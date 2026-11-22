# shared-prompt-enhancer

Wire contract for the native "Enhance Prompt" feature. This module holds only Zod schemas,
limits and error codes. It performs no I/O, never reads the repository and never calls a model.

## Boundary

- The request identifies a workspace by `workspacePath` and, for remote workspaces, by
  `workspaceIdentity`. Consumers must send both when they have them; the Host falls back to
  `workspacePath` only when identity is absent, using the shared identity-key rule.
- `target` distinguishes a free-form composer prompt (`chat_user_prompt`) from an author's custom
  system prompt (`custom_system_prompt`). The Host applies different meta-prompts; the wire shape is
  identical.
- `preservedMentions` carries `@file` / `$skill` markers verbatim. The enhancer must return them
  unchanged; changing a mention path is an `unsupported_changes` failure, not a silent rewrite.
- `activeFilePaths` is a bounded proximity hint (max 10). It never grants file access.
- `draftText` is capped at 32 000 characters so one RPC frame and the downstream model request stay
  bounded.

## Result

`enhancedText` is the only field the composer applies. `addedClarifications`, `assumptions` and
`usedContext` are provenance for the UI: they let the surface explain what changed without diffing
free text. `usedContext` never contains file contents, only workspace-relative paths or symbol names.

`tokenDelta.before` / `tokenDelta.after` are estimates produced by the Host with the declared
`method` (`tokenlens` when the tokenizer is available, otherwise the shared char-ratio estimator).
The delta is informational; it is not a billing fact.

## Failure semantics

Errors travel as `PromptEnhanceErrorCode` values inside the transport envelope. `aborted` and
`timeout` are cancellations, not model failures. Hosts log request metadata at `debug` and never log
`draftText` or `enhancedText` at `info`.
