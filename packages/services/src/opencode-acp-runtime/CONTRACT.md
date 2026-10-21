# opencode-acp-runtime

Host-local adapter for an explicitly delegated OpenCode ACP child. The settings UI calls this service through the Local Host only; the service is never registered on remote workspace or phone attachment channels.

不变量：

- Opening settings and querying CLI version never starts ACP or creates an OpenCode session.
- Only the explicit `startSession` call starts `opencode acp` and creates OpenCode's durable session.
- ACP `configOptions` are passed through unchanged; they are not ZCode Provider Registry models.
- OpenCode owns auth, model/provider selection, tool loop, workspace modifications, and session history.
- The service owns only child-process lifecycle and ACP transport. Client permission requests are exposed to the session UI; only an option advertised by that ACP request can be selected, and cancellation replies with ACP `cancelled` before sending `session/cancel`.
- A local runtime never accepts a remote workspace path and is disposed with the owning Local Host.
