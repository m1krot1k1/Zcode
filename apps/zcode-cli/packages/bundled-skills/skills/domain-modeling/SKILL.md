---
name: domain-modeling
description: Use in ZCode to clarify domain language, entities, boundaries, relationships, and invariants; record durable terminology and consequential choices.
---

# Domain modeling

Use this skill when changing domain concepts, defining product behavior, resolving overloaded terms, or recording durable domain decisions. Reading an existing glossary for context does not by itself require this workflow.

## Procedure

1. Read the applicable product specification and inspect the relevant code, public contracts, schemas, and tests. Use available ZCode tools such as `Read`, `Glob`, `Grep`, and, when needed and authorized, `Bash`. Treat user language, existing documents, and code as evidence to compare; do not assume they already agree.
2. Identify the bounded context and its owner. Clarify which terms refer to distinct concepts, who or what has identity, how each concept changes over its lifecycle, and which concepts own state or decisions.
3. Describe the conceptual model in plain language: entities and their identities, value concepts, relationships, boundaries, lifecycle transitions, and invariants. Use concrete scenarios and edge cases to test the model, including missing, repeated, stale, partial, and conflicting inputs where relevant.
4. Trace the proposed model back to the actual ZCode contracts, types, persistence, APIs, and tests. Label what is **observed in the current implementation** separately from what is **proposed**. Surface contradictions and migration implications instead of silently renaming or reshaping concepts.
5. Search for an existing `GLOSSARY-MAP.md`, glossary, and ADR conventions in the relevant context before creating documentation. Update the owning glossary when terminology is resolved and useful beyond the current change. A glossary contains definitions and domain relationships, not implementation details, scratch notes, or unresolved proposals. Create one only when there is a durable term to record, in the repository's established location and format.
6. Record a decision in an ADR only when all three conditions hold: reversing it would have meaningful cost; a future maintainer would otherwise find the choice surprising; and a real trade-off was resolved between alternatives. Reuse the existing ADR location and format. If any condition is absent, keep the rationale in the relevant spec or change discussion instead.
7. Before changing behavior, update the owning specification and define acceptance scenarios there. Make code and documentation edits only within the user's authorized scope, using available ZCode tools such as `Write`, `Edit`, or `ApplyPatch`; never assume a path or tool that the active runtime has not provided.

Ask the user to resolve a domain ambiguity only when competing meanings would materially change behavior or ownership and the available product sources cannot settle it. Otherwise state a bounded assumption and proceed with evidence.
