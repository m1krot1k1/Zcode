# ZCode: архитектура, агенты, навыки и реальные причины медленности

Дата: 2026-11-20. Ветка: `dev`, HEAD до этой работы — `880ab6fd`.

Метод: разбор текущего исходного кода и реального model-io запроса из
`~/.zcode/cli/debug/model-io-session_79e076073b036660761887b08b3bcdf2.jsonl`, затем
сверка с настройками `~/.zcode/v2/setting.json` и существующими архитектурными аудитами
репозитория. Внешние источники — только как ориентир по индустрии, не как доказательство
поведения ZCode.

Обозначения: **[код]** — факт из текущего checkout; **[измерение]** — число из реального
запроса/скрипта; **[источник]** — внешний источник; **[вывод]** — интерпретация;
**[гипотеза]** — требует A/B. Все оценки ускорения — гипотезы, не обещания.

---

## 1. Главный вывод

Ощущение «много агентов, но медленно и не профессионально» имеет конкретную причину:

> **ZCode отправляет в модель ~40 000 входных токенов ещё до того, как начал работу.
> Большая часть этого — не задача, а always-on инфраструктура: 54 tool-схемы, каталог
> навыков, каталог агентов, MCP-инструменты плагинов и длинные описания.**

В одном реальном запросе (`querySource: main_turn`, ответ «DEV-OK»):

| Компонент                                      | Символов |   ≈токенов | Доля входа |
| ---------------------------------------------- | -------: | ---------: | ---------: |
| Tool declarations (54 инструмента)             |  105 263 |    ≈26 300 |        66% |
| System prompt (3 блока)                        |   17 880 |     ≈4 600 |        12% |
| Skills + agent listing (одно system-сообщение) |   19 992 |     ≈5 200 |        13% |
| User message + AGENTS.md/контекст              |   10 924 |     ≈2 800 |         7% |
| История/прочее                                 |        — |     ≈1 000 |         2% |
| **Итого provider input**                       |        — | **39 884** |   **100%** |

`cacheReadTokens = 0`: повторного использования префикса нет. Каждый следующий шаг снова
несёт эти ~40k. **[измерение]**

При этом:

- **41 из 54 инструментов помечены `shouldDefer`** — их можно не отправлять сразу, а
  подгружать через `ToolSearch`. Это **67.8%** tool-схемы, ≈18 000 токенов. Но
  `toolSearchMode` в настройках — `"off"`. **[измерение + код]**
- **20 из 54 инструментов — MCP-инструменты плагинов** documents/pdf/presentations/
  spreadsheets. Это 21 823 символа, ≈5 650 токенов, 14% входа. Они подключены, даже если
  пользователь не работает с документами. **[измерение]**
- **Каталог навыков и агентов — 19 992 символа** (10 015 skills + 9 976 agent listing).
  Лимит skills — 20 000, то есть каталог заполнен почти под потолок. **[измерение]**
- **16 специализированных встроенных агентов существовали в runtime, но не были видны в
  Settings.** `SubagentsService` отдавал только `Explore`. Это уже исправлено в этой
  работе. **[код]**
- **У всех встроенных ролей в `skills` стоит `"*"`**, то есть каждый агент может загрузить
  любой навык. Это soft-specialization: роли выглядят специализированными, но каталог
  навыков у них общий. **[код]**
- **`/start` всегда идёт `start → orchestrator → worker`**, даже для одной ограниченной
  задачи. Это две дополнительные model-ступени до начала работы. **[код]**
- **На 16 ГБ host разрешает до 10 одновременных субагентов** (`maxParallelSubagents: 0` →
  min(10 CPU, 8 ГБ / 512 МБ)). Это не «много агентов = быстро», это конкуренция за CPU,
  память и провайдера. **[код + измерение]**

Главная мысль: проблема не в том, что агентов слишком мало или промпты слишком короткие.
Проблема в том, что **слишком много контекста включено постоянно**, а специализация
осталась декларативной. Нужно не «добавить ещё агентов», а сделать **progressive
disclosure**: тонкое постоянное ядро, всё остальное — по требованию.

---

## 2. Как ZCode устроен сейчас

### 2.1 Слои

```
Electron Main
  └─ window-scoped Local Host (на каждое окно)
       ├─ Provider Registry / Model Selection
       ├─ Services: sessions, subagents, skills, MCP, plugins, automations
       └─ Agent process (zcode-cli runtime)
            ├─ Turn loop
            ├─ Context builder (system + skills + tools + messages)
            ├─ Tool registry / executor
            ├─ Subagent runner (start/orchestrator/workers)
            ├─ Compaction / memory / CodeIndex
            └─ Session store (SQLite + JSONL)
```

**[код: `AGENTS.md`, `packages/services`, `apps/zcode-cli/packages/core`]**

Main не владеет task/session-бизнес-состоянием. Host владеет локальным workspace и
форвардит метаданные. Runtime Core — единственный владелец turn loop, tool execution,
subagent admission и compaction. Это правильная граница; основная цена — три уровня
сериализации/форвардинга, но не она главная причина 40k контекста.

### 2.2 Путь одного сообщения

1. UI Composer отправляет prompt в Host.
2. Host выбирает session/route и отправляет в Agent runtime.
3. Runtime собирает контекст: stable identity + dynamic sections + skills catalog +
   agent listing + tool declarations + история.
4. Provider получает запрос; модель отвечает текстом или tool calls.
5. Tool calls исполняются; результаты добавляются в историю.
6. Если модель просит продолжения — ещё один model step с **тем же префиксом**.
7. При `/start` первый шаг — `Task(start)`, затем `start` вызывает `Task(orchestrator)`,
   затем orchestrator запускает worker-ветки.

**[код: `turn-loop.ts`, `context/builder.ts`, `subagent/*`]**

### 2.3 Роли

Встроенный ростер — 16 ролей. **[код: `built-in-profiles.ts`]**

| Группа       | Роли                                                                                 | Инструменты                                       |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Роутеры      | `start`, `orchestrator`                                                              | `Task`, `TodoRead`, `TodoWrite`                   |
| Исследование | `researcher`                                                                         | CodeIndex/Read/Glob/Grep/Bash/Web/Skill, без Task |
| Исполнение   | `debugger`, `implementer`, `coder`, `frontend-coder`, `backend-coder`, `infra-coder` | полный worker-набор + Task                        |
| Проверка     | `reviewer`, `security-reviewer`, `test-engineer`, `evaluator`                        | read-only/Bash, Task только для researcher-веток  |
| Мета         | `self-improver`, `knowledge-curator`, `subagent-factory`                             | worker-набор                                      |

Роутеры не читают репозиторий: это сделано специально, чтобы они не начинали
самостоятельное исследование вместо делегирования. Worker-роли имеют право параллелить
независимые части, но не подниматься до `start`/`orchestrator`.

### 2.4 Навыки

- Навык — это `SKILL.md` + файлы, найденные в project `.agents/skills`, user
  `~/.zcode/agents`/skills, plugin roots. **[код: `bootstrap/src/skills.ts`]**
- `Skill` tool загружает инструкции в текущую сессию; `SkillSearch`/`SkillInstall` работают
  с публичным `skills.sh`. **[код: `handlers/skill*.ts`]**
- У профиля есть `skills: string[]`; `"*"` означает «можно любой навык».
  `FilteredSkillPort` фильтрует `discoverSkills`/`loadSkill` по этому списку.
  **[код: `runtime/methods/subagent/skill-port.ts`]**
- В Settings навыки и агенты — разные сущности. Установка навыка **не создаёт агента**,
  который его использует. `subagent-factory` умеет создать профиль вручную, но
  автоматической упаковки «навык → агент» нет. **[код + вывод]**

### 2.5 Инструменты

Фактический запрос содержал 54 инструмента. Группы:

| Группа                | Примеры                                                                                 | Символов |
| --------------------- | --------------------------------------------------------------------------------------- | -------: |
| Делегирование/control | `Agent`, `Task`, `TaskOutput`, `TaskStop`, `SendMessage`, `ReadSessionContext`          |   27 789 |
| Plugin MCP            | documents/pdf/presentations/spreadsheets, по 5 инструментов                             |   21 823 |
| Core coding           | `Read`, `Write`, `Edit`, `ApplyPatch`, `MultiEdit`, `Bash`, `Glob`, `Grep`, `CodeIndex` |   16 922 |
| Automation            | `Cron*`, `OffPeak*`                                                                     |   14 900 |
| Skills                | `Skill`, `SkillSearch`, `SkillInstall`, `InstallCapability`                             |    5 385 |
| Прочее                | `AskUserQuestion`, `Web*`, `EnterPlanMode`, `Todo*`, `node_repl`                        |   15 119 |

**[измерение: разбор `request.body.tools`]**

41 инструмент помечен `shouldDefer` или является MCP. `ToolSearch`/`DeferredToolCall` уже
реализованы и умеют local/native режимы. Но в настройках `toolSearchMode: "off"`, поэтому
все 54 схемы уходят в модель. **[код + измерение]**

### 2.6 Модели и routing

- Provider Registry поддерживает built-in, personal, account и runtime-провайдеры.
- `start`/`orchestrator`/`Explore`/`general-purpose` могут иметь model override; остальные
  worker-роли наследуют модель сессии. **[код: `subagents-types.ts`]**
- До этой работы формальная схема `subagentRuntimeStateSchema` и
  `normalizeBuiltInSelectionOverrides()` **отбрасывали** override для `start`/`orchestrator`,
  хотя state migration и UI их поддерживали. То есть «дешёвый роутер» не сохранялся.
  Исправлено. **[код + тест]**
- Один и тот же provider/model обслуживает main turn, роутеры, worker-роли, autocomplete,
  proactive suggestions и memory extraction, если пользователь не настроил раздельные
  модели. **[код + вывод]**

### 2.7 Контекст

`ContextBuilder` собирает:

- CLI prefix;
- identity (security notice, harness block, compact core, cognitive protocols);
- desktop context, dynamic behavior, session guidance;
- memory, context ledger, env, workspace facts;
- output style;
- skills + agent listing (meta user);
- tool declarations (provider field);
- messages.

Stable prefix кэшируется через `cacheControl: ephemeral` в Anthropic-совместимых
провайдерах. Для custom OpenAI-compatible/DeepSeek фактический `cacheReadTokens` был 0.
**[код + измерение]**

---

## 3. Что именно тормозит

### 3.1 40k входа на тривиальном ходе

Реальный запрос: **39 884 input tokens**, **4 output tokens**, 2 082 мс. Это не «модель
долго думает»; это «система много отправляет». На длинной сессии каждый шаг повторяет
этот префикс, а история растёт. **[измерение]**

### 3.2 Tool search выключен

`toolSearchMode: "off"` — главный переключатель, который уже реализован, но не включён.
Если включить `local`/`auto`:

- resident: 13 инструментов, 32 904 символа;
- deferred: 41 инструмент, 69 238 символов;
- вход падает примерно на **18 000 токенов** (45%). **[измерение + арифметика]**

Это не бесплатно: модель должна вызвать `ToolSearch`, чтобы открыть отложенный инструмент.
Но для 41 инструмента это почти всегда выгоднее, чем держать все схемы постоянно.
**[гипотеза, требует A/B]**

### 3.3 MCP-плагины всегда подключены

20 инструментов документов/PDF/презентаций/таблиц — 21 823 символа, ≈5 650 токенов, 14%
входа. Если пользователь не работает с документами, это чистый налог. Tool search скроет
их схемы, но сами MCP-серверы всё равно подключаются и потребляют ресурсы. Нужен lazy MCP:
подключать сервер при первом обращении к его инструменту. **[вывод]**

### 3.4 Каталог навыков и агентов — 20k символов

Одно system-сообщение: 82 строки навыков (10 015 символов) + 23 строки агентов (9 976).
Лимит `skills.metadataBudget = 20 000`; каталог почти заполнен. Модель видит все навыки и
все роли на каждом запросе, даже если задача — «поправь одну строку». **[измерение]**

Что делать:

- снизить бюджет до 10–12k и включать описания, пока они помещаются, остальные — только
  именами;
- сжать agent listing до имени + одной строки, без полного списка tools у каждой роли;
- для subagent-ролей показывать только их preferred skills, а остальные — через
  `SkillSearch`. **[гипотеза]**

### 3.5 Все агенты — «специалисты» с `skills: ["*"]`

У `start`, `orchestrator`, `coder`, `reviewer` и остальных в списке навыков стоит `"*"`.
`FilteredSkillPort` считает `"*"` разрешением на любой навык. Поэтому:

- каталог навыков у всех одинаково большой;
- модель не получает сигнала «этот агент умеет именно это»;
- специализация держится на тексте промпта, а не на границе возможностей.

Это и есть ощущение «одни и те же агенты». Нужно разделить:

- **preferred skills** — что показывать в каталоге и считать специализацией;
- **allowed skills** — что разрешено загрузить, включая marketplace.

`"*"` можно оставить как fallback, но каталог должен быть role-scoped. **[вывод]**

### 3.6 16 агентов были невидимы

`createBuiltInAgents()` возвращал только `Explore`; `BUILT_IN_AGENT_NAMES` — только
`Explore`. Поэтому Settings показывал `Explore` и plugin-агентов `visual-judge`, а
`debugger`, `reviewer`, `security-reviewer`, `test-engineer`, `frontend-coder` и остальные
не показывал. Это уже исправлено: теперь в Settings видны все 16 + `Explore`, у строк есть
бейдж concrete skills, а `start`/`orchestrator` можно назначить отдельную модель.
**[код + тест]**

### 3.7 `/start` всегда добавляет две ступени

`START_ONLY_ORCHESTRATOR_CONTRACT` запрещает `start` вызывать worker напрямую. Даже для
одной ограниченной задачи маршрут:

```
root → Task(start) → Task(orchestrator) → Task(coder)
```

Это две дополнительные model-ступени, каждая со своим контекстом и TTFT. Для большой
многокомпонентной задачи это оправдано; для «поправь кнопку» — нет. `decideDelegationRoute`
уже умеет `delegate_single`; контракт промпта его не использует. Нужен fast path:
`start` может делегировать одну ограниченную задачу сразу worker-роли, а `orchestrator`
вызывать только при ≥2 независимых ветках. **[код + вывод]**

### 3.8 Слишком много субагентов на 16 ГБ

`maxParallelSubagents: 0` означает «host capacity». На этой машине:

```
CPU bound = 10
memory bound = 16 ГБ * 0.5 / 512 МБ = 16
effective = min(10, 16) = 10
```

То есть до 10 одновременных агентов. Каждый — отдельный runtime/процесс, Bash, файлы,
модельные запросы. На 16 ГБ это конкурентная нагрузка, а не ускорение. Для такой машины
разумнее 3–5. **[код + измерение]**

### 3.9 Нет prompt cache и observation masking

`cacheReadTokens = 0`; каждый шаг платит заново. Для Anthropic cache control уже есть; для
custom OpenAI-compatible/DeepSeek нужно проверить, поддерживает ли провайдер prefix cache
и присылает ли usage. Если нет — это ограничение провайдера, но его нужно знать.

Старые `Read`/`Bash` результаты остаются в истории. Нет observation masking: модель тащит
простыни файлов и команд через десятки шагов. Аудит `stage1-forensic-audit-and-baseline.md`
уже фиксировал F-04: 444k контекста, 20.47M input tokens, cache 0. **[код + документ]**

### 3.10 Фоновые вызовы конкурируют с основным ходом

В логах есть повторяющиеся `proactive_suggestion` (249 input / 12 output, ~1.8 с),
`chat_autocomplete`, `session_title`, memory extraction. Они используют тот же provider и
могут создавать очередь/rate limit. `promptEnhancerSettings.enabled: true`, autocomplete
включён. Это не главная причина, но на медленном канале/лимитированном провайдере —
заметная. **[измерение + код]**

---

## 4. Что уже исправлено в этой работе

1. **Единый каталог встроенных агентов** в `packages/shared/src/subagent-catalog/builtInAgents.ts`.
2. **Settings показывает все 16 ролей + Explore** как read-only строки.
3. **Бейдж concrete skills** в строке агента; `"*"` не считается навыком.
4. **`start`/`orchestrator` model override больше не теряется**:
   `subagentRuntimeStateSchema` и `normalizeBuiltInSelectionOverrides()` принимают их.
5. **Contract test** сверяет shared-каталог с runtime-ростером.
6. Тесты: shared/services/UI/bootstrap; typecheck UI/bootstrap/services/shared проходит.

Ограничение: это visibility/routing fix, а не решение проблемы 40k контекста. Чтобы
увидеть его в установленном приложении, нужен новый build/release.

---

## 5. Целевая архитектура

### 5.1 Принцип: тонкое постоянное ядро, всё остальное — по требованию

```
Resident (всегда):
  Read, Write, Edit, Bash, Grep, Glob, CodeIndex, Agent/Task, Skill, AskUserQuestion
  + короткий system prompt
  + краткий каталог агентов (имя + 1 строка)
  + краткий каталог preferred skills

Deferred (ToolSearch):
  Cron*, OffPeak*, WebFetch/WebSearch, Todo*, TaskOutput/Stop, SendMessage,
  Enter/ExitPlanMode, workflow tools, node_repl, все MCP-инструменты

Lazy (connect on first use):
  documents/pdf/presentations/spreadsheets MCP servers
  marketplace skills / plugin tools
```

Ожидаемый вход: **20–22k токенов** вместо 39.9k, без потери возможностей — просто они
появляются по запросу. **[гипотеза, основанная на измеренной схеме]**

### 5.2 Роутер быстрый, исполнитель сильный

- `start`/`orchestrator` — дешёвая/быстрая модель, маленький контекст, только Task/Todo.
- `coder`/`debugger`/`frontend`/`backend` — сильная модель сессии.
- `reviewer`/`test-engineer` — средняя модель, read-only/Bash.
- Autocomplete/proactive/title — отдельная лёгкая модель, не конкурирует с main turn.

Теперь это можно настроить через Settings после фикса roster. Нужно добавить UI-подсказку
и, возможно, дефолт для новых установок.

### 5.3 Специализация: навык → агент

- У профиля два поля: `preferredSkills` (каталог, который видит модель) и `allowedSkills`
  (что можно загрузить, включая marketplace).
- `"*"` остаётся только как fallback, но не попадает в каталог.
- `SkillInstall` может предложить «создать агента под этот навык»; `subagent-factory`
  валидирует профиль на реальной задаче.
- Settings показывает, какие навыки реально используются агентом, и кто их выбрал.

### 5.4 Один владелец каталога

Shared-каталог (уже добавлен) — единственная проекция для Settings/Services. Runtime
промпты остаются в Core; contract test не даёт каталогам разойтись. Следующий шаг —
перенести `preferredSkills` в этот же каталог и использовать его в `FilteredSkillPort`.

### 5.5 Наблюдаемость

В чате уже есть Context Usage panel. Нужно, чтобы он показывал:

- tool schemas (system vs MCP) — сколько токенов;
- skills/agent listing — сколько;
- cache read/write;
- tool calls per step;
- subagent wait time;
- malformed tool calls.

Без этого пользователь не понимает, почему «агентов много, а быстро не стало».

---

## 6. План внедрения

### P0 — контекст и ресурсы (сначала это)

| #    | Что                                                                                                     | Ожидаемый эффект                         | Риск                                      | Файлы                                                      |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| P0.1 | Включить `toolSearchMode: auto` для моделей с tool calls; one-time migration с сохранением явного `off` | −45% input, −20–40% TTFT/стоимости       | средний: модель должна освоить ToolSearch | `validationAppSettings.ts`, `tool/search/exposure.ts`, E2E |
| P0.2 | Lazy MCP: не подключать documents/pdf/presentations/spreadsheets без первого обращения                  | −14% input + меньше процессов            | средний                                   | `mcp-sync`, `plugin-runtime-catalog`, startup              |
| P0.3 | Сжать skills/agent listing: бюджет 10–12k, partial descriptions, agent listing в 1 строку               | −8–12% input                             | низкий                                    | `context/sections/skills.ts`, `subagent/listing.ts`        |
| P0.4 | Снизить `maxParallelSubagents` на 16 ГБ до 4–6 (1 ГБ/агент + резерв)                                    | меньше contention, стабильнее wall-clock | низкий                                    | `runtime-task/registry-types.ts`                           |
| P0.5 | `workingContextCeilingTokens` 120k → 80k + observation masking старых tool outputs                      | короче контекст, дешевле шаги            | средний: можно потерять детали            | `runtime-config`, compact/history                          |
| P0.6 | Проверить и включить prompt cache для поддерживаемых провайдеров; показывать cache hit                  | 50–90% input cost на cached prefix       | зависит от провайдера                     | `adapters/model/cache-control`, provider factory           |

### P1 — routing и специализация

| #    | Что                                                                                          | Ожидаемый эффект                                      | Риск                         |
| ---- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| P1.1 | Fast path `start → worker` для одной ограниченной задачи; `orchestrator` только для ≥2 веток | −1 model call, −20–50% latency на малых задачах       | средний: routing consistency |
| P1.2 | Дефолт/подсказка «быстрая модель для start/orchestrator»                                     | быстрее планирование, дешевле                         | низкий                       |
| P1.3 | `preferredSkills` + role-scoped каталог; `"*"` только fallback                               | меньше контекста, реальная специализация              | средний                      |
| P1.4 | «Создать агента из навыка» в marketplace + валидация factory                                 | пользователь видит агентов, которые используют навыки | средний                      |
| P1.5 | Изолировать фоновые вызовы (autocomplete/proactive/memory) от main turn                      | меньше очередь/rate limit                             | низкий                       |

### P2 — качество и доказательства

| #    | Что                                                                        | Зачем                             |
| ---- | -------------------------------------------------------------------------- | --------------------------------- |
| P2.1 | Context Usage panel: breakdown по tools/MCP/skills/cache                   | чтобы решения были измеримыми     |
| P2.2 | A/B 50–100 задач: base vs tool-search vs fast-router vs role-scoped skills | не верить гипотезам               |
| P2.3 | Observation masking + tool result summaries                                | длинные сессии без 400k контекста |
| P2.4 | File locks/worktrees для параллельных writer-агентов                       | аудит stage1 уже показал гонки    |
| P2.5 | Local model start-gate (отдельный spec)                                    | локальный 27B без автозапуска     |

---

## 7. Что не делать

- **Не добавлять ещё агентов и ещё промпты.** Сначала убрать always-on контекст.
- **Не включать все настройки сразу.** Tool search и lazy MCP могут сломать привычные
  сценарии; нужен A/B и fallback.
- **Не снижать контекст без observation masking.** Иначе модель потеряет нужные факты.
- **Не запускать 10 агентов на 16 ГБ.** Это не параллелизм, а thrashing.
- **Не использовать одну тяжёлую модель для роутера и исполнителя.** Роутер должен быть
  быстрым и дешёвым.
- **Не считать «агент создан» доказательством специализации.** Нужны трассы: какие skills
  реально загружены, какие роли реально вызваны.

---

## 8. Метрики, по которым проверять

- input tokens per turn (по категориям: tools, MCP, skills, system, messages);
- cache read/write tokens;
- TTFT и total turn time;
- tool calls per step и malformed tool calls;
- subagent wait time и active parallel;
- `error_max_turns` и context overflow;
- pass@1 на 50–100 задачах ZCode;
- стоимость на задачу.

50 задач дают примерно ±14 п.п. на 95% интервале; для +10 п.п. нужно ~100 задач или
несколько повторов. **[источник: методика Harness Hub]**

---

## 9. Внешние ориентиры

- Anthropic, «Building effective agents»: простые workflows, routing, orchestrator-workers,
  evaluator-optimizer; не строить сложную мультиагентность там, где хватает одного агента.
- Anthropic, «Effective context engineering for AI agents»: compaction, observation masking,
  just-in-time retrieval; контекст — дефицитный ресурс.
- Anthropic, «Introducing Agent Skills» и `SKILL.md`: навыки как переиспользуемые пакеты
  инструкций, загружаемые по требованию.
- Anthropic tool search / deferred tools: не отправлять все tool schemas сразу.
- OpenAI Agents SDK: handoffs, guardrails, sessions; явные роли и передача контекста.
- Claude Code subagents: специализированные агенты с собственным контекстом и tools.
- `skills.sh`: публичный marketplace навыков; полезен, но требует curation и проверки.
- RouteLLM и routing-подходы: дешёвый роутер + сильная модель.
- OpenTelemetry GenAI semconv: единые метрики/трейсы для моделей и инструментов.

Ссылки:

- https://www.anthropic.com/engineering/building-effective-agents
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/news/skills
- https://openai.github.io/openai-agents-js/
- https://docs.anthropic.com/en/docs/claude-code/sub-agents
- https://skills.sh
- https://github.com/lm-sys/RouteLLM
- https://opentelemetry.io/docs/specs/semconv/gen-ai/

---

## 10. Ограничения

- Разобран один реальный model-io запрос; тяжёлые сессии пользователя в этом checkout
  отсутствуют, поэтому распределение tool calls/агентов по длинным задачам не измерено.
- Токены tool-схем пересчитаны по 3.86 символа/токен из фактического provider usage;
  это оценка, не BPE.
- 33/54 инструмента — срез текущей сессии; точный набор зависит от плагинов, портов и
  gate-флагов.
- Все проценты ускорения в P0/P1 — гипотезы до A/B.
- Код в этой работе меняет только roster/overrides; tool search, lazy MCP, skill scoping
  и routing fast path не реализованы.

---

## 11. Что сделать прямо сейчас

1. Открыть Settings → Subagents: теперь должны быть видны все 16 ролей и `Explore`.
2. Назначить `start` и `orchestrator` быструю/дешёвую модель, если она есть.
3. Открыть Context Usage в чате и посмотреть, сколько занимают tools/MCP/skills.
4. На 16 ГБ поставить `maxParallelSubagents` = 4.
5. Если провайдер и модель уверенно работают с tool search — включить
   Settings → General → Tool search → Auto/Local и сравнить качество/скорость.
6. Не включать все плагины документов, если они не нужны: это 20 инструментов и ~14%
   входа.
