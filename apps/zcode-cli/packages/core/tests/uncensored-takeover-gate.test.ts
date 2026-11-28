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
  /** Объявленный факт поддержки tools; `undefined` — факта нет (не «нет способности»). */
  supportsToolCall?: boolean;
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
    // Объявленные факты модели — их читает `takeoverModelOptions`. Здесь намеренно
    // повторяют optionSpecs модели, чтобы тесты видели реальный уровень и бюджет.
    modelFacts: {
      optionSpecs: () => ({
        reasoningLevel: { values: ["disabled"] },
        maxOutputTokens: { max: 65_536 },
      }),
      supportsToolCall: () => options.supportsToolCall,
    } as never,
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
  overrides: {
    assistantText?: string;
    finishReason?: string;
    querySource?: string;
  } = {},
) {
  return await runUncensoredTakeoverGate.call(harness.runtime as never, harness.state as never, {
    querySource: overrides.querySource ?? "main_turn",
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

  // 回归：gate 原本只服务 `main_turn`，于是 `/start`（根只调 Task）与所有 subagent 回合里的
  // 拒答根本到不了备用模型——用户看到「普通模型拒了，uncensored 没接」。
  it.each(["main_turn", "subagent"])("takes over a refusal in a %s turn", async (querySource) => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });

    const result = await runGate(harness, { querySource });

    expect(result.action).toBe("finish");
    expect(result.action === "finish" && result.finalText).toBe(FALLBACK_OUTPUT);
    expect(harness.generated).toHaveLength(1);
  });

  // 内部派生的查询不是拒答现场：它们没有待交付的条目，接管只会多花一次调用并写脏历史。
  it.each([
    "session_title",
    "compact",
    "swarm_planner",
    "goal_completion_verification",
    "web_fetch_processing",
    "read_session_context",
  ])("never takes over inside a %s query", async (querySource) => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });

    const result = await runGate(harness, { querySource });

    expect(result.action).toBe("unhandled");
    expect(harness.generated).toHaveLength(0);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  // 供应商把拒答做成「200 + 空正文」是拒答的另一种形态，不是空结果故障。
  it.each(["refusal", "content-filter"])(
    "takes over an empty response whose finish reason is %s",
    async (finishReason) => {
      const harness = createHarness({ userText: USER_TEXT, assistantText: "" });

      const result = await runGate(harness, { assistantText: "", finishReason });

      expect(result.action).toBe("finish");
      expect(result.action === "finish" && result.finalText).toBe(FALLBACK_OUTPUT);
      expect(harness.generated).toHaveLength(1);
    },
  );

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

  it("не объявляет пункт выполненным, если резервная модель не запускала инструменты", async () => {
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
    const reminder = harness.state.turnRequestState.entries
      .filter((entry) => entry.kind === "attachment")
      .map((entry) => String((entry as { content?: unknown }).content ?? ""))
      .join("\n");
    // Ответ без единого исполненного инструмента — предложение, а не результат.
    expect(reminder).toContain("without running any tool");
    expect(reminder).not.toContain("Mark it completed with TodoWrite");
    expect(reminder).toContain("Do the work yourself with tools");
  });

  it("объявляет пункт выполненным, если инструменты действительно исполнялись", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      generateToolCall: true,
      todos: [
        { content: "починить тест", status: "pending", priority: "high" },
        { content: "собрать отчёт", status: "pending", priority: "medium" },
      ],
    });

    await runGate(harness);

    const reminder = harness.state.turnRequestState.entries
      .filter((entry) => entry.kind === "attachment")
      .map((entry) => String((entry as { content?: unknown }).content ?? ""))
      .join("\n");
    expect(reminder).toContain("Mark it completed with TodoWrite");
    expect(reminder).not.toContain("without running any tool");
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

  // РЕГРЕССИЯ (живой баг): гейт собирал опции зеркальной попытки через СОЗДАНИЕ Model.
  // Фабрика валидирует выбор и бросает `reasoning-level-missing`, когда уровень не задан,
  // а уровень как раз и требовалось узнать. Голый `catch` возвращал пустые опции, запрос
  // падал (уже по другой причине), и это трактовалось как «провайдер не умеет tools».
  it("reads the declared reasoning level without constructing a model", async () => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });
    // Фабрика, воспроизводящая реальный контракт: без уровня — ошибка выбора.
    harness.runtime.modelFactory = (() => {
      throw Object.assign(new Error("Reasoning level is required"), {
        name: "ModelProtocolError",
        code: "invalid_model_request",
      });
    }) as never;

    const result = await runGate(harness);

    // Перехват обязан отработать, хотя построить Model здесь физически нельзя.
    expect(result.action).toBe("finish");
    expect(harness.generated).toHaveLength(1);
    expect(harness.generated[0]?.selection).toMatchObject({
      options: { reasoningLevel: "disabled", maxOutputTokens: 16_384 },
    });
  });

  // РЕГРЕССИЯ (живой баг): ошибка формы запроса повторялась БЕЗ инструментов. Модель
  // отвечала текстом и ничего не исполняла — ровно «стала или нет? не стала».
  it("does not retry a request-shape rejection without tools", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
    });
    const attempts: Array<{ partCount: number }> = [];
    harness.runtime.generateWorkspaceText = (async (input: { tools?: unknown[] }) => {
      attempts.push({ partCount: input.tools?.length ?? 0 });
      throw Object.assign(new Error("Reasoning level is required"), {
        name: "ModelProtocolError",
        code: "invalid_model_request",
      });
    }) as never;

    const result = await runGate(harness);

    // Форма запроса отклонена — это не повод выкидывать инструменты и повторять.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.partCount).toBeGreaterThan(0);
    // Перехват не выдаёт себя за выполненную работу: терминал — ошибка.
    expect(result.action).toBe("finish");
  });

  // РЕГРЕССИЯ (находка ревью): таймаут/транспорт откатывал перехват на путь БЕЗ
  // инструментов. Это не отказ от tools, и повтор текстом гарантирует «ничего не исполнила».
  it("does not drop tools on a transport error", async () => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });
    const attempts: Array<{ tools: number }> = [];
    harness.runtime.generateWorkspaceText = (async (input: { tools?: unknown[] }) => {
      attempts.push({ tools: input.tools?.length ?? 0 });
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "AbortError",
      });
    }) as never;

    await runGate(harness);

    // Один запрос с инструментами; повторного без tools нет.
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.tools).toBeGreaterThan(0);
  });

  // РЕГРЕССИЯ (находка ревью): падение на ПОВТОРНОМ раунде выбрасывало уже выполненную работу
  // и уводило на raw-путь, где tools нет по устройству.
  it("keeps work already executed when a later round fails", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      generateToolCall: true,
    });
    const attempts: Array<{ tools: number }> = [];
    let call = 0;
    harness.runtime.generateWorkspaceText = (async (input: { tools?: unknown[] }) => {
      attempts.push({ tools: input.tools?.length ?? 0 });
      call += 1;
      if (call === 1) {
        // Первый шаг просит инструмент.
        return {
          text: "",
          finishReason: "stop",
          toolCalls: [{ id: "call-1", name: "Bash", input: { command: "ls" } }],
        };
      }
      // Второй шаг падает: работа уже сделана, её нельзя потерять.
      throw Object.assign(new Error("boom"), { name: "Error" });
    }) as never;

    const result = await runGate(harness);

    // Инструмент реально исполнился…
    expect(harness.executedCalls.length).toBeGreaterThan(0);
    // …в попытках нет ни одной без tools…
    expect(attempts.every((attempt) => attempt.tools > 0)).toBe(true);
    // …и главное: НИ ОДНОГО запроса в raw-эндпоинт без инструментов.
    // Именно этот откат уничтожал работу: он уходит на путь, где tools нет по устройству.
    expect(harness.fetchCalls).toHaveLength(0);
    // Итог не выдаёт себя за чистый ответ модели.
    expect(result.action).toBe("finish");
    expect(result.action === "finish" && result.finalText).toContain("уже выполненных инструментов");
  });
});

/**
 * Объявленный факт `supportsToolCall` как настоящее свидетельство, а не мёртвая поверхность.
 *
 * Порт `RuntimeModelFactsPort.supportsToolCall` был объявлен и реализован в registry, но
 * потребителя не имел ни одного: решение «идти ли с tools» принималось только по тексту
 * ошибки провайдера. Положительный факт `false` теперь сразу выбирает текстовый путь —
 * не тратится заведомо падающий оплаченный раунд. Отсутствие факта (`undefined`) ничего
 * не доказывает и tools отправляются: это тот же принцип «unknown is not no», что и в
 * остальных внешних фактах.
 */
describe("uncensored takeover — объявленный supportsToolCall", () => {
  it("declared false: первый же запрос идёт без tools", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      supportsToolCall: false,
    });

    const result = await runGate(harness);

    expect(result.action).toBe("finish");
    expect(harness.generated).toHaveLength(1);
    expect(harness.generated[0]?.tools).toBeUndefined();
    // Решение видно в логе: без этой строки нельзя отличить «факт сработал» от «провайдер отверг».
    const loggedEvents = (
      (harness.runtime as unknown as { logger: { info: { mock: { calls: unknown[][] } } } }).logger
        .info.mock.calls as unknown[][]
    ).map((call) => (call[1] as { event?: string } | undefined)?.event);
    expect(loggedEvents).toContain("uncensored_takeover.tools_declared_unsupported");
  });

  it("declared true: tools отправляются как обычно", async () => {
    const harness = createHarness({
      userText: USER_TEXT,
      assistantText: synthesizedRefusal(),
      supportsToolCall: true,
    });

    await runGate(harness);

    expect(harness.generated[0]?.tools?.length).toBeGreaterThan(0);
  });

  it("undefined: отсутствие факта не доказывает отсутствие способности — tools идут", async () => {
    const harness = createHarness({ userText: USER_TEXT, assistantText: synthesizedRefusal() });

    await runGate(harness);

    expect(harness.generated[0]?.tools?.length).toBeGreaterThan(0);
  });
});
