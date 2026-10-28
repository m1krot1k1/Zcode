---
name: zcode-swarm
description: Use when planning or coordinating independent work with ZCode Agent subagents, including parallel branches, nested tasks, ownership boundaries, and result synthesis.
---

# ZCode swarm coordination

Use the ZCode runtime's available `Agent` capability and the accepted swarm mode. This skill explains how to plan and join work; loading it does not start agents or prove that a swarm ran.

## Nested capability probe

When the user explicitly asks only to verify recursive `Task` nesting, do not send the probe through the ordinary independence planner. Run one bounded serial chain D1→D5:

1. D1, D2, D3, and D4 each call `Task` exactly once for the next depth, using an exact active profile ID that has `Task` in its current toolset.
2. Each hop carries only the next-depth instruction and a unique depth marker. D5 is a leaf: it reports its marker and calls no tools.
3. Do not add an orchestrator, parallel siblings, or repeated branches. A capability measurement needs one lineage, not an exponential task tree.
4. Report the observed `Task` calls, child session IDs, parent/root lineage, and leaf result. If the runtime cannot expose one of these, label it unverified instead of claiming the depth passed.

For normal requests, continue using the plan below: delegate only independent deliverables with distinct scopes and useful results.

## Plan

1. Split the request into concrete deliverables. Delegate only work that is independent and has a clear result.
2. Give each child a narrow task, relevant context, expected output, and a distinct file or investigation scope. Avoid concurrent edits to the same file.
3. Keep dependencies explicit. Start independent branches together; wait for prerequisites before dependent work.
4. Follow runtime budgets, active-task limits, deadlines, cancellation, and profile permissions. Do not promise unlimited parallelism or depth.

## Join and report

1. Collect every accepted child result and identify failed, cancelled, or incomplete branches.
2. Check important claims against the cited files, command output, or runtime evidence. A child's summary is evidence to inspect, not proof by itself.
3. Reconcile overlaps and resolve incompatible findings before synthesis. Keep a clear distinction between child work and root-owned integration.
4. Report what ran, what changed, what was checked, and any remaining uncertainty. Never claim a branch, tool call, or verification that did not occur.

Respect the workspace instructions and the ZCode runtime's actual tool and profile contracts. This skill does not grant permissions or bypass admission, budget, or cancellation rules.
