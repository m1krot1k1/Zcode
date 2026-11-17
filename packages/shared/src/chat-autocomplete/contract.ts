import { z } from "zod";

/**
 * Проводной контракт `ChatAutocompleteService` (ghost-text в композере).
 *
 * Модуль чистый: только Zod-схемы, лимиты и чистые функции пост-обработки.
 * Сбор контекста, обращение к модели, кэш префиксов и профиль лексики живут
 * в Host-сервисе (`packages/services`). Один контракт обслуживает Desktop Local
 * Host, Remote SSH Server и Web Remote — транспорт не добавляет своих полей.
 */

/** Откуда взялась подсказка: кэш префиксов или стрим модели. */
export const chatAutocompleteSourceSchema = z.enum([
  "prefix_cache_exact",
  "prefix_cache_partial",
  "prefix_cache_backspace",
  "model_stream",
]);
export type ChatAutocompleteSource = z.infer<typeof chatAutocompleteSourceSchema>;

/** Жёсткие бюджеты: подсказка не должна ни жечь токены, ни задерживать ввод. */
export const CHAT_AUTOCOMPLETE_MAX_OUTPUT_TOKENS = 48;
export const CHAT_AUTOCOMPLETE_REQUEST_TIMEOUT_MS = 1_200;
export const CHAT_AUTOCOMPLETE_MIN_PREFIX_CHARS = 4;
export const CHAT_AUTOCOMPLETE_MAX_PREFIX_CHARS = 4_000;
export const CHAT_AUTOCOMPLETE_MAX_SUFFIX_CHARS = 1_000;
export const CHAT_AUTOCOMPLETE_MAX_OPEN_TABS = 8;
export const CHAT_AUTOCOMPLETE_MAX_CONTEXT_MESSAGES = 6;
export const CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS = 320;
export const CHAT_AUTOCOMPLETE_CACHE_ENTRIES = 32;
export const CHAT_AUTOCOMPLETE_LEXICON_MAX_BYTES = 64 * 1024;
export const CHAT_AUTOCOMPLETE_LEXICON_MAX_PHRASES = 150;

/** Уровень обогащения запроса: какие источники реально подмешиваются в контекст. */
export const chatAutocompleteContextOptionsSchema = z
  .object({
    history: z.boolean().default(true),
    openFiles: z.boolean().default(true),
    diffs: z.boolean().default(true),
    codeIndex: z.boolean().default(true),
    userLexicon: z.boolean().default(true),
  })
  .strict();
export type ChatAutocompleteContextOptions = z.infer<
  typeof chatAutocompleteContextOptionsSchema
>;

/** Настройки ghost-подсказки в композере; владелец — `AppSettings`. */
export const chatAutocompleteSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Базовый дебаунс; адаптивность поднимает его до 700 мс при быстром наборе. */
    debounceMs: z.number().int().min(120).max(800).default(250),
    /** Принимать слово по `ArrowRight` (иначе только `Tab` и клик). */
    acceptWordOnArrowRight: z.boolean().default(true),
    /** Минимальная длина префикса, ниже которой модель не спрашиваем. */
    minPrefixChars: z.number().int().min(3).max(40).default(6),
    /** Подсказка только когда курсор в конце текста. */
    cursorAtEndOnly: z.boolean().default(true),
    /** Быстрая модель; `null` — автовыбор быстрой модели провайдера. */
    modelOverride: z
      .object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1) })
      .strict()
      .nullable()
      .default(null),
    context: chatAutocompleteContextOptionsSchema.default({
      history: true,
      openFiles: true,
      diffs: true,
      codeIndex: true,
      userLexicon: true,
    }),
  })
  .strict();
export type ChatAutocompleteSettings = z.infer<typeof chatAutocompleteSettingsSchema>;

/** Настройки улучшения промптов (4.4 + UI 4.6). */
export const promptEnhancerSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    style: z
      .enum(["structured_engineering", "concise_direct", "deep_architectural"])
      .default("structured_engineering"),
    /** Сколько источников контекста подключать (0 — только черновик). */
    maxContextSources: z.number().int().min(0).max(5).default(4),
    modelOverride: z
      .object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1) })
      .strict()
      .nullable()
      .default(null),
    includeCodeIndexContext: z.boolean().default(true),
    includeConversationHistory: z.boolean().default(true),
  })
  .strict();
export type PromptEnhancerSettings = z.infer<typeof promptEnhancerSettingsSchema>;

export const chatAutocompleteRequestSchema = z
  .object({
    requestId: z.string().trim().min(8).max(64),
    workspacePath: z.string().trim().min(1).max(4096),
    /** Идентичность удалённого workspace; при отсутствии Host берёт `workspacePath`. */
    workspaceIdentity: z.string().trim().min(1).max(4096).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    /** Текст до курсора; подсказка генерируется как его продолжение. */
    prefix: z
      .string()
      .min(CHAT_AUTOCOMPLETE_MIN_PREFIX_CHARS)
      .max(CHAT_AUTOCOMPLETE_MAX_PREFIX_CHARS),
    suffix: z.string().max(CHAT_AUTOCOMPLETE_MAX_SUFFIX_CHARS).default(""),
    /** Подсказка допустима только когда курсор в конце мысли (настраивается в UI). */
    cursorAtEndOfLine: z.boolean().default(true),
    activeFilePath: z.string().trim().min(1).max(4096).optional(),
    openTabPaths: z
      .array(z.string().trim().min(1).max(4096))
      .max(CHAT_AUTOCOMPLETE_MAX_OPEN_TABS)
      .default([]),
    /** Явный выбор быстрой модели; при отсутствии Host берёт дефолтную. */
    modelSelection: z
      .object({ providerId: z.string().trim().min(1), modelId: z.string().trim().min(1) })
      .strict()
      .optional(),
    context: chatAutocompleteContextOptionsSchema.default({
      history: true,
      openFiles: true,
      diffs: true,
      codeIndex: true,
      userLexicon: true,
    }),
    /** Базовый дебаунс из настроек; Host использует его как стартовый ориентир. */
    debounceMs: z.number().int().min(100).max(1_000).optional(),
  })
  .strict();
export type ChatAutocompleteRequest = z.infer<typeof chatAutocompleteRequestSchema>;

export const chatAutocompleteResponseSchema = z
  .object({
    requestId: z.string().min(1),
    /** Чистый суффикс для вставки в GhostTextNode (после `removePrefixOverlap`). */
    suggestion: z.string(),
    source: chatAutocompleteSourceSchema,
    latencyMs: z.number().nonnegative(),
    /** Модель, реально ответившая на запрос; `null` для ответов из кэша. */
    modelUsed: z
      .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type ChatAutocompleteResponse = z.infer<typeof chatAutocompleteResponseSchema>;

export const chatAutocompleteCancelParamsSchema = z
  .object({ requestId: z.string().trim().min(1).max(64) })
  .strict();
export type ChatAutocompleteCancelParams = z.infer<typeof chatAutocompleteCancelParamsSchema>;

export const chatAutocompleteAcceptedSuggestionSchema = z
  .object({
    workspacePath: z.string().trim().min(1).max(4096),
    workspaceIdentity: z.string().trim().min(1).max(4096).optional(),
    /** Полный промпт после принятия — источник паттернов постановки задач. */
    fullPrompt: z.string().max(32_000),
    acceptedSlice: z.string().max(CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS),
  })
  .strict();
export type ChatAutocompleteAcceptedSuggestion = z.infer<
  typeof chatAutocompleteAcceptedSuggestionSchema
>;

export const chatAutocompleteLexiconLanguageSchema = z.enum(["ru", "en", "zh", "unknown"]);
export type ChatAutocompleteLexiconLanguage = z.infer<
  typeof chatAutocompleteLexiconLanguageSchema
>;

export const chatAutocompleteLexiconPhraseSchema = z
  .object({
    text: z.string().trim().min(1).max(120),
    /** Экспоненциально сглаженный вес; больше — чаще употребляется. */
    weight: z.number().positive().max(1_000),
  })
  .strict();
export type ChatAutocompleteLexiconPhrase = z.infer<typeof chatAutocompleteLexiconPhraseSchema>;

/** Компактный профиль стиля пользователя; секреты и пути вырезаются до записи. */
export const chatAutocompleteLexiconProfileSchema = z
  .object({
    version: z.literal(1).default(1),
    preferredLanguage: chatAutocompleteLexiconLanguageSchema.default("unknown"),
    frequentPhrases: z
      .array(chatAutocompleteLexiconPhraseSchema)
      .max(CHAT_AUTOCOMPLETE_LEXICON_MAX_PHRASES)
      .default([]),
    imperativePatterns: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    averageMessageChars: z.number().int().nonnegative().max(32_000).default(0),
    samples: z.number().int().nonnegative().default(0),
    updatedAt: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ChatAutocompleteLexiconProfile = z.infer<typeof chatAutocompleteLexiconProfileSchema>;

/** Детерминированные коды ошибок: UI не угадывает причину по тексту. */
export const chatAutocompleteErrorCodeSchema = z.enum([
  "invalid_request",
  "aborted",
  "timeout",
  "model_unavailable",
  "model_failed",
  "empty_suggestion",
]);
export type ChatAutocompleteErrorCode = z.infer<typeof chatAutocompleteErrorCodeSchema>;

export class ChatAutocompleteError extends Error {
  constructor(
    readonly code: ChatAutocompleteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatAutocompleteError";
  }
}

/** Текст ошибки не содержит пользовательского ввода. */
export function describeChatAutocompleteError(code: ChatAutocompleteErrorCode): string {
  switch (code) {
    case "invalid_request":
      return "The autocomplete request is invalid.";
    case "aborted":
      return "Autocomplete was cancelled.";
    case "timeout":
      return "Autocomplete timed out.";
    case "model_unavailable":
      return "No autocomplete model is available.";
    case "model_failed":
      return "The autocomplete model failed.";
    case "empty_suggestion":
      return "The autocomplete model returned no suggestion.";
  }
}
