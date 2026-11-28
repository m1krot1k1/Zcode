/**
 * cli-uncensored-takeover — minimal model call plus deterministic item attribution for one
 * provider refusal. The module owns HTTP/context shaping only; the turn loop keeps ownership
 * of events, durable rows and message history.
 *
 * Invariants:
 * - refusal is derived only from provider finish reasons, never from message text;
 * - exactly two provider messages, budgets 12000/4000/4000 and at most 3 fragments;
 * - providers and their enabled models are tried in configuration order, one attempt each,
 *   no retries, no redirects;
 * - the API key is only used in the Authorization header and never logged or persisted.
 */
import type { LogContext, TodoItem } from "@zcode/contracts";
import type { ZCodeUncensoredGetConfigResult } from "@zcode/shared";
import { z } from "zod";

export type TakeoverStatus = "running" | "done" | "refused" | "error" | "no-enabled-models";
export type TakeoverTerminalStatus = Exclude<TakeoverStatus, "running">;

/** Host configuration port. `null` means the Host reported no usable configuration. */
export interface UncensoredConfigPort {
  getConfig(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeUncensoredGetConfigResult | null>;
}

/** Injectible fetch surface; production uses `globalThis.fetch`, tests capture bodies. */
export interface TakeoverFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type TakeoverFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<TakeoverFetchResponse>;

/** Narrow logger: no response bodies, no secrets, no URLs. */
export interface TakeoverLogger {
  debug?(message: string, context?: LogContext): void;
  info?(message: string, context?: LogContext): void;
  warn?(message: string, context?: LogContext): void;
}

export interface AttributedTakeoverItem {
  itemIndex: number;
  itemText: string;
}

export interface TakeoverContextFragment {
  toolName: string;
  toolCallId: string;
  /** Fragment text, already truncated to `TAKEOVER_MAX_FRAGMENT_CHARS`. */
  text: string;
  /** Matched absolute/relative path when the item or tool text mentions one. */
  matchedPath?: string;
}

/** Provider-visible tool result reduced for fragment selection (current turn only). */
export interface TakeoverToolResult {
  toolName: string;
  toolCallId: string;
  text: string;
  isError: boolean;
  readOnly: boolean;
  /** Strictly increasing position; larger is newer. */
  index: number;
  /** Serialized tool input when available (used only for path matching). */
  inputText?: string;
}

export interface TakeoverChatMessage {
  role: "system" | "user";
  content: string;
}

export interface TakeoverRequestBody {
  model: string;
  messages: [TakeoverChatMessage, TakeoverChatMessage];
  max_tokens: 16_384;
  stream: false;
}

export interface TakeoverTerminal {
  status: TakeoverTerminalStatus;
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  output: string;
  reason?: string;
  /**
   * Сколько инструментов резервная модель реально исполнила. `done` с пустым `output` и
   * этим числом больше нуля — законный исход: модель работала инструментами и не написала
   * закрывающего текста. Без поля вызывающая сторона не отличает это от пустого ответа.
   */
  toolsExecuted?: number;
}

export interface RunUncensoredTakeoverInput {
  configPort: UncensoredConfigPort;
  workspace: { workspacePath: string; workspaceIdentity?: string };
  taskId: string;
  itemIndex: number;
  itemText: string;
  fragments: readonly TakeoverContextFragment[];
  /**
   * Normal provider/model path (Host-side mirror). Preferred over raw `fetch`: it uses the
   * exact chat configuration, credentials and adapter for the selected provider/model.
   */
  generate?: UncensoredGeneratePort;
  /** Legacy raw OpenAI-compatible transport for configs without a mirrored providerId. */
  fetch?: TakeoverFetch;
  signal?: AbortSignal;
  logger?: TakeoverLogger;
}

export interface UncensoredGenerateResult {
  text: string;
  finishReason?: string;
  /**
   * Сколько инструментов исполнилось в этой попытке. Считается по факту (`executed`), не по
   * намерению: ответ, где инструменты реально сработали, нельзя классифицировать как текст.
   */
  toolsExecuted?: number;
}

export interface UncensoredGeneratePort {
  generate(input: {
    providerId: string;
    modelId: string;
    messages: readonly TakeoverChatMessage[];
    signal?: AbortSignal;
  }): Promise<UncensoredGenerateResult>;
}

export interface TakeoverReminderInput {
  itemIndex: number;
  terminal: TakeoverTerminal;
  /**
   * Сколько инструментов реально исполнила резервная модель. Ноль при `done` значит, что
   * ответ — текст без действий: его нельзя выдавать за выполненный пункт.
   */
  toolsExecuted?: number;
}

export interface BuildTakeoverEntryInput {
  sessionId: string;
  taskId: string;
  itemIndex: number;
  itemText: string;
  agentId: string;
  terminal: TakeoverTerminal;
  createdAt: number;
  updatedAt: number;
}

/** Strict durable payload written to the CLI session store (`runtime/uncensored_takeover`). */
export const uncensoredTakeoverEntryPayloadSchema = z
  .object({
    kind: z.literal("uncensored_takeover"),
    taskId: z.string().min(1),
    itemIndex: z.number().int().nonnegative(),
    itemText: z.string().min(1).max(4000),
    providerId: z.string().min(1).nullable(),
    providerName: z.string().min(1).nullable(),
    modelId: z.string().nullable(),
    status: z.enum(["running", "done", "refused", "error", "no-enabled-models"]),
    output: z.string(),
    reason: z.string().optional(),
    // Сколько инструментов реально исполнилось. Без поля в durable-строке холодный повтор
    // (и любой дубликат) теряет факт и объявляет выполненную работу «текстом без проверки»
    // либо «пустым ответом». Опционально: старые строки поля не имеют.
    toolsExecuted: z.number().int().nonnegative().optional(),
    agentId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type UncensoredTakeoverEntryPayload = z.infer<typeof uncensoredTakeoverEntryPayloadSchema>;

export interface UncensoredTakeoverSessionEntry {
  id: string;
  sessionID: string;
  type: "runtime/uncensored_takeover";
  time: { created: number; updated: number };
  data: UncensoredTakeoverEntryPayload;
}

/** Public contract: one intent per method (max 12). */
export interface CliUncensoredTakeoverContract {
  /** Returns the normalized refusal reason or `null`; never inspects message text. */
  detectRefusal(input: {
    finishReason?: string | null;
    rawFinishReason?: string | null;
  }): string | null;
  /** First `in_progress`, else first `pending`; `null` for empty/all-completed lists. */
  attributeItem(todos: readonly TodoItem[]): AttributedTakeoverItem | null;
  /** Deterministic idempotency key: taskId + whitespace-normalized item text. */
  idempotencyKey(taskId: string, itemText: string): string;
  /** Deterministic agent id `<prefix>:<taskId>:<itemIndex>:<sha256(key)[0..16]>`. */
  agentId(taskId: string, itemIndex: number, itemText: string): string;
  /** Filters current-turn read-only successful results; path matches first, newest next. */
  selectFragments(input: {
    itemText: string;
    results: readonly TakeoverToolResult[];
  }): readonly TakeoverContextFragment[];
  /** Exactly two messages within the 12000/4000 budgets; friendly to exact-body tests. */
  buildRequestBody(input: {
    modelId: string;
    itemIndex: number;
    itemText: string;
    fragments: readonly TakeoverContextFragment[];
  }): TakeoverRequestBody;
  /** Enabled models across providers in configuration order; one attempt each, zero fetch when none. */
  run(input: RunUncensoredTakeoverInput): Promise<TakeoverTerminal>;
  /** Synthetic reminder text for the main model (no duplicated takeover output). */
  buildReminder(input: TakeoverReminderInput): string;
  /** Durable entry for cold replay. */
  buildEntry(input: BuildTakeoverEntryInput): UncensoredTakeoverSessionEntry;
  /** Strict parse of a durable payload; `null` when the row is foreign or malformed. */
  parseEntryData(data: unknown): UncensoredTakeoverEntryPayload | null;
}

export const UNCENSORED_TAKEOVER_ENTRY_TYPE = "runtime/uncensored_takeover" as const;
export const UNCENSORED_TAKEOVER_AGENT_TYPE = "uncensored-takeover" as const;
export const TAKEOVER_SYSTEM_INSTRUCTION =
  "You complete exactly one task item. Produce the result directly. Do not ask questions.";
export const TAKEOVER_MAX_USER_CONTENT_CHARS = 12_000;
export const TAKEOVER_MAX_ITEM_CHARS = 4_000;
export const TAKEOVER_MAX_FRAGMENT_CHARS = 4_000;
export const TAKEOVER_MAX_FRAGMENTS = 3;
export const TAKEOVER_HTTP_TIMEOUT_MS = 60_000;
/** `max_tokens` включает reasoning: 4096 thinking-модель тратит целиком на него. */
export const TAKEOVER_MAX_TOKENS = 16_384 as const;
export const TAKEOVER_REFUSAL_REASONS = ["refusal", "content-filter"] as const;
