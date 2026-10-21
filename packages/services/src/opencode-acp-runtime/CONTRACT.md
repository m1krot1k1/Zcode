# opencode-acp-runtime

Host-local adapter for an explicitly delegated OpenCode ACP child. The settings UI calls this service through the Local Host only; the service is never registered on remote workspace or phone attachment channels.

不变量：

- Opening settings and querying CLI version never starts ACP or creates an OpenCode session.
- Only the explicit `startSession` call starts `opencode acp` and creates OpenCode's durable session.
- `installCli` runs only after UI confirmation. macOS/Linux execute the official V2 installer under a disposable temporary HOME, then copy the version-verified binary to the user's `~/.opencode/bin` with exclusive creation and `--no-modify-path`; Windows uses the exact WinGet package with `--no-upgrade`. A detected CLI is never replaced.
- ACP `configOptions` are passed through unchanged; they are not ZCode Provider Registry models.
- OpenCode owns auth, model/provider selection, tool loop, workspace modifications, and session history.
- The service owns only child-process lifecycle and ACP transport. Client permission requests are exposed to the session UI; only an option advertised by that ACP request can be selected, and cancellation replies with ACP `cancelled` before sending `session/cancel`.
- ACP startup keeps only a bounded stderr tail in memory to classify allowlisted local-listener/spawn/early-exit failures. Raw stderr and ACP error text are never returned, logged, or persisted.
- A local runtime never accepts a remote workspace path and is disposed with the owning Local Host.
