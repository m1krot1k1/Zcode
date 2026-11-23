import type { TodoItem } from "@zcode/contracts";
import {
  TAKEOVER_MAX_FRAGMENT_CHARS,
  TAKEOVER_MAX_FRAGMENTS,
  TAKEOVER_MAX_ITEM_CHARS,
  TAKEOVER_REFUSAL_REASONS,
  type AttributedTakeoverItem,
  type TakeoverContextFragment,
  type TakeoverToolResult,
} from "./contract.js";

const REFUSAL_REASONS: ReadonlySet<string> = new Set(TAKEOVER_REFUSAL_REASONS);
const PATH_PATTERN = /[\w./-]+\.[A-Za-z0-9]+/g;

/** lower/trim/`_`->`-`; unknown input yields `undefined`. */
export function normalizeFinishReason(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Provider refusal detection. Only finish-level facts are used. The normative set is
 * `refusal`/`content-filter`; raw values `safety`/`blocked` stay out until an adapter test
 * confirms their emission. Message text is never inspected.
 */
export function detectRefusal(input: {
  finishReason?: string | null;
  rawFinishReason?: string | null;
}): string | null {
  for (const candidate of [input.finishReason, input.rawFinishReason]) {
    const normalized = normalizeFinishReason(candidate);
    if (normalized && REFUSAL_REASONS.has(normalized)) return normalized;
  }
  return null;
}

/** Trailing ellipsis marks truncation without extra flags (spec «Атрибуция пункта»). */
export function truncateItemText(text: string, max = TAKEOVER_MAX_ITEM_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Idempotency key: position is not part of the identity, text is (whitespace-collapsed). */
export function normalizeItemText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/** First `in_progress`, else first `pending`; deterministic array-position index. */
export function attributeTodoItem(todos: readonly TodoItem[]): AttributedTakeoverItem | null {
  if (todos.length === 0) return null;
  const index = todos.findIndex((todo) => todo.status === "in_progress");
  const resolved = index >= 0 ? index : todos.findIndex((todo) => todo.status === "pending");
  if (resolved < 0) return null;
  const item = todos[resolved];
  if (!item || item.content.trim().length === 0) return null;
  return { itemIndex: resolved, itemText: truncateItemText(item.content) };
}

/**
 * Attribution cascade: a tracked todo wins; otherwise the last user message becomes item 0,
 * so a plain chat refusal still gets one fallback attempt. The same 4000-char bound applies,
 * and an empty message never starts a takeover.
 */
export function attributeTurnItem(
  todos: readonly TodoItem[],
  lastUserText: string,
): AttributedTakeoverItem | null {
  const todoItem = attributeTodoItem(todos);
  if (todoItem) return todoItem;
  const text = truncateItemText(normalizeItemText(lastUserText));
  if (text.length === 0) return null;
  return { itemIndex: 0, itemText: text };
}

function extractPaths(itemText: string): string[] {
  const matches = itemText.match(PATH_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

function matchingPath(result: TakeoverToolResult, paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  for (const path of paths) {
    if (result.text.includes(path) || result.inputText?.includes(path) === true) return path;
  }
  return undefined;
}

function clipFragment(text: string): string {
  if (text.length <= TAKEOVER_MAX_FRAGMENT_CHARS) return text;
  return `${text.slice(0, TAKEOVER_MAX_FRAGMENT_CHARS - 1)}…`;
}

/**
 * Fragment source: successful read-only tool results of the current main turn only.
 * Path matches come first (newest first), then the newest remaining results.
 */
export function selectContextFragments(input: {
  itemText: string;
  results: readonly TakeoverToolResult[];
}): readonly TakeoverContextFragment[] {
  const paths = extractPaths(input.itemText);
  const eligible = input.results
    .filter((result) => result.readOnly && !result.isError && result.text.trim().length > 0)
    .sort((left, right) => right.index - left.index);
  const pathMatches: TakeoverContextFragment[] = [];
  const rest: TakeoverContextFragment[] = [];
  for (const result of eligible) {
    const matchedPath = matchingPath(result, paths);
    const fragment: TakeoverContextFragment = {
      toolName: result.toolName,
      toolCallId: result.toolCallId,
      text: clipFragment(result.text),
      ...(matchedPath ? { matchedPath } : {}),
    };
    if (matchedPath) pathMatches.push(fragment);
    else rest.push(fragment);
  }
  return [...pathMatches, ...rest].slice(0, TAKEOVER_MAX_FRAGMENTS);
}

export const TEXT_REFUSAL_REASON = "text-refusal";

const TEXT_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\b(?:i'?m|i)\b[^.!?\n]{0,80}\b(?:can'?t|cannot|won'?t|will not|must decline|unable to)\b[^.!?\n]{0,40}\b(?:help|assist|comply|provide|fulfill|do (?:that|this))\b/iu,
  /(?:^|\s)не могу\s+(?:помочь|выполнить|предоставить|сделать это)/iu,
  /(?:^|\s)не буду\s+(?:это\s+)?(?:делать|выполнять|помогать)/iu,
  /(?:^|\s)отказываюсь\s+(?:помогать|выполнять)/iu,
  /无法(?:帮助|协助|提供|完成)/u,
  /不能(?:帮助|协助|提供|完成)/u,
  /抱歉[，,]\s*我(?:不能|无法)/u,
];

/**
 * Conservative text-refusal cascade layer. Only used when the provider did not already
 * signal a refusal, the last assistant message has no tool calls, and the finish reason is
 * `stop`. Never inspects tool output, never fires on a clarifying question, and stays
 * high-precision: a miss keeps the normal turn, a false positive would misroute a real answer.
 */
export function detectTextRefusal(
  text: string,
  options: { hasToolCalls: boolean },
): string | null {
  if (options.hasToolCalls) return null;
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.length > 4000) return null;
  if (normalized.endsWith("?") || normalized.endsWith("？")) return null;
  return TEXT_REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized))
    ? TEXT_REFUSAL_REASON
    : null;
}
