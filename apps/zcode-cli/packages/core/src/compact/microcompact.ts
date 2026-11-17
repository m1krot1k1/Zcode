import { createHash } from "node:crypto";
import {
  MicrocompactStrategy,
  MicrocompactTrigger,
  modelMessageContentToText,
  type MicrocompactBoundaryPayload,
  type ModelMessageContent,
  type ToolCallId,
} from "@zcode/contracts";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens } from "./manual.js";

export const MICROCOMPACT_CLEARED_TOOL_RESULT_PREFIX = "[Old tool result content cleared]";
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
export const OBSERVATION_MASK_PREFIX = "[Old tool observation masked";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 6;
export const DEFAULT_OBSERVATION_MASK_MIN_CHARS = 1_000;
const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
export const DEFAULT_WORKING_CONTEXT_SOFT_CAP_TOKENS = 120_000;
export const DEFAULT_MASKING_STEP_QUANTUM_TOKENS = 20_000;
export const DEFAULT_MICROCOMPACT_GROUP_QUANTUM = 4;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = [
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "CodeIndex",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "ApplyPatch",
] as const;

export interface LocalMicrocompactPolicyConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  /** Эффективный мягкий потолок рабочего контекста (по умолчанию 120 000 токенов даже для 1M-моделей). */
  workingContextSoftCapTokens?: number;
  /** Шаг квантования токенного порога маскирования, исключающий перестройку префикса на каждом ходу. */
  maskingStepQuantumTokens?: number;
  /** Квантование числа очищаемых групп инструментов для сохранения стабильности кэш-префикса. */
  groupQuantum?: number;
  idleThresholdMinutes?: number;
  keepRecentToolResults?: number;
  compactableToolNames?: readonly string[];
  clearErrorResults?: boolean;
  minTokenSavings?: number;
  /** observation сохраняет имя инструмента, цель и размер; clear оставляет прежнюю заглушку. */
  maskStyle?: "observation" | "clear";
  /** Маскировать только достаточно крупные наблюдения; маленькие результаты дешевле оставить. */
  minMaskChars?: number;
}

export interface LocalMicrocompactMessage extends CompactModelMessage {
  isError?: boolean;
  toolCalls?: Array<{ id: string; input: unknown; name: string }>;
  toolCallId?: string;
  toolName?: string;
}

export type LocalMicrocompactBoundaryPayload = Omit<
  MicrocompactBoundaryPayload,
  "traceId" | "turnId"
>;

export interface LocalMicrocompactDecision {
  estimatedTokenCount: number;
  reason:
    | "disabled"
    | "not_triggered"
    | "no_candidates"
    | "nothing_to_clear"
    | "below_min_savings"
    | "applied";
  thresholdTokens?: number;
  trigger?: MicrocompactTrigger;
}

export interface LocalMicrocompactResult<T extends LocalMicrocompactMessage> {
  decision: LocalMicrocompactDecision;
  messages: T[];
  payload?: LocalMicrocompactBoundaryPayload;
}

interface ToolResultCandidate {
  index: number;
  maskable: boolean;
  toolCallId: string;
  toolName: string;
}

export function buildDefaultMicrocompactThreshold(
  autoCompactThreshold: number,
  workingContextSoftCapTokens = DEFAULT_WORKING_CONTEXT_SOFT_CAP_TOKENS,
): number {
  const ratioThreshold = Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO);
  const bufferThreshold = autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS;
  const softCap =
    positiveInt(workingContextSoftCapTokens) ?? DEFAULT_WORKING_CONTEXT_SOFT_CAP_TOKENS;
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold, softCap));
}

export function maybeLocalMicrocompactMessages<T extends LocalMicrocompactMessage>(input: {
  config?: LocalMicrocompactPolicyConfig;
  lastAssistantCompletedAtMs?: number;
  messages: readonly T[];
  resolveToolResultName?: (message: T, index: number) => string | undefined;
  /** Tool input нужен только для читаемой маски: путь/паттерн, без содержимого и секретов. */
  resolveToolInput?: (message: T, index: number) => unknown;
  nowMs?: number;
}): LocalMicrocompactResult<T> {
  const config = input.config ?? {};
  const messages = input.messages.map(cloneLocalMicrocompactMessage);
  const estimatedTokenCount = estimateMessageTokens(messages);
  const baseThresholdTokens = positiveInt(config.thresholdTokens);
  const quantumTokens = positiveInt(config.maskingStepQuantumTokens) ?? 0;
  const thresholdTokens =
    baseThresholdTokens !== undefined ? baseThresholdTokens + quantumTokens : undefined;

  if (config.enabled === false) {
    return {
      decision: { estimatedTokenCount, reason: "disabled", thresholdTokens },
      messages,
    };
  }

  const trigger = resolveMicrocompactTrigger({
    config,
    estimatedTokenCount,
    lastAssistantCompletedAtMs: input.lastAssistantCompletedAtMs,
    nowMs: input.nowMs,
    thresholdTokens,
  });
  if (!trigger) {
    return {
      decision: { estimatedTokenCount, reason: "not_triggered", thresholdTokens },
      messages,
    };
  }

  const candidateGroups = collectCompactableToolResultGroups(
    messages,
    config,
    input.resolveToolResultName,
  );
  if (candidateGroups.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "no_candidates", thresholdTokens, trigger },
      messages,
    };
  }

  const keepCount =
    positiveInt(config.keepRecentToolResults) ?? DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS;
  const boundedKeepCount = Math.max(1, keepCount);
  const rawClearGroupCount = Math.max(0, candidateGroups.length - boundedKeepCount);
  const groupQuantum = Math.max(1, positiveInt(config.groupQuantum) ?? 1);
  const clearGroupCount =
    groupQuantum > 1 && rawClearGroupCount >= groupQuantum
      ? Math.floor(rawClearGroupCount / groupQuantum) * groupQuantum
      : rawClearGroupCount;
  if (clearGroupCount === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages,
    };
  }

  const toClearGroups = candidateGroups.slice(0, clearGroupCount);
  const toClear = toClearGroups.flat().filter((candidate) => candidate.maskable);
  const toKeep = candidateGroups.slice(clearGroupCount).flat();
  if (toClear.length === 0) {
    return {
      decision: { estimatedTokenCount, reason: "nothing_to_clear", thresholdTokens, trigger },
      messages: input.messages.map(cloneLocalMicrocompactMessage),
    };
  }
  const maskStyle = config.maskStyle ?? "observation";
  for (const candidate of toClear) {
    const message = messages[candidate.index];
    if (!message) continue;
    const fallbackToolInput = resolveToolCallInputFromHistory(messages, candidate.toolCallId);
    messages[candidate.index] = {
      ...message,
      content:
        maskStyle === "clear"
          ? buildClearedToolResultContent()
          : buildObservationMaskContent({
              content: message.content,
              isError: message.isError === true,
              toolInput:
                input.resolveToolInput?.(message, candidate.index) ?? fallbackToolInput,
              toolName: candidate.toolName,
            }),
    };
  }

  const postTokenCount = estimateMessageTokens(messages);
  const tokensSaved = Math.max(0, estimatedTokenCount - postTokenCount);
  const minSavings = positiveInt(config.minTokenSavings) ?? DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS;
  if (tokensSaved < minSavings) {
    return {
      decision: { estimatedTokenCount, reason: "below_min_savings", thresholdTokens, trigger },
      messages: input.messages.map(cloneLocalMicrocompactMessage),
    };
  }

  return {
    decision: { estimatedTokenCount, reason: "applied", thresholdTokens, trigger },
    messages,
    payload: {
      clearedMessageCount: toClear.length,
      clearedToolCallIds: toClear.map((candidate) => candidate.toolCallId as ToolCallId),
      keptToolCallIds: toKeep.map((candidate) => candidate.toolCallId as ToolCallId),
      postMicrocompactTokenCount: postTokenCount,
      preMicrocompactTokenCount: estimatedTokenCount,
      strategy: MicrocompactStrategy.LocalToolResultClear,
      tokensSaved,
      trigger,
    },
  };
}

function resolveMicrocompactTrigger(input: {
  config: LocalMicrocompactPolicyConfig;
  estimatedTokenCount: number;
  lastAssistantCompletedAtMs?: number;
  nowMs?: number;
  thresholdTokens?: number;
}): MicrocompactTrigger | undefined {
  const idleThresholdMinutes =
    positiveInt(input.config.idleThresholdMinutes) ?? DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES;
  if (
    input.lastAssistantCompletedAtMs !== undefined &&
    Number.isFinite(input.lastAssistantCompletedAtMs)
  ) {
    const elapsedMs = (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs;
    if (elapsedMs > idleThresholdMinutes * 60_000) {
      return MicrocompactTrigger.TimeBased;
    }
  }

  if (input.thresholdTokens !== undefined && input.estimatedTokenCount >= input.thresholdTokens) {
    return MicrocompactTrigger.TokenPressure;
  }

  return undefined;
}

function collectCompactableToolResultGroups<T extends LocalMicrocompactMessage>(
  messages: readonly T[],
  config: LocalMicrocompactPolicyConfig,
  resolveToolResultName?: (message: T, index: number) => string | undefined,
): ToolResultCandidate[][] {
  const compactableTools = new Set(
    config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS,
  );
  const clearErrorResults = config.clearErrorResults === true;
  const minMaskChars =
    config.maskStyle === "clear"
      ? 0
      : (positiveInt(config.minMaskChars) ?? DEFAULT_OBSERVATION_MASK_MIN_CHARS);
  const groups: ToolResultCandidate[][] = [];
  let currentGroup: ToolResultCandidate[] | undefined;

  const flushCurrentGroup = (): void => {
    if (currentGroup && currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = undefined;
  };

  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      flushCurrentGroup();
      currentGroup = [];
      return;
    }

    if (message.role !== "tool") return;
    const toolName = resolveToolResultName
      ? resolveToolResultName(message, index)
      : message.toolName;
    if (!message.toolCallId || !toolName) return;
    if (!compactableTools.has(toolName)) return;
    const maskable =
      (!message.isError || clearErrorResults) &&
      !isMicrocompactClearedToolResultContent(message.content) &&
      !isObservationMaskContent(message.content) &&
      !hasMediaToolResultContent(message.content) &&
      modelMessageContentToText(message.content).length >= minMaskChars;
    // Ошибки/media/маленькие результаты не маскируются, но остаются в группе:
    // иначе маленький свежий результат не защитил бы старый крупный от очистки.

    if (!currentGroup) {
      groups.push([{ index, maskable, toolCallId: message.toolCallId, toolName }]);
      return;
    }

    currentGroup.push({ index, maskable, toolCallId: message.toolCallId, toolName });
  });

  flushCurrentGroup();
  return groups;
}

function buildClearedToolResultContent(): ModelMessageContent {
  return MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
}

function buildObservationMaskContent(input: {
  content: ModelMessageContent;
  isError: boolean;
  toolInput?: unknown;
  toolName: string;
}): ModelMessageContent {
  const rawText = modelMessageContentToText(input.content);
  const target = summarizeObservationTarget(input.toolName, input.toolInput);
  const charCount = rawText.length;
  const lineCount = countContentLines(rawText);
  const sha256Short = createHash("sha256").update(rawText).digest("hex").slice(0, 12);
  const compactMask = `${OBSERVATION_MASK_PREFIX}: ${input.toolName}${target ? ` ${target}` : ""}${input.isError ? " status=error" : ""} lines=${lineCount} chars=${charCount} sha256=${sha256Short}]`;
  const fullMask = `${OBSERVATION_MASK_PREFIX}: ${input.toolName}${target ? ` ${target}` : ""}${input.isError ? " status=error" : ""} lines=${lineCount} chars=${charCount} sha256=${sha256Short}; re-run the tool with offset/limit if the full output is needed]`;
  return charCount > fullMask.length + 16 ? fullMask : compactMask;
}

function countContentLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function resolveToolCallInputFromHistory<T extends LocalMicrocompactMessage>(
  messages: readonly T[],
  toolCallId: string,
): unknown {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const toolCalls = messages[i]?.toolCalls;
    if (!toolCalls) continue;
    const found = toolCalls.find((call) => call.id === toolCallId);
    if (found && found.input !== undefined) {
      return found.input;
    }
  }
  return undefined;
}

function summarizeObservationTarget(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";
  const record = toolInput as Record<string, unknown>;
  const stringField = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };
  const numberField = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
    }
    return undefined;
  };
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
    case "ApplyPatch": {
      const path = stringField("file_path", "path");
      const offset = numberField("offset");
      const limit = numberField("limit");
      return [
        path ? `path=${truncateMaskValue(path, 160)}` : "",
        offset !== undefined ? `offset=${offset}` : "",
        limit !== undefined ? `limit=${limit}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "Grep":
    case "CodeIndex": {
      const pattern = stringField("pattern", "query");
      const path = stringField("path");
      return [
        pattern ? `pattern=${truncateMaskValue(pattern, 80)}` : "",
        path ? `path=${truncateMaskValue(path, 120)}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "Glob": {
      const pattern = stringField("pattern");
      return pattern ? `pattern=${truncateMaskValue(pattern, 120)}` : "";
    }
    default:
      // Bash/WebFetch/WebSearch/MCP: намеренно не повторяем команду или URL —
      // они уже есть в assistant tool call, а маска не должна продлевать жизнь секретам.
      return "";
  }
}

function truncateMaskValue(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function isMicrocompactClearedToolResultContent(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content) === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE;
}

function isObservationMaskContent(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content).startsWith(OBSERVATION_MASK_PREFIX);
}

function hasMediaToolResultContent(content: ModelMessageContent): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object" || !("type" in block)) return false;
    // video 与 image/file 同为受保护媒体：Read 视频结果漏判会被 microcompact 清掉。
    return block.type === "image" || block.type === "video" || block.type === "file";
  });
}

function cloneLocalMicrocompactMessage<T extends LocalMicrocompactMessage>(message: T): T {
  return {
    ...message,
    content: cloneContent(message.content),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
  };
}

function cloneContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if ("source" in block && block.source) {
      return { ...block, source: { ...block.source } };
    }
    if ("providerOptions" in block && block.providerOptions) {
      return { ...block, providerOptions: { ...block.providerOptions } };
    }
    return { ...block };
  }) as ModelMessageContent;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
