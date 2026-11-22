# V3 — Аудит покрытия исследования и соблюдения ограничений миссии

- Branch ID: V3 (parent ORCH-ZCODE-WIDE-RESEARCH)
- Дата аудита: 2026-11-11
- Ветка: `dev`; HEAD: `d10f0b69 Выпустить macOS Preview 3.17.102.`
- Роль: оценщик покрытия, не фактчекер утверждений (это V1/V2)
- Язык: русский
- Режим: read-only; записан только этот файл

## 1. Method and preflight

### 1.1. Preflight (Observed)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
$ git diff --stat
(пусто)
$ git diff --cached --stat
(пусто)
$ git stash list | wc -l
10
$ find docs/research -type f | wc -l
28
```

- `git status --porcelain --untracked-files=all | grep -v '^?? docs/research/'` → пусто. Все 28 untracked-файлов лежат под `docs/research/`.
- Untracked-корпус на момент начала аудита: 19 исследовательских partial-файлов (`partials/2026-11-11-*.md`) + 9 файлов `docs/research/2026-11-11-zcode-broad-competitive-research-evidence/*.md` = 28. После записи этого аудита — 29 файлов, 20 partial-файлов.
- `git log --all --since='2026-11-11 00:00'` → пусто: коммитов после базового `d10f0b69` нет ни в одной ref.
- `git reflog -12` → только commit/reset от 2026-11-09/10; записей checkout нет. Stash-записи: 10, новейшая 2026-11-07 22:16 (+03), все старше даты миссии.
- CodeIndex: `state: ready`, `partial: false`, generation 1490, 10007 files. Использован только как проверка доступности; выводы ниже построены на чтении research-файлов и git-метаданных.

### 1.2. Что читалось

1. Полностью: `docs/research/partials/2026-11-11-zcode-01-inventory.md` (Z01) — верхнеуровневая карта, инвентарь пакетов, гейты, карта филиалов.
2. Разделы 1–2 каждого из остальных 18 partial-файлов (Z02–Z15, C1–C4) — scope/method и coverage table.
3. Целевые разделы 3–8: event flow и ownership (Z05), протокол V4 (Z06), agent loop (Z07), tools/providers (Z08), context/MCP (Z09), протоколы (Z10), telemetry/perf/reliability (Z11), security (Z12), git/editor/residual (Z13), testing/CI/docs (Z14), product/marketplace (Z15), competitor mechanics и рекомендации (C1–C4).
4. Структурная проверка: `grep '^## '` по всем 19 partial; подсчёт строк-источников в §8; `rg` по ключевым темам и пакетам; mtimes файлов; runtime `metadata.json` филиалов.

### 1.3. Границы аудита

- Аудит документарный: я не перепроверял file:line-факты ZCode и не открывал внешние URL конкурентов. Это работа V1/V2.
- «Покрыто» здесь означает: в корпусе есть отдельный содержательный раздел с evidence-якорями, а не «утверждение верно».
- Сравнение состояний выполнялось одинаковыми командами (`git status`, `git diff`, `git log`, `git stash list`, `find`), без переключения ветки и без записи в проверяемые файлы.

## 2. Partial completeness and headings

### 2.1. Структура

Все 19 исследовательских partial-файлов содержат все восемь обязательных H2-разделов в порядке 1–8; восемь из них добавляют отдельный H2 с coverage-status после §8:

| Partial | §1 | §2 | §3 | §4 | §5 | §6 | §7 | §8 | Coverage status | Write confirmation | Строк |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Z01 | да | да | да | да | да | да | да | да | да, отдельный H2 (701) | да | 711 |
| Z02 | да | да | да | да | да | да | да | да | да, внутри §8 (379) | да | 383 |
| Z03 | да | да | да | да | да | да | да | да | да, §8.6 (579) | да | 587 |
| Z04 | да | да | да | да | да | да | да | да | да, §8 tail (695) | да | 699 |
| Z05 | да | да | да | да | да | да | да | да | да, tail (431) | да | 440 |
| Z06 | да | да | да | да | да | да | да | да | да, tail (438) | да | 442 |
| Z07 | да | да | да | да | да | да | да | да | да, §8.5 (717) | да | 725 |
| Z08 | да | да | да | да | да | да | да | да | да, отдельный H2 (565) | да | 575 |
| Z09 | да | да | да | да | да | да | да | да | да, tail (777) | да | 783 |
| Z10 | да | да | да | да | да | да | да | да | да, отдельный H2 (702) | да | 712 |
| Z11 | да | да | да | да | да | да | да | да | да, отдельный H2 (707) | да | 734 |
| Z12 | да | да | да | да | да | да | да | да | да, H2 «Статус покрытия» (506) | да | 521 |
| Z13 | да | да | да | да | да | да | да | да | да, отдельный H2 (593) | да | 611 |
| Z14 | да | да | да | да | да | да | да | да | да, §8.3 (486) | да | 491 |
| Z15 | да | да | да | да | да | да | да | да | да, §8.5 (520) | да | 589 |
| C1 | да | да | да | да | да | да | да | да | да, tail (749) | да | 753 |
| C2 | да | да | да | да | да | да | да | да | да, H2 (682) | да | 692 |
| C3 | да | да | да | да | да | да | да | да | да, H2 (962) | да | 989 |
| C4 | да | да | да | да | да | да | да | да | да, tail (568) | да | 572 |

Итог: 19/19 — все восемь разделов и coverage-status присутствуют; 19/19 — есть заявление «записан только этот файл».

### 2.2. Нарушения и дефекты структуры

| ID | Дефект | Доказательство | Серьёзность |
|---|---|---|---|
| V-01 | Карта покрытия Z01 устарела: §2.1 утверждает, что существуют только Z01–Z10, а Z11–Z16 не назначены. Итоговый корпус содержит Z11–Z15. | `2026-11-11-zcode-01-inventory.md:89-105`; mtimes: Z01 10:42, Z11 12:55, Z12 12:46, Z13 12:46, Z14 13:22, Z15 12:53; runtime metadata Z11–Z15 = completed | Высокая для синтеза |
| V-02 | Следствие V-01: рекомендация Z01 R-11 «спланировать Z11–Z16» устарела — пять из шести областей уже закрыты. | `Z01:502-511` | Средняя |
| V-03 | Разное размещение coverage-status: у 8 partial это дополнительный H2 после §8, у остальных — подраздел §8. Формально требование выполнено, но машинная проверка «8 headings» может считать лишние H2 нарушением. | `Z01:701`, `Z08:565`, `Z10:702`, `Z11:707`, `Z12:506`, `Z13:593`, `C2:682`, `C3:962` | Низкая (косметика) |
| V-04 | Z12 использует русские H2 «Статус покрытия / Not checked / Подтверждение записи» вместо английских; содержательно эквивалентно. | `Z12:506-521` | Низкая |
| V-05 | В Z09 один смешанный артефакт языка: «Plugin agents V1 не运行» (китайский глагол внутри русской фразы). | `Z09:771` (строка C-05) | Низкая |
| V-06 | C1 в §6 не содержит ни inline URL, ни source-ID на строку рекомендации; трассировка возможна только вручную по продукту и §8. | `C1:515-591`, §8 `C1:625-748` | Средняя для final report |
| V-07 | 9-файловый evidence-корпус `2026-11-11-zcode-broad-competitive-research-evidence/` дублирует C1–C4, но partial-файлы на него почти не ссылаются (единственное исключение — Z11 ссылается на part-d). | `Z11:153,297`; другие partial — 0 ссылок | Средняя (риск двух версий истины) |
| V-08 | C1, C3 и C4 не фиксируют git-preflight (branch/HEAD/`git status`), в отличие от Z01–Z15 и C2. Их ограничительные декларации («only this file was written») не подкреплены снимком состояния. | `C1:1-30` (нет git-строк); `C3:1-10` (ветка/дата без HEAD/status); `C4:1-8` (только дата); для сравнения `C2:5,656` | Средняя для аудита ограничений |

## 3. 25-theme coverage matrix

Статусы: **Covered** — есть содержательный раздел с evidence; **Partially covered** — тема названа, но часть заявленных измерений не проверена; **Not covered** — отдельного разбора нет.

| # | Тема | Статус | Ветки | Evidence anchors | Пробел |
|---|---|---|---|---|---|
| 1 | Desktop | Covered | Z02 | `Z02` §2 (25-66), §3.2–3.9 (76-156), §4 (157-169), §6 R1–R7 (181-266) | Нет запуска Electron/WDIO, Windows/Linux-сборок |
| 2 | Web/server | Covered | Z03 | `Z03` §3.1–3.10 (47-151), §4 (152-236), §6 R-01–R-11 (252-374), §8.1–8.5 (390-578) | Нет живого relay и внешнего деплоя |
| 3 | UI | Covered | Z04 | `Z04` §2 (56-74), §3.1–3.10 (77-204), §4.1–4.10 (207-333), §6 R-01–R-12 (357-502) | Нет реального Electron/screen-reader прогона |
| 4 | Services | Covered | Z05 | `Z05` §3.1–3.5 (51-99), §4 G1–G14 (100-165), §6 CR-1–CR-10 (179-290) | Часть lifecycle-выводов без runtime |
| 5 | RPC/shared | Covered | Z06 | `Z06` §3.2–3.4 (79-144), §4 (155-216), §6 R1–R9 (230-339) | Нет fuzz/property-тестов, runtime reconnect |
| 6 | Client SDK | Covered (тонко) | Z06 | `Z06` §3.5 (145-154), §4.9 (205-209), R6 (292-303) | Один подраздел; reconnect/auth/cancellation не документированы |
| 7 | CLI/runtime | Covered | Z07 | `Z07` §3.1–3.8 (69-279), §4 (280-363), §6 R1–R10 (388-531) | Нет real-provider E2E и полного suite |
| 8 | Architecture/event model | Covered (фрагментировано) | Z05, Z06, Z01, Z14, Z10 | `Z05` §3.4–3.5 (76-99); `Z06` §3.3 (105-134); `Z01` §3.4 (219-262), G-2/G-14 (334,358); `Z14` §3.2 (71-106); `Z10` §3.6 (247-283) | Нет единого end-to-end разбора слоёв и порядка событий Desktop→Host→CLI→UI; выводы распределены |
| 9 | Agent loop | Covered | Z07 | `Z07` §3.1 (69-124), §4.1 (284-357) | Нет живого provider-loop |
| 10 | Tools | Covered | Z08 | `Z08` §3.1–3.5 (61-142), §4 G-01–G-15 (168-265) | Нет Windows/PTY/sandbox runtime |
| 11 | Context/memory | Covered | Z09, Z07 | `Z09` §3.1 (78-112), §3.3 (136-155); `Z07` §3.7 (236-243) | Semantic recall/Dream выключены; оценка токенов эвристическая |
| 12 | Rules/skills/plugins/MCP | Covered | Z09 | `Z09` §3.2 (113-135), §3.4 (156-189), §3.5 (190-213), §3.6 (214-250) | Нет сетевого marketplace/MCP runtime |
| 13 | Subagents/orchestration | Covered | Z10 | `Z10` §3.1–3.5 (71-246), §4.1–4.16 (288-381) | Dynamic workflow и subagent-factory покрыты частично |
| 14 | Models/routing | Covered | Z08, Z15 | `Z08` §3.6 (143-167); `Z15` §3.2 (96-117) | Нет wire-матрицы 4 форматов × все tool-фичи; cost не считается |
| 15 | Sandbox/permissions/security | Covered | Z12, Z07, Z08 | `Z12` §3.1–3.8 (44-153), §4 (176-217); `Z07` §3.2 (125-164); `Z08` G-01/G-02 (170-183) | Sandbox не enforced; web/relay проверены статически |
| 16 | Git/PR | Covered | Z13 | `Z13` §3.1–3.5 (83-138), §4 G1–G18 (238-337) | Нет PR/CI-контура в продукте |
| 17 | IDE/editor + mobile/remote | Covered | Z13, Z03, Z02, Z04 | `Z13` §3.6 (139-151), G8 (276-281); `Z03` §3.4 (77-86), §3.8 (119-127); `Z02:175`; `Z04` §4.7 (303-310) | IDE-половина — негативный вывод (нет extension/LSP); mobile покрыт сильно |
| 18 | Protocols/interop | Covered | Z10, Z06, Z08 | `Z10` §3.6 (247-283), R11 (523-534); `Z06` §3.3 (105-134); `Z08` MCP-разделы | ZCode Protocol — partial; LSP отсутствует; ACP только client |
| 19 | Telemetry/evals/metrics | Covered | Z11, Z15 | `Z11` §3.1–3.7 (91-227), §4.1–4.14 (270-373); `Z15` §3.6 (159-169) | Нет SLO, quality-evals, delivery-метрик |
| 20 | Performance | Partially covered | Z11, Z04 | `Z11` §3.8 (228-241), §4.4 (301-308), §4.12 (357-363); `Z04` §3.9 (180-189), §4.8 (311-317) | Large-repo, throughput, latency-бюджеты, soak — только по коду/докам; live замеры одной машины |
| 21 | Reliability | Covered | Z11, Z05, Z02 | `Z11` §3.9–3.10 (242-265), §4.9 (333-348); `Z05` §4; `Z02` §3.2/§3.4 | Нет реального host crash и soak |
| 22 | Multiplatform | Partially covered | Z02, Z14, Z13 | `Z02` §3.8 (141-150); `Z14` §3.5 (139-149); `Z13` §3.8 android (163-235) | Нет Windows/Linux runtime и build; Android — orphan без CI |
| 23 | Monetization/product | Covered | Z15, Z01 | `Z15` §3.2–3.5 (96-158), §3.7–3.8 (170-188); `Z01` §3.6 (272-290) | Нет живого checkout/webview/биллинга |
| 24 | Testing/CI/quality | Covered | Z14, Z01 | `Z14` §3.1–3.4 (40-138), §4 G-1–G-14 (172-255); `Z01` §3.4 (219-262) | Нет полного прогона suite/E2E/CI |
| 25 | Docs/DX | Covered | Z14, Z01 | `Z14` §3.6–3.7 (150-169), §4.1 (256-297); `Z01` §3.5 (263-271) | Нет проверки содержимого 2088 документов |

**Счёт (строки матрицы):** 25 тем. Covered — 21 полных, плюс 1 «Covered (тонко)» (тема 6, Client SDK) и 1 «Covered (фрагментировано)» (тема 8, Architecture/event model) — суммарно 23 Covered. Partially covered — 2 (темы 20 Performance и 22 Multiplatform). Not covered — 0.

Ключевой вывод: тезис Z01 о непокрытых темах 19–25 верен только для состояния на 10:42; итоговые Z11–Z15 закрывают 19–25, кроме performance и multiplatform, которые сами помечены partial.

## 4. Top-level area coverage

Глубина: **Substantive** — есть отдельный разбор механик/рисков; **Inventory-only** — описание на уровне абзаца-инвентаря; **Not covered** — только упоминание или отсутствие анализа.

| Область | Ветки | Глубина | Evidence anchor | Комментарий |
|---|---|---|---|---|
| `packages/desktop` | Z02 (+Z05,Z11,Z12) | Substantive | `Z02` целиком | 7 рекомендаций, unit-прогоны 76 тестов |
| `packages/web` | Z03 | Substantive | `Z03` §3.1–3.5 | 128 тестов запущено |
| `packages/server` | Z03 | Substantive | `Z03` §3.6–3.9 | HTTP/stdio/remote deploy |
| `packages/ui` | Z04 (+Z15,Z13) | Substantive | `Z04` целиком | 12 рекомендаций, token/a11y/i18n |
| `packages/services` | Z05 | Substantive | `Z05` §3–§4 | 10 рекомендаций, ownership map |
| `packages/rpc` | Z06 | Substantive | `Z06` §3.2 | 9 рекомендаций |
| `packages/shared` | Z06 (+Z09,Z11) | Substantive | `Z06` §3.3–3.4 | protocol/identity/platform |
| `packages/client` | Z06 | Substantive | `Z06` §3.5 | Тонко, но с gap-анализом |
| `packages/provider` | Z08 | Substantive | `Z08` §3.6 | 4 wire-формата, registry |
| `packages/provider-node` | — | **Not covered** | только зависимости: `Z05:56`, `Z14:51`, `Z01:180` | Нет собственного разбора |
| `packages/model-option-map` | — | **Not covered** | только `Z01:178`, `Z06:72` | Нет разбора модели опций/правил |
| `packages/zcode-server-cli` | Z13, Z03 | Substantive | `Z13` §3.8; `Z03` §3.6/§3.7 | Ingress/auth/static |
| `packages/web-share` | Z03, Z13 | Substantive (малый объём) | `Z13` §3.8; `Z03` §3.5 | Дрейф деплой-доков |
| `packages/share-ui` | Z13 | Inventory-only | `Z13` §3.8 | Тонкая обёртка, 0 тестов |
| `packages/zcode-cua` | Z13, Z01 | Substantive | `Z13` §3.8; `Z01:193` | Заглушка fail-closed |
| `packages/formal-proof` | Z13 | Inventory-only | `Z13` §3.8 | Dev-tool, 0 тестов |
| `packages/stream-animate` | Z13 | Inventory-only | `Z13` §3.8 | Dev-tool, 0 тестов |
| `packages/e2e-report` | Z13, Z02 | Inventory-only | `Z13` §3.8; `Z02` §3.9 | Test-tooling, 0 тестов |
| `packages/android` | Z13 | Substantive по коду, без сборки | `Z13` §2.2, §3.8 | Orphan, нет package.json/CI |
| `apps/zcode-cli` | Z07 (+Z08,Z09,Z10,Z11) | Substantive | `Z07` целиком | 10 рекомендаций |
| `apps/dev-docs` | Z14, Z13 | Substantive | `Z14` §3.6; `Z13` §2.2 | Тесты вне root unit |
| `scripts/` | Z01, Z13, Z14 | Substantive | `Z01` §3.1/§3.4; `Z13` §3.8; `Z14` §3.2 | 37 тестов, release/verify |
| `.github/` | Z01, Z02, Z14 | Substantive | `Z14` §3.3; `Z01:244-250` | Единственный ручной workflow |
| `.agents/` | Z01, Z09 | Substantive | `Z01` §3.7; `Z09` §3.4 | 32 skills |
| `.zcode/` | Z01, Z11 | Inventory-only | `Z01` §3.7; `Z11` §2 | Только `evaluation-cases.json`; нет `agents/` |
| `third-party/` | Z13, Z01 | Substantive (release-input) | `Z13` §3.8; `Z01:156` | 1219 packages, 19 reviewRequired |
| `patches/` | — | **Not covered** | только `Z01:157,523` | 8 патчей не разобраны |
| `config/` | — | **Not covered** | только `Z01:159` | `default.json` и builtin-provider не разобраны |
| `public/` | — | **Not covered** | только `Z01:158` | Лого/иконки |
| `docs/` | Z14, Z01 | Substantive | `Z14` §3.6; `Z01` §3.5 | Drift, отсутствие индекса |
| `specs/` (корень) | — | Inventory-only | `Z01:150`; `Z14:155` | Один файл; `docs/specs/` покрыт через Z07/Z09/Z10/Z14 |

**Области без содержательного покрытия:** `packages/model-option-map`, `packages/provider-node`, `patches/`, `config/`, `public/`.
**Inventory-only:** `packages/share-ui`, `packages/formal-proof`, `packages/stream-animate`, `packages/e2e-report`, `.zcode/`, корневой `specs/`.

## 5. Mandatory competitor coverage

| # | Продукт | Отчёт и раздел | Distinct sources | Механики/архитектура описаны | Пробел |
|---|---|---|---|---|---|
| 1 | OpenAI Codex CLI | C1 §3.1 (46-100); C4 §3.6 (173-219) | C1: 24 строки источников; C4: 5 cloud-строк | Да: sandbox/approval split, app-server, exec JSONL, hooks, subagents, skills, AGENTS.md, MCP | Внутренний loop не документирован (UNKNOWN) |
| 2 | Cline | C2 §3.1 (76-107) | 14+ | Да: hub-spoke, plan/act, checkpoints, MCP, subagents, browser, ACP | Нет runtime-проверки |
| 3 | Kilo Code | C2 §3.2 (108-141) | 18+ | Да: agents/modes, orchestrator, permissions, sandbox, indexing, condensing, Auto Model, cost | Цены cloud частично обрезаны |
| 4 | OpenCode | C1 §3.4 (187-232) | 19 | Да: server-first, OpenAPI, SSE, permissions, LSP, plugins, providers | Hook plugin API не раскрыт |
| 5 | Cursor | C3 §3.2 (97-133); C4 §3.6 | C3: 27 URL | Да: Run Modes, sandbox.json, plan mode, subagents, router, hooks | Внутренний loop/compaction закрыты |
| 6 | Continue | C2 §3.4 (166-191) | 13+ | Да: config/model roles, rules, context providers, modes, CLI | Продукт read-only; CI docs 404 |
| 7 | Aider | C1 §3.5 (233-274) | 19 | Да: PageRank repo map, edit formats, git auto-commit, architect/editor | Sandbox/permissions не документированы |
| 8 | Windsurf / Devin Desktop | C3 §3.3 (134-169) | 26 URL | Да: Cascade legacy, Devin Local, sandbox scopes, Adaptive/Fusion | Числовые квоты не раскрыты; rebrand |
| 9 | GitHub Copilot Workspace/Agent | C3 §3.4 (170-199); C4 §3.6 | C3: 22 URL (2 blocked); C4: 4 | Agent mode/cloud — да; Workspace — **нет** | Docs Copilot Workspace 404; механики Workspace не описаны |
| 10 | JetBrains AI | C3 §3.5 (200-229) | 23 URL | Да: AI Assistant, Junie, Air, ACP, plan mode | Sandbox/compaction Junie не документированы |
| 11 | Roo Code | C2 §3.3 (142-165) | 12+ | Да: modes, boomerang, checkpoints, condensing, indexing, worktrees | Архив с 2026-05-15 |
| 12 | Amp | C2 §3.6 (214-241); C4 §3.6 | C2: 16+; C4: 9 | Да: threads, Dial, subagents, plugins, orbs, MCP-in-skills | Telemetry-страница 404 |
| 13 | Goose | C2 §3.5 (192-213) | 14+ | Да: extensions/MCP, recipes, permissions, subagents, headless | — |
| 14 | Zed AI | C3 §3.6 (230-259) | 21 URL | Да: Agent, External Agents/ACP, edit prediction, tool permissions | Нет eval harness; SSO/SCIM не выпущены |
| 15 | Devin | C4 §3.2 (57-86) | 27 | Да: VM/snapshot, session states, API, Outposts, Fusion, ACU, computer use | Архитектурные внутренности закрыты |

Примечание к колонке «Distinct sources»: для C1, C3, C4 числа получены подсчётом строк в §8 (`rg '^\| C1-'` и аналоги); для C2 — взяты из self-reported таблицы C2 §2.2, независимо не пересчитывались.

**Счёт:** 15/15 продуктов присутствуют; 14 — с описанием механик; 1 (GitHub Copilot Workspace) — частично, только Agent-половина.

**Дубли между C-отчётами:** Codex (C1 + C4), Copilot (C3 + C4), Cursor (C3 + C4), Amp (C2 + C4), Windsurf/Devin (C3 + C4/Desk). Синтез должен выбрать канонический источник на продукт и сверить числа.

**Дубли с evidence-корпусом:** G1 покрывает Codex/Copilot/Cursor/Windsurf, G2 — Cline/Roo/Kilo/Continue, G3 — OpenCode/Aider/Amp/Goose, G4 — Zed/JetBrains/Devin. Это вторая версия тех же 15 продуктов; partial-файлы её не цитируют (кроме Z11 → part-d). Риск расхождения чисел и рекомендаций.

## 6. Mission-constraint compliance

| Проверка | Доказательство | Вердикт |
|---|---|---|
| Добавлены только файлы `docs/research/` | `git status --short` → `?? docs/research/`; на момент начала аудита 28 untracked-файлов, все под `docs/research/`; вне каталога — 0 (после аудита 29: добавлен этот файл) | PASS |
| Нет production-диффов | `git diff --stat` пуст; `git diff --cached --stat` пуст; `git diff --numstat` и `--cached --numstat` пусты | PASS |
| Нет коммитов после `d10f0b69` | `git log -1` = `d10f0b69`; `git log --all --since='2026-11-11 00:00'` пуст | PASS |
| Нет переключения ветки | `git branch --show-current` = `dev`; 16 из 19 partial фиксируют `dev` явно; C1/C3/C4 git-preflight не приводят (V-08); reflog последних 12 записей — только commit/reset, checkout отсутствует | PASS по состоянию; история reflog не полная |
| Нет деструктивных git-операций | 10 stash-записей, новейшая 2026-11-07 (до миссии); reflog показывает `reset` 2026-11-10, до начала исследования; новых stash/reset/clean нет | PASS по состоянию; отдельные команды не логируются |
| Записан только свой файл | 19/19 partial содержат явное подтверждение; 16 фиксируют `?? docs/research/` до/после, у C1/C3/C4 — только декларация без снимка | PASS по декларациям; независимо не проверялось |

**Оговорки:**
- `node scripts/check-workspace-freshness.mjs` (Z01 §1.2, `scripts/check-workspace-freshness.mjs:35-37`) выполняет `git fetch origin --prune`. Это обновляет remote-tracking refs, но не worktree и не коммиты. Формально это запись в `.git`, а не деструктивная операция.
- `git submodule update --init --recursive apps/zcode-cli` в Z01 — no-op (`.gitmodules` отсутствует), exit 0.
- Точечные тесты (Z02 76, Z03 128, Z07 357, Z08 12 наборов, Z04 Playwright-пробы, Z14 `vitest list`/`node --test`, Z15 dev-docs) могли создать кэши, но tracked-файлы не изменились.
- C1, C3 и C4 не приводят git-preflight (V-08). Глобальное состояние git чистое, поэтому ограничения соблюдены, но доказательство для этих трёх филиалов опирается на итоговый снимок, а не на их собственные записи.

**Итоговый вердикт по ограничениям: PASS с тремя evidence-оговорками (fetch/prune; неполнота reflog; отсутствие git-preflight у C1/C3/C4).**

## 7. Final-report material readiness

| Требуемый материал | Статус | Кто поставляет | Комментарий |
|---|---|---|---|
| (a) ZCode file:line evidence к каждой рекомендации | Available | Z01–Z15 §6 | 154 рекомендации; у каждой есть `ZCode evidence`/`Доказательство` с path:line. Форматы различаются, но evidence присутствует |
| (b) Competitor URL+date к каждой рекомендации | Partially available | C2 (inline URL+date), C3 (ID → §8), C4 (ID → §8), C1 (только product-level) | C1 §6 не содержит ни URL, ни ID; трассировка вручную по §8 |
| (c) Quick wins | Partially available | Z01–Z15 §6 (поля `Сложность`/`Complexity` + `Priority`) | Явной секции «quick wins» нет; выводится: 38 чистых `S`; всего 59 полей сложности с `S`-префиксом (включая `S/M`, `S–M`, `S (A) / L (B)`); 23 рекомендации P0 |
| (d) Strategic bets | Partially available | Z01–Z15 §6 (`Сложность: L`/`M`) | Явной секции нет; выводится: 12 L-префиксов (включая варианты `L (A) / S (B)`) |
| (e) Strengths | Available | все 19 partial §5 | Содержательные differentiators с evidence |
| (f) Anti-patterns | Available | C1 §6.7; C2 §6.2 (A1–A16); C3 §6 (блоки «что не копировать» в R1–R15); C4 §6.2 | ZCode-сторона — через §4 gaps, отдельной антипаттерн-секции нет |
| (g) Open questions | Available | все 19 partial §7 | Плюс Q-1…Q-4 в Z01 §7 |
| (h) Failed checks | Available | Z01 §3.4/§7; Z02 §2.1; Z03 §8.6; Z04 §8.4; Z07 §8.2; Z08 §8.2; Z09 §8.1; Z10 §8; Z11 Not-checked; Z12 §8; Z13 §8.3; Z14 §8.3; Z15 §8.7 | Собраны распределённо; synthesis должен свести в один список |
| (i) Appendix источников/файлов | Available | все 19 partial §8 | 117 строк C1, 170 URL-строк C2, 189 строк C3, 125 строк C4; Z-части — path:line таблицы |

**Вердикт по готовности материала: partial.** Все категории имеют хотя бы частичный материал, но synthesis обязан: (1) исправить устаревшую карту Z01; (2) свести quick wins/strategic bets из полей сложности и приоритета; (3) добавить C1 source-ID/URL к рекомендациям; (4) выбрать канонический корпус между C1–C4 и evidence-директорией; (5) собрать единый not-checked список.

## 8. Duplicate and overlapping recommendations

| Группа | Рекомендации | Что дублируется | Действие synthesis |
|---|---|---|---|
| G1. CI/quality gates | Z01 R-3; Z02 R5; Z14 R-1; Z14 R-5 | Внешний checks-job и typecheck в CI | Одна рекомендация «CI-гейт» с подпунктами lint/typecheck/unit |
| G2. Format/arch/Node pins | Z01 R-1, R-2, R-4; Z14 R-3, R-4, R-8 | fmt, full architecture-check, Node pin | Разделить на 3 независимых пункта, не смешивать |
| G3. Test collection/E2E | Z01 R-5, R-9; Z04 R-06; Z14 R-2, R-10; Z02 R7 | `.tsx`, scripts/test, CLI, битые include, E2E backlog | Один пакет «сбор тестов», E2E-долг — отдельно |
| G4. Docs/spec drift | Z01 R-7, R-8; Z03 R-07; Z09 R-03, R-05; Z13 R-7; Z14 R-6, R-9; Z15 R1 | Docs↔код, навигация, CONTEXT, dev-docs | Две подгруппы: docs-индекс/дрейф и продуктовые противоречия |
| G5. Release metadata | Z01 R-6; Z14 R-7 | lockfile, версия, changelog | Один пункт «единый источник версии/lock» |
| G6. Sandbox/workspace boundary | Z08 R-02, R-03; Z12 R-1, R-2 | Sandbox no-op и открытая граница workspace | Два пункта: enforcement sandbox и политика workspace |
| G7. Permission semantics | Z07 R1, R5; Z12 R5, R7 | `permissionTimeoutMs`, YOLO/`disallowedTools` | Один пункт «жёсткие запреты и таймаут» |
| G8. Web/Electron trust boundary | Z02 R1, R4; Z03 R-02, R-04; Z12 R1, R10 | CSP, navigation guard, Origin allowlist, lite-token | Один security-пакет по ingress/renderer |
| G9. MCP/plugin/skill trust & supply chain | Z09 R-01, R-02, R-16; Z12 R-4, R-9; Z15 R3, R4 | Project MCP trust, plugin hooks, install/source validation | Один пункт «supply chain и trust gate» |
| G10. Cost & quota | Z07 R3; Z08 R-06; Z11 R6; Z15 R2 | cost accounting, budgets, quota UI | Разделить: runtime cost-учёт и UI-обзор плана |
| G11. Session state/leaks/resume | Z05 CR-1, CR-2, CR-3, CR-5, CR-6; Z02 R3; Z11 R5; Z07 R9 | owner/lease, teardown, streamBatches, resume | Один lifecycle-пакет с подпунктами; не смешивать с host crash |
| G12. Dead contracts/legacy | Z05 CR-7; Z07 R6; Z09 R-14; Z01 R-9 | Неиспользуемые API/конфиги | Один пункт «удалить или реализовать» |
| G13. Protocol robustness/compat | Z06 R1, R3, R7; Z05 CR-4; Z10 R11; Z08 R-07; Z07 R10 | frame limits, malformed policy, compat matrix, retry thresholds | Два пункта: RPC-граница и матрица совместимости/retry |
| G14. Telemetry privacy/ops | Z11 R1–R5; Z15 R5; Z12 (secrets in logs) | consent/opt-out, PII в логах, объём логов | Один privacy-пакет + отдельный ops-пункт объёма |
| G15. Worktree isolation | Z10 R3; Z13 R2 | Буквальный дубль: `isolation: "worktree"` | Одна рекомендация, владелец — Z10/Z13 совместно |
| G16. CUA/product truth | Z01 R-10; Z13 §3.8 (факт) | Статус заглушки CUA | Один пункт «не обещать CUA в UI/доках» |
| G17. Marketplace trust | Z15 R3, R4; Z09 R-16; Z12 R-4 | Trust-сигналы, install validation, source validation | Слить в G9, оставив UI-часть в Z15 |

**Также требует сведения:** competitor-дубли Codex/Copilot/Cursor/Amp/Windsurf между C1–C4 и evidence-корпусом (см. §5).

## 9. Explicit uncovered areas

### 9.1. Темы

- **Тема 20 (performance)** — Partially covered: нет large-repo/throughput/latency-бюджетов, soak и профилирования; Z11 сам ставит `partial`.
- **Тема 22 (multiplatform)** — Partially covered: нет Windows/Linux runtime, сборок, подписи; Android — orphan без CI.

### 9.2. Пакеты/каталоги без содержательного разбора

- `packages/model-option-map` — только строка инвентаря и зависимость `shared`.
- `packages/provider-node` — только списки зависимостей.
- `patches/` — 8 патчей не разобраны.
- `config/` — `default.json` и builtin-provider JSON не разобраны.
- `public/` — лого/иконки, только инвентарь.

### 9.3. Inventory-only (абзац, без архитектурного разбора)

- `packages/share-ui`, `packages/formal-proof`, `packages/stream-animate`, `packages/e2e-report`.
- `.zcode/` — только `evaluation-cases.json`; отсутствие `.zcode/agents/` зафиксировано, но профили не проверялись.
- Корневой `specs/` — один файл, без анализа.

### 9.4. Competitor gaps

- GitHub Copilot Workspace: docs 404, механики Workspace не описаны (Agent-половина покрыта).
- C1: нет per-recommendation source-ID/URL.
- Windsurf/Devin: числовые квоты не раскрыты; rebrand повышает риск смешения legacy Cascade и Devin Local.

### 9.5. Типы доказательств, которых нет

- Нет ни одного полного прогона `pnpm typecheck`, `pnpm lint`, `pnpm test`, desktop E2E, реального CI.
- Нет живых provider-вызовов, relay, marketplace, checkout, Windows/Linux-сборок.
- Нет воспроизведения конкурирующих продуктов; всё competitor-знание — из документации.
- Нет независимой проверки, что каждый partial писал только свой файл (только декларации и итоговое состояние git).

## 10. Readiness verdict

**Вердикт: partial (не blocked).**

Обоснование:
1. Все 25 тем имеют материал: 21 Covered полностью, 2 Covered с оговоркой (темы 6 и 8), 2 Partially covered, 0 Not covered.
2. Все 19 partial структурно полны: 8 разделов, coverage-status, write-confirmation.
3. Ограничения миссии соблюдены по состоянию git: только `docs/research/`, нулевые production-диффы, HEAD `d10f0b69`, ветка `dev`, без новых stash/reset.
4. Final report можно собрать, но synthesis обязан закрыть пять разрывов: устаревшая карта Z01 (V-01/V-02), дубль evidence-корпуса (V-07), отсутствие per-rec source-ID в C1 (V-06), отсутствие явных quick wins/strategic bets, непокрытые `model-option-map`/`provider-node`/`patches`/`config`/`public`.

Условия перехода в **ready**:
- Пересчитать карту покрытия по фактическим 19 partial, а не по раннему снимку Z01.
- Свести C1–C4 и evidence-директорию к одному каноническому источнику на продукт.
- Добавить к C1-рекомендациям ID источников из §8.
- Сформировать quick wins (S/P0) и strategic bets (L/M) из существующих полей.
- Явно пометить performance и multiplatform как partial в итоговом отчёте, а не как полное покрытие.

**Подтверждение записи:** записан только этот файл — `<repo-root>/docs/research/partials/2026-11-11-verification-coverage-compliance.md`. Продуктовый код, конфиги, lockfile и другие partial-файлы не изменялись; коммиты не создавались.
