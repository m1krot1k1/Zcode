# Лимит ходов turn (maxTurns)

## Назначение

Зафиксировать контракт `maxTurns`: отсутствие значения означает отсутствие лимита, а явное
положительное число ограничивает число ходов turn и завершает его предсказуемым статусом
`error_max_turns`, без тихого обрыва и без «успешного» терминального события.

## Владелец состояния

- `AgentRuntimeConfig.maxTurns?: number` — конфигурация конкретного runtime
  (`apps/zcode-cli/packages/core/src/runtime/types.ts`). Значение не переписывается и не
  подставляется по умолчанию внутри turn loop.
- Для дочерних сессий эффективное значение вычисляет единственный владелец спавна
  (`runtime/methods/subagent.ts`): `profile.maxTurns ?? config.subagents.maxTurns`. Если оба
  источника отсутствуют, ребёнок получает `undefined`, то есть без лимита; неявный fallback
  вроде `?? 4` не допускается.
- Workflow-актор получает только явное значение
  (`request.opts.maxTurns ?? runtimeConfig.maxTurns`), ограниченное схемой
  `MAX_WORKFLOW_AGENT_TURNS`; отсутствие поля означает отсутствие лимита.
- Счётчик израсходованных ходов принадлежит тому же turn loop, который запускает модель и
  инструменты. Второй счётчик в registry или UI не вводится; UI читает готовый terminal-статус.

## Контракт

- `maxTurns === undefined` — лимита нет: turn выполняется до естественного завершения ответа,
  `Stop`, отмены runtime или ошибки провайдера.
- `maxTurns` — положительное целое число. Turn завершается, когда число выполненных ходов
  достигло значения, а модель снова запросила продолжение (то есть новый ход потребовал бы
  превышения лимита). Ровно `maxTurns` ходов разрешены; следующий не запускается.
- Достижение лимита — не ошибка выполнения инструмента и не отмена пользователем. Turn
  публикует терминальное событие `TurnComplete` с `resultType: "error_max_turns"` (значение уже
  входит в `TurnResultType` в contracts и в protocol schema), сохраняя уже полученный
  assistant-текст. Отдельный `TurnError` с выдуманным кодом не вводится.
- Ограниченный результат должен быть durable: финальный assistant-шаг turn получает маркер
  `metadata.turnResult = "error_max_turns"` в transcript. Маркер пишется на терминальной
  границе limit-finalizer и читается холодным восстановлением, чтобы после рестарта turn не
  превращался в `success`. Маркер не является `assistant.error`: последний assistant-шаг
  выполнился штатно, а `error` исключает сообщение из compact preserved segment и из
  stable-fork boundary, что потеряло бы уже полученный текст.
- Маркер привязан к assistant-сообщению **текущего turn**, а не к runtime-глобальному
  указателю. Limit-finalizer выбирает последний завершённый assistant этого turn
  (`anchor.turnId === turn.turnId`, есть `time.completed`, нет `assistant.error`);
  `latestAssistantMessageId` как источник якоря запрещён: после отката непустого шага он
  может указывать на assistant предыдущего turn. Если текущий turn не оставил ни одного
  assistant-сообщения (например, пустой length-шаг откатывается, и maxTurns срабатывает на
  следующей границе), finalizer сам персистит минимальный технический assistant-якорь в этом
  turn: пустой текст, пустой usage, без `finish`, `anchor.turnId` текущего turn. Якорь не
  попадает в provider-историю при холодном восстановлении (пустой assistant без token
  baseline пропускается hydration-ом) и не создаёт ложный Continue, потому что не несёт
  `finish: "length"`.
- Запись маркера fail-closed: `persistTurnResultMarker` повторно проверяет
  `role === "assistant"`, совпадение `anchor.turnId` с turn finalizer-а и наличие
  `time.completed`. При несовпадении маркер не пишется (warn
  `turn.max_turns.marker_anchor_mismatch`), поэтому assistant чужого turn не может получить
  ограниченный статус. Отсутствие маркера деградирует только холодный путь, но не меняет
  live-терминал.
- Статус виден пользователю: projection строит из `resultType` заголовок раунда (`failed`) и
  фазу `error`, а для `error_max_turns` дополнительно проецирует
  `control.lastError { code: "error_max_turns" }`; `ChatErrorBanner` локализует этот код
  (`zcode.error.ERROR_MAX_TURNS`) и показывает явное сообщение о достигнутом лимите ходов.
  Turn не отображается как обычный `success` и не завершается молчаливым обрывом без текста.
- Session `lastOutcome` для `error_max_turns` не равен `completed`: лимит — ограниченный
  результат, а не успех. Владелец персистенции терминального события обязан маппить
  `error_max_turns` в `error`; UI не выводит успех из наличия `TurnComplete`.
- `maxTurns` не влияет на уже принятый ввод, permission-запросы и tool execution внутри
  начатого хода: проверка выполняется на границе нового хода.
- Родительский лимит не наследуется ребёнку автоматически: у ребёнка своё эффективное значение
  из профиля/`subagents.maxTurns`. Deadline роли (`subagentTaskTimeoutMinutes`) и `maxTurns`
  независимы; побеждает то ограничение, которое наступило первым, и оно пишет свой terminal-факт
  через существующий finalizer.
- Встроенные роли задают `maxTurns` явно: start 12, orchestrator 60, researcher/debugger 40,
  implementer/coder/frontend/backend/infra 50, reviewer/security/evaluator/self-improver 25,
  test-engineer 30, knowledge-curator/subagent-factory 20. Это не token budget и не deadline,
  а предсказуемая граница model steps; custom-профиль может переопределить значение.
- За 5 шагов до лимита turn loop один раз добавляет provider-visible reminder
  (`model_anomaly`): прекратить расширение scope, синтезировать собранное и вернуть partial
  handoff с evidence и unresolved. Напоминание не меняет terminal-семантику `error_max_turns`.
- Отдельно действует мягкий `modelAnomalyGuard.toolCallWarningThreshold = 60`: после 60 tool
  calls turn получает reminder синтезировать результат, но не прерывается. Это ориентир, а не
  жёсткий лимит и не замена `maxTurns`.
- Если настройка задана некорректно (0, отрицательное, дробное, NaN), runtime не превращает её
  в лимит: такое значение отклоняется парсером фронтматтера/настроек, а runtime трактует
  невалидное значение как отсутствие лимита. Тихий fallback к фиксированному числу запрещён.

## Состояние реализации

- Единственный исполнитель лимита — `runtime/methods/turn-loop.ts`: `resolveMaxTurnsLimit`
  принимает только положительный safe integer, а граница проверяется перед запуском нового
  model step (`state.modelStepCount >= limit`). Уже начатый шаг (включая tool execution и
  permission-запросы) не прерывается.
- При срабатывании пишется диагностическое событие лога `turn.max_turns.reached`
  (`maxTurns`, `modelStepCount`) со статусом `failed` (ограниченный результат, не обычное
  завершение), затем `TurnMachine.complete(..., "error_max_turns")`; `runtime/methods/turn.ts`
  публикует `TurnComplete` с `resultType` из turn machine, не перезаписывая его на `success`.
- Durable-маркер пишет тот же limit-finalizer. `turn-loop.ts` сначала выбирает якорь в
  пределах текущего turn: последний assistant с `anchor.turnId === state.turnId`, заполненным
  `time.completed` и без `assistant.error`; runtime-глобальный `latestAssistantMessageId` не
  читается. Если такого assistant нет, finalizer пишет минимальный технический якорь через
  `persistAssistantMessage` (пустой текст, пустой usage, без `finish`) и передаёт его id в
  `persistTurnResultMarker` (`runtime/methods/message-persistence.ts`). Marker-функция
  находит запись по id, проверяет владельца (`role`, `anchor.turnId`, `time.completed`),
  добавляет `metadata.turnResult = "error_max_turns"` и переиспользует существующий
  `persistMessage`/`saveMessage`; при несовпадении пишет warn
  `turn.max_turns.marker_anchor_mismatch` и ничего не меняет. `historyRoundCount`
  фиксируется в `anchor` из live-значения turn loop, чтобы технический якорь не искажал
  холодный счётчик раундов. Отдельная схема не вводится: `metadata.turnResult` —
  transcript-аналог уже принятого для `cancelled` `error.data.turnResult`. Ошибки записи
  логируются как `warn` (`turn.max_turns.marker_persist_failed`) и не превращают
  ограниченный terminal в успех: live-событие уже содержит `error_max_turns`, а потеря
  маркера деградирует только холодное восстановление до прежнего (ошибочного) `success`.
- Терминальная телеметрия согласована с ограниченным статусом. `recordTurnUsageFact` для
  `error_max_turns` получает `status: "error"` (`UsageStatus` не содержит `failed`; это
  единственное фактически поддерживаемое не-успешное значение) и `errorType:
"error_max_turns"`. Лог turn-finalizer для этого случая называется
  `turn.max_turns.completed` и несёт `status: "failed"` и `resultType`; событие
  `turn.completed` со `status: "completed"` остаётся только у успешного turn, поэтому
  success-метрики (`avgTurnDurationMs` по `status = 'completed'`) не включают ограниченные
  turn.
- Холодная цепочка: limit-finalizer → `metadata.turnResult` в transcript →
  `transcript-hydration` (`TurnResultForHydration`, `normalizeTurnResult`,
  `synthesizeAssistantParts`) → `TurnComplete(resultType)` → `ProductProjection`
  (`mapTurnResultToHeaderState` → `failed`, `phase: "error"`, `lastError`) →
  `cold-event-merge` подавляет memory-события turn, если transcript-производные уже
  покрывают его, поэтому именно маркер transcript является авторитетным для холодного пути.
- Приоритет значений в `normalizeTurnResult`: `cancelled` > `error_max_turns` >
  `error_during_execution` > `success`. Turn-level limit (уже полученный текст сохранён)
  точнее, чем дефолтное «выполнение прервано», но отмена пользователя остаётся сильнее.
- Перед терминальным фактом лимита turn loop проверяет `turnAbortSignal`: если Stop/отмена
  произошли на границе (в том числе во время async-возврата guide в очередь), побеждает
  `cancelled`, а не `error_max_turns`.
- `runtime/methods/subagent.ts` больше не добавляет `?? 4`: эффективное значение ребёнка —
  `request.maxTurns ?? config.subagents?.maxTurns`, иначе `undefined`.
- `runtime/methods/events.ts` маппит `TurnComplete(resultType: "error_max_turns")` в
  `lastOutcome: "error"`; `cancelled` остаётся `interrupted`, `TurnError` — `error`.
- UI-слой текущего change set (`packages/ui/src/ChatErrorBanner.tsx`,
  `packages/ui/src/root/botsTaskBroadcast.ts`, i18n-ключи `ERROR_MAX_TURNS`) показывает
  явное сообщение о лимите и не помечает такой task как `completed`.

## Типы терминального статуса

- `TurnResultType` в contracts (`apps/zcode-cli/packages/contracts/src/events/session.events.ts`,
  локальная копия в `core/src/agent/turn-state.ts`) содержит
  `success | cancelled | error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls`.
- Protocol-схема `TurnComplete` (`packages/shared/src/zcode-protocol/index.ts`) принимает те же
  значения строгим enum; новое значение не требуется.
- `lastOutcome` сессии: `error_max_turns → error`, `cancelled → interrupted`,
  любой `TurnError → error`, остальные `TurnComplete → completed`.

## Проводка настройки (фактическая)

- Subagent-профиль: frontmatter `maxTurns` (`agentProfileSchema`: positive integer; парсеры
  `subagent-profile-parser.ts` / `subagentMarkdown.ts` нормализуют невалидное значение в
  `undefined`) → `AgentProfile.maxTurns` → `subagent/runner.ts` передаёт в
  `ExploreSubagentRuntimeRequest.maxTurns` → `runtime/methods/subagent.ts` создаёт child с
  `request.maxTurns ?? config.subagents?.maxTurns`.
- Script-workflow: `WorkflowAgentOptionsSchema.maxTurns` (positive integer, не больше
  `MAX_WORKFLOW_AGENT_TURNS = 200`) → `script-workflow-runtime.ts` сохраняет `opts` →
  `script-workflow-child-runtime.ts`: `request.opts?.maxTurns ?? runtimeConfig.maxTurns`.
  Отсутствие поля означает отсутствие лимита.
- Root runtime: `AgentRuntimeConfig.maxTurns` читается turn loop, но фактических продюсеров
  из UI/протокола сегодня нет: `zcodeSessionCreateParamsSchema`/resume, `buildSessionCreateParams`
  в `packages/services/src/zcode-agent`, `packages/desktop/src` и `AppSettings`
  (`packages/shared/src/protocol.ts`) не содержат `maxTurns`; в CLI/TUI нет флага и ключа
  конфига. Поэтому root-настройка сейчас достижима только программно (встраивание,
  тесты, e2e), а по умолчанию root работает без лимита.
- `subagents.maxTurns` типизирован и пробрасывается в конфиг ребёнка/внука
  (`subagent.ts`), но Host/UI-продюсера у него тоже нет: единственный пользовательский
  путь — `maxTurns` в Markdown-профиле агента. UI формы subagents (`SubagentsSection.tsx`)
  не рисует поле ввода `maxTurns` и лишь сохраняет уже существующее значение профиля при
  редактировании; i18n-ключи `settings.subagents.form.maxTurns.*` объявлены, но не
  используются компонентом. Новую настройку root/UI не изобретать без отдельного
  продуктового решения.

## Приёмочные сценарии

| ID         | Сценарий                                                                                                       | Ожидаемый результат                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MAXTURN-01 | `maxTurns` не задан                                                                                            | Turn не обрывается по счётчику; завершение только по ответу модели, Stop, отмене или ошибке провайдера.                                                                                                                  |
| MAXTURN-02 | `maxTurns = 3`, модель просит продолжения после 3-го хода                                                      | Четвёртый ход не запускается; публикуется `TurnComplete(resultType: "error_max_turns")` с уже полученным текстом; финальный assistant получает durable `metadata.turnResult = "error_max_turns"`.                        |
| MAXTURN-03 | `maxTurns = 3`, модель завершает ответ раньше                                                                  | Turn завершается обычным `success`; лимит не влияет на результат.                                                                                                                                                        |
| MAXTURN-04 | Ребёнок без `profile.maxTurns` и без `subagents.maxTurns`                                                      | Эффективное значение `undefined`; неявного `4` нет.                                                                                                                                                                      |
| MAXTURN-05 | Ребёнок с `profile.maxTurns = 2`                                                                               | Лимит действует только на ребёнка; родитель продолжает по своему значению.                                                                                                                                               |
| MAXTURN-06 | Достигнут лимит при активном tool-вызове                                                                       | Начатый ход завершается штатно; новый ход не стартует; terminal-факт один и видим пользователю.                                                                                                                          |
| MAXTURN-07 | UI получает terminal-событие `error_max_turns`                                                                 | Пользователь видит явное сообщение о лимите (`control.lastError.code = "error_max_turns"` + локализация); статус не маппится в обычный успех.                                                                            |
| MAXTURN-08 | Cold resume после ограниченного turn                                                                           | Восстановленный из transcript turn имеет `resultType: "error_max_turns"`, `turnHeader.state: "failed"`, `control.phase: "error"` и `control.lastError.code = "error_max_turns"`; `lastOutcome` сессии остаётся `error`.  |
| MAXTURN-09 | Пустой length-шаг на границе лимита: turn 1 success, turn 2 заканчивается пустым `finish: "length"` и maxTurns | Шаг turn 2 откатывается (нет assistant-сообщения), маркер получает технический якорь turn 2; assistant turn 1 остаётся без `metadata.turnResult`. Cold hydrate даёт `success` для turn 1 и `error_max_turns` для turn 2. |
| MAXTURN-10 | Граница лимита после tool-only шагов                                                                           | Маркер пишется на последний assistant именно этого turn (turnId совпадает); assistant предыдущего turn не маркируется; cold hydrate сохраняет прежний результат предыдущего turn.                                        |
| MAXTURN-11 | Телеметрия ограниченного turn                                                                                  | `upsertTurnUsage` получает `status: "error"` и `errorType: "error_max_turns"`; лог ограничения — `turn.max_turns.completed` со `status: "failed"`; `turn.completed`/`status: "completed"` для такого turn не пишутся.    |
| MAXTURN-12 | Встроенный профиль без `maxTurns` в исходном объекте                                                           | Каталог отдаёт явный ролевой дефолт; `researcher=40`, `reviewer=25`, значения положительные у всех 16 ролей.                                                                                                             |
| MAXTURN-13 | До лимита осталось 5 шагов                                                                                     | Ровно один reminder просит синтезировать результат и вернуть partial handoff; повторно reminder не добавляется, terminal остаётся прежним.                                                                               |

## Проверки

- Unit: turn loop с `maxTurns = N` выполняет ровно N ходов и завершает turn с
  `resultType: "error_max_turns"`; без настройки счётчик не ограничивает цикл.
- Unit: лог `turn.max_turns.reached` несёт `status: "failed"`, а не `completed`.
- Unit: финальный assistant ограниченного turn durable-маркирован
  `metadata.turnResult = "error_max_turns"`; при штатном `success` маркера нет.
- Unit (MAXTURN-09): после turn 1 с `success` turn 2 с пустым `finish: "length"` и
  достигнутым maxTurns создаёт технический якорь turn 2 с маркером; assistant turn 1
  остаётся без маркера; cold hydrate даёт `["success", "error_max_turns"]`.
- Unit (MAXTURN-10): маркер не уходит на assistant предыдущего turn при границе после
  tool-only шагов; проверяется совпадение `anchor.turnId` и отсутствие маркера у turn 1.
- Unit (MAXTURN-11): `upsertTurnUsage` для ограниченного turn — `status: "error"`,
  `errorType: "error_max_turns"`; терминальный лог — `turn.max_turns.completed` со
  `status: "failed"`; `turn.completed` не публикуется.
- Cold-resume regression: transcript с маркером после `mergeColdConversationEvents`
  даёт `TurnComplete(error_max_turns)`, `turnHeader.state: "failed"`, `control.phase: "error"`,
  `control.lastError.code = "error_max_turns"` и `lastOutcome: "error"`, а не `success`.
- Projection: `TurnComplete(error_max_turns)` проецирует `control.lastError` с кодом
  `error_max_turns` (для достижимости локализованной ветки `ChatErrorBanner`).
- Unit: `resolveSubagentTaskTimeoutMs` и сборка child config не добавляют неявный `maxTurns`.
- Protocol/UI: `error_max_turns` проходит strict schema и отображается как ограниченный
  результат, а не как `success`.
