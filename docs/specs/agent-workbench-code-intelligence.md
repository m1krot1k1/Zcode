# Agent Workbench and local code intelligence

## Owners and data flow

- One new managed `packages/services` module owns code-index lifecycle, workspace-scoped local persistence, hybrid search, relationship queries, and index status. UI reads/writes through the existing service hook boundary; UI and renderer never open the database or index files. The Host exposes bounded read-only graph queries to agent runtimes through the existing agent protocol; the CLI never opens the host database directly.
- Index identity is `workspaceIdentity?.trim() || workspacePath`. Database filenames use a stable hash of that identity under the local ZCode data root (`~/.zcode/code-intelligence/`, or the configured data root). Records store normalized workspace-relative paths, file fingerprints and change metadata, parser/index version, symbol/call/dependency edges, text chunks, embedding model identity, and vectors. Credentials, ignored files, and absolute paths are never indexed.
- SQLite is the embedded durable store and lexical/metadata index. Embeddings are stored locally in the same workspace DB. Vector generation is pluggable: local model endpoints are supported; if no embedding provider is configured, code/symbol/lexical search remains available and the UI reports semantic search as unavailable. No Qdrant service is required for the default install.
- File discovery and parsing are asynchronous and generation-based. The service applies ignore rules from each directory, extracts symbols and import/call edges, embeds changed chunks, then publishes one committed generation. A changed embedding model schedules every indexed chunk for re-embedding; a cancelled or failed generation cannot replace the last usable index. Change detection includes size, mtime, ctime, and the persisted content fingerprint. File changes enqueue incremental refreshes; a full rebuild is explicit.
- The Host API is `getStatus`, `indexWorkspace`, `search`, `getSymbolContext`, `getImpact`, `trace`, `setEmbeddingConfig`, and `clearIndex`. Every operation except `clearIndex` is read-only or idempotent for the same workspace contents/configuration. `indexWorkspace` resolves only after its SQLite transaction commits; a failure rolls back data and publishes a diagnostic while preserving the previous generation. `clearIndex` removes only the database selected by the workspace identity hash.
- Status is a projection of committed database metadata plus the current in-process indexing operation. It exposes state, generation, timestamps, file/chunk/symbol/edge counts, progress, embedding model/readiness, and sanitized diagnostics; it never exposes a database path, absolute source path, endpoint credential, or source text.
- Search accepts a query and bounded result count. It returns relative path, line range, symbol name/kind when known, a short safe excerpt, and whether the match came from lexical or semantic ranking. Semantic ranking is attempted only when a loopback embedding endpoint and model are configured and stored vectors match that model; failures fall back to lexical ranking and appear in diagnostics.
- `setEmbeddingConfig` accepts a loopback HTTP endpoint and model name, or clears the configuration. An omitted field preserves its current value; explicit `null` clears the configuration. It does not fetch or install a model. Endpoint credentials, non-loopback hosts, and non-HTTP schemes are rejected. The default configuration is unset, so indexing never downloads or starts a model implicitly.
- Symbol extraction is TypeScript compiler API based for JS/TS source. Imports create module dependency edges; named declarations are stored with relative source locations. Call edges are best-effort and only emitted when a local declaration can be resolved without guessing. Results mark graph coverage partial when the parser cannot resolve an edge.
- GitNexus-style capabilities are implemented behind our own contracts: symbol context, callers/dependencies, impact from a diff, paths between symbols, and semantic/lexical code query. The Workbench dashboard exposes all graph queries, and a read-only `CodeIndex` agent tool exposes search, symbol context, impact, and trace through a strict protocol request scoped to the connected workspace. Query results are bounded and relative-path-only. We do not copy GitNexus source or add it as a runtime dependency.

## Agent dashboard

- A dedicated Agent Workbench view is the read model for live and recent Swarm runs, named role/profile, attached skills, selected model, child lineage, queue/active capacity, and explicit failure/deadline reasons. Runtime journal/registry and SubagentsService remain authoritative; dashboard does not invent a second mutable run state.
- The Code Intelligence area shows per-workspace index state (unindexed/indexing/ready/degraded), indexed file/chunk/symbol/edge counts, embedding model, last successful generation, progress, diagnostics, and actions for index, refresh, and clear. Search results show relative file paths and expose context, impact, and trace queries; source text remains bounded excerpts.
- The dashboard is available in Desktop and Web where the host provides the code-intelligence service. Unsupported hosts show an explicit unavailable state and do not attempt local filesystem access.
- The initial dashboard surface is workspace-scoped and contains profile roster (role, source, enabled state, attached skill names), current spawn/parallel/minimum-runtime settings, the active task's existing subagent directory projection, local code-index controls/status, and code search. Live run lineage remains read from the existing session subagent projection in its owner conversation; the dashboard embeds that projection and does not duplicate its state.

## Privacy, capacity, and failure

- Default excludes include VCS metadata, dependencies/build outputs, generated bundles/maps, secrets/private keys, and the repository's ignore rules. The service applies size limits and language allowlists before reading content.
- Workspace index data is local and removable per workspace. Workspace removal does not remove agent profiles or task journal data.
- Concurrency is bounded by the user-selected maximum and an adapter-level safe upper bound. `0` means adaptive concurrency, never unlimited uncontrolled file/model fan-out. Spawn count remains a separate root-run budget; the dashboard displays both values and why a task was rejected.
- Index/search errors preserve the last committed generation and are visible as diagnostics. Missing embeddings, parser coverage gaps, stale index, and unsupported languages are distinct states.

## Acceptance scenarios

- Workspace identity separates indexes for two remote workspaces that share a display path; local identity falls back to canonical workspace path.
- An incremental refresh updates only changed files and atomically publishes a complete generation; cancellation/failure leaves the last committed index queryable.
- Updating a dependency file preserves inbound imports from unchanged files because module IDs are stable by relative path; outgoing edges for changed files are rebuilt without reloading all indexed chunk text into memory.
- Ignored, secret-like, over-size, and unsupported files do not enter chunks, graph, or embeddings.
- Lexical and symbol search work without an embedding provider; semantic search uses locally stored vectors when configured and reports model identity.
- Changing the embedding model re-embeds unchanged chunks; saving one embedding field while omitting the other preserves the saved value, while explicit clear removes configuration and vectors.
- The agent `CodeIndex` tool is read-only, can only query the workspace bound to its Host connection, and returns bounded relative paths and excerpts; it is unavailable when the Host does not provide code intelligence.
- Same-size edits with a preserved mtime refresh through filesystem change metadata and update the content fingerprint, symbols, edges, chunks, and vectors.
- Nested ignore rules prevent matching files from being read into the index.
- Endpoint configuration rejects remote URLs, embedded credentials, invalid model names, and non-HTTP schemes; a failed local model request leaves the previous committed generation searchable.
- Impact, context, and trace results identify the supporting symbols/files and return an explicit partial result when parser coverage is incomplete.
- Dashboard rows use the authoritative Swarm run ID and role profile ID; profile edits affect later runs only.
- Removing a workspace index deletes only that workspace's index artifacts.
