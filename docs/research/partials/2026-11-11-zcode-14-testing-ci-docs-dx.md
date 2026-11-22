# Z14. Тестирование, CI/качество, документация и DX (темы 24, 25, 22)

Дата исследования: 2026-11-11. Ветка: `dev`. База: `d10f0b69` («Выпустить macOS Preview 3.17.102.»).

## 1. Scope and method

**Вопрос.** Как в ZCode устроены тестовая архитектура, локальные и CI-гейты качества, релиз/упаковка, мультиплатформенные пути, документация и developer experience; где проходят реальные границы проверок и какие разрывы создают риск.

**Метод.** Только первичные источники в рабочем дереве: конфиги, скрипты, `package.json`, workflow, исходники и документация. Инструменты: адресный `CodeIndex` (`status` → `ready`, 10007 файлов / 26791 чанк), `Read`/`Grep`/`Glob`, точечные `Bash`-команды (листинги, `git`, `vitest list`, `node --test` отдельных файлов). Полный `pnpm test` и тяжёлые сборки не запускались (запрет envelope). Запускались только дешёвые/точечные проверки, перечисленные в §8.

**Метки.** OBSERVED — непосредственно наблюдаемый факт из файла:строки или вывода команды; INFERRED — вывод, не подтверждённый прямым запуском; UNKNOWN — источники не дают ответа. Каждая нагрузочная претензия ниже имеет путь:строку или команду.

**Preflight (OBSERVED).**
- `git status --short` → `?? docs/research/` (единственное локальное изменение; всё остальное чисто).
- `git branch --show-current` → `dev`.
- `git log -1 --oneline` → `d10f0b69 Выпустить macOS Preview 3.17.102.`
- `node --version` → `v26.9.0`; `pnpm --version` → `10.33.2`; `mise.toml:2-3` пинует Node `24.14.0`, pnpm `10.33.2`.

**Ограничения.** (а) `apps/zcode-cli` — вложенный pnpm-workspace с 913 `.test.ts` и собственным Turbo; его полный прогон не выполнялся. (б) Desktop E2E (575 файлов) не запускался: дорого и требует Electron/дисплея. (в) Часть выводов о CI за пределами checkout (внешний GitLab) остаётся UNKNOWN — в дереве таких конфигов нет. (г) Часть замеров количества специй сделана через `vitest list`/`globTestSpecifications`; расхождение 2064 vs 2066 для project `unit` отмечено в §7.

## 2. Coverage table

| Область | Что проверено | Метод | Статус |
|---|---|---|---|
| Корневой Vitest | `vitest.config.ts` целиком, projects, include/exclude, coverage | Read + `vitest list`/`globTestSpecifications` | OBSERVED |
| Пакетные Vitest | 9 конфигов (`packages/*`, `apps/*`, `apps/zcode-cli/*`) | Read | OBSERVED |
| Сбор тестов | 2688 `.test.ts` в `packages`, 10 `.test.tsx`, 913 в CLI, 575 E2E, 36 в `scripts/test` | `find` | OBSERVED |
| E2E | `wdio.conf.ts`, shard-runner, formal/pending, fixtures, веса | Read + `find` + `bash`-preset | OBSERVED (запуск E2E — нет) |
| Coverage | конфиг и пороги | Read + grep | OBSERVED |
| Гейты | `verify:pre-push`, lint/fmt/typecheck/arch/knip/privacy/schema/links/freshness | Read + фактические прогоны | OBSERVED |
| CI | `.github/workflows`, триггеры, jobs, кэш/секреты/пины | Read + grep | OBSERVED |
| Release | версии, скрипты macOS/Preview, signing, feed, changelog | Read + grep | OBSERVED |
| Мультиплатформа | platform-ветки, keychain, форматы, E2E-гейты по ОС | grep + Read | OBSERVED |
| Docs | 2088 tracked md, 48 каталогов, drift-ссылки, dev-docs | `git ls-files`/`find`/`rg` + запуск тестов dev-docs | OBSERVED |
| DX | bootstrap, dev-серверы, отладка, шаблоны, CODEOWNERS | Read + `git ls-files` | OBSERVED |
| Внешний CI (GitLab/Jenkins) | наличие конфигов вне checkout | `find` + `git ls-files` | UNKNOWN (в дереве отсутствуют) |

## 3. Capability inventory

### 3.1. Тестовая архитектура

**Корневой конфиг.** `vitest.config.ts:108-142` объявляет три проекта:
- `unit` — `include` (`:113-122`): `packages/*/test/**/*.test.ts`, `packages/*/src/**/contract.test.ts`, `packages/shared/src/node/genUiPaths.test.ts`, `packages/services/src/gen-ui/**/*.test.ts`, `scripts/assert-safe-cua-helper-zip.test.mjs`, `scripts/ci/ci-telemetry-keyword-guard.test.mjs`; `exclude` (`:123`) — `packages/desktop/test/e2e/**`, `packages/zcode-cua/**`, весь список `forkIsolatedTests`.
- `fork-isolated` (`:130-140`) — только `forkIsolatedTests`, `pool: "forks"`, `fileParallelism: false`, `maxWorkers: 1`.
- `packages/zcode-cua/vitest.config.ts` (`:141`) — отдельный проект `cua-placeholder` с 1 файлом.

**Глобальные параметры** (`vitest.config.ts:82-107`): `setupFiles: ./vitest.setup.ts`; `silent: "passed-only"` (`:96`, мотивация — 3.3 МБ stdout превышал лимит 256 КБ); `hookTimeout`/`testTimeout` 30 с (`:101,103`); `maxWorkers: 4`; `forceRerunTriggers` с `**/{vitest,vite}.config.*` и `**/vitest.setup.ts` (`:85-90`).

**Изоляция.** 32 уникальных файла в fork-группе (5 `processLifecycleTests` + 27 литералов), из них 10 физически отсутствуют (§4, G-3). Причина выделения описана комментариями: реальные процессы, `fs.watch`, Git-спавны, `electron-builder`/NSIS, pdfjs-краш в threads (`vitest.config.ts:11-58`).

**Пакетные конфиги.** `packages/rpc|provider|provider-node|zcode-server-cli` — `include: ["test/**/*.test.ts"]` (`packages/rpc/vitest.config.ts:3-7` и аналоги); `packages/zcode-server-cli` дополнительно `pool: threads`, `fileParallelism: false`, `maxWorkers: 1` (`:9-19`); `packages/ui/vitest.config.ts:4-6` — только алиас `@`, без `test.include`; `apps/dev-docs/vitest.config.ts:10-13` — node + `test/**/*.test.ts`; `apps/zcode-cli/vitest.config.ts:16-24` — четыре include-паттерна и исключение node:test-файлов; `apps/zcode-cli/packages/office-runtime/vitest.config.ts:3-7` — собственный таймаут 30 с.

**Сбор.** OBSERVED `globTestSpecifications` → 2089 спецификаций: `unit` 2066, `fork-isolated` 22, `cua-placeholder` 1. `vitest list --project unit` → 2064 уникальных файла / 19 889 кейсов (расхождение 2 файла — §7). На диске вне E2E — 2113 `.test.ts`; 24 не попадают в glob (`/tmp`-диф, §8).

**Что не собирается вообще.** 10 `.test.tsx` (все в `packages/ui/test/`, например `subagentDrilldown.test.tsx`): ни один include не содержит `.tsx`; `vitest list --project unit` → 0 tsx. При этом `knip.json:5-8` объявляет их entrypoint, то есть файлы поддерживаются как живые. 23 колокейтед `.test.ts` под `src/` не собираются, потому что include берёт только `contract.test.ts` + два точечных пути (`vitest.config.ts:114-121`).

**Мёртвые include/exclude.** `vitest.config.ts:120` — `scripts/assert-safe-cua-helper-zip.test.mjs`, `:121` — `scripts/ci/ci-telemetry-keyword-guard.test.mjs`; каталога `scripts/ci` нет (`ls scripts/ci` → No such file or directory). Отсутствие файлов в `include`/exclude-списке Vitest не считает ошибкой — гейт молча не покрывает заявленное.

**Coverage.** `vitest.config.ts:143-146`: provider `v8`, `include: ["packages/*/src/**/*.ts"]`. Ни `thresholds`, ни `all`, ни `.tsx`; порогов нет ни в одном конфиге (grep по `thresholds` → 0). Скрипт `test:coverage` (`package.json:37`) не входит ни в один гейт и ни в CI.

**Desktop E2E.** `packages/desktop/test/e2e` — 575 `.test.ts`; 377 в `manual-review/pending`, 198 формальных; `listDefaultFormalE2ESpecs()` (`packages/desktop/scripts/run-windows-e2e-shards.mjs:92-118`) исключает каталог `manual-review`, `upstream-provider.test.ts` и (без SSH-переменных) `conversation-session-ssh-remote*` → 194 спеки в дефолтном прогоне. Точка входа `packages/desktop/package.json:36` `test:e2e` → `run-windows-e2e-shards.mjs` на всех ОС (имя «windows» историческое); дефолт — 1 shard (`run-windows-e2e-shards.mjs:82-89`), перф-вход `--shards=10` (`packages/desktop/package.json:40`). WDIO-конфиг — монолит 220 820 байт, `wdio.conf.ts:4718-4721` (mocha, `spec` reporter, `maxInstances` 1). Фикстуры: 908 файлов `test/e2e/fixtures`, 405 case-манифестов `fixtures/cases/conversation-session`, два профиля весов (`spec-duration-weights.json` — 53 записи, `conversation-ci-spec-duration-weights.json` — 77, последний кодом не читается, только документом).

**Пропуски.** 4 явных `it.skip`/`describe.skip`; 37 `skipIf(process.platform...)`. Windows-only спеки (`windowsInstallerNshSmoke.test.ts:7`, `windowsInstallerPreserveFiles.test.ts:7`) попадают в glob, но `vitest list --project unit <file>` на darwin вернул `[]` — поведение Vitest 4 с `describe.skipIf` (UNKNOWN, §7).

**Изоляция данных.** `vitest.setup.ts:5-35` нормализует Git CRLF, Windows PATH (System32/bsdtar), удаляет `ZCODE_DATA_BASE_DIR`, мокает `node:os.homedir` на env; `:49-66` восстанавливает `localStorage` для jsdom на Node ≥25. E2E HOME/artifacts изолируются по runId (`run-windows-e2e-shards.mjs:240-267`), artifacts root в `.gitignore:21`, локально накоплено 226 каталогов / 54 МБ.

**CLI.** 913 `.test.ts` и собственный Turbo (`apps/zcode-cli/turbo.json:49-58`: `test` зависит от `build`, `coverage` — от `build`). Внутри CLI сосуществуют Vitest (843 файла) и `node:test` (65 файлов), причём `apps/zcode-cli/vitest.config.ts:8-23` исключает node:test-файлы, чтобы не получать «No test suite found». У 25 вложенных пакетов есть свои `test`-скрипты (в т.ч. `node --test` у `@zcode/cli`, `@zcode/tui`, `plugin-creator-plugin`).

**Пакеты без тестового входа.** У `packages/ui` нет `scripts.test` (`packages/ui/package.json:21-24` — только lint), хотя в `test/` 1060 `.test.*`. У `packages/services`, `packages/shared`, `packages/web`, `packages/desktop` тоже нет `test`-скрипта: единственный раннер — корневой. Запуск `npx vitest list` в `packages/ui` падает: `Cannot find package 'sharp'` и ENOENT на `packages/ui/src/v4/SessionPane.tsx` (наблюдаемый вывод) — то есть даже пакетный список UI-тестов в этом checkout не собирается.

### 3.2. Гейты качества

Полная цепочка `verify:pre-push` (`package.json:51`), 14 шагов, порядок фиксирован:
1. `prism10:check`; 2. `test:prism10-experiment-gate`; 3. `lint`; 4. `check-tracked-privacy.mjs`; 5. `db:schema:check`; 6. `test:architecture`; 7. `architecture:check -- --changed`; 8. `test:unit:affected --scope push`; 9. `test:self-improve-pr`; 10. `test:delegation-routing-benchmark`; 11. `test:knip-baseline`; 12. `test:cross-platform-preview-release`; 13. `knip`; 14. `test:brainstorming-companion`.

Чего в цепочке нет: `typecheck`, `fmt:check`, `verify:links`, `test:coverage`, `test:e2e`, любые тесты `apps/zcode-cli`, `audit:*`, `eval:gate`, `dep:refs`.

**Гейты против триггеров (OBSERVED):**

| Гейт (команда) | Где реально запускается | Триггер | Наблюдаемый статус 2026-11-11 |
|---|---|---|---|
| `pnpm lint` (`package.json:81`) | pre-push шаг 3; `release:macos:preview` (через `verify:pre-push`) | push любого ref (husky) | exit 0; oxlint 95 warnings / 0 errors; CLI-часть 86 warnings / 0 errors / 7 accepted |
| `pnpm typecheck` (`package.json:69`) | **только** `release:macos:preview` (`scripts/release-macos-preview.mjs:136`) и вручную | release preview | exit 0; CLI-воркспейс и `test/`-деревья не входят |
| `pnpm fmt:check` (`package.json:72`) | нигде автоматически (только AGENTS.md:18 как ручная команда) | — | exit 1; 160 файлов |
| `architecture:check --changed` (`package.json:93`) | pre-push шаг 7 | push | exit 0 (base `merge-base upstream origin/dev`, 0 нарушений) |
| `architecture:check` (полное дерево) | вручную/`architecture:report` | — | exit 1: `missing-module-artifact packages/services/src/gen-ui` |
| `test:architecture` (`package.json:97`) | pre-push шаг 6 | push | exit 0, 36/36 |
| `check-tracked-privacy.mjs` | pre-push шаг 4 | push | exit 0; 17 982 файла |
| `db:schema:check` (`package.json:99`) | pre-push шаг 5 | push | exit 0; оба baseline совместимы |
| `test:unit:affected --scope push` | pre-push шаг 8 | push (требует чистое дерево) | dry-run exit 2: «Push 工作区 не пусто» (из-за untracked `docs/research/`) |
| `knip` (`package.json:73`) | pre-push шаг 13 | push | exit 0; current=3174 baseline=3174 new=0 |
| `verify:links` (`package.json:52`) | нигде автоматически | — | exit 0 вручную: 1693 файла / 2472 ссылки; unit-тест 6/6 |
| `verify:privacy` (`package.json:53`) | нигде автоматически (в pre-push только сама проверка) | — | не запускался целиком; privacy-скрипт exit 0 |
| `check-workspace-freshness.mjs` | вручную (AGENTS.md:10) | — | exit 0: ahead 344 / behind 0 |
| `test:e2e` / `test:e2e:windows:sharded` | локально/вручную | — | не запускался |
| `test:coverage` | нигде | — | не запускался |
| `eval:gate`, `audit:*`, `dep:refs` | нигде автоматически | — | не запускались (кроме `dep:refs` smoke) |

**Lint.** `.oxlintrc.json` — единственное правило-ошибка `max-lines: 800` (`:6`), десятки overrides на warn/off, тесты и локали исключены (`:64-75`). `scripts/run-cli-lint.mjs:1-120` прогоняет lint каждого вложенного CLI-пакета и классифицирует «pristine upstream» диагностику; прямой вызов без `pnpm` падает с «请通过 pnpm lint 运行 CLI lint» (`:40-42`) — проверено.

**Typecheck.** `package.json:69` — `tsc -b` по 15 проектам; `apps/zcode-cli` в списке нет (это отдельный Turbo `typecheck`). `packages/desktop/tsconfig.json:6-14` включает e2e-проект (`tsconfig.e2e.json`), но ни один tsconfig пакетов не включает `test/` (например `packages/services/tsconfig.json:9` — `include: ["src"]`), то есть 2603 файла `packages/*/test/**/*.test.ts` не типизируются корневым гейтом.

**Architecture.** `architecture-policy.yaml:854-865` — global rules: `newFilesEnforcedSince: 2026-09-10`, `maxFileLines: 800`, `forbidCycles`, `forbidDeepImports`, `managedOnly: true`; 51 `managed: true`, 16 `managed: false`. Полный прогон падает на `gen-ui-service` (`architecture-policy.yaml:256-259`): required artifacts `module.ts/contract.ts/contract.example.ts/contract.test.ts/CONTRACT.md` (`scripts/architecture/index.mjs:88-94`), а `packages/services/src/gen-ui/contract.test.ts` отсутствует; `--changed` это не видит, потому что scope фильтрует модуль.

**Docs/format.** `scripts/check-doc-links.mjs:1-20` проверяет только относительные markdown-ссылки в `docs/` и корне; `inScope` (`:128-133`) явно отбрасывает всё вне `docs/` и корня; inline-code и пути в бэктиках не проверяются. `scripts/knip-baseline.mjs:1-40` — baseline-гейт (3174 известных проблемы, падает только на новых).

### 3.3. CI

OBSERVED: в дереве ровно один workflow — `.github/workflows/cross-platform-preview-release.yml`. Триггер — только `workflow_dispatch` (`:7`), нет `push`/`pull_request` (grep по триггерам → только `:7`). Jobs: `desktop` (`:25`), `cli` (`:99`), `publish` (`:158`). Матрицы: macOS Apple Silicon (`macos-15`, arm64), Windows x64 (`windows-2025`), Linux AMD64 (`ubuntu-24.04`) — по 3 цели на desktop и CLI (`:29-45`, `:103-118`).

- Node — `24.14.0` (`:56`, `:130`), pnpm — `10.33.2` (`:60`, `:134`); версии захардкожены, не из `mise.toml`.
- Кэширования нет: `actions/cache`/`cache: pnpm` не встречаются.
- `retention-days` нет.
- Секреты: только `${{ github.token }}` (`:190`); внешних secrets нет.
- Actions закреплены по major-тегу (`checkout@v4`, `setup-node@v4`, `pnpm/action-setup@v4`, `upload-artifact@v4`, `download-artifact@v4`; `:49,54,58,93,123,128,132,152,166,172`), не по SHA.
- Шагов lint/typecheck/test нет ни в одном job (grep по `pnpm test|lint|typecheck|vitest` → 0 совпадений).
- Проверка «тег = версия» (`:61-64`, `:135-138`, `:176-179`), сборка offline Preview (`:67-85`), smoke `--version` для CLI (`:141-150`), публикация prerelease идемпотентно (`:188-209`), отказ менять stable/чужой commit (`:196-198`).
- Отсутствие PR CI задокументировано как следствие биллинга: `docs/testing/github-actions-billing.md:1-40`, комментарий в workflow `:4-6`.
- GitLab-конфигов нет: `.gitlab-ci.yml`/`.gitlab/` отсутствуют, других CI (`Jenkinsfile`, `.circleci`, Azure, Bitbucket) нет (find → пусто). При этом 19 tracked документов упоминают `.gitlab` (§4, G-8).

**Локальный «CI» = husky.** `git config core.hooksPath` → `.husky/_`. `.husky/pre-push:1-17` кэширует stdin, чистит Git local env и вызывает `pnpm run verify:pre-push` (`:17`). `.husky/commit-msg:25-28` требует кириллицу в теме коммита. **Pre-commit-хука нет**: `.husky/` содержит только `commit-msg` и `pre-push` (листинг), `lint-staged.config.mjs` существует, `lint-staged` в devDependencies (`package.json:120`), но нигде не вызывается (grep по `.husky`, `.github`, `package.json` — только объявление).

### 3.4. Release и упаковка

**Версии.** `package.json:3` → `3.17.102`; `package-lock.json:3,9` → `3.17.102`; `apps/zcode-cli/package.json:3` → `0.17.0`; `packages/desktop/package.json` не имеет поля `version`. README отстаёт: `README.md:18-21` и `README.en.md:18-21` сообщают «Updated to ZCode v3.16.2», хотя пакет уже 3.17.102.

**Две разные политики bump.** `scripts/release-macos-local/main.mjs:58-88` меняет только `package.json`, коммитит только его и проверяет `statusAfterBuild === "M  package.json"` — `package-lock.json` остаётся со старой версией. `scripts/release-macos-preview.mjs:383-385` меняет и `package.json`, и `package-lock.json`, а `:156-161` требует, чтобы staged были ровно эти два файла. То есть локальный релиз и Preview оставляют разное состояние версионных носителей.

**Changelog.** `.release-it.mjs:23-33` подключает `@release-it/conventional-changelog` с `infile: "CHANGELOG.md"`; `CHANGELOG.md` в репозитории отсутствует (`git ls-files CHANGELOG.md` → 0) и не генерируется ни одним гейтом. `scripts/release-it/changelog-writer.mjs:1-50` задаёт свои секции/парсер. `pnpm release` при первом запуске создаст файл, которого сейчас нет в истории.

**Signing/упаковка.** `packages/desktop/electron-builder.config.js`: mac `dmg+zip` (`:914`), `identity` включается только при `ZCODE_ENABLE_MAC_SIGN=1` (`:72-74`, `:930`), `notarize`/`hardenedRuntime` (`:933-934`), win `nsis` (`:951`) + опциональный vsigntool-хук (`:240`, `:959-965`, `packages/desktop/scripts/sign-windows-hook.cjs`), linux `AppImage+deb+rpm+pacman` (`:967`), rpm-зависимости через fpm (`:990-999`), pacman `pkg.tar.zst` (`:981-988`). Preview принудительно ad-hoc/unsigned и без notarization/auto-update (`scripts/release-macos-preview.mjs:37-72`); ключи `APPLE_*`/`CSC_*`/`GH_TOKEN` вычищаются из env (`:39-52`). Production-релиз требует валидный Developer ID из keychain (`scripts/macos-release-security.mjs:80-115`).

**Auto-update.** `packages/desktop/electron-builder.config.js:1028-1037` — generic provider, `url: "https://zcode.z.ai/updates"`, `useMultipleRangeRequest: false`. Реально клиент использует кастомный `ManifestUpdateProvider` (`packages/desktop/src/main/autoUpdater.ts:814-833`), feed можно переопределить `ZCODE_UPDATE_FEED_URL` (`:28`). Генерация `latest.yml`/манифестов в репозитории отсутствует — фид формирует сервер (INFERRED из комментария `:1031-1032` и отсутствия скриптов).

**Rollback.** Автоматического отката релиза не найдено (grep `rollback` — только транзакция E2E-промоушена и тесты). Откат, судя по документации, ручной через серверный release API (`docs/desktop-ci-cd.md:28-29`) — но этого пайплайна в дереве нет.

**Node-pin на релизе.** `assertPinnedNodeVersionFromMise` бросает при несовпадении точной версии (`scripts/assert-node-version.mjs:65-80`). OBSERVED: на Node 26.9.0 вызов бросил `Версия Node 26...`; `pnpm ci:assert-node` при этом проходит, т.к. CLI-ветка проверяет только `major >= 24` (`:95-100`). Значит `pnpm release:macos:preview` в текущем окружении заблокирован без `mise exec`.

### 3.5. Мультиплатформа

- 49 файлов в `packages/**/src` содержат `process.platform ===`: 71 проверка `win32`, 37 `darwin`, 7 `linux`.
- Контракт платформы — `IPlatformService` (`packages/shared/src/platform.ts:683`), UI обязан ходить через него (AGENTS.md:56).
- Windows: отдельный Electron-резолв (`packages/desktop/scripts/dev.mjs:21-36`), win-специфичные app-пути (`scripts/dev-desktop-env.mjs:22-47`), System32/bsdtar нормализация в тестах (`vitest.setup.ts:11-18`), Windows-совместимость задокументирована: 8 классов причин, «9 fails / 12444 pass» после rebase (`docs/windows-test-compatibility.md:1-40`).
- Linux: 4 формата пакетов, зависимости mesa/alsa для rpm (`electron-builder.config.js:990-999`), `--linux` вариант remote-assets (`package.json:77`).
- Ключей ОС нет: credential store — JSON с AES-256-GCM, ключ из `ZCODE_CREDENTIAL_SECRET` или fallback `zcode-credential-fallback:<platform>:<homedir>:<user>` (`packages/services/src/credential/providers/credentialCipherProvider.ts:6,24-37,60`); комментарий прямо говорит, что переход на `safeStorage`/keychain — будущий шаг (`credentialService.ts:20-25`).
- E2E по ОС: 37 `skipIf`; `windowsInstaller*` — Windows-only; SSH-спеки гейтятся env-переменными (`e2e-formal-spec-selection.mjs:1-21`).
- Docker E2E: `scripts/test-desktop-e2e-container.sh:12,14` держит пустые `CONVERSATION_SESSION_VERIFIED_E2E_SPEC`/`PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC`, поэтому preset'ы `conversation-session-verified`/`plugins-verified` завершаются exit 2 (OBSERVED для первого). Дефолтный набор — 5 спек (`:9`), включая `upstream-provider.test.ts`.
- Платформенные артефакты Preview: 3 цели (`mac arm64`, `win x64`, `linux x64`) в workflow (`:29-45`) и в спецификации `docs/specs/cross-platform-preview-release.md:1-7`; CLI — те же 3 SEA (`:103-118`).

### 3.6. Документация

- OBSERVED: 2088 tracked `.md` под `docs/` (всего tracked md — 2879; 9 в корне; 466 в `apps/`, 49 в `packages/`); на диске 2112 (24 untracked — research-партиалы). 48 каталогов верхнего уровня, 68 МБ, ~424 708 строк.
- Крупные поддеревья: `docs/electron` 275 tracked, `docs/webdriverio` 123, `docs/superpowers` 261, `docs/working-memory` 260, `docs/vendor` 19, `docs/archive` 19.
- **Индекса нет**: `docs/README.md` и `docs/index.md` отсутствуют; README (корень) ссылается только на CLI-гайд (`README.md:112`). `AGENTS.md:28,38-39` указывает на `docs/testing/pre-push-hook.md`, `CONTEXT.md`, `DESIGN.md`, но не на карту docs.
- `specs/` в корне содержит 1 файл (`specs/zcode-unified-distribution.md`, initial import), тогда как `docs/specs/` — 50 файлов; формат «Product rules / Ownership and boundaries / Acceptance scenarios» выдержан, например `docs/specs/eval-gate.md:1-20`, `docs/specs/cross-platform-preview-release.md:1-20`. Единого контракта, какой каталог считать spec-домом, нет.
- `CONTEXT.md` (89 строк) — глоссарий Plugin Store; `DESIGN.md` (655 строк) — design system с явным приоритетом `text-ui-*`.
- `apps/dev-docs` — отдельное Vite/React-приложение (порт 5186, `apps/dev-docs/vite.config.ts:244-246`), читает не markdown, а TS-данные (`protocolDocs.ts`, `productCapabilityMap.ts`, `featureBoundaryGraphSource.ts`) и YAML фича-графа (`.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`); `stdio 抓包`-страница читает `~/.zcode/v2/dev/stdio-traffic` (`vite.config.ts:10-11,194-235`). Документации о самом dev-docs почти нет (только `docs/zcode-stdio-tap-proxy.md:15`).
- **Drift-инвентарь** (подробно в §4 и таблице ниже).

### 3.7. Developer experience

- Bootstrap: `pnpm bootstrap` (`package.json:83`) → `scripts/bootstrap.mjs`: `git submodule update ... apps/zcode-cli` (`:220`, no-op, т.к. `.gitmodules` нет и `apps/zcode-cli` — tree), `pnpm install` (`:235`), `prepare:desktop-runtime` (`:235`), `build:bootstrap` (`:240-244`). `--with-remote` дополнительно собирает пакеты и `stage:remote-assets` (`:209-217`, `:235-244`).
- Dev-серверы: `dev:desktop` → `dev:desktop:prod` (`package.json:11-13`); `dev:runtime` поднимает `tsup --watch` (8 watch-корней), `vite dev` и Electron (`packages/desktop/package.json:17`); Vite-порт 5174 (`packages/desktop/scripts/dev.mjs:89`). `dev:web` — server+web (`package.json:8`), README фиксирует 5173/3030 (`README.md:81`). `dev:docs` — 5186 (`package.json:10`).
- Отладка: `.vscode/launch.json` — attach к main на 9231 с preLaunchTask; `.vscode/start-electron.mjs`, `tsup-watch.mjs`, `vite-dev.mjs`.
- Логи: `createServiceLogger` (`packages/services/src/logger/serviceLogger.ts:19-60`), `debug` включается только в dev (`:24-35`); UI-логгер `packages/ui/src/logger.ts:1-112`.
- stdio tap: Help-меню в dev-сборке, файл `~/.zcode/v2/dev/zcode-stdio-tap.json`, ndjson в `~/.zcode/v2/dev/stdio-traffic/<workspaceHash>/` (`docs/zcode-stdio-tap-proxy.md:1-20`).
- Contribution: **нет** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.github/PULL_REQUEST_TEMPLATE*`, `.github/ISSUE_TEMPLATE`, `CODEOWNERS` (все проверки — отсутствие). PR-шаблон упоминается только для внешнего `zcode-plugins` (`README.md:131`). Правила коммита — только `.husky/commit-msg` (кириллица). PR-описание регламентировано в `AGENTS.md:47`.
- Частые отказы: грязное дерево блокирует `test:unit:affected` (`scripts/affected-unit-tests/scope.mjs:49-50`; OBSERVED exit 2); fmt-гейт красный из-за `.agents` и research; dev-docs падает на feature-графе (§4, G-9); UI-тесты не собираются без `sharp`.

## 4. Gaps, risks, weaknesses

### G-1. Гейта на PR нет; качество держится на локальном pre-push (P0)

**OBSERVED.** Единственный workflow — ручной (`cross-platform-preview-release.yml:7`); шагов тестов нет. `verify:pre-push` (`package.json:51`) исполняется только husky-хуком при локальном `git push`. Формально `docs/testing/github-actions-billing.md` объясняет причину (биллинг), но это означает: любой обход хука (`--no-verify`, GUI-клиент без Node, force-push) публикует непроверенный код, и ни один серверный гейт это не поймает. Документация `docs/desktop-ci-cd.md:3,20` при этом описывает Windows-job с `pnpm lint`/`typecheck`/`test:unit`, которого в дереве нет.

**Риск.** Регрессии в `dev`/`main` не блокируются; нет воспроизводимого «зелёного» статуса для ревью.

### G-2. Корневой сбор тестов не покрывает `.tsx` и 23 колокейтед-теста (P0)

**OBSERVED.** `vitest.config.ts:114-121` — только `.test.ts`; 10 `.test.tsx` в `packages/ui/test` (например `subagentDrilldown.test.tsx`) не собираются (`vitest list --project unit` → 0). 23 `.test.ts` под `src/` (плагин-песочница — 6 файлов `packages/desktop/src/main/pluginSandbox`, 4 `packages/ui/src/plugin-ui/app`, 3 `packages/services/src/plugin-ui-bridge` и т.д.) не входят ни в один include (полный список — `/tmp`-диф, воспроизводимая команда в §8). Итого 33 тестовых файла существуют, но не выполняются корневым раннером.

**Риск.** Ложное чувство покрытия; изменения plugin-sandbox/plugin-ui/GenUI не проверяются вообще.

### G-3. 12 мёртвых include/exclude-путей (P1)

**OBSERVED.** `vitest.config.ts:120-121` — 2 несуществующих файла; `forkIsolatedTests` — 32 уникальные записи, 10 отсутствуют (`r3RemoteProcess`, `e2eSummarySpecCoverage`, `migrateStableFeedScript`, `uploadOssScript`, `notarizeMacosScript`, `publishReleaseScript`, `remoteFrontendBuildSource`, `dev-cua-plugin-runtime`, `builtin-provider-build`, `builtin-provider-test-config-sync`); фактически fork-проект собирает 22 файла. Vitest молча игнорирует несовпавшие пути — это не ошибка конфигурации, а тихая потеря изоляции для переименованных/удалённых тестов.

**Риск.** Переименование теста выключает его из прогона без сигнала; список «serial» больше не соответствует реальности.

### G-4. Полный architecture-check красный, а pre-push смотрит только changed (P0/P1)

**OBSERVED.** Полный `architecture:check` → exit 1: «модуль gen-ui-service缺少 contract.test.ts» (`architecture-policy.yaml:256-259`, `scripts/architecture/index.mjs:88-94`). `--changed` → exit 0, потому что модуль не в диффе. То есть красное состояние может жить в `dev` неограниченно и всплывёт только у того, кто тронет `packages/services/src/gen-ui`.

**Риск.** Архитектурный контракт managed-модулей деградирует; новые модули копируют исключение.

### G-5. `fmt:check` красный и нигде не гейтится (P1)

**OBSERVED.** `pnpm fmt:check` → exit 1, 160 файлов: 30 repo-owned tracked (5 `packages/services/src`, 3 `packages/services/test`, 5 `packages/ui/src`, 4 `packages/ui/test`, 2 `scripts/…`, `docs/specs/skill-marketplace.md`, e2e-спека), 106 в `.agents/skills`, 24 untracked research. Гейт не входит в `verify:pre-push` и CI; AGENTS.md:18 предписывает запускать вручную. Исторические документы фиксируют, что «全仓 fmt:check 未通过» — это норма (`docs/ui/chat-composer-action-menu.md:62`, `docs/testing/conversation-session-e2e-coverage-matrix.md:413`).

**Риск.** Форматирование дрейфует; любой, кто запустит `oxfmt`, получит шумный диф на 100+ файлов; `.agents`-скиллы попадают в проверку, хотя это вендоренный контент.

### G-6. `typecheck` не покрывает CLI и тестовые деревья (P1)

**OBSERVED.** `package.json:69` — 15 проектов, `apps/zcode-cli` отсутствует; CLI имеет свой `typecheck` через Turbo (`apps/zcode-cli/package.json`). `packages/*/tsconfig.json` включают только `src` (`packages/services/tsconfig.json:9`, `packages/shared/tsconfig.json:12`, `packages/web/tsconfig.json:10`, `packages/server/tsconfig.json:8`), поэтому 2603 `packages/*/test/**/*.test.ts` не типизируются; исключение — desktop e2e (`packages/desktop/tsconfig.json:13` → `tsconfig.e2e.json`). В CI typecheck не запускается вообще, а в pre-push — тоже.

**Риск.** Ошибки типов в тестах и CLI обнаруживаются только при ручном запуске (или в релизном скрипте Preview, `scripts/release-macos-preview.mjs:134-137`).

### G-7. Coverage — декоративный скрипт (P2)

**OBSERVED.** `vitest.config.ts:143-146` — только `packages/*/src/**/*.ts`, без `.tsx` (828 `.tsx` в `packages/ui/src`) и без порогов; `test:coverage` не входит ни в один гейт. Заявления о покрытии в документации отсутствуют.

**Риск.** Нет сигнала о регрессе покрытия; UI-код (большая часть продукта) вне метрики даже при ручном запуске.

### G-8. Документация описывает несуществующий CI и удалённые пути (P1)

**OBSERVED.** 19 tracked документов упоминают `.gitlab`; 11 — `scripts/ci/`; 2 — `packages/distillation`. Ключевые примеры — в таблице doc-drift ниже. `check-doc-links` это не ловит, потому что (а) проверяет только markdown-ссылки, (б) `inScope` ограничен `docs/` и корнем, (в) inline-code игнорируется (`scripts/check-doc-links.mjs:1-20,128-133`). Итог: гейт зелёный (2472 ссылки), а «вход CI/CD» в `docs/desktop-ci-cd.md:3` указывает на отсутствующий файл.

**Риск.** Новый инженер идёт по ложной карте; агенты цитируют несуществующие job'ы и пути.

### G-9. dev-docs тесты красные, фича-граф разошёлся (P1/P2)

**OBSERVED.** `pnpm --filter @zcode/dev-docs test` → 1 failed / 3 passed файлов; `apps/dev-docs/test/featureBoundaryGraph.test.ts:114-117` ожидает `nodeCount: 324, edgeCount: 629, unresolvedEndpointCount: 2`, реально приходит `417 / 803 / 2` (YAML 463 315 байт, обновлён 2026-11-05). Это же приложение — единственный внутренний «док-сайт», и его тест-сигнал сейчас красный.

**Риск.** Любое изменение карты способностей ломает тест; при этом сам тест не входит в pre-push, значит расхождение копится.

### G-10. Bump версии расходится между релизными путями (P1)

**OBSERVED.** Локальный релиз меняет только `package.json` (`scripts/release-macos-local/main.mjs:58-88`, проверка `M  package.json`), Preview — `package.json` + `package-lock.json` (`scripts/release-macos-preview.mjs:383-385`, проверка ровно двух файлов). `CHANGELOG.md` отсутствует, хотя `.release-it.mjs:23-33` настроен на него. `apps/zcode-cli` версионируется отдельно (0.17.0) и не синхронизируется с 3.17.102.

**Риск.** «Версия» в трёх носителях (`package.json`, `package-lock.json`, CLI) расходится; релизный артефакт и changelog не воспроизводимы; npm-lock — мёртвый, но релизный контракт на него опирается.

### G-11. Node-pin 24.14.0 против фактического 26.9.0 (P1)

**OBSERVED.** `mise.toml:2` — 24.14.0; CI — 24.14.0; README — 24.14.0; локально — 26.9.0. `ci:assert-node` пропускает 26 (major ≥ 24, `assert-node-version.mjs:95-100`), а release-скрипты требуют точного совпадения (`:65-80`) и падают (проверено). `docs/windows-test-compatibility.md:12` фиксирует результаты на другой базе, что дополнительно расходится с текущей средой.

**Риск.** Локальный релиз требует `mise exec`; расхождение версий Node между разработчиками/CI — источник flaky (в конфиге уже есть комментарии про SIGSEGV на Node 24/macOS, `vitest.config.ts:124-126`, и про Node ≥25 localStorage, `vitest.setup.ts:49-52`).

### G-12. E2E-объём и «pending»-долг (P2)

**OBSERVED.** 575 спек, из них 377 (65.6%) — `manual-review/pending`; дефолтный прогон — 194. Docker-preset'ы «verified» пусты и возвращают exit 2 (`test-desktop-e2e-container.sh:12,14,29-53`). Веса шардов устарели: `spec-duration-weights.json` — 53 записи, `conversation-ci-spec-duration-weights.json` — 77 записей и не читается кодом (только упомянут в `docs/testing/conversation-session-automatic-e2e-ci.md:53`). Локально накоплено 54 МБ artifacts.

**Риск.** Большая часть UI/продуктовых сценариев не в автоматическом контуре; перф-шардирование опирается на исторические веса, а не на текущий набор.

### G-13. DX-онбординг неполон (P2)

**OBSERVED.** Нет `CONTRIBUTING.md`/`SECURITY.md`/`CODEOWNERS`/PR- и issue-шаблонов; нет `docs`-индекса; bootstrap-документ противоречит README по submodule (`docs/bootstrap.md:3,5,10` vs `README.md:33`); единственная точка «что гейтит push» — `docs/testing/pre-push-hook.md`; порядок в этом документе (`:9`) перечисляет только 4 шага из 14.

**Риск.** Новый участник не знает, какие проверки реально обязательны; агенты и люди тратят время на несуществующие шаги.

### G-14. UI-тестовая инфраструктура в этом checkout неработоспособна без доп. зависимостей (P2)

**OBSERVED.** `npx vitest list` в `packages/ui` падает на `sharp` (`packages/ui/test/browser/manual-review/pending/lucide-opacity.test.mjs:12`) и ENOENT `packages/ui/src/v4/SessionPane.tsx`; при этом у `packages/ui` нет `test`-скрипта. 37 `.test.mjs` в `test/browser` — node:test+playwright-core, но `playwright-core` объявлен только в `packages/desktop/package.json:84`, не в UI. Формального раннера/скрипта для `test/browser` нет (grep по package.json — 0).

**Риск.** Браузерные UI-кандидаты не запускаются ни из корня, ни из пакета; зависимость «висит» транзитивно.

### 4.1. Doc-drift inventory (file:line)

| Документ:строка | Утверждение | Реальность (evidence) | Тип |
|---|---|---|---|
| `docs/desktop-ci-cd.md:3` | вход CI/CD — `.gitlab-ci.yml`, job'ы в `.gitlab/ci/*.yml` | `.gitlab-ci.yml`/`.gitlab/` отсутствуют (`ls` → No such file); единственный workflow — `.github/workflows/cross-platform-preview-release.yml` | stale |
| `docs/desktop-ci-cd.md:7-14` | перечислены `00-workflow.yml`…`preview-child.yml` | ни одного файла нет; `find .gitlab` → пусто | stale |
| `docs/desktop-ci-cd.md:16` | ссылка на `remote-v4-static-deployment.md` «(已删除)» | файла нет (`ls docs/web-remote-control/remote-v4-static-deployment.md` → No such file) | stale (inline-code, гейт не ловит) |
| `docs/desktop-ci-cd.md:20` | Windows job запускает `pnpm lint/typecheck/test:unit` | в workflow нет шагов test/lint/typecheck | stale |
| `docs/desktop-ci-cd.md:24-25,37-38` | «шесть платформ» в validate/approve | workflow строит 3 цели (`:29-45`); 6 платформ — наследие удалённого GitLab | stale |
| `docs/desktop-ci-cd.md:187,244` | runner-теги/переменные из `.gitlab/ci/20-test.yml`, `.gitlab-ci.yml` | файлов нет | stale |
| `docs/ci-cache-strategy.md:1-4,24,54-57,63` | GitLab Cache, `.gitlab/ci/*`, `scripts/ci/ci-lint-pipeline.mjs` | каталогов `.gitlab` и `scripts/ci` нет; стратегия не применяется | stale (исторический spec) |
| `docs/product-capability-map-engineering-infrastructure.md:11` | Primary seeds: `.gitlab/ci/*.yml`, `packages/distillation`, `scripts/ci` | все три отсутствуют | stale |
| `docs/product-capability-map-engineering-infrastructure.md:33,35,43-46,63,71` | GitLab pipeline/DAG, `packages/distillation`, `scripts/ci/push-e2e-*.mjs` | отсутствуют | stale |
| `docs/testing/conversation-session-automatic-e2e-ci.md:25-26,127,140,147` | GitLab MR pipeline, `parallel`, job artifact | GitLab нет; CI-конфига нет | stale |
| `docs/testing/conversation-session-automatic-e2e-ci.md:51-53` | веса `conversation-ci-spec-duration-weights.json` для 4 job'ов | файл существует (77 записей), но код его не читает; runner читает `spec-duration-weights.json` (53 записи, `run-windows-e2e-shards.mjs:15`) | drift |
| `docs/testing/e2e-failure-artifact-report-upload.md:35,58` | `scripts/ci/push-e2e-report-to-feedback.mjs`, `scripts/ci/run-e2e-bitable-loop.ps1` | `scripts/ci` отсутствует | stale |
| `docs/monitoring/process-resource-telemetry.md:508-511,749` | guard в `scripts/ci/ci-telemetry-keyword-guard.mjs`, подключён к `pnpm test:unit` | файла нет; include `vitest.config.ts:121` мёртв | stale |
| `docs/desktop/zcode-preview-packaging.md:10,52,214` | code owners/CI: `.gitlab/ci/30-build.yml`, `00-workflow.yml`, `preview-child.yml` | файлов нет | stale |
| `docs/web-remote-control/web-remote-control-architecture.md:56,85,93,95,328` | ссылки на удалённый `remote-v4-static-deployment.md` | файла нет; ссылки в inline-code, гейт не ловит | stale |
| `docs/bootstrap.md:3,5,10` | bootstrap «сначала тянет submodule `apps/zcode-cli`» | `.gitmodules` нет; `apps/zcode-cli` — tree в HEAD; `git submodule update` — no-op; README прямо отрицает submodule (`README.md:33`) | contradiction |
| `README.md:18-21`, `README.en.md:18-21` | «Updated to v3.16.2» | `package.json:3` = `3.17.102` | drift |
| `docs/testing/unit-test-quality.md:375` | «3585 записей, пути без дублей и пропусков» | в `docs/testing/unit-test-review/` осталось 326 строк в 7 jsonl; 6 файлов ledger'а помечены «已删除» (`:363-370`) | inconsistent (историческое утверждение) |
| `docs/testing/unit-test-quality.md:234-235` | удалённые тесты `capabilityMapCurrentFeatures.test.ts`, `capabilityMapOfficeComputerUse.test.ts` | файлов нет — это раздел «删除文件的位置记录如下，不作为当前文件链接» (`:232`), т.е. помечено корректно | проверено, не drift |
| `docs/testing/desktop-e2e-runtime-performance.md:6,27` | перф-вход фиксирует `--shards=10` | `packages/desktop/package.json:40` — так и есть | проверено, ок |
| `docs/specs/cross-platform-preview-release.md:1-7` | 3 платформы, manual-only, ad-hoc macOS | совпадает с workflow (`:29-45`, `:56,130`); §5 strengths | проверено, ок |

## 5. Strengths and differentiators

- **Двухуровневая изоляция тестов.** `unit` (threads, maxWorkers 4) + `fork-isolated` (forks, строго 1 воркер) с подробной мотивацией каждого файла и фиксированными 30-секундными таймаутами (`vitest.config.ts:11-58,101-139`). Это редкая для монорепо зрелость: реальные процессы и `fs.watch` не смешиваются с быстрыми тестами.
- **Единый локальный гейт из 14 шагов.** `verify:pre-push` покрывает lint, privacy (17 982 файла, включая push-range blob'ы), schema-контракт SQLite, архитектуру, affected-тесты, knip, release-контракт, benchmark делегирования (`package.json:51`). Все 14 шагов существуют и запускаются, а не декларируются.
- **Affected-тесты на официальном API Vitest.** `scripts/run-affected-unit-tests.mjs:1-120` использует `getRelevantTestSpecifications`/`globTestSpecifications`, а не самописный граф; полный выбор корректно пропускает UT с exit 0 (`:98-103`), грязное дерево — exit 2 (`scripts/affected-unit-tests/scope.mjs:49-50`). Семантика exit-кодов задокументирована.
- **Privacy-гейт по индексу и push-range.** `scripts/check-tracked-privacy.mjs:1-40` сканирует index+HEAD+blob'ы push'а, не печатает значения, имеет точечный allowlist — заметно строже типичных «grep по рабочему дереву».
- **Архитектура как исполняемая политика.** `architecture-policy.yaml` (48 КБ, 51 managed-модуль), `architecture:context`/`adopt`/`baseline`, contract-артефакты (`scripts/architecture/index.mjs:85-115`). Это дифференциатор: правила слоёв/циклов/размеров проверяются, а не живут в вики.
- **E2E-инфраструктура промышленного масштаба.** 575 спек, 908 фикстур, 405 case-манифестов, replay/capture-провайдеры, LPT-шардирование по весам, `summary.json`/видео/логи по кейсам (`docs/testing/e2e-failure-artifact-report-upload.md:1-35`), Docker-образ и admission-скрипты. Мало кто в OSS-агентах имеет такой объём воспроизводимых E2E.
- **Честная фиксация Windows-совместимости.** `docs/windows-test-compatibility.md` перечисляет 8 корневых причин и правила (CRLF, GNU tar, exec-бит, EPERM, named pipes) — это готовая база знаний, а не «магия в setup».
- **Release-safety.** Preview-скрипт вычищает Apple/GH-креды, отключает auto-update, требует точный tag/commit, идемпотентно обновляет prerelease и отказывается трогать stable (`scripts/release-macos-preview.mjs:37-72`, workflow `:188-209`); macOS local-release проверяет `write-tree` и неизменность дерева (`release-macos-local/main.mjs:75-88`).
- **Явный design-system и доменный глоссарий.** `DESIGN.md` (655 строк, обязательный `text-ui-*`) и `CONTEXT.md` (89 строк, Plugin Store vocabulary) дают агентам и людям единый язык.

## 6. Candidate recommendations

Формат: проблема/разрыв → доказательство → решение → рамки → эффект → риски → сложность → приоритет → приёмка → проверка.

### R-1. Ввести серверный checks-job (PR + push) или явно закрепить «local-only gate»

- **Проблема:** нет PR CI; качество зависит от локального хука (G-1).
- **ZCode evidence:** `.github/workflows/cross-platform-preview-release.yml:7` (только `workflow_dispatch`); `package.json:51`; `docs/testing/github-actions-billing.md:1-40`.
- **Решение:** добавить job `checks` на `pull_request`/`push` в существующий workflow (lint + `typecheck` + `architecture:check --changed` + affected UT), с `permissions: contents: read` и кэшем pnpm; параллельно починить `docs/desktop-ci-cd.md`. Если биллинг блокирует — зафиксировать статус «local gates only» в `docs/testing/` и убрать GitLab-описание.
- **Scope:** `.github/workflows/`, `docs/desktop-ci-cd.md`, `docs/testing/`. **Out of scope:** восстановление GitLab-инфраструктуры.
- **Ожидаемый эффект:** любой PR получает воспроизводимый статус; обход `--no-verify` ловится.
- **Риски:** стоимость runner-минут; ложные красные из-за fmt/arch (сначала R-4, R-5).
- **Сложность:** M. **Приоритет:** P0.
- **Приёмка:** PR с заведомо падающим тестом краснеет; PR с зелёным — зелёный; `checks` виден в branch protection.
- **Проверка:** тестовый PR; `gh run view --json jobs`.

### R-2. Починить корневой сбор тестов: `.tsx`, колокейтед-тесты, мёртвые пути

- **Проблема:** 33 файла не исполняются; 12 путей мертвы (G-2, G-3).
- **ZCode evidence:** `vitest.config.ts:114-123`; `knip.json:5-8`; список отсутствующих — §8.
- **Решение:** добавить `packages/*/test/**/*.test.{ts,tsx}` и `packages/*/src/**/*.test.{ts,tsx}` (или точечные каталоги plugin-sandbox/plugin-ui/gen-ui), удалить 10 мёртвых fork-записей и 2 мёртвых include, добавить тест-инвариант «каждый include-путь существует».
- **Scope:** `vitest.config.ts`, `knip.json`, тестовые пути. **Out of scope:** переписывание самих тестов.
- **Ожидаемый эффект:** +33 файла в контуре; переименования не теряют тесты молча.
- **Риски:** новые падения (возможно, файлы были исключены осознанно) — сначала прогнать точечно.
- **Сложность:** S–M. **Приоритет:** P0.
- **Приёмка:** `vitest list` содержит все `.test.tsx` и 23 src-теста; fork-проект = 22 файла ровно; нет include-путей без файлов.
- **Проверка:** `pnpm exec vitest list --project unit | grep -c '\.test\.tsx'` > 0; node-скрипт проверки существования путей.

### R-3. Закрыть архитектурный долг gen-ui-service и включить полный check в гейт

- **Проблема:** полное дерево красное; `--changed` маскирует (G-4).
- **ZCode evidence:** `architecture-policy.yaml:256-259`; `scripts/architecture/index.mjs:88-94`; вывод `architecture: FAILED … gen-ui`.
- **Решение:** добавить `packages/services/src/gen-ui/contract.test.ts` (или понизить модуль до legacy с явным решением), затем добавить полный `architecture:check` в CI-джобу (не в pre-push — дорого).
- **Scope:** `packages/services/src/gen-ui/`, `architecture-policy.yaml`, workflow. **Out of scope:** рефакторинг gen-ui.
- **Ожидаемый эффект:** полный architecture-check зелёный и обязательный.
- **Риски:** контрактный тест может вскрыть реальные нарушения.
- **Сложность:** S. **Приоритет:** P0.
- **Приёмка:** `node scripts/architecture/architecture-check.mjs check` → exit 0; CI-джоба краснеет при удалении артефакта.
- **Проверка:** команда + негативный тест.

### R-4. Сделать `fmt:check` пригодным и подключить к гейту

- **Проблема:** 160 файлов дрейфа, гейт не запускается (G-5).
- **ZCode evidence:** `.oxfmtrc.json:1-29` (нет ignore для `.agents/**` и `docs/research/**`); `package.json:72`; вывод `fmt:check` exit 1.
- **Решение:** `oxfmt` один раз по 30 repo-owned файлам; добавить в `.oxfmtrc.json` `ignorePatterns` для `.agents/**` (вендоренные скиллы) и `docs/research/**` (генеративные заметки); затем добавить `fmt:check` в CI-джобу (или pre-push как шаг 3a).
- **Scope:** `.oxfmtrc.json`, 30 файлов, workflow. **Out of scope:** форматирование `.agents` и research.
- **Ожидаемый эффект:** гейт зелёный и быстрый (~10 с на 9 656 файлов — замерено).
- **Риски:** массовый диф; делать отдельным коммитом «format only».
- **Сложность:** S. **Приоритет:** P1.
- **Приёмка:** `pnpm fmt:check` exit 0; новый PR с неформатированным файлом краснеет.
- **Проверка:** команда до/после + негативный PR.

### R-5. Включить typecheck в CI и расширить на CLI/тесты

- **Проблема:** typecheck не входит ни в один автоматический гейт; CLI и 2603 теста не типизируются (G-6).
- **ZCode evidence:** `package.json:69`; `packages/services/tsconfig.json:9`; `apps/zcode-cli/package.json` (`typecheck` через Turbo).
- **Решение:** CI-джоба `pnpm typecheck` + `pnpm --filter zcode-cli typecheck`; добавить в pre-push хотя бы корневой typecheck (измерить время, возможно, только для изменённых пакетов через `tsc -b`).
- **Scope:** workflow, `package.json`, tsconfig-ы тестов. **Out of scope:** включение всех тестов в build-граф.
- **Ожидаемый эффект:** ошибки типов ловятся до релиза, а не в Preview-скрипте.
- **Риски:** десятки существующих ошибок в тестах всплывут сразу — нужен поэтапный allowlist.
- **Сложность:** M. **Приоритет:** P1.
- **Приёмка:** CI-джоба запускает typecheck; на сломанном типе краснеет.
- **Проверка:** `pnpm typecheck` + негативная правка.

### R-6. Привести документацию к реальности и восстановить навигацию

- **Проблема:** 19 документов описывают GitLab/`scripts/ci`, README отстаёт, bootstrap противоречит README, индекса нет (G-8, G-13).
- **ZCode evidence:** `docs/desktop-ci-cd.md:3,7-14,16,20,187,244`; `docs/ci-cache-strategy.md:24,54-57,63`; `docs/product-capability-map-engineering-infrastructure.md:11,33-46,63,71`; `docs/testing/conversation-session-automatic-e2e-ci.md:25-26,51,127,140,147`; `docs/testing/e2e-failure-artifact-report-upload.md:35,58`; `docs/monitoring/process-resource-telemetry.md:508-511,749`; `docs/desktop/zcode-preview-packaging.md:10,52,214`; `docs/bootstrap.md:3,5,10`; `README.md:18-21`; `README.en.md:18-21`.
- **Решение:** переписать `docs/desktop-ci-cd.md` под фактический GitHub workflow; пометить `ci-cache-strategy.md` как исторический; удалить/архивировать GitLab-ссылки в актуальных документах; исправить bootstrap-док (никакого submodule); обновить блок версий; добавить `docs/README.md` с картой 48 каталогов и правилом «spec живёт в `docs/specs`».
- **Scope:** перечисленные документы + новый индекс. **Out of scope:** ревизия `docs/electron`, `docs/webdriverio`, `docs/vendor`, `docs/archive`.
- **Ожидаемый эффект:** новый инженер находит актуальный вход; агенты не цитируют мёртвые пути.
- **Риски:** большой объём правок; нужна проверка ссылок.
- **Сложность:** M. **Приоритет:** P1.
- **Приёмка:** `rg -n '\.gitlab|scripts/ci/' docs --glob '!docs/research/**' --glob '!docs/archive/**' --glob '!docs/superpowers/**' --glob '!docs/working-memory/**'` → только исторические пометки; `pnpm verify:links` зелёный; README-версия = `package.json`.
- **Проверка:** команды + ревью диффа.

### R-7. Синхронизировать версионные носители и changelog

- **Проблема:** локальный релиз не обновляет `package-lock.json`; CHANGELOG-конфиг без файла; CLI-версия отдельная (G-10).
- **ZCode evidence:** `scripts/release-macos-local/main.mjs:58-88`; `scripts/release-macos-preview.mjs:383-385,156-161`; `.release-it.mjs:23-33`; `git ls-files CHANGELOG.md` → 0.
- **Решение:** либо обновлять `package-lock.json` в локальном релизе (как Preview), либо удалить npm-lock как носитель и проверять `pnpm-lock`; генерировать `CHANGELOG.md` на релизе и коммитить; описать правило версии CLI в `docs/specs/cross-platform-preview-release.md`.
- **Scope:** release-скрипты, `.release-it.mjs`, docs. **Out of scope:** пересмотр схемы версионирования продукта.
- **Ожидаемый эффект:** один источник истины версии; релиз воспроизводим.
- **Риски:** конфликт с текущим контрактом «только package.json» в локальном релизе — согласовать.
- **Сложность:** S–M. **Приоритет:** P1.
- **Приёмка:** после пробного bump все носители совпадают; `CHANGELOG.md` существует и обновлён.
- **Проверка:** dry-run bump в temp-worktree; `node -p` по трём файлам.

### R-8. Устранить расхождение Node и зафиксировать политику версий

- **Проблема:** пин 24.14.0 vs фактические 26.9.0; разные проверки в `ci:assert-node` и release (G-11).
- **ZCode evidence:** `mise.toml:2`; `README.md:25`; workflow `:56,130`; `scripts/assert-node-version.mjs:65-80,95-100`.
- **Решение:** решить, какая версия поддерживается (24 LTS), привести `engines`/`mise`/CI/README к ней; в dev-скриптах и pre-push добавить warning при major-расхождении; release-проверку оставить строгой.
- **Scope:** `mise.toml`, `package.json:134-136`, README, workflow, `scripts/assert-node-version.mjs`. **Out of scope:** миграция на Node 26.
- **Ожидаемый эффект:** одинаковое поведение локально/CI; релиз не блокируется неожиданно.
- **Риски:** Node 26 уже используется локально — возможно, тесты завязаны на него.
- **Сложность:** S. **Приоритет:** P1.
- **Приёмка:** `pnpm ci:assert-node` и release-assert согласованы; README/mise/CI совпадают.
- **Проверка:** прогон обеих проверок на 24 и 26.

### R-9. Починить dev-docs тест и закрепить фича-граф

- **Проблема:** 1/4 файлов падает; граф разошёлся (G-9).
- **ZCode evidence:** `apps/dev-docs/test/featureBoundaryGraph.test.ts:114-117`; YAML 463 315 байт.
- **Решение:** обновить ожидаемые counts (или убрать хардкод, проверяя инварианты: все endpoints разрешены, счётчики > 0, стабильность относительно входного YAML), включить dev-docs тесты в CI.
- **Scope:** `apps/dev-docs/test/`, workflow. **Out of scope:** изменение самого графа.
- **Ожидаемый эффект:** зелёный dev-docs; тест перестаёт быть хрупким.
- **Риски:** потеря «защиты от дрейфа» — заменить на проверку структуры.
- **Сложность:** S. **Приоритет:** P2.
- **Приёмка:** `pnpm --filter @zcode/dev-docs test` exit 0.
- **Проверка:** команда.

### R-10. Навести порядок в UI-тестах и E2E-долге

- **Проблема:** UI-тесты не собираются, browser-раннер не объявлен, 377 pending, пустые verified-пресеты, устаревшие веса (G-12, G-14).
- **ZCode evidence:** `packages/ui/package.json:21-24`; `packages/ui/test/browser/manual-review/pending/lucide-opacity.test.mjs:12`; `packages/desktop/package.json:84`; `scripts/test-desktop-e2e-container.sh:12,14`; `packages/desktop/scripts/run-windows-e2e-shards.mjs:15`; `docs/testing/conversation-session-automatic-e2e-ci.md:53`.
- **Решение:** добавить `packages/ui` `test`-скрипт с `jsdom` и явными зависимостями (`sharp`, `playwright-core` — в UI или в общий dev-root); вынести `test/browser` в отдельный скрипт; удалить/пометить неиспользуемый профиль весов; пересчитать веса из последнего успешного прогона.
- **Scope:** `packages/ui/package.json`, `vitest.config.ts`, runner-скрипты, docs. **Out of scope:** массовый перевод pending в formal.
- **Ожидаемый эффект:** UI-тесты запускаются; E2E-шардирование опирается на актуальные данные.
- **Риски:** новые падения UI-тестов; объём.
- **Сложность:** M–L. **Приоритет:** P2.
- **Приёмка:** `pnpm --filter @zcode/ui test` собирает и проходит; `pnpm test:e2e --dry-run`-манифест содержит актуальные веса.
- **Проверка:** локальные прогоны + сверка manifest.

## 7. Open questions and unverified

1. **UNKNOWN.** Есть ли внешний (не в checkout) GitLab/Jenkins-пайплайн, который реально гоняет Windows lint/typecheck/unit. В дереве конфигов нет; `docs/desktop-ci-cd.md` описывает его как действующий. Нужен доступ к настройкам проекта/раннерам.
2. **UNKNOWN.** Куда делись 10 тестов из `forkIsolatedTests` (`r3RemoteProcess`, `uploadOssScript`, `notarizeMacosScript`, `publishReleaseScript`, `e2eSummarySpecCoverage`, `migrateStableFeedScript`, `remoteFrontendBuildSource`, `dev-cua-plugin-runtime`, `builtin-provider-build`, `builtin-provider-test-config-sync`): удалены, переименованы или никогда не были импортированы? В текущем дереве файлов с такими именами нет (`find` → пусто).
3. **UNKNOWN.** Почему `vitest list --project unit` даёт 2064 уникальных файла, а `globTestSpecifications` — 2066 спецификаций project `unit`. Вероятно, два файла попадают в два проекта или дублируются по moduleId; требует отладки, не влияет на вывод о покрытии.
4. **UNKNOWN.** Почему `vitest list --project unit <windowsInstallerNshSmoke>` на darwin возвращает `[]`, хотя spec включён в glob. `describe.skipIf` в Vitest 4 может не регистрировать suite; нужно проверить на Windows-раннере.
5. **UNKNOWN.** Реально ли `pnpm --filter zcode-cli test` проходит на текущем HEAD: не запускался (913 файлов, Turbo + build-зависимость, запрет на тяжёлые прогоны). Аналогично не запускались ни один E2E-спек и полный `pnpm test`.
6. **UNKNOWN.** Воспроизводится ли `pnpm test:unit` (полный) без падений/flaky на этой машине. Запуск запрещён; конфиг содержит длинный список исторически flaky-файлов (`vitest.config.ts:11-58`), что подтверждает существование проблемы, но не её текущий масштаб.
7. **UNKNOWN.** Где генерируются `latest.yml`/`latest-mac.yml`/`release-meta-*.json`: в репозитории скриптов нет (grep → 0); предположительно серверный release API/инфраструктура (`docs/desktop-ci-cd.md:26-29`), но подтвердить нечем.
8. **UNKNOWN.** Кто владеет `CHANGELOG.md`: конфиг release-it есть, файла нет; неизвестно, генерируется ли он вне репозитория при `pnpm release`.
9. **UNKNOWN.** `.test.tsx` в `packages/ui/test` были исключены намеренно (jsdom-окружение/скорость) или это регрессия конфига. Ни комментария, ни issue в дереве нет.
10. **UNKNOWN.** Статус `apps/dev-docs/test` в CI: тест красный локально, но нигде не подключён; возможно, он проходит только при определённой версии YAML — требует прогона на другой базе.

## 8. Evidence appendix

### 8.1. Команды и результаты (OBSERVED)

| # | Команда | Результат |
|---|---|---|
| 1 | `git status --short`; `git branch --show-current`; `git log -1 --oneline` | `?? docs/research/`; `dev`; `d10f0b69 Выпустить macOS Preview 3.17.102.` |
| 2 | `node --version`; `pnpm --version` | `v26.9.0`; `10.33.2` |
| 3 | `node scripts/check-workspace-freshness.mjs --no-fetch` | exit 0: `dev`, ahead 344 / behind 0 (порог 50) |
| 4 | `pnpm exec oxlint` | exit 0: 95 warnings, 0 errors, 6856 файлов |
| 5 | `pnpm lint` | exit 0; хвост: `CLI lint: 0 errors, 86 warnings, 7 pristine upstream line-count diagnostics` |
| 6 | `pnpm typecheck` | exit 0 |
| 7 | `pnpm exec oxfmt --check` / `pnpm fmt:check` | exit 1: «Format issues found in above 160 files» (30 tracked repo-owned, 106 `.agents`, 24 untracked) |
| 8 | `node scripts/architecture/architecture-check.mjs check` | exit 1: `missing-module-artifact packages/services/src/gen-ui: 模块 gen-ui-service 缺少 contract.test.ts` |
| 9 | `node scripts/architecture/architecture-check.mjs check --changed` | exit 0: base `merge-base upstream origin/dev`, violations 0 |
| 10 | `pnpm test:architecture` | exit 0: 36 tests, 36 pass |
| 11 | `node scripts/check-tracked-privacy.mjs` | exit 0: 17 982 файла, совпадений нет |
| 12 | `pnpm db:schema:check` | exit 0: оба schema baseline совместимы |
| 13 | `node scripts/knip-baseline.mjs` | exit 0: current=3174, baseline=3174, new=0 |
| 14 | `node scripts/check-doc-links.mjs` | exit 0: 1693 файла, 2472 ссылки |
| 15 | `node --test scripts/check-doc-links.test.mjs` | exit 0: 6 pass |
| 16 | `node --test scripts/test/cross-platform-preview-release.test.mjs` | exit 0: 1 pass |
| 17 | `pnpm test:unit:affected --scope push --dry-run` | exit 2: «Push 工作区不干净» (untracked `docs/research/`) |
| 18 | `pnpm test:unit:affected --files packages/ui/src/logger.ts --dry-run` | exit 0: выбрано 546/2089 |
| 19 | `node scripts/prism10-runtime-profile.mjs --check` | exit 0 |
| 20 | `pnpm test:knip-baseline`, `test:brainstorming-companion`, `test:self-improve-pr`, `test:delegation-routing-benchmark`, `test:release:macos`, `test:prism10-experiment-gate` | все exit 0 |
| 21 | `pnpm exec vitest list --project unit` | 2064 уникальных `.test.ts`, 19 889 кейсов, 0 `.test.tsx` |
| 22 | `pnpm exec vitest list --project fork-isolated` | 22 файла, 506 кейсов |
| 23 | `pnpm exec vitest list --project cua-placeholder` | 1 файл, 2 кейса |
| 24 | `globTestSpecifications` (Vitest API) | 2089 спецификаций: unit 2066, fork 22, cua 1 |
| 25 | `find packages -name '*.test.ts' -not -path '*/node_modules/*'` | 2688 всего; E2E 575; non-E2E 2113 |
| 26 | `find packages/desktop/test/e2e -name '*.test.ts'` | 575; `manual-review/pending` 377; formal 198; дефолтный formal 194 |
| 27 | `find packages -name '*.test.tsx'` | 10, все в `packages/ui/test`; все не собираются |
| 28 | `find apps/zcode-cli -name '*.test.ts'`; grep node:test/vitest | 913 файлов; 65 node:test, 843 vitest |
| 29 | `find scripts/test -name '*.test.mjs'` | 36 в `scripts/test` (+ прочие); 19 подключены, 17 — нет |
| 30 | `npx vitest list` в `packages/ui` | падает: `Cannot find package 'sharp'`, ENOENT `packages/ui/src/v4/SessionPane.tsx` |
| 31 | `pnpm --filter @zcode/dev-docs test` | exit 1: 1 failed / 3 passed файлов; `featureBoundaryGraph.test.ts:114` ожидает 324/629, получено 417/803 |
| 32 | `bash scripts/test-desktop-e2e-container.sh conversation-session-verified` | exit 2: preset пуст |
| 33 | `git submodule update --init --recursive apps/zcode-cli` | exit 0 (no-op); `.gitmodules` отсутствует |
| 34 | `assertPinnedNodeVersionFromMise()` (node) | throw: `Версия Node 26...`; `pnpm ci:assert-node` → OK |
| 35 | `pnpm -s dep:refs --list-exports packages/ui/src/logger.ts` | exit 0: 4 экспорта |
| 36 | `ls docs/README.md docs/index.md` | No such file (оба) |
| 37 | `git ls-files 'docs/*.md' 'docs/**/*.md'` | 2088 unique; все tracked md 2879; в корне 9 |
| 38 | `rg -l '\.gitlab' docs` | 19 файлов; `scripts/ci/` — 11; `packages/distillation` — 2 |
| 39 | `find docs -name '*.md'`; `du -sh docs` | 2112 (24 untracked); 68 МБ; ~424 708 строк |
| 40 | `.github/workflows` | 1 файл; других CI-конфигов нет |

### 8.2. Точные пути, на которые опираются выводы

- Конфиги тестов: `<repo-root>/vitest.config.ts`, `vitest.setup.ts`, `packages/*/vitest.config.ts`, `apps/zcode-cli/vitest.config.ts`, `apps/dev-docs/vitest.config.ts`.
- E2E: `<repo-root>/packages/desktop/wdio.conf.ts`, `packages/desktop/scripts/run-windows-e2e-shards.mjs`, `packages/desktop/scripts/run-all-e2e-coverage.mjs`, `packages/desktop/scripts/e2e-formal-spec-selection.mjs`, `scripts/test-desktop-e2e-container.sh`, `Dockerfile.desktop-e2e`.
- Гейты: `<repo-root>/package.json`, `scripts/run-affected-unit-tests.mjs`, `scripts/affected-unit-tests/scope.mjs`, `scripts/architecture/*.mjs`, `architecture-policy.yaml`, `scripts/check-doc-links.mjs`, `scripts/check-tracked-privacy.mjs`, `scripts/knip-baseline.mjs`, `scripts/run-cli-lint.mjs`, `.oxlintrc.json`, `.oxfmtrc.json`, `knip.json`.
- CI/release: `<repo-root>/.github/workflows/cross-platform-preview-release.yml`, `.husky/pre-push`, `.husky/commit-msg`, `scripts/release-macos-local/*.mjs`, `scripts/release-macos-preview.mjs`, `scripts/macos-release-security.mjs`, `.release-it.mjs`, `packages/desktop/electron-builder.config.js`, `packages/desktop/src/main/autoUpdater.ts`.
- Docs/DX: `<repo-root>/docs/desktop-ci-cd.md`, `docs/ci-cache-strategy.md`, `docs/product-capability-map-engineering-infrastructure.md`, `docs/bootstrap.md`, `docs/testing/*.md`, `docs/specs/*.md`, `README.md`, `README.en.md`, `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, `apps/dev-docs/*`.

### 8.3. Coverage status

- **Покрыто:** test architecture (root + 9 пакетных конфигов), сбор/недобор тестов, E2E-структура и объёмы, coverage-конфиг, все локальные гейты и их фактические прогоны, CI-workflow, release-скрипты и signing, мультиплатформенные ветки, docs-инвентарь и drift, DX-входы, шаблоны/CODEOWNERS.
- **Не проверено (not checked):** полный `pnpm test`; ни один Desktop E2E-спек; полный `pnpm --filter zcode-cli test`; внешний CI вне checkout; фактическая генерация `latest.yml`/`CHANGELOG`; работа `pnpm release` (создал бы коммит/тег — запрещено); установка/запуск Electron-приложения; Windows/Linux-прогоны (только darwin-хост); содержимое `docs/electron|webdriverio|vendor` (зеркала upstream, вне гейта).
- **Только один файл записан:** `<repo-root>/docs/research/partials/2026-11-11-zcode-14-testing-ci-docs-dx.md`. Продукционный код, конфиги, тесты и git-состояние не изменялись; `git status --short` остаётся `?? docs/research/`.
- **Неизвестное vs подтверждённое:** все пункты §4 помечены OBSERVED-доказательствами; INFERRED отдельно указаны (генерация feed, намеренность исключения `.tsx`); UNKNOWN собраны в §7.
