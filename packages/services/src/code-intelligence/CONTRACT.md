# Code Intelligence service contract

`ICodeIntelligenceService` is the single owner of local code-index lifecycle and graph/search reads. The Host keeps SQLite under the local ZCode data root's `code-intelligence/` directory, keyed by SHA-256 of `workspaceIdentity?.trim() || workspacePath`; the UI and agent tools only receive relative paths and bounded, sanitized index facts.

## Operations

- `getStatus` reads committed generation metadata and process-local progress.
- `watchWorkspace` arms one Host-owned native recursive watcher without crawling the workspace tree, then incrementally reconciles changes missed while the Host was closed; it never creates the first index silently.
- `indexWorkspace` arms the native watcher before scanning, performs ignore-aware JS/TS indexing, and commits a new generation in one transaction. Native watcher events are filtered and debounced; unidentifiable paths conservatively schedule a refresh.
- `search` ranks local lexical matches, then optionally reranks with configured vectors. A changed provider, endpoint, or model causes the next index operation to embed all chunks that do not match the full embedding identity.
- `getSymbolContext`, `getImpact`, and `trace` query symbols and dependency edges from the same generation.
- The scanner resolves named imported calls to unique exported symbols in the target workspace file, including aliases. It also emits `contains` edges from modules to top-level declarations and from declarations to their direct nested declarations, which joins file-level imports to symbol-level calls. Ambiguous or unsupported call forms are omitted; changing either endpoint refreshes the derived edge.
- A persisted graph-parser revision gates one-time graph-only backfills. A revision change reparses unchanged source into symbols and relationship facts, preserves unchanged chunks and vectors, and commits graph data plus the new revision atomically. A failed pass leaves the previous graph generation available; once current, subsequent unchanged refreshes do not repeat the backfill.
- `getGraphOverview` returns a bounded connected overview seeded from a high-degree node or one focused symbol neighborhood, with relative paths and an explicit partial flag; it never returns source excerpts.
- `setEmbeddingConfig` configures or clears Ollama or an OpenAI-compatible endpoint/model and may save or clear an optional API key. It never installs or launches models.
- `testEmbeddingConfig` probes a fixed, non-source batch at the same maximum size used by indexing, with the draft provider config and saved/draft token. It never saves configuration or changes vectors, and returns only a sanitized outcome, dimensions, elapsed time, and (for HTTP failures) the status code; it never returns a provider response body.
- `clearIndex` closes and removes one identity-scoped database.

## State and failure behavior

SQLite owns non-secret workspace embedding metadata and index data. `ICredentialService` owns the API key under a credential key derived from the workspace identity hash. In-process indexing/embedding progress is ephemeral; the last embedding phase (`pending`, `ready`, or `failed`) is persisted so a restart cannot leave a false `building` status. A failed embedding build preserves lexical indexing, records only a safe error category and optional HTTP status in `CodeIndexStatus.embedding.lastError`, and leaves the previous vectors unpublished. The composer index popover prioritizes this error over coverage warnings. Provider response bodies, source text, and credentials never enter diagnostics. Retryable HTTP 429/5xx responses receive at most two bounded retries per batch, respecting a short provider `Retry-After`; a repeated failure remains visible and can be retried by refreshing the index. An index/storage failure rolls back content changes and leaves the previous committed generation queryable. Repeating a successful index against unchanged files is idempotent. A workspace identity is never inferred from display name. Omitted embedding settings preserve their saved values; null provider/endpoint/model explicitly clears the whole configuration, and `apiKey: null` clears only the key.

## Privacy and resource bounds

Only JS/TS-family source files up to 1 MiB are considered. Root and nested Git ignore rules and `.zcodeignore` apply, along with built-in dependency/build/secret exclusions. Symlinks are skipped. Absolute paths, source-root paths, credentials, and source text are not written to status or diagnostics. Embedding requests send source chunks and search queries to the configured endpoint; Ollama is limited to loopback HTTP, while OpenAI-compatible remote calls require HTTPS except for loopback HTTP. Requests are batched and response order is validated. Search and graph traversals return bounded results without materializing embedding blobs or the entire graph in application memory.

The workspace watcher uses one native recursive subscription rather than a per-directory recursive crawl. Unsupported or failed watcher creation is reported and leaves explicit manual refresh available; it does not fall back to a watcher per directory.
