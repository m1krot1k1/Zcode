# Z09 — Context, memory, rules, skills, plugins, MCP

> Research-only артефакт. Продуктовый код, конфиги, зависимости и lockfile не изменялись.
> Дата исследования: 2026-11-11. Ветка `dev`, HEAD `d10f0b69` (`Выпустить macOS Preview 3.17.102.`).
> Единственная запись этого филиала — данный файл.

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

`docs/research/` уже существовал как untracked-каталог до начала работы; никакие tracked-файлы не менялись.

### 1.2. Загруженный skill и границы

- Skill `research` загружен по точному имени через `Skill`. Применена его дисциплина: primary sources (код, контракты, конфиги, спецификации, тесты), разделение FACT / INFERENCE / UNKNOWN, фиксация недоступного.
- Роль: researcher, read-only. `pnpm typecheck`, `pnpm lint`, полный unit-набор, E2E, сборки и установка пакетов не запускались.
- Разрешённая запись: только этот partial-файл. Остальные изменения не вносились.
- Инструменты: `CodeIndex status` + адресные `search`, затем `rg -n`, `nl -ba`, `sed -n`, `find`, `wc`, `git status/branch/log/blame`. Индекс доступен (`state: ready`, 10 007 файлов, 26 791 chunks), но embedding search в этой среде недоступен (`Embedding search is unavailable; showing lexical results`), поэтому факты ниже проверялись по исходникам, а не по выдаче индекса.
- Метки: **Observed** — прямо видно в файле/команде; **Inferred** — вывод из совокупности фактов; **Unknown** — источники не дают ответа.

### 1.3. Что считается «context» в этом отчёте

Пять связанных, но разных механизмов:

1. **Context assembly** — сборка system prompt и meta-user вложений, порядок, token estimation, prompt caching, compact/microcompact.
2. **Rules** — AGENTS.md, user default instructions, bundled harness rules, workspace `.zcode/rules`.
3. **Memory** — project memory (MEMORY.md + topic files), extraction, recall, consolidation, per-agent memory.
4. **Skills** — SKILL.md, discovery, loading, marketplace, инъекция метаданных.
5. **Plugins и MCP** — расширения, их компоненты, доверие, transport/lifecycle/auth/limits.

## 2. Coverage table

| Область | Статус | Основные доказательства | Что проверено |
| --- | --- | --- | --- |
| Context assembly | Covered | `apps/zcode-cli/packages/core/src/context/builder.ts:83-236`, `:243-337`; `context/types.ts:35-96` | Порядок секций, три system message, meta_user attachments, cache hints, token estimate |
| Token budgeting / truncation | Covered with gaps | `core/context/builder.ts:222-235`; `core/context/sections/skills.ts:9-10,53-60`; `core/memory/index-content.ts:3-4`; `adapters/src/context/index.ts:26-40` | Локальные лимиты есть; общего бюджета контекста нет |
| Compaction / summarization | Covered | `core/compact/policy.ts:6-14`; `compact/prompt.ts:111-165`; `compact/microcompact.ts:12-29`; `runtime/methods/turn-loop.ts:153-190` | Manual/auto/microcompact, пороги, retries, breaker, summary message |
| Prompt caching | Covered | `core/context/builder.ts:36,266-286`; `runtime/helpers/provider-request-messages.ts:326-348` | Ephemeral markers на stable/dynamic system и последнем non-system сообщении |
| AGENTS.md discovery | Covered with contradiction | `adapters/src/context/index.ts:26,571-606,681-720`; `bootstrap/src/builtin-prompt-command.ts:313-319` | User + workspace merge; вложенные и hidden-пути не читаются |
| Workspace rules | Covered with gap | `adapters/src/context/index.ts:223-325,388-493`; `core/context/sections/request-user-context.ts:111-135` | `.zcode/rules/*.mdc`, frontmatter, globs, caps, untrusted label; нет product-продюсера `ruleTargetPaths` |
| Bundled harness rules | Covered | `adapters/src/context/index.ts:33-40,118-221`; `apps/zcode-cli/packages/bundled-skills/rules/*.mdc` | `.mdc` always-on, size caps, path containment, сортировка |
| Project memory | Covered | `core/src/memory/project-root.ts:10-23`; `runtime/helpers/project-memory.ts:4-24`; `context/sections/memory.ts:29-60` | Root, opt-out, MEMORY.md index, формат, лимиты |
| Memory extraction | Covered | `core/src/memory/extraction.ts:6,42-83`; `runtime/helpers/project-memory-extraction.ts:32-77`; `runtime/methods/turn.ts:1061-1077` | Post-turn subagent, гейты, scheduler, tool policy |
| Semantic recall | Implemented but disabled | `core/src/memory/project-memory-retrieval-branch.ts:3-14`; `runtime/helpers/project-memory-recall.ts:46-55` | Код есть, ветка выключена константой |
| Memory consolidation (Dream) | Implemented but not wired | `core/src/memory/dream.ts:9-12,95-170`; `runtime/helpers/project-memory-dream.ts:54` | Prompt/lock/handler есть; автозапуска нет |
| Per-agent memory | Covered | `core/src/subagent/persistent-memory.ts:24-44,76-116,120` | user/project/local scopes, MEMORY.md, secret filtering |
| Skills format/discovery | Covered | `adapters/src/skills/roots.ts:21-138`; `skills/scan.ts:45-155`; `skills/index.ts:68-102,237-316` | Roots, `.zcode`+`.agents`, scan, frontmatter, symlink policy |
| Skills loading/injection | Covered | `core/src/context/sections/skills.ts:9-82`; `core/src/tool/handlers/skill.ts:17-145` | Metadata budget, текст Skill tool, 100KB/200KB caps |
| Skills marketplace | Covered | `adapters/src/skills/marketplace.ts:20-32,47-55,174-213`; `scripts/sync-skills-sh.mjs:1-75`; `skills-sh.lock.json:1` | Search/install, path validation, non-overwrite, sync+lock |
| Skill precedence | Contradiction | `adapters/src/skills/roots.ts:46-55`; `adapters/tests/skills.test.ts:172-199`; `docs/skills-product.md:78-84` | Код и тест: user выигрывает; продукт-док: workspace первый |
| Plugins format/discovery | Covered | `adapters/src/plugins/index.ts:105-113,134-276,898-969` | 3 manifest paths, id, enablement, suppression, duplicates |
| Plugin install/update/remove | Covered | `plugins/marketplace.ts:815-898,1303-1340`; `plugins/atomic-directory.ts:1-40`; `plugins/version-compare.ts:1-45` | Dependency closure, rollback, uninstall, semver/sha |
| Plugin permissions/sandbox | Gap | `plugins/index.ts:371-376`; `docs/claude-code-marketplace-plugin-compat.md:267-283` | Хуки всегда runnable; sandbox не найден |
| Plugin components | Covered | `plugins/index.ts:341-368,677-714`; `plugins/mcp.ts:22-69`; `contracts/src/plugins/index.ts:144-166` | skills/commands/hooks/MCP/userConfig/ui; agents парсятся в Agent profiles в bootstrap |
| MCP config/locations | Covered | `adapters/src/config/schema.ts:48-116,340-384,465-511`; `docs/settings-directory-sources.md:26-33`; `packages/desktop/src/main/mcpUserDirectory/index.ts:37-66,334-348` | `.zcode/config.json`, `.agents/mcp.json`, plugin `.mcp.json`, legacy normalization |
| MCP transports | Covered | `adapters/src/mcp/index.ts:1917-1969`; `contracts/src/interfaces/mcp.port.ts:8-10` | stdio, Streamable HTTP, SSE |
| MCP version negotiation | Covered | `adapters/src/mcp/index.ts:2328-2380`; `docs/mcp-dual-era-version-negotiation.md:1-50` | auto/legacy/pin 2026-07-28, probe timeouts |
| MCP lifecycle/pool | Covered | `adapters/src/mcp/index.ts:305-449`; `mcp/pool.ts:34-80,460-560` | replace semantics, disconnect, lease, isolation, reconnect |
| MCP auth | Covered | `adapters/src/mcp/index.ts:1491-1546,1972+`; `mcp/oauth-*.ts`; `docs/mcp-oauth-two-phase.md:1-40` | OAuth client_credentials/authorization_code, official origin trust, provenance |
| MCP permissions | Covered | `core/src/mcp/index.ts:166-185,259-267`; `core/src/permission/service.ts:485-492,565-575` | needsApproval=true, risk mapping, plan mode nuance |
| MCP output limits | Covered | `core/src/mcp/index.ts:48-53,186-210,284-355,627-655`; `docs/mcp-tool-output-budget.md:1-60` | 100KB/50KB truncate, paging, image 200KB, CUA/node_repl budgets |
| MCP resources/subscriptions | Covered | `contracts/src/interfaces/mcp.port.ts:429-490`; `adapters/src/mcp/resource-subscriptions.ts` | list/read/templates/subscribe/unsubscribe, notifications |
| MCP prompts/sampling/roots/completion | Absent | repo-wide `rg` (см. §8.4) | Нет port-методов и adapter-кода |
| Tests | Covered | `core/tests/context-builder.test.ts` (49 it), `adapters/tests/fs-context.test.ts` (37), `adapters/tests/plugins.test.ts` (76), etc. | Есть unit-покрытие; E2E ограничен memory/compact/plugins |
| Runtime verification | Not run | — | Никакие тесты/сборки не исполнялись |

## 3. Capability inventory

### 3.1. Context assembly

**FACT.** `ContextBuilder.build()` собирает секции в фиксированном порядке (`apps/zcode-cli/packages/core/src/context/builder.ts:83-236`):

1. CLI prefix (`:101-106`);
2. stable body: `Custom System Prompt` либо workflow-actor identity, либо обычная identity (`:108-123`);
3. dynamic system: Desktop context, Dynamic Behavior, Session Guidance, Memory, Env Info, Output Style, Context Management, Git snapshot (`:125-184`);
4. Skills listing (`:186-198`);
5. meta-user: Request User Context (AGENTS.md, harness rules, workspace rules, MEMORY.md), Current Date (`:200-215`);
6. custom sections (`:217-218`).

**FACT.** Порядок инъекции жёстко фиксирован: `system/stable → system/dynamic → meta_user/stable → meta_user/dynamic` (`builder.ts:322-337`). Затем собираются три system message (`:243-289`) и meta-user attachments (`:291-319`); конвертация в entries — `runtime/methods/context-history-entries.ts:7-16`.

**FACT.** `cli_prefix` идёт отдельным system message без `cacheControl`; stable body и dynamic system получают `{ type: "ephemeral" }` (`builder.ts:246-286`). Дополнительно последнее non-system сообщение получает ephemeral marker, а прежние non-system markers очищаются (`runtime/helpers/provider-request-messages.ts:326-367`). Это единственный механизм prompt caching в коде; provider-specific TTL/namespace не настраивается.

**FACT.** Token estimation грубый: `ceil((chineseChars*2 + otherChars)/3)` (`context/utils.ts:12-18`; делитель `packages/shared/src/usage-stats.ts:9`). Totals только считаются и логируются (`builder.ts:222-235`; `runtime/methods/context.ts:333-360`), но **не ограничивают** сумму секций.

**FACT.** Локальные лимиты:

| Объект | Лимит | Файл:строка |
| --- | --- | --- |
| AGENTS.md (один файл) | 100 KB | `adapters/src/context/index.ts:27` |
| Bundled harness rule | 16 KB на файл, 64 KB суммарно | `:39-40` |
| Workspace rule | 64 KB на файл, 256 KB суммарно | `:29-30` |
| Workspace rule globs | ≤32 glob, ≤64 brace expansions | `:31-32` |
| MEMORY.md index | 200 строк и 25 000 символов | `core/src/memory/index-content.ts:3-4` |
| Skills metadata listing | 20 000 **символов** (не токенов) | `core/src/context/sections/skills.ts:9,53-60` |
| Описание skill в listing | 250 символов | `:10,63-71` |

**FACT.** `ContextBuilderConfig` поддерживает `customSystemPrompt`, `workflowActor`, `outputStyle`, `language`, `compact`, `guidanceToolNames`, `taskDagAvailable`, `skills`, `memoryRoot`, `memoryIndexContent`, `userInstructions`, `bundledHarnessRules`, `workspaceRules`, `presentationSurface` (`core/src/context/types.ts:106-149`). `customSystemPrompt` и `workflowActor` взаимоисключающи; иначе builder бросает ошибку (`builder.ts:90-98`).

**FACT.** Context prefix пересобирается при смене model/outputStyle/language: `runtime/methods/context-refresh.ts:7-46` пересоздаёт builder и заменяет первые `context_prefix` entries, сохраняя канонический диалог.

**FACT.** Code-index hint добавляется в turn как attachment: только при `codeIntelligencePort`, только не `model-only`, статус индекса `ready`, 800 ms timeout, 4 hits, lexical-only, бюджет 12 000 символов (`runtime/helpers/runtime-reminders.ts:282-338`; вызов `runtime/methods/turn.ts:660-667,2677-2692`). Это не отдельная секция system prompt и не замена CodeIndex tool.

### 3.2. Project rules

**FACT.** AGENTS.md discovery (`adapters/src/context/index.ts:571-606`):

- `DEFAULT_PRIORITY_FILES = ["AGENTS.md"]` (`:26`);
- user default — ровно `~/.zcode/AGENTS.md` (`:706-720`), учитывая `HOME`/`USERPROFILE`;
- workspace file ищется от `workingDirectory` вверх до project root (первый `.git`-маркер) (`:681-704`, `:797-806`);
- найденные источники дедуплицируются по абсолютному пути (`:619-634`), читаются с cap 100 KB (`:636-662`) и **конкатенируются**: user первым, workspace вторым (`:664-679`). В prompt они рендерятся как отдельные `Contents of ... (user default instructions)` / `(workspace instructions)` (`core/src/context/sections/request-user-context.ts:180-198`).

**FACT.** Вложенные AGENTS.md не мержатся: `findInstructionFile` возвращает первый найденный файл и прекращает поиск (`:688-703`). Тест покрывает только пару user+workspace (`adapters/tests/fs-context.test.ts:1075-1135`).

**FACT.** **Runtime не читает `<workspace>/.zcode/AGENTS.md` и `<workspace>/.agents/AGENTS.md`.** Единственные упоминания этих путей — prompt встроенной команды `/init` (`bootstrap/src/builtin-prompt-command.ts:313-319`) и spec `docs/zcode-init-agents-md-command.md:27`, где они называются «existing hidden instructions». В `NodeContextSourceAdapter` таких кандидатов нет (repo-wide `rg` нашёл только `/init` и onboarding-migration сервиса для `~/.zcode/AGENTS.md`).

**FACT.** Bundled harness rules — `.mdc` в `apps/zcode-cli/packages/bundled-skills/rules`, всегда `alwaysApply: true`, без globs, с ненулевым телом; иначе диагностика и пропуск (`adapters/src/context/index.ts:118-221`). Сейчас в пакете 7 файлов `00-evidence` … `06-progress` (`apps/zcode-cli/packages/bundled-skills/rules/00-evidence.mdc:1` и соседние).

**FACT.** Workspace rules — только `<projectRoot>/.zcode/rules/*.mdc` (`adapters/src/context/index.ts:28,223-325`). Frontmatter: `description`, `alwaysApply`, `globs`; прочие ключи дают диагностику, но не блокируют (`:388-493`). `alwaysApply` применяются всегда; glob-правила — только если запрос содержит `ruleTargetPaths`, совпавшие с glob (`:296-303`). Сортировка в prompt: `alwaysApply` раньше glob, затем по `filePath` (`request-user-context.ts:115-118`).

**FACT.** Workspace rules помечены как untrusted: заголовок и текст прямо запрещают менять permissions/tool access/trust boundaries (`request-user-context.ts:79-86,132-134`). Bundled harness rules имеют аналогичную оговорку (`:105-108`).

**GAP (observed).** `ruleTargetPaths` не производится ни одним продуктовым слоем: repo-wide поиск даёт только `runtime/types.ts:272`, `runtime/methods/context.ts:64-66`, `contracts/.../context-source.port.ts:29,91`, `adapters/src/context/index.ts:78` и тесты. Ни UI, ни services, ни bootstrap не передают target paths. Следствие: **в реальной сессии применяются только alwaysApply-правила; glob-правила `.zcode/rules` фактически не активируются**, хотя тест `fs-context.test.ts:959-992` проверяет их на прямом вызове адаптера.

**FACT.** Пользовательских `.zcode/rules` вне workspace нет: `WORKSPACE_RULE_DIRECTORIES` — единственный каталог, user-root rules не сканируются.

### 3.3. Memory

**FACT.** Project memory root: `<cliStorageRoot>/memories/projects/<slug>-<hash16>/memory`, где hash берётся от `workspaceIdentity` (если задан) либо нормализованного `workspacePath` (`core/src/memory/project-root.ts:10-23`). Включение: `features.memory` (default `true`), `memory.use` (default `true`), непустой `cliStorageRoot`, и только для main-подобных task types (`runtime/helpers/project-memory.ts:4-24`; defaults `contracts/src/config/index.ts:316-326`).

**FACT.** В system prompt добавляется секция `# Memory` с инструкцией формата: один факт — один файл, frontmatter `name`, `description`, `metadata.type` (`user|feedback|project|reference`), ссылки `[[name]]`; при `default-index` — однострочный указатель в `MEMORY.md` (`core/src/context/sections/memory.ts:29-60`). Сам `MEMORY.md` подгружается в meta-user с заголовком `Contents of ... (user's auto-memory, persists across conversations)` (`request-user-context.ts:137-150`), с обрезкой 200 строк/25 000 символов и warning-хвостом (`memory/index-content.ts:13-40`).

**FACT.** Post-turn extraction: после успешного turn планируется фоновый subagent (`runtime/methods/turn.ts:1061-1077`), если `memory.extractionEnabled !== false` (`runtime/helpers/project-memory-extraction.ts:38`), не remote workspace (`:41`), есть session store/FS/model (`:42-44`). Гейт: минимум 3 слова пользовательской прозы и отсутствие прямого Write/Edit в memory root (`memory/extraction.ts:6,68-83`). Scheduler single-flight, хранит только последний pending snapshot, cursor по message id, `drain` до 60 s (`extraction.ts:85-301`; `project-memory-extraction.ts:14`).

**FACT.** Tool policy memory-агента: Read/Grep/Glob разрешены; Write/Edit — только contained `.md` внутри memory root; Bash — только read-only либо `rm` contained `.md`; Agent, `mcp__*`, network tools запрещены (`core/src/memory/memory-agent-loop.ts:127-169`). Дополнительно запрещены sensitive path segments (`.git`, `.zcode`, `skills`, `commands`, `agents`, `hooks`, `node_modules` и др.) (`memory/memory-file-path.ts:5-46`). При записи в memory frontmatter добавляется `metadata.node_type: memory` и `originSessionId`, если их нет (`memory/origin-session.ts:7-45`).

**FACT.** Semantic recall реализован, но **выключен**: `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false` (`memory/project-memory-retrieval-branch.ts:3-14`), а prefetch сразу возвращается при ветке, отличной от `semantic-recall` (`runtime/helpers/project-memory-recall.ts:51`). Код содержит manifest-scan (200 файлов, 30 строк preview), LLM-selector с JSON Schema (до 5 memories), лимит 61 440 символов на сессию, чтение 200 строк/4096 байт на файл и stale-warning (`memory/recall/manifest.ts:12-44`; `recall/selector.ts:15-27,128-141`; `recall/index.ts:20-31`; `recall/content.ts:5-7,27-99`).

**FACT.** Memory consolidation (Dream) реализован как prompt + lock + memory-agent loop (`memory/dream.ts:9-12,95-239`; `runtime/helpers/project-memory-dream.ts:71-170`), но **автоматически не запускается**: в коде явный комментарий «текущая продуктовая цепочка не запускает Dream автоматически», и `runProjectMemoryDream` вызывается только из тестов (`project-memory-dream.ts:54`; `core/tests/runtime-memory-dream.test.ts:247,326`).

**FACT.** Per-agent memory: профиль subagent может иметь `memory: user|project|local`; user — `<storageRoot>/agent-memory/<agentKey>`, project — `<workspace>/.zcode/agent-memory/<agentKey>`, local — `<workspace>/.zcode/agent-memory-local/<agentKey>` (`subagent/persistent-memory.ts:24-44`). Загружается `MEMORY.md` каждого child launch (`:76-116`). Evidence-gated lessons пишутся только при «тот же инструмент сначала упал, потом succeeded» и фильтруют secret-подобные токены (`:118-199`).

**FACT.** Remote workspace исключён из extraction, dream и persistent agent memory (`project-memory-extraction.ts:41`; `project-memory-dream.ts:61`; `persistent-memory.ts:212`).

**FACT.** Память хранится вне workspace, в `cliStorageRoot`; UI имеет `MemorySettingsSection` с `memoryEnabled` и списком проектных памятей (`packages/ui/src/settings/MemorySettingsSection.tsx:47-183`; сервис `packages/services/src/memory/memoryService.ts:215`). Точная запись `features.memory` из этого UI в рамках исследования не прослежена — **Unknown**.

### 3.4. Skills

**FACT.** Формат: каталог с `SKILL.md`; frontmatter опционален. Если frontmatter есть, обязательны `name` и `description`; `description` ≤1024 символов; `when_to_use` читается как `whenToUse`; без frontmatter имя берётся из имени каталога (`adapters/src/skills/index.ts:237-316`). `version` в `SkillMetadata` отсутствует (`contracts/src/skills/index.ts:43-59`) — версионирование skill на уровне формата не поддерживается.

**FACT.** Discovery roots (`adapters/src/skills/roots.ts:21-72`):

- `skills.roots` (extraRoots) — первыми;
- `~/.zcode/skills` и `~/.agents/skills` (user);
- для cwd и каждого родителя до worktree root — `<dir>/.zcode/skills` и `<dir>/.agents/skills` (project);
- `additionalDirectories` — с namespace по basename;
- `extraResolvedRoots` (plugin skills, bundled skills).

Каждый base даёт **оба** корня — `.zcode` и `.agents`; это merge, а не fallback (`roots.ts:107-117`). `.cursor` не читается (тесты `skills.test.ts:268-319`).

**FACT.** Scan: `SKILL.md` в самом root и ровно на один уровень ниже; dot-directories допускаются только по allowlist; для plugin-scope symlink не разыменовывается ни на уровне root, ни каталога, ни файла; для user/project — разыменовывается (`adapters/src/skills/scan.ts:30-155`; `packages/shared/src/skill-scan-policy.ts:53-61`). Ошибки кроме ENOENT пробрасываются, чтобы дать `skill_scan_failed`, а не тихий пустой список (`scan.ts:17-24,140-155`).

**FACT.** Дедупликация — **по абсолютному пути**, не по имени; одинаковые имена из разных источников сохраняются как отдельные записи (`skills/index.ts:77-101`; тест `skills.test.ts:172-199,433-466`). `loadSkill` выбирает первое совпадение `name` или `qualifiedName` в списке, отсортированном по имени (stable sort сохраняет порядок roots) (`skills/index.ts:186-189,495-497`). Поскольку user roots идут раньше project roots (`roots.ts:46-55`), при одинаковом имени **побеждает user skill**. Тест это фиксирует: `loaded.metadata.description === "User description"` (`skills.test.ts:186-189`).

**CONTRADICTION.** `docs/skills-product.md:78-84` утверждает приоритет `Workspace > User > Extension` и «同名技能按高优先级覆盖低优先级». Код и тест дают обратный результат для same-name load. Это расхождение продукт-документа и реализации (**Observed**).

**FACT.** Инъекция в prompt — только метаданные: имя/qualifiedName, description (≤250 символов), `when_to_use`, путь; при превышении `skillMetadataBudget` (20 000 символов) остаются только имена и пути (`core/src/context/sections/skills.ts:9-82`). Секция идёт как отдельный meta-user attachment `skills_listing` (`builder.ts:186-198,291-304`). Полный текст загружается только через tool `Skill` (`core/src/tool/handlers/skill.ts:37-91`), в обёртке `<skill_content>`, с base directory и подстановкой `${CLAUDE_SKILL_DIR}`/`${ZCODE_SKILL_DIR}` (`:78-96`).

**FACT.** Ограничения текста: обычный skill 100 000 байт, `dynamic-workflows` 200 000 байт; результат tool — до 204 096 байт (`skill.ts:17-35,126,147`). Frontmatter при загрузке отрезается (`skills/index.ts:198`).

**FACT.** Disable: `disabledPaths` из `skillOverrides` (`bootstrap/src/skills.ts:127`), сравнение и по scan-path, и по realpath (`skills/index.ts:318-327`). `skills.enabled`/`features.skill` выключают discovery (`bootstrap/src/skills.ts:97`). `skills.includeInstructions` существует в конфиге и схеме, но **потребителя в runtime нет** — grep находит только config plumbing (`adapters/src/config/index.ts:165-166,318`; `contracts/src/config/index.ts:241,340`).

**FACT.** `safeToAutoLoad` вычисляется как «все frontmatter keys входят в {name, description, when_to_use, license, metadata}» (`skills/index.ts:31-37,310`), но в production не потребляется: единственное использование — CLI `skills inspect` (`cli/src/skills-command.ts:160,228`). `policy.allowImplicitInvocation` жёстко `true` (`skills/index.ts:312-314`); поля `disable-model-invocation` нет. Tool `Skill` имеет `needsApproval: false`, `riskLevel: "low"`, `sideEffectScope: "session"` (`tool/handlers/skill.ts:122-145`). Следствие (**Inferred**): любая найденная skill может быть загружена моделью без отдельного подтверждения; ограничение — только список в prompt и поведение модели.

**FACT.** Marketplace: `SkillSearch`/`SkillInstall` tools, установка в `<workspace>/.agents/skills` или `~/.agents/skills` (`adapters/src/skills/marketplace.ts:47-55`). Snapshots валидируются: ≤500 файлов, ≤10 MB суммарно, ≤5 MB на файл, обязательный `SKILL.md` в корне, запрет абсолютных путей и `..` (`:21-31,107-172`). Overwrite разрешён только для marketplace-managed каталога с совпадающим `source`; hand-written skill не перезаписывается (`:183-195`). `SkillInstall` имеет `riskLevel: "medium"`, `sideEffectScope: "workspace"`, `needsApproval: false` (`tool/handlers/skill-marketplace.ts:190-198`), поэтому в build mode попадает под общий ask по side effects (`permission/service.ts:565-575`).

**FACT.** `pnpm skills:sync` → `scripts/sync-skills-sh.mjs`; дефолт 20 skills, `minInstalls=1000`, курируемый список и тематические queries, lock `skills-sh.lock.json` с hash; уже существующие имена и каталоги пропускаются (`scripts/sync-skills-sh.mjs:26-75,262-367`; `skills-sh.lock.json:1-20`). В lock сейчас 138 строк, записи содержат `source/skillId/name/hash` (**Observed**).

**FACT.** Plugin skills получают `pluginName`/`pluginId`/`qualifiedName = <pluginName>:<skill>` (`skills/index.ts:329-342,297-304`); загрузка возможна и по qualified, и по bare имени (`:495-497`). Bare alias выводится в listing (`context/sections/skills.ts:74-81`).

### 3.5. Plugins

**FACT.** Manifest discovery: `.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json` (`adapters/src/plugins/index.ts:105-107,935-948`). Валидируется только JSON-object и `name` по `^[a-z0-9][a-z0-9._-]{0,127}$`; `version` при отсутствии = `0.0.0`; остальные поля проходят как есть (`:950-969`). `UNSUPPORTED_COMPONENT_KEYS = channels, lspServers, outputStyles, settings` — только diagnostic warning, не блокировка (`:112,378-389`).

**FACT.** ID плагина = `<name>@<marketplace>`; duplicate id игнорируется с `plugin_duplicate_id` (первый кандидат выигрывает) (`:151-175`). Кандидаты: inline dirs → official roots → official cache → installed marketplace records (`:238-276`). Официальные built-ins можно «удалить» только через `suppressedBuiltins`; suppression фильтрует discovery, не удаляя cache (`:155-160`); восстановление — снятие suppression (`bootstrap/tests/plugins.test.ts:1121-1234`).

**FACT.** Enablement: `config.enabledPlugins[id] ?? candidateDefaultEnabled || officialPluginsEnabledByDefault` (`plugins/index.ts:176-181,994-996`). Компоненты: `skills` (`skills/` или manifest paths), `commands`, `hooks` (`hooks/hooks.json` + manifest), `mcpServers` (`.mcp.json` + manifest `mcpServers`, namespaced `plugin:<name>:<server>`), `userConfig`, `ui.surfaces` (`:341-368,677-714`; `plugins/mcp.ts:22-69`; `plugins/ui-surfaces.ts`).

**FACT.** Plugin MCP: `.mcp.json` и manifest-спека мержатся, manifest перекрывает файл; неизвестный transport/ошибка конфигурации даёт `plugin_mcp_server_disabled` и пропуск только этого server (`plugins/mcp.ts:22-69,196-293`). Env/headers/args раскрывают `userConfig`, env vars и пути; `env` и `headers` используют `allowSensitive: true`, т.е. плагин может подставить произвольную переменную окружения процесса в env/headers MCP-сервера (`:214-226,255-258`; тест `plugins.test.ts:3750-3810`). Host authority `_plugin id` пишется после manifest env и не может быть переопределён (`:227-230`). Official auth `zcode_official` разрешён для http и stdio, запрещён для sse; `official` provenance генерируется хостом и не читается из `.mcp.json` (`:196-293`).

**FACT.** Install: `installMarketplacePlugin` разрешает dependency closure, блокирует cross-marketplace зависимости по умолчанию, детектирует циклы, кэширует каждый плагин и делает rollback активаций при ошибке (`plugins/marketplace.ts:815-874,1303-1340`). Активация каталога атомарная с transaction-файлом и recovery (`plugins/atomic-directory.ts:1-437`). Uninstall удаляет record, при `removeCache` — cache и (если не `keepData`) `data/<plugin-id>` (`marketplace.ts:876-898`). CLI: `zcode plugins list/install/uninstall/enable/disable/update/validate/marketplace ...` (`cli/src/plugins-command.ts:38-52`).

**FACT.** Update: semver `coerce`; если версии не парсятся, но различаются — `version-changed`; если version нет, сравнивается source sha (`plugins/version-compare.ts:1-45`).

**FACT.** Hooks: `canRunPluginHooks()` **всегда возвращает `true`**, включая third-party marketplace; комментарий прямо признаёт, что прежняя граница «только official hooks» снята (`plugins/index.ts:371-376`). `hookInspection.events` попадают в `component.hooks` для enabled-плагина (`:186-200`), затем `mergeRuntimeHooks` подмешивает их в runtime config и включает hooks (`bootstrap/src/app/runtime-config.ts:178-182,265-287`).

**CONTRADICTION.** `docs/claude-code-marketplace-plugin-compat.md:274-275` утверждает: «第三方 marketplace hooks 默认不注入 runtime; только ZCode official, Claude official или explicit inline trusted…». Код и тест `plugins.test.ts:3549` («runs Marketplace cache hooks from third-party marketplaces when enabled») показывают обратное. Документ устарел относительно кода.

**GAP.** Sandbox для плагинов не найден: `rg "sandbox"` в `adapters/src/plugins`, `adapters/src/mcp` не даёт совпадений. Плагинные hooks исполняются как команды процесса; plugin MCP stdio запускает процесс с sanitized env, но это не sandbox.

**FACT.** Plugin agents **загружаются** как Agent profiles: `create-app.ts:259-279` вызывает `loadPluginAgentTemplates` → `resolvePluginAgentProfiles`; парсинг markdown и namespacing — `bootstrap/src/subagents.ts:113-184,186-234`. Bare-имя добавляется только при отсутствии reserved/ambiguity; при конфликте — `agent_ambiguous_name` (`:154-169`).

**CONTRADICTION.** `docs/claude-code-marketplace-plugin-compat.md:269-270` утверждает «Plugin agents V1 не运行 / runtime Explore-only». Код исполняет plugin agents как профили. Это расхождение docs↔code в plugin-слое (см. §8.5, C-05).

### 3.6. MCP

**FACT.** Конфигурация:

- workspace `.zcode`: `<workspace>/.zcode/config.json` → `mcp.servers`;
- workspace `.agents`: `<workspace>/.agents/mcp.json` → `mcpServers`, только если `.zcode` не дал ни одного server;
- user `.zcode`: `~/.zcode/cli/config.json` → `mcp.servers`;
- user `.agents`: `~/.agents/mcp.json` → `mcpServers`, fallback;
- plugin: `.mcp.json` + manifest `mcpServers`;
- built-in servers мержатся последними и сохраняют identity (`docs/settings-directory-sources.md:26-33`; `packages/desktop/src/main/mcpUserDirectory/index.ts:37-66,334-348`; `bootstrap/src/app/runtime-config.ts:97-104`).

**FACT.** Config schema строгая: три transport-а (`stdio|http|sse`), неизвестные поля отбрасывают **этот** server с `config_mcp_server_invalid`, остальные servers и остальная конфигурация сохраняются (`adapters/src/config/schema.ts:48-116,465-511`). Legacy normalization: `environment→env`, `enable→enabled` (конфликт трактуется как disable), `type:"remote"→http`, `http_headers→headers` (`:340-384`). `protocolVersion` принимает `auto|legacy|2026-07-28` (`:50-51`). Поля `source`/`official` — runtime-only, конфигом не задаются (`contracts/src/interfaces/mcp.port.ts:12-15,60-64`).

**FACT.** Trust: комментарий и код говорят «product decision: project MCP trusted by default and auto-connected»; `untrustedProjectMcpServers` создаётся пустым и нигде не наполняется (`bootstrap/src/app/runtime-config.ts:116-121`; `bootstrap/src/zcode-protocol/mcp.ts:75-76`). Статус `untrusted` и текст «Project MCP server requires explicit connection before use» существуют в projection (`bootstrap/src/mcp-config.ts:205-217`), но в текущем продукт-пути не применяются. Следствие (**Inferred**): MCP server из workspace-конфига, включая stdio с произвольной командой, стартует автоматически при создании runtime (`core/src/runtime/methods/mcp.ts:42-120`).

**FACT.** Transport-ы: `ProcessTreeStdioClientTransport` (stdio, process-tree termination, stderr pipe), `StreamableHTTPClientTransport`, `SSEClientTransport` (`adapters/src/mcp/index.ts:1917-1969`; `stdio-transport.ts`; `process-tree.ts`). stdio env получает sanitized runtime env + proxy/CA настройки + per-server env (`:1925-1928`; `network.ts:8-30`); HTTP/SSE получают proxy-aware fetch (`network.ts:32-43`).

**FACT.** Version negotiation: `auto` по умолчанию для stdio/http, `legacy` для sse, pin `2026-07-28` без fallback; probe timeout ≤5 s для auto и полный connect timeout для pin (`adapters/src/mcp/index.ts:2328-2380`; `docs/mcp-dual-era-version-negotiation.md:14-50`). Server version (`serverInfo.version`) не сохраняется и не сравнивается — drift detection отсутствует (**Inferred** из отсутствия полей/кода).

**FACT.** Lifecycle: `connectConfiguredServers` — replace-семантика: servers, отсутствующие в новом наборе, отключаются; одинаковый config переиспользуется; OAuth-pending connection переиспользуется (`adapters/src/mcp/index.ts:305-341`). `disconnectServer` увеличивает generation, закрывает record и оставляет статус `disconnected` (`:436-449`). Pool: lease на session, idle grace, `isolation: session` по умолчанию, `workspace` только при явном `isolation:"workspace"` (`mcp/pool.ts:34-58,460-560`). Runtime стартует MCP при инициализации контекста (`core/src/runtime/methods/context.ts:78`; `methods/mcp.ts:42-120`), ждёт OAuth не более 15 s на session (`methods/mcp.ts:12,76`), регистрирует tools до первого model request (`:123-175`), обновляет по `notifications/tools/list_changed` только на границе turn (`:203-230`).

**FACT.** Timeouts: default `30_000 ms` per server (`adapters/src/mcp/index.ts:106`), ping `5_000 ms` (`:108`), tool-level `_meta.timeoutMs` принимается в диапазоне `1_000 … 30*60*1000` (`contracts/src/interfaces/mcp.port.ts:353-354`; `mcp/descriptor.ts:38-44`). Tool call не разрешает caller override (`core/src/mcp/index.ts:269-272`), но использует descriptor timeout.

**FACT.** Retries: ровно один reconnect+retry при точном `"Not connected"`; другие ошибки не ретраятся (`adapters/src/mcp/index.ts:828-850,1255-1263`). OAuth runtime recovery: Phase 2 interactive authorization → Phase 1 reconnect → один безопасный retry (`:1265-1280`; `docs/mcp-oauth-two-phase.md:1-40`). Cross-process refresh идёт через file lease/lock (`mcp/oauth-lease.ts`, `oauth-refresh.ts`).

**FACT.** Auth: `client_credentials` и `authorization_code` OAuth (`contracts/src/interfaces/mcp.port.ts:26-47`), official `zcode_official` с `provider:"jwt_token"` для http/stdio (`:49-66`), origin trust — точное совпадение с ZCode API origin, loopback-http только для self-test (`:376-397`; `packages/shared/src/official-mcp-auth.ts`). Для http identity-заголовки инжектятся в fetch wrapper; для stdio — в `_meta` каждого запроса (`:49-66`; `adapters/src/mcp/official-auth.ts`). Static reserved headers при official auth запрещены (`plugins/mcp.ts:268-275`).

**FACT.** Permissions: каждый MCP tool имеет `permission: "mcp"`, `needsApproval: true`, `sideEffectScope` `network` (кроме host `node_repl/js` → `system`), risk `low` при readOnlyHint, `high` при destructiveHint, иначе `medium`; `node_repl/js` — `high` (`core/src/mcp/index.ts:166-185,259-267`). Plan mode разрешает non-destructive MCP tools (`permission/service.ts:485-492`); build mode для side-effect tools уходит в ask (`:565-575`).

**FACT.** Output limits: обычный MCP — `maxInlineBytes 100_000`, `maxModelBytes 50_000`, strategy `truncate`; host `node_repl/js` — `1_000_000` inline, `64_000` model, strategy `artifact`, retention session; официальный CUA — `256_000/256_000` с modelContentProtection (`core/src/mcp/index.ts:186-210,219-231`). Текстовые результаты >40 000 байт разбиваются на страницы по 40 000, хранятся до 1 000 000 байт, максимум 32 записи в process map; page request проверяет `sessionId` (`:48-53,627-693`). MCP images: inline base64 ≤200 KiB, иначе artifact или текст; host node_repl image может сжиматься (`mcp/image-normalization.ts:21-23,131-182`; `docs/mcp-tool-output-budget.md:1-60`).

**FACT.** Resources: `readResource`, `listResources`, `listResourceTemplates`, `subscribeResource`, `unsubscribeResource`, `unsubscribeResourcesBySubscriber`, notifications `resourceUpdated`/`resourceListChanged`/`toolListChanged`/`loggingMessage` (`contracts/src/interfaces/mcp.port.ts:429-490`; `adapters/src/mcp/resource-subscriptions.ts`; `resource-telemetry.ts`). Elicitation: только `form` mode; server→client `elicitation/create` идёт в host port (`mcp.port.ts:399-427`; `adapters/src/mcp/index.ts:1538-1547`; `bootstrap/src/zcode-protocol-v4/mcp-elicitation.ts`).

**ABSENT.** MCP `prompts/list`, `prompts/get`, sampling, roots, completion: ни в `McpPort`, ни в adapters/core нет соответствующих методов; repo-wide поиск не нашёл MCP-упоминаний (см. §8.4). Ресурсы и tools — единственные model-facing поверхности.

**PLANNED, NOT IMPLEMENTED.** Process-scoped tool catalog cache (32 entries, 30 min TTL) описан как «规划» и не реализован (`docs/mcp-async-tool-catalog-cache.md:3-6,43-49`). В коде MCP startup по-прежнему блокирует первый model request до `connect + listTools` (`core/src/runtime/methods/turn-loop.ts:193-197`).

### 3.7. Tests

**FACT (counts by `grep -c '  it('`, static):**

| Файл | Кол-во `it(` |
| --- | ---: |
| `apps/zcode-cli/packages/core/tests/context-builder.test.ts` | 49 |
| `apps/zcode-cli/packages/adapters/tests/fs-context.test.ts` | 37 |
| `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts` | 37 |
| `apps/zcode-cli/packages/adapters/tests/mcp.test.ts` | 37 |
| `apps/zcode-cli/packages/adapters/tests/plugins.test.ts` | 76 |
| `apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts` | 45 |
| `apps/zcode-cli/packages/adapters/tests/skills.test.ts` | 19 |
| `apps/zcode-cli/packages/adapters/tests/skill-marketplace.test.ts` | 4 |
| `apps/zcode-cli/packages/bootstrap/tests/skills.test.ts` | 5 |
| `apps/zcode-cli/packages/core/tests/memory-recall.test.ts` | 19 |
| `apps/zcode-cli/packages/core/tests/runtime-memory-extraction.test.ts` | 18 |
| `apps/zcode-cli/packages/core/tests/memory-dream.test.ts` | 7 |
| `apps/zcode-cli/packages/core/tests/memory-agent-loop.test.ts` | 8 |
| `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts` | 67 |
| `apps/zcode-cli/packages/core/tests/compact-policy.test.ts` | 14 |
| `apps/zcode-cli/packages/core/tests/microcompact.test.ts` | 11 |

Плюс отдельные MCP-файлы: `mcp-connection-pool` 16, `mcp-official-auth` 25, `mcp-oauth.e2e` 21, `mcp-version-negotiation` 3, `mcp-process-lifecycle` 7, `mcp-network` 3 и др. (суммарно >150 MCP-кейсов).

**FACT.** Покрыты: порядок/содержимое context sections и точные provider-visible строки (`context-builder.test.ts:79-1767`), workspace rules и AGENTS.md merge (`fs-context.test.ts:852-1189`), compact policy/retry/rapid-refill (`runtime-compact.test.ts`, `compact-policy.test.ts`), memory extraction/recall/dream/agent-loop, skill discovery/precedence/disabled/symlink, plugin discovery/manifest/install/rollback/hooks/MCP variables, MCP OAuth/official auth/pool/transports/timeouts.

**GAP.** E2E: `apps/zcode-cli/e2e/memory` и `apps/zcode-cli/e2e/compact-microcompact` есть; plugin UI E2E лежит в `packages/desktop/test/e2e/plugins/manual-review/pending/` (не в активном наборе). E2E для MCP-транспортов и skill marketplace в CLI не найден. Тесты не запускались в этом исследовании.

## 4. Gaps, risks, weaknesses

| ID | Проблема | Доказательство | Тип |
| --- | --- | --- | --- |
| G-01 | Third-party plugin hooks исполняются без trust gate и sandbox; docs утверждают обратное | `adapters/src/plugins/index.ts:371-376`; `bootstrap/src/app/runtime-config.ts:178-182,265-287`; `docs/claude-code-marketplace-plugin-compat.md:274-275` | Security / contradiction |
| G-02 | Project-scope MCP auto-connect, включая stdio-команды из repo-конфига; `untrustedProjectMcpServers` всегда пуст | `bootstrap/src/app/runtime-config.ts:116-121`; `bootstrap/src/zcode-protocol/mcp.ts:75-76`; `core/src/runtime/methods/mcp.ts:42-120` | Security |
| G-03 | Skill precedence user > project, продукт-док обещает project > user | `adapters/src/skills/roots.ts:46-55`; `skills.test.ts:172-199`; `docs/skills-product.md:78-84` | Correctness / contradiction |
| G-04 | Runtime не читает `.zcode/AGENTS.md`/`.agents/AGENTS.md`, хотя `/init` называет их существующими инструкциями | `adapters/src/context/index.ts:681-720`; `bootstrap/src/builtin-prompt-command.ts:313-319` | Correctness / UX |
| G-05 | Вложенные AGENTS.md не мержатся: берётся первый файл по пути вверх | `adapters/src/context/index.ts:688-703` | Capability gap |
| G-06 | Нет общего token budget/детерминированной деградации контекста; только локальные caps | `core/src/context/builder.ts:222-235`; caps в §3.1 | Context bloat |
| G-07 | Compaction lossy и без указателя на transcript: опция `transcriptPath` не передаётся | `compact/prompt.ts:146-148`; `runtime/methods/compact-active.ts:581-583` | Context recovery |
| G-08 | Semantic recall выключен, Dream не подключён; retrieval = только MEMORY.md index | `memory/project-memory-retrieval-branch.ts:3-14`; `runtime/helpers/project-memory-dream.ts:54` | Memory capability |
| G-09 | `ruleTargetPaths` не производится продуктом → glob-правила `.zcode/rules` не работают в реальной сессии | repo-wide `rg`; `fs-context.test.ts:959-992` | Rules correctness |
| G-10 | `safeToAutoLoad` не enforced, `allowImplicitInvocation=true`, нет `disable-model-invocation` | `skills/index.ts:310-314`; `skill.ts:136-145` | Skill safety |
| G-11 | Plugin может подставить произвольные env vars процесса в env/headers MCP | `plugins/mcp.ts:214-226,255-258`; `plugins.test.ts:3750-3810` | Secret exposure |
| G-12 | Metadata budget для skills считается в символах, не токенах; 20k chars могут быть ~7k tokens, но модель оценки бюджета не учитывает | `context/sections/skills.ts:53`; `context/utils.ts:12-18` | Estimation |
| G-13 | `skills.includeInstructions` — dead config: нет потребителя | `adapters/src/config/index.ts:165-166,318` | Config drift |
| G-14 | `MEMORY.md` pruning и консолидация — только prompt-инструкции; детерминированного trim/merge нет | `memory/index-content.ts:13-40`; `memory/dream.ts:95-170` | Memory bloat |
| G-15 | MCP prompts/sampling/roots/completion отсутствуют — часть MCP-серверов несовместима | §8.4; `contracts/src/interfaces/mcp.port.ts:429-490` | Compatibility |
| G-16 | Нет версии/целостности MCP server beyond protocol era; serverInfo не сохраняется | `mcp/index.ts:2328-2380`; `mcp.port.ts:8-10` | Version drift |
| G-17 | Микрокомпакция по умолчанию выключена (`enabled === true` требуется), хотя константы и docs намекают на автоматизм | `runtime/methods/microcompact.ts:105-115`; `compact/microcompact.ts:12-18` | Behavior nuance |
| G-18 | `storedMcpResults` — module-global Map, максимум 32 записи; при большом числе сессий ранние страницы исчезают | `core/src/mcp/index.ts:48-53,627-693` | Reliability |
| G-19 | Marketplace sync/install проверяет paths/размеры, но не подпись/провенанс контента; lock фиксирует hash только для sync | `scripts/sync-skills-sh.mjs:1-30`; `skills/marketplace.ts:139-213` | Supply chain |
| G-20 | Docs и код расходятся минимум по четырём пунктам (plugin hooks, skill precedence, hidden AGENTS.md, plugin agents); нет автоматической проверки doc-code consistency | G-01, G-03, G-04, §3.5 CONTRADICTION | Governance |

### 4.1. Context bloat и слабая компакция

**Observed.** Builder не имеет параметра `maxTokens`/`maxChars` для суммы секций: `ContextBuilderConfig` (`context/types.ts:106-149`) его не содержит, а `build()` только суммирует `totalTokens` (`builder.ts:222-235`). Все ограничения локальны: AGENTS.md 100 KB, rules 256 KB, MEMORY.md 25 KB, skills listing 20k chars. Верхняя граница суммы при худшем случае — сотни KB, что при делителе 3 даёт десятки тысяч «оценочных» токенов, не считая tools schema и истории.

**Inferred.** Деградация происходит только через auto compact после того, как provider usage/оценка превысит threshold (`compact/policy.ts:84-88`, `runtime/methods/compact.ts:184-230`). Детерминированного приоритета «что выбросить первым» нет; microcompact чистит только старые tool results и по умолчанию выключен (`runtime/methods/microcompact.ts:109-115`).

### 4.2. Память: что есть и чего нет

**Present.** Между сессиями сохраняется project memory (файлы + MEMORY.md), per-agent memory, а также compaction summary внутри сессии и `ReadSessionContext` для чтения другой сессии по `#sess_*` (`docs/session-context-tool.md:1-40`; timeout 300 s — `core/src/tool/handlers/read-session-context.ts:37,178`).

**Absent.** Отдельной «session memory» (структурированной памяти о текущей сессии, кроме compact summary и persisted message history) нет. Автоматической cross-session консолидации нет (Dream не вызван). Семантический retrieval выключен. Конфликты памяти детерминированно не разрешаются — только инструкции в prompt («update/delete», «resolve contradictions» в Dream) и `originSessionId` для трассировки.

**Privacy.** Project memory лежит вне workspace, в storage root, ключ — hash от identity/path (`project-root.ts:10-23`); remote workspace исключён; memory-агент ограничен contained `.md` и sensitive segment deny-list. При этом содержимое памяти уходит в provider как обычный контекст, и отдельных redaction/шифрования нет (**Inferred** из отсутствия кода).

### 4.3. MCP trust boundary

**Observed.** Для MCP servers из workspace-конфига нет подтверждения: `untrustedProjectMcpServers` пуст, `connectConfiguredServers` вызывается в `startMcpStartup` при инициализации контекста. Для stdio это означает запуск команды из repo-контролируемого `.zcode/config.json` (или `.agents/mcp.json` fallback) в процессе агента с sanitized env. Официальный CUA имеет отдельный authority gate (`core/src/runtime/methods/mcp.ts:22-40`; `bootstrap/src/mcp-config.ts:45-64`), но обычные project servers — нет.

**Observed.** Официальная auth-модель корректно отделяет origin trust от plugin identity (`contracts/src/interfaces/mcp.port.ts:376-397`; `docs/mcp-dual-era-version-negotiation.md`), но это не закрывает trust для произвольного stdio.

## 5. Strengths and differentiators

| ID | Сила | Доказательство |
| --- | --- | --- |
| S-01 | Явная трёхслойная архитектура prompt: stable system / dynamic system / meta_user, с cache markers на границах | `context/builder.ts:243-337`; тесты `context-builder.test.ts:819-920` |
| S-02 | Provider-visible строки зафиксированы тестами (frozen fixtures), что снижает дрейф prompt | `context-builder.test.ts:517-632,920-1180`; `memory-extraction.test.ts:30` |
| S-03 | Rules с path containment, size caps, glob validation, diagnostics и явной untrusted-маркировкой | `adapters/src/context/index.ts:118-325,388-493`; `request-user-context.ts:79-135` |
| S-04 | Многоуровневая компакция: microcompact → auto → manual, provider usage как источник истины, retry на prompt-too-long, rapid-refill breaker, persisted boundary | `compact/policy.ts:6-14`; `runtime/methods/compact.ts:184-330`; `runtime/helpers/compact-selection.ts:59-130` |
| S-05 | File-based memory с прозрачным форматом, origin session, constrained memory-agent и sensitive-path deny-list | `memory/index-content.ts`; `memory-agent-loop.ts:127-169`; `memory-file-path.ts:5-46` |
| S-06 | Skills: merge `.zcode`+`.agents`, plugin namespace, symlink policy для plugin scope, path-identity dedupe, bounded body/description | `skills/roots.ts:107-117`; `skills/scan.ts:30-58`; `skills/index.ts:68-102,237-316` |
| S-07 | Marketplace skills с валидацией snapshot, запретом overwrite hand-written и lock/hash в sync | `skills/marketplace.ts:139-213`; `scripts/sync-skills-sh.mjs:1-30`; `skills-sh.lock.json` |
| S-08 | Plugins: 3 manifest conventions, dependency closure/cycle detection, atomic install с rollback, suppression/recovery, version compare по semver и sha | `plugins/index.ts:105-113,238-276`; `plugins/marketplace.ts:815-874,1303-1340`; `plugins/atomic-directory.ts`; `version-compare.ts` |
| S-09 | Plugin MCP namespacing + host-generated provenance + запрет reserved headers для official auth | `plugins/mcp.ts:22-69,196-293` |
| S-10 | MCP dual-era negotiation, OAuth two-phase с cross-process lease, official-origin trust, connection pool с isolation | `mcp/index.ts:2328-2380`; `mcp/pool.ts:34-80,527-560`; `docs/mcp-oauth-two-phase.md` |
| S-11 | MCP result budgets/paging/artifacts и image normalization защищают provider request | `core/src/mcp/index.ts:48-53,186-210,627-693`; `mcp/image-normalization.ts`; `docs/mcp-tool-output-budget.md` |
| S-12 | CodeIndex turn hint ограничен 800 ms/4 hits/12 KB и не подменяет tool | `runtime-reminders.ts:282-338` |
| S-13 | Прозрачная телеметрия context usage/cache hit rate с разделением main/sidecar | `docs/context-cache-hit-rate.md`; `runtime/methods/context-usage.ts` |

## 6. Candidate recommendations

> Поля обязательны: problem/gap; ZCode evidence file:line; proposed solution; scope/out-of-scope; expected effect; risks; complexity S/M/L; suggested priority P0/P1/P2; acceptance criteria; verification method. Конкурентные утверждения здесь не приводятся.

### R-01. Trust gate и sandbox-решение для plugin hooks

- **Problem/gap:** любой установленный marketplace-плагин может исполнять hooks; docs обещают блокировку third-party; per-plugin trust и sandbox отсутствуют.
- **ZCode evidence:** `apps/zcode-cli/packages/adapters/src/plugins/index.ts:371-376` (`canRunPluginHooks` → `true`); `:186-200` (events попадают в components); `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:178-182,265-287`; `docs/claude-code-marketplace-plugin-compat.md:274-275`.
- **Proposed solution:** вернуть trust-фильтр: official/builtin → runnable; third-party → `runnable:false` до явного пользовательского approval, привязанного к digest bundle (аналогично workspace hook trust review). Показывать hooks в install/review UI. Sandbox — отдельным этапом.
- **Scope:** `adapters/plugins`, `bootstrap` runtime config, `services` settings/trust store, tests. **Out of scope:** OS-level sandbox и пересмотр hook runtime.
- **Expected effect:** установка плагина перестаёт быть достаточным условием для выполнения произвольной команды.
- **Risks:** ломает существующие third-party hooks; нужен миграционный UX; digest должен быть стабильным.
- **Complexity:** M. **Priority:** P0.
- **Acceptance criteria:** untrusted plugin hooks имеют `runnable:false` и не попадают в `HooksRuntimeConfig.events`; explicit trust сохраняется по digest; official/inline trusted работают как раньше.
- **Verification method:** unit в `adapters/tests/plugins.test.ts` и `bootstrap/tests/runtime-config.test.ts`; desktop E2E review flow; ручная проверка, что third-party command не стартует.

### R-02. Подтверждение project-scope MCP

- **Problem/gap:** workspace `.zcode/config.json` MCP автоматически стартует, включая stdio-команды; `untrustedProjectMcpServers` всегда пуст.
- **ZCode evidence:** `bootstrap/src/app/runtime-config.ts:116-121`; `bootstrap/src/zcode-protocol/mcp.ts:75-76`; `core/src/runtime/methods/mcp.ts:42-120`; `adapters/src/config/config-factory.ts:113-136`.
- **Proposed solution:** по умолчанию помечать project-scope servers как untrusted; требовать первого явного connect/approve, привязанного к digest config server entry; показывать command/args/env preview. User-scope оставить auto-connect.
- **Scope:** bootstrap, desktop main/settings, protocol status; tests. **Out of scope:** remote relay, изменение OAuth-модели.
- **Expected effect:** repo не может молча выполнить произвольный MCP binary.
- **Risks:** дополнительный friction; ложные срабатывания при каждом изменении конфига; нужно не сломать `.agents/mcp.json` fallback UX.
- **Complexity:** M. **Priority:** P0.
- **Acceptance criteria:** новый workspace stdio server не спавнится до approval; approval сохраняется по digest; изменение команды инвалидирует approval; user-scope не затронут.
- **Verification method:** unit `bootstrap/tests/mcp-project-config.test.ts` + `core/tests/mcp-runtime.test.ts`; desktop E2E settings connect.

### R-03. Согласовать AGENTS.md discovery с `/init` и документацией

- **Problem/gap:** `/init` утверждает, что `.zcode/AGENTS.md`/`.agents/AGENTS.md` — существующие инструкции; runtime их не читает.
- **ZCode evidence:** `adapters/src/context/index.ts:681-720`; `bootstrap/src/builtin-prompt-command.ts:313-319`; `docs/zcode-init-agents-md-command.md:27`.
- **Proposed solution:** либо читать hidden-пути с явным precedence (например, root `AGENTS.md` > `.zcode/AGENTS.md` > `.agents/AGENTS.md`, с маркировкой источника), либо изменить `/init` и spec, чтобы они не обещали загрузку.
- **Scope:** adapters/context, bootstrap prompt, docs, tests. **Out of scope:** пользовательский `~/.zcode/AGENTS.md` (уже поддержан).
- **Expected effect:** пользовательские инструкции не теряются молча.
- **Risks:** неоднозначный precedence; конфликт с существующими workspace-файлами.
- **Complexity:** S. **Priority:** P1.
- **Acceptance criteria:** выбранная семантика зафиксирована тестом; prompt `/init` и runtime совпадают.
- **Verification method:** `fs-context.test.ts` + `core/tests/context-builder.test.ts`; doc link check.

### R-04. Иерархический merge AGENTS.md

- **Problem/gap:** вложенные AGENTS.md не мержатся; берётся первый найденный.
- **ZCode evidence:** `adapters/src/context/index.ts:688-703`; тесты покрывают только user+workspace (`fs-context.test.ts:1075-1135`).
- **Proposed solution:** собрать все `AGENTS.md` от project root до cwd (или наоборот) с явным порядком, суммарным cap и отдельными блоками `Contents of ...`.
- **Scope:** adapters/context, request-user-context, tests. **Out of scope:** автоматическое слияние семантики.
- **Expected effect:** монорепо-правила подкаталогов становятся применимы.
- **Risks:** рост prompt; конфликтующие правила; нужно определить «ближе = важнее».
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** два уровня AGENTS.md рендерятся в детерминированном порядке; cap соблюдается; тест на конфликт.
- **Verification method:** unit fs-context + context-builder snapshot.

### R-05. Выровнять skill precedence с продукт-доком

- **Problem/gap:** код загружает user skill при same-name, docs обещают workspace-first.
- **ZCode evidence:** `adapters/src/skills/roots.ts:46-55`; `adapters/tests/skills.test.ts:172-199`; `docs/skills-product.md:78-84`.
- **Proposed solution:** выбрать одно правило. Рекомендуется project > user (соответствует продукт-доку и ожиданию «team rules override personal»), с сохранением qualified/bare aliases и явной диагностики при конфликте.
- **Scope:** skills roots/order, tests, docs. **Out of scope:** удаление дублей из listing без решения продукта.
- **Expected effect:** предсказуемая загрузка skill в монорепо.
- **Risks:** меняет текущее поведение и может сломать пользовательские expectations.
- **Complexity:** S. **Priority:** P1.
- **Acceptance criteria:** same-name project/user load возвращает project; тест обновлён; docs синхронизированы.
- **Verification method:** `skills.test.ts` + doc review.

### R-06. Enforcement skill invocation policy

- **Problem/gap:** `safeToAutoLoad` не enforced; `allowImplicitInvocation` всегда true; нет `disable-model-invocation`.
- **ZCode evidence:** `adapters/src/skills/index.ts:310-314`; `core/src/tool/handlers/skill.ts:136-145`; `contracts/src/skills/index.ts:43-59`.
- **Proposed solution:** либо реализовать `disable-model-invocation`/`safeToAutoLoad` в listing и Skill handler (deny с понятной ошибкой), либо удалить поля и заявить, что единственная защита — approval/allowlist.
- **Scope:** skills adapter/contracts, Skill tool, prompt listing. **Out of scope:** полноценный permission broker для каждого skill.
- **Expected effect:** отсутствие ложного чувства безопасности; контроль опасных skills.
- **Risks:** блокировка существующих skills; нужно решить, кто выставляет флаг.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** skill с запретом не auto-invokable и явно отклоняется; обычные skills не затронуты; тесты.
- **Verification method:** unit skill-tool/skill-catalog + prompt snapshot.

### R-07. Общий context budget и детерминированная деградация

- **Problem/gap:** сумма секций не ограничена; локальные caps не предотвращают bloat.
- **ZCode evidence:** `core/src/context/builder.ts:222-235`; caps §3.1; `runtime/methods/compact.ts:184-230`.
- **Proposed solution:** ввести бюджет по категориям (identity/behavior/harness/rules/instructions/memory/skills) и детерминированный порядок: compress → drop optional → keep safety; добавить маркер усечения в prompt и метрику в context usage.
- **Scope:** context builder/types, request-user-context, usage breakdown, tests. **Out of scope:** provider-specific tokenizer.
- **Expected effect:** предсказуемый prompt size; меньше поздних compact-ов.
- **Risks:** потеря важных правил; сложность настройки; нужен snapshot-контроль.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** при превышении бюджета применяется фиксированный порядок; safety/identity никогда не режутся; тест на порядок.
- **Verification method:** unit context-builder + property-style тесты на caps.

### R-08. Указатель на transcript в compact summary

- **Problem/gap:** `transcriptPath` не передаётся; после компакции модель не знает, где искать детали.
- **ZCode evidence:** `core/src/compact/prompt.ts:146-148`; `runtime/methods/compact-active.ts:581-583`.
- **Proposed solution:** передавать persisted transcript path или session id + стратегию `ReadSessionContext`; иначе удалить неиспользуемую опцию.
- **Scope:** compact active/persistence, summary message, tests. **Out of scope:** новая система хранения транскриптов.
- **Expected effect:** восстановимость деталей после lossy compaction.
- **Risks:** утечка пути/контента в prompt; размер; доступность файла.
- **Complexity:** S. **Priority:** P1.
- **Acceptance criteria:** summary содержит корректный pointer при наличии store; при отсутствии — ничего не добавляет.
- **Verification method:** unit compact + snapshot summary.

### R-09. Подключить `ruleTargetPaths` или убрать glob-правила из продукта

- **Problem/gap:** glob-правила `.zcode/rules` не активируются, потому что продукт не передаёт target paths.
- **ZCode evidence:** repo-wide `rg ruleTargetPaths` (только runtime/contracts/tests); `fs-context.test.ts:959-992`.
- **Proposed solution:** определить продюсера: текущий редактируемый/упомянутый файл, изменённые файлы turn, явные UI-теги; передавать их в `ContextSourceRequest.ruleTargetPaths`. Либо убрать обещание glob-правил и оставить только `alwaysApply`.
- **Scope:** core turn/context, adapters, UI/session metadata, tests. **Out of scope:** автоматический анализ всего репозитория.
- **Expected effect:** file-scoped rules начнут работать; меньше prompt bloat от always-on.
- **Risks:** ложные совпадения; сложность определения «затронутых» файлов.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** при упоминании `src/foo.ts` применяется соответствующее glob-правило; без target — только alwaysApply.
- **Verification method:** integration test context source + runtime turn.

### R-10. Решить судьбу semantic recall

- **Problem/gap:** код recall реализован, но выключен; это мёртвая поверхность и неиспользуемые тесты.
- **ZCode evidence:** `memory/project-memory-retrieval-branch.ts:3-14`; `runtime/helpers/project-memory-recall.ts:46-55`; `memory/recall/*`.
- **Proposed solution:** либо включить за флагом с проверкой поддержки JSON Schema model и бюджетом, либо удалить ветку и тесты, оставив index-only.
- **Scope:** memory recall, config flag, tests. **Out of scope:** embedding storage.
- **Expected effect:** меньше кода/рисков; либо лучший retrieval.
- **Risks:** включение добавляет latency/стоимость и privacy-вопросы.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** флаг явно документирован; при выключенном — ноль вызовов selector; при включённом — cap и abort соблюдаются.
- **Verification method:** existing memory-recall tests + runtime integration.

### R-11. Подключить Dream или удалить

- **Problem/gap:** consolidation prompt/lock/handler есть, но продукт их не вызывает.
- **ZCode evidence:** `runtime/helpers/project-memory-dream.ts:54`; `memory/dream.ts:9-12,95-170`.
- **Proposed solution:** запускать после N сессий/по расписанию за флагом, с изоляцией transcript; либо удалить код.
- **Scope:** memory runtime, scheduler, tests. **Out of scope:** UI для ручного запуска (можно отдельно).
- **Expected effect:** память не разрастается и не устаревает.
- **Risks:** фоновая модель-стоимость; конфликты с extraction; приватность.
- **Complexity:** L. **Priority:** P2.
- **Acceptance criteria:** запуск идемпотентен, lock соблюдается, MEMORY.md остаётся в лимитах; тест на «не запускать чаще интервала».
- **Verification method:** unit dream + runtime-memory-dream.

### R-12. MCP prompts: поддержка или явная декларация отсутствия

- **Problem/gap:** часть MCP-серверов публикует prompts; ZCode их не видит.
- **ZCode evidence:** отсутствие методов в `contracts/src/interfaces/mcp.port.ts:429-490`; §8.4.
- **Proposed solution:** добавить `listPrompts/getPrompt` в port и tool/bridge-поверхность либо задокументировать неподдержку в compatibility-матрице.
- **Scope:** contracts/adapter/core/tools/tests. **Out of scope:** sampling/roots.
- **Expected effect:** предсказуемая совместимость.
- **Risks:** расширение поверхности и permissions; prompt injection через server prompts.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** либо MCP prompts работают через явный tool/команду с approval, либо docs и skill `diagnosing-mcp` явно говорят «not supported».
- **Verification method:** adapter contract tests + compatibility doc.

### R-13. MCP server version/health drift

- **Problem/gap:** отслеживается только protocol era; версия сервера и изменения tool schema не сохраняются.
- **ZCode evidence:** `mcp.port.ts:8-10`; `mcp/index.ts:2328-2380`; `runtime/methods/mcp.ts:191-196` (signature только name/tool/description).
- **Proposed solution:** сохранять `serverInfo.name/version` и hash tool schema; предупреждать при drift; включить в status/telemetry.
- **Scope:** adapter descriptor/pool, runtime signature, UI status. **Out of scope:** автоматический rollback.
- **Expected effect:** диагностируемость «сервер обновился и сломал tools».
- **Risks:** ложные предупреждения; приватность.
- **Complexity:** S/M. **Priority:** P2.
- **Acceptance criteria:** status содержит server version; изменение schema видно в логах/событии.
- **Verification method:** unit adapter + telemetry test.

### R-14. Удалить или реализовать `skills.includeInstructions`

- **Problem/gap:** настройка существует, но нигде не потребляется.
- **ZCode evidence:** `contracts/src/config/index.ts:241,340`; `adapters/src/config/index.ts:165-166,318`; grep не находит runtime-потребителя.
- **Proposed solution:** удалить поле или реализовать «не включать body skill в prompt/tool result» с явной семантикой.
- **Scope:** contracts/config schema/adapters/skills. **Out of scope:** изменение формата SKILL.md.
- **Expected effect:** меньше мёртвых настроек.
- **Complexity:** S. **Priority:** P2.
- **Acceptance criteria:** поле либо влияет на поведение и покрыто тестом, либо отсутствует в схеме.
- **Verification method:** config schema tests + skill loading test.

### R-15. Документировать реальный статус plugin agents и ограничить их права

- **Problem/gap:** docs утверждают, что plugin agents не исполняются, но код создаёт из них Agent profiles; при этом docs отдельно предупреждают, что Claude plugin agents обходят tool allowlist/permission broker/изоляцию.
- **ZCode evidence:** `bootstrap/src/app/create-app.ts:259-279`; `bootstrap/src/subagents.ts:113-184,186-234`; `adapters/src/plugins/plugin-components.ts:31`; `docs/claude-code-marketplace-plugin-compat.md:269-270`.
- **Proposed solution:** либо обновить docs и добавить явные ограничения (allowlist tools, запрет опасных полей, отображение plugin agent в UI), либо отключить загрузку plugin agents до появления policy.
- **Scope:** bootstrap subagents, docs, UI metadata. **Out of scope:** полноценный sandbox plugin-agent runtime.
- **Expected effect:** отсутствие ложных ожиданий и снижение риска обхода permission-модели.
- **Risks:** отключение ломает существующие plugin workflows; ограничение tools может урезать функциональность.
- **Complexity:** S/M. **Priority:** P1.
- **Acceptance criteria:** docs совпадают с runtime; plugin agent проходит через тот же tool policy/allowlist; UI показывает источник профиля.
- **Verification method:** bootstrap subagent tests + plugin UI snapshot + manual profile listing.

### R-16. Supply-chain проверка skills

- **Problem/gap:** sync/install валидирует пути/размеры, но не подпись; lock фиксирует hash только для sync-скрипта.
- **ZCode evidence:** `scripts/sync-skills-sh.mjs:1-30,134-172`; `skills/marketplace.ts:174-213`.
- **Proposed solution:** проверять hash snapshot при install, показывать provenance/source и обновлять lock при agent-install; опционально подпись.
- **Scope:** skills marketplace/sync, lock. **Out of scope:** PKI.
- **Expected effect:** воспроизводимость и защита от подмены.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** install отклоняет hash mismatch; provenance виден в listing; lock обновляется.
- **Verification method:** marketplace tests + script dry-run.

## 7. Open questions and unverified

| ID | Вопрос | Почему не решён | Что нужно |
| --- | --- | --- | --- |
| Q-01 | Является ли user > project для skill намеренным решением или багом? | Код и тест противоречат продукт-доку | Решение продукта; обновить либо код, либо `docs/skills-product.md` |
| Q-02 | Где именно должен применяться `untrustedProjectMcpServers`? | Поле есть, но всегда пусто; возможно, desktop main фильтрует раньше | Проверить desktop session create path и `mcp/list` chain |
| Q-03 | Есть ли внешний trust-фильтр plugin hooks в desktop/services? | В `adapters` его нет; bootstrap merge безусловный | Просмотреть desktop plugin install flow и services settings |
| Q-04 | Записывает ли UI `MemorySettingsSection` в `features.memory`? | Прослежен только prop `memoryEnabled` и список | Просмотреть settings service/action wiring |
| Q-05 | Ограничены ли MCP resource reads по размеру? | `readResource` возвращает content без явного resultBudget в port | Проверить `mcp/uiReadResource` и bootstrap resource path |
| Q-06 | Есть ли redaction секретов в memory extraction? | Memory-agent deny-list по путям и secret-like lesson filter есть; общий redaction контента не найден | Проверить extraction executor и provider projection |
| Q-07 | Работает ли plugin `userConfig` sensitive без credential store? | Docs обещают ограничение; adapter только парсит `sensitive` | Просмотреть `plugins/configure` и settings service |
| Q-08 | Поддерживается ли `skills.roots` из user config и как он мержится? | Поле читается (`extraRoots`), но precedence относительно home/project не тестировался отдельно | Добавить тест/проверить config merge |
| Q-09 | Как ведёт себя MCP при `enabled:false` в plugin manifest? | `resolvePluginMcpServers` не проверяет `enabled` явно (только transport/auth) | Проверить adapter connectServer: `config.enabled === false` → disabled (`mcp/index.ts:384-395`) — вероятно, покрыто, но не тестом plugin-пути |
| Q-10 | Влияет ли `presentationSurface` на MCP/context в web/mobile? | Desktop context section включается только при `zcode_desktop` (`builder.ts:132-134`) | Проверить web/mobile surface wiring |
| Q-11 | Сохраняется ли `MEMORY.md` origin/format при конкурентных extraction? | Scheduler single-flight, но межпроцессной блокировки для project memory нет | Проверить write path/atomicity |
| Q-12 | Полностью ли покрыт `ruleTargetPaths` тестами? | Есть только прямые adapter-тесты, нет runtime-теста | Добавить runtime integration |

**Unknown / unverified явно:** реальное поведение desktop UI для plugin hooks/trust, MCP settings connect, memory toggle; фактические E2E-прогоны; сетевое поведение marketplace (не запускалось); точные размеры prompt в токенах для реальных provider-ов (используется оценка, не tokenizer).

## 8. Evidence appendix

### 8.1. Выполненные команды (read-only)

```text
git status --short
git branch --show-current
git log -1 --oneline
CodeIndex status
CodeIndex search "system prompt construction"
CodeIndex search "AGENTS.md discovery rules loading"
rg -n ... (по перечисленным ниже файлам)
nl -ba <file> | sed -n '<range>'
sed -n '<range>' <file>
find apps/zcode-cli/packages -maxdepth 4 -type d | rg -i 'mcp|plugin|skill|context|memory|rule'
wc -l <files>
git blame -L 371,376 apps/zcode-cli/packages/adapters/src/plugins/index.ts
```

Тесты, typecheck, lint, сборки не запускались.

### 8.2. Ключевые файлы и строки

**Context / rules**

- `apps/zcode-cli/packages/core/src/context/builder.ts:36,83-236,243-337,322-337`
- `apps/zcode-cli/packages/core/src/context/types.ts:35-96,100-149`
- `apps/zcode-cli/packages/core/src/context/utils.ts:12-18`
- `apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts:17-198`
- `apps/zcode-cli/packages/core/src/context/sections/skills.ts:9-82`
- `apps/zcode-cli/packages/core/src/context/sections/memory.ts:9-60`
- `apps/zcode-cli/packages/core/src/context/dynamic-sections.ts:26-134`
- `apps/zcode-cli/packages/adapters/src/context/index.ts:26-40,57-98,118-325,388-493,571-720,797-806`
- `apps/zcode-cli/packages/core/src/runtime/methods/context.ts:40-97,123-190,193-260,331-360`
- `apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts:7-46`
- `apps/zcode-cli/packages/core/src/runtime/methods/context-history-entries.ts:7-16`
- `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts:84-105,326-367`
- `apps/zcode-cli/packages/core/src/runtime/helpers/runtime-reminders.ts:282-338`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:655-668,2677-2692`

**Compact**

- `apps/zcode-cli/packages/core/src/compact/policy.ts:6-14,67-88,90-160`
- `apps/zcode-cli/packages/core/src/compact/prompt.ts:1-165`
- `apps/zcode-cli/packages/core/src/compact/manual.ts:6-100,106-166`
- `apps/zcode-cli/packages/core/src/compact/microcompact.ts:12-29,31-...`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts:153-197`
- `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts:184-330`
- `apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts:105-115`
- `apps/zcode-cli/packages/core/src/runtime/helpers/compact-selection.ts:59-130`
- `apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts:581-583`

**Memory**

- `apps/zcode-cli/packages/core/src/memory/project-root.ts:10-23`
- `apps/zcode-cli/packages/core/src/memory/index-content.ts:3-40`
- `apps/zcode-cli/packages/core/src/memory/extraction.ts:6,42-83,85-301`
- `apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts:127-169`
- `apps/zcode-cli/packages/core/src/memory/memory-file-path.ts:5-46`
- `apps/zcode-cli/packages/core/src/memory/origin-session.ts:7-45`
- `apps/zcode-cli/packages/core/src/memory/dream.ts:9-12,95-170`
- `apps/zcode-cli/packages/core/src/memory/recall/index.ts:20-41`
- `apps/zcode-cli/packages/core/src/memory/recall/manifest.ts:12-44`
- `apps/zcode-cli/packages/core/src/memory/recall/selector.ts:15-27,128-141`
- `apps/zcode-cli/packages/core/src/memory/recall/content.ts:5-7,27-99`
- `apps/zcode-cli/packages/core/src/memory/project-memory-retrieval-branch.ts:3-14`
- `apps/zcode-cli/packages/core/src/runtime/helpers/project-memory.ts:4-24`
- `apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-extraction.ts:14,32-44,77-...`
- `apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-recall.ts:46-55`
- `apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-dream.ts:54,71-170`
- `apps/zcode-cli/packages/core/src/subagent/persistent-memory.ts:24-44,76-116,118-199`
- `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:1061-1077`
- `apps/zcode-cli/packages/ui/src/settings/MemorySettingsSection.tsx:47-183`
- `packages/services/src/memory/memoryService.ts:215`

**Skills**

- `apps/zcode-cli/packages/adapters/src/skills/roots.ts:21-138`
- `apps/zcode-cli/packages/adapters/src/skills/scan.ts:1-155`
- `apps/zcode-cli/packages/adapters/src/skills/index.ts:30-44,68-102,129-208,210-235,237-316,318-327,495-497`
- `apps/zcode-cli/packages/adapters/src/skills/marketplace.ts:20-32,47-55,57-172,174-213`
- `apps/zcode-cli/packages/core/src/tool/handlers/skill.ts:17-35,37-91,98-145`
- `apps/zcode-cli/packages/core/src/tool/handlers/skill-marketplace.ts:20-21,136-144,190-198`
- `apps/zcode-cli/packages/contracts/src/skills/index.ts:43-59,135-140`
- `scripts/sync-skills-sh.mjs:1-75,134-172,262-367`
- `skills-sh.lock.json:1-20`
- `apps/zcode-cli/packages/bootstrap/src/skills.ts:97,127`
- `apps/zcode-cli/packages/adapters/tests/skills.test.ts:172-199,433-466`
- `docs/skills-product.md:76-84`

**Plugins**

- `apps/zcode-cli/packages/adapters/src/plugins/index.ts:105-113,120-276,341-376,677-714,898-969,994-996`
- `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts:22-69,196-293`
- `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:815-898,1303-1340`
- `apps/zcode-cli/packages/adapters/src/plugins/atomic-directory.ts:1-40`
- `apps/zcode-cli/packages/adapters/src/plugins/version-compare.ts:1-45`
- `apps/zcode-cli/packages/adapters/src/plugins/plugin-components.ts:31`
- `apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts:1-90`
- `apps/zcode-cli/packages/contracts/src/plugins/index.ts:58-65,144-166`
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:97-122,178-182,265-287`
- `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:436-447`
- `apps/zcode-cli/packages/cli/src/plugins-command.ts:38-52,70-89`
- `docs/claude-code-marketplace-plugin-compat.md:267-283`
- `docs/claude-marketplace-triplet-plugin-compat.md`
- `docs/plugin-mcp-session-runtime-merge.md`

**MCP**

- `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts:8-15,17-130,353-354,376-427,429-490`
- `apps/zcode-cli/packages/adapters/src/mcp/index.ts:106-115,305-449,820-850,1255-1280,1491-1546,1829-1906,1917-1969,2328-2380`
- `apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts:10-45`
- `apps/zcode-cli/packages/adapters/src/mcp/timeout.ts:1-99`
- `apps/zcode-cli/packages/adapters/src/mcp/network.ts:8-43`
- `apps/zcode-cli/packages/adapters/src/mcp/pool.ts:34-80,460-560`
- `apps/zcode-cli/packages/adapters/src/mcp/resource-subscriptions.ts`
- `apps/zcode-cli/packages/core/src/mcp/index.ts:48-53,166-210,259-272,284-355,494-514,627-693`
- `apps/zcode-cli/packages/core/src/mcp/image-normalization.ts:21-23,131-182`
- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts:15-20,42-175,203-230`
- `apps/zcode-cli/packages/core/src/runtime/methods/context.ts:78`
- `apps/zcode-cli/packages/core/src/permission/service.ts:240-246,485-492,565-575`
- `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:45-121,205-217`
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:97-122`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:38-128`
- `apps/zcode-cli/packages/adapters/src/config/schema.ts:48-116,340-384,465-511`
- `apps/zcode-cli/packages/adapters/src/config/config-factory.ts:113-136`
- `packages/desktop/src/main/mcpUserDirectory/index.ts:37-66,334-348`
- `docs/settings-directory-sources.md:26-33`
- `docs/external-agent-mcp-import.md`
- `docs/mcp-dual-era-version-negotiation.md`
- `docs/mcp-oauth-two-phase.md`
- `docs/mcp-tool-output-budget.md`
- `docs/mcp-platform-boundary.md`
- `docs/mcp-config-compat-diagnostics.md`
- `docs/mcp-async-tool-catalog-cache.md:3-6,43-49`

### 8.3. Тесты (выборочно)

- `apps/zcode-cli/packages/core/tests/context-builder.test.ts:79-1767`
- `apps/zcode-cli/packages/adapters/tests/fs-context.test.ts:852-1189`
- `apps/zcode-cli/packages/adapters/tests/skills.test.ts:7-466`
- `apps/zcode-cli/packages/adapters/tests/plugins.test.ts:56-4817`
- `apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts:115-2768`
- `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts` (67 кейсов)
- `apps/zcode-cli/packages/core/tests/compact-policy.test.ts` (14)
- `apps/zcode-cli/packages/core/tests/microcompact.test.ts` (11)
- `apps/zcode-cli/packages/core/tests/memory-recall.test.ts` (19)
- `apps/zcode-cli/packages/core/tests/memory-dream.test.ts` (7)
- `apps/zcode-cli/packages/core/tests/memory-agent-loop.test.ts` (8)
- `apps/zcode-cli/packages/core/tests/runtime-memory-extraction.test.ts` (18)
- `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts` (37)
- `apps/zcode-cli/packages/adapters/tests/mcp.test.ts` (37)
- `apps/zcode-cli/e2e/memory/*`, `apps/zcode-cli/e2e/compact-microcompact/*`
- `packages/desktop/test/e2e/plugins/manual-review/pending/*`

### 8.4. Доказательства отсутствия

**MCP prompts/sampling/roots/completion (Observed absence):**

```text
rg -n "prompts/list|listPrompts|getPrompt|prompts/get|sampling|completion/complete|roots/list" \
  apps/zcode-cli/packages packages --glob '!**/dist/**' --glob '!**/node_modules/**'
# exit 1; MCP-релевантных совпадений нет
```

В `McpPort` (`contracts/src/interfaces/mcp.port.ts:429-490`) присутствуют только tools, resources/templates/subscriptions, status/ping/disconnect/close; prompts/sampling/roots/completion отсутствуют.

**Hidden AGENTS.md (Observed absence в runtime):**

```text
rg -n "\.zcode/AGENTS\.md|\.agents/AGENTS\.md|join\(.*\"\.zcode\", \"AGENTS\.md\"|join\(.*\"\.agents\", \"AGENTS\.md\"" \
  apps/zcode-cli/packages packages --glob '!**/dist/**' --glob '!**/node_modules/**'
# Совпадения только: bootstrap/src/builtin-prompt-command.ts:313,319;
# tests/context-builder.test.ts:941,965; tests/subagent-prompt-assembly.test.ts:63;
# onboarding/migration services (~/.zcode/AGENTS.md)
```

Runtime-adapter (`adapters/src/context/index.ts`) ищет только `AGENTS.md` в каждом каталоге и `~/.zcode/AGENTS.md`; hidden workspace-пути не входят в `priorityFiles`.

**Product producer `ruleTargetPaths` (Observed absence):**

```text
rg -n "ruleTargetPaths" apps packages --glob '!**/dist/**' --glob '!**/node_modules/**' --glob '!**/tests/**'
# apps/zcode-cli/packages/core/src/runtime/types.ts:272
# apps/zcode-cli/packages/core/src/runtime/methods/context.ts:64-66
# apps/zcode-cli/packages/contracts/src/interfaces/context-source.port.ts:29,91
# apps/zcode-cli/packages/adapters/src/context/index.ts:78
```

Ни UI, ни services, ни bootstrap, ни CLI не передают target paths.

**Plugin sandbox (Observed absence):**

```text
rg -n "sandbox" apps/zcode-cli/packages/adapters/src/plugins apps/zcode-cli/packages/adapters/src/mcp
# exit 1
```

Это не доказывает отсутствие sandbox в desktop/main, но в слое расширений его нет.

**MCP tool catalog cache (Observed as planning):**

```text
sed -n '1,8p' docs/mcp-async-tool-catalog-cache.md
# "阶段：规划"
rg -n "toolCatalogCache|catalogCache|MCP_TOOL_CATALOG" apps/zcode-cli/packages --glob '!**/dist/**'
# совпадений нет
```

### 8.5. Сводка противоречий

| # | Документ утверждает | Код/тест показывает | Где |
| --- | --- | --- | --- |
| C-01 | Workspace skills приоритетнее user | User выигрывает same-name load | `docs/skills-product.md:78-84` vs `roots.ts:46-55`, `skills.test.ts:186-189` |
| C-02 | Third-party plugin hooks не инжектятся по умолчанию | `canRunPluginHooks` всегда true, hooks мержатся | `docs/claude-code-marketplace-plugin-compat.md:274-275` vs `plugins/index.ts:371-376`, `runtime-config.ts:265-287` |
| C-03 | `.zcode/AGENTS.md`/`.agents/AGENTS.md` — существующие инструкции | Runtime их не читает | `builtin-prompt-command.ts:313-319` vs `context/index.ts:681-720` |
| C-04 | MCP tool catalog cache — планируемая оптимизация | В коде отсутствует | `docs/mcp-async-tool-catalog-cache.md:3-6` vs grep |
| C-05 | Plugin agents V1 не运行 | Plugin agents парсятся в Agent profiles и попадают в runtime config | `docs/claude-code-marketplace-plugin-compat.md:269-270` vs `bootstrap/src/app/create-app.ts:259-279`, `bootstrap/src/subagents.ts:113-184,186-234` |

---

**Coverage status: partial.**

- Полностью статически покрыты: context assembly/compaction/caching, rules discovery/precedence, project/per-agent memory и recall/extraction/dream wiring, skills format/discovery/loading/marketplace, plugins format/discovery/install/update/hooks, MCP config/transports/lifecycle/auth/permissions/limits/resources, тестовый инвентарь.
- Не проверялось: исполнение тестов, typecheck/lint, desktop/web UI flows, сетевое поведение marketplace, реальные provider-запросы, точные token counts (используется оценка), MCP resource size limits, запись memory toggle из UI, внешний trust-фильтр plugin hooks вне `adapters`/`bootstrap`, поведение web/mobile surface.
- Частично unverified: `userConfig.sensitive` enforcement, concurrent project-memory writes, MCP `enabled:false` в plugin-пути, remote workspace MCP/memory behavior за пределами найденных guard-ов.

Подтверждаю: в рамках этой ветки изменён только файл `docs/research/partials/2026-11-11-zcode-09-context-memory-skills-mcp.md`; продуктовый код, конфиги, lockfile и git-история не менялись.
