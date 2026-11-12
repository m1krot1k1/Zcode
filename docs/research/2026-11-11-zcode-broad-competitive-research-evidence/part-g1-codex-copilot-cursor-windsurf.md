# Part G1 — Конкуренты: OpenAI Codex, GitHub Copilot (Workspace/Agent), Cursor, Windsurf/Devin Desktop

Дата доступа ко всем источникам: **2026-11-11T06:08:04Z — 2026-11-11T09:16:00Z** (UTC, получено командой `date -u +%Y-%m-%dT%H:%M:%SZ`).
Заявленная дата отчёта: 2026-11-11.

## 0. Baseline репозитория (зафиксирован до сбора данных)

| Параметр | Значение |
| --- | --- |
| Branch | `dev` |
| HEAD | `d10f0b69` (`Выпустить macOS Preview 3.17.102.`) |
| Предыдущие коммиты | `bbb756e8`, `fc70a81b`, `982e30c9`, `05bd5b31` |
| `git status --porcelain` до записи | пусто |
| Изменения production-кода/конфигов/зависимостей | отсутствуют |
| Коммиты/установки | отсутствуют |

Соблюдены ограничения: research-only, единственная запись — этот файл. Каталог `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/` создан заново (до этого не существовал); в нём уже лежали файлы параллельных ветвей (`part-c`, `part-d`, `part-e`, `part-f`, `part-g3`), они не изменялись.

Навык `research` загружен через `Skill` до начала анализа (процедура: primary sources → цитирование → разделение FACT/HYPOTHESIS/UNKNOWN → запись артефакта).

## 1. Метод, границы, соглашения о статусах

- Использованы только первичные источники: официальные домены документации (`learn.chatgpt.com`, `docs.github.com`, `cursor.com/docs`, `docs.devin.ai`, `cognition.com`), официальные GitHub-репозитории/релизы/API, официальные блоги (`github.blog`, `cursor.com/blog`).
- Вторичные обзоры не использовались ни как единственная, ни как основная опора.
- Статусы:
  - `confirmed` — утверждение прямо присутствует в проверенном первичном тексте (док, README, релиз, changelog).
  - `marketing` — утверждение с официального маркетингового лендинга/страницы тарифов; фиксируется как заявление вендора, а не как проверенная механика.
  - `unverified` — источник доступен, но не подтверждает утверждение (например, страница существует, но нужного текста в извлечённом содержимом нет).
- Отдельно помечено `BLOCKED` — страница недоступна; содержимое не восстанавливалось по памяти.
- Единая оговорка: страницы документации быстро меняются. Все цитаты действительны на дату доступа; версии продуктов указаны там, где они были в источнике.

## 2. Проверка идентичности продуктов (identity checks)

Задача требует явно отделить одноимённые/переименованные продукты. Проверки:

| Проверка | Установленный факт | Источник | Статус |
| --- | --- | --- | --- |
| Codex = OpenAI Codex CLI | «Codex CLI is a coding agent from OpenAI that runs locally on your computer»; Apache-2.0; 134 817 stars; 27 115 открытых issues | https://github.com/openai/codex ; `gh api repos/openai/codex` | confirmed |
| Codex Cloud / Codex Web | README: «If you are looking for the *cloud-based agent* from OpenAI, **Codex Web**, go to chatgpt.com/codex»; отдельная страница «Codex Cloud» | https://github.com/openai/codex ; https://learn.chatgpt.com/codex/cloud | confirmed |
| Copilot Workspace ≠ Copilot coding agent | Workspace — проект GitHub Next, карточка помечена «Completed»; последняя запись changelog — 2025-02-28; актуальная документация Workspace отсутствует (все проверенные пути 404) | https://githubnext.com/projects ; https://github.blog/changelog/2025-02-28-copilot-workspace-showing-quota-limits-issues-in-dashboard-and-ux-improvements/ | confirmed (отсутствие доков), статус вывода Workspace — unverified |
| Copilot «в облаке» = преемник cloud agent | Док: «Starting October 28, 2026, the new Copilot in the cloud experience on GitHub.com and GitHub Mobile is available to users with a paid Copilot plan»; сравнивается с «older Copilot cloud agent plus Copilot Chat experience» | https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent | confirmed |
| Cursor = Anysphere, с 2026-08-14 внутри SpaceX | «Cursor has officially been acquired by SpaceX» (Aug 14, 2026); футер сайта «© 2026 Anysphere, Inc.»; тарифы продаются через «X Subscription Corp.» | https://cursor.com/blog/joining-spacex ; https://cursor.com/pricing | confirmed |
| Cursor ≠ xAI-продукт по бренду | Док прямо не заявляет аффилиацию с xAI; модели Grok лицензируются как Cursor-модели, «Jointly trained by Cursor and SpaceXAI» | https://cursor.com/docs/models-and-pricing.md ; https://cursor.com/pricing | confirmed (отсутствие заявления об аффилиации), атрибуция — частично unverified |
| Windsurf → Devin Desktop | «On June 2, 2026, Windsurf is becoming Devin Desktop»; «Devin Desktop is the new name for Windsurf. It's the same IDE, same editor, and has the same features, but unified under the Devin brand»; тарифы не меняются | https://docs.devin.ai/desktop/devin-desktop-faq.md | confirmed |
| Windsurf принадлежит Cognition | «Cognition has signed a definitive agreement to acquire Windsurf, the agentic IDE» (July 14, 2025) | https://cognition.com/blog/windsurf | confirmed |
| Cascade больше не основной агент | «Cascade is the legacy agent in Devin Desktop»; новые сессии идут в Devin Local | https://docs.devin.ai/desktop/cascade/cascade | confirmed |
| Редиректы домена | `windsurf.com` → `devin.ai/desktop` (308); `windsurf.com/pricing` → `devin.ai/pricing` (308); `docs.windsurf.com` → `docs.devin.ai` (307); `windsurf.com/blog` → `devin.ai/blog` (308) | наблюдение при fetch | confirmed |

Ключевой вывод по идентичности: **Copilot Workspace как отдельный продукт больше не документируется; его функцию занял Copilot cloud agent / «Copilot in the cloud»**. Формального публичного объявления о выводе Workspace из эксплуатации в проверенных первичных источниках найти не удалось — это фиксируется как `unverified`, а не как факт. **Windsurf следует читать как Devin Desktop (Cognition), а Cascade — как legacy-агент**. **Cursor — продукт Anysphere, приобретённый SpaceX, с собственным модельным семейством Grok/Composer.**

## 3. Таблица источников

Все URL первичные. Дата доступа — 2026-11-11 (UTC).

| URL | Дата доступа | Статус | Подтверждаемое утверждение |
| --- | --- | --- | --- |
| https://github.com/openai/codex | 2026-11-11 | confirmed | Codex CLI — локальный кодинг-агент; Apache-2.0; установка macOS/Linux/Windows; `npm i -g @openai/codex`, Homebrew cask, release-бинари |
| https://github.com/openai/codex/releases | 2026-11-11 | confirmed | `rust-v0.167.1` (2026-11-10), `rust-v0.169.0-alpha.10` (2026-11-11); 0.167.0 (2026-11-06): agent command center, переключение backend, локальные превью изображений, Vertex AI sign-in, system proxy (experimental), inline patch review в approvals, улучшения context compaction |
| https://learn.chatgpt.com/docs | 2026-11-11 | confirmed | Поверхности Codex: ChatGPT desktop app, mobile app, web, Codex CLI, IDE extension, Codex Cloud; расширения: MCP, configuration, SDK, changelog, scheduled tasks, code review |
| https://learn.chatgpt.com/docs/codex/cli | 2026-11-11 | confirmed | Слэш-команды `/init`, `/status`, `/permissions`, `/model`, `/review`; `codex exec` для CI; `codex resume`, `--image`, `--search`, `codex cloud`, `codex mcp`, `codex completion`; `/permissions` задаёт «the boundaries for each run» |
| https://learn.chatgpt.com/codex/sandbox | 2026-11-11 | confirmed | `sandbox_mode`: `read-only` / `workspace-write` / `danger-full-access`; `approval_policy`: `on-request` / `never` / `granular` (subkeys `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`); `untrusted` выведен; macOS Seatbelt через `sandbox-exec`; Linux `bwrap plus seccomp`, `landlock` как alias; Windows `MXC` + elevated/unelevated fallback, WSL2 — Linux sandbox; сеть выключена по умолчанию, `network_access = true`, `network_proxy` off by default, `allow_local_binding = false` |
| https://learn.chatgpt.com/codex/config-file/config-reference | 2026-11-11 | confirmed | Ключи `model`, `model_provider` (default `openai`), `model_reasoning_effort`, `model_context_window`, `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope` (`total`/`body_after_prefix`), `model_instructions_file`; `model_providers.<id>` c `base_url`, `wire_api` (только `responses`), `env_key`, `auth.command`, `requires_openai_auth`, `capabilities.external_web_access`/`remote_compaction`; зарезервированные provider id `openai`, `ollama`, `lmstudio`; `oss_provider`; профили `$CODEX_HOME/<profile>.config.toml`; project-local не может переопределять `model_provider`, `model_providers`, `openai_base_url`, `chatgpt_base_url`, `profile`, `profiles`, `otel`, `notify` |
| https://learn.chatgpt.com/codex/guides/agents-md | 2026-11-11 | confirmed | `AGENTS.md` читается до начала работы; глобально `AGENTS.override.md` → `AGENTS.md` (только первый непустой); проект — от корня к cwd, порядок `AGENTS.override.md`, `AGENTS.md`, fallback-имена; файлы конкатенируются, ближайший переопределяет; `project_doc_max_bytes` = 32 KiB по умолчанию |
| https://learn.chatgpt.com/codex/extend/mcp | 2026-11-11 | confirmed | MCP: STDIO и Streamable HTTP; `~/.codex/config.toml` или `.codex/config.toml` для trusted-проектов; `[mcp_servers.<name>]` с `command`/`args`/`env`/`env_vars`/`cwd` либо `url`/`auth`/`bearer_token_env_var`/`http_headers`/`env_http_headers`; `codex mcp add/list/login` |
| https://learn.chatgpt.com/codex/skills | 2026-11-11 | confirmed | Skills: папка с `SKILL.md` (YAML `name`, `description`) + `scripts/`, `references/`, `assets/`, `agents/openai.yaml`; progressive disclosure; пути `.agents/skills` (cwd, родители, корень репо), `$HOME/.agents/skills`, `/etc/codex/skills`, bundled; вызов `/skills` или `$` в Codex, `@` в ChatGPT; дубликаты не мержатся |
| https://learn.chatgpt.com/codex/hooks | 2026-11-11 | confirmed | Хуки: `SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreModelRequest`, `PostModelRequest`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd`; `hooks.json` или `[hooks]` в `config.toml`; handlers `command` и `mcp_tool`; `PreToolUse` может deny/rewrite, `PermissionRequest` approve/deny, `UserPromptSubmit` block, `PreCompact`/`PostCompact` остановить компакцию, `PostToolUse` заменить результат; требует trust review; отключается `[features] hooks = false` |
| https://learn.chatgpt.com/codex/subagents | 2026-11-11 | confirmed | Subagents: «Subagent workflow» с параллельными потоками; встроенные `default`, `worker`, `explorer`; кастомные TOML в `~/.codex/agents/` или `.codex/agents/` (`name`, `description`, `developer_instructions`); `/subagents`; лимит `agents.max_concurrent_threads_per_session`; `agents.enabled`; наследуют sandbox/approval/permissions родителя и не могут их переопределять |
| https://learn.chatgpt.com/docs/agent-configuration/rules.md | 2026-11-11 | confirmed | Rules (experimental): Starlark `prefix_rule(pattern, decision, justification, match, not_match)` в `rules/` рядом с config layer, например `~/.codex/rules/default.rules`; `decision = "prompt"` |
| https://learn.chatgpt.com/docs/environments/git-worktrees.md | 2026-11-11 | confirmed | Worktrees: несколько независимых чатов в одном проекте; `Local checkout` / `Worktree` / `Handoff`; scheduled tasks на выделенных background worktree; на телефоне worktree не запускается — телефон управляет подключённым компьютером |
| https://learn.chatgpt.com/docs/skills-and-plugins.md | 2026-11-11 | confirmed | Plugin — installable bundle из skills и MCP-серверов, опционально lifecycle hooks для Codex runtime; skill может включать инструкции, ресурсы, шаблоны |
| https://learn.chatgpt.com/docs/customization/overview.md | 2026-11-11 | confirmed | Слои кастомизации: `AGENTS.md`, Memories, Skills, MCP, Subagents; «`AGENTS.md` shapes behavior, memories carry local context forward» |
| https://learn.chatgpt.com/docs/customization/memories.md | 2026-11-11 | confirmed | Memories: локальные Codex-клиенты используют отдельное local memory store; `/memories`; Settings > Personalization: «Enable Codex memories», «Allow memories from tool-assisted chats», «Delete Codex memories»; правило хранить обязательные инструкции в `AGENTS.md` |
| https://learn.chatgpt.com/codex/code-review | 2026-11-11 | confirmed | Code review: PR в desktop-плагине (Summary/Changes, Review with Codex); «GitHub code review is generally available»; GitLab MR — preview; автоматические ревью через connector; `/review` по локальному checkout; `review_model`; `chatgpt.reviewDelivery = "detached"` |
| https://learn.chatgpt.com/codex/automations | 2026-11-11 | confirmed | Scheduled tasks: расписание (включая RFC 5545 recurrence) и события Gmail/Slack/GitHub на web/mobile; standalone или внутри чата; desktop-задачи требуют включённого компьютера; в CLI/IDE нет UI управления; event-триггеры недоступны в desktop/CLI/IDE |
| https://learn.chatgpt.com/codex/cloud | 2026-11-11 | confirmed | Codex Cloud: «Each task has its own workspace and can keep working while your computer is asleep»; окружения с репозиториями, install script, network access, HTTP secrets, env vars, OIDC, VPN; GitHub или GitLab; commit или open PR |
| https://learn.chatgpt.com/codex/ide | 2026-11-11 | confirmed | IDE: VS Code и совместимые (Cursor, Windsurf, Insiders), Xcode и JetBrains — собственные интеграции; open files/selection/recent chats; focused diff; handoff в Codex web |
| https://learn.chatgpt.com/codex/app | 2026-11-11 | confirmed | Desktop app: «Run projects in parallel, work with files, use your computer, and keep long-running work moving from one desktop workspace»; выбор ChatGPT или Codex |
| https://learn.chatgpt.com/codex/mobile | 2026-11-11 | confirmed | Mobile: запуск Cloud или connected computer + project; approve actions; просмотр diffs и test results; «Use the ChatGPT mobile app with Cloud or a connected Mac or Windows PC» |
| https://learn.chatgpt.com/docs/codex-sdk.md | 2026-11-11 | confirmed | Codex SDK: TypeScript `@openai/codex-sdk`, Node.js 18+, start/continue/resume локальных thread; app-server для кастомных клиентов; `codex mcp-server` удалён |
| https://learn.chatgpt.com/docs/app-server.md | 2026-11-11 | confirmed | Codex app-server — интерфейс для rich clients (например, VS Code extension): auth, история, approvals, streamed events; open source в `openai/codex/codex-rs/app-server`; remote TUI через `codex app-server --listen ws://…` |
| https://learn.chatgpt.com/docs/sandboxing/auto-review.md | 2026-11-11 | confirmed | Auto-review: «sends eligible approval requests to a separate reviewer agent»; работает только при `on-request` или granular; в desktop «Approve for me» |
| https://learn.chatgpt.com/docs/enterprise/workspace-analytics.md | 2026-11-11 | confirmed | Аналитика: ChatGPT workspace analytics, Codex analytics dashboard (`admin.openai.com/analytics/codex`), Analytics API, Compliance API; поверхности не выдают доступ и не задают политику |
| https://learn.chatgpt.com/docs/pricing.md | 2026-11-11 | confirmed | «ChatGPT Work and Codex are included in your ChatGPT Free, Go, Plus, Pro, Business, Edu, or Enterprise plan»; «ChatGPT Work and Codex share usage»; Free $0, Go $8, Plus $20, Pro от $100, Business $25/user/mo (annual; $30 monthly), Enterprise/Edu — contact sales; API Key — только CLI/SDK/IDE без cloud-функций |
| https://learn.chatgpt.com/codex/pricing | 2026-11-11 | confirmed | Plus включает Codex в web, CLI, IDE extension и iOS + cloud-интеграции (automatic code review, Slack); «Flexibly extend usage with ChatGPT credits» |
| https://chatgpt.com/pricing | 2026-11-11 | confirmed | Доступность Codex по планам: Free — «Limited», Go — «Limited», Plus — «Yes», Pro — «Expanded» |
| https://learn.chatgpt.com/docs/feature-maturity.md | 2026-11-11 | confirmed | Уровни зрелости: Under development / Experimental / Beta / Stable / Deprecated; конкретные фичи на странице не размечены |
| https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent | 2026-11-11 | confirmed | Copilot на GitHub.com/Mobile: plan, changes, review PR, automate tasks; среда — «a cloud sandbox, a GitHub Actions runner, or a remote custom environment»; «can only work on one branch at a time», «can open one pull request per task»; Actions-сессия ≤ 59 минут; Actions-сессия меняет только один репозиторий, cloud sandbox — несколько; только GitHub-репозитории |
| https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent | 2026-11-11 | confirmed | Старт задач: issue, PR-комментарий, Agents UI, IDE/MCP, GitHub CLI, Mobile, API, Raycast; «Copilot in the cloud» с 2026-10-28 на платных планах; continuous session между web/mobile/app/IDE/CLI; компоненты client/session/environment |
| https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli | 2026-11-11 | confirmed | Copilot CLI доступен на всех планах Copilot (при включённой org-политике); Linux/macOS/Windows PowerShell/WSL; interactive и programmatic; sandboxed local servers |
| https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference | 2026-11-11 | confirmed | `copilot`, `copilot app`, `copilot completion`, `copilot config`, `copilot init`, `copilot mcp`, `copilot memories import`, `copilot plugin`, `copilot instruction`, `copilot lsp`, `copilot sandbox`; permission patterns `Kind(argument)` для `read`/`write`/`shell`/`url`/`memory`/`MCP-server`; deny > allow; `~/.copilot/mcp-config.json`; skills `SKILL.md`; hooks; OTel off by default (`COPILOT_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `COPILOT_OTEL_FILE_EXPORTER_PATH`) |
| https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/understanding-local-sandboxing | 2026-11-11 | confirmed | Local sandboxing: OS-level sandbox, filesystem policy read/write/none, автоматическая сборка политики, enterprise-managed policies |
| https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment | 2026-11-11 | confirmed | Custom environment: Linux machine/codespace; `.github/workflows/copilot-setup-steps.yml` с job `copilot-setup-steps`, должен быть на default branch; только Ubuntu x64 / Windows 64-bit runners; firewall несовместим с self-hosted runners и Windows |
| https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions | 2026-11-11 | confirmed | Инструкции: `.github/copilot-instructions.md`; `.github/instructions/NAME.instructions.md` с `applyTo` (path-specific только для cloud agent и code review); `AGENTS.md` в любом месте репо, ближайший выигрывает; один корневой `CLAUDE.md`/`GEMINI.md`; приоритет personal → repository → organization, но передаются все |
| https://docs.github.com/en/copilot/concepts/context/mcp | 2026-11-11 | confirmed | MCP: до 50 серверов суммарно personal + repo; секреты с префиксом `COPILOT_MCP_`; personal — только key-based auth и только cloud sandbox; repo-level переопределяет personal при коллизии имён; по умолчанию для cloud agent подключены GitHub MCP server и Playwright MCP; cloud agent и code review поддерживают только MCP tools; политика «MCP servers in Copilot» off by default и только для Business/Enterprise |
| https://docs.github.com/en/copilot/concepts/customizations/custom-agents | 2026-11-11 | confirmed | Custom agents: Markdown + YAML frontmatter, описание роли, инструкции, ограничение инструментов, MCP-серверы; уровни repo/org/enterprise, personal в CLI; доступны в Copilot app, CLI, cloud agent (agents tab/panel, issue assignment, PR), IDE; встроенные агенты CLI: `explore`, `task`, `general-purpose`, `code-review`, `research`, `rubber-duck`, `security-review`; subagent = отдельный context window, параллельность |
| https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory | 2026-11-11 | confirmed | Copilot Memory: repository-level facts (shared с коллегами) и user-level preferences (переносятся между репозиториями); доступно на всех платных планах |
| https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-github-copilot-agents | 2026-11-11 | confirmed | Уровни автономности: collaborative session, asynchronous session, automated workflow; «you remain responsible for defining the goal and constraints, granting appropriate access, and reviewing the agent's work» |
| https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/delegating-and-parallelizing-work-with-agents | 2026-11-11 | confirmed | `/fleet` в Copilot app и CLI: orchestrator разбивает цель, назначает subagent'ам, запускает независимые задачи параллельно, сводит результаты |
| https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/autopilot | 2026-11-11 | confirmed | Autopilot mode: агент пишет код, запускает тесты, оценивает результат и итерирует без ожидания пользователя после каждого шага; доступен в Copilot CLI и Copilot app |
| https://docs.github.com/en/copilot/reference/hooks-reference | 2026-11-11 | confirmed | Hooks в Copilot CLI и Copilot in the cloud: `preToolUse`, `postToolUse`, `agentStop`, `subagentStop`, `permissionRequest`, `notification`; decision control; matcher filtering; exit codes; disable all hooks |
| https://docs.github.com/en/copilot/reference/copilot-feature-matrix | 2026-11-11 | confirmed | Матрица по IDE: Workspace indexing — ✓ в VS Code/Visual Studio/JetBrains/Eclipse, ✗ в Xcode/Neovim; Checkpoints — ✓ в VS Code/Visual Studio/JetBrains/Xcode, ✗ в Eclipse/Neovim; BYOK — P/✓; Agent skills — ✓ в VS Code/Visual Studio, P в JetBrains; матрица «in public preview» |
| https://docs.github.com/en/copilot/get-started/plans | 2026-11-11 | confirmed | Тарифы: Free, Student, Pro $10/mo (1 500 credits), Pro+ $39/mo (7 000), Max $100/mo (20 000), Business $19/seat/mo (1 900), Enterprise $39/seat/mo (3 900), Copilot access $0 для GHE Cloud / $10 standalone; «Copilot in the cloud» не входит в Free; метрика — GitHub AI Credits |
| https://docs.github.com/en/copilot/reference/ai-models/supported-models | 2026-11-11 | confirmed | Мультивендорный набор моделей; Auto model selection; разделы «Fallback and long-term support (LTS) models», «Evaluation models», «Utility models», «Model retirement history» |
| https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ | 2026-11-11 | confirmed | 2025-05-19: coding agent стартует по назначению issue или промпту в VS Code; окружение на GitHub Actions; пушит коммиты в draft PR; PR требует human approval до запуска CI/CD |
| https://github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/ | 2026-11-11 | confirmed | 2026-06-02: GitHub Copilot app — «agent-native desktop experience», доступен на Pro/Pro+/Business/Enterprise; мотив — «most developer tools were not designed for directing multiple agents in parallel» |
| https://github.blog/changelog/2026-11-06-github-copilot-weekly-releases-november-2/ | 2026-11-11 | confirmed | Copilot app: Agent Merge, компакция диалога при достижении контекстного лимита, assisted approval personal instructions; Copilot CLI: `/settings` как единый dashboard для plugins/MCP |
| https://github.blog/changelog/2026-11-03-byok-and-enterprise-custom-models-in-the-copilot-usage-api/ | 2026-11-11 | confirmed | Usage API разделяет Local BYOK (`used_local_byok`, `totals_by_local_byok`) и enterprise custom models (`is_custom_enterprise_model`); Local BYOK — запросы идут напрямую к ключу разработчика или локальной модели из Copilot CLI / Copilot app |
| https://github.blog/changelog/label/copilot/ | 2026-11-11 | confirmed | Октябрь–ноябрь 2026: «GitHub Agentic Workflows generally available» (10-28), «Agent Merge» (10-28), «Dynamic workflows in Copilot CLI and the Copilot app» (10-01), «Discover local models in GitHub Copilot CLI» (10-07) |
| https://githubnext.com/projects | 2026-11-11 | confirmed | Карточка «Copilot Workspace — An agentic dev environment, designed for everyday tasks», бейдж «Completed», дата Apr 2024 |
| https://githubnext.com/projects/copilot-workspace | 2026-11-11 | unverified | Страница отдаёт 200, но извлечённый текст содержит только заголовок «Copilot Workspace»; статус/даты отсутствуют |
| https://github.blog/changelog/2025-02-28-copilot-workspace-showing-quota-limits-issues-in-dashboard-and-ux-improvements/ | 2026-11-11 | confirmed | Последняя найденная запись changelog по Workspace (2025-02-28): индикатор квот, список issues на dashboard, UX-правки |
| https://cursor.com/docs | 2026-11-11 | confirmed | Позиционирование: «a coding agent for building ambitious software»; разделы Understand your code, Plan and build features, Find and fix bugs, Review changes, Customize Cursor, Connect your workflow; кастомизация «plugins, skills, MCPs, and rules from one place» |
| https://cursor.com/docs/agent/overview.md | 2026-11-11 | confirmed | Agent = Instructions + Tools + Model, тюнинг под каждую модель; «There is no limit on the number of tool calls Agent can make during a task»; инструменты: поиск файлов, web, fetch rules, чтение файлов (включая изображения), редактирование, shell, browser; Projects — coordinator делегирует другим агентам; Checkpoints — автоснапшоты изменённых файлов, restore возвращает файлы, но не сообщения, хранятся локально отдельно от Git; queued messages + steering на следующем tool call; side chats; `/goal`, `/loop` |
| https://cursor.com/docs/agent/plan-mode | 2026-11-11 | confirmed | Plan Mode: уточняющие вопросы, исследование кодовой базы, план на ревью, редактирование плана, затем build; «Save to workspace»; переключение через mode picker или Shift+Tab |
| https://cursor.com/docs/context/rules | 2026-11-11 | confirmed | Rules: `.cursor/rules/*.mdc` (plain `.md` игнорируется), типы `Always Apply`, `Apply Intelligently`, `Apply to Specific Files`, `Apply Manually`; Project/User/Team Rules; `AGENTS.md` с вложенным слиянием; приоритет Team → Project → User; «Large language models don't retain memory between completions» |
| https://cursor.com/docs/context/codebase-indexing | 2026-11-11 | confirmed | Поиск: «Instant Grep» запускается автоматически, без конфигурации, full regex + word-boundary; индекс строится и запрашивается на машине; «does not store embeddings of your codebase for search»; «does not upload file paths or code to build a search index»; содержимое файла может попасть в model request при открытии матча |
| https://cursor.com/docs/cloud-agents | 2026-11-11 | confirmed | «Cloud Agents were formerly called Background Agents»; изолированные VM с полным dev-окружением (repos, dependencies, secrets, startup commands, network); «You can run as many agents as you want in parallel»; не требуют локальной машины онлайн; multi-repo; доступны Premium+, Teams, Enterprise, legacy paid; spend limit |
| https://cursor.com/docs/cloud-agent/capabilities | 2026-11-11 | confirmed | Cloud agent: полный desktop, mouse/keyboard и browser control, «take control of the agent's remote desktop»; dev servers, click-through UI flows; MCP (HTTP-серверы проксируются через backend, stdio — в VM); short-lived OIDC JWT; подписка на события с пробуждением; artifacts (screenshots/videos/logs) в PR; авто-починка CI (только GitHub Actions) |
| https://cursor.com/docs/cloud-agent/mobile.md | 2026-11-11 | confirmed | Cursor for iOS: управление cloud и local-агентами, real-time follow, review/merge PR; iPhone/iPad iOS 26+, English; Android planned; доступно на Premium/Super/Ultra/Teams/Enterprise и legacy Start/Pro/Pro+/Ultra |
| https://cursor.com/docs/cloud-agent/self-hosted.md | 2026-11-11 | confirmed | Self-Hosted Machines: Cursor выполняет agent loop, inference и planning; worker клиента — file edits, terminal, computer-use и локальные MCP |
| https://cursor.com/docs/cloud-agent/automations.md | 2026-11-11 | confirmed | Automations: cloud agents по расписанию или событиям GitHub, GitLab, Slack, webhooks, Linear; создание через Agents Window, cursor.com/automations, `/automate` |
| https://cursor.com/docs/cli/overview | 2026-11-11 | confirmed | CLI `agent`: interactive и print mode `-p`; режимы Agent/Plan/Ask (`--mode`); `--output-format text`; cloud handoff через `&`; `--sandbox enabled|disabled` |
| https://cursor.com/docs/agent/tools/terminal.md | 2026-11-11 | confirmed | Terminal: Run Mode определяет, когда команда выполняется, спрашивает или уходит в sandbox; sandbox блокирует «unauthorized file access and network activity»; `sandbox.json`; `CURSOR_AGENT` env |
| https://cursor.com/docs/agent/tools/browser.md | 2026-11-11 | confirmed | Browser: нативный инструмент без внешней установки; console logs и network traffic; логи в файлы, которые агент grep'ает; скриншоты как изображения; определение dev server и портов; enterprise — MCP allowlist/denylist |
| https://cursor.com/docs/agent/security/run-modes.md | 2026-11-11 | confirmed | Run Modes: Auto-review (allowlist + sandbox + classifier), Allowlist, Run Everything; Settings > Agents > Approvals & Execution |
| https://cursor.com/docs/context/mcp | 2026-11-11 | confirmed | MCP: `.cursor/mcp.json` (project) и `~/.cursor/mcp.json` (global); транспорты `stdio`, `SSE`, `Streamable HTTP`; approval перед MCP tools по умолчанию; `envFile` только для STDIO; remote URL ограничен configured pattern |
| https://cursor.com/docs/agent/hooks | 2026-11-11 | confirmed | Hooks: `hooks.json` project/user; agent hooks (`sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`), Tab hooks, app lifecycle `workspaceOpen`; типы `command` и `prompt`; `timeout`, `loop_limit`, `failClosed`, `matcher`; merge priority Enterprise → Team → Project → User, plugins после; cloud agents — только command-based hooks из repo |
| https://cursor.com/docs/plugins | 2026-11-11 | confirmed | Plugins: bundle Rules, Skills, Agents, Commands, MCP Servers, Hooks; форматы Agent Plugins (`plugin.json`) и Cursor Plugins (`.cursor-plugin/plugin.json`); Cursor Marketplace + cursor.directory; team marketplaces Default Off/On/Required; skills вызываются `/skill-name`; встроенные `/automate`, `/autopilot`, `/canvas`, `/create-hook`, `/create-rule`, `/create-skill` |
| https://cursor.com/docs/subagents.md | 2026-11-11 | confirmed | Subagents: свой context window, foreground/background, параллельный запуск, кастомные prompt/tool/model; встроенные `Explore` и второй контекстный subagent; доступны в editor, CLI и Cloud Agents |
| https://cursor.com/docs/skills.md | 2026-11-11 | confirmed | Agent Skills как открытый стандарт: портируемые, версионируемые, progressive disclosure; автообнаружение при старте; ручной вызов через `/`; закрепление на сессию через Custom Modes (Option/Alt+Enter) |
| https://cursor.com/docs/agent/agents-window.md | 2026-11-11 | confirmed | Agents Window: agent-first интерфейс, multi-workspace, новый diffs view с commit/PR, parallel agents в cloud, remote SSH; переключение в IDE |
| https://cursor.com/docs/agent-sdk | 2026-11-11 | confirmed | Agent SDK: Markdown + TypeScript, prompts `.md`/`.ts`, deterministic code hooks, evals как версионируемые файлы, деплой Cursor-managed или self-hosted, триггеры source control / issue tracker / Slack |
| https://cursor.com/docs/agent-sdk/reference/evals.md | 2026-11-11 | confirmed | Evals: файлы `evals/**/*.eval.ts|js`, `defineEval` с `test` или `cases`, `iterations` 1–100 |
| https://cursor.com/docs/agent-sdk/reference/memory.md | 2026-11-11 | confirmed | Memory в Agent SDK: hook добавляет запись за turn в `memory/journal.jsonl`; модель читает журнал файловыми инструментами; recall-tool отсутствует, записи трактуются как untrusted history |
| https://cursor.com/docs/enterprise/opentelemetry-export.md | 2026-11-11 | confirmed | OTel Export (Enterprise): OTLP/HTTP protobuf на `/v1/metrics` и `/v1/logs`; метрики (tokens, tool calls, best-effort cost) и логи (API requests, errors, corrections, skills, hooks, plugins, cloud agent lifecycle); opt-in conversation content и MCP tool I/O; export server-side |
| https://cursor.com/docs/models-and-pricing.md | 2026-11-11 | confirmed | Cursor-модели: Grok 4.7/4.6/4.5, Composer 2.5; сторонние — Claude, GPT, Gemini по API list price с prepaid credit; Grok «Jointly trained by Cursor and SpaceXAI»; единый недельный pool, общий для editor/CLI/Cloud Agents/Grok Bot |
| https://cursor.com/pricing | 2026-11-11 | confirmed | Free $0; Plus $8 (только Grok-модели, без third-party, без BYOK, без cloud agents); Premium $30 (4x Plus, cloud agents & automations, third-party по list price, Bugbot); Super $100 (15x); Ultra $200 (50x); Teams $30+/user; Enterprise custom |
| https://cursor.com/help/models-and-usage/api-keys.md | 2026-11-11 | confirmed | BYOK: OpenAI (standard non-reasoning), Anthropic (все Claude), Google Gemini, Azure OpenAI, AWS Bedrock; «Custom API keys only work with chat models», Tab — встроенные модели; ключ не хранится на серверах, но отправляется с каждым запросом |
| https://cursor.com/changelog | 2026-11-11 | confirmed | Nov 6 2026 Voice Chat with Agents (Grok Voice, Agents Window/IDE/web/iOS); Nov 5 2026 Build Live Apps in Cursor (cloud agents + Postgres + deploy); Oct 20 2026 Agent SDK; Oct 16 2026 Cloud Agent Canvases + Environments API beta (300 repos); Oct 13 2026 Origin App Marketplace (20+ integrations) |
| https://cursor.com/blog/joining-spacex | 2026-11-11 | confirmed | Aug 14 2026: «Cursor has officially been acquired by SpaceX»; цель — «more capable models at lower cost»; Grok 4.6 как ранний пример |
| https://cursor.com/blog | 2026-11-11 | confirmed | Sep 21 2026: «Introducing Grok 4.7»; футер «© 2026 Anysphere, Inc.» |
| https://cognition.com/blog/windsurf | 2026-11-11 | confirmed | July 14 2025: «Cognition has signed a definitive agreement to acquire Windsurf, the agentic IDE»; Windsurf team continues, планируется интеграция IP в продукты Cognition |
| https://docs.devin.ai/desktop/devin-desktop-faq.md | 2026-11-11 | confirmed | June 2 2026: Windsurf → Devin Desktop; «same IDE, same editor, same features», Agent Command Center — основной вид; pricing не меняется; продукты унифицируются под брендом Devin (Cloud, Desktop, CLI, Review) |
| https://docs.devin.ai/desktop/getting-started | 2026-11-11 | confirmed | Devin Desktop — «next-generation AI IDE»; локальный агент — «next-generation agent harness, shared with Devin CLI», primary local agent; правила и `AGENTS.md`; MCP расширяет возможности; `devin-desktop` package, `windsurf` — transitional package |
| https://docs.devin.ai/desktop/introducing-devin-desktop.md | 2026-11-11 | confirmed | «Agent Development Environment for local and cloud agents, with support for ACP, all frontier models, and leading open models»; Devin on machine, delegate to cloud, third-party agent через ACP; управление из Agent Command Center |
| https://docs.devin.ai/desktop/agent-command-center.md | 2026-11-11 | confirmed | Agent Command Center: local agents (в редакторе) и cloud agents (Devin на собственных VM) в одном view; duplicate session, rules в @-mention, editable queued messages, sessions locked while running, sidebar grouping/folders/child sessions |
| https://docs.devin.ai/desktop/cascade/cascade | 2026-11-11 | confirmed | «Cascade is the legacy agent in Devin Desktop»; больше не стартует/не открывает диалоги; режимы Code/Chat; Todo list; Workflows — manual-only, «Cascade will never invoke a workflow automatically»; Auto-Continue после 40 tool invocations на промпт (`devin.autoContinue`) |
| https://docs.devin.ai/desktop/devin-local/overview.md | 2026-11-11 | confirmed | Devin Local: общий harness с Devin CLI; режимы Code, Smart, Ask, Plan, Bypass Permissions; subagents, sandboxing, plan mode, worktrees, permissions; ставка на prompt caching |
| https://docs.devin.ai/desktop/devin-local/permissions.md | 2026-11-11 | confirmed | Permissions: Deny > Ask > Allow; scope — file reads/writes, command execution, HTTP fetches, MCP tools; уровни project/user/organization; glob-правила вида `Read(**/*.pem)` |
| https://docs.devin.ai/desktop/devin-local/worktrees.md | 2026-11-11 | confirmed | Worktrees: New/Existing worktree при старте сессии, Merge обратно в workspace, только на старте; путь `~/.windsurf/worktrees/<repo>`; предупреждение о поломке relative-path сборок |
| https://docs.devin.ai/desktop/devin-local/customizations.md | 2026-11-11 | confirmed | Кастомизация Devin Local: Rules, Skills, Plugins, MCP servers, Hooks; формат и discovery — от Devin CLI, одна настройка работает в обоих |
| https://docs.devin.ai/desktop/changelog | 2026-11-11 | confirmed | v3.12.43 (2026-11-09), v3.12.32 (2026-11-08, MCP servers в session header, VS Code 1.141.2 / Electron 43.8.3), v3.11.212 (2026-10-23, Agent Window overhaul: sessions, Automations, Review, Wiki, side-by-side sessions, session terminals, cloud IDE via Remote SSH), v3.10.67 (2026-10-12, MCP protocol revision 2026-07-28, enterprise Extension marketplace URL) |
| https://docs.devin.ai/cli/index.md | 2026-11-11 | confirmed | Devin CLI — «local command-line coding agent with deep Devin Cloud integration»; установка macOS/Linux/WSL, Homebrew cask, Windows installer; входит в Devin Desktop |
| https://docs.devin.ai/cli/models.md | 2026-11-11 | confirmed | Модели: Anthropic, OpenAI, Google, Cognition + open source DeepSeek, Kimi, GLM; short names `opus`/`sonnet`/`swe`/`codex`/`gemini` резолвятся в последнюю версию; reasoning levels `Alt+T`; `/model`; pinned models `Alt+P`/`Alt+N`; team allowlists |
| https://docs.devin.ai/cli/subagents.md | 2026-11-11 | confirmed | Subagents: foreground (родитель ждёт) и background (параллельно, unapproved tools авто-deny); свой conversation chain, не наследует историю; «subagents both improve overall coding performance and reduce cost» |
| https://docs.devin.ai/cli/extensibility/index.md | 2026-11-11 | confirmed | Extensibility: Rules, Skills, Plugins, Custom Subagents, MCP Servers, Hooks; слои: rules всегда активны, skills — по требованию, subagents — worker-профили |
| https://docs.devin.ai/cli/extensibility/rules.md | 2026-11-11 | confirmed | Rules: `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`, `CLAUDE.md` — «All of these are treated identically — their contents are loaded as always-on rules»; `.devin/rules/*.md`, `.devin/global_rules.md`; глобальные и проектные активны одновременно; `.devin/` приоритетнее `.windsurf/`; `.codeiumignore` не поддерживается |
| https://docs.devin.ai/cli/extensibility/hooks/overview.md | 2026-11-11 | confirmed | Hooks: JSON-формат в `.devin/`, события `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PostCompaction`, `SessionStart`, `SessionEnd`; могут блокировать/переписывать tool calls, инжектить контекст, менять permissions; подхватываются hooks из `.claude/` |
| https://docs.devin.ai/cli/extensibility/skills/overview.md | 2026-11-11 | confirmed | Skills: `SKILL.md`, вызов `/skill-name` или агентом, собственные permissions и auto-approved tools |
| https://docs.devin.ai/cli/extensibility/plugins/overview.md | 2026-11-11 | confirmed | Plugins: bundle skills + rules/hooks/MCP/subagents; установка из GitHub repo, git URL, subfolder, local folder; `/<plugin>:<skill>`; plugin — единица установки |
| https://docs.devin.ai/cli/extensibility/mcp/overview.md | 2026-11-11 | confirmed | MCP: сервер описывается в config с command/args/env; tool discovery и execution через сервер; транспорты stdio, Streamable HTTP, SSE (по индексу конфигурации) |
| https://docs.devin.ai/cli/sandbox.md | 2026-11-11 | confirmed | `--sandbox`: OS-level isolation; writable paths = `Write(...)` scopes + workspace, остальное read-only; readable = всё, кроме `Read(...)` в deny; mid-session Write расширяет sandbox; fail-closed — при невозможности включить sandbox CLI «will refuse to start» |
| https://docs.devin.ai/cli/reference/configuration/read-config-from.md | 2026-11-11 | confirmed (по официальному индексу доков) | Импорт настроек из Cursor, Windsurf, Claude Code, GitHub Copilot, Codex, Kiro, OpenCode, Zed |
| https://docs.devin.ai/admin/billing/self-serve.md | 2026-11-11 | confirmed | Тарифы Devin: Free, Pro $20/mo, Max $200/mo, Teams от $80/mo (до 100 участников); квоты, не credits |
| https://devin.ai/pricing | 2026-11-11 | confirmed | Free $0; Pro $20/mo («Free use of SWE-2»); Max $200/mo; Teams $80/mo + $40/mo full dev seat; Enterprise custom |
| https://docs.devin.ai/windsurf/plugins/cascade/memories.md | 2026-11-11 | confirmed | Cascade Memories: автоматически генерируются и хранятся по workspace, retrieval по релевантности, между workspace не переносятся; «Creating and using auto-generated memories do NOT consume credits»; rules — global и workspace |

Итого: **110 уникальных первичных URL** (включая редиректы, зафиксированные как наблюдение). Из них `confirmed` — 109, `unverified` — 1 (`https://githubnext.com/projects/copilot-workspace`). Отдельно 52 недоступных URL зафиксированы в разделе 8 (`BLOCKED`); часть из них компенсирована альтернативным каноническим путём, что отмечено в колонке «Что не удалось подтвердить».

## 4. Capability matrix

Обозначения: `+` — документировано и доступно; `~` — ограничено/частично/preview/план-зависимо; `-` — не документировано на проверенных страницах; `?` — источник не найден или страница недоступна (не утверждение об отсутствии).

| Возможность | OpenAI Codex | GitHub Copilot | Cursor | Windsurf → Devin Desktop |
| --- | --- | --- | --- | --- |
| CLI | `+` `codex`, `codex exec` | `+` `copilot` | `+` `agent` | `+` `devin` |
| IDE extension | `+` VS Code/совместимые, Xcode, JetBrains | `+` VS Code, VS, JetBrains, Eclipse, Xcode, Neovim (частично) | `+` собственный IDE | `+` собственный IDE + JetBrains/Zed/Xcode через ACP |
| Desktop app | `+` ChatGPT desktop (`codex app`) | `+` GitHub Copilot app | `+` Cursor Desktop + Agents Window | `+` Devin Desktop |
| Web / cloud | `+` Codex Cloud, ChatGPT web | `+` GitHub.com, Copilot in the cloud | `+` Cloud Agents, cursor.com/agents | `+` Devin Cloud |
| Mobile | `+` ChatGPT mobile (Cloud или connected computer) | `+` GitHub Mobile | `+` iOS (Android planned) | `+` через Devin Cloud/ACP-экосистему (детали на проверенных страницах не раскрыты) |
| Agent loop / автономность | `+` turn loop, approvals, `codex exec` | `+` collaborative / asynchronous / automated; Autopilot | `+` Agent с неограниченным числом tool calls | `+` Devin Local (Code/Smart/Ask/Plan/Bypass) |
| Plan mode | `~` `/plan`-подобный режим явно не документирован; есть `read-only` sandbox для планирования | `+` Plan mode в CLI | `+` Plan Mode + Projects coordinator | `+` Plan mode |
| Subagents | `+` `default`/`worker`/`explorer`, кастомные TOML | `+` встроенные + custom agents + `/fleet` | `+` foreground/background, Explore | `+` foreground/background, custom profiles |
| Parallel agents | `+` параллельные subagent threads + worktrees | `+` `/fleet`, несколько cloud-сессий | `+` «as many agents as you want in parallel» | `+` Agent Command Center, side-by-side sessions |
| Files / search / edit | `+` | `+` | `+` | `+` |
| Terminal | `+` sandboxed | `+` sandboxed (local sandboxing) | `+` sandbox + Run Modes | `+` terminal с allow/ask/deny |
| Browser | `~` `--search` web search; computer use на mobile/desktop упоминается косвенно | `+` Playwright MCP по умолчанию у cloud agent; computer use | `+` нативный browser tool + computer use в cloud VM | `~` Previews (element selection, error capture); отдельный browser tool на проверенных страницах не найден |
| MCP | `+` STDIO + Streamable HTTP | `+` до 50 серверов, политика org | `+` stdio/SSE/Streamable HTTP | `+` stdio/Streamable HTTP/SSE |
| Context / rules | `+` `AGENTS.md` (override, 32 KiB) + `.rules` (Starlark) | `+` `copilot-instructions.md`, `*.instructions.md`, `AGENTS.md` | `+` `.cursor/rules/*.mdc`, `AGENTS.md`, Team Rules | `+` `AGENTS.md`/`.devin/rules`/`.windsurf/rules`, `.windsurfrules` |
| Memory | `+` local memory store, `/memories` | `+` Copilot Memory (repo + user level) | `~` memory только в Agent SDK (`journal.jsonl`); в IDE отдельного Memories-продукта не документировано | `+` Cascade Memories (auto, per-workspace); для Devin Local — через rules/plugins |
| Codebase indexing | `?` явного описания индекса на проверенных страницах нет | `+` Workspace indexing (VS Code/VS/JetBrains/Eclipse) | `+` Instant Grep, локальный индекс, без embeddings для поиска | `?` на проверенных страницах не описано |
| Compaction | `+` `model_auto_compact_token_limit`, scope, turn-end %, remote `v2` | `+` компакция диалога из UI при достижении лимита | `~` `preCompact` hook; собственная политика не документирована | `~` hook `PostCompaction`; политика не документирована |
| Skills | `+` `SKILL.md`, progressive disclosure | `+` Agent skills (`SKILL.md`) | `+` Agent Skills стандарт + встроенные скиллы | `+` `SKILL.md`, permissions |
| Hooks | `+` 14 событий, `command`/`mcp_tool` | `+` preToolUse/postToolUse/agentStop/subagentStop/permissionRequest/notification | `+` 18+ событий, command/prompt, failClosed | `+` PreToolUse/PostToolUse/UserPromptSubmit/Stop/PostCompaction/SessionStart/SessionEnd |
| Plugins / marketplace | `+` plugin bundle (skills + MCP + hooks) | `+` plugins и plugin marketplaces в CLI | `+` Cursor Marketplace + Agent Plugins standard + team marketplaces | `+` plugins + team marketplace |
| Custom agents как файлы | `+` TOML (`name`, `description`, `developer_instructions`) | `+` Markdown + YAML frontmatter | `+` subagents с prompt/tools/model | `+` subagent profiles |
| SDK / protocol | `+` TypeScript SDK + app-server protocol | `~` Copilot SDK упомянут в навигации доков; стабильный контракт на проверенных страницах не подтверждён | `+` Agent SDK (Markdown+TS) + API/webhooks | `~` ACP (Agent Client Protocol) + Devin API для cloud |
| Models / providers | `+` GPT-6.1 Sol / GPT-6 Luna / GPT-6.1 Terra; custom `model_providers`, Bedrock, GCP, Ollama/LM Studio | `+` мультивендор + Auto selection + LTS/fallback | `+` Grok 4.7/4.6/4.5, Composer 2.5, Claude/GPT/Gemini | `+` Anthropic/OpenAI/Google/Cognition + DeepSeek/Kimi/GLM; Adaptive router; Fusion |
| BYOK / local models | `+` `env_key`, `auth.command`, `--oss` (lmstudio/ollama) | `+` Local BYOK (CLI/app) + enterprise custom models | `+` OpenAI/Anthropic/Google/Azure/Bedrock (chat-only) | `~` модели выбираются из каталога; собственный ключ на проверенных страницах не документирован |
| Routing / fallback | `~` `model_provider` + profiles; автоматического fallback не документировано | `+` Auto model selection + fallback/LTS-модели | `+` Cursor Router (Teams/Enterprise, Balance/Intelligence) | `+` Adaptive router + Fusion pairing |
| Permissions | `+` approval policies + granular + auto-review | `+` allow/deny/assist + permission patterns | `+` Run Modes + allowlist + classifier | `+` Allow/Ask/Deny, project/user/org |
| Sandbox | `+` Seatbelt / bwrap+seccomp / MXC, сеть off by default | `+` OS-level local sandbox + cloud sandbox + firewall | `+` sandbox + `sandbox.json` | `+` OS-level `--sandbox`, fail-closed |
| Secrets | `+` HTTP secrets в cloud environments, env vars, OIDC, VPN | `+` `COPILOT_MCP_`-секреты, connectors, OIDC | `+` secrets в cloud env, OIDC JWT, проксирование HTTP MCP | `~` env/secret handling на проверенных страницах не детализирован |
| Git / PR | `+` commit/PR из Cloud, `/review`, GitHub/GitLab | `+` draft PR, один branch/PR на задачу, branch protection | `+` PR из cloud, commit/PR в Agents Window | `+` PR через cloud, Merge из worktree |
| Worktree | `+` Local/Worktree + Handoff, background worktrees для scheduled | `-` явного worktree-продукта нет; worktrees упоминаются в блоге как практика | `~` worktrees не документированы на проверенных страницах | `+` New/Existing worktree + Merge |
| Checkpoints / rewind | `~` `/review` и Git; отдельный checkpoint-продукт не документирован | `+` Checkpoints в VS Code/VS/JetBrains/Xcode | `+` Checkpoints (файлы, не сообщения; локально, вне Git) | `~` rewind через worktree/duplicate session; checkpoint-продукт не документирован |
| Cloud / background | `+` Codex Cloud + scheduled tasks | `+` Copilot in the cloud, autopilot, automations | `+` Cloud Agents + Automations | `+` Devin Cloud + Automations |
| Telemetry | `+` OTel (`otel.exporter`, trace, metrics) + Analytics API + Compliance API | `+` OTel off by default | `+` OTel Export (Enterprise) + Analytics API | `~` Analytics API (Cascade/agent tool calls, LOC); OTel на проверенных страницах не найден |
| Evals | `-` публичного eval-продукта на проверенных страницах нет | `~` ReviewBench (внешний бенчмарк), eval-модели в каталоге | `+` Evals в Agent SDK | `-` не документировано |
| Монетизация | ChatGPT-подписка (Free/Go/Plus/Pro/Business/Enterprise) + API key | GitHub AI Credits по тарифам | Подписка X (Grok+Cursor), недельный pool, prepaid credit | Квоты Devin (Free/Pro/Max/Teams) |

## 5. Продуктовые нарративы

### 5.1 OpenAI Codex

**Позиционирование и статус.** Codex — зонтичный бренд семейства: локальный CLI, IDE-расширение, облако и присутствие в ChatGPT (desktop/mobile/web). README формулирует ядро так: «Codex CLI is a coding agent from OpenAI that runs locally on your computer», Apache-2.0, 134 817 stars. Продукт живой и быстро релизится: `rust-v0.167.1` (2026-11-10), альфы `0.169.0` (2026-11-11).

**Поверхности.** Шесть документированных поверхностей: ChatGPT desktop app, ChatGPT mobile app, ChatGPT web, Codex CLI, Codex IDE extension, Codex Cloud. IDE-расширение ставится в VS Code и совместимые (Cursor, Windsurf, Insiders), Xcode и JetBrains имеют собственные интеграции.

**Agent loop и автономность.** Основной цикл — turn-based с инструментами и политикой approvals. Автономность регулируется не «режимом агента», а двумя независимыми осями: `sandbox_mode` (что физически можно) и `approval_policy` (когда спрашивать). `codex exec` — неинтерактивный режим для CI: `--json` выдаёт newline-delimited JSON по одному событию на state change, `--output-schema` задаёт JSON Schema финального ответа, `--ephemeral` не пишет rollout-файлы. Отдельно есть `auto-review`: «sends eligible approval requests to a separate reviewer agent» — то есть проверка разрешений вынесена в отдельного агента, а не в эвристику.

**Planning и subagents.** Subagents — полноценный продуктовый слой: встроенные `default`/`worker`/`explorer`, кастомные TOML-профили в `~/.codex/agents/` или `.codex/agents/`, команда `/subagents`, лимит `agents.max_concurrent_threads_per_session`. Важная деталь дизайна: subagent наследует sandbox/approval/permissions родителя, но кастомный файл агента не может их переопределить. Это защита от «агент сам себе выдал права».

**Инструменты.** Файлы, поиск, редактирование, shell в песочнице, web search (`--search`), изображения (`--image`), MCP. Браузер как отдельный первоклассный инструмент на проверенных страницах не документирован (в отличие от Cursor).

**Контекст и память.** `AGENTS.md` с явным порядком: глобальный `AGENTS.override.md` → `AGENTS.md`, затем проект от корня к cwd с конкатенацией и приоритетом ближайшего файла; лимит `project_doc_max_bytes` 32 KiB. Отдельно — Memories: локальное хранилище, `/memories`, настройки «Enable Codex memories» и «Allow memories from tool-assisted chats», с прямой рекомендацией не делать memories единственным носителем обязательных правил. Компакция настраивается количественно (`model_auto_compact_token_limit`, `_scope`, turn-end %), есть remote compaction protocol `v2` через Responses.

**Расширяемость.** Очень широкий набор: skills (`SKILL.md` + progressive disclosure, пути `.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`), hooks (14 событий, handlers `command` и `mcp_tool`, блокировка PreToolUse/PermissionRequest/UserPromptSubmit/PreCompact, замена результата PostToolUse), plugins (skills + MCP + lifecycle hooks), MCP (STDIO и Streamable HTTP), `.rules` на Starlark (`prefix_rule` с `decision = "prompt"`, помечено experimental), subagents, SDK (TypeScript, Node 18+) и app-server protocol для собственных клиентов.

**Модели и провайдеры.** GPT-6.1 Sol, GPT-6 Luna, GPT-6.1 Terra. Провайдеры настраиваются через `model_providers.<id>`: `base_url`, `env_key`, `auth.command` (команда печатает токен в stdout), `wire_api` — **только `responses`**, то есть произвольный OpenAI-совместимый chat-completions endpoint не подойдёт. Зарезервированы `openai`, `ollama`, `lmstudio`; есть `amazon-bedrock` и `gcp`; `--oss` + `oss_provider` для локальных моделей. Project-local config не может переопределять провайдеров и `otel` — это осознанная граница доверия.

**Permissions / sandbox / secrets.** Три sandbox-режима и три approval-политики, включая granular с подкатегориями. OS-enforcement различается: macOS Seatbelt через `sandbox-exec`, Linux `bwrap` + seccomp (`landlock` — alias), Windows `MXC` с legacy fallback, WSL2 — Linux sandbox. Сеть по умолчанию выключена; `network_proxy` off by default; `allow_local_binding = false` блокирует local/private адреса. `untrusted` выведен и может помешать старту — это ломающее изменение, которое стоит учитывать при миграции.

**Git / PR / worktree.** Worktrees — первоклассный объект: `Local checkout`, `Worktree`, `Handoff` между ними; scheduled tasks работают в выделенных background worktree. `/review` ревьюит локальный checkout (base-branch, uncommitted, commit, custom scopes) и «reports prioritized findings without changing your working tree». PR-ревью: GitHub GA, GitLab preview, автоматические ревью через connector.

**Remote / cloud.** Codex Cloud: у каждой задачи свой workspace, работа продолжается при спящем компьютере; окружения включают репозитории, install script, network access, HTTP secrets, env vars, OIDC, VPN; поддерживаются GitHub и GitLab. Mobile управляет Cloud или подключённым Mac/Windows.

**Telemetry.** OTel с явными ключами (`otel.exporter` = `none|otlp-http|otlp-grpc`, отдельно trace и metrics exporter), плюс Codex analytics dashboard, Analytics API и Compliance API.

**Pricing.** Codex включён в ChatGPT Free/Go/Plus/Pro/Business/Edu/Enterprise; usage общий с ChatGPT Work; Free $0, Go $8, Plus $20, Pro от $100, Business $25/user/mo (annual; $30 monthly), Enterprise — contact sales. Отдельно «API Key» — только CLI/SDK/IDE, без cloud-функций.

**Notable 2025–2026.** 0.167.0 (2026-11-06): agent command center с unread-маркерами и переключением между подключёнными backend, локальные превью изображений, вход через Google Cloud Vertex AI, экспериментальный system proxy, inline patch review прямо в approvals. Плюс постоянные правки context compaction. Отдельная линия — Codex Security (CLI, Cloud, plugin, TypeScript SDK, CI/CD для GitHub Actions и GitLab).

**Сильные стороны.** Самая глубокая проработка sandbox/approval-модели среди четырёх (три режима × три политики × granular × отдельный reviewer-агент); открытый Apache-2.0 CLI; количественно настраиваемая компакция; аккуратная граница доверия project-local config; реальные worktrees с Handoff.

**Слабые стороны.** `wire_api` только `responses` — узкая совместимость провайдеров; браузер не оформлен как первоклассный инструмент; `.rules` помечены experimental; автоматический fallback моделей не документирован; документация переехала и часть старых URL (`/docs/codex/sandbox`, `/docs/codex/cloud`, `/docs/codex/codex-sdk`) отдаёт 404 — внешние ссылки ломаются; после серии запросов `*.md`-эндпоинты начали отдавать `403 Forbidden` (rate limit).

**Do-not-copy.** (1) Не копировать `wire_api = responses`-ограничение: оно привязывает продукт к одному протоколу и делает «OpenAI-совместимые» провайдеры недоступными. (2) Не копировать 32 KiB-лимит на `AGENTS.md` как жёсткий дефолт без диагностики — он молча обрезает инструкции. (3) Не копировать вывод `untrusted` с падением старта: миграция должна быть с предупреждением и автофиксом. (4) Не копировать разнесение части доков по редиректам без сохранения старых путей.

### 5.2 GitHub Copilot: Workspace → coding agent → «Copilot in the cloud»

**Позиционирование и статус.** GitHub последовательно заменил «Workspace» на агентскую модель. Workspace — проект GitHub Next (карточка «Completed», апрель 2024), последняя запись changelog — 2025-02-28; актуальной документации Workspace нет (все проверенные пути 404). Формального объявления о выводе найти не удалось, поэтому вывод Workspace из эксплуатации фиксируется как `unverified`, а вот отсутствие документации — `confirmed`.

Преемник — Copilot cloud agent, с 2026-10-28 переоформленный в «Copilot in the cloud»: «a continuous task flow», где сессия переносится между web, mobile, Copilot app, VS Code и CLI, а работа и контекст сохраняются.

**Поверхности.** GitHub.com, GitHub Mobile, GitHub Copilot app (agent-native desktop, с 2026-06-02), Copilot CLI, IDE (VS Code, Visual Studio, JetBrains, Eclipse, Xcode, частично Neovim). Плюс интеграции: Slack/Teams (GA 2026-11-06), GitHub CLI, API, Raycast, MCP-совместимые инструменты.

**Agent loop и автономность.** Три уровня: collaborative session (ведёшь и одобряешь), asynchronous session (делегировал — вернулся), automated workflow (событие/расписание). Autopilot mode в CLI и app: «can write code, run tests, evaluate the results, and continue iterating until it determines that the task is complete». Ограничения жёсткие и явные: «can only work on one branch at a time», «can open one pull request per task», Actions-сессия ≤ 59 минут, Actions-сессия меняет только один репозиторий (cloud sandbox — несколько), только GitHub-репозитории.

**Planning и параллельность.** `/fleet` — оркестратор разбивает цель, назначает subagent'ам, запускает независимые задачи параллельно и сводит результаты. Custom agents (Markdown + YAML frontmatter) задают роль, инструкции, ограничение инструментов и MCP-серверы; встроенные агенты CLI: `explore`, `task`, `general-purpose`, `code-review`, `research`, `rubber-duck`, `security-review`.

**Инструменты.** Файлы, поиск, редактирование, shell в локальном sandbox, MCP. Браузер — через Playwright MCP, который подключён по умолчанию у cloud agent. Есть computer use, tool search, image generation (по навигации доков).

**Контекст и память.** Три слоя инструкций: `.github/copilot-instructions.md` (repo-wide), `.github/instructions/NAME.instructions.md` с `applyTo` (path-specific, только cloud agent и code review), `AGENTS.md` в любом месте репо (ближайший выигрывает), один корневой `CLAUDE.md`/`GEMINI.md`. Приоритет: personal → repository → organization, но «all sets of relevant instructions are provided to Copilot». Copilot Memory двухуровневая: repository-level facts (видны коллегам) и user-level preferences (переносятся между репозиториями). Компакция доступна из UI при достижении контекстного лимита (ноябрь 2026).

**Расширяемость.** MCP (до 50 серверов, секреты `COPILOT_MCP_`, repo-level переопределяет personal, политика org off by default и только Business/Enterprise), skills (`SKILL.md`), hooks (`preToolUse`, `postToolUse`, `agentStop`, `subagentStop`, `permissionRequest`, `notification`; в CLI и cloud), plugins и plugin marketplaces, custom agents, dynamic workflows, agentic workflows (GA 2026-10-28), ACP.

**Модели и провайдеры.** Мультивендорный каталог с Auto model selection, отдельными разделами «Fallback and long-term support (LTS) models», «Evaluation models», «Utility models» и «Model retirement history». BYOK: Local BYOK в CLI/app — запросы идут напрямую к ключу разработчика или локальной модели; enterprise custom models маршрутизируются через GitHub. Usage API разделяет `used_local_byok` и `is_custom_enterprise_model` — это редкая для рынка прозрачность биллинга BYOK.

**Permissions / sandbox / secrets.** Local sandboxing с OS-level изоляцией и файловой политикой (read/write/none), собираемой автоматически; permission patterns `Kind(argument)` для `read`/`write`/`shell`/`url`/`memory`/MCP-сервера; deny всегда сильнее allow. Cloud sandbox + integrated firewall, но firewall несовместим с self-hosted runners и Windows; поддерживаются только Ubuntu x64 и Windows 64-bit runners.

**Git / PR.** Draft PR, human approval до запуска CI/CD, branch protection сохраняется, один branch и один PR на задачу, Agent Merge (2026-10-28) — Copilot сам мержит PR, когда checks прошли.

**Telemetry.** OTel off by default, включается `COPILOT_OTEL_ENABLED` / `OTEL_EXPORTER_OTLP_ENDPOINT` / `COPILOT_OTEL_FILE_EXPORTER_PATH`; usage metrics API с разбивкой по BYOK и custom models.

**Pricing.** Free / Student / Pro $10 (1 500 credits) / Pro+ $39 (7 000) / Max $100 (20 000) / Business $19 за seat (1 900) / Enterprise $39 за seat (3 900) / Copilot access $0 для GHE Cloud, $10 standalone. Метрика — GitHub AI Credits; «Copilot in the cloud» не входит в Free.

**Notable 2025–2026.** 2025-05-19 — запуск coding agent (issue → draft PR, Actions). 2026-06-02 — Copilot app. 2026-10-28 — Agentic Workflows GA, Agent Merge, «Copilot in the cloud». 2026-11-03 — BYOK в usage API, JetBrains Air, Xcode coding assistant. 2026-11-06 — Slack/Teams GA, assisted approval personal instructions. 2026-11-09 — Claude Fable 5.2 в Copilot.

**Сильные стороны.** Самая зрелая интеграция с git-хостингом (branch protection, PR-гейты, human approval до CI); прозрачная биллинговая модель для BYOK; `/fleet` как готовый оркестратор; Copilot Memory с разделением repo/user; широкий охват IDE, включая Xcode и Eclipse.

**Слабые стороны.** Жёсткие лимиты автономии (один branch/PR, 59 минут, один репозиторий в Actions); MCP-политика по умолчанию выключена и доступна только Business/Enterprise; cloud agent и code review поддерживают только MCP tools (не произвольные инструменты); firewall несовместим с self-hosted/Windows; Workspace оставил после себя битые ссылки и неопределённый статус; Copilot SDK на проверенных страницах не подтверждён стабильным контрактом.

**Do-not-copy.** (1) Не копировать «один branch — один PR» как архитектурный предел: это ограничение окружения, а не свойство задачи. (2) Не копировать 59-минутный потолок сессии как продуктовую норму. (3) Не копировать выключенную по умолчанию MCP-политику с доступом только для enterprise — это создаёт разрыв между триалами и продакшеном. (4) Не оставлять после смены продукта недокументированные 404-пути, как это вышло с Workspace.

### 5.3 Cursor

**Позиционирование и статус.** «A coding agent for building ambitious software». За 2026 год продукт прошёл два крупных сдвига: 2026-08-14 «Cursor has officially been acquired by SpaceX» и превращение в часть «The X Subscription» (Grok + Cursor + X), с собственным модельным семейством (Grok 4.7/4.6/4.5, Composer 2.5). Футер по-прежнему «© 2026 Anysphere, Inc.».

**Поверхности.** Собственный IDE, Agents Window (agent-first интерфейс с multi-workspace и parallel agents), CLI `agent`, Cloud Agents, iOS-приложение (iOS 26+, Android planned), web (cursor.com/agents), триггеры из Slack/GitHub/Bitbucket/Linear, API.

**Agent loop и автономность.** Agent = Instructions + Tools + Model, причём Cursor «tuning instructions and tools specifically for every frontier model» — то есть под каждый вендор отдельная обвязка. «There is no limit on the number of tool calls Agent can make during a task». Projects дают coordinator-агента, который планирует и делегирует другим агентам. Run Modes задают три уровня: Auto-review (allowlist → sandbox → classifier), Allowlist, Run Everything.

**Planning.** Plan Mode: уточняющие вопросы, исследование кодовой базы, план на ревью, редактирование, затем build; «Save to workspace» для шаринга. Отдельно `/goal` (долгоживущая цель) и `/loop` (повтор промпта/скилла).

**Subagents.** Свой context window у каждого, foreground/background, параллельный запуск, кастомные prompt/tools/model, встроенный `Explore`. Работают в editor, CLI и Cloud Agents.

**Инструменты.** Поиск файлов и паттернов, web search, fetch rules, чтение файлов (включая изображения), редактирование, shell, нативный browser tool. Browser — сильная сторона: console logs и network traffic, логи пишутся в файлы и агент их grep'ает (экономия токенов), скриншоты передаются как изображения, агент определяет запущенные dev-серверы и их порты.

**Контекст и индекс.** Rules: `.cursor/rules/*.mdc` (plain `.md` игнорируется — частая ловушка), четыре типа применения, Project/User/Team Rules, `AGENTS.md` с вложенным слиянием, приоритет Team → Project → User. Индексация — «Instant Grep»: локальный индекс, full regex + word-boundary, без конфигурации; «does not store embeddings of your codebase for search» и «does not upload file paths or code to build a search index» — это заметно более консервативная privacy-позиция, чем у embedding-индексов. Отдельного продукта Memories в IDE нет: память живёт в Agent SDK как hook, пишущий `memory/journal.jsonl`, причём «The model has no recall tool» — журнал читается файловыми инструментами и трактуется как untrusted history.

**Расширяемость.** Самый широкий набор точек расширения: hooks (18+ событий, включая Tab-хуки и app lifecycle, типы `command` и `prompt`, `failClosed`, `loop_limit`, совместимость с Claude Code hooks), plugins (Agent Plugins open standard + Cursor Plugins, bundle Rules/Skills/Agents/Commands/MCP/Hooks), marketplace + team marketplaces с режимами Default Off/On/Required, skills как открытый стандарт, встроенные `/automate`, `/autopilot`, `/canvas`, `/create-hook`, `/create-rule`, `/create-skill`, Agent SDK с evals.

**Модели и провайдеры.** Grok 4.7/4.6/4.5 и Composer 2.5 — в включённом пуле; сторонние (Claude, GPT, Gemini) — по API list price с prepaid credit и только с Premium+. Cursor Router на Teams/Enterprise выбирает между Cursor-моделями и сторонними по режиму Balance/Intelligence. BYOK: OpenAI (только standard non-reasoning), Anthropic (все Claude), Google Gemini, Azure OpenAI, AWS Bedrock; «Custom API keys only work with chat models», Tab всегда на встроенных моделях; ключ не хранится на серверах, но отправляется с каждым запросом.

**Permissions / sandbox / secrets.** Run Modes + sandbox для shell, `sandbox.json`, `CURSOR_AGENT` env для совместимости с shell-темами. В cloud: secrets в окружении, HTTP MCP проксируются через backend (креды не попадают в VM), short-lived OIDC JWT, private connectivity (AWS PrivateLink / Cloudflare Tunnel), self-hosted machines.

**Git / PR / checkpoints.** Checkpoints — автоснапшоты изменённых файлов перед значимыми изменениями; restore возвращает файлы, но не сообщения; хранятся локально и отдельно от Git. Cloud agents создают artifacts (screenshots, videos, logs) и прикрепляют их к PR; автоматически чинят CI, но только GitHub Actions. Agents Window даёт diffs view с commit/PR без выхода из Cursor.

**Remote / cloud.** Cloud Agents — изолированные VM с полным desktop, computer use (мышь/клавиатура/browser), «You can run as many agents as you want in parallel», multi-repo, self-hosted machines, Automations по расписанию и событиям. iOS-приложение управляет и cloud, и local-агентами.

**Telemetry и evals.** OTel Export только на Enterprise: OTLP/HTTP protobuf, метрики (tokens, tool calls, cost) и логи (API requests, errors, corrections, skills, hooks, plugins, cloud agent lifecycle), opt-in conversation content и MCP tool I/O, export server-side. Analytics API с разрезами agent-edits, tab-usage, DAU, model-usage, mcp-adoption, skills-adoption. Evals — часть Agent SDK: `evals/**/*.eval.ts|js`, `defineEval`, `iterations` 1–100.

**Pricing.** Free $0; Plus $8 (только Grok-модели, без third-party, без BYOK, без cloud agents); Premium $30 (4x, cloud agents & automations, third-party по list price, Bugbot); Super $100 (15x); Ultra $200 (50x); Teams $30+/user; Enterprise custom. Один недельный pool на editor/CLI/Cloud/Grok.

**Notable 2025–2026.** 2026-08-14 — приобретение SpaceX. 2026-09-21 — Grok 4.7. 2026-10-13 — Origin App Marketplace (20+ интеграций). 2026-10-16 — Cloud Agent Canvases + Environments API beta (до 300 репозиториев). 2026-10-20 — Agent SDK. 2026-11-05 — Build Live Apps (Postgres + deploy из cloud agent). 2026-11-06 — Voice Chat with Agents на Grok Voice.

**Сильные стороны.** Лучший browser-tool с экономией токенов; самая широкая hook-поверхность (включая Tab и app lifecycle); Evals как файлы в репозитории; Instant Grep без выгрузки кода; параллельные cloud agents без документированного лимита; Agents Window как отдельный agent-first интерфейс.

**Слабые стороны.** Жёсткая привязка к экосистеме X/Grok: Plus не даёт сторонних моделей и BYOK, cloud agents только с Premium+; BYOK ограничен chat-моделями и OpenAI только non-reasoning; ключ отправляется с каждым запросом; OTel Export только Enterprise; нет продукта Memories в IDE; `AGENTS.md` сосуществует с `.mdc`-правилами и легко получить неожиданный приоритет; Android отсутствует.

**Do-not-copy.** (1) Не копировать `preToolUse`-семантику cloud-хуков, где `updated_input` игнорируется и `postToolUse` получает `{"redacted": true}` вместо результата — это ломает ожидания авторов хуков. (2) Не копировать «plain `.md` в rules-каталоге молча игнорируется» — нужна диагностика. (3) Не копировать привязку BYOK к chat-only при наличии агентных задач. (4) Не копировать отправку ключа на backend с каждым запросом как норму. (5) Не копировать раздвоение «Rules vs AGENTS.md» без явного правила приоритета в UI.

### 5.4 Windsurf → Devin Desktop (Cognition)

**Позиционирование и статус.** 2025-07-14 Cognition объявила о приобретении Windsurf («Cognition has signed a definitive agreement to acquire Windsurf, the agentic IDE»). 2026-06-02 Windsurf стал Devin Desktop: «Devin Desktop is the new name for Windsurf. It's the same IDE, same editor, and has the same features, but unified under the Devin brand». Позиционирование — «Agent Development Environment for local and cloud agents, with support for ACP, all frontier models, and leading open models». Agent Command Center (управление local и cloud агентами в одном view) вынесен на первый план.

**Поверхности.** Devin Desktop (IDE, macOS/Windows/Linux), Devin CLI, Devin Cloud, Devin Review, Agent Command Center, ACP для сторонних агентов, JetBrains/Zed/Xcode через ACP.

**Agent loop и автономность.** Ключевая деталь: **Cascade — legacy**. «Cascade is the legacy agent in Devin Desktop», новые сессии идут в Devin Local — общий harness с Devin CLI. Режимы Devin Local: Code, Smart, Ask, Plan, Bypass Permissions. У Cascade остались Code/Chat, Todo list, Workflows (manual-only, «Cascade will never invoke a workflow automatically») и Auto-Continue после 40 tool invocations на промпт (`devin.autoContinue`) — это исторический лимит, который стоит читать как антипаттерн, а не как дизайн.

**Planning и subagents.** Plan mode — штатный режим Devin Local. Subagents: foreground (родитель ждёт, tool calls можно одобрять) и background (параллельно, unapproved tools автоматически deny); свой conversation chain, историю родителя не наследует. Вендор прямо заявляет: «subagents both improve overall coding performance and reduce cost».

**Инструменты.** Терминал с allow/ask/deny, Previews (preview web-приложения в IDE или browser с element selection и error capture), MCP. Отдельный первоклассный browser-tool на проверенных страницах не найден.

**Контекст и память.** Rules: `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`, `CLAUDE.md` — «All of these are treated identically — their contents are loaded as always-on rules»; `.devin/rules/*.md`, `.devin/global_rules.md`; глобальные и проектные активны одновременно; `.devin/` приоритетнее `.windsurf/`; `.codeiumignore` не поддерживается. Cascade Memories — автоматическая генерация по workspace, retrieval по релевантности, между workspace не переносятся, «Creating and using auto-generated memories do NOT consume credits». Компакция как продукт не документирована, есть только hook `PostCompaction`.

**Расширяемость.** Rules, Skills (`SKILL.md`, `/skill-name`, собственные permissions и auto-approved tools), Plugins (bundle skills + rules/hooks/MCP/subagents; установка из GitHub repo, git URL, subfolder, local folder; `/<plugin>:<skill>`; team marketplace), MCP (stdio, Streamable HTTP, SSE), Hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PostCompaction`, `SessionStart`, `SessionEnd`; JSON в `.devin/`; подхватывает `.claude/` hooks), Custom Subagents. Отдельно — импорт конфигурации из Cursor, Windsurf, Claude Code, GitHub Copilot, Codex, Kiro, OpenCode, Zed: сильный ход для миграции пользователей.

**Модели и провайдеры.** Anthropic, OpenAI, Google, Cognition + open source DeepSeek, Kimi, GLM; short names `opus`/`sonnet`/`swe`/`codex`/`gemini` резолвятся в последнюю версию; reasoning levels `Alt+T`; pinned models. Два уровня маршрутизации: Adaptive (интеллектуальный выбор модели) и Fusion (frontier lead + cost-efficient sidekick) — Fusion рекомендуется как дефолт «for most users». Team allowlists ограничивают каталог.

**Permissions / sandbox / secrets.** Allow/Ask/Deny с приоритетом Deny > Ask > Allow, scope — file reads/writes, command execution, HTTP fetches, MCP tools; уровни project/user/org; glob-правила. `--sandbox`: OS-level изоляция, writable = `Write(...)` scopes + workspace, readable = всё кроме `Read(...)` в deny, mid-session Write расширяет sandbox, и fail-closed: при невозможности включить sandbox CLI «will refuse to start» — это самая строгая позиция из четырёх.

**Git / PR / worktree.** Worktrees: New/Existing при старте сессии, Merge обратно в workspace, только на старте (перенести начатую сессию нельзя), путь `~/.windsurf/worktrees/<repo>` с честным предупреждением, что relative-path сборки и symlinked-зависимости могут ломаться.

**Remote / cloud.** Devin Cloud, Automations, Agent Command Center с local+cloud, side-by-side sessions, session terminals, cloud IDE через Remote SSH, `devin ssh`/`devin forward`/`scp` для cloud-сессий.

**Telemetry.** Analytics API с разрезами (Cascade analytics, agent tool calls, LOC, active users, consumption); OTel на проверенных страницах не найден.

**Pricing.** Free $0; Pro $20/mo («Free use of SWE-2»); Max $200/mo; Teams от $80/mo + $40/mo full dev seat; Enterprise custom. Модель — квоты, не credits; после ребрендинга тарифы не менялись.

**Notable 2025–2026.** 2025-07-14 — приобретение Cognition. 2026-06-02 — ребрендинг в Devin Desktop, Agent Command Center как основной вид. 2026-10-12 — MCP protocol revision 2026-07-28, enterprise Extension marketplace URL. 2026-10-23 — Agent Window overhaul: sessions, Automations, Review, Wiki, Command Palette, side-by-side sessions, session file trees, Changes tabs, session terminals, cloud IDE via Remote SSH. 2026-11-08/09 — MCP servers в session header, VS Code 1.141.2 / Electron 43.8.3.

**Сильные стороны.** Fail-closed sandbox; единый harness Desktop/CLI (одна настройка работает в обоих); импорт конфигурации из восьми конкурирующих инструментов; Fusion/Adaptive как реальная экономика токенов; Agent Command Center с local+cloud в одном view; честная документация ограничений (worktree relative paths, Cascade legacy).

**Слабые стороны.** Бренд и домены в переходном состоянии (`windsurf.com` → `devin.ai`, `windsurf` npm-пакет — transitional, пути `~/.windsurf/worktrees` остались); Cascade одновременно «legacy» и всё ещё документирован — риск, что пользователь попадёт в мёртвую ветку; нет OTel; нет первоклассного browser-tool; компакция не оформлена как продукт; Workflows намеренно manual-only (не автоматизируются агентом).

**Do-not-copy.** (1) Не копировать двойной брендинг и transitional-пакеты: `windsurf`-пути внутри `devin`-продукта — источник путаницы. (2) Не копировать лимит «40 tool invocations на промпт» с платным Auto-Continue. (3) Не копировать `manual-only` workflows как единственную модель автоматизации. (4) Не копировать worktree, который нельзя перенести в другую сессию. (5) Не копировать отсутствие OTel при enterprise-позиционировании.

## 6. Сквозные паттерны (что рынок сошёлся считать нормой)

1. **Разделение «что можно» и «когда спрашивать».** Codex (`sandbox_mode` × `approval_policy`), Copilot (permission patterns + sandbox), Cursor (Run Modes), Devin (Allow/Ask/Deny + `--sandbox`). Все четыре развели физическую изоляцию и политику подтверждений — это уже отраслевой консенсус, а не фича одного вендора.
2. **Три уровня автономности.** Collaborative → asynchronous → automated (Copilot формулирует явно; Codex — через `codex exec` и scheduled tasks; Cursor — через Automations; Devin — через Cloud + Automations).
3. **`AGENTS.md` как де-факто стандарт.** Все четыре поддерживают `AGENTS.md`; трое (Codex, Copilot, Cursor) явно описывают приоритет вложенных файлов; Devin дополнительно читает `.windsurfrules` и `CLAUDE.md` «identically».
4. **Skills (`SKILL.md`) как переносимый формат.** Codex, Cursor, Devin, Copilot — все используют `SKILL.md` с YAML `name`/`description` и progressive disclosure. Формат стал кросс-вендорным.
5. **Hooks как обязательный слой управления.** Наборы событий почти совпадают: `PreToolUse`/`PostToolUse` есть у всех четырёх; `SessionStart`/`Stop` — у всех; `PreCompact`/`PostCompact` — у Codex, Cursor, Devin; `PermissionRequest` — у Codex и Copilot.
6. **Subagents с изоляцией контекста.** Все четыре: отдельный context window, foreground/background, параллельность, кастомные профили. Причины названы одинаково — снижение context rot и стоимости.
7. **Worktrees вместо «просто ветки».** Codex (Local/Worktree + Handoff), Devin (New/Existing + Merge), Cursor (параллельные cloud VM как замена), Copilot (branch-per-task без worktree-продукта).
8. **MCP как единственный способ подключить внешние инструменты.** Все четыре; различаются только транспорты (stdio/SSE/Streamable HTTP) и политики (у Copilot — до 50 серверов и off-by-default org-политика).
9. **OTel как корпоративный стандарт телеметрии.** Codex, Copilot, Cursor (Enterprise), Devin — частично (Analytics API без OTel).
10. **Биллинг уходит от «запросов» к пулам/кредитам.** ChatGPT credits, GitHub AI Credits, Cursor weekly pool + prepaid credit, Devin quotas.

## 7. Кандидатные рекомендации для ZCode (только с опорой на конкурентные доказательства)

Каждый пункт: (а) наблюдаемое у конкурента с URL, (б) что это даёт, (в) что нужно проверить в ZCode — помечено **needs ZCode evidence**.

### R1. Явная матрица «sandbox × approval» вместо одного режима
- **Доказательство:** Codex разделяет `sandbox_mode` (`read-only`/`workspace-write`/`danger-full-access`) и `approval_policy` (`on-request`/`never`/`granular` с пятью подкатегориями) — https://learn.chatgpt.com/codex/sandbox, https://learn.chatgpt.com/codex/config-file/config-reference. Cursor делает то же через Run Modes (Auto-review/Allowlist/Run Everything) — https://cursor.com/docs/agent/security/run-modes.md. Devin — Allow/Ask/Deny + `--sandbox` — https://docs.devin.ai/desktop/devin-local/permissions.md.
- **Что даёт:** пользователь понимает, что именно ограничено физически, а что требует подтверждения; enterprise-политики применяются к каждой оси отдельно.
- **needs ZCode evidence:** проверить, есть ли в ZCode независимые оси sandbox и approval, или они слиты в один режим; проверить `apps/zcode-cli/packages/adapters/src/config/schema.ts` (permission schema) и `packages/shared/src/hooks.ts`. Без этого нельзя утверждать, что разрыв существует.

### R2. Granular approvals с отдельным reviewer-агентом
- **Доказательство:** Codex `approvals_reviewer = "user" | "auto_review"` и auto-review, который «sends eligible approval requests to a separate reviewer agent» — https://learn.chatgpt.com/codex/config-file/config-reference, https://learn.chatgpt.com/docs/sandboxing/auto-review.md. Cursor Auto-review использует classifier — https://cursor.com/docs/agent/security/run-modes.md. Copilot — assisted permissions, «automatically approve those it judges to be safe» — https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli.
- **Что даёт:** меньше prompt fatigue без потери контроля; reviewer-агент видит контекст запроса, а не только команду.
- **needs ZCode evidence:** проверить, есть ли в ZCode PermissionRequest-hook и возможность подменить решение; см. `packages/shared/src/hooks.ts` (`PermissionRequest`) и `packages/services/src` permission broker. Нужно подтвердить, что broker — единственная точка решения.

### R3. `AGENTS.md` с диагностикой лимита и приоритета
- **Доказательство:** Codex: порядок override → AGENTS.md → fallback, конкатенация от корня к cwd, `project_doc_max_bytes` 32 KiB — https://learn.chatgpt.com/codex/guides/agents-md. Copilot: `AGENTS.md` в любом месте, ближайший выигрывает — https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions. Cursor: `AGENTS.md` + `.mdc` с приоритетом Team → Project → User — https://cursor.com/docs/context/rules. Devin: пять имён файлов трактуются идентично — https://docs.devin.ai/cli/extensibility/rules.md.
- **Что даёт:** предсказуемость; отсутствие «молча обрезанных» инструкций.
- **needs ZCode evidence:** проверить, какой лимит и какой порядок слияния у ZCode; есть ли диагностика при превышении. Смотреть `packages/services/src` context assembly и `AGENTS.md`-лоадер. **Не копировать** молчаливое обрезание (см. do-not-copy Codex).

### R4. Hooks как стабильный контракт с явным списком событий
- **Доказательство:** Codex — 14 событий, `command`/`mcp_tool`, trust review — https://learn.chatgpt.com/codex/hooks. Copilot — 6 событий в CLI и cloud — https://docs.github.com/en/copilot/reference/hooks-reference. Cursor — 18+ событий, включая Tab и app lifecycle, `failClosed` — https://cursor.com/docs/agent/hooks. Devin — 7 событий, подхват `.claude/` hooks — https://docs.devin.ai/cli/extensibility/hooks/overview.md.
- **Что даёт:** экосистема авторов хуков; совместимость с Claude Code-хуками (Cursor и Devin это делают явно).
- **needs ZCode evidence:** в ZCode уже есть `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop` (см. `apps/zcode-cli/packages/adapters/src/config/schema.ts:217-336` и `packages/shared/src/hooks.ts`). Нужно проверить: есть ли `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `SessionEnd`, и есть ли trust-review для project-hooks (частично есть — `workspace-hook-trust-store-file.ts`). Рекомендация формулируется как «добавить недостающие события», а не «внедрить hooks с нуля».

### R5. Skills с progressive disclosure и единым путём `.agents/skills`
- **Доказательство:** Codex: `.agents/skills` (cwd, родители, корень), `$HOME/.agents/skills`, `/etc/codex/skills`, `/skills` или `$` — https://learn.chatgpt.com/codex/skills. Cursor: Agent Skills как открытый стандарт, автообнаружение, `/skill-name` — https://cursor.com/docs/skills.md. Devin: `SKILL.md`, свои permissions, auto-approved tools — https://docs.devin.ai/cli/extensibility/skills/overview.md. Copilot: `SKILL.md` со схемой frontmatter (`allowed-tools`, `user-invocable`, `disable-model-invocation`) — https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference.
- **Что даёт:** переносимость скиллов между инструментами; снижение контекста за счёт загрузки по требованию.
- **needs ZCode evidence:** в ZCode скиллы уже есть (`packages/services/src/skills/skillsService.ts`, `.agents/skills` в репозитории). Проверить: поддержан ли `allowed-tools`/`user-invocable`/`disable-model-invocation`, и совпадает ли набор discovery-путей с Codex/Cursor.

### R6. Evals как версионируемые файлы в репозитории
- **Доказательство:** Cursor Agent SDK: `evals/**/*.eval.ts|js`, `defineEval`, `iterations` 1–100 — https://cursor.com/docs/agent-sdk/reference/evals.md, https://cursor.com/docs/agent-sdk. Copilot публикует ReviewBench как открытый бенчмарк code review — https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/. Codex ведёт `feature-maturity` (Stable/Beta/Experimental/Deprecated) — https://learn.chatgpt.com/docs/feature-maturity.md.
- **Что даёт:** регрессии агентного поведения ловятся в CI, а не в проде; «качество агента» становится измеримым.
- **needs ZCode evidence:** есть ли в ZCode harness для прогонки сценариев агента как тестов (не только unit). Проверить `apps/zcode-cli/packages/bootstrap/tests` и наличие eval-подобных фикстур. Если harness отсутствует — это реальный пробел, но его нужно подтвердить, а не предполагать.

### R7. Worktree как объект первого класса с Handoff
- **Доказательство:** Codex: `Local checkout` / `Worktree` / `Handoff`, background worktrees для scheduled tasks — https://learn.chatgpt.com/docs/environments/git-worktrees.md. Devin: New/Existing + Merge, но «нельзя перенести сессию» — https://docs.devin.ai/desktop/devin-local/worktrees.md.
- **Что даёт:** параллельная работа без гонок за рабочую копию; безопасный фон.
- **needs ZCode evidence:** в ZCode есть `packages/services/src/git/repo/gitCheckpointRepo.ts` и упоминания worktree в `gitCliRepo.ts`/`skillsService.ts`. Проверить, является ли worktree полноценным объектом сессии или только утилитой. **Не копировать** ограничение Devin «worktree выбирается только на старте».

### R8. OTel-экспорт с разделением метрик и логов
- **Доказательство:** Codex: `otel.exporter`, `otel.trace_exporter`, `otel.metrics_exporter` (`none|statsig|otlp-http|otlp-grpc`) — https://learn.chatgpt.com/codex/config-file/config-reference. Cursor: OTLP/HTTP protobuf `/v1/metrics` и `/v1/logs`, opt-in conversation content, export server-side — https://cursor.com/docs/enterprise/opentelemetry-export.md. Copilot: OTel off by default, три способа включения — https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference.
- **Что даёт:** enterprise-клиенты подключают свой collector без вендорского дашборда; off-by-default снимает вопрос приватности.
- **needs ZCode evidence:** есть ли в ZCode `otel`-ключи в конфиге и экспортёр. Проверить `apps/zcode-cli/packages/adapters/src/config/schema.ts` на наличие telemetry-секции. Если нет — это кандидат, но приоритет зависит от наличия enterprise-заказчиков (данных нет).

### R9. Прозрачный биллинг BYOK
- **Доказательство:** Copilot Usage API разделяет `used_local_byok` и `is_custom_enterprise_model` — https://github.blog/changelog/2026-11-03-byok-and-enterprise-custom-models-in-the-copilot-usage-api/. Cursor явно пишет, что ключ «is not stored on our servers», но «sent to our backend with every request» — https://cursor.com/help/models-and-usage/api-keys.md. Codex даёт `auth.command` (токен печатается в stdout) — https://learn.chatgpt.com/codex/config-file/config-reference.
- **Что даёт:** пользователь понимает, куда уходят деньги и креды; enterprise может отделить BYOK-трафик.
- **needs ZCode evidence:** есть ли в ZCode учёт usage по провайдерам и различимо ли BYOK в телеметрии. Проверить `packages/shared/src/api-key-usage-scene.ts` и `packages/services/src` usage-сервисы. **Не копировать** отправку ключа на backend без явного согласия.

### R10. Импорт конфигурации из конкурирующих инструментов
- **Доказательство:** Devin CLI `read_config_from` импортирует настройки из Cursor, Windsurf, Claude Code, GitHub Copilot, Codex, Kiro, OpenCode, Zed — https://docs.devin.ai/cli/reference/configuration/read-config-from.md. ZCode уже импортирует Claude-сессии (`packages/services/src/session/claude-native/claudeNativeSessionImportRepo.ts`).
- **Что даёт:** снижение стоимости перехода; реальный канал миграции пользователей.
- **needs ZCode evidence:** подтвердить, какие источники уже поддержаны, и есть ли импорт `AGENTS.md`/`.cursor/rules`/`.windsurf/rules`. Без замера спроса приоритет неясен.

### Приоритизация (гипотеза, требует ZCode-подтверждения)
- **Высокий приоритет:** R4 (дополнить hook-события — низкая цена, высокая совместимость), R3 (диагностика `AGENTS.md`), R1 (если оси слиты).
- **Средний:** R2, R5, R7, R9.
- **Требует решения продукта:** R6 (evals-harness), R8 (OTel), R10 (импорт).

## 8. BLOCKED-источники (точные URL, ошибка, дата)

| URL | Ошибка | Дата | Что не удалось подтвердить |
| --- | --- | --- | --- |
| https://openai.com/codex/ | HTTP 403 Forbidden | 2026-11-11 | Маркетинговое позиционирование Codex с корпоративного сайта |
| https://developers.openai.com/codex/ | 308 → https://learn.chatgpt.com/docs (redirect) | 2026-11-11 | Старый путь; содержимое получено с целевого URL |
| https://developers.openai.com/codex/cli | 308 → https://learn.chatgpt.com/docs/codex/cli | 2026-11-11 | То же |
| https://learn.chatgpt.com/docs/codex/sandbox | HTTP 404 | 2026-11-11 | Канонический путь sandbox-докой; содержимое получено с `/codex/sandbox` |
| https://learn.chatgpt.com/docs/codex/cloud | HTTP 404 | 2026-11-11 | Канонический путь cloud-докой; получено с `/codex/cloud` |
| https://learn.chatgpt.com/docs/codex/codex-sdk | HTTP 404 | 2026-11-11 | Канонический путь SDK; получено с `/docs/codex-sdk.md` |
| https://learn.chatgpt.com/docs/codex/changelog | HTTP 404 | 2026-11-11 | Страница changelog Codex; версии получены из GitHub Releases |
| https://learn.chatgpt.com/docs/changelog.md | «Not found» | 2026-11-11 | Markdown-вариант changelog |
| https://learn.chatgpt.com/sitemap.xml | HTTP 404 | 2026-11-11 | Полная карта доков; пути восстановлены через `llms.txt` |
| https://learn.chatgpt.com/docs/llms.txt | Извлечение вернуло пустой текст | 2026-11-11 | Индекс; получен через `https://learn.chatgpt.com/llms.txt` |
| https://learn.chatgpt.com/docs/pricing.md (повторные запросы) | HTTP 403 «Forbidden» (rate limit) | 2026-11-11 | Повторное чтение тарифов; первичное чтение и HTML-страница `/codex/pricing` получены |
| https://learn.chatgpt.com/docs/sandboxing.md | HTTP 403 Forbidden | 2026-11-11 | Обзор sandboxing; частично компенсировано `/codex/sandbox` |
| https://learn.chatgpt.com/docs/hooks.md | HTTP 403 Forbidden | 2026-11-11 | Markdown hooks; получено с `/codex/hooks` |
| https://learn.chatgpt.com/docs/models.md | HTTP 403 Forbidden | 2026-11-11 | Каталог моделей; названия моделей получены из `/docs` и `/codex/pricing` |
| https://learn.chatgpt.com/docs/computer-use.md | HTTP 403 Forbidden | 2026-11-11 | Computer use в Codex — не подтверждён |
| https://learn.chatgpt.com/docs/open-source.md | HTTP 403 Forbidden | 2026-11-11 | Список open-source компонентов |
| https://learn.chatgpt.com/docs/agent-configuration/agents-md.md | HTTP 403 Forbidden | 2026-11-11 | Markdown AGENTS.md; получено с `/codex/guides/agents-md` |
| https://learn.chatgpt.com/docs/agent-configuration/subagents.md | HTTP 403 Forbidden | 2026-11-11 | Markdown subagents; получено с `/codex/subagents` |
| https://learn.chatgpt.com/docs/extend/record-and-replay.md | HTTP 403 Forbidden | 2026-11-11 | Record & Replay |
| https://learn.chatgpt.com/codex/extend | HTTP 404 | 2026-11-11 | Индекс Extend-раздела |
| https://docs.github.com/en/copilot/concepts/agents/custom-agents | HTTP 404 | 2026-11-11 | Неверный путь; корректный — `/en/copilot/concepts/customizations/custom-agents` |
| https://docs.github.com/en/copilot/concepts/agents/copilot-workspace | HTTP 404 | 2026-11-11 | Документация Copilot Workspace отсутствует |
| https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-workspace | HTTP 404 | 2026-11-11 | То же |
| https://docs.github.com/en/copilot/using-github-copilot/copilot-workspace | HTTP 404 | 2026-11-11 | То же |
| https://docs.github.com/en/copilot/reference/copilot-workspace | HTTP 404 | 2026-11-11 | То же |
| https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/assign-issues-to-copilot | HTTP 404 | 2026-11-11 | Точный flow назначения issue; частично получен из `/cloud-agent` |
| https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent/assign-issues-to-copilot | HTTP 404 | 2026-11-11 | То же |
| https://docs.github.com/en/copilot/concepts/agents/delegate-and-parallelize-work | HTTP 404 | 2026-11-11 | Корректный путь найден через docs search API |
| https://docs.github.com/en/copilot/concepts/agents/about-agents | HTTP 404 | 2026-11-11 | То же |
| https://docs.github.com/en/copilot/concepts/agents/copilot-sdk | HTTP 404 | 2026-11-11 | Copilot SDK — контракт не подтверждён |
| https://docs.github.com/en/copilot/how-tos/copilot-sdk/quickstart | HTTP 404 | 2026-11-11 | То же |
| https://github.blog/changelog/2025-05-19-copilot-workspace-technical-preview-is-now-retired/ | HTTP 404 | 2026-11-11 | Гипотетизированное объявление о выводе Workspace — не существует по этому URL; факт вывода остаётся `unverified` |
| https://github.com/githubnext/copilot-workspace | HTTP 404 | 2026-11-11 | Репозиторий проекта; `gh api` также 404 |
| https://github.com/github/copilot-workspace | HTTP 404 | 2026-11-11 | То же |
| https://githubnext.com/projects/copilot-workspace | HTTP 200, но текст содержит только заголовок | 2026-11-11 | Статус проекта; бейдж «Completed» получен с `/projects` |
| https://docs.cursor.com/ | 308 → https://cursor.com/docs | 2026-11-11 | Старый домен; содержимое получено с целевого |
| https://cursor.com/docs/agent/checkpoints | HTTP 404 | 2026-11-11 | Отдельная страница checkpoints; механика получена из `/docs/agent/overview` |
| https://cursor.com/docs/context/memories | HTTP 404 | 2026-11-11 | Cursor Memories в IDE не существует; страница про Rules |
| https://cursor.com/docs/models.md | «Page not found» | 2026-11-11 | Корректный путь — `/docs/models-and-pricing.md` |
| https://cursor.com/docs/settings/api-keys.md | «Page not found» | 2026-11-11 | Корректный путь — `/help/models-and-usage/api-keys.md` |
| https://cursor.com/docs/cloud-agents/environments | HTTP 404 | 2026-11-11 | Environments-страница; частично компенсировано `/docs/cloud-agent.md` |
| https://docs.windsurf.com/ | 307 → https://docs.devin.ai/desktop/getting-started | 2026-11-11 | Старый домен; содержимое получено с целевого |
| https://windsurf.com/ | 308 → https://devin.ai/desktop | 2026-11-11 | Маркетинговый лендинг Windsurf больше не существует отдельно |
| https://windsurf.com/pricing | 308 → https://devin.ai/pricing | 2026-11-11 | То же |
| https://windsurf.com/blog | 308 → https://devin.ai/blog | 2026-11-11 | То же |
| https://devin.ai/desktop | Таймаут 60 с | 2026-11-11 | Маркетинговое описание Devin Desktop; компенсировано `docs.devin.ai/desktop/introducing-devin-desktop.md` |
| https://docs.devin.ai/desktop/features | HTTP 404 | 2026-11-11 | Индекс фич; восстановлен через `_llms/en/desktop.txt` |
| https://docs.devin.ai/desktop/devin-local/memories.md | Page Not Found | 2026-11-11 | Memories для Devin Local; память документирована только для Cascade |
| https://docs.devin.ai/desktop/devin-local/browser.md | Page Not Found | 2026-11-11 | Browser-tool Devin Local не подтверждён |
| https://docs.devin.ai/desktop/accounts/quota-based-usage | HTTP 404 | 2026-11-11 | Механика квот; получена из `/admin/billing/self-serve.md` |
| https://devin.ai/blog | 200, но Windsurf/Cognition не упомянуты | 2026-11-11 | Официальный статус ребрендинга; получен из FAQ доков |
| https://github.blog/changelog/2025-02-28-... (поиск по «retired») | Релевантных записей о Workspace нет | 2026-11-11 | Формальное объявление о выводе Workspace |

## 9. Сводка

- **Проверено первичных URL:** 110 уникальных в таблице источников (109 `confirmed`, 1 `unverified`), плюс 52 недоступных URL в разделе 8.
- **Статус `unverified`:** страница `githubnext.com/projects/copilot-workspace` (200, но без статуса); атрибуция Cursor↔xAI (прямого заявления нет, только «Jointly trained by Cursor and SpaceXAI»); Copilot SDK (все проверенные пути 404); формальный вывод Copilot Workspace (объявления нет, но документация отсутствует — `confirmed` отсутствие доков).
- **Ключевой риск достоверности:** документация всех четырёх продуктов переехала в 2025–2026 (developers.openai.com → learn.chatgpt.com; docs.cursor.com → cursor.com/docs; docs.windsurf.com → docs.devin.ai; windsurf.com → devin.ai), из-за чего значительная часть внешних ссылок и часть внутренних путей отдают 404. Это отдельный наблюдаемый факт, а не артефакт сбора.
- **Что подтверждено сильно:** sandbox/approval-модели Codex и Devin; git/PR-гейты и биллинг BYOK Copilot; hooks/skills/evals Cursor; факт ребрендинга Windsurf → Devin Desktop и приобретений Cognition/SpaceX.
- **Что осталось неподтверждённым:** формальный статус Copilot Workspace; наличие первоклассного browser-tool у Codex и Devin; OTel у Devin; Cursor Memories в IDE; точные лимиты конкурентности Codex Cloud.
