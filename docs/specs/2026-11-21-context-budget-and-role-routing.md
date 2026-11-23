# Context budget, role-scoped skills, and start fast path

Date: 2026-11-21. Status: implemented in 3.17.139.

## Problem

The measured main turn carried ~40k input tokens before work started. Skills and the
agent listing filled ~20k of that budget, every built-in role advertised `skills: ["*"]`,
`/start` always inserted an orchestrator step, and a 16 GB host allowed up to 10 parallel
subagents. The result was expensive, slow, and only nominally specialized.

## Owners

- `apps/zcode-cli/packages/core/src/context/sections/skills.ts` owns the skill catalog
  projection.
- `apps/zcode-cli/packages/core/src/subagent/profile.ts` and `listing.ts` own the
  model-visible agent catalog and caller admission.
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent/skill-port.ts` owns the
  child skill boundary: catalog visibility vs. load permission.
- `apps/zcode-cli/packages/core/src/runtime-task/registry-types.ts` owns adaptive
  subagent capacity.
- `apps/zcode-cli/packages/core/src/subagent/built-in-profiles.ts` owns the router
  prompts.

## Rules

### Skill catalog

1. Default `skills.metadataBudget` is 12,000 characters.
2. Descriptions are capped at 160 characters.
3. Descriptions are kept while they fit; the remaining skills stay visible as name +
   path. The model never loses exact skill names because the catalog is full.
4. The catalog remains the only runtime projection; Settings and services are unchanged.

### Agent listing

1. The main-turn listing is one line per role.
2. Descriptions are capped at 140 characters; at most six tools are shown, followed by
   `+N more`.
3. `Skill` is retained in the visible tool prefix when the role may use it.
4. Routers keep their own caller-scoped catalogs; the compact form does not widen
   admission.

### Role-scoped skills

1. `skills` remains the allowed set. `"*"` means "may load any skill".
2. `preferredSkills` is the catalog projection. When absent, concrete entries from
   `skills` are preferred; a profile with only `"*"` shows the full allowed catalog.
3. `discoverSkills` returns only preferred skills. `loadSkill` still resolves against
   the allowed set, so marketplace or explicitly allowed skills remain loadable even
   when they are not in the compact catalog.
4. Marketplace installation keeps creating a same-named profile in `~/.zcode/agents`;
   that profile has `skills: [name]`, so its catalog is naturally role-scoped.

### Start routing

1. A single bounded task goes directly to a matching worker profile.
2. `orchestrator` is used for two or more independent workstreams or explicit dependency
   planning/join when a separate owner reduces the critical path. Unclear scope alone does
   not add a handoff level; the exact worker owns research for one deliverable.
3. `start` never runs implementation itself and never delegates to itself.
4. Admission and the visible catalog use the same predicate, so the model cannot call a
   role it cannot see.

### Adaptive subagent capacity

1. Memory accounting uses 1 GiB per agent and a 40% RAM budget.
2. On 16 GB this yields 6 slots; on 8 GB, 3 slots. CPU remains the other bound.
3. A user-configured `maxParallelSubagents` may only reduce the adaptive ceiling.

### Working context ceiling

1. The default is auto (`workingContextCeilingTokens: 0`): use the full context window
   reported by the provider, minus the output reserve and compaction buffer. A 1M model
   therefore compacts near 966k, not at an artificial 80k.
2. The persisted 80k and 120k defaults migrate once to 0 under
   `workingContextCeilingMigrationVersion: 2`; explicit custom values (for example 180k)
   are preserved.
3. A custom ceiling remains an opt-in Settings control for cost/latency; the default UI
   shows "Auto — model window" and hides the numeric input unless the user enables a limit.
4. Observation masking is enabled by default: stale large Read/Bash/Grep/Edit observations
   are replaced with target metadata and a digest in quantized groups. With auto it uses
   the model-window threshold; an explicit lower ceiling still compacts earlier without
   turning old tool output into a hard loss of identity.
5. Cache hit rate is already projected into Context Usage; no new provider API is
   invented when the provider does not expose prefix-cache usage.

## Acceptance

- A 16 GB host resolves at most 6 parallel subagents.
- A full skill catalog keeps descriptions for the leading entries and keeps exact names
  for the tail; total stays near the configured budget.
- A built-in role with concrete skills shows only those skills, but can still load an
  allowed marketplace skill by exact name.
- `start` sees workers and orchestrator, not itself; a single-task prompt routes to a
  worker, while fan-out still routes to orchestrator.
- Existing tests for tool filtering, marketplace delegation, and plan/join routing stay
  green.

## Evidence

- `apps/zcode-cli/packages/core/tests/context-builder.test.ts`
- `apps/zcode-cli/packages/core/tests/agent-listing.test.ts`
- `apps/zcode-cli/packages/core/tests/subagent-skill-marketplace.test.ts`
- `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts`
- `apps/zcode-cli/packages/core/tests/spawn-budget.test.ts`
- `apps/zcode-cli/packages/core/tests/microcompact-budget.test.ts`
- `packages/shared/test/appSettings.test.ts`
- `apps/zcode-cli/packages/core/tests/compact-policy.test.ts`

## Not enabled in this pass

Lazy MCP connection and isolation of autocomplete/proactive/memory model calls remain
opt-in/A-B work: both can remove tools or starve background features, so they are not
enabled blindly. ToolSearch deferral (P0.1) already removes deferred MCP schemas from
the resident prompt, and observation masking is enabled ahead of the model-window auto-compaction threshold.
