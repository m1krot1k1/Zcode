# Этап 6.1 — сквозная приёмочная верификация в реальном рантайме

Дата: 2026-11-17. Контур: локальная Linux-машина (kernel 6.14), Node v22.23.5, pnpm 10.33.2, `DISPLAY=:0`, Chromium (Playwright `chromium-1217`), `bwrap 0.2/0.9`, `node-pty 1.1.0`.

Правило отчётности: каждый пункт имеет статус `VERIFIED` (объективное доказательство), `FAILED` (дефект найден и исправлен) или `BLOCKED` (невозможно в этом окружении, с причиной и доказательством). Никаких «должно работать».

---

## 1. Сводная таблица функций

| # | Функция | Сценарий проверки | Статус | Доказательство |
|---|---|---|---|---|
| 1 | `MultiEdit` / `Edit` / `Write` / `ApplyPatch` — транзакционное редактирование | Реальный runtime: успешный пакет из 3 файлов; отклонение при синтаксической ошибке; `Edit` с расхождением отступов; проверка отсутствия частично записанных файлов | **VERIFIED** | `apps/zcode-cli/e2e/session-forensic-replay/case-multiedit-transaction.mjs` → `assertions: {atomicCommit, rejectedSyntaxRolledBack, tolerantIndentEdit, noPartialFiles}`. Артефакты: `docs/architecture/evidence/stage6/forensic-replay-run*.json` |
| 2 | `ApplyPatch` на не-GPT модели | Скриптованный OpenAI-совместимый провайдер (не GPT): инструмент присутствует в списке и патч применяется на диске | **VERIFIED** | `case-prompt-cache-apply-patch.mjs` → `assertions: {applyPatchVisibleForNonGptProvider: true, applyPatchAppliedOnDisk: true}` |
| 3 | `PtySession` — интерактивная сессия | Реальный `bash` под PTY: старт, запись команды, инкрементальное чтение, `exitCode`, kill с деревом процессов | **VERIFIED** | `case-pty-session.mjs` → `assertions: {started, incrementalRead, exitCodeObserved, killTreeTerminated}` |
| 4 | Песочница `bash` (`sandbox.mode` в результате) | Реальный `bwrap`: `sandbox.mode` доходит до модели в тексте результата; запись вне workspace (`$HOME`, ro-bind) блокируется | **VERIFIED** | `case-bash-sandbox.mjs` → строка `[sandbox: mode=bwrap, filesystemIsolated=true, networkIsolated=false]` в перехваченном запросе; попытка записи в `$HOME` → `EACCES/EROFS` |
| 5 | Код-индекс (`CodeIndex`) | Автостарт индексации в фоне для тестовой папки; реальный поиск релевантного фрагмента; инкрементальное обновление после правки; инструмент виден модели | **VERIFIED** | `case-code-index.mjs` → `assertions: {autoStartBuiltIndexInBackground, searchSnippetMatched, incrementalUpdateApplied, codeIndexToolVisibleToModel}`; реальный SQLite + AST-чанкер `@zcode/services` |
| 6 | Обрыв по `finishReason === "length"` | Провайдер отдаёт обрезанные аргументы инструмента при `finish_reason: "length"`: детерминированный `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS`, декомпозиция повторной генерации, отсутствие `Unexpected end of JSON input` | **VERIFIED** | `case-truncated-tool-args.mjs` → `assertions: {deterministicTruncationCode, decomposedRecovery, noJsonParseError, noPartialFileOnDisk}` |
| 7 | Кэширование промптов | Побайтовая стабильность кэшируемого префикса (tools + первые сообщения) между реальными запросами провайдера | **VERIFIED** (скриптованный провайдер) | `case-prompt-cache-apply-patch.mjs` → `assertions.cacheablePrefixByteStable: true`, `prefixLength` в результате |
| 8 | Кэш промптов, реальные `cacheReadTokens > 0` | Нужен реальный ключ OpenRouter | **BLOCKED** | `~/.zcode/v2/credentials.json` содержит 0 ключей; сетевого провайдера нет |
| 9 | Субагенты / Swarm с пересекающимися путями | 3 параллельных субагента (`subagent_type: "coder"`) с одинаковыми `write_paths`: детерминированные `write_claim_conflict`, освобождение локов, неизменность общего файла | **VERIFIED** | `case-swarm-file-locks.mjs` → `assertions: {allThreeSpawned, claimConflictsObserved, sharedFileUnchanged, locksReleased}` |
| 10 | `/enhance` (CLI) | Реальный `runEnhanceCommand` → `generateWorkspaceText`: успех, сохранение `@src/app.ts`, отмена через `AbortSignal`, пустой ввод, `model_unavailable` | **VERIFIED** | `case-enhance.mjs` → `assertions: {realModelCallReturnedPrompt, mentionsPreserved, cancellationAborts, emptyInputRejected, modelUnavailableReported}` |
| 11 | Auto-repair loop (`enableAutoRepairLoop: true`) | Реальный `tsc`-исполнитель через `ExecutionPort`: инжектированная ошибка типа → блокирующий сигнал → отчёт `[auto-repair]` с `TS1005` → модель исправляет файл без участия пользователя; лимит запусков соблюдён | **VERIFIED** | `case-auto-repair-loop.mjs` → `assertions: {gateRanRealTypecheckProcess, blockingSignalReturnedToModel, fileRepairedWithoutUser}`, `modelRequests: 6` |
| 12 | Ghost-text (автодополнение в композере) | Реальный браузерный рендер | **VERIFIED** | CDP к живому Electron renderer: ghost-нода `[data-testid="chat-ghost-text"]` появляется с `data-ghost-source=model_stream` (реальная модель), `Tab` принимает всю подсказку и нода исчезает, `Escape` скрывает без потери введённого текста, `ArrowRight` принимает одно слово; при `chatAutocompleteSettings.enabled=false` ноды нет. Скриншоты: `docs/architecture/evidence/stage6/ui/10..15-*.png`, лог: `ui-verification.json`. См. §9 |
| 13 | Кнопка `Enhance Prompt` (UI) | Реальный браузерный рендер | **VERIFIED** | `disabled` на пустом вводе и активна при тексте; реальный RPC `PromptEnhancer` изменил черновик (32 → 812…1232 симв.), `Ctrl+Z` вернул исходный текст. Скриншоты `06..08-enhance-*.png`, см. §9 |
| 14 | `/enhance` в slash-панели (UI) | Реальный браузерный рендер | **VERIFIED** | Панель slash на `/enhance` содержит «Улучшить промпт». Скриншот `09-slash-enhance.png` |
| 15 | Панель настроек «Возможности агента» | Реальный браузерный рендер + персистентность | **VERIFIED** | Секция открывается, все 13 строк отрендерены (7 групп), описания на `ru-RU`; переключатель меняет значение, пишется в `~/.zcode/v2/setting.json` и переживает reload renderer. Глобального поиска по настройкам в Desktop-сборке нет (см. §9, оговорка) |
| 16 | Диффы / статус фоновых задач в UI | Реальный браузерный рендер | **VERIFIED** | Закрыто в Этапе 6.1c (см. §12). В живом Electron renderer реальный `MultiEdit` двух файлов довёл `fileTransaction.updated` до UI: под tool-блоком появляется `chat-file-transaction-panel` с `data-transaction-status="committed"`, `data-transaction-compact="false"`, реальными путями и счётчиками `+2 -0`; консоль renderer чистая. Артефакты: `docs/architecture/evidence/stage6/ui/16-file-transaction-panel.png`, `17-file-transaction-files.png`, `18-file-transaction-after-reload.png`, `ui-file-transaction-verification.json`. До этого проверка была `PARTIAL`, потому что панель не имела потребителя (§10.4) и данные терялись на двух участках CLI (§12.1) |
| 17 | Electron: окно создаётся, renderer загружается | Запуск из исходников с `--remote-debugging-port` | **VERIFIED** | `pnpm dev:desktop`/`electron .` поднимает окно, `dom-ready`, `did-finish-load`, RPC из renderer (`window-controller.listTaskList OK`), CDP-таргет `ZCode` доступен. `ERR_FAILED`/`did-fail-load`/`ERR_UPDATER` — 0 вхождений. См. §8 |

---

## 2. Воспроизведение траектории `session_dee7732e677519c63e3dd10d5eeeaaff`

Каталог: `apps/zcode-cli/e2e/session-forensic-replay/` (часть поставки, пригоден для CI).

Состав набора (9 кейсов):

| Кейс | Закрываемый отказ | Что доказывает |
|---|---|---|
| `case-truncated-tool-args.mjs` | `F-01` (обрыв JSON аргумента инструмента) | Детерминированный код усечения, декомпозированное восстановление, отсутствие `Unexpected end of JSON input`, отсутствие частично записанного файла |
| `case-swarm-file-locks.mjs` | `F-02` (гонки субагентов на общих файлах) | `write_claim_conflict`, освобождение локов, неизменность файла |
| `case-prompt-cache-apply-patch.mjs` | `F-03` (`ApplyPatch` только для GPT) | Инструмент доступен не-GPT провайдеру и применяет патч |
| `case-multiedit-transaction.mjs` | `F-04`/`F-06` (атомарность файловых операций, `Edit` по отступам) | 100 % откат при синтаксической ошибке, tolerant-совпадение отступов |
| `case-code-index.mjs` | `F-05` (индекс не строится автоматически) | Автостарт индексации + инкрементальное обновление |
| `case-bash-sandbox.mjs` | `F-07` (`BASH_SANDBOX_ENFORCEMENT = "not_implemented"`) | Реальный `bwrap`, блокировка записи вне workspace |
| `case-pty-session.mjs` | 4.5a (интерактивный PTY) | Старт/чтение/exit/kill дерева |
| `case-enhance.mjs` | 4.4 (`/enhance`) | Реальный вызов модели, отмена, ошибки |
| `case-auto-repair-loop.mjs` | 4.5b (замкнутый цикл) | Исполнение реальных проверок внутри хода агента |

### 2.1. Три прогона подряд

Команда (последовательно, `nice -n 19`):

```bash
pnpm --filter zcode-cli exec tsx \
  ../../apps/zcode-cli/e2e/session-forensic-replay/run.mjs \
  --artifacts-dir=/tmp/zcode-e2e-verify/fin<N>
```

| Прогон | Кейсов | Passed | Failed | Артефакт |
|---|---|---|---|---|
| 1 | 9 | 9 | 0 | `docs/architecture/evidence/stage6/forensic-replay-run1.json` |
| 2 | 9 | 9 | 0 | `docs/architecture/evidence/stage6/forensic-replay-run2.json` |
| 3 | 9 | 9 | 0 | `docs/architecture/evidence/stage6/forensic-replay-run3.json` |

Итог: **3 × 9 = 27 прогонов кейсов, 0 падений**, результат воспроизводим.

### 2.2. Какие отказы закрыты и чем доказано

- `F-01` — `truncated-tool-args`: `deterministicTruncationCode`, `noJsonParseError`.
- `F-02` — `swarm-file-locks`: `claimConflictsObserved` при трёх одновременных субагентах на общих файлах.
- `F-03` — `prompt-cache-apply-patch`: `applyPatchVisibleForNonGptProvider`.
- `F-04` / `F-06` — `multiedit-transaction`: `rejectedSyntaxRolledBack`, `tolerantIndentEdit`.
- `F-05` — `code-index`: `autoStartBuiltIndexInBackground`.
- `F-07` — `bash-sandbox`: `sandbox.mode=bwrap` + блокировка записи вне workspace.

---

## 3. Обнаруженные и исправленные дефекты

### 3.1. `PtySession` не был подключён ни в одном хосте (`FAILED → исправлено`)

Симптом: `ptySessionPort` объявлен в `core` и реализован в `adapters`, но ни `prepareAppPorts`, ни хосты его не создавали. В перехваченном запросе к провайдеру было 33 инструмента — `PtySession` отсутствовал, то есть функция была недоступна модели.

Исправление:
- `apps/zcode-cli/packages/bootstrap/src/app/create-app-ports.ts` — создание/приём порта и `closePtySessions`;
- `types.ts`, `create-app-session.ts`, `session-facade.ts`, `create-app-surface.ts`, `session-facade-shutdown.ts` — протяжка порта и освобождение ресурса;
- `apps/zcode-cli/packages/core/src/index.ts` — экспорт типа `PtySessionPort`;
- `apps/zcode-cli/packages/cli/scripts/build.mjs` — `node-pty` вынесен во external.

Проверка: в запросе стало **34 инструмента**, `PtySession: true`; `case-pty-session.mjs` проходит.

### 3.2. Фактический `sandbox.mode` не доходил до модели (`FAILED → исправлено`)

`formatBashModelContent` не включал данные песочницы, хотя `bash-prompt.ts` обещает модели поле `sandbox.mode`.

Исправление: `apps/zcode-cli/packages/core/src/tool/handlers/bash-model-content.ts` — добавлен `formatSandboxInfoForModel`, выводящий `[sandbox: mode=…, reason: …, filesystemIsolated=…, networkIsolated=…]`.

Тест: `apps/zcode-cli/packages/core/tests/bash-sandbox-model-content.test.ts` (3 теста, проходят).

### 3.3. `enableAutoRepairLoop` не имел потребителя в рантайме (`FAILED → исправлено`)

Симптом: флаг доходил из настроек до `runtimeConfig` (`server-operations-part6.ts`), но `createRuntimeAutoRepairLoop` вызывался **только из тестов** — цикл самовосстановления в реальном ходе агента не работал.

Исправление:
- новый файл `apps/zcode-cli/packages/core/src/runtime/auto-repair-loop/agent-gate.ts` — разбор вывода `tsc`/`oxlint`, сбор сигналов через структурный порт исполнения, лимит запусков `AUTO_REPAIR_GATE_MAX_RUNS`;
- точка подключения — `apps/zcode-cli/packages/core/src/runtime/methods/turn-stop.ts` (`finishModelStepWithoutToolCalls`): гейт вызывается **до** завершения автомата, поэтому блокирующий сигнал продолжает тот же turn;
- счётчик `autoRepairGateRuns` в `RegularTurnLoopState` — единственный владелец бюджета запусков;
- экспорт в `auto-repair-loop/index.ts`.

Тест: `apps/zcode-cli/packages/core/tests/auto-repair-gate.test.ts` (10 тестов: разбор выводов, недоступный исполнитель → warning, лимит запусков, выключенный флаг → ни одной команды).

E2E: `case-auto-repair-loop.mjs` — реальный процесс `tsc` внутри тестовой папки, `[auto-repair]` + `TS1005` в запросе модели, файл исправлен агентом.

Архитектурная проверка после переноса файла в managed-модуль `cli-auto-repair-loop`: `pnpm architecture:check --changed` → `violations: 0`.

---

## 4. Ограничения окружения (`BLOCKED`)

Блокеры UI/Electron из первичного прогона **закрыты** в Этапе 6.1b — см. §9. Ниже сохранена исходная фиксация ограничений и добавлено фактическое состояние.

### 4.1. UI-проверки ghost-text / `Enhance Prompt` / `/enhance` / настроек — ЗАКРЫТО

`packages/web` — это клиент **Web Remote Control** (`packages/web/src` содержит только `auth/`, `bootstrap/`, `share/`, `web-remote-control/`), поэтому `pnpm dev:web` рендерит экран «Web Remote Control Failed» (`docs/architecture/evidence/stage6/web-vite-standalone.json`). Этот вывод верен и не изменился: целевой UI живёт в Electron renderer.

Что изменилось: Electron renderer теперь реально запускается, и UI проверен через CDP (§9). Все целевые проверки получили `VERIFIED`, кроме реактивной сводки диффов (§10).

### 4.2. Electron renderer — ЗАКРЫТО

Обе причины отказа устранены (§9.1, §9.2):

- `ERR_FAILED (-2)` был **вторичным**: main падал на импорте `electron-updater` с `App version is not a valid semver version: "0.0"` ещё до создания окна, из-за чего навигация и последующее закрытие окна выглядели как отказ renderer.
- в окружении терминала выставлен `ELECTRON_RUN_AS_NODE=1`, из-за чего `electron` стартовал как Node (`SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`).

После исправлений: `did-finish-load`, `dom-ready`, RPC из renderer (`window-controller.listTaskList OK`), CDP-таргет `ZCode` с `User-Agent … ZCodeDev/3.17.122`. Вхождения `ERR_FAILED`, `did-fail-load`, `ERR_UPDATER` в логе — 0.

### 4.3. Реальные `cacheReadTokens > 0` — BLOCKED (без изменений)

В `~/.zcode/v2/credentials.json` — 0 ключей. Проверка стабильности префикса выполнена на перехваченных телах запросов, но фактический счётчик кэша провайдера получить нечем. Для UI-проверок использовался настроенный `provider_config.json` (`opencode-go-messages`), что к этой строке не относится.

---

## 5. Аудит заглушек

Область: файлы, созданные/изменённые на Этапах 4.1–5b (142 пути из `git status`, исключая `dist/`). Поиск по `TODO`, `FIXME`, `not_implemented`, `notImplemented`, `Not implemented`, `stub`, `placeholder`, `mock`, `as any`.

| Совпадение | Вердикт |
|---|---|
| `bootstrap/src/app/create-app-surface.ts` — комментарии «stub порт не陪跑» (3 места) | **обосновано**: описывает поведение при отсутствии опционального порта; логика проверяет `undefined` и не регистрирует возможность |
| `bootstrap/src/zcode-protocol/session-mapper-projection.ts:720` — комментарий «Без `as any` / `@ts-ignore`» | **обосновано**: отрицательное утверждение в документации, кода-заглушки нет |
| `contracts/src/interfaces/browser-control.port.ts:611` — «不允许伪造 stub» | **обосновано**: контрактное требование |
| `core/src/runtime/types.ts:487` — «a repeat returns the existing stub» | **обосновано**: описание кэша чтения, не заглушка реализации |
| `core/src/tool/handlers/bash.ts:428` — `crypto.randomUUID() as any` | **обосновано**: приведение к branded-типу идентификатора внутри существующего обработчика; не новая логика этапов 4.1–5b |
| `shared/src/protocol.ts:347` — `TODO(settings-schema-version)` | **обосновано с оговоркой**: явный техдолг миграции настроек, помеченный и не влияющий на текущее поведение; относится к предсуществующему коду |
| `packages/ui/src/i18n/locales/*.ts`, `LexicalChatInput.tsx`, `ConversationComposer.tsx`, `ComposerRoot.tsx` — `placeholder` | **обосновано**: это UI-атрибут/ключ локализации, не заглушка |
| `packages/services/test/**`, `packages/ui/test/**` — `mock`/`vi.mock` | **обосновано**: тестовый код вне продакшн-путей |
| `packages/services/src/node/registration.ts:414-428` — «mock сценарий» | **обосновано**: описывает разрешённый тестовый сценарий в правилах доступа, не подменяет продакшн-логику |
| `core/tests/**` — `as any`, `not_implemented` | **обосновано**: тесты, включая утверждение, что внутренний trace больше не `not_implemented` |

Дефектов-заглушек в продакшн-путях новых модулей **не обнаружено**.

---

## 6. Сквозная проводка (проверено статически)

### 6.1. RPC-каналы `PromptEnhancer` и `ChatAutocomplete`

Оба сервиса реально регистрируются в Host:
- `packages/services/src/node/registration.ts:20` — `createPromptEnhancerService`, `IPromptEnhancerService`;
- `packages/services/src/node/registration.ts:29` — `IChatAutocompleteService`;
- регистрация в реестре: строки 485 и 497.

Они не являются zcode-protocol каналами: это сервисные дескрипторы `@zcode/services`, доступные через общий RPC-мост Host, поэтому отдельной схемы в `packages/shared/src/zcode-protocol` для них нет — это соответствует архитектуре.

### 6.2. Путь «UI → settings → runtimeConfig → потребитель»

| Настройка | UI | Проекция | Потребитель в рантайме |
|---|---|---|---|
| `enableAutoRepairLoop` (+ лимиты) | `settings-stage4/SettingsStage4Section.tsx:191` | `shared/src/stage4-settings/host-runtime.ts:66` → `agent.ts:313` → `server-operations-part6.ts:237` | `core/src/runtime/methods/turn-stop.ts` → `auto-repair-loop/agent-gate.ts` (добавлено в 3.3) |
| `sandbox.mode` / `allowNetwork` / `commandTimeoutMs` | `SettingsStage4Section.tsx` | `host-runtime.ts` → `agent.ts:317-319` | `core` bash handler → `adapters/exec/sandbox` |
| `subagentMaxParallel` | `SettingsStage4Section.tsx` | `host-runtime.ts:73` → `agent.ts:320` | `runtimeTaskRegistry.beginRootRunBudget({ maxParallel })` |
| `codeIndexAutoStart` / `codeIndexVectorChannel` / `codeIndexTokenBudget` | `SettingsStage4Section.tsx` | `agent.ts:321-323` | `codeIntelligenceService.watchWorkspace({ autoIndexOnOpen })`, `search({ maxTokens })` |
| `chatAutocompleteEnabled` / `promptEnhancerEnabled` | `SettingsStage4Section.tsx` | `agent.ts:325-326` | Host-сервисы `PromptEnhancer`/`ChatAutocomplete` |

Все пять строк имеют реального потребителя; до правки 3.3 потребителя не было только у `enableAutoRepairLoop`.

### 6.3. Видимость инструментов модели

По перехваченному телу запроса в `case-pty-session` / `case-code-index`:
- `PtySession` — присутствует (после 3.1), 34 инструмента;
- `CodeIndex` — присутствует при инжектированном `codeIntelligencePort`;
- `MultiEdit` — присутствует в наборе file-tools;
- `ApplyPatch` — присутствует у не-GPT провайдера (см. кейс 2).

---

## 7. Метрики Baseline → Итог

| Метрика | Baseline (Stage 1) | Итог | Комментарий |
|---|---|---|---|
| `BASH_SANDBOX_ENFORCEMENT` | `not_implemented` | `bwrap` + блокировка записи вне workspace | `case-bash-sandbox` |
| Обрыв JSON при `length` | `Unexpected end of JSON input` | `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS` + восстановление | `case-truncated-tool-args` |
| Атомарность файловых операций | частичные записи | 100 % откат, `noPartialFiles` | `case-multiedit-transaction` |
| `ApplyPatch` на не-GPT | недоступен | доступен и применяется | `case-prompt-cache-apply-patch` |
| Автоиндексация кода | индекс не строился | автостарт + инкрементальное обновление | `case-code-index` |
| Интерактивный PTY | отсутствовал в наборе инструментов | виден модели, работает | `case-pty-session` |
| Замкнутый цикл самовосстановления | не подключён к рантайму | работает в ходе агента, лимит соблюдён | `case-auto-repair-loop` + 10 UT |
| Гонки субагентов | не детектировались | детерминированный `write_claim_conflict` | `case-swarm-file-locks` |
| Стабильность e2e | — | 3 прогона × 9 кейсов = 27/27 | §2.1 |
| `pnpm typecheck` | 0 ошибок | 0 ошибок | подтверждено повторно |
| `pnpm lint` | 0 ошибок | 0 ошибок (345 warnings, из них 5 в CLI) | повторно |
| `architecture:check --changed` | 0 | 0 | повторно после переноса файла |

**Недостигнутые цели (честно):** реальные `cacheReadTokens > 0`, визуальная проверка ghost-text / `Enhance Prompt` / `/enhance` в UI, панель настроек с персистентностью, реактивные диффы в UI — все требуют работающего Electron renderer или реального провайдера (см. §4).

---

## 8. Воспроизведение

```bash
# Сборка пакетов CLI
pnpm --filter @zcode/core build
pnpm --filter @zcode/adapters build
pnpm --filter @zcode/bootstrap build

# Полный forensic-replay набор (9 кейсов)
pnpm --filter zcode-cli exec tsx \
  ../../apps/zcode-cli/e2e/session-forensic-replay/run.mjs \
  --artifacts-dir=/tmp/zcode-e2e-verify/run

# Отдельный кейс
... run.mjs --case=auto-repair-loop

# Юнит-тесты исправлений
pnpm --filter @zcode/core exec vitest run \
  tests/auto-repair-gate.test.ts \
  tests/bash-sandbox-model-content.test.ts
```

---

## 8. Этап 6.1b — закрытие UI-блокеров

### 8.1. Причина `App version is not a valid semver version: "0.0"`

Точный стек (воспроизведён запуском `electron .` из `packages/desktop`):

```
WARNING:electron/shell/common/application_info_linux.cc:68] No version found. Was app.setVersion() called?
App threw an error during load
Error: App version is not a valid semver version: "0.0"
    at new AppUpdater (node_modules/electron-updater/out/AppUpdater.js:215:55)
    at new BaseUpdater …
    at Object.get [as autoUpdater] (node_modules/electron-updater/out/main.js:81:32)
    at file:///…/packages/desktop/out/main/index.js:3:902
```

Механика: `electron-updater` читает `this.app.version` **в конструкторе** при первом обращении к `autoUpdater`, то есть на этапе вычисления модулей main. Без упаковки `app.asar` нет, и Electron возвращает `0.0` (он сам об этом предупреждает). Упаковочный пайплайн подставляет версию через `extraMetadata.version` из `electron.config`/`electron-builder`, поэтому установленная сборка не страдала, а dev- запуск падал до создания окна.

Почему не «хардкод-заглушка»: версия берётся из реального источника — корневого `package.json` через уже существующий `__ZCODE_VERSION__` (tsup `define`), с явным override `ZCODE_APP_VERSION` и документированным fallback `0.0.0-dev`; `setVersion` вызывается только в не-упакованном режиме, поэтому релизный пайплайн (`extraMetadata`) не затрагивается.

### 8.2. Причина `ERR_FAILED (-2)`

`ERR_FAILED` был **вторичным эффектом** 8.1 плюс окружения:

1. main падал на импорте `electron-updater` → окно либо не успевало получить документ, либо создавалось и закрывалось вместе с Host (`[createWindow] window closed, killing host process (local-1)`), что в отчёте выглядело как «навигация отклонена».
2. В терминале был выставлен `ELECTRON_RUN_AS_NODE=1`; первый ручной запуск вообще стартовал как Node:
   `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'` (Node.js v24.14.0).
3. `--remote-debugging-port=<port>` из CLI игнорировался, потому что main жёстко вызывает `app.commandLine.appendSwitch("remote-debugging-port", "9229")`; CDP нужно искать на 9229 (`ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` отключает пин).

Дополнительно устранён реальный дефект CSP: `connect-src` содержал `ws://[::1]:5174`, который Chromium считает невалидным host-source и игнорирует, засоряя консоль renderer ошибкой.

### 8.3. Внесённые исправления

| Файл | Что сделано |
|---|---|
| `packages/desktop/src/main/desktopAppVersionBootstrap.ts` (новый) | Чистая логика выбора версии: shape-валидация semver, порядок `ZCODE_APP_VERSION` → `__ZCODE_VERSION__` → `0.0.0-dev`, `setVersion` только для не-упакованного рантайма; идемпотентность |
| `packages/desktop/src/main/desktopEarlyAppVersionBootstrap.ts` (новый) | Ранний side-effect модуль: вызывает bootstrap до остальных `import` в main |
| `packages/desktop/src/main/index.ts` | `import "./desktopEarlyAppVersionBootstrap.js"` **первой строкой**, до `electron-updater` и прочих модулей |
| `packages/desktop/src/renderer/index.html` | Убран невалидный `ws://[::1]:5174` из `connect-src` (HMR по `localhost`/`127.0.0.1` сохранён) |
| `packages/services/src/prompt-enhancer/service.ts` | `PromptEnhancerModelResolver` теперь возвращает `reasoningLevels`; добавлен `pickLowestReasoningLevel`; `resolveSelection` больше не хардкодит `minimal` и сохраняет уровень клиента |
| `packages/services/src/node/prompt-enhancer-ports.ts` | Резолвер читает `optionSpecs.reasoningLevel.values` модели из реестра и передаёт их сервису |
| `packages/services/src/chat-autocomplete/service.ts` | То же для ghost-text: `pickCheapestReasoningLevel` вместо хардкода `"none"` |
| `packages/services/src/chat-autocomplete/ports.ts` | Резолвер прокидывает `reasoningLevels` из реестра провайдеров |
| `packages/desktop/test/desktopAppVersionBootstrap.test.ts` (новый) | 5 тестов: semver-валидация, приоритет источников, установка версии, невмешательство в packaged, идемпотентность |
| `packages/services/test/prompt-enhancer/promptEnhancerService.test.ts` | +2 регрессионных теста (модель с единственным `disabled`) |
| `packages/services/src/chat-autocomplete/contract.test.ts` | +1 регрессионный тест |
| `packages/desktop/scripts/verify-stage6-ui.mjs` (новый) | Переиспользуемый Playwright/CDP-скрипт приёмочной проверки UI |
| `architecture-policy.yaml` | path-exact исключения для двух ранних bootstrap-файлов (как для остальных `desktopEarly*`) |

### 8.4. Как запускается renderer (документированная команда)

```bash
pnpm dev:desktop          # → scripts/dev-desktop-env.mjs production → pre-dev, agent CLI, dev:runtime (tsup watch + vite dev + electron)
```

Проверка «голого» запуска из исходников (без Vite, с собранным `out/renderer`):

```bash
cd packages/desktop
env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 ZCODE_ENV=production \
  ../../node_modules/electron/dist/electron . --enable-logging=stderr
# CDP: http://127.0.0.1:9229  (порт пиннится в main; снять пин — ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1)
```

Обязательные условия dev-запуска: валидная версия приложения (§8.1), отсутствие `ELECTRON_RUN_AS_NODE` в окружении Electron, собранный renderer (`out/renderer/index.html`) при запуске без `ELECTRON_RENDERER_URL`. Секретов не требуется — `.env.example`/`.env.development` не менялись.

---

## 9. UI-верификация через Playwright + CDP (реальный renderer)

Подключение: `chromium.connectOverCDP("http://127.0.0.1:9229")` к **живому** Electron renderer (`file:///…/out/renderer/index.html`), DOM/preload/RPC — настоящие. Скрипт: `packages/desktop/scripts/verify-stage6-ui.mjs`, лог прогона: `docs/architecture/evidence/stage6/ui/ui-verification.json`, скриншоты: `docs/architecture/evidence/stage6/ui/*.png`.

| # | Проверка | Статус | Доказательство |
|---|---|---|---|
| 1 | Секция «Возможности агента» открывается, все 13 строк отрендерены | **VERIFIED** | 7 групп: «Агент и рассуждения», «Улучшение промптов», «Автодополнение в чате», «Параллельные и фоновые задачи», «Кодовая индексация», «Песочница и Computer Use», «Браузер». `01-settings-stage4-section.png` |
| 2 | Описания на текущем языке | **VERIFIED** | Кириллица в описании строки (локаль `ru-RU`). `02-settings-localized-description.png` |
| 3 | Переключатель реактивно меняет значение и пишется в `setting.json` | **VERIFIED** | `aria-checked` изменён, `chatAutocompleteSettings.enabled` в `~/.zcode/v2/setting.json` совпал. `03-settings-autocomplete-toggled.png` |
| 4 | Значение переживает перезагрузку renderer | **VERIFIED** | После `page.reload()` состояние то же. `04-settings-after-reload.png` |
| 5 | Поиск по настройкам находит новые опции | **BLOCKED (не применимо)** | В Desktop-сборке панель настроек не содержит глобального поля поиска (`input[type=search]` отсутствует в DOM) — продуктовая особенность, не дефект этой задачи. `05-settings-search.png` |
| 6 | `Enhance Prompt` disabled на пустом вводе / активна при тексте | **VERIFIED** | `disabled=true` → `disabled=false`. `06-enhance-button-state.png` |
| 7 | `Enhance Prompt` реально вызывает `PromptEnhancer` и применяет результат | **VERIFIED** | Состояние загрузки (`aria-busy`) + черновик изменён (32 → 812…1232 симв.). `07-enhance-result.png` |
| 8 | Undo/откат улучшения | **VERIFIED** | `Ctrl+Z` вернул исходные 32 симв. `08-enhance-undo.png` |
| 9 | `/enhance` в slash-панели | **VERIFIED** | Найден пункт «Улучшить промпт». `09-slash-enhance.png` |
| 10 | Ghost-text не появляется при `chatAutocompleteSettings.enabled=false` | **VERIFIED** | `chat-ghost-text` в DOM = 0. `10-ghost-disabled.png` |
| 11 | Ghost-text появляется с реальной моделью | **VERIFIED** | `data-ghost-source=model_stream`, длина 30…56 симв. `11-ghost-visible.png` |
| 12 | `Tab` принимает всю подсказку | **VERIFIED** | Ghost-нода исчезла, принятый текст в документе. `12-ghost-tab-accepted.png` |
| 13 | `Escape` скрывает подсказку без потери введённого | **VERIFIED** | Ghost-нода = 0, пользовательский текст идентичен до/после. `13-ghost-escape.png` |
| 14 | `ArrowRight` принимает слово | **VERIFIED** | Первое слово подсказки добавлено к введённому тексту. `14-ghost-arrow-right.png` |
| 15 | Принятый текст не попадает в сообщение до явного принятия | **VERIFIED** | Ghost-нода декоративная: `aria-hidden=true`, `pointer-events-none`, `getTextContent()`/`getMarkdown()` → `""`. `15-ghost-isolation.png` |
| 16 | Консоль renderer без необработанных ошибок | **VERIFIED** | 0 ошибок; внешний CORS к `zcode.z.ai` — 0 (после фикса CSP) |

Разделение источников по ghost-text: генерация шла **с реальной моделью** (`opencode-go-messages/minimax-m3`, `source=model_stream`). Детерминированный подмен не потребовался; регрессия reasoning-level зафиксирована unit-тестами, а не подменой сервиса в рантайме.

---

## 10. Найденные дефекты Этапа 6.1b и их состояние

### 10.1. Хардкод `reasoningLevel` ломал `Enhance Prompt` (FAILED → исправлено)

Симптом (лог Host, реальный прогон):

```
[prompt-enhancer] Prompt enhancement failed
  {"code":"model_failed","error":"Reasoning level is required for opencode-go-messages/minimax-m3"}
[zcode-host] [rpc:call] prompt-enhancer.enhance FAIL (61.2ms)
```

Причина: `resolveSelection` в `prompt-enhancer/service.ts` всегда подставлял `options: { reasoningLevel: "minimal" }`. Реестр провайдеров валидирует уровень строго (`reasoning-level-not-supported`), а `opencode-go-messages/minimax-m3` допускает только `disabled`.

Исправление: резолвер модели сообщает фактические `optionSpecs.reasoningLevel.values`; сервис выбирает низший доступный уровень (`pickLowestReasoningLevel`), а присланный клиентом уровень больше не перетирается. После фикса `prompt-enhancer.enhance` отвечает успехом, кнопка применяет результат и откатывается по `Ctrl+Z` (проверки 7–8 в §9).

### 10.2. Тот же класс дефекта в ghost-text (исправлено профилактически)

`chat-autocomplete/service.ts` жёстко отправлял `reasoningLevel: "none"`. Для моделей без `none` (например `disabled`/`high`/`max`) подсказка тихо не генерировалась бы. Логика приведена к общему виду (`pickCheapestReasoningLevel`), добавлен регрессионный тест.

### 10.3. Невалидный IPv6 host-source в CSP (исправлено)

`connect-src` содержал `ws://[::1]:5174`; Chromium пишет `contains an invalid source … It will be ignored` и игнорирует весь литерал. Литерал убран, HMR-адреса на `localhost`/`127.0.0.1` сохранены (их же перебирает `scripts/dev.mjs`). Консоль renderer стала чистой (§9, п.16).

### 10.4. `MessageChangeSummaryPanel` не смонтирован в UI (закрыто в Этапе 6.1c)

Факты на момент 6.1b:

- Реальная задача в живом renderer выполнила `MultiEdit` двух файлов; содержимое на диске изменилось (`ALPHA`, `BETA`), UI показал tool-блок правки и статистику `+21 / -12` на другом турне.
- `pnpm dep:refs --list-exports packages/ui/src/MessageChangeSummaryPanel.tsx` → экспорт есть, **потребителей 0**; `grep` по `packages/ui/src` и `packages/desktop/src` не находит импортов.
- В DOM живого renderer нет ни одного `data-testid^="chat-change-summary"` ни для одной из 7 задач истории.

Вывод на тот момент: компонент реактивной сводки диффов существует и типизирован, но не подключён к дереву V4-таймлайна.

**Текущее состояние: закрыто в Этапе 6.1c.** Легаси-компонент `MessageChangeSummaryPanel` оставлен как есть (он не входил в дерево V4), а вместо «монтажа старого компонента на глаз» реализована полноценная цепочка: `fileTransaction.updated` → UI-store → новая панель под tool-блоком. Место монтирования, разделение контуров доставки, изоляция и идемпотентность описаны в §12.

---

## 11. Результаты обязательных проверок (Этап 6.1b)

| Проверка | Результат |
|---|---|
| `pnpm typecheck` | 0 ошибок |
| `pnpm lint` | 0 ошибок, 346 warnings (как в базовой линии; 5 в CLI) |
| `pnpm architecture:check --changed` | `violations: 0`, `new: 0` (после регистрации двух path-exact исключений) |
| `pnpm --filter @zcode/desktop exec vitest run test/desktopAppVersionBootstrap.test.ts` | 5/5 passed |
| `pnpm exec vitest run packages/services/test/prompt-enhancer/promptEnhancerService.test.ts` | 18/18 passed |
| `pnpm exec vitest run packages/services/src/chat-autocomplete/contract.test.ts` | 3/3 passed |
| `verify-stage6-ui.mjs` | 16 проверок: 15 `VERIFIED`, 1 `BLOCKED` (поиск в настройках не применим) |

`git commit` не выполнялся.

---

## 12. Этап 6.1c — реактивная синхронизация диффов и фоновых файловых задач

Закрывает проверку №16 (§1) и дефект §10.4. Цель: довести `fileTransaction.updated`
от CLI до пользователя без заглушек, с честным разделением контуров доставки.

### 12.1. Корневые причины «панель не появляется» (обе подтверждены живым прогоном)

Найдены и устранены два независимых дефекта в CLI — без них UI-часть физически
не могла получить данные:

| № | Место | Симптом | Причина | Исправление |
|---|---|---|---|---|
| 1 | [`mapSessionEventType()`](apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper-projection.ts:657) | В renderer никогда не приходил тип `fileTransaction.updated` | `SessionEventType.FileTransactionUpdated` не имел ветки в `switch` и попадал в `default: return "session.updated"` — событие маскировалось под обновление сессии, `case "fileTransaction.updated"` в UI-проекции не срабатывал | Добавлена явная ветка `case SessionEventType.FileTransactionUpdated: return "fileTransaction.updated"` |
| 2 | [`createTransactionHooks()`](apps/zcode-cli/packages/core/src/tool/handlers/transaction-hooks.ts:108) | Панель появлялась, но показывала `+0 -0` и не могла открыть diff | `buildPatchProjections()` существовал и экспортировался, но emitter вызывался **без** `structuredPatches`/`lineStats`; в payload не было ни патча, ни счётчиков | Sink переведён на ленивые провайдеры `structuredPatches(event)`/`lineStats(event)`; хук передаёт `buildPatchProjections(event.files)` с кэшем на событие (`WeakMap`) |

Единственный источник правды остаётся тем же — `beforeContent`/`afterContent`
коммита транзакции; второй путь вычисления диффа не создавался.

Порядок событий (владелец факта — CLI, UI только отображает):

```text
FileTransactionManager.commit()
  → onTransactionEvent(event)
  → createTransactionHooks → buildPatchProjections(event.files)   [патч + ± по путям]
  → createFileTransactionEventEmitter → buildFileTransactionEventPayload({ deliveryKind })
       ├─ desktop-continuous      → compact:false + structuredPatch + before/afterContent
       └─ web-remote-replayable   → toCompactFileTransactionPayload(...) ≤ 2 КБ
  → SessionEvent(file_transaction_updated)
  → bootstrap mapSessionEventType → "fileTransaction.updated"
  → services file_transaction_update
  → UI IZCodeTaskService.onDynamicTaskEvent(deliveryKind)
  → useFileTransactionStream → fileTransactionStore (workspaceKey → sessionId → transactionId)
  → ToolFileTransactionSummary → FileTransactionSummaryPanel (под tool-блоком)
```

### 12.2. Где смонтирована панель и почему именно там

**Место:** [`ToolCallRowView.tsx`](packages/ui/src/v4/conversation-row-view/ToolCallRowView.tsx) —
непосредственно под tool-блоком, внутри `RowShell` той же строки.

**Почему:**

- Это существующий паттерн V4-таймлайна «инструмент → его результат»: панель стоит
  там, где пользователь ждёт подробностей конкретной правки, и не требует нового layout.
- Ключ выбора — `toolCallId` (fallback `turnId`). Один `MultiEdit` на N файлов даёт
  ровно **одну** панель: нет дублирования агрегатом турна.
- Task-level агрегат не добавлялся: в `ConversationTurnGroup` уже есть
  `ConversationFileSummaryPanel` (git-статус турна), второй агрегат дублировал бы смысл.

Новые файлы (6):

| Файл | Роль |
|---|---|
| [`lib/fileTransactionProjection.ts`](packages/ui/src/lib/fileTransactionProjection.ts) | Чистая модель: `FileTransactionView`, `buildUnifiedPatch()`, `shouldApplyFileTransactionUpdate()` |
| [`lib/fileTransactionWorkspaceScope.ts`](packages/ui/src/lib/fileTransactionWorkspaceScope.ts) | `resolveFileTransactionWorkspaceKey`, `shouldMirrorFileTransaction()` |
| [`store/fileTransactionStore.ts`](packages/ui/src/store/fileTransactionStore.ts) | Zustand: `workspaceKey → sessionId → transactionId → view` |
| [`hooks/useFileTransactionStream.ts`](packages/ui/src/hooks/useFileTransactionStream.ts) | Единственная точка записи в store (подписка на поток) |
| [`v4/FileTransactionSummaryPanel.tsx`](packages/ui/src/v4/FileTransactionSummaryPanel.tsx) | Презентационный компонент (Collapsible, пути, ±, статус, фоновые задачи) |
| [`v4/ToolFileTransactionSummary.tsx`](packages/ui/src/v4/ToolFileTransactionSummary.tsx) | Селектор среза store → одна панель для конкретного tool-блока |

### 12.3. Разделение `desktop-continuous` / `web-remote-replayable`

Разделение сделано на стороне владельца факта (CLI), UI лишь корректно отображает
обе формы — без ошибок и без «пустой» панели:

| Контур | `deliveryKind` | Payload | Поведение панели |
|---|---|---|---|
| Electron | `continuous` | `compact:false`, полный `structuredPatch`, `beforeContent`/`afterContent` | Показывает `+N/-M` из полей файла; клик по файлу собирает unified diff (`buildUnifiedPatch`) и открывает `CodeViewerSource` типа `patch` |
| Web / mobile | `replayable` | `compact:true`, сводка ≤ 2 КБ (`toCompactFileTransactionPayload`) | Показывает пути и `+N/-M` из компактной сводки; `unifiedPatch` не строится (`data-transaction-compact="true"`), клик по файлу не открывает diff — панель остаётся информативной, а не пустой |

Выбор контура в UI-подписке — по `workspaceRemoteSessionId`, а не по
`workspaceIdentity`: именно remote-сессия означает replayable-контур.

### 12.4. Изоляция по `workspaceKey`

Ключ — `workspaceIdentity?.trim() || workspacePath`, применён на двух уровнях:

1. **Фильтр кадра** в `useFileTransactionStream`: `shouldMirrorFileTransaction({ payloadWorkspaceKey, workspaceKey })`.
   Пустой ключ кадра трактуется как «не наш» — чужое событие не попадает в store.
2. **Раскладка в store**: `table[workspaceKey][sessionId][transactionId]`. Даже при
   совпадении `sessionId` в двух workspace записи не пересекаются.

Смешивание событий разных workspace/сессий исключено на обоих уровнях.

### 12.5. Идемпотентность и откат

- Единица сравнения — `revisionKey` (статус + timestamp + compact + отсортированные пути
  + состояние фоновых задач + `errorDetails`).
- `applyPayload()` возвращает `boolean`: при повторе того же кадра возвращает `false`
  **и не меняет ссылку `table`**, поэтому лишних ререндеров нет (поток идёт пачками).
- Терминальный статус не «оживает»: `shouldApplyFileTransactionUpdate()` не даёт
  позднему in-flight кадру перезаписать `committed`/`rolled_back`.
- `rolled_back` показывает явный индикатор «Изменения откачены» (`data-transaction-status="rolled_back"`).
- Сворачивание/разворачивание — `Collapsible` из существующего набора компонентов.

### 12.6. Фоновые файловые задачи и отмена

- Индикатор подключён к тем же событиям: `payload.backgroundTasks[]`
  (`queued|running|completed|failed|cancelled`) рендерится строками
  `chat-file-transaction-background-task-<taskId>` с `data-background-task-status`
  и локализованным текстом (`ru-RU`/`en-US`/`zh-CN`).
- **Отмены из панели нет — осознанно.** Отмена файловой транзакции в архитектуре 4.2
  это abort инструмента (`AbortSignal` → `taskRegistry.cancel`), а v4-команда
  `cancelBackgroundWork{workId}` адресует runtime-задачи (bash/agent/workflow), не
  файловые транзакции. Кнопка, меняющая только локальный флаг, была бы визуальной
  пустышкой; вместо неё индикатор честно показывает фактический статус.

### 12.7. Unit-тесты (jsdom/vitest, `packages/ui`)

[`packages/ui/test/fileTransactionPanel.test.tsx`](packages/ui/test/fileTransactionPanel.test.tsx) — **8/8 passed**:

| Тест | Что доказывает |
|---|---|
| committed | Панель появляется по событию `committed` с путями и счётчиками (`+24/-12`, `2 files changed`) |
| rolled_back | Явный индикатор «изменения откачены» |
| идемпотентность | Второй `applyPayload` того же `transactionId` → `false`, ссылка `table` не изменилась |
| чужой workspace | Кадр другого `workspaceKey` не попадает в store |
| компактная сводка (web) | Рендер без `structuredPatch` корректен, `unifiedPatch` не строится |
| полный патч (desktop) | `unifiedPatch` собирается, клик открывает `CodeViewerSource` типа `patch` |
| невалидный кадр | `safeParse`-отказ не бросает исключение, пустая панель не рендерится |
| невалидный `structuredPatch` | `buildUnifiedPatch` возвращает `undefined` вместо падения |

### 12.8. Живая проверка в Electron (CDP)

Скрипт [`verify-stage6-ui.mjs`](packages/desktop/scripts/verify-stage6-ui.mjs) расширен
флагом `--only=file-transaction`: реальный prompt через E2E-мост Lexical
(`__zcodeLexicalInputE2E.setText` — `keyboard.type` не обновляет editor state и оставлял
кнопку отправки disabled), клик по `v4-composer-send`, ожидание узла панели до 3 минут.

Результат последнего прогона (`VERIFIED=3 FAILED=0 PARTIAL=0`):

```text
[OK  ] file-transaction-panel-appears: панель=true, status=committed, compact=false,
       transactions=1; текст: Изменено файлов: 2 +2 -0
[OK  ] file-transaction-panel-live-only: после полного reload панели нет —
       live-поток не персистируется (контракт desktop-continuous)
[OK  ] renderer-console-clean: ошибок консоли без внешнего CORS: 0
```

Артефакты: `docs/architecture/evidence/stage6/ui/16-file-transaction-panel.png`,
`17-file-transaction-files.png`, `18-file-transaction-after-reload.png`,
`ui-file-transaction-verification.json`. Файлы `stage6c-alpha.txt`/`stage6c-beta.txt`
на диске действительно созданы — панель питается реальными событиями, не моком.

Оговорка про восстановление из истории: панель — производная live-потока
(`desktop-continuous`), поэтому после полного reload renderer её нет. Это
зафиксированный контракт, а не дефект; восстановление из истории потребовало бы
персиста транзакций в транскрипт — отдельная задача, в объём 6.1c не входила.

### 12.9. Проверки Этапа 6.1c

| Проверка | Результат |
|---|---|
| `pnpm exec vitest run packages/ui/test/fileTransactionPanel.test.tsx` | 8/8 passed |
| `pnpm --filter @zcode/core exec tsc --noEmit` | 0 ошибок |
| `pnpm --filter @zcode/cli build` | собрано (провайдеры `structuredPatches(event)`/`lineStats(event)` присутствуют в бандле) |
| `verify-stage6-ui.mjs --only=file-transaction` | 3 `VERIFIED`, 0 `FAILED` |
