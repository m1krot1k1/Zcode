# Cursor CLI provider settings

The ordinary conversation Composer is the Cursor CLI provider/model selection surface. The owning Host discovers the local `cursor-agent` binary and its model catalog, then publishes `cursor` as an ordinary local-auth Provider Registry entry (`api.type: "cursor-cli"`). The Composer persists the selection as the standard `ModelSelection` and sends it through the normal conversation command/runtime.

This settings module owns the user's persisted enablement preference and shows actionable fixed diagnostics. Enablement is a preference and may be saved while the CLI is missing; the Host must still verify the CLI and catalog before publishing Cursor as selectable in Composer. It does not host model selection, a workspace field, a start-session action, a second transcript, or a separate prompt box.

Invariants:

- Settings do not start `cursor-agent` for a prompt, retain a process, or create a session. The renderer never spawns the binary; it only reads `cursorCliRuntime.getCliStatus()` and `listModels()`.
- Enablement (`cursorCliEnabled`) and selectability are separate facts. The Host publishes the `cursor` provider only when the flag is on and the CLI resolves.
- A missing CLI shows the official install command and a re-check button. There is no managed install: Cursor does not publish a pinned manifest with checksums, so ZCode does not download it.
- The model catalog is the Host's bounded, normalized list. Models reported by the CLI are authoritative; the documented baseline set is marked `source: "baseline"` and never presented as a verified CLI report.
- Authentication is not inspected: the catalog reports `authentication: "not-checked"`. Cursor owns sign-in and rate limits.
- No automatic fallback changes the selected provider or model.
- Diagnostics are fixed codes rendered next to the status; raw paths or errors from the Host never reach the user.
