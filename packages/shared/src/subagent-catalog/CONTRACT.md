# shared-subagent-catalog

**Intent.** Provide one stable, runtime-independent projection of ZCode's built-in agent
roster. Settings and Services need names, descriptions, colors, tools and preferred skills,
but they must not import Core prompts or execution code. Core remains the owner of runtime
behavior; this module is the shared catalog contract.

**Invariants.**

- The catalog is data only: no spawning, no model calls, no filesystem access.
- `BUILT_IN_AGENT_SUMMARIES` must match `BUILT_IN_SWARM_PROFILES` in
  `apps/zcode-cli/packages/core/src/subagent/built-in-profiles.ts`; the bootstrap contract
  test fails on drift.
- Built-in names are reserved; custom profiles cannot replace them.
- `skills` lists preferred skills. `"*"` means "may load any skill" and is not a
  specialization; consumers must not count it as a concrete skill.
- No secrets, prompts, model selections or user data belong in this module.

**Intersections.**

- `packages/services/src/subagents` projects the catalog into Settings rows.
- `packages/ui` renders the rows and model-override controls.
- `apps/zcode-cli/packages/bootstrap` owns the runtime roster and hosts the drift test.
- Runtime prompts/tools remain in Core; this module never becomes a second execution owner.

**Public surface.** `index.ts` re-exports `contract.ts`, `builtInAgents.ts` and
`runtimeConfig.ts`. Consumers import through `@zcode/shared`, not deep paths.
