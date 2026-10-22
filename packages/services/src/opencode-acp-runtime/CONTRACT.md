# opencode-acp-runtime

Host-local adapter for an explicitly delegated OpenCode ACP child. The service is registered only on a process-owning Host: the window-scoped Local Host or a standalone Source Server Host. Server-remote UI calls it through that server's authenticated RPC channel. Legacy desktop-attached SSH/WSL/Docker and phone attachment channels do not register it.

不变量：

- Opening settings and querying CLI version never starts ACP or creates an OpenCode session.
- `listModels` is an explicit, read-only `opencode models` CLI query. It returns only validated provider/model IDs and a typed diagnostic; authentication is always `not-checked`. It never reads `auth.json`, calls `opencode auth list`, starts ACP, or creates an OpenCode session.
- Only the explicit `startSession` call starts `opencode acp` and creates OpenCode's durable session.
- `installCli` runs only after UI confirmation. macOS/Linux execute the official V2 installer under a disposable temporary HOME, then copy the version-verified binary to the user's `~/.opencode/bin` with exclusive creation and `--no-modify-path`; Windows uses the exact WinGet package with `--no-upgrade`. A detected CLI is never replaced.
- Install failures cross the Host boundary only as fixed diagnostic codes for download, installer/package-manager execution, timeout, destination conflict, or verification failure. Raw stderr, commands, absolute paths, environment values, and credentials are never returned to the UI. The current button still depends on `bash`/`curl` or WinGet; hosts without them are a documented gap against one-click installation on every supported OS.
- ACP `configOptions` are passed through unchanged; they are not ZCode Provider Registry models.
- Only ACP's typed authentication-required error (`RequestError` code `-32000`) is normalized to `opencode.auth-required`; peer text and data remain private. This diagnostic does not authenticate or inspect OpenCode credentials.
- OpenCode owns auth, model/provider selection, tool loop, workspace modifications, and session history.
- The service owns only child-process lifecycle and ACP transport. Client permission requests are exposed to the session UI; only an option advertised by that ACP request can be selected, and cancellation replies with ACP `cancelled` before sending `session/cancel`.
- ACP startup keeps only a bounded stderr tail in memory to classify allowlisted local-listener/spawn/early-exit failures. Raw stderr and ACP error text are never returned, logged, or persisted.
- Each runtime accepts only workspace paths meaningful on its owning Host and is disposed with that Host. The UI must select the target workspace service collection; it must never fall back from a remote Source Server to the Desktop Local Host.
