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
const TASK_ITEM_LINE = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/u;
const ITEM_TOKEN = /[\p{L}\p{N}_-]{4,}/gu;

function itemTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(ITEM_TOKEN) ?? []);
}

/** Numbered/bulleted lines of the current user message; fewer than two items is not a list. */
function splitUserTaskItems(text: string): AttributedTakeoverItem[] {
  const items: AttributedTakeoverItem[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const body = TASK_ITEM_LINE.exec(line)?.[1]?.trim() ?? "";
    if (!body) continue;
    items.push({ itemIndex: items.length, itemText: truncateItemText(body) });
  }
  return items.length >= 2 ? items : [];
}

function pickItemByOverlap(
  items: readonly AttributedTakeoverItem[],
  assistantText: string,
): AttributedTakeoverItem | null {
  const assistantTokens = itemTokens(assistantText);
  if (assistantTokens.size === 0) return null;
  let best: { item: AttributedTakeoverItem; score: number } | null = null;
  for (const item of items) {
    let score = 0;
    for (const token of itemTokens(item.itemText)) {
      if (assistantTokens.has(token)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item ?? null;
}

export function attributeTurnItem(
  todos: readonly TodoItem[],
  lastUserText: string,
  lastAssistantText = "",
): AttributedTakeoverItem | null {
  const todoItem = attributeTodoItem(todos);
  if (todoItem) return todoItem;
  const normalized = normalizeItemText(lastUserText);
  if (normalized.length === 0) return null;
  const items = splitUserTaskItems(lastUserText);
  if (items.length === 0) return { itemIndex: 0, itemText: truncateItemText(normalized) };
  // No TodoWrite: send only the item the refusal text actually talks about; fall back to the
  // first item when the refusal is generic, so the main model can continue the rest.
  return pickItemByOverlap(items, lastAssistantText) ?? items[0]!;
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
  // «Не буду — это оскорбление»: отказ, где разделитель вводит причину. Только в начале
  // фразы, иначе «не буду» внутри ответа о планах не считается отказом.
  /(?:^|[.!?\n]\s+)(?:я\s+)?(?:не могу|не буду|не стану|отказываюсь|отказался|отказалась)\s*[—–:;,]/iu,
  // «не могу выполнить», «не буду помогать»: стем отказа + глагол обслуживания запроса.
  /(?:^|\s)(?:не могу|не буду|не стану|отказываюсь|отказался|отказалась)\s+(?:это(?:го)?\s+)?(?:помогать|помочь|выполнять|выполнить|делать|сделать|предоставлять|предоставить|произносить|произнести|озвучивать)(?![\p{L}\p{N}])/iu,
  // «я такое не произношу»: отказ именно от произнесения, а не от работы с задачей.
  /(?:^|[.!?;,\n]\s+)я\s+(?:это\s+|такое\s+|так\s+)?не\s+(?:произношу|произнесу|озвучу)(?![\p{L}\p{N}])/iu,
  // «Не буду это комментировать»: отказ от производства содержания, где причина идёт
  // после отказа, а не отдельным глаголом обслуживания запроса.
  /(?:^|[.!?;,\n]\s+)(?:я\s+)?(?:не буду|не стану)\s+(?:это\s+|этого\s+)?(?:комментировать|прокомментировать|обсуждать|обсудить|оценивать|оценить)(?![\p{L}\p{N}])/iu,
  // «я такое не выдаю и не подтверждаю»: отказ от выдачи оценки или утверждения.
  /(?:^|[.!?;,\n]\s+)я\s+(?:это|такое|такого|такие|таких|подобное|подобного)\s+не\s+(?:выдаю|выдам|подтверждаю|подтвержу|поддерживаю|поддержу)(?![\p{L}\p{N}])/iu,
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
export function detectTextRefusal(text: string, options: { hasToolCalls: boolean }): string | null {
  if (options.hasToolCalls) return null;
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.length > 4000) return null;
  if (normalized.endsWith("?") || normalized.endsWith("？")) return null;
  return TEXT_REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized))
    ? TEXT_REFUSAL_REASON
    : null;
}
