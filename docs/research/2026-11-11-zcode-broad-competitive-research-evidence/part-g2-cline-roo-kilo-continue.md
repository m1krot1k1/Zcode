# Part G2 — Конкуренты: Cline, Roo Code, Kilo Code, Continue

Дата доступа ко всем источникам: **2026-11-11T06:08:35Z — 2026-11-11T06:43:47Z** (UTC, получено командой `date -u +%Y-%m-%dT%H:%M:%SZ`).
Заявленная дата отчёта: 2026-11-11.

## 0. Baseline репозитория (зафиксирован до сбора данных)

| Параметр | Значение |
| --- | --- |
| Branch | `dev` (`## dev...origin/dev`) |
| HEAD | `d10f0b69` (`Выпустить macOS Preview 3.17.102.`) |
| Предыдущие коммиты | `bbb756e8` (`Не красить весь индекс частичным из-за фиктивных паролей в тестах.`), `fc70a81b` (`Выпустить macOS Preview 3.17.101.`), `982e30c9`, `05bd5b31` |
| `check-workspace-freshness.mjs` | `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）` |
| `git status --porcelain` до записи | пусто; после создания каталога — `?? docs/research/` |
| Изменения production-кода/конфигов/зависимостей | отсутствуют |

Ограничения задачи соблюдены: research-only, без коммитов и установок. Единственная запись — этот файл.

## 1. Метод, статусы и границы достоверности

- Загружен skill `research` (`<home>/Desktop/Zcode Preview.app/Contents/Resources/glm/packages/bundled-skills/skills/research/SKILL.md`); процедура соблюдена: первичные источники → проверка формулировок → явные метки.
- Разрешённые источники: официальные сайты, официальные docs, официальные GitHub API/releases/README, официальные блоги. Вторичные обзоры не использовались как единственная опора.
- Метки статуса:
  - **confirmed** — утверждение прямо следует из текста первичного источника (страница/README/API-ответ).
  - **marketing** — официальное позиционирование/цифры вендора без независимого подтверждения (число пользователей, «#1», «500+ models» и т.п.).
  - **unverified** — источник доступен, но утверждение не подтверждается его текстом, либо относится к отсутствию/недоступности.
- Для двух продуктов зафиксированы **изменения статуса в 2026 году**, которые радикально меняют конкурентную картину: Roo Code (shutdown, архив репозитория) и Continue (acquired by Cursor, репозиторий read-only). Оба случая подтверждены первичными источниками, а не слухами.
- Kilo Code: 15 июля 2026 объявлено о покупке Anaconda; продукт продолжает выходить (release `v7.8.27`, 2026-11-05).
- Cline: активен, релизы идут (SDK `v0.2.0`, CLI `v3.0.74`, desktop `v0.0.49`, extension `v4.1.26` — все 2026-10-26).

## 2. Ключевые статусные выводы (сводка)

| # | Вывод | Доказательство | Статус |
| --- | --- | --- | --- |
| K1 | **Roo Code extension прекратил работу 15 мая 2026**; GitHub-репозиторий archived, read-only; последний релиз 3.50.0 (2026-02-19); docs архивированы с `Last updated on May 15, 2026` | https://github.com/RooCodeInc/Roo-Code ; https://api.github.com/repos/RooCodeInc/Roo-Code ; https://roocodeinc.github.io/Roo-Code/ ; https://roocodeinc.github.io/Roo-Code/update-notes/ | confirmed |
| K2 | **Roo Code Cloud выключается**; `roocode.com` 301 → `roomote.dev`; в кабинете: «We're winding down Roo Code Cloud to focus on Roomote» | https://app.roocode.com/ ; `curl -I https://roocode.com/` → `301 https://roomote.dev/` | confirmed |
| K3 | **Continue приобретён Cursor**; сайт: «Continue was acquired by Cursor»; GitHub README: «no longer actively maintained and is read-only for all users»; финальный релиз 2.0.0 (2026-06-19) | https://www.continue.dev/ ; https://github.com/continuedev/continue ; https://api.github.com/repos/continuedev/continue/releases?per_page=10 | confirmed |
| K4 | Continue в финальном 2.0.0 **удалил телеметрию и аутентификацию** | https://github.com/continuedev/continue (README, «Final 2.0.0 Release») | confirmed |
| K5 | **Kilo Code куплен Anaconda** (публикация «Jul. 15, 2026»); продукт жив, MIT, релизы продолжаются | https://www.anaconda.com/blog/anaconda-acquires-kilo-code ; https://api.github.com/repos/Kilo-Org/kilocode/releases?per_page=3 | confirmed (дата/факт), условия сделки — unverified (не раскрыты) |
| K6 | Kilo Code переписан в апреле 2026 на общий core для VS Code/CLI/Cloud; orchestrator mode объявлен deprecated | https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new ; https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode | confirmed |
| K7 | Cline вынес harness в SDK и мигрировал на него расширение с «over 11 million developers»; миграция сопровождалась откатом | https://cline.bot/blog/how-we-migrated-11-million-users-to-clines-biggest-harness-upgrade | confirmed (текст), 11M — marketing |
| K8 | Cline **сознательно не индексирует код** («doesn't index or embed the contents of your repositories») | https://docs.cline.bot/enterprise-solutions/overview.md | confirmed |
| K9 | Continue **Hub больше не работает**: `hub.continue.dev` не резолвится, `/hub` в docs — 404 | `curl https://hub.continue.dev` → `Could not resolve host`; https://docs.continue.dev/hub → 404 | confirmed (отсутствие) |
| K10 | Roo Code оставил пользователям два пути: ZooCode (community fork) и Cline | https://roocodeinc.github.io/Roo-Code/ ; https://app.roocode.com/ | confirmed |

Практический вывод: из четырёх продуктов **два** (Roo Code, Continue) в ноябре 2026 — исторические артефакты, а не живые конкуренты. Их ценность для ZCode — в дизайне механик и в антипримерах жизненного цикла. Реальная конкуренция — Cline и Kilo Code.

## 3. Таблица источников

Все URL первичные. Дата доступа — 2026-11-11 (UTC).

| # | URL | Дата доступа | Статус | Подтверждаемое утверждение |
| --- | --- | --- | --- | --- |
| S1 | https://docs.cline.bot/llms.txt | 2026-11-11 | confirmed | Полная карта docs Cline: приложения (Desktop/CLI/IDE/SDK/Kanban), tools, rules, skills, plugins, MCP, hooks, subagents, agent teams, memory bank, checkpoints, auto-approve, enterprise |
| S2 | https://docs.cline.bot/cline-overview.md | 2026-11-11 | confirmed | «AI coding agent that lives in your editor and your terminal»; читает/пишет файлы, запускает команды, использует браузер; «Every action requires your explicit approval» |
| S3 | https://docs.cline.bot/core-workflows/plan-and-act.md | 2026-11-11 | confirmed | Plan mode не может менять файлы и выполнять команды; Act исполняет; история сохраняется при переключении; можно разные модели на Plan/Act |
| S4 | https://docs.cline.bot/tools-reference/all-cline-tools.md | 2026-11-11 | confirmed | Встроенные tools `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit`; `editor` XOR `apply_patch`; `toolRoutingRules` |
| S5 | https://docs.cline.bot/features/subagents.md | 2026-11-11 | confirmed | Subagents только CLI/Desktop (не VS Code/JetBrains); отдельный контекст; Act даёт edit/commands, Plan — read-only; вложенный spawn; **нет MCP tools**; approval `spawn_agent` авторизует всё дочернее; расход в счёт сессии |
| S6 | https://docs.cline.bot/cli/agent-teams.md | 2026-11-11 | confirmed | `/team`; coordinator + specialists; task board, mailbox, mission log в `~/.cline/data/db/teams.db`; только SDK/CLI/Kanban; недоступно с `--yolo` |
| S7 | https://docs.cline.bot/core-workflows/checkpoints.md | 2026-11-11 | confirmed | Shadow git repo отдельно от проекта; commit после каждого tool use; полное состояние файлов включая untracked; Restore Files / Restore Task Only / Restore Files & Task; Compare; включено по умолчанию; предупреждение о storage/perf |
| S8 | https://docs.cline.bot/features/auto-approve.md | 2026-11-11 | confirmed | Approval на каждый tool call; категории read/edit project/all, safe/all commands, browser, MCP, notifications; «Cline does not use a fixed allowlist», модель ставит `requires_approval`; YOLO «disables all safety checks» |
| S9 | https://docs.cline.bot/customization/cline-rules.md | 2026-11-11 | confirmed | `.clinerules/`, `.cline/rules/`, `.cursorrules`, `.windsurfrules`, `AGENTS.md`; conditional rules через YAML frontmatter `paths`; workspace > global; invalid YAML «fail open» |
| S10 | https://docs.cline.bot/customization/skills.md | 2026-11-11 | confirmed | Progressive loading: metadata ~100 tokens всегда, instructions <5k по триггеру, resources по требованию; `SKILL.md` + YAML frontmatter; slash-команда на скилл |
| S11 | https://docs.cline.bot/customization/plugins.md | 2026-11-11 | confirmed | Плагины только SDK/CLI/Kanban; custom tools, lifecycle hooks, slash commands, rules, providers, events; установка file URL/git/npm/local |
| S12 | https://docs.cline.bot/sdk/plugins.md | 2026-11-11 | confirmed | Хуки `beforeRun`, `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`, `onEvent`; hooks могут останавливать run, менять запрос, подменять tool call, требовать approval; timeout 3s; `hookErrorMode: ignore` по умолчанию |
| S13 | https://docs.cline.bot/sdk/guides/permission-handling.md | 2026-11-11 | confirmed | `toolPolicies` на tool: `autoApprove: true/false`, `enabled: false`; **если политика не задана — tool включён и авто-одобрен** |
| S14 | https://docs.cline.bot/sdk/architecture/hub-spoke.md | 2026-11-11 | confirmed | Hub (daemon) координирует сессии/события/approvals/schedules, не исполняет loop; Spoke исполняет; clients подключаются по WebSocket |
| S15 | https://docs.cline.bot/usage/cloud-agents.md | 2026-11-11 | confirmed | Cloud Agents в браузере на GitHub-репозитории; своя sandbox-копия на сессию; ветка `cline/`, никогда default; commit/push по ходу; PR по запросу; 3 провайдера (ClineFree, ClinePass, usage-billing); idle 15 мин — пауза |
| S16 | https://docs.cline.bot/usage/cline-desktop.md | 2026-11-11 | confirmed | Desktop — open source, open-weight models, параллельные сессии, scheduled tasks, импорт сессий Claude Code/Codex; macOS + Windows (beta) |
| S17 | https://docs.cline.bot/usage/kanban.md | 2026-11-11 | confirmed | Kanban research preview: worktree + terminal на карточку, task linking, inline review, auto-commit/auto-PR |
| S18 | https://docs.cline.bot/getting-started/clinepass.md | 2026-11-11 | confirmed | ClinePass — **$9.99/мес**, 2–5x лимиты на популярные open coding models; отдельный provider |
| S19 | https://docs.cline.bot/getting-started/cline-provider.md | 2026-11-11 | confirmed | Cline (usage-billing): кредиты, один аккаунт, «100+ models»; pay-as-you-go |
| S20 | https://docs.cline.bot/getting-started/authorizing-with-cline.md | 2026-11-11 | confirmed | Три пути: usage-billing, ClinePass, BYOK (cloud или local); Ollama/LM Studio без ключа |
| S21 | https://docs.cline.bot/running-models-locally/overview.md | 2026-11-11 | confirmed | Локальные runtime: Ollama, LM Studio, Atomic Chat; hardware-таблица RAM; «Use Compact Prompt» |
| S22 | https://docs.cline.bot/enterprise-solutions/overview.md | 2026-11-11 | confirmed | Enterprise: агент и tools работают где выбрано; inference — ваш provider; **«No codebase indexing»**; scoped telemetry |
| S23 | https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md | 2026-11-11 | confirmed | Телеметрия **включена по умолчанию** в IDE/Desktop/CLI; собирает features/tasks/errors/tokens/version/OS/editor; код и промпты не собирает, кроме запросов к Cline/ClinePass; общий выключатель на машину |
| S24 | https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry.md | 2026-11-11 | confirmed | Opt-in OTLP export metrics/logs в Datadog/New Relic/Grafana и др. |
| S25 | https://docs.cline.bot/core-workflows/using-commands.md | 2026-11-11 | confirmed | Slash-команды `/newtask`, `/smol` (`/compact`), `/newrule`, `/deep-planning`, `/reportbug` |
| S26 | https://docs.cline.bot/cli/scheduling.md | 2026-11-11 | confirmed | Cron-расписания через hub; переживают рестарт процесса; только SDK/CLI/Kanban |
| S27 | https://docs.cline.bot/cli/connectors.md | 2026-11-11 | confirmed | Connectors: Telegram, Slack, Discord, Google Chat, WhatsApp; только CLI |
| S28 | https://docs.cline.bot/cli/samples/model-orchestration.md | 2026-11-11 | confirmed | Мультимодельные workflow через `--config`/`--thinking` — **ручная** маршрутизация по фазам, не автоматический routing |
| S29 | https://docs.cline.bot/sdk/guides/going-to-production.md | 2026-11-11 | confirmed | Error handling, `mistake_limit`, loop detection, OpenTelemetry в SDK |
| S30 | https://docs.cline.bot/resources/deprecations.md | 2026-11-11 | confirmed | `.clineignore` deprecating soon; Explain Changes deprecated; Focus Chain deprecated без замены |
| S31 | https://docs.cline.bot/customization/clineignore.md | 2026-11-11 | confirmed | `.clineignore` «not a security or access-control boundary»; ignored files читаются через `@` и shell; предлагается PreToolUse hook |
| S32 | https://github.com/cline/cline | 2026-11-11 | confirmed | Description «Autonomous coding agent as an SDK, IDE extension, or CLI assistant»; Apache-2.0; 71.5k stars |
| S33 | https://api.github.com/repos/cline/cline/releases?per_page=10 | 2026-11-11 | confirmed | `v4.1.26` 2026-10-26; `cli-v3.0.74` 2026-10-26; `desktop-v0.0.49` 2026-10-26; `sdk/sdk/v0.2.0` 2026-10-26 |
| S34 | https://cline.bot/blog/how-we-migrated-11-million-users-to-clines-biggest-harness-upgrade | 2026-11-11 | confirmed | Rebuild harness вокруг SDK; первый релиз откатили; «over 11 million developers» (marketing); дата 2026-09-02 |
| S35 | https://cline.bot/blog/open-sourcing-evals-for-open-weight-agents | 2026-11-11 | confirmed | Evals на Harbor + Modal, Terminal Bench 89 задач; метрики cost/tokens/tool calls; разброс 43.8–56.2% на 5 прогонах; routing влияет (74.2% vs 61.8%); дата 2026-08-18 |
| S36 | https://github.com/cline/kanban | 2026-11-11 | confirmed | «npx kanban (Research Preview)»; worktree на карточку; auto-commit/auto-PR; permission bypass в preview |
| S37 | https://cline.bot/pricing | 2026-11-11 | marketing | Open Source free для индивидуальных разработчиков, платят только за inference; Enterprise custom; конкретных цифр нет |
| S38 | https://roocodeinc.github.io/Roo-Code/ | 2026-11-11 | confirmed | «The Roo Code Extension was shut down on May 15th»; альтернативы ZooCode и Cline |
| S39 | https://github.com/RooCodeInc/Roo-Code | 2026-11-11 | confirmed | «This repository was archived by the owner on May 15, 2026. It is now read-only.»; Apache-2.0; 24.2k stars |
| S40 | https://api.github.com/repos/RooCodeInc/Roo-Code | 2026-11-11 | confirmed | `archived: true`, `pushed_at` 2026-05-15T18:08:47Z, homepage `https://roocode.com` |
| S41 | https://roocodeinc.github.io/Roo-Code/update-notes/ | 2026-11-11 | confirmed | Последний релиз 3.50.0 (2026-02-19); далее записей нет |
| S42 | https://roocodeinc.github.io/Roo-Code/basic-usage/using-modes | 2026-11-11 | confirmed | Modes: Code (default), Ask (read+MCP), Architect (markdown-only), Debug, Orchestrator (без tools, делегирует через `new_task`); tool groups; per-mode model |
| S43 | https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions | 2026-11-11 | confirmed | Master Enabled + tiles; read/edit/commands/browser/MCP/mode switch/subtasks/follow-ups; command allow/deny prefix lists, longest-prefix precedence, deny побеждает; write delay; protected files |
| S44 | https://roocodeinc.github.io/Roo-Code/features/checkpoints | 2026-11-11 | confirmed | Shadow git; snapshot на старте задачи и перед изменениями, **не перед командами**; task-scoped; Restore Files Only / Files & Task; nested repos ломают checkpoints |
| S45 | https://roocodeinc.github.io/Roo-Code/features/intelligent-context-condensing | 2026-11-11 | confirmed | Condensing включён по умолчанию, threshold 100%; 70% history / 20% output / 10% buffer; при context-limit ошибке reduce 25% и retry; нельзя другую модель для condensing |
| S46 | https://roocodeinc.github.io/Roo-Code/features/codebase-indexing | 2026-11-11 | confirmed | Opt-in semantic index: Tree-sitter + embeddings (Gemini/OpenAI/Ollama/OpenAI-compatible/Mistral/Vercel/Bedrock/OpenRouter) + **Qdrant**; tool `codebase_search`; файл ≤1MB |
| S47 | https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo | 2026-11-11 | confirmed | STDIO / Streamable HTTP / legacy SSE; **нет предустановленных серверов**; per-tool auto-approve после global; timeout 60s default (1–3600) |
| S48 | https://roocodeinc.github.io/Roo-Code/features/skills | 2026-11-11 | confirmed | Agent Skills: `.roo/skills`, `~/.roo/skills`, `.agents/skills`; mode-specific `skills-{mode}`; project > global; skills не регистрируют tools |
| S49 | https://roocodeinc.github.io/Roo-Code/features/worktrees | 2026-11-11 | confirmed | Worktrees UI, переключение, `.worktreeinclude` (пересечение с `.gitignore`), параллельные задачи в разных окнах |
| S50 | https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks | 2026-11-11 | confirmed | Boomerang/Orchestrator: декомпозиция и `new_task` с mode+message; subtask завершается `attempt_completion` |
| S51 | https://roocodeinc.github.io/Roo-Code/features/slash-commands | 2026-11-11 | confirmed | `.roo/commands/*.md`, `~/.roo/commands`; project > global; built-in `/init` генерирует mode-specific AGENTS.md |
| S52 | https://roocodeinc.github.io/Roo-Code/providers/ | 2026-11-11 | confirmed | ~22 провайдера, включая Anthropic, Bedrock, DeepSeek, Gemini, LM Studio, LiteLLM, Ollama, OpenAI, OpenRouter, Requesty, SambaNova, Vercel AI Gateway, Vertex, VS Code LM API, xAI, Z AI, Qwen Code CLI |
| S53 | https://roocodeinc.github.io/Roo-Code/faq | 2026-11-11 | confirmed | «The Roo Code extension is free and open-source»; пользователь платит провайдеру inference; offline через local model |
| S54 | https://app.roocode.com/ | 2026-11-11 | confirmed | «Roo Code Cloud is shutting down… to focus on Roomote»; dashboard недоступен; возврат балансов |
| S55 | https://roomote.dev/ | 2026-11-11 | unverified | Позиционирование «your own cloud coding agent», self-host, source-available; связь с Roo Code через 301 с `roocode.com` и текст Roo Cloud, не через собственную страницу |
| S56 | https://kilo.ai/docs | 2026-11-11 | confirmed | «Kilo has been acquired by Anaconda» (footer); платформы VS Code / JetBrains / CLI; Gateway; Desktop Beta |
| S57 | https://www.anaconda.com/blog/anaconda-acquires-kilo-code | 2026-11-11 | confirmed | Дата «Jul. 15, 2026»; «Anaconda is acquiring Kilo Code»; Kilo — «agentic engineering layer»; продукт остаётся доступен; цена не раскрыта |
| S58 | https://www.anaconda.com/products/kilo-by-anaconda | 2026-11-11 | marketing | «500+ models across 60+ providers», «Six surfaces, shared context», MIT, «Kilo ranked #1 product of the month by Product Hunt in May 2026»; метрики на странице отображаются как плейсхолдеры «0 M+» |
| S59 | https://kilo.ai/docs/code-with-ai | 2026-11-11 | confirmed | «your AI pair programmer that works in your IDE, terminal, or browser»; платформы: VS Code, JetBrains, CLI, Cloud Agent, mobile, Slack; agents Code/Ask/Plan/Debug; autocomplete, code actions, todos, checkpoints, browser use, git commit gen |
| S60 | https://kilo.ai/docs/code-with-ai/agents/using-agents | 2026-11-11 | confirmed | Агенты — «specialized personas» с разными capability/access; переключение dropdown/slash |
| S61 | https://kilo.ai/docs/customize/custom-modes | 2026-11-11 | confirmed | Built-ins `code, plan, debug, ask, orchestrator, explore, general`; permission rules `allow/deny/ask`; ordered globs, last match wins; тело Markdown = system prompt |
| S62 | https://kilo.ai/docs/customize/agent-permissions | 2026-11-11 | confirmed | `allow/ask/deny`; порядок правил, last match wins; globs для путей относительно worktree; shell — parsed command patterns, любой denied отклоняет запрос; `task` rules ограничивают subagents |
| S63 | https://kilo.ai/docs/getting-started/settings/auto-approving-actions | 2026-11-11 | confirmed | Единая модель для VS Code/JetBrains/CLI; default `ask` при отсутствии правила; **большинство tools по умолчанию allow**; `.env`, `external_directory`, `doom_loop` спрашивают; MCP keys `{server}_{tool}` с globs |
| S64 | https://kilo.ai/docs/getting-started/settings/sandboxing | 2026-11-11 | confirmed | Sandbox off by default; macOS Seatbelt (`sandbox-exec`), Linux Bubblewrap, **Windows не поддерживается**; writes ограничены workspace/worktree/runtime; network блокируется кроме `allowed_hosts`; **reads не ограничены**; MCP lifecycle/plugin hooks/inference вне sandbox; git mutation — разовая escalation; при невозможности confinement tool отклоняется |
| S65 | https://kilo.ai/docs/code-with-ai/features/checkpoints | 2026-11-11 | confirmed | Snapshot repo вне проекта; снимки на старте/финише model call; хранение `~/.local/share/kilo/snapshot/`; GC 7 дней; revert на границе user message; Redo/Redo All; worktree isolation |
| S66 | https://kilo.ai/docs/customize/context/context-condensing | 2026-11-11 | confirmed | Порог `compaction.threshold_percent`; reserved buffer; **context pruning**: tool outputs вне 40K окна заменяются `"[Old tool result content cleared]"`; anchored summary; 2 recent user turns; 25% (2K–8K) verbatim tail; отдельная compaction model; custom models без context window не трекаются |
| S67 | https://kilo.ai/docs/customize/context/codebase-indexing | 2026-11-11 | confirmed | Opt-in; Tree-sitter; embeddings OpenAI/Ollama/OpenAI-compatible/Gemini/Mistral/Vercel/Bedrock/OpenRouter/Voyage; **LanceDB default**, Qdrant для команд; tool `semantic_search`; `searchMinScore` 0.4, `searchMaxResults` 50; файл ≤1MB; incremental hash cache; только snippets уходят в embedding |
| S68 | https://kilo.ai/docs/customize/agents-md | 2026-11-11 | confirmed | `AGENTS.md` (plural recommended) / `AGENT.md`; subdirectory по мере чтения; write-protected; precedence: agent prompt > project instructions > AGENTS.md > global instructions > skills; memory-bank deprecated |
| S69 | https://kilo.ai/docs/customize/skills | 2026-11-11 | confirmed | Agent Skills: `~/.kilo/skills`, `.kilo/skills`, `~/.agents/skills`, `.agents/skills`, `.claude/skills`; на старте только metadata, полный SKILL.md по требованию; project > global; `/reload` |
| S70 | https://kilo.ai/docs/automate/extending/plugins | 2026-11-11 | confirmed | TS/JS plugins: tools, hooks (`tool.execute.before/after`, `chat.params`, `chat.headers`, `permission.ask`, `shell.env`, `auth`, `provider`), TUI; marketplace; `kilo plugin`; Bun install, lifecycle scripts blocked; `KILO_PURE=1` |
| S71 | https://kilo.ai/docs/automate/mcp/overview | 2026-11-11 | confirmed | MCP как расширение внешними tools/resources; curated servers из Marketplace |
| S72 | https://kilo.ai/docs/automate/mcp/server-transports | 2026-11-11 | confirmed | STDIO и SSE как основные транспорты; JSON-RPC 2.0; STDIO — локально, один-к-одному, без network exposure |
| S73 | https://kilo.ai/docs/automate/agent-manager | 2026-11-11 | confirmed | Managed sessions в отдельных worktrees/branches; multi-version «up to 4 parallel implementations» с разными моделями; task subagents внутри сессии; `agent_manager` tool — до 20 задач на запрос; старый orchestrator deprecated |
| S74 | https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode | 2026-11-11 | confirmed | «Deprecated — scheduled for removal»; Code/Plan/Debug делегируют сами через `task` |
| S75 | https://kilo.ai/docs/code-with-ai/platforms/cloud-agent | 2026-11-11 | confirmed | Изолированный Linux container на пользователя; ephemeral; inactive sessions удаляются через 7 дней (beta); branch + optional commit/push; **Auto/YOLO mode всегда активен**; PR-создание не документировано; до 20 requests per trigger |
| S76 | https://kilo.ai/docs/code-with-ai/platforms/cli | 2026-11-11 | confirmed | `kilo`, `kilo run --auto`, `kilo serve`, `kilo attach`, `kilo acp`, `kilo mcp`, `kilo auth`, `kilo agent`, `kilo models`, `kilo session`, `kilo cloud`; exit codes 0/124/1; `/remote`, `/goal`, `/review`, `/diff` |
| S77 | https://kilo.ai/docs/code-with-ai/platforms/mobile | 2026-11-11 | confirmed | iOS/Android; подключается к Cloud Agents и remote sessions локального CLI/IDE |
| S78 | https://kilo.ai/docs/code-with-ai/gastown | 2026-11-11 | confirmed | Gas Town: town/bead/convoy/rig; mayor координирует, polecats пишут, refinery ревьюит и мержит/создаёт PR |
| S79 | https://kilo.ai/docs/automate/code-reviews/overview | 2026-11-11 | confirmed | AI review PR/MR на GitHub App и GitLab OAuth/PAT; `REVIEW.md` как repo-owned guidance; compute free в limited beta |
| S80 | https://kilo.ai/docs/code-with-ai/agents/auto-model | 2026-11-11 | confirmed | Тиры `kilo-auto/frontier`, `efficient`, `free`; efficient оценивает сложность и держит выбор до явного удешевления; custom pool 1–10 model+thinking вариантов с benchmark «Ready»; fallback на фиксированную baseline-модель |
| S81 | https://kilo.ai/docs/gateway | 2026-11-11 | confirmed | OpenAI-совместимый unified API; BYOK с шифрованием ключей at rest; usage tracking microdollar precision; org limits |
| S82 | https://kilo.ai/pricing | 2026-11-11 | confirmed | Individual free (usage отдельно, Auto Free/BYOK/local $0); Teams **$15/user/month**; Enterprise custom; Gateway $0/mo + exact provider rates, 500+ models / 60+ providers; Kilo Pass **$19/$49/$199**; credit fee 5%; Cloud compute: Code Review $0.33/hr, Cloud Agent Docker/Small $0.60/hr, Standard $1.20/hr |
| S83 | https://kilo.ai/docs/getting-started/using-kilo-for-free | 2026-11-11 | confirmed | Free-модели для agentic-задач; autocomplete/фоновые задачи тоже расходуют кредиты по умолчанию |
| S84 | https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new | 2026-11-11 | confirmed | Апрель 2026: rebuild на общем core; parallel tool calls, subagents, Agent Manager, inline review, multi-model comparison; modes → agents; indexing «temporarily unavailable» на момент релиза; custom profiles удалены |
| S85 | https://kilo.ai/docs/contributing/features/agent-observability | 2026-11-11 | confirmed | Статус «Partial»: API/session metrics ingestion, burn-rate alerts, Analytics Engine, per-message feedback; behavior/outcome метрики — roadmap |
| S86 | https://kilo.ai/docs/contributing/features/benchmarking | 2026-11-11 | confirmed | `kilo-bench` smoke test (hello-world + Terminal-Bench sample); Harbor adapters/Opik/CI regression — roadmap |
| S87 | https://github.com/Kilo-Org/kilocode | 2026-11-11 | confirmed | «all-in-one agentic engineering platform…»; MIT; 27.9k stars; `main` не принимает новые features, они идут в `v2` |
| S88 | https://api.github.com/repos/Kilo-Org/kilocode | 2026-11-11 | confirmed | `archived: false`, `pushed_at` 2026-11-11T02:12:26Z, license MIT |
| S89 | https://api.github.com/repos/Kilo-Org/kilocode/releases?per_page=3 | 2026-11-11 | confirmed | `v7.8.27` 2026-11-05; `v7.8.28` pre-release 2026-11-07 |
| S90 | https://registry.npmjs.org/@kilocode/cli | 2026-11-11 | confirmed | `latest` 7.8.27; modified 2026-11-09 |
| S91 | https://docs.continue.dev/ | 2026-11-11 | confirmed | «Open source AI code assistant for VS Code and JetBrains»; features Agent/Chat/Edit/Autocomplete; CLI `cn`; Customize: Models, MCP, Rules, Prompts |
| S92 | https://www.continue.dev/ | 2026-11-11 | confirmed | «Continue has joined Cursor»; «Continue was acquired by Cursor»; open-source codebase остаётся доступной; FAQ-заголовки без ответов |
| S93 | https://github.com/continuedev/continue | 2026-11-11 | confirmed | «no longer actively maintained and is read-only for all users»; Final 2.0.0: удалены телеметрия и аутентификация; рекомендует CLI вместо JetBrains plugin |
| S94 | https://api.github.com/repos/continuedev/continue | 2026-11-11 | confirmed | Apache-2.0, 36.4k stars, `archived: false`, `pushed_at` 2026-11-05T15:28:28Z |
| S95 | https://api.github.com/repos/continuedev/continue/releases?per_page=10 | 2026-11-11 | confirmed | `v2.1.0-vscode` и `v2.0.0-vscode` — 2026-06-19; `v1.0.67-jetbrains` — 2026-03-27; новых после июня нет |
| S96 | https://docs.continue.dev/ide-extensions/agent/quick-start | 2026-11-11 | confirmed | Chat — без tools, Plan — read-only, Agent — все tools; модель выбирает tool, пользователь одобряет; tool output возвращается как context item |
| S97 | https://docs.continue.dev/ide-extensions/agent/how-it-works | 2026-11-11 | confirmed | Tool handshake; built-ins `read_file`, `read_currently_open_file`, `ls`, `view_repo_map`, `glob_search`, `grep_search`, `fetch_url_content`, `search_web`, `view_diff`, `codebase_tool`, `edit_existing_file`, `create_new_file`, `create_rule_block`, `run_terminal_command` |
| S98 | https://docs.continue.dev/cli/quickstart | 2026-11-11 | confirmed | `cn` TUI; `cn -p` headless; флаги `--auto`, `--readonly`, `--allow`, `--exclude`, `--config`, `--resume`, `--rule`, `--mcp`, `--model`, `--agent` |
| S99 | https://docs.continue.dev/customize/models | 2026-11-11 | confirmed | Model roles: Chat, Edit, Apply, Autocomplete, Embedding, Reranker |
| S100 | https://docs.continue.dev/customize/model-providers/overview | 2026-11-11 | confirmed | Провайдеры Anthropic/OpenAI/Azure/Bedrock/Ollama/Gemini/DeepSeek/Mistral/xAI/Vertex и др.; `config.yaml` c `name/provider/model/apiKey/roles`; BYOK через `${{ secrets.X }}`; self-host |
| S101 | https://docs.continue.dev/customize/rules | 2026-11-11 | confirmed | Rules в `.continue/rules`; применяются в Agent/Chat/Edit; версионируются с кодом |
| S102 | https://docs.continue.dev/reference | 2026-11-11 | confirmed | Agents = models + rules + tools (MCP servers); `mcpServers` ключи `name/command/args/env/cwd/requestOptions/connectionTimeout`; capability `tool_use` обязательна для Agent mode |
| S103 | https://docs.continue.dev/reference/deprecated-codebase | 2026-11-11 | confirmed | `@Codebase` deprecated; исторически embeddings локально через transformers.js в `~/.continue/index`; transformers.js не работает в JetBrains |
| S104 | https://docs.continue.dev/guides/custom-code-rag | 2026-11-11 | confirmed | Custom Code RAG: рекомендует `voyage-code-3`, LanceDB, reranking; advanced setup |
| S105 | https://docs.continue.dev/guides/plan-mode-guide | 2026-11-11 | confirmed | Plan mode — read-only exploration, «understand before you change» |
| S106 | https://docs.continue.dev/faqs | 2026-11-11 | confirmed | FAQ покрывает networking, configs, Ollama, secrets, reset; **не** покрывает Cursor/подписки/лицензию |
| S107 | https://hub.continue.dev (curl) | 2026-11-11 | confirmed (отсутствие) | `Could not resolve host` — Hub недоступен |
| S108 | https://continue.dev/pricing, https://www.continue.dev/pricing, https://docs.continue.dev/pricing | 2026-11-11 | confirmed (отсутствие) | Все три URL → HTTP 404; актуальный прайс Continue не публикуется |
| S109 | https://cursor.com/blog | 2026-11-11 | confirmed (отсутствие) | Поста о приобретении Continue в индексе блога Cursor нет |
| S110 | https://blog.continue.dev/ | 2026-11-11 | confirmed (отсутствие) | В индексе блога нет поста о Cursor/приобретении; только 7 контентных статей |

## 4. Матрица возможностей

Обозначения: **✅** документировано и работает; **⚠️** частично/с ограничениями; **❌** не документировано/отсутствует; **—** неприменимо (продукт закрыт).

| Возможность | Cline | Roo Code | Kilo Code | Continue |
| --- | --- | --- | --- | --- |
| Статус на 2026-11-11 | Активен, релизы weekly | **Extension shut down 15.05.2026**, repo archived | Активен, куплен Anaconda 15.07.2026 | **Acquired by Cursor, read-only, final 2.0.0** |
| Лицензия | Apache-2.0 | Apache-2.0 (архив) | MIT | Apache-2.0 |
| Позиционирование | «AI-powered agent for complex work», approval-first | «whole dev team of AI agents in your code editor» | «all-in-one agentic engineering platform» | «open source AI code assistant for VS Code and JetBrains» |
| VS Code | ✅ | ✅ (закрыт) | ✅ | ✅ (2.0.0) |
| JetBrains | ✅ | ❌ | ✅ (v7 native) | ⚠️ (README рекомендует CLI) |
| CLI | ✅ `npm i -g cline` + TUI | ❌ | ✅ `kilo` + TUI | ✅ `cn` |
| Desktop app | ✅ (macOS, Windows beta) | ❌ | ✅ Kilo Desktop (beta) | ❌ |
| Cloud / browser agents | ✅ Cloud Agents (GitHub) | — (Cloud выключен) | ✅ Cloud Agent (GitLab/Bitbucket, browser/mobile) | ❌ (Hub недоступен) |
| Mobile | ❌ (браузер на телефоне) | ❌ | ✅ iOS/Android | ❌ |
| IDE-agnostic протокол | ✅ ACP (Zed/Neovim/Emacs) | ❌ | ✅ `kilo acp` | ❌ |
| Embeddable SDK | ✅ `@cline/sdk` + hub-spoke | ❌ | ⚠️ plugins/TUI API, отдельного agent SDK нет | ❌ |
| Plan / read-only режим | ✅ Plan & Act | ✅ Architect (md-only), Ask | ✅ Plan agent | ✅ Plan mode |
| Subagents | ✅ `spawn_agent` (CLI/Desktop) | ✅ Boomerang subtasks | ✅ `task` subagents | ❌ |
| Параллельные агенты / команды | ✅ Agent Teams + Kanban | ⚠️ Orchestrator + worktrees | ✅ Agent Manager, multi-version ×4, Gas Town | ❌ |
| Worktree-изоляция | ✅ Kanban (карточка = worktree) | ✅ UI worktrees + `.worktreeinclude` | ✅ managed sessions + multi-version | ❌ |
| File tools | ✅ read/edit/apply_patch | ✅ read/write/apply_diff | ✅ read/edit/write | ✅ read/edit/create |
| Search | ✅ `search_codebase` (lexical) | ✅ + `codebase_search` (semantic) | ✅ grep/glob + `semantic_search` | ✅ glob/grep + `codebase_tool` |
| Terminal | ✅ `run_commands` | ✅ + shell integration | ✅ `bash` (parsed patterns) | ✅ `run_terminal_command` |
| Browser automation | ✅ (встроенный browser) | ✅ headless browser | ✅ Playwright + integrated browser | ❌ (нет в tools) |
| MCP | ✅ STDIO/HTTP/SSE | ✅ STDIO/HTTP/SSE | ✅ STDIO/SSE + Marketplace | ✅ `mcpServers` в YAML |
| Плагины / hooks | ✅ (SDK/CLI/Kanban) | ⚠️ только MCP + custom modes | ✅ TS/JS plugins + hooks + TUI | ❌ |
| Skills (SKILL.md) | ✅ progressive loading | ✅ `.roo/skills`, mode-specific | ✅ `.kilo/skills`, `.agents/skills` | ❌ |
| Slash-команды | ✅ `/newtask`, `/smol`, `/deep-planning` | ✅ `.roo/commands`, `/init` | ✅ `/review`, `/diff`, `/goal`, `/remote` | ✅ prompts |
| Custom modes/agents | ⚠️ Plan/Act + profiles в SDK | ✅ 5 built-in + custom modes | ✅ 7 built-in + custom agents | ⚠️ Chat/Plan/Agent |
| Rules / AGENTS.md | ✅ + `.clinerules`, conditional `paths` | ✅ `.roo/rules`, mode-specific | ✅ AGENTS.md + `instructions` | ✅ `.continue/rules` |
| Семантическая индексация | ❌ **сознательно нет** | ✅ opt-in + Qdrant | ✅ opt-in + LanceDB/Qdrant | ⚠️ только custom RAG |
| Auto-compaction | ✅ Auto Compact | ✅ condensing + error recovery | ✅ + pruning старых tool outputs | ❌ |
| Долговременная память | ✅ Memory Bank (markdown) | ⚠️ rules/instructions | ⚠️ AGENTS.md (memory-bank deprecated) | ❌ |
| Checkpoints / rewind | ✅ shadow git, 3 режима restore | ✅ shadow git, 2 режима | ✅ snapshot + Redo/Redo All | ❌ |
| Git commit/PR автоматизация | ✅ Kanban auto-commit/auto-PR, Cloud PR | ❌ | ⚠️ commit/push; PR не документирован (кроме Gas Town refinery) | ❌ |
| Гранулярность auto-approve | ⚠️ категории + model `requires_approval` | ✅ tiles + command prefix allow/deny | ✅ allow/ask/deny + globs + MCP keys | ⚠️ `--auto` / `--allow` / `--exclude` |
| OS-level sandbox | ❌ не документирован | ❌ | ✅ Seatbelt/Bubblewrap; Windows ❌ | ❌ |
| Секреты | ⚠️ env vars в MCP-конфиге | ⚠️ provider keys в настройках | ⚠️ `kilo.jsonc` (документировано как secret) | ✅ `${{ secrets.X }}` |
| Провайдеры / BYOK | ✅ 30+ + Cline + ClinePass + local | ✅ ~22 + local | ✅ 40+ + Gateway + local | ✅ 28+ + local |
| Локальные модели | ✅ Ollama/LM Studio/Atomic Chat | ✅ Ollama/LM Studio | ✅ Ollama/LM Studio | ✅ Ollama/LM Studio/llama.cpp/llamafile |
| Автоматический routing/fallback | ❌ (ручной `--config`) | ❌ | ✅ Auto Model tiers + baseline fallback | ❌ |
| Enterprise governance | ✅ SSO/SLA/RBAC/audit/VPC (custom) | — | ✅ SSO/OIDC/SCIM/audit/SLA/model allowlists | ❌ |
| Телеметрия | ⚠️ on by default + opt-out + OTLP | ⚠️ (архив) | ⚠️ observability «Partial» | ✅ удалена в 2.0.0 |
| Evals / benchmarks | ✅ открытые eval traces, Harbor/Terminal Bench | ❌ | ⚠️ kilo-bench smoke, roadmap | ❌ |
| Монетизация | Free + $9.99 ClinePass + usage credits + Enterprise | Free extension, платит пользователь провайдеру | Free/$15 seat/$19–199 Pass/Gateway at cost/cloud per-hour | Нет прайса (404) |

## 5. Cline

### 5.1 Позиционирование и статус
«Your AI-powered agent for complex work»: «read and write files, run terminal commands, use a browser… Every action requires your explicit approval» (S2). Description репозитория: «Autonomous coding agent as an SDK, IDE extension, or CLI assistant» (S32). Apache-2.0, 71.5k stars. Релизы: extension `v4.1.26`, CLI `v3.0.74`, Desktop `v0.0.49`, SDK `v0.2.0` — все 2026-10-26 (S33). Продукт живой и быстро движется.

### 5.2 Поверхности
Один harness, шесть приложений: Desktop (open source, open-weight models, параллельные сессии, scheduled tasks, импорт Claude Code/Codex, macOS + Windows beta), CLI (`npm i -g cline`, TUI + headless), VS Code extension, JetBrains plugin, SDK (`npm install @cline/sdk`), Kanban (`npx kanban`, research preview) (S1, S2, S16, S17). Дополнительно ACP-режим для Zed/JetBrains/Neovim/Emacs и Cloud Agents в браузере (S1, S15).

### 5.3 Agent loop, автономия, планирование, subagents
- Plan/Act: Plan «cannot modify any files or execute commands»; Act исполняет; история переносится; можно разные модели на режимы (S3).
- Встроенные tools: `read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit`. Сессия даёт `editor` **или** `apply_patch`, не оба; по умолчанию `apply_patch` для GPT/Codex и OpenAI-native, `editor` для остальных; Plan не даёт ни одного (S4).
- Subagents: `spawn_agent`, отдельный контекст, параллельно, отчёт родителю. Только CLI/Desktop. Дочерние не получают MCP tools; approval `spawn_agent` авторизует все последующие действия ребёнка; вложенный spawn разрешён; расход в счёт сессии (S5).
- Agent Teams: `/team`, coordinator + specialists, task board + mailbox + mission log в SQLite (`~/.cline/data/db/teams.db`); только SDK/CLI/Kanban; недоступно с `--yolo` (S6).
- Автономность по умолчанию ограничена approval на каждый tool call; `--auto-approve`/YOLO снимает ограничения (S8, S13).

### 5.4 Контекст, память, правила, индексация, compaction
- Auto Compact: при приближении к лимиту создаёт сводку, заменяет историю, продолжает; стоимость ~обычного tool call; при отсутствии — rule-based truncation (S1, S2).
- Memory Bank: методология из markdown-файлов (`projectbrief.md`, `activeContext.md`, `progress.md` и др.), не встроенный сервис, а правила + команды «initialize/update memory bank» (S1).
- Rules: `.clinerules/`, `.cline/rules/`, плюс `.cursorrules`, `.windsurfrules`, `AGENTS.md`; conditional rules через YAML frontmatter `paths` (globs); workspace > global; invalid YAML «fail open» — сырой текст попадает в контекст (S9).
- Skills: `SKILL.md`, metadata ~100 tokens всегда, инструкции <5k по триггеру, ресурсы по требованию; slash-команда для явного вызова (S10).
- Индексации **нет by design**: «Cline reads files when a task needs them and doesn't index or embed the contents of your repositories» (S22). Это осознанная security-позиция, а не пробел.

### 5.5 Расширяемость
MCP: STDIO, `streamableHttp`, legacy `sse` (default при отсутствии `type`), CLI-мастер `cline mcp`, OAuth для remote (S1). Плагины: только SDK/CLI/Kanban; custom tools, hooks (`beforeRun`…`onEvent`), slash commands, rules, providers, events; hooks могут останавливать run, менять запрос, подменять tool call, требовать approval; timeout 3s, `hookErrorMode: ignore` по умолчанию; установка file URL/git/npm/local (S11, S12). Hooks в extension — `.clinerules/hooks/`, в CLI — `.cline/hooks/` (S31). Slash-команды `/newtask`, `/smol`, `/newrule`, `/deep-planning`, `/reportbug` (S25). Scheduling по cron через hub (S26). Connectors в Telegram/Slack/Discord/Google Chat/WhatsApp (S27).

### 5.6 Модели, провайдеры, BYOK, local, routing
Три пути доступа: Cline (usage-billing) с кредитами и «100+ models», ClinePass ($9.99/мес, 2–5x лимиты на open coding models), BYOK (30+ провайдеров, включая OpenRouter, Bedrock, Anthropic, Gemini, DeepSeek, Qwen, Z AI, OpenAI-compatible) (S18, S19, S20). Локально: Ollama, LM Studio, Atomic Chat, с рекомендациями по RAM (S21). **Автоматического routing/fallback нет**: «Model Orchestration» — это ручные `--config`/`--thinking` по фазам (S28). Cloud Agents поддерживают только три Cline-провайдера (S15).

### 5.7 Permissions, sandbox, security, secrets
- Approval по каждому tool call; категории: read project/all, edit project/all, safe/all commands, browser, MCP, notifications (S8).
- «Cline does not use a fixed allowlist»: модель помечает команду `requires_approval`; builds/tests/read-only обычно safe, установки пакетов/recursive delete/moves/in-place edits — approval (S8).
- YOLO: «approves everything… disables all safety checks» (S8).
- `.clineignore` **deprecated** и прямо описан как «not a security or access-control boundary»; ignored files доступны через `@` и shell; предлагается PreToolUse hook (S30, S31).
- OS-level sandbox для локального bash в docs не описан — это пробел относительно Kilo (S64).
- Секреты MCP: рекомендация хранить в env variables, ограничивать `autoApprove` (S1).
- Enterprise: агент и tools работают где выбрано, inference — ваш провайдер, без индексации кода, scoped telemetry (S22).

### 5.8 Git/PR/worktree/diff/checkpoints
Checkpoints: отдельный shadow git repo, commit после каждого tool use, полное состояние включая untracked, переживают сессии; Restore Files / Restore Task Only / Restore Files & Task; Compare (S7). Kanban: worktree + terminal на карточку, dependency chains, inline review, auto-commit/auto-PR (S17, S36). Cloud Agents: ветка `cline/`, никогда default, commit/push по ходу, PR по запросу (S15).

### 5.9 Remote/cloud/background
Cloud Agents в браузере на GitHub-репозитории, своя sandbox-копия на сессию, пауза при idle 15 мин, доступ с телефона через браузер (S15). Desktop SSH: агент и код на удалённой машине, приложение локально (S1). Scheduled agents через hub переживают рестарт (S26).

### 5.10 Телеметрия и evals
Телеметрия включена по умолчанию во всех поверхностях; собирает features/tasks/errors/tokens/version/OS/editor; код и промпты — нет, кроме запросов к Cline/ClinePass; один выключатель на машину (S23). Opt-in OTLP export в Datadog/New Relic/Grafana (S24). Evals: открытые traces на Harbor + Modal, Terminal Bench 89 задач, разброс 43.8–56.2% на 5 прогонах, routing влияет на score (74.2% vs 61.8%) — редкая для рынка прозрачность (S35).

### 5.11 Pricing
Open Source free для индивидуальных разработчиков, платят только за inference; ClinePass $9.99/мес; Enterprise custom (SSO, SLA, RBAC, audit, VPC) (S18, S37).

### 5.12 Изменения 2025–2026
Вынос harness в SDK и миграция расширения на него; первый релиз откатили, затем «biggest refactor since inception» (S34, дата 2026-09-02). Появление Desktop, Cloud Agents, Kanban, Agent Teams, SDK v0.2.0 (S15–S17, S6, S33). Открытие eval-ledger (S35). Deprecations: `.clineignore`, Explain Changes, Focus Chain (S30).

### 5.13 Сильные стороны
1. Один harness на шесть поверхностей — редкая широта при едином поведении (S2, S14).
2. SDK + hub-spoke: встраиваемость и «сессии переживают закрытие окна» (S14).
3. Approval-first по умолчанию и честная документация рисков YOLO (S8).
4. Checkpoints с тремя режимами восстановления и сохранением разговора (S7).
5. Прозрачные evals с воспроизводимыми traces (S35).
6. Осознанный отказ от индексации как security-позиция (S22).

### 5.14 Слабые стороны
1. Subagents, Agent Teams, plugins, scheduling, connectors **недоступны в VS Code/JetBrains** — расширение отстаёт от CLI (S5, S6, S11, S26, S27).
2. Нет автоматического model routing/fallback (S28).
3. `.clineignore` уходит, не оставляя встроенной замены — только hook (S30, S31).
4. Нет OS-level sandbox для локальных команд (S64 — контраст).
5. Дефолт `toolPolicies` «нет политики = auto-approve» в SDK опасен для встраивания (S13).
6. Телеметрия on by default (S23).

### 5.15 Do-not-copy
- **Не копировать модель «safe command» через флаг модели** (`requires_approval` ставит LLM): нет детерминированного allowlist, классификация зависит от модели и промпта (S8). Причина: непроверяемая граница безопасности; ZCode уже имеет `ShellPermissionRule` allow/deny и parsed patterns.
- **Не копировать удаление `.clineignore` без замены**: deprecation оставляет пользователей без фильтра, а hook требует ручной настройки (S30, S31).
- **Не копировать дефолт «нет политики → auto-approve»** в SDK (S13): небезопасный default для встраиваемых агентов.
- **Не копировать фрагментацию возможностей по поверхностям** (subagents только CLI/Desktop): пользователь IDE получает худший продукт (S5).

## 6. Roo Code

### 6.1 Позиционирование и статус
«Roo Code gives you a whole dev team of AI agents in your code editor» (S39). «Open-source AI coding agent for VS Code», model-agnostic, работает локально (S38, S52). **Extension shut down 15 May 2026**; репозиторий archived и read-only; последний релиз 3.50.0 (2026-02-19); docs заморожены на 2026-05-15 (S38–S41). Cloud выключается, `roocode.com` → `roomote.dev` (S54, S55). Официальные альтернативы: ZooCode (community fork) и Cline (S38).

### 6.2 Поверхности
Только VS Code (Marketplace + Open VSX) (S38). CLI, JetBrains, desktop, cloud — нет.

### 6.3 Agent loop, автономия, планирование, subagents
- Modes: Code (default, полный доступ), Ask (read + MCP), Architect (read + MCP + только markdown-правки), Debug (полный доступ + структурированный troubleshooting), Orchestrator (без прямых tools, делегирует через `new_task`) (S42).
- Orchestrator/Boomerang: декомпозиция, `new_task(mode, message)`, subtask завершается `attempt_completion(result)`; контекст передаётся явно (S50).
- Auto-approve: master switch + tiles; read/edit/commands/browser/MCP/mode switch/subtasks/follow-ups; command allow/deny — prefix lists с longest-prefix precedence, deny побеждает; write delay для diagnostics; protected files (S43).

### 6.4 Инструменты
File read/write, `apply_diff`, terminal (VS Code shell integration), browser, MCP. Codebase indexing добавляет `codebase_search` (S46). Skills не регистрируют tools — только инструкции (S48).

### 6.5 Контекст, память, правила, индексация, compaction
- Condensing: включён по умолчанию, threshold 100%; 70% истории / 20% output / 10% buffer; при context-limit ошибке reduce 25% и retry; **только активная модель** — провайдеро-специфичные tool-форматы не переводятся (S45).
- Codebase indexing: opt-in, Tree-sitter + embeddings (8 провайдеров) + **обязательный Qdrant**; файл ≤1MB; лучше работает на Tree-sitter-языках (S46).
- Rules: `.roo/rules/` и mode-specific `.roo/rules-{mode}`; `/init` генерирует mode-specific AGENTS.md (S51).
- Skills: `.roo/skills`, `~/.roo/skills`, `.agents/skills`, `skills-{mode}`; project > global, mode > generic (S48).

### 6.6 Расширяемость
MCP: STDIO / Streamable HTTP / legacy SSE; **нет предустановленных серверов**; per-tool auto-approve после global; timeout 60s default (S47). Custom modes с tool groups и `fileRegex` (S42). Slash-команды `.roo/commands/*.md` (S51). Worktrees с `.worktreeinclude` (S49).

### 6.7 Модели
~22 провайдера, включая Anthropic, Bedrock, DeepSeek, Gemini, LM Studio, LiteLLM, Ollama, OpenAI, OpenAI Compatible, OpenRouter, Requesty, SambaNova, Vercel AI Gateway, Vertex, VS Code LM API, xAI, Z AI, Qwen Code CLI (S52). Каждый mode помнит свою последнюю модель (S42). Routing/fallback не документированы.

### 6.8 Permissions, sandbox, security
Auto-approve детальный, но без OS sandbox. Командные allow/deny — prefix-based, с явным предупреждением о data loss (S43). Защита — workspace boundaries, protected files, MCP двухшаговое подтверждение, диагностическая задержка после write.

### 6.9 Git/PR/worktree/checkpoints
Checkpoints: shadow git, snapshot на старте задачи и перед изменениями, **не перед командами**; task-scoped; Restore Files Only / Files & Task; nested repos ломают инициализацию (S44). Worktrees: UI-создание, переключение, `.worktreeinclude` (пересечение с `.gitignore`) (S49).

### 6.10 Remote/cloud
Cloud выключен; возврат балансов; фокус на Roomote (S54). Remote/background в docs не документированы.

### 6.11 Телеметрия/evals
Публичной документации по телеметрии и evals на archived docs не найдено; страницы `/features/telemetry` → 404. **UNKNOWN**.

### 6.12 Pricing
Extension free и open-source; пользователь платит провайдеру inference (S53). Монетизации как таковой не осталось — что и объясняет shutdown (гипотеза, не подтверждённая официальным текстом: причина закрытия не названа, S38).

### 6.13 Изменения 2025–2026
Релизы 3.40–3.50 (январь–февраль 2026), затем остановка 15 мая 2026 (S41). Skills, worktrees, mode-specific rules появились до закрытия (S48, S49, S51).

### 6.14 Сильные стороны
1. Самая развитая таксономия режимов: Architect с markdown-only правками, Ask, Debug, Orchestrator (S42).
2. Гранулярный auto-approve с prefix allow/deny и protected files (S43).
3. Mode-specific rules и skills — редкая детализация (S48, S51).
4. Worktrees как first-class UI с `.worktreeinclude` (S49).
5. Boomerang-декомпозиция с явным контрактом `new_task`/`attempt_completion` (S50).

### 6.15 Слабые стороны
1. Продукт закрыт; нет обновлений безопасности и совместимости с моделями (S38–S41).
2. Один редактор — нет CLI/cloud/JetBrains (S38).
3. Checkpoints не создаются перед командами — shell-изменения вне снапшота (S44).
4. Индексация требует внешнего Qdrant (S46).
5. Condensing жёстко привязан к активной модели (S45).

### 6.16 Do-not-copy
- **Не копировать single-surface + «free extension» без монетизации**: продукт закрылся, оставив пользователей без пути миграции кроме fork/Cline (S38, S53). Причина: нет устойчивого дохода при растущей стоимости поддержки моделей.
- **Не копировать checkpoints, не покрывающие команды** (S44): shell может изменить файлы вне снапшота.
- **Не копировать обязательный внешний vector DB** для базовой функции поиска (S46): повышает порог входа.
- **Не копировать Orchestrator с нулевыми tools** как единственный способ делегирования (S42, S50): координатор не может проверить результат сам.

## 7. Kilo Code

### 7.1 Позиционирование и статус
«Your AI pair programmer that works in your IDE, terminal, or browser» (S59); «all-in-one agentic engineering platform» (S87). MIT, 27.9k stars, `pushed_at` 2026-11-11, релиз `v7.8.27` (2026-11-05) (S87–S89). Куплен Anaconda 15 июля 2026; остаётся доступным individual/teams/orgs (S57). Позиционируется как «agentic engineering layer» платформы Anaconda.

### 7.2 Поверхности
VS Code, JetBrains (v7 native), CLI (`kilo`, `run`, `serve`, `attach`, `acp`, `mcp`, `cloud`), Cloud Agent, mobile iOS/Android, Slack, GitHub, Linear, Kilo Connect, Kilo Desktop (beta: notebooks, in-app browser, terminal, git, local inference, conda) (S59, S76, S77, S84). «Six surfaces, shared context» (S58, marketing).

### 7.3 Agent loop, автономия, планирование, subagents
- Агенты: `code, plan, debug, ask, orchestrator, explore, general`; кастомные агенты с permission rules; тело Markdown = system prompt (S61).
- Orchestrator **deprecated**; Code/Plan/Debug делегируют сами через `task` (S74). Agent Manager: managed sessions в отдельных worktrees/branches; **multi-version — до 4 параллельных реализаций** одного промпта, можно с разными моделями; `agent_manager` tool — до 20 задач на запрос (S73).
- Subagent delegation ограничивается `task`-правилами: можно запретить всех, затем разрешить именованных (S62).
- Gas Town: town/bead/convoy/rig; mayor координирует, polecats пишут, refinery ревьюит и мержит/создаёт PR (S78).
- Автономность: per-tool allow/ask/deny, по умолчанию `ask` при отсутствии правила, но большинство tools по умолчанию `allow` (S63). Cloud Agent всегда в Auto/YOLO (S75).

### 7.4 Инструменты
`read`, `edit`, `bash`, `glob`, `grep`, `task`, `webfetch`, `websearch`, `todowrite`, `todoread`, `skill`, `lsp`, `agent_manager`, `external_directory`, `doom_loop` (S62, S63). Browser: Playwright + отдельный experimental integrated browser (S59). `semantic_search` при включённой индексации (S67).

### 7.5 Контекст, память, правила, индексация, compaction
- Compaction: порог `threshold_percent` + reserved buffer; **context pruning** — завершённые tool outputs вне 40K-окна заменяются `"[Old tool result content cleared]"`; anchored summary (goal/constraints/progress/next steps/files); 2 recent user turns; 25% (2K–8K) verbatim tail; **отдельная compaction model**; custom models без context window не трекаются (S66).
- Codebase indexing: opt-in; Tree-sitter; 9 embedding-провайдеров; **LanceDB default** (без сервера) или Qdrant для команд; `searchMinScore` 0.4, `searchMaxResults` 50; incremental hash cache; только snippets уходят в embedding (S67).
- AGENTS.md: root `AGENTS.md` (plural recommended) / `AGENT.md`; subdirectory-файлы по мере чтения; write-protected; precedence agent prompt > project instructions > AGENTS.md > global instructions > skills; memory-bank deprecated (S68).
- Skills: `~/.kilo/skills`, `.kilo/skills`, `.agents/skills`, `.claude/skills`; metadata на старте, полный текст по требованию; project > global; `/reload` (S69).

### 7.6 Расширяемость
MCP: STDIO/SSE (+ streamable HTTP в docs), curated servers из Marketplace, per-tool `{server}_{tool}` с globs (S63, S71, S72). Плагины: TS/JS, hooks (`tool.execute.before/after`, `chat.params`, `chat.headers`, `permission.ask`, `shell.env`, `auth`, `provider`), custom tools с Zod, TUI plugins; marketplace; `kilo plugin`; Bun install с блокировкой lifecycle scripts; `KILO_PURE=1` отключает внешние плагины (S70). Slash-команды `/review`, `/diff`, `/goal`, `/remote` (S76).

### 7.7 Модели, routing, fallback
Kilo Gateway — OpenAI-совместимый unified API, «500+ models across 60+ providers», BYOK с шифрованием ключей at rest, usage tracking microdollar precision (S81). Auto Model: тиры `frontier` / `efficient` / `free`; efficient оценивает сложность и держит модель до явного удешевления; custom pool 1–10 model+thinking вариантов, допускаются только benchmark-«Ready»; fallback на фиксированную baseline-модель (S80). Локально: Ollama/LM Studio (S59). 40+ провайдеров в docs (S56).

### 7.8 Permissions, sandbox, security, secrets
- Единая модель для VS Code/JetBrains/CLI; `allow/ask/deny`; ordered globs, last match wins; пути относительно worktree; shell — parsed command patterns, любой denied отклоняет весь запрос; `task` rules ограничивают subagents (S62, S63).
- **Sandbox**: off by default; macOS Seatbelt (`sandbox-exec`), Linux Bubblewrap; **Windows не поддерживается**; writes только в workspace/worktree/runtime/extra paths; network блокируется кроме `allowed_hosts` (DNS host:port, без wildcards/IP); **reads не ограничены**; MCP lifecycle, plugin hooks, provider inference вне sandbox; git mutations — разовая escalation; при невозможности confinement tool отклоняется, а не падает в unrestricted (S64).
- Честная формулировка: «Permissions decide whether a tool invocation may proceed; the sandbox constrains what an allowed invocation can write or reach… permission rules alone are not a complete confidentiality boundary» (S64).
- Секреты: `kilo.jsonc` документирован как secret в shared environments; Gateway keys encrypted at rest (S67, S81).

### 7.9 Git/PR/worktree/diff/checkpoints
Checkpoints: snapshot repo вне проекта, снимки на старте/финише model call, хранение `~/.local/share/kilo/snapshot/`, GC 7 дней, revert на границе user message, **Redo/Redo All**, worktree isolation (S65). Agent Manager: worktrees/branches, multi-version (S73). Cloud Agent: branch + optional commit/push; **PR-создание не документировано** (S75), но Gas Town refinery создаёт PR по merge policy (S78). Code Reviews: AI review PR/MR на GitHub/GitLab с `REVIEW.md` (S79).

### 7.10 Remote/cloud/background
Cloud Agent: изолированный Linux container на пользователя, ephemeral, inactive sessions удаляются через 7 дней (beta), «Auto/YOLO mode is always active», до 20 requests per trigger; доступ из browser/mobile/CLI `kilo cloud` (S75, S76, S77). `/remote` поднимает локальную CLI-сессию в cloud UI (S76).

### 7.11 Телеметрия/evals
Observability: «Partial» — API/session metrics ingestion, burn-rate alerts, Analytics Engine, per-message feedback; behavior/outcome метрики в roadmap (S85). Benchmarking: `kilo-bench` smoke test, Harbor adapters/Opik/CI regression — roadmap (S86). Это слабее открытого eval-ledger Cline (S35).

### 7.12 Pricing
Individual free, usage отдельно; Teams **$15/user/month**; Enterprise custom (SSO/OIDC/SCIM, audit, SLA, private-gateway BYOK, 14-day trial); Gateway $0/mo + exact provider rates без наценки; Kilo Pass **$19 / $49 / $199** в месяц (до 50% bonus credits, annual $588); комиссия 5% при покупке кредитов; cloud compute: Code Review $0.33/hr, Cloud Agent Docker/Small $0.60/hr, Standard $1.20/hr (S82).

### 7.13 Изменения 2025–2026
Апрель 2026: rebuild на общем core для VS Code/CLI/Cloud; parallel tool calls, subagents, Agent Manager, inline line-level review, multi-model comparison, 500+ models; modes → agents; orchestrator deprecated; indexing временно недоступна на момент релиза (S84). Июль 2026: покупка Anaconda (S57). Ноябрь 2026: релизы 7.8.x (S89).

### 7.14 Сильные стороны
1. Единственная из четырёх с **OS-level sandbox** и честным описанием его границ (S64).
2. Единая permission-модель на IDE/CLI/cloud, включая shell parsing и MCP keys (S62, S63).
3. Auto Model с benchmark-гейтом и fallback — единственный документированный автоматический routing (S80).
4. Multi-version параллельные реализации в worktrees (до 4) (S73).
5. Compaction с pruning старых tool outputs и отдельной compaction model (S66).
6. Широта поверхностей + enterprise governance + прозрачный прайс (S59, S82).

### 7.15 Слабые стороны
1. Windows sandbox не поддерживается — «нельзя включить и нельзя обойти» (S64).
2. Reads не ограничены sandbox: файлы могут попасть в контекст (S64).
3. Cloud Agent всегда Auto/YOLO — риск для недоверенных репозиториев (S75).
4. PR-создание в Cloud Agent не документировано (S75).
5. Orchestrator deprecated, а Gas Town вводит новый словарь (town/bead/convoy) — цена обучения (S74, S78).
6. Observability и benchmarking — «Partial»/roadmap (S85, S86).
7. `main` не принимает новые features — развитие идёт в `v2`, риск для форков (S87).

### 7.16 Do-not-copy
- **Не копировать Cloud Agent с принудительным YOLO** (S75): автономия без подтверждений на чужом коде — недопустимый default.
- **Не копировать sandbox с неограниченными reads** (S64): утечка конфиденциальных файлов в контекст остаётся.
- **Не копировать «большинство tools по умолчанию allow»** (S63): расходится с approval-first Cline и с ZCode `guarded`.
- **Не копировать параллельную терминологию** (orchestrator/modes/agents/Gas Town) без миграции — пользователь теряет модель (S74, S84).
- **Не копировать обязательный benchmark-«Ready» для custom pool** (S80): блокирует эксперименты, если нет инфраструктуры бенчмарков.

## 8. Continue

### 8.1 Позиционирование и статус
«Open source AI code assistant for VS Code and JetBrains»; «create, share, and use custom AI code agents» (S91). Миссия: «developers amplified, not automated» (S92). **Приобретён Cursor**; README: «no longer actively maintained and is read-only for all users»; финальный 2.0.0 (2026-06-19) удалил телеметрию и аутентификацию (S92, S93, S95). Apache-2.0, 36.4k stars (S94).

### 8.2 Поверхности
VS Code extension, JetBrains plugin (README рекомендует CLI вместо плагина), CLI `cn` (S91, S93, S98). Hub/cloud недоступны: `hub.continue.dev` не резолвится, `/hub` → 404 (S107).

### 8.3 Agent loop, автономия, планирование
Три режима: Chat (без tools), Plan (read-only), Agent (все tools). Модель выбирает tool, пользователь одобряет, результат возвращается как context item (S96). Plan mode — «understand before you change» (S105). Subagents/параллельных агентов нет.

### 8.4 Инструменты
`read_file`, `read_currently_open_file`, `ls`, `view_repo_map`, `view_subdirectory`, `glob_search`, `grep_search`, `fetch_url_content`, `search_web`, `view_diff`, `codebase_tool`, `edit_existing_file`, `create_new_file`, `create_rule_block`, `run_terminal_command` (S97). Browser automation в списке нет.

### 8.5 Контекст, память, правила, индексация, compaction
- `@Codebase` deprecated; агент исследует код через tools (S103).
- Custom Code RAG как отдельный advanced guide: `voyage-code-3`, LanceDB, reranking (S104).
- Rules в `.continue/rules`, применяются в Agent/Chat/Edit (S101).
- Prompts и model roles: Chat, Edit, Apply, Autocomplete, Embedding, Reranker (S99).
- Автоматической compaction не документировано.

### 8.6 Расширяемость
MCP: `mcpServers` в `config.yaml` с `name/command/args/env/cwd/requestOptions/connectionTimeout` (S102). Custom prompts/slash-команды (S91). Плагинов/skills/hooks нет.

### 8.7 Модели, провайдеры, BYOK, local
Anthropic, OpenAI, Azure, Bedrock, Ollama, Gemini, DeepSeek, Mistral, xAI, Vertex, Inception, HuggingFace, Groq, Together, DeepInfra, OpenRouter, Cohere, NVIDIA, Cloudflare, MiniMax, LM Studio, llama.cpp, LlamaStack, llamafile, SambaNova, Watson x, SageMaker, Nebius; BYOK через `apiKey` или `${{ secrets.X }}`; self-host (S100). Routing/fallback не документированы; роли распределяют модели по задачам вручную.

### 8.8 Permissions, sandbox, security
Одобрение tool call по умолчанию; `--auto` снимает все подтверждения, `--readonly` — Plan, `--allow`/`--exclude` — точечно (S98). Sandbox не документирован. Секреты — через secret references (S100).

### 8.9 Git/PR/worktree/checkpoints
Не документировано. Checkpoints/rewind отсутствуют.

### 8.10 Remote/cloud/background
Hub и cloud недоступны (S107). Headless `cn -p` для CI/CD и git hooks (S98).

### 8.11 Телеметрия/evals
Телеметрия **удалена** в финальном 2.0.0 (S93). Evals не документированы.

### 8.12 Pricing
Публичного прайса нет: `continue.dev/pricing`, `www.continue.dev/pricing`, `docs.continue.dev/pricing` → 404 (S108). FAQ на сайте содержит заголовок «What about my subscription?» без ответа (S92). **UNKNOWN**.

### 8.13 Изменения 2025–2026
Финальный 2.0.0 (июнь 2026): удалены телеметрия и аутентификация, исправлены баги, CLI рекомендуется вместо JetBrains (S93, S95). Приобретение Cursor — дата не указана ни на сайте, ни в блогах (S92, S109, S110).

### 8.14 Сильные стороны
1. Минимальный и понятный agent loop: Chat/Plan/Agent с явным tool handshake (S96).
2. Разделение model roles (chat/edit/apply/autocomplete/embed/rerank) — чистая абстракция (S99).
3. Config-as-code YAML с secret references (S100).
4. Сильная история local/self-host и offline (S100).
5. В финальном релизе удалены телеметрия и auth — privacy-first завершение (S93).

### 8.15 Слабые стороны
1. Продукт не поддерживается; новых релизов после июня 2026 нет (S93, S95).
2. Hub/cloud исчезли, docs всё ещё описывают функции, которых больше нет (S107).
3. Нет subagents, checkpoints, sandbox, browser, автоматической compaction.
4. Прайс и судьба подписок неизвестны (S108).
5. JetBrains-плагин фактически заморожен (S93).

### 8.16 Do-not-copy
- **Не копировать завершение продукта без публичной миграции**: сайт говорит «open-source codebase remains available», но нет migration guide, а FAQ без ответов (S92, S106). Причина: пользователь остаётся без пути.
- **Не копировать docs, описывающие удалённые сервисы** (Hub/cloud) (S107): подрывает доверие к документации.
- **Не копировать `--auto` как единственную форму автономии** без sandbox и гранулярных правил (S98): нет защитного слоя.
- **Не копировать отсутствие compaction/checkpoints** в агенте, который правит файлы (S96, S97): долгие сессии деградируют, откат невозможен.

## 9. Кандидатные рекомендации для ZCode

Каждая рекомендация: (а) доказательство у конкурента, (б) текущее состояние ZCode с указанием источника, (в) что нужно доказать внутри ZCode. Формулировки «needs ZCode evidence» означают: утверждение о ZCode не проверено в этой задаче и требует отдельного исследования/теста.

### R1. Сделать rewind/checkpoints первоклассной поверхностью, а не только контрактом
- Конкурент: Cline — три режима restore + Compare, сохранение разговора (S7); Kilo — revert на границе сообщения + Redo/Redo All + GC (S65); Roo — Restore Files Only / Files & Task (S44).
- ZCode: контракты `RewindScope` (conversation/workspace/both), `RewindStrategy` (active_chain/file_only/fork_required/unavailable), `RewindTargetStatus` (covered_by_compact), checkpoint payload с `snapshotRef`/`diffRef`/`compactBoundaryId` — `apps/zcode-cli/packages/contracts/src/rewind/index.ts:1-120`; workspace artifact с `beforeContent`/`afterContent`/`structuredPatch` — тот же файл; тесты — `apps/zcode-cli/packages/contracts/tests/rewind.test.ts:1-120`.
- Needs ZCode evidence: есть ли UI-паритет «Restore files only / Restore conversation only / Both» и Redo после revert; покрывает ли checkpoint shell-команды (у Roo — нет, S44); как ведёт себя rewind после compaction (контракт знает `covered_by_compact`, но UX не проверен).

### R2. Единая permission-модель на всех поверхностях (desktop/CLI/mobile/remote)
- Конкурент: Kilo прямо заявляет одну модель для VS Code/JetBrains/CLI и один `kilo.jsonc` (S63); Cline, наоборот, фрагментирован — subagents/teams/plugins только CLI (S5, S6, S11).
- ZCode: `permissionSchema` с режимами `plan/build/edit/yolo/guarded/auto`, `allowedTools`, `disallowedTools`, `autoApproveHighRisk`, `allowMediumRiskInAuto` — `apps/zcode-cli/packages/adapters/src/config/schema.ts:15-21`; `ShellPermissionPolicy` с `rules`, `allowReadonly`, `sandboxEnabled`, `dangerousDisableSandboxAllowed` — `apps/zcode-cli/packages/contracts/src/tools/bash.ts:329-340`.
- Needs ZCode evidence: совпадают ли эффективные правила в Desktop, CLI и mobile remote; нет ли поверхности, где allowlist игнорируется; как отображается «почему спросили/почему разрешили».

### R3. Решить судьбу OS-level sandbox явно: либо вернуть, либо задокументировать отсутствие
- Конкурент: Kilo — Seatbelt/Bubblewrap, writes/network confinement, честные ограничения, Windows unsupported, отказ вместо fallback (S64).
- ZCode: контракт содержит `sandboxEnabled`, `dangerouslyDisableSandbox`, `SANDBOX_VIOLATION` (`apps/zcode-cli/packages/contracts/src/tools/bash.ts:64-69, 179-181, 314, 338-339`), но adapter-комментарий фиксирует «sandbox 撤除后» — `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts:399-400`.
- Needs ZCode evidence: sandbox реально исполняется или контракт остался без реализации; если снят — какая граница заменяет его (guarded-политика? allowlist?); нужен тест, доказывающий, что write вне workspace блокируется.

### R4. Автоматический model routing с benchmark-гейтом и явным fallback
- Конкурент: Kilo Auto Model (frontier/efficient/free), custom pool 1–10 вариантов, baseline fallback (S80); Cline routing отсутствует — только ручной `--config` (S28).
- ZCode: `provider-registry`, `model-config-rules`, `model-token-limits`, `model-reasoning` — `apps/dev-docs/src/data/productCapabilityMap.ts:433-552`; selection через `parseModelPickerValue`/`modelSelection` в `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch.ts:109-228`.
- Needs ZCode evidence: существует ли routing по сложности/цене; есть ли fallback при недоступности провайдера; есть ли замеры качества, оправдывающие выбор дешёвой модели (у Kilo — benchmark «Ready», S80).

### R5. Разделить «эфемерного subagent» и «управляемую команду/доску задач»
- Конкурент: Cline — subagents (эфемерные, без MCP) и Agent Teams с task board/mailbox/mission log (S5, S6); Kilo — Agent Manager + multi-version ×4 (S73); Roo — Boomerang с `new_task`/`attempt_completion` (S50).
- ZCode: `subagent-profiles`, `child-runtime`, `interaction-broker`, `background-tasks` — `apps/dev-docs/src/data/productCapabilityMap.ts:649-768`; child runtime с `subagents: { enabled: false }` для workflow-детей — `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts:109-228`.
- Needs ZCode evidence: есть ли durable team state (board/mailbox) или только parent→child; как переживает рестарт; как считается стоимость на команду.

### R6. Бюджет контекста для skills: metadata всегда, тело по требованию
- Конкурент: Cline — ~100 tokens metadata, <5k инструкции, resources по требованию (S10); Kilo — metadata на старте, полный `SKILL.md` по требованию (S69); Roo — skills не регистрируют tools (S48).
- ZCode: bundled skill pack с фиксированным списком обязательных файлов — `apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts:1-259`; discovery/приоритеты и тесты — `apps/zcode-cli/packages/bootstrap/tests/dynamic-workflow-skill.test.ts:541-625`.
- Needs ZCode evidence: сколько токенов занимает каталог скиллов в system prompt; загружается ли тело только по триггеру; есть ли конфликт имён project vs bundled (у Kilo project > global, S69).

### R7. Compaction: pruning старых tool outputs + отдельная модель + защита от «rapid refill»
- Конкурент: Kilo — 40K-окно, замена старых результатов строкой `"[Old tool result content cleared]"`, anchored summary, отдельная compaction model (S66); Roo — reduce 25% и retry при context-limit (S45); Cline — Auto Compact как обычный tool call (S1).
- ZCode: `compact-runtime` — manual/auto/reactive/microcompact, summary, timeline, rapid-refill breaker — `apps/dev-docs/src/data/productCapabilityMap.ts:433-552`; compact boundary payload и `truePostCompactTokenCount` — `apps/zcode-cli/packages/contracts/src/rewind/index.ts:1-120`; mapping compaction-метаданных — `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts:109-228`.
- Needs ZCode evidence: заменяются ли старые tool outputs, а не только суммаризуются; можно ли выбрать отдельную модель; что происходит при повторном быстром заполнении (breaker есть в описании, нужен тест).

### R8. Worktree-изолированные параллельные сессии
- Конкурент: Kilo multi-version до 4 реализаций в разных worktrees (S73); Cline Kanban — worktree на карточку (S17, S36); Roo worktrees с `.worktreeinclude` (S49).
- ZCode: поиск по `src/**/*.ts` не нашёл worktree-логики (только `git-snapshot.ts` с branch/status/main branch — `apps/zcode-cli/packages/adapters/src/context/git-snapshot.ts:1-120`); capability map упоминает `Repo Snapshot` и `conversation-branch-rewind`, но не worktree.
- Needs ZCode evidence: есть ли вообще worktree-режим; если нет — это крупный пробел для параллельных агентов; проверить, не реализован ли он в desktop-слое вне `apps/zcode-cli/packages`.

### R9. Семантический поиск как opt-in, с локальным default и честной ценой
- Конкурент: Kilo — LanceDB default + Ollama-эмбеддинги как zero-cost вариант, snippets-only в embedding (S67); Roo — обязательный Qdrant, 1MB cap (S46); Cline — сознательно без индексации (S22); Continue — только custom RAG (S104).
- ZCode: `Grep` по `src/**/*.ts` не нашёл `semantic_search`/`codebase_index`; capability map относит «Repo Wiki, Repo Snapshot и索引服务» к `workbench-services` — `apps/dev-docs/src/data/productCapabilityMap.ts:217`.
- Needs ZCode evidence: существует ли индекс в host-слое (не в CLI); если нет — решить между «нет by design» (Cline) и opt-in (Kilo), с явным ответом на риск утечки кода в embedding-провайдера.

### R10. Телеметрия: явный default, граница данных и OTLP-экспорт
- Конкурент: Cline — on by default, но с точным перечнем полей и одним выключателем (S23), OTLP export (S24); Kilo — observability «Partial», roadmap (S85); Continue — телеметрия удалена (S93).
- ZCode: `apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts`, `apps/zcode-cli/packages/contracts/src/telemetry/agent-execution.ts`, usage SQLite с 30-дневным retention — `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts:1-120`.
- Needs ZCode evidence: включена ли телеметрия по умолчанию; какие поля уходят; есть ли opt-out на уровне workspace/org; поддержан ли OTLP.

### R11. Упаковка «flat subscription на open-weight модели»
- Конкурент: ClinePass $9.99/мес с 2–5x лимитами (S18); Kilo Pass $19/$49/$199 с bonus credits (S82).
- ZCode: Start/Coding/Team Plan, plan-quota-monitor, subscription-billing — `apps/dev-docs/src/data/productCapabilityMap.ts:541-660`.
- Needs ZCode evidence: как считается квота (токены/запросы/время), что происходит при исчерпании, есть ли аналог «open-weight-only» тарифа.

### R12. Антипримеры, которые нельзя переносить
- Single-surface без монетизации → shutdown (Roo, S38, S53).
- Завершение продукта без migration guide и с неотвеченным FAQ (Continue, S92, S106).
- «Safe command» определяется моделью, а не allowlist (Cline, S8).
- Cloud-агент с принудительным YOLO (Kilo, S75).
- Sandbox с неограниченными reads (Kilo, S64).
- Docs, описывающие удалённые сервисы (Continue Hub, S107).
- Дефолт «нет политики = auto-approve» (Cline SDK, S13).

## 10. Заблокированные и недоступные источники

| URL | Ошибка | Дата | Что делали |
| --- | --- | --- | --- |
| https://docs.cline.bot/features/security | HTTP 404 | 2026-11-11 | Заменено на `enterprise-solutions/overview.md` и `customization/clineignore.md` |
| https://docs.cline.bot/features/browser-use | HTTP 404 | 2026-11-11 | Использован `cline-overview.md` (браузер упомянут) |
| https://docs.cline.bot/provider-config/overview | HTTP 404 | 2026-11-11 | Использован `llms.txt` + отдельные provider-страницы |
| https://docs.cline.bot/enterprise/overview | HTTP 404 | 2026-11-11 | Использован `enterprise-solutions/overview.md` |
| https://docs.cline.bot/features/telemetry | HTTP 404 | 2026-11-11 | Использован `enterprise-solutions/monitoring/telemetry.md` |
| https://docs.cline.bot/llms.txt (WebFetch) | Извлечение вернуло пустой текст | 2026-11-11 | Получено через `curl`; индекс прочитан |
| https://docs.continue.dev/hub | HTTP 404 | 2026-11-11 | Подтверждено отсутствие Hub; `hub.continue.dev` — DNS not resolved (`curl` exit 6) |
| https://continue.dev/pricing, https://www.continue.dev/pricing, https://docs.continue.dev/pricing | HTTP 404 (все три) | 2026-11-11 | Прайс Continue записан как UNKNOWN |
| https://cursor.com/blog | Пост о Continue отсутствует в индексе | 2026-11-11 | Дата приобретения осталась неизвестной |
| https://blog.continue.dev/ | Пост о Continue/Cursor отсутствует в индексе | 2026-11-11 | То же |
| https://kilo.ai/docs/changelog | HTTP 404 | 2026-11-11 | Использованы `whats-new` + GitHub Releases API |
| https://kilo.ai/docs/cloud-agent, https://kilo.ai/docs/cloud-agents | HTTP 404 | 2026-11-11 | Использован `code-with-ai/platforms/cloud-agent` |
| https://kilo.ai/docs/customize/context-indexing | HTTP 404 | 2026-11-11 | Использован `customize/context/codebase-indexing` |
| https://kilo.ai/docs/customize/mcp-servers | HTTP 404 | 2026-11-11 | Использованы `automate/mcp/overview` и `server-transports` |
| https://kilo.ai/docs/desktop | HTTP 308 → `kilo.ai/docs/desktop/overview` | 2026-11-11 | Прочитано после редиректа |
| https://roocodeinc.github.io/Roo-Code/features/roomote | HTTP 404 | 2026-11-11 | Связь Roo→Roomote подтверждена через 301 и текст Roo Cloud |
| https://roomote.dev/about, https://roomote.dev/pricing, https://roomote.dev/docs | HTTP 404; главная иногда timeout | 2026-11-11 | Roomote оставлен как `unverified`; не использован для утверждений о функциях |
| https://roocodeinc.github.io/Roo-Code/privacy-policy | HTTP 404 | 2026-11-11 | Телеметрия Roo — UNKNOWN |
| https://roocodeinc.github.io/Roo-Code/features/telemetry | HTTP 404 | 2026-11-11 | То же |

Отдельно: `docs.roocode.com` отдаёт 301 на `roocodeinc.github.io/Roo-Code/`; `kilocode.ai/docs` — 308 на `kilo.ai/docs`. Это не блокировки, а смена канонических доменов; в отчёте используются конечные URL.

## 11. Ограничения покрытия и что осталось неизвестным

1. **Continue pricing** — UNKNOWN: три прайс-URL дают 404, FAQ не отвечает. Нельзя утверждать ни «free», ни «enterprise only».
2. **Дата приобретения Continue** — UNKNOWN: ни сайт, ни блог, ни блог Cursor не содержат даты.
3. **Roo Code телеметрия/evals** — UNKNOWN: docs archived без этих страниц.
4. **Kilo Cloud PR-создание** — UNKNOWN: страница Cloud Agent описывает branch/commit/push, но не PR; PR упомянут только для Gas Town refinery.
5. **Cline OS sandbox** — отсутствие в docs не доказывает отсутствие в коде; это «не документировано», а не «нет».
6. **ZCode sandbox** — контракт есть, adapter-комментарий говорит о снятии; фактическое поведение в этой задаче не проверялось (needs ZCode evidence).
7. **ZCode worktree / semantic index** — не найдены в `apps/zcode-cli/packages/src`, но host/desktop-слой не проверялся; отсутствие в partial-индексе не доказывает отсутствие кода.
8. **Kilo «500+ models / 60+ providers»** — marketing-цифра вендора (S58, S82), не проверялась по каталогу.
9. **Cline «11 million developers»** — marketing (S34), не проверялось.
10. **Метрики Anaconda-страницы** отображаются как «0 M+», «0 T+», «0 K» — использовать их нельзя (S58).

## 12. Итог

- **Cline** — самый широкий живой конкурент: один harness на Desktop/CLI/IDE/SDK/Kanban/Cloud, approval-first, checkpoints, subagents/teams, открытые evals. Слабости: возможности фрагментированы по поверхностям, нет auto-routing, `.clineignore` уходит без замены, нет OS sandbox.
- **Kilo Code** — самый «инженерно-зрелый» по безопасности и routing: единая permission-модель, OS sandbox с честными границами, Auto Model с benchmark-гейтом, multi-version worktrees, прозрачный прайс. Слабости: Windows sandbox, неограниченные reads, Cloud Agent всегда YOLO, orchestrator deprecated.
- **Roo Code** — закрыт 15.05.2026; ценность только как источник дизайна modes/auto-approve/worktrees и как антипример жизненного цикла.
- **Continue** — приобретён Cursor, read-only, финальный 2.0.0 без телеметрии и auth; ценность как минималистичный референс agent loop и model roles, а также как антипример завершения без миграции.
- Для ZCode наибольший разрыв с живыми конкурентами — **OS-level sandbox** (Kilo), **автоматический routing/fallback** (Kilo), **worktree-параллелизм** (Kilo/Cline), **durable team state** (Cline). Наибольший риск при копировании — принудительный YOLO в cloud и «модель решает, что безопасно».
