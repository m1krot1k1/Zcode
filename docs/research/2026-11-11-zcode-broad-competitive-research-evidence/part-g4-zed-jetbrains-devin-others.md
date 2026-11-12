# BRANCH G4 — Zed AI, JetBrains AI, Devin, Claude Code, Gemini CLI + короткий скан прочих

**Дата доступа:** 2026-11-11, окно 06:08:06Z — 06:39:37Z (UTC).
**Тип документа:** evidence appendix к широкому конкурентному исследованию ZCode. Только исследование: продуктовый код, конфиги и зависимости не менялись.
**Автор:** competitive research analyst (профиль implementer использован только для записи этого файла).

## 0. Методика и границы

- Использованы только первичные источники: официальная документация, официальные репозитории/releases/changelogs, официальные блоги и официальные страницы цен.
- Каждое утверждение в таблицах источников помечено статусом:
  - `confirmed` — факт прямо подтверждён текстом официальной страницы;
  - `marketing` — формулировка самой компании о себе (позиционирование, заявления о превосходстве), не проверяемая независимо;
  - `unverified` — источник официальный, но утверждение не удалось подтвердить первоисточником (например, пересказ сделки в новостном индексе);
  - `BLOCKED` — страница недоступна; зафиксированы точный URL, ошибка и дата. Из памяти содержание не восстанавливалось.
- `WebSearch` в этой сессии недоступен как отдельный инструмент; навигация велась по официальным индексам документации (`llms.txt`), картам сайтов и переходам внутри официальных домены. Это ограничивает полноту: часть страниц могла не попасть в выборку.
- Вторичные обзоры не использовались как единственная опора ни для одного утверждения. Единственное исключение — новостной индекс Tricentis (см. S122), и он явно помечен `unverified`.
- Конфликты между официальными страницами не сглаживались, а зафиксированы (см. §9.1 про Gemini CLI и §5.3 про JetBrains).

### 0.1. Базовый срез репозитория (baseline)

| Параметр | Значение |
| --- | --- |
| Репозиторий | `<repo-root>` |
| Ветка | `dev` |
| HEAD | `d10f0b69f98677091e0428a92839e4a1e01e04ca` («Выпустить macOS Preview 3.17.102.») |
| `git status --short` до записи | пусто (чистое дерево) |
| `git status --short` после записи | `?? docs/research/` (только каталог этого артефакта) |
| Пять последних коммитов | `d10f0b69`, `bbb756e8`, `fc70a81b`, `982e30c9`, `05bd5b31` |

Запись ограничена одним путём: `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/part-g4-zed-jetbrains-devin-others.md`. Коммитов, установок и изменений production-кода не выполнялось.

---

## 1. Таблица источников

### 1.1. Zed AI

| ID | URL | Дата доступа | Статус | Что подтверждает |
| --- | --- | --- | --- | --- |
| S1 | https://zed.dev/docs/ai/overview | 2026-11-11 | confirmed | Набор AI-функций: «Agent Panel», «Parallel Agents», «Inline Assistant», «Edit Prediction», «Git commit generation»; три пути агента: «Zed Agent», «External Agents», «Terminal Threads»; варианты доступа к моделям: Zed-hosted, provider API keys, subscription sign-in, gateways, local models |
| S2 | https://zed.dev/docs/ai/tools | 2026-11-11 | confirmed | 16 встроенных инструментов: `diagnostics`, `fetch`, `find_path`, `grep`, `list_directory`, `read_file`, `search_web`, `copy_path`, `create_directory`, `delete_path`, `edit_file`, `move_path`, `write_file`, `terminal`, `skill`, `spawn_agent`; `search_web` доступен только Pro-подписчикам на Zed-провайдере |
| S3 | https://zed.dev/docs/ai/llm-providers | 2026-11-11 | confirmed | Пути доступа: «Use Zed-Hosted Models», «Use API Access», «Use an Existing Subscription», «Use a Gateway» (OpenRouter, Bedrock, Vercel), «Use a Local Model»; fallback не документирован |
| S4 | https://zed.dev/docs/ai/agent-panel | 2026-11-11 | confirmed | Параллельные потоки, Threads Sidebar, thread switcher, «Steer» только для Zed Agent, «Review Changes», `agent.single_file_review`, приёмка/отклонение хунков |
| S5 | https://zed.dev/docs/ai/tool-permissions | 2026-11-11 | confirmed | Значения `allow`/`deny`/`confirm`, ключ `agent.tool_permissions`, массивы `always_allow`/`always_deny`/`always_confirm`, правила `pattern` + `case_sensitive`, жёсткий приоритет built-in правил, hardcoded защита `terminal` от рекурсивного удаления `/`, `~`, `$HOME`, `.`, `..` |
| S6 | https://zed.dev/docs/ai/agent-profiles | 2026-11-11 | confirmed | Профили `agent.profiles` управляют доступностью инструментов и моделью, а не разрешениями; встроенные профили `Write`, `Ask`, `Minimal`; поля `name`, `tools`, `enable_all_context_servers`, `context_servers`, `default_model` |
| S7 | https://zed.dev/docs/ai/skills | 2026-11-11 | confirmed | Skills из `~/.agents/skills/` и `<worktree>/.agents/skills/`, обязательный `SKILL.md` с frontmatter `name`/`description`, опциональный `disable-model-invocation`, progressive disclosure, project-local приоритет, загрузка только из trusted worktrees |
| S8 | https://zed.dev/docs/ai/mcp | 2026-11-11 | confirmed | Ключ `context_servers`; локальные `command`/`args`/`env`, удалённые `url`/`headers` + стандартный MCP OAuth; поддержаны Tools и Prompts, нет Discovery/Sampling/Elicitation; per-tool правила `mcp:<server>:<tool_name>` |
| S9 | https://zed.dev/docs/ai/edit-prediction | 2026-11-11 | confirmed | Модель по умолчанию `Zeta` (open source), провайдеры GitHub Copilot, Mercury Coder, Codestral, Ollama, OpenAI-compatible self-hosted; форматы `zeta`, `zeta2`, `zeta2_1`, `code_llama`, `star_coder`, `deepseek_coder`, `qwen`, `code_gemma`, `codestral`, `glm`, `sweep`; контекст отправляется провайдеру |
| S10 | https://zed.dev/docs/ai/external-agents | 2026-11-11 | confirmed | ACP-агенты через ACP Registry: Claude Agent, Codex, Gemini CLI, OpenCode, Copilot, Cursor, Pi Coding Agent, Poolside; биллинг/данные/аутентификация — между пользователем и провайдером агента; Zed не берёт плату за External Agents |
| S11 | https://zed.dev/docs/ai/parallel-agents | 2026-11-11 | confirmed | Изоляция не автоматическая: «If two threads might edit the same files, start one in a new Git worktree»; новый worktree в detached HEAD; хук `create_worktree` с `ZED_WORKTREE_ROOT` и `ZED_MAIN_GIT_WORKTREE`; running threads нельзя переместить в историю до завершения |
| S12 | https://zed.dev/docs/ai/privacy-and-security | 2026-11-11 | confirmed | «Zed does not retain your prompts or code context by default»; zero data retention в соглашениях с провайдерами, кроме Covered Models с safety-retention (Anthropic, минимум 30 дней); ключи в системном keychain, не в `settings.json` |
| S13 | https://zed.dev/docs/ai/ai-improvement | 2026-11-11 | confirmed | Рейтинг ответа отправляет тред в Zed; opt-in на training data требует одновременно opt-in, open-source проект и отсутствие исключения; телеметрия AI-функций собирается отдельно; данные в Snowflake, анонимизируются |
| S14 | https://zed.dev/docs/ai/sandboxing | 2026-11-11 | confirmed | macOS `Seatbelt`/`sandbox-exec`, Linux `Bubblewrap`, Windows только через WSL; ограничивает `terminal` (запись ФС и сеть, защита Git-метаданных) и `fetch` (хосты); ключи `agent.sandbox_permissions.network_hosts`, `allow_all_hosts`, `write_paths`, `allow_fs_write_all`, `allow_unsandboxed` |
| S15 | https://zed.dev/docs/ai/instructions | 2026-11-11 | confirmed | Personal `~/.config/zed/AGENTS.md`; project — первый совпавший из `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; project переопределяет personal |
| S16 | https://zed.dev/docs/ai/agents | 2026-11-11 | confirmed | Таблица трёх путей агента и их различий по моделям/конфигурации; «An agent path is sometimes called a harness» |
| S17 | https://zed.dev/docs/ai/agent-settings | 2026-11-11 | confirmed | Автоматическая компакция включена по умолчанию при 90% контекстного окна; `agent.compaction_model`, `agent.thread_summary_model`; настройка `auto_compact` принимает процент, абсолютное число токенов и отрицательное «сколько останется» |
| S18 | https://zed.dev/docs/account/plans-and-pricing | 2026-11-11 | confirmed | Free/Pro/Student/Business; Zed-hosted модели только с Pro и выше; Pro включает $5 месячного кредита; Student — $10/мес кредита и без Fable/Opus/pro-моделей |
| S19 | https://zed.dev/docs/account/zed-hosted-models | 2026-11-11 | confirmed | Наценка к прайсу провайдера +10% (пример: Claude Fable 5.1 $10 → $11 input, $50 → $55 output) |
| S20 | https://zed.dev/docs/git | 2026-11-11 | confirmed | LLM-генерация commit message, действие `git: generate commit message`, `commit_message_model`, `commit_message_instructions`; AI-функций diff/review не документировано |
| S21 | https://zed.dev/releases | 2026-11-11 | confirmed | Актуальный стабильный релиз 1.27.0 от 04.11.2026; в нём — снижение памяти Agent Panel, стилевые примеры commit message из трёх последних коммитов |
| S22 | https://zed.dev/pricing | 2026-11-11 | confirmed (числа) / marketing (позиционирование) | Personal $0, Pro $10/мес, Business $30/место/мес; Pro: unlimited edit predictions + $5 токенов, далее usage-based; Business без фиксированного LLM-кредита, org-wide AI policies, SSO/SAML/SCIM «planned» |
| S23 | https://zed.dev/docs/ai/zed-agent | 2026-11-11 | confirmed | Zed Agent читает/ищет проект, редактирует файлы, запускает команды, использует Zed-managed MCP, следует профилям, Skills и Instructions; пошаговый agent loop не документирован |

### 1.2. Claude Code

| ID | URL | Дата доступа | Статус | Что подтверждает |
| --- | --- | --- | --- | --- |
| S24 | https://code.claude.com/docs/en/overview | 2026-11-11 | confirmed (факты) / marketing (позиционирование) | «agentic coding tool», доступен в terminal, IDE, desktop, browser; планирует подход, пишет код в нескольких файлах, верифицирует; lead agent координирует нескольких агентов; hooks, MCP, Skills, Agent SDK |
| S25 | https://code.claude.com/docs/en/tools-reference.md | 2026-11-11 | confirmed | Полный каталог инструментов, включая `Agent`, `Artifact`, `AskUserQuestion`, `Bash`, `CronCreate/Delete/List`, `Edit`, `EnterPlanMode`/`ExitPlanMode`, `EnterWorktree`/`ExitWorktree`, `Glob`, `Grep`, `ListAgents`, `LSP`, `Monitor`, `NotebookEdit`, `PowerShell`, `Read`, `ReadMcpResourceTool`, `RemoteTrigger`, `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `TaskCreate/Get/List/Stop/Update`, `TodoWrite`, `ToolSearch`, `WebFetch`, `WebSearch`, `Workflow`, `Write`; `Glob`/`Grep` по умолчанию отсутствуют на macOS/Linux/WSL |
| S26 | https://code.claude.com/docs/en/sub-agents | 2026-11-11 | confirmed | Субагенты — Markdown + frontmatter в `.claude/agents/`, `~/.claude/agents/`, плагинах; поля `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `isolation`, `effort`; лимит 20 конкурентных субагентов (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), вложенность 3 уровня (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) |
| S27 | https://code.claude.com/docs/en/hooks | 2026-11-11 | confirmed | 33 события, включая `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart/Stop`, `TaskCreated/Completed`, `Stop`, `InstructionsLoaded`, `FileChanged`, `WorktreeCreate/Remove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`; типы обработчиков `command`, `http`, `mcp_tool`, `prompt`, `agent`; выход `permissionDecision: deny` |
| S28 | https://code.claude.com/docs/en/sandboxing | 2026-11-11 | confirmed | macOS Seatbelt, Linux/WSL2 bubblewrap + socat, Windows без sandbox; покрывает только shell-команды и потомков; сеть только через прокси с allowlist (изначально пустым); `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`, `excludedCommands`; файловая изоляция: запись в cwd/temp/added dirs, чтение почти всей машины (включая `~/.ssh`, `~/.aws/credentials`), `sandbox.filesystem.*`, `sandbox.credentials.files/envVars` с режимами `deny`/`mask` |
| S29 | https://code.claude.com/docs/en/memory | 2026-11-11 | confirmed | Иерархия CLAUDE.md: managed → user → project → local; `.claude/rules/**/*.md` и `~/.claude/rules/`; AGENTS.md читается только если нет CLAUDE.md (режимы `claude-md-or-agents-md`, `claude-md-and-agents-md`, `claude-md`, `managed-only`); импорты `@path` до 4 уровней; project-root CLAUDE.md переживает `/compact`; auto memory в `~/.claude/projects/<project>/memory/` с `MEMORY.md` (первые 200 строк или 25KB) |
| S30 | https://code.claude.com/docs/en/checkpointing | 2026-11-11 | confirmed | Чекпоинт на каждый промпт, 100 последних на сессию, `/rewind` или двойной Esc; варианты «Restore code and conversation», «Restore conversation», «Restore code», «Summarize from here/up to here»; не отслеживает изменения только через Bash, правки субагентов, внешние и параллельные сессии; симлинки и хардлинки пропускаются |
| S31 | https://code.claude.com/docs/en/permission-modes.md | 2026-11-11 | confirmed | Режимы `default` (Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`; в `plan` правки заблокированы до утверждения плана; `bypassPermissions` — только для изолированных контейнеров/VM |
| S32 | https://code.claude.com/docs/en/auto-mode-config.md | 2026-11-11 | confirmed | Auto mode: классификатор блокирует «irreversible, destructive, or aimed outside your environment»; `hard_deny` выше `soft_deny`, `allow` переопределяет `soft_deny`; встроенные soft-правила — force push, `curl \| bash`, production deploy; конфиг `autoMode.environment`, `allow`, `soft_deny`, `hard_deny`, `classifyAllShell`; project settings не читаются |
| S33 | https://code.claude.com/docs/en/mcp.md | 2026-11-11 | confirmed | Транспорты HTTP (рекомендуемый), SSE (deprecated), stdio, WebSocket (только JSON), `sdk`; скоупы local (`~/.claude.json`), project (`.mcp.json`), user, plugin; порядок приоритета local → project → user → plugin → claude.ai connectors, managed выше; project-серверы требуют подтверждения в интерактиве; `disabledMcpjsonServers`, `--strict-mcp-config` |
| S34 | https://code.claude.com/docs/en/skills.md | 2026-11-11 | confirmed | `SKILL.md` в `.claude/skills/<name>/`, `~/.claude/skills/`, nested, plugin, `~/.claude/skills/synced/`; «Custom commands have been merged into skills»; поля `description`, `when_to_use`, `paths`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `context: fork`, `agent`, `background`, `model`, `effort`, `hooks`; `$ARGUMENTS`, `$N`, `` !`command` `` |
| S35 | https://code.claude.com/docs/en/plugins/overview.md | 2026-11-11 | confirmed | Плагин = каталог с `.claude-plugin/plugin.json`, может включать skills, agents, hooks, MCP servers; marketplace = `.claude-plugin/marketplace.json`, тиры Official/Community/Third-party; плагины исполняют код с правами пользователя |
| S36 | https://code.claude.com/docs/en/agent-sdk/agent-loop.md | 2026-11-11 | confirmed | Цикл: промпт → оценка → инструменты → результаты → повтор до ответа без tool calls; типы сообщений `SystemMessage` (в т.ч. `compact_boundary`), `AssistantMessage`, `UserMessage`, `StreamEvent`, `ResultMessage`; `max_turns`, `max_budget_usd`; read-only инструменты параллельны, изменяющие последовательны; авто-компакция суммирует старую историю |
| S37 | https://code.claude.com/docs/en/agent-sdk/overview.md | 2026-11-11 | confirmed | Agent SDK даёт тот же loop, инструменты и управление контекстом в Python/TypeScript; отдельно Managed Agents — хостингуемый harness в облачном или self-hosted sandbox |
| S38 | https://code.claude.com/docs/en/worktrees.md | 2026-11-11 | confirmed | `--worktree`/`-w`, каталог `.claude/worktrees/<name>/`, ветка `worktree-<name>`; `isolation: worktree` во frontmatter субагента; `.worktreeinclude` копирует gitignored файлы; `worktree.baseRef` `fresh`/`head`; хуки `WorktreeCreate`/`WorktreeRemove` для не-git VCS |
| S39 | https://code.claude.com/docs/en/claude-code-on-the-web.md | 2026-11-11 | confirmed | `--cloud` создаёт облачную сессию на claude.ai (один репозиторий, клонирует remote текущей ветки); `--teleport` возвращает сессию локально с проверками (чистое дерево, тот же репозиторий, запушенная ветка); недоступно на Bedrock/Vertex; bundle < 100 MB |
| S40 | https://code.claude.com/docs/en/claude-projects.md | 2026-11-11 | confirmed | Project = долгоживущая сессия-координатор, threads с отдельными контекстами; облачные threads стартуют с репозиториев, инструкций (до 16 000 символов) и памяти (`MEMORY.md`); лимиты 1 000 файлов / 2 GB, 500 новых threads в день; public beta на Pro/Max/Ultra, нет на Team/Enterprise |
| S41 | https://code.claude.com/docs/en/remote-control.md | 2026-11-11 | confirmed | Remote Control связывает claude.ai/мобильное приложение с локальным процессом; исполнение остаётся локальным; только подписки Pro/Max/Ultra/Team/Enterprise, API-ключи не поддерживаются; одна remote-сессия на интерактивный процесс; транскрипт хранится на серверах Anthropic |
| S42 | https://code.claude.com/docs/en/github-actions | 2026-11-11 | confirmed | `anthropics/claude-code-action@v1` запускает Claude Code в GitHub Actions; триггер `@claude` (полное слово, Write access, human actor); `use_bedrock`, `use_vertex`, `use_foundry` через OIDC |
| S43 | https://code.claude.com/docs/en/monitoring-usage.md | 2026-11-11 | confirmed | OTel: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`; метрики `claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `cost.usage`, `token.usage`, `code_edit_tool.decision`, `active_time.total`; события `claude_code.user_prompt`, `tool_result`, `tool_decision`, `api_request`, `api_error`; контент-логирование за флагами `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` |
| S44 | https://code.claude.com/docs/en/code-review.md | 2026-11-11 | confirmed | Code Review для PR в GitHub, несколько агентов, верификация и дедупликация находок; check run «Claude Code Review» не блокирует и не аппрувит; только Team/Enterprise; глубина `Quick`/`Standard`/`Deep`; read-only доступ, код не собирается и не запускается |
| S45 | https://claude.com/pricing | 2026-11-11 | confirmed (числа) / marketing (позиционирование) | Free $0 без Claude Code; Pro $17/мес при годовой оплате ($200 сразу) или $20/мес; Max $100/мес (5x Pro); Ultra $200/мес (10x Pro weekly); Team $20–25/место стандарт и $100–125 премиум; Enterprise $20/место/мес при 20 местах + usage по API-ставкам |
| S46 | https://code.claude.com/docs/en/changelog.md | 2026-11-11 | confirmed | 2.1.322 (10.11.2026) — fast mode на Vertex; 2.1.321 (09.11.2026) — Claude Fable 5.2 как дефолтная Fable, 1M контекст, $8/$40 за Mtok, cache read $0.20/Mtok |
| S47 | https://code.claude.com/docs/en/agent-teams.md | 2026-11-11 | confirmed | Agent teams экспериментальны и выключены по умолчанию (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); team lead координирует, teammates имеют общий список задач и общаются напрямую; известные ограничения по resume, координации и shutdown |
| S48 | https://code.claude.com/docs/en/desktop.md | 2026-11-11 | confirmed | Desktop: параллельные сессии в Code tab, split view, отдельные окна; окружения Local/Cloud/SSH/WSL; worktree по умолчанию выключен, каталог `.claude/worktrees/`; `dontAsk` только в CLI; side chats не сохраняются на диск; GUI-поверхности diff view, Browser pane, Terminal, Files, iOS Simulator, Auto-fix, Merge when ready, Remote Control |
| S49 | https://code.claude.com/docs/en/features-overview.md | 2026-11-11 | confirmed | Разграничение CLAUDE.md (always-on, < 200 строк), Skills (on-demand), Subagents (изоляция контекста), Hooks (детерминированные триггеры), MCP (внешние системы), Plugins (упаковка) |

### 1.3. Gemini CLI

| ID | URL | Дата доступа | Статус | Что подтверждает |
| --- | --- | --- | --- | --- |
| S50 | https://github.com/google-gemini/gemini-cli (README, raw) | 2026-11-11 | confirmed | Позиционирование «open-source AI agent» в терминале; баннер: «Enterprise Code Assist only», «No free tier or Google AI plans», «Not optimized for Gemini 4+»; переход на Antigravity CLI 18.06.2026; Apache 2.0; каналы nightly/preview/stable (stable по вторникам 20:00 UTC) |
| S51 | https://www.geminicli.com/docs/reference/tools | 2026-11-11 | confirmed | Инструменты `run_shell_command`, `glob`, `grep_search` (алиас `search_file_content`), `list_directory`, `read_file`, `read_many_files`, `replace`, `write_file`, `ask_user`, `write_todos`, `tracker_*`, `list_mcp_resources`, `read_mcp_resource`, `activate_skill`, `get_internal_docs`, `enter_plan_mode`, `exit_plan_mode`, `complete_task`, `google_web_search`, `web_fetch`; `run_shell_command`/`replace`/`write_file` требуют ручного подтверждения |
| S52 | https://www.geminicli.com/docs/core/subagents | 2026-11-11 | confirmed | Кастомные агенты — Markdown + frontmatter в `.gemini/agents/*.md` и `~/.gemini/agents/*.md`; поля `kind`, `tools`, `mcpServers`, `model`, `temperature`, `max_turns` (30), `timeout_mins` (10); встроенные `codebase_investigator`, `cli_help`, `generalist`, `browser_agent`; «subagents cannot call other subagents»; remote через A2A |
| S53 | https://www.geminicli.com/docs/cli/sandbox | 2026-11-11 | confirmed | Методы: macOS Seatbelt, Docker/Podman, Windows Native Sandbox, gVisor/runsc, LXC/LXD (experimental); `tools.sandbox` принимает `true`/`"docker"`/`"podman"`/`"sandbox-exec"`/`"runsc"`/`"lxc"`; `security.toolSandboxing`; env `GEMINI_SANDBOX`, `SANDBOX_MOUNTS`, `SANDBOX_FLAGS` |
| S54 | https://www.geminicli.com/docs/cli/checkpointing | 2026-11-11 | confirmed | Выключено по умолчанию; shadow git repo в `~/.gemini/history/<project_hash>`; `/restore` и `/restore <checkpoint_file>`; чекпоинт создаётся только при одобрении изменяющего инструмента; данные локальны |
| S55 | https://www.geminicli.com/docs/cli/gemini-md | 2026-11-11 | confirmed | Иерархия `~/.gemini/GEMINI.md` → workspace `GEMINI.md` и родители → JIT по доступу инструмента; всё конкатенируется в каждый промпт; импорты `@file.md`; `/memory show`, `/memory reload`; `context.fileName` может включать `AGENTS.md`, `CONTEXT.md`, `GEMINI.md` |
| S56 | https://www.geminicli.com/docs/cli/telemetry | 2026-11-11 | confirmed | OTel логи/метрики/трейсы; атрибуты `session.id`, `installation.id`, `active_approval_mode`, `user.email`; `target` = `gcp`/`local`; ключи `enabled`, `traces`, `otlpEndpoint`, `otlpProtocol`, `otlpHeaders`, `outfile`, `logPrompts`, `useCollector`; телеметрия выключена по умолчанию, `logPrompts` по умолчанию true, детальные атрибуты трейсов opt-in |
| S57 | https://www.geminicli.com/docs/cli/plan-mode.md | 2026-11-11 | confirmed | Plan Mode включён по умолчанию, read-only; `gemini --approval-mode=plan`, Shift+Tab цикл Default → Auto-Edit → Plan, `/plan [goal]`; план пишется Markdown-файлом в plans directory; `enter_plan_mode` недоступен в YOLO mode |
| S58 | https://www.geminicli.com/docs/cli/model-routing.md | 2026-11-11 | confirmed | Fallback при отказе модели включён по умолчанию (`ModelAvailabilityService`), по умолчанию спрашивает пользователя; тихий fallback-чейн для utility-вызовов `gemini-2.5-flash-lite` → `flash` → `pro`; локальный роутер на Gemma (experimental); приоритет `--model` → `GEMINI_MODEL` → `model.name` → local router → default `auto` |
| S59 | https://www.geminicli.com/docs/cli/auto-memory.md | 2026-11-11 | confirmed (experimental) | Auto Memory сканирует прошлые транскрипты и предлагает патчи памяти и черновики `SKILL.md` в project-local inbox; требует ≥10 пользовательских сообщений в idle-сессии; включается `experimental.autoMemory`; ничего не применяется без одобрения |
| S60 | https://www.geminicli.com/docs/cli/rewind.md | 2026-11-11 | confirmed | `/rewind` или двойной Esc; три действия: «Rewind conversation and revert code changes», «Rewind conversation», «Revert code changes»; не отменяет ручные правки и изменения от shell; работает поверх компрессии истории |
| S61 | https://www.geminicli.com/docs/cli/git-worktrees.md | 2026-11-11 | confirmed (experimental) | `experimental.worktrees: true`; `--worktree`/`-w`, каталог `.gemini/worktrees/`, имя = имя ветки |
| S62 | https://www.geminicli.com/docs/cli/trusted-folders | 2026-11-11 | confirmed | Folder trust выключен по умолчанию; `security.folderTrust.enabled`; решения в `~/.gemini/trustedFolders.json`; untrusted = «safe mode»: без project settings и `.env`, без MCP-подключений, без `.toml`-команд, каждое tool-run требует одобрения; `--skip-trust`, `GEMINI_CLI_TRUST_WORKSPACE=true` |
| S63 | https://www.geminicli.com/docs/cli/custom-commands | 2026-11-11 | confirmed | TOML v1, обязательный `prompt`; `~/.gemini/commands/` и `<project>/.gemini/commands/`; project переопределяет user; `{{args}}`, `!{...}`, `@{...}`; `git/commit.toml` → `/git:commit` |
| S64 | https://geminicli.com/docs/extensions/writing-extensions | 2026-11-11 | confirmed | `gemini-extension.json` с `mcpServers`, `settings`, `contextFileName`; вклад: MCP server, custom commands, `GEMINI.md`, Agent Skills (`skills/<name>/SKILL.md`), hooks, themes; sensitive-настройки в системном keychain; `gemini extensions link .` |
| S65 | https://www.geminicli.com/docs/reference/policy-engine.md | 2026-11-11 | confirmed | Политики TOML в `~/.gemini/policies/*.toml`; правило `toolName`, `commandPrefix`, `decision = "deny"`, `priority = 100`; решения allow/deny/confirm |
| S66 | https://www.geminicli.com/docs/cli/skills.md | 2026-11-11 | confirmed | Agent Skills по открытому стандарту agentskills.io; discovery → activation через `activate_skill` → consent prompt → injection → execution; каталог skill'а добавляется в разрешённые пути чтения |
| S67 | https://www.geminicli.com/docs/core/remote-agents.md | 2026-11-11 | confirmed | Remote subagents по Agent-to-Agent (A2A); `kind: remote`; `.gemini/agents/*.md`; proxy через `general.proxy` |
| S68 | https://www.geminicli.com/docs/resources/quota-and-pricing.md | 2026-11-11 | confirmed (таблица) / конфликт с S50 | Таблица лимитов: Google account Code Assist Individual 1 000 запросов/день, AI Pro 1 500, AI Ultra 2 000; API key free 250; Code Assist Standard 1 500, Enterprise 2 000. Страница не отражает баннер о прекращении consumer-доступа |
| S69 | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ | 2026-11-11 | confirmed | Пост 19.05.2026: 18.06.2026 Gemini CLI и Gemini Code Assist IDE extensions перестают обслуживать AI Pro/Ultra и free individual; enterprise-лицензии не затронуты; усилия консолидируются в Antigravity; Antigravity CLI «keeps the most critical features of Gemini CLI» — Skills, Hooks, Subagents, Extensions (переименованы в plugins), но «there won't be 1:1 feature parity right out of the gate» |
| S70 | https://antigravity.google/product/antigravity-cli | 2026-11-11 | marketing | Antigravity CLI: «terminal-first surface», subagents с `/agents`, `ctrl+k` для одобрения инструментов, `/config`, `/keybindings`, slash-команды для plugins/MCP/skills/hooks |
| S71 | https://www.geminicli.com/docs/changelogs.md | 2026-11-11 | confirmed | v0.64.0 (13.10.2026): атомарные операции файловых инструментов, append-only delta patching и bounded history в ChatRecordingService; v0.63.0 (06.10.2026): autonomous plan execution в non-interactive режиме |
| S72 | https://www.geminicli.com/docs/ | 2026-11-11 | confirmed | Индекс документации: Subagents 🔬, Remote subagents 🔬, Checkpointing, Sandboxing, Extensions, MCP servers, Custom commands, Plan mode 🔬, Auto Memory 🔬, Git worktrees 🔬, Policy engine, Telemetry |

### 1.4. JetBrains (AI Assistant, Junie, Air)

| ID | URL | Дата доступа | Статус | Что подтверждает |
| --- | --- | --- | --- | --- |
| S74 | https://www.jetbrains.com/ai/ | 2026-11-11 | marketing | Air как «one system for building software with agents»; Junie «now part of JetBrains Air»; Air поддерживает Claude Agent, Codex, Junie, Copilot, OpenCode через ACP; поверхности JetBrains IDEs, Web, CLI, Mobile (coming soon); «Air Context» — semantic indexing; BYOK/подписки/базовый URL; «Switch between subscriptions – even mid-session» |
| S75 | https://junie.jetbrains.com/ | 2026-11-11 | marketing (цены — confirmed как опубликованные) | Junie: «Advanced Plan Mode» с планами в `.junie/plans`, «Live Prompting», «Human in the Loop» + «Dynamic allowlist», «Remote Control» (async CLI + web monitoring), «Custom Guidelines & Skills», `/commands` через ACP; «10+ models supported via BYOK»; интерфейсы Junie CLI, Air in IDEs, GitHub Action, GitLab CI/CD; Junie Lite бесплатен, AI Pro $8.33/user/мес (10 кредитов), AI Ultimate $25.00/user/мес (35 кредитов), BYOK и local models без наценки |
| S76 | https://www.jetbrains.com/help/ai-assistant/ | 2026-11-11 | confirmed | Функции: «Context-aware AI Chat», «Coding agents», «In-editor AI assistance», «Code insights», «Routine automation»; поддерживаемые IDE: CLion, DataGrip, DataSpell, GoLand, IntelliJ IDEA, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm; контекст — открытый файл, выделение, недавние изменения |
| S77 | https://www.jetbrains.com/help/ai-assistant/supported-llms.html?auth=1 | 2026-11-11 | confirmed | Каталог моделей: Anthropic (Claude Opus 5.5, Sonnet 5.5, Fable 5.1/5, Opus 5, Sonnet 5, 4.8/4.7/4.6/4.5 серии), Google (Gemini 3.8/3.7/3.6 Flash, 3.1/2.5 Pro), OpenAI (GPT-6.1 Sol, GPT-6 Luna/Sol, GPT-5.6/5.5/5.4/5.3 Codex/5.2/5.1/5, o1/o3/o4-mini); xAI Grok удалён/устарел; BYOK через Settings → Tools → AI Assistant → Providers & API keys; локальные модели через Ollama и LM Studio |
| S78 | https://www.jetbrains.com/help/ai-assistant/feature-set.html | 2026-11-11 | confirmed | Полный список фич: cloud code completion, next edit suggestions, рефакторинг, объяснение ошибок, генерация тестов/документации, commit messages, self-review, разрешение Git-конфликтов, «Use third-party and local models», MCP, ACP, «Project rules», «Prompt library»; Junie на странице не упомянут |
| S79 | https://www.jetbrains.com/help/ai-assistant/switch-to-air.html | 2026-11-11 | confirmed | Переход на Air опционален: «AI Assistant can be hidden after the switch», «You can return to AI Assistant at any time»; дата страницы 19.10.2026; даты sunset нет |
| S80 | https://blog.jetbrains.com/ai/ | 2026-11-11 | confirmed | Air in IDEs EAP (октябрь 2026), Air Governance (22.10.2026) — «one place to manage which AI agents, models, and providers your teams use», лимиты расходов и отчётность; livestream 18.11.2026 |
| S81 | https://www.jetbrains.com/help/air/ | 2026-11-11 | confirmed | Air — «a system for building software with AI agents» для individual, teams, managers; поверхности Air in IDEs, Air Teams, Air Governance; setup в JetBrains Console |

### 1.5. Devin (Cognition)

| ID | URL | Дата доступа | Статус | Что подтверждает |
| --- | --- | --- | --- | --- |
| S84 | https://devin.ai/ | 2026-11-11 | marketing | «your team's autonomous software engineer»; cloud или локально; собственный браузер и VM Windows/Mac/Linux; model routing «up to 60% less»; parallel cloud agents; @Devin в Slack/Teams; «Wiki», «Devin Cloud», «Desktop», «CLI», «Devin Review», «Security Swarm»; SOC 2, ISO 27001, FedRAMP, zero data retention, audit logs, отдельная VM на сессию, RBAC/SSO/SCIM/OIDC |
| S85 | https://devin.ai/pricing | 2026-11-11 | confirmed (числа) / marketing (позиционирование) | Free $0; Pro $20/мес; Max $200/мес; Teams $80/мес + $40/мес за full dev seat (до 100 пользователей); Enterprise «Let's talk»; квоты обновляются daily и weekly, сверх — по API-ценам |
| S86 | https://docs.devin.ai/ | 2026-11-11 | confirmed | Devin — «autonomous AI software engineer», который «write, run and test code»; инструменты «Shell», «IDE», «Browser», «Interactive Browser»; «Devin API», «Devin CLI», «Devin for Terminal» с `/handoff` |
| S87 | https://docs.devin.ai/get-started/first-run.md | 2026-11-11 | confirmed | Режимы `Ask` (без изменений файлов, планирование) и `Agent` (полная автономия); типы агентов `Lite`, `Normal`, `Ultra`, `Fusion`, `SWE-2` (research preview, reasoning effort Medium/High/Max), `Free (powered by SWE-2)` (до 2 конкурентных сессий, Teams); @-упоминания `@Repos`, `@Files`, `@Macros`, `@Skills`, `@Secrets`, `@Sessions` |
| S88 | https://docs.devin.ai/work-with-devin/devin-session-tools.md | 2026-11-11 | confirmed | «Side chats» — read-only Q&A, не меняет файлы и не запускает команды; «Shell & Terminal» с переключением read-only/writable; «Devin IDE» — VSCode с Cmd/Ctrl+K, Cmd/Ctrl+I, Tab; «Interactive Browser» (он же «Computer» при Computer Use) с сохранением cookies и browser state |
| S89 | https://docs.devin.ai/work-with-devin/advanced-capabilities.md | 2026-11-11 | confirmed | «Managed Devins»: координатор делит задачу между дочерними сессиями, каждая в своей VM; управление дочерними сессиями (промпты, skills, tags, ACU-лимиты), messaging, self-reminders; «Analyze session outcomes»; «Create and improve skills» с `SKILL.md`; «Manage knowledge»; доступ через Devin MCP server |
| S90 | https://docs.devin.ai/work-with-devin/dynamic-workflows.md | 2026-11-11 | confirmed | Dynamic Workflows — детерминированный Python-скрипт, оркестрирующий команду Devin; `register_workflow(meta)`, `agent(prompt, phase=..., schema=...)`, `pipeline(items, stage1, stage2, ...)`, `parallel([...])`, `log()`; режимы «Separate VM (default)» и «Shared VM»; resume по run ID с хэшированием вызовов; бюджет по умолчанию и максимум «seven days» |
| S91 | https://docs.devin.ai/product-guides/memory.md | 2026-11-11 | confirmed | Memory — персональная, не шарится с командой; «memory drive» — git-репозиторий Markdown с `MEMORY.md`; одна строка на запись с session ID; «Dreaming» — фоновая сессия примерно раз в сутки консолидирует и чистит заметки; automations не читают и не пишут memory |
| S92 | https://docs.devin.ai/product-guides/skills.md | 2026-11-11 | confirmed | `SKILL.md` по открытому Agent Skills standard; рекомендованный путь `.agents/skills/<name>/SKILL.md`; сканируются также `.devin/`, `.github/`, `.claude/`, `.cognition/`, `.windsurf/`, `.cursor/`, `.codex/`, `.codeium/`, `.kiro/skills/`; поля `allowed-tools`, `argument-hint`, `triggers`, `permissions`; встроенные skills `implement`, `plan`, `triage`, `review` в «System Skills» |
| S93 | https://docs.devin.ai/product-guides/creating-playbooks.md | 2026-11-11 | confirmed | Playbooks переезжают в Skills; «New accounts will start with Skills and have no Playbooks, from October 24, 2026» |
| S94 | https://docs.devin.ai/product-guides/knowledge | 2026-11-11 | confirmed | Knowledge — deprecated, мигрирует в Skills как «Knowledge» plugin; обязательный «Trigger Description»; content «a handful of sentences»; scope enterprise/organization/personal |
| S95 | https://docs.devin.ai/product-guides/secrets.md | 2026-11-11 | confirmed | Типы секретов: «Persisted Global Secrets», «Personal Secrets», «Repo-Specific Secrets», «Session-Specific Secrets»; форматы «Raw Secret», «Site Cookies» (base64 Chromium cookie JSON), «TOTP»; секреты не грузятся в каждый shell, а биндятся как env vars по необходимости |
| S96 | https://docs.devin.ai/product-guides/security-profiles.md | 2026-11-11 | confirmed | Security profiles ограничивают network policy (allowlist хостов/CIDR), MCP access, «Devin MCP read-only», git access level (`Read-only`/`Full`), GitHub CLI token; привязка Enterprise default → Organization default → Automations default → Automation → Session, с «Inherit»/«Pin a profile»/«No profile»; «Mandatory» профиль ограничивает нижние уровни |
| S97 | https://docs.devin.ai/work-with-devin/devin-review.md | 2026-11-11 | confirmed | Devin Review группирует изменения PR, объясняет их и помечает баги; «Bug Catcher», «Security», «Flags», codebase-aware chat; auto-review по событиям «PR is created»/«PR is ready» и каденции «Only once»/«Every push»; «Custom reviewers» (Beta), «Autoapprover» (Beta); ACU-расход, «Review size indicator» XS–XL, per-PR spend limit, «Review effort» Normal/Ultra |
| S98 | https://docs.devin.ai/cli/subagents.md | 2026-11-11 | confirmed | Профили `subagent_explore` (read-only + web search) и `subagent_general` (полный доступ в foreground, только pre-approved в background); кастомные профили в `agents/` с `model`, `allowed-tools`, `max-nesting`; foreground блокирует родителя, background параллелен и не может запрашивать новые разрешения; `ask_user_question` всегда скрыт; вложенность по умолчанию выключена |
| S99 | https://docs.devin.ai/cli/sandbox.md | 2026-11-11 | confirmed | `--sandbox` — OS-изоляция: запись только в `Write(...)`-скоупы и workspace, остальное read-only; fail-closed («refuse to start rather than running unsandboxed»); Windows не поддерживается; Linux требует `bubblewrap` и `socat`; `allowed_domains`/`denied_domains`/`network_mode` (`full`/`limited`); «Sandbox network filtering is currently unstable»; enterprise enforcement `Optional`/`Required`/`Strict` |
| S100 | https://docs.devin.ai/cli/extensibility/index.md | 2026-11-11 | confirmed | Extensibility: Rules & AGENTS.md, Skills, Plugins, Custom Subagents, MCP Servers, Hooks; project config `.devin/`, user config `~/.config/devin/`; импорт конфигурации из Cursor, Windsurf, Claude Code, Copilot, Codex, Kiro, OpenCode, Zed (`read_config_from`) |
| S101 | https://docs.devin.ai/cli/reference/permissions.md | 2026-11-11 | confirmed | Правила `Read(glob)`, `Write(glob)`, `Exec(prefix)`, `Fetch(pattern)`, tool-имена `read`/`edit`/`grep`/`glob`/`exec`, MCP `mcp__server__tool`/`mcp__server__*`/`mcp__*`; порядок `deny` → `ask` → `allow` → prompt; приоритет Organization/team → session grants → `.devin/config.local.json` → `.devin/config.json` → `~/.config/devin/config.json`; режимы `Normal`, `Accept Edits`, `Smart`, `Bypass`, `Autonomous (sandbox)`; scope'ы сохранения allow-решения |
| S102 | https://docs.devin.ai/cli/reference/configuration/config-file.md | 2026-11-11 | confirmed | Ключи `permissions.allow/deny/ask`, `permission_mode`, `sandbox.allowed_domains/denied_domains/network_mode`, `proxy.mode/url/no_proxy`, `agent.model/subagent_model/pinned_models`; `agent`, `permission_mode`, `proxy`, `sandbox` — только user-level; project config поддерживает только `permissions`, `read_config_from`, `hooks`; `system.json` — enterprise policy |
| S103 | https://docs.devin.ai/cli/models.md | 2026-11-11 | confirmed | Провайдеры Anthropic, OpenAI, Google, Cognition + open-source DeepSeek, Kimi, GLM; алиасы `opus`, `sonnet`, `swe`, `codex`, `gemini`; «Fusion» — frontier lead + cost-efficient sidekick; BYOK и локальные модели на странице не описаны |
| S104 | https://docs.devin.ai/cli/adaptive.md | 2026-11-11 | confirmed | Adaptive — «intelligent model router», анализирует промпт и направляет простые задачи дешёвым моделям, сложные — сильным; включается `/model adaptive`, `--model adaptive`, `agent.model: "adaptive"`; в enterprise по умолчанию выключен, требует разрешения пула моделей |
| S105 | https://docs.devin.ai/cli/essential-commands.md | 2026-11-11 | confirmed | `/mode`, `/normal`, `/accept-edits`, `/smart`, `/bypass` (алиасы `/yolo`, `/dangerous`), `/plan`, `/ask`, `/handoff`, `/cloud`, `/model`, `/compact`, `/open`; флаги `-p`, `-c`/`--continue`, `-r`/`--resume`, `--cloud`, `devin ssh`, `--sandbox`, `--permission-mode`; Shift+Tab цикл режимов |
| S106 | https://docs.devin.ai/cli/changelog/stable.md | 2026-11-11 | confirmed | v3000.12.43 (09.11.2026) — `image_size` для image reads, продолжение turn при truncated output; v3000.12.17 (06.11.2026) — Vim prompt editing, model pinning, `permission_mode`, MCP JSON listing; v3000.11.205 (22.10.2026) — immediate steering, `/rename`, `/pickup`, file-based session storage |
| S107 | https://docs.devin.ai/release-notes/2026.md | 2026-11-11 | confirmed | 81 дата релизов в 2026; последние: 09.11.2026 (secret pills, forwarded messages, «In Merge Queue», My Analytics для всех, daily session consumption API), 06.11.2026 («Reveal Child Sessions», side chats queue/interrupt), 02.11.2026 (multi-repo scans до 1 000 репозиториев), 19.10.2026 (Devin Oncall GA, Rules Editor for Devin Review) |
| S108 | https://docs.devin.ai/onboard-devin/agents-md.md | 2026-11-11 | confirmed | AGENTS.md — открытый стандарт; автоматически инжектируется до 16 KiB с начала файла, дальше truncation notice и чтение по требованию |
| S109 | https://docs.devin.ai/admin/billing/self-serve.md | 2026-11-11 | confirmed | Free (1 участник), Pro $20/мес (1), Max $200/мес (1, без daily cap), Teams $80/мес минимум (до 100); Pro/Max не шарятся; квота покрывает sessions + CLI + Desktop |
| S110 | https://docs.devin.ai/admin/billing/usage.md | 2026-11-11 | confirmed | Enterprise — ACU по order form; self-serve — квота + on-demand credits; расход зависит от числа и сложности действий и VM-времени; Windows-сессии ~9% дороже Linux, macOS без наценки (promotional); не расходует при ожидании ответа/тестов/клонирования |
| S111 | https://docs.devin.ai/_llms/en/desktop.txt | 2026-11-11 | confirmed | Devin Desktop — «Agent Development Environment for local and cloud agents», ACP, frontier и open models; «Agent Command Center» управляет локальными и облачными агентами из одного вида; «Cascade» — legacy-агент; «Windsurf Plugins» для JetBrains/VS Code/Eclipse/Visual Studio/NeoVim; «Devin Local» — CLI harness с subagents, sandboxing, plan mode, worktrees, permissions |
| S112 | https://docs.devin.ai/essential-guidelines/when-to-use-devin.md | 2026-11-11 | confirmed | Cloud-сессии — «majority of engineering tasks», эвристика «three hours or less»; лучше при наличии тестов/CI; параллельные независимые задачи через managed Devins или API; Devin CLI — быстрые правки и локальный контекст, `/handoff` для эскалации в cloud |

### 1.6. Короткий скан прочих

| ID | URL | Дата доступа | Статус | Что подтверждает |
| --- | --- | --- | --- | --- |
| S113 | https://aws.amazon.com/q/developer/ | 2026-11-11 | marketing | Amazon Q Developer — «The most capable generative AI–powered assistant for software development»; агентные сценарии (features, docs, tests, review, refactor, upgrades); IDE-плагины поддерживаются до 30.04.2027 с указанием на Kiro; поверхности JetBrains, IntelliJ IDEA, Visual Studio, VS Code, Eclipse (preview), CLI, Console, GitLab Duo, Teams/Slack, GitHub (preview); заявления о SWE-Bench |
| S114 | https://aws.amazon.com/q/developer/pricing/ | 2026-11-11 | confirmed | Free $0: 50 agentic requests/мес, Java upgrade 1 000 строк/мес; Pro $19/мес за пользователя: больше запросов, admin controls, IP indemnity, Java 4 000 строк/мес pooled, overage $0.003 за строку |
| S115 | https://www.augmentcode.com/ | 2026-11-11 | marketing | Cosmos — «always-on software delivery system» «from spec to verification»; общий контекст и память, permissions, audit trails, observability, human review points; сценарии code review, ticket to PR, vulnerability remediation, incident response; запуск в managed cloud sandboxes или на машинах клиента; триггеры GitHub, GitLab, Slack, Linear, Jira, schedules, webhooks |
| S116 | https://www.augmentcode.com/pricing | 2026-11-11 | confirmed | Standard $20/мес flat (до 50 мест, $20 usage), Business $100/мес flat (до 50 мест, $100 usage), Enterprise custom (unlimited users); usage покрывает LLM, Context Engine и compute |
| S117 | https://docs.augmentcode.com/ | 2026-11-11 | confirmed | Cosmos с «built-in experts» Code, Review, Other automation; агент запускается по триггеру или расписанию |
| S118 | https://docs.augmentcode.com/cli/overview | 2026-11-11 | confirmed | Auggie CLI (`@augmentcode/auggie`): анализ кода, изменения, исполнение инструментов; «Augment's powerful context engine» с доступом к репозиторию и связанным репозиториям; автоиндексация; `--print`, `--mode stream`, `--mode json` |
| S119 | https://replit.com/agent | 2026-11-11 | marketing | Replit — «AI App and Website Builder»; Agent пишет «production-ready code», «parallel task execution», «Infinite Canvas», «Intelligent Model Routing» (заявлено «65% lower average cost»), «Free mode»; встроенные Auth, Database, Hosting, Monitoring, 100+ integrations; Free mode до 30 часов чата и 60 проектов; Core $20/мес ($18 годовая), Pro $100/мес ($90 годовая); Enterprise custom с SSO/SAML, SOC 2, single-tenant |
| S120 | https://docs.tabnine.com/main | 2026-11-11 | confirmed | Tabnine — «a fully private, organization-aware AI coding agent», работающий «entirely within your environment»; предложения «Tabnine Agent» (CLI или IDE), «Tabnine Chat»; статус-баннера о переходе нет |
| S121 | https://docs.tabnine.com/main/welcome/readme/ai-models.md | 2026-11-11 | confirmed | Модели: Claude 4.8/4.7/4.6 Opus, 4.6/4.5 Sonnet, 4.5 Haiku, 4 Sonnet, GPT-5.5/5.4/5.3 Codex/5.2 Codex/5.2/5/4o, Gemini 3.5/3.1/3.0 Pro, Devstral-Small-2-24B, Devstral-2-123B, MiniMax-M2.7, GLM-4.7, Qwen-3-Coder-480B, Qwen-3-30B; private installation может использовать «some of these models and more using private endpoints»; BYOK на странице не упомянут |
| S122 | https://www.tricentis.com/news | 2026-11-11 | unverified | Новостной индекс Tricentis содержит карточку от 30.07.2026 «Insight Partners-Backed Tricentis Acquires Tabnine» с excerpt о приобретении AI coding platform и ссылкой на themiddlemarket.com (торговое издание). Первичного пресс-релиза Tricentis или Tabnine получить не удалось; docs.tabnine.com не показывает переходного баннера |

### 1.7. Заблокированные и отсутствующие источники

| ID | URL | Ошибка / наблюдение | Дата | Статус |
| --- | --- | --- | --- | --- |
| B1 | https://zed.dev/docs/ai/rules | HTTP 404 Not Found | 2026-11-11 | BLOCKED (страница не существует; фактическая — `/docs/ai/instructions`, см. S15) |
| B2 | https://zed.dev/changelog | HTTP 404 (тело «Zed: Not Found») | 2026-11-11 | BLOCKED (использован `/releases`, см. S21) |
| B3 | https://code.claude.com/docs/en/background-tasks | HTTP 404 Not Found | 2026-11-11 | BLOCKED (фоновая работа описана в S26, S36, S48) |
| B4 | https://code.claude.com/docs/en/plan-mode | HTTP 404 Not Found | 2026-11-11 | BLOCKED (режим плана описан в S31) |
| B5 | https://code.claude.com/docs/en/llms.txt | HTTP 404 Not Found | 2026-11-11 | BLOCKED (рабочий индекс — `/docs/llms.txt`) |
| B6 | https://www.jetbrains.com/help/junie/get-started-junie.html | 301 → `https://junie.jetbrains.com/docs/`; страница документации отдаёт JS-оболочку, повторные запросы — HTTP 403 (134 байта) | 2026-11-11 | BLOCKED для глубокого чтения доков Junie; факты взяты с продуктовой страницы S75 |
| B7 | https://www.jetbrains.com/ai-ides/buy/ | HTTP 200, но цены не в серверном HTML (клиентский рендер); текст страницы — только «JetBrains AI Plans & Pricing» и «Store» | 2026-11-11 | BLOCKED для чисел; цены взяты из S75 |
| B8 | https://www.jetbrains.com/help/ai-assistant/manage-ai-models.html | HTTP 404 Not Found | 2026-11-11 | BLOCKED (модели — S77) |
| B9 | https://www.jetbrains.com/help/ai-assistant/faq.html | HTTP 404 Not Found | 2026-11-11 | BLOCKED |
| B10 | https://www.jetbrains.com/help/ai-assistant/ai-assistant-pricing.html | HTTP 404 Not Found | 2026-11-11 | BLOCKED |
| B11 | https://docs.devin.ai/product-guides/playbooks | HTTP 404 Not Found | 2026-11-11 | BLOCKED (рабочая — `creating-playbooks.md`, S93) |
| B12 | https://docs.devin.ai/admin/billing/acu.md | HTTP 404 Not Found | 2026-11-11 | BLOCKED (механика ACU — S110) |
| B13 | https://docs.devin.ai/release-notes/cloud.md | HTTP 404 Not Found | 2026-11-11 | BLOCKED (рабочая — `release-notes/2026.md`, S107) |
| B14 | https://www.geminicli.com/docs/core/architecture | HTTP 404 Not Found | 2026-11-11 | BLOCKED (структура пакетов частично видна в индексе S72) |
| B15 | https://www.geminicli.com/docs/development/behavioral-evaluations.md | HTTP 404 (страница «Page Not Found») | 2026-11-11 | BLOCKED (раздел «Behavioral evaluations» есть в навигации, отдельная страница недоступна) |
| B16 | https://www.geminicli.com/docs/core/policy-engine.md | HTTP 404 | 2026-11-11 | BLOCKED (рабочая — `/docs/reference/policy-engine.md`, S65) |
| B17 | https://www.tabnine.com/ | 301 → `https://www.tricentis.com/products?utm_source=...`; `https://www.tabnine.com/pricing` → 301 на `/contact-us`; `https://www.tabnine.com/enterprise` → HTTP 502 | 2026-11-11 | BLOCKED для продуктовых страниц Tabnine; использованы docs (S120, S121) и новостной индекс (S122) |
| B18 | https://www.tricentis.com/news | `UND_ERR_HEADERS_OVERFLOW` при WebFetch; успешно получено через `curl` (HTTP 200) | 2026-11-11 | Частично BLOCKED; содержимое извлечено из HTML |
| B19 | https://zed.dev/docs/ai/agent-rules | HTTP 404 Not Found | 2026-11-11 | BLOCKED (см. S15) |

---

## 2. Матрица возможностей

Обозначения: ✅ — документировано первоисточником; ⚠️ — есть, но с оговоркой (experimental / beta / ограничение); ❌ — не документировано или прямо отсутствует; «—» — не проверялось в этой ветке исследования.

| Измерение | Zed AI | Claude Code | Gemini CLI | JetBrains (AI Assistant + Junie + Air) | Devin |
| --- | --- | --- | --- | --- | --- |
| Позиционирование | Редактор с нативным агентом + хостинг чужих ACP-агентов (S1, S16) | Agentic coding tool в terminal/IDE/desktop/browser (S24) | Enterprise Code Assist CLI, consumer-доступ передан Antigravity (S50, S69) | Air как «система для сборки ПО агентами», Junie внутри (S74) | Автономный software engineer в cloud и локально (S84) |
| Поверхности | Agent Panel, Threads Sidebar, Inline Assistant, edit prediction (S1) | CLI, VS Code/Cursor/JetBrains extensions, Desktop, Web/mobile (S24, S48) | Terminal TUI, headless `-p`, IDE companion, GitHub Action (S50, S51) | JetBrains IDEs, Web, CLI, Mobile (coming soon); Air in IDEs EAP (S74, S81) | Cloud web, Desktop, CLI, Slack/Teams, IDE-плагины Windsurf (S84, S111) |
| Agent loop | Не описан пошагово; tool-calling + review UI (S23) | Явный цикл сообщений и tool execution (S36) | ReAct-подобный цикл с tools; loop не назван явно (S51) | Не документирован в доступных страницах (S76, B6) | Сессия с planning/context/execution/browser (S86, S88) |
| Планирование | Нет отдельного plan mode в docs AI (S1) | `EnterPlanMode`/`ExitPlanMode`, режим `plan` (S25, S31) | Plan Mode по умолчанию, `/plan`, план-файл в plans directory (S57) | Junie «Advanced Plan Mode» с `.junie/plans` (S75) | `Ask` для планирования + `Send to Devin`; `/plan` в CLI (S87, S105) |
| Субагенты | `spawn_agent`, «own context», те же инструменты (S2) | `Agent`, до 20 конкурентных, вложенность 3 (S25, S26) | `.gemini/agents/*.md`, встроенные 4, без вложенности, remote A2A (S52, S67) | Не документировано на доступных страницах (B6) | `subagent_explore`/`subagent_general`, background-параллель (S98); Managed Devins (S89) |
| Параллельные агенты | Несколько threads + worktree isolation вручную (S4, S11) | Параллельные сессии/субагенты, agent teams experimental (S26, S47, S48) | Несколько сессий + experimental worktrees (S61) | Air «Track parallel work», параллельные project sessions (S74) | Managed Devins + Dynamic Workflows fan-out (S89, S90) |
| Инструменты | 16 встроенных, включая `terminal`, `fetch`, `skill`, `spawn_agent` (S2) | ~45 инструментов, включая `LSP`, `Monitor`, `Workflow`, `Artifact` (S25) | ~20 инструментов, включая `tracker_*`, `activate_skill`, `web_fetch` (S51) | Набор фич IDE + MCP/ACP, инструменты не перечислены (S76, S78) | Shell, IDE, Browser, Computer Use, Devin API/MCP (S86, S88) |
| MCP | `context_servers`, Tools + Prompts, без Sampling/Elicitation (S8) | HTTP/SSE/stdio/WS/sdk, local/project/user/plugin scopes (S33) | `~/.gemini/settings.json`, ресурсы + инструменты (S50, S51) | MCP в списке фич AI Assistant (S78) | MCP servers + Devin MCP server + DeepWiki MCP (S89, S100) |
| Контекст/правила | `AGENTS.md` и совместимые файлы, первый совпавший (S15) | CLAUDE.md иерархия + `.claude/rules` + AGENTS.md режимы + импорты (S29) | `GEMINI.md` иерархия + JIT + импорты (S55) | «Project rules», «Prompt library» (S78); AGENTS.md для Devin CLI (S100) | AGENTS.md до 16 KiB (S108); Rules в CLI (S100) |
| Память | Нет отдельной memory-подсистемы в docs (S1) | Auto memory `MEMORY.md` + topic files (S29) | Auto Memory (experimental) с inbox и патчами (S59) | Не документировано (B6) | Memory drive + Dreaming (S91) |
| Компакция | Авто при 90%, `compaction_model` (S17) | Авто-компакция + `compact_boundary` + `/compact` (S29, S36) | Chat compression + `/rewind` поверх компрессии (S60, S71) | Не документировано (B6) | `/compact` в CLI (S105) |
| Расширяемость | Skills (`SKILL.md`), MCP, profiles, ACP (S6, S7, S8, S10) | Skills, subagents, hooks, MCP, plugins + marketplace (S26, S27, S34, S35) | Extensions (MCP, commands, GEMINI.md, skills, hooks, themes) + policy engine (S63, S64, S65) | MCP, ACP, prompt library, skills (S75, S78) | Rules, Skills, Plugins, MCP, Hooks, subagents + импорт конфигов (S100) |
| Hooks | Не документированы (S2, S16) | 33 события, 5 типов обработчиков (S27) | Hooks с lifecycle-событиями (S64, S72) | Не документировано (B6) | 8 событий, `PreToolUse`/`PostToolUse`/`PermissionRequest`/`Stop`/`PostCompaction` (S100, S106) |
| SDK / API | Нет публичного SDK агента в docs (S1) | Agent SDK (Python/TS) + Managed Agents (S37) | Headless JSON/stream-json; A2A для агентов (S50, S67) | Junie CLI + GitHub Action + GitLab CI (S75) | Devin API v1/v2/v3, CLI, MCP (S84, S86, S107) |
| Модели/BYOK | Zed-hosted, API keys, subscriptions, gateways, local (S3); Zeta для predictions (S9) | Claude-модели; Bedrock/Vertex/Foundry через gateway и GH Actions (S42) | Gemini через OAuth/API key/Vertex; fallback-роутинг (S50, S58) | Anthropic/Google/OpenAI + BYOK + Ollama/LM Studio (S77); 10+ моделей BYOK в Junie (S75) | Anthropic/OpenAI/Google/Cognition + DeepSeek/Kimi/GLM; Adaptive router; Fusion (S103, S104) |
| Роутинг/fallback | Gateway-роутинг, fallback не описан (S3) | Auto mode classifier ≠ routing; model выбирается пользователем/субагентом (S26, S32) | Fallback-чейн с подтверждением, локальный Gemma-роутер (S58) | «Switch between subscriptions mid-session», Air Context (S74) | Adaptive router + Fusion + pinned_models (S102, S104) |
| Permissions | `allow`/`deny`/`confirm` + patterns + built-in hard rules (S5) | 6 режимов + правила `ToolName(specifier)` + managed policies (S25, S31) | allow/deny/confirm + TOML policy engine с priority (S65) | Human in the Loop + Dynamic allowlist в Junie (S75) | 5 режимов + `Read/Write/Exec/Fetch` + deny>ask>allow + enterprise policy (S101, S102) |
| Sandbox | Seatbelt/Bubblewrap, только `terminal` и `fetch`, ключи `agent.sandbox_permissions` (S14) | Seatbelt/bubblewrap, сеть через прокси, credentials deny/mask, off by default (S28) | Seatbelt/Docker/Podman/gVisor/LXC + tool-level sandboxing (S53) | Не документировано (B6) | `--sandbox` fail-closed, network allowlist, enterprise Required/Strict (S99) |
| Секреты | Ключи в системном keychain (S12) | Managed settings + hooks; `sandbox.credentials` (S28) | Sensitive extension settings в keychain (S64) | Не документировано (B6) | 4 scope'а секретов + Site Cookies + TOTP (S95) |
| Git/PR/worktree | Review Changes, worktree picker, commit message gen (S4, S11, S20) | `--worktree`, `EnterWorktree`, `.worktreeinclude`, `WorktreeCreate` hook, PR/commit через Bash (S38) | Experimental worktrees `.gemini/worktrees/` (S61) | Commit messages, self-review, conflict resolution (S78) | Stacked PRs, Devin Review, отдельная VM/ветка на сессию (S97, S107) |
| Checkpoint/rewind | Нет чекпоинтов в docs; review принимает/отклоняет хунки (S4) | `/rewind`, 100 чекпоинтов, ограничения по Bash/субагентам (S30) | Shadow git repo + `/restore` + `/rewind` (S54, S60) | Не документировано (B6) | Не документировано как checkpoint; сессия в VM + Review (S86, S97) |
| Remote/cloud | External Agents и Terminal Threads вместо собственного облака (S10) | `--cloud`/`--teleport`, Remote Control, Projects, GH Actions (S39, S40, S41, S42) | A2A remote subagents; consumer-облако ушло в Antigravity (S67, S69) | Air Teams (cloud), «Remote Control» в Junie (S74, S75) | Основной сценарий: cloud VM, Desktop, CLI, `/handoff` (S84, S105) |
| Телеметрия/evals | Отдельная AI-телеметрия, без публичного каталога метрик (S13) | OTel метрики/события/трейсы с именами и content-гейтами (S43) | OTel логи/метрики/трейсы, `logPrompts` default true (S56) | Не документировано; Air Governance — расходы и usage (S80) | ACU-учёт, Session Insights, Devin Coach, Consumption dashboard (S89, S97, S107) |
| Цены | Free $0 / Pro $10 / Business $30 за место; hosted +10% (S18, S19, S22) | Free без Claude Code; Pro $17–20; Max $100; Ultra $200; Team $20–125/место; Enterprise $20/место + usage (S45) | Enterprise Code Assist; consumer-тарифы сняты 18.06.2026 (S50, S68, S69) | Junie Lite free; AI Pro $8.33 (10 кредитов); AI Ultimate $25 (35 кредитов) (S75) | Free / Pro $20 / Max $200 / Teams $80 + $40 за место / Enterprise (S85, S109) |

---

## 3. Zed AI

### 3.1. Позиционирование и статус

Zed строит AI вокруг редактора, а не вокруг отдельного агентского продукта. Официальный обзор перечисляет пять AI-функций — «Agent Panel», «Parallel Agents», «Inline Assistant», «Edit Prediction», «Git commit generation» — и три «пути агента»: собственный «Zed Agent», «External Agents» по ACP и «Terminal Threads» (S1, S16). Документация прямо вводит термин: «An agent path is sometimes called a harness» (S16). Это ключевое отличие от Claude Code и Devin: Zed не пытается быть единственным harness, он предоставляет оболочку и для чужих.

Актуальный стабильный релиз на дату доступа — 1.27.0 от 04.11.2026; в релизных заметках AI-изменения этого выпуска касаются производительности Agent Panel (ленивая загрузка диффов и парсинг Markdown при первом просмотре) и стилевых примеров для commit message из трёх последних коммитов репозитория (S21).

### 3.2. Поверхности

Agent Panel — основная поверхность: потоки, Threads Sidebar, переключатель недавних потоков, очередь сообщений во время генерации, «Steer» (только для Zed Agent, потому что внешние агенты не отдают границы turn'ов), «Review Changes» и приёмка/отклонение отдельных хунков (S4). Inline Assistant и Edit Prediction работают вне панели; Edit Prediction — отдельная подсистема со своей моделью (S9). Git commit generation — отдельная мелкая AI-функция с настройками `commit_message_model` и `commit_message_instructions` (S20).

### 3.3. Agent loop, автономия, планирование, субагенты

Пошаговый agent loop в документации Zed Agent не описан: страница ограничивается перечислением возможностей — читать и искать проект, редактировать файлы, запускать команды, использовать Zed-managed MCP, следовать профилям, Skills и Instructions, показывать изменения в review UI (S23). Отдельного plan mode в документации AI-раздела не найдено (S1, S72 — в индексе AI нет страницы планирования). Это не значит, что планирования нет как поведения модели; это значит, что **продуктового контракта plan mode у Zed Agent не задокументировано**.

Субагенты есть: инструмент `spawn_agent` создаёт субагента «with its own context and access to the same tools as the parent» (S2). Ограничений на параллелизм не заявлено; параллельная работа реализуется через несколько потоков и, при конфликте файлов, через worktree (S4, S11).

### 3.4. Инструменты

Полный список из 16 инструментов (S2): чтение и поиск — `diagnostics`, `find_path`, `grep`, `list_directory`, `read_file`; сеть — `fetch` и `search_web`; изменения — `copy_path`, `create_directory`, `delete_path`, `edit_file`, `move_path`, `write_file`; исполнение — `terminal`; расширение — `skill`; оркестрация — `spawn_agent`.

Две детали важны для сравнения:

1. `search_web` доступен **только** подписчикам Zed Pro на Zed-провайдере; иначе нужен MCP-сервер (S2). Это прямая монетизационная привязка инструмента.
2. `fetch` **не** исполняется в OS-sandbox терминала, поэтому `allow_hosts`/`allow_all_hosts` к нему не применяются; вместо этого правила `fetch` матчатся регулярным выражением по URL (S2, S5). То есть у Zed две разные модели сетевых ограничений: sandbox-прокси для `terminal` и regex-правила для `fetch`.

Браузерного инструмента в списке нет: веб-взаимодействие ограничено `fetch` (Markdown) и `search_web` (S2). Для сравнения, у Claude Code есть `WebFetch`/`WebSearch` без браузера, у Devin — полноценный Interactive Browser, у ZCode — browser plugin через Node REPL/CDP.

### 3.5. Контекст, правила, память, компакция

Правила — это «Instructions»: personal `~/.config/zed/AGENTS.md`, project — **первый совпавший** файл из списка `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`; project переопределяет personal (S15). Модель «первый совпавший» — прагматичный компромисс: пользователь мигрирует с другого инструмента без переименования файлов, но одновременно действует только один источник правил. У Claude Code наоборот — все найденные файлы конкатенируются (S29).

Отдельной подсистемы памяти в документации AI-раздела не найдено (S1). Компакция документирована явно: автоматическая, включена по умолчанию, срабатывает на 90% контекстного окна, настраивается через `auto_compact` (процент, абсолютное число токенов, отрицательное значение «сколько останется»), с отдельной `agent.compaction_model` и `agent.thread_summary_model` (S17). Это самая «прозрачная» настройка компакции среди пяти продуктов: у Claude Code порог не публикуется как настройка, у Gemini CLI есть chat compression без публичного порога, у Devin — только `/compact`.

Индексации кода (семантического индекса) в документации Zed Agent не описано; поиск — `grep`/`find_path` (S2). Для контраста: JetBrains Air заявляет «Air Context» semantic indexing (S74), Augment — Context Engine (S118), Devin — DeepWiki/индексация репозитория (S84, S86).

### 3.6. Расширяемость

Три независимых механизма:

- **Skills** — `~/.agents/skills/` и `<worktree>/.agents/skills/`, обязательный `SKILL.md` с `name`/`description`, опциональный `disable-model-invocation`, progressive disclosure (в промпт попадают только имя и описание), project-local приоритет, загрузка только из trusted worktrees; изменения применяются на лету, но правка name/description инвалидирует prompt cache (S7).
- **MCP** — `context_servers`, локальные `command/args/env` и удалённые `url/headers` с MCP OAuth; поддержаны Tools и Prompts, но не Discovery/Sampling/Elicitation; per-tool правила `mcp:<server>:<tool_name>` (S8).
- **Agent Profiles** — `agent.profiles` с `name`, `tools`, `enable_all_context_servers`, `context_servers`, `default_model`; профиль управляет **доступностью**, а разрешения задаёт отдельный слой Tool Permissions (S6). Встроенные профили: `Write`, `Ask`, `Minimal`.

Хуков нет. Кастомных slash-команд как отдельного расширения нет — их роль играют Skills (`skill` tool) и `/`-меню (S7). SDK агента нет; внешняя интеграция идёт через ACP (S10).

### 3.7. Модели, провайдеры, BYOK, локальные модели

Пять путей доступа (S3): Zed-hosted модели, собственные API-ключи, существующая подписка (ChatGPT/Claude/Copilot), gateway (OpenRouter, Bedrock, Vercel), локальная модель. Термин BYOK не используется, но функционально это он. Fallback-поведение не документировано. Каталог hosted-моделей публикует цены с наценкой +10% к прайсу провайдера (S19); ассортимент включает Claude Fable 5.1/5, Opus 5.5/5/4.5–4.8, GPT-6.x, Gemini и др. (S19).

Edit Prediction имеет собственный набор провайдеров: `Zeta` (open source модель Zed) по умолчанию, GitHub Copilot, Mercury Coder, Codestral, Ollama, OpenAI-compatible self-hosted; форматы моделей перечислены явно (S9). Это самая широкая поддержка локальных моделей именно для предиктивного слоя, а не для агента.

### 3.8. Разрешения, sandbox, безопасность

Tool Permissions — зрелая модель (S5):

- три исхода `allow`/`deny`/`confirm`, по умолчанию `confirm`;
- глобальный `agent.tool_permissions.default`, per-tool `tools.<name>.default`, массивы `always_allow`/`always_deny`/`always_confirm`;
- записи правил: `pattern` + `case_sensitive`;
- приоритет: built-in security rules → `always_deny` → `always_confirm` → `always_allow` → tool default → global default;
- `always_deny` описан как «highest priority, cannot be overridden», но built-in правила стоят выше;
- hardcoded защита только для `terminal`: блокируется рекурсивное удаление `/`, `~`, `$HOME`, `.`, `..`, включая wildcard-варианты, с проверкой каждого подчинённого сегмента в цепочке команд;
- «There are no other built-in rules» — примеры для `.env`, secrets и keys в дефолтном файле настроек закомментированы и не активны.

Sandbox (S14): macOS Seatbelt, Linux Bubblewrap, Windows только через WSL. Ограничивает `terminal` (запись ФС, исходящая сеть, защита Git-метаданных) и `fetch` (хосты). По умолчанию: чтение почти всей ФС, запись внутри открытых проектов, сеть недоступна без одобрения, Unix-domain sockets запрещены. Ключи: `agent.sandbox_permissions.network_hosts`, `allow_all_hosts`, `write_paths`, `allow_fs_write_all`, `allow_unsandboxed`. На Linux при невозможности создать bubblewrap sandbox может не примениться с предупреждением; на WSL сеть либо вся, либо никакая; NTFS write grants ослабляют гарантии.

Приватность: Zed не хранит промпты и контекст по умолчанию; соглашения с провайдерами требуют zero data retention, кроме Covered Models (Anthropic, минимум 30 дней safety retention, Zed не может это отключить); ключи в системном keychain (S12). Рейтинг ответа отправляет тред в Zed; training data требует трёх условий одновременно — opt-in, open-source проект, отсутствие исключения; данные анонимизируются и лежат в Snowflake (S13).

### 3.9. Git, diff, worktree

Review Changes открывает multi-buffer вкладку, принимает/отклоняет хунки; `agent.single_file_review` включает inline-диффы (S4). Worktree isolation выбирается **вручную**: «If two threads might edit the same files, start one in a new Git worktree»; новый worktree стартует в detached HEAD, чтобы не делить ветку случайно; хук `create_worktree` автоматизирует setup и получает `ZED_WORKTREE_ROOT` и `ZED_MAIN_GIT_WORKTREE` (S11). Автоматического merge нет — изменения сводятся обычным Git-процессом (S11).

Чекпоинтов/rewind в документации нет (S1, S4). Это заметный разрыв с Claude Code (`/rewind`), Gemini CLI (`/restore`, `/rewind`) и даже ZCode (файловый rewind, см. §11).

### 3.10. Remote/cloud, телеметрия, цены

Собственного облака агентов нет. Роль remote-поверхности играют External Agents по ACP: Zed хостит поток в Agent Panel, но «the agent typically owns its own runtime, auth, model selection, tools, and native configuration»; биллинг, юридические условия, retention и обработка данных — «between you and the agent provider»; Zed за External Agents не берёт плату (S10). Поддерживаются Claude Agent, Codex, Gemini CLI, OpenCode, Copilot, Cursor, Pi Coding Agent, Poolside, а также любые ACP-совместимые агенты; extension-based агенты объявлены deprecated с автомиграцией в registry-эквиваленты (S10).

Телеметрия AI-функций собирается отдельно от общей телеметрии редактора и покрывает использование функций, время ответа, принятие/отклонение правок (S13). Публичного каталога метрик (как у Claude Code) нет.

Цены (S18, S22): Personal $0 (только свои ключи или external agents), Pro $10/мес ($5 токенов + unlimited edit predictions, дальше usage-based), Business $30/место/мес (без фиксированного LLM-кредита, org-wide AI policies, unified spend visibility, SSO/SAML/SCIM — «planned»). Hosted-токены — по прайсу провайдера +10% (S19). Trial — 14 дней и $5 GPT-6 Luna (S22).

### 3.11. Сильные и слабые стороны

**Сильные:** самая чистая архитектура «редактор + harness» с тремя путями агента; зрелая и понятная модель Tool Permissions с приоритетами и built-in защитой; настоящий OS-sandbox для терминала (редкость среди редакторов); Skills по открытому стандарту `.agents/skills`; прозрачная настройка компакции; честная политика приватности с указанием исключения safety-retention; ACP как способ не конкурировать с чужими агентами.

**Слабые:** нет plan mode как продуктового контракта; нет чекпоинтов/rewind; нет памяти; нет хуков; нет браузерного инструмента; `search_web` монетизационно привязан к Pro; две несогласованные модели сетевых ограничений (`fetch` regex vs `terminal` sandbox); worktree isolation ручная; External Agents размывают единый контроль permissions/telemetry (каждый агент приносит свои).

---

## 4. Claude Code

### 4.1. Позиционирование и статус

Официально — «agentic coding tool», который «reads your codebase, edits files, runs commands» и доступен «in your terminal, IDE, desktop app, and browser» (S24). Это самый широкий набор поверхностей среди пяти: CLI (native installer, Homebrew, WinGet, apt/dnf/apk), расширения VS Code/Cursor/JetBrains, Desktop (macOS/Windows/Linux beta), Web с мобильным доступом (S24, S48).

Актуальная версия на дату доступа — 2.1.322 (10.11.2026); в 2.1.321 (09.11.2026) добавлена Claude Fable 5.2 как дефолтная Fable с 1M контекста и ценой $8/$40 за Mtok, cache read $0.20/Mtok (S46). Темп релизов — ежедневный/несколько раз в день, что само по себе является конкурентным фактором и одновременно риском для документации.

### 4.2. Agent loop

Agent SDK документирует цикл явно и это, вероятно, самое точное публичное описание agent loop среди конкурентов: промпт → оценка → исполнение инструментов → возврат результатов → повтор до ответа без tool calls; финальный `AssistantMessage` + `ResultMessage` (S36). Типы сообщений: `SystemMessage` (subtypes `init`, `compact_boundary`, `informational`, `worker_shutting_down`), `AssistantMessage`, `UserMessage`, `StreamEvent`, `ResultMessage`; `ResultMessage` несёт текст, токены, стоимость, session ID и subtype (`success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`) (S36).

Важная деталь конкурентного дизайна: read-only инструменты могут исполняться параллельно, state-modifying — последовательно; кастомные инструменты по умолчанию последовательны, если не помечены `readOnlyHint` (S36). Это ровно та политика, которую ZCode реализует в tool scheduler, но у Claude она опубликована как контракт.

Лимиты: `max_turns` считает tool-call turn'ы плюс финальный текстовый; `max_budget_usd` ограничивает оценённую стоимость (S36).

### 4.3. Планирование и режимы разрешений

Шесть режимов (S31): `default` (Manual, только чтения), `acceptEdits` (чтения + правки + обычные файловые команды), `plan` (чтения и classifier-approved команды, правки заблокированы до утверждения плана), `auto` (всё, с фоновыми проверками классификатора), `dontAsk` (чтения в рабочих каталогах и pre-approved инструменты; всё, что требовало бы промпта, — deny), `bypassPermissions` (всё, только для изолированных контейнеров/VM).

Plan mode — не просто «read-only»: модель просят «research and propose changes without making them», а утверждение плана выводит из режима и переключает в выбранный режим редактирования (S31). Инструменты `EnterPlanMode`/`ExitPlanMode` формализуют переход (S25).

Auto mode — отдельный слой поверх режимов: классификатор блокирует «anything irreversible, destructive, or aimed outside your environment»; `hard_deny` блокирует безусловно, `soft_deny` может быть переопределён явным намерением пользователя или `allow`, причём «General requests don't count as explicit intent»; встроенные soft-правила — force push, `curl | bash`, production deploy; встроенный hard-deny — правило эксфильтрации данных; конфигурация `autoMode.environment` описывает доверенную инфраструктуру прозой, а не регулярками; project settings для auto mode не читаются (S32). Это самая проработанная модель «доверия к намерению» среди конкурентов.

### 4.4. Инструменты

Каталог — порядка 45 инструментов (S25), и он заметно шире, чем у остальных: помимо ожидаемых `Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`/`WebFetch`/`WebSearch`, есть `LSP` (переходы к определениям, ссылки, типовые ошибки), `Monitor` (фоновая команда, построчно отдающая вывод в диалог, или WebSocket-события), `NotebookEdit`, `PowerShell`, `EnterWorktree`/`ExitWorktree`, `ListAgents`/`SendMessage`, `TaskCreate/Get/List/Stop/Update`, `TodoWrite`, `ToolSearch` (поиск и загрузка отложенных инструментов), `CronCreate/Delete/List`, `RemoteTrigger`, `ReportFindings`, `Workflow`, `Artifact`, `PushNotification`, `SendUserFile`.

Два наблюдения для конкурентного анализа:

1. `Glob` и `Grep` **отсутствуют по умолчанию** на macOS/Linux/WSL — Claude использует `find`/`grep` через `Bash` (S25). Это сознательный отказ от собственных файловых инструментов там, где shell справляется; экономит схемы инструментов, но повышает нагрузку на permission-правила Bash.
2. `ToolSearch` — механизм отложенной загрузки схем инструментов. Это прямое решение проблемы «слишком много MCP-инструментов в контексте», которую ZCode решает через MCP runtime и компакцию.

Правила разрешений: `ToolName(specifier)`, например `Bash(npm run *)`, `Read(~/secrets/**)`, `Edit(/src/**)`, `Skill(deploy *)`, `Agent(Explore)`, `WebFetch(domain:example.com)` (S25). Есть неочевидная семантика: allow-правило `Edit(...)` также разрешает чтение того же пути, а deny-правило `Read(...)` блокирует и `Edit`/`Write` (S25).

### 4.5. Субагенты, команды, параллельность

Субагенты — Markdown + frontmatter в `.claude/agents/`, `~/.claude/agents/`, plugin `agents/`, managed settings и `--agents` JSON; project/user каталоги сканируются рекурсивно, ближайший к рабочему каталогу выигрывает; plugin-подкаталоги становятся частью идентификатора (`my-plugin:review:security`) (S26). Полный набор полей включает `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation`, `initialPrompt`, `experimental` (S26).

Лимиты и семантика: 20 конкурентных субагентов по умолчанию (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), вложенность 3 уровня (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), foreground блокирует основной диалог, background работает параллельно; background-субагенты получают урезанный набор встроенных инструментов; `AskUserQuestion`, `EnterPlanMode`, `ScheduleWakeup`, `WaitForMcpServers`, `Workflow` всегда удалены из субагентов (S26).

Agent teams — отдельный экспериментальный уровень: team lead координирует, teammates имеют общий список задач, сами захватывают работу и общаются напрямую; включается `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; известные ограничения по resume, координации и shutdown (S47). Это важный кейс «не копировать»: Anthropic сам маркирует механизм экспериментальным и предупреждает о coordination overhead.

### 4.6. Контекст, память, правила, компакция

Иерархия памяти (S29): managed policy (`/Library/Application Support/ClaudeCode/CLAUDE.md`, `/etc/claude-code/CLAUDE.md`, `C:\Program Files\ClaudeCode\CLAUDE.md`) → user `~/.claude/CLAUDE.md` → project `./CLAUDE.md` или `./.claude/CLAUDE.md` → local `./CLAUDE.local.md`; плюс `.claude/rules/**/*.md` и `~/.claude/rules/`. Все найденные файлы конкатенируются, а не переопределяют друг друга; порядок — от корня ФС к рабочему каталогу, «instructions closer to where you launched Claude are read last» (S29).

AGENTS.md читается только если нет CLAUDE.md, `.claude/CLAUDE.md` или `CLAUDE.local.md` в рабочем каталоге и выше; поведение переключается настройкой Project instructions: `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `claude-md`, `managed-only`; `AGENTS.local.md`, `AGENTS.override.md`, `.agents/` не читаются (S29). Это прямо противоположный Zed выбор: Zed берёт первый совпавший файл, Claude — конкатенирует и приоритизирует CLAUDE.md над AGENTS.md.

Импорты `@path/to/import` до 4 уровней; импорт не уменьшает стоимость контекста, так как файлы загружаются вместе с импортирующим (S29). Важная деталь: project-level импорт вне рабочего каталога требует одноразового подтверждения.

Компакция: при приближении к лимиту SDK суммирует старую историю, сохраняя последние обмены и ключевые решения, и эмитит `compact_boundary`; project-root CLAUDE.md переживает `/compact` — Claude перечитывает его с диска и инжектирует снова; nested CLAUDE.md и path-scoped rules могут загрузиться снова по требованию; инструкции, данные только в разговоре, теряются (S29, S36). Auto memory живёт в `~/.claude/projects/<project>/memory/` с `MEMORY.md` как индексом; первые 200 строк или 25KB загружаются на старте, дальше — по требованию; CLAUDE.md больше 4 MiB пропускается целиком (S29).

### 4.7. Расширяемость

- **Skills** — `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/`, nested, plugin, `~/.claude/skills/synced/`; «Custom commands have been merged into skills»; `.claude/commands/*.md` остаётся поддерживаемым legacy-форматом; поля `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `context: fork`, `agent`, `background`, `model`, `effort`, `hooks`; `$ARGUMENTS`, `$N`, named placeholders, динамическая инъекция `` !`command` ``; `context: fork` запускает skill в субагенте (S34).
- **Hooks** — 33 события и 5 типов обработчиков (`command`, `http`, `mcp_tool`, `prompt`, `agent`); конфигурация в `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings, `plugin/hooks/hooks.json`, frontmatter skill/subagent; `PreToolUse` может вернуть `permissionDecision: deny` с причиной; `Stop` может блокировать завершение; `PreCompact`/`PostCompact` дают контроль над компакцией; `WorktreeCreate`/`WorktreeRemove` — над worktree (S27).
- **MCP** — HTTP (рекомендуемый), SSE (deprecated), stdio, WebSocket (только JSON), `sdk`; скоупы local/project/user/plugin; приоритет local → project → user → plugin → claude.ai connectors, managed выше; project-серверы требуют подтверждения в интерактиве, но в `-p`, SDK и части облачных сессий грузятся без вопроса; `disabledMcpjsonServers`, `--strict-mcp-config`; workspace trust важен — «A cloned repository can't approve its own servers» (S33).
- **Plugins** — каталог с `.claude-plugin/plugin.json`, может включать skills, agents, hooks, MCP; marketplace — `.claude-plugin/marketplace.json` с тирами Official/Community/Third-party; плагины исполняют код с правами пользователя (S35).
- **Agent SDK** — тот же loop, инструменты, permissions, sessions и hooks как библиотека на Python/TypeScript; отдельно Managed Agents — хостингуемый harness в облачном или self-hosted sandbox (S37).

### 4.8. Модели, провайдеры, маршрутизация

Модели — Claude-семейство; провайдерский доступ через Anthropic API, Amazon Bedrock, Google Cloud Agent Platform, Microsoft Foundry (S42). Отдельного пользовательского model router нет: модель выбирается на уровне сессии/субагента (приоритет: параметр вызова → frontmatter `model` → `CLAUDE_CODE_SUBAGENT_MODEL` → модель основного диалога) (S26). Fallback документирован только частично: fast mode на Vertex «falling back to standard speed if Vertex refuses it» (S46). Для GitHub Actions есть `use_bedrock`, `use_vertex`, `use_foundry` через OIDC без статических облачных креденшелов (S42).

### 4.9. Разрешения, sandbox, секреты

Sandbox — отдельный от permissions слой (S28). macOS Seatbelt, Linux/WSL2 bubblewrap + socat, Windows без sandbox. Покрывает **только** shell-команды и их потомков (Bash, PowerShell, Monitor); файловые инструменты, MCP-серверы и hooks работают вне sandbox. Сеть: «no direct route out», только через локальный прокси с проверкой хостов, allowlist изначально пуст; UDP, HTTP/3 и ICMP не выходят; инструменты, игнорирующие proxy-переменные (`ssh`, большинство драйверов БД), не подключаются. Файловая изоляция по умолчанию: запись в cwd, per-user temp и added directories; чтение почти всей машины, **включая `~/.ssh` и `~/.aws/credentials`** — документация прямо предупреждает «This default still allows reading credential files» (S28).

Ключи: `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`, `excludedCommands`, `enableWeakerNestedSandbox`, `allowNestedUserNamespaces`, `bwrapPath`; файловые `sandbox.filesystem.allowWrite/denyWrite/denyRead/allowRead/disabled`; credentials `sandbox.credentials.files/envVars` с режимами `deny` и `mask` (mask требует TLS termination); сетевые `allowedDomains`, `deniedDomains`, `strictAllowlist`, `allowManagedDomainsOnly`, `tlsTerminate`, порты прокси (S28). `sandbox.filesystem.disabled: true` оставляет сетевую изоляцию, но даёт неограниченный доступ к ФС и может быть установлен только из user/managed/`--settings` — project settings не могут (S28).

Ключевая архитектурная мысль для ZCode: Claude разводит **pre-execution approval policy** (permissions/modes) и **runtime boundary** (sandbox), и явно пишет, что `/sandbox` — «not a permission mode» (S28). Это ровно то разделение, которого не хватает продуктам, где sandbox пытаются выразить через «режим разрешений».

### 4.10. Git, worktree, checkpoints

`--worktree`/`-w`, каталог `.claude/worktrees/<name>/`, ветка `worktree-<name>`; `isolation: worktree` во frontmatter субагента даёт временный worktree, неизменённые удаляются автоматически; `.worktreeinclude` копирует gitignored файлы (`.env`, `config/secrets.json`) в новый worktree; `worktree.baseRef` = `fresh` (default) или `head`; `worktree.bgIsolation: "none"` разрешает фоновые правки без изоляции; `WorktreeCreate`/`WorktreeRemove` хуки поддерживают не-git VCS (S38).

Checkpointing (S30): чекпоинт на каждый промпт, 100 последних на сессию, хранение с разговором (значит `/rewind` работает после resume), retention по умолчанию ~30 дней (`cleanupPeriodDays`). Меню: «Restore code and conversation», «Restore conversation», «Restore code», «Summarize from here», «Summarize up to here». Ограничения перечислены честно: изменения только через Bash не отслеживаются, правки субагентов обычно не захватываются (исключение — foreground forked skill), внешние и параллельные сессии не захватываются, симлинки и хардлинки пропускаются, «Not a replacement for version control» (S30).

### 4.11. Remote/cloud/background

- `--cloud` создаёт облачную сессию на claude.ai: один репозиторий, клонирует remote текущей ветки (не локальный checkout), требует claude.ai sign-in и org policy `allow_remote_sessions`, недоступно на Bedrock/Vertex; bundle-fallback < 100 MB, untracked файлы исключаются (S39).
- `--teleport` возвращает сессию локально: нужен чистый рабочий каталог, тот же репозиторий (не fork), запушенная ветка, тот же аккаунт; если облачная сессия была компактирована, ранние суммированные сообщения не копируются (S39).
- Remote Control — обратное направление: claude.ai/мобильное приложение управляет **локальным** процессом; исполнение остаётся локальным; только подписки, API-ключи не поддерживаются; одна remote-сессия на интерактивный процесс; транскрипт хранится на серверах Anthropic; org с ZDR или HIPAA не могут включить (S41).
- Projects — координатор, который раздаёт работу в threads с отдельными контекстами; облачные threads стартуют с репозиториев, инструкций (до 16 000 символов) и памяти (`MEMORY.md`); лимиты 1 000 файлов / 2 GB, 500 новых threads в день; public beta на Pro/Max/Ultra, недоступно на Team/Enterprise (S40).
- GitHub Actions — `anthropics/claude-code-action@v1`, триггер `@claude` (полное слово, Write access, human actor, боты только через `allowed_bots`), облачная маршрутизация через Bedrock/Vertex/Foundry (S42).
- Desktop — параллельные сессии в Code tab, split view, отдельные окна, окружения Local/Cloud/SSH/WSL, worktree по умолчанию выключен, side chats не сохраняются на диск, `dontAsk` только в CLI (S48).

Честность документации здесь — отдельный конкурентный актив: для каждой remote-функции перечислено, что **не** переносится (запущенные shell-команды, субагенты, session-scoped scheduled tasks при reclaim VM; ранние сообщения при teleport компактированной сессии; untracked файлы в bundle) (S39).

### 4.12. Телеметрия и evals

OTel-экспорт с публично названными метриками и событиями (S43): `claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`, `cost.usage`, `token.usage`, `code_edit_tool.decision`, `active_time.total`; события `user_prompt`, `assistant_response`, `tool_result`, `tool_decision`, `api_request`, `api_error`, `api_refusal`, `api_request_body`, `api_response_body`, `system_prompt`; трейсы в beta (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) со спанами `claude_code.interaction`, `llm_request`, `tool`, `tool.blocked_on_user`, `tool.execution`, `hook`. Контент по умолчанию не логируется: включается `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES`; трейсы по умолчанию редактируют текст промптов и содержимое инструментов (S43). Это самый полный публичный контракт наблюдаемости среди пяти продуктов.

Отдельный eval-контур публично не документирован; есть Code Review с градацией глубины и `ultrareview` как multi-agent проверка в облаке (S44, индекс документации).

### 4.13. Цены

Free $0 — Claude Code **не включён**; Pro $17/мес при годовой оплате ($200 сразу) или $20/мес; Max $100/мес (5x Pro usage каждые 5 часов и неделю, $100 API-кредитов); Ultra $200/мес (10x Pro weekly, без 5-часового лимита для verified, $200 кредитов); Team $20–25/место стандарт и $100–125 премиум; Enterprise $20/место/мес при 20 местах + usage по API-ставкам; Claude Code включён во все платные планы и делит пул с остальным Claude (S45).

### 4.14. Сильные и слабые стороны

**Сильные:** самый широкий и самый документированный набор инструментов; явный публичный agent loop; шесть режимов разрешений + классификатор auto mode с прозрачным приоритетом правил; настоящий OS-sandbox с сетевым прокси и маскированием креденшелов; 33 hook-события, включая компакцию и worktree; Skills/Commands/Plugins/Subagents с ясным разделением ролей; Agent SDK; OTel-контракт; честная документация ограничений.

**Слабые:** сложность — 45 инструментов, 33 события, 6 режимов, несколько скоупов настроек создают высокую когнитивную нагрузку и риск несовместимости между версиями (релизы почти ежедневные, S46); привязка к Claude-моделям и Anthropic-инфраструктуре для облачных функций (Remote Control, Code Review, Projects недоступны на Bedrock/Vertex/Foundry); sandbox покрывает только shell — файловые инструменты, MCP и hooks вне границы; дефолтное чтение credential-файлов; agent teams экспериментальны; Projects в beta и не для Team/Enterprise.

---

## 5. JetBrains: AI Assistant, Junie, Air

### 5.1. Позиционирование и статус

JetBrains находится в середине продуктовой консолидации, и это важнее любого отдельного списка фич.

- `jetbrains.com/ai/` — это страница **Air**, а не AI Assistant: Air подан как «one system for building software with agents», а Junie описан как «now part of JetBrains Air» и «the most cost efficient coding agent» (S74).
- Air поддерживает «the agents you already use» — Claude Agent, Codex, Junie, Copilot, OpenCode и других через ACP (S74).
- AI Assistant остаётся отдельным продуктом с собственной документацией; страница `switch-to-air.html` (19.10.2026) говорит, что переход **опционален**: «AI Assistant can be hidden after the switch», «You can return to AI Assistant at any time»; даты sunset нет (S79).
- Блог подтверждает фазу EAP: Air in IDEs EAP в октябре 2026, Air Governance 22.10.2026 (S80).

Вывод: у JetBrains сейчас **три пересекающиеся поверхности** — AI Assistant (в IDE), Junie (IDE + CLI + CI), Air (IDE-плагин + Teams + Governance). Официального заявления о замене AI Assistant на Air нет (S79); официальное заявление о том, что Junie «now part of JetBrains Air», есть (S74). Это не противоречие, но и не однозначная стратегия.

### 5.2. Поверхности

- **AI Assistant** — во всех основных IDE: CLion, DataGrip, DataSpell, GoLand, IntelliJ IDEA, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm; Android Studio и ReSharper упомянуты, но вне охвата документации (S76).
- **Junie** — «Junie CLI» в терминале, «Air in IDEs», GitHub Action, GitLab CI/CD (S75).
- **Air** — JetBrains IDEs (плагин), Web (Air Teams), CLI (Air Gateway), Mobile (coming soon) (S74, S81).

### 5.3. Возможности AI Assistant

Список фич (S78) — это в основном IDE-нативные сценарии, а не агентский harness: cloud code completion, next edit suggestions, suggest refactoring, name suggestions, Python type annotations, генерация кода по промпту, перевод вставленного кода на другой язык, объяснение кода/ошибок/логов/CMake/сборки/SQL, поиск проблем, генерация тестов и документации, commit messages, self-review, объяснение коммитов, title/description для PR/MR, разрешение Git-конфликтов, summary входящего PR, объяснение query plans, Jupyter-ячейки и визуализации.

Конфигурационный блок того же списка важен: «Use third-party and local models», «Model Context Protocol (MCP)», «Agent Client Protocol (ACP)», «Project rules», «Prompt library» (S78). То есть JetBrains уже поддерживает и MCP, и ACP, и проектные правила, и библиотеку промптов — но как набор IDE-функций, а не как единый агентский контракт.

Отдельно: на странице feature-set **Junie не упомянут** (S78), хотя на продуктовой странице Junie назван частью Air (S74). Это ещё одна иллюстрация продуктовой фрагментации.

### 5.4. Junie: планирование, автономия, расширяемость

С продуктовой страницы (S75):

- **Advanced Plan Mode** — создаёт структурированные требования, дизайн и этапы поставки до кода; планы хранятся в `.junie/plans`, редактируются и коммитятся; планирование и реализация могут использовать **разные модели** («Plan on a powerful model, implement on a fast one»).
- **Live Prompting** — перенаправление агента во время задачи без перезапуска.
- **Human in the Loop** — ревью и одобрение ключевых действий с «Dynamic allowlist» и подтверждением пользователя.
- **Remote Control** — асинхронное исполнение в CLI плюс веб-мониторинг; позиционируется для миграций, обновлений Spring Boot, добавления покрытия тестами.
- **Custom Guidelines & Skills** — постоянные командные правила плюс «Agent Skills packages»; общие `/commands` в CLI и IDE через ACP.

Отсутствует в доступных источниках: описание внутренних инструментов, субагентов, хуков, sandbox, памяти и компакции. Страницы документации Junie отдают 403 (B6), поэтому эти измерения честно помечены как неизвестные, а не как отсутствующие.

### 5.5. Модели, BYOK, локальные модели

AI Assistant (S77): каталог включает Anthropic (Claude Opus 5.5, Sonnet 5.5, Fable 5.1/5, Opus 5, Sonnet 5, 4.8/4.7/4.6/4.5 семейства), Google (Gemini 3.8/3.7/3.6 Flash, 3.1/2.5 Pro), OpenAI (GPT-6.1 Sol, GPT-6 Luna/Sol, GPT-5.6/5.5/5.4/5.3 Codex/5.2/5.1/5, o1/o3/o4-mini). xAI Grok помечен как «Removed by JetBrains» (Grok-4.3) или «Deprecated by provider» (4.1/4/Code Fast 1). BYOK — через Settings → Tools → AI Assistant → Providers & API keys; локальные модели — Ollama и LM Studio.

Junie (S75): «10+ models supported via BYOK», примеры Claude Opus 5.5, Gemini 4 Carbon, GPT-6 ASTRA, Grok 4.7; Junie Lite позволяет любую модель, локальные модели и BYOK по ценам провайдера **без наценки**; «AI usage billed separately».

Air (S74): можно принести существующую подписку, API-ключи или даже base URL; организации — ключи Amazon Bedrock, OpenAI, Anthropic или любого провайдера; «Switch between subscriptions – even mid-session»; JetBrains AI доступен «with credits billed at public API rates».

### 5.6. Цены

Junie (S75): Lite — бесплатно, без trial и карты; AI Pro — $8.33/user/мес с 10 AI Credits за 30 дней и топ-апами; AI Ultimate — $25.00/user/мес с 35 AI Credits, «Recommended for Junie»; годовая и месячная оплата.

AI Assistant/Air (B7): страница цен `jetbrains.com/ai-ides/buy/` отдаёт только заголовок и «Store» — числа не в серверном HTML. Поэтому конкретные цены AI Assistant/Air в этом отчёте не утверждаются; они помечены как BLOCKED, а не заполнены по памяти.

### 5.7. Governance и телеметрия

Air Governance (S80): «one place to manage which AI agents, models, and providers your teams use», лимиты расходов, отчётность «what that usage costs and delivers». Страница Air (S74) добавляет governance-блок: «Set rules and permissions», «Control the cost», «Use any vendor», «Optimize with analytics», а для команд — «Run shared projects», «Automate busywork», «Control project environments», «Centralize your setup».

Публичного каталога метрик/событий (как OTel у Claude Code) не найдено.

### 5.8. Сильные и слабые стороны

**Сильные:** глубокая интеграция с IDE и code intelligence (IntelliJ Engine); Advanced Plan Mode с версионируемыми планами в репозитории и разными моделями на план/реализацию; широкий каталог моделей + BYOK + Ollama/LM Studio; ACP как способ встроить чужих агентов; governance-слой с бюджетами и аналитикой; Junie Lite бесплатен и без наценки на BYOK.

**Слабые:** продуктовая фрагментация (AI Assistant, Junie, Air) и отсутствие публичного заявления о единой стратегии; документация Junie недоступна для внешнего чтения (403), что само по себе барьер для оценки и внедрения; цены AI Assistant/Air не опубликованы в машиночитаемом виде; нет публичных данных о sandbox, хуках, памяти, компакции; набор фич AI Assistant — это длинный список IDE-операций, а не агентский контракт.

---

## 6. Devin

### 6.1. Позиционирование и статус

Cognition позиционирует Devin как «your team's autonomous software engineer», который «runs in the cloud or on your machine», тестирует в собственном браузере и «won't stop until the PR is ready to merge» (S84). Это единственный из пяти продуктов, где **cloud VM является основным, а не дополнительным** исполнением: каждая сессия получает собственную VM с Windows/macOS/Linux, браузером, shell и IDE (S84, S86).

Devin также прошёл через приобретение Windsurf: в документации фигурируют «Devin Desktop» как «Agent Development Environment for local and cloud agents», «Agent Command Center», legacy-агент «Cascade» и «Windsurf Plugins» для JetBrains/VS Code/Eclipse/Visual Studio/NeoVim (S111). Это объясняет, почему у Devin одновременно есть cloud-агент, локальный CLI-harness и редактор.

### 6.2. Поверхности

Cloud web (`app.devin.ai`), Devin Desktop, Devin CLI, Slack, Microsoft Teams, IDE-плагины Windsurf, Devin API (S84, S86, S111). CLI умеет `devin ssh` в VM облачной сессии, `devin forward` для портов и `scp` для файлов (S105, S86). `/handoff` переводит работу между локальной и облачной сессиями (S105).

### 6.3. Agent loop, автономия, планирование

Режимы: `Ask` — исследование кода и планирование без изменений файлов, с возможностью «Construct a Devin Prompt» и «Send to Devin»; `Agent` — полная автономия: писать код, запускать команды, браузить, исправлять баги, создавать PR, тестировать (S87). Переключение агента посреди сессии применяется к следующему сообщению (S87).

Типы агентов (S87): `Lite` (простые, хорошо очерченные задачи, минимальная стоимость), `Normal` (баланс), `Ultra` (сложнейшие задачи, максимальная стоимость), `Fusion` (frontier-модель + дешёвый sidekick), `SWE-2` (research preview с reasoning effort Medium/High/Max), `Free (powered by SWE-2)` (Teams, до 2 конкурентных сессий). Это редкий пример **явной продуктовой таксономии стоимости/способности** на уровне выбора агента, а не только модели.

Планирование: `Ask`-сессия строит контекстный промпт; в CLI есть `/plan` и режим Plan agent (S105). Отдельного «plan mode с файлом плана» как у Gemini/Junie не документировано.

### 6.4. Инструменты

Четыре поверхности инструментов (S88): «Side chats» — read-only Q&A рядом с worklog, может искать и читать код, но не менять файлы и не запускать команды; «Shell & Terminal» — полный доступ, история команд, переключение read-only/writable; «Devin IDE» — интерактивный VSCode с загруженными репозиториями, Cmd/Ctrl+K, Cmd/Ctrl+I, Tab, доступ к терминалам Devin; «Interactive Browser» (он же «Computer» при Computer Use) — CAPTCHA, MFA, OAuth, сложные сайты, локальное тестирование, визуальная проверка, скриншоты и записи; cookies сохраняются в течение сессии, browser state можно сохранить для будущих сессий.

Плюс MCP: Devin MCP server позволяет внешним инструментам управлять сессиями, playbooks, knowledge и документацией репозитория (S89); DeepWiki MCP — публичный сервер `mcp.deepwiki.com` для чтения wiki-структуры публичных репозиториев (индекс документации S86).

Отдельно — «Local Hands»: облачная сессия может выполнять команды и редактировать файлы **на машине пользователя** через Devin Desktop или `devin connect`, с одобрением каждого вызова (индекс документации S86). Это гибрид cloud-автономии и локального доступа.

### 6.5. Субагенты, параллельность, оркестрация

Три уровня:

1. **CLI-субагенты** (S98): `subagent_explore` (read-only + web search, модель субагента по умолчанию) и `subagent_general` (полный доступ в foreground, только pre-approved в background, модель родителя); кастомные профили в `agents/` с `model`, `allowed-tools`, `max-nesting`. Foreground блокирует родителя и может запрашивать разрешения; background параллелен, наследует уже выданные разрешения и **не может** запрашивать новые; `ask_user_question` всегда скрыт; вложенность по умолчанию выключена, включается `max-nesting: 3`; прерывание родителя «паркует» субагентов и они возобновляются на следующем сообщении; стоимость растёт с каждым субагентом, `subagent_general` умножает расход премиум-модели.

2. **Managed Devins** (S89): координатор делит большую задачу между дочерними сессиями, каждая в собственной изолированной VM, затем «scopes the work, monitors progress, resolves conflicts, and compiles results»; управление — запуск дочерних сессий с промптами, skills, tags, ACU-лимитами, messaging, уведомления, мониторинг ACU, sleep/terminate, self-reminders; «Auto-approve child sessions» можно отключить, чтобы ревьюить батчи.

3. **Dynamic Workflows** (S90): детерминированный Python-скрипт, который оркестрирует команду Devin; `register_workflow(meta)`, `agent(prompt, phase=..., schema=...)` возвращает dict по схеме, `pipeline(items, stage1, stage2, ...)` без барьера между стадиями, `parallel([...])` с барьером, `log()`; режимы «Separate VM (default)» (изолированные дочерние сессии, обмен кодом через git-ветки) и «Shared VM» (общее дерево, ниже параллелизм, нужны непересекающиеся записи); resume по run ID с хэшированием вызовов (промпт + схема + настройки исполнения); бюджет по умолчанию и максимум — **семь дней**; остановка отменяет скрипт и усыпляет оставшиеся дочерние сессии, записанная работа остаётся возобновляемой.

Это ближайший аналог ZCode Dynamic Workflow (см. §11) — вплоть до терминологии `pipeline`/`parallel`/`phase` и resume по хэшу вызова.

### 6.6. Контекст, память, knowledge, skills

- **AGENTS.md** — автоматически инжектируется до 16 KiB с начала файла; дальше truncation notice и чтение по требованию; рекомендация держать always-on guidance под 16 KiB, остальное — в skills (S108).
- **Memory** (S91): персональная, не шаршится с командой; «memory drive» — git-репозиторий Markdown с `MEMORY.md` как точкой входа; записи — однострочные bullets с session ID; каждая сессия получает свой checkout и `MEMORY.md` как контекст, остальные заметки читаются по необходимости; новые воспоминания применяются к будущим сессиям, не к текущей; параллельные сессии пишут в один drive, stale-записи отклоняются и повторяются; automations не читают и не пишут memory.
- **Dreaming** (S91): фоновая сессия примерно раз в сутки консолидирует пересекающиеся заметки, удаляет временное и устаревшее, добавляет невысказанные уроки, реорганизует; сохраняет source links и явные предпочтения; первый «сон» сеет память из недавних сессий. Memory отключается «Turn off personal memory».
- **Skills** (S92): `SKILL.md` по открытому Agent Skills standard, рекомендованный путь `.agents/skills/<name>/SKILL.md`, сканируются также `.devin/`, `.github/`, `.claude/`, `.cognition/`, `.windsurf/`, `.cursor/`, `.codex/`, `.codeium/`, `.kiro/skills/`; поля `allowed-tools`, `argument-hint`, `triggers` (default `["user","model"]`), `permissions`; встроенные `implement`, `plan`, `triage`, `review` в «System Skills».
- **Playbooks → Skills** (S93): «New accounts will start with Skills and have no Playbooks, from October 24, 2026».
- **Knowledge → Skills** (S94): Knowledge deprecated, мигрирует в Skills как «Knowledge» plugin с обязательным «Trigger Description».

Две миграции расширяемости за несколько месяцев — это одновременно сила (сходимость к открытому стандарту) и слабость (пользовательские инструкции дважды меняли дом).

### 6.7. Модели, роутинг, Fusion

Провайдеры: Anthropic, OpenAI, Google, Cognition + open-source DeepSeek, Kimi, GLM; алиасы `opus`, `sonnet`, `swe`, `codex`, `gemini`; примеры `swe-1-6-fast`, `gpt-5` (S103). «Fusion» — «pairing a frontier lead model with a cost-efficient sidekick» (S103). «Adaptive» — intelligent model router, анализирует промпт, простые задачи отправляет быстрым моделям, сложные — сильным; включается `/model adaptive`, `--model adaptive` или `agent.model: "adaptive"`; в enterprise по умолчанию выключен и требует, чтобы пул моделей был разрешён (S104). Пользовательских правил роутинга не документировано.

BYOK и локальные модели в CLI-документации не описаны (S103) — в отличие от AI Assistant, где они есть. Зато в federal-документации есть air-gapped развёртывание с `models.json`, указывающим на OpenAI-compatible эндпоинты (индекс S86).

### 6.8. Разрешения, sandbox, секреты

CLI (S101): правила `Read(glob)`, `Write(glob)`, `Exec(prefix)`, `Fetch(pattern)`, tool-имена `read`/`edit`/`grep`/`glob`/`exec`, MCP-паттерны `mcp__server__tool`/`mcp__server__*`/`mcp__*`; порядок внутри уровня `deny` → `ask` → `allow` → prompt; «A deny rule always wins»; приоритет уровней Organization/team → session grants → `.devin/config.local.json` → `.devin/config.json` → `~/.config/devin/config.json`; нижний `allow` не может переопределить верхний `ask`. Режимы: `Normal` (read-only auto, записи и shell спрашивают), `Accept Edits`, `Smart` (быстрая модель решает, безопасно ли авто-исполнение), `Bypass` (всё авто), `Autonomous (sandbox)` (shell/fetch авто, прямой `edit`/`write` всё равно спрашивает). Scope'ы сохранения allow-решения: once, session, project, project-local, global.

Sandbox (S99): `--sandbox` — OS-изоляция, запись только в `Write(...)`-скоупы и workspace, остальное read-only; `Read(...)` в deny-листе полностью скрывает пути; **fail-closed** — «refuse to start rather than running unsandboxed»; Windows не поддерживается; Linux требует `bubblewrap` и `socat`; сеть — `allowed_domains`, `denied_domains`, `network_mode` (`full`/`limited`, где limited = только GET/HEAD/OPTIONS), паттерны `example.com`, `*.example.com`, `**.example.com`; честная оговорка «Sandbox network filtering is currently unstable»; исключённые команды только `Exec(...)`-правилами с порядком `deny` > `ask` > `allow`; persistent PTY-команды всегда внутри sandbox. Enterprise enforcement: `Optional` / `Required` (форсирует `--sandbox`) / `Strict` (будущий режим); enterprise allowlist **заменяет** пользовательский, denylist **дополняет**.

Секреты (S95): четыре scope'а — «Persisted Global Secrets» (org-wide, админы управляют просмотром), «Personal Secrets» (только сессии этого пользователя), «Repo-Specific Secrets» (в blueprint репозитория, доступны при сборке snapshot и в сессиях), «Session-Specific Secrets» (только текущий разговор, не сохраняются). Форматы: Raw Secret, Site Cookies (base64 Chromium cookie JSON), TOTP. В браузере Devin вводит значения напрямую; для shell секреты биндятся как env vars по необходимости, а не грузятся в каждый shell; имена нормализуются.

Security profiles (S96): ограничивают network policy (allowlist хостов/CIDR), MCP access, «Devin MCP read-only», git access level (`Read-only` — clone/fetch без push/PR; `Full` — включая push/PR), GitHub CLI token; привязка по иерархии Enterprise default → Organization default → Automations default → Automation → Session с «Inherit»/«Pin»/«No profile»; «Mandatory» профиль ограничивает нижние уровни; профили резолвятся при boot/wake/reboot, правки не влияют на работающие сессии; snapshot builds используют только network policy.

### 6.9. Git, PR, review, worktree

Devin работает через ветки и PR в собственной VM; «Stacked PRs» разбивают большое изменение на упорядоченный стек PR, которые лендятся снизу вверх (индекс S86, S107). «Devin Review» (S97) — отдельный продукт ревью: группирует связанные изменения в PR, объясняет их рядом с диффом и помечает потенциальные баги; покрывает GitHub и GitLab, частично Azure DevOps, Bitbucket, Perforce Swarm; ручной триггер `/devin review`; ключевые фичи «Bug Catcher», «Security», «Flags», «Codebase-aware chat»; auto-review по событиям «PR is created»/«PR is ready» и каденции «Only once»/«Every push»; «Custom reviewers» (Beta) с инструкциями/скиллами и уровнями «Severe»/«Moderate»/«Info»; «Autoapprover» (Beta) оценивает, можно ли аппрувить PR без человека, по рубрике intent/code quality/incident risk; контроль стоимости — ACU, Consumption dashboard, «Review size indicator» XS–XL, per-PR spend limit, «Review effort» Normal/Ultra.

Worktree как пользовательская концепция в cloud-модели не нужен (сессия = VM + ветка); в CLI есть worktrees через legacy Cascade-настройки (S111). Отдельного `/rewind` для файлов не документировано; откат — через git.

### 6.10. Remote/cloud, automations, telemetry

Cloud — основной режим. Automations: event-driven workflows из Slack, GitHub, Linear, schedules, webhooks (S86, индекс); scheduled sessions переведены в automations с триггером Schedule (индекс S86). Devin Outposts — self-hosted workers на собственной инфраструктуре (индекс S86). Air-gapped Desktop + CLI для federal с offline license, `models.json` на OpenAI-compatible эндпоинты, собственным OIDC и JSONL audit log для SIEM (индекс S86).

Телеметрия/учёт: ACU как единица; расход зависит от числа и сложности действий и VM-времени; Windows-сессии ~9% дороже Linux, macOS без наценки (promotional); не расходует при ожидании ответа, тестов и клонирования (S110). «Session Insights» — анализ завершённых сессий, проблем, использования knowledge и улучшенных промптов; «Devin Coach» — флаги неэффективных промптов в поле ввода и аналитика для админов (S89, индекс S86). «My Analytics» доступна всем членам, включая Teams (S107).

### 6.11. Цены

Self-serve (S85, S109): Free $0 (1 участник, доступ к Devin Review и DeepWiki), Pro $20/мес (1), Max $200/мес (1, без daily cap), Teams $80/мес минимум + $40/мес за full dev seat, до 100 участников; Enterprise — custom. Квота покрывает sessions + CLI + Desktop. Сверх квоты — on-demand credits по API-ценам. Enterprise — ACU по order form (S110). Модель «план + докупка» вместо чистой подписки — важное отличие от Zed/Claude Code.

### 6.12. Сильные и слабые стороны

**Сильные:** настоящая cloud-автономия с VM, браузером и IDE; зрелая оркестрация на трёх уровнях (CLI-субагенты, Managed Devins, Dynamic Workflows с resume и бюджетом 7 дней); открытый стандарт Skills с максимальным числом поддерживаемых каталогов (10 путей); Memory + Dreaming как редкая попытка фоновой консолидации знаний; security profiles с иерархией привязки и mandatory-профилями; Devin Review с cost cap и autoapprover; fail-closed sandbox; честная документация ограничений (Windows, нестабильная фильтрация сети).

**Слабые:** стоимость и непрозрачность ACU для индивидуальных планов; привязка к облачной инфраструктуре Cognition (кроме Outposts/federal); отсутствие BYOK/локальных моделей в CLI; две миграции расширяемости (Knowledge→Skills, Playbooks→Skills) за короткий срок; sandbox только в CLI и только не на Windows; фильтрация сети сама помечена как нестабильная; браузерная автономия повышает риск prompt injection и требует отдельных guardrails (AI Guardrails, Attribution Filtering — в enterprise-разделе).

---

## 7. Gemini CLI

### 7.1. Позиционирование и статус — главный факт

На дату доступа Gemini CLI находится в состоянии **продуктового сворачивания**, и это надо фиксировать раньше любых фич.

README (S50) содержит баннер:

- «**Enterprise Code Assist only:** Designed for Gemini Code Assist Standard / Enterprise licenses and Code Assist for GitHub on Google Cloud»;
- «**No free tier or Google AI plans:** Free individual access and Google AI Pro / Ultra (Google One) moved to Antigravity CLI on June 18, 2026»;
- «**Not optimized for Gemini 4+:** Not tuned for the Gemini 4 series … or future releases in this or later generations»;
- «**Not for model benchmarks:** Don't use Gemini CLI to benchmark Gemini models».

Официальный блог Google (S69, 19.05.2026) объясняет причину: «your workflows have simply outgrown those early days of 2025», «You now require multiple agents communicating with each other», поэтому «we can serve you best by pouring our energy into a single product built for today's multi-agent reality». 18.06.2026 Gemini CLI и Gemini Code Assist IDE extensions перестают обслуживать AI Pro/Ultra и free individual; enterprise-лицензии не затронуты; Antigravity CLI «keeps the most critical features of Gemini CLI» — Skills, Hooks, Subagents, Extensions (переименованы в plugins), но «there won't be 1:1 feature parity right out of the gate» (S69).

При этом репозиторий продолжает выпускать релизы: v0.64.0 от 13.10.2026 (атомарные операции файловых инструментов, append-only delta patching и bounded history в ChatRecordingService), v0.63.0 от 06.10.2026 (autonomous plan execution в non-interactive режиме) (S71). Каналы nightly/preview/stable с weekly cadence (S50). То есть это **maintenance-режим для enterprise**, а не мёртвый продукт.

### 7.2. Конфликт источников по квотам

`/docs/resources/quota-and-pricing` (S68) всё ещё публикует таблицу дневных лимитов: Google account Code Assist Individual 1 000 запросов/день, AI Pro 1 500, AI Ultra 2 000, API key free 250, Code Assist Standard 1 500, Enterprise 2 000 — и текст «Gemini CLI offers a generous free tier». Это прямо противоречит README (S50) и блогу (S69), которые говорят, что free individual и AI Pro/Ultra переведены на Antigravity 18.06.2026.

Фиксация: страница квот, вероятно, устарела. Для ZCode практический вывод — **не опираться на таблицу квот Gemini CLI как на актуальную**; актуальным считать баннер README и блог. Статус таблицы — `confirmed как опубликованный текст`, но `устаревший относительно S50/S69`.

### 7.3. Поверхности

Terminal TUI, headless `-p` с `--output-format json` и `stream-json`, IDE companion (VS Code), GitHub Action (S50). Плюс A2A remote subagents как способ подключить удалённых агентов (S67).

### 7.4. Инструменты

Каталог (S51) делится на группы:

- исполнение — `run_shell_command` (включая интерактивные и фоновые процессы);
- файлы — `glob`, `grep_search` (legacy alias `search_file_content`), `list_directory`, `read_file` (текст, изображения, аудио, PDF), `read_many_files`, `replace`, `write_file`;
- взаимодействие — `ask_user`, `write_todos`;
- экспериментальный трекер задач — `tracker_create_task`, `tracker_update_task`, `tracker_get_task`, `tracker_list_tasks`, `tracker_add_dependency`, `tracker_visualize`, `update_topic`;
- MCP — `list_mcp_resources`, `read_mcp_resource`;
- память — `activate_skill`, `get_internal_docs`;
- планирование — `enter_plan_mode`, `exit_plan_mode`;
- системное — `complete_task` (только для субагентов);
- сеть — `google_web_search`, `web_fetch` (с проверкой приватных и зарезервированных IP).

Подтверждения: «You must manually approve tools that modify files or execute shell commands (mutators)»; `run_shell_command`, `replace`, `write_file` помечены «Requires manual confirmation»; `web_fetch` в Plan Mode требует явного подтверждения (S51). Браузерного инструмента нет, но есть `browser_agent` как встроенный субагент, выключенный по умолчанию (S52).

### 7.5. Планирование

Plan Mode включён по умолчанию и является read-only средой: исследование, дизайн, план до изменения кода (S57). Вход: `gemini --approval-mode=plan`, Shift+Tab цикл Default → Auto-Edit → Plan, `/plan [goal]`, либо естественный язык → инструмент `enter_plan_mode`. Важная деталь: план пишется **Markdown-файлом в plans directory**, который можно открыть, отредактировать (`Ctrl+X`) и, судя по формулировке, использовать как артефакт ревью. `enter_plan_mode` недоступен в YOLO mode (S57).

В v0.63.0 добавлено «autonomous plan execution in non-interactive mode» — то есть план можно исполнить без человека в headless-сценарии (S71). Это редкая комбинация: plan mode и автономное исполнение плана в одном продукте.

### 7.6. Субагенты

Кастомные агенты — Markdown + frontmatter в `.gemini/agents/*.md` и `~/.gemini/agents/*.md`; обязательные `name`, `description`; опциональные `kind`, `tools`, `mcpServers`, `model`, `temperature`, `max_turns` (default 30), `timeout_mins` (default 10); wildcard'ы `*`, `mcp_*`, `mcp_my-server_*`; встроенные `codebase_investigator`, `cli_help`, `generalist`, `browser_agent` (выключен по умолчанию); «subagents cannot call other subagents» — защита от рекурсии (S52). Remote-субагенты — через A2A, `kind: remote`, тот же формат файлов, proxy через `general.proxy` (S67).

Это самая простая модель субагентов из пяти: один уровень вложенности, без параллельного планировщика, но с явным A2A-мостом к внешним агентам.

### 7.7. Контекст, память, компакция

`GEMINI.md` (S55): иерархия global `~/.gemini/GEMINI.md` → workspace `GEMINI.md` и родительские каталоги → JIT при доступе инструмента к файлу/каталогу (сканирование до trusted root). Всё найденное **конкатенируется** и отправляется с каждым промптом; явного правила разрешения конфликтов не описано. Импорты `@file.md` (относительные и абсолютные). Команды `/memory show`, `/memory reload`. `context.fileName` может включать `AGENTS.md`, `CONTEXT.md`, `GEMINI.md` — то есть имена контекстных файлов конфигурируемы.

Auto Memory (S59, experimental): сканирует прошлые транскрипты, ищет durable facts, предпочтения, ограничения и повторяющиеся процедуры; черновики памяти — unified diff `.patch`, черновики процедур — `SKILL.md`; всё складывается в project-local inbox и **не применяется без одобрения**; требует ≥10 пользовательских сообщений в idle-сессии; включается `experimental.autoMemory`. Это самая «review-first» модель памяти среди пяти.

Компакция: chat compression упоминается в телеметрии и changelog (`ChatRecordingService` с bounded history windowing в v0.64.0), `/rewind` работает поверх точек компрессии, реконструируя историю из сохранённых данных (S60, S71). Порог и настройка компакции публично не документированы.

### 7.8. Checkpoint и rewind — две разные подсистемы

Это важное различие, которое легко упустить:

- **Checkpointing** (S54) — shadow git repository в `~/.gemini/history/<project_hash>`; чекпоинт создаётся **только** при одобрении изменяющего инструмента; хранит полное состояние файлов проекта, историю разговора и ожидающий tool call; `/restore` и `/restore <checkpoint_file>` откатывают всё и заново предлагают исходный tool call; не мешает собственному git-репозиторию проекта; выключено по умолчанию; старый флаг `--checkpointing` удалён в 0.11.0.
- **Rewind** (S60) — `/rewind` или двойной Esc, выбор интеракции, три действия: откатить разговор и код, только разговор, только код; не отменяет ручные правки и изменения от shell; работает поверх компрессии.

То есть checkpoint = «снимок перед мутацией + повторное предложение tool call», rewind = «откат к произвольной интеракции». У Claude Code это объединено в одной подсистеме чекпоинтов с меню восстановления.

### 7.9. Расширяемость

- **Extensions** (S64): `gemini-extension.json` с `mcpServers`, `settings`, `contextFileName`; вклад — MCP server, custom commands, `GEMINI.md`, Agent Skills (`skills/<name>/SKILL.md`), hooks, themes; sensitive-настройки хранятся в системном keychain и инжектируются как env vars; локальная установка `gemini extensions link .`.
- **Custom commands** (S63): TOML v1, обязательный `prompt`; `~/.gemini/commands/` и `<project>/.gemini/commands/`; project переопределяет user; `git/commit.toml` → `/git:commit`; `{{args}}`, `!{...}` (shell с подтверждением), `@{...}` (инъекция файла/листинга).
- **Skills** (S66): открытый стандарт agentskills.io; discovery → activation через `activate_skill` → consent prompt с именем, назначением и путём → injection тела `SKILL.md` → каталог skill'а добавляется в разрешённые пути чтения. Это самая явная модель согласия на skill среди пяти.
- **Hooks** (S64, S72): lifecycle-события, конфигурируются расширением.
- **Policy engine** (S65): TOML-политики в `~/.gemini/policies/*.toml`, правила `toolName`, `commandPrefix`, `decision` (allow/deny/confirm), `priority`; это отдельный от approval-mode слой, пригодный для администрирования.

### 7.10. Модели, роутинг, fallback

Модели — Gemini; доступ через OAuth Google, Gemini API key, Vertex AI (S50). Model routing (S58): `ModelAvailabilityService` отслеживает здоровье модели и при отказе (квота, серверная ошибка) инициирует fallback; по умолчанию **спрашивает пользователя**; некоторые utility-вызовы (prompt completion, классификация) используют тихий fallback-чейн `gemini-2.5-flash-lite` → `gemini-2.5-flash` → `gemini-2.5-pro` без смены настроенной модели. Приоритет выбора: `--model` → `GEMINI_MODEL` → `model.name` в settings → локальный Gemma-роутер (experimental) → default `auto`. Локальный роутер на Gemma — уникальная для этой пятёрки идея: решения о маршрутизации не отправляются в хостед-модель.

### 7.11. Разрешения, sandbox, безопасность

Approval modes: Default → Auto-Edit → Plan, плюс YOLO (S57). Policy engine с приоритетами (S65). Trusted folders (S62): выключено по умолчанию; при включении untrusted-папка работает в «safe mode» — не грузятся project settings и `.env`, блокируются установка/обновление/удаление расширений, каждое tool-run требует одобрения, останавливается автоматическая загрузка локальной памяти, **не выполняются подключения к MCP-серверам**, не загружаются `.toml`-команды; решения в `~/.gemini/trustedFolders.json`; `--skip-trust` и `GEMINI_CLI_TRUST_WORKSPACE=true` для headless; `/permissions` меняет доверие текущей папки. Это самая агрессивная модель «недоверенной папки» из пяти — вплоть до отключения MCP.

Sandbox (S53): пять методов — macOS Seatbelt (`sandbox-exec`), Docker/Podman, Windows Native Sandbox, gVisor/runsc (Linux), LXC/LXD (Linux, experimental); `tools.sandbox` принимает `true`/`"docker"`/`"podman"`/`"sandbox-exec"`/`"runsc"`/`"lxc"` или объект с `command` и `image`; `security.toolSandboxing: false` отключает tool-level sandboxing (требует рестарта); env-контроли `GEMINI_SANDBOX`, `GEMINI_SANDBOX_IMAGE`, `SEATBELT_PROFILE`, `SANDBOX_MOUNTS`, `SANDBOX_FLAGS`, `SANDBOX_SET_UID_GID`; изоляция может ограничивать ФС проектом, контейнер даёт полную процессную изоляцию, workspace биндится по тому же абсолютному пути.

Это самый широкий выбор sandbox-бэкендов среди пяти продуктов.

### 7.12. Телеметрия

OTel (S56): логи, метрики, трейсы; общие атрибуты `session.id`, `installation.id`, `active_approval_mode`, `user.email` (при аутентификации); `target` = `gcp` или `local`; GCP-экспорт идёт в Cloud Trace/Monitoring/Logging; локально — `outfile` или OTLP-коллектор (`otlpEndpoint`, default `http://localhost:4317`); транспорт `otlpProtocol` (grpc/http), `otlpHeaders`, `useCollector`. Ключи в `.gemini/settings.json`: `enabled`, `traces`, `target`, `otlpEndpoint`, `otlpProtocol`, `otlpHeaders`, `outfile`, `logPrompts`, `useCollector`, `useCliAuth`; env-оверрайды `GEMINI_TELEMETRY_*`.

Приватность: телеметрия выключена по умолчанию (`enabled`), но `logPrompts` по умолчанию **true** — то есть при включении телеметрии содержимое промптов логируется, пока явно не выключено; детальные атрибуты трейсов (полные промпты и выводы инструментов) по умолчанию выключены, включаются `traces` или `GEMINI_TELEMETRY_TRACES_ENABLED`; `user.email` только при аутентификации; маскирование вывода инструментов логируется как `gemini_cli.tool_output_masking` (S56).

### 7.13. Цены

Формально: enterprise-лицензии Code Assist Standard/Enterprise и Code Assist for GitHub на Google Cloud, плюс legacy paid API/Vertex keys (S50). Таблица квот (S68) перечисляет дневные лимиты, но противоречит баннеру о прекращении consumer-доступа. Публичной цены за место на страницах Gemini CLI не найдено; цены Code Assist — на отдельной странице Google Cloud, которая в этой сессии не открывалась (редирект на `docs.cloud.google.com` и затем 404 при повторной попытке).

### 7.14. Сильные и слабые стороны

**Сильные:** открытый исходный код (Apache 2.0) и прозрачный changelog; Plan Mode по умолчанию с планом-файлом; самая широкая палитра sandbox-бэкендов; policy engine с приоритетами; trusted folders с отключением MCP; review-first Auto Memory; `activate_skill` с явным consent; A2A remote subagents; локальный Gemma-роутер; честный баннер о статусе продукта.

**Слабые:** продукт в maintenance-режиме и прямо объявлен «not optimized for Gemini 4+»; consumer-аудитория переведена на Antigravity CLI; документация противоречит сама себе по квотам; документация частично недоступна (404 на architecture/evals); субагенты без вложенности; нет браузерного инструмента (только выключенный `browser_agent`); checkpointing выключен по умолчанию; `logPrompts` по умолчанию true при включённой телеметрии.

---

## 8. Короткий скан прочих инструментов

Формат: одна строка статуса + официальный URL. Глубоко не проверялось; всё, что не подтверждено первоисточником, помечено.

- **Amazon Q Developer** — AWS-ассистент с агентными сценариями (features, tests, review, refactor, upgrades); IDE-плагины поддерживаются до 30.04.2027 с переводом пользователей на Kiro; Free 50 agentic requests/мес, Pro $19/user/мес. `confirmed` для чисел, `marketing` для позиционирования. https://aws.amazon.com/q/developer/ · https://aws.amazon.com/q/developer/pricing/ (S113, S114).
- **Augment Code (Cosmos + Auggie CLI)** — «always-on software delivery system» с общим контекстом и памятью, агентами Code/Review, запуском в managed cloud sandboxes или на машинах клиента; Standard $20/мес flat, Business $100/мес flat, Enterprise custom. `marketing` для позиционирования, `confirmed` для цен и CLI-описания. https://www.augmentcode.com/ · https://www.augmentcode.com/pricing · https://docs.augmentcode.com/cli/overview (S115, S116, S117, S118).
- **Replit Agent** — «AI App and Website Builder» для не-разработчиков: describe-and-publish, «Infinite Canvas», Intelligent Model Routing (заявлено «65% lower average cost»), встроенные Auth/DB/Hosting/Monitoring; Free mode до 30 часов чата и 60 проектов, Core $20/мес, Pro $100/мес, Enterprise custom. Всё — `marketing`, числа — с официальной страницы. https://replit.com/agent (S119).
- **Tabnine** — «fully private, organization-aware AI coding agent», работающий целиком в окружении клиента; Tabnine Agent (CLI/IDE) и Tabnine Chat; каталог моделей от Claude/GPT/Gemini до открытых (Devstral, MiniMax, GLM, Qwen); private installation может использовать собственные эндпоинты. **Статус владения не подтверждён:** новостной индекс Tricentis содержит карточку от 30.07.2026 «Insight Partners-Backed Tricentis Acquires Tabnine» со ссылкой на торговое издание, первичного пресс-релиза получить не удалось; docs.tabnine.com переходного баннера не показывает. `unverified` для сделки, `confirmed` для продукта и моделей. https://docs.tabnine.com/main · https://docs.tabnine.com/main/welcome/readme/ai-models.md · https://www.tricentis.com/news (S120, S121, S122).

---

## 9. Сводные наблюдения по рынку

### 9.1. Сходимость к открытым стандартам

Четыре из пяти глубоко покрытых продуктов используют `.agents/skills` или `SKILL.md`:

| Продукт | Путь skills | Стандарт |
| --- | --- | --- |
| Zed | `~/.agents/skills/`, `<worktree>/.agents/skills/` (S7) | `SKILL.md` + frontmatter, progressive disclosure |
| Claude Code | `.claude/skills/`, `~/.claude/skills/`, nested, plugin (S34) | `SKILL.md`, commands merged into skills |
| Gemini CLI | `.gemini/skills` через extensions, `activate_skill` (S51, S64, S66) | agentskills.io |
| Devin | `.agents/skills/` рекомендован + 9 других корней (S92) | Agent Skills standard |
| JetBrains | «Agent Skills packages» (S75) | не детализировано (B6) |

То же с `AGENTS.md`: Zed читает его как project instructions (S15), Claude — как fallback при отсутствии CLAUDE.md (S29), Gemini — через `context.fileName` (S55), Devin — с лимитом 16 KiB (S108), JetBrains — «Project rules» без указания формата (S78).

Практический вывод: формат файлов перестал быть дифференциатором. Дифференциаторами стали **модель разрешений**, **изоляция исполнения**, **оркестрация** и **наблюдаемость**.

### 9.2. Три архетипа разрешений

1. **Правила-паттерны + режим** (Claude Code, Devin, Zed, Gemini policy engine): `ToolName(specifier)` с приоритетами и отдельным слоем режима. Наиболее зрелая версия — Claude (6 режимов + классификатор auto mode + managed policies) и Devin (5 режимов + иерархия уровней + mandatory-профили).
2. **Профиль инструментов отдельно от разрешений** (Zed): `agent.profiles` отвечает за доступность, `agent.tool_permissions` — за allow/deny/confirm. Чистое разделение, но требует от пользователя понимать две сущности.
3. **Governance-слой сверху** (JetBrains Air, Devin security profiles): бюджеты, allowlist провайдеров, mandatory-профили, аудит. Это то, чего обычно не хватает индивидуальным планам.

### 9.3. Sandbox: четыре разных ответа

- **Claude Code:** OS-sandbox только для shell, сеть через прокси с allowlist, credentials deny/mask, отдельно от permissions (S28).
- **Devin:** `--sandbox` fail-closed, запись только в разрешённые скоупы, network allowlist, enterprise enforcement Required/Strict (S99).
- **Zed:** Seatbelt/Bubblewrap для `terminal` и `fetch`, ручное управление `agent.sandbox_permissions` (S14).
- **Gemini CLI:** пять бэкендов на выбор, включая gVisor и LXC, плюс tool-level sandboxing (S53).

Общее: sandbox нигде не покрывает **все** инструменты. Claude прямо говорит, что файловые инструменты, MCP и hooks вне границы (S28); Zed ограничивает `terminal` и `fetch` (S14); Devin ограничивает shell и запись (S99). Это системное ограничение архитектуры «агент как набор инструментов», а не недосмотр конкретного продукта.

### 9.4. Память: три школы

- **Файловая и явная** (Claude Code): `MEMORY.md` + topic files, всегда-загружаемый индекс с лимитом (S29).
- **Автоматическая с ревью** (Gemini CLI): Auto Memory предлагает патчи и `SKILL.md` в inbox, человек одобряет (S59).
- **Фоновая консолидация** (Devin): Memory drive + Dreaming раз в сутки (S91).

Zed и JetBrains в доступных источниках память не документируют (S1, B6). ZCode имеет memory-runtime с recall/write и дедупликацией (см. §11).

### 9.5. Оркестрация: от потоков до детерминированных скриптов

| Уровень | Примеры |
| --- | --- |
| Несколько потоков вручную | Zed Parallel Agents + worktree (S11), Claude Desktop split view (S48) |
| Субагенты внутри сессии | Claude `Agent` (S26), Gemini subagents (S52), Zed `spawn_agent` (S2), Devin CLI subagents (S98) |
| Координатор + рабочие | Claude Projects (S40), Devin Managed Devins (S89) |
| Детерминированный скрипт | Devin Dynamic Workflows (S90) |
| Команда с общим списком задач | Claude agent teams (experimental, S47) |
| Удалённые агенты по протоколу | Gemini A2A remote subagents (S67), Zed ACP external agents (S10) |

ZCode Dynamic Workflow находится на уровне «детерминированный скрипт» — том же, что Devin Dynamic Workflows, с почти идентичным API (`pipeline`, `parallel`, `phase`, `agent`, resume).

### 9.6. Remote/cloud: направление передачи работы имеет значение

- **Claude Code** различает три направления и честно документирует, что не переносится: `--cloud` (локально → облако), `--teleport` (облако → локально), Remote Control (облако управляет локальным) (S39, S41).
- **Devin** делает облако основным, а локальное — вспомогательным, с `/handoff` в обе стороны и «Local Hands» для доступа к машине пользователя (S105, S86).
- **Zed** не имеет своего облака и делегирует его External Agents (S10).
- **Gemini CLI** передал consumer-облако Antigravity (S69).
- **JetBrains** строит Air Teams как облачную поверхность (S74, S81).

### 9.7. Телеметрия: только двое публикуют контракт

Claude Code (S43) и Gemini CLI (S56) публикуют имена метрик/событий и флаги контент-логирования. Zed говорит о наличии телеметрии без каталога (S13). Devin даёт бизнес-аналитику (ACU, Session Insights, Coach) без технического OTel-контракта (S89, S107). JetBrains даёт governance-аналитику без публичного каталога (S80).

### 9.8. Ценовые модели

| Модель | Продукты | Особенность |
| --- | --- | --- |
| Подписка + кредит + наценка | Zed ($10/$5 кредит, +10% на токены) | Прозрачная наценка на прайс провайдера (S19, S22) |
| Подписка с пулом и лимитами | Claude Code (Pro/Max/Ultra, 5x/10x) | Лимиты выражены в кратности Pro (S45) |
| Подписка + докупка | Devin (Pro/Max/Teams + on-demand credits, ACU в enterprise) | Двойная метрика: квота и ACU (S85, S109, S110) |
| Кредиты + BYOK без наценки | JetBrains Junie (10/35 кредитов, BYOK по ценам провайдера) | Бесплатный Lite + нулевая наценка на BYOK (S75) |
| Enterprise-лицензия | Gemini CLI (Code Assist Standard/Enterprise) | Consumer-тарифы сняты (S50, S69) |
| Flat + usage | Augment ($20/$100 flat, до 50 мест) | Цена не за место, а за пул usage (S116) |

---

## 10. Кандидатные рекомендации для ZCode

Каждая рекомендация содержит: (а) конкурентное свидетельство с ID источника, (б) что уже есть в ZCode по проверенным файлам, (в) пометку `needs ZCode evidence`, если отсутствие/наличие не подтверждено полностью.

### R1. Session-level worktree isolation как первоклассная поверхность

**Конкурентное свидетельство:** Claude `--worktree`/`-w`, `.claude/worktrees/`, `isolation: worktree` для субагентов, `.worktreeinclude` для gitignored файлов, `WorktreeCreate`/`WorktreeRemove` хуки (S38); Zed worktree picker и detached HEAD при создании (S11); Gemini `--worktree` с `.gemini/worktrees/` (S61); Devin — отдельная VM на сессию и отдельная ветка (S84, S97).

**Что есть в ZCode:** изоляция `worktree` существует **только внутри Dynamic Workflow** — `WorkflowAgentIsolationSchema = z.enum(["worktree"])` (`apps/zcode-cli/packages/contracts/src/workflow/script.ts:42`) и `opts.isolation: 'worktree'` в описании Workflow-инструмента (`apps/zcode-cli/packages/core/src/tool/handlers/workflow-description.ts:3`), где прямо сказано, что это дорого (~200–500 мс setup + диск на агента) и применять только при параллельных мутациях.

**Рекомендация:** ввести сессионный аналог (`--worktree` / UI-переключатель) с теми же гарантиями: отдельный каталог, отдельная ветка, копирование gitignored файлов по манифесту, автоочистка неизменённых. Не изобретать новую семантику — переиспользовать существующий workflow-механизм.

**needs ZCode evidence:** наличие session-level worktree в CLI-аргументах и Desktop UI не подтверждено; в проверенных файлах найден только workflow-уровень.

### R2. Публичный контракт разрешений: грамматика правил + приоритеты

**Конкурентное свидетельство:** Claude `ToolName(specifier)` с неочевидной семантикой (`Edit(...)` разрешает чтение, `Read(...)` deny блокирует `Edit`/`Write`) и managed policies (S25, S31); Devin `Read/Write/Exec/Fetch` + `deny > ask > allow` + пять уровней конфигурации (S101, S102); Gemini policy engine TOML с `priority` (S65); Zed `pattern` + `case_sensitive` + фиксированный порядок из шести уровней (S5).

**Что есть в ZCode:** `permission-broker`, `mode-policy` (build/edit/plan/yolo), `tool-scheduler` перечислены в карте возможностей (`apps/dev-docs/src/data/productCapabilityMap.ts:433-552`); в bootstrap есть `readProjectPermissionMode` и `persistedMode` (`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:270`).

**Рекомендация:** опубликовать пользовательскую грамматику правил и таблицу приоритетов как часть спецификации, а не только как поведение кода. Без публичного контракта нельзя ни задокументировать, ни протестировать совместимость.

**needs ZCode evidence:** наличие user-facing rule grammar (паттерны вида `Bash(...)`) в проверенных файлах не подтверждено; подтверждён только broker/mode-слой.

### R3. OS-sandbox как отдельный слой, не как «режим»

**Конкурентное свидетельство:** Claude явно пишет, что `/sandbox` — «not a permission mode», и разделяет pre-execution approval и runtime boundary (S28); Devin делает `--sandbox` fail-closed (S99); Zed документирует отдельные `agent.sandbox_permissions` (S14); Gemini имеет `security.toolSandboxing` отдельно от approval modes (S53).

**Что есть в ZCode:** в проверенных файлах найден `bash-readonly-policy` (`apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-core.ts`) и сетевые настройки прокси в bootstrap (`httpProxy`, `noProxy`, `caCertFile` в `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`).

**Рекомендация:** если OS-sandbox планируется, зафиксировать его как отдельный контракт с явным перечислением того, что он **не** покрывает (файловые инструменты, MCP, hooks), и с fail-closed поведением. Копировать структуру Claude (Seatbelt/bubblewrap + прокси-allowlist + credentials deny/mask), а не изобретать.

**needs ZCode evidence:** наличие OS-level sandbox в ZCode не подтверждено; подтверждено только наличие readonly-политики для bash и прокси-настроек.

### R4. Hooks: добавить события компакции и worktree

**Конкурентное свидетельство:** Claude имеет `PreCompact`/`PostCompact`, `WorktreeCreate`/`WorktreeRemove`, `InstructionsLoaded`, `FileChanged`, `PreModelSwitch`/`PostModelSwitch` (S27); Devin имеет `PostCompaction` и `SessionStart`/`SessionEnd` (S100); Gemini имеет hooks через extensions (S64); Zed хуков не имеет вовсе (S2, S16) — это пример разрыва, который стоит закрыть.

**Что есть в ZCode:** hooks загружаются extension-loader'ом и участвуют в turn orchestration и permission broker (`apps/dev-docs/src/data/productCapabilityMap.ts:649-768`, связи `hooks → turn-orchestration` и `hooks → permission-broker`); есть client-visible сводка Hook-исполнения (`hook-turn-summary`).

**Рекомендация:** проверить, покрывают ли текущие события компакцию и worktree; если нет — добавить `PreCompact`/`PostCompact` (нужны для повторной инъекции правил после сжатия) и события жизненного цикла worktree (нужны для setup/cleanup в изолированных сессиях).

**needs ZCode evidence:** полный список событий ZCode hooks в проверенных файлах не найден; подтверждено только наличие hook-механизма.

### R5. Согласие и границы skill'ов как продуктовый контракт

**Конкурентное свидетельство:** Gemini `activate_skill` показывает consent prompt с именем, назначением и **каталогом**, который skill получит, и добавляет этот каталог в разрешённые пути чтения (S66); Zed загружает project-local skills только из trusted worktrees (S7); Claude разделяет `disable-model-invocation` и `user-invocable` (S34); Devin сканирует 10 корней и задаёт `allowed-tools` (S92).

**Что есть в ZCode:** skills живут в `.agents/skills/<name>/SKILL.md` (workspace: `.agents/skills/*/SKILL.md`), загружаются через `bundledSkillRoots` и `pluginSkillRoots` (`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:255-258`), а `skill-command-overrides` управляет отключением.

**Рекомендация:** сделать границы skill'а явными: какой каталог он получает, какие инструменты ему pre-approved, что происходит при конфликте имён. Модель Gemini (consent + directory grant) — самая проверяемая для пользователя.

**needs ZCode evidence:** наличие consent-шага и directory grant при активации skill'а не подтверждено.

### R6. Память с обязательным ревью перед применением

**Конкурентное свидетельство:** Gemini Auto Memory складывает предложения в inbox и «never applies them without your approval», черновики памяти — `.patch`, черновики процедур — `SKILL.md` (S59); Devin Memory пишет в git-репозиторий с `MEMORY.md` и отклоняет stale-записи (S91); Claude auto memory имеет явный лимит загрузки индекса (200 строк / 25KB) (S29).

**Что есть в ZCode:** `memory-runtime` с recall/write, summary, topic-ретривом, remember/forget, редактированием и атомарной персистентностью (`apps/dev-docs/src/data/productCapabilityMap.ts:433-552`).

**Рекомендация:** если память пишется автоматически, добавить review-очередь с diff-представлением и отбрасыванием stale-записей. Если уже есть — задокументировать как контракт.

**needs ZCode evidence:** наличие review-шага перед записью памяти не подтверждено; подтверждено наличие recall/write.

### R7. Plan mode с планом-файлом в рабочем каталоге

**Конкурентное свидетельство:** Gemini пишет план Markdown-файлом в plans directory, позволяет открыть/отредактировать и исполняет план автономно в headless (S57, S71); Junie хранит планы в `.junie/plans`, коммитит их и может использовать разные модели для плана и реализации (S75); Claude имеет `EnterPlanMode`/`ExitPlanMode` с явным утверждением (S25, S31); Devin использует `Ask` для планирования и переноса в `Agent` (S87).

**Что есть в ZCode:** `/plan` shortcut с compare-and-set переключением и отказом при вложениях (`apps/dev-docs/src/data/productCapabilityMap.ts:325-444`, `plan-shortcut`), mode-policy с build/edit/plan/yolo.

**Рекомендация:** сохранять утверждённый план как файл в workspace (например, `.zcode/plans/<name>.md`), чтобы он был ревьюабельным артефактом и переживал компакцию. Это дешёвая функция с высоким эффектом на воспроизводимость.

**needs ZCode evidence:** сохранение плана в файл не подтверждено; подтверждён только plan-shortcut и mode-policy.

### R8. Публичный контракт наблюдаемости (метрики/события/редакция)

**Конкурентное свидетельство:** Claude публикует имена метрик и событий и отдельные флаги для контента, по умолчанию выключенные (S43); Gemini публикует ключи OTel и честно указывает, что `logPrompts` по умолчанию true (S56); Devin даёт бизнес-аналитику (ACU, Session Insights, Coach) без технического контракта (S89, S107).

**Что есть в ZCode:** OTel-экспортёр (`apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts` — OTLPMetricExporter, OTLPTraceExporter, AsyncLocalStorageContextManager), `usage-fact-collection` → `usage-sqlite` с 30-дневным хранением (`apps/dev-docs/src/data/productCapabilityMap.ts:649-768`).

**Рекомендация:** опубликовать стабильные имена метрик и явные гейты для контента (промпты, вывод инструментов, тела API). Claude-модель (всё контентное — opt-in) безопаснее Gemini-модели (`logPrompts` по умолчанию true).

**needs ZCode evidence:** публичный список метрик ZCode не найден; подтверждено наличие OTel-экспортёра и usage-хранилища.

### R9. Явная семантика handoff между локальным и удалённым исполнением

**Конкурентное свидетельство:** Claude документирует для каждой remote-функции, что **не** переносится (запущенные shell-команды, субагенты, scheduled tasks при reclaim; ранние сообщения при teleport компактированной сессии; untracked файлы в bundle) (S39, S41); Devin имеет `/handoff` в обе стороны и «Local Hands» с одобрением каждого вызова (S105, S86).

**Что есть в ZCode:** `local-host`, `remote-host` (SSH/WSL/Docker), `mobile-remote`, `relay-pairing`, `shared-attachment`, `desktop-continuous` и `mobile-replayable` как раздельные delivery-контуры (`apps/dev-docs/src/data/productCapabilityMap.ts:541-660`); AGENTS.md требует не смешивать эти два семантических контура.

**Рекомендация:** опубликовать таблицу «что переносится / что не переносится» для каждого перехода (local→remote, remote→local, mobile→desktop). У ZCode архитектурно уже есть разделение контуров; не хватает пользовательского контракта.

**needs ZCode evidence:** пользовательская документация о потерях при handoff не проверялась.

### R10. Review как отдельный сервис с контролем стоимости

**Конкурентное свидетельство:** Devin Review с «Bug Catcher»/«Security»/«Flags», custom reviewers, autoapprover, per-PR spend limit и review size indicator (S97); Claude Code Review с глубиной Quick/Standard/Deep, read-only доступом и явным «never approves or blocks the PR» (S44); Zed Review Changes с multi-buffer и accept/reject хунков (S4).

**Что есть в ZCode:** `git-diff-ui` (статус, diff, stage, commit, ветки) и skill `code-review` (`.agents/skills/code-review/SKILL.md`).

**Рекомендация:** если review станет продуктом, скопировать две вещи: (1) явное «review не аппрувит и не блокирует», (2) лимит расхода на PR с индикатором размера. Это защищает от главного риска AI-ревью — тихого роста стоимости.

**needs ZCode evidence:** наличие серверного review-сервиса с бюджетом не подтверждено; подтверждён только UI-diff и skill.

### R11. Кросс-сессионная связь и «agent command center»

**Конкурентное свидетельство:** Claude `ListAgents`/`SendMessage` и cross-session messaging, Desktop показывает другие сессии (S25, S48); Devin Agent Command Center объединяет локальных и облачных агентов (S111); Zed Threads Sidebar группирует потоки по проекту (S4); Claude agent teams — общий список задач и прямая коммуникация (S47, experimental).

**Что есть в ZCode:** `task-navigation` (проекты/группы/таймлайн, поиск, Command Center) в карте возможностей; `child-runtime → interaction-broker → product-projection` для зеркалирования дочерних взаимодействий в родительскую задачу (`apps/dev-docs/src/data/productCapabilityMap.ts:649-768`).

**Рекомендация:** ZCode уже имеет половину (Command Center, зеркалирование дочерних событий). Не хватает явной межсессионной адресации (list/message) с контролем прав. Реализовывать без экспериментального статуса, в отличие от Claude agent teams.

**needs ZCode evidence:** наличие cross-session messaging не подтверждено.

### R12. Модельный роутинг с наблюдаемым решением

**Конкурентное свидетельство:** Devin Adaptive router + Fusion (frontier lead + дешёвый sidekick) + `pinned_models` (S103, S104); Gemini fallback-чейн с подтверждением и локальный Gemma-роутер (S58); JetBrains «Plan on a powerful model, implement on a fast one» (S75); Zed `compaction_model` и `thread_summary_model` как отдельные дешёвые роли (S17).

**Что есть в ZCode:** `provider-registry`, `model-config-rules`, `model-token-limits`, `model-reasoning`, `subagent-profiles` и `offpeak` в карте возможностей; Dynamic Workflow поддерживает `opts.model` и таблицу `model()` на фазу (`apps/zcode-cli/packages/core/src/tool/handlers/workflow-description.ts:3`, `apps/zcode-cli/packages/bootstrap/tests/dynamic-workflow-skill.test.ts:325-444`).

**Рекомендация:** у ZCode уже есть per-phase model routing внутри workflow. Следующий шаг — сделать решение роутера наблюдаемым (почему выбрана эта модель) и добавить «дешёвые роли» (compaction, summary, classify) как отдельные настройки, как у Zed.

**needs ZCode evidence:** наличие отдельных настроек моделей для компакции/суммаризации не подтверждено.

### R13. Явный статус экспериментальных функций

**Конкурентное свидетельство:** Claude маркирует agent teams экспериментальными и перечисляет известные ограничения (S47); Gemini маркирует Auto Memory, Git worktrees, Subagents, Plan mode значком 🔬 и требует включения флагами (S59, S61, S72); Devin помечает custom reviewers и Autoapprover как Beta (S97); Zed явно описывает, какие пути не работают на Windows/WSL (S14).

**Что есть в ZCode:** в проверенных файлах — `experimental`-поля в контрактах workflow (`apps/zcode-cli/packages/contracts/src/workflow/script.ts`), а также документация с явными «не-целями» (`docs/file-summary-safe-rewind.md`).

**Рекомендация:** закрепить в спецификации обязательный блок «статус + известные ограничения + что не покрывается» для каждой новой агентской функции. Это дешёвый способ повысить доверие и снизить число ложных ожиданий.

**needs ZCode evidence:** единый публичный реестр статусов функций не проверялся.

---

## 11. Сопоставление с уже существующим в ZCode (локальные свидетельства)

Эти факты проверены по исходникам и документации репозитория и приведены как опорная база для рекомендаций. Это не оценка качества — только наличие.

| Возможность ZCode | Локальное свидетельство | Ближайший конкурент |
| --- | --- | --- |
| Dynamic Workflow с `pipeline`/`parallel`/`phase`/`log`/`budget`/`workflow`/`args` | `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-source.ts:79-93` (глобалы `parallel`, `pipeline`); описание API в `apps/zcode-cli/packages/core/src/tool/handlers/workflow-description.ts:3` | Devin Dynamic Workflows (S90) — почти идентичный API |
| Worktree-изоляция агента внутри workflow | `apps/zcode-cli/packages/contracts/src/workflow/script.ts:42-61` (`WorkflowAgentIsolationSchema`, `isolation: "worktree"`) | Claude `isolation: worktree` (S38), Gemini experimental worktrees (S61) |
| Ограничение параллелизма workflow | `max(4, min(16, cpu cores - 2))`, cap 1000 агентов, до 4096 items на вызов (`workflow-description.ts:3`) | Devin Shared VM concurrency cap (S90) |
| Resume workflow по run ID с кэшем префикса | `resumeFromRunId` в `WorkflowInputSchema` (`apps/zcode-cli/packages/contracts/tests/workflow-scheduler-state.test.ts:1-120`); описание resume (`workflow-description.ts:3`) | Devin resume с хэшированием вызовов (S90) |
| Компакция: manual/auto/reactive/microcompact, summary, timeline, rapid-refill breaker | `compact-runtime` (`apps/dev-docs/src/data/productCapabilityMap.ts:433-552`) | Claude auto-compact + `compact_boundary` (S36), Zed `auto_compact` 90% (S17) |
| Память: recall/write, summary, topic-ретрив, remember/forget, атомарная персистентность | `memory-runtime` (`productCapabilityMap.ts:433-552`) | Devin Memory + Dreaming (S91), Gemini Auto Memory (S59) |
| Файловый rewind с preflight и обратным проигрыванием чекпоинтов | `docs/file-summary-safe-rewind.md`; `applyFileRewind` не трогает историю чата | Claude `/rewind` (S30), Gemini `/restore` + `/rewind` (S54, S60) |
| Отсутствие conversation cascade rewind (осознанное решение) | `docs/rewind-button-any-message.md`: «V4 不存在 conversation cascade rewind 命令», `session/rewind` удалён из протокола | Claude восстанавливает и код, и разговор (S30) |
| Hooks в turn orchestration и permission broker | `productCapabilityMap.ts:649-768` (`hooks → turn-orchestration`, `hooks → permission-broker`, `hook-turn-summary`) | Claude 33 события (S27), Devin 8 событий (S100) |
| Extension loader: skills, MCP, hooks, commands, memory | `productCapabilityMap.ts:649-768` | Zed profiles+MCP+skills (S6-S8), Claude plugins (S35) |
| OTel-экспорт метрик и трейсов | `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts` | Claude OTel-контракт (S43), Gemini OTel (S56) |
| Учёт расхода с 30-дневным хранением | `usage-fact-collection → usage-sqlite` (`productCapabilityMap.ts:649-768`) | Devin ACU + analytics (S110), Zed token metering (S22) |
| Browser Use через Node REPL/CDP + Computer Use MCP | `browser-plugin`, `node-repl`, `cdp-control`, `computer-use-mcp` (`productCapabilityMap.ts:325-444`, `541-660`) | Devin Interactive Browser (S88), Claude Browser pane (S48) |
| Мобильный remote с replayable-контуром | `mobile-remote`, `mobile-replayable`, `relay-pairing`, `shared-attachment` (`productCapabilityMap.ts:541-660`) | Claude Remote Control (S41) |
| ACP-клиент для OpenCode | `packages/services/src/opencode-ln-runtime/contract.js` и адаптер | Zed как ACP-хост (S10) |

Важное уточнение: ACP в ZCode обнаружен как **клиент** OpenCode runtime, а не как серверный ACP-хост, принимающий внешние агенты. Утверждение «ZCode умеет хостить внешних ACP-агентов» было бы выходом за пределы проверенного.

---

## 12. Do-not-copy: что не стоит перенимать и почему

1. **Гонка за количеством инструментов и hook-событий (Claude Code: ~45 инструментов, 33 события, 6 режимов, 4+ скоупа настроек).** Причина: релизы почти ежедневные (S46), и каждая новая семантика умножает матрицу совместимости. ZCode должен публиковать **меньший, стабильный** контракт и добавлять расширения через MCP/skills, а не через новые встроенные инструменты.
2. **Agent teams как продуктовая функция по умолчанию.** Claude сам держит их за флагом и предупреждает об ограничениях resume/координации/shutdown (S47). Копировать экспериментальную координацию в основной путь — значит наследовать её баги.
3. **ACU-метрика для индивидуальных планов (Devin).** ACU зависит от «числа и сложности действий» и VM-времени (S110), то есть пользователь не может предсказать счёт. Полезная часть, которую стоит взять, — per-PR spend limit и review size indicator (S97), а не сама метрика.
4. **Два параллельных агентских бренда с разной документацией (JetBrains: AI Assistant + Junie + Air).** Feature-set AI Assistant не упоминает Junie (S78), а продуктовая страница Junie называет его частью Air (S74); документация Junie недоступна (B6). Это создаёт неопределённость для пользователя и поддержки.
5. **Две миграции расширяемости за квартал (Devin: Knowledge→Skills, Playbooks→Skills).** S93 и S94 фиксируют перенос обоих механизмов в Skills в 2026. Сходимость к стандарту правильная, но повторять путь с двумя промежуточными домами не нужно — сразу Skills.
6. **Поддержание двух harness'ов с публичным признанием, что один не оптимизирован под текущие модели (Gemini CLI).** README прямо говорит «Not optimized for Gemini 4+» и «Not for model benchmarks» (S50). Если ZCode когда-нибудь будет выделять «старый» harness, нельзя оставлять его в основном канале с таким дисклеймером — это разрушает доверие.
7. **Позиционирование «no coding needed» (Replit).** S119 адресует не-разработчиков и продаёт хостинг/БД/Auth. ZCode адресует инженеров; копирование этой рамки размывает продукт.
8. **`search_web`, привязанный к подписке (Zed).** Инструмент, который молча меняет поведение в зависимости от плана, усложняет документацию и поддержку (S2). Лучше явная зависимость: «нужен провайдер поиска» — как у Claude `WebSearch` с permission-требованием (S25).
9. **Дефолтное чтение credential-файлов в sandbox (Claude).** Документация сама предупреждает: «This default still allows reading credential files» (S28). Если ZCode делает sandbox, дефолт должен быть deny для `~/.ssh`, `~/.aws`, `~/.config/*` и подобных.
10. **`logPrompts` по умолчанию true (Gemini CLI).** При включённой телеметрии содержимое промптов логируется, пока явно не выключено (S56). Для продукта, который позиционируется как приватный, это неверный дефолт.
11. **Sandbox как «режим разрешений».** Claude прямо разделяет эти слои (S28). Смешение приводит к тому, что пользователь думает, будто «режим» ограничивает исполнение, хотя ограничивает только подтверждения.
12. **Заявление о превосходстве без методики (Amazon Q «most capable», SWE-Bench-заявления).** S113 содержит маркетинговые утверждения без публичной методики на самой странице. В конкурентной документации ZCode лучше избегать непроверяемых суперлативов.

---

## 13. Пробелы покрытия и что осталось непроверенным

### 13.1. Продукты, где измерения остались неизвестными

- **JetBrains Junie:** внутренние инструменты, субагенты, hooks, sandbox, память, компакция, лимиты — неизвестны из-за 403 на страницах документации (B6). Всё, что есть в §5.4, взято с продуктовой страницы (S75) и является маркетинговым описанием, а не техническим контрактом.
- **JetBrains AI Assistant / Air:** цены (B7) и модель разрешений не подтверждены. Известно только, что есть «Human in the Loop» и «Dynamic allowlist» у Junie (S75).
- **Tabnine:** статус владения (S122, `unverified`); BYOK не подтверждён (S121); sandbox/разрешения/агентский loop не проверялись.

### 13.2. Измерения, которые не удалось закрыть по всем продуктам

| Измерение | Кто не закрыт | Причина |
| --- | --- | --- |
| Evals/benchmarks | Zed, Claude Code, Gemini CLI, JetBrains, Devin | Публичных методик на официальных страницах не найдено; у Claude есть `ultrareview` и Code Review, но это продукт, а не eval-контур; у Devin — Session Insights/Coach, но это аналитика использования |
| Компакция (порог/политика) | JetBrains, Devin (кроме `/compact`), Gemini (порог) | Не документировано |
| Память | Zed, JetBrains | Не документировано |
| Hooks | Zed, JetBrains | Не документировано |
| Sandbox | JetBrains, Tabnine | Не документировано |
| Worktree/checkpoint | Devin (checkpoint), JetBrains | Не документировано |
| Публичный контракт телеметрии | Zed, JetBrains, Devin | Публичного каталога метрик нет |

### 13.3. Ограничения метода

- `WebSearch` как отдельный инструмент в этой сессии недоступен. Навигация шла по официальным индексам (`llms.txt`, навигация сайта, changelog-страницы). Часть страниц могла быть не найдена, даже если существует.
- Три страницы возвращали 404 из-за изменившихся путей; для них найдены и использованы актуальные эквиваленты (B1, B11, B13, B16). Это зафиксировано, а не скрыто.
- Страница цен JetBrains рендерится клиентом; числа по AI Assistant/Air не приводятся, чтобы не заполнять их по памяти.
- Даты «последнего обновления» страниц документации, как правило, не публикуются; фиксировалась только дата доступа. Для продуктов с ежедневными релизами (Claude Code, Devin) это означает, что через несколько дней часть деталей может измениться.

---

## 14. Итоговая сводка

**Кто что задаёт:**

- **Claude Code** задаёт планку по **публичному контракту**: agent loop, каталог инструментов, шесть режимов, 33 hook-события, OTel-имена, честные ограничения. Одновременно это самый сложный продукт и самый быстрый по темпу изменений.
- **Devin** задаёт планку по **автономии и оркестрации**: VM на сессию, браузер, Managed Devins, Dynamic Workflows с resume и семидневным бюджетом, Memory + Dreaming, security profiles, review с cost cap.
- **Zed** задаёт планку по **чистоте архитектуры**: три пути агента (свой, ACP, terminal), разделение profiles и permissions, настоящий OS-sandbox для терминала, прозрачная настройка компакции, честная приватность.
- **Gemini CLI** задаёт планку по **sandbox-разнообразию и политикам**: пять бэкендов, TOML policy engine с приоритетами, trusted folders с отключением MCP, review-first Auto Memory, consent при активации skill. Но продукт в maintenance-режиме и сам это объявляет.
- **JetBrains** задаёт планку по **IDE-интеграции и governance**: IntelliJ Engine, Advanced Plan Mode с планами в репозитории, широкий каталог моделей + BYOK + Ollama/LM Studio без наценки, Air Governance с бюджетами. Но страдает от фрагментации трёх продуктов.

**Где у ZCode уже есть паритет или преимущество (по проверенным локальным файлам):** Dynamic Workflow с `pipeline`/`parallel`/`phase`/`budget` и resume; worktree-изоляция на уровне workflow-агента; компакция с четырьмя режимами; память с recall/write; файловый rewind с preflight; hooks в turn orchestration и permission broker; OTel-экспортёр; учёт расхода; Browser Use и Computer Use; мобильный replayable-контур.

**Три главных разрыва, которые видны из конкурентного материала:**

1. **Нет публичного контракта разрешений и sandbox.** У Claude, Devin, Gemini и Zed это документированные слои с грамматикой и приоритетами; в проверенных файлах ZCode найден broker/mode-слой и readonly-политика bash, но не пользовательская грамматика правил и не OS-sandbox.
2. **Worktree-изоляция существует только внутри workflow.** Все четыре конкурента так или иначе дают её на уровне сессии или агента; ZCode — только на уровне `agent(..., {isolation:'worktree'})`.
3. **Нет session-level handoff-контракта «что переносится / что нет».** У Claude это самая сильная сторона документации; у ZCode архитектурно есть раздельные контуры (`desktop-continuous` / `mobile-replayable`, `local-host` / `remote-host`), но пользовательского контракта по потерям при переходах не найдено.

**Артефакт:** `<repo-root>/docs/research/2026-11-11-zcode-broad-competitive-research-evidence/part-g4-zed-jetbrains-devin-others.md`

**Проверки, фактически выполненные в этой ветке:** только чтение первичных веб-источников (WebFetch и `curl` к официальным домены) и чтение локальных файлов/индекса ZCode. Код не запускался, тесты не запускались, typecheck/lint не запускались — это research-only ветка, и продуктовые изменения отсутствуют.
