---
name: completion-gate
description: "Use before reporting a task complete, evaluating acceptance criteria, or joining delegated work that requires evidence."
---

# Completion gate

For every user-requested outcome, mark **pass**, **fail**, or **not run**. Attach the evidence that supports the status: observed UI behavior, command output, source assertion, or external artifact. A planned check, model statement, HTTP status, or unrelated green test is not proof of the requested result.

Check that all requested deliverables are accounted for, regressions were considered, and relevant verification actually ran. State environment blockers plainly. Never convert missing evidence into a pass or claim a release, push, build launch, or client interaction that was not observed.
