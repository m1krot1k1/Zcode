# agent-workbench

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

不变量：

- Profiles 来自 `subagentsService.list`，роль, enabled state, source и skill names отображаются как read-only snapshot; editing remains in the existing subagent settings surface.
- Code index lifecycle and graph/search facts come only from `codeIntelligenceService`; UI never reads SQLite, scans paths, or persists a second copy of service state.
- Model settings owns embedding provider configuration and transient token entry. The composer context control opens the index status/search popover; Usage Stats owns the full bounded Code Graph explorer.
- The graph panel calls `search`, `getSymbolContext`, `getImpact`, and `trace`; its embedding form selects Ollama or OpenAI-compatible, submits endpoint/model plus a transient optional API key, and never reads a saved key back. Empty key input preserves the saved value; a separate action clears only the key, and another action clears the full embedding configuration.
- The Usage Stats Code Graph reads only bounded `getGraphOverview` results plus `getStatus`/`search` through `codeIntelligenceService`; selecting a search hit focuses its immediate callers and dependencies. The renderer never reads SQLite or loads an unbounded graph.
- The Code Graph shows a loading label instead of fabricated zero counts until `getStatus` succeeds. A failed initial status read has a visible retry state. Graph controls follow the active theme and its minimap stays secondary to the canvas.
- Embedding test errors show a safe category and HTTP status when the provider returned one; provider response bodies and credentials stay inside the service boundary.
- Workspace identity is passed unchanged to both services. A missing index service is an explicit unsupported state.
- Live child lineage is still owned by the active conversation projection and existing subagent directory. This panel does not synthesize or cache run state.
- The dashboard composes the existing subagent directory for the active task and reads capacity values through `useSettings`; it remains a read-only projection of those owners.
