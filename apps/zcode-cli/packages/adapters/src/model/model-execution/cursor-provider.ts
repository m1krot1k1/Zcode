// ============================================================
// Vercel AI SDK model execution — Cursor CLI provider runtime
// ============================================================

import { spawn } from "node:child_process";
import type {
  JSONValue,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { getCurrentModelInvocationContext, type Logger } from "@zcode/contracts";
import { asRecord } from "./record-utils.js";

const CURSOR_PROVIDER_ID = "cursor-cli";
const CURSOR_DEFAULT_EXECUTABLE = "cursor-agent";
const CURSOR_TEXT_PART_ID = "cursor-text-0";
const CURSOR_STDERR_LIMIT = 8_192;
const CURSOR_KILL_GRACE_MS = 5_000;

/** Cursor schema `result.subtype` — единственный авторитетный признак успеха. */
interface CursorResultEvent {
  readonly isError: boolean;
  readonly subtype: string | undefined;
  readonly text: string | undefined;
}

interface CursorToolCallEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly input: string;
  readonly result: NonNullable<JSONValue> | undefined;
}

type CursorParsedEvent =
  | { readonly type: "assistant-text"; readonly text: string }
  | { readonly type: "tool-call-start"; readonly call: CursorToolCallEvent }
  | { readonly type: "tool-call-complete"; readonly call: CursorToolCallEvent }
  | { readonly type: "result"; readonly result: CursorResultEvent };

/**
 * Минимальная поверхность дочернего процесса, необходимая провайдеру.
 * Тесты подменяют её, чтобы проверять парсинг без установленного cursor-agent.
 */
export interface CursorCliProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  kill(signal?: NodeJS.Signals): boolean;
  onClose(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface CursorCliSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type CursorCliSpawn = (
  command: string,
  args: readonly string[],
  options: CursorCliSpawnOptions,
) => CursorCliProcess;

export interface CursorProviderOptions {
  /** Абсолютный путь к `cursor-agent`; по умолчанию бинарь ищется в PATH. */
  readonly executablePath?: string;
  /** Рабочая директория по умолчанию, если invocation context её не передал. */
  readonly cwd?: string;
  /** `--force` включает правки без подтверждения; по умолчанию включён. */
  readonly force?: boolean;
  readonly logger?: Logger;
  readonly env?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
  /** Инъекция процесса для тестов; production использует node:child_process. */
  readonly spawn?: CursorCliSpawn;
}

export interface CursorProvider {
  languageModel(modelId: string): LanguageModelV3;
}

interface CursorRunRequest {
  readonly modelId: string;
  readonly call: LanguageModelV3CallOptions;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

const EMPTY_USAGE: LanguageModelV3Usage = Object.freeze({
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: undefined,
    text: undefined,
    reasoning: undefined,
  },
});

const defaultSpawn: CursorCliSpawn = (command, args, options) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => child.kill(signal),
    onClose: (listener) => {
      child.on("close", listener);
    },
    onError: (listener) => {
      child.on("error", listener);
    },
  };
};

export function createCursorProvider(options: CursorProviderOptions = {}): CursorProvider {
  return {
    languageModel: (modelId) => createCursorLanguageModel(modelId, options),
  };
}

function createCursorLanguageModel(
  modelId: string,
  options: CursorProviderOptions,
): LanguageModelV3 {
  const executable = options.executablePath?.trim() || CURSOR_DEFAULT_EXECUTABLE;
  const spawnProcess = options.spawn ?? defaultSpawn;
  const env = options.env ?? process.env;
  const force = options.force ?? true;

  const resolveCwd = (): string => {
    const context = getCurrentModelInvocationContext() as
      | (ReturnType<typeof getCurrentModelInvocationContext> & { workingDirectory?: string })
      | undefined;
    return context?.workingDirectory ?? options.cwd ?? process.cwd();
  };

  const run = (
    call: LanguageModelV3CallOptions,
    signal: AbortSignal,
  ): AsyncGenerator<LanguageModelV3StreamPart, void, undefined> =>
    streamCursorAgent({
      modelId,
      call,
      cwd: resolveCwd(),
      signal,
    }, {
      executable,
      env,
      force,
      logger: options.logger,
      killGraceMs: options.killGraceMs ?? CURSOR_KILL_GRACE_MS,
      spawnProcess,
    });

  return {
    specificationVersion: "v3",
    provider: CURSOR_PROVIDER_ID,
    modelId,
    supportedUrls: {},
    async doGenerate(call): Promise<LanguageModelV3GenerateResult> {
      const controller = new AbortController();
      const detach = linkAbort(call.abortSignal, controller);
      try {
        const content: Array<LanguageModelV3Content> = [];
        let text = "";
        let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
        for await (const part of run(call, controller.signal)) {
          switch (part.type) {
            case "text-delta":
              text += part.delta;
              break;
            case "text-end":
              if (text.length > 0) content.push({ type: "text", text });
              text = "";
              break;
            case "tool-call":
              content.push({
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                providerExecuted: true,
                dynamic: true,
              });
              break;
            case "tool-result":
              content.push({
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                result: part.result,
                ...(part.isError === undefined ? {} : { isError: part.isError }),
                dynamic: true,
              });
              break;
            case "finish":
              finishReason = part.finishReason;
              break;
            case "error":
              throw part.error instanceof Error
                ? part.error
                : new Error(`Cursor CLI stream error: ${String(part.error)}`);
            default:
              break;
          }
        }
        if (text.length > 0) content.push({ type: "text", text });
        return {
          content,
          finishReason,
          usage: cloneEmptyUsage(),
          warnings: [],
        };
      } finally {
        detach();
      }
    },
    async doStream(call) {
      const controller = new AbortController();
      const detach = linkAbort(call.abortSignal, controller);
      const iterator = run(call, controller.signal);
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(streamController) {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              streamController.enqueue(next.value);
            }
            streamController.close();
          } catch (error) {
            streamController.error(error);
          } finally {
            detach();
          }
        },
        async cancel() {
          controller.abort();
          await iterator.return(undefined);
        },
      });
      return { stream };
    },
  };
}

interface CursorRunRuntime {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly force: boolean;
  readonly logger?: Logger;
  readonly killGraceMs: number;
  readonly spawnProcess: CursorCliSpawn;
}

async function* streamCursorAgent(
  request: CursorRunRequest,
  runtime: CursorRunRuntime,
): AsyncGenerator<LanguageModelV3StreamPart, void, undefined> {
  if (request.signal.aborted) throw createAbortError();

  const args = buildCursorArgs(
    request.modelId,
    request.cwd,
    runtime.force,
    projectPrompt(request.call.prompt),
  );
  let process_: CursorCliProcess;
  try {
    process_ = runtime.spawnProcess(runtime.executable, args, {
      cwd: request.cwd,
      env: runtime.env,
    });
  } catch (error) {
    throw createCursorApiCallError(
      `Не удалось запустить ${runtime.executable}`,
      request,
      args,
      undefined,
      error,
    );
  }

  let stderr = "";
  let stderrTruncated = false;
  const collectStderr = async (): Promise<void> => {
    try {
      for await (const chunk of process_.stderr) {
        const text = decodeChunk(chunk);
        if (!text) continue;
        const remaining = CURSOR_STDERR_LIMIT - stderr.length;
        if (remaining > 0) {
          stderr += text.slice(0, remaining);
          if (text.length > remaining) stderrTruncated = true;
        } else {
          stderrTruncated = true;
        }
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) runtime.logger?.warn("cursor-agent stderr", { line: trimmed });
        }
      }
    } catch (error) {
      runtime.logger?.debug("cursor-agent stderr stream failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const stderrDone = collectStderr();

  let cleanupTermination: (() => void) | undefined;
  const abortListener = () => {
    cleanupTermination = terminateProcess(process_, runtime.killGraceMs);
  };
  request.signal.addEventListener("abort", abortListener, { once: true });

  const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    process_.onClose((code) => resolve({ code }));
    process_.onError((error) => resolve({ code: null, error }));
  });

  let sawResult = false;
  // Причина: --stream-partial-output отдаёт каждый чанк отдельным assistant-событием.
  // Раньше на каждый чанк эмитился свой text-start/text-end, из-за чего UI создавал
  // отдельный текстовый блок на слово и ответ «сыпался» построчно. Держим один
  // открытый блок на весь ответ (устойчивый id), закрывая его только в конце.
  let textStarted = false;
  // Отдельный признак нужен, чтобы не дописывать result.result дубликатом после дельт.
  let sawTextDelta = false;
  let sawFinish = false;
  let resultError: Error | undefined;

  const openText = function* (): Generator<LanguageModelV3StreamPart, void, undefined> {
    if (textStarted) return;
    textStarted = true;
    yield { type: "text-start", id: CURSOR_TEXT_PART_ID };
  };

  const emitEvent = function* (
    event: CursorParsedEvent,
  ): Generator<LanguageModelV3StreamPart, void, undefined> {
    if (event.type === "assistant-text") {
      yield* openText();
      sawTextDelta = true;
      yield { type: "text-delta", id: CURSOR_TEXT_PART_ID, delta: event.text };
      return;
    }
    if (event.type === "result") {
      sawResult = true;
      if (event.result.isError) {
        resultError = createCursorResultError(event.result, stderr);
        if (textStarted) {
          textStarted = false;
          yield { type: "text-end", id: CURSOR_TEXT_PART_ID };
        }
        yield { type: "error", error: resultError };
        yield {
          type: "finish",
          usage: cloneEmptyUsage(),
          finishReason: { unified: "error", raw: event.result.subtype ?? "error" },
        };
        sawFinish = true;
        return;
      }
      // Причина: если дельт не было (например, все assistant-события оказались
      // дубликатами с model_call_id), единственный текст ответа есть в result.result.
      // Отдаём его одним delta в уже открытом блоке; при наличии дельт — не дублируем.
      if (!sawTextDelta) {
        const finalText = event.result.text ?? "";
        if (finalText.trim().length > 0) {
          yield* openText();
          sawTextDelta = true;
          yield { type: "text-delta", id: CURSOR_TEXT_PART_ID, delta: finalText };
        }
      }
      return;
    }
    yield* mapToolEventToParts(event);
  };

  try {
    yield { type: "stream-start", warnings: [] };

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of process_.stdout) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const event = parseCursorLine(line, runtime.logger);
        if (!event) continue;
        yield* emitEvent(event);
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      const event = parseCursorLine(trailing, runtime.logger);
      if (event) yield* emitEvent(event);
    }

    if (textStarted) {
      textStarted = false;
      yield { type: "text-end", id: CURSOR_TEXT_PART_ID };
    }

    if (request.signal.aborted) throw createAbortError();

    const outcome = await exit;
    await stderrDone;

    if (!sawResult && outcome.error) {
      throw createCursorApiCallError(
        `cursor-agent не запустился: ${outcome.error.message}`,
        request,
        args,
        stderr,
        outcome.error,
      );
    }
    if (!sawResult && outcome.code !== 0 && outcome.code !== null) {
      throw createCursorApiCallError(
        `cursor-agent завершился с кодом ${outcome.code}${stderrTail(stderr, stderrTruncated)}`,
        request,
        args,
        stderr,
        undefined,
        outcome.code,
      );
    }
    if (request.signal.aborted) throw createAbortError();
    if (!sawFinish) {
      yield {
        type: "finish",
        usage: cloneEmptyUsage(),
        finishReason: { unified: sawResult && resultError ? "error" : "stop", raw: undefined },
      };
    }
  } finally {
    request.signal.removeEventListener("abort", abortListener);
    cleanupTermination?.();
  }
}

/**
 * Текстовые события и `result` обрабатываются в `emitEvent` с сохранением состояния,
 * чтобы весь ответ шёл одним непрерывным блоком. Здесь остаются только tool-события.
 */
function mapToolEventToParts(
  event: Extract<CursorParsedEvent, { type: "tool-call-start" | "tool-call-complete" }>,
): Array<LanguageModelV3StreamPart> {
  switch (event.type) {
    case "tool-call-start":
      return [
        {
          type: "tool-call",
          toolCallId: event.call.callId,
          toolName: event.call.toolName,
          input: event.call.input,
          providerExecuted: true,
          dynamic: true,
        },
      ];
    case "tool-call-complete":
      return [
        {
          type: "tool-result",
          toolCallId: event.call.callId,
          toolName: event.call.toolName,
          result: event.call.result ?? { value: null },
          dynamic: true,
        },
      ];
  }
}

function parseCursorLine(line: string, logger: Logger | undefined): CursorParsedEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Не-JSON строки в stdout (например, предупреждения Cursor) не должны рвать поток.
    logger?.debug("cursor-agent non-JSON stdout line", { line: line.slice(0, 512) });
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  const type = record.type;
  if (type === "assistant") {
    // Причина: --stream-partial-output печатает и дельты (timestamp_ms без model_call_id),
    // и финальное агрегированное сообщение. Дедупликация по документированному правилу.
    if (record.timestamp_ms === undefined || record.model_call_id !== undefined) return undefined;
    const message = asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .map((part) => {
        const entry = asRecord(part);
        return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
      })
      .join("");
    return text.length > 0 ? { type: "assistant-text", text } : undefined;
  }
  if (type === "tool_call") {
    const subtype = record.subtype;
    if (subtype !== "started" && subtype !== "completed") return undefined;
    const callId = typeof record.call_id === "string" ? record.call_id : undefined;
    if (!callId) return undefined;
    const toolCall = asRecord(record.tool_call);
    if (!toolCall) return undefined;
    const key = Object.keys(toolCall)[0];
    if (!key) return undefined;
    const value = asRecord(toolCall[key]) ?? {};
    const rawInput = value.args ?? value.arguments ?? {};
    if (subtype === "started") {
      return {
        type: "tool-call-start",
        call: {
          callId,
          toolName: key,
          input: safeStringify(rawInput),
          result: undefined,
        },
      };
    }
    return {
      type: "tool-call-complete",
      call: {
        callId,
        toolName: key,
        input: safeStringify(rawInput),
        result: toToolResult(value.result ?? value.success ?? value),
      },
    };
  }
  if (type === "result") {
    const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
    return {
      type: "result",
      result: {
        isError: record.is_error === true || subtype !== "success",
        subtype,
        text: typeof record.result === "string" ? record.result : undefined,
      },
    };
  }
  return undefined;
}

function toToolResult(value: unknown): NonNullable<JSONValue> {
  const record = asRecord(value);
  const candidate = record && "result" in record ? record.result : value;
  try {
    const serialized = JSON.stringify(candidate);
    if (serialized === undefined) return { value: String(candidate) };
    return JSON.parse(serialized) as NonNullable<JSONValue>;
  } catch {
    return { value: String(candidate) };
  }
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "{}" : serialized;
  } catch {
    return "{}";
  }
}

function buildCursorArgs(
  modelId: string,
  cwd: string,
  force: boolean,
  prompt: string,
): readonly string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    modelId,
    "--workspace",
    cwd,
    ...(force ? ["--force"] : []),
    // cursor-agent принимает prompt позиционным аргументом; без него `-p` ждёт stdin.
    prompt,
  ];
}

function projectPrompt(prompt: LanguageModelV3Prompt): string {
  const blocks: string[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        if (message.content.trim()) blocks.push(message.content);
        break;
      case "user": {
        const text = message.content
          .map((part) =>
            part.type === "text" ? part.text : `[file: ${part.mediaType}]`,
          )
          .join("");
        if (text.trim()) blocks.push(text);
        break;
      }
      case "assistant": {
        const text = message.content
          .map((part) => {
            switch (part.type) {
              case "text":
                return part.text;
              case "tool-call":
                return `[tool-call ${part.toolName} ${safeStringify(part.input)}]`;
              case "tool-result":
                return `[tool-result ${part.toolName}] ${stringifyToolResultOutput(part.output)}`;
              case "file":
                return `[file: ${part.mediaType}]`;
              case "reasoning":
                return "";
            }
          })
          .filter((part) => part.length > 0)
          .join("\n");
        if (text.trim()) blocks.push(`Assistant:\n${text}`);
        break;
      }
      case "tool": {
        const text = message.content
          .map((part) => {
            if (part.type === "tool-result") {
              return `[tool-result ${part.toolName}] ${stringifyToolResultOutput(part.output)}`;
            }
            const approved = part.approved ? "approved" : "denied";
            return `[tool-approval ${approved}${part.reason ? `: ${part.reason}` : ""}]`;
          })
          .join("\n");
        if (text.trim()) blocks.push(text);
        break;
      }
    }
  }
  return blocks.join("\n\n");
}

function stringifyToolResultOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return safeStringify(output.value);
    case "execution-denied":
      return `[execution denied${output.reason ? `: ${output.reason}` : ""}]`;
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "file-url") return `[file: ${part.url}]`;
          if ("mediaType" in part) return `[file: ${part.mediaType}]`;
          return "[file]";
        })
        .join("\n");
  }
}

function createCursorResultError(result: CursorResultEvent, stderr: string): Error {
  const message = result.text?.trim() || stderr.trim() || `cursor-agent result: ${result.subtype}`;
  return new APICallError({
    message: `Cursor CLI вернул ошибку: ${message}`,
    url: "cursor-cli://local",
    requestBodyValues: {},
    responseBody: stderr,
    isRetryable: false,
  });
}

function createCursorApiCallError(
  message: string,
  request: CursorRunRequest,
  args: readonly string[],
  stderr: string | undefined,
  cause: unknown,
  statusCode?: number,
): APICallError {
  return new APICallError({
    message,
    url: "cursor-cli://local",
    requestBodyValues: { modelId: request.modelId, cwd: request.cwd, args: [...args] },
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(stderr === undefined ? {} : { responseBody: stderr }),
    cause,
    isRetryable: false,
  });
}

function stderrTail(stderr: string, truncated: boolean): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  return `: ${truncated ? "…" : ""}${trimmed}`;
}

function terminateProcess(process_: CursorCliProcess, graceMs: number): () => void {
  try {
    process_.kill("SIGTERM");
  } catch {
    // Процесс мог завершиться между abort и kill.
  }
  const timer = setTimeout(() => {
    try {
      process_.kill("SIGKILL");
    } catch {
      // Процесс уже завершён.
    }
  }, graceMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const listener = () => controller.abort();
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function createAbortError(): Error {
  const error = new Error("Cursor CLI request aborted");
  error.name = "AbortError";
  return error;
}

function decodeChunk(chunk: Uint8Array | string): string {
  if (typeof chunk === "string") return chunk;
  return new TextDecoder().decode(chunk);
}

function cloneEmptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { ...EMPTY_USAGE.inputTokens },
    outputTokens: { ...EMPTY_USAGE.outputTokens },
  };
}
