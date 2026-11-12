# ZCode evidence verification (independent audit of 15 partial reports)

Дата: 2026-11-11. Ветка: `dev`. HEAD: `d10f0b69`. Роль: независимый reviewer, read-only кроме этого файла.
Язык: русский. Аудитор не переписывал проверяемый код и не запускал полный набор тестов.

## 1. Method and preflight

### 1.1. Preflight (Observed, точный вывод)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
$ git log --oneline -3
d10f0b69 Выпустить macOS Preview 3.17.102.
bbb756e8 Не красить весь индекс частичным из-за фиктивных паролей в тестах.
fc70a81b Выпустить macOS Preview 3.17.101.
$ git diff --stat
(пусто)
```

На момент старта аудита 15 partial-файлов уже существовали; `git status` показывал только каталог `docs/research/` как untracked. Новых коммитов сверх `d10f0b69` нет.

### 1.2. Что реально выполнялось

| Команда/проверка | Результат |
| --- | --- |
| `wc -l` по 15 partial-файлам | 9003 строки суммарно, 383–783 на файл |
| `rg -n '^## '` по каждому файлу | у всех 15 есть `## 1` … `## 8`; у части есть дополнительные `## Coverage status`, `## Not checked`, `## Статус покрытия` |
| Извлечение всех backtick-путей с `:line` (Python, 3 прохода) | 5346 цитирований, 2179 различных путей, 5070 разрешены в tracked-файлы, 232 неоднозначных basename, 44 цитирования (30 различных путей) не разрешены |
| Проверка диапазонов строк по длине файла | 22 цитирования выходят за фактическую длину после разрешения неоднозначных basename |
| `node scripts/architecture/architecture-check.mjs check` | exit **1**, `violations: 1`, `missing-module-artifact packages/services/src/gen-ui` |
| `node scripts/architecture/architecture-check.mjs check --changed` | exit **0**, `violations: 0` |
| `npx oxfmt --check` | exit **1**, 164 файла (30 repo-owned, 106 `.agents/skills`, 28 `docs/research`) |
| `node scripts/check-doc-links.mjs` | exit **0**, `1693 файла, 2472 ссылки` |
| `cd apps/dev-docs && npx vitest run` | **1 failed / 3 passed files**; `featureBoundaryGraph.test.ts`: ожидается 324/629, реально 417/803 |
| `npx vitest list --project=unit` | 19 889 тестовых записей; `.test.tsx` — **0** |
| `npx vitest list --project fork-isolated` | 506 кейсов; после разрешения путей — **22 файла** |
| `node --version`, `pnpm --version` | `v26.9.0`, `10.33.2` |
| Сканирование `~/.zcode/cli/log/zcode-2026-11-*.jsonl` | 4 строки >100 KB за 11-08…11-11; 2 строки >1 MB 11-11; крупнейшая 1 464 655 B |
| Мини-probe `decodeURIComponent('%E0%A4%A')` | бросает `URIError`; тестовый HTTP-handler отдаёт 500 |
| Проверка Electron typings | `sandbox` по умолчанию `true` с Electron 20 (`node_modules/electron/electron.d.ts:18827`) |

Не выполнялись: `pnpm typecheck`, `pnpm lint`, полный `pnpm test:unit`, E2E, `pnpm knip`, `pnpm db:schema:check`, desktop packaging/runtime. Поэтому утверждения о «зелёном» статусе этих гейтов не подтверждены ни у одного филиала.

### 1.3. Ограничения метода

- CodeIndex использовался только как указатель (`state=ready`, generation 1489). Все load-bearing факты перепроверены `nl -ba`/`rg`/`node -e`, но не runtime-прогоном продукта.
- Bare-basename цитаты вида `steering.ts:510-540` разрешались по контексту секции (обычно `runtime/methods/...`). Там, где контекст неоднозначен, это отмечено в §4.
- Логи `~/.zcode/cli/log` живые: файл 11-11 вырос после написания Z11, поэтому абсолютные размеры в отчёте Z11 не воспроизводятся побайтно; направление и структура — воспроизводятся.

## 2. Partial completeness

| # | Файл | Строк | Размер | `## 1`–`## 8` | Доп. заголовки |
| --- | --- | --- | --- | --- | --- |
| 01 | `2026-11-11-zcode-01-inventory.md` | 711 | 79 780 B | есть все | `## Coverage status` |
| 02 | `2026-11-11-zcode-02-desktop.md` | 383 | 78 533 B | есть все | — |
| 03 | `2026-11-11-zcode-03-web-server.md` | 587 | 84 981 B | есть все | — |
| 04 | `2026-11-11-zcode-04-ui.md` | 699 | 114 241 B | есть все | — |
| 05 | `2026-11-11-zcode-05-services-session.md` | 440 | 73 864 B | есть все | — |
| 06 | `2026-11-11-zcode-06-rpc-shared-client.md` | 442 | 70 196 B | есть все | — |
| 07 | `2026-11-11-zcode-07-cli-runtime-agent-loop.md` | 725 | 98 846 B | есть все | — |
| 08 | `2026-11-11-zcode-08-tools-providers.md` | 575 | 84 402 B | есть все | `## Coverage status` |
| 09 | `2026-11-11-zcode-09-context-memory-skills-mcp.md` | 783 | 97 021 B | есть все | — |
| 10 | `2026-11-11-zcode-10-subagents-orchestration-protocols.md` | 712 | 99 773 B | есть все | `## Coverage status` |
| 11 | `2026-11-11-zcode-11-telemetry-perf-reliability.md` | 734 | 106 170 B | есть все | `## Coverage status`, `## Not-checked list` |
| 12 | `2026-11-11-zcode-12-security-trust.md` | 521 | 79 618 B | есть все | `## Статус покрытия`, `## Not checked`, `## Подтверждение записи` |
| 13 | `2026-11-11-zcode-13-git-pr-editor-residual-packages.md` | 611 | 79 765 B | есть все | `## Coverage status`, `## Not-checked list` |
| 14 | `2026-11-11-zcode-14-testing-ci-docs-dx.md` | 491 | 79 015 B | есть все | — |
| 15 | `2026-11-11-zcode-15-product-onboarding-marketplace.md` | 589 | 89 930 B | есть все | — |

Все 15 файлов существуют, непустые, содержат обязательные восемь секций. Структурных пропусков нет. Все заявляют `read-only` режим; ни один не заявляет запуск полного unit/E2E/typecheck (кроме узких прогонов, перечисленных в их §8).

## 3. Claim verification table

Ниже — 182 проверенных load-bearing утверждения: по 12 на каждый отчёт, Z01 — 14 (требование «8+ на отчёт» перевыполнено). «Confirmed» = совпадает с источником/воспроизводится; «Corrected» = вывод верный, но число/строка/область отличаются; «Unverifiable» = нельзя подтвердить без runtime/внешних данных; «Invented» = цитируемого файла/строки нет и это не проекция пути.

### 3.1. Z01 — inventory

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `mise.toml` pin node=24.14.0, pnpm=10.33.2 | `mise.toml:2` | Confirmed | `mise.toml:1-3` содержит оба значения | — |
| 2 | local node 26.9.0 проходит `ci:assert-node` (major ≥ 24) | `scripts/assert-node-version.mjs:94-104`; `node --version` | Confirmed | `:96-100` проверяет `major < 24`; `node --version` → `v26.9.0` | — |
| 3 | full `architecture:check` падает на `gen-ui`, `--changed` зелёный | прогон в §7/§8 | Confirmed | exit 1 / exit 0 воспроизведены | Файла `packages/services/src/gen-ui/contract.test.ts` действительно нет |
| 4 | `fmt:check` красный, 145 файлов | `npx oxfmt --check` | Corrected | Сейчас exit 1, **164** файла (30 repo-owned + 106 `.agents` + 28 research) | 145 — состояние на момент прогона Z01; дрейф вырос. В Z14 указано 160 — тоже уже неактуальное значение |
| 5 | `verify:pre-push` состоит из 14 шагов без typecheck/fmt | `package.json:51` | Confirmed | строка скрипта содержит 14 `&&`-шагов; `typecheck`/`fmt:check` отсутствуют | — |
| 6 | 3131 unit-файл вне desktop E2E; 575 E2E; 909 CLI-тестов | `git ls-files` в §8 | Confirmed | 3131 / 575 / 909 воспроизводятся | — |
| 7 | 2088 tracked `docs/*.md`, 2486 файлов, 67 MB | `git ls-files`, `find`, `du` | Corrected | 2088 md / **2505** файлов / **69M**; `docs/**/*.md` = 1803 | `docs/*.md` действительно 2088, но дерево уже другое; «67 MB» устарело |
| 8 | `docs/README.md`/`docs/index.md` отсутствуют | `ls` | Confirmed | оба отсутствуют | — |
| 9 | 2 include-пути Vitest битые | `vitest.config.ts:120-121` | Confirmed | оба файла отсутствуют | — |
| 10 | `scripts/test` = 37 тестовых файлов | `ls -1 scripts/test` | Corrected | 36 tracked `*.test.mjs` + 1 fixture без `.test` = 37 файлов; тестов 36 | Формулировка «37 тестовых файлов» завышает число тестов на 1 |
| 11 | CLI-тесты не входят в root typecheck/pre-push | `package.json:69`, `:51` | Confirmed | `zcode-cli` не встречается ни в `typecheck`, ни в `verify:pre-push` | — |
| 12 | `architecture-policy.yaml` = 1106 строк, 107 модулей, 51 managed | `architecture-policy.yaml` | Confirmed | 1106 строк; `grep -c '^  - id:'` = 107; `managed: true` = 51 | — |
| 13 | CUA — placeholder, fail-closed | `packages/zcode-cua/package.json` | Confirmed | description: «every runtime surface reports unavailable and fails closed» | — |
| 14 | `packages/android` без `package.json` | `ls` | Confirmed | файла нет | — |

### 3.2. Z02 — desktop

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `BrowserWindow` main без `sandbox`/navigation guard | `desktopWindowChrome.ts:591-614` | Confirmed (факт), Corrected (вывод) | `:602-613` действительно не содержит `sandbox`; guards для main не найдены | Electron default `sandbox: true` с Electron 20 (`electron.d.ts:18827`); «без sandbox» как *дыра* — overclaim, см. §7 |
| 2 | preload публикует 132 метода | `preload/index.ts:264-934` | Confirmed | ровно 132 top-level ключа в `zcodeApi` | — |
| 3 | Host exit не уведомляет renderer и не respawn'ит | `desktopHostProcess.ts:647-664` | Confirmed | `:647-664` удаляет из maps/paths, `webContents.send` в файле нет | — |
| 4 | `streamBatches` удаляется только при `event.terminal` | `taskRealtimeBus.ts:520-522,544-546` | Confirmed | обе точки удаления под `if (event.terminal)`; `streamBatches.delete` встречается ровно 2 раза | — |
| 5 | 377 из 575 E2E — `manual-review/pending`, 198 формальных | `wdio.conf.ts:583-587,4778` | Confirmed | 575 `.test.ts`, 377 pending, 198 вне pending; exclude по `MANUAL_REVIEW_SPEC_GLOB` `:4778` | — |
| 6 | 121 формальная спека в `conversation-session` | подсчёт | Confirmed | 121 | — |
| 7 | 118 IPC-хендлеров | `rg ipcMain` | Corrected | `ipcMain.handle` = 88, `ipcMain.on` = 30, суммарно **118** — арифметика верна, но формулировка «118 обработчиков» скрывает разделение | Уточнить: 88 handle + 30 on |
| 8 | `autoUpdater.ts` = 2148 строк | `wc -l` | Confirmed | 2148 | — |
| 9 | 370 unit-файлов desktop | §3.9 | Corrected | 358 `test/*.test.ts` + 1 `test/unit` + 11 колокейтед = 370; но всего tracked desktop-тестов вне e2e — 371, включая `test/plugin-sandbox` | Не ошибка, но «370» зависит от способа подсчёта |
| 10 | force-update gate до окна, 10 c / 1 MiB | `index.ts:2524-2543`; `forceUpdateGuard.ts:13-15` | Confirmed | `:2524-2543` — вызов до `primaryWindow` (окно создаётся ниже), лимиты в guard | — |
| 11 | `desktopWindowChrome.test.ts` (33) прошли | §2/§3 | Unverifiable | Файл существует; аудитор этот прогон не повторял | Прогон Z02 не перепроверен |
| 12 | В checkout нет E2E/CI для update install | `autoUpdaterReadyState.test.ts`; `rg pending` | Confirmed | только unit-модель состояний; update-спека в `manual-review/pending` | — |

### 3.3. Z03 — web/server

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `decodeURIComponent` без try/catch → 500 на `/%E0%A4%A` | `http.ts:298` | Confirmed | `:298` без защиты; `decodeURIComponent` бросает `URIError`; Hono без `onError` → 500 | — |
| 2 | `Set-Cookie` без `Secure`/`Max-Age`/`__Host-` | `http.ts:243-260` | Confirmed | `:255`: `Path=/; HttpOnly; SameSite=Lax` | — |
| 3 | non-loopback без токена не стартует | `http.ts:361-369`; `serverInfoHttp.test.ts:140-144` | Confirmed | throw в `:365-369`; тест `:140-144` | — |
| 4 | bots webhook под общим token-middleware | `http.ts:262-264,465-466` | Confirmed | `/api/*` token-protected; `/api/bots/:provider` объявлен ниже | — |
| 5 | сравнение webhook-секрета через `!==` | `botsService.ts:3714,3838,3855` | Confirmed | три `!==`-сравнения на указанных строках | — |
| 6 | `c.req.text()` без body-limit | `http.ts:433` | Confirmed | `await c.req.text()` без ограничения | — |
| 7 | нет CSP/XFO/nosniff/healthz | `rg` по `http.ts` | Confirmed | `healthz`, `bodyLimit`, `Origin`, security headers не найдены | — |
| 8 | `main.tsx` = 2107 строк | `packages/web/src/main.tsx:12` | Confirmed | 2107; `eslint-disable max-lines` на `:12` | — |
| 9 | 2219 `.map`, 144 MB assets | `find`/`du` | Confirmed | 2219 / 144M | — |
| 10 | `code_challenge` отсутствует (нет PKCE) | `rg` по `packages/web/src`, `packages/shared/src` | Confirmed | 0 совпадений | — |
| 11 | `packages/web/test/remoteFrontendBuildSource.test.ts` отсутствует, но указан в `vitest.config.ts:32` | `:32` | Confirmed (stale-entry), Corrected (эффект) | файла нет; запись в `forkIsolatedTests`, а не в include | Z03 уже корректно пишет «безвредный stale-entry»; в других отчётах это подаётся как «мёртвый include», что неточно |
| 12 | `version.ts:14-77` и `handshake.ts:20-126` — это `packages/server/src/remote/*` | §3.4, §8 | Confirmed | `packages/server/src/remote/handshake.ts` = 159 строк; `webRemoteControlVersion.ts` = 78 строк | Корректно, если читать контекст; без контекста basename неоднозначен |

### 3.4. Z04 — UI

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | Глобальный `outline:none!important` + `box-shadow:none` для `:focus`/`:focus-visible` | `styles.css:126-138` | Confirmed | `:126-131` и `:133-139` | — |
| 2 | `text-muted-foreground` = 207 call-sites, токен не определён | `styles.css`; `@theme` | Confirmed | 208 совпадений в `packages/ui/src` (207 + 1 в комментарии); `--color-muted*` в `@theme` нет | 207 корректно как «≈»; 208 — фактический `rg` |
| 3 | `focus-visible:ring-*` = 274 в 104 файлах | подсчёт | Corrected | 277 вхождений в 106 файлах (исключая тесты — те же 277/106) | Числа выросли; порядок верный |
| 4 | `Button` не имеет focus-стиля | `button.tsx` | Corrected | base `outline-none`; `destructive`/`warning` имеют `focus-visible:ring-*`, default/outline/secondary/ghost — нет | Точнее: базовый default-вариант без focus-стиля |
| 5 | 10 `.test.tsx` не собираются корневым Vitest | `vitest.config.ts:114-121` | Confirmed | `vitest list --project=unit` → 0 `.test.tsx`; 10 файлов в `packages/ui/test` | — |
| 6 | `.tsx` исключены из coverage | `vitest.config.ts:143-146` | Confirmed | `include: ["packages/*/src/**/*.ts"]` | — |
| 7 | Toast без `role`/`aria-live` | `toast.tsx` | Confirmed | `aria-live`/`role=` в `toast.tsx` не найдены | — |
| 8 | `prefers-reduced-motion` уже используется в 5 местах | §4.12 | Confirmed | 5 `@media (prefers-reduced-motion: reduce)` в CSS | Claim «добавить reduced-motion» относится к оверлеям, не ко всему UI |
| 9 | DESIGN требует `rounded-lg`/`h-9`, код — `rounded-md`/`h-7` | `DESIGN.md:398` | Confirmed | DESIGN `:398` требует `rounded-lg`; `button.tsx:10` — `rounded-md`, `:29` — `h-7` | — |
| 10 | `jsx-a11y` даёт 129 warnings | `npx oxlint --jsx-a11y-plugin` | Unverifiable | Аудитор флаг не запускал; конфигурация `oxlint` без плагина подтверждается | Требует повторного прогона |
| 11 | 2 i18n-ключа отсутствуют во всех каталогах | §4.7 | Unverifiable | Не проверялось по всем трём каталогам | — |
| 12 | Lighthouse/Playwright-пробы фокуса (8 скриптов) | §1.4 | Unverifiable | Артефакты проб в репозиторий не входят | — |

### 3.5. Z05 — services/session

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `createReportingRemoteZCodeTaskService` вызывается один раз без `taskRealtimePort` | `host/index.ts:3985-3992` | Confirmed | вызов ровно один; опции только `{ reportRunningPromptCount: false }` | — |
| 2 | Портовые операции лежат в ветке, недостижимой без порта | `host/index.ts:1428-1492` | Confirmed | `:1428-1432` ранний `return sendPrompt` при `!taskRealtimePort` | — |
| 3 | `onDidReceiveOwnerCommand` не имеет production-вызовов | `sessionRealtimePort.ts:40`; `taskRealtimeBridge.ts:221` | Confirmed | только определения; `.onDidReceiveOwnerCommand(` call-sites = 0 | — |
| 4 | `sessionEmitters.delete` отсутствует, очистка только `clear()` в dispose | `zcodeAgentService.ts:2091-2100,4453-4470` | Confirmed | `sessionEmitters.delete` = 0; `clear()` на `:4464` | — |
| 5 | `sessionTraceIdBySessionKey` не удаляется | `zcodeAgentService.ts:1648,4080-4093,5046-5050` | Confirmed | `delete/clear` = 0 | — |
| 6 | `markRuntimeCommandFailed` оставляет запись навсегда | `zcodeTaskServiceAdapter.ts:533-550` | Confirmed | map заменяет элемент на `status:"failed"`, не удаляет | — |
| 7 | любой request-timeout, кроме cancel, убивает процесс | `zcodeAgentProcessManager.ts:1302-1337` | Confirmed | `:1302-1326`; cancel — отдельная ветка `:1306-1318` | — |
| 8 | `conversationQueryTimeoutMs` нигде не читается | `core.ts:83` | Confirmed | единственное вхождение — определение | — |
| 9 | `forwardSessionMessageSendRequested` объявлен, но не потребляется | `node.ts:1235-1237` | Corrected | опция объявлена; Host её передаёт (`host/index.ts:3955`), но внутри `createLocalServices` она не читается | Уточнение: «не потребляется внутри services» верно |
| 10 | mailbox API бросает unsupported | `zcodeTaskServiceAdapter.ts:2102-2110` | Confirmed | `deliverSessionMessage`/`sendSessionMessageDeliveryResult` → `unsupported(...)` | — |
| 11 | `architecture-policy.yaml:25` ссылается на несуществующий `packages/services/src/session/contract.ts` | `architecture-policy.yaml:20-31` | Confirmed | `:25` содержит путь; файла нет; модуль `managed: false` | — |
| 12 | owner/lease слой «реализован, но не подключён» | §4 G4 | Confirmed | `taskRealtimePort:` как аргумент = 0 в production | — |

### 3.6. Z06 — rpc/shared/client

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | 32-битный length без верхней границы; `channelServer` без try/catch | `protocol.ts:274-278`; `persistent-protocol.ts:180-198`; `channelServer.ts:68-98` | Confirmed | чтение `readUInt32BE(9)` и ожидание кадра; `onRawMessage` без try/catch | — |
| 2 | `server.ts` dispatch = ~111 case в `:695-1009` | `server.ts:695-1009` | Corrected | 112 `case` в диапазоне 696–1009: 30 `V4_METHODS` + 81 legacy + 1 default; по всему файлу 111 plain `case` | «111» воспроизводится только как общее число `^\s+case` по файлу; диапазон содержит 112 меток |
| 3 | 104 метода в `zcodeProtocolMethods` | `index.ts:4602-4739` | Confirmed | 104 | — |
| 4 | 23 типизированных контракта | `index.ts:4747+` | Confirmed | 23 `[zcodeProtocolMethods.*]` | — |
| 5 | `parseParams` в `server.ts` — 2 раза, в `server-operations.ts` — 22 | `server.ts`; `server-operations.ts` | Confirmed | 2 и 22 | — |
| 6 | unknown method → `-32601` | `server.ts:1008` | Confirmed | `default: throw new ProtocolRequestError(-32601, ...)` | — |
| 7 | CLI transport отвечает `-32600` и продолжает; Host закрывает транспорт | `transport.ts:267-291`; `zcodeStdioTransport.ts:256-270` | Confirmed | CLI `sendError(..., -32600)` и `return null`; Host `fireClose({reason:"protocol_parse_error"})` | — |
| 8 | `ProxyChannel.call` резолвит унаследованные члены | `proxy-channel.ts:85-95` | Confirmed | `const target = handler[command]; if (typeof target === "function")` без `hasOwnProperty` | — |
| 9 | `write` молча теряет данные при закрытом сокете | `websocket.ts:45-49` | Confirmed | `if (readyState === OPEN) send(...)`, иначе no-op | — |
| 10 | `connectViaWebSocket` без reconnect/backoff | `client/src/websocket.ts:62-100` | Confirmed | `rg reconnect|retry|backoff` по `packages/client/src` пуст | — |
| 11 | `fast-check` отсутствует | manifest/rg | Confirmed | нет в `package.json`/lock | — |
| 12 | `remoteServiceAccess.sampling.test.ts` не собирается root-конфигом | `vitest.config.ts:113-122` | Corrected | файл лежит в `packages/client/src`, а include для unit — `packages/*/test/**/*.test.ts` + `contract.test.ts` + gen-ui | Файл не «мёртвый», но действительно вне include; формулировка верна по существу |

### 3.7. Z07 — CLI runtime

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `permissionTimeoutMs` объявлен, но нигде не присваивается в продукте | `runtime/types.ts:149`; `rg` | Confirmed | объявление + прокидка через `runtime-tools.ts:242` → `executor/impl.ts:44` → `permission-request.ts:73`; присваивания в bootstrap/cli/config нет | — |
| 2 | broker ждёт бесконечно при `timeoutMs === undefined` | `permission/broker.ts:108-126` | Confirmed | `if (options?.timeoutMs !== undefined) setTimeout(...)` | — |
| 3 | `maxTurns` не задаётся через CLI-флаги и runtime-config | `arguments.ts:3-110`; `runtime-config.ts:125-204` | Corrected | `runtime/types.ts:144` есть, `subagent`-путь использует; CLI-флаг отсутствует; отдельного продуктового поля в bootstrap не найдено | По существу верно, но «недоступен в проде» — Inferred, не доказано для host-пути |
| 4 | `cost` всегда 0 | `turn-stop.ts:86,137`; `message-persistence.ts:337` | Confirmed | `cost: 0` в трёх местах | — |
| 5 | `auto` достижим, но всегда deny | `permission/service.ts:173-180,399-406` | Confirmed | `mode.auto.unimplemented` | — |
| 6 | `disallowedTools` обходится в yolo/guarded | `permission/service.ts:169-189`; комментарий `:391` | Confirmed | yolo/guarded allow до `isToolDisallowed`; комментарий прямо это признаёт | — |
| 7 | `steering.ts:510-540` — fallback guide в queue; `:1373-1404` — discard pending | `steering.ts` | Confirmed | реальный файл — `runtime/methods/steering.ts` (1445 строк), обе функции на указанных строках | Bare basename; корректность зависит от контекста |
| 8 | `resume.ts:286-287` — вызов discard, `recoveredSteerInputCount = 0` | `resume.ts` | Confirmed | `runtime/methods/resume.ts:286-287` | — |
| 9 | `runtime-tool-loop.test.ts` = 16 893 строки, 184 `it()` | `wc -l`, `rg -c` | Confirmed | 16893 / 184 | — |
| 10 | `streaming-tool-coordinator` без выделенного unit-теста | `rg` | Corrected | файл — `runtime/methods/streaming-tool-coordinator.ts` (441 строка), а не `runtime/helpers/...`; тестов с basename не найдено | Путь в §8 верный, в кратких ссылках — неоднозначный basename |
| 11 | 10 попыток stream recovery | `streaming-recovery.ts:14` | Unverifiable | Константа найдена; фактическое число попыток на runtime не проверялось | — |
| 12 | `compact.ts:184-300` — `autoCompactIfNeeded` | `compact.ts` | Confirmed | `runtime/methods/compact.ts:184-200` содержит функцию; файл 468 строк | `helpers/compact.ts` — другой файл (188 строк), в §8 указан правильный |

### 3.8. Z08 — tools/providers

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | ApplyPatch закомментирован в реестре | `handlers/index.ts:90` | Confirmed | `// applyPatchToolEntry,` | — |
| 2 | ApplyPatch-ассерты условны (`if (applyPatch)`) | `tool-contracts.test.ts:443-449` | Confirmed | `:443-449` | — |
| 3 | strict read/write suites выключены env-флагами | `read-tool-contract.test.ts:32-33`; `write-tool-contract.test.ts:31-32` | Confirmed | `describe.skip` при отсутствии `ZCODE_RUN_*_STRICT_CONTRACT` | — |
| 4 | `path-policy` намеренно не блокирует выход за workspace | `path-policy.ts:32-39` | Confirmed | комментарий `:36-38` + `return resolvedPath` | — |
| 5 | Bash формирует `sandbox`, но adapter его не читает | `bash.ts:458-461`; `execution.port.ts:108-113,153` | Confirmed | поле есть; `rg request\.sandbox` по `adapters/src/exec` пуст | — |
| 6 | sandbox-запрос влияет только на telemetry `sandboxed` | `bash.ts:328` | Confirmed | `sandboxed: input.dangerouslyDisableSandbox !== true` | — |
| 7 | Result budget по умолчанию 100 KB | `result-serialization.ts:34-41` | Confirmed | `maxInlineBytes/maxModelBytes: 100_000` | — |
| 8 | Bash default 120 s, max 600 s | `tool/bash-timeout-policy.ts:6-35` | Confirmed | константы + env override | — |
| 9 | TaskStop budget 100 KB | `task-stop.ts:14` | Confirmed | `MAX_TASK_STOP_MODEL_BYTES = 100_000` | — |
| 10 | `model-execution.ts:517-553` — provider factory switch | `model-execution.ts` | Confirmed | реальный файл `adapters/src/model/model-execution.ts` (2005 строк) | Bare basename разрешается верно по контексту |
| 11 | `summarizeProviderBusinessBody` оставляет scalars+keys | `model-execution.ts:1098-1104` | Confirmed | `:1098-1104` | — |
| 12 | Retry-After порог 5 мин согласован adapter/spec | `retry-policy.ts:31`; `provider-quota-fallback.md:14` | Confirmed | `MAX_HONORED_RETRY_AFTER_MS = 5 * 60_000`; spec `:13` «>300 секунд» | — |

### 3.9. Z09 — context/memory/skills/MCP

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `canRunPluginHooks` возвращает `true` для сторонних плагинов | `plugins/index.ts:371-376` | Confirmed | `:375` `return true` с комментарием про снятую границу | — |
| 2 | project-scope MCP доверен по умолчанию | `bootstrap/src/zcode-protocol/mcp.ts:74-76`; `runtime-config.ts:116-121` | Confirmed | `untrustedProjectMcpServers = new Set()` в обоих местах | — |
| 3 | MCP `needsApproval: true`, risk mapping | `core/src/mcp/index.ts:166-185,259-267` | Confirmed | существует | — |
| 4 | AGENTS.md discovery идёт вверх до projectRoot/user home | `context/index.ts:681-720` | Confirmed | `findInstructionFile` + `findDefaultUserInstructionFile` | — |
| 5 | skill precedence roots: project < user < additional | `skills/roots.ts:46-55` | Confirmed | порядок push соответствует | — |
| 6 | `allowImplicitInvocation: true` жёстко зашит | `skills/index.ts:310-314` | Confirmed | `policy: { allowImplicitInvocation: true }` | — |
| 7 | Skill tool `needsApproval: false`, `sideEffectScope: "session"` | `core/tool/handlers/skill.ts:136-145` | Confirmed | `:136-145` | — |
| 8 | compact summary содержит путь к transcript | `compact/prompt.ts:146-148` | Confirmed | `:146-148` | — |
| 9 | `MemorySettingsSection` = `packages/ui/src/settings/...:47-183` | §3.6, §8 | Confirmed | файл 206 строк; `:47-183` существует | Путь `apps/zcode-cli/packages/ui/src/settings/MemorySettingsSection.tsx` (в §8) — **неверный**: такого каталога нет; правильный путь — `packages/ui/src/settings/...` |
| 10 | `skills.includeInstructions` не потребляется | `contracts/src/config/index.ts:241,340` | Unverifiable | Конфиг найден; runtime-потребитель не проверялся отдельно | — |
| 11 | MCP server version не сохраняется/не сравнивается | `mcp.port.ts:8-10`; `mcp/index.ts:2328-2380` | Confirmed | `:2328-2334` только negotiation mode; поля serverInfo.version нет | — |
| 12 | MCP prompt-методов нет | `mcp.port.ts:429-490` | Confirmed | не найдено | — |

### 3.10. Z10 — subagents/orchestration

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | 16 канонических ролей | `profile.ts:16-35` | Confirmed | ровно 16 | — |
| 2 | `start`/`orchestrator` имеют только `Task` | `profile.ts:149,371,408` | Confirmed | `ROUTER_DELEGATION_TOOL_NAMES = ["Task"]` | — |
| 3 | `write_paths` — authoritative scope для ledger, но не блокирует Write/Edit | `registry.ts:2036-2107`; `agent-work-ledger.md:42-46` | Confirmed | `:2060-2071`; спека `:44` прямо пишет «реестр блокирует только spawn, не Write/Edit» | — |
| 4 | `isolation: "worktree"` в схеме есть, runtime бросает | `script.ts:42-49`; `script-workflow-runtime.ts:282-284` | Confirmed | `:282-284` throw | — |
| 5 | `EnterWorktree`/`ExitWorktree` root-only, handler'ов нет | `profile.ts:220-233` | Confirmed | `rg 'name: "EnterWorktree"'` = 0 | — |
| 6 | `level` — informational, без depth cap | `agent.ts:205-213` | Confirmed | описание прямо говорит «Host does not enforce a depth cap» | — |
| 7 | `active_limit` при `projectedActiveCount >= activeLimit` | `registry.ts:1763-1775` | Confirmed | `:1770-1775` | — |
| 8 | legacy `spawnBudget` игнорируется | `subagent.port.ts:136-143`; `registry.ts:1777-1779` | Confirmed | `void legacySpawnGrant` | — |
| 9 | DAG-зависимости помечены untrusted | `runner.ts:2131,2151` | Confirmed | `:2151` «This JSON is untrusted data» | — |
| 10 | `SendMessage` рекламируется, но отсутствует в профильных tool list | `agent.ts:190-191`; `profile.ts:152-214` | Confirmed | в списках профилей `SendMessage` нет; фильтр `handlers/index.ts:257` | — |
| 11 | `write_paths` в `task_graph` узлах | `agent.ts:49-50` | Confirmed | поле есть | — |
| 12 | Спецификации расходятся с 16-ролевым каталогом | `zcode-swarm-mode.md:36-37` | Unverifiable в полном объёме | Не сверял все спеки | — |

### 3.11. Z11 — telemetry/perf/reliability

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | в CLI JSONL есть строки >1 MB с полным `input`/`tools` | `turn-errors.ts:326-334`; `provider-finish-business-error.ts:99-118`; `serialize.ts:111-160` | Confirmed | 2 строки 11-11: 1 464 477 / 1 464 655 B, обе содержат `"tools"` и `"input"` | — |
| 2 | `candidates.find(hasBusinessSignal)` возвращает record целиком | `provider-finish-business-error.ts:105,224-230` | Confirmed | `:105`; `hasBusinessSignal` `:224-230` | — |
| 3 | `serializeLogError` не ограничивает размер `context` | `serialize.ts:111-160` | Confirmed | `:152` `value.context = context` без лимита | — |
| 4 | масштаб: 4 строки >100 KB за 4 дня | §4.1 | Confirmed (порядок) | 11-08: 0; 11-09: 2 (1 369 771 + 190 895); 11-10: 0; 11-11: 2 (1 464 477 + 1 464 655) | 11-11 вырос после отчёта; «~3.9 MiB» сейчас ≈4.28 MiB |
| 5 | `event_text` уходит без санитайзера | `telemetryCore.ts:439` | Confirmed | `:439 event_text: payload.eventText ?? ""`; санитайз только для `event_extra_detail` `:441` | — |
| 6 | `template_prompt` уходит в `eventExtraDetail` | `promptTemplateTelemetry.ts:22-25` | Confirmed | `:22-25` | — |
| 7 | sanitize пропускает всё, кроме `error_msg`/`skill_name`/`login_url` | `shared/src/telemetry.ts:222-240` | Confirmed | `:230-239` | — |
| 8 | `writeTelemetryState` не атомарен | `telemetryCore.ts:162-166` | Confirmed | `writeFile` поверх файла | — |
| 9 | desktop main logger синхронный, без redaction | `logger.ts:73-91` | Confirmed | `appendFileSync` на каждый вызов; `JSON.stringify` без redactor | — |
| 10 | TTFT/trace по умолчанию выключены | `local-ttft-rollout-checklist.md:16` | Confirmed | `localTtftEnabled` default false | — |
| 11 | checklist упоминает retention 7/30 и стоимость на `:80-95` | `local-ttft-rollout-checklist.md:80-95` | Corrected | Файл 80 строк; retention/cost — на `:64`, этапы 1–3 — на `:9,15-17`; строк 80–95 нет | **Out-of-range**: цитата выходит за конец файла |
| 12 | `TaskRealtimeBus.streamBatches` не удаляется без terminal | `taskRealtimeBus.ts:366-397,520-522,544-546` | Confirmed | `streamBatches.delete` только в двух terminal-ветках; release делает `flushBatch` | — |

### 3.12. Z12 — security/trust

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | main window без `sandbox`/CSP; guards только для guest | `desktopWindowChrome.ts:602-613`; `renderer/index.html` | Confirmed (факт), Corrected (severity) | `sandbox` не задан; CSP 0; guest guards `:377,453,738-769`; Electron default `sandbox:true` | «Главное окно без sandbox» как отдельная дыра — overclaim; CSP и navigation guard — подтверждённые gaps |
| 2 | ~143 `ipcRenderer` обращения, 46 `ipcRenderer.on` | `preload/index.ts:934` | Corrected | `ipcRenderer.invoke` 73 + `send` 25 + `on` 46 + `removeListener` 34 = 178; 73+25+46 = 144 | «143» не воспроизводится ни одной естественной суммой; ближайшее — 144 (invoke+send+on) |
| 3 | YOLO/guarded обходят `disallowedTools` | `permission/service.ts:169-189` | Confirmed | `:169-171` allow до `:182` | — |
| 4 | guarded допускает `unsupported`/`notMatched` | `guarded/command.ts:51-86`; `guarded-mode.test.ts:80-105` | Confirmed | код и тест совпадают | — |
| 5 | project MCP auto-trust | `mcp.ts:74-76`; `runtime-config.ts:116-122` | Confirmed | см. Z09 #2 | — |
| 6 | workspace boundary открыт | `path-policy.ts:32-39` | Confirmed | комментарий + return | — |
| 7 | symlink-read не блокируется | `fs/index.ts:155-260,700-755` | Unverifiable | Не воспроизводил symlink-read runtime | — |
| 8 | master key — SHA-256 от host+user fallback | `credentialCipherProvider.ts:20-37,79-82` | Confirmed | `defaultCredentialSecret` = env или `zcode-credential-fallback:${platform}:${homedir}:${username}` | — |
| 9 | cookie без Secure/__Host-/Origin-check | `http.ts:243-268,361-380` | Confirmed | см. Z03 #2 | — |
| 10 | durable audit trail permission/auth отсутствует | `events.ts:641-898` | Confirmed (по отсутствию) | отдельного durable trail не найдено | — |
| 11 | нет burst-лимита/body-limit на ingress | `http.ts:433` | Confirmed | — | — |
| 12 | Linux AppImage запускается с `--no-sandbox` | — | Unverifiable (не заявлено в Z12) | `--no-sandbox` найден только в allowlist аргументов deep-link (`desktopLinuxDeepLinkRegistration.ts:39-43`), не как флаг запуска | Такого утверждения в Z12 нет; строка добавлена как проверка возможного ложного вывода синтеза |

### 3.13. Z13 — git/PR/editor/residual packages

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | нет PR-создания/review/CI ingestion | `grep 'gh pr create'` | Confirmed | единственное вхождение — bundled skill `superpowers-plugin/.../SKILL.md:128` | — |
| 2 | `useGitActions` — заглушка с toast, без потребителей | `useGitActions.ts:12-47`; `ui/src/index.ts:77` | Confirmed | все методы вызывают `announcePlaceholder`; импорт в UI = 0 | — |
| 3 | stage вызывается из commit-диалога и branch-switch assist | `GitActionMenu.tsx:1173`; `useGitBranchSwitcher.ts:341` | Confirmed | `GitActionMenu.tsx:1173` `gitService.stagePaths` | — |
| 4 | unstage/discard не вызываются из UI | `rg` | Confirmed | 0 вызовов | — |
| 5 | `isolation: "worktree"` падает | `script-workflow-runtime.ts:282-284` | Confirmed | throw | — |
| 6 | `NotebookEdit` зарезервирован, handler'а нет | `handlers/edit.ts:193-198` | Confirmed | только текст ошибки; `name: "NotebookEdit"` = 0 | — |
| 7 | `share-ui` = 59 deps + 4 devDeps, index 6 строк | `package.json` | Confirmed | 59 / 4 / 6 | — |
| 8 | `web-share`/share deploy docs ссылаются на отсутствующие файлы | `docs/web-share/*` | Confirmed | `Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx*.conf`, `scripts/test-web-share-build.sh` отсутствуют | — |
| 9 | `packages/android` — orphan без `package.json` | `ls` | Confirmed | файла нет | — |
| 10 | Git-checkpoint service не связан с UI | `gitCheckpointService.ts`; `node.ts:1371,2731-2732` | Confirmed | 0 ссылок в `packages/ui/src` | — |
| 11 | conflict detection есть, resolver'а нет | `gitCliHelpers.ts:336-355`; `gitCliRepo.ts:1105-1125` | Corrected (путь) | Файлы лежат в `packages/services/src/git/repo/`, а не `packages/services/src/git/` | Пути без `repo/` не резолвятся |
| 12 | `EnterWorktree`/`LSP` в provider-visible-order без handler'ов | `provider-visible-order.ts:11,13,16` | Confirmed | строки содержат имена; handler'ов нет | — |

### 3.14. Z14 — testing/CI/docs/DX

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | единственный workflow — manual release, без lint/test/typecheck | `.github/workflows/cross-platform-preview-release.yml:7` | Confirmed | `workflow_dispatch` only; `rg 'pnpm (lint|typecheck|test)'` пуст | — |
| 2 | 10 `.test.tsx` + 23 колокейтед-теста не собираются | `vitest.config.ts:114-121` | Confirmed | 10 `.test.tsx`; src-тестов 84, покрыты include: 56 `contract.test.ts` + 4 gen-ui + 1 `genUiPaths` = 61, не покрыты **23**; итог 33 | — |
| 3 | 12 мёртвых include/exclude-путей; fork-проект собирает 22 файла | `vitest.config.ts:120-121`; fork list | Confirmed | 2 мёртвых include + 10 отсутствующих fork-записей = 12; после разрешения — 22 файла (`5 processLifecycle + 17 explicit`) | — |
| 4 | 2603 файла `packages/*/test/**/*.test.ts` не типизируются | `packages/*/tsconfig.json` | Corrected | 2603 = **2028** тестов в `packages/*/test/**` (без e2e) **+ 575** desktop e2e. E2E типизируются через `packages/desktop/tsconfig.e2e.json`, поэтому нетипизированных — 2028, а не 2603 | Исключить 575 E2E из числа «нетипизированных»; формулировка завышает на 575 |
| 5 | 160 файлов fmt drift: 30 repo-owned + 106 `.agents` + 24 untracked research | `pnpm fmt:check` | Corrected | Сейчас 164: **30** repo-owned + **106** `.agents` + **28** `docs/research` | Разбивка почти верна; research-часть выросла |
| 6 | dev-docs тест красный: 324/629 vs 417/803 | `featureBoundaryGraph.test.ts:114-117` | Confirmed | прогон: 1 failed / 3 passed; 417/803 | — |
| 7 | `ci:assert-node` пропускает 26 при пине 24.14.0 | `assert-node-version.mjs:95-100` | Confirmed | проверка только `major < 24` | — |
| 8 | 19 tracked документов упоминают `.gitlab`; 11 — `scripts/ci`; 2 — `packages/distillation` | §4/G-8 | Corrected | `git grep -l -E '\.gitlab' -- 'docs/*.md' 'docs/**/*.md'` = **15**; `scripts/ci` = **14**; `packages/distillation` = **1** | Все три числа завышены (19→15, 11→14, 2→1); порядок величины тот же |
| 9 | `docs/desktop-ci-cd.md` описывает отсутствующий GitLab job | `docs/desktop-ci-cd.md:3,20` | Confirmed | `.gitlab-ci.yml`/`.gitlab/` отсутствуют | — |
| 10 | 575 E2E; 377 pending; 194 в дефолтном прогоне | `run-windows-e2e-shards.mjs:92-118` | Confirmed | `listDefaultFormalE2ESpecs` исключает `manual-review`, upstream, ssh → 194 | — |
| 11 | `spec-duration-weights.json` 53 записи, conversation-веса 77 и не читаются | `run-windows-e2e-shards.mjs:15` | Confirmed | файлы и отсутствие чтения второго | — |
| 12 | `CONTRIBUTING.md`/`SECURITY.md`/`CODEOWNERS`/PR-шаблонов нет | `ls` | Confirmed | все отсутствуют | — |

### 3.15. Z15 — product/onboarding/marketplace

| # | Claim (short) | Cited evidence | Verdict | Actual evidence | Correction |
| --- | --- | --- | --- | --- | --- |
| 1 | `CONTEXT.md` называет Example Prompt единственным входом, «Try now» удалён | `CONTEXT.md:73-75` | Confirmed | `:74` содержит это утверждение | — |
| 2 | код рендерит `plugin-store-try-now` | `PluginStoreDetailView.tsx:160-171` | Confirmed | `:166` `data-testid="plugin-store-try-now"` | — |
| 3 | `recommendedPlugins.ts` говорит, что секция Recommended снята | `recommendedPlugins.ts:3-9` | Confirmed | `:3-5` | — |
| 4 | install-кнопка только `disabled={installing}`, отмены нет | `PluginStoreCard.tsx:187-226` | Confirmed | `:209 disabled={installing}` | — |
| 5 | `cancelPluginOperation` есть в сервисе, UI-пути нет | `pluginManagementService.ts:193` | Confirmed | сервис/агент/protocol есть; UI-вызова нет | — |
| 6 | sources dialog не умеет validate | `PluginStoreSourcesDialog.tsx:49-57,132,151` | Unverifiable | Файл существует; отдельного validate-действия не нашёл, но полный просмотр диалога не делал | — |
| 7 | нет пользовательского consent/opt-out телеметрии | `telemetryCore.ts:419`; `rg DO_NOT_TRACK` | Confirmed | `REPORT_ENDPOINT` gate; `DO_NOT_TRACK/telemetryDisabled` = 0 | — |
| 8 | onboarding не ведёт к первому task | `OnboardingDialog.tsx:38-45` | Unverifiable | Файл существует; сценарий не проходил | — |
| 9 | локали ru-RU — JSON, en-US/zh-CN — TS | §3.8 | Confirmed | `packages/ui/src/i18n/locales/{en-US.ts,zh-CN.ts,ru-RU.json}` | — |
| 10 | `client/configs` используется для планов/продуктов | `useCodingPlanProducts.ts` | Confirmed | комментарии и вызовы | — |
| 11 | `CONTEXT.md` = 89 строк | §1 | Confirmed | 89 | — |
| 12 | marketplace trust: sha256 для CDN zip | `CONTEXT.md:17-19` | Confirmed (док) / Unverifiable (реализация) | Документ утверждает; реализацию не проверял | — |

**Сводка по таблице:** 182 проверено. Confirmed — 149, Corrected — 21 (из них 3 — «факт верен, вывод/severity уточнён»), Unverifiable — 12 (включая одну проверку утверждения, которого в отчёте нет), Invented — 0. «Invented» не выставлен ни одному цитируемому пути: все 30 нерезолвленных цитирований — либо намеренно отсутствующие файлы (negative evidence), либо артефакты вне git (`dist/`, `out/`), либо неоднозначные basename.

## 4. Path audit

### 4.1. Метод

Из 15 partial-файлов извлечены все backtick-цитирования с расширением и опциональным `:line`. После удаления wildcard/placeholder-форм (`*.test.ts`, `.../`, `{…}`, `<…>`) осталось 5346 цитирований, 2179 различных путей. Каждый путь пытался разрешиться:

1. как repo-relative путь из `git ls-files`;
2. если нет — как уникальный суффикс среди tracked-файлов (для bare-basename цитат);
3. если суффикс неоднозначен — записывался в «ambiguous», а не в «missing».

Результат: **5070** разрешены в tracked-файлы, **232** — неоднозначные basename (например `steering.ts`, `resume.ts`, `index.ts`, `contract.ts`), **30** различных путей не разрешены.

### 4.2. Несуществующие пути: классификация

| Путь | Встречается в | Класс | Комментарий |
| --- | --- | --- | --- |
| `.gitlab-ci.yml`, `.gitlab/ci/20-test.yml`, `.gitlab/ci/30-build.yml`, `00-workflow.yml`, `50-release.yml` | Z01, Z02, Z03, Z14 | Negative evidence | Файлов нет; отчёты используют это как доказательство отсутствия GitLab CI |
| `scripts/ci/ci-telemetry-keyword-guard.test.mjs`, `scripts/ci/ci-lint-pipeline.mjs`, `scripts/ci/push-e2e-report-to-feedback.mjs`, `scripts/ci/run-e2e-bitable-loop.ps1` | Z01, Z14 | Negative evidence / stale doc | Каталога `scripts/ci` нет; Z14 приводит их как содержимое устаревших документов |
| `scripts/assert-safe-cua-helper-zip.test.mjs` | Z01, Z14 | Negative evidence | Мёртвый include в `vitest.config.ts:120` |
| `packages/services/src/gen-ui/contract.test.ts` | Z01, Z14 | Negative evidence | Причина красного полного arch-check |
| `packages/services/src/session/contract.ts` | Z05 | Negative evidence | Битая декларация в `architecture-policy.yaml:25` |
| `packages/android/package.json` | Z13 | Negative evidence | Android-каталог без манифеста |
| `scripts/test-web-share-build.sh` | Z03, Z13 | Negative evidence | Ссылка из `docs/web-share/*`, файла нет |
| `docs/index.md` | Z01, Z14 | Negative evidence | Точки входа в docs нет |
| `docs/agent-next-steps.md` | Z06 | **Ошибка цитирования** | Файла нет ни в HEAD, ни в истории (`git log --all -- docs/agent-next-steps.md` пуст). Z06 ссылается на него как на действующий источник `workspaceKey` |
| `apps/zcode-cli/packages/ui/src/settings/MemorySettingsSection.tsx` | Z09 (§8) | **Ошибка пути** | Каталога `apps/zcode-cli/packages/ui` нет; правильный путь — `packages/ui/src/settings/MemorySettingsSection.tsx:47-183` |
| `packages/client/test/websocket.test.ts` | Z06 (R6) | Будущий тест | Явно предложен как новый; отсутствие корректно |
| `packages/shared/test/zcodeProtocolV4WireProperty.test.ts` | Z06 (R8) | Будущий тест | Явно предложен как новый; отсутствие корректно |
| `packages/web/test/remoteFrontendBuildSource.test.ts` | Z03, Z14 | Stale config entry | Отсутствие — сам дефект; путь корректен |
| `docs/research/partials/2026-11-11-zcode-04-ui.md` и др. | 04, 05, 09, 13, 15 | Self-reference | Файлы существуют, но untracked на момент аудита; позже станут tracked |
| `packages/web/dist/assets/index-7oewE0-r.js`, `index-l9S3SK-D.css` | Z03, Z04 | Артефакт вне git | Файлы существуют на диске, untracked; Z04 сам оговаривает возраст артефакта |
| `apps/zcode-cli/packages/cli/dist/zcode.cjs` | Z11 | Артефакт вне git | Существует на диске, untracked |
| `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/part-d-models-telemetry-reliability.md` | Z11 | Существует | untracked, но на диске есть — не ошибка |

Итог: из 30 нерезолвленных путей **27 — корректные negative evidence или артефакты**, **2 — ошибки цитирования** (`docs/agent-next-steps.md`, `apps/zcode-cli/packages/ui/...`), **1 — stale config entry** (сам является находкой), будущие тесты — 2, self-reference — 5 (пересекаются).

### 4.3. Line-range audit

Из 5070 разрешённых цитирований с `:line` 149 диапазонов формально превышали длину разрешённого файла. После разрешения неоднозначных basename по контексту осталось **22 реальных out-of-range**:

| Отчёт | Цитата | Фактическая длина | Класс |
| --- | --- | --- | --- |
| Z01 | `DESIGN.md:1-660` | 655 | Off-by-5 |
| Z01 | `CONTEXT.md:1-120` | 89 | Off-by-31 |
| Z01 | `mise.toml:23-46` | 41 | Off-by-5 |
| Z03 | `version.ts:14-77` | `webRemoteControlVersion.ts` = 78 | OK при правильном файле; basename неоднозначен |
| Z09 | `runtime-reminders.ts:282-338` | 337 | Off-by-1 |
| Z09 | `docs/session-context-tool.md:1-40` | 33 | Off-by-7 |
| Z10 | `subagent-selection.ts:15-59` | 58 | Off-by-1 |
| Z11 | `packages/client/src/logger.ts:1-30` | 25 | Off-by-5 |
| Z11 | `appTelemetryPrivacy.test.ts:1-70` | 65 | Off-by-5 |
| Z11 | `local-ttft-rollout-checklist.md:80-95` | 80 | **Содержательная ошибка**: стр. 64 содержит retention/cost, 80–95 не существует |
| Z11 | `appTelemetryRuntime.ts:1-140` | 122 | Off-by-18 |
| Z11 | `armsCustomEventObservability.ts:1-40` | 39 | Off-by-1 |
| Z12 | `permission-response.ts:75-117` | 111 | Off-by-6 |
| Z13 | `AndroidManifest.xml:1-69` | 64 | Off-by-5 |
| Z13 | `packages/e2e-report/src/node/index.ts:1-35` | 33 | Off-by-2 |
| Z14 | `scripts/run-cli-lint.mjs:1-120` | 96 | Off-by-24 |
| Z15 | `docs/settings-preview-updates-copy.md:1-20` | 19 | Off-by-1 |

Вывод: подавляющее большинство out-of-range — мелкие off-by-N, не влияющие на вывод. Содержательно опасны два случая: Z11 `local-ttft-rollout-checklist.md:80-95` (несуществующий диапазон при верном смысле) и Z09 `apps/zcode-cli/packages/ui/...` (несуществующий путь при верном факте).

### 4.4. Контрольная выборка 150+ различных путей

Все 15 отчётов цитируют файлы, которые реально существуют, кроме перечисленных выше 30. Выборочная проверка 160 путей (по 10–12 на отчёт, приоритет — P0/P1 evidence) дала:

- **155** путей существуют и содержат цитируемый фрагмент;
- **3** пути существуют, но цитируемый диапазон/содержимое смещены (`local-ttft-rollout-checklist.md`, `permission-response.ts`, `armsCustomEventObservability.ts`);
- **2** пути не существуют и являются ошибками (`docs/agent-next-steps.md`, `apps/zcode-cli/packages/ui/src/settings/MemorySettingsSection.tsx`).

## 5. Cross-branch contradictions

### 5.1. Z07 vs Z12: `permissionTimeoutMs`

- Z07 R1: «approval в core-пути может ждать бесконечно, потому что `permissionTimeoutMs` нигде не присваивается»; P1.
- Z12 R5: то же самое; P1.
- **Вердикт: consistent, complementary.** Оба указывают один и тот же факт (`runtime/types.ts:149`; `broker.ts:108-126`; `permission-request.ts:73`). Расхождений в приоритете нет. Z12 добавляет security-контекст (fail-open по времени), Z07 — runtime-контекст (нет продуктового поля). Уточнение для синтеза: реальный риск — не «бесконечное ожидание пользователя», а «ожидание без таймаута при потере клиента»; это подтверждается кодом broker'а, но не воспроизведено runtime.

### 5.2. Z08 vs Z12: sandbox / workspace boundary

- Z08 G-01/R-03: `sandbox` поле формируется, но adapter его не читает; P1.
- Z12 G-06/coverage: «sandbox — observed no-op», «подтверждает Z08».
- **Вердикт: consistent.** Оба опираются на один `rg`-результат. Дополнительно: Z02/Z12 называют «main window без sandbox» отдельным P0-gap, но Electron docs (`electron.d.ts:18827`) говорят, что по умолчанию `sandbox: true` с Electron 20. Это **не противоречие между филиалами**, а общий overclaim двух филиалов: отсутствие явного `sandbox` в `webPreferences` не означает отсутствие sandbox. Подтверждённые части — отсутствие CSP и navigation guard.

### 5.3. Z05 vs Z10: owner/lease

- Z05 G4: `taskRealtimePort` не инжектится, owner-команды не доставляются, docs требуют обратное; P0.
- Z10 §3.3: WorkLedger «не заменяет owner/lease и CommandInbox», owner/lease живёт в CLI Runtime registry; P1-рекомендации не касаются desktop-порта.
- **Вердикт: complementary, не contradictory.** Z10 описывает work-ledger (другой механизм), Z05 — desktop TaskRealtimeBus. Пересечение только в формулировке «owner», но это разные owner'ы: ledger claims vs run lease. Z05 корректно цитирует `runtime-boundaries.md:57-58` и `task-realtime-sync.md:6-7`; Z10 корректно цитирует `agent-work-ledger.md:48-49`. Для синтеза важно не склеивать эти два «owner» в один вывод.

### 5.4. Z01 vs Z14: CI/gates

- Z01: единственный workflow — ручной release; GitLab-документация устарела; P0 для документарной части, P1 для CI.
- Z14: то же; P0 для CI-job.
- **Вердикт: consistent, приоритеты расходятся.** Z01 ставит P0 только документарной части, Z14 — всему CI-гейту. Факты совпадают: `.github/workflows/cross-platform-preview-release.yml:7` — только `workflow_dispatch`; шагов lint/typecheck/test нет. Расхождение приоритета — предмет §6.

### 5.5. Z09 vs Z12: MCP trust

- Z09 R-02: project-scope MCP trusted by default; P0.
- Z12 R4: то же; P1.
- **Вердикт: consistent, приоритеты расходятся.** Факт один: `untrustedProjectMcpServers = new Set()` в `bootstrap/src/zcode-protocol/mcp.ts:75` и `runtime-config.ts:117`. Z09 ставит P0 (supply-chain), Z12 — P1. Это самый значимый приоритетный конфликт, см. §6.

### 5.6. Z02 vs Z11: `TaskRealtimeBus.streamBatches`

- Z02 G3: утечка на нетерминальных окончаниях; P1.
- Z11 §4.9: MAIN-H2 «не исправлено»; P1 (в таблице аудита).
- **Вердикт: consistent.** Оба указывают `taskRealtimeBus.ts:520-522` и `releaseLease` без удаления. Z02 добавляет host-`finally` (`host/index.ts:1485-1490`), Z11 — исторический аудит. Факт подтверждён: `streamBatches.delete` только в двух terminal-ветках.

### 5.7. Z03 vs Z12: lite-token cookie / Origin

- Z03 G-02/R-02: cookie без `Secure`, токен в query, нет Origin-check; P1.
- Z12 R10: то же; P2.
- **Вердикт: consistent, приоритеты расходятся.** Код (`http.ts:243-268`) подтверждает оба. Z03 ставит P1, Z12 — P2. Для loopback-only сценария P2 разумнее; для `--host 0.0.0.0` — P1 (это и пишет Z03 в R-06).

### 5.8. Z04 vs Z14: `.test.tsx`

- Z04 R-06: 10 `.test.tsx` не собираются; P0 (гейт-дефект).
- Z14 G-2: 10 `.test.tsx` + 23 колокейтед; P0.
- **Вердикт: consistent, complementary.** Подтверждено: `vitest list --project=unit` → 0 `.test.tsx`; 84 src-теста, 61 покрыты include, 23 нет. Z04 фокусируется на UI, Z14 — на общем конфиге.

### 5.9. Z13 vs Z10: `isolation: "worktree"`

- Z13 R2: реализовать или удалить; P0.
- Z10 R3: то же; P1 (вариант B — убрать из схемы), P2 (вариант A — реализовать).
- **Вердикт: consistent, приоритеты расходятся.** Код один (`script-workflow-runtime.ts:282-284` throw). Z13 ставит P0, Z10 — P1/P2. P0 у Z13 не обоснован security/data-loss влиянием; см. §6.

### 5.10. Z06 vs Z12: RPC malformed policy

- Z06 R3: CLI отвечает `-32600` и продолжает, Host закрывает транспорт; P0.
- Z12 не рассматривает этот слой.
- **Вердикт: нет противоречия, есть пробел покрытия у Z12.** Z06 подтверждает код (`transport.ts:278-288`; `zcodeStdioTransport.ts:261-270`).

## 6. Priority corrections

Ниже — только те P0/P1, где уровень не соответствует заявленному эффекту. Обоснование: P0 = прямая потеря данных/секретов/краш/невозможность работы; P1 = серьёзный, но ограниченный дефект; P2 = гигиена/долг.

### 6.1. Завышенные P0

| Отчёт | Пункт | Заявлено | Предлагается | Причина |
| --- | --- | --- | --- | --- |
| Z01 | R-2 (arch full vs changed) | P0 | **P1** | Красный полный arch-check не влияет на runtime, данные или безопасность; это качество гейта. Влияние — «нарушение может жить в dev», но `--changed` ловит изменения при касании модуля |
| Z01 | R-3 (CI-гейт, документарная часть) | P0 | **P1** | Отсутствие PR CI — процессный риск, не прямой дефект продукта. Ветка уже имеет 14-шаговый local gate |
| Z01 | R-11 (план Z11–Z16) | «P0 для миссии» | **P1** | Это мета-требование к исследованию, не к продукту; в синтезе не должно попадать в продуктовый P0 |
| Z02 | R2 (Host crash) | P0 | **P1** | Нет respawn/уведомления — плохо, но окно не крашится, данные не теряются, пользователь может reload. E2E-подтверждения user impact нет |
| Z03 | R-01 (500 на malformed encoding) | P0 | **P2/P1** | Тривиальный дефект с воспроизведением, но это 500 на мусорном URL, не data-loss/security. Z03 сам называет его «тривиальным» |
| Z04 | R-06 (`.test.tsx` не собираются) | P0 (гейт-дефект) | **P1** | Тесты существуют и проходят при прямом запуске; проблема — неисполнение в корневом прогоне, а не сломанный продукт |
| Z04 | R-01 (глобальный focus reset) | P0 | **P1** | Accessibility-дефект высокого охвата, но не security/data-loss/crash. P0 оправдан только если продукт позиционируется как accessibility-compliant |
| Z13 | R1 (PR-контур) | P0 | **P1** | Отсутствие PR-автоматизации — product gap, не дефект; нет потери данных |
| Z13 | R2 (`isolation: "worktree"`) | P0 | **P1** | Runtime честно бросает ошибку; это не silent corruption, а fail-closed отсутствие фичи |
| Z15 | R5 (consent/opt-out телеметрии) | P0 | **P1 (юридический)** | Нет opt-out — регуляторный риск, но Z15 не приводит доказательств отправки PII; `event_text` — отдельная P0 у Z11 |
| Z15 | R1 (`CONTEXT.md` sync) | P0 | **P1** | Документарный drift; не влияет на runtime |

### 6.2. Заниженные (закопаны в P2/P1)

| Отчёт | Пункт | Заявлено | Предлагается | Причина |
| --- | --- | --- | --- | --- |
| Z05 | CR-1 (owner/lease не подключён) | P0 | **P0 (подтвердить)** | Оставить P0: документация требует маршрутизацию, код её не подключает; но в синтезе пометить «mobile mirror может быть намеренно отключён», как пишет сам Z05 |
| Z08 | R-03 (sandbox no-op) | P1 | **P0** | Модель и пользователь видят `dangerouslyDisableSandbox`/`sandboxed`, но изоляции нет. Это ложная гарантия безопасности — выше обычного P1 |
| Z08 | R-02 (workspace boundary) | P1 | **P0** | Read/write вне workspace разрешены намеренно, но это прямой prompt-injection→filesystem путь; Z12 G-04 классифицирует как high |
| Z09 | R-02 (project MCP auto-trust) | P0 | **P0 (подтвердить)** | Оставить P0: repo-controlled MCP запускается без approval |
| Z11 | R1 (полный request body в JSONL/support) | P0 | **P0 (подтвердить)** | Воспроизведено: 1.46 MB строки с `input`/`tools`; экспорт в support bundle — утечка приватного содержимого |
| Z11 | R2 (`event_text`/`eventExtraDetail` без санитайза) | P1 | **P0/P1 (зависит от содержания)** | `template_prompt` — продуктовый контент, но `event_text` может нести пользовательский текст; нужен ответ владельца. Пометить как «P1 с потенциалом P0» |
| Z12 | R5 (`permissionTimeoutMs`) | P1 | **P1 (подтвердить)** | Риск «зависший approval» реален, но без runtime-воспроизведения; не P0 |
| Z03 | R-03 (bots webhook под lite-token) | P1 | **P1 (подтвердить)** | Внешний webhook без `?token=` получает 401 — функциональный дефект интеграции, не security |
| Z12 | R8 (master key из host+user) | P1 | **P1 (подтвердить)** | Fallback-ключ детерминирован; это слабость at-rest шифрования, но требует локального доступа |

### 6.3. Приоритетные конфликты между филиалами

1. **MCP auto-trust:** Z09 P0 vs Z12 P1. Синтез должен выбрать P0: запуск repo-controlled MCP без approval — supply-chain риск с прямым выполнением.
2. **`.test.tsx`:** Z04 P0 vs Z14 P0 — согласованы; но по критерию «прямой impact» это P1.
3. **`isolation: "worktree"`:** Z13 P0 vs Z10 P1/P2. Выбрать P1: fail-closed, не corruption.
4. **cookie/Origin:** Z03 P1 vs Z12 P2. Выбрать P1 только для non-loopback, P2 для loopback-only.
5. **`permissionTimeoutMs`:** Z07 P1 = Z12 P1 — согласованы.

## 7. Material corrections for synthesis

Список ограничен 20 пунктами: только то, что меняет вывод синтеза, а не косметика.

1. **Z02 + Z12: «главное окно без sandbox» — overclaim.** `desktopWindowChrome.ts:602-613` не задаёт `sandbox`, но Electron 20+ включает его по умолчанию (`node_modules/electron/electron.d.ts:18827`: «Default is `true` since Electron 20»). Подтверждённые части: нет CSP, нет `will-navigate`/`setWindowOpenHandler` для main window, нет централизованной sender-проверки. Синтез должен писать «main window не задаёт sandbox явно; default=true; подтверждённые gaps — CSP и navigation guard», а не «sandbox отсутствует».
2. **Z12: «≈143 ipcRenderer обращения» не воспроизводится.** Факт: 73 `invoke` + 25 `send` + 46 `on` + 34 `removeListener` = 178; `invoke+send+on` = 144. Ближайшее к 143 — 144; вероятно, один вызов выпал при подсчёте. Правка: «≈144 IPC-вызова (73 invoke, 25 send, 46 on)».
3. **Z14: «2603 файла `packages/*/test/**/*.test.ts` не типизируются».** 2603 = 2028 тестов в `packages/*/test/**` (без e2e) + 575 desktop E2E. E2E покрыты `packages/desktop/tsconfig.e2e.json`, поэтому нетипизированных в `test/` — 2028. Формулировка завышает на 575 файлов.
4. **Z14: 19/11/2 документов с `.gitlab`/`scripts/ci`/`packages/distillation`.** `git grep` по tracked `docs/**/*.md` даёт 15/14/1. Порядок тот же, но числа в синтезе нужно поправить.
5. **Z01: «145 файлов fmt drift» и Z14: «160 файлов»** — оба устарели. Замер на HEAD: 164 файла (30 repo-owned + 106 `.agents/skills` + 28 `docs/research`). Для синтеза: «≈160–164 файла, из которых ~30 repo-owned» — это устойчивая часть.
6. **Z01: `scripts/*` = 113.** `ls -1 scripts` → 110 записей, `find -maxdepth 1 -mindepth 1` → 111, tracked верхнеуровневых файлов → 100. 113 не воспроизводится; в синтезе не цитировать.
7. **Z01: `docs/` = 2088 md / 2486 файлов / 67 MB.** 2088 `docs/**/*.md` подтверждается; файлов сейчас 2508 (без `docs/research` — 2477), объём 70 MB (без research — 65 MB). Использовать 2088 md и «≈2.5k файлов».
8. **Z11: `local-ttft-rollout-checklist.md:80-95` — out-of-range.** Файл 80 строк. Факты: этапы 1–2 не выполнены (`:9,15-17`), retention 7/30 и стоимость — `:64`. Смысл верен, ссылка нет.
9. **Z09: `apps/zcode-cli/packages/ui/src/settings/MemorySettingsSection.tsx` — неверный путь.** Каталога нет; правильно `packages/ui/src/settings/MemorySettingsSection.tsx:47-183` (файл 206 строк). Сам факт (UI памяти существует) верен.
10. **Z06: `docs/agent-next-steps.md:28` — файла нет и не было в истории.** Ссылка на него как на источник `workspaceKey` недействительна; валидные источники — `docs/zcode-protocol.md:97-113` и код `task-realtime-core.ts:84-89`, `web-remote-control.ts:744-748`.
11. **Z13: пути `packages/services/src/git/gitCliRepo.ts` / `gitCliHelpers.ts`.** Фактически — `packages/services/src/git/repo/...`. В §8 Z13 указал правильные пути, в таблицах §3 — сокращённые. При цитировании брать §8.
12. **Z06: «111 case в `server.ts:695-1009`».** В диапазоне 696–1009 — 112 `case`: 30 `V4_METHODS` + 81 legacy + `default`. 111 — общее число `^\s+case` по файлу. Правка: «112 меток, из них 81 legacy/30 V4».
13. **Z04: «274 ring в 104 файлах» → 277 в 106 файлах; «207 `text-muted-foreground`» → 208 совпадений (207 call-sites + 1 комментарий).** Дефект подтверждён; числа нужно обновить.
14. **Z02: «118 IPC-обработчиков».** Верно как сумма, но это 88 `ipcMain.handle` + 30 `ipcMain.on`. Для оценки поверхности лучше указывать раздельно.
15. **Z01: «37 файлов `scripts/test/*.test.mjs`».** Тестовых файлов 36; 37-й tracked-файл — `release-macos-local-fixture.mjs` без `.test`. Правка: «36 тестов + 1 fixture».
16. **Z15: `CONTEXT.md:74` действительно утверждает удаление «Try now» 2026-07-14, а код рендерит `plugin-store-try-now` (`PluginStoreDetailView.tsx:166`).** Факт подтверждён; это не ошибка Z15, но синтез должен явно назвать, какой источник считать актуальным — без ответа владельца это Unknown, а не «документ устарел».
17. **Z03: `remoteFrontendBuildSource.test.ts` — не «мёртвый include», а запись в `forkIsolatedTests` (`vitest.config.ts:32`).** Она не влияет на include, но означает тихую потерю serial-изоляции для удалённого теста. Точная формулировка важна: это не «тест не запускается», а «тест не существует».
18. **Z08/Z12: «sandbox no-op» подтверждён, но стоит различать три вещи:** (a) поле `sandbox` в `ExecutionRequest` есть; (b) adapter его не читает; (c) telemetry `sandboxed` всё равно пишется. Вывод «пользователь видит гарантию, которой нет» — верный, и это P0/P1, а не косметика.
19. **Z09 vs Z12 по MCP:** оба подтверждают `untrustedProjectMcpServers = new Set()` (`mcp.ts:75`, `runtime-config.ts:117`). Приоритетный конфликт P0 vs P1 решается в пользу P0: запуск repo-controlled MCP без approval — supply-chain риск.
20. **Z05: owner/lease.** Подтверждено: `createReportingRemoteZCodeTaskService` вызывается один раз без порта (`host/index.ts:3985-3992`), а вся lease-логика — под `if (!taskRealtimePort || !meta) return` (`:1428-1432`). Но Z05 сам пишет, что mobile mirror мог быть намеренно отключён; синтез должен сохранить эту оговорку, а не объявлять «mobile сломан».

## 8. Unknowns and unverifiable claims

1. **Electron runtime behavior.** Ни один отчёт не запускал packaged desktop и не проверял фактическое наследование preload/popup для main window. Вывод Z02 о «popup получает native API» — Inferred; Z12 это признаёт, Z02 — частично.
2. **Sandbox enforcement.** `sandbox` в Electron и `ExecutionRequest.sandbox` — разные механизмы; ни один отчёт не проверял, включён ли Chromium sandbox в собранном приложении (`app.enableSandbox` не вызывается, но default=true). Это Unknown для packaged build.
3. **`permissionTimeoutMs` в собранном desktop.** Ни Z07, ни Z12 не нашли присваивания в checkout; возможно, значение приходит из внешней конфигурации Host. Runtime-проверка не выполнялась.
4. **CI вне репозитория.** Все отчёты фиксируют отсутствие GitLab-конфигов, но не могут доказать, что внешнего CI нет. Z02/Z03/Z14 корректно помечают это как Unknown.
5. **Полный статус `pnpm typecheck`/`pnpm lint`.** Не запускались ни одним филиалом; аудитор тоже не запускал. Утверждения «pre-push зелёный» — это про структуру, не про фактический прогон.
6. **E2E-статус.** 575 спек не запускались; 377 `manual-review/pending` не проверены на актуальность.
7. **Поведение MCP-серверов и сторонних плагинов.** Z09/Z12 проверяли код, но не реальные сторонние MCP/skill payload'ы.
8. **`event_text` с пользовательским содержимым.** Z11 подтверждает, что поле уходит без санитайзера, но не доказывает, что туда попадает PII. Нужен ответ владельца телеметрии.
9. **`docs/research` untracked.** На момент аудита каталог не в git; self-reference путей в отчётах (04, 05, 09, 13, 15) резолвятся только после `git add`.
10. **Android/formal-proof/stream-animate/e2e-report.** Z13/Z01 описывают их как residual, но сборка/тесты не запускались.

## 9. Repository state confirmation

```text
$ git status --short
?? docs/research/
$ git diff --stat
(пусто)
$ git log --oneline -3
d10f0b69 Выпустить macOS Preview 3.17.102.
bbb756e8 Не красить весь индекс частичным из-за фиктивных паролей в тестах.
fc70a81b Выпустить macOS Preview 3.17.101.
```

- Коммитов сверх `d10f0b69` нет.
- `git diff --stat` пуст: продуктовые файлы, конфиги и lockfile не изменены.
- Единственное изменение рабочего дерева — untracked `docs/research/` (15 partial-отчётов + этот файл + конкурентные partials + `_swarm`).
- Записан только `<repo-root>/docs/research/partials/2026-11-11-verification-zcode-evidence.md`. Аудитор не создавал и не менял других файлов; `/tmp`-скрипты и логи прогонов вне репозитория.

### 9.1. Ограничения этого аудита

- Полный `pnpm typecheck`, `pnpm lint`, unit/E2E не запускались: это выходит за рамки read-only верификации и time-box ветки.
- Из 182 проверенных утверждений 12 остались Unverifiable; они перечислены в §8 и не должны попадать в findings синтеза как факты.
- Line-range аудит выполнялся по длине файла, а не по семантике каждой строки; мелкие off-by-N не считаются содержательными ошибками, кроме явно отмеченных.
