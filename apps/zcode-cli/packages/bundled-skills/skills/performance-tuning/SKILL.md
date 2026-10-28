---
name: performance-tuning
description: Use when a ZCode feature is measurably slow, resource-heavy, or oversized and needs a focused optimization with comparable before-and-after evidence.
---

# Performance tuning

Optimize an observed bottleneck, not an intuition. A change is not a performance improvement until the same representative workload has been measured before and after it.

## Measure first

1. Define the user-visible scenario and the metric that matters: for example, time to first frame, interaction latency, request duration, memory, CPU, or shipped bundle size. State the acceptance target when one is known.
2. Find the owning package's existing benchmark, trace, profiler, performance test, or diagnostic procedure. Use `Read`, `Grep`, and `Glob` to inspect those contracts, and `Bash` to run the repository's declared commands. Do not invent a benchmark or assume a profiler is installed.
3. Capture a baseline on the same build mode, data shape, environment, and workload that will be used after the change. Record the command or observation, repetitions where the procedure requires them, and the result. If no reliable baseline can be collected, stop before optimization and report what measurement is missing.
4. Use the trace or profile to locate the highest-impact bottleneck. Distinguish startup from steady state and hot paths from cold paths; do not infer a bottleneck from source appearance alone.

## Make a focused change

1. Read the owning specification and follow the package's architecture. Change the smallest mechanism that addresses the measured bottleneck.
2. Avoid speculative caching, broad memoization, or unrelated cleanup. Account for cache invalidation, memory growth, cancellation, and the cost shifted to other users or phases.
3. Preserve functional behavior and add or update a focused regression check for the affected path.

## Compare and report

1. Re-run the same workload and measurement procedure under comparable conditions. Compare before/after values and variability; include secondary costs such as memory, cold start, bundle size, or error rate when relevant.
2. Run the affected package checks and inspect their output. Performance evidence does not replace correctness, type, lint, or integration verification.
3. Keep the change only when the target metric improves as predicted without an unacceptable regression. If results are noisy, inconclusive, or the baseline could not be reproduced, say so rather than calling it faster.
4. Report the bottleneck evidence, baseline and candidate measurements, exact commands or observed runtime conditions, functional checks, and remaining uncertainty. Do not claim an unmeasured gain or use subjective wording such as “feels faster” as proof.
