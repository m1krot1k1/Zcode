import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_CLI_INSTALL_COMMAND,
  createCursorCliRuntime,
  type CursorCliCommandResult,
} from "../src/cursor-cli-runtime/adapters/cursorCliRuntime.js";
import type { CursorCliResolution } from "../src/cursor-cli-runtime/adapters/cliResolver.js";

const found: CursorCliResolution = { found: true, path: "/bin/cursor-agent" };
const missing: CursorCliResolution = { found: false, reason: "not-found" };

function result(partial: Partial<CursorCliCommandResult>): CursorCliCommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...partial,
  };
}

function runtime(
  resolution: CursorCliResolution,
  runCommand: (args: readonly string[], timeoutMs: number) => Promise<CursorCliCommandResult>,
) {
  return createCursorCliRuntime({
    resolveCli: async () => resolution,
    runCommand,
  });
}

describe("createCursorCliRuntime", () => {
  it("сообщает missing с официальной командой установки", async () => {
    const status = await runtime(missing, async () => result({})).getCliStatus();
    expect(status).toEqual({
      status: "missing",
      diagnostic: "not-found",
      installCommand: CURSOR_CLI_INSTALL_COMMAND,
    });
  });

  it("извлекает версию из `cursor-agent --version`", async () => {
    const runCommand = vi.fn(async () => result({ stdout: "cursor-agent 2025.09.25\n" }));
    const status = await runtime(found, runCommand).getCliStatus();
    expect(status).toEqual({
      status: "available",
      version: "2025.09.25",
      executablePath: "/bin/cursor-agent",
    });
    expect(runCommand).toHaveBeenCalledWith(["/bin/cursor-agent", "--version"], expect.any(Number));
  });

  it("сообщает unavailable при ненулевом коде версии", async () => {
    const status = await runtime(found, async () =>
      result({ exitCode: 1, stderr: "permission denied" }),
    ).getCliStatus();
    expect(status).toMatchObject({ status: "unavailable", diagnostic: "permission denied" });
  });

  it("сообщает timed-out при таймауте проверки", async () => {
    const status = await runtime(found, async () =>
      result({ exitCode: null, timedOut: true }),
    ).getCliStatus();
    expect(status.status).toBe("timed-out");
  });

  it("публикует CLI-модели из `cursor-agent models`", async () => {
    const runCommand = vi.fn(async (args: readonly string[]) =>
      args[1] === "models"
        ? result({ stdout: "composer-1 - Composer 1\nclaude-4.5-sonnet - Sonnet\n" })
        : result({}),
    );
    const catalog = await runtime(found, runCommand).listModels();
    expect(catalog.status).toBe("available");
    if (catalog.status !== "available") throw new Error("expected available catalog");
    expect(catalog.models.map((model) => model.modelId)).toEqual([
      "composer-1",
      "claude-4.5-sonnet",
    ]);
    expect(catalog.models[0]?.source).toBe("cli");
  });

  it("падает на --list-models и использует baseline для пустого списка", async () => {
    const runCommand = vi.fn(async (args: readonly string[]) =>
      args[1] === "models"
        ? result({ exitCode: 2, stderr: "unknown command" })
        : result({ stdout: "Available models\n" }),
    );
    const catalog = await runtime(found, runCommand).listModels();
    expect(catalog.status).toBe("available");
    if (catalog.status !== "available") throw new Error("expected available catalog");
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models.every((model) => model.source === "baseline")).toBe(true);
  });

  it("installCli запускает официальный установщик и подтверждает бинарь через --version", async () => {
    const runCommand = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "/bin/bash" || args[0] === "/bin/sh") {
        return result({ stdout: "installed" });
      }
      return result({ stdout: "cursor-agent 2025.11.1\n" });
    });
    const install = await runtime(found, runCommand).installCli();
    expect(install).toEqual({
      status: "installed",
      version: "2025.11.1",
      executablePath: "/bin/cursor-agent",
    });
    expect(runCommand.mock.calls[0]?.[0]).toEqual([
      expect.stringMatching(/^\/bin\/(bash|sh)$/),
      "-lc",
      CURSOR_CLI_INSTALL_COMMAND,
    ]);
  });

  it("installCli не считает код установщика доказательством установки", async () => {
    const runCommand = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "/bin/bash" || args[0] === "/bin/sh") return result({ exitCode: 0 });
      return result({ exitCode: 127, stderr: "not found" });
    });
    const install = await runtime(found, runCommand).installCli();
    expect(install).toMatchObject({
      status: "failed",
      diagnostic: "install-verification-failed",
    });
  });

  it("installCli сообщает failed при ошибке установщика", async () => {
    const install = await runtime(found, async () =>
      result({ exitCode: 22, stderr: "curl: (22) 404" }),
    ).installCli();
    expect(install).toMatchObject({ status: "failed", diagnostic: "install-failed" });
  });

  it("кэширует статус и каталог, чтобы refresh настроек не запускал CLI каждый раз", async () => {
    let now = 1_000;
    const runCommand = vi.fn(async (args: readonly string[]) =>
      args[1] === "--version"
        ? result({ stdout: "cursor-agent 2025.11.1\n" })
        : result({ stdout: "composer-1 - Composer 1\n" }),
    );
    const cursor = createCursorCliRuntime({
      resolveCli: async () => found,
      runCommand,
      now: () => now,
      cacheTtlMs: 1_000,
    });
    await cursor.getCliStatus();
    await cursor.getCliStatus();
    expect(runCommand).toHaveBeenCalledTimes(1);
    await cursor.listModels();
    await cursor.listModels();
    expect(runCommand).toHaveBeenCalledTimes(2);
    now += 1_001;
    await cursor.listModels();
    expect(runCommand).toHaveBeenCalledTimes(3);
  });

  it("сохраняет последний удачный каталог, если сеть Cursor пропала", async () => {
    let now = 1_000;
    let failing = false;
    const runCommand = vi.fn(async (args: readonly string[]) => {
      if (args[1] === "--version") return result({ stdout: "cursor-agent 2025.11.1\n" });
      return failing
        ? result({ exitCode: 1, stderr: "getaddrinfo ENOTFOUND api2.cursor.sh" })
        : result({ stdout: "composer-1 - Composer 1\n" });
    });
    const cursor = createCursorCliRuntime({
      resolveCli: async () => found,
      runCommand,
      now: () => now,
      cacheTtlMs: 1_000,
    });
    const first = await cursor.listModels();
    expect(first.status).toBe("available");
    now += 1_001;
    failing = true;
    const second = await cursor.listModels();
    expect(second.status).toBe("available");
    if (second.status !== "available") throw new Error("expected stale catalog");
    expect(second.models.map((model) => model.modelId)).toEqual(["composer-1"]);
    // 失败结果也进入短 TTL 缓存：设置页刷新不能反复 spawn CLI。
    const callsAfterFailure = runCommand.mock.calls.length;
    const third = await cursor.listModels();
    expect(third.status).toBe("available");
    expect(runCommand).toHaveBeenCalledTimes(callsAfterFailure);
  });

  it("сообщает unavailable, если обе команды завершились ошибкой", async () => {
    const catalog = await runtime(found, async () =>
      result({ exitCode: 1, stderr: "auth required" }),
    ).listModels();
    expect(catalog).toMatchObject({ status: "unavailable", diagnostic: "auth required" });
  });
});
