# Prompt enhancer without questions

Date: 2026-11-21. Status: implemented in 3.17.143.

## Problem

The composer enhance button produced a structured rewrite, but it did not classify the
task, choose a prompt framework, or surface capability suggestions. It also had no
explicit consent boundary before mutating the composer draft. The product rule is now:
**never ask the author a clarifying question; infer, mark assumptions, and let the author
accept or reject the result.**

## Ownership

- `packages/shared/src/prompt-enhancer/classify.ts` owns deterministic domain/task/framework
  classification.
- `packages/shared/src/prompt-enhancer/meta-prompts.ts` owns the enhancer contract and
  framework guidance.
- `packages/shared/src/prompt-enhancer/pipeline.ts` owns parsing and bounds.
- `packages/services/src/prompt-enhancer/service.ts` binds classification, model call,
  streaming, cancellation and result provenance.
- `packages/ui/src/prompt-enhancer-ui/*` owns preview, Apply, Cancel and Undo.

## Rules

1. **No clarifying questions.** The system prompt explicitly forbids them. Ambiguity is
   resolved with an assumption record (`draft` / `repository` / `model`).
2. **Automatic classification.** The classifier derives a coarse `domain` and `taskKind`
   from the draft, target and collaboration mode. It is a hint, not a new requirement.
3. **Framework selection.**
   - `TAG` for a short single action;
   - `CARE` when an example/style reference is requested;
   - `RISE` for multi-step, implementation, bugfix, refactor, planning or plan mode;
   - `ORACLE` for long/open-ended work and the fallback.
4. **Capability suggestions.** The model may return
   `skill`/`mcp`/`agent`/`plugin` suggestions with a reason. The Host marks every
   suggestion `requiresConsent: true`. Nothing is installed on render; a suggested skill
   is installed only by one explicit click on its install button. `requiresConsent`
   remains a provenance/status marker for display, not a second confirmation step.
5. **Preview/consent.** Composer enhancement opens a before/after dialog. The editor is
   not mutated until Apply. Cancel discards. After Apply, Undo restores the exact original
   draft for 30 seconds.
   System-instruction editors (e.g. the subagent system prompt field) apply the result
   straight into the field as a form draft, without a dialog; only explicitly saving the
   form commits it. Composer preview/consent behavior is unchanged.
6. **Cancellation/timeout.** Existing request abort/timeout behavior is preserved; a
   canceled request never applies text.
7. **Language and mentions.** The rewrite stays in the author's language and preserves
   protected mentions byte-for-byte.
8. **Provenance UI.** The preview shows framework, domain, task kind, assumptions and
   capability suggestions. No hidden side effect.

## Acceptance

- A short "rename the button" draft selects `TAG`.
- A multi-step TypeScript implementation selects `RISE`, `domain=coding`,
  `taskKind=feature`.
- An explicit "like this example" selects `CARE`.
- A long open-ended brief falls back to `ORACLE`.
- The system prompt contains "Never ask the author a question" and the selected
  framework.
- Capability suggestions are returned with `requiresConsent: true`; malformed entries are
  dropped.
- Composer does not mutate the draft before Apply; Cancel leaves it unchanged; Undo
  restores the original.
- A suggested skill installs from one explicit click; nothing is installed before the
  click.
- Existing streaming/cancel/mention-protection tests stay green.

## Evidence

- `packages/shared/src/prompt-enhancer/classify.test.ts`
- `packages/shared/src/prompt-enhancer/contract.test.ts`
- `packages/services/src/prompt-enhancer/contract.test.ts`
- `packages/services/test/prompt-enhancer/promptEnhancerService.test.ts`
- `packages/ui/src/prompt-enhancer-ui/enhancePromptButton.test.tsx`
- `packages/ui/src/prompt-enhancer-ui/EnhancePromptDetails.test.tsx`
- `apps/zcode-cli/packages/cli/tests/enhance-command.test.ts`

## Capability Resolver follow-up

The suggestion list is now resolved against the installed capability index and surfaced
with `installed`/`source` provenance; see
[`2026-11-21-task-brief-capability-resolver.md`](./2026-11-21-task-brief-capability-resolver.md).
Installing a suggested skill takes one explicit click on the suggestion's install button
and then runs through the existing marketplace skill install service; nothing is installed
or invoked automatically. The `requiresConsent` flag is still surfaced as a status text
next to a not-yet-installed suggestion, but the install button itself is the consent
action rather than a first step of a two-step confirmation.
