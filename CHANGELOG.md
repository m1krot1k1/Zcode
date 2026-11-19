# Changelog

## [3.17.134](https://github.com/m1krot1k1/Zcode/compare/v3.17.133...v3.17.134) (2026-11-19)

### Features

* **chat:** продолжать ghost-подсказкой черновик пользователя, а не отвечать на него
  * промпт сервиса `chat-autocomplete` требует только суффикс продолжения в лице, языке и регистре пользователя; история диалога и ответы ассистента передаются как контекст, но не как образец голоса
  * детерминированный фильтр `shared-chat-autocomplete/postprocess.ts` отбрасывает ассистентский план, мета-комментарий и markdown-план; отфильтрованный ответ возвращается как штатный `empty_suggestion`, не попадает в кэш и не показывается в UI
  * `chatAutocompleteSettings.enabled` включён по умолчанию; запрос ограничен дебаунсом, `minPrefixChars`, кэшем префиксов и бюджетом 48 выходных токенов
  * регрессия: `contract.test.ts`, `userVoiceContinuation.test.ts`, `useChatAutocomplete.test.tsx` и `lexical-ghost-autocomplete/contract.test.ts` покрывают user-voice, фильтрацию assistant-voice и клиентскую отмену/дебаунс
* **composer:** предлагать следующую задачу после завершённого turn
  * после `completedSuccess` при фокусе на пустом композере `ComposerProactiveSuggestion` запрашивает одну короткую подсказку и показывает её над вводом; черновик не отправляется автоматически
  * `Tab` на редакторе или клик вставляют подсказку, `Escape` и кнопка dismiss скрывают; уход фокуса за пределы композера отменяет запрос
  * анти-спам: не больше двух запросов на turn, успешный ответ кэшируется по turn и повторный focus не тратит токены; смена turn сбрасывает кэш и счётчик попыток
  * сервис `proactive-suggestion` зарегистрирован в accessor и Node registration и доступен в Electron и Web (включая remote/mobile); настройка `proactiveSuggestionSettings` включена по умолчанию с одной подсказкой на turn, строки добавлены в `ru-RU`, `en-US`, `zh-CN`
  * регрессия: `proactiveSuggestion.test.ts`, `proactiveSuggestionHook.test.tsx`, shared/services/composer contract-тесты, `remoteServiceAccess.test.ts` и host-тесты регистрации сервиса

## [3.17.133](https://github.com/m1krot1k1/Zcode/compare/v3.17.132...v3.17.133) (2026-11-19)

### Features

* **agent:** показывать миллиардные и триллионные token counts как `B`/`T`-сокращение
  * `formatCompactTokenCount` расширен с `M`-only до полной шкалы `k/M/B/T`: единица выбирается по исходному значению, затем выводится ровно одна дробная цифра с decimal separator из locale
  * группировка разрядов отключена, поэтому `999 999 999` остаётся в `M`-диапазоне и рендерится как `1000,0M` (`en-US` — `1000.0M`), а `1 000 000 000` уже попадает в `B` и даёт `1,0B`
  * `ru-RU`: `1 500 000 000 000` → `1,5T`, `3 942 000 000` → `3,9B`; `en-US` использует точку (`1.5T`, `3.9B`); единицы выше `T` нет, поэтому `1e15` → `1000,0T`
  * строка Agent, breakdown и граф вложенных агентов по-прежнему используют один formatter
  * регрессия: `agentToolCallBlock.test.ts` (25 тестов) проверяет границы `M`/`B` и `B`/`T`, `1e12`/`1e15`, отсутствие группирующих разделителей и оба locale

## [3.17.132](https://github.com/m1krot1k1/Zcode/compare/v3.17.131...v3.17.132) (2026-11-19)

### Bug Fixes

* **agent:** показывать миллионные token counts как locale-aware `M`-сокращение
  * строка статистики subagent форматировала все значения `>= 1000` в тысячах, поэтому `3 100 000` рендерилось как `3100k`, а `3 942 000` — как `3942k`
  * `formatCompactTokenCount` теперь принимает locale: `>= 1 000 000` выводится как число миллионов с ровно одной дробной цифрой и Latin `M`, decimal separator берётся из locale (`ru-RU` — `3,9M`, `en-US` — `3.9M`)
  * значения `< 1 000 000` сохраняют прежний вид (`34k`, `55k`, `999 999 → 1000k`); breakdown и граф вложенных агентов используют тот же formatter
  * регрессия: `agentToolCallBlock.test.ts` проверяет фактический рендер строки для `1 000 000`…`3 942 000`, breakdown и границы в `ru-RU`, а также `en-US`

## [3.17.131](https://github.com/m1krot1k1/Zcode/compare/v3.17.130...v3.17.131) (2026-11-19)

### Bug Fixes

* **agent:** не терять ветки вложенного fan-out и запрещать фоновый запуск из turn-scoped caller
  * `callerAgentType` теперь входит в политику `run_in_background`: root/main по-прежнему автоматически уходит в background при двух и более Agent/Task в одной группе, а `start`, `orchestrator` и worker выполняют свои ветки в foreground и join до конца turn
  * явный `run_in_background: true` от turn-scoped caller отклоняется до spawn с `agent_background_unavailable`; профильный `background: true` не наследуется вложенным вызовом
  * `allowBackground: false` отключает и `autoBackgroundMs`, и внешний background request, поэтому дочерний runtime не уходит в background перед закрытием родительского turn
  * terminal gate проверяет прямых `local_agent` детей перед успешным отчётом и возвращает `agent_unresolved_children`, если ветка ещё не завершилась
  * регрессии: `agent-routing-policy.test.ts`, `subagent-background.test.ts`, `subagent-terminal-gate.test.ts` и end-to-end `subagent-nested-join.test.ts` с тремя параллельными ветками orchestrator

## [3.17.130](https://github.com/m1krot1k1/Zcode/compare/v3.17.129...v3.17.130) (2026-11-18)

### Bug Fixes

* **executor:** передавать полный контекст выполнения во все ветки `executeToolSchedule`
  * `executeToolSchedule` больше не собирает опции батча вручную: объект, который он передаёт в `executeBatch`, и разбиение по `maxConcurrency` внутри `executeBatch` теперь расширяют `...options`, как это уже делал быстрый путь, поэтому поля `ToolExecuteOptions` не теряются на отдельных маршрутах
  * восстановлен `offPeakTurn` в `ToolExecutionContext`: теперь он доходит до handler через `executeToolSchedule`, и `assertNotOffPeakTurn` снова отклоняет `Workflow` и `OffPeakCreate` в режиме простоя; ранее потеря поля заставляла проверку возвращаться без отказа
  * восстановлены `finishReason` и `consecutiveSchemaFailuresByTool`: усечённый ответ (`finishReason: "length"`) снова идёт в восстановление после усечения, а счётчик последовательных schema-ошибок снова обновляется
  * регрессионный тест `apps/zcode-cli/packages/core/tests/schedule-options-forwarding.test.ts` покрывает быстрый путь и разбиение по `maxConcurrency` и падал до исправления

## [3.17.129](https://github.com/m1krot1k1/Zcode/compare/v3.17.128...v3.17.129) (2026-11-18)

### Bug Fixes

* **agent:** вернуть публичный контракт инструментов к чтению и выполнению команд
  * `PtySession` больше не регистрируется в runtime-наборе и не виден модели; `Read` и `Bash` остаются без изменений
  * обычная диагностическая команда снова выполняется одним вызовом `Bash`, без трёх последовательных `start` → `write` → `read`
  * PTY-порт и handler сохранены как внутренняя инфраструктура и покрыты unit-тестами
* **code-index:** упаковать tree-sitter runtime в app.asar и серверный архив
  * `web-tree-sitter` и `tree-sitter-wasms` добавлены в injection и финальную проверку bundle; без них packaged-версия молча уходила в text fallback и давала 0 связей
  * `stage.ts` явно добавляет оба пакета в `runtime/node_modules` серверного архива: сканер bare-спецификаторов не видел wasm-грамматики, и remote-индекс оставался без refs/edges
  * `SCHEMA_VERSION` 4 перестраивает прежний text-fallback индекс при первом открытии

### Tests

* **agent:** проверить отсутствие `PtySession` в наборе по умолчанию, наличие `Read`/`Bash` и одноразовый вызов `Bash` в forensic-replay E2E
* **code-index:** проверить оба списка упаковки tree-sitter runtime, наличие `tree-sitter-wasms` в staged-архиве сервера и непустые `refs`/`edges` на реальном индексе

## [3.17.128](https://github.com/m1krot1k1/Zcode/compare/v3.17.127...v3.17.128) (2026-11-18)

### Bug Fixes

* **remote:** не блокировать Source Server устаревшим lock после переиспользования PID
  * `run/server.lock` хранит `processStartId` (Linux `/proc/<pid>/stat`, macOS `ps lstart`) и сравнивает идентичность инстанса, а не только `kill(pid, 0)`
  * legacy lock без identity признаётся stale, если PID занят посторонней командой; живой процесс `server-cli` не перехватывается
  * зомби и недоступная командная строка обрабатываются консервативно; recovery gate и quarantine по-прежнему гарантируют одного владельца
  * исправляет restart-loop Supervisor с `Another ZCode Server instance is already running`, когда PID из lock достался другому процессу

### Tests

* **remote:** покрыть перехват lock с чужим `processStartId`, legacy lock после переиспользования PID и сохранение lock за живым `server-cli`

## [3.17.127](https://github.com/m1krot1k1/Zcode/compare/v3.17.126...v3.17.127) (2026-11-18)

### Features

* **core:** параллелить доказуемо read-only команды Bash
  * `ToolEntry.resolveConcurrencyCapability` переопределяет статический `concurrentSafe` на уровне конкретного вызова
  * `pwd`, `ls`, `git status` и другие read-only команды входят в общую параллельную группу с `Read`/`Grep`/`Glob`; write-команды остаются барьером
  * классификация учитывает весь compound-command, а не только первый токен
* **agents:** не ждать самый медленный Agent в общем batch
  * при двух и более `Agent`/`Task` в одной параллельной группе запуск автоматически уходит в background
  * каждый завершившийся Agent доставляет результат через существующую очередь `background_task.notification`; явный `run_in_background:false` сохраняет блокирующее поведение
  * `task_graph` не переводится в auto-background
* **docs:** зафиксировать Definition of Done и контракт параллельного исполнения

### Bug Fixes

* **remote:** не обрывать холодный старт Source Server раньше бюджета Supervisor
  * внешнее ожидание `ready` увеличено с 10 до 25 секунд и теперь длиннее `CORE_READY_TIMEOUT_MS` (15 секунд)
  * при `crash-loop-stopped` CLI сразу сообщает `lastExitReason`; обычный таймаут показывает последнее состояние и путь к `status.json`
* **release:** пересобирать bundled Source Server при смене commit
  * рядом с bundled-release хранится `source-revision.txt`; при несовпадении с `git rev-parse HEAD` архив собирается заново
  * без commit-маркера (старые релизы) переиспользование запрещено, чтобы фикс не остался вне приложения
* **ui:** показывать команду и детали tool call в office mode
  * summary `execute` и `execute-group` снова содержит текст команды, карточка раскрывается, а `ToolSnapshotFieldNotice` доступен для догрузки полей

### Tests

* **core:** привести ожидания `agent-routing-policy` и `runtime-tool-loop` к действующим правилам leaf-роли researcher и auto-repair

## [3.17.126](https://github.com/m1krot1k1/Zcode/compare/v3.17.125...v3.17.126) (2026-11-18)

### Bug Fixes

* **exec:** действительно выключать OS-песочницу при `sandboxSettings.mode=off`
  * `sandboxMode`/`sandboxAllowNetwork` доходят от Host preferences через `AgentRuntimeConfig` до `ToolExecutionContext` Bash и PTY
  * при `off` команда не оборачивается в bwrap/seatbelt, результат сообщает `sandbox.mode=none`, а окружение процесса передаётся полностью (`GH_CONFIG_DIR`, `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`)
  * дочерние и fork-сессии наследуют снимок sandbox-настроек родителя
* **remote:** исправить предзаполнение SSH-ключа в форме нового подключения
  * ключ применяется после `resetDraft()` на шаге `settings`, поэтому больше не затирается при нажатии «新建 SSH 连接»

## [3.17.125](https://github.com/m1krot1k1/Zcode/compare/v3.17.124...v3.17.125) (2026-11-18)

### Bug Fixes

* **desktop:** убрать падение composer/palette из-за несовпадения формы подписки `onStreamDelta`
  * RPC `bufferEvent` нормализует функцию-отписку в `IDisposable`; Host больше не падает на `dispose is not a function`
  * `usePromptEnhancer` принимает обе формы подписки и безопасно освобождает её при размонтировании
* **sandbox:** по умолчанию выключить bwrap/seatbelt
  * `sandboxSettings.mode` по умолчанию `off`; сохранённый legacy `auto` трактуется как `off`
  * фактический проброс `off` в Bash/PTY и полное окружение исправлены в 3.17.126
* **remote:** не использовать CDN и не подставлять z.ai endpoints
  * Source Server резолвится только из bundled/mock release; при отсутствии архива сборка падает с явной ошибкой
  * Desktop больше не инжектит `ZCODE_BASE_URL`/`ZAI_*` по умолчанию
  * встроенный provider catalog больше не обновляется с CDN z.ai — читается только bundled config
  * рекомендованные промпты используют локальные иконки вместо `cdn-zcode.z.ai`
* **remote:** подставлять последний использованный SSH private key в форме нового сервера

## [3.17.124](https://github.com/m1krot1k1/Zcode/compare/v3.17.123...v3.17.124) (2026-11-18)

### Bug Fixes

* **desktop:** убрать падение запуска из-за `node-pty` в упакованном agent bundle
  * CLI bundle загружает `node-pty` лениво при первом `create()`; `--prepare-storage` больше не зависит от native-аддона
  * `node-pty` с prebuild целевой платформы стейджится в `resources/glm/node_modules`, поэтому `PtySession` работает без доступа к `app.asar.unpacked`
  * `afterPack` проверяет `lib/index.js` и `prebuilds/<platform>/pty.node` рядом с `zcode.cjs`

## [3.17.123](https://github.com/m1krot1k1/Zcode/compare/v3.17.122...v3.17.123) (2026-11-17)

### Features

* **code-index:** v3 с Tree-sitter AST, графом символов и гибридным поиском (этап 4.3) ([f9e0ff9](https://github.com/m1krot1k1/Zcode/commit/f9e0ff966eac25f4521a09d55a527a511807c9bd))

* **core:** детерминированный автомат сессий, самовосстановление вызовов инструментов и кэширование промптов (этап 4.1) ([47daa22](https://github.com/m1krot1k1/Zcode/commit/47daa22bed3137807e8a7d5c4cf9051deece7de7))

* **exec:** песочница bwrap/Seatbelt, PTY-сессии, Computer Use и auto-repair (этап 4.5) ([4be5c50](https://github.com/m1krot1k1/Zcode/commit/4be5c5027126ad78e55ebe70196f3d5041d1557d))

* **prompts:** промпты v2, когнитивные протоколы и сервис улучшения промптов (этап 4.4) ([b5d7b91](https://github.com/m1krot1k1/Zcode/commit/b5d7b91f848993018b9f73d18445f71890c30eb4))

* **shared:** нотификация мутаций код-индекса, сервисные порты и архитектурная политика этапов 4-5 ([3b84379](https://github.com/m1krot1k1/Zcode/commit/3b84379eb6190669cbaa770779601385c0c364ef))

* **tools:** транзакционное мультифайловое редактирование, движок диффов и фоновые задачи (этап 4.2) ([16c1df2](https://github.com/m1krot1k1/Zcode/commit/16c1df2eff4945daafe66daf3e58f7fe9a8dbcd8))

* **ui:** ghost-text автодополнение, кнопка/команда enhance и единые настройки (этап 4.6) ([0181824](https://github.com/m1krot1k1/Zcode/commit/0181824e16d0a589d0a71e248568ab0505532fd5))

* **zcode-cli:** добавление атомарных файловых транзакций и MultiEdit ([1896ba1](https://github.com/m1krot1k1/Zcode/commit/1896ba1d417ac0d08e67d302470473786cc56957))

* **zcode-cli:** усиление контроля за выполнением вызовов инструментов ([46e96d8](https://github.com/m1krot1k1/Zcode/commit/46e96d8b4d29e9b2b604deb7bef6d9c394290230))
  * восстановление усеченных аргументов вызова инструмента, когда finishReason имеет значение length,
  * добавление детерминированного конвейера самовосстановления для некорректных входных данных JSON/Zod
  * сериализация записи файлов между родительскими и дочерними агентами с помощью общего реестра блокировок файлов и волнового планирования DAG для перекрывающихся путей записи
  * внедрение точек останова для кэша подсказок Anthropic/OpenRouter и нормализация
  * запись переходов между состояниями и пошаговой диагностики в сохраняемые
  * ограничение рабочего контекста и бюджета вывода с учетом рассуждений, чтобы большие


### Bug Fixes

* **privacy:** корректный range-скан pre-push гейта и baseline для уже исправленной истории ([ce0e8db](https://github.com/m1krot1k1/Zcode/commit/ce0e8db033af5b98410e8a20a39b7570a216abb6))
  * `git rev-list --objects -z` не поддерживает `-z`, флаг молча игнорировался, вывод не содержал `path=`, поэтому push-диапазон фактически не сканировался
  * парсинг `rev-list --objects` переведён на построчный формат `<sha> <path>` с обработкой пробелов и C-эскейпинга git
  * добавлен `scripts/privacy-sanitized-history.json` — подавление только для уже исправленных исторических блобов (строгий матч path + blobSha + тип находки, только push-диапазон)
  * механизм вынесен в `scripts/privacy-sanitized-history.mjs` и задокументирован в `docs/testing/pre-push-hook.md`

* **prompts:** синхронизировать PRISM профиль и реестр с compact coding core ([a4d93ec](https://github.com/m1krot1k1/Zcode/commit/a4d93ec8d56de6f22ad33ab6f0ad93c66e6c5dbb))
  * `identity.ts` перегенерирован из `scripts/prism10-runtime-profile.mjs`, поэтому `prism10:check` проходит
  * обязательный маркер в `config/prompts/registry.json` приведён к актуальному тексту (`# Priorities`), поэтому `prompt:check` проходит


### Chores

* **knip:** устранить неиспользуемые экспорты и объявить динамические зависимости (этап 6.5) ([09ee32c](https://github.com/m1krot1k1/Zcode/commit/09ee32cd4f5fb93254a92704d23cb60be5dfbc79))
  * удалён мёртвый код, не входящий в публичные контракты модулей (`tool/patch-apply.ts`, каскад стратегий в `edit-matchers.ts` и 28 неиспользуемых экспортов)
  * устранены три реальных дефекта проводки: подключены `enforceByteLimit` в `hybridSearch`, `compactDatabase` в `indexEngine` и `SystemPromptEnhanceAction` в `SubagentForm`
  * `knip.json` дополнен entry публичных entrypoints по `architecture-policy.yaml` и `ignoreDependencies` для динамически загружаемых `koffi`, `tree-sitter-wasms`, `web-tree-sitter`


### Documentation

* **architecture:** аудит, целевая архитектура, бенчмарки и приёмочные отчёты (этапы 1-6) ([f14af28](https://github.com/m1krot1k1/Zcode/commit/f14af289d2966ccf7e9bdb81ee6492a0f65dd6f0))
