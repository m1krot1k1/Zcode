# Session latency: compaction and `/start` routing

Date: 2026-11-22. Status: implementation in progress; source checks passed, live task smoke must use isolated storage.

## Evidence

Session `session_a2f1550c91cb767864f383e97a308fd8` ran for about 10m47s and ended
cancelled. One presentation deliverable went through `start -> orchestrator -> find-skills`;
the `start` call occupied 285s, `orchestrator` 231s, and `find-skills` 130s with 33 tool
calls and about 687k tokens. No presentation worker started. The parent then made 20
direct Bash and 7 Read calls, outside the requested `/start` agent path.

Two compact model calls used `effort=max` and a 20,000-token output limit;
the first took about 89 seconds and finished at the output limit, while the second was
cancelled after about 76 seconds. The root session spent about 4m45s waiting for
`start -> orchestrator` before continuing. The compact prompt asked for chronological,
exhaustive coverage of every user message and full code snippets, including an
`<analysis>` section.

The required `presentations:pptx` capability belongs to the ZCode `presentations` plugin,
but the admission error incorrectly instructed the caller to use `SkillInstall`, which
only downloads from skills.sh. That request received HTTP 404. The plugin copy was cached
but disabled. This caused a long marketplace-search detour and then direct shell-based
OOXML work instead of an exact skill-backed worker.

The screenshot's context breakdown attributes 4.1% to the system prompt. The compact
PRISM profile is already reduced, so changing PRISM is not supported by this evidence.

During the dev smoke launch, the v3 protocol rejected `tool.updated` events because
`readOnly` and `sideEffectScope` were emitted by the CLI but missing from its strict
`started` payload schema. This makes tool activity disappear from the desktop timeline.

## Product rules

1. Compaction is a short auxiliary model call: bind the lowest reasoning level the model
   supports and cap summary generation at 8,000 output tokens.
2. The compact prompt asks for a concise handoff with the active request, user constraints,
   decisions, changed files, checks, blockers, a `Pending Tasks` section, and next action. It must not request hidden
   analysis, a transcript of every user message, or full code excerpts. Exact historical
   details remain available from the transcript reference.
3. A compact summary that reaches the output limit is incomplete and must not silently be
   treated as a complete handoff.
4. `/start` sends one deliverable directly to its best matching worker. It uses
   `orchestrator` only for multiple independent deliverables or real dependency planning
   and joining. Root may install an exact missing plugin capability only through
   `InstallCapability` after approval and retry `Task(start)` once. Otherwise a blocked
   start ends the root turn; root does not use workspace tools or spawn sibling profiles.
5. Parallelism remains adaptive to actual independent work and runtime capacity; this does
   not add a fixed agent limit.
6. The v3 `tool.updated` started-event schema accepts the resolved `readOnly` and
   `sideEffectScope` metadata already emitted by the CLI.
7. `SkillInstall` is used only for public skills.sh results. A plugin-owned skill must use
   its exact plugin capability through `InstallCapability` after approval; if the plugin
   cannot be resolved or installation is denied/fails, stop with the specific blocker.
8. A `Skill` denial names the requested skill and the current profile's allowlist, making
   clear that the restriction is profile-scoped and identifying the exact profile change
   needed. It must not claim that skills are globally unavailable to all subagents.

## Event sequence

```mermaid
sequenceDiagram
  participant User
  participant Root
  participant Start as start
  participant Worker as Exact worker
  participant Capability as Plugin capability
  participant Runtime
  User->>Root: One deliverable via /start
  Root->>Start: Task(start)
  Start->>Worker: Bounded task and exact skill/profile
  opt Plugin skill is unavailable
    Worker-->>Start: Exact plugin capability missing
    Start-->>Root: Exact missing plugin id
    Root->>Capability: InstallCapability with approval
    Capability-->>Root: Installed or explicit failure
    Root->>Start: Retry Task(start) once when installed
  end
  Worker-->>User: Result and evidence
  Note over Root,Runtime: Other blocked results end the root turn; no direct-tool fallback

  participant Model
  Runtime->>Model: Compact with lowest reasoning and <= 8k output
  Model-->>Runtime: Concise handoff
  Runtime->>Runtime: Preserve recent entries and continue task
```

## Acceptance

- Compact model requests bind the lowest supported reasoning level and send no more than
  8,000 output tokens, including models with a larger configured output budget.
- The compact prompt is materially shorter and preserves actionable context without asking
  for `<analysis>` or exhaustive transcript reconstruction.
- A non-empty `finishReason: "length"` compact response is treated as truncated and cannot
  replace the conversation as if complete.
- `/start` command text no longer routes every complex task to `orchestrator`; it matches
  the built-in start routing contract and directs the root to stop on a blocked start result.
- Missing plugin-qualified skills do not direct the model to `SkillInstall`; the error
  identifies the plugin capability path. Public skills.sh installs retain their existing
  path.
- A profile-scoped Skill denial identifies the exact disallowed skill and allowed set.
- Strict v3 event validation accepts valid started-event capability metadata and continues
  to reject invalid side-effect scope values.
- Regression tests cover model options, truncation, prompt shape, and slash-command text.
- Targeted tests, `pnpm architecture:check --changed`, `pnpm typecheck`, and `pnpm lint`
  run and their actual results are reported.
