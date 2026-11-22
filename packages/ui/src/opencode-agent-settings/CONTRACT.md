# OpenCode CLI provider settings

The ordinary conversation Composer is the OpenCode CLI provider/model selection surface. The owning Host discovers the local CLI and its available models, then publishes `opencode` as an ordinary local-auth Provider Registry entry. The Composer persists the selection as the standard `ModelSelection` and sends it through the normal conversation command/runtime. OpenCode Go and other API providers remain separate API-backed Provider Registry entries.

This settings module owns the user's persisted enablement preference, installing the local CLI, and showing actionable fixed diagnostics. Enablement is a preference and may be saved while the CLI is missing; the Host must still verify the CLI and model catalog before publishing OpenCode as selectable in Composer. It does not host model selection, a workspace field, a Start session action, a second transcript, or a separate prompt box. The Composer's active workspace binding supplies the Host and working directory. Source Server workspaces use their authenticated server Host; legacy desktop-attached remote and phone workspaces do not use the Desktop Local Host's CLI.

不变量：

- Settings and Composer model discovery do not start ACP or create a durable OpenCode session.
- Sending a Composer message uses the active workspace Host and the standard ZCode run lifecycle; the provider adapter uses OpenCode's own CLI/server and authentication.
- Composer transcript and Stop/cancel behavior remain in the normal ZCode conversation.
- OpenCode owns tools, workspace changes, authentication and provider rate limits; do not bypass or infer their state.
- Only the Host's typed `opencode.auth-required` diagnostic prompts the user to run OpenCode's own `opencode auth login`; model discovery remains `not-checked` and never inspects credentials.
- The Composer provider/model selection uses the Host's bounded CLI model catalog and a real `opencode` registry identity, not an ACP-only selector or a fabricated API provider.
- A missing CLI or unavailable catalog gives an actionable inline Composer state. No automatic fallback changes the selected provider or model.
