# bundled-skills

Skills that ship with the ZCode CLI as a built-in capability, outside the plugin system.

A skill lives here when a product feature depends on it: the feature's tools are registered
by the runtime, so the skill that teaches the model how to use them must be just as
unremovable. Unlike an official plugin, this pack is never listed in the plugin store, has no
enable/disable switch, cannot be uninstalled, and does not appear in the Settings skill list
or the composer's `$` skill picker. The runtime discovers its `skills/` directory as a
`source: "bundled"`, `scope: "system"` skill root on every start.

| Skill                         | Feature                                               | Contract                                           |
| ----------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `dynamic-workflows`           | dynamic workflows (`/workflow`, `CreateWorkflow`)    | `docs/dynamic-workflow/authoring.md`               |
| `zcode-swarm`                 | ZCode subagent planning and result synthesis         | `docs/specs/zcode-swarm-mode.md`                   |
| `zcode-verification`          | Evidence-based validation and truthful reporting     | Repository instructions and the affected spec     |
| `zcode-systematic-debugging`  | Reproducing and tracing runtime or packaging failures | Repository instructions and the affected spec     |
| `anti-loop`                   | Detecting repeated delegation without progress       | `docs/specs/cursor-harness-runtime-adaptation.md`   |
| `self-improvement`            | Evidence-driven updates to prompts, skills, and gates | `docs/specs/cursor-harness-runtime-adaptation.md`  |
| `code-craft`                  | Small, reviewable implementation changes            | Repository instructions and the affected spec      |
| `codebase-design`             | Designing useful module interfaces and dependencies | Repository instructions and public contracts       |
| `doc-coauthoring`             | Collaborative specifications, proposals, and plans   | The requested audience and document constraints   |
| `reference-first`              | Reusing existing code and verified references        | `docs/specs/cursor-harness-runtime-adaptation.md`  |
| `task-planning`                | Turning a request into bounded deliverables          | `docs/specs/cursor-harness-runtime-adaptation.md`  |
| `execution-patterns`            | Choosing direct, sequential, or parallel execution   | `docs/specs/cursor-harness-runtime-adaptation.md`  |
| `reviewer`                      | Independent, evidence-backed code review             | `docs/specs/cursor-harness-runtime-adaptation.md`  |
| `completion-gate`               | Checking requested outcomes before reporting done    | `docs/specs/cursor-harness-runtime-adaptation.md`  |
| `research`                      | Traceable, primary-source research and evidence labels | `docs/specs/cursor-harness-runtime-adaptation.md` |
| `domain-modeling`                | Domain terms, identities, boundaries, and invariants | `docs/specs/cursor-harness-runtime-adaptation.md` |
| `ui-craft`                       | Accessible, responsive, evidence-reviewed interfaces | `DESIGN.md` and the owning UI specification       |
| `merge-conflict-resolution`      | Intent-preserving Git conflict resolution            | Repository instructions and the affected spec    |
| `handoff`                        | Accurate, secret-safe continuation notes             | Repository instructions and current task evidence |
| `image-to-code`                  | Translating supplied visual references into UI       | `DESIGN.md` and the owning UI specification        |
| `performance-tuning`              | Measured, comparable performance improvements        | Repository instructions and the affected spec     |
| `mcp-authoring`                   | ZCode-native MCP/plugin capability design and checks | `docs/plugin-creator.md` and MCP contracts       |

## Always-on harness rules

`rules/*.mdc` contains a small portable ruleset adapted from useful ZCode agent harness guidance. The
bootstrap resolves it once into the canonical `ContextSourceSnapshot`; root turns and descendants
reuse that snapshot. The renderer attaches the rules as explicitly untrusted task guidance. They do
not alter system policy, permissions, tool access, or trust boundaries. Desktop staging and SEA
collection require and package the same rules beside the skills.

## How it reaches users

- **Development and Electron desktop**: the directory is resolved on disk next to the CLI entry
  (`packages/bundled-skills` relative to the entry, the same candidate walk official plugins
  use) and read in place; nothing is copied.
- **SEA binaries**: `scripts/sea-bundled-skill-assets.mjs` embeds `skills/**` under the
  `zcode-bundled-skills/` asset prefix. On start the CLI extracts them once into
  `~/.zcode/cli/bundled-skills/<content-hash>/` and reads from there.
- **Remote hosts**: `packages/server/src/remote/zcodeAgentDevDeploy.ts` stages this directory
  next to the remote `zcode.cjs`; remote release validation checks every required pack asset
  before activation.

The resolver is `apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts`. Every shipped
skill file is pinned as a required asset in bootstrap, Desktop staging, SEA collection, and
remote deployment validation: a stage or seed that loses one refuses the whole pack and logs a
warning instead of shipping an incomplete skill.
