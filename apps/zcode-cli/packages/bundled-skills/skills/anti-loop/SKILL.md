---
name: anti-loop
description: Use in ZCode when planning nested delegation or repeated attempts; compare the task, evidence, scope, and remaining runtime budget before spawning again.
---

# Anti-loop delegation

Use this as planning guidance. ZCode's runtime admission, permissions, cancellation, and task limits remain authoritative; this skill cannot raise or bypass them.

## Before delegating

1. State the concrete artifact or evidence the child must produce.
2. Check the task ancestry for the same objective, target, and acceptance condition. A reworded prompt or a different role does not make duplicate work independent.
3. Give each child a distinct scope. If a child must delegate, its subtask must be narrower and have a named role available in the current conversation.
4. Start only the independent branches that fit the runtime's current concurrency and resource limits. Keep time and token budget for joining and checking their results.

## When work repeats

- First repeat: narrow the task to the observed failure and make one focused retry.
- Second repeat: change the method or report the missing evidence needed to continue.
- If there is no new artifact, test result, or narrower scope, stop spawning and summarize the blocker.

## Capability checks

Test nested delegation with a bounded runtime fixture that launches one named child at each required depth and returns a unique marker. Verify lineage, tool availability, inherited context, and termination independently. Do not multiply branches merely to prove that another nesting level exists; runtime depth, parallelism, and total work are separate properties.
