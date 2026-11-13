import type { McpAdapterContext, McpClient, McpTransport } from "./adapter-context.js";
import { getStdioTransportPid } from "./adapter-helpers.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";

export async function closeRecord(ctx: McpAdapterContext, name: string): Promise<void> {
  const record = ctx.records.get(name);
  if (!record) return;
  record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
  if (!record.client && !record.transport) return;
  await closeClientAndTransport(ctx, name, record.client, record.transport);
}

export async function closeClientAndTransport(
  ctx: McpAdapterContext,
  name: string,
  client?: McpClient,
  transport?: McpTransport,
): Promise<void> {
  const startedAt = Date.now();
  const mcpTransportPid = getStdioTransportPid(transport);
  // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
  if (client) client.onclose = undefined;
  // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
  // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
  await terminateStdioProcessTree(ctx, name, transport);

  try {
    await client?.close();
  } catch (error) {
    ctx.logger?.debug("MCP client close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.client.close.failed",
      mcpServerName: name,
    });
  }

  try {
    await transport?.close();
  } catch (error) {
    ctx.logger?.debug("MCP transport close failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.transport.close.failed",
      mcpServerName: name,
    });
  }
  if (
    ctx.connectionContext &&
    transport instanceof ProcessTreeStdioClientTransport &&
    !transport.processAlive
  ) {
    ctx.telemetry?.recordProcessClosed({
      connectionId: ctx.connectionContext.mcpConnectionId,
    });
  }
  ctx.logger?.info("MCP server closed", {
    ...ctx.connectionContext,
    durationMs: Date.now() - startedAt,
    event: "mcp.server.closed",
    mcpServerName: name,
    ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
    status: "completed",
  });
}

async function terminateStdioProcessTree(
  ctx: McpAdapterContext,
  name: string,
  transport?: McpTransport,
): Promise<void> {
  const pid = getStdioTransportPid(transport);
  if (pid == null) return;

  try {
    await terminateMcpStdioProcessTree(pid);
  } catch (error) {
    ctx.logger?.warn("MCP stdio process tree cleanup failed", {
      ...ctx.connectionContext,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp.stdio.process_tree_cleanup.failed",
      mcpServerName: name,
      mcpTransportPid: pid,
      pid,
      status: "failed",
    });
  }
}
