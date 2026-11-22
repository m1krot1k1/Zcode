# Delegation routing: real A/B benchmark (2026-11-21)

Status: **completed real run**. Verdict from the gate: **reject** (median latency
regression above 50%). Both arms passed every acceptance check with zero critical
regressions.

- CLI: `apps/zcode-cli/packages/cli/dist/zcode.cjs`
- Model reported by the runtime: `deepseek/deepseek-flash`, reasoning `max`
- Git HEAD at run start: `c53a8cdf9584c4a47171d9c8c712668c97a44448`
- Repeats: 3 per task/arm; 6 protected-holdout tasks; 36 real CLI runs
- Raw record files: `baseline.jsonl`, `candidate.jsonl`, `runs.jsonl`, `runs/`
- Gate report: `report.json` / `report.txt`

## Result

| Arm                       | Success |           Median latency |          Total tokens | Critical regressions | Duplicate claims |
| ------------------------- | ------: | -----------------------: | --------------------: | -------------------: | ---------------: |
| baseline (root inline)    |    100% |              24 499.5 ms |             3 172 822 |                    0 |                0 |
| candidate (routing-gated) |    100% |                77 715 ms |             3 929 907 |                    0 |                0 |
| delta                     |       0 | **+53 215.5 ms (+217%)** | **+757 085 (+23.9%)** |                    0 |                0 |

The candidate improved neither latency nor tokens on this task set. The gate rejects a
median latency regression above 50%; the observed regression is far beyond that.

## Per task

| Task                                          | Route              | Baseline median / tokens | Candidate median / tokens | Candidate spawns (3 runs) | Acceptance |
| --------------------------------------------- | ------------------ | -----------------------: | ------------------------: | ------------------------: | ---------- |
| `holdout-single-file-bugfix`                  | `delegate_single`  |      21 978 ms / 525 981 |       80 637 ms / 647 059 |                 1 / 1 / 1 | pass       |
| `holdout-multi-file-refactor`                 | `delegate_single`  |      26 350 ms / 560 644 |       74 793 ms / 647 821 |                 1 / 1 / 1 | pass       |
| `holdout-independent-research-implementation` | `orchestrate`      |      23 933 ms / 429 134 |      195 057 ms / 499 392 |                11 / 7 / 7 | pass       |
| `holdout-serial-migration`                    | `integrate_inline` |      29 166 ms / 617 935 |       26 999 ms / 763 619 |                 0 / 0 / 0 | pass       |
| `holdout-release-pipeline`                    | `integrate_inline` |      25 066 ms / 534 431 |       23 089 ms / 626 318 |                 0 / 0 / 0 | pass       |
| `holdout-duplicate-work-probe`                | `orchestrate`      |      23 690 ms / 504 697 |      200 581 ms / 745 698 |                 9 / 7 / 5 | pass       |

All 36 runs finished; none timed out. Baseline never spawned a child (`Task/Agent`
denied). Candidate followed the expected route in every task: it spawned for
`delegate_single`/`orchestrate` and stayed inline for `integrate_inline`.

The duplicate-work probe recorded **4 claim-conflict events** across its three candidate
runs. The registrar rejected overlapping write claims rather than silently duplicating
edits; the final file had exactly one definition of each function and acceptance passed.
Because rejected claims are not accepted overlapping claims, `duplicateClaims` remains 0.

## Interpretation

- For a **single bounded file** and a **small multi-file refactor**, delegation costs
  roughly 3-4x latency for no success gain and more tokens. The routing gate's
  `delegate_single` route was the expected route in the plan, but the measured policy is
  not efficient at this task size.
- For **independent research + implementation**, delegation is the worst latency case
  (about 8x) and still uses more tokens; multiple child turns add overhead without a
  correctness gain.
- For **serial migration** and the **release pipeline**, the gate correctly chooses
  `integrate_inline`: latency is roughly neutral, but tokens are still 17-24% higher.
- The **duplicate-work probe** confirms the work-ledger gate is active, but repeated
  overlapping attempts make the candidate ~8x slower.

This is evidence against the current routing policy on small tasks, not evidence for
more delegation. Any policy change based on these holdout results would invalidate this
holdout; a future candidate must be validated on a **new** protected holdout.

## Evidence and reproduction

Run command:

```bash
node scripts/delegation-routing-benchmark-real.mjs \
  --tasks holdout-single-file-bugfix,holdout-multi-file-refactor,holdout-independent-research-implementation,holdout-serial-migration,holdout-release-pipeline,holdout-duplicate-work-probe \
  --repeats 3 \
  --out docs/research/delegation-benchmark/2026-11-21
```

Gate command (run by the harness):

```bash
node scripts/delegation-routing-benchmark.mjs \
  --baseline docs/research/delegation-benchmark/2026-11-21/baseline.jsonl \
  --candidate docs/research/delegation-benchmark/2026-11-21/candidate.jsonl
```

The per-run `runs/*.json` files contain the parsed spawn evidence (agent roles, tool call
IDs, claim conflicts, turn count), acceptance output and a short response preview. Raw
model streams are not committed.

## Caveats

- Candidate routing is prompt-level: the harness passes the deterministic route to the
  root. The real `start`/`orchestrator` profiles, Task admission and work-ledger still run
  in the CLI runtime, but the GUI-only explicit swarm intent is not exercised.
- The suite is six small fixtures, not the full 12-task plan allocation. It is a real
  protected holdout for this run, not a universal model-capability claim.
- Token totals are the CLI-reported totals across repeats; they include child requests
  when the runtime reports them.
- Stable/notarized macOS packaging remains blocked by missing Apple Developer ID and
  notarization credentials; it is unrelated to this benchmark.
