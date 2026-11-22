import { describe, expect, it, vi } from "vitest";
import { buildCursorReasoningMap } from "@zcode/provider";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  createCursorProvider,
  type CursorCliProcess,
  type CursorCliSpawn,
} from "../src/model/model-execution/cursor-provider.js";

function fakeProcess(
  events: readonly unknown[],
  options: { exitCode?: number | null; stderr?: string } = {},
): CursorCliProcess {
  const stdout = (async function* () {
    for (const event of events) {
      yield `${typeof event === "string" ? event : JSON.stringify(event)}\n`;
    }
  })();
  const stderr = (async function* () {
    if (options.stderr) yield `${options.stderr}\n`;
  })();
  return {
    stdout,
    stderr,
    kill: vi.fn(() => true),
    onClose: (listener) => queueMicrotask(() => listener(options.exitCode ?? 0)),
    onError: () => {},
  };
}

async function collect(
  stream: ReadableStream<{ type: string }>,
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];
  for await (const part of stream as unknown as AsyncIterable<Record<string, unknown>>) {
    parts.push(part);
  }
  return parts;
}

function createModel(spawn: CursorCliSpawn) {
  return createCursorProvider({ spawn, cwd: "/workspace", executablePath: "/bin/cursor-agent" })
    .languageModel("composer-1");
}

const prompt = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
};

describe("cursor-provider", () => {
  it("резолвит reasoningLevel в точный Cursor model id до запуска CLI", () => {
    const maps = compileModelOptionMaps({
      reasoningLevel: {
        map: buildCursorReasoningMap([
          { level: "default", modelId: "gpt-5.3-codex" },
          { level: "low", modelId: "gpt-5.3-codex-low" },
          { level: "high", modelId: "gpt-5.3-codex-high-fast" },
        ]),
      },
      maxOutputTokens: { map: "{}" },
    });
    expect(maps.apply({}, { reasoningLevel: "default", maxOutputTokens: 100 })).toEqual({
      modelId: "gpt-5.3-codex",
    });
    expect(maps.apply({}, { reasoningLevel: "low", maxOutputTokens: 100 })).toEqual({
      modelId: "gpt-5.3-codex-low",
    });
    expect(maps.apply({}, { reasoningLevel: "high", maxOutputTokens: 100 })).toEqual({
      modelId: "gpt-5.3-codex-high-fast",
    });
  });

  it("передаёт документированные флаги print/stream-json и рабочую директорию", async () => {
    const spawn = vi.fn<CursorCliSpawn>(() =>
      fakeProcess([{ type: "result", subtype: "success", is_error: false, result: "ok" }]),
    );
    const model = createModel(spawn);
    await model.doGenerate?.(prompt);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe("/bin/cursor-agent");
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--model",
      "composer-1",
      "--workspace",
      "/workspace",
      "--force",
      "hello",
    ]);
    expect(options.cwd).toBe("/workspace");
  });

  it("стримит дельты, отбрасывает дубликаты и завершает finish",async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
        {
          type: "assistant",
          timestamp_ms: 1,
          message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
        },
        {
          type: "assistant",
          timestamp_ms: 2,
          message: { role: "assistant", content: [{ type: "text", text: "lo" }] },
        },
        {
          type: "assistant",
          model_call_id: "call-1",
          message: { role: "assistant", content: [{ type: "text", text: "Hello duplicate" }] },
        },
        { type: "result", subtype: "success", is_error: false, result: "Hello" },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("");
    expect(text).toBe("Hello");
    expect(parts.at(-1)).toMatchObject({ type: "finish" });
  });

  it("маппит tool_call started/completed в providerExecuted части", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        {
          type: "tool_call",
          subtype: "started",
          call_id: "call-1",
          tool_call: { readToolCall: { args: { path: "src/index.ts" } } },
        },
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "call-1",
          tool_call: { readToolCall: { result: { success: { content: "file" } } } },
        },
        { type: "result", subtype: "success", is_error: false, result: "" },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    const toolCall = parts.find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      toolCallId: "call-1",
      providerExecuted: true,
      dynamic: true,
    });
    const toolResult = parts.find((part) => part.type === "tool-result");
    expect(toolResult).toMatchObject({ toolCallId: "call-1", dynamic: true });
  });

  it("is_error result завершает поток ошибкой без выдуманного текста", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        { type: "result", subtype: "error", is_error: true, result: "authentication required" },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    expect(parts.some((part) => part.type === "error")).toBe(true);
  });

  it("(a) склеивает частичные дельты в один блок и не дублирует result.result", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        ...["При", "вет", ",", " naj"].map((text, index) => ({
          type: "assistant",
          timestamp_ms: index + 1,
          message: { role: "assistant", content: [{ type: "text", text }] },
        })),
        { type: "result", subtype: "success", is_error: false, result: "Привет, naj" },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    const textStarts = parts.filter((part) => part.type === "text-start");
    const textEnds = parts.filter((part) => part.type === "text-end");
    const deltas = parts.filter((part) => part.type === "text-delta");
    // Ровно одна граница блока: иначе UI создаёт отдельный абзац на каждый чанк.
    expect(textStarts).toHaveLength(1);
    expect(textEnds).toHaveLength(1);
    expect(deltas).toHaveLength(4);
    // Стабильный id у всех частей одного блока.
    expect(new Set(deltas.map((part) => part.id))).toEqual(new Set(["cursor-text-0"]));
    expect(textStarts[0]!.id).toBe("cursor-text-0");
    expect(textEnds[0]!.id).toBe("cursor-text-0");
    // result.result не дописан повторно.
    expect(deltas.map((part) => part.delta).join("")).toBe("Привет, naj");
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
    expect(parts.at(-1)).toMatchObject({ type: "finish" });
  });

  it("(b) без дельт отдаёт result.result одним блоком", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        { type: "result", subtype: "success", is_error: false, result: "Готово." },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    expect(parts.filter((part) => part.type === "text-start")).toHaveLength(1);
    expect(parts.filter((part) => part.type === "text-end")).toHaveLength(1);
    const deltas = parts.filter((part) => part.type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ id: "cursor-text-0", delta: "Готово." });
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
  });

  it("(d) стримит thinking как reasoning-части и закрывает блок", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        { type: "system", subtype: "init", session_id: "s1" },
        { type: "thinking", subtype: "delta", text: "The user" },
        { type: "thinking", subtype: "delta", text: " asks who I am." },
        { type: "thinking", subtype: "completed" },
        ...["I", " am", " Auto", "."].map((text, index) => ({
          type: "assistant",
          timestamp_ms: index + 1,
          message: { role: "assistant", content: [{ type: "text", text }] },
        })),
        { type: "result", subtype: "success", is_error: false, result: "I am Auto." },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    expect(parts.filter((part) => part.type === "reasoning-start")).toHaveLength(1);
    expect(parts.filter((part) => part.type === "reasoning-end")).toHaveLength(1);
    const reasoning = parts
      .filter((part) => part.type === "reasoning-delta")
      .map((part) => part.delta)
      .join("");
    expect(reasoning).toBe("The user asks who I am.");
    expect(parts.filter((part) => part.type === "text-start")).toHaveLength(1);
  });

  it("(e) сохраняет reasoning в doGenerate content", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        { type: "thinking", subtype: "delta", text: "reasoning" },
        { type: "thinking", subtype: "completed" },
        { type: "result", subtype: "success", is_error: false, result: "answer" },
      ]);
    const result = await createModel(spawn).doGenerate?.(prompt);
    expect(result?.content).toEqual([
      { type: "reasoning", text: "reasoning" },
      { type: "text", text: "answer" },
    ]);
  });

  it("(c) игнорирует дубликат assistant с model_call_id и не склеивает его в текст", async () => {
    const spawn: CursorCliSpawn = () =>
      fakeProcess([
        {
          type: "assistant",
          timestamp_ms: 1,
          message: { role: "assistant", content: [{ type: "text", text: "Ответ" }] },
        },
        // Buffered flush перед tool call: timestamp_ms + model_call_id — дубликат.
        {
          type: "assistant",
          timestamp_ms: 2,
          model_call_id: "call-1",
          message: { role: "assistant", content: [{ type: "text", text: "Ответ" }] },
        },
        // End-of-turn flush: без обоих полей — тоже дубликат.
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Ответ" }] },
        },
        { type: "result", subtype: "success", is_error: false, result: "Ответ" },
      ]);
    const { stream } = await createModel(spawn).doStream(prompt);
    const parts = await collect(stream as ReadableStream<{ type: string }>);
    const deltas = parts.filter((part) => part.type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas.map((part) => part.delta).join("")).toBe("Ответ");
    expect(parts.filter((part) => part.type === "text-start")).toHaveLength(1);
    expect(parts.filter((part) => part.type === "text-end")).toHaveLength(1);
  });

  it("abort убивает дочерний процесс", async () => {
    const kill = vi.fn(() => true);
    let settled: ((code: number | null) => void) | undefined;
    const spawn: CursorCliSpawn = () => ({
      stdout: (async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      })(),
      stderr: (async function* () {})(),
      kill,
      onClose: (listener) => {
        settled = listener;
      },
      onError: () => {},
    });
    const controller = new AbortController();
    const { stream } = await createModel(spawn).doStream({
      ...prompt,
      abortSignal: controller.signal,
    });
    const reader = (stream as ReadableStream<{ type: string }>).getReader();
    controller.abort();
    await reader.read().catch(() => undefined);
    expect(kill).toHaveBeenCalled();
    settled?.(null);
  });
});
