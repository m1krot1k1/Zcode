import type {
  BrowserCommandResult,
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@zcode/contracts";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Download, FileChooser, Locator, Page } from "playwright-core";

const DEFAULT_TIMEOUT_MS = 3_000;
type PartialResult = Omit<BrowserCommandResult, "elapsedMs">;

/**
 * Контекст выполнения Playwright-действий.
 *
 * `workspacePath` обязателен для файловых операций: и загрузка, и скачивание должны
 * оставаться внутри workspace. Без него файловые операции отклоняются, а не «делают
 * что-нибудь» — молчаливый выход за пределы рабочей директории недопустим.
 */
export interface ManagedPlaywrightContext {
  workspacePath?: string;
}

const downloads = new Map<string, Download>();
const fileChoosers = new Map<string, FileChooser>();

function timeoutMs(value?: number): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

/**
 * Проверяет, что путь лежит внутри workspace.
 *
 * Сравнение идёт по нормализованным абсолютным путям, поэтому `..` и симлинк-подобные
 * обходы в аргументе не проходят: `relative()` вернёт путь с `..`, и проверка падает.
 */
export function assertPathInsideWorkspace(targetPath: string, workspacePath: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, targetPath);
  const relativePath = relative(root, target);
  const outside =
    relativePath === "" ? false : relativePath.startsWith("..") || isAbsolute(relativePath);
  if (outside) {
    throw new Error(
      `Файловая операция вне workspace запрещена: ${targetPath} (workspace: ${root})`,
    );
  }
  return target;
}

function locatorFor(page: Page, selector: string): Locator {
  return page.locator(selector);
}

function modifiers(
  values?: BrowserPlaywrightModifier[],
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  return (values ?? []).map((value) =>
    value === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : value,
  );
}

export async function evaluatePage(
  page: Page,
  expression: string,
  expressionKind: "string" | "function",
  arg: unknown,
  budgetMs: number,
): Promise<unknown> {
  const client = await page.context().newCDPSession(page);
  try {
    const source =
      expressionKind === "function" ? `(${expression})(${JSON.stringify(arg)})` : expression;
    const raw = (await client.send("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      timeout: budgetMs,
    })) as {
      exceptionDetails?: { exception?: { description?: string }; text?: string };
      result?: { value?: unknown };
    };
    if (raw.exceptionDetails) {
      const message =
        raw.exceptionDetails.exception?.description ??
        raw.exceptionDetails.text ??
        "Playwright evaluate failed";
      throw new Error(`playwright.evaluate failed: ${message}`);
    }
    return raw.result?.value;
  } finally {
    await client.detach().catch(() => undefined);
  }
}

async function runLocatorAction(
  page: Page,
  action: Extract<BrowserPlaywrightAction, { name: "locator" }>,
): Promise<unknown> {
  const locator = locatorFor(page, action.selector);
  const timeout = timeoutMs(action.timeoutMs);
  switch (action.operation) {
    case "allTextContents":
      return await locator.allTextContents();
    case "count":
      return await locator.count();
    case "getAttribute":
      return await locator.getAttribute(action.attribute ?? "", { timeout });
    case "innerText":
      return await locator.innerText({ timeout });
    case "isEnabled":
      return await locator.isEnabled({ timeout });
    case "isVisible":
      return await locator.isVisible();
    case "textContent":
      return await locator.textContent({ timeout });
    case "click":
      await locator.click({
        button: action.button,
        force: action.force,
        modifiers: modifiers(action.modifiers),
        timeout,
      });
      return undefined;
    case "dblclick":
      await locator.dblclick({
        button: action.button,
        force: action.force,
        modifiers: modifiers(action.modifiers),
        timeout,
      });
      return undefined;
    case "fill":
      if (action.replace === false)
        await locator.pressSequentially(String(action.value ?? ""), { timeout });
      else await locator.fill(String(action.value ?? ""), { timeout });
      return undefined;
    case "press":
      await locator.press(String(action.value ?? ""), { timeout });
      return undefined;
    case "selectOption": {
      const selections = (action.selections ?? []).map((selection) =>
        selection.index !== undefined
          ? { index: selection.index }
          : selection.label !== undefined
            ? { label: selection.label }
            : { value: selection.value ?? "" },
      );
      await locator.selectOption(selections, { timeout });
      return undefined;
    }
    case "setChecked":
      await locator.setChecked(action.checked ?? true, { force: action.force, timeout });
      return undefined;
    case "waitFor":
      await locator.waitFor({ state: action.state ?? "visible", timeout });
      return undefined;
    case "downloadMedia":
    case "evaluate":
      throw new Error(`Playwright locator operation '${action.operation}' is unavailable`);
  }
}

export async function executeManagedPlaywrightAction(
  page: Page,
  action: BrowserPlaywrightAction,
  context: ManagedPlaywrightContext = {},
): Promise<PartialResult> {
  switch (action.name) {
    case "domSnapshot":
      return {
        ok: true,
        value: await page.locator("html").ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS }),
      };
    case "elementInfo":
      return {
        ok: true,
        value: await page.evaluate(
          ({ x, y, includeNonInteractable }) =>
            document
              .elementsFromPoint(x, y)
              .filter(
                (element) =>
                  includeNonInteractable ||
                  element.matches("a,button,input,select,textarea,[role],[tabindex]"),
              )
              .map((element) => {
                const rect = element.getBoundingClientRect();
                const text = (
                  (element as HTMLElement).innerText ||
                  element.textContent ||
                  ""
                ).trim();
                return {
                  tagName: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  visibleText: text || null,
                  ariaName: element.getAttribute("aria-label") || text || null,
                  testId: element.getAttribute("data-testid"),
                  boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  preview: element.outerHTML.slice(0, 300),
                  selector: {
                    primary: element.id ? `#${element.id}` : element.tagName.toLowerCase(),
                    candidates: [],
                  },
                };
              }),
          action,
        ),
      };
    case "elementScreenshot": {
      const markerAttribute = "data-zcode-element-screenshot";
      const count = await page.evaluate(
        ({ x, y, includeNonInteractable, markerAttribute }) => {
          const elements = document
            .elementsFromPoint(x, y)
            .filter(
              (element) =>
                includeNonInteractable ||
                element.matches("a,button,input,select,textarea,[role],[tabindex]"),
            );
          let marked = 0;
          for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const marker = document.createElement("div");
            marker.setAttribute(markerAttribute, "");
            Object.assign(marker.style, {
              border: "2px solid #ff2d55",
              boxSizing: "border-box",
              height: `${rect.height}px`,
              left: `${rect.left}px`,
              pointerEvents: "none",
              position: "fixed",
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              zIndex: "2147483647",
            });
            document.documentElement.append(marker);
            marked += 1;
          }
          return marked;
        },
        { ...action, markerAttribute },
      );
      if (count === 0) throw new Error("No matching element was found at the requested point");
      try {
        const image = await page.screenshot({ type: "png" });
        return { ok: true, image: { base64: image.toString("base64"), mimeType: "image/png" } };
      } finally {
        await page
          .evaluate(
            (attribute) =>
              document.querySelectorAll(`[${attribute}]`).forEach((element) => element.remove()),
            markerAttribute,
          )
          .catch(() => undefined);
      }
    }
    case "evaluate":
      return {
        ok: true,
        value: await evaluatePage(
          page,
          action.expression,
          action.expressionKind,
          action.arg,
          timeoutMs(action.timeoutMs),
        ),
      };
    case "waitForLoadState":
      if ((action.state ?? "load") === "networkidle") {
        throw new Error("playwright_wait_for_load_state does not support networkidle");
      }
      await page.waitForLoadState(action.state ?? "load", { timeout: timeoutMs(action.timeoutMs) });
      return { ok: true };
    case "waitForURL":
      if (action.waitUntil === "networkidle") {
        throw new Error("playwright_wait_for_url does not support networkidle");
      }
      await page.waitForURL(action.url, {
        timeout: timeoutMs(action.timeoutMs),
        waitUntil: action.waitUntil ?? "load",
      });
      return { ok: true };
    case "locator": {
      const value = await runLocatorAction(page, action);
      return value === undefined ? { ok: true } : { ok: true, value };
    }
    /**
     * `waitForEvent` реально ждёт download/filechooser и кэширует полученный объект.
     * Кэш нужен, потому что `downloadPath`/`fileChooserSetFiles` вызываются отдельной
     * командой уже после события; без него объект был бы потерян.
     */
    case "waitForEvent": {
      const timeout = timeoutMs(action.timeoutMs);
      if (action.event === "download") {
        const download = await page.waitForEvent("download", { timeout });
        downloads.set(download.url() || `download:${downloads.size + 1}`, download);
        return {
          ok: true,
          value: {
            suggestedFilename: download.suggestedFilename(),
            url: download.url(),
          },
        };
      }
      const chooser = await page.waitForEvent("filechooser", { timeout });
      const chooserId = `filechooser:${fileChoosers.size + 1}`;
      fileChoosers.set(chooserId, chooser);
      return { ok: true, value: { fileChooserId: chooserId, multiple: chooser.isMultiple() } };
    }
    case "downloadPath": {
      const download = downloads.get(action.downloadId);
      if (!download) {
        throw new Error(
          `Download '${action.downloadId}' неизвестен. Сначала вызовите waitForEvent({ event: "download" }) и передайте полученный downloadId.`,
        );
      }
      // Скачивание за пределы workspace запрещено: путь валидируется до записи файла.
      const workspacePath = context.workspacePath;
      if (!workspacePath) {
        throw new Error(
          "Скачивание требует workspacePath: сохранять файлы вне workspace небезопасно.",
        );
      }
      const target = assertPathInsideWorkspace(download.suggestedFilename(), workspacePath);
      await download.saveAs(target);
      const failure = await download.failure();
      if (failure) throw new Error(`Скачивание не удалось: ${failure}`);
      return { ok: true, value: { path: target } };
    }
    case "fileChooserSetFiles": {
      const chooser = fileChoosers.get(action.fileChooserId);
      if (!chooser) {
        throw new Error(
          `FileChooser '${action.fileChooserId}' неизвестен. Сначала вызовите waitForEvent({ event: "filechooser" }).`,
        );
      }
      const workspacePath = context.workspacePath;
      if (!workspacePath) {
        throw new Error(
          "Загрузка файлов требует workspacePath: читать файлы вне workspace небезопасно.",
        );
      }
      // Каждый путь валидируется отдельно: один внешний файл не должен протащить остальные.
      const files = action.files.map((file) => assertPathInsideWorkspace(file, workspacePath));
      await chooser.setFiles(files, { timeout: timeoutMs(action.timeoutMs) });
      return { ok: true, value: { count: files.length } };
    }
  }
}

/** Снимает кэш скачиваний/chooser'ов. Вызывается при закрытии сессии/контекста. */
export function releaseManagedPlaywrightResources(): void {
  downloads.clear();
  fileChoosers.clear();
}
