# Changelog

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
