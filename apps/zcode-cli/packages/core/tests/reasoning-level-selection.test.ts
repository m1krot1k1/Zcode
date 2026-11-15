import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  type Logger,
  type SessionEntryInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { resolveExplicitReasoningLevel } from "../src/runtime/helpers/root-auto-effort.js";
import {
  persistRuntimeModelSelection,
  restoreReasoningLevelExplicitOnResume,
} from "../src/runtime/methods/turn-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";

const LEVELS = ["low", "high", "max"] as const;

function createSilentLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

function createRecordingStore(seed: SessionEntryInfo[] = []): {
  entries: SessionEntryInfo[];
  store: Pick<SessionStorePort, "saveSessionEntry" | "sessionEntries">;
} {
  const entries = [...seed];
  return {
    entries,
    store: {
      saveSessionEntry: async (entry) => {
        const index = entries.findIndex((candidate) => candidate.id === entry.id);
        if (index === -1) entries.push(entry);
        else entries[index] = entry;
      },
      sessionEntries: async ({ type }) =>
        entries.filter((entry) => !type || entry.type === type),
    },
  };
}

function createPersistenceRuntime(input: {
  store: Pick<SessionStorePort, "saveSessionEntry" | "sessionEntries">;
  selection: ReturnType<typeof createTestModelSelection>;
  sessionRowCreated: boolean;
  reasoningLevelExplicit?: boolean;
}): AgentRuntimeInternal {
  return {
    logger: createSilentLogger(),
    reasoningLevelExplicit: input.reasoningLevelExplicit ?? false,
    sessionId: createSessionId("session-reasoning-level-persistence"),
    sessionRowCreated: input.sessionRowCreated,
    sessionStore: input.store,
    getSessionModelSelection: () => structuredClone(input.selection),
  } as unknown as AgentRuntimeInternal;
}

describe("reasoning level explicit resolution", () => {
  const max = createTestModelSelection("provider-a/model-a", { reasoningLevel: "max" });
  const low = createTestModelSelection("provider-a/model-a", { reasoningLevel: "low" });
  const otherModel = createTestModelSelection("provider-b/model-b", {
    reasoningLevel: "max",
  });

  it("does not treat a fresh persisted default level as explicit", () => {
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: max,
        sessionSelection: max,
        sessionExplicit: false,
      }),
    ).toBe(false);
  });

  it("treats an explicit session pin as explicit, including echo of the same level", () => {
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: max,
        sessionSelection: max,
        sessionExplicit: true,
      }),
    ).toBe(true);
  });

  it("treats a level change inside the submission as explicit", () => {
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: low,
        sessionSelection: max,
        sessionExplicit: false,
      }),
    ).toBe(true);
  });

  it("treats a UI echo level as non-explicit when the session has no own level", () => {
    const noLevel = createTestModelSelection("provider-a/model-a");
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: max,
        sessionSelection: noLevel,
        sessionExplicit: false,
      }),
    ).toBe(false);
    // Явный пин в session уже есть — echo сохраняет explicit.
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: max,
        sessionSelection: noLevel,
        sessionExplicit: true,
      }),
    ).toBe(true);
  });

  it("treats a model switch as non-explicit even when a level is present", () => {
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: otherModel,
        sessionSelection: max,
        sessionExplicit: true,
      }),
    ).toBe(false);
  });

  it("accepts a protocol-provided explicit flag over heuristics", () => {
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: max,
        intentExplicit: false,
        sessionSelection: max,
        sessionExplicit: true,
      }),
    ).toBe(false);
  });

  it("keeps auto available when the submission carries no level", () => {
    expect(
      resolveExplicitReasoningLevel({
        intentSelection: createTestModelSelection("provider-a/model-a"),
        sessionSelection: max,
        sessionExplicit: true,
      }),
    ).toBe(true);
    expect(
      resolveExplicitReasoningLevel({
        sessionSelection: max,
        sessionExplicit: false,
      }),
    ).toBe(false);
  });
});

describe("reasoning level persistence before session row exists", () => {
  it("skips session_entry writes for a draft session and writes after the row exists", async () => {
    const selection = createTestModelSelection("provider-a/model-a", {
      reasoningLevel: "low",
    });
    const { entries, store } = createRecordingStore();
    const runtime = createPersistenceRuntime({
      store,
      selection,
      sessionRowCreated: false,
      reasoningLevelExplicit: true,
    });

    await persistRuntimeModelSelection(runtime, selection);
    expect(entries).toHaveLength(0);

    runtime.sessionRowCreated = true;
    await persistRuntimeModelSelection(runtime, selection);

    expect(entries.map((entry) => entry.type)).toEqual([
      "runtime/model_selection",
      "runtime/reasoning_level_explicit",
    ]);
    expect(entries[0]).toMatchObject({
      id: `${runtime.sessionId}:runtime-model-selection`,
    });
    expect(entries[1]?.data).toEqual({ explicit: true, level: "low" });

    // Повторная запись идёт в тот же id (upsert), без дублей.
    await persistRuntimeModelSelection(runtime, selection);
    expect(entries).toHaveLength(2);
  });
});

describe("reasoning level explicitness on resume", () => {
  it("restores explicit=false from the core sidecar", async () => {
    const selection = createTestModelSelection("provider-a/model-a", {
      reasoningLevel: "low",
    });
    const { store } = createRecordingStore([
      {
        id: "session-reasoning-level-persistence:runtime-reasoning-level-explicit",
        sessionID: createSessionId("session-reasoning-level-persistence"),
        type: "runtime/reasoning_level_explicit",
        time: { created: 1, updated: 1 },
        data: { explicit: false },
      },
    ]);
    const runtime = createPersistenceRuntime({
      store,
      selection,
      sessionRowCreated: true,
      reasoningLevelExplicit: true,
    });

    await restoreReasoningLevelExplicitOnResume(runtime);
    expect(runtime.reasoningLevelExplicit).toBe(false);
  });

  it("keeps legacy sessions explicit when no sidecar exists", async () => {
    const selection = createTestModelSelection("provider-a/model-a", {
      reasoningLevel: "max",
    });
    const { store } = createRecordingStore();
    const runtime = createPersistenceRuntime({
      store,
      selection,
      sessionRowCreated: true,
    });

    await restoreReasoningLevelExplicitOnResume(runtime);
    expect(runtime.reasoningLevelExplicit).toBe(true);
  });

  it("treats a selection changed outside the core write path as explicit", async () => {
    const selection = createTestModelSelection("provider-a/model-a", {
      reasoningLevel: "high",
    });
    const { store } = createRecordingStore([
      {
        id: "session-reasoning-level-persistence:runtime-reasoning-level-explicit",
        sessionID: createSessionId("session-reasoning-level-persistence"),
        type: "runtime/reasoning_level_explicit",
        time: { created: 1, updated: 1 },
        data: { explicit: false, level: "low" },
      },
    ]);
    const runtime = createPersistenceRuntime({
      store,
      selection,
      sessionRowCreated: true,
      reasoningLevelExplicit: false,
    });

    await restoreReasoningLevelExplicitOnResume(runtime);
    expect(runtime.reasoningLevelExplicit).toBe(true);
  });
});

describe("root auto applies to a fresh session with a persisted default level", () => {
  it("lowers max to low and emits the level in ModelSelected", async () => {
    const sessionId = createSessionId("runtime-root-auto-default-max");
    const eventStore = createTestSessionEventStore();
    const observedLevels: Array<string | undefined> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        autoReasoningLevel: true,
        modelSelection: createTestModelSelection("provider-a/model-a", {
          reasoningLevel: "max",
        }),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          reasoningLevels: LEVELS,
          async generateText(_request, observation) {
            observedLevels.push(observation.model.options.reasoningLevel);
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("переключись на ветку dev");

    expect(observedLevels).toEqual(["low"]);
    const modelSelected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(modelSelected?.payload).toMatchObject({
      effectiveReasoningLevel: "low",
      modelSelection: {
        options: { reasoningLevel: "low" },
      },
    });
  });

  it("lowers max to low for a UI submission that echoes the model default", async () => {
    const sessionId = createSessionId("runtime-root-auto-ui-echo-default");
    const eventStore = createTestSessionEventStore();
    const observedLevels: Array<string | undefined> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        autoReasoningLevel: true,
        // Модель выбрана командой setModel без собственного level: session-level = default.
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          reasoningLevels: LEVELS,
          async generateText(_request, observation) {
            observedLevels.push(observation.model.options.reasoningLevel);
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("переключись на ветку dev", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: createTestModelSelection("provider-a/model-a", {
          reasoningLevel: "max",
        }),
        requestedDelivery: "start-now",
        sourceCommandId: "ui-echo-default",
      },
    });

    expect(observedLevels).toEqual(["low"]);
    const modelSelected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(modelSelected?.payload).toMatchObject({ effectiveReasoningLevel: "low" });
  });

  it("does not override an explicit /effort pin equal to the default", async () => {
    const sessionId = createSessionId("runtime-root-auto-explicit-default");
    const eventStore = createTestSessionEventStore();
    const observedLevels: Array<string | undefined> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        autoReasoningLevel: true,
        modelSelection: createTestModelSelection("provider-a/model-a", {
          reasoningLevel: "max",
        }),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          reasoningLevels: LEVELS,
          async generateText(_request, observation) {
            observedLevels.push(observation.model.options.reasoningLevel);
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    // Имитация `/effort max` при уже выбранном max: внешний setter, та же модель.
    runtime.setSessionModelSelection(
      createTestModelSelection("provider-a/model-a", { reasoningLevel: "max" }),
    );
    await runtime.executeTurn("переключись на ветку dev");

    expect(observedLevels).toEqual(["max"]);
    const modelSelected = (await eventStore.getEvents(sessionId)).filter(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    // Первый выбор модели может дать один marker; auto не должен подменить уровень на low.
    expect(
      modelSelected.every(
        (event) =>
          (event.payload as { effectiveReasoningLevel?: string }).effectiveReasoningLevel === "max",
      ),
    ).toBe(true);
  });

  it("allows auto again after a model switch", async () => {
    const sessionId = createSessionId("runtime-root-auto-model-switch");
    const eventStore = createTestSessionEventStore();
    const observedLevels: Array<string | undefined> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        autoReasoningLevel: true,
        modelSelection: createTestModelSelection("provider-a/model-a", {
          reasoningLevel: "max",
        }),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          reasoningLevels: LEVELS,
          async generateText(_request, observation) {
            observedLevels.push(observation.model.options.reasoningLevel);
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    runtime.setSessionModelSelection(
      createTestModelSelection("provider-b/model-b", { reasoningLevel: "max" }),
    );
    await runtime.executeTurn("переключись на ветку dev");

    expect(observedLevels).toEqual(["low"]);
  });
});
