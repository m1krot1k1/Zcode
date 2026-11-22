---
name: deep-task-contract
description: Use when a task is complex, ambiguous, high-stakes, or the user asks for a deep rather than a larger answer. Forces primary-source research, expert method selection, falsifiable evidence, and independent verification.
---

# Deep task contract

Use this skill for substantial research, architecture, prompt-system, or debugging work. Do not load it for a trivial lookup or a one-line fix.

## Before proposing or rewriting

1. **What would a leading specialist do that the user did not ask for?** Name the missing inventory, measurements, controls, or failure analysis, not more deliverables.
2. **What raw sources would they use instead of a prepared summary?** Prefer source files, command output, traces, primary references, specs, and raw datasets over generated reports or memory.
3. **Which methods and tools would they apply?** Name the concrete method: ablation, baseline/candidate A/B, holdout, trace analysis, token/cache profiling, static analysis, differential testing.
4. **What independent evidence would confirm or refute the result?** Prefer external graders, tests, exit codes, diffs, runtime state, repeated runs, and blind review over agent self-report.

## Rules

- Separate `HYPOTHESIS`, `TESTED`, `VERIFIED`, `REFUTED`, and `UNKNOWN`.
- Do not invent percentages. Mark every estimate and attach the experiment that could falsify it.
- Do not expand scope merely to look thorough. Prefer one verified depth increase.
- Preserve the user's explicit constraints, model choice, permissions, and irreversible-action boundaries.
- Do not let the candidate author rewrite the tests or the grader and then declare victory.
- If the evidence is insufficient, say so and name the cheapest decisive experiment.

## Output

Return a compact map: claim -> raw source -> method -> independent evidence -> confidence -> next decisive check. Then produce the requested artifact (plan, rewrite, code change) only when it follows from that map.

## Context ledger

For multi-step work, maintain `.zcode/context-ledger.json` with `goal`, `constraints`, `decisions`, `facts[{claim,evidence}]`, `openQuestions`, `changedFiles`, and `nextActions`. The runtime injects it as a compact system-context section; keep it current and do not use it as a transcript.
