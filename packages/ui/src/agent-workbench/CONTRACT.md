# agent-workbench

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

不变量：

- Profiles 来自 `subagentsService.list`，роль, enabled state, source и skill names отображаются как read-only snapshot; editing remains in the existing subagent settings surface.
- Code index lifecycle and graph/search facts come only from `codeIntelligenceService`; UI never reads SQLite, scans paths, or persists a second copy of service state.
- Model settings owns embedding provider configuration and transient token entry. When a local workspace is available, its provider navigation exposes an Embeddings entry under Workspace intelligence and renders the settings in the selected detail pane. Testing a draft keeps the token in the password field so the user can save it afterward; a successful save or explicit clear removes it from the field, and saved credentials are never read back. The composer context control opens the index status/search popover; a dedicated Code Graph section immediately below Usage Stats owns the full bounded explorer.
- The embedding detail calls the code-intelligence service to select Ollama or OpenAI-compatible, submit endpoint/model plus a transient optional API key, and never read a saved key back. Testing never discards the draft key; empty key input preserves the saved value; a separate action clears only the key, and another action clears the full embedding configuration. The graph panel calls `search`, `getSymbolContext`, `getImpact`, and `trace`.
- The Code Graph section reads only bounded `getGraphOverview` results plus `getStatus`/`search` through `codeIntelligenceService`; selecting a search hit focuses its immediate callers and dependencies. The renderer never reads SQLite or loads an unbounded graph.
- The Code Graph shows a loading label instead of fabricated zero counts until `getStatus` succeeds. A failed initial status read has a visible retry state. It retains the last successful graph during refresh/failure, rejects stale asynchronous responses, reloads on generation changes, and keeps empty-index, filtered-empty, loading, and failure states distinct. Node-kind and call/import filters affect only the displayed bounded slice. Graph controls follow the active theme and its minimap stays secondary to the canvas.
- Partial coverage and skipped-file diagnostics use a collapsed neutral disclosure. Real service/provider failures remain visible with semantic error styling.
- Embedding test errors show a safe category and HTTP status when the provider returned one; provider response bodies and credentials stay inside the service boundary.
- Failed bulk embedding builds expose only a safe category and optional HTTP status in the Code Index status. The composer popover shows that actionable error before partial-coverage warnings; lexical search remains available, and Refresh retries the index.
- Workspace identity is passed unchanged to both services. A missing index service is an explicit unsupported state.
- Live child lineage is still owned by the active conversation projection and existing subagent directory. This panel does not synthesize or cache run state.
- The dashboard composes the existing subagent directory for the active task and reads capacity values through `useSettings`; it remains a read-only projection of those owners.
