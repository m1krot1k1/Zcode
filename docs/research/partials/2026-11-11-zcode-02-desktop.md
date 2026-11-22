# Z02 — packages/desktop: карта подсистемы, риски и рекомендации

Дата исследования: 2026-11-11. Ветка: `dev`. HEAD: `d10f0b69 Выпустить macOS Preview 3.17.102.`
Режим: read-only, кроме этого partial-файла. Продакшн-код, конфиги и lockfile не изменялись; коммитов нет.

## 1. Scope and method

**Вопрос.** Что фактически реализует `packages/desktop`: границы main/preload/renderer/host, жизненный цикл Electron, IPC-поверхность и границы доверия, транспорт к Agent, обновления и упаковку, кросс-платформенные ветки и покрытие тестами. Где находятся подтверждённые слабые места.

**Границы.** В фокусе `packages/desktop` целиком (`src/main`, `src/host`, `src/preload`, `src/renderer`, `src/scheduler`, `src/shared`, `test`, `scripts`, `electron-builder.config.js`). `packages/services`, `packages/rpc`, `packages/client`, `packages/ui` читались только как владельцы смежных контрактов (stdio-транспорт, MessagePort RPC, UI-поверхности); их внутренняя инвентаризация не выполнялась. Спецификации `docs/desktop/*`, `docs/testing/*`, `docs/web-remote-control/*` использованы как заявленные инварианты и отделены от кода.

**Метод.**
1. Зафиксирован baseline: `git status --short` → `?? docs/research/`; `git branch --show-current` → `dev`; `git log -1 --oneline` → `d10f0b69 Выпустить macOS Preview 3.17.102.`
2. `node scripts/check-workspace-freshness.mjs` → `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）`, exit 0.
3. CodeIndex `status` → `ready`, `partial: false`, generation 1453, 10007 files / 26791 chunks; в `diagnostics` — `Embedding search is unavailable; showing lexical results.`
4. Инвентаризация: `find`, `wc -l`, `rg -c`, точечные `awk`-подсчёты по `packages/shared/src/channels.ts`.
5. Чтение исходников через `nl -ba`/`sed -n`; `codeIndex` не использовался для вывода фактов, потому что все ключевые факты проверены по тексту файлов (index — только указатель на области).
6. Два узких прогона Vitest (5 файлов, 76 тестов, оба exit 0); полный suite, typecheck, lint и Electron-запуск не выполнялись (запрещено envelope).
7. Изучен последний локальный E2E-артефакт `.e2e-artifacts/desktop-e2e-20261109085638661-p5091-abaca2a3fc72deec/` (наблюдаемый, но исторический прогон 2026-11-09, не текущая ревизия).

**Метки доказательств.** OBSERVED — прочитано в исходнике либо получено командой. INFERRED — вывод из кода/документации без runtime-проверки. UNKNOWN — источники не дают ответа.

**Ограничения.** Не запускались `pnpm typecheck`, `pnpm lint`, полный `pnpm test`, Electron/WebDriver, сборка и подпись. Не проверены реальные Windows/Linux-сборки и нотаризация. Не аудировались все 118 IPC-обработчиков построчно; выводы по ним основаны на выборочном чтении и подсчётах. Локальный E2E-артефакт относится к ревизии от 2026-11-09 и не доказывает состояние HEAD.

## 2. Coverage table

| Поверхность | Файлы | Доказательство | Покрытие |
|---|---|---|---|
| Пакет, скрипты, зависимости | `packages/desktop/package.json` | `:7` main `out/main/index.js`; `:13-52` dev/build/bundle/e2e-скрипты; `:80` `electron-updater ^6.8.3`; `:84` `playwright-core 1.59.1`; `:115` `electron 41.0.3`; `:116` `electron-builder ^26.8.1`; `:128` productName ZCode | OBSERVED |
| Границы сборки | `tsconfig.{main,host,preload,renderer,scheduler,e2e}.json`; `tsup.config.ts`; `vite.config.ts` | `tsconfig.main.json:12` include `src/main,src/shared,src/scheduler`; `tsconfig.host.json:8` include `src/host`; `tsup.config.ts:267-429` — 5 конфигов (main ESM/node22, preload CJS, plugin-sandbox IIFE, host ESM, scheduler ESM); `vite.config.ts:196` root `src/renderer`, `:213` port 5174 strict | OBSERVED |
| Размер подсистемы | `src/main`, `src/host`, `src/preload`, `src/renderer`, `src/scheduler` | `find`+`wc`: main 245 файлов / 58 318 строк; host 73 / 17 500; preload 14 / 1 789; renderer 25 / 2 290; scheduler 6 / 822; shared 3 / 218; в `src/main` 173 файла верхнего уровня и 6 подкаталогов | OBSERVED |
| Main lifecycle | `src/main/index.ts` (2 653 строки) | `:295-308` `app.setName`/`setPath`; `:1989-2010` `open-url`; `:2011-2014` single-instance lock; `:2015-2049` `second-instance`; `:2051` `whenReady`; `:2599-2606` `window-all-closed`; `:2607-2650` `before-quit`; `:2651-2653` `activate` | OBSERVED, unit-тестами entry не покрыт (см. ниже) |
| Окна и chrome | `desktopWindowLifecycle.ts` (475), `desktopWindowChrome.ts`, `primaryWindowCoordinator.ts` (101) | `desktopWindowLifecycle.ts:30-98` создание; `:135-287` dom-ready/reload/closed; `desktopWindowChrome.ts:591-614` `new BrowserWindow`; `:664-769` hardening `<webview>` | OBSERVED; `desktop/test/desktopWindowLifecycle.test.ts` (19) и `desktopWindowChrome.test.ts` (33) прошли |
| Host process | `src/host/index.ts` (4 158 строк, 42 функции верхнего уровня), `desktopHostProcess.ts` (769) | `host/index.ts:1-16` модель «один Host на окно»; `:3636-3684` attach/detach; `:3690-3982` InitLocal; `:3190-3195` Dispose; `desktopHostProcess.ts:251-273` fork; `:647-664` exit cleanup | OBSERVED; `desktopHostProcess.test.ts` (10) прошёл |
| Привязки/скоупы | `windowHostAttachmentRegistry.ts` (169), `windowHostAttachmentRpcPolicy.ts`, `hostMessagePortGuard.ts` | `windowHostAttachmentRegistry.ts:47-93` map по attachmentId + замена предыдущего; `:104-145` detach по generation/session; `windowHostAttachmentRpcPolicy.ts:16-80` fail-closed allowlist для `web-remote-replayable` | OBSERVED; `windowHostAttachmentRegistry.test.ts` (10) прошёл |
| stdio к Agent | `packages/services/src/zcode-agent/*` | `zcodeAgentProcessManager.ts:443-469` resolver (env → repo dist → Electron Node → native binary); `:417-441` `ELECTRON_RUN_AS_NODE`; `zcodeStdioTransport.ts:35-96` LF-фреймы; `:98-190` EOF + process-tree terminate | OBSERVED; вне scope пакета, но это фактический транспорт Host→Agent |
| IPC-протокол | `packages/shared/src/channels.ts` | `:202-524` `PlatformChannels` (154 записи); `:91-201` `ServiceChannels` (58); `:583-598` `InternalChannels` (8); `:610-670` `HostMessageTypes` (31); `:673-772` `HostResponseTypes` (78); `:779+` типизированный `PlatformChannelMap` | OBSERVED |
| Preload bridge | `src/preload/index.ts` (1 049 строк) | `:934` `contextBridge.exposeInMainWorld("zcode", zcodeApi)`; 132 ключа в `zcodeApi`; `:29` `__ZCODE_DEVICE_ID__`; `:106-114` E2E-only namespace; `:943-965` transfer MessagePort; `pluginSandbox/hostBridge.ts:15-43` отдельный `zcodePluginSandbox` | OBSERVED |
| Renderer shell | `src/renderer/src/main.tsx` (391), `databaseStartupAdmission.ts` (31) | `main.tsx:50-64` launch marks; `:105-116` platform-классы; `:167-200` admission; `:275-317` message router; `:319-372` `initializeBusinessRoot`; `:380-391` update-status window | OBSERVED; UI-поверхности живут в `@zcode/ui` |
| desktop-continuous | preload + renderer + host attachment | `desktopWindowLifecycle.ts:160-167` `clientMode: "desktop-continuous"`, `scope:{kind:"local"}`; UI-выбор режима `packages/ui/src/Root.tsx:1001`, `useZCodeTaskService.ts:51` | OBSERVED (код), E2E — косвенно |
| Updates | `autoUpdater.ts` (2 148), `manifestUpdateProvider.ts`, `forceUpdateGuard.ts` | `autoUpdater.ts:26-27` poll 15 min / 2 min; `:1647-1651` `autoDownload=false`, `autoInstallOnAppQuit=false`; `:441-538` quitAndInstall state machine; `manifestUpdateProvider.ts:22,77-93` `/api/v1/releases/electron/manifest`; `forceUpdateGuard.ts:13-15,76-120` | OBSERVED; unit `autoUpdaterReadyState.test.ts`; E2E установки нет |
| Packaging / signing | `electron-builder.config.js` (1 038), `scripts/bundle.mjs`, `scripts/desktop-product-identity.mjs` | `:272-275` artifact naming; `:670-676` fuses только win32; `:904-912` protocol `zcode`; `:913-949` mac dmg+zip/hardenedRuntime/notarize/signIgnore; `:950-965` NSIS; `:966-1000` AppImage/deb/rpm/pacman; `:1028-1037` generic publish placeholder; `bundle.mjs:876-888` `--publish never` | OBSERVED |
| CI | `.github/workflows/cross-platform-preview-release.yml` | `:3-12` только `workflow_dispatch`; `:24-45` matrix macOS arm64 / Windows x64 / Linux x64; `:67-85` offline Preview build, `ZCODE_AUTO_UPDATE=0`, sign/notarize off; `:158-209` prerelease upload | OBSERVED; шагов test/lint/typecheck нет |
| Тесты (unit) | `test/*.test.ts`, `test/unit`, колокация | 358 файлов `test/*.test.ts`, 1 `test/unit`, 11 колокированных `src/**/*.test.ts`; 2 прогона, 76 тестов, exit 0 | OBSERVED |
| Тесты (E2E) | `test/e2e/**`, `wdio.conf.ts` (5 291) | 575 `*.test.ts`; 198 вне `manual-review`, 377 в `manual-review/pending`; `wdio.conf.ts:4743-4771` capabilities, `:4748-4755` `--no-sandbox`, `:4772-4786` specs/exclude, `:580-587` default glob | OBSERVED; полный E2E не запускался |

### 2.1 Проверенные и непроверенные desktop-пути

**Проверено (OBSERVED).**
- Обработка внешних URL в `<webview>`: allowlist протоколов, hardening `will-attach-webview`, popup/will-navigate для Coding Plan/PayPal — `desktopWindowChrome.ts:268-310`, `:377-500`, `:664-769`; тесты `desktopWindowChrome.test.ts` (33) прошли.
- Закрытие окна: macOS hide/exit-fullscreen, Windows/Linux close-to-tray с проверкой tray capability, подтверждение выхода последнего окна — `desktopWindowLifecycle.ts:107-126`, `:417-475`; 19 тестов прошли.
- Переиспользование существующего Host при renderer reload и fallback-пересоздание — `desktopWindowLifecycle.ts:146-189`; тест «renderer reload 复用已有 Host…» есть в `desktopWindowLifecycle.test.ts:219`.
- Bounded wait runtime env prewarm с fallback и защитой от второго Host — `desktopWindowLifecycle.ts:227-272`; тесты `:281`, `:344`.
- `disposeHostProcess`/`disposeHostProcessAndWait`: минимальная задержка 3.5 c, ожидание exit, идемпотентность — `desktopHostProcess.ts:669-769`; тесты `desktopHostProcess.test.ts:266-327`.
- Attachment registry: замена по attachmentId, очистка по close порта, stale generation detach — `windowHostAttachmentRegistry.ts:57-145`; 10 тестов прошли.
- URL-парсинг deep link (OAuth/payment/workspace/share, multi-decode, join argv) — `desktopDeepLinkUrl.ts:1-150`; `desktopDeepLinkUrl.test.ts`, `desktopSecondInstanceDeepLink.test.ts`, `startupWorkspaceDeepLinkGate.test.ts`.

**Не проверено (UNKNOWN / нет теста).**
- Реальная последовательность `app.whenReady` и `before-quit` barrier: ни один unit-тест не импортирует `src/main/index.ts` (только чтение файла как текста/фикстуры карты покрытия; см. §8).
- Single-instance lock, `second-instance`, macOS `open-url` на уровне приложения: тестируются только чистые helper-функции, не маршрутизация в окно.
- Установка обновления (скачивание, `quitAndInstall`, повторный вход после сбоя): только unit-модель `autoUpdaterReadyState.test.ts`; E2E нет. В `test/e2e/**` есть один `manual-review/pending` update-спек.
- Падение/перезапуск Host: unit-тесты проверяют cleanup сообщений, но не сценарий «Host умер → окно продолжает работать».
- Tray: E2E только `manual-review/pending/windows-tray-export-logs.test.ts`.
- Windows/Linux-поведение (AppImage, .desktop, WSL, AUMID) вне текущей машины; только unit-тесты helper-логики.
- Утечки `TaskRealtimeBus.streamBatches` на нетерминальных окончаниях run: тестов нет (см. §4).

## 3. Capability inventory

### 3.1 Границы и сборка

- OBSERVED. Пакет — ESM (`package.json:6`), `main` → `out/main/index.js` (`:7`). Отдельные tsconfig-проекты задают физические границы: main видит `src/main|shared|scheduler`, host — только `src/host`, preload — `src/preload` с DOM lib, renderer — `src/renderer` с references на `ui/client/preload` (`tsconfig.*.json:1-20`).
- OBSERVED. tsup собирает main/preload/host/scheduler раздельно; main и host инлайнят `@zcode/services|shared|rpc|client|provider|zcode-cua`, но оставляют `undici` внешним из-за dynamic require (`tsup.config.ts:280-301`, `:371-389`). Preload — CJS `.cjs`, `external: ["electron"]`, `noExternal: ["@zcode/shared"]` (`:313-340`).
- OBSERVED. Renderer — Vite SPA (`vite.config.ts:196-238`), dev-сервер на 5174, base `./`, build в `../../out/renderer` (`:238-248`). UI-поверхности (терминал, файловое дерево, редактор-ссылки, браузер) находятся в `packages/ui`; desktop renderer — тонкая оболочка (2 290 строк).
- OBSERVED. Скрипты: `pre-dev` чистит `out`, `dev` идёт через `scripts/dev-desktop-env.mjs`, `build` = runtime assets + production build, `test:e2e` — sharded Windows runner, `test:e2e:serial` — WDIO (`package.json:13-52`). `postinstall` пересобирает node-pty (`:50`).

### 3.2 Main process: жизненный цикл

- OBSERVED. Ранние side-effect импорты до `app.whenReady`: data-dir bootstrap, hardware-acceleration bootstrap, crash capture, ARMS init (`index.ts:1-16`). `app.setName`/`setPath(userData/sessionData)` выполняются до ready (`:295-308`); в dev включается фиксированный remote debugging port 9229, если E2E его не отключил (`:288-293`).
- OBSERVED. Crash capture инициализируется на импорте: `appCrashCaptureBootstrap.ts:6` → `initializeCrashCapture(logger, true)`; собственный `crashReporter.start` выполняется только если ARMS не включён (`desktopCrashCapture.ts:372-382`). Слушатели `render-process-gone`, `child-process-gone`, `unresponsive` регистрируются в `:412-457`; dmp архивируются с повторами (`:333-351`).
- OBSERVED. Single-instance lock: `app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv))`, при неудаче `app.quit()` (`index.ts:2011-2014`). Второй экземпляр передаёт deep link/workspace через `additionalData` и argv (`desktopSecondInstanceDeepLink.ts:38-63`), затем main фокусирует/восстанавливает существующее окно (`index.ts:2039-2048`).
- OBSERVED. Deep links: `zcode://workspace/open`, `zcode://oauth/callback`, `zcode://payment/callback`, `zcode://share/import` (`desktopDeepLinkUrl.ts:1-94`). Для workspace внешний путь сначала проверяется на network/UNC и только потом на `statSync` (`desktopOAuthDeepLink.ts:264-269`), подтверждение пользователю — до обращения к файловой системе (`:281-287`). Cold-start Finder/`open-url` буферизуется до создания окна (`index.ts:1997-2005`).
- OBSERVED. Протокол регистрируется до lock (`index.ts:1988`); Windows-регистрация добавляет `--` перед URL, чтобы URL не стал Electron-флагом (`desktopOAuthDeepLink.ts:407-432`); Linux AppImage дополнительно ставит `.desktop` с allowlist разрешённых аргументов (`desktopLinuxDeepLinkRegistration.ts:39-104`). Обработчика macOS `app.on("open-file")` нет (`rg "open-file" src/main` → пусто); открытие папок реализовано через Finder Services workflow, вызывающий `zcode://workspace/open` (`desktopFinderOpenFolderWorkflow.ts:16-28`).
- OBSERVED. `whenReady` — длинная последовательность: PATH login shell, request security diagnostics, media protocol, plugin sandbox host, browser restore protocol, чтение setting.json (dataBaseDir/locale/closeToTray migration/keep-awake/zoom/window size), database-startup quit hook, cron scheduler spawn после DB ready, Windows AUMID, иконка, Finder workflow, Windows context menu, network policy, embedded-browser permission policy, post-update notes, `initAutoUpdater`, menu/dock/tray, platform+remote IPC, await ARMS init, telemetry wiring, force-update gate, и только затем первое окно (`index.ts:2051-2573`).
- OBSERVED. Окно создаётся через single-flight `primaryWindowCoordinator.ensurePrimaryWindow` (`primaryWindowCoordinator.ts:60-96`): параллельные `activate`/`ready` схлопываются, окно с упавшим renderer уничтожается и создаётся заново (`:30-57`), force-update gate блокирует создание (`:61-65`).
- OBSERVED. Shutdown: `window-all-closed` завершает приложение кроме macOS (`index.ts:2599-2606`). `before-quit` сначала спрашивает подтверждение, затем при первом проходе блокирует выход и запускает `prepareAppQuit`: параллельно flushes telemetry/TTFT/action trace, dispose cron, remote sessions и всех Host через `disposeHostProcessAndWait` с политикой `normal|update-install` (`index.ts:1180-1268`). Политика: strict 7 500/9 000 мс, Windows normal 4 000/4 500 мс (`appShutdownPolicy.ts:14-34`). После подготовки выход привязывается к `closed` последнего окна, а не к повторному `app.quit()` (`index.ts:2618-2649`).

### 3.3 Окна, tray, меню, уведомления

- OBSERVED. Основное окно: `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: true`, zoom factor, `--device-id` в `additionalArguments` (`desktopWindowChrome.ts:591-613`). Платформенный chrome: macOS hidden titlebar + traffic lights + vibrancy; Windows frameless + acrylic + кастомные контролы; Linux прозрачный frameless без тени (`:139-171`). Для Windows есть обходной repaint после resize (`:230-266`).
- OBSERVED. `<webview>` hardening: preload принудительно заменяется на изолированный JS-dialog bridge, `contextIsolation=true`, `nodeIntegration=false`, `nodeIntegrationInSubFrames=true`, `sandbox=true`, `allowpopups` восстанавливается контролируемо, протоколы ограничены `about/data/http/https/zcode-browser-restore` (`desktopWindowChrome.ts:664-736`). Popup и `will-navigate` для Coding Plan/PayPal маршрутизируются по allowlist хостов (`:268-310`, `:377-500`).
- OBSERVED. Tray создаётся на Windows сразу, на Linux — только после capability probe (`index.ts:2243-2281`); без рабочего Tray close-to-tray отключается, чтобы не потерять окно (`desktopWindowLifecycle.ts:436-451`; `desktopTraySupport.ts`). Меню пересобирается при смене locale и при записи shortcut (`index.ts:2322-2358`; `desktopApplicationMenu.ts:61-110`, `:366-378`).
- OBSERVED. Уведомления: 3-секундный dedupe, отдельный ключ для permission/elicitation, максимум 100 активных, macOS focus restore, локализованный текст обязателен (`desktopNotifications.ts:6-121`).
- OBSERVED. Вспомогательные окна: update-status (`index.ts:1726-1770`), resource manager (`resourceManagerWindow.ts:263-285`), about (`about.ts:255-274`), force-update prompt (`forceUpdatePrompt.ts:502-528`), CUA-индикаторы/панели.

### 3.4 Host: жизненный цикл и транспорт

- OBSERVED. Контракт: один Host на окно; renderer и мобильный клиент attachment-ятся к одному Host; main отправляет `init-local` один раз (`host/index.ts:1-16`). Host запускается через `electronUtilityProcess.fork(hostModulePath)` с env из `buildHostProcessEnv`, E2E coverage env и macOS `ZCODE_CUA_LAUNCHER_PID` (`desktopHostProcess.ts:251-273`).
- OBSERVED. `InitLocal` создаёт `createHostDatabaseStartup`, ждёт готовности БД, затем собирает `createLocalServices` с `serviceAuthorityMode: "desktop-local"`, task realtime bridge, feedback, browser-control executor (`host/index.ts:3690-3982`). Attachment до готовности БД ставится в `pendingStartupAttachments` и активируется на `phase: "ready"` (`:3641-3648`, `:3711-3722`).
- OBSERVED. `AttachServicePort` валидирует scope: `web-remote-replayable` + `source-settings` отклоняется; remote scope ждёт generation barrier; ошибка закрывает переданный port (`host/index.ts:3636-3676`). `DetachServicePort` идемпотентен (`:3678-3684`).
- OBSERVED. Registry хранит attachment по `attachmentId`, при повторной привязке освобождает предыдущий, а по `close` порта освобождает себя; есть точечные detach по remoteSessionId/generation и sourceServerId (`windowHostAttachmentRegistry.ts:47-145`).
- OBSERVED. Политика экспозиции: для `web-remote-replayable` — явный allowlist `ServiceChannels` (`windowHostAttachmentRpcPolicy.ts:16-67`), для desktop — полный ServiceCollection (`:73-80`). В комментарии зафиксирован прошлый баг: denylist пропускал Terminal/PTY мобильному клиенту (`:73-79`).
- OBSERVED. Сообщения main→host валидируются Zod; при невалидном schema переданные порты закрываются (`hostMessagePortGuard.ts:20-31`), недоступный service port отклоняется (`:33-41`).
- OBSERVED. Host отвечает main по `parentPort`: DB startup state, structured logs, network telemetry/capture, agent process lifecycle, MCP/plugin/session telemetry, cron/off-peak results, browser execute requests, local media authorization, plugin sandbox registration (`desktopHostProcess.ts:299-597`). Main валидирует ответы `hostResponseMessageSchema` и игнорирует неизвестные (`:299-303`).
- OBSERVED. Остановка: `Dispose` → `disposeHostResources` → `process.exit(exitCode)` (`host/index.ts:3190-3195`). Очистка идемпотентна (`hasDisposedHostResources` + in-flight promise, `:2758-2770`), выполняется фазами с таймаутами: remote registry 6 c, source-server 2 c, services 3.5 c (`:2802-2830`). При потере родителя (`disconnect`) Host сам завершается после очистки (`:2910-2913`); фатальный `uncaughtException` тоже идёт через cleanup (`:2919-2943`).
- OBSERVED. Со стороны main `disposeHostProcess` отправляет `Dispose`, но не убивает Host раньше `max(forceKillDelayMs, 3500)` мс, чтобы успел отработать SIGTERM/SIGKILL процессного дерева Agent (`desktopHostProcess.ts:669-713`). `disposeHostProcessAndWait` корректно обрабатывает кейс Electron UtilityProcess без `exitCode` (`:727-769`).
- OBSERVED. Транспорт Host→Agent — stdio `app-server --stdio`. В упакованном desktop резолвер использует `process.execPath` (Electron Node) + `resources/glm/zcode.cjs` с `ELECTRON_RUN_AS_NODE=1` (`zcodeAgentProcessManager.ts:417-441`); в репозитории — dist/tsx (`:358-394`); переменные `ZCODE_AGENT_SERVER_COMMAND/ARGS_JSON/CWD` имеют приоритет (`:443-456`). Фрейминг — только LF, backpressure через колбэк `stdin.write`, закрытие — EOF с ожиданием 1.8 c, затем snapshot+terminate process tree (`zcodeStdioTransport.ts:62-110`, `:129-190`).

### 3.5 IPC и границы доверия

- OBSERVED. Каналы централизованы: 154 `PlatformChannels`, 58 `ServiceChannels`, 8 `InternalChannels`, 31 `HostMessageTypes`, 78 `HostResponseTypes` (`packages/shared/src/channels.ts:91-772`); для PlatformChannels есть типизированная карта request/response (`:779+`).
- OBSERVED. В `packages/desktop/src` зарегистрировано 88 `ipcMain.handle` и 30 `ipcMain.on` (без тестов). Основная масса — `desktopMainIpcPlatform.ts` (33 handle) и `desktopMainIpcRemote.ts` (16+ handle).
- OBSERVED. Preload выставляет один объект `window.zcode` из 132 методов (`preload/index.ts:264-934`) и отдельные namespaces: `__ZCODE_DEVICE_ID__` (`:29`), E2E-only `__zcodeFinalArmsCustomEventsE2E` (`:106-114`), `zcodePluginSandbox` (`pluginSandbox/hostBridge.ts:15-43`). MessagePort не идёт через contextBridge; он передаётся через `window.postMessage(..., [port])` (`preload/index.ts:938-965`).
- OBSERVED. Валидация в main: Zod-схемы для настроек, locale, логов, массивов путей, web-remote workspace targets (`desktopMainIpcPlatform.ts:6-26`, `:268-292`, `:338-349`); проверка известности `DesktopCommandId` (`desktopCommandIpc.ts:13-23`); allowlist протоколов для `openExternal` (http/https/file) (`desktopMainIpcRemote.ts:70-77`, `:329-343`); проверка `requestId` и отправителя при web-remote reconnect (`webRemoteControlRendererReconnect.ts:33-51`); owner-check для resource manager network (`resourceManagerNetwork.ts:107-116`).
- OBSERVED. `OpenExternalFile` и `OpenInFileManager` принимают произвольный путь без проверки отправителя (`desktopMainIpcRemote.ts:371-373`; `desktopMainIpcPlatform.ts:376-378`; реализация `desktopMainIpcHelpers.ts:28-90`). `ClearAllData` защищён только нативным диалогом `showMessageBox` и затем удаляет `~/.zcode/v2` (`desktopCommandHandlers.ts:83-119`, `:679-685`).
- OBSERVED. Настройки безопасности webPreferences: main-окно — `contextIsolation=true`, `nodeIntegration=false`, `webviewTag=true`, явного `sandbox` нет (`desktopWindowChrome.ts:602-613`); гостевые `<webview>` — `sandbox=true` и принудительный изолированный preload (`:706-709`); plugin-sandbox гость дополнительно фиксирует `webSecurity=true` (`pluginSandbox/guestPolicy.ts:45-55`). Вспомогательные окна: update-status `contextIsolation/nodeIntegration` заданы, `webviewTag=false`, `sandbox` не задан (`index.ts:1764-1770`); resource manager — без `sandbox` (`resourceManagerWindow.ts:271-275`); about/force-update/Windows CUA indicator — `sandbox: true` (`about.ts:269-273`; `forceUpdatePrompt.ts:526-528`; `windowsCuaOperationIndicator.ts:262-265`).
- OBSERVED. `app.enableSandbox()` нигде не вызывается; `contextIsolation:false`/`nodeIntegration:true` в `src` не встречаются. Официальная документация Electron: «Starting from Electron 20, the sandbox is enabled for renderer processes without any further configuration», а `nodeIntegration: true` отключает sandbox (загружено с electronjs.org, см. §8). Следовательно main-окно и resource manager в Electron 41 по умолчанию sandboxed — INFERRED из документации и отсутствия override.
- OBSERVED. Главное окно не имеет ни `will-navigate`/`will-frame-navigate`, ни `setWindowOpenHandler`, ни CSP meta в `src/renderer/index.html` (`rg "will-navigate|setWindowOpenHandler" src/main` даёт только `desktopWindowChrome.ts` для guest и recorder/plugin-sandbox; `index.html:1-190` без CSP). При этом в UI есть `target="_blank"`/`window.open`-ссылки (например `packages/ui/src/settings/McpRegistryMarketplace.tsx:354-362`, `packages/ui/src/v4/ConversationShareContent.tsx:92`, `packages/ui/src/feedback/TicketDetail.tsx:209-214`).
- OBSERVED. Electron fuses: только Windows отключает `enableNodeCliInspectArguments`; `runAsNode` остаётся (нужен Agent) (`electron-builder.config.js:670-676`); тест фиксирует именно это (`test/electronBuilderSecurity.test.ts:8-21`).

### 3.6 Renderer и desktop-continuous

- OBSERVED. Renderer до React: читает launch marks из query, ставит theme по localStorage, выставляет platform-классы по `navigator.userAgent`, читает флаги `restoreSession/supportsSettings/initialWorkspacePath/windowKind/locale` (`main.tsx:50-145`). `DatabaseStartupAdmission` принимает только пару «state(ready) + port» одного `startupId`, закрывает stale-порты и не смешивает поколения (`databaseStartupAdmission.ts:3-31`).
- OBSERVED. Первый бизнес-порт приходит из preload через `window.postMessage` transfer и подключается `connectViaMessagePort` → `RemoteServiceAccess` (`main.tsx:307-327`; `packages/client/src/messageport.ts:25-70`). После этого регистрируются base services и рендерится `Root` из `@zcode/ui` (`main.tsx:319-372`).
- OBSERVED. Remote workspace attachment: scoped port парсится Zod-схемой, при раннем приходе буферизуется до готовности base services, после регистрации отправляется `ScopedServicePortReady` (`main.tsx:222-260`, `:294-305`; `remoteWorkspaceServicePortBridge.ts:11-44`). Main подтверждает готовность по `sender.id` (`desktopMainIpcRemote.ts:282-296`).
- OBSERVED. `desktop-continuous` — режим локального desktop attachment: `clientMode` передаётся в `AttachServicePort` (`desktopWindowLifecycle.ts:160-165`), UI выбирает его для desktop и `web-remote-replayable` для remote (`packages/ui/src/Root.tsx:1001`, `:719`; `useZCodeTaskService.ts:51`). В host это влияет на политику экспозиции сервисов (`windowHostAttachmentRpcPolicy.ts:73-80`).
- OBSERVED. Переподключение renderer после reload: main не убивает Host, а создаёт новый `MessageChannelMain`, отправляет `AttachServicePort` и новый `ServicePort`, синхронизирует update state и reattach remote sessions (`desktopWindowLifecycle.ts:146-183`). Если привязка невозможна — Host убивается и создаётся заново (`:184-189`).
- OBSERVED. Web remote reconnect инициируется main→renderer с `requestId`, ожидает ответ только от нужного webContents и имеет timeout (`webRemoteControlRendererReconnect.ts:9-52`).
- OBSERVED. UI-поверхности: терминал (`packages/ui/src/Terminal.tsx`, `terminal/*`), файловое дерево (`packages/ui/src/workspace-file-tree/*`), diff/code viewer (`components/ui/diff-viewer.tsx`, `code-viewer.tsx`), встроенный браузер (`packages/desktop/src/main/browserView/*` + `packages/ui/src/browser-use/*`). Desktop renderer сам их не реализует — это соответствует границе «UI в `@zcode/ui`».

### 3.7 Обновления, упаковка, релиз

- OBSERVED. Новые клиенты используют серверный manifest `GET /api/v1/releases/electron/manifest` с `platform`, `device_mid`, `channel` (`manifestUpdateProvider.ts:22`, `:77-93`; `autoUpdater.ts:814-836`). Провайдер — `custom` c `ManifestUpdateProvider`; `publish` в electron-builder — только generic-заглушка `https://zcode.z.ai/updates` (`electron-builder.config.js:1028-1037`) и `useMultipleRangeRequest: false` для OSS/CDN.
- OBSERVED. Состояние обновления — явная машина: `autoDownload=false`, `autoInstallOnAppQuit=false`, ручное скачивание, отмена по `CancellationToken`, skip-version по каналам stable/preview, защита от stale-каналов, повторный download при восстановлении pending release notes (`autoUpdater.ts:441-538`, `:1620-1651`, `:1708-1783`). Установка сначала ждёт `onBeforeQuitAndInstall` (host/agent cleanup + Windows resource locks), затем вызывает `autoUpdater.quitAndInstall()`; при сбое подготовки — `app.relaunch()` (`:131-139`, `:491-538`).
- OBSERVED. Автообновление включается только при `ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED` (`index.ts:2211-2212`; `docs/desktop/build-time-optional-capabilities.md:5-11,35`). Preview-идентичность никогда не обновляется (`index.ts:2208-2210`).
- OBSERVED. Force-update gate до создания окна: `GET /api/v1/client/configs` c timeout 10 c и лимитом ответа 1 MiB, fail-open при сетевой ошибке, блокировка всех путей создания окна при `blocked` (`forceUpdateGuard.ts:13-15`, `:76-120`; `index.ts:2518-2543`; `primaryWindowCoordinator.ts:61-65`).
- OBSERVED. Упаковка: artifact name `productName-version-platform-arch{_TEST}.{ext}` (`electron-builder.config.js:272-275`); macOS dmg+zip, hardened runtime, notarize из `resolveMacReleaseBuildSettings`, entitlements, `signIgnore` для предподписанных `cua-helper/glm/tools` (`:913-949`); Windows NSIS + опциональный vsigntool hook + fuses (`:950-965`, `:670-676`); Linux AppImage/deb/rpm/pacman с явными зависимостями (`:966-1000`); DMG 3200m против усечения (`:1001-1006`); scheme `zcode` в `protocols` (`:904-912`).
- OBSERVED. Продуктовые идентичности: production `dev.zcode.app`/`ZCode`; preview `dev.zcode.app.preview`/`ZCode Preview`, отдельные Linux package names (`scripts/desktop-product-identity.mjs:8-31`). Flavor выводится из `ZCODE_ENV`/`ZCODE_PREVIEW_IDENTITY` (`:61-70`), суффикс `_TEST` — только для test backend (`:76-78`).
- OBSERVED. `bundle.mjs` всегда запускает electron-builder с `--publish never` (`scripts/bundle.mjs:876-888`); публикация вынесена в отдельные шаги/скрипты. Единственный workflow (`cross-platform-preview-release.yml`) — только `workflow_dispatch`, собирает offline Preview, публикует GitHub prerelease; шагов `typecheck/lint/test` в нём нет (`:47-97`, `:158-209`).
- OBSERVED. Локальные артефакты `packages/desktop/dist/` содержат `ZCode Preview-3.17.77…3.17.102-mac-arm64_TEST.dmg/zip` (наблюдение `find`); production-подписанных артефактов в checkout нет.

### 3.8 Кросс-платформенность

- OBSERVED. Платформенные модули: `desktopDarwinCloseBehavior.ts`, `desktopLinuxAppImageIcon.ts`, `desktopLinuxDeepLinkRegistration.ts`, `desktopLinuxXdg.ts`, `desktopWindowsOpenFolderContextMenu.ts`, `windowsAumidIcon.ts`, `windowsChromeAppBoundKey.ts`, `windowsCuaOperationIndicator*.ts`, `windowsExplorerDelegation.ts`, `windowsInstallResourceLocks.ts`.
- OBSERVED. macOS: hidden titlebar, traffic lights, vibrancy, Dock menu, Finder Services workflow, `open-url`; закрытие окна = hide (кроме fullscreen → exit fullscreen) (`desktopWindowChrome.ts:139-148`; `desktopWindowLifecycle.ts:402-415`; `desktopDarwinCloseBehavior.ts:7-31`; `desktopFinderOpenFolderWorkflow.ts:7-28`).
- OBSERVED. Windows: frameless acrylic, кастомные контролы через titleBarOverlay, AUMID, tray, taskbar overlay badge, Explorer context menu, `taskkill /T /F` в process-tree cleanup, resource-lock pre-cleanup перед установкой обновления (`desktopWindowChrome.ts:150-157`; `index.ts:2149-2155`; `desktopWindowLifecycle.ts:331-375`; `windowsInstallResourceLocks.ts:7-11,39+`).
- OBSERVED. Linux: frameless transparent window, tray только при capability, AppImage `.desktop` с allowlist аргументов, `zcode.desktop` ownership marker, `xdg` команды с timeout (`desktopWindowChrome.ts:159-170`; `desktopTray.ts:30-67`; `desktopLinuxDeepLinkRegistration.ts:11-104`; `desktopLinuxXdg.ts`).
- OBSERVED. WSL: канонизация distro/user с TTL-кэшем и удалением неудачного кэша (`desktopWslTargetResolver.ts:31-73`).
- OBSERVED. Клавиатура: accelerator'ы меню настраиваются, recording-state снимает их, тесты фиксируют `CmdOrCtrl+W`, `CmdOrCtrl+0`, `CmdOrCtrl+Plus`, `CmdOrCtrl+-` (`desktopApplicationMenu.ts:61-110`, `:366-378`; `desktopApplicationMenu.test.ts:286`, `:339-342`).
- OBSERVED. Доступность: `aria`/`role`/`prefers-reduced-motion` есть в мелких native-окнах (`aboutWindow.ts:170-173`, `forceUpdatePrompt.ts:306-329`, `windowsCuaOperationIndicatorContent.ts:70-76`) и в стартовом shell (`renderer/index.html:99-105`, `:110-116`); основной UI — в `@zcode/ui`, здесь не аудировался.

### 3.9 Тестовая инфраструктура

- OBSERVED. Unit: 358 `test/*.test.ts` + 1 `test/unit` + 11 колокированных; Vitest root исключает `packages/desktop/test/e2e/**` (`package.json:38`; `vitest.config.ts:108-138`). E2E: 575 спек, 198 формальных вне `manual-review`, 377 в `manual-review/pending`; по умолчанию `manual-review` исключён (`wdio.conf.ts:4775-4785`), specs — `./test/e2e/**/*.test.ts` (`:580-587`).
- OBSERVED. WDIO: `framework: "mocha"`, `maxInstances` по умолчанию 1, `wdio-electron-service` с локальной патченной обёрткой, `--no-sandbox` только в appArgs теста, Chromedriver cache в репозитории (`wdio.conf.ts:4718-4771`). E2E-отчётность и очистка процессов задокументированы в `docs/desktop/e2e-process-lifecycle.md:5-35` и `docs/testing/desktop-e2e-reporting.md`.
- OBSERVED. Последний локальный артефакт `desktop-e2e-20261109085638661-p5091-abaca2a3fc72deec` (2026-11-09): exit code 1, 1 тест, 0 passed, 1 timeout (`AWB-E2E-001`, `agent-workbench.test.ts:39`, 5 418 ms). Это исторический локальный прогон, не HEAD.

## 4. Gaps, risks, weaknesses

1. **Main-окно не имеет навигационного/popup-конtainment, а preload отдаёт весь `window.zcode` на любой загрузке.** OBSERVED: `desktopWindowChrome.ts:602-613` не задаёт `sandbox`/`will-navigate`/`setWindowOpenHandler`; `rg` по `src/main` не находит `will-navigate`/`setWindowOpenHandler` для main-окна; `preload/index.ts:934` безусловно публикует 132 метода; `src/renderer/index.html` без CSP. В UI есть `target="_blank"` (`McpRegistryMarketplace.tsx:354-362`, `ConversationShareContent.tsx:92`, `TicketDetail.tsx:209-214`). Electron docs: без handler popup-окно может создаваться, а разрешённое окно наследует security-related webPreferences; preload-наследование в docs не заявлено. INFERRED: XSS/внешняя навигация в главном frame или popup с preload даёт доступ к `executeDesktopCommand`, `openExternalFile`, `saveFile`, `selectDirectory`, MCP-записи и т.п. Severity: высокая, потому что main-окно рендерит markdown/HTML из модели и плагинов.
2. **Падение Host не приводит к восстановлению и не уведомляет renderer.** OBSERVED: `desktopHostProcess.ts:647-664` при exit удаляет Host из maps, снимает broadcast/realtime, но не шлёт событие в `webContents` и не вызывает `disposeRemoteWorkspaceSessionsForWindow`/`webRemoteControlManager.disposeWindow` (эти вызовы есть только в `closed` окна, `desktopWindowLifecycle.ts:275-287`). Автоматического respawn нет (`rg "respawn|restartHost"` → только fallback при reload, `desktopWindowLifecycle.ts:177-189`). INFERRED: окно остаётся с мёртвым MessagePort, UI получает ошибки RPC без явного статуса; remote logical sessions в main могут остаться зарегистрированными. `docs/testing/conversation-session-decision-backlog.md:157` фиксирует этот вопрос как нерешённый.
3. **Утечка `TaskRealtimeBus.streamBatches` на нетерминальных окончаниях run всё ещё присутствует.** OBSERVED: batch удаляется только при `event.terminal` (`taskRealtimeBus.ts:520-522`, `:544-546`); `releaseLease`/`releaseLeasesForHost` только `flushBatch`, но не удаляют batch (`:366-393`); host в `finally` всегда отпускает lease (`host/index.ts:1485-1490`), включая отмену/ошибку. Audit `docs/analysis/memory-leak-audit-2026-09-03.md:59-63` описывает ровно это; в текущем коде состояние не изменилось. Тестов на непустой `streamBatches` после нетерминального release нет (16 тестов `taskRealtimeBus.test.ts`, проверены имена). Риск: рост main-памяти и replay-нагрузки при открытии новых окон (`replayVisibleRunsToHost`, `taskRealtimeBus.ts:752-784`).
4. **Нет централизованной проверки отправителя IPC.** OBSERVED: из 118 обработчиков только единицы проверяют `event.sender`/owner (resource manager network `resourceManagerNetwork.ts:107-116`; web-remote reconnect `webRemoteControlRendererReconnect.ts:33-51`; shortcut recording owner `desktopMainIpcPlatform.ts:354-360`). Остальные полагаются на `BrowserWindow.fromWebContents` и схему payload. `OpenExternalFile`/`OpenInFileManager` принимают произвольный локальный путь без sender-проверки (`desktopMainIpcRemote.ts:371-373`; `desktopMainIpcPlatform.ts:376-378`). INFERRED: при компрометации любого frame, получившего preload, доступна вся платформенная поверхность, а не только разрешённые для этого окна методы.
5. **Нет E2E/интеграционной проверки установки обновления.** OBSERVED: `autoUpdater.ts` — 2 148 строк с state machine, `quitAndInstall` и recovery; покрытие — `autoUpdaterReadyState.test.ts` (модель состояний) и `desktopApplicationMenu.test.ts`; в E2E только один `manual-review/pending` спек, упоминающий update. `docs/desktop/windows-update-install-handoff.md` и `auto-update-*.md` описывают инварианты, но не дают прогоняемого теста.
6. **В checkout нет CI, который проверяет качество desktop-кода.** OBSERVED: единственный workflow — manual `workflow_dispatch`, собирает Preview и публикует prerelease (`cross-platform-preview-release.yml:3-12`, `:158-209`); шагов typecheck/lint/unit/E2E нет. `docs/desktop-ci-cd.md:20` описывает Windows job с `pnpm lint`/`typecheck`/`test:unit`, но `.gitlab-ci.yml` и `.gitlab/` в checkout отсутствуют (`ls` → No such file or directory). Release macOS выполняется локально (`package.json:86-89`; `scripts/release-macos-preview.mjs:1-5`), а локальные артефакты в `dist` имеют суффикс `_TEST` и ad-hoc подпись.
7. **Огромная часть E2E не входит в дефолтный прогон.** OBSERVED: 377 из 575 спек лежат в `manual-review/pending` и исключены по умолчанию (`wdio.conf.ts:583-587`, `:4778`). Формальных спек — 198, из них 121 в `conversation-session`. Desktop-платформенные сценарии (tray, deep links, single instance, update install, host crash) почти не имеют формального E2E.
8. **Синхронный файловый лог в main.** OBSERVED: `logger.ts:73-91` делает `mkdirSync` + `appendFileSync` на каждый `info/warn/error`, включая горячие пути; `hostLogRelay` дублирует потоки Host. INFERRED: при интенсивном выводе (agent/tool/MCP) это блокирует event loop main и может усиливать задержки IPC.
9. **Хрупкость single-file orchestration.** OBSERVED: `src/main/index.ts` — 2 653 строки, `src/host/index.ts` — 4 158 строк и 42 функции верхнего уровня; host одновременно владеет DB startup, local services, remote registry, source servers, window controller, cron/off-peak, attachments и telemetry. OBSERVED в `docs/specs/workspace-hook-trust.md:2585-2586`: старый task-realtime owner bus оставлен только для совместимости, тогда как `docs/web-remote-control/task-realtime-sync.md:6-7` заявляет, что bus «продолжает нести owner lease». Формулировки расходятся; фактический код main всё ещё содержит lease/replay (`taskRealtimeBus.ts:122-135`).
10. **Force-update и update feed — сетевая зависимость на старте.** OBSERVED: `maybeBlockStartupForForceUpdate` вызывается до создания окна (`index.ts:2524-2543`), запрос ограничен 10 c/1 MiB (`forceUpdateGuard.ts:13-15`). Fail-open при ошибке предусмотрен (`:76-120`), но при медленном/зависшем endpoint (timeout) первый экран откладывается до 10 c. UNKNOWN: фактическая задержка на реальной сети не измерялась.

## 5. Strengths and differentiators

1. **Явная и физически закреплённая граница Main/Host/Renderer.** OBSERVED: отдельные tsconfig-проекты и tsup-конфиги; Host — `utilityProcess` на окно; main не хранит task/session бизнес-состояние, а только окна/процессы/пересылку (`AGENTS.md:64-67`; `host/index.ts:1-16`). Перезагрузка renderer не убивает Agent: Host переиспользуется и получает новый MessagePort (`desktopWindowLifecycle.ts:146-183`) — это прямое исправление класса «сессия теряется при reload».
2. **Инженерно сильная остановка процессов.** OBSERVED: `Dispose` → bounded cleanup → `process.exit`; main ждёт exit с floor 3.5 c, чтобы process-tree Agent успел получить SIGTERM/SIGKILL (`desktopHostProcess.ts:669-713`); host выполняет фазы с индивидуальными таймаутами (`host/index.ts:2802-2830`); политика `normal|update-install` отделяет короткий Windows-выход от строгого update-выхода (`appShutdownPolicy.ts:14-34`); E2E-очистка использует run identity, а не имена процессов (`docs/desktop/e2e-process-lifecycle.md:5-35`).
3. **Типизированный протокол и валидация на границах.** OBSERVED: центральный `channels.ts` с request/response map; Zod на main↔host (`hostMessagePortGuard.ts:20-31`), на payload'ах main IPC (`desktopMainIpcPlatform.ts:6-26`), на preload port payload'ах (`databaseStartupAdmission.ts:15-23`); неизвестные сообщения Host игнорируются, а переданные порты закрываются.
4. **Модель attachment со scope/generation и fail-closed allowlist для мобильного клиента.** OBSERVED: `windowHostAttachmentRegistry.ts:47-145`; `windowHostAttachmentRpcPolicy.ts:16-80` — mobile получает только перечисленные каналы, Terminal/PTY не входит; это исправление прошлого denylist-бага зафиксировано комментарием (`:73-79`).
5. **Глубоко проработанная trust-boundary для deep links.** OBSERVED: network/UNC reject до `statSync`, диалог подтверждения до файловых операций, одноразовый deep-link gate на холодном старте, `--` перед URL в Windows-регистрации, allowlist аргументов AppImage (`desktopOAuthDeepLink.ts:264-287`, `:407-432`; `startupWorkspaceDeepLinkGate.ts`; `desktopLinuxDeepLinkRegistration.ts:39-104`).
6. **Зрелая упаковка и update-интеграция.** OBSERVED: multi-target (dmg/zip, NSIS, AppImage/deb/rpm/pacman), afterPack-ремонт app.asar для runtime-модулей, проверка native-пакетов, DMG 3200m, `signIgnore` для предподписанных helper/runtime, manifest provider, stable/preview каналы, skip-version, cancel токеном, Windows resource-lock cleanup перед установкой (`electron-builder.config.js:913-1037`; `autoUpdater.ts:441-538`; `windowsInstallResourceLocks.ts`).
7. **Наблюдаемость.** OBSERVED: T0–T5 launch marks (`desktopLaunchMarks.ts:1-17`; `main.tsx:50-64`), resource telemetry по ролям, memory diagnostics registry, crash dump archive, отдельные логи web-remote relay, E2E summary/perf artifacts (`logger.ts:94-114`; `desktopCrashCapture.ts:333-457`; `docs/monitoring/memory-diagnostics-log.md:78-92`).
8. **Объём и организация тестов.** OBSERVED: 370 unit-файлов, 198 формальных E2E, кастомный WDIO reporter с lifecycle/perf/summary, шардирование Windows, replay/capture fixtures, Docker E2E (`docs/testing/desktop-e2e-container.md:3-17`; `wdio.conf.ts`).

## 6. Candidate recommendations

### R1. Contain main-window navigation and popups; gate preload exposure by frame origin

- **Problem/gap:** главное окно без `will-navigate`/`setWindowOpenHandler`/CSP; preload публикует 132 метода любому загруженному документу.
- **ZCode evidence:** `packages/desktop/src/main/desktopWindowChrome.ts:591-614` (webPreferences без sandbox/navigation guard), отсутствие `will-navigate`/`setWindowOpenHandler` для main-окна (`rg` по `packages/desktop/src/main`), `packages/desktop/src/preload/index.ts:264-934`, `packages/ui/src/settings/McpRegistryMarketplace.tsx:354-362`, `packages/desktop/src/renderer/index.html:1-190` (нет CSP).
- **Proposed solution:** в `createBrowserWindow` добавить `will-navigate`/`will-frame-navigate`, разрешающие только доверенный origin (dev server или `file://` внутри app.asar); `setWindowOpenHandler` → `deny` + `shell.openExternal` для http(s); все `target="_blank"`-сценарии перевести на `platform.openExternal`; добавить CSP meta/response header для renderer; опционально — выставлять `window.zcode` только при `event.senderFrame.url` из доверенного origin (preload не умеет проверять sender, поэтому лучше проверять в main на каждом handler).
- **Scope:** `packages/desktop/src/main/desktopWindowChrome.ts`, `src/preload/index.ts`, `src/renderer/index.html`, UI-компоненты ссылок. **Out of scope:** `<webview>`-политика (уже реализована), embedded browser permission policy.
- **Expected effect:** закрывает класс «навигация/попап получает native API», снижает поверхность XSS-эскалации.
- **Risks:** можно сломать OAuth/payment redirect и внутренние file:// переходы; нужен точный allowlist и regression E2E.
- **Complexity:** M. **Priority:** P0.
- **Acceptance criteria:** unit-тест проверяет регистрацию `will-navigate`/`will-frame-navigate`/`setWindowOpenHandler`; клик по внешней ссылке в главном окне открывает системный браузер и не создаёт `BrowserWindow`; навигация main frame на `https://example.com` блокируется; preload-методы недоступны после навигации (тест на `window.zcode === undefined`).
- **Verification:** `pnpm --filter @zcode/desktop exec vitest run test/desktopWindowChrome.test.ts`; новый E2E в `test/e2e/ui-shell/` с моком `shell.openExternal`; ручная проверка OAuth/payment.

### R2. Host crash: уведомление renderer, one-shot respawn и reconciliation

- **Problem/gap:** Host exit не уведомляет окно и не восстанавливает Host; remote-сессии и web-remote attachments не приводятся в согласованное состояние.
- **ZCode evidence:** `packages/desktop/src/main/desktopHostProcess.ts:647-664`; отсутствие `webContents.send` в этом файле; `packages/desktop/src/main/desktopWindowLifecycle.ts:275-287` (cleanup только на `closed`); `docs/testing/conversation-session-decision-backlog.md:157`.
- **Proposed solution:** добавить `InternalChannels.HostProcessExited` (payload: windowId, hostId, code, hadRunningSessions) и состояние `host_unavailable` в UI; в main при exit вызывать `remoteSessionManager.disposeRemoteWorkspaceSessionsForWindow`/`webRemoteControlManager.disposeWindow`, затем один respawn с backoff и guard от циклов; при respawn заново раздавать ServicePort и переинициализировать attachment.
- **Scope:** main host supervision (`desktopHostProcess.ts`, `desktopWindowLifecycle.ts`, `index.ts`), shared channels, renderer/UI banner. **Out of scope:** изменение семантики `CommandInbox` и CLI recovery.
- **Expected effect:** предсказуемое восстановление после crash, отсутствие «тихого» мёртвого окна, корректная очистка lease/attachments.
- **Risks:** двойной respawn при гонке с reload; повторное появление старых attachments; нужно строго один owner на окно.
- **Complexity:** M. **Priority:** P0.
- **Acceptance criteria:** E2E убивает Host (`process.kill`/`browser.electron.execute`), UI показывает статус, Host перезапускается ровно один раз, старые remote attachments освобождены; unit-тест на exit cleanup + respawn guard.
- **Verification:** новый E2E `test/e2e/workspace-host-crash-recovery.test.ts`; unit `desktopHostProcess.test.ts` + `desktopRemoteSessions.test.ts`; проверка `windowHostProcessMap`/`windowHostAttachmentRegistry.size`.

### R3. Завершить lifecycle `TaskRealtimeBus.streamBatches`

- **Problem/gap:** batches не удаляются при нетерминальном окончании run; lease release не освобождает replay-состояние.
- **ZCode evidence:** `packages/desktop/src/main/taskRealtimeBus.ts:129`, `:366-393`, `:520-522`; `packages/desktop/src/host/index.ts:1485-1490`; `docs/analysis/memory-leak-audit-2026-09-03.md:59-63`; `docs/monitoring/memory-diagnostics-log.md:84`.
- **Proposed solution:** в `releaseLease`/`releaseLeasesForHost` после финального flush удалять batch, если lease больше не существует; добавить terminal-признак в release или отдельный cap/TTL для «осиротевших» batch; расширить `collectMemoryDiagnostics` тестом на нулевое значение после release.
- **Scope:** `taskRealtimeBus.ts`, тесты, память-диагностика. **Out of scope:** замена bus на CLI `CommandInbox` (отдельная архитектурная задача).
- **Expected effect:** устраняет документированную утечку main и лишний replay новым окнам.
- **Risks:** преждевременное удаление batch может оборвать mirror для observer; нужен тест на порядок «release → observer invalidation».
- **Complexity:** S/M. **Priority:** P1.
- **Acceptance criteria:** после release без terminal `streamBatches.size === 0`; observer получает `snapshot_invalidation`; существующие 16 тестов bus зелёные.
- **Verification:** `pnpm exec vitest run packages/desktop/test/taskRealtimeBus.test.ts` + новый кейс.

### R4. Централизованный sender/origin guard для platform IPC

- **Problem/gap:** большинство из 118 IPC-обработчиков не проверяют отправителя; `OpenExternalFile`/`OpenInFileManager` принимают любой путь.
- **ZCode evidence:** `packages/desktop/src/main/desktopMainIpcPlatform.ts:116-175`, `:376-378`; `packages/desktop/src/main/desktopMainIpcRemote.ts:70-77`, `:371-373`; положительный пример owner-check — `resourceManagerNetwork.ts:107-116`.
- **Proposed solution:** ввести `assertTrustedPlatformSender(event, {allowAuxiliary?: boolean})`, проверяющий `event.senderFrame.url`/`event.sender.getURL()` против allowlist (упакованный `file://.../renderer/index.html`, dev `ELECTRON_RENDERER_URL`, отдельные preload-страницы); применить к каждому `ipcMain.handle/on` в platform/remote/browser/save/logging; для path-based методов добавить allowlist корней (workspace/data root) или явный capability-token.
- **Scope:** `src/main/desktopMainIpc*.ts`, `desktopBrowserViewIpc.ts`, `desktopSaveFile.ts`, `desktopCommandIpc.ts`. **Out of scope:** RPC-сервисы Host (у них своя auth-модель через attachment scope).
- **Expected effect:** даже при компрометации frame нельзя вызвать методы, не предназначенные этому окну.
- **Risks:** сломать вспомогательные окна/тестовый bridge; нужен строгий список и negative-тесты.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** тест-энумератор проверяет, что каждый `ipcMain.*` в desktop-пакете вызывает guard; negative-тест с фейковым sender URL получает отказ; resource manager/E2E остаются зелёными.
- **Verification:** unit-тесты guard + `desktopMainIpcPlatform.test.ts`; E2E smoke/container.

### R5. Вернуть quality gates в CI для desktop

- **Problem/gap:** единственный workflow не запускает typecheck/lint/unit/E2E и работает только вручную; релиз macOS — локальный.
- **ZCode evidence:** `.github/workflows/cross-platform-preview-release.yml:3-12`, `:47-97`, `:158-209`; `package.json:69` (typecheck), `:81` (lint), `:38` (unit); `scripts/bundle.mjs:876-888` (`--publish never`); `docs/desktop-ci-cd.md:20` (заявленный, но отсутствующий в checkout GitLab test job).
- **Proposed solution:** добавить job `verify` (typecheck + lint + узкий unit-набор desktop: `desktopHostProcess`, `desktopWindowChrome`, `desktopWindowLifecycle`, `windowHostAttachmentRegistry`, `taskRealtimeBus`, `autoUpdaterReadyState`) и сделать его dependency для `publish`; для E2E — хотя бы smoke/container на Linux с уже существующим `test:e2e:container`.
- **Scope:** workflow, при необходимости — новый shard-скрипт. **Out of scope:** полный 575-спек E2E и подпись/нотаризация в CI.
- **Expected effect:** regression-гейт на PR/релизе; прозрачность локального релиза.
- **Risks:** время CI и стоимость раннеров; плавающие E2E.
- **Complexity:** S/M. **Priority:** P1.
- **Acceptance criteria:** workflow падает на type/lint/unit ошибке; `publish` не стартует при красном `verify`; зелёный прогон на 3 ОС.
- **Verification:** прогон workflow_dispatch на тестовом теге; локальное воспроизведение команд.

### R6. Детерминированный E2E установки обновления

- **Problem/gap:** 2 148 строк update-логики не имеют E2E; проверяется только модель состояний.
- **ZCode evidence:** `packages/desktop/src/main/autoUpdater.ts:441-538`, `:1620-1651`; `packages/desktop/test/autoUpdaterReadyState.test.ts`; `ZCODE_UPDATE_FEED_URL`/`--zcode-update-feed-url` (`autoUpdater.ts:28-33`).
- **Proposed solution:** поднять локальный fixture-feed (custom manifest + файл), запустить приложение с `ZCODE_UPDATE_FEED_URL` и dev-флагами, проверить состояния `idle → checking → available → download-progress → downloaded → installing`; для install-части — assert вызова `quitAndInstall`/подготовки, без реального installer.
- **Scope:** `test/e2e`, fixture server, возможно dev-only флаг. **Out of scope:** реальная установка NSIS/DMG и нотаризация.
- **Expected effect:** фиксирует state machine и защищает от регрессий каналов/skip/cancel.
- **Risks:** dev-флаг `forceDevUpdateConfig` может течь в production; нужен явный build-time gate.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** тест стабильно проходит 3 раза подряд локально и в контейнере; проверены cancel и skip-version.
- **Verification:** `pnpm --filter @zcode/desktop test:e2e:serial -- --spec test/e2e/update-flow.test.ts` (или WDIO spec-фильтр).

### R7. Сократить manual-review backlog и закрепить критерии промоушена

- **Problem/gap:** 377 из 575 E2E-спек исключены по умолчанию; desktop-платформенные сценарии почти не имеют формального E2E.
- **ZCode evidence:** подсчёт `find`; `wdio.conf.ts:583-587`, `:4775-4785`; `scripts/e2e-formal-spec-selection.mjs:1-25`.
- **Proposed solution:** ввести список «платформенных P0-спек» (tray, deep link, single instance, host crash, update flow) и перевести их из `pending` в формальные; для остальных — явные owner/дата/причина pending; добавить метрику «formal/pending» в E2E-отчёт.
- **Scope:** `test/e2e`, WDIO config/report. **Out of scope:** переписывание всех 377 спек.
- **Expected effect:** дефолтный прогон начинает защищать desktop-платформу, а не только conversation-session.
- **Risks:** рост времени дефолтного прогона; flaky-спеки.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** минимум 5 платформенных спек в formal наборе; отчёт показывает formal/pending; стабильность 3 прогона.
- **Verification:** `pnpm --filter @zcode/desktop test:e2e` на macOS и в Linux-контейнере.

## 7. Open questions and unverified

1. **UNKNOWN.** Является ли отсутствие `setWindowOpenHandler` для главного окна осознанным решением (например, чтобы `target="_blank"` открывал дочернее окно с preload) или недосмотром. Нужен ответ владельца desktop-платформы до реализации R1.
2. **UNKNOWN.** Наследует ли дочернее окно, созданное `window.open` из main-окна, preload и `window.zcode` в Electron 41. Официальная страница `window-open` говорит о наследовании security-related webPreferences, но не о preload; требуется runtime-probe.
3. **UNKNOWN.** Что именно видит пользователь при падении Host: глобальный error boundary, «workspace not ready» или зависшие запросы. Нужен runtime-эксперимент (убить Host, снять логи/renderer state).
4. **UNKNOWN.** Есть ли внешние CI-пайплайны (GitLab/Jenkins), которых нет в checkout. OBSERVED: `docs/desktop-ci-cd.md:1-31` описывает GitLab CI (`.gitlab-ci.yml`, `.gitlab/ci/*.yml`, стадии `test → build → approve → validate → upload → preload → publish` и Windows `pnpm lint`/`typecheck`/`test:unit`), но самих файлов в checkout нет: `ls .gitlab-ci.yml .gitlab` → `No such file or directory`, `find . -maxdepth 2 -name '.gitlab*'` → пусто. Фактически доступный CI в дереве — только `.github/workflows/cross-platform-preview-release.yml`. Нужно подтвердить, является ли GitLab-пайплайн внешним/приватным.
5. **UNKNOWN.** Реальная задержка первого экрана при недоступном force-update endpoint: код ограничивает 10 c, но фактическое поведение на плохой сети не измерялось.
6. **UNKNOWN.** Влияет ли синхронный `appendFileSync` в `logger.ts` на latency IPC в реальной нагрузке; нужен профиль на длинной сессии.
7. **UNKNOWN.** Статус Windows/Linux-релизов: workflow собирает только offline Preview с отключённой подписью; production-подпись/нотаризация описаны в `docs/desktop/macos-dmg-signing-notarization.md`, но в текущем checkout нет CI-шагов, которые бы их выполняли.
8. **UNKNOWN.** Актуальность 377 `manual-review/pending` спек: часть может быть устаревшей, часть — намеренно ручной. Нужен owner-review.
9. **UNKNOWN.** Существует ли внешний потребитель legacy `TaskRealtimeBus` owner-command schema (комментарий `docs/specs/workspace-hook-trust.md:2585-2586` говорит «только для совместимости»), и можно ли удалить bus-состояние полностью. Без ответа R3 ограничивается точечным исправлением утечки.

## 8. Evidence appendix

**Baseline (OBSERVED, команды выполнены из `<repo-root>`).**

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
$ node scripts/check-workspace-freshness.mjs
[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）
exit=0
```

**CodeIndex.**

```json
{"state":"ready","partial":false,"generation":1453,"counts":{"files":10007,"chunks":26791,"symbols":278154,"edges":377669},
 "embedding":{"configured":true,"available":true},"diagnostics":["Embedding search is unavailable; showing lexical results."]}
```

**Подсчёты (OBSERVED).**

```text
packages/desktop/src/main      files=245 lines=58318
packages/desktop/src/host      files=73  lines=17500
packages/desktop/src/preload   files=14  lines=1789
packages/desktop/src/renderer  files=25  lines=2290
packages/desktop/src/scheduler files=6   lines=822
packages/desktop/src/shared    files=3   lines=218
test/*.test.ts (top-level) = 358
test/unit/*.test.ts        = 1
src/**/*.test.ts           = 11
test/e2e/**/*.test.ts      = 575  (198 вне manual-review, 377 в manual-review/pending)
ipcMain.handle (src, без тестов) = 88
ipcMain.on     (src, без тестов) = 30
PlatformChannels = 154; ServiceChannels = 58; InternalChannels = 8; HostMessageTypes = 31; HostResponseTypes = 78
preload zcodeApi keys = 132; contextBridge.exposeInMainWorld("zcode", ...) = preload/index.ts:934
```

**Узкие тесты (OBSERVED).**

```text
$ npx vitest run packages/desktop/test/windowHostAttachmentRegistry.test.ts packages/desktop/test/desktopHostProcess.test.ts
✓ |unit| packages/desktop/test/windowHostAttachmentRegistry.test.ts (10 tests)
✓ |unit| packages/desktop/test/desktopHostProcess.test.ts (10 tests)
Test Files  2 passed (2) | Tests  20 passed (20) | exit 0
```

```text
$ npx vitest run packages/desktop/test/desktopWindowLifecycle.test.ts packages/desktop/test/desktopWindowChrome.test.ts packages/desktop/test/primaryWindowCoordinator.test.ts
✓ |unit| packages/desktop/test/primaryWindowCoordinator.test.ts (4 tests)
✓ |unit| packages/desktop/test/desktopWindowChrome.test.ts (33 tests)
✓ |unit| packages/desktop/test/desktopWindowLifecycle.test.ts (19 tests)
Test Files  3 passed (3) | Tests  56 passed (56) | exit 0
```

Примечание: первая попытка добавить `--reporter=basic` завершилась `ERR_LOAD_URL` (Vitest 4 не содержит такого reporter); это ошибка команды, а не продукта. Повторный прогон без флага — зелёный.

**Ключевые негативные проверки (OBSERVED).**

```text
$ rg -n "open-file" packages/desktop/src/main
(пусто)  → обработчика macOS app.on("open-file") нет
$ rg -n "enableSandbox" packages/desktop/src
(пусто)  → глобальный enableSandbox не вызывается
$ rg -n "will-navigate|setWindowOpenHandler" packages/desktop/src/main
только desktopWindowChrome.ts (для guest), electronBrowserWebmRecorder.ts, pluginSandbox/guestPolicy.ts
$ rg -n "webContents.send" packages/desktop/src/main/desktopHostProcess.ts
(пусто)  → main не уведомляет renderer о выходе Host
$ rg -n "src/main/index" packages/desktop/test/*.test.ts
только чтение файла как текста/фикстуры (e2eProcessCleanup.test.ts:65,80; e2eCoverageHeatmap.test.ts:40; e2eNodeCoverageNormalization.test.ts:27-84)
$ rg -n "streamBatches.delete" packages/desktop/src/main/taskRealtimeBus.ts
520, 545 — только при event.terminal
```

**Внешние источники (OBSERVED через WebFetch).**
- https://www.electronjs.org/docs/latest/tutorial/sandbox — «Starting from Electron 20, the sandbox is enabled for renderer processes without any further configuration»; «Enabling Node.js integration … disables the sandbox».
- https://www.electronjs.org/docs/latest/api/window-open — при разрешённом новом окне наследуются «security-related webPreferences»; для `about:blank` WebPreferences копируются; preload-наследование не заявлено.
- https://www.electronjs.org/docs/latest/api/web-contents — `setWindowOpenHandler` вызывается до создания окна; `deny` отменяет создание.
- https://www.electronjs.org/docs/latest/api/process — в sandboxed renderer доступны `argv`, `env`, `platform`; `title` в списке отсутствует.
- https://www.electronjs.org/docs/latest/api/session — поведение по умолчанию без `setPermissionRequestHandler`/`setPermissionCheckHandler` не описано (UNKNOWN).

**Документация репозитория (использована как заявленные инварианты, не как доказательство реализации).**
- `docs/desktop/startup-critical-path.md:5-14` — baseline T0–T5 и P0-оптимизации старта; `:19-60` — prewarm login shell; `:62-96` — bounded wait/fallback.
- `docs/desktop-ci-cd.md:1-31` — заявленный GitLab pipeline (файлы в checkout отсутствуют; см. §7).
- `docs/desktop/e2e-process-lifecycle.md:5-35` — run identity и границы очистки процессов.
- `docs/desktop/build-time-optional-capabilities.md:5-11,35` — автообновление/ARMS/телеметрия как build-time опции.
- `docs/desktop/macos-dmg-signing-notarization.md:9-22` — DMG sign/notarize/staple/spctl, запрет `.unnotarized.dmg` в release.
- `docs/desktop/auto-update-baseline.md:5-16,30-35` — manifest API и gray `status=3/1`, generic feed только для legacy.
- `docs/analysis/memory-leak-audit-2026-09-03.md:59-63` — MAIN-H2 `streamBatches`.
- `docs/monitoring/memory-diagnostics-log.md:78-92` — какие таблицы попадают в memory diagnostics.
- `docs/web-remote-control/task-realtime-sync.md:6-7,11-19` — role `TaskRealtimeBus` и разделение desktop-continuous/replayable.
- `docs/specs/workspace-hook-trust.md:2585-2586` — bus оставлен для совместимости.
- `docs/testing/conversation-session-decision-backlog.md:157` — нерешённый сценарий host crash.
- `docs/testing/desktop-e2e-container.md:3-17` — контейнерный smoke-набор.
- `AGENTS.md:64-67`, `:81-82` — ownership Main/Host и правила логов.

**Coverage status: partial.**

- OBSERVED и покрыто: структура пакета, границы сборки, main lifecycle (по коду), окна/chrome, tray/menu, Host lifecycle и attachment, stdio-контракт, IPC-инвентарь и выборочная валидация, renderer shell, update/packaging-конфиг, кросс-платформенные модули, тестовая инфраструктура, два узких unit-прогона.
- Не проверено: запуск Electron/WebDriver, полный `pnpm typecheck`/`pnpm lint`/`pnpm test`, реальные Windows/Linux-сборки, подпись и нотаризация, все 118 IPC-обработчиков построчно, runtime-поведение popup/навигации, реальный host crash, производительность логирования.
- Подтверждение: записан только этот файл; продакшн-код и конфигурация не изменялись.
