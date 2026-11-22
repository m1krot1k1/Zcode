/**
 * Реализация `BrowserTelemetryController` поверх Playwright `Page`.
 *
 * Владелец состояния — этот класс: он единственный держит подписки и буфер окна.
 * Вызывающий (браузерный контроллер) только просит `beginAction`/`observe`.
 */
import {
  BROWSER_OBSERVATION_BUDGETS,
  clipText,
  emptyObservationTruncation,
  isObservationHealthy,
  type BrowserActionObservation,
  type BrowserConsoleEntry,
  type BrowserConsoleLevel,
  type BrowserDialogObservation,
  type BrowserFailedRequest,
  type BrowserNavigationEntry,
  type BrowserPageErrorEntry,
} from "@zcode/shared";
import type { Dialog, Page, Request, Response } from "playwright-core";
import {
  BROWSER_TELEMETRY_DEFAULTS,
  type BrowserDialogPolicy,
  type BrowserObservationRequest,
  type BrowserTelemetryController,
  type BrowserTelemetryOptions,
} from "./contract.js";

interface PageWindow {
  consoleEntries: BrowserConsoleEntry[];
  pageErrors: BrowserPageErrorEntry[];
  failedRequests: BrowserFailedRequest[];
  navigations: BrowserNavigationEntry[];
  /** Тексты уже учтённых console.error — для дедупликации одинаковых повторов. */
  consoleErrorDedupe: Set<string>;
  /** Сколько записей вытеснено бюджетом этого окна. */
  droppedConsole: number;
  droppedPageErrors: number;
  droppedFailedRequests: number;
  droppedNavigations: number;
  currentDialog?: BrowserDialogObservation;
  /** Сырой объект диалога Playwright — нужен, чтобы закрыть его из таймера. */
  rawDialog?: Dialog;
  dialogTimer?: NodeJS.Timeout;
  /** Незавершённые чтения тел ошибочных ответов; observe() дожидается их. */
  pendingBodies: Array<Promise<void>>;
  /** Ловим `close`, чтобы снять подписки и таймеры страницы. */
  cleanup: Array<() => void>;
}

interface NormalizedOptions {
  dialogPolicy: BrowserDialogPolicy;
  dialogAutoDismissMs: number;
  quietWindowMs: number;
  maxSettleMs: number;
  screenshotAlways: boolean;
}

export function createBrowserTelemetryController(
  options: BrowserTelemetryOptions = {},
): BrowserTelemetryController {
  const config: NormalizedOptions = {
    dialogPolicy: options.dialogPolicy ?? BROWSER_TELEMETRY_DEFAULTS.dialogPolicy,
    dialogAutoDismissMs: Math.max(
      0,
      Math.trunc(options.dialogAutoDismissMs ?? BROWSER_TELEMETRY_DEFAULTS.dialogAutoDismissMs),
    ),
    quietWindowMs: Math.max(0, Math.trunc(options.quietWindowMs ?? BROWSER_TELEMETRY_DEFAULTS.quietWindowMs)),
    maxSettleMs: Math.max(0, Math.trunc(options.maxSettleMs ?? BROWSER_TELEMETRY_DEFAULTS.maxSettleMs)),
    screenshotAlways: options.screenshotAlways ?? BROWSER_TELEMETRY_DEFAULTS.screenshotAlways,
  };
  const windows = new Map<Page, PageWindow>();
  let disposed = false;

  const newWindow = (): PageWindow => ({
    consoleEntries: [],
    pageErrors: [],
    failedRequests: [],
    navigations: [],
    consoleErrorDedupe: new Set(),
    droppedConsole: 0,
    droppedPageErrors: 0,
    droppedFailedRequests: 0,
    droppedNavigations: 0,
    pendingBodies: [],
    cleanup: [],
  });

  const windowFor = (page: Page): PageWindow => {
    const existing = windows.get(page);
    if (existing) return existing;
    const created = newWindow();
    windows.set(page, created);
    return created;
  };

  const clearDialogTimer = (state: PageWindow): void => {
    if (state.dialogTimer) {
      clearTimeout(state.dialogTimer);
      state.dialogTimer = undefined;
    }
    state.rawDialog = undefined;
  };

  const disposeWindow = (state: PageWindow): void => {
    state.pendingBodies.length = 0;
    clearDialogTimer(state);
    for (const off of state.cleanup.splice(0)) off();
  };

  /**
   * Записывает диалог и запускает таймер авто-закрытия. Без таймера незакрытый
   * `confirm()` держит страницу вечно — агент получает таймауты вместо данных.
   */
  const recordDialog = (page: Page, dialog: Dialog, state: PageWindow): void => {
    const type = dialog.type();
    const normalized =
      type === "alert" || type === "confirm" || type === "prompt" || type === "beforeunload"
        ? type
        : "alert";
    state.rawDialog = dialog;
    state.currentDialog = {
      type: normalized,
      message: clipText(dialog.message(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars),
      disposition: "pending",
      ...(dialog.defaultValue()
        ? { defaultPrompt: clipText(dialog.defaultValue(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars) }
        : {}),
    };
    const autoDismiss = (): void => {
      if (!state.rawDialog) return;
      const pending = state.rawDialog;
      state.rawDialog = undefined;
      state.dialogTimer = undefined;
      // Ошибка dismiss только означает, что диалог уже закрыт пользователем/страницей.
      void pending.dismiss().catch(() => undefined);
      if (state.currentDialog?.disposition === "pending") {
        state.currentDialog = { ...state.currentDialog, disposition: "auto_dismissed" };
      }
    };
    if (config.dialogPolicy === "auto-dismiss") {
      autoDismiss();
      return;
    }
    if (config.dialogAutoDismissMs > 0) {
      state.dialogTimer = setTimeout(autoDismiss, config.dialogAutoDismissMs);
      state.dialogTimer.unref?.();
    }
  };

  const attach = (page: Page): void => {
    if (disposed) return;
    if (windows.has(page)) return;
    const state = newWindow();
    windows.set(page, state);

    const consoleListener = (message: {
      type: () => string;
      text: () => string;
      location: () => { url?: string; lineNumber?: number; columnNumber?: number };
    }) => {
      const rawType = message.type();
      const level: BrowserConsoleLevel =
        rawType === "error" ? "error" : rawType === "warning" ? "warning" : rawType === "debug" ? "debug" : "info";
      const text = clipText(message.text(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars);
      if (level === "error") {
        // React/Vue в dev-режиме дублируют одну ошибку несколько раз; без дедупликации
        // наблюдение тратит бюджет на копии и теряет другие сигналы.
        if (state.consoleErrorDedupe.has(text)) return;
        state.consoleErrorDedupe.add(text);
      }
      if (state.consoleEntries.length >= BROWSER_OBSERVATION_BUDGETS.maxConsoleEntries) {
        state.droppedConsole += 1;
        return;
      }
      const location = message.location();
      const parts = [location.url, location.lineNumber, location.columnNumber].filter(
        (part): part is string | number => part !== undefined && part !== "",
      );
      state.consoleEntries.push({
        level,
        text,
        ...(parts.length > 0 ? { location: parts.join(":") } : {}),
        ageMs: 0,
      });
    };
    page.on("console", consoleListener);
    state.cleanup.push(() => page.off("console", consoleListener));

    const pageErrorListener = (error: Error) => {
      if (state.pageErrors.length >= BROWSER_OBSERVATION_BUDGETS.maxPageErrors) {
        state.droppedPageErrors += 1;
        return;
      }
      state.pageErrors.push({
        name: error.name || "Error",
        message: clipText(error.message, BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars),
        ...(error.stack ? { stack: clipText(error.stack, BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars) } : {}),
        ageMs: 0,
      });
    };
    state.cleanup.push(() => page.off("pageerror", pageErrorListener));
    page.on("pageerror", pageErrorListener);

    const requestFailedListener = (request: Request) => {
      if (state.failedRequests.length >= BROWSER_OBSERVATION_BUDGETS.maxFailedRequests) {
        state.droppedFailedRequests += 1;
        return;
      }
      const failure = request.failure();
      state.failedRequests.push({
        kind: "request_failed",
        method: request.method(),
        url: clipText(request.url(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars),
        statusOrError: failure?.errorText ?? "unknown_failure",
        resourceType: request.resourceType(),
        ageMs: 0,
      });
    };
    page.on("requestfailed", requestFailedListener);
    state.cleanup.push(() => page.off("requestfailed", requestFailedListener));

    /**
     * Ответы >= 400 фиксируются здесь, тело читается лениво: `body()` может
     * выбросить для редиректов/закрытых страниц, поэтому тело — best-effort в observe().
     * Храним сам Response, чтобы не читать тело в горячем пути.
     */
    const responseListener = (response: Response) => {
      const status = response.status();
      if (status < 400) return;
      if (state.failedRequests.length >= BROWSER_OBSERVATION_BUDGETS.maxFailedRequests) {
        state.droppedFailedRequests += 1;
        return;
      }
      const request = response.request();
      const entry: BrowserFailedRequest = {
        kind: "http_error",
        method: request.method(),
        url: clipText(response.url(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars),
        statusOrError: String(status),
        resourceType: request.resourceType(),
        ageMs: 0,
      };
      state.failedRequests.push(entry);
      // Тело читаем сразу: Playwright гарантирует доступность body() вскоре после
      // ответа, а отложенное чтение через WeakMap теряет связь, если буфер окна
      // успевает сброситься. Промис складываем, чтобы observe() дождался сниппета.
      const bodyPromise = (async () => {
        try {
          const body = await response.body();
          const text = body.subarray(0, BROWSER_OBSERVATION_BUDGETS.maxResponseBodyBytes).toString("utf8");
          if (text) entry.responseSnippet = text;
        } catch {
          // Тело недоступно (редирект, бинарный поток, закрытая страница) — без сниппета.
        }
      })();
      state.pendingBodies.push(bodyPromise);
    };
    page.on("response", responseListener);
    state.cleanup.push(() => page.off("response", responseListener));

    const navigationListener = (frame: { url: () => string; parentFrame: () => unknown }) => {
      // Считаем только основную рамку: iframe-навигации засоряют наблюдение.
      if (frame.parentFrame() !== null) return;
      if (state.navigations.length >= BROWSER_OBSERVATION_BUDGETS.maxNavigations) {
        state.droppedNavigations += 1;
        return;
      }
      state.navigations.push({ url: clipText(frame.url(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars), kind: "frame_navigated", ageMs: 0 });
    };
    page.on("framenavigated", navigationListener);
    state.cleanup.push(() => page.off("framenavigated", navigationListener));

    const loadListener = () => {
      if (state.navigations.length >= BROWSER_OBSERVATION_BUDGETS.maxNavigations) return;
      state.navigations.push({ url: clipText(page.url(), BROWSER_OBSERVATION_BUDGETS.maxEntryTextChars), kind: "load", ageMs: 0 });
    };
    page.on("load", loadListener);
    state.cleanup.push(() => page.off("load", loadListener));

    const dialogListener = (dialog: Dialog) => recordDialog(page, dialog, state);
    page.on("dialog", dialogListener);
    state.cleanup.push(() => page.off("dialog", dialogListener));

    const closeListener = () => {
      disposeWindow(state);
      windows.delete(page);
    };
    page.on("close", closeListener);
    state.cleanup.push(() => page.off("close", closeListener));
  };

  const detach = (page: Page): void => {
    const state = windows.get(page);
    if (!state) return;
    disposeWindow(state);
    windows.delete(page);
  };

  const beginAction = (page: Page): void => {
    const state = windows.get(page);
    if (!state) return;
    state.consoleEntries.length = 0;
    state.pageErrors.length = 0;
    state.failedRequests.length = 0;
    state.navigations.length = 0;
    state.consoleErrorDedupe.clear();
    state.droppedConsole = 0;
    state.droppedPageErrors = 0;
    state.droppedFailedRequests = 0;
    state.droppedNavigations = 0;
    state.pendingBodies.length = 0;
  };

  const dialogFor = (page: Page): BrowserDialogObservation | undefined => windows.get(page)?.currentDialog;

  const noteDialogHandled = (page: Page, disposition: "accepted" | "dismissed"): void => {
    const state = windows.get(page);
    if (!state) return;
    clearDialogTimer(state);
    if (state.currentDialog) state.currentDialog = { ...state.currentDialog, disposition };
  };

  const observe = async (
    page: Page,
    request: BrowserObservationRequest = {},
  ): Promise<BrowserActionObservation> => {
    const startedAt = Date.now();
    const state = windowFor(page);

    /**
     * Микро-стабилизация: действие могло запустить fetch/XHR, и ответ придёт уже
     * после возврата из Playwright. Ждём `networkidle` в пределах `maxSettleMs`,
     * но не считаем таймаут ошибкой — это потолок, а не гарантия.
     */
    if (config.maxSettleMs > 0) {
      await page
        .waitForLoadState("networkidle", { timeout: config.maxSettleMs })
        .catch(() => undefined);
    }

    const truncation = emptyObservationTruncation();
    truncation.console = state.droppedConsole > 0;
    truncation.pageErrors = state.droppedPageErrors > 0;
    truncation.failedRequests = state.droppedFailedRequests > 0;
    truncation.navigations = state.droppedNavigations > 0;


    const url = page.url();
    const title = await page.title().catch(() => "");
    const maxAriaChars = Math.max(0, request.maxAriaChars ?? BROWSER_OBSERVATION_BUDGETS.maxAriaSnapshotChars);
    let ariaSnapshotCompact = "";
    if (maxAriaChars > 0) {
      try {
        const raw = await page.locator("body").ariaSnapshot({ timeout: 2_000 });
        ariaSnapshotCompact = clipText(raw, maxAriaChars);
        truncation.ariaSnapshot = raw.length > maxAriaChars;
      } catch {
        truncation.ariaSnapshot = true;
      }
    }

    const maxDomNodes = Math.max(0, request.maxDomNodes ?? BROWSER_OBSERVATION_BUDGETS.maxDomNodes);
    let dom: BrowserActionObservation["dom"];
    if (maxDomNodes > 0) {
      try {
        const collected = await page.evaluate((limit) => {
          const selector =
            "body,main,nav,header,footer,aside,section,article,h1,h2,h3,h4,h5,h6,p,ul,ol,li,form,table,button,input,textarea,select,a[href],[role]";
          const nodes = Array.from(document.querySelectorAll(selector))
            .slice(0, limit)
            .map((element) => {
              const tag = element.tagName.toLowerCase();
              let depth = 0;
              for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
              const text = ((element as HTMLElement).innerText || element.textContent || "")
                .trim()
                .replace(/\s+/g, " ");
              const role = element.getAttribute("role");
              const ariaLabel = element.getAttribute("aria-label");
              return {
                tag,
                depth,
                ...(role ? { role } : {}),
                ...(ariaLabel ? { name: ariaLabel } : {}),
                ...(text ? { text: text.slice(0, 160) } : {}),
              };
            });
          return { nodes, total: document.querySelectorAll(selector).length };
        }, maxDomNodes);
        truncation.dom = collected.total > maxDomNodes;
        dom = collected.nodes;
      } catch {
        truncation.dom = true;
        dom = undefined;
      }
    }

    const wantsScreenshot =
      request.includeScreenshot === true || config.screenshotAlways || !isObservationHealthy({
        pageErrors: state.pageErrors,
        consoleEntries: state.consoleEntries,
        failedRequests: state.failedRequests,
      });
    let screenshotBase64: string | undefined;
    let screenshotBytes: number | undefined;
    if (wantsScreenshot) {
      try {
        const buffer = await page.screenshot({ type: "jpeg", quality: BROWSER_OBSERVATION_BUDGETS.screenshotQuality });
        if (buffer.byteLength <= BROWSER_OBSERVATION_BUDGETS.maxScreenshotBytes) {
          screenshotBase64 = buffer.toString("base64");
          screenshotBytes = buffer.byteLength;
        } else {
          // Не отдаём модели кадр сверх бюджета: это скрытая стоимость токенов.
          truncation.screenshot = true;
        }
      } catch {
        truncation.screenshot = true;
      }
    }

    // Финальный дренаж: события `response` успевают прийти во время сборки снимка,
    // поэтому тела дочитываются непосредственно перед формированием результата.
    if (state.pendingBodies.length > 0) {
      await Promise.all(state.pendingBodies.map((promise) => promise.catch(() => undefined)));
      state.pendingBodies.length = 0;
    }

    const healthy = isObservationHealthy({
      pageErrors: state.pageErrors,
      consoleEntries: state.consoleEntries,
      failedRequests: state.failedRequests,
    });

    return {
      url,
      title,
      ariaSnapshotCompact,
      ...(dom ? { dom } : {}),
      consoleEntries: state.consoleEntries.map((entry) => ({ ...entry, ageMs: startedAt - startedAt })),
      pageErrors: state.pageErrors.map((entry) => ({ ...entry, ageMs: startedAt - startedAt })),
      failedRequests: state.failedRequests.map((entry) => ({ ...entry, ageMs: startedAt - startedAt })),
      navigations: state.navigations.map((entry) => ({ ...entry, ageMs: startedAt - startedAt })),
      ...(state.currentDialog ? { dialog: state.currentDialog } : {}),
      ...(screenshotBase64
        ? { screenshotBase64, screenshotMimeType: "image/jpeg" as const, screenshotBytes }
        : {}),
      truncation,
      collectionDurationMs: Date.now() - startedAt,
      capturedAt: startedAt,
      healthy,
    };
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const state of windows.values()) disposeWindow(state);
    windows.clear();
  };

  return { attach, detach, beginAction, observe, dialogFor, noteDialogHandled, dispose };
}
