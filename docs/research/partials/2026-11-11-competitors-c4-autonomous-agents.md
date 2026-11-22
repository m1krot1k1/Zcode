# C4. Автономные и research-grade coding-агенты: Devin, OpenHands, SWE-agent, Factory Droid и смежные продукты

Дата исследования: 2026-11-11. Все источники открывались 2026-11-11.

**Контракт цитирования.** Каждое утверждение о конкуренте помечено `[ID]`; этот ID указывает на строку в разделе 8, где приведены полный URL и дата доступа 2026-11-11. Маркетинговые страницы помечены `[CLAIM]`, официальные docs/repo/paper — `[FACT]`, выводы — `[HYPOTHESIS]`, неподтверждённое — `[UNKNOWN]`. Ни один URL не составлен по памяти: все адреса взяты из навигации источников или проверены HTTP-запросом 2026-11-11.

Конвенция ссылок: `[D1]`, `[O1]`, `[S1]`, `[F1]`, `[C1]`, `[X1]`, `[CU1]`, `[A1]`, `[G1]` раскрываются в разделе 8 с полным URL и датой доступа. Метки: **[FACT]** — официальная документация, репозиторий или paper; **[CLAIM]** — маркетинг, pricing-страница или вендорский бенчмарк; **[UNKNOWN]** — источник не подтверждает.

## 1. Scope and method

Цель partial — собрать первичные механики автономных coding-агентов, пригодные для сравнительного анализа: архитектура исполнения, изоляция, модель долгой задачи, checkpoint/resume, параллелизм, tool surface, стратегия контекста, verification loop, human-in-the-loop, стоимость и лимиты, телеметрия и evals, бенчмарки и режимы отказа.

Метод:
1. Для каждого обязательного продукта искались официальные docs, репозиторий, paper/technical report, changelog и pricing. Приоритет — страницы, которые описывают механику, а не лендинги.
2. Для каждого утверждения фиксировался тип источника. Маркетинговые числа (бенчмарки вендора, «cost savings», «reliability») помечены **[CLAIM]** и не смешиваются с **[FACT]** из docs/repo.
3. Если страница отдавала 404/редирект или контент не извлекался, это записано в разделах 7 и 8; такие места не додумывались.
4. Бенчмарки фиксируются с версией: SWE-bench original/full (2294 инстанса), SWE-bench Lite (300), SWE-bench Verified (500), Terminal-Bench 2.0, Agent Arena, Next.js evals, Review Benchmark.
5. Разделы 4–6 — наблюдения о конкурентах и их механиках, а не рекомендации для ZCode.

Ограничения метода: документация продуктов быстро меняется; часть страниц содержит «future-dated» версии моделей и функций (2026), поэтому это срез на 2026-11-11, а не историческая реконструкция. Вендорские бенчмарки не воспроизводились.

## 2. Coverage table

| Продукт | Официальные primary-источники | Репозиторий/paper | Маркетинг/pricing | Покрытие механик | Статус |
|---|---|---|---|---|---|
| Devin (Cognition) | docs: intro, session tools, blueprints, API v3, Outposts, security profiles, dynamic workflows, testing, CLI sandbox, Fusion, computer use, stacked PRs, session insights, AGENTS.md `[D1]–[D27]` | публичного repo/paper в проверенных источниках не найдено | devin.ai/pricing, self-serve/usage billing `[D11]–[D13]` | архитектура, VM/snapshot, API, параллелизм, resume, HITL, cost, security | покрыт |
| OpenHands (All-Hands-AI) | repo README, SDK architecture, agent loop, condenser, workspace, Docker sandbox, security, task tool set, skills, hooks, agent server, warm pool, cloud API, v1 API, critic `[O1]–[O21]` | GitHub repo + paper arXiv 2407.16741 `[O1][O15]` | openhands.dev/pricing `[O17]` | архитектура, sandbox, event stream, condensation, delegation, verification, HITL, cost | покрыт |
| SWE-agent / mini-SWE-agent | repo, docs architecture, ACI, config, models, agent reference, changelog, batch, trajectories, tools, environments `[S1]–[S17]` | GitHub repo + paper arXiv 2405.15793 `[S1][S2][S3]` | нет отдельного pricing; OSS | ACI, tool surface, context, sandbox, batch parallelism, evals | покрыт |
| Factory Droid | docs home, sandbox, auto-run, Droid Shield, Missions, Missions reference, Workstreams, Droid Computers, Droid Exec, Router, enterprise security/identity/audit/network/airgap, agent effectiveness, release notes `[F1]–[F23]` | публичного repo/paper в проверенных источниках не найдено | pricing individuals/organizations, benchmarks `[F16]–[F21]` | sandbox, long-running missions, orchestration, enterprise, cost, evals | покрыт |
| GitHub Copilot coding agent | about, firewall, environment, MCP `[C1]–[C4]` | публичного repo в проверенных источниках не найдено | GitHub plan-зависимые лимиты | execution environments, PR flow, firewall, limits | покрыт частично (нет architecture deep-dive) |
| OpenAI Codex Cloud | cloud, cloud environments, sandboxing, approvals/security, legacy internet `[X1]–[X5]` | публичного repo cloud-части в проверенных источниках не найдено | ChatGPT plan | workspaces, environments, sandbox, network, approvals | покрыт частично (sandbox cloud не детализирован) |
| Cursor Cloud Agents | cloud agent, security, security-network, capabilities, builds, self-hosted, API, agent overview `[CU1]–[CU8]` | публичного repo в проверенных источниках не найдено | plan usage | VM isolation, snapshots, network, computer use, self-hosted, API | покрыт |
| Sourcegraph Amp | llms index, Orbs, sizes/costs, models/subagents, tools, pricing, agent-to-agent, self-hosted orbs, modes `[A1]–[A9]` | публичного repo в проверенных источниках не найдено | pricing/orb costs | per-thread orbs, subagents, self-hosted, cost | покрыт |
| Google Antigravity | product, agent, subagents, permissions, browser, artifacts, implementation plan, plans, enterprise, models, getting started `[G1]–[G11]` | публичного repo/paper в проверенных источниках не найдено | free/Google AI plans, Gemini Enterprise | surfaces, subagents, sandbox, browser, artifacts, enterprise hybrid execution | покрыт |

Итог покрытия: 4 обязательных продукта и 5 дополнительных. У Devin, OpenHands, SWE-agent, Factory и Antigravity — больше 3 первичных источников каждый. У Copilot, Codex Cloud, Cursor и Amp — по 4–8 официальных страниц, но часть архитектурных деталей не раскрыта.

## 3. Capability inventory

Все ссылки вида `[ID]` раскрываются в разделе 8 с полным URL и датой доступа 2026-11-11. В таблицах и тексте ниже `[FACT]` — утверждение, прямо поддерживаемое официальным источником; `[CLAIM]` — маркетинговое или вендорское заявление; `[HYPOTHESIS]` — вывод из фактов, не заявленный источником.

### 3.1 Сводная матрица механик

| Продукт | Исполнение и изоляция | Модель долгой задачи | Checkpoint / resume | Параллелизм | Tool surface | Контекст | Verification loop | HITL | Cost / limits | Telemetry / evals | Бенчмарк |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Devin** | Cloud VM на сессию; blueprint build → frozen snapshot; «each session boots a fresh copy»; Outposts переносит исполнение на свои машины `[D3][D9]` | Сессия с прогресс-шагами; правило «задача до 3 часов»; декомпозиция крупного; coordinator запускает child sessions `[D1][D7][D18]` | `suspended`/`resuming`; сообщение автоматически resume; Dynamic Workflows resume по run ID и хешу вызова `[D5][D6][D8]` | Child sessions на отдельных VM; dynamic workflows `pipeline`/`parallel`; concurrency по pricing page: до 10 на Free/Pro, unlimited на Max/Teams `[D7][D8][D13]` (vendor claim) | Shell, IDE (VS Code), Browser, Interactive Browser, Computer Use 1024×768, MCP, Slack/Teams `[D2][D21]` | AGENTS.md до 16 KiB auto-inject; skills; knowledge; memory; playbooks; blueprint `knowledge` в контексте `[D3][D24][D26]` | Testing & Video Recordings после PR; stacked PRs; CI/review; Session Insights `[D17][D22][D23]` | Interactive Browser, takeover IDE после pause, side chat read-only, security profiles, approval `[D2][D16]` | ACU = действия/сложность + VM time; sleep 5 мин; Windows +~9%; quotas/credits; workflow run max 7 дней `[D8][D11][D12]` | Session Insights; usage metrics; audit logs; analytics endpoints `[D23][D27]` | Публичного benchmark в проверенных docs не найдено; Agent Arena 1263 (Dec 2025) `[F19]` |
| **OpenHands** | LocalWorkspace subprocess; DockerWorkspace container; RemoteWorkspace HTTP→agent-server; Docker/Apptainer/API/cloud sandbox; warm-pool deferred init `[O2][O5][O6][O12]` | Conversation + event stream; `step()` атомарный; pause/resume; condensation при переполнении `[O3][O4]` | Event history append-only; `WAITING_FOR_CONFIRMATION`; sandbox pause/resume `[O3][O14]` | `TaskToolSet` subagents; `tool_concurrency_limit`; несколько agent-server; automations `[O1][O8][O11]` | `execute_bash`, `file_editor`, `glob`, `grep`, `finish`, `think`, `task_tracker`, MCP; browser — Chromium/Playwright в sandbox (paper version) `[O10][O15]` | LLM condenser: `max_size=120`, `keep_first=4`, target 60; skills progressive disclosure; AGENTS.md `[O4][O9]` | Critic score 0–1 + iterative refinement; hooks `Stop` может не дать завершиться `[O18][O19]` | Confirmation policy `AlwaysConfirm`/`NeverConfirm`/`ConfirmRisky`; risk LOW/MEDIUM/HIGH/UNKNOWN `[O7]` | OSS MIT; Teams $500/мес до 10 users, 5000 sessions/мес; BYO LLM `[O17]` | Event stream; critic results; hooks; audit trail решений security `[O7][O18][O19]` | Paper: SWE-bench Lite 26.0% (Claude 3.5 Sonnet, CodeActAgent v1.8); blog: 66.4% SWE-bench Verified (5 attempts + critic) `[O15][O16]` |
| **SWE-agent** | `SWEEnv` поверх SWE-ReX; local Docker или remote Modal/AWS; Docker image `python:3.11` по умолчанию `[S5][S13]` | Один `run()` до `done`; `handle_submission` читает `/root/model.patch`; retries `max_requeries=3` `[S8]` | Trajectory `.traj` сохраняется каждый шаг; `sweagent inspect`; web inspector `[S8][S11]` | `run-batch`, параллельные инстансы, per-instance cost limit `[S10]` | Bash, `filemap`, `_state`, tool bundles; ACI: линтер, file viewer 100 строк, search `[S4][S12]` | History processors (`cache_control`, `last_n_messages=2`); last-5 observations ablation; 100-line viewer `[S3][S6]` | Линтер блокирует синтаксически неверный edit; submit patch; benchmark harness `[S3][S4]` | Нет встроенного approval loop; `HumanModel`/`ReplayModel` для research `[S7]` | per-instance cost limit; local models без spending limits `[S7][S10]` | Trajectory inspector; paper ablations; SWE-bench `[S3][S11]` | Paper: SWE-bench full 12.47%, Lite 18.00% (GPT-4 Turbo); HumanEvalFix 87.7 Python `[S3]` |
| **mini-SWE-agent** | bash-only; local/docker/podman/singularity/bubblewrap/contree; `subprocess.run` `[S14][S15]` | Линейный цикл, каждый action независим; нет stateful shell `[S14]` | Линейная history; trajectory browser; v1/v2 миграция `[S14][S15]` | Легко масштабируется сменой `subprocess.run` на `docker exec` `[S14]` | Только bash; не требует tool-calling API `[S14]` | Полностью линейная history, без history processors `[S14]` | Внешние тесты/бенчмарк; нет встроенного verification loop `[S14]` | Нет approval loop; baseline для research `[S14]` | OSS; perf >74% SWE-bench Verified `[S14]` | Trajectory browser, SWE-bench bash-only leaderboard `[S14]` | >74% SWE-bench Verified (вендорский README) `[S14]` |
| **Factory Droid** | OS sandbox: Seatbelt macOS, bubblewrap+seccomp Linux/WSL2; egress proxy; per-command или whole-process; fail-closed `[F2]` | Missions: plan → milestones → Mission Control; «not fire-and-forget»; 1–500 features `[F5][F6]` | Milestones как checkpoints; session resume; Droid Computers persistent state; `--fork`/`--session-id` `[F5][F8][F9]` | Workstreams orchestrator + parallel agents; Droid Computers pool 1–20, 3 workers default; subagents inherit sandbox `[F2][F7][F8]` | Shell, file tools, browser/FetchUrl/WebSearch, MCP, skills, hooks, custom droids; Droid Exec headless `[F1][F4][F9]` | AGENTS.md, skills, hooks, mission plan; compaction сохраняет approved spec `[F5][F23]` | User-facing QA during mission; validator model; Droid Shield before commit/push; review automations `[F1][F4][F5][F6]` | Auto-run Off/Low/Medium/High; permission rules; Spec Mode; violations interrupt even High `[F3][F2]` | Pro $20/Plus $100/Max $200; rolling 5h/7d/30d; Missions требуют Extra Usage `[F16]` | Agent Effectiveness: throughput/output/attribution/intents/friction; OTel/Analytics API `[F22]` | Terminal-Bench 2.0: 63.1%; Agent Arena: 1330; Next.js 66%; Review F1 60.5% `[F18]–[F21]` |
| **Copilot coding agent** | GitHub Actions runner или cloud sandbox; Actions repo-bound; cloud sandbox multi-repo в org `[C1]` | Background task; один branch/один PR; Actions max 59 мин `[C1]` | Отдельного checkpoint/resume в docs не описано; PR как handoff; Agent Merge watch/fix `[C1]` | Один branch и один PR на task; concurrency в проверенных docs не раскрыта `[C1]` | Bash, file edits, tests/linters, GitHub MCP, repository MCP, Playwright MCP `[C1][C4]` | Repo instructions, MCP context, session logs `[C1][C4]` | Runs tests/linters; Agent Merge; human review обязателен `[C1]` | PR review; branch protection; firewall allowlist; Agent Merge `[C1][C2]` | Actions 59 мин hard cap; plan-dependent models `[C1]` | Session logs; PR warning о blocked address `[C1][C2]` | Публичного benchmark в проверенных docs не найдено |
| **Codex Cloud** | Legacy: isolated OpenAI-managed containers; current: own workspace per task; published environment `[X1][X2]` | Task продолжается при спящем компьютере; follow-ups в том же чате `[X1]` | Existing task сохраняет files/uncommitted/tools; environment publish snapshot `[X2]` | Несколько tasks от published environment, state раздельный `[X1][X2]` | Shell, file edits, tests, skills, MCP/connectors `[X1][X2]` | Repo skills в cloud; personal skills не синхронизируются; saved state `[X2]` | Tests/CI в task; review changed files; PR `[X1]` | «Approve for me»; environment publish review; approval policy `[X1][X4]` | ChatGPT plan; лимиты в docs не детализированы `[X1]` | Cloud telemetry в проверенных docs не описана; sandbox/approvals docs `[X3][X4]` | Публичного benchmark в проверенных docs не найдено |
| **Cursor Cloud Agents** | Per-agent VM; Firecracker microVM; отдельный AWS account; VM snapshot 30 дней `[CU2]` | Run → persist → handoff; hibernation/recycle; follow-up/steer `[CU1][CU2]` | Conversation indefinite; VM snapshot resume; Builds pre-warmed snapshot `[CU2][CU5]` | «as many agents as you want in parallel»; max 500 repos на agent `[CU1][CU7]` | Terminal, file edits, browser/desktop computer use, MCP, hooks `[CU1][CU4]` | Rules/skills/AGENTS.md; context window selectable `[CU1]` | Agent runs tests, uses computer use; artifacts/screenshots/videos attached to PR `[CU4]` | PR review; terminal commands auto-run; per-command approval в cloud не документирован `[CU3]` | Plan usage; spend limit; API default 20 req/min `[CU1][CU7]` | Artifacts, Cursor Cloud MCP diagnostics, transcripts `[CU4]` | Публичного benchmark в проверенных docs не найдено |
| **Amp** | Orb = remote machine на thread; fresh isolated env; sleep/wake preserves files/services `[A2]` | Thread может продолжать после disconnect; orb runs while work exists `[A1][A2]` | Orb sleep/wake; snapshot проекта; thread history `[A2][A3]` | Burst 20 metered orbs, затем 1 orb/5 мин; Task subagents `[A2][A4]` | Shell, file tools, Task/Read Thread subagents, Oracle/Librarian/Finder plugins, Painter `[A4][A5]` | Compaction как system model; subagents own context; plugins/custom modes `[A4][A9]` | Tests через shell; делегирование с явной передачей файлов `[A5][A7]` | По умолчанию нет approval перед tools; контроль через plugin `[A5]` | Hobby free; Megawatt $20; Gigawatt $200; orb $0.08–$2.13/ч `[A3][A6]` | Thread sharing; usage billing; публичного eval suite в проверенных docs не найдено `[A1][A6]` | Публичного benchmark в проверенных docs не найдено |
| **Antigravity** | IDE/App/CLI/SDK; terminal sandbox; subagent workspace inherit/branch/share; Turbo unsandboxed `[G2][G3][G4]` | Parallel conversations; scheduled messages; `/teamwork` milestones; `/swarm` shared board `[G1][G3]` | Отдельного checkpoint/resume в docs не описано; conversation history; idle subagent re-awaken; worktree cleanup `[G3]` | Concurrent background subagents; nesting 10; `/boost` 3-tier hierarchy `[G3]` | Browser via Chrome DevTools MCP, terminal, files, artifacts, MCP `[G2][G4][G5]` | Artifacts/plans; context summaries by first-party models `[G6][G9]` | Implementation plan review; browser recordings; `/teamwork` independent verification `[G3][G5][G7]` | deny>ask>allow; sandbox modes Request Review/Default/Auto/Turbo; approval bubbles `[G4]` | Free/Google AI plans; 5h/weekly quotas; credits overage `[G8]` | Artifacts, browser recordings; публичного eval suite в проверенных docs не найдено `[G5][G6]` | Публичного benchmark в проверенных docs не найдено |

### 3.2 Devin (Cognition)

**Архитектура и среда.**
- **[FACT]** Devin — «autonomous AI software engineer», работает через web app, Devin API и Devin CLI; workspace содержит Shell, IDE (встроенный VS Code) и Browser, плюс Interactive Browser для вмешательства человека `[D1][D2]`.
- **[FACT]** Environment описан blueprint'ом: YAML с `initialize`, `maintenance`, `knowledge`, `post-build`, `clone`. Build исполняет blueprint и клонирует репозитории; snapshot — «frozen, bootable image», из которого стартует каждая сессия. У организации один активный snapshot; изменения сессии не пишутся обратно `[D3]`.
- **[FACT]** Build lifecycle: enterprise `initialize`/`maintenance`, organization `initialize`/`maintenance`, клонирование до 10 репозиториев параллельно, repo-level шаги, `post-build`, health check, snapshot. Шаг timeout 3 часа; periodic refresh ~24 часа (macOS — неделя); pin возможен только на build моложе 7 дней `[D3]`.

**Долгая задача и параллелизм.**
- **[FACT]** Сессия имеет `status` (`new`, `claimed`, `running`, `exit`, `error`, `suspended`, `resuming`) и `status_detail` (`working`, `waiting_for_user`, `waiting_for_approval`, `finished`, `inactivity`, `usage_limit_exceeded`, `out_of_credits`, `out_of_quota`, `no_quota_allocation`, `payment_declined`, `org_usage_limit_exceeded`, `user_usage_limit_exceeded`, `total_session_limit_exceeded`, `contract_expired`, `error`) `[D5]`.
- **[FACT]** Сообщение в suspended-сессию «automatically resumed»; endpoint `POST /v3/organizations/{org_id}/sessions/{devin_id}/messages` `[D6]`.
- **[FACT]** Devin может быть координатором: запускать child sessions «each running in its own isolated VM», задавать prompts, skills, tags и ACU limits, мониторить, pause/terminate, получать completion alerts `[D7]`.
- **[FACT]** Dynamic Workflows — детерминированный Python-скрипт: `register_workflow(meta)`, `agent(prompt, phase=..., schema=...)`, `pipeline(items, stage1, stage2, ...)`, `parallel([...])`, `log("message")`. Каждый `agent()` возвращает dict по JSON Schema; `pipeline` не имеет barrier между стадиями; `parallel` — для merge/dedup `[D8]`.
- **[FACT]** По умолчанию каждый агент workflow — отдельная VM; shared-VM режим делит working tree, включая uncommitted changes, и имеет lower concurrency cap. Resume: скрипт перезапускается сверху, вызовы ключуются хешем prompt/schema/settings, завершённые replay'ятся. Бюджет run — 7 дней (default и maximum); остановка усыпляет оставшиеся child sessions `[D8]`.

**Tool surface и HITL.**
- **[FACT]** IDE takeover требует остановить сессию и pause; Shell хранит историю команд, будущие команды серые; Browser/Interactive Browser сохраняет cookies и session data; Side Chat read-only, но main session продолжает работать `[D2]`.
- **[FACT]** Computer Use даёт полный desktop: Linux/Windows/macOS, экран 1024×768, mouse/keyboard/screenshots, тестирование GUI и TUI `[D21]`.
- **[FACT]** Security profiles задают network allowlist hostnames/CIDR, MCP allowlist, git read-only/full, наличие GitHub CLI token; mandatory profile — floor, lower-level может только ужесточать; child sessions наследуют parent chain; на Outposts firewall не ставится, оператор обязан применять `spec.network_policy` `[D16]`.
- **[FACT]** Devin CLI `--sandbox` использует OS-level isolation, fail-closed (при сбое CLI «refuse to start»), Linux требует `bubblewrap` и `socat`, Windows не поддерживается; `sandbox.excluded` допускает только `Exec(...)` с `allow`/`ask`/`deny`, разрешение конфликтов — `deny > ask > allow`; network filtering помечен как unstable `[D19]`.

**Verification и стоимость.**
- **[FACT]** Testing & Video Recordings: после PR Devin запускает приложение, проходит браузерный сценарий, записывает экран с аннотациями и прикладывает видео; recording — «quick sanity check», не замена test suite/CI `[D17]`.
- **[FACT]** Stacked PRs: GitHub.com only; stack — first-class GitHub object, PR идут bottom-up, merge нижнего мержит всё ниже атомарно; Devin следит за CI и конфликтами `[D22]`.
- **[FACT]** ACU (Agent Compute Unit) отражает действия/сложность и VM time; sleep после 5 минут inactivity; Windows ~9% дороже Linux; enterprise timeout 5–120 минут `[D11]`.
- **[FACT]** Self-serve: Free $0, Pro $20/мес, Max $200/мес, Teams от $80/мес + $40/мес за full seat, до 100 members; Teams Free mode — 2 concurrent sessions на пользователя `[D12]`. **[CLAIM]** Pricing page: concurrency Free/Pro «Up to 10», Max/Teams «Unlimited» `[D13]`.
- **[FACT]** Enterprise: ACU по contract volume/order form; budgets образуют дерево org/user limits; on-demand credits отдельно от enterprise ACU `[D25]`.
- **[FACT]** Deployment: Enterprise Cloud (brain и Devbox в multi-tenant Cognition cloud, каждая сессия на isolated machine) или Customer Dedicated VPC (brain в Cognition cloud, Devbox в single-tenant VPC, AWS PrivateLink или IPSec, OpenVPN) `[D15]`.
- **[FACT]** Security: SOC 2 Type II с сентября 2024; data encrypted in transit/at rest; по умолчанию данные могут использоваться для обучения, paid plans могут opt out, Enterprise — только с письменного согласия `[D14]`.
- **[FACT]** Outposts: agent loop (inference/planning) остаётся в cloud Cognition, исполнение команд/edits/repo access — на машинах клиента; worker'ы только outbound HTTPS; N workers = N concurrent sessions; passwordless sudo рекомендован только на выделенных машинах `[D9][D10]`.

### 3.3 OpenHands (All-Hands-AI)

**Архитектура.**
- **[FACT]** Repo теперь называется Agent Canvas — self-hosted control center для coding agents и automations; frontend/control plane к OpenHands Agent Server, «REST API for running multiple agents on a single machine»; поддерживает OpenHands, Claude Code, Codex, Gemini, Pi, OpenCode и ACP-агентов; MIT `[O1]`.
- **[FACT]** SDK-пакеты: `openhands.sdk` (core), `openhands.tools`, `openhands.workspace`, `openhands.agent_server`. Компоненты: `Agent`, `Conversation`, `LLM`, `Tool System`, `Events`, `Workspace`, `Skill`, `Condenser`, `Security`. Tools исполняются «alongside the agent», а не через workspace API `[O2]`.
- **[FACT]** Agent loop одношаговый: execute pending actions → condense → LLM → parse → confirmation → execute tools. `step()` stateless, атомарный, может быть paused/resumed; состояние — event history `[O3]`.
- **[FACT]** Events — append-only typed log: `ActionEvent`, `MessageEvent`, `ObservationEvent`, `Condensation`, `CondensationRequest`, `PauseEvent`, `ConversationStateUpdateEvent`; `ActionEvent` → `ObservationEvent` strict pattern `[O3][O20]`.

**Sandbox и runtime.**
- **[FACT]** Workspace абстракция: `LocalWorkspace` — direct subprocess, process-level isolation, host access; `DockerWorkspace` — auto-spawn container, container isolation; `RemoteWorkspace` — HTTP → agent-server, container/VM-level sandbox `[O5]`.
- **[FACT]** Docker sandbox: default image `ghcr.io/openhands/agent-server:latest-python`; «complete isolation from the host system»; ports `host_port=8010/8011`, `extra_ports=True` даёт VS Code Web и VNC; WebSocket event streaming `[O6]`.
- **[FACT]** Agent Server: HTTP/WebSocket, `/health`, `/ready`, `/server_info`, `/docs`, authenticated `/api/*`, `GET /api/conversations/count`; по умолчанию unauthenticated, ключи через `OH_SESSION_API_KEYS_0`, header `X-Session-API-Key` `[O11]`.
- **[FACT]** Warm-pool deferred init: `OH_DEFERRED_INIT=true`, состояния `dormant → initializing → ready`; `POST /api/init` с `X-Init-API-Key`; до init все `/api/*` возвращают 503 `[O12]`.
- **[FACT]** Cloud API: `POST /api/v1/app-conversations`, `stream-start`, `start-tasks`, `app-conversations`; startup states `WORKING`, `WAITING_FOR_SANDBOX`, `PREPARING_REPOSITORY`, `SETTING_UP_SKILLS`, `READY`, `ERROR`; sandbox states `STARTING/RUNNING/PAUSED/ERROR/MISSING`; execution states `idle/running/paused/waiting_for_confirmation/finished/error/stuck` `[O13]`.
- **[FACT]** V1 REST: `/api/v1/app-conversations`, `/api/v1/sandboxes` (`search`, `pause`, `resume`), `/api/v1/sandbox-specs/search` `[O14]`.

**Контекст и делегирование.**
- **[FACT]** Condenser: автоматически при `event count > max_size` (default 120), manual через `CondensationRequest`; типы `NoOpCondenser`, `LLMSummarizingCondenser`, `PipelineCondenser`; `keep_first=4`, target `max_size // 2` (60); summary event хранит `forgotten_event_ids` `[O4]`.
- **[FACT]** `TaskToolSet`: subagent получает собственную conversation, работает синхронно, возвращает `TaskObservation` (`task_id`, `subagent`, `status`, response); resume по task ID сохраняет контекст; параллельность — `tool_concurrency_limit` у parent `[O8]`.
- **[FACT]** Skills: `AGENTS.md` целиком в initial system prompt; `SKILL.md` в `.agents/skills/<name>/`; keyword-trigger и path-trigger; discovery → invocation → resources; project skills override user, user override public `[O9]`.
- **[FACT]** Tools: `execute_bash`, `file_editor`, `glob`, `grep`, `finish`, `think`, `task_tracker`, `BashTool`; MCP tools обходят registry и добавляются в tool map `[O10]`.
- **[FACT]** Прежние «microagents» заменены Skills: legacy-каталоги `.openhands/skills/` и `.openhands/microagents/` ещё поддерживаются, но приоритет у `.agents/skills/`; в проверенном индексе docs (`llms.txt`) отдельной страницы «microagents» нет `[O9][O21]`.

**Security, verification, стоимость.**
- **[FACT]** Security analyzer: `LLMSecurityAnalyzer` добавляет обязательный `security_risk` в schema каждого tool; risk LOW («read-only»), MEDIUM («modifies user data»), HIGH («dangerous operations»), UNKNOWN; default `ConfirmRisky` threshold HIGH, `confirm_unknown=True` `[O7]`.
- **[FACT]** Hooks: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`; `PreToolUse`/`UserPromptSubmit`/`Stop` могут блокировать; `Stop` hook может «force the agent to keep working if linting checks haven't passed yet»; exit code 2 или JSON `{"decision":"deny"}` `[O18]`.
- **[FACT]** Critic (experimental): score 0.0–1.0, `success = score >= 0.5`, real-time feedback и iterative refinement; автоматически конфигурируется при OpenHands LLM Provider `[O19]`.
- **[FACT]** Paper: каждая task session — isolated Docker container; внутри sandbox REST API, bash, Jupyter IPython, Chromium через Playwright/BrowserGym; arbitrary Docker images; workspace монтируется. 15 бенчмарков. SWE-bench Lite (300): CodeActAgent v1.8 + Claude 3.5 Sonnet — 26.0%, GPT-4o — 22.0%; HumanEvalFix Python 79.3% `[O15]`.
- **[FACT]** Blog (17 Apr 2025): 60.6% SWE-bench Verified single rollout → 66.4% с 5 attempts и обученным critic (Qwen 2.5 Coder 32B, TD learning, γ=0.99) `[O16]`.
- **[FACT]** Pricing: Agent Canvas Free (MIT, self-host, BYO LLM); Teams $500/мес до 10 users (+$50/мес за seat), cap 5000 sessions/мес; Enterprise custom, uncapped `[O17]`.

### 3.4 SWE-agent и mini-SWE-agent

**Архитектура и ACI.**
- **[FACT]** SWE-agent — LM-powered coding agent, NeurIPS 2024, Princeton/Stanford, MIT; «takes a GitHub issue and tries to automatically fix it»; конфигурация — один YAML; «leaves maximal agency to the LM» `[S1]`.
- **[FACT]** Paper: ACI (agent-computer interface) — специализированный интерфейс для LM как нового класса пользователей. SWE-bench full (2294): 12.47% GPT-4 Turbo, 10.46% Claude 3 Opus; SWE-bench Lite (300): 18.00% / 13.00%; HumanEvalFix pass@1: Python 87.7, JavaScript 89.7, Java 87.9 `[S3]`.
- **[FACT]** Ablations на SWE-bench Lite: full config 18.0%; edit без линтера 15.0%; без edit action 10.3%; iterative search 12.0%; summarized search 18.0%; file viewer 30 строк 14.3%, full file 12.7%; full history 15.0%; last-5 observations 18.0%; без demonstration 16.3% `[S3]`.
- **[FACT]** ACI-механики: линтер не пропускает синтаксически неверный edit; file viewer показывает 100 строк за turn, со scroll и search; поиск выдаёт список файлов, а не контекст совпадений; пустой output нормализуется в «Your command ran successfully and did not produce any output» `[S4]`.
- **[FACT]** Architecture: `sweagent` CLI → `SWEEnv` (thin wrapper над SWE-ReX) → deployment (local Docker или remote Modal/AWS) → `Agent.forward()` → parser → `env.communicate()`; history сжимается `HistoryProcessor` `[S5]`.
- **[FACT]** Config: `agent.templates` (system/instance/next_step/next_step_no_output), `agent.tools.bundles[].path`, `agent.tools.enable_bash_tool`, `agent.history_processors[].type`; default `cache_control` с `last_n_messages: 2` `[S6]`.
- **[FACT]** Tools: `bash`, `filemap`, `_state`; tool bundles — папки с `bin/`, `config.yaml`, `install.sh`; state command возвращает JSON для шаблонов `[S12]`.
- **[FACT]** Agent reference: `DefaultAgent.run(env, problem_statement, output_dir)` → `step()` до `done`; `handle_submission` читает `/root/model.patch`; `exit` останавливает; ошибки/timeout/context/cost могут autosubmit; `max_requeries=3`; `RetryAgent` cost limit `1.1 * cost_limit` `[S8]`.
- **[FACT]** Environments: Docker image `python:3.11` по умолчанию, SWE-bench images из Docker Hub, `--env.deployment.image`; remote deployment через SWE-ReX `[S5][S13]`.
- **[FACT]** Batch: `sweagent run-batch --config config/default.yaml --agent.model.name ... --agent.model.per_instance_cost_limit 2.00 --instances...`; параллельные инстансы, `.traj` files, `sweagent inspect` и web inspector `[S10][S11]`.
- **[FACT]** Paper фиксирует среднюю стоимость инстанса: SWE-agent + GPT-4 Turbo — $1.59 на full и $1.67 на Lite; Claude 3 Opus — $2.59 и $2.18 соответственно `[S3]`.
- **[FACT]** Changelog 1.0.0 (2025-02-13): SWE-ReX parallel/cloud execution, configurable retries, tool bundles, litellm, new CLI, trajectory inspector, pydantic config, Jinja2. 1.1.0 (2025-05-22): SWE-smith, multilingual/multimodal, breaking `query` вместо `messages` `[S9]`.
- **[FACT]** SWE-agent переведён в maintenance-only; mini-swe-agent объявлен заменой с сопоставимой производительностью `[S1][S16]`.

**mini-SWE-agent.**
- **[FACT]** Около 100 строк на agent class; только bash; не использует tool-calling interface; `subprocess.run` для каждого action, actions независимы, нет persistent shell; полностью линейная history `[S14][S15]`.
- **[FACT]** Environments: local, docker/podman, singularity/apptainer, bubblewrap, contree; models через LiteLLM/OpenRouter/Portkey, `/completion` и `/response`; v2, migration guide `[S14][S15]`.
- **[CLAIM]** README: «>74% on SWE-bench verified»; «beats Claude Code and Codex on DeepSWE»; используется Meta, NVIDIA, Essential AI, IBM, Nebius, Anyscale, Princeton, Stanford `[S14]`.

### 3.5 Factory Droid

**Архитектура и sandbox.**
- **[FACT]** Droid — единый агент в Factory App, Droid CLI и Web/Mobile; «runs the same everywhere»; cloud session sync и Droid Computers дают browser access; Workstreams — orchestrator + team of agents; Missions — крупные workflows; Enterprise — deployment/security/identity/telemetry `[F1]`.
- **[FACT]** Sandbox: OS-level, kernel-enforced. macOS — Seatbelt; Linux/WSL2 — bubblewrap + seccomp. Egress через HTTP/SOCKS filtering proxy, allowlist доменов; Factory/WorkOS домены всегда разрешены `[F2]`.
- **[FACT]** Два режима: default `per-command` (sandbox только shell и children, main Droid process не изолирован) и `whole-process` (весь Droid; при сбое isolation «refuses to start rather than running unsandboxed»). File reads broadly allowed кроме `denyRead`; writes deny-all-except-CWD; `denyWrite` overrides `allowWrite`; org denies cannot be removed downstream `[F2]`.
- **[FACT]** Enforcement: file tools проверяются per operation; shell — в OS sandbox; `FetchUrl`/`WebSearch` — по allowed domains; MCP requests проверяются; delegated subagents inherit parent policy; hooks wrapped; «Tools whose actions can't be checked are blocked»; interactive violations interrupt even at Auto (High), `droid exec` violations auto-denied `[F2]`.
- **[FACT]** Ограничение: «allowed network egress can still leak data»; sandbox — «defense in depth, not a hard boundary around untrusted code»; для untrusted code рекомендуется container/VM `[F2]`.

**Missions, Workstreams, Droid Computers.**
- **[FACT]** Missions: structured workflow для large multi-feature work; plan с features, milestones, skills; Mission Mode после approval; Mission Control управляет исполнением; Droid runs user-facing QA и self-corrects; «not fire-and-forget» — при проблемах нужно pause orchestrator и описать проблему; sweet spot 1–500 features `[F5]`.
- **[FACT]** Missions reference: headless `droid exec --mission`; `--worker-model`, `--worker-reasoning-effort`, `--validator-model`, `--validator-reasoning-effort`; `missionModelSettings.workerModel`, `validationWorkerModel`, `skipScrutiny`, `skipUserTesting`, `missionOrchestratorModel`, `keepSystemAwakeDuringMissions`; enterprise `missionPolicy.restrictedAccess` + `allowedUserIds` `[F6]`.
- **[FACT]** Workstreams (beta): orchestrator — «lead session you talk to»; parallel agents each own one piece и open PRs; users can message any agent; shared documents в Files; available on Pro/Plus/Max/Teams, not Business/Enterprise; «use more tokens than a single session» `[F7]`.
- **[FACT]** Droid Computers: Factory-hosted persistent machines; installed packages/files/services/config persist between sessions; auto-pause idle, auto-resume; inbound only daemon port, root/password auth disabled, SSH via tunnel; `factory-user` имеет passwordless sudo и может менять правила; parallel sessions share CPU/memory/disk, Droid told to use separate git worktrees; pool batch 1–20; per-machine workers default 3, range 1–50, recommended 3–5; slot held 30 минут после idle `[F8]`.

**Autonomy, verification, enterprise, cost.**
- **[FACT]** Auto-run tiers: Off — read tools/policy-allowed commands; Low — file edits + low-risk commands/MCP; Medium — Low + reversible workspace changes; High — high-risk actions unless safety checks require approval. `permissionRules` matching exact ordered args; blocks > approval > allows; Spec Mode read-only planning `[F3]`.
- **[FACT]** Droid Shield: scans added diff lines before `git commit`/`git push`, blocks on detected API keys/tokens/credentials/private keys; enabled by default; only Droid-run git operations; limitations — custom/obfuscated secrets, business logic; 2.0 semantic layer private preview `[F4]`.
- **[FACT]** Enterprise: Droid CLI runs locally, shell/file edits local; no wholesale repo upload/index; prompts/context follow model/gateway; org policy governs models, MCP, hooks, plugins, sandboxing, retention; OTel metrics + hosted analytics + audit events; SAML/OIDC SSO, SCIM, roles, service accounts `[F11][F12]`.
- **[FACT]** Identity: WorkOS, domain verification mandatory for SSO, SCIM, roles User/Manager/Owner, service accounts with API keys, service accounts «never inherit organization OAuth credentials for source control» `[F12]`.
- **[FACT]** Audit log: Enterprise owners only; actor/source/target/payload/ISO timestamp; categories usage limits, membership, API keys, service accounts, integrations, org lifecycle, managed settings, analytics; retention/export/API не описаны `[F13]`.
- **[FACT]** Deployment: Factory Managed или Factory Private (часть инфраструктуры в VPC, sandboxes через OpenCompute, control plane Factory-hosted; Private Preview); EU dedicated deployment; airgapped — «needs none of these hosts» `[F14]`.
- **[FACT]** Airgap: Enterprise-only binaries, at least one custom model иначе Droid не стартует turn; no Factory services; only BYOK endpoints; Factory Router недоступен; updates через artifact repository; telemetry только в свой collector `[F15]`.
- **[FACT]** Pricing individuals: Pro $20, Plus $100, Max $200; три rolling windows 5h/7d/30d независимо; Droid Core — free open-weight pool с отдельными лимитами; extra usage — prepaid credits, $10 minimum, no expiration; Missions требуют Extra Usage и pause при limit `[F16]`.
- **[FACT]** Pricing organizations: Teams $60/мес + $40/seat, до 10 seats, Pro rate limits; Business custom; Enterprise custom, unlimited seats, dedicated compute/partitioned inference/on-prem/data residency/sub-orgs/SSO/SAML/SCIM/ZDR/audit `[F17]`.
- **[FACT]** Agent Effectiveness: throughput, output, attribution, session intents, friction, expertise; Analytics API — Standard Credits, tool usage, user activity, productivity, per-user metrics; OTel export `[F22]`.

**Бенчмарки (вендорские).**
- **[CLAIM]** Terminal-Bench 2.0, last updated Dec 2025: Factory Droid 63.1%, OpenAI Codex CLI 60.4%, Warp 59.1%, OpenHands 43.8%, Claude Code 40.1%; five task areas: code navigation, bug fixing, feature implementation, refactoring, testing `[F18]`.
- **[CLAIM]** Agent Arena (Design Arena), Dec 2025: Droid Elo 1330, Codex 1301, Devin 1263, Claude Code 1242, Cursor 1120, Gemini CLI 937; human side-by-side, Bradley-Terry Elo `[F19]`.
- **[CLAIM]** Next.js evals: Droid (GPT-5.2) 66%, Droid (Opus 4.5) 56%, Droid (Sonnet 4.5) 50%, Droid (Gemini 3 Pro) 46%, Claude Code (Opus 4.5) 42%, Cursor (Sonnet 4.5) 38%; Dec 2025 `[F20]`.
- **[CLAIM]** Review Benchmark: 13 models, 50 PRs из Sentry/Grafana/Keycloak/Discourse/Cal.com, 167 validated bugs; mean F1 GPT-5.2 60.5% при $1.25/PR, Opus 4.6 59.8% при $3.11/PR `[F21]`.

### 3.6 Смежные продукты (дополнительный срез)

**GitHub Copilot coding agent.**
- **[FACT]** Три части: client/surface, session, environment. Environment — cloud sandbox, GitHub Actions или remote custom. Actions — repo-bound; cloud sandbox — multi-repo в пределах org, но без custom compute/Actions-specific setup/self-hosted runners `[C1]`.
- **[FACT]** Actions session: max execution 59 минут, «cannot be extended or bypassed»; один branch и один PR на task; Copilot работает только с GitHub-hosted repos. Agent Merge может watch/fix failed workflows и merge conflicts `[C1]`.
- **[FACT]** Firewall: default limited; allowlist package repos/registries/CAs/Playwright; blocked request даёт PR warning с address и командой; применяется только к процессам, запущенным через Bash tool; не покрывает MCP server processes и setup steps; «sophisticated attacks may bypass»; не является comprehensive security solution `[C2]`.
- **[FACT]** Setup steps: `.github/workflows/copilot-setup-steps.yml`, один job `copilot-setup-steps`, должен быть на default branch, настраиваемые ключи `steps`/`permissions`/`runs-on`/`services`/`snapshot`/`timeout-minutes` (max 59); Ubuntu x64/Windows 64 only; firewall несовместим с self-hosted runners и Windows `[C3]`.
- **[FACT]** MCP: repo Settings → Copilot → MCP servers, JSON `mcpServers`; GitHub MCP и Playwright MCP включены по умолчанию; обязательны `tools` и `type` (`local`/`stdio`/`http`/`sse`); `*` разрешает все tools; secrets только с префиксом `COPILOT_MCP_`; remote OAuth не поддерживается `[C4]`.

**OpenAI Codex Cloud.**
- **[FACT]** Cloud task: собственный workspace, продолжает работу при спящем компьютере; published environment переиспользует repos/deps/tools, но working state каждой task отдельный; existing task сохраняет свои files/uncommitted/tools; repository refresh идёт в фоне `[X1][X2]`.
- **[FACT]** Environment: install script + start skill; network access настраивается (public internet, package-manager domains, additional domains); HTTP secrets/env vars/OIDC/VPN; secrets для cloud environments доступны только во время setup и удаляются перед agent phase (legacy) `[X1][X2][X4]`.
- **[FACT]** Legacy internet: default blocked; setup scripts имеют internet; modes Off/On; allowlist presets None/Common dependencies/All; HTTP methods GET/HEAD/OPTIONS, остальные blocked. Риски: prompt injection, code/secret exfiltration, malware, license restrictions `[X5]`.
- **[FACT]** Local sandbox: macOS Seatbelt, Linux/WSL2 bubblewrap, Windows native sandbox; default no network and writes limited to workspace; approval policy — отдельный слой; `on-request` разрешает sandbox-allowed commands без approval `[X3][X4]`.
- **[FACT]** Current cloud limitations: no computer use, no self-hosted GitHub Enterprise Server, personal skills не синхронизируются `[X2]`.

**Cursor Cloud Agents.**
- **[FACT]** Cloud agent — isolated VM в Cursor cloud с cloned repo, dependencies, secrets, network; запускается из iOS/Web/Desktop/Slack/GitHub/Bitbucket/Linear/API; multi-repo; «run as many agents as you want in parallel» `[CU1]`.
- **[FACT]** Security: per-agent VM, Firecracker microVM, отдельный AWS account, Cursor employees не имеют доступа к коду внутри VM; TLS 1.2+, AES-256, per-agent keys, CMEK/BYOK для Enterprise; VM snapshots 30 дней inactivity, conversation history indefinitely by default `[CU2]`.
- **[FACT]** Network: internet default on; egress controls per user/team/environment; runtime secrets redacted from tool results/transcript/commits, но видны через Terminal; build secrets только в Docker build; signed commits HSM-backed Ed25519; OIDC tokens `[CU3]`.
- **[FACT]** Agent auto-runs all terminal commands, в отличие от foreground agent; docs прямо предупреждают о prompt injection/exfiltration риске `[CU3]`.
- **[FACT]** Builds: bootable snapshot среды; triggers recurring/config change/manual/agent-requested; failed build не заменяет last successful; pre-warmed copies; self-hosted machines builds не используют `[CU5]`.
- **[FACT]** Self-Hosted Machines: agent loop/inference/planning в Cursor, file edits/terminal/computer-use/local MCP — на машине клиента; outbound HTTPS only, no inbound ports; up to 10,000 workers per user/team `[CU6]`.
- **[FACT]** API: create agent, list/get, follow-up/steer, list runs; `agentId` для идемпотентного create (`409 agent_id_conflict`), max 500 repos, max 50 env vars; default rate limit 20 req/min `[CU7]`.
- **[FACT]** Local agent checkpoints: snapshots before significant changes, restore files only, stored locally separate from Git `[CU8]`.

**Sourcegraph Amp.**
- **[FACT]** Orb — remote machine на thread, fresh isolated environment с кодом/tools/plugins; idle orb засыпает и «costs nothing», wake сохраняет conversation/files/services; each user can start burst of 20 metered orbs, затем one new orb every five minutes `[A2]`.
- **[FACT]** Orb sizes: `a1.tiny` 1 CPU/2 GB/$0.08/ч … `a1.3xlarge` 16 CPU/44 GB/$2.13/ч; 60 GB disk; billing per minute; pause когда agent не работал 5 минут и user не взаимодействовал 20 минут `[A3]`.
- **[FACT]** Modes: `low`, `medium`, `high`, `ultra` — model + reasoning effort + system prompt + tools; subagents — Task и Read Thread, same model/effort, separate context, cannot communicate, main agent receives final summary only `[A4][A9]`.
- **[FACT]** Tools: shell commands, Task subagents, Oracle (review, never edits), Librarian (clones external repos в `/tmp`), Finder (workspace search with line ranges), Painter; no approval before tools by default; control via custom plugin `[A5]`.
- **[FACT]** Agent-to-agent: each new thread has own conversation/context/working copy/orb; uncommitted files not shared; explicit transfer required `[A7]`.
- **[FACT]** Self-hosted orbs: `amp orb provider ./dispatch.sh`, provider connects outbound to Amp, receives `spawn`/`pause`/`delete`, starts `amp orb bootstrap` inside orb; no inbound ports `[A8]`.
- **[FACT]** Pricing: Hobby free; Megawatt $20/мес; Gigawatt $200/мес; Teams без доплаты; Enterprise custom; credits expire 12 months; self-hosted orbs free для individuals/teams `[A6]`.

**Google Antigravity.**
- **[FACT]** Surfaces: Antigravity IDE (agent manager, artifacts, codebase understanding), Antigravity App (command center для multiple local agents, Projects, scheduled messages), Antigravity CLI (terminal-first, background subagents), Antigravity SDK (Python prototype/eval); browser-in-the-loop agents `[G1][G11]`.
- **[FACT]** Agent: multi-step reasoning, frontier LLM, tools incl. browser, artifacts, knowledge, customizations; можно запускать несколько conversations параллельно `[G2]`.
- **[FACT]** Subagents: `invoke_subagent`, concurrent background subagents; built-ins `research`, `browser`, `self`; workspace modes `inherit`/`branch` (isolated git worktree)/`share`; subagent не наследует parent conversation history, но наследует command prefixes, file scopes, sandbox settings; states running/idle/killed; nesting cap 10; typo tool name может повесить subagent `[G3]`.
- **[FACT]** Teamwork: `/boost` — трёхуровневая иерархия Orchestrator → DeepCoder/DeepInvestigator → isolated workers; `/teamwork` — milestone decomposition, parallel implementation, independent verification; `/swarm` — shared message board, idle workers не тратят tokens `[G3]`.
- **[FACT]** Permissions: `action(target)` против deny/ask/allow; приоритет Deny > Ask > Allow; workspace read/write без prompt; web и MCP default Ask; sandbox modes Request Review (disabled), Default (enabled, no network), Auto (sandbox with checked outside commands), Turbo (disabled, full FS); `read_url` domains компилируются в outbound allowlist `[G4]`.
- **[FACT]** Browser: `/browser` запускает subagent, который управляет локальным Chrome через Chrome DevTools MCP server (`npx`), remote debugging; screenshots и WebM recordings; JavaScript execution policy и actuation rules `[G5]`.
- **[FACT]** Artifacts: implementation plan, walkthrough, visual screenshots, browser recordings, interactive HTML; plan review с комментариями и `Proceed`; CLI review panel `[G6][G7]`.
- **[FACT]** Enterprise: Gemini Enterprise, hybrid execution — при выборе Claude Opus/Sonnet 5.5 third-party model выполняет primary reasoning/planning/tool orchestration/codegen, а lightweight first-party Gemini — context management/summaries (токены тарифицируются); HITL confirmation; regional endpoints, network allowlists, PSC `[G9]`.
- **[FACT]** Plans: baseline quota доступен на всех планах; quota и доступность моделей зависят от Google AI плана; Google AI Pro/Ultra — 5-часовые квоты и weekly limits; AI credits для overage `[G8][G10]`. **[CLAIM]** Product page: «Available at no charge» для разработчиков `[G1]`.
- **[FACT]** Models: Gemini 4 Carbon/Argon, Gemini 3.8/3.7/3.6 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus 5.5 (Thinking), GPT-OSS 120B; thinking levels Low/Medium/High; доступность зависит от плана `[G10]`.

### 3.7 Режимы отказа, зафиксированные источниками

| Продукт | Что источник называет режимом отказа | Источник |
|---|---|---|
| Devin | повторные session limits как сигнал слишком сложной задачи; проблемы dev environment; video recording не заменяет CI; login walls/VPN мешают тесту; workflow-скрипт ломается при time/random/env/filesystem/network dependencies | `[D17][D18][D8]` |
| OpenHands | превышение context window → `CondensationRequest`; cloud execution state `stuck`; unauthenticated Agent Server даёт исполнение команд; `async: true` hooks не могут блокировать | `[O3][O13][O11][O18]` |
| SWE-agent | timeout/context/cost/API/environment/repeated format/blocklist/syntax errors ведут к autosubmit и остановке; нет `max_steps`; ACI-эффекты зависят от модели/benchmark | `[S8][S3]` |
| mini-SWE-agent | нет custom tools и persistent shell; линейная history без history processors; нет встроенного verification/approval | `[S14][S15]` |
| Factory Droid | allowed egress может утекать данные; uncheckable tools блокируются; non-interactive violations auto-denied; Missions требуют ручного вмешательства при проблемах | `[F2][F5]` |
| Copilot coding agent | firewall можно обойти sophisticated attack; не покрывает MCP/setup; Actions session обрывается на 59 минутах | `[C1][C2]` |
| Codex Cloud | prompt injection/exfiltration/malware/licence risks при internet; нет computer use; personal skills не синхронизируются | `[X2][X5]` |
| Cursor Cloud Agents | auto-run всех terminal-команд + internet default on создают exfiltration risk; VM recycling после idle | `[CU2][CU3]` |
| Amp | burst 20 orbs, затем ожидание 1 orb/5 мин; orb засыпает и не держит dev server; subagents не координируются | `[A2][A3][A4]` |
| Antigravity | typo в tool name может повесить subagent; Turbo отключает sandbox; hybrid execution тратит first-party tokens | `[G3][G4][G9]` |

## 4. Gaps, risks, weaknesses

Ниже — наблюдения о конкурентах; это не оценка ZCode. Все `[ID]` относятся к источникам, открытым 2026-11-11 (URL в разделе 8). Пункты `[FACT]` цитируют ограничение из источника; пункты `[HYPOTHESIS]` — следствия, которые источник прямо не утверждает.

### 4.1 Devin
- **[FACT]** Жёсткая зависимость от качества environment: docs прямо называют проблемы dev environment и повторные session limits признаками слишком сложной задачи; рекомендуют дробить и пересобирать Workspace `[D18]`. **[HYPOTHESIS]** Это переносит значительную часть надёжности на blueprint build, а не на агент.
- **[FACT]** Snapshot модели «one active snapshot per org» и «session changes don't persist back» `[D3]` означают, что конкурент платит за предсказуемость ценой потери ad-hoc состояния между сессиями; **[HYPOTHESIS]** долгие эксперименты требуют blueprints/knowledge, а не просто работы в VM.
- **[FACT]** Dynamic Workflows требуют детерминированного скрипта: нельзя использовать time/random/generated IDs/env/filesystem/network responses; изменение prompt reruns agent и downstream `[D8]`. Это мощная, но хрупкая модель для агентной оркестрации.
- **[FACT]** Resume у workflows replay'ит завершённые вызовы по хешу; нет документированной идемпотентности session message endpoint, только auto-resume `[D6][D8]`. Повторная отправка сообщения может быть небезопасна без внешнего idempotency layer.
- **[FACT]** Outposts переносит на клиента provisioning, isolation, access control, capacity, monitoring и recovery; passwordless sudo рекомендуется только на выделенных машинах `[D9]`. Это высокая операционная цена «self-hosted».
- **[FACT]** Security profiles на Outposts не ставят firewall; оператор обязан сам применять `spec.network_policy` `[D16]`. Документированная граница безопасности зависит от реализации клиента.
- **[CLAIM]** Pricing-страница заявляет «Up to 10» concurrency для Free/Pro и «Unlimited» для Max/Teams `[D13]`, но не раскрывает, как concurrency сочетается с ACU-бюджетами и child sessions; фактическая пропускная способность не верифицируется по docs.
- **[UNKNOWN]** Публичного benchmark и воспроизводимого eval-набора Devin в официальных docs не найдено. Agent Arena 1263 — сторонний вендорский рейтинг `[F19]`, не primary-доказательство возможностей.

### 4.2 OpenHands
- **[FACT]** LocalWorkspace даёт host system access, process-level isolation; Docker sandbox рекомендуется для ноутбуков, но не является единственным режимом `[O1][O5]`. **[HYPOTHESIS]** Неверная конфигурация backend'а превращает «sandbox» в прямой доступ к файлам.
- **[FACT]** Agent Server по умолчанию unauthenticated; docs предупреждают, что такой сервер может исполнять команды и читать/писать workspace, и требуют keys/TLS/private network/CORS `[O11]`. Это security-риск конфигурации, а не дефект sandbox.
- **[FACT]** Condenser заменяет середину истории summary; `forgotten_event_ids` сохраняются, но детали теряются, а `max_size=120` — эвристика по числу событий, не по токенам `[O4]`. Для длинных задач возможна потеря причинно-важных деталей.
- **[FACT]** Subagents в `TaskToolSet` синхронны для одного вызова; параллельность только через `tool_concurrency_limit`, а результаты возвращаются как `TaskObservation` `[O8]`. Нет документированного scheduler'а с приоритетами/квотами.
- **[FACT]** Docker sandbox docs не описывают CPU/memory/disk limits и bind-mount конфигурацию `[O6]`; изоляция есть, resource governance не документирован.
- **[FACT]** Security analyzer с LLM рискует быть недетерминированным: риск приходит в tool arguments, `NoOpSecurityAnalyzer` всегда UNKNOWN, `ConfirmRisky` по умолчанию требует confirmation для UNKNOWN `[O7]`. **[HYPOTHESIS]** Это может как блокировать полезные действия, так и создавать ложное чувство контроля.
- **[FACT]** Hooks с `async: true` «can never block» `[O18]`; quality gate, реализованный асинхронно, не гарантирует остановку.
- **[FACT]** Бенчмарк-числа разнесены по paper и blog и относятся к разным версиям/подходам: Lite 26.0% (CodeActAgent v1.8, Claude 3.5 Sonnet) и Verified 66.4% (5 attempts + critic) `[O15][O16]`. Их нельзя сравнивать напрямую.

### 4.3 SWE-agent и mini-SWE-agent
- **[FACT]** SWE-agent maintenance-only; development переключён на mini `[S1][S16]`. **[HYPOTHESIS]** Это риск для продуктов, строящих долгую стратегию на полном ACI-стеке.
- **[FACT]** ACI-абляции показывают сильную чувствительность к интерфейсу: без edit action −7.7 п.п., iterative search −6.0, full history −3.0, full-file viewer −5.3 на SWE-bench Lite `[S3]`. **[HYPOTHESIS]** Механики ACI — не универсальный рецепт, а подгонка под конкретный benchmark/модель.
- **[FACT]** mini-SWE-agent сознательно отказывается от persistent shell и tool-calling interface; каждый action независим `[S14]`. Это упрощает sandbox/масштабирование, но лишает stateful-сессию и тонкие tool contracts.
- **[FACT]** В `DefaultAgent` нет `max_steps`; остановка — submission, exit, ошибки, timeout, context/cost, repeated format/blocklist/syntax errors; correction attempts ограничены `max_requeries=3` `[S8]`. Долгая задача без внешнего watchdog может закончиться autosubmit'ом.
- **[FACT]** Docs batch mode и environments не покрывают resource limits, network isolation и multi-tenant scheduling; это research harness, а не production control plane `[S10][S13]`.
- **[CLAIM]** «>74% on SWE-bench verified» и «beats Claude Code and Codex on DeepSWE» — README-заявления без воспроизводимого протокола в docs `[S14]`.

### 4.4 Factory Droid
- **[FACT]** Sandbox — defense in depth, не hard boundary; allowed egress может утекать данные; writable paths могут меняться; для untrusted code рекомендованы container/VM `[F2]`. Продукт сам ограничивает гарантии.
- **[FACT]** В `per-command` режиме main Droid process не изолирован; `whole-process` — opt-in `[F2]`. **[HYPOTHESIS]** Дефолт оставляет process-level поверхность атаки.
- **[FACT]** Droid Shield — detection tool, не guarantee; не ловит custom/obfuscated secrets и business-logic уязвимости; сканирует только git-операции через Droid `[F4]`.
- **[FACT]** Missions «not fire-and-forget»: при проблемах нужно pause orchestrator и вручную описывать проблему; sweet spot 1–500 features; за пределами — дробить `[F5]`. Автономность ограничена оператором.
- **[FACT]** Workstreams — beta, недоступны на Business/Enterprise, «use more tokens than a single session» `[F7]`. Корпоративная аудитория не получает этот механизм.
- **[FACT]** Droid Computers: parallel sessions share CPU/memory/disk; `factory-user` имеет passwordless sudo и может менять firewall-правила; 30-минутный slot после idle `[F8]`. Это удобно, но ослабляет изоляцию между сессиями.
- **[FACT]** Audit log доступен только Enterprise owners; retention/export/API не описаны `[F13]`. Для compliance-сценариев это неполный контроль.
- **[CLAIM]** Factory Router обещает «63% aggregate cost savings» и «99.9%+» reliability `[F10]`; методика и baseline не раскрыты.
- **[CLAIM]** Все бенчмарки Factory — вендорские страницы; Terminal-Bench 2.0, Agent Arena, Next.js и Review Benchmark опубликованы самой Factory `[F18]–[F21]`. Независимого воспроизведения в проверенных источниках нет.

### 4.5 Смежные продукты
- **[FACT]** Copilot: Actions session жёстко ограничена 59 минутами; один branch/один PR; repo-bound в Actions `[C1]`. Firewall не покрывает MCP processes/setup steps и может быть обойдён `[C2]`.
- **[FACT]** Codex Cloud: legacy internet default blocked, но setup имеет network; риски prompt injection/exfiltration/malware/license; current cloud ограничен — no computer use, no self-hosted GHES, personal skills не синхронизируются `[X2][X5]`.
- **[FACT]** Cursor: cloud agent auto-runs all terminal commands и имеет internet по умолчанию; docs прямо называют data exfiltration risk `[CU3]`. Runtime secrets видны через Terminal, хотя redacted в transcript `[CU3]`.
- **[FACT]** Cursor: VM snapshots удаляются через 30 дней inactivity; conversation history хранится indefinitely by default; кастомные retention windows — early access Enterprise `[CU2][CU3]`.
- **[FACT]** Amp: по умолчанию нет approval перед tools; контроль только через custom plugin `[A5]`. Orbs стоят денег per minute, а burst ограничен 20 metered orbs `[A2][A3]`.
- **[FACT]** Antigravity: Turbo отключает sandbox и даёт full filesystem/unrestricted terminal `[G4]`; typo в tool name может повесить subagent `[G3]`; hybrid execution с третьим-party Claude тратит first-party Gemini tokens на фоновую координацию `[G9]`.
- **[UNKNOWN]** У Copilot, Codex Cloud, Cursor, Amp и Antigravity не найдено официальных воспроизводимых benchmark-страниц; отсутствие числа не означает отсутствие возможностей.

## 5. Strengths and differentiators

Все `[ID]` — источники, открытые 2026-11-11; полные URL в разделе 8.

### 5.1 Devin
- **[FACT]** Самая полная документированная модель «cloud VM + frozen snapshot + blueprint build»: environment как воспроизводимый артефакт, а не как побочный результат сессии `[D3]`.
- **[FACT]** Сильный параллелизм на уровне продукта: coordinator/child sessions на отдельных VM, dynamic workflows с fan-out/pipeline/parallel и resume по run ID `[D7][D8]`.
- **[FACT]** Хорошо описанный HITL: Interactive Browser, IDE takeover после pause, read-only Side Chat, security profiles с mandatory floor `[D2][D16]`.
- **[FACT]** Verification как продуктовый артефакт: видео-запись пользовательского сценария после PR, stacked PRs, Session Insights `[D17][D22][D23]`.
- **[FACT]** Enterprise-развилка Cloud/VPC/Outposts с явным разделением brain и execution `[D15][D9]`.

### 5.2 OpenHands
- **[FACT]** Самая прозрачная OSS-архитектура: event-sourced agent loop, typed events, workspace abstraction, Docker/Apptainer/remote sandboxes, Agent Server API `[O2][O3][O5][O11]`.
- **[FACT]** Condenser с явными параметрами (`max_size`, `keep_first`, target) и типами (`NoOp`, `LLMSummarizing`, `Pipeline`) — редкая для рынка документированная стратегия контекста `[O4]`.
- **[FACT]** Делегирование с сохранением conversation subagent'а и resume по task ID `[O8]`.
- **[FACT]** Hooks как enforceable quality gate: `Stop` hook может не дать агенту завершиться, пока lint/test не прошли `[O18]`.
- **[FACT]** Critic с калиброванной вероятностью успеха и iterative refinement, плюс опубликованный paper/blog с методикой `[O16][O19]`.
- **[FACT]** Гибкая deployment-модель: local, Docker, Apptainer, API sandbox, cloud workspace, warm pool `[O5][O6][O12]`.

### 5.3 SWE-agent / mini-SWE-agent
- **[FACT]** ACI как научная гипотеза с абляциями: линтер, file viewer 100 строк, summarized search, last-5 observations дают измеримый вклад `[S3][S4]`.
- **[FACT]** Максимальная прозрачность trajectory: `.traj` на каждом шаге, CLI/web inspector `[S8][S11]`.
- **[FACT]** Research-grade конфигурируемость: YAML, tool bundles, history processors, model classes (`HumanModel`, `ReplayModel`) `[S6][S7]`.
- **[FACT]** mini-SWE-agent — радикальная простота: 100 строк, только bash, линейная history, лёгкий перенос в любой sandbox `[S14]`.
- **[FACT]** Дешёвый batch-параллелизм: `run-batch` с per-instance cost limit `[S10]`.

### 5.4 Factory Droid
- **[FACT]** Sandbox с kernel-enforced политиками и egress proxy, `denyWrite` overrides `allowWrite`, org denies cannot be removed downstream `[F2]`.
- **[FACT]** Missions как продуктовая надстройка над долгой задачей: plan → milestones → Mission Control → user-facing QA, с validator model и headless-флагами `[F5][F6]`.
- **[FACT]** Workstreams: orchestrator + parallel agents + PR handoff, с возможностью писать любому агенту `[F7]`.
- **[FACT]** Droid Computers: persistent state, auto-pause/resume, tunnel SSH, pool 1–20, parallel workers `[F8]`.
- **[FACT]** Enterprise-контур: airgap, BYOK-only, OTel-only telemetry, SSO/SCIM, audit, EU deployment, Factory Private `[F14][F15][F12][F13]`.
- **[FACT]** Model independence: Factory Router per-task routing + BYOK, provider failover `[F10]`.
- **[FACT]** Сильная культура измерения: Agent Effectiveness (throughput/output/attribution/friction) и несколько публичных benchmark-страниц `[F22][F18]–[F21]`.

### 5.5 Смежные продукты
- **[FACT]** Copilot: PR-native flow, branch protection, Agent Merge, GitHub MCP/Playwright MCP по умолчанию, firewall с PR-warning `[C1][C2][C4]`.
- **[FACT]** Codex Cloud: published environments, saved state каждой task, setup script + start skill, двухфазный legacy runtime `[X1][X2][X4]`.
- **[FACT]** Cursor: Firecracker microVM, отдельный AWS account, HSM-signed commits, OIDC, Builds pre-warm, self-hosted worker до 10,000 `[CU2][CU3][CU5][CU6]`.
- **[FACT]** Amp: per-thread orb с дешёвым sleep/wake, прозрачные размеры/цены, self-hosted provider, agent-to-agent isolation `[A2][A3][A7][A8]`.
- **[FACT]** Antigravity: artifacts-first workflow (plan/diff/recording), concurrent subagents с worktree isolation, deny>ask>allow, Turbo как явный «unsafe» режим, hybrid execution для enterprise `[G3][G4][G6][G9]`.

## 6. Candidate recommendations

Раздел фиксирует, какие механики конкурентов стоит изучить, а какие не стоит копировать. Это competitor-side observations, не план изменений ZCode. Все `[ID]` — источники, открытые 2026-11-11 (URL в разделе 8); колонка «Почему» — анализ, а не цитата источника.

### 6.1 Механики, которые стоит изучить

| Механика | Кто | Почему стоит изучить | Доказательство |
|---|---|---|---|
| Environment как воспроизводимый build + frozen snapshot | Devin, Cursor, Codex Cloud | Отделяет «подготовку среды» от сессии; повторные задачи стартуют из известного состояния, а не из ad-hoc VM | Devin blueprint/build/snapshot `[D3]`; Cursor Builds `[CU5]`; Codex published environment `[X2]` |
| Явный статус-конечный автомат сессии | Devin, OpenHands, Cursor | `suspended/resuming`, `waiting_for_confirmation`, `stuck` позволяют строить надёжный polling и UI без догадок | Devin status/status_detail `[D5]`; OpenHands execution states `[O13]`; Cursor run states `[CU7]` |
| Resume по детерминированному ключу, а не по позиции | Devin Dynamic Workflows | Хеш prompt/schema/settings даёт воспроизводимый replay завершённых шагов; помогает при сбоях и повторных запусках | `[D8]` |
| Structured output между агентами | Devin Dynamic Workflows | JSON Schema на каждом `agent()` превращает fan-out в типизированный pipeline, а не в пересказ | `[D8]` |
| Суб-агент с собственной conversation и resume по task ID | OpenHands TaskToolSet | Изолирует сложность подзадачи от родительского контекста; позволяет вернуться к subagent'у позже | `[O8]` |
| Condenser с явными порогами и сохранением первых событий | OpenHands | Предсказуемое сжатие истории; `keep_first` защищает системные инструкции, summary заменяет середину | `[O4]` |
| Stop-hook как quality gate | OpenHands | Позволяет не дать агенту завершиться, пока lint/test не прошли; verification становится enforceable, а не рекомендацией | `[O18]` |
| ACI-подсказки: линтер, ограниченный viewer, summarized search | SWE-agent | Абляции показывают измеримый вклад интерфейса в успех; это дешёвые механизмы, влияющие на качество | `[S3][S4]` |
| Trajectory как first-class artifact | SWE-agent, mini-SWE-agent | `.traj` + inspector упрощают отладку, сравнение моделей и fine-tuning | `[S8][S11][S14]` |
| Sandbox с egress-proxy и наследованием политики суб-агентами | Factory | `denyWrite` overrides `allowWrite`, org denies нельзя ослабить ниже; subagents inherit policy | `[F2]` |
| Long-running mission с milestones и validator model | Factory | Долгая задача разбивается на проверяемые checkpoint'ы; validator model отделяет исполнение от приёмки | `[F5][F6]` |
| Per-task model routing + BYOK | Factory, Amp, Devin Fusion | Дешёвая модель для routine, frontier — для сложного; снижает стоимость без смены интерфейса | Factory Router `[F10]`; Amp modes `[A4][A9]`; Devin Fusion `[D20]` |
| Per-agent VM/microVM и отдельный cloud account | Cursor | Сильная граница изоляции между агентами и от production-инфраструктуры | `[CU2]` |
| Signed commits и OIDC вместо долгоживущих ключей | Cursor | Убирает классические секреты из CI/агентского окружения, даёт проверяемое авторство | `[CU3]` |
| Artifacts-first review: plan, diff, recording | Antigravity, Devin, Cursor | Человек проверяет артефакт до исполнения и после него; recording — дешёвое доказательство пользовательского сценария | Antigravity `[G6][G7]`; Devin `[D17]`; Cursor `[CU4]` |
| Явные unsafe-режимы с отдельным именем | Antigravity Turbo, Factory High | Опасный режим не маскируется под дефолт; пользователь осознанно выбирает ослабление sandbox | Antigravity `[G4]`; Factory `[F3]` |
| Airgap/BYOK-only deployment | Factory | Показывает, какие функции неизбежно отваливаются без cloud control plane, и как сохранить локальные возможности | `[F15]` |

### 6.2 Механики, которые не стоит копировать

| Анти-паттерн | Кто демонстрирует | Почему не стоит копировать | Доказательство |
|---|---|---|---|
| «Unlimited concurrency» как маркетинговый дефолт | Devin Max/Teams, Cursor, Amp | Сам по себе параллелизм не гарантирует пропускную способность: нужны cost ceiling и capacity. Devin отдельно вводит ACU limits, Cursor — spend limit, Amp — burst limit и per-minute billing | Devin pricing `[D13]`; Devin ACU budgets `[D25]`; Cursor `[CU1]`; Amp `[A2][A3]` |
| Resume, завязанный на перезапуск всего скрипта | Devin Dynamic Workflows | Требует детерминированности и запрета time/random/env/filesystem; любое изменение prompt reruns downstream | `[D8]` |
| Autosubmit при ошибке/лимите | SWE-agent | Маскирует незавершённую работу под «submission»; источник не описывает отдельный failed-state для этого пути | `[S8]` |
| Benchmark-chasing через подгонку ACI | SWE-agent | Абляции сильно зависят от benchmark/модели; перенос интерфейса без повторной валидации может ухудшить результат. Это наблюдение, а не доказанный causal claim | `[S3][S4]` |
| Sandbox как «defense in depth» без hard boundary | Factory | Сам продукт признаёт утечку через allowed egress и советует container/VM для untrusted code | `[F2]` |
| Декомпозиция долгой задачи переложена на пользователя | Devin (правило 3 часов) | Правило «дробите задачу» переносит планирование на пользователя; в отличие от Missions с milestones и validator, здесь нет встроенной приёмки этапов | `[D18]` (для контраста — Factory Missions `[F5][F6]`) |
| Автозапуск всех terminal-команд в cloud | Cursor | Docs прямо признают prompt injection/exfiltration risk; для недоверенного контента нужен egress control или approval | `[CU3]` |
| Approval, который не покрывает MCP/setup processes | Copilot | Firewall применяется только к Bash tool; MCP и setup steps вне контура, при этом «sophisticated attacks may bypass» | `[C2]` |
| Гибридное исполнение с фоновыми first-party вызовами | Antigravity | Docs раскрывают, что при выборе third-party Claude фоновые Gemini-вызовы расходуют first-party tokens; без явного индикатора пользователь может не ожидать двойного счёта | `[G9]` |
| Side chat в одном UI с основным агентом | Devin | Side Chat документирован как read-only и не меняет файлы/команды; близость к основному чату повышает риск ложных ожиданий | `[D2]` |
| Жёсткие платформенные лимиты cloud-режима | Copilot Actions, Cursor managed, Codex Cloud | 59-минутный cap, 30-дневные snapshots, отсутствие computer use и ограничения self-hosted сужают класс задач; локальные fallback есть, но не эквивалентны | Copilot `[C1]`; Cursor `[CU2][CU6]`; Codex `[X2]` |
| Суб-агенты без канала координации | Amp, Antigravity `inherit` | Subagents не могут общаться друг с другом и получают только финальный summary; при пересечении файлов это создаёт риск конфликтов (источник инцидентов не документирует) | Amp `[A4]`; Antigravity `[G3]` |
| Зависимость от одного активного snapshot | Devin | Один snapshot на организацию упрощает воспроизводимость, но может мешать параллельным командам с разными environment-требованиями | `[D3]` |

## 7. Open questions and unverified

1. **[UNKNOWN]** Точная архитектура cloud sandbox у Devin: docs говорят «isolated machine»/VM, но не раскрывают hypervisor/container tech, CPU/RAM/disk, network namespace. `[D15]` не детализирует.
2. **[UNKNOWN]** Точная архитектура Codex Cloud sandbox: current docs описывают workspace и environment, но не hypervisor/isolation tech; legacy docs говорят «isolated OpenAI-managed containers» `[X1][X4]`. Нужен primary source от OpenAI.
3. **[UNKNOWN]** Copilot cloud sandbox isolation: docs описывают environment choice и firewall, но не hypervisor/container tech; security deep-dive не найден `[C1][C2]`.
4. **[UNKNOWN]** Единый benchmark-протокол для сравнения Devin/Factory/Cursor/Amp/Antigravity: публичных воспроизводимых наборов в их docs на 2026-11-11 не найдено; Agent Arena/Terminal-Bench — вендорские или сторонние рейтинги `[F18][F19]`.
5. **[UNKNOWN]** Реальные resource limits (CPU/RAM/disk) для OpenHands Docker sandbox, Devin VM, Factory Droid Computers, Cursor VM: docs либо молчат, либо дают только размеры/цены без гарантий `[O6][D3][F8][CU2]`.
6. **[UNKNOWN]** Семантика идемпотентности Devin session message/create: idempotency key/retry не описаны; auto-resume есть, но повторная доставка не документирована `[D4][D6]`.
7. **[UNKNOWN]** Точные retention/export/API для Factory audit log: доступ только Enterprise owners, retention/export/API не описаны `[F13]`.
8. **[UNKNOWN]** Точные квоты Copilot coding agent (кроме 59-минутного Actions cap) и модели по планам: docs говорят «depend on your plan and account policies», без чисел `[C1]`.
9. **[UNKNOWN]** Точные лимиты Codex Cloud (число параллельных tasks, CPU/RAM, срок жизни environment): в cloud docs не найдены `[X1][X2]`.
10. **[UNKNOWN]** Точная реализация Antigravity terminal sandbox (какой механизм изоляции, какие syscall/FS ограничения): docs описывают режимы и политики, но не tech stack `[G4]`.
11. **[UNKNOWN]** Текущие позиции SWE-bench leaderboard не извлечены: страница `swebench.com` по умолчанию показывает «No models selected», а ranked-таблица формируется интерактивно; версии датасетов зафиксированы — original 2294, Verified 500, Lite 300, Multilingual 300/42 repos/9 языков, Multimodal 480 `[S17]`.
12. **[UNKNOWN]** Независимая проверка вендорских чисел Factory (Terminal-Bench 2.0 63.1%, Agent Arena 1330, Next.js 66%, Review F1 60.5%) и mini-SWE-agent (>74% Verified) не проводилась; это заявления источников `[F18]–[F21][S14]`.
13. **[UNKNOWN]** Влияние гибридного исполнения Antigravity на стоимость и задержку при third-party моделях: docs говорят о фоновых Gemini-токенах, но не дают формулы/лимитов `[G9]`.

Недоступные/неизвлечённые источники (зафиксировано, не додумывалось):
- `docs.devin.ai/enterprise/security` — HTTP 404; рабочая страница `enterprise/security-access/security/enterprise-security.md` `[D14]`.
- `docs.devin.ai/essential-guidelines/sessions` — HTTP 404; использованы session tools/API `[D2][D4][D5]`.
- `docs.openhands.dev/openhands/usage/architecture` и `/runtime` — HTTP 404; использованы SDK architecture/workspace/Docker sandbox `[O2][O5][O6]`.
- `swe-agent.com/latest/config/history_processors/` — HTTP 404; использованы config/reference/paper `[S3][S6][S8]`.
- `ampcode.com/how-to-use` — HTTP 404; использован `ampcode.com/docs` и llms index `[A1]`.
- `docs.cursor.com/background-agent` — редирект на `cursor.com/docs`; использован `cursor.com/docs/cloud-agent.md` `[CU1]`.
- `antigravity.google/docs/agent-overview` — HTTP 404; использован `antigravity.google/docs/agent/` `[G2]`.
- `docs.devin.ai/release-notes/2026.md` — контент получен частично (обрыв вывода), использованы отдельные страницы продукта.
- GitHub API releases для SWE-agent — rate limit exceeded; вместо API использованы changelog docs `[S9]`.
- PDF `arxiv.org/pdf/2405.15793` — WebFetch не поддерживает PDF; использован ar5iv HTML `[S3]`.

## 8. Evidence appendix

Все записи ниже открывались 2026-11-11. Тип: docs/repo/paper = official primary; pricing/benchmark/product = vendor claim.

### Devin
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| D1 | https://docs.devin.ai/get-started/devin-intro.md | official docs | 2026-11-11 | продукт, workspace, Shell/IDE/Browser, CLI, parallel, HITL, ограничения |
| D2 | https://docs.devin.ai/work-with-devin/devin-session-tools.md | official docs | 2026-11-11 | IDE takeover, shell history, Interactive Browser, Side Chat, browser profile |
| D3 | https://docs.devin.ai/onboard-devin/environment/blueprints.md | official docs | 2026-11-11 | blueprint/build/snapshot, lifecycle, 10 clones, 3h timeout, 24h refresh, 7-day pin |
| D4 | https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md | official API docs | 2026-11-11 | create session fields, `max_acu_limit`, `structured_output_schema`, statuses |
| D5 | https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md | official API docs | 2026-11-11 | session fields, status/status_detail enums, suspension causes |
| D6 | https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages.md | official API docs | 2026-11-11 | message endpoint, auto-resume, no idempotency |
| D7 | https://docs.devin.ai/work-with-devin/advanced-capabilities.md | official docs | 2026-11-11 | coordinator/child sessions, isolated VM, ACU limits, MCP, skills, knowledge |
| D8 | https://docs.devin.ai/work-with-devin/dynamic-workflows.md | official docs | 2026-11-11 | Python workflow API, pipeline/parallel, VM modes, resume hash, 7-day budget |
| D9 | https://docs.devin.ai/cloud/outposts/overview.md | official docs | 2026-11-11 | brain cloud/execution on-prem, outbound HTTPS, N workers = N sessions, sudo warning |
| D10 | https://docs.devin.ai/cloud/outposts/reference.md | official docs | 2026-11-11 | `devin worker start`, fleet API under `/opbeta/outposts/`, worker flags |
| D11 | https://docs.devin.ai/admin/billing/usage.md | official docs | 2026-11-11 | ACU metering, sleep 5 min, Windows +9%, enterprise timeout 5–120 min |
| D12 | https://docs.devin.ai/admin/billing/self-serve.md | official docs | 2026-11-11 | Free/Pro/Max/Teams, $20/$200/$80+$40, quotas, 2 free-mode sessions |
| D13 | https://devin.ai/pricing | vendor pricing | 2026-11-11 | Free/Pro/Max/Teams/Enterprise, concurrency Up to 10/Unlimited, $20/$200 |
| D14 | https://docs.devin.ai/enterprise/security-access/security/enterprise-security.md | official docs | 2026-11-11 | SOC 2 Type II, encryption, retention, model training policy |
| D15 | https://docs.devin.ai/enterprise/deployment/overview.md | official docs | 2026-11-11 | Enterprise Cloud vs Customer Dedicated VPC, PrivateLink/IPSec, no Outposts |
| D16 | https://docs.devin.ai/product-guides/security-profiles.md | official docs | 2026-11-11 | network/MCP/git profiles, mandatory floor, child inheritance, Outposts firewall caveat |
| D17 | https://docs.devin.ai/work-with-devin/testing-and-recordings.md | official docs | 2026-11-11 | post-PR app test, video recording, limitations |
| D18 | https://docs.devin.ai/essential-guidelines/when-to-use-devin.md | official docs | 2026-11-11 | 3-hour rule, decomposition, session limit as complexity signal, env problems |
| D19 | https://docs.devin.ai/cli/sandbox.md | official docs | 2026-11-11 | OS-level sandbox, fail-closed, bubblewrap/socat, Windows unsupported, network unstable |
| D20 | https://docs.devin.ai/cli/fusion.md | official docs | 2026-11-11 | lead/sidekick models, defaults, paid-only, separate billing |
| D21 | https://docs.devin.ai/work-with-devin/computer-use.md | official docs | 2026-11-11 | full desktop, 1024×768, Linux/Windows/macOS, Outposts X session |
| D22 | https://docs.devin.ai/work-with-devin/stacked-prs.md | official docs | 2026-11-11 | GitHub.com only, stack semantics, CI/conflict handling |
| D23 | https://docs.devin.ai/product-guides/session-insights.md | official docs | 2026-11-11 | auto classification, L/XL analysis, ACU usage, API trigger |
| D24 | https://docs.devin.ai/onboard-devin/agents-md.md | official docs | 2026-11-11 | 16 KiB auto-injection, truncation notice, skills for longer guidance |
| D25 | https://docs.devin.ai/admin/billing/enterprise.md | official docs | 2026-11-11 | enterprise ACU on order form, budget tree, per-user tiers, on-demand separation |
| D26 | https://docs.devin.ai/_llms/en/cloud.txt | official docs index | 2026-11-11 | каталог страниц Skills, Memory, Playbooks, Session Insights, CLI, Outposts |
| D27 | https://docs.devin.ai/_llms/en/api.txt | official API docs index | 2026-11-11 | каталог v3 endpoints: sessions, knowledge, playbooks, secrets, snapshot setup, analytics, audit logs |

### OpenHands
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| O1 | https://github.com/OpenHands/OpenHands | official repo | 2026-11-11 | Agent Canvas, Agent Server, ACP agents, MIT, sandbox modes |
| O2 | https://docs.openhands.dev/sdk/arch/overview.md | official docs | 2026-11-11 | packages, components, agent loop, workspace modes, events, security |
| O3 | https://docs.openhands.dev/sdk/arch/agent.md | official docs | 2026-11-11 | single-step stateless loop, atomic pause/resume, events, confirmation |
| O4 | https://docs.openhands.dev/sdk/arch/condenser.md | official docs | 2026-11-11 | triggers, condenser types, max_size 120, keep_first 4, target 60 |
| O5 | https://docs.openhands.dev/sdk/arch/workspace.md | official docs | 2026-11-11 | Local/Docker/Remote workspace isolation, command results, file transfer |
| O6 | https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox.md | official docs | 2026-11-11 | image, complete isolation, ports, VSCode/VNC, no resource limits |
| O7 | https://docs.openhands.dev/sdk/arch/security.md | official docs | 2026-11-11 | analyzers, risk levels, confirmation policies, defaults |
| O8 | https://docs.openhands.dev/sdk/guides/task-tool-set.md | official docs | 2026-11-11 | subagent conversation, sync, task ID resume, tool_concurrency_limit |
| O9 | https://docs.openhands.dev/overview/skills.md | official docs | 2026-11-11 | AGENTS.md, SKILL.md, triggers, progressive disclosure, precedence |
| O10 | https://docs.openhands.dev/sdk/arch/tool-system.md | official docs | 2026-11-11 | tool names, action/observation, MCP bypass registry |
| O11 | https://docs.openhands.dev/sdk/arch/agent-server.md | official docs | 2026-11-11 | HTTP/WS, endpoints, unauthenticated default, API keys, storage |
| O12 | https://docs.openhands.dev/sdk/guides/agent-server/deferred-init.md | official docs | 2026-11-11 | warm pool, dormant/initializing/ready, `/api/init`, 503 |
| O13 | https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md | official docs | 2026-11-11 | app-conversations, start tasks, sandbox/execution states, rate limits |
| O14 | https://docs.openhands.dev/openhands/usage/api/v1.md | official docs | 2026-11-11 | `/api/v1` app-conversations, sandboxes, sandbox-specs |
| O15 | https://ar5iv.labs.arxiv.org/html/2407.16741 | paper | 2026-11-11 | isolated Docker runtime, Jupyter/Chromium, 15 benchmarks, Lite 26.0% |
| O16 | https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model | official blog | 2026-11-11 | 60.6% single → 66.4% 5 attempts + critic, 17 Apr 2025 |
| O17 | https://www.openhands.dev/pricing | vendor pricing | 2026-11-11 | Free/Teams $500/5000 sessions/Enterprise custom |
| O18 | https://docs.openhands.dev/openhands/usage/customization/hooks.md | official docs | 2026-11-11 | six hook events, blocking, Stop quality gate, exit code 2 |
| O19 | https://docs.openhands.dev/sdk/guides/critic.md | official docs | 2026-11-11 | score 0–1, success >=0.5, iterative refinement, experimental |
| O20 | https://docs.openhands.dev/sdk/arch/events.md | official docs | 2026-11-11 | append-only typed event log, event classes |
| O21 | https://docs.openhands.dev/llms.txt | official docs index | 2026-11-11 | каталог страниц: SDK architecture, agent server, skills, delegation, condenser, security; страницы «microagents» нет |

### SWE-agent / mini-SWE-agent
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| S1 | https://github.com/SWE-agent/SWE-agent | official repo | 2026-11-11 | NeurIPS 2024, MIT, YAML, maintenance-only, mini supersedes |
| S2 | https://arxiv.org/abs/2405.15793 | paper abstract | 2026-11-11 | ACI, SWE-bench 12.5%, HumanEvalFix 87.7%, versions |
| S3 | https://ar5iv.labs.arxiv.org/html/2405.15793 | paper HTML | 2026-11-11 | tables: full/Lite/HumanEvalFix, ablations, costs |
| S4 | https://swe-agent.com/latest/background/aci/ | official docs | 2026-11-11 | linter, 100-line viewer, search, empty output normalization |
| S5 | https://swe-agent.com/latest/background/architecture/ | official docs | 2026-11-11 | SWEEnv/SWE-ReX, deployments, Agent.forward, history processor |
| S6 | https://swe-agent.com/latest/config/config/ | official docs | 2026-11-11 | agent templates, tool bundles, history_processors, model keys |
| S7 | https://swe-agent.com/latest/config/models/ | official docs | 2026-11-11 | per-model settings, cost limits, HumanModel/ReplayModel |
| S8 | https://swe-agent.com/latest/reference/agent/ | official docs | 2026-11-11 | run loop, `/root/model.patch`, retries, cost limit |
| S9 | https://swe-agent.com/latest/installation/changelog/ | official docs | 2026-11-11 | 1.0.0/1.0.1/1.1.0 dates and features |
| S10 | https://swe-agent.com/latest/usage/batch_mode/ | official docs | 2026-11-11 | run-batch, parallel instances, per-instance cost limit |
| S11 | https://swe-agent.com/latest/usage/trajectories/ | official docs | 2026-11-11 | `.traj`, CLI/web inspector, benchmark results |
| S12 | https://swe-agent.com/latest/config/tools/ | official docs | 2026-11-11 | bash, filemap, `_state`, tool bundles |
| S13 | https://swe-agent.com/latest/config/environments/ | official docs | 2026-11-11 | Docker `python:3.11`, image override, SWE-ReX |
| S14 | https://github.com/SWE-agent/mini-swe-agent | official repo | 2026-11-11 | 100 lines, bash-only, subprocess.run, >74% Verified, environments |
| S15 | https://mini-swe-agent.com/latest/ | official docs | 2026-11-11 | design philosophy, bash-only, linear history, v2 |
| S16 | https://swe-agent.com/latest/faq/ | official docs | 2026-11-11 | maintenance-only, recommends mini |
| S17 | https://www.swebench.com/ | official benchmark site | 2026-11-11 | версии датасетов и размеры: original 2294, Verified 500, Lite 300, Multilingual 300, Multimodal 480 |

### Factory Droid
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| F1 | https://docs.factory.com/ | official docs | 2026-11-11 | Droid surfaces, Workstreams, Missions, Droid Computers, Enterprise |
| F2 | https://docs.factory.com/autonomy-and-safety/sandbox | official docs | 2026-11-11 | Seatbelt/bubblewrap+seccomp, egress proxy, modes, deny rules, limits |
| F3 | https://docs.factory.com/autonomy-and-safety/auto-run | official docs | 2026-11-11 | Off/Low/Medium/High, permissionRules, Spec Mode |
| F4 | https://docs.factory.com/autonomy-and-safety/droid-shield | official docs | 2026-11-11 | secret scan, commit/push blocking, scope, limitations |
| F5 | https://docs.factory.com/missions/overview | official docs | 2026-11-11 | plan/milestones/QA, Mission Control, not fire-and-forget, 1–500 |
| F6 | https://docs.factory.com/missions/reference | official docs | 2026-11-11 | headless mission flags, model settings, missionPolicy |
| F7 | https://docs.factory.com/workstreams/overview | official docs | 2026-11-11 | orchestrator, parallel agents, PRs, beta availability, token cost |
| F8 | https://docs.factory.com/droid-computers/overview | official docs | 2026-11-11 | persistent state, auto-pause/resume, network/SSH, sudo, pool/worker limits |
| F9 | https://docs.factory.com/droid-exec/overview | official docs | 2026-11-11 | one-shot, auto levels, output formats, worktree/session flags, exit 0 caveat |
| F10 | https://docs.factory.com/model-independence/factory-router | official docs | 2026-11-11 | per-task routing, failover, 63% savings claim, 99.9% claim |
| F11 | https://docs.factory.com/enterprise/security | official docs | 2026-11-11 | local execution, no repo upload, OTel/audit, SSO/SCIM, sandbox |
| F12 | https://docs.factory.com/enterprise/identity-and-access | official docs | 2026-11-11 | WorkOS, roles, service accounts, OAuth non-inheritance, audit attrs |
| F13 | https://docs.factory.com/enterprise/audit-log | official docs | 2026-11-11 | Enterprise owners only, event categories, no retention/export/API |
| F14 | https://docs.factory.com/enterprise/network-and-deployment | official docs | 2026-11-11 | Managed/Private, OpenCompute, EU deployment, airgap hosts |
| F15 | https://docs.factory.com/enterprise/airgapped-deployment | official docs | 2026-11-11 | custom model required, no Factory services, BYOK-only, telemetry local |
| F16 | https://docs.factory.com/pricing/individuals | vendor pricing | 2026-11-11 | Pro/Plus/Max, rolling windows, Droid Core, credits, Missions |
| F17 | https://docs.factory.com/pricing/organizations | vendor pricing | 2026-11-11 | Teams $60+$40/seat, Business, Enterprise terms |
| F18 | https://docs.factory.com/benchmarks/terminal-bench | vendor benchmark | 2026-11-11 | Terminal-Bench 2.0, Dec 2025, scores |
| F19 | https://docs.factory.com/benchmarks/agent-arena | vendor benchmark | 2026-11-11 | Agent Arena Elo, Dec 2025 |
| F20 | https://docs.factory.com/benchmarks/nextjs-eval | vendor benchmark | 2026-11-11 | Next.js evals, Dec 2025, scores |
| F21 | https://docs.factory.com/benchmarks/review-benchmark | vendor benchmark | 2026-11-11 | 13 models, 50 PRs, 167 bugs, F1/cost |
| F22 | https://docs.factory.com/agent-effectiveness/overview | official docs | 2026-11-11 | throughput/output/attribution/intents/friction, Analytics API, OTel |
| F23 | https://docs.factory.com/changelog/release-notes.md | official docs | 2026-11-11 | release cadence, approved spec survives compaction, exec session conflicts |

### GitHub Copilot coding agent
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| C1 | https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent | official docs | 2026-11-11 | client/session/environment, Actions/cloud sandbox, 59 min, one branch/PR, Agent Merge |
| C2 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall | official docs | 2026-11-11 | firewall scope, allowlist, blocked-address warning, MCP/setup gaps, bypass warning |
| C3 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment | official docs | 2026-11-11 | setup steps file, job keys, 59 min, runner OS, firewall incompatibilities |
| C4 | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp | official docs | 2026-11-11 | repo MCP JSON, default GitHub/Playwright, tools allowlist, COPILOT_MCP_ secrets, no OAuth |

### OpenAI Codex Cloud
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| X1 | https://learn.chatgpt.com/docs/cloud.md | official docs | 2026-11-11 | cloud tasks, own workspace, review/PR, environments |
| X2 | https://learn.chatgpt.com/docs/environments/cloud-environments.md | official docs | 2026-11-11 | published environments, saved state, install script/start skill, limitations |
| X3 | https://learn.chatgpt.com/docs/sandboxing.md | official docs | 2026-11-11 | Seatbelt/bubblewrap/Windows sandbox, default network off, workspace writes |
| X4 | https://learn.chatgpt.com/docs/agent-approvals-security.md | official docs | 2026-11-11 | sandbox vs approval, legacy containers, two-phase setup, secrets removed |
| X5 | https://learn.chatgpt.com/docs/cloud/internet-access.md | official docs | 2026-11-11 | Off/On, allowlists, HTTP methods, prompt injection/exfiltration risks |

### Cursor Cloud Agents
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| CU1 | https://cursor.com/docs/cloud-agent.md | official docs | 2026-11-11 | isolated VMs, parallel, multi-repo, environments, MCP, hooks, models |
| CU2 | https://cursor.com/docs/cloud-agent/security.md | official docs | 2026-11-11 | Firecracker microVM, separate AWS account, encryption, retention, no employee access |
| CU3 | https://cursor.com/docs/cloud-agent/security-network.md | official docs | 2026-11-11 | secret types, runtime redaction, signed commits, OIDC, internet default on, exfiltration risk, 30-day snapshots |
| CU4 | https://cursor.com/docs/cloud-agent/capabilities.md | official docs | 2026-11-11 | computer use, artifacts, remote desktop, MCP HTTP/stdio, Cursor Cloud MCP |
| CU5 | https://cursor.com/docs/cloud-agent/builds.md | official docs | 2026-11-11 | bootable build snapshots, triggers, pre-warm, failure fallback |
| CU6 | https://cursor.com/docs/cloud-agent/self-hosted.md | official docs | 2026-11-11 | agent loop cloud/execution local, outbound HTTPS, 10,000 workers |
| CU7 | https://cursor.com/docs/cloud-agent/api/endpoints.md | official docs | 2026-11-11 | create/list/get agent, steer, runs, idempotent `agentId`, 500 repos, 50 env vars |
| CU8 | https://cursor.com/docs/agent/overview.md | official docs | 2026-11-11 | local checkpoints, restore files only, separate from Git |

### Sourcegraph Amp
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| A1 | https://ampcode.com/llms.txt | official docs index | 2026-11-11 | product pages, orbs, apps, pricing |
| A2 | https://ampcode.com/docs/markdown/orbs | official docs | 2026-11-11 | per-thread orb, isolation, sleep/wake, 20 burst then 1/5 min |
| A3 | https://ampcode.com/docs/markdown/orbs/sizes-and-costs | official docs | 2026-11-11 | sizes, CPU/RAM, $/hour, 60 GB, pause rules, billing per minute |
| A4 | https://ampcode.com/docs/markdown/models-and-subagents | official docs | 2026-11-11 | low/medium/high/ultra, Task/Read Thread, isolation, compaction |
| A5 | https://ampcode.com/docs/markdown/tools | official docs | 2026-11-11 | shell, Task, Oracle/Librarian/Finder, Painter, no default approvals |
| A6 | https://ampcode.com/docs/markdown/pricing | vendor pricing | 2026-11-11 | Hobby/Megawatt/Gigawatt/Teams/Enterprise, credits, self-hosted orbs |
| A7 | https://ampcode.com/docs/markdown/orbs/agent-to-agent | official docs | 2026-11-11 | separate conversation/context/working copy/orb, explicit transfer |
| A8 | https://ampcode.com/docs/markdown/orbs/self-hosted | official docs | 2026-11-11 | `amp orb provider`, spawn/pause/delete, outbound only |
| A9 | https://ampcode.com/modes | official docs | 2026-11-11 | mode → model routing table, Puck/system models |

### Google Antigravity
| ID | URL | Тип | Дата доступа | Что подтверждает |
|---|---|---|---|---|
| G1 | https://antigravity.google/ | vendor product | 2026-11-11 | IDE/App/CLI/SDK, agent manager, artifacts, parallel local agents, free |
| G2 | https://antigravity.google/docs/agent/ | official docs | 2026-11-11 | multi-step agent, tools, artifacts, knowledge, parallel conversations |
| G3 | https://antigravity.google/docs/subagents | official docs | 2026-11-11 | `invoke_subagent`, workspace modes, isolation, 10 levels, teamwork/swarm |
| G4 | https://antigravity.google/docs/permissions/ | official docs | 2026-11-11 | deny>ask>allow, sandbox modes, Turbo unsafe, read_url egress allowlist |
| G5 | https://antigravity.google/docs/ide/browser | official docs | 2026-11-11 | Chrome DevTools MCP, remote debugging, screenshots/WebM, JS/actuation policies |
| G6 | https://antigravity.google/docs/artifacts/ | official docs | 2026-11-11 | plans, diffs, recordings, interactive HTML, review/steering |
| G7 | https://antigravity.google/docs/implementation-plan/ | official docs | 2026-11-11 | plan artifact, comments, Proceed, review before changes |
| G8 | https://antigravity.google/docs/plans/ | vendor pricing | 2026-11-11 | baseline quota, Pro/Ultra 5h/weekly, credits overage |
| G9 | https://antigravity.google/docs/enterprise/ | official docs | 2026-11-11 | Gemini Enterprise, hybrid execution, HITL, regional endpoints/PSC |
| G10 | https://antigravity.google/docs/models/ | official docs | 2026-11-11 | model list, thinking levels, plan availability |
| G11 | https://antigravity.google/docs/getting-started | official docs | 2026-11-11 | surfaces, install, first project |

---

**Статус покрытия:** обязательные C4-продукты (Devin, OpenHands, SWE-agent, Factory Droid) покрыты первичными источниками; дополнительные (Copilot, Codex Cloud, Cursor, Amp, Antigravity) — официальными docs, часть архитектурных деталей помечена UNKNOWN.

**Не проверено:** независимое воспроизведение бенчмарков; реальные resource limits и hypervisor-технологии cloud-сред Devin/Codex/Copilot; retention/export Factory audit log; точная идемпотентность Devin API; стоимость гибридного исполнения Antigravity; квоты Copilot/Codex сверх документированных.

**Подтверждение:** записан только этот partial — `<repo-root>/docs/research/partials/2026-11-11-competitors-c4-autonomous-agents.md`; другие файлы не изменялись.
