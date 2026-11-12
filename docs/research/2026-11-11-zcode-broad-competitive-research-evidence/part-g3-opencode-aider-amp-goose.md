# Part G3 — Конкуренты: OpenCode, Aider, Amp, Goose

Дата доступа ко всем источникам: **2026-11-11T06:08:05Z — 2026-11-11T06:31:21Z** (UTC, получено командой `date -u +%Y-%m-%dT%H:%M:%SZ`).
Заявленная дата отчёта: 2026-11-11.

## 0. Baseline репозитория (зафиксирован до сбора данных)

| Параметр | Значение |
| --- | --- |
| Branch | `dev` |
| HEAD | `d10f0b69f98677091e0428a92839e4a1e01e04ca` (`Выпустить macOS Preview 3.17.102.`) |
| Предыдущие коммиты | `bbb756e8` (`Не красить весь индекс частичным из-за фиктивных паролей в тестах.`), `fc70a81b` (`Выпустить macOS Preview 3.17.101.`) |
| `git status --porcelain` до записи | пусто; после создания каталога — `?? docs/research/` |
| Изменения production-кода | отсутствуют |

Ограничения задачи соблюдены: research-only, без правок production-кода/конфигов/зависимостей, без коммитов и установок. Единственная запись — этот файл.

## 1. Проверка канонической идентичности (identity checks)

Задача требовала явно отделить одноимённые проекты. Результаты проверки:

| Проверка | Установленный факт | Источник | Статус |
| --- | --- | --- | --- |
| OpenCode — канонический проект | `anomalyco/opencode`, MIT, description «The open source coding agent.», homepage `opencode.ai`; 225 953 stars, `pushed_at` 2026-11-11T06:10:28Z | https://api.github.com/repos/anomalyco/opencode | confirmed |
| OpenCode — издатель | Сайт: «Built in the open by Anomaly and 1,090 contributors», «MIT licensed»; org `anomalyco` («Anomaly», blog `anoma.ly`, created 2020-06-07) | https://opencode.ai/ ; https://api.github.com/orgs/anomalyco | confirmed |
| Одноимённый проект | `opencode-ai/opencode` — **archived**, `pushed_at` 2025-09-18, 13 885 stars, «Built for the terminal» | https://api.github.com/repos/opencode-ai/opencode | confirmed |
| SST-атрибуция OpenCode | На текущем сайте и в README SST **не упоминается**; имя пакета установки историческое | https://opencode.ai/ ; https://raw.githubusercontent.com/anomalyco/opencode/dev/README.md | confirmed (отсутствие) |
| Crush — не OpenCode | `charmbracelet/crush`, отдельный проект Charmbracelet, 29 037 stars, активен | https://api.github.com/repos/charmbracelet/crush | confirmed |
| Amp = Sourcegraph Amp | «We're spinning out of Sourcegraph to become an independent research lab», «Amp is becoming a separate company», «Amp is profitable» — пост 2025-12-02 | https://ampcode.com/news/amp-frontier-corporation | confirmed |
| Amp — исходный анонс | Thorsten Ball, 2025-05-15: «As of today, Amp, the frontier agent, is available to everyone»; Sourcegraph в тексте не назван | https://ampcode.com/notes/how-i-use-amp | confirmed (текст), Sourcegraph-связь — по spin-out посту |
| Goose = Block Goose | README/homepage: Apache-2.0, Rust, «part of the Agentic AI Foundation at the Linux Foundation»; репозиторий теперь `aaif-goose/goose`, homepage `goose-docs.ai` | https://goose-docs.ai/ ; https://api.github.com/repos/aaif-goose/goose | confirmed |
| Передача Goose в фонд | LF: AAIF основан «09 December 2025» «with founding contributions from Anthropic, Block, and OpenAI»; goose от Block — «open source, local-first AI agent framework» | https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation | confirmed |
| Aider — канонический проект | `Aider-AI/aider`, Apache-2.0, «aider is AI pair programming in your terminal», автор пакета PyPI `paul-gauthier` | https://api.github.com/repos/Aider-AI/aider ; https://pypi.org/pypi/aider-chat/json | confirmed |

Ключевой вывод по идентичности: **OpenCode следует читать как проект Anomaly (`anomalyco/opencode`), а не как архивный `opencode-ai/opencode` и не как Crush**. **Amp — это Sourcegraph Amp, с 2025-12-02 отдельная компания Amp Frontier Corporation.** **Goose — Block Goose, с декабря 2025 под Linux Foundation (AAIF).** Aider остаётся независимым Apache-2.0 проектом.

## 2. Таблица источников

Все URL первичные: официальные сайты/доки, официальные GitHub API/релизы, официальные блоги. Дата доступа — 2026-11-11 (UTC).

| URL | Дата доступа | Статус | Подтверждаемое утверждение |
| --- | --- | --- | --- |
| https://opencode.ai/ | 2026-11-11 | marketing | «The open source coding agent for any model»; desktop+terminal+mobile+SDK; «200+ LLM providers»; «Built in the open by Anomaly and 1,090 contributors»; 226K stars, 22M monthly developers; free models без аккаунта; OpenCode Go от $10/мес |
| https://opencode.ai/docs/ | 2026-11-11 | confirmed | Поверхности: terminal, desktop app, web app; `opencode pair`, ссылки одноразовые и живут 5 минут; Docker-теги версий |
| https://opencode.ai/download | 2026-11-11 | marketing | Desktop: «Sessions, tabs, diffs, built-in browser, and extensions»; macOS Apple Silicon/Intel, Windows x64/ARM64, Linux deb/rpm/AppImage |
| https://raw.githubusercontent.com/anomalyco/opencode/dev/README.md | 2026-11-11 | confirmed | Desktop помечен «BETA»; агенты `build`/`plan`; `plan` — read-only, запрещает правки; subagent `general` через `@general` |
| https://opencode.ai/docs/agents/ | 2026-11-11 | confirmed | Агенты = system prompt + model + permissions; режимы `primary`/`subagent`/`all`; subagents «run with fresh context in foreground or background child sessions»; встроенные `build`, `plan`, `general`, `explore`; `hidden` «controls visibility, not security» |
| https://opencode.ai/docs/permissions/ | 2026-11-11 | confirmed | Упорядоченные правила `action/resource/effect`; «The last matching rule wins»; по умолчанию `ask`; `shell` — scanner-produced command string; «`shell` runs with the host user's filesystem, process, and network authority» — sandbox не описан |
| https://opencode.ai/docs/policies/ | 2026-11-11 | confirmed | Policies «binary, never prompt», «only ever tighten»; hard-deny после agent rules и saved approvals |
| https://opencode.ai/docs/tools/ | 2026-11-11 | confirmed | Встроенные: `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `experimental_image_generate`, `question`, `skill`, `subagent`, `execute`; Code Mode (`execute`) — JS-оркестрация инструментов |
| https://opencode.ai/docs/mcp-servers/ | 2026-11-11 | confirmed | Local stdio и remote Streamable HTTP; OAuth по умолчанию (PKCE+refresh); таймауты 30s/12h; предупреждение «MCP tools consume model context» |
| https://opencode.ai/docs/plugins/ | 2026-11-11 | confirmed | Плагины добавляют «tools, hooks, integrations, commands, agents»; npm/Git/local; hot reload; TUI и GUI части |
| https://opencode.ai/docs/build/plugins/server/ | 2026-11-11 | confirmed | Хуки: session prompt/context/compaction/generate/title, model resolution/request, HTTP/WS, retry, permission evaluation, shell `create.before`, tool `execute.before/after`; `ctx.skill.*` |
| https://opencode.ai/docs/skills/ | 2026-11-11 | confirmed | `SKILL.md`; discovery: `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`, `.opencode/skills`, `.claude/skills`, `.agents/skills`; модель видит только id/name/description; permission action `skill` |
| https://opencode.ai/docs/commands/ | 2026-11-11 | confirmed | Markdown/JSON команды; `$ARGUMENTS`, `$1..$n`; shell-инъекция ``!`cmd` `` идёт «outside the agent's tool permission flow»; `subagent: true` |
| https://opencode.ai/docs/providers/ | 2026-11-11 | confirmed | Каталог из models.dev; локальные Ollama/LM Studio/vLLM; ретрай таймаута до 3 раз; общего routing/fallback не описано |
| https://opencode.ai/docs/models/ | 2026-11-11 | confirmed | Модели из models.dev + интеграции + config; варианты `provider/model#variant`; free-модели `opencode`/`opencode-go` |
| https://opencode.ai/docs/rules/ | 2026-11-11 | confirmed | `AGENTS.md`, `/init`; глобальный `~/.config/opencode/AGENTS.md`; fallback на `CLAUDE.md`; приоритет AGENTS.md |
| https://opencode.ai/docs/instructions/ | 2026-11-11 | confirmed | V2 распознаёт только `AGENTS.md`, без fallback на CLAUDE.md; вложенные файлы грузятся при исследовании; configured instructions после AGENTS.md; URL-fetch 5s |
| https://opencode.ai/docs/references/ | 2026-11-11 | confirmed | Named-доступ к внешним каталогам/репозиториям; remote checkout кэшируется, refresh не чаще 24h; references не дают доп. прав |
| https://opencode.ai/docs/compaction/ | 2026-11-11 | confirmed | Auto-compaction по умолчанию; `buffer` 15%, `keep.tokens` 15 000; summary: objective/decisions/completed/blockers/next steps/files; «Compaction is lossy» |
| https://opencode.ai/docs/snapshots/ | 2026-11-11 | confirmed | Снапшоты до/после шага; отдельная internal Git ODB; `/undo`, `/redo`, Revert; «convenience, not a transaction or backup»; лимит 2 MiB на untracked файл |
| https://opencode.ai/docs/warming/ | 2026-11-11 | confirmed | Warming = keep-alive вызовы для provider-side prompt cache, off by default, тратит токены |
| https://opencode.ai/docs/formatters/ | 2026-11-11 | confirmed | Форматтеры после `write`/`edit`/`patch`, off by default, стоп после первой успешной команды |
| https://opencode.ai/docs/lsp/ | 2026-11-11 | confirmed | LSP даёт diagnostics как feedback; «LSP is disabled by default»; рекомендация запускать lint/typecheck CLI и документировать в AGENTS.md |
| https://opencode.ai/docs/websearch/ | 2026-11-11 | confirmed | Провайдеры Exa/Firecrawl/Parallel/Tavily/TinyFish; permission `websearch`; cooldown на 429 |
| https://opencode.ai/docs/server/ | 2026-11-11 | confirmed | `opencode serve` — headless HTTP на 127.0.0.1:4096; OpenAPI 3.1 на `/doc`; TUI — клиент сервера |
| https://opencode.ai/docs/api | 2026-11-11 | confirmed | «Experimental HttpApi», OpenAPI 3.1.0, «170 operations and 498 schemas»; pairing через short-lived single-use code |
| https://opencode.ai/docs/sdk/ | 2026-11-11 | confirmed | `@opencode-ai/sdk`; `createOpencode()`/`createOpencodeClient()`; все server APIs; SSE-события; structured output в `/v2` |
| https://opencode.ai/docs/cli/acp/ | 2026-11-11 | confirmed | ACP v1, запуск из Zed; compaction в ACP — «in Preview» |
| https://opencode.ai/docs/cli/commands/ | 2026-11-11 | confirmed | Команды: `run`, `mini`, `session`, `auth`, `models`, `mcp`, `plugin`, `stats`, `serve`, `pair`, `service`, `reload`, `api`, `acp`, `debug`, `upgrade`, `uninstall` |
| https://opencode.ai/docs/cli/web/ | 2026-11-11 | confirmed | Web UI пароль-защищён; pairing ссылки одноразовые/5 мин; сессии 30 дней; OpenTunnel E2E; смена пароля разлогинивает |
| https://opencode.ai/docs/github/ | 2026-11-11 | confirmed | GitHub Actions: `/opencode` или `/oc`; triage, ветки/PR, review комментариев; `model` обязателен |
| https://opencode.ai/docs/config/ | 2026-11-11 | confirmed | Managed settings: `/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode`; MDM `ai.opencode.managed`; policies нужны, т.к. settings сами не запрещают добавлять providers/MCP/plugins |
| https://opencode.ai/docs/console/ | 2026-11-11 | confirmed | Console — опциональный сервис: workspaces, usage, budgets, policies, inference; Go $10, Go Plus $40, Go Teams $20/member |
| https://opencode.ai/docs/console/billing/ | 2026-11-11 | confirmed | Console «free for any team size», «no seat fees»; prepaid credits; комиссия 4.6% + $0.31; при нуле HTTP 402 |
| https://opencode.ai/docs/console/models/ | 2026-11-11 | confirmed | Gateway «at cost»; «All our models are hosted in the US and EU»; zero-retention с исключениями |
| https://opencode.ai/docs/console/harnesses/ | 2026-11-11 | confirmed | Console принимает Claude Code, Codex, Hermes, Pi, Raycast как harnesses |
| https://opencode.ai/docs/console/workspaces/ | 2026-11-11 | confirmed | Роли Member/Admin/Owner; policies привязаны к workspace |
| https://opencode.ai/docs/console/sso/ | 2026-11-11 | confirmed | OIDC (Google, Entra, Okta, Auth0, Ping) и SAML 2.0; «included with every workspace»; SCIM = directory sync |
| https://opencode.ai/docs/console/go/ | 2026-11-11 | confirmed | Go $10, Go Plus $40, Go Teams $20/member; лимиты 5ч=20%, неделя=50%, месяц=100%; Extra Usage |
| https://opencode.ai/pricing | 2026-11-11 | marketing | Free-модели с daily request limit; Go $10; Go Plus $40 |
| https://opencode.ai/enterprise | 2026-11-11 | marketing | Enterprise — контактная страница: budgets, policies, SSO, gateways/private networks, volume pricing |
| https://opencode.ai/docs/migrate-v1/ | 2026-11-11 | confirmed | V2: новый plugin API, новый server API/clients, единый `cli.json`; «V1 plugin implementations do not run in V2» |
| https://github.com/sst/opencode/releases | 2026-11-11 | confirmed | Релизы v2.2.7 (10 Nov), v2.2.6 (06 Nov), v2.2.5–v2.2.1 (29–30 Oct); темы: Copilot Auto routing, persistent desktop terminals, shared MCP connections, scripted runs in worktrees, schedules, Code Mode, breaking changes TUI plugins |
| https://api.github.com/repos/anomalyco/opencode/releases/latest | 2026-11-11 | confirmed | tag `v1.19.5`, published 2026-10-28T06:17:49Z |
| https://api.github.com/repos/anomalyco/opencode/releases?per_page=10 | 2026-11-11 | confirmed | v2.2.7 (2026-11-10T10:37:15Z), v2.2.6 (2026-11-06T23:37:20Z), prerelease=false |
| https://aider.chat/docs/ | 2026-11-11 | confirmed | «AI pair programming in your terminal»; режимы code/architect/ask/help; repo map; git; lint/test; MCP на странице не упомянут |
| https://aider.chat/docs/usage/modes.html | 2026-11-11 | confirmed | architect = architect model + editor model, два LLM-запроса |
| https://aider.chat/docs/repomap.html | 2026-11-11 | confirmed | Repo map: важные классы/функции и сигнатуры; graph ranking (файл=узел); `--map-tokens` default 1k |
| https://aider.chat/docs/git.html | 2026-11-11 | confirmed | Автокоммит после каждой правки; `/undo`, `/diff`, `/commit`; preexisting dirty changes коммитятся отдельно |
| https://aider.chat/docs/usage/lint-test.html | 2026-11-11 | confirmed | Линт автоматически по умолчанию; auto-test опционально (`--test-cmd` + `--auto-test`); цикл исправлений |
| https://aider.chat/docs/more/edit-formats.html | 2026-11-11 | confirmed | Форматы whole, diff, diff-fenced, udiff, editor-diff/editor-whole |
| https://aider.chat/docs/scripting.html | 2026-11-11 | confirmed | `--message`, `--message-file`, `--yes`, `--dry-run`, `--commit`; Python API «not officially supported» |
| https://aider.chat/docs/usage/watch.html | 2026-11-11 | confirmed | `--watch-files`; комментарии `AI`, `AI!`, `AI?`; редактор-агностично |
| https://aider.chat/docs/languages.html | 2026-11-11 | confirmed | 150 языков / 204 строки; tree-sitter для lint и repo map (`tags.scm`) |
| https://aider.chat/docs/more/analytics.html | 2026-11-11 | confirmed | Opt-in анонимная аналитика, UUID4; «never collects your code, chat messages, keys or personal info»; `--analytics-disable` |
| https://aider.chat/docs/faq.html | 2026-11-11 | confirmed | «only work with one repo at a time»; большие монорепо не оптимизированы; MCP/subagents не упомянуты |
| https://aider.chat/docs/leaderboards/ | 2026-11-11 | confirmed | Polyglot benchmark, 225 Exercism задач, 6 языков; «last updated November 20, 2025»; gpt-5 (high) 88.0% |
| https://aider.chat/2024/12/21/polyglot.html | 2026-11-11 | confirmed | Метрики: percent completed correctly и percent using correct edit format |
| https://aider.chat/docs/more/infinite-output.html | 2026-11-11 | confirmed | Продолжение ответа при достижении output limit через prefill; только для моделей с prefill |
| https://api.github.com/repos/Aider-AI/aider | 2026-11-11 | confirmed | Apache-2.0, 50 059 stars, 1 961 open issues, `pushed_at` 2026-05-22T14:02:20Z, не archived |
| https://api.github.com/repos/Aider-AI/aider/commits?per_page=5 | 2026-11-11 | confirmed | Последние коммиты 15–22 мая 2026; PR #5173 (Anthropic models), #5132 (bash tree-sitter tags) |
| https://api.github.com/repos/Aider-AI/aider/releases?per_page=3 | 2026-11-11 | confirmed | Последний GitHub Release: v0.86.0, 2025-08-09T17:42:19Z |
| https://pypi.org/project/aider-chat/#history | 2026-11-11 | confirmed | 0.86.2 — «Feb 12, 2026»; 0.86.0 — «Aug 9, 2025» |
| https://pypi.org/pypi/aider-chat/json | 2026-11-11 | confirmed | latest 0.86.2; owner `paul-gauthier`; homepage — GitHub repo |
| https://ampcode.com/ | 2026-11-11 | marketing | «the frontier agent and development environment that lets you build from anywhere»; web/terminal/phone/Android; orbs «run without supervision»; portals; multiplayer; automations |
| https://ampcode.com/docs | 2026-11-11 | confirmed | Три поверхности: web «needs no install», native Mac/Windows/Linux/iPhone/iPad/Android, terminal CLI; VS Code/JetBrains расширений в навигации нет |
| https://ampcode.com/manual | 2026-11-11 | confirmed | Orb = машина «created per thread»; «Send a prompt, close your laptop, and the agent keeps working»; «same agent and the same threads everywhere»; «No backward compatibility, no legacy features» |
| https://ampcode.com/docs/tools | 2026-11-11 | confirmed | Task tool (subagent), Painter tool; «does not ask for approval» по умолчанию; sandbox не описан; совет про policy plugin/isolated env |
| https://ampcode.com/docs/models-and-subagents | 2026-11-11 | confirmed | Task subagent: свой контекст, изолирован, «cannot talk to each other»; параллелизм по независимым областям; Oracle `@amp/oracle` не редактирует файлы; custom agents через плагины |
| https://ampcode.com/docs/customize/model-routing | 2026-11-11 | confirmed | Connections: API keys, subscriptions (ChatGPT, X Premium+/SuperGrok), Bedrock/Vertex/Foundry, routers (OpenRouter, Vercel, Cloudflare, Ollama Cloud, OpenCode Go, custom URL); fallback: personal → workspace → Amp; priority 0 первым |
| https://ampcode.com/docs/customize/skills | 2026-11-11 | confirmed | `SKILL.md`; `.agents/skills/`, `~/.config/agents/skills/`, `.claude/skills/`; `mcp.json` рядом со скиллом; hooks не описаны |
| https://ampcode.com/docs/customize/plugins | 2026-11-11 | confirmed | TS/JS плагины; события `session.start`, `agent.start`, `tool.call`, `tool.result`, `agent.end`, `changes.prompt`; `registerTool`, `registerCommand`, UI, `amp.ai.ask/decide`, `createAgent`; precedence «project, system, personal, then workspace» |
| https://ampcode.com/docs/customize/mcp | 2026-11-11 | confirmed | Local stdio + remote; remote tools Allow/Ask First/Disabled; «Ask First» недоступен субагентам; workspace-серверы требуют approval |
| https://ampcode.com/docs/customize/agents-md | 2026-11-11 | confirmed | AGENTS.md по дереву до `$HOME`, subtree-файлы при чтении; personal/system/workspace guidance; fallback AGENT.md/CLAUDE.md; `AMP_IGNORE_GUIDANCE_FILES` |
| https://ampcode.com/docs/orbs | 2026-11-11 | confirmed | Cloud sandbox на поток; `amp sync`, `amp sync --apply`; спящий orb бесплатен; burst 20 orbs, далее 1 orb / 5 мин; файлы до 512 MB |
| https://ampcode.com/docs/orbs/sizes-and-costs | 2026-11-11 | confirmed | a1.tiny $0.08/h … a1.3xlarge $2.13/h; 60 GB disk; пауза после 5 мин без работы/20 мин без взаимодействия; self-hosted $0.0504/CPU-h + $0.0162/GB-h |
| https://ampcode.com/docs/orbs/agent-to-agent | 2026-11-11 | confirmed | Агенты запускают агентов, обмениваются сообщениями и файлами; у каждого свой контекст/workspace/orb |
| https://ampcode.com/docs/boxes | 2026-11-11 | confirmed | Box — «always-on computer»; у приложения свой URL; b1.tiny ~$18/мес ($0.025/h), b1.small $30/30 дней; 100 GB трафика |
| https://ampcode.com/pricing | 2026-11-11 | marketing | Hobby free; Individual $20/mo; Teams без доплаты; Enterprise custom; Education $10/mo |
| https://ampcode.com/security | 2026-11-11 | marketing | SOC 2 Type II; SSO/Directory Sync через WorkOS; audit logs ≥30 дней; GCP US; TLS 1.2+/AES-256; secret redaction best-effort; no training unless opt-in |
| https://ampcode.com/news/amp-frontier-corporation | 2026-11-11 | confirmed | 2025-12-02: spin-out из Sourcegraph, «independent research lab», «Amp is profitable» |
| https://ampcode.com/news/the-coding-agent-is-dead | 2026-11-11 | confirmed | 2026-02-19: «kill the Amp editor extensions for VS Code and Cursor», self-destruct 2026-03-05 |
| https://ampcode.com/news/neo | 2026-11-11 | confirmed | 2026-05-06: rebuilt CLI «remote-controllable, compaction-first, plugin-powered»; compaction при 90% контекста; permissions стали плагином; удалены handoff, rollback при редактировании сообщений, user-invokable skills |
| https://ampcode.com/news/plugins-everywhere | 2026-11-11 | confirmed | 2026-05-28: плагины показывают UI на web (notifications, dialogs, inputs, selects) |
| https://ampcode.com/news/custom-agents | 2026-11-11 | confirmed | 2026-06-19: `amp.createAgent`, `registerTool`, `registerAgentMode`; «spawn 25 custom worker agents» |
| https://ampcode.com/news/agents-in-orbs | 2026-11-11 | confirmed | 2026-06-30: orbs «machines where agents can run without supervision», billed by minute, sleep |
| https://ampcode.com/news/the-dial | 2026-11-11 | confirmed | 2026-07-09: ultra/high/medium/low; Fable 5 + GPT-5.6 Sol как oracle; low = GLM-5.2 |
| https://ampcode.com/news/from-agent-to-agent | 2026-11-11 | confirmed | 2026-07-17: агенты запускают агентов в orbs/локально/на других машинах, обмен сообщениями и файлами |
| https://ampcode.com/news/free-agent | 2026-11-11 | confirmed | 2026-09-13: free при своём compute/подписке; убраны BYOK token fees (кроме Enterprise); Hobby free, Teams без доплаты, Individual $20 |
| https://ampcode.com/news/amp-on-ios-and-macos | 2026-11-11 | confirmed | 2026-08-28: iOS (TestFlight) и macOS (direct download) |
| https://ampcode.com/news/self-hosted-orbs | 2026-11-11 | confirmed | 2026-10-22: `amp orb provider`; Docker/E2B/Kubernetes/Apple containers/Modal/Vercel/Daytona/exe.dev |
| https://ampcode.com/news/amp-on-android | 2026-11-11 | confirmed | 2026-10-27: Android-приложение |
| https://ampcode.com/news/artifacts | 2026-11-11 | confirmed | 2026-11-02: Artifacts — документы одного thread, редактируют агент, пользователь и команда |
| https://ampcode.com/news/spaces | 2026-11-11 | confirmed | 2026-11-06: Space — «a conversation with a single agent whose job is to spawn and coordinate agents» |
| https://ampcode.com/news/boxes | 2026-11-11 | confirmed | 2026-11-10: boxes — «always-on computer», $18/30 дней от |
| https://ampcode.com/news/amp-free | 2026-11-11 | confirmed | 2025-10-15: Amp Free с рекламой; Update 4 — «is paused», «We don't intend to bring it back» |
| https://ampcode.com/news/librarian | 2026-11-11 | confirmed | 2025-10-20: субагент поиска по публичному и приватному GitHub |
| https://ampcode.com/news/cli-vscode-neovim | 2026-11-11 | confirmed | 2025-09-30: `amp --ide` даёт доступ к текущему файлу, выделению и diagnostics |
| https://ampcode.com/news/agentic-code-review | 2026-11-11 | confirmed | 2025-12-18: review-агент на Gemini 3 Pro, pre-scan diff, actionable improvements |
| https://ampcode.com/news/drop-the-neo | 2026-11-11 | confirmed | 2026-05-27: суффикс Neo снят |
| https://goose-docs.ai/ | 2026-11-11 | marketing | «open source AI agent», «runs on your machine»; Apache 2.0, Rust; «600+ Contributors»; AAIF/Linux Foundation; desktop+CLI+API+GDK; MCP «70+ documented extensions»; «15+ providers» |
| https://goose-docs.ai/docs/getting-started/installation.md | 2026-11-11 | confirmed | Desktop download/Homebrew; welcome screen выбора провайдера; Models tab; Desktop и CLI «share all core configurations» |
| https://goose-docs.ai/docs/getting-started/providers/ | 2026-11-11 | confirmed | Anthropic/OpenAI/Gemini/Bedrock/Azure/OpenRouter/Groq/Mistral/xAI/Copilot/Ollama; «works best with Claude 4 models»; custom OpenAI/Anthropic/Ollama-совместимые провайдеры |
| https://goose-docs.ai/docs/getting-started/using-extensions | 2026-11-11 | confirmed | Расширения на MCP: builtin, platform, stdio, streamable_http (SSE unsupported); malware-check перед активацией; deeplinks |
| https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md | 2026-11-11 | confirmed | 4 режима: Completely Autonomous (default), Manual Approval, Smart Approval, Chat Only; read/write классификация — «best effort» через LLM |
| https://goose-docs.ai/docs/guides/context-engineering/subagents.mdx | 2026-11-11 | confirmed | Временные изолированные инстансы; последовательно или параллельно; default 5 concurrent, 1000 turns, 5-мин таймаут; субагент не может спавнить субагентов |
| https://goose-docs.ai/docs/guides/context-engineering/custom-agents.md | 2026-11-11 | confirmed | Markdown+YAML в `~/.agents/agents/` или `<project>/.agents/agents/`; поля name/description/model |
| https://goose-docs.ai/docs/guides/context-engineering/hooks.md | 2026-11-11 | confirmed | Хуки — shell-команды из плагинов, `hooks/hooks.json`; события SessionStart/End, Stop, UserPromptSubmit, PreToolUse, PostToolUse и др.; только PreToolUse блокирует вызов |
| https://goose-docs.ai/docs/guides/context-engineering/plugins.md | 2026-11-11 | confirmed | Плагин = контейнер skills + hooks; `goose plugin install <git-url>`; Open Plugins и Gemini extensions |
| https://goose-docs.ai/docs/guides/context-engineering/using-skills.md | 2026-11-11 | confirmed | `SKILL.md`; `~/.agents/skills/`, `.agents/skills/`, `~/.agents/plugins/<plugin>/`; legacy `.goose/skills/`, `.claude/skills/`; `goose skills list`, `/skills` |
| https://goose-docs.ai/docs/guides/context-engineering/using-goosehints.md | 2026-11-11 | confirmed | `.goosehints` глобальный/локальный; локальные приоритетнее; hints идут в system prompt каждого запроса; `AGENTS.md` проверяется первым |
| https://goose-docs.ai/docs/guides/recipes/recipe-reference.md | 2026-11-11 | confirmed | YAML/JSON; `instructions` или `prompt`; Jinja-параметры; типы string/number/boolean/date/file/select; `sub_recipes`; `prompt` обязателен в headless |
| https://goose-docs.ai/docs/guides/goose-cli-commands.md | 2026-11-11 | confirmed | `goose session --resume/--fork`; SQLite `sessions.db`; `goose run` из файла/stdin, `--output-format text/json/stream-json`, `--max-turns`; `goose schedule add --cron`; `goose acp`, `goose serve` |
| https://goose-docs.ai/docs/guides/sessions/session-management.md | 2026-11-11 | confirmed | Общая БД Desktop+CLI; поиск/форк/экспорт/импорт сессий; «new sessions for new tasks» |
| https://goose-docs.ai/docs/guides/codebase-analysis.md | 2026-11-11 | confirmed | Analyze extension: Structure/Semantic/Focus, call graphs; лимит 50 000 символов без `force=true` |
| https://goose-docs.ai/docs/gdk/index.md | 2026-11-11 | confirmed | GDK — переиспользуемый agent runtime; Rust core, Python/Kotlin bindings; resume from persisted state |
| https://goose-docs.ai/docs/guides/config-files.md | 2026-11-11 | confirmed | `~/.config/goose/config.yaml`; `GOOSE_MODE`, `GOOSE_MAX_TURNS`; `otel_exporter_otlp_endpoint`; `GOOSE_TELEMETRY_ENABLED` |
| https://goose-docs.ai/docs/guides/usage-data.md | 2026-11-11 | confirmed | Только анонимные метрики после согласия; исключает «your conversations, code, tool arguments, error messages, or any personal data» |
| https://goose-docs.ai/docs/guides/allowlist.md | 2026-11-11 | confirmed | Allowlist MCP-серверов через `GOOSE_ALLOWLIST`; без переменной ограничений нет |
| https://goose-docs.ai/docs/guides/zed.md | 2026-11-11 | confirmed | ACP-интеграция с Zed; goose читает существующую конфигурацию; context_servers Zed доступны goose |
| https://goose-docs.ai/docs/guides/remote-goose-server.md | 2026-11-11 | confirmed | `goose serve` на VM, Desktop подключается по URL; `GOOSE_SERVER__SECRET_KEY`; TOFU или pinning по fingerprint |
| https://goose-docs.ai/docs/guides/roaming-agents.md | 2026-11-11 | confirmed | Экспериментальный P2P ACP через iroh/QUIC; не входит в релизные бинарники; «effectively remote shell access» |
| https://goose-docs.ai/docs/guides/terminal-integration.md | 2026-11-11 | confirmed | `@goose`/`@g` из shell; не записывает команды по умолчанию; `--dangerous-include-history` отправляет историю провайдеру |
| https://goose-docs.ai/docs/guides/mcp-elicitation.md | 2026-11-11 | confirmed | MCP elicitation: форма запроса у пользователя, таймаут 5 минут |
| https://goose-docs.ai/docs/guides/mcp-roots.md | 2026-11-11 | confirmed | MCP roots поддерживаются (страница существует в официальном дереве docs) |
| https://api.github.com/repos/aaif-goose/goose | 2026-11-11 | confirmed | Apache-2.0, 56 441 stars, `pushed_at` 2026-11-11T04:26:36Z, homepage `goose-docs.ai` |
| https://api.github.com/repos/aaif-goose/goose/releases/latest | 2026-11-11 | confirmed | tag `v1.59.0`, published 2026-11-10T17:17:02Z |
| https://api.github.com/repos/aaif-goose/goose/releases/tags/v1.59.0 | 2026-11-11 | confirmed | Deferred MCP tools, live-voice instructions, ACP session filtering, goose-agent hooks, subagent follow-ups, compaction prompt fix |
| https://api.github.com/repos/aaif-goose/goose/releases/tags/v1.56.0 | 2026-11-11 | confirmed | Subagent resume, session links, `GOOSE_MAX_CONCURRENT_SUBAGENTS`, turn-limit fallback, foreground subagents in GDK |
| https://api.github.com/repos/aaif-goose/goose/releases/tags/v1.57.0 | 2026-11-11 | confirmed | Allowlist: HTTPS + redirect validation; zstd advisory fix; remove jsonwebtoken |
| https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation | 2026-11-11 | confirmed | AAIF создан 2025-12-09; founding contributions от Anthropic, Block, OpenAI; goose передан Block |
| https://block.github.io/goose/ | 2026-11-11 | confirmed | Редирект-заглушка «goose has moved» → `goose-docs.ai`; подтверждает переезд доков |
| https://goose-docs.ai/docs/ | 2026-11-11 | confirmed | Официальный docs-хост (после переезда) |

### 2.1 Недоступные (BLOCKED) источники

| URL | Ошибка | Дата | Комментарий |
| --- | --- | --- | --- |
| https://block.github.io/goose/docs/getting-started/installation | HTTP 404 | 2026-11-11 | Старый путь; актуальный — `goose-docs.ai/docs/getting-started/installation.md` |
| https://block.github.io/goose/docs/ | HTTP 404 | 2026-11-11 | Старый путь; сайт отдаёт «goose has moved» |
| https://block.github.io/goose/blog | HTTP 404 | 2026-11-11 | Блог переехал; содержимое не проверено |
| https://goose-docs.ai/pricing | HTTP 404 | 2026-11-11 | Публичной pricing-страницы нет; вывод о бесплатности — только из Apache-2.0 + отсутствия платного tier в docs |
| https://goose-docs.ai/docs/enterprise/ | HTTP 404 | 2026-11-11 | Публичного enterprise-оффера в docs не найдено |
| https://goose-docs.ai/docs/guides/cost-tracking.md | HTTP 404 | 2026-11-11 | Страница отсутствует; отдельного cost-tracking гайда в дереве docs нет |
| https://goose-docs.ai/blog/same-brain-different-bill/ | HTTP 404 | 2026-11-11 | Пост упомянут в release notes v1.59.0, но URL не подтверждён |
| https://goose-docs.ai/docs/guides/mcp-apps.md | HTTP 404 | 2026-11-11 | MCP Apps упоминаются на homepage, отдельная страница по этому пути не найдена |
| https://ampcode.com/news/amp | HTTP 404 | 2026-11-11 | Неверный путь; используется `/notes/how-i-use-amp` и `/news/amp-frontier-corporation` |
| https://ampcode.com/news/puck | HTTP 404 | 2026-11-11 | Puck упоминается в manual, отдельного поста по этому URL нет |
| https://ampcode.com/manual/tools, /manual/permissions, /manual/subagents | HTTP 404 | 2026-11-11 | Фактические пути — `/docs/tools`, `/docs/models-and-subagents` |
| https://ampcode.com/docs/telemetry | HTTP 404 | 2026-11-11 | Публичной telemetry-страницы нет |
| https://ampcode.com/docs/editor-extensions | HTTP 404 | 2026-11-11 | Расширения для редакторов сняты (см. «The Coding Agent Is Dead»); отдельной страницы нет |
| https://ampcode.com/changelog | HTTP 404 | 2026-11-11 | Публичного changelog нет; хронология восстанавливается по `/news` |
| https://opencode.ai/docs/context/, /docs/share/, /docs/telemetry/, /docs/desktop/, /docs/worktrees | HTTP 404 | 2026-11-11 | Контекст описан в `/docs/compaction/`; desktop — на `/download` и в README; отдельной worktrees-страницы нет |
| https://opencode.ai/privacy | HTTP 404 | 2026-11-11 | Публичной privacy-политики по этому пути нет; выводы о данных — только из `/docs/console/models/` |
| https://opencode.ai/blog, https://opencode.ai/blog/opencode-2 | HTTP 404 | 2026-11-11 | Публичного блога по этим путям нет |
| https://aider.chat/docs/more/privacy.html | HTTP 404 | 2026-11-11 | Приватность описана в `/docs/more/analytics.html` |
| https://aider.chat/docs/more/faq.html, /docs/more/thanks.html | HTTP 404 | 2026-11-11 | FAQ — на `/docs/faq.html` |
| https://aider.chat/HISTORY.html | 200, но без текста | 2026-11-11 | Extraction вернул пустой результат; даты взяты из GitHub Releases и PyPI |
| https://aider.chat/docs/llms.txt, https://aider.chat/sitemap.xml | 404 / пусто | 2026-11-11 | Индекс не дал данных; MCP-отсутствие подтверждено обходом docs-навигации |

Правило соблюдено: там, где источник недоступен, утверждение **не** восстановлено по памяти; в матрице стоит `н/д` или явная пометка.

## 3. Сводная матрица возможностей

Обозначения: `+` — подтверждено первичным источником; `±` — частично/с оговорками; `−` — официально не заявлено или явно отсутствует; `н/д` — источник недоступен (BLOCKED).

| Возможность | OpenCode (Anomaly) | Aider | Amp (Sourcegraph → Amp Frontier) | Goose (Block → AAIF) |
| --- | --- | --- | --- | --- |
| Позиционирование | «The open source coding agent for any model» | «AI pair programming in your terminal» | «frontier agent and development environment» | «open source, extensible AI agent that goes beyond code suggestions» |
| Terminal/TUI | + (`opencode`, `mini`) | + (основная поверхность) | + (CLI, `--no-tui` для runner) | + (`goose session`, `@goose` в shell) |
| IDE-интеграция | + через ACP (Zed); VS Code/JetBrains — не заявлены | ± редактор-агностичный `--watch-files`, без плагинов | − расширения VS Code/Cursor «self-destruct» 2026-03-05; `amp --ide` остался как CLI-мост | + ACP/Zed |
| Desktop | + (BETA), macOS/Win/Linux | − | + macOS/Windows/Linux | + macOS/Linux/Windows |
| Web UI | + (`opencode serve`, web UI, `pair`, OpenTunnel) | ± «in your browser» через LLM chat copy/paste | + ampcode.com, «needs no install» | − (Desktop подключается к remote `goose serve`, но web-клиента нет) |
| Mobile | ± web UI через QR/`pair` | − | + iOS, Android, iPad | − |
| Cloud/remote agents | ± GitHub Actions, `opencode serve` на своей машине | − | + orbs, self-hosted orbs, boxes, spaces | ± `goose serve` на VM, experimental roaming (P2P ACP) |
| Agent loop | + tool-calling loop, Code Mode `execute` | + one-shot/chat loop с edit format | + orb-based, compaction-first, remote-controllable | + state-machine loop, GDK |
| Планирование | + agent `plan` (read-only) | + режим `architect` (plan→edit) | + custom modes, Spaces-координатор | + режимы, recipes, custom agents |
| Субагенты | + `subagent` tool, foreground/background child sessions | − | + Task tool, custom agents, `@amp/oracle`, Librarian | + internal/external subagents, default 5 concurrent |
| Параллельные агенты | ± несколько child sessions, лимит параллелизма не документирован | − | + явно: несколько субагентов, «spawn 25 custom worker agents», Spaces | + параллельные субагенты, cap через env |
| Tools: файлы | + `read/glob/grep/edit/write/patch` | + add/read/edit файлов | + built-in (список через `amp tools list`) | + Developer extension |
| Tools: терминал | + `shell` (host authority, 2 мин foreground) | + shell-команды, lint/test | + terminal в orb/runner | + shell, terminal integration |
| Tools: браузер | + `browser` namespace в Code Mode | − | + порталы/preview, browser в orb | + Computer Controller extension |
| MCP | + local/remote, OAuth, Code Mode | − (нет упоминаний в docs) | + local/remote, allow/ask/disabled, enterprise allowlist | + ядро расширяемости, «70+ extensions», MCP Apps, elicitation, roots |
| Rules/instructions | `AGENTS.md` (V2 только он), `/init`, instructions array | `CONVENTIONS.md` через `/read`/config | `AGENTS.md` по дереву + personal/system/workspace | `.goosehints` + `AGENTS.md` (первым), custom agents |
| Repo indexing / repo map | ± references + grep/glob; semantic index не заявлен | + repo map (tree-sitter tags + graph ranking, 1k tokens) | + Librarian (поиск по GitHub), Finder | + Analyze extension (Structure/Semantic/Focus, call graphs) |
| Compaction | + auto (15% buffer, keep 15k), manual API, lossy | ± «infinite output» только для output limit; input compaction не заявлена | + «compaction-first», авто при 90% | + compaction (упоминается в release notes; отдельная страница не найдена) |
| Extensibility: plugins | + server/TUI/GUI plugins, hooks, hot reload | − | + TS/JS plugin API (tools, commands, events, UI, agents, decision models) | + plugins = skills + hooks |
| Extensibility: skills | + `SKILL.md`, 6 путей discovery | − | + `SKILL.md`, `.agents/skills`, `.claude/skills`, `mcp.json` рядом | + `SKILL.md`, `.agents/skills`, plugins |
| Extensibility: hooks | + богатый набор хуков (session/tool/model/HTTP/retry/permission) | − | + события `session.start`, `tool.call`, `tool.result` и др. | + `hooks.json`, 12 событий, PreToolUse блокирует |
| Custom commands | + Markdown/JSON, args, shell-инъекция, subagent | ± slash-команды встроенные, пользовательских нет | + `registerCommand` через плагин | + slash commands, recipes |
| SDK / headless | + `@opencode-ai/sdk`, HTTP API (170 операций), `run`, `serve` | ± `--message`/`--yes`, Python API «not officially supported» | + `@ampcode/sdk`, `amp -x`, runners | + GDK (Rust/Python/Kotlin), `goose run`, ACP server |
| Models/providers | + 200+ через models.dev, local Ollama/LM Studio/vLLM | + «almost any LLM», local | + connections (API keys, подписки, cloud, routers), fallback personal→workspace→Amp | + 15+ провайдеров, Ollama, custom OpenAI/Anthropic/Ollama |
| Routing/fallback | ± ретраи, custom gateways; общего router нет | − | + priority-based fallback, oracle как review (не fallback) | ± model selection, без документированного fallback |
| BYOK | + (`/connect`, env, cloud auth) | + (ключи провайдеров) | + (Hobby free, без token fees кроме Enterprise) | + (свои ключи) |
| Permissions | + ordered rules, policies hard-deny, managed config/MDM | ± `--yes` и подтверждения; гранулярной модели нет | ± по умолчанию **не спрашивает**; policy plugin; MCP Ask First | + 4 режима, включая Smart Approval и Chat Only |
| Sandbox | − «host user's filesystem, process, and network authority» | − | + orb/runner как изоляция; локально sandbox не описан | − sandbox не заявлен; allowlist MCP |
| Secrets | + хранение вне project config, env substitution | + `.env`, ключи провайдеров | ± secret redaction «best-effort»; секреты в boxes | + `secrets.yaml`, keyring не подтверждён |
| Git/commit | ± `/undo`/`/redo` через internal Git ODB; автокоммитов нет | + автокоммит каждой правки, `/undo`, `/diff`, `/commit` | ± `amp sync`, изменения в orb; коммиты — через агента | ± только рекомендация «commit early and often»; авто-commit не заявлен |
| PR | + GitHub Actions `/oc`, review | − | ± agentic review, без PR-бота | − (нет GitHub-интеграции в docs) |
| Worktree | + `worktree.directory`, scripted runs in worktrees | − | ± orb на поток, `amp sync` в checkout | − |
| Checkpoints/undo | + snapshots, `/undo`/`/redo`/Revert | + `/undo` (git-based) | − rollback при редактировании сообщений удалён в Neo | − |
| Telemetry/evals | н/д (страницы нет); benchmark — polyglot у Aider | + opt-in analytics; polyglot benchmark 225 задач | н/д (страницы нет) | + opt-in anonymous metrics, OTel export |
| Pricing | Free-модели; Go $10/Plus $40/Teams $20; Console free, credits | Бесплатный Apache-2.0, платите провайдеру | Hobby free; Individual $20; orbs по минутам; boxes от $18 | Бесплатный Apache-2.0; публичного платного tier нет |
| Notables 2025–2026 | V2 с breaking changes, desktop BETA, Go/Console, 200+ провайдеров | 0.86.x, GPT-5/Grok-4, tree-sitter расширения; темп коммитов замедлился с мая 2026 | Spin-out, «Neo» rebuild, orbs, spaces, boxes, mobile, удаление IDE-расширений | AAIF, v1.5x: субагенты, hooks, plugins, MCP Apps, recipes/schedules, GDK |

## 4. Per-product narrative

### 4.1 OpenCode (Anomaly)

**Позиционирование и статус.** Официальный сайт называет продукт «The open source coding agent for any model» и заявляет «200+ LLM providers», MIT-лицензию и «Built in the open by Anomaly and 1,090 contributors» (https://opencode.ai/). Репозиторий — `anomalyco/opencode`, 225 953 stars, активная разработка (последний push 2026-11-11T06:10:28Z). Важная деталь идентичности: архивный `opencode-ai/opencode` (13 885 stars, `pushed_at` 2025-09-18) — **другой** проект; актуальный OpenCode живёт под `anomalyco`. Упоминаний SST на текущем сайте/README нет.

**Поверхности.** Terminal/TUI (`opencode`, `opencode mini`), desktop-приложение (README помечает его «BETA»), web UI, mobile через QR/`opencode pair`, headless `opencode serve`, ACP для Zed. Desktop: «Sessions, tabs, diffs, built-in browser, and extensions», macOS Apple Silicon/Intel, Windows x64/ARM64, Linux deb/rpm/AppImage (https://opencode.ai/download). Web UI пароль-защищён, pairing-ссылки одноразовые и живут 5 минут, сессии 30 дней, OpenTunnel E2E (https://opencode.ai/docs/cli/web/).

**Agent loop, автономия, планирование, субагенты.** Два основных агента: `build` (полный доступ) и `plan` (read-only, «Denies file edits by default», спрашивает перед bash). Субагенты `general` и `explore` запускаются через tool `subagent` и «run with fresh context in foreground or background child sessions» (https://opencode.ai/docs/agents/). Каждый агент — это «system prompt, model preference, permissions, and display details». Параллелизм субагентов явно не лимитирован в docs; Code Mode (`execute`) позволяет комбинировать и параллелить инструменты в JS (https://opencode.ai/docs/tools/).

**Инструменты.** `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `experimental_image_generate`, `question`, `skill`, `subagent`, `execute`. `patch` доступен только «for supported GPT models». `shell` имеет `workdir`, `timeout`, `background`; foreground-таймаут 2 минуты. MCP-инструменты обычно доступны через `execute`, если не выставлено `codemode: false`. В Code Mode есть namespace `browser`.

**Контекст/память/rules.** V2 распознаёт только `AGENTS.md`, без fallback на `CLAUDE.md`; вложенные файлы грузятся при исследовании соответствующих областей; configured instructions (files/globs/URL с 5s таймаутом) применяются после AGENTS.md (https://opencode.ai/docs/instructions/). Compaction: auto по умолчанию, `buffer` 15% (минимум 16k), `keep.tokens` 15 000, summary фиксирует objective/decisions/completed/blockers/next steps/files, «Compaction is lossy» (https://opencode.ai/docs/compaction/). Отдельного semantic-индекса нет; есть `references` для внешних каталогов/репозиториев с кэшем и refresh не чаще 24h. LSP выключен по умолчанию; документация сама советует запускать lint/typecheck CLI и фиксировать команды в `AGENTS.md` (https://opencode.ai/docs/lsp/). Warming — это keep-alive для provider prompt cache, а не прогрев индекса (https://opencode.ai/docs/warming/).

**Расширяемость.** Плагины (server/TUI/GUI) добавляют «tools, hooks, integrations, commands, agents»; хуки покрывают session prompt/context/compaction/generate/title, model resolution/request, HTTP/WS, retry, permission evaluation, shell `create.before`, tool `execute.before/after` (https://opencode.ai/docs/build/plugins/server/). Skills — `SKILL.md` с шестью путями discovery, включая `.claude/skills` и `.agents/skills`; модель видит только id/name/description. Команды — Markdown/JSON с `$ARGUMENTS`/`$1..$n`, shell-инъекцией и `subagent: true`; shell-инъекция исполняется «outside the agent's tool permission flow» — это осознанный риск. SDK `@opencode-ai/sdk` и HTTP API (OpenAPI 3.1, «170 operations and 498 schemas») дают полноценный headless-контур.

**Модели/провайдеры.** Каталог из models.dev, локальные Ollama/LM Studio/vLLM, варианты `provider/model#variant`, free-модели `opencode`/`opencode-go`. Общего routing/fallback нет: есть ретрай таймаута до 3 раз, custom gateways и OpenRouter. Платный слой — Console (gateway «at cost», US/EU hosting, zero-retention с исключениями) и подписки Go $10 / Go Plus $40 / Go Teams $20 за участника.

**Права/безопасность.** Упорядоченные правила `action/resource/effect`, «The last matching rule wins», по умолчанию `ask`. `shell` работает «with the host user's filesystem, process, and network authority» — sandbox не заявлен, рекомендация — узкий shell allowlist. Policies — бинарные, «never prompt», «only ever tighten», применяются после agent rules и saved approvals. Managed settings через `/Library/Application Support/opencode`, `/etc/opencode`, `%ProgramData%\opencode` и MDM-домен `ai.opencode.managed`; но settings сами по себе «cannot stop users from adding providers, MCP servers, agents, or plugins» — нужны policies.

**Git/PR/checkpoints.** Snapshots — best-effort до/после каждого шага, отдельная internal Git ODB, `/undo`/`/redo`/Revert, лимит 2 MiB на untracked файл, «convenience, not a transaction or backup». Автокоммитов нет. GitHub Actions: `/opencode` или `/oc`, triage, ветки/PR, review комментариев, `model` обязателен. Worktrees настраиваются через `worktree.directory`; в релизах есть «Scripted Runs in Worktrees».

**Наблюдаемые 2025–2026 изменения.** Переход на V2 с тремя breaking changes (plugin API, server API/clients, единый `cli.json`); «V1 plugin implementations do not run in V2» (https://opencode.ai/docs/migrate-v1/). Релизы v2.2.7 (2026-11-10) и v2.2.6 (2026-11-06); темы: GitHub Copilot Auto routing, persistent desktop terminals, shared MCP connections, scripted runs in worktrees, schedules, Code Mode, breaking changes в TUI plugins.

**Сильные стороны.** Широта поверхностей и провайдеров; продуманная модель permissions+policies с managed/MDM; мощный plugin/hook API; полноценный headless SDK/HTTP API; прозрачная lossy-компакция с сохранением решений и блокеров; snapshots с undo/redo.

**Слабые стороны.** Нет sandbox — shell наследует права пользователя; shell-инъекция команд обходит tool permission flow; snapshot не транзакция и не бэкап; V2 сломал plugin API; desktop ещё BETA; нет встроенного semantic-индекса и repo map; параллелизм субагентов не лимитирован в docs.

**Do-not-copy.** (1) `shell` без sandbox и с host authority — не копировать без изоляции. (2) Shell-инъекция в custom commands вне permission flow — прямое расширение поверхности атаки. (3) V2-style breaking plugin API без длинного deprecation-окна — дорого для экосистемы. (4) Snapshots как «undo» без явного предупреждения о не-транзакционности — риск потери данных.

### 4.2 Aider

**Позиционирование и статус.** «AI pair programming in your terminal», Apache-2.0, `Aider-AI/aider`, 50 059 stars, 1 961 открытый issue, `pushed_at` 2026-05-22T14:02:20Z, не archived. Последний GitHub Release — v0.86.0 (2025-08-09T17:42:19Z); на PyPI 0.86.2 от «Feb 12, 2026». Коммиты идут (15–22 мая 2026, PR #5173 и #5132), но темп ниже, чем у конкурентов, и после мая 2026 публичной активности в проверенных источниках не видно. Это наблюдение о темпе, не заявление о прекращении поддержки.

**Поверхности.** Терминал — основная; плюс работа «from within your favorite IDE or editor» через `--watch-files`, browser chat через copy/paste, изображения/веб-страницы и голос. Отдельного desktop/web/mobile нет.

**Agent loop, автономия, планирование.** Один цикл «запрос → правки → diff → коммит». Режимы: `code`, `ask` (никогда не меняет файлы), `architect` (architect model предлагает, editor model применяет — два LLM-запроса), `help`. Субагентов и параллельных агентов нет. Автономия ограничена: `--yes` снимает подтверждения, `--dry-run` ничего не пишет, `--message`/`--message-file` дают one-shot.

**Инструменты.** Редактирование только файлов, добавленных в чат; repo map подсказывает цели; shell-интеграция — через lint/test команды и `/run`. Браузера, MCP и плагинов нет: MCP не упоминается ни в индексе docs, ни в options, ни в FAQ; sitemap не содержит mcp/plugin/extension URL. Это подтверждённое отсутствие, а не «не найдено».

**Контекст/память/rules.** Repo map — «concise map of your whole git repository» с сигнатурами, graph ranking (файл = узел, рёбра = зависимости), `--map-tokens` по умолчанию 1k, динамическая подстройка. 150 языков, tree-sitter (`tags.scm`) для repo map и линта. Правила — `CONVENTIONS.md` через `/read` или config. Compaction входного контекста не заявлена; «infinite output» — только продолжение ответа при output limit через prefill.

**Расширяемость.** Практически отсутствует: встроенные slash-команды, конфиг YAML/`.env`, Python API «not officially supported or documented». Нет hooks, skills, plugins, MCP.

**Модели/провайдеры.** «Almost any LLM, including local models»; документированы OpenAI, Anthropic, Gemini, Groq, LM Studio, xAI, Azure, Cohere, DeepSeek, Ollama, OpenRouter, GitHub Copilot, Vertex AI, Bedrock, OpenAI-совместимые. Выбор модели в чате, `/model`, `/editor-model`, `/weak-model`, reasoning effort, thinking-token budgets.

**Права/безопасность.** Гранулярной модели прав нет: подтверждения и `--yes`. Git-гигиена сильная: перед правками Aider коммитит preexisting dirty changes отдельно, чтобы не потерять работу пользователя. Аналитика opt-in, «never collects your code, chat messages, keys or personal info», `--analytics-disable`.

**Git/PR/checkpoints.** Лучшая в группе git-дисциплина: «Whenever aider edits a file, it commits those changes with a descriptive commit message»; `/undo`, `/diff`, `/commit`. PR-бота нет. Worktree нет.

**Наблюдаемые 2025–2026 изменения.** 0.77–0.86: GPT-5, Grok-4, Gemini 2.5, Claude Sonnet/Opus 4, o3-pro, Qwen3, DeepSeek; `/context`, `/clear`, `/undo`, commit-language, shell completions; расширение tree-sitter-языков; polyglot leaderboard обновлён 2025-11-20 (gpt-5 high — 88.0% correct, 91.6% well-formed, $29.08).

**Сильные стороны.** Минимализм и предсказуемость; repo map с реальным графом зависимостей и бюджетом токенов; автоматические git-коммиты и честный `/undo`; авто-линт и цикл исправлений; прозрачная стоимость; редактор-агностичность.

**Слабые стороны.** Нет MCP, субагентов, плагинов, hooks, skills, sandbox, параллелизма, remote/cloud; один репозиторий за раз; большие монорепо не оптимизированы; нет входной компакции; публичный release-процесс на GitHub отстаёт от PyPI (v0.86.0 vs 0.86.2).

**Do-not-copy.** (1) Отсутствие MCP/расширяемости — тупик для экосистемы. (2) Автокоммит каждой правки в основной ветке — спорная модель для команд; у нас уже есть snapshots/undo. (3) Python API «not officially supported» — не строить публичный контракт на необещанном API. (4) Один репозиторий за раз — не масштабируется на монорепо.

### 4.3 Amp (Sourcegraph → Amp Frontier Corporation)

**Позиционирование и статус.** «The frontier agent and development environment that lets you build from anywhere». 2025-05-15 Thorsten Ball анонсировал Amp как «the frontier agent» с VS Code extension и CLI. 2025-12-02 Amp объявил spin-out из Sourcegraph: «We're spinning out of Sourcegraph to become an independent research lab», «Amp is profitable». 2026-02-19 Amp заявил «The Coding Agent Is Dead» и **убил расширения VS Code/Cursor** («will self-destruct on March 5 at 8pm Pacific Time»), переведя пользователей на CLI. 2026-05-06 — rebuild «Codename: Neo»: «remote-controllable, compaction-first, plugin-powered»; 2026-05-27 суффикс Neo снят.

**Поверхности.** Web (ampcode.com, «needs no install»), native apps Mac/Windows/Linux/iPhone/iPad/Android, terminal CLI. IDE-расширений в текущей навигации docs нет; `amp --ide` остаётся мостом к VS Code/Neovim (доступ к текущему файлу, выделению, diagnostics). «Amp is the same agent and the same threads everywhere».

**Agent loop, автономия, планирование, субагенты.** Работа идёт в orb — «machines that Amp creates per thread». «Send a prompt, close your laptop, and the agent keeps working». Neo: «compaction-first», авто-компакция при 90% контекста, удалён handoff. Task tool делегирует работу в отдельный контекст; субагенты изолированы, «cannot talk to each other», выбираются автоматически в medium mode. Oracle (`@amp/oracle`) ревьюит и советует, но «never edits files». Custom agents через плагины: `amp.createAgent`, `registerTool`, `registerAgentMode`, до «spawn 25 custom worker agents». Agent-to-agent: агенты запускают агентов в orbs, локально или на других машинах, обмениваются сообщениями и файлами; у каждого свой контекст/workspace/orb. Spaces (2026-11-06) — «a conversation with a single agent whose job is to spawn and coordinate agents».

**Инструменты.** Built-ins (список через `amp tools list`), Task, Painter (генерация/редактирование изображений, до 3 reference images). В orb доступны terminal, browser, установка зависимостей, запуск приложения и E2E-тестирование. MCP: local stdio + remote, remote tools Allow/Ask First/Disabled; «Ask First» недоступен субагентам; workspace-серверы требуют explicit approval.

**Контекст/память/rules.** `AGENTS.md` по дереву до `$HOME`, subtree-файлы грузятся при чтении файла в поддереве; personal (`~/.config/amp/AGENTS.md`) и system (`/etc/ampcode/AGENTS.md`, `/Library/Application Support/ampcode/AGENTS.md`, `%ProgramData%\ampcode\AGENTS.md`); workspace guidance применяется до personal/repo, но не к субагентам, Puck и raw custom agents; fallback `AGENT.md`/`CLAUDE.md`; `AMP_IGNORE_GUIDANCE_FILES`. Компакция автоматическая при 90%; отдельного repo index нет, но есть Librarian (поиск по публичному и приватному GitHub) и Finder.

**Расширяемость.** Plugin API на TS/JS: события `session.start`, `agent.start`, `tool.call`, `tool.result`, `agent.end`, `changes.prompt`; `registerTool`, `registerCommand`, UI (notifications, confirmations, inputs, selects, panes/portals), `amp.ai.ask/decide`, `createAgent`/`registerAgentMode`. Skills — `SKILL.md` в `.agents/skills/`, `~/.config/agents/skills/`, `.claude/skills/`; `mcp.json` рядом со скиллом. Precedence плагинов: «project, system, personal, then workspace». Decision models (Jev по умолчанию или `openai/gpt-6-luna`) возвращают typed choice/probability/score и «never fall through» к другой модели.

**Модели/провайдеры.** Connections: API-ключи Anthropic/Google/Meta/OpenAI/xAI, подписки ChatGPT и X Premium+/SuperGrok, cloud Bedrock/Vertex/Foundry, routers OpenRouter/Vercel/Cloudflare/Ollama Cloud/OpenCode Go/custom URL (Chat Completions, Responses, Anthropic Messages, Google Generative AI). Fallback: personal → workspace → Amp, «first active one whose model mapping includes that model». The Dial: ultra = Claude Fable 5 + GPT-5.6 Sol oracle; high = GPT-5.6 Sol xhigh + Fable oracle; medium = Sol medium + Sol high oracle; low = GLM-5.2 + Sol oracle. BYOK без token fees кроме Enterprise.

**Права/безопасность.** Ключевая особенность: Amp «does not ask for approval» по умолчанию; контроль — через custom policy plugin, который админ может распространить на workspace. Sandbox локально не описан; изоляция достигается orb/runner. MCP-инструменты имеют Allow/Ask First/Disabled. Enterprise: SOC 2 Type II, SSO/Directory Sync через WorkOS, audit logs ≥30 дней, GCP US, TLS 1.2+/AES-256, secret redaction best-effort, no training unless opt-in, Minimal Data Retention.

**Git/PR/checkpoints.** `amp sync` зеркалит изменения orb в локальный checkout (нужен чистый checkout), `amp sync --apply` — разово. Коммиты/PR — через агента, не автоматика. Neo удалил file rollback при редактировании сообщений. Agentic review (2025-12-18) — отдельный review-агент на Gemini 3 Pro с pre-scan diff и actionable improvements.

**Remote/cloud/background.** Orbs: cloud sandbox на поток, billed by minute, спящий orb бесплатен, burst 20 orbs, далее 1 orb / 5 мин, файлы до 512 MB. Self-hosted orbs (2026-10-22): `amp orb provider`, Docker/E2B/Kubernetes/Apple containers/Modal/Vercel/Daytona/exe.dev. Boxes (2026-11-10): «always-on computer» для задеплоенных приложений, b1.tiny ~$18/мес, b1.small $30/30 дней, 100 GB трафика. Runners — свой compute бесплатно.

**Монетизация.** Hobby free (self-hosted orbs бесплатны, BYOK без token fees); Individual $20/мес; Teams без доплаты (pooled credits, SSO, shared BYOK/routing); Enterprise custom (SCIM, audit logs, pooled credits only); Education $10/мес. Amp Free (2025-10-15) с рекламой — «is paused», «We don't intend to bring it back».

**Наблюдаемые 2025–2026 изменения.** См. хронологию в таблице источников: Amp Free → Agents for the Agent → Librarian → Agentic Review → spin-out → Amp Labs → «The Coding Agent Is Dead» + удаление IDE-расширений → Neo rebuild → plugins everywhere → custom agents → orbs → The Dial → from agent to agent → subscriptions → iOS/macOS → free agent → self-hosted orbs → Android → Artifacts → Spaces → Boxes. Это самый быстрый темп продуктовых изменений в группе.

**Сильные стороны.** Реальная фоновая автономия (orb), а не «фоновый процесс на ноутбуке»; remote-controllable threads со всех устройств; зрелая модель connections/fallback; plugin API с событиями и UI; skills + MCP + decision models; продуманная enterprise-безопасность; честная экономика BYOK.

**Слабые стороны.** «No backward compatibility, no legacy features» — высокий churn для пользователей и экосистемы; permissions по умолчанию отсутствуют; sandbox только в orbs; удалены IDE-расширения и rollback; часть функций (Spaces, Puck) не имеют executor для плагинов; публичного changelog/telemetry-политики нет.

**Do-not-copy.** (1) «Не спрашивать разрешения по умолчанию» — недопустимо для нашего контура. (2) Удаление публичных расширений с self-destruct датой — разрушает доверие экосистемы. (3) «No backward compatibility» как принцип — несовместимо с нашим контрактом протокола и SDK. (4) Привязка части функций к orb-инфраструктуре без локального эквивалента.

### 4.4 Goose (Block → Agentic AI Foundation)

**Позиционирование и статус.** «Open source, extensible AI agent that goes beyond code suggestions — install, execute, edit, and test with any LLM». Apache-2.0, Rust, `aaif-goose/goose`, 56 441 stars, `pushed_at` 2026-11-11T04:26:36Z. С 2025-12-09 — часть Agentic AI Foundation при Linux Foundation, «vendor-neutral, community-governed», «600+ Contributors». Документация переехала с `block.github.io/goose` на `goose-docs.ai` (старый хост отдаёт «goose has moved»).

**Поверхности.** Native desktop macOS/Linux/Windows, CLI, API, GDK для встраивания агентов, ACP/Zed, terminal integration (`@goose`/`@g` из shell), remote `goose serve`. Мобильного и web-клиента нет.

**Agent loop, автономия, планирование, субагенты.** State-machine loop, вынесенный в GDK (Rust core, Python/Kotlin bindings, resume from persisted state). Режимы автономии: Completely Autonomous (default), Manual Approval, Smart Approval, Chat Only. Субагенты — «temporary, independent agent instances» с process isolation и context preservation; могут идти последовательно или параллельно; defaults: 5 concurrent, 1000 turns, 5-мин таймаут, inherited extensions, full-detail return; субагент не может спавнить субагентов и управлять расширениями/расписаниями. Custom agents — Markdown+YAML в `~/.agents/agents/` или `<project>/.agents/agents/`. Recipes — переиспользуемые workflow с Jinja-параметрами, `sub_recipes`, structured `response` и retry.

**Инструменты.** Developer extension (файлы/shell), Computer Controller, Analyze (Structure/Semantic/Focus, call graphs), Memory, Tutorial, Auto Visualiser, Skills, Summon, Apps, Chat Recall, Code Mode, Todo, Top of Mind. Всё расширение идёт через MCP: builtin, platform, stdio, streamable_http; SSE не поддерживается. Внешние расширения проходят malware-check перед активацией.

**Контекст/память/rules.** `.goosehints` глобальный (`~/.config/goose/.goosehints`) и локальный; локальные приоритетнее; hints идут в system prompt каждого запроса; `AGENTS.md` проверяется первым, затем `.goosehints`; `CONTEXT_FILE_NAMES` настраивает. Skills — `SKILL.md` в `~/.agents/skills/`, `.agents/skills/`, `~/.agents/plugins/<plugin>/`, legacy `.goose/skills/`, `.claude/skills/`. Память — Memory extension (MCP). Компакция существует (release notes v1.59.0: «Reword compaction prompt that Opus 5.5 refuses as distillation»), но отдельной страницы в docs не найдено. Кодовая база анализируется Analyze extension, а не постоянным индексом.

**Расширяемость.** Плагины = контейнер skills + hooks; `goose plugin install <git-url>`, форматы Open Plugins и Gemini extensions. Hooks: `hooks/hooks.json`, события SessionStart, SessionEnd, Stop, UserPromptSubmit, PreToolUse, PreToolUseResult, PostToolUse, PostToolUseFailure, BeforeReadFile, AfterFileEdit, BeforeShellExecution, AfterShellExecution; только PreToolUse блокирует вызов, Stop может блокировать завершение turn; `on_failure: block` доступен. MCP elicitation (форма с таймаутом 5 минут) и MCP roots. GDK — публичный runtime для встраивания.

**Модели/провайдеры.** 15+ провайдеров: Anthropic, OpenAI, Gemini, Bedrock, Azure OpenAI, OpenRouter, Groq, Mistral, xAI, GitHub Copilot, Ollama; custom OpenAI/Anthropic/Ollama-совместимые провайдеры в JSON. «Relies heavily on tool calling capabilities» и «currently works best with Claude 4 models». Ollama host `localhost:11434`, `OLLAMA_HOST`, `OLLAMA_CONTEXT_LENGTH`.

**Права/безопасность.** Четыре режима, granular tool permissions в Manual/Smart. Read/write классификация — «best effort» через LLM-провайдера. Allowlist MCP-серверов через `GOOSE_ALLOWLIST` (без переменной ограничений нет); v1.57.0 требует HTTPS и валидирует redirects, блокирует при policy failure. `goose serve` требует `GOOSE_SERVER__SECRET_KEY`; Desktop использует TOFU или pinning по `GOOSED_CERT_FINGERPRINT`. Terminal integration не записывает команды по умолчанию; `--dangerous-include-history` отправляет историю провайдеру. Roaming agents — экспериментальный P2P ACP, «effectively remote shell access», не входит в релизные бинарники.

**Git/PR/checkpoints.** Авто-коммитов и PR-интеграции нет; docs рекомендуют «commit early and often» и не подтверждают, что Goose коммитит/ветвится/создаёт PR. Checkpoints/undo не заявлены.

**Remote/cloud/background.** `goose serve` на VM с локальным Desktop-клиентом; `goose schedule add --cron` для автоматизации recipes; `goose run` headless с `--output-format text/json/stream-json`, `--max-turns`, `--max-tool-repetitions`; ACP server (`goose acp`) и HTTP/WS (`goose serve`).

**Telemetry/evals.** Opt-in anonymous metrics: OS/version/arch, версия и способ установки, provider/model, счётчики extension/tool, session metrics, широкие категории ошибок; исключает «your conversations, code, tool arguments, error messages, or any personal data». OTel export через `otel_exporter_otlp_endpoint`. Публичных evals/benchmark не найдено.

**Монетизация.** Публичного платного tier нет: Apache-2.0, установка и использование бесплатны, платите провайдеру. Pricing-страница отсутствует (404). Quickstart упоминает Tetrate Agent Router с «$10 in free credits» — это сторонний провайдер, не монетизация Goose.

**Наблюдаемые 2025–2026 изменения.** Передача в AAIF (2025-12-09). v1.51–v1.59 (сентябрь–ноябрь 2026): state-machine desktop routing, live voice, MCP Apps, subagents (v1.54–v1.56), удаление background subagents и orchestrator (v1.55), ProviderManager, Windows NSIS installer, context-window reporting, deferred MCP tools, ACP session filtering, subagent follow-ups. v1.57 — security-фокус (allowlist HTTPS/redirects, dependency advisories).

**Сильные стороны.** Самая открытая модель управления (фонд, vendor-neutral); MCP как единственный и последовательный механизм расширения; hooks с блокировкой PreToolUse; recipes с параметрами/подрецептами и cron; GDK для встраивания; 4 режима прав, включая Smart Approval; кроссплатформенный desktop + CLI с общей БД сессий; продуманная opt-in телеметрия.

**Слабые стороны.** Нет git-автоматики, PR-интеграции, checkpoints/undo; нет sandbox; read/write классификация «best effort» через LLM; allowlist по умолчанию выключен; roaming экспериментален и даёт «effectively remote shell access»; нет публичных evals; компакция и cost-tracking не документированы отдельными страницами; SSE не поддерживается.

**Do-not-copy.** (1) Allowlist MCP по умолчанию выключен — небезопасный default. (2) Классификация read/write через LLM — недетерминированная граница безопасности. (3) Roaming с «full control» и all-or-nothing `peers accept` — слишком грубая модель доверия. (4) Отсутствие git-дисциплины и undo — потеря контроля над изменениями.

## 5. Кандидатные рекомендации для ZCode (с Evidence)

Формат: рекомендация → доказательство у конкурента → что нужно проверить в ZCode (`mark: needs ZCode evidence`).

| # | Рекомендация | Evidence у конкурента | Что подтвердить в ZCode |
| --- | --- | --- | --- |
| R1 | Единая модель «permissions + hard policies» с managed-конфигом | OpenCode: ordered rules + policies «never prompt», managed settings/MDM, но settings сами не запрещают добавлять providers/MCP/plugins — нужны policies (https://opencode.ai/docs/policies/, https://opencode.ai/docs/config/) | `mark: needs ZCode evidence` — есть ли у нас hard-deny слой поверх allow/ask и managed/MDM-эквивалент; проверить `packages/shared/src/zcode-protocol/index.ts` и permission-сервисы |
| R2 | Lossy-компакция с явным сохранением objective/decisions/completed/blockers/next steps/files | OpenCode compaction: summary этих полей, `buffer` 15%, `keep.tokens` 15k (https://opencode.ai/docs/compaction/) | `mark: needs ZCode evidence` — сравнить с нашим `apps/zcode-cli/e2e/compact-microcompact` и `CompactBoundaryPayload`; проверить, сохраняем ли мы эти поля |
| R3 | Snapshots с undo/redo, отделённые от git-истории, с честным предупреждением о границах | OpenCode snapshots: internal Git ODB, `/undo`/`/redo`, лимит 2 MiB, «not a transaction or backup» (https://opencode.ai/docs/snapshots/) | `mark: needs ZCode evidence` — есть ли у нас аналог; проверить, как desktop `conversation revert` соотносится с файловым состоянием |
| R4 | Repo map с бюджетом токенов и графом зависимостей | Aider: tree-sitter `tags.scm` + graph ranking, `--map-tokens` 1k (https://aider.chat/docs/repomap.html, https://aider.chat/docs/languages.html) | `mark: needs ZCode evidence` — есть ли у нас repo map/embedded search; проверить `resolveRuntimeEmbeddedSearchEnabled` и CodeIndex-подобные механизмы |
| R5 | Hooks с блокирующим PreToolUse и наблюдательными PostToolUse | Goose hooks: 12 событий, PreToolUse блокирует, Stop блокирует завершение turn (https://goose-docs.ai/docs/guides/context-engineering/hooks.md); OpenCode hooks: tool `execute.before/after`, permission evaluation (https://opencode.ai/docs/build/plugins/server/) | `mark: needs ZCode evidence` — какие hook-точки уже есть в runtime и можно ли добавить блокировку без обхода permission-слоя |
| R6 | Плагинная экосистема с декларативными skills и MCP-конфигом рядом | Amp: `SKILL.md` + `mcp.json` рядом, precedence, `amp skill add` (https://ampcode.com/docs/customize/skills); Goose: plugins = skills + hooks (https://goose-docs.ai/docs/guides/context-engineering/plugins.md) | `mark: needs ZCode evidence` — у нас уже есть plugin marketplace и `SKILL.md`; проверить, можно ли связать skill с MCP-серверами декларативно |
| R7 | Headless/SDK-контур как первоклассный продукт | OpenCode: SDK + OpenAPI 3.1 «170 operations», `serve`, `run --format json` (https://opencode.ai/docs/sdk/, https://opencode.ai/docs/api); Goose GDK (https://goose-docs.ai/docs/gdk/index.md) | `mark: needs ZCode evidence` — какие наши протокольные методы уже стабильны и документированы; проверить `packages/shared/src/zcode-protocol/index.ts` |
| R8 | BYOK/routing с детерминированным fallback-порядком и видимой ценой | Amp: personal → workspace → Amp, priority 0, «anything no connection serves is served by Amp» (https://ampcode.com/docs/customize/model-routing); pricing orbs по минутам (https://ampcode.com/docs/orbs/sizes-and-costs) | `mark: needs ZCode evidence` — есть ли у нас явный fallback-порядок и отображение стоимости; проверить provider routing в `apps/zcode-cli/packages/adapters` |
| R9 | Opt-in анонимная телеметрия с явным перечнем исключений | Goose usage-data: только анонимные метрики, исключает conversations/code/tool arguments (https://goose-docs.ai/docs/guides/usage-data.md); Aider analytics (https://aider.chat/docs/more/analytics.html) | `mark: needs ZCode evidence` — что именно мы собираем и есть ли публичный перечень; проверить telemetry-слой |
| R10 | Recipes/параметризуемые workflow с cron и structured output | Goose recipes: Jinja-параметры, `sub_recipes`, `prompt` для headless, `goose schedule add --cron`, `--output-format stream-json` (https://goose-docs.ai/docs/guides/recipes/recipe-reference.md, https://goose-docs.ai/docs/guides/goose-cli-commands.md) | `mark: needs ZCode evidence` — есть ли у нас шаблоны задач/расписания; проверить, не дублирует ли это dynamic-workflows skill |

Отдельно: **не копировать** следующие паттерны (обоснование в разделах выше): shell без sandbox (OpenCode), permissions off by default (Amp), allowlist off by default (Goose), отсутствие MCP (Aider), «no backward compatibility» (Amp), self-destruct расширений (Amp), shell-инъекция вне permission flow (OpenCode), классификация read/write через LLM (Goose), roaming с full control (Goose).

## 6. Ограничения исследования и уверенность

1. **Только первичные источники.** Вторичные обзоры не использовались как основание. Там, где страница недоступна, стоит BLOCKED и `н/д`, без восстановления по памяти.
2. **Динамика продукта.** Amp и OpenCode меняются еженедельно; утверждения привязаны к дате 2026-11-11. Например, `anomalyco/opencode` имеет одновременно релизы v1.19.5 (2026-10-28) и v2.2.7 (2026-11-10), а сайт/README описывают V2-поведение.
3. **Aider: темп vs статус.** `pushed_at` 2026-05-22 и последний GitHub Release v0.86.0 (2025-08-09) при PyPI 0.86.2 (2026-02-12) — это факты; вывод о снижении темпа — интерпретация, не заявление о заброшенности.
4. **Goose: пробелы в docs.** Компакция, cost tracking, MCP Apps и enterprise-оффер не имеют доступных страниц; их наличие/отсутствие частично выводится из release notes и навигации. Это помечено `н/д`/BLOCKED, а не «подтверждено отсутствует».
5. **Amp: отсутствие публичных telemetry/changelog.** Политика данных подтверждена только страницей `/security` (маркетинговая), не privacy-политикой.
6. **OpenCode: нет privacy-страницы.** Утверждения о данных ограничены `/docs/console/models/` («hosted in the US and EU», zero-retention с исключениями).
7. **Уровень доказательности.** Все записи в таблице источников имеют статус `confirmed` (док/релиз/API), `marketing` (сайт/цены/security-страница) или `unverified` (не использовались как единственное основание). Матрица смешивает оба уровня; для решений о копировании нужна проверка на нашем коде (`needs ZCode evidence`).

## 7. Итог для ZCode

- **OpenCode** — ближайший архитектурный ориентир по permissions/policies, compaction и plugin/SDK-контуру; главный урок — жёсткий policy-слой поверх allow/ask и managed-конфиг, антиурок — shell без sandbox.
- **Aider** — ориентир по repo map с бюджетом токенов и по git-дисциплине (автокоммит + честный undo); антиурок — отсутствие расширяемости и один репозиторий за раз.
- **Amp** — ориентир по реальной фоновой автономии (orb), remote-controllable threads, connections/fallback и plugin API с событиями; антиуроки — permissions off by default, «no backward compatibility», удаление расширений.
- **Goose** — ориентир по MCP-first расширяемости, hooks с блокирующим PreToolUse, recipes/cron и GDK; антиуроки — allowlist off by default, LLM-классификация read/write, грубая модель доверия roaming.

Ни одна рекомендация не является готовым планом внедрения: каждая требует проверки на текущем коде ZCode (`mark: needs ZCode evidence`).
