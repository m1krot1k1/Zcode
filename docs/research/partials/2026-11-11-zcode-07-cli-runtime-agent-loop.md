# Z07 — apps/zcode-cli: runtime и agent loop

Ветка: `dev`; коммит на момент исследования: `d10f0b69 Выпустить macOS Preview 3.17.102.`
Дата: 2026-11-11. Режим: evidence-first, read-only (единственный записанный файл — этот partial).

## 1. Scope and method

### 1.1 Вопрос и границы

Задача — карта исполнения агентного цикла в `apps/zcode-cli`: жизненный цикл turn, вызов модели, разбор и исполнение tool calls, approvals, обработка ошибок, лимиты, session/runtime-состояние, streaming и context window, а также фактическое покрытие тестами. Отдельно фиксируются пробелы и риски с привязкой к источникам.

Границы: `apps/zcode-cli` (вложенный pnpm-monorepo). Основной предмет — `packages/core` (runtime, turn loop, tool executor, permission, compact, session persistence), `packages/adapters` (model runner, retry, failure classification), `packages/bootstrap` (CommandInbox, protocol-v4, runtime assembly), `packages/cli` и `packages/tui` (entrypoints, approval UX). Desktop/web UI, RPC-фреймворк и бизнес-сервисы верхнего уровня вне scope.

### 1.2 Метод

1. Базовая линия git зафиксирована до любых действий:
   - `git status --short` → `?? docs/research/`
   - `git branch --show-current` → `dev`
   - `git log -1 --oneline` → `d10f0b69 Выпустить macOS Preview 3.17.102.`
2. `CodeIndex status` → `state: ready`, `partial: false`, generation 1453, 10007 files / 26791 chunks / 278154 symbols; диагностика `Embedding search is unavailable; showing lexical results.` Лексический поиск по общим запросам оказался шумным, поэтому карта строилась по структуре каталогов (`find`, `ls`) и адресному чтению владельцев поведения.
3. Основной инструмент доказательств — чтение исходников (`nl -ba`, `sed -n`) и узкие `rg -n` запросы. Индексные указатели отделены от проверенных фактов: всё, что ниже помечено как факт, прочитано в исходнике.
4. Выполнены узкие тесты (не полный suite). Точные команды и результаты — в §8.2.
5. Никакие production-файлы не изменялись; `git status --short` после записи partial должен содержать только `?? docs/research/`.

### 1.3 Обозначения

- **Observed (FACT)** — подтверждено чтением исходника/док-файла или выводом выполненной команды.
- **Inferred** — вывод из нескольких подтверждённых фактов, прямо не наблюдавшийся.
- **Unknown** — источники не дают ответа.

### 1.4 Структура `apps/zcode-cli`

**Observed.** `apps/zcode-cli` — самостоятельный pnpm-workspace внутри репозитория: `apps/zcode-cli/pnpm-workspace.yaml:1-3` объявляет `packages/*` и `tools/*`. Манифест верхнего уровня (`apps/zcode-cli/package.json:1-59`) описывает `zcode-cli` 0.17.0 и скрипты `build`/`test`/`typecheck`/`lint`/`registry:check`, которые делегируют turbo-задачам по пакетам. `engines.node` — 24.14.0, `packageManager` — pnpm@10.33.2.

Пакеты, релевантные scope (по `packages/*/package.json` и каталогам):

| Пакет | Роль в agent loop | Ключевые каталоги |
| --- | --- | --- |
| `@zcode/core` (`packages/core`) | Единственный владелец turn loop, tool executor, permission service, compact, session hydration | `src/agent`, `src/runtime`, `src/runtime/methods`, `src/tool`, `src/tool/executor`, `src/permission`, `src/compact`, `src/context`, `src/runtime-task` |
| `@zcode/adapters` (`packages/adapters`) | Model runner, retry/backoff, failure classification, stream idle timeout, session store, fs/exec/http ports | `src/model`, `src/storage`, `src/exec`, `src/fs`, `src/http`, `src/mcp` |
| `@zcode/bootstrap` (`packages/bootstrap`) | Сборка AgentRuntime, CommandInbox, protocol-v3/v4, interaction broker | `src/app`, `src/zcode-protocol`, `src/zcode-protocol-v4` |
| `@zcode/cli` (`packages/cli`) | Entrypoint (`src/main.ts`), arg parsing, headless prompt, TUI launch, plugins/skills commands | `src`, `src/command-center`, `src/internal-search` |
| `@zcode/tui` (`packages/tui`) | TUI rendering, approval panel, submit/queue UX | `src` |
| `@zcode/contracts` / `@zcode/shared-types` | Типы, схемы, конфиг-дефолты, CoreErrorType, permission port | `src/*` |

**Entrypoints.** `packages/cli/src/main.ts:15-110` — единственная точка входа: sanitization env, stderr/console boundary, process error boundary, отдельная ветка `plugin-host`, затем динамический `import("./run.js")` и `run(context, ...)`. `packages/cli/src/run.ts:305+` маршрутизирует: `storage-migrate` (`:306-330`), protocol server (`:252-303`), headless prompt (`:566`, `:584`), TUI (`:643`). Режим по умолчанию для headless: `DEFAULT_HEADLESS_PROMPT_MODE = "yolo"` (`packages/cli/src/run.ts:52`).

## 2. Coverage table

Пункты соответствуют SPECIFIC SCOPE Z07 (1–10).

| # | Пункт scope | Что проверено | Статус | Основные доказательства |
| --- | --- | --- | --- | --- |
| 1 | Карта `apps/zcode-cli` | pnpm-workspace, 30 пакетов, entrypoints, commands, adapters, runtime, tests, config | complete | `apps/zcode-cli/pnpm-workspace.yaml:1-3`; `apps/zcode-cli/package.json:1-59`; `packages/cli/src/main.ts:15-110`; `packages/cli/src/run.ts:252-303,305+,566,584,643` |
| 2 | Agent loop: lifecycle, planning, model invocation, tool parse/exec, observation, termination, max turns, stop, interrupts, resume | Полный путь `executeTurn → executeTurnCommand → runRegularTurnLoop → runModelBackedTurnStep → executeToolCallsForModelStep → finishModelStepWithoutToolCalls`; maxTurns; stop hooks; abort; resume | complete | `runtime/methods/turn.ts:124-162,164-260,486-494,851-911,915-946,979-1001,1088-1196`; `turn-loop.ts:110-347`; `turn-model-step.ts:142-822`; `turn-tools.ts:31-298`; `turn-stop.ts:157-237` |
| 3 | Approvals: когда спрашивается, режимы, persistence allow/deny, per-tool rules, bypass, UI/CLI prompts | `PermissionService` (порядок правил), broker, approval gate, permission flow, persistence, TUI/headless/protocol UX | complete | `permission/service.ts:117-291,602-605`; `permission/broker.ts:24-167`; `tool/executor/permission-flow.ts:44-333`; `tool/executor/permission-rules-persistence.ts:19-128`; `tui/src/app-approval.ts:14-16,127-149`; `cli/src/headless-workflow.ts:31-51` |
| 4 | Error handling: provider/tool errors, malformed tool calls, retries, fallback, degradation, user-visible errors, partial results | Классификация ошибок, adapter retry, selection fallback, stream recovery, reactive compact, TurnError/TurnComplete, synthetic results | complete | `contracts/src/errors/index.ts:9-54`; `adapters/src/model/retry-policy.ts:13-49`; `runtime/methods/streaming-recovery.ts:14-40,239-260,376-401`; `runtime/methods/turn-execution-fallback.ts:50-138`; `runtime/methods/turn-model-step.ts:276-518`; `runtime/helpers/turn-errors.ts:242-324` |
| 5 | Limits: context/token, turn, timeouts, output caps, cost, concurrency | maxTurns, output caps (32k/остаток окна), tool deadline 300s, idle 600s, first-token 90s, retry caps, concurrency 10, result budget 100KB, отсутствие cost cap | complete (с пробелами, см. §4) | `turn-loop.ts:49-55,116-125`; `model-token-limits.ts:5-41`; `tool/executor/impl.ts:43-44,97`; `contracts/src/config/index.ts:287-301,350-356`; `tool/executor/result-serialization.ts:34-41`; `compact/policy.ts:6-14` |
| 6 | Session/runtime: persistence, resume, checkpointing, CommandInbox admission, busy/running input, cancellation, stale guards, reconnection | `executeTurnCommand`, reservation, runtimeCommandQueue, CommandInbox, steer/guide, cancellation, stale branch, resume/hydration | complete | `turn.ts:164-260`; `runtime/methods/prompt-admission.ts:21-160`; `runtime/methods/runtime-command-queue.ts:25-128,206-335,467-493`; `bootstrap/src/zcode-protocol-v4/command-inbox.ts:110-150`; `runtime/methods/runtime-command-generation.ts:6-67`; `runtime/methods/resume.ts:71-340` |
| 7 | Streaming: model stream, tool stream, event emission, ordering, backpressure, UI/CLI rendering | Event queue с high-water 128, stream deltas, tool input deltas, streaming tool execution, ledger events | complete | `runtime/methods/model-streaming-event-queue.ts:4-73`; `runtime/methods/model.ts:191-280`; `runtime/methods/streaming-tool-coordinator.ts:42-186,387-410`; `runtime/methods/model-streaming-event.ts:5-14` |
| 8 | Context window: assembly, truncation/compaction/summarization, cache, prompt caching, token accounting | ContextBuilder, microcompact, autocompact, reactive compact, rapid-refill breaker, cache_control, usage records | complete | `context/builder.ts:40-120`; `compact/policy.ts:67-155`; `compact/microcompact.ts:12-29`; `runtime/methods/compact.ts:184-300`; `runtime/helpers/provider-request-messages.ts:326-367`; `runtime/methods/usage-observability.ts:56-110` |
| 9 | Tests: unit/integration по loop, approvals, stop/resume, errors, limits; чего нет | 306 test-файлов в core, 164 adapters, 237 bootstrap, 28 cli, 29 tui, 44 contracts; узкие прогоны 357 тестов | complete (инвентарь), missing-cases в §4/§7 | §8.2; `packages/core/tests/*` |
| 10 | Gaps/risks: checkpointing, recovery, approvals, error taxonomy, unbounded loops, cost controls | Каждый пункт проверен по коду; подтверждённые пробелы вынесены в §4 | complete | §4 |

**Ограничения покрытия (Observed).** Полный `pnpm test` / `pnpm typecheck` / `pnpm lint` не запускались (запрещены режимом ветки и объёмом). Реальные provider E2E (`e2e/compact-microcompact`, `e2e/memory`) не запускались: требуется сеть и API key (`apps/zcode-cli/e2e/compact-microcompact/README.md`, раздел Local). Desktop/mobile E2E и web-remote-replayable путь не проверялись — вне Z07.

## 3. Capability inventory

### 3.1 Карта agent loop (file:line)

**Точка входа и admission.**

| Шаг | Владелец | Доказательство |
| --- | --- | --- |
| Публичный вход turn | `AgentRuntime.executeTurn` | `runtime/methods/turn.ts:124-162` — создаёт `PromptRuntimeCommand` (`mode: "prompt"`, `priority: "next"`) и ставит его в очередь через `enqueueCancellableRuntimeCommand` |
| Admission в protocol-режиме | `admitPrompt` | `runtime/methods/prompt-admission.ts:21-160` — busy-проверка, reservation (`:112-117`), enqueue (`:127-155`) |
| Исполнение команды | `executeTurnCommand` | `runtime/methods/turn.ts:164-260` — заморозка selection/style до первого `await` (`:171-190`), создание turnId/queryId/trace (`:192-205`), reservation (`:211`), abort scope (`:213-214`), root-run budget (`:215-226`) |
| Активация turn | `beginActiveTurn` | `turn.ts:486-494`; `runtime/methods/steering.ts:328-356` (запрет второго turn и конфликт reservation) |
| Инициализация контекста и hooks | `ensureContextInitialized` / `runSessionStartHooks` | `turn.ts:430-455` |
| Persist user input и TurnStarted | `appendEvent` + `persistUserPrompt` | `turn.ts:527-567,719-780` |
| Формирование loop state | inline object | `turn.ts:851-911` (`modelStepCount: 0`, `toolCallCount: 0`, `turnRequestState.entries` из `messageHistory.borrowReadOnlyRuntimeEntries()`) |
| Запуск цикла | `runRegularTurnLoop` | `turn.ts:914-951`, реализация `turn-loop.ts:110-347` |

**Turn loop (по итерациям).** `turn-loop.ts:117-346`:

1. `throwIfTurnAborted` + `refreshOffPeakTurnAfterTakeover` — `:118-119`.
2. Проверка `maxTurns` на границе нового model step — `:120-125`.
3. Drain runtime commands (только при `modelStepCount > 0`, не в output-token recovery) — `:132-142`.
4. Подмешивание settled project-memory recall после реального tool batch — `:144-151`.
5. `microcompactIfNeeded` — `:153-161`.
6. Быстрый refill-детектор и `autoCompactIfNeeded`; при `rapid_refill_blocked` — throw — `:163-190`.
7. `initializeMcp` / `refreshMcpToolsIfChanged` — `:193-198`.
8. Сборка tool set (`getTurnTools`), agent listing, plan-exit/runtime-mode/todo/output-style reminders, tool-search announcement — `:199-275`.
9. Сборка provider request (`prepareRuntimeProviderRequest`) c `applyCacheControl: true` — `:278-301`.
10. Перевод turn machine в `startModelRequest` и лог `model.request.started` — `:314-330`.
11. `runModelBackedTurnStep` — `:332-341`; `break` только если step вернул `"break"` — `:343-345`.

**Model step.** `turn-model-step.ts:142-822`:

- Персистенция assistant-контейнера и `step-start` part, event `ModelRequest` — `:184-218`.
- Создание `streamingToolCoordinator` — `:219-224`.
- `runModelTextRequest` с вычисленным `maxOutputTokens` (`resolveModelStepMaxOutputTokens`) — `:241-274`.
- Обработка исключения: usage record → selection fallback → stream recovery → off-peak takeover → Start Plan admission retry → Start Plan exhaustion → cancel persistence → persist assistant error → reactive compact при context exceeded → throw — `:276-518`. Комментарии в этом блоке фиксируют конкретные root causes (например, `:288-291` про порядок fallback/recovery; `:310-316` про сброс output-token счётчика после fallback).
- Успешный путь: учёт usage, парсинг tool calls, `automationCreateLimitReached` (принудительный text-only), диагностика, output-token continuation (`:520-575`), context-exceeded по finish reason (`:576-600`), suspicious empty (`:601-632`), персистенция reasoning/text parts (`:636-669`), `ModelComplete` (`:680-704`), machine `receiveModelResponse` (`:716-718`), исполнение tool calls (`:731-734,796-821`).

**Tool execution.** `turn-tools.ts:31-298`:

- Нормализация tool calls и pending tool parts + ledger `tool_call_closed` — `:48-121`.
- `scheduleTools` (топологический порядок) и machine `scheduleTools` → `startToolExecution` — `:126-134`.
- `emitToolScheduledEvents`, `tool_queued`, `executeTools` с `onBatchStart` (persist running parts + `tool_started`) — `:135-221`.
- Слияние streamed и pending результатов, `settleToolResults` — `:222-239`.
- `stopTurnAfterResult` (automation limit / plan-exit / terminal tool) → `break` — `:241-280`.
- Anomaly warnings, `persistToolModelStepFinish`, `completedRealToolResultBatch`, inline guide drain — `:282-297`.

**Termination.** `turn-stop.ts:157-237`:

- Нет tool calls → персистенция assistant (`includeEmptyAssistant: true`), затем последовательно: automation text-only break (`:176-194`), inline guide → `continue` (`:195-200`), Stop hooks → `continue` при `stopShouldContinue` и лимите 3 (`:201-217`), иначе fallback guides to queue, `steerable = false`, `complete(..., "success")`, `break` (`:218-237`).

**Машина состояний.** Фазы и допустимые переходы — `agent/turn-state.ts:27-40,233-266`; API — `agent/turn-machine.ts:41-66`; реализация переходов — `:92-343`. Терминальные типы результата — `agent/turn-state.ts:151-158`: `success`, `cancelled`, `error_max_turns`, `error_max_budget`, `error_during_execution`, `error_max_tool_calls`.

**Planning.** Отдельной «planning-фазы модели» в главном loop нет: решение принимает сама модель через tool calls. Два исключения:
- **Plan Mode** — policy-слой (`permission/service.ts:227-229,472-514`; `permission/plan-mode-policy.ts:20-43`) и `ExitPlanMode` turn-control (`tool/executor/turn-control.ts:44-82`).
- **Swarm planner** — только для explicit swarm с root-run budget: `turn.ts:916-945` (`shouldRunRootSwarmPlanner`), реализация `executeSwarmRun` в `turn.ts:1384+`; `SWARM_PLAN_MAX_ATTEMPTS = 2`, `SWARM_PLAN_MAX_OUTPUT_TOKENS = 4096` (`turn.ts:1262-1266`).

### 3.2 Approvals

**Когда спрашивается.** Синхронный `PermissionService.checkPermission` (`permission/service.ts:117-291`) возвращает `allow | ask | deny`. Порядок ветвей (важен для рисков §4):

1. Plan-mode transition (`EnterPlanMode` allow; `ExitPlanMode` deny вне plan) — `:126-130`.
2. `requiresUserInteraction` → hard block через `disallowedTools` иначе `ask` — `:132-148`.
3. Guarded + `userApprovalRule` (dangerous command) → `ask` c `approvalMode: "user-once"` — `:150-162`.
4. `alwaysAsk` (tool-declared) → `checkAlwaysAsk` — `:164-167`, `:393-452`.
5. `yolo`/`guarded` без plan → `allow` (`mode.yolo`) — `:169-171`.
6. `auto` → `deny` «reserved but not implemented» — `:173-180`.
7. `disallowedTools` → deny — `:182-189`.
8. project `deny` → deny; project `ask` → ask — `:191-207`.
9. Channel-reply preapproved (`network`, medium risk, не destructive) → allow — `:209-225`.
10. Plan mode → `checkPlanMode` (readOnly, non-destructive MCP, session-scope explicit capability, иначе deny) — `:227-229,472-514`.
11. project `allow` → allow — `:231-238`.
12. MCP stored result page и preapproved WebFetch → allow — `:240-256`.
13. Preapproved workflow draft write → allow — `:258-275`.
14. `allowedTools` → allow — `:277-284`.
15. Edit mode (`permissionName === "edit"` + workspace) → allow, иначе build — `:286-290,586-600`.
16. Build mode: readOnly allow; critical ask; high ask (если `!autoApproveHighRisk`); low-risk session scope allow; side effects ask; иначе allow — `:520-584`.

**Режимы.** `CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto"` (`contracts/src/interfaces/session.port.ts`). CLI принимает `build|plan|edit|yolo|guarded` и отвергает `auto` (`packages/cli/src/run.ts:143-157`); переключаемые режимы command-center — `packages/cli/src/command-center/modes.ts:4-13`. Defaults конфигурации: `mode: "build"`, `autoApproveHighRisk: false`, `allowMediumRiskInAuto: false` (`contracts/src/config/index.ts:302-308`).

**Bypass-пути (все Observed):**
- `guarded` dangerous-command `user-once`: `permission-flow.ts:170-178` принудительно `gate: "ask"` даже если tool `prepareApproval` вернул `proceed`; ответ валидируется как single-use — `tool/executor/permission-response.ts:41-42,92-111` (нельзя вернуть `escalate`, нельзя приложить `permissionUpdates`/`sessionPermissionUpdates`).
- `guarded` не принимает hook-allow для опасной команды — тесты `core/tests/guarded-approval.test.ts:417`.
- `alwaysAsk` блокируется hard-deny до ask, но **пропускает** session-level allow и owned-workflow amend — `permission/service.ts:424-451`.
- TUI авто-разрешает `CreateWorkflow`/`AmendWorkflow` на клиентском слое без записи правил — `tui/src/app-permission.ts:13-50`.
- Headless (`-p`) авто-разрешает те же два tool, остальное fail-closed через `DenyPermissionBroker` — `cli/src/headless-workflow.ts:31-51`.
- «Полный доступ» = транзакционный перевод режима в `yolo` с receipt и фиксированным набором queueItemIds — `runtime/permission-full-access.ts:18-80`.
- Default runtime broker — `DenyPermissionBroker` (fail-closed), в `guarded` бросает `ConfigurationError` вместо deny — `permission/broker.ts:24-39`; в runtime `deps.permissionBroker ?? createDenyPermissionBroker()` — `runtime/agent-runtime.ts:332-333`, `tool/executor/impl.ts:37`.

**Persistence и per-tool rules.** `applyPermissionUpdates` поддерживает только `addRules` с дедупликацией по `(toolName, ruleContent)` — `tool/executor/permission-rules.ts:3-46`. Загрузка: session-scope ruleset из session, иначе project ruleset — `permission-rules-persistence.ts:19-27`. Запись: project rules сохраняются в store; session-grant идёт только в память `PermissionService.sessionRules` и никогда не персистится — `permission-rules-persistence.ts:82-128`; контракт `sessionPermissionUpdates` явно описан в `contracts/src/interfaces/permission.port.ts:82-87`. Сбой записи project-правила возвращает tool error и не применяет session-grant — `permission-rules-persistence.ts:92-110`.

**Правила matching.** `ruleContent` поддерживает `prefix:*` и `*` (wildcard → RegExp), иначе точное совпадение — `permission/service.ts:367-380`; subjects берутся из `command`, `url`, `file_path`, `path`, `pattern`, `patch_text` — `:343-358`; `Write` матчится правилом `Edit` — `:324-327`; `official_cua` матчится только при наличии capability group — `:329-341`.

**Запрос к клиенту.** `requestPermission` формирует `requestId = "perm_" + uuid`, suggested updates (или `buildDefaultPermissionUpdates`), публикует `permission_requested` и гоняет два responder-а: broker и `PermissionRequest` hooks — `tool/executor/permission-flow.ts:180-276`, `tool/executor/permission-request.ts:21-138`. При `guarded` hook-rewrite валидируется и при необходимости идёт `rewrite` с новым requestId — `permission-flow.ts:209-254`. Ошибка broker/hook не превращается в «пользователь отказал»: `ToolExecutionFailed` в guarded, `PermissionDenied` иначе — `permission-flow.ts:256-273`.

**UI.** TUI: `decisionsForApproval` даёт `["allow_once","allow_project","deny"]`, а при `user-once` — только `["allow_once","deny"]` (`tui/src/app-approval.ts:14-16,246`); Esc = deny (`:53-55`); `allow_project` при `user-once` понижается до deny (`:131-140`).

### 3.3 Error handling

**Наложение уровней (снизу вверх).**

1. **Adapter retry/backoff.** Default `maxAttempts = 11` (10 retries), base 2s, factor 2, cap 60s, jitter — `adapters/src/model/retry-policy.ts:13-16,42-49`; env-override `ZCODE_MODEL_RETRY_*` — `:18-21,77-85`. `Retry-After` > 5 минут трактуется как quota exhausted и не ретраится — `:23-40`. Retry-budget `SingleAttempt` схлопывает попытки до 1 — `adapters/src/model/retry-budget.ts:16-38`.
2. **First-token watchdog** 90s и **stream idle** 600s (+30s на каждый retry) — `contracts/src/config/index.ts:287-290`; `adapters/src/model/stream-idle-timeout.ts:5-24`; `adapters/src/model/first-token-watchdog.ts:1-78`.
3. **Execution-selection fallback** (например, high-speed provider → сессионная модель): создание — `turn-execution-fallback.ts:50-67`; request-time — `:107-138`; кандидаты и запрет возврата на того же provider — `:78-98`. Cancel и context-exceeded fallback не запускают; OpenCode 429/sign-in — тоже — `:114-128`.
4. **Core stream recovery**: 10 попыток — `runtime/methods/streaming-recovery.ts:14`; transient-коды/причины — `:24-40`; recovery частичного вывода (reasoning и text) — `:239-260`; при уже начатых tool calls — settlement и повтор — `streaming-tool-coordinator.ts:196-250`. Синтетические результаты: `not_executed` / `unknown_execution_state` — `streaming-tool-synthetic-result.ts:13-52`.
5. **Reactive compact** при context exceeded, один раз на model step, с rapid-refill breaker — `turn-model-step.ts:831-894`, `turn-loop-state.ts:212-236`.
6. **Терминальный исход**: `TurnComplete(cancelled)` для отмены, `TurnError` для остального — `runtime/helpers/turn-errors.ts:266-322`; `projectExecutionErrorPayload` сохраняет provider business code/attribution в payload (`turn-errors.ts:268,296-313`), что покрыто тестами `core/tests/turn-errors.test.ts:212-413`.

**Malformed tool calls.** Валидация на admission: пустое/невалидное имя → registry miss, `tool_use_error` в provider-visible content — `tool/executor/call-runner.ts:72-108`; нормализация имени (trim) и сохранение пустого имени за non-empty storage projection — `runtime/methods/turn-model-step.ts:528-544`, `core/tests/model-tool-call-validation.test.ts:18-137`; input validation формирует `<tool_use_error>InputValidationError: ...` — `tool/input-validation-model-content.ts:12-60`; ошибка sanitized malformed input возвращается как failed tool result и run продолжается — тест `core/tests/runtime-tool-loop.test.ts:11696`.

**Tool errors.** Не прерывают turn (кроме `turnControl.stopTurnAfterResult`): batch продолжает следующие группы — `tool/executor/batch-runner.ts:132-158` (закомментированная старая стратегия оставлена как объяснение). Permission denial сохраняется provider-visible и не блокирует следующие tool calls — тесты `tool-executor-error.test.ts:13-42`, `runtime-tool-loop.test.ts:15797`.

**Degradation.** `automationCreateLimitReached` принудительно переводит turn в text-only, скрывает tools (`turn-loop-state.ts:54-56`) и игнорирует галлюцинированные tool calls (`turn-model-step.ts:531-544`). Suspicious empty отличает provider business error и context overflow от пустого успеха — `turn-model-step.ts:576-632`; тесты `runtime-model-anomaly.test.ts:71-260`. Сбой preview в approval-gate не ослабляет ask — `approval-gate.ts:61-74`.

### 3.4 Limits

| Лимит | Значение / семантика | Доказательство |
| --- | --- | --- |
| `maxTurns` | Только явный positive safe integer; иначе лимита нет. Проверка перед новым model step. | `turn-loop.ts:49-55,116-125`; `docs/specs/max-turns-limit.md:24-74` |
| Терминал при достижении `maxTurns` | `TurnComplete(resultType: "error_max_turns")` + durable `metadata.turnResult` на assistant текущего turn; cold hydration читает маркер | `turn-loop.ts:62-108`; `message-persistence.ts:397-415`; `bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:282-290` |
| Output budget обычного запроса | `min(model.optionSpecs.maxOutputTokens.max, contextWindow - estimatedUsage - 1000)`; если модель не объявила — 32 000 | `runtime/methods/model-token-limits.ts:5-41` |
| Output-token continuation | Максимум 3 продолжения на query-local цепочку, затем `ModelError` (`model_output_limit_exceeded`) | `runtime/methods/turn-output-token-continuation.ts:18,27-57`; тест `runtime-output-token-continuation.test.ts:221` |
| Stop-hook continuation | Максимум 3 | `runtime/methods/hooks.ts:10,120-129` |
| Tool timeout | Default 300 000 ms, per-tool policy (`none`, `defaultMs`, `maxMs`, `allowCallOverride`, `cleanupGraceMs`); deadline приостанавливается на admission-ожидании | `tool/executor/impl.ts:43`; `tool/executor/timeout.ts:19-75,170-195` |
| Tool concurrency | 10 (executor default и `toolConcurrency.maxConcurrency` конфига) | `tool/executor/impl.ts:97`; `tool/scheduler.ts:48`; `contracts/src/config/index.ts:350-352` |
| Tool result budget | `maxInlineBytes`/`maxModelBytes` 100 000, strategy `truncate`, head preview; artifact при явной политике | `tool/executor/result-serialization.ts:34-41,97-113` |
| Model stream idle | 600 000 ms + 30 000/retry | `contracts/src/config/index.ts:287`; `adapters/src/model/stream-idle-timeout.ts:5-24` |
| First token | 90 000 ms, `<=0` выключает | `contracts/src/config/index.ts:290`; `first-token-watchdog.ts:54-78` |
| Adapter retries | 11 attempts (10 retries) по умолчанию | `adapters/src/model/retry-policy.ts:13-16,42-49` |
| Core stream recovery | 10 | `runtime/methods/streaming-recovery.ts:14` |
| Autocompact | `contextWindow - min(maxOutput, 21K) - 13K`; порог 100%; 3 подряд failures = circuit breaker | `compact/policy.ts:6-14,67-88,136-154` |
| Microcompact | Оставляет 5 последних tool results, порог 0.9 окна и 2000 буфера, min savings 256, idle 60 мин | `compact/microcompact.ts:12-29` |
| Rapid refill breaker | 3 compact подряд при < 3 tool turns между ними → `ModelContextExceeded` | `turn-loop-state.ts:27-28,212-226` |
| Steer input | 200 000 байт | `runtime/helpers/steering.ts:11` |
| Root run deadline | По умолчанию отсутствует (`undefined`) | `runtime-task/registry.ts:1434`; `docs/specs/root-run-budget-removed.md:26-28` |
| Cost cap | **Отсутствует**: нет поля лимита; `cost` в step-finish жёстко `0` | `runtime/methods/turn-stop.ts:86,137`; `runtime/methods/message-persistence.ts:337` |

**Inferred (не наблюдено в рантайме).** Худший случай физических provider-запросов на один model step складывается: до 11 попыток adapter-retry × до 10 перезапусков core stream recovery. Это верхняя граница по константам, а не измеренное поведение; часть путей взаимоисключающая (recovery запускается после исчерпания adapter-бюджета).

### 3.5 Session/runtime и admission

**Две очереди, два владельца.**
- **Protocol-level `CommandInbox`** (`bootstrap/src/zcode-protocol-v4/command-inbox.ts:110-150+`, 509 строк): три класса фактов — in-flight pin, live input, settled LRU 512/session (`:1-2`); FIFO-гейты key→session (`:88-108,142-150`); идемпотентность по `commandId`; порядок durable fallback `transcript → timeline → child → discarded` (`:37-42`).
- **Core-level `runtimeCommandQueue`** (`runtime/command-queue.ts:10-130`): режимы `prompt | target-continuation | target-continuation-loop | task-notification | subagent-message | control-only-turn`, приоритеты `now | next | later`; `dequeueNextBatch` склеивает только task-notification одного priority и off-peak execution (`:185-211`).
- **Drain**: единственный активный drain (`runtimeCommandDrainActive`), последовательный `runRuntimeCommand`; task-notifications батчатся — `runtime/methods/runtime-command-queue.ts:50-89,337-415`.
- **Busy-предикат**: `hasActiveOrQueuedTurnWork` = lease | foreground | drainActive | queue pending | activeTurn | reservation — `:119-128`.

**Busy/running input.** `admitPrompt` (`prompt-admission.ts:21-160`): `requireQueue` → всегда очередь; busy + `requireIdle`/`modelExecution` → reject; иначе steer при `steerable` и отсутствии attachments (`:62-85`), иначе enqueue (`:87-101`). Steer отклоняется по `empty_input`, `input_too_large`, `no_active_turn`, `expected_turn_mismatch`, `turn_not_steerable` — `runtime/methods/steering.ts:73-120`. Guide дренится только на безопасных границах: один guide на завершённый tool batch (`turn-tools.ts:290`), либо на text-only границе (`turn-stop.ts:195-200`); иначе guide возвращается в queue с reason `guide.noToolBoundary` — `steering.ts:510-540`.

**Cancellation.** `enqueueCancellableRuntimeCommand` умеет убрать ещё не запущенную команду и пометить cancel-pending для узкого окна «уже dequeued, но не исполнена» — `runtime-command-submit.ts:49-59`. `stopActiveForegroundExecution` поддерживает `expectedForegroundExecutionId` и `preserveQueueAutoDrainOnCancel` — `runtime-command-queue.ts:467-493`. Отмена turn: `TurnComplete(cancelled)`, а не `TurnError` — `turn-errors.ts:266-292`; тест `runtime-cancel.test.ts:17`.

**Stale guards.** `isStaleBranchRuntimeCommand` / `isStaleBranchRuntimeTaskEvent` сравнивают `branchGeneration` и отбрасывают команды/события; применяется и при enqueue, и перед исполнением/персистенцией — `runtime/methods/runtime-command-generation.ts:6-67`; вызов на execution — `runtime-command-queue.ts:214`.

**Resume.** `resumeFromStore` (`runtime/methods/resume.ts:71-376`): soft-deleted session → `SessionNotFound` (`:87-96`); path repair (`:97-115`); `branchGeneration` из `session.revert` (`:126-130`); PRISM projection restore (`:132`); swarm journal recovery (`:133-139`); read-state hydration до context init (`:179-188`); основной hydration (`:192-201`); восстановление mode из authoritative events и session entry (`:238-266`); permission grant marker (`:271`); cache-hit aggregate (`:273-276`); **discard persisted pending steer inputs** (`:286-287`, реализация `steering.ts:1373-1404`, sweep admitted → `discarded/session_resumed`).

**Checkpointing.** Checkpoints — только файловые: `emitFileMutationCheckpoint` пишет artifact + `CheckpointCreated` с `scope: Workspace` и диффом (`runtime/methods/tools.ts:171-236`). Состояния самого цикла (номер step, pending tool batch, очередь) не чекпойнтятся. При холодном resume незавершённые tool parts превращаются в синтетический failed result `[Tool execution was interrupted before resume]` — `agent/session-history-hydrator.ts:49,228-240`.

**Ownership/lease.** `beginForegroundExecution` создаёт AbortController на команду и публикует `foregroundExecutionId` — `runtime-command-queue.ts:417-444`; `foregroundPromotionLease` (promote queued → now) — `:130-170`.

### 3.6 Streaming

- **Event queue**: `ModelStreaming` append сериализован в цепочку промисов, high-water 128 pending writes, `maybeApplyBackpressure()` ждёт только при превышении — `model-streaming-event-queue.ts:4-73`. Явный `drain()` на границах `finish/error/tool_call` — `model.ts:206-217`.
- **Поток модели**: `for await` по `model.streamText`, проверка abort на каждом кадре, события `start`, text/reasoning/tool-input delta, tool-input fallback flush каждые 4096 символов или по переводу строки — `model.ts:261-280`, `:31-33,244-259`.
- **Поток инструментов**: read-only+concurrentSafe+`sideEffectScope: none` tool может исполняться во время стрима, только при `modelStreaming === "on"` и `streamingToolExecution !== "off"` — `streaming-tool-coordinator.ts:387-410`. Side-effecting tools всегда ждут конца стрима — тест `runtime-tool-loop.test.ts:11934`.
- **Отмена стрима**: `abandon(reason)` помечает ledger `tool_cancelled`/`tool_abandoned` и ждёт handles не дольше 250 ms — `streaming-tool-coordinator.ts:42,155-174`.
- **Порядок**: ledger updates идут через `emitStreamingToolLedgerUpdate` (closed → queued → started), а `settleToolResults` пишет финальные части; для turn-control stop предусмотрен `persistToolModelStepFinish` до `break` — `turn-tools.ts:115-120,140-154,241-286`.
- **UI/CLI rendering**: TUI подписан на session events; отдельный `tui-session-event-relay.ts` в CLI; 29 test-файлов TUI (`packages/tui/tests/*`). Детальный рендеринг вне Z07 и не проверялся.

### 3.7 Context window и token accounting

- **Assembly**: `ContextBuilder.build()` собирает стабильные секции (CLI prefix, identity/custom prompt, env/git, skills, memory, desktop, dynamic behavior, output style, guidance) — `context/builder.ts:83-120+`; `cacheHint` помечает stable/dynamic (`:66-78`). Инструменты в system prompt больше не дублируются — `:48-53`.
- **Перестроение префикса** при смене модели/refresh — `runtime/methods/context-refresh.ts:7` (`rebuildContextPrefix`), вызов в `turn.ts:432-440` и в guide drain при смене модели (`turn-guide-drain.ts:36-50`).
- **Truncation/compaction**: microcompact (локальная зачистка старых tool results) → autocompact (summary через отдельный model request) → reactive compact (после реального context overflow) → rapid-refill breaker. `compactActiveConversation` вызывается из loop до каждого model step — `turn-loop.ts:153-190`; реализация `compact.ts:184-300`; policy `compact/policy.ts`; summary prompt и лимиты (`MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`, `MAX_COMPACT_PROMPT_TOO_LONG_RETRIES = 3`) — `compact/policy.ts:11`, `compact/manual.ts:56-60`.
- **Prompt caching**: `applyCacheControl: true` для обычных запросов (`turn-loop.ts:290`); ставится ровно один `cache_control: {type:"ephemeral"}` на последнее non-system сообщение, с переносом breakpoint при `skipCacheWrite` — `runtime/helpers/provider-request-messages.ts:326-348`; существующие cache_control очищаются перед установкой (`:360-367`).
- **Token accounting**: usage-события пишутся в usage store с provider id/model/reasoning level/mode/taskType, token-полями и TTFT — `usage-observability.ts:56-110`; отдельный per-turn aggregate, cache-hit aggregate — `turn-model-step-usage.ts:25-59,73-112`; `state.tokenCount` и `state.toolCallCount` в `TurnComplete` — `turn.ts:979-1001`.

### 3.8 Тестовая карта

**Observed инвентарь (число файлов `*.test.ts`, исключая `node_modules`).**

| Пакет | Файлов | Профиль |
| --- | --- | --- |
| core | 306 | Turn machine/loop, permission, executor, compact, resume, subagent, tool-search, workflow |
| adapters | 164 | retry/backoff, failure classifier, stream idle, opencode, storage, fs/exec |
| bootstrap | 237 | protocol-v3/v4, CommandInbox, projection, hydration, admission, workflow driver |
| cli | 28 (node:test + vitest mix) | args, TUI wiring, headless workflow, build/sea, provider env |
| tui | 29 (node:test) | approval panel, submit, queue, events, markdown |
| contracts | 44 | schemas, reducers, ports |

**Покрытые control-flow пути (по именам тестов и чтению assertions).**

- Turn machine переходы и model-tool-model цикл — `core/tests/turn-machine.test.ts:15-99`.
- Max turns: граница, durable маркер, пустой length step, tool-only steps, отмена на границе, subagent inheritance — `core/tests/max-turns-limit.test.ts` (19 тестов; список имён `:128-846`), включая cold hydration через `ProductProjection` (`:74-90`).
- Admission/reservation/FIFO/steer — `prompt-admission.test.ts:44-241`, `runtime-command-queue.test.ts`, `runtime-queue-auto-drain.test.ts:8-40`.
- Approvals: 104 теста `guarded-approval.test.ts` (включая «preview proceed не обходит user-once» `:239`, timeout `:516`, hook rewrite `:360-442`), 64 `permission-service.test.ts`, 16 `permission-responder-race.test.ts`.
- Cancellation — `runtime-cancel.test.ts:17-107`; stale branch — косвенно через bootstrap-тесты admission; отдельного теста на `isStaleBranchRuntimeCommand` не найдено.
- Stream recovery: 10 попыток, synthetic failed result для side-effecting tool, Start Plan exhaustion — `runtime-tool-loop.test.ts:12852,13098`; reasoning-only recovery — `runtime-stream-recovery.test.ts:51`.
- Output-token continuation: 4-й лимит закрывается TurnError, persisted/hydrated carrier, control-flow границы — `runtime-output-token-continuation*.test.ts` (5 файлов).
- Compact: auto/micro/reactive, PTL retry, circuit breaker, rapid refill — `runtime-compact.test.ts` (в т.ч. `:5369-5376`), `microcompact.test.ts` (11 тестов), e2e `e2e/compact-microcompact` (не запускался).
- Provider retry/classification — `adapters/tests/retry-budget.test.ts`, `failure-classifier.test.ts`, `runner-retry-after-policy.test.ts`.
- CommandInbox: ACK/CAS/идемпотентность/LRU/pinned/single-flight/FIFO — `bootstrap/tests/command-inbox.test.ts:32-626+`.

**Не покрытые или покрытые только косвенно пути.**

- `streaming-tool-coordinator` как отдельный модуль: нет файла `*streaming-tool-coordinator*` (поиск по `packages/core/tests` дал 0). Поведение проверяется через `runtime-tool-loop.test.ts`, `runtime-streaming-tool-part-identity.test.ts`, `tool-result-settlement/contract.test.ts`.
- `isStaleBranchRuntimeCommand`/`isStaleBranchRuntimeTaskEvent` — прямых тестов нет.
- `TurnMachineImpl.fail`, `getNextPhase`, `isComplete` — не вызываются и не тестируются (см. §4).
- `permissionTimeoutMs` — тестируется только через явную инъекцию в `guarded-approval.test.ts:98`; продуктовая проводка отсутствует.
- `maxTurns` для главного turn — не проверяется, поскольку surface отсутствует.
- `auto` режим — тестов на режим нет, потому что он всегда deny.
- Реальный provider E2E цикл (сеть, ключ) — только e2e-скрипты, не прогонялись.

## 4. Gaps, risks, weaknesses

Каждый пункт — с доказательством. Уровень: **подтверждено** (код/тест прочитан) или **гипотеза**.

### 4.1 Подтверждённые пробелы

**G1. Главный turn не имеет ни дефолтного, ни пользовательского `maxTurns` — цикл потенциально неограничен.**
- `AgentRuntimeConfig.maxTurns?: number` существует (`runtime/types.ts:144`), но `resolveMaxTurnsLimit` возвращает `undefined` при отсутствии значения (`turn-loop.ts:49-55`).
- CLI не объявляет флаг: в `packages/cli/src/arguments.ts:3-110` нет `max-turns` (есть только `mode`, `prompt`, `resume`, `target`, `workflow-mode` и т.д.).
- Bootstrap не выставляет `maxTurns` при сборке runtime: `bootstrap/src/app/runtime-config.ts:125-204` не содержит поля; единственный продовый `maxTurns:` — для workflow child (`bootstrap/src/app/script-workflow-child-runtime.ts:144`) и для subagent (`core/src/runtime/methods/subagent.ts:494-530`).
- UI выставляет `maxTurns` только для subagent-профиля (`packages/ui/src/settings/SubagentsSection.tsx:1053`).
- Спека прямо декларирует «нет значения — нет лимита» (`docs/specs/max-turns-limit.md:26-27`) и «runaway покрывается явным maxTurns» (`docs/specs/root-run-budget-removed.md:19-24`). Итог: для обычного интерактивного turn защиты по числу шагов нет.
- Сопутствующее: `AGENTS.md` (вложенный) требует «не использовать tool call count как hard stop», поэтому отсутствие лимита — осознанное решение, но пользовательского рычага для его включения нет.

**G2. Нет cost cap и фактически нет cost accounting.**
- Поиск `costUsd|totalCost|cost_usd|maxCost|budget` по `core/adapters/contracts` не нашёл полей лимита; `budget` встречается только как `resultBudget`/root-run budget.
- `cost` в step-finish частях жёстко `0`: `runtime/methods/turn-stop.ts:86,137`, `runtime/methods/message-persistence.ts:337`, `runtime/methods/turn-step-finish.ts:29`, `runtime/methods/timeline-persistence.ts:130`, `runtime/methods/session-fork.ts:475`.
- Usage store хранит токены и тайминги (`usage-observability.ts:56-110`), но не денежную стоимость.
- Следствие: нельзя ни ограничить, ни показать пользователю стоимость turn; единственный «бюджет» — контекст и явный `maxTurns`.

**G3. `permissionTimeoutMs` не проводён в проде → approval может ждать бесконечно (core-путь).**
- Поле существует (`runtime/types.ts:149`), читается и передаётся (`runtime/helpers/runtime-tools.ts:242` → `tool/executor/impl.ts:44` → `permission-request.ts:73`), но таймаут в `ManualPermissionBroker` включается только при `options.timeoutMs !== undefined` (`permission/broker.ts:108-126`).
- Присваивания `permissionTimeoutMs` в bootstrap/CLI/TUI не найдено (поиск дал только тесты `core/tests/guarded-approval.test.ts:98`).
- Protocol-путь имеет собственный механизм `timedOut` (`bootstrap/src/zcode-protocol/interaction-broker.ts:79-92`; `server.ts:1139-1151`), но вызовов с `timeoutMs` в `server.ts` не найдено (grep по `timeoutMs:` дал только саму реализацию `:1147`).
- Итог: в TUI/headless пользователь/процесс не получает автоматического `PermissionTimeout`; реальный таймаут зависит от внешнего клиента или Stop.
- Смягчение: TUI Esc → deny, Stop отменяет turn, а headless fail-closed (`headless-workflow.ts:31-51`).

**G4. Режим `auto` объявлен, но всегда запрещает.**
- `CollaborationMode` включает `"auto"` (`contracts/src/interfaces/session.port.ts`).
- `checkPermission` для `auto` возвращает deny «reserved but not implemented yet» (`permission/service.ts:173-180`); `checkAlwaysAsk` — то же (`:399-406`).
- CLI отвергает `--mode auto` (`packages/cli/src/run.ts:143-157`), т.е. значение достижимо только через конфиг/session state и приводит к отказу всех tool с этим mode.
- Риск: пользователь, выставивший `permission.mode = "auto"` в config (`contracts/src/config/index.ts:17`), получит полностью неработающий агент без явной валидации при старте.

**G5. `yolo`/`guarded` обходят `disallowedTools` — известное, но опасное упорядочение.**
- Ветка `(mode === "yolo" || mode === "guarded") && !planEnabled` → `allow` стоит **раньше** проверки `disallowedTools` (`permission/service.ts:169-189`).
- Комментарий в коде прямо признаёт это: «особенно yolo 目前先于 disallowedTools 放行这一点» (`permission/service.ts:391`).
- `alwaysAsk`-ветка защищена отдельно (`checkAlwaysAsk` сначала проверяет hard-deny, `:407-422`), но обычные tool — нет.
- Риск: `disallowedTools` не является жёстким запретом для side-effecting tool в yolo/guarded; обещание «disallowed» в конфиге не соответствует поведению.

**G6. Нет mid-turn resume: прерывание теряет незавершённую работу.**
- Незавершённые tool parts синтезируются как failed с текстом `[Tool execution was interrupted before resume]` (`agent/session-history-hydrator.ts:49,228-240`); `interruptedToolCount` уходит в `SessionResumed` (`resume.ts:292-306`).
- Persisted pending steer inputs **отбрасываются** при resume: sweep admitted → `discarded/session_resumed` (`steering.ts:1373-1394`), вызов `resume.ts:286-287`, `recoveredSteerInputCount = 0`.
- Чекпойнты покрывают только файловые мутации (`runtime/methods/tools.ts:171-236`), не состояние цикла.
- Итог: resume = «восстановить историю и ждать нового ввода», а не «продолжить turn». Это согласовано с тестами `runtime-tool-loop.test.ts:11292` («discards queued-but-not-drained steering input during resume») и `resume.ts:140-151` (warn при нуле сообщений), но означает потерю пользовательских сообщений, отправленных в момент падения.

**G7. Мёртвый/недостижимый код в контрактах цикла (риск ложной уверенности).**
- `TurnMachineImpl.fail()` объявлен и реализован (`agent/turn-machine.ts:63,299-306`), но нигде не вызывается в `core/src` (grep: 0 вызовов).
- `getNextPhase()` (`:64,308-339`) — ни одного вызова.
- `isComplete()` (`:65,341-343`) — ни одного вызова.
- `PermissionService.requiresApproval()` (`permission/service.ts:602-605`) — ни одного вызова.
- `TurnResultType` содержит `error_max_budget` и `error_max_tool_calls` (`agent/turn-state.ts:156,158`), но в `core/src` никто их не публикует (grep: только объявление); `error_during_execution` публикуется только cold-hydration (`bootstrap/.../transcript-hydration.ts:1263`).
- `PermissionConfig.allowMediumRiskInAutoMode` объявлен и присваивается (`permission/service.ts:749,756`; `bootstrap/src/app/create-app.ts:394`), но в решениях не читается (grep: только объявление/дефолт/присваивание).
- Риск: тесты/документация могут ссылаться на несуществующее поведение; `TurnResultType` выглядит богаче фактического контракта.

**G8. Защита от «бесконечного» цикла ограничена предупреждениями, а не остановом.**
- Anomaly guard только инжектит reminder и событие `ModelAnomalyWarning`: повторные вызовы (`runtime/helpers/model-anomaly.ts:23-62`) и tool-call budget (`:64-91`), применение — `runtime/methods/turn-tool-warnings.ts:14-82`. Остановки нет.
- Единственный жёсткий предел шагов — явный `maxTurns` (`turn-loop.ts:122-125`), который в проде не выставлен (G1).
- `MAX_STOP_HOOK_CONTINUATIONS = 3` (`hooks.ts:10`) и `MAX_OUTPUT_TOKEN_CONTINUATIONS = 3` (`turn-output-token-continuation.ts:18`) ограничивают только собственные расширения, не число tool-шагов.

**G9. Каскад retry может дать очень большое число физических запросов (Inferred).**
- Adapter: до 11 attempts на один вызов (`retry-policy.ts:13-16,42-49`).
- Core stream recovery: до 10 перезапусков `runModelTextRequest` (`streaming-recovery.ts:14`), каждый со своим adapter-бюджетом.
- Итоговая верхняя граница по константам — до 110 запросов на один model step; измерением не подтверждено, часть путей исключает друг друга.
- Валидация конфига отсутствует: `normalizePositiveInteger`/`parseNonNegativeInteger` принимают любые большие значения (`retry-policy.ts:87-120`).

**G10. `guarded` dangerous-command matcher — эвристика с явно задокументированными слепыми зонами.**
- Плана и реализация: `docs/dangerous-command-approval-v1-plan.md` (разделы про batch-delete, Robocopy, PowerShell/brace/переменные/скрипты).
- Документ прямо перечисляет исключения: PowerShell, brace/переменные/command substitution, скрипты, implicit config, rimraf/shred/truncate, remote delete, Git partial rollback; wrapper только `env/time/sudo`; `xargs/find-exec/npx` не расширяются; `robocopy src dst *.txt /MIR` может вернуть `unsupported` и уйти по YOLO-базе.
- Риск: `guarded` не является полным sandbox; `unsupported` не означает «безопасно» (это сказано в документе), но пользователю это не видно.

**G11. Тестовая эргономика: сверхкрупные файлы.**
- `core/tests/runtime-tool-loop.test.ts` — 16 893 строки, 184 `it(...)`; следующий по размеру `runtime-compact.test.ts`.
- Риск: медленная обратная связь, конфликтующие правки, трудно локализовать регресс. Правило `AGENTS.md` ограничивает 800 строк на source-файл, но не на тесты.

**G12. Стриминговые tool calls покрыты только интеграционно.**
- Нет выделенного теста `streaming-tool-coordinator`; таймауты 250 ms (`streaming-tool-coordinator.ts:42`), поведение `abandon` и классификация `unknown_execution_state` проверяются только через крупные integration-сценарии.
- Риск: регресс в `collectCompletedResults`/`drain` может проявиться только в редком сценарии обрыва посреди side-effecting batch.

### 4.2 Гипотезы

**H1.** Отсутствие `permissionTimeoutMs` в проде маскируется тем, что desktop всегда отвечает, а TUI имеет Esc; в headless всё fail-closed. Проверка: собрать gateway с клиентом, который не отвечает на permission request, и замерить, доходит ли до `PermissionTimeout` (потребует отдельного harness).
**H2.** Порядок `yolo` → `disallowedTools` не эксплуатируется на практике, потому что `disallowedTools` задаётся редко. Проверка: продуктовый аудит конфигов + добавить тест на yolo+disallowed и решить ожидаемую семантику.
**H3.** Верхняя граница «110 запросов» недостижима из-за взаимоисключающих путей, но близкие значения (десятки) реальны при нестабильной сети. Проверка: fault-injection E2E с провайдером, рвущим стрим на каждом attempt.

## 5. Strengths and differentiators

**S1. Единственный владелец цикла и явная граница maxTurns.** `runRegularTurnLoop` — единственное место, где решается «ещё один model step», с проверкой строго на границе (`turn-loop.ts:110-125`). Спека `docs/specs/max-turns-limit.md` фиксирует контракт, включая durable маркер и холодное восстановление; 19 тестов покрывают граничные случаи, включая отмену на границе и пустой length-step. Это редкий уровень формализации для «лимита ходов».

**S2. Durable-маркер ограниченного turn.** `error_max_turns` пишется в transcript как `metadata.turnResult`, а не как `assistant.error`, чтобы не потерять текст и не исключить шаг из compact-preserved segment (`docs/specs/max-turns-limit.md:35-51`; `message-persistence.ts:397-415`; чтение маркера — `transcript-hydration.ts:282-290`). Холодный путь не превращает ограниченный turn в success.

**S3. Многоуровневое восстановление с явным порядком.** Adapter retry → selection fallback → core stream recovery → reactive compact → terminal error. Порядок мотивирован в комментариях (`turn-model-step.ts:288-331`), а не импровизирован; fallback не срабатывает на cancel/context-exceeded/OpenCode 429 (`turn-execution-fallback.ts:114-128`).

**S4. Fail-closed approval по умолчанию.** `DenyPermissionBroker` — дефолт (`agent-runtime.ts:332-333`); headless deny-всё-кроме-двух-workflow (`headless-workflow.ts:31-51`); preview-hook не может превратить ask в allow (`approval-gate.ts:61-74`); `user-once` не может персистить правила (`permission-response.ts:92-111`); session-grant живёт только в памяти (`permission-rules-persistence.ts:112-126`).

**S5. Разделение синхронной политики и асинхронного согласования.** `PermissionService` (allow/ask/deny) и `PermissionBroker` (wait/modify/deny/escalate) — разные владельцы (`apps/zcode-cli/docs/design/v2/permission-broker.md`), что позволяет тестировать политику без клиента (64 теста) и согласование без модели (104 теста guarded).

**S6. Явная семантика guide/queue.** Guide дренится только на безопасной границе, не вставляется между `assistant tool_use` и `tool_result`; при невозможности возвращается в очередь с reason-кодом (`turn-tools.ts:290`, `turn-stop.ts:195-200`, `steering.ts:510-540`). Это закрывает типичный класс ошибок «user message внутри tool-пары».

**S7. Stale-generation защита для фоновых результатов.** `branchGeneration` проверяется и при enqueue, и перед исполнением/персистенцией (`runtime-command-generation.ts:6-67`), что предотвращает воскрешение результатов после rewind.

**S8. Богатая наблюдаемость.** Каждый шаг пишет lifecycle-события с trace/span/querySource (`turn.ts:246-273,495-501`, `turn-model-step.ts:203-217,680-704`), usage-факты с TTFT и cache-токенами (`usage-observability.ts:56-110`), а ошибки несут provider business code и attribution (`turn-errors.ts:296-313`). `DEBUG`-события отделены от production-событий (`events.ts:60-72`).

**S9. Детерминированный порядок streaming-записи с backpressure.** Сериализация append в цепочку промисов + high-water 128 (`model-streaming-event-queue.ts:4-73`) сохраняет порядок токенов, не блокируя чтение SSE.

**S10. Явные границы tool-безопасности.** Scheduler учитывает readOnly/destructive/concurrentSafe/sideEffectScope (`tool/scheduler.ts:85-103`); streaming-исполнение разрешено только для readOnly+concurrentSafe+`sideEffectScope: none` (`streaming-tool-coordinator.ts:402-409`); tool-result budget ограничивает контекст 100 KB (`result-serialization.ts:34-41`).

**S11. Размер и характер тестового набора.** 306 test-файлов в core; тесты читают реальные события/projection, а не только моки (например, `max-turns-limit.test.ts:74-90` строит `ProductProjection` из синтезированных событий). Это даёт проверку холодного пути, а не только live.

## 6. Candidate recommendations

Поля: problem/gap; ZCode evidence; proposed solution; scope/out-of-scope; expected effect; risks; complexity; priority; acceptance criteria; verification method.

### R1. Провести `permissionTimeoutMs` в продуктовую конфигурацию и UI/протокол

- **Problem/gap:** G3 — approval в core-пути может ждать бесконечно, потому что `permissionTimeoutMs` нигде не присваивается.
- **ZCode evidence:** `runtime/types.ts:149`; `runtime/helpers/runtime-tools.ts:242`; `tool/executor/impl.ts:44`; `permission/broker.ts:108-126`; `tool/executor/permission-request.ts:73`; отсутствие присваиваний подтверждено `rg -n "permissionTimeoutMs"` (только тесты).
- **Proposed solution:** добавить поле в `RuntimeConfig.permission` (или session setting) с дефолтом (например, 5 минут) и явным «0 = без таймаута»; прокинуть в `AgentRuntimeConfig.permissionTimeoutMs` при сборке runtime; для protocol-пути — передавать тот же бюджет в `requestPermission(..., { timeoutMs })`.
- **Scope:** contracts/config, bootstrap runtime-config, core wiring, локализация ошибки `PermissionTimeout`.
- **Out-of-scope:** изменение семантики `guarded` `user-once`; новые режимы.
- **Expected effect:** предсказуемое завершение зависших approval; `PermissionTimeout` становится наблюдаемым в TUI/headless.
- **Risks:** слишком короткий таймаут ломает медленные ручные подтверждения; нужно согласовать дефолт и поведение при `guarded` (ошибка инфраструктуры vs отказ).
- **Complexity:** S.
- **Priority:** P1.
- **Acceptance criteria:** при отсутствии ответа клиента дольше лимита tool получает `CoreErrorType.PermissionTimeout`, `permission_resolved` публикуется один раз, rules не пишутся; при `0` поведение прежнее.
- **Verification method:** расширить `core/tests/guarded-approval.test.ts` (сейчас таймаут проверяется только при явной инъекции `:98,516`), добавить bootstrap-тест на проброс `timeoutMs` в `createProtocolInteractionBroker`.

### R2. Дать пользователю явный surface для `maxTurns` главного turn

- **Problem/gap:** G1 — защита от неограниченного цикла недоступна в проде.
- **ZCode evidence:** `arguments.ts:3-110` (нет флага); `runtime-config.ts:125-204` (нет поля); `runtime/types.ts:144`; `turn-loop.ts:116-125`; `docs/specs/max-turns-limit.md:24-30`.
- **Proposed solution:** добавить `--max-turns <n>` в CLI и поле в session/runtime settings, по умолчанию `undefined` (сохранить текущий контракт «нет значения — нет лимита»), с валидацией positive integer и явной ошибкой на невалидное значение.
- **Scope:** `packages/cli/src/arguments.ts`, `shared-types`, bootstrap runtime-config, i18n settings.
- **Out-of-scope:** изменение дефолта (не вводить неявный лимит — это противоречит `docs/specs/root-run-budget-removed.md:19-24`).
- **Expected effect:** пользователь/автоматизация может ограничить runaway turn, не теряя текущую семантику по умолчанию.
- **Risks:** соблазн выставить неявный дефолт; нужно не сломать subagent inheritance.
- **Complexity:** S.
- **Priority:** P1.
- **Acceptance criteria:** флаг/настройка доходят до `config.maxTurns`; при достижении публикуется `TurnComplete(error_max_turns)` и durable маркер; отсутствие значения = без лимита.
- **Verification method:** `max-turns-limit.test.ts` + новый CLI contract-тест (`packages/cli/tests/argument-parsing/contract.test.ts`); e2e с малым лимитом на scripted provider.

### R3. Ввести явный «budget/limit» для стоимости или честно удалить `cost` из контракта

- **Problem/gap:** G2 — нет cost cap, `cost` всегда 0.
- **ZCode evidence:** `turn-stop.ts:86,137`; `message-persistence.ts:337`; `turn-step-finish.ts:29`; отсутствие `costUsd/maxCost` полей (rg по core/adapters/contracts).
- **Proposed solution (вариант A):** добавить `maxCostUsd` на turn/session и считать стоимость по прайсу провайдера в usage store; при превышении — терминальный статус с отдельным `TurnResultType` (например, `error_max_cost`) и UI-сообщением. **(вариант B, минимальный):** если cost не планируется, убрать/задокументировать `cost: 0` как «не используется», чтобы не создавать ложное впечатление учёта.
- **Scope:** contracts usage, core usage accounting, settings/UI, protocol payload.
- **Out-of-scope:** биллинг и квоты провайдера.
- **Expected effect:** либо реальный контроль расходов, либо устранение ложного поля.
- **Risks:** прайс-листы меняются; кэш-токены считаются иначе; неверная оценка хуже отсутствия лимита.
- **Complexity:** L (вариант A) / S (вариант B).
- **Priority:** P2.
- **Acceptance criteria (A):** превышение бюджета даёт детерминированный терминальный статус, usage сохраняется, повторный turn не стартует автоматически. (B): поле `cost` удалено или помечено deprecated с тестом, что оно не влияет на UI.
- **Verification method:** unit на калькулятор стоимости с cache read/write; интеграционный тест с scripted provider и фиксированным usage.

### R4. Решить судьбу режима `auto`

- **Problem/gap:** G4 — `auto` достижим, но всегда deny.
- **ZCode evidence:** `contracts/src/interfaces/session.port.ts` (тип); `permission/service.ts:173-180,399-406`; `contracts/src/config/index.ts:17`.
- **Proposed solution:** либо реализовать (правила «allow medium risk» уже есть как неиспользуемое поле `allowMediumRiskInAutoMode`, `permission/service.ts:749`), либо удалить `auto` из `CollaborationMode` и отклонять конфиг на старте с внятной ошибкой.
- **Scope:** contracts, permission service, config validation, i18n/UI.
- **Out-of-scope:** новые риск-политики.
- **Expected effect:** нет «тихо нерабочего» режима.
- **Risks:** удаление типа — ломающее изменение для сохранённых настроек; нужна миграция/нормализация.
- **Complexity:** M (реализация) / S (удаление с валидацией).
- **Priority:** P2.
- **Acceptance criteria:** при `mode: "auto"` либо предсказуемая политика с тестами, либо явная ошибка конфигурации при старте и миграция значения.
- **Verification method:** `permission-service.test.ts` + config-load тест в bootstrap.

### R5. Сделать `disallowedTools` жёстким запретом независимо от `yolo`/`guarded`

- **Problem/gap:** G5 — «disallowed» обходится в yolo/guarded.
- **ZCode evidence:** `permission/service.ts:169-189`; признание в комментарии `:391`.
- **Proposed solution:** перенести проверку `isToolDisallowed` (и project `deny`) **выше** ветки `mode.yolo`; либо явно переименовать конфиг в `preapprovedOnly` и зафиксировать семантику в docs.
- **Scope:** `permission/service.ts`, docs `apps/zcode-cli/docs/design/v2/permission-broker.md`, тесты.
- **Out-of-scope:** изменение `guarded` `user-once`.
- **Expected effect:** конфиг соответствует названию; hard-deny нельзя обойти сменой режима.
- **Risks:** существующие пользователи могут полагаться на текущее поведение; нужен changelog.
- **Complexity:** S.
- **Priority:** P1.
- **Acceptance criteria:** при `yolo`+`disallowedTools: ["Bash"]` вызов Bash получает deny с `rule.disallowedTools`; при `guarded` — то же; `alwaysAsk`-путь не регрессирует.
- **Verification method:** новые кейсы в `permission-service.test.ts` и `guarded-approval.test.ts` (сейчас тесты проверяют YOLO-обход только для dangerous-command, `:551`).

### R6. Удалить или использовать мёртвые контракты цикла

- **Problem/gap:** G7 — `fail`, `getNextPhase`, `isComplete`, `requiresApproval`, `error_max_budget`, `error_max_tool_calls`, `allowMediumRiskInAutoMode`.
- **ZCode evidence:** `agent/turn-machine.ts:63-65,299-343`; `permission/service.ts:602-605,749`; `agent/turn-state.ts:156,158`; grep-подтверждение нулевых вызовов.
- **Proposed solution:** либо удалить вместе с типами, либо подключить (например, использовать `fail()` при не-восстановимой ошибке внутри loop вместо проброса исключения; `requiresApproval` — в preflight-проверке tool batch).
- **Scope:** core agent/permission, contracts (если удаляется `TurnResultType`), docs `loop/interfaces.md`.
- **Out-of-scope:** изменение наблюдаемого поведения turn.
- **Expected effect:** контракт кода = фактическое поведение; меньше ложных ожиданий у тестов и интеграторов.
- **Risks:** `fail()` может потребовать согласования с `TurnError`-проекцией; удаление `TurnResultType` — wire-совместимость.
- **Complexity:** S.
- **Priority:** P2.
- **Acceptance criteria:** `knip`/grep не находят неиспользуемых публичных членов; все оставшиеся `TurnResultType` имеют продюсера и тест.
- **Verification method:** `pnpm knip` по `packages/core`; grep-проверка; существующие тесты остаются зелёными.

### R7. Выделить unit-тесты для `streaming-tool-coordinator`

- **Problem/gap:** G12 — критичный узел покрыт только интеграционно.
- **ZCode evidence:** `streaming-tool-coordinator.ts:42,64-186,196-250,387-410,426-440`; отсутствие `*streaming-tool-coordinator*` в `packages/core/tests`.
- **Proposed solution:** добавить `core/tests/streaming-tool-coordinator.test.ts` с fake runtime/registry: (a) accept только для readOnly+concurrentSafe+none; (b) `abandon` маркирует ledger и укладывается в 250 ms; (c) `collectCompletedResults` даёт `unknown_execution_state` при зависшем handle; (d) late update после synthetic не перетирает результат.
- **Scope:** только тесты.
- **Out-of-scope:** рефакторинг координатора.
- **Expected effect:** быстрая локализация регрессов в самом рискованном участке streaming.
- **Risks:** fake-окружение может разойтись с реальным runtime; держать тесты на публичном API координатора.
- **Complexity:** S.
- **Priority:** P1.
- **Acceptance criteria:** 4+ сценария, тесты выполняются < 2 s, не требуют сети.
- **Verification method:** `vitest run tests/streaming-tool-coordinator.test.ts`.

### R8. Разделить `runtime-tool-loop.test.ts`

- **Problem/gap:** G11 — 16 893 строки, 184 теста в одном файле.
- **ZCode evidence:** `wc -l` и `rg -c "it\("` по `core/tests/runtime-tool-loop.test.ts`.
- **Proposed solution:** разрезать по темам (swarm, targets, streaming/recovery, checkpoints/rewind, queue/steer, approvals) с общими helpers в `tests/helpers/`.
- **Scope:** только тесты; без изменения assertions.
- **Out-of-scope:** изменение production-кода.
- **Expected effect:** параллельный прогон, меньшие diff-конфликты, быстрый targeted loop.
- **Risks:** механическое разрезание может изменить порядок/изоляцию; нужен «no assertion change» diff-контроль.
- **Complexity:** M.
- **Priority:** P2.
- **Acceptance criteria:** суммарное число тестов не изменилось; все файлы < 2 000 строк; полный прогон core зелёный.
- **Verification method:** сравнение списка имён тестов до/после; `vitest run tests` в core.

### R9. Зафиксировать контракт «resume не продолжает turn» и не терять pending input молча

- **Problem/gap:** G6 — отброшенные pending steer inputs и failed-синтетика могут удивить пользователя.
- **ZCode evidence:** `steering.ts:1373-1394`; `resume.ts:286-287`; `session-history-hydrator.ts:49,228-240`.
- **Proposed solution:** (a) документировать в спеке session lifecycle, что resume не возобновляет turn; (b) UI-баннер «N неподтверждённых вводов отброшено при восстановлении» на основе `discarded` ledger; (c) опционально — сохранять последний незавершённый ввод как черновик composer.
- **Scope:** docs, projection/UI banner, ledger read.
- **Out-of-scope:** полноценный mid-turn checkpoint/resume.
- **Expected effect:** потеря ввода становится видимой, а не молчаливой.
- **Risks:** новые события/поля протокола; не показывать ложные баннеры при чистом resume.
- **Complexity:** M.
- **Priority:** P2.
- **Acceptance criteria:** после kill -9 во время turn с двумя steer-входами повторное открытие показывает баннер с количеством отброшенных; при обычном resume баннера нет.
- **Verification method:** bootstrap test с recording store + projection на `discarded` фактах; e2e на scripted provider.

### R10. Ограничить/валидировать каскад retry

- **Problem/gap:** G9 (Inferred) — потенциально десятки физических запросов на один step.
- **ZCode evidence:** `retry-policy.ts:13-16,42-49,87-120`; `streaming-recovery.ts:14`.
- **Proposed solution:** ввести общий per-step «request budget» (например, `maxPhysicalAttemptsPerStep`), учитываемый и adapter-retry, и core recovery; отклонять аномально большие env-значения при старте с warn.
- **Scope:** adapters retry, core streaming recovery, config validation.
- **Out-of-scope:** изменение backoff-кривой.
- **Expected effect:** предсказуемая верхняя граница нагрузки и времени «Working».
- **Risks:** слишком строгий бюджет ухудшит устойчивость на нестабильных сетях; нужен консервативный дефолт.
- **Complexity:** M.
- **Priority:** P2.
- **Acceptance criteria:** fault-injection тест: провайдер рвёт стрим на каждом attempt — число физических запросов не превышает заданный бюджет; терминальная ошибка содержит счётчик.
- **Verification method:** `runner-retry`-тест в adapters + `runtime-tool-loop` сценарий; метрика числа `model_request_started` событий.

## 7. Open questions and unverified

1. **Не проверено:** полный `pnpm test`, `pnpm test:unit`, `pnpm typecheck`, `pnpm lint` для `apps/zcode-cli`. Частичные прогоны — §8.2. Нельзя утверждать, что baseline зелёный.
2. **Не проверено:** реальный provider loop (сеть/ключ): `e2e/compact-microcompact`, `e2e/memory`, `e2e/file-tools-atomic-write`. README прямо требует API key и spend.
3. **Не проверено:** desktop E2E, mobile `web-remote-replayable`, `desktop-continuous`, real relay. Эти пути живут в `packages/services`, `packages/desktop`, `packages/ui` — вне Z07.
4. **Unknown:** фактический дефолт `permissionTimeoutMs` в собранном desktop-приложении. В коде присваивания не найдено; возможно, оно приходит из внешней конфигурации, которой нет в checkout. Требуется проверка в `packages/desktop`/`packages/services` или в runtime-логе.
5. **Unknown:** действительно ли `maxTurns` можно задать через session entry/protocol при создании сессии (я нашёл только `subagent`/workflow-child пути). Возможен путь через `runtimeConfig` от host, которого нет в этом checkout.
6. **Unknown (Inferred H1):** поведение approval без ответа клиента в реальном gateway — нужен harness с молчащим клиентом.
7. **Unknown:** семантика `dequeueNextBatch` при смешанных priority в одном батче — код склеивает только task-notification с совпадающим priority/offPeak; не проверял на реальных сценариях цельную картину throughput.
8. **Unknown:** как именно UI показывает `TurnError` с provider business code и attribution (локализация/баннер). В Z07 прочитан только путь публикации события (`turn-errors.ts`), не рендер.
9. **Unknown:** стоимость и latency `ContextBuilder.build()` на больших репозиториях; бенчмарков не запускал.
10. **Unknown:** покрытие `guarded`-matcher для Windows CMD/Git Bash/Robocopy в текущем checkout — документ содержит исторические прогоны, но самих скриптов/oracle я не исполнял.
11. **Частично:** `CodeIndex` работал в lexical-режиме (embedding unavailable). Часть фактов найдена структурным чтением; отсутствие символа по индексу не считается доказательством отсутствия — все «нет вызовов» проверены `rg` по исходникам.

## 8. Evidence appendix

### 8.1 Ключевые файлы и диапазоны

**Entrypoints и wiring**

- `apps/zcode-cli/package.json:1-59`
- `apps/zcode-cli/pnpm-workspace.yaml:1-3`
- `apps/zcode-cli/packages/cli/src/main.ts:15-110`
- `apps/zcode-cli/packages/cli/src/run.ts:49-60,143-157,252-303,305-330,566,584,643`
- `apps/zcode-cli/packages/cli/src/arguments.ts:3-110`
- `apps/zcode-cli/packages/cli/src/prompt-command.ts:70-90,251`
- `apps/zcode-cli/packages/cli/src/headless-workflow.ts:31-51`
- `apps/zcode-cli/packages/cli/src/command-center/modes.ts:4-13`

**Agent loop**

- `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:124-162,164-260,280-426,486-567,592-650,719-780,782-946,948-1077,1088-1196,1223-1259`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:49-108,110-347`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts:96-140,142-274,276-518,520-632,636-735,731-822,831-894`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-tools.ts:31-121,126-239,241-297`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-stop.ts:21-104,106-155,157-237`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop-state.ts:27-28,54-82,125-186,212-255`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-guide-drain.ts:13-66`
- `apps/zcode-cli/packages/core/src/agent/turn-machine.ts:41-66,92-343`
- `apps/zcode-cli/packages/core/src/agent/turn-state.ts:27-40,151-158,184-215,233-266`

**Approvals**

- `apps/zcode-cli/packages/core/src/permission/service.ts:89-115,117-291,293-380,382-452,454-518,520-600,602-625,651-678,741-757`
- `apps/zcode-cli/packages/core/src/permission/broker.ts:24-39,41-167`
- `apps/zcode-cli/packages/core/src/permission/plan-mode-policy.ts:20-43`
- `apps/zcode-cli/packages/core/src/tool/executor/approval-gate.ts:23-75`
- `apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts:44-333`
- `apps/zcode-cli/packages/core/src/tool/executor/permission-request.ts:21-138`
- `apps/zcode-cli/packages/core/src/tool/executor/permission-response.ts:24-111`
- `apps/zcode-cli/packages/core/src/tool/executor/permission-rules-persistence.ts:19-133`
- `apps/zcode-cli/packages/core/src/tool/executor/permission-rules.ts:3-46`
- `apps/zcode-cli/packages/core/src/tool/executor/permission-suggestions.ts:6-48`
- `apps/zcode-cli/packages/core/src/tool/executor/turn-control.ts:20-82`
- `apps/zcode-cli/packages/core/src/runtime/permission-full-access.ts:18-80`
- `apps/zcode-cli/packages/tui/src/app-permission.ts:13-111`
- `apps/zcode-cli/packages/tui/src/app-approval.ts:14-16,127-181,246`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts:58-102`
- `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:390-395`
- `apps/zcode-cli/packages/contracts/src/interfaces/permission.port.ts:35-113`
- `apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts` (`CollaborationMode`)

**Errors / retry / recovery**

- `apps/zcode-cli/packages/contracts/src/errors/index.ts:9-112`
- `apps/zcode-cli/packages/adapters/src/model/retry-policy.ts:13-120`
- `apps/zcode-cli/packages/adapters/src/model/retry-budget.ts:16-65`
- `apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts:1-55`
- `apps/zcode-cli/packages/adapters/src/model/first-token-watchdog.ts:1-78`
- `apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts:14-145,239-260,376-401`
- `apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-coordinator.ts:42-43,64-186,196-250,387-410,426-440`
- `apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-synthetic-result.ts:13-52`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-execution-fallback.ts:50-138`
- `apps/zcode-cli/packages/core/src/runtime/helpers/turn-errors.ts:239-324`
- `apps/zcode-cli/packages/core/src/runtime/helpers/model-errors.ts:27-65`
- `apps/zcode-cli/packages/core/src/runtime/helpers/model-anomaly.ts:23-109`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-tool-warnings.ts:14-82`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts:12-88`
- `apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts:10,120-129`

**Limits / tools**

- `apps/zcode-cli/packages/core/src/runtime/methods/model-token-limits.ts:5-81`
- `apps/zcode-cli/packages/core/src/tool/executor/impl.ts:29-101`
- `apps/zcode-cli/packages/core/src/tool/executor/timeout.ts:19-75,93-163,170-229`
- `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts:72-108,438-474,479-620,635-740,804`
- `apps/zcode-cli/packages/core/src/tool/executor/batch-runner.ts:24-55,57-161`
- `apps/zcode-cli/packages/core/src/tool/executor/result-serialization.ts:34-41,47-113`
- `apps/zcode-cli/packages/core/src/tool/scheduler.ts:43-58,60-103,105-152,154-202,233-245`
- `apps/zcode-cli/packages/core/src/tool/input-validation-model-content.ts:12-60`
- `apps/zcode-cli/packages/contracts/src/config/index.ts:17,249-261,287-301,302-308,350-381`

**Sessions / admission / resume**

- `apps/zcode-cli/packages/core/src/runtime/command-queue.ts:10-130,132-248`
- `apps/zcode-cli/packages/core/src/runtime/methods/prompt-admission.ts:16-160`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-submit.ts:11-75`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts:25-89,91-128,130-170,206-335,337-415,417-493`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-generation.ts:6-67`
- `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts:63-140,328-381,510-540,1373-1404`
- `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts:71-151,152-235,236-340,356-376`
- `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts:49,58-76,228-245`
- `apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoints.ts:42-166`
- `apps/zcode-cli/packages/core/src/runtime/methods/tools.ts:38-61,63-123,171-240`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts:1-150`
- `apps/zcode-cli/packages/core/src/runtime-task/registry.ts:1369-1397,1434,1539-1570`

**Streaming / context / usage**

- `apps/zcode-cli/packages/core/src/runtime/methods/model.ts:180-280`
- `apps/zcode-cli/packages/core/src/runtime/methods/model-streaming-event-queue.ts:4-73`
- `apps/zcode-cli/packages/core/src/runtime/methods/model-streaming-event.ts:5-14`
- `apps/zcode-cli/packages/core/src/runtime/methods/events.ts:48-90,410,1537`
- `apps/zcode-cli/packages/core/src/context/builder.ts:36-120`
- `apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts:7`
- `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts:45-145,184-300`
- `apps/zcode-cli/packages/core/src/compact/policy.ts:1-160`
- `apps/zcode-cli/packages/core/src/compact/manual.ts:36-100`
- `apps/zcode-cli/packages/core/src/compact/microcompact.ts:12-70`
- `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:320-367`
- `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.ts:18-77`
- `apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts:56-110`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step-usage.ts:25-59,73-112`

**Specs / docs**

- `docs/specs/max-turns-limit.md:1-80`
- `docs/specs/root-run-budget-removed.md:1-35`
- `apps/zcode-cli/docs/design/v2/loop/tool-calling-loop.md:1-70`
- `apps/zcode-cli/docs/design/v2/permission-broker.md:1-42`
- `docs/dangerous-command-approval-v1-plan.md:1-40`
- `docs/v4-refactor/18-resume-race-audit-plan.md:1-40`
- `apps/zcode-cli/e2e/compact-microcompact/README.md` (Local, case list)
- `apps/zcode-cli/AGENTS.md:1-40`

### 8.2 Выполненные проверки

Команды и результаты (Observed; запущены точечно, не полный suite):

1. `git status --short` / `git branch --show-current` / `git log -1 --oneline`
   → `?? docs/research/` / `dev` / `d10f0b69 Выпустить macOS Preview 3.17.102.`
2. `CodeIndex status`
   → `state: ready`, `partial: false`, generation 1453, 10007 files / 26791 chunks / 278154 symbols, 377669 edges; `Embedding search is unavailable; showing lexical results.`
3. `cd apps/zcode-cli/packages/core && ./node_modules/.bin/vitest run tests/max-turns-limit.test.ts`
   → `1 passed (1)`, `19 passed (19)`, duration 6.91 s.
4. То же: `tests/turn-machine.test.ts tests/permission-broker.test.ts tests/prompt-admission.test.ts tests/runtime-cancel.test.ts`
   → `4 passed (4)`, `20 passed (20)`, duration 7.15 s.
5. То же: `tests/guarded-approval.test.ts tests/permission-service.test.ts tests/permission-responder-race.test.ts tests/runtime-command-queue.test.ts tests/tool-deadline.test.ts`
   → `5 passed (5)`, `203 passed (203)`, duration 8.87 s (guarded-approval: 104 tests, permission-service: 64).
6. То же: `tests/runtime-model-anomaly.test.ts tests/tool-executor-error.test.ts tests/runtime-output-token-continuation-control-flow.test.ts`
   → `3 passed (3)`, `23 passed (23)`, duration 5.74 s.
7. `cd apps/zcode-cli/packages/adapters && ./node_modules/.bin/vitest run tests/retry-budget.test.ts tests/failure-classifier.test.ts tests/runner-retry-after-policy.test.ts`
   → `3 passed (3)`, `112 passed (112)`, duration 4.97 s (failure-classifier: 87).
8. Попытка `vitest run tests/model-retry-policy.test.ts` → `No test files found` (файла нет; фактический файл называется `retry-budget.test.ts`). Это подтверждает, что имя файла в плане поиска было неверным, а не что тестов нет.

**Итого наблюдаемо:** 7 test-файловых наборов, 357 тестов, все успешно. Это доказывает только точечные инварианты (граница maxTurns, переходы машины, admission/reservation, approve/deny/timeout, retry-классификация), но не общее состояние baseline.

**Не запускалось:** `pnpm test`, `pnpm test:unit`, `pnpm typecheck`, `pnpm lint`, `pnpm verify:pre-push`, `e2e/*`, desktop/mobile E2E, любые сборки (`build`, `build:sea`).

### 8.3 Соответствие заявленных контрактов и кода (сводка)

| Контракт (doc) | Реализация | Состояние |
| --- | --- | --- |
| `maxTurns` = только явный positive integer, иначе без лимита (`docs/specs/max-turns-limit.md:24-30`) | `turn-loop.ts:49-55,116-125` | совпадает |
| Ограниченный turn = `TurnComplete(error_max_turns)`, durable маркер, не `TurnError` (`:31-51`) | `turn-loop.ts:87-107`; `message-persistence.ts:397-415`; `transcript-hydration.ts:282-290` | совпадает |
| `permission.service` — синхронная политика; broker — async (`permission-broker.md:20-24`) | `permission/service.ts`; `permission/broker.ts` | совпадает |
| `Allow once` не пишет правила; `Always allow in this project` пишет project ruleset (`permission-broker.md:7-13`) | `permission-flow.ts:180-190`; `permission-rules-persistence.ts:29-76` | совпадает |
| Session-level grant хранится только в памяти (`permission.port.ts:82-87`) | `permission-rules-persistence.ts:112-126` | совпадает |
| Root run без wall-clock deadline по умолчанию (`root-run-budget-removed.md:26-28`) | `registry.ts:1434` | совпадает |
| Tool call count — не hard stop (`loop/tool-calling-loop.md:1-3`; `AGENTS.md`) | `model-anomaly.ts` только предупреждает | совпадает, но создаёт G1/G8 |
| `auto` mode — «reserved but not implemented» (`permission/service.ts:173-180`) | deny | совпадает с кодом, противоречит наличию значения в `CollaborationMode` (G4) |

### 8.4 Проверенные отсутствия (grep, не индекс)

- `turnMachine.fail(` / `.fail(createTurnError` в `packages/core/src` → 0 совпадений (объявление в `turn-machine.ts:299`).
- `getNextPhase(` → только объявление и реализация (`turn-machine.ts:64,308`) плюс doc `loop/interfaces.md:587`.
- `isComplete()` → 0 вызовов вне объявления.
- `requiresApproval(` → только объявление (`permission/service.ts:602`).
- `error_max_budget` / `error_max_tool_calls` → только объявления типа (`turn-state.ts:156,158`) и схема events (`contracts/src/events/session.events.ts:676-678`); продюсеров в core нет.
- `allowMediumRiskInAutoMode` → объявление и присваивание (`service.ts:749,756`; `create-app.ts:394`), чтения в решениях нет.
- `costUsd|totalCost|cost_usd|maxCost` в `core/adapters/contracts` → 0 совпадений.
- `permissionTimeoutMs` присваивания → только тесты (`core/tests/guarded-approval.test.ts:98`).
- `maxTurns` в `packages/cli/src`, `packages/shared-types/src`, `bootstrap/src/app/runtime-config.ts` → 0 совпадений.
- `streaming-tool-coordinator` в `packages/core/tests` → 0 файлов.

### 8.5 Coverage status

**Статус: partial.**

**Проверено:** структура `apps/zcode-cli` и все пакеты, релевантные loop; полный путь turn от `executeTurn` до терминального события; maxTurns и durable-маркер; approval-политика, broker, persistence правил, TUI/headless UX; уровни retry/fallback/recovery; лимиты (turn, output, timeout, concurrency, result budget, idle/first-token); admission (CommandInbox + core queue), steer/guide, cancellation, stale-generation guards; resume и hydration; streaming-очередь и tool-streaming; context assembly, micro/auto/reactive compact, cache_control, usage accounting; инвентарь тестов (306/164/237/28/29/44 файлов) и 357 узких тестов выполнено.

**Не проверено / ограничения:** полный `pnpm test`/`typecheck`/`lint`; real-provider E2E; desktop/mobile E2E; web-remote-replayable и desktop-continuous пути; детальный рендер ошибок и approval в UI; стоимость/латентность `ContextBuilder`; matcher `guarded` для Windows-диалектов на этой машине; фактическая продуктовая проводка `permissionTimeoutMs` и путь задания `maxTurns` через host/protocol (возможно, вне checkout).

**Подтверждение:** единственный записанный файл — `<repo-root>/docs/research/partials/2026-11-11-zcode-07-cli-runtime-agent-loop.md`. Production-файлы не изменялись; коммиты не делались; `git status --short` до записи содержал только `?? docs/research/`. Ветка осталась `dev`.
