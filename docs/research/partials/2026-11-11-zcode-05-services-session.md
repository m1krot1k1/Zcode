# Z05 — packages/services: бизнес-сервисы, жизненный цикл session, владение состоянием

Дата исследования: 2026-11-11. Ветка: `dev`. HEAD: `d10f0b69 Выпустить macOS Preview 3.17.102.`
Режим: read-only, за исключением этого partial-файла. Продакшн-код не изменялся, коммитов нет.

## 1. Scope and method

**Вопрос.** Что фактически реализует `packages/services` в части session/task lifecycle: кто владеет изменяемым состоянием, где проходят границы между Host, CLI и Renderer, какие lifecycle-переходы покрыты тестами, а какие нет; где остаются дубли состояния, неочищаемые карты и разрывы между документами и кодом.

**Границы.**
- В фокусе: `packages/services/src/zcode-agent/*` (agent service, process manager, task adapter, task-index syncer), `packages/services/src/zcode-session/*`, `packages/services/src/session/*` (TaskIndexRepo, tasksDatabase, automation/offPeak), `packages/services/src/task-facts/*`, `packages/services/src/logger/*`.
- Смежные владельцы читались только как контекст: CLI `CommandInbox` и gateway (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/*`), desktop `TaskRealtimeBus`/bridge (`packages/desktop/src/main/taskRealtimeBus.ts`, `packages/desktop/src/host/*`), UI projection/overlay (`packages/ui/src/v4/*`).
- Вне scope: полная инвентаризация bots/plugins/MCP/OAuth/model-provider подсистем; desktop E2E не запускался.

**Метод.**
1. Зафиксирован baseline: `git status --short` → `?? docs/research/`; `git branch --show-current` → `dev`; `git log -1 --oneline` → `d10f0b69 Выпустить macOS Preview 3.17.102.`
2. `node scripts/check-workspace-freshness.mjs` → `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）`, exit 0.
3. CodeIndex `status` → `ready`, generation 1453, 10007 files / 26791 chunks; в diagnostics `Embedding search is unavailable; showing lexical results.` Адресный поиск по индексу дал только общие указатели, поэтому все несущие факты ниже проверены по исходникам (`rg -n`, `grep -n`, `sed -n`, `nl -ba`).
4. Инвентаризация: `find`, `wc -l`, `rg` по импортам и экспортам.
5. Чтение спецификаций: `AGENTS.md`, `packages/services/AGENTS.md`, `docs/agents/runtime-boundaries.md`, `docs/web-remote-control/task-realtime-sync.md`, `docs/web-remote-control-task-command-queue.md`, `docs/v4-refactor/01-topology.md`, `docs/v4-refactor/04-sync-and-recovery.md`, `docs/v4-refactor/07-persistence.md`, `docs/v4-refactor/18-resume-race-audit-plan.md`, `docs/session-idle-deactivation.md`, `docs/task-list-refresh-semantics.md`, `docs/conversation-session-case-catalog.md`.
6. Воспроизведение: `pnpm architecture:check --changed` → `architecture: OK / violations: 0`, exit 0.
7. Узкие тесты (не полный suite): 6 файлов, 196 тестов — все прошли (§8.3).

**Метки доказательств.** `OBSERVED` — прочитано в исходнике или воспроизведено командой. `INFERRED` — вывод из кода без runtime-проверки. `UNKNOWN` — источники не дают ответа.

**Ограничения.**
- История git в checkout сведена к `1889d446 Initial import of the Zcode source tree.` для большинства файлов services; `git blame` не позволяет отделить «когда появилось» от «перенесено при импорте». Атрибуция изменений не делается.
- Полные `pnpm typecheck`, `pnpm lint`, `pnpm test` и desktop E2E не запускались (запрещено envelope). Вывод о типах/линте не делается.
- Desktop E2E (442 файла в `packages/desktop/test/e2e/conversation-session`) не исполнялся; статусы покрытия взяты из `docs/testing/conversation-session-e2e-coverage-matrix.md`, а не из прогона.

## 2. Coverage table

| Поверхность | Файлы (ключевые) | Доказательство | Статус покрытия |
|---|---|---|---|
| Пакет и entrypoints | `packages/services/package.json`; `src/index.ts`; `src/node.ts` | `package.json:8-14` — 5 exports (`.`, `./node`, `./storage-startup`, `./cua-permission-broker`, `./process/processTreeTerminator`); `src/index.ts:1-3,95-98` — root entry browser-safe, Node-реализации только из `node.ts` | OBSERVED; architecture:check прошёл |
| Инвентарь | `packages/services/src` | 531 `.ts`, из них 36 `*.test.ts`; 67 подкаталогов + корень (`find`) | OBSERVED |
| Session facade | `src/zcode-session/zcodeSessionService.ts`; `src/zcode-session/zcodeSession.ts` | `createSession:213`, `resumeSession:267`, `promoteDeferredDraftSession:404`, `closeSession:421`, `closeDeferredDraftSession:426`, `setModel:453`; descriptor `zcodeSession.ts:170-172` | OBSERVED; `zcodeSessionService.test.ts` 17 тестов |
| Agent service | `src/zcode-agent/zcodeAgentService.ts` (7705 строк) | `createSession:4812`, `resumeSession:4946`, `listSessions:5033`, `readSession:5094`, `closeSession:6379`, `subscribeConversationV4:6876`, `sendConversationCommandV4:7028`, `disposeWorkspace:7653`, `disposeAll:7675` | OBSERVED; прямые unit-тесты разнесены по 14+ файлам `zcodeAgentService.*.test.ts` |
| Process manager | `src/zcode-agent/zcodeAgentProcessManager.ts` (1495 строк) | `getClient:845`, `startClient:958`, `onRequestTimeout:1302`, `disposeWorkspace:1405`, `disposeAllAndWait:1468` | OBSERVED; 49 тестов прошли |
| Task adapter | `src/zcode-agent/zcodeTaskServiceAdapter.ts` (5845 строк) | `enqueueTaskCommand:2112`, `promoteTaskCommand:2143`, `cancelTaskCommand:2166`, `stopGeneration:2222`, `respondPermission:2371`, `deleteTask:2959`, `disposeAll:3163` | OBSERVED; `zcodeLegacyTaskCompatTaskIndex.test.ts` 94 теста |
| Task-index syncer | `src/zcode-agent/zcodeTaskIndexSyncer.ts` (1955 строк) | `subscribeIndexTopic:1432`, `subscribeConfigTopic:1473`, `applyTerminalTransition:590`, `processSummary:664`, `syncSnapshotAndBroadcast:1677` | OBSERVED; `zcodeTaskIndexSyncer.test.ts` 73 теста |
| Task facts (единственный app-порт фактов) | `src/task-facts/index.ts`; `CONTRACT.md` | `createTaskFacts:24`; `mutate:119-128` (сначала CLI, потом reconcile); `CONTRACT.md:3-12` | OBSERVED; `contract.test.ts` + используется syncer |
| Persistence (tasks-index) | `src/session/taskIndexRepo.ts`; `src/session/tasksDatabase/*` | pragmas `taskIndexRepo.ts:404-407`; миграции `tasksDatabase/migrations.ts:64-170`; write chain `taskIndexRepo.ts:711-728` | OBSERVED; 6+8+1 тестов migration/startup/rollback |
| CLI CommandInbox | `apps/zcode-cli/.../command-inbox.ts` | gates `:88-108`, `handle:120-211`, `clearSession:265-269` | OBSERVED; 25 тестов прошли |
| CLI gateway / cold resume | `apps/zcode-cli/.../v4-gateway.ts`; `server-operations.ts` | `performHydration:3287-3314`, `disposeSession:2873-2890`, `activateSessionForResume:1476-1590` | OBSERVED; R1/R2 из audit-плана остаются частично открытыми (§4) |
| Resident pool | `apps/zcode-cli/.../session-resident-pool.ts`; `session-residency.ts` | defaults `:7-9` (8/16/10 мин); deactivation `session-residency.ts:23-39`; вызов из sampler `resource-sampler.ts:32-35` | OBSERVED; `session-resident-pool.test.ts` |
| Desktop owner/lease | `packages/desktop/src/main/taskRealtimeBus.ts`; `host/taskRealtimeBridge.ts` | lease `:321-355`, release `:366-392`, terminal release `:400-423`, owner commands `:854-918` | OBSERVED в изоляции; production-wiring отсутствует (§4, G4) |
| UI overlay/ledger | `packages/ui/src/v4/conversationProjectionStore.ts`; `pendingCommandRegistry.ts` | overlay `:106-111`, reconcile `:1365-1396`; TTL/запись/батчи `pendingCommandRegistry.ts:36,153-175,456-465` | OBSERVED; 16 тестов реестра прошли |
| Docs ↔ code | `docs/v4-refactor/*`, `docs/web-remote-control/*` | владение состоянием `01-topology.md:113-124`; инварианты `task-realtime-sync.md:11-22` | OBSERVED; два расхождения зафиксированы в §4 (G11, G12) |

## 3. Capability inventory

### 3.1 Композиция и направление зависимостей
- `@zcode/services` — private workspace-пакет, `"type": "module"`, alias `#src/*` (`packages/services/package.json:2-7`). Публичные входы: `.`, `./node`, `./storage-startup`, `./cua-permission-broker`, `./process/processTreeTerminator` (`:8-14`).
- Root entry намеренно browser-safe: value-экспорты фабрик, тянущих `node:*`, запрещены комментарием и вынесены в `node.ts` (`src/index.ts:95-98`; `createOnboardingRecordService` там только типом).
- Зависимости сервисов: `@zcode/shared`, `@zcode/rpc`, `@zcode/provider`, `@zcode/provider-node`, `@zcode/zcode-cua` (`package.json:19-36`). Обратных импортов в `@zcode/ui|desktop|server|web|client` нет (`rg` по `packages/services/src` — 0 совпадений). Потребители: `packages/ui`, `packages/desktop`, `packages/server`, `packages/zcode-server-cli`, `packages/client` (grep по `package.json`).
- Сборка Host: единый `createLocalServices()` (`src/node.ts:1192`) создаёт один `TaskIndexRepo` (`:1404`), один `createZCodeTaskIndexSyncer` (`:2510-2513`), один `createZCodeSessionService` (`:2546-2550`) и один `createZCodeTaskServiceAdapter` (`:2576-2582`). Это подтверждает заявленную «одну точку сборки» для локального Host.

### 3.2 Инвентарь сервисов (по назначению, не полный список 67 каталогов)
- Conversation/session/runtime: `zcode-agent/` (agent service, process manager, protocol client/transport, task adapter, task-index syncer, connection scope, model trajectory), `zcode-session/` (session facade, draft registry, import repair), `session/` (TaskIndexRepo, tasksDatabase, automation*, offPeak*, claude-native import, mailbox-типы, file change tracker).
- Facts/projection: `task-facts/` (единственный app-порт ingest/refresh/mutate/reconcile).
- Persistence/startup: `project-storage/`, `startup-storage/`, `fs/atomicFileUtils.ts`, `paths.ts`.
- Остальные домены (bots, plugins, skills, MCP sync, OAuth, credential, model-provider, usage-stats, storage, git, terminal, file, memory, hooks, subagents, code-intelligence, gen-ui, plugin-ui-bridge, opencode-acp-runtime, cua-permission-broker) — сервисы с собственными lifecycle, в этом partial только как контекст.

### 3.3 Session lifecycle (create/resume/close/delete)
- **Create.** `zcodeSessionService.createSession` (`:213-264`) резолвит MCP-серверы, вызывает `agentService.createSession`, логирует, затем:
  - при `persistence === "deferred"` запоминает draft в `zcodeSessionDeferredDraftRegistry` и **не** пишет task index (`:245-249`);
  - иначе `notifySyncer` + `broadcastSnapshot` с reason `task_meta_changed` (`:250-264`).
  `agentService.createSession` (`:4812-4944`) делает `session/create`, compatibility-retry по известным optional-полям и (при отсутствии `thoughtLevel` в старом schema) отдельный `session/setThoughtLevel`.
- **Resume.** `zcodeSessionService.resumeSession` (`:267-370`) вызывает `agentService.resumeSession`, затем «реплей» task-local `thoughtLevel` при расхождении (с проверкой доступных значений), `notifySyncer`, и по умолчанию broadcast snapshot с reason `task_status_changed`; при `broadcastSnapshot: false` пишет только model (`:330-369`).
- **Close.** `zcodeSessionService.closeSession` (`:421-424`) забывает draft-маркер и зовёт `agentService.closeSession`; `closeDeferredDraftSession` (`:426-450`) использует condition `expectedPersistence: "deferred"`, чтобы не закрыть уже повышенный в задача task; при ошибке старого Agent возвращает `false`, не выполняя безусловный close.
- **Delete.** Отдельного `deleteSession` в `IZCodeSessionService`/`IZCodeAgentService` нет. Удаление идёт как V4-команда `deleteSession` через `task-facts.mutate → source.execute` (`src/task-facts/index.ts:119-128`; syncer `:534-566`), а CLI-сторона — `v4-bridge.ts:1539-1560`: `softDeleteSession` → `record.unsubscribe()` → `record.app.close()` → `v4Gateway.disposeSession({deleted:true})` → `queuedTurnExecutions.delete` → `context.sessions.delete`. Обработчик команды: `commands/handlers/session-mgmt.ts:169-181`. Мягкое удаление в SQLite: `repositories/sessions.ts:128-139` (`time_deleted = coalesce(time_deleted, ?)`).
- **Стоп/отмена.** `stopGeneration` (`zcodeTaskServiceAdapter.ts:2222-2259`) шлёт V4 `stop` с опциональным `expectedForegroundExecutionId`; `cancelTaskCommand` (`:2166-2215`) для accepted-команд удаляет запись и эмитит `task_snapshot_updated`, для running — возвращает `already_running`.
- **Idle deactivation.** CLI держит resident pool 8/16/10 мин (`session-resident-pool.ts:7-9`), деактивация синхронно снимает record и асинхронно `app.close` (`session-residency.ts:23-39`); sampler вызывает `rebalanceResidentSessions()` по общему тику (`resource-sampler.ts:32-35`). Это единственный в репозитории idle-TTL для session; процессный idle-reclaim в `ZCodeAgentProcessManager` включён только для lane с явным `idleTimeoutMs` (chat-lane его не получает: `zcodeAgentService.ts:1297` vs `:1328-1336`).

### 3.4 Event flow (кто эмитит, кто подписан)
- Protocol → service: `wireClient` (`zcodeAgentService.ts:2431`) подписывает client callbacks; `handleSessionEvent` (`:2403`) нормализует seq (`normalizeSessionEventSeq:2365`) и дедуплицирует bounded-набором (`shouldDeliverLiveSessionEvent:2395`, cap `MAX_TRACKED_SESSION_EVENT_IDS=10_000`, `:507`).
- Fan-out: `emitSessionEvent` (`:2325-2331`) точечно в per-session `Emitter`; `emitWorkspaceEvent` (`:2333-2343`) линейно сканирует все `sessionEmitters` по префиксу workspaceKey. Per-session emitters создаются лениво (`getSessionEmitter:2091-2100`) и **не имеют** `onDidRemoveLastListener`.
- V4 subscriptions: `subscribeConversationV4` (`:6876-7016`) → `rememberV4SubscriptionRoute` (`:2206-2224`); unsubscribe/resync (`:2275-2331`) принимают только текущую route-генерацию (сравнение по object identity); routes очищаются на restart (`:1412-1415`) и `disposeWorkspace` (`:7653-7672`).
- Connection facade: trusted carrier читается только из скрытого поля (`zcodeAgentConnectionScope.ts:72-91`), `withTrustedConnection` вычищает все подделываемые поля `connectionId/clientMode/deliveryProfile/workflowRunDeltas/historyFirst` (`:96-110`); per-connection ownership и staging ограничены 1024 кадрами / 32 MiB (`:178-179`, `:455-470`), overflow → `fault.subscription.initialFrameStagingOverflow`.
- Task-index syncer: два независимых topic-а (sessions-index и workspace-config) с раздельными watermark/epoch/recovery (`zcodeTaskIndexSyncer.ts:235-260`, `:1432-1560`); при gap — same-sub resync, при повторном gap — force snapshot, при force-gap — fresh subscribe (`:779-800`, `:970-990`). Snapshot omission не удаляет строку; удаляет только явный `deleted` (`:1085-1096`), что совпадает с `task-facts/CONTRACT.md:8`.
- UI-приёмник: `conversationProjectionStore` применяет snapshot атомарно и снимает optimistic overlay по `pendingCommands`/`queue.items[].sourceCommandId`/`userInput` rows (`:1365-1396`); accepted-input projection имеет grace 2 s (`:47`), после чего запрашивается same-sub resync (`:1338-1344`).
- Pending ledger: `PendingCommandRegistry` хранит 24 h TTL (`pendingCommandRegistry.ts:36`, запись `:153-175`), сверяет батчами по 64 (`:456-465`), снимается при появлении queue/transcript (`:314-340`); сам по себе не является очередью и не переигрывает команды (§ заголовок файла `:1-2`).

### 3.5 Владение изменяемым состоянием (карта)
| Состояние | Владелец (по контракту) | Где создаётся/пишется | Где очищается | Комментарий |
|---|---|---|---|---|
| session event log / projection | CLI | `v4-gateway.ts` ingest/projection; services только читает | CLI `disposeSession/deactivateSession` (`:2873-2890`, `:2919-2971`) | Host emitters — только транспорт |
| admitted busy/running input | CLI `CommandInbox` | `command-inbox.ts:120-211` | `clearSession` при deactivate (`:265-269`) | UI overlay не является очередью (`01-topology.md:118`) |
| command idempotency | CLI LRU 512 + durable transcript/marker/child/discarded | `command-inbox.ts:181-250`; `core.ts:82` | settled LRU eviction; `clearSession` только без pinned | durable fallback порядок `07-persistence.md:59-70` |
| task index (title/status/model/search) | Host `TaskIndexRepo` (проекция CLI-фактов) | `task-facts/index.ts:83-166` → `taskIndexRepo.applyCliFacts:973-1040`, `updateTaskPresentation:1155-1209` | `applyCliDeletion:949-970`; tombstone `deleted=max(deleted,?)` | единственный writer для CLI-фактов — `task-facts` (`CONTRACT.md:3-9`) |
| pin/archive/unread/project | Host project/task services | `taskIndexRepo.updateTaskState:1112-1150`; project storage | там же (CAS/`unread_at`) | CLI не владеет организацией (`CONTRACT.md:10`) |
| V4 subscription routes | services facade | `zcodeAgentService.ts:1410-1411`, `:2206-2224` | restart/dispose (`:1412`, `:7658`), unsubscribe (`:2275-2295`) | generation-guard на await |
| workspace startup single-flight | services agent | `getClient:4270-4293`, `startModelExecutionClient:4295-4348` | `cancelWaitingWorkspaceStartup:1630-1636` | ready-event тоже проверяет identity (`:2057-2076`) |
| runtime process (Chat lane) | process manager | `processesByWorkspaceKey`; `startClient:958-1130` | `disposeWorkspace:1405-1430`, `disposeAllAndWait:1468+` | idle-TTL у chat-lane нет |
| per-session mirror maps (services) | agent service / adapter | см. §4 G1 | **только** `disposeLocalState`/`disposeAll` | главный разрыв lifecycle |
| owner/lease/stale-run | desktop main | `taskRealtimeBus.ts:321-355` | `:366-392`, terminal op `:409-414`, host exit `:198-202` | в текущей композиции не подключён к чату (§4 G4) |
| pending command ledger | renderer | `pendingCommandRegistry.ts:153-175` | TTL `:528-540`, authoritative settle `:314-340` | 24 h, не источник истины |

## 4. Gaps, risks, weaknesses

### G1. Per-session/per-task mirror state не очищается на close/delete — OBSERVED
- `sessionEmitters` создаётся лениво (`zcodeAgentService.ts:2091-2100`), но `sessionEmitters.delete` в файле отсутствует (grep — 0); очистка только в `disposeLocalState` (`:4453-4470`). Аналогично `sessionEventSequenceStates` (объявлен `:1416`, cap 10k id на session `:507`, `:2384-2391`) очищается только в `:4501`.
- `sessionTraceIdBySessionKey` (`:1648`) наполняется из `createSession/resumeSession/listSessions/readSession` (`:4080-4093`, `:5046-5050`) и не имеет ни `delete`, ни `clear` (grep — 0). `listSessions` пишет trace для каждого элемента выдачи, то есть карта растёт с числом просмотренных сессий воркспейса.
- В adapter карты `taskEmitters`, `globalTaskEmitters`, `taskTargets`, `apiRetryByTaskKey`, `backgroundTaskControlsByTaskKey`, `toolProjectionMemoryByTaskKey` живут до `disposeLocalTaskState` (`zcodeTaskServiceAdapter.ts:1698-1712`); `deleteTask` (`:2959-2964`) их не трогает. Для `liveToolProjectionsByTaskKey` есть LRU по числу задач/инструментов (`:704-733`), для остальных — нет.
- Совпадает с ранее зафиксированным аудитом `docs/analysis/memory-leak-audit-2026-09-03.md:86-94`; с тех пор код adapter в git выглядит как initial import, поэтому нельзя утверждать, что пункт исправлялся.
- Риск: долгоживущий Host (окно на весь день, сотни открытых задач) накапливает closures/maps и `emitWorkspaceEvent` деградирует линейно (`:2333-2343`).
- Это не «утечка в CLI»: CLI имеет resident pool и deactivation; это утечка **Host-слоя services**, которая не подписана на CLI `session.removed`.

### G2. Провалившиеся host-команды остаются в `runtimeCommands` навсегда — OBSERVED
`markRuntimeCommandFailed` (`zcodeTaskServiceAdapter.ts:533-550`) заменяет элемент на `status:"failed"`, но не удаляет его; `drainRuntimeCommands` выбирает только `accepted` (`:611-660`), `removeRuntimeCommand` вызывается лишь на терминальном событии (`completeRuntimeCommandByInputId:574-605`) или при явном cancel. Запись содержит `content` и `attachments`, то есть потенциально base64. То же зафиксировано в `docs/analysis/memory-leak-audit-2026-09-03.md:92`.

### G3. Adapter не подписан на runtime lifecycle → residual `activePromptInputIds` блокирует drain — OBSERVED/INFERRED
- `activePromptInputIds` ставится перед отправкой (`:413`), снимается при ошибке отправки (`:490`) и на `turn.completed|failed` (`:1637-1641`). `drainRuntimeCommands` в самом начале делает `if (activePromptInputIds.has(key)) return;` (`:611-614`).
- В adapter нет подписок `onAgentRuntimeRestarted`/`onAgentRuntimeLifecycle` (grep по файлу — 0), хотя agent service их предоставляет (`zcodeAgentService.ts:7645-7651`). При падении CLI без терминального события (например, protocol close и последующий recycle) ключ остаётся, и новые accepted-команды больше не drain-ятся.
- INFERRED: эффект зависит от того, приходит ли `turn.failed` перед recycle; в коде нет инварианта, который это гарантирует. Это ровно тот сценарий, который аудит называет «adapter 不订阅 runtime lifecycle» (`memory-leak-audit-2026-09-03.md:94`).

### G4. Owner/lease/mirror-слой реализован, но не подключён в текущей композиции Desktop Host — OBSERVED (отсутствие call sites)
- `createReportingRemoteZCodeTaskService` определён в `packages/desktop/src/host/index.ts:1314-1332` и вызывается **ровно один раз** (`:3985-3992`) с опциями `{ reportRunningPromptCount: false }` — без `taskRealtimePort` и без `materializePromptAttachments`.
- Все потребители порта (`acquireTaskRunLease`, `publishStreamOp`, `releaseTaskRunLease`) находятся внутри ветки `if (!taskRealtimePort || !meta) return sendPrompt...` (`:1428-1492`) и потому недостижимы в этой композиции. `taskRealtimePort:` как аргумент не встречается ни в одном production-файле (`rg -F` по `packages/**`, исключая tests — 0).
- `activeSessionRealtimePort` создаётся при инициализации Host (`:3731`) и только диспозится (`:2794-2797`, `:2890-2893`); в `createLocalServices` он не передаётся (grep по `packages/services/src/node.ts` — 0).
- `requestOwnerCommand` и `onDidReceiveOwnerCommand` не имеют production-вызовов: определения только в `sessionRealtimePort.ts:24,40` и реализация в `taskRealtimeBridge.ts:194,221`. `TaskOwnerCommandDeliver` уходит в host только из `taskRealtimeBus.ts:902-903`, но получателя в Host нет.
- Документы при этом требуют сохранять owner/lease и маршрутизацию (`AGENTS.md:69-70`, `docs/agents/runtime-boundaries.md:57-58`, `task-realtime-sync.md:121-135`). Расхождение «документ требует — код не подключает» — главный архитектурный риск этого среза. Нельзя утверждать деградацию поведения mobile: возможно, в текущем продуктовом потоке mirror просто отключён, а не сломан (см. §7 Q1).

### G5. Legacy host command queue остаётся публичным API без production-потребителей — OBSERVED
`IZCodeTaskService.enqueueTaskCommand/promoteTaskCommand/cancelTaskCommand` (`src/session/zcodeTaskService.ts:322-359`) реализованы в adapter (`:2112-2215`), но вызовов в `packages/ui`, `packages/web`, `packages/desktop/src`, `packages/server/src`, `packages/client` нет (`rg` — 0, кроме `apps/dev-docs/src/data/protocolDocs.ts:920` и тестов `zcodeLegacyTaskCompatTaskIndex.test.ts:2283+`). Документы прямо говорят, что V4 не использует этот queue (`docs/web-remote-control-task-command-queue.md:5-7,27`; `task-realtime-sync.md:139-154`). Итог: второй in-memory источник accepted input (`runtimeCommands`, `:270`) остаётся в коде и удерживает payload (§G2), а 94 теста поддерживают мёртвый путь.

### G6. Таймауты протокола: дефолт 3 минуты, любой timeout (кроме cancel) убивает процесс; query-deadline не подключён — OBSERVED
- `DEFAULT_ZCODE_PROTOCOL_REQUEST_TIMEOUT_MS = 3 * 60_000` (`zcodeProtocolClient.ts:50`), per-request override возможен (`:168`).
- В process manager любой `onRequestTimeout`, кроме `workspace/cancelGenerateText`, снимает процесс из пула и запускает `cleanupManagedProcessWithRetry(..., "request-timeout")` (`zcodeAgentProcessManager.ts:1302-1337`). То есть медленный read/query/attachment может стоить всего runtime и всех активных turn-ов.
- `PROTOCOL_V4_LIMITS.conversationQueryTimeoutMs = 10_000` определён (`packages/shared/src/zcode-protocol-v4/core.ts:83`), но нигде не читается (`rg` — только определение и audit-документ). `queryConversationCommandsV4` (`zcodeAgentService.ts:7116-7126`) не передаёт `timeoutMs`. Это подтверждает открытый пункт R3 в `docs/v4-refactor/18-resume-race-audit-plan.md:105-120`.
- `SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000` — единственный явный расширенный бюджет (`zcodeAgentService.ts:421`, применение `:6308`).

### G7. Legacy `session/resume` не имеет per-session single-flight — OBSERVED
`activateSessionForResume` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1476-1590`) ждёт только `sessionResidentPool.waitForDeactivation` (`:1492`), затем читает `context.sessions.get` (`:1493`) и без блокировки материализует record, `context.sessions.set(params.sessionId, record)` (`:1559`). Два параллельных resume могут оба пройти проверку `:1493` и создать два `app`; проигравший record будет перезаписан. Это ровно R2 из `18-resume-race-audit-plan.md:71-103`; в коде на дату проверки исправления нет. V4 cold-resume имеет свой single-flight (`cold-session-resume.ts:46-83`), но legacy-путь им не покрыт.
Практический вход: `snapshot resume` в adapter (`zcodeTaskServiceAdapter.ts:1249-1262`) использует `resumeSnapshot` (legacy `session/resume`) для replayable/legacy восстановления, поэтому гонка достижима при двух открытиях задачи.

### G8. Ошибка hydration всё ещё может превратиться в пустую projection — OBSERVED (частично закрыто)
`performHydration` (`v4-gateway.ts:3287-3314`) при ошибке `loadPersistedEvents` пишет `v4.hydrate` и:
```ts
if (this.historyOpenings.has(sessionId)) throw error;
return { events: [], synthesized: false, sourceEventSeq: 0 };
```
То есть для history-first/cold-opening ошибка пробрасывается, а для обычного warm-пути без активного `historyOpenings` — по-прежнему подменяется пустым набором. Audit R1 (`18-resume-race-audit-plan.md:45-70`) требовал не выдавать пустой snapshot за успешный; исправление частичное и зависит от того, каким путём открыли сессию. Прямого регрессионного теста на «loadPersistedEvents throws → subscribe rejects» в `apps/zcode-cli/packages/bootstrap/tests/v4-gateway.test.ts` не найдено (`rg` по `throw`/`rejects` — только другие fault-сценарии).

### G9. Services пишет в CLI `db.sqlite` напрямую, в обход CLI-адаптера — OBSERVED
`SourceServerWorkspaceAliasRepo` открывает `~/.zcode/cli/db/db.sqlite` своим `DatabaseSync` (`sourceServerWorkspaceAliasRepo.ts:290-305`, `openDatabase:179-182` с `busy_timeout=5000`), делает бэкап и `BEGIN IMMEDIATE; UPDATE session SET workspace_id=...` (`mergeSessionDatabase:868-890`). Это второй writer в базу, владельцем которой объявлен CLI (`docs/v4-refactor/07-persistence.md:5-11`), со своим таймаутом и без миграционного контракта CLI. Риск: блокировки/несогласованные миграции и скрытая зависимость от внутренней схемы `session`.

### G10. Нет integrity/corruption-политики для tasks-index — OBSERVED (отсутствие кода)
Найдены только: WAL/synchronous/busy_timeout (`taskIndexRepo.ts:404-407`), одноразовый `initializePromise` (`:368-383`), backup-каталоги при миграциях (`tasksDatabase/migrations.ts:203-206`), checksum-проверка применённой миграции (`:246-252`), rollback в транзакциях. `PRAGMA integrity_check/quick_check`, quarantine/rebuild повреждённой БД, retry на `SQLITE_CORRUPT` — отсутствуют (rg по `packages/services/src/session` и `packages/shared/src/sqlite-migrations` — 0). `initialize` при ошибке делает `close()` и пробрасывает (`taskIndexRepo.ts:376-380`), то есть повторная попытка возможна, но политики восстановления нет. UNKNOWN: как ведёт себя продукт при реальном повреждении файла — не проверялось.

### G11. Doc drift: persistence-спека отстаёт от кода — OBSERVED
`docs/v4-refactor/07-persistence.md:10-19` утверждает «текущая миграция 0018» и перечисляет 0014–0018. Фактический список в `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` содержит 27 миграций, последняя — `0028_swarm_run_journal` (`:1183`), включая `0019_dwf_journal`, `0020_provider_model_selection`, `0023_session_soft_delete_outcome`, `0025–0028`. Документ как «источник текущих фактов» устарел; ссылаться на него при аудите persistence нельзя без проверки кода.

### G12. `architecture-policy.yaml` ссылается на несуществующий public entrypoint — OBSERVED
`architecture-policy.yaml:20-31` объявляет модуль `session` с `publicEntrypoints`, первым из которых указан `packages/services/src/session/contract.ts`. Файла нет: `git ls-files --error-unmatch ...` → exit 1, `ls` → `No such file or directory`. Модуль `managed: false` (`:22`), а checker применяет правила только к managed (`scripts/architecture/index.mjs:135`; `policy.mjs:70`), поэтому `architecture:check --changed` проходит с 0 нарушений и не замечает битую декларацию. Риск: политика создаёт ложное впечатление контракта, которого нет; при включении `managed: true` проверка упадёт.

### G13. Логирование: смешение каналов и отсутствие корреляции вне traceId — OBSERVED
- `createServiceLogger` (`logger/serviceLogger.ts:18-56`) пишет через `console.*` sink, `debug` отключён вне dev (`:30-35,44-46`), корреляция — только префикс `[scope][trace:<id>]` (`:47`). Отдельного полевого logger-контракта (structured fields) нет.
- В services остаются прямые `console.*` вне logger: `zcodeAgentService.ts:6793` (`console.warn` при исчерпании 8 попыток подписки, `SESSION_SUBSCRIBE_MAX_ATTEMPTS=8`, `:506`), `node.ts:1339`, `memoryService.ts:160,181,200`, `settingService.ts:35`, `oauthService.ts:45`, `mcpSyncService.ts:813`, `outputStyleService.ts:68,80,172`. Это нарушает `AGENTS.md:81-85` и `packages/services/AGENTS.md:7-19`.
- `zcodeProtocolClient.ts` вообще не имеет logger (grep по `createServiceLogger|console` — 0): таймауты/отказы видны только через callback в process manager (`:1302-1337`) и логи вызывающего. Для диагностики «кто именно» (session/command) в момент timeout в process manager есть только `method/requestId/pid/workspaceKey` (`:1319-1325`), без sessionId.

### G14. Legacy mailbox / branch API объявлены, но не реализованы — OBSERVED
`IZCodeTaskService.deliverSessionMessage/sendSessionMessageDeliveryResult` (`src/session/zcodeTaskService.ts:315-319`) в adapter кидают `ZCODE_AGENT_UNSUPPORTED_LEGACY_TASK_METHOD` (`zcodeTaskServiceAdapter.ts:2102-2110`). При этом Desktop Host имеет полный маршрут `SessionMessageSendRequested → TaskRealtimeBus (30 s timeout, `taskRealtimeBus.ts:30,927-985`) → SessionMessageDeliver → zcodeTaskService.deliverSessionMessage`, который всегда завершится failed. `forwardSessionMessageSendRequested` объявлен в `createLocalServices` options (`src/node.ts:1235-1237`), но нигде не потребляется внутри services. UNKNOWN: фича намеренно выключена или сломана; тестов на end-to-end нет.

## 5. Strengths and differentiators

1. **CommandInbox — самая зрелая часть контура.** Фиксированный порядок локов key → per-session admission (`command-inbox.ts:134-156`), pin in-flight **до** освобождения key gate (`:173-178`), общий `final` promise для дубликатов, освобождение session FIFO на `settle` (в т.ч. failed), durable fallback `transcript → marker → child → discarded` (`:402-449`). 25 тестов, включая churn >512, single-flight query+execute и failed-settle (`tests/command-inbox.test.ts:546-640`).
2. **Явная модель владения состоянием.** `docs/v4-refactor/01-topology.md:113-124` и `task-realtime-sync.md:11-22` перечисляют владельцев для каждого класса состояния; код в основном следует этой таблице (CLI владеет projection/queue, Host — task index, Renderer — только overlay/черновик).
3. **Trusted connection carrier.** Подделываемые поля вычищаются перед инъекцией host-контекста (`zcodeAgentConnectionScope.ts:96-110`, `:270-287`); clientMode выбирает только attachment, не UI.
4. **Generation-guard везде, где есть await.** V4 routes проверяют identity после каждого await (`:2275-2331`), workspace startup разделяет identity/generation (`:4278-4293`, recheck в `startClient:1000-1025`), process start отменяется AbortController-ами (`:845-899`), UI store отбрасывает stale ACK/gap (по `docs/v4-refactor/04-sync-and-recovery.md`).
5. **Монотонность task index.** `writeRecord` транзакционен (`taskIndexRepo.ts:769-900`), `cli_updated_at = max(...)`, `deleted = max(deleted, ?)`, title handoff c custom-защитой (`:995-1030`); `applyCliFacts` сохраняет searchable/unread (`:973-1040`); `updateTaskPresentation` не перезаписывает `updated_at` (в списке колонок `:1187` его нет), поэтому исторический snapshot не откатывает свежие timestamps — подтверждено тестами syncer (`zcodeTaskIndexSyncer.test.ts:1969,2014`).
6. **Устойчивый recovery для двух topic-ов.** Раздельные epoch/seq/recovery, topic-local retry и warn-троттлинг раз в 60 s (`zcodeTaskIndexSyncer.ts:58-62`, `:300-320`), staging overflow → recovery, а не тихая потеря (`:346-356`); 73 теста покрывают gap/fault/duplicate/restart/fresh-subscribe.
7. **Ресурсная дисциплина в CLI.** Resident pool с high/low-water и TTL, preflight запрет деактивации при pinned CommandInbox (`v4-gateway.ts:2892-2900`, `session-residency.ts:23-39`), event-store prune по тику (`server.ts:353+`), WAL + bounded frames.
8. **Наблюдаемость памяти.** `registerMemoryDiagnosticsProvider("agent"/"task")` (`zcodeAgentService.ts:1422-1427`; `zcodeTaskServiceAdapter.ts:282-286`) даёт счётчики карт; это редкий для кодовой базы механизм, на который можно опереться при исправлении G1/G2.
9. **Browser-safe граница пакета.** Root entry не тянет `node:*`; enforced комментарием и реальным разделением `index.ts`/`node.ts` (`src/index.ts:95-98`), что защищает renderer bundle.
10. **Явные durability-инварианты входа.** «UI не очищает payload, пока CLI не записал queue/guided/transcript/rejected» (`docs/web-remote-control-task-command-queue.md:19-20`) и `sourceCommandId` end-to-end прослеживаются в кейс-каталоге (`conversation-session-case-catalog.md`, B09e и др.) — сильный контракт для будущих изменений.

## 6. Candidate recommendations

### CR-1. Подключить или удалить owner/lease/mirror-слой (G4)
- **Проблема/разрыв:** `taskRealtimePort` не инжектится, owner-команды не доставляются получателю; документация требует обратное.
- **ZCode evidence:** `packages/desktop/src/host/index.ts:3985-3992` (единственный вызов без порта), `:1428-1492` (ветка mirror недостижима), `:3731` (порт создан и не передан), `packages/desktop/src/host/taskRealtimeBridge.ts:194-227`, `packages/services/src/session/sessionRealtimePort.ts:19-43`, `docs/agents/runtime-boundaries.md:57-58`.
- **Решение:** решить судьбу явно. Вариант A — включить фичу: передать `activeSessionRealtimePort` в `createReportingRemoteZCodeTaskService`, зарегистрировать `onDidReceiveOwnerCommand` в Host и покрыть e2e mobile relay; Вариант B — удалить dead-код и синхронно поправить `runtime-boundaries.md`, `task-realtime-sync.md`, `AGENTS.md`.
- **Scope:** desktop host composition + services port + docs. **Out of scope:** изменение lease-модели, relay-протокола.
- **Ожидаемый эффект:** либо восстановленная mobile mirror/owner-маршрутизация, либо −~400 строк мёртвого состояния и снятие ложного требования.
- **Риски:** Вариант A — дублирование стрима/лишние lease; Вариант B — потеря забытой зависимости у mobile/bot сценариев.
- **Сложность:** M. **Приоритет:** P0.
- **Acceptance criteria:** в дереве нет свойства, которое объявлено и никогда не передаётся; e2e-тест «mobile attachment видит mirror батчи и stop/permission доходят до владельца» проходит; либо grep показывает 0 ссылок на удалённые API и документы обновлены в том же PR.
- **Verification:** `pnpm test -- packages/desktop/test/taskRealtimeBus.test.ts`, новый e2e `packages/desktop/test/e2e/.../mobile-owner-mirror`, `pnpm architecture:check --changed`.

### CR-2. Ввести единый teardown per-session состояния в services (G1)
- **Проблема/разрыв:** emitters, seq states, trace ids и adapter-карты не очищаются при close/delete, `emitWorkspaceEvent` деградирует линейно.
- **ZCode evidence:** `zcodeAgentService.ts:1338,1416,1648,2091-2100,2333-2343,4453-4470`; `zcodeTaskServiceAdapter.ts:266-283,1698-1712,2959-2964`; аудит `docs/analysis/memory-leak-audit-2026-09-03.md:86-94`.
- **Решение:** один внутренний `forgetSession(workspaceKey, sessionId)` в agent service, вызываемый из `closeSession` и из обработки CLI `session.removed`/`deleteSession` факта; emitters — self-dispose через `onDidRemoveLastListener` (паттерн уже есть у `pluginOperationProgressEmitters:2104-2113`). Adapter получает тот же сигнал через syncer/agent-service event и чистит свои карты по taskKey.
- **Scope:** `zcodeAgentService`, `zcodeTaskServiceAdapter`, event contract. **Out of scope:** пересмотр владения task index.
- **Ожидаемый эффект:** счётчики `memoryDiagnostics` (agent/task) перестают монотонно расти при циклах create→close→delete; `emitWorkspaceEvent` остаётся O(живых сессий).
- **Риски:** преждевременная очистка при повторном открытии той же сессии (нужен generation/identity guard); listener, держащий emitter после close, может получить «тихий» поток — поэтому событие teardown должно быть явным.
- **Сложность:** M. **Приоритет:** P0.
- **Acceptance criteria:** unit-тест «N create/close → размеры 4 карт не растут»; тест «delete→повторный resume восстанавливает эмиттер»; `memoryDiagnostics` в логах на e2e-прогоне показывает стабильные значения.
- **Verification:** focused unit `zcodeAgentService.test.ts` + `zcodeLegacyTaskCompatTaskIndex.test.ts`; затем e2e-сессия с 20 открытиями.

### CR-3. Ограничить/убирать failed host-команды и residual active input (G2, G3)
- **Проблема/разрыв:** failed-команды с payload хранятся бессрочно; после падения CLI `activePromptInputIds` может навсегда блокировать drain.
- **ZCode evidence:** `zcodeTaskServiceAdapter.ts:533-550,611-614,1637-1641`; отсутствие lifecycle-подписки в adapter (0 совпадений `onAgentRuntimeRestarted|onAgentRuntimeLifecycle`); `docs/analysis/memory-leak-audit-2026-09-03.md:92-94`.
- **Решение:** (а) failed-команда удаляется/переводится в bounded ring после явного terminal/UI-confirm; (б) adapter подписывается на runtime restart/close и сбрасывает `activePromptInputIds` для всех taskKey workspace; (в) `drainRuntimeCommands` добавляет timestamp-guard, чтобы не блокироваться навсегда.
- **Scope:** adapter, agent service event surface. **Out of scope:** CLI CommandInbox.
- **Ожидаемый эффект:** нет неограниченного роста payload в памяти; следующий accepted prompt после crash снова исполняется.
- **Риски:** сброс active id может привести к конкурентному drain двух команд, если старый turn ещё жив — нужен «recycle token», а не просто delete.
- **Сложность:** S–M. **Приоритет:** P1.
- **Acceptance criteria:** тест «crash во время turn → следующая enqueue исполняется»; тест «failed command удаляется после N минут/явного terminal, размер `runtimeCommands` не растёт».
- **Verification:** расширить `zcodeLegacyTaskCompatTaskIndex.test.ts` (уже 94 теста) + новый unit на lifecycle-reset.

### CR-4. Привести таймауты протокола к явной политике (G6)
- **Проблема/разрыв:** 3-минутный дефолт и перезапуск процесса на любой timeout; 10-секундный query-deadline не подключён.
- **ZCode evidence:** `zcodeProtocolClient.ts:50,168`; `zcodeAgentProcessManager.ts:1302-1337`; `packages/shared/src/zcode-protocol-v4/core.ts:83`; `zcodeAgentService.ts:7116-7126`; audit R3 `18-resume-race-audit-plan.md:105-120`.
- **Решение:** классифицировать методы (query/read/attachment vs long-running turn), передавать `timeoutMs` из констант в `queryConversationCommandsV4`, `rowsRange`, `fileChanges`, attachment reads; для idempotent query не recycle-ить процесс целиком (или recycle только после N подряд).
- **Scope:** services timeouts + process-manager policy. **Out of scope:** CLI handler budget.
- **Ожидаемый эффект:** предсказуемые SLA для UI-запросов; меньше «каскадных» kill всего workspace.
- **Риски:** слишком короткие query-таймауты на медленных дисках; нужно измерить p99.
- **Сложность:** M. **Приоритет:** P1.
- **Acceptance criteria:** таблица «метод → deadline → recycle?» в spec; unit-тесты на каждый класс; отсутствие recycle на query-timeout.
- **Verification:** `zcodeProtocolClient.test.ts`, `zcodeAgentProcessManager.test.ts` (есть 49 тестов), новый fault-injection тест в bootstrap.

### CR-5. Закрыть R2: per-session activation single-flight в legacy resume (G7)
- **Проблема/разрыв:** два параллельных `session/resume` могут материализовать два app.
- **ZCode evidence:** `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1476-1590`; сравнение с уже существующим `ColdSessionResumeCoordinator` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-session-resume.ts:46-83`); audit R2 `18-resume-race-audit-plan.md:71-103`.
- **Решение:** вынести общий `activationFlights: Map<sessionId, Promise<record>>` на уровне server context и переиспользовать его в `activateSessionForResume`; ошибка/отмена должна очищать flight с generation.
- **Scope:** CLI server-operations. **Out of scope:** V4 gateway READY.
- **Ожидаемый эффект:** один runtime owner на session при конкурентном открытии; нет двух `app.close()`/event sinks.
- **Риски:** flight, завершившийся ошибкой, должен ретраиться; иначе временный сбой залипнет.
- **Сложность:** M. **Приоритет:** P1.
- **Acceptance criteria:** тест «Promise.all двух resume → `createdAppOptions` для sessionId ровно 1» (готовый probe из audit); повторный resume после failure создаёт новый flight.
- **Verification:** `apps/zcode-cli/packages/bootstrap/tests/*resume*` + новый тест рядом с `command-inbox.test.ts`.

### CR-6. Не подменять ошибку hydration пустой projection на warm-пути (G8)
- **Проблема/разрыв:** при ошибке чтения persisted events warm-путь возвращает пустой snapshot как успех.
- **ZCode evidence:** `v4-gateway.ts:3301-3312`; audit R1 `18-resume-race-audit-plan.md:45-70`; отсутствие прямого теста в `tests/v4-gateway.test.ts`.
- **Решение:** всегда пробрасывать `fault.subscribe.resumeFailed` при ошибке первичного persisted-read; допустимый fallback — только для явно помеченного «derived/optional» чтения.
- **Scope:** gateway hydration. **Out of scope:** transcript hydration merge.
- **Ожидаемый эффект:** UI не открывает «успешно пустую» историю и не строит команды на revision=0.
- **Риски:** старые сессии с частично повреждёнными данными перестанут открываться — нужен UX-путь «показать ошибку и повторить».
- **Сложность:** S. **Приоритет:** P2.
- **Acceptance criteria:** unit: `loadPersistedEventsImpl = async () => { throw }` → `gateway.subscribe(...)` rejects; тест на warm-путь без `historyOpenings`.
- **Verification:** `apps/zcode-cli/packages/bootstrap/tests/v4-gateway.test.ts`.

### CR-7. Удалить/депрориоритизировать legacy host command queue (G5)
- **Проблема/разрыв:** публичный API и второй in-memory источник accepted input без production-потребителей.
- **ZCode evidence:** `zcodeTaskService.ts:322-359`; adapter `:2112-2215`; отсутствие вызовов (`rg`); `docs/web-remote-control-task-command-queue.md:27`.
- **Решение:** пометить методы `@deprecated` + `unsupported()` для V4-сборки, либо удалить вместе с `runtimeCommands`/drain и перенести нужные проверки в tests как historical. Обновить `apps/dev-docs/src/data/protocolDocs.ts:920`.
- **Scope:** services interface/adapter + docs. **Out of scope:** CLI CommandInbox.
- **Ожидаемый эффект:** −~500 строк состояния, −payload-риск G2; документация соответствует «одной очереди».
- **Риски:** внешние потребители `@zcode/services` (client/server) могут вызывать методы динамически — нужно проверить diag; в этом checkout вызовов нет.
- **Сложность:** M (удаление) / S (deprecate). **Приоритет:** P2.
- **Acceptance criteria:** grep 0 production-вызовов; тесты удалённого пути удалены/переориентированы; docs обновлены.
- **Verification:** `rg`, `pnpm knip`, `pnpm architecture:check --changed`.

### CR-8. Ввести политику целостности и единственного writer для SQLite (G9, G10)
- **Проблема/разрыв:** второй writer в CLI `db.sqlite` из services; нет integrity-check и recovery-политики.
- **ZCode evidence:** `sourceServerWorkspaceAliasRepo.ts:290-305,868-890`; `taskIndexRepo.ts:368-415`; `tasksDatabase/migrations.ts:246-252`; `docs/v4-refactor/07-persistence.md:5-11`.
- **Решение:** (а) оформить миграцию `workspace_id` как CLI-adapter операцию (или документированный service-контракт с общей блокировкой/версией); (б) добавить `quick_check` при старте tasks-index и quarantine+rebuild из CLI-фактов при corruption; (в) записывать в лог решение и путь бэкапа.
- **Scope:** persistence. **Out of scope:** смена схемы task index.
- **Ожидаемый эффект:** один владелец записи, предсказуемое восстановление, отсутствие silent data loss.
- **Риски:** rebuild может потерять pin/archive/unread — нужен явный merge.
- **Сложность:** L. **Приоритет:** P2.
- **Acceptance criteria:** corruption-тест (подменить файл/обрезать страницу) → сервис стартует по определённой политике; CLI db не пишется из services без контракта.
- **Verification:** `tasksStartupPreparation.test.ts` + новый fault-injection тест.

### CR-9. Привести логи и политику к контракту (G13, G12, G11)
- **Проблема/разрыв:** `console.*` вне logger, слабая корреляция, битый entrypoint в policy, устаревшая persistence-спека.
- **ZCode evidence:** `zcodeAgentService.ts:6793`; `node.ts:1339`; `memoryService.ts:160-200`; `packages/services/AGENTS.md:7-19`; `architecture-policy.yaml:20-31`; `07-persistence.md:10-19`; `migrations.ts:1183`.
- **Решение:** заменить `console.*` на `createServiceLogger`; добавить `sessionId/commandId` в warn-timeout контекст; удалить/создать `session/contract.ts`; обновить migration-таблицу до 0028.
- **Scope:** logging + docs/policy. **Out of scope:** формат лог-файлов.
- **Ожидаемый эффект:** production-диагностика без ad-hoc grep; политика отражает реальность.
- **Риски:** минимальные; объём механический.
- **Сложность:** S. **Приоритет:** P2.
- **Acceptance criteria:** `rg "console\\.(log|warn|error)" packages/services/src` даёт 0 вне тестов/легитимных sink; docs migration list совпадает с кодом; policy entrypoint существует.
- **Verification:** `rg`, `pnpm lint`, `pnpm architecture:check --changed`, `node scripts/check-doc-links.mjs`.

### CR-10. Согласовать mailbox API с реализацией (G14)
- **Проблема/разрыв:** объявленный cross-session messaging всегда падает на adapter.
- **ZCode evidence:** `src/session/zcodeTaskService.ts:315-319`; `zcodeTaskServiceAdapter.ts:2102-2110`; `packages/desktop/src/host/index.ts:1331-1358,3219-3250`; `taskRealtimeBus.ts:927-1000`.
- **Решение:** либо реализовать `deliverSessionMessage` через V4 `sendText` с trusted bot-scope, либо удалить маршрут из Host и типы; зафиксировать в spec.
- **Scope:** services + desktop host + docs. **Out of scope:** новые каналы.
- **Ожидаемый эффект:** нет всегда-падающего API и лишнего 30-секундного pending.
- **Риски:** удаление может затронуть недокументированный bot-сценарий — проверить `bots/*`.
- **Сложность:** M. **Приоритет:** P2.
- **Acceptance criteria:** e2e/unit «deliverSessionMessage возвращает success» или 0 ссылок на API; `SESSION_MESSAGE_DELIVERY_TIMEOUT_MS` не срабатывает в норме.
- **Verification:** `taskRealtimeBus.test.ts`, новый unit на adapter.

## 7. Open questions and unverified

- **Q1 (G4).** Owner/lease/mirror-слой не подключён в `packages/desktop/src/host/index.ts`. Это осознанно отключённая фича (mobile relay mirror ещё не включён) или регрессия композиции? В repo нет feature-флага, который бы это объяснял. UNKNOWN до ответа владельца desktop host.
- **Q2 (G4).** Есть ли другой Host-композиционный вход (например, отдельный remote/source-server host), который создаёт bridge и передаёт порт? В этом checkout поиск по `packages/**` (кроме tests) не нашёл `taskRealtimePort:` ни разу. UNKNOWN: возможно, код генерируется/собирается вне checkout.
- **Q3 (G1).** Ожидается ли, что CLI `session.removed` доходит до services? В `zcodeAgentService` нет обработчика removed-события (grep — 0); неясно, должен ли teardown быть pull (на close) или push (на событие).
- **Q4 (G7).** Достаточно ли `waitForDeactivation` плюс `context.sessions.get` для реального конкурентного открытия, или UI-слой сериализует resume до отправки? Runtime-probe из audit (два `Promise.all`) в этом исследовании не запускался (CLI-сервер не поднимался), поэтому вывод R2 остаётся «код без single-flight», а не «воспроизведённый баг в текущей сборке».
- **Q5 (G8).** Какой путь hydration реально используется для warm-сессии без `historyOpenings`? Нужен runtime-тест с реальным gateway host, чтобы понять, достижима ли ветка `return empty` в продукте.
- **Q6 (G10).** Что должен делать продукт при `SQLITE_CORRUPT` tasks-index: тихо пересоздать из CLI, показать ошибку, или блокировать старт? Продуктового решения в docs не найдено.
- **Q7.** Покрывает ли desktop E2E удаление/закрытие сессии с проверкой памяти? В `docs/testing/conversation-session-e2e-coverage-matrix.md` найдены case-статусы для stop/queue (`:1006-1010`), но не найдено кейса «create→close→delete→счётчики карт». UNKNOWN.
- **Q8.** Является ли `forwardSessionMessageSendRequested` в `createLocalServices` мёртвой опцией (объявлена `node.ts:1235-1237`, не потребляется)? Похоже на остаток фичи; нужно решение владельца.
- **Q9.** Насколько безопасно текущее поведение `onRequestTimeout` (recycle всего процесса) для мобильного replayable клиента при медленном query? Runtime-наблюдений нет; нужен fault-injection.
- **Q10.** Актуальны ли ограничения resident pool (8/16/10 мин) для больших монорепозиториев с сотнями сессий? Замеров RSS нет.

## 8. Evidence appendix

### 8.1 Зафиксированный baseline (OBSERVED)
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
$ pnpm architecture:check --changed
architecture: OK
base: merge-base upstream origin/dev
violations: 0
baseline: 0
new: 0
exit=0
```
CodeIndex: `state=ready`, `generation=1453`, `files=10007`, `chunks=26791`, `diagnostics=["Embedding search is unavailable; showing lexical results."]`.

### 8.2 Инвентарь (OBSERVED)
```text
packages/services/src: 531 .ts (36 *.test.ts), 67 подкаталогов + корень
package.json exports: storage-startup, ".", cua-permission-broker, process/processTreeTerminator, node
node.ts: 149 строк, начинающихся с export
крупнейшие файлы: zcodeAgentService.ts 7705, zcodeTaskServiceAdapter.ts 5845,
zcodeTaskIndexSyncer.ts 1955, zcodeAgentProcessManager.ts 1495,
taskIndexRepo.ts 1419, zcodeSessionService.ts 490, task-facts/index.ts 168
```
Импорты внутри `packages/services/src`: `@zcode/shared` 417, `@zcode/rpc` 52, `@zcode/shared/zcode-protocol-v4` 29, `@zcode/provider` 18, `@zcode/zcode-cua` 12, `@zcode/shared/node` 10, `@zcode/provider-node` 7, остальное < 7. Импортов в `@zcode/ui|desktop|server|web|client` — 0.

### 8.3 Выполненные проверки (OBSERVED)
| Команда | Результат |
|---|---|
| `npx vitest run tests/command-inbox.test.ts` (cwd `apps/zcode-cli/packages/bootstrap`) | 25 passed / 25 |
| `npx vitest run packages/services/test/zcodeSessionService.test.ts` | 17 passed / 17 |
| `npx vitest run packages/services/test/zcodeTaskIndexSyncer.test.ts` | 73 passed / 73 |
| `npx vitest run packages/services/test/zcodeAgentProcessManager.test.ts` | 49 passed / 49 (39.05 s) |
| `npx vitest run packages/desktop/test/taskRealtimeBus.test.ts` | 16 passed / 16 |
| `npx vitest run packages/ui/test/v4PendingCommandRegistry.test.ts` | 16 passed / 16 |
| `pnpm architecture:check --changed` | OK, violations 0 |
Итого: 6 файлов, 196 тестов, все прошли. Полные `typecheck/lint/test/e2e` не запускались.

### 8.4 Источники по коду (OBSERVED)
- `packages/services/package.json:8-36` — exports и зависимости.
- `packages/services/src/index.ts:1-3,95-98,105-123,186-203,228-230` — browser-safe root, session/task descriptors.
- `packages/services/src/node.ts:1192-1250,1404,2268,2510-2513,2546-2550,2576-2582,3093-3094` — композиция.
- `packages/services/src/zcode-session/zcodeSessionService.ts:32,104-140,190-210,213-264,267-370,374-500`.
- `packages/services/src/zcode-session/zcodeSessionDraftRegistry.ts:1-38`.
- `packages/services/src/zcode-agent/zcodeAgentService.ts:410-421,507,1297,1328-1336,1338,1410-1434,1416-1434,1422-1427,1629-1642,1648,1656-1680,2057-2076,2091-2100,2206-2331,2325-2343,2345-2403,2431,4080-4093,4156-4348,4350-4462,4453-4510,4812-5030,5033-5118,6379-6400,6876-7112,7116-7126,7645-7703`.
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:50,601-670,845-899,958-1130,1302-1337,1405-1430,1468+`.
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:187-190,246-288,300-390,505-704,1004-1046,1429-1451,1490-1641,1698-1712,2080-2260,2371-2437,2441-2500,2562-2696,2959-2976,3067-3090,3132-3191`.
- `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts:58-70,100-260,280-360,466-590,590-760,1000-1120,1432-1560,1677-1735,1797+`.
- `packages/services/src/task-facts/index.ts:24-168`; `task-facts/CONTRACT.md:1-14`.
- `packages/services/src/session/taskIndexRepo.ts:25,103,339-345,368-415,711-729,769-900,904-970,973-1040,1073-1110,1112-1150,1155-1209`.
- `packages/services/src/session/tasksDatabase/migrations.ts:64-170,172-260`; `schema-v1.ts:1-96`; `prepared.ts:1-16`.
- `packages/services/src/fs/atomicFileUtils.ts:62-180`.
- `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts:179-182,290-305,868-890`.
- `packages/services/src/logger/serviceLogger.ts:18-56`.
- `packages/services/src/session/zcodeTaskService.ts:315-359,782-784`.
- `packages/services/src/zcode-agent/zcodeV4HostCommand.ts:55-164`.
- `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts:30-110,178-179,240-330,380-470,689`.
- `packages/services/src/session/sessionRealtimePort.ts:1-45`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts:88-108,110-211,253-290,472-500`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:2873-2900,2919-2971,3089-3195,3287-3314`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1476-1590,2856-2880`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1539-1560`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts:169-181`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-flow.ts:31-32,421-439`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-session-resume.ts:46-83`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts:7-9,147-215`; `session-residency.ts:23-39`; `resource-sampler.ts:32-35`.
- `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts:688-1200`; `repositories/sessions.ts:128-139`; `paths.ts:5`.
- `packages/desktop/src/main/taskRealtimeBus.ts:24-30,128-140,186-202,321-423,854-1000,1036-1055`.
- `packages/desktop/src/host/taskRealtimeBridge.ts:27,71,135-256`.
- `packages/desktop/src/host/index.ts:1314-1332,1361-1372,1428-1492,3219-3250,3719-3731,3985-3992`.
- `packages/ui/src/v4/pendingCommandRegistry.ts:1-60,153-175,314-340,406-466,528-540`.
- `packages/ui/src/v4/conversationProjectionStore.ts:47,106-111,1338-1396`.
- `packages/shared/src/zcode-protocol-v4/core.ts:60-95`; `snapshot.ts:364-520`.
- `packages/shared/src/task-realtime.ts:80-100,120-178`.
- `packages/shared/src/channels.ts:110-116,641,745`.

### 8.5 Источники по спецификациям (OBSERVED)
- `AGENTS.md:3-6,15-30,41-51,55-70,74-85`.
- `packages/services/AGENTS.md:3-19`.
- `docs/agents/runtime-boundaries.md:7-32,34-64`.
- `docs/web-remote-control/task-realtime-sync.md:11-22,24-53,121-135,137-196,198-221`.
- `docs/web-remote-control-task-command-queue.md:5-31,33-50,52-73,75-109`.
- `docs/v4-refactor/01-topology.md:113-124`.
- `docs/v4-refactor/04-sync-and-recovery.md:1-120`.
- `docs/v4-refactor/07-persistence.md:5-22,40-70,72-96`.
- `docs/v4-refactor/18-resume-race-audit-plan.md:45-70,71-103,105-120,148-167`.
- `docs/session-idle-deactivation.md:7-34`.
- `docs/task-list-refresh-semantics.md:1-40`.
- `docs/conversation-session-case-catalog.md:529-604`.
- `docs/analysis/memory-leak-audit-2026-09-03.md:80-100`.
- `architecture-policy.yaml:17-31`.

### 8.6 Проверенные lifecycle-пути: тестировано vs не тестировано
| Путь | Что проверено | Статус |
|---|---|---|
| createSession (desktop-continuous) | `zcodeSessionService.test.ts` (CUA-инъекция, draft, broadcast); `zcodeLegacyTaskCompatTaskIndex.test.ts` (94 теста, включая create/drain) | TESTED (unit) |
| createSession + deferred draft | `zcodeSessionService.test.ts:98,140,185,238,287` | TESTED |
| resumeSession + model/thought-level replay | `zcodeSessionService.test.ts:669,716,782,851` | TESTED |
| closeSession / closeDeferredDraft | `zcodeSessionService.test.ts:238-323` | TESTED (unit, mocked agent) |
| deleteTask → CLI tombstone → task index | `zcodeLegacyTaskCompatTaskIndex.test.ts:2016-2077`; `zcodeTaskIndexSyncer.test.ts:432-533` | TESTED (unit) |
| deleteTask → очистка services-карт | нет теста; код отсутствует | NOT TESTED / MISSING CODE |
| stopGeneration (V4 stop) | `zcodeLegacyTaskCompatTaskIndex.test.ts:2753-2854` | TESTED |
| host command queue enqueue/promote/cancel | `zcodeLegacyTaskCompatTaskIndex.test.ts:2267-2716` | TESTED, но production-вызовов нет |
| owner/lease/stale-run (bus) | `packages/desktop/test/taskRealtimeBus.test.ts:294-348,615-664` | TESTED (isolated); wiring отсутствует |
| owner command → host receiver | нет получателя | NOT WIRED / NOT TESTED |
| workspace startup single-flight | `zcodeAgentProcessManager.test.ts:338-421` | TESTED |
| process idle recycle (mcp-status lane) | `zcodeAgentProcessManager.test.ts:1011-1097` | TESTED |
| request-timeout → recycle | `zcodeAgentProcessManager.test.ts` (частично); отдельного теста классификации нет | PARTIAL |
| CommandInbox FIFO/идемпотентность/query | `apps/zcode-cli/.../tests/command-inbox.test.ts` (25) | TESTED |
| session deactivation / resident pool | `apps/zcode-cli/.../tests/session-resident-pool.test.ts` (не запускался) | EXISTS, NOT RUN |
| sync snapshot/delta/gap/recovery | `zcodeTaskIndexSyncer.test.ts` (73) | TESTED |
| hydration failure | нет прямого теста; частичный guard в коде | NOT TESTED |
| concurrent legacy resume (R2) | probe в audit-документе, в текущих тестах не найден | NOT TESTED |
| UI overlay settle | `v4PendingCommandRegistry.test.ts` (16), `v4SessionDataLayer.test.ts` (68) | TESTED |
| mobile replayable cold restore | desktop E2E (442 файла, не запускались) | NOT RUN HERE |
| DB corruption/recovery | тестов нет | NOT TESTED |

---

**Coverage status: partial.**

Что не проверено:
- не запускались полные `pnpm typecheck`, `pnpm lint`, `pnpm test`, desktop E2E (442 файла), CLI fault-matrix и resident-pool тесты;
- не поднимался реальный CLI/gateway для runtime-воспроизведения R1/R2/hydration/owner-command сценариев;
- не проверялась другая Host-композиция (remote/source-server), которая могла бы подключить `taskRealtimePort`;
- не проверялось поведение при реальном повреждении SQLite и реальном cross-process lock на Windows;
- не выполнялся замер RSS/памяти для подтверждения G1/G2 количественно (только статический разбор и счётчики `memoryDiagnostics`).

Подтверждение записи: создан только файл `docs/research/partials/2026-11-11-zcode-05-services-session.md`; продакшн-файлы не изменялись, коммитов нет. `git status --short` до и после записи показывает `?? docs/research/` (каталог untracked); `git diff --stat` пуст.
