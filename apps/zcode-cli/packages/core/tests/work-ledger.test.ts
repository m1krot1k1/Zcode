import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MIN_SHARED_INTENT_TOKENS,
  WORK_LEDGER_JOURNAL_VERSION,
  WORK_LEDGER_TTL_MS,
  WorkLedger,
  normalizeWorkspacePath,
  pathsOverlap,
  resolveWorkspaceKey,
} from "../src/runtime-task/work-ledger.js";

const WORKSPACE_IDENTITY = "zcode-main";

describe("WorkLedger", () => {
  let directory: string;
  let workspacePath: string;
  let journalPath: string;
  let now: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zcode-work-ledger-"));
    workspacePath = join(directory, "workspace");
    journalPath = join(directory, "work-ledger.jsonl");
    now = Date.UTC(2026, 10, 4, 12, 0, 0);
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  function createLedger(): WorkLedger {
    return new WorkLedger({ journalPath, now: () => now });
  }

  function claim(
    ledger: WorkLedger,
    agentId: string,
    paths: string[],
    intent = `работа агента ${agentId}`,
    parentAgentId: string | null = null,
  ) {
    return ledger.claim({
      agentId,
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
      parentAgentId,
      profile: "prism",
      intent,
      paths,
    });
  }

  it("(a) два claim на один файл → конфликт с перечнем держателей", () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/runtime/agent.ts"], "правлю рантайм агента");

    const second = claim(ledger, "agent-b", ["src/runtime/agent.ts"], "добавляю лог в рантайм");

    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]?.path).toBe("src/runtime/agent.ts");
    expect(second.conflicts[0]?.kind).toBe("same-file");
    expect(second.conflicts[0]?.holders).toHaveLength(1);
    expect(second.conflicts[0]?.holders[0]?.agentId).toBe("agent-a");
    expect(second.conflicts[0]?.holders[0]?.intent).toBe("правлю рантайм агента");
    expect(second.claim.status).toBe("active");
  });

  it("(b) разные файлы → конфликта нет", () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/runtime/agent.ts"]);
    const second = claim(ledger, "agent-b", ["src/runtime/session.ts"]);

    expect(second.conflicts).toEqual([]);
    expect(ledger.list({ status: "active" })).toHaveLength(2);
  });

  it("(c) родитель и ребёнок на один путь → конфликт виден обоим", () => {
    const ledger = createLedger();
    claim(ledger, "parent", ["src/runtime-task"], "делаю реестр работ");
    const child = claim(
      ledger,
      "child",
      ["src/runtime-task/work-ledger.ts"],
      "пишу ядро реестра",
      "parent",
    );

    expect(child.conflicts).toHaveLength(1);
    expect(child.conflicts[0]?.kind).toBe("directory-overlap");
    expect(child.conflicts[0]?.holders[0]?.agentId).toBe("parent");

    const parentView = ledger.findConflicts({
      agentId: "parent",
      paths: ["src/runtime-task"],
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
    });
    expect(parentView).toHaveLength(1);
    expect(parentView[0]?.holders.map((holder) => holder.agentId)).toEqual(["child"]);
    expect(parentView[0]?.holders[0]?.parentAgentId).toBe("parent");
  });

  it("(d) TTL: без heartbeat 10 минут → stale и не блокирует", () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/runtime-task/work-ledger.ts"]);

    now += WORK_LEDGER_TTL_MS + 60_000;

    const swept = ledger.sweepStale();
    expect(swept.map((item) => item.status)).toEqual(["stale"]);
    expect(swept[0]?.agentId).toBe("agent-a");

    const late = claim(ledger, "agent-b", ["src/runtime-task/work-ledger.ts"]);
    expect(late.conflicts).toEqual([]);

    expect(ledger.list({ status: "active" }).map((item) => item.agentId)).toEqual(["agent-b"]);
    expect(ledger.list({ agentId: "agent-a" })[0]?.status).toBe("stale");
  });

  it("TTL продлевается heartbeat'ом", () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/runtime-task/work-ledger.ts"]);

    now += 5 * 60_000;
    expect(ledger.heartbeat("agent-a")).toHaveLength(1);

    now += 9 * 60_000;
    expect(ledger.list({ status: "active" })).toHaveLength(1);
  });

  it("(e) похожий intent + пересечение путей → предупреждение", () => {
    const ledger = createLedger();
    claim(
      ledger,
      "agent-a",
      ["src/runtime-task/work-ledger.ts"],
      "реестр работ агентов: модель данных",
    );

    const warnings = ledger.findSimilarIntent({
      intent: "Реестр работ агентов — API",
      paths: ["src/runtime-task/work-ledger.ts"],
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("overlapping");
    expect(warnings[0]?.claim.agentId).toBe("agent-a");
    expect(warnings[0]?.sharedTokens.length).toBeGreaterThanOrEqual(MIN_SHARED_INTENT_TOKENS);
    expect(warnings[0]?.message).toContain("уже занимается агент agent-a");

    const second = claim(
      ledger,
      "agent-b",
      ["src/runtime-task/work-ledger.ts"],
      "Реестр работ агентов — API",
    );
    expect(second.similarIntent).toHaveLength(1);
    expect(second.similarIntent[0]?.claim.agentId).toBe("agent-a");
    expect(second.conflicts).toHaveLength(1);
  });

  it("похожий intent на разных файлах не считается дублем", () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/runtime-task/work-ledger.ts"], "реестр работ агентов");

    const warnings = ledger.findSimilarIntent({
      intent: "реестр работ агентов",
      paths: ["src/ui/store/ledger.ts"],
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
    });

    expect(warnings).toEqual([]);
  });

  it("(f) перезапуск: журнал читается, активные claim восстанавливаются", async () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/runtime-task/work-ledger.ts"], "пишу ядро");
    claim(ledger, "agent-b", ["src/runtime-task/index.ts"], "правлю экспорты", "agent-a");
    claim(ledger, "agent-c", ["src/runtime-task/registry.ts"], "правлю реестр");
    ledger.release("agent-b");
    now += 60_000;
    ledger.heartbeat("agent-a");
    await ledger.flush();

    const restored = await WorkLedger.open({ journalPath, now: () => now });
    const active = restored.list({ status: "active" });

    expect(active.map((item) => item.agentId).sort()).toEqual(["agent-a", "agent-c"]);
    expect(restored.list({ agentId: "agent-a" })[0]?.heartbeatAt).toBe(now);
    expect(restored.list({ agentId: "agent-b" })[0]?.status).toBe("released");
    expect(restored.skippedLines).toBe(0);
    expect(restored.lastLoadError).toBeNull();

    const conflicts = restored.findConflicts({
      agentId: "agent-d",
      paths: ["src/runtime-task/work-ledger.ts"],
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
    });
    expect(conflicts[0]?.holders[0]?.agentId).toBe("agent-a");
  });

  it("журнал append-only: строки — валидные события версии 1", async () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/a.ts"]);
    ledger.release("agent-a");
    await ledger.flush();

    const lines = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { v: number; type: string });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ v: WORK_LEDGER_JOURNAL_VERSION, type: "claim" });
    expect(lines[1]).toMatchObject({ v: WORK_LEDGER_JOURNAL_VERSION, type: "release" });
    expect(ledger.lastWriteError).toBeNull();
  });

  it("повторный claim того же агента обновляет запись, а не создаёт вторую", () => {
    const ledger = createLedger();
    const first = claim(ledger, "agent-a", ["src/a.ts"], "первая задача");
    const second = claim(ledger, "agent-a", ["src/b.ts"], "вторая задача");

    expect(second.reused).toBe(true);
    expect(second.claim.id).toBe(first.claim.id);
    expect(second.claim.startedAt).toBe(first.claim.startedAt);
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0]?.paths).toEqual(["src/b.ts"]);
  });

  it("после release новый claim агента создаётся заново", () => {
    const ledger = createLedger();
    const first = claim(ledger, "agent-a", ["src/a.ts"]);
    ledger.release("agent-a");
    const second = claim(ledger, "agent-a", ["src/a.ts"]);

    expect(second.reused).toBe(false);
    expect(second.claim.id).not.toBe(first.claim.id);
    expect(second.conflicts).toEqual([]);
  });

  it("нормализация путей: относительный, абсолютный, `..` и `\\`", () => {
    expect(normalizeWorkspacePath("./src/../src//agent.ts", workspacePath)).toBe("src/agent.ts");
    expect(normalizeWorkspacePath("src\\runtime\\agent.ts", workspacePath)).toBe(
      "src/runtime/agent.ts",
    );
    expect(normalizeWorkspacePath(workspacePath, workspacePath)).toBe(".");
    expect(normalizeWorkspacePath(join(workspacePath, "src/agent.ts"), workspacePath)).toBe(
      "src/agent.ts",
    );

    const ledger = createLedger();
    claim(ledger, "agent-a", ["./src\\runtime/../runtime/agent.ts"]);
    const conflicts = ledger.findConflicts({
      agentId: "agent-b",
      paths: [join(workspacePath, "src/runtime/agent.ts")],
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.path).toBe("src/runtime/agent.ts");
  });

  it("общий текстовый префикс — не пересечение, корень workspace — пересечение", () => {
    expect(pathsOverlap("src/ab", "src/a/b.ts", { caseSensitive: true })).toBe(false);
    expect(pathsOverlap("src/a", "src/a/b.ts", { caseSensitive: true })).toBe(true);
    expect(pathsOverlap(".", "src/a.ts", { caseSensitive: true })).toBe(true);

    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/ab"]);
    expect(
      ledger.findConflicts({
        agentId: "agent-b",
        paths: ["src/a/b.ts"],
        workspacePath,
        workspaceIdentity: WORKSPACE_IDENTITY,
      }),
    ).toEqual([]);

    claim(ledger, "agent-root", ["."]);
    expect(
      ledger.findConflicts({
        agentId: "agent-b",
        paths: ["src/a/b.ts"],
        workspacePath,
        workspaceIdentity: WORKSPACE_IDENTITY,
      }),
    ).toHaveLength(1);
  });

  it("агенты в разных workspace не конфликтуют", () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/a.ts"]);

    const other = ledger.claim({
      agentId: "agent-b",
      workspacePath,
      workspaceIdentity: "another-workspace",
      intent: "другая задача",
      paths: ["src/a.ts"],
    });

    expect(other.conflicts).toEqual([]);
  });

  it("resolveWorkspaceKey: identity важнее пути, пустая identity — fallback", () => {
    expect(resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "  remote  " })).toBe(
      "remote",
    );
    expect(resolveWorkspaceKey({ workspacePath: "/tmp/ws", workspaceIdentity: "   " })).toBe(
      "/tmp/ws",
    );
    expect(resolveWorkspaceKey({ workspacePath: "/tmp/ws" })).toBe("/tmp/ws");
  });

  it("битые строки журнала пропускаются, реестр не падает", async () => {
    const ledger = createLedger();
    claim(ledger, "agent-a", ["src/a.ts"]);
    await ledger.flush();

    const truncated = readFileSync(journalPath, "utf8") + "not-json\n";
    writeFileSync(journalPath, truncated, "utf8");

    const restored = await WorkLedger.open({ journalPath, now: () => now });
    expect(restored.skippedLines).toBe(1);
    expect(restored.list({ status: "active" })).toHaveLength(1);
  });

  it("runId/attemptId сохраняются в claim, журнале и при replay", async () => {
    const ledger = createLedger();
    ledger.claim({
      agentId: "agent-a",
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
      intent: "правлю реестр",
      paths: ["src/runtime-task/work-ledger.ts"],
      runId: "root-session:turn-1",
      attemptId: "attempt-1",
    });
    await ledger.flush();

    const line = readFileSync(journalPath, "utf8")
      .split("\n")
      .find((candidate) => candidate.includes('"type":"claim"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({
      claim: { runId: "root-session:turn-1", attemptId: "attempt-1" },
    });

    const restored = await WorkLedger.open({ journalPath, now: () => now });
    expect(restored.list({ agentId: "agent-a" })[0]).toMatchObject({
      runId: "root-session:turn-1",
      attemptId: "attempt-1",
    });

    // Повторный claim обновляет audit-поля, а не создаёт вторую запись.
    const updated = ledger.claim({
      agentId: "agent-a",
      workspacePath,
      workspaceIdentity: WORKSPACE_IDENTITY,
      intent: "правлю реестр",
      paths: ["src/runtime-task/work-ledger.ts"],
      runId: "root-session:turn-2",
      attemptId: "attempt-2",
    });
    expect(updated.reused).toBe(true);
    expect(updated.claim.runId).toBe("root-session:turn-2");
    expect(updated.claim.attemptId).toBe("attempt-2");
  });

  it("старые записи журнала без runId/attemptId читаются", async () => {
    const record = {
      v: WORK_LEDGER_JOURNAL_VERSION,
      type: "claim",
      at: now,
      claim: {
        id: "legacy-claim",
        workspaceIdentity: WORKSPACE_IDENTITY,
        workspacePath,
        agentId: "agent-legacy",
        parentAgentId: null,
        profile: null,
        intent: "старая работа",
        paths: ["src/a.ts"],
        startedAt: now,
        heartbeatAt: now,
        status: "active",
      },
    };
    writeFileSync(journalPath, `${JSON.stringify(record)}\n`, "utf8");

    const restored = await WorkLedger.open({ journalPath, now: () => now });
    const claim = restored.list({ agentId: "agent-legacy" })[0];
    expect(claim?.paths).toEqual(["src/a.ts"]);
    expect(claim?.runId).toBeUndefined();
    expect(claim?.attemptId).toBeUndefined();
    expect(restored.skippedLines).toBe(0);
  });
});
