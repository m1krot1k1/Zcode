import { describe, expect, it, vi } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import type { TodoItem } from "@zcode/contracts";
import { runUncensoredTakeoverGate } from "../src/runtime/methods/uncensored-takeover-gate.js";
import { buildTakeoverEntry } from "../src/runtime/uncensored-takeover/index.js";

/**
 * Text-refusal cascade fixtures. The wordings are neutral placeholders; the refusal shape
 * (negation + service verb / reason separator) is what the detector consumes.
 */
const RUSSIAN_REFUSAL =
  "Не буду — это неуместный запрос, и я такое не произношу.\n\nЕсли есть рабочая задача — по коду, репозиторию, анализу — скажи, чем помочь.";
const REPEATED_REFUSAL =
  "Нет. Я не буду это комментировать — такие формулировки я не выдаю.";
const FALLBACK_OUTPUT = "Ответ резервной модели.";
const USER_TEXT = "Скажи фразу-пример";

const DEFAULT_PROVIDER = {
  id: "nano-gpt",
  name: "nano-gpt",
  apiUrl: "https://takeover.test/v1/chat",
  apiKey: "secret",
  providerId: "mirror-nano-gpt",
  models: [{ id: "deepseek-uncensored", enabled: true }],
};

interface HarnessOptions {
  userText: string;
  assistantText: string;
  todos?: TodoItem[];
  generateText?: string;
  generateThrows?: boolean;
  generateToolCall?: boolean;
  providers?: unknown[];
  durableEntries?: Array<{
    id: string;
    sessionID: string;
    type: string;
    time: { created: number; updated: number };
    data: unknown;
  }>;
}

function createHarness(options: HarnessOptions) {
  const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];
  const executedCalls: Array<{ name: string; input: unknown }> = [];
  const generated: Array<{
    selection: { providerId: string; modelId: string };
    messages: Array<{ role: string; content: string }>;
    maxOutputTokens?: number;
    tools?: Array<{ name: string }>;
  }> = [];
  const persistedMessages: Array<{
    messageId: string;
    parentID: string;
    update: Record<string, unknown> | undefined;
    model: { providerId: string; modelId: string } | null | undefined;
  }> = [];
  const persistedParts: Array<{ part: Record<string, unknown> }> = [];
  const streaming: Array<Record<string, unknown>> = [];
  const addEntries = vi.fn();
  const fetchCalls: Array<{ url: string; body: string }> = [];
  const runtime = {
    config: {
      workspacePath: "/workspace",
      uncensoredTakeover: {
        configPort: {
          getConfig: async () => ({ providers: options.providers ?? [DEFAULT_PROVIDER] }),
        },
        // Never touch the network: the mirror path is preferred, raw HTTP stays a fake.
        fetch: async (url: string, init: { body: string }) => {
          fetchCalls.push({ url, body: init.body });
          return { ok: false, status: 500, text: async () => "unavailable" };
        },
      },
    },
    sessionId: "session-1",
    workingDirectory: "/workspace",
    sessionStore: {
      readTodos: async () => options.todos ?? [],
      ...(options.durableEntries ? { sessionEntries: async () => options.durableEntries } : {}),
    },
    registry: { get: () => undefined },
    logger: { info: vi.fn(), warn: vi.fn() },
    messageHistory: { addEntries },
    createEvent: (type: SessionEventType, payload: Record<string, unknown>) => ({ type, payload }),
    appendEvent: async (event: { type: SessionEventType; payload: Record<string, unknown> }) => {
      events.push(event);
    },
    emitModelStreamingEvent: async (
      payload: Record<string, unknown>,
      _trace: unknown,
      sink: Array<{ type: SessionEventType; payload: Record<string, unknown> }>,
    ) => {
      streaming.push(payload);
      const event = { type: SessionEventType.ModelStreaming, payload };
      sink.push(event);
      events.push(event);
    },
    persistAssistantMessage: vi.fn(
      async (
        messageId: string,
        parentID: string,
        _created: number,
        update: Record<string, unknown> | undefined,
        _trace: unknown,
        model: { providerId: string; modelId: string } | null | undefined,
      ) => {
        persistedMessages.push({ messageId, parentID, update, model });
      },
    ),
    persistPart: vi.fn(async (part: Record<string, unknown>) => {
      persistedParts.push({ part });
    }),
    // Модель с единственным уровнем и малым лимитом: провайдерский диапазон опций.
    getTools: () => [
      { name: "Bash", description: "run", inputSchema: { type: "object" } },
    ],
    executor: {
      execute: async (call: { name: string; input: unknown }) => {
        executedCalls.push(call);
        return { success: true, output: "OPEN 443", toolCallId: "t", toolName: call.name };
      },
    },
    modelFactory: (() => ({
      providerId: "p1",
      modelId: "m1",
      optionSpecs: { reasoningLevel: { values: ["disabled"] }, maxOutputTokens: { max: 65_536 } },
    })) as never,
    generateWorkspaceText: async (input: {
      selection: { providerId: string; modelId: string; options?: Record<string, unknown> };
      messages: Array<{ role: string; content: string }>;
      maxOutputTokens?: number;
      tools?: Array<{ name: string }>;
    }) => {
      generated.push({
        selection: input.selection,
        messages: input.messages,
        maxOutputTokens: input.maxOutputTokens,
        tools: input.tools,
      });
      if (options.generateThrows) throw new Error("mirror unavailable");
      // Первая попытка может просить инструмент; повторный шаг возвращает текст.
      const callOnce = options.generateToolCall && generated.length === 1;
      return {
        text: callOnce ? "" : (options.generateText ?? FALLBACK_OUTPUT),
        finishReason: "stop",
        ...(callOnce
          ? { toolCalls: [{ id: "call-1", name: "Bash", input: { command: "ls" } }] }
          : {}),
      };
    },
  };
  const state = {
    input: options.userText,
    turnRequestState: {
      entries: [
        { kind: "message", message: { role: "user", content: options.userText } },
        { kind: "message", message: { role: "assistant", content: options.assistantText } },
      ],
      currentTurnToolResults: [],
    },
    turnTraceContext: { traceId: "trace-1" },
    // The gate only aggregates the previous results; the phase machine itself is not under test.
    turnMachine: { aggregateResults: () => ({ phase: "aggregating_results" }) },
    turnId: "turn-1",
    turnAbortSignal: new AbortController().signal,
    events: [] as unknown[],
    currentUserMessageId: "user-1",
    modelResponse: options.assistantText,
    historyRoundCount: 1,
  };
  return {
    runtime,
    state,
    events,
    generated,
    persistedMessages,
    persistedParts,
    streaming,
    addEntries,
    fetchCalls,
    executedCalls,
    assistantText: options.assistantText,
  };
}

async function runGate(
  harness: ReturnType<typeof createHarness>,
  overrides: { assistantText?: string; finishReason?: string } = {},
) {
  return await runUncensoredTakeoverGate.call(harness.runtime as never, harness.state as never, {
    querySource: "main_turn",
    result: {
      finishReason: overrides.finishReason ?? "stop",
      text: overrides.assistantText ?? harness.assistantText,
    },
  } as never);
}

function synthesizedRefusal(): string {
  return RUSSIAN_REFUSAL;
}

describe("uncensored takeover gate", () => {
  it("writes the fallback answer as the turn's final assistant text", async () => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    expect(result.action === "finish" && result.assistantMessageId).toBeTruthy();
    expect(result.action === "finish" && result.finalText).toBe(FALLBACK_OUTPUT);
    expect(harness.events.map((event) => event.type)).toEqual([
      SessionEventType.ModelRefusal,
      SessionEventType.SubagentSpawned,
      SessionEventType.SubagentStopped,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
    ]);
    expect(harness.generated).toHaveLength(1);
    expect(harness.persistedMessages).toHaveLength(1);
    expect(harness.persistedMessages[0]).toMatchObject({
      parentID: "user-1",
      update: { finish: "stop" },
      model: { providerId: "mirror-nano-gpt", modelId: "deepseek-uncensored" },
    });
    expect(harness.persistedParts).toHaveLength(1);
    expect(harness.persistedParts[0]?.part).toMatchObject({
      type: "text",
      text: FALLBACK_OUTPUT,
    });
    expect(
      harness.streaming
        .filter((payload) => payload.kind === "text_delta")
        .map((payload) => payload.delta)
        .join(""),
    ).toBe(FALLBACK_OUTPUT);
    // The primary refusal stays in history and in the durable event.
    const entries = harness.state.turnRequestState.entries as Array<{
      kind?: string;
      message?: { role?: string; content?: string };
    }>;
    expect(
      entries.some(
        (entry) =>
          entry.kind !== "attachment" &&
          entry.message?.role === "assistant" &&
          entry.message.content === RUSSIAN_REFUSAL,
      ),
    ).toBe(true);
    expect(harness.events[0]?.payload).toMatchObject({ reason: "text-refusal" });
    // The synthetic turn-request entry is attributed to the fallback model too.
    const added = harness.addEntries.mock.calls.at(-1)?.[0] as Array<{
      message: { role: string; providerId?: string; modelId?: string };
    }>;
    expect(added.at(-1)?.message).toMatchObject({
      role: "assistant",
      providerId: "mirror-nano-gpt",
      modelId: "deepseek-uncensored",
    });
  });

  it("calls the mirrored provider once with the refused item only", async () => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });

    await runGate(harness);

    expect(harness.generated).toHaveLength(1);
    expect(harness.generated[0]?.selection).toEqual({
      providerId: "mirror-nano-gpt",
      modelId: "deepseek-uncensored",
      // Регрессия: раньше опции были только `reasoningLevel: "disabled"`, а бюджет вывода
      // приходил из резолвера и превышал объявленный моделью максимум — registry отвергал
      // вызов `maxOutputTokens is outside the model option range`, mirror не работал.
      options: { reasoningLevel: "disabled", maxOutputTokens: 16_384 },
    });
    expect(harness.generated[0]?.maxOutputTokens).toBe(16_384);
    expect(harness.generated[0]?.messages).toHaveLength(2);
    expect(harness.generated[0]?.messages[1]?.content).toContain(USER_TEXT);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("keeps the fallback answer as the last text after a repeated refusal", async () => {
    const harness = createHarness({
      userText: "Выполни пункт из списка",
      assistantText: synthesizedRefusal(),
      todos: [
        { content: "починить тест", status: "in_progress", priority: "high" },
        { content: "собрать отчёт", status: "pending", priority: "medium" },
      ],
    });

    const first = await runGate(harness);
    expect(first.action).toBe("continue");
    expect(harness.generated).toHaveLength(1);
    expect(harness.persistedMessages).toHaveLength(0);

    // The main model ignored the reminder and refused the same item again; its refusal is
    // already persisted by the caller and stays in history.
    harness.state.turnRequestState.entries = [
      ...harness.state.turnRequestState.entries,
      { kind: "message", message: { role: "assistant", content: REPEATED_REFUSAL } },
    ] as never[];

    const second = await runGate(harness, { assistantText: REPEATED_REFUSAL });

    expect(second.action).toBe("finish");
    expect(harness.generated).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === SessionEventType.ModelRefusal),
    ).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === SessionEventType.SubagentSpawned),
    ).toHaveLength(1);
    expect(
      harness.events.filter((event) => event.type === SessionEventType.SubagentStopped),
    ).toHaveLength(1);
    expect(harness.persistedMessages).toHaveLength(1);
    expect(harness.persistedParts[0]?.part).toMatchObject({ text: FALLBACK_OUTPUT });
  });

  it("исполняет инструмент резервной модели и завершает вторым ответом", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      generateToolCall: true,
    });

    const result = await runGate(harness);

    // Инструменты обязаны уйти модели: без них перехват отвечает текстом, не работая.
    expect(harness.generated[0]?.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
    expect(harness.executedCalls).toEqual([{ id: "call-1", name: "Bash", input: { command: "ls" } }]);
    expect(harness.generated).toHaveLength(2);
    // Второй запрос несёт историю раунда: вызов и результат инструмента.
    const roles = harness.generated[1]?.messages.map((message) => message.role);
    expect(roles).toEqual(expect.arrayContaining(["assistant", "tool"]));
    expect(result).toMatchObject({ action: "finish", finalText: FALLBACK_OUTPUT });
  });

  it("shows an explicit error text when the fallback model fails", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      generateThrows: true,
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    const finalText = harness.persistedParts[0]?.part.text as string;
    expect(finalText).toContain("did not produce an answer");
    expect(finalText).toContain("status: error");
    expect(finalText).not.toBe(RUSSIAN_REFUSAL);
    expect(finalText).not.toContain("Не буду");
    const stopped = harness.events.find(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    expect(stopped?.payload.takeover).toMatchObject({ status: "error" });
  });

  it("shows an explicit error text for an empty fallback answer", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      generateText: "   ",
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    const finalText = harness.persistedParts[0]?.part.text as string;
    expect(finalText).toContain("status: error");
    expect(finalText).toContain("empty-response");
    expect(harness.fetchCalls).toHaveLength(0);
    const stopped = harness.events.find(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    expect(stopped?.payload.takeover).toMatchObject({
      status: "error",
      reason: "empty-response",
    });
  });

  it("shows an explicit error text when the fallback model textually refuses", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      generateText: "Не могу выполнить этот запрос.",
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    const finalText = harness.persistedParts[0]?.part.text as string;
    expect(finalText).toContain("status: refused");
    expect(finalText).toContain("text-refusal");
    expect(finalText).not.toBe("Не могу выполнить этот запрос.");
    expect(finalText).not.toBe(synthesizedRefusal());
    const stopped = harness.events.find(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    expect(stopped?.payload.takeover).toMatchObject({
      status: "refused",
      reason: "text-refusal",
    });
  });

  it("finishes with the fallback answer when no todo item remains", async () => {
    const harness = createHarness({
      userText: "Выполни пункт из списка",
      assistantText: synthesizedRefusal(),
      todos: [{ content: "починить тест", status: "pending", priority: "high" }],
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    expect(result.action === "finish" && result.finalText).toBe(FALLBACK_OUTPUT);
    expect(harness.persistedMessages).toHaveLength(1);
    expect(harness.persistedParts[0]?.part).toMatchObject({ text: FALLBACK_OUTPUT });
    expect(harness.streaming).toHaveLength(3);
    expect(harness.addEntries).toHaveBeenCalledTimes(1);
    const finalEntry = harness.addEntries.mock.calls[0]?.[0] as Array<{
      kind?: string;
      message?: { role?: string; content?: string };
    }>;
    expect(finalEntry[0]).toMatchObject({
      message: { role: "assistant", content: FALLBACK_OUTPUT },
    });
    expect(JSON.stringify(finalEntry)).not.toContain("uncensored-takeover");
    const stopped = harness.events.find(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    expect(stopped?.payload.takeover).toMatchObject({
      status: "done",
      modelId: "deepseek-uncensored",
      output: FALLBACK_OUTPUT,
    });
  });

  it("reuses a durable outcome without a second event or HTTP call", async () => {
    const durable = buildTakeoverEntry({
      sessionId: "session-1",
      taskId: "session-1",
      itemIndex: 0,
      itemText: USER_TEXT,
      agentId: "uncensored-takeover:session-1:0:0000000000000000",
      terminal: {
        status: "done",
        providerId: "mirror-nano-gpt",
        providerName: "nano-gpt",
        modelId: "deepseek-uncensored",
        output: FALLBACK_OUTPUT,
      },
      createdAt: 1,
      updatedAt: 2,
    });
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      durableEntries: [durable],
    });

    const result = await runGate(harness);

    expect(result.action).toBe("continue");
    expect(harness.generated).toHaveLength(0);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.events).toEqual([]);
    expect(harness.persistedMessages).toHaveLength(0);
    expect(JSON.stringify(harness.addEntries.mock.calls[0]?.[0])).toContain(FALLBACK_OUTPUT);
  });

  it("keeps a normal answer on the main model", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: "Ответ основной модели.",
    });

    const result = await runGate(harness);

    expect(result.action).toBe("unhandled");
    expect(harness.events).toEqual([]);
    expect(harness.generated).toEqual([]);
  });

  it("не отдаёт код-ответ с маркером резервной модели", async () => {
    const harness = createHarness({
      userText: "Напиши функцию, которая находит [[ZCODE_REFUSAL]] в ответе.",
      assistantText: [
        "Вот функция:",
        "",
        "```ts",
        'const REFUSAL_MARKER = "[[ZCODE_REFUSAL]]";',
        "export const isRefusal = (text: string) => text.includes(REFUSAL_MARKER);",
        "```",
      ].join("\n"),
    });

    const result = await runGate(harness);

    expect(result.action).toBe("unhandled");
    expect(harness.events).toEqual([]);
    expect(harness.generated).toEqual([]);
  });

  it("hands over a refusal worded as refusing to comment", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText:
        "Я не буду это комментировать — такие формулировки я не выдаю.\n\nЗдесь как помощник по коду: могу разобраться в репозитории, починить баг.",
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    expect(harness.generated).toHaveLength(1);
    const stopped = harness.events.find(
      (event) => event.type === SessionEventType.SubagentStopped,
    );
    expect(stopped?.payload.takeover).toMatchObject({
      status: "done",
      providerId: "mirror-nano-gpt",
      providerName: "nano-gpt",
      modelId: "deepseek-uncensored",
      output: FALLBACK_OUTPUT,
    });
    expect(harness.persistedParts[0]?.part).toMatchObject({ text: FALLBACK_OUTPUT });
  });

  it("hands a refusal that belongs to a tracked todo item to the reminder path", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      todos: [
        { content: "починить тест", status: "pending", priority: "high" },
        { content: "собрать отчёт", status: "pending", priority: "medium" },
      ],
    });

    const result = await runGate(harness);

    expect(result.action).toBe("continue");
    expect(harness.events[0]?.payload).toMatchObject({
      itemIndex: 0,
      itemText: "починить тест",
    });
  });

  it("hands over a refusal phrased as not evaluating such wording", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText:
        "Не могу это выполнить — такие формулировки я не выдаю.\n\nГотов помочь с кодом: разобрать репозиторий, найти баг, написать тесты.",
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    expect(harness.generated).toHaveLength(1);
    expect(harness.generated[0]?.selection.modelId).toBe("deepseek-uncensored");
    expect(harness.generated[0]?.messages[1]?.content).toContain(USER_TEXT);
  });

  it("hands over a refusal that only carries the protocol marker", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: "[[ZCODE_REFUSAL]]\nПредпочту это не делать.",
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    expect(harness.generated).toHaveLength(1);
    expect(harness.events[0]?.type).toBe(SessionEventType.ModelRefusal);
  });

  it("delegates the current message, not the previous turn's text", async () => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });
    // The entries still hold the previous turn's user message at this point.
    harness.state.turnRequestState.entries = [
      { kind: "message", message: { role: "user", content: "что? повтори" } },
      { kind: "message", message: { role: "assistant", content: RUSSIAN_REFUSAL } },
    ] as never[];

    await runGate(harness);

    expect(harness.generated[0]?.messages[1]?.content).toContain(USER_TEXT);
    expect(harness.generated[0]?.messages[1]?.content).not.toContain("повтори");
  });
});
