import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createSessionId,
  type MessageWithParts,
  type SessionId,
  type UsageStorePort,
  type FileSystemPort,
} from "@zcode/contracts";
import { appendEvent } from "../src/runtime/methods/events.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
// Cold-path regression только для проверки durable-маркера: hydrate-путь принадлежит
// bootstrap, но сценарий проверяется на том же runtime/store, что и остальные кейсы файла.
import { ProductProjection } from "../../bootstrap/src/zcode-protocol-v4/product-projection.js";
import { synthesizeEventsFromMessages } from "../../bootstrap/src/zcode-protocol-v4/transcript-hydration.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/**
 * 该 store 只服务于持久化断言：core 的 persist 路径读取本 turn 的 assistant 消息并
 * 重写 metadata。Usage 等可选方法故意缺失——runtime 会在调用前检查，fixture 保持最小。
 */
function maxTurnsSessionStore() {
  return createRecordingSubagentSessionStore();
}

/**
 * Usage-факты проверяются на том же recording store: usageStoreFor требует все четыре
 * метода, поэтому недостающие дополняются no-op заглушками, а upsertTurnUsage — spy.
 */
function maxTurnsSessionStoreWithUsage() {
  const upsertTurnUsage = vi.fn(
    async (_fact: Parameters<UsageStorePort["upsertTurnUsage"]>[0]) => {},
  );
  const store = {
    ...maxTurnsSessionStore(),
    async recordModelUsage() {},
    upsertTurnUsage,
    async upsertToolUsage() {},
    async pruneUsage() {},
  };
  return { store: store as ReturnType<typeof maxTurnsSessionStore>, upsertTurnUsage };
}

/**
 * recording store 模拟 append-семантику, production sqlite upsert 覆盖同一 id；
 * 冷恢复 читает transcript как последний snapshot каждой message.
 */
function dedupeTranscript(messages: MessageWithParts[]): MessageWithParts[] {
  const indexById = new Map<string, number>();
  const ordered: MessageWithParts[] = [];
  for (const message of messages) {
    const id = String(message.info.id);
    // recording store append-ит каждое состояние part-а, production sqlite upsert-ит по id;
    // без дедупликации холодный путь видит устаревшие pending/running снимки tool-частей.
    const partsById = new Map<string, MessageWithParts["parts"][number]>();
    for (const part of message.parts) partsById.set(String(part.id), part);
    const snapshot = { info: message.info, parts: [...partsById.values()] };
    const index = indexById.get(id);
    if (index === undefined) {
      indexById.set(id, ordered.length);
      ordered.push(snapshot);
      continue;
    }
    ordered[index] = snapshot;
  }
  return ordered;
}

function coldProjection(messages: MessageWithParts[], sessionId: SessionId) {
  const transcript = dedupeTranscript(messages);
  const events = synthesizeEventsFromMessages(transcript, { sessionId });
  const projection = new ProductProjection(sessionId, "epoch-cold-max-turns");
  for (const event of events) projection.applyEvent(event);
  return { events, projection };
}

function coldTurnResults(
  messages: MessageWithParts[],
  sessionId: SessionId,
): Array<string | undefined> {
  return completionPayloads(coldProjection(messages, sessionId).events).map(
    (payload) => payload.resultType,
  );
}

function registerMarkerTool(registry: ReturnType<typeof createToolRegistry>): void {
  registry.register({
    inputSchema: {},
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name: "ReadMarker",
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler: async () => "marker-ok",
  });
}

function markerToolStep(step: number) {
  return {
    finishReason: "tool-calls",
    providerMetadata: undefined,
    text: `step ${step}`,
    toolCalls: [{ id: `marker-${step}`, name: "ReadMarker", input: {} }],
    usage,
  };
}

function completionPayloads(
  events: Awaited<ReturnType<ReturnType<typeof createTestSessionEventStore>["getEvents"]>>,
): Array<{ resultType?: string; response?: string }> {
  return events
    .filter((event) => event.type === SessionEventType.TurnComplete)
    .map((event) => event.payload as { resultType?: string; response?: string });
}

describe("maxTurns limit", () => {
  // MAXTURN-02：已完成 maxTurns 步后模型仍要求继续时，下一次 model step 不得启动，
  // 终态是 TurnComplete(error_max_turns)，并保留最后一个 assistant 文本。
  it("stops before the third model step and finishes with error_max_turns when maxTurns = 2", async () => {
    const sessionId = createSessionId("max-turns-limit-main");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    const infoLog = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: infoLog,
      warn: vi.fn(),
    };
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 2,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-limit",
      },
      {
        eventStore,
        logger: logger as never,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            return markerToolStep(modelCalls);
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("loop until the turn limit");

    expect(modelCalls).toBe(2);
    expect(result.response).toBe("step 2");
    // 契约要求达到上限有显式诊断事件，不能静默收口；受限结果不是普通 completed。
    expect(infoLog).toHaveBeenCalledWith(
      "Turn reached max turns limit",
      expect.objectContaining({
        event: "turn.max_turns.reached",
        maxTurns: 2,
        modelStepCount: 2,
        status: "failed",
      }),
    );
    const events = await eventStore.getEvents(sessionId);
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    const completions = completionPayloads(events);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      resultType: "error_max_turns",
      response: "step 2",
    });
  });

  // MAXTURN-02 durability：cold hydration 看不到 live 事件。最终步骤必须带
  // durable metadata.turnResult，否则重启后受限 turn 会恢复为 success
  // （docs/specs/max-turns-limit.md MAXTURN-08）。
  it("persists metadata.turnResult=error_max_turns on the final assistant step", async () => {
    const sessionId = createSessionId("max-turns-marker");
    const eventStore = createTestSessionEventStore();
    const sessionStore = maxTurnsSessionStore();
    const updateSessionSpy = vi.spyOn(sessionStore, "updateSession");
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 2,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-marker",
      },
      {
        eventStore,
        sessionStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            return markerToolStep(modelCalls);
          },
        } as never),
      },
    );

    await runtime.executeTurn("loop until the turn limit");

    const messages = (await sessionStore.messages({ sessionID: sessionId })).filter(
      (message) => message.info.role === "assistant",
    );
    const lastAssistant = messages.at(-1);
    expect(lastAssistant?.info.role).toBe("assistant");
    expect(
      lastAssistant?.info.role === "assistant" ? lastAssistant.info.metadata : undefined,
    ).toMatchObject({ turnResult: "error_max_turns" });
    // 仅 финальный шаг несёт маркер: предыдущий assistant остаётся обычным completed.
    expect(
      messages.slice(0, -1).every((message) => message.info.metadata?.turnResult === undefined),
    ).toBe(true);
    // lastOutcome пишется владельцем durable-события и не расходится с маркером.
    expect(updateSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: sessionId, lastOutcome: "error" }),
    );
  });

  // MAXTURN-09：пустой length-шаг откатывается, поэтому в текущем turn нет assistant
  // (turn-model-step.ts, includeEmptyAssistant:false + откат latestAssistantMessageId).
  // Глобальный указатель в этот момент смотрит на assistant предыдущего turn; маркер должен
  // попасть в технический якорь текущего turn, а не в чужое сообщение.
  it("anchors the marker to the limited turn when an empty length step is rolled back", async () => {
    const sessionId = createSessionId("max-turns-empty-length");
    const eventStore = createTestSessionEventStore();
    const sessionStore = maxTurnsSessionStore();
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 1,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-empty-length",
      },
      {
        eventStore,
        sessionStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "turn one done",
                usage,
              };
            }
            // Пустой length-шаг: output-token continuation耗尽тся на границе maxTurns.
            return { finishReason: "length", providerMetadata: undefined, text: "", usage };
          },
        } as never),
      },
    );

    await runtime.executeTurn("turn one");
    await runtime.executeTurn("turn two");

    expect(modelCalls).toBe(2);
    const transcript = dedupeTranscript(await sessionStore.messages({ sessionID: sessionId }));
    const assistants = transcript.filter((message) => message.info.role === "assistant");
    // turn 1 assistant + технический якорь turn 2; откатанный пустой шаг не остался.
    expect(assistants).toHaveLength(2);
    const [firstTurnAssistant, limitAnchor] = assistants;
    expect(firstTurnAssistant?.info.metadata?.turnResult).toBeUndefined();
    expect(limitAnchor?.info.metadata).toMatchObject({ turnResult: "error_max_turns" });
    expect(limitAnchor?.parts).toEqual([]);
    // Якорь принадлежит второму turn, а не предыдущему assistant.
    expect(limitAnchor?.info.anchor?.turnId).toBeDefined();
    expect(limitAnchor?.info.anchor?.turnId).not.toBe(firstTurnAssistant?.info.anchor?.turnId);
    expect(coldTurnResults(transcript, sessionId)).toEqual(["success", "error_max_turns"]);
    // Технический якорь — не пользовательская строка: пустой assistant без usage не должен
    // материализоваться в пустую assistantText row или сломать фазу ошибки.
    const { projection } = coldProjection(transcript, sessionId);
    const snapshot = projection.getSnapshot();
    expect(snapshot.control.phase).toBe("error");
    expect(snapshot.control.lastError).toMatchObject({ code: "error_max_turns" });
    expect(
      snapshot.rows.window.filter(
        (row) => row.kind === "assistantText" && row.text.trim().length === 0,
      ),
    ).toEqual([]);
  });

  // MAXTURN-10：граница после tool-only шагов. Маркер обязан лечь на assistant этого turn,
  // даже когда последний assistant — tool-call шаг, а не текст.
  it("keeps the marker on the current turn after tool-only steps", async () => {
    const sessionId = createSessionId("max-turns-tool-only-boundary");
    const eventStore = createTestSessionEventStore();
    const sessionStore = maxTurnsSessionStore();
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 1,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-tool-only-boundary",
      },
      {
        eventStore,
        sessionStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "turn one done",
                usage,
              };
            }
            return markerToolStep(modelCalls);
          },
        } as never),
      },
    );

    await runtime.executeTurn("turn one");
    await runtime.executeTurn("turn two");

    expect(modelCalls).toBe(2);
    const transcript = dedupeTranscript(await sessionStore.messages({ sessionID: sessionId }));
    const assistants = transcript.filter((message) => message.info.role === "assistant");
    expect(assistants).toHaveLength(2);
    const [firstTurnAssistant, limitedAssistant] = assistants;
    expect(firstTurnAssistant?.info.metadata?.turnResult).toBeUndefined();
    expect(limitedAssistant?.info.metadata).toMatchObject({ turnResult: "error_max_turns" });
    expect(limitedAssistant?.info.anchor?.turnId).not.toBe(firstTurnAssistant?.info.anchor?.turnId);
    expect(coldTurnResults(transcript, sessionId)).toEqual(["success", "error_max_turns"]);
  });

  // MAXTURN-11：ограниченный terminal обязан отражаться и в usage-факте, и в логе.
  // UsageStatus не содержит "failed", поэтому используется поддерживаемый "error";
  // errorType маркирует именно лимит ходов.
  it("records limited usage and log statuses as non-success", async () => {
    const sessionId = createSessionId("max-turns-usage-status");
    const eventStore = createTestSessionEventStore();
    const { store, upsertTurnUsage } = maxTurnsSessionStoreWithUsage();
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    const infoLog = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: infoLog,
      warn: vi.fn(),
    };
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 1,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-usage-status",
      },
      {
        eventStore,
        logger: logger as never,
        sessionStore: store,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls === 1) {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "turn one done",
                usage,
              };
            }
            return markerToolStep(modelCalls);
          },
        } as never),
      },
    );

    await runtime.executeTurn("turn one");
    await runtime.executeTurn("turn two");

    const usageFacts = upsertTurnUsage.mock.calls.map(([fact]) => fact);
    expect(usageFacts).toHaveLength(2);
    expect(usageFacts[0]).toMatchObject({ status: "completed" });
    expect(usageFacts[1]).toMatchObject({ status: "error", errorType: "error_max_turns" });
    const turnCompletedLogs = infoLog.mock.calls.filter(
      ([, context]) => (context as { event?: string } | undefined)?.event === "turn.completed",
    );
    expect(turnCompletedLogs).toHaveLength(1);
    expect(infoLog).toHaveBeenCalledWith(
      "Turn completed with max turns limit",
      expect.objectContaining({
        event: "turn.max_turns.completed",
        resultType: "error_max_turns",
        status: "failed",
      }),
    );
  });

  // 无受限终态的 turn 不能留下标记，否则 cold 路径会误报 failure。
  it("does not persist a turn-result marker for a successful turn", async () => {
    const sessionId = createSessionId("max-turns-marker-success");
    const eventStore = createTestSessionEventStore();
    const sessionStore = maxTurnsSessionStore();
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 3,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-marker-success",
      },
      {
        eventStore,
        sessionStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done early",
              usage,
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("answer before the limit");

    const messages = await sessionStore.messages({ sessionID: sessionId });
    expect(
      messages.every(
        (message) =>
          message.info.role !== "assistant" || message.info.metadata?.turnResult === undefined,
      ),
    ).toBe(true);
  });

  // MAXTURN-01 补充：非正数/дробное/NaN 不是「0 步上限」，runtime 必须按无限制处理。
  it.each([
    ["zero", 0],
    ["negative", -3],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
  ])("treats an invalid maxTurns value (%s) as unlimited", async (_label, maxTurns) => {
    const sessionId = createSessionId(`max-turns-invalid-${_label}`);
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-invalid",
      },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls <= 4) return markerToolStep(modelCalls);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage,
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("invalid maxTurns must not cap the loop");

    expect(modelCalls).toBe(5);
    expect(result.response).toBe("done");
    expect(completionPayloads(await eventStore.getEvents(sessionId))).toEqual([
      expect.objectContaining({ resultType: "success", response: "done" }),
    ]);
  });

  // Контракт: Stop/отмена приоритетнее лимита. Abort приходит из tool handler до
  // следующего model-step boundary; turn должен закончиться cancelled, не error_max_turns.
  it("keeps cancellation authoritative on the maxTurns boundary", async () => {
    const sessionId = createSessionId("max-turns-cancel-boundary");
    const eventStore = createTestSessionEventStore();
    const abortController = new AbortController();
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "AbortTurn",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        abortController.abort(new Error("user stop"));
        return "aborted";
      },
    });
    const infoLog = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: infoLog,
      warn: vi.fn(),
    };
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 1,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-cancel",
      },
      {
        eventStore,
        logger: logger as never,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            return {
              finishReason: "tool-calls",
              providerMetadata: undefined,
              text: `step ${modelCalls}`,
              toolCalls: [{ id: `abort-${modelCalls}`, name: "AbortTurn", input: {} }],
              usage,
            };
          },
        } as never),
      },
    );

    await expect(
      runtime.executeTurn("stop right at the limit", undefined, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });

    const events = await eventStore.getEvents(sessionId);
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(completionPayloads(events)).toEqual([
      expect.objectContaining({ resultType: "cancelled" }),
    ]);
    expect(
      infoLog.mock.calls.some(
        ([, context]) =>
          (context as { event?: string } | undefined)?.event === "turn.max_turns.reached",
      ),
    ).toBe(false);
  });

  // Узкое окно самого фикса: abort приходит во время async-возврата guide в очередь внутри
  // finishTurnAtMaxTurns. После await turn обязан ещё раз проверить abort и завершиться cancelled,
  // не публикуя error_max_turns.
  it("does not publish error_max_turns when the abort lands during the guide fallback await", async () => {
    const sessionId = createSessionId("max-turns-cancel-during-finish");
    const eventStore = createTestSessionEventStore();
    const abortController = new AbortController();
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    const infoLog = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info: infoLog,
      warn: vi.fn(),
    };
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 1,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-cancel-finish",
      },
      {
        eventStore,
        logger: logger as never,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            return markerToolStep(modelCalls);
          },
        } as never),
      },
    );
    const fallbackPendingGuidesToQueue = runtime.fallbackPendingGuidesToQueue.bind(runtime);
    const fallbackSpy = vi
      .spyOn(runtime, "fallbackPendingGuidesToQueue")
      .mockImplementation(async (options) => {
        const changed = await fallbackPendingGuidesToQueue(options);
        // 用户 Stop 恰好落在 guide 回退的 await 中。
        abortController.abort(new Error("user stop during limit finish"));
        return changed;
      });

    await expect(
      runtime.executeTurn("stop while the limit finalizer is awaiting", undefined, {
        abortSignal: abortController.signal,
      }),
    ).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
    expect(fallbackSpy).toHaveBeenCalled();

    const events = await eventStore.getEvents(sessionId);
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
    expect(completionPayloads(events)).toEqual([
      expect.objectContaining({ resultType: "cancelled" }),
    ]);
    expect(
      infoLog.mock.calls.some(
        ([, context]) =>
          (context as { event?: string } | undefined)?.event === "turn.max_turns.reached",
      ),
    ).toBe(false);
  });

  // MAXTURN-03：модель завершила ответ раньше лимита — обычный success, лимит не влияет.
  it("finishes with success when the model stops before the limit", async () => {
    const sessionId = createSessionId("max-turns-finish-early");
    const eventStore = createTestSessionEventStore();
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 3,
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-finish-early",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done early",
              usage,
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("answer before the limit");

    expect(modelCalls).toBe(1);
    expect(result.response).toBe("done early");
    expect(completionPayloads(await eventStore.getEvents(sessionId))).toEqual([
      expect.objectContaining({ resultType: "success", response: "done early" }),
    ]);
  });

  // MAXTURN-01：undefined 表示无限制，计数不能截断正常的多步工具循环。
  it("does not limit model steps when maxTurns is undefined", async () => {
    const sessionId = createSessionId("max-turns-unlimited-main");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    registerMarkerTool(registry);
    let modelCalls = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-unlimited",
      },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            modelCalls += 1;
            if (modelCalls <= 6) return markerToolStep(modelCalls);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage,
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("run several tool steps without a limit");

    expect(modelCalls).toBe(7);
    expect(result.response).toBe("done");
    expect(completionPayloads(await eventStore.getEvents(sessionId))).toEqual([
      expect.objectContaining({ resultType: "success", response: "done" }),
    ]);
  });

  // MAXTURN-05：profile.maxTurns 只约束 child runtime；父 runtime 按自己的配置继续。
  it("applies profile.maxTurns to the child runtime only", async () => {
    const parentSessionId = createSessionId("max-turns-child-limit");
    const eventStore = createTestSessionEventStore();
    let parentCalls = 0;
    let childCalls = 0;
    let childSessionId: SessionId | undefined;
    const runtime = createTestAgentRuntime(
      parentSessionId,
      {
        mode: "yolo",
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-child-limit",
        subagents: {
          profiles: [
            {
              name: "turn-limited-reviewer",
              description: "Child with an explicit turn limit.",
              source: "user",
              systemPrompt: "CHILD LIMIT PROFILE",
              tools: ["Read"],
              maxTurns: 2,
            },
          ],
        },
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            if (observation.invocationContext?.metadata?.querySource === "subagent") {
              childCalls += 1;
              childSessionId = observation.invocationContext.traceContext?.sessionId;
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: `child step ${childCalls}`,
                toolCalls: [
                  {
                    id: `child-read-${childCalls}`,
                    name: "Read",
                    input: { file_path: "/missing-max-turns-fixture" },
                  },
                ],
                usage,
              };
            }
            parentCalls += 1;
            if (parentCalls === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "spawn-limited-reviewer",
                    name: "Agent",
                    input: {
                      description: "review child",
                      prompt: "Run until the child turn limit is reached.",
                      subagent_type: "turn-limited-reviewer",
                    },
                  },
                ],
                usage,
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "parent done",
              usage,
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("delegate to the limited child");

    expect(childCalls).toBe(2);
    expect(result.response).toBe("parent done");
    expect(completionPayloads(await eventStore.getEvents(parentSessionId))).toEqual([
      expect.objectContaining({ resultType: "success", response: "parent done" }),
    ]);
    expect(childSessionId).toBeDefined();
    expect(completionPayloads(await eventStore.getEvents(childSessionId!))).toEqual([
      expect.objectContaining({ resultType: "error_max_turns", response: "child step 2" }),
    ]);
  });

  // MAXTURN-04：没有 profile.maxTurns 且没有 subagents.maxTurns 时 child 无限制；
  // 旧实现的 `?? 4` 会让第 5 步无法启动，这里用 6 个工具步直接回归该隐式上限。
  it("leaves the child unlimited when neither profile nor subagents defines maxTurns", async () => {
    const parentSessionId = createSessionId("max-turns-child-unlimited");
    const eventStore = createTestSessionEventStore();
    let parentCalls = 0;
    let childCalls = 0;
    let childSessionId: SessionId | undefined;
    const fileSystemPort = {
      stat: async ({ path }: { path: string }) => ({
        path,
        kind: "file" as const,
        sizeBytes: 7,
      }),
      readTextFileRange: async ({ path }: { path: string }) => ({
        path,
        content: "fixture",
        encoding: "utf8" as const,
        bytesRead: 7,
        sizeBytes: 7,
        truncated: false,
        startLine: 1,
        lineCount: 1,
        totalLines: 1,
      }),
    } as unknown as FileSystemPort;
    const runtime = createTestAgentRuntime(
      parentSessionId,
      {
        mode: "yolo",
        compact: { enabled: false },
        titleGeneration: { enabled: false },
        workingDirectory: "/tmp/zcode-max-turns-child-unlimited",
        subagents: {
          profiles: [
            {
              name: "turn-unlimited-reviewer",
              description: "Child without an explicit turn limit.",
              source: "user",
              systemPrompt: "CHILD UNLIMITED PROFILE",
              tools: ["Read"],
            },
          ],
        },
      },
      {
        eventStore,
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            if (observation.invocationContext?.metadata?.querySource === "subagent") {
              childCalls += 1;
              childSessionId = observation.invocationContext.traceContext?.sessionId;
              if (childCalls <= 6) {
                return {
                  finishReason: "tool-calls",
                  providerMetadata: undefined,
                  text: `child step ${childCalls}`,
                  toolCalls: [
                    {
                      id: `child-read-${childCalls}`,
                      name: "Read",
                      input: { file_path: "/tmp/zcode-max-turns-child-unlimited/fixture.txt" },
                    },
                  ],
                  usage,
                };
              }
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "child done",
                usage,
              };
            }
            parentCalls += 1;
            if (parentCalls === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "spawn-unlimited-reviewer",
                    name: "Agent",
                    input: {
                      description: "unlimited child",
                      prompt: "Run several tool steps without a limit.",
                      subagent_type: "turn-unlimited-reviewer",
                    },
                  },
                ],
                usage,
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "parent done",
              usage,
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("delegate to the unlimited child");
    expect(childCalls).toBe(7);
    expect(result.response).toBe("parent done");
    expect(childSessionId).toBeDefined();
    expect(completionPayloads(await eventStore.getEvents(childSessionId!))).toEqual([
      expect.objectContaining({ resultType: "success", response: "child done" }),
    ]);
  });
});

describe("session lastOutcome for limited turns", () => {
  // docs/specs/max-turns-limit.md：error_max_turns 是受限结果，不得持久化为 completed。
  it.each([
    ["success", "completed"],
    ["cancelled", "interrupted"],
    ["error_max_turns", "error"],
  ])("persists TurnComplete(%s) as %s", async (resultType, lastOutcome) => {
    const updateSession = vi.fn(async () => {});
    const event = {
      type: SessionEventType.TurnComplete,
      payload: { resultType },
      sessionId: "max-turns-outcome-session",
      timestamp: new Date(2000),
      sequenceNumber: 1,
    };
    await appendEvent.call(
      {
        eventStore: { append: async () => event },
        sessionStore: { updateSession },
        notifyEventSinks: async () => {},
      } as never,
      event as never,
      { traceId: "trace-max-turns-outcome" } as never,
    );
    expect(updateSession).toHaveBeenCalledWith({
      id: "max-turns-outcome-session",
      lastOutcome,
      timeUpdated: 2000,
    });
  });
});
