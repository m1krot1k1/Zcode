# Z01 — Инвентаризация репозитория, mission preflight, governance и карта покрытия

> Research-only артефакт. Продуктовый код, конфиги, зависимости и lockfile не изменялись.
> Дата исследования: 2026-11-11. Ветка `dev`, HEAD `d10f0b69f98677091e0428a92839e4a1e01e04ca`.
> Единственная запись этого филиала — данный файл.

## 1. Scope and method

### 1.1. Загруженный skill и границы

- Skill `research` загружен по точному имени через `Skill`. Применена его дисциплина: primary sources (код, конфиги, git), разделение FACT / INFERENCE / UNKNOWN, фиксация недоступного.
- Роль: researcher, read-only, кроме одного partial-файла. `pnpm typecheck`, полный unit-набор, E2E и тяжёлые сборки не запускались.
- Запускались только точечные read-only команды: `git status/branch/log/rev-parse/ls-files`, `find`, `rg`, `nl -ba`, `sed -n`, `wc`, `node -e` (чтение JSON), `node --version`, `node scripts/check-workspace-freshness.mjs`, `node scripts/architecture/architecture-check.mjs check`, `node scripts/check-doc-links.mjs`, `npx oxlint`, `npx oxfmt --check`, `git submodule update --init --recursive apps/zcode-cli`, `git submodule status`.

### 1.2. Mission preflight (обязательный первый шаг)

**Команда 1 — базовое состояние git (Observed).**

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

**Команда 2 — freshness (Observed, exit code 0).**

```text
$ node scripts/check-workspace-freshness.mjs
[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）
EXIT_CODE=0
```

Скрипт выполняет `git fetch origin --prune` (scripts/check-workspace-freshness.mjs:35-37), затем проверяет отставание от upstream и от `origin/main` (:49-57).

**Команда 3 — версия Node (Observed).**

```text
$ node --version
v26.9.0
```

**Факт (expected vs actual):**

| Источник | Значение | Файл:строка |
| --- | --- | --- |
| Ожидаемый Node | `24.14.0` | `mise.toml:2` (`node = "24.14.0"`) |
| Ожидаемый pnpm | `10.33.2` | `mise.toml:3`; `package.json:137` (`packageManager`) |
| Дублирующий пин Node | `24.14.0` | `apps/zcode-cli/.node-version:1` |
| Пин только по major | `24` | `.nvmrc:1` |
| Минимум в engines | `>=24.0.0` | `package.json:134-136` |
| **Фактический Node среды** | **`v26.9.0`** | `node --version` |

**Расхождение:** среда исследования работает на Node 26.9.0 при пине 24.14.0. Это не дефект продукта, но `ci:assert-node` это расхождение не ловит (см. §4, G-1). Формально `engines` (`>=24.0.0`) и `.nvmrc` (`24`) допускают 26.9.0, а точное сравнение с `mise.toml` выполняется только на входе macOS-release-скриптов (`scripts/release-macos-local/main.mjs:43`, `scripts/release-macos-preview.mjs:314`).

**Побочный факт preflight:** `git submodule update --init --recursive apps/zcode-cli` завершился с `EXIT_CODE=0`, хотя сабмодуля нет: `git ls-files -s | awk '$1=="160000"'` пуст, `.gitmodules` отсутствует, `git submodule status` — пустой вывод. То есть вызов в `scripts/bootstrap.mjs:220` — no-op, а не реальная инициализация.

### 1.3. Как собирались данные инвентаризации

- Обход дерева: `ls -la`, `find . -maxdepth 2 -not -path '*/node_modules*' -not -path './.git*'`.
- Манифесты: чтение каждого `packages/*/package.json`, `apps/*/package.json`, `apps/zcode-cli/packages/*/package.json`, `apps/zcode-cli/tools/*/package.json` через `node -e "require(...)"`.
- Подсчёты тестов: `git ls-files` (только tracked-файлы), чтобы не считать `node_modules`/`dist`.
- CodeIndex использован только для проверки доступности индекса; все load-bearing факты подтверждены чтением файлов и командами. `CodeIndex status`: `state: ready`, `partial: false`, generation `1454`, 10007 файлов, 26791 чанк, 278154 символа, 377669 рёбер.

## 2. Coverage table

Шкала статуса: **полный** — область покрыта и перепроверена источником; **частичный** — покрыта выборочно по явно названным пунктам; **вне охвата** — в конверте Z01 не запрашивалась; **пробел** — запрашивалась, но не проверена.

| # | Область (пункт конверта Z01) | Статус | Основные источники |
| --- | --- | --- | --- |
| 2.1 | Preflight: freshness, Node vs mise | полный | §1.2; `mise.toml:2-3`, `package.json:134-137`, `.nvmrc:1`, `apps/zcode-cli/.node-version:1` |
| 2.2 | Верхний уровень репозитория, роли каталогов | полный | `ls -la`, `find -maxdepth 2`, §3.1 |
| 2.3 | Корневые конфиги: `package.json`, `pnpm-workspace.yaml`, `mise.toml`, tsconfig/lint/fmt/test | полный | `package.json`, `pnpm-workspace.yaml:1-7`, `tsconfig.base.json`, `.oxlintrc.json:1-40`, `.oxfmtrc.json:1-32`, `vitest.config.ts:1-148` |
| 2.4 | `turbo.json`/`nx.json` | полный (turbo найден только внутри CLI) | `apps/zcode-cli/turbo.json`; в корне отсутствуют |
| 2.5 | `.github/workflows/*` | полный | `.github/workflows/cross-platform-preview-release.yml:1-209` |
| 2.6 | `scripts/*` и подоболочки | полный (инвентарь) / частичный (семантика каждого скрипта) | `ls -1 scripts`, `scripts/test` (37 файлов), `scripts/architecture` (13), `scripts/release-macos-local` (11), `scripts/zcode-distribution` (3) |
| 2.7 | `docs/` дерево | полный (объём/структура) / частичный (содержание 2088 md) | §3.5 |
| 2.8 | `CONTEXT.md`, `DESIGN.md`, `AGENTS.md`, `README*`, `specs/` | полный | `AGENTS.md:1-86`, `DESIGN.md:1-660`, `CONTEXT.md:1-120`, `README.md:1-35`, `README.en.md:1-35`, `specs/zcode-unified-distribution.md` |
| 2.9 | Инвентарь всех пакетов и приложений (имя, путь, скрипты, тесты) | полный | §3.2, §3.3 |
| 2.10 | Тесты и quality gates | полный (структура) / неполный (исполнение) | §3.4, §4 |
| 2.11 | Release/changelog/versioning | полный | §3.6 |
| 2.12 | Профили агентов и skills | полный | §3.7 |
| 2.13 | Git-история по подсистемам | полный (агрегаты за 300 коммитов) | §3.8 |
| 2.14 | Карта покрытия Z01–Z16 | полный с ограничением (Z11–Z16 не существуют) | §2.1 |
| 2.15 | Governance/DX пробелы | полный (evidence-based перечень) | §4 |

### 2.1. Карта исследовательских филиалов (master coverage map)

**Наблюдение (FACT):** в состоянии рантайма существуют конверты только Z01–Z10. Поиск по всем `metadata.json` сессий агентов дал уникальный набор `Branch ID: Z01 … Z10`; ни одного `Z11`–`Z16` не найдено (`grep -rIoh --include="metadata.json" -E "Branch ID: Z[0-9]+"` → только Z01..Z10). Конверт Z01 требует карту до Z16, поэтому Z11–Z16 помечены как **не назначенные**, а не как «покрытые».

| Филиал | Явно назначенная область (цитата конверта) |
| --- | --- |
| Z01 | `repository inventory, mission preflight, governance and coverage map` |
| Z02 | `packages/desktop and desktop platform` (main/preload/renderer/host, IPC, updates/packaging, cross-platform, E2E) |
| Z03 | `packages/web and packages/server` (клиент, сервер, auth, remote semantics, security, ops) |
| Z04 | `packages/ui and the design system` (компоненты, hooks, Zustand, layout, theming/i18n, perf, a11y) |
| Z05 | `packages/services, business services, session lifecycle, state ownership` |
| Z06 | `packages/rpc, packages/shared, packages/client` |
| Z07 | `apps/zcode-cli runtime and agent loop` |
| Z08 | `tools, execution environment, providers, models` |
| Z09 | `context, memory, rules, skills, plugins, MCP` |
| Z10 | `subagents, orchestration, protocols/interoperability` |
| Z11–Z16 | **не существуют в рантайме; область не назначена** |

### 2.2. Соответствие верхнеуровневых областей филиалам

Метод: проверка, назван ли путь/термин в тексте конверта филиала (`node -e` по `prompt` из `metadata.json`). «Тематически» = термин есть, путь не назван.

| Область | Филиал | Статус соответствия |
| --- | --- | --- |
| `packages/desktop` | Z02 | путь назван |
| `packages/web`, `packages/server` | Z03 | пути названы |
| `packages/ui` | Z04 | путь назван |
| `packages/services` | Z05 | путь назван |
| `packages/rpc`, `packages/shared`, `packages/client` | Z06 | пути названы |
| `apps/zcode-cli` | Z07 (+ Z08 tools/providers) | путь назван |
| `packages/provider`, `packages/provider-node`, `packages/model-option-map` | Z08 | только тематически («Providers/models», п.6) — путь не назван |
| `packages/zcode-server-cli` | — | **не назван ни в одном Z02–Z10** |
| `packages/web-share`, `packages/share-ui` | — | **не назван ни в одном Z02–Z10** |
| `packages/zcode-cua` | — | **не назван ни в одном Z02–Z10** |
| `packages/formal-proof` | — | **не назван ни в одном Z02–Z10** |
| `packages/stream-animate` | — | **не назван ни в одном Z02–Z10** |
| `packages/e2e-report` | — | **не назван ни в одном Z02–Z10** |
| `packages/android` | — | **не назван ни в одном Z02–Z10** |
| `apps/dev-docs` | — | **не назван ни в одном Z02–Z10** |
| `scripts/` | — | **не назван как владелец области** (упоминаются только `mise`, `pnpm`) |
| `.github/`, `.agents/`, `.zcode/` | — | **не назван ни в одном Z02–Z10** |
| `third-party/`, `patches/`, `config/`, `public/` | — | **не назван ни в одном Z02–Z10** |

### 2.3. Сквозные темы миссии без назначенного филиала

Оркестраторский prompt миссии перечисляет 25 крупных областей; в конвертах Z02–Z10 не встречаются как термины: `telemetry`/телеметрия, `monetization`/тарифы, `onboarding`, `evals`, `IDE integration`, `docs/DX`, `release/packaging` (кроме п.6 Z02), `CI/quality gates` (кроме упоминаний в Z02/Z03). Соответственно **не покрыты отдельным филиалом**: телеметрия/observability (п.19), evals/метрики качества (п.19), производительность как отдельная тема (п.20 — присутствует фрагментарно в Z02/Z04), надёжность как отдельная тема (п.21 — фрагментарно в Z05/Z07), мультиплатформенность (п.22 — фрагментарно в Z02/Z03), монетизация/onboarding (п.23), тестирование/CI/качество (п.24 — только инвентарь Z01 + E2E в Z02), документация/DX (п.25).

**INFERENCE:** эти темы остаются непокрытыми, если Z11–Z16 не будут созданы. Это не доказательство, что соответствующие исследования не велись внутри Z02–Z10, — это факт отсутствия назначенной области.

## 3. Capability inventory

### 3.1. Верхний уровень репозитория

`ls -la` (Observed). Каталоги и их роль:

| Путь | Роль | Доказательство |
| --- | --- | --- |
| `packages/` | 19 подкаталогов, 18 с `package.json` | §3.2 |
| `apps/` | `dev-docs` (Vite/React карта способностей) и `zcode-cli` (вложенный pnpm-workspace) | `pnpm-workspace.yaml:1-7` |
| `docs/` | 2486 файлов, 2088 tracked `.md`, 67 MB | `find docs -type f \| wc -l`, `git ls-files 'docs/*.md' \| wc -l`, `du -sh docs` |
| `scripts/` | 110 записей верхнего уровня: 101 файл + 10 подкаталогов (`test`, `architecture`, `release-macos-local`, `release-it`, `zcode-distribution`, `lib`, `dev`, `license-texts`, `affected-unit-tests`, `native-search-tools-windows`) | `ls -1 scripts \| wc -l`; `find scripts -maxdepth 1 -type f \| wc -l`; `find scripts -maxdepth 1 -type d -not -path scripts` |
| `specs/` | единственный файл `zcode-unified-distribution.md` | `find specs -maxdepth 3` |
| `.agents/skills/` | 32 каталога skills | §3.7 |
| `.github/workflows/` | один workflow | §3.4 |
| `.husky/` | `commit-msg`, `pre-push`, `_/` (без `pre-commit`) | `ls .husky` |
| `.zcode/` | только `evaluation-cases.json`; `.zcode/agents/` отсутствует | `find .zcode -type f` |
| `.cursor/hooks/state/` | `continual-learning.json` | `find .cursor -type f` |
| `third-party/` | лицензионные материалы + снапшоты upstream | `third-party/SPEC.md:1-25` |
| `patches/` | 8 patch-файлов для pnpm `patchedDependencies` | `ls -1 patches`; `package.json:139-149` |
| `public/` | лого/иконки | `find public -maxdepth 2` |
| `config/` | `default.json`, `provider/zcode-builtin*.json` | `config/README.md:1-25` |
| `.plan/` | локальные plan-файлы; **gitignored** | `.gitignore:81`; `git check-ignore -v .plan` |
| `.worktrees/` | 3 локальных worktree подагентов; gitignored | `.gitignore:45` |
| `.cache/`, `.pnpm-store/`, `.zcode-runtime/` | локальные кэши; gitignored | `.gitignore:33,37,80` |
| `node_modules/` | установленные зависимости | `ls -la` |

Корневые документы: `AGENTS.md` (86 строк, 7 разделов), `CONTEXT.md` (доменный словарь Plugin Store), `DESIGN.md` (660 строк, 24 раздела), `README.md`/`README.en.md`, `UI_PLUGIN.md`/`UI_PLUGIN.en.md` (48-58 KB), `NOTICE.md`, `THIRD-PARTY-NOTICES.md` (2.0 MB), `LICENSE` (Apache-2.0), `dependency-graph.mmd`, `architecture-policy.yaml` (1106 строк).

### 3.2. Инвентарь `packages/*`

Имя, версия, приватность и скрипты получены из каждого `package.json` (`node -e`). Число тестов — `git ls-files`-подсчёт по каталогу, без `node_modules`.

| Путь | Имя | Версия | Приватный | Скрипты | Тесты | LOC `src` |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/android` | — | — | — | **`package.json` отсутствует**; Gradle-проект (`build.gradle.kts`, `gradlew`, `gradle/libs.versions.toml`) | 0 | 0 |
| `packages/client` | `@zcode/client` | — | да | `lint`, `lint:fix` | 7 | 1993 |
| `packages/desktop` | `@zcode/desktop` | — | да | 34 скрипта: `dev`, `build`, `prepare:*` (9), `test:e2e`, `test:e2e:all:coverage`, `test:e2e:serial`, `test:e2e:windows:sharded`, `e2e:*`, `bundle`, `audit:bundle-size`, `typecheck:e2e`, `lint` | 372 unit + 575 E2E | 81948 |
| `packages/e2e-report` | `@zcode/e2e-report` | — | да | `build`, `build:node`, `build:viewer`, `dev`, `lint`, `lint:fix`, `preview`, `typecheck` | 0 | 1724 |
| `packages/formal-proof` | `@zcode/formal-proof` | — | да | `dev`, `build`, `preview`, `typecheck`, `lint` | 0 | 2400 |
| `packages/model-option-map` | `@zcode/model-option-map` | — | да | `build`, `typecheck`, `test`, `lint` | 2 | 867 |
| `packages/provider` | `@zcode/provider` | — | да | `build`, `typecheck`, `test`, `lint` | 23 | 5107 |
| `packages/provider-node` | `@zcode/provider-node` | — | да | `build`, `typecheck`, `test`, `lint` | 27 | 1931 |
| `packages/rpc` | `@zcode/rpc` | **1.0.0** | **нет** (публикуемый) | `test`, `build`, `demo:basic`, `demo:proxy`, `demo:messageport`, `demo:remote`, `lint`, `lint:fix` | 8 | 3300 |
| `packages/server` | `@zcode/server` | — | да | `dev`, `build`, `build:remote`, `lint`, `lint:fix` | 29 | 12037 |
| `packages/services` | `@zcode/services` | — | да | **только `lint`, `lint:fix`** (тестового скрипта нет) | 324 | 138122 |
| `packages/share-ui` | `@zcode/share-ui` | — | да | `lint`, `lint:fix` | 0 | 7 |
| `packages/shared` | `@zcode/shared` | — | да | `lint`, `lint:fix` | 159 | 55750 |
| `packages/stream-animate` | `@zcode/stream-animate` | — | да | `dev`, `build`, `preview`, `run:sample`, `typecheck`, `lint`, `lint:fix` | 0 | 2368 |
| `packages/ui` | `@zcode/ui` | — | да | **только `lint`, `lint:fix`** | 1102 | 429050 |
| `packages/web` | `@zcode/web` | — | да | `dev`, `build`, `lint`, `lint:fix` | 37 | 8517 |
| `packages/web-share` | `@zcode/web-share` | — | да | `dev`, `build`, `lint` | 0 | 186 |
| `packages/zcode-cua` | `@zcode/zcode-cua` | **0.6.5** | да | `build` | 1 | 0 (только конфиг) |
| `packages/zcode-server-cli` | `@zcode/server-cli` | — | да | `build`, `stage`, `stage:remote-assets`, `spike:proxy-stdio-docker`, `test`, `lint` | 32 | 6990 |

Отдельно: `packages/zcode-cua/package.json` содержит описание «API-compatible placeholder package for Computer Use. This build ships without Computer Use: every runtime surface reports unavailable and fails closed» — то есть CUA в этой сборке — заглушка, не рабочая возможность.

Зависимости внутри workspace (из `dependencies`/`devDependencies`/`peerDependencies`):

- `@zcode/ui` → `provider`, `rpc`, `services`, `shared`.
- `@zcode/services` → `provider`, `provider-node`, `rpc`, `shared`, `zcode-cua`.
- `@zcode/desktop` → `client`, `e2e-report`, `provider`, `provider-node`, `rpc`, `server`, `services`, `shared`, `ui`, `zcode-cua`.
- `@zcode/server` → `client`, `rpc`, `services`, `shared`.
- `@zcode/web` → `client`, `shared`, `ui`; `@zcode/web-share` → `share-ui`, `shared`.
- `@zcode/client` → `rpc`, `services`, `shared`; `@zcode/shared` → `model-option-map`.

### 3.3. Приложения

| Путь | Имя | Версия | Скрипты | Тесты |
| --- | --- | --- | --- | --- |
| `apps/dev-docs` | `@zcode/dev-docs` | — | `dev`, `build`, `preview`, `lint`, `lint:fix`, `test` | 4 (`apps/dev-docs/test/capabilityMap*.test.ts`, `featureBoundaryGraph.test.ts`) |
| `apps/zcode-cli` | `zcode-cli` | **0.17.0** | 24 скрипта: `build`, `build:sea`, `check`, `clean`, `cli:build`, `cli:dev`, `cli:upload-sea`, `coverage`, `dev`, `format`, `format:check`, `lint`, `lint:count`, `lint:fix`, `prompt-trajectory:*` (3), `registry:check`, `registry:generate`, `release`, `release:dry`, `sea`, `pretest`, `test`, `test:e2e:memory`, `test:browser-headless`, `test:browser-headless:linux`, `typecheck` | 909 |

`apps/zcode-cli` — самостоятельный вложенный pnpm-workspace (`apps/zcode-cli/pnpm-workspace.yaml`: `packages/*`, `tools/*`; свой `turbo.json`; свой `pnpm-lock.yaml` на 6722 строки). Состав:

- 30 пакетов с `package.json`: `adapters` (164 теста), `android-emulator-plugin` (1), `bootstrap` (237), `browser-use-plugin` (3), `cli` (28), `contracts` (44), `core` (306), `debug` (4), `documents-plugin` (0), `dynamic-workflow` (38), `dynamic-workflow-runtime` (16), `i18n` (1), `image-search-plugin` (0), `ios-simulator-plugin` (1), `node-repl-host` (6), `office-runtime` (13), `pdf-plugin` (0), `plugin-creator-plugin` (0), `presentations-plugin` (0), `restore-legacy-sessions-plugin` (0), `shared-types` (0), `skill-creator-plugin` (0), `spreadsheets-plugin` (0), `superpowers-plugin` (0), `swift-bridge` (0), `telemetry` (9), `tui` (29), `visualize-plugin` (0), `zcode-cua-plugin` (0), `zcode-guide-plugin` (0).
- `apps/zcode-cli/packages/bundled-skills` — **без `package.json`**: 23 SKILL.md + 7 rules (`00-evidence.mdc` … `06-progress.mdc`).
- `apps/zcode-cli/tools/`: `prompt-trajectory`, `typescript` (2 пакета).
- Объём: 5345 tracked файлов; 349382 строки `packages/*/src`; 428591 строка тестов.
- 15 из 30 пакетов — `*-plugin` (встроенные плагины: documents, pdf, presentations, spreadsheets, browser-use, image-search, office, visualize, android/ios эмуляторы, superpowers, zcode-cua, zcode-guide, plugin-creator, skill-creator, restore-legacy-sessions).

### 3.4. Тесты и quality gates (структура, не исполнение)

Подсчёт по tracked-файлам (Observed):

| Метрика | Значение | Команда |
| --- | --- | --- |
| Unit/integration тесты вне desktop E2E | **3131** | `git ls-files '*.test.ts' '*.test.tsx' '*.test.mjs' \| grep -v '^packages/desktop/test/e2e/' \| wc -l` |
| Desktop E2E (`WDIO`) | **575** | `git ls-files 'packages/desktop/test/e2e/*.test.ts' \| wc -l` |
| `node --test` скриптовые тесты | **42** | `git ls-files 'scripts/test/*.test.mjs' 'scripts/*.test.mjs' \| wc -l` |
| CLI-тесты | **909** | `git ls-files 'apps/zcode-cli/**/*.test.ts' \| wc -l` |
| Tracked `.ts`/`.tsx` | **9420** | `git ls-files '*.ts' '*.tsx' \| wc -l` |
| Всего tracked | **18816** | `git ls-files \| wc -l` |
| E2E-каталоги desktop | 16 подкаталогов (`bots`, `browser-permission`, `conversation-session`, `git`, `fixtures`, `helpers`, `manual-review`, `infrastructure`, …) | `ls -1d packages/desktop/test/e2e/*/` |

Раннеры и конфигурации:

- Корневой `vitest.config.ts` (148 строк) с двумя projects: `unit` (threads, `maxWorkers: 4`) и `fork-isolated` (последовательно, 22 файла в списке `forkIsolatedTests`), плюс отдельный `packages/zcode-cua/vitest.config.ts`. Include: `packages/*/test/**/*.test.ts`, `packages/*/src/**/contract.test.ts`, gen-ui paths, два несуществующих файла (см. §4, G-6). Coverage: `provider: "v8"`, `include: ["packages/*/src/**/*.ts"]`, **без thresholds** (`vitest.config.ts:143-146`).
- CLI: `apps/zcode-cli/vitest.config.ts` (include `test|tests`), плюс `node:test`-файлы, исключённые из Vitest, и `turbo run test`.
- E2E: `packages/desktop/wdio.conf.ts` — **5291 строка** одной конфигурации.
- Архитектура: `architecture-policy.yaml` (1106 строк): **107 модулей, из них 51 `managed: true`**; `pnpm architecture:check/report/baseline:update/context/adopt` (`package.json:93-97`).
- Doc links: `scripts/check-doc-links.mjs` — **прогон выполнен**: `[doc-links] OK：1693 个文件、2472 条相对链接全部有效` (1693 файла, 2472 относительные ссылки), exit 0.
- Pre-push: `.husky/pre-push:17` → `pnpm run verify:pre-push`; цепочка из **14 шагов** (`package.json:51`): `prism10:check` → `test:prism10-experiment-gate` → `lint` → `check-tracked-privacy` → `db:schema:check` → `test:architecture` → `architecture:check --changed` → `test:unit:affected --scope push` → `test:self-improve-pr` → `test:delegation-routing-benchmark` → `test:knip-baseline` → `test:cross-platform-preview-release` → `knip` → `test:brainstorming-companion`. **`typecheck` и `fmt:check` в цепочке отсутствуют** (проверено `node -e` по строке скрипта).
- `commit-msg` hook требует кириллицу в теме коммита (`.husky/commit-msg:26-29`), с исключениями `Merge*/Revert*/fixup!/squash!/Release*`.
- `lint-staged.config.mjs` существует и подключён как devDependency (`package.json:120`), но `.husky/pre-commit` **отсутствует** — конфигурация не вызывается.

CI (Observed):

- Единственный workflow: `.github/workflows/cross-platform-preview-release.yml` (209 строк), триггер — **только `workflow_dispatch`** с обязательным `release_tag` (строки 3-12).
- Матрица: `desktop` и `cli` jobs × 3 платформы (`macos-15`/arm64, `windows-2025`/x64, `ubuntu-24.04`/x64), строки 27-45 и 101-120; Node `24.14.0` (строки 56, 130), pnpm `10.33.2` (строки 60, 134).
- Шаги: checkout → setup-node → setup-pnpm → verify tag == `package.json` version → `pnpm install --frozen-lockfile` → build → upload artifacts; `publish` job собирает артефакты и создаёт/обновляет prerelease.
- **Ни `lint`, ни `typecheck`, ни unit/E2E в workflow не запускаются** (`grep -n "pnpm lint\|typecheck\|test:unit\|pnpm test"` → пусто).
- `.gitlab-ci.yml` и `.gitlab/` **отсутствуют**: `git ls-files | grep -cE "^\.gitlab"` → 0.

Фактические прогоны (Observed, реальные exit codes):

| Команда | Результат |
| --- | --- |
| `node scripts/check-workspace-freshness.mjs` | exit **0**, «基线新鲜 … ahead 344 / behind 0» |
| `node scripts/architecture/architecture-check.mjs check` | exit **1**: `architecture: FAILED`, `violations: 1`, `missing-module-artifact packages/services/src/gen-ui: 模块 gen-ui-service 缺少 contract.test.ts` |
| `node scripts/architecture/architecture-check.mjs check --changed` | exit **0**: `architecture: OK`, base `merge-base upstream origin/dev` |
| `npx oxlint` | exit **0**: `95 warnings and 0 errors` |
| `npx oxfmt --check` | exit **1**: `Format issues found in above 145 files` |
| `node scripts/check-doc-links.mjs` | exit **0**: 1693 файла, 2472 относительные ссылки |

### 3.5. Документация

- 2088 tracked `.md` в `docs/`, 2486 файлов всего, 67 MB. Верхнеуровневых `.md` прямо в `docs/` — 285.
- Крупнейшие разделы: `docs/testing` (92 md), `docs/ui` (163), `docs/desktop` (45), `docs/browser-use` (48), `docs/specs` (50 файлов), `docs/chat` (37), `docs/monitoring` (33), `docs/v4-refactor` (28), `docs/architecture` (21), `docs/git` (14), `docs/web-remote-control` (13), `docs/plans` (14), `docs/cua` (15).
- Крупнейшие файлы: `docs/conversation-session-case-catalog.md` (4828 строк), `docs/testing/conversation-session-e2e-coverage-matrix.md` (4344), `docs/dynamic-workflow/launch.md` (2987), `docs/specs/workspace-hook-trust.md` (2756).
- `docs/adr/` — 4 ADR. `docs/specs/` — 50 файлов спецификаций. `specs/` в корне — 1 файл.
- **`docs/README.md` и `docs/index.md` отсутствуют** — точки входа в 2088 документов нет; навигация только через `AGENTS.md`, внешние ссылки и `apps/dev-docs` (который рендерит не markdown, а статические TS-данные: `apps/dev-docs/src/data/productCapabilityMap.ts`, `featureBoundaryGraph.ts`, `protocolDocs.ts`).
- Вложенная документация CLI: `apps/zcode-cli/docs` — 159 `.md`, плюс `apps/zcode-cli/AGENTS.md`.

### 3.6. Release, versioning, changelog

| Механизм | Состояние | Доказательство |
| --- | --- | --- |
| Версия продукта | `3.17.102` | `package.json:3` |
| Версия CLI | `0.17.0` | `apps/zcode-cli/package.json:3` |
| Версия публикуемого `@zcode/rpc` | `1.0.0` | `packages/rpc/package.json:3` |
| Версия `@zcode/zcode-cua` | `0.6.5` | `packages/zcode-cua/package.json:3` |
| Теги | 84, последние `v3.17.102` … `v3.17.93` | `git tag --sort=-creatordate \| head` |
| `release-it` (корень) | `.release-it.mjs`: `git.commitMessage`/`tagName`, `npm.publish: false`, `infile: "CHANGELOG.md"` | `.release-it.mjs:8-31` |
| `CHANGELOG.md` | **отсутствует** | `ls -la CHANGELOG.md` → No such file |
| Changesets | **отсутствуют** | `ls -la .changeset` → no .changeset |
| macOS Preview release | `scripts/release-macos-preview.mjs`, `scripts/release-macos-local.mjs` + 11 модулей в `scripts/release-macos-local/` | `ls scripts/release-macos-local` |
| Version commit contract | Preview-коммит обязан менять **только** `package.json` и `package-lock.json`; версии в обоих файлах должны совпадать | `scripts/release-macos-preview.mjs:156-171` |
| `package-lock.json` | tracked, 2049 строк, 140 `packages`-записей; в корне только 5 devDeps, при 23 в `package.json`; обновляется **только** полем version | `package-lock.json:1-20`; `scripts/release-macos-preview.mjs:184-198` |
| Lockfile-история | `package-lock.json` — 100 коммитов; `pnpm-lock.yaml` — 9 коммитов | `git log --oneline -- <file> \| wc -l` |
| CLI release | `apps/zcode-cli/.release-it.json`: `git: false`, `npm.publish: false` | `cat apps/zcode-cli/.release-it.json` |
| Packaging | `packages/desktop/electron-builder.config.js` (49 KB), `Dockerfile.desktop-e2e`, `scripts/zcode-distribution/`, `scripts/build-zcode.mjs` | `ls -la` |

### 3.7. Профили агентов и skills

- **`.zcode/agents/` отсутствует.** В `.zcode/` только `evaluation-cases.json`. Профили ролей задаются кодом: канонический список 16 ролей — `apps/zcode-cli/packages/core/src/subagent/profile.ts:18-35` (`SWARM_AGENT_TYPES`: `start`, `orchestrator`, `researcher`, `debugger`, `implementer`, `coder`, `frontend-coder`, `backend-coder`, `infra-coder`, `reviewer`, `security-reviewer`, `test-engineer`, `evaluator`, `self-improver`, `knowledge-curator`, `subagent-factory`).
- При этом prompt-контракт предписывает создавать устойчивые профили в `.zcode/agents` (`profile.ts:72`, `:129`, `:338-343`, `:400`, `:767`). В этом checkout каталога нет — расхождение между инструкцией и состоянием репозитория (не дефект: каталог появляется по мере создания профилей).
- `.agents/skills/` — **32 каталога**, все tracked (32 `SKILL.md` через `git ls-files`). Из них:
  - **19 из marketplace**, зафиксированы в `skills-sh.lock.json` (find-skills, vercel-react-native-skills, vercel-react-view-transitions, web-design-guidelines, frontend-design, apple-design, emil-design-eng, review-animations, design-mobile-apps, prisma-client-api, google-agents-cli-{adk-code,observability,scaffold}, grill-with-docs, triage, diagnosing-bugs, code-review, wayfinder, wizard).
  - **13 локальных (workspace-specific)**: `agent-browser`, `ai-elements`, `architecture-governance`, `dep-refs`, `dogfood`, `e2e-case-lifecycle`, `electron`, `feature-boundary-planner`, `react-best-practices`, `session-management`, `yandex-webmaster`, `yandex-wordstat`, `zcode-large-task-fixture`.
  - 4 из них пришли из `vercel-labs/agent-browser` и зафиксированы отдельно в `skills-lock.json` (agent-browser, ai-elements, dogfood, electron).
- 10 skills имеют подкаталог `agents/openai.yaml` (architecture-governance, code-review, dep-refs, diagnosing-bugs, e2e-case-lifecycle, feature-boundary-planner, grill-with-docs, triage, wayfinder, wizard) — это метаданные для внешнего маркетплейса, не профили ZCode.
- Расхождение имени: каталог `.agents/skills/react-best-practices` объявляет `name: vercel-react-best-practices`.
- Workspace-specific skills, завязанные на архитектуру ZCode: `architecture-governance`, `dep-refs`, `e2e-case-lifecycle`, `feature-boundary-planner`, `session-management`, `zcode-large-task-fixture`.
- Дополнительно: `apps/zcode-cli/.agents/skills/` — 3 skills (`opentui`, `vercel-react-best-practices`, `vercel-react-view-transitions`) внутри вложенного workspace.

### 3.8. Git-история

- 30 последних коммитов — релизы Preview и исправления индекса/оркестрации (см. §8, E-9). Язык тем — русский (принудительно, `.husky/commit-msg:26-29`).
- Плотность за последние 300 коммитов (Observed, `git log -300 --oneline -- <path> | wc -l`):

| Область | Коммитов | Последний |
| --- | --- | --- |
| `apps/zcode-cli` | 139 | `982e30c9` 2026-11-10 |
| `packages/ui` | 77 | `982e30c9` 2026-11-10 |
| `packages/services` | 63 | `bbb756e8` 2026-11-10 |
| `packages/desktop` | 50 | `b697e913` 2026-11-10 |
| `scripts` | 49 | `b697e913` 2026-11-10 |
| `packages/shared` | 41 | `4cdcc7e9` 2026-11-10 |
| `packages/server` | 10 | `8cd57114` 2026-11-05 |
| `packages/client` | 7 | `23f8312a` 2026-11-08 |
| `packages/provider-node` | 7 | `3b2f6d88` 2026-11-05 |
| `packages/provider` | 6 | `3b2f6d88` 2026-11-05 |
| `packages/web` | 4 | `09b0235a` 2026-11-08 |
| `packages/zcode-server-cli` | 3 | `24a685d4` 2026-11-08 |
| `packages/rpc` | 2 | `3b2f6d88` 2026-11-05 |
| `packages/web-share` | 1 | `1889d446` 2026-10-21 |

- `origin/main` — один коммит `1889d446` «Initial import of the Zcode source tree» (2026-10-21); `dev` впереди на 344. **Тип репозитория:** история ведётся в `dev`; `main` — точка импорта, а не активная ветка. Даты не используются как аргумент о причинах.

## 4. Gaps, risks, weaknesses

Все пункты — **Observed**, если не помечено иначе.

**G-1. Пин Node не проверяется на обычных путях.** `ci:assert-node` (`scripts/assert-node-version.mjs:94-104`) проверяет только `major >= 24`, поэтому Node 26.9.0 проходит. Точное сравнение с `mise.toml` есть только в macOS-release (`release-macos-local/main.mjs:43`, `release-macos-preview.mjs:314`). Итог: локальные проверки, pre-push и CI могут идти на версии, отличной от пина. Риск: различия V8/Node API и поведения инструментов между 24 и 26 не проявятся до release.

**G-2. Архитектурный гейт на полном дереве красный при зелёном `--changed`.** `architecture-check check` → exit 1 (`missing-module-artifact packages/services/src/gen-ui … contract.test.ts`), а `check --changed` → exit 0, потому что `packages/services`/`gen-ui` не входят в diff. Pre-push использует именно `--changed` (`package.json:51`), поэтому нарушение не блокирует push. Файл `packages/services/src/gen-ui/contract.test.ts` отсутствует физически, модуль `gen-ui-service` объявлен `managed: true` с `roots: [packages/services/src/gen-ui]` (`architecture-policy.yaml:256-271`).

**G-3. Нет отслеживаемого CI-гейта на lint/typecheck/unit.** Единственный workflow — ручной release-пайплайн (`workflow_dispatch`, строки 3-12) без тестовых шагов. Реальный гейт — локальный pre-push. Дополнительно: `.gitlab-ci.yml`/`.gitlab/` отсутствуют (0 tracked файлов), хотя `docs/desktop-ci-cd.md:3,7-13` описывает их как «вход CI/CD» и перечисляет `00-workflow.yml`…`50-release.yml`.

**G-4. `fmt:check` красный на HEAD.** `npx oxfmt --check` → exit 1, 145 файлов (включая `.agents/skills/*`, `packages/ui/src/v4/SessionPane.tsx`, `scripts/knip-baseline.mjs`). В `verify:pre-push` форматирование не входит. То есть заявленный style gate (`package.json:72`) не проходит на текущем `dev`.

**G-5. `typecheck` вне pre-push и не покрывает CLI.** `verify:pre-push` не содержит `typecheck`. Корневой `typecheck` (`package.json:69`) перечисляет пакеты явно и **не включает** `apps/zcode-cli` (проверено подстрокой `zcode-cli` → нет), хотя CLI — вторая по величине кодовая база (349k строк `src`). Типы CLI проверяются только при `pnpm --dir apps/zcode-cli typecheck`/`check`.

**G-6. Битая конфигурация Vitest.** `vitest.config.ts:120-121` перечисляет `scripts/assert-safe-cua-helper-zip.test.mjs` и `scripts/ci/ci-telemetry-keyword-guard.test.mjs`; оба файла **отсутствуют**, каталога `scripts/ci/` нет. Include по `scripts/*.test.mjs` (кроме двух имён) отсутствует, поэтому 37 файлов `scripts/test/*.test.mjs` в корневой unit-прогон не попадают и запускаются только отдельными скриптами.

**G-7. Два lockfile и «декоративный» `package-lock.json`.** `pnpm-lock.yaml` (829 KB) — реальный менеджер; `apps/zcode-cli/pnpm-lock.yaml` — второй, вложенный; `package-lock.json` — 2049 строк, 140 записей, но корневой `devDependencies` содержит 5 пакетов против 23 в `package.json`. Он существует как носитель версии для release-скрипта (`release-macos-preview.mjs:156-171,184-198`), а не как рабочий npm-lock. Риск: любой инструмент/агент, принявший его за источник истины, получит неверную картину зависимостей.

**G-8. Противоречие про submodule.** `docs/bootstrap.md:3,5` утверждает, что `pnpm bootstrap` «сначала подтягивает `apps/zcode-cli` submodule»; `README.md:33` и `README.en.md:33` — что это обычный каталог без submodule. Проверка: `.gitmodules` нет, gitlink-записей нет, `git submodule status` пуст; при этом `scripts/bootstrap.mjs:220` действительно вызывает `git submodule update --init --recursive apps/zcode-cli` (no-op, exit 0). Документация описывает намерение, которого нет в структуре репозитория.

**G-9. README-блок «Обновления» устарел.** `README.md:18-21` и `README.en.md:18-21` последним указывают v3.16.2 (2026-10-19), при `package.json:3` = 3.17.102.

**G-10. Документы ссылаются на удалённые пути.** `docs/desktop-ci-cd.md:3,7-13` (`.gitlab-ci.yml`, `.gitlab/ci/*.yml`), `docs/ci-cache-strategy.md:1-4` (GitLab cache как действующая политика), `docs/product-capability-map-engineering-infrastructure.md:11,45` (`packages/distillation`, `scripts/ci` — каталоги отсутствуют), 10 документов ссылаются на `scripts/ci/`. Гейт `check-doc-links` это не ловит: он проверяет только markdown-ссылки, а не упоминания путей в inline-code (и прогон зелёный: 2472 ссылки).

**G-11. Нет точки входа в документацию.** 2088 tracked `.md`, 67 MB, при отсутствии `docs/README.md`/`docs/index.md`; `apps/dev-docs` показывает статические capability-данные, а не навигацию по markdown.

**G-12. `lint-staged` подключён, но не вызывается.** `lint-staged.config.mjs` + devDependency (`package.json:120`), `prepare` = `husky && pnpm build:cua` (`package.json:36`), но `.husky/pre-commit` нет; в `_/` есть шаблон, не активированный. Проверка стиля на коммите фактически отсутствует; остаётся `pre-push`.

**G-13. Крупные файлы при собственном лимите 800 строк.** `.oxlintrc.json:5` задаёт `max-lines: 800`, но 103 tracked файла в `packages/*/src` превышают лимит; крупнейшие: `packages/services/src/bots/botsService.ts` (9887), `packages/ui/src/i18n/locales/en-US.ts` (8732), `zh-CN.ts` (8276), `packages/services/src/zcode-agent/zcodeAgentService.ts` (7705), `packages/ui/src/v4/SessionPane.tsx` (6114). Лимит де-факто превращён в список исключений.

**G-14. Архитектурная политика покрывает меньшинство модулей.** 107 модулей, `managed: true` — 51; `packages/services`, `packages/ui`, `packages/shared`, `packages/provider`, `packages/client`, `packages/server`, `apps/zcode-cli` объявлены `managed: false` (`architecture-policy.yaml:5-50`). Гейт даёт гарантии только для покрытых модулей — это зафиксировано и в `docs/agents/instruction-maintenance.md` («门禁只对其实际覆盖的模块提供保证»).

**G-15. Coverage без порогов.** `vitest.config.ts:143-146` задаёт только provider/include; thresholds отсутствуют, `test:coverage` (`package.json:37`) не является гейтом.

**G-16. CUA — заглушка.** `packages/zcode-cua/package.json` (description): «ships without Computer Use: every runtime surface reports unavailable and fails closed». При этом пакет — зависимость `packages/desktop` и `packages/services`, а в CLI есть `zcode-cua-plugin` (0 тестов). Риск: UI-поверхности CUA могут обещать больше, чем поставлено.

**G-17. Нулевое тестовое покрытие у части встроенных плагинов.** 0 тестов у `documents-plugin`, `image-search-plugin`, `pdf-plugin`, `presentations-plugin`, `plugin-creator-plugin`, `restore-legacy-sessions-plugin`, `skill-creator-plugin`, `spreadsheets-plugin`, `superpowers-plugin`, `swift-bridge`, `visualize-plugin`, `zcode-cua-plugin`, `zcode-guide-plugin`. У части есть `test:e2e`/`smoke`-скрипты, но в этом checkout tracked-тестов нет.

**G-18. `.github` содержит единственный workflow и не покрывает PR-проверки.** См. G-3; дополнительно `docs/testing/github-actions-billing.md` фиксирует блокировку Actions на уровне аккаунта — то есть даже ручной прогон сейчас может падать вне репозитория.

**G-19. Второй вложенный workspace без единого гейта.** `apps/zcode-cli` имеет собственный `turbo.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, 30 пакетов и 428k строк тестов, но корневой pre-push запускает только `test:unit:affected` (корневой Vitest, который не видит `apps/**`) и `lint` через `scripts/run-cli-lint.mjs` (только oxlint по пакетам). `turbo run test` CLI в pre-push не входит.

## 5. Strengths and differentiators

**S-1. Инженерная дисциплина гейтов выше среднего для OSS-репозитория.** 14-шаговый `verify:pre-push` (`package.json:51`) включает privacy-scan индекса и push-диапазона, SQLite schema contract, архитектурный baseline, affected-тесты, self-improve/delegation/knip/CI-contract тесты. Проверяет не только «собирается», но и «не деградировали ли контракты».

**S-2. Architecture-as-code.** `architecture-policy.yaml` (1106 строк, 107 модулей) с `managed`, `requires`, `layers`, `layerOrder`, `publicEntrypoints`, `contract.test.ts`-требованием и `adopt`-командой; отдельный `upstream-snapshot.json` для контроля принятых upstream-файлов. Это редкость: границы зафиксированы данными, а не только текстом.

**S-3. Масштаб тестов.** 3131 unit (вне desktop E2E) + 575 desktop E2E + 909 CLI + 42 скриптовых теста; `packages/ui` — 1102 теста, `packages/services` — 324, CLI `adapters` 164 / `bootstrap` 237 / `core` 306.

**S-4. Реальный multi-surface продукт.** Desktop (Electron 41.0.3) + Web + CLI/TUI + phone remote; общие пакеты `shared`/`rpc`/`client` вынесены и имеют собственные тесты.

**S-5. Доменный словарь и дизайн-система как первичные артефакты.** `CONTEXT.md` объявляет себя «唯一裁决来源» для терминов магазина плагинов; `DESIGN.md` (660 строк) задаёт палитру, типографику, spacing, radius, motion, a11y. Есть `docs/agents/instruction-maintenance.md` с таблицей «какой файл читать при каком изменении».

**S-6. Документированные контракты release/version.** Preview-релиз проверяет, что version-коммит меняет ровно `package.json` + `package-lock.json`, и что обе версии совпадают (`release-macos-preview.mjs:156-171`); CI-воркфлоу проверяет, что тег равен версии (`cross-platform-preview-release.yml:61-64`).

**S-7. Воспроизводимость окружения заявлена в трёх местах.** `mise.toml`, `.nvmrc`, `apps/zcode-cli/.node-version`; `mise`-задачи повторяют реальные pnpm-скрипты, не создавая второй семантики (`mise.toml:23-46`).

**S-8. Privacy и third-party как отдельные подсистемы.** `scripts/check-tracked-privacy.mjs` в pre-push; `third-party/SPEC.md` описывает владельцев, правила генерации notices и блокировки по лицензиям; `THIRD-PARTY-NOTICES.md` 2.0 MB.

## 6. Candidate recommendations

Формат: проблема/пробел → evidence → решение → scope/out-of-scope → эффект → риски → сложность → приоритет → критерии приёмки → проверка. Конкурентные сопоставления здесь не приводятся (синтез выполнит их отдельно).

### R-1. Сделать пин Node реально исполняемым
- **Проблема:** точная версия из `mise.toml` проверяется только в macOS-release; `ci:assert-node` допускает любую major ≥ 24, поэтому Node 26.9.0 проходит все локальные гейты.
- **Evidence:** `scripts/assert-node-version.mjs:94-104`; `mise.toml:2`; `scripts/release-macos-local/main.mjs:43`; `scripts/release-macos-preview.mjs:314`; `node --version` → v26.9.0.
- **Решение:** вызывать `assertPinnedNodeVersionFromMise()` из `verify:pre-push` (или отдельным шагом) и из CI setup-шага; оставить `ci:assert-node` как быструю major-проверку.
- **Scope:** `package.json` (script), `scripts/assert-node-version.mjs` (режим вызова), `.github/workflows/cross-platform-preview-release.yml`. **Out of scope:** смена пина, обновление Node.
- **Эффект:** исчезает класс «локально зелено, в релизе иначе».
- **Риски:** сломает push тем, кто сознательно работает на другой версии; нужен явный escape-hatch (`--allow-mismatch`) и сообщение с командой `mise exec`.
- **Сложность:** S. **Приоритет:** P0.
- **Приёмка:** `pnpm verify:pre-push` на Node 26.9.0 завершается с понятной ошибкой и ссылкой на `mise exec`; на 24.14.0 — проходит; escape-hatch документирован.
- **Проверка:** unit на `assertPinnedNodeVersion` (уже есть `scripts/test/release-macos-local.test.mjs:36-62`) + ручной прогон hook на обеих версиях.

### R-2. Устранить расхождение архитектурного гейта full vs `--changed`
- **Проблема:** `architecture:check` на полном дереве падает (`gen-ui-service` без `contract.test.ts`), а pre-push зелёный, потому что использует `--changed`.
- **Evidence:** прогон `architecture-check.mjs check` → exit 1, `missing-module-artifact packages/services/src/gen-ui`; `check --changed` → exit 0; `architecture-policy.yaml:256-271`; файла `packages/services/src/gen-ui/contract.test.ts` нет.
- **Решение:** добавить `packages/services/src/gen-ui/contract.test.ts` по контракту модуля (или понизить модуль до `managed: false` с записанным reason, если контракт ещё не готов). Плюс периодический (nightly/ручной) full-check, чтобы baseline не расходился молча.
- **Scope:** `packages/services/src/gen-ui/`, `architecture-policy.yaml`. **Out of scope:** рефакторинг gen-ui.
- **Эффект:** baseline перестаёт врать; full и changed совпадают.
- **Риски:** contract-тест может вскрыть реальные нарушения границ.
- **Сложность:** S–M. **Приоритет:** P0.
- **Приёмка:** `node scripts/architecture/architecture-check.mjs check` → exit 0, `violations: 0`.
- **Проверка:** прямой прогон полного режима.

### R-3. Ввести PR/commit CI-гейт (или явно зафиксировать его отсутствие)
- **Проблема:** единственный workflow — ручной release; lint/typecheck/unit в CI не запускаются; документы описывают несуществующий GitLab-пайплайн.
- **Evidence:** `.github/workflows/cross-platform-preview-release.yml:3-12`; `grep` по `pnpm lint|typecheck|test` → пусто; `git ls-files | grep -cE '^\.gitlab'` → 0; `docs/desktop-ci-cd.md:3,7-13`.
- **Решение:** либо добавить в GitHub Actions job `checks` (lint + typecheck + affected unit) на `pull_request`, либо, если Actions заблокирован биллингом, явно вынести это в `docs/testing` как «local-only gate» и обновить `docs/desktop-ci-cd.md`, удалив GitLab-описание.
- **Scope:** `.github/workflows/`, `docs/desktop-ci-cd.md`, `docs/ci-cache-strategy.md`. **Out of scope:** восстановление GitLab-инфраструктуры.
- **Эффект:** понятная и правдивая модель качества; новые контрибьюторы не ищут несуществующие файлы.
- **Риски:** CI на 3131 unit + 575 E2E дорог; нужен affected-режим.
- **Сложность:** M. **Приоритет:** P0 (документарная часть — P0, CI-часть — P1).
- **Приёмка:** любой из вариантов: (а) PR запускает `checks` job и краснеет на сломанном тесте; (б) ни один doc не упоминает `.gitlab`/`scripts/ci`/`packages/distillation`, и статус «local gates only» описан явно.
- **Проверка:** тестовый PR; `node scripts/check-doc-links.mjs` + `rg -n "\.gitlab|packages/distillation" docs`.

### R-4. Привести форматирование к зелёному и подключить его к гейту
- **Проблема:** `fmt:check` красный на HEAD (145 файлов), в pre-push не входит.
- **Evidence:** `npx oxfmt --check` → exit 1, 145 файлов; `package.json:51` (нет `fmt:check`), `:72`.
- **Решение:** разовый `pnpm fmt` отдельным коммитом (только форматирование), затем добавить `fmt:check` в `verify:pre-push` и в CI.
- **Scope:** форматируемые файлы, `package.json`. **Out of scope:** изменение `.oxfmtrc.json`-исключений без обоснования.
- **Эффект:** диффы перестают содержать шум; гейт становится исполнимым.
- **Риски:** большой единоразовый дифф; конфликты с открытыми ветками.
- **Сложность:** S. **Приоритет:** P1.
- **Приёмка:** `pnpm fmt:check` → exit 0; pre-push включает шаг.
- **Проверка:** прямой прогон `npx oxfmt --check`.

### R-5. Закрыть дыру в покрытии тестами корневых скриптов и CLI
- **Проблема:** 37 файлов `scripts/test/*.test.mjs` не попадают в корневой unit-прогон; два include-пути в Vitest битые; CLI-тесты не входят ни в root typecheck, ни в pre-push.
- **Evidence:** `vitest.config.ts:120-121` (оба файла отсутствуют), отсутствие include `scripts/test/**`; `package.json:69` (нет `zcode-cli`), `:51` (нет CLI test).
- **Решение:** добавить include `scripts/test/**/*.test.mjs` (или явный project), удалить битые пути; добавить в pre-push шаг `pnpm --dir apps/zcode-cli check` (или хотя бы `typecheck` + `test:unit:affected` для CLI).
- **Scope:** `vitest.config.ts`, `package.json`. **Out of scope:** переписывание CLI-тестов.
- **Эффект:** ~37 скриптовых тестов и 909 CLI-тестов перестают быть «теневыми».
- **Риски:** рост времени pre-push; нужен affected/кэш.
- **Сложность:** M. **Приоритет:** P1.
- **Приёмка:** `pnpm test:unit` выполняет скриптовые тесты; битые include удалены; pre-push запускает CLI typecheck.
- **Проверка:** `pnpm test:unit --reporter=verbose` показывает файлы из `scripts/test`; `pnpm typecheck` включает CLI.

### R-6. Убрать двойственность lockfile-ов
- **Проблема:** три lock-файла; корневой `package-lock.json` не отражает реальный граф зависимостей (5 devDeps против 23) и существует только ради version-контракта релиза.
- **Evidence:** `package-lock.json:1-20`; `node -e` сравнение → 18 отсутствующих devDeps; `scripts/release-macos-preview.mjs:184-198`; `apps/zcode-cli/pnpm-lock.yaml`.
- **Решение:** либо перевести version-контракт Preview-релиза на `pnpm-lock.yaml`/отдельный `release-metadata.json` и удалить `package-lock.json`, либо генерировать его полноценно. Зафиксировать в `docs/` единственный источник истины.
- **Scope:** `scripts/release-macos-preview.mjs`, `package-lock.json`, документация релиза. **Out of scope:** смена пакетного менеджера.
- **Эффект:** один источник истины; меньше ложных сигналов для агентов и инструментов.
- **Риски:** сломать release-скрипт и его тесты (`scripts/test/release-macos-preview.test.mjs`).
- **Сложность:** M. **Приоритет:** P2.
- **Приёмка:** `release-macos-preview` проходит на выбранной схеме; в репозитории один рабочий lock на workspace.
- **Проверка:** `pnpm test:release:macos`.

### R-7. Синхронизировать документацию с реальной структурой
- **Проблема:** submodule-утверждение, GitLab-пайплайн, `packages/distillation`, `scripts/ci`, устаревший README-блок версий.
- **Evidence:** `docs/bootstrap.md:3,5` vs `README.md:33`; `.gitmodules` отсутствует; `scripts/bootstrap.mjs:220`; `docs/desktop-ci-cd.md:3,7-13`; `docs/product-capability-map-engineering-infrastructure.md:11,45`; `README.md:18-21` vs `package.json:3`.
- **Решение:** удалить/переписать устаревшие разделы; в `docs/bootstrap.md` описать фактическое поведение (`git submodule update` как no-op при отсутствии submodule); в README — либо убрать блок «Обновления», либо генерировать его из тегов.
- **Scope:** перечисленные документы. **Out of scope:** реорганизация всего `docs/`.
- **Эффект:** новые участники и агенты не идут по ложным путям.
- **Риски:** низкие; требуется решение, что считать «историей версий».
- **Сложность:** S. **Приоритет:** P1.
- **Приёмка:** `rg -n "\.gitlab|packages/distillation|scripts/ci/" docs` не находит действующих (не архивных) упоминаний; `docs/bootstrap.md` не противоречит README.
- **Проверка:** `pnpm verify:links` + ручная сверка.

### R-8. Дать точку входа в 2088 документов
- **Проблема:** `docs/` без `README.md`/`index.md`; 67 MB; навигация только через `AGENTS.md` и точечные ссылки.
- **Evidence:** `ls docs/README.md docs/index.md` → нет; 2088 tracked md; `docs/testing` 92, `docs/ui` 163.
- **Решение:** добавить `docs/README.md` с картой разделов, «какой документ читать при каком изменении» (частично уже есть в `docs/agents/instruction-maintenance.md`) и правилом «новый раздел добавляет строку в индекс»; при желании — генерировать индекс скриптом и проверять в CI.
- **Scope:** `docs/README.md`, возможно `scripts/`-генератор. **Out of scope:** переписывание существующих документов.
- **Эффект:** снижение стоимости входа и риска «документ есть, но его не находят».
- **Риски:** индекс быстро устаревает без гейта.
- **Сложность:** S–M. **Приоритет:** P1.
- **Приёмка:** `docs/README.md` существует, покрывает все каталоги первого уровня, ссылки валидны; добавлен гейт полноты (каждый каталог `docs/*/` упомянут).
- **Проверка:** `pnpm verify:links`; новый тест полноты индекса.

### R-9. Убрать «мёртвые» конфигурации
- **Проблема:** `lint-staged` подключён, но `pre-commit` отсутствует; битые include-пути в Vitest.
- **Evidence:** `lint-staged.config.mjs`; `package.json:120`; `.husky/pre-commit` отсутствует; `vitest.config.ts:120-121`.
- **Решение:** либо добавить `.husky/pre-commit` → `pnpm exec lint-staged`, либо удалить конфиг и devDependency; битые include удалить.
- **Scope:** `.husky/`, `package.json`, `vitest.config.ts`. **Out of scope:** изменение правил линта.
- **Эффект:** меньше «настроено, но не работает»; честная модель гейтов.
- **Риски:** pre-commit замедлит коммиты; нужен `--no-verify`-путь и предупреждение.
- **Сложность:** S. **Приоритет:** P2.
- **Приёмка:** поведение коммита соответствует документации; `vitest.config.ts` не ссылается на отсутствующие файлы.
- **Проверка:** тестовый commit; чтение списка collected specs.

### R-10. Зафиксировать статус CUA и нулевого покрытия плагинов
- **Проблема:** `zcode-cua` — заглушка (`fails closed`), но присутствует в зависимостях desktop/services; 13 встроенных плагинов не имеют tracked-тестов.
- **Evidence:** `packages/zcode-cua/package.json` (description); `packages/zcode-cua/README.md`; отсутствие `test`/`test:e2e` у части плагинов (`documents-plugin`, `pdf-plugin`, `presentations-plugin`, `spreadsheets-plugin` имеют только `smoke`/`test:e2e` без tracked-тестов).
- **Решение:** добавить в документацию и/или capability-map явную метку «CUA unavailable in this build»; для плагинов — минимальный контрактный тест (manifest/schema/install path), не полный E2E.
- **Scope:** `packages/zcode-cua/README.md`, `docs/`, `apps/zcode-cli/packages/*-plugin`. **Out of scope:** реализация CUA.
- **Эффект:** отсутствие ложных ожиданий в UI и документации.
- **Риски:** требует продуктивного решения, а не только инженерного.
- **Сложность:** S (док) / M (тесты). **Приоритет:** P1 (док) / P2 (тесты).
- **Приёмка:** ни один UI/doc не обещает работающий CUA; у каждого встроенного плагина есть хотя бы один исполняемый тест.
- **Проверка:** `rg -n "Computer Use" docs packages/zcode-cua`; `pnpm --dir apps/zcode-cli test`.

### R-11. Спланировать оставшиеся исследовательские области (Z11–Z16)
- **Проблема:** конверт Z01 требует карту до Z16, но существуют только Z01–Z10; без назначения остаются телеметрия, evals, performance/reliability как отдельные темы, мультиплатформенность, монетизация/onboarding, тестирование/CI/качество, docs/DX, а также пакеты `zcode-server-cli`, `web-share`, `share-ui`, `zcode-cua`, `formal-proof`, `stream-animate`, `e2e-report`, `android`, `apps/dev-docs`, `scripts/`, `third-party/`.
- **Evidence:** `metadata.json` всех агентов → только `Branch ID: Z01..Z10`; §2.2, §2.3.
- **Решение:** выпустить Z11–Z16 конверты на непокрытые области (например: Z11 telemetry/observability/evals; Z12 performance/reliability; Z13 multiplatform + zcode-server-cli/remote; Z14 monetization/onboarding/i18n продукта; Z15 test/CI/quality infrastructure; Z16 docs/DX + dev-docs + e2e-report + formal-proof/stream-animate).
- **Scope:** план исследования. **Out of scope:** продуктовый код.
- **Эффект:** полнота карты, требуемая acceptance Z01.
- **Риски:** дублирование с частично покрытыми темами внутри Z02–Z10 — нужен явный out-of-scope.
- **Сложность:** S (план). **Приоритет:** P0 для миссии.
- **Приёмка:** каждый верхнеуровневый каталог и каждая тема из §2.2–2.3 имеет назначенный филиал или явную запись «сознательно вне охвата» с причиной.
- **Проверка:** таблица соответствия в синтезе, сверенная с `ls` верхнего уровня.

## 7. Open questions and unverified

**Не проверено и почему:**

1. **Реальное исполнение тестов.** `pnpm typecheck`, `pnpm test:unit`, `pnpm test:e2e`, `pnpm knip`, `pnpm db:schema:check`, `pnpm prism10:check` не запускались: research-only ограничение, полный набор тяжёлый, а часть шагов пишет артефакты. Следствие: утверждения о тестах — о структуре и наличии, а не о зелёном статусе.
2. **E2E-статус.** 575 WDIO-файлов не запускались; неизвестно, какие из них реально проходят на этой машине. `docs/testing/conversation-session-e2e-coverage-matrix.md` содержит статусы, но это документ, а не результат прогона.
3. **CI-исполнимость.** Actions-биллинг задокументирован как блокер (`docs/testing/github-actions-billing.md`), но фактический прогон workflow не выполнялся и не мог быть выполнен из этой сессии.
4. **`packages/android`.** Gradle-проект без `package.json`, не входит в pnpm-workspace (glob `packages/*` даёт каталог, но pnpm требует манифест). Собирается ли он, каким пайплайном и входит ли в релиз — не проверялось.
5. **Содержимое 2088 документов.** Проверялись структура, объём и точечные утверждения (§4), а не систематическая актуальность каждого документа.
6. **Семантика 113 корневых скриптов.** Инвентаризированы имена и ключевые из них; каждый скрипт по отдельности не читался.
7. **Корректность `packages/android` Gradle-обёртки, `patches/*.patch` и снапшотов `third-party/upstream/`** — не верифицировались.
8. **`dist`/`out`/`node_modules` в `packages/desktop`.** Каталоги существуют локально и gitignored; их содержимое не инспектировалось и не должно использоваться как источник фактов.
9. **Причина красного `fmt:check`.** Зафиксирован факт (145 файлов), но не установлено, почему drift накопился: не проверялась история `.oxfmtrc.json` и момент появления каждого файла. Даты/коммиты не используются как атрибуция.
10. **Профили в `.zcode/agents`.** Каталога нет, поэтому невозможно проверить формат реально созданных профилей — только контракт в `profile.ts`.
11. **Z11–Z16.** Отсутствие конвертов проверено по `metadata.json` всех сессий агентов в `~/.zcode/cli/agents`. Не исключено, что план существует в другом месте вне этого состояния; проверялся только доступный рантайм.

**Открытые вопросы к оркестратору:**

- Q-1. Является ли отсутствие Z11–Z16 дефектом плана (ветки ещё не запущены) или сознательным сокращением? От этого зависит, считать ли §2.2–2.3 «пробелами» или «отложенным охватом».
- Q-2. Считать ли `packages/android` продуктовой частью (тогда нужен владелец и гейт) или экспериментальным каталогом?
- Q-3. Ожидается ли, что `packages/zcode-cua` останется заглушкой в Preview-сборке? Если да, нужна явная продуктовая формулировка для UI/доков.
- Q-4. Должен ли `pnpm verify:pre-push` включать `typecheck` и `fmt:check`? Сейчас не включает, а `AGENTS.md` требует «必须执行 pnpm typecheck 和 pnpm lint» для изменений кода — то есть требование адресовано агенту, а не гейту.

## 8. Evidence appendix

**E-1. git baseline**

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
$ git rev-parse HEAD
d10f0b69f98677091e0428a92839e4a1e01e04ca
$ git rev-list --left-right --count origin/main...dev
0	344
$ git log -1 --format='%h %ad %s' --date=short origin/main
1889d446 2026-10-21 Initial import of the Zcode source tree.
```

**E-2. freshness**

```text
$ node scripts/check-workspace-freshness.mjs
[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）
EXIT_CODE=0
```

**E-3. версии**

```text
$ node --version
v26.9.0
$ cat mise.toml   # первые строки
[tools]
node = "24.14.0"
pnpm = "10.33.2"
$ cat .nvmrc
24
$ cat apps/zcode-cli/.node-version
24.14.0
$ node -e "console.log(require('./package.json').engines.node)"
>=24.0.0
```

**E-4. прогоны гейтов**

```text
$ node scripts/architecture/architecture-check.mjs check
architecture: FAILED
violations: 1
baseline: 0
new: 1
- missing-module-artifact packages/services/src/gen-ui: 模块 gen-ui-service 缺少 contract.test.ts
REAL_EXIT=1

$ node scripts/architecture/architecture-check.mjs check --changed
architecture: OK
base: merge-base upstream origin/dev
violations: 0
REAL_EXIT=0

$ npx oxlint
Found 95 warnings and 0 errors.
REAL_EXIT=0

$ npx oxfmt --check
Format issues found in above 145 files. Run without `--check` to fix.
Finished in 10428ms on 9646 files using 10 threads.
REAL_EXIT=1

$ node scripts/check-doc-links.mjs
[doc-links] OK：1693 个文件、2472 条相对链接全部有效
EXIT=0
```

**E-5. подсчёты**

```text
$ git ls-files | wc -l                            → 18816
$ git ls-files 'docs/*.md' | wc -l                → 2088
$ find docs -type f | wc -l                       → 2486
$ du -sh docs                                     → 67M
$ git ls-files '*.ts' '*.tsx' | wc -l             → 9420
$ git ls-files '*.test.ts' '*.test.tsx' '*.test.mjs' | grep -v '^packages/desktop/test/e2e/' | wc -l → 3131
$ git ls-files 'packages/desktop/test/e2e/*.test.ts' | wc -l → 575
$ git ls-files 'apps/zcode-cli/**/*.test.ts' | wc -l → 909
$ git ls-files 'scripts/test/*.test.mjs' 'scripts/*.test.mjs' | wc -l → 42
$ ls -1 .agents/skills | wc -l                    → 32
$ git tag | wc -l                                 → 84
$ ls -1 scripts | wc -l                            → 113
$ grep -c '^  - id:' architecture-policy.yaml      → 107
$ grep -c 'managed: true' architecture-policy.yaml → 51
```

**E-6. структура workspace**

```text
$ cat pnpm-workspace.yaml
packages:
  - apps/dev-docs
  - packages/*
  - apps/zcode-cli
  - apps/zcode-cli/packages/*
  - apps/zcode-cli/tools/*
…
$ ls -1 apps
dev-docs
zcode-cli
$ ls packages/android/package.json
ls: packages/android/package.json: No such file or directory
$ find . -name turbo.json -not -path '*/node_modules/*'
./apps/zcode-cli/turbo.json
```

**E-7. reference-файлы (path:line)**

| Утверждение | Источник |
| --- | --- |
| Пин Node/pnpm | `mise.toml:1-7` |
| engines/packageManager | `package.json:134-137` |
| 14-шаговый pre-push | `package.json:51`; `.husky/pre-push:17` |
| Корневой typecheck без CLI | `package.json:69` |
| Coverage без thresholds | `vitest.config.ts:143-146` |
| Битые include | `vitest.config.ts:120-121` |
| fork-isolated список | `vitest.config.ts:11-90`, `:130-140` |
| max-lines 800 | `.oxlintrc.json:5` |
| Prettier/oxfmt ignore | `.oxfmtrc.json:1-32` |
| CI-триггер и матрица | `.github/workflows/cross-platform-preview-release.yml:3-12`, `:27-45`, `:101-120` |
| CI без тестов | тот же файл, шаги `:48-96`, `:122-158` |
| Release-контракт версий | `scripts/release-macos-preview.mjs:156-171`, `:184-198` |
| Node-ассерт только major | `scripts/assert-node-version.mjs:94-104` |
| submodule-вызов | `scripts/bootstrap.mjs:220` |
| Submodule-утверждение в доках | `docs/bootstrap.md:3,5`; противоречие — `README.md:33` |
| Устаревший CI-док | `docs/desktop-ci-cd.md:3,7-13` |
| Удалённые пути в доке | `docs/product-capability-map-engineering-infrastructure.md:11,45` |
| 16 ролей | `apps/zcode-cli/packages/core/src/subagent/profile.ts:16-35` |
| Контракт профилей `.zcode/agents` | `profile.ts:72,129,338-343,400,767` |
| Политика модулей | `architecture-policy.yaml:5-50`, `:256-271` |
| CUA-заглушка | `packages/zcode-cua/package.json` (description), `packages/zcode-cua/README.md` |
| `.plan/` gitignored | `.gitignore:81` |
| Skills-lock | `skills-lock.json`, `skills-sh.lock.json` |

**E-8. Git-история (последние 10)**

```text
d10f0b69 Выпустить macOS Preview 3.17.102.
bbb756e8 Не красить весь индекс частичным из-за фиктивных паролей в тестах.
fc70a81b Выпустить macOS Preview 3.17.101.
982e30c9 Убрать неиспользуемые экспорты, которые knip считает новыми.
05bd5b31 Уложить индекс и подсказку хода в лимиты архитектуры, чтобы пуш прошёл.
4cdcc7e9 Показать свежий индекс и миниатюры очереди, и не заставлять агентов перечитывать файлы.
5ebb2408 Выпустить macOS Preview 3.17.100.
b697e913 Добавить индикатор состояния индекса и завершить runtime-исправления
512131c4 Выпустить macOS Preview 3.17.99.
45700674 Исправить компиляцию после снятия planner deadline
```

**E-9. Источники вне git (рантайм миссии), только для карты филиалов**

- `<home>/.zcode/cli/agents/session_5341dd672f640ba6d5cff3c4bd7773b7/*/metadata.json` — конверты Z01–Z10 (`prompt`, `profileId`, `status`).
- Команда проверки: `grep -rIoh --include="metadata.json" -E "Branch ID: Z[0-9]+" ~/.zcode/cli/agents | sort -u` → `Z01 … Z10`; Z11–Z16 отсутствуют.
- Эти данные использованы **только** для §2.1–2.3 (карта покрытия) и не являются доказательством состояния продукта.

---

## Coverage status

**Статус: partial (высокая полнота по инвентарю, неполнота по исполнению и по филиалам Z11–Z16).**

Покрыто и перепроверено источником: preflight (точные выводы и exit codes), верхний уровень репозитория, все `package.json` (18 в `packages/`, 2 в `apps/`, 30 + 2 во вложенном CLI-workspace), корневые конфиги, тестовая структура и гейты, CI-воркфлоу, release/versioning, skills и роли агентов, git-агрегаты, карта покрытия Z01–Z10.

Не проверено: исполнение `typecheck`/unit/E2E/knip/db-schema/prism10; фактический прогон CI; содержимое 2088 документов; каждый из 101 корневого скрипта; сборка `packages/android`; причина накопления fmt-drift; реальные профили `.zcode/agents` (каталога нет); существование плана Z11–Z16 вне доступного рантайма.

Блокеры: нет технических блокеров; единственное содержательное ограничение — **Z11–Z16 не существуют**, поэтому требование «карта до Z16» выполнено как «Z01–Z10 назначены, остальное явно помечено как не назначенное».

**Подтверждение:** записан только этот файл — `<repo-root>/docs/research/partials/2026-11-11-zcode-01-inventory.md`. Продуктовые файлы, конфиги и lockfile не изменялись; `git status --short` после работы содержит только `?? docs/research/`.
