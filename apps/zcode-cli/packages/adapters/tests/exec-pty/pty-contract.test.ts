import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliExecPtyModule } from "../../src/exec/pty/module.js";
import { AgentPtyManager } from "../../src/exec/pty/agent-pty-manager.js";
import { AnsiRingBuffer, parseAnsi, stripAnsi } from "../../src/exec/pty/ansi-ring-buffer.js";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "zcode-pty-test-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("cli-exec-pty contract", () => {
  it("declares its module manifest and depends on the sandbox", () => {
    expect(cliExecPtyModule.id).toBe("cli-exec-pty");
    expect(cliExecPtyModule.requires).toContain("cli-exec-sandbox");
  });

  it("runs a real PTY session, reads output incrementally and reports exit code", async () => {
    const manager = new AgentPtyManager({ platform: process.platform });
    try {
      const session = await manager.create({
        cwd: workspace,
        workspacePath: workspace,
        // Реальная песочница: на Linux это bwrap, иначе degraded/none.
        sandbox: { profile: "workspace-write", networkAccess: "allow" },
        cols: 100,
        rows: 30,
      });
      expect(session.status).toBe("running");
      expect(session.pid).toBeGreaterThan(0);
      expect(["bwrap", "seatbelt", "degraded", "none"]).toContain(session.sandboxMode);

      await manager.write(session.sessionId, "printf 'marker-one\\n'\r");
      const waited = await manager.waitFor(session.sessionId, {
        pattern: "marker-one",
        timeoutMs: 10_000,
      });
      expect(waited.matched).toBe("pattern");
      expect(waited.match).toContain("marker-one");

      // Инкрементальное чтение: второй вызов с lastSeq не повторяет первый.
      const first = await manager.read(session.sessionId, { sinceSeq: 0 });
      const second = await manager.read(session.sessionId, {
        sinceSeq: first.session.lastSeq,
      });
      expect(second.chunks).toHaveLength(0);
      expect(first.chunks.length).toBeGreaterThan(0);

      // Следующая команда даёт новые чанки только после sinceSeq.
      await manager.write(session.sessionId, "printf 'marker-two\\n'\r");
      const afterSecond = await manager.waitFor(session.sessionId, {
        pattern: "marker-two",
        timeoutMs: 10_000,
      });
      expect(afterSecond.matched).toBe("pattern");
      const delta = await manager.read(session.sessionId, {
        sinceSeq: first.session.lastSeq,
      });
      expect(delta.truncatedFrom).toBeUndefined();
      expect(delta.chunks.every((chunk) => chunk.seq > first.session.lastSeq)).toBe(true);

      await manager.write(session.sessionId, "exit 7\r");
      const exited = await manager.waitFor(session.sessionId, {
        exitCode: 7,
        timeoutMs: 10_000,
      });
      expect(exited.matched).toBe("exit");
      expect(exited.session.exitCode).toBe(7);
    } finally {
      await manager.dispose();
    }
  }, 40_000);

  it("kills the session tree and is idempotent", async () => {
    const manager = new AgentPtyManager({ platform: process.platform });
    try {
      const session = await manager.create({
        cwd: workspace,
        workspacePath: workspace,
        sandbox: { profile: "off" },
      });
      // Фоновый потомок: kill обязан снять всё дерево, не только shell.
      await manager.write(session.sessionId, "sleep 300 & sleep 300\r");
      await manager.waitFor(session.sessionId, { idleMs: 300, timeoutMs: 5_000 });

      const killed = await manager.kill(session.sessionId, { graceMs: 400 });
      expect(killed.status).toBe("killed");

      const again = await manager.kill(session.sessionId, { graceMs: 0 });
      expect(again.status).toBe("killed");
    } finally {
      await manager.dispose();
    }
  }, 30_000);

  it("enforces maxSessions and disposes without leaving descriptors", async () => {
    const manager = new AgentPtyManager({
      platform: process.platform,
      maxSessions: 2,
    });
    const created = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        created.push(
          await manager.create({
            cwd: workspace,
            workspacePath: workspace,
            sandbox: { profile: "off" },
          }),
        );
      }
      await expect(
        manager.create({
          cwd: workspace,
          workspacePath: workspace,
          sandbox: { profile: "off" },
        }),
      ).rejects.toThrow(/limit reached/i);
    } finally {
      await manager.dispose();
    }
    // После dispose список пуст: дескрипторы освобождены.
    expect(manager.list()).toHaveLength(0);
  }, 30_000);
});

describe("ansi ring buffer", () => {
  it("strips CSI/OSC sequences and keeps control sequences separately", () => {
    const parsed = parseAnsi("\u001b[31mred\u001b[0m and \u001b]0;title\u0007text");
    expect(parsed.text).toBe("red and text");
    expect(parsed.sequences).toContain("\u001b[31m");
    expect(parsed.sequences.some((sequence) => sequence.startsWith("\u001b]0;"))).toBe(true);
  });

  it("carries a split escape sequence into the next chunk", () => {
    const first = parseAnsi("\u001b[3");
    expect(first.pending).toBe("\u001b[3");
    const second = parseAnsi("1mgreen", first.pending);
    expect(second.text).toBe("green");
    expect(second.sequences).toEqual(["\u001b[31m"]);
  });

  it("assigns monotonic seq and returns only new chunks", () => {
    const buffer = new AnsiRingBuffer(1024);
    buffer.append("one");
    buffer.append("two");
    buffer.append("three");

    const all = buffer.readAsChunks(0);
    expect(all.chunks.map((chunk) => chunk.seq)).toEqual([1, 2, 3]);
    expect(all.chunks.map((chunk) => chunk.text)).toEqual(["one", "two", "three"]);

    const tail = buffer.readAsChunks(2);
    expect(tail.chunks.map((chunk) => chunk.text)).toEqual(["three"]);
    expect(tail.truncatedFrom).toBeUndefined();
  });

  it("reports truncatedFrom when the requested position was evicted", () => {
    const buffer = new AnsiRingBuffer(8);
    for (let index = 0; index < 6; index += 1) buffer.append(`chunk-${index}`);

    expect(buffer.truncatedBytes).toBeGreaterThan(0);
    const result = buffer.readAsChunks(1);
    expect(result.truncatedFrom).toBeDefined();
    expect(result.chunks.every((chunk) => chunk.seq > (result.truncatedFrom ?? 0))).toBe(true);
  });

  it("caps memory at the configured budget", () => {
    const buffer = new AnsiRingBuffer(64);
    for (let index = 0; index < 50; index += 1) buffer.append("x".repeat(16));
    expect(buffer.storedBytes).toBeLessThanOrEqual(64);
  });

  it("keeps stripAnsi free of escape characters", () => {
    expect(stripAnsi("\u001b[2K\u001b[1Gdone")).toBe("done");
  });
});
