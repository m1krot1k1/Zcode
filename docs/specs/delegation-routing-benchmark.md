# Delegation routing benchmark

## Goal

Compare two execution policies on the same tasks:

- **baseline** — the root session does the work inline (the current default for serial tasks);
- **candidate** — the routing gate from `apps/zcode-cli/packages/core/src/subagent/profile.ts`
  (`decideDelegationRoute`) delegates bounded tasks and orchestrates independent workstreams;
  the root keeps only integration and final verification.

The benchmark answers one question: does routing-gated delegation improve time-to-verified-result
without increasing duplicate work or critical regressions? It does **not** assume that more agents
are better.

## Task families

Each family contains paired tasks with the same inputs and acceptance checks:

1. **Single-file bugfix** — one owner, one file; expected `delegate_single`.
2. **Multi-file refactor** — one coherent change across several files; expected `delegate_single`
   with an explicit file boundary, or `orchestrate` only when the files are independent.
3. **Independent research + implementation** — two independent workstreams; expected `orchestrate`.
4. **Serial migration** — each step depends on the previous one; expected `integrate_inline` in the
   root, with delegated verification where possible.
5. **Release pipeline** — version bump, build, release, and verification are serial; expected
   `integrate_inline` in the root.
6. **Duplicate-work probe** — two agents are intentionally given overlapping file scopes; the
   work-ledger must report the overlap and the run must not silently duplicate the edit.

## Metrics

- `success` — the task's acceptance checks pass.
- `durationMs` — wall-clock time to verified result.
- `tokens` — total model tokens for the task.
- `duplicateClaims` — work-ledger claims that overlap another live claim on the same path.
- `criticalRegressions` — failed safety, release, or data-integrity checks.
- `repeats` — how many runs are aggregated into the record; real runs require at least three.
- `synthetic` — `true` for fixtures. Synthetic records are labeled as such and never prove model gains.
- `holdout` — `true` for protected-holdout tasks. A real comparison requires at least one holdout task.

## Protocol

- Same model, tool configuration, workspace, and acceptance checks for both arms.
- At least three repeats per task; use the median for time and totals for tokens.
- Keep a protected holdout of tasks that are not used to tune prompts or routing.
- Record one JSONL line per task and arm:

```json
{"taskId":"single-file-bugfix-1","arm":"baseline","success":true,"durationMs":42000,"tokens":18000,"duplicateClaims":0,"criticalRegressions":0,"repeats":3,"synthetic":false,"holdout":true}
{"taskId":"single-file-bugfix-1","arm":"candidate","success":true,"durationMs":31000,"tokens":15000,"duplicateClaims":0,"criticalRegressions":0,"repeats":3,"synthetic":false,"holdout":true}
```

- Compare the records:

```bash
node scripts/delegation-routing-benchmark.mjs --baseline baseline.jsonl --candidate candidate.jsonl
```

The gate exits non-zero for a rejected candidate: critical regression, lower success, or a median
latency regression above 50%. Real records also need at least three repeats and one holdout task;
otherwise the verdict is `inconclusive`. It prints both arm summaries, paired deltas, `evidence`
(`real` or `synthetic`), `minRepeats`, `holdoutTasks`, reasons, and one of `candidate`,
`inconclusive`, or `reject`. Synthetic records are always labeled and never treated as proof.

## Acceptance

A candidate is accepted only when:

- `criticalRegressions` does not increase;
- `successRate` is not lower than baseline;
- median latency does not regress by more than 50%;
- at least one efficiency metric improves (median time, tokens, or duplicate claims);
- real records have at least three repeats and at least one protected-holdout task.

Otherwise the result is `inconclusive` (no proven gain) or `reject` (regression). Do not present
synthetic fixtures or a single lucky run as evidence of a general capability gain.

## Limitations

- The script compares recorded results; it does not run an LLM and cannot verify that the records
  are genuine.
- Synthetic fixtures test the gate itself, not model behavior.
- A real run needs the packaged app/runtime, the same provider/model, and a budget for repeats and
  a protected holdout.
- Work-ledger overlap is advisory; a zero count does not prove that two agents never edited the
  same file, only that no live claim overlapped at claim time.
