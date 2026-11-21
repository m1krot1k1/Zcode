# Real delegation-routing benchmark run

Date: 2026-11-21. Status: harness implemented; real records are produced by
`scripts/delegation-routing-benchmark-real.mjs`.

## Purpose

The existing `scripts/delegation-routing-benchmark.mjs` only compares recorded JSONL.
This run closes the evidence gap by executing the **built ZCode CLI** on isolated
fixture workspaces and recording real `success`, `durationMs`, `tokens`,
`duplicateClaims`, `criticalRegressions`, `repeats`, `synthetic` and `holdout` values.

It does not change product routing. It answers whether the routing-gated policy is
better than root-inline work on the same tasks.

## Arms

- **baseline** — the root does the work inline. The harness passes
  `--disallowed-tools Task,Agent`, so a spawn is a policy violation and is recorded as
  a critical regression.
- **candidate** — the prompt carries the deterministic routing decision
  (`delegate_single`, `orchestrate`, or `integrate_inline`). Task/Agent remain available:
  - `integrate_inline`: a spawn is a violation; the root must integrate itself.
  - `delegate_single`: at least one `Task` spawn is required; the prompt names the
    worker role.
  - `orchestrate`: the prompt requires `Task(orchestrator)` or two distinct child
    branches; a missing spawn is a violation.

Both arms use the same model, CLI, mode (`yolo`), workspace fixtures and hidden
acceptance checks. The CLI's actual model is recorded from the first
`session.updated.modelSelection` event.

## Fixtures

Six protected-holdout tasks in `scripts/delegation-routing-benchmark-real.mjs`:

| Task                                          | Route              | Acceptance                                                                                   |
| --------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `holdout-single-file-bugfix`                  | `delegate_single`  | slugify handles punctuation, whitespace and repeated hyphens; only `src/slugify.mjs` changes |
| `holdout-multi-file-refactor`                 | `delegate_single`  | shared `clamp` module, both consumers import it, behavior unchanged                          |
| `holdout-independent-research-implementation` | `orchestrate`      | `docs/api.md` plus `multiply`/`divide`; `divide(1,0)` throws `RangeError`                    |
| `holdout-serial-migration`                    | `integrate_inline` | exact `config.v2.json`, unchanged v1, exact `migration.log`                                  |
| `holdout-release-pipeline`                    | `integrate_inline` | version, changelog, build output and unchanged `build.mjs`                                   |
| `holdout-duplicate-work-probe`                | `orchestrate`      | both shared-file fixes, exactly one definition each                                          |

Acceptance scripts live outside the workspace under `<out>/accept/`; the agent never
sees them, so it cannot edit the grader. Fixtures are rewritten for every repeat.

## Metrics and aggregation

Each repeat is a separate CLI process. Per-run evidence is written to `<out>/runs/*.json`
with the parsed stream evidence (spawn tool calls, child roles, claim conflicts, turn
count, acceptance output, response preview). Aggregated records use:

- `success` — every repeat passed acceptance and policy;
- `durationMs` — median wall clock across repeats;
- `tokens` — sum of the CLI-reported `usage.totalTokens` across repeats;
- `duplicateClaims` — overlapping accepted write claims (0; rejected spawns are recorded
  separately as `claimConflicts`);
- `criticalRegressions` — acceptance failures, CLI failures/timeouts and policy
  violations;
- `repeats` — number of runs;
- `synthetic:false`, `holdout:true`.

The aggregated files are passed to the existing gate:

```bash
node scripts/delegation-routing-benchmark.mjs \
  --baseline <out>/baseline.jsonl \
  --candidate <out>/candidate.jsonl
```

## Real-run protocol

```bash
node scripts/delegation-routing-benchmark-real.mjs \
  --tasks holdout-single-file-bugfix,holdout-multi-file-refactor,holdout-independent-research-implementation,holdout-serial-migration,holdout-release-pipeline,holdout-duplicate-work-probe \
  --repeats 3 \
  --out docs/research/delegation-benchmark/2026-11-21
```

A timeout is 360 seconds per run by default. Runs are serial to reduce provider-rate
drift. The fixture workspace is deleted after each run; only parsed evidence remains.

## Acceptance

- The gate returns one of `candidate`, `inconclusive` or `reject`.
- A `candidate` verdict requires equal/higher success, no critical regression, no >50%
  median latency regression, an efficiency win, at least 3 repeats and a holdout task.
- A `reject` is reported as-is; the benchmark does not tune fixtures after seeing the
  holdout result.
- No synthetic records are accepted as proof.

## Limitations

- The harness executes the CLI, but the candidate instruction is still a prompt-level
  routing decision; it does not expose the GUI-only explicit swarm intent. The
  `start`/`orchestrator` profiles and the Task admission path still run in the real
  runtime.
- The protected holdout is the six fixture tasks in this document; prompt or fixture
  changes invalidate previously recorded results and require a new run.
- Token totals come from the CLI summary; they include child model requests when the
  runtime reports them, but the benchmark does not reconstruct per-child billing.
- Stable/notarized macOS release remains blocked by missing Apple Developer ID and
  notarization credentials; this benchmark is independent of packaging.
