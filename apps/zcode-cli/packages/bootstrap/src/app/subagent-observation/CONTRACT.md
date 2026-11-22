# CLI subagent observation

This app module owns the shared child-session directory read model used by the Server protocol and the local observation adapter. SessionStore remains the durable source; the module does not restore completed work into `RuntimeTaskRegistry` or start a process.

Invariants:

- Lifecycle status and optional Host PRISM acceptance are separate facts.
- PRISM acceptance is recomputed from exact root-owned entries and active transcript lineage on demand.
- Missing or ambiguous provenance returns `unknown`; storage failure omits optional badges and preserves the directory.
- Transcript replay replaces persisted message bodies for the same streaming message instead of duplicating them.
