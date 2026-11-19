import { z } from "zod";

/**
 * Proactive next-task suggestion — wire contract.
 * Владелец текста — UI-контроллер композера; сервис генерирует один короткий текст
 * по снимку контекста, переданному в запросе.
 */

/** Сколько последних сообщений попадает в контекст. */
export const PROACTIVE_SUGGESTION_MAX_MESSAGES = 8;
/** Лимит символов на одно сообщение контекста. */
export const PROACTIVE_SUGGESTION_MAX_MESSAGE_CHARS = 600;
/** Лимит символов ответа ассистента за завершённый turn. */
export const PROACTIVE_SUGGESTION_MAX_ASSISTANT_RESULT_CHARS = 1_200;
/** Сколько результатов инструментов попадает в контекст. */
export const PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS = 8;
/** Лимит символов на имя инструмента. */
export const PROACTIVE_SUGGESTION_MAX_TOOL_NAME_CHARS = 80;
/** Лимит символов на результат инструмента. */
export const PROACTIVE_SUGGESTION_MAX_TOOL_RESULT_CHARS = 400;
/** Сколько изменённых файлов/диффов попадает в контекст. */
export const PROACTIVE_SUGGESTION_MAX_DIFFS = 6;
/** Лимит символов на summary дифа. */
export const PROACTIVE_SUGGESTION_MAX_DIFF_CHARS = 300;
/** Сколько открытых файлов попадает в контекст. */
export const PROACTIVE_SUGGESTION_MAX_OPEN_FILES = 16;
/** Сколько результатов тестовых прогонов попадает в контекст. */
export const PROACTIVE_SUGGESTION_MAX_TEST_RESULTS = 4;
/** Лимит символов на имя тестового инструмента/команды. */
export const PROACTIVE_SUGGESTION_MAX_TEST_RESULT_TOOL_NAME_CHARS = 120;
/** Лимит символов на статус тестового прогона. */
export const PROACTIVE_SUGGESTION_MAX_TEST_RESULT_STATUS_CHARS = 40;
/** Лимит символов на summary тестового прогона. */
export const PROACTIVE_SUGGESTION_MAX_TEST_RESULT_CHARS = 300;
/** Бюджет ответа модели: одна короткая следующая задача. */
export const PROACTIVE_SUGGESTION_MAX_OUTPUT_TOKENS = 96;
/** Жёсткий таймаут запроса; внедряется в тестах. */
export const PROACTIVE_SUGGESTION_REQUEST_TIMEOUT_MS = 8_000;
/** Максимальная длина показанной подсказки. */
export const PROACTIVE_SUGGESTION_MAX_SUGGESTION_CHARS = 240;

export const proactiveSuggestionErrorCodeSchema = z.enum([
  "invalid_request",
  "aborted",
  "timeout",
  "empty_suggestion",
  "assistant_voice",
  "model_unavailable",
  "model_failed",
]);
export type ProactiveSuggestionErrorCode = z.infer<typeof proactiveSuggestionErrorCodeSchema>;

/** Причина, по которой валидный ответ модели дал `suggestion: null`. */
export const proactiveSuggestionSkipReasonSchema = z.enum(["empty_suggestion", "assistant_voice"]);
export type ProactiveSuggestionSkipReason = z.infer<typeof proactiveSuggestionSkipReasonSchema>;

export const proactiveSuggestionMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(PROACTIVE_SUGGESTION_MAX_MESSAGE_CHARS),
  })
  .strict();

export const proactiveSuggestionToolResultSchema = z
  .object({
    toolName: z.string().trim().min(1).max(PROACTIVE_SUGGESTION_MAX_TOOL_NAME_CHARS),
    summary: z.string().max(PROACTIVE_SUGGESTION_MAX_TOOL_RESULT_CHARS),
  })
  .strict();

export const proactiveSuggestionDiffSchema = z
  .object({
    path: z.string().trim().min(1).max(400),
    summary: z.string().max(PROACTIVE_SUGGESTION_MAX_DIFF_CHARS).optional(),
  })
  .strict();

/**
 * Результат тестового прогона: короткое резюме без вывода целиком.
 * Совпадает с UI-контекстом композера (тот же shape и те же срезы).
 */
export const proactiveSuggestionTestResultSchema = z
  .object({
    toolName: z.string().trim().min(1).max(PROACTIVE_SUGGESTION_MAX_TEST_RESULT_TOOL_NAME_CHARS),
    /**
     * Статус не требует `min(1)`: проекция turn'а может не знать статуса, и
     * UI подставляет fallback `completed` только для null/undefined.
     */
    status: z.string().max(PROACTIVE_SUGGESTION_MAX_TEST_RESULT_STATUS_CHARS),
    summary: z.string().max(PROACTIVE_SUGGESTION_MAX_TEST_RESULT_CHARS),
  })
  .strict();

export const proactiveSuggestionContextSchema = z
  .object({
    messages: z
      .array(proactiveSuggestionMessageSchema)
      .max(PROACTIVE_SUGGESTION_MAX_MESSAGES)
      .default([]),
    assistantResult: z
      .string()
      .max(PROACTIVE_SUGGESTION_MAX_ASSISTANT_RESULT_CHARS)
      .nullable()
      .default(null),
    toolResults: z
      .array(proactiveSuggestionToolResultSchema)
      .max(PROACTIVE_SUGGESTION_MAX_TOOL_RESULTS)
      .default([]),
    testResults: z
      .array(proactiveSuggestionTestResultSchema)
      .max(PROACTIVE_SUGGESTION_MAX_TEST_RESULTS)
      .default([]),
    diffs: z.array(proactiveSuggestionDiffSchema).max(PROACTIVE_SUGGESTION_MAX_DIFFS).default([]),
    openFiles: z
      .array(z.string().trim().min(1).max(400))
      .max(PROACTIVE_SUGGESTION_MAX_OPEN_FILES)
      .default([]),
  })
  .strict();
export type ProactiveSuggestionContext = z.infer<typeof proactiveSuggestionContextSchema>;

export const proactiveSuggestionRequestSchema = z
  .object({
    requestId: z.string().trim().min(8).max(64),
    sessionId: z.string().trim().min(1).max(256),
    turnId: z.string().trim().min(1).max(256),
    /** Черновик обязан быть пустым: подсказка предлагает следующую задачу. */
    draftEmpty: z.literal(true),
    cursor: z
      .object({
        offset: z.number().int().nonnegative(),
        atEnd: z.boolean(),
      })
      .strict()
      .optional(),
    workspacePath: z.string().trim().min(1).max(4_096),
    workspaceIdentity: z.string().trim().min(1).max(4_096).optional(),
    context: proactiveSuggestionContextSchema.default({
      messages: [],
      assistantResult: null,
      toolResults: [],
      testResults: [],
      diffs: [],
      openFiles: [],
    }),
  })
  .strict();
export type ProactiveSuggestionRequest = z.infer<typeof proactiveSuggestionRequestSchema>;

export const proactiveSuggestionResponseSchema = z
  .object({
    requestId: z.string().trim().min(1),
    /** `null` — валидный «нет подсказки»; причина в `reason`. */
    suggestion: z.string().trim().min(1).max(PROACTIVE_SUGGESTION_MAX_SUGGESTION_CHARS).nullable(),
    reason: proactiveSuggestionSkipReasonSchema.nullable().default(null),
    latencyMs: z.number().nonnegative(),
    modelUsed: z
      .object({ providerId: z.string(), modelId: z.string() })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type ProactiveSuggestionResponse = z.infer<typeof proactiveSuggestionResponseSchema>;

export const proactiveSuggestionCancelSchema = z
  .object({ requestId: z.string().trim().min(8).max(64) })
  .strict();
export type ProactiveSuggestionCancel = z.infer<typeof proactiveSuggestionCancelSchema>;

/** Настройки проактивной подсказки; владелец — `settingService` / `AppSettings`. */
export const proactiveSuggestionSettingsSchema = z
  .object({
    /**
     * Включено по умолчанию: подсказка появляется только по focus/click на пустом
     * композере после завершённого turn и никогда не отправляется автоматически.
     * Стоимость — один запрос до 96 выходных токенов на завершённый turn.
     */
    enabled: z.boolean().default(true),
    /** Ровно одна подсказка на turn (дедуп также живёт в UI-контроллере). */
    maxSuggestionsPerTurn: z.number().int().min(1).max(1).default(1),
  })
  .strict();
export type ProactiveSuggestionSettings = z.infer<typeof proactiveSuggestionSettingsSchema>;
