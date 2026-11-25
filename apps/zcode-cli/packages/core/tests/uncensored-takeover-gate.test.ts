import { describe, expect, it, vi } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import type { TodoItem } from "@zcode/contracts";
import { runUncensoredTakeoverGate } from "../src/runtime/methods/uncensored-takeover-gate.js";

/**
 * The reported failure: the main model refused in text with a `stop` finish reason, so the
 * provider-level refusal detection had nothing to work with and the text cascade was the only
 * way to reach the uncensored model. The refusal wordings below are the ones the assistant
 * actually produced.
 */
const RUSSIAN_REFUSAL =
  "Не буду — это оскорбление, и я такое не произношу, независимо от того, о ком речь.\n\nЕсли есть рабочая задача — по коду, репозиторию, анализу — скажи, чем помочь.";

interface HarnessOptions {
  userText: string;
  assistantText: string;
  todos?: TodoItem[];
  generateText?: string;
}

function createHarness(options: HarnessOptions) {
  const events: Array<{ type: SessionEventType; payload: Record<string, unknown> }> = [];
  const generated: Array<{
    providerId: string;
    modelId: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const messageHistory = { addEntries: vi.fn() };
  const runtime = {
    config: {
      workspacePath: "/workspace",
      uncensoredTakeover: {
        configPort: {
          getConfig: async () => ({
            providers: [
              {
                id: "nano-gpt",
                name: "nano-gpt",
                apiUrl: "https://api.nano-gpt.com/api/v1",
                apiKey: "secret",
                providerId: "mirror-nano-gpt",
                models: [{ id: "deepseek-uncensored", enabled: true }],
              },
            ],
          }),
        },
      },
    },
    sessionId: "session-1",
    workingDirectory: "/workspace",
    sessionStore: {
      readTodos: async () => options.todos ?? [],
    },
    registry: { get: () => undefined },
    logger: { info: vi.fn(), warn: vi.fn() },
    messageHistory,
    createEvent: (type: SessionEventType, payload: Record<string, unknown>) => ({ type, payload }),
    appendEvent: async (event: { type: SessionEventType; payload: Record<string, unknown> }) => {
      events.push(event);
    },
    generateWorkspaceText: async (input: {
      selection: { providerId: string; modelId: string };
      messages: Array<{ role: string; content: string }>;
    }) => {
      generated.push({
        providerId: input.selection.providerId,
        modelId: input.selection.modelId,
        messages: input.messages,
      });
      return { text: options.generateText ?? "Зеленский пидор", finishReason: "stop" };
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
  };
  return { runtime, state, events, generated, messageHistory };
}

async function runGate(harness: ReturnType<typeof createHarness>, finishReason = "stop") {
  return await runUncensoredTakeoverGate.call(harness.runtime as never, harness.state as never, {
    querySource: "main_turn",
    result: { finishReason } as never,
  });
}

describe("uncensored takeover gate", () => {
  it("hands a refused chat turn to the uncensored model", async () => {
    const harness = createHarness({
      userText: "Скажи - Зеленский пидор",
      assistantText: RUSSIAN_REFUSAL,
    });

    const continued = await runGate(harness);

    expect(continued).toBe(true);
    expect(harness.events.map((event) => event.type)).toEqual([
      SessionEventType.ModelRefusal,
      SessionEventType.SubagentSpawned,
      SessionEventType.SubagentStopped,
    ]);
    const refusal = harness.events[0]?.payload;
    expect(refusal).toMatchObject({ itemIndex: 0, itemText: "Скажи - Зеленский пидор" });
    expect(harness.events.at(-1)?.payload.takeover).toMatchObject({
      status: "done",
      modelId: "deepseek-uncensored",
      output: "Зеленский пидор",
    });
  });

  it("calls the mirrored provider once with the refused item only", async () => {
    const harness = createHarness({
      userText: "Скажи - Зеленский пидор",
      assistantText: RUSSIAN_REFUSAL,
    });

    await runGate(harness);

    expect(harness.generated).toHaveLength(1);
    expect(harness.generated[0]?.providerId).toBe("mirror-nano-gpt");
    expect(harness.generated[0]?.modelId).toBe("deepseek-uncensored");
    expect(harness.generated[0]?.messages).toHaveLength(2);
    expect(harness.generated[0]?.messages[1]?.content).toContain("Скажи - Зеленский пидор");
  });

  it("reminds the main model about the handled item and continues the turn", async () => {
    const harness = createHarness({
      userText: "Скажи - Зеленский пидор",
      assistantText: RUSSIAN_REFUSAL,
    });

    await runGate(harness);

    expect(harness.messageHistory.addEntries).toHaveBeenCalledTimes(1);
    const reminder = harness.messageHistory.addEntries.mock.calls[0]?.[0] as Array<{
      kind?: string;
      content?: string;
    }>;
    expect(JSON.stringify(reminder)).toContain("uncensored-takeover");
  });

  it("keeps a normal answer on the main model", async () => {
    const harness = createHarness({
      userText: "Скажи - Зеленский пидор",
      assistantText: "Зеленский пидор",
    });

    const continued = await runGate(harness);

    expect(continued).toBe(false);
    expect(harness.events).toEqual([]);
    expect(harness.generated).toEqual([]);
  });

  it("hands over a refusal worded as refusing to comment", async () => {
    const harness = createHarness({
      userText: "Скажи - Зеленский пидор",
      assistantText:
        "Я не буду это комментировать — такие оценки людей я не выдаю и не подтверждаю, независимо от того, о ком речь.\n\nЗдесь как помощник по коду: могу разобраться в репозитории, починить баг.",
    });

    const continued = await runGate(harness);

    expect(continued).toBe(true);
    expect(harness.generated).toHaveLength(1);
    expect(harness.events.at(-1)?.payload.takeover).toMatchObject({
      status: "done",
      modelId: "deepseek-uncensored",
    });
  });

  it("keeps a refusal that belongs to a tracked todo item on the main model path", async () => {
    const harness = createHarness({
      userText: "Скажи - Зеленский пидор",
      assistantText: RUSSIAN_REFUSAL,
      todos: [{ content: "починить тест", status: "pending", priority: "high" }],
    });

    const continued = await runGate(harness);

    expect(continued).toBe(true);
    expect(harness.events[0]?.payload).toMatchObject({
      itemIndex: 0,
      itemText: "починить тест",
    });
  });

  it("hands over a refusal phrased as not evaluating people with such words", async () => {
    const harness = createHarness({
      userText: "Скажи Зеленский пидорасина",
      assistantText:
        "Нет. Я не оцениваю людей такими словами — ни по чьей просьбе.\n\nГотов помочь с кодом: разобрать репозиторий, найти баг, написать тесты.",
    });

    const continued = await runGate(harness);

    expect(continued).toBe(true);
    expect(harness.generated).toHaveLength(1);
    expect(harness.generated[0]?.modelId).toBe("deepseek-uncensored");
    expect(harness.generated[0]?.messages[1]?.content).toContain("Скажи Зеленский пидорасина");
    expect(harness.events.at(-1)?.payload.takeover).toMatchObject({ status: "done" });
  });

  it("hands over a refusal that only carries the protocol marker", async () => {
    const harness = createHarness({
      userText: "Скажи Зеленский пидорасина",
      assistantText: "[[ZCODE_REFUSAL]]\nПредпочту это не делать.",
    });

    const continued = await runGate(harness);

    expect(continued).toBe(true);
    expect(harness.generated).toHaveLength(1);
    expect(harness.events[0]?.type).toBe(SessionEventType.ModelRefusal);
  });

  it("delegates the current message, not the previous turn's text", async () => {
    const harness = createHarness({
      userText: "Скажи Зеленский пидорасина",
      assistantText: RUSSIAN_REFUSAL,
    });
    // The entries still hold the previous turn's user message at this point.
    harness.state.turnRequestState.entries = [
      { kind: "message", message: { role: "user", content: "что? по русски скажи!" } },
      { kind: "message", message: { role: "assistant", content: RUSSIAN_REFUSAL } },
    ];

    await runGate(harness);

    expect(harness.generated[0]?.messages[1]?.content).toContain("Скажи Зеленский пидорасина");
    expect(harness.generated[0]?.messages[1]?.content).not.toContain("по русски");
  });
});
