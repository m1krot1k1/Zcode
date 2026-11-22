# Agent roster and parallel orchestration

Status: active (2026-11-22, release 3.17.153)

This spec extends the existing capability-gated subagent system. It does not replace the
`Task`/`Agent` runtime, the task DAG, or admission; it makes the roster broader and makes
the parallel intent explicit at every level.

## 1. Built-in roster

The built-in roster contains **24 profiles**:

- routers: `start`, `orchestrator`;
- evidence: `researcher`, `planner`, `architect`;
- implementation: `implementer`, `coder`, `frontend-coder`, `backend-coder`,
  `infra-coder`, `data-engineer`, `ml-engineer`, `mobile-coder`,
  `performance-engineer`, `migration-engineer`, `docs-writer`;
- quality: `reviewer`, `security-reviewer`, `test-engineer`, `evaluator`;
- evolution: `self-improver`, `knowledge-curator`, `subagent-factory`.

`packages/shared/src/subagent-catalog/builtInAgents.ts` is the UI/Services projection.
`apps/zcode-cli/packages/core/src/subagent/built-in-profiles.ts` owns the runtime prompts
and tool surfaces; `specialistProfiles.ts` owns the specialty data so the main module
stays below the 800-line policy. The bootstrap contract test keeps the two projections
identical (name, description, color, tools, skills, `injectAgentsMd`, memory).

## 2. Nested delegation

Nested delegation is a runtime capability, not a prompt trick:

- `start` and `orchestrator` are routers. They receive `Task`, `TodoRead`, `TodoWrite`
  only and never read or modify the repository themselves.
- A worker may spawn narrower workers/researchers for genuinely independent parts of its
  assigned area. Children may themselves delegate until a concrete deliverable is done.
- Router roles cannot be spawned by a subagent; this prevents recursive routing loops.
- There is no artificial depth cap. Capacity, cancellation, permissions, token/context
  limits, and the task-DAG admission are the real bounds. A child must not invent depth,
  wave, or time budgets.
- Every handoff carries `status`, `files`, `tests`, `evidenceRefs`, `unresolved`, and an
  optional `nextOwner` only for partial/blocked/failed work.

## 3. Parallelism

Parallelism has three independent layers:

1. **Agent fan-out** — independent leaves are emitted in the same assistant message.
   `resolveSubagentMaxParallel` clamps the DAG width to actual free worker slots; the
   runtime scheduler starts all ready nodes of a wave concurrently.
2. **Tool fan-out** — the tool scheduler runs independent calls in parallel groups
   (default ceiling 10). Read/Grep/Glob/CodeIndex and inspection Bash are independent by
   default; destructive/stateful tools serialize. The system prompt requires independent
   calls in one response.
3. **Nested fan-out** — a worker batches independent tool calls and may spawn independent
   child leaves in the same message. The parent owns integration and verification; it
   does not serialize work that has no dependency.

`/start` behavior:

- A single bounded deliverable goes directly to the closest worker.
- Two or more independent deliverables go to `orchestrator` in one Task call with a
  `task_graph`; independent leaves share a wave and `max_parallel` follows host capacity.
- The root calls `Task(start)` only. `start` never implements the task inline.
- `/start` keeps the user's language, constraints, authorization, acceptance checks, and
  known facts in the envelope; it does not add fake depth or budget fields.

## 4. Acceptance

- The shared/runtime roster contract passes for all 24 profiles.
- `SWARM_AGENT_TYPES`, `BUILT_IN_MAX_TURNS`, `ROLE_EVIDENCE_LINES`, and the shared
  summaries all include every new role.
- A subagent caller cannot spawn `start` or `orchestrator`; a worker still receives
  `Task` and can spawn a non-router child.
- The tool scheduler produces a parallel group for independent read-only calls and a
  serial group for `Edit`/`Bash`-mutation calls.
- `/start` prompt contains the parallel fan-out and same-message tool-batch rules.
- `built-in-profiles.ts` remains below 800 lines; `specialistProfiles.ts` is the only
  added data module.
