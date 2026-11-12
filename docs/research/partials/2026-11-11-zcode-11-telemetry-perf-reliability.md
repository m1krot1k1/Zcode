# Z11 — Телеметрия, логирование, метрики/оценки, производительность и надёжность

Ветка: `dev`; коммит на момент исследования: `d10f0b69 Выпустить macOS Preview 3.17.102.`
Дата: 2026-11-11. Режим: evidence-first, read-only (единственный записанный файл — этот partial).

## 1. Scope and method

### 1.1 Вопрос и границы

Задача Z11 — карта телеметрии, логирования, метрик/оценок, производительности и надёжности ZCode по темам 19–21: конвейер событий продукта, схемы и идентификаторы, согласие/opt-out, очистка PII, батчинг, обработка ошибок доставки, эндпоинты и выключатели; логирование UI, сервисов, main-процесса и CLI (уровни, ротация, redaction, корреляция, объём, удержание); учёт токенов/cost, TTFT/латентность, метрики успеха, eval-харнессы, golden-тесты и дашборды; старт, память, большие репозитории, индексация, streaming, bundle, фоновые задачи, watcher'ы и стоимость запросов к БД; восстановление после сбоев, orphan-процессы, ретраи/идемпотентность, таймауты, деградация, атомарность, watchdog'и, утечки и backpressure; наблюдаемость отказов и диагностические артефакты; тесты/бенчмарки и их пробелы.

Границы: весь монорепозиторий, с фокусом на `packages/services` (телеметрия `/event/report`, usage-stats, code-intelligence, process-lifecycle), `packages/shared` (схемы, санитайзеры, env-константы, process-resource), `packages/ui` (logger, TTFT/ARMS-клиенты), `packages/desktop` (main/host/renderer-логгеры, ARMS, crash capture, process/resource telemetry, export logs), `apps/zcode-cli` (OTel-пакет, JSONL-логгер, event store, process manager, ретраи модели). Вне scope: бизнес-логика сессий/чатов (см. Z05/Z07), RPC-фреймворк (Z06), провайдеры моделей (Z08), web/desktop UI-функции (Z03/Z04).

### 1.2 Базовая линия (preflight)

Выполнено до чтения кода и повторено перед записью:

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

`CodeIndex status` → `state: ready`, `partial: false`, generation `1456`, 10 007 файлов / 26 791 чанк / 278 154 символа / 377 669 рёбер; embedding `perplexity/pplx-embed-v1-0.6b` — `available: true`, diagnostics пуст. Индекс использован для адресного поиска (`telemetry`, `logger`, `usage/cost`, `benchmark`); после этого все load-bearing факты перечитаны в исходниках (`nl -ba`, `sed -n`, `rg -n`), т.к. lexical-выдача по общим запросам шумная (например, поиск `logger ...` вернул десятки unrelated-файлов).

### 1.3 Метод и обозначения

1. Структура и владельцы поведения определены через `find`/`ls` по каталогам и `package.json` скрипты.
2. Каждый существенный тезис проверен чтением исходника или выводом команды. Ссылки даны как `path:startLine-endLine`.
3. Измерения объёма логов и памяти сделаны на локальном рантайме этого рабочего каталога (`~/.zcode/cli/log`, `~/.zcode/v2/logs`, `~/.zcode/cli/rollout`) — это **наблюдения одной машины**, не репрезентативная выборка пользователей.
4. Размеры бандла сняты с локального build-output `packages/desktop/out` (сборка от 2026-11-10); они могут не совпадать с релизным артефактом.
5. Никакие production-файлы не изменялись; фикстуры и `.agents/skills/zcode-large-task-fixture` не трогались.

Обозначения:

- **Observed (FACT)** — непосредственно прочитано в исходнике/доке или получено выполненной командой.
- **Inferred** — вывод из нескольких подтверждённых фактов, прямо не наблюдавшийся.
- **Unknown** — доступные источники не дают ответа.

### 1.4 Что именно считается «телеметрией» в ZCode

Наблюдаются **четыре независимых канала**, которые нельзя смешивать (это же зафиксировано в `docs/monitoring/performance-telemetry-catalog.md:1-30`):

| Канал | Транспорт | Владелец кода | Назначение |
| --- | --- | --- | --- |
| `/event/report` (product telemetry) | HTTP POST JSON | `packages/services/src/telemetry/telemetryCore.ts` + UI-обёртка `packages/ui/src/lib/appTelemetry.ts` | Продуктовые события (launch, daily active, send, completion, agent_step, плагины, онбординг) |
| ARMS RUM (main + renderer) | `@arms/rum-electron` `sendCustom`, IPC из renderer | `packages/desktop/src/main/appARMSBootstrap.ts`, `desktopStabilityTelemetry.ts`, `packages/ui/src/lib/uiPerfArmsTelemetry.ts` | Crash/ANR/ресурсы/сеть, UI-perf, стабильность |
| CLI Agent OTel | OTLP/HTTP protobuf (traces+metrics), GZIP | `apps/zcode-cli/packages/telemetry` | Логические вызовы модели, попытки, инструменты, TTFT, токены |
| Desktop local TTFT | OTLP metrics + traces, отдельный `service.name=zcode-local-ttft` | `packages/desktop/src/main/localTtftExporter.ts`, `packages/ui/src/v4/telemetry/localTtft*` | Поэтапный TTFT локальной отправки (экспериментальный, за флагом) |

Дополнительно существует **локальная диагностика**, не уходящая по сети: JSONL-логи CLI, текстовые логи Desktop, memory-diagnostics строки, `model-io` rollout, crash dumps, экспорт логов для поддержки.

## 2. Coverage table

Пункты соответствуют SPECIFIC SCOPE Z11 (1–8).

| # | Пункт scope | Что проверено | Статус | Основные доказательства |
| --- | --- | --- | --- | --- |
| 1 | Telemetry: pipeline, schema, IDs (`deviceMid`), consent/opt-out, PII, batching, failure, endpoints, off switch, product vs diagnostic, crash reporting | Полный путь UI → IPC → Core → HTTP; схемы Zod; deviceMid (3 реализации); retry/drain; build-time и env-выключатели; ARMS-канал; OTel CLI; crashReporter/native dumps | complete (с пробелами, см. §4) | `packages/ui/src/lib/appTelemetry.ts:36-68`; `packages/services/src/telemetry/telemetryCore.ts:21,38-41,152-166,226-273,312-334,356-509,511-542`; `packages/shared/src/env.ts:60-64`; `apps/zcode-cli/packages/telemetry/src/bootstrap.ts:75-137,198-221,414-416`; `packages/desktop/src/main/appARMSBootstrap.ts:163-167,204+` |
| 2 | Logging: UI/service/main/CLI, levels, rotation, redaction, correlation, debug gating, volume, disk, retention; AGENTS.md compliance | 4 логгера, их гейты, формат, ротация/удержание, redactor, объём на диске, нарушения правил AGENTS | complete | `packages/ui/src/logger.ts:13-112`; `packages/services/src/logger/serviceLogger.ts:18-65`; `packages/desktop/src/main/logger.ts:18-146`; `apps/zcode-cli/packages/adapters/src/logging/index.ts:124-230`; `.../serialize.ts:15-160`; `.../retention.ts:6-120`; `packages/desktop/src/main/logRetention.ts:4,60-98` |
| 3 | Metrics/evals: token/usage, TTFT, success, cost, eval harness, golden tests, benchmarks, regression detection, dashboards | `recordModelUsage`, `firstTokenAt`, hardcoded `cost: 0`, local TTFT конвейер и gate, OTel metrics, eval-gate, PRISM/delegation бенчмарки, 3 JSON-дашборда | complete (отсутствие quality-оценок зафиксировано) | `apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts:66-104`; `.../message-persistence.ts:337-338`; `.../turn-stop.ts:86,137`; `packages/desktop/src/main/localTtftExporter.ts:17-90`; `packages/shared/src/rendererActionTrace.ts:4-33`; `scripts/eval-results-gate.mjs:1-20`; `.zcode/evaluation-cases.json` |
| 4 | Performance: startup/cold start, first token, memory, large repos, index build, streaming, UI re-render, virtualization, bundle, background tasks, scheduler, watchers, DB cost | Задокументированные замеры старта, живой замер Host init, память по memory-diagnostics, caps сканера/индекса, coalescing/backpressure, bundle, watcher debounce, WAL/pragma | partial: старт/память/bundle измерены; large-repo и throughput — только по коду | `docs/desktop/startup-critical-path.md:8-13`; `~/.zcode/v2/logs/2026-11-11.log:26-88`; `docs/monitoring/memory-diagnostics-log.md:1-40`; `packages/services/src/code-intelligence/scanner.ts:75-77,468-499`; `docs/performance/streaming-tool-input-backpressure.md:1-30`; `packages/services/src/project-storage/startup.ts:48,74-75` |
| 5 | Reliability: crash recovery, orphans, restart/reconnect, retries/idempotency, timeouts, degradation, partial failures, corruption, storage atomicity, watchdogs, leaks, backpressure; сверка с `docs/analysis/memory-leak-audit-2026-09-03.md` | Process manager, quit barrier, crash budget supervisor, retry policies, атомарные записи, idle/first-token/tool таймауты, статус каждого high-risk пункта аудита | complete (аудит перепроверен по коду) | `packages/desktop/src/main/appShutdownPolicy.ts:14-24`; `packages/desktop/src/main/index.ts:1218-1252`; `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:1000-1035,1405-1428`; `packages/zcode-server-cli/src/supervisor/crashBudget.ts`; `apps/zcode-cli/packages/contracts/src/events/in-memory-session-event-store.ts:60-129`; `apps/zcode-cli/packages/contracts/src/events/session-event-retention.ts:9-121` |
| 6 | Observability of failures: taxonomy, user-visible errors, support bundle, log export, triage | `projectExecutionErrorPayload`, UI `chatErrorAttribution`, DB-startup copy diagnostics, export-logs, feedback archive, crash dumps | complete (SLO/триаж-ранбуки отсутствуют) | `apps/zcode-cli/packages/core/src/errors/error-payload.ts:53-113`; `packages/ui/src/lib/chatErrorAttribution.ts:1-80`; `packages/desktop/src/main/exportLogs.ts:151,608-645,963-1000`; `packages/desktop/src/main/desktopCrashCapture.ts:23-24` |
| 7 | Tests/benchmarks: perf, soak, leak, chaos; gaps | Инвентаризация 3 601 `*.test.ts` + 10 `*.test.tsx`; 575 E2E; 145 telemetry- и 235 logging-related тестов; единственный perf-тест под `ZCODE_PERF_REPRO=1`; memory e2e; fs-fault injection | complete (пробелы перечислены) | `find … -name '*.test.ts'` → 3 601; `apps/zcode-cli/packages/bootstrap/tests/compacted-full-history-cold-hydration.perf.test.ts:34`; `apps/zcode-cli/e2e/memory/README.md:1-35`; `docs/testing/e2e-fs-fault-injection.md:1-45` |
| 8 | Gaps/risks: cost controls, evals, leak-prone paths, noisy logs, SLO, crash reporting, startup regressions, unbounded queues | Сведены в §4; каждый пункт с Observed/Inferred и файлом | complete | §4, §7 |

### 2.1 Ключевые количественные срезы (Observed, локальная машина)

| Метрика | Значение | Источник |
| --- | --- | --- |
| CLI JSONL за 4 дня | 359.4 MiB (376 837 049 B), 4 файла (11-11 ещё дописывался) | `ls -la ~/.zcode/cli/log` |
| Худший день CLI | 2026-11-09: 245 510 строк / 164.0 MiB | подсчёт `python3` по файлу |
| 2026-11-11 (последний снимок, T2) | 72 413 строк / 64.7 MiB; p50 строки 868 B, p95 1 357 B, max 1 344 757 B (T1-снимок) | подсчёт `python3` |
| Строки > 100 KB | 2 (11-09, ~1.3 MiB) и 2 (11-11, ~2.6 MiB) | подсчёт `python3` |
| Строк на сессию (11-11) | 64 сессии, p50 1 055, p95 3 322, max 3 706 | подсчёт `python3` |
| Строк на trace (11-11) | 7 traceId, p50 626, max 70 519 | подсчёт `python3` |
| Desktop text-логи | 13.8 MB за 4 дня (4.26 + 4.36 + 3.37 + 1.84 MB) | `ls -la ~/.zcode/v2/logs` |
| CLI heap/RSS peak (memory_sample) | heap 888.1 MB / RSS 1 196.8 MB при 5 sessions, eventRows 225 698, eventTransientRetained 162 538 | `~/.zcode/cli/log/zcode-2026-11-11.jsonl` (09:44:59) |
| Desktop peak по ролям | utility_host 644 MB, main 203 MB, renderer 135.7 MB | `~/.zcode/v2/logs/2026-11-11.log` (`[memory]` строки) |
| Renderer assets без sourcemap | 45.7 MiB; крупнейшие: styles-*.js 6.6 MB, `duke_sheets_wasm` 4.1 MB, office xlsx chunk 2.1 MB | `find packages/desktop/out/renderer/assets … stat` |
| CLI bundle | `apps/zcode-cli/packages/cli/dist/zcode.cjs` 16.2 MB | `ls -la` |
| Тесты | 3 601 `*.test.ts`, 10 `*.test.tsx`; 575 E2E-файлов; 145 telemetry- и 235 logging-related тестовых файлов | `find`, `rg -l` |
| Мониторинг-доки / дашборды | 33 `.md`, 3 JSON-дашборда | `ls docs/monitoring`, `docs/monitoring/dashboards` |

## 3. Capability inventory

### 3.1 Конвейер продуктовой телеметрии (`/event/report`)

**Observed (FACT).** Путь события:

```text
UI (reportAppTelemetryEvent)
  -> sanitizeTelemetryEventDetail(...)            UI-side очистка копии
  -> logger.debug для agent_step/message_completion
  -> platform.reportTelemetryEvent(payload)       IPC
Desktop Main (ipcMain.handle ReportTelemetryEvent)
  -> rendererTelemetryEventPayloadSchema.safeParse
  -> TelemetryCore.reportEvent(...)
       -> loadUserId(), ensureTelemetryDeviceMid()
       -> sendReport(): повторный sanitize + сборка body + headers
       -> POST с 5s timeout, redirect:"error", до 2 попыток
```

Ключевые факты:

- UI-очистка выполняется **до** IPC и до локального debug-лога: `packages/ui/src/lib/appTelemetry.ts:50-63`. Это прямо зафиксировано как исправление в комментарии `:57-58`.
- Основной санитайзер (`packages/shared/src/telemetry.ts:216-241`) обрабатывает точечно: `error_msg → "[redacted]"` (`:181-183`), `skill_name → regex whitelist` (`:192-203`), `app_login_ck.login_url → hostname` (`:205-213`), а для plugin-событий — жёсткий whitelist измерений (`:63-79`). **Все остальные ключи и значения проходят без изменений.**
- Core повторяет очистку на границе сети: `packages/services/src/telemetry/telemetryCore.ts:440-444`.
- Схема IPC не ограничивает размеры `eventText` и `eventExtraDetail`: `packages/shared/src/validation.ts:517-527` (`z.record(z.string(), z.string())` без `.max`, `eventText: z.string().optional()`).
- Эндпоинт — константа сборки: `ZCODE_TELEMETRY_REPORT_ENDPOINT` (`packages/shared/src/env.ts:60-64`) из `__ZCODE_TELEMETRY_REPORT_ENDPOINT__`; при пустом значении `sendReport` выходит до сети (`telemetryCore.ts:419`).
- Batching отсутствует: каждое событие — отдельный `fetch`; «очередь» — только `Set<Promise>` незавершённых отправок для drain при выходе (`telemetryCore.ts:350,511-542`).
- Ретраи: максимум 2 попытки, 300 мс (сеть/408/5xx) или 1 000 мс (429); 4xx (кроме 408/429) не ретраится (`telemetryCore.ts:38-41,356-370,478-502`).
- Таймаут 5 с на попытку, `redirect: "error"` — запрет уводить запрос с identity-заголовками на другой хост (`telemetryCore.ts:38,384-404`).
- Финализатор: одна warn-строка без payload, с eventId/attempts/category/elapsed (`telemetryCore.ts:504-508`).
- Drain при выходе: `flushPendingReports({timeoutMs: 2_000})` параллельно в `prepareAppQuit` (`packages/desktop/src/main/index.ts:1223`).
- Авторизация: `loadAuthorization(userId)` читается **на каждую попытку**; ошибка чтения → анонимная отправка (`telemetryCore.ts:378-383`).
- `event_id` стабилен между попытками; для `session_create` — детерминированный UUIDv8 от `(userId, sessionId)` (`telemetryCore.ts:23-32,559-564`).
- Поле `mac_id` жёстко пустое (`telemetryCore.ts:451`), `marketing_params` — JSON-строка (`:452`).
- `event_text` уходит без санитайза вообще: `telemetryCore.ts:439`.

**Observed.** Продуктовые имена событий: 21 уникальное литеральное значение `elementName` в product-коде (подсчёт `rg -o` с исключением тестов/`e2e`), плюс динамические plugin-события из whitelist (`packages/shared/src/telemetry.ts:56-61`). Полный каталог полей — в `docs/monitoring/business-monitoring.md` и `docs/monitoring/performance-telemetry-catalog.md` (31 строка `perf_*`, 38 уникальных имён).

### 3.2 Идентификаторы (`deviceMid`) и состояние телеметрии

**Observed (FACT).** Три реализации, работающие с одним файлом `telemetry-state.json`:

| Реализация | Локация | Особенности |
| --- | --- | --- |
| Desktop main (sync) | `packages/desktop/src/main/desktopDeviceMid.ts:17-50` | `readFileSync`/`writeFileSync` + `renameSync`, атомарно; при любой ошибке возвращает in-memory UUID, не падает |
| Services core (async) | `packages/services/src/telemetry/telemetryCore.ts:126-138,152-166,226-334` | `telemetry-state.lock` (`open(...,"wx")`), stale-lock 5 мин с проверкой pid, кэш `Promise` per state-file |
| CLI adapter | `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts:34-158` | Свой lock (200 попыток × 10 мс), temp+rename, при timeout — просто читает файл без записи |
| CLI OTel bootstrap | `apps/zcode-cli/packages/telemetry/src/bootstrap.ts:223-296` | Свой lock (2 попытки), temp+rename, при занятом lock — возвращает `undefined` (анонимная телеметрия) |

**Observed.** Один и тот же `deviceMid` служит: (a) `device_mid` в `/event/report`, (b) `X-Device-Mid` в заголовках (`buildZCodeSourceHeadersFromContext`, `telemetryCore.ts:464-474`), (c) `installationId` в OTel resource (`bootstrap.ts:165`), (d) `device_mid` в ARMS (`packages/desktop/src/main/desktopDeviceMid.ts:14-16`). Идентичность между каналами согласована — это сильная сторона.

Состояние в файле: `lastDailyActiveDate`, `deviceMid`, `dailyActiveInFlight` (`telemetryCore.ts:85-92`). Запись `writeTelemetryState` — **прямой `writeFile` без temp+rename** (`telemetryCore.ts:162-166`), в отличие от CLI-адаптера (`cli-device-mid.ts:104-121`) и bootstrap (`bootstrap.ts:252-254`).

### 3.3 Consent / opt-out / выключатели

**Observed (FACT).**

| Канал | Условие включения | Условие выключения | Пользовательский переключатель |
| --- | --- | --- | --- |
| `/event/report` | Непустой build-define `ZCODE_TELEMETRY_REPORT_ENDPOINT` | Пустой define на этапе сборки | **Нет** |
| ARMS RUM | Непустой `ZCODE_ARMS_RUM_ENDPOINT`, `enable: ZCODE_ARMS_RUM_ENDPOINT !== ""` (`appARMSBootstrap.ts:163-167`) | Пустой define | **Нет** |
| CLI OTel | Есть `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/`OTEL_EXPORTER_OTLP_ENDPOINT` **и** `ZCODE_MODEL_TELEMETRY_ENABLED` не в `0/false/off/disabled` (`bootstrap.ts:124,414-416`) | env-переменная | Только env (диагностический surface) |
| Desktop local TTFT | `rendererActionTrace.localTtftEnabled` из server config, по умолчанию false (`packages/shared/src/rendererActionTrace.ts:21`) | Флаг конфига; локально `ZCODE_LOCAL_TTFT_ENABLED=1` (`rendererActionTraceIpc.ts:123`) | Нет UI-тумблера; rollout через `/api/v1/client/configs` |

Repo-wide поиск `telemetryEnabled|telemetryOptOut|disableTelemetry|DO_NOT_TRACK|sendUsageData|analyticsEnabled` по `packages/*/src` и `apps/zcode-cli/packages/*/src` дал **0 совпадений** (команда выполнена, exit 0, пустой вывод). Это согласуется с более ранним выводом в `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/part-d-models-telemetry-reliability.md:57,307-308`.

**Inferred.** Модель согласия — «build-time opt-in»: публичная сборка без приватного `build-defaults.json` вообще не отправляет события (`docs/desktop/build-time-optional-capabilities.md:1-40`). Для正式-сборки с включёнными эндпоинтами пользовательского opt-out нет.

### 3.4 Канал ARMS (main + renderer)

**Observed.** `armsRum.init` с `enable` по наличию build-эндпоинта, `autoInject: true` (`appARMSBootstrap.ts:163-170`). Единая точка очистки всего батча — `beforeReport` (`:204+`):

- `packages/desktop/src/main/armsEventRedaction.ts:1-100+` — click-name усекается до тега (текст элемента удаляется), `snapshots` удаляются, exception `message` ≤2 000 символов и `stack` ≤4 000, URL-поля очищаются, resource/api события редактируются;
- native dump события (`type=crash, source=crashReporter`) **исключены** из этой очистки, потому что `filterAndEnrichNativeCrashEvents` опирается на `binary_images` (`armsEventRedaction.ts:38-42`);
- стабильность: schema v2, ANR ≥5 s, freeze ≥30 s, crash-классификация scope/cause, дедуп exception до 1 024 (`desktopStabilityTelemetry.ts:17-40`);
- renderer UI-perf: `perf_ui_launch_to_input` с 6 стадиями, sanity-отсев >300 000 мс, `perf_ui_first_token`, `perf_ui_stream_stall` с порогом 3 000 мс (`packages/ui/src/lib/uiPerfArmsTelemetry.ts:11-31,116-133,332`);
- отправка UI-perf идёт через `reportArmsCustomEvent` и не блокирует UI (`uiPerfArmsTelemetry.ts:70-86`).

**Observed.** `crashReporter.start` включается в `desktopCrashCapture.ts:361-381`; архивы crash dump ограничены 5 файлами / 100 MiB (`:23-24`), с prune при старте (`:275-288`).

### 3.5 CLI Agent OTel

**Observed (FACT).**

- Owner один на процесс: `AgentTelemetryRuntimeOwner` (`otlp-exporter.ts:53-156`), Session только «одалживает» (`bootstrap.ts:39-64`).
- BatchSpanProcessor: queue 2 000, batch 100, delay 5 s, export timeout 3 s (`otlp-exporter.ts:63-68`).
- Metric reader: интервал 300 000 мс, DELTA temporality (`:31,77-90`), cardinality limit 250 на view (`:191-207`).
- Trace sampling: root 10%, `ParentBasedSampler` (`:32,158-162`).
- Disabled-путь не импортирует OTel SDK вообще (`bootstrap.ts:124-137` + комментарий `otlp-exporter.ts:49-52`).
- Активные writer'ы ограничены 5 000, при переполнении — counter `creation_drop` и однократный warning (`agent-trace-runtime.ts:117,581-599`).
- Метрики: 8 histogram'ов длительностей (turn/step/tool/command/compaction/detached/model call/attempt), TTFT (first provider event / first content / first text), stream stalls, tokens по типам, attempts (`agent-metrics.ts:56-95`).
- Явный контроль стоимости: тест `otlp-cost-controls.test.ts:16-80` фиксирует 5-минутный интервал, 10% сэмплинг, отсутствие min/max и ≤10 buckets.
- Ошибки экспорта **не наблюдаются**: в `otlp-exporter.ts` нет `onError`/diag logger'а; `forceFlush`/`shutdown` обёрнуты в `withTimeout`, но результат не логируется (`:131-155,280-292`).

### 3.6 Метрики, cost и оценки

**Observed.**

- Токены: `recordModelUsage` пишет `firstTokenAt`, `durationMs`, `timeToFirstTokenMs` в usage-store (`usage-observability.ts:66-104`); `tokens` сохраняются в сообщении (`message-persistence.ts:338`).
- `cost` жёстко `0` в production-путях: `message-persistence.ts:337`, `turn-stop.ts:86,137`, `turn-step-finish.ts:29`, `timeline-persistence.ts:130`, `session-fork.ts:475`. Контракт объявляет `cost: number` (`session-store.port.ts:413`), а сериализация протокола отдаёт `cost: null` (`session-mapper.ts:728,761,779`). Это подтверждает вывод Z07 (`2026-11-11-zcode-cli-runtime-agent-loop.md:203,294-296`).
- UI показывает «Total cost» из сторонней библиотеки `tokenlens.getUsage(...)` (`packages/ui/src/components/ai-elements/context.tsx:224-236`), то есть считает по прайс-листу библиотеки, а не по фактическому биллингу и не по persisted `cost`.
- `/event/report` `message_completion` исторически нёс `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_input_tokens`, `total_tokens`, `time_to_first_token`, `duration_ms` (`docs/monitoring/business-monitoring.md:40-70`); документ сам помечает V4-проекцию как «не подключена» в верхней врезке (`:1-8`), а затем уточняет, что supervisor уже подключён (`2026-09-11 Todo129` врезка).
- Успех/качество: run-success метрики на уровне продукта не найдены. Есть только OTel `outcome`-labels на span'ах и `perf_agent_crash`/`perf_mcp_process_crash`.
- Eval-харнесс: `scripts/eval-results-gate.mjs` — fail-closed проверка, что для каждого case из `.zcode/evaluation-cases.json` есть pass-строка в `.zcode/eval-results.jsonl` на текущем HEAD. Файл результатов отсутствует; запуск гейта дал `FAIL (1 problem) — .zcode/eval-results.jsonl is missing`. В каталоге 3 кейса (`E-START-GW`, `E-NEST-DEPTH`, `E-PROXY-FALLBACK`).
- Бенчмарки: PRISM gate (`scripts/prism10-experiment-gate.mjs`) с `MAX_COST_RATIO = 1.25`, `MAX_LATENCY_RATIO = 1.3`, минимум 20 кейсов и 2 trial'а, знаковый тест; delegation routing benchmark (`scripts/delegation-routing-benchmark.mjs` + тесты) с полями `success/durationMs/tokens/duplicateClaims/criticalRegressions`.
- Дашборды: `docs/monitoring/dashboards/local-ttft.json` (Grafana-совместимый, 18 KB), `process-resource-dashboard.json` (387 KB), `process-resource-queries.json` (145 KB). Дашборда для `/event/report` или для OTel CLI в репозитории нет.

### 3.7 Логирование

**Observed (FACT).** Четыре независимых логгера:

| Слой | Файл | Формат | Уровни | Гейт |
| --- | --- | --- | --- | --- |
| UI/renderer | `packages/ui/src/logger.ts:33-91` | console + bridge `window.zcode.log` | debug/info/warn/error/trace/lifecycle | В production-сборке всё `no-op` (`:40-49`); `lifecycle.*` всё равно идёт через bridge (`:62-75`); `logMemoryDiagnostics` — исключение (`:98-112`) |
| services | `packages/services/src/logger/serviceLogger.ts:18-65` | console через sink | debug/info/warn/error | `debug` только при dev (`:41-43`) |
| desktop main | `packages/desktop/src/main/logger.ts:73-133` | `[ts] [level] [pid] [source] msg` → `YYYY-MM-DD.log` | debug/info/warn/error + `fromRenderer` | `debug` только при `NODE_ENV !== "production"` (`:122-126`) |
| CLI | `apps/zcode-cli/packages/adapters/src/logging/index.ts:95-230` | JSONL `zcode-YYYY-MM-DD.jsonl` | LogLevel 0..3, default Info / Debug в dev (`:226-240`) | `minLevel` через API; `ZCODE_LOG_LEVEL` намеренно игнорируется |

Дополнительно: `packages/client/src/logger.ts:1-30` — тот же production-гейт, что в UI; `rendererLoggingEnv.ts` — общий признак production-build.

**Redaction:**

- CLI: `DefaultLogRedactor` (`serialize.ts:15-45`) рекурсивно заменяет значения по regex ключа `api[-_]?key|authorization|cookie|credential|password|secret|token`, глубина ≤8, циклы → `[Redacted:Circular]`. Ошибки сериализуются с cause-цепочкой до глубины 8 (`:111-160`).
- Desktop main: **redaction отсутствует**. `logger.ts:77` делает `JSON.stringify(a)` для не-строк и пишет как есть; очистка выполняется только на этапе экспорта (`exportLogs.ts:252-278,608-645`).
- services: redaction отсутствует, sink = console.
- UI: redaction отсутствует; полагается на санитайзер на входе телеметрии.

**Ротация/удержание:**

| Слой | Удержание | Ограничение размера файла |
| --- | --- | --- |
| Desktop main | 14 дней, только файлы `YYYY-MM-DD.log`, `readdirSync`+`unlinkSync` при старте (`logRetention.ts:4,60-98`) | **Нет** |
| CLI | 7 дней, только `zcode-YYYY-MM-DD.jsonl`, async cleanup через 60 s после старта (`retention.ts:6-15,97-120`) | **Нет** |
| model-io rollout | 3 файла, 64 MiB на файл (dev: 256 MiB) (`runner-debug.ts:35-42`) | Да |
| crash dumps | 5 файлов / 100 MiB (`desktopCrashCapture.ts:23-24`) | Да |
| feedback/export archive | lookback 3 дня (`exportLogs.ts:151`) | Нет, но zip потоковый |

**Корреляция.** CLI JSONL содержит `traceId/spanId/parentSpanId/sessionId/turnId/toolCallId` (`logging/index.ts:143-165`); `StartupTimer` добавляет `durationMs` и `context.totalDurationMs` по монотонным часам (`bootstrap/src/startup-logging.ts:10-70`). Desktop main-логгер correlation ID не поддерживает — только `pid`/`source`.

### 3.8 Производительность

**Observed (FACT).**

- Старт: документированный baseline — Host `initializing local services → local services ready` 2.081 s median, «ввод доступен» ≈5.3 s, React first commit 24 ms, 146 RPC в первую секунду (`docs/desktop/startup-critical-path.md:8-13`). Живой замер этого каталога: `08:56:58.394 → 08:56:58.413` = **19 ms** (тёплый старт, `~/.zcode/v2/logs/2026-11-11.log:26,88`) — цифры несопоставимы по условиям, прямой регрессии не доказывают.
- CLI startup (тёплый, protocol entrypoint): `zcode_protocol.startup.completed` 60 ms; `bootstrap.app.startup.completed` — 4 запуска подряд 94 / 94 / 108 / 125 ms (`~/.zcode/cli/log/zcode-2026-11-11.jsonl`).
- Память: memory-diagnostics покрывает main/utility_host/renderer/agent_node с гейтом «5% heap / 10% rss / 300 s heartbeat» (`docs/monitoring/memory-diagnostics-log.md:1-40`); живые сэмплы подтверждают работу счётчиков (`eventRows`, `eventEvicted`, `v4.detachedLive` и др.).
- Event store: реализован `turn-window` retention — `push` вместо копирования, счётчик seq отдельно, eviction транзиентных событий с лагом в один turn, grace 120 s, «худение» `model_request` до `messageCount` (`in-memory-session-event-store.ts:60-129`; `session-event-retention.ts:9-121`).
- Code index: `MAX_SOURCE_BYTES = 1 MiB`, `MAX_SOURCE_FILES = 20 000`, `MAX_CHUNK_LINES = 120` (`scanner.ts:75-77`), при превышении — остановка с сообщением (`:543`); watcher — один рекурсивный `fs.watch` вместо chokidar из-за EMFILE (`workspaceWatcher.ts:76-92`), debounce 300 ms; file-watcher service — debounce 150 ms (`fileWatcherService.ts:10`).
- Streaming: задокументированный O(n²)-хотспот закрыт — превью `Write/Edit` ограничено 1 000 мс, фон не пишет в message store, дедуп `tool_input` (`docs/performance/streaming-tool-input-backpressure.md:1-30`); фоновые сессии переходят в tombstone-режим (`docs/performance/background-session-event-coalescing.md:1-40`).
- БД: `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout` 25 ms на старте (`project-storage/startup.ts:48,74-75`); CLI session DB — WAL + `busy_timeout` (`migration-runner.ts:86,89,141`); code-intelligence — WAL + 5 000 ms (`database.ts:223-224`).
- Bundle: см. §2.1. Renderer содержит крупный `styles-*.js` 6.6 MB (uncompressed build-output) и WASM-чанки для Office-превью.
- Ресурсная телеметрия: sample 10 s, окно отчёта 300 s (prod) / 60 s (dev/E2E) (`desktopResourceTelemetry.ts:55-70`), CLI-сэмпл 60 s (`processResourceTelemetry.ts:29`), «чистая память, без очередей и ретраев» (`processResourceWindowAggregator.ts:5`).

### 3.9 Надёжность

**Observed (FACT).**

- Процессы агента: `detached` process group на POSIX, `taskkill /T` на Windows (`zcodeAgentProcessManager.ts:1033-1035`); generation-guard от гонки spawn/restart (`:1000-1021,1405-1428`); `disposeAllAndWait` реентерабелен.
- Выход приложения: `prepareAppQuit` — общий барьер, параллельно: telemetry drain 2 s, local TTFT shutdown, renderer trace shutdown, cron dispose, remote sessions, host dispose с `forceKillDelayMs` 7 500 / wait 9 000 (Windows normal 4 000/4 500) (`index.ts:1218-1252`; `appShutdownPolicy.ts:14-24`).
- Supervisor (`packages/zcode-server-cli`): crash backoff 1/2/4/8/16 s, окно 5 мин, остановка после 5-го падения (`supervisor/crashBudget.ts`, тест `crashBudget.test.ts:4-20`).
- Ретраи модели: `retry-after` из заголовков приоритетнее локального backoff (`runner-retry.ts:45-53,92-108`); stream idle 600 s, first-token 90 s (`contracts/src/config/index.ts:287-300`); tool default deadline 300 s (`tool/executor/impl.ts:43`); конкурентность инструментов по умолчанию 10 (`tool/scheduler.ts:48`).
- Атомарность: workspace `atomicWrite` temp+rename+fsync-fallback (`adapters/src/fs/index.ts:700-737`); `cli-device-mid` temp+rename; `bootstrap` deviceMid temp+rename. `TelemetryCore.writeTelemetryState` — **не** атомарен (`telemetryCore.ts:162-166`).
- Утечки/ограничения (см. §4 и §7): `streamBatches` удаляется только при terminal-событии (`taskRealtimeBus.ts:520-522,544-546`), `releaseLease`/`releaseLeasesForHost` только flush'ат (`:366-397`).
- Fault injection: `ZCODE_E2E_FS_FAULTS` покрывает ENOSPC/EACCES/повреждённые снапшоты, включая CLI log sink и desktop main log sink (`docs/testing/e2e-fs-fault-injection.md:1-45`).
- Таймауты/деградация: телеметрия — «побочный канал»: ошибки marketing attribution один раз warn'ятся и не блокируют событие (`telemetryCore.ts:421-431`); ARMS init падения не блокируют окно (комментарий `appARMSBootstrap.ts:151`); resource telemetry — «pure memory, bounded, no queue, no retry».

### 3.10 Наблюдаемость отказов

**Observed.**

- Таксономия ошибок ядра: `projectExecutionErrorPayload` собирает `code/message/detail/underlyingErrorMessage/underlyingErrorDetail/attribution` (provider/model/statusCode/transport/retryable/source/reason) (`core/src/errors/error-payload.ts:53-113`).
- UI-атрибуция: `chatErrorAttribution.ts:1-80+` — таблица стабильных кодов (`model_config_missing`, `ERR_SQLITE_ERROR`, `StreamRecoveryDiscarded`, media-budget коды) + regex-фолбэки для rate limit/balance/context/auth/network/timeout/overload.
- `turn.failed` пишет полный cause-chain (`turn-errors.ts:326-334`) — но без ограничения объёма (см. §4.1).
- DB-startup имеет отдельный error-code классификатор (`packages/shared/src/database-startup.ts:20+`) и пользовательскую страницу с «копировать диагностику» (`packages/ui/src/i18n/locales/zh-CN.ts:396-425`).
- Support bundle: `exportLogs` собирает `~/.zcode/v2/logs`, `~/.zcode/cli/log`, `config.json`, `rollout/`, CUA `.exit.log`, чистит секреты потоково (`exportLogs.ts:963-1000,1046-1058`), zip с ограничением skipped-files и staging (`:1080-1110`). Feedback использует `prepareCompactLogArchive` (`packages/services/src/feedback/compactLogArchive.ts`).
- SLO/SLA/error budget в репозитории не определены: поиск `\bSLO\b|\bSLA\b|error budget` по `docs/**.md` даёт только упоминания «SLO» в telemetry-спеках как повод для гистограммных buckets, без численных целей.

## 4. Gaps, risks, weaknesses

Ниже — только подтверждённые или явно помеченные выводы. Для каждого пункта указан уровень доказанности.

### 4.1 P0-риск: полный request body попадает в CLI JSONL и в поддержку (Observed + воспроизведено)

**Факт.** В `~/.zcode/cli/log/zcode-2026-11-11.jsonl` есть 2 строки >1 MB; крупнейшая — `turn.failed` длиной 1 344 757 B. Разбор структуры:

```text
error.name/message/code/type = 5/21/13/13 chars
error.context = {"errorPayloadRole": "wrapper"}
error.cause.context.responseBodySummary.error.requestBodyValues =
    { model, input: [670 items], max_output_tokens, tools: [18 items], tool_choice, stream }
```

То есть в лог целиком попал **prompt со всей историей сообщений и полными определениями инструментов** (в sample виден системный промпт и текст пользовательских сообщений). Строка `turn.failed` формируется в `apps/zcode-cli/packages/core/src/runtime/helpers/turn-errors.ts:326-334` — `runtime.logger?.error(..., coreError, {...})` без усечения; `serializeLogError` не ограничивает размер `context` (`apps/zcode-cli/packages/adapters/src/logging/serialize.ts:111-160`), а `DefaultLogRedactor` заменяет только значения по имени ключа (`:16-45`), поэтому `input`/`tools` проходят.

**Источник данных (Inferred по форме payload'а).** Наблюдаемый `responseBodySummary` содержит полный `requestBodyValues` — такую форму даёт `apps/zcode-cli/packages/adapters/src/model/provider-finish-business-error.ts:99-118`, где `candidates.find(hasBusinessSignal)` возвращает **исходный record целиком** (не summary), а `hasBusinessSignal` (`:224-230`) срабатывает на любом `message`. Другие конструкторы (`failure-ai-sdk-provider-error.ts:69-90`, `model-execution.ts:1098-1104`) оставляют только scalars и `keys`. Далее `runner-retry.ts:270-281` кладёт значение в `context`, а `toAdapterError` (`:127`) — в нормализованный контекст ошибки. Runtime-трассировка конкретной строки не выполнялась, поэтому цепочка помечена как Inferred; сам факт наличия полного `input`/`tools` в логе — Observed.

**Масштаб.** За 4 дня: 4 строки >100 KB, суммарно ~3.9 MiB; 2 из них — именно этот путь. На 11-11 это 2 строки из 72 413 (0.003%) и 2.6 MiB из 64.7 MiB (4%). На 11-09 — 1.3 MiB из 164 MiB.

**Почему это важно.** Это одновременно (a) утечка приватного содержимого в локальный лог, который целиком уходит в support bundle (`exportLogs.ts:963-1000` включает `~/.zcode/cli/log`), и (b) риск раздувания логов и памяти при сериализации. Экспортная очистка (`exportLogs.ts:157-205`) ловит ключи `password/token/auth/...`, но не `input`/`tools`/`model` — то есть **не** остановит эту утечку при отправке в поддержку.

### 4.2 P0-риск: `event_text` и произвольные `eventExtraDetail` уходят без очистки (Observed)

`telemetryCore.ts:439` отправляет `event_text: payload.eventText ?? ""` без санитайзера; `packages/ui/src/lib/promptTemplateTelemetry.ts:19-25` кладёт в `eventExtraDetail.template_prompt` **полный текст шаблона**, а `sanitizeTelemetryEventDetail` для не-plugin событий пропускает всё, кроме `error_msg`/`skill_name`/`login_url` (`packages/shared/src/telemetry.ts:222-240`). Тест `packages/ui/test/promptTemplateTelemetry.test.ts:19-26` подтверждает, что `template_prompt` уходит как есть. Схема IPC не ограничивает ни длину, ни число ключей (`packages/shared/src/validation.ts:517-527`).

**Inferred.** Это осознанное решение для шаблонов подсказок (текст шаблона — продуктовый контент), но оно контрастирует с заявленной политикой `docs/monitoring/event-report-privacy.md:5-20` («логин-URL и `error_msg`»), которая покрывает только эти два поля.

### 4.3 P1: нет пользовательского opt-out телеметрии (Observed)

См. §3.3: repo-wide поиск не нашёл ни настройки, ни `DO_NOT_TRACK`, ни consent-шага онбординга (в `packages/ui/src/onboarding/*` нет privacy/telemetry шага). Выключение возможно только на этапе сборки или через env. Для сравнения: в `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/part-d-models-telemetry-reliability.md:57` тот же вывод уже зафиксирован.

**Риск.** Юридический/продуктовый: пользователь не может отказаться от `/event/report` в正式-сборке; нет журнала согласия.

### 4.4 P1: объём и стоимость CLI-логов (Observed)

- 359.4 MiB за 4 дня при удержании 7 дней → ожидаемый потолок ~600–650 MiB на пользователя только в `~/.zcode/cli/log` (экстраполяция по текущему темпу; **Inferred**); лимита на размер файла нет (`retention.ts:97-120` удаляет по дате, не по размеру).
- Топ событий 11-11 (парсинг снимка файла на момент T1: 68 177 строк; файл продолжал расти): `model.request.completed` 9 636, `session.event.persistence.started/completed` по 9 389, `tool.call.started` 8 941, `tool.call.completed` 8 873, `model.request.started` 4 581, `model.network.completed` 4 550, `model.sdk.stream.completed` 4 549 — всё `info`. При этом `apps/zcode-cli/docs/design/v2/logging.md:163-180` требует «default log = index, not payload».
- 2026-11-09: `mcp.server.failed` 11 534 записи, из них 7 900 `Connection closed` и 2 048 `Version negotiation failed` на одном workspace — то есть повторяющийся сбой MCP пишет warn на каждую попытку без throttling/дедупа (`apps/zcode-cli/packages/adapters/src/mcp/index.ts:1892-1905`).
- `turn.phase.started/completed` — `info` на каждую фазу (`core/src/runtime/methods/turn.ts:250-271`), 19 026 + 18 932 записей за 11-09.
- Итог: доля `session.event.persistence.*` — 33.6 MiB из 164 MiB (20%); `turn.phase.*` — 22.7 MiB (14%); `mcp.server.failed` — 10.0 MiB (6%). «Шумные» info-события доминируют.

### 4.5 P1: Desktop main-логгер не редактирует секреты и пишет синхронно (Observed)

- `packages/desktop/src/main/logger.ts:73-91`: `JSON.stringify` произвольных аргументов + `appendFileSync` на каждый вызов в главном процессе Electron; redaction нет.
- `package/desktop/src/main/logger.ts:122-126`: `debug` гейтится `NODE_ENV !== "production"`, но `info/warn/error` — всегда.
- Ротация только по дате (14 дней), без лимита размера (`logRetention.ts:4,60-98`).
- Для сравнения CLI-логгер имеет redactor и JSONL (`logging/serialize.ts:15-45`), а main — plain text с `JSON.stringify` — то есть при случайном логировании объекта с токеном он окажется в файле, который затем экспортируется (экспорт потом чистит по ключам, но не по свободному тексту).

### 4.6 P1: телеметрия не имеет SLO и не измеряет собственные потери (Observed)

- Нет счётчиков «отправлено/успешно/потеряно» для `/event/report`: `flushPendingReports` только warn'ит `pending=N` при таймауте (`telemetryCore.ts:539-541`); при отказе создания/сети warn не агрегируется в метрику.
- Для OTel CLI ошибки экспортёра не наблюдаются: нет diag logger (`otlp-exporter.ts` — весь файл), `forceFlush` результат отбрасывается.
- Дашбордов по `/event/report` и по OTel CLI в `docs/monitoring/dashboards` нет (только local-ttft и process-resource).
- `docs/monitoring/event-report-delivery-reliability.md:75-79` задаёт продуктовую цель «87.6% → ≥95%», но это цель, а не измеряемый в коде показатель; раздел «проверка» — ручной анализ в течение трёх дней.

### 4.7 P1: локальные TTFT и renderer trace фактически выключены по умолчанию (Observed)

- `rendererActionTrace` default: `enabled: false`, `sampleRatio: 0` (`packages/shared/src/rendererActionTrace.ts:29-33`); `localTtftEnabled` — opt-in (`:21`).
- Rollout чеклист признаёт: «этап 1 (packaging) и этап 2 (灰度) не выполнены» (`docs/monitoring/local-ttft-rollout-checklist.md:1-20,60-80`), retention/cost не проверены (`:80-95`).
- Оба TTFT E2E-теста лежат в `manual-review/pending` (`packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-ttft-stages.test.ts`, `...-ttft-diagnostics.test.ts`) — то есть не входят в автоматический прогон по умолчанию.

### 4.8 P1: cost accounting фактически отсутствует, а UI показывает расчёт сторонней библиотеки (Observed)

`cost: 0` в 5 production-путях, `cost: null` в протоколе, при этом `context.tsx:224-236` считает «Total cost» по `tokenlens` и выводит пользователю. Это создаёт **несогласованность источников истины**: сохранённая запись говорит `0`, UI показывает ненулевое значение, а биллинг Coding Plan не учитывается вовсе.

### 4.9 P1: в аудите утечек часть высоких пунктов закрыта, часть — нет (Observed, перепроверено по коду)

| Аудит-пункт (`docs/analysis/memory-leak-audit-2026-09-03.md`) | Состояние в текущем коде | Доказательство |
| --- | --- | --- |
| CLI-H1: event store хранит всё, `[...events]` копирование | **Исправлено**: `push`, `turn-window`, `slimRetainedModelRequest` | `in-memory-session-event-store.ts:60-129`; `session-event-retention.ts:26-121`; тесты `session-event-retention.test.ts`, `session-event-store-retention.protocol.test.ts` |
| CLI-H2: publisher суб-агента не освобождается | **Исправлено частично**: `pruneDetachedChildPublishers` с grace 120 s и вызовом из 60-секундного sampler'а | `v4-gateway.ts:1142-1187`; `server.ts:362-364`; `resource-sampler.ts:36`; тест `v4-cold-resume.test.ts:2092` |
| UI-H1: `shiki tokensCache` без эвикции | **Не исправлено**: `tokensCache.set` есть, `delete/clear/лимита` нет | `packages/ui/src/lib/shikiHighlighter.ts:60-67,176`; комментарий `:62-63` прямо называет это «самым подозрительным ростом» |
| UI-H2: in-memory snapshot cache без лимита | **Не исправлено**: лимиты `SNAPSHOT_CACHE_MAX_*` применяются только к persisted-кэшу (`prunePersistedSnapshotCache`), а in-memory `snapshotCache` очищается только при пустом snapshot | `useZCodeTaskService.ts:21-23,79-95,199-213,273-275` |
| MAIN-H1: `will-download` на defaultSession | **Исправлено**: cleanup вызывается только при живом guest, `session` берётся из guest, `downloadCleanup` очищается в `finally`; при разрушенном guest listener умирает вместе с объектом (комментарий-обоснование) | `browserGuestManager.ts:3361-3391,4228-4247` |
| MAIN-H2: `TaskRealtimeBus.streamBatches` не удаляются без terminal | **Не исправлено**: удаление только в двух ветках при `event.terminal`; `releaseLease`/`releaseLeasesForHost`/`unregisterHost` только flush'ат | `taskRealtimeBus.ts:366-397,520-522,544-546` |
| SVC-H1: bots per-task состояние | **Не исправлено**: освобождение только по terminal-событиям (`:5752,5802,7173,8031,9580`) и `disposeAll` (`:9825-9828`); подписки — только `delete` в тех же точках | `packages/services/src/bots/botsService.ts:760-812` |
| SRV-H1: web server `remoteConnections` | **Исправлено иначе**: старый `/api/connect-remote` удалён, теперь `/ws/remote` использует `connectionScope.dispose()` на `socket.onClose` | `packages/server/src/http.ts:134-139,468-470` |
| Структурный корень A: RPC disconnect не освобождает pty/watcher | **Не исправлено**: `IPCServer` фаерит `onDidRemoveConnection` (`packages/rpc/src/ipc.ts:141`), но **ни один** файл в `packages/services/src`, `packages/desktop/src`, `packages/web/src`, `packages/server/src` не подписан на него (repo-wide `rg` дал 0 совпадений) | `packages/rpc/src/ipc.ts:59-64,130-143`; `terminalService.ts:486-493` только `disposeAll` |

**Inferred.** Пункты 1–2, 5, 8 из аудита закрыты; UI-кэши и структурный корень A остаются. Это подтверждает, что memory-diagnostics счётчики (`shiki.tokensCache`, `taskSnapshotCache.entries`, `terminal.open`, `fileWatcher.open`) появились именно для наблюдения за незакрытыми утечками (`docs/monitoring/memory-diagnostics-log.md:40-60`).

### 4.10 P2: `writeTelemetryState` не атомарен, хотя соседние реализации атомарны

`packages/services/src/telemetry/telemetryCore.ts:162-166` делает `writeFile` поверх существующего `telemetry-state.json`. CLI (`cli-device-mid.ts:104-121`) и bootstrap (`bootstrap.ts:252-254`) используют temp+rename. При crash в момент записи возможен «полузаписанный» JSON; `readTelemetryState` вернёт `{}` (`:152-160`), что приведёт к новой генерации `deviceMid` — то есть к смене device identity.

### 4.11 P2: ARMS `beforeReport` — единственная точка очистки, но native dump исключён

`armsEventRedaction.ts:38-42` намеренно не трогает native dump события. Это обосновано (`binary_images` нужны для классификации), но означает, что любые текстовые поля, которые ARM crash collector извлёк из minidump, уходят без redaction. **Inferred:** второго фильтра после `filterAndEnrichNativeCrashEvents` в прочитанном коде нет; фактическое содержимое таких полей не проверялось (нет minidump-фикстуры с пользовательскими строками).

### 4.12 P2: нет soak/chaos-тестов и perf-бюджетов в CI

- Единственный `*.perf.test.ts` — `compacted-full-history-cold-hydration.perf.test.ts`, под `describe.skipIf(process.env.ZCODE_PERF_REPRO !== "1")` (`:34`), пишет измерения в stdout, но **не содержит порогов**; проверяются только структурные инварианты.
- `memory-bench.test.mjs` (190 строк) проверяет liveness/порядок событий/наличие файла, но не RSS/heap (grep `heapUsed|rss|maxRss` по `apps/zcode-cli/e2e/memory/*` — 0 совпадений).
- Нет тестов «медленный диск», «сеть недоступна для телеметрии», «экспортёр OTel отвечает 500».
- Есть fs-fault injection (`docs/testing/e2e-fs-fault-injection.md`), что частично закрывает chaos-потребность.

### 4.13 P2: обработка ошибок телеметрии смешивает «не удалось» и «не пытались»

`sendReport` при пустом `REPORT_ENDPOINT` молча `return` (`telemetryCore.ts:419`), а `reportEvent` всё равно резолвится. Вызывающий код не может отличить «успешно отправлено» от «канал отключён сборкой»; метрики доставки на клиенте из-за этого невозможны без изменений API.

### 4.14 P2: имена/язык логов непоследовательны

- `apps/zcode-cli/packages/core/src/runtime-task/registry.ts:2081,2104,2116` содержит русские тексты в `console.warn` (`не удалось проверить конфликты`, `Конфликт...`), что нарушает принятый в остальном репозитории английский/китайский стиль и плохо ищется в логах.
- `apps/zcode-cli/packages/core/src/tool/registry.ts:41-65` пишет `console.warn` напрямую вместо инжектированного logger — сообщения не попадают в structured JSONL и не имеют traceId.
- `packages/services/src/setting/settingService.ts:34-42`, `packages/services/src/oauth/oauthService.ts:44-46`, `packages/services/src/memory/memoryService.ts:160,181,200` используют голый `console.*` вместо `createServiceLogger`, что расходится с AGENTS.md-правилом «Agent/session/runtime-логи через `createServiceLogger(scope)`». В `oauthService.ts` `createServiceLogger` уже импортирован (`:23,46`), но рядом остался `console.log`-хелпер (`:44-45`); в `settingService.ts` и `memoryService.ts` импорта `createServiceLogger` нет.

## 5. Strengths and differentiators

Всё ниже — Observed; «сильная сторона» здесь означает «механизм реально реализован и проверяемо ограничен», а не сравнение с конкурентами.

1. **Единая псевдонимная идентичность `deviceMid`.** Один UUID, один файл, четыре независимых потребителя (продуктовые события, HTTP-заголовки, ARMS, OTel installationId). Каждая реализация имеет собственную защиту от гонок, а CLI/Desktop сходятся на одном файле — `packages/desktop/src/main/desktopDeviceMid.ts:17-50`, `packages/services/src/telemetry/telemetryCore.ts:285-334`, `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts:34-158`, `apps/zcode-cli/packages/telemetry/src/bootstrap.ts:223-296`.
2. **Идемпотентность продуктовых событий.** `session_create` получает детерминированный UUIDv8 от `(userId, sessionId)`, все попытки переиспользуют один `event_id`; серверная дедупликация по `event_id` — `telemetryCore.ts:23-32,559-564`; контракт зафиксирован в `docs/monitoring/event-report-delivery-reliability.md:37-53`.
3. **Жёсткая граница «телеметрия — побочный канал».** Ошибки marketing attribution warn'ятся один раз; `daily_active` вынесен из-под блокировки файла (сеть вне lock); drain ограничен 2 s и параллелен остальному shutdown — `telemetryCore.ts:421-431,630-641`; `index.ts:1218-1252`. Это не даёт телеметрии удлинять выход или блокировать turn.
4. **Двухуровневая очистка приватности `/event/report`.** UI чистит до IPC и до debug-лога, Core чистит повторно на выходе; есть regression-тесты, включая проверку, что исходный объект не мутируется (`packages/ui/test/appTelemetryPrivacy.test.ts:1-70`) и что ретрай переиспользует уже очищенное тело (`docs/monitoring/event-report-privacy.md:38-43`).
5. **Централизованная и обоснованная очистка ARMS.** Единый `beforeReport` вместо разрозненных коллекторов; click-текст, snapshots, exception message/stack, URL — всё усечено/удалено; native dumps осознанно исключены с сохранением `binary_images` (`armsEventRedaction.ts:1-100`; `docs/monitoring/performance-monitoring.md:152-160,213,269`).
6. **OTel cost controls спроектированы, а не случайны.** 5-минутный metric interval, DELTA temporality, 10% head sampling с parent-based наследованием, ≤10 buckets, cardinality limit 250, 5 000 active writers с counter'ом `creation_drop` — и всё это закреплено тестом (`otlp-cost-controls.test.ts:16-80`; `agent-metrics.ts:225-245`).
7. **`turn-window` retention для event store.** Редкий случай, когда утечка не просто «подчищена», а закрыта дизайн-контрактом с таблицей зависимостей, тестами на seq-монотонность и сравнением `unbounded` vs `turn-window` (`apps/zcode-cli/docs/design/v2/session-event-store-retention.md:1-80`; `contracts/tests/in-memory-session-event-store.test.ts:100`).
8. **Явные границы streaming backpressure и фоновой коалесценции.** Задокументированы и реализованы: 1 000 мс бюджет для `Write/Edit`-превью, tombstone-буфер для фоновых сессий, запрет на дросселирование permission/terminal (`docs/performance/streaming-tool-input-backpressure.md:1-30`; `docs/performance/background-session-event-coalescing.md:1-40`).
9. **Многоуровневый процессный жизненный цикл.** detached process group + `taskkill /T`, generation-guard от гонок restart, crash budget 1/2/4/8/16 s с остановкой после пятой попытки, общий shutdown-барьер с разными бюджетами для Windows и остальных (`zcodeAgentProcessManager.ts:1000-1035`; `crashBudget.ts`; `appShutdownPolicy.ts:14-32`).
10. **Диагностика памяти как отдельный продукт.** Четыре роли процессов, 60-секундные сэмплы, гейт «5%/10%/300 s», доменные счётчики, `role=`-строки в main-логе и JSONL в CLI, отдельный документ с командами `grep`/`jq` (`docs/monitoring/memory-diagnostics-log.md:1-120`). Это позволяет владельцу утечки увидеть её без воспроизведения.
11. **Экспорт логов с потоковой очисткой и устойчивостью к гонкам.** Санитайзер применяется как Transform-поток, кодировки UTF-8/UTF-16 определяются по сэмплу, файл копируется в staging до zip, недоступные файлы пропускаются с ограничением списка (`exportLogs.ts:608-645,1046-1060,1080-1110`).
12. **Fault injection для файловых сбоев.** Документированные D01–D05, включая ENOSPC в session history и log sink'ах, с защитой от production-включения (`docs/testing/e2e-fs-fault-injection.md:1-45`).

## 6. Candidate recommendations

Формат: **problem/gap** · **ZCode evidence** · **proposed solution** · **scope/out-of-scope** · **expected effect** · **risks** · **complexity S/M/L** · **priority P0/P1/P2** · **acceptance criteria** · **verification method**.

---

### R1. Не допускать полный request body в CLI JSONL и support bundle

- **Problem/gap.** `turn.failed` пишет `responseBodySummary` = исходный record с `input` (670 сообщений) и `tools` (18 определений); строки до 1.34 MB; данные уходят в support bundle. §4.1.
- **ZCode evidence.** `apps/zcode-cli/packages/core/src/runtime/helpers/turn-errors.ts:326-334`; `apps/zcode-cli/packages/adapters/src/model/provider-finish-business-error.ts:99-118,224-230`; `apps/zcode-cli/packages/adapters/src/logging/serialize.ts:111-160`; воспроизведение в `~/.zcode/cli/log/zcode-2026-11-11.jsonl`.
- **Proposed solution.** (a) В `provider-finish-business-error.ts` заменить `candidates.find(hasBusinessSignal)` на явный `summarize...` той же формы, что `summarizeProviderBusinessBody` (`model-execution.ts:1098-1104`), т.е. только scalars + `keys` + `request_id`/`code`/`message`; (b) в `serializeLogError` ограничить сериализуемый `context` по глубине/размеру (например, max 8 KB на frame с маркером `truncated: true`); (c) добавить тест, что `input`/`tools`/`messages` не попадают в JSONL при `ProviderBusinessError`.
- **Scope.** `apps/zcode-cli/packages/adapters` (error summary + serializer) и один regression-тест. Out of scope: изменение retry-решений, формата `/report`, OTel.
- **Expected effect.** Удаление 4 строк >100 KB за 4 дня (~3.9 MiB) и полного prompt из support bundle; снижение риска приватности.
- **Risks.** Можно потерять диагностические поля, которые сейчас случайно доступны; нужно сохранить `error.code/type/providerCode/requestId` и `keys`, чтобы triage не ухудшился.
- **Complexity.** S (два файла + тест).
- **Priority.** P0.
- **Acceptance criteria.** Для сценария `ProviderBusinessError` с большим `requestBodyValues` сериализованная строка ≤ 32 KB; присутствуют `providerCode`, `requestId`, `keys`, `message`; `input`, `tools`, `messages` отсутствуют; существующие тесты `runner-provider-business-network.test.ts` / `retry-budget.test.ts` остаются зелёными.
- **Verification.** Новый unit-тест в `apps/zcode-cli/packages/adapters/tests/` + `pnpm --dir apps/zcode-cli test` по затронутому пакету; ручная проверка: прогнать сценарий и убедиться, что в `zcode-YYYY-MM-DD.jsonl` нет строк >100 KB.

---

### R2. Добавить бюджет и санитайз для `event_text` / `eventExtraDetail`

- **Problem/gap.** `event_text` и произвольные detail-ключи уходят без очистки и без ограничения размера; `template_prompt` содержит полный текст шаблона. §4.2.
- **ZCode evidence.** `packages/services/src/telemetry/telemetryCore.ts:439,441-444`; `packages/shared/src/telemetry.ts:216-241`; `packages/ui/src/lib/promptTemplateTelemetry.ts:14-27`; `packages/shared/src/validation.ts:517-527`.
- **Proposed solution.** (a) В `rendererTelemetryEventPayloadSchema` задать `.max(...)` для `eventText`, ключей и значений detail (например, 256 симв. / 64 ключа / 1 KB на значение); (b) добавить в `sanitizeTelemetryEventDetail` allowlist допустимых detail-ключей **или** явную политику «свободный текст только для перечисленных событий»; (c) для `template_prompt` заменить значение на `template_id`-производный хэш либо явно задокументировать как продуктовый контент.
- **Scope.** `packages/shared/src/telemetry.ts`, `packages/shared/src/validation.ts`, `packages/services/src/telemetry/telemetryCore.ts`, UI-call-site. Out of scope: изменение набора событий и их семантики.
- **Expected effect.** Ограничение размера payload'ов и защита от случайной отправки пользовательских текстов новыми событиями; укладывается в существующий контракт «privacy by subset» (`docs/monitoring/event-report-privacy.md`).
- **Risks.** Слишком строгий allowlist сломает будущие события; нужен режим «безопасный по умолчанию + явное расширение».
- **Complexity.** M.
- **Priority.** P1.
- **Acceptance criteria.** Payload > лимита отклоняется на IPC-схеме (или усекается с явным маркером); `prompt_template_ck` не содержит `template_prompt` дословно либо это задокументировано и покрыто тестом; существующие `appTelemetryPrivacy.test.ts`, `promptTemplateTelemetry.test.ts` обновлены.
- **Verification.** Unit-тесты схем + `pnpm typecheck`/`pnpm lint`; проверка, что UI-тест кодирует новую политику.

---

### R3. Ввести пользовательский opt-out и журнал согласия

- **Problem/gap.** Нет настройки/`DO_NOT_TRACK`/consent-шага; выключение только сборкой или env. §4.3.
- **ZCode evidence.** repo-wide поиск (0 совпадений); `packages/shared/src/env.ts:60-64`; `appARMSBootstrap.ts:163-167`; `telemetryCore.ts:419`; онбординг без privacy-шага (`packages/ui/src/onboarding/`, поиск `privacy|telemetry` пуст).
- **Proposed solution.** (a) Добавить настройку `telemetry.enabled` (default: как сейчас для正式-сборки) и проверять её в `reportAppTelemetryEvent` (UI), `TelemetryCore.reportEvent` (Main) и в ARMS `beforeReport`/init; (b) `DO_NOT_TRACK=1` учитывать как принудительный opt-out; (c) фиксировать decision в `setting.json` и показывать в «About/Privacy».
- **Scope.** `packages/shared` (setting schema), `packages/ui` (settings UI + reporter guard), `packages/desktop` (Main gate), `packages/services` (Core gate). Out of scope: серверная сторона, OTel CLI (диагностический surface).
- **Expected effect.** Соответствие ожиданиям пользователей и снижение юридического риска; возможность отключить поток без пересборки.
- **Risks.** Уменьшение объёма продуктовых данных; нужно решить, применяется ли opt-out к crash reporting (обычно нет) и к ARMS-стабильности.
- **Complexity.** M.
- **Priority.** P1.
- **Acceptance criteria.** При `telemetry.enabled=false` ни один из `/event/report` и ARMS sendCustom не уходит (проверяется тестом с mock transport); настройка сохраняется и переживает перезапуск; `DO_NOT_TRACK=1` даёт тот же эффект; crash reporting остаётся включённым и это явно задокументировано.
- **Verification.** Unit-тесты на три гейта + ручная проверка локального HTTP-приёмника; регресс существующих `telemetryDeliveryReliability.test.ts`.

---

### R4. Снизить объём CLI JSONL: уровни, агрегация и cap размера файла

- **Problem/gap.** 359.4 MiB за 4 дня; доминируют info-события `session.event.persistence.*`, `turn.phase.*`, повторяющийся `mcp.server.failed`; нет лимита размера. §4.4.
- **ZCode evidence.** измерения §2.1; `apps/zcode-cli/packages/adapters/src/logging/retention.ts:6,97-120`; `apps/zcode-cli/packages/core/src/runtime/methods/events.ts:62-72,420-425,473-480`; `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:250-271`; `apps/zcode-cli/packages/adapters/src/mcp/index.ts:1892-1905`.
- **Proposed solution.** (a) `turn.phase.started/completed` перевести в `debug` или агрегировать в один `turn.phase.summary`; (b) `session.event.persistence.started` убрать для title-only или слить с completed; (c) троттлинг `mcp.server.failed`: один warn на `(connectionId, errorClass)` за окно, счётчик подавленных; (d) добавить размерный cap (`maxBytesPerDay` с переходом на `zcode-YYYY-MM-DD.N.jsonl` и жёстким удалением старейшего при превышении).
- **Scope.** CLI core/adapters logging. Out of scope: формат session events, OTel, Desktop логи.
- **Expected effect.** Ожидаемое сокращение объёма на 30–40% (по доле `session.event.persistence.*` 20% + `turn.phase.*` 14% + MCP 6% за 11-09) и защита от «одного плохого дня» на сотни MB.
- **Risks.** Потеря диагностических полей при переводе в debug; нужно сохранить stage/phase в агрегате.
- **Complexity.** M.
- **Priority.** P1.
- **Acceptance criteria.** На типовой сессии число info-строк на turn снижается; при превышении `maxBytesPerDay` создаётся новый файл, старейшие удаляются по retention; `logging.test.ts` и `session-lifecycle-logging.test.ts` обновлены; `event_store` seq/replay тесты не затронуты.
- **Verification.** Unit-тесты логгера (ротация по размеру), прогон генератора нагрузки/сценария и сравнение объёма до/после; `pnpm --dir apps/zcode-cli test`.

---

### R5. Закрыть оставшиеся утечки из аудита 2026-09-03

- **Problem/gap.** `shiki tokensCache`, in-memory `snapshotCache`, `TaskRealtimeBus.streamBatches`, bots per-task state, отсутствие подписчиков на `onDidRemoveConnection`. §4.9.
- **ZCode evidence.** `packages/ui/src/lib/shikiHighlighter.ts:60-67,176`; `packages/ui/src/hooks/useZCodeTaskService.ts:21-23,79-95,199-213`; `packages/desktop/src/main/taskRealtimeBus.ts:366-397,520-522`; `packages/services/src/bots/botsService.ts:760-812`; `packages/rpc/src/ipc.ts:141`.
- **Proposed solution.** (a) LRU cap для `tokensCache` (например, 500 записей / 32 MB, считать по сумме длин) и `snapshotCache` (переиспользовать `SNAPSHOT_CACHE_MAX_*`); (b) удалять `streamBatches` в `releaseLease`/`releaseLeasesForHost`/`unregisterHost` после flush; (c) `releaseTaskWatch(taskId)` для bots, вызываемый из disconnect/terminal/delete; (d) подписать `terminalService` и `fileWatcherService` на `IPCServer.onDidRemoveConnection` и освобождать per-connection ресурсы.
- **Scope.** `packages/ui`, `packages/desktop/src/main`, `packages/services`, `packages/rpc` (wire-up). Out of scope: изменение протокола и семантики continuous/replayable.
- **Expected effect.** Устранение роста памяти при долгой работе; счётчики `shiki.tokensCache`, `taskSnapshotCache.entries`, `taskBus.streamBatches`, `terminal.open`, `fileWatcher.open` перестают монотонно расти.
- **Risks.** Преждевременная эвикция ухудшит UX (повторная токенизация, повторный RPC snapshot); очистка watcher'ов может сломать подписки, переживающие reconnect.
- **Complexity.** L (структурный пункт d).
- **Priority.** P1.
- **Acceptance criteria.** Для каждого пункта есть тест, доказывающий освобождение (например, `streamBatches.size === 0` после non-terminal release); memory-diagnostics счётчики в soak-сценарии стабилизируются; `docs/analysis/memory-leak-audit-2026-09-03.md` обновлён статусом «fixed».
- **Verification.** Unit/integration тесты + 30-минутный soak с 5 параллельными задачами и записью `[memory]`-строк; сравнение p95 `heapUsedKb` до/после.

---

### R6. Сделать cost-учёт согласованным (или явно удалить поле)

- **Problem/gap.** `cost: 0` в production, `null` в протоколе, при этом UI считает cost через `tokenlens`. §4.8.
- **ZCode evidence.** `apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts:337`; `turn-stop.ts:86,137`; `turn-step-finish.ts:29`; `timeline-persistence.ts:130`; `session-fork.ts:475`; `session-mapper.ts:728,761,779`; `packages/ui/src/components/ai-elements/context.tsx:224-236`.
- **Proposed solution.** Вариант A: считать `cost` на стороне CLI из прайса провайдера (если прайс доступен) и сохранять; Вариант B (минимальный): удалить `cost` из контракта или пометить `deprecated` и убрать «Total cost» из UI, оставив только токены.
- **Scope.** `apps/zcode-cli/packages/contracts`, `core/runtime/methods`, `bootstrap/zcode-protocol`, UI context-компонент. Out of scope: биллинг Coding Plan (серверный).
- **Expected effect.** Устранение ложного впечатления учёта; единый источник истины для cost.
- **Risks.** Вариант A требует прайс-данных и версионирования; ошибки прайса дадут неверные числа.
- **Complexity.** M (B) / L (A).
- **Priority.** P2 (но P1, если cost будет использоваться в продукте).
- **Acceptance criteria.** (B) `rg "cost: 0"` в production-путях = 0; UI не показывает ненулевой cost при `cost: null`; (A) cost сохраняется и совпадает с расчётом на фиксированном fixture с известным прайсом.
- **Verification.** Unit-тест на persistence + UI-тест отображения; `pnpm typecheck`.

---

### R7. Дать телеметрии собственные метрики доставки

- **Problem/gap.** Нет счётчиков успех/потеря для `/event/report`; отключённый канал неотличим от успешного. §4.6, §4.13.
- **ZCode evidence.** `telemetryCore.ts:419,504-508,539-541`; `otlp-exporter.ts` (нет diag logger).
- **Proposed solution.** (a) Вернуть из `reportEvent` структурированный результат `{status: "delivered"|"disabled"|"failed", category}` и агрегировать в `createAppTelemetryRuntime`; (b) отдавать агрегат в память + периодический `info`-лог (раз в 15 мин) с `attempts/success/failedByCategory/pending`; (c) для OTel CLI установить `diag` logger, пишущий ошибки экспортёра в structured logger с rate-limit.
- **Scope.** `packages/services/src/telemetry`, `packages/desktop/src/main/appTelemetryRuntime.ts`, `apps/zcode-cli/packages/telemetry`. Out of scope: серверный приёмник.
- **Expected effect.** Появляется локально измеримый delivery-rate; можно ввести SLO и дашборд без серверных данных.
- **Risks.** Дополнительные логи; нужно не логировать payload.
- **Complexity.** M.
- **Priority.** P2.
- **Acceptance criteria.** Для каждого события известен терминальный статус; агрегат доступен через memory-diagnostics/лог; тест проверяет `disabled` vs `delivered` vs `failed`; OTel-ошибка экспортёра видна в логе один раз за окно.
- **Verification.** Unit-тесты с mock fetch; локальный HTTP-приёмник, отвечающий 500/429.

---

### R8. Ввести SLO и perf-бюджеты в CI

- **Problem/gap.** Нет численных SLO; единственный perf-тест под флагом и без порогов; memory-e2e не проверяет RSS. §4.12.
- **ZCode evidence.** `apps/zcode-cli/packages/bootstrap/tests/compacted-full-history-cold-hydration.perf.test.ts:34,110-130`; `apps/zcode-cli/e2e/memory/memory-bench.test.mjs:1-190`; отсутствие `\bSLO\b` с числами в `docs/`.
- **Proposed solution.** (a) Зафиксировать SLO в `docs/monitoring/` (например, `perf_app_start` p95, Host init p95, TTFT p95 по `local_ttft`, crash-free rate, delivery rate); (b) добавить в существующий perf-тест порог по `totalMs`/`mergeMs` с щедрым запасом и отчётом в stdout; (c) в memory-e2e добавить проверку `rss` до/после сценария и порог роста.
- **Scope.** `docs/monitoring`, `apps/zcode-cli` perf/memory tests. Out of scope: продакшн-алертинг (вне репозитория).
- **Expected effect.** Регрессии старта/памяти ловятся в PR, а не в поле.
- **Risks.** Флаки в CI из-за вариативности машин; нужны относительные пороги и `skipIf` для локальных прогонов.
- **Complexity.** M.
- **Priority.** P2.
- **Acceptance criteria.** SLO-документ содержит числа и метод измерения; perf-тест падает при искусственном замедлении (проверяется тестом самого гейта); memory-e2e сообщает рост RSS и сравнивает с порогом.
- **Verification.** Прогон `ZCODE_PERF_REPRO=1` локально; unit-тест на гейт; CI-job (если разрешён владельцем CI).

---

### R9. Атомарная запись `telemetry-state.json` в Core

- **Problem/gap.** `writeTelemetryState` пишет поверх файла; crash → повреждённый JSON → новый `deviceMid`. §4.10.
- **ZCode evidence.** `packages/services/src/telemetry/telemetryCore.ts:162-166`; ср. `cli-device-mid.ts:104-121`; `bootstrap.ts:252-254`.
- **Proposed solution.** Использовать temp-файл + `rename` (как в CLI), сохранить текущий контракт ошибок (не бросать наружу).
- **Scope.** Один файл + тест. Out of scope: формат состояния.
- **Expected effect.** Устойчивость идентичности к crash/питанию.
- **Risks.** Минимальные; temp-файлы нужно чистить при ошибке.
- **Complexity.** S.
- **Priority.** P2.
- **Acceptance criteria.** Тест с инъекцией сбоя записи: файл остаётся валидным и `deviceMid` не меняется; при чтении повреждённого файла поведение прежнее.
- **Verification.** Unit-тест `telemetryCore` с mock fs.

---

### R10. Привести сервисные логи к `createServiceLogger` и убрать смешанные языки

- **Problem/gap.** `console.*` в services/core, русские сообщения в CLI. §4.14.
- **ZCode evidence.** `packages/services/src/setting/settingService.ts:34-42`; `packages/services/src/oauth/oauthService.ts:44-46`; `packages/services/src/memory/memoryService.ts:160,181,200`; `apps/zcode-cli/packages/core/src/tool/registry.ts:41-65`; `apps/zcode-cli/packages/core/src/runtime-task/registry.ts:2081,2104,2116`.
- **Proposed solution.** Заменить на `createServiceLogger`/инжектированный logger; унифицировать язык сообщений (английский для логов, локализуемые строки — в i18n).
- **Scope.** Указанные файлы + тесты. Out of scope: изменение поведения.
- **Expected effect.** Логи становятся структурированными, с scope/pid, и не теряются при переключении sink'а; grep по инциденту работает одинаково.
- **Risks.** Меняются строки, на которые могут опираться тесты/парсеры; нужно проверить `rg` по текстам.
- **Complexity.** S.
- **Priority.** P2.
- **Acceptance criteria.** `rg "console\.(log|warn|error)" packages/services/src apps/zcode-cli/packages/core/src` не находит этих мест; все сообщения логов — на английском; тесты обновлены.
- **Verification.** `pnpm lint` (+ lint-правило, если есть), unit-тесты соответствующих сервисов.

## 7. Open questions and unverified

### 7.1 Unknown — требует внешних данных или продакшн-наблюдения

1. **Фактический delivery rate `/event/report`.** В коде нет клиентской метрики; цель 87.6% → ≥95% задана в `docs/monitoring/event-report-delivery-reliability.md:75-79` как продуктовая, но текущее значение не измеряется. Unknown.
2. **Реальные размеры `~/.zcode/cli/log` у пользователей.** Измерение сделано на одной dev-машине, где активно работали субагенты (64 сессии, 5 процессов, 225k eventRows). Пользовательские распределения Unknown.
3. **Стоимость хранения телеметрии на сервере.** `local-ttft-rollout-checklist.md:80-95` прямо перечисляет «retention 7/30 дней и стоимость» как непроверенные; дашборд существует, но ёмкость/цена Unknown.
4. **Эффект `turn-window` retention на длинных сессиях в проде.** Есть тесты и дизайн-документ, но нет продакшн-метрики «heap до/после» на реальных пользователях. Локальный пик 888 MB heap при 5 сессиях и 225k eventRows — это **не** доказательство регрессии (нет baseline до изменения).
5. **Причина роста `eventRows` до 225 698 при `eventEvicted` 686 233.** Счётчики показывают, что eviction работает, но не объясняют, почему одновременно остаётся 162 538 transient-событий. Возможные причины: несколько открытых turn'ов, subagent-сессии с grace, `unbounded`-режим в каком-то пути. Требует адресного профилирования. **Inferred**, не подтверждено.
6. **Влияние логирования на латентность turn'а.** Синхронный `appendFileSync` на каждый info-лог (`logging/index.ts:133`) на медленном диске может давать десятки мс; замеров нет. Unknown.
7. **Поведение `streamBatches` на реальном отключении хоста.** Код показывает отсутствие delete в `releaseLease`/`unregisterHost`, но фактический рост в продакшне не измерен; Unknown, насколько часто это срабатывает.
8. **Windows/Linux-специфика.** Все живые замеры — macOS (darwin). Windows `taskkill /T`, пути, `EPIPE`-обработка и размеры логов не проверены на реальной Windows-машине.
9. **Эффективность `armsEventRedaction` для native dump.** Исключение сделано осознанно, но нет теста/данных, что в minidump-производных полях не бывает пользовательских строк. Unknown.
10. **Существует ли внутренний дашборд для `/event/report`.** В репозитории его нет; возможно, он живёт в приватном репозитории/BI — Unknown.
11. **Причина `cost: 0` — намеренное решение или незавершённая миграция.** Z07 зафиксировал отсутствие cost cap; в этом partial подтверждено только поведение. Мотивация Unknown.
12. **Реальная скорость и память индексации больших репозиториев.** Есть caps (20 000 файлов, 1 MiB), но нет бенчмарка времени/памяти на репозитории >20k файлов. Unknown.
13. **Стоимость `tokenlens`-расчёта в UI на больших сессиях.** `getUsage` вызывается на рендер футера контекста (`context.tsx:224-236`); профиля нет. Unknown.

### 7.2 Unverified claims — сформулированы, но не доказаны

1. «Логи стали причиной замедления» — не доказано; доля времени на `appendFileSync` не измерена.
2. «`turn-window` полностью решает рост памяти event store» — доказано только на уровне кода/тестов; продакшн-эффект Unknown.
3. «ARMS-очистка покрывает все поля» — покрывает известные коллекторы, но нет fuzz-теста на произвольные поля.
4. «Дублирование `push` вместо копирования убирает O(n²)» — код это делает, но бенчмарка до/после в репозитории нет.

### 7.3 Проверки, которые не выполнялись

- Полный `pnpm test` / `pnpm test:unit` (запрещено рамками ветки).
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check` (только чтение, изменений нет; запускать не требовалось, но и не запускалось).
- Desktop E2E, TTFT E2E (лежат в `manual-review/pending`).
- Реальные сетевые запросы к ARMS/OTLP/`/event/report`.
- Windows/Linux-прогоны.
- Профилирование CPU/heap (DevTools/`--inspect`) — не выполнялось.
- Проверка приватного `config/private/build-defaults.json` (в OSS-дереве отсутствует; наличие в приватном репо Unknown).

## 8. Evidence appendix

### 8.1 Preflight

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

`CodeIndex status`:

```json
{"state":"ready","partial":false,"generation":1456,
 "counts":{"files":10007,"chunks":26791,"symbols":278154,"edges":377669},
 "embedding":{"configured":true,"model":"perplexity/pplx-embed-v1-0.6b","available":true},
 "diagnostics":[]}
```

### 8.2 Выполненные команды и результаты

| Команда | Результат |
| --- | --- |
| `ls -la ~/.zcode/cli/log` | 4 файла: 11-08 17 314 637 B; 11-09 172 228 090 B; 11-10 123 178 124 B; 11-11 (на момент первого замера) 64 116 198 B; суммарно ~360 MiB |
| `wc -l ~/.zcode/cli/log/zcode-2026-11-11.jsonl` | 67 940 строк на момент T0; 68 177 при python-парсинге T1; 72 413 при замере размера T2 — файл активно дописывался |
| python-агрегация по 11-11 (снимок T1) | 68 177 строк / 61.1 MiB; p50 868 B, p95 1 357 B, p99 1 365 B, max 1 344 757 B; строк >8 KB — 2 (2.6 MiB) |
| python-агрегация по 11-09 | 245 510 строк / 164.0 MiB; `mcp.server.failed` 11 534 (10.0 MiB); `session.event.persistence.completed` 23 589 (17.4 MiB); `turn.phase.completed` 18 932 (11.5 MiB) |
| python: распределение строк по сессиям (11-11) | 64 сессии; p50 1 055, p95 3 322, max 3 706 (`sess_subagent_agent_167979aa-…`); top-3: 3 706 / 3 413 / 3 351 |
| python: распределение строк по traceId (11-11) | 7 traceId; p50 626, max 70 519 |
| python: memory_sample по 11-11 | 340 сэмплов; max heap 888.1 MB, max RSS 1 196.8 MB, max eventRows 246 094, max eventEvicted 686 233 |
| python: `[memory]` по `~/.zcode/v2/logs/2026-11-11.log` | 218 main / 148 utility_host / 114 renderer строк; max utility_host 644 368 KB, main 203 136 KB, renderer 135 742 KB |
| `find packages/desktop/out/renderer/assets …` | 147 MB с sourcemap, 45.7 MB без; `styles-*.js` 6.6 MB, `duke_sheets_wasm` 4.1 MB, office-chunk 2.1 MB, `IntlProvider` 1.7 MB |
| `ls -la apps/zcode-cli/packages/cli/dist` | `zcode.cjs` 16 226 753 B |
| подсчёт `find … -name '*.test.ts'` | 3 601 (+10 `*.test.tsx`) |
| подсчёт `find packages/desktop/test/e2e -name '*.test.ts'` | 575 |
| подсчёт `rg -l telemetry … --glob '*.test.ts'` | 145 |
| подсчёт файлов `*.test.ts`, упоминающих `logger` или `logging` | 235 |
| `node scripts/eval-results-gate.mjs` | `eval gate: FAIL (1 problem)` — `.zcode/eval-results.jsonl is missing; run /evaluate at HEAD d10f0b6` |
| `rg -n` по ключам opt-out (`telemetryEnabled`, `telemetryOptOut`, `DO_NOT_TRACK`, `disableTelemetry`, `analyticsEnabled`) в `packages/*/src` и `apps/zcode-cli/packages/*/src` | пустой вывод (0 совпадений) |
| `rg -n` по `onDidRemoveConnection` в `packages` и `apps` | 3 совпадения, все в `packages/rpc/src/ipc.ts` (`:63,104-105,141`); ни одного подписчика в services/desktop/web/server |
| `ls -la ~/.zcode/cli/rollout` | 3 файла, 2.8 MB (`model-io-no-session.jsonl` 45 KB, два session-файла ~1.4 MB) |

### 8.3 Ключевые пути и символы

**Telemetry product (`/event/report`)**
- `packages/ui/src/lib/appTelemetry.ts:36-68` — `reportAppTelemetryEvent`, UI-санитайз + debug-лог.
- `packages/shared/src/telemetry.ts:63-79` — `sanitizePluginTelemetryDetail` (whitelist).
- `packages/shared/src/telemetry.ts:181-183` — `sanitizeTelemetryErrorMessage`; `:192-203` — `sanitizeTelemetrySkillName`; `:205-213` — `sanitizeLoginHostname`; `:216-241` — `sanitizeTelemetryEventDetail`.
- `packages/services/src/telemetry/telemetryCore.ts:23-32` — детерминированный `sessionCreateEventId`; `:38-41` — константы ретраев; `:85-92` — `TelemetryState`; `:126-166` — state/lock файлы, чтение/запись; `:172-273` — stale-lock; `:280-334` — `ensureDeviceMid` + кэш; `:336-354` — `createTelemetryCore`; `:356-370` — классификация HTTP; `:372-409` — `sendReportAttempt`; `:411-509` — `sendReport`; `:511-542` — drain; `:544-683` — публичный API.
- `packages/shared/src/env.ts:60-64` — `ZCODE_TELEMETRY_REPORT_ENDPOINT`.
- `packages/shared/src/validation.ts:517-527` — IPC-схема без размерных лимитов.
- `packages/desktop/src/main/desktopMainIpcRemote.ts:390-400` — IPC-обработчик `ReportTelemetryEvent`.
- `packages/desktop/src/main/index.ts:774-782` — сборка `TelemetryCore`; `:1218-1252` — quit-барьер.
- `packages/desktop/src/main/appTelemetryRuntime.ts:1-140` — launch/daily-active и heartbeat 15 мин.
- `packages/services/src/node.ts:3125-3148` — `createTelemetryAuthorizationLoader` (перечитывает identity и JWT перед отправкой).

**Идентификаторы**
- `packages/desktop/src/main/desktopDeviceMid.ts:17-50` — sync ensure.
- `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts:34-158` — CLI ensure + lock.
- `apps/zcode-cli/packages/telemetry/src/bootstrap.ts:223-296` — OTel ensure + lock.
- `packages/services/src/telemetry/telemetryCore.ts:285-334` — Core ensure.

**ARMS / crash**
- `packages/desktop/src/main/appARMSBootstrap.ts:163-170,204-245` — init + beforeReport.
- `packages/desktop/src/main/armsEventRedaction.ts:1-100` — очистка.
- `packages/desktop/src/main/desktopStabilityTelemetry.ts:17-40,174,523-616,909-943` — ANR/freeze/crash/agent-crash.
- `packages/desktop/src/main/desktopCrashCapture.ts:23-24,275-288,361-381`.
- `packages/ui/src/lib/uiPerfArmsTelemetry.ts:11-31,116-133,158,332`.
- `packages/ui/src/lib/armsCustomEventObservability.ts:1-40` — bounded E2E ring 200.

**OTel CLI**
- `apps/zcode-cli/packages/telemetry/src/bootstrap.ts:75-137,198-221,414-416`.
- `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:31-32,53-156,158-189,209-257`.
- `apps/zcode-cli/packages/telemetry/src/agent-metrics.ts:13-37,56-95,195-245`.
- `apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts:117,439-448,581-599`.
- `apps/zcode-cli/packages/telemetry/tests/otlp-cost-controls.test.ts:16-80`.

**Логирование**
- `packages/ui/src/logger.ts:13-112`.
- `packages/services/src/logger/serviceLogger.ts:18-65`.
- `packages/desktop/src/main/logger.ts:7-146`.
- `apps/zcode-cli/packages/adapters/src/logging/index.ts:95-249`.
- `apps/zcode-cli/packages/adapters/src/logging/serialize.ts:15-170`.
- `apps/zcode-cli/packages/adapters/src/logging/retention.ts:6-120`.
- `packages/desktop/src/main/logRetention.ts:4,60-98`.
- `packages/desktop/src/main/exportLogs.ts:151,157-205,222-278,608-645,779-790,963-1000,1046-1060`.
- `packages/client/src/logger.ts:1-30`.

**Надёжность / процессы**
- `packages/desktop/src/main/appShutdownPolicy.ts:14-32`.
- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:251,1000-1035,1405-1428`.
- `packages/zcode-server-cli/src/supervisor/crashBudget.ts`; `packages/zcode-server-cli/test/crashBudget.test.ts:4-20`.
- `apps/zcode-cli/packages/contracts/src/events/in-memory-session-event-store.ts:60-129`.
- `apps/zcode-cli/packages/contracts/src/events/session-event-retention.ts:9-121`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1142-1187`.
- `packages/rpc/src/ipc.ts:130-143`.
- `apps/zcode-cli/packages/adapters/tests/logging.test.ts:172-180` (`ZCODE_LOG_LEVEL` игнорируется).

**Производительность**
- `docs/desktop/startup-critical-path.md:8-13`.
- `packages/services/src/code-intelligence/scanner.ts:75-77,468-499,543`.
- `packages/services/src/code-intelligence/workspaceWatcher.ts:76-92`.
- `packages/services/src/fileWatcher/fileWatcherService.ts:10,66-88`.
- `packages/services/src/project-storage/startup.ts:48,74-75`.
- `packages/desktop/src/main/desktopResourceTelemetry.ts:55-70`.
- `packages/shared/src/processResourceTelemetry.ts:29`.
- `docs/performance/streaming-tool-input-backpressure.md:1-30`.
- `docs/performance/background-session-event-coalescing.md:1-40`.

**Тесты / eval**
- `.zcode/evaluation-cases.json` — 3 кейса.
- `scripts/eval-results-gate.mjs:1-20`.
- `scripts/prism10-experiment-gate.mjs:1-20` (`MAX_COST_RATIO = 1.25`, `MAX_LATENCY_RATIO = 1.3`).
- `scripts/delegation-routing-benchmark.mjs` (+ тест).
- `apps/zcode-cli/packages/bootstrap/tests/compacted-full-history-cold-hydration.perf.test.ts:34,110-130`.
- `apps/zcode-cli/e2e/memory/README.md:1-35`.
- `docs/testing/e2e-fs-fault-injection.md:1-45`.

### 8.4 Карта «аудит 2026-09-03 → текущий код»

Полная таблица в §4.9. Кратко: исправлено — CLI-H1, CLI-H2 (частично), MAIN-H1, SRV-H1; не исправлено — UI-H1, UI-H2, MAIN-H2, SVC-H1, структурный корень A (RPC disconnect). Доказательства — `git log` по этим файлам показывает только `1889d446 Initial import` и форматирующий `3b2f6d88`, то есть исправления вносились до текущей истории/в исходном импорте, а не отдельными коммитами, на которые можно сослаться; статус определён чтением кода, не историей.

---

## Coverage status

| Тема | Статус | Комментарий |
| --- | --- | --- |
| 19. Telemetry | **complete** | Все 4 канала, идентификаторы, retries, privacy-санитайзеры, off-switch'и, crash reporting. Пробелы: `event_text`, opt-out, delivery-метрики. |
| 19. Logging | **complete** | 4 логгера, уровни, гейты, redaction, retention, объём с замерами, нарушения AGENTS. |
| 19. Metrics / evals | **complete** | Токены/TTFT/OTel-метрики, `cost: 0`, eval-gate (не проходит), PRISM/delegation бенчмарки, 3 дашборда; качественных eval'ов и run-success SLO нет. |
| 20. Performance | **partial** | Старт/память/bundle — измерены; large-repo index, throughput, latency бюджеты — только по коду и докам; soak/нагрузочных прогонов нет. |
| 21. Reliability | **complete** | Процессы, quit-барьер, crash budget, ретраи, таймауты, атомарность, аудит утечек перепроверен построчно. |
| Observability of failures | **complete** | Error taxonomy, UI attribution, DB-startup UX, export logs, feedback archive; SLO/ранбуков нет. |
| Tests / benchmarks | **complete** | Инвентаризация + пробелы (нет perf-порогов, нет soak, нет chaos кроме fs-fault). |
| Docs/analysis cross-check | **complete** | `memory-leak-audit-2026-09-03.md` и `memory-leak-fix-plan-cli-event-store.md` сверены с кодом; статусы в §4.9. |

### Not-checked list

- Полный unit/integration suite, `pnpm typecheck`, `pnpm lint`, `architecture:check` — не запускались (read-only ветка, изменений нет).
- Desktop E2E, TTFT E2E, Windows/Linux-прогоны.
- Реальные отправки в ARMS/OTLP/`/event/report`; сетевые ошибки проверены только чтением кода и существующих тестов.
- CPU/heap-профилирование DevTools/`--inspect`.
- Приватный `config/private/build-defaults.json` и внутренние CI-переменные (`ZCODE_PACKAGED_AGENT_OTEL_*`, `ZCODE_ARMS_RUM_ENDPOINT` в release-пайплайне).
- Серверная retention/cost телеметрии в ARMS/SLS.
- Массовый парсинг всех 4 лог-файлов (анализировались 11-09 и 11-11 полностью; 11-08 и 11-10 — только размеры).
- Содержимое `~/.zcode/cli/rollout` (только размеры и число файлов).
- Работоспособность `streamBatches`/`onDidRemoveConnection` под реальной нагрузкой (вывод по коду).

---

**Подтверждение:** записан только этот partial-файл. Production-код, тесты, фикстуры и `.agents/skills/zcode-large-task-fixture` не изменялись; коммиты не создавались.
