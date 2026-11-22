# C2 — IDE-встроенные и open-source агентские расширения: Cline, Kilo Code, Roo Code, Continue, Goose, Amp

> Research-only артефакт. Продуктовый код, конфиги, зависимости и lockfile не изменялись.
> Branch ID: **C2**. Дата исследования и дата доступа ко всем источникам: **2026-11-11**.
> Baseline репозитория на момент сбора: ветка `dev`, HEAD `d10f0b69`, `git status --porcelain` до записи — только `?? docs/research/`.
> Единственная запись этого филиала — данный файл.

## 1. Scope and method

### 1.1. Вопрос и границы

Задача: собрать первоисточники по шести продуктам класса «агент, встроенный в IDE, и/или open-source агентское расширение» — Cline, Kilo Code, Roo Code, Continue, Goose, Amp — и извлечь **конкретные цитируемые механики** (конфигурационные ключи, режимы, форматы файлов, модели разрешений), а не маркетинговые описания. Отдельно требуется кросс-продуктовая матрица и синтез различий.

Что считается первоисточником в этом отчёте:

- официальная документация продукта (docs-сайт, `llms.txt`, raw-markdown endpoint);
- официальный GitHub-репозиторий: GitHub API (лицензия, `archived`, `pushed_at`), raw-файлы исходников, releases API;
- официальный changelog/новости/блог вендора;
- официальная страница тарифов.

Вторичные обзоры, сравнения «X vs Y» сторонних сайтов и поисковые сниппеты как единственная опора не использовались.

### 1.2. Метки достоверности

- **confirmed** — утверждение прямо следует из текста первоисточника (документация, README, API-ответ, исходник).
- **claim** — официальное позиционирование вендора без независимого подтверждения (число пользователей, «500+ моделей», «zero markup», «profitable», счётчики установок).
- **unverified** — источник доступен, но утверждение не подтверждается его текстом.
- **absent / unreachable** — страница или сущность отсутствует (HTTP 404, DNS failure, JSON `not_found`), либо документация её не описывает. Отсутствие фиксируется как факт об источнике, а не как факт о продукте.

### 1.3. Как собирались данные

- Для каждого продукта сначала запрашивался машинный индекс документации (`/llms.txt`), затем — целевые страницы. Это дало точные URL вместо угадывания.
- GitHub-метаданные сняты через `api.github.com/repos/<owner>/<repo>` 2026-11-11; звёзды/форки/issue — снимок на эту дату, а не «истина навсегда».
- Исходники читались только там, где документация отсутствовала или расходилась с ней: браузерный слой Cline (`BrowserSession.ts`, `BrowserSettings.ts`) и слой отображения стоимости (`useProviderUsageCostDisplay.ts`).
- Для страниц, отрендеренных JavaScript, использовался raw-markdown endpoint (`ampcode.com/docs/markdown/...`) либо HTML извлекался с удалением `<script>/<style>`.
- Локальный `CodeIndex` использован только для проверки доступности индекса: `state: ready`, `partial: false`, generation 1466, 10 007 файлов. Для внешнего веб-исследования он нерелевантен; ни один конкурентный факт из него не выведен.
- UTC-время фиксации baseline: `2026-11-11T09:49:16Z` (команда `date -u`).

### 1.4. Ограничения метода

- Документация — это заявление вендора о продукте. Ни один продукт не запускался и не тестировался в этой сессии; поведение в рантайме не проверялось.
- Тарифы и лимиты — опубликованные условия на 2026-11-11; они меняются.
- Часть docs-сайтов отдаёт контент только после JS-рендера. Там, где raw-страница не найдена, это отмечено в §8.2.
- Один вызов GitHub API упёрся в rate limit (метаданные `Zoo-Code-Org/Zoo-Code`); страница репозитория при этом открылась, поэтому вывод о форке сделан по HTML, а не по API.

## 2. Coverage table

### 2.1. Статус продуктов на 2026-11-11

| Продукт | Репозиторий / лицензия | Состояние | Последняя активность | Источник |
| --- | --- | --- | --- | --- |
| **Cline** | `cline/cline`, Apache-2.0 | активен, не archived | `pushed_at` 2026-11-11T08:50:28Z; extension `v4.1.26` 2026-10-26 | https://api.github.com/repos/cline/cline (2026-11-11); https://api.github.com/repos/cline/cline/releases?per_page=6 (2026-11-11) |
| **Kilo Code** | `Kilo-Org/kilocode`, MIT | активен, не archived; куплен Anaconda 2026-07-15 | `pushed_at` 2026-11-11T09:21:06Z; release `v7.8.27` 2026-11-05 | https://api.github.com/repos/Kilo-Org/kilocode (2026-11-11); https://www.anaconda.com/blog/anaconda-acquires-kilo-code (2026-11-11) |
| **Roo Code** | `RooCodeInc/Roo-Code`, Apache-2.0 | **archived, extension shut down 2026-05-15** | `pushed_at` 2026-05-15T18:08:47Z; release `v3.54.0` 2026-05-15 | https://api.github.com/repos/RooCodeInc/Roo-Code (2026-11-11); https://roocodeinc.github.io/Roo-Code/ (2026-11-11) |
| **Continue** | `continuedev/continue`, Apache-2.0 | **read-only, no longer actively maintained; acquired by Cursor** | `pushed_at` 2026-11-05T15:28:28Z; `v2.0.0-vscode` и `v2.1.0-vscode` 2026-06-19 | https://api.github.com/repos/continuedev/continue (2026-11-11); https://github.com/continuedev/continue (2026-11-11); https://www.continue.dev/ (2026-11-11) |
| **Goose** | `block/goose` → `aaif-goose/goose`, Apache-2.0 | активен, не archived; часть AAIF / Linux Foundation | `pushed_at` 2026-11-11T04:26:36Z; release `v1.59.0` 2026-11-10 | https://api.github.com/repos/block/goose (2026-11-11); https://raw.githubusercontent.com/aaif-goose/goose/main/README.md (2026-11-11) |
| **Amp** | публичного репозитория агента нет; npm-пакеты под `Amp Commercial License` | активен как продукт; закрытый исходник агента | `@ampcode/plugin` `0.0.0-20261111001139-g66076eb`; `@ampcode/cli` — `SEE LICENSE IN LICENSE.md` | https://registry.npmjs.org/@ampcode/plugin/latest (2026-11-11); https://api.github.com/repos/sourcegraph/amp → 404 (2026-11-11); https://ampcode.com/docs/markdown (2026-11-11) |

Ключевой статусный вывод: **из шести продуктов два — исторические артефакты.** Roo Code выключен 15 мая 2026, репозиторий archived, облако выключается с перенаправлением `roocode.com` → `roomote.dev` (https://roocode.com/, 301 → https://roomote.dev/, 2026-11-11; https://app.roocode.com/, 2026-11-11). Continue приобретён Cursor, README прямо говорит «no longer actively maintained and is read-only for all users» (https://github.com/continuedev/continue, 2026-11-11). Их ценность — в дизайне механик и в антипримерах жизненного цикла, а не в актуальной конкуренции.

### 2.2. Покрытие по каждому продукту

| Продукт | Distinct primary sources проверено | Покрытые измерения | Статус покрытия |
| --- | --- | --- | --- |
| Cline | 14+ (repo API, `llms.txt`, 8 docs-страниц, sitemap, 3 raw-исходника, releases) | архитектура, plan/act, tools, checkpoints, MCP, subagents, memory bank, auto-approve, стоимость, телеметрия, браузер, ACP, лицензия | полный |
| Kilo Code | 18+ (repo API, `llms.txt`, 14 docs-страниц, architecture, pricing, Anaconda blog, releases) | агенты/режимы, orchestrator, subagents, permissions, sandbox, indexing, compaction, memory, MCP, marketplace, Auto Model, cost controls, телеметрия, архитектура, лицензия | полный |
| Roo Code | 12+ (repo API, archived docs home/sitemap, 9 docs-страниц, releases, app.roocode.com) | modes, boomerang/orchestration, checkpoints, condensing, indexing, MCP, marketplace, worktrees, skills, auto-approve, жизненный цикл | полный (кроме cloud agents — выключены) |
| Continue | 13+ (repo API, README, homepage, `config.yaml` reference, models, agent how-it-works, plan mode, rules, install, CLI quickstart, context providers, npm) | config/model roles, rules/prompts, context, modes, tools/policies, CLI/headless, IDE support, Hub (отсутствует), лицензия/жизненный цикл | полный, кроме CI checks |
| Goose | 14+ (repo API, README, `llms.txt`, permissions, tool-permissions, extensions, recipes, subagents, custom agents, headless, config files, usage data, CLI commands, summon, releases) | extensions/MCP, recipes, permissions, headless, subagents, custom agents, config, телеметрия, GDK/ACP, лицензия | полный |
| Amp | 16+ (`llms.txt`, 12 raw-docs, pricing, security, 2 news, npm registry, GitHub org listing, substrate README) | threads/sharing, modes/Dial, subagents, tools/permissions, MCP, model routing, pricing/orbs, plugins/skills, AGENTS.md, agent-to-agent, review, diagnostics, лицензия | полный, кроме telemetry-страницы (404) |

## 3. Capability inventory

Ниже — по каждому продукту: архитектура, агентный цикл, инструменты, стратегия контекста, разрешения/песочница, расширяемость, субагенты, маршрутизация моделей, контроль стоимости, UX, телеметрия/оценка, лицензия. Все URL — доступ 2026-11-11.

### 3.1. Cline

**Архитектура.** Hub-and-spoke: фоновый демон (hub) координирует состояние сессий и маршрутизацию событий, но **не выполняет агентный цикл**; spoke-воркер запускает `@cline/core`; клиент (CLI, VS Code, JetBrains, произвольное приложение) подключается по WebSocket. Формулировка docs: «clients participate, spokes execute, the hub coordinates», «No two roles should overlap». Спайк в spoke не деградирует hub; падение клиента не останавливает выполнение (https://docs.cline.bot/sdk/architecture/hub-spoke, 2026-11-11). IDE-расширение в этой модели — **клиент и поставщик возможностей** (`open-file`, `reveal-diff`, `run-build`), а не исполнитель агента.

**Агентный цикл и режимы.** Plan mode «cannot modify any files or execute commands»; Act mode «modify files, run commands, and execute your strategy». История сохраняется при переключении; можно включить «Use different models for Plan and Act», и переключение режима автоматически переключает модель, сохраняя выбор для каждого режима (https://docs.cline.bot/core-workflows/plan-and-act, 2026-11-11).

**Инструменты.** Девять встроенных: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit`. Сессия даёт либо `editor`, либо `apply_patch`, никогда оба; по умолчанию Act маршрутизирует `apply_patch` к GPT/Codex и всем моделям провайдера `openai-native`, остальные получают `editor`; Plan не даёт ни одного. SDK-вызов может переопределить это через `toolRoutingRules` (https://docs.cline.bot/tools-reference/all-cline-tools, 2026-11-11).

**Контекст.** Cline **сознательно не индексирует код**: enterprise-документация утверждает «Cline reads files when a task needs them and doesn't index or embed the contents of your repositories» (https://docs.cline.bot/enterprise-solutions/overview.md, 2026-11-11). При приближении к лимиту Auto Compact суммирует историю, сохраняет технические решения и заменяет историю резюме; при этом виден tool call суммаризации с её стоимостью; для моделей, где суммаризация недоступна, включается rule-based truncation (https://docs.cline.bot/features/auto-compact, 2026-11-11). Есть `/smol` (алиас `/compact`) и `/newtask` — «packages what matters… into a fresh task with a clean context window» (https://docs.cline.bot/core-workflows/using-commands, 2026-11-11, в извлечении полного docs-файла).

**Memory Bank.** Это **методология документации**, а не встроенная БД: пользователь включает её, скопировав инструкции в Cline Rules и попросив «initialize memory bank». Ядро — `projectbrief.md`, `productContext.md`, `activeContext.md`, `systemPatterns.md`, `techContext.md`, `progress.md`; инструкция требует «I MUST read ALL memory bank files at the start of EVERY task - this is not optional». Память сбрасывается между сессиями, поэтому Bank — механизм непрерывности; эффективность зависит от дисциплины обновления (https://docs.cline.bot/best-practices/memory-bank.md, 2026-11-11).

**Разрешения и песочница.** Auto Approve оценивается **на каждый tool call**, по категориям: чтение/редактирование внутри проекта, чтение/редактирование вне workspace (требует базового тумблера), «safe commands», «all commands», браузер, MCP, уведомления. Статического allowlist нет: «Cline does not use a fixed allowlist»; модель помечает команду флагом `requires_approval`, примеры безопасных — build/test, `git status`, `ls -la`, `cat`; опасных — установка пакетов, `rm -rf`, `mv`, in-place `sed`. Документация честно предупреждает: «These are examples, not guarantees». YOLO «disables all safety checks» без диалогов подтверждения (https://docs.cline.bot/features/auto-approve, 2026-11-11). Отдельной OS-песочницы в docs не описано.

**Checkpoints.** Отдельный shadow Git-репозиторий, не затрагивающий `.git` проекта; коммит **после каждого tool use**, снимок полного состояния, включая untracked-файлы; переживает перезапуск редактора. Три режима восстановления: Restore Files, Restore Task Only, Restore Files & Task. Включено по умолчанию; на больших репозиториях предупреждают о расходе диска и замедлении (https://docs.cline.bot/core-workflows/checkpoints, 2026-11-11).

**MCP.** Конфиг CLI: `~/.cline/data/settings/cline_mcp_settings.json`, переопределяется `CLINE_MCP_SETTINGS_PATH`; в IDE — `mcpServers` в том же JSON. Локальные — STDIO (`command` + `args`), удалённые — `url`; `type: "streamableHttp"` рекомендуется, при отсутствии `type` по умолчанию legacy `sse`. OAuth поддерживается через wizard `cline mcp`; у сервера есть `autoApprove` и `disabled` (https://docs.cline.bot/mcp/mcp-overview, 2026-11-11).

**Marketplace.** Отдельной docs-страницы marketplace нет: URL `https://docs.cline.bot/mcp/mcp-marketplace` отдаёт 200, но это та же общая MCP-страница, а не каталог. При этом маркетинговый сайт `https://cline.bot/mcp-marketplace` (200, JS-приложение) перечисляет десятки серверов (Auth0, Context7, Neo4j, Supabase, Slack и др.), а Desktop-документация описывает **Marketplace для skills, MCP и plugins** внутри приложения (https://docs.cline.bot/usage/cline-desktop, 2026-11-11). То есть marketplace существует как продуктовая поверхность, но не как документированный каталог в docs.

**Браузер.** Docs-страница `https://docs.cline.bot/features/browser-use` — **404** (2026-11-11). Механика подтверждается исходником: `chrome-launcher` + `puppeteer-core`, `DEBUG_PORT = 9222`, режимы connect к удалённому хосту и launch локального Chrome; дефолты `BrowserSettings` — viewport 900×600, `remoteBrowserHost: "http://localhost:9222"`, `remoteBrowserEnabled: false`, `disableToolUse: true`, `customArgs: ""`; пресеты viewport — Large Desktop 1280×800, Small Desktop 900×600, Tablet 768×1024, Mobile 360×640 (https://raw.githubusercontent.com/cline/cline/main/apps/vscode/src/services/browser/BrowserSession.ts, 2026-11-11; https://raw.githubusercontent.com/cline/cline/main/apps/vscode/src/shared/BrowserSettings.ts, 2026-11-11). В Auto Approve есть отдельный тумблер «Use the browser».

**Субагенты.** Только CLI и Desktop — «The VS Code and JetBrains extensions don't use them». Каждый получает отдельное окно контекста и возвращает финальный отчёт; основной агент ждёт. В Act доступны чтение/редактирование/команды, в Plan нет инструментов редактирования, блокируются `rm`, `git commit`, но это не жёсткий барьер: «some of them, such as `python -c`, can write files». Одобрение `spawn_agent` авторизует **всё, что субагент затем делает**; настройки approval внутри субагента не применяются; **MCP-инструменты субагенту не доступны**; вложенность разрешена; расход прибавляется к сессии (https://docs.cline.bot/features/subagents.md, 2026-11-11).

**Agent Teams.** Docs-индекс перечисляет отдельную CLI-возможность `/team`: координатор + специалисты, task board, mailbox, mission log в `~/.cline/data/db/teams.db` (https://docs.cline.bot/llms.txt, 2026-11-11; страница https://docs.cline.bot/cli/agent-teams.md в этой сессии не перечитывалась — детали не перепроверены). Помечено как ограничение покрытия.

**Стоимость.** «The estimated cost shown in the task header updates after each API request»; оценка использует прайс провайдера и может отличаться от счёта из-за округления (https://docs.cline.bot/core-workflows/task-management, 2026-11-11). В коде есть явное решение `usageCostDisplay: "show" | "hide" | "subscription"`: для flat-rate подписок (ChatGPT Plus/Pro, ClinePass) долларовая оценка **скрывается**, потому что это не фактическое списание; `"unknown"` до загрузки листингов тоже не рендерится, чтобы не мигнуть ложной цифрой (https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts, 2026-11-11). SDK отдаёт `usage.inputTokens/outputTokens/totalCost`, а cost-control пример использует `maxTokensPerTurn`, `maxIterations` и abort по `usage-updated` при превышении $1 (https://docs.cline.bot/sdk/guides/going-to-production, 2026-11-11, из полного docs-файла).

**Телеметрия.** Включена по умолчанию во всех поверхностях, opt-out; одна настройка на компьютер, общая для VS Code/JetBrains/Desktop/CLI. Собирает фичи, старт/завершение задач, переключения Plan/Act, ошибки, токены/тайминги/модель, версию/ОС/редактор; **не собирает код, содержимое файлов и промпты**, кроме запросов к Cline и ClinePass, где промпт и ответ могут попадать в телеметрию. CLI: `"telemetryOptOut": true` в `~/.cline/data/settings/global-settings.json`; Desktop/CLI игнорируют организационную настройку `telemetryEnabled` (https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md, 2026-11-11). Есть OpenTelemetry-экспорт и справочник событий (https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry, 2026-11-11).

**Лицензия.** Apache-2.0 (https://api.github.com/repos/cline/cline, 2026-11-11).

### 3.2. Kilo Code

**Архитектура.** Три слоя: локальный runtime и клиенты (Kilo CLI runtime в `packages/opencode/`, `kilo serve` — локальный HTTP+SSE, editor-owned child, локальный демон, VS Code, JetBrains); Kilo Cloud (web control plane, Gateway, Workers, queues, Durable Objects); hosted product runtimes (Cloud Agent, Automation, Security Agent, Gas Town). Репозитории разделены: `Kilo-Org/kilocode` (клиенты, runtime, indexing, gateway client, telemetry) и `Kilo-Org/cloud` (control plane, Cloud Agent, billing) (https://kilo.ai/docs/contributing/architecture, 2026-11-11). В апреле 2026 расширение переписано на общий core для VS Code/CLI/Cloud (https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new, 2026-11-11).

**Агенты/режимы.** Встроенные: `code` (полный доступ), `ask` (read-only инструменты и read-only bash, write заблокирован, MCP с подтверждением), `plan` (read-only + редактирование только файлов плана в `.kilo/plans/`), `debug` (полный доступ), `orchestrator` (deprecated), плюс subagents `general` и `explore`. Переключение: dropdown, `/agents`, `Cmd/Ctrl+.`; в CLI — `Tab`, `Ctrl+X a`, `default_agent` в конфиге (https://kilo.ai/docs/code-with-ai/agents/using-agents, 2026-11-11).

**Кастомные агенты.** Markdown с YAML frontmatter в `.kilo/agents/`, `.kilo/agent/`, `~/.config/kilo/agent/` (legacy `.kilocode/agents/` читается); имя — имя файла, вложенные каталоги дают namespace (`backend/sql.md` → `backend/sql`). Поля: `description`, `model` в формате `provider/model`, тело = system prompt, `mode: primary | subagent | all`, `permission`, `color`, `steps` (максимум итераций до text-only), `temperature`/`top_p`, `variant`, `hidden`, `disable`. Приоритет мержа: built-in → global → project → `.kilo/`/legacy → `KILO_CONFIG_CONTENT`; свойства **мержатся**, а не заменяются целиком (https://kilo.ai/docs/customize/custom-modes, 2026-11-11).

**Orchestrator и субагенты.** Orchestrator **deprecated**: «agents with full tool access (Code, Plan, Debug) can now delegate to subagents automatically»; делегирование идёт через tool `task`, `general` — автономная работа, `explore` — read-only исследование. Субагент имеет отдельную историю, но **разделяет project directory/worktree и не изолирует правки файлов**; foreground возвращает результат до продолжения родителя, background (`background: true`) возвращает управление сразу; можно запускать несколько параллельно. Дочерний агент **не интерактивен** — не может задать вопрос пользователю. Координация — **Kilo Swarm**: `board_post`/`board_read`, общая доска для главной сессии и её task-потомков; по умолчанию включён, выключается `shared_agent_board: false` в `kilo.jsonc` (https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode, 2026-11-11; https://kilo.ai/docs/customize/custom-subagents, 2026-11-11).

**Инструменты.** Группы: read (`read`, `glob`, `grep`), edit (`edit`, `write`, `apply_patch`), execute (`bash`), web (`webfetch`, `websearch`), browser preview (`browser_open`), MCP (`{server}_{tool}`), workflow (`question`, `task`, `todowrite`, `todoread`, `plan`, `skill`, `agent_manager`, `board_post`, `board_read`). `question`, `task`, todo-инструменты доступны всегда. `interactive_terminal` удалён вместе с API/SDK-типами. Браузерная автоматизация — Playwright MCP (`kilo-playwright`), экспериментальный `browser_open` открывает только `localhost`/`127.0.0.1` и блокирует сторонние origin (https://kilo.ai/docs/automate/tools, 2026-11-11).

**Контекст и индексация.** Codebase Indexing **opt-in, выключен по умолчанию**; Tree-sitter нарезает семантические блоки, эмбеддинги складываются в векторную БД, агенту выдаётся `semantic_search`. Провайдеры эмбеддингов: OpenAI, Ollama, OpenAI-compatible, Gemini, Mistral, Vercel AI Gateway, AWS Bedrock, OpenRouter, Voyage; хранилища — LanceDB (по умолчанию, embedded) или Qdrant; конфиг `indexing.*` в `kilo.jsonc`, включая `searchMinScore: 0.4`, `searchMaxResults: 50`, `embeddingBatchSize: 60`, `scannerMaxBatchRetries: 3`. LanceDB не поддерживается на Intel Mac. Отдельно страница «What's New (April 2026)» говорит, что индексация в новом расширении «temporarily unavailable» — **прямое расхождение с актуальной docs-страницей**, которое зафиксировано в §4.5 (https://kilo.ai/docs/customize/context/codebase-indexing, 2026-11-11; https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new, 2026-11-11).

**Compaction.** Авто-компакция включена (`compaction.auto: true`), порог `threshold_percent` 1–100 опционален; при срабатывании создаётся «anchored summary» (цель, ограничения, прогресс, решения, следующие шаги, файлы), старый summary обновляется, а не пересоздаётся. Отдельный **prune** проход заменяет завершённые tool outputs вне 40 000-токенного окна recency на `"[Old tool result content cleared]"`. Дефолты: `tail_turns: 2`, `preserve_recent_tokens` 25% контекста с клампом 2 000–8 000, `reserved: min(20 000, model_max_output)`. Можно назначить дешёвую модель компакции: `agent.compaction.model`. Env-overrides: `KILO_DISABLE_AUTOCOMPACT=1`, `KILO_DISABLE_PRUNE=1` (https://kilo.ai/docs/customize/context/context-condensing, 2026-11-11).

**Memory.** Отдельная от deprecated Memory Bank: opt-in, только project-scope, три Markdown-файла (`project.md`, `environment.md`, `corrections.md`) + session digests в `~/.local/share/kilo/memory/<project-slug>-<sha1-12>/`. Auto-save включён по умолчанию, шлёт best-effort-redacted контекст провайдеру, только добавляет/обновляет, никогда не удаляет; `memory_model` позволяет отдельную модель. Индекс памяти инжектится в начало сессии, детали достаются `kilo_memory_recall`; режимы recall: `search`, `typed`, `digest`, `catalog`. «Memory is context, not instruction» (https://kilo.ai/docs/customize/context/memory, 2026-11-11).

**Разрешения.** Три уровня — `allow`, `ask`, `deny` — на инструмент: `external_directory`, `bash`, `read`, `edit`, `glob`, `grep`, `task`, `agent_manager`, `skill`, `lsp`, `todoread`/`todowrite`, `websearch`, `webfetch`, `doom_loop`. Правила — glob-паттерны, **последнее совпавшее правило побеждает**; пример: `{"bash": {"*": "ask", "uv *": "allow"}}` разрешает `uv pip install`, а обратный порядок — нет. Большинство инструментов по умолчанию `"*": "allow"`; исключения — `.env`/`*.env.*` (ask, `*.env.example` разрешён), `external_directory`, `doom_loop`, а в JetBrains ещё и `edit`. Project-level `kilo.jsonc` кешируется при загрузке workspace и не перечитывается на каждый промпт — правка правил требует reload окна или новой CLI-сессии (https://kilo.ai/docs/getting-started/settings/auto-approving-actions, 2026-11-11).

**Песочница.** **Выключена по умолчанию.** Это OS-граница, ограничивающая **запись**, но не чтение: агент может читать любой файл, доступный пользователю, писать — только в workspace/worktree, runtime-каталоги Kilo и `sandbox.writable_paths`. Сеть по умолчанию `"deny"`, разрешения — `sandbox.allowed_hosts` (порты по умолчанию 443). `.git` всегда read-only для песочницы, глобальный конфиг read-only, project-конфиг может только ужесточать политику, но не ослаблять. Не поддерживается на Windows; при невозможности применить политику Kilo отказывается запускать инструмент, а не падает в unrestricted. MCP-клиенты и plugin hooks работают как trusted host integrations вне границы; при network deny локальные/удалённые MCP-вызовы недоступны, но MCP prompt retrieval — вне политики. Прямо сказано: «The sandbox is a write boundary, not a privacy boundary» (https://kilo.ai/docs/getting-started/settings/sandboxing, 2026-11-11).

**MCP и Marketplace.** Конфиг — ключ `mcp` в `kilo.jsonc`: local `type: "local"`, `command: [...]`, `environment`, `enabled`, `timeout`; remote `type: "remote"`, `url`, `headers`, `oauth: false`; project-level переопределяет global. Marketplace — это **не VS Code extensions**, а конфигурационные/инструкционные/plugin-файлы: Agent, Skill, MCP server, Plugin; установка добавляет файлы в проект или user config, plugin попадает в массив `plugin` (https://kilo.ai/docs/automate/mcp/using-in-kilo-code, 2026-11-11; https://kilo.ai/docs/customize/marketplace, 2026-11-11).

**Маршрутизация моделей.** `kilo-auto/frontier` (максимальная способность), `kilo-auto/efficient` (session-aware классификация сложности, дешёвая модель, доказавшая точность на бенчмарках, fallback на фиксированный baseline), `kilo-auto/free` (лучшие free-модели через OpenRouter, mapping обновляется server-side). Efficient-пул настраивается: 1–10 пар model+variant, каждая бенчмаркится on demand, статусы Benchmarking/Ready/Failed/Unavailable; лимит 10 новых/повторных пар на владельца за 24 часа. Auto Free может уходить к провайдерам, логирующим промпты (предупреждение про NVIDIA) (https://kilo.ai/docs/code-with-ai/agents/auto-model, 2026-11-11).

**Контроль стоимости.** `doom_loop` (default `ask`) останавливает повторяющиеся неудачи; per-tool approvals; при нулевом балансе платные запросы падают; организация может задать **per-user daily spending limits** с сбросом в полночь UTC; **spend alerts** — по окнам 24 ч / 7 д / 30 д и «spend spike» 1×–50× к обычному часовому темпу за предыдущие 14 дней; free-модели ограничены **200 запросов/час** (HTTP 429); советы — узкий scope, `/compact`, дешёвая compaction-модель, отключение неиспользуемых MCP, prompt caching (https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards, 2026-11-11).

**Тарифы.** Free (платформа), Teams **$15/user/month**, Enterprise custom; Gateway — $0/мес + provider rates, «zero markup»; Kilo Pass от **$19/мес** с бонусными кредитами до 50%; processing fee **5%** на top-ups и Pass; кредиты истекают через год; cloud compute отдельно (Code Review **$0.33/час**, Cloud Agent Docker/Small **$0.60/час**, таблица в извлечении обрезана после Standard). Все цифры — опубликованная страница тарифов, доступ 2026-11-11 (https://kilo.ai/pricing, 2026-11-11).

**Телеметрия.** Включена по умолчанию; отключается `experimental.openTelemetry: false`; при заданном `OTEL_EXPORTER_OTLP_ENDPOINT` CLI экспортирует трейсы и логи, поддерживает `OTEL_EXPORTER_OTLP_HEADERS` и `OTEL_RESOURCE_ATTRIBUTES`; спаны содержат `http.method`, `http.path`, `session.id`, `message.id`. В VS Code — `telemetry.telemetryLevel: Off`, в CLI — `KILO_TELEMETRY_LEVEL=off`. Мобильное приложение спрашивает согласие на optional telemetry, но предвыбирает её в onboarding (https://kilo.ai/docs/getting-started/settings, 2026-11-11).

**Лицензия.** MIT для клиентов; Gateway и Cloud — «source available» отдельно (https://api.github.com/repos/Kilo-Org/kilocode, 2026-11-11; https://kilo.ai/llms.txt, 2026-11-11 — claim).

### 3.3. Roo Code (архив)

**Статус.** «The Roo Code Extension was shut down on May 15th»; рекомендации — ZooCode (community fork) и Cline (https://roocodeinc.github.io/Roo-Code/, 2026-11-11). Репозиторий `archived: true`, `pushed_at` 2026-05-15T18:08:47Z (https://api.github.com/repos/RooCodeInc/Roo-Code, 2026-11-11). Облако: «Roo Code Cloud is shutting down… winding down Roo Code Cloud to focus on Roomote… unused account balances are being refunded automatically» (https://app.roocode.com/, 2026-11-11). `roocode.com` отдаёт 301 на `roomote.dev` (2026-11-11).

**Custom modes.** Свойства: `slug`, `name`, `description`, `roleDefinition`, `whenToUse` (используется orchestrator'ом для делегирования и выбора режима), `customInstructions`, `groups` (наборы инструментов и ограничения файлов). **Sticky models**: каждый режим запоминает последнюю модель, использованную с ним, и переключение режима переключает модель. Project-режимы хранятся в `.roomodes`, global — в глобальном конфиге; правила — `.roo/rules-{slug}/`; экспорт даёт YAML `customModes: [...]` с `rulesFiles`, импорт поддерживает project/global и автоматически переписывает пути при смене slug (https://roocodeinc.github.io/Roo-Code/features/custom-modes, 2026-11-11).

**Оркестрация (Boomerang).** Встроенный `🪃 Orchestrator` разбивает задачу и делегирует её другому режиму через `new_task`; каждая подзадача — отдельный контекст и отдельная история, родитель ставится на паузу, результат возвращается сводкой; `switch_mode` позволяет менять режим (https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks, 2026-11-11).

**Checkpoints.** Включены по умолчанию, требуют установленный Git, но не GitHub-аккаунт; shadow-репозиторий независим от `.git` проекта. Снимки создаются **при старте задачи и перед модификацией файлов**, но **не перед выполнением команд**; фиксируют изменения, новые, удалённые и переименованные файлы. «Checkpoint initialization timeout» — 10–60 с, default 30 с (https://roocodeinc.github.io/Roo-Code/features/checkpoints, 2026-11-11).

**Context condensing.** Включено по умолчанию; суммирует раннюю часть диалога при приближении к лимиту; порог — слайдер, default 100%; кастомный condensing prompt; slash-команды из первого сообщения сохраняются через конденсацию; стоимость суммаризации показывается в метриках UI (https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing, 2026-11-11).

**Индексация.** Tree-sitter → эмбеддинги → **Qdrant** → tool `codebase_search`; есть полностью бесплатная конфигурация (Qdrant Cloud free tier или Docker + Gemini embeddings) (https://roocodeinc.github.io/Roo-Code/features/codebase-indexing, 2026-11-11).

**MCP/Marketplace.** MCP: STDIO, Streamable HTTP, legacy SSE, с approve инструментов. Marketplace — каталог **MCP и Modes**, установка одним кликом, project/global scope (https://roocodeinc.github.io/Roo-Code/features/mcp/overview, 2026-11-11; https://roocodeinc.github.io/Roo-Code/features/marketplace, 2026-11-11).

**Auto-approve.** Предупреждение о риске, dropdown рядом с чатом, All/None chips, горячая клавиша `Cmd+Alt+A`, команда `roo-cline.toggleAutoApprove`; глобальный Enabled сохраняет per-permission настройки (https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions, 2026-11-11).

**Worktrees и Skills.** Git worktrees дают отдельное окно VS Code на ветку — параллельные задачи без переключения ветки (https://roocodeinc.github.io/Roo-Code/features/worktrees, 2026-11-11). Skills загружаются on-demand, когда запрос совпадает с назначением навыка, в отличие от custom instructions, действующих всегда (https://roocodeinc.github.io/Roo-Code/features/skills, 2026-11-11).

**Пробелы.** Cloud agents как живая механика не проверяемы: облако выключено, а в архивном sitemap нет cloud-раздела. Модель «trade tokens for quality» — позиционирование docs, не измерение. Телеметрия детально не документирована (только ссылка на privacy policy в футере).

**Лицензия.** Apache-2.0 (https://api.github.com/repos/RooCodeInc/Roo-Code, 2026-11-11).

### 3.4. Continue (read-only, acquired by Cursor)

**Статус.** README: «The `continuedev/continue` repository is no longer actively maintained and is read-only for all users». Финал — 2.0.0 для VS Code, CLI и JetBrains: «removing anonymous telemetry, pulling out authentication, squashing bugs» (https://github.com/continuedev/continue, 2026-11-11). Сайт: «Continue was acquired by Cursor» (https://www.continue.dev/, 2026-11-11). Releases: `v2.0.0-vscode` и `v2.1.0-vscode` опубликованы 2026-06-19 (https://api.github.com/repos/continuedev/continue/releases?per_page=5, 2026-11-11) — при этом README называет финальным именно 2.0.0; расхождение зафиксировано в §7.

**Архитектура конфигурации.** Всё описывается одним `config.yaml`: обязательные `name`, `version`, `schema: v1`; секции `models`, `context`, `rules`, `prompts`, `docs`, `mcpServers`, `data`. Конфиг лежит локально (`~/.continue/config.yaml` на macOS/Linux, `%USERPROFILE%\.continue\config.yaml` на Windows), автоматически перезагружается при сохранении, версионируется вместе с кодом. Это **local-first, machine-owned** модель: «all configuration stored directly on your machine» (https://docs.continue.dev/reference, 2026-11-11; https://docs.continue.dev/guides/understanding-configs, 2026-11-11).

**Роли моделей.** `roles: [chat, autocomplete, embed, rerank, edit, apply, summarize]`, default `[chat, edit, apply, summarize]`; при этом docs прямо пишут, что роль `summarize` «is not currently used». `capabilities: [tool_use, image_input]` переопределяют автоопределение; `chatOptions` содержат отдельные system prompts для Chat (`baseSystemMessage`), Agent (`baseAgentSystemMessage`) и Plan (`basePlanSystemMessage`); `promptTemplates` переопределяют шаблоны для `chat`/`edit`/`apply`/`autocomplete`. Модель без `tool_use` не может работать в Agent/Plan (https://docs.continue.dev/reference, 2026-11-11; https://docs.continue.dev/customize/models, 2026-11-11).

**Режимы и агентный цикл.** Три режима: Chat (инструментов нет), Plan (только read-only), Agent (все инструменты). Handshake: инструменты отправляются вместе с запросом → модель может вернуть tool call → пользователь даёт разрешение (шаг пропускается, если политика инструмента `Automatic`) → Continue вызывает инструмент сам или через MCP-сервер → результат уходит модели → цикл повторяется. Read-only набор Plan: `read_file`, `read_currently_open_file`, `ls`, `glob_search`, `grep_search`, `fetch_url_content`, `search_web`, `view_diff`, `view_repo_map`, `view_subdirectory`, `codebase_tool`; Agent добавляет `create_new_file`, `edit_existing_file`, `run_terminal_command`, `create_rule_block` (https://docs.continue.dev/ide-extensions/agent/how-it-works, 2026-11-11).

**Контекст.** Агент выбирает контекст из содержимого файлов, определений language server, импортов и недавней истории файлов; tool-ответы автоматически становятся context items, поэтому агент видит результат предыдущего действия (https://docs.continue.dev/ide-extensions/agent/context-selection, 2026-11-11). Исторические context providers (Jira, Discord, Greptile, Commits и др.) **deprecated**: «no longer actively maintained… consider migrating to… MCP» (https://docs.continue.dev/reference/deprecated-context-providers, 2026-11-11). `@Codebase` и `@Docs` тоже помечены deprecated в навигации docs.

**Rules/Prompts.** Rules — файлы в `.continue/rules`, конкатенируются в system message для Agent/Chat/Edit-запросов; prompts — переиспользуемые шаблоны, вызываемые как slash-команды (https://docs.continue.dev/customize/rules, 2026-11-11; https://docs.continue.dev/reference, 2026-11-11).

**CLI.** `cn` — тот же агент в терминале. TUI по умолчанию; headless — `cn -p "prompt"`. Флаги: `--config`, `--resume`, `--auto` (все инструменты без подтверждения), `--readonly` (Plan), `--allow <tool>`, `--exclude <tool>`, `--rule`, `--mcp`, `--model`, `--agent`, `--verbose`. Для CI — `CONTINUE_API_KEY` вместо браузерного логина; npm-пакет требует Node 20+ (https://docs.continue.dev/cli/quickstart, 2026-11-11).

**MCP.** MCP-серверы описываются в `mcpServers` внутри `config.yaml` либо отдельными YAML в `.continue/mcpServers/` (пример: `uses: continuedev/continue-docs-mcp`); работают **только в agent mode** (https://docs.continue.dev/reference/continue-mcp, 2026-11-11; https://docs.continue.dev/customize/mcp-tools, 2026-11-11).

**Hub.** Проверка на 2026-11-11: `hub.continue.dev` **не резолвится** (`Could not resolve host`), `https://docs.continue.dev/hub` — 404, в навигации docs раздела Hub нет, а страница конфигурации говорит, что конфиг хранится локально. Вывод: Hub как продуктовая поверхность недоступен; его механики по первоисточникам не восстановимы.

**IDE support.** VS Code и JetBrains (две вкладки установки); README дополнительно указывает CLI. Для JetBrains README рекомендует **CLI вместо плагина** (https://docs.continue.dev/ide-extensions/install, 2026-11-11; https://github.com/continuedev/continue, 2026-11-11).

**CI checks.** Ни одного подтверждённого docs-маршрута про CI/GitHub Actions найти не удалось: `docs.continue.dev/ci`, `/github`, `/guides/ci`, `/cli/github-actions` — все 404 (2026-11-11). Тема помечена как **не проверенная**, а не как отсутствующая.

**Лицензия.** Apache-2.0; CLI `@continuedev/cli` — Apache-2.0 (https://api.github.com/repos/continuedev/continue, 2026-11-11; https://registry.npmjs.org/@continuedev/cli/latest, 2026-11-11).

### 3.5. Goose

**Архитектура.** Rust-агент общего назначения: desktop (macOS/Linux/Windows), CLI и API; «runs on your machine», не только для кода. Репозиторий `block/goose` перенаправляется на `aaif-goose/goose`; README: «part of the Agentic AI Foundation (AAIF) at the Linux Foundation». GDK (goose Development Kit) даёт Rust-crates для сборки агента; Python/Kotlin-биндинги покрывают провайдеров и компакцию, но **не полный runtime**; ACP позволяет использовать готового goose как backend (https://raw.githubusercontent.com/aaif-goose/goose/main/README.md, 2026-11-11; https://goose-docs.ai/llms.txt, 2026-11-11).

**Расширения = MCP.** Встроенные: Developer (включён по умолчанию), Computer Controller, Memory, Tutorial, Auto Visualiser. Платформенные: Analyze (вкл.), Apps, Chat Recall, Code Mode, Extension Manager (вкл.), Skills (вкл.), Summon (вкл.), Todo, Top of Mind. Важная деталь: «goose's built-in extensions are MCP servers in their own right» — их можно подключить к другому агенту. Перед активацией внешних расширений goose проверяет их на известное malware и блокирует вредоносные пакеты; поддерживаются MCP Roots для рабочего каталога (https://goose-docs.ai/docs/getting-started/using-extensions.md, 2026-11-11).

**Разрешения.** Четыре режима: **Completely Autonomous** (по умолчанию; правки/удаление/расширения без подтверждений), **Manual Approval** (подтверждение каждого инструмента), **Smart Approval** (риск-ориентированный: low-risk автоматически, остальное спрашивает), **Chat Only** (без инструментов). Режим — на сессию; в CLI `/mode auto|smart_approve|approve|chat`. Поверх режима — per-tool уровни **Always Allow / Ask Before / Never Allow**. Важное ограничение: в manual/smart goose спрашивает только для инструментов, которые сам счёл «write», а классификация read/write — «best effort attempt… interpreted by your LLM provider» (https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md, 2026-11-11; https://goose-docs.ai/docs/guides/managing-tools/tool-permissions.md, 2026-11-11).

**Субагенты.** Отдельные инстансы с изолированным контекстом; автономное создание **только в autonomous mode** — «Subagents are disabled in manual approval, smart approval, and chat-only modes». Последовательные по умолчанию, параллельные по ключевым словам («parallel», «simultaneously»). Внутренние — direct prompts или recipes; внешние — Summon. Таймаут по умолчанию 5 минут; при провале субагент не возвращает вывод, при параллельном запуске результаты успешных сохраняются. Tool calls видны в UI/CLI с идентификатором `subagent:16` (https://goose-docs.ai/docs/guides/context-engineering/subagents.md, 2026-11-11).

**Recipes.** YAML/JSON (`.yml` CLI не поддерживает). Поля: `title`, `description`, `instructions` и/или `prompt` (prompt обязателен в headless), `activities` (только Desktop), `extensions`, `parameters`, `response` (схема структурированного вывода), `retry` (retry с валидацией успеха), `settings`, `sub_recipes`, `version`. Загрузка: текущий каталог, `GOOSE_RECIPE_PATH`, GitHub-репозиторий через `GOOSE_RECIPE_GITHUB_REPO` + авторизованный `gh`. Рецепт с `sub_recipes` автоматически инжектит `summon` (https://goose-docs.ai/docs/guides/recipes/recipe-reference.md, 2026-11-11).

**Custom agents.** Markdown + YAML frontmatter (`name` обязателен, `description`, `model` опциональны) в `~/.agents/agents/` или `<project>/.agents/agents/`; совместимость с `.goose/agents/`, `.claude/agents/` и их home-вариантами. Агента можно вызвать через `@name`, делегировать в отдельную сессию или загрузить его инструкции в текущий контекст (https://goose-docs.ai/docs/guides/context-engineering/custom-agents.md, 2026-11-11).

**Headless.** `goose run` с `-t`, `--no-session`, `--with-builtin`, `--max-turns` (default 1000), `--output-format text|json|stream-json`, `--recipe`, `--params`, `--debug`, `--explain`. В headless нет интерактивных решений: контекст суммируется автоматически, tool permissions используют заданные дефолты или «fail safely» (https://goose-docs.ai/docs/tutorials/headless-goose.md, 2026-11-11; https://goose-docs.ai/docs/guides/goose-cli-commands.md, 2026-11-11).

**Конфиг.** `~/.config/goose/config.yaml`, `permission.yaml`, `secrets.yaml`, `permissions/tool_permissions.json`, `prompts/`. Ключевые настройки: `GOOSE_MODE` (auto/approve/chat/smart_approve), `GOOSE_MAX_TURNS` 1000, `GOOSE_CLI_SHOW_COST` **false** по умолчанию (оценочная стоимость в CLI), `GOOSE_CACHE_TTL`, `GOOSE_TOOL_DEFERRAL` (публиковать имена MCP-инструментов заранее, схемы — on demand через `enable_tools`), `GOOSE_INPUT_LIMIT` для Ollama (https://goose-docs.ai/docs/guides/config-files.md, 2026-11-11).

**Телеметрия.** Opt-in: `GOOSE_TELEMETRY_ENABLED` default **false**; при включении собирает ОС/архитектуру, версию и способ установки, провайдера/модель, счётчики расширений и инструментов (только имена), метрики сессии (длительность, число взаимодействий, токены), типы ошибок — без диалогов, кода, аргументов инструментов и персональных данных. OTLP-экспорт: `otel_exporter_otlp_endpoint`, `otel_exporter_otlp_timeout` (https://goose-docs.ai/docs/guides/usage-data.md, 2026-11-11; https://goose-docs.ai/docs/guides/config-files.md, 2026-11-11).

**Лицензия.** Apache-2.0 (https://api.github.com/repos/block/goose, 2026-11-11). Публичного прайса нет: open-source, стоимость — у провайдера модели.

### 3.6. Amp

**Архитектура и позиционирование.** «Amp is a coding agent and development environment built for the frontier»; агент — серверный, поверхности — web, CLI, приложения macOS/Windows/Linux/iOS/Android, Puck (Slack). Thread — единица работы: один URL открывается во всех клиентах, а место исполнения отделено от места просмотра (orb, runner или локальная CLI-сессия) (https://ampcode.com/docs/markdown, 2026-11-11; https://ampcode.com/docs/markdown/threads, 2026-11-11). Публичного репозитория агента нет: `https://api.github.com/repos/sourcegraph/amp` — 404; в org `ampcode` лежат плагины, SDK-демо, примеры и `substrate` (sandbox-runtime, Apache-2.0, «low-opinion runtime, not an agent SDK») (https://api.github.com/orgs/ampcode/repos?per_page=20, 2026-11-11; https://raw.githubusercontent.com/ampcode/substrate/main/README.md, 2026-11-11).

**Режимы («The Dial»).** Четыре встроенных режима: `low`, `medium`, `high`, `ultra`; каждый = модель + reasoning effort + system prompt + набор инструментов. Режим **фиксируется при первом сообщении треда и не меняется позже**; причина указана явно: модели путаются, продолжая диалог другой модели, а смена system prompt/инструментов инвалидирует prompt cache и удорожает тред. Новый тред стартует в последнем использованном режиме или в workspace-default. Модели под режимами могут меняться server-side, смысл позиции — нет (https://ampcode.com/docs/markdown/the-dial, 2026-11-11).

**Субагенты.** Два: **Task** (выполняет делегированную работу end-to-end, имеет file editing, terminal, skills для read-only ролей: поиск по workspace, исследование репозитория/зависимости, review изменения, планирование) и **Read Thread** (читает и суммирует другие треды). Оба работают на **той же модели и reasoning effort, что и запустивший их тред**; у каждого свой контекст; они **не общаются друг с другом**, пользователь не может ими управлять напрямую, основной агент получает только финальную сводку. Субагенту можно дать дополнительную задачу — он получит её в текущую работу или в свой контекст; при заполнении контекста компактится так же, как тред. Amp выбирает субагентов автоматически, в основном в `medium`. Отдельные плагины `@amp/oracle` (review, никогда не редактирует), `@amp/librarian` (клонирует внешние репозитории в `/tmp`), `@amp/finder` (поиск файлов и диапазонов строк) позволяют запускать эти роли на выбранной модели (https://ampcode.com/docs/markdown/models-and-subagents, 2026-11-11).

**Инструменты и разрешения.** «By default, Amp does not ask for approval before running tools»; «Amp does not ask for approval before running tools». Управление — только через **custom plugin**: обработчик `amp.on('tool.call', ...)` возвращает `allow` или `reject-and-continue`; пример плагина классифицирует git-команды через `amp.ai.ask(...)` и спрашивает подтверждение через `ctx.ui.confirm(...)` только для потенциально деструктивных. Workspace-админ может распространить такой плагин на всех. Встроенный список инструментов смотреть через `amp tools list`; отдельно упомянут Painter (генерация/редактирование изображений, GPT Image 2.5 Sunburst) (https://ampcode.com/docs/markdown/tools, 2026-11-11; https://ampcode.com/docs/markdown/customize/plugins, 2026-11-11).

**MCP.** Два способа: локальный `amp.mcpServers` (даже URL-запись остаётся локальной конфигурацией) и **remote MCP definitions**, хранящиеся на ampcode.com (`amp mcp remote`); для remote-серверов, принимающих только известные IP, нужно разрешить egress-адреса Amp. Рекомендация — **бандлить MCP в skills через `mcp.json`**, чтобы не раздувать список инструментов и грузить их on demand. Поля: `command`/`args`/`env` для локальных, `url`/`headers` для remote, `${VAR}` для env; OAuth автоматический; `${amp:id-token}` работает только в headers HTTPS-серверов без OAuth и только внутри orb (https://ampcode.com/docs/markdown/customize/mcp, 2026-11-11).

**Thread sharing и review.** Share dialog: General Access — только People with Access, вся workspace или любой с ссылкой; Multiplayer позволяет всем с доступом вносить вклад, но недоступен при «anyone with link» и выключается при переходе на ссылку. CLI: `amp threads share T-… --visibility unlisted`. Экспорт: `.md` в конце URL даёт Markdown, Export — Markdown и JSON для создателя; CLI `amp threads markdown/export`. Review: панель review, drag диапазона изменений, pre-scan diff рекомендует порядок файлов и даёт summary; отдельный review agent публикует список actionable improvements, которые можно вернуть основному агенту; используется Gemini 3 Pro и review-oriented toolset (https://ampcode.com/docs/markdown/threads, 2026-11-11; https://ampcode.com/news/agentic-code-review, 2025-12-18, accessed 2026-11-11).

**Модельная маршрутизация.** По умолчанию Amp сам обслуживает модели и списывает кредиты; можно добавить connections: API keys, подписки (ChatGPT, Claude, GitHub Copilot), cloud platforms (Bedrock, Vertex, Azure AI Foundry), routers/gateways (OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, Ollama Cloud, OpenCode Go, custom OpenAI/Anthropic-compatible URL). Порядок connections задаёт пользователь; `amp config model-providers` и Check Access проверяют credential; workspace-connections применяются ко всем, Enterprise может запретить personal. Свои ключи/подписки на не-Enterprise тарифах — «no Amp fees or limits» (https://ampcode.com/docs/markdown/customize/model-routing, 2026-11-11; https://ampcode.com/docs/markdown/pricing, 2026-11-11).

**Стоимость.** Тарифы: Hobby free (pay-as-you-go credits), Megawatt **$20/мес** ($10 с education) с $20 agent usage и 750 часами `a1.small` orb, Gigawatt **$200/мес** с $200 usage и 1 000 часами `a1.xxlarge`, Teams без доплаты (каждый сохраняет свой tier, купленные кредиты — общий пул), Enterprise custom. Кредиты истекают через 12 месяцев. Orb-размеры: `a1.tiny` $0.08/ч, `a1.small` $0.17/ч, `a1.medium` $0.33/ч, `a1.large` $0.66/ч, `a1.xxlarge` $1.32/ч, `a1.3xlarge` $2.13/ч; биллинг поминутный, пауза через 5 минут без работы агента и 20 минут без взаимодействия (что позже). На не-Enterprise Amp не добавляет markup к API-ценам провайдеров; non-model tools (web search) тоже расходуют кредиты. Детальная стоимость треда — по клику на `$` в сайдбаре; есть `amp usage` (https://ampcode.com/docs/markdown/pricing, 2026-11-11; https://ampcode.com/docs/markdown/orbs/sizes-and-costs, 2026-11-11).

**Расширяемость.** Плагины — TypeScript/JavaScript-модули: `amp.on(...)` для событий tool call/result и lifecycle, `amp.registerTool(...)`, `ctx.tools.call(...)`, `amp.registerSkill(...)`, `amp.registerCommand(...)`, UI-хелперы, `amp.ai.ask/decide`, labels тредов. Источники и приоритет: project `.amp/plugins/` → system (`~/.config/amp/plugins/`) → personal → workspace. Skills: project `.agents/skills/`, personal/workspace repos, 11-уровневый порядок приоритета, `amp skill add <source>`; AGENTS.md читается из cwd/родителей/поддеревьев, `$HOME/.config/amp/AGENTS.md`, системных путей; workspace-guidance идёт раньше personal и repo и **не применяется к субагентам, Puck и raw custom agents** (https://ampcode.com/docs/markdown/customize/plugins, 2026-11-11; https://ampcode.com/docs/markdown/customize/skills, 2026-11-11; https://ampcode.com/docs/markdown/customize/agents-md, 2026-11-11).

**Headless/CI.** `amp -x "prompt"` — execute mode: отправить сообщение, дождаться конца хода, напечатать финальный ответ, выйти; `-ox` — то же в orb; pipe-ввод поддерживается; `--mcp-config` задаёт MCP без правки settings; `--timings` печатает тайминги в stderr; `--plugin-ready-timeout` ждёт загрузки плагинов (до 300 с); `--executor runner:<id>` запускает на runner; `--stream-json` для программ. Execute mode включается автоматически при редиректе stdout (https://ampcode.com/docs/markdown/cli/execute-mode, 2026-11-11).

**Agent-to-agent.** Агент может запустить другой тред (в другом проекте, orb или на runner), передать инструкции и файлы, получить результат обратно; при этом рабочие копии **не общие** — файлы передаются только явными transfer-операциями. Это позиционируется и как способ eval-ить «agent friendliness» репозитория: запустить несколько свежих orbs без подсказок и посмотреть, как далеко каждый зайдёт (https://ampcode.com/docs/markdown/orbs/agent-to-agent, 2026-11-11).

**Телеметрия/диагностика.** Отдельной страницы telemetry нет: `ampcode.com/docs/telemetry` и `ampcode.com/docs/markdown/telemetry` — 404 (2026-11-11). Есть `amp report-bug` / `amp diagnostics` (алиасы `amp report`): собирают thread state, client logs и settings; диагностические данные удаляются через 7 дней (https://ampcode.com/docs/markdown/support/reporting-bugs, 2026-11-11). Security-страница описывает data retention, encryption, audit logging, minimal data retention (https://ampcode.com/security, 2026-11-11).

**Лицензия.** Агент — проприетарный: `@ampcode/plugin` — «Amp Commercial License», `@ampcode/cli` — «SEE LICENSE IN LICENSE.md»; публичный `substrate` — Apache-2.0, но это отдельный sandbox-runtime (https://registry.npmjs.org/@ampcode/plugin/latest, 2026-11-11; https://registry.npmjs.org/@ampcode/cli/latest, 2026-11-11).

### 3.7. Матрица механик (шесть продуктов)

Обозначения: **+** документировано и доступно; **~** частично/с оговоркой; **−** отсутствует или не документировано; **n/a** продукт выключен. Все ячейки — по источникам, доступ 2026-11-11, перечисленным в §3.1–3.6 и §8.

| Механика | Cline | Kilo Code | Roo Code | Continue | Goose | Amp |
| --- | --- | --- | --- | --- | --- | --- |
| Основной режим разделения прав | Plan/Act | allow/ask/deny на инструмент | Modes + groups | Chat/Plan/Agent | 4 permission mode + per-tool | Dial `low/medium/high/ultra` |
| Отдельная модель на режим | + (`Use different models for Plan and Act`) | + (`model` на агента, model per mode) | + (sticky model per mode) | ~ (model roles, не per-mode) | + (`model` в custom agent) | + (модель под режимом, server-side) |
| Approval по умолчанию | + (кроме YOLO) | ~ (большинство `allow`, `.env`/external/doom ask) | + | + (policy `Automatic` отключает) | − (autonomous default) | − (no approval by default) |
| OS-песочница | − (не описана) | + (opt-in, write+network, не Windows) | − (не описана) | − (не описана) | − (не описана; sandbox — отдельный Substrate) | ~ (orbs/Substrate, не локальный дефолт) |
| Checkpoints/снимки | + (shadow git, после каждого tool use) | + (snapshot repo, step boundaries) | + (shadow git, перед правками) | − (не документировано) | − (не документировано) | ~ (Changes/Ship/Review, без «checkpoint»-термина) |
| Авто-компакция | + (`/smol`, auto-compact) | + (`compaction.*`, prune) | + (condensing, default on) | − (не документировано) | + (auto-summarize в headless) | + (compaction тредов и субагентов) |
| Семантическая индексация | − (сознательно нет) | + (opt-in, LanceDB/Qdrant) | + (Qdrant) | ~ (`@Codebase` deprecated) | ~ (Analyze extension, не embeddings) | − (не документировано) |
| MCP | + | + | + | + | + (основной способ расширения) | + (local + remote registry) |
| Marketplace | ~ (Desktop Marketplace; docs-каталога нет) | + (Agent/Skill/MCP/Plugin) | n/a (был MCP+Modes) | − (Hub недоступен) | + (extensions directory) | ~ (skills/plugins, без MCP-каталога в docs) |
| Субагенты | + (CLI/Desktop, без MCP) | + (`task`, general/explore, swarm board) | + (boomerang, режимы) | − (не документировано) | + (autonomous only, recipes/summon) | + (Task/Read Thread, same model) |
| Параллельные агенты | ~ (`/team`, Kanban) | + (Agent Manager worktrees) | + (worktrees) | − | + (parallel subagents) | + (agent-to-agent, fan-out) |
| Правила/инструкции | + (`.clinerules`, skills) | + (`AGENTS.md`, rules, skills) | + (custom instructions, skills) | + (`.continue/rules`) | + (`AGENTS.md`, `.goosehints`, skills) | + (`AGENTS.md`, skills) |
| Хуки/плагины | + (plugins, hooks) | + (plugins, hooks) | ~ (custom tools experimental) | − | + (hooks, plugins) | + (`tool.call`, registerTool) |
| Headless/CI | + (`cline`, `--acp`) | + (`kilo run`) | − (расширение) | + (`cn -p`) | + (`goose run`) | + (`amp -x`) |
| Структурированный вывод | ~ (SDK events/JSON) | ~ (CLI JSON) | − | ~ (`--verbose`, нет JSON-контракта в docs) | + (`--output-format json/stream-json`) | + (`--stream-json`) |
| Учёт стоимости | + (task header, subscription-aware) | + (usage, spend alerts, Auto Model) | ~ (condensing cost в UI) | − (не документировано) | ~ (`GOOSE_CLI_SHOW_COST`, default off) | + (credits + orb minutes) |
| Телеметрия по умолчанию | on (opt-out) | on (opt-out) | не документировано | − (удалена в 2.0.0) | off (opt-in) | не документировано |
| OTLP-экспорт | + | + | − | − | + | − |
| Лицензия | Apache-2.0 | MIT (клиенты) | Apache-2.0 (archived) | Apache-2.0 (read-only) | Apache-2.0 | Commercial |
| Статус 2026-11-11 | активен | активен | shut down | read-only | активен | активен |

### 3.8. Общие паттерны, видимые у всех шести

1. **MCP стал универсальным слоем инструментов.** У всех шести есть MCP-клиент; Goose идёт дальше и делает встроенные расширения MCP-серверами, а Amp рекомендует грузить MCP через skills, чтобы не раздувать список инструментов (https://goose-docs.ai/docs/getting-started/using-extensions.md, 2026-11-11; https://ampcode.com/docs/markdown/customize/mcp, 2026-11-11).
2. **Разделение «планирование / исполнение»** существует в пяти продуктах из шести (Cline Plan/Act, Kilo Plan/Code, Roo Architect/Code, Continue Plan/Agent, Amp `low`→`ultra`, Goose — через permission modes). Отличается лишь то, является ли Plan жёсткой границей (Kilo: только `.kilo/plans/`; Cline: subagent в Plan всё равно может писать через `python -c`).
3. **Компакция контекста — гигиенический минимум.** Cline, Kilo, Roo, Goose и Amp документируют авто-суммирование; Continue — нет (продукт заморожен).
4. **Стоимость показывается, но по-разному.** Cline скрывает доллары для подписок; Kilo показывает spend alerts и лимиты; Amp биллит кредиты и минуты orb; Goose по умолчанию не показывает оценку.
5. **Телеметрия — спектр, а не норма.** От «on by default с исключением контента» (Cline, Kilo) до «opt-in, default off» (Goose) и «удалена совсем» (Continue 2.0.0).

## 4. Gaps, risks, weaknesses

Раздел описывает **наблюдения со стороны конкурентов**: где их механики дают сбой, какие риски они создают и какие ограничения сами признают. Это не список задач для ZCode.

### 4.1. Жизненный цикл и vendor risk (Roo, Continue)

- **Roo Code**: расширение выключено 15 мая 2026, репозиторий archived, облако выключается, балансы возвращаются, `roocode.com` уходит на `roomote.dev`. Пользователь не получает встроенного пути миграции: документация предлагает «check out ZooCode … and Cline» (https://roocodeinc.github.io/Roo-Code/, 2026-11-11; https://app.roocode.com/, 2026-11-11). Риск: режимы, правила и `.roomodes`-конфигурация остаются в формате мёртвого продукта; форк ZooCode существует, но это отдельный проект (https://github.com/Zoo-Code-Org/Zoo-Code, 2026-11-11).
- **Continue**: приобретён Cursor, репозиторий read-only, финальный релиз удалил телеметрию и аутентификацию. Это честный «offboarding», но экосистема (Hub, marketplace-модели, CI-интеграции) не воспроизводится: `hub.continue.dev` не резолвится, `/hub` — 404 (https://www.continue.dev/, 2026-11-11; https://docs.continue.dev/hub, 2026-11-11). Риск: конфигурация `config.yaml` остаётся, а сервисные зависимости — нет.
- **Урок для оценки конкурентов**: наличие open-source лицензии не гарантирует непрерывность; Apache-2.0 позволяет форк, но не переносит хостинговые функции.

### 4.2. Разрешения: «удобный дефолт» против безопасности

- **Goose** по умолчанию работает в **Completely Autonomous** и прямо предупреждает: «goose operates autonomously by default… can execute commands and modify files without your approval» (https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md, 2026-11-11; https://goose-docs.ai/docs/getting-started/using-extensions.md, 2026-11-11). Классификация read/write отдана LLM, то есть граница безопасности зависит от суждения модели.
- **Amp** по умолчанию **не спрашивает** подтверждений вообще; политика — только через плагин, который пишет пользователь или админ workspace (https://ampcode.com/docs/markdown/tools, 2026-11-11). Это максимальная скорость и максимальная поверхность prompt injection: документация сама предупреждает про untrusted repositories и MCP.
- **Cline** компенсирует approval'ами, но безопасность команды решает **модель** через флаг `requires_approval`, а docs честно пишут «These are examples, not guarantees» (https://docs.cline.bot/features/auto-approve, 2026-11-11). YOLO снимает все проверки.
- **Kilo** даёт самую гранулярную модель (glob-правила, last-match-wins) и единственную OS-песочницу, но песочница **выключена по умолчанию**, не работает на Windows и ограничивает только запись, а не чтение: «The sandbox is a write boundary, not a privacy boundary» (https://kilo.ai/docs/getting-started/settings/sandboxing, 2026-11-11). Плюс project-config кешируется и не перечитывается — правка правил «на лету» не применяется (https://kilo.ai/docs/getting-started/settings/auto-approving-actions, 2026-11-11).
- **Cline subagents**: одно одобрение `spawn_agent` авторизует всё, что ребёнок сделает дальше, а настройки approval внутри не действуют (https://docs.cline.bot/features/subagents.md, 2026-11-11). Это скрытая передача полномочий.
- **Continue**: политика `Automatic` отключает шаг подтверждения; при этом Plan формально read-only, но MCP-инструменты в Plan доступны все — граница держится на том, что MCP-серверы сами не пишут (https://docs.continue.dev/ide-extensions/agent/how-it-works, 2026-11-11; https://docs.continue.dev/ide-extensions/agent/plan-mode, 2026-11-11).

### 4.3. Контекст: индексация — не бесплатная

- **Cline** не индексирует код и продаёт это как приватность/простоту (https://docs.cline.bot/enterprise-solutions/overview.md, 2026-11-11), но тогда качество поиска зависит от `search_codebase` и от того, что модель догадается прочитать; Memory Bank — ручная дисциплина, а не гарантия.
- **Kilo и Roo** индексируют, но требуют внешнего векторного хранилища и провайдера эмбеддингов: LanceDB/Qdrant у Kilo, Qdrant у Roo; у Kilo LanceDB не работает на Intel Mac, у Roo нужен отдельный Qdrant-сервер или cloud free tier (https://kilo.ai/docs/customize/context/codebase-indexing, 2026-11-11; https://roocodeinc.github.io/Roo-Code/features/codebase-indexing, 2026-11-11). Это операционная нагрузка и расходы на эмбеддинги.
- **Continue** оставил `@Codebase`/`@Docs`/context providers в deprecated-состоянии, а миграцию предлагает на MCP — то есть семантический поиск перестаёт быть встроенным (https://docs.continue.dev/reference/deprecated-context-providers, 2026-11-11).
- **Goose** не делает embeddings-индексацию; роль «понимания кода» играет расширение Analyze (call graph, структура), а не векторный поиск (https://goose-docs.ai/docs/getting-started/using-extensions.md, 2026-11-11).
- **Amp** не документирует индексацию; контекст держится на тредах, субагентах и system models, а не на semantic search (https://ampcode.com/docs/markdown/models-and-subagents, 2026-11-11).

### 4.4. Стоимость: непрозрачность переносится на пользователя

- **Amp**: три компонента — план, inference-кредиты, orb-минуты; non-model tools тоже жгут кредиты; orb паузится по таймаутам, а не по завершении работы. Пользователь видит `$` в сайдбаре, но прогноз сложен (https://ampcode.com/docs/markdown/pricing, 2026-11-11; https://ampcode.com/docs/markdown/orbs/sizes-and-costs, 2026-11-11).
- **Cline**: оценка в task header может отличаться от счёта из-за округления провайдера; для подписок доллары скрываются — это честно, но означает, что пользователь подписки не видит «стоимость» вообще (https://docs.cline.bot/core-workflows/task-management, 2026-11-11; https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts, 2026-11-11).
- **Kilo**: «zero markup» относится к inference, но есть 5% processing fee на top-ups/Pass, отдельная плата за cloud compute и истечение кредитов через год; free-модели ограничены 200 запросов/час (https://kilo.ai/pricing, 2026-11-11; https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards, 2026-11-11).
- **Goose** по умолчанию **не показывает** оценку стоимости (`GOOSE_CLI_SHOW_COST: false`), а `--max-turns` по умолчанию 1000 — то есть верхняя граница расхода очень высокая (https://goose-docs.ai/docs/guides/config-files.md, 2026-11-11).
- **Roo**: философия «trade tokens for quality» и «don't skimp on tokens» прямо поощряет высокий расход; стоимость condensing показывается, но общего бюджета/лимита в docs не найдено (https://roocodeinc.github.io/Roo-Code/, 2026-11-11; https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing, 2026-11-11).

### 4.5. Docs drift и расхождения источников

- **Kilo**: страница «What's New (April 2026)» утверждает, что code indexing «temporarily unavailable in the new extension» и ссылается на issue #6144; актуальная страница Codebase Indexing подробно документирует включение, провайдеров и хранилища (https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new, 2026-11-11; https://kilo.ai/docs/customize/context/codebase-indexing, 2026-11-11). Читатель не может понять, доступна ли функция в его версии.
- **Cline**: docs-индекс и продуктовые страницы расходятся: `features/browser-use` — 404, хотя browser tool и тумблер Auto Approve существуют; marketplace описан на маркетинговом сайте, но не в docs; страница `features/auto-compact` отдаёт контент, а `core-workflows/understanding-costs` — 404 (проверки 2026-11-11 перечислены в §8.2). Механики приходится собирать из исходников.
- **Continue**: README называет финальным релиз 2.0.0, а в GitHub одновременно опубликованы `v2.0.0-vscode` и `v2.1.0-vscode` (2026-06-19); docs продолжают описывать `summarize`-роль, которая «not currently used» (https://github.com/continuedev/continue, 2026-11-11; https://api.github.com/repos/continuedev/continue/releases?per_page=5, 2026-11-11; https://docs.continue.dev/reference, 2026-11-11).
- **Amp**: `llms.txt` перечисляет страницу Editor Extensions, но `/docs/editor-extensions` и `/docs/markdown/editor-extensions` отдают 404/`not_found`; telemetry-страница отсутствует. Механики редактора известны только из новости Agentic Review (https://ampcode.com/llms.txt, 2026-11-11; https://ampcode.com/news/agentic-code-review, 2025-12-18, accessed 2026-11-11).

### 4.6. Субагенты: границы возможностей

- **Cline**: субагенты недоступны в VS Code и JetBrains — то есть в тех поверхностях, где продукт исторически живёт; у них нет MCP; approval — «всё или ничего» (https://docs.cline.bot/features/subagents.md, 2026-11-11).
- **Kilo**: дочерний агент не может задать вопрос пользователю и не изолирует файловые правки — параллельные дети в одном worktree могут конфликтовать; отсюда отдельный Agent Manager с worktrees (https://kilo.ai/docs/customize/custom-subagents, 2026-11-11; https://kilo.ai/docs/automate/agent-manager, 2026-11-11).
- **Roo**: boomerang-подзадачи хороши для режимов, но вся конструкция привязана к мёртвому расширению; cloud-оркестрация недоступна (https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks, 2026-11-11).
- **Goose**: субагенты **выключены** в manual/smart/chat режимах — то есть чем безопаснее режим, тем меньше доступна оркестрация; таймаут 5 минут и «no output on failure» (https://goose-docs.ai/docs/guides/context-engineering/subagents.md, 2026-11-11).
- **Amp**: субагенты не общаются друг с другом, не управляются напрямую и работают на той же модели — нет возможности дать review-роли более сильную модель без установки отдельного плагина (https://ampcode.com/docs/markdown/models-and-subagents, 2026-11-11).
- **Continue**: first-class субагентов/оркестрации в документации нет — только режимы и tool loop (https://docs.continue.dev/ide-extensions/agent/how-it-works, 2026-11-11).

### 4.7. Телеметрия и приватность

- **Cline** и **Kilo** включают телеметрию по умолчанию; Cline исключает код/промпты, кроме запросов к собственному провайдеру, Kilo экспортирует OTLP-трейсы и в мобильном приложении предвыбирает optional telemetry в onboarding (https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md, 2026-11-11; https://kilo.ai/docs/getting-started/settings, 2026-11-11).
- **Goose** — opt-in, default off; это самый строгий дефолт из шести (https://goose-docs.ai/docs/guides/usage-data.md, 2026-11-11).
- **Continue** удалил телеметрию в финальном релизе — но вместе с аутентификацией, что ломает сервисные сценарии (https://github.com/continuedev/continue, 2026-11-11).
- **Amp**: публичной telemetry-политики в docs нет; есть диагностика с retention 7 дней. Это **неизвестное**, а не «нет телеметрии» (https://ampcode.com/docs/markdown/support/reporting-bugs, 2026-11-11).
- **Roo**: телеметрия детально не документирована; после shutdown проверить фактическое поведение нельзя (https://roocodeinc.github.io/Roo-Code/, 2026-11-11).

### 4.8. Лицензии и бизнес-модель

- **Amp** — единственный полностью закрытый агент: коммерческая лицензия плагинов/CLI, отсутствие публичного repo агента. Это ограничивает аудит, форк и самостоятельный хостинг; публичный `substrate` не заменяет агент (https://registry.npmjs.org/@ampcode/plugin/latest, 2026-11-11; https://api.github.com/repos/sourcegraph/amp, 404, 2026-11-11).
- **Kilo** — MIT только для клиентов; Gateway и Cloud «source available», то есть open-source-статус продукта неполный (https://api.github.com/repos/Kilo-Org/kilocode, 2026-11-11; https://kilo.ai/llms.txt, 2026-11-11 — claim).
- **Cline, Roo, Continue, Goose** — Apache-2.0, но у Roo и Continue лицензия уже не помогает: код archived/read-only (https://api.github.com/repos/RooCodeInc/Roo-Code, 2026-11-11; https://api.github.com/repos/continuedev/continue, 2026-11-11).

### 4.9. UX и «churn» абстракций

- **Kilo** переименовал modes → agents, убрал profile layer, заменил auto-confirm UI на per-tool permissions и **deprecated orchestrator**; пользовательские custom modes и закладки на docs устаревают (https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new, 2026-11-11).
- **Cline** перенёс функциональность в SDK/CLI/Desktop, а субагенты и Agent Teams оставил вне IDE — UX фрагментируется по поверхностям (https://docs.cline.bot/features/subagents.md, 2026-11-11; https://docs.cline.bot/llms.txt, 2026-11-11).
- **Amp** фиксирует режим на весь тред: чтобы «повысить мощность», нужно начать новый тред, что разрывает историю (https://ampcode.com/docs/markdown/the-dial, 2026-11-11).
- **Goose** даёт четыре режима, но переключение `/mode` доступно только в сессии, а default — autonomous; пользователь, ожидающий «спроси меня», получит обратное поведение (https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md, 2026-11-11).

### 4.10. Платформенные ограничения

- Kilo sandbox недоступен на Windows; LanceDB не работает на Intel Mac (https://kilo.ai/docs/getting-started/settings/sandboxing, 2026-11-11; https://kilo.ai/docs/customize/context/codebase-indexing, 2026-11-11).
- Cline checkpoints могут замедлять большие репозитории и занимать много диска (https://docs.cline.bot/core-workflows/checkpoints, 2026-11-11).
- Roo checkpoints требуют установленного Git (https://roocodeinc.github.io/Roo-Code/features/checkpoints, 2026-11-11).
- Continue JetBrains-плагин официально менее предпочтителен, чем CLI (https://github.com/continuedev/continue, 2026-11-11).
- Amp orbs — облачные машины; локальный запуск идёт через CLI/runner, а не через «локальный orb» (https://ampcode.com/docs/markdown/orbs/sizes-and-costs, 2026-11-11).

## 5. Strengths and differentiators

### 5.1. Cline

- **Процессная изоляция hub/spoke**: падение клиента не убивает агента, spoke изолирован от hub, роли не пересекаются — редкая для IDE-расширений архитектура (https://docs.cline.bot/sdk/architecture/hub-spoke, 2026-11-11).
- **Plan/Act с разными моделями** и сохранением истории — простая, но сильная экономика: дорогая модель планирует, дешёвая исполняет (https://docs.cline.bot/core-workflows/plan-and-act, 2026-11-11).
- **Checkpoints как полный снимок**, включая untracked, с трёхрежимным restore — сильнее, чем «git stash»-подходы (https://docs.cline.bot/core-workflows/checkpoints, 2026-11-11).
- **Subscription-aware отображение стоимости** — механика, которую мало кто делает: не показывать доллары там, где списание не поминутное (https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts, 2026-11-11).
- **ACP**: один и тот же CLI-агент встраивается в Zed, JetBrains, Neovim, Emacs без отдельного расширения (https://docs.cline.bot/usage/acp.md, 2026-11-11).
- **Отказ от индексации** — осознанный дифференциатор для privacy-sensitive enterprise (https://docs.cline.bot/enterprise-solutions/overview.md, 2026-11-11).

### 5.2. Kilo Code

- **Самая гранулярная модель разрешений**: per-tool allow/ask/deny + glob-правила + last-match-wins + отдельный `doom_loop` (https://kilo.ai/docs/getting-started/settings/auto-approving-actions, 2026-11-11).
- **Единственная OS-песочница** среди шести, с честной документацией границ: write-only, не privacy, project-config не может ослабить (https://kilo.ai/docs/getting-started/settings/sandboxing, 2026-11-11).
- **Настраиваемая компакция**: порог, prune-окно, tail turns, preserve tokens, отдельная дешёвая модель — инженерно полный набор (https://kilo.ai/docs/customize/context/context-condensing, 2026-11-11).
- **Auto Model с бенчмаркингом пула** — попытка сделать routing не «магическим», а проверяемым: каждая пара model+variant получает статус Ready/Failed (https://kilo.ai/docs/code-with-ai/agents/auto-model, 2026-11-11).
- **Spend alerts и per-user daily limits** — операционная зрелость для команд (https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards, 2026-11-11).
- **Единый `kilo.jsonc` для VS Code/JetBrains/CLI** — конфиг переживает смену поверхности (https://kilo.ai/docs/getting-started/settings, 2026-11-11).

### 5.3. Roo Code (историческая ценность)

- **Modes как «роли команды»** с per-mode sticky models и ограничениями файлов — самая развитая концепция «переключаемых специалистов» среди архивных продуктов (https://roocodeinc.github.io/Roo-Code/features/custom-modes, 2026-11-11).
- **Boomerang-оркестрация** с изолированным контекстом подзадач и возвратом сводки — прямой предшественник современных subagent-подходов (https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks, 2026-11-11).
- **Marketplace MCP+Modes** с project/global scope — идея «конфигурация как расширение» (https://roocodeinc.github.io/Roo-Code/features/marketplace, 2026-11-11).
- **Worktrees на ветку** — параллельные задачи без переключения ветки (https://roocodeinc.github.io/Roo-Code/features/worktrees, 2026-11-11).
- **Ограничение**: всё это — музейный экспонат; ценность в дизайне, не в эксплуатации.

### 5.4. Continue (историческая ценность)

- **`config.yaml` как декларативное определение агента**: модели + роли + capabilities + rules + prompts + MCP в одном версионируемом файле (https://docs.continue.dev/reference, 2026-11-11).
- **Model roles** (chat/edit/apply/autocomplete/embed/rerank) — редкая для 2023–2024 попытка разложить стоимость по функциям (https://docs.continue.dev/customize/models, 2026-11-11).
- **Локальный конфиг без сервера** — «всё на машине», пригодно для air-gapped (https://docs.continue.dev/guides/understanding-configs, 2026-11-11).
- **Headless CLI с `--readonly`, `--allow`, `--exclude`** — лаконичный контракт для CI (https://docs.continue.dev/cli/quickstart, 2026-11-11).
- **Ограничение**: продукт заморожен; Hub и CI-сценарии не воспроизводимы.

### 5.5. Goose

- **MCP-native**: встроенные расширения сами являются MCP-серверами, плюс malware-проверка и MCP Roots (https://goose-docs.ai/docs/getting-started/using-extensions.md, 2026-11-11).
- **Recipes с параметрами, response-схемой, retry и sub_recipes** — самый полный формат «переиспользуемого workflow» среди шести (https://goose-docs.ai/docs/guides/recipes/recipe-reference.md, 2026-11-11).
- **Smart Approval** — риск-ориентированный режим между «всё разрешено» и «спроси всё» (https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md, 2026-11-11).
- **Headless со structured output** (`--output-format json/stream-json`) и `--max-turns` — пригодно для CI (https://goose-docs.ai/docs/guides/goose-cli-commands.md, 2026-11-11).
- **Opt-in телеметрия** — самый консервативный дефолт (https://goose-docs.ai/docs/guides/usage-data.md, 2026-11-11).
- **GDK/ACP** — агент как библиотека и как backend для других приложений (https://goose-docs.ai/llms.txt, 2026-11-11).

### 5.6. Amp

- **Thread как переносимая единица работы**: один URL, все клиенты, отдельное место исполнения; шаринг с гранулярным доступом и multiplayer (https://ampcode.com/docs/markdown/threads, 2026-11-11).
- **Orbs** — машина на тред с поминутным биллингом и паузой по idle; self-hosted orbs и runner'ы (https://ampcode.com/docs/markdown/orbs/sizes-and-costs, 2026-11-11).
- **Dial с фиксацией режима на тред** — осознанный компромисс ради prompt cache и предсказуемости (https://ampcode.com/docs/markdown/the-dial, 2026-11-11).
- **Субагенты с изоляцией контекста и автоматическим выбором**, плюс плагины oracle/librarian/finder для смены модели на роли (https://ampcode.com/docs/markdown/models-and-subagents, 2026-11-11).
- **Плагины как policy layer** (`tool.call`, `amp.ai.ask`, `ctx.ui.confirm`) — расширяемость без встроенной модели разрешений (https://ampcode.com/docs/markdown/customize/plugins, 2026-11-11).
- **Model routing через свои ключи/подписки/шлюзы** и переиспользование ChatGPT/Claude/Copilot подписок (https://ampcode.com/docs/markdown/customize/model-routing, 2026-11-11).
- **Agent-to-agent** и fan-out для независимых задач и eval-ов (https://ampcode.com/docs/markdown/orbs/agent-to-agent, 2026-11-11).

## 6. Candidate recommendations

Раздел намеренно сформулирован как **наблюдения со стороны конкурентов**: какие механики стоит изучить и какие не стоит копировать. Это не предложения по изменению ZCode и не утверждения о его текущем коде.

### 6.1. Механики, которые стоит изучить (с указанием, почему)

| # | Механика | Где | Почему представляет интерес | Источник |
| --- | --- | --- | --- | --- |
| M1 | Hub/spoke с процессной изоляцией и capability-брокериджем | Cline | Позволяет IDE-клиенту падать/переподключаться, не убивая агента; роли клиента/хаба/спока не пересекаются, события идут через хаб | https://docs.cline.bot/sdk/architecture/hub-spoke (2026-11-11) |
| M2 | Graded permissions: allow/ask/deny + glob + last-match-wins + `doom_loop` | Kilo | Даёт предсказуемую и тестируемую политику без «модель решила»; `doom_loop` закрывает класс зацикливаний | https://kilo.ai/docs/getting-started/settings/auto-approving-actions (2026-11-11) |
| M3 | OS-песочница как отдельный слой поверх permissions, с честным контрактом «write-only, не privacy» | Kilo | Разделяет «что разрешено» и «что реально может изменить»; project-config не может ослабить глобальную политику | https://kilo.ai/docs/getting-started/settings/sandboxing (2026-11-11) |
| M4 | Snapshot-модель checkpoint'ов на границах шагов, с revert на уровне сообщения | Kilo | Позволяет откатывать «ход агента» целиком, не теряя историю; учитывает `.gitignore` | https://kilo.ai/docs/code-with-ai/features/checkpoints (2026-11-11) |
| M5 | Полный снимок файлов, включая untracked, в отдельном shadow-репозитории | Cline | Переживает перезапуск редактора; не трогает `.git`; три режима restore разделяют «файлы» и «историю» | https://docs.cline.bot/core-workflows/checkpoints (2026-11-11) |
| M6 | Anchored summary + prune старого tool output + отдельная дешёвая модель компакции | Kilo | Делает компакцию настраиваемой и не сжигает frontier-токены на суммаризацию | https://kilo.ai/docs/customize/context/context-condensing (2026-11-11) |
| M7 | Subscription-aware скрытие денежных оценок | Cline | Не показывает ложную «стоимость» там, где списание фиксированное; статус `unknown` не рендерится, чтобы не мигать цифрой | https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts (2026-11-11) |
| M8 | Spend alerts (окно + spike) и per-user daily limits | Kilo | Операционный контроль без ручного мониторинга; spike считается от 14-дневной часовой истории | https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards (2026-11-11) |
| M9 | Auto Model с бенчмаркингом пула и явными статусами | Kilo | Routing становится проверяемым: пара model+variant либо Ready, либо Failed/Unavailable; fallback на baseline | https://kilo.ai/docs/code-with-ai/agents/auto-model (2026-11-11) |
| M10 | Recipes: параметры, response-схема, retry, sub_recipes, activities | Goose | Формат переиспользуемого workflow, пригодный и для человека, и для CI; `prompt` обязателен в headless | https://goose-docs.ai/docs/guides/recipes/recipe-reference.md (2026-11-11) |
| M11 | Permission modes, включая Smart Approval, плюс per-tool Always/Ask/Never | Goose | Даёт «средний» режим автономии, которого нет у бинарных allow/deny; режим — на сессию | https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md (2026-11-11) |
| M12 | Thread как переносимая единица + orbs/runners | Amp | Разделяет «где исполняется» и «откуда смотрю»; шаринг, экспорт в Markdown/JSON, multiplayer | https://ampcode.com/docs/markdown/threads (2026-11-11) |
| M13 | Плагины как policy layer с `tool.call` и AI-классификатором риска | Amp | Позволяет строить политику без изменения ядра; пример с git-командами показывает паттерн | https://ampcode.com/docs/markdown/customize/plugins (2026-11-11) |
| M14 | Фиксация режима на тред ради prompt cache | Amp | Явно объяснённый компромисс: предсказуемость и кэш против гибкости; причину видно пользователю | https://ampcode.com/docs/markdown/the-dial (2026-11-11) |
| M15 | ACP как способ встраивания одного агента в чужие IDE | Cline | Убирает необходимость писать отдельное расширение под каждую IDE; stdio-контракт | https://docs.cline.bot/usage/acp.md (2026-11-11) |
| M16 | Playwright MCP как браузерный инструмент + отдельный `browser_open` только для localhost | Kilo | Разделяет «интерактивный браузер» и «превью локального приложения», ограничивая последнее localhost | https://kilo.ai/docs/automate/tools (2026-11-11) |
| M17 | `GOOSE_TOOL_DEFERRAL`: имена MCP-инструментов заранее, схемы on demand | Goose | Снижает размер system prompt при большом числе MCP-серверов | https://goose-docs.ai/docs/guides/config-files.md (2026-11-11) |
| M18 | MCP в skills через `mcp.json`, чтобы грузить инструменты on demand | Amp | Держит список инструментов чистым; MCP не попадает в контекст, пока не нужен | https://ampcode.com/docs/markdown/customize/mcp (2026-11-11) |

### 6.2. Механики, которые не стоит копировать (и почему)

| # | Анти-механика | Где | Почему не стоит копировать | Источник |
| --- | --- | --- | --- | --- |
| A1 | Автономный режим по умолчанию без подтверждений | Goose | Классификация read/write отдана LLM; «best effort» — не граница безопасности; при untrusted repo это прямой prompt injection | https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md (2026-11-11) |
| A2 | Полное отсутствие approval'ов по умолчанию, политика только через плагин | Amp | Безопасность становится ответственностью пользователя; плагин надо написать, прежде чем он начнёт защищать | https://ampcode.com/docs/markdown/tools (2026-11-11) |
| A3 | Решение о «безопасности» команды моделью (`requires_approval`) без статического allowlist | Cline | Docs сами пишут «examples, not guarantees»; поведение зависит от модели и промпта | https://docs.cline.bot/features/auto-approve (2026-11-11) |
| A4 | Одно одобрение субагента, авторизующее все его дальнейшие действия | Cline | Скрытая передача полномочий; настройки approval внутри не действуют | https://docs.cline.bot/features/subagents.md (2026-11-11) |
| A5 | Песочница, ограничивающая только запись, при выключенном по умолчанию состоянии | Kilo | Чтение остаётся неограниченным; «write boundary, not privacy boundary»; Windows не поддержан | https://kilo.ai/docs/getting-started/settings/sandboxing (2026-11-11) |
| A6 | Кеширование project-config без перечитывания | Kilo | Правка правил «на лету» не применяется; пользователь думает, что политика новая, а действует старая | https://kilo.ai/docs/getting-started/settings/auto-approving-actions (2026-11-11) |
| A7 | Индексация, требующая внешнего векторного сервера, при отсутствии fallback | Roo/Kilo | Qdrant/LanceDB — операционная нагрузка; Intel Mac и Windows дают platform-specific провалы | https://roocodeinc.github.io/Roo-Code/features/codebase-indexing (2026-11-11); https://kilo.ai/docs/customize/context/codebase-indexing (2026-11-11) |
| A8 | «Memory» как prompt-дисциплина без enforcement | Cline | Работает только если модель следует инструкции читать все файлы каждый раз; зависит от instruction-following | https://docs.cline.bot/best-practices/memory-bank.md (2026-11-11) |
| A9 | Телеметрия on-by-default с исключениями, которые зависят от провайдера | Cline/Kilo | Для Cline/ClinePass промпты всё же попадают в телеметрию; для Kilo mobile optional telemetry предвыбрана | https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md (2026-11-11); https://kilo.ai/docs/getting-started/settings (2026-11-11) |
| A10 | Отсутствие встроенного бюджета при philosophy «don't skimp on tokens» | Roo | Высокий расход поощряется, лимита в docs нет; после shutdown это уже не исправить | https://roocodeinc.github.io/Roo-Code/ (2026-11-11) |
| A11 | Фиксация режима на весь тред без mid-thread escalation | Amp | Нельзя усилить модель, не начав новый тред и не потеряв непрерывность | https://ampcode.com/docs/markdown/the-dial (2026-11-11) |
| A12 | Один общий контекст/история для параллельных детей в одном worktree | Kilo | Дети не изолируют правки; конфликт файлов возможен, нужен Agent Manager | https://kilo.ai/docs/customize/custom-subagents (2026-11-11) |
| A13 | Docs, расходящиеся с фактическим состоянием функции | Kilo/Cline/Continue | «temporarily unavailable» против полной docs-страницы; 404 на browser-use; README 2.0.0 против 2.1.0 | §4.5, ссылки там же (2026-11-11) |
| A14 | Отсутствие публичной telemetry-политики при закрытом исходнике | Amp | Нельзя отличить «нет телеметрии» от «не документирована»; остаётся unknown | https://ampcode.com/docs/markdown/support/reporting-bugs (2026-11-11) |
| A15 | Абстракция orchestrator, которая позже становится лишней | Kilo | Пользовательские конфиги и привычки устаревают; migration cost ложится на пользователя | https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode (2026-11-11) |
| A16 | Зависимость сервисных функций от хостинга вендора | Continue/Roo | Hub/Cloud умирают вместе с компанией; локальный конфиг остаётся, сервис — нет | https://docs.continue.dev/hub (404, 2026-11-11); https://app.roocode.com/ (2026-11-11) |

## 7. Open questions and unverified

| # | Вопрос | Почему не решён | Что бы решило |
| --- | --- | --- | --- |
| Q1 | Реально ли Cline Auto Approve классифицирует команды так, как описано, на всех провайдерах? | Docs дают примеры, но не гарантии; рантайм не запускался | Прогон с разными моделями и журналированием `requires_approval` |
| Q2 | Что именно попадает в телеметрию Cline при запросах к Cline/ClinePass? | Docs говорят «can include the prompt and the model's response», без деталей | Аудит сетевых запросов или исходников telemetry |
| Q3 | Работает ли codebase indexing в текущем VS Code-расширении Kilo? | Docs-страница описывает функцию, What's New называет её временно недоступной | Проверка на установленной версии `v7.8.27`/`v7.8.28` |
| Q4 | Поддерживает ли Kilo sandbox сетевые исключения для MCP при network deny? | Docs говорят, что MCP-вызовы недоступны, но prompt retrieval — вне политики | Рантайм-тест с MCP-сервером |
| Q5 | Какие именно cloud-агенты были у Roo Code и как они работали? | Облако выключено; в архивном sitemap нет cloud-раздела | Архивные docs/релизы, если сохранились |
| Q6 | Есть ли у Continue CI/GitHub Actions интеграция? | Все проверенные маршруты — 404 | Поиск в архиве репозитория (docs-каталог) |
| Q7 | Что стало с Continue Hub и его моделями/ассистентами? | DNS не резолвится, `/hub` 404, в навигации нет | Архивные снапшоты/репозиторий docs |
| Q8 | Есть ли у Goose публичный benchmark/eval-набор? | В проверенных docs только blog-посты без методологии | Поиск в репозитории `evals/` и релизах |
| Q9 | Как Amp собирает телеметрию? | Отдельной страницы нет; есть только diagnostics с retention 7 дней | Публичная privacy/telemetry-политика или аудит |
| Q10 | Какие модели реально стоят за режимами Amp? | Docs говорят, что mapping меняется server-side, и приводят примеры имён | Страница `/modes` на дату проверки (не фиксировалась) |
| Q11 | Насколько безопасен `substrate` как замена песочнице Amp? | Это отдельный проект, не агент; интеграция с Amp не документирована в проверенных страницах | Docs по self-hosted orbs + Substrate |
| Q12 | Есть ли у Amp встроенный approval-механизм помимо плагинов? | Docs утверждают, что approval'ов нет по умолчанию; enterprise controls описаны только для MCP allowlist/моделей | Enterprise docs или исходники плагинов |
| Q13 | Точные цены cloud compute Kilo | Таблица на странице тарифов обрезана в извлечении после `Standard` | Полный рендер страницы или API тарифов |
| Q14 | Лицензия Amp SDK (`@ampcode/sdk` / Python) | Проверены только `@ampcode/plugin` и `@ampcode/cli` | npm/PyPI-манифесты SDK |
| Q15 | Сохранился ли форк ZooCode как полноценная замена Roo? | Проверена только страница репозитория (Apache-2.0, не archived); функциональность не тестировалась | Сравнение релизов/фич форка с Roo 3.54.0 |

## 8. Evidence appendix

### 8.1. Источники по продуктам

Все URL проверены 2026-11-11. Тип: **repo** — GitHub API/raw, **docs** — официальная документация, **site** — официальный сайт/тарифы, **news** — официальный блог/новость, **pkg** — реестр пакетов.

#### Cline

| URL | Тип | Что подтверждает |
| --- | --- | --- |
| https://api.github.com/repos/cline/cline | repo | `full_name`, Apache-2.0, `archived: false`, 71 519 stars, `pushed_at` 2026-11-11T08:50:28Z |
| https://api.github.com/repos/cline/cline/releases?per_page=6 | repo | `v4.1.26` 2026-10-26; SDK/CLI/desktop релизы |
| https://docs.cline.bot/llms.txt | docs | карта docs: Plan & Act, Checkpoints, Subagents, Memory Bank, Auto Approve, MCP, Plugins, Hooks, Skills, Telemetry, ACP |
| https://docs.cline.bot/core-workflows/plan-and-act | docs | Plan не меняет файлы/не выполняет команды; история и модели сохраняются |
| https://docs.cline.bot/tools-reference/all-cline-tools | docs | 9 инструментов; `editor` XOR `apply_patch`; `toolRoutingRules` |
| https://docs.cline.bot/core-workflows/checkpoints | docs | shadow git, коммит после каждого tool use, untracked, 3 restore, default on |
| https://docs.cline.bot/features/auto-approve | docs | per-call approval, категории, отсутствие allowlist, YOLO |
| https://docs.cline.bot/best-practices/memory-bank.md | docs | 6 файлов, «I MUST read ALL…», ручное включение |
| https://docs.cline.bot/mcp/mcp-overview | docs | пути конфига, STDIO/remote, `streamableHttp`, legacy `sse`, `autoApprove` |
| https://docs.cline.bot/features/subagents.md | docs | CLI/Desktop only, отдельный контекст, нет MCP, blanket approval |
| https://docs.cline.bot/features/auto-compact | docs | авто-суммаризация, стоимость tool call, fallback на truncation |
| https://docs.cline.bot/core-workflows/task-management | docs | task header cost estimate, обновление после каждого запроса |
| https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md | docs | opt-out, что собирается, исключение контента, org setting |
| https://docs.cline.bot/enterprise-solutions/overview.md | docs | «No codebase indexing» |
| https://docs.cline.bot/usage/acp.md | docs | `cline --acp`, Zed/JetBrains конфиги |
| https://docs.cline.bot/usage/cline-desktop | docs | Desktop Marketplace: skills, MCP, plugins |
| https://raw.githubusercontent.com/cline/cline/main/apps/vscode/src/services/browser/BrowserSession.ts | repo | puppeteer-core, chrome-launcher, порт 9222 |
| https://raw.githubusercontent.com/cline/cline/main/apps/vscode/src/shared/BrowserSettings.ts | repo | viewport 900×600, remote host, `disableToolUse: true`, пресеты |
| https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts | repo | `show/hide/subscription`, скрытие долларов для подписок |
| https://docs.cline.bot/sdk/architecture/hub-spoke | docs | hub/spoke/client, process boundaries |
| https://cline.bot/mcp-marketplace | site | маркетинговый каталог MCP (JS-приложение) |

#### Kilo Code

| URL | Тип | Что подтверждает |
| --- | --- | --- |
| https://api.github.com/repos/Kilo-Org/kilocode | repo | MIT, `archived: false`, 27 942 stars, `pushed_at` 2026-11-11T09:21:06Z |
| https://api.github.com/repos/Kilo-Org/kilocode/releases?per_page=5 | repo | `v7.8.27` 2026-11-05, `v7.8.28` pre-release 2026-11-07 |
| https://kilo.ai/llms.txt | site | продуктовый FAQ: 500+ моделей, 4 агента, cloud agents, MCP marketplace, MIT |
| https://kilo.ai/docs/llms.txt | docs | полный индекс docs (34 498 строк) |
| https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode | docs | orchestrator deprecated, `task`, general/explore, swarm |
| https://kilo.ai/docs/customize/custom-subagents | docs | `mode`, `task`, foreground/background, non-interactive, no worktree |
| https://kilo.ai/docs/customize/custom-modes | docs | Markdown+YAML, поля агента, precedence, merge |
| https://kilo.ai/docs/code-with-ai/agents/using-agents | docs | code/ask/plan/debug, доступы, способы переключения |
| https://kilo.ai/docs/automate/tools | docs | группы инструментов, `browser_open`, Playwright MCP, удалённый `interactive_terminal` |
| https://kilo.ai/docs/customize/context/codebase-indexing | docs | opt-in, Tree-sitter, провайдеры, LanceDB/Qdrant, ключи |
| https://kilo.ai/docs/customize/context/context-condensing | docs | compaction defaults, prune 40K, `agent.compaction.model`, env |
| https://kilo.ai/docs/customize/context/memory | docs | project memory, 3 файла, auto-save, recall modes |
| https://kilo.ai/docs/code-with-ai/features/checkpoints | docs | snapshot repo, step boundaries, revert по сообщению, retention |
| https://kilo.ai/docs/getting-started/settings/auto-approving-actions | docs | allow/ask/deny, glob, last-match-wins, defaults, config caching |
| https://kilo.ai/docs/getting-started/settings/sandboxing | docs | opt-in, write-only, network deny, Windows, trusted integrations |
| https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards | docs | doom_loop, limits, alerts, 200 free req/h |
| https://kilo.ai/docs/code-with-ai/agents/auto-model | docs | frontier/efficient/free, пул, benchmark statuses |
| https://kilo.ai/docs/customize/marketplace | docs | Agent/Skill/MCP/Plugin, project/global |
| https://kilo.ai/docs/automate/mcp/using-in-kilo-code | docs | `mcp` key, local/remote, OAuth |
| https://kilo.ai/docs/contributing/architecture | docs | три слоя, `packages/opencode`, `kilo serve`, cloud repo |
| https://kilo.ai/docs/getting-started/settings | docs | `kilo.jsonc`, OTEL, privacy mode |
| https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new | docs | rebuild April 2026, indexing «temporarily unavailable», `/review` |
| https://kilo.ai/pricing | site | Free/Teams $15/Enterprise, Gateway, Pass $19, 5% fee, orb prices |
| https://www.anaconda.com/blog/anaconda-acquires-kilo-code | news | приобретение, дата Jul. 15, 2026 |

#### Roo Code

| URL | Тип | Что подтверждает |
| --- | --- | --- |
| https://api.github.com/repos/RooCodeInc/Roo-Code | repo | Apache-2.0, `archived: true`, `pushed_at` 2026-05-15 |
| https://api.github.com/repos/RooCodeInc/Roo-Code/releases?per_page=5 | repo | `v3.54.0` 2026-05-15 |
| https://roocodeinc.github.io/Roo-Code/ | docs | «Extension Shutdown… May 15th»; альтернативы ZooCode/Cline |
| https://roocodeinc.github.io/Roo-Code/features/custom-modes | docs | поля mode, groups, sticky models, `.roomodes`, YAML export/import |
| https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks | docs | orchestrator, `new_task`, изолированный контекст |
| https://roocodeinc.github.io/Roo-Code/features/checkpoints | docs | shadow git, снимки перед правками, timeout 10–60 с |
| https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing | docs | default on, threshold 100%, стоимость в UI |
| https://roocodeinc.github.io/Roo-Code/features/codebase-indexing | docs | Tree-sitter, Qdrant, `codebase_search` |
| https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions | docs | security warning, All/None, `Cmd+Alt+A` |
| https://roocodeinc.github.io/Roo-Code/features/marketplace | docs | MCP+Modes, one-click, project/global |
| https://roocodeinc.github.io/Roo-Code/features/worktrees | docs | worktree на ветку, отдельное окно |
| https://roocodeinc.github.io/Roo-Code/features/skills | docs | on-demand skills vs custom instructions |
| https://roocodeinc.github.io/Roo-Code/features/mcp/overview | docs | STDIO/Streamable HTTP/SSE |
| https://app.roocode.com/ | site | «Roo Code Cloud is shutting down… Roomote… balances refunded» |
| https://roocode.com/ | site | 301 → https://roomote.dev/ |
| https://github.com/Zoo-Code-Org/Zoo-Code | repo | форк, Apache-2.0, не archived |

#### Continue

| URL | Тип | Что подтверждает |
| --- | --- | --- |
| https://api.github.com/repos/continuedev/continue | repo | Apache-2.0, `archived: false`, 36 455 stars, `pushed_at` 2026-11-05 |
| https://github.com/continuedev/continue | repo | README: read-only, final 2.0.0, telemetry/auth removed |
| https://www.continue.dev/ | site | «acquired by Cursor» |
| https://api.github.com/repos/continuedev/continue/releases?per_page=5 | repo | `v2.0.0-vscode` и `v2.1.0-vscode` 2026-06-19 |
| https://docs.continue.dev/reference | docs | config.yaml: name/version/schema/models/context/rules/prompts/docs/mcpServers/data; роли и capabilities |
| https://docs.continue.dev/customize/models | docs | 6 ролей, recommended models by role |
| https://docs.continue.dev/ide-extensions/agent/how-it-works | docs | handshake, Chat/Plan/Agent, списки инструментов |
| https://docs.continue.dev/ide-extensions/agent/quick-start | docs | permission по умолчанию, tool policies |
| https://docs.continue.dev/ide-extensions/agent/plan-mode | docs | read-only, MCP tools доступны |
| https://docs.continue.dev/ide-extensions/agent/context-selection | docs | file content, LSP, imports, history, tool responses |
| https://docs.continue.dev/customize/rules | docs | `.continue/rules`, конкатенация в system message |
| https://docs.continue.dev/guides/understanding-configs | docs | локальный `~/.continue/config.yaml`, auto-reload |
| https://docs.continue.dev/ide-extensions/install | docs | VS Code и JetBrains |
| https://docs.continue.dev/cli/quickstart | docs | `cn`, TUI/headless, флаги `--auto`, `--readonly`, `--allow`, `--exclude` |
| https://docs.continue.dev/reference/continue-mcp | docs | `.continue/mcpServers/*.yaml`, agent mode only |
| https://docs.continue.dev/reference/deprecated-context-providers | docs | context providers deprecated, миграция на MCP |
| https://registry.npmjs.org/@continuedev/cli/latest | pkg | Apache-2.0, версия 1.5.47 |

#### Goose

| URL | Тип | Что подтверждает |
| --- | --- | --- |
| https://api.github.com/repos/block/goose | repo | redirect на `aaif-goose/goose`, Apache-2.0, 56 448 stars, `pushed_at` 2026-11-11 |
| https://api.github.com/repos/aaif-goose/goose/releases?per_page=5 | repo | `v1.59.0` 2026-11-10 |
| https://raw.githubusercontent.com/aaif-goose/goose/main/README.md | repo | desktop/CLI/API, Rust, 15+ провайдеров, 70+ MCP, AAIF |
| https://goose-docs.ai/llms.txt | docs | карта docs, GDK, ACP |
| https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md | docs | 4 режима, autonomous default, `/mode` |
| https://goose-docs.ai/docs/guides/managing-tools/tool-permissions.md | docs | Always/Ask/Never, «<25 tools» рекомендация |
| https://goose-docs.ai/docs/getting-started/using-extensions.md | docs | built-in extensions = MCP servers, malware check, MCP Roots |
| https://goose-docs.ai/docs/guides/recipes/recipe-reference.md | docs | поля recipe, `.yml` не поддержан, `sub_recipes`, summon |
| https://goose-docs.ai/docs/guides/context-engineering/subagents.md | docs | disabled в non-autonomous, parallel/sequential, 5-min timeout |
| https://goose-docs.ai/docs/guides/context-engineering/custom-agents.md | docs | Markdown+YAML, `.agents/agents`, delegate/load |
| https://goose-docs.ai/docs/tutorials/headless-goose.md | docs | `goose run`, no-session, auto-summarize, CI-примеры |
| https://goose-docs.ai/docs/guides/goose-cli-commands.md | docs | `--max-turns` 1000, `--output-format`, `--recipe` |
| https://goose-docs.ai/docs/guides/config-files.md | docs | config.yaml/permission.yaml/secrets.yaml, `GOOSE_CLI_SHOW_COST`, OTEL |
| https://goose-docs.ai/docs/guides/usage-data.md | docs | opt-in, что собирается, no content |
| https://goose-docs.ai/docs/mcp/summon-mcp.md | docs | Summon: recipes/agents/subrecipes → subagents |

#### Amp

| URL | Тип | Что подтверждает |
| --- | --- | --- |
| https://ampcode.com/llms.txt | docs | индекс всех docs; редакторские расширения, orbs, boxes, puck, sdk |
| https://ampcode.com/docs/markdown | docs | позиционирование, surfaces, threads |
| https://ampcode.com/docs/markdown/threads | docs | thread URL, share dialog, multiplayer, export, Activity |
| https://ampcode.com/docs/markdown/the-dial | docs | low/medium/high/ultra, фиксация режима, prompt cache |
| https://ampcode.com/docs/markdown/models-and-subagents | docs | Task/Read Thread, same model, system models, custom agents |
| https://ampcode.com/docs/markdown/tools | docs | «does not ask for approval», Painter, policy plugin |
| https://ampcode.com/docs/markdown/customize/mcp | docs | `amp.mcpServers`, remote definitions, skills-bundled MCP, `${amp:id-token}` |
| https://ampcode.com/docs/markdown/customize/model-routing | docs | connections: keys/subscriptions/cloud/gateways, workspace, enterprise restrictions |
| https://ampcode.com/docs/markdown/customize/plugins | docs | plugin API, locations/precedence, `tool.call`, permission example |
| https://ampcode.com/docs/markdown/customize/skills | docs | `.agents/skills`, 11-level precedence, `amp skill add` |
| https://ampcode.com/docs/markdown/customize/agents-md | docs | AGENTS.md locations, precedence, not applied to subagents |
| https://ampcode.com/docs/markdown/cli/execute-mode | docs | `-x`, `-ox`, `--mcp-config`, `--timings`, `--plugin-ready-timeout`, runner |
| https://ampcode.com/docs/markdown/orbs/sizes-and-costs | docs | размеры и цены orb, pause rules, billing |
| https://ampcode.com/docs/markdown/orbs/agent-to-agent | docs | delegate across threads/projects/machines, no automatic file sharing |
| https://ampcode.com/docs/markdown/pricing | docs | Hobby/Megawatt/Gigawatt/Teams/Enterprise, credits, no markup |
| https://ampcode.com/docs/markdown/support/reporting-bugs | docs | `amp report-bug`/`amp diagnostics`, retention 7 days |
| https://ampcode.com/news/agentic-code-review | news | review panel, pre-scan, review agent, Gemini 3 Pro (2025-12-18) |
| https://ampcode.com/security | site | data retention, encryption, audit logging |
| https://api.github.com/repos/sourcegraph/amp | repo | 404 — публичного repo агента нет |
| https://api.github.com/orgs/ampcode/repos?per_page=20 | repo | org содержит plugins, SDK demo, substrate; агента нет |
| https://raw.githubusercontent.com/ampcode/substrate/main/README.md | repo | Substrate — sandbox runtime, Apache-2.0, не агент |
| https://registry.npmjs.org/@ampcode/plugin/latest | pkg | «Amp Commercial License» |
| https://registry.npmjs.org/@ampcode/cli/latest | pkg | «SEE LICENSE IN LICENSE.md» |

### 8.2. Недоступные и неполные источники

| URL | Код/состояние | Что это значит |
| --- | --- | --- |
| https://docs.cline.bot/features/browser-use | 404 | Документации браузера нет; механика восстановлена из исходников |
| https://docs.cline.bot/core-workflows/understanding-costs | 404 | Стоимость описана в `core-workflows/task-management` |
| https://docs.cline.bot/mcp/mcp-marketplace | 200, но контент = общая MCP-страница | Отдельной docs-страницы marketplace нет |
| https://docs.continue.dev/llms.txt | 404 | Машинного индекса docs нет; навигация собиралась из HTML |
| https://docs.continue.dev/sitemap.xml | 404 | Sitemap отсутствует |
| https://docs.continue.dev/hub | 404 | Раздел Hub недоступен |
| https://hub.continue.dev | DNS failure (`Could not resolve host`) | Хостинг Hub не существует |
| https://docs.continue.dev/customize/model-roles | 404 | Роли описаны в `/reference` и `/customize/models` |
| https://ampcode.com/docs/telemetry | 404 | Публичной telemetry-страницы нет |
| https://ampcode.com/docs/markdown/telemetry | `{"error":"not_found"}` | То же |
| https://ampcode.com/docs/editor-extensions | 404 | Страница, на которую ссылается `llms.txt`, отсутствует |
| https://ampcode.com/docs/markdown/editor-extensions | `{"error":"not_found"}` | То же |
| https://api.github.com/repos/sourcegraph/amp | 404 | Публичного репозитория агента нет |
| https://api.github.com/repos/Zoo-Code-Org/Zoo-Code | GitHub API rate limit на момент запроса | Метаданные форка взяты из HTML-страницы GitHub |
| `https://kilo.ai/pricing` (таблица cloud compute) | 200, но HTML-извлечение обрезано | Цены после `Cloud Agent — Standard` не зафиксированы |
| Roo Code Cloud docs | отсутствуют в архивном sitemap | Cloud-механики не воспроизводимы |
| Continue CI/GitHub Actions docs | все проверенные маршруты 404 | Тема остаётся unknown, а не «отсутствует» |

### 8.3. Выполненные проверки (точные команды и результаты)

- `git rev-parse --short HEAD` → `d10f0b69`; `git branch --show-current` → `dev`; `git status --porcelain` → `?? docs/research/` (baseline до записи).
- `date -u +"%Y-%m-%dT%H:%M:%SZ"` → `2026-11-11T09:49:16Z`.
- `node scripts/check-workspace-freshness.mjs` → exit 0, вывод: `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）`.
- `CodeIndex status` → `state: ready`, `partial: false`, generation 1466, 10 007 файлов, 26 791 чанк, 278 154 символа, 377 669 рёбер.
- `curl -sIL https://roocode.com/` → `HTTP/2 301`, `location: https://roomote.dev/`.
- `curl -sS https://hub.continue.dev` → `Could not resolve host`.
- `curl -s https://api.github.com/repos/sourcegraph/amp` → HTTP 404.
- `curl -s https://registry.npmjs.org/@ampcode/plugin/latest` → `"license": "Amp Commercial License"`.
- `curl -s https://registry.npmjs.org/@ampcode/cli/latest` → `"license": "SEE LICENSE IN LICENSE.md"`.
- `curl -s https://api.github.com/repos/block/goose` → `full_name: "aaif-goose/goose"` (redirect).
- `curl -s https://api.github.com/repos/RooCodeInc/Roo-Code` → `"archived": true`, `pushed_at: "2026-05-15T18:08:47Z"`.
- `curl -s https://api.github.com/repos/continuedev/continue/releases?per_page=5` → `v2.0.0-vscode` и `v2.1.0-vscode`, оба `2026-06-19T00:24:01Z`/`00:24:00Z`.
- `curl -s https://api.github.com/repos/Kilo-Org/kilocode/releases?per_page=5` → `v7.8.27` 2026-11-05, `v7.8.28` 2026-11-07.
- `curl -s https://api.github.com/repos/aaif-goose/goose/releases?per_page=5` → `v1.59.0` 2026-11-10.
- `curl -s https://api.github.com/repos/cline/cline/releases?per_page=6` → `v4.1.26` 2026-10-26.
- Чтение raw-исходников Cline (браузер, cost display) — HTTP 200, содержимое процитировано в §3.1.

### 8.4. Что не проверялось и не может быть подтверждено этим отчётом

- Ни один продукт не запускался; поведение в рантайме, фактическая безопасность approval'ов, реальная точность compaction и стоимость не измерялись.
- Числа stars/forks/issue — снимок 2026-11-11, не устойчивая метрика.
- Заявления «500+ моделей», «zero markup», «3M developers», «почти 10 трлн токенов/мес», «15+ providers», «70+ extensions», «profitable» — маркетинговые claim'ы вендоров; независимого подтверждения нет.
- Cloud-функции Roo Code и Continue Hub не воспроизводимы: сервисы выключены.
- Amp telemetry, Amp SDK-лицензия, точные цены cloud compute Kilo — unknown (см. §7).
- Continue CI-интеграции — unknown; отсутствие docs-маршрутов не доказывает отсутствие функции.

## Coverage status

**Статус: partial (высокая полнота по шести продуктам; незакрытые пункты перечислены явно).**

Покрыто и перепроверено первоисточником: Cline (архитектура, plan/act, tools, checkpoints, MCP, subagents, memory bank, auto-approve, стоимость, телеметрия, браузер по исходникам, ACP, лицензия); Kilo Code (агенты, orchestrator/subagents, permissions, sandbox, indexing, compaction, memory, MCP, marketplace, Auto Model, cost controls, телеметрия, архитектура, тарифы, лицензия); Roo Code (modes, boomerang, checkpoints, condensing, indexing, MCP, marketplace, worktrees, skills, auto-approve, shutdown); Continue (config.yaml, model roles, rules/prompts, context, режимы, tool handshake, CLI, MCP, IDE support, Hub — отсутствует, лицензия, acquisition); Goose (extensions/MCP, recipes, permissions, subagents, custom agents, headless, config, telemetry, GDK/ACP, лицензия); Amp (threads/sharing, Dial, subagents, tools/permissions, MCP, model routing, pricing/orbs, plugins/skills, AGENTS.md, agent-to-agent, review, diagnostics, лицензия).

Не проверено: фактический рантайм любого продукта; Roo cloud agents (сервис выключен); Continue CI/GitHub Actions (docs-маршруты 404); Continue Hub (DNS/404); Amp telemetry-политика (страница отсутствует); Amp SDK-лицензия (не смотрели манифесты SDK); точные цены cloud compute Kilo (таблица обрезана); Cline Agent Teams в деталях (страница не перечитывалась); реальные модели за режимами Amp на дату проверки (страница `/modes` не фиксировалась).

Блокеров нет. Ограничение: часть docs-сайтов отдаёт контент только через JS, поэтому для Cline browser и Amp использовались raw-исходники и raw-markdown endpoints; там, где это не удалось, зафиксировано `404`/`not_found`, а не догадка.

**Подтверждение:** записан только этот файл — `<repo-root>/docs/research/partials/2026-11-11-competitors-c2-ide-extensions.md`. Продуктовые файлы, конфиги, lockfile и другие partial-файлы не изменялись; `git status --porcelain` после работы содержит только `?? docs/research/`.
