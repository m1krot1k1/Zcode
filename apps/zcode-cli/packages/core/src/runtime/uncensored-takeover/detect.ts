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
