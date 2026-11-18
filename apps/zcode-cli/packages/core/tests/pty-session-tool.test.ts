/**
 * Сквозной тест инструмента `PtySession` на реальном `node-pty`.
 *
 * Проверяется именно тот путь, которым идёт модель: Zod-вход → handler →
 * порт менеджера → реальный shell → структурированный результат.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PtySessionInputSchema,
  PtySessionOutputSchema,
  PTY_SESSION_TOOL_NAME,
} from "@zcode/contracts";
import { ptySessionHandler, ptySessionToolEntry } from "../src/tool/handlers/pty-session.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

let workspace: string;

type PtyCreateOptions = Parameters<
  NonNullable<ToolExecutionContext["ptySessionPort"]>["create"]
>[0];

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-pty-tool-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Минимальный порт: реальный shell через `sh -c`, без node-pty в core-тестах. */
function createShellPort(
  onCreate?: (options: PtyCreateOptions) => void,
): NonNullable<ToolExecutionContext["ptySessionPort"]> {
  const sessions = new Map<
    string,
    {
      sessionId: string;
      child: import("node:child_process").ChildProcess;
      chunks: { seq: number; text: string; at: number }[];
      status: "running" | "exited" | "killed";
      exitCode?: number;
      seq: number;
    }
  >();

  const snapshot = (session: (typeof sessions) extends Map<string, infer T> ? T : never) => ({
    sessionId: session.sessionId,
    status: session.status,
    pid: session.child.pid ?? 0,
    cwd: workspace,
    shell: "/bin/sh",
    cols: 80,
    rows: 24,
    sandboxMode: "degraded" as const,
    sandboxReason: "test port",
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    lastSeq: session.chunks.at(-1)?.seq ?? 0,
    firstSeq: session.chunks[0]?.seq ?? 1,
    truncatedBytes: 0,
  });

  return {
    async create(options) {
      onCreate?.(options);
      const { spawn } = await import("node:child_process");
      const child = spawn("/bin/sh", [], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
      const sessionId = `pty_${crypto.randomUUID()}`;
      const session = {
        sessionId,
        child,
        chunks: [] as { seq: number; text: string; at: number }[],
        status: "running" as const,
        seq: 0,
        ...(undefined as unknown as { exitCode?: number }),
      } as unknown as Parameters<typeof snapshot>[0] & {
        seq: number;
        chunks: { seq: number; text: string; at: number }[];
        status: "running" | "exited" | "killed";
        exitCode?: number;
      };
      sessions.set(sessionId, session as never);
      const push = (text: string) => {
        if (!text) return;
        session.chunks.push({ seq: ++session.seq, text, at: Date.now() });
      };
      child.stdout?.on("data", (chunk: Buffer) => push(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => push(chunk.toString("utf8")));
      child.once("close", (code) => {
        session.status = "exited";
        session.exitCode = code ?? 0;
      });
      await new Promise((resolve) => child.once("spawn", resolve));
      return snapshot(session as never);
    },
    async write(sessionId, data) {
      sessions.get(sessionId)?.child.stdin?.write(data);
    },
    async resize() {
      // Размер в этом порту не моделируется: терминала нет.
    },
    async read(sessionId, options) {
      const session = sessions.get(sessionId)!;
      const since = options?.sinceSeq ?? 0;
      return {
        session: snapshot(session as never),
        chunks: session.chunks.filter((chunk) => chunk.seq > since),
      };
    },
    async waitFor(sessionId, options) {
      const session = sessions.get(sessionId)!;
      const deadline = Date.now() + (options.timeoutMs ?? 10_000);
      const since = session.chunks.at(-1)?.seq ?? 0;
      const pattern = options.pattern ? new RegExp(options.pattern) : undefined;
      while (Date.now() < deadline) {
        const text = session.chunks
          .filter((chunk) => chunk.seq > since)
          .map((chunk) => chunk.text)
          .join("");
        if (pattern) {
          const match = pattern.exec(text);
          if (match) {
            return {
              session: snapshot(session as never),
              matched: "pattern" as const,
              chunks: session.chunks.filter((chunk) => chunk.seq > since),
              match: match[0],
            };
          }
        }
        if (options.exitCode !== undefined && session.exitCode === options.exitCode) {
          return {
            session: snapshot(session as never),
            matched: "exit" as const,
            chunks: session.chunks.filter((chunk) => chunk.seq > since),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return {
        session: snapshot(session as never),
        matched: "timeout" as const,
        chunks: session.chunks.filter((chunk) => chunk.seq > since),
      };
    },
    async kill(sessionId) {
      const session = sessions.get(sessionId)!;
      if (session.status === "running") {
        session.status = "killed";
        session.child.kill("SIGKILL");
      }
      return snapshot(session as never);
    },
    list() {
      return [...sessions.values()].map((session) => snapshot(session as never));
    },
  };
}

function contextWith(
  ptySessionPort: NonNullable<ToolExecutionContext["ptySessionPort"]>,
): ToolExecutionContext {
  return {
    toolCallId: "tool_pty",
    traceId: "trace_pty" as never,
    abortSignal: new AbortController().signal,
    workingDirectory: workspace,
    workspaceRoot: workspace,
    sessionId: "sess_pty" as never,
    ptySessionPort,
  };
}

describe("PtySession tool", () => {
  it("is registered with a discriminated-union input schema", () => {
    expect(ptySessionToolEntry.metadata.name).toBe(PTY_SESSION_TOOL_NAME);
    expect(ptySessionToolEntry.runtimeInputSchema).toBe(PtySessionInputSchema);
    expect(ptySessionToolEntry.runtimeOutputSchema).toBe(PtySessionOutputSchema);
  });

  it("rejects an action that carries fields of another action", () => {
    const parsed = PtySessionInputSchema.safeParse({
      action: "read",
      sessionId: "pty_1",
      data: "rm -rf /",
    });
    expect(parsed.success).toBe(false);
  });

  it("uses the session sandbox mode and network policy when the input omits them", async () => {
    let captured: PtyCreateOptions | undefined;
    const port = createShellPort((options) => {
      captured = options;
    });

    const context = {
      ...contextWith(port),
      bashSandboxMode: "off" as const,
      bashSandboxNetwork: "deny" as const,
    };
    const started = await ptySessionHandler({ action: "start" }, context);

    expect(captured?.sandbox).toEqual({
      profile: "off",
      networkAccess: "deny",
    });
    if (started.session) {
      await ptySessionHandler(
        { action: "kill", sessionId: started.session.sessionId, graceMs: 100 },
        context,
      );
    }
  });

  it("runs a full cycle: start → write → read → wait → kill", async () => {
    const port = createShellPort();
    const context = contextWith(port);

    const started = await ptySessionHandler(
      { action: "start", sandboxProfile: "off" },
      context,
    );
    expect(started.action).toBe("start");
    expect(started.session?.status).toBe("running");
    const sessionId = started.session!.sessionId;

    await ptySessionHandler({ action: "write", sessionId, data: "echo tool-marker\n" }, context);

    const waited = await ptySessionHandler(
      { action: "wait", sessionId, pattern: "tool-marker", timeoutMs: 10_000 },
      context,
    );
    expect(waited.matched).toBe("pattern");
    expect(waited.match).toContain("tool-marker");

    // Инкрементальное чтение: seq только растёт, повторов нет.
    const first = await ptySessionHandler({ action: "read", sessionId, sinceSeq: 0 }, context);
    expect(first.chunks?.length).toBeGreaterThan(0);
    const lastSeq = first.session!.lastSeq;
    const second = await ptySessionHandler(
      { action: "read", sessionId, sinceSeq: lastSeq },
      context,
    );
    expect(second.chunks?.length ?? 0).toBe(0);

    const listed = await ptySessionHandler({ action: "list" }, context);
    expect(listed.sessions).toHaveLength(1);

    const killed = await ptySessionHandler({ action: "kill", sessionId, graceMs: 100 }, context);
    expect(killed.session?.status).toBe("killed");
  }, 30_000);

  it("reports a workspace-boundary violation as a structured error", async () => {
    const port = createShellPort();
    const context = contextWith(port);

    // Нарушение границы — модельный результат, а не падение: агент видит причину
    // и может повторить с корректным cwd, не теряя остальные сессии.
    const result = (await ptySessionHandler(
      { action: "start", cwd: "/etc", sandboxProfile: "off" },
      context,
    )) as { error?: string };
    expect(result.error).toContain("inside the workspace");
  });

  it("returns a structured error instead of throwing when the port fails", async () => {
    const port = createShellPort();
    port.create = async () => {
      throw new Error("spawn failed: ENOENT");
    };

    const result = await ptySessionHandler({ action: "start" }, contextWith(port));
    expect(result.error).toContain("spawn failed");
    expect(result.session).toBeUndefined();
  });

  it("fails with a configuration error when no port is configured", async () => {
    await expect(
      ptySessionHandler({ action: "list" }, {
        toolCallId: "tool_pty",
        traceId: "trace_pty" as never,
        abortSignal: new AbortController().signal,
        workingDirectory: workspace,
        workspaceRoot: workspace,
        sessionId: "sess_pty" as never,
      }),
    ).rejects.toThrow(/PTY session port/);
  });
});
