# C1. Terminal-first coding agents: Codex CLI, Claude Code, Gemini CLI, OpenCode, Aider, Qwen Code

- Branch: C1 (parent ORCH-ZCODE-WIDE-RESEARCH)
- Research date: 2026-11-11
- Source access date for every URL in this file: 2026-11-11
- Language: Russian; product and source titles kept in original form
- Status: partial (only this file was written)

## 1. Scope and method

**Question.** Какие конкретные, воспроизводимые механики используют terminal-first coding agents, чем они отличаются и какие из этих механик стоит изучать, а какие не стоит копировать.

**Products in scope.** OpenAI Codex CLI, Anthropic Claude Code, Google Gemini CLI, OpenCode (sst/opencode, репозиторий переехал в anomalyco/opencode), Aider, Qwen Code.

**Important scope deviation.** Claude Code включён в C1 по требованию задания, но он не является open-source: в файле `LICENSE.md` указано "© Anthropic PBC. All rights reserved." и дана ссылка на Commercial Terms of Service, а публичный репозиторий содержит issues, docs, examples и plugins, а не ядро продукта. Это зафиксировано как факт и учитывается в выводах, а не как ошибка выборки. Source: https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md (2026-11-11); https://github.com/anthropics/claude-code (2026-11-11).

**Method.**
1. Приоритет отдавался первоисточникам: официальная документация продукта, GitHub-репозиторий, changelog/releases, файлы конфигурации и исходный код, если он опубликован.
2. Для каждой механики фиксировались точные имена флагов, ключей конфигурации, файлов, событий и endpoint'ов.
3. Данные о лицензиях, звёздах и релизах получены через GitHub REST API (`api.github.com`) в ходе исследования 2026-11-11; часть повторных запросов позже упёрлась в rate limit, это отмечено в разделе 7.
4. Все страницы читались через WebFetch. Там, где страница недоступна, это явно записано; там, где утверждение взято из маркетингового текста или self-reported benchmark, оно помечено как CLAIM.
5. Ни один продукт не запускался локально, сборка из исходников не выполнялась. Поведение описано по документации и опубликованному коду, а не по наблюдаемому runtime.

**Labels.**
- FACT — подтверждено официальной документацией, репозиторием или changelog.
- CLAIM — заявление производителя или self-reported метрика, не проверенная независимо.
- UNKNOWN — источники не дают ответа; отсутствие упоминания в просмотренных страницах не трактуется как отсутствие функции.

**What would count as a useful answer.** Матрица механик по шести продуктам, перечень конкретных differentiators и список anti-patterns с причиной, почему их не стоит переносить.

## 2. Coverage table

| Product | Repo and license | Primary sources inspected | Coverage status | Main caveat |
|---|---|---|---|---|
| OpenAI Codex CLI | `openai/codex`, Apache-2.0, Rust | 18 официальных docs-страниц (CLI, exec, hooks, subagents, skills, AGENTS.md, config basic/reference/sample/advanced, permissions, approvals/security, app-server, MCP, cloud, review, slash commands, CLI customization), GitHub repo, releases | Высокое | Внутренний agent loop отдельно не документирован; старые URL `developers.openai.com/codex/*` редиректят на `learn.chatgpt.com` |
| Claude Code | `anthropics/claude-code`, проприетарная лицензия, TypeScript | overview, permissions, sandboxing, hooks, sub-agents, skills, plugins, MCP, memory, settings, CLI reference, costs, monitoring-usage, data-usage, LICENSE, repo | Высокое по публичным контрактам | Ядро закрыто; agent loop и полный список tool-ов проверить нельзя |
| Gemini CLI | `google-gemini/gemini-cli`, Apache-2.0, TypeScript | repo, core/index, tools reference, sandbox, checkpointing, extensions index/reference, hooks, subagents, custom commands, trusted folders, telemetry, configuration, releases, plan mode, auto memory, ACP, headless, generation settings, token caching, skills | Высокое | Нет отдельной architecture-страницы; README содержит необычное позиционирование (см. раздел 7) |
| OpenCode | `anomalyco/opencode` (redirect с `sst/opencode`), MIT, TypeScript | docs index, server, agents, permissions, tools, LSP, plugins, build/plugins, MCP, commands, config, rules, skills, providers, terminal, repo layout | Средне-высокое | Маркетинговые страницы и docs расходятся по деталям; hooks plugin API не раскрыт |
| Aider | `Aider-AI/aider`, Apache-2.0, Python | docs index, repo map doc + `aider/repomap.py`, edit formats, git, modes, options, YAML config, lint/test, watch, analytics, benchmarks, leaderboards, install, README, commits page | Высокое по документированным механикам | Нет sandbox/permissions слоя в docs; последний stable-релиз заметно старый |
| Qwen Code | `QwenLM/qwen-code`, Apache-2.0, TypeScript | repo, README, settings, approval mode, model providers, sandbox, sub-agents, hooks, skills, MCP, context cost, docs index | Средне-высокое | `docs/developers/architecture.md` не отдался через WebFetch; часть возможностей заявлена только в README |

**Coverage rule.** Минимум три независимых первоисточника на продукт выполнены для всех шести. Для Claude Code три источника — docs, LICENSE и GitHub repo, но они не раскрывают ядро, потому что исходников нет.

## 3. Capability inventory

### 3.1 OpenAI Codex CLI

**Positioning and architecture.** Репозиторий описывает продукт как "Lightweight coding agent that runs in your terminal" и "a coding agent from OpenAI that runs locally on your computer". Лицензия Apache-2.0, основной язык Rust, релизы `rust-v0.167.1` (2026-11-10). Source: https://github.com/openai/codex (2026-11-11); https://api.github.com/repos/openai/codex (2026-11-11); https://api.github.com/repos/openai/codex/releases (2026-11-11).

- FACT: в дереве `codex-rs` присутствуют отдельные crates `core`, `exec`, `execpolicy`, `app-server`, `app-server-protocol`, `app-server-transport`, `cloud-tasks`, `cloud-client`, `codex-mcp`, `apply-patch`, `bwrap`, `config`, `config-schema`, `code-mode`, `code-mode-host`, `code-mode-runtime`, `agent-roles`, `agent-graph-store`, `connectors`, `core-plugins`. Это указывает на модульное разделение runtime, non-interactive exec, серверного протокола, MCP, sandbox-хелперов и cloud tasks. Source: https://api.github.com/repos/openai/codex/contents/codex-rs (2026-11-11).
- FACT: app-server — двунаправленный JSON-RPC 2.0 поверх stdio (JSONL), также поддерживаются `ws://`, `unix://`, `off`; старт соединения — `initialize`, затем `initialized`. Source: https://learn.chatgpt.com/docs/app-server.md (2026-11-11).
- FACT: контракт app-server задаёт жизненный цикл thread/turn: `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `turn/start`, `turn/steer`, `turn/interrupt`, `review/start`, `command/exec`, `model/list`, `config/read`, `config/value/write`, `config/batchWrite`. События: `thread/started`, `turn/started`, `turn/completed`, `turn/diff/updated`, `turn/plan/updated`, `item/started`, `item/completed`, delta-события. Source: https://learn.chatgpt.com/docs/app-server.md (2026-11-11).
- FACT: approvals в app-server — серверные JSON-RPC-запросы `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`, `item/tool/requestUserInput`; решения `accept`, `acceptForSession`, `decline`, `cancel` плюс execpolicy amendment. Source: https://learn.chatgpt.com/docs/app-server.md (2026-11-11).

**Agent loop.** Отдельного документа с описанием цикла нет (UNKNOWN для внутренностей). Публично виден только контракт: turn запускается, стримит item/delta-события, может быть продолжен `turn/steer` и прерван `turn/interrupt`, завершается статусом `completed`, `interrupted` или `failed`. Source: https://learn.chatgpt.com/docs/app-server.md (2026-11-11).

**Tools.**
- FACT: feature-флаги `[features]` включают `shell_tool`, `unified_exec`, `apps`, `goals`, `hooks`, `fast_mode`, `memories`, `multi_agent`, что показывает наличие shell-инструмента, унифицированного exec, приложений/коннекторов, памяти и мультиагентности как отдельных подсистем. Source: https://learn.chatgpt.com/docs/config-file/config-basic.md (2026-11-11).
- FACT: для правок используется `apply-patch` (отдельный crate), а execpolicy управляет тем, какие команды разрешены вне sandbox. Source: https://api.github.com/repos/openai/codex/contents/codex-rs (2026-11-11); https://learn.chatgpt.com/docs/agent-configuration/rules.md (2026-11-11).
- FACT: web search включается флагом `codex --search`; изображение можно вставить в composer. Source: https://learn.chatgpt.com/docs/codex/cli.md (2026-11-11).

**Context strategy.**
- FACT: иерархия инструкций: в домашней директории читается `AGENTS.override.md`, иначе `AGENTS.md`; затем от корня проекта вниз до текущей директории, в каждом каталоге ровно один файл в порядке `AGENTS.override.md` → `AGENTS.md` → fallback-имена. Файлы конкатенируются, более близкий к cwd файл идёт позже и переопределяет ранние указания. Source: https://learn.chatgpt.com/docs/agent-configuration/agents-md.md (2026-11-11).
- FACT: лимит `project_doc_max_bytes` по умолчанию 32 KiB; fallback-имена задаются `project_doc_fallback_filenames`, например `["TEAM_GUIDE.md", ".agents.md"]`. Source: https://learn.chatgpt.com/docs/agent-configuration/agents-md.md (2026-11-11); https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: skills лежат в `.agents/skills` (repo, repo parent, repo root), `$HOME/.agents/skills`, `/etc/codex/skills` и bundled; `SKILL.md` требует `name` и `description`. Начальный листинг ограничен 2% контекстного окна или 8000 символов, настраивается `skills.max_context_tokens` до 10000. Source: https://learn.chatgpt.com/docs/build-skills.md (2026-11-11).
- FACT: авто-компакция управляется `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope` (`total` или `body_after_prefix`) и `model_post_turn_compact_threshold_percent`. Source: https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).

**Permissions and sandbox.**
- FACT: `approval_policy` принимает `on-request`, `never` или granular-таблицу с полями `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`; `untrusted` больше не поддерживается, `on-failure` deprecated. Source: https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: `sandbox_mode` принимает `read-only`, `workspace-write`, `danger-full-access`. `sandbox_workspace_write.writable_roots` добавляет пути, `sandbox_workspace_write.network_access = true` открывает сеть. Source: https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: по умолчанию сеть выключена. macOS использует Seatbelt через `sandbox-exec`, Linux — `bwrap` плюс seccomp, Windows — MXC с elevated/unelevated fallback, WSL2 — Linux sandbox, WSL1 не поддерживается. Под `workspace-write` пути `.git`, `.agents`, `.codex`, `.aws` остаются рекурсивно read-only. Source: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11).
- FACT: `approval_policy = "never"` не отключает sandbox; `danger-full-access` и флаг `--dangerously-bypass-approvals-and-sandbox` отключают и sandbox, и approvals. Source: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11).
- FACT: beta permission profiles задаются `[permissions.<name>]`, `default_permissions`, `extends` от `:read-only`, `:workspace` или другого named profile; правила файловой системы — `"<path>" = "read" | "write" | "deny"`, network — `network.enabled` и `[permissions.<name>.network.domains]`. Source: https://learn.chatgpt.com/docs/permissions.md (2026-11-11).
- FACT: `sandbox_mode` и `sandbox_workspace_write` взаимоисключающи с permission profiles. Source: https://learn.chatgpt.com/docs/permissions.md (2026-11-11).

**Extensibility.**
- FACT: MCP настраивается в `config.toml` через `mcp_servers.<server-name>`; транспорты stdio (`command`, `args`, `env`, `env_vars`, `cwd`) и streamable HTTP (`url`, `auth`, `bearer_token_env_var`, `http_headers`, `env_http_headers`). Source: https://learn.chatgpt.com/docs/extend/mcp (2026-11-11).
- FACT: `default_tools_approval_mode` принимает `auto`, `prompt`, `writes`, `approve`, переопределяется per-tool через `tools.<tool>.approval_mode`. Source: https://learn.chatgpt.com/docs/extend/mcp (2026-11-11).
- FACT: hooks задаются в `~/.codex/hooks.json`, `<repo>/.codex/hooks.json` или inline-таблицами `[hooks]` в `config.toml`. События: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`, `PreModelRequest`, `PostModelRequest`, `Interrupt`, `SessionStart`, `SubagentStart`, `SessionEnd`. Handler types: `command`, `mcp_tool`; `prompt` и `agent` парсятся, но пропускаются. Source: https://learn.chatgpt.com/docs/hooks.md (2026-11-11).
- FACT: hooks требуют trust: non-managed hook проверяется по хэшу и не запускается до review; `--dangerously-bypass-hook-trust` обходит проверку, `allow_managed_hooks_only = true` в `requirements.toml` оставляет только managed hooks. Source: https://learn.chatgpt.com/docs/hooks.md (2026-11-11).
- FACT: subagents — отдельные TOML-файлы в `~/.codex/agents/` и `.codex/agents/`, обязательные поля `name`, `description`, `developer_instructions`. Глобальные настройки `[agents]`: `enabled`, `max_concurrent_threads_per_session`, `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message`. Built-in: `default`, `worker`, `explorer`. Source: https://learn.chatgpt.com/docs/agent-configuration/subagents.md (2026-11-11).
- FACT: subagent не может переопределить `sandbox_mode`, `approval_policy`, `model_provider`, `mcp_servers`; наследует политику родителя. Source: https://learn.chatgpt.com/docs/agent-configuration/subagents.md (2026-11-11).

**Model routing and cost.**
- FACT: `model`, `review_model`, `model_provider`, `openai_base_url`, `model_context_window`, `model_reasoning_effort`, `model_catalog_json`, `oss_provider` (`lmstudio` или `ollama`). Source: https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: кастомные провайдеры задаются `model_providers.<id>` с `name`, `base_url`, `env_key`, `wire_api`. Source: https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: профили — отдельные файлы `$CODEX_HOME/profile-name.config.toml`, выбираются `codex --profile profile-name`. Source: https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: `codex exec` — non-interactive режим: прогресс в stderr, финальное сообщение в stdout; `--json` даёт JSONL-события `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`; `--sandbox workspace-write` разрешает правки; `--output-schema ./schema.json` требует финальный JSON по схеме; `--ephemeral` не сохраняет rollout; `--skip-git-repo-check` снимает требование Git-репозитория. Source: https://learn.chatgpt.com/docs/non-interactive-mode.md (2026-11-11).
- FACT: `--full-auto` в non-interactive режиме больше не поддерживается. Source: https://learn.chatgpt.com/docs/non-interactive-mode.md (2026-11-11).

**UX surface.**
- FACT: интерактивные команды включают `/permissions`, `/approve`, `/plan`, `/goal`, `/status`, `/usage`, `/debug-config`, `/clear`, `/new`, `/resume`, `/fork`, `/side`, `/compact`, `/recap`, `/export`, `/diff`, `/mention`, `/init`, `/review`, `/ide`, `/worktree`, `/model`, `/agents`, `/subagents`, `/plugins`, `/hooks`, `/mcp`, `/skills`, `/memories`, `/ps`, `/stop`, `/daemon`, `/tui`, `/theme`, `/keymap`, `/vim`, `/statusline`. Source: https://learn.chatgpt.com/docs/developer-commands.md (2026-11-11).
- FACT: TUI позволяет steer активного turn, смотреть команды и diff, вставлять изображения, выбирать syntax theme и открывать длинный prompt в редакторе `VISUAL`/`EDITOR`; `codex resume` переоткрывает чат из текущего репозитория. Source: https://learn.chatgpt.com/docs/codex/cli.md (2026-11-11).
- FACT: cloud tasks запускаются в ChatGPT web/desktop/mobile, используют reusable environments, каждая задача имеет отдельный workspace и может продолжаться, пока компьютер спит. Source: https://learn.chatgpt.com/docs/cloud (2026-11-11).
- FACT: `/review` запускает отдельного reviewer'а по локальному diff или base branch, `review_model` задаёт модель review; cloud review умеет комментировать GitHub PR без создания cloud environment. Source: https://learn.chatgpt.com/docs/code-review.md (2026-11-11).

**Telemetry and evals.** FACT: `[analytics] enabled = false` отключает usage/health-метрики и Statsig; `[otel]` включает OTLP-экспорт (`otlp-http`, `otlp-grpc`), `otel.metrics_exporter = "none"` отключает метрики. Source: https://learn.chatgpt.com/docs/config-file/config-advanced.md (2026-11-11). Публичного eval-набора в просмотренных docs нет — UNKNOWN.

**Release cadence and licensing.** FACT: stable `rust-v0.167.0` (2026-11-06), `rust-v0.167.1` (2026-11-10), параллельно идут alpha `0.169.0-alpha.*`; Apache-2.0. Source: https://api.github.com/repos/openai/codex/releases (2026-11-11); https://api.github.com/repos/openai/codex (2026-11-11).

### 3.2 Anthropic Claude Code

**Positioning and architecture.** FACT: "Claude Code is an agentic coding tool that reads your codebase, edits files, runs commands"; доступен в terminal, IDE, desktop и browser, причём "Each surface connects to the same underlying Claude Code engine", поэтому `CLAUDE.md`, settings и MCP работают одинаково. Source: https://code.claude.com/docs/en/overview (2026-11-11). FACT: репозиторий публичный, но ядро не опубликовано; лицензия проприетарная. Source: https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md (2026-11-11).

**Agent loop.** Публично описан только как engine, общий для поверхностей; внутренний цикл не раскрыт — UNKNOWN. Source: https://code.claude.com/docs/en/overview (2026-11-11).

**Tools.** FACT: permission-правила и sandbox упоминают `Bash`, `Edit`, `Write`, `Read`, `WebFetch`, `WebSearch`, `Agent`; subagent `Explore` имеет запрет на `Write` и `Edit`. Source: https://code.claude.com/docs/en/permissions (2026-11-11); https://code.claude.com/docs/en/sub-agents (2026-11-11). Полный список tool-ов в одном документе не опубликован — UNKNOWN.

**Context strategy.**
- FACT: `CLAUDE.md` читается из managed policy, `~/.claude/CLAUDE.md`, `./CLAUDE.md` или `./.claude/CLAUDE.md`, `./CLAUDE.local.md`; файлы из cwd и всех родителей конкатенируются, порядок — от корня файловой системы вниз, `CLAUDE.local.md` после `CLAUDE.md`. Source: https://code.claude.com/docs/en/memory (2026-11-11).
- FACT: импорты `@path/to/import` резолвятся относительно файла импорта, глубина не более четырёх переходов, code spans и fenced blocks игнорируются. Source: https://code.claude.com/docs/en/memory (2026-11-11).
- FACT: auto memory по умолчанию включена локально, хранится в `~/.claude/projects/<project>/memory/` (`MEMORY.md` плюс topic-файлы); при старте грузятся первые 200 строк или 25 KB `MEMORY.md`, topic-файлы — по требованию. Source: https://code.claude.com/docs/en/memory (2026-11-11).
- FACT: `AGENTS.md` читается только если нет `CLAUDE.md` в cwd или выше; поведение переключается настройкой Project instructions (`claude-md-or-agents-md`, `claude-md-and-agents-md`, `claude-md`, `managed-only`). Source: https://code.claude.com/docs/en/memory (2026-11-11).
- FACT: skills используют progressive disclosure: всегда загружается только `description`, полный `SKILL.md` — при вызове, supporting files — по необходимости; рекомендуется держать `SKILL.md` до 500 строк. Source: https://code.claude.com/docs/en/skills (2026-11-11).

**Permissions and sandbox.**
- FACT: modes: `default` (alias `manual`), `acceptEdits`, `plan`, `bypassPermissions`, `auto`, `dontAsk`; default для новой сессии задаётся `permissions.defaultMode`; `auto` использует background classifier, `dontAsk` авто-отклоняет prompts. Source: https://code.claude.com/docs/en/permissions (2026-11-11).
- FACT: правила вычисляются в порядке `deny`, затем `ask`, затем `allow`; первое совпадение решает, специфичность порядок не меняет. Source: https://code.claude.com/docs/en/permissions (2026-11-11).
- FACT: sandbox использует Seatbelt на macOS, bubblewrap на Linux/WSL2, `socat` для proxy; на нативном Windows команды идут без sandbox. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).
- FACT: ключи `sandbox.enabled`, `sandbox.filesystem.allowWrite`, `denyWrite`, `denyRead`, `allowRead`, `disabled`; для сети — `sandbox.network.allowedDomains`, `deniedDomains`, `strictAllowlist`, `allowManagedDomainsOnly`, `tlsTerminate`, `httpProxyPort`, `socksProxyPort`, `allowLocalBinding`, `allowUnixSockets`. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).
- FACT: sandbox покрывает только shell-команды; Read/Edit/Write/WebFetch/WebSearch, hooks, MCP-серверы, LSP-серверы и helper-команды работают вне него. `denyRead` не ограничивает Read tool, `allowedDomains` не ограничивает WebFetch. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).
- FACT: по умолчанию чтение охватывает большую часть машины, включая `~/.ssh` и `~/.aws/credentials`; ограничивать нужно явно через `sandbox.credentials.files` и `sandbox.credentials.envVars` с `"mode": "deny"` или `"mask"`. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).

**Extensibility.**
- FACT: hooks настраиваются в `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy, plugin `hooks/hooks.json`, skill/subagent frontmatter. События включают `SessionStart`, `SessionEnd`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreCompact`, `PostCompact`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `Notification`, `MessageDisplay`. Source: https://code.claude.com/docs/en/hooks (2026-11-11).
- FACT: handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`; exit code `2` блокирует событие, остальные коды обычно non-blocking; `onFailure: "block"` нужен для fail-closed политики. Source: https://code.claude.com/docs/en/hooks (2026-11-11).
- FACT: subagents — Markdown-файлы в `.claude/agents/` и `~/.claude/agents/`; обязательны `name` и `description`; опциональны `tools`, `disallowedTools`, `model` (`sonnet`, `opus`, `haiku`, `fable`, полный ID, `inherit`), `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `isolation`. Source: https://code.claude.com/docs/en/sub-agents (2026-11-11).
- FACT: порядок выбора модели subagent: invocation `model` → frontmatter `model` → `CLAUDE_CODE_SUBAGENT_MODEL` → модель основной сессии. Source: https://code.claude.com/docs/en/sub-agents (2026-11-11).
- FACT: built-in agents: `Explore` (read-only), `Plan` (read-only), `general-purpose`, `claude`, `statusline-setup`, `claude-code-guide`. Source: https://code.claude.com/docs/en/sub-agents (2026-11-11).
- FACT: skills — `.claude/skills/<skill-name>/SKILL.md`, `~/.claude/skills/...`, plugin `skills/...`; frontmatter-поля все опциональны, рекомендуется `description`; `allowed-tools` даёт pre-approval на один turn. Source: https://code.claude.com/docs/en/skills (2026-11-11).
- FACT: plugins — директория с `.claude-plugin/plugin.json`, компоненты `skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`; marketplace описывается `.claude-plugin/marketplace.json`, установка `plugin@marketplace`. Source: https://code.claude.com/docs/en/plugins (2026-11-11).
- FACT: MCP scopes: local (`~/.claude.json`), project (`.mcp.json`), user (`~/.claude.json`); типы `http`, `sse`, `ws`, `stdio`; OAuth через `/mcp` или `claude mcp login`; имя tool-а `mcp__plugin_<plugin>_<server>__<tool>` для plugin-bundled серверов. Source: https://code.claude.com/docs/en/mcp (2026-11-11).

**Model routing and cost.**
- FACT: CLI `--model` принимает alias `sonnet`, `opus`, `haiku`, `fable` или полный ID; `fallbackModel`, `availableModels`, `modelPicker`, `modelSettings`, `effortLevel` — settings-ключи. Source: https://code.claude.com/docs/en/cli-reference (2026-11-11); https://code.claude.com/docs/en/settings (2026-11-11).
- FACT: `/usage` показывает token/cost-блок, разбивку по моделям и prompt-cache статистику; `--max-budget-usd` задаёт бюджет; prompt caching включён автоматически; `/effort` меняет reasoning effort. Source: https://code.claude.com/docs/en/costs (2026-11-11).
- FACT: `-p`/`--print` — неинтерактивный режим, `--output-format` принимает `text`, `json`, `stream-json`; `--permission-mode` стартует в одном из режимов; `--agents` задаёт subagents JSON; `--settings` переопределяет настройки на сессию; `--mcp-config` грузит MCP из JSON. Source: https://code.claude.com/docs/en/cli-reference (2026-11-11).

**Telemetry and evals.** FACT: телеметрия выключена, включается `CLAUDE_CODE_ENABLE_TELEMETRY=1`; экспортёры `otlp`, `prometheus`, `console`, `none`; метрики `claude_code.session.count`, `claude_code.lines_of_code.count`, `claude_code.pull_request.count`, `claude_code.commit.count`, `claude_code.cost.usage`, `claude_code.token.usage`, `claude_code.code_edit_tool.decision`, `claude_code.active_time.total`; события `claude_code.user_prompt`, `claude_code.assistant_response`, `claude_code.tool_result`, `claude_code.tool_decision`, `claude_code.api_request`, `claude_code.api_error`, `claude_code.api_refusal`. Source: https://code.claude.com/docs/en/monitoring-usage (2026-11-11). Публичного eval-набора нет — UNKNOWN.

**Release cadence and licensing.** FACT: `v2.1.322` (2026-11-10), `v2.1.321` (2026-11-09), `v2.1.319` (2026-11-06); в выборке из 100 последних релизов все 100 — stable, что указывает на почти ежедневный patch-ритм. Source: https://api.github.com/repos/anthropics/claude-code/releases (2026-11-11). FACT: лицензия проприетарная, "© Anthropic PBC. All rights reserved." Source: https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md (2026-11-11).

### 3.3 Google Gemini CLI

**Positioning and architecture.** FACT: "An open-source AI agent that brings the power of Gemini directly into your terminal"; Apache-2.0. Source: https://github.com/google-gemini/gemini-cli (2026-11-11). FACT: `packages/core` — backend, отвечает за связь с Gemini API, управление tools и обработку запросов из `packages/cli`; `packages/cli` — пользовательский интерфейс. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/index.md (2026-11-11). FACT: в `packages/` также есть `a2a-server`, `sdk`, `devtools`, `vscode-ide-companion`, `test-utils`. Source: https://api.github.com/repos/google-gemini/gemini-cli/contents/packages (2026-11-11).

**Agent loop.** FACT: core "interprets tool use requests from the Gemini model", "executes the requested tools with the provided arguments", "returns tool execution results to the Gemini model" и "keeps track of the conversation state". Это единственное публичное описание цикла. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/index.md (2026-11-11).

**Tools.**
- FACT: tool-имена: `run_shell_command` (manual confirmation), `glob`, `grep_search` (legacy alias `search_file_content`), `list_directory`, `read_file`, `read_many_files`, `replace` и `write_file` (оба требуют confirmation), `ask_user`, `write_todos`, `tracker_*`, `list_mcp_resources`, `read_mcp_resource`, `activate_skill`, `get_internal_docs`, `enter_plan_mode`, `exit_plan_mode`, `complete_task`, `google_web_search`, `web_fetch`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/tools.md (2026-11-11).
- FACT: общее правило — "You must manually approve tools that modify files or execute shell commands". Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/tools.md (2026-11-11).

**Context strategy.**
- FACT: `GEMINI.md` — основной context-файл, имя настраивается `context.fileName`; extensions могут поставлять свой `GEMINI.md` через `contextFileName`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md (2026-11-11); https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/reference.md (2026-11-11).
- FACT: auto memory по умолчанию выключена, включается `"experimental": { "autoMemory": true }`; кандидаты складываются в project-local inbox как `.patch`-диффы и `SKILL.md`, применяются только после approve через `/memory inbox`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/auto-memory.md (2026-11-11).
- FACT: token caching переиспользует system instructions и контекст, доступен при API-key auth и Vertex AI, недоступен OAuth-пользователям; `/stats` показывает cached token savings. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/token-caching.md (2026-11-11).
- FACT: `model.compressionThreshold`, `model.maxSessionTurns`, `model.summarizeToolOutput` — ключи управления контекстом и длиной сессии. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md (2026-11-11).

**Permissions and sandbox.**
- FACT: `general.defaultApprovalMode` принимает `default`, `auto_edit`, `plan`; YOLO включается `--yolo` или `--approval-mode=yolo`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md (2026-11-11).
- FACT: sandbox включается `-s`/`--sandbox`, переменной `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc` или `{"tools": {"sandbox": "docker"}}`; приоритет — flag, env, settings. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/sandbox.md (2026-11-11).
- FACT: Docker/Podman монтируют workspace по тому же абсолютному пути; default image `ghcr.io/google/gemini-cli:latest`; macOS Seatbelt profiles: `permissive-open`, `permissive-proxied`, `restrictive-open`, `restrictive-proxied`, `strict-open`, `strict-proxied`; `SANDBOX_MOUNTS` задаёт `from:to:opts`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/sandbox.md (2026-11-11).
- FACT: trusted folders включаются `security.folderTrust.enabled` в user settings; решения хранятся в `~/.gemini/trustedFolders.json`. В untrusted-папке игнорируются project `.gemini/settings.json`, project `.env`, блокируются extension install/update/uninstall, отключаются auto-accept, auto memory и MCP, не загружаются custom `.toml` commands. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/trusted-folders.md (2026-11-11).

**Extensibility.**
- FACT: extension — директория в `~/.gemini/extensions/<name>` с `gemini-extension.json`; ключи `name`, `version`, `description`, `mcpServers`, `contextFileName`, `excludeTools`, `settings`, `themes`; команды — TOML-файлы в `commands/`, hooks — `hooks/hooks.json`, skills — `skills/<skill>/SKILL.md`, agents — `agents/*.md`, policies — `policies/*.toml`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/reference.md (2026-11-11).
- FACT: установка extension — `gemini extensions install <github-url>`; список — `gemini extensions list` или `/extensions list`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md (2026-11-11).
- FACT: hooks задаются в `settings.json` под ключом `hooks`; события `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`; поддерживается только `"type": "command"`; exit `2` — system block. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md (2026-11-11).
- FACT: subagents — `*.md` в `.gemini/agents/` и `~/.gemini/agents/`, обязательны `name` и `description`, опциональны `kind`, `tools`, `mcpServers`, `model`, `temperature`, `max_turns`, `timeout_mins`; built-in `codebase_investigator`, `cli_help`, `generalist`, `browser_agent`. Subagent не может вызывать subagent. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md (2026-11-11).
- FACT: custom commands — TOML с обязательным `prompt`, optional `description`; `{{args}}` подставляет аргументы, `!{...}` выполняет shell, `@{...}` инжектит файл или листинг директории; подкаталоги дают namespace (`git/commit.toml` → `/git:commit`). Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md (2026-11-11).
- FACT: ACP-режим `gemini --acp` говорит по JSON-RPC 2.0 через stdio; методы `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `unstable_setSessionModel`; файловый доступ проксируется через ACP-клиент. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/acp-mode.md (2026-11-11).

**Model routing and cost.**
- FACT: routing выполняет `ModelAvailabilityService`, включён по умолчанию; выбор модели: `--model` → `GEMINI_MODEL` → `model.name`; если ничего не задано, default — `auto`; utility-вызовы имеют silent fallback chain `gemini-2.5-flash-lite` → `gemini-2.5-flash` → `gemini-2.5-pro`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/model-routing.md (2026-11-11).
- FACT: `modelConfigs.aliases`, `customAliases`, `overrides`, `modelDefinitions`, `modelChains`; alias может наследовать через `extends`; `generateContentConfig.temperature`, `topP`, `thinkingConfig.thinkingBudget`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md (2026-11-11); https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/generation-settings.md (2026-11-11).
- FACT: headless: `-p`/`--prompt`, `--output-format` с JSON или streaming JSON (JSONL events `init`, `message`, `tool_use`, `tool_result`, `error`, `result`). Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md (2026-11-11).

**UX surface.**
- FACT: Plan Mode переключается `gemini --approval-mode=plan`, `Shift+Tab` или `/plan [goal]`; в нём запрещены write-tools, кроме `.md` в `~/.gemini/tmp/<project>/<session-id>/plans/` или `general.plan.directory`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/plan-mode.md (2026-11-11).
- FACT: checkpointing создаёт shadow Git repo в `~/.gemini/history/<project_hash>` плюс JSON с историей разговора и tool call в `~/.gemini/tmp/<project_hash>/checkpoints`; `/restore` откатывает файлы, восстанавливает разговор и заново предлагает исходный tool call. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md (2026-11-11).
- FACT: checkpointing выключен по умолчанию, включается только в `settings.json`; CLI-флаг `--checkpointing` удалён в 0.11.0. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md (2026-11-11).

**Telemetry and evals.** FACT: `telemetry.enabled` (default false), `target` `local` или `gcp`, `otlpEndpoint` (default `http://localhost:4317`), `otlpProtocol` `grpc`/`http`, `logPrompts` (default true), `outfile`; события `gemini_cli.config`, `gemini_cli.user_prompt`, `gemini_cli.tool_call`, `gemini_cli.api_request`, `gemini_cli.api_response`, `gemini_cli.model_routing`, `gemini_cli.agent.start`, `gemini_cli.agent.finish`; метрики включают token usage, tool latency, lines changed, startup duration. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md (2026-11-11). FACT: в репозитории есть каталоги `evals`, `perf-tests`, `integration-tests`, `memory-tests` и документ `docs/behavioral-evals.md`. Source: https://api.github.com/repos/google-gemini/gemini-cli/contents/docs (2026-11-11).

**Release cadence and licensing.** FACT: nightly публикуется каждый день в 00:00 UTC, stable и preview — каждый вторник около 20:00 UTC; код идёт main → nightly → preview (не более недели) → stable (ещё неделя); версионирование semver, недельные релизы — minor, хотфиксы — patch. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/releases.md (2026-11-11). FACT: `v0.68.0` (2026-11-10), `v0.67.0` (2026-11-04), Apache-2.0. Source: https://api.github.com/repos/google-gemini/gemini-cli/releases (2026-11-11); https://api.github.com/repos/google-gemini/gemini-cli (2026-11-11).

### 3.4 OpenCode

**Positioning and architecture.** FACT: "OpenCode is an open source coding agent", доступен как terminal UI, desktop app и web app; лицензия MIT, репозиторий `anomalyco/opencode` (старый `sst/opencode` редиректит туда). Source: https://opencode.ai/docs/ (2026-11-11); https://api.github.com/repos/anomalyco/opencode (2026-11-11).
- FACT: пакеты включают `cli`, `server`, `tui`, `desktop`, `sdk`, `plugin`, `protocol`, `core`, `app`, `ai`, `codemode`, `session-ui`, `ui`, `schema`, `process-daemon`. Source: https://api.github.com/repos/anomalyco/opencode/contents/packages (2026-11-11).
- FACT: `opencode` запускает TUI и server; TUI — клиент, который общается с сервером; `opencode serve` поднимает headless HTTP server с OpenAPI 3.1 по `/doc` (default `http://localhost:4096/doc`), по этому же spec генерируется SDK. Source: https://opencode.ai/docs/server/ (2026-11-11).
- FACT: server API включает `GET /event` (SSE, первое событие `server.connected`), `GET /global/event`, `GET /session`, `POST /session`, `GET /session/:id`, `POST /session/:id/message`, `POST /session/:id/prompt_async`, `POST /session/:id/command`, `POST /session/:id/shell`, `POST /session/:id/fork`, `POST /session/:id/abort`, `GET /session/:id/diff`, `POST /session/:id/summarize`, `POST /session/:id/revert`, `POST /session/:id/unrevert`. Source: https://opencode.ai/docs/server/ (2026-11-11).

**Agent loop.** FACT: сессия хранит выбранную модель отдельно от агента; `steps` задаёт максимальное число model-step, на последнем шаге tools удаляются и модель просят суммировать; subagents запускаются в child-сессиях с fresh context. Source: https://opencode.ai/docs/agents/ (2026-11-11). Внутренний цикл как отдельная диаграмма не опубликован — UNKNOWN.

**Tools.**
- FACT: built-in tools: `read`, `glob`, `grep`, `edit`, `write`, `patch` (только для поддерживаемых GPT-моделей), `shell`, `webfetch`, `websearch`, `experimental_image_generate`, `question`, `skill`, `subagent`, `execute`, `session_rename`, `session_move`, `worktree_create`, `worktree_list`, `worktree_remove`, `browser`. Source: https://opencode.ai/docs/tools/ (2026-11-11).
- FACT: LSP интегрирован как источник diagnostics: при открытии файла расширение сверяется с включёнными LSP-серверами, сервер стартует при совпадении; diagnostics используются как feedback для агента. Source: https://opencode.ai/docs/lsp/ (2026-11-11).
- FACT: LSP выключен по умолчанию; `"lsp": true` включает все built-in, `"lsp": {}` оставляет built-in с возможностью override, `"lsp": false` выключает; auto-download отключается `OPENCODE_DISABLE_LSP_DOWNLOAD=true`. Source: https://opencode.ai/docs/lsp/ (2026-11-11).

**Context strategy.**
- FACT: `AGENTS.md` в корне проекта и `~/.config/opencode/AGENTS.md` глобально; `CLAUDE.md` используется только если нет `AGENTS.md`; ключ `instructions` принимает файлы, globs и remote URL (timeout 5 секунд), всё объединяется с `AGENTS.md`. Source: https://opencode.ai/docs/rules/ (2026-11-11).
- FACT: skills — `.opencode/skills/<skill-id>/SKILL.md`, совместимость с `.claude/skills` и `.agents/skills`; модель видит только ID, name и description, тело грузится через `skill` tool; supporting files не загружаются автоматически. Source: https://opencode.ai/docs/skills/ (2026-11-11).
- FACT: `instructions` и `AGENTS.md` — разные источники, которые складываются; `@path`-ссылки в `AGENTS.md` автоматически не парсятся. Source: https://opencode.ai/docs/rules/ (2026-11-11).

**Permissions and sandbox.**
- FACT: permissions — массив правил `{ action, resource, effect }`, effect `allow`/`deny`/`ask`; "The last matching rule wins"; agent-specific правила добавляются после глобальных; при отсутствии совпадения — `ask`. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- FACT: базовая политика: `*/* allow`, `read *.env ask`, `read *.env.* ask`, `read *.env.example allow`. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- FACT: shell проверяется встроенным сканером для Bash, Zsh, POSIX sh и PowerShell; проверяются каждая извлечённая подкоманда и каждый `cd`; при небезопасном динамическом eval сканер возвращает ошибку, а не запускает непроверенное. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- FACT: approval `ask` даёт варианты `once`, `always`, `reject`; `always` сохраняет project-scoped allow-правило, которое не переопределяет configured deny; `policies` могут hard-deny после permissions и saved approvals. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- FACT: shell "runs with the host user's filesystem, process, and network authority"; отдельного OS-sandbox в просмотренных docs нет — UNKNOWN. Source: https://opencode.ai/docs/permissions/ (2026-11-11).

**Extensibility.**
- FACT: plugins задаются ключом `plugins`, автозагружаются из `.opencode/plugins/` и `~/.config/opencode/plugins/`; запись `Plugin.define({ id, async setup(ctx) {...} })`; server-часть добавляет "tools, hooks, integrations, commands, and agents". Source: https://opencode.ai/docs/plugins/ (2026-11-11); https://opencode.ai/docs/build/plugins/ (2026-11-11).
- FACT: MCP — `mcp.servers.<name>`, local (`type: "local"`, `command`) или remote (`type: "remote"`, `url`); remote по умолчанию использует OAuth, отключается `"oauth": false`; tool-имена `<server>_<tool>`; нет `enabled`, выключение — `"disabled": true`. Source: https://opencode.ai/docs/mcp-servers/ (2026-11-11).
- FACT: custom commands — Markdown в `~/.config/opencode/commands/` и `.opencode/commands/`, `$ARGUMENTS`, `$1`, `!`backtick-shell, frontmatter `agent`, `model`, `subagent`; JSON-формат — ключ `commands` с обязательным `template`. Source: https://opencode.ai/docs/commands/ (2026-11-11).
- FACT: agents — Markdown в `~/.config/opencode/agents/<name>.md` и `.opencode/agents/<name>.md`, режимы `primary`, `subagent`, `all`; built-in `Build`, `Plan`, `General`, `Explore` плюс скрытые `compaction`, `title`, `summary`. Source: https://opencode.ai/docs/agents/ (2026-11-11).
- FACT: model syntax `provider/model` с optional `#variant`, например `anthropic/claude-sonnet-5-5#high`; subagent без своей модели наследует модель родительской сессии. Source: https://opencode.ai/docs/agents/ (2026-11-11).

**Model routing and cost.**
- FACT: `providers` — карта provider ID; поля `name`, `env`, `package`, `canonical`, `compatibility`, `settings`, `headers`, `body`, `models`; endpoint override — `settings.baseURL`; credentials — `env` список переменных. Source: https://opencode.ai/docs/providers/ (2026-11-11).
- FACT: provider packages включают `@opencode/ai/providers/openai`, `openai/chat`, `openai/responses`, `openai-compatible`, `anthropic`, `anthropic-compatible`, `google`, `google-vertex`, `azure`, `amazon-bedrock`, `openrouter`, `xai`; модели имеют `cost`, `limit`, `variants`. Source: https://opencode.ai/docs/providers/ (2026-11-11).
- FACT: `opencode stats` показывает shareable usage statistics; `opencode run --auto` разрешает все действия, кроме запрещённых. Source: https://opencode.ai/terminal.md (2026-11-11).

**UX surface.**
- FACT: TUI: `opencode mini` печатает ответы в scrollback; `shift+tab` переключает агентов, `ctrl+p` открывает команды; `-c` продолжает последнюю сессию, `-s` — выбранную; темы переключаются в одно нажатие, TUI следует light/dark режиму терминала. Source: https://opencode.ai/terminal.md (2026-11-11).
- FACT: `opencode pair` открывает web-интерфейс, ссылка одноразовая и истекает через 5 минут. Source: https://opencode.ai/docs/ (2026-11-11).

**Telemetry and evals.** В просмотренных docs телеметрия не описана; `opencode stats` — локальная статистика, не exporter. Статус: UNKNOWN. Source: https://opencode.ai/terminal.md (2026-11-11); https://opencode.ai/docs/ (2026-11-11).

**Release cadence and licensing.** FACT: `v2.2.7` (2026-11-10), `v2.2.6` (2026-11-06), `v2.2.5` (2026-10-30); MIT. Source: https://api.github.com/repos/anomalyco/opencode/releases (2026-11-11); https://api.github.com/repos/anomalyco/opencode (2026-11-11).

### 3.5 Aider

**Positioning and architecture.** FACT: "Aider is AI pair programming in your terminal"; Python, Apache-2.0; установка через `aider-chat` (pip/pipx/uv) или `aider-install`. Source: https://aider.chat/docs/ (2026-11-11); https://aider.chat/docs/install.html (2026-11-11); https://api.github.com/repos/Aider-AI/aider (2026-11-11).

**Agent loop.** FACT: Aider не описывает tool-loop в стиле agent harness. Ключевая механика — на каждый change request отправляется repo map вместе с сообщением; в architect-режиме выполняются два LLM-запроса: architect предлагает изменения, editor переводит их в правки. Source: https://aider.chat/docs/repomap.html (2026-11-11); https://aider.chat/docs/usage/modes.html (2026-11-11).

**Tools and edit mechanics.**
- FACT: edit formats: `whole` (полная обновлённая копия файла), `diff` (search/replace блоки в стиле merge conflict), `diff-fenced` (путь внутри fence), `udiff` (упрощённый unified diff), `editor-diff` и `editor-whole` для architect mode; формат форсируется `--edit-format`. Source: https://aider.chat/docs/more/edit-formats.html (2026-11-11).
- FACT: Aider выбирает формат под модель: `diff-fenced` в основном для Gemini, `udiff` для GPT-4 Turbo; для GPT-3.5 используется whole, для GPT-4 — diff. Source: https://aider.chat/docs/more/edit-formats.html (2026-11-11).
- FACT: lint/test: `--lint`, `--lint-cmd <cmd>`, `--no-auto-lint`, `--test-cmd <cmd>`, `--auto-test`; linter получает имена файлов и должен возвращать ненулевой код при ошибке. Source: https://aider.chat/docs/usage/lint-test.html (2026-11-11).

**Context strategy.**
- FACT: repo map включает важные классы и функции с сигнатурами; ранжирование — graph ranking на графе, где файл — узел, а рёбра — зависимости; отправляется с каждым change request. Source: https://aider.chat/docs/repomap.html (2026-11-11).
- FACT: `--map-tokens` по умолчанию 1k, размер карты динамически адаптируется; при отсутствии файлов в чате карта расширяется, `map_mul_no_files=8`, target ограничен context window минус 4096 padding-токенов. Source: https://aider.chat/docs/repomap.html (2026-11-11); https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py (2026-11-11).
- FACT: реализация использует tree-sitter tags (`name.definition.*` → `def`, `name.reference.*` → `ref`), `networkx.MultiDiGraph`, PageRank с весами, disk cache `.aider.tags.cache.v3` и `CACHE_VERSION = 3`. Source: https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py (2026-11-11).
- FACT: пользователь вручную добавляет файлы в чат; рекомендация — "Just add the files you think need to be edited", слишком большой набор файлов вредит. `/add`, `/drop`, `/read` управляют рабочим набором. Source: https://aider.chat/docs/usage/tips.html (2026-11-11).

**Permissions and sandbox.** В просмотренных официальных docs нет раздела permissions/sandbox; Aider выполняет lint/test команды и правит файлы с правами пользователя. Отсутствие раздела не доказывает отсутствие механизма, но публично документированного sandbox не обнаружено — UNKNOWN. Source: https://aider.chat/docs/ (2026-11-11); https://aider.chat/docs/usage/lint-test.html (2026-11-11).

**Extensibility.**
- FACT: конфигурация `.aider.conf.yml` ищется в home, git root и cwd (позже переопределяет раньше); `--config <filename>` грузит только указанный файл; `.env` и `--env-file` (default `.env`); `api-key` задаёт `PROVIDER_API_KEY`. Source: https://aider.chat/docs/config/aider_conf.html (2026-11-11).
- FACT: model settings переопределяются `.aider.model.settings.yml`, `--model-settings-file`, `--model-metadata-file`; полностью квалифицированное имя модели с provider-префиксом соответствует `litellm_provider`. Source: https://aider.chat/docs/config/adv-model-settings.html (2026-11-11).
- FACT: watch-режим `--watch-files` ищет комментарии `# ...`, `// ...`, `-- ...`, начинающиеся или заканчивающиеся на `AI`, `AI!`, `AI?`; `AI!` меняет код, `AI?` отвечает на вопрос. Source: https://aider.chat/docs/usage/watch.html (2026-11-11).
- FACT: MCP в просмотренных docs Aider не документирован — UNKNOWN, не утверждение об отсутствии. Source: https://aider.chat/docs/ (2026-11-11).

**Subagents.** Публично не документированы. Architect/editor — это разделение ролей между двумя моделями, а не subagent-механизм. Source: https://aider.chat/docs/usage/modes.html (2026-11-11).

**Model routing and cost.**
- FACT: режимы `code`, `ask`, `architect`, `help`; переключение `/chat-mode`, one-message `/code`, `/architect`, `/ask`, `/help`; `--architect` — shortcut. Source: https://aider.chat/docs/usage/modes.html (2026-11-11).
- FACT: architect использует main model и editor model, editor выбирается built-in defaults или `--editor-model`; architect делает два запроса и может стоить дороже. Source: https://aider.chat/docs/usage/modes.html (2026-11-11).
- FACT: `--weak-model` используется для commit messages и summarization; `--cache-prompts` включает prompt caching, default false. Source: https://aider.chat/docs/git.html (2026-11-11); https://aider.chat/docs/config/options.html (2026-11-11).
- FACT: бенчмарк polyglot — 225 Exercism-задач на C++, Go, Java, JavaScript, Python, Rust; лидер `gpt-5 (high)` — 88.0% при $29.08, `gpt-5 (medium)` — 86.7% при $17.69, `o3-pro (high)` — 84.9% при $146.32. Source: https://aider.chat/docs/leaderboards/ (2026-11-11).
- FACT: более ранний benchmark на 133 Exercism Python задачах показал, что plain text edit formats работают лучше function calls; GPT-4 сравним на whole и diff, но whole дороже и медленнее. Source: https://aider.chat/docs/benchmarks.html (2026-11-11).

**Git integration and UX.**
- FACT: Aider коммитит каждое изменение с описательным сообщением; `--no-auto-commits` отключает это; перед работой коммитит preexisting изменения; `/undo` отменяет и отбрасывает последнее изменение; commit message генерирует weak model, по умолчанию Conventional Commits. Source: https://aider.chat/docs/git.html (2026-11-11).
- FACT: `--read` добавляет read-only файл, `--yes-always` авто-подтверждает, `--watch-files` включает watch, `--auto-commits` default true, `--lint` и `--test` default false. Source: https://aider.chat/docs/config/options.html (2026-11-11).

**Telemetry and evals.** FACT: analytics собирает анонимные данные через PostHog: какие LLM и сколько токенов, какие edit formats, частота features/commands, exceptions; "never collects your code, prompts, chats, keys or any personal info"; opt-out `--analytics-disable` (постоянно) или `--no-analytics` (сессия). Source: https://aider.chat/docs/more/analytics.html (2026-11-11). FACT: публичные leaderboards и benchmark notes — фактический eval-механизм. Source: https://aider.chat/docs/leaderboards/ (2026-11-11).

**Release cadence and licensing.** FACT: последний stable `v0.86.0` от 2025-08-09; до него `v0.85.0` (2025-06-27), `v0.84.0` (2025-05-30); последний commit на `main` — 22 мая 2026. Apache-2.0. Source: https://api.github.com/repos/Aider-AI/aider/releases (2026-11-11); https://github.com/Aider-AI/aider/commits/main (2026-11-11); https://api.github.com/repos/Aider-AI/aider (2026-11-11).

### 3.6 Qwen Code

**Positioning and architecture.** FACT: "An open-source AI coding agent that lives in your terminal"; Apache-2.0; изначально основан на Google Gemini CLI v0.8.2, но с Qwen Code v0.1 прекратил синхронизацию с upstream и развивается как multi-protocol, multi-platform framework. Source: https://github.com/QwenLM/qwen-code (2026-11-11); https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11).
- FACT: пакеты включают `cli`, `core`, `acp-bridge`, `sdk-typescript`, `sdk-python`, `sdk-java`, `web-shell`, `desktop`, `channels`, `browser-use`, `cua-driver`, `live-host`, `managed-agent-server`, `node-repl`, `vscode-ide-companion`, `zed-extension`. Source: https://api.github.com/repos/QwenLM/qwen-code/contents/packages (2026-11-11).
- FACT: `qwen serve` поднимает daemon с built-in Web Shell и HTTP + SSE API на `http://127.0.0.1:4170`; daemon поддерживает несколько workspace и reconnect клиентов к активным сессиям. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11).

**Agent loop.** Публичная architecture-страница `docs/developers/architecture.md` не отдалась через WebFetch, поэтому внутренний цикл — UNKNOWN. Косвенно: approval-mode таблица различает plan/default/auto-edit/auto/yolo для edit и shell, hooks покрывают `PreToolUse`/`PostToolUse`, subagents выполняют отдельные context loops. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11); https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md (2026-11-11).

**Tools.** FACT: approval-mode таблица называет `edit`, `write_file`, `notebook_edit`, shell-команды; hooks-матчеры используют `run_shell_command`, `write_file`, `read_file`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md (2026-11-11); https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/hooks.md (2026-11-11). Полный каталог tools в одном документе не проверен — UNKNOWN.

**Context strategy.**
- FACT: контекст включает `QWEN.md` (context file), skill listing, tool schemas и system prompt; `/context` даёт разбивку по категориям, `/context detail` — по item-ам; `startupContext` — environment block первого user turn. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/context-cost.md (2026-11-11).
- FACT: `tools.eager` — allowlist built-in tools, остающиеся в initial request, остальные deferred; `tools.visible` объявляет один deferred tool заранее; `tools.disabled` или `permissions.deny` удаляют tool; `tools.toolSearch.enabled` и `tools.toolSearch.threshold` управляют tool search. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/context-cost.md (2026-11-11).
- FACT: skills — `~/.qwen/skills/`, `.qwen/skills/`, `~/.agents/skills/`, `.agents/skills/`; `SKILL.md` требует непустые `name` и `description`; optional `paths`, `user-invocable: false`, `disable-model-invocation: true`, `hooks`, `allowedTools`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/skills.md (2026-11-11).

**Permissions and sandbox.**
- FACT: approval modes: `plan`, `default` (Ask Permissions), `auto-edit`, `auto`, `yolo`; цикл `Shift+Tab` (Tab на Windows); persistent через `/approval-mode yolo --project` или `--user`; ключ `tools.approvalMode`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md (2026-11-11).
- FACT: Auto Mode использует classifier для shell и network, но most read-only операции и in-workspace edits пропускают classifier; `permissions.deny` остаётся enforced, широкие `permissions.allow` временно отключаются. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md (2026-11-11).
- FACT: execution sandbox на Linux: `tools.executionSandbox` требует `filesystem` (`read-only` или `workspace-write`) и `network` (`open` или `closed`), optional `backend` (`auto`, `bwrap`, `landlock`); `auto` сначала пробует bwrap, Landlock fallback требует `network: open` и Landlock ABI 3+; Landlock не умеет `network: closed`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sandbox.md (2026-11-11).
- FACT: whole-CLI sandbox: `-s`/`--sandbox[=provider]` (`true`, `false`, `docker`, `podman`, `sandbox-exec`), `--sandbox-image`, `tools.sandbox`, `tools.sandboxImage`, `QWEN_SANDBOX`, `QWEN_SANDBOX_IMAGE`; Docker/Podman монтируют workspace и `~/.qwen`; macOS Seatbelt profiles `permissive-open`, `permissive-closed`, `permissive-proxied`, `restrictive-open`, `restrictive-closed`, `restrictive-proxied`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sandbox.md (2026-11-11).

**Extensibility.**
- FACT: hooks — ключ `hooks` в `.qwen/settings.json`; события `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `SessionDelete`, `MessageDisplay`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Notification`, `PermissionRequest`, `PermissionDenied`, `TodoCreated`, `TodoCompleted`, `InstructionsLoaded`, `FileChanged`; types `command`, `http`, `function`, `prompt`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/hooks.md (2026-11-11).
- FACT: subagents — `.qwen/agents/` и `~/.qwen/agents/`; поля `name`, `description`, `model`, `approvalMode`, `tools`, `disallowedTools`; Claude Code-совместимые `permissionMode`, `maxTurns`, `color`, `mcpServers`, `hooks`; forks через `.qwen/fork-profiles/<name>.md`; regular subagents по умолчанию background. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md (2026-11-11).
- FACT: MCP — `mcpServers` в `settings.json`; transport `command` (stdio), `url` (SSE, legacy), `httpUrl` (HTTP); OAuth-ключи `enabled`, `clientId`, `clientSecret`, `authorizationUrl`, `tokenUrl`, `scopes`, `redirectUri`; tokens в `~/.qwen/mcp-oauth-tokens.json`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/mcp.md (2026-11-11).
- FACT: model providers — `modelProviders` с built-in `openai`, `anthropic`, `gemini`, `vertex-ai`; запись модели содержит `id`, `name`, `envKey`, `baseUrl`, `wireApi` (`chat-completions` или `responses`); custom provider требует `providerProtocol`; `/model` переключает runtime, `/auth` выбирает auth. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/model-providers.md (2026-11-11).

**Model routing and cost.**
- FACT: `model.name`, `model.reasoningEffort` (`low`, `medium`, `high`, `xhigh`, `max`), `model.generationConfig.enableCacheControl`, `model.catalogRefresh`; `ui.allowedApprovalModes` — presentation-only, не backend enforcement. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/settings.md (2026-11-11).
- FACT: subagent model: `inherit`, `fast` (fallback на inherit), конкретный ID, provider-qualified `openai:gpt-4o`, `authType:modelId`; `agents.modelGrades`, `agents.allowedGrades`, `agents.builtin.exploreModel`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md (2026-11-11).
- FACT: daemon default `http://127.0.0.1:4170`; по умолчанию слушает loopback без bearer authentication, любой локальный процесс может использовать полный API, включая code execution; для shared hosts — `QWEN_SERVER_TOKEN` и `--require-auth`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11).

**UX surface.** FACT: поверхности — terminal `qwen`, headless `qwen -p`, desktop, browser Web Shell, IDE plugins (VS Code, JetBrains, Zed), SDK (TypeScript, Python, Java), chat/IM channels; заявлены Agent Teams, Agent Arena, computer use, browser use, Git worktrees, plan mode, LSP. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11).

**Telemetry and evals.** FACT: `privacy.usageStatisticsEnabled` default true; отключает collection of usage statistics и models.dev catalog refresh; не ограничен workspace. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/settings.md (2026-11-11). CLAIM: README заявляет 76.40–77.80% на SWE-bench Verified с Qwen 3.7 Max на 500 задачах и трёх trials; независимой проверки не было. Source: https://github.com/QwenLM/qwen-code (2026-11-11).

**Release cadence and licensing.** FACT: `v0.27.2` (2026-11-10), `v1.0.0-preview` (2026-11-11, prerelease), several SDK releases в тот же период; Apache-2.0. Source: https://api.github.com/repos/QwenLM/qwen-code/releases (2026-11-11); https://api.github.com/repos/QwenLM/qwen-code (2026-11-11).

### 3.7 Cross-product mechanics matrix

| Mechanic | Codex CLI | Claude Code | Gemini CLI | OpenCode | Aider | Qwen Code |
|---|---|---|---|---|---|---|
| Runtime / license | Rust, Apache-2.0 | TypeScript, proprietary | TypeScript, Apache-2.0 | TypeScript, MIT | Python, Apache-2.0 | TypeScript, Apache-2.0 |
| Config format | TOML `~/.codex/config.toml` | JSON settings hierarchy | JSON `settings.json` | JSON/JSONC `opencode.json(c)` | YAML `.aider.conf.yml` | JSON `~/.qwen/settings.json` |
| Project instructions | `AGENTS.md` + `AGENTS.override.md`, 32 KiB cap | `CLAUDE.md` hierarchy + imports + auto memory | `GEMINI.md` (`context.fileName`) + auto memory inbox | `AGENTS.md` + `instructions` key | Manual file selection + repo map | `QWEN.md` + skills |
| Context retrieval | AGENTS.md, skills, auto-compaction | CLAUDE.md, skills, auto memory | GEMINI.md, extensions, auto memory, token cache | AGENTS.md, instructions, skills, LSP diagnostics | tree-sitter tags + PageRank repo map | QWEN.md, `/context`, deferred tools |
| Permission model | `approval_policy` + `sandbox_mode` + beta profiles | modes + deny/ask/allow rules | approval modes + trusted folders | ordered `permissions` rules, last match wins | not documented | plan/default/auto-edit/auto/yolo + classifier |
| OS sandbox | Seatbelt, bwrap+seccomp, MXC | Seatbelt, bubblewrap, no native Windows | Docker, Podman, Seatbelt, runsc, lxc | not documented | not documented | bwrap, Landlock, Docker, Podman, Seatbelt |
| Extensibility | MCP, skills, hooks, plugins, subagents | MCP, skills, plugins, hooks, subagents, SDK | extensions, MCP, hooks, skills, subagents, commands, ACP | MCP, plugins, skills, commands, agents, LSP | YAML config, model settings, watch, lint/test | MCP, hooks, skills, subagents, daemon SDKs |
| Subagents | TOML files, 3 built-ins, thread cap | Markdown files, 6 built-ins, model resolution | Markdown files, 4 built-ins, no nesting | Markdown agents, primary/subagent/all | no subagent mechanism | Markdown files, forks, background default |
| Model routing | `model_provider`, profiles, reasoning effort | aliases, `fallbackModel`, subagent model order | `ModelAvailabilityService`, aliases, chains | `provider/model#variant`, per-agent model | main/weak/editor split | `modelProviders`, grades, `fast` |
| Headless / protocol | `codex exec --json`, app-server JSON-RPC | `-p`, `--output-format`, Agent SDK | `-p`, JSON/JSONL, ACP | HTTP server + OpenAPI + SDK | CLI/Python scripting | `qwen -p`, daemon HTTP+SSE, SDKs |
| Telemetry | Statsig + OTLP | OTel metrics/events/traces | OTel local/GCP, rich events | not documented | PostHog analytics | `privacy.usageStatisticsEnabled` |
| Release cadence | weekly stable + alphas | near-daily patches | nightly + weekly stable/preview | several per week | last stable 2025-08-09 | near-daily + preview 1.0 |
| Sharing/collaboration | cloud tasks, review | remote control, web, mobile, Slack | ACP, IDE, headless | `opencode pair`, desktop, mobile | none documented | daemon, Web Shell, IM channels |

## 4. Gaps, risks, weaknesses

Все пункты ниже — наблюдения о конкурентах, а не рекомендации для ZCode. Для каждого продукта отдельно указано, какие механики стоит изучить и какие копировать не стоит.

### 4.1 Codex CLI

**Weaknesses and risks.**
- FACT: одновременно существуют две модели ограничений — старые `sandbox_mode`/`approval_policy` и beta permission profiles; они взаимоисключающи, что создаёт миграционную развилку и риск неверной конфигурации. Source: https://learn.chatgpt.com/docs/permissions.md (2026-11-11); https://learn.chatgpt.com/docs/config-file/config-reference.md (2026-11-11).
- FACT: `danger-full-access` и `--dangerously-bypass-approvals-and-sandbox` полностью снимают и sandbox, и approvals; документация сама помечает это как elevated risk. Source: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11).
- FACT: по умолчанию сеть выключена, поэтому установка зависимостей и сетевые команды требуют явного `network_access = true` или approval; это безопасно, но повышает трение первого запуска. Source: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11).
- FACT: sandbox реализован по-разному на macOS, Linux, Windows и WSL2; поведение не унифицировано, а WSL1 больше не поддерживается. Source: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11).
- FACT: hooks требуют trust по хэшу; новые или изменённые hooks молча пропускаются до review, что может выглядеть как «hook не работает». Source: https://learn.chatgpt.com/docs/hooks.md (2026-11-11).
- FACT: `--full-auto` удалён из non-interactive режима, то есть CLI-контракт ломается между версиями. Source: https://learn.chatgpt.com/docs/non-interactive-mode.md (2026-11-11).
- FACT: документация фрагментирована и переехала: `developers.openai.com/codex/*` отдаёт 308 на `learn.chatgpt.com/docs/*`, старые пути `docs/config.md` и `docs/sandbox.md` в GitHub-репозитории содержат только ссылки-заглушки. Source: https://developers.openai.com/codex/config-reference (2026-11-11); https://raw.githubusercontent.com/openai/codex/main/docs/config.md (2026-11-11).

**Mechanics worth learning.**
- OS-level sandbox по умолчанию плюс отдельная ось approvals: «что технически можно» и «когда нужно спросить» разделены. Source: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11).
- app-server как стабильный JSON-RPC-контракт с thread/turn/approval-событиями — хороший пример отделения UI от runtime. Source: https://learn.chatgpt.com/docs/app-server.md (2026-11-11).
- `codex exec --json` с JSONL-событиями и `--output-schema` — практичный CI-контракт. Source: https://learn.chatgpt.com/docs/non-interactive-mode.md (2026-11-11).
- Иерархия `AGENTS.override.md` → `AGENTS.md` → fallback-имена с явным byte-cap. Source: https://learn.chatgpt.com/docs/agent-configuration/agents-md.md (2026-11-11).
- Skills с бюджетом на начальный листинг (2% контекста или 8000 символов). Source: https://learn.chatgpt.com/docs/build-skills.md (2026-11-11).

**Mechanics NOT to copy.**
- Две параллельные permission-модели (`sandbox_mode` и `[permissions.<name>]`). Причина: удваивает число состояний, усложняет миграцию и диагностику; лучше одна модель с явным deprecated-путём.
- `danger-full-access` как обычный режим в публичном CLI. Причина: слишком легко получить неограниченный доступ; безопаснее отдельный одноразовый контейнер/runner.
- Разрозненная документация с редиректами и страницами-заглушками. Причина: ломает ссылки, усложняет автоматическую проверку актуальности.
- Trust-by-hash с молчаливым skip. Причина: пользователь не понимает, почему hook не сработал; нужен явный статус «skipped, требуется trust».

### 4.2 Claude Code

**Weaknesses and risks.**
- FACT: продукт проприетарный, исходники ядра не опубликованы; это lock-in и невозможность независимого аудита цикла, tool-ов и sandbox. Source: https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md (2026-11-11).
- FACT: sandbox покрывает только shell-команды; Read/Edit/Write/WebFetch/WebSearch, hooks, MCP, LSP и helper-команды работают вне sandbox; `denyRead` не ограничивает Read tool, а `allowedDomains` не ограничивает WebFetch. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).
- FACT: по умолчанию чтение охватывает большую часть машины, включая `~/.ssh` и `~/.aws/credentials`; защита credentials требует отдельной настройки. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).
- FACT: на нативном Windows команды идут без sandbox; безопасность зависит от WSL2. Source: https://code.claude.com/docs/en/sandboxing (2026-11-11).
- FACT: hooks — очень большая поверхность: более 30 событий и пять типов handler-ов (`command`, `http`, `mcp_tool`, `prompt`, `agent`), при этом exit code `1` обычно non-blocking; fail-closed требует явного `onFailure: "block"`. Source: https://code.claude.com/docs/en/hooks (2026-11-11).
- FACT: порядок permission-правил `deny → ask → allow`, первое совпадение решает, специфичность не учитывается; широкий deny нельзя переопределить узким allow. Source: https://code.claude.com/docs/en/permissions (2026-11-11).
- FACT: пять механизмов расширения (skills, plugins, hooks, subagents, MCP) пересекаются по возможностям; plugin может содержать skills, agents, hooks и MCP одновременно. Source: https://code.claude.com/docs/en/plugins (2026-11-11).
- FACT: стоимость и лимиты зависят от подписки и rolling-окон; `/usage` и `/usage-credits` нужны для понимания расхода. Source: https://code.claude.com/docs/en/costs (2026-11-11).

**Mechanics worth learning.**
- Progressive disclosure для skills: всегда в контексте только `description`, тело — по вызову. Source: https://code.claude.com/docs/en/skills (2026-11-11).
- Frontmatter subagent-а с `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `isolation` и явным порядком resolution модели. Source: https://code.claude.com/docs/en/sub-agents (2026-11-11).
- Иерархия памяти с imports, ограничением глубины и auto memory с лимитом чтения. Source: https://code.claude.com/docs/en/memory (2026-11-11).
- Единый engine для terminal/IDE/desktop/web — хороший принцип паритета поверхностей. Source: https://code.claude.com/docs/en/overview (2026-11-11).
- OTel-схема с отдельными метриками `cost.usage`, `token.usage`, `code_edit_tool.decision`. Source: https://code.claude.com/docs/en/monitoring-usage (2026-11-11).

**Mechanics NOT to copy.**
- Проприетарное ядро при открытых plugins/issues. Причина: пользователь не может проверить поведение и ограничен экосистемой вендора.
- Sandbox только для shell при заявлении «sandbox» как свойства продукта. Причина: создаёт ложное чувство безопасности; Read/WebFetch/MCP остаются вне границы.
- Сверхбольшой hook-taxonomy без стабильного версионированного контракта. Причина: высокая стоимость поддержки и риск, что события меняются между релизами.
- Permission-порядок «первое совпадение» без специфичности. Причина: трудно предсказать результат; политики хуже поддаются статической проверке.
- Пять пересекающихся механизмов расширения. Причина: пользователю сложно выбрать правильный слой; дублирование кода и документации.

### 4.3 Gemini CLI

**Weaknesses and risks.**
- FACT: checkpointing выключен по умолчанию и включается только через `settings.json`; CLI-флаг `--checkpointing` удалён в 0.11.0. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md (2026-11-11).
- FACT: hooks поддерживают только `"type": "command"`, а не-JSON stdout трактуется как «Allow» и превращается в `systemMessage`. Это fail-open поведение. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md (2026-11-11).
- FACT: untrusted workspace переводит CLI в safe mode, где игнорируются project settings и `.env`, блокируются extensions, отключаются MCP, auto memory и auto-accept, не загружаются custom commands. Это безопасно, но неожиданно для пользователя. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/trusted-folders.md (2026-11-11).
- FACT: subagents не могут вызывать subagents, что ограничивает глубину оркестрации. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md (2026-11-11).
- FACT: extension объединяет commands, MCP, hooks, skills, agents, policies и themes; precedence между источниками (built-in, extension, user, workspace) сложна и требует отдельной таблицы. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/reference.md (2026-11-11); https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/skills.md (2026-11-11).
- FACT: конфигурация имеет много top-level ключей (`general`, `output`, `ui`, `ide`, `privacy`, `billing`, `model`, `modelConfigs`, `agents`, `context`, `tools`, `mcp`, `security`, `experimental`, `skills`, `hooks`, `hooksConfig`, `contextManagement`, `admin`, `mcpServers`, `telemetry`), что повышает когнитивную нагрузку. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md (2026-11-11).
- CLAIM: README репозитория заявляет «Enterprise Code Assist only», «No free tier or Google AI plans» и «Not optimized for Gemini 4+». Это нестандартное позиционирование для публичного OSS-продукта; утверждение требует отдельной проверки, поскольку может отражать состояние конкретной ветки/страницы. Source: https://github.com/google-gemini/gemini-cli (2026-11-11).

**Mechanics worth learning.**
- Extension как единый installable bundle с `gemini-extension.json`, commands, hooks, skills, agents, policies и themes. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/reference.md (2026-11-11).
- Checkpointing, который сохраняет не только файлы, но и историю разговора и исходный tool call, а `/restore` заново предлагает действие. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md (2026-11-11).
- Trusted folders с явным safe mode и персистентным `trustedFolders.json`. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/trusted-folders.md (2026-11-11).
- ACP как открытый протокол для IDE-интеграций с JSON-RPC 2.0 поверх stdio. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/acp-mode.md (2026-11-11).
- Telemetry-схема с событиями `gemini_cli.tool_call`, `gemini_cli.api_request`, `gemini_cli.model_routing` и метриками token/tool latency. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md (2026-11-11).
- Прозрачный release train: nightly → preview → stable с недельным окном. Source: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/releases.md (2026-11-11).

**Mechanics NOT to copy.**
- Fail-open hooks при не-JSON stdout. Причина: ошибка в hook-скрипте приводит к разрешению действия; безопаснее fail-closed по умолчанию для security hooks.
- Checkpointing, выключенный по умолчанию, с удалённым CLI-флагом. Причина: функция есть, но пользователь её не находит; discoverability падает.
- Safe mode, который молча отключает MCP, project settings и commands. Причина: пользователь видит «сломанный» проект без явной причины; нужен внятный статус и путь к trust.
- Subagent, которому запрещено вызывать subagent. Причина: ограничивает декомпозицию и заставляет родителя делать всю оркестрацию.
- Extension-механизм, дублирующий skills/commands/agents/hooks без чёткого rule of thumb. Причина: пользователь не понимает, куда класть расширение.

### 4.4 OpenCode

**Weaknesses and risks.**
- FACT: permission-правила работают по принципу «last matching rule wins», а agent-specific правила добавляются после глобальных; при отсутствии совпадения — `ask`. Это требует дисциплины порядка и легко ломается при добавлении правил. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- FACT: shell-сканер проверяет извлечённые подкоманды и `cd`, но «Directory inference from command text is best effort»; shell выполняется с правами пользователя. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- FACT: LSP выключен по умолчанию, но при включении auto-download может подтягивать серверы; 30+ built-in LSP-серверов увеличивают поверхность и сетевые зависимости. Source: https://opencode.ai/docs/lsp/ (2026-11-11).
- FACT: V2-конфигурация имеет deprecated-поля (`temperature`, `prompt`, `permission`, `tools`, `disable`, `maxSteps`), а `request` overlays «preserves these values but does not yet send them with model requests» — половина функции ещё не работает. Source: https://opencode.ai/docs/agents/ (2026-11-11).
- FACT: `opencode pair` даёт одноразовую ссылку, истекающую через 5 минут; это ограничивает совместную работу и удалённую демонстрацию. Source: https://opencode.ai/docs/ (2026-11-11).
- FACT: продукт охватывает TUI, desktop, web, mobile, browser, Code Mode, plugins, SDK; такая широта повышает стоимость поддержки и риск расхождения поведения поверхностей. Source: https://opencode.ai/llms.txt (2026-11-11); https://api.github.com/repos/anomalyco/opencode/contents/packages (2026-11-11).
- Телеметрия в просмотренных docs не описана — UNKNOWN; нельзя утверждать ни её наличие, ни отсутствие. Source: https://opencode.ai/docs/ (2026-11-11).

**Mechanics worth learning.**
- Server-first архитектура: TUI — клиент, `opencode serve` публикует OpenAPI 3.1 и генерирует SDK. Source: https://opencode.ai/docs/server/ (2026-11-11).
- SSE-события и REST-сессии с `fork`, `revert`, `unrevert`, `summarize`, `diff`, `abort` — богатый контракт для клиентов. Source: https://opencode.ai/docs/server/ (2026-11-11).
- Permission-движок с shell-сканером и явными `allow`/`ask`/`deny`, включая `external_directory`. Source: https://opencode.ai/docs/permissions/ (2026-11-11).
- LSP diagnostics как feedback-петля для агента. Source: https://opencode.ai/docs/lsp/ (2026-11-11).
- Provider-каталог с `package`, `settings.baseURL`, `models`, `variants`, `cost`, `limit`. Source: https://opencode.ai/docs/providers/ (2026-11-11).
- Skills с совместимостью `.claude/skills` и `.agents/skills`, что снижает стоимость миграции. Source: https://opencode.ai/docs/skills/ (2026-11-11).

**Mechanics NOT to copy.**
- Permission-order «last match wins» без specificity. Причина: политика становится порядко-зависимой и хрупкой; лучше явный приоритет/скоуп.
- Наполовину реализованные поля конфигурации, которые парсятся, но не отправляются. Причина: пользователь думает, что настройка работает; это хуже отсутствия функции.
- Auto-download LSP по умолчанию при включении LSP. Причина: неожиданные сетевые загрузки и supply-chain риск; лучше явный install.
- Одноразовая 5-минутная ссылка как основной механизм sharing. Причина: не подходит для командной работы и повторных сессий.
- Широкая продуктовая поверхность до стабилизации core-контрактов (V2 migration + deprecated fields). Причина: распылённое внимание и несовместимости между клиентами.

### 4.5 Aider

**Weaknesses and risks.**
- FACT: в просмотренных docs нет permissions/sandbox-слоя; Aider правит файлы и запускает lint/test с правами пользователя. Это существенный gap для автономного агента. Source: https://aider.chat/docs/ (2026-11-11); https://aider.chat/docs/usage/lint-test.html (2026-11-11).
- FACT: контекст ограничен repo map и вручную добавленными файлами; агент не сканирует репозиторий инструментами, а пользователь должен сам выбрать файлы. Source: https://aider.chat/docs/usage/tips.html (2026-11-11).
- FACT: edit format `whole` требует полную копию файла и дороже/медленнее diff; для GPT-3.5 он выбран осознанно, но это неэффективно для больших файлов. Source: https://aider.chat/docs/more/edit-formats.html (2026-11-11); https://aider.chat/docs/benchmarks.html (2026-11-11).
- FACT: auto-commit включён по умолчанию; каждое изменение становится коммитом, а commit message генерирует weak model. Это засоряет историю и зависит от качества слабой модели. Source: https://aider.chat/docs/git.html (2026-11-11).
- FACT: последний stable-релиз `v0.86.0` — 2025-08-09, при коммитах до мая 2026; cadence и maintenance-статус неопределённы. Source: https://api.github.com/repos/Aider-AI/aider/releases (2026-11-11); https://github.com/Aider-AI/aider/commits/main (2026-11-11).
- FACT: установка ограничена Python 3.8–3.13 для quick installer и 3.9–3.12 для pip/pipx. Source: https://aider.chat/docs/install.html (2026-11-11).
- MCP и subagents в просмотренных docs не документированы — UNKNOWN. Source: https://aider.chat/docs/ (2026-11-11).

**Mechanics worth learning.**
- Repo map на tree-sitter tags + graph ranking (PageRank) с token budget, динамическим расширением при отсутствии файлов и disk cache. Source: https://aider.chat/docs/repomap.html (2026-11-11); https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py (2026-11-11).
- Edit formats, подобранные под модель, и явный `--edit-format` для форсирования. Source: https://aider.chat/docs/more/edit-formats.html (2026-11-11).
- Git-native workflow: auto-commit, `/undo`, отдельный weak model для commit messages. Source: https://aider.chat/docs/git.html (2026-11-11).
- Architect/editor split с двумя моделями и `--editor-edit-format`. Source: https://aider.chat/docs/usage/modes.html (2026-11-11).
- Публичные воспроизводимые бенчмарки с ценой и процентом успеха. Source: https://aider.chat/docs/leaderboards/ (2026-11-11).
- Watch-режим с AI-комментариями в коде (`AI!`, `AI?`). Source: https://aider.chat/docs/usage/watch.html (2026-11-11).

**Mechanics NOT to copy.**
- Отсутствие permission/sandbox-слоя. Причина: агент с правом записи и запуска команд без границ — неприемлемый риск по умолчанию.
- Ручной выбор файлов как единственная стратегия контекста. Причина: перекладывает поиск на пользователя и плохо масштабируется на большие репозитории.
- Auto-commit по умолчанию. Причина: история Git становится шумной; безопаснее opt-in или отдельная ветка.
- Whole-file edit как дефолт для слабых моделей. Причина: дорого и медленно; лучше diff/udiff с fallback.
- Отсутствие MCP/агентной экстенсибильности. Причина: ограничивает интеграции и автоматизацию; но это может быть осознанным минимализмом.

### 4.6 Qwen Code

**Weaknesses and risks.**
- FACT: daemon по умолчанию слушает loopback без bearer authentication, и любой локальный процесс может использовать полный API, включая code execution; защита — только `QWEN_SERVER_TOKEN` и `--require-auth`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11).
- FACT: Landlock fallback не умеет `network: closed` и не скрывает masked paths; при `backend: auto` на системах без bwrap граница слабее. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sandbox.md (2026-11-11).
- FACT: forks не имеют worktree-изоляции и делят рабочую директорию с родителем, поэтому конкурентные правки могут конфликтовать; fork children не могут спавнить subagents. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md (2026-11-11).
- FACT: настройки имеют сложный precedence: system defaults, user, project, system, плюс workspace-ограничения; `ui.allowedApprovalModes` — только presentation, не enforcement. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/settings.md (2026-11-11).
- FACT: Claude Code-совместимые поля subagent-ов (`effort`, `skills`, `initialPrompt`, `memory`, `isolation`) «noted but not yet landed», то есть совместимость неполная. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md (2026-11-11).
- FACT: продукт быстро расширяется: Agent Teams, Agent Arena, channels, computer use, browser use, mobile shell, live host, managed agent server; широкая поверхность повышает риск расхождения поведения и стоимости поддержки. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11); https://api.github.com/repos/QwenLM/qwen-code/contents/packages (2026-11-11).
- CLAIM: заявленные 76.40–77.80% на SWE-bench Verified — self-reported, без независимого воспроизведения. Source: https://github.com/QwenLM/qwen-code (2026-11-11).

**Mechanics worth learning.**
- Approval ladder `plan → default → auto-edit → auto → yolo` с classifier для Auto Mode и сохранением `permissions.deny`. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md (2026-11-11).
- Execution sandbox с явной матрицей `filesystem` × `network` × `backend` (bwrap/Landlock). Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sandbox.md (2026-11-11).
- Claude Code-совместимый frontmatter subagent-ов и hooks — снижает стоимость миграции. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md (2026-11-11); https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/hooks.md (2026-11-11).
- `/context` с категориями и понятием «idle cost» для оценки постоянного префикса. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/context-cost.md (2026-11-11).
- Daemon с HTTP + SSE, reconnect к активным сессиям и SDK на трёх языках. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11).
- `modelProviders` с `envKey`, `baseUrl`, `wireApi` и runtime-переключением. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/model-providers.md (2026-11-11).

**Mechanics NOT to copy.**
- Daemon без аутентификации по умолчанию. Причина: полный API с code execution доступен любому локальному процессу; bearer auth должен быть обязательным.
- Landlock как fallback для closed network. Причина: он не обеспечивает заявленную границу; лучше явно запрещать конфигурацию, которую backend не может выполнить.
- Forks без worktree-изоляции. Причина: конкурентные правки конфликтуют, а «fork» создаёт ложное ожидание изоляции.
- Feature sprawl (teams, arena, channels, computer use) до стабилизации core. Причина: распылённые ресурсы и несовместимости между поверхностями.
- Сложный settings-precedence с presentation-only ключами. Причина: пользователь не понимает, что реально влияет на enforcement.

## 5. Strengths and differentiators

### 5.1 Per-product strengths

- **Codex CLI.** Самая явная модель безопасности: OS sandbox по умолчанию, сеть выключена, approvals отделены от sandbox, protected paths. Плюс сильный машинный контракт app-server и CI-режим `exec --json`. Sources: https://learn.chatgpt.com/docs/agent-approvals-security (2026-11-11); https://learn.chatgpt.com/docs/app-server.md (2026-11-11); https://learn.chatgpt.com/docs/non-interactive-mode.md (2026-11-11).
- **Claude Code.** Самая развитая экосистема расширений и поверхностей: hooks, skills, plugins, subagents, MCP, memory, IDE/desktop/web/mobile, единый engine. Sources: https://code.claude.com/docs/en/overview (2026-11-11); https://code.claude.com/docs/en/hooks (2026-11-11); https://code.claude.com/docs/en/plugins (2026-11-11).
- **Gemini CLI.** Самый прозрачный OSS-процесс: architecture-документ, extension bundle, checkpointing, trusted folders, ACP, публичная telemetry-схема, weekly release train. Sources: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/index.md (2026-11-11); https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/releases.md (2026-11-11).
- **OpenCode.** Самый чистый client/server-дизайн: TUI как клиент, OpenAPI 3.1, SDK, SSE, богатый REST для сессий, LSP diagnostics и широкий provider-каталог. Sources: https://opencode.ai/docs/server/ (2026-11-11); https://opencode.ai/docs/lsp/ (2026-11-11); https://opencode.ai/docs/providers/ (2026-11-11).
- **Aider.** Самая зрелая контекстная эвристика для редактирования: PageRank repo map, token budget, model-specific edit formats, git-native undo и публичные бенчмарки. Sources: https://aider.chat/docs/repomap.html (2026-11-11); https://aider.chat/docs/more/edit-formats.html (2026-11-11); https://aider.chat/docs/leaderboards/ (2026-11-11).
- **Qwen Code.** Самый широкий охват провайдеров и поверхностей при Apache-2.0: OpenAI/Anthropic/Gemini/Qwen, локальные модели, daemon HTTP+SSE, SDK на трёх языках, Claude Code-совместимые subagents/hooks. Sources: https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md (2026-11-11); https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/model-providers.md (2026-11-11).

### 5.2 Notable cross-product differentiators

| Differentiator | Who is strongest | Concrete mechanic |
|---|---|---|
| OS-level sandbox by default | Codex CLI | `sandbox_mode = "workspace-write"` + network off + protected paths, Seatbelt/bwrap/MXC |
| Lifecycle hook coverage | Claude Code | 30+ events, handlers `command`/`http`/`mcp_tool`/`prompt`/`agent` |
| Extension packaging | Gemini CLI | `gemini-extension.json` bundle with commands, hooks, skills, agents, policies |
| Client/server separation | OpenCode | `opencode serve`, OpenAPI 3.1 at `/doc`, SSE `/event`, SDK generation |
| Repository context ranking | Aider | tree-sitter tags + PageRank repo map, `--map-tokens`, cache |
| Multi-provider + multi-surface OSS | Qwen Code | `modelProviders` + daemon + SDKs + IDE/desktop/web/channels |
| Snapshot/restore of files and conversation | Gemini CLI | shadow Git repo + `/restore` re-proposes tool call |
| CI-native machine output | Codex CLI | `codex exec --json` JSONL + `--output-schema` |
| Permission rule engine for shell | OpenCode | per-subcommand scanner + `allow`/`ask`/`deny` |
| Skills as portable packaging | Claude Code, Codex CLI, Qwen Code, OpenCode | `SKILL.md` with `name`/`description`, progressive disclosure |

## 6. Candidate recommendations

Раздел носит competitor-side характер: ниже — что можно изучить у конкурента и что у него копировать не стоит. Сопоставление с ZCode выполняется в синтезе, здесь нет ссылок на файлы ZCode.

### 6.1 Codex CLI

| Learn | Why | Do NOT copy | Why |
|---|---|---|---|
| Разделение «sandbox policy» и «approval policy» | Позволяет независимо управлять технической границей и human-in-the-loop | Две параллельные permission-модели (`sandbox_mode` и `[permissions.<name>]`) | Удваивает состояния и усложняет миграцию |
| app-server JSON-RPC с thread/turn/approval events | Чёткий контракт между runtime и любым UI | `danger-full-access` как обычный режим | Слишком легко потерять границу безопасности |
| `exec --json` JSONL + `--output-schema` | Готовый CI/automation-контракт | Trust-by-hash с молчаливым skip hooks | Пользователь не понимает, почему hook не сработал |
| `AGENTS.override.md` → `AGENTS.md` → fallback + byte cap | Предсказуемая иерархия инструкций | Фрагментированная документация с редиректами | Ломает ссылки и автоматическую проверку актуальности |

### 6.2 Claude Code

| Learn | Why | Do NOT copy | Why |
|---|---|---|---|
| Progressive disclosure skills (`description` always, body on invoke) | Экономит контекст и сохраняет discoverability | Sandbox только для shell | Read/WebFetch/MCP остаются вне границы, создаётся ложное чувство безопасности |
| Subagent frontmatter с `tools`, `model`, `permissionMode`, `maxTurns`, `isolation` | Гибкое делегирование с явными ограничениями | 30+ hook events и 5 handler types без стабильного контракта | Высокая стоимость поддержки и риск несовместимости |
| Иерархия памяти с imports и auto memory | Переносимость инструкций и накопление знаний | Permission-order `deny → ask → allow` с первым совпадением | Трудно предсказать и статически проверить |
| Единый engine для всех поверхностей | Паритет поведения terminal/IDE/desktop/web | Проприетарное ядро при открытых plugins | Lock-in и невозможность аудита |

### 6.3 Gemini CLI

| Learn | Why | Do NOT copy | Why |
|---|---|---|---|
| Extension bundle `gemini-extension.json` | Один installable артефакт для commands, hooks, skills, agents, policies | Fail-open hooks при не-JSON stdout | Ошибка hook-а разрешает действие вместо блокировки |
| Checkpointing files + conversation + tool call | Полное восстановление контекста, а не только diff | Checkpointing off by default + removed CLI flag | Функция не discoverable |
| Trusted folders + safe mode | Явная граница для незнакомых репозиториев | Safe mode, молча отключающий MCP/settings/commands | Пользователь видит «сломанный» проект без причины |
| ACP JSON-RPC 2.0 over stdio | Открытая IDE-интеграция | Запрет subagent → subagent | Ограничивает декомпозицию |
| Telemetry schema с token/tool/model-routing событиями | Наблюдаемость и стоимость | Extension/skills/commands/agents/hooks без rule of thumb | Пользователь не знает, куда класть расширение |

### 6.4 OpenCode

| Learn | Why | Do NOT copy | Why |
|---|---|---|---|
| Server-first + OpenAPI 3.1 + generated SDK | Любой клиент может подключиться к runtime | Permission «last match wins» без specificity | Порядко-зависимая и хрупкая политика |
| SSE `/event` + REST session API (`fork`, `revert`, `diff`, `abort`) | Богатый контракт для UI и автоматизации | Парсинг полей, которые ещё не отправляются | Пользователь думает, что настройка работает |
| LSP diagnostics как feedback | Ловит ошибки до запуска тестов | Auto-download LSP при включении | Сетевые загрузки и supply-chain риск |
| Provider catalog с `package`, `models`, `variants`, `cost` | Гибкая маршрутизация моделей | Одноразовая 5-минутная пара-ссылка как основной sharing | Не подходит для командной работы |
| Skills-совместимость с `.claude/skills` и `.agents/skills` | Снижает стоимость миграции | Широкая поверхность до стабилизации core | Распылённые ресурсы и несовместимости |

### 6.5 Aider

| Learn | Why | Do NOT copy | Why |
|---|---|---|---|
| PageRank repo map с token budget и dynamic expansion | Дешёвый и объяснимый контекст для больших репозиториев | Отсутствие permission/sandbox слоя | Агент с записью и shell без границ — неприемлемый риск |
| Model-specific edit formats + `--edit-format` | Снижает стоимость и повышает success rate | Ручной выбор файлов как единственная стратегия | Не масштабируется и перекладывает поиск на пользователя |
| Git-native auto-commit + `/undo` + weak model для commit messages | Быстрый откат и чистая история изменений | Auto-commit по умолчанию | Засоряет историю; нужен opt-in |
| Architect/editor split | Разделение планирования и редактирования | Whole-file edit по умолчанию для слабых моделей | Дорого и медленно |
| Публичные бенчмарки с ценой | Сравнимость моделей и форматов | MCP/subagents как отсутствующая экосистема | Ограничивает интеграции, хотя может быть осознанным минимализмом |

### 6.6 Qwen Code

| Learn | Why | Do NOT copy | Why |
|---|---|---|---|
| Approval ladder `plan → default → auto-edit → auto → yolo` + classifier | Градуированная автономия с сохранением deny | Daemon без auth по умолчанию | Полный API с code execution доступен локальным процессам |
| Execution sandbox matrix `filesystem` × `network` × `backend` | Явные, проверяемые границы | Landlock fallback для closed network | Backend не обеспечивает заявленную границу |
| Claude Code-совместимый frontmatter subagents/hooks | Миграция без переписывания | Forks без worktree-изоляции | Конкурентные правки конфликтуют |
| `/context` + idle cost | Понятная стоимость постоянного префикса | Feature sprawl до стабилизации core | Распылённые ресурсы и расхождение поверхностей |
| Daemon HTTP+SSE + SDKs | Единый runtime для browser/editor/automation | Сложный settings-precedence с presentation-only ключами | Пользователь не понимает, что влияет на enforcement |

### 6.7 Cross-competitor anti-patterns

| Anti-pattern | Where observed | Reason not worth copying |
|---|---|---|
| Fail-open hook semantics | Gemini CLI (non-JSON stdout → Allow) | Ошибка в hook-е разрешает действие; security hooks должны fail closed |
| Unauthenticated local daemon with code execution | Qwen Code | Любой локальный процесс получает полный API; bearer auth обязателен |
| Sandbox only for shell commands | Claude Code | Read/WebFetch/MCP/LSP вне границы; заявление «sandbox» вводит в заблуждение |
| Two overlapping permission configs | Codex CLI | Удваивает состояния и миграцию; нужна одна модель |
| Permission ordering without specificity | OpenCode, Claude Code | Результат зависит от порядка; трудно статически проверить |
| Runs parsed but not sent | OpenCode V2 `request` overlays | Создаёт ложное ожидание работающей настройки |
| Auto-commit by default | Aider | Засоряет историю; должен быть opt-in |
| No permission layer at all | Aider | Агент с shell и записью без границ — неприемлемый риск по умолчанию |
| Feature sprawl before core stability | Qwen Code, OpenCode | Распылённые ресурсы, расхождение поведения поверхностей |
| Huge hook taxonomy without versioned contract | Claude Code | Дорогая поддержка и риск несовместимости между релизами |

## 7. Open questions and unverified

**Confirmed gaps in sources.**
- Codex CLI: внутренний agent loop как отдельный документ не опубликован. Публичный контракт app-server описывает turn lifecycle, но не внутренние стадии планирования/выбора tool-ов. Статус: UNKNOWN.
- Codex CLI: `developers.openai.com/codex/*` отдаёт 308 на `learn.chatgpt.com/docs/*`; файлы `docs/config.md` и `docs/sandbox.md` в GitHub-репозитории содержат только ссылки-заглушки. Часть старых URL недоступна напрямую. Sources: https://developers.openai.com/codex/config-reference (2026-11-11); https://raw.githubusercontent.com/openai/codex/main/docs/config.md (2026-11-11).
- Codex CLI: `codex-rs/README.md` не содержит архитектурного описания; список crates получен через GitHub API, а не из документа. Source: https://raw.githubusercontent.com/openai/codex/main/codex-rs/README.md (2026-11-11).
- Claude Code: ядро проприетарно, полный список tools, внутренний цикл и точная семантика permission enforcement не проверяемы по исходникам. Статус: UNKNOWN. Source: https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md (2026-11-11).
- Gemini CLI: отдельной architecture-страницы нет; `docs/core/index.md` даёт только высокоуровневое описание. `docs/architecture.md` и `docs/core/architecture.md` вернули 404. Sources: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/index.md (2026-11-11); https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/architecture.md (2026-11-11).
- Qwen Code: `docs/developers/architecture.md` не отдался через WebFetch; внутренний цикл и полный tool-каталог не проверены. Source: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/developers/architecture.md (2026-11-11).
- OpenCode: hooks plugin API не раскрывает имена событий в просмотренных страницах; `docs/usage` вернул 404. Статус: UNKNOWN. Sources: https://opencode.ai/docs/build/plugins/ (2026-11-11); https://opencode.ai/docs/usage/ (2026-11-11).
- Aider: sandbox/permissions и MCP не документированы в просмотренных страницах; это не доказательство отсутствия. Статус: UNKNOWN. Source: https://aider.chat/docs/ (2026-11-11).

**Claims requiring independent verification.**
- CLAIM: Gemini CLI README заявляет «Enterprise Code Assist only», «No free tier or Google AI plans» и «Not optimized for Gemini 4+». Source: https://github.com/google-gemini/gemini-cli (2026-11-11). Это может быть состоянием конкретной ветки/страницы; требует проверки на текущем релизе.
- CLAIM: Qwen Code заявляет 76.40–77.80% на SWE-bench Verified с Qwen 3.7 Max (500 задач, 3 trials). Source: https://github.com/QwenLM/qwen-code (2026-11-11). Независимого воспроизведения не было.
- CLAIM: Aider polyglot leaderboard показывает 88.0% для `gpt-5 (high)` при $29.08. Source: https://aider.chat/docs/leaderboards/ (2026-11-11). Методика опубликована, но результаты self-reported.
- CLAIM: OpenCode Go — «$10/month subscription plan». Source: https://opencode.ai/docs/ (2026-11-11). Цена и условия не проверялись.

**Operational limitations of this research.**
- GitHub REST API rate limit был исчерпан в ходе исследования (`remaining 0`), поэтому часть повторных запросов (свежие stars/commits/contents) не выполнялась. Все приведённые release-данные получены до исчерпания лимита 2026-11-11.
- Ни один продукт не запускался; поведение sandbox, hooks, permissions и telemetry описано по документации, а не по runtime-наблюдениям.
- Не проверялись: Windows-поведение, enterprise-цены и SSO, audit logs, история CVE, supply-chain контроли плагинов, локализация, фактические token/cost-замеры, воспроизводимость бенчмарков.
- Не проверялись: реальные сетевые запросы telemetry (только документация), поведение при отключённой сети, совместимость форматов между версиями.

**Not-checked list.**
- Codex cloud environments: setup scripts, secrets, OIDC, network rules — прочитано только верхнеуровневое описание.
- Claude Code Agent SDK: API, orchestration, permission model — не открывался.
- Gemini CLI enterprise configuration и billing — не открывались.
- OpenCode Code Mode и desktop/mobile — не открывались.
- Aider voice, images, browser, copy/paste — не открывались.
- Qwen Code Agent Teams, Agent Arena, channels, computer use — только упоминания в README, механики не проверены.
- Лицензии зависимостей и сторонних компонентов (tree-sitter, LSP-серверы, MCP-серверы) — не проверялись.

## 8. Evidence appendix

Все URL ниже открывались 2026-11-11. Тип источника: `docs` — официальная документация, `repo` — GitHub-репозиторий/API, `changelog` — releases, `code` — исходный файл, `marketing` — маркетинговая страница, `license` — лицензия.

| ID | Product | Type | URL | Supports |
|---|---|---|---|---|
| C1-01 | Codex | repo | https://github.com/openai/codex | Positioning, install, Apache-2.0 |
| C1-02 | Codex | repo | https://api.github.com/repos/openai/codex | License, stars, language |
| C1-03 | Codex | changelog | https://api.github.com/repos/openai/codex/releases | `rust-v0.167.1`, cadence |
| C1-04 | Codex | repo | https://api.github.com/repos/openai/codex/contents/codex-rs | Crate list |
| C1-05 | Codex | docs | https://learn.chatgpt.com/docs/codex/cli.md | CLI commands, TUI, resume |
| C1-06 | Codex | docs | https://learn.chatgpt.com/docs/non-interactive-mode.md | `codex exec`, `--json`, `--output-schema`, `--full-auto` removal |
| C1-07 | Codex | docs | https://learn.chatgpt.com/docs/hooks.md | Hook events, handlers, trust |
| C1-08 | Codex | docs | https://learn.chatgpt.com/docs/agent-configuration/subagents.md | Subagent TOML, `[agents]`, built-ins |
| C1-09 | Codex | docs | https://learn.chatgpt.com/docs/build-skills.md | `SKILL.md`, `.agents/skills`, listing budget |
| C1-10 | Codex | docs | https://learn.chatgpt.com/docs/agent-configuration/agents-md.md | AGENTS.md discovery, 32 KiB cap |
| C1-11 | Codex | docs | https://learn.chatgpt.com/docs/config-file/config-basic.md | `~/.codex/config.toml`, common keys |
| C1-12 | Codex | docs | https://learn.chatgpt.com/docs/config-file/config-reference.md | `approval_policy`, `sandbox_mode`, `mcp_servers`, `model_providers` |
| C1-13 | Codex | docs | https://learn.chatgpt.com/docs/config-file/config-sample.md | Sample values, 32768 |
| C1-14 | Codex | docs | https://learn.chatgpt.com/docs/config-file/config-advanced.md | `[analytics]`, `[otel]` |
| C1-15 | Codex | docs | https://learn.chatgpt.com/docs/permissions.md | Beta permission profiles |
| C1-16 | Codex | docs | https://learn.chatgpt.com/docs/agent-approvals-security | Sandbox OS mechanics, network, approvals |
| C1-17 | Codex | docs | https://learn.chatgpt.com/docs/app-server.md | JSON-RPC methods, events, approvals |
| C1-18 | Codex | docs | https://learn.chatgpt.com/docs/extend/mcp | MCP transports, auth, approval modes |
| C1-19 | Codex | docs | https://learn.chatgpt.com/docs/cloud | Cloud tasks, environments |
| C1-20 | Codex | docs | https://learn.chatgpt.com/docs/code-review.md | `/review`, `review_model`, cloud review |
| C1-21 | Codex | docs | https://learn.chatgpt.com/docs/developer-commands.md | Slash commands |
| C1-22 | Codex | docs | https://learn.chatgpt.com/docs/cli-customization.md | Theme, editor |
| C1-23 | Claude | repo | https://github.com/anthropics/claude-code | Repo scope, issues/plugins |
| C1-24 | Claude | license | https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md | Proprietary license |
| C1-25 | Claude | docs | https://code.claude.com/docs/en/overview | Surfaces, shared engine, features |
| C1-26 | Claude | docs | https://code.claude.com/docs/en/permissions | Modes, rule order |
| C1-27 | Claude | docs | https://code.claude.com/docs/en/sandboxing | Seatbelt/bubblewrap, filesystem/network keys |
| C1-28 | Claude | docs | https://code.claude.com/docs/en/hooks | Hook events, handlers, exit codes |
| C1-29 | Claude | docs | https://code.claude.com/docs/en/sub-agents | Subagent paths, frontmatter, built-ins |
| C1-30 | Claude | docs | https://code.claude.com/docs/en/skills | SKILL.md, progressive disclosure |
| C1-31 | Claude | docs | https://code.claude.com/docs/en/plugins | Plugin bundle, marketplace |
| C1-32 | Claude | docs | https://code.claude.com/docs/en/mcp | MCP scopes, transports, OAuth |
| C1-33 | Claude | docs | https://code.claude.com/docs/en/memory | CLAUDE.md hierarchy, imports, auto memory |
| C1-34 | Claude | docs | https://code.claude.com/docs/en/settings | Settings precedence, keys |
| C1-35 | Claude | docs | https://code.claude.com/docs/en/cli-reference | CLI flags |
| C1-36 | Claude | docs | https://code.claude.com/docs/en/costs | `/usage`, `--max-budget-usd`, caching |
| C1-37 | Claude | docs | https://code.claude.com/docs/en/monitoring-usage | OTel metrics/events |
| C1-38 | Claude | changelog | https://api.github.com/repos/anthropics/claude-code/releases | `v2.1.322`, cadence |
| C1-39 | Gemini | repo | https://github.com/google-gemini/gemini-cli | Positioning, Apache-2.0, README claims |
| C1-40 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/index.md | Core/cli architecture, agent loop |
| C1-41 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/tools.md | Tool names, confirmations |
| C1-42 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/sandbox.md | Sandbox flags, profiles, mounts |
| C1-43 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md | Shadow repo, `/restore`, default off |
| C1-44 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/reference.md | Extension manifest and layout |
| C1-45 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/index.md | Install commands |
| C1-46 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md | Hook events, command-only, exit codes |
| C1-47 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md | Subagent fields, built-ins, no nesting |
| C1-48 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/custom-commands.md | TOML commands, `{{args}}`, `!{}`, `@{}` |
| C1-49 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/trusted-folders.md | Safe mode, trustedFolders.json |
| C1-50 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md | Telemetry keys, events, metrics |
| C1-51 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md | Settings keys |
| C1-52 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/releases.md | Nightly/preview/stable cadence |
| C1-53 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/plan-mode.md | Plan mode controls |
| C1-54 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/auto-memory.md | Auto memory inbox |
| C1-55 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/acp-mode.md | ACP protocol and methods |
| C1-56 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md | Headless output |
| C1-57 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/generation-settings.md | Model aliases/overrides |
| C1-58 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/token-caching.md | Token caching |
| C1-59 | Gemini | changelog | https://api.github.com/repos/google-gemini/gemini-cli/releases | `v0.68.0`, cadence |
| C1-60 | OpenCode | repo | https://github.com/anomalyco/opencode | Repo layout, packages, MIT |
| C1-61 | OpenCode | repo | https://api.github.com/repos/anomalyco/opencode | License, stars, language |
| C1-62 | OpenCode | changelog | https://api.github.com/repos/anomalyco/opencode/releases | `v2.2.7`, cadence |
| C1-63 | OpenCode | docs | https://opencode.ai/docs/ | Positioning, surfaces, pair |
| C1-64 | OpenCode | docs | https://opencode.ai/docs/server/ | OpenAPI, SSE, session endpoints |
| C1-65 | OpenCode | docs | https://opencode.ai/docs/agents/ | Agent modes, model syntax, steps |
| C1-66 | OpenCode | docs | https://opencode.ai/docs/permissions/ | Rule engine, shell scanner, approvals |
| C1-67 | OpenCode | docs | https://opencode.ai/docs/tools/ | Built-in tools, permission resources |
| C1-68 | OpenCode | docs | https://opencode.ai/docs/lsp/ | LSP config, built-in servers |
| C1-69 | OpenCode | docs | https://opencode.ai/docs/plugins/ | Plugin config, discovery |
| C1-70 | OpenCode | docs | https://opencode.ai/docs/build/plugins/ | `Plugin.define` |
| C1-71 | OpenCode | docs | https://opencode.ai/docs/mcp-servers/ | `mcp.servers`, local/remote, OAuth |
| C1-72 | OpenCode | docs | https://opencode.ai/docs/commands/ | Markdown/JSON commands, `$ARGUMENTS` |
| C1-73 | OpenCode | docs | https://opencode.ai/docs/config/ | Config keys, precedence |
| C1-74 | OpenCode | docs | https://opencode.ai/docs/rules/ | AGENTS.md, instructions |
| C1-75 | OpenCode | docs | https://opencode.ai/docs/skills/ | SKILL.md, discovery, permissions |
| C1-76 | OpenCode | docs | https://opencode.ai/docs/providers/ | Provider/model config |
| C1-77 | OpenCode | marketing | https://opencode.ai/terminal.md | TUI, mini, keybinds, stats |
| C1-78 | Aider | repo | https://github.com/Aider-AI/aider | Repo, license, positioning |
| C1-79 | Aider | repo | https://api.github.com/repos/Aider-AI/aider | License, stars, language |
| C1-80 | Aider | changelog | https://api.github.com/repos/Aider-AI/aider/releases | `v0.86.0`, last release date |
| C1-81 | Aider | docs | https://aider.chat/docs/ | Product surface, docs map |
| C1-82 | Aider | docs | https://aider.chat/docs/repomap.html | Repo map mechanics, `--map-tokens` |
| C1-83 | Aider | code | https://raw.githubusercontent.com/Aider-AI/aider/main/aider/repomap.py | Tree-sitter, PageRank, cache |
| C1-84 | Aider | docs | https://aider.chat/docs/more/edit-formats.html | Edit formats, model mapping |
| C1-85 | Aider | docs | https://aider.chat/docs/git.html | Auto-commit, `/undo`, commit messages |
| C1-86 | Aider | docs | https://aider.chat/docs/usage/modes.html | Code/ask/architect/help |
| C1-87 | Aider | docs | https://aider.chat/docs/config/options.html | CLI options and defaults |
| C1-88 | Aider | docs | https://aider.chat/docs/config/aider_conf.html | YAML config precedence |
| C1-89 | Aider | docs | https://aider.chat/docs/config/adv-model-settings.html | Model settings YAML |
| C1-90 | Aider | docs | https://aider.chat/docs/usage/lint-test.html | Lint/test options |
| C1-91 | Aider | docs | https://aider.chat/docs/usage/watch.html | Watch mode, AI comments |
| C1-92 | Aider | docs | https://aider.chat/docs/more/analytics.html | PostHog analytics, opt-out |
| C1-93 | Aider | docs | https://aider.chat/docs/benchmarks.html | Exercism Python benchmark |
| C1-94 | Aider | docs | https://aider.chat/docs/leaderboards/ | Polyglot leaderboard |
| C1-95 | Aider | docs | https://aider.chat/docs/install.html | Install commands, Python versions |
| C1-96 | Aider | repo | https://github.com/Aider-AI/aider/commits/main | Latest commit date |
| C1-97 | Qwen | repo | https://github.com/QwenLM/qwen-code | Positioning, Gemini CLI lineage, Apache-2.0 |
| C1-98 | Qwen | repo | https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md | Features, daemon, providers, security note |
| C1-99 | Qwen | repo | https://api.github.com/repos/QwenLM/qwen-code | License, stars, language |
| C1-100 | Qwen | changelog | https://api.github.com/repos/QwenLM/qwen-code/releases | `v0.27.2`, `v1.0.0-preview` |
| C1-101 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/settings.md | Settings keys, privacy |
| C1-102 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md | Approval modes, classifier |
| C1-103 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/model-providers.md | `modelProviders`, `envKey`, `wireApi` |
| C1-104 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sandbox.md | Execution sandbox matrix |
| C1-105 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md | Subagent fields, forks, background |
| C1-106 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/hooks.md | Hook events, types, exit codes |
| C1-107 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/skills.md | SKILL.md, locations, precedence |
| C1-108 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/mcp.md | `mcpServers`, transports, OAuth |
| C1-109 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/context-cost.md | `/context`, idle cost, deferred tools |
| C1-110 | Qwen | repo | https://api.github.com/repos/QwenLM/qwen-code/contents/packages | Package list |
| C1-111 | Gemini | repo | https://api.github.com/repos/google-gemini/gemini-cli/contents/packages | Package list |
| C1-112 | Gemini | repo | https://api.github.com/repos/google-gemini/gemini-cli/contents/docs | `evals`, `behavioral-evals.md` presence |
| C1-113 | Codex | docs | https://developers.openai.com/codex/config-reference | Redirect evidence (308 to learn.chatgpt.com) |
| C1-114 | Codex | docs | https://raw.githubusercontent.com/openai/codex/main/docs/config.md | Stub page evidence |
| C1-115 | Gemini | docs | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/architecture.md | 404 evidence |
| C1-116 | Qwen | docs | https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/developers/architecture.md | Fetch failure evidence |
| C1-117 | OpenCode | docs | https://opencode.ai/docs/usage/ | 404 evidence |

**Coverage status.** C1 покрывает 6/6 продуктов, минимум по три первоисточника на продукт, все восемь обязательных разделов присутствуют, матрица механик построена. Ограничения: Claude Code не open-source и его ядро не проверяемо; Codex/Gemini/Qwen architecture-документы частично недоступны; runtime-проверок не было.

**Not-checked list (сводно).** Enterprise-цены и SSO; audit logs; CVE-история; supply-chain контроли плагинов и LSP/MCP-серверов; Windows-поведение; локализация; фактические token/cost-замеры; воспроизводимость бенчмарков; Codex cloud environment internals; Claude Agent SDK; Gemini enterprise/billing; OpenCode Code Mode/desktop/mobile; Aider voice/images/browser; Qwen Agent Teams/Arena/channels/computer use.

**Only-the-partial-written confirmation.** В рамках C1 создан только этот partial-файл: `<repo-root>/docs/research/partials/2026-11-11-competitors-c1-terminal-agents.md`. Другие файлы не изменялись, коммиты не создавались, пакеты не устанавливались.
