import {
  PROMPT_ENHANCE_MAX_MENTIONS,
  PromptEnhanceError,
  type PromptEnhanceMention,
  type PromptEnhanceRequest,
} from "./contract.js";

/**
 * Детерминированный разбор ответа модели и проверка инвариантов.
 *
 * Общий для Host-сервиса и CLI `/enhance`: одинаковый вход обязан давать одинаковый
 * результат независимо от того, где исполняется улучшение. Здесь нет I/O и вызова модели.
 */

export interface ParsedEnhancerResponse {
  enhancedText: string;
  addedClarifications: string[];
  assumptions: Array<{ text: string; origin: "draft" | "repository" | "model" }>;
  capabilitySuggestions: Array<{
    kind: "skill" | "mcp" | "agent" | "plugin";
    name: string;
    reason: string;
  }>;
}

const MAX_CLARIFICATIONS = 20;
const MAX_ASSUMPTIONS = 20;
const MAX_ASSUMPTION_CHARS = 1_000;
const MAX_CAPABILITY_SUGGESTIONS = 10;
const MAX_CAPABILITY_NAME_CHARS = 256;
const MAX_CAPABILITY_REASON_CHARS = 500;

/**
 * Разбор ответа модели. Модель может обернуть JSON в fence или добавить преамбулу —
 * принимаем только объект с ожидаемой формой, иначе выбрасываем `model_failed`.
 * Если ответ не JSON, но содержит текст, он трактуется как готовый промпт.
 */
export function parseEnhancedPromptResponse(raw: string): ParsedEnhancerResponse {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  const fenced = withoutThinking.match(/^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu);
  const candidate = fenced?.[1]?.trim() ?? withoutThinking;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const plain = candidate.replace(/^```[^\n]*\n?|```$/gu, "").trim();
    if (plain.length === 0) {
      throw new PromptEnhanceError("empty_result", "Empty model output");
    }
    return {
      enhancedText: plain,
      addedClarifications: [],
      assumptions: [],
      capabilitySuggestions: [],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PromptEnhanceError("model_failed", "Enhancer response is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const enhancedText = typeof record.enhancedText === "string" ? record.enhancedText.trim() : "";
  if (enhancedText.length === 0) {
    throw new PromptEnhanceError("empty_result", "Enhancer response has no enhancedText");
  }
  const clarifications: string[] = Array.isArray(record.addedClarifications)
    ? record.addedClarifications
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .slice(0, MAX_CLARIFICATIONS)
    : [];
  const assumptions: ParsedEnhancerResponse["assumptions"] = Array.isArray(record.assumptions)
    ? record.assumptions
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          const text = typeof entry.text === "string" ? entry.text.trim() : "";
          if (text.length === 0) return [];
          const origin: "draft" | "repository" | "model" =
            entry.origin === "repository" || entry.origin === "model" ? entry.origin : "draft";
          return [{ text: text.slice(0, MAX_ASSUMPTION_CHARS), origin }];
        })
        .slice(0, MAX_ASSUMPTIONS)
    : [];
  const capabilitySuggestions: ParsedEnhancerResponse["capabilitySuggestions"] = Array.isArray(
    record.capabilitySuggestions,
  )
    ? record.capabilitySuggestions
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          const kind =
            entry.kind === "skill" ||
            entry.kind === "mcp" ||
            entry.kind === "agent" ||
            entry.kind === "plugin"
              ? entry.kind
              : undefined;
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
          if (!kind || name.length === 0 || reason.length === 0) return [];
          const suggestion: ParsedEnhancerResponse["capabilitySuggestions"][number] = {
            kind,
            name: name.slice(0, MAX_CAPABILITY_NAME_CHARS),
            reason: reason.slice(0, MAX_CAPABILITY_REASON_CHARS),
          };
          return [suggestion];
        })
        .slice(0, MAX_CAPABILITY_SUGGESTIONS)
    : [];
  return { enhancedText, addedClarifications: clarifications, assumptions, capabilitySuggestions };
}

/** Проверяет, что все protected mentions уцелели дословно. */
export function findMissingPromptMentions(
  enhancedText: string,
  request: Pick<PromptEnhanceRequest, "preservedMentions">,
): string[] {
  return request.preservedMentions
    .map((mention) => mention.displayText)
    .filter((marker) => !enhancedText.includes(marker));
}

/**
 * Извлекает `@path` и `$skill` маркеры из черновика.
 *
 * CLI не получает структурированный список вложений из композера, поэтому маркеры
 * нужно вытащить из самого текста — иначе `preservedMentions` пуст и модель может
 * молча удалить ссылку на файл. Порядок и дедупликация детерминированы: первый
 * встреченный порядок, без сортировки, чтобы повторный вызов на том же черновике
 * давал тот же массив.
 */
export function extractPromptMentions(draftText: string): PromptEnhanceMention[] {
  const pattern = /(^|[\s([{"'])([@$])([A-Za-z0-9_./\\@-]{1,512})/gu;
  const seen = new Set<string>();
  const mentions: PromptEnhanceMention[] = [];
  for (const match of draftText.matchAll(pattern)) {
    const sigil = match[2];
    const body = match[3] ?? "";
    if (body.length === 0) continue;
    if (sigil === "@" && !/[A-Za-z_./\\]/u.test(body)) continue;
    const displayText = `${sigil}${body}`;
    if (seen.has(displayText)) continue;
    seen.add(displayText);
    mentions.push({
      kind: sigil === "$" ? "skill" : "file",
      value: body,
      displayText,
    });
    if (mentions.length >= PROMPT_ENHANCE_MAX_MENTIONS) break;
  }
  return mentions;
}
