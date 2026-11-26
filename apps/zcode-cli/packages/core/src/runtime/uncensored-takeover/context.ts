import {
  TAKEOVER_MAX_FRAGMENT_CHARS,
  TAKEOVER_MAX_FRAGMENTS,
  TAKEOVER_MAX_ITEM_CHARS,
  TAKEOVER_MAX_USER_CONTENT_CHARS,
  TAKEOVER_SYSTEM_INSTRUCTION,
  TAKEOVER_MAX_TOKENS,
  type TakeoverChatMessage,
  type TakeoverContextFragment,
  type TakeoverRequestBody,
  type TakeoverReminderInput,
  type TakeoverTerminalStatus,
} from "./contract.js";
import { truncateItemText } from "./detect.js";

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}

function renderFragment(index: number, fragment: TakeoverContextFragment): string {
  const summary = fragment.matchedPath ?? `${fragment.toolName} result`;
  return `--- fragment ${index + 1}: ${summary} ---\n${fragment.text}`;
}

/**
 * Builds exactly two messages for the fallback model. `Task item` text has priority and is
 * capped at 4000 chars; fragments are capped at 3 x 4000 and then squeezed so that the whole
 * user content (headers, separators, text) never exceeds 12000 chars.
 */
export function buildTakeoverMessages(input: {
  itemIndex: number;
  itemText: string;
  fragments: readonly TakeoverContextFragment[];
}): [TakeoverChatMessage, TakeoverChatMessage] {
  const itemText = truncateItemText(input.itemText, TAKEOVER_MAX_ITEM_CHARS);
  let user = `Task item (index ${input.itemIndex}):\n${itemText}`;
  const fragments = input.fragments.slice(0, TAKEOVER_MAX_FRAGMENTS);
  if (fragments.length > 0) {
    user += `\n\nContext fragments (most relevant first):`;
    for (let index = 0; index < fragments.length; index += 1) {
      const fragment = fragments[index];
      if (!fragment) continue;
      const emptyFragment = { ...fragment, text: "" };
      const overhead = `\n${renderFragment(index, emptyFragment)}`.length;
      const remaining = TAKEOVER_MAX_USER_CONTENT_CHARS - user.length - overhead;
      if (remaining <= 1) break;
      const body = clip(fragment.text, Math.min(TAKEOVER_MAX_FRAGMENT_CHARS, remaining));
      user += `\n${renderFragment(index, { ...fragment, text: body })}`;
    }
  }
  user = clip(user, TAKEOVER_MAX_USER_CONTENT_CHARS);
  return [
    { role: "system", content: TAKEOVER_SYSTEM_INSTRUCTION },
    { role: "user", content: user },
  ];
}

/** Суффикс thinking-модели: сервер тратит на reasoning тот же `max_tokens`, что и на ответ. */
const THINKING_SUFFIX = /:thinking$/iu;

/**
 * Wire-идентификатор для вызова перехвата. Фиксированный суффикс `:thinking` включает
 * серверное обдумывание, которое при исчерпании бюджета даёт `finish_reason: "length"` и
 * пустой `content` — попытка падала в `empty-content` при фактическом ответе в reasoning.
 * Перехвату нужен готовый ответ, поэтому суффикс снимается только на проводе; атрибуция
 * (`providerName`, `modelId`) остаётся на исходном id. Теги вида `llama3:8b` не меняются.
 */
export function takeoverRequestModelId(modelId: string): string {
  const stripped = modelId.replace(THINKING_SUFFIX, "");
  return stripped.length > 0 ? stripped : modelId;
}

export function buildTakeoverRequestBody(input: {
  modelId: string;
  itemIndex: number;
  itemText: string;
  fragments: readonly TakeoverContextFragment[];
}): TakeoverRequestBody {
  return {
    model: takeoverRequestModelId(input.modelId),
    messages: buildTakeoverMessages(input),
    max_tokens: TAKEOVER_MAX_TOKENS,
    stream: false,
  };
}

const REMINDER_STATUS_NOTE: Record<TakeoverTerminalStatus, string> = {
  done: "the fallback model completed it; use its output as the result",
  refused: "the fallback model also refused it",
  error: "the fallback model attempt failed",
  "no-enabled-models": "no uncensored model is enabled in settings",
};

/** Synthetic reminder inserted before the next model step; it never edits the todo list. */
export function buildTakeoverReminder(input: TakeoverReminderInput): string {
  const provider = input.terminal.providerName ?? "none";
  const model = input.terminal.modelId ?? "none";
  const reason = input.terminal.reason ? `\nReason: ${input.terminal.reason}` : "";
  const output = input.terminal.output.trim().length > 0 ? `\nOutput:\n${input.terminal.output}` : "";
  return [
    `[uncensored-takeover] Task item ${input.itemIndex} was handled by a fallback model.`,
    `Status: ${input.terminal.status}. Provider: ${provider}. Model: ${model}. ${REMINDER_STATUS_NOTE[input.terminal.status]}.${reason}`,
    output,
    "Do not repeat this item. Mark it completed with TodoWrite, then continue with the remaining items.",
    "If no items remain, reply with a short final summary.",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}
