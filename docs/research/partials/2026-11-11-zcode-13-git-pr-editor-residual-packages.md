# Z13 — Git/PR, IDE/editor surfaces и residual packages

Дата исследования: 2026-11-11. Ветка: `dev`. Коммит: `d10f0b69` («Выпустить macOS Preview 3.17.102.»).

## 1. Scope and method

### 1.1 Preflight (наблюдаемые результаты)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

Рабочее дерево содержало только незакоммиченный каталог `docs/research/` (создан другими ветками исследования). Ветка не переключалась, production-файлы не изменялись.

### 1.2 Метод

- `CodeIndex status` → `ready`, без partial, 10007 файлов / 278154 символов (проверено в начале работы).
- Адресные `CodeIndex search` по темам «git», «pull request», затем переход к первоисточникам через `Glob`/`Grep`/`Read` (широкий поиск по индексу для этих тем оказался нерелевантным: выдавал описания capability-map, fixtures и skill-скрипты).
- Все утверждения ниже помечены **Observed** (подтверждено файлом/командой), **Inferred** (вывод из наблюдаемого, не проверен исполнением) или **Unknown**.
- Исполнялись только узкие unit-тесты (без полного набора, без E2E и без сборок). Запуски зафиксированы в §8.
- Границы: темы 16 (Git/PR), 17 (IDE/editor) и все пакеты, не покрытые Z01–Z12. Вне scope: Desktop UI-архитектура целиком, Web/Server как таковые, CLI tool-loop, provider/session (см. соответствующие partials).

### 1.3 Терминология reachability

- **production** — код/артефакт входит в поставляемый продукт или обязательный release-процесс.
- **dev-tooling** — запускается только разработчиком/CI, не попадает к пользователю.
- **test-only** — импортируется только тестами.
- **orphan** — нет ни одного потребителя в репозитории и нет build/CI-входа.

## 2. Coverage table

### 2.1 Темы 16–17

| Подтема | Где искать | Статус | Ключевой первоисточник |
| --- | --- | --- | --- |
| Git status/diff | `packages/services/src/git` | Реализовано | `gitCliRepo.ts:855-918`, `:1252-1369`; `gitCliHelpers.ts:244-359`, `:585-658` |
| Stage/unstage/discard | `gitService`/`gitCliRepo` | Реализовано на сервисе, **не достижимо из UI** | `gitService.ts:242-252`; `gitCliRepo.ts:1423-1487` |
| Commit / commit+push | `GitActionMenu` | Реализовано | `GitActionMenu.tsx:1107-1244`; `gitCliRepo.ts:1488-1636`, `:1638-1673` |
| Генерация commit message | `gitCommitMessageGenerator` | Реализовано (LLM) | `gitCommitMessageGenerator.ts:57-173` |
| Ветки (switch/create) | `useGitBranchSwitcher` | Реализовано | `gitCliRepo.ts:1071-1250`; `useGitBranchSwitcher.ts:252-356` |
| Git graph | `git-graph` | Реализовано, read-only | `GitGraphDialog.tsx:26`; `gitCliRepo.ts:1009-1069` |
| Worktrees | workflow schema vs runtime | **Не реализовано** | `contracts/src/workflow/script.ts:42-49`; `bootstrap/src/app/script-workflow-runtime.ts:282-284` |
| Конфликты | status + branch guard + checkpoint | Частично (детекция, без resolver) | `gitCliHelpers.ts:244-355`; `gitCliRepo.ts:1105-1125`; `shared/git.ts:260-264` |
| Blame/history | — | **Отсутствует** | `grep` по `"blame"` в `packages/services/src` — 0 совпадений |
| Revert/undo | — | **Отсутствует в Git-домене** | `grep` `"revert"`/`"stash"`/`"merge"` в `packages/services/src/git` — 0 |
| Checkpoints | `gitCheckpoint*` | Реализовано на сервисе, UI нет | `gitCheckpointService.ts:63-110`; `gitCheckpointRepo.ts:255-493` |
| Safe destructive guards | path containment/timeouts | Частично | `gitCliHelpers.ts:683-717`; `config.ts:4-14` |
| Credentials | — | **Нет собственной обработки** | `config.ts:34-77` (только очистка local env) |
| Git hooks | `.husky/*` (репозиторий), не продукт | Только учёт длинного pre-push | `config.ts:5-11`; `gitCliRepo.ts:1650-1662` |
| PR creation / review comments / CI ingestion | — | **Отсутствует** | `grep` `gh pr create` = 0; `gh` только в read-only allowlist Bash |
| Diff UX | `GitPane`, `@pierre/diffs` | Реализовано (unified, lazy, virtualized) | `GitPane.tsx:43-546`; `GitPaneChangeCard.tsx:1-226` |
| Apply/reject hunks | — | **Отсутствует** | `grep` `applyHunk`/`reject` в `packages/ui/src` — 0 |
| Embedded editor (Monaco/CodeMirror) | — | **Отсутствует** | `packages/ui/package.json` — нет зависимостей; просмотр через `@pierre/diffs` |
| LSP / diagnostics / go-to-def | — | **Отсутствует** | `provider-visible-order.ts:16` (только сортировка); `adapters/src/plugins/index.ts:112`; `bootstrap/src/zcode-protocol/plugins.ts:497` |
| Notebook support | `Edit`/`Read` | **Отсутствует** (зарезервировано) | `handlers/edit.ts:193-198`; `handlers/read.ts:95` |
| Terminal panel | xterm + node-pty | Реализовано | `ui/src/terminal/TerminalSession.tsx:1-4`; `services/src/terminal/terminal.ts:11-25` |
| File tree | `workspace-file-tree` | Read-only дерево | `workspace-file-tree/WorkspaceFileTree.tsx`; `services/src/file/file.ts:21-81` |
| Tabs | `workspaceSidePane` | Реализовано | `lib/workspaceSidePane.ts:1-90`; `app-shell/AnimatedSidePanePanel.tsx:1352-1368` |

### 2.2 Residual packages

| Пакет | Размер (src) | Entrypoint | Тесты | Reachability |
| --- | --- | --- | --- | --- |
| `packages/zcode-server-cli` | 49 файлов, 6990 строк | `src/index.ts`, `src/main.ts`, `server-core/entry.ts`; bin `zcode` | 32 файла | production (standalone remote server), не вызывается Desktop-исходниками |
| `packages/web-share` | 2 файла, 186 строк | `src/main.tsx` (Vite, base `/cn/share/`) | 0 | build-reachable; deploy-файлы (`Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx.web-share*.conf`) в репозитории отсутствуют |
| `packages/share-ui` | 2 файла, 7 строк | `src/index.ts`, `src/styles.css` | 0 | частично: используется только как путь к `styles.css`; реальный импорт идёт через alias `@zcode/ui/conversation-share-readonly` |
| `packages/zcode-cua` | 0 `src`, JS-stub | `index.js`, `broker.js` и подпути | 1 тест | production, но намеренно fail-closed заглушка |
| `packages/formal-proof` | 3 файла, 2400 строк | `src/model.ts`, `src/main.ts` (Vite :4176) | 0 в пакете; 1 тест в bootstrap | dev-tooling + test-only потребитель |
| `packages/stream-animate` | 17 файлов, 1809 строк | `src/server/index.ts`, `src/main.tsx` | 0 | dev-tooling, без runtime-потребителя |
| `packages/e2e-report` | 10 файлов, 1314 строк | `src/node/index.ts`, viewer (Vite :4173) | 0 | test-tooling (E2E-отчётность) |
| `packages/android` | 44 tracked-файла, 1261 строка Kotlin | `MainActivity.kt`, `RemoteControlApp.kt` | 1 инструментальный тест (assertion пакета) | orphan: нет `package.json`, нет CI/build-входа |
| `apps/dev-docs` | 18 файлов TS/TSX | `src/main.tsx`, Vite | 4 теста в пакете (не входят в root unit project) | dev-tooling (`dev:docs`, `build:docs`) |
| `third-party/` | 211 tracked-файлов | `inventory.json`, `SPEC.md` | проверки в `scripts/` | release-input (генерация notices) |
| корневой `scripts/` | 110 записей + 37 тестов в `scripts/test` | `build-zcode.mjs`, `licenses.mjs`, `verify:pre-push` и др. | 37 | production release/verify |

## 3. Capability inventory

### 3.1 Git: слои и реальные команды

**Observed.** Домен `packages/services/src/git` — 15 файлов, 5908 строк: `config.ts` (132), `git.ts` (55), `gitService.ts` (357), `gitCommitMessageGenerator.ts` (356), `commitMessageFileScope.ts` (97), `gitCheckpointService.ts` (111), `providers/gitCommandProvider.ts` (238), `providers/gitEnvironmentProvider.ts` (65), `repo/gitCliRepo.ts` (1711), `repo/gitCliHelpers.ts` (717), `repo/gitCheckpointRepo.ts` (493), `repo/gitCheckpointStore.ts` (98), `repo/gitCliTypes.ts` (119).

Сервисный контракт `IGitService` (`services/src/git/git.ts:32-55`):
`getRepositorySummary`, `getWorkspaceRepositoryInfo`, `getLocalBranches`, `getCommitGraph`, `switchBranch`, `createBranchAndSwitch`, `getChanges`, `getIgnoredPaths`, `getDiff`, `getBranchComparison`, `stagePaths`, `unstagePaths`, `discardPaths`, `generateCommitMessage`, `commit`, `push`, `getIdentity`, `refresh`.

Фактически исполняемые git-подкоманды (по литералам в `packages/services/src/git`): `status`, `diff`, `add`, `restore`, `reset`, `commit`, `push`, `switch`, `log`, `show`, `rev-parse`, `for-each-ref`, `config`, `remote`, `check-ignore`, `check-ref-format`, `ls-files`, `ls-tree`, `read-tree`, `update-index`, `update-ref`, `write-tree`, `commit-tree`, `hash-object`, `merge-base`.

**Ключевые реализации:**

- Статус: `git status --porcelain=v2 -z` + `diff --cached --numstat -z` + `diff --numstat -z` (`gitCliRepo.ts:888-890`); парсер `parseStatusPorcelain` (`gitCliHelpers.ts:244-359`), включая `u`-записи (unmerged) → `isConflicted` (`:336-355`).
- Untracked: отдельный bounded-скан с лимитом 1 MiB и 4 воркерами (`gitCliHelpers.ts:455-487`; константы `config.ts:14-16`).
- Diff: `git diff --no-ext-diff --no-color --binary` (staged/`--cached`), branch-режим `upstream...HEAD`, fallback `--no-index` для untracked (`gitCliRepo.ts:1252-1369`); классификация `patch|binary|truncated|unavailable` (`gitCliHelpers.ts:585-658`).
- Stage: `git add -- <paths>` (`gitCliRepo.ts:1423-1443`).
- Unstage: `git restore --staged -- <paths>` (`:1444-1464`).
- Discard: `git restore --worktree` либо `--source=HEAD --staged --worktree` (`:1465-1487`).
- Commit: обычный `git commit -m <msg> -- <paths>`; при `stagedOnly` — временный `GIT_INDEX_FILE`, `read-tree`, `update-index --cacheinfo`, `git commit` в temp index, затем `git reset --quiet HEAD -- <paths>` (`:1488-1636`).
- Push: `git push` (tracking) или `git push --set-upstream <remote> <branch>`; remote выбирается из `branch.<name>.remote`, `remote.pushDefault`, `origin`, единственного remote (`:673-706`; push — `:1638-1673`).
- Identity: `git config --show-scope --show-origin --get user.name|user.email` (`:1675-1711`).
- Ветки: `git switch --no-guess`, `git switch -c`; предварительные проверки конфликтов, незавершённых операций, `check-ref-format --branch`; маппинг stderr в стабильные коды (`gitCliRepo.ts:1071-1250`; `gitCliHelpers.ts:66-167`).
- Commit graph: `git log HEAD --branches --tags --remotes --date-order --topo-order --skip --max-count` с `--format=%H%x00%P%x00...`; исключает внутренние hidden refs (`gitCliRepo.ts:1009-1069`), лимиты 100/200 (`:111-112`).
- Branch comparison: `git diff --numstat -z --find-renames <tracking>...HEAD --` (`:1371-1421`); без upstream возвращает пустой список с `baseRef=null`.
- Checkpoints: `createCheckpoint` → `git add` в temp index, `write-tree`, `commit-tree`, `update-ref` (`gitCheckpointRepo.ts:255-366`); diff через `git diff`/`ls-tree`; restore только worktree через `git restore --source=<oid> --worktree`, без изменения индекса, с pre/post conflict-валидацией (`:380-470`); store — атомарный JSON-манифест (`gitCheckpointStore.ts:23-98`).

### 3.2 Git: UI-поверхности

- `GitPane` (`GitPane.tsx:43-546`) — панель review: переключатель источника (`unstaged`/`staged`/`branch`/`last-turn`), виртуализированный список (`useVirtualizer`, `:302`), ленивая загрузка diff по раскрытию (`:182-267`), поиск по содержимому diff с предзагрузкой (`:325-362`), пустые состояния и ошибки (`:108-164`). Вкладка монтируется в `app-shell/AnimatedSidePanePanel.tsx:1352-1368`.
- `GitPaneChangeCard` (`GitPaneChangeCard.tsx:1-226`) — раскрытие файла, контекстное меню только «reveal in file manager», «copy path», «reveal in file tree» (`:128-142`). Нет кнопок stage/unstage/discard.
- Рендер diff: `@pierre/diffs` `DiffViewer` (`components/ui/diff-viewer.tsx:6-7`) и лёгкий `LightweightDiffPreview`; политика выбора `getGitPaneDiffPreviewPlan` — plain-text/patch/rich с порогами 180000 символов и 1200 строк (`GitPane/helpers.ts:10-11`, `:118-170`).
- `GitActionMenu` (`GitActionMenu.tsx:822-1404`) — commit-dialog: генерация сообщения (`:989-1059`), `includeUnstaged`, действия commit/commitAndPush/push, авто-генерация при пустом сообщении, проверка identity (`:1107-1244`), push-dialog (`:1253-1290`). Монтируется в `v4/ConversationStatusPanel.tsx:449-456`.
- `GitBranchSwitcher` + `GitGraphDialog` (`GitBranchSwitcher.tsx:18, 330, 362-366`); граф read-only, 50 на страницу, без checkout/diff-перехода (`GitGraphDialog.tsx:26`; `docs/git/git-graph.md`).
- `useGitActions` (`hooks/useGitActions.ts:7-64`) — заглушка: все операции показывают toast `diff.placeholder.toast` и ничего не вызывают. **Потребителей нет** (`grep -rn "useGitActions("` → только определение), хотя хук реэкспортируется из `ui/src/index.ts:77`.
- `useGitRepository` (`hooks/useGitRepository.ts`) — single-flight refresh через `gitService.refresh` (`:466`), gating по `shouldEnableWorkspaceRpc` (`:398`), `last-turn` dataset из персистентных per-turn снапшотов (`:316-345`, `:551`).

### 3.3 Commit message generation

**Observed.** `GitCommitMessageGenerator` (`gitCommitMessageGenerator.ts:57-173`) читает текущую модель, строит prompt и валидирует Conventional Commit (`CONVENTIONAL_COMMIT_RE`, `:20-21`; `validateGeneratedGitCommitMessage`, `:239-255`). Лимиты: 20 файлов, 8 diff-файлов, 12000 суммарных символов diff, 2000 на файл, 12 сообщений контекста, 4000 символов контекста (`:10-16`). Язык — только `Chinese|English`, fallback English (`:224-237`). Ошибки типизированы (`GitCommitMessageGenerationError`, `:46-55`). Область файлов ограничивается текущей сессией (`commitMessageFileScope.ts:24-97`; вызов в `gitService.ts:263-269`).

### 3.4 Diff/review UX (без PR)

- Инлайн-комментарии существуют не для PR, а для ассистентского review: `CodeViewer` принимает `comments`, `focusedRange`, `onSubmitCodeComment` (`components/ui/code-viewer.tsx:44-69`, `:470-540`).
- Агентские code-review карточки: `previewPaneCodeReview.ts:1-43` (проецирует `requestId`, `startLine/endLine`, тело комментария в inline/top comment).
- Директива `code-comment` парсится из ответа ассистента (`lib/assistantCodeComment.ts:1-40`).
- Мультифайловый review как PR-поток отсутствует: нет approve/reject, нет apply/reject hunk, нет комментариев к строкам diff на сервере.

### 3.5 PR / CI / remote providers

**Observed отсутствие:**

- `grep 'gh pr create'` по `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts` → 0.
- `gh` присутствует только в read-only allowlist Bash-политики: `gh auth status` (`bash-readonly-policy-multiword-core.ts:24`), `gh pr checks` (`...-gh.ts:52`), `gh pr diff` (`:65`), `gh pr list` (`:77`), `gh pr status` (`:97`), `gh pr view` (`:104`), `gh repo view` (`:128`).
- Нет `api.github.com`, `GITHUB_TOKEN`, `gitlab.com/api` в `packages/services/src`, `packages/desktop/src`, `packages/ui/src`, `packages/shared/src`, `packages/zcode-server-cli/src` (grep — 0).
- Нет ingestion CI-статусов в UI/services (grep по `ci status|pipeline|checks` даёт только proxy-check и чекбоксы).
- Единственные «PR-поверхности» — текстовые suggested prompts: «Draft a merge request description… Show me the draft without publishing the MR» (`v4/featureSuggestedPrompts.ts:441`, `:445`), «Review this branch and find issues to fix before submitting a merge request» (`v4/officeSuggestedPrompts.ts:37-41`). Иконка `gitlab/icon.png` берётся с CDN, самого GitLab-плагина в репозитории нет (`find apps/zcode-cli/packages -name '*gitlab*'` → пусто).

### 3.6 IDE/editor surfaces

- Встроенного редактируемого редактора кода нет: `CodeViewer` — просмотрщик на `@pierre/diffs` `File` (`code-viewer.tsx:11-12`, `:680-762`), без `contentEditable`/`onChange`. Ввод текста есть только в prompt-editor (Lexical) и в Textarea для комментариев (`code-viewer.tsx:359-362`).
- Зависимостей Monaco/CodeMirror/LSP нет в `packages/ui/package.json` (проверено чтением dependencies).
- `LSP` — только имя в списке сортировки (`provider-visible-order.ts:16`); handler отсутствует. В плагинах `lspServers` — `UNSUPPORTED_COMPONENT_KEYS` (`adapters/src/plugins/index.ts:112`) и `diagnosticOnly` (`bootstrap/src/zcode-protocol/plugins.ts:497`).
- Diagnostics: нет LSP-диагностик; есть только подсветка строк `markedLines` для карточки compile feedback (`code-viewer.tsx:55-57`, `:679`).
- Go-to-definition/code actions: отсутствуют (grep — 0).
- Terminal: xterm + addon-fit/clipboard в UI (`terminal/TerminalSession.tsx:2-4`), PTY-сервис (`services/src/terminal/terminal.ts:11-25`) на Desktop-хосте через node-pty (`packages/desktop/package.json:83`).
- File tree: ленивая загрузка, поиск, git-статусы, watcher (`workspace-file-tree/*.ts`); write-операций нет — `IFileService` (`services/src/file/file.ts:21-81`) не содержит create/rename/delete/move, только чтение и `.zcodeignore`.
- Tabs/side pane: типы `browser`, `file-manager`, `code-viewer`, `git`, `treemapping`, `whiteboard`, `model-trajectory`, plugin-tabs и др. (`lib/workspaceSidePane.ts:1-90`).
- Notebook: `.ipynb` запрещён в `Edit` с отсылкой к несуществующему `NotebookEdit` (`handlers/edit.ts:193-198`); `Read` умеет `case "notebook"` (`handlers/read.ts:95`); handler `NotebookEdit` не зарегистрирован (grep `name: "NotebookEdit"` → 0).
- Внешние редакторы: обнаружение установленных приложений и «open in editor» (`WorkspaceEditorButtonGroup.tsx:23-55`; `docs/specs/desktop-editor-detection.md`).

### 3.7 Distribution: share links

- Входы: `/cn/share/<code>`, `/share/<code>`, callback-пути (`web/src/share/conversationShareRoute.ts:1-18`; `web-share/src/main.tsx:38-43`).
- Модель доступа: `private | public_readonly | public_importable` (`shared/src/conversation-share.ts:59-63`); default в UI — `public_importable` (`ui/src/store/conversationShareSelectionStore.ts:6-7`).
- Срок жизни: `expires_at` в контрактах confirm/preparation/preview (`shared/src/conversation-share.ts:249-250`, `:271-272`, `:345-347`; `conversationShareHttpClient.ts:540`); enforce на бэкенде (в репозитории его нет), landing показывает expired-состояние (`web/src/share/ConversationShareLandingPage.tsx:121-122`, `:167-168`).
- Бэкенд `/api/v1/shares/*` не входит в репозиторий: клиент вызывает `capabilities`, `preparations`, `preparations/{id}/artifacts`, `.../confirm`, `{code}/preview`, `{code}/continuation` (`services/src/conversation-share/conversationShareHttpClient.ts:229-317`), но ни `packages/server`, ни `packages/zcode-server-cli` не содержат маршрутов `/shares` (grep — 0).
- Защита контента: `assertSafeString` блокирует `data:`/`file:` и сырые `zcode-artifact://` (`conversationSharePublicProjection.ts:67-77`); public projection запрещает local write identity, local actions, feedback, subagent details, private runtime details (`:520-640`), усекает tool output до `output.text` (`:179-182`); sanitize issue-полей убирает пути/URL/длинные имена (`services/test/conversationShareSanitize.test.ts:26-52`).
- Disclosure gate: обязательное подтверждение перед публикацией (`conversationShareService.ts:2018` `disclosure_required`; UI `v4/ConversationShareConfirmationDock.tsx:117-130`, `:495-540`).
- Desktop import: deep link + pending queue (`desktop/src/main/desktopOAuthDeepLink.ts:50-70`, `:318`), канал `PlatformChannels.ShareImport` (`shared/src/channels.ts:391`).
- Мобильный web-remote: share-entry намеренно не добавляется (`ui/src/conversation-share-interaction/CONTRACT.md:9`).

### 3.8 Residual packages: детали

#### `packages/zcode-server-cli` (`@zcode/server-cli`)

- **Observed.** `private: true`, bin `zcode → ./dist/server-cli.js` (`package.json:3-6`). tsup собирает два бандла: `server-cli` и `server-core` (`tsup.config.ts:27-31`).
- Entrypoints: `runServerCli` (`src/cli.ts:107`; команды `serve|status|running-tasks|stop|restart|update|uninstall|proxy-stdio|migrate`, `:116-205`), `runServerCore` (`src/server-core/core.ts:21`), `createCoreHttpServer` (`src/server-core/http.ts:197`).
- HTTP/WS: Hono + `@hono/node-ws`; маршруты `/api/server-info` (`http.ts:271`), `/ws` — режим `web-remote-replayable` (`:272-284`), `/ws/host` — `desktop-continuous` + header capability (`:285-305`), `/api/rpc-host-capability` (`:306`).
- Auth: fail-closed для non-loopback (`:212-217`); ingress token — 32 random bytes, файл 0600 (`ingressToken.ts:5-16`), проверка Bearer или `?token=` через `timingSafeEqual` (`http.ts:239-270`); `/api/server-info` доступен без токена как anonymous compatibility fact (`:261-269`).
- Static hosting: **отсутствует** (`grep staticRoot|serveStatic` в `server-core/http.ts` → 0). Статика живёт в `packages/server/src/http.ts:352-483` и включается только env `ZCODE_WEB_STATIC_ROOT` (`entry-http.ts:19,38`).
- Reachability: документация R2 объявляет P0/P1 реализованными и Linux x64 проверенным по SSH (`docs/architecture/r2-server-cli-and-daemon.md:5`); Desktop-исходники ссылаются на «remote zcode-server» только в комментариях (`desktop/src/host/index.ts:1487`). Корневой `typecheck` включает пакет (root `package.json:69`), release-скрипт `prepare:remote-assets` фильтрует `@zcode/server-cli` (root `package.json:76-77`).

#### `packages/web-share` (`@zcode/web-share`)

- **Observed.** Vite-приложение, `base: "/cn/share/"`, alias `@`→`packages/ui/src`, `@zcode/ui/conversation-share-readonly`→`packages/share-ui/src/index.ts` (`vite.config.ts:1-62`). `main.tsx` (131 строка) импортирует `../../web/src/share/ConversationShareLandingPage.js`, preview client, route и mock client (строки 7-15, 80), OAuth callback (`ShareAuthPages.tsx`, 55 строк).
- Mock-режим: `VITE_CONVERSATION_SHARE_PREVIEW_MOCK === "true"` + `sessionStorage["zcode:share:mock-auth"]` (`main.tsx:76-86`).
- Скрипты: `build:web-share` (root `package.json:58`), `dev:web-share:test|mock` (root `package.json:18-19`, `scripts/dev-web-share-env.mjs`).
- **Gap:** документация описывает `Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx.web-share.conf`, `nginx.web-share.security-headers.conf` и `scripts/test-web-share-build.sh` (`docs/web-share/web-share-static-deployment.md:12-20`, `:60`), но в репозитории их нет (`ls` → No such file). Деплой-цепочка, следовательно, внешняя/неподтверждённая.

#### `packages/share-ui` (`@zcode/share-ui`)

- **Observed.** 2 файла: `src/index.ts` (6 строк) реэкспортирует `ui/src/v4/ConversationShareReadonlyTimeline.js` и тип `Theme`; `src/styles.css` — одна строка `@import "../../ui/src/styles.css";`.
- В `package.json` объявлено ~60 зависимостей, но код пакета их не использует; knip-baseline фиксирует `@zcode/share-ui`, `@zcode/shared`, `lucide-react`, `tailwindcss` как неиспользуемые (`scripts/knip-baseline.json:106-108`, `:134`).
- Реальная точка входа для landing page — `@zcode/ui/conversation-share-readonly` (`ui/package.json:10`; `web/src/share/ConversationShareLandingPage.tsx:14`), а alias в web-share указывает на `share-ui` (`web-share/vite.config.ts:61`). То есть share-ui — тонкая обёртка/точка переключения, а не самостоятельная библиотека.

#### `packages/zcode-cua` (`@zcode/zcode-cua` 0.6.5)

- **Observed.** Намеренная заглушка: `package.json:5` («API-compatible placeholder … every runtime surface reports unavailable and fails closed»), `zcodeCuaPlaceholder: true` (`:61`). `createComputerUseRuntime().execute` всегда возвращает `isError` с текстом «Computer Use is not available in this build.» (`index.js:1-13`); `callBrokerMethod` бросает `BrokerError` с кодом `unavailable` (`broker.js:39-41`).
- Потребители: `apps/zcode-cli/packages/node-repl-host/src/server.ts:17,377` (создание runtime только при наличии `ZCODE_CUA_PERMISSION_BROKER_SOCKET`), Desktop main — константы helper/ports и installer (`desktop/src/main/desktopCuaHelperInstaller.ts:3`, `desktopRuntimeEnv.ts:7`, `cuaPipFocusRouter.ts:1`).
- Тест ровно один: `test/availability.test.ts` (2 кейса), подтверждает fail-closed и отсутствие подготовки broker.
- **Вывод:** CUA-поверхность в этой сборке — статическая заглушка; UI-компоненты permission/PiP остаются, но runtime-функциональности нет.

#### `packages/formal-proof` (`@zcode/formal-proof`)

- **Observed.** Vite-приложение `:4176`; `src/model.ts` (918 строк) — исполняемая таблица решений для compact/fork/goal/queue; `src/main.ts` (905) — визуализация; README ссылается на `docs/conversation-product-state-space.md`.
- Reachability: dev-dep bootstrap (`apps/zcode-cli/packages/bootstrap/package.json:45`), сборка в `bootstrap:with-remote` (`scripts/bootstrap.mjs:209`), тест `formal-proof-consistency.test.ts:18` сверяет `evaluate` с `computeAvailability`/`computeInputRouting` проекции.
- Пакет не имеет собственных тестов (0) и не входит в пользовательский артефакт.

#### `packages/stream-animate` (`@zcode/stream-animate`)

- **Observed.** Локальный сервер (`src/server/index.ts`, порт 5187) c runner'ом DeepSeek (`src/server/deepseekRunner.ts:1-30`, SSE, метрики first-byte/first-token), клиент на React (`FrameChart`, `RunForm`, `RunHistory`).
- В `package.json` нет зависимости от других workspace-пакетов; ни один пакет/приложение не импортирует `@zcode/stream-animate` (grep — только собственный `package.json`).
- Собирается в `bootstrap:with-remote` (`scripts/bootstrap.mjs:169-187`). Тестов 0.
- **Вывод:** внутренний benchmark/визуализатор стриминга, не продукт; сборка в bootstrap — единственный «вход».

#### `packages/e2e-report` (`@zcode/e2e-report`)

- **Observed.** Node-библиотека `src/node/index.ts` (`readE2EReportSummary`, `createE2EReportViewerUrl`, base `http://127.0.0.1:4173/`) + Vite-viewer (`src/viewer/*`).
- Потребитель: `packages/desktop/test/e2e/reporting/e2e-reporting-summary.ts:5`; сборка `build:node` перед E2E (`packages/desktop/package.json:35,38,47,71`); tsconfig path alias (`packages/desktop/tsconfig.e2e.json:10`).
- Тестов в пакете 0.

#### `packages/android`

- **Observed.** Нет `package.json` (не pnpm-пакет, не typecheck/lint). Gradle Kotlin + Compose (`app/build.gradle.kts:1-70`): `applicationId com.example.zcode_mobile`, minSdk 24, targetSdk 36, `REMOTE_CONTROL_DEFAULT_URL = https://zcode.z.ai/remote`.
- Манифест: INTERNET, CAMERA, FOREGROUND_SERVICE, POST_NOTIFICATIONS; deep links `zcode://remote` и `https://zcode.z.ai/remote` (`AndroidManifest.xml:1-69`).
- `RemoteControlUrlPolicy.kt:1-80` — allowlist только `zcode.z.ai/remote` (https), debug-сборка дополнительно разрешает localhost/10.0.2.2/.local/192.168.x/10.x/172.16-31.x.
- 1261 строка Kotlin, единственный тест `ExampleInstrumentedTest.kt` проверяет только имя пакета.
- **Вывод:** orphan-прототип мобильного WebView-пульта; ни сборки, ни CI, ни публикации в репозитории.

#### `apps/dev-docs`

- **Observed.** Vite-приложение документации/карт возможностей (`src/App.tsx`, `capability-map/*`, `feature-boundary-graph/*`, `data/productCapabilityMap.ts` ~? строк). Скрипты `dev:docs`/`build:docs` (root `package.json:10,56`), включён в root `typecheck` (`:69`).
- Тесты: 4 файла, по 1-3 кейса (`apps/dev-docs/test/*.test.ts`), запускаются только собственным `vitest.config.ts` (`package.json` script `test`), не входят в root unit project (include ограничен `packages/*/test/**`).

#### `third-party/`

- **Observed.** `README.md`/`SPEC.md` описывают владение материалами и release-входы. `inventory.json`: 1219 packages, 12 copied components, 19 `reviewRequired` (например `unsafe-pointer@0.2.0`, `@hono/node-ws@1.3.0`, React Best Practices skill).
- Генерация/проверка: `scripts/licenses.mjs`, `scripts/generate-third-party-notices.mjs`, `scripts/third-party-notices.mjs`; `check --strict` существует, но, по SPEC, не подключён к SEA/CI публикации (`third-party/SPEC.md`, раздел «交付入口»/«开发、构建与校验边界»).

#### Корневой `scripts/`

- **Observed.** 110 записей, включая release (`release-macos-local.mjs`, `release-macos-preview.mjs`), distribution (`build-zcode.mjs`, `zcode-distribution/*`), verify (`verify:pre-push`), licenses, architecture, affected tests, а также `self-improve-pr.mjs`/`self-improve-evaluator.mjs` (локальный план, `--apply` запрещён до внешнего secret gate — комментарий в шапке файла).
- 37 тестов в `scripts/test`; часть подключена к `verify:pre-push` (root `package.json:54`).

## 4. Gaps, risks, weaknesses

### G1. PR/CI/remote-provider автоматизация отсутствует полностью — High

**Observed.** Нет PR-создания, review-комментариев, ingestion CI, auth к GitHub/GitLab, ни одного вызова API провайдера (см. §3.5). `gh` доступен модели только как read-only Bash-команды; `gh pr create` отсутствует в allowlist, поэтому создание PR потребует permission-запроса или ручного действия пользователя.

**Следствие:** «PR workflow» в продукте сведён к генерации текста описания через prompt. Итерации patch → review → CI не автоматизированы.

### G2. `isolation: "worktree"` объявлен в схеме, но падает в runtime — High

**Observed.** Схема принимает значение (`apps/zcode-cli/packages/contracts/src/workflow/script.ts:42-49`), runtime бросает `workflow agent isolation 'worktree' is not implemented yet.` (`apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts:282-284`). `EnterWorktree`/`ExitWorktree` есть в root-only списках (`subagent/profile.ts:227-228`, `provider-visible-order.ts:11-12`), но handler'ов нет (grep `name: "EnterWorktree"` → 0).

**Следствие:** модель может выбрать заявленную возможность и получить runtime error; параллельные writers не изолированы (только ledger-gate по намерениям).

### G3. UI не даёт stage/unstage/discard, а `useGitActions` — мёртвая заглушка — High

**Observed.** Сервис реализует `stagePaths`/`unstagePaths`/`discardPaths` (`gitService.ts:242-252`; `gitCliRepo.ts:1423-1487`), но в `packages/ui/src` нет ни одного вызова `unstagePaths`/`discardPaths`; `stagePaths` вызывается только из commit-диалога и branch-switch assist (`GitActionMenu.tsx:1173`; `useGitBranchSwitcher.ts:341`). `useGitActions` показывает `diff.placeholder.toast` и ничего не выполняет (`useGitActions.ts:12-47`), при этом экспортируется из публичного `ui/src/index.ts:77` и не имеет потребителей.

**Следствие:** пользователь не может отменить staging или отбросить изменения из Git pane; discard-код существует без UI-пути и без теста UI-уровня.

### G4. Нет conflict resolution, revert/undo Git-уровня, blame — Medium-High

**Observed.** Конфликты детектируются (`isConflicted`, `gitCliHelpers.ts:336-355`) и блокируют switch (`gitCliRepo.ts:1105-1125`), но нет resolver-редактора, `merge`/`rebase`/`cherry-pick`/`stash`/`revert` команд (grep — 0). `blame` отсутствует. Отмена изменений есть только на уровне AI-checkpoint'ов (`apps/zcode-cli/.../file-rewind.ts`, `ConversationFileRewindDialog.tsx`), не Git-операций.

### G5. GitGraph и branch comparison ограничены — Low-Medium

**Observed.** Graph — read-only, 50/страница, без checkout/diff-перехода (`GitGraphDialog.tsx:26`; `docs/git/git-graph.md`). Branch comparison требует upstream (`gitCliRepo.ts:1371-1385`), иначе список пуст; UI не предлагает задать upstream кроме push (`gitCliRepo.ts:1650-1655`).

### G6. Destructive Git-операции без UI-подтверждений и без undo — Medium

**Observed.** `discard` реализован через `git restore --worktree`/`--source=HEAD` (`gitCliRepo.ts:1465-1487`) без встроенного undo; UI-пути нет, поэтому и подтверждений нет. Branch switch assist делает `stagePaths` + `commit` + `switchBranch` без диалога подтверждения самого commit (`useGitBranchSwitcher.ts:335-360`) — авто-сообщение генерируется шаблоном (`buildGitBranchAutoCommitMessage`).

**Inferred risk:** при появлении UI для discard отсутствие подтверждения/undo станет источником потери данных.

### G7. Credentials/SSH/GPG не управляются, hooks невидимы — Medium

**Observed.** Git-команды наследуют окружение, но вычищают `GIT_DIR`, `GIT_WORK_TREE` и др. (`config.ts:34-77`); нет `GIT_ASKPASS`, `GIT_SSH_COMMAND`, `GIT_TERMINAL_PROMPT`, `credential.helper`. Репозиторные husky-хуки (`.husky/pre-push`, `.husky/commit-msg` с требованием кириллицы в теме) — это hooks самого репозитория, а не продуктовая функция; `git push` лишь получает увеличенные timeout/output budget (`config.ts:5-11`).

**Inferred risk:** в средах без настроенного credential helper push будет интерактивно зависать или падать по timeout (10 минут), а причины хуков не видны в UI.

### G8. Нет LSP/diagnostics/go-to-def/code actions; notebook зарезервирован, но не реализован — High (для «IDE»-позиционирования)

**Observed.** `LSP` — только строка сортировки (`provider-visible-order.ts:16`); плагинные `lspServers` — diagnostic-only (`adapters/src/plugins/index.ts:112`; `bootstrap/src/zcode-protocol/plugins.ts:497`). `NotebookEdit` не зарегистрирован, но `Edit` отказывает `.ipynb` с отсылкой к нему (`handlers/edit.ts:193-198`). `Read` поддерживает notebook-ветку (`handlers/read.ts:95`).

**Следствие:** редактирование и навигация по коду ограничены чтением; «IDE»-сценарии (переход к определению, диагностика, code actions) не покрыты.

### G9. File tree и code viewer — только чтение — Medium

**Observed.** `IFileService` не содержит write/create/rename/delete/move (`services/src/file/file.ts:21-81`); `CodeViewer` — просмотрщик (`code-viewer.tsx:11-12`, `:359-362` только Textarea комментария). Правки кода возможны только через инструменты агента (`Edit`/`Write`/`ApplyPatch`) или внешний редактор.

### G10. `web-share`/`share-ui`: дрейф документации, раздутые зависимости, нет тестов — Medium

**Observed.** Документация ссылается на отсутствующие `Dockerfile.web-share`, `Jenkinsfile.web-share`, `nginx.web-share*.conf`, `scripts/test-web-share-build.sh` (`docs/web-share/web-share-static-deployment.md`). `share-ui` объявляет 59 dependencies + 4 devDependencies при 7 строках кода; knip-baseline подавляет предупреждения (`scripts/knip-baseline.json:106-108,134`). Тестов в `web-share`/`share-ui` — 0.

**Inferred risk:** production-сборка share-страницы не воспроизводима из этого репозитория; состав зависимостей не соответствует реальному использованию.

### G11. `android` — orphan-прототип — Medium

**Observed.** Нет `package.json`, нет CI/Jenkins/Gradle-шага, единственный тест — проверка имени пакета (`ExampleInstrumentedTest.kt:20-22`). При этом манифест запрашивает CAMERA, FOREGROUND_SERVICE, POST_NOTIFICATIONS и deep links.

**Inferred risk:** код не проверяется ни typecheck, ни lint, ни сборкой в этом репозитории; битые изменения не будут замечены.

### G12. `formal-proof`/`stream-animate`/`e2e-report` — тестовый/дев-инструментарий с нулевым покрытием — Low-Medium

**Observed.** 0 тестов в каждом из трёх пакетов; `formal-proof` проверяется косвенно тестом bootstrap; `stream-animate` не имеет потребителей кроме bootstrap-сборки; `e2e-report` — только E2E-инструмент.

### G13. `zcode-server-cli`: ingress auth есть, но публичный listener и статика не покрыты — Medium

**Observed.** Non-loopback listener запрещён без auth (`http.ts:212-217`), token проверяется timing-safe (`:239-270`), capability имеет TTL (`:230-234`, `:285-290`). Статики нет; HTTP-слой не отдаёт UI. Тестами покрыты auth/capability/WS-закрытие (`test/coreHttp.test.ts:303,360,528,549`), но не реальный Supervisor lifecycle (это в `serverCore.test.ts` с моками).

**Inferred:** для standalone server UI должен обслуживаться отдельным `packages/server` с `ZCODE_WEB_STATIC_ROOT`; связка «server-cli + server static» не описана в коде как единый продукт.

### G14. Checkpoint-сервис не связан с UI — Medium

**Observed.** `IGitCheckpointService` зарегистрирован (`services/src/node.ts:1371`, `:2731-2732`), доступен через accessor (`services/src/accessor.ts:70`) и RPC (`desktop/src/host/remoteWorkspaceRpcContract.ts:8`), но в `packages/ui/src` нет ни одного вызова `checkpointService` (grep — 0). Спецификация прямо говорит «не接入 UI 交互» (`docs/git/checkpoint-service-foundation.md:7`). Отмена файлов у пользователя идёт через AI-checkpoint rewind (`v4/ConversationFileRewindDialog.tsx`), а не через Git-checkpoint.

**Следствие:** два параллельных механизма снапшотов (Git-checkpoint service и AI artifact-store) без единого UX.

### G15. Commit из branch-switch assist без подтверждения и с шаблонным сообщением — Medium

**Observed.** `commitAndSwitchBranch` делает `stagePaths` + `commit` (без `paths`, т.е. весь индекс) + `switchBranch` (`useGitBranchSwitcher.ts:335-360`), сообщение по умолчанию — `buildGitBranchAutoCommitMessage(targetBranch)`. Пользователь видит диалог, но scope commit — весь индекс, а не только затронутые файлы (`switchAssistState.stagePaths` только для stage).

**Inferred risk:** в индекс могут попасть посторонние staged-файлы; это расходится с commit-dialog, где есть явный `paths`/`stagedOnly`.

### G16. `discard`/`unstage` на unborn HEAD — Unknown

**Observed.** `unstage` использует `git restore --staged` (`gitCliRepo.ts:1444-1464`), `discard(staged=true)` — `git restore --source=HEAD` (`:1465-1487`). Для репозитория без первого коммита `HEAD` не резолвится.

**Unknown:** поведение на unborn-ветке не покрыто тестами (`gitService.test.ts` создаёт baseline-коммит). Требует проверки.

### G17. Share-ссылки: серверная часть вне репозитория, expiry не проверяется клиентом — Medium

**Observed.** Клиент доверяет `expires_at` с сервера (`conversationShareHttpClient.ts:540`), landing показывает expired только по серверному ответу (`ConversationShareLandingPage.tsx:643-670`). Локальной проверки срока нет. Backend `/api/v1/shares/*` отсутствует в репозитории, поэтому политика TTL, rate-limit и ownership не проверяемы по коду.

**Unknown:** реальные TTL, права доступа и защита от перебора share code.

### G18. PR-подсказки ссылаются на несуществующий GitLab-плагин — Low

**Observed.** `officeSuggestedPrompts.ts:37-44` использует `plugin.stableId = "gitlab@zcode-plugins-official"`, но такого плагина в `apps/zcode-cli/packages` и в списке официальных плагинов (`server/src/remote/zcodeAgentOfficialPluginAssets.ts:5-19`) нет. Иконки `gitlab/icon.png` — внешний CDN (`featureSuggestedPrompts.ts:11`).

**Inferred:** подсказка может вести в несуществующий сценарий, если UI попытается открыть плагин.

## 5. Strengths and differentiators

1. **Настоящий Git CLI, а не libgit2-обёртка** (Observed: все операции — spawn `git`; `gitCommandProvider.ts:76-230`). Это даёт совместимость с hooks, filters, worktree, submodule и пользовательским конфигом.
2. **Защита от «протекания» hook-окружения.** `GIT_LOCAL_ENV_VARS` вычищается перед каждой командой (`config.ts:34-77`) — редко встречающаяся деталь, предотвращающая «串仓» при вызове из pre-push hook.
3. **Path containment и workspace-subtree scoping.** `normalizeInputPath` запрещает выход за repo (`gitCliHelpers.ts:683-702`), а `gitService` фильтрует изменения по подкаталогу workspace (`gitService.ts:20-28`, `:114-121`) — корректно для monorepo.
4. **Бюджеты вместо «повиснуть»:** 15s обычные команды, 10 мин push, 20s diff, 512 KiB/8 MiB output, 1 MiB diff, bounded untracked-скан с 4 воркерами (`config.ts:4-16`; `gitCliHelpers.ts:455-487`).
5. **Структурированные ошибки ветвления** вместо парсинга текста в UI: 9 стабильных кодов (`shared/git.ts:26-35`; `gitCliHelpers.ts:66-167`).
6. **Checkpoint с честной конфликт-моделью и сохранением индекса:** restore меняет только worktree, pre/post валидация, `force` как явный opt-in (`gitCheckpointRepo.ts:380-470`).
7. **Session-scoped commit message generation:** фильтр по файлам текущей сессии, Conventional Commit валидация, жёсткие лимиты prompt'а (`commitMessageFileScope.ts`; `gitCommitMessageGenerator.ts:10-21`, `:239-255`).
8. **Производительность diff/review:** виртуализация списка, ленивая загрузка, пороги перехода на plain-text/patch, отдельный worker pool для `@pierre/diffs` (`GitPane.tsx:302-323`; `GitPane/helpers.ts:118-170`; `root/DiffsWorkerPoolProvider.tsx`).
9. **Public projection для share с жёсткими assert'ами:** блокировка local identity, actions, feedback, subagent, `data:`/`file:` и сырых artifact-ссылок (`conversationSharePublicProjection.ts:67-77`, `:520-640`) + обязательный disclosure gate (`conversationShareService.ts:2018`).
10. **server-core fail-closed:** non-loopback listener невозможен без auth, token constant-time, capability TTL и одноразовое потребление (`server-core/http.ts:212-306`).
11. **CUA честно недоступен и это протестировано** (`zcode-cua/index.js:1-13`; `test/availability.test.ts`), а не имитируется.
12. **Широкая тестовая база Git-домена:** реальные git-репозитории в fork-isolated (20 тестов) + 29 unit-тестов UI/repo/message в обычном прогоне (см. §8).

## 6. Candidate recommendations

### R1. Добавить минимальный PR-контур: создание PR и ingestion CI через `gh`, с явным permission-gate

- **Problem/gap:** §3.5, G1 — нет PR-создания, review-комментариев и CI-фидбэка; `gh pr create` вне allowlist.
- **ZCode evidence:** `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts:52-128` (read-only набор); `bash-readonly-policy-multiword-core.ts:24`; `v4/featureSuggestedPrompts.ts:441-445` (только черновик текста); `grep 'gh pr create'` = 0.
- **Proposed solution:** (a) добавить в Bash allowlist мутирующие `gh pr create|edit|comment|review` с обязательным permission-запросом и audit-логом; (b) ввести сервис `IGitRemoteService` (host-side) с методами `createPullRequest`, `listChecks`, `getReviewComments`; (c) в UI — секция «PR» в status panel: черновик (из commit message generator) → подтверждение → создание; polling checks с TTL-кэшем; (d) не хранить токены в ZCode — использовать существующий `gh`/credential helper.
- **Scope in:** GitHub через `gh`; чтение checks/comments.
- **Scope out:** GitHub API-клиент с OAuth, GitLab, merge/approve, auto-fix CI.
- **Expected effect:** цикл «изменения → PR → CI-статус» без выхода из приложения.
- **Risks:** секреты и права в логах; rate limit (`bash-gh-rate-limit.ts:7` уже предупреждает о 5000/час); расхождение поведения `gh` версий.
- **Complexity:** L. **Priority:** P0.
- **Acceptance:** из Git-панели создаётся PR в тестовом репозитории; при отсутствии `gh`/auth показывается actionable ошибка; checks отображаются и обновляются; ни один токен не попадает в лог.
- **Verification:** интеграционный тест с локальным git-remote + fake `gh` в PATH; E2E-сценарий с mock HTTP; проверка логов на отсутствие токена.

### R2. Реализовать `isolation: "worktree"` или убрать его из схемы

- **Problem/gap:** §3.1, G2 — схема обещает worktree, runtime бросает ошибку.
- **ZCode evidence:** `apps/zcode-cli/packages/contracts/src/workflow/script.ts:42-49`; `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts:282-284`; `subagent/profile.ts:227-228` (имена без handler'ов).
- **Proposed solution (вариант A, рекомендуемый):** создать worktree от HEAD в `<repo>/.zcode/worktrees/<runId>`, запустить child с `cwd=worktree`, по завершении вернуть diff и удалить неизменённый worktree; при ошибке — cleanup в `finally`. Вариант B — удалить `isolation` из схемы и описаний до реализации.
- **Scope in:** lifecycle worktree, cleanup, возврат diff.
- **Scope out:** merge обратно, разрешение конфликтов между worktree.
- **Expected effect:** параллельные writers не конфликтуют; обещание схемы соответствует поведению.
- **Risks:** git-версии без `worktree`, права на FS, «забытые» worktree при crash (нужен startup-sweep).
- **Complexity:** M. **Priority:** P0.
- **Acceptance:** два actor'а с `isolation:"worktree"` пишут один путь без конфликта; при отсутствии изменений worktree удалён; при ошибке — cleanup; на startup удаляются stale-worktree.
- **Verification:** integration-тест с реальным git-репозиторием; тест crash-recovery; проверка, что без git worktree поддержка деградирует с понятной ошибкой.

### R3. Дать UI-путь для stage/unstage/discard с подтверждением и undo-окном

- **Problem/gap:** §3.2, G3 — операции есть в сервисе, но недостижимы; `useGitActions` — мёртвая заглушка.
- **ZCode evidence:** `gitService.ts:242-252`; `gitCliRepo.ts:1423-1487`; `useGitActions.ts:12-47`; `ui/src/index.ts:77`; отсутствие вызовов `unstagePaths`/`discardPaths` в UI.
- **Proposed solution:** заменить `useGitActions` на реальный hook (или удалить и использовать `useServices().gitService`); в `GitPaneChangeCard` добавить per-file и bulk действия; для discard — confirm-dialog с перечнем файлов и «undo» через checkpoint (создать checkpoint перед discard, `restoreBetweenCheckpoints` при отмене).
- **Scope in:** stage/unstage/discard, confirm, undo через существующий checkpoint-сервис.
- **Scope out:** partial-line staging, interactive rebase.
- **Expected effect:** review-панель становится рабочим инструментом, а не только просмотром.
- **Risks:** потеря данных при discard без checkpoint; дублирование состояния между Git index и checkpoint.
- **Complexity:** M. **Priority:** P1.
- **Acceptance:** пользователь ставит/снимает staging и отбрасывает изменения; discard всегда создаёт checkpoint; undo восстанавливает файлы; UI-тесты покрывают disabled/loading/error.
- **Verification:** component-тесты `GitPaneChangeCard`; integration-тест discard+undo на реальном репозитории; E2E «Changes → stage → commit».

### R4. Conflict resolution surface (read-only минимум → редактируемый merge)

- **Problem/gap:** §3.1, G4 — конфликты видны, но разрешать их в приложении нельзя.
- **ZCode evidence:** `gitCliHelpers.ts:336-355`; `gitCliRepo.ts:1105-1125`; `shared/git.ts:26-35` (`conflicts-present`); отсутствие `merge|rebase|cherry-pick`.
- **Proposed solution:** этап 1 — секция «Conflicts» в GitPane с open-in-external-editor и кнопкой «mark resolved» (`git add <path>`); этап 2 — встроенный three-way viewer на `@pierre/diffs` с выбором ours/theirs.
- **Scope in:** список конфликтов, переход к файлу, mark resolved.
- **Scope out:** merge/rebase orchestration, auto-merge.
- **Expected effect:** блокирующие конфликты перестают быть тупиком.
- **Risks:** неверная «resolved»-пометка при несохранённых правках; лимиты больших файлов.
- **Complexity:** M. **Priority:** P1.
- **Acceptance:** конфликтный репозиторий показывает секцию, «mark resolved» снимает блокировку switch, действия логируются.
- **Verification:** integration-тест с созданным merge-конфликтом; UI-тест секции.

### R5. Ввести LSP-адаптер (диагностика + definition) как плагинную возможность

- **Problem/gap:** §3.6, G8 — LSP отсутствует, хотя имя зарезервировано и плагины объявляют `lspServers`.
- **ZCode evidence:** `provider-visible-order.ts:16`; `adapters/src/plugins/index.ts:112`; `bootstrap/src/zcode-protocol/plugins.ts:497`.
- **Proposed solution:** (a) формализовать `lspServers` как runnable-компонент плагина (stdio LSP client в host); (b) tool `LSP` с операциями `definition|diagnostics|references`; (c) подсветка `markedLines` уже есть — переиспользовать.
- **Scope in:** stdio LSP, diagnostics, definition.
- **Scope out:** completion, rename, code actions, workspace symbols.
- **Expected effect:** навигация по коду и диагностика без внешнего редактора.
- **Risks:** память/CPU на большие workspace; lifecycle серверов; безопасность сторонних LSP.
- **Complexity:** L. **Priority:** P1.
- **Acceptance:** для TS-проекта `LSP definition` возвращает позицию, diagnostics отображаются на строках; плагин без LSP не ломает загрузку.
- **Verification:** integration-тест с `typescript-language-server`; контрактный тест plugin manifest; проверка timeout/cleanup.

### R6. Убрать расхождение «NotebookEdit зарезервирован, но отсутствует»

- **Problem/gap:** §3.6, G8 — `Edit` отправляет пользователя к несуществующему инструменту.
- **ZCode evidence:** `handlers/edit.ts:193-198`; `handlers/read.ts:95`; `grep 'name: "NotebookEdit"'` = 0.
- **Proposed solution:** вариант A — реализовать `NotebookEdit` (cell-level replace/insert/delete) и зарегистрировать; вариант B — изменить сообщение `Edit` на «notebooks are not editable in this build» и убрать имя из provider-visible списка.
- **Scope in:** сообщение и/или handler.
- **Scope out:** notebook UI/рендеринг.
- **Expected effect:** нет ложного обещания; при варианте A — редактирование `.ipynb`.
- **Risks:** вариант A — сложность сохранения JSON-структуры и outputs.
- **Complexity:** S (вариант B) / M (вариант A). **Priority:** P1 (B) / P2 (A).
- **Acceptance:** ни один tool-ответ не ссылается на незарегистрированный инструмент; тест `edit-tool-contract` обновлён.
- **Verification:** unit-тест сообщения; grep-тест «все имена в provider-visible имеют handler или помечены reserved».

### R7. Привести share-пакеты и деплой-документацию в соответствие репозиторию

- **Problem/gap:** §3.8, G10 — отсутствуют Dockerfile/Jenkinsfile/nginx, `share-ui` раздут, тестов 0.
- **ZCode evidence:** `docs/web-share/web-share-static-deployment.md:12-20,60`; `packages/share-ui/src/index.ts` (6 строк); `packages/share-ui/package.json` (59 deps + 4 devDeps); `scripts/knip-baseline.json:106-108,134`; `packages/web-share/src/main.tsx:2-15`.
- **Proposed solution:** либо добавить в репозиторий `Dockerfile.web-share`/`Jenkinsfile.web-share`/`nginx.web-share*.conf`/smoke-скрипт, либо убрать их из документа как внешние и указать владельца; сократить `share-ui` dependencies до реально импортируемых (или удалить пакет, оставив alias на `ui`); добавить unit-тест на `ShareAuthPages`/route (сейчас route-тесты есть только в `packages/web`).
- **Scope in:** манифест, доки, минимальные тесты.
- **Scope out:** изменение дизайна landing page.
- **Expected effect:** воспроизводимая сборка и честный dependency-граф; knip-baseline перестаёт скрывать долг.
- **Risks:** удаление пакета затронет Vite alias в `web-share`.
- **Complexity:** S. **Priority:** P1.
- **Acceptance:** `pnpm build:web-share` и smoke-скрипт воспроизводимы из checkout; документация не ссылается на отсутствующие файлы; `share-ui` не содержит неиспользуемых зависимостей.
- **Verification:** чистый checkout + build; `node scripts/check-doc-links.mjs`; knip без новых записей.

### R8. Определить судьбу `packages/android` и добавить его в проверки

- **Problem/gap:** §3.8, G11 — orphan без `package.json`, CI и содержательных тестов.
- **ZCode evidence:** отсутствие `packages/android/package.json`; `app/build.gradle.kts:1-70`; `ExampleInstrumentedTest.kt:20-22`; отсутствие упоминаний android в root `scripts/*.mjs`/`.github`.
- **Proposed solution:** либо (a) добавить Gradle-джобу (`assembleDebug` + `lint`) и тест на `RemoteControlUrlPolicy` (сейчас allowlist не покрыт), либо (b) удалить пакет из репозитория, если мобильный пульт реализуется как PWA (`/remote`).
- **Scope in:** build/lint/test или удаление.
- **Scope out:** публикация в Play Store.
- **Expected effect:** код либо проверяется, либо не создаёт ложного впечатления поддержки Android.
- **Risks:** AGP/Gradle версии и CI-время.
- **Complexity:** M. **Priority:** P2.
- **Acceptance:** CI собирает debug-APK и прогоняет unit-тест политики URL; либо каталог отсутствует и упоминания удалены.
- **Verification:** CI-лог сборки; unit-тест `RemoteControlUrlPolicy` (JVM, без эмулятора).

### R9. Связать Git-checkpoint service с UI или удалить дублирующий слой

- **Problem/gap:** §3.1, G14 — сервис доступен, но UI не использует; отмена идёт через AI-checkpoint.
- **ZCode evidence:** `gitCheckpointService.ts:63-110`; `services/src/node.ts:1371,2731-2732`; `accessor.ts:70`; `remoteWorkspaceRpcContract.ts:8`; 0 вызовов в `packages/ui/src`.
- **Proposed solution:** использовать `gitCheckpointService` как backend для R3-undo (создавать checkpoint перед discard и перед ветвлением), либо задокументировать, что это внутренний API для будущего Source Control и убрать из публичного accessor до появления потребителя.
- **Scope in:** один из двух вариантов.
- **Scope out:** слияние с AI-artifact-store.
- **Expected effect:** нет «мёртвого» публичного API; undo получает надёжный источник.
- **Risks:** checkpoint'ы занимают место; нужно расписание очистки.
- **Complexity:** S–M. **Priority:** P2.
- **Acceptance:** либо UI вызывает сервис и checkpoint'ы очищаются по TTL, либо сервис не экспортируется в accessor.
- **Verification:** integration-тест discard+undo на checkpoint; тест очистки.

## 7. Open questions and unverified

1. **PR/CI roadmap.** Планируется ли собственный GitHub/GitLab API-клиент или ставка на `gh`/пользовательские команды? В коде нет ни того, ни другого (Unknown).
2. **GitLab-плагин.** `officeSuggestedPrompts.ts:44` ссылается на `gitlab@zcode-plugins-official`, но плагина нет. Это внешний marketplace-плагин или ошибка? (Unknown.)
3. **Unborn HEAD.** Поведение `unstage`/`discard(staged)` без первого коммита не покрыто тестами (G16, Unknown); нужен реальный прогон.
4. **Credential/SSH.** Предполагается, что пользователь настроил credential helper/SSH-agent глобально; продуктовая поддержка не заявлена. Насколько это осознанное решение? (Inferred из `config.ts:34-77`.)
5. **Git hooks UX.** Должны ли хуки (pre-commit/pre-push) отображаться в UI с выводом? Сейчас о них знает только таймаут push (`config.ts:5-11`).
6. **Worktree-изоляция.** Какой вариант выбран — реализация или удаление поля? (Unknown; см. R2.)
7. **LSP.** `lspServers` в плагинах — будущая фича или поле будет удалено? (Z10 фиксировал то же.)
8. **NotebookEdit.** Планируется ли реализация или только исправление сообщения? (Unknown.)
9. **Share TTL и права.** Реальные `expires_at`, лимиты и anti-enumeration живут на внешнем бэкенде; в репозитории их нет (Unknown). Есть ли отдельный репозиторий/сервис?
10. **Деплой share.** Существуют ли `Dockerfile.web-share`/`Jenkinsfile.web-share`/nginx-конфиги вне этого репозитория? Если да — где источник истины?
11. **Android.** Это долгосрочный продукт или прототип, подлежащий удалению? (Unknown.)
12. **`stream-animate`.** Кто потребитель метрик и нужен ли пакет в bootstrap-сборке? (Consumer не найден.)
13. **`formal-proof`.** Должен ли пакет иметь собственные тесты, или связка через bootstrap-тест считается достаточной? (Unknown.)
14. **`third-party` strict-check.** Когда `check --strict` будет подключён к release? Сейчас 19 `reviewRequired` не блокируют выпуск (SPEC.md говорит об этом явно).
15. **`useGitActions`.** Удалить или доработать? Публичный экспорт без потребителя — потенциальный контракт для плагинов (Unknown).

## 8. Evidence appendix

### 8.1 Наблюдаемые команды и результаты

| Команда | Результат |
| --- | --- |
| `git status --short` | `?? docs/research/` (в начале и в конце) |
| `git branch --show-current` | `dev` |
| `git log -1 --oneline` | `d10f0b69 Выпустить macOS Preview 3.17.102.` |
| `CodeIndex status` | `ready`, `partial: false`, generation 1456, 10007 files, 278154 symbols |
| `npx vitest run packages/ui/test/gitGraphLayout.test.ts --project unit` | 1 file, 8 tests passed |
| `npx vitest run packages/services/test/gitService.test.ts packages/services/test/gitCheckpointService.test.ts --project fork-isolated` | 2 files, 20 tests passed (реальные git init/commit внутри тестов) |
| `npx vitest run packages/services/test/gitCommitMessageGenerator.test.ts packages/services/test/gitCliRepo.test.ts packages/ui/test/gitBranchSwitcher.test.ts packages/ui/test/gitActionMenuDisplay.test.ts --project unit` | 4 files, 29 tests passed |
| `npx vitest run packages/ui/test/gitRepositoryRefresh.test.ts packages/ui/test/diffViewerComponent.test.ts packages/ui/test/patchDiffPreview.test.ts packages/ui/test/v4ConversationStatusPanelGitReview.test.ts --project unit` | 4 files, 32 tests passed |
| `npx vitest run packages/zcode-server-cli/test/coreHttp.test.ts packages/zcode-server-cli/test/serverCore.test.ts --project unit` | 2 files, 15 tests passed |
| `npx vitest run packages/services/test/conversationShareSanitize.test.ts packages/web/test/conversationSharePreviewClient.test.ts packages/ui/test/conversationSharePreflightResponse.test.ts --project unit` | 3 files, 28 tests passed |
| `npx vitest run apps/dev-docs/test --project unit` | «No test files found» — тесты dev-docs не входят в root unit project (ожидаемо по `vitest.config.ts` include) |
| `npx vitest run ... --reporter=basic` | ошибка загрузки reporter (не влияет на выводы; заменено на `--project unit`) |
| `node -e "require('./third-party/inventory.json')"` | 1219 packages, 12 copied, 19 reviewRequired |
| `find packages/zcode-server-cli/test/*.test.ts | wc -l` | 32 |
| `find packages/desktop/test/e2e -name '*.test.ts' | wc -l` | 575 |
| `git ls-files packages/android | wc -l` | 44 |
| `git ls-files third-party | wc -l` | 211 |
| `git ls-files scripts | wc -l` | 190 |

### 8.2 Точечные ссылки на первоисточники

**Git domain**
- `packages/services/src/git/git.ts:32-55` — `IGitService`.
- `packages/services/src/git/gitService.ts:20-28, 114-121, 148-168, 226-355` — scoping, commit-message diff queries, refresh.
- `packages/services/src/git/repo/gitCliRepo.ts:638-706` — выбор remote; `:855-918` — status; `:1009-1069` — log; `:1071-1250` — branch; `:1252-1369` — diff; `:1371-1421` — branch comparison; `:1423-1487` — stage/unstage/discard; `:1488-1636` — commit (temp index); `:1638-1673` — push; `:1675-1711` — identity.
- `packages/services/src/git/repo/gitCliHelpers.ts:66-167` — branch issue parsing; `:169-203` — success/timeout/truncation; `:244-359` — porcelain v2; `:455-487` — untracked stats; `:585-658` — diff result; `:683-717` — path containment/repo availability.
- `packages/services/src/git/config.ts:4-16, 34-77` — budgets, env sanitization.
- `packages/services/src/git/providers/gitCommandProvider.ts:76-230` — spawn/timeout/force-kill/truncation.
- `packages/services/src/git/gitCommitMessageGenerator.ts:10-21, 57-173, 224-255` — prompt/limits/validation.
- `packages/services/src/git/commitMessageFileScope.ts:24-97` — session file scope.
- `packages/services/src/git/gitCheckpointService.ts:63-110`; `repo/gitCheckpointRepo.ts:255-493`; `repo/gitCheckpointStore.ts:23-98`.
- `packages/shared/src/git.ts:7, 26-35, 260-264` — source ids, issue codes, checkpoint conflict reasons.

**Git UI**
- `packages/ui/src/GitPane.tsx:43-546` (особенно `:182-267`, `:302-323`, `:325-362`).
- `packages/ui/src/GitPaneChangeCard.tsx:128-142, 160-226`.
- `packages/ui/src/GitActionMenu.tsx:989-1059, 1081, 1107-1244, 1253-1290`.
- `packages/ui/src/hooks/useGitBranchSwitcher.ts:252-356`.
- `packages/ui/src/hooks/useGitActions.ts:7-64` (заглушка).
- `packages/ui/src/hooks/useGitRepository.ts:316-345, 398, 466, 551`.
- `packages/ui/src/git-graph/GitGraphDialog.tsx:26`; `packages/ui/src/GitBranchSwitcher.tsx:18, 330, 362-366`.
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx:1352-1368`.
- `packages/ui/src/v4/ConversationStatusPanel.tsx:413-432, 449-456`.
- `packages/ui/src/lib/workspaceSidePane.ts:1-90`.
- `packages/ui/src/components/ui/diff-viewer.tsx:6-7, 44-100`; `packages/ui/src/GitPane/helpers.ts:10-11, 118-170`.

**PR/CI (absence)**
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts:52, 65, 77, 97, 104, 128`.
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-core.ts:24`.
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-gh-rate-limit.ts:7`.
- `packages/ui/src/v4/featureSuggestedPrompts.ts:441, 445`; `packages/ui/src/v4/officeSuggestedPrompts.ts:37-44`.

**Editor/LSP/notebook**
- `apps/zcode-cli/packages/core/src/tool/provider-visible-order.ts:11-27` (LSP, NotebookEdit, EnterWorktree).
- `apps/zcode-cli/packages/adapters/src/plugins/index.ts:112`; `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts:497`.
- `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts:193-198`; `handlers/read.ts:95`.
- `apps/zcode-cli/packages/contracts/src/workflow/script.ts:42-49`; `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts:282-284`.
- `packages/ui/src/components/ui/code-viewer.tsx:11-12, 44-69, 359-362, 455-540, 680-762`.
- `packages/ui/src/terminal/TerminalSession.tsx:1-4`; `packages/services/src/terminal/terminal.ts:11-25`.
- `packages/services/src/file/file.ts:21-81` (нет write-операций).
- `packages/ui/src/workspace-file-tree/*` (read-only дерево).
- `docs/specs/desktop-editor-detection.md`.

**Share/distribution**
- `packages/shared/src/conversation-share.ts:59-63, 73, 249-250, 271-272, 345-347`.
- `packages/services/src/conversation-share/conversationShareHttpClient.ts:229, 253, 277, 291, 301, 317, 540`.
- `packages/services/src/conversation-share/conversationSharePublicProjection.ts:67-77, 179-182, 520-640`.
- `packages/services/src/conversation-share/conversationShareService.ts:2018`.
- `packages/ui/src/v4/ConversationShareConfirmationDock.tsx:117-130, 495-540`.
- `packages/ui/src/store/conversationShareSelectionStore.ts:6-7`.
- `packages/web/src/share/conversationShareRoute.ts:1-18`; `ConversationShareLandingPage.tsx:14, 121-122, 167-168, 643-670`.
- `packages/web-share/src/main.tsx:2, 7-15, 38-43, 76-86`; `web-share/vite.config.ts:1-62`.
- `packages/share-ui/src/index.ts` (6 строк), `src/styles.css` (1 строка), `package.json` (deps).
- `packages/desktop/src/main/desktopOAuthDeepLink.ts:50-70, 318`; `packages/shared/src/channels.ts:391`.
- `packages/ui/src/conversation-share-interaction/CONTRACT.md:9`.

**Residual packages**
- `packages/zcode-server-cli/package.json:1-30`; `tsup.config.ts:27-31`; `src/cli.ts:107-205`; `src/server-core/core.ts:21`; `src/server-core/http.ts:197-306`; `src/server-core/ingressToken.ts:5-16`.
- `packages/zcode-cua/index.js:1-13`; `broker.js:39-41`; `package.json:5,61`; `test/availability.test.ts`.
- `packages/formal-proof/README.md`; `src/model.ts:1-40`; `bootstrap/package.json:45`; `bootstrap/tests/formal-proof-consistency.test.ts:18`; `scripts/bootstrap.mjs:209`.
- `packages/stream-animate/src/server/index.ts:1-21`; `src/server/deepseekRunner.ts:1-30`; `scripts/bootstrap.mjs:169-187`.
- `packages/e2e-report/src/node/index.ts:1-35`; `packages/desktop/package.json:35,38,47,71`; `packages/desktop/test/e2e/reporting/e2e-reporting-summary.ts:5`; `packages/desktop/tsconfig.e2e.json:10`.
- `packages/android/app/build.gradle.kts:1-70`; `app/src/main/AndroidManifest.xml:1-69`; `remote/RemoteControlUrlPolicy.kt:1-80`; `androidTest/.../ExampleInstrumentedTest.kt:20-22`.
- `apps/dev-docs/package.json`; `apps/dev-docs/test/*.test.ts`.
- `third-party/SPEC.md`; `third-party/inventory.json`; `scripts/knip-baseline.json:106-108,134`.
- `docs/architecture/r2-server-cli-and-daemon.md:5`.
- `docs/git/requirements.md:29-33`; `docs/git/checkpoint-service-foundation.md:7,21`; `docs/git/git-graph.md`.
- `docs/web-share/web-share-static-deployment.md:12-20,60`.

### 8.3 Ограничения этого partial

- Не запускались E2E Desktop (WDIO), включая `git-commit-dialog-ui-flow.test.ts` и share-сценарии в `manual-review/pending`.
- Не запускались `pnpm typecheck`, `pnpm lint`, `pnpm build:web-share`, Gradle-сборка Android и полный unit suite.
- Не проверялись внешние сервисы: `/api/v1/shares/*`, GitHub/GitLab API, CDN-иконки, Jenkins/registry.
- Выводы о reachability `zcode-server-cli` опираются на исходники + архитектурный документ; реальный запуск Supervisor/Core не выполнялся.
- Утверждения о поведении на unborn HEAD, о TTL share-ссылок и о внешнем деплое отмечены как Unknown/Inferred.

## Coverage status

- Покрыты все 8 обязательных разделов; темы 16–17 и все перечисленные residual-пакеты описаны с file:line.
- Для каждого residual-пакета дан verdict reachability (§2.2) и указаны тесты/их отсутствие.
- Проверено исполнением: 6 успешных узких unit/fork-isolated прогонов (всего 132 теста, все прошли); 2 запуска завершились до сбора тестов (неверный reporter, dev-docs вне root project) — см. §8.1.
- Не проверено: E2E, typecheck/lint, сборки, внешние API, Android Gradle, полный unit suite.

## Not-checked list

1. Desktop E2E Git (`git-commit-dialog-ui-flow.test.ts`) и share E2E (5 pending specs).
2. `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check`, `pnpm knip`.
3. Сборка `build:web-share`, `build:docs`, `build:cua`, Gradle `assembleDebug`.
4. Полный `pnpm test:unit` (запускались только перечисленные файлы).
5. Реальный запуск `zcode-server-cli` (`serve`/Supervisor/Core) и проверка ingress извне.
6. Внешние сервисы: backend share, GitHub/GitLab, CDN.
7. Поведение на unborn HEAD, submodule, worktree-репозитории для discard/unstage.
8. Мобильный share-entry (по контракту отсутствует; UI-проверка не выполнялась).

> Подтверждение: в рамках этой ветки записан **только** файл `docs/research/partials/2026-11-11-zcode-13-git-pr-editor-residual-packages.md`; production-файлы не изменялись, коммиты не создавались, деструктивные git-команды не выполнялись.
