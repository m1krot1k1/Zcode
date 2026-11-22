import { z } from "zod";

/**
 * Проводной контракт `PromptEnhancerService`.
 *
 * Модуль чистый: здесь только Zod-схемы запроса/ответа/событий и общие лимиты.
 * Сбор контекста, вызов модели и отмена живут в Host-сервисе (`packages/services`).
 * Один и тот же контракт обслуживает Desktop Local Host, Remote SSH Server и Web Remote:
 * ни один из транспортов не добавляет собственных полей.
 */

/** Что улучшаем: свободный запрос пользователя из композера или кастомный системный промпт. */
export const promptEnhanceTargetSchema = z.enum(["chat_user_prompt", "custom_system_prompt"]);
export type PromptEnhanceTarget = z.infer<typeof promptEnhanceTargetSchema>;

/** Стиль улучшения. Меняет только полноту структуры, не язык и не намерение автора. */
export const promptEnhanceStyleSchema = z.enum([
  "structured_engineering",
  "concise_direct",
  "deep_architectural",
]);
export type PromptEnhanceStyle = z.infer<typeof promptEnhanceStyleSchema>;

export const PROMPT_ENHANCE_DEFAULT_STYLE: PromptEnhanceStyle = "structured_engineering";

/** Deterministic prompt-shape selected by the enhancer, never by a clarifying question. */
export const promptEnhanceFrameworkSchema = z.enum(["oracle", "rise", "care", "tag"]);
export type PromptEnhanceFramework = z.infer<typeof promptEnhanceFrameworkSchema>;

export const promptEnhanceCapabilitySuggestionSchema = z
  .object({
    kind: z.enum(["skill", "mcp", "agent", "plugin"]),
    /** Exact installed/marketplace name when known; never a command or URL. */
    name: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(500),
    /** True only when the Host found the capability in its installed index. */
    installed: z.boolean().default(false),
    /** `model` — proposed by the enhancer; `index` — deterministic installed match. */
    source: z.enum(["model", "index"]).default("model"),
    /** Suggestions are informational; installing/using is always a separate consent step. */
    requiresConsent: z.boolean().default(true),
  })
  .strict();
export type PromptEnhanceCapabilitySuggestion = z.infer<
  typeof promptEnhanceCapabilitySuggestionSchema
>;

/** Размеры ограничены, чтобы RPC-кадр и последующий запрос к модели оставались предсказуемыми. */
export const PROMPT_ENHANCE_MAX_DRAFT_CHARS = 32_000;
export const PROMPT_ENHANCE_MAX_ACTIVE_FILES = 10;
export const PROMPT_ENHANCE_MAX_MENTIONS = 50;
export const PROMPT_ENHANCE_MAX_CONTEXT_TOKENS = 1_200;
export const PROMPT_ENHANCE_CONTEXT_BUDGET_MS = 60;
export const PROMPT_ENHANCE_REQUEST_TIMEOUT_MS = 90_000;

/** Маркер, который UI вставляет в композер; должен пережить улучшение без искажения пути. */
export const promptEnhanceMentionSchema = z
  .object({
    kind: z.enum(["file", "folder", "symbol", "skill", "session"]),
    value: z.string().trim().min(1).max(4096),
    displayText: z.string().min(1).max(4096),
  })
  .strict();
export type PromptEnhanceMention = z.infer<typeof promptEnhanceMentionSchema>;

export const promptEnhanceRequestSchema = z
  .object({
    requestId: z.string().trim().min(8).max(64),
    workspacePath: z.string().trim().min(1).max(4096),
    /** Идентичность удалённого workspace; при отсутствии Host использует `workspacePath`. */
    workspaceIdentity: z.string().trim().min(1).max(4096).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    target: promptEnhanceTargetSchema,
    style: promptEnhanceStyleSchema.default(PROMPT_ENHANCE_DEFAULT_STYLE),
    draftText: z.string().min(2).max(PROMPT_ENHANCE_MAX_DRAFT_CHARS),
    preservedMentions: z
      .array(promptEnhanceMentionSchema)
      .max(PROMPT_ENHANCE_MAX_MENTIONS)
      .default([]),
    activeFilePaths: z
      .array(z.string().trim().min(1))
      .max(PROMPT_ENHANCE_MAX_ACTIVE_FILES)
      .default([]),
    /** Режим коллаборации из композера (`default` / `plan` / ...); влияет на формулировки. */
    collaborationMode: z.string().trim().min(1).max(64).optional(),
    /** Явный выбор модели улучшения; при отсутствии Host берёт дефолтную быструю модель. */
    modelSelection: z
      .object({
        providerId: z.string().trim().min(1),
        modelId: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PromptEnhanceRequest = z.infer<typeof promptEnhanceRequestSchema>;

/** Источники, реально попавшие в контекст, чтобы UI мог их показать, не раскрывая содержимое. */
export const promptEnhanceContextSourceSchema = z
  .object({
    kind: z.enum(["code_index", "git_diff", "agents_md", "session_history", "active_files"]),
    /** Пути или имена символов; никогда не содержимое файла. */
    items: z.array(z.string().max(4096)).max(20),
  })
  .strict();
export type PromptEnhanceContextSource = z.infer<typeof promptEnhanceContextSourceSchema>;

export const promptEnhanceAssumptionSchema = z
  .object({
    text: z.string().trim().min(1).max(1_000),
    /** Откуда взято допущение: draft, контекст репозитория или модель домыслила. */
    origin: z.enum(["draft", "repository", "model"]),
  })
  .strict();
export type PromptEnhanceAssumption = z.infer<typeof promptEnhanceAssumptionSchema>;

export const promptEnhanceResultSchema = z
  .object({
    requestId: z.string().min(1),
    enhancedText: z.string().min(1),
    style: promptEnhanceStyleSchema,
    framework: promptEnhanceFrameworkSchema.default("oracle"),
    /** Coarse task/domain classification inferred without asking the author. */
    domain: z.string().trim().min(1).max(64).default("general"),
    taskKind: z.string().trim().min(1).max(64).default("general"),
    /** Явные уточнения, добавленные к черновику (не пересказ всего текста). */
    addedClarifications: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
    assumptions: z.array(promptEnhanceAssumptionSchema).max(20).default([]),
    capabilitySuggestions: z.array(promptEnhanceCapabilitySuggestionSchema).max(10).default([]),
    usedContext: z.array(promptEnhanceContextSourceSchema).max(10).default([]),
    modelUsed: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).strict(),
    /** Прирост входа: `tokensAfter - tokensBefore`; оценка тем же методом, что и в рантайме. */
    tokenDelta: z
      .object({
        before: z.number().int().nonnegative(),
        after: z.number().int().nonnegative(),
        method: z.enum(["tokenlens", "char-ratio"]),
      })
      .strict(),
    elapsedMs: z.number().nonnegative(),
  })
  .strict();
export type PromptEnhanceResult = z.infer<typeof promptEnhanceResultSchema>;

export const promptEnhanceCancelParamsSchema = z
  .object({ requestId: z.string().trim().min(1).max(64) })
  .strict();
export type PromptEnhanceCancelParams = z.infer<typeof promptEnhanceCancelParamsSchema>;

export const promptEnhanceStreamDeltaSchema = z
  .object({
    requestId: z.string().min(1),
    delta: z.string(),
    accumulated: z.string(),
  })
  .strict();
export type PromptEnhanceStreamDelta = z.infer<typeof promptEnhanceStreamDeltaSchema>;

/** Детерминированный код ошибки: RPC переносит его строкой, UI не угадывает по тексту. */
export const promptEnhanceErrorCodeSchema = z.enum([
  "invalid_request",
  "aborted",
  "timeout",
  "model_unavailable",
  "model_failed",
  "empty_result",
  "unsupported_changes",
]);
export type PromptEnhanceErrorCode = z.infer<typeof promptEnhanceErrorCodeSchema>;

export class PromptEnhanceError extends Error {
  constructor(
    readonly code: PromptEnhanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PromptEnhanceError";
  }
}

/** Провайдер-независимая формулировка ошибки; текст не содержит черновика пользователя. */
export function describePromptEnhanceError(code: PromptEnhanceErrorCode): string {
  switch (code) {
    case "invalid_request":
      return "The enhance request is invalid.";
    case "aborted":
      return "Prompt enhancement was cancelled.";
    case "timeout":
      return "Prompt enhancement timed out.";
    case "model_unavailable":
      return "No enhancer model is available.";
    case "model_failed":
      return "The enhancer model failed to produce a result.";
    case "empty_result":
      return "The enhancer model returned an empty prompt.";
    case "unsupported_changes":
      return "The enhancer changed protected mentions or the author's language.";
  }
}
