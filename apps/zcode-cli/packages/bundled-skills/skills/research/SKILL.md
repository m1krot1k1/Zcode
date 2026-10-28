---
name: research
description: Use in ZCode to investigate with traceable primary evidence, cite material claims, and distinguish facts from hypotheses.
---

# Evidence-led research

Use this skill when an answer depends on project sources, external documentation, current facts, or competing claims.

## Procedure

1. Define the question, scope, and decision the research should support. Note any time-sensitive parts and what would count as a useful answer.
2. Start with sources that own the claim: project specifications and implementation, official product or API documentation, standards, original papers, or first-party data. Treat search snippets, summaries, and other agents' reports as leads, not evidence.
3. Use only tools available to the current ZCode role. For workspace material, use `Read`, `Glob`, and `Grep`; use `Bash` only for a bounded inspection command that the task permits. For public sources, use `WebSearch` to locate material and `WebFetch` to inspect a result when those tools are available. Do not assume a tool or external connection exists.
4. Follow each important claim to the source passage, symbol, or data that supports it. Prefer independent primary sources for consequential or disputed claims. Record publication/update dates when recency matters and note inaccessible or incomplete sources.
5. Report findings with explicit labels:
   - **FACT** — directly supported by an inspected source; cite a local path and line/symbol or a direct URL beside the claim.
   - **HYPOTHESIS** — an inference that is not established by the evidence; state what evidence would confirm or reject it.
   - **UNKNOWN** — the available sources do not settle the point.
6. Separate evidence from interpretation. When sources disagree, describe the conflict and the source authority/date; do not silently choose the convenient claim. State limits on coverage and confidence.
7. Write a Markdown research note only when the user asks for a saved artifact or an accepted deliverable requires one. Use the requested path or the repository's established location and format; do not invent a new permanent knowledge store. Use `Write`, `Edit`, or `ApplyPatch` only when the task authorizes writing.
8. Delegate with `Task` or `Agent` only if the current role actually has that tool and the work divides into independent questions with distinct evidence. Give each branch a bounded question and require cited findings; verify load-bearing claims against the source yourself before synthesis.

Never present an uninspected search result or a model-generated statement as a verified fact. Do not expose secrets or private user data in research notes.
