/**
 * cli-browser-telemetry — контракт сбора телеметрии браузерных действий.
 *
 * Модуль владеет подписками на события Playwright `Page` (console, pageerror,
 * requestfailed, response >= 400, навигация, dialog) и сборкой атомарного
 * наблюдения `BrowserActionObservation`, которое уходит МОДЕЛИ в результате
 * инструмента, а не только в логи.
 *
 * Почему отдельный модуль: раньше каждая ячейка повторно импортировала SDK и
 * теряла события между вызовами. Здесь состояние живёт в контроллере, привязанном
 * к `Page`, а буфер окна сбрасывается атомарно в момент начала действия.
 *
 * Инварианты:
 * - события не теряются между действиями: коллектор подписывается один раз на страницу;
 * - окно наблюдения ограничено бюджетами и явно помечает усечение;
 * - диалог не «залипает»: либо его обрабатывает агент, либо контроллер закрывает его
 *   по таймауту с явной пометкой `auto_dismissed`;
 * - `dispose()` снимает все подписки и таймеры, повторный вызов идемпотентен.
 */
import type { BrowserActionObservation, BrowserDialogObservation } from "@zcode/shared";
import type { Page } from "playwright-core";

/** Что делать с незакрытым JS-диалогом. */
export type BrowserDialogPolicy = "record" | "auto-dismiss";

export interface BrowserTelemetryOptions {
  /**
   * Политика диалогов. `record` оставляет диалог агенту до истечения
   * `dialogAutoDismissMs`; `auto-dismiss` закрывает немедленно и сообщает об этом
   * в наблюдении. По умолчанию `record` — модель может ответить на confirm/prompt.
   */
  dialogPolicy?: BrowserDialogPolicy;
  /**
   * Через сколько миллисекунд незакрытый диалог закрывается автоматически.
   * Защита от вечной блокировки страницы. По умолчанию 10 000 мс.
   */
  dialogAutoDismissMs?: number;
  /**
   * Потолок ожидания микро-стабилизации после действия (тишина сети/DOM).
   * По умолчанию 350 мс тишины при потолке 2 500 мс.
   */
  quietWindowMs?: number;
  maxSettleMs?: number;
  /** Прикладывать ли WebP-кадр к каждому наблюдению (по умолчанию только при ошибках). */
  screenshotAlways?: boolean;
}

/** Параметры одного снятия наблюдения. */
export interface BrowserObservationRequest {
  /** Приложить кадр даже при здоровом состоянии. */
  includeScreenshot?: boolean;
  /** Сколько узлов DOM включать (0 — не включать). По умолчанию 200. */
  maxDomNodes?: number;
  /** Максимум символов ARIA-снимка. По умолчанию 12 000. */
  maxAriaChars?: number;
}

/**
 * Владелец телеметрии. Один экземпляр на browser runtime; страницы
 * подключаются и отключаются явно.
 */
export interface BrowserTelemetryController {
  /** Подписывает контроллер на страницу. Идемпотентно для одной и той же страницы. */
  attach(page: Page): void;
  /** Снимает подписки со страницы и сбрасывает её буфер. */
  detach(page: Page): void;
  /**
   * Сбрасывает буфер окна страницы. Вызывается перед действием, чтобы
   * наблюдение содержало только эффекты именно этого действия.
   */
  beginAction(page: Page): void;
  /**
   * Собирает наблюдение по накопленным событиям, ARIA/DOM-снимку и (опционально) кадру.
   * Не бросает: недоступный ARIA-снимок даёт пустую строку, недоступный кадр — флаг усечения.
   */
  observe(page: Page, request?: BrowserObservationRequest): Promise<BrowserActionObservation>;
  /** Текущий незакрытый диалог страницы, если он есть. */
  dialogFor(page: Page): BrowserDialogObservation | undefined;
  /**
   * Отмечает, что агент сам обработал диалог. Снимает таймер авто-закрытия,
   * чтобы `handleDialog` не конфликтовал с политикой.
   */
  noteDialogHandled(page: Page, disposition: "accepted" | "dismissed"): void;
  /** Снимает все подписки и таймеры. Идемпотентно. */
  dispose(): void;
}

/** Таймауты по умолчанию. */
export const BROWSER_TELEMETRY_DEFAULTS = {
  dialogPolicy: "record",
  dialogAutoDismissMs: 10_000,
  quietWindowMs: 350,
  maxSettleMs: 2_500,
  screenshotAlways: false,
} as const;
