# Part C — Context/Memory/Compaction, Rules, Skills, Plugins, MCP, Hooks, Subagents

> Evidence appendix for the ZCode broad competitive research.
> Research-only branch. No product code, config, dependency, or lockfile was modified.
> This file is the only artifact written by this branch.

## 0. Baseline (recorded before analysis)

| Item | Value |
| --- | --- |
| Date (UTC) | `Wed Nov 11 06:08:04 UTC 2026` |
| Branch | `dev` |
| HEAD | `d10f0b69f98677091e0428a92839e4a1e01e04ca` |
| HEAD subject | `Выпустить macOS Preview 3.17.102.` |
| `git status --short` | empty (0 entries) at start |
| Freshness gate | `node scripts/check-workspace-freshness.mjs` → `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）`, exit 0 |
| Code index | `CodeIndex status` → `state: ready`, `partial: false`, generation 1440, 10007 files / 26791 chunks |
| Skill loaded | `codebase-design` (bundled skill) loaded before analysis |

Working root: `<repo-root>`.
CLI monorepo root: `apps/zcode-cli/packages/*`.

## 1. Method and evidence legend

- Facts are cited as `path:line` relative to the repository root, with the CLI packages under `apps/zcode-cli/packages/...`.
- `[observed]` = read directly in source or produced by a command run in this session.
- `[inferred]` = conclusion drawn from observed code but not directly executed.
- `[unknown]` = not verifiable from the checked files.
- Note: in this environment `rg` sometimes masks matched identifiers in its output (it printed `n` for names such as `safeToAutoLoad` and `registerMcpTools`). All exact-identifier claims below were re-verified with `grep -n`, which showed the real names.
- Verification runs executed (narrow, read-only unit tests):
  - `core`: `tests/compact-policy.test.ts` (26) + `tests/microcompact.test.ts` (11) → 37 passed.
  - `core`: `tests/memory-extraction.test.ts` (17) + `tests/memory-recall.test.ts` (19) → 36 passed.
  - `adapters`: `tests/skills.test.ts` (20) + `tests/commands.test.ts` (11) → 31 passed.
  - `core`: `tests/hooks-seven-events.test.ts` (13) + `tests/workspace-hook-trust-domain.test.ts` (6) → 19 passed.
  - `core`: `tests/subagent-profile.test.ts` (93) + `tests/work-ledger.test.ts` (18) → 111 passed.
  - `core`: `tests/context-builder.test.ts` (49) → 49 passed.
  - `adapters`: `tests/mcp.test.ts` (37) + `tests/plugin-mcp-always-load.test.ts` (10) → 47 passed.
  - `core`: `tests/runtime-compact.test.ts` (71) → 71 passed.
  - `adapters`: `tests/plugins.test.ts` (79) → 79 passed.
  - Total: 470 tests passed, 0 failed, across 12 files.
- Not run: full `pnpm test`, `pnpm typecheck`, `pnpm lint`, desktop E2E, live MCP/OAuth against real servers, live plugin marketplace network calls. No dev servers or long background processes were started.

## 2. Coverage matrix

Status scale: `implemented` / `partial` / `weak` / `absent` / `NA`.

### 2.1 Context assembly and instruction injection

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Sectioned system-prompt builder with stable/dynamic cache split | implemented | `apps/zcode-cli/packages/core/src/context/builder.ts:83`, `:243`, `:322` | `core/tests/context-builder.test.ts:112`, `:819`, `:1506` | `docs/specs/zcode-native-harness-capability-map.md` | Three system messages (CLI prefix, stable body, dynamic body) plus meta-user attachments; deterministic ordering by `injectionTarget` then `cacheHint`. |
| Product/agent identity, security notice, harness block, PRISM profile | implemented | `core/src/context/sections/identity.ts:13`, `:25`, `:36`, `:46` | `context-builder.test.ts:1471`, `:1483` | — | Identity is a large vendored PRISM prompt with checksum comments; harness block is shared with workflow-actor identity. |
| Custom system prompt replaces the default body | implemented | `builder.ts:88`, `:109-123`, `:126-131` | `context-builder.test.ts:368` | — | Custom prompt suppresses default system sections (desktop/behavior/guidance/env/output-style/context-management/git); memory and skills/user-context still inject. |
| Workflow-actor (third) identity path | implemented | `builder.ts:93-99`, `:119-120`; `sections/workflow-actor.ts` | `context-builder.test.ts:1592-1760` | `docs/dynamic-workflow/*` | Mutually exclusive with `customSystemPrompt` (throws at `:94-98`). |
| Desktop surface section | implemented | `builder.ts:132-134`; `sections/desktop.ts` | `context-builder.test.ts:210`, `:271` | — | Only for `presentationSurface === "zcode_desktop"`. |
| Dynamic behavior / session guidance / output style / context management | implemented | `builder.ts:138-151`, `:172-175`, `:178`; `context/dynamic-sections.ts:44`, `:85`, `:100`, `:111` | `context-builder.test.ts:79-206`, `:697-817` | — | Session guidance advertises Agent/task_graph only when tools/ports exist (`dynamic-sections.ts:54-67`). |
| Environment info + git snapshot | implemented | `builder.ts:163-169`, `:180-183`; `sections/env-info.ts:33`; `adapters/src/context/index.ts:100-115` | `context-builder.test.ts:633`, `:1302`, `:1390` | — | envInfo includes cwd/platform/shell/os/node plus git branch/status/recent commits. |
| User instructions (user + workspace AGENTS.md) | implemented | `adapters/src/context/index.ts:26`, `:571-606`, `:681-704`, `:706-720` | `adapters/tests/fs-context.test.ts:1075`, `:1135`, `:1162`; `context-builder.test.ts:920`, `:1045` | `AGENTS.md` | Default priority file is `AGENTS.md`; user default is `~/.zcode/AGENTS.md`; workspace search walks cwd→project root. Both are merged into one `ResolvedUserInstructions` with `sources[]`. |
| Workspace rules `.zcode/rules/*.mdc` | implemented | `adapters/src/context/index.ts:28`, `:223-323`, `:388-493` | `fs-context.test.ts:883`, `:959`, `:993`, `:1041` | — | YAML frontmatter `description`/`alwaysApply`/`globs`; `alwaysApply` first, then glob-matched via explicit `ruleTargetPaths`. Hard limits: 64 KiB/file, 256 KiB total, 32 globs, 64 expansions. Path-escape and symlink escapes are rejected with diagnostics. |
| Bundled harness rules | implemented | `adapters/src/context/index.ts:33-40`, `:118-222`; `bundled-skills/rules/00-evidence.mdc`…`06-progress.mdc` | `fs-context.test.ts:917` | `docs/specs/zcode-native-harness-capability-map.md` | 7 packaged always-on rules; must be `alwaysApply: true`, no globs, non-empty body (`adapters/src/context/index.ts:198-206`). |
| Project memory index injection (`MEMORY.md`) | implemented | `builder.ts:200-210`; `sections/request-user-context.ts:137-150`; `memory/index-content.ts:3-38` | `context-builder.test.ts:517`, `:556`, `:593` | `docs/superpowers/plans/2026-07-14-memory-active-path.md:12-30` | Only on `default-index` branch; leading frontmatter and top-level HTML comments stripped; 200-line / 25 000-char cap with warning. |
| "Untrusted guidance" framing for agentsMd/rules | implemented | `sections/request-user-context.ts:79-86`, `:105`, `:132` | `context-builder.test.ts:1078` | `AGENTS.md` | Workspace content is explicitly declared unable to change permissions/trust boundaries. |
| Skills listing in meta-user reminder | implemented | `builder.ts:190-198`; `sections/skills.ts:17-61` | `context-builder.test.ts:1210`, `:1532`, `:1558` | — | 20 000-char budget (`sections/skills.ts:9`); falls back to names-only lines when over budget (`:57-60`). |
| Attachments and per-turn reminders | implemented | `core/src/system-reminder/source.ts:20-59`; `system-reminder/prompt-attachment.ts:22-58` | `core/tests/system-reminder-source.test.ts` | — | Attachments are user-provided context, not instructions (`prompt-attachment.ts:54-57`). |
| Subagent prompt assembly | implemented | `core/src/subagent/context-builder.ts:32-104`, `:113-172` | `core/tests/subagent-prompt-assembly.test.ts` | — | Separate builder: CLI prefix + agent prompt + common notes + environment + user context/rules + date + skills. No memory, no context-management section. |
| Agent/subagent catalog in prompt | partial | `core/src/subagent/listing.ts:14-60`; `context-builder.test.ts:1269` | `core/tests/agent-listing.test.ts` | `docs/subagent-listing-attachment.md` | Deliberately NOT mirrored into the static context builder; injected later as `agent_listing_delta` reminders. |
| `projectContext` / `agentProfiles` / `embeddedSearchEnabled` / `language` builder inputs | weak | `core/src/context/types.ts:118`, `:122`, `:123`, `:132`; no reads in `builder.ts` (verified by grep) | `context-builder.test.ts:1012` | — | Typed config fields are accepted and forwarded (`runtime/methods/context.ts:174-186`) but never rendered. `language` is only stored (`runtime/methods/config.ts:61-62`). Dead/aspirational inputs. |
| Compact guidance in context | weak | `context/types.ts:134`; no read in `builder.ts`; assertions at `context-builder.test.ts:783-817` | `context-builder.test.ts:783` | — | Tests assert absence of `# Function Result Clearing`, a string that no longer exists in `src` (grep found it only in tests). Those two tests are vacuous. |

### 2.2 Memory runtime

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Project memory root per workspace identity | implemented | `core/src/memory/project-root.ts:10-24`; `runtime/helpers/project-memory.ts:4-26` | `core/tests/memory-recall.test.ts` (manifest root cases) | — | `~/.zcode/cli/.../memories/projects/<slug>-<sha16>/memory`; identity beats path; Windows path lowercased. |
| Memory root enable gate | implemented | `runtime/helpers/project-memory.ts:8-11`; `runtime/methods/context.ts:193-212` | — | — | Requires `memory.enabled`, `use !== false`, `cliStorageRoot`, and a main-like `taskType` (`project-memory.ts:19-26`). Remote workspaces and non-main task types excluded. |
| Memory file format guidance | implemented | `context/sections/memory.ts:33-60` | `context-builder.test.ts:517` | — | One fact per file, frontmatter `name/description/metadata.type` (user/feedback/project/reference), `[[links]]`, anti-duplication and "don't save what the repo records" rules. |
| `MEMORY.md` pointer discipline | implemented | `context/sections/memory.ts:52-57`; `memory/index-content.ts:8-38` | `context-builder.test.ts:556`, `:593` | `docs/superpowers/plans/2026-07-14-memory-active-path.md:12-30` | Index is loaded each session; content must not be duplicated there. |
| Index truncation and comment stripping | implemented | `memory/index-content.ts:3-4`, `:20-37`, `:49-66` | `context-builder.test.ts:593` | — | 200 lines / 25 000 chars; only top-level markdown HTML comment tokens removed, code/list comments preserved. |
| Automatic extraction after successful turns | implemented | `memory/extraction.ts:42-179`; `runtime/helpers/project-memory-extraction.ts:32-81`; `runtime/methods/turn.ts:1061-1066` | `core/tests/memory-extraction.test.ts:63-313` | — | Gated by `extractionEnabled !== false`, non-remote, store+FS present, boundary message present; scheduler keeps one running + latest pending (coalescing), advances cursor only on success/no-op (`extraction.ts:118-120`). |
| Extraction eligibility | implemented | `memory/extraction.ts:6`, `:68-83`, `:228-297` | `memory-extraction.test.ts:64`, `:83` | — | Skips if a contained memory `Write`/`Edit` already happened after the cursor, or if no non-meta user text with ≥3 words exists. |
| Extraction tool sandbox | implemented | `memory/memory-agent-loop.ts:41`, `:127-169`, `:171-217`, `:279-297`; `runtime/helpers/project-memory-agent.ts:104-133` | `core/tests/memory-agent-loop.test.ts` | — | Only Read/Grep/Glob, read-only Bash, contained `rm *.md`, and contained `Write`/`Edit` on `.md`; `Agent`, `mcp__*`, network tools denied; `EnterPlanMode`/`ExitPlanMode` not reachable. |
| Memory write permission fast-path | implemented | `tool/executor/memory-file-permission.ts:19-46`, `:55-66`, `:74-86` | (covered indirectly by tool/permission suites) | — | Markdown writes inside the memory root auto-allowed, but an existing deny (except plan-mode non-read-only) or `alwaysAsk` is preserved. |
| Sensitive-path exclusions for memory writes | implemented | `memory/memory-file-path.ts:5-26`, `:44-56`, `:63-67`, `:79-84` | — | — | Rejects memory targets under `.git`, `hooks`, `.husky`, `.githooks`, `node_modules`, `.vscode`, `.idea`, `.claude`, `.zcode`, `skills`, `commands`, `agents`, etc., including zero-width/Bidi-normalized names. |
| Origin-session stamping | implemented | `memory/origin-session.ts:8-51`; `tool/handlers/write.ts:118`; `tool/handlers/edit.ts:501` | `core/tests/memory-origin-session.test.ts` | — | Adds `metadata.originSessionId` and `node_type: memory` only when absent; malformed frontmatter is left untouched. |
| Atomic persistence | implemented | `adapters/src/fs/index.ts:307-308`, `:700-745` | `adapters/tests/fs-context.test.ts:62` | — | Default `atomic: true`: temp file + `fsync` + `rename`, refuses symlink targets, preserves existing mode. |
| Redaction before memory write | absent | no `redact`/`sanitize` in `core/src/memory/*` (grep); only hook display redaction exists (`hooks/display-metadata.ts:35`) | — | — | Memory content is model-authored and persisted verbatim. Only path sensitivity is enforced. Prompt guidance never tells the model not to store secrets. |
| `remember`/`forget` as first-class tools | absent (prompt-level only) | `memory/extraction.ts:62`; `subagent/persistent-memory-prompt.ts:13` | — | — | No `Remember`/`Forget` tool exists (grep over `core/src/tool/handlers`). Behavior is instructed: "if asked to remember, save immediately; if asked to forget, remove the entry". |
| Semantic recall (selector) | implemented but disabled | `memory/recall/selector.ts:15-126`; `memory/project-memory-retrieval-branch.ts:4-14` | `memory-recall.test.ts:174-414` | `docs/superpowers/plans/2026-07-14-memory-active-path.md:14-30` | Full selector pipeline exists (JSON-schema output, sticky conversation, abort-safe, ≤5 results), but `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false`; production uses `default-index`. |
| Recall prefetch/consume | implemented but inactive | `runtime/helpers/project-memory-recall.ts:46-138` | `memory-recall.test.ts:415-560` | — | Prefetch starts only on `semantic-recall`, requires `supportsJsonSchemaOutput` (`:55`), and is consumed only after a completed real tool batch (`turn-loop.ts:144-151`). |
| Recall staleness warning | implemented (inactive path) | `memory/recall/content.ts:95-99` | `memory-recall.test.ts:509` | — | Memories older than 1 day get "point-in-time observation, verify against current code". |
| Recall read-state synchronization | implemented (inactive path) | `runtime/helpers/project-memory-recall.ts:116-130`; `:155-178` | `memory-recall.test.ts` (read-state cases) | — | Injected memory bodies update `readFileState` so later Edit/Write freshness checks behave like a real Read; invalidation on Dream changes. |
| Dream / consolidation | partial | `memory/dream.ts:9-93`, `:95+`; `runtime/helpers/project-memory-dream.ts:28-71` | `core/tests/memory-dream.test.ts:25-115` | — | Prompt, 24h gate, 10-min scan throttle, PID+readback lock, touched-path capture all exist, but the product path never schedules it: "当前产品链路不自动触发 Dream" (`project-memory-dream.ts:54`). |
| Evidence-gated lessons (knowledge-curator memory) | implemented | `subagent/persistent-memory.ts:202-250`; `runtime/methods/turn.ts:1068-1076` | — | — | Writes `lessons/<file>` under the `knowledge-curator` project memory root when the same tool fails then succeeds in one turn; dedupes by index marker and caps at 200 index lines (`:121`, `:236-238`). |
| Per-profile persistent memory | implemented | `subagent/persistent-memory.ts:24-38`, `:46-69`, `:76+`; `subagent/persistent-memory-prompt.ts:6-13` | — | `docs/specs/zcode-agent-profile-lifecycle.md:9-13` | Scopes `user` (`<storage>/agent-memory/<agent>`), `project` (`.zcode/agent-memory/<agent>`), `local` (`.zcode/agent-memory-local/<agent>`). Memory-enabled profiles get `Write`/`Edit` added (`:46-54`). |
| Topic archive / topic resource recall | implemented | `session-context/topic-archive.ts:26-105`; `session-context/topic-resource.ts:36-150` | — | — | Bounded original-archive search (≤12 000 tokens, ≥256 minimum, cursor, gap/truncation flags) restricted to current session and trusted input metadata. |

### 2.3 Compaction runtime

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Manual `/compact` (+ custom instructions) | implemented | `runtime/helpers/commands.ts:5-15`; `runtime/methods/turn.ts:190`, `:457-473`; `runtime/methods/compact.ts:45-182` | `runtime-compact.test.ts:563-2778` | `docs/testing/conversation-session-compact-decision-worksheet.md:8-28` | `inputVisibility: "model-only"` so the command is not a user bubble (`compact.ts:75-78`); supports `/compact <instructions>`. |
| Auto compaction before/inside a model step | implemented | `runtime/methods/compact.ts:184-315`; `turn-loop.ts:153-190` | `runtime-compact.test.ts:414`, `:5187` | — | Decision from provider usage when available, else local estimate (`compact.ts:317-344`); threshold = effective window − 13 000 buffer (`compact/policy.ts:84-88`). |
| Reactive compaction after provider overflow | implemented | `runtime/methods/compact.ts:356-468`; `turn-model-step.ts:831-883` | `runtime-compact.test.ts:5285`, `:5393`; `runtime-compact-telemetry.test.ts:10` | — | Triggered by `isModelContextExceededError` (`runtime/helpers/model-errors.ts:223`), once per model step (`turn-model-step.ts:838-862`). |
| Microcompaction (tool-result clearing) | implemented but default-off | `compact/microcompact.ts:83-174`; `runtime/methods/microcompact.ts:24-115` | `core/tests/microcompact.test.ts:11-430` | — | `enabled: config.microcompact?.enabled === true` (`microcompact.ts:111`) → opt-in. Clears old compactable tool results, keeps latest 5 groups, never clears media or error results by default, requires ≥256 tokens saved. |
| Microcompact triggers | implemented | `compact/microcompact.ts:176-200` | `microcompact.test.ts:66`, `:108` | — | Time-based (idle > 60 min) or token pressure (≥ threshold, default 90% of auto threshold / threshold−2000). |
| Summary prompt and no-tools contract | implemented | `compact/prompt.ts:1-117` | `runtime-compact.test.ts:361`, `:2456` | — | Explicit text-only preamble/trailer; summary format `<analysis>`+`<summary>`; tool calls rejected. |
| Summary continuation message | implemented | `compact/prompt.ts:133-165` | `runtime-compact.test.ts:384` | — | Optional transcript path, preserved-recent notice, REPL-cleared notice, "resume without asking". |
| Prompt-too-long retry ladder | implemented | `compact/manual.ts:56-60`; `compact-active.ts:212`, `:480-500`; `runtime/helpers/compact-selection.ts:59`, `:103` | `runtime-compact.test.ts:2591`, `:2694`, `:2778` | — | Auto gets up to N attempts; retries by dropping older rounds, then by truncating; media-size errors retried with stripped media (`compact-active.ts:129-141`). |
| Preserved recent rounds + preserved segment | implemented | `runtime/helpers/compact-selection.ts:25-56`; `compact-active.ts:598-631`; `agent/compact-session.ts:4-83` | `compact-preserved-inputs.test.ts:45`; `runtime-compact.test.ts:414`, `:452` | — | Auto/reactive preserve one recent assistant-started group (`compact-selection.ts:36`); boundary records `preservedSegment` (head/tail/anchor) and cold resume re-inserts it. |
| Post-compact reminders | implemented | `compact-active.ts:216-224`, `:598`; `runtime/helpers/compact-post-reminders.ts` | `runtime-compact.test.ts:1680`, `:1802`, `:1898` | `docs/plan-mode-plan-file-compact-continuity.md` | Rebuilds agent listing, plan-file reference, read-state reminders, tool-search announcement after compaction. |
| Compact timeline persistence | implemented | `runtime/methods/compact-persistence.ts:35-153`, `:159-197`, `:199-286`, `:288+` | `runtime-compact.test.ts:2005`, `:2126`, `:2250`, `:2384` | `docs/chat/synthetic-timeline-dividers.md`; `docs/conversation-product-protocol.md:241-436` | Timeline part with `started/retrying/skipped/completed/failed/interrupted`; interrupted timelines are reconciled on resume (`:199-278`). |
| Atomic ordering of compaction | implemented | `compact-active.ts:294-306` ("discovery checkpoint saved atomically with summary; runtime history replaced only after persistence") | `runtime-compact.test.ts:1450` | — | Persist summary → append boundary event → replace runtime history. |
| Circuit breaker on repeated auto-compact failures | implemented | `compact/policy.ts:136-144`; `runtime/methods/compact.ts:286`, `:301`, `:443`, `:456` | `compact-policy.test.ts` (indirect) | — | `maxConsecutiveFailures` default 3; counter reset on success. |
| Rapid-refill breaker | implemented | `turn-loop-state.ts:27-28`, `:212-236`; `turn-loop.ts:163-190`; `turn-model-step.ts:842-883`; `runtime/helpers/model-errors.ts:46-60` | `runtime-compact.test.ts:5187`, `:5285`, `:5393` | — | If context refills in <3 tool turns after compaction 3 times consecutively, block with `compact_rapid_refill_breaker` and an actionable message. |
| Provider-usage token truth | implemented | `compact.ts:317-344`; `compact-policy.ts:28-39`, `:90-155` | `compact-policy.test.ts:211`; `runtime-compact.test.ts:169-338` | — | Prefers latest committed assistant `contextUsageTokens` + local increment; falls back to local estimate that includes reasoning and tool-call inputs (`compact/manual.ts:106-142`). |
| Partial / SessionMemory triggers | absent (types only) | `contracts/src/compact/index.ts:9-15`; `runtime/helpers/compact.ts:44-62` | — | — | No producer sets `CompactTrigger.Partial` or `SessionMemory` (grep found only the mapping switch and contract arrays). |
| Compact policy `summaryReserveTokens` / `thresholdPercentOverride` | weak | `compact/policy.ts:21`, `:23` | `compact-policy.test.ts:200-210` | — | Fields are declared but never read by policy logic; tests assert `thresholdPercentOverride` no longer changes the algorithm. |
| `features.compact` config flag | weak | `contracts/src/config/index.ts:34`, `:317`; `adapters/src/config/index.ts:120-121`, `:290` | `adapters/tests/config.test.ts` | — | The config flag is stored but never wired into `AgentRuntimeConfig`; runtime compact enablement is `config.compact?.enabled` (`runtime/methods/microcompact.ts:36`, `compact.ts:366`) which bootstrap does not set. `[inferred]` Effective behavior: compaction always on unless an embedder passes `compact.enabled`. |

### 2.4 History and session state

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Runtime message history as single in-memory owner | implemented | `core/src/agent/message-history.ts:108-145`, `:163-260` | `core/tests/message-history.test.ts` | — | `init`, `addEntries`, `borrowReadOnlyRuntimeEntries`, `replaceMessages`; read-only borrow for hot paths, defensive copies elsewhere. |
| Context prefix separated from conversation | implemented | `runtime/methods/context-history-entries.ts:7-16`; `runtime/helpers/compact.ts:72-88`; `runtime/methods/context-refresh.ts:29-49` | `runtime-compact.test.ts:1143` | — | Prefix is metadata-marked, not text-matched; literal `<system-reminder>` user text is not preserved as prefix. |
| Cold resume hydration | implemented | `core/src/agent/session-history-hydrator.ts:58`, `:251`, `:316`, `:409-459` | `bootstrap/tests/session-persistence.test.ts` | — | Rebuilds user/assistant/tool entries and restorable reminders; provider-wrapped reminder text is recognized. |
| Resume honors compact boundary | implemented | `runtime/methods/compact-persistence.ts:199-278`; `agent/compact-session.ts:60-83` | `runtime-compact.test.ts:1450`, `:2005`, `:2250`, `:2384` | — | Stale pre-compact history is not rehydrated; interrupted timelines converge to interrupted/completed. |
| Rewind/fork branch selection | implemented | `runtime/methods/project-memory-extraction.ts:57-62` (uses `selectActiveConversationBranch`) | `core/tests/input-intent-persistence.test.ts` | `docs/chat/conversation-transcript-storage.md` | Extraction snapshots only the active branch; branch cut/rewind metadata is honored. |
| Session event journal / projection | implemented | `bootstrap/src/zcode-protocol-v4/projection-rows.ts:166-190`; `docs/conversation-product-protocol.md:241-436` | `packages/shared/test/zcodeProtocolV4*.test.ts` | `docs/conversation-product-protocol.md` | Compact is `activeWork.kind=compact`; `/compact` is rejected while busy, queued per decision worksheet. |
| Memory recall read-state reset on compact | implemented | `runtime/helpers/compact.ts` (`buildPostCompactRuntimeEntries` only keeps prefix+summary+preserved+reminders) | `runtime-compact.test.ts:1680` | — | Pre-compact `readFileState` is not silently reused; reminders re-establish what the model may still trust. |

### 2.5 Skills

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Skill discovery roots | implemented | `adapters/src/skills/roots.ts:21-72`, `:107-117` | `adapters/tests/skills.test.ts:8`, `:200`, `:250`, `:433`, `:584` | `docs/skills-product.md:17-23` | Merges `.zcode/skills` + `.agents/skills` for user and each project dir up to worktree root; `.zcode` wins same-name load; additional dirs get `namespace/name`. `.cursor` is not scanned (`skills.test.ts:268`, `:293`). |
| Frontmatter parsing and validation | implemented | `adapters/src/skills/index.ts:30-44`, `:237-316` | `skills.test.ts:8`, `:382` | — | `name`/`description` required when frontmatter exists; folder name allowed when absent; description ≤1024; unknown keys tolerated but reduce `safeToAutoLoad`; multiline descriptions supported. |
| Skill identity and dedupe | implemented | `adapters/src/skills/index.ts:89-93`, `:495-497` | `skills.test.ts:172`, `:221` | — | Identity is path, not name; same-name skills from different roots both listed; load resolves `name` or `qualifiedName` by first root priority. |
| Plugin-qualified skill aliases | implemented | `adapters/src/skills/index.ts:329-352`; `adapters/src/plugins/index.ts:40-44` | `skills.test.ts:321` | `docs/plugin-mcp-skill-case-catalog.md:7-14` | `pluginName:skillName` alias resolved from nearest plugin manifest; bare name still loadable. |
| Disabled-skill config | implemented | `adapters/src/skills/index.ts:47-49`, `:318-327`; `bootstrap/src/app/create-app.ts:902-909` | `skills.test.ts:37`, `:123` | `docs/settings-skill-list.md:12` | Disabled paths are filtered at discovery so discover/load/inspect agree; compares both scan path and realpath. |
| Skill tool loading and budgets | implemented | `core/src/tool/handlers/skill.ts:18-35`, `:37-91` | `core/tests/skill-tool.test.ts` | — | 100 KiB default, 200 KiB for `dynamic-workflows`; `<skill_content>` wrapper; `${CLAUDE_SKILL_DIR}`/`${ZCODE_SKILL_DIR}` expanded to base dir; truncation marker. |
| Skill policy enforcement (`safeToAutoLoad`, `allowImplicitInvocation`) | weak | `adapters/src/skills/index.ts:310`, `:313`; consumers: only CLI display (`cli/src/skills-command.ts:160`, `:228`) | `skill-tool.test.ts`, `context-builder.test.ts` (fixtures only) | — | Both fields are computed and always `allowImplicitInvocation: true`; no runtime gate reads them. |
| Skill-required gate for workflow authoring | implemented | `core/src/tool/handlers/workflow-skill-gate.ts:25-53`; `agent/loaded-skills.ts:20-46`; `runtime/helpers/runtime-tools.ts:223` | `core/tests/loaded-skills.test.ts`; `core/tests/workflow-skill-gate.test.ts` | `docs/dynamic-workflow/authoring.md` | Create/Amend/Save/Eval require a successful `Skill(dynamic-workflows)` call still visible in history; compaction re-closes the gate. |
| Marketplace search/install | implemented | `adapters/src/skills/index.ts:104-171`; `core/src/tool/handlers/skill-marketplace.ts:111`, `:165-217` | `adapters/tests/skill-marketplace.test.ts:27-142`; `core/tests/skill-marketplace-tool.test.ts` | `docs/specs/skill-marketplace.md:9-53` | Public `skills.sh` endpoints only; snapshot validated (relative paths, ≤500 files, ≤10 MiB total, ≤5 MiB/file, root `SKILL.md`); hand-written skills never overwritten; install scope workspace/user. |
| Repo-level skill sync | implemented | `scripts/sync-skills-sh.mjs:1-30`; `skills-sh.lock.json` (19 entries) | — | `docs/specs/skill-marketplace.md:55-60` | `pnpm skills:sync` downloads pinned skills into `.agents/skills` and updates the lock. |
| Skill `args` support | weak | `contracts/src/tools/skill.ts:9-14`; handler parses but destructures only `{ skill }` (`core/src/tool/handlers/skill.ts:38`) | `skill-tool.test.ts` | — | `args` is advertised in the tool description but never interpolated into the skill body. |
| `skills.includeInstructions` config | weak | `contracts/src/config/index.ts:241`, `:340`; `adapters/src/config/index.ts:165-166`, `:318` | `adapters/tests/config.test.ts:520-538` | — | Stored and round-tripped but no runtime consumer (grep over `bootstrap/src`, `core/src`, `cli/src`). |

### 2.6 Plugins

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Plugin candidate sources | implemented | `adapters/src/plugins/index.ts:238-277` | `adapters/tests/plugins.test.ts` | `docs/plugin-hooks-compat.md:9-17` | inline config dirs, official roots, official cache scan, installed marketplace records. |
| Manifest discovery order | implemented | `adapters/src/plugins/index.ts:105-107`; `adapters/src/skills/index.ts:40-44` | `plugins.test.ts:741`, `:878` | `docs/plugin-hooks-compat.md:9-17` | `.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json`. |
| Enable/disable and suppressed builtins | implemented | `adapters/src/plugins/index.ts:159-180`, `:994` | `plugins.test.ts:418`, `:461`, `:526` | — | `suppressedBuiltins` removes official plugins even with stale cache; inline plugins with same name are unaffected. |
| Component resolution (skills, commands, hooks, MCP) | implemented | `adapters/src/plugins/index.ts:193-225`, `:341-369`, `:392-465`, `:467-607`; `adapters/src/plugins/plugin-components.ts:31-105` | `plugins.test.ts:741`, `:878`, `:1109`, `:1232` | — | Enabled plugins contribute skill roots, command roots (materialized into `data/<plugin>/generated-commands`), hooks and MCP servers; disabled plugins still expose declared names for UI. |
| Plugin skill root containment | implemented | `adapters/src/plugins/index.ts:405-450`; `adapters/src/skills/index.ts:217-221` | `plugins.test.ts` | — | `resolveInside` prevents path escape; plugin skill roots do not follow symlinks. |
| Unsupported manifest components | implemented | `adapters/src/plugins/index.ts:112`, `:378-390` | `plugins.test.ts` | — | `channels`, `lspServers`, `outputStyles`, `settings` are diagnostic-only. |
| Marketplace source kinds | implemented | `adapters/src/plugins/marketplace.ts:84-93`; `contracts/src/plugins/index.ts:70-76` | `plugins.test.ts:1272`, `:1365` | `docs/plugin-github-archive-source.md`, `docs/plugin-cdn-zip-source.md` | url, github, git, npm, file, directory, hostPattern, pathPattern, settings. |
| Marketplace add/update/remove | implemented | `adapters/src/plugins/marketplace.ts:410`, `:716`, `:767` | `plugins.test.ts:110`, `:194`, `:386` | `docs/claude-code-marketplace-plugin-compat.md` | Proxy-aware git env; redirect handling; icon enrichment; failure records. |
| Dependency closure install | implemented | `adapters/src/plugins/marketplace.ts:815-874`, `:1303-1380` | `plugins.test.ts` (dependency cases) | `docs/plugin-management-lifecycle-case-catalog.md` | Resolves closure, allows cross-marketplace only when declared, rolls back staged directories on failure. |
| Atomic install/uninstall | implemented | `adapters/src/plugins/marketplace.ts:840-873`, `:876-898`; `adapters/src/plugins/atomic-directory.ts:7-60` | `bootstrap/tests/plugin-storage-lock.test.ts`; `plugins.test.ts` | `docs/plugin-management-lifecycle-case-catalog.md` | Stage → activate → finalize with rollback; uninstall can keep `data/<plugin-id>`. |
| Plugin options / user config | implemented | `contracts/src/plugins/index.ts:58-68`, `:164`; `adapters/src/plugins/index.ts:202` | `plugins.test.ts` | `docs/plugin-capabilities-settings.md` | `userConfig` options feed `${VAR}` expansion in MCP/hook commands (`adapters/src/plugins/mcp.ts:19`, `:142`). |
| Plugin UI surfaces | implemented | `contracts/src/plugins/index.ts:168-183`; `adapters/src/plugins/ui-surfaces.ts` | `bootstrap/tests/v4-plugin-ui-background.test.ts` | `docs/plugin-ui-background-execution.md` | `ui.surfaces[]` must be session-scoped and `ui://`; served through namespaced MCP server. |
| Plugin hooks trust boundary | weak | `adapters/src/plugins/index.ts:371-376` | `core/tests/hooks-seven-events.test.ts` | `docs/plugin-hooks-compat.md:23-30` | `canRunPluginHooks` returns `true` unconditionally; enabling any third-party plugin grants shell-hook execution with inherited env. Explicitly acknowledged as a deferred trust boundary. |
| Plugin reference reminder | implemented | `core/src/plugin-reference/reminder.ts:8-50`; `core/src/plugin-reference/catalog.ts:10-40`; `runtime/methods/plugin-reference.ts:85+` | `core/tests/plugin-reference.test.ts`, `plugin-reference-runtime.test.ts` | `docs/plugin-reference-mention.md` | Identifier-only, bounded (32 skills / 16 MCP / 16 subagents / 8 KiB), fail-closed, no I/O in builder. |
| Plugin CLI surface | implemented | `cli/src/plugins-command.ts:44-56`, `:70-86`; `cli/src/plugins-marketplace-command.ts` | `cli/tests/plugins-command.test.ts` | `docs/cli-plugins-command-parity.md` | `list/install/uninstall/enable/disable/update/validate/marketplace add|list|remove|update`. |

### 2.7 MCP

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Transports | implemented | `contracts/src/interfaces/mcp.port.ts:8`, `:76-104`; `adapters/src/mcp/index.ts:1919-1968` | `adapters/tests/mcp.test.ts`; `mcp-stdio-transport.test.ts` | `docs/mcp-platform-boundary.md` | stdio (process-tree transport), Streamable HTTP, SSE. |
| Server config model | implemented | `contracts/src/interfaces/mcp.port.ts:17-25`, `:76-104` | `adapters/tests/mcp-config-protocol-version.test.ts` | `docs/mcp-config-compat-diagnostics.md:5-35` | `alwaysLoad`, `enabled`, `isolation`, `protocolVersion`, `timeoutMs`; legacy `environment→env`, `remote→http` normalized at config entry. |
| Config precedence | implemented | `adapters/src/config/config-factory.ts:372-398` | `adapters/tests/config.test.ts`; `bootstrap/tests/mcp-project-config.test.ts` | — | system → project → user → env → cli; MCP-specific rule: user shadows project. |
| Plugin MCP merge | implemented | `bootstrap/src/app/runtime-config.ts:99-110`; `docs/plugin-mcp-session-runtime-merge.md:13-19` | `bootstrap/tests/mcp-protocol.test.ts` | `docs/plugin-mcp-session-runtime-merge.md` | Plugin servers injected first, then explicit user servers override by name. |
| Plugin MCP namespacing | implemented | `adapters/src/plugins/mcp.ts:67-69`; `adapters/src/mcp/descriptor.ts:30` | `adapters/tests/plugin-mcp-always-load.test.ts`; `tool-search-mcp.test.ts` | `docs/plugin-mcp-skill-case-catalog.md:7-14` | `plugin:<plugin>:<server>` → `mcp__plugin_<plugin>_<server>__<tool>`. |
| OAuth (authorization_code, client_credentials) | implemented | `contracts/src/interfaces/mcp.port.ts:27-44`; `adapters/src/mcp/oauth.ts`, `oauth-interactive.ts`, `oauth-refresh.ts`, `oauth-lease.ts`, `oauth-credentials.ts` | `adapters/tests/mcp-oauth*.test.ts` (7 files, incl. 2 e2e) | `docs/mcp-oauth-client-auth.md`, `docs/mcp-oauth-two-phase.md` | Interactive browser flow, refresh, cross-process lease, credential storage. Session startup waits only 15 s (`core/src/runtime/methods/mcp.ts:12`, `:76`). |
| Official ZCode auth (`zcode_official`) | implemented | `contracts/src/interfaces/mcp.port.ts:46-74`; `adapters/src/plugins/mcp.ts:199-296`; `adapters/src/mcp/official-auth.ts` | `mcp-official-auth.test.ts`, `mcp-official-auth-integration.test.ts`, `mcp-official-auth-stdio-meta.test.ts`; `bootstrap/tests/official-mcp-auth-port.test.ts` | — | HTTP injects identity headers per request; stdio passes identity via `_meta`. SSE rejected. Official identity requires trusted origin, not just the field. |
| Protocol era negotiation | implemented | `contracts/src/interfaces/mcp.port.ts:9`; `adapters/src/mcp/index.ts` (negotiation around `:311` test) | `mcp-version-negotiation.test.ts` | `docs/mcp-dual-era-version-negotiation.md` | `legacy | auto | 2026-07-28`; default auto. |
| Connection pool and reconnection | implemented | `adapters/src/mcp/pool.ts`; `adapters/src/mcp/index.ts:305`, `:365`, `:770`, `:1118-1137` | `mcp-connection-pool.test.ts`; `mcp.test.ts:771` | — | Shared startup wait without cancelling it; one retry after dead transport; explicit reconnect path. |
| Tool exposure and deferral | implemented | `core/src/mcp/index.ts:113-243`; `core/src/tool/search/exposure.ts:23-89` | `core/tests/mcp-runtime.test.ts`, `mcp-tool-bridge.test.ts`, `tool-search-exposure.test.ts` | `docs/mcp-async-tool-catalog-cache.md` | MCP tools are deferred by default (`shouldDefer: true` at `:234`), `alwaysLoad` overrides; native vs local tool-search modes. |
| Oversized result paging | implemented | `core/src/mcp/index.ts:49-51`, `:636-714` | `core/tests/mcp-structured-content-projection.test.ts` | `docs/mcp-tool-output-budget.md` | Text results >40 000 bytes are stored and paged with `__zcode_result_page` + tool-call id. |
| Notifications | implemented | `adapters/src/mcp/index.ts:165-168`, `:735` | `mcp.test.ts` | — | `tools/list_changed`, `resources/updated`, `resources/list_changed`, `notifications/message`. |
| stdio process containment | implemented | `adapters/src/mcp/process-tree.ts`, `windows-job-object.ts`, `stdio-transport.ts` | `mcp-process-lifecycle.test.ts`, `mcp-stdio-transport.test.ts` | `docs/windows-mcp-job-object-containment.md` | Process-tree termination; Windows Job Object; stderr diagnostics. |
| MCP result budget interaction with compact | implemented | `core/src/mcp/index.ts:49-51`; `runtime/helpers/compact-media.ts` | `compact-media-capability.test.ts` | `docs/compact-media-capability-projection.md` | Media in MCP results is capability-gated and preserved from microcompact (`compact/microcompact.ts:258-265`). |

### 2.8 Hooks

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Event surface | implemented (7 events) | `contracts/src/hooks/index.ts:7-15` | `core/tests/hooks-seven-events.test.ts:156-317` | `docs/hooks-runtime-contract.md:9-29` | SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop. No new events per spec. |
| Hook config types | implemented | `contracts/src/hooks/index.ts:303-341`, `:377-430` | `hooks-seven-events.test.ts:198` | `docs/hooks-runtime-contract.md:23-29` | `process` (argv) and `command` (shell); no `prompt`/`agent`/`http`/`callback`. |
| Matcher semantics | implemented | `core/src/hooks/output.ts:98`; `hooks-seven-events.test.ts:198` | `hooks-seven-events.test.ts:198` | `docs/hooks-runtime-contract.md` | Exact, pipe, wildcard, regex. |
| Execution pipeline | implemented | `core/src/hooks/runner.ts:35-200`, `:254+` | `core/tests/hook-runner-lifecycle.test.ts:48-370` | `docs/hooks-implementation-analysis.md` | Per-invocation id, per-run id, started/completed/blocked lifecycle, stderr/stdout previews, timeout/cancel outcomes. |
| Async hooks | implemented | `core/src/hooks/runner.ts:125-153`; `configured-runner-callback.ts:47-50` | `hook-runner-lifecycle.test.ts:151`; `hooks-seven-events.test.ts:286`, `:319` | `docs/hooks-runtime-contract.md` | Async command hooks run in background; their decisions cannot affect the already-continued action. |
| Output/decision semantics | implemented | `core/src/hooks/output.ts:11-79` | `hooks-seven-events.test.ts` (per-event verify) | `docs/hooks-runtime-contract.md:19-21` | `additionalContext`, `decision: block`, `continue`, `stopReason`, `suppressOutput`, `hookSpecificOutput` per event; Stop continuations capped at 3 (`runtime/methods/hooks.ts:10`, `:120-129`). |
| Hook context injection | implemented | `runtime/methods/hooks.ts:113`, `:131-140`; `runtime/methods/turn.ts:651-654` | `runtime-hooks.test.ts:102`, `:210` | — | Context injected as `hook_context` per-current-turn reminder, truncated to 24 000 chars (`hooks.ts:15`). |
| SessionStart semantics | partial | `runtime/methods/hooks.ts:20-48`; `turn.ts:444`, `resume.ts:307-315` | `runtime-hooks.test.ts:102` | — | Runs once per runtime (`sessionStartHookRan`, `hooks.ts:27-29`). `"clear"` and `"compact"` are declared in the union (`hooks.ts:18`) but no caller passes them (grep). |
| Workspace hook trust model | implemented | `core/src/hooks/workspace-hook-trust-evaluation.ts:15-99`; `contracts/src/hooks/workspace-hook-trust.ts:87-122`; `workspace-hook-policy.ts:4-7` | `workspace-hook-trust-domain.test.ts:84-226`; `workspace-hook-runtime-admission.test.ts`; `workspace-hook-review-flow.test.ts` | `docs/specs/workspace-hook-trust.md` (2756 lines) | Precedence deny > allow_trusted_only > persistent > revoked > stale_digest > pending. Corrupt store fails closed. Policy default `user_decides`. |
| Trust re-evaluation at dispatch | implemented | `core/src/hooks/runner.ts:87-90` | `hook-runner-dispatch-admission.test.ts` | `docs/workspace-hook-trust-user-guide.md` | Admission is re-resolved immediately before each hook dispatch; cached decision is used only for `skipLifecycle`/count. |
| Trust CLI | implemented | `cli/src/hooks-trust-command.ts:14-18`, `:148-160` | `cli/tests/hooks-trust-command.test.ts`; `bootstrap/tests/workspace-hook-trust-cli.test.ts` | `docs/workspace-hook-trust-user-guide.md` | `status/review/grant/revoke`, digest-based pretrust, corrupt-store guidance. |
| Hook redaction | implemented | `core/src/hooks/display-metadata.ts:3-6`, `:35-65` | `hook-runner-lifecycle.test.ts:215`, `:338` | — | Masks URL userinfo, bearer/basic auth, query params and `*_token/_secret/_password/_api_key/_private_key/_credential` forms before persistence. |
| Hook enable semantics | partial | `bootstrap/src/app/runtime-config.ts:263-287`; `core/src/hooks/configured-runner.ts:53-54` | `hooks-seven-events.test.ts:256` | `docs/hooks-runtime-contract.md:67-80` | Any plugin hook sets `enabled: true` for the merged config (`runtime-config.ts:282`), so a user `hooks.enabled:false` does not disable plugin hooks. `[observed]` merge overwrite. |
| Hook environment exposure | weak | `configured-runner-callback.ts:44`, `:89` (`createPluginEnvOverlay`) | `hooks-seven-events.test.ts` | `docs/plugin-hooks-compat.md:23-30` | Hook subprocesses inherit agent process env; enabling a plugin grants command execution and env read. Documented as current boundary. |

### 2.9 Subagents and orchestration

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Profile schema | implemented | `packages/shared/src/subagent-profile.ts:8-65`; `packages/shared/src/subagent-profile-parser.ts:33-107` | `core/tests/subagent-profile.test.ts` (93), `subagent-profile-fields.test.ts` | `docs/specs/zcode-agent-profile-lifecycle.md:5-13` | name/description/systemPrompt/source/modelSelection/permissionMode/memory/maxTurns/tools/disallowedTools/skills/mcpServers/background/injectAgentsMd/includeInSwarm/color. |
| Project-level privilege hardening | implemented | `packages/shared/src/subagent-profile-parser.ts:62-64` | `subagent-profile.test.ts` | — | Project markdown cannot set `permissionMode`; only user/trusted-plugin sources can. |
| Profile loading roots | implemented | `bootstrap/src/subagents.ts:50-111` | `bootstrap/tests/subagents.test.ts`, `subagent-runtime-config.test.ts` | — | `<storageRoot>/agents` (user) + `<cwd>/.zcode/agents` + additional dirs; `.cursor` never read. |
| Plugin agent templates | implemented | `bootstrap/src/subagents.ts:113-235` | `bootstrap/tests/subagents.test.ts` | `docs/specs/zcode-agent-profile-lifecycle.md` | Plugin `agents/*.md` namespaced `${plugin}:${agent}`. |
| Built-in role catalog | implemented | `core/src/subagent/profile.ts:18-35`, `:349-780` | `subagent-profile.test.ts` | `docs/specs/agent-capability-gate.md:5-31` | 16 built-in roles (see inventory). |
| Capability tiers (router/inspection/review/worker) | implemented | `profile.ts:149-233`; `subagent/tool-policy.ts:8-92` | `subagent-profile.test.ts`; `core/tests/subagent-execution-boundaries.test.ts` | `docs/specs/agent-capability-gate.md:18-40` | Routers get only `Task`; inspection/review get read+Bash+Task+Skill+marketplace; workers get full write set. |
| Effective child tool surface | implemented | `core/src/runtime/methods/subagent.ts` (`resolveSubagentToolAllowlist`, cited by spec `:14-16`); `subagent/tool-policy.ts:48-92` | `subagent-execution-boundaries.test.ts`, `subagent-output-permissions.test.ts` | `docs/specs/agent-capability-gate.md:33-40` | Child = profile tools ∩ parent effective surface, minus child-forced disallows (`EnterPlanMode`/`ExitPlanMode`, alias closure for Agent/Task). |
| Caller-scoped catalog and admission | implemented | `profile.ts:801-892` | `core/tests/agent-routing-policy.test.ts`, `agent-listing.test.ts` | `docs/specs/agent-capability-gate.md` | start→orchestrator only; inspection/review→researcher only; other subagents→any non-router; root→unrestricted. |
| Task/Agent tool with strict role validation | implemented | `core/src/tool/handlers/agent.ts:169-204`, `:559-640` | `core/tests/subagent-nesting.test.ts`; `task-alias-visibility.test.ts` | `docs/specs/task-alias-visibility.md` | `subagent_type` required; unknown role is an error, never falls back to `general-purpose`; `Agent` and `Task` are alias-closed. |
| Parallelism governance | implemented | `profile.ts:235-328`; `subagent/runner.ts:203-270`; `runtime-task/registry.ts:309-330` | `subagent-nesting.test.ts`; `subagent-background.test.ts` | `docs/specs/zcode-swarm-mode.md` | Pure routing gate plus capacity clamp at admission; adaptive default from CPU count. |
| Write scopes / work ledger | implemented | `core/src/tool/handlers/agent.ts:194`, `:548`; `runtime-task/work-ledger.ts:16`, `:214`, `:250-327`; `runtime-task/registry.ts:127-141`, `:2033-2092` | `core/tests/work-ledger.test.ts` (18), `work-ledger-wire.test.ts`, `work-ledger-workspace-root-admission.test.ts` | `docs/specs/agent-work-ledger.md:29-50` | `write_paths` is the only write-scope authority; conflicts block admission with `write_claim_conflict`; TTL 10 min with heartbeat. Ledger blocks spawn only, not Write/Edit (explicit non-goal, spec `:44`). |
| Background subagents / notifications | implemented | `subagent/runner.ts` lifecycle; `subagent/completion-notification.ts` | `subagent-background.test.ts` (3259 lines) | `docs/plans/2026-07-15-subagent-summary-side-pane-only-plan.md` | `run_in_background`, TaskOutput/TaskStop, completion notification with bounded summary. |
| DAG (`task_graph`) | implemented | `subagent/runner.ts:1192-1195`, `:1741-2040` | `create-workflow-graph-bounds-holes.test.ts`; `subagent-nesting.test.ts` | `docs/specs/zcode-swarm-mode.md` | Bounded node output (2 KiB), dependency context (24 KiB), aggregate result (64 KiB); availability advertised only when port exists (`dynamic-sections.ts:58-61`). |
| WorkResult contract | implemented | `subagent/runner.ts:1197-1400`, `:1585-1637` | `core/tests/work-result.test.ts` | `docs/specs/agent-work-ledger.md:40` | `<zcode-work-result>` block with bounded files/tests/evidence/metrics; derived from tool facts when absent. |
| Subagent persistent memory | implemented | `subagent/persistent-memory.ts:24-69`, `:76+` | — | `docs/specs/zcode-agent-profile-lifecycle.md:9-13` | Per-profile memory scopes; `Write`/`Edit` injected into tool list when memory enabled. |
| Subagent MCP scoping | implemented | `core/src/subagent/mcp-config.ts:10-95` | `core/tests/subagent-mcp-config.test.ts` | — | Profile `mcpServers` must be parent server names; wildcard `*` supported; connected-status matching uses model-visible naming. |
| Subagent borrowed MCP / browser | implemented | `subagent/borrowed-mcp-port.ts`; `browser-client`; `core/tests/subagent-borrowed-mcp-port.test.ts`, `subagent-browser-session.test.ts` | — | — | Child sessions borrow parent ports with child session identity. |
| Profile lifecycle writes (rename journal) | implemented | `docs/specs/zcode-agent-profile-lifecycle.md:5-39` (owner: `SubagentsService`) | `bootstrap/tests/subagents.test.ts` | same | Atomic staging + hash-guarded rename + disabled-ID journal; fail-closed on conflicts. |
| `injectAgentsMd` profile flag | partial | `core/src/subagent/profile.ts:355`+ (all built-ins `true`); `runtime/methods/subagent.ts:248` | `subagent-prompt-assembly.test.ts` | — | Comment documents a prior bug where `false` dropped project rules for Explore/descendants; the flag is effectively always on for built-ins. |

### 2.10 Custom commands and custom agents

| Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Command roots | implemented | `adapters/src/commands/roots.ts:21-72`, `:107-117` | `adapters/tests/commands.test.ts:7`, `:137`, `:155`, `:259` | — | `.zcode/commands` + `.agents/commands` at user and each project dir; `.zcode` wins duplicates; additional dirs namespaced. |
| Command frontmatter | implemented | `adapters/src/commands/index.ts:26-31`, `:184-216` | `commands.test.ts:8`, `:73` | — | `description`, `argument-hint`, `model`, `allowed-tools`; unknown keys are warnings. |
| Prompt expansion | implemented | `cli/src/custom-command-expand.ts:22-65` | (CLI command-center tests) | — | `$ARGUMENTS`, `$1..$n`, quoted args; rejects dynamic shell `` !`...` `` / fenced shell; appends "Required skills" instruction when command declares skills. |
| `allowed-tools` / `model` enforcement | weak | `adapters/src/commands/index.ts:211`, `:216`; `cli/src/command-center-custom.ts:13-14` | `commands.test.ts` | — | Parsed and surfaced in the command center, but not applied to the spawned turn's tool allowlist or model selection (no consumer found in `cli/src/command-center/create.ts`). |
| Plugin commands | implemented | `adapters/src/plugins/index.ts:452-465`, `:716-846` | `plugins.test.ts:741`, `:878` | — | Manifest `commands` materialized into `data/<plugin>/generated-commands` with metadata frontmatter, then merged as a command root. |
| Custom agents | implemented | `bootstrap/src/subagents.ts:50-111`; `docs/specs/zcode-agent-profile-lifecycle.md` | `subagent-profile.test.ts`; `bootstrap/tests/subagents.test.ts` | `docs/specs/zcode-agent-profile-lifecycle.md` | `.zcode/agents/*.md`; project-level profiles cannot raise permission mode. |
| Subagent factory | implemented | `core/src/subagent/profile.ts:333-347` | `subagent-profile.test.ts` | `docs/specs/zcode-agent-profile-lifecycle.md` | Writes `.zcode/agents/<kebab>.md`, forbids built-in/reserved names and root-only tools, requires real skills. |

### 2.11 Checked areas with no significant gap

These were inspected and look coherent; no actionable gap found:

- Context section ordering and cache-hint discipline (`builder.ts:220-236`, `:322-337`).
- Meta-user attachment assembly and reminder wrapping (`builder.ts:291-319`; `system-reminder/source.ts:226-272`).
- Instruction truncation/merge and `sources[]` handling (`adapters/src/context/index.ts:636-679`).
- Workspace rule path-escape and size-limit diagnostics (`adapters/src/context/index.ts:240-290`, `:469-487`).
- Memory index sanitization (frontmatter/HTML comment handling) (`memory/index-content.ts:8-66`).
- Memory agent tool-policy closure (deny reasons, catalog-miss handling) (`memory/memory-agent-loop.ts:127-169`, `:279-297`).
- Compact selection by assistant-started rounds (`compact/rounds.ts:1-35`; `compact/manual.ts:152-154`).
- Media protection in microcompact (`compact/microcompact.ts:258-265`).
- Post-compact read-state reminder reconstruction (`runtime/methods/compact-active.ts:216-224`; `runtime-compact.test.ts:1680-1898`).
- Interrupted compact timeline recovery (`compact-persistence.ts:199-286`; `runtime-compact.test.ts:2005`, `:2126`).
- Skill path traversal/overwrite protection in marketplace install (`adapters/tests/skill-marketplace.test.ts:113`, `:142`).
- Plugin duplicate-ID, impersonated marketplace, and stale-cache suppression (`plugins.test.ts:418`, `:461`, `:556`, `:577`).
- MCP dead-transport retry and intentional-close distinction (`mcp.test.ts:682`, `:771`).
- Hook matcher semantics and async decision isolation (`hooks-seven-events.test.ts:198`, `:286`).
- Hook trust precedence and corrupt-store fail-closed (`workspace-hook-trust-domain.test.ts:85-226`).
- Work ledger path normalization and overlap rules (`work-ledger.test.ts`; `work-ledger-wire.test.ts`).
- Agent/Task alias closure in allow/deny sets (`subagent/tool-policy.ts:13-28`).

## 3. Detailed findings

### 3.1 Context assembly

**What actually happens (observed).** `ContextBuilder.build()` (`core/src/context/builder.ts:83-236`) assembles an ordered section list, then splits it into:

1. a `system` message containing only the CLI prefix (`:246-256`);
2. a `system` message containing all `stable` sections with `cacheControl: ephemeral` (`:258-272`);
3. a `system` message containing all `dynamic` sections, prefixed with `\n\n` (`:274-286`);
4. up to two `meta_user` attachments: `skills_listing` and `context_prefix` (`:291-319`).

Ordering is `system/stable → system/dynamic → meta_user/stable → meta_user/dynamic` (`:322-337`), so cache breakpoints sit at stable boundaries and dynamic content cannot invalidate the stable prefix.

**Injection boundaries.** The builder is a *rendering* owner, not a policy owner. It reads a `ContextSourceSnapshot` produced by `NodeContextSourceAdapter.resolveContextSources` (`adapters/src/context/index.ts:57-98`), which in turn:

- resolves the project root by walking up to a `.git` marker (`:60`, `findProjectRoot`);
- resolves user/workspace instructions (`:65-75`, `:571-720`);
- resolves `.zcode/rules/*.mdc` (`:76-80`, `:223-323`);
- resolves bundled harness rules from package-relative candidates (`:81-84`, `:118-222`);
- detects project type/package manager (`:85-86`, `:727+`).

This is a clean ownership split: adapters do IO and trust checks; the builder does rendering and cache layout. Preserve it.

**Instruction precedence is explicit but limited.** Only one user default file and one nearest workspace file are loaded (`findInstructionFile` stops at the first match walking upward, `:681-704`). There is no merging of multiple nested `AGENTS.md` files along the path, and no `.cursor/rules` support (tests assert `.cursor` is ignored: `adapters/tests/fs-context.test.ts:883`). Nested per-package guidance (e.g. `packages/ui/AGENTS.md` inside a monorepo) is therefore invisible unless the session cwd is inside that package.

**Rules are glob-target-driven.** Glob rules apply only when an explicit workspace-relative target path is passed (`UserInstructionsOptions.ruleTargetPaths`, `contracts/src/interfaces/context-source.port.ts:28-29`; matching at `adapters/src/context/index.ts:194-201`). The runtime passes `subagentContext.ruleTargetPaths ?? userInstructions.ruleTargetPaths` (`runtime/methods/context.ts:64-66`). `[inferred]` If the main turn never supplies target paths, only `alwaysApply` rules inject; prompt text is deliberately not used for matching (comment at `context-source.port.ts:28`).

**Dead builder inputs.** `projectContext`, `agentProfiles`, `embeddedSearchEnabled`, `language` are declared (`context/types.ts:118-132`) and passed from `runtime/methods/context.ts:174-186`, but `grep` over `context/builder.ts` shows no reads. This is an interface that promises more than it delivers; callers can believe project type or language guidance is injected when it is not.

**Vacuous compact-guidance tests.** `context-builder.test.ts:783-817` asserts that `# Function Result Clearing` is absent; `grep` over `core/src`, `bootstrap/src`, `cli/src` finds that string only in tests. Those tests cannot fail for the stated reason.

### 3.2 Memory runtime

**Two retrieval branches, one active.** `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED = false` (`memory/project-memory-retrieval-branch.ts:4`) selects `default-index`. In this branch:

- `MEMORY.md` is read at context init and injected as a meta-user section (`runtime/methods/context.ts:214-243`; `sections/request-user-context.ts:137-150`);
- the selector, manifest scan, and `relevant_memory` injection are not started (`runtime/helpers/project-memory-recall.ts:51`, `:102`);
- the Memory system section tells the model to maintain the index pointer (`sections/memory.ts:52-57`).

The `semantic-recall` code path is complete and tested (`memory-recall.test.ts:174-560`) but dormant. Switching the single constant is the only intended lever (comment at `project-memory-retrieval-branch.ts:3`).

**Extraction is a bounded background agent.** After a successful turn (`runtime/methods/turn.ts:1061-1066`), a snapshot of the active conversation branch up to the boundary message is scheduled (`project-memory-extraction.ts:45-75`). The scheduler keeps one running execution and coalesces newer snapshots into one pending slot (`memory/extraction.ts:85-179`). Eligibility requires ≥3-word non-meta user prose and no direct memory write after the cursor (`:68-83`, `:228-297`). Execution is capped at 5 turns (`project-memory-extraction.ts:19`) and runs with a deny-by-default permission broker (`project-memory-agent.ts:122`) plus the memory tool policy (`memory-agent-loop.ts:127-169`).

**Boundaries that matter.** Extraction is disabled for remote workspaces (`project-memory-extraction.ts:42`) and when `memory.extractionEnabled === false` (`:38`). A session close drains with a 60 s bounded wait (`:20`, `:83-107`). Shutdown aborts the scheduler so it cannot keep writing memory after the session is gone (`memory/extraction.ts:170-177`).

**What is missing.**

- **No redaction.** Memory content is written verbatim by the model. Path sensitivity is enforced (`memory/memory-file-path.ts:5-26`), but there is no secret/PII filter and no instruction telling the model to avoid secrets. Hook command redaction exists for a different surface (`hooks/display-metadata.ts:35`), which shows the codebase knows how to do it.
- **No first-class remember/forget.** There is no `Remember`/`Forget` tool; the behavior is prompt-only (`memory/extraction.ts:62`; `subagent/persistent-memory-prompt.ts:13`). A user asking to "forget X" depends on the extraction subagent finding and deleting the file in a 5-turn budget.
- **Dream is not wired.** The consolidation prompt, 24 h gate, throttle and lock exist (`memory/dream.ts`), but the product path never calls `runProjectMemoryDream`; the file itself says so (`project-memory-dream.ts:54`). Long-lived memory therefore never gets cross-session synthesis.
- **No memory deletion audit.** `rm` inside the memory root is allowed by policy (`memory-agent-loop.ts:188-217`) and by the write permission fast-path (`memory-file-permission.ts:19-46` covers Write/Edit only, but `rm` is allowed in the memory agent). There is no tombstone or undo.

### 3.3 Compaction runtime

**Four triggers, three producers.** `CompactTrigger` declares `manual/auto/partial/reactive/session_memory` (`contracts/src/compact/index.ts:9-15`), but only `manual`, `auto`, and `reactive` have producers (`runtime/methods/compact.ts:86`, `:275`, `:432`). `partial` and `session_memory` exist only in the phase/reason mapping (`runtime/helpers/compact.ts:44-62`) and contract arrays.

**Pipeline order per model step** (`runtime/methods/turn-loop.ts:144-191`):

1. consume settled memory recall (inactive branch) after a completed real tool batch;
2. microcompact (opt-in; default off, `runtime/methods/microcompact.ts:111`);
3. compute rapid-refill decision;
4. auto-compact if above threshold and breaker allows;
5. throw `compact_rapid_refill_breaker` if blocked;
6. record success and reset tool-turn counter if compacted.

Reactive compaction happens later, on provider overflow, once per model step (`turn-model-step.ts:831-883`).

**Threshold math is defensible.** Effective window = context window − min(maxOutput, 21 000) (`compact/policy.ts:67-82`); threshold = effective − 13 000 (`:84-88`). Token truth prefers provider `contextUsageTokens` + local increment over pure estimation (`runtime/methods/compact.ts:317-344`), and the estimator includes reasoning blocks and tool-call inputs (`compact/manual.ts:106-142`) — two places where naive implementations undercount.

**Preservation and ordering are strong.** Auto/reactive preserve one recent assistant-started group (`runtime/helpers/compact-selection.ts:36`), the boundary records `preservedSegment`, and cold resume re-inserts it after the anchor (`agent/compact-session.ts:18-27`). Persistence happens before runtime history replacement (`compact-active.ts:294-306`), and the timeline is reconciled on resume (`compact-persistence.ts:199-286`).

**Gaps.**

- **Microcompact is default-off.** `enabled: config.microcompact?.enabled === true` (`runtime/methods/microcompact.ts:111`) means the feature ships but does nothing unless an embedder explicitly turns it on. No bootstrap wiring sets it (`grep` over `bootstrap/src/app/runtime-config.ts` finds no `compact`/`microcompact` key). `[inferred]` The product's advertised "microcompact" capability is effectively dormant.
- **`features.compact` is a dead flag.** The config key is stored (`adapters/src/config/index.ts:120-121`, `:290`) but never mapped into `AgentRuntimeConfig`; runtime enablement reads `config.compact?.enabled`, which bootstrap does not set. Users cannot disable compaction via config in the CLI path.
- **Two dead policy knobs.** `summaryReserveTokens` and `thresholdPercentOverride` (`compact/policy.ts:21`, `:23`) are never read; a test even asserts the percent override no longer changes behavior (`compact-policy.test.ts:200-210`). This is stale surface area.
- **Partial compaction is absent.** There is no way to compact only the oldest half while keeping a mid-conversation boundary; it is all-or-nothing from the boundary.

### 3.4 History and session state

`MessageHistoryImpl` (`core/src/agent/message-history.ts:163-260`) is the single in-memory owner of provider-visible history. Context prefix entries are distinguished by metadata, not text (`runtime/helpers/compact.ts:80-88`), which is why literal `<system-reminder>` user text is not mistaken for a prefix (`runtime-compact.test.ts:1143`).

Cold resume rebuilds entries from the session store (`agent/session-history-hydrator.ts:58+`) and honors compact boundaries (`compact-persistence.ts:199-286`). Rewind/fork branch selection is applied when snapshotted for extraction (`project-memory-extraction.ts:57-62`), so background memory work cannot resurrect an abandoned branch.

The product protocol treats compact as `activeWork.kind=compact` inside `running`, with explicit reject/queue rules for `/compact` (`docs/conversation-product-protocol.md:241-436`; `docs/testing/conversation-session-compact-decision-worksheet.md:8-28`). That is a real, documented state machine rather than an implicit one.

### 3.5 Skills

**Discovery is path-identity based.** `NodeSkillAdapter.discoverSkills` walks roots by ascending priority, dedupes by resolved path, and returns skills sorted by name (`adapters/src/skills/index.ts:68-102`). Same-name skills from different roots coexist; `loadSkill` resolves by root priority and matches either `name` or `qualifiedName` (`:186`, `:495-497`). Tests pin this behavior (`skills.test.ts:172`, `:221`, `:433`).

**Trust boundaries.** Plugin skill roots do not follow symlinks; user roots do (`adapters/src/skills/index.ts:217-221`). Marketplace snapshots reject `..`, absolute paths, NUL, and oversize files, and never execute bundle content (`docs/specs/skill-marketplace.md:36-46`; tests `skill-marketplace.test.ts:113`).

**Policy fields are decorative.** `safeToAutoLoad` and `allowImplicitInvocation` are computed (`adapters/src/skills/index.ts:310`, `:313`) but only `safeToAutoLoad` is read, and only for CLI display (`cli/src/skills-command.ts:160`, `:228`). `allowImplicitInvocation` is always `true` and never read. There is no "this skill may not be auto-invoked" gate.

**Skill args are ignored.** The schema advertises `args` (`contracts/src/tools/skill.ts:9-14`) and the tool description tells the model to pass them (`core/src/tool/handlers/skill.ts:110`), but the handler destructures only `{ skill }` (`:38`). Skills cannot receive parameters, and `/skill name task` style invocation loses the task text unless the caller also writes it in the prompt.

**Listing budget is sensible.** 20 000 chars with a names-only fallback (`context/sections/skills.ts:9`, `:52-60`) prevents skills from crowding out instructions.

### 3.6 Plugins

**Resolution is layered and mostly fail-safe.** Candidates come from inline dirs, official roots, official cache scan, and installed records (`adapters/src/plugins/index.ts:238-277`). Duplicate IDs are diagnosed (`:162-171`), suppressed built-ins are filtered by authoritative ID even if stale cache dirs remain (`:155-161`), and unsupported components are warnings only (`:378-390`).

**Install is transactional.** `installMarketplacePlugin` resolves a dependency closure, stages each plugin directory, activates them, and rolls back all activations if any step throws (`adapters/src/plugins/marketplace.ts:830-873`). `AtomicDirectoryActivation` supports `finalize`/`rollback` with transaction records and crash recovery (`adapters/src/plugins/atomic-directory.ts:7-60`). Uninstall can keep user data (`marketplace.ts:876-898`).

**Marketplace sources are broad.** url/github/git/npm/file/directory/hostPattern/pathPattern/settings (`marketplace.ts:84-93`). Git operations use a proxy-aware environment (`:204+`) and bounded retries.

**The weak point is plugin hook trust.** `canRunPluginHooks` returns `true` for every plugin (`adapters/src/plugins/index.ts:371-376`), with a comment acknowledging that "enabling a plugin" grants local command execution and inherited env. `docs/plugin-hooks-compat.md:23-30` documents the same. This is a deliberate current boundary, not an accident, but it is the largest asymmetry versus the carefully gated workspace-hook trust system (`docs/specs/workspace-hook-trust.md`).

**Hook merge can re-enable hooks.** `mergeRuntimeHooks` returns `enabled: true` whenever any plugin hook exists (`bootstrap/src/app/runtime-config.ts:281-286`), overriding a user `hooks.enabled:false`. `[observed]` code path; `[inferred]` user intent to disable hooks is not honored when a plugin contributes hooks.

### 3.7 MCP

**Transport and auth coverage is unusually complete.** stdio/http/sse (`contracts/src/interfaces/mcp.port.ts:8`), OAuth authorization-code and client-credentials (`:27-44`), official ZCode JWT auth restricted to http/stdio (`adapters/src/plugins/mcp.ts:199-211`), and protocol-era negotiation (`mcp.port.ts:9`). Tests cover OAuth refresh, lease, callback, cross-process e2e, official auth integration and stdio `_meta` (`adapters/tests/mcp-oauth*.test.ts`, `mcp-official-auth*.test.ts`).

**Tool exposure is deferral-first.** MCP tools get `shouldDefer: true` (`core/src/mcp/index.ts:234`), with `alwaysLoad` as the escape hatch (`:235`), and the catalog participates in tool-search (`core/src/tool/search/exposure.ts:42-89`). Oversized text results are paged at 40 000 bytes (`core/src/mcp/index.ts:51`, `:636`).

**Config compatibility is handled at the entry.** Legacy `environment→env`, `remote→http`, per-server fault isolation with diagnostics (`docs/mcp-config-compat-diagnostics.md:5-35`). This prevents one bad server from invalidating unrelated config.

**Boundaries.** Session startup waits at most 15 s for interactive OAuth (`core/src/runtime/methods/mcp.ts:12`, `:74-77`) so a missing browser authorization cannot hang the first model request; the settings page owns the authorization entry point. That is a good latency/UX boundary.

### 3.8 Hooks

**Seven events, closed set.** `contracts/src/hooks/index.ts:7-15`; the runtime contract says explicitly that no new events are added this period (`docs/hooks-runtime-contract.md:9-29`).

**Execution semantics are careful.**

- Admission is resolved twice: once to compute `skipLifecycle`/`hookCount`, and again immediately before each dispatch (`core/src/hooks/runner.ts:61-90`) so revoke/policy/store reload during a preceding hook takes effect.
- Blocked hooks emit `HookRunBlocked` with a sanitized reason (`:91-111`, `:174-200`).
- Async hooks run in background and their decisions are discarded (`:125-153`; test `hooks-seven-events.test.ts:286`).
- Output is bounded by `maxOutputBytes` (default 32 768) and the injected context is truncated to 24 000 chars (`runtime/methods/hooks.ts:15`).

**Workspace hook trust is the strongest safety design in this area.** Precedence is `deny > allow_trusted_only > persistent > revoked > stale_digest > pending` (`workspace-hook-trust-evaluation.ts:28-42`), trust keys are `workspaceIdentity + declaration digest` (`:66-68`), a corrupt store fails closed (`:30-31`; `workspace-hook-runtime-admission.ts:141`), and grant/revoke are explicit CLI actions (`cli/src/hooks-trust-command.ts:14-18`). Review flow and admission have dedicated tests (`workspace-hook-review-flow.test.ts`, `workspace-hook-runtime-admission.test.ts`).

**Gaps.**

- `SessionStart` declares `"clear"` and `"compact"` sources (`runtime/methods/hooks.ts:18`) but only `"startup"` and `"resume"` are passed (`turn.ts:445`, `resume.ts:308`). Matchers on `clear`/`compact` can never fire.
- `sessionStartHookRan` makes SessionStart once-per-runtime (`hooks.ts:27-29`), so a resume in the same runtime cannot re-run SessionStart hooks.
- Plugin hook trust is absent (see 3.6), and plugin hooks can force `enabled: true`.
- `PostToolUseFailure`/`PostToolUse` `additionalContext` is merged into the tool result path; `[inferred]` large hook contexts can inflate the next request even though the hook's own stdout is bounded — the 24 000-char truncation at `hooks.ts:15` applies to the injected reminder, which mitigates this.

### 3.9 Subagents and orchestration

**The catalog is explicit and enforced.** 16 built-in roles (`profile.ts:18-35`, definitions `:349-780`) with four capability tiers (`:149-233`), a pure routing gate (`:260-301`), and a caller-scoped catalog filter (`:819-862`). The spec (`docs/specs/agent-capability-gate.md:5-40`) states the invariant: a profile is an upper bound, never an expansion of the parent.

**Write scopes are real.** `write_paths` is parsed from the tool input (`tool/handlers/agent.ts:548`) and enforced at admission through the work ledger (`runtime-task/registry.ts:2033-2092`). Conflicts return `write_claim_conflict` before any state mutation. The ledger's own spec is explicit that it blocks spawn only, not Write/Edit (`docs/specs/agent-work-ledger.md:42-46`). This is an important honesty boundary: a determined child can still write outside its declared paths; the ledger prevents duplicate work, not unauthorized writes. Actual file-write authorization remains with the permission layer.

**DAG support is bounded.** Node output 2 KiB, dependency context 24 KiB, aggregate 64 KiB (`subagent/runner.ts:1192-1195`), and `task_graph` is advertised only when the port exists (`context/dynamic-sections.ts:58-61`).

**Gaps.**

- `injectAgentsMd: false` is documented as previously dropping project rules for Explore/descendants (`runtime/methods/subagent.ts:248`); all built-ins now set `true`. The flag is effectively vestigial and a future custom profile could reintroduce the bug.
- Subagent context does not include the memory section or the context-management section (`subagent/context-builder.ts:113-172`), so a child cannot use the main memory index even when `memory.enabled` is true for the session. Per-profile memory is a separate mechanism.
- The work-ledger `write_paths` contract is prompt-enforced for correctness of intent (the model must declare them); a wrong declaration silently narrows or widens the claim.

### 3.10 Custom commands

Parsing, expansion, and roots are solid (`adapters/src/commands/*`, `cli/src/custom-command-expand.ts`). The gap is enforcement: `allowed-tools` and `model` frontmatter are parsed (`adapters/src/commands/index.ts:211`, `:216`) but not applied to the turn. A command that declares `allowed-tools: Read` still runs with the session's full tool surface. `[inferred]` from absence of consumers in `cli/src/command-center/create.ts` and `bootstrap/src/custom-commands.ts`.

## 4. Inventories

### 4.1 Skills (bundled, 23)

From `apps/zcode-cli/packages/bundled-skills/skills/` (directory listing):

`anti-loop`, `code-craft`, `codebase-design`, `completion-gate`, `doc-coauthoring`, `domain-modeling`, `dynamic-workflows`, `execution-patterns`, `handoff`, `image-to-code`, `mcp-authoring`, `merge-conflict-resolution`, `performance-tuning`, `reference-first`, `research`, `reviewer`, `self-improvement`, `task-planning`, `ui-craft`, `zcode-swarm`, `zcode-systematic-debugging`, `zcode-test-driven-development`, `zcode-verification`.

Plus plugin skills under each `*-plugin/skills/` directory (18 plugin packages listed in `apps/zcode-cli/packages`), and repo-synced skills from `skills-sh.lock.json` (19 entries) installed into `.agents/skills`.

Skill scopes: `project | user | system | admin` (`contracts/src/skills/index.ts:7`). Produced scopes in practice: `user`, `project` (`adapters/src/skills/roots.ts:46-55`), `system` for bundled (`bootstrap/src/app/bundled-skills.ts:124-125`). Sources declared: `agents | cursor | zcode | bundled | plugin | remote` (`contracts/src/skills/index.ts:9`); produced: `zcode`, `agents`, `bundled`, `plugin`. `cursor` and `remote` are declared but not produced (`.cursor` is explicitly ignored: `skills.test.ts:268`).

### 4.2 Plugin sources

| Dimension | Values | Evidence |
| --- | --- | --- |
| Discovery source | `official`, `inline`, `cache` | `contracts/src/plugins/index.ts:27`; `adapters/src/plugins/index.ts:244-274` |
| Marketplace source kinds | url, github, git, npm, file, directory, hostPattern, pathPattern, settings | `adapters/src/plugins/marketplace.ts:84-93` |
| Manifest paths | `.zcode-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` | `adapters/src/plugins/index.ts:105-107` |
| Marketplace manifests | `marketplace.json` / `.claude-plugin/marketplace.json` | `adapters/src/plugins/marketplace.ts:56`, `:65` |
| Plugin components | skills, commands, agents, hooks, MCP servers, UI surfaces | `contracts/src/plugins/index.ts:97-109`, `:144-166` |
| Unsupported components | channels, lspServers, outputStyles, settings | `adapters/src/plugins/index.ts:112` |
| Installed state | `installed_plugins.json`, `known_marketplaces.json` | `adapters/src/plugins/marketplace.ts:54-55` |
| Bundled plugin packages | 15 `*-plugin` dirs under `apps/zcode-cli/packages` | directory listing |

### 4.3 MCP transports and auth

| Transport | Config type | Auth options | Notes |
| --- | --- | --- | --- |
| stdio | `McpStdioServerConfig` (`mcp.port.ts:76-85`) | `zcode_official` via `_meta`; no OAuth | Process-tree transport (`adapters/src/mcp/stdio-transport.ts`); Windows Job Object containment. |
| http | `McpHttpServerConfig` (`:87-95`) | `oauth` (authorization_code / client_credentials), `zcode_official` headers | Streamable HTTP (`adapters/src/mcp/index.ts:1953`). |
| sse | `McpSseServerConfig` (`:97-102`) | `oauth` | `zcode_official` rejected (`adapters/src/plugins/mcp.ts:200-205`). |

Protocol versions: `legacy | auto | 2026-07-28` (`mcp.port.ts:9`). Isolation: `session | workspace` (`:10`). Notifications: `tools/list_changed`, `resources/updated`, `resources/list_changed`, `notifications/message` (`adapters/src/mcp/index.ts:165-168`).

### 4.4 Hook events

| Event | Input payload | Decision capabilities | Invocation site |
| --- | --- | --- | --- |
| SessionStart | `source: startup|resume|clear|compact`, `model` | `additionalContext` | `runtime/methods/turn.ts:444`, `resume.ts:307` |
| UserPromptSubmit | `prompt`, `attachmentsSummary` | `additionalContext`, block (`preventContinuation`) | `turn.ts:600-654` |
| PreToolUse | `toolName`, `toolInput`, `riskLevel`, `sideEffectScope` | `permissionDecision`, `updatedInput`, `additionalContext`, block | `tool/executor/hook-flow.ts:16-40` |
| PermissionRequest | `requestId`, `reason`, `permissionSuggestions` | `allow` with permission updates / `deny` with interrupt | `hook-flow.ts:60+` |
| PostToolUse | `toolResponse`, `toolResultPreview`, `artifactRefs` | `additionalContext` | `hook-flow.ts:135+` |
| PostToolUseFailure | `error {type,message}`, `isInterrupt` | `additionalContext` | `hook-flow.ts:169+` |
| Stop | `responsePreview`, `responseText`, `stopHookActive`, `toolCallCount` | `additionalContext`, continue (≤3) | `runtime/methods/turn-stop.ts:211`; `hooks.ts:120-129` |

Hook kinds: `process` (argv, no shell) and `command` (shell) (`contracts/src/hooks/index.ts:303-329`). Source kinds: `user | plugin | project | internal` (`:29-36`). Outcomes: `success | blocked | failed | cancelled | timed_out` (`:19-25`).

### 4.5 Subagent roles (built-in, 16)

From `core/src/subagent/profile.ts:18-35` with tier mapping from `docs/specs/agent-capability-gate.md:18-31`:

| Role | Tier | Tools (declared) |
| --- | --- | --- |
| `start` | read-only router | `Task` |
| `orchestrator` | read-only router | `Task` |
| `researcher` | inspection | CodeIndex, Read, Glob, Grep, Bash, WebFetch, WebSearch, Task, Skill, SkillSearch, SkillInstall, TodoRead, TodoWrite, AskUserQuestion, TaskOutput, TaskStop |
| `debugger` | worker | `WORKER_SUBAGENT_TOOL_NAMES` (`profile.ts:195-214`), used at `:468` |
| `implementer` | worker | worker set |
| `coder` | worker | worker set |
| `frontend-coder` | worker | worker set |
| `backend-coder` | worker | worker set |
| `infra-coder` | worker | worker set |
| `reviewer` | review-only | `REVIEW_SUBAGENT_TOOL_NAMES` (`profile.ts:175-192`), used at `:640` |
| `security-reviewer` | review-only | same review set |
| `test-engineer` | worker | worker set |
| `evaluator` | inspection | inspection set |
| `self-improver` | worker | worker set |
| `knowledge-curator` | worker | worker set |
| `subagent-factory` | worker | worker set |

Root-only tools excluded from all profiles: `CronCreate/Delete/List/Update`, `ScheduleWakeup`, `Workflow`, `EnterWorktree/ExitWorktree`, `TaskCreate/Get/List/Update` (`profile.ts:220-233`).

Caller policy (`profile.ts:819-862`): `start → orchestrator`; inspection/review → `researcher` only; other subagents → any non-router; root → unrestricted.

### 4.6 Context sections (source enum)

`cli_prefix`, `identity`, `env_info`, `system_context`, `skills`, `tools`, `request_user_context`, `memory`, `current_date`, `custom_system_prompt`, `workflow_actor_identity`, `subagent_agent_prompt`, `subagent_notes`, `subagent_environment`, `dynamic_behavior`, `session_guidance`, `output_style`, `context_management`, `desktop_context` (`context/types.ts:35-54`).

`tools` is declared but no longer produced; tool descriptions travel in the request `tools` field (comment at `context/builder.ts:48-50`; test `context-builder.test.ts:1182`).

## 5. Strengths worth preserving

1. **Cache-aware section layout.** Stable/dynamic split with a separate CLI-prefix message is a deliberate provider-cost optimization (`builder.ts:243-289`). Do not collapse it.
2. **One owner per mutable fact.** `MessageHistoryImpl` owns history; `WorkLedger` owns path claims; `CommandInbox` owns admission; trust coordinator owns hook trust. The specs repeat this and the code respects it.
3. **Untrusted-content framing.** Workspace rules and `AGENTS.md` are labeled as unable to change permissions/trust (`request-user-context.ts:79-86`, `:105`, `:132`). This is a real prompt-injection mitigation.
4. **Path containment everywhere.** Memory writes (`memory-file-path.ts`), workspace rules (`context/index.ts:240-290`), plugin components (`resolveInside`), and marketplace snapshots all validate containment and reject escapes with diagnostics.
5. **Atomic persistence by default.** `writeTextFile` uses temp+fsync+rename and refuses symlink targets (`adapters/src/fs/index.ts:700-745`); plugin installs use staged atomic directory activation with rollback.
6. **Trust re-evaluation at execution time.** Hook admission is re-resolved immediately before dispatch (`hooks/runner.ts:87-90`), and the trust key includes the declaration digest, so an edited hook loses trust (`workspace-hook-trust-evaluation.ts:66-99`).
7. **Provider-truth token accounting.** Compaction prefers provider usage over estimates and includes reasoning/tool-call inputs in the fallback (`compact.ts:317-344`; `compact/manual.ts:106-142`).
8. **Rapid-refill and failure breakers.** Both auto-compact failure streaks and post-compact refill loops are bounded with actionable messages (`policy.ts:136-144`; `turn-loop-state.ts:212-236`; `model-errors.ts:46-60`).
9. **Dormant-but-complete semantic recall.** The selector path is implemented, tested, and switchable from one constant (`project-memory-retrieval-branch.ts:4`), which is a low-risk path to a future capability.
10. **Capability tiers with a stated invariant.** A child profile cannot exceed the parent's effective tool surface (`docs/specs/agent-capability-gate.md:33-40`; `subagent/tool-policy.ts:80-92`).

## 6. Candidate recommendations

Each item: problem → ZCode evidence → solution/boundaries → effect → risk/size → priority → acceptance → verification. "Competitor evidence needed" marks claims that must be validated against other products before asserting a gap.

### C-01. Wire or remove the dead `features.compact` flag

- **Problem:** users cannot disable compaction from config in the CLI path; the flag exists but is inert.
- **Evidence:** `contracts/src/config/index.ts:34`, `:317`; `adapters/src/config/index.ts:120-121`, `:290`; no `compact` mapping in `bootstrap/src/app/runtime-config.ts` (grep empty); runtime reads `config.compact?.enabled` (`runtime/methods/microcompact.ts:36`, `runtime/methods/compact.ts:366`).
- **Solution:** map `features.compact` (and optionally `compact.microcompact`) into `AgentRuntimeConfig.compact.enabled` in `resolveAppRuntimeConfig`, keeping `AgentRuntimeConfig` as the only runtime owner. Do not add a second read path in core.
- **Boundaries:** CLI/bootstrap only; core keeps its existing `config.compact` contract; protocol unchanged.
- **Effect:** config flag becomes truthful; users can turn compaction off.
- **Risk / size:** low / S.
- **Priority:** P1 (correctness of a public config surface).
- **Acceptance:** with `features.compact: false`, `shouldAutoCompact` returns `reason: "disabled"` and no compact boundary event is emitted in a turn.
- **Verification:** unit test in `bootstrap/tests` asserting the mapped runtime config; existing `compact-policy.test.ts` covers `enabled:false` behavior.
- **Competitor evidence needed:** no (internal correctness).

### C-02. Make microcompaction reachable (or delete it)

- **Problem:** microcompact is opt-in and nothing opts in, so the advertised capability never runs.
- **Evidence:** `runtime/methods/microcompact.ts:111` (`enabled === true`); `compact/microcompact.ts:83-174`; no bootstrap wiring.
- **Solution:** default `microcompact.enabled` to true when `features.compact` is enabled, with explicit `false` respected; expose threshold/keep-count via the existing `LocalMicrocompactPolicyConfig`. Keep the safety rules (media/error protection, min savings).
- **Boundaries:** core default change + one config mapping; no new tool or protocol.
- **Effect:** large tool outputs stop occupying the window until full compaction; fewer auto-compacts.
- **Risk / size:** medium / S–M (behavior change; must not clear results the model still needs — mitigate with `keepRecentToolResults` default 5 and the existing media/error exclusions).
- **Priority:** P1.
- **Acceptance:** a session with >threshold tool output emits `MicrocompactBoundary` and saves ≥256 tokens; error and media results are preserved.
- **Verification:** `microcompact.test.ts` already covers all these cases; add a bootstrap config test for the default.
- **Competitor evidence needed:** yes — verify whether competitors run tool-result clearing by default before framing this as parity.

### C-03. Remove stale compact policy fields and vacuous tests

- **Problem:** `summaryReserveTokens`/`thresholdPercentOverride` are dead config; two context tests assert absence of a string that no longer exists.
- **Evidence:** `compact/policy.ts:21`, `:23`; `compact-policy.test.ts:200-210`; `context-builder.test.ts:783-817`; grep shows `# Function Result Clearing` only in tests.
- **Solution:** delete the unused fields (or implement them and document precedence); replace the two context tests with assertions on the actual context-management section (`dynamic-sections.ts:111-117`).
- **Boundaries:** no behavior change intended.
- **Effect:** less misleading API surface; tests regain signal.
- **Risk / size:** low / S.
- **Priority:** P2.
- **Acceptance:** typecheck passes; no reference to removed fields; new tests fail if `# Context management` is removed.
- **Verification:** `pnpm typecheck`, `context-builder.test.ts`, `compact-policy.test.ts`.
- **Competitor evidence needed:** no.

### C-04. Add secret/PII guardrails to the memory write path

- **Problem:** memory files are persisted verbatim with no redaction and no instruction to avoid secrets.
- **Evidence:** no `redact`/`sanitize` in `core/src/memory/*` (grep); `memory/memory-file-path.ts` enforces only path sensitivity; extraction prompt (`memory/extraction.ts:42-65`) has no secret rule; by contrast hooks redact before persistence (`hooks/display-metadata.ts:35-65`).
- **Solution:** add a memory-specific redaction/screening step at the tool boundary for memory-root writes (reuse the hook sensitive-key patterns), and add one explicit instruction to the Memory section and extraction prompt. Log a redaction event; do not silently rewrite user-provided text outside memory roots.
- **Boundaries:** memory root only; no change to general Write/Edit; no change to hook redaction.
- **Effect:** prevents durable credential leakage into `MEMORY.md`/topic files that are re-injected every session.
- **Risk / size:** medium / M (false positives must not corrupt legitimate notes; prefer flag+redact over reject).
- **Priority:** P1 (security).
- **Acceptance:** a Write of `api_key=...` into the memory root persists a masked value and emits a redaction event; the same content outside the memory root is untouched.
- **Verification:** new unit tests next to `memory-agent-loop.test.ts` and `memory-file-permission.ts`; reuse `hook-runner-lifecycle.test.ts:338` patterns.
- **Competitor evidence needed:** yes — check how competitors handle durable memory secrets before claiming a differentiator.

### C-05. Give remember/forget a first-class surface

- **Problem:** remember/forget are prompt-only; a "forget X" request depends on a 5-turn background extraction agent.
- **Evidence:** `memory/extraction.ts:62`; `subagent/persistent-memory-prompt.ts:13`; no `Remember`/`Forget` tool in `core/src/tool/handlers`.
- **Solution:** add `MemoryRemember`/`MemoryForget` tools that operate only inside the memory root (reuse `resolveSafeMemoryFilePath`), with deterministic file writes and index updates; keep extraction for implicit learning.
- **Boundaries:** tools own file mutation; extraction keeps its current role; permission fast-path already allows contained markdown writes.
- **Effect:** explicit user intent is honored deterministically and immediately.
- **Risk / size:** medium / M (new tool surface, index consistency).
- **Priority:** P2.
- **Acceptance:** `MemoryForget(name)` removes the topic file and its `MEMORY.md` line; `MemoryRemember` creates/updates a file with frontmatter and index pointer; both reject paths outside the memory root.
- **Verification:** new core tool tests; reuse `memory-extraction.test.ts` fixtures for frontmatter.
- **Competitor evidence needed:** yes — many competitors expose explicit memory commands; validate naming/UX expectations.

### C-06. Gate plugin hooks behind an explicit trust decision

- **Problem:** enabling any third-party plugin grants shell-hook execution with inherited environment.
- **Evidence:** `adapters/src/plugins/index.ts:371-376` (`return true`); `docs/plugin-hooks-compat.md:23-30`; hook subprocess env overlay at `configured-runner-callback.ts:44`, `:89`.
- **Solution:** reuse the existing workspace-hook trust machinery for plugin hook declarations: compute a declaration digest, require `pending_trust` admission for marketplace (non-official) plugins, and expose the existing `zcode hooks trust` review flow. Official/bundled plugins can be pretrusted by the shipped manifest.
- **Boundaries:** plugin loader produces declarations; the trust coordinator remains the only admission owner; no second trust store.
- **Effect:** closes the largest asymmetry between workspace hooks and plugin hooks.
- **Risk / size:** medium-high / M–L (migration for existing installs; must not break official plugins).
- **Priority:** P1 (security), but requires product decision on migration.
- **Acceptance:** a freshly installed marketplace plugin with `hooks/hooks.json` shows `pending_trust` and does not execute until granted; official bundled plugins execute as before.
- **Verification:** extend `workspace-hook-trust-domain.test.ts` and `plugins.test.ts`; add a bootstrap integration test.
- **Competitor evidence needed:** yes — competitor plugin-hook permission models should be checked before finalizing the migration story.

### C-07. Stop plugin hooks from overriding `hooks.enabled:false`

- **Problem:** any plugin hook sets the merged hooks config to `enabled: true`.
- **Evidence:** `bootstrap/src/app/runtime-config.ts:281-286`.
- **Solution:** preserve the user's `enabled` value; when it is `false`, keep plugin hook declarations as inspectable but non-executable (same pattern as pending trust).
- **Boundaries:** bootstrap merge only.
- **Effect:** user intent is honored; also a prerequisite for C-06.
- **Risk / size:** low / S.
- **Priority:** P1.
- **Acceptance:** user config `hooks.enabled:false` + a plugin with hooks → no hook executes; settings still lists the declarations.
- **Verification:** `bootstrap/tests/plugins.test.ts` or a new runtime-config test.
- **Competitor evidence needed:** no.

### C-08. Honor `allowed-tools`/`model` in custom commands

- **Problem:** command frontmatter is parsed but not enforced.
- **Evidence:** `adapters/src/commands/index.ts:211`, `:216`; no consumers in `cli/src/command-center/create.ts` or `bootstrap/src/custom-commands.ts`.
- **Solution:** when a command declares `allowed-tools`, pass it as the turn's `toolAllowlist` (intersected with the session surface, never expanded); when it declares `model`, use it as the submission model only if the selection is valid.
- **Boundaries:** command expansion produces a prompt plus an optional execution envelope; runtime admission still intersects with parent policy.
- **Effect:** commands become a real least-privilege unit instead of a prompt shortcut.
- **Risk / size:** medium / M.
- **Priority:** P2.
- **Acceptance:** a command with `allowed-tools: Read` cannot call Write in that turn; an invalid `model` falls back with a diagnostic rather than failing the turn.
- **Verification:** new CLI/command-center test plus a runtime allowlist test.
- **Competitor evidence needed:** yes — check whether competitors enforce command-level tool scopes.

### C-09. Implement or remove `Skill.args`

- **Problem:** the tool advertises `args` but drops them.
- **Evidence:** `contracts/src/tools/skill.ts:9-14`; `core/src/tool/handlers/skill.ts:38` (destructures only `skill`).
- **Solution:** interpolate `args` into the skill body via a documented token (e.g. `$ARGUMENTS`), or remove `args` from the schema and description. Prefer interpolation because the listing already tells the model to pass args.
- **Boundaries:** Skill tool only; no new permission.
- **Effect:** parameterized skills (`/skill review src/a.ts`) work as advertised.
- **Risk / size:** low / S.
- **Priority:** P2.
- **Acceptance:** loading a skill with `args: "src/a.ts"` produces a body containing the args at the documented token; no args → unchanged body.
- **Verification:** `core/tests/skill-tool.test.ts`.
- **Competitor evidence needed:** no.

### C-10. Add nested instruction-file discovery (or document the limit)

- **Problem:** only the nearest `AGENTS.md` up the tree is loaded; nested package guidance is invisible in a monorepo.
- **Evidence:** `adapters/src/context/index.ts:681-704` returns the first match and stops; `:586-593` merges only user + one workspace source.
- **Solution:** either (a) collect all `AGENTS.md` from cwd to project root with nearest-last precedence and per-file size caps, or (b) keep single-file semantics and document it explicitly in `AGENTS.md` guidance.
- **Boundaries:** adapter only; the builder still renders `sources[]` in order.
- **Effect:** monorepo packages can carry local rules.
- **Risk / size:** medium / S–M (prompt growth; needs aggregate cap).
- **Priority:** P2.
- **Acceptance:** with `AGENTS.md` at repo root and `packages/ui/AGENTS.md`, a session in `packages/ui` sees both, nearest last.
- **Verification:** `adapters/tests/fs-context.test.ts` nested-root case.
- **Competitor evidence needed:** yes — nested instruction files are a known competitor behavior; confirm exact semantics before implementing.

### C-11. Fix `SessionStart` source coverage

- **Problem:** `clear` and `compact` sources are declared but never produced; SessionStart runs once per runtime.
- **Evidence:** `runtime/methods/hooks.ts:18`, `:27-29`; callers at `turn.ts:445` (`startup`), `resume.ts:308` (`resume`).
- **Solution:** either emit `SessionStart` with `source: "compact"` after a successful compaction (when hooks are enabled) and `"clear"` on `/clear`, or remove the unused literals from the contract. Decide explicitly; do not leave a matcher that can never fire.
- **Boundaries:** hook event emission only.
- **Effect:** removes a silent contract lie.
- **Risk / size:** low / S.
- **Priority:** P2.
- **Acceptance:** a SessionStart matcher on `compact` fires after manual compact; or the literals are removed and docs updated.
- **Verification:** `hooks-seven-events.test.ts` case.
- **Competitor evidence needed:** no.

### C-12. Remove or implement dead context builder inputs

- **Problem:** `projectContext`, `agentProfiles`, `embeddedSearchEnabled`, `language` are accepted but unused.
- **Evidence:** `context/types.ts:118-132`; no reads in `context/builder.ts` (grep); `language` only stored (`runtime/methods/config.ts:61-62`).
- **Solution:** delete them from `ContextBuilderConfig` and the call site, or render them (e.g., project type/package manager guidance, language directive). Prefer delete unless a concrete product requirement exists.
- **Boundaries:** context builder API only.
- **Effect:** callers stop assuming behavior that does not exist.
- **Risk / size:** low / S.
- **Priority:** P3.
- **Acceptance:** typecheck passes; no unused config keys; tests updated.
- **Verification:** `pnpm typecheck`, `context-builder.test.ts`.
- **Competitor evidence needed:** no.

### C-13. Make `write_paths` advisory-vs-enforced status explicit

- **Problem:** the work ledger blocks spawn conflicts but does not block Write/Edit; readers may assume `write_paths` is an enforcement boundary.
- **Evidence:** `docs/specs/agent-work-ledger.md:42-46` (explicit non-goal); `runtime-task/registry.ts:2033-2092` (claim gate only); `tool/handlers/agent.ts:194`.
- **Solution:** either (a) add an optional runtime guard that denies Write/Edit outside the claimed paths for child sessions with `writePaths`, or (b) keep advisory semantics but state it in the Agent tool description and spec (the spec already does; the tool description does not).
- **Boundaries:** permission layer must stay the final authority; a ledger guard would be a second check, not a replacement.
- **Effect:** prevents accidental cross-branch edits in parallel swarms.
- **Risk / size:** medium-high / M (false denials for legitimate generated files; must be opt-in).
- **Priority:** P2 (documentation), P3 (enforcement).
- **Acceptance:** tool description states advisory semantics; or opt-in guard denies out-of-scope writes with a clear error.
- **Verification:** `work-ledger.test.ts` extension; `subagent-execution-boundaries.test.ts`.
- **Competitor evidence needed:** yes — check competitor subagent write-scope enforcement.

### C-14. Decide the fate of Dream consolidation

- **Problem:** a complete consolidation pipeline exists but is never scheduled.
- **Evidence:** `memory/dream.ts:95+`; `runtime/helpers/project-memory-dream.ts:54` ("当前产品链路不自动触发 Dream").
- **Solution:** either wire it behind the existing 24 h gate and lock (e.g., on session start or after N sessions), or delete the unused prompt/lock code to reduce surface. Wiring requires the project-transcript isolation decision the comment references.
- **Boundaries:** memory runtime only; no protocol change.
- **Effect:** long-lived memory stops accumulating near-duplicates.
- **Risk / size:** medium / M.
- **Priority:** P3.
- **Acceptance:** with ≥5 prior sessions and 24 h elapsed, a dream run executes once and respects the lock; failure restores the lock mtime.
- **Verification:** `memory-dream.test.ts` already covers prompt/timing/lock; add a scheduling integration test.
- **Competitor evidence needed:** yes — memory consolidation is a competitor differentiator; verify their cadence before claiming parity.

### C-15. Enforce or drop `safeToAutoLoad` / `allowImplicitInvocation`

- **Problem:** skill policy fields are computed and never enforced.
- **Evidence:** `adapters/src/skills/index.ts:310`, `:313`; only CLI display consumes `safeToAutoLoad` (`cli/src/skills-command.ts:160`, `:228`); `allowImplicitInvocation` has no reader.
- **Solution:** either add a gate in the Skill tool (refuse implicit invocation when `allowImplicitInvocation === false`) and use `safeToAutoLoad` for auto-listing, or remove both fields.
- **Boundaries:** skill tool + listing only.
- **Effect:** untrusted/extension-key skills can be restricted from auto-invocation.
- **Risk / size:** low / S.
- **Priority:** P3.
- **Acceptance:** a skill with `allowImplicitInvocation:false` is refused unless the user explicitly named it in the current turn.
- **Verification:** `skill-tool.test.ts`.
- **Competitor evidence needed:** no.

## 7. Open questions, unverified items, failed commands

### 7.1 Open questions

1. **Should `write_paths` be enforced at Write/Edit?** The spec says no; parallel swarms may still collide. Product decision needed (C-13).
2. **What is the intended microcompact default?** Code is opt-in, docs/product map describe it as a capability. Is it shipping-dormant by design or an unwired feature?
3. **Is `features.compact` meant to be user-visible?** It is in the config schema and defaults to true, but has no runtime effect.
4. **Which memory branch is the future?** `default-index` is active; `semantic-recall` is complete but disabled. Is the selector meant to ship behind a setting?
5. **Should memory writes be redacted?** No current mechanism; hooks already redact. Is durable memory considered trusted because the model authored it?
6. **Plugin hook trust:** is "enable plugin = grant shell execution" an accepted permanent boundary or a temporary gap? `docs/plugin-hooks-compat.md` calls it current, not final.
7. **Nested `AGENTS.md`:** is single-file semantics intentional to bound prompt size?
8. **`Skill.args`:** intended feature or schema leftover?
9. **Dream consolidation:** intentionally shelved pending transcript isolation, or forgotten?

### 7.2 Unverified / inferred

- Effective runtime behavior of `features.compact` (inferred from missing mapping; not exercised end-to-end).
- Whether `config.compact` is ever set by a Desktop/Host caller outside this repo's bootstrap (not checked across `packages/desktop`, `packages/services`; out of branch scope).
- Whether plugin hooks in practice force-enable hooks in the Desktop path (observed in bootstrap merge; Desktop may pass `runtimeConfig.hooks` explicitly).
- `[inferred]` Prompt-size impact of nested instruction discovery (C-10) — not measured.
- Real-provider behavior of the selector's JSON schema requirement (only checked code gate at `project-memory-recall.ts:55`).
- OAuth e2e tests were not run (they are in `adapters/tests/mcp-oauth.e2e.test.ts` / `mcp-oauth-cross-process.e2e.test.ts`; network/browser dependent).

### 7.3 Failed / blocked commands

- `vitest run ... --reporter=basic` failed with `ERR_LOAD_URL` because the custom reporter module could not be loaded in this environment. Rerun without the custom reporter succeeded (results above). This is a tooling limitation, not a test failure.
- No other command failed. `rg` produced masked identifiers in several outputs (e.g., printing `n` instead of `safeToAutoLoad`/`registerMcpTools`); exact names were re-verified with `grep -n`. All identifier claims in this document use the grep-verified names.

## 8. Appendix — narrative summary (Russian)

### 8.1 Что проверено и как

Базовая точка зафиксирована до анализа: ветка `dev`, HEAD `d10f0b69f98677091e0428a92839e4a1e01e04ca`, рабочее дерево чистое, `check-workspace-freshness` подтвердил синхронизацию с `origin/dev`. Индекс кода был доступен и не partial, поэтому навигация шла через индекс, а точные утверждения проверялись чтением исходников и `grep -n`.

Основные зоны: сборка контекста (`core/src/context/*`, `adapters/src/context/*`), память (`core/src/memory/*`, `runtime/helpers/project-memory-*`), компакция (`core/src/compact/*`, `runtime/methods/compact*`, `turn-loop*`), история (`agent/message-history.ts`, `session-history-hydrator.ts`), навыки (`adapters/src/skills/*`), плагины (`adapters/src/plugins/*`), MCP (`adapters/src/mcp/*`, `core/src/mcp/*`), хуки (`core/src/hooks/*`, `contracts/src/hooks/*`), субагенты (`core/src/subagent/*`, `runtime-task/*`), кастомные команды (`adapters/src/commands/*`, `cli/src/custom-command-expand.ts`).

Запущены 12 узких тестовых файлов, 470 тестов, все прошли. Полный `pnpm test`, `typecheck`, `lint`, desktop E2E и живые сетевые проверки MCP/OAuth/маркетплейса не запускались — это исследовательская ветка с ограничением на запись.

### 8.2 Главные выводы

**Сильные стороны.** Контекст собирается детерминированно, с разделением stable/dynamic и корректной расстановкой cache-брейкпоинтов. Несколько владельцев состояния разведены честно: история, work ledger, CommandInbox, trust coordinator. Везде, где пишутся файлы, есть проверка containment и атомарная запись. Токен-учёт компакции опирается на провайдерский usage, а не только на оценку. Хуки перепроверяют admission непосредственно перед запуском, а trust-ключ включает digest декларации. Capability-gate субагентов формально запрещает профилю расширять права родителя.

**Пробелы.** Четыре независимых «мёртвых» поверхности: `features.compact` не подключён, microcompact по умолчанию выключен и никем не включается, `summaryReserveTokens`/`thresholdPercentOverride` не читаются, `projectContext`/`agentProfiles`/`embeddedSearchEnabled`/`language` в билдере не используются. Два теста контекста проверяют отсутствие строки, которой больше нет в исходниках. Память пишется без редактирования секретов и без явных инструментов remember/forget; Dream-консолидация реализована, но не запланирована. Плагинные хуки исполняются без отдельного trust-решения и могут переопределить `hooks.enabled:false`. `Skill.args` рекламируется, но отбрасывается. `allowed-tools`/`model` кастомных команд парсятся, но не применяются. `write_paths` — это claim против дублирования работы, а не запрет записи; спецификация это признаёт, а описание инструмента — нет.

**Риски, требующие продуктового решения.** Долговременная память может накапливать секреты и не имеет механизма «забыть» по явному запросу. Доверие к плагинам фактически равно «включил плагин — разрешил shell». Вложенные `AGENTS.md` не читаются, что ограничивает монорепозитории. Семантический recall готов, но выключен одним флагом — это одновременно и возможность, и неопределённость плана.

### 8.3 Что не проверено

Не проверялись реальные сетевые сценарии MCP/OAuth, живой маркетплейс плагинов и навыков, поведение Desktop-хоста за пределами bootstrap, а также полные прогоны typecheck/lint/test. Утверждения о влиянии на размер промпта (вложенные инструкции, hook-контекст) являются выводом из кода, а не измерением. Все такие места помечены `[inferred]` или `[unknown]` в разделах выше.

### 8.4 Рекомендуемый следующий шаг

Приоритет P1: C-01 (подключить `features.compact`), C-02 (решить судьбу microcompact), C-04 (защита секретов в памяти), C-06/C-07 (trust плагинных хуков). Далее P2: C-05 (remember/forget), C-08 (allowed-tools команд), C-09 (Skill.args), C-11 (SessionStart sources), C-13 (документировать write_paths). Перед формулировкой конкурентных утверждений по C-02, C-04, C-05, C-06, C-10, C-13, C-14 необходимо собрать доказательства по конкурентам — в этой ветке они не собирались и не выдумывались.
