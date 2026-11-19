import {
  PROACTIVE_SUGGESTION_MAX_SUGGESTION_CHARS,
  filterAssistantVoiceSuggestion,
  type ProactiveSuggestionRequest,
  type ProactiveSuggestionSkipReason,
} from "@zcode/shared";

/** Системный промпт: только голос пользователя, одна короткая следующая задача. */
export const PROACTIVE_SUGGESTION_SYSTEM_PROMPT = [
  "You suggest the user's next task in the chat composer of a coding assistant.",
  "The previous turn is complete and the draft is empty.",
  "Write ONE short next task, in the user's voice, as the user would type it: an imperative request, a clarification, a review or a verification step.",
  "Base it on the recent conversation, the assistant result, executed edits, tests, diffs and tool results.",
  "Return only that one line: no quotes, no markdown, no numbering, no headings, at most 20 words.",
  "Never answer as the assistant, never write a plan, never narrate actions, never address yourself.",
  'Forbidden openings include "Сначала изучу", "Сначала проверю", "Проверю", "Давайте", "I will", "I\'ll", "Let me", "First, I".',
  "If no useful next task follows from the context, return an empty string.",
].join(" ");

/** Пользовательское сообщение: снимок контекста в фиксированном порядке. */
export function buildProactiveSuggestionPrompt(request: ProactiveSuggestionRequest): string {
  const lines: string[] = [];
  lines.push("Context of the completed turn (facts only; do not imitate the assistant voice):");
  if (request.context.messages.length > 0) {
    lines.push("Recent messages:");
    for (const message of request.context.messages) {
      lines.push(`${message.role}: ${message.text}`);
    }
  }
  if (request.context.assistantResult) {
    lines.push(`Assistant result: ${request.context.assistantResult}`);
  }
  if (request.context.toolResults.length > 0) {
    lines.push("Tool results:");
    for (const tool of request.context.toolResults) {
      lines.push(`${tool.toolName}: ${tool.summary}`);
    }
  }
  if (request.context.testResults.length > 0) {
    lines.push("Test results:");
    for (const result of request.context.testResults) {
      lines.push(`${result.toolName} [${result.status}]: ${result.summary}`);
    }
  }
  if (request.context.diffs.length > 0) {
    lines.push(
      `Changed files: ${request.context.diffs
        .map((diff) => (diff.summary ? `${diff.path} (${diff.summary})` : diff.path))
        .join(", ")}`,
    );
  }
  if (request.context.openFiles.length > 0) {
    lines.push(`Open files: ${request.context.openFiles.join(", ")}`);
  }
  lines.push("Next task in the user's voice (one line):");
  return lines.join("\n");
}

export interface NormalizedProactiveSuggestion {
  suggestion: string | null;
  reason: ProactiveSuggestionSkipReason | null;
}

/** Одна строка, без кавычек/маркеров; ассистентский голос отбрасывается. */
export function normalizeProactiveSuggestion(raw: string): NormalizedProactiveSuggestion {
  const firstLine =
    raw
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const stripped = firstLine
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "")
    .trim()
    .slice(0, PROACTIVE_SUGGESTION_MAX_SUGGESTION_CHARS)
    .trim();
  if (!stripped) return { suggestion: null, reason: "empty_suggestion" };
  if (!filterAssistantVoiceSuggestion(stripped)) {
    return { suggestion: null, reason: "assistant_voice" };
  }
  return { suggestion: stripped, reason: null };
}
