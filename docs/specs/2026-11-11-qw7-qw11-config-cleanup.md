# QW7/QW11: чистка мёртвых записей vitest и удаление нереализованного `isolation`

## Назначение

Две независимые правки, обе — удаление кода/конфигурации, которая объявляет возможности,
которых нет в текущем исходнике:

- **QW7** — из корневого `vitest.config.ts` убрать записи, указывающие на несуществующие
  файлы тестов. Пока они там, `fork-isolated` project ссылается на пустоту, а `exclude`
  содержит мёртвые пути; это скрывает реальный состав сьютов.
- **QW11** — убрать `isolation` из строгой схемы workflow-скриптов. Поле объявлено в
  контракте и описании модели, но единственный runtime-читатель бросает
  `not implemented yet`, то есть схема обещает функциональность, которой нет.

Обе правки не меняют продуктовое поведение за пределами заявленного: ни один live-тест не
перестаёт собираться, ни одна реализованная возможность не теряется.

## 1. QW7: мёртвые записи корневого vitest-конфига

### Владелец и границы

Единственный владелец — `vitest.config.ts` в корне репозитория: массив
`forkIsolatedTests` (`vitest.config.ts:11`) и его единственные потребители —
`exclude` unit-проекта (`vitest.config.ts:108`, было `:123`) и `include` проекта
`fork-isolated` (`vitest.config.ts:119`, было `:134`). Второй источник правды для
串行-группы не создаётся.

### Удаляемые записи `forkIsolatedTests` (файлы отсутствуют)

Проверено поиском по дереву; ни одного из перечисленных путей в репозитории нет:

| Строка (до правки) | Запись                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| 15                 | `packages/desktop/test/r3RemoteProcess.test.ts`                         |
| 24                 | `packages/desktop/test/e2eSummarySpecCoverage.test.ts`                  |
| 25                 | `packages/desktop/test/migrateStableFeedScript.test.ts`                 |
| 27                 | `packages/desktop/test/uploadOssScript.test.ts`                         |
| 29                 | `packages/desktop/test/notarizeMacosScript.test.ts`                     |
| 30                 | `packages/desktop/test/publishReleaseScript.test.ts`                    |
| 32                 | `packages/web/test/remoteFrontendBuildSource.test.ts`                   |
| 34                 | `packages/desktop/test/dev-cua-plugin-runtime.test.ts`                  |
| 38                 | `packages/provider-node/test/builtin-provider-build.test.ts`            |
| 39                 | `packages/provider-node/test/builtin-provider-test-config-sync.test.ts` |

### Удаляемые записи `include` unit-проекта (файлы отсутствуют)

| Строка (до правки) | Запись                                           |
| ------------------ | ------------------------------------------------ |
| 120                | `scripts/assert-safe-cua-helper-zip.test.mjs`    |
| 121                | `scripts/ci/ci-telemetry-keyword-guard.test.mjs` |

`scripts/ci` как каталог отсутствует, поэтому второй путь тем более не существует.

### Что сохраняется

- Все live-записи `forkIsolatedTests` остаются без изменений — включая причины串行-изоляции,
  зафиксированные в комментариях. Фактический состав после правки: `:4-9`
  (`processLifecycleTests`), `:12` (spread), `:15`, `:17`, `:19-23`, `:25-27`, `:30`,
  `:33-36`, `:39`, `:44` — см. текущий файл, номера строк сместились после удаления.
- Комментарии, которые описывали именно удалённые записи, становятся неверными после
  их удаления (например, «发布脚本…» над живой записью `webRemoteControlTransport`),
  поэтому удалены вместе с записями: оставлять объяснение к несуществующему тесту
  означало бы документировать не то поведение. Комментарии, относящиеся к живым
  записям, сохранены дословно, кроме одного, где убрано упоминание удалённого
  `r3RemoteProcess` («真实显示进程树和…» → «独立配置读者…»).
- Состав проектов (`unit`, `fork-isolated`, `packages/zcode-cua/vitest.config.ts`),
  порядок групп, `pool`, `maxWorkers` не меняются.
- Сбор `.tsx`, широкие glob-шаблоны и любые новые включения не добавляются.

### Проверяемый эффект

- В `fork-isolated` не остаётся ни одного пути, для которого нет файла.
- В `include` unit-проекта не остаётся ни одного несуществующего `.mjs`-пути.
- Живые записи сохраняют串行-семантику (`pool: "forks"`, `fileParallelism: false`,
  `maxWorkers: 1`), поэтому поведение известных нестабильных тестов не меняется.

## 2. QW11: удаление `isolation` из workflow-контракта

### Владелец и границы

- Контракт схемы — `apps/zcode-cli/packages/contracts/src/workflow/script.ts`:
  `WorkflowAgentIsolationSchema` (:42), тип `WorkflowAgentIsolation` (:43) и поле
  `isolation` в `WorkflowAgentOptionsSchema` (:49). Это единственное место объявления.
- Единственный runtime-читатель поля — `WorkflowAgentCallInputSchema.parse` в
  `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts:220`
  (запрос дочернего процесса) и ветка-заглушка в `runLiveAgent` (:282-284).
- Модельное описание — `apps/zcode-cli/packages/core/src/tool/handlers/workflow-description.ts`
  (сигнатура `agent()` и абзац про `opts.isolation`).
- Документация формата вызова — `apps/zcode-cli/docs/design/v2/workflow-script.md:122`.
- Регрессионный тест — `apps/zcode-cli/packages/contracts/tests/workflow-scheduler-state.test.ts`.

### Правило

1. `WorkflowAgentIsolationSchema` и его inferred-тип удаляются из контракта; повторное
   объявление enum в другом месте не создаётся.
2. Поле `isolation` удаляется из `WorkflowAgentOptionsSchema`. Схема остаётся `.strict()`,
   поэтому любой `isolation` в `agent(..., { isolation: ... })` отклоняется на разборе
   (`Unrecognized key(s) in object: 'isolation'`).
3. Ветка-заглушка в `runLiveAgent` удаляется: единственный путь, который мог до неё
   дойти, — уже провалидированный payload, а поле больше не проходит валидацию. Это
   сохраняет fail-closed: скрипт с `isolation` падает на `WorkflowAgentCallInputSchema.parse`
   до создания дочерней сессии, а не после.
4. Из модельного описания убираются поле в сигнатуре `agent()` и абзац, обещающий
   worktree-исполнение. Пример «Migrate» больше не упоминает worktree isolation, чтобы
   описание не рекламировало несуществующую опцию.
5. `docs/design/v2/workflow-script.md` больше не содержит `isolation?: "worktree"` в
   контракте `agent()`.
6. Регрессионный тест перестаёт передавать `isolation` в валидный вызов и явно
   утверждает отказ на `Unrecognized key`, фиксируя удаление.

### Совместимость (обязательная заметка)

- Сохранённые скрипты, использующие `isolation`, теперь **падают на разборе** вызова
  `agent()`, а не на runtime-заглушке `not implemented yet`. Ошибка возникает раньше и
  до создания дочерней сессии; тихая деградация (запуск без изоляции) невозможна.
- Персистентные строки, где `opts_json` уже содержит `isolation`, **продолжают
  читаться**: `decodeActivity` декодирует `opts_json` через `decodeJson<WorkflowAgentOptions>`
  без повторной валидации схемой
  (`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-codecs.ts:158`).
  Повреждения хранимых данных удаление поля не вызывает.
- Повторный запуск/resume такого сохранённого скрипта снова исполняет `agent(...)` и
  снова упирается в отказ на разборе — это ожидаемое fail-closed поведение, а не
  потеря данных.
- Важно для сборки: `@zcode/contracts` подключается из `dist/` (`package.json`
  `main`/`exports`), а `dist/` в `.gitignore`. Пока пакеты не пересобраны
  (`pnpm -r build`), возможны смешанные состояния артефактов. Пересборка в порядке
  зависимостей безопасна: контракт перестаёт принимать `isolation` раньше, чем
  bootstrap перестаёт его отвергать, поэтому промежуточное состояние остаётся
  fail-closed. Источник правды — `src/`; `dist/` руками не правится.

## 3. Сценарии приёмки

| ID      | Сценарий                                                                                                                | Ожидаемо                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QW7-A1  | Поиск каждого из 10 удалённых путей в рабочем дереве                                                                    | Ни один файл не найден; записи из конфига удалены                                                                                                                                     |
| QW7-A2  | Поиск `scripts/assert-safe-cua-helper-zip.test.mjs` и `scripts/ci/ci-telemetry-keyword-guard.test.mjs`                  | Файлов нет; `scripts/ci` отсутствует; записи из `include` удалены                                                                                                                     |
| QW7-A3  | Чтение `forkIsolatedTests` после правки                                                                                 | Остались только live-пути; объяснения относятся только к живым записям                                                                                                                |
| QW7-A4  | `fork-isolated` project                                                                                                 | `pool: "forks"`, `fileParallelism: false`, `maxWorkers: 1` без изменений                                                                                                              |
| QW11-A1 | `WorkflowAgentCallInputSchema.parse({ opts: { label: "x" }, prompt: "p" })`                                             | Успех                                                                                                                                                                                 |
| QW11-A2 | `WorkflowAgentCallInputSchema.parse({ opts: { isolation: "worktree" }, prompt: "p" })`                                  | Ошибка разбора, сообщение содержит `Unrecognized key`                                                                                                                                 |
| QW11-A3 | Поиск `WorkflowAgentIsolation` / `opts.isolation` в `apps/zcode-cli/packages/*/src` и `apps/zcode-cli/packages/*/tests` | Совпадений нет (кроме комментария-объяснения в `script.ts` и самого нового теста с отрицательной проверкой). Совпадения в `docs/research/**` — исторические снимки, не переписываются |
| QW11-A4 | Чтение persisted-строки с `opts_json = {"isolation":"worktree"}`                                                        | Декодируется без ошибки (валидация схемы на чтении не выполняется)                                                                                                                    |
| QW11-A5 | Модельное описание `Workflow`                                                                                           | Больше не содержит `isolation`                                                                                                                                                        |

## 4. Вне области

- Реализация worktree-изоляции для workflow-агентов.
- Изменение串行-состава тестов сверх удаления мёртвых путей (новые `.tsx`-включения,
  расширение glob-шаблонов).
- Правка собранных артефактов `dist/` — они пересоздаются сборкой.
- Поле `isolation` у Agent-инструмента (`tool/07-subagent.md`) и MCP-конфигурации —
  это другие контракты, они не затрагиваются.

## 5. Проверка

Узкие проверки перечислены в сценариях приёмки. Фактический запуск фиксируется в
отчёте о выполнении: `pnpm typecheck` (contracts/bootstrap/core), целевой
`vitest run packages/contracts/tests/workflow-scheduler-state.test.ts` и проверка
конфигурации. Если окружение не позволяет запустить команды, это указывается явно как
`not_run`, а не как успех.
