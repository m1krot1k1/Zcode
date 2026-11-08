# Code Intelligence service contract

`ICodeIntelligenceService` is the single owner of local code-index lifecycle and graph/search reads. The Host keeps SQLite under the local ZCode data root's `code-intelligence/` directory, keyed by SHA-256 of `workspaceIdentity?.trim() || workspacePath`; the UI and agent tools only receive relative paths and bounded, sanitized index facts.

## Operations

- `getStatus` reads committed generation metadata and process-local progress.
- `indexWorkspace` performs ignore-aware JS/TS indexing and commits a new generation in one transaction.
- `search` ranks local lexical matches, then optionally reranks with configured vectors. A changed provider, endpoint, or model causes the next index operation to embed all chunks that do not match the full embedding identity.
- `getSymbolContext`, `getImpact`, and `trace` query symbols and dependency edges from the same generation.
- `setEmbeddingConfig` configures or clears Ollama or an OpenAI-compatible endpoint/model and may save or clear an optional API key. It never installs or launches models.
- `clearIndex` closes and removes one identity-scoped database.

## State and failure behavior

SQLite owns non-secret workspace embedding metadata and index data. `ICredentialService` owns the API key under a credential key derived from the workspace identity hash. In-process progress is ephemeral. An index failure rolls back all content changes, records a sanitized diagnostic separately, and leaves the previous committed generation queryable. Repeating a successful index against unchanged files is idempotent. A workspace identity is never inferred from display name. Omitted embedding settings preserve their saved values; null provider/endpoint/model explicitly clears the whole configuration, and `apiKey: null` clears only the key.

## Privacy and resource bounds

Only JS/TS-family source files up to 1 MiB are considered. Root and nested Git ignore rules and `.zcodeignore` apply, along with built-in dependency/build/secret exclusions. Symlinks are skipped. Absolute paths, source-root paths, credentials, and source text are not written to status or diagnostics. Embedding requests send source chunks and search queries to the configured endpoint; Ollama is limited to loopback HTTP, while OpenAI-compatible remote calls require HTTPS except for loopback HTTP. Requests are batched and response order is validated. Search and graph traversals return bounded results without materializing embedding blobs or the entire graph in application memory.
