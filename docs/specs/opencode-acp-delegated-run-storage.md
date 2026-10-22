# OpenCode ACP delegated run persistence and recovery

This spec is a prerequisite for the Composer route in [opencode-acp-delegated-runtime.md](./opencode-acp-delegated-runtime.md). It defines the durable owner for one accepted OpenCode CLI request without representing ACP output as ZCode model output.

## Owner and atomic write

- The CLI `SessionStorePort` / SQLite session store is the only durable owner. Reuse the existing session database and transaction boundary; do not add a second database or write this state from Renderer/Host.
- A delegated `sendText` uses deterministic `runId = commandId`. Before committing, shared schema validation rejects unsupported payloads and the V4 gateway verifies the task is idle and has a process-owning Host route.
- Add a transactional store operation that writes the canonical `session_input` intent and the initial external-run journal record in one SQLite transaction. The input intent includes `executionRoute`; the run record is an outbox row in state `pending`. A crash cannot leave an accepted delegated input without a dispatchable outbox record, or an outbox record without its accepted input.
- The transaction is the accepted-input commit point. Only after it commits may `CommandInbox` settle the request as accepted and the outbox dispatcher send `startRun`. Repeated `commandId` returns the existing intent/run record; it never inserts a second user prompt or ACP run.
- Preserve the existing ordinary ZCode admission and promotion transaction semantics. `startPromptTurn` must not run for an ACP route.

## Durable record

Add a strict schema and migration for a table in the existing session database, keyed by `(session_id, run_id)` and foreign-keyed to the owning session. A row contains only:

- schema version, `session_id`, `run_id`/`command_id`, and the associated admitted input ID;
- route kind and optional requested OpenCode model catalog ID;
- lifecycle state (`pending`, `dispatching`, `running`, `completed`, `cancelled`, `failed`, `interrupted`), durable record revision, process-owning Host event sequence, and created/updated/terminal timestamps;
- the Host-returned ACP session ID while active, cleared at terminal settlement;
- bounded final text/result (maximum 32 KiB UTF-8), stop reason, and stable diagnostic/interruption code.

Do not persist partial ACP chunks, ACP tool inputs, permission payloads, process environment/path, stderr, authentication state, or OpenCode credential material. Host attachment/generation and permission state are live connection state and never durable. The OpenCode session ID is a correlation value only; it is not evidence of resumability.

## Projection and events

- Extend the V4 conversation protocol with a dedicated `externalAgentRun` row kind linked to the canonical `session_input`/`commandId`. It renders the user's submitted text and clearly labeled OpenCode-owned status/result. It is not an `assistantText`, `reasoning`, or ZCode `toolCall` row.
- The live event adapter emits a strict versioned external-run event union with per-run increasing Host `sequence`. Persist the durable record revision and Host event sequence separately: outbox claims, admission acknowledgements, and restart recovery may advance the record revision but must not consume a Host event sequence. The CLI validates the current run ID, owning task, active Host connection generation, and exact next Host sequence before updating the journal and publishing the row delta.
- Same-state `running` updates are Host events only; generic lifecycle transitions cannot accept them or bypass the Host sequence compare-and-set.
- Generic transitions own outbox dispatch and local recovery only. Host-originated `running` and terminal results must use the Host-event compare-and-set; a lost Host may move a nonterminal record to `interrupted` without claiming a Host event.
- Snapshot hydration reads the journal and reconstructs the external-run row. Existing task history remains readable when no such rows exist. A malformed/unknown version becomes a bounded diagnostic row or a typed recovery failure; it must not be converted into assistant output.
- Admission is visible as the canonical user request plus a `pending` external run. Updates to `dispatching`/`running` and terminal state update that same row. Content/tool/permission live updates are volatile and may disappear on restart; only the bounded terminal summary is durable.

## Recovery, idempotency, and retention

- The outbox dispatcher claims `pending` rows using a compare-and-set transition to `dispatching`. `runId` is the Host idempotency key. A retry after response loss first asks `getRunStatus`; it cannot create another ACP session.
- On process restart or owning Host loss, any nonterminal row becomes `interrupted` exactly once, with a stable reason code. The app does not replay text, start a replacement ACP session, or offer “continue this OpenCode session.” A new user submission creates a new command and run ID.
- On successful completion/cancel/failure, transactionally store terminal state and bounded result, clear active ACP session correlation, and release the V4 external foreground-work owner. Duplicate or stale events are no-ops and cannot reopen a terminal row.
- Journal lifetime follows the owning task/session deletion and retention rules. Add indexes for task/run lookup and pending outbox scans. Bound retained records by the existing task-retention policy; no unbounded second history is allowed.

## Required verification

Storage tests must prove atomic rollback of the input + outbox transaction, duplicate command idempotency, monotonic state transitions, maximum result size, stale event rejection, terminal idempotency, restart-to-interrupted recovery, and cleanup on task deletion. Protocol tests must prove round-trip snapshot hydration of the dedicated row and ensure it never enters assistant/tool event reducers. Packaged E2E must show a pending/running/terminal delegated row across app restart while ordinary ZCode rows remain unchanged.
