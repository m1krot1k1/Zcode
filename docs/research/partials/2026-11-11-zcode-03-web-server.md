# Z03 — packages/web и packages/server: карта поверхностей, риски, рекомендации

Дата исследования: 2026-11-11. Ветка: `dev`. HEAD: `d10f0b69 Выпустить macOS Preview 3.17.102.`
Режим: read-only, за исключением этого partial-файла. Продакшн-код не изменялся.

## 1. Scope and method

**Вопрос.** Что фактически реализуют `packages/web` и `packages/server`: какие поверхности входа, аутентификации, API, remote-семантики и эксплуатации существуют; где проходят границы доверия; какие пути покрыты тестами, а какие нет.

**Границы.** В фокусе: `packages/web` (Vite SPA: `/remote/v4`, `/remote/__test__`, share-страницы, обычный Web+Server bootstrap), `packages/server` (HTTP/WS ingress, stdio entry, remote deploy SSH/WSL/Docker, source-server transport adapter). Смежные пакеты (`packages/services`, `packages/rpc`, `packages/client`, `packages/zcode-server-cli`, `apps/zcode-cli`) читались только как контекст владельцев состояния; их внутренняя реализация не инвентаризировалась.

**Метод.**
1. Зафиксировано состояние репозитория: `git status --short` → `?? docs/research/`; `git branch --show-current` → `dev`; `git log -1 --oneline` → `d10f0b69 Выпустить macOS Preview 3.17.102.`
2. `node scripts/check-workspace-freshness.mjs` → `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）`, exit 0.
3. CodeIndex `status` → `ready`, generation 1453, 10007 files / 26791 chunks, embedding unavailable (lexical fallback).
4. Инвентаризация файлов: `find`, `wc -l`, `git ls-files` (113 tracked файлов в `packages/web` без `material-icons`, 88 в `packages/server`).
5. Чтение исходников через `nl -ba`, `rg -n`, `sed -n`; спецификации в `docs/` — как источник заявленных инвариантов, отдельно от кода.
6. Воспроизведение поведения: три локальных probe-скрипта через `tsx` на `createHttpServer` (static path handling, lite-token cookie, bots webhook под `authToken`).
7. Узкие тесты: 15 файлов, 128 тестов (детали в §8).

**Метки доказательств.** OBSERVED — прочитано в исходнике или воспроизведено командой. INFERRED — вывод из кода без runtime-проверки. UNKNOWN — источники не дают ответа.

**Ограничения.** В checkout отсутствуют `.gitlab-ci.yml`, `.gitlab/`, `Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx.web-share*.conf`, `scripts/test-web-share-build.sh`, хотя документация на них ссылается. Полный `pnpm typecheck`/`pnpm lint`/`pnpm test` не запускался (запрещён envelope); запускались только узкие Vitest-файлы и локальные probe-скрипты.

## 2. Coverage table

| Поверхность | Файлы | Доказательство | Покрытие |
|---|---|---|---|
| Web entry / routing | `packages/web/src/main.tsx`; `packages/web/index.html` | `main.tsx:2032-2107` — `bootstrapWebApp()`: OAuth callback → share → `/remote/v4` → Web+Server; `index.html:16` — pre-bundle theme shell | OBSERVED (код), частично тестами (`externalRelayFrameGapRecovery.test.ts` импортирует `src/main.js`) |
| Vite build/dev config | `packages/web/vite.config.ts` | `:30-46` env/ZCODE_ENV; `:47-61` React/Tailwind/алиасы; `:62-82` proxy `/api/v1/oauth/token`, `/api/v1/remote`, `/ws`, `/api`; `:96-110` define-константы; `:111-114` sourcemap | OBSERVED; `viteConfigLoad.test.ts` (6 тестов) |
| Web OAuth | `auth/webAuthService.ts`, `auth/browserOAuthCredentialRepo.ts`, `auth/oauthStateCodec.ts`, `auth/zaiWebOAuthProvider.ts` | `webAuthService.ts:87-120`, `:122-176`; `browserOAuthCredentialRepo.ts:12-20`, `:95-106`; `oauthStateCodec.ts:62-81`, `:114-155`; `zaiWebOAuthProvider.ts:168-192`, `:211-239` | OBSERVED; `webAuthService.test.ts` (20), `oauthStateCodec.test.ts` (12), `browserOAuthCredentialRepo.test.ts` (10) |
| Share landing (`/share`, `/cn/share`) | `share/ConversationShareLandingPage.tsx`, `share/conversationSharePreviewClient.ts`, `share/conversationShareRoute.ts` | `conversationSharePreviewClient.ts:111-135`; `conversationShareRoute.ts:11-18`; состояния `ConversationShareLandingPage.tsx:623-682`, `:774-826` | OBSERVED; 3 файла тестов (8/11/4) |
| Mobile remote control entry | `web-remote-control/app/webRemoteControlEntry.ts`, `app/webRemoteControlRoute.ts`, `contract.ts` | `webRemoteControlEntry.ts:77-98` (callback → JWT gate → QR params → devices); `contract.ts:48-61` | OBSERVED; `webRemoteControlEntry.test.ts` (30), `contract.test.ts` |
| Relay V2 transport | `adapters/webRemoteControlTransport.ts`, `adapters/relayMessage.ts`, `adapters/webRemoteControlV2Token.ts`, `adapters/webRemoteControlDeviceClient.ts`, `adapters/webRemoteControlHttpSignal.ts` | `webRemoteControlTransport.ts:84-140`; `relayMessage.ts:11-60` (1 MiB gate); `webRemoteControlV2Token.ts:9-44`; `deviceClient.ts:10-35`; `httpSignal.ts:2-27` | OBSERVED; `webRemoteControlTransport.test.ts` (29), `...TransportV2.test.ts` (11), token/device/http — 6/3/5(+28 parameterized) |
| Workspace bridge / recovery | `app/webRemoteControlWorkspaceBridgeSession.ts`, `app/webRemoteControlBridgeRecovery.ts`, `app/webRemoteControlLifecycle.ts`, `app/webRemoteControlVersion.ts`, `app/webRemoteControlTaskView.ts`, `app/webRemoteControlTaskRead.ts` | `workspaceBridgeSession.ts:26-83`, `:85-110`; `bridgeRecovery.ts:1-28`; `lifecycle.ts:17-66`; `version.ts:14-77`; `taskView.ts:9-86` | OBSERVED; соответствующие 5 тест-файлов + `externalRelayFrameGapRecovery.test.ts` (13) |
| HTTP server core | `packages/server/src/http.ts` | `:47-140` WS wrap/channel server; `:181-201` server-info; `:203-268` lite token; `:271-336` static; `:342-380` host/auth guard; `:382-466` routes; `:471-496` serve | OBSERVED; `serverInfoHttp.test.ts` (6), `staticRoutePathContainment.test.ts` (6), `botsHttp.test.ts` (4), `hostCapability.test.ts` (1) |
| HTTP entrypoint | `packages/server/src/entry-http.ts` | `:12-41` env (`PORT`, `ZCODE_SERVER_HOST`/`HOST`, `ZCODE_WEB_STATIC_ROOT`, `ZCODE_SERVER_AUTH_TOKEN`), `createServerHostServices`, `createHttpServer` | OBSERVED; отдельных тестов нет |
| stdio server / lifecycle | `packages/server/src/entry-stdio.ts`, `src/stdio.ts`, `src/stdio-lifecycle.ts` | `entry-stdio.ts:42-104`; `stdio.ts:63-108`; `stdio-lifecycle.ts:25-...` | OBSERVED; `stdioLifecycle.test.ts` (244 строки), `stdioDesktopPresentationSurface.test.ts` |
| Remote deploy (SSH/WSL/Docker) | `remote/connect.ts`, `remote/deploy.ts`, `remote/ssh-backend.ts`, `remote/wsl-backend.ts`, `remote/docker-backend.ts`, `remote/remoteDeployLock.ts`, `remote/remoteAsset*.ts` | `connect.ts:110-140`; `deploy.ts:95`; `ssh-backend.ts:219-367`; `remoteDeployLock.ts:39-72`; `remoteAssetCdn.ts:84-118` | OBSERVED; крупные тесты: `remoteDeploy.test.ts` (4651), `remoteAssetInstaller.test.ts` (1230), `sshBackend.test.ts` (1005), `wslBackend.test.ts` (517), `remoteConnect.test.ts` (410) |
| Source Server transport | `source-server/transportAdapter.ts`, `sourceServerProbe.ts`, `sourceServerReleaseDownload.ts`, `sourceServerTransportRuntime.ts` | `transportAdapter.ts:1-40`; `sourceServerTransportRuntime.ts:11-38`; `sourceServerProbe.ts:20-40` | OBSERVED; `sourceServerTransportAdapter.test.ts` (738 строк) |
| Server Core (zcode-server-cli) | `packages/zcode-server-cli/src/server-core/http.ts`, `ingressToken.ts`, `hostCapability.ts` | `http.ts:54-69` WS drain; `:197-329`; `ingressToken.ts:5-17` | OBSERVED; `coreHttp.test.ts`, `serverCore.test.ts`, `ingressToken.test.ts` (вне scope Z03, использовано для сравнения) |
| Deployment / distribution | `scripts/zcode-distribution/runner.mjs`, `scripts/build-zcode.mjs` | `runner.mjs:101-111` token defaults; `:170-232` spawn/env/shutdown; `build-zcode.mjs:142-155` build, `:157-160` stage | OBSERVED; Docker/Jenkins/nginx артефакты отсутствуют |
| CI | `.github/workflows/cross-platform-preview-release.yml` | jobs: `desktop`, `cli`, `publish`; шагов `pnpm test/lint/typecheck` нет | OBSERVED (отсутствие), `docs/desktop-ci-cd.md:3` ссылается на отсутствующий `.gitlab-ci.yml` |

## 3. Capability inventory

### 3.1 packages/web — структура и сборка

- OBSERVED. `packages/web/package.json:8-13` содержит только `dev`, `build`, `lint`, `lint:fix`; собственного `test`-скрипта нет. Зависимости: React 19, `@zcode/ui`, `@zcode/client`, `@zcode/shared` (`:14-19`).
- OBSERVED. Vite-конфиг: `vite.config.ts:30-46` выбирает `ZCODE_ENV` и endpoint origin; `:47-61` — `pdfJsCMapsPlugin`, React, Tailwind, third-party notices, алиасы `@` → `packages/ui/src`; `:62-82` — dev-proxy, где `/api/v1/oauth/token` и `/api/v1/remote` уходят на продуктовый endpoint до общего `/api`; `:79-80` — `/ws` и `/api` на `localhost:3030`.
- OBSERVED. `:96-110` инжектит `__ZCODE_VERSION__`, `__ZCODE_MIN_COMPATIBLE_VERSION__`, `__ZCODE_ENV__`, `VITE_ZCODE_BASE_URL`, OAuth-параметры. Секреты через `VITE_` не передаются (комментарий `:44`).
- OBSERVED. `:111-114`: `sourcemap: mode === "production" ? "hidden" : true`. В существующем `packages/web/dist` найдено 2219 `.map`-файлов общим объёмом ~92 MB; в `dist/assets/index-7oewE0-r.js` нет `sourceMappingURL` (проверено `grep -c` → 0). То есть карты генерируются, но не аннотируются в бандле; попадут ли они на статический хостинг — зависит от публикации каталога целиком.

### 3.2 Web-клиент: routing, SSR/CSR, state, auth

- OBSERVED. Чистый CSR: `createRoot(document.getElementById("root")!)` — `main.tsx:230`. SSR-кода нет.
- OBSERVED. Маршрутизация ручная, по `window.location` в `bootstrapWebApp()` — `main.tsx:2032-2107`:
  1. OAuth callback (`/remote/v4` либо `/share/callback`, `/cn/share/callback`) → `renderWebAuthCallbackPage()` (`:304-321`);
  2. share-путь (`/share*`, `/cn/share*`) → `renderConversationSharePage()` (`:323-395`);
  3. `/remote/v4` (и `resolveWebRemoteControlRoutePath`) → `remoteEntry.start()` (`:2047-2050`);
  4. иначе — обычный Web+Server bootstrap (`:2052-2104`).
- OBSERVED. Ветка `?remote=<id>` создаёт `ws://host/ws/remote/<id>` (`main.tsx:683-690`), но этот маршрут удалён на сервере (`http.ts:468-470` — комментарий о недоступности; `serverInfoHttp.test.ts:146-162` проверяет 404). При этом `connectRemote` в web-платформе явно возвращает ошибку «not supported in Web mode yet» (`main.tsx:482-505`). INFERRED: `?remote=` — мёртвая ветка, сохраняющая только URL-совместимость.
- OBSERVED. Тема применяется до рендера React (`main.tsx:194-222`) и pre-bundle inline-скриптом в `index.html:16+`; ключ `zcode-theme`, дефолт `zai-dark`, для share — `zai-light` (`main.tsx:189-200`).
- OBSERVED. i18n: `ZCodeIntlProvider` c `settingService`/`broadcastService` (`main.tsx:1770-1774`, `:2076-2079`); для remote-экранов локаль вычисляется из `navigator.language` (`main.tsx:1048-1050`, `resolveWebRemoteControlScreenLocale`).
- OBSERVED. Платформенный слой — единый `IPlatformService` (`createWebPlatform`, `main.tsx:456-675`): файловые диалоги, терминал, обновления, Docker/WSL/SSH-списки либо no-op, либо делегируются `externalWebRemoteControlProxy` (`:459`, `:470-473`, `:516-549`). Прямых обращений к `window.zcode` в web-слое не найдено.
- OBSERVED. Home-only fallback для отключённого remote workspace: `createHomeOnlyWebRemoteControlServices()` (`main.tsx:783-1042`) возвращает пустые/`unsupported` реализации, чтобы `Root` не падал при разорванном bridge; события `onXxx`/`onDynamicXxx` отдают пустые Event (`:766-781`).
- OBSERVED. Ошибки OAuth-страницы показываются пользователю как есть: `WebCallbackPage.tsx:31`, `:51-53` (`{error}` в UI).

### 3.3 Web OAuth и хранение сессии

- OBSERVED. Поток: `startLogin()` (`webAuthService.ts:87-120`) генерирует nonce (`crypto.randomUUID` либо `getRandomValues`, `:46-58`), сохраняет pending-login `{nonce, provider, redirectUri}` в localStorage (`:97`), собирает `state` как base64url(JSON) (`oauthStateCodec.ts:62-64`) и уходит на authorize URL. Callback (`:122-176`) парсит state, проверяет `return_to` (dev-forwarding только для приватных адресов, `oauthStateCodec.ts:18-19`, `:95-97`), берёт pending-login по nonce (`:154-157`), меняет code на токены и сохраняет их (`:166-168`).
- OBSERVED. Токены: `zcodejwttoken`, `oauth:zai:access_token`, `oauth:bigmodel:access_token`, user-info и `oauth:active_provider` — всё в `localStorage` (`browserOAuthCredentialRepo.ts:12-20`, `:95-106`, `:108-111`). Pending-login лимитирован 5 записями (`:18-20`); истёкшие/битые сессии вычищаются (`:164-175`).
- OBSERVED. PKCE отсутствует: поиск `code_challenge|code_verifier|PKCE` по `packages/web/src` и `packages/shared/src` не дал совпадений. Авторизация использует `response_type=code` и `client_id` (`zaiWebOAuthProvider.ts:184-191`); BigModel — `redirect`/`appId` (`:175-182`).
- OBSERVED. Обмен кода идёт на относительный `tokenUrl: "/api/v1/oauth/token"` (`webZaiOAuthConfig.ts:56`, `:211-228`) — same-origin к endpoint, в dev проксируется (`vite.config.ts:67-71`).
- OBSERVED. `resolveSafeAppReturnTo()` разрешает только известные пути (`/remote/v4[/]`, `/remote/__test__[/]`, share-путь по regex) и только same-origin (`oauthStateCodec.ts:114-133`); query фильтруется allowlist `app_version|sid|mid|name` (`:17`, `:105-112`).

### 3.4 Mobile remote control (web-remote-control)

- OBSERVED. `WebRemoteControlEntry.start()` (`webRemoteControlEntry.ts:77-98`): callback → проверка JWT → разбор QR-параметров → без `sid` — список устройств (с авто-подключением к последнему/единственному онлайн, `:36-48`) → `connect()`.
- OBSERVED. `WebRemoteControlTerminalTransport` (`webRemoteControlTransport.ts:84-140`) получает one-time terminal token, подключается к relay WS с `?token&mid`, отправляет `auth_init` с `device_sid` и meta `{platform:"web", version, name:"mobile-browser"}`. Лимит входящего кадра — 1 MiB (`relayMessage.ts:11-40`), парсинг строгий и молча отбрасывает невалидное (`:50-60`).
- OBSERVED. Восстановление: `createWebRemoteControlBridgeRecoveryRunner` сериализует recovery flight (`bridgeRecovery.ts:8-28`); backoff 1s/2s/5s (`:1-5`); lifecycle слушает `visibilitychange/freeze/resume/pageshow/pagehide/online` и не запускает recovery без предшествующей приостановки (`lifecycle.ts:17-66`). Основной entry различает `requiresBridgeRebuild` и «короткий background», сохраняя смонтированный Root (`main.tsx:1281-1357`, комментарии `:1323-1326`, `:1348-1353`).
- OBSERVED. Bridge: `openWorkspaceBridge()` отправляет `workspace-bridge-open` с `bridgeSessionId`, `bridgeGeneration`, `recoveryId`, `workspaceKey` (`main.tsx:1645-1692`), затем создаёт acknowledged relay protocol и регистрирует remote workspace session (`workspaceBridgeSession.ts:39-110`). Replay неотправленных кадров — `replayWebRemoteControlWorkspaceBridgeFrames` (`:26-36`).
- OBSERVED. Отправка состояния просмотра: `mobile-view-state-update` с `deviceInfo` (`main.tsx:1594-1608`); публикатор task view хранит epoch/seq и шлёт `mobile-task-view-update` (`taskView.ts:9-86`).
- OBSERVED. Контракт зафиксирован в `packages/web/src/web-remote-control/CONTRACT.md`: «Main/Host/CLI продолжают владеть бизнес-состоянием, телефон остаётся replayable».
- OBSERVED (спецификация, не код Z03). `docs/web-remote-control/web-remote-control-architecture.md:294-314` описывает snapshot/gap/resume (`{logEpoch, seq}`, `toSeq <= localSeq`, единственный resync, `commands/query`), `docs/web-remote-control-task-command-queue.md` — authoritative input queue. Реализация этих инвариантов находится в `apps/zcode-cli` и `packages/services`, вне scope Z03.

### 3.5 Share-страницы

- OBSERVED. Share landing в `packages/web` — самостоятельный entry, но `packages/web-share/src/main.tsx:5-22` импортирует те же модули напрямую из `../../web/src/share/*` и `../../web/src/auth/*`; отдельной копии логики нет. `packages/web-share/vite.config.ts:29-33` задаёт `base: "/cn/share/"` и `publicDir` из `packages/web/public`.
- OBSERVED. Состояния страницы: `loading`, `ready`, `login_required`, `error` с kind (`not_found`, `rate_limited`, `authentication_required`, `invalid_contract`, `network`) — `ConversationShareLandingPage.tsx:34-38`, `:623-682`, `:774-826`. Preview-клиент валидирует share code regex `^[A-Za-z0-9._~-]{1,512}$` (`conversationSharePreviewClient.ts:15`, `:43-57`), шлёт GET `/api/v1/shares/<code>/preview` с optional Bearer (`:111-135`) и не логирует код/JWT (`:84-93`, `:123-129`).
- OBSERVED. Спецификация `docs/conversation-share-v1.md:212-239` требует двух защит для публичной страницы: rendering-side нормализация remote images и transport CSP с `img-src 'self' data: blob:` и `script-src ... 'wasm-unsafe-eval'`. Ни `Content-Security-Policy`, ни X-Frame-Options и т.п. в `packages/server/src` и `packages/web/index.html` не выставляются (поиск по репозиторию нашёл CSP только в `packages/services/src/cloud-content`, `packages/desktop/...pluginSandbox`, Electron docs). Файл `nginx.web-share.security-headers.conf` в checkout отсутствует.

### 3.6 packages/server — HTTP ingress

- OBSERVED. Framework: Hono + `@hono/node-server` + `@hono/node-ws` (`http.ts:7-10`, `packages/server/package.json:21-22`). Сервер создаётся в `createHttpServer(services, port=3030, options)` (`http.ts:352-497`).
- OBSERVED. Маршруты:
  - `GET /api/server-info` (`:382`) — `ServerRemoteInfo`: `serverId`, `version`, `protocolVersion`, `authRequired`, `workspaces`, `compatibility`, `migration.failedPathCount`, `identity {osUser, hostname}`, `capabilities` (`:181-201`);
  - `POST /api/rpc-host-capability` (`:383`) — выдача one-time capability;
  - `GET /ws` (`:387-399`) — всегда `web-remote-replayable`;
  - `GET /ws/host` (`:401-419`) — `desktop-continuous`, только с валидной capability;
  - `POST /api/bots/:provider` и `/api/bots/:provider/:botId` (`:421-466`);
  - статика `*` при `options.staticRoot` (`:471-486`).
- OBSERVED. `setupChannelServer()` (`:89-140`) создаёт `ChannelServer`, оборачивает в `LoggingChannelServer`, опционально `SourceServerWorkspaceIdentityChannelServer`, и строит `createZCodeAgentConnectionScope` с `clientMode` и `role` (`:104-116`). Для non-continuous клиентов `IProviderProvisioningTargetService` подменяется stub с ошибкой (`:117-132`).
- OBSERVED. Логика `hasValidLiteToken` (`:243-260`): `Authorization: Bearer`, либо `?token=`, либо cookie `zcode_lite_token`. При query-токене выставляется `Set-Cookie: ...; Path=/; HttpOnly; SameSite=Lax` (`:251-258`). Под токеном только `/ws`, `/ws/*`, `/api/*` (`:262-264`); статика и SPA fallback — публичны (`:266-268`).
- OBSERVED. Fail-closed на non-loopback без токена: `throw` при `!isLoopbackHost(host) && !authToken` (`:361-369`). Дефолтный host — `127.0.0.1`.
- OBSERVED. Статика: `resolveStaticFile()` (`:291-336`) блокирует drive-qualified пути (`:272-276`, `:301-303`), проверяет containment через `isInsideDirectory` (`:281-289`), умеет SPA fallback, но не отдаёт fallback для `/api`/`/ws` (`:326-328`). MIME-таблица фиксирована (`:205-222`), кэш: `index.html` — `no-cache`, остальное — `public, max-age=31536000, immutable` (`:479-484`).
- OBSERVED. Bots callback: провайдер валидируется по `botProviders` (`:421-428`), принимается только `webhook` (`:426-428`), тело читается как текст и парсится, при ошибке оборачивается `{payload: rawBodyText}` (`:433-441`), секрет берётся из `x-zcode-bot-secret` (`:442`), статусы 400/401/503 транслируются (`:450-462`).
- OBSERVED. Явно удалены legacy-маршруты `/api/connect-remote` и `/ws/remote/:id` — комментарий `:468-470`, подтверждено тестом `serverInfoHttp.test.ts:146-162`.

### 3.7 packages/server — stdio, remote deploy, source-server

- OBSERVED. `entry-stdio.ts:42-104`: печатает `zcode-hello`, ждёт `hello-ack` (10 s), редиректит `console.*` в stderr (`:27-34`), обеспечивает device MID (`:57-60`), мигрирует storage (`:68`), создаёт services и stdio RPC server, регистрирует lifecycle с таймаутами 1 s (RPC stop) и 3.5 s (service dispose) (`stdio-lifecycle.ts:4-5`).
- OBSERVED. `stdio.ts:63-108`: один trusted-host-relay scope c `clientMode: "desktop-continuous"`; `services.exposeOnChannelServer` без allowlist (полный сервисный набор).
- OBSERVED. Remote deploy: `connectRemote()` (`connect.ts:110-140`) → `detect` → deploy → `exec server` → handshake → `SocketProtocol`/`ChannelClient`/`RemoteServiceAccess`. В remote пробрасывается только allowlist env (`connect.ts:59-93`). Handshake (`handshake.ts:20-126`) читает строки, пропускает SSH banner, валидирует `zcode-hello` zod-схемой, ошибки дополняет усечёнными stdout/stderr (2048 символов, `:5`, `:128-158`).
- OBSERVED. Backends: `createRemoteBackend()` (`create-backend.ts:6-39`); SSH читает private key по `~`-пути (`:10-15`), конфиг с `readyTimeout 60s`, `keepalive 15s/3` (`sshAuth.ts:26-53`), нормализует auth-ошибки в публичные коды (`:72-111`); `ssh-backend` исполняет команды через `/bin/sh` и квотирует аргументы (`ssh-backend.ts:290-367`, `:531-545`); Docker использует `sh -lc` и `quotePosixShellArg` (`docker-backend.ts:174-258`).
- OBSERVED. Deploy lock — директория с owner-token, heartbeat 30 s, stale 600 s, takeover через `mv` + `rm -rf` (`remoteDeployLock.ts:7-11`, `:39-72`). CDN-пути нормализуются: запрещены `\`, абсолютные/drive-пути, `.`/`..`, пустые сегменты (`remoteAssetCdn.ts:84-118`); версия CDN сверяется (`:120+`).
- OBSERVED. Source Server transport (`source-server/transportAdapter.ts:1-40`) объединяет probe, release download, daemon start, channel и target lifecycle; shell-аргументы квотируются (`sourceServerTransportRuntime.ts:11-13`); JSON-результат ищется с конца, чтобы пережить шум stderr (`:22-38`).

### 3.8 Remote-семантика (replayable vs continuous, identity, attachment)

- OBSERVED (код). `packages/server/src/http.ts:92` — `clientMode` параметр; `:387-399` `/ws` жёстко replayable (старый `x-zcode-rpc-client-mode` игнорируется — комментарий `:385-386`); `:401-419` `/ws/host` требует capability и создаёт continuous; capability — 32 random bytes, TTL 30 s, ровно одно потребление (`hostCapability.ts:4-52`), тест `serverRemoteConnection.test.ts:610-651`.
- OBSERVED (код). Desktop-side allowlist для мобильных attachment: `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts:16-80` — явный набор каналов, Terminal и SourceServerManagement отсутствуют, неизвестные каналы fail-closed. Это закрывает R3-ISSUE-003 (`docs/architecture/r3-source-server-remote-open-issues.md:116-126`, статус «已关闭»).
- OBSERVED (код). Identity-key: `workspaceIdentity?.trim() || workspacePath` (`packages/shared/src/web-remote-control.ts:744-748`); mobile `main.tsx:137-145` отказывается писать task-read в чужой workspace; `workspaceBridgeSession` регистрирует `remoteSessionId` + identity/path (`:96-110`).
- OBSERVED (спецификация). `docs/web-remote-control/web-remote-control-architecture.md:31-43` — разделение owner: desktop continuous, mobile replayable, relay только транспорт; `:152-160` — `bridge-degraded` как invalidation latch и обязательный терминальный `connection-recovery-timeout`; `:234-252` — `/ws` vs `/ws/host` и capability; `:278-292` — attachment только к существующему `remoteSessionId`.
- OBSERVED (тесты). `packages/web/test/externalRelayFrameGapRecovery.test.ts:345-685` — 13 сценариев: коррекция версии до bridge, повторная проверка при новом pairing, rebuild при degraded во время version check, hard recovery при inbound gap, терминальное состояние после исчерпания retry, маршрутизация raw ACK, сохранение Root при коротком и длинном background. Запущено: 13/13 pass.
- UNKNOWN. Реальная snapshot/gap/queue-механика (`{logEpoch, seq}`, `commands/query`, CommandInbox) живёт в `apps/zcode-cli`/`packages/services`; в Z03 она подтверждена только спецификацией и тестами web-entry, не собственным кодом `packages/server`.

### 3.9 Эксплуатация (operations)

- OBSERVED. Health/readiness endpoint отсутствует: поиск `healthz|readyz|livez|/metrics|prometheus|opentelemetry` по `packages/server/src`, `packages/web/src`, `packages/zcode-server-cli/src` не дал результатов. Единственный «health-ish» ответ — `/api/server-info`.
- OBSERVED. Graceful shutdown в `entry-http.ts` не реализован: файл заканчивается `main().catch(...)` (`:43-46`), обработчиков `SIGTERM/SIGINT` нет. Для сравнения: stdio имеет `stdio-lifecycle.ts:3` (`SIGHUP/SIGTERM/SIGINT`), а Server Core — `close()` c `closeWebSocketServer` (250 ms drain, затем `terminate`) — `packages/zcode-server-cli/src/server-core/http.ts:54-69`, `:322-327`.
- OBSERVED. Distribution runner: `zcode --web` по умолчанию слушает `127.0.0.1`, токен включается только для non-loopback (`runner.mjs:101-107`, `:173-175`), генерируется 24 random bytes (`:109-111`), в URL попадает `?token=` (`:131-135`); дочернему процессу передаются `PORT`, `ZCODE_SERVER_HOST`, `ZCODE_SERVER_WORKSPACE`, `ZCODE_WEB_STATIC_ROOT`, `ZCODE_SERVER_AUTH_TOKEN` (`:178-190`). При остановке — `SIGTERM`, затем `process.exit(0)` через 1.5 s (`:226-233`).
- OBSERVED. Логирование HTTP-слоя — один `console.log` при старте (`http.ts:86-87`, `:491`). RPC-вызовы логируются `LoggingChannelServer` строкой `[rpc:call] channel.command OK/FAIL (ms)` (`packages/rpc/src/logging-middleware.ts:34-51`). В `packages/server` не используется `createServiceLogger` (в отличие от `server-core`, где `http.ts:52`). Request-id/структурированных полей нет.
- OBSERVED. Миграции: `migrateApplicationStorage` вызывается в stdio (`entry-stdio.ts:68`) и внутри `createServerHostServices` (`packages/services/src/node.ts:3322`); HTTP entry получает `migrationFailedPathCount` (`entry-http.ts:23-28`) и публикует его в server-info (`http.ts:192`). SQLite — `node:sqlite` (`packages/services/src/session/tasksDatabase/migrations.ts:1-6`, `:183-206`), схема и ledger версионируются.
- OBSERVED. Мульти-тенантность: один процесс = один Source Server / один workspace по умолчанию (`http.ts:168-179`, env `ZCODE_SERVER_WORKSPACE`); «virtual projects» объявляются capability-флагом (`entry-http.ts:35`, `http.ts:197`). Изоляции нескольких арендаторов на одном HTTP-процессе нет.
- OBSERVED. Фоновых job-очередей в `packages/server` нет (поиск по `queue`, `cron`, `interval` в `src` не показал собственного scheduler; задачи — в services/CLI).

### 3.10 Тесты

- OBSERVED. `packages/web/test`: 36 `.test.ts` (7177 строк) + `packages/web/src/web-remote-control/contract.test.ts`; 18 `manual-review/pending/*.mjs` сценариев (не автоматизированы, «pending»).
- OBSERVED. `packages/server/test`: 29 `.test.ts` (11190 строк). Крупнейшие: `remoteDeploy` 4651, `remoteAssetInstaller` 1230, `sshBackend` 1005, `sourceServerTransportAdapter` 738, `wslBackend` 517.
- OBSERVED. HTTP-покрытие: `serverInfoHttp.test.ts` (6 тестов: metadata, virtualProjects, lite token + capability, non-loopback guard, 404 retired routes, static+SPA), `staticRoutePathContainment.test.ts` (6: drive-qualified, encoded `..`), `botsHttp.test.ts` (4: payload+secret forwarding, unsupported provider, 503 retryable, non-webhook 400), `hostCapability.test.ts` (1: TTL/one-shot).
- OBSERVED (запущено). 15 файлов / 128 тестов, все pass:
  - `packages/server/test/{serverInfoHttp,staticRoutePathContainment,botsHttp,hostCapability}.test.ts` → 17;
  - `packages/web/test/{oauthStateCodec,webAuthService,webRemoteControlLifecycle,webRemoteControlBridgeRecovery,homeOnlyWebRemoteControlServices}.test.ts` → 41;
  - `packages/web/test/{webRemoteControlHttpCompatibility,webRemoteControlDeviceClient,webRemoteControlV2Token,webRemoteControlTaskViewPublisher,webRemoteControlWorkspaceBridgeSession}.test.ts` → 57;
  - `packages/web/test/externalRelayFrameGapRecovery.test.ts` → 13.
- OBSERVED. Конфигурация: root `vitest.config.ts:108-142` — проект `unit` с include `packages/*/test/**/*.test.ts` и `packages/*/src/**/contract.test.ts`, exclude `packages/desktop/test/e2e/**`; отдельный `fork-isolated` список. Запуск из корня: `pnpm test:unit`.
- OBSERVED. В `vitest.config.ts:32` указан файл `packages/web/test/remoteFrontendBuildSource.test.ts`, которого в checkout нет. INFERRED: безвредный stale-entry в списке serial-тестов (не влияет на include), но это признак дрейфа конфигурации.
- OBSERVED. CI: единственный workflow `.github/workflows/cross-platform-preview-release.yml` содержит jobs `desktop`, `cli`, `publish`; шагов `pnpm test`, `vitest`, `pnpm lint`, `pnpm typecheck` нет. `docs/desktop-ci-cd.md:3` описывает `.gitlab-ci.yml` и `.gitlab/ci/*`, которых в checkout нет. UNKNOWN: выполняются ли эти проверки во внешнем CI (инфраструктура вне репозитория).

## 4. Gaps, risks, weaknesses

### 4.1 Воспроизведённые дефекты

**G-01. Malformed percent-encoding в static route даёт HTTP 500.**
OBSERVED. `resolveStaticFile()` вызывает `decodeURIComponent(normalizedPathname)` без try/catch (`packages/server/src/http.ts:298`). Probe:

```
{"path":"/%E0%A4%A","status":500,"type":"text/plain; charset=UTF-8","body":"Internal Server Error"}
URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at resolveStaticFile (/Users/.../packages/server/src/http.ts:298:24)
```

Тот же запрос также печатает stack trace в stderr. Это не path traversal (содержимое не отдаётся), но это необработанный 500 и шум в логах на публичном статическом маршруте. `staticRoutePathContainment.test.ts` этот случай не покрывает.

**G-02. Lite-token cookie не имеет `Secure` и не привязан к TLS-схеме.**
OBSERVED. `http.ts:255`: `zcode_lite_token=...; Path=/; HttpOnly; SameSite=Lax`. `Secure` не выставляется никогда, префикс `__Host-` не используется. Probe:

```
GET /?token=tkn -> 200 set-cookie: zcode_lite_token=tkn; Path=/; HttpOnly; SameSite=Lax
GET /api/server-info (no cookie) -> 401
GET /api/server-info?token=tkn -> 200 set-cookie: ...
GET /assets/app.js (no cookie) -> 200
```

Токен принимается в query и остаётся в cookie без `Secure`; при HTTPS-развёртывании за реверс-прокси флаг не появляется автоматически. `Set-Cookie` не имеет `Max-Age`/`Expires` — сессионный.

**G-03. Под `ZCODE_SERVER_AUTH_TOKEN` webhook-провайдеры обязаны присылать внутренний lite-token.**
OBSERVED. `/api/bots/:provider` попадает под общий `/api/*` middleware (`http.ts:262-264`, `:370-380`). Probe:

```
POST /api/bots/webhook without token -> 401 handlerCalls= 0
POST /api/bots/webhook?token=tkn -> 200 handlerCalls= 1
```

Внешний webhook (Telegram/Feishu/кастомный) не знает `?token=`; в коде нет отдельного provider-secret-only маршрута вне middleware. Это либо недокументированное требование к настройке, либо функциональный блокер для ботов при включённом токене. `docs/bots.md:246-250` описывает только `POST /api/bots/webhook`, без упоминания lite-token.

**G-04. Сравнение webhook-секрета не является timing-safe.**
OBSERVED. `packages/services/src/bots/botsService.ts:3838` (`expectedSecret !== inboundSecret`), `:3855` (`expectedToken !== inboundToken`), `:3714` (`expectedToken !== inboundToken`) — обычное строковое сравнение. Для `server-core` в этом же репозитории есть корректный пример: `timingSafeEqual` в `packages/zcode-server-cli/src/server-core/http.ts:244-256`.

### 4.2 Архитектурные и эксплуатационные разрывы

**G-05. Нет security headers в HTTP-слое.**
OBSERVED. В `packages/server/src/http.ts` и `packages/web/index.html` отсутствуют `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`. Единственные CSP в продуктовом коде — `packages/services/src/cloud-content/cloudContentService.ts:62-64` и desktop plugin sandbox. Спецификация share (`docs/conversation-share-v1.md:226-239`) требует CSP от nginx, но `nginx.web-share.security-headers.conf` в checkout отсутствует. Для `/remote/v4` и обычного Web UI требования к headers не зафиксированы вовсе.

**G-06. Нет проверки Origin на WS upgrade и API.**
OBSERVED. Поиск `req.header("origin")`, `headers.origin`, `Origin` в `packages/server/src`, `packages/rpc/src`, `packages/zcode-server-cli/src` не дал совпадений. Защита `/ws` — только lite-token (`http.ts:262-264`, `:370-380`); cookie `SameSite=Lax` снижает, но не исключает cross-site WS (WS upgrade не подчиняется SameSite в части браузеров/сценариев). При включённом токене и loopback-only это низкий риск; при `--host 0.0.0.0` и токене в URL — выше.

**G-07. Нет rate limiting и ограничения размера тела на HTTP-уровне.**
OBSERVED. В `packages/server/src/http.ts` нет middleware `bodyLimit`/rate-limiter; `handleBotCallback` делает `await c.req.text()` без лимита (`:433`). Аутентификация не ограничивает число попыток подбора `?token=`. RPC-слой имеет собственные лимиты (1 MiB на app payload — `packages/web/src/web-remote-control/adapters/relayMessage.ts:11-40`; flow control — `docs/web-remote-control/web-remote-control-architecture.md:125-137`), но HTTP ingress — нет.

**G-08. Нет health/readiness и graceful shutdown у HTTP entrypoint.**
OBSERVED. `entry-http.ts:43-46` — только `catch`; `SIGTERM` не обрабатывается, `server.close()` не вызывается, `disposeServiceResourcesAndWait` не вызывается. Distribution runner шлёт `SIGTERM` и через 1.5 s делает `process.exit(0)` (`runner.mjs:226-233`), то есть процесс, скорее всего, завершается по дефолтному сигналу без дренажа WS/agent-процессов. Это контрастирует со stdio (`stdio-lifecycle.ts:25+`) и Server Core (`server-core/http.ts:54-69`, `:322-327`).
INFERRED: при `zcode --web` в момент остановки возможны оборванные RPC-сессии и незавершённый cleanup дочерних agent-процессов; runtime-проверка не выполнялась.

**G-09. Документация деплоя ссылается на отсутствующие артефакты.**
OBSERVED. Отсутствуют: `Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx.web-share.conf`, `nginx.web-share.security-headers.conf`, `scripts/test-web-share-build.sh`. При этом на них ссылаются `docs/web-share/web-share-static-deployment.md:13,28,41,43,60`, `docs/web-share/web-share-build-decoupling.md:33`, `docs/conversation-share-v1.md:36,46,226`. `docs/web-remote-control/web-remote-control-architecture.md:56,85,93,95,328` прямо помечает `remote-v4-static-deployment.md` как «已删除», но оставляет ссылки. `docs/desktop-ci-cd.md:3` ссылается на отсутствующий `.gitlab-ci.yml`.
INFERRED: либо деплой-инфраструктура вынесена из публичного checkout, либо документация рассинхронизирована. Проверить по внешнему репозиторию инфраструктуры невозможно — UNKNOWN.

**G-10. Нет публичного health/metrics контура.**
OBSERVED. Метрик (`/metrics`, Prometheus, OTel) в `packages/server`/`packages/web` нет. Телеметрия продукта идёт через ARMS/собственные события (`docs/monitoring/*`), но она не покрывает доступность HTTP-процесса, latency RPC и ошибки ingress.

**G-11. Монолитный web-entry и слабая тестируемость маршрутизации.**
OBSERVED. `packages/web/src/main.tsx` — 2107 строк, содержит bootstrap, OAuth, share, platform, home-only services, relay lifecycle и bridge orchestration; в файле стоит `eslint-disable max-lines` (`:12`). Маршрутизация (`bootstrapWebApp`) проверяется косвенно через `externalRelayFrameGapRecovery.test.ts` (импорт `../src/main.js`) и `homeOnlyWebRemoteControlServices.test.ts`; отдельного теста приоритетов маршрутов (callback → share → remote → web) нет.
INFERRED: любое изменение порядка ветвлений легко ломает один из входов, а тест это поймает только при совпадении сценария.

**G-12. Размер бандла и карт.**
OBSERVED. `packages/web/dist/assets/index-7oewE0-r.js` — 6.7 MB (gzip ~2.0 MB), суммарно `dist/assets` — 144 MB, 2219 `.map` файлов (~92 MB), 4799 файлов в `assets`. Dynamic import в `packages/web/src` только один — mock share client (`main.tsx:355-359`); остальное статически связано через `@zcode/ui`. `material-icons` — 1146 файлов / 4.6 MB.
INFERRED: на мобильном web первый payload заметно тяжелее, чем нужно для `/remote/v4`; production-сборка генерирует `.map`, которые могут быть опубликованы вместе с `dist`, если публикация копирует каталог целиком (в текущем `index-*.js` аннотации нет).

**G-13. OAuth без PKCE, токены в localStorage.**
OBSERVED. PKCE отсутствует; `zcodejwttoken` и provider access tokens лежат в `localStorage` (`browserOAuthCredentialRepo.ts:12-20`, `:95-106`). `localStorage` доступен любому JS на origin; при XSS (в т.ч. через встраиваемый контент в UI) токены читаемы. Спецификация `docs/web-remote-control/web-remote-login.md` («存储与边界») фиксирует это как текущее решение, не как временное.
INFERRED: риск ограничен доверенным same-origin кодом и отсутствием сторонних скриптов, но CSP отсутствует (G-05), поэтому компенсирующего контроля нет.

**G-14. Нет автоматизированного E2E для web/server в репозитории.**
OBSERVED. 18 сценариев `packages/web/test/e2e/manual-review/pending/*.mjs` не входят в Vitest include (`vitest.config.ts:113-122`). `docs/web-remote-control/relay-v2-pairing.md:622-636` фиксирует матрицу из 7 реальных сценариев как «未执行». `docs/web-remote-control/relay-v2-pairing.md:603-607` перечисляет известные ограничения (старые QR-ссылки, отсутствие meta у offline-устройств, неоднозначность `KICKED`).

**G-15. `?remote=` ветка в web мертва и не диагностируется.**
OBSERVED. `main.tsx:683-690` формирует `/ws/remote/<id>`, сервер этот маршрут не регистрирует (`http.ts:468-470`, тест `serverInfoHttp.test.ts:158-162`). `connectRemote` явно возвращает ошибку (`main.tsx:482-505`). Пользователь с legacy-ссылкой получит отказ подключения без указания, что маршрут удалён.
INFERRED: диагностируемость хуже, чем у явного 404 на уровне сервера.

**G-16. Remote deploy: shell-поверхность и сетевые допущения.**
OBSERVED. Команды формируются конкатенацией с `quotePosixShellArg` (`ssh-backend.ts:290-367`, `docker-backend.ts:185`, `remoteDeployLock.ts:39-72`); wildcard-пути в deploy lock (`rm -rf "$stale_dir"`) ограничены каталогом lock. `remoteAssetCache.ts:1171` использует `fetchImpl(candidate)` без ограничения redirect и без явного таймаута на скачивание артефакта (таймаут есть только у manifest — `:1195`). INFERRED: SSRF-риск ограничен тем, что URL-кандидаты берутся из конфигурации/манифеста CDN, а не из пользовательского ввода напрямую; но при компрометации манифеста redirect может увести загрузку на произвольный хост.

## 5. Strengths and differentiators

- OBSERVED. **Жёсткая граница режимов доступа.** `/ws` всегда replayable, `/ws/host` — только по one-time capability на 30 s (`http.ts:385-419`, `hostCapability.ts:4-52`). Старый mode-header игнорируется (`http.ts:385-386`), попытка реплея capability отклоняется (тест `serverRemoteConnection.test.ts:610-651`).
- OBSERVED. **Allowlist вместо denylist для мобильных RPC-каналов.** `windowHostAttachmentRpcPolicy.ts:16-80` перечисляет разрешённые каналы; Terminal/SourceServerManagement/ProviderProvisioningTarget отсутствуют; неизвестный канал fail-closed. Это прямое исправление класса уязвимостей «новая привилегированная служба автоматически доступна телефону».
- OBSERVED. **Защита статики от traversal.** Drive-qualified пути блокируются до `resolve` (`http.ts:272-276`, `:301-303`), containment проверяется `path.relative` с обработкой Windows cross-drive (`:281-289`), SPA fallback не применяется к `/api`/`/ws` (`:326-328`); есть тесты на `Z:/`, `%3A`, encoded `..`.
- OBSERVED. **Явный fail-closed при сетевом слушании.** Non-loopback без токена не запускается (`http.ts:361-369`), это покрыто тестом (`serverInfoHttp.test.ts:140-144`).
- OBSERVED. **Дисциплина секретов в web-конфиге.** `vite.config.ts:44` запрещает secret/token через `VITE_`; в `webZaiOAuthConfig.ts:57` зафиксировано, что client_id — публичный; share-preview client не логирует share code/JWT/Signed URL (`conversationSharePreviewClient.ts:84-93`).
- OBSERVED. **Строгий разбор relay-сообщений.** 1 MiB лимит до `JSON.parse` (`relayMessage.ts:11-40`), zod-схемы shared, безопасные метаданные в трассировке (`:69-80`, `:88-110`), one-time token не кэшируется и не попадает в UI/логи (`webRemoteControlV2Token.ts:8`, `:39-43`).
- OBSERVED. **Восстановление bridge с единственным owner.** `createWebRemoteControlBridgeRecoveryRunner` сериализует recovery (`bridgeRecovery.ts:8-28`); lifecycle не запускает лишний socket до реальной приостановки (`lifecycle.ts:28-34`); при исчерпании бюджета — явное терминальное состояние с ручным retry (`main.tsx:1260-1279`).
- OBSERVED. **Identity-изоляция по `workspaceIdentity || workspacePath`** сквозная: shared helper (`packages/shared/src/web-remote-control.ts:744-748`), отказ от cross-workspace task-read (`main.tsx:136-145`), регистрация remote session (`workspaceBridgeSession.ts:96-110`).
- OBSERVED. **Богатая инвентаризация remote deploy.** 4651 строк тестов `remoteDeploy`, 1230 `remoteAssetInstaller`, 1005 `sshBackend` — покрытие включает отмену, освобождение backend, поздние ошибки SSH, deploy lock, Windows rename, CDN fallback.
- OBSERVED. **Строгая валидация deploy-путей.** `normalizeRemoteAssetRelativePath` (`remoteAssetCdn.ts:84-118`) отсекает `\`, absolute/drive, `.`/`..`, пустые сегменты — прямой барьер path traversal на remote.
- OBSERVED. **Lifecycle stdio-сервера с бюджетом.** Явные таймауты 1 s на RPC stop и 3.5 s на dispose (`stdio-lifecycle.ts:4-5`), redirect `console.*` в stderr, чтобы не портить RPC-поток (`entry-stdio.ts:27-34`).
- OBSERVED. **Replayable/continuous разделены на уровне типа соединения, а не UI-параметра.** `clientMode` приходит из доверенного attachment scope (`http.ts:104-116`; `docs/...architecture.md:294-304`), а не из заголовка клиента.

## 6. Candidate recommendations

### R-01. Устранить 500 на malformed percent-encoding в static route
- **Problem/gap:** `decodeURIComponent` в `resolveStaticFile` не защищён; `/%E0%A4%A` даёт 500 и stack trace в stderr (G-01).
- **ZCode evidence:** `packages/server/src/http.ts:298`; probe-вывод в §4.1; отсутствие кейса в `packages/server/test/staticRoutePathContainment.test.ts:88-101`.
- **Proposed solution:** обернуть decode в try/catch и возвращать `null` (→ 404/SPA-fallback по обычным правилам), не логируя stack; либо отклонять такие пути 400 до `resolve`.
- **Scope:** только `packages/server/src/http.ts` + тест. **Out of scope:** изменения SPA fallback и MIME.
- **Expected effect:** публичный статический маршрут перестаёт быть источником 500 и шума; поведение становится детерминированным.
- **Risks:** можно случайно сломать обработку легитимных encoded путей (`%20`, unicode) — нужен тест на успешный decode.
- **Complexity:** S. **Priority:** P0 (тривиальный дефект с воспроизведением).
- **Acceptance criteria:** `GET /%E0%A4%A` → 404; `GET /%20file.txt` и unicode-имя → корректный файл; в stderr нет `URIError`.
- **Verification:** новый кейс в `staticRoutePathContainment.test.ts` + повторный probe.

### R-02. Привести lite-token cookie к TLS-корректному виду и убрать токен из query там, где можно
- **Problem/gap:** `Set-Cookie` без `Secure`, без срока, имя без `__Host-`; токен принимается в query и остаётся в истории/логах/Referer (G-02).
- **ZCode evidence:** `packages/server/src/http.ts:243-260`; probe в §4.1; distribution формирует URL с `?token=` (`scripts/zcode-distribution/runner.mjs:131-135`, `:173-176`).
- **Proposed solution:** выставлять `Secure` при `X-Forwarded-Proto: https` или `options.secureCookies`; добавить `Max-Age`; рассмотреть `__Host-zcode_lite_token`; для распределения — обменять query-токен на cookie и делать `history.replaceState` без токена.
- **Scope:** `http.ts` middleware + runner URL. **Out of scope:** переход на OAuth/JWT для local Web.
- **Expected effect:** снижение утечки токена через URL и защита cookie на HTTPS-развёртываниях.
- **Risks:** `Secure` ломает HTTP-loopback сценарии; `__Host-` требует `Path=/` и отсутствие `Domain` — совместимо, но требует проверки старых браузеров.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** при HTTPS-cookie содержит `Secure; HttpOnly; SameSite=Lax`; при HTTP loopback — прежнее поведение; URL после `replaceState` не содержит `token`; тесты на оба режима.
- **Verification:** юнит-тест middleware + ручной probe на два режима.

### R-03. Вынести bots-webhook из-под общего lite-token middleware и сделать сравнение секрета timing-safe
- **Problem/gap:** внешний webhook получает 401 без `?token=` (G-03), а секрет сравнивается `!==` (G-04).
- **ZCode evidence:** `packages/server/src/http.ts:262-264`, `:370-380`, `:465-466`; `packages/services/src/bots/botsService.ts:3714`, `:3838`, `:3855`; probe в §4.1.
- **Proposed solution:** отдельный маршрут (например `/api/bots/webhook` вне token-protected prefix) с обязательной проверкой провайдерского секрета через `crypto.timingSafeEqual` и ограничением по размеру тела; либо явно документировать `?token=` и добавить его в настройку webhook.
- **Scope:** `http.ts` routing + `botsService` comparison. **Out of scope:** изменение протоколов провайдеров.
- **Expected effect:** webhook-боты работают при включённом токене без утечки внутреннего токена третьим лицам; устранён timing-oracle.
- **Risks:** ослабление общего middleware для одного пути требует отдельной аутентификации; ошибка в allowlist откроет callback без секрета.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** без секрета → 401; с неверным секретом → 401; с верным → 200; без `?token=`; сравнение через `timingSafeEqual`; размер тела ограничен.
- **Verification:** расширить `packages/server/test/botsHttp.test.ts` кейсами под `authToken` и timing-safe-мок.

### R-04. Добавить security headers и Origin-allowlist для HTTP/WS ingress
- **Problem/gap:** нет CSP/XFO/nosniff/Referrer-Policy; нет проверки `Origin` на upgrade (G-05, G-06); share-спека полагается на отсутствующий nginx-конфиг.
- **ZCode evidence:** отсутствие заголовков в `packages/server/src/http.ts`; `docs/conversation-share-v1.md:226-239`; `docs/web-remote-control/web-remote-control-architecture.md:62-95`; отсутствие `nginx.web-share.security-headers.conf`.
- **Proposed solution:** Hono middleware, выставляющее базовый набор заголовков для HTML/asset-ответов; для share — CSP из спеки (`img-src 'self' data: blob:`, `script-src 'self' 'wasm-unsafe-eval'`); на WS upgrade — проверять `Origin` против same-origin/allowlist, отклонять cross-origin.
- **Scope:** `http.ts` (middleware + upgrade hooks), конфиг заголовков. **Out of scope:** политика CSP для desktop Electron.
- **Expected effect:** закрывается класс XSS/tracking-pixel/clickjacking и cross-site WS.
- **Risks:** слишком строгая CSP ломает shiki wasm, inline theme bootstrap в `index.html`, `data:` favicon; нужен точный список директив и тест на реальном bundle.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** share и `/remote/v4` отдают заданные заголовки; cross-origin WS upgrade → 403; same-origin → 200; shiki-подсветка и inline theme работают (smoke-тест браузера).
- **Verification:** HTTP-тесты заголовков + браузерный smoke на share/remote.

### R-05. Добавить `/healthz` (liveness) и корректный graceful shutdown для HTTP entrypoint
- **Problem/gap:** нет health endpoint и обработки сигналов; distribution убивает процесс через 1.5 s (G-08, G-10).
- **ZCode evidence:** `packages/server/src/entry-http.ts:43-46`; `scripts/zcode-distribution/runner.mjs:226-233`; положительный пример — `packages/zcode-server-cli/src/server-core/http.ts:54-69`, `:322-327`; `packages/server/src/stdio-lifecycle.ts:25+`.
- **Proposed solution:** `GET /healthz` (200 при живом процессе, опционально проверка БД), `SIGTERM`/`SIGINT` → `server.close()`, закрытие WS с drain-бюджетом, `disposeServiceResourcesAndWait(services)` с таймаутом, затем exit.
- **Scope:** `entry-http.ts`, `http.ts` (возврат закрывающей ручки), runner. **Out of scope:** k8s-манифесты.
- **Expected effect:** предсказуемый rolling restart, отсутствие оборванных RPC и осиротевших agent-процессов, возможность liveness-probe.
- **Risks:** таймаут dispose может увеличить время остановки; неверный порядок закроет транспорт до flush.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** `GET /healthz` → 200; SIGTERM → процесс завершается ≤ N s, WS получают close-frame, дочерние процессы очищены; exit code 0.
- **Verification:** интеграционный тест с реальным сервером и фейковым WS-клиентом; повтор distribution-runner stop.

### R-06. Ограничить размер тела и добавить rate limiting на ingress
- **Problem/gap:** `c.req.text()` без лимита, нет rate limit на token-попытки и API (G-07).
- **ZCode evidence:** `packages/server/src/http.ts:433`; отсутствие `bodyLimit`/limiter в `http.ts`; `packages/web/src/web-remote-control/adapters/relayMessage.ts:11-40` как существующий лимит на другом слое.
- **Proposed solution:** `hono/body-limit` (или аналог) на `/api/bots/*` (например 1 MiB), общий лимит на JSON-API, простой in-memory limiter по IP+token для неудачных auth.
- **Scope:** `http.ts`. **Out of scope:** распределённый rate limit (Redis) и WAF.
- **Expected effect:** защита от memory-DoS и подбора токена; стабильная latency под мусорным трафиком.
- **Risks:** ложные 413 на легитимных webhook с большими payload; in-memory limiter не работает между процессами.
- **Complexity:** S/M. **Priority:** P2 (при loopback-only) / P1 при `--host 0.0.0.0`.
- **Acceptance criteria:** тело > лимита → 413; серия неверных токенов → 429; легитимный webhook ≤ лимита проходит.
- **Verification:** HTTP-тесты с большим телом и серией запросов.

### R-07. Синхронизировать документацию деплоя с фактическим содержимым репозитория
- **Problem/gap:** docs ссылаются на отсутствующие `Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx.web-share*.conf`, `scripts/test-web-share-build.sh`, `.gitlab-ci.yml` (G-09).
- **ZCode evidence:** `docs/web-share/web-share-static-deployment.md:13,28,41,43,60`; `docs/web-share/web-share-build-decoupling.md:33`; `docs/conversation-share-v1.md:36,46,226`; `docs/desktop-ci-cd.md:3`; факт отсутствия подтверждён `ls`/`git ls-files`.
- **Proposed solution:** либо вернуть конфиги в репозиторий, либо переписать docs как «инфраструктура внешняя, путь X», удалив мёртвые ссылки; для `remote-v4-static-deployment.md` — либо восстановить файл, либо убрать ссылки полностью.
- **Scope:** только docs (+ возможно восстановление артефактов). **Out of scope:** изменение самой deployment-инфраструктуры.
- **Expected effect:** новый инженер может воспроизвести деплой; `pnpm verify:links` перестанет находить мёртвые ссылки.
- **Risks:** если артефакты существуют во внешнем репозитории, неверная формулировка снова разойдётся; нужен владелец инфраструктуры.
- **Complexity:** S. **Priority:** P2.
- **Acceptance criteria:** все ссылки в docs разрешаются; для внешних артефактов указан точный источник; `verify:links` проходит на затронутых файлах.
- **Verification:** `node scripts/check-doc-links.mjs` + `pnpm verify:links`.

### R-08. Разделить `packages/web/src/main.tsx` на модули bootstrap/routing/platform
- **Problem/gap:** 2107 строк, несколько ответственностей, маршрутизация не покрыта отдельным тестом (G-11).
- **ZCode evidence:** `packages/web/src/main.tsx:12` (`eslint-disable max-lines`), `:2032-2107` (routing), `:456-675` (platform), `:783-1042` (home-only), `:1066-1494` (relay lifecycle).
- **Proposed solution:** вынести `resolveWebRoute(kind)` (чистая функция приоритетов), `createWebPlatform` и `createHomeOnlyWebRemoteControlServices` в отдельные модули; `main.tsx` оставить orchestration ≤ ~300 строк.
- **Scope:** `packages/web/src`. **Out of scope:** изменение поведения/контрактов.
- **Expected effect:** тестируемый приоритет маршрутов, меньшая вероятность регрессий при добавлении входа, проще code review.
- **Risks:** механический рефакторинг большого файла; нужен снапшот поведения до/после.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** чистая функция маршрутизации покрыта табличным тестом (callback/share/remote/web/invalid); существующие 36 web-тестов проходят без изменения ожиданий.
- **Verification:** новый `webRouteResolution.test.ts` + полный прогон `packages/web/test`.

### R-09. Исключить source maps из публикуемого web-дистрибутива и уменьшить стартовый payload
- **Problem/gap:** 2219 `.map` (~92 MB) и 144 MB `assets`; index-бандл 6.7 MB / ~2.0 MB gzip (G-12).
- **ZCode evidence:** `vite.config.ts:111-114`; `du -sh packages/web/dist/assets` → 144M; `find ... -name "*.map" | wc -l` → 2219; `gzip -c index-*.js | wc -c` → 2001190; единственный dynamic import — `main.tsx:355-359`.
- **Proposed solution:** `build.sourcemap: false` для production-артефакта (или отдельный debug-артефакт), исключить `.map` из stage в `scripts/build-zcode.mjs:157+`, вынести тяжёлые preview-модули (Office/PDF) в lazy import по требованию.
- **Scope:** `packages/web/vite.config.ts`, `scripts/build-zcode.mjs`, точечные dynamic imports. **Out of scope:** переписывание UI-компонентов.
- **Expected effect:** меньше размер образа/OSS-каталога, быстрее первый payload `/remote/v4` на мобильном.
- **Risks:** lazy import может ухудшить UX первого открытия preview; source maps нужны для диагностики — хранить как отдельный артефакт.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** production `dist` не содержит `.map`; index-бандл ≤ согласованного бюджета; preview-функции работают после lazy load.
- **Verification:** `vite build` + `du`, smoke share/remote/обычный Web.

### R-10. Ввести PKCE и рассмотреть перенос долгоживущих токенов из localStorage
- **Problem/gap:** OAuth authorization-code без PKCE; JWT/access tokens в `localStorage`; CSP отсутствует (G-13, G-05).
- **ZCode evidence:** отсутствие `code_challenge` (поиск по `packages/web/src`, `packages/shared/src`); `browserOAuthCredentialRepo.ts:12-20`, `:95-106`; `webZaiOAuthProvider.ts:184-191`.
- **Proposed solution:** добавить `code_challenge`/`code_verifier` (S256) в authorize/token exchange; оценить хранение JWT в `HttpOnly`-cookie через same-origin `/api` и CSRF-токен; минимум — сократить TTL и добавить CSP.
- **Scope:** web OAuth + серверный обмен кода. **Out of scope:** смена OAuth-провайдера.
- **Expected effect:** украденный authorization code нельзя обменять без verifier; XSS не даёт немедленного доступа к токенам при cookie-варианте.
- **Risks:** серверный endpoint обмена должен поддерживать PKCE; cookie-вариант требует CSRF-защиты и меняет контракт `/api/v1/oauth/token`.
- **Complexity:** M/L. **Priority:** P2 (P1 при появлении сторонних скриптов на origin).
- **Acceptance criteria:** authorize URL содержит `code_challenge`; token exchange отправляет `code_verifier`; без verifier обмен отклоняется; существующие логины работают.
- **Verification:** юнит-тесты `webAuthService` + интеграция с фейковым token endpoint.

### R-11. Добавить интеграционный тест полного web-bootstrap против реального сервера
- **Problem/gap:** маршрутизация и bootstrap проверяются моками; E2E — pending (G-14).
- **ZCode evidence:** `vitest.config.ts:113-122`; `packages/web/test/e2e/manual-review/pending/` (18 файлов); `serverInfoHttp.test.ts` поднимает реальный сервер, но web-entry к нему не подключается.
- **Proposed solution:** тест, который поднимает `createHttpServer` со `staticRoot` и `ServiceCollection`, открывает страницу в jsdom/happy-dom и проверяет порядок веток и наличие `/api/server-info` + `/ws`; либо минимальный Playwright-сценарий в CI.
- **Scope:** `packages/web/test`, `packages/server/test`. **Out of scope:** полный remote relay E2E.
- **Expected effect:** ловит регрессии вида «share перехватил `/remote`» и «bootstrap не нашёл server-info» до релиза.
- **Risks:** jsdom не поддерживает WebSocket нативно; может потребоваться `ws`-полифилл.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** тест проходит на реальном HTTP-сервере; падает при инверсии приоритетов маршрутов.
- **Verification:** запуск нового теста + мутационная проверка (временно поменять порядок веток локально).

## 7. Open questions and unverified

1. **UNKNOWN.** Где выполняется CI для `pnpm test:unit`/`lint`/`typecheck`? В checkout есть только GitHub workflow релиза без тестовых шагов; `docs/desktop-ci-cd.md:3` ссылается на отсутствующий `.gitlab-ci.yml`. Требуется доступ к инфраструктурному репозиторию.
2. **UNKNOWN.** Публикуются ли `.map`-файлы вместе с `packages/web/dist` в OSS/nginx. В текущем бандле нет `sourceMappingURL`, но сами карты лежат рядом. Нужен доступ к publish-скрипту (в checkout его нет).
3. **UNKNOWN.** Существуют ли `Dockerfile.web-share`/`Jenkinsfile.web-share`/`nginx.web-share*.conf` во внешнем репозитории; от этого зависит реальность CSP для share (G-09).
4. **UNKNOWN.** Требует ли продовый webhook-провайдер ручной подстановки `?token=`; нет документации и нет теста `botsHttp` под `authToken`. Нужен ответ владельца Bots.
5. **HYPOTHESIS.** `SIGTERM` при `zcode --web` приводит к немедленному завершению без cleanup, поскольку `entry-http.ts` не регистрирует обработчик. Проверка: запустить distribution runner, отправить SIGTERM, проверить логи и наличие дочерних процессов.
6. **HYPOTHESIS.** `?remote=` ветка (`main.tsx:683-690`) недостижима и должна быть удалена. Проверка: grep по документации/QR-генераторам на `/ws/remote/`, поиск в desktop main.
7. **UNKNOWN.** Полный набор remote snapshot/gap/queue инвариантов в runtime (`logEpoch`, `seq`, `CommandInbox`, `commands/query`) — вне scope Z03; подтверждён только спецификациями `docs/web-remote-control/task-realtime-sync.md`, `docs/web-remote-control-task-command-queue.md` и web-тестами entry. Нужен отдельный исследователь по `apps/zcode-cli`.
8. **UNKNOWN.** Влияние отсутствия `Origin`-проверки на реальные браузеры при `SameSite=Lax` cookie: теоретический cross-site WS-сценарий не воспроизводился (запрет на эксплуатацию по условию задачи).
9. **UNKNOWN.** Полный `pnpm typecheck`/`pnpm lint` статус для `packages/web`/`packages/server` на этом HEAD: не запускались (ограничение envelope). Узкие тесты проходят.
10. **INFERRED.** `vitest.config.ts:32` ссылается на отсутствующий `packages/web/test/remoteFrontendBuildSource.test.ts`; вероятно, безвредно, но требует подтверждения владельцем тестового конфига.

## 8. Evidence appendix

### 8.1 Команды и точный вывод

```
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

CodeIndex `status`: `state: ready`, `partial: false`, `generation: 1453`, `files: 10007`, `chunks: 26791`, `symbols: 278154`, `edges: 377669`, embedding diagnostic: `Embedding search is unavailable; showing lexical results.`

Инвентаризация:

```
packages/web: 113 tracked files (excluding public/material-icons), src 8375 lines
packages/server: 88 tracked files, src 12037 lines
packages/web/test: 36 *.test.ts, 7177 lines, 18 pending E2E *.mjs
packages/server/test: 29 *.test.ts, 11190 lines
packages/web/dist: 153M total; assets 144M; 2219 *.map (~92M); index-*.js 6.7M (gzip 2001190 bytes)
```

Запущенные тесты (все pass):

```
$ node_modules/.bin/vitest run packages/server/test/serverInfoHttp.test.ts \
    packages/server/test/staticRoutePathContainment.test.ts \
    packages/server/test/botsHttp.test.ts packages/server/test/hostCapability.test.ts
Test Files  4 passed (4)
Tests       17 passed (17)

$ node_modules/.bin/vitest run packages/web/test/oauthStateCodec.test.ts \
    packages/web/test/webAuthService.test.ts packages/web/test/webRemoteControlLifecycle.test.ts \
    packages/web/test/webRemoteControlBridgeRecovery.test.ts \
    packages/web/test/homeOnlyWebRemoteControlServices.test.ts
Test Files  5 passed (5)
Tests       41 passed (41)

$ node_modules/.bin/vitest run packages/web/test/webRemoteControlHttpCompatibility.test.ts \
    packages/web/test/webRemoteControlDeviceClient.test.ts packages/web/test/webRemoteControlV2Token.test.ts \
    packages/web/test/webRemoteControlTaskViewPublisher.test.ts \
    packages/web/test/webRemoteControlWorkspaceBridgeSession.test.ts
Test Files  5 passed (5)
Tests       57 passed (57)

$ node_modules/.bin/vitest run packages/web/test/externalRelayFrameGapRecovery.test.ts
Test Files  1 passed (1)
Tests       13 passed (13)
```

Итого: 15 файлов, 128 тестов, 0 падений. Полный suite не запускался.

### 8.2 Probe: static route и malformed encoding

Скрипт (временный, `/tmp`, вне репозитория) поднимал `createHttpServer(new ServiceCollection(), 0, { staticRoot, spaFallback: true })` с `index.html` и `app.js`. Результат:

```
{"path":"/","status":200,"type":"text/html; charset=utf-8","body":"<html>ok</html>"}
URIError: URI malformed
    at decodeURIComponent (<anonymous>)
    at resolveStaticFile (/Users/.../packages/server/src/http.ts:298:24)
{"path":"/%E0%A4%A","status":500,"type":"text/plain; charset=UTF-8","body":"Internal Server Error"}
{"path":"/..%2f..%2fetc/passwd","status":404,"type":"text/plain; charset=UTF-8","body":"404 Not Found"}
{"path":"/a/../../etc/passwd","status":200,"type":"text/html; charset=utf-8","body":"<html>ok</html>"}
{"path":"/app.js%00.txt","status":200,"type":"text/html; charset=utf-8","body":"<html>ok</html>"}
```

Интерпретация: traversal не воспроизведён (404 либо SPA fallback); 500 — подтверждённый дефект обработки кодировки.

### 8.3 Probe: lite-token cookie и protected paths

```
GET /?token= -> 200 set-cookie: zcode_lite_token=tkn; Path=/; HttpOnly; SameSite=Lax
GET /api/server-info (no cookie) -> 401
GET /api/server-info?token= -> 200 set-cookie: zcode_lite_token=tkn; Path=/; HttpOnly; SameSite=Lax
GET /assets/app.js (no cookie) -> 200
GET /ws (no token, HTTP fetch) -> 401
```

### 8.4 Probe: bots webhook под authToken

```
POST /api/bots/webhook without token -> 401 handlerCalls= 0
POST /api/bots/webhook?token= -> 200 handlerCalls= 1
```

### 8.5 Ключевые file:line ссылки

Web:
- `packages/web/package.json:8-13` — scripts без `test`.
- `packages/web/vite.config.ts:30-46`, `:47-61`, `:62-82`, `:96-110`, `:111-114`.
- `packages/web/index.html:1-15`, `:16+` — inline theme bootstrap.
- `packages/web/src/main.tsx:12`, `:189-230`, `:304-321`, `:323-395`, `:397-447`, `:456-675`, `:681-711`, `:783-1042`, `:1044-1064`, `:1066-1494`, `:1594-1608`, `:1645-1756`, `:1758-1853`, `:1966-2012`, `:2014-2029`, `:2032-2107`.
- `packages/web/src/auth/webAuthService.ts:46-58`, `:87-120`, `:122-176`, `:178-208`.
- `packages/web/src/auth/browserOAuthCredentialRepo.ts:12-20`, `:95-106`, `:108-111`, `:164-175`.
- `packages/web/src/auth/oauthStateCodec.ts:17-19`, `:62-81`, `:95-97`, `:105-112`, `:114-155`.
- `packages/web/src/auth/zaiWebOAuthProvider.ts:168-192`, `:194-208`, `:211-239`.
- `packages/web/src/auth/webZaiOAuthConfig.ts:45-67`, `:69-72`.
- `packages/web/src/auth/WebCallbackPage.tsx:16-37`, `:42-57`.
- `packages/web/src/share/conversationSharePreviewClient.ts:15`, `:43-57`, `:84-93`, `:111-135`.
- `packages/web/src/share/conversationShareRoute.ts:11-18`.
- `packages/web/src/share/ConversationShareLandingPage.tsx:34-38`, `:219-223`, `:623-682`, `:774-826`.
- `packages/web/src/web-remote-control/CONTRACT.md:1-9`.
- `packages/web/src/web-remote-control/contract.ts:27-61`.
- `packages/web/src/web-remote-control/app/webRemoteControlEntry.ts:17-26`, `:36-48`, `:77-98`, `:100+`.
- `packages/web/src/web-remote-control/app/webRemoteControlRoute.ts:13-16`.
- `packages/web/src/web-remote-control/app/webRemoteControlVersion.ts:14-77`.
- `packages/web/src/web-remote-control/app/webRemoteControlBridgeRecovery.ts:1-28`.
- `packages/web/src/web-remote-control/app/webRemoteControlLifecycle.ts:17-66`.
- `packages/web/src/web-remote-control/app/webRemoteControlTaskView.ts:9-86`.
- `packages/web/src/web-remote-control/app/webRemoteControlTaskRead.ts:25-42`.
- `packages/web/src/web-remote-control/app/webRemoteControlWorkspaceBridgeSession.ts:26-36`, `:39-83`, `:85-110`.
- `packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts:37-140`, `:763` (длина).
- `packages/web/src/web-remote-control/adapters/relayMessage.ts:11-60`, `:69-80`, `:88-110`.
- `packages/web/src/web-remote-control/adapters/webRemoteControlV2Token.ts:8-44`.
- `packages/web/src/web-remote-control/adapters/webRemoteControlDeviceClient.ts:10-35`.
- `packages/web/src/web-remote-control/adapters/webRemoteControlHttpSignal.ts:2-27`.
- `packages/web-share/src/main.tsx:5-22`.
- `packages/web-share/vite.config.ts:18-33`.

Server:
- `packages/server/package.json:5-19`.
- `packages/server/src/http.ts:47-84`, `:89-140`, `:142-155`, `:157-201`, `:203-260`, `:262-268`, `:271-336`, `:342-380`, `:382-399`, `:401-419`, `:421-466`, `:468-470`, `:471-486`, `:488-496`.
- `packages/server/src/entry-http.ts:12-46`.
- `packages/server/src/hostCapability.ts:4-52`.
- `packages/server/src/stdio.ts:63-108`.
- `packages/server/src/entry-stdio.ts:27-34`, `:42-104`, `:106-144`.
- `packages/server/src/stdio-lifecycle.ts:3-5`, `:25+`.
- `packages/server/src/remote/connect.ts:52-93`, `:110-140`.
- `packages/server/src/remote/handshake.ts:5`, `:20-126`, `:128-158`.
- `packages/server/src/remote/create-backend.ts:6-39`.
- `packages/server/src/remote/backend.ts:32-49`.
- `packages/server/src/remote/sshAuth.ts:26-53`, `:72-111`.
- `packages/server/src/remote/ssh-backend.ts:219-367`, `:531-545`.
- `packages/server/src/remote/docker-backend.ts:174-258`.
- `packages/server/src/remote/remoteDeployLock.ts:7-11`, `:39-72`.
- `packages/server/src/remote/remoteAssetCdn.ts:84-118`, `:120+`.
- `packages/server/src/remote/remoteAssetCache.ts:1162-1182`, `:1184-1235`.
- `packages/server/src/remote/deploy.ts:55-95`.
- `packages/server/src/source-server/transportAdapter.ts:1-40`.
- `packages/server/src/source-server/sourceServerTransportRuntime.ts:11-38`.
- `packages/server/src/source-server/sourceServerProbe.ts:20-40`.
- `packages/server/src/bundledZCodeBuiltinProviderConfig.ts:1+`.
- `packages/server/tsup.config.ts:24-88`.
- `packages/server/build-remote.ts:1-40`.

Shared / cross-cutting:
- `packages/shared/src/web-remote-control.ts:159-164`, `:744-748`, `:750-756`.
- `packages/shared/src/validation.ts:423-428`.
- `packages/rpc/src/protocol.ts:86-178`, `:237-308`.
- `packages/rpc/src/logging-middleware.ts:27-63`, `:79-96`.
- `packages/services/src/collection.ts:4-48`.
- `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts:241-295`.
- `packages/services/src/conversation-share/conversationShareConnectionScope.ts:34-100`.
- `packages/services/src/bots/botsService.ts:3708-3722`, `:3830-3858`.
- `packages/services/src/node.ts:3307-3354`.
- `packages/services/src/session/tasksDatabase/migrations.ts:1-6`, `:183-206`.
- `packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts:16-80`, `:82-111`.
- `packages/zcode-server-cli/src/server-core/http.ts:52`, `:54-69`, `:197-329`.
- `packages/zcode-server-cli/src/server-core/ingressToken.ts:5-17`.
- `packages/zcode-server-cli/src/server-core/hostCapability.ts:20-55`.
- `scripts/zcode-distribution/runner.mjs:12-14`, `:101-111`, `:131-135`, `:170-192`, `:226-249`.
- `scripts/build-zcode.mjs:142-160`.
- `vitest.config.ts:108-142`.
- `.github/workflows/cross-platform-preview-release.yml:24-25`, `:99`, `:158` (jobs desktop/cli/publish).

Docs:
- `docs/web-remote-control/web-remote-control-architecture.md:26-43`, `:62-95`, `:97-160`, `:162-292`, `:294-343`, `:345-393`, `:395-431`.
- `docs/web-remote-control/CONTRACT` — нет; контракт в `packages/web/src/web-remote-control/CONTRACT.md`.
- `docs/web-remote-control/relay-v2-pairing.md:7-24`, `:26-65`, `:67-87`, `:603-620`, `:622-636`.
- `docs/web-remote-control/web-remote-login.md:5-13`, `:32-35` («存储与边界»), `:90-106` («回调落到同一浏览器的其他标签页»).
- `docs/web-remote-control/mobile-remote-workspace-reconnect.md:1-24`.
- `docs/web-remote-control/task-realtime-sync.md:1-11`, `:83-136`, `:137-197`.
- `docs/web-remote-control-task-command-queue.md:1-22`, `:75-110`.
- `docs/web-share/web-share-static-deployment.md:1-61`.
- `docs/web-share/web-share-build-decoupling.md:33` (ссылка на отсутствующий `Dockerfile.web-share`).
- `docs/conversation-share-v1.md:177-239`.
- `docs/security/security-audit-2026-06-09.md:85-104`, `:174-194`.
- `docs/architecture/r3-source-server-remote-open-issues.md:38-67`, `:116-126`.
- `docs/architecture/unified-zcode-lite-server-multi-server-plan.md:415-428`.
- `docs/desktop-ci-cd.md:3-16`.

### 8.6 Coverage status

**Статус: partial.**

Проверено: исходники `packages/web` и `packages/server` полностью инвентаризированы и прочитаны в объёме, достаточном для карты поверхностей; спецификации web-remote-control, share, relay-v2 и R3-issues сопоставлены с кодом; 128 узких тестов выполнены; три HTTP-probe воспроизведены (static path/encoding, lite-token cookie, bots webhook под authToken).

Не проверено: полный `pnpm typecheck`/`pnpm lint`/`pnpm test`; реальный E2E через браузер/реальный relay (запрещён и недоступен); внешняя deployment-инфраструктура (Docker/Jenkins/nginx/GitLab CI — отсутствуют в checkout); snapshot/gap/queue-реализация в `apps/zcode-cli` (вне scope Z03); эксплуатационные сценарии graceful shutdown (только гипотеза).

Подтверждение: единственный записанный файл — `<repo-root>/docs/research/partials/2026-11-11-zcode-03-web-server.md`. Продакшн-файлы не изменялись; `git status --short` до записи содержал только `?? docs/research/`.
