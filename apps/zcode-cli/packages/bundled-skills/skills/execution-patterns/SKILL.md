---
name: execution-patterns
description: "Use when choosing between direct work, sequential steps, or parallel named agents and when joining their results."
---

# Execution patterns

- **Direct:** one small, self-contained task or answer-only request.
- **Sequential:** later work depends on an earlier result, migration, or shared edit surface.
- **Parallel:** at least two independently useful deliverables with disjoint ownership. Give each exact role and expected evidence.
- Use the active runtime's concurrency and nesting limits. A prompt cannot raise them. Do not create work only to make the agent count larger.
- Join every branch. Check claims against source or command evidence and report failures or missing results as incomplete.
- Keep integration and final acceptance with the parent that owns the user request.
