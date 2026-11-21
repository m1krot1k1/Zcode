# Task brief, capability resolution and agent library lifecycle

Date: 2026-11-21. Status: implemented for 3.17.144.

This spec closes the prompt-UX and capability chain that follows the composer enhancer:
**compose a brief without questions, continue the draft inline, resolve installed
capabilities, and keep the skill→agent library consistent.**

## 1. Task Composer (P0.6)

The composer uses the existing prompt-enhancer preview. The enhancer is a task composer,
not a questionnaire:

- The system prompt explicitly forbids asking the author a question.
- `classifyPromptEnhanceTask` deterministically derives `domain`, `taskKind` and a
  framework (`ORACLE` / `RISE` / `CARE` / `TAG`) before the model call.
- The selected task kind adds a required brief shape, for example:
  - `bugfix`: symptom, reproduction, expected vs actual, root-cause evidence, minimal fix,
    regression test;
  - `feature`: user-visible goal, interface/data contract, non-goals, acceptance tests;
  - `review`: scope, base/diff, risk areas, severity, evidence.
- Ambiguity becomes an `assumption` entry (`draft` / `repository` / `model`), never a
  question. The preview shows framework, domain, task kind and assumptions.
- The editor is unchanged until **Apply**. **Cancel** discards. **Undo** restores the exact
  original draft for 30 seconds.

Owner: `packages/shared/src/prompt-enhancer/{classify,meta-prompts}.ts` and
`packages/ui/src/prompt-enhancer-ui/useComposerPromptEnhance.ts`.

## 2. Inline continuation (P0.7)

`ChatAutocompleteService` already receives the draft before/after the cursor, active file,
open tabs and recent context. This pass adds a deterministic draft-shape hint:

- The same classifier labels the prefix as `bugfix`/`feature`/`review`/etc.
- The continuation prompt asks for the next missing part of the user's brief (scope,
  constraint, acceptance criterion, missing input), not an assistant plan.
- No extra model call, no new state, no change to the 48-token / 1.2 s budgets.
- Prefix cache, cancellation and lexicon behavior are unchanged.

Owner: `packages/services/src/chat-autocomplete/service.ts`.

## 3. Capability Index and Resolver (P1)

### Index

The Host builds a read-only index from installed facts:

- skills from `SkillsService.list`;
- user agents from `SubagentsService.list({ mode: "settingsUserOnly" })`;
- MCP servers/plugins remain model-proposed until their own settings surfaces are used,
  because listing them may start connections or scan plugin caches.

The index is cached per workspace identity (or path fallback) for 60 seconds. The lookup
starts in parallel with the model call and is capped at 2 seconds; a failure or timeout
never fails prompt enhancement.

### Resolver

`resolvePromptEnhanceCapabilities` merges:

1. model suggestions, preserving order and reason, annotated with the observed
   `installed` state;
2. deterministic installed matches based on draft tokens, name/description and the
   classified domain/task.

Rules:

- every suggestion has `requiresConsent: true`;
- disabled capabilities are never suggested;
- suggestions are capped (6);
- no installation, invocation or claim of availability happens in the resolver;
- the result carries `source: "model" | "index"` and `installed: boolean`.

Owner: `packages/shared/src/prompt-enhancer/capabilities.ts`,
`packages/services/src/prompt-enhancer/service.ts`,
`packages/services/src/node/prompt-enhancer-ports.ts`.

## 4. Consent-aware maze installation

The preview's capability list shows `Installed` / `Not installed`. For an uninstalled
skill, the user needs two explicit clicks:

1. **Install skill** arms the confirmation;
2. **Confirm install** calls the same `SkillsService.installMarketplaceSkill` used by
   Settings, with `scope: "workspace"` and the current workspace path.

The Host then writes the skill and provisions the same-name agent through the existing
`onMarketplaceSkillInstalled` callback. MCP/plugin/agent suggestions stay informational;
their installation remains in Settings.

## 5. Skill→agent backfill and Agent Librarian (P1)

- `SkillsService.list` calls `onSkillsListed` once per workspace. The Host backfills
  missing agents for marketplace skills under `.agents/skills` (`.zcode/skills` is not a
  marketplace install root), then refreshes subagent runtime state.
- Backfill is idempotent: an existing user profile is never overwritten.
- `auditAgentSkillLibrary` is a read-only audit that reports:
  - generated skill agents whose skill disappeared (`orphanedSkillAgents`);
  - any agent that references a missing skill (`agentsWithMissingSkills`);
  - enabled marketplace skills without any agent reference (`skillsWithoutAgent`).
- The audit logs counts only; it never deletes or rewrites a user profile. A hand-edited
  profile is preserved and remains visible.

## 6. Monitoring

- `prompt enhancement completed` includes `capabilitySuggestionCount`,
  `installedCapabilityCount` and `capabilityIndexSize`.
- `agent skill library drift` logs aggregate counts per workspace.
- Logs never include the draft text, skill bodies or user paths beyond the existing
  workspace log fields.

## 7. Acceptance

- A bugfix draft yields a brief with reproduction/root-cause/regression requirements and
  no question mark added by the enhancer.
- Autocomplete on a feature draft continues the user's sentence with a missing constraint
  or acceptance criterion, not an assistant plan.
- A model suggestion matching an installed skill is marked `installed: true`; an unknown
  suggestion stays `installed: false`.
- An installed skill whose terms match the draft is suggested even if the model omitted it.
- Capability suggestions never install on render; two clicks are required for a skill.
- Installing a skill from the preview creates the same-name agent and the next listing
  shows it.
- Backfill runs once per workspace; an existing profile is not overwritten.
- The Librarian audit reports drift without mutating profiles.
- A slow/failed capability index does not fail or delay an enhancement beyond the 2 s cap.

## 8. Evidence

- `packages/shared/src/prompt-enhancer/capabilities.test.ts`
- `packages/services/src/prompt-enhancer/contract.test.ts`
- `packages/services/test/prompt-enhancer/promptEnhancerService.test.ts`
- `packages/services/src/node/prompt-enhancer-ports.test.ts`
- `packages/services/src/subagents/agentLibraryAudit.test.ts`
- `packages/services/test/skillsService.test.ts`
- `packages/ui/src/prompt-enhancer-ui/useComposerPromptEnhance.test.tsx`
- `packages/ui/src/prompt-enhancer-ui/EnhancePromptDetails.test.tsx`
- `packages/services/src/chat-autocomplete/*.test.ts`

## 9. Out of scope

- Automatic marketplace installation without a click.
- MCP/plugin installation from the composer preview.
- Deleting orphaned agents automatically; destructive lifecycle remains a user action.
- A separate "task composer" dialog: the existing enhancer preview is the single consent
  boundary, so there is no second divergent composer state.
