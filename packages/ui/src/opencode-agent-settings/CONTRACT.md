# opencode-agent-settings

Separate OpenCode CLI agent surface embedded in Model Providers settings. It consumes the process-owning Host service for the active workspace through `useServices()` and never adds a model to ZCode Provider Registry or conversation state. Source Server workspaces use the authenticated server Host; legacy desktop-attached remote and phone workspaces do not use the Desktop Local Host's CLI.

不变量：

- Opening settings or checking diagnostics never starts ACP or creates a durable OpenCode session.
- A session starts only from the explicit Start button and uses a workspace path owned by the active process-owning Host. The local directory picker is used only for local workspaces; Source Server passes its server-owned workspace path through its server Host service.
- Transcript, composer, cancellation and status are separate from the ZCode composer/session.
- The panel explains that OpenCode owns tools, permissions, workspace changes, authentication and rate limits.
- Only the Host's typed `opencode.auth-required` diagnostic prompts the user to run OpenCode's own `opencode auth login`; model discovery remains `not-checked` and never infers sign-in state.
- Model/agent selectors only use live ACP `configOptions`; model changes use `session/set_config_option` and replace the complete option set.
- If ACP provides no selectable model, show OpenCode default and require explicit confirmation before the first prompt.
