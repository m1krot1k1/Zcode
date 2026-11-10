# Видимость Task alias и единый владелец правила

## Назначение

`Task` — совместимый alias `Agent`, а не отдельная возможность делегирования. Модель должна
видеть его в provider schema только там, где делегирование разрешено продуктовой ролью сессии,
и не видеть в workflow-акторах. Одно и то же правило должно применяться при первичной
регистрации built-in инструментов и при любом refresh, который перерегистрирует набор.

## Владелец состояния

- Владелец решения «показывать ли `Task`» — один общий helper в
  `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`:
  `shouldIncludeTaskAlias(taskType)` рядом с `resolveBuiltInToolAllowlist` и
  `resolveRuntimeDisallowedTools`. Helper — чистая функция от
  `AgentRuntimeConfig["taskType"]`, без чтения registry, портов и mutable runtime state.
- Оба пути регистрации обязаны использовать этот helper и не дублировать список `taskType`:
  - первичная сборка — `registerRuntimeBuiltInTools` в `runtime-tools.ts`;
  - refresh — `refreshBranchAwareBuiltInTools` в `embedded-search-branch.ts`, который
    вызывается в том числе из `applySessionShellEnvironment` (путь
    `initializeSessionShellEnvironmentIfNeeded`) и из активации dynamic workflow.

## Контракт

```ts
type SessionTaskType =
  | "interactive"
  | "fork"
  | "selection_side_chat"
  | "workflow_parent"
  | "workflow_child"
  | "subagent_child"
  | "nested_workflow_child";

// undefined — корневая/обычная сессия без явного taskType.
function shouldIncludeTaskAlias(taskType: SessionTaskType | undefined): boolean;
```

- `Task` provider-visible (`metadata.providerVisible: true`) для `taskType`:
  `undefined`, `interactive`, `fork`, `selection_side_chat`, `subagent_child`.
- `Task` скрыт (`providerVisible: false`, поведение совместимого alias по умолчанию) для
  `workflow_parent`, `workflow_child` и `nested_workflow_child`. Для `workflow_parent`
  отдельного правила нет: он просто не входит в явный allow-список helper'а, и alias остаётся
  скрытым, как у любого не перечисленного taskType.
- Сама регистрация `Task` entry по-прежнему управляется `includeAgent`/allowlist: helper
  решает только видимость alias, когда `Task` вообще зарегистрирован.
- При refresh состояние обязано совпадать с первичной регистрацией: refresh передаёт в
  `registerBuiltInTools` то же значение `includeTaskAlias`, а также те же
  `resolveBuiltInToolAllowlist` и `resolveRuntimeDisallowedTools`. `silentDuplicateWarnings`
  не должен маскировать расхождение: registry перезаписывает запись, поэтому второй путь
  обязан явно передавать alias-флаг, а не полагаться на прежнюю регистрацию.
- Списки/порядок `taskType` не дублируются в `runtime-tools.ts`, `embedded-search-branch.ts`
  или `resolveRuntimeDisallowedTools`; изменение правила делается в одном helper.

## Инварианты

1. Один владелец правила: только общий helper решает видимость `Task` по `taskType`.
2. Первичная регистрация и refresh дают одинаковый `toContracts()` ответ для одинакового
   `AgentRuntimeConfig` и одинакового набора портов.
3. `workflow_child` и `nested_workflow_child` не видят `Task` ни до, ни после shell-init
   refresh; workflow actor не получает alias как побочный эффект повторной регистрации.
4. `subagent_child` видит `Task` только если профиль и все предки разрешают `Agent`/`Task`;
   helper не расширяет права и не обходит `filterSubagentChildToolNames`.
5. Disallowlist `Agent` или `Task` закрывает оба имени на всех уровнях; helper не воскрешает
   alias после refresh.
6. `Task` остаётся alias-ом `Agent`: вызов идёт через тот же handler, точную проверку активного
   profile ID и тот же task registry/root budget/cancellation lineage.

## Alias-развёртывание disallowlist на трёх границах

Инвариант 5 требует явного развёртывания пары `Agent`↔`Task` до сравнения по точному имени.
Раньше оно существовало только на turn-уровне (`buildTurnDisallowedTools`, inline) и в
`filterSubagentChildToolNames`; `registerBuiltInTools` и `PermissionService` сравнивали
`options.disallowedTools`/`context.toolName` буквально. Поэтому `toolDisallowlist: ["Agent"]`
скрывал `Agent`, но оставлял `Task` provider-visible и исполняемым.

Правило живёт в одном helper'е `runtime/helpers/tool-allowlist.ts`:

```ts
// Чистая функция; разбирает rule syntax через getToolRuleName, поэтому "Agent(*)" тоже матчится.
function expandSubagentDispatchDisallowRules(
  rules: readonly string[] | undefined,
): readonly string[] | undefined;
```

- Если во входном списке есть правило, чьё имя — `Agent` или `Task`, helper добавляет в результат
  оба имени (`AGENT_TOOL_NAME`, `TASK_TOOL_NAME` из `tool/compat.ts`); иначе возвращает вход без
  изменений. Другие инструменты не затрагиваются.
- Call-site 1 — граница регистрации: `registerBuiltInTools`
  (`tool/handlers/index.ts`) разворачивает `options.disallowedTools` до
  `createToolRuleNameSet`. Это закрывает оба входа регистрации (`runtime-tools.ts` и refresh
  в `embedded-search-branch.ts`) и прямые вызовы `registerBuiltInTools`.
- Call-site 2 — permission boundary: `PermissionService` (`permission/service.ts`) применяет
  тот же helper в `isToolDisallowed`, который вызывают все три места `checkPermission`
  (requiresUserInteraction, обычная ветка, `checkAlwaysAsk`). Список читается из
  `PermissionConfig` на каждой проверке, поэтому прямой вызов `Task` (или hook-инициированный
  вызов) получает `rule.disallowedTools`, как `Agent`, без изменения семантики конфигурации.
- Call-site 3 — turn boundary: `buildTurnDisallowedTools`
  (`runtime/methods/turn-loop-state.ts`) строит множество запрещённых имён как
  `expandSubagentDispatchDisallowRules(state.toolDisallowlist)` и больше не содержит ни
  inline-проверки `has("Agent") || has("Task")`, ни литералов пары. Ветка
  `subagentsDisabled` в `getTurnTools` также разворачивает пару через тот же helper
  (вход `[AGENT_TOOL_NAME]`), чтобы список имён не дублировался в третьем месте.
- Child-фильтр `buildSubagentChildDisallowRules` (`subagent/tool-policy.ts`) не входит в эти
  три границы и сохраняет собственный предикат `isSubagentDispatchRule`; он тоже разбирает
  правило через `getToolRuleName` и разворачивает пару в оба имени, поэтому семантика
  совпадает. Импорт общего helper'а туда не добавлен: файл не входит в границы этого изменения,
  а поведение уже эквивалентно.
- Результат детерминирован и идемпотентен: повторное применение не добавляет новых имён и
  сохраняет порядок исходного списка.

### Scoped-правила `Agent(x)` / `Task(x)` — принятая семантика

`getToolRuleName` отрезает всё после `(`: `Agent(*)`, `Agent(researcher)`, `Task(fork)` дают
соответственно `Agent`, `Agent`, `Task`. Поэтому scoped-правило для dispatch-инструмента
трактуется как **запрет всего инструмента `Agent`/`Task`** на всех трёх границах:

- registration: `["Agent(researcher)"]` скрывает и `Agent`, и `Task`;
- permission: прямой вызов `Agent` или `Task` получает `rule.disallowedTools`;
- turn: `toolDisallowlist: ["Agent(*)"]` убирает оба имени из provider-visible набора.

Это осознанно fail-closed: имя инструмента в provider schema — это `Agent`/`Task` без
аргумента; область действия живёт в `subagent_type`/`allowedTools`/профиле делегирования, а не
в имени инструмента. Правило вида `Agent(researcher)` не несёт адресуемого уровня «только этот
subagent_type»: реализации пришлось бы вводить новый контракт сопоставления правила с
аргументом вызова, а при несовпадении оставлять `Agent` исполняемым для всех остальных типов.
Поэтому partial-scoped семантика не поддерживается; документированный результат — полный
запрет dispatch-пары. Ограничение конкретного `subagent_type` выражается через
`subagent_type`-allowlist профиля, а не через disallow-правило.

## Историческая заметка: устранённое расхождение

До реализации существовали три расхождения, все закрыты одним изменением:

- `runtime-tools.ts` вычислял allow-список `taskType` inline. Теперь список живёт только в
  `shouldIncludeTaskAlias` (`runtime/helpers/tool-allowlist.ts`), а оба входа регистрации
  вызывают его.
- `refreshBranchAwareBuiltInTools` (`runtime/methods/embedded-search-branch.ts`) вызывал
  `registerBuiltInTools` без `includeTaskAlias`. Для `interactive`-сессии это перезаписывало
  ранее видимый `Task` entry версией с `providerVisible: false`; после
  `initializeSessionShellEnvironmentIfNeeded` (через `applySessionShellEnvironment`) alias
  исчезал. Теперь refresh передаёт `includeTaskAlias: shouldIncludeTaskAlias(taskType)`.
- Тот же refresh передавал `disallowedTools: runtime.config.toolDisallowlist` напрямую вместо
  `resolveRuntimeDisallowedTools(runtime.config)`, поэтому структурные запреты
  `workflow_child` после refresh терялись. Теперь refresh использует общий helper.

Регрессия закреплена сквозным тестом
`apps/zcode-cli/packages/core/tests/task-alias-visibility.test.ts`: матрица helper'а и путь
`initializeSessionShellEnvironmentIfNeeded` для всех семи `taskType`, до и после refresh.

## Актуальный контракт обоих путей регистрации

| Путь регистрации                                  | Файл                                        | Значение `includeTaskAlias`                       |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Первичная сборка                                  | `runtime/helpers/runtime-tools.ts`          | `shouldIncludeTaskAlias(runtime.config.taskType)` |
| Refresh (shell-init и активация dynamic workflow) | `runtime/methods/embedded-search-branch.ts` | `shouldIncludeTaskAlias(runtime.config.taskType)` |

Оба вызова передают также `resolveBuiltInToolAllowlist` и `resolveRuntimeDisallowedTools`.
Refresh сознательно не передаёт порт-гейтед опции (`includeSendMessage`,
`includeRespondToCoordinator`, `includeSubmitResult`, `includeEscalate`, `includeWorkflow`,
`includeAutomation`, `includeOffPeak`, `includeNodeRepl`, `includeBrowserUse`,
`includeCodeIndex`): их полярность — «только `true` регистрирует», поэтому пропуск опции в
refresh означает «не перерегистрировать инструмент», и запись, созданная первым проходом по
фактическому порту, остаётся нетронутой. Refresh при этом обновляет общие для обоих входов
опции (`Bash`/embedded search, `Agent`/`Task`, allowlist, disallowlist) и не теряет
структурные запреты. Единственная опция с обратной полярностью — `includeDynamicWorkflow`
(«отсутствие = включено»), поэтому она передаётся явно через
`resolveRuntimeDynamicWorkflowToolsIncluded`.

## Приёмочные сценарии

| ID           | Сценарий                                                                                    | Ожидаемый результат                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TASKALIAS-01 | `taskType` = `undefined`, `interactive`, `fork`, `selection_side_chat` или `subagent_child` | `registry.toContracts()` содержит `Task`; вызов требует точный `subagent_type`.                                                                                                                      |
| TASKALIAS-02 | `taskType` = `workflow_child` или `nested_workflow_child`                                   | `registry.toContracts()` не содержит `Task` и до, и после refresh, вызванного shell-init.                                                                                                            |
| TASKALIAS-03 | Сессия `interactive`, затем `initializeSessionShellEnvironmentIfNeeded`                     | После refresh `Task` остаётся provider-visible; повторная регистрация использует тот же helper.                                                                                                      |
| TASKALIAS-04 | Сессия `workflow_child`, затем shell-init refresh                                           | `Task` не появляется; refresh передаёт `includeTaskAlias: false` через helper.                                                                                                                       |
| TASKALIAS-05 | Профиль/предок запрещает `Agent`, но `taskType` разрешает alias                             | `Task` не provider-visible: `registerBuiltInTools` получает развёрнутый список, `toContracts()` не содержит `Task`; прямой вызов `Task` получает deny `rule.disallowedTools` от `PermissionService`. |
| TASKALIAS-06 | Изменение allow-списка `taskType`                                                           | Правится только helper; тесты первичной регистрации и refresh падают вместе, если пути разошлись.                                                                                                    |
| TASKALIAS-07 | `toolDisallowlist: ["Task"]` при разрешённом alias                                          | `Agent` скрыт на границе регистрации (обратное направление того же развёртывания); вызов `Agent` запрещён permission-сервисом.                                                                       |
| TASKALIAS-08 | Ни `Agent`, ни `Task` не запрещены                                                          | `Task` остаётся provider-visible при `includeAgent: true` и `includeTaskAlias: true`; регрессия B1.                                                                                                  |
| TASKALIAS-09 | Turn-level `toolDisallowlist: ["Agent(*)"]`                                                 | `getTurnTools` не содержит ни `Agent`, ни `Task`; правило со scope трактуется как полный запрет dispatch-пары.                                                                                       |
| TASKALIAS-10 | Turn-level `toolDisallowlist: ["Bash"]`                                                     | `Agent` и `Task` остаются в `getTurnTools`; постороннее правило не задевает пару.                                                                                                                    |

## Проверки

- `apps/zcode-cli/packages/core/tests/runtime-tool-allowlist.test.ts` — taskType-матрица
  первичной регистрации и точный `subagent_type` на schema/handler boundary.
- `apps/zcode-cli/packages/core/tests/task-alias-visibility.test.ts` — матрица helper'а,
  сквозной путь `initializeSessionShellEnvironmentIfNeeded` (Task до и после refresh для всех
  семи `taskType`), сохранность структурного disallowlist `workflow_child`, сохранность/отсутствие
  порт-гейтед инструментов после refresh, alias-развёртывание на registration boundary
  (`registerBuiltInTools` через `resolveRuntimeDisallowedTools`), permission boundary
  (`PermissionService.checkPermission`) для направлений `Agent→Task`, `Task→Agent` и
  разрешённой пары (TASKALIAS-05/07/08), а также turn boundary через
  `getTurnTools`/`buildTurnDisallowedTools`: `["Agent(*)"]` и `["Task"]` скрывают оба имени,
  `["Bash"]` не трогает пару, обычный turn без disallow сохраняет `Task` (TASKALIAS-09/10).
