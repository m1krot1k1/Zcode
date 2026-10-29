import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { describe, expect, it } from "vitest";

import { buildPersistentAgentMemoryPrompt } from "../src/subagent/persistent-memory-prompt.js";
import {
  captureEvidenceGatedLesson,
  loadPersistentAgentMemory,
  projectPersistentAgentMemoryTools,
  resolvePersistentAgentMemoryRoot,
  sanitizePersistentAgentMemoryKey,
} from "../src/subagent/persistent-memory.js";
import {
  formatAgentProfilesForPrompt,
  getSwarmAgentProfiles,
  type AgentProfile,
} from "../src/subagent/profile.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const fixture = readFileSync(
  new URL("./fixtures/memory/custom-agent-memory.md", import.meta.url),
  "utf8",
).replace(/\n$/u, "");

const scopeGuidance = JSON.parse(
  readFileSync(
    new URL("./fixtures/memory/custom-agent-scope-guidance.json", import.meta.url),
    "utf8",
  ),
) as Record<"user" | "project" | "local", string>;

describe("persistent custom-agent memory", () => {
  it("uses the exact agent key replacement and three ZCode scope roots", () => {
    expect(sanitizePersistentAgentMemoryKey("reviewer/a b")).toBe("reviewer-a-b");
    expect(sanitizePersistentAgentMemoryKey("review😀agent")).toBe("review--agent");
    expect(sanitizePersistentAgentMemoryKey("!!!")).toBe("---");
    expect(sanitizePersistentAgentMemoryKey("")).toBe("unknown");

    expect(root("user")).toBe("/storage/agent-memory/reviewer-a-b");
    expect(root("project")).toBe("/workspace/app/.zcode/agent-memory/reviewer-a-b");
    expect(root("local")).toBe("/workspace/app/.zcode/agent-memory-local/reviewer-a-b");
  });

  it.each(["user", "project", "local"] as const)(
    "renders the exact empty %s-scope provider prompt",
    (scope) => {
      const memoryRoot = root(scope);
      const expected = fixture
        .replace("<MEMORY_ROOT>", memoryRoot)
        .replace("<SCOPE_GUIDANCE>", scopeGuidance[scope]);

      expect(
        buildPersistentAgentMemoryPrompt({ indexContent: "", rootDir: memoryRoot, scope }),
      ).toBe(expected);
    },
  );

  it("projects Write/Edit for built-in knowledge-curator project memory (AGENT-12)", async () => {
    const curator = getSwarmAgentProfiles([]).find((profile) => profile.name === "knowledge-curator");
    expect(curator?.memory).toBe("project");
    expect(curator?.tools).toEqual(["Read", "Glob", "Grep", "Task"]);

    const memory = { enabled: true, storageRoot: "/storage", use: true };
    const projected = projectPersistentAgentMemoryTools(
      { activeAgents: [curator!] },
      memory,
    ).activeAgents[0];
    expect(projected?.tools).toEqual(["Read", "Glob", "Grep", "Task", "Write", "Edit"]);
    expect(resolvePersistentAgentMemoryRoot({
      agentName: curator!.name,
      scope: "project",
      storageRoot: "/storage",
      workspaceRoot: "/workspace/app",
    })).toBe("/workspace/app/.zcode/agent-memory/knowledge-curator");

    const fs = new MemoryFileSystem();
    const loaded = await loadPersistentAgentMemory({
      fileSystemPort: fs,
      memory,
      profile: curator!,
      workspaceRoot: "/workspace/app",
    });
    expect(loaded?.rootDir).toBe("/workspace/app/.zcode/agent-memory/knowledge-curator");
    expect(loaded?.prompt).toContain("# Persistent Agent Memory");
  });

  it("loads non-empty MEMORY.md and applies the exact 200-line truncation warning", () => {
    const index = Array.from({ length: 201 }, (_, index) => `- memory ${index + 1}`).join("\n");
    const prompt = buildPersistentAgentMemoryPrompt({
      indexContent: index,
      rootDir: root("project"),
      scope: "project",
    });

    expect(prompt).toContain("## MEMORY.md\n\n- memory 1");
    expect(prompt).toContain("- memory 200\n\n> WARNING: MEMORY.md is 201 lines (limit: 200).");
    expect(prompt).not.toContain("- memory 201");
  });

  it("limits a single long MEMORY.md value and formats integer KB like the baseline", () => {
    const prompt = buildPersistentAgentMemoryPrompt({
      indexContent: "x".repeat(25_600),
      rootDir: root("local"),
      scope: "local",
    });

    expect(prompt).toContain(
      `${"x".repeat(25_000)}\n\n> WARNING: MEMORY.md is 25KB (limit: 24.4KB) — index entries are too long.`,
    );
  });

  it("adds only Write/Edit for explicit tools, then keeps existing filtering", () => {
    const profile = customProfile({
      disallowedTools: ["Edit"],
      memory: "project",
      tools: ["Grep"],
    });
    const definitions = { activeAgents: [profile] };
    const memory = { enabled: true, storageRoot: "/storage", use: true };
    const projected = projectPersistentAgentMemoryTools(definitions, memory).activeAgents[0];

    expect(projected?.tools).toEqual(["Grep", "Write", "Edit"]);
    expect(formatAgentProfilesForPrompt([projected!])).toContain(
      "- reviewer/a b: Review changes. (Tools: Grep, Write)",
    );
    expect(projectPersistentAgentMemoryTools(definitions, { ...memory, enabled: false })).toBe(
      definitions,
    );
    expect(projectPersistentAgentMemoryTools(definitions, undefined)).toBe(definitions);
    expect(projectPersistentAgentMemoryTools(definitions, { ...memory, storageRoot: "" })).toBe(
      definitions,
    );
    expect(
      projectPersistentAgentMemoryTools(
        { activeAgents: [customProfile({ memory: "project" })] },
        memory,
      ).activeAgents[0]?.tools,
    ).toBeUndefined();
    expect(
      projectPersistentAgentMemoryTools(
        { activeAgents: [customProfile({ memory: "project", tools: [] })] },
        memory,
      ).activeAgents[0]?.tools,
    ).toEqual(["Write", "Edit"]);
    expect(
      projectPersistentAgentMemoryTools({ activeAgents: [projected!] }, memory).activeAgents[0],
    ).toBe(projected);
    expect(profile.tools).toEqual(["Grep"]);
  });

  it("reads MEMORY.md for every child launch and creates nothing when globally disabled", async () => {
    const memoryRoot = root("project");
    const indexPath = join(memoryRoot, "MEMORY.md");
    const fileSystem = new MemoryFileSystem({ [indexPath]: "first index" });
    const profile = customProfile({ memory: "project", tools: ["Write"] });
    const memory = { enabled: true, storageRoot: "/storage", use: true };

    const first = await loadPersistentAgentMemory({
      fileSystemPort: fileSystem,
      memory,
      profile,
      workspaceRoot: "/workspace/app",
    });
    fileSystem.files[indexPath] = "second index";
    const second = await loadPersistentAgentMemory({
      fileSystemPort: fileSystem,
      memory,
      profile,
      workspaceRoot: "/workspace/app",
    });

    expect(first?.prompt).toContain("## MEMORY.md\n\nfirst index");
    expect(second?.prompt).toContain("## MEMORY.md\n\nsecond index");
    expect(first?.rootDir).toBe(memoryRoot);
    expect(fileSystem.createdDirectories).toContain(memoryRoot);

    const disabledFileSystem = new MemoryFileSystem({});
    expect(
      await loadPersistentAgentMemory({
        fileSystemPort: disabledFileSystem,
        memory: { enabled: false, storageRoot: "/storage", use: true },
        profile,
        workspaceRoot: "/workspace/app",
      }),
    ).toBeUndefined();
    expect(disabledFileSystem.createdDirectories.size).toBe(0);
  });

  it("still returns the custom Memory prompt when directory creation fails", async () => {
    const fileSystem = new MemoryFileSystem({});
    fileSystem.createDirectory = async () => {
      throw new Error("mkdir failed");
    };

    const loaded = await loadPersistentAgentMemory({
      fileSystemPort: fileSystem,
      memory: { enabled: true, storageRoot: "/storage", use: true },
      profile: customProfile({ memory: "user", tools: ["Write"] }),
      workspaceRoot: "/workspace/app",
    });

    expect(loaded?.rootDir).toBe("/storage/agent-memory/reviewer-a-b");
    expect(loaded?.prompt).toContain("# Persistent Agent Memory");
  });

  it("records one evidence-gated lesson after the same tool fails and later succeeds", async () => {
    const secret = "sk-live-secret-should-not-be-stored";
    const fs = new MemoryFileSystem({});
    const events = [
      toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-1", toolName: "Bash" }),
      toolEvent(SessionEventType.ToolCallError, {
        error: { code: "exit_1", message: secret, type: "ToolExecutionFailed" },
        toolCallId: "call-1",
      }),
      toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-2", toolName: "Bash" }),
      toolEvent(SessionEventType.ToolCallResult, { result: { content: secret }, toolCallId: "call-2" }),
    ];

    const first = await captureEvidenceGatedLesson(lessonInput(fs, events));
    const second = await captureEvidenceGatedLesson(lessonInput(fs, events));

    expect(first).toEqual({ written: true });
    expect(second).toEqual({ written: false });
    const root = "/workspace/app/.zcode/agent-memory/knowledge-curator";
    const lesson = fs.files[`${root}/lessons/Bash-ToolExecutionFailed-exit_1.md`];
    const index = fs.files[`${root}/MEMORY.md`];
    expect(lesson).toContain("Evidence: session session-1 turn turn-1");
    expect(lesson).not.toContain(secret);
    expect(index).toBe(
      "- [Bash recovered](lessons/Bash-ToolExecutionFailed-exit_1.md) — ToolExecutionFailed/exit_1\n",
    );
    expect(index).not.toContain(secret);
    expect(index.match(/Bash recovered/g)).toHaveLength(1);

    const secretCode = new MemoryFileSystem({});
    const coded = await captureEvidenceGatedLesson(
      lessonInput(secretCode, [
        toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-1", toolName: "Bash" }),
        toolEvent(SessionEventType.ToolCallError, {
          error: { code: "sk-live-secret", message: secret, type: "ToolExecutionFailed" },
          toolCallId: "call-1",
        }),
        toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-2", toolName: "Bash" }),
        toolEvent(SessionEventType.ToolCallResult, { toolCallId: "call-2" }),
      ]),
    );
    expect(coded.written).toBe(true);
    const stored = Object.values(secretCode.files).join("\n");
    expect(stored).not.toContain("sk-live-secret");
    expect(stored).toContain("Bash-ToolExecutionFailed-none.md");
  });

  it("does not record a lesson without a recovered tool, disabled memory, or a remote workspace", async () => {
    const fs = new MemoryFileSystem({});
    const onlyFailure = [
      toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-1", toolName: "Bash" }),
      toolEvent(SessionEventType.ToolCallError, {
        error: { message: "failed", type: "ToolExecutionFailed" },
        toolCallId: "call-1",
      }),
    ];
    const onlySuccess = [
      toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-2", toolName: "Bash" }),
      toolEvent(SessionEventType.ToolCallResult, { toolCallId: "call-2" }),
    ];

    expect((await captureEvidenceGatedLesson(lessonInput(fs, onlyFailure))).written).toBe(false);
    expect((await captureEvidenceGatedLesson(lessonInput(fs, onlySuccess))).written).toBe(false);
    expect(
      (
        await captureEvidenceGatedLesson({
          ...lessonInput(fs, recoveredBash()),
          memory: { enabled: false, storageRoot: "/storage", use: true },
        })
      ).written,
    ).toBe(false);
    expect(
      (await captureEvidenceGatedLesson({ ...lessonInput(fs, recoveredBash()), remoteWorkspace: true }))
        .written,
    ).toBe(false);
    expect(Object.keys(fs.files)).toEqual([]);
  });
});

function lessonInput(fs: MemoryFileSystem, events: SessionEvent[]) {
  return {
    events,
    fileSystemPort: fs,
    memory: { enabled: true, storageRoot: "/storage", use: true as const },
    remoteWorkspace: false,
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceRoot: "/workspace/app",
  };
}

function recoveredBash(): SessionEvent[] {
  return [
    toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-1", toolName: "Bash" }),
    toolEvent(SessionEventType.ToolCallError, {
      error: { message: "failed", type: "ToolExecutionFailed" },
      toolCallId: "call-1",
    }),
    toolEvent(SessionEventType.ToolCallScheduled, { toolCallId: "call-2", toolName: "Bash" }),
    toolEvent(SessionEventType.ToolCallResult, { toolCallId: "call-2" }),
  ];
}

function toolEvent(type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: `event-${type}-${JSON.stringify(payload)}` as SessionEvent["id"],
    payload,
    sequenceNumber: 1,
    sessionId: "session-1" as SessionEvent["sessionId"],
    timestamp: new Date("2026-10-29T00:00:00.000Z"),
    traceId: "trace-1" as SessionEvent["traceId"],
    turnId: "turn-1" as SessionEvent["turnId"],
    type,
  };
}

function root(scope: "user" | "project" | "local"): string {
  return resolvePersistentAgentMemoryRoot({
    agentName: "reviewer/a b",
    scope,
    storageRoot: "/storage",
    workspaceRoot: "/workspace/app",
  });
}

function customProfile(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    description: "Review changes.",
    name: "reviewer/a b",
    source: "project",
    systemPrompt: "Review carefully.",
    ...overrides,
  };
}
