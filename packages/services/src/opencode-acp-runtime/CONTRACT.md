# opencode-acp-runtime

Host-local adapter for an explicitly delegated OpenCode ACP child. The service is registered only on a process-owning Host: the window-scoped Local Host or a standalone Source Server Host. Server-remote UI calls it through that server's authenticated RPC channel. Legacy desktop-attached SSH/WSL/Docker and phone attachment channels do not register it.

不变量：

- Opening settings and querying CLI version never starts ACP or creates an OpenCode session.
- `listModels` is an explicit, read-only `opencode models` CLI query. It returns only validated provider/model IDs and a typed diagnostic; authentication is always `not-checked`. It never reads `auth.json`, calls `opencode auth list`, starts ACP, or creates an OpenCode session.
- Only the explicit `startSession` call starts `opencode acp` and creates OpenCode's durable session.
- `installCli` runs only after UI confirmation. It downloads the pinned official OpenCode v1.19.3 CLI asset for the Host OS/architecture/ABI, checks its SHA-256 before extraction, probes the executable in a disposable HOME, and creates `~/.opencode/bin/opencode[.exe]` exclusively. It does not require `bash`, `curl`, WinGet, npm, or administrator access. A detected CLI is never replaced or upgraded.
- The allowlisted binary manifest contains only macOS arm64/x64 baseline, Windows arm64/x64 baseline, and Linux arm64/x64 baseline for glibc and musl. Updating the pinned version requires refreshed official digests and a real ACP smoke. Unsupported OS/architecture combinations are rejected before network access.
- Install failures cross the Host boundary only as fixed diagnostic codes for download, archive format, digest mismatch, timeout, destination conflict, or version verification failure. Raw stderr, commands, absolute paths, environment values, and credentials are never returned to the UI. Provider rate limits remain provider-owned and are never bypassed.
- ACP `configOptions` are passed through unchanged; they are not ZCode Provider Registry models.
- Only ACP's typed authentication-required error (`RequestError` code `-32000`) is normalized to `opencode.auth-required`; peer text and data remain private. This diagnostic does not authenticate or inspect OpenCode credentials.
- OpenCode owns auth, model/provider selection, tool loop, workspace modifications, and session history.
- The service owns only child-process lifecycle and ACP transport. Client permission requests are exposed to the session UI; only an option advertised by that ACP request can be selected, and cancellation replies with ACP `cancelled` before sending `session/cancel`.
- ACP startup keeps only a bounded stderr tail in memory to classify allowlisted local-listener/spawn/early-exit failures. Raw stderr and ACP error text are never returned, logged, or persisted.
- Each runtime accepts only workspace paths meaningful on its owning Host and is disposed with that Host. The UI must select the target workspace service collection; it must never fall back from a remote Source Server to the Desktop Local Host.
