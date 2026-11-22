# Верификация источников четырёх конкурентных partial-отчётов

- Ветка: V2 (parent ORCH-ZCODE-WIDE-RESEARCH)
- Дата проверки: 2026-11-11, время фиксации состояния репозитория: 2026-11-11T11:22:24Z
- Роль: независимый fact-checker; продакшн-код не изменялся, коммиты не создавались, пакеты не устанавливались
- Проверяемые файлы (абсолютные пути):
  - `<repo-root>/docs/research/partials/2026-11-11-competitors-c1-terminal-agents.md`
  - `<repo-root>/docs/research/partials/2026-11-11-competitors-c2-ide-extensions.md`
  - `<repo-root>/docs/research/partials/2026-11-11-competitors-c3-commercial-ides.md`
  - `<repo-root>/docs/research/partials/2026-11-11-competitors-c4-autonomous-agents.md`
- Записан только этот файл: `<repo-root>/docs/research/partials/2026-11-11-verification-competitor-sources.md`

## 1. Method and preflight

### 1.1. Preflight (точные результаты)

```
$ git status --short
?? docs/research/

$ git branch --show-current
dev

$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.

$ node scripts/check-workspace-freshness.mjs
[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）
exit 0
```

`git diff --stat` пуст: отслеживаемых изменений нет. Всё содержимое `docs/research/` — untracked.

### 1.2. Что и как проверялось

1. Полностью прочитаны все четыре проверяемых файла (753, 692, 989 и 572 строки).
2. Извлечены все URL; для аудита выбраны 88 приоритетных ссылок (C1 17, C2 22, C3 28, C4 21), включая все ссылки, на которых держатся «несущие» механики (sandbox, permissions, agent loop, pricing, shutdown/acquisition).
3. Для каждой ссылки выполнен реальный HTTP-запрос: `curl -sSL -o /dev/null -w '%{http_code} %{url_effective}'` и/или `curl -sSL` с последующим grep по телу. Для страниц, где утверждение построено на цитате, цитата искалась в теле страницы, а не выводилась из заголовка.
4. GitHub-метаданные (license, archived, pushed_at, releases) перепроверены через `gh api` (аутентифицированный), потому что анонимный `api.github.com` в ходе аудита отдавал `403 API rate limit exceeded` (`core.remaining = 0`).
5. Проверены redirect-цепочки (`-D -`): `windsurf.com`, `docs.windsurf.com`, `roocode.com`, `github.com/sst/opencode`, `developers.openai.com`, `docs.cursor.com/background-agent`, `docs.github.com` (несколько путей).
6. Кросс-проверка проводилась по первичным страницам самих вендоров; сводки других агентов доказательством не считались.
7. Продукты не запускались, тарифы не покупались, бенчмарки не воспроизводились. Всё, что не удалось проверить, вынесено в раздел 9 и в «gaps», а не в findings.

### 1.3. Ограничения аудита

- Проверялось соответствие «URL + цитата/число = утверждение отчёта». Полнота описания механик (нет ли у продукта ещё чего-то) не проверялась.
- JS-рендеринг: у `docs.trae.ai` тело статьи лежит во встроенном JSON-payload. Цитаты извлекались из payload, как и заявлено в C3.
- GitHub API: анонимный лимит исчерпан, поэтому метаданные и релизы проверялись через `gh api`; это тот же первичный источник, но с аутентификацией.
- Даты доступа во всех четырёх отчётах совпадают с датой аудита (2026-11-11), поэтому расхождения «источник изменился после доступа» маловероятны, но не исключены для динамических страниц (pricing, changelog).

## 2. Partial completeness

| Файл | Строк | Байт | ## 1–8 | Доп. разделы | Оценка |
|---|---:|---:|---|---|---|
| `2026-11-11-competitors-c1-terminal-agents.md` | 753 | 139 660 | все 8 присутствуют | — | complete partial |
| `2026-11-11-competitors-c2-ide-extensions.md` | 692 | 143 667 | все 8 присутствуют | `## Coverage status` | complete partial |
| `2026-11-11-competitors-c3-commercial-ides.md` | 989 | 276 883 | все 8 присутствуют | `## Coverage status, not-checked list, and confirmation` | complete partial |
| `2026-11-11-competitors-c4-autonomous-agents.md` | 572 | 110 638 | все 8 присутствуют | — | complete partial |

Проверка заголовков выполнена `grep -n '^## '`; у всех четырёх файлов разделы идут в порядке 1→8 без пропусков. Дополнительные разделы не нарушают контракт.

Внутренние артефакты, которые важны для оценки:
- C1: §8 содержит 117 пронумерованных источников (`C1-01`…`C1-117`), включая явные «evidence of unavailability» (404).
- C2: §8 разбит по продуктам, есть §8.3 с точными выполненными командами (`curl`, `CodeIndex status`, `date -u`).
- C3: §8 содержит ID-таблицы по 8 продуктам плюс §8.3 «недоступные источники» с кодами.
- C4: §8 содержит ID-таблицы по 9 продуктам; каждая строка имеет дату доступа.

Вывод: все четыре файла — завершённые partial-артефакты, а не черновики. Ни один не заявляет полный охват всего рынка; каждый явно перечисляет непроверенное.

## 3. Mandatory competitor coverage

Обязательный список: OpenAI Codex/Codex CLI, Cline, Kilo Code, OpenCode, Cursor, Continue, Aider, Windsurf, GitHub Copilot Workspace/Agent, JetBrains AI, Roo Code, Amp, Goose, Zed AI, Devin.

| # | Продукт | Где покрыт | Первичные источники (примеры, проверены) | Статус |
|---:|---|---|---|---|
| 1 | OpenAI Codex / Codex CLI | C1 §3.1; C4 §3.6 (Cloud) | `learn.chatgpt.com/docs/app-server.md`, `.../agent-approvals-security`, `github.com/openai/codex` | покрыт |
| 2 | Cline | C2 §3.1 | `docs.cline.bot/sdk/architecture/hub-spoke`, `.../features/subagents.md`, `.../features/auto-approve`, raw `BrowserSettings.ts` | покрыт |
| 3 | Kilo Code | C2 §3.2 | `kilo.ai/docs/getting-started/settings/sandboxing`, `.../auto-approving-actions`, `.../context-condensing`, `kilo.ai/pricing` | покрыт |
| 4 | OpenCode | C1 §3.4 | `opencode.ai/docs/server/`, `.../permissions/`, `.../lsp/`, `.../agents/` | покрыт |
| 5 | Cursor | C3 §3.2; C4 §3.6 (Cloud Agents) | `cursor.com/docs/agent/security/run-modes`, `.../hooks`, `cursor.com/pricing`, `.../cloud-agent/security.md` | покрыт |
| 6 | Continue | C2 §3.4 | `github.com/continuedev/continue` (README), `www.continue.dev`, `docs.continue.dev/reference` | покрыт, статус read-only подтверждён |
| 7 | Aider | C1 §3.5 | `aider.chat/docs/repomap.html`, `.../leaderboards/`, `.../config/options.html` | покрыт |
| 8 | Windsurf | C3 §3.3 | `devin.ai/desktop`, `docs.devin.ai/desktop/devin-local/modes.md`, `.../cascade.md`, `.../quota.md` | покрыт, ребрендинг подтверждён |
| 9 | GitHub Copilot Workspace/Agent | C3 §3.4 (Agent); C4 §3.6 (coding agent) | `docs.github.com/.../copilot-on-github`, `.../customize-the-firewall`, `.../custom-agents` | Agent — покрыт; **Workspace как продукт — пробел** |
| 10 | JetBrains AI | C3 §3.5 | `jetbrains.com/help/ai-assistant/agents.html`, `.../licensing-and-subscriptions.html`, `junie.jetbrains.com` | покрыт |
| 11 | Roo Code | C2 §3.3 | `roocodeinc.github.io/Roo-Code/`, `api.github.com/repos/RooCodeInc/Roo-Code` | покрыт, shutdown подтверждён |
| 12 | Amp | C2 §3.6; C4 §3.6 | `ampcode.com/docs/markdown/the-dial`, `.../tools`, `.../models-and-subagents`, `.../pricing` | покрыт |
| 13 | Goose | C2 §3.5 | `goose-docs.ai/docs/guides/managing-tools/goose-permissions.md`, `.../context-engineering/subagents.md` | покрыт |
| 14 | Zed AI | C3 §3.6 | `zed.dev/docs/ai/sandboxing`, `.../tool-permissions`, `zed.dev/pricing` | покрыт |
| 15 | Devin | C4 §3.2; C3 §3.3 (Devin Desktop) | `docs.devin.ai/work-with-devin/dynamic-workflows.md`, `.../onboard-devin/environment/blueprints.md`, `.../admin/billing/usage.md` | покрыт |

Дополнительные (необязательные) продукты: Claude Code (C1), Gemini CLI (C1), OpenHands (C4), SWE-agent (C4), Augment Code (C3), Factory Droid (C4), Kiro (C3), Trae (C3), Qwen Code (C1) — все покрыты первичными источниками, проверенными в этом аудите.

### 3.1. Пробелы обязательного покрытия

1. **GitHub Copilot Workspace (как отдельный продукт).** Оба проверенных docs-пути отдают 404 (`/en/copilot/concepts/agents/copilot-workspace`, `/en/copilot/how-tos/use-copilot-agents/copilot-workspace`). C3 честно фиксирует 404 (§3.4, §8.3), но единственный первичный источник о Workspace — превью-пост GitHub от 2024-04-29 (`https://github.blog/news-insights/product-news/github-copilot-workspace/`, проверен: 200, «Today, we begin the technical preview»), который в отчётах не использован. Итог: «Copilot Agent» покрыт дважды, «Copilot Workspace» — только как отсутствующая docs-страница. Это не фабрикация, но формально обязательный пункт закрыт не полностью.
2. **Gemini CLI как актуальный продукт.** Покрыт в C1, но его текущий статус (enterprise-only, free/Google AI переведены на Antigravity CLI 2026-06-18, «Not optimized for Gemini 4+») в C1 помечен как CLAIM, требующий проверки, хотя это текст README на проверенном URL. C4 покрывает Antigravity, но не связывает его с миграцией пользователей Gemini CLI. Продукт покрыт, статус — искажён (см. §6 и §7).

Все остальные 13 обязательных продуктов имеют минимум три различных первичных источника и проверяемую механику. Требование «mandatory coverage» выполнено на 14/15 с оговоркой по Workspace.

## 4. URL verification table

Метод: `curl -sSL` (фактический запрос, с follow redirect) + чтение тела. «Supports» = страница реально содержит утверждение/цитату отчёта. «Partially» = страница существует и в основном поддерживает, но формулировка отчёта неточна. «Does not support» = страница опровергает утверждение отчёта. «Unreachable» = сетевой отказ.

| # | Отчёт | URL | Что поддерживает | HTTP | Verdict |
|---:|---|---|---|---:|---|
| 1 | C1 | `https://learn.chatgpt.com/docs/app-server.md` | JSON-RPC 2.0, stdio JSONL, thread/turn, approval requests | 200 | supports |
| 2 | C1 | `https://learn.chatgpt.com/docs/agent-configuration/agents-md.md` | `AGENTS.override.md` → `AGENTS.md` → fallback, 32 KiB | 200 | supports |
| 3 | C1 | `https://learn.chatgpt.com/docs/hooks.md` | события hooks; `prompt`/`agent` «parsed but skipped» | 200 | supports |
| 4 | C1 | `https://learn.chatgpt.com/docs/agent-approvals-security` | protected paths `.git/.agents/.codex/.aws`; WSL1 не поддерживается | 200 | supports |
| 5 | C1 | `https://learn.chatgpt.com/docs/permissions.md` | profiles и `sandbox_mode` не композируются | 200 | supports |
| 6 | C1 | `https://learn.chatgpt.com/docs/build-skills.md` | 2% контекста / 8 000 символов; лимит до 10 000 токенов | 200 | supports |
| 7 | C1 | `https://learn.chatgpt.com/docs/non-interactive-mode.md` | `exec --json`, `--output-schema`, `--ephemeral`, `--full-auto` удалён | 200 | supports |
| 8 | C1 | `https://code.claude.com/docs/en/sandboxing` | sandbox только shell; `denyRead`≠Read; `allowedDomains`≠WebFetch | 200 | supports |
| 9 | C1 | `https://code.claude.com/docs/en/hooks` | 33 события, 5 типов handler, exit code 2, `onFailure` | 200 | supports |
| 10 | C1 | `https://code.claude.com/docs/en/memory` | `MEMORY.md`: первые 200 строк или 25 KB | 200 | supports |
| 11 | C1 | `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md` | выключен по умолчанию; флаг удалён в 0.11.0 | 200 | supports |
| 12 | C1 | `https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/architecture.md` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 13 | C1 | `https://opencode.ai/docs/permissions/` | last matching rule wins; нет совпадения → ask; нет OS-sandbox | 200 | supports |
| 14 | C1 | `https://opencode.ai/docs/usage/` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 15 | C1 | `https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/developers/architecture.md` | отчёт заявляет «не отдался», loop = UNKNOWN; фактически 200 и loop описан | 200 | **does not support** |
| 16 | C1 | `https://raw.githubusercontent.com/openai/codex/main/docs/config.md` | отчёт: «только ссылки-заглушки»; файл 726 B, из них ~600 B — ссылки, плюс раздел Lifecycle hooks; `docs/sandbox.md` (150 B) — чистый stub | 200 | partially supports |
| 17 | C1 | `https://github.com/google-gemini/gemini-cli` | точные строки README об enterprise-only/no free tier/Gemini 4+ | 200 | supports (цитата точна; проблема интеграции статуса — см. §6/§7) |
| 18 | C2 | `https://docs.cline.bot/sdk/architecture/hub-spoke` | «clients participate, spokes execute, the hub coordinates» | 200 | supports |
| 19 | C2 | `https://docs.cline.bot/features/browser-use` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 20 | C2 | `https://docs.cline.bot/core-workflows/checkpoints` | shadow git, коммит после каждого tool use, untracked, 3 restore | 200 | supports |
| 21 | C2 | `https://docs.cline.bot/features/auto-approve` | «does not use a fixed allowlist», `requires_approval`, «examples, not guarantees» | 200 | supports |
| 22 | C2 | `https://docs.cline.bot/features/subagents.md` | CLI/Desktop only, без MCP, blanket approval, вложенность | 200 | supports |
| 23 | C2 | `https://docs.cline.bot/cli/agent-teams.md` | `/team`, task board, mailbox, mission log, `teams.db` | 200 | supports |
| 24 | C2 | `https://kilo.ai/docs/getting-started/settings/sandboxing` | sandbox off by default, «write boundary, not privacy boundary», Windows | 200 | supports |
| 25 | C2 | `https://kilo.ai/docs/getting-started/settings/auto-approving-actions` | «last matching rule wins»; кеш project-config | 200 | supports |
| 26 | C2 | `https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new` | «Code indexing is temporarily unavailable», issue #6144 | 200 | supports |
| 27 | C2 | `https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode` | orchestrator deprecated, `task`, «does not isolate file edits» | 200 | supports |
| 28 | C2 | `https://kilo.ai/docs/customize/context/context-condensing` | `tail_turns=2`, prune 40 000, clamp 2 000–8 000, reserved `min(20 000, max_out)` | 200 | supports |
| 29 | C2 | `https://roocodeinc.github.io/Roo-Code/` | «Extension was shut down on May 15th»; ZooCode/Cline | 200 | supports |
| 30 | C2 | `https://api.github.com/repos/RooCodeInc/Roo-Code` | `archived:true`, `pushed_at 2026-05-15T18:08:47Z` (через `gh api`) | 403→200 | supports |
| 31 | C2 | `https://github.com/continuedev/continue` | «no longer actively maintained and is read-only»; final 2.0.0; telemetry/auth removed | 200 | supports |
| 32 | C2 | `https://www.continue.dev/` | «Continue was acquired by Cursor» | 200 | supports |
| 33 | C2 | `https://hub.continue.dev` | DNS failure, как заявлено | 000 | supports |
| 34 | C2 | `https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md` | autonomous default; 4 режима | 200 | supports |
| 35 | C2 | `https://ampcode.com/docs/markdown/the-dial` | режим фиксируется первым сообщением треда | 200 | supports |
| 36 | C2 | `https://ampcode.com/docs/markdown/tools` | «does not ask for approval before running tools» | 200 | supports |
| 37 | C2 | `https://ampcode.com/docs/telemetry` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 38 | C2 | `https://api.github.com/repos/sourcegraph/amp` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 39 | C2 | `https://www.anaconda.com/blog/anaconda-acquires-kilo-code` | «Jul. 15, 2026», «Anaconda is acquiring Kilo Code» | 200 | supports |
| 40 | C3 | `https://cursor.com/docs/agent/security/run-modes` | «Auto-review is not a security boundary», classifier can make mistakes, default read outside workspace | 200 | supports |
| 41 | C3 | `https://cursor.com/docs/hooks` | fail-open по умолчанию; `failClosed: true`; 18 agent-event; cloud `updated_input` игнорируется | 200 | supports |
| 42 | C3 | `https://cursor.com/help/account-and-billing/pricing.md` | Auto разделён на Cost/Balance/Intelligence; Enterprise Router выключен | 200 | supports |
| 43 | C3 | `https://cursor.com/pricing` | Free/Plus $8/Premium $30/Super $100/Ultra $200; недельный пул | 200 | supports |
| 44 | C3 | `https://cursor.com/blog/joining-spacex` | «Cursor has officially been acquired by SpaceX», Aug 14, 2026 | 200 | supports |
| 45 | C3 | `https://cursor.com/docs/cloud-agent/security.md` | Firecracker microVM, отдельный AWS-аккаунт, snapshots 30 дней, CMEK | 200 | supports |
| 46 | C3 | `https://devin.ai/desktop` | «Devin Desktop is the new name for Windsurf» | 200 | supports |
| 47 | C3 | `https://docs.devin.ai/desktop/cascade.md` | Cascade legacy, 40 инвокаций, `continue` = новый кредит, revert необратим | 200 | supports |
| 48 | C3 | `https://docs.devin.ai/desktop/accounts/quota.md` | квоты с марта 2026, daily/weekly, extra usage по API list | 200 | supports |
| 49 | C3 | `https://docs.windsurf.com/windsurf/cascade/cascade` | redirect на docs.devin.ai (отчёт: 307; фактически 308) | 308 | **partially supports** |
| 50 | C3 | `https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent` | 59 мин, one branch/PR, cloud vs Actions (после redirect на `copilot-on-github`) | 200 | supports |
| 51 | C3 | `https://docs.github.com/en/copilot/concepts/agents/copilot-workspace` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 52 | C3 | `https://docs.github.com/en/copilot/get-started/plans` | Pro $10/1 500, Pro+ $39/7 000, Max $100/20 000, Business $19/1 900, Enterprise $39/3 900 | 200 | supports |
| 53 | C3 | `https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/content-exclusion` | «not a filesystem security boundary» | 200 | supports |
| 54 | C3 | `https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall` | firewall только для Bash; MCP/setup вне; sophisticated bypass | 200 | supports |
| 55 | C3 | `https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html` | AI Pro $10/10 кредитов, Ultimate $30/35; org $20/$60; $1=1 кредит | 200 | supports |
| 56 | C3 | `https://junie.jetbrains.com/` | AI Pro $8.33, AI Ultimate $25.00 (расхождение с docs — реальное) | 200 | supports |
| 57 | C3 | `https://zed.dev/docs/ai/sandboxing` | sandbox только `terminal`/`fetch`; External Agents вне; Windows слабее | 200 | supports |
| 58 | C3 | `https://kiro.dev/docs/permissions/` | deny > ask > allow > evaluate; парсинг compound-команд | 200 | supports |
| 59 | C3 | `https://kiro.dev/docs/sandbox/` | локальный command sandbox выключен по умолчанию | 200 | supports |
| 60 | C3 | `https://kiro.dev/docs/acp/` | тело получено: ACP соединяет editor с Kiro harness (отчёт: «не получено») | 200 | **partially supports** |
| 61 | C3 | `https://docs.trae.ai/llms.txt` | SPA-оболочка 1 913 338 байт, как заявлено | 200 | supports |
| 62 | C3 | `https://docs.trae.ai/ide/permission-and-approval` | «Sandbox enabled; commands are executed in an isolated environment»; US restriction | 200 | supports |
| 63 | C3 | `https://docs.trae.ai/ide/auto-run-and-security` | «commands are always auto-run outside the sandbox» | 200 | supports |
| 64 | C3 | `https://docs.augmentcode.com/cli/permissions` | «not enforced in the Augment code extension»; 5 типов policy | 200 | supports |
| 65 | C3 | `https://docs.augmentcode.com/cosmos/workers-subagents.md` | «Cosmos does not launch one implicitly»; worker/subagent/Expert-to-Expert | 200 | supports |
| 66 | C3 | `https://www.augmentcode.com/pricing` | Standard $20 flat до 50 seats, Business $100 flat | 200 | supports |
| 67 | C3 | `https://www.augmentcode.com/context-engine` | «33% Lower Spend», «32% Fewer Tokens»; baseline — Claude Code, не «grep-based» | 200 | **partially supports** |
| 68 | C4 | `https://docs.devin.ai/onboard-devin/environment/blueprints.md` | один snapshot на org, up to 10 параллельных клонов, шаг 3 ч, refresh ~24 ч/неделя macOS, pin < 7 дней | 200 | supports |
| 69 | C4 | `https://docs.devin.ai/work-with-devin/dynamic-workflows.md` | `pipeline`/`parallel`, shared VM, resume по хешу, бюджет 7 дней | 200 | supports |
| 70 | C4 | `https://docs.devin.ai/cli/sandbox.md` | fail-closed «refuse to start», Windows hard-fail, bwrap/socat, network unstable | 200 | supports |
| 71 | C4 | `https://docs.devin.ai/admin/billing/usage.md` | ACU, sleep 5 мин, Windows ~9%, timeout 5–120 мин | 200 | supports |
| 72 | C4 | `https://devin.ai/pricing` | Free/Pro $20/Max $200/Teams $80+$40; «Up to 10»/«Unlimited» | 200 | supports |
| 73 | C4 | `https://docs.openhands.dev/sdk/arch/condenser.md` | `max_size=120`, `keep_first=4`, target 60, `forgotten_event_ids` | 200 | supports |
| 74 | C4 | `https://docs.openhands.dev/sdk/arch/agent-server.md` | unauthenticated default, `OH_SESSION_API_KEYS_*`, `X-Session-API-Key` | 200 | supports |
| 75 | C4 | `https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md` | startup/sandbox/execution states, включая `stuck` | 200 | supports |
| 76 | C4 | `https://docs.openhands.dev/sdk/guides/task-tool-set.md` | синхронные субагенты, resume по task ID, `tool_concurrency_limit` | 200 | supports |
| 77 | C4 | `https://docs.openhands.dev/sdk/guides/critic.md` | score 0–1, `success = score >= 0.5`, iterative refinement | 200 | supports |
| 78 | C4 | `https://ar5iv.labs.arxiv.org/html/2405.15793` | 12.47%, 10.46%, 18.00%, 13.00%, 87.7%, 89.7%, 87.9% | 200 | supports |
| 79 | C4 | `https://swe-agent.com/latest/faq/` | «superseded by mini-swe-agent», maintenance-only | 200 | supports |
| 80 | C4 | `https://docs.factory.com/autonomy-and-safety/sandbox` | Seatbelt/bubblewrap+seccomp, egress proxy, `denyWrite` overrides `allowWrite`, org denies | 200 | supports |
| 81 | C4 | `https://docs.factory.com/droid-computers/overview` | pool quantity 1–20, worker 1–50 default 3, slot 30 мин, passwordless sudo | 200 | supports |
| 82 | C4 | `https://docs.factory.com/benchmarks/terminal-bench` | 63.1 / 60.4 / 59.1 / 43.8 / 40.1 | 200 | supports |
| 83 | C4 | `https://learn.chatgpt.com/docs/cloud/internet-access.md` | default blocked, Off/On, presets None/Common dependencies, GET/HEAD/OPTIONS | 200 | supports |
| 84 | C4 | `https://cursor.com/docs/cloud-agent/self-hosted.md` | 10 000 workers per user/team; outbound HTTPS only | 200 | supports |
| 85 | C4 | `https://cursor.com/docs/cloud-agent/api/endpoints.md` | 500 repos, 50 env vars; 20 req/min здесь НЕ документированы (это `cursor.com/docs/api.md`) | 200 | **partially supports** |
| 86 | C4 | `https://antigravity.google/docs/subagents` | `invoke_subagent`, nesting 10, известный баг с typo tool name | 200 | supports |
| 87 | C4 | `https://docs.devin.ai/enterprise/security` | отчёт заявляет 404 — фактически 404 | 404 | supports |
| 88 | C4 | `https://docs.openhands.dev/openhands/usage/architecture` | отчёт заявляет 404 — фактически 404 | 404 | supports |

### 4.1. Сводка вердиктов

| Verdict | Кол-во |
|---|---:|
| supports | 82 |
| partially supports | 5 |
| does not support | 1 |
| unreachable (сетевой отказ) | 0* |
| **Итого строк** | **88** |

\* `hub.continue.dev` дал DNS-отказ, но это и есть утверждение отчёта («не резолвится»), поэтому строка засчитана как supports, а не как недоступность источника. Анонимный `api.github.com` давал 403 rate limit; метаданные перепроверены через `gh api` и совпали, поэтому строка 30 — supports.

Итог: **ни одной выдуманной ссылки не найдено**. Один URL (`Qwen Code architecture.md`) опровергает утверждение отчёта о недоступности; 5 URL поддерживают утверждение частично (неточность формулировки, статус-код или атрибуция).

## 5. Access dates and source quality

### 5.1. Даты доступа

| Отчёт | Заявленная дата | Где зафиксирована | Замечание |
|---|---|---|---|
| C1 | 2026-11-11 | строки 4–5, каждая ссылка | единообразно |
| C2 | 2026-11-11 | строка 4; UTC baseline `2026-11-11T09:49:16Z` | самый точный baseline |
| C3 | 2026-11-11 | строка 5; §8 у каждой строки | нет времени запроса |
| C4 | 2026-11-11 | строка 3; §8 у каждой строки | единообразно |

Все четыре отчёта используют одну дату доступа, совпадающую с датой аудита. Источники с другой фактической датой помечены корректно там, где это важно: C2 явно ставит `2025-12-18, accessed 2026-11-11` для Amp news; C4-marked бенчмарки Factory — «Last updated: December 2025»; C3 фиксирует «as of November 9, 2026» для модели/ставок Devin. Недатированных источников, выданных за датированные, не найдено.

### 5.2. Качество источников

- Доля первичных источников высокая: официальные docs, GitHub repo/API, paper (ar5iv), npm registry, first-party pricing/blog.
- Вторичные обзоры и «X vs Y» не использованы как единственная опора.
- Маркетинговые страницы присутствуют, но, как правило, помечены `claim`/CLAIM: C3 — 28 упоминаний, C4 — 15, C1 — 9, C2 — 4 (по `grep -c`).
- C1 и C2 явно фиксируют недоступные страницы как факт об источнике, а не как отсутствие функции.
- Слабые места:
  - C1: GitHub API данные собраны до rate limit; повторная сверка в этом аудите подтвердила релизы и лицензии, но не все звёзды/contents.
  - C3: не использован first-party источник о приобретении Windsurf (Cognition blog), хотя URL был запрошен.
  - C4: атрибуция Amp как «Sourcegraph Amp» устарела; `ampcode.com/llms.txt` и homepage не упоминают Sourcegraph.
  - Цены — снимок; ни один отчёт не утверждает, что тарифы стабильны, и это корректно оговорено.

## 6. Fact vs claim audit

### 6.1. Claims, поданные как факт, но опирающиеся только на marketing/pricing

| Отчёт | Утверждение | Источник | Оценка |
|---|---|---|---|
| C1 | Aider polyglot: gpt-5 (high) 88.0% при $29.08 | `aider.chat/docs/leaderboards/` | корректно помечено CLAIM в §7, но в §3.5 стоит FACT-строка с теми же числами — двойная метка |
| C1 | Qwen Code 76.40–77.80% SWE-bench Verified | README | корректно CLAIM |
| C1 | Gemini CLI «Enterprise Code Assist only» | README | метка CLAIM допустима по конвенции C1 (заявление вендора), но статус не отражён в позиционировании, §5.1 и матрице — это фактическая неполнота, а не ложь |
| C2 | Kilo «500+ моделей», «zero markup» | `kilo.ai/llms.txt`, pricing | помечено claim; в §3.2 часть цифр подана как факт тарифной страницы — допустимо, но требует пометки «опубликовано вендором» |
| C2 | Amp «profitable»/«3M developers»/«10 трлн токенов» | marketing | в §8.4 перечислены как claim — корректно |
| C3 | Augment «33% Lower Spend / 32% Fewer Tokens» | context-engine | корректно claim |
| C3 | Junie «Proven in Benchmarks»/SWE-Rebench | marketing | корректно claim |
| C3 | Cursor «no limit on tool calls» | docs | подан как факт docs, но это продуктовое утверждение вендора — приемлемо при текущей конвенции C3 (`confirmed` = вендор это документирует) |
| C4 | Factory benchmarks (63.1%, 1330, 66%, F1 60.5%) | vendor benchmark pages | корректно CLAIM |
| C4 | mini-SWE-agent «>74% Verified», «beats Claude Code and Codex» | README | корректно CLAIM |
| C4 | Devin concurrency «Up to 10 / Unlimited» | pricing | корректно CLAIM |
| C4 | Antigravity «Available at no charge» | product page | корректно CLAIM |

### 6.2. Явно помеченные CLAIM

Все четыре отчёта используют явную метку и не смешивают её с FACT в таблицах механик. Подсчёт: C1 — 9, C2 — 4, C3 — 28, C4 — 15 вхождений метки. Для C2 меньшее число объясняется тем, что метка `claim` стоит в таблице покрытия и §8, а не в каждом абзаце.

### 6.3. Проверка на фабрикации

Проверялись: названия флагов/ключей, номера событий, лимиты, цены, лицензии, даты релизов, статусы archived/read-only, acquisition/shutdown.

- **Выдуманных функций не найдено.** Все проверенные конкретные строки (например, `project_doc_max_bytes = 32768`, `requires_approval`, `last matching rule wins`, `denyWrite overrides allowWrite`, `subagent:16`, `teammates.db`) присутствуют в источниках.
- **Неверных лицензий не найдено.** Codex Apache-2.0; Claude proprietary; Gemini Apache-2.0; OpenCode MIT; Aider Apache-2.0; Qwen Apache-2.0; Cline Apache-2.0; Kilo MIT (клиенты); Roo Apache-2.0; Continue Apache-2.0; Goose Apache-2.0; OpenHands MIT; SWE-agent MIT; Amp Commercial; Zed GPL-3.0-or-later + Apache-2.0 components; остальные — проприетарные.
- **Неверных acquisition/shutdown статусов не найдено.** Roo archived 2026-05-15; Continue read-only и acquired by Cursor; Kilo приобретён Anaconda 2026-07-15; Windsurf → Devin Desktop; Cursor приобретён SpaceX 2026-08-14; Goose → AAIF/Linux Foundation.
- **Выдуманных URL не найдено.** Все 88 строк таблицы разрешились (200/404/redirect) либо дали DNS-отказ, который отчёт и утверждает.
- **Одна содержательная фактическая ошибка:** Qwen Code `docs/developers/architecture.md`. Отчёт C1 утверждает, что страница не отдалась и agent loop = UNKNOWN; страница отдаёт 200 и 13 043 байта, включая «packages/core owns the agent loop… enters the agent/tool loop».
- **Одна устаревшая атрибуция:** «Sourcegraph Amp» в C4. Первичные страницы Amp не содержат упоминаний Sourcegraph; `sourcegraph.com/amp` 301→`ampcode.com`.
- **Одна неточность статус-кода:** C3 §1.5/§8.3 указывает 307 для `docs.windsurf.com`; фактически 308 (как и `windsurf.com`).
- **Один неверно закрытый gap:** C3 §7 Q15/§8.3 утверждает, что тело `kiro.dev/docs/acp/` не получено; тело доступно и описывает ACP-интеграцию.

## 7. Cross-competitor contradictions

| # | Что противоречит | Где | Источник-победитель | Комментарий |
|---:|---|---|---|---|
| 1 | «Amp — единственный полностью закрытый агент» vs 8+ закрытых продуктов в C3/C4 | C2 §4.8 против C3 §3.2–3.9, C4 §3 | C3/C4 | Верно только внутри шести продуктов C2. Нужна оговорка «среди шести»; иначе утверждение ложно (Cursor, Copilot, Devin, Kiro, Trae, Augment, JetBrains, Factory — закрытые). |
| 2 | Статус Gemini CLI: активный терминальный агент vs enterprise-only legacy | C1 §3.3/§5.1 против README `google-gemini/gemini-cli` | README + Google transition post | README прямо: «Enterprise Code Assist only», «No free tier or Google AI plans», free/Google AI переведены на Antigravity CLI 2026-06-18, «Not optimized for Gemini 4+». C1 обязан перенести это из CLAIM в FACT и отразить в позиционировании; C4 должен связать Antigravity с миграцией. |
| 3 | C1: «самый прозрачный OSS-процесс: architecture-документ» vs «отдельной architecture-страницы нет» | C1 §5.1 против C1 §7 | C1 §7 | Несогласованность формулировок: `docs/architecture.md` — 404, есть только `docs/core/index.md`. §5.1 нужно сузить до «core/index.md + release train». |
| 4 | C3: Windsurf → Devin Desktop (Cognition) без ссылки vs C4: Devin (Cognition) | C3 §1.2 против C4 §2 | `cognition.com/blog/windsurf` | C3 §8.3 сам пишет, что блог запрошен, но «для утверждений не использован». First-party источник доступен: заголовок «Cognition’s acquisition of Windsurf». |
| 5 | C2 «Amp» vs C4 «Sourcegraph Amp» | C2 §3.6 против C4 §2/§8 | `ampcode.com/llms.txt`, `ampcode.com` | Брендинг Sourcegraph в первичных страницах отсутствует; `sourcegraph.com/amp` 301→`ampcode.com`. Правильное имя — Amp (ampcode.com). |
| 6 | C3: ACP Kiro «не проверено» vs фактическая доступность страницы | C3 §7 Q15/§8.3 | `kiro.dev/docs/acp/` | Страница 200 и содержит описание ACP client→Kiro harness. Gap можно закрыть, противоречия с другими отчётами нет. |
| 7 | Бенчмарки: C4 vs C1/C2/C3 | C4 §3.5 против C1 §3.5, C3 §3.2 | Ничья (разные продукты) | Числа Factory (Terminal-Bench, Agent Arena, Next.js, Review) воспроизведены точно по вендорской странице; пересечений с числами Aider/Cursor нет, поэтому противоречий не возникает. Оба набора — vendor-only. |
| 8 | Sandbox availability | C1 (Codex default sandbox) против C2 (Kilo off by default) и C3 (Kiro off by default) | Соответствующие docs | Не противоречие: разные продукты. Единая формулировка «sandbox by default» неверна для рынка в целом — это стоит явно сказать в синтезе. |
| 9 | Cursor plan/pricing | C3 §3.2 против `cursor.com/pricing` | pricing page | Совпадает: Free $0/Plus $8/Premium $30/Super $100/Ultra $200, Teams $30+, недельный пул. |

Победитель определяется по правилу: первичная страница вендора на 2026-11-11 важнее сводки другого partial; при конфликте docs vs marketing выигрывает docs, если marketing не датирован; при конфликте двух docs-страниц фиксируется противоречие, а не выбирается удобная.

## 8. Anti-pattern evidence audit

Проверено 12 «do not copy» утверждений (минимум по заданию — 10): C1 — 4, C2 — 4, C3 — 2, C4 — 2; фактически проверено 12 строк таблицы в этом разделе. Критерий: есть URL и причина, а причина не является чистой вкусовщиной.

| # | Anti-pattern | Отчёт | URL | Причина | Evidence-статус |
|---:|---|---|---|---|---|
| 1 | Fail-open hooks (Gemini: non-JSON stdout → Allow) | C1 §6.7 | `raw…/docs/hooks/index.md` | ошибка hook разрешает действие | подтверждено дословно |
| 2 | Unauthenticated local daemon с code execution (Qwen) | C1 §6.7 | `raw…/README.md` | любой локальный процесс получает API | подтверждено дословно |
| 3 | Sandbox only for shell (Claude Code) | C1 §6.7 | `code.claude.com/docs/en/sandboxing` | Read/WebFetch/MCP вне границы | подтверждено дословно |
| 4 | Parsed but not sent (OpenCode V2 `request`) | C1 §6.7 | `opencode.ai/docs/agents/` | ложное ожидание работающей настройки | подтверждено дословно |
| 5 | `requires_approval` без статического allowlist (Cline) | C2 A3 | `docs.cline.bot/features/auto-approve` | «examples, not guarantees» | подтверждено дословно |
| 6 | Sandbox off by default, write-only (Kilo) | C2 A5 | `kilo.ai/docs/getting-started/settings/sandboxing` | чтение не ограничено; Windows не поддержан | подтверждено дословно |
| 7 | Кеш project-config без перечитывания (Kilo) | C2 A6 | `kilo.ai/docs/getting-started/settings/auto-approving-actions` | правка правил «на лету» не применяется | подтверждено дословно |
| 8 | Режим фиксируется на весь тред (Amp) | C2 A11 | `ampcode.com/docs/markdown/the-dial` | нельзя усилить модель без нового треда | подтверждено дословно |
| 9 | Противоречивая документация sandbox (Trae) | C3 P1 | T6 + T8 (payload) | пользователь не может построить модель угроз | оба предложения найдены в payload |
| 10 | Permissions не enforced в IDE-расширении (Augment) | C3 P3 | `docs.augmentcode.com/cli/permissions` | одна установка расширения обходит контроль | подтверждено дословно |
| 11 | Sandbox «defense in depth», не hard boundary (Factory) | C4 §6.2 | `docs.factory.com/autonomy-and-safety/sandbox` | allowed egress может утекать данные | подтверждено дословно |
| 12 | Autosubmit при ошибке/лимите (SWE-agent) | C4 §6.2 | `swe-agent.com/latest/reference/agent/` | незавершённая работа выглядит как submission | метод `attempt_autosubmission_after_error` подтверждён; отсутствие failed-state — вывод, а не цитата |

### 8.1. Проблема структуры anti-pattern таблиц

- **C1 §6.7 — единственная таблица без колонки URL.** Причины сформулированы как мнения («лучше одна модель», «нужен явный статус»), но опираются на факты из §3, где URL есть. Формально требование «URL + reason» не выполнено в самой таблице; содержательно — выполнено в §3/§7. Рекомендация: добавить колонку Source ID, как в C4.
- C2 A13 и C3 P10/P14/P15 ссылаются на несколько источников через ID/§, а не прямым URL в строке; ID разрешаются в §8. Это допустимо, но затрудняет автоматическую проверку.
- C4 — лучший формат: каждая строка имеет `[ID]`, ID разрешается в §8 с датой.

Все 12 проверенных причин являются проверяемыми утверждениями о продукте, а не вкусовщиной. Единственное исключение — C4 «Autosubmit»: тезис «источник не описывает отдельный failed-state» — это аргумент от отсутствия в документации, а не цитата; сам отчёт это признаёт.

## 9. Repository state confirmation

### 9.1. Состояние после аудита

```
$ git status --short
?? docs/research/

$ git diff --stat
(пусто)
```

- Изменены/созданы только файлы под `docs/research/` (untracked-каталог, существовавший до аудита).
- Продакшн-код, `package.json`, lockfile, конфиги, тесты не изменялись.
- Коммиты не создавались, пакеты не устанавливались, продукты не запускались.
- Единственная запись этого аудита — `<repo-root>/docs/research/partials/2026-11-11-verification-competitor-sources.md`.

### 9.2. Выполненные проверки и результаты

| Проверка | Команда/инструмент | Результат |
|---|---|---|
| Preflight | `git status --short`, `git branch --show-current`, `git log -1 --oneline` | `?? docs/research/`; `dev`; `d10f0b69` |
| Свежесть базы | `node scripts/check-workspace-freshness.mjs` | exit 0, «базовая свежая, ahead 344 / behind 0» |
| Наличие файлов | `ls -la`, `wc -l` | 4 файла, 753/692/989/572 строки |
| Заголовки | `grep -n '^## '` | 1–8 во всех файлах |
| URL-статусы | `curl -sSL -w '%{http_code} %{url_effective}'` | 87 строк, см. §4 |
| GitHub-метаданные | `gh api repos/<owner>/<repo>` | лицензии, archived, pushed_at, releases совпали |
| Redirect-цепочки | `curl -D -` | `sst/opencode` 301; `developers.openai.com` 308; `windsurf.com` 308; `roocode.com` 301 |
| Цитаты | `curl … \| grep` и `WebFetch` | 60+ цитат сверены с телом страницы |
| Даты доступа | `grep` по шапкам и §8 | 2026-11-11 во всех четырёх |

### 9.3. Что не проверено (gaps)

- Не проверены все 610 уникальных URL из четырёх отчётов; аудит выборочный (88 строк в таблице = 88 запрошенных URL, плюс ~60 точечных повторов цитат и проверка редиректов).
- Не проверялась полнота описания каждого продукта (например, все ли режимы Kilo, все ли модели Kiro перечислены).
- Не проверялись: jetbrains agent-skills (J7), Kilo Auto Model (маршрутизация `kilo-auto/*`), Kiro enterprise deployment (K22/K23), Trae on-demand billing (T16), Antigravity hybrid execution (G9), Zed collaboration (Z16), Devin Outposts (D9/D10), Copilot OTel (C4 §3.6), Cursor OTel (C3 §3.2), Continue JetBrains preference (C2 §5.4), Goose GDK/ACP (C2 §5.5).
- Не воспроизводились бенчмарки и не покупались тарифы; все числа — снимок опубликованных страниц.
- Не проверялась юридическая корректность лицензий (например, применимость MIT к клиентам Kilo при source-available Gateway/Cloud).

### 9.4. Итоговая оценка (для родительского синтеза)

- **Readiness: ready-with-corrections.** Фабрикаций, выдуманных URL и неверных лицензий/статусов не обнаружено. Все обязательные продукты, кроме Copilot Workspace как отдельного продукта, покрыты первичными источниками.
- **Обязательные исправления перед синтезом:**
  1. C1: Qwen `architecture.md` доступен, loop описан — снять UNKNOWN и обновить §3.6/§7.
  2. C1: Gemini CLI — перенести enterprise-only/migration на Antigravity CLI в позиционирование §3.3, §5.1 и матрицу; метку CLAIM можно оставить, но статус обязан быть виден в выводах.
  3. C1: §5.1 «architecture-документ» несогласован с §7 — сузить формулировку.
  4. C1: Codex `docs/config.md` — в основном заглушка, но содержит раздел Lifecycle hooks; формулировку «только ссылки-заглушки» уточнить (для `docs/sandbox.md` она верна).
  5. C2: «Amp — единственный закрытый» — добавить «среди шести».
  6. C3: `docs.windsurf.com` redirect — 308, не 307.
  7. C3: Kiro ACP — страница доступна, gap закрыть.
  8. C3: Augment Context Engine baseline — сравнение с Claude Code, не «grep-based агент»; методология на странице минимальна.
  9. C3: добавить ссылку `cognition.com/blog/windsurf` для атрибуции Windsurf → Cognition.
  10. C4: заменить «Sourcegraph Amp» на «Amp (ampcode.com)».
  11. C4: 20 req/min для Cursor API — источник `cursor.com/docs/api.md`, не endpoints.md.
- **Contradictions:** см. §7; критичных для выводов нет, кроме статуса Gemini CLI (п. 2) и scope-оговорки Amp (п. 5).
