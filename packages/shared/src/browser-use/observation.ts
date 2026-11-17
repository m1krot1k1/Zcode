import { z } from "zod";

/**
 * BrowserActionObservation — атомарное наблюдение за одним действием браузера.
 *
 * Зачем отдельная схема: агент принимает решения по фактическому состоянию страницы, а не
 * по «нажатие прошло успешно». Поэтому после каждого действия контроллер отдаёт модели
 * не только результат команды, но и телеметрию: консоль, необработанные исключения,
 * сетевые сбои, HTTP >= 400, ARIA/DOM-снимок и (по запросу или при ошибке) кадр экрана.
 *
 * Инварианты:
 * - массив ошибок всегда содержит бюджет и флаг усечения; потеря данных видима, не маскируется;
 * - `healthy` вычисляется по фактам (нет pageerror, нет console.error, нет 5xx/failed),
 *   а не по `ok` команды: успешное нажатие может сломать страницу;
 * - `screenshotWebpBase64` опционален и ограничен по байтам, чтобы не съесть бюджет токенов.
 */

/** Бюджет телеметрии одного действия. Всё, что не влезло, помечается усечением. */
export const BROWSER_OBSERVATION_BUDGETS = {
  /** Сколько записей консоли максимум отдавать модели. */
  maxConsoleEntries: 40,
  /** Сколько необработанных исключений максимум отдавать. */
  maxPageErrors: 20,
  /** Сколько сетевых сбоев/HTTP-ошибок максимум отдавать. */
  maxFailedRequests: 25,
  /** Сколько навигационных событий максимум отдавать. */
  maxNavigations: 20,
  /** Максимальная длина текста одного сообщения консоли/ошибки. */
  maxEntryTextChars: 2_000,
  /** Сколько байт тела ошибочного ответа прикладывать. */
  maxResponseBodyBytes: 512,
  /** Максимум символов в компактном ARIA-снимке. */
  maxAriaSnapshotChars: 12_000,
  /** Максимум узлов DOM в снимке. */
  maxDomNodes: 200,
  /** Максимум байт кадра (jpg/png). */
  maxScreenshotBytes: 512 * 1024,
  /** Качество JPEG-кадра (0-100). */
  screenshotQuality: 75,
} as const;

export const browserConsoleLevelSchema = z.enum(["debug", "info", "warning", "error"]);
export type BrowserConsoleLevel = z.infer<typeof browserConsoleLevelSchema>;

export const browserConsoleEntrySchema = z
  .object({
    level: browserConsoleLevelSchema,
    text: z.string(),
    /** `url:line:column` или путь в бандле, если страница его отдала. */
    location: z.string().optional(),
    /** Стек, если он есть только у исключений внутри console.error. */
    stack: z.string().optional(),
    /** Сколько миллисекунд назад от момента снятия наблюдения это произошло. */
    ageMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserConsoleEntry = z.infer<typeof browserConsoleEntrySchema>;

export const browserPageErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    ageMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserPageErrorEntry = z.infer<typeof browserPageErrorSchema>;

export const browserFailedRequestSchema = z
  .object({
    /** `request_failed` — обрыв/отказ; `http_error` — ответ с кодом >= 400. */
    kind: z.enum(["request_failed", "http_error"]),
    method: z.string(),
    url: z.string(),
    /** Код ответа для `http_error`; текст ошибки (`ERR_CONNECTION_REFUSED`) для сбоя. */
    statusOrError: z.string(),
    resourceType: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    /** Первые `maxResponseBodyBytes` байт тела ответа с ошибкой. */
    responseSnippet: z.string().optional(),
    ageMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserFailedRequest = z.infer<typeof browserFailedRequestSchema>;

export const browserNavigationEntrySchema = z
  .object({
    url: z.string(),
    kind: z.enum(["frame_navigated", "committed", "load", "domcontentloaded"]),
    ageMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserNavigationEntry = z.infer<typeof browserNavigationEntrySchema>;

export const browserDialogObservationSchema = z
  .object({
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string(),
    /** `pending` — диалог ждёт решения агента; `auto_dismissed` — закрыт контроллером. */
    disposition: z.enum(["pending", "auto_dismissed", "accepted", "dismissed"]),
    defaultPrompt: z.string().optional(),
  })
  .strict();
export type BrowserDialogObservation = z.infer<typeof browserDialogObservationSchema>;

/** Флаги усечения: модель должна знать, что наблюдение неполное. */
export const browserObservationTruncationSchema = z
  .object({
    console: z.boolean(),
    pageErrors: z.boolean(),
    failedRequests: z.boolean(),
    navigations: z.boolean(),
    ariaSnapshot: z.boolean(),
    dom: z.boolean(),
    screenshot: z.boolean(),
  })
  .strict();
export type BrowserObservationTruncation = z.infer<typeof browserObservationTruncationSchema>;

export const browserActionObservationSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    /** Компактный ARIA-снимок: то, что модель читает вместо пикселей. */
    ariaSnapshotCompact: z.string(),
    dom: z
      .array(
        z
          .object({
            tag: z.string(),
            depth: z.number().int().nonnegative(),
            role: z.string().optional(),
            name: z.string().optional(),
            text: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    consoleEntries: z.array(browserConsoleEntrySchema),
    pageErrors: z.array(browserPageErrorSchema),
    failedRequests: z.array(browserFailedRequestSchema),
    navigations: z.array(browserNavigationEntrySchema),
    dialog: browserDialogObservationSchema.nullable().optional(),
    /** JPEG-кадр в base64; прикладывается по запросу или при нездоровом состоянии. */
    screenshotBase64: z.string().optional(),
    /** Формат кадра. Playwright отдаёт png/jpeg; webp не поддерживается. */
    screenshotMimeType: z.enum(["image/jpeg", "image/png"]).optional(),
    screenshotBytes: z.number().int().nonnegative().optional(),
    truncation: browserObservationTruncationSchema,
    /** Сколько миллисекунд занял сбор телеметрии. */
    collectionDurationMs: z.number().nonnegative(),
    /** Момент снятия наблюдения (epoch ms). */
    capturedAt: z.number().nonnegative(),
    /**
     * `true` тогда и только тогда, когда нет pageerror, нет console.error и нет 5xx/failed.
     * Считается по фактам, а не по `ok` команды.
     */
    healthy: z.boolean(),
  })
  .strict();
export type BrowserActionObservation = z.infer<typeof browserActionObservationSchema>;

/** Усечение строки с явным маркером — модель не должна думать, что видит всё. */
export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated ${value.length - maxChars} chars]`;
}

/** Здоровье наблюдения по фактам телеметрии. */
export function isObservationHealthy(input: {
  pageErrors: readonly unknown[];
  consoleEntries: readonly { level: BrowserConsoleLevel }[];
  failedRequests: readonly { kind: "request_failed" | "http_error"; statusOrError: string }[];
}): boolean {
  if (input.pageErrors.length > 0) return false;
  if (input.consoleEntries.some((entry) => entry.level === "error")) return false;
  return !input.failedRequests.some(
    (request) =>
      request.kind === "request_failed" ||
      request.statusOrError.startsWith("5") ||
      request.statusOrError === "500",
  );
}

/** Пустые флаги усечения — базовая линия для контроллера. */
export function emptyObservationTruncation(): BrowserObservationTruncation {
  return {
    console: false,
    pageErrors: false,
    failedRequests: false,
    navigations: false,
    ariaSnapshot: false,
    dom: false,
    screenshot: false,
  };
}
