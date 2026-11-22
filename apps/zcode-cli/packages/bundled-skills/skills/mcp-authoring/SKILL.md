---
name: mcp-authoring
description: Use when adding or changing a ZCode plugin capability backed by an MCP server, including its tool contract, transport, configuration, permissions, and verification.
---

# MCP authoring in ZCode

Prefer ZCode's existing plugin and MCP runtime over a parallel server integration. A generated server scaffold or a successful MCP handshake alone does not prove that the requested capability works.

## Choose the right owner

1. Clarify the user-visible task the MCP capability should enable and define a representative input with an observable expected result.
2. Inspect the current plugin source, feature spec, `apps/zcode-cli/docs/design/v2/mcp.md`, `apps/zcode-cli/docs/design/v2/plugin-compat.md`, and `docs/plugin-creator.md` as relevant. Search with `Grep`/`Glob` and read the owning contracts with `Read` before editing.
3. For plugin creation or changes to a plugin manifest or its capabilities, use the `plugin-creator` skill through the ZCode `Skill` tool when it is available; otherwise follow `docs/plugin-creator.md` and its checked-in implementation. Keep its local source, manifest, and test-marketplace workflow as the owner. Do not bypass its validation or manual-install handoff.
4. Determine whether the work belongs in an existing plugin or MCP server. Add a standalone server only when the accepted requirement needs a separately configured server; do not recreate features already provided by ZCode's MCP client, plugin runtime, or an existing plugin.
5. For protocol details not settled by repository contracts, consult the official Model Context Protocol documentation using available `WebFetch`. External examples do not override ZCode's trust, permission, configuration, or layering rules.

## Define the MCP contract

- Select only transports supported by the current ZCode contract (`stdio`, Streamable HTTP, or SSE); use the existing adapter and configuration shapes. Do not add a transport by documenting it alone.
- Design tools around a real user workflow. Use clear action-oriented names, concise descriptions, bounded input schemas, and focused outputs. Add pagination or filtering when needed to keep results useful within model context.
- Mark read-only, destructive, idempotent, and open-world behavior accurately using the MCP annotations and fields supported by the current server/runtime. The annotation is descriptive; ZCode's permission and admission checks remain authoritative.
- Define authentication and configuration without embedding secrets in source, manifests, examples, logs, or handoff text. Keep project-provided servers behind ZCode's existing trust behavior; connecting a configured server can start a process or make a network request.
- Make external I/O asynchronous and honor the existing timeout, cancellation, error, and lifecycle contracts. Return actionable errors without exposing secret values.
- Respect layering: MCP SDK and transport code belong in adapters/plugin runtime; core consumes normalized tool descriptors and must not import an MCP SDK directly. Cross-boundary inputs need runtime validation, not only TypeScript types.

## Implement and verify

1. Use ZCode `Read`, `Edit`, and `Write` for scoped source changes, and `Bash` for repository-declared validation and tests. Preserve unrelated plugin and marketplace entries.
2. Validate the manifest and declared resource paths with the plugin creator's supported validation procedure. Then run the plugin's focused checks and the representative MCP operation through ZCode's actual runtime when available.
3. Verify failure cases that matter: invalid configuration, unavailable server, permission denial, timeout/cancellation, and malformed or oversized results. A handshake or tool-list response proves connectivity and discovery only; invoke the capability and check its result.
4. Report the source and config changed, transport, permission/trust expectations, exact checks and outcomes, and what still requires local installation, credentials, or a live server. Do not claim that a plugin was installed, enabled, published, or exercised unless that action was observed.
