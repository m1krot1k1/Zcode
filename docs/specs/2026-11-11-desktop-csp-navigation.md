# Главное окно Desktop: CSP и navigation/popup guard

## Назначение

Закрыть класс атак «недоверенный документ получает native API окна»: главное окно
`packages/desktop/src/renderer/index.html` до этого change set не имело CSP, а
`BrowserWindow` главного окна не имел ни `will-navigate`, ни `setWindowOpenHandler`
(guard'ы существовали только для `<webview>` guest'ов). R07 требует:

1. restrictивный CSP для production-документа главного окна;
2. deny-by-default для `will-navigate` и `setWindowOpenHandler`, внешние ссылки — только
   через `shell.openExternal` из явного allowlist;
3. не ослаблять и не расширять guest/webview/plugin sandbox policy;
4. проверяемые unit-решения и наличие CSP.

Ссылки: `docs/research/2026-11-11-zcode-wide-competitive-research.md` §R07,
`packages/desktop/src/main/desktopWindowChrome.ts:591-614` (окно без guard'ов),
`packages/desktop/src/renderer/index.html` (0 CSP до change set).

## Владелец состояния и точки решения

- CSP — единственный владелец: статический `<meta http-equiv="Content-Security-Policy">`
  в `packages/desktop/src/renderer/index.html`. Причина meta, а не HTTP-заголовка:
  production грузит документ через `file://`, для которого Electron не даёт выставить
  CSP-заголовок (`docs/electron/docs/tutorial/security.md:406-411`).
- Navigation/popup решения — единственный владелец
  `packages/desktop/src/main/desktopWindowChrome.ts`:
  `resolveMainWindowNavigationDecision()` и `resolveMainWindowWindowOpenDecision()`.
  `createBrowserWindow()` только регистрирует обработчики и выполняет решения.
- Guest/webview/plugin sandbox policy не меняется: `will-attach-webview`,
  `did-attach-webview`, `attachEmbeddedBrowserWindowOpenHandler`,
  `pluginSandbox/guestPolicy.ts` и их allowlist'ы остаются единственной границей для
  встроенного браузера и плагинов. CSP главного окна не является второй политикой guest'ов.

## Доверенные origin'ы

| Окружение                              | Документ                                                                                               | Что разрешено как navigation                                                                                                                                              | Обоснование                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| production (`app.isPackaged === true`) | `file://…/out/renderer/index.html`                                                                     | только `file:` внутри каталога `out/renderer`                                                                                                                             | renderer-ассеты и `loadFile` живут в этом каталоге; любой другой документ не должен загружаться в окно с preload                              |
| development                            | `http://localhost:5174` / `127.0.0.1:5174` / `[::1]:5174` (Vite dev server из `ELECTRON_RENDERER_URL`) | только тот же `origin`, что и загруженный dev-сервер; при отсутствии `ELECTRON_RENDERER_URL` — только `file:` внутри `out/renderer` (тот же fallback, что в `loadWindow`) | HMR full reload и SPA-навигация остаются рабочими; production не наследует `ELECTRON_RENDERER_URL` (правило уже зафиксировано в `loadWindow`) |
| любой                                  | внешний `http:` / `https:`                                                                             | никогда в окне; `shell.openExternal`                                                                                                                                      | «внешняя ссылка открывается в системном браузере» из R07                                                                                      |
| любой                                  | прочие схемы (`javascript:`, `data:`, `file:` вне renderer, `about:`, неизвестные)                     | никогда и без `openExternal`                                                                                                                                              | неизвестная схема не должна ни грузиться в приложение, ни запускать обработчик ОС                                                             |

`ELECTRON_RENDERER_URL` учитывается только при `!app.isPackaged`; значение
нормализуется в `origin` (путь и query отбрасываются).

## CSP

Политика задана одной строкой в `index.html` (переносы строк в атрибуте допустимы, но
строка одна):

```text
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' file:;
style-src 'self' 'unsafe-inline' file:;
img-src 'self' data: blob: zcode-media: http: https: file:;
media-src 'self' data: blob: zcode-media: http: https: file:;
font-src 'self' data: file:;
connect-src 'self' http: https: file: blob: ws://localhost:5174 ws://127.0.0.1:5174 ws://[::1]:5174;
worker-src 'self' blob: file:;
object-src 'none';
base-uri 'none';
form-action 'self'
```

Решения и их обоснование (по фактам исходника):

1. **`script-src 'self'`** — единственный исполняемый скрипт production-документа —
   собранный bundle (`packages/desktop/out/renderer/index.html:107`); inline-скриптов в
   собранном HTML нет.
2. **`'unsafe-inline'` в `script-src`** — требование dev-режима: `@vitejs/plugin-react`
   добавляет inline module-preamble Fast Refresh
   (`node_modules/@vitejs/plugin-react/dist/index.js:176-182`). Этот hook не имеет
   `order: "pre"`, поэтому выполняется как normal-hook уже после `devHtmlHook`, который
   переписывает inline module-скрипты в `?html-proxy` URL
   (`node_modules/vite/dist/node/chunks/node.js:25151-25163,25260-25266`). Значит
   preamble остаётся inline и требует `'unsafe-inline'`. В production build
   (`command === "build"`) preamble не инжектится
   (`plugin-react/dist/index.js:98`), и этот токен не используется ни одним легитимным
   скриптом. Поэтому production-сборка прогоняет страницу через плагин
   `zcode-production-csp` (`packages/desktop/scripts/production-csp.ts`), который
   вырезает `'unsafe-inline'` из `script-src` прямо в `transformIndexHtml`; dev-режим
   сохраняет токен для Fast Refresh. Покрытие: `packages/desktop/test/productionCsp.test.ts`.
3. **`'wasm-unsafe-eval'`** — объективно требуется сборке: office-превью компилирует WASM
   (`@extend-ai/react-xlsx`/`react-docx`, `packages/ui/src/previewPaneOfficeXlsxContent.tsx`,
   `previewPaneOfficeLegacyDocContent.tsx`), diff-подсветка использует oniguruma WASM
   (`packages/ui/src/lib/diffsHighlighterEngine.ts:13`), pdf.js содержит WASM-декодеры.
   `'wasm-unsafe-eval'` разрешает только компиляцию WebAssembly и **не** разрешает `eval()`
   и `new Function()` с произвольным JS.
4. **`'unsafe-eval'` не добавлен**: в renderer-бандле нет исполняемого `new Function(`/`eval(`
   (проверено по `out/renderer/assets`: вхождения только в `.map` и в feature-detect
   `isEvalSupported()` pdf.js worker, который при отказе просто отключает eval-путь).
   Если будущая зависимость потребует eval, это отдельное решение с доказательством.
5. **`file:` в `script-src`/`style-src`/`font-src`/`worker-src`/`connect-src`** — документ
   production грузится как `file://`. CSP не умеет ограничивать `file:` конкретным
   каталогом: `file:` разрешает схему целиком, а containment внутри `out/renderer`
   обеспечивает navigation guard в main. Формулировка осознанно фиксирует это разделение:
   CSP ограничивает схемы/источники, guard — конкретный документ.
6. **`connect-src` с `http:`/`https:`** — renderer легитимно обращается к
   пользовательским endpoint'ам: MCP-проба (`packages/ui/src/lib/mcpStatusProbe.ts:51`),
   скачивание изображений (`packages/ui/src/components/ai-elements/image-preview-dialog.tsx:125`),
   share/cloud-content. Сузить нельзя без переноса этих запросов в Host (вне scope).
7. **`ws://localhost:5174` / `ws://127.0.0.1:5174` / `ws://[::1]:5174`** — dev-only HMR
   WebSocket: Vite слушает `port: 5174, strictPort: true`
   (`packages/desktop/vite.config.ts:213`), dev-скрипт пробует ровно эти три loopback-адреса
   (`packages/desktop/scripts/dev.mjs:89`). В production эти origin'ы не используются.
8. **`object-src 'none'`, `base-uri 'none'`, `form-action 'self'`** — блокируют плагины/embed,
   подмену base и отправку форм на чужой origin; в UI формы отправляются через `onSubmit`
   без `action`, навигация формы ограничена собственным origin.
9. **Нет `default-src`/`frame-src`/`child-src`**: главное окно содержит `<webview>`
   встроенного браузера и сторонние iframe (cloud-content/marketing). Политика guest'ов уже
   реализована в main (`will-attach-webview` + guest-navigation allowlist); включение
   `default-src 'none'` или узкого `frame-src` рискует сломать встроенный браузер и не
   является границей для guest'ов. Это сознательное решение, а не забытая директива.
   `frame-ancestors` в meta не поддерживается и потому не указывается.

CSP применяется только к документу главного окна. `plugin-sandbox.html`,
`resource-manager.html`, `cua-permission-panel.html` и guest-документы сохраняют
собственные политики.

## Порядок событий

```text
createBrowserWindow()
  └─ new BrowserWindow(...)                       // webPreferences не меняются
  └─ webContents.setWindowOpenHandler(handler)    // всегда { action: "deny" }
  └─ webContents.on("will-navigate", handler)     // регистрация до loadWindow
  └─ loadWindow(...)                              // programmatic loadURL/loadFile не эмитит will-navigate

renderer-initiated navigation (click / location / reload)
  → will-navigate
     → resolveMainWindowNavigationDecision(url)
        allow        → навигация продолжается (same file:// renderer / same dev origin)
        deny+external→ event.preventDefault(); shell.openExternal(http(s))
        deny         → event.preventDefault(); logger.warn (схема не запускается)
  → will-redirect (server 30x)
     → только main frame (isMainFrame !== false); тот же resolveMainWindowNavigationDecision()

window.open / target=_blank
  → setWindowOpenHandler(details)
     http(s)  → { action: "deny" } + shell.openExternal(url)
     иначе    → { action: "deny" } + logger.warn
```

Свойства:

- `setWindowOpenHandler` всегда возвращает `deny`, поэтому второй `BrowserWindow` из
  renderer-документа не создаётся ни при каких URL.
- `will-navigate` не эмитится для программного `loadURL`/`loadFile`/`back`, поэтому
  начальная загрузка окна не зависит от guard'а; `will-redirect` закрывает 30x, который
  `will-navigate` не покрывает.
- `shell.openExternal` вызывается только для `http:`/`https:` и только после
  `preventDefault()`; ошибка открытия логируется, навигация в окне уже отменена.

## Критерии приёмки

1. `packages/desktop/test/desktopMainWindowPolicy.test.ts`:
   - `resolveMainWindowNavigationDecision` разрешает `file:`-файл внутри renderer-каталога;
   - разрешает URL с тем же `origin`, что и dev-сервер;
   - запрещает `https://example.com`, `javascript:`, `data:`, `file:` вне renderer и
     возвращает `openExternal: true` только для http(s);
   - `resolveMainWindowWindowOpenDecision` всегда `deny`, `openExternal: true` только для
     http(s), для `file:`/`javascript:`/`mailto:`/неизвестных схем — `false`.
2. `createBrowserWindow` регистрирует `setWindowOpenHandler`, `will-navigate` и
   `will-redirect`; внешний http(s)-popup не создаёт новое окно и уходит в
   `shell.openExternal`; внешняя main-frame навигация блокируется с `preventDefault`,
   subframe-redirect не блокируется.
3. CSP присутствует в исходном `packages/desktop/src/renderer/index.html` (тест читает
   источник; собранный HTML наследует ту же meta через Vite): проверяется наличие всех
   директив, отсутствие `'unsafe-eval'` и wildcard `*`.
4. Dev smoke: Vite HMR (inline preamble + ws на 5174) не ломается. Production smoke:
   bundle грузится при `script-src 'self' … file:`.
5. Guest/webview/plugin sandbox тесты не меняются и остаются зелёными.

## Проверка

Узкие проверки (без full test/E2E/packaging):

```bash
pnpm exec vitest run packages/desktop/test/desktopMainWindowPolicy.test.ts
pnpm exec vitest run packages/desktop/test/desktopWindowChrome.test.ts
pnpm --filter @zcode/desktop exec tsc -p tsconfig.main.json --noEmit
```

## Остаточные работы и границы

- Убрать `'unsafe-inline'` из `script-src` можно только добавив nonce/hash для
  dev-preamble (`vite.config.ts` → `html.cspNonce`), это вне данного change set.
- `frame-src`/`child-src` сознательно не заданы: граница `<webview>` — guest policy в main.
- Переход desktop с `file://` на привилегированную схему (`app://`) не входит в R07.
- Electron runtime smoke (dev HMR и production bundle) в этой сессии не выполнялся —
  см. отчёт задачи.
