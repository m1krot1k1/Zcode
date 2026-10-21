# opencode-agent-settings

Separate local OpenCode CLI agent surface embedded in Model Providers settings. It consumes the local Desktop Host service through `useServices()` and never adds a model to ZCode Provider Registry or conversation state.

不变量：

- Opening settings or checking diagnostics never starts ACP or creates a durable OpenCode session.
- A session starts only from the explicit Start button and uses a local workspace directory selected through `IPlatformService`.
- Transcript, composer, cancellation and status are separate from the ZCode composer/session.
- The panel explains that OpenCode owns tools, permissions, workspace changes, authentication and rate limits.
- Model/agent selectors only use live ACP `configOptions`; model changes use `session/set_config_option` and replace the complete option set.
- If ACP provides no selectable model, show OpenCode default and require explicit confirmation before the first prompt.
