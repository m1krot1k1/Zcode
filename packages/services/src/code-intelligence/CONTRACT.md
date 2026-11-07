# Code Intelligence service contract

`ICodeIntelligenceService` is the single owner of local code-index lifecycle and graph/search reads. The Host keeps SQLite under the local ZCode data root's `code-intelligence/` directory, keyed by SHA-256 of `workspaceIdentity?.trim() || workspacePath`; the UI and agent tools only receive relative paths and bounded, sanitized index facts.

## Operations

- `getStatus` reads committed generation metadata and process-local progress.
- `indexWorkspace` performs ignore-aware JS/TS indexing and commits a new generation in one transaction.
- `search` ranks local lexical matches, then optionally reranks with configured local vectors. A changed model causes the next index operation to embed all chunks that do not match the configured model.
- `getSymbolContext`, `getImpact`, and `trace` query symbols and dependency edges from the same generation.
- `setEmbeddingConfig` configures or clears a loopback HTTP endpoint/model. It never installs or launches models.
- `clearIndex` closes and removes one identity-scoped database.

## State and failure behavior

SQLite is the persistence owner. In-process progress is ephemeral. An index failure rolls back all content changes, records a sanitized diagnostic separately, and leaves the previous committed generation queryable. Repeating a successful index against unchanged files is idempotent. A workspace identity is never inferred from display name. Omitted embedding settings preserve their saved values; `null` explicitly clears the whole embedding configuration.

## Privacy and resource bounds

Only JS/TS-family source files up to 1 MiB are considered. Root and nested Git ignore rules and `.zcodeignore` apply, along with built-in dependency/build/secret exclusions. Symlinks are skipped. Absolute paths, source-root paths, credentials, and source text are not written to status or diagnostics. Embedding calls are limited to the validated loopback endpoint and are batched. Search and graph traversals return bounded results without materializing embedding blobs or the entire graph in application memory.
