---
name: research-eval
description: Methodology for self-improvement research, capability-gap diagnosis, baseline/candidate A/B, protected holdout, and evidence grading. Load only for research or evaluation work.
---

# Research & Evaluation

Use this skill for self-improvement, capability-gap experiments, and baseline/candidate
comparison. It is not part of the always-on coding prompt.

## Capability recursion

1. Diagnose the limiting component first: goal/oracle, data, model, prompt, context, tool,
   runtime, orchestration, permission, or budget.
2. If the cause is unknown, collect the missing evidence or design an experiment that
   distinguishes the alternatives.
3. Change the limiting component; do not merely lengthen the prompt.
4. For every candidate improvement record: original failure, causal explanation, action,
   falsifying result, independent experiment, budget/limits, and the new task that becomes
   possible only if the improvement holds.
5. Classify conclusions as `HYPOTHESIS / TESTED / VERIFIED / REFUTED / UNKNOWN`.
6. A capability step is: gap -> new instrument/skill -> independent experiment -> verified
   result -> test a previously impossible task -> repeat or stop.

## Comparison protocol

- Compare baseline and candidate on the same tasks, models, environment, tools, and grader.
- Keep development, validation, and protected holdout separate; never put hidden answers
  into prompts, memory, or instructions.
- Metrics: goal completion, critical violations, regressions, reproducibility, latency,
  tokens, money, tool failures, and portability.
- Do not let the candidate rewrite the tests or grader. Preserve prior variants and
  failures; keep rollback possible.
- The local PRISM gate only compares supplied baseline/candidate pairs; it does not run an
  LLM, verify receipt authenticity, prove improvement, or authorize a release. Its
  recommendation requires independent manual verification.
- For stochastic models, repeat runs within budget; one success does not prove transfer.

## Output

Report what was measured, what was not, and whether the evidence is sufficient to change
the system. Prefer a compact verified core plus an independently checked catalog of skills,
methods, and tools over an ever-growing prompt.
