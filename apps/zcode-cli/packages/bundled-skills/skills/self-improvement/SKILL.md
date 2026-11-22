---
name: self-improvement
description: Use in ZCode when repeated, observed failures justify a small change to prompts, rules, skills, or evaluation cases.
---

# Evidence-driven harness improvement

Harness changes improve instructions, orchestration, and checks; they do not train model weights or prove that the system improves itself automatically.

## Trigger

Start from a named failure supported by a session, source path, test result, or reproducible behavior. Do not change a prompt merely because it could be phrased differently.

## Procedure

1. Record the observed behavior and the evidence that confirms it.
2. Trace the behavior to one instruction, interface, or check. Mark any uncertain link as a hypothesis.
3. State what the smallest reversible change should alter and how to measure that result.
4. Update the owning spec before changing behavior. Preserve permission, tool, trust, cancellation, and admission boundaries.
5. Add or update a focused evaluation case that fails on the old behavior.
6. Run that case and the repository-required checks; read their actual output.
7. Run the same named check against the baseline and the changed version. State the predicted delta before editing; keep the change only when that delta appears. If the baseline cannot be reproduced, the check cannot run, or the delta is absent, revert the narrow change and report the limitation.
8. Record failed attempts and remaining limitations accurately. Do not treat a green test unrelated to the predicted behavior as evidence of improvement.

Never widen the agent's own permissions, weaken a safety or verification gate, or publish a success claim based only on model output.
