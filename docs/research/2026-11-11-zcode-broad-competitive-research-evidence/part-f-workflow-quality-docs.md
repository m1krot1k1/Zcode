# Branch F — Git/PR/workflow, task/session management, CLI UX, monetization/onboarding/docs, CI/tests/quality, persistence

Research-only evidence appendix. No production code, configs, dependencies or lockfiles were modified. The only write is this file (plus `mkdir -p` for its directory).

## 0. Baseline

| Item | Value | Source |
| --- | --- | --- |
| Date (UTC) | 2026-11-11 06:08:04 UTC | `date -u` |
| Branch | `dev` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `d10f0b69f98677091e0428a92839e4a1e01e04ca` — «Выпустить macOS Preview 3.17.102.» | `git rev-parse HEAD`, `git log --oneline -12` |
| Working tree | clean (no porcelain output) | `git status --porcelain=v1` |
| Remote | `https://github.com/m1krot1k1/Zcode.git` | `git remote -v` |
| Freshness | `[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）`, exit 0 | `node scripts/check-workspace-freshness.mjs` |
| Tracked files | 18816 | `git ls-files \| wc -l` |
| Tracked `docs/**/*.md` | 2088 | `git ls-files 'docs/*.md' \| wc -l` |
| Tracked unit-test files (excluding desktop E2E) | 3037 | `git ls-files '*.test.ts' '*.test.tsx'` minus `packages/desktop/test/e2e/` |
| Tracked desktop E2E files | 575 | `git ls-files 'packages/desktop/test/e2e/*.test.ts'` |
| Tracked script tests (`node --test`) | 42 | `git ls-files 'scripts/test/*.test.mjs' 'scripts/*.test.mjs'` |
| CodeIndex | ready, partial=false, generation 1440, 10007 files / 26791 chunks / 278154 symbols | `CodeIndex status` |

Skill `code-review` was loaded successfully from `.agents/skills/code-review/SKILL.md`. Its process (pin a fixed point, diff vs merge-base, parallel Standards/Spec axes) is oriented at reviewing a branch diff against a spec; this task is a read-only repository audit, so the skill's review-discipline (cite standards sources, separate standards from spec conformance, no tooling-enforced noise) was applied as an evidence discipline rather than as a diff review. No fixed point / originating issue was supplied, so no Standards/Spec sub-agent split was executed.

Fact vs inference convention below: every claim carries `path:line` or command output. Statements that are reasoning from those facts are marked **inference**; anything not verified is marked **unknown**.

---

## 1. Coverage matrix (per assigned topic)

Status scale: implemented / partial / weak / absent / NA.

| # | Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- | --- |
| j1 | Git repository status/diff/stage/commit/push service | implemented | `packages/services/src/git/git.ts:32-55`; `packages/services/src/git/gitService.ts:177-357`; `packages/services/src/git/repo/gitCliRepo.ts:1423,1444,1465` | `packages/services/test/gitService.test.ts` (18), `gitCliRepo.test.ts` (11), `gitUntrackedStats.test.ts` (5) | `docs/git/service-foundation.md`, `docs/git/architecture.md`, `docs/git/ui-shell.md` | Local/remote/web unified `IGitService` over real `git` CLI; stage/unstage/discard/commit/push/branch switch/create all present. |
| j2 | Git UI (pane, sources, diff, branch switcher, commit dialog, graph) | implemented | `packages/ui/src/GitPane.tsx:43`; `packages/ui/src/GitActionMenu.tsx:1,79-87`; `packages/ui/src/git-graph/GitGraphPane.tsx`; `packages/ui/src/GitBranchSwitcher.tsx` | `packages/ui/test/gitActionMenu*.test.ts`, `gitBranchSwitcher*.test.ts`, `gitGraphLayout.test.ts`, `useGitAutoRefresh.test.ts`, `v4ConversationStatusPanelGitReview.test.ts` | `docs/git/requirements.md:15-33`, `docs/git/requirements-review.md:42-74`, `docs/git/ui-shell.md` | 4 change sources (unstaged/staged/branch/last-turn), inline diff, directory tree, commit/push dialogs, commit graph. |
| j3 | "last-turn" change source | partial | `packages/ui/src/hooks/useGitRepository.ts:406` («保留空态骨架，待 v4 投影的 per-turn 变更面接入后回填»), `:320-345`, `packages/ui/src/GitPane.tsx:109-114` | no dedicated test for populated last-turn | `docs/git/requirements-review.md:51` (marked «已验收» for read-only reuse) | **Contradiction**: the docs mark «上一轮更改» accepted, but the hook comments and `lastTurnEntry = null` show the live feed was deleted; the pane renders an empty-state skeleton. Status of the doc row is stale. |
| j4 | Checkpoints / file rewind | implemented (UI) + implemented (service) with separate models | `packages/services/src/git/gitCheckpoint.ts:13`; `packages/services/src/git/gitCheckpointService.ts:63,73,86,102`; `packages/services/src/git/repo/gitCheckpointRepo.ts:255,367,387,482`; runtime: `apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoints.ts:98,133`, `file-rewind.ts:1-120` | `packages/services/test/gitCheckpointService.test.ts` (2, real repos); runtime rewind tests under `apps/zcode-cli/packages/core/tests` | `docs/git/checkpoint-service-foundation.md`, `docs/file-summary-safe-rewind.md`, `docs/rewind-button-any-message.md` | Two distinct layers: (a) services `GitCheckpointService` (hidden git refs + manifest JSON), (b) runtime `workspace_checkpoint` session entries driving file rewind/fork. Message-level cascade rewind deliberately removed (`docs/rewind-button-any-message.md:5-7,21-24`). |
| j5 | PR / remote review collaboration | absent | `rg 'createPullRequest|gh pr create'` over repo → only `apps/zcode-cli/packages/superpowers-plugin/skills/finishing-a-development-branch/SKILL.md:128`; `docs/git/requirements.md:33` explicitly non-goal; `docs/git/requirements-review.md:64` | none | `docs/git/requirements.md:33` | No PR creation, no GitHub/GitLab review UI, no inline review comment write-back. Agents are told to use `gh` (`apps/zcode-cli/packages/core/src/tool/handlers/bash-prompt.ts:20`), and read-only `gh pr *` subcommands are allowlisted (`bash-readonly-policy-multiword-gh.ts:52,65,77,97,104`), but that is agent-shell policy, not a product workflow. |
| j6 | Worktree management | weak / absent as product feature | `packages/shared/src/git.ts:131` (`linked-worktree` detection), `packages/services/src/git/repo/gitCliRepo.ts:827-841`, `packages/shared/src/git.ts:34` (`branch-in-other-worktree`), `gitCliHelpers.ts:124-128` | `gitService.test.ts` conflict cases | `docs/git/checkpoint-service-foundation.md:21` («在不引入 worktree 的前提下») | ZCode only *detects* linked worktrees (for migration filtering, fail-open) and reports branch conflicts. No `git worktree add/remove/list` surface. Worktree creation exists only as an agent-facing skill (`apps/zcode-cli/packages/superpowers-plugin/skills/using-git-worktrees/SKILL.md:108`), i.e. model-driven `git` calls, not product state. |
| p1 | Subscription / plan / purchase | implemented | `packages/services/src/coding-plan-subscription/codingPlanSubscription.ts:63-126`; providers `zaiCodingPlanSubscriptionProvider.ts`, `bigmodelCodingPlanSubscriptionProvider.ts`; UI `packages/ui/src/settings/CodingPlanUpgradeDialog.tsx`, `packages/ui/src/CodingPlanUsageRemainingPanel.tsx` | `packages/desktop/test/e2e/coding-plan-*.test.ts` (upgrade sold-out, system-busy, webview-refresh), `coding-plan-team-usage.test.ts`; `packages/services/test/bigmodelUsageQuotaProvider.test.ts` | `docs/coding-plan-purchase-panel-flow.md`, `docs/coding-plan-*` (≈15 files), `docs/start-plan-daily-quota-banner.md` | Start/Individual/Team plans, Stripe card bind/pay, PayPal subscribe, enterprise orders, manual claim, quota reset. Payment orchestration is server-side; client is a thin RPC/WebView surface. |
| p2 | Usage metering / quota / limits | implemented | `packages/services/src/usage-stats/usageStats.ts:21-40`; `packages/services/src/usage-stats/usageStatsConfig.ts:1-7`; CLI tables `model_usage`, `turn_usage`, `tool_usage` in `schema.baseline.sql:101,331,361`; retention `repositories/usage.ts:17-18,335-345` | `apps/zcode-cli/packages/adapters/tests/session-store.test.ts:2958` (prune); `packages/services/test/zcodeMcpQuota.test.ts` | `docs/coding-plan-quota-remaining-api.md`, `docs/usage-stats-app-coding-plan-split.md`, `docs/usage-remaining-refresh-policy.md` | Two independent stores: app/host aggregation (`IUsageStatsService`, 7d/30d ranges) and CLI SQLite usage facts with a hard 30-day prune. |
| p3 | Feature gates | weak (single-purpose) | `packages/desktop/src/main/webRemoteControlManager.ts:171,1491,1888`; `packages/desktop/src/main/index.ts:974` | `packages/desktop/test/webRemoteControlManager*.test.ts` | — | Only a Web-remote-control enable gate exists in Main. No general entitlement/feature-flag service for product capabilities. Plan availability is expressed as provider availability (`packages/services/src/model-provider/codingPlanProviderAvailability.ts`) and quota, not as a gate API. |
| p4 | Telemetry consent | absent (no user-facing toggle found) | `packages/ui/src/lib/appTelemetry.ts:37-43` (`reportAppTelemetryEvent` → `IPlatformService.reportTelemetryEvent`); `packages/shared/src/platform.ts` `reportTelemetryEvent`; no `telemetryEnabled`/consent key found by `rg` across `packages/*/src` | — | — | Telemetry is fire-and-forget through a platform port with sanitization; **no opt-out setting, no consent record, no first-run disclosure** was located. Cross-check with Branch D for telemetry policy; this branch only records the absence of a consent surface. |
| p5 | Onboarding | implemented | `packages/ui/src/onboarding/OnboardingDialog.tsx:174,310-444`; `useOnboardingTrigger.ts:1-40`; `packages/services/src/onboarding/onboardingRecordService.ts`; schema `packages/shared/src/onboardingRecord.ts` | onboarding UI tests under `packages/ui/test` (not enumerated exhaustively) | `docs/onboarding-record-spec.md`, `docs/onboarding-external-agent-import-steps.md`, `docs/onboarding-record-spec.md` §6 | 3-step wizard (occupation / mode / preferences) + AGENTS.md migration step; device-id anchored multi-user record; conservative trigger (unknown → do not disturb). |
| p6 | Documentation system | implemented, large, partly stale | 2088 tracked md; `docs/*.md` = 285; `docs/ui` 163, `docs/electron` 280, `docs/testing` 92, `docs/issues` 62, `docs/specs` 50, `docs/desktop` 45, `docs/architecture` 21, `docs/git` 14 | `scripts/check-doc-links.mjs` (run: OK, 1693 files / 2472 links) | self | No `docs/README.md` index. Many feature docs are per-change design notes, not a curated user manual. Some docs reference a GitLab CI that is not in this checkout (see F-6). |
| p7 | Dev-docs app | implemented (narrow) | `apps/dev-docs/src/App.tsx:56-58,476`; `apps/dev-docs/src/data/productCapabilityMap.ts`; `pnpm dev:docs` | `apps/dev-docs` `test: vitest run` | `docs/product-capability-map*.md`, `docs/feature-boundary-graph-visualization.md` | Internal Vite app rendering capability map + feature-boundary graph. Not a general developer documentation portal. |
| q1 | CI | weak in-repo | `.github/workflows/cross-platform-preview-release.yml` is the only workflow (209 lines, `workflow_dispatch` only, lines 3-7); no `.gitlab-ci.yml`, no `.gitlab/` (verified by `ls` + `git ls-files`) | — | `docs/desktop-ci-cd.md:3` describes `.gitlab-ci.yml` + `.gitlab/ci/*.yml`; `docs/testing/github-actions-billing.md` | The authoritative CI described by docs is **not in this checkout**. The GitHub workflow builds/publishes Preview only and is documented as billing-blocked. **Fact: no PR/push CI gate exists in the repository itself.** Local hooks are the real gate. |
| q2 | Pre-push / local quality gate | implemented, strong | `.husky/pre-push`; `.husky/commit-msg`; `package.json:51` `verify:pre-push` (14 chained checks) | each chained script has tests (e.g. `scripts/test/knip-baseline.test.mjs`, `architecture-governance.test.mjs`, `sqlite-schema-contract.test.mjs`) | `docs/testing/pre-push-hook.md`, `docs/ci/affected-unit-test-baseline.md` | Chain: prism10 profile+gate → lint → tracked-privacy → db schema → architecture tests → `architecture:check --changed` → affected UT → self-improve-pr → delegation benchmark → knip baseline → preview-release tests → knip → brainstorming companion. Doc at `pre-push-hook.md:9` lists only 4 of 14 steps (stale). |
| q3 | Typecheck / lint / fmt | implemented; fmt not gated | `package.json:69` (typecheck, run: exit 0), `:81` (lint, run: 0 errors / 86 warnings), `:72` (`fmt:check`) | — | — | `pnpm typecheck` and `pnpm lint` pass. `pnpm fmt:check` **fails on the clean baseline**: 136 files, 30 outside `.agents/skills`, including `packages/ui/src/i18n/locales/en-US.ts`, `packages/services/src/mcp-sync/mcpSyncService.ts`. `fmt:check` is **not** part of `verify:pre-push`. |
| q4 | Architecture governance | implemented, strong | `scripts/architecture/architecture-check.mjs:19-104`; `architecture-policy.yaml` (107 modules, 51 managed); `.architecture-baseline.json` = `{"version":1,"violations":[]}`; run `check --changed` → 0 violations, exit 0 | `scripts/test/architecture-governance.test.mjs`, `architecture-governance-review.test.mjs`, `architecture-upstream-admission.test.mjs`, `source-size-policy.test.mjs` | `docs/architecture/architecture-governance.md` | Ratchet with empty baseline; new-file enforcement; upstream admission by commit SHA; `context`/`adopt`/`baseline:update` commands. |
| q5 | Knip / dep:refs | implemented | `scripts/knip-baseline.mjs:3-12,70-75`; `scripts/knip-baseline.json` = 3174 issues; `scripts/dep-refs.mjs:222,265-277` | `scripts/test/knip-baseline.test.mjs` | `docs/knip/**` | Knip is wrapped in a baseline gate (fails only on *new* issues); `dep:refs` is static-analysis only and states it cannot see dynamic imports (`dep-refs.mjs:222`). |
| q6 | Test suites (unit / integration / E2E) | implemented, very large | `vitest.config.ts:108-148` (two projects: `unit` threads/4, `fork-isolated` forks/1); `packages/desktop/package.json` `test:e2e*` | 3037 unit files, 575 E2E files, 42 script tests | `docs/testing/**` (92 files), `docs/testing/unit-test-quality.md` | Unit run excludes desktop E2E by explicit glob; heavy process/git suites are fork-isolated with documented reasons. Coverage has no thresholds (`vitest.config.ts:143-148`). |
| t1 | Storage retention (cross-check with D) | implemented for usage; no session-content retention | `repositories/usage.ts:17-18,335-345` (30 days, model/turn/tool); session rows are soft-deleted only (`repositories/sessions.ts:128-136`, `listSessions` filters `time_deleted is null` at `:151`); migration backups `BACKUPS_TO_KEEP = 2` (`packages/shared/src/sqlite-migrations/backup.ts:9,134`) | `session-store.test.ts:2958` | `docs/settings-storage-management.md` | Session content is never aged out; only explicit delete (soft) + archive cleanup. Usage facts age out at 30 days. Model-IO diagnostics retention is a separate setting (`docs/model-io-full-retention-setting.md`). Telemetry retention/policy deliberately not analyzed here (Branch D). |

---

## 2. Detailed findings

### F-1 Git is a full lightweight review panel, not a source-control IDE (implemented, intentional)

`IGitService` (`packages/services/src/git/git.ts:32-55`) exposes: repository summary, workspace repository info, local branches, commit graph, switch branch, create-and-switch, changes, ignored paths, diff, branch comparison, stage, unstage, discard, generate commit message, commit, push, identity, and a batched `refresh`.

The batched `refresh` is a deliberate performance boundary, documented inline at `packages/services/src/git/gitService.ts:340-346`: three UI RPCs used to each re-run `git status`; now one status snapshot yields summary + unstaged + staged + branch comparison. This is a real strength.

Command budget is explicit in `packages/services/src/git/config.ts:3-16`: discovery 3 s, command 15 s, **push 10 min**, diff 20 s, default output 512 KiB, **push output 8 MiB**, diff bytes 1 MiB, untracked stat 1 MiB / 64 KiB chunks / 4 workers. The push exceptions are commented with their reason (repo pre-push hooks). This is well-reasoned and worth preserving.

Diff degradation is modelled as data, not exceptions: `GitDiffAvailability = "patch" | "binary" | "truncated" | "unavailable"` (`packages/shared/src/git.ts:22`), produced at `gitCliHelpers.ts:540-551` (binary / oversize untracked) and `:600-612` (timeout / output truncation). UI gets a typed reason instead of an error string.

Boundaries: no `fetch`, `pull`, `stash`, `merge`, `rebase`, `reset --hard` product commands (`rg` over `packages/services/src/git` finds only `reset --quiet HEAD` as internal cleanup at `gitCliRepo.ts:1606`). `docs/git/requirements.md:29-33` lists these as non-goals. Note that `docs/git/requirements.md:32` also lists stage/unstage/discard and the history graph as non-goals, while `gitCliRepo.ts:1423,1444,1465` and `getCommitGraph` (`git.ts:36`) implement them — **the requirements doc is out of date relative to code** (inference: docs predate feature growth; no superseding doc found).

### F-2 «上一轮更改» (last-turn) is a hollow shell — doc says accepted (gap)

`packages/ui/src/hooks/useGitRepository.ts:406` states plainly that the per-turn summary write path was deleted with the old ChatView stream subscription, the store no longer holds that derived state, and the `"last-turn"` dataset keeps an empty skeleton pending a v4 projection. `:411-412` hard-codes `lastFileChangeEntry = null` and `lastSummaryEntry = null`. `GitPane.tsx:109-114` renders a dedicated empty-state for that source.

`docs/git/requirements-review.md:51` still records this row as «已完成 / 已验收» with «优先复用当前 task 的 per-turn 文件快照和摘要». That is a factual contradiction with the code, not a judgment call. This is the clearest stale-acceptance defect found in this branch.

### F-3 Checkpoints exist twice, with different ownership and no GC

Layer A — services: `IGitCheckpointService` (`packages/services/src/git/gitCheckpoint.ts:13`) with `createCheckpoint`, `diffCheckpoints`, `restoreBetweenCheckpoints`, `deleteCheckpoint`. Storage is a per-workspace JSON manifest under the app config dir plus a hidden git ref (`docs/git/checkpoint-service-foundation.md:163-189`), with atomic write chaining (`gitCheckpointStore.ts:33-60`). Restore is conflict-checked (`content-mismatch`, `missing-in-worktree`, `unexpected-file-in-worktree`, `type-mismatch` at `packages/shared/src/git.ts:260-264`) and deliberately does not touch the real index (`gitCheckpointRepo.ts:426`).

Layer B — runtime: session entries typed `runtime/workspace_checkpoint` (`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts:817`) drive `previewWorkspaceFileRewind` / `applyWorkspaceFileRewind` (`apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts:1-120`), listing and fork (`workspace-checkpoints.ts:98,133`). The safety model is all-or-nothing: `applyWorkspaceFileRewind` returns `applied:false` if any file is unsafe (`file-rewind.ts:96-104`), and the combined edit+rewind path commits the branch cut only after all file writes succeed (`commitAfterApply` doc comment at `file-rewind.ts:74-76`).

Gap: `docs/git/checkpoint-service-foundation.md:150-155` explicitly records that there is **no checkpoint list API, no GC API, no rename/annotate** at the services layer. The runtime layer does list checkpoints, but retention/GC of the hidden refs and manifests is not implemented in either layer (no `gc`/`prune` symbol found in `gitCheckpointService.ts` / `workspace-checkpoints.ts`). Long-lived workspaces accumulate refs and manifest files indefinitely — **inference** from absence of GC code, not observed growth.

### F-4 No PR workflow; the PR story is delegated to the agent's shell

Product code has no PR creation. The only `gh pr create` string is inside a bundled skill (`superpowers-plugin/skills/finishing-a-development-branch/SKILL.md:128`), i.e. instructions for the model to run a shell command. Read-only `gh pr checks|diff|list|status|view` are allowlisted for the read-only Bash policy (`bash-readonly-policy-multiword-gh.ts:52-104`), while `gh pr create/merge` are not — so **the agent can read PR state but a write is subject to the normal permission path**, not a product-level PR object.

Consequence: there is no PR status surface in ZCode, no review-comment ingestion, no "create PR from commit dialog". Commit dialog actions are exactly `commit | commitAndPush | push` (`packages/ui/src/GitActionMenu.tsx:79`). Compare-and-contrast against competitors is **not asserted here** — competitor evidence is required (see §5 marker).

### F-5 Commit-message generation is localized, scoped and validated (strength)

`packages/services/src/git/gitCommitMessageGenerator.ts:12-21` caps the prompt: 20 files, 8 diff files, 12 000 diff chars, 2 000 per file, 12 conversation messages, 4 000 context chars, 600 per message, 1 000 output chars, and enforces `CONVENTIONAL_COMMIT_RE` (`:20-21`, checked at `:251`). Language is normalized from the resolved UI locale with English fallback (`docs/git/commit-message-language.md:9-20`). File scope is constrained to the current session's changed files (`docs/git/commit-message-language.md:22-28`; `packages/services/src/git/commitMessageFileScope.ts`). This is a good example of "model output must satisfy a machine-checkable contract".

Boundary: the generator requires a current model selection (`GitCommitMessageCurrentModelProvider.readCurrentModel` at `:24-27`); with no model configured it throws `GitCommitMessageGenerationError("未读取到当前模型。", "model-unavailable")` (`:124-132`). No offline/heuristic fallback exists.

### F-6 CI described by docs is absent from the checkout; the one workflow is manual and billing-blocked

`.github/workflows/cross-platform-preview-release.yml` is 209 lines, triggered only by `workflow_dispatch` with a required `release_tag` input (`:3-12`), with an explicit comment that macOS Preview releases are produced locally while GitHub Actions billing is unavailable (`:3-5`). Jobs: `desktop` (macOS arm64 / Windows x64 / Linux x64 matrix, `:25-46`), `cli` (`:99-120`), `publish` (`:158-161`). Permissions are `contents: read` (`:16-17`); concurrency cancels nothing (`:19-22`).

Meanwhile `docs/desktop-ci-cd.md:3-15` describes `.gitlab-ci.yml` plus `.gitlab/ci/00-workflow.yml` … `50-release.yml`, stages `approve → validate → upload → preload → publish → release-notify`. Neither `.gitlab-ci.yml` nor `.gitlab/` exists (`ls` → No such file; `git ls-files | rg '^\.gitlab'` → empty). 15 docs reference the GitLab pipeline. `docs/testing/github-actions-billing.md` documents the Actions failure as an account billing condition, not a repo failure.

**Fact:** this repository, as checked out, has no automated push/PR quality pipeline. **Inference:** the real CI lives in a downstream/internal mirror, and this export intentionally ships only the manual Preview workflow. Either way, docs and code diverge and a reader cannot reproduce CI from this tree.

### F-7 Local gate is the real quality system, and it is unusually thorough

`.husky/pre-push` captures push refs, unsets Git local env vars (with a bugfix comment about temp-repo tests renaming branches), and runs `pnpm run verify:pre-push`. `package.json:51` chains 14 steps. Notable properties:

- Privacy scan runs over index + `HEAD` + push-range blobs, so "secret added then deleted" is still caught (`docs/testing/pre-push-hook.md:34-45`), and reports `file:line:type` without echoing the value.
- `db:schema:check` runs the contract test **and** `scripts/check-sqlite-schema.ts`, which regenerates schemas from the real migration sets and asserts additive-only change against `git show <base>:<baseline>` (`scripts/check-sqlite-schema.ts:20-24,46-60`). This is a strong, rarely-seen guard.
- `architecture:check --changed` gates new violations; baseline is empty.
- `test:unit:affected --scope push` uses Vitest's own selection and **skips** (exit 0) when Vitest selects the entire root suite (`scripts/run-affected-unit-tests.mjs:97-101`), by design, to avoid blocking push.

Documentation drift: `docs/testing/pre-push-hook.md:9` says the chain runs "lint, tracked-file privacy, architecture check, affected unit tests" — 4 of 14 steps. A reader cannot learn the real gate from the hook doc.

`.husky/commit-msg` enforces a Cyrillic subject with exemptions for `Merge*`, `Revert*`, `fixup!*`, `squash!*`, `Release*`. This is a repository policy, not a product feature; it is relevant to any contributor automation and to how the git log reads (`git log --oneline` shows Russian subjects).

### F-8 `fmt:check` fails on the clean baseline and is not gated

`pnpm fmt:check` → `Format issues found in above 136 files`, exit 1. Of these, 30 are outside `.agents/skills/` (the skills dir is only partially ignored: `.oxfmtrc.json` ignores `ai-elements` and `react-best-practices`, not the rest). Affected production paths include `packages/ui/src/i18n/locales/en-US.ts`, `packages/ui/src/i18n/locales/zh-CN.ts`, `packages/services/src/mcp-sync/mcpSyncService.ts`, `packages/shared/src/mcp.ts`, `packages/ui/src/ErrorBoundary.tsx`.

`fmt:check` is **not** in `verify:pre-push` (verified by string check of the script). So formatting is advisory and currently red. AGENTS.md lists `pnpm fmt:check` as a command but does not claim it is gated.

### F-9 Session store: 27 tables, 27 migrations, strict additive contract, no content retention

Baseline schema (`apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql`, 647 lines) declares 27 tables: `dwf_actor`, `dwf_event`, `dwf_node`, `dwf_run`, `input_history`, `local_setting`, `message`, `model_usage`, `opencode_agent_run`, `part`, `permission`, `schema_migration`, `session`, `session_entry`, `session_input`, `session_target`, `session_task_link`, `swarm_node_attempt`, `swarm_run`, `todo`, `tool_usage`, `turn_usage`, `workflow_activity`, `workflow_definition`, `workflow_event`, `workflow_run`, `zcode_database_identity`.

Migration ledger `migrations.ts` (1202 lines) registers ids `0001_base_session_store` … `0028_swarm_run_journal`, 27 entries, with `0024_session_database_identity` sourced from `packages/shared/src/sqlite-migrations/legacy.ts:60-62` (comment explains the 0023/0024 renumbering). `0023_session_soft_delete_outcome` adds `time_deleted` and `last_outcome` (`migrations.ts:1079-1098`).

Startup is hardened: WAL enforcement, `BEGIN IMMEDIATE`, checksum verification, `waiting_for_lock` progress phases, exponential backoff on `SQLITE_BUSY`, and a 1-hour default migration wait (`migration-runner.ts:32-58,64-124`). Progress frames are emitted to the Host with a sequence and database id (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts:9-45`). Migration backups keep 2 copies and skip empty/new DBs (`packages/shared/src/sqlite-migrations/backup.ts:9,18-22`).

Data lifecycle: `session` rows are soft-deleted (`repositories/sessions.ts:128-136`) and all listing filters `time_deleted is null` (`:151`); messages/parts are preserved. Only usage tables have time-based retention: `USAGE_RETENTION_DAYS = 30` (`repositories/usage.ts:17`) applied in `pruneUsage` over `model_usage`, `turn_usage`, `tool_usage` (`:335-345`), called after each usage write (`:163,256,332`). There is **no** retention for messages, parts, checkpoints, or model-IO files in this layer. `docs/settings-storage-management.md` documents a storage-usage UI that explicitly reports two data roots and does not unify them.

### F-10 Task/session UX: list, search, resume, archive — implemented; `last-turn` and cross-device are the soft spots

Task list contract: `ZCodeTaskListQuery` supports `kind: pinned|archived|timeline|active`, multi-workspace scopes, `sortBy`, `search`, `limit` (`packages/services/src/session/zcodeTaskListTypes.ts:3-23`), returning `searchSnippet`/`searchSnippets` (`:25-28`). Search is `LIKE` on lowercased title-or-override and `searchable_text` (`packages/services/src/session/taskIndexRepo.ts:1338`), with up to 4 snippets (`:102`) built case-insensitively (`:232-275`). `searchable_text` is capped at 200 000 chars when built from imported Claude sessions (`packages/services/src/session/claude-native/persistImportedClaudeTask.ts:10,12-20`), matching `docs/task-search.md:9`.

UI: `TaskList.tsx` (524 lines), `TaskSearchDialog.tsx` (417 lines, 9-result cap at `:32`, 3 collapsed snippets at `:33`), `TaskFindDialog.tsx` (389 lines) for in-conversation find. `docs/task-search.md` documents Cmd/Ctrl+K, and `docs/v4-session-find-highlight.md:7-14` documents that in-conversation find covers only `userInput.text` and `assistantText.text`, no regex, and caps backfill at 1200 projection rows.

Resume: CLI `--resume <sessionId>` / `-c, --continue` (`apps/zcode-cli/packages/i18n/src/locales/en-US.ts:47-51`), implementation `apps/zcode-cli/packages/cli/src/resume.ts:8-29` (`--continue` resolves the latest session for cwd, throws a plain `Error` when none). TUI `/resume [sessionId]` opens a filterable selection with `Enter resumes` (`apps/zcode-cli/packages/cli/src/command-center/selections.ts:12-31`), capped at 50 checkpoints for `/fork` and `/rewind` (`command-center/create.ts:249,263`).

Archive deletion is guarded against partial failure: `collectArchivedTaskDeletion` reads the full archived set per workspace (never the UI-filtered view), and reports `unavailableWorkspaces` instead of silently deleting a subset (`packages/ui/src/lib/archivedTaskDeletion.ts:1-50`).

Gap: task list/search is per-workspace and index-backed; there is no global cross-device task search surface in this branch's evidence, and `docs/task/task-sqlite-index.md:3` marks the old index doc as historical with the runtime model replaced by the virtual-project design.

### F-11 CLI UX: small, honest command surface; onboarding absent in TUI

Commands are exactly `app-server`, `commands`, `doctor`, `login`, `logout`, `plugins`, `skills`, `tui`, `version` (`apps/zcode-cli/packages/i18n/src/locales/en-US.ts:18-27`; dispatch `apps/zcode-cli/packages/cli/src/run.ts:601-649`), plus `agent-server` as an alias handled in the same switch (`run.ts:608-609`). Unknown commands print help to stderr and exit 1 (`run.ts:644-648`).

Flags (`apps/zcode-cli/packages/cli/src/arguments.ts:4-80`): `--help/-h`, `--json`, `--output-format`, `--no-color`, `--no-browser`, `--browser-use`, `--browser-executable`, `-p/--prompt`, `--memory-bench`, `--attach` (repeatable), `--cwd`, `--locale`, `--resume`, `--target`, `--target-replace`, `-c/--continue`, `-f/--force`, `--toolsearch-mode`, `--force-mcs`, `--mode`, `--verbose`, `-v/--version`, `--prepare-storage`, `--stdio`.

Slash commands are a coherent set (`command-center/slash-commands.ts:53-237`): `compact, expert, effort, dwf, fork, help, init, workflow, login, logout, locale, resume, new, rewind, mode, mcp, plugins, model, goal, skill`. Help text documents them (`en-US.ts:57-70`).

Auth: `login [zai|bigmodel]` with browser OAuth and `--no-browser` URL printing (`login-command.ts:7-33`), `logout` removing shared credentials (`:86-106`), TUI variants in `tui-auth.ts:10,35,61,74`. No CLI-side plan/subscription command was found — monetization is desktop-UI-only.

Onboarding: none in TUI/CLI (`rg 'onboarding|firstRun|welcome'` over `apps/zcode-cli/packages/tui/src` and `packages/cli/src` → no matches). Onboarding is a desktop/web wizard only.

### F-12 Monetization: server-driven catalog, client-side surfaces, no client-side entitlement engine

`ICodingPlanSubscriptionService` (`coding-plan-subscription.ts:63-126`) is a large server proxy: static products, start-plan preview, manual claim, off-peak config, dynamic-workflow config, model context budget strategy, billing discount, request verification, force-update config, product info, preview/sign, payment check, pending orders, Stripe cards (bind/unbind/pay), PayPal (support/setup/subscribe), enterprise pricing/balance/orders/cancel/status. Payment method selection is server-authoritative; the client never computes price.

UI surfaces: `CodingPlanUpgradeDialog.tsx`, `CodingPlanEmbeddedWebviewDialog.tsx` (WebView-based checkout), `CodingPlanUsageRemainingPanel.tsx`, `StartPlanQuotaStatusCard.tsx`, quota-reset components (`packages/ui/src/components/coding-plan-quota-reset/*`), sidebar badge helpers (`WorkspaceSidebarFooterPlanBadgeHelpers.ts`).

Quota policy detail worth preserving: the low-quota banner computes per-bucket `remaining_units / total_units`, fires only in `(0, 10%]`, dedupes by `bucket_id + period_start + period_end`, stores the dedupe in localStorage without balances or tokens, and uses `snapshot.serverTime` rather than device time (`docs/start-plan-daily-quota-banner.md:5-13,17-21`). This is a careful, testable spec.

Gap: there is no client-side feature-gate layer — capability availability is expressed as provider availability plus quota, so "plan X unlocks feature Y" would today be encoded as a provider/model fact or a server error, not as an explicit gate. **Inference** from the absence of a gate API (§p3).

### F-13 Onboarding: three steps plus a migration step, conservative triggering

Wizard steps: occupation → interface mode → preferences, plus an AGENTS.md migration step (`OnboardingDialog.tsx:442-444`, `wizardStep` handling at `:310-340`). Trigger logic is deliberately failure-safe: if the record service errors or times out, `needsOnboarding` resolves `false` rather than bothering the user (`useOnboardingTrigger.ts:8-21`), with a 3-second release budget shared across re-evaluation rounds (`:24-32`). Record schema is device-id anchored with multiple user ids and a `pending|uploaded` upload state (`docs/onboarding-record-spec.md:16-40`).

Telemetry from onboarding is exposure-scoped and deduped (`useOnboardingTelemetry.ts:1-60`), reporting through the same `reportTelemetryEvent` platform port.

Gap: onboarding has no telemetry consent step and no privacy disclosure step in the wizard steps enumerated above (occupation/mode/preferences/migration only).

### F-14 Docs: huge, link-clean, but no entry index and visible drift

- 2088 tracked markdown files; `docs/*.md` = 285; largest areas `docs/electron` 280, `docs/ui` 163, `docs/testing` 92, `docs/issues` 62, `docs/specs` 50, `docs/desktop` 45, `docs/architecture` 21, `docs/git` 14, `docs/task` 5, `docs/ci` 1.
- `scripts/check-doc-links.mjs` passes: 1693 files / 2472 relative links valid. `verify:links` exists (`package.json:52`) but is not in `verify:pre-push`.
- No `docs/README.md` or `docs/index.md` (verified by `ls`); the only navigation artifacts are `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, `README.md`/`README.en.md` and the dev-docs capability map.
- Drift instances verified: GitLab CI references in 15 docs with no `.gitlab*` in tree (F-6); `docs/git/requirements.md:32` non-goals contradicted by stage/discard/graph code (F-1); `docs/git/requirements-review.md:51` last-turn acceptance contradicted by code (F-2); `docs/testing/pre-push-hook.md:9` lists 4 of 14 gate steps (F-7).
- `docs/task/task-sqlite-index.md:3` self-marks as historical, which is good hygiene; not all docs do this.

Checked with no significant gap: `docs/architecture/architecture-governance.md` matches `architecture-policy.yaml` + `scripts/architecture/*` behavior (107 modules / 51 managed / empty baseline / `context|adopt|baseline:update`); `docs/testing/unit-test-quality.md` matches `vitest.config.ts` project split and the fork-isolation comments; `docs/testing/affected-unit-test-baseline.md` matches `scripts/affected-unit-tests/scope.mjs:21-22` and the skip-on-full-selection behavior.

### F-15 Areas checked with no significant gap

- Git command timeout/output budgets and their documented reasons (`config.ts:3-16`).
- Diff availability typing end-to-end (`shared/src/git.ts:22` → `gitCliHelpers.ts:540-612` → `GitPane` empty/degraded copy).
- Git branch mutation issue taxonomy (`shared/src/git.ts:26-35`) covers conflicts, in-progress operations, and other-worktree branches.
- Untracked-file stat memory bound (1 MiB/file, 4 workers, 64 KiB chunks) with a real regression story (`docs/git/untracked-file-stat-budget.md:1-25`).
- SQLite additive-schema contract (8 assertions in `scripts/test/sqlite-schema-contract.test.mjs`, run green) including CHECK/UNIQUE/index/collation preservation.
- Migration checksum freezing and re-entrancy for restore (`migrations.ts:1-12` comment block; `frozen-migration-startup.test.ts` 3 cases).
- Architecture ratchet with empty baseline and upstream admission validated by commit ancestry (`docs/architecture/architecture-governance.md` «指定上游的存量准入»).
- Knip baseline gate semantics (new-only failures) (`scripts/knip-baseline.mjs:3-12`).
- Task archive deletion all-or-per-workspace semantics (`archivedTaskDeletion.ts:1-50`).
- Onboarding failure-safe triggering (`useOnboardingTrigger.ts:8-32`).

---

## 3. Inventory tables

### 3.1 Workflows (CI)

| Path | Trigger | Jobs | Notes |
| --- | --- | --- | --- |
| `.github/workflows/cross-platform-preview-release.yml` (209 lines) | `workflow_dispatch` + required `release_tag` (`:3-12`) | `desktop` matrix macos-15 / windows-2025 / ubuntu-24.04 (`:25-46`); `cli` (`:99-120`); `publish` ubuntu-24.04 (`:158-161`) | `permissions: contents: read` (`:16-17`); concurrency no-cancel (`:19-22`); comment says local macOS Preview releases because Actions billing is unavailable (`:3-5`). Only workflow in tree. |
| `.gitlab-ci.yml` + `.gitlab/ci/*.yml` | — | — | **Absent from checkout**; described by `docs/desktop-ci-cd.md:3-15`. |

### 3.2 Root scripts (`package.json`)

| Group | Scripts |
| --- | --- |
| Dev | `dev:web`, `dev:docs`, `dev:desktop`, `dev:desktop:test`, `dev:desktop:prod`, `dev:desktop:bytecode`, `dev:desktop:remote-prod`, `dev:web-remote-control`, `dev:web-share:test|mock`, `dev:server`, `dev:official-mcp`, `dev:e2e-report` |
| Build | `build`, `build:desktop-agent:bytecode`, `build:docs`, `build:web-share`, `build:zcode`, `build:bootstrap`, `build:sea`, `build:sea:all`, `build:native-search`, `pack:native-search`, `bundle:desktop`, `prepare`, `prepare:desktop-runtime`, `prepare:remote-assets[:linux]`, `bootstrap`, `bootstrap:with-remote` |
| Quality | `typecheck`, `lint`, `lint:fix`, `fmt`, `fmt:check`, `knip`, `knip:update-baseline`, `dep:graph`, `dep:refs`, `architecture:check|report|context|adopt|baseline:update`, `test:architecture`, `db:schema:check`, `db:schema:update`, `verify:pre-push`, `verify:links`, `verify:privacy`, `audit:agent-remnants`, `audit:conversation-session-coverage|complete`, `eval:gate` |
| Tests | `test` (= `test:unit`), `test:unit`, `test:unit:affected`, `test:coverage`, `test:e2e`, `test:e2e:all:coverage`, `test:e2e:windows:sharded`, `test:e2e:container[:conversation|:plugins]`, `test:brainstorming-companion`, `test:self-improve-pr`, `test:prism10-experiment-gate`, `test:knip-baseline`, `test:cross-platform-preview-release`, `test:delegation-routing-benchmark`, `test:release:macos`, `test:dev-desktop:endpoints`, `test:docker:web-app-gateway`, `test:native-search:e2e`, `test:sea-runtime-tools:e2e` |
| Prism/eval | `prism10:sync`, `prism10:check`, `prism10:experiment-gate`, `self-improve:evaluate` |
| Release | `release` (release-it), `release:macos`, `release:macos:preview[:resume]`, `release:cli[:dry]`, `doctor:macos-release` |
| Ops | `clean`, `count-lines`, `skills:sync`, `ci:assert-node`, `ci:ensure-native-search-deps` |

### 3.3 Test suites

| Suite | Entry | Config | Volume |
| --- | --- | --- | --- |
| Root unit | `pnpm test:unit` → `vitest run --exclude "packages/desktop/test/e2e/**/*.test.ts"` (`package.json:38`) | `vitest.config.ts:108-141`, two projects (`unit` threads/4; `fork-isolated` forks/1, `fileParallelism:false`) | 3037 tracked unit files |
| Affected | `pnpm test:unit:affected [--scope worktree|push]` (`package.json:39`) | `scripts/run-affected-unit-tests.mjs`, `scripts/affected-unit-tests/scope.mjs` | exit codes 0/1/2 documented at `run-affected-unit-tests.mjs:50` |
| Desktop E2E (WDIO) | `pnpm test:e2e` → `@zcode/desktop test:e2e` (Windows sharding) | `packages/desktop/wdio.conf.ts` | 575 tracked E2E files; 442 under `conversation-session`, 377 under `manual-review`, 1 under `git/` |
| E2E coverage/promotion | `test:e2e:all:coverage`, `e2e:promote`, `e2e:docker:admit[:plugins]`, `e2e:fixture:check` | `packages/desktop/scripts/*` | — |
| Container E2E | `test:e2e:container[:conversation|:plugins]` | `scripts/test-desktop-e2e-container.sh`, `Dockerfile.desktop-e2e` | — |
| Script tests | `node --test scripts/test/*.test.mjs` (subset chained in `verify:pre-push`) | — | 42 tracked files |
| Go/Python/Kotlin tests | mentioned by `docs/testing/unit-test-quality.md` («7 个 Go、Python、Kotlin 测试，共 2270 行») | — | not verified by running |

### 3.4 Docs areas (tracked `.md`)

| Area | Files | Area | Files |
| --- | --- | --- | --- |
| `docs/electron` | 280 | `docs/specs` | 50 |
| `docs/ui` | 163 | `docs/desktop` | 45 |
| `docs/testing` | 92 | `docs/architecture` | 21 |
| `docs/issues` | 62 | `docs/archive` | 19 |
| `docs/plans` | 17 | `docs/git` | 14 |
| `docs/design` | 9 | `docs/remote` | 8 |
| `docs/analysis` | 7 | `docs/plugins` | 6 |
| `docs/task` | 5 | `docs/adr` | 4 |
| `docs/agents` | 3 | `docs/security` | 2 |
| `docs/ci` | 1 | top-level `docs/*.md` | 285 |
| **Total tracked** | **2088** | `specs/` (separate root dir) | 1 |

### 3.5 Session DB tables (`apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql`)

| Table | Purpose (from columns/usage) | Line |
| --- | --- | --- |
| `session` | session identity, project/workspace, title, permission, summary, soft delete (`time_deleted`), `last_outcome` | 191 |
| `message` | message rows | 93 |
| `part` | message parts | 173 |
| `session_entry` | typed JSON entries (e.g. `runtime/workspace_checkpoint`, `runtime/model_selection`) | 215 |
| `session_input` | admission ledger (`startNow|guide|queue`, status incl. `failed`) | 224 |
| `session_target` | goal/target state | 239 |
| `session_task_link` | task↔session link | 251 |
| `input_history` | prompt history | 72 |
| `permission` | permission facts | 182 |
| `todo` | per-session todo list (`session_id, position` PK) | 320 |
| `local_setting` | namespaced local settings | 81 |
| `model_usage` / `turn_usage` / `tool_usage` | usage facts, 30-day retention | 101 / 361 / 331 |
| `opencode_agent_run` | OpenCode CLI run outbox | 144 |
| `swarm_run`, `swarm_node_attempt` | swarm journal | 296, 271 |
| `dwf_run`, `dwf_node`, `dwf_event`, `dwf_actor` | dynamic-workflow journal | 47, 25, 15, 1 |
| `workflow_definition`, `workflow_run`, `workflow_event`, `workflow_activity` | script workflows | 424, 450, 438, 391 |
| `schema_migration` | migration ledger (id, checksum, app_version, time_applied) | 189 |
| `zcode_database_identity` | database identity | 480 |

Migrations: 27 registered ids `0001`…`0028` (`migrations.ts`), plus separate `tasks-index.sqlite` ledger `0001_adopt_task_schema`…`0006_task_group_admissions` (`packages/services/src/session/tasksDatabase/migrations.ts:64-121`).

---

## 4. Strengths worth preserving

1. **One Git service, three transports.** `IGitService` is a normal service channel, not `IPlatformService`, so local desktop, remote host and web all execute Git in the same place with the same DTOs (`docs/git/architecture.md:33-70`). This avoids the classic "Git runs in the renderer on one platform only" trap.
2. **Batched `refresh` to stop `git status` amplification** (`gitService.ts:340-346`). Directly addresses agent-driven file-burst rendering stalls.
3. **Degradation as typed data.** `GitDiffAvailability` plus per-cause summaries means the UI never has to parse error strings, and "binary/truncated/unavailable" are testable states.
4. **Explicit, commented command budgets**, with separate push timeout/output because repo hooks can run a full test suite (`config.ts:3-16`).
5. **Untracked-stat memory contract** (1 MiB/file, 4 workers, 64 KiB chunks, NUL-based binary detection) with a real 2.67 GiB heap incident as the driver (`docs/git/untracked-file-stat-budget.md`).
6. **All-or-nothing file rewind with re-validation** (`file-rewind.ts:96-104`; `docs/file-summary-safe-rewind.md:12-20`). Refuses to write a partial set when any file drifted.
7. **Additive-only SQLite schema contract enforced against `git show <base>:<baseline>`** (`scripts/check-sqlite-schema.ts:46-60`) plus CHECK/UNIQUE/index preservation tests. This is the single strongest quality mechanism in this branch.
8. **Migration checksum freezing + re-entrant build migrations for restore** (`migrations.ts:1-12`).
9. **Architecture ratchet with an empty baseline** and explicit upstream admission by commit ancestry — new violations block, legacy debt is not re-litigated per branch (`docs/architecture/architecture-governance.md`).
10. **Knip as a new-issues-only gate** instead of a permanently-red linter (`scripts/knip-baseline.mjs:3-12`).
11. **Privacy scan over index + HEAD + push-range blobs, output without the secret value** (`docs/testing/pre-push-hook.md:34-45`).
12. **Affected-test selection that refuses to masquerade as a full run** — it skips and says so, rather than blocking push on an accidental full-suite selection (`run-affected-unit-tests.mjs:97-101`).
13. **Commit-message generation with hard prompt budgets and a Conventional-Commit validator** (`gitCommitMessageGenerator.ts:12-21,251`).
14. **Quota banner semantics** keyed by bucket+period with server-time and no balance persistence (`docs/start-plan-daily-quota-banner.md`).
15. **Failure-safe onboarding trigger** — unknown state means "do not disturb" (`useOnboardingTrigger.ts:8-21`).
16. **Doc-link gate that actually passes** over 2472 links (`scripts/check-doc-links.mjs`, run green).

---

## 5. Candidate recommendations

Each item: problem → ZCode evidence → solution + boundaries → effect → risk/size → tentative priority → acceptance → verification. Items marked **[competitor evidence needed]** must not be justified by invented competitor claims; a comparison requires its own sourced research.

### R-1 Restore or retire the «上一轮更改» Git source (P0)

- **Problem:** the source is advertised and marked accepted, but is an empty shell.
- **Evidence:** `packages/ui/src/hooks/useGitRepository.ts:406,411-412`; `packages/ui/src/GitPane.tsx:109-114`; `docs/git/requirements-review.md:51`.
- **Solution:** either (a) wire the v4 projection per-turn file-change surface into `buildLastTurnDataset` (`useGitRepository.ts:320-345`), or (b) remove the source from `gitSourceOptions` (`useGitRepository.ts:180-194`) and downgrade the doc row to «未实现». Boundary: keep `IGitService` unchanged; no new RPC; no second source of truth for per-turn diffs.
- **Effect:** removes a visible dead control and a false acceptance record.
- **Risk:** S (retire) / M (restore). Retiring touches i18n copy + one doc row.
- **Priority:** high — a documented-as-accepted feature that does nothing is a credibility defect.
- **Acceptance:** with a task that changed files, the source either shows that turn's files with diffs, or the source no longer exists and no i18n key is orphaned.
- **Verification:** `packages/ui/test/gitRepositoryRefresh.test.ts`-style unit for dataset building; one E2E in `packages/desktop/test/e2e/git/`; `pnpm typecheck`, `pnpm lint`.
- **[competitor evidence needed]** for any claim about how peers present per-turn change sets.

### R-2 Add checkpoint/ref GC for the two checkpoint layers (P1)

- **Problem:** no list/GC at the services layer and no retention for hidden refs/manifests; unbounded growth per workspace.
- **Evidence:** `docs/git/checkpoint-service-foundation.md:150-155`; absence of `gc|prune` in `packages/services/src/git/gitCheckpointService.ts` and `apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoints.ts`; ref layout at `docs/git/checkpoint-service-foundation.md:186-197`.
- **Solution:** add an explicit `gcCheckpoints({ workspacePath, keepLatestN, olderThanMs })` on `IGitCheckpointService` plus a Host-side sweep triggered by storage management, deleting manifest + `refs/zcode/checkpoints/...` together (ref deletion must be idempotent and must not delete a ref referenced by an active session's `runtime/workspace_checkpoint` entry). Boundary: never GC during an active turn; no background timer; no cross-workspace sweep without explicit user action.
- **Effect:** bounded disk/ref growth; storage UI numbers become actionable.
- **Risk:** M (data loss if refs referenced by live sessions are removed).
- **Priority:** medium.
- **Acceptance:** after GC, `git for-each-ref refs/zcode/checkpoints` contains exactly the retained set; a fork/rewind from a retained checkpoint still succeeds; a rewind from a collected checkpoint fails with a typed error, not a crash.
- **Verification:** extend `packages/services/test/gitCheckpointService.test.ts` with a real repo (create 5, keep 2, assert refs + manifest files); runtime test that listing after GC returns only live entries.

### R-3 Make the CI story truthful in this repository (P0)

- **Problem:** docs describe a GitLab pipeline that does not exist here; the only workflow is manual and billing-blocked. A reader cannot reproduce the quality gate from the tree.
- **Evidence:** `ls .gitlab*` → absent; `.github/workflows/cross-platform-preview-release.yml:3-12`; `docs/desktop-ci-cd.md:3-15`; 15 docs referencing `.gitlab`.
- **Solution:** add a short `docs/ci/README.md` (or extend `docs/ci/affected-unit-test-baseline.md`) stating exactly what runs where in this checkout: local `verify:pre-push` is authoritative; GitHub workflow is Preview-publish-only and manual; GitLab pipeline is defined outside this export. Mark `docs/desktop-ci-cd.md` as describing the internal mirror, with a one-line header, matching the pattern already used at `docs/task/task-sqlite-index.md:3`. Boundary: documentation only; do not add a workflow that cannot run.
- **Effect:** removes the largest "docs lie" in this branch with minimal blast radius.
- **Risk:** S. **Priority:** high.
- **Acceptance:** a new contributor can answer "what gates my push?" from `docs/` alone; `pnpm verify:links` stays green.
- **Verification:** `node scripts/check-doc-links.mjs`; manual read-through of the new header.
- **[competitor evidence needed]** only if the appendix compares CI maturity across products.

### R-4 Put `fmt:check` back to green and decide its gate status (P1)

- **Problem:** the documented format check fails on a clean HEAD in 136 files (30 outside `.agents/skills`), and is not part of `verify:pre-push`.
- **Evidence:** `pnpm fmt:check` → exit 1, "Format issues found in above 136 files"; `node -e` check → `fmt included: false`; `.oxfmtrc.json` ignore list omits most of `.agents/skills`.
- **Solution:** one-time `pnpm fmt` pass limited to tracked source/docs (or extend `ignorePatterns` for vendored/skill content), then either add `pnpm fmt:check` to `verify:pre-push` or document explicitly that formatting is advisory. Boundary: formatting-only commit; no behavior change; do not reformat `docs/vendor`, `docs/electron/docs`, `third-party/**` (already ignored).
- **Effect:** removes a permanently-red command from the developer loop; makes AGENTS.md's command table honest.
- **Risk:** S (diff noise in one commit; risk of touching generated files if ignore list is wrong).
- **Priority:** medium.
- **Acceptance:** `pnpm fmt:check` exits 0 on HEAD; if gated, a deliberately misformatted file blocks push.
- **Verification:** `pnpm fmt:check`; `pnpm typecheck`; `pnpm lint`; `git diff --stat` shows only whitespace/format changes.

### R-5 Align `docs/testing/pre-push-hook.md` with the actual 14-step chain (P2)

- **Problem:** the hook doc lists 4 of 14 steps, omitting prism10, db schema, self-improve-pr, delegation benchmark, knip baseline, preview-release tests, knip, brainstorming companion.
- **Evidence:** `docs/testing/pre-push-hook.md:9` vs `package.json:51`.
- **Solution:** replace the prose list with the authoritative chain copied from `package.json`, plus one line per step naming its script and its failure semantics. Boundary: docs only; keep the existing "no mise dependency" section.
- **Effect:** contributors can predict push failures.
- **Risk:** S. **Priority:** low-medium.
- **Acceptance:** every token in `package.json:51` appears in the doc in the same order.
- **Verification:** `pnpm verify:links`; a diff read.

### R-6 Make Git requirement docs match implemented scope (P1)

- **Problem:** `docs/git/requirements.md:29-33` lists stage/unstage/discard and the history graph as non-goals, but all are implemented (`gitCliRepo.ts:1423,1444,1465`; `git.ts:36`; `git-graph/GitGraphPane.tsx`). `docs/git/unverified-requirements.md` still lists 5 unverified items with a 8/13 acceptance tally from 2026-04-09.
- **Evidence:** as cited; doc dates `docs/git/requirements.md` (baseline section) and `docs/git/unverified-requirements.md:5` («更新日期：2026-04-09»).
- **Solution:** rewrite the non-goals to the *current* boundary (no fetch/pull/stash/merge/rebase, no PR collaboration, no worktree management) and re-derive the acceptance table from code + tests. Boundary: docs only; do not "accept" items without an executable check.
- **Effect:** the Git doc set becomes usable as a spec again; removes F-1/F-2 class drift.
- **Risk:** S. **Priority:** high (cheap, high trust value).
- **Acceptance:** every row in the acceptance table cites a test file or a code path; no row contradicts code.
- **Verification:** cross-read against `packages/services/test/git*.test.ts` and `packages/ui/test/git*.test.ts`.

### R-7 Add a telemetry consent surface or document its absence (P1)

- **Problem:** telemetry flows through `IPlatformService.reportTelemetryEvent` with sanitization but no user-visible toggle or consent record was found; onboarding has no privacy step.
- **Evidence:** `packages/ui/src/lib/appTelemetry.ts:37-43`; `packages/shared/src/platform.ts` port; `rg` for `telemetryEnabled|telemetryOptOut|consent` over `packages/*/src` → no setting key; onboarding steps at `OnboardingDialog.tsx:442-444`.
- **Solution:** either add a `telemetry.enabled` setting (default per policy), surface it in Settings, and gate `reportAppTelemetryEvent` at one choke point; or, if policy is "always on, disclosed elsewhere", add a one-line disclosure in the onboarding preferences step and document the decision in `docs/`. Boundary: single choke point in `appTelemetry.ts`; no per-call-site conditionals; do not change event payloads. **Cross-check with Branch D before specifying retention/policy semantics.**
- **Effect:** removes an unverifiable compliance claim and a potential trust issue.
- **Risk:** M (product/policy decision, not purely technical).
- **Priority:** high if any market requires opt-out; otherwise medium.
- **Acceptance:** with the setting off, no telemetry request leaves the renderer (assertable via the platform port mock); with it on, existing payloads are unchanged.
- **Verification:** unit test on `reportAppTelemetryEvent` with a mocked platform port; one E2E for the settings toggle.
- **Unknown:** whether a consent surface exists in a non-renderer layer (Main/preload) — not verified in this branch.

### R-8 Give the CLI a session/plan introspection command (P3, optional)

- **Problem:** `--resume`/`-c`/`/resume` exist, but there is no `zcode sessions list` style non-interactive introspection, and no CLI surface for plan/usage; automation must parse the DB or drive the TUI.
- **Evidence:** command set `run.ts:601-649`; flags `arguments.ts:4-80`; help copy `en-US.ts:18-51`; no plan/usage command found.
- **Solution:** add `zcode sessions list [--json] [--cwd] [--limit]` backed by the existing `resolveLatestSession`-adjacent bootstrap path, reusing `listSessions` (`repositories/sessions.ts:147`) and the existing `--json` flag. Boundary: read-only; no new state; no duplicate query path (must go through the same store port).
- **Effect:** scriptable session discovery; makes `--resume <id>` usable without the TUI.
- **Risk:** S-M. **Priority:** low.
- **Acceptance:** `zcode sessions list --json` returns `{id,title,directory,updatedAt}` for the current cwd, newest first, and `--limit` is honored.
- **Verification:** CLI unit test with a temp DB; help text snapshot test.
- **[competitor evidence needed]** before claiming parity or advantage.

---

## 6. Open questions / unverified / failed commands

| # | Item | Status |
| --- | --- | --- |
| 1 | `pnpm fmt:check` | **Ran, failed** on clean HEAD: 136 files, exit 1. Recorded as a baseline defect (R-4), not caused by this research. |
| 2 | `pnpm lint` | Ran, exit 0; `CLI lint: 0 errors, 86 warnings, 7 pristine upstream line-count diagnostics`. Warnings include `max-lines` on `apps/zcode-cli/packages/core/src/runtime/methods/events.ts:1553`, `subagent/profile.ts:898`, `steering.ts:1301`, and unused imports in `compact.ts`, `file-rewind.ts`. |
| 3 | `pnpm typecheck` | Ran, exit 0. |
| 4 | `node scripts/check-doc-links.mjs` | Ran, exit 0: 1693 files / 2472 links. |
| 5 | `node scripts/architecture/architecture-check.mjs check --changed` | Ran, exit 0: `architecture: OK`, base `merge-base upstream origin/dev`, 0 violations, 0 baseline, 0 new. |
| 6 | `node --test scripts/test/sqlite-schema-contract.test.mjs` | Ran, 8/8 pass. |
| 7 | `pnpm exec vitest run packages/services/test/gitService.test.ts packages/services/test/gitCheckpointService.test.ts` | Ran, 20/20 pass (both in `fork-isolated`). |
| 8 | `pnpm exec vitest run packages/services/test/taskIndexRepoWorkspaceIdentity.test.ts packages/services/test/taskIndexRepoUnreadCompareAndClear.test.ts packages/services/test/taskChangeSummary.test.ts` | Ran, 19/19 pass. |
| 9 | `pnpm verify:pre-push` (full) | **Not run.** It would execute affected unit tests, knip, and other gates beyond this read-only audit's scope; individual components were run instead. |
| 10 | Desktop E2E (`pnpm test:e2e`) | **Not run** (requires Electron/WDIO and a long-lived harness; prohibited by task constraints). |
| 11 | `.gitlab-ci.yml` / `.gitlab/ci/*` | **Not present** in the checkout. Whether they exist in a private mirror is unknown. |
| 12 | Telemetry consent in Main/preload | **Unknown.** Only renderer-side absence was verified. Cross-check with Branch D. |
| 13 | Go/Python/Kotlin test suites | **Not verified.** Only referenced by `docs/testing/unit-test-quality.md`; not located or run. |
| 14 | Checkpoint GC growth in practice | **Unknown.** Absence of GC code is verified; actual disk growth on long-lived workspaces was not measured. |
| 15 | Competitor comparisons | **Deliberately not asserted.** No competitor source was read in this branch; every comparison point is marked `[competitor evidence needed]`. |
| 16 | `last-turn` populated behaviour | **Unknown.** The code path is hard-coded to `null`; whether a v4 projection exists elsewhere under a different name was not exhaustively proven — the CodeIndex search returned only empty-skeleton evidence. |
| 17 | `docs/git/requirements-review.md` acceptance tally | **Internally inconsistent.** The table (`:42-74`) has 31 requirement rows: 26 «已验收», 5 «未验收» (`sed -n '42,120p' … \| rg '^\| '` counts). But the conclusion at `:70` states «当前所有需求项的 `验收状态` 统一为 `未验收`», and `docs/git/unverified-requirements.md:5` claims 5 unverified **of 13** with an 8/13 progress table. Three different numbers for the same set. The 5 unverified rows do match, but the totals and the conclusion do not. |

### Failed / limited commands log

- `node -e "require('./.oxlintrc.json')"` → `SyntaxError: Expected property name or '}' in JSON at position 241`. `.oxlintrc.json` is JSONC (comments/trailing commas); `require` cannot parse it. Not a repository defect — oxlint itself reads it fine (`pnpm lint` exit 0). Recorded so the reader does not repeat it.
- `rg` with `--glob '!**/dist/**'` on the whole repo hit bundled `packages/desktop/bundled-agents/mac-arm64/glm/zcode.cjs` (minified, ~1.8 MB lines) and produced truncated output. Subsequent searches were narrowed to `packages/*/src` and `apps/zcode-cli/packages`; conclusions relying on "not found" were re-run with narrowed scopes.
- CodeIndex `search` returned oversized excerpts (one call failed with `too_big` on a 4096-char excerpt limit) and was therefore used only for orientation; all load-bearing claims were re-verified with `rg -n` against source.

---

## 7. Appendix narrative (по-русски)

### Что проверялось

Ветка F покрывает шесть независимых областей: (j) git/PR/worktree/diff/review, (p) монетизация, онбординг и документация, (q) тесты, CI и качество кода, плюс управление задачами и сессиями, UX командной строки и хранилище сессий с жизненным циклом данных. Проверка велась только чтением: исходники, конфигурация, документация и прогон безопасных локальных команд. Продакшн-код, конфиги, зависимости и lock-файлы не менялись; коммитов нет; серверы разработки не запускались.

### Git: сильный «лёгкий» обзор изменений, но без PR и worktree

Git реализован как полноценный сервис с единым интерфейсом для локального, удалённого и веб-окружения. Есть статус, diff, stage/unstage/discard, commit, push, переключение и создание веток, граф коммитов, сравнение с базовой веткой. Отдельно стоит отметить три инженерных решения, которые стоит сохранить: пакетный `refresh`, который заменил три RPC с повторным `git status` одним снимком; типизированную деградацию diff (`patch/binary/truncated/unavailable`) вместо разбора строк ошибок; и явные бюджеты команд с отдельными лимитами для push, потому что pre-push hook может запускать полный набор тестов.

Границы честные и задокументированы: нет fetch/pull/stash/merge/rebase как продуктовых операций. Но два места расходятся с кодом. Первое — источник «上一轮更改» (изменения прошлого хода): в документации он помечен как принятый, а в коде это пустой каркас с захардкоженным `null`, поскольку цепочка записи per-turn сводок была удалена вместе со старой подпиской на поток. Второе — `docs/git/requirements.md` перечисляет stage/unstage/discard и граф истории как не-цели, хотя они реализованы.

PR-воркфлоу отсутствует как продуктовая функция. Агент может читать состояние PR через разрешённые read-only подкоманды `gh`, но создание PR — это обычный shell-вызов под общим механизмом разрешений, а не объект продукта. Worktree тоже не управляется продуктом: есть только детекция linked worktree (для фильтрации миграций) и диагностика «ветка занята в другом worktree». Создание worktree существует лишь как инструкция в skill для модели.

Чекпоинты существуют в двух слоях: сервисный `GitCheckpointService` (скрытые git-ref плюс JSON-манифест, восстановление с проверкой конфликтов, не трогает индекс) и runtime-слой `runtime/workspace_checkpoint`, который питает файловый откат и форк. Откат файлов сделан по принципу «всё или ничего» с повторной проверкой прямо перед записью. Слабое место — отсутствие сборки мусора: ни список, ни GC на сервисном слое не реализованы, скрытые ref и манифесты копятся без ограничения.

### Задачи, сессии, CLI

Список задач и поиск реализованы через индекс `tasks-index.sqlite`: `LIKE` по заголовку и `searchable_text`, до четырёх сниппетов, лимит 200 000 символов для индексируемого текста. `searchable_text` заполняется при импорте и обновлении, а не читается из JSON сессии на лету — это правильная граница. Удаление архивных задач сначала читает полный набор по каждому workspace и сообщает о недоступных workspace, вместо того чтобы молча удалить подмножество.

CLI имеет маленькую и честную поверхность: девять команд и явный набор флагов, включая `--resume`, `--continue`, `--json`, `--locale`, `--mode`. Слэш-команды покрывают компакцию, форк, откат, режимы, модели, MCP, плагины и скиллы. Авторизация — браузерный OAuth с `--no-browser` для печати URL. Онбординга в TUI нет: мастер онбординга живёт только в десктопном/веб-интерфейсе. Команды для плана или использования из CLI тоже нет — монетизация целиком в UI.

### Монетизация, онбординг, телеметрия

Подписки — это серверный каталог с тонким клиентом: статические продукты, предпросмотр, ручное получение, Stripe-карты, PayPal, корпоративные заказы, сброс квоты. Клиент не считает цену. Квоты и лимиты — отдельный сервис с диапазонами 7 и 30 дней, плюс SQLite-факты использования в CLI с жёстким 30-дневным прунингом. Механизм баннера низкой квоты сделан аккуратно: считает по каждому «ведру» отдельно, срабатывает только в диапазоне (0, 10%], дедуплицирует по `bucket_id + period_start + period_end`, хранит только ключ периода и использует серверное время.

Общего слоя feature-gate нет. Единственный найденный гейт — включение веб-удалённого управления в Main. Доступность возможностей выражается через доступность провайдера и квоту, а не через явный API гейтов. Телеметрия идёт через платформенный порт с санитизацией, но пользовательского переключателя или записи согласия в renderer не найдено; шаг согласия в онбординге отсутствует. Это требует сверки с веткой D, которая отвечает за политику телеметрии.

Онбординг — три шага (профессия, режим интерфейса, предпочтения) плюс шаг миграции AGENTS.md. Триггер намеренно консервативный: при ошибке или таймауте запись считается «неизвестной» и пользователя не беспокоят, с общим трёхсекундным бюджетом на все повторные проверки. Запись привязана к device-id и поддерживает несколько пользователей на одной машине.

### Качество, CI и документация

Локальный гейт — это фактическая система качества. `pre-push` запускает 14 шагов: профиль и эксперимент-гейт prism10, lint, скан приватности по индексу, `HEAD` и blob-ам push-диапазона, проверку схемы SQLite, тесты архитектуры, `architecture:check --changed`, affected-тесты, тесты self-improve, бенчмарк делегирования, baseline knip, тесты preview-release, knip и тесты brainstorming. Отдельно сильны два механизма: контракт «только аддитивные изменения схемы», который сверяется с `git show <base>:<baseline>` и проверяет сохранение CHECK/UNIQUE/индексов/коллации, и affected-тесты, которые при выборе всего корневого набора честно пропускают прогон и сообщают об этом, а не блокируют push.

CI в этом чекауте фактически отсутствует: единственный workflow — ручной сборки Preview, а описанный в документации GitLab-пайплайн в дереве отсутствует. Пятнадцать документов ссылаются на `.gitlab-ci.yml`. Это не «сломанный CI», а расхождение экспорта и внутреннего зеркала, но читатель не может воспроизвести гейт по дереву.

Форматирование — единственная реально красная проверка на чистом HEAD: 136 файлов, из них 30 вне `.agents/skills`. `fmt:check` не входит в `pre-push`, поэтому дефект не блокирует работу, но делает команду из AGENTS.md недостоверной.

Документация огромна (2088 файлов), и ссылки в порядке: 2472 относительные ссылки валидны. Но точки входа нет — ни `docs/README.md`, ни индекса. Много документов-«заметок об изменении», а не руководства. Часть документов устарела: GitLab CI, не-цели Git, принятый «последний ход», четыре шага из четырнадцати в описании pre-push.

### Хранилище сессий

Схема — 27 таблиц, 27 зарегистрированных миграций, строгий аддитивный контракт, WAL, `BEGIN IMMEDIATE`, проверка контрольных сумм, фазы прогресса `checking → waiting_for_lock → migrating → committing → ready`, резервные копии с сохранением двух последних. Сессии удаляются мягко (`time_deleted`), сообщения и части сохраняются; списки фильтруют удалённые. Прунинг по времени есть только для таблиц использования — 30 дней. Политики хранения содержимого сессий, чекпоинтов и файлов model-IO в этом слое нет. Управление хранилищем в UI честно показывает два корня данных и не пытается их объединить.

### Главные выводы

Сильные стороны: единый Git-сервис с пакетным refresh и типизированной деградацией; контракт аддитивной схемы SQLite; архитектурный ratchet с пустым baseline; новый-только knip-гейт; скан приватности по blob-ам; affected-тесты, которые не притворяются полным прогоном; «всё или ничего» при откате файлов; аккуратная семантика квот; консервативный триггер онбординга.

Главные пробелы: мёртвый источник «последний ход», помеченный как принятый; отсутствие GC для чекпоинтов; отсутствие PR/worktree как продуктовых функций; красный `fmt:check` вне гейта; CI, описанный в документации, отсутствует в дереве; отсутствие пользовательского согласия на телеметрию; устаревшие Git-документы и устаревшее описание pre-push.

Приоритеты: сначала дешёвые и доверительные исправления документации и мёртвого UI (R-1, R-3, R-6), затем форматирование (R-4) и GC чекпоинтов (R-2), затем решение по согласию на телеметрию (R-7) и, опционально, CLI-интроспекция сессий (R-8).
