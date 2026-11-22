# Z08 — Инструменты, среда исполнения, провайдеры и модели

> Research-only артефакт. Продуктовый код, конфиги, lockfile и тесты не изменялись.
> Дата исследования: 2026-11-11. Ветка `dev`, HEAD `d10f0b69` («Выпустить macOS Preview 3.17.102.»).
> Корень репозитория: `<repo-root>`.
> Метки: **Observed** — прямо подтверждено источником/командой; **Inferred** — вывод из косвенных данных; **Unknown** — источники не дают ответа.

## 1. Scope and method

### 1.1. Preflight (Observed)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

- Индекс кода: `CodeIndex status` → `state: "ready"`, `partial: false`, generation 1453, files 10007, chunks 26791, symbols 278154, edges 377669; диагностика `Embedding search is unavailable; showing lexical results.` (Observed).
- Skill `research` загружен по точному имени через `Skill`; применена его дисциплина: primary sources, разделение фактов/гипотез/неизвестного, запрет выдавать неинспектированный результат за факт.

### 1.2. Что именно проверялось

Только read-only команды: `git status/branch/log`, `find`, `rg`, `grep`, `nl -ba`, `sed -n`, `wc`, `awk`, точечные `vitest run` для узких наборов. Не запускались: `pnpm typecheck`, `pnpm lint`, полный unit-набор, E2E, сборки SEA/desktop, реальные сетевые вызовы провайдеров, Windows-рантайм.

Границы охвата: агентские tool-хендлеры и реестр в `apps/zcode-cli/packages/core`, исполнительный адаптер в `apps/zcode-cli/packages/adapters`, контракты `apps/zcode-cli/packages/contracts`, сервис индекса `packages/services/src/code-intelligence`, провайдерный конфиг/реестр `packages/provider`, model runtime `apps/zcode-cli/packages/adapters/src/model`, bootstrap-обвязка `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts`, тесты соответствующих пакетов.

### 1.3. Как читать матрицы

- «Регистрация» — попадает ли `ToolEntry` в `builtInTools` и какие гейты (`options.*`) его включают.
- «Границы» — проверка пути/воркспейса и sandbox; отдельно отмечено, где граница намеренно не блокирует.
- «Бюджет» — лимит inline/model-байтов и стратегия (`truncate`/`artifact`).
- «Тесты» — существующие тестовые файлы; факт их прогона в этом исследовании указан отдельно в §2 и §8.

## 2. Coverage table

| Область | Покрыто | Статус | Ключевое доказательство | Остаточный пробел |
|---|---|---|---|---|
| Tool registry / contracts | Реестр, aliases, provider-visible фильтрация, `toContracts` | complete | `apps/zcode-cli/packages/core/src/tool/registry.ts:30-129`; `.../tool/types.ts:310-409`; тест `core/tests/tool-contracts.test.ts` (49 тестов, run) | Нет проверки, что каждый зарегистрированный tool имеет прогоняемый контрактный тест на malformed input |
| Tool executor lifecycle | validate → resolveInput → hooks → permission → timeout → handler → output validation → serialize → post-hook | complete | `.../tool/executor/call-runner.ts:72-108,236-471,564-767`; `.../executor/validation.ts:9-120`; `.../executor/timeout.ts:19-229` | Нет executor-level дедупликации повторного `toolCallId` (см. G-08) |
| Scheduling / concurrency | topological sort, parallel groups, max 10 | complete | `.../tool/scheduler.ts:48,60-227`; `.../executor/impl.ts:97`; `.../executor/batch-runner.ts:24-55` | Зависимости между tool-call’ами фактически пустые: `runtime/methods/tools.ts:42-57` ставит `dependsOn: []` |
| File tools | Read/Write/Edit, read-state, freshness, encoding | complete | `.../handlers/read.ts:141-251,464-526`; `.../write.ts:66-187,278-360`; `.../edit.ts:84-252` | Workspace boundary намеренно открыт (G-02) |
| ApplyPatch | Парсер, verify-before-write, encoding, тесты | complete, но tool не зарегистрирован | `.../handlers/apply-patch.ts:49-118`; `.../tool/patch-parser.ts:21-69`; `.../tool/patch-apply.ts:11-68`; `.../tool/handlers/index.ts:90` | Нет multi-file транзакции/rollback (G-07) |
| Bash / execution adapter | shell selection, cwd, env, timeouts, output, process tree, Windows | complete (код) | `.../handlers/bash.ts:150-259,418-540`; `adapters/src/exec/node-execution-adapter-run.ts:131-521`; `.../exec/node-execution-adapter-process.ts:62-267`; `.../exec/process-tree.ts:7-122` | Реальный Windows-прогон не выполнялся; sandbox не enforced |
| Background tasks | explicit/auto background, TaskOutput, TaskStop, notifications, catalog | complete | `.../executor/background-tasks.ts:86-810`; `.../executor/background-task-registry.ts:47-117`; `.../handlers/task-output.ts:52-256`; `.../handlers/task-stop.ts:29-97` | `assistantAutoBackgrounded`/`backgroundedByUser` не имеют продюсера (G-09) |
| Glob / Grep | Поиск файлов/текста, ripgrep WASM, JS fallback, лимиты | complete | `.../handlers/glob.ts:20-82`; `.../handlers/grep.ts:23-138`; `adapters/src/fs/index.ts:393-471,510-574,924-979,1811-1834` | Glob не применяет ignore-файлы (G-04); ripgrep-ignore поведение не проверено |
| Embedded search branch | Bash prelude c find/grep, capability gate | complete | `core/src/embedded-search/capability.ts:4-44`; `core/src/embedded-search/shell.ts:5-15`; `adapters/src/exec/embedded-search-prelude.ts:34-71` | Документация и код расходятся по видимости Glob/Grep (G-11) |
| Code index | Scanning, ignore, secrets, incremental, graph, search, watcher, limit | complete (сервис) | `packages/services/src/code-intelligence/scanner.ts:74-108,438-553`; `.../codeIntelligenceService.ts:621-720`; `.../workspaceWatcher.ts:5-103`; `.../CONTRACT.md:1-27` | Только JS/TS; embedding-поиск зависит от внешнего endpoint |
| MCP tools | Dynamic ToolEntry, paging, approval, CUA authority | complete | `core/src/mcp/index.ts:48,159-357,403-494` | Сетевой MCP не поднимался |
| WebFetch / WebSearch | SSRF-guard, redirects, cache, native web search | complete | `.../handlers/webfetch.ts:52-99`; `.../webfetch-egress-guard.ts:14-28`; `.../webfetch-url.ts:10-45`; `.../handlers/websearch.ts:60-126`; `contracts/src/tools/websearch.ts:123-163` | Реальные внешние запросы не выполнялись |
| Provider config / registry | 4 API type, access modes, validation, registry view | complete | `packages/provider/src/config/provider-data-schema.ts:4-9`; `packages/provider/src/registry.ts:47-139`; `packages/provider/src/resolver.ts:117-180` | Провайдерные тесты пакета не прогонялись |
| Model adapters | AI SDK factories, transforms, strict schema, tool-call assembly | complete | `adapters/src/model/model-execution.ts:517-553,837-872`; `.../model/tool-transform.ts:40-99,313-361`; `.../model/strict-tool-schema.ts:50-64`; `.../model/streaming-tool-call-assembler.ts:24-116` | Нет матричного wire-теста на все 4 формата × все tool-фичи |
| Retries / rate limits / fallback | 11 attempts, backoff, Retry-After, quota switch | complete | `.../model/retry-policy.ts:13-49`; `.../model/runner-retry.ts:41-108`; `.../model/failure-classifier.ts:290-317`; `core/src/runtime/methods/provider-quota-fallback.ts:14-113`; `bootstrap/src/app/provider-registry-model-runtime.ts:70-122` | Порог Retry-After расходится 300s vs 600s (G-05) |
| Tokens / cost | Provider usage, token estimation, UI cost | partial | `contracts/src/model/index.ts:531-559`; `core/src/context/utils.ts:12-18`; `runtime/methods/turn-step-finish.ts:29`; `packages/ui/src/components/ai-elements/context.tsx:224-236` | В рантайме нет расчёта стоимости и бюджетов (G-06) |
| Tests | Контракты, scheduler, file-tool, Bash, retries, quota, index | partial | см. §8 | Sandbox/Windows/PTY/стоимость не покрыты |

## 3. Capability inventory

### 3.1. Реестр и конвейер исполнения

- `builtInTools` содержит **47** `ToolEntry`-записей; `applyPatchToolEntry` присутствует только закомментированной строкой (Observed: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts:83-154`, строка `90` — `// applyPatchToolEntry,`; подсчёт `awk`/Python по списку).
- `registerBuiltInTools` фильтрует по `allowedTools`/`disallowedTools`, гейтам `includeAgent`, `includeSkill`, `includeSendMessage`, `includeRespondToCoordinator`, `includeSubmitResult`, `includeEscalate`, `includeWorkflow`, `includeAutomation`, `includeOffPeak`, `includeDynamicWorkflow=false`, `includeNodeRepl`, `includeCodeIndex` (Observed: `.../handlers/index.ts:222-306`).
- `ToolRegistry` отклоняет alias-конфликты, canonical всегда приоритетнее alias (Observed: `.../tool/registry.ts:34-71`; тест `core/tests/tool-registry-alias.test.ts`, 2 теста, run).
- `toContracts()` отдаёт provider-visible контракты с `inputSchema`, `outputSchema`, `readOnly`, `destructive`, `concurrentSafe`, `resultBudget`, `permission` и без `execute` (Observed: `.../tool/registry.ts:104-129`).
- Порядок provider-visible: сначала отсортированный эталонный список из 29 имён, затем локальные инструменты (Observed: `.../tool/provider-visible-order.ts:1-51`). В списке есть имена без реализации (`LSP`, `NotebookEdit`, `EnterWorktree`, `TaskCreate` и т.д.) — это признак зарезервированных/будущих имён, а не зарегистрированных tools (Observed: `.../provider-visible-order.ts:11-27`; `rg` по `name: "LSP"|NotebookEdit` не находит регистрации; `NotebookEdit` упоминается только в сообщении Edit и списках).
- Дефолтная конкурентность: `DEFAULT_MAX_CONCURRENCY = 10` в scheduler и `maxConcurrency: options.maxConcurrency ?? 10` в executor (Observed: `.../tool/scheduler.ts:48`; `.../executor/impl.ts:97`).
- Планировщик параллелит `readOnly`, `concurrentSafe`, `sideEffectScope === "none"`; `destructive`/`concurrentSafe: false` выполняются одиночными группами; циклы зависимостей — ошибка (Observed: `.../tool/scheduler.ts:85-103,105-152,154-202`; тест `scheduler.test.ts`, 10 тестов, run).
- Фактическая передача зависимостей: runtime строит `dependsOn: []` для всех calls, т.е. topo-sort вырожден, а параллельность определяется только safety-флагами (Observed: `core/src/runtime/methods/tools.ts:42-57`).
- Executor: ранний abort, проверка `inputSchema` + runtime Zod, tool-specific `validateInput`, `resolveInput` (нормализация до hook/approval), PreToolUse, permission, `prepareApproval`/input adjustments, `emitToolCallStarted`, handler с `ToolDeadline`, `validateOutput`, сериализация с бюджетом, PostToolUse, `emitToolCallResult`/`emitToolCallError`, фоновый трекер (Observed: `.../executor/call-runner.ts:221-767`).
- `ToolDeadline` ставит таймер только после допуска и умеет ставиться на паузу на время queue в model admission (Observed: `.../executor/timeout.ts:19-91,93-179`; тест `tool-deadline.test.ts`, 9 тестов, run).
- `resolveTimeoutMs`: `kind:"none"` → без таймера; иначе default/max и `cleanupGraceMs` (Bash +6000ms, js +2000ms) (Observed: `.../executor/timeout.ts:181-204`; `.../handlers/bash.ts:523-528`; `.../handlers/node-repl.ts:400-405`).
- Сериализация результата: effective budget = `entry.resultBudget` или default 100000/100000/truncate/head; `artifact`-стратегия пишет tool artifact и отдаёт preview; иначе suffix с `originalBytes/maxModelBytes/strategy` (Observed: `.../executor/result-serialization.ts:34-41,55-232`).
- Пустой результат получает placeholder `(<Tool> completed with no output)` (Observed: `.../executor/result-serialization.ts:58-69`).

### 3.2. Матрица tool-возможностей

| Tool(ы) | Регистрация / гейт | Вход и валидация | Границы пути / sandbox | Выход и лимиты | Таймаут / отмена | Конкурентность | Тесты |
|---|---|---|---|---|---|---|---|
| `Read` | всегда (`handlers/index.ts:87`) | `ReadInputSchema` (Zod), preflight custom issues для PDF/device/binary, `validateInput` для `pages` (`handlers/read.ts:253-310`; `contracts/src/tools/read.ts:65-150`) | `resolveWorkspacePath(..., "read")`; вне workspace разрешено (`tool/path-policy.ts:32-39`); device/binary блокируются схемой (`contracts/src/tools/read.ts:50-63,129-150`) | 256 KiB файл, 25k токенов, дефолт 2000 строк в описании; текст/изображение/видео/PDF; `file_unchanged` при повторном чтении (`contracts/src/tools/read.ts:15-23`; `handlers/read.ts:55-68,186-198`) | 30s, PDF до `READ_PDF_TOOL_TIMEOUT_MS`; cancel → `ToolCancelled` (`handlers/read.ts:464-526`) | `concurrentSafe: true` | `file-tool-port.test.ts` (32), `read-tool-contract.test.ts` (29+13 skip) |
| `Write` | всегда (`index.ts:88`) | `WriteInputSchema`; read-before-write + freshness (`handlers/write.ts:278-337`) | `resolveWorkspacePath(..., "write")`; вне workspace разрешено (`path-policy.ts:36-39`) | output 1 MB, model 100 KB; atomic write, expectedRevision (`handlers/write.ts:125-136,211-266`) | 30s; cleanup bestEffort (`:250-259`) | `concurrentSafe: false` | `write-tool-contract.test.ts` (strict-часть skip по env), `file-tool-port.test.ts` |
| `Edit` | всегда (`index.ts:89`) | `EditInputSchema`; no-op/empty path/notebook/missing/read-state; fuzzy-match стратегии (`handlers/edit.ts:104-251`; `edit-matchers.ts:41-69`) | `resolveWorkspacePath(..., "write")` | 1 GB верхний предел файла (`edit.ts:61,148-153`); model 100 KB (`:284-292`) | 30s | `concurrentSafe: false` | `edit-tool-contract.test.ts` (много кейсов, run) |
| `ApplyPatch` | **не зарегистрирован**: строка закомментирована (`handlers/index.ts:90`) | `ApplyPatchInputSchema` — только `patch_text` (`contracts/src/tools/apply-patch.ts:10-14`) | `resolveWorkspacePath(..., "write")` для add/update/delete/move (`handlers/apply-patch.ts:286-296`) | add/delete/update/move; diff summary; output 1 MB/model 100 KB (`:325-364`) | 30s | `concurrentSafe: false` | `file-tool-port.test.ts:868-955` (handler-level) |
| `Bash` | всегда; пересоздаётся `createBashToolEntry` (`handlers/index.ts:302-317`) | `BashInputSchema`: `command`, `timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox`; нет `cwd`/`env` (`contracts/src/tools/bash.ts:32-72`) | cwd = session cwd (`handlers/bash.ts:444-448`); успешный cwd внутри workspace сохраняется, вне — reset + stderr suffix (`bash-cwd-policy.ts:33-49`); sandbox-запрос формируется, но не enforced (G-01) | inline 30 KB, runtime persisted до 5 GiB, tail preview, merged stdout/stderr (`handlers/bash.ts:80-81,452-457`; `adapters/src/exec/bash-file-output.ts:9,66-88`) | default 120s, max 600s, env override `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` (`tool/bash-timeout-policy.ts:6-35`); auto-background по таймауту кроме `sleep` (`bash-background-policy.ts:3-9`) | `concurrentSafe: false`, но read-only команда динамически помечается readOnly/none (`handlers/bash.ts:96-141`) | `bash-handler.test.ts` (96), `bash-permission.test.ts` (12), `exec.test.ts` (125, run) |
| `Glob` | всегда (`index.ts:92`) | `GlobInputSchema`; пустой pattern → `invalid_pattern` (`handlers/glob.ts:25-54`; `adapters/src/fs/index.ts:401-407`) | `resolveWorkspacePath(..., "read")`; вне workspace разрешено | 100 результатов, сортировка по mtime, 100 KB model (`handlers/glob.ts:20-21,72-81`; `fs/index.ts:430-446`) | 30s | `concurrentSafe: true` | `file-tool-port.test.ts` |
| `Grep` | всегда (`index.ts:93`) | `GrepInputSchema`; ripgrep-совместимые поля (`handlers/grep.ts:32-105`) | `resolveWorkspacePath(..., "read")`; вне workspace разрешено | 20 KB model; default head_limit 250; `max-columns 500`; VCS dirs исключены (`handlers/grep.ts:23`; `fs/index.ts:52,932-945`) | 30s, ripgrep worker terminate по abort/timeout (`fs/index.ts:1029-1098`) | `concurrentSafe: true` | `file-tool-port.test.ts` |
| `CodeIndex` | `includeCodeIndex: Boolean(deps.codeIntelligencePort)` (`runtime/helpers/runtime-tools.ts:84`) | discriminated union `status/search/context/impact/trace`; пути только workspace-relative; limit 1..12 (`handlers/code-index.ts:6-21`) | нет доступа вне workspace по схеме; порт `CodeIntelligencePort` (`handlers/code-index.ts:31-36`) | 24 KB; deferred (`shouldDefer: true`) (`:46-89`) | 120s (`:90-95`) | `concurrentSafe: true` | `core/tests/code-index-turn-hint.test.ts` (4), `tool-input-validation-error.test.ts`; сервисные тесты |
| `ToolSearch` / `DeferredToolCall` | всегда; `DeferredToolCall` только local mode (`search/exposure.ts:106-120`) | `ToolSearchInputSchema`; select:/keyword search (`handlers/tool-search.ts:34-50`; `search/search.ts:25-107`) | только каталог/реестр | 100 KB; 10s | 10s (`handlers/tool-search.ts:68`) | `concurrentSafe: true` | `tool-search-*.test.ts` (много) |
| `TaskOutput` / `TaskStop` | всегда; Stop aliases (`handlers/task-stop.ts:99-100`) | `task_id`/legacy `shell_id`; TaskOutput `block`/`timeout` (`handlers/task-output.ts:52-117,205-220`) | доступ к runtime task registry + session catalog; archived output path проверяется (`task-output.ts:222-256`) | TaskOutput default 32k, max 160k, persist threshold 100k, budget 400k (`:40-44`); TaskStop 100 KB (`task-stop.ts:14`) | TaskOutput `kind:"none"`; TaskStop 10s (`task-output.ts:168-170`; `task-stop.ts:141-144`) | `concurrentSafe: true` | `task-output-tool.test.ts` (10+), `task-stop-tool.test.ts` |
| `Agent` / `Task` | `includeAgent === true`; Task alias видим только при `includeTaskAlias` (`handlers/index.ts:246-248,329-336`) | `AgentInputSchema` / `TaskInputSchema`; task graph validation (`handlers/agent.ts:559-615`) | дочерний runtime сам применяет tool allowlist | 120 KB model, artifact (`agent.ts:26,589-601`) | `kind:"none"` (`:602`) | `concurrentSafe: true` | `tool-contracts.test.ts`, `subagent-*` |
| `Skill` / `SkillSearch` / `SkillInstall` | `includeSkill !== false` (`handlers/index.ts:249-256`) | Skill input schema; marketplace tools | сессионный контекст; marketplace — сеть/диск | Skill budget = `WORKFLOW_SKILL_MAX_BYTES (200000) + SKILL_RESULT_WRAPPER_BYTES (4096)` = 204096 (`handlers/skill.ts:25-31`), 30s (`:98-160`) | 30s | `concurrentSafe: true` | `skill-tool.test.ts`, `skill-marketplace-tool.test.ts` |
| `TodoRead` / `TodoWrite` | всегда | todo schema; Write replace-all semantics (`handlers/todo.ts:74-160`) | session state | малый model budget | 30s | Read safe=true, Write safe=false (`todo.ts:82,145`) | `todo-tool.test.ts` |
| `WebFetch` | всегда | URL normalization: только http/https, без credentials, http→https, private IP/localhost запрещены (`webfetch-url.ts:10-45`; `webfetch-egress-guard.ts:14-28`) | egress guard по литералам, DNS preflight намеренно не делается (`:24-27`) | 10 MB response, model 100 KB, cache 15 min/50 MB, max 10 redirects (`webfetch-constants.ts:2-9`) | 60s | `concurrentSafe: true` | `webfetch-tool.test.ts` |
| `WebSearch` | всегда; handler требует `model.properties.supportsNativeWebSearch` (`handlers/websearch.ts:71-80`) | `WebSearchInputSchema`; `allowed_domains`/`blocked_domains`; `maxUses=8` (`:29-32`) | внутренний provider-native web_search | inline 10k/model 20k (`contracts/src/tools/websearch.ts:138-146`) | 60s default / 120s max (`:147-151`) | `concurrentSafe: true` | `websearch.test.ts` |
| MCP tools | dynamic, providerVisible по `mcpPresentation.ui.visibility`, `shouldDefer: true` (`mcp/index.ts:159-258`) | input schema из descriptor + paging fields; `needsApproval: true` (`:185,228-232`) | внешний server; `permission: "mcp"`, pattern sources `toolName/input/network` (`:259-267`) | 100k inline/50k model для обычных; 1M/64k для node_repl; 256k для official CUA (`:187-210`) | 30s default или descriptor timeout (`:48,186`) | `concurrentSafe` = readOnly или idempotentHint (`:237`) | `tool-search-mcp.test.ts`, `mcp-*` |
| `js` (node_repl) | `includeNodeRepl === true` (`handlers/index.ts:296-298`) | `JsInputJsonSchema`; persistent globalThis per session (`handlers/node-repl.ts:364-412`) | `sideEffectScope: "system"`, risk high, approval true (`:371-377`) | 1M inline, `JS_MAX_MODEL_OUTPUT_BYTES = 64 KiB` model, artifact/tail (`node-repl.ts:285,393-399`) | 30s default, 120s max, cleanup grace 2s (`:400-405`) | `concurrentSafe: false` | `node-repl-*.test.ts` |
| `Cron*`, `OffPeak*` | `includeAutomation` / `includeOffPeak` (`handlers/index.ts:275-289`) | свои схемы; subagent исключён (`runtime-tools.ts:72-75`) | сессионные/automation порты | стандартные бюджеты | свои таймауты | по метаданным | `cron-tool.test.ts`, `off-peak-tool.test.ts` |
| `EnterPlanMode` / `ExitPlanMode` | всегда | plan-mode schema/prompt (`handlers/plan-mode.ts:143`) | read-only policy в plan mode (`permission/service.ts:470-512`) | стандарт | 30s | по метаданным | `plan-mode-tool.test.ts` |
| `AskUserQuestion` | всегда | schema, `requiresUserInteraction: true` (`handlers/ask-user-question.ts:71-110`) | interaction | малый model budget | 30s | `concurrentSafe: true` | `ask-user-question-tool.test.ts` |
| `SendMessage` / `RespondToCoordinator` / `submit_result` / `escalate` | гейты портов (`handlers/index.ts:257-271`) | соответствующие схемы; `submit_result` typed schema опционально (`:318-320`) | session/subagent/workflow | стандарт | по метаданным | по метаданным | `submit-result-tool.test.ts`, `coordinator-response.test.ts` |
| `ReadSessionContext` / `ReplyToChannel` | всегда | схемы | session | стандарт | по метаданным | по метаданным | `read-session-context-tool.test.ts`, `reply-to-channel.test.ts` |
| Workflow family (`CreateWorkflow`, `AmendWorkflow`, `SaveWorkflow`, `EvalWorkflowSnippet`, `ListWorkflowRuns`, `GetWorkflowRun`, `ResumeWorkflowRun`, `ResolveWorkflowQuestion`, `FillWorkflowHole`, `ListSavedWorkflows`, `ListModels`) | `includeDynamicWorkflow !== false`; `ListModels` входит в ту же группу (`handlers/index.ts:164-176,290-295`) | свои схемы; `prepareApproval`/`resolveInput` для части (`handlers/create-workflow.ts:409-414`; `fill-workflow-hole.ts:324`) | workflow ports; child disallow list | стандартные/свои бюджеты | свои | по метаданным | `create-workflow-tool.test.ts`, `saved-workflow-tools.test.ts`, `list-models-tool.test.ts` |

### 3.3. Shell / terminal / execution environment

- Bash не вызывает `child_process` напрямую; всё идёт через `ExecutionPort` (Observed: `handlers/bash.ts:156-218`; design `apps/zcode-cli/docs/design/v2/tool/04-bash.md:140-155`).
- Выбор shell: `resolvePosixBashShell` учитывает `$SHELL`, PATH и фиксированные каталоги; Windows — Git Bash из стандартных путей/из `git.exe`, иначе `cmd.exe` (Observed: `adapters/src/exec/bash-shell-provider.ts:36-105,159-236,302-341`).
- POSIX запуск: `<shell> -c -l <command>`; при наличии shell-init snapshot — `-c <command>` после source snapshot (Observed: `execution-command.ts:142-164`; `node-execution-adapter-process.ts:79-108`; docs `docs/runtime-tools/bash-effective-shell-snapshot.md:30-52`).
- Windows: `.cmd`/`.bat` идут через `cmd.exe /d /s /c` с quoting; обычные `.exe` — `shell:false`; `windowsHide: true`; `detached` только non-Windows (Observed: `execution-command.ts:118-139,242-251`; `node-execution-adapter-process.ts:125-136`).
- Env: копируется process env, вычищаются runtime-переменные (`sanitizeZCodeRuntimeEnvInPlace`), применяются network egress env, затем `unset`/`set` overlay; Bash tool не принимает env от модели (Observed: `execution-command.ts:28-69`; `handlers/bash.ts:437-449`).
- Cwd: `resolveToolWorkingDirectory(undefined, ...)` всегда даёт session cwd; после успешного exitCode 0 в main scope cwd внутри workspace сохраняется, вне workspace сбрасывается и в stderr добавляется `Shell cwd was reset to ...` (Observed: `handlers/bash.ts:236-247,444-448`; `bash-cwd-policy.ts:33-49`).
- Таймауты: default 120000ms, max 600000ms; `resolveBashTimeoutMs = min(input || default, max)`; админ может переопределить через `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` (Observed: `tool/bash-timeout-policy.ts:6-35`; `bootstrap/src/app/runtime-config.ts:130`).
- Background: `run_in_background` требует `runBashWithBackgroundLifecycle`; иначе configuration error (Observed: `handlers/bash.ts:188-200`). Авто-перевод по таймауту выполняется для любой команды, кроме первой `sleep` (Observed: `bash-background-policy.ts:3-9`; `node-execution-adapter-lifecycle.ts:209-241`).
- Вывод: Bash пишет merged stdout/stderr напрямую в один файл, Node collector не участвует; inline limit 30 KB; persisted limit 5 GiB; watchdog каждые 5 секунд; progress tail 4 KB; при превышении — stop (Observed: `node-execution-adapter-run.ts:313-325,366-393`; `bash-file-output.ts:9,66-88`; `execution-utils.ts:9-16`).
- Отмена/таймаут: `requestStop` → `terminateProcessTree`; POSIX — SIGTERM группе + snapshot потомков, затем SIGKILL через 1500ms; Windows — `taskkill /pid <pid> /T /F`; force-exit таймер 5s; drain 1s (Observed: `node-execution-adapter-run.ts:251-288`; `node-execution-adapter-process.ts:146-200`; `process-tree.ts:7-61`; `execution-utils.ts:12-13`).
- PTY: у агентского Bash нет PTY — spawn с pipe/file fd (Observed: `node-execution-adapter-process.ts:125-136`). PTY есть только в desktop terminal service (`packages/services/src/terminal/terminalService.ts:1-20`, `node-pty` в `packages/desktop/package.json:83`, `packages/services/package.json:31`). Следствие (Inferred): интерактивные TUI-команды в агентском Bash не поддерживаются; это согласуется с prompt-ом «Interactive flags ... are not supported» (`core/tests/tool-contracts.test.ts:456`).
- Windows Job Object используется только для MCP stdio transport (`adapters/src/mcp/stdio-transport.ts:63`; `adapters/src/mcp/windows-job-object.ts:27-60`), не для Bash.
- Windows output encoding: при не-UTF8 code page выполняется `chcp` и декодирование через `iconv`; переопределение `ZCODE_WINDOWS_OUTPUT_ENCODING` (Observed: `outputEncoding.ts:5,148-170,204-215,263`).

### 3.4. Поиск и code index

- `Glob` обходит дерево рекурсивно, пропуская только VCS-каталоги из `VCS_DIRECTORIES_TO_EXCLUDE`; ignore-файлы и `node_modules` не учитываются (Observed: `adapters/src/fs/index.ts:54,1708-1731`). Результат режется до 100 и сортируется по mtime (Observed: `fs/index.ts:430-446`). Это осознанно простой обход, но на больших репозиториях он читает всё дерево (Inferred).
- `Grep` использует bundled ripgrep WASI в Worker, с `--no-config --hidden --color never --no-heading --with-filename --max-columns 500`; VCS-каталоги исключены glob’ами; `--json` для content, `-c` для count; `head_limit` по умолчанию 250 (Observed: `fs/index.ts:52,924-979,1240-1260,1811-1834`). Abort/timeout терминируют Worker (Observed: `:1047-1098`). При `RipgrepRuntimeFailure` — JS fallback (Observed: `:459-470`). Использует ли ripgrep `.gitignore` по умолчанию — явно не отключено (`--no-ignore` не передан); можно считать, что да, но это **Inferred**, не проверено тестом.
- `embedded-search`: глобальный флаг `true`; prelude инжектится только для posix/git-bash и только если `embeddedSearch.enabled` и backend задан (Observed: `core/src/embedded-search/capability.ts:4-44`; `shell.ts:5-15`; `handlers/bash.ts:423-436`). Prelude подменяет `find`/`grep` функциями, с fallback на `rg` (Observed: `adapters/src/exec/embedded-search-prelude.ts:34-71,105-160`).
- `CodeIndex` — Host-capability; tool возвращает `code_index_unavailable` (код 41), если порт отсутствует (Observed: `handlers/code-index.ts:23-36`).
- Сервис индекса: только JS/TS-family, файлы ≤1 MiB, ≤20000 файлов, chunks по 120 строк с overlap 12, секреты/ключи/.env исключаются, симлинки пропускаются, применяются root/nested `.gitignore` и `.zcodeignore` (Observed: `packages/services/src/code-intelligence/scanner.ts:74-108,396-436,438-553`; `CONTRACT.md:23-27`).
- Инкрементальность: изменение определяется по mtime/ctime/size, затем sha256 fingerprint; unchanged chunks/embeddings не пересоздаются; graph-parser revision запускает graph-only backfill (Observed: `scanner.ts:477-533`; `codeIntelligenceService.ts:248-345,449-479`; `CONTRACT.md:9-13`).
- Watcher: один нативный recursive watcher на workspace, debounce 300 ms, игнорирует build/dependency каталоги; при `filename === null` — консервативный refresh (Observed: `workspaceWatcher.ts:5-22,54-103`).
- Поиск: lexical score по terms (до 20 терминов, длина ≥2), затем опционально embedding-rerank; `limit` clamp 1..50, default 12; при недоступном embedding возвращает lexical и диагностику (Observed: `database.ts:112-125`; `codeIntelligenceService.ts:621-720`).
- Выдача tool’а ограничена 12 результатами и 24 KB (Observed: `handlers/code-index.ts:13,85-89`).
- Turn hint использует CodeIndex при ready, таймаут 800 ms, до 4 hits и 12k символов, затем жёстко обрезается (Observed: `core/src/runtime/helpers/runtime-reminders.ts:282-337`).

### 3.5. Patches / diffs

- Формат: `*** Begin Patch` / `*** End Patch`, `Add File`, `Delete File`, `Update File`, `Move to`, `@@` hunks, `*** End of File`; CRLF нормализуется, heredoc-обёртка снимается (Observed: `tool/patch-parser.ts:13-69,71-135,158-162`).
- Применение: все секции сначала верифицируются, затем пишутся; update ищет контекст с 4 уровнями сравнения (exact → trimEnd → trim → Unicode-normalized), `End of File` матчит с конца; при ненайденном hunk — ошибка (Observed: `tool/patch-apply.ts:11-132`).
- Кодировки и окончания строк: update/delete читают исходный файл и передают `encoding`/`lineEndings` в запись; add — utf8; при невозможности кодирования legacy-китайских кодировок — ошибка round-trip (Observed: `handlers/apply-patch.ts:176-216`; `adapters/src/fs/text-metadata.ts:63-80`).
- Атомарность: запись каждого файла — `atomic: true` с `expectedRevision` для update; delete/move — отдельные `removeFile` (Observed: `handlers/apply-patch.ts:80-110`; `fs/index.ts:291-328,700-755`). Транзакции на весь patch нет (Inferred из последовательного цикла; см. G-07).
- Diff: `structuredPatch` через пакет `diff` с 3 строками контекста и таймаутом 5s (Observed: `tool/diff.ts:4-30`).
- ApplyPatch не проверяет `readFileState` перед редактированием (в отличие от Edit/Write), только файловую revision (Observed: `handlers/apply-patch.ts:176-216` — нет обращения к `context.readFileState`; ср. `handlers/edit.ts:200-201`, `handlers/write.ts:278-304`). Это важно, если включать tool.

### 3.6. Провайдеры, модели, маршрутизация

| API format | AI SDK factory | Особенности wire | Tool-схемы | Evidence |
|---|---|---|---|---|
| `anthropic-messages` | `createAnthropic` | `createAnthropicCompatFetch`; auth header; baseURL normalization | `strict:true` только для first-party `claude-*`; folding ограничений schema в description; tool search — `tool-reference` | `model-execution.ts:528-536`; `tool-transform.ts:40-50,88-99,207-218,313-336`; `strict-tool-schema.ts:45-64` |
| `openai-responses` | `createOpenAI(...).responses` | `createOpenAIResponsesJsonCompatFetch`; previousResponseId/conversation/store-логика | strict не применяется; provider-native web_search только для разрешённых | `model-execution.ts:518-526`; `transform.ts:370-405`; `tool-transform.ts:344-361` |
| `openai-chat-completions` | `createOpenAICompatible` | `includeUsage: true`; `supportsStructuredOutputs` из model facts | strict не применяется; `empty_tool_name` placeholder для пустого имени | `model-execution.ts:538-551`; `transform.ts:397-404` |
| `opencode-sdk` | `OpencodeProvider` / `createOpencodeServer` | локальный ACP/OpenCode runtime, без baseUrl/headers | отдельная ветка; free-limit/rate-limit остаются в текущем запросе | `model-execution.ts:66,843-847`; `provider-data-schema.ts:4-9,72,109-121,175-180`; `bootstrap/src/app/provider-registry-model-runtime.ts:78-79` |

- Access modes: `api-key`, `local-auth`, `zhipu-account`; для `zhipu-account`/`local-auth` API key не подставляется из конфига; `local-auth` и `opencode-sdk` должны использоваться парой (Observed: `packages/provider/src/config/provider-data-schema.ts:72-121,175-180`; `model-execution.ts:852-861`).
- Base URL обязателен для всех, кроме `opencode-sdk` (Observed: `model-execution.ts:849-851`).
- Provider registry: валидирует duplicate providers/models, selection (`provider-not-found`, `model-not-found`, reasoning level), хранит immutable view с revision и listeners (Observed: `packages/provider/src/registry.ts:47-139,142-174`).
- Effective selection: account-plan provider подменяется на текущий подключённый account-provider, скрытые provider’ы недоступны, reasoning level валидируется/нормализуется (Observed: `packages/provider/src/effective-model-selection.ts:17-77`).
- Model catalog (`ModelCatalogPort`) — синхронный, живой снимок registry, используется `ListModels` и `CreateWorkflow/AmendWorkflow` для `subagent_model`; tool явно не меняет модель сессии (Observed: `contracts/src/interfaces/model-catalog.port.ts:12-39`; `handlers/list-models.ts:37-58`).
- Разрешение `subagent_model`: 1) `providerId/modelId`, 2) голый `modelId` в текущем provider, 3) голый `modelId` в другом provider → `other_provider`; disabled-модели не выбираются молча; `$level` валидируется (Observed: `handlers/model-reference.ts:38-100`).
- Subagent override: `createSubagentOverrideModelFactory`; child может наследовать model, если override нет (Observed: `core/src/runtime/methods/subagent.ts:238-269,368-369,806`).
- Token usage: провайдерские поля `inputTokens/outputTokens/totalTokens/cacheRead/cacheWrite/reasoning/serverToolUse`; summary агрегирует `ModelComplete` и failed usage (Observed: `contracts/src/model/index.ts:526-559`; `contracts/src/events/session.events.ts:1376-1395`).
- Оценка токенов для бюджетов: `estimateTokens = ceil((chinese*2 + other)/3)` — грубая эвристика (Observed: `core/src/context/utils.ts:12-18`; `packages/shared/src/usage-stats.ts:9`).
- Cost: в рантайме не считается: `step-finish` и assistant message пишут `cost: 0` (Observed: `runtime/methods/turn-step-finish.ts:29`; `runtime/methods/message-persistence.ts:337`; `turn-stop.ts:86,137`). В контракте поле есть (`contracts/src/interfaces/session-store.port.ts:413,695`). UI считает стоимость через `tokenlens.getUsage` по `modelId` (Observed: `packages/ui/src/components/ai-elements/context.tsx:224-236`).
- Retry: default 10 retries (11 attempts), base 2s, factor 2, cap 60s, jitter, `retry-after` имеет приоритет в пределах 300s; >300s — terminal quota (Observed: `retry-policy.ts:13-49`; `runner-retry.ts:41-108`).
- Failure classification: 402 → quota exhausted; 429 → retryable, кроме длинного Retry-After; 529 overloaded retryable; 400/422 invalid request non-retryable (Observed: `failure-classifier.ts:290-330,622-660`).
- Watchdogs: stream idle 600s + 30s за попытку; first token 90s (Observed: `contracts/src/config/index.ts:287-300`; `stream-idle-timeout.ts:5-24`; `first-token-watchdog.ts:1-60`).
- Provider quota fallback: до 3 attempts, same model class, registry order, hidden excluded, `providerFallback: "disabled"` отключает; после вывода стрима не переключает; OpenCode исключён (Observed: `core/src/runtime/methods/provider-quota-fallback.ts:14-113`; `bootstrap/src/app/provider-registry-model-runtime.ts:70-122`; spec `docs/specs/provider-quota-fallback.md:1-45`).
- Tool-call assembly: streaming assembler ждёт `tool-input-end` и финальный `tool_call`, дедуплицирует по id, нормализует пустое имя; malformed JSON string → `{}` и schema-error вместо падения запроса (Observed: `adapters/src/model/streaming-tool-call-assembler.ts:24-116`; `adapters/src/model/tool-input-normalization.ts:9-48`; `core/src/tool/input-normalization.ts:42-63`; docs `docs/model-tool-call-validation.md:1-40`).

## 4. Gaps, risks, weaknesses

### G-01. Sandbox не enforced; флаг создаёт ложное впечатление защиты — high

- Bash handler формирует `ExecutionRequest.sandbox` из `dangerouslyDisableSandbox` (Observed: `core/src/tool/handlers/bash.ts:458-461`).
- В `adapters/src/exec/*` нет чтения `request.sandbox`: `rg -n "request\\.sandbox|\\.sandbox\\b|sandboxPolicy"` по каталогу дал пустой вывод; есть только комментарии «sandbox撤除后» (`node-execution-adapter-run.ts:399-400`).
- Контракт содержит `ExecutionSandboxPolicy` и `SANDBOX_VIOLATION` (`contracts/src/interfaces/execution.port.ts:108-113,153,163`; `contracts/src/tools/bash.ts:314,338`).
- Проектная документация прямо допускает no-op: «`sandbox` … Первая версия может быть no-op, но поле должно贯穿 trace и аудит» (`apps/zcode-cli/docs/design/v2/tool/04-bash.md:235`).
- Риск: модель и пользователь видят `dangerouslyDisableSandbox`, telemetry `sandboxed` (`bash.ts:328`), но фактической изоляции нет.

### G-02. Граница workspace намеренно открыта — high

- `resolveWorkspacePath` возвращает путь вне `workspaceRoot` без ошибки; комментарий объясняет потребности subagent’ов (Observed: `core/src/tool/path-policy.ts:32-39`).
- Тесты фиксируют это как ожидаемое поведение для Read/Write/Glob/Grep (Observed: `core/tests/file-tool-port.test.ts:420-492`).
- Риск: prompt-injection/ошибочный путь может читать и писать произвольные файлы пользователя; защита остаётся только на permission-слое и ОС.

### G-03. ApplyPatch реализован и протестирован, но недоступен модели — medium

- `applyPatchToolEntry` экспортируется, handler покрыт тестами, но строка в `builtInTools` закомментирована (Observed: `handlers/apply-patch.ts:325-381`; `handlers/index.ts:90`; `core/tests/file-tool-port.test.ts:868-955`).
- Контрактный тест проверяет ApplyPatch только `if (applyPatch)` — при отсутствии tool ассерты молча пропускаются (Observed: `core/tests/tool-contracts.test.ts:443-449`).
- Риск: мёртвая документированная возможность; включение «как есть» обойдёт read-before-edit (см. §3.5).

### G-04. Glob не уважает ignore-файлы и обходит всё дерево — medium/high для больших репо

- `walkFiles` пропускает только VCS-каталоги, без `.gitignore`, `.zcodeignore`, `node_modules`, `dist` (Observed: `adapters/src/fs/index.ts:54,1708-1731`).
- Лимит 100 результатов применяется **после** полного обхода (`:423-446`), поэтому стоимость обхода не ограничена числом результатов.
- Риск: `**/*` в огромном монорепо читает `node_modules`, зависает до 30s, выдаёт 100 случайных по mtime файлов; нет диагностики «поиск ограничен».

### G-05. Расхождение порогов Retry-After: 300s vs 600s — medium

- Adapter: `MAX_HONORED_RETRY_AFTER_MS = 5 * 60_000` (300s) (Observed: `adapters/src/model/retry-policy.ts:31`); `failure-classifier` использует `isLongRetryAfter` → >300s помечается `providerQuotaExhausted` (Observed: `failure-classifier.ts:303-316`).
- Core: `QUOTA_RETRY_AFTER_THRESHOLD_MS = 600_000` (600s) (Observed: `core/src/runtime/methods/provider-quota-fallback.ts:15`; `findQuotaFailure` проверяет `> 600_000` на `:325-330`).
- Спецификация говорит «429 … Retry-After больше 300 секунд» (Observed: `docs/specs/provider-quota-fallback.md:14`), а комментарий classifier — «10 минут» (`failure-classifier.ts:304`).
- Риск: если ошибка приходит без adapter-контекста (другой путь/старый адаптер), 429 с Retry-After 5–10 минут не запустит provider fallback; поведение зависит от того, какой слой классифицировал ошибку.

### G-06. Нет учёта стоимости и бюджетов стоимости — high для cost control

- `cost` в step-finish и assistant message всегда `0` (Observed: `turn-step-finish.ts:29`; `message-persistence.ts:337`).
- В `ModelUsage` нет цены; только токены (Observed: `contracts/src/model/index.ts:531-539`).
- Единственный расчёт — UI-компонент через `tokenlens.getUsage` по `modelId` (Observed: `packages/ui/src/components/ai-elements/context.tsx:224-236`; зависимость `packages/ui/package.json:90`).
- Нет лимитов/бюджетов на стоимость в runtime; `root run budget` в коде относится к resource/token/time, не к деньгам (Observed: `failure-classifier.ts:49-50`).
- Риск: нельзя остановить дорогой run, нельзя показать точную стоимость для произвольных provider/model, cost-политики отсутствуют.

### G-07. Multi-file ApplyPatch не транзакционен — medium

- Цикл записи идёт по файлам последовательно; при ошибке на втором файле первый уже записан (Observed: `handlers/apply-patch.ts:80-110`).
- `atomic: true` защищает только отдельный файл; rollback нет; отмена (`abortSignal`) проверяется файловым портом, но не откатывает уже записанные изменения (Inferred из отсутствия rollback-кода).
- Риск: частично применённый патч; модель получает ошибку, но рабочее дерево уже изменено.

### G-08. Нет executor-level идемпотентности по `toolCallId` — medium

- `StreamingToolCallAssembler` дедуплицирует повторные `tool_call` события по id (Observed: `adapters/src/model/streaming-tool-call-assembler.ts:78-90`).
- В `executeToolCall` нет проверки «этот callId уже исполнялся» (Observed: `core/src/tool/executor/call-runner.ts:72-108`; поиск `toolCallId` Set/дедупликации в executor не дал результата).
- Риск: при повторной доставке/continuation один и тот же side-effecting call может выполниться дважды. Гипотеза требует проверки runtime-пути повторов.

### G-09. Поля `assistantAutoBackgrounded`/`backgroundedByUser` не имеют продюсера — low/medium

- Форматтер Bash использует оба флага (Observed: `core/src/tool/handlers/bash-model-content.ts:119-131`).
- Во всём `apps`/`packages` (кроме тестов, контракта и форматтера) нет присваивания `assistantAutoBackgrounded` или `backgroundedByUser`; авто-background выставляет `status: "backgrounded"`, но не эти флаги (Observed: grep; `handlers/bash.ts:276-295`).
- Следствие (Inferred): ветки сообщений «assistant-mode blocking budget 15s» и «manually backgrounded by user» недостижимы; поле в output schema — мёртвый контракт.

### G-10. Windows: очистка дерева слабее, чем POSIX; реальный прогон не проверен — medium

- Windows использует `taskkill /T /F`, без Job Object для Bash; Job Object применён только к MCP stdio (Observed: `node-execution-adapter-process.ts:152-169`; `mcp/stdio-transport.ts:63`).
- `detached: false` на Windows; нет negative-PGID kill; после `taskkill` остаётся полагаться на его успех (Observed: `node-execution-adapter-process.ts:125-136,146-200`).
- Тесты Windows-ветки помечены `skipIf` на не-Windows (Observed: `adapters/tests/exec.test.ts:1320`); в этом исследовании Windows-прогон не выполнялся (Unknown фактического поведения).

### G-11. Документация и код расходятся по видимости Glob/Grep в embedded branch — low

- Комментарий в `handlers/index.ts:80-81` утверждает, что embedded branch «统一隐藏 Glob/Grep, и через Bash find/grep接管搜索».
- Фактически `registerBuiltInTools` их не скрывает; тест явно ожидает `Glob`/`Grep` видимыми (Observed: `core/tests/tool-contracts.test.ts:1104-1118`).
- Дизайн-документ `apps/zcode-cli/docs/design/v2/tool/09-grep.md:8-24` также говорит, что embedded branch не показывает direct `Grep`.
- Риск: противоречивые ожидания у разработчиков и в prompt-ах Explore.

### G-12. Read: описание «2000 lines by default» не соответствует фактическому чтению — low/medium

- Константа и описание: `READ_DEFAULT_MAX_LINES = 2000`, prompt «Reads up to 2000 lines by default» (Observed: `contracts/src/tools/read.ts:17`; `core/src/tool/handlers/read.ts:57-68`).
- Фактический `readTextFileForModel` передаёт `limitLines: undefined`, если limit не задан, и adapter читает все строки; ограничение — 256 KiB / 25k токенов (Observed: `core/src/tool/handlers/read-text.ts:41-59`; `adapters/src/fs/text-range-reader.ts:205-214`).
- Тест прямо ожидает чтение 2005 строк по умолчанию (Observed: `core/tests/read-tool-contract.test.ts:198-213`).
- Риск: модель и пользователь ожидают усечение до 2000 строк, но получают весь файл; на больших файлах это упирается в token cap и даёт partial-view вместо предсказуемого диапазона.

### G-13. Code index ограничен JS/TS; LSP/NotebookEdit зарезервированы, но не реализованы — medium

- Сканер индексирует только `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs` (Observed: `scanner.ts:74`).
- `LSP`, `NotebookEdit`, `EnterWorktree`, `ScheduleWakeup`, `TaskCreate/Get/List/Update` есть в provider-visible order, но не имеют `ToolEntry` (Observed: `provider-visible-order.ts:11-27`; `rg` не находит `name: "LSP"`).
- Edit отказывает `.ipynb`, ссылаясь на отсутствующий `NotebookEdit` (Observed: `handlers/edit.ts:193-198`).
- Риск: нет символьной навигации для Python/Go/Rust/Java и нет редактирования ноутбуков; обещания prompt-ов могут расходиться с tool surface.

### G-14. Malformed tool input молча деградирует в `{}` — low (осознанный компромисс)

- Adapter и core нормализуют строковый/битый JSON в `{}` и логируют warn, чтобы не ломать весь model request (Observed: `adapters/src/model/tool-input-normalization.ts:9-65`; `core/src/tool/input-normalization.ts:42-86`; docs `docs/model-tool-call-validation.md:1-20`).
- Риск: провайдерный баг сериализации маскируется под schema-error инструмента; нет агрегированной метрики частоты (Inferred).

### G-15. Стоимость/лимиты провайдера не видны в tool layer — medium

- Rate limit и quota обрабатываются в adapter/core, но tool `Bash`/`WebSearch` не получают бюджета стоимости; `WebSearch` имеет `maxUses=8` только для native-поиска (Observed: `handlers/websearch.ts:32`).
- Модель может многократно вызывать дорогие tool’ы; ограничение только на уровне turn/token/времени (Observed: `failure-classifier.ts:49-50`).

## 5. Strengths and differentiators

### S-1. Единый типизированный tool-контракт с двойной валидацией

`ToolEntry` одновременно несёт JSON Schema для провайдера и runtime Zod-схему, permission-декларацию, бюджеты, timeout/cancel-политику и trace-требования (Observed: `core/src/tool/types.ts:310-409`). Это даёт одинаковые ошибки на входе модели и на исполнении, а также позволяет генерировать provider-visible контракты без ручного дублирования (`registry.ts:104-129`).

### S-2. Полный жизненный цикл tool-call с hooks и аудитом

Конвейер `validate → resolveInput → PreToolUse → permission → timeout → handler → validateOutput → serialize → PostToolUse` покрыт событиями `ToolCallStarted/Result/Error`, trace-контекстом, telemetry и логами (Observed: `executor/call-runner.ts:221-767`; `executor/events.ts:23-134`). Bash дополнительно отдаёт `executionEvidence` с sha256 команды и статусом (Observed: `events.ts:102-134`).

### S-3. Безопасная деградация и восстановление после ошибок модели

- Битый tool input не валит запрос: он превращается в schema-error или пустой объект с предупреждением (Observed: `adapters/src/model/tool-input-normalization.ts:39-47`; `core/src/tool/executor/call-runner.ts:230-274`).
- Пустое имя tool’а закрывается парным error-result с исходным id (Observed: `call-runner.ts:147-186`; docs `docs/model-tool-call-validation.md:20-40`).
- Streaming assembler не публикует вызов до `tool-input-end` и финального `tool_call` (Observed: `streaming-tool-call-assembler.ts:78-115`).

### S-4. Сильная работа с процессами и большим выводом

Bash-адаптер сочетает: прямой файловый capture (без Node collector), 5 GiB runtime cap, inline 30 KB, прогресс-хвост, POSIX process-tree kill с SIGTERM→SIGKILL, Windows `taskkill /T /F`, force-exit таймер, drain-таймаут, отмену до spawn и во время shell-init snapshot (Observed: `node-execution-adapter-run.ts:59-129,251-521`; `node-execution-adapter-process.ts:146-267`; `process-tree.ts:7-61`; `bash-file-output.ts:33-97`). Это выше типичного «spawn + timeout + truncate».

### S-5. Фоновая жизнь задач и durability

Есть `TaskOutput` с polling/block, archived catalog, attempt fencing, `TaskStop` с model/user initiator, max runtime для subagent Bash, terminal notifications и XML-совместимый provider output (Observed: `handlers/task-output.ts:52-256`; `handlers/task-stop.ts:29-157`; `executor/background-tasks.ts:160-300`; `executor/background-task-registry.ts:47-117`).

### S-6. Patch application с verify-before-write и сохранением кодировки

Все hunks проверяются до записи; ошибка поиска не оставляет частичных файлов внутри одной секции; encoding/lineEndings исходника сохраняются, включая GB2312/GBK/GB18030 с round-trip проверкой (Observed: `handlers/apply-patch.ts:67-216`; `adapters/src/fs/text-metadata.ts:63-80`; design `14-apply-patch.md:35-52`).

### S-7. Code index с приватностью и инкрементальностью

Ignore-правила, исключение секретов, symlink-skip, fingerprint-инкремент, graph-only backfill, single recursive watcher, лексический + embedding-поиск, bounded output и turn hint — всё в одном сервисе с отдельным CONTRACT (Observed: `scanner.ts:74-108,438-553`; `codeIntelligenceService.ts:248-479,621-720`; `workspaceWatcher.ts:31-103`; `CONTRACT.md:1-27`).

### S-8. Провайдерный слой с четырьмя wire-форматами и защитами

Единый model API поверх Anthropic Messages, OpenAI Responses, OpenAI Chat Completions и OpenCode SDK; аккуратные compat-fetch’и, strict schema только там, где безопасно, provider-native web search, failure classifier с бизнес-кодами, retry budget, quota fallback, first-token/stream-idle watchdogs (Observed: `model-execution.ts:517-553,837-872`; `tool-transform.ts:40-99,313-361`; `failure-classifier.ts:110-330`; `retry-policy.ts:13-49`; `provider-quota-fallback.ts:14-113`).

### S-9. Тестовая база

299 test-файлов в `core/tests`, 163 в `adapters/tests`, 23 в `packages/provider/test`, 3 в `packages/services/test/code-intelligence`; в этом исследовании прогнаны 12 узких наборов (см. §8) — все прошли, кроме ожидаемых skip. Это даёт хорошую регрессионную сетку для tool-контрактов, Bash и retry-политик.

## 6. Candidate recommendations

### R-01. Решить судьбу ApplyPatch: включить с parity read-state или удалить из документации/тестов

- **Problem/gap:** tool реализован и протестирован, но не зарегистрирован; контрактный тест молча пропускает проверки.
- **ZCode evidence:** `apps/zcode-cli/packages/core/src/tool/handlers/index.ts:90`; `.../handlers/apply-patch.ts:49-118,325-381`; `core/tests/tool-contracts.test.ts:443-449`; `core/tests/file-tool-port.test.ts:868-955`.
- **Proposed solution:** либо добавить `applyPatchToolEntry` в `builtInTools` с гейтом и добавить проверку `readFileState`/freshness как в Edit/Write, либо удалить handler/тесты/документацию и оставить один путь Edit/Write.
- **Scope:** tool registration, permission, read-state parity, contract tests. **Out-of-scope:** новый формат патчей.
- **Expected effect:** устранение мёртвой возможности и скрытого поведения; при включении — более дешёвые multi-hunk правки.
- **Risks:** обход read-before-edit; ошибки fuzzy-поиска hunk; рост tool surface.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** ApplyPatch либо присутствует в `toContracts()` и имеет тест read-before-edit/stale, либо отсутствует во всех docs/tests; `pnpm test:unit` зелёный.
- **Verification:** `core/tests/tool-contracts.test.ts`, `file-tool-port.test.ts`; ручной прогон tool-call через executor.

### R-02. Ввести явную политику выхода за workspace вместо неявного «разрешено»

- **Problem/gap:** `resolveWorkspacePath` не блокирует пути вне workspaceRoot; это зафиксировано тестами.
- **ZCode evidence:** `core/src/tool/path-policy.ts:32-39`; `core/tests/file-tool-port.test.ts:420-492`; permission service не проверяет путь вне workspace (`permission/service.ts:117-200`).
- **Proposed solution:** добавить конфигурируемую политику `workspaceBoundary: "strict" | "ask" | "allow"` с дефолтом `ask` для write и `allow` для read (или наоборот по продуктовому решению); передавать её в `resolveWorkspacePath`.
- **Scope:** path-policy, permission, UI settings, тесты. **Out-of-scope:** OS sandbox.
- **Expected effect:** предсказуемая защита пользовательских файлов без потери сценария sibling-repo.
- **Risks:** сломать subagent’ов, которым нужен внешний файл; ложные ask в CI.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** есть тесты strict/ask/allow для Read/Write/Edit/Glob/Grep; default задокументирован; permission-событие содержит причину.
- **Verification:** unit-тесты path-policy + executor permission flow; e2e сценарий с внешним файлом.

### R-03. Убрать ложную гарантию sandbox или реализовать его

- **Problem/gap:** `sandbox` поле уходит в adapter, но не читается; `dangerouslyDisableSandbox` влияет только на telemetry.
- **ZCode evidence:** `core/src/tool/handlers/bash.ts:328,458-461`; `contracts/src/interfaces/execution.port.ts:108-113,153`; `adapters/src/exec/*` — нет чтения (rg пусто); design `04-bash.md:235`.
- **Proposed solution:** вариант A — реализовать платформенный sandbox (macOS sandbox-exec/seatbelt, Linux bwrap/landlock, Windows job/restricted token) и вернуть `SANDBOX_VIOLATION`; вариант B — удалить `dangerouslyDisableSandbox` из model schema, оставить поле только как internal trace metadata и явно документировать отсутствие изоляции.
- **Scope:** adapter exec, contracts, prompt/schema, docs. **Out-of-scope:** контейнерная изоляция desktop.
- **Expected effect:** либо реальная защита, либо честный контракт.
- **Risks:** sandbox ломает git/npm/сетевые команды; Windows-реализация дорогая.
- **Complexity:** L (A) / S (B). **Priority:** P1.
- **Acceptance criteria:** нет provider-visible поля, обещающего изоляцию, без enforcement; либо есть e2e-тест, где sandbox блокирует запись/сеть и возвращает `sandbox_violation`.
- **Verification:** платформенные e2e; `exec.test.ts`; ручная проверка `dangerouslyDisableSandbox`.

### R-04. Добавить ignore-правила и верхнюю границу обхода в Glob

- **Problem/gap:** Glob обходит всё дерево, включая `node_modules`, и не читает `.gitignore`.
- **ZCode evidence:** `adapters/src/fs/index.ts:54,423-446,1708-1731`.
- **Proposed solution:** переиспользовать `ignore`-модуль и правила из CodeIndex (`scanner.ts:396-436`) или явно задать built-in excludes (`node_modules`, `.git`, `dist`, `build`, `.venv`, `target`); добавить `maxVisitedEntries`/`maxDepth` и диагностику `truncatedByTraversal`.
- **Scope:** FS adapter, Glob schema/output, тесты. **Out-of-scope:** изменение Grep.
- **Expected effect:** предсказуемая latency на монорепо, меньше мусорных результатов.
- **Risks:** пользователь ожидает найти файл в игнорируемом каталоге; нужен override.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** тест с `node_modules` и `.gitignore` показывает исключение; обход прерывается на лимите; output содержит причину усечения.
- **Verification:** unit-тест walkFiles + бенчмарк на большом fixture.

### R-05. Сделать multi-file ApplyPatch транзакционным или явно откатываемым

- **Problem/gap:** последовательная запись файлов; ошибка на N-м файле оставляет предыдущие изменения.
- **ZCode evidence:** `handlers/apply-patch.ts:80-110`; `fs/index.ts:700-755` (atomic per file).
- **Proposed solution:** two-phase: записать все новые содержимые во временные файлы, затем переименовать; при ошибке — удалить temp и не трогать оригиналы. Для delete/move — журнал и обратный rename.
- **Scope:** ApplyPatch handler + FS port (batch write). **Out-of-scope:** транзакции для Edit/Write.
- **Expected effect:** «all-or-nothing» патч.
- **Risks:** сложность с разными filesystem/Windows; права/симлинки.
- **Complexity:** L. **Priority:** P2.
- **Acceptance criteria:** тест, где второй файл не пишется, первый остаётся неизменным; тест move/delete rollback.
- **Verification:** `file-tool-port.test.ts` + fault injection.

### R-06. Ввести расчёт стоимости и бюджеты

- **Problem/gap:** `cost: 0` в рантайме, нет price-каталога и лимитов.
- **ZCode evidence:** `runtime/methods/turn-step-finish.ts:29`; `runtime/methods/message-persistence.ts:337`; `contracts/src/model/index.ts:531-539`; UI-only `context.tsx:224-236`.
- **Proposed solution:** добавить в model config необязательные `inputPricePerMTok`/`outputPricePerMTok`/`cachePrice`; считать cost в runtime по usage; агрегировать в session/turn; добавить soft/hard budget с событием и остановкой turn.
- **Scope:** provider model schema, runtime usage, UI, session store. **Out-of-scope:** биллинг провайдера.
- **Expected effect:** видимая стоимость и контроль расходов.
- **Risks:** неверные цены; разные валюты; провайдеры без pricing.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** cost > 0 для модели с заданными ценами; budget-exceeded событие и остановка turn; UI показывает сумму и источник цен.
- **Verification:** unit на cost-калькулятор + runtime-тест бюджета.

### R-07. Синхронизировать порог Retry-After между adapter, core и спецификацией

- **Problem/gap:** adapter 300s, core 600s, spec 300s, комментарий «10 минут».
- **ZCode evidence:** `adapters/src/model/retry-policy.ts:31`; `failure-classifier.ts:303-316`; `core/src/runtime/methods/provider-quota-fallback.ts:15,325-330`; `docs/specs/provider-quota-fallback.md:14`.
- **Proposed solution:** один экспортируемый констант (например, в contracts) и единый helper; core должен читать `providerQuotaExhausted` из контекста, а fallback по чистому 429 — по тому же 300s.
- **Scope:** adapter retry policy, core quota fallback, docs. **Out-of-scope:** изменение алгоритма backoff.
- **Expected effect:** одинаковое поведение при 429 в любом пути.
- **Risks:** слишком агрессивный switch на 5–10-минутных лимитах.
- **Complexity:** S. **Priority:** P1.
- **Acceptance criteria:** тест с 429 Retry-After 301s и 601s даёт одинаковый результат в adapter и core; spec обновлена.
- **Verification:** `runner-retry-after-policy.test.ts`, `provider-quota-fallback.test.ts`, новый integration-тест.

### R-08. Закрыть тестовые пробелы: sandbox, workspace boundary, Windows, cost, strict-контракты

- **Problem/gap:** strict read/write suites выключены env-флагами; sandbox/Windows не тестируются; ApplyPatch-ассерты условны.
- **ZCode evidence:** `core/tests/read-tool-contract.test.ts:32-33,377`; `core/tests/write-tool-contract.test.ts:31-32,380`; `adapters/tests/exec.test.ts:1320` (`skipIf` Windows); `core/tests/tool-contracts.test.ts:443-449` (`if (applyPatch)`).
- **Proposed solution:** включить strict-наборы в CI; добавить тест «workspace outside» с текущей политикой и с будущей; добавить Windows-job-object тест для Bash (или явно задокументировать unsupported); добавить cost unit-тесты; убрать условные ассерты или сделать их явными skip с причиной.
- **Scope:** tests/CI. **Out-of-scope:** продуктовые изменения.
- **Expected effect:** меньше скрытых регрессий.
- **Risks:** рост времени CI; Windows-runner.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** strict-наборы выполняются без env-флага; в отчёте видно количество skip и причину; sandbox/workspace тесты падают при регрессии.
- **Verification:** CI-лог с прогоном этих файлов.

### R-09. Добавить идемпотентность side-effecting tool calls по `toolCallId`

- **Problem/gap:** executor не помнит, что callId уже исполнялся; повторная доставка может дать двойной эффект.
- **ZCode evidence:** `core/src/tool/executor/call-runner.ts:72-108`; `adapters/src/model/streaming-tool-call-assembler.ts:78-90` (дедуп только на уровне потока).
- **Proposed solution:** ввести per-turn `Set<toolCallId>` в executor и возвращать закэшированный результат/ошибку для повторного id; хранить ключ в session event journal для cold resume.
- **Scope:** executor, event journal, tests. **Out-of-scope:** provider retry (там свои id).
- **Expected effect:** защита от двойных Write/Bash при повторной доставке.
- **Risks:** законные повторы с тем же id; память; semantics continuation.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** тест с двумя одинаковыми callId выполняет handler один раз и возвращает тот же результат; после resume повтор не исполняется.
- **Verification:** executor unit + runtime resume test.

## 7. Open questions and unverified

1. **Ripgrep ignore semantics.** Использует ли bundled ripgrep в Worker `.gitignore` при `preopens {".": outputRoot}`? Флаги `--no-ignore` не переданы, но поведение WASI-сборки не проверено. **Unknown**; нужен тест с `.gitignore` + `node_modules`.
2. **Provider fallback end-to-end.** Wrapper собирается в bootstrap и покрыт unit-тестами; реальный путь `turn → model → quota error → switch → continuation` не прогонялся (нет сети). **Unknown**.
3. **Windows Bash cleanup.** `taskkill /T /F` и отсутствие Job Object для Bash не проверены на живой Windows; тесты ветки skip’аются. **Unknown**.
4. **Executor-level duplicate callId.** Есть ли выше по стеку (stream coordinator/runtime) защита от повторной доставки того же call id? Не найдено в executor; требует трассировки повторов. **Unknown**.
5. **Pricing source.** Откуда UI/tokenlens берёт цены и покрывает ли все провайдеры/модели ZCode; не проверялось. **Unknown**.
6. **`assistantAutoBackgrounded`/`backgroundedByUser`.** Не найдено продюсеров в TS; возможно, их пишет внешний desktop/JS-слой или старый протокол. **Unknown**.
7. **Provider package test execution.** 23 теста в `packages/provider/test` существуют, но их прогон в общем CI не проверялся; в этом исследовании не запускались. **Unknown**.
8. **CodeIndex embeddings.** Реальный embedding endpoint не поднимался; проверена только lexical-часть и fallback-диагностика. **Unknown** для качества semantic rerank.
9. **MCP network.** MCP-серверы не запускались; проверена только регистрация/бюджеты/ошибки по коду. **Unknown** для реальных таймаутов и paging.
10. **Bash `stdin`.** `ExecutionRequest.stdin` поддержан, но Bash tool не имеет поля stdin; кто использует stdin (hooks/MCP?) — не проверено. **Unknown**.

## 8. Evidence appendix

### E-1. Git / preflight

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

### E-2. Индекс

```text
CodeIndex status:
state=ready partial=false generation=1453
files=10007 chunks=26791 symbols=278154 edges=377669
embedding: configured=true model=perplexity/pplx-embed-v1-0.6b available=true
diagnostics: ["Embedding search is unavailable; showing lexical results."]
```

### E-3. Подсчёт built-in tools

Python-проход по `builtInTools` (строки 83–154 `handlers/index.ts`) дал 47 записей; `applyPatchToolEntry` в списке отсутствует (закомментирован на строке 90).

### E-4. Проверка отсутствия sandbox-enforcement

```text
$ rg -n "request\.sandbox|\.sandbox\b|sandboxPolicy" apps/zcode-cli/packages/adapters/src/exec --glob '*.ts'
<пустой вывод>
```

Единственные упоминания sandbox в exec-адаптере — комментарии `node-execution-adapter-run.ts:399-400`.

### E-5. Запущенные узкие тесты (Observed)

```text
core: tests/tool-registry-alias.test.ts tests/scheduler.test.ts tests/tool-deadline.test.ts tests/read-tool-contract.test.ts
→ 4 files passed; 37 passed | 13 skipped

core: tests/file-tool-port.test.ts tests/tool-input-normalization.test.ts
→ 2 files passed; 40 passed

core: tests/tool-contracts.test.ts
→ 1 file passed; 49 passed

core: tests/bash-handler.test.ts tests/bash-permission.test.ts
→ 2 files passed; 108 passed

core: tests/provider-quota-fallback.test.ts
→ 1 file passed; 10 passed

core: tests/edit-tool-contract.test.ts (не запускался в этом прогоне; файл существует)
adapters: tests/bash-process-stop.test.ts tests/bash-output-preview.test.ts
→ 2 files passed; 5 passed

adapters: tests/tool-input-normalization.test.ts
→ 1 file passed; 28 passed

adapters: tests/exec.test.ts
→ 1 file passed; 122 passed | 3 skipped

adapters: tests/retry-budget.test.ts tests/runner-retry-after-policy.test.ts
→ 2 files passed; 25 passed

services: packages/services/test/code-intelligence/scanner.test.ts
→ 1 file passed; 1 passed

services: packages/services/test/code-intelligence/codeIntelligenceService.test.ts
→ 1 file passed; 24 passed
```

Не запускались: `typecheck`, `lint`, полный `test:unit`, E2E, desktop packaging, реальные provider/MCP/embedding-вызовы.

### E-6. Ключевые file:line для проверки

| Утверждение | Файл:строки |
|---|---|
| 47 built-in entries, ApplyPatch закомментирован | `apps/zcode-cli/packages/core/src/tool/handlers/index.ts:83-154` (строка 90) |
| Гейты регистрации | `.../handlers/index.ts:222-306` |
| Registry aliases/canonical | `.../tool/registry.ts:34-71,104-129` |
| Scheduler + concurrency 10 | `.../tool/scheduler.ts:48,60-227`; `.../executor/impl.ts:97` |
| Executor lifecycle | `.../tool/executor/call-runner.ts:72-767` |
| Timeout/deadline/grace | `.../tool/executor/timeout.ts:19-204` |
| Result budget | `.../tool/executor/result-serialization.ts:34-232` |
| Path policy (вне workspace разрешено) | `.../tool/path-policy.ts:32-39` |
| Read limits | `.../contracts/src/tools/read.ts:15-23`; `.../handlers/read.ts:464-526` |
| Read default 2000 mismatch | `.../handlers/read-text.ts:41-59`; `core/tests/read-tool-contract.test.ts:198-213` |
| Write read-before-write/freshness | `.../handlers/write.ts:278-337` |
| Edit read-state/limits | `.../handlers/edit.ts:61,148-153,200-251` |
| ApplyPatch verify/write loop | `.../handlers/apply-patch.ts:49-118` |
| Patch parser/apply | `.../tool/patch-parser.ts:21-69`; `.../tool/patch-apply.ts:11-132` |
| Atomic write | `adapters/src/fs/index.ts:700-755` |
| Bash schema/timeouts | `contracts/src/tools/bash.ts:32-72`; `tool/bash-timeout-policy.ts:6-35` |
| Bash cwd policy | `handlers/bash-cwd-policy.ts:33-49` |
| Bash output limits | `handlers/bash.ts:80-81,452-457`; `adapters/src/exec/bash-file-output.ts:9,66-88` |
| Process tree POSIX/Windows | `adapters/src/exec/process-tree.ts:7-61`; `.../node-execution-adapter-process.ts:146-200` |
| PTY only in terminal service | `packages/services/src/terminal/terminalService.ts:1-20`; `packages/desktop/package.json:83` |
| Glob no ignores | `adapters/src/fs/index.ts:54,1708-1731` |
| Grep ripgrep plan/limits | `adapters/src/fs/index.ts:52,924-979,1811-1834` |
| Embedded search gates | `core/src/embedded-search/capability.ts:4-44`; `shell.ts:5-15` |
| Code index scan/ignore/limits | `packages/services/src/code-intelligence/scanner.ts:74-108,438-553` |
| Code index search/ranking | `.../codeIntelligenceService.ts:621-720`; `database.ts:112-125` |
| Code index watcher | `.../workspaceWatcher.ts:5-22,31-103` |
| CodeIndex tool schema/limits | `core/src/tool/handlers/code-index.ts:6-21,46-107` |
| Provider API types | `packages/provider/src/config/provider-data-schema.ts:4-9` |
| Provider registry validation | `packages/provider/src/registry.ts:47-139` |
| Provider factory mapping | `adapters/src/model/model-execution.ts:517-553,837-872` |
| Anthropic strict schema | `adapters/src/model/strict-tool-schema.ts:45-64` |
| Tool-call assembler/normalization | `adapters/src/model/streaming-tool-call-assembler.ts:24-116`; `tool-input-normalization.ts:9-65` |
| Retry policy | `adapters/src/model/retry-policy.ts:13-49`; `runner-retry.ts:41-108` |
| Retry-After mismatch | `retry-policy.ts:31`; `failure-classifier.ts:303-316`; `core/src/runtime/methods/provider-quota-fallback.ts:15,325-330` |
| Quota fallback wrapper | `core/src/runtime/methods/provider-quota-fallback.ts:74-113`; `bootstrap/src/app/provider-registry-model-runtime.ts:70-122` |
| Cost always 0 | `core/src/runtime/methods/turn-step-finish.ts:29`; `message-persistence.ts:337` |
| UI cost via tokenlens | `packages/ui/src/components/ai-elements/context.tsx:224-236` |
| Model catalog port | `contracts/src/interfaces/model-catalog.port.ts:12-39` |
| ListModels boundary | `core/src/tool/handlers/list-models.ts:37-58` |
| Model reference resolution | `core/src/tool/handlers/model-reference.ts:38-100` |
| Strict contract tests gated | `core/tests/read-tool-contract.test.ts:32-33,377`; `core/tests/write-tool-contract.test.ts:31-32,380` |
| ApplyPatch conditional assertions | `core/tests/tool-contracts.test.ts:443-449` |
| Windows test skip | `adapters/tests/exec.test.ts:1320` |

### E-7. Тестовые файлы, существующие, но не запускавшиеся

- `apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts` (много кейсов Edit).
- `apps/zcode-cli/packages/core/tests/task-output-tool.test.ts`, `task-stop-tool.test.ts`.
- `apps/zcode-cli/packages/core/tests/webfetch-tool.test.ts`, `websearch.test.ts`.
- `apps/zcode-cli/packages/core/tests/tool-search-*.test.ts` (около 20 файлов).
- `apps/zcode-cli/packages/adapters/tests/bash-direct-execution.test.ts`, `bash-shutdown.test.ts`, `bash-resource-lifecycle.test.ts`, `shell-init-snapshot*.test.ts`, `windows-job-object.test.ts`, `mcp-*.test.ts`.
- `packages/provider/test/*.test.ts` (23 файла).
- `packages/services/test/code-intelligence/database.test.ts`.

---

## Coverage status

**Статус: partial.**

Покрыто и проверено по исходникам: реестр и конвейер tool-исполнения, все 47 зарегистрированных built-in entries и гейты, file tools (Read/Write/Edit/ApplyPatch), Bash/execution adapter (shell selection, cwd, env, timeouts, output, process tree, Windows-ветка по коду), background tasks, Glob/Grep/embedded search, CodeIndex service, MCP tool entry, WebFetch/WebSearch, patch parser/apply, provider config/registry/selection, 4 wire-формата, retries/failure classification/quota fallback, token usage и отсутствие cost-учёта, тестовая сетка. Прогнаны 12 узких наборов тестов (все pass, skip только ожидаемые).

Не проверено: реальный Windows-прогон, PTY-сценарии агентского Bash, сетевые вызовы провайдеров/MCP/embedding, полный unit/typecheck/lint/E2E, стоимость через tokenlens для всех моделей, поведение ripgrep WASI с `.gitignore`, end-to-end provider fallback, продюсеры `assistantAutoBackgrounded`/`backgroundedByUser`.

Блокеров нет; основное содержательное ограничение — research-only режим и отсутствие живой Windows/сетевой среды.

**Подтверждение:** записан только этот файл — `<repo-root>/docs/research/partials/2026-11-11-zcode-08-tools-providers.md`. Продуктовые файлы, конфиги, lockfile и тесты не изменялись; `git status --short` после работы содержит только `?? docs/research/`.
