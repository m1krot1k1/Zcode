---
name: zcode-systematic-debugging
description: Use when diagnosing a ZCode runtime, provider, packaging, or application failure and tracing it from a reproducible symptom to a verified fix.
---

# ZCode systematic debugging

Use repository source, the relevant spec, logs, and runtime behavior to separate confirmed causes from hypotheses. If the request is investigation-only, diagnose and report without changing code.

## Workflow

1. **Reproduce:** capture the exact action or command, inputs, environment that matters, and complete relevant error. Confirm whether the failure is repeatable.
2. **Trace:** follow the failing request through its actual owners and interfaces. Inspect the nearest logs and callers; avoid guessing from a UI symptom alone.
3. **Isolate:** form a specific cause, then check it against source or a focused experiment. Change one relevant factor at a time where practical.
4. **Fix:** when implementation is requested, make the smallest change consistent with the spec and existing architecture. Preserve unrelated local work.
5. **Reproduce and verify again:** rerun the original failing path and the focused regression check. Compare the new evidence with the original failure.

Report the confirmed cause, the evidence for it, the fix, and the checks that passed or could not run. Mark unresolved explanations as hypotheses; do not convert a plausible explanation into a verified fact.
