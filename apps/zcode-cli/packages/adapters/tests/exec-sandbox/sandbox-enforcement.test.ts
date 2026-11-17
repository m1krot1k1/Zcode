/**
 * Реальная проверка песочницы на текущей машине.
 *
 * Тесты не имитируют механизм: `ExecutionSandbox` делает настоящий probe и настоящий
 * `spawn` внутри bwrap. Если bwrap недоступен (например, контейнер без user
 * namespaces), позитивные тесты честно пропускаются с явной причиной, а degraded-путь
 * проверяется всегда.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ExecutionSandbox } from "../../src/exec/sandbox/execution-sandbox.js";
import { probeSandboxCapability } from "../../src/exec/sandbox/capability-probe.js";
import type { SandboxedCommand } from "../../src/exec/sandbox/contract.js";

const execFileAsync = promisify(execFile);

let workspace: string;
let sandbox: ExecutionSandbox;
let bwrapAvailable = false;
let skipReason = "";

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-sandbox-test-"));
  sandbox = new ExecutionSandbox();
  const capability = await probeSandboxCapability();
  bwrapAvailable = capability.available && capability.mode === "bwrap";
  if (!bwrapAvailable) {
    skipReason = capability.reason ?? `sandbox mode is ${capability.mode}`;
  }
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Исполняет обёрнутую команду и возвращает фактический код/вывод. */
async function runWrapped(
  wrapped: SandboxedCommand,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(wrapped.file, wrapped.args, {
      cwd: wrapped.cwd,
      env: wrapped.env,
      timeout: timeoutMs,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

describe("sandbox capability probe", () => {
  it("reports a concrete mode with a reason when unavailable", async () => {
    const capability = await probeSandboxCapability();
    expect(["bwrap", "seatbelt", "degraded"]).toContain(capability.mode);
    if (!capability.available) {
      expect(capability.reason).toBeTruthy();
    }
    expect(capability.probeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("caches probe results without re-running the self-test", async () => {
    let calls = 0;
    const cached = new ExecutionSandbox({
      probe: async () => {
        calls += 1;
        const capability = await probeSandboxCapability();
        return capability;
      },
    });
    await cached.probe();
    await cached.probe();
    expect(calls).toBe(1);
  });
});

describe("workspace-write enforcement", () => {
  it("writes inside the workspace and reads the file back", async () => {
    const wrapped = await sandbox.wrap(
      { file: "/bin/sh", args: ["-c", "echo inside-ok > ./inside.txt && cat ./inside.txt"] },
      {
        profile: "workspace-write",
        cwd: workspace,
        workspacePath: workspace,
        networkAccess: "allow",
      },
    );

    const result = await runWrapped(wrapped);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("inside-ok");
    if (bwrapAvailable) {
      expect(wrapped.sandboxMode).toBe("bwrap");
      expect(await readFile(join(workspace, "inside.txt"), "utf8")).toContain("inside-ok");
    }
  });

  it.skipIf(!existsSync("/usr/bin/bwrap"))(
    "blocks writes outside the workspace when bwrap is available",
    async () => {
      const outside = join(tmpdir(), `zcode-forbidden-${Date.now()}.txt`);
      const wrapped = await sandbox.wrap(
        { file: "/bin/sh", args: ["-c", `touch '${outside}' 2>&1; echo "exit=$?"`] },
        {
          profile: "workspace-write",
          cwd: workspace,
          workspacePath: workspace,
          networkAccess: "allow",
        },
      );

      expect(wrapped.sandboxMode).toBe("bwrap");
      const result = await runWrapped(wrapped);
      // Запись вне workspace обязана провалиться: файл не создан.
      expect(existsSync(outside)).toBe(false);
      expect(result.stdout).toContain("exit=");
    },
  );

  it.skipIf(!existsSync("/usr/bin/bwrap"))(
    "denies network egress with --unshare-net",
    async () => {
      const wrapped = await sandbox.wrap(
        {
          file: "/bin/sh",
          args: ["-c", "timeout 3 getent hosts registry.npmjs.org; echo \"rc=$?\""],
        },
        {
          profile: "strict-offline",
          cwd: workspace,
          workspacePath: workspace,
          networkAccess: "deny",
        },
      );

      expect(wrapped.sandboxMode).toBe("bwrap");
      expect(wrapped.networkIsolated).toBe(true);
      const result = await runWrapped(wrapped);
      // Без сети резолв не проходит: rc не ноль и адрес не выводится.
      expect(result.stdout).not.toMatch(/\b\d+\.\d+\.\d+\.\d+\b/);
      expect(result.stdout).toContain("rc=");
      expect(result.stdout).not.toContain("rc=0");
    },
  );

  it("applies ulimit-based limits in degraded mode", async () => {
    const degraded = new ExecutionSandbox({
      probe: async () => ({
        mode: "degraded",
        available: false,
        reason: "forced for test",
        supportedFlags: [],
        probedAt: 0,
        probeDurationMs: 0,
      }),
    });

    const wrapped = await degraded.wrap(
      { file: "/bin/sh", args: ["-c", "echo limited"] },
      {
        profile: "workspace-write",
        cwd: workspace,
        workspacePath: workspace,
        limits: { cpuSeconds: 10, maxFileSizeBytes: 4096 },
      },
    );

    expect(wrapped.sandboxMode).toBe("degraded");
    expect(wrapped.sandboxReason).toBe("forced for test");
    expect(wrapped.args[0]).toBe("-c");
    expect(wrapped.args[1]).toContain("ulimit -t 10");
    expect(wrapped.args[1]).toContain("ulimit -f 8");
    const result = await runWrapped(wrapped);
    expect(result.stdout).toContain("limited");
  });

  it("keeps the sandbox reason visible to the caller when degraded", async () => {
    const degraded = new ExecutionSandbox({
      probe: async () => ({
        mode: "degraded",
        available: false,
        reason: "kernel.apparmor_restrict_unprivileged_userns=1",
        supportedFlags: [],
        probedAt: 0,
        probeDurationMs: 0,
      }),
    });
    const wrapped = await degraded.wrap(
      { file: "/bin/sh", args: ["-c", "true"] },
      { profile: "workspace-write", cwd: workspace, workspacePath: workspace },
    );
    expect(wrapped.sandboxMode).toBe("degraded");
    expect(wrapped.sandboxReason).toContain("apparmor");
    expect(wrapped.filesystemIsolated).toBe(false);
  });
});

describe("skip accounting", () => {
  it("records why bwrap-specific checks were skipped", () => {
    // Явный отчёт вместо тишины: причина видна в выводе теста.
    if (!bwrapAvailable) {
      console.warn(`[sandbox] bwrap-specific tests skipped: ${skipReason}`);
    }
    expect(typeof bwrapAvailable).toBe("boolean");
  });
});

describe("hidden file helper", () => {
  it("keeps the workspace writable for temp markers", async () => {
    const marker = join(workspace, "marker.txt");
    await writeFile(marker, "ok");
    expect(await readFile(marker, "utf8")).toBe("ok");
  });
});
