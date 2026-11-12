# ZCode: широкое исследование системы и сравнение с агентными средами разработки

Дата: 2026-11-11. Ветка: dev. HEAD: d10f0b69. Статус: complete (с явно зафиксированными ограничениями).

Канонический корпус: 19 partial-файлов (`docs/research/partials/2026-11-11-zcode-01…15`, `competitors-c1…c4`) и 3 файла верификации (V1 — ZCode evidence, V2 — competitor sources, V3 — coverage/compliance). Все material-коррекции V1 (§6, §7), V2 (§9.4) и V3 (§8) применены; где число partial расходится с перепроверкой, использовано перепроверенное значение и это указано.

Обозначения достоверности: **Observed** — источник или команда проверены; **Inferred** — вывод из проверенных фактов, не подтверждённый runtime; **Unknown** — данных нет. Отчёт не содержит runtime-прогонов продукта: ни один десктопный бинарник, E2E-набор, живой provider, relay или marketplace не запускался.

## 1. Executive summary

ZCode — это многослойная агентная среда: Electron-десктоп (main + window-scoped Host + renderer), web-клиент и HTTP/WS-сервер, мобильный remote по relay, CLI/runtime с собственным agent loop, четыре wire-формата провайдеров, 16-ролевой субагентный каталог, `.agents/skills` и два протокола (legacy v1 и V4 wire v3). Инженерная база сильнее среднего для рынка: architecture-as-code на 107 модулях, 14-шаговый pre-push, 3131 unit-файл вне desktop E2E, 575 E2E-спек, 909 CLI-тестов, V4 wire с CRC/сборкой/ordinal tombstones, CommandInbox с идемпотентностью и durable fallback, plugin-sandbox с отдельным origin и строгим CSP.

Одновременно исследование подтвердило девять дефектов уровня P0 (раздел 4), из которых четыре — прямые ложные гарантии безопасности:

1. **Project-scope MCP доверен по умолчанию.** `untrustedProjectMcpServers` создаётся пустым в двух местах (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:74-76`, `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:116-121`), то есть repo-контролируемый `.zcode/config.json` может запустить stdio-команду без подтверждения. Спека `docs/runtime-tools/mcp-status-list-control-plane.md:16,30` утверждает обратное — документ и код противоречат друг другу.
2. **Plugin hooks третьих сторон исполняются без trust gate.** `canRunPluginHooks` возвращает `true` (`apps/zcode-cli/packages/adapters/src/plugins/index.ts:371-376`), хотя `docs/claude-code-marketplace-plugin-compat.md:274-275` обещает фильтрацию.
3. **Граница workspace намеренно открыта.** `resolveWorkspacePath` возвращает путь вне `workspaceRoot` (`apps/zcode-cli/packages/core/src/tool/path-policy.ts:32-39`) — это документированное решение ради sibling-репозиториев, но оно превращает prompt injection в произвольное чтение/запись файлов пользователя.
4. **Bash sandbox — no-op.** Поле `sandbox` формируется (`apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:458-461`), telemetry пишет `sandboxed` (`:328`), но `adapters/src/exec/*` его не читает (rg по `request.sandbox` пуст). Пользователь и модель видят гарантию изоляции, которой нет.

К остальным P0 относятся: жёсткий `disallowedTools` обходится в `yolo`/`guarded` (allow-ветка стоит раньше deny, `apps/zcode-cli/packages/core/src/permission/service.ts:169-189`); `permissionTimeoutMs` нигде не присваивается, approval может ждать без таймаута (`core/src/permission/broker.ts:108-126`); полный request body (prompt + 670 сообщений + 18 tool-схем) попадает в CLI JSONL и support bundle (строки до 1.46 MB, `core/src/runtime/helpers/turn-errors.ts:326-334`); главное окно Electron не имеет CSP и не имеет `will-navigate`/`setWindowOpenHandler` (`packages/desktop/src/main/desktopWindowChrome.ts:591-614`, `packages/desktop/src/renderer/index.html`); RPC-кадр не имеет верхней границы и битый кадр роняет процесс (`packages/rpc/src/protocol.ts:274-278`, `packages/rpc/src/channelServer.ts:68-98`); owner/lease/mirror-слой реализован, но не подключён (`packages/desktop/src/host/index.ts:3985-3992`, `:1428-1492`), с оговоркой, что mobile mirror мог быть намеренно отключён.

Важное уточнение V1, которое отчёт соблюдает буквально: **главное окно не задаёт `sandbox` явно, но это не означает отсутствия sandbox** — Electron с версии 20 включает его по умолчанию (`node_modules/electron/electron.d.ts:18827`, «Default is `true` since Electron 20»). Подтверждённые gap'ы главного окна — отсутствие CSP и отсутствие navigation/popup guard; plugin-sandbox и гостевые `<webview>` имеют `sandbox=true`.

Конкурентное сравнение даёт три вывода. Во-первых, у ZCode нет ни одного продуктового пробела «всё отсутствует»: agent loop, MCP, skills, subagents, checkpoints, remote/mobile, marketplace и cost-UI существуют. Во-вторых, разрыв сосредоточен в четырёх областях: (а) execution boundary — Codex, Kiro, Windsurf/Devin, Factory, Copilot и Antigravity документируют OS-sandbox и явные deny/ask/allow-модели, ZCode — нет; (б) delivery loop — PR/CI-контур отсутствует у ZCode полностью, тогда как Cursor, Copilot, Devin, Factory и Kiro его имеют; (в) context/memory — ZCode имеет compaction, но без общего token-бюджета, семантический recall выключен, Dream не подключён; (г) cost — `cost` жёстко `0` в пяти production-путях, при этом UI показывает расчёт `tokenlens`. В-третьих, рыночный паттерн — конвергенция к открытым форматам (`SKILL.md`, ACP, MCP) и к явным статус-машинам сессий; ZCode силён в первом (skills, MCP client, ACP client) и слаб во втором (нет durable task journal для обычных Agent/Task, нет mid-turn resume).

Итоговая оценка: инженерно — сильный продукт с четырьмя ложными гарантиями безопасности и одним крупным продуктовым пробелом (delivery loop); стратегически — обороноспособная позиция в desktop/mobile-continuity и слабая в IDE-интероперабельности (нет LSP, нет ACP-сервера, `NotebookEdit` зарезервирован без handler'а).

## 2. Карта исследованных областей

### 2.1. 25 тем миссии

Карта построена по фактическим 19 partial, а не по раннему снимку Z01: Z01 утверждал, что существуют только Z01–Z10 и темы 19–25 не покрыты (V3 V-01/V-02). Это верно только для состояния Z01 на 10:42; итоговые Z11–Z15 закрывают темы 19–25, кроме performance и multiplatform, которые сами помечены partial. Z16 в корпусе отсутствует.

| # | Тема | Ветки | Что проверено | Статус | Evidence anchor |
|---:|---|---|---|---|---|
| 1 | Desktop | Z02 (+Z05, Z11, Z12) | main lifecycle, окна/chrome, tray/menu, Host lifecycle, attachment, stdio, IPC-инвентарь, update/packaging, кросс-платформенные модули, два узких unit-прогона | полный (без запуска Electron) | Z02 §2–§3, §4 R1–R7 |
| 2 | Web/server | Z03 | web-структура, OAuth, share, mobile remote, HTTP ingress, stdio/remote deploy, ops, 128 запущенных тестов | полный (без живого relay) | Z03 §3.1–3.10, §4 |
| 3 | UI | Z04 | токены, focus, a11y, i18n, store/broadcast, layout, perf, тесты; Chromium-пробы фокуса | полный (без screen-reader) | Z04 §3–§4 |
| 4 | Services | Z05 | композиция, session lifecycle, event flow, карта владения, CommandInbox | полный (часть lifecycle — без runtime) | Z05 §3, §4 G1–G14 |
| 5 | RPC/shared | Z06 | 7 слоёв, транспорты, V1/V4, serialization, identity, client SDK | полный (без fuzz/reconnect runtime) | Z06 §3.2–3.5 |
| 6 | Client SDK | Z06 | публичный API, 58 прокси, WS/MessagePort, relay-адаптеры | полный (тонко: один подраздел) | Z06 §3.5, R6 |
| 7 | CLI/runtime | Z07 (+Z08–Z11) | agent loop, approvals, errors, limits, admission, streaming, context, тесты | полный (без provider E2E) | Z07 §3.1–3.8 |
| 8 | Architecture/event model | Z05, Z06, Z01, Z14, Z10 | слои, ownership, порядок событий, протокол | полный (фрагментировано по ветвям) | Z05 §3.4–3.5; Z06 §3.3; Z01 §3.4 |
| 9 | Agent loop | Z07 | turn machine, model step, tool step, stop, swarm planner | полный (без живого provider-loop) | Z07 §3.1, §4.1 |
| 10 | Tools | Z08 | 47 tool entries, матрица возможностей, Bash/exec, patch, code index | полный (без Windows/PTY) | Z08 §3.1–3.5 |
| 11 | Context/memory | Z09, Z07 | ContextBuilder, micro/auto/reactive compact, MEMORY.md, recall, Dream | полный (recall/Dream выключены) | Z09 §3.1, §3.3; Z07 §3.7 |
| 12 | Rules/skills/plugins/MCP | Z09 | discovery, precedence, marketplace, plugin lifecycle, MCP dual-era/OAuth | полный (без сетевого MCP runtime) | Z09 §3.2–3.6 |
| 13 | Subagents/orchestration | Z10 | 16 ролей, ledger, DAG, swarm, fabrication, workflow | полный (dynamic workflow — частично) | Z10 §3.1–3.5 |
| 14 | Models/routing | Z08, Z15 | 4 wire-формата, registry, selection, quota fallback, планы | полный (нет matrix всех tool-фич) | Z08 §3.6; Z15 §3.2 |
| 15 | Sandbox/permissions/security | Z12, Z07, Z08 | trust-boundary table, permission order, secrets, web security, supply chain | полный (sandbox не enforced) | Z12 §3.1–3.10 |
| 16 | Git/PR | Z13 | CLI-слой, UI-поверхности, commit message, PR/CI отсутствие | полный (нет PR-контура в продукте) | Z13 §3.1–3.5 |
| 17 | IDE/editor + mobile/remote | Z13, Z03, Z02, Z04 | code viewer, LSP/notebook отсутствие, remote/mobile, mobile shell | полный (IDE-половина — негативный вывод) | Z13 §3.6; Z03 §3.4 |
| 18 | Protocols/interop | Z10, Z06, Z08 | ZCode Protocol, MCP, ACP, LSP, MCP-as-server | полный (ACP только client; LSP нет) | Z10 §3.6; Z06 §3.3 |
| 19 | Telemetry/evals/metrics | Z11, Z15 | telemetry core, ARMS, OTel, privacy, funnel, delivery | полный (нет SLO и quality-evals) | Z11 §3.1–3.7; Z15 §3.6 |
| 20 | Performance | Z11, Z04 | бандл, startup, TTFT, memory diagnostics, large-file | частично | Z11 §3.8, §4.12; Z04 §3.9 |
| 21 | Reliability | Z11, Z05, Z02 | retry/recovery, crash budget, shutdown, host exit, leaks | полный (без soak/crash runtime) | Z11 §3.9–3.10; Z05 §4 |
| 22 | Multiplatform | Z02, Z14, Z13 | 49 файлов `process.platform`, packaging 3 ОС, Windows-док, Android orphan | частично | Z02 §3.8; Z14 §3.5; Z13 §3.8 |
| 23 | Monetization/product | Z15, Z01 | планы/entitlements/quota, billing webview, marketplace, onboarding | полный (без checkout) | Z15 §3.2–3.5 |
| 24 | Testing/CI/quality | Z14, Z01 | сбор тестов, 14 шагов pre-push, CI, release, E2E | полный (без полного прогона) | Z14 §3.1–3.4 |
| 25 | Docs/DX | Z14, Z01 | 2088 md, drift, индекс, bootstrap, contribution | полный (без проверки содержимого всех документов) | Z14 §3.6–3.7, §4.1 |

Счёт: 23 темы покрыты (из них тема 6 — тонко, тема 8 — фрагментировано), 2 — частично (20, 22), 0 — не покрыто. Это и есть основание статуса `complete`: все 25 тем имеют evidence-якоря, а два partial-статуса и все непроверенные области перечислены явно.

### 2.2. Верхнеуровневые области

| Область | Покрывающая ветка | Вердикт содержательной полноты |
|---|---|---|
| `packages/desktop` | Z02 (+Z05, Z11, Z12) | substantive: 7 рекомендаций, 76 unit-тестов прогнано, lifecycle/attachment/stdio |
| `packages/web` | Z03 | substantive: 128 тестов прогнано, OAuth/share/remote/ingress |
| `packages/server` | Z03 | substantive: HTTP ingress, stdio, remote deploy, source-server |
| `packages/ui` | Z04 (+Z15, Z13) | substantive: токены, focus, a11y, i18n, 86 тестов в 5 прогонах |
| `packages/services` | Z05 | substantive: ownership map, lifecycle, 164 теста в 4 прогонах |
| `packages/rpc` | Z06 | substantive: 7 слоёв, 71 тест, пробы oversize/malformed |
| `packages/shared` | Z06 (+Z09, Z11) | substantive: protocol, identity, platform, validation |
| `packages/client` | Z06 | substantive (тонко): один подраздел, reconnect/auth — gap |
| `packages/provider` | Z08 | substantive: registry, selection, effective-model |
| `packages/zcode-server-cli` | Z13, Z03 | substantive: ingress auth, capability, static отсутствует |
| `packages/web-share` | Z03, Z13 | substantive (малый объём): entry, mock, deploy-docs drift |
| `packages/zcode-cua` | Z13, Z01 | substantive: fail-closed заглушка, 2 теста |
| `packages/android` | Z13 | substantive по коду, **без сборки**: orphan, нет `package.json`/CI |
| `apps/zcode-cli` | Z07 (+Z08–Z11) | substantive: 725 строк partial, 10 рекомендаций, 357 тестов в узких прогонах |
| `apps/dev-docs` | Z14, Z13 | substantive: 4 теста, красный feature-graph |
| `scripts/` | Z01, Z13, Z14 | substantive: 110 записей верхнего уровня, 100 tracked top-level, 36 тестов + 1 fixture |
| `.github/` | Z01, Z02, Z14 | substantive: единственный ручной workflow |
| `.agents/` | Z01, Z09 | substantive: 32 skill-каталога |
| `third-party/` | Z13, Z01 | substantive как release-input: 1219 packages, 19 reviewRequired |
| `docs/` | Z14, Z01 | substantive по структуре и drift; содержимое 2088 документов не проверялось систематически |

Области **только на уровне инвентаря** (без архитектурного разбора; это не «пробел», а явно зафиксированная граница):

- `packages/model-option-map` — 2 теста, 867 строк; только строка инвентаря и зависимость `shared`.
- `packages/provider-node` — 27 тестов, 1931 строка; только списки зависимостей.
- `patches/` — 8 patch-файлов для `pnpm.patchedDependencies`, не разобраны.
- `config/` — `default.json` и `provider/zcode-builtin*.json`, не разобраны.
- `public/` — лого/иконки, только инвентарь.
- `packages/share-ui` — 6 строк `src` (wc -l packages/share-ui/src/index.ts), 59 dependencies; тонкая обёртка.
- `packages/formal-proof` — dev-tool, 0 тестов, 2400 строк.
- `packages/stream-animate` — dev-tool, 0 тестов, 2368 строк.
- `packages/e2e-report` — test-tooling, 0 тестов.
- `.zcode/` — только `evaluation-cases.json`; `.zcode/agents/` отсутствует.
- Корневой `specs/` — один файл `zcode-unified-distribution.md`.
- `packages/android` — покрыт по коду, но без сборки и CI.

Ни одна из этих областей не влияет на P0-выводы: все они либо dev-tooling, либо тонкие обёртки, либо release-input. Но их непокрытие означает, что отчёт не даёт гарантий по их поведению.

## 3. Сравнительная таблица возможностей ZCode и конкурентов

Матрица 20×4. Колонка «конкуренты» содержит первичный источник со страницы, открытой 2026-11-11; при отсутствии прямого аналога это указано. Вердикт: сильнее / паритет / слабее / отсутствует.

| Возможность | ZCode (file:line) | Конкуренты (URL, 2026-11-11) | Вердикт |
|---|---|---|---|
| Agent loop и лимиты шагов | `maxTurns` есть в типах, но CLI-флага и продуктового поля нет; без значения лимита нет (`core/src/runtime/methods/turn-loop.ts:49-55,116-125`; `core/src/runtime/types.ts:144`) | Codex exec с `--output-schema` и лимитами; Claude Code `maxTurns` во frontmatter субагента (https://code.claude.com/docs/en/sub-agents); Goose `--max-turns` default 1000 (https://goose-docs.ai/docs/guides/config-files.md) | слабее (нет пользовательского рычага) |
| Approvals / sandbox | `DenyPermissionBroker` по умолчанию, fail-closed (`core/src/runtime/agent-runtime.ts:332-333`); OS-sandbox для Bash отсутствует (no-op) | Codex: OS sandbox default + network off + approvals отдельно (https://learn.chatgpt.com/docs/agent-approvals-security); Factory: Seatbelt/bwrap + egress proxy (https://docs.factory.com/autonomy-and-safety/sandbox) | слабее (fail-closed policy есть, enforcement нет) |
| Permission engine | 16-шаговый порядок, `guarded` user-once, project rules; `yolo`/`guarded` обходят `disallowedTools` (`core/src/permission/service.ts:169-189`) | Kiro: deny>ask>allow, парсинг compound-команд (https://kiro.dev/docs/permissions/); OpenCode: last-match-wins + shell scanner (https://opencode.ai/docs/permissions/) | паритет по модели, слабее по enforcement |
| Context / compaction | ContextBuilder + micro/auto/reactive + rapid-refill breaker (`core/src/compact/policy.ts:6-14`; `runtime/methods/compact.ts:184-300`); общего token-бюджета нет | Kilo: `tail_turns=2`, prune 40000, clamp 2000–8000, reserved `min(20000,max_out)` (https://kilo.ai/docs/customize/context/context-condensing); OpenHands condenser `max_size=120`, `keep_first=4` (https://docs.openhands.dev/sdk/arch/condenser.md) | паритет по механике, слабее по управляемости |
| Memory | File-based project memory + MEMORY.md; semantic recall выключен, Dream не подключён (`memory/project-memory-retrieval-branch.ts:3-14`; `runtime/helpers/project-memory-dream.ts:54`) | Claude Code auto memory + imports (https://code.claude.com/docs/en/memory); Devin knowledge/playbooks (https://docs.devin.ai/get-started/devin-intro.md) | слабее |
| Skills / rules | `.agents/skills`, merge `.zcode`+`.agents`, marketplace; precedence user > project вопреки продукт-доку (`adapters/src/skills/roots.ts:46-55`); `ruleTargetPaths` не производится | Agent Skills принят Copilot/Devin/Zed/Kiro/JetBrains/Augment (https://docs.github.com/en/copilot/concepts/agents/copilot-on-github); Cursor rules с 4 режимами (https://cursor.com/docs/context/rules) | паритет по формату, слабее по предсказуемости |
| MCP | Клиент: stdio/http/sse, dual-era negotiation, OAuth two-phase; server — только invocation-scoped bridge (`adapters/src/mcp/index.ts:2328-2383`) | Goose MCP-native + malware check + MCP Roots (https://goose-docs.ai/docs/getting-started/using-extensions.md); Cline/OpenCode MCP-клиенты | сильнее по negotiation, слабее по trust |
| Plugins / marketplace | install/update/rollback, sha256 для CDN zip, orphan/restorable; нет подписи/provenance, нет compat-metadata (`contracts/src/plugins/index.ts:144-166`) | Amp skills/plugins; Cursor Marketplace с team modes (https://cursor.com/changelog); JetBrains ACP-реестр агентов (https://www.jetbrains.com/help/ai-assistant/agents.html) | паритет по lifecycle, слабее по trust-сигналам |
| Subagents / orchestration | 16 ролей, caller-policy, ledger claims, DAG, durable Swarm journal; `write_paths` не блокирует Write/Edit (`core/src/runtime-task/registry.ts:2036-2107`) | Cursor Explore/Browser + Projects coordinator (https://cursor.com/docs/subagents.md); Kiro DAG-субагенты (https://kiro.dev/docs/permissions/); Antigravity nesting 10 (https://antigravity.google/docs/subagents) | сильнее по каталогу ролей, паритет по DAG |
| Checkpoint / resume | File-mutation checkpoints + artifact store; незавершённые tool parts синтезируются failed, pending steer отбрасывается (`agent/session-history-hydrator.ts:49,228-240`; `runtime/methods/steering.ts:1373-1404`) | Cline shadow-git после каждого tool use с 3 режимами restore (https://docs.cline.bot/core-workflows/checkpoints); Gemini CLI checkpointing (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md) | слабее (нет mid-turn resume) |
| Git / PR | Настоящий git CLI, stage/commit/push, commit-message generator; PR/CI ingestion отсутствует (`grep 'gh pr create'` = 0; `packages/services/src/git/repo/gitCliRepo.ts:1423-1673`) | Cursor Bugbot + Agent Review + PR-статусы (https://cursor.com/docs/bugbot.md); Copilot Agent Merge; Devin stacked PRs (https://docs.devin.ai/work-with-devin/stacked-prs.md) | слабее (delivery loop отсутствует) |
| Editor / LSP | CodeViewer только чтение; LSP — имя в сортировке без handler'а (`core/src/tool/provider-visible-order.ts:16`); `NotebookEdit` зарезервирован (`handlers/edit.ts:193-198`) | OpenCode LSP diagnostics (https://opencode.ai/docs/lsp/); JetBrains отдаёт агентам IDE inspections/refactorings/debugger (https://www.jetbrains.com/help/ai-assistant/agents.html) | отсутствует |
| Remote / mobile | `/ws` всегда replayable, `/ws/host` — one-time capability 30 c; allowlist мобильных каналов; desktop-continuous отделён (`packages/server/src/http.ts:385-419`; `windowHostAttachmentRpcPolicy.ts:16-80`) | Devin Agent Command Center + mobile; Cursor iOS/web/desktop; Kiro cloud sessions с любой поверхности (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent) | сильнее по протоколу, паритет по поверхностям |
| Desktop hardening | contextIsolation, nodeIntegration=false, webviewTag=true, `<webview>` sandbox + изолированный preload; **нет CSP и нет navigation/popup guard главного окна** (`desktopWindowChrome.ts:591-614`); `sandbox` не задан явно, default Electron = true | Zed project trust; Kiro untrusted workspace; Codex protected paths (https://learn.chatgpt.com/docs/agent-approvals-security) | слабее по renderer-контейну |
| Telemetry / evals | ARMS + OTel + product events + memory diagnostics; нет SLO, нет quality-evals, нет delivery-метрик (`packages/services/src/telemetry/telemetryCore.ts:419,539-541`) | Copilot OTel с независимыми capture classes (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent); Cursor OTel Enterprise (https://cursor.com/docs/enterprise/opentelemetry-export.md) | паритет по объёму, слабее по управляемости/privacy |
| Cost controls | `cost: 0` в 5 путях, UI считает через `tokenlens`; лимитов стоимости нет (`runtime/methods/turn-stop.ts:86,137`; `message-persistence.ts:337`) | Kilo spend alerts + per-user daily limits (https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards); Cline subscription-aware cost display (https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts) | слабее |
| Model routing | 4 wire-формата, registry, effective selection, quota fallback до 3 attempts (`packages/provider/src/registry.ts:47-139`; `runtime/methods/provider-quota-fallback.ts:14-113`) | Cursor Router Cost/Balance/Intelligence (https://cursor.com/help/account-and-billing/pricing.md); Windsurf Adaptive/Fusion (https://docs.devin.ai/desktop/fusion.md); JetBrains plan-on-strong (https://www.jetbrains.com/help/ai-assistant/agents.html) | паритет по инфраструктуре, слабее по явным режимам |
| Share / collaboration | Conversation share (private/public_readonly/public_importable), disclosure gate, public projection с assert'ами; backend `/shares` вне репозитория | Amp thread-as-unit + multiplayer (https://ampcode.com/docs/markdown/threads); Zed multiplayer; OpenCode `opencode pair` 5 мин (https://opencode.ai/docs/) | паритет по приватности, слабее по collaboration |
| Onboarding / monetization | 3-шаговый occupation onboarding, quota banner блокирует submit, billing через embedded webview; нет consent/opt-out, нет self-serve управления подпиской (`packages/ui/src/v4/SessionPane.tsx:5555-5571`; `usage-stats.ts:78-101`) | Copilot per-seat + credits (https://docs.github.com/en/copilot/get-started/plans); Kiro credits + pooling; JetBrains $1=1 кредит (https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html) | паритет по billing, слабее по activation |
| CI / quality | 14-шаговый pre-push, architecture-policy, privacy-scan, affected-тесты; PR CI отсутствует, test collection не покрывает `.tsx`/23 колокейтед-теста (`vitest.config.ts:110-122`) | Copilot coding agent прогоняет tests/linters до PR (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent); OpenHands Stop-hook как quality gate (https://docs.openhands.dev/openhands/usage/customization/hooks.md) | паритет по локальным гейтам, слабее по серверным |

Сводка: сильнее — в протокольной части (V4 wire, capability, replayable/continuous), в каталоге субагентов и в allowlist мобильных каналов; паритет — в context/compaction, marketplace lifecycle, model router; слабее — в sandbox enforcement, delivery loop, editor/LSP, cost, memory, onboarding, desktop renderer containment.

## 4. Приоритизированный backlog улучшений

Backlog сведён по V3 §8 (группы G1–G17) и приоритетным правкам V1 §6. Правила: P0 = прямая потеря данных/секретов/краш/ложная гарантия безопасности; P1 = серьёзный ограниченный дефект или продуктовый пробел; P2 = гигиена/долг. Пункты, для которых нет валидного конкурентного источника и которые являются чистой гигиеной, вынесены в §9 (чтобы не изобретать подтверждение).

Согласование приоритетов (явно, чтобы не выглядело как потеря пунктов):

- Z05 ставил teardown per-session состояния (CR-2) в P0. Здесь он слит с R10 и опущен до P1: утечка не приводит к потере данных и не является ложной гарантией, а её пользовательский эффект — деградация `emitWorkspaceEvent` и рост памяти на долгоживущем Host. Если владелец считает долгоживущий Host (окно на весь день, сотни задач) P0-сценарием, R10 повышается до P0 без изменения содержания.
- Z11 ставил `event_text`/`eventExtraDetail` без санитайзера в P1 «с потенциалом P0» (V1 §6.2). Здесь это R14, P1: подтверждено отсутствие санитайзера, но не подтверждено попадание PII. Отдельный P0 по приватности — R06 (полный request body), где утечка prompt воспроизведена.
- Z01 R-2 (полный arch-check) и R-3 (CI-гейт) понижены V1 до P1; здесь это R12 (объединено с test collection) и H1 (§9.3, гигиена без конкурентного подтверждения).
- Z13 R1/R2 (PR-контур, `isolation:"worktree"`) понижены V1 до P1; здесь R19 и R20.
- Z15 R1/R5 (CONTEXT.md, consent) понижены V1 до P1; здесь R21 и R14.
- Z04 R-01/R-06, Z02 R2, Z03 R-01, Z06 R2 понижены V1; здесь R23 (a11y), R12 (`.tsx`), R10 (host crash), H (500 на malformed encoding — чистый дефект без конкурентного подтверждения, §9.3).
- Upgrade по V1: Z08 workspace boundary и sandbox — R03/R04 (P0); Z09/Z12 project MCP — R01 (P0); Z11 R1 — R06 (P0); Z05 owner/lease — R09 (P0 с оговоркой).

### P0

#### R01. Project-scope MCP: untrusted-by-default и digest-bound approval
- **Проблема/пробел:** repo-контролируемый MCP стартует без подтверждения; `untrustedProjectMcpServers` всегда пуст; спека утверждает обратное.
- **Доказательство ZCode:** `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:74-76`; `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:116-121`; `apps/zcode-cli/packages/adapters/src/config/config-factory.ts:113-136`; противоречие — `docs/runtime-tools/mcp-status-list-control-plane.md:16,30`.
- **Подтверждение у конкурента:** Kiro не загружает custom agents/steering/MCP/skills в недоверенном workspace и спрашивает перед shell (https://kiro.dev/docs/permissions/, accessed 2026-11-11); Zed загружает project-local instructions/skills только из доверенных worktree (https://zed.dev/docs/ai/tool-permissions, accessed 2026-11-11).
- **Решение и границы:** заполнять `untrustedProjectMcpServers` для workspace-scope; требовать первого явного connect/approve с preview command/args/env и digest записи; изменение команды инвалидирует trust. User-scope остаётся auto-connect. Out of scope: plugin MCP trust (отдельный слой), OAuth-модель, remote relay.
- **Ожидаемый эффект:** репозиторий не может молча выполнить произвольный stdio-бинарник; спека и код совпадают.
- **Риски и сложность:** ломает «workspace MCP из коробки», нужен миграционный UX; digest должен быть стабилен. M.
- **Приоритет:** P0.
- **Критерии приёмки:** новый workspace stdio server не спавнится до approve; approve привязан к digest; изменение command/args сбрасывает trust; user-scope не затронут.
- **Способ проверки:** unit `bootstrap/tests/mcp-project-config.test.ts` + `core/tests/mcp-runtime.test.ts`; desktop E2E settings connect; ручная проверка, что процесс не появился до approve.

#### R02. Plugin hooks: trust gate для third-party
- **Проблема/пробел:** любой установленный marketplace-плагин исполняет hooks; per-plugin trust и sandbox отсутствуют; документация обещает фильтрацию.
- **Доказательство ZCode:** `apps/zcode-cli/packages/adapters/src/plugins/index.ts:371-376` (`canRunPluginHooks` → `true`); `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:178-182,265-287`; `docs/claude-code-marketplace-plugin-compat.md:274-275`.
- **Подтверждение у конкурента:** Codex требует trust по хэшу для hooks и пропускает нетрастованные (https://learn.chatgpt.com/docs/hooks.md, accessed 2026-11-11); Cursor hooks по умолчанию fail-open, но имеет `failClosed: true` и рекомендует его для MCP (https://cursor.com/docs/agent/hooks, accessed 2026-11-11).
- **Решение и границы:** official/builtin → runnable; third-party → `runnable:false` до явного approval, привязанного к digest bundle; показывать hooks в install/review UI. Out of scope: OS-sandbox hooks, пересмотр hook runtime.
- **Ожидаемый эффект:** установка плагина перестаёт быть достаточным условием выполнения произвольной команды.
- **Риски и сложность:** ломает существующие third-party hooks; нужен digest и миграционный UX. M.
- **Приоритет:** P0.
- **Критерии приёмки:** untrusted hooks имеют `runnable:false` и не попадают в `HooksRuntimeConfig.events`; trust сохраняется по digest; official работает как раньше.
- **Способ проверки:** unit `adapters/tests/plugins.test.ts` + `bootstrap/tests/runtime-config.test.ts`; desktop E2E review flow; ручная проверка, что command не стартует.

#### R03. Workspace boundary как явная политика strict/ask/allow
- **Проблема/пробел:** read/write вне workspace разрешены намеренно; symlink-read не блокируется; путь prompt-injection → filesystem открыт.
- **Доказательство ZCode:** `apps/zcode-cli/packages/core/src/tool/path-policy.ts:32-39`; `apps/zcode-cli/packages/adapters/src/fs/index.ts:155-260` (read), `:700-755` (write); тесты фиксируют текущее поведение — `core/tests/file-tool-port.test.ts:420-492`.
- **Подтверждение у конкурента:** Cursor Run Modes + `sandbox.json` с team policy сверху (https://cursor.com/docs/agent/security/run-modes, accessed 2026-11-11); Kiro permissions + отдельный command sandbox (https://kiro.dev/docs/sandbox/, accessed 2026-11-11).
- **Решение и границы:** конфигурируемая `workspaceBoundary: strict|ask|allow`; strict — realpath-containment с учётом symlink; ask — permission-escalation с path preview; write по умолчанию `ask`, read — `allow` до миграции. Out of scope: OS-sandbox, remote workspace.
- **Ожидаемый эффект:** закрывает чтение `~/.ssh`/`~/.zcode/v2/credentials.json` через file tools в strict/ask.
- **Риски и сложность:** subagent'ы, которым нужны sibling-репозитории, начнут получать ask; realpath на Windows/junction требует аккуратности. M.
- **Приоритет:** P0.
- **Критерии приёмки:** strict отвергает absolute path вне root и symlink на вне-root; ask создаёт permission request; существующие тесты обновлены; default задокументирован.
- **Способ проверки:** unit path-policy/fs + permission-flow; E2E чтения файла вне workspace; negative-тест symlink.

#### R04. Bash sandbox: реализовать или убрать ложную гарантию
- **Проблема/пробел:** `sandbox` формируется и телеметрируется, но не enforced; модель и пользователь видят «sandboxed».
- **Доказательство ZCode:** `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:328,458-461`; `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts:108-113,153`; `rg request.sandbox` по `apps/zcode-cli/packages/adapters/src/exec` пуст; комментарий «sandbox撤除后» — `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts:399-400`.
- **Подтверждение у конкурента:** Codex: OS sandbox default, сеть выключена, approvals отдельно (https://learn.chatgpt.com/docs/agent-approvals-security, accessed 2026-11-11); Factory: Seatbelt/bwrap+seccomp + egress proxy, `denyWrite` overrides `allowWrite` (https://docs.factory.com/autonomy-and-safety/sandbox, accessed 2026-11-11); Kilo честно документирует «write boundary, not privacy boundary» и off-by-default (https://kilo.ai/docs/getting-started/settings/sandboxing, accessed 2026-11-11).
- **Решение и границы:** вариант A — платформенный sandbox (macOS seatbelt, Linux bwrap/landlock, Windows restricted token) и возврат `SANDBOX_VIOLATION`; вариант B — удалить `dangerouslyDisableSandbox` из model schema, оставить поле как internal trace и явно документировать отсутствие изоляции. Out of scope: контейнерная изоляция desktop.
- **Ожидаемый эффект:** либо реальная защита, либо честный контракт; исчезает ложная гарантия.
- **Риски и сложность:** sandbox ломает git/npm/сеть; Windows дорог. L (A) / S (B).
- **Приоритет:** P0.
- **Критерии приёмки:** нет provider-visible поля, обещающего изоляцию, без enforcement; либо e2e, где sandbox блокирует запись/сеть и возвращает `sandbox_violation`.
- **Способ проверки:** платформенные e2e; `adapters/tests/exec.test.ts`; ручная проверка `dangerouslyDisableSandbox` в prompt.

#### R05. Жёсткие запреты и таймаут approval
- **Проблема/пробел:** `yolo`/`guarded` обходят `disallowedTools` и project deny; `permissionTimeoutMs` не присваивается, approval ждёт бесконечно.
- **Доказательство ZCode:** `apps/zcode-cli/packages/core/src/permission/service.ts:169-189` (+ признание в комментарии `:391`); `core/src/permission/broker.ts:108-126`; `core/src/runtime/types.ts:149`; тест обхода — `core/tests/permission-service.test.ts:937-960`.
- **Подтверждение у конкурента:** Kiro: deny > ask > allow, самое ограничительное побеждает, non-interactive ask → deny (https://kiro.dev/docs/permissions/, accessed 2026-11-11); Copilot: `--deny-tool` имеет приоритет над `--allow-all-tools`/`--allow-tool` (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent, accessed 2026-11-11).
- **Решение и границы:** перенести `isToolDisallowed` и project deny выше allow-ветки `yolo`/`guarded`; добавить `permission.approvalTimeoutMs` с дефолтом (например 300000) и `0 = без таймаута`, прокинуть в `AgentRuntimeConfig.permissionTimeoutMs` и в protocol-путь. Out of scope: режим `auto`, новые риск-политики.
- **Ожидаемый эффект:** конфиг соответствует названию; зависший клиент не подвешивает turn навсегда.
- **Риски и сложность:** меняет продуктовое поведение yolo (нужен sign-off); короткий таймаут сорвёт долгие подтверждения. S.
- **Приоритет:** P0.
- **Критерии приёмки:** `yolo` + `disallowedTools:["Bash"]` → deny с `rule.disallowedTools`; `guarded` — то же; при отсутствии ответа через N мс — `PermissionTimeout`; `0` отключает таймаут.
- **Способ проверки:** `permission-service.test.ts` + `guarded-approval.test.ts` + новый broker-тест с deferred responder.

#### R06. Убрать полный request body из JSONL и support bundle
- **Проблема/пробел:** `turn.failed` пишет `responseBodySummary` с полным `input` (до 670 сообщений) и `tools` (18 определений); строки до 1.46 MB; всё уходит в support bundle.
- **Доказательство ZCode:** `apps/zcode-cli/packages/core/src/runtime/helpers/turn-errors.ts:326-334`; `apps/zcode-cli/packages/adapters/src/model/provider-finish-business-error.ts:99-118,224-230`; `apps/zcode-cli/packages/adapters/src/logging/serialize.ts:111-160`; воспроизведение — `~/.zcode/cli/log/zcode-2026-11-11.jsonl` (2 строки 1 464 477 / 1 464 655 B).
- **Подтверждение у конкурента:** Cursor OTel экспортирует tokens/tool calls/cost, а контент диалога и MCP I/O — только opt-in (https://cursor.com/docs/enterprise/opentelemetry-export.md, accessed 2026-11-11); Copilot OTel по умолчанию исключает prompts/responses/tool arguments и включает capture classes независимо (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent, accessed 2026-11-11).
- **Решение и границы:** заменить `candidates.find(hasBusinessSignal)` на явный summary (scalars + keys + request_id/code/message); ограничить `serializeLogError` по глубине/размеру (например 8 KB на frame с `truncated:true`). Out of scope: retry-решения, формат `/report`, OTel.
- **Ожидаемый эффект:** строки ≤32 KB, prompt исчезает из support bundle, приватность восстановлена.
- **Риски и сложность:** можно потерять диагностические поля — сохранить `providerCode/requestId/keys/message`. S.
- **Приоритет:** P0.
- **Критерии приёмки:** для `ProviderBusinessError` сериализованная строка ≤32 KB; `input/tools/messages` отсутствуют; `runner-provider-business-network.test.ts` зелёный.
- **Способ проверки:** новый unit в `adapters/tests/`; ручной прогон сценария + `awk` по размеру строк JSONL.

#### R07. Главное окно: CSP и navigation/popup guard
- **Проблема/пробел:** нет CSP; нет `will-navigate`/`will-frame-navigate`/`setWindowOpenHandler` для main; preload публикует 132 метода любому загруженному документу. `sandbox` не задан явно, но default Electron = true — это не gap.
- **Доказательство ZCode:** `packages/desktop/src/main/desktopWindowChrome.ts:591-614`; `packages/desktop/src/preload/index.ts:264-934`; `packages/desktop/src/renderer/index.html` (0 CSP); guards существуют только для guest (`desktopWindowChrome.ts:377,453,738-769`).
- **Подтверждение у конкурента:** прямая аналогия ограничена — конкуренты документируют границу загрузки/исполнения, а не Electron-CSP: Kiro не загружает project-конфиг до trust (https://kiro.dev/docs/permissions/, accessed 2026-11-11); Antigravity имеет deny>ask>allow и режимы sandbox (https://antigravity.google/docs/permissions/, accessed 2026-11-11). Это **аналогия принципа**, а не подтверждение конкретной механики.
- **Решение и границы:** `will-navigate` allowlist (app origin / dev server / file внутри asar), `setWindowOpenHandler` → deny + `shell.openExternal` для http(s), CSP meta/header, целевое `openExternal` вместо `target="_blank"`. Out of scope: `<webview>`-политика (уже реализована), embedded browser permission policy.
- **Ожидаемый эффект:** закрывает класс «навигация/попап получает native API», снижает XSS-эскалацию.
- **Риски и сложность:** можно сломать OAuth/payment redirect и dev HMR. M.
- **Приоритет:** P0.
- **Критерии приёмки:** unit проверяет регистрацию guard'ов; клик по внешней ссылке открывает системный браузер; навигация main frame на `https://example.com` блокируется; CSP присутствует в собранном HTML; dev/prod smoke зелёный.
- **Способ проверки:** `vitest run packages/desktop/test/desktopWindowChrome.test.ts`; новый E2E с моком `shell.openExternal`; ручная проверка OAuth.

#### R08. RPC-граница: лимит кадра и безопасный разбор
- **Проблема/пробел:** 32-битный `length` без верхней границы; битый тег даёт uncaught `TypeError`; 512 MiB заголовок принимается.
- **Доказательство ZCode:** `packages/rpc/src/protocol.ts:274-278`; `packages/rpc/src/persistent-protocol.ts:180-198`; `packages/rpc/src/channelServer.ts:68-98`; проба: `buffered bytes: 13 | unack: 0`, unknown tag → `TypeError: Cannot read properties of undefined (reading '0')`.
- **Подтверждение у конкурента:** прямого аналога лимита кадра в C1–C4 нет (UNKNOWN); ближайший документированный принцип — стабильный машинный контракт app-server с явными событиями (https://learn.chatgpt.com/docs/app-server.md, accessed 2026-11-11). Внутренний ориентир — V4-лимит 1 MiB (`packages/shared/src/zcode-protocol-v4/core.ts:64-100`).
- **Решение и границы:** `maxFrameBytes` в `PersistentProtocolOptions`/`SocketProtocol` (per-transport конфиг), typed close reason при превышении, try/catch вокруг `onRawMessage`, тесты на 1 MiB−1/1 MiB/1 MiB+1 и unknown tag. Out of scope: изменение 13-байтового заголовка, V4 wire-лимиты.
- **Ожидаемый эффект:** memory-DoS и падение процесса от одного кадра устранены.
- **Риски и сложность:** легитимные крупные Channel-payload (медиа до 8 MiB) требуют per-transport конфига. M.
- **Приоритет:** P0.
- **Критерии приёмки:** unknown tag не роняет процесс; oversize закрывает соединение с typed reason; 71 rpc-тест зелёный.
- **Способ проверки:** новые unit в `packages/rpc/test/protocol.test.ts`/`channels.test.ts`; интеграционный прогон `zcode-server-cli/test/coreHttp.test.ts`.

#### R09. Owner/lease/mirror: подключить или явно удалить
- **Проблема/пробел:** `taskRealtimePort` не инжектится, owner-команды не доставляются, lease-ветка недостижима; документация требует обратное. Оговорка: mobile mirror мог быть намеренно отключён (Z05 §7 Q1); это не доказательство «mobile сломан».
- **Доказательство ZCode:** `packages/desktop/src/host/index.ts:3985-3992` (единственный вызов без порта), `:1428-1492` (ранний `return`), `:3731` (порт создан и не передан); `packages/services/src/session/sessionRealtimePort.ts:19-43`; `packages/desktop/src/host/taskRealtimeBridge.ts:194-227`; `docs/agents/runtime-boundaries.md:57-58`.
- **Подтверждение у конкурента:** конкурентное подтверждение — про необходимость явной модели владения сессией, а не про этот код: Devin имеет явные session status/status_detail и auto-resume (https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md, accessed 2026-11-11); Amp держит thread как переносимую единицу с орбом (https://ampcode.com/docs/markdown/threads, accessed 2026-11-11).
- **Решение и границы:** вариант A — передать `activeSessionRealtimePort` в `createReportingRemoteZCodeTaskService`, зарегистрировать `onDidReceiveOwnerCommand`, покрыть e2e mobile relay; вариант B — удалить dead-код и синхронно поправить `runtime-boundaries.md`, `task-realtime-sync.md`, `AGENTS.md`. Out of scope: изменение lease-модели и relay-протокола.
- **Ожидаемый эффект:** либо восстановленная маршрутизация, либо −~400 строк мёртвого состояния и снятие ложного требования.
- **Риски и сложность:** A — дублирование стрима/лишние lease; B — потеря забытой зависимости mobile/bot. M.
- **Приоритет:** P0 (с обязательной фиксацией выбранного варианта в PR).
- **Критерии приёмки:** в дереве нет свойства, объявленного и никогда не передаваемого; e2e «mobile attachment видит mirror батчи и stop/permission доходят до владельца» проходит либо grep показывает 0 ссылок и документы обновлены.
- **Способ проверки:** `packages/desktop/test/taskRealtimeBus.test.ts`; новый e2e mobile-owner-mirror; `pnpm architecture:check --changed`.

### P1

#### R10. Lifecycle сессии: teardown, failed-команды, host crash
- **Проблема/пробел:** per-session maps не очищаются на close/delete; failed host-команды с payload остаются навсегда; residual `activePromptInputIds` блокирует drain после падения CLI; падение Host не уведомляет renderer и не respawn'ится.
- **Доказательство ZCode:** `packages/services/src/zcode-agent/zcodeAgentService.ts:2091-2100,2333-2343,4453-4470`; `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:533-550,611-614,1637-1641,1698-1712`; `packages/desktop/src/main/desktopHostProcess.ts:647-664`; `packages/desktop/src/main/desktopWindowLifecycle.ts:275-287`; `packages/desktop/src/main/taskRealtimeBus.ts:366-397,520-522`.
- **Подтверждение у конкурента:** Devin имеет явный статус-конечный автомат и auto-resume (https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md, accessed 2026-11-11); OpenHands имеет pause/resume и `stuck` как наблюдаемое состояние (https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md, accessed 2026-11-11).
- **Решение и границы:** единый `forgetSession(workspaceKey, sessionId)` в agent service, вызываемый на close и на CLI `session.removed`; self-dispose emitters через `onDidRemoveLastListener`; bounded ring/TTL для failed-команд; подписка adapter на runtime restart с reset `activePromptInputIds`; `InternalChannels.HostProcessExited` + one-shot respawn с guard. Out of scope: замена bus на CommandInbox, изменение CLI recovery.
- **Ожидаемый эффект:** счётчики memory diagnostics стабилизируются; после crash следующий prompt исполняется; окно не остаётся «тихо мёртвым».
- **Риски и сложность:** преждевременная очистка при повторном открытии (нужен generation guard); двойной respawn при гонке с reload. M.
- **Приоритет:** P1.
- **Критерии приёмки:** N create/close → 4 карты не растут; crash во время turn → следующий enqueue исполняется; после release без terminal `streamBatches.size === 0`; E2E kill Host → UI статус + ровно один respawn.
- **Способ проверки:** `zcodeAgentService.test.ts`, `zcodeLegacyTaskCompatTaskIndex.test.ts`, `taskRealtimeBus.test.ts`; новый E2E `workspace-host-crash-recovery.test.ts`; 30-минутный soak с `[memory]`-логами.

#### R11. Legacy resume: per-session single-flight и честная ошибка hydration
- **Проблема/пробел:** два параллельных `session/resume` могут материализовать два app; ошибка warm-hydration подменяется пустым snapshot как успех.
- **Доказательство ZCode:** `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1476-1590`; `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:3287-3314`; аудит — `docs/v4-refactor/18-resume-race-audit-plan.md:45-70,71-103`.
- **Подтверждение у конкурента:** конкурентный ориентир — явные состояния resume: Devin `suspended`/`resuming` и auto-resume (https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md, accessed 2026-11-11); OpenHands pause/resume (https://docs.openhands.dev/sdk/arch/agent.md, accessed 2026-11-11).
- **Решение и границы:** общий `activationFlights: Map<sessionId, Promise<record>>` на server context, переиспользуемый в `activateSessionForResume`; ошибка/отмена очищает flight с generation. Всегда пробрасывать `fault.subscribe.resumeFailed` при ошибке первичного persisted-read. Out of scope: V4 READY, transcript merge.
- **Ожидаемый эффект:** один runtime owner на session; UI не открывает «успешно пустую» историю.
- **Риски и сложность:** flight с ошибкой должен ретраиться, иначе сбой залипнет; старые частично повреждённые сессии перестанут открываться — нужен UX «показать ошибку и повторить». M.
- **Приоритет:** P1.
- **Критерии приёмки:** `Promise.all` двух resume → ровно 1 `createdAppOptions`; `loadPersistedEventsImpl = throw` → subscribe rejects на warm-пути.
- **Способ проверки:** `apps/zcode-cli/packages/bootstrap/tests/*resume*`, `v4-gateway.test.ts`.

#### R12. Серверный CI-гейт и реальный сбор тестов
- **Проблема/пробел:** единственный workflow — ручной release без lint/typecheck/test; 10 `.test.tsx` и 23 колокейтед-теста не собираются; 12 мёртвых include/exclude-путей.
- **Доказательство ZCode:** `.github/workflows/cross-platform-preview-release.yml:3-12`; `vitest.config.ts:110-122` (include без `.tsx`, два отсутствующих файла); `:32` (отсутствующий `remoteFrontendBuildSource.test.ts` в `forkIsolatedTests`); `knip.json:5-8`.
- **Подтверждение у конкурента:** Copilot coding agent прогоняет tests/linters до PR (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent, accessed 2026-11-11); OpenHands Stop-hook как enforcement-гейт качества (https://docs.openhands.dev/openhands/usage/customization/hooks.md, accessed 2026-11-11).
- **Решение и границы:** job `checks` на `pull_request`/`push` (lint + typecheck + `architecture:check --changed` + affected UT) с `permissions: contents: read`; include `packages/*/test/**/*.test.{ts,tsx}` + колокейтед каталоги; удалить 10 мёртвых fork-записей и 2 мёртвых include; добавить тест-инвариант «каждый include-путь существует». Out of scope: восстановление GitLab-инфраструктуры, полный 575-спек E2E в CI.
- **Ожидаемый эффект:** любой PR получает воспроизводимый статус; 33 файла тестов перестают быть теневыми.
- **Риски и сложность:** стоимость runner-минут; ложные красные из-за fmt/arch (сначала локальная гигиена); `.tsx` в thread-pool. M.
- **Приоритет:** P1.
- **Критерии приёмки:** PR с падающим тестом краснеет; `vitest list` содержит все 10 `.tsx`; каждый include-путь существует.
- **Способ проверки:** тестовый PR + `gh run view --json jobs`; `npx vitest list --project unit`.

#### R13. Cost accounting: единый источник истины
- **Проблема/пробел:** `cost` всегда `0` в пяти production-путях, `null` в протоколе, UI показывает расчёт `tokenlens` — три противоречащих источника.
- **Доказательство ZCode:** `core/src/runtime/methods/turn-stop.ts:86,137`; `message-persistence.ts:337`; `turn-step-finish.ts:29`; `timeline-persistence.ts:130`; `session-fork.ts:475`; UI — `packages/ui/src/components/ai-elements/context.tsx:224-236`.
- **Подтверждение у конкурента:** Kilo spend alerts + per-user daily limits (https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards, accessed 2026-11-11); Cline показывает стоимость с учётом подписки и скрывает доллары там, где списание фиксированное (https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts, accessed 2026-11-11).
- **Решение и границы:** вариант A — считать cost на CLI из прайса провайдера и сохранять; добавить `maxCostUsd` на turn/session с терминальным статусом `error_max_cost`; вариант B — удалить/депрекейтить поле и убрать «Total cost» из UI. Out of scope: биллинг Coding Plan (серверный).
- **Ожидаемый эффект:** либо реальный контроль расходов, либо отсутствие ложного впечатления учёта.
- **Риски и сложность:** прайс-листы меняются, кэш-токены считаются иначе; неверная оценка хуже отсутствия лимита. L (A) / S (B).
- **Приоритет:** P1.
- **Критерии приёмки:** (A) превышение бюджета даёт детерминированный терминальный статус; (B) `rg "cost: 0"` в production = 0, UI не показывает ненулевой cost при `null`.
- **Способ проверки:** unit на калькулятор с cache read/write; integration с scripted provider и фиксированным usage; UI-тест отображения.

#### R14. Телеметрия: санитайз, opt-out и объём логов
- **Проблема/пробел:** `event_text`/`eventExtraDetail` уходят без санитайзера, `template_prompt` — полный текст; нет пользовательского opt-out/consent; CLI JSONL даёт 359 MiB за 4 дня, desktop main-логгер синхронный и без redaction.
- **Доказательство ZCode:** `packages/services/src/telemetry/telemetryCore.ts:419,439,441-444,162-166`; `packages/shared/src/telemetry.ts:216-241`; `packages/ui/src/lib/promptTemplateTelemetry.ts:14-27`; `packages/desktop/src/main/logger.ts:73-91`; `apps/zcode-cli/packages/adapters/src/logging/retention.ts:97-120`.
- **Подтверждение у конкурента:** Goose — telemetry opt-in, default off (https://goose-docs.ai/docs/guides/usage-data.md, accessed 2026-11-11); Copilot OTel — capture classes включаются независимо и по умолчанию без prompts/responses (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent, accessed 2026-11-11).
- **Решение и границы:** `.max()` для `eventText`/ключей/значений detail; allowlist detail-ключей или явная политика «свободный текст только для перечисленных событий»; persisted `telemetry.enabled` + `DO_NOT_TRACK` + consent-шаг; `turn.phase.*` в debug или агрегат, throttling `mcp.server.failed`, `maxBytesPerDay` с ротацией; redactor и асинхронный sink для desktop logger. Out of scope: серверная очистка истории, OTel CLI.
- **Ожидаемый эффект:** ограниченный payload, управляемый privacy-контур, −30–40% объёма логов.
- **Риски и сложность:** строгий allowlist сломает будущие события; отключение телеметрии ухудшит метрики; crash reporting должен остаться. M.
- **Приоритет:** P1.
- **Критерии приёмки:** payload > лимита отклоняется/усекается с маркером; при `telemetry.enabled=false` ни один `/event/report` и ARMS sendCustom не уходит; при превышении `maxBytesPerDay` создаётся новый файл.
- **Способ проверки:** unit схем + `appTelemetryPrivacy.test.ts`/`promptTemplateTelemetry.test.ts`; mock transport на три гейта; генератор нагрузки и сравнение объёма до/после.

#### R15. Durable audit trail для permission и auth-событий
- **Проблема/пробел:** permission events не входят в durable whitelist, default store — in-memory; после рестарта нельзя доказать, кто и почему одобрил действие.
- **Доказательство ZCode:** `core/src/runtime/methods/events.ts:641-898`; `bootstrap/src/app/create-app.ts:874`; `core/src/tool/executor/permission-flow.ts:121-160,277-292`.
- **Подтверждение у конкурента:** Devin документирует audit logs в API-каталоге (https://docs.devin.ai/_llms/en/api.txt, accessed 2026-11-11); Copilot имеет audit log изменений policy (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent, accessed 2026-11-11).
- **Решение и границы:** `session_entry` тип `permission_decision` (requestId, toolCallId, toolName, risk, scope, decision, ruleId, mode, approvalMode, timestamp, input summary) в `persistDurableSessionEvent`; auth-failure — отдельный security log sink с redaction. Out of scope: внешний SIEM.
- **Ожидаемый эффект:** аудит не зависит от in-memory retention.
- **Риски и сложность:** объём БД и PII; нужен retention/rotation. M.
- **Приоритет:** P1.
- **Критерии приёмки:** allow/deny/ask-resolved переживают рестарт; запись без полного input; нет дублей при replay.
- **Способ проверки:** unit persistence + restart E2E; проверка `session_entry` после cold resume.

#### R16. Credentials: ключ вне предсказуемых данных, миграция plaintext
- **Проблема/пробел:** master key = SHA-256 от `platform+homedir+username`; `safeStorage` не используется; legacy plaintext читается без миграции.
- **Доказательство ZCode:** `packages/services/src/credential/providers/credentialCipherProvider.ts:20-37,60-105`; `:79-82` (plaintext passthrough); `credentialService.ts:19-25` (комментарий про safeStorage).
- **Подтверждение у конкурента:** конкурентный ориентир — OS-keychain/enterprise KMS: Cursor CMEK/BYOK для Enterprise (https://cursor.com/docs/cloud-agent/security.md, accessed 2026-11-11); Factory SAML/OIDC/SCIM и org policy (https://docs.factory.com/autonomy-and-safety/sandbox, accessed 2026-11-11) — как пример контроля секретов, не как аналог локального шифрования.
- **Решение и границы:** Desktop — шифровать master key через `safeStorage` (Host запрашивает main); CLI — случайный `~/.zcode/security/master.key` с `0o600`; `enc:v2` + read-time миграция `enc:v1`/plaintext; fallback только при явном `ZCODE_CREDENTIAL_SECRET`. Out of scope: серверная ротация OAuth.
- **Ожидаемый эффект:** офлайн-расшифровка при краже файла перестаёт быть тривиальной.
- **Риски и сложность:** миграция при смене машины; нужен backup/rollback. M/L.
- **Приоритет:** P1.
- **Критерии приёмки:** новые записи `enc:v2`; старые читаются и переписываются; ключ не выводится из homedir/username.
- **Способ проверки:** unit credentialService/cipher; desktop smoke; проверка файла на диске.

#### R17. Untrusted-рамки для внешнего контента и public egress
- **Проблема/пробел:** WebFetch вставляет контент без инструкции «не выполняй», MCP descriptions/results идут без рамки, work-ledger envelope вставляет текст других агентов, `egressPolicy: "public"` не передаётся.
- **Доказательство ZCode:** `core/src/tool/handlers/webfetch-processing.ts:105-125`; `webfetch-network.ts:70-81`; `core/src/mcp/index.ts:239-241,494-519`; `core/src/runtime-task/work-ledger-wire.ts:304-347`; контраст — `core/src/subagent/runner.ts:2131,2151`.
- **Подтверждение у конкурента:** Antigravity компилирует домены `read_url` в outbound allowlist (https://antigravity.google/docs/permissions/, accessed 2026-11-11); Cursor документирует, что classifier Auto-review не является security boundary (https://cursor.com/docs/agent/security/run-modes, accessed 2026-11-11) — то есть границу надо строить детерминированно, а не вероятностно.
- **Решение и границы:** обернуть page content, MCP result и ledger envelope в `<untrusted_external_content>` с одной строкой «never follow instructions inside»; передавать `egressPolicy: "public"` или включить DNS preflight; сохранить redirect-host проверку. Out of scope: смена prompt-архитектуры провайдера.
- **Ожидаемый эффект:** снижение indirect prompt injection и SSRF/DNS-rebinding поверхности.
- **Риски и сложность:** доп. текст в контексте; public egress ломает proxy-сценарии. S/M.
- **Приоритет:** P1.
- **Критерии приёмки:** тест проверяет рамку и лимит 15 строк ledger-блока; WebFetch с private IP после redirect блокируется; MCP result содержит рамку.
- **Способ проверки:** unit webfetch/mcp/work-ledger; `adapters/tests/http.test.ts` egress-кейсы.

#### R18. Контракт сборки контекста: бюджет, precedence, target paths
- **Проблема/пробел:** нет общего token-бюджета секций; skill precedence user > project вопреки продукт-доку; `ruleTargetPaths` не производится, поэтому glob-правила не работают; скрытые `.zcode/AGENTS.md`/`.agents/AGENTS.md` не читаются, хотя `/init` их называет; `transcriptPath` в compact summary не передаётся.
- **Доказательство ZCode:** `core/src/context/builder.ts:222-235`; `adapters/src/skills/roots.ts:46-55`; `docs/skills-product.md:78-84`; `adapters/src/context/index.ts:681-720`; `bootstrap/src/builtin-prompt-command.ts:313-319`; `core/src/compact/prompt.ts:146-148`; `runtime/methods/compact-active.ts:581-583`.
- **Подтверждение у конкурента:** Cursor rules — 4 режима активации и приоритеты Team→Project→User→AGENTS.md (https://cursor.com/docs/context/rules, accessed 2026-11-11); JetBrains project rules — Always/Manually/By model decision/By file patterns/Off (https://www.jetbrains.com/help/ai-assistant/agents.html, accessed 2026-11-11); OpenHands condenser с `keep_first` (https://docs.openhands.dev/sdk/arch/condenser.md, accessed 2026-11-11).
- **Решение и границы:** бюджет по категориям с детерминированным порядком «compress → drop optional → keep safety»; project > user для same-name skill; продюсер `ruleTargetPaths` (редактируемый/упомянутый файл, изменённые файлы turn); читать hidden AGENTS.md с явным precedence или убрать обещание из `/init`; передавать transcript pointer в summary. Out of scope: provider-specific tokenizer, embedding storage.
- **Ожидаемый эффект:** предсказуемый размер prompt, работающие file-scoped rules, восстановимость после compaction.
- **Риски и сложность:** потеря важных правил; 272 ru-строки с plural — отдельная трудоёмкость (не входит). M.
- **Приоритет:** P1.
- **Критерии приёмки:** при превышении бюджета применяется фиксированный порядок и safety не режется; same-name skill → project; при упоминании `src/foo.ts` применяется glob-правило; summary содержит pointer.
- **Способ проверки:** unit context-builder + snapshot; `fs-context.test.ts`; integration test context source + runtime turn.

#### R19. Delivery loop: PR и CI-ingestion
- **Проблема/пробел:** нет PR-создания, review-комментариев, ingestion CI-статусов; `gh` доступен модели только read-only; «PR workflow» = генерация текста.
- **Доказательство ZCode:** `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts:52-128`; `bash-readonly-policy-multiword-core.ts:24`; `v4/featureSuggestedPrompts.ts:441-445`; `grep 'gh pr create'` = 0.
- **Подтверждение у конкурента:** Cursor Bugbot публикует CI-статусы и ревьюит PR-диффы (https://cursor.com/docs/bugbot.md, accessed 2026-11-11); Devin stacked PRs + CI-контроль (https://docs.devin.ai/work-with-devin/stacked-prs.md, accessed 2026-11-11); Copilot Agent Merge (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent, accessed 2026-11-11).
- **Решение и границы:** добавить мутирующие `gh pr create|edit|comment|review` в allowlist с обязательным permission и audit; сервис `IGitRemoteService` (createPullRequest, listChecks, getReviewComments); UI-секция PR с polling checks и TTL-кэшем; токены — только через `gh`/credential helper. Out of scope: GitHub OAuth-клиент, GitLab, merge/approve, auto-fix CI.
- **Ожидаемый эффект:** цикл «изменения → PR → CI-статус» без выхода из приложения.
- **Риски и сложность:** секреты в логах, rate limit 5000/ч, расхождение версий `gh`. L.
- **Приоритет:** P1 (P0 по продуктовой ценности, P1 по критерию «нет data-loss»).
- **Критерии приёмки:** PR создаётся из Git-панели; при отсутствии `gh`/auth — actionable ошибка; checks отображаются; токен не попадает в лог.
- **Способ проверки:** интеграционный тест с локальным git-remote + fake `gh` в PATH; E2E с mock HTTP; grep логов на токен.

#### R20. Git workspace UX: worktree isolation и stage/unstage/discard
- **Проблема/пробел:** `isolation:"worktree"` падает в runtime; UI не даёт unstage/discard, `useGitActions` — мёртвая заглушка; нет resolver'а конфликтов.
- **Доказательство ZCode:** `apps/zcode-cli/packages/contracts/src/workflow/script.ts:42-49`; `bootstrap/src/app/script-workflow-runtime.ts:282-284`; `packages/ui/src/hooks/useGitActions.ts:12-47`; `gitService.stagePaths` вызывается только из `GitActionMenu.tsx:1173` и `useGitBranchSwitcher.ts:341`; `packages/services/src/git/repo/gitCliHelpers.ts:336-355` (конфликты детектируются).
- **Подтверждение у конкурента:** Kilo Agent Manager/worktrees и предупреждение, что subagents не изолируют файловые правки (https://kilo.ai/docs/customize/custom-subagents, accessed 2026-11-11); Antigravity workspace modes `inherit|branch|share` (https://antigravity.google/docs/subagents, accessed 2026-11-11); Zed worktree isolation (https://zed.dev/docs/ai/tool-permissions, accessed 2026-11-11).
- **Решение и границы:** worktree от HEAD в `<repo>/.zcode/worktrees/<runId>`, child cwd=worktree, diff обратно, cleanup в `finally`; либо удалить `isolation` из схемы (S). Добавить в Git pane кнопки stage/unstage/discard с подтверждением и undo-буфером; резолвер конфликтов как read-only «open in editor» минимум. Out of scope: авто-merge и разрешение конфликтов между worktree.
- **Ожидаемый эффект:** параллельные writers получают файловую изоляцию; пользователь управляет индексом из UI.
- **Риски и сложность:** диск/время, submodules, грязный workspace, cleanup при crash; discard без undo — риск потери данных. M.
- **Приоритет:** P1.
- **Критерии приёмки:** два actor'а с worktree пишут один путь без конфликта; неизменённый worktree удалён; unstage/discard доступны и обратимы в рамках сессии.
- **Способ проверки:** integration-тест на временном git-репозитории; UI-тесты GitPane; E2E stage→commit→unstage.

#### R21. Правдивость документации и точка входа
- **Проблема/пробел:** 2088 md без индекса; drift по `.gitlab`/`scripts/ci`/`packages/distillation`; `CONTEXT.md` описывает снятый Recommended и удалённый Try now; спеки Swarm говорят 15 ролей против 16 в коде.
- **Доказательство ZCode:** `docs/desktop-ci-cd.md:3,7-14,20`; `docs/ci-cache-strategy.md:1-4`; `docs/product-capability-map-engineering-infrastructure.md:11,45`; `CONTEXT.md:50-52,73-75` против `recommendedPlugins.ts:3-9` и `PluginStoreDetailView.tsx:160-171`; `docs/specs/zcode-swarm-mode.md:36-37` против `core/src/subagent/profile.ts:16-35`.
- **Подтверждение у конкурента:** конкурентные антипримеры документированного drift: Kilo «temporarily unavailable» против полной docs-страницы (https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new, accessed 2026-11-11); Trae — противоречивые sandbox-страницы (https://docs.trae.ai/ide/permission-and-approval, accessed 2026-11-11); C3 P10/P7 фиксируют тот же класс.
- **Решение и границы:** `docs/README.md` с картой разделов и правилом «новый раздел добавляет строку»; удалить/архивировать GitLab-описание; синхронизировать `CONTEXT.md` с owner-подтверждением по Try now; спеки Swarm — 16 ролей. Out of scope: переписывание всех документов.
- **Ожидаемый эффект:** новый инженер и агент не идут по ложной карте; ревью ссылается на актуальный словарь.
- **Риски и сложность:** без ответа владельца по Try now правка закрепит неверную сторону. S.
- **Приоритет:** P1.
- **Критерии приёмки:** нет действующих упоминаний `.gitlab`/`scripts/ci`/`packages/distillation`; `docs/README.md` покрывает каталоги первого уровня; `CONTEXT.md` не содержит термина без ссылки на реализацию/решение.
- **Способ проверки:** `node scripts/check-doc-links.mjs`; `rg` по drift-паттернам; тест полноты индекса.

#### R22. Marketplace trust: compatibility, source validation, install cancel
- **Проблема/пробел:** нет `engines/minAppVersion`, нет verification издателя, install нельзя отменить, sources dialog не умеет validate.
- **Доказательство ZCode:** `apps/zcode-cli/packages/contracts/src/plugins/index.ts:115-166`; `packages/ui/src/settings/PluginStoreCard.tsx:187-226` (`disabled={installing}`); `PluginStoreSourcesDialog.tsx:49-57,132,151`; `pluginManagementService.ts:193` (`cancelPluginOperation` есть, UI-пути нет).
- **Подтверждение у конкурента:** Cursor Marketplace с team modes Default Off/On/Required (https://cursor.com/changelog, accessed 2026-11-11); JetBrains ACP-реестр с install/update/uninstall (https://www.jetbrains.com/help/ai-assistant/agents.html, accessed 2026-11-11); Cline Auto Approve документирует «examples, not guarantees» — как антипример оценки безопасности моделью (https://docs.cline.bot/features/auto-approve, accessed 2026-11-11).
- **Решение и границы:** опциональные `minAppVersion`/`publisherVerification` с бейджем и диагностикой `plugin_incompatible_app_version`; Cancel в installing-состоянии через существующий operationId; Validate для personal source. Не вводить install counts/ratings. Out of scope: собственная модерация, подписи пакетов, revenue share.
- **Ожидаемый эффект:** несовместимый плагин отклоняется до установки; «залипшая» установка управляема.
- **Риски и сложность:** новые поля требуют публикации каталога; старые каталоги должны деградировать. M.
- **Приоритет:** P1.
- **Критерии приёмки:** каталог без полей работает как раньше; `minAppVersion > ZCODE_VERSION` блокирует install; Cancel возвращает не-installed без потери существующей установки.
- **Способ проверки:** adapter-тесты parse/diagnostics; UI-тесты card/detail; service-тест cancellation.

#### R23. UI accessibility и корректность токенов
- **Проблема/пробел:** глобальный `outline:none!important` + `box-shadow:none` подавляет 277 ring-стилей и 95 outline; 208 упоминаний `text-muted-foreground` при отсутствии токена; toast без live-region; композер без accessible name; два отсутствующих i18n-ключа.
- **Доказательство ZCode:** `packages/ui/src/styles.css:126-139`; `packages/ui/src/components/ui/button.tsx:10-24`; `badge.tsx:13`; `toast.tsx` (нет `role`/`aria-live`); `LexicalChatInput.tsx:1312-1340,1461-1472`; `IntlProvider.tsx:127-128`; `packages/ui/src/DeleteAllArchivedTasksButton.tsx:61` (`taskList.noArchivedTasks`) и `packages/ui/src/project-sidebar/RemoteProjectMenu.tsx:42` (`workspaceSidebar.addProject`) — оба ключа отсутствуют во всех трёх каталогах.
- **Подтверждение у конкурента:** прямого конкурентного подтверждения нет — a11y-механики в C1–C4 не документированы; пункт остаётся P1 по продуктовому impact (keyboard-first заявлен в `DESIGN.md:613-614`), и это ограничение фиксируется явно. Косвенный ориентир — Zed публикует отдельную страницу tool permissions/trust, то есть документирует интерактивные гарантии (https://zed.dev/docs/ai/tool-permissions, accessed 2026-11-11).
- **Решение и границы:** scoped-нормализация фокуса (`:focus:not(:focus-visible)`), `focus-visible` стили в базе Button, forced-colors outline; ввести `--color-muted*`/`--color-ring` как алиасы существующих токенов (вариант A) или массово заменить usages (вариант B); `role="region"`+`aria-live` для toast; `ariaLabel` для композера; dialog-семантика; два ключа в 3 каталога. Out of scope: полный переход на radix-dialog, RTL.
- **Ожидаемый эффект:** видимый keyboard-фокус, восстановленный цвет ~280 мест, озвучиваемые уведомления.
- **Риски и сложность:** контраст алиаса `muted-foreground` требует проверки 4.5:1; возврат системной рамки снимается `:focus-visible`. M.
- **Приоритет:** P1.
- **Критерии приёмки:** computed style при `:focus-visible` содержит непрозрачный outline/box-shadow/border для Button/Input/Select/Tabs/Checkbox/Switch/RadioGroup; `.text-muted-foreground` присутствует в generated CSS; `getByRole("status")` находит toast.
- **Способ проверки:** Playwright-probe по матрице примитивов; unit-тест наличия `--color-*` для каждого используемого класса; jsdom-тесты ролей.

### P2

#### R24. MCP compatibility: prompts, serverInfo version, явная матрица
- **Проблема/пробел:** MCP prompts/sampling/roots/completion отсутствуют; serverInfo.version не сохраняется и не сравнивается; часть серверов несовместима.
- **Доказательство ZCode:** `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts:429-490`; `apps/zcode-cli/packages/adapters/src/mcp/index.ts:2328-2380`.
- **Подтверждение у конкурента:** Goose делает встроенные расширения MCP-серверами и проверяет malware/MCP Roots (https://goose-docs.ai/docs/getting-started/using-extensions.md, accessed 2026-11-11).
- **Решение и границы:** добавить `listPrompts/getPrompt` в port и tool-поверхность с approval либо задокументировать неподдержку в compatibility-матрице; сохранять serverInfo version и показывать drift. Out of scope: sampling/roots.
- **Ожидаемый эффект:** предсказуемая совместимость вместо тихого отсутствия.
- **Риски и сложность:** расширение поверхности и permissions; prompt injection через server prompts. M.
- **Приоритет:** P2.
- **Критерии приёмки:** prompts работают через явный tool с approval либо docs и skill `diagnosing-mcp` говорят «not supported».
- **Способ проверки:** adapter contract tests + compatibility doc.

#### R25. Client SDK: контракт reconnect/close и удаление мёртвой ветки
- **Проблема/пробел:** `connectViaWebSocket` не переподключается, `write` молча теряет данные при закрытом сокете, `onClose` у web-входа пустой; `?remote=` ветка мертва и не диагностируется.
- **Доказательство ZCode:** `packages/client/src/websocket.ts:45-49,62-108`; `packages/web/src/main.tsx:2068-2070`, `:683-690`; `packages/server/src/http.ts:468-470`.
- **Подтверждение у конкурента:** OpenCode server-first с SSE и reconnect-контрактом (https://opencode.ai/docs/server/, accessed 2026-11-11); Qwen daemon с reconnect к активным сессиям (https://github.com/QwenLM/qwen-code, accessed 2026-11-11).
- **Решение и границы:** handle с `onClose(reason)`, `reconnect()`, `dispose()`, `isClosed`; pending RPC reject при close; README с матрицей «кто владеет reconnect»; явная диагностика удалённого `?remote=`. Out of scope: встроенный backoff внутри SDK.
- **Ожидаемый эффект:** предсказуемое поведение при обрыве, отсутствие «вечных» pending.
- **Риски и сложность:** двойной reconnect (SDK + relay). M.
- **Приоритет:** P2.
- **Критерии приёмки:** close WS → все pending reject с typed reason; `?remote=` даёт явное сообщение о retired route.
- **Способ проверки:** новый `packages/client/test/websocket.test.ts`; web-тест маршрутизации.

#### R26. E2E-долг: промоушен платформенных спек и update-flow
- **Проблема/пробел:** 377 из 575 E2E — `manual-review/pending`; update-install не имеет E2E; Docker-preset'ы «verified» пусты.
- **Доказательство ZCode:** `packages/desktop/wdio.conf.ts:583-587,4778`; `scripts/test-desktop-e2e-container.sh:9-14`; `packages/desktop/src/main/autoUpdater.ts:441-538` (2 148 строк без E2E).
- **Подтверждение у конкурента:** Cursor/Devin публикуют artifacts/recordings как доказательство сценария (https://cursor.com/docs/cloud-agent/capabilities.md, accessed 2026-11-11; https://docs.devin.ai/work-with-devin/testing-and-recordings.md, accessed 2026-11-11).
- **Решение и границы:** список «платформенных P0-спек» (tray, deep link, single instance, host crash, update flow) → formal; fixture-feed для update; метрика formal/pending в E2E-отчёте. Out of scope: переписывание всех 377 спек.
- **Ожидаемый эффект:** дефолтный прогон защищает desktop-платформу, а не только conversation-session.
- **Риски и сложность:** рост времени; flaky. M.
- **Приоритет:** P2.
- **Критерии приёмки:** ≥5 платформенных спек в formal; update-state-machine тест стабилен 3 прогона.
- **Способ проверки:** `pnpm --filter @zcode/desktop test:e2e` на macOS и в Linux-контейнере.

#### R27. Продуктовая правда: CUA, LSP/notebook, residual packages
- **Проблема/пробел:** CUA — заглушка, но присутствует в зависимостях; LSP/NotebookEdit зарезервированы без handler'ов; `share-ui` с 59 зависимостями при 6 строках (wc -l packages/share-ui/src/index.ts); `android` — orphan без сборки.
- **Доказательство ZCode:** `packages/zcode-cua/package.json` (description); `core/src/tool/provider-visible-order.ts:11-27`; `handlers/edit.ts:193-198`; `packages/share-ui/src/index.ts` (6 строк, wc -l packages/share-ui/src/index.ts); `packages/android` (нет `package.json`).
- **Подтверждение у конкурента:** конкурентный ориентир — честная маркировка границ: Kilo «write boundary, not privacy boundary» (https://kilo.ai/docs/getting-started/settings/sandboxing, accessed 2026-11-11); Zed — sandbox исключает External Agents (https://zed.dev/docs/ai/sandboxing, accessed 2026-11-11).
- **Решение и границы:** явная метка «CUA unavailable in this build» в UI/docs; убрать `LSP`/`NotebookEdit`/`EnterWorktree` из provider-visible order или реализовать; решить судьбу `android` (владелец+гейт или архив); почистить `share-ui` deps. Out of scope: реализация CUA и LSP.
- **Ожидаемый эффект:** нет ложных ожиданий; инвентарь соответствует продукту.
- **Риски и сложность:** требует продуктового решения. S/M.
- **Приоритет:** P2.
- **Критерии приёмки:** ни один UI/doc не обещает работающий CUA; provider-visible order не содержит имён без handler'а; у `android` есть owner-решение.
- **Способ проверки:** `rg "Computer Use" docs packages/zcode-cua`; `pnpm knip`; чтение provider-visible order.

Покрытие 25 тем (каждая тема присутствует в backlog'е, в сильной стороне или в явном открытом вопросе): 1 Desktop → R07, R10, R26; 2 Web/server → §9.3 H15/H16, §7 п.8 (replayable/continuous); 3 UI → R23; 4 Services → R09, R10; 5 RPC/shared → R08, R25; 6 Client SDK → R25; 7 CLI/runtime → R05, R11, R21; 8 Architecture/event model → R10, R11; 9 Agent loop → R05, R13; 10 Tools → R03, R04, R08; 11 Context/memory → R18; 12 Rules/skills/plugins/MCP → R01, R02, R18, R22, R24; 13 Subagents/orchestration → R09, R10, R20; 14 Models/routing → R13; 15 Sandbox/permissions/security → R01–R08; 16 Git/PR → R19, R20; 17 IDE/editor + mobile/remote → R19, R27, §7 п.7; 18 Protocols/interop → R24, R25, R27; 19 Telemetry/evals → R06, R14, R15; 20 Performance → R14, R26, §9.3 H2; 21 Reliability → R10, R11; 22 Multiplatform → R26, R27, §9.1 п.9; 23 Monetization/product → R13, R22, §9.4 (product decisions); 24 Testing/CI/quality → R12, R15, R26; 25 Docs/DX → R21.

## 5. Быстрые победы

Только S-усилия, извлекаемые из backlog; каждая ссылается на раздел 4.

| # | Действие | ID | Усилие | Эффект |
|---|---|---|---|---|
| QW1 | Убрать `dangerouslyDisableSandbox` из model schema и telemetry `sandboxed`, оставить поле internal trace с комментарием | R04 (вариант B) | S | Исчезает ложная гарантия за один PR; модель перестаёт «выбирать» несуществующую изоляцию |
| QW2 | Перенести `isToolDisallowed` и project deny выше allow-ветки `yolo`/`guarded` | R05 | S | Hard-deny перестаёт обходиться сменой режима |
| QW3 | Прокинуть `permission.approvalTimeoutMs=300000` в `AgentRuntimeConfig.permissionTimeoutMs` | R05 | S | Зависший approval завершается `PermissionTimeout`, а не висит вечно |
| QW4 | Заменить `candidates.find(hasBusinessSignal)` на summary-форму (scalars+keys+requestId) | R06 | S | Удаляет prompt из JSONL и support bundle; размер строки ≤32 KB |
| QW5 | Заполнить `untrustedProjectMcpServers` для workspace-scope без UI-approve (fail-closed) | R01 | S | Репозиторий перестаёт молча запускать stdio; далее — digest-approve |
| QW6 | Обернуть page content / MCP result / ledger envelope в `<untrusted_external_content>` | R17 | S | Дешёвое снижение cross-agent и indirect injection |
| QW7 | Удалить 10 мёртвых fork-записей и 2 мёртвых include в `vitest.config.ts` | R12 | S | Гейт перестаёт молча не покрывать заявленное |
| QW8 | Добавить `document.documentElement.lang` при смене locale и два отсутствующих i18n-ключа | R23 | S | Корректная фонетика screen reader, нет raw-id в UI |
| QW9 | Синхронизировать `CONTEXT.md` (Recommended/Try now/сегменты) и спеки Swarm 15→16 ролей | R21 | S | Устраняет главный источник неверных реализаций |
| QW10 | Добавить Cancel в installing-состояние плагина через существующий `cancelPluginOperation` | R22 | S | Убирает «залипшую» установку без нового backend |
| QW11 | Удалить `isolation: "worktree"` из схемы до реализации | R20 (вариант B) | S | Runtime-ошибка заменяется честным отсутствием поля |
| QW12 | Заменить `writeFile` на temp+rename в `writeTelemetryState` | R14 | S | Идентичность `deviceMid` переживает crash |
| QW13 | Добавить `Secure`/`Max-Age` в lite-token cookie при `X-Forwarded-Proto: https` | R14/§9.3 H16 | S | Cookie не уходит без TLS-флага на HTTPS |
| QW14 | Удалить мёртвую ветку `?remote=` или дать ей явное сообщение о retired route | R25 | S | Пользователь с legacy-ссылкой понимает причину отказа |

## 6. Стратегические ставки

8 ставок, каждая — 2–3 квартала; порядок отражает зависимость, а не приоритет.

**S1. Execution boundary как продуктовое свойство (R03, R04, R05).** Почему стратегически: это единственная область, где все восемь «серьёзных» конкурентов (Codex, Kiro, Windsurf/Devin, Factory, Copilot, Antigravity, Zed, Claude Code) документируют явную модель, а ZCode — нет; без неё нельзя продавать enterprise и нельзя безопасно включать автономные режимы. Scope: OS-sandbox (3 платформы), `workspaceBoundary` в config+UI, перенос deny выше allow, approval timeout, digest-approval для MCP/hooks, тесты на обход через interpreter/pipe. Критерий выхода: ни одно provider-visible поле не обещает изоляцию без enforcement. Горизонт: Q1: политика и тесты обхода; Q2: OS-sandbox macOS/Linux; Q3: Windows и migration UX.

**S2. Единая модель сессии и владения (R09, R10, R11).** Почему: четыре разных «owner» (run lease, ledger claim, CommandInbox, Host attachment) сосуществуют, и один из них не подключён; без явной статус-машины нельзя строить ни mobile mirror, ни durable resume. Scope: один lifecycle-контракт сессии (created/running/waiting_approval/interrupted/closed), teardown-хук, durable task journal для обычных Agent/Task, single-flight resume, host supervision. Критерий: после kill -9 состояние восстанавливается в `interrupted`, а не в «тихо пусто». Горизонт: Q1: lifecycle-контракт и teardown; Q2: durable journal + single-flight; Q3: host supervision и mobile mirror по решению владельца.

**S3. Контекст и память как управляемая система (R18).** Почему: compaction есть, но без бюджета и без pointer; semantic recall/Dream выключены; правила и skills имеют расходящийся precedence. Scope: категорийный бюджет, детерминированная деградация, transcript pointer, file-scoped rules, project>user, включение или удаление recall/Dream. Критерий: размер prompt предсказуем, после compaction детали находимы, glob-правила работают. Горизонт: Q1: бюджет и precedence; Q2: ruleTargetPaths и transcript pointer; Q3: recall/Dream — включить или удалить.

**S4. Delivery loop (R19, R20).** Почему: это единственный крупный продуктовый пробел, где конкуренты уже стандарт (Bugbot, Agent Merge, stacked PRs, worktrees). Scope: PR-создание и review-комментарии через `gh`, ingestion checks, worktree isolation, Git-pane actions, conflict surface. Критерий: задача проходит путь branch → commit → PR → checks → review без покидания ZCode. Горизонт: Q1: `gh`-мутации + PR-панель; Q2: checks ingestion; Q3: worktree isolation и conflict surface.

**S5. Supply chain (R01, R02, R22, R17).** Почему: marketplace растёт, а trust-сигналов нет; три P0 — из этой области. Scope: digest-approval MCP/hooks, compat metadata, source validation, untrusted-рамки контента, подпись/provenance как следующий шаг. Критерий: установка плагина или открытие repo не даёт исполнения без явного решения пользователя. Горизонт: Q1: digest-approval MCP/hooks; Q2: compat metadata и source validation; Q3: подпись/provenance как отдельное решение.

**S6. Наблюдаемость продукта (R06, R13, R14, R15).** Почему: сейчас одновременно утекает prompt, отсутствует cost, нет SLO и нет delivery-метрик — то есть нельзя ни доказать приватность, ни измерить экономику. Scope: privacy-by-default логи, cost accounting + budget, consent/opt-out, delivery-метрики, durable audit. Критерий: по логам можно ответить «сколько стоил turn», «что ушло в поддержку», «кто одобрил действие». Горизонт: Q1: R06 + cost accounting; Q2: consent/opt-out и delivery-метрики; Q3: durable audit и SLO.

**S7. Промышленный тестовый контур (R12, R26).** Почему: 14 локальных шагов — сильная база, но без серверного гейта и с 33 невидимыми тестами она не защищает от обхода хука. Scope: checks-job, `.tsx`/колокейтед-тесты, платформенные E2E, update-flow, метрика formal/pending. Критерий: любой PR краснеет на регрессии без локального окружения автора. Горизонт: Q1: checks-job и `.tsx`; Q2: платформенные E2E; Q3: update-flow и formal/pending метрика.

**S8. Интероперабельность (R24, R25, R27).** Почему: рынок сошёлся на SKILL.md, MCP и ACP; ZCode — клиент, но не сервер, и без LSP. Scope: ACP-серверная половина (или явный отказ), LSP-diagnostics, MCP prompts, честный статус NotebookEdit. Критерий: внешний редактор/агент может подключиться к ZCode по стандартному протоколу, либо продукт явно декларирует client-only. Горизонт: Q1: MCP prompts и честные статусы; Q2: LSP-diagnostics; Q3: ACP-сервер или явный client-only манифест.

## 7. Сильные стороны ZCode, которые нельзя терять

1. **Единственный владелец turn loop и формализованный `maxTurns`.** `runRegularTurnLoop` — единственное место решения «ещё один шаг», проверка строго на границе (`apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:110-125`), контракт закреплён `docs/specs/max-turns-limit.md` и 19 тестами. Не терять: любая оптимизация «лимитов» не должна размазывать решение по слоям.
2. **Durable-маркер ограниченного turn.** `error_max_turns` пишется в `metadata.turnResult`, а не в `assistant.error`, поэтому текст не теряется и шаг не исключается из compact-preserved segment (`runtime/methods/message-persistence.ts:397-415`; чтение — `transcript-hydration.ts:282-290`). Не терять: это редкая корректность холодного пути.
3. **Fail-closed approval по умолчанию.** `DenyPermissionBroker` — дефолт (`runtime/agent-runtime.ts:332-333`), headless deny-всё-кроме-двух-workflow (`packages/cli/src/headless-workflow.ts:31-51`), preview-hook не превращает ask в allow (`approval-gate.ts:61-74`), session-grant живёт только в памяти (`permission-rules-persistence.ts:112-126`). Не терять: это правильная база, к которой нужно добавить enforcement, а не заменить её.
4. **Разделение синхронной политики и асинхронного согласования.** `PermissionService` (allow/ask/deny) и `PermissionBroker` (wait/modify/deny/escalate) — разные владельцы, что позволяет тестировать политику без клиента (64 теста) и согласование без модели (104 теста guarded). Не терять при рефакторинге R05.
5. **V4 wire: детерминированная упаковка и атомарная сборка.** Метрика считает три носителя (CLI NDJSON, Channel binary, mobile base64), фрагментация бинарным поиском, fail-closed (`packages/shared/src/zcode-protocol-v4/wire-codec.ts:25-77,169-240`); assembler проверяет длину, base64, дубликаты, CRC32, UTF-8, JSON и schema, ordinal tombstones не дают старым фрагментам воскресить состояние (`packages/shared/src/zcode-protocol-v4/wire-reassembly.ts:31-207`; `wire-assembler.ts:144-330`). Не терять: это конкурентное преимущество в протокольной строгости.
6. **CommandInbox.** Фиксированный порядок локов key → session, pin in-flight до освобождения key gate, общий `final` promise для дубликатов, durable fallback `transcript → marker → child → discarded` (`bootstrap/src/zcode-protocol-v4/command-inbox.ts:134-178,402-449`), 25 тестов включая churn >512. Не терять: это самая зрелая часть контура.
7. **Allowlist мобильных каналов вместо denylist.** `windowHostAttachmentRpcPolicy.ts:16-80` перечисляет разрешённые каналы, Terminal/SourceServerManagement отсутствуют, неизвестный канал fail-closed; комментарий фиксирует прошлый denylist-баг (`:73-79`). Не терять: любая новая привилегированная служба не должна автоматически попадать телефону.
8. **One-time capability и разделение replayable/continuous.** `/ws` всегда replayable, `/ws/host` требует capability 32 random bytes, TTL 30 c, ровно одно потребление (`packages/server/src/http.ts:385-419`; `hostCapability.ts:4-52`). Не терять: это правильная модель для mobile/desktop разницы.
9. **Plugin sandbox.** Отдельный `zcode-sandbox://` origin, `default-src 'none'`, домены только из `_meta.ui.csp`, `frame-ancestors` только shell, permissions policy отключает camera/mic/geo/payment/usb/clipboard, permission handler fail-closed (`packages/desktop/src/main/pluginSandbox/csp.ts:20-99`; `session.ts:103-140`). Не терять: при добавлении CSP в main window не ослабить guest-политику.
10. **Hook trust по digest.** `workspaceIdentity + hookDeclarationDigest`, revoke, stale-digest, corrupt-store fail-closed (`apps/zcode-cli/packages/core/src/hooks/workspace-hook-trust-evaluation.ts:13-50`; `apps/zcode-cli/packages/core/src/hooks/workspace-hook-trust-coordinator.ts:47-100`), project hooks вырезаются из исполняемого config (`apps/zcode-cli/packages/adapters/src/config/project-config.adapter.ts:122-138`). Не терять: это готовый шаблон для R01/R02.
11. **Subagent-каталог и caller-policy.** 16 ролей, один предикат `isAgentTypeAllowedForCaller` для каталога и для spawn, точный profile ID без generic-fallback, встроенные роли не переопределяются, child tools = пересечение с родителем (`core/src/subagent/profile.ts:16-35,819-834,967-994`; `subagent.ts:864-920`). Не терять: это сильнее, чем у большинства конкурентов.
12. **Untrusted-рамки в ключевых местах.** Subagent results, session transcript extraction, Gen UI state, workspace guidance уже обёрнуты (`runtime/methods/turn.ts:1650,1853`; `read-session-context.ts:303`; `context/sections/desktop.ts:19`; `request-user-context.ts:83`). R17 расширяет практику, а не вводит её.
13. **Trusted connection carrier.** Подделываемые поля вычищаются перед инъекцией host-контекста (`zcodeAgentConnectionScope.ts:96-110`), `clientMode` выбирает только attachment, не UI. Не терять при переходе к ACP/LSP.
14. **Architecture-as-code и privacy-гейт.** `architecture-policy.yaml` (1106 строк, 107 модулей, 51 managed) + `check-tracked-privacy.mjs`, сканирующий index и push-range blob'ы, не печатая значения. Не терять: это редкость и прямой дифференциатор для enterprise-разговора.
15. **Честные «недоступно».** CUA-заглушка fail-closed с тестом (`packages/zcode-cua/index.js:1-13`; `test/availability.test.ts`), а не имитация. Не терять: этот принцип надо расширить на LSP/NotebookEdit/provider-visible-order (R27).

## 8. Функции конкурентов, которые не стоит копировать

| # | Механика | Источник (URL, 2026-11-11) | Причина не копировать |
|---|---|---|---|
| A1 | Fail-open hooks при не-JSON stdout | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md | Ошибка hook-скрипта разрешает действие; для security hooks нужен fail-closed |
| A2 | Unauthenticated local daemon с code execution | https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md | Любой локальный процесс получает полный API; bearer auth должен быть обязательным |
| A3 | Sandbox только для shell при заявлении «sandbox» | https://code.claude.com/docs/en/sandboxing | Read/WebFetch/MCP/LSP вне границы; это ровно тот класс ложной гарантии, который есть у ZCode в Bash — не тиражировать |
| A4 | Две параллельные permission-модели | https://learn.chatgpt.com/docs/permissions.md | Удваивает состояния и миграцию; нужна одна модель с deprecated-путём |
| A5 | Permission ordering без specificity | https://opencode.ai/docs/permissions/; https://code.claude.com/docs/en/permissions | Результат зависит от порядка; трудно статически проверить |
| A6 | Поля, которые парсятся, но не отправляются | https://opencode.ai/docs/agents/ | Ложное ожидание работающей настройки; хуже отсутствия функции |
| A7 | Отсутствие permission-слоя вообще | https://aider.chat/docs/ | Агент с shell и записью без границ — неприемлемый риск по умолчанию |
| A8 | Autonomous default без подтверждений | https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md | Классификация read/write отдана LLM; «best effort» — не граница |
| A9 | Approval, который не покрывает MCP/setup processes | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall | Firewall только для Bash; MCP и setup вне контура, «sophisticated attacks may bypass» |
| A10 | Auto-run всех terminal-команд в cloud | https://cursor.com/docs/cloud-agent/security-network.md | Docs прямо признают exfiltration risk; для недоверенного контента нужен egress control |
| A11 | Autosubmit при ошибке/лимите | https://swe-agent.com/latest/reference/agent/ | Маскирует незавершённую работу под submission; отдельного failed-state нет |
| A12 | Непрозрачные ярлыки квот + точная цена overage | https://docs.devin.ai/desktop/accounts/quota.md | Клиент несёт downside, не зная базового allowance |
| A13 | Принуждение, которое исчезает на одной поверхности | https://docs.augmentcode.com/cli/permissions | Permissions не enforced в IDE-расширении: одна установка обходит контроль |
| A14 | Docs, расходящиеся с фактическим состоянием | https://kilo.ai/docs/code-with-ai/platforms/vscode/whats-new | «temporarily unavailable» против полной docs-страницы; читатель не может понять состояние |
| A15 | Молчаливое игнорирование конфигурации | https://cursor.com/docs/context/rules | `.md` без frontmatter молча игнорируется; опечатка становится отсутствующей политикой |

Практический вывод для ZCode: A3, A5, A6, A13, A14 и A15 — те же классы, которые уже присутствуют в репозитории (sandbox no-op, порядок правил, `skills.includeInstructions`, поверхностный enforcement, doc drift, молчаливое отбрасывание фрагментов). Копировать чужие механики допустимо только вместе с их антипаттернами-ограничениями. Не включены в список как менее релевантные ZCode: auto-commit по умолчанию (Aider), фиксация режима на тред (Amp), observability только на верхнем тарифе (Cursor), legacy-фичи в доках как текущие (Devin Cascade) и «defense in depth» без hard boundary (Factory) — последний уже покрыт A3 по смыслу.

## 9. Открытые вопросы и непроверенные гипотезы

### 9.1. Unknown (источники не решают)

1. **Внешний CI.** Отчёты фиксируют отсутствие GitLab/Jenkins в checkout, но не могут доказать, что внешнего пайплайна нет. Нужен доступ к инфраструктурному репозиторию. Evidence: `docs/desktop-ci-cd.md:3` описывает несуществующий `.gitlab-ci.yml`; в дереве только `.github/workflows/cross-platform-preview-release.yml:7` (`workflow_dispatch`).
2. **Наследует ли popup главного окна preload/`window.zcode` в Electron 41.** Официальная страница `window-open` говорит о наследовании security-related webPreferences, но не preload; нужен runtime-probe.
3. **Что видит пользователь при падении Host** — error boundary, «workspace not ready» или зависшие запросы. Нужен runtime-эксперимент (убить Host, снять renderer state).
4. **Реальный дефолт `permissionTimeoutMs` в собранном desktop.** В checkout присваивания нет; возможно, значение приходит из внешней конфигурации Host.
5. **Публикуются ли `.map` вместе с `packages/web/dist`.** В бандле нет `sourceMappingURL`, но 2219 карт лежат рядом; publish-скрипт в checkout отсутствует.
6. **Существуют ли `Dockerfile.web-share`/`Jenkinsfile.web-share`/`nginx.web-share*.conf`** во внешнем репозитории; от этого зависит реальность CSP для share.
7. **Требует ли продовый webhook-провайдер ручной подстановки `?token=`** при включённом `ZCODE_SERVER_AUTH_TOKEN`; нет теста `botsHttp` под authToken.
8. **Поведение `SQLITE_CORRUPT` для tasks-index** — тихо пересоздать из CLI, показать ошибку или блокировать старт.
9. **Кросс-платформенный enforcement.** Sandbox/signature/Windows ACL/AppImage не проверялись; в `packages/desktop/test/e2e` — 0 вхождений `skipIf`, в `packages/desktop/test` — 14, repo-wide шаблон `skipIf(...process.platform...)` — 67, всех `skipIf(` — 106; точная атрибуция платформенных пропусков требует отдельного прогона.
10. **Содержимое `event_text`.** Z11 подтверждает отсутствие санитайзера, но не доказывает, что туда попадает PII; нужен ответ владельца телеметрии.
11. **Совместимость старых клиентов с новыми необязательными полями V4 snapshot** — перечень «какие ключи старый клиент молча теряет» не составлялся.
12. **Эффект отсутствия `Origin`-проверки на реальные браузеры при `SameSite=Lax`** — теоретический cross-site WS-сценарий не воспроизводился.

### 9.2. Гипотезы (Inferred, требуют проверки)

1. **Host crash не приводит к respawn** — следует из отсутствия `webContents.send` в `desktopHostProcess.ts` и `rg respawn` (только fallback при reload); user impact не измерен.
2. **Симлинк-чтение обходит будущую containment-политику** — следует из `read` через `stat/readFile` без realpath; отдельного теста нет.
3. **Отсутствие `permissionTimeoutMs` маскируется тем, что desktop всегда отвечает** — нужен harness с молчащим клиентом.
4. **`yolo` + `disallowedTools` не эксплуатируется, потому что конфиг редок** — продуктовый аудит конфигов не проводился.
5. **Верхняя граница «110 физических запросов на model step» (11 adapter-retry × 10 stream recovery)** недостижима из-за взаимоисключающих путей, но десятки реальны при нестабильной сети.
6. **`?remote=`-ветка недостижима** — следует из удаления серверного маршрута (`packages/server/src/http.ts:468-470`), но grep по QR-генераторам не выполнялся.
7. **SIGTERM при `zcode --web` приводит к немедленному завершению без cleanup** — следует из отсутствия обработчика в `entry-http.ts:43-46`; runtime-проверка не выполнялась.
8. **`apps/dev-docs` тест красный из-за обновления YAML 2026-11-05**, а не из-за кода — косвенно, по датам файлов; атрибуция не доказана.

### 9.3. Гигиенические дефекты без конкурентного подтверждения

Эти пункты намеренно не включены в §4 как рекомендации с «подтверждением у конкурента», потому что источник нельзя привязать без натяжки.

| # | Дефект | Доказательство | Класс |
|---|---|---|---|
| H1 | Полный `architecture:check` красный: `missing-module-artifact packages/services/src/gen-ui` | прогон: exit 1, `violations: 1`; `architecture-policy.yaml:256-271`; файла `contract.test.ts` нет | Observed |
| H2 | `fmt:check` красный на HEAD: 164 файла (30 repo-owned + 106 `.agents/skills` + 28 `docs/research`), в pre-push не входит | V1 §1.2; повторный прогон во время синтеза дал 167 файлов (дрейф растёт с untracked research) | Observed |
| H3 | Node pin 24.14.0 не enforced: `ci:assert-node` проверяет только major ≥ 24, локально Node 26.9.0 | `scripts/assert-node-version.mjs:94-104`; `mise.toml:2` | Observed |
| H4 | Три lock-файла; корневой `package-lock.json` — носитель версии для release, не рабочий npm-lock | `package-lock.json:1-20`; `scripts/release-macos-preview.mjs:156-171,184-198` | Observed |
| H5 | `CHANGELOG.md` отсутствует при настроенном `@release-it/conventional-changelog` | `.release-it.mjs:23-33`; `git ls-files CHANGELOG.md` = 0 | Observed |
| H6 | Ветка `?remote=` формирует удалённый серверный маршрут | `packages/web/src/main.tsx:683-690`; `packages/server/src/http.ts:468-470` | Observed |
| H7 | `packages/services/src/session/contract.ts` указан в policy и отсутствует | `architecture-policy.yaml:20-31`; `git ls-files --error-unmatch` → exit 1 | Observed |
| H8 | `docs/agent-next-steps.md` цитируется Z06 как источник `workspaceKey`, но файла нет и в истории | `git log --all -- docs/agent-next-steps.md` пуст | Observed (ошибка цитирования partial) |
| H9 | `packages/web/test/remoteFrontendBuildSource.test.ts` указан в `forkIsolatedTests`, файла нет | `vitest.config.ts:32` | Observed (stale-entry, не «мёртвый include») |
| H10 | `.zcode/agents/` отсутствует, хотя prompt-контракт предписывает создавать там профили | `.zcode/` содержит только `evaluation-cases.json`; `profile.ts:72,129,338-343` | Observed |
| H11 | `AGENTS.md` требует `pnpm typecheck` и `pnpm lint`, но pre-push не содержит typecheck и fmt | `package.json:51`; `AGENTS.md:18` | Observed |
| H12 | Android-каталог без `package.json`, без CI, единственный тест проверяет имя пакета | `packages/android`; `ExampleInstrumentedTest.kt:20-22` | Observed |
| H13 | `share-ui` объявляет 59 dependencies при 6 строках кода (wc -l packages/share-ui/src/index.ts) | `packages/share-ui/src/index.ts`; `package.json` | Observed |
| H14 | `stream-animate`/`formal-proof`/`e2e-report` — 0 тестов | Z13 §3.8 | Observed |
| H15 | Malformed percent-encoding в static route даёт HTTP 500 и stack trace в stderr | `packages/server/src/http.ts:298`; probe `GET /%E0%A4%A` → 500; `staticRoutePathContainment.test.ts` этот случай не покрывает | Observed |
| H16 | Lite-token cookie без `Secure`/`Max-Age`/`__Host-`, токен принимается в query | `packages/server/src/http.ts:243-260`; `scripts/zcode-distribution/runner.mjs:131-135` | Observed (P2 при loopback, P1 при `--host 0.0.0.0`) |
| H17 | Webhook-секрет сравнивается через `!==` (не timing-safe) | `packages/services/src/bots/botsService.ts:3714,3838,3855`; корректный пример — `packages/zcode-server-cli/src/server-core/http.ts:244-256` | Observed |
| H18 | Bots webhook обязан присылать внутренний lite-token при включённом auth | `packages/server/src/http.ts:262-264,370-380`; probe: без токена 401, с токеном 200 | Observed (функциональный, не security) |
| H19 | `lint-staged` подключён, но `pre-commit`-хука нет | `lint-staged.config.mjs`; `package.json:120`; `.husky/` содержит только `commit-msg` и `pre-push` | Observed |
| H20 | `docs/testing/pre-push-hook.md:9` перечисляет 4 шага из 14 | `package.json:51` | Observed |

### 9.4. Вопросы к владельцу (product decisions)

1. Try now: считать `CONTEXT.md:73-75` устаревшим или код `PluginStoreDetailView.tsx:160-171` подлежит удалению? Без ответа §9 фиксирует противоречие, а не выбор стороны.
2. Owner/lease: включить mobile mirror (вариант A) или удалить dead-код (вариант B)? В repo нет feature-флага, объясняющего текущее состояние.
3. `auto`-режим: реализовать (поле `allowMediumRiskInAutoMode` уже есть) или удалить из `CollaborationMode` с валидацией конфига на старте?
4. CUA: остаётся заглушкой в Preview навсегда или планируется? От этого зависит формулировка в UI.
5. `packages/android`: продуктовая часть (нужен owner и гейт) или экспериментальный каталог (архив)?
6. Telemetry: применяется ли opt-out к crash reporting (обычно нет) и к ARMS-стабильности?

## 10. Какие проверки не удалось выполнить и почему

### 10.1. Не выполнялось (и почему)

| Проверка | Причина |
|---|---|
| Полный `pnpm typecheck` | Вне time-box ветки; частичные прогоны не дают права утверждать «зелено» |
| Полный `pnpm lint` | То же; узкий `npx oxlint` дал 95 warnings / 0 errors, CLI-часть 86 warnings / 0 errors / 7 accepted |
| Полный `pnpm test:unit` | 19 889 тестовых записей; ни один филиал не запускал полный набор |
| Desktop E2E (575 спек) | Требует Electron/WebDriver, Windows/Linux-раннеров и времени; 377 спек в `manual-review/pending` |
| `pnpm knip` полный | Запускался только baseline-гейт в pre-push-проверках (current=3174, baseline=3174, new=0) |
| Packaging/signing/notarization | Нет ключей Apple/Windows; Preview принудительно ad-hoc/unsigned |
| Windows/Linux runtime | Только текущая macOS-машина; 14 `skipIf` в `packages/desktop/test` (0 в `test/e2e`), `windowsInstaller*` не собираются на darwin |
| Живой provider loop | Требует API key и spend; e2e `compact-microcompact`/`memory` не запускались |
| Живой MCP/relay/marketplace/checkout | Сетевые и платёжные сценарии вне ограничений миссии |
| Browser a11y (screen reader, VoiceOver/NVDA) | Не запускался; выводы о toast/contenteditable — по отсутствию ARIA в коде |
| Бенчмарки и soak | Нет воспроизводимых наборов и времени; единственный perf-тест под `ZCODE_PERF_REPRO=1` без порогов |
| Внешний CI | Нет доступа к инфраструктурному репозиторию; в checkout только ручной workflow |
| Попытка эксплуатации уязвимостей | Запрещена условиями миссии; cross-site WS/prompt injection не воспроизводились |

### 10.2. Что реально выполнено (точные команды и результаты)

Из V1 §1.2 (независимый аудит; команды выполнены из корня репозитория):

- `git status --short` → `?? docs/research/`; `git branch --show-current` → `dev`; `git log -1 --oneline` → `d10f0b69 Выпустить macOS Preview 3.17.102.`; `git diff --stat` → пусто.
- `node scripts/architecture/architecture-check.mjs check` → exit **1**, `violations: 1`, `missing-module-artifact packages/services/src/gen-ui`.
- `node scripts/architecture/architecture-check.mjs check --changed` → exit **0**, base `merge-base upstream origin/dev`, `violations: 0`.
- `npx oxfmt --check` → exit **1**, 164 файла (30 repo-owned + 106 `.agents/skills` + 28 `docs/research`); повторный прогон синтеза → 167 (см. H2).
- `node scripts/check-doc-links.mjs` → exit **0**, 1693 файла / 2472 ссылки.
- `cd apps/dev-docs && npx vitest run` → 1 failed / 3 passed; `featureBoundaryGraph.test.ts` ожидает 324/629, реально 417/803.
- `npx vitest list --project=unit` → 19 889 записей; `.test.tsx` — 0; `--project fork-isolated` → 506 кейсов, после разрешения путей 22 файла.
- `node --version` → v26.9.0; `pnpm --version` → 10.33.2.
- `node scripts/check-workspace-freshness.mjs` → exit 0, «ahead 344 / behind 0»; напоминание: скрипт выполняет `git fetch origin --prune` (меняет только remote-tracking refs).
- Мини-probe `decodeURIComponent('%E0%A4%A')` → `URIError`; тестовый HTTP-handler → 500.
- Проверка Electron typings: `sandbox` default `true` с Electron 20 (`node_modules/electron/electron.d.ts:18827`).
- CodeIndex: `state: ready`, `partial: false`, generation 1489–1490, 10 007 файлов.

Из partial-отчётов (узкие прогоны, все зелёные, кроме отмеченных): Z02 — 76 тестов (20 + 56) в двух прогонах; Z03 — 128 тестов в 15 файлах; Z05 — 25 `command-inbox`, 17 `zcodeSessionService`, 73 `zcodeTaskIndexSyncer`, 49 `zcodeAgentProcessManager`; Z04 — 86 тестов в 5 прогонах; Z08 — 12 узких наборов; Z07 — 357 тестов; Z15 — dev-docs (красный).

Из синтеза (эта ветка, read-only): повторно проверены `git log -1`, `git status`, `git stash list` (10 записей, все старше миссии), `find docs -type f | wc -l` → 2508, `git ls-files 'docs/**/*.md' 'docs/*.md' | sort -u | wc -l` → 2088, `ls -1 scripts | wc -l` → 110, `grep -ro 'focus-visible:ring-' packages/ui/src | wc -l` → 277, `grep -ro 'text-muted-foreground' packages/ui/src | wc -l` → 208, `git grep -l -E '\.gitlab' -- 'docs/*.md' 'docs/**/*.md' | wc -l` → 15, `grep -c 'ipcMain.handle'` → 88 реальных регистраций (+1 комментарий), `ipcMain.on` → 30, preload `invoke/send/on/removeListener` → 73/25/46/34, `sed` по `desktopWindowChrome.ts:591-614`, `styles.css:120-140`, `path-policy.ts:30-40`, `bash.ts:455-462`, `permission/service.ts:165-192`, `vitest.config.ts:110-148`. Эти команды подтвердили числа, использованные в отчёте; они не заменяют runtime-прогон.

### 10.3. Что эти проверки доказывают и что нет

- Доказывают: наличие/отсутствие файлов и строк, значения констант, порядок ветвей, размеры и числа, структуру гейтов, красный/зелёный статус узких прогонов.
- Не доказывают: поведение собранного Electron, фактическое наследование preload/popup, реальный sandbox enforcement, поведение при повреждённой БД, latency/память под нагрузкой, пользовательский эффект host crash, delivery-rate телеметрии.

## 11. Приложение: источники и изученные файлы

### 11.1. Конкурентные источники (все открыты 2026-11-11)

**OpenAI Codex / Codex CLI.** https://learn.chatgpt.com/docs/app-server.md; https://learn.chatgpt.com/docs/agent-approvals-security; https://learn.chatgpt.com/docs/agent-configuration/agents-md.md; https://learn.chatgpt.com/docs/hooks.md; https://learn.chatgpt.com/docs/permissions.md; https://learn.chatgpt.com/docs/build-skills.md; https://learn.chatgpt.com/docs/non-interactive-mode.md; https://learn.chatgpt.com/docs/config-file/config-reference.md; https://github.com/openai/codex; https://learn.chatgpt.com/docs/cloud.md; https://learn.chatgpt.com/docs/environments/cloud-environments.md; https://learn.chatgpt.com/docs/sandboxing.md; https://learn.chatgpt.com/docs/cloud/internet-access.md.

**Anthropic Claude Code.** https://code.claude.com/docs/en/sandboxing; https://code.claude.com/docs/en/hooks; https://code.claude.com/docs/en/memory; https://code.claude.com/docs/en/sub-agents; https://code.claude.com/docs/en/permissions; https://code.claude.com/docs/en/plugins; https://code.claude.com/docs/en/costs; https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md.

**Google Gemini CLI.** https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/trusted-folders.md; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/core/subagents.md; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/extensions/reference.md; https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md; https://github.com/google-gemini/gemini-cli (README: Enterprise Code Assist only / no free tier / not optimized for Gemini 4+ / migration to Antigravity CLI on 2026-06-18 — статус подтверждён первичным README, а не только меткой CLAIM).

**OpenCode.** https://opencode.ai/docs/server/; https://opencode.ai/docs/permissions/; https://opencode.ai/docs/lsp/; https://opencode.ai/docs/agents/; https://opencode.ai/docs/providers/; https://opencode.ai/docs/skills/; https://opencode.ai/docs/.

**Aider.** https://aider.chat/docs/repomap.html; https://aider.chat/docs/more/edit-formats.html; https://aider.chat/docs/git.html; https://aider.chat/docs/leaderboards/; https://aider.chat/docs/usage/modes.html; https://aider.chat/docs/usage/watch.html; https://aider.chat/docs/install.html.

**Qwen Code.** https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/developers/architecture.md (доступен, 200, 13 043 байта, описывает agent/tool loop — правка V2, снимающая UNKNOWN C1); https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/model-providers.md; https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/configuration/settings.md; https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sub-agents.md; https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/sandbox.md; https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/approval-mode.md; https://raw.githubusercontent.com/QwenLM/qwen-code/main/README.md.

**Cline.** https://docs.cline.bot/sdk/architecture/hub-spoke; https://docs.cline.bot/features/auto-approve; https://docs.cline.bot/features/subagents.md; https://docs.cline.bot/core-workflows/checkpoints; https://docs.cline.bot/cli/agent-teams.md; https://docs.cline.bot/usage/acp.md; https://docs.cline.bot/enterprise-solutions/monitoring/telemetry.md; https://raw.githubusercontent.com/cline/cline/main/apps/vscode/webview-ui/src/hooks/useProviderUsageCostDisplay.ts.

**Kilo Code.** https://kilo.ai/docs/getting-started/settings/sandboxing; https://kilo.ai/docs/getting-started/settings/auto-approving-actions; https://kilo.ai/docs/customize/context/context-condensing; https://kilo.ai/docs/code-with-ai/agents/orchestrator-mode; https://kilo.ai/docs/code-with-ai/agents/auto-model; https://kilo.ai/docs/getting-started/cost-controls-and-usage-safeguards; https://kilo.ai/docs/customize/custom-subagents; https://kilo.ai/docs/automate/agent-manager; https://kilo.ai/pricing.

**Roo Code (архив).** https://roocodeinc.github.io/Roo-Code/; https://api.github.com/repos/RooCodeInc/Roo-Code (archived, pushed_at 2026-05-15); https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks; https://roocodeinc.github.io/Roo-Code/features/codebase-indexing.

**Continue (read-only, acquired by Cursor).** https://github.com/continuedev/continue; https://www.continue.dev/; https://docs.continue.dev/reference; https://docs.continue.dev/customize/models; https://docs.continue.dev/cli/quickstart; https://hub.continue.dev (DNS-отказ, как и утверждает источник).

**Goose.** https://goose-docs.ai/docs/guides/managing-tools/goose-permissions.md; https://goose-docs.ai/docs/getting-started/using-extensions.md; https://goose-docs.ai/docs/guides/recipes/recipe-reference.md; https://goose-docs.ai/docs/guides/config-files.md; https://goose-docs.ai/docs/guides/usage-data.md; https://goose-docs.ai/docs/guides/context-engineering/subagents.md.

**Amp (ampcode.com; закрытый, сравнение только внутри шести C2).** https://ampcode.com/docs/markdown/the-dial; https://ampcode.com/docs/markdown/tools; https://ampcode.com/docs/markdown/models-and-subagents; https://ampcode.com/docs/markdown/pricing; https://ampcode.com/docs/markdown/threads; https://ampcode.com/docs/markdown/orbs/sizes-and-costs; https://ampcode.com/docs/markdown/customize/plugins; https://ampcode.com/docs/markdown/customize/mcp; https://ampcode.com/llms.txt; https://registry.npmjs.org/@ampcode/plugin/latest.

**Cursor.** https://cursor.com/docs/agent/security/run-modes; https://cursor.com/docs/agent/hooks; https://cursor.com/docs/context/rules; https://cursor.com/docs/context/codebase-indexing; https://cursor.com/docs/subagents.md; https://cursor.com/docs/bugbot.md; https://cursor.com/docs/enterprise/opentelemetry-export.md; https://cursor.com/docs/cloud-agent/security.md; https://cursor.com/docs/cloud-agent/security-network.md; https://cursor.com/docs/cloud-agent/capabilities.md; https://cursor.com/help/account-and-billing/pricing.md; https://cursor.com/pricing; https://cursor.com/blog/joining-spacex.

**Windsurf / Devin Desktop (Cognition).** https://devin.ai/desktop; https://docs.devin.ai/desktop/devin-local/modes.md; https://docs.devin.ai/desktop/devin-local/permissions.md; https://docs.devin.ai/desktop/cascade.md; https://docs.devin.ai/desktop/accounts/quota.md; https://docs.devin.ai/desktop/fusion.md; https://docs.devin.ai/desktop/adaptive.md; https://docs.devin.ai/desktop/acp.md; https://docs.windsurf.com/windsurf/cascade/cascade (308 → docs.devin.ai); https://cognition.com/blog/windsurf (подтверждение приобретения Windsurf компанией Cognition).

**GitHub Copilot (Agent / coding agent).** https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent; https://docs.github.com/en/copilot/concepts/agents/copilot-on-github; https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall; https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment; https://docs.github.com/en/copilot/get-started/plans; https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/content-exclusion. **Copilot Workspace как отдельный продукт:** first-party docs отсутствуют (оба проверенных пути 404); единственный первичный источник — анонс 2024-04-29 https://github.blog/news-insights/product-news/github-copilot-workspace/ — статус покрытия **partial**.

**JetBrains AI (AI Assistant / Junie / Air).** https://www.jetbrains.com/help/ai-assistant/agents.html; https://www.jetbrains.com/help/ai-assistant/licensing-and-subscriptions.html; https://junie.jetbrains.com/; https://blog.jetbrains.com/ai/2026/11/air-in-jetbrains-ides-ga/.

**Zed AI.** https://zed.dev/docs/ai/sandboxing; https://zed.dev/docs/ai/tool-permissions; https://zed.dev/pricing; https://api.github.com/repos/zed-industries/zed; https://api.github.com/repos/zed-industries/agent-client-protocol.

**Kiro.** https://kiro.dev/docs/permissions/; https://kiro.dev/docs/sandbox/; https://kiro.dev/docs/acp/ (страница доступна, 200, описывает ACP client → Kiro harness — правка V2).

**Trae.** https://docs.trae.ai/llms.txt; https://docs.trae.ai/ide/permission-and-approval; https://docs.trae.ai/ide/auto-run-and-security.

**Augment Code.** https://docs.augmentcode.com/cli/permissions; https://docs.augmentcode.com/cosmos/workers-subagents.md; https://www.augmentcode.com/pricing; https://www.augmentcode.com/context-engine (baseline сравнения — Claude Code, не «grep-based агент» — правка V2).

**Devin.** https://docs.devin.ai/get-started/devin-intro.md; https://docs.devin.ai/work-with-devin/devin-session-tools.md; https://docs.devin.ai/onboard-devin/environment/blueprints.md; https://docs.devin.ai/work-with-devin/dynamic-workflows.md; https://docs.devin.ai/cli/sandbox.md; https://docs.devin.ai/admin/billing/usage.md; https://docs.devin.ai/admin/billing/self-serve.md; https://devin.ai/pricing; https://docs.devin.ai/work-with-devin/testing-and-recordings.md; https://docs.devin.ai/work-with-devin/stacked-prs.md; https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md; https://docs.devin.ai/_llms/en/api.txt.

**OpenHands.** https://github.com/OpenHands/OpenHands; https://docs.openhands.dev/sdk/arch/overview.md; https://docs.openhands.dev/sdk/arch/agent.md; https://docs.openhands.dev/sdk/arch/condenser.md; https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox.md; https://docs.openhands.dev/openhands/usage/cloud/cloud-api.md; https://docs.openhands.dev/openhands/usage/customization/hooks.md; https://docs.openhands.dev/sdk/guides/critic.md; https://www.openhands.dev/pricing.

**SWE-agent / mini-SWE-agent.** https://github.com/SWE-agent/SWE-agent; https://swe-agent.com/latest/background/aci/; https://swe-agent.com/latest/config/config/; https://swe-agent.com/latest/reference/agent/; https://swe-agent.com/latest/usage/batch_mode/; https://swe-agent.com/latest/usage/trajectories/; https://github.com/SWE-agent/mini-swe-agent; https://arxiv.org/abs/2405.15793; https://ar5iv.labs.arxiv.org/html/2405.15793; https://www.swebench.com/.

**Factory Droid.** https://docs.factory.com/autonomy-and-safety/sandbox; https://docs.factory.com/droid-computers/overview; https://docs.factory.com/benchmarks/terminal-bench; https://docs.factory.com/benchmarks/review-benchmark; https://docs.factory.com/agent-effectiveness/overview; https://docs.factory.com/changelog/release-notes.md.

**Antigravity.** https://antigravity.google/docs/subagents; https://antigravity.google/docs/permissions/; https://antigravity.google/docs/artifacts/; https://antigravity.google/docs/enterprise/; https://antigravity.google/docs/models/; https://antigravity.google/docs/plans/.

**Смежные cloud-источники.** https://cursor.com/docs/cloud-agent/capabilities.md; https://cursor.com/docs/cloud-agent/self-hosted.md; https://cursor.com/docs/cloud-agent/api/endpoints.md (20 req/min документированы в https://cursor.com/docs/api.md, а не в endpoints.md — правка V2); https://cursor.com/docs/cloud-agent/builds.md.

### 11.2. Проверенные файлы ZCode (компактно, по пакетам)

Правило чтения ссылок: полный путь указан там, где basename неоднозначен. Сокращённые basename (`message-persistence.ts`, `turn-stop.ts`, `hostCapability.ts`, `subagent.ts`, `approval-gate.ts`, `permission-rules-persistence.ts`, `transcript-hydration.ts`, `windowHostAttachmentRpcPolicy.ts`, `usage-stats.ts`, `pluginManagementService.ts`, `recommendedPlugins.ts`, `PluginStoreDetailView.tsx`, `PluginStoreSourcesDialog.tsx`, `GitActionMenu.tsx`, `useGitBranchSwitcher.ts`, `node-execution-adapter-run.ts`, `credentialService.ts`, `webfetch-network.ts`, `bash-readonly-policy-multiword-core.ts`, `pluginSandbox/session.ts`) резолвятся в пакет, названный в том же абзаце или строке таблицы, и происходят из соответствующего partial §8; V1 подтвердил корректность такого разрешения по контексту (V1 §1.3, §4.3). Ни один путь в отчёте не является реконструкцией по памяти.

- **Desktop:** `packages/desktop/src/main/desktopWindowChrome.ts:591-614,664-736`; `src/main/desktopHostProcess.ts:251-273,647-713`; `src/main/desktopWindowLifecycle.ts:146-189,275-287`; `src/main/taskRealtimeBus.ts:321-397,520-546`; `src/main/autoUpdater.ts:441-538`; `src/main/forceUpdateGuard.ts:13-15,76-120`; `src/main/pluginSandbox/csp.ts:20-99`; `src/preload/index.ts:264-934`; `src/renderer/index.html`; `electron-builder.config.js:670-676,913-1037`.
- **Web/server:** `packages/web/src/main.tsx:683-690,2032-2107`; `packages/web/src/auth/browserOAuthCredentialRepo.ts:12-20,95-111`; `packages/server/src/http.ts:181-201,243-268,291-336,352-419,421-486`; `packages/server/src/hostCapability.ts:4-52`; `packages/server/src/entry-http.ts:19-46`; `packages/zcode-server-cli/src/server-core/http.ts:54-69,212-306`.
- **UI:** `packages/ui/src/styles.css:91-96,120-139,150-166`; `components/ui/button.tsx:10-37`; `components/ui/toast.tsx`; `settings/PluginStoreDetailView.tsx:160-171`; `settings/PluginStoreCard.tsx:187-226`; `settings/PluginStoreListView.tsx:37,167-196,237-243`; `v4/SessionPane.tsx:5555-5571`; `i18n/IntlProvider.tsx:19-27,123-137`; `store/index.ts:234,347-351`.
- **Services:** `packages/services/src/zcode-agent/zcodeAgentService.ts:1416,1648,2091-2100,2333-2343,4453-4470`; `zcodeTaskServiceAdapter.ts:533-550,611-660,1698-1712,2102-2110`; `session/zcodeTaskService.ts:315-359`; `git/repo/gitCliRepo.ts:1423-1673`; `git/repo/gitCliHelpers.ts:244-359`; `credential/providers/credentialCipherProvider.ts:20-37,60-105`; `telemetry/telemetryCore.ts:162-166,419,439-444`; `logger/serviceLogger.ts:18-56`.
- **RPC/shared/client:** `packages/rpc/src/protocol.ts:24-39,86-178,196-308`; `persistent-protocol.ts:77-96,180-249`; `channelServer.ts:22-36,68-98,136-178`; `channelClient.ts:66-147,186-193`; `proxy-channel.ts:37-147,178-213`; `packages/shared/src/zcode-protocol/index.ts:134-144,425-472,4602-4739,4747+`; `zcode-protocol-v4/core.ts:7,34-100`; `zcode-protocol-v4/wire.ts:7-158`; `wire-codec.ts:25-77,169-240`; `wire-assembler.ts:144-330`; `packages/client/src/websocket.ts:45-49,62-108`; `packages/shared/src/platform.ts:683-1229`; `packages/shared/src/web-remote-control.ts:744-756`.
- **CLI/runtime:** `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:124-260`; `turn-loop.ts:49-55,110-347`; `turn-model-step.ts:142-822`; `turn-stop.ts:86,137,157-237`; `permission/service.ts:117-291,367-452`; `permission/broker.ts:24-39,108-126`; `tool/path-policy.ts:32-39`; `tool/handlers/bash.ts:328,444-461`; `tool/handlers/index.ts:83-154,222-306`; `tool/provider-visible-order.ts:1-51`; `compact/policy.ts:6-14,67-155`; `compact/prompt.ts:146-148`; `context/builder.ts:40-120,222-337`; `apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts:51-86`; `runtime/helpers/turn-errors.ts:266-334`; `adapters/src/plugins/index.ts:112,371-376`; `adapters/src/skills/roots.ts:46-55`; `adapters/src/mcp/index.ts:2328-2413`; `adapters/src/model/provider-finish-business-error.ts:99-118,224-230`; `adapters/src/logging/serialize.ts:111-160`; `adapters/src/fs/index.ts:54,155-260,700-755,1708-1731`; `bootstrap/src/zcode-protocol/mcp.ts:74-76`; `bootstrap/src/app/runtime-config.ts:116-121,178-182`; `bootstrap/src/zcode-protocol-v4/command-inbox.ts:110-150,402-449`; `bootstrap/src/app/script-workflow-runtime.ts:282-284`; `contracts/src/workflow/script.ts:42-49`.
- **Корень и инфраструктура:** `package.json:3,18-19,51,58,69,76-77,93-99,120,134-137`; `vitest.config.ts:11-148`; `architecture-policy.yaml:5-50,256-271,854-865`; `mise.toml:1-7`; `.husky/pre-push:17`; `.github/workflows/cross-platform-preview-release.yml:3-12,27-45,101-120,158-209`; `scripts/assert-node-version.mjs:65-104`; `scripts/check-workspace-freshness.mjs:35-57`; `scripts/check-doc-links.mjs:1-20,128-133`; `scripts/release-macos-preview.mjs:156-171,184-198`; `CONTEXT.md:50-52,73-75`; `DESIGN.md:398,448,486,613-614`; `AGENTS.md:10,18,47,64-67,81-85`.

### 11.3. Корпус исследования

19 canonical partial-файлов (`<repo-root>/docs/research/partials/`):

1. `2026-11-11-zcode-01-inventory.md` (711 строк)
2. `2026-11-11-zcode-02-desktop.md` (383)
3. `2026-11-11-zcode-03-web-server.md` (587)
4. `2026-11-11-zcode-04-ui.md` (699)
5. `2026-11-11-zcode-05-services-session.md` (440)
6. `2026-11-11-zcode-06-rpc-shared-client.md` (442)
7. `2026-11-11-zcode-07-cli-runtime-agent-loop.md` (725)
8. `2026-11-11-zcode-08-tools-providers.md` (575)
9. `2026-11-11-zcode-09-context-memory-skills-mcp.md` (783)
10. `2026-11-11-zcode-10-subagents-orchestration-protocols.md` (712)
11. `2026-11-11-zcode-11-telemetry-perf-reliability.md` (734)
12. `2026-11-11-zcode-12-security-trust.md` (521)
13. `2026-11-11-zcode-13-git-pr-editor-residual-packages.md` (611)
14. `2026-11-11-zcode-14-testing-ci-docs-dx.md` (491)
15. `2026-11-11-zcode-15-product-onboarding-marketplace.md` (589)
16. `2026-11-11-competitors-c1-terminal-agents.md` (753)
17. `2026-11-11-competitors-c2-ide-extensions.md` (692)
18. `2026-11-11-competitors-c3-commercial-ides.md` (989)
19. `2026-11-11-competitors-c4-autonomous-agents.md` (572)

3 файла верификации:

1. `2026-11-11-verification-zcode-evidence.md` (574) — V1: 182 утверждения (149 Confirmed, 21 Corrected, 12 Unverifiable, 0 Invented), приоритетные правки §6, material corrections §7, unknowns §8.
2. `2026-11-11-verification-competitor-sources.md` (368) — V2: 15 обязательных продуктов проверены, 88 URL: 82 supports, 5 partially, 1 does not support (Qwen architecture), 0 unreachable; обязательные исправления §9.4.
3. `2026-11-11-verification-coverage-compliance.md` (308) — V3: 25 тем (23 Covered, 2 Partially), 19/19 структурно полны, группы дублей G1–G17, PASS с оговорками по ограничениям.

**Параллельный корпус:** `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/` (9 файлов) существует и местами дублирует C1–C4 (G1 — Codex/Copilot/Cursor/Windsurf, G2 — Cline/Roo/Kilo/Continue, G3 — OpenCode/Aider/Amp/Goose, G4 — Zed/JetBrains/Devin). Он **не** используется как канонический: единственная ссылка в partial — Z11 → part-d. Риск двух версий истины зафиксирован V3 (V-07); синтез опирается только на 19 partial.

### 11.4. Известные ограничения источников

- **GitHub API rate limit.** Анонимный `api.github.com` в ходе V2 отдавал 403 (`core.remaining = 0`); метаданные лицензий/архивации/релизов перепроверены через аутентифицированный `gh api`, числа совпали. В C1 часть повторных запросов (свежие stars/commits/contents) не выполнялась.
- **404 как negative evidence.** C1/C2/C3/C4 корректно фиксируют недоступные страницы; 404 не означает отсутствия функции. Примеры: Copilot Workspace docs (оба пути 404), `docs.cline.bot/features/browser-use` (404), `opencode.ai/docs/usage/` (404), `ampcode.com/docs/telemetry` (404), `docs.devin.ai/enterprise/security` (404).
- **C1 не содержит inline URL/ID в §6.** Трассировка рекомендаций C1 возможна только вручную по продукту и §8 (117 источников `C1-01…C1-117`); в отчёте это учтено — рекомендации с C1-механиками ссылаются на §8-источники напрямую.
- **Copilot Workspace.** Как отдельный продукт покрыт partial: first-party docs отсутствуют, единственный первичный источник — анонс 2024 года; механики Workspace не описаны.
- **SPA-payload Trae.** Тело статей извлекалось из встроенного JSON-payload; часть таблиц в payload пуста, поэтому table-only механики могут отсутствовать.
- **Вендорские claims.** Бенчмарки (Factory Terminal-Bench 63.1%, Agent Arena 1330/1263, Aider 88.0% при $29.08, Qwen 76.40–77.80% SWE-bench Verified, mini-SWE-agent >74%) не воспроизводились; в отчёте они либо не используются, либо помечены как CLAIM.
- **C1 §6 anti-pattern таблица без URL-колонки** — источники разрешаются через §8; в §8 настоящего отчёта все антипримеры даны с прямым URL.
- **Динамические страницы.** Цены и тарифы — снимок на 2026-11-11; расхождение docs vs marketing (JetBrains $10/$30 против $8.33/$25) зафиксировано как реальное, а не разрешено произвольно.

### 11.5. Состояние репозитория и ограничения миссии

- HEAD `d10f0b69`; ветка `dev`; `git status --short` → только `?? docs/research/`; `git diff --stat` пуст; коммитов сверх HEAD нет.
- 10 pre-existing stash-записей, новейшая 2026-11-07 22:16 (+03), все старше даты миссии; не трогались.
- `check-workspace-freshness.mjs` выполняет `git fetch origin --prune`: меняются только remote-tracking refs, worktree и коммиты не затрагиваются.
- Единственное изменение рабочего дерева — untracked `docs/research/` (19 partial + 3 verification + этот отчёт + pre-existing evidence-корпус).
- Продуктовый код, конфиги, lockfile, тесты и `.agents/skills` не изменялись; пакеты не устанавливались; коммиты не создавались; деструктивных git-операций не было.
