/**
 * Интеграционные тесты stateful Playwright-контроллера и телеметрии.
 *
 * Тесты поднимают реальный `http.createServer` и запускают настоящий Chromium через
 * `playwright-core` (managed CDP). Моков нет: проверяются фактические console/pageerror/
 * HTTP-события и переиспользование BrowserContext между вызовами инструмента.
 *
 * Если Chromium в кэше отсутствует, тесты честно пропускаются с точной причиной —
 * подмены реального браузера фейком нет.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserRuntimeUnavailableError,
  createManagedCdpBrowserRuntime,
} from "../src/browser/index.js";
import { assertPathInsideWorkspace } from "../src/browser/playwright-command.js";

const chromiumExecutable = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require("playwright-core") as {
      chromium: { executablePath(): string };
    };
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();

const browsersInstalled = Boolean(chromiumExecutable && existsSync(chromiumExecutable));

const PAGE_HTML = `<!doctype html>
<html><head><title>Telemetry fixture</title></head>
<body>
  <main>
    <h1 id="heading">Telemetry fixture</h1>
    <button id="log" onclick="console.log('clicked-log')">log</button>
    <button id="warn" onclick="console.warn('clicked-warn')">warn</button>
    <button id="err" onclick="console.error('clicked-error')">error</button>
    <button id="throw" onclick="setTimeout(() => { throw new Error('boom-pageerror'); }, 0)">throw</button>
    <button id="fetch500" onclick="fetch('/broken').catch(() => {})">500</button>
    <input id="file" type="file" />
  </main>
</body></html>`;

describe.runIf(browsersInstalled)("managed CDP telemetry", () => {
  let server: Server;
  let baseUrl: string;
  let runtime: ReturnType<typeof createManagedCdpBrowserRuntime>;
  let descriptor: { id: string; generation: number };

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/broken") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "backend exploded" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    runtime = createManagedCdpBrowserRuntime({ executablePath: chromiumExecutable });
    const [first] = await runtime.browserControlPort.list({ sessionId: "telemetry-session" });
    descriptor = { id: first!.id, generation: first!.generation };
    const opened = await runtime.browserControlPort.execute({
      browserId: descriptor.id,
      browserGeneration: descriptor.generation,
      sessionId: "telemetry-session",
      command: { method: "newTab" },
    });
    expect(opened.ok).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await runtime?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const run = (command: Parameters<typeof runtime.browserControlPort.execute>[0]["command"]) =>
    runtime.browserControlPort.execute({
      browserId: descriptor.id,
      browserGeneration: descriptor.generation,
      sessionId: "telemetry-session",
      command,
    });

  it("собирает ARIA/DOM и остаётся здоровым на обычной навигации", async () => {
    const result = await run({ method: "navigate", url: baseUrl });
    expect(result.ok).toBe(true);
    const observation = result.observation;
    expect(observation).toBeDefined();
    expect(observation!.url).toContain("127.0.0.1");
    expect(observation!.title).toBe("Telemetry fixture");
    expect(observation!.ariaSnapshotCompact).toContain("Telemetry fixture");
    expect(observation!.dom?.some((node) => node.tag === "button")).toBe(true);
    expect(observation!.healthy).toBe(true);
    expect(observation!.truncation.console).toBe(false);
  });

  it("перехватывает console.error и pageerror от реального клика", async () => {
    await run({ method: "navigate", url: baseUrl });
    const clicked = await run({ method: "click", x: 10, y: 120 });
    expect(clicked.ok).toBe(true);
    // Ловим ошибку именно после действия, а не из предыдущего окна.
    const afterError = await run({
      method: "evaluate",
      expression: "document.getElementById('err').click(); 'done'",
    });
    expect(afterError.observation?.consoleEntries.some((entry) => entry.level === "error")).toBe(
      true,
    );
    expect(afterError.observation?.healthy).toBe(false);

    const afterThrow = await run({
      method: "evaluate",
      expression: "document.getElementById('throw').click(); 'done'",
    });
    // pageerror приходит асинхронно; ждём кадр событий перед снятием наблюдения.
    const afterWait = await run({ method: "playwrightWaitForTimeout", timeoutMs: 150 });
    const errors = [
      ...(afterThrow.observation?.pageErrors ?? []),
      ...(afterWait.observation?.pageErrors ?? []),
    ];
    expect(errors.some((error) => error.message.includes("boom-pageerror"))).toBe(true);
  });

  it("фиксирует HTTP 500 с телом ответа и прикладывает кадр", async () => {
    await run({ method: "navigate", url: baseUrl });
    const result = await run({
      method: "evaluate",
      expression: "document.getElementById('fetch500').click(); 'started'",
    });
    const waited = await run({ method: "playwrightWaitForTimeout", timeoutMs: 400 });
    const failures = [
      ...(result.observation?.failedRequests ?? []),
      ...(waited.observation?.failedRequests ?? []),
    ];
    const httpError = failures.find((entry) => entry.kind === "http_error");
    expect(httpError?.statusOrError).toBe("500");
    expect(httpError?.url).toContain("/broken");
    expect(httpError?.responseSnippet).toContain("backend exploded");
    // Нездоровое наблюдение прикладывает кадр по умолчанию.
    const unhealthy = [result.observation, waited.observation].find((item) => item?.healthy === false);
    expect(unhealthy?.screenshotBase64).toBeTruthy();
    expect(unhealthy?.screenshotMimeType).toBe("image/jpeg");
  });

  it("переиспользует BrowserContext между вызовами (stateful, без холодного импорта)", async () => {
    await run({ method: "navigate", url: baseUrl });
    await run({ method: "evaluate", expression: "window.__marker = 'kept'; 'ok'" });
    const second = await run({ method: "evaluate", expression: "window.__marker" });
    expect(second.value).toBe("kept");
    // Тот же backend identity: generator не увеличился, контекст не пересоздавался.
    expect(second.meta?.browserGeneration).toBe(descriptor.generation);
  });

  it("блокирует недопустимые схемы навигации", async () => {
    const file = await run({ method: "navigate", url: "file:///etc/passwd" });
    expect(file).toMatchObject({ ok: false, error: { code: "navigation_blocked" } });
    const js = await run({ method: "navigate", url: "javascript:alert(1)" });
    expect(js).toMatchObject({ ok: false, error: { code: "navigation_blocked" } });
    const data = await run({ method: "navigate", url: "data:text/html,hi" });
    expect(data).toMatchObject({ ok: false, error: { code: "navigation_blocked" } });
  });

  it("dispose освобождает контекст и делает порт непригодным", async () => {
    await runtime.close();
    const afterDispose = await runtime.browserControlPort
      .execute({
        browserId: descriptor.id,
        browserGeneration: descriptor.generation,
        sessionId: "telemetry-session",
        command: { method: "getState" },
      })
      .catch((error: unknown) => error);
    // После закрытия backend либо отвергает stale generation, либо бросает закрытием рантайма.
    expect(
      afterDispose instanceof Error ||
        (afterDispose as { ok?: boolean }).ok === false,
    ).toBe(true);
  });

  it("ограничивает загрузку файлов путями workspace", () => {
    const root = "/tmp/zcode-workspace";
    expect(() => assertPathInsideWorkspace("src/index.ts", root)).not.toThrow();
    expect(() => assertPathInsideWorkspace("../escape.txt", root)).toThrow(/вне workspace/u);
    expect(() => assertPathInsideWorkspace("/etc/passwd", root)).toThrow(/вне workspace/u);
  });
});

describe.skipIf(browsersInstalled)("managed CDP telemetry (пропуск)", () => {
  it.skip("Chromium не установлен: интеграционные тесты телеметрии недоступны", () => {
    // Причина: Playwright браузеры отсутствуют в кэше (~/.cache/ms-playwright).
    // Установка: pnpm exec playwright install chromium --with-deps
  });
});

describe("managed CDP: честная деградация без браузера", () => {
  it("execute возвращает структурированную ошибку browser_not_installed с инструкцией", async () => {
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: async () =>
        ({
          chromium: {
            // Путь заведомо отсутствует: resolveInstalledBrowserExecutable не найдёт
            // ни его, ни системных кандидатов на этой машине.
            executablePath: () => "/nonexistent/zcode-chromium-missing",
            launch: async () => {
              throw new Error("launch must not be called");
            },
          },
        }) as never,
    });
    // list не может вернуть backend без запуска браузера — это не ошибка, это пустой список.
    const descriptors = await runtime.browserControlPort.list({ sessionId: "missing" }).catch(
      () => [] as never[],
    );
    const result = await runtime.browserControlPort.execute({
      browserId: "cdp:unknown",
      browserGeneration: 1,
      sessionId: "missing",
      command: { method: "getState" },
    });
    // Без backend'а порт отказывает stale binding, но не падает.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_unavailable");
    expect(descriptors).toHaveLength(0);
    await runtime.close();
  });

  it("list бросает BrowserRuntimeUnavailableError с кодом browser_not_installed", async () => {
    const runtime = createManagedCdpBrowserRuntime({
      loadPlaywright: async () =>
        ({
          chromium: {
            executablePath: () => "/nonexistent/zcode-chromium-missing",
            launch: async () => {
              throw new Error("launch must not be called");
            },
          },
        }) as never,
    });
    const error = await runtime.browserControlPort
      .list({ sessionId: "missing" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserRuntimeUnavailableError);
    expect((error as BrowserRuntimeUnavailableError).code).toBe("browser_not_installed");
    expect((error as BrowserRuntimeUnavailableError).hint).toMatch(/playwright install/u);
    await runtime.close();
  });

  it("BrowserRuntimeUnavailableError несёт код и подсказку установки", () => {
    const error = new BrowserRuntimeUnavailableError(
      "browser_not_installed",
      "missing",
      "pnpm exec playwright install chromium",
    );
    expect(error.code).toBe("browser_not_installed");
    expect(error.hint).toContain("playwright install");
  });
});
