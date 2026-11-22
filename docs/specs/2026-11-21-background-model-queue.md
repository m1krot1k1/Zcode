# Background model request queue

Date: 2026-11-21. Status: implemented in 3.17.142.

## Problem

Autocomplete, proactive suggestions, session/goal titles, and project-memory sidecars
used the same provider admission as the main turn. They could create queued requests
and rate-limit pressure while the user waited for the main answer. The opposite failure
would be worse: a background job must never delay the main turn.

## Ownership

- `apps/zcode-cli/packages/bootstrap/src/app/workflow-concurrency-governor.ts` owns the
  process-level main/background admission counters and wait queue.
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-model.ts` binds the selected
  admission to every model handle.
- `workspace-generate-text.ts` classifies service sidecars by `querySource`.
- `title-generation-sidecar.ts` and `project-memory-agent.ts` explicitly request the
  background admission.

## Rules

1. Background concurrency is **1** by default (configurable 1–2 at governor creation).
2. A background request does not start while the main agent has an in-flight admission
   ticket. It waits in a FIFO queue.
3. The main agent never waits for the background queue: observer tickets are granted
   immediately and keep their existing provider-bucket behavior.
4. A background request releases its slot as soon as its attempt ends; retry backoff does
   not hold a slot.
5. `AbortSignal` cancels a queued request immediately with the signal reason. Existing
   caller timeouts (autocomplete, title, memory) remain the deadline owner.
6. Background classification is explicit:
   `chat_autocomplete`, `proactive_suggestion`, `session_title`, `goal_summary_title`,
   `project_memory_extract`, `project_memory_dream`.
7. Prompt enhancement, git commit messages, swarm planning, and user-visible main work
   stay on the main admission.
8. Background tickets are not attached to workflow buckets: the goal is main-turn
   isolation, not workflow fan-out capacity.

## Acceptance

- While a main ticket is held, `background.tryAcquire` misses and `background.acquire`
  remains pending.
- Releasing the main ticket wakes exactly the background waiters up to the background
  limit.
- A second background request waits while the first is in flight.
- Aborting a queued background request rejects it without leaking the waiter.
- Main requests still acquire immediately while background requests are queued/running.
- `chat_autocomplete` selects the background admission; `swarm_planner` selects main.
- Title and memory sidecars use the background admission.

## Evidence

- `apps/zcode-cli/packages/bootstrap/tests/workflow-concurrency-governor.test.ts`
- `apps/zcode-cli/packages/core/tests/workspace-generate-text-streaming.test.ts`

## Not in this pass

Provider-bucket integration for background tickets and per-workspace fairness are not
enabled. The main turn has absolute priority; background work is best-effort by design.
