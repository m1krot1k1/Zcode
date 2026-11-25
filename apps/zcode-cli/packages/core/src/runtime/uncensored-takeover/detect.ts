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

/**
 * Machine-readable refusal marker the main model is told to emit (see the identity prompt).
 * It makes refusal detection independent of wording and language: any refusal, phrased any
 * way, is announced with the same token. The heuristic shapes below stay as a safety net for
 * models that ignore the instruction.
 */
export const REFUSAL_MARKER = "[[ZCODE_REFUSAL]]";
const REFUSAL_MARKER_PATTERN = /\[\[\s*ZCODE[\s_-]*REFUSAL\s*\]\]/iu;

export function hasRefusalMarker(text: string): boolean {
  return REFUSAL_MARKER_PATTERN.test(text);
}

/** Drops the marker line so the user never sees the protocol token in chat. */
export function stripRefusalMarker(text: string): string {
  if (!REFUSAL_MARKER_PATTERN.test(text)) return text;
  return text
    .split("\n")
    .filter((line) => !REFUSAL_MARKER_PATTERN.test(line))
    .join("\n")
    .replace(/^\s*\n+/, "")
    .trimEnd();
}

/**
 * Universal refusal shapes, not a phrase list. A refusal is recognised by structure:
 * a negation plus an object it refuses (any conjugation), a policy/capability denial,
 * or a denial that pivots into "I can help with something else". Concrete wordings are
 * consumed by stems, so new phrasing of the same shape is covered.
 */
const NEGATION_STEM = String.raw`(?:не\s+(?:буду|могу|стану|хочу|собираюсь|намерен\p{L}*|позволю|в\s+праве)|не|нет|никогда)`;
// Content-production actions a refusal refuses to perform: every non-past form
// (infinitive, present, future). Past-tense forms are statements of fact («не обсуждал
// это с командой»), not refusals, so they are deliberately absent.
const REFUSED_ACTION = String.raw`(?:помогать|помочь|помогаю|помогу|выполнять|выполнить|выполняю|выполню|предоставлять|предоставить|предоставляю|предоставлю|комментировать|прокомментировать|комментирую|прокомментирую|обсуждать|обсудить|обсуждаю|обсуждаем|обсужу|обсудим|произносить|произнести|произношу|произнесу|озвучивать|озвучить|озвучиваю|озвучу|поддерживать|поддержать|поддерживаю|поддержу|генерировать|сгенерировать|генерирую|сгенерирую|создавать|создать|создаю|создам|писать|написать|пишу|напишу|делать|сделать|делаю|сделаю)`;
const EN_REFUSED_ACTION = String.raw`(?:help|assist|comply|provide|produce|generate|write|say|tell|discuss|comment|evaluate|answer|participate|engage|support|confirm|create|do (?:that|this|it))`;

const REFUSAL_SHAPES: readonly RegExp[] = [
  // Negation followed by a separator that introduces the reason: «Не буду — это оскорбление».
  new RegExp(String.raw`(?:^|[.!?;,\n]\s*)${NEGATION_STEM}\s*[—–:,;]`, "iu"),
  // Negation (up to three padding words) + refused action in any conjugation.
  new RegExp(
    String.raw`(?:^|[^\p{L}])${NEGATION_STEM}\s+(?:\p{L}+\s+){0,3}${REFUSED_ACTION}(?![\p{L}])`,
    "iu",
  ),
  // Negation + the object a refusal commonly names: people, such words.
  /(?:не|никогда)\s+(?:\p{L}+\s+){0,3}(?:людей|человека|такие\s+слова|таких\s+слов|такими\s+словами|подобное|подобного)(?![\p{L}])/iu,
  // English: can't / won't / decline + refused action.
  new RegExp(
    String.raw`\b(?:can(?:no|')?t|cannot|won'?t|will\s+not|(?:am|i'?m)\s+not\s+able\s+to|unable\s+to|decline\s+to|refuse\s+to)\s+(?:\p{L}+\s+){0,3}${EN_REFUSED_ACTION}\b`,
    "iu",
  ),
  // Policy or capability denial: refusal of any wording, regardless of the action.
  /(?:не\s+имею\s+права|не\s+вправе|не\s+разрешено|запрещ\p{L}*|против\s+правил|противоречит\s+(?:политике|правилам)|неэтичн\p{L}*|оскорбительн\p{L}*)/iu,
  /\b(?:against\s+(?:my|the|our)\s+(?:policy|policies|guidelines)|not\s+allowed\s+to|violates?\s+(?:policy|guidelines|usage))\b/iu,
  /(?:无法|不能|不会|不可以|不允许|拒绝)/u,
];

/** Departures that turn a denial into a refusal of the request rather than an answer to it. */
const PIVOT_OFFERS: readonly RegExp[] = [
  /(?:готов\p{L}*\s+помо\p{L}*|могу\s+помо\p{L}*|чем\s+(?:ещё\s+)?(?:могу\s+)?помо\p{L}*|если\s+(?:есть|нужн)\p{L}*|сформулиру\p{L}*|напиш\p{L}*,?\s*что|обращайтесь|спрашивайте)/iu,
  /\b(?:happy\s+to\s+help|glad\s+to\s+help|i\s+can\s+help\s+with|let\s+me\s+know|feel\s+free\s+to)/iu,
  /(?:乐意帮助|可以帮助|随时告诉我|需要的话)/u,
];

const LEADING_DENIAL = /^\s*(?:нет|no|nope|не)\b[.!,\s]/iu;

/** Work artefacts: an answer that shows real work is never a refusal of that work. */
const WORK_SIGNALS = /```|`[^`]+`|[\w./-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|sh|yml|yaml)\b/u;

/**
 * Conservative text-refusal cascade layer. Only used when the provider did not already
 * signal a refusal, the last assistant message has no tool calls, and the finish reason is
 * `stop`. Never inspects tool output, never fires on a clarifying question, and stays
 * high-precision: a miss keeps the normal turn, a false positive would misroute a real answer.
 */
export function detectTextRefusal(text: string, options: { hasToolCalls: boolean }): string | null {
  if (options.hasToolCalls) return null;
  if (hasRefusalMarker(text)) return TEXT_REFUSAL_REASON;
  const normalized = text.trim();
  if (normalized.length === 0 || normalized.length > 4000) return null;
  if (normalized.endsWith("?") || normalized.endsWith("？")) return null;
  // An answer that ships code or file output is real work, never a refusal of that work.
  if (WORK_SIGNALS.test(normalized)) return null;
  const head = normalized.slice(0, 600);
  const denies = REFUSAL_SHAPES.some((pattern) => pattern.test(head));
  const pivots = PIVOT_OFFERS.some((pattern) => pattern.test(normalized));
  const short = normalized.length <= 900;
  // A bare "Нет." that pivots to "I can help with…" is a refusal even without a known action.
  const leadingDenial = LEADING_DENIAL.test(head);
  if (denies && (pivots || short)) return TEXT_REFUSAL_REASON;
  if (!denies && pivots && leadingDenial) return TEXT_REFUSAL_REASON;
  return null;
}
