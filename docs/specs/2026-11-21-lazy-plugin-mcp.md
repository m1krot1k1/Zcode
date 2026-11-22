# Lazy plugin MCP servers

Date: 2026-11-21. Status: implemented in 3.17.141.

## Problem

Official document plugins (`documents`, `pdf`, `presentations`, `spreadsheets`) start
large stdio MCP servers for every session, even when the turn never touches a document.
Their schemas are already deferrable through ToolSearch, but the process and handshake
cost remained always-on.

## Ownership

- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` classifies plugin-owned
  document servers as lazy. A user-provided server with the same name is never lazy.
- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts` owns lazy activation,
  connection, tool registration and logging.
- `AgentRuntimeConfig.mcp.lazyServers` is the only runtime carrier for not-yet-connected
  plugin servers.
- `mcp.servers` remains the eager/connected set. Successful activation moves a server
  from `lazyServers` to `servers`.

## Rules

1. Lazy servers never enter `connectConfiguredServers` at session creation.
2. A turn activates only the lazy servers named by its own input:
   - `documents`: `.docx`, Word, документ/ворд, 文档;
   - `pdf`: `.pdf`, PDF, пдф;
   - `presentations`: `.ppt`/`.pptx`, presentation/slide, презентац/слайд, 演示;
   - `spreadsheets`: `.xls`/`.xlsx`, Excel/spreadsheet, таблиц/эксель, 表格.
3. A child profile that explicitly requires a lazy MCP server activates only that
   scoped server before admission.
4. Activation waits for eager startup, connects with the same 15s OAuth bound as session
   startup, then re-registers the live `listTools()` union.
5. A failed activation does not fail the turn. The server stays lazy and can be retried
   on a later matching turn.
6. No eager fallback starts all lazy servers: that would recreate the original cost and
   could fail the whole session for an unrelated plugin.
7. A user-configured server with the same name is eager and keeps full existing
   semantics; provenance/trust checks are unchanged.

## Acceptance

- With an eager `local` server and a lazy `documents` server, startup connects only
  `local`.
- A turn containing `DOCX` connects `documents`, registers its tools, and the next model
  request sees `mcp__documents__*`.
- An unrelated turn does not connect `documents`.
- A profile-required lazy server activates before subagent admission.
- Activation failure logs a warning and leaves the turn usable.

## Evidence

- `apps/zcode-cli/packages/core/tests/mcp-runtime.test.ts`
- `apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`

## Not in this pass

ToolSearch cannot discover a tool name that has never been listed. The activation signal
is intentionally deterministic (turn input/profile requirement). A later extension can
add an explicit `McpActivate` tool or a persisted discovery catalog; neither is required
to stop always-on document processes.
