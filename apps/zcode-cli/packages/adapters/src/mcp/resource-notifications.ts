import {
  MCP_NOTIFICATION_MESSAGE,
  MCP_NOTIFICATION_RESOURCES_LIST_CHANGED,
  MCP_NOTIFICATION_RESOURCES_UPDATED,
  MCP_NOTIFICATION_TOOLS_LIST_CHANGED,
  type McpAdapterContext,
  type McpClient,
} from "./adapter-context.js";

/**
 * server 主动通知。订阅类通知附上当前登记的 subscriberKey（宿主据此按会话拆分）；
 * tools/list_changed 只标记 stale，下一次 listTools 再拉；没有端口时 SDK 默认丢弃。
 */
export function installNotificationHandlers(
  ctx: McpAdapterContext,
  client: McpClient,
  serverName: string,
): void {
  const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
    .setNotificationHandler;
  if (typeof setNotificationHandler !== "function") return;
  // SDK 2.x：第一个参数是通知方法名（spec 方法直接用字符串），schema 是可选的第二个参数。
  const typed = client as unknown as {
    setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
  };
  typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
    const record = ctx.records.get(serverName);
    if (record) record.toolsStale = true;
    ctx.toolListRevisionCounter += 1;
    ctx.notifications?.onNotification({ kind: "toolListChanged", serverName });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
    const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
    if (typeof uri !== "string") return;
    ctx.notifications?.onNotification({
      kind: "resourceUpdated",
      serverName,
      uri,
      subscribers: ctx.resourceSubscriptions.subscribers(serverName, uri),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
    ctx.notifications?.onNotification({
      kind: "resourceListChanged",
      serverName,
      subscribers: ctx.resourceSubscriptions.allSubscribers(serverName),
    });
  });
  typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
    const params = (notification as { params?: Record<string, unknown> }).params ?? {};
    ctx.notifications?.onNotification({
      kind: "loggingMessage",
      serverName,
      level: typeof params.level === "string" ? params.level : "info",
      ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
      data: params.data,
    });
  });
}

/** 断连重连后按登记表重放 subscribe（A3）；单条失败不影响其它。 */
export async function replayResourceSubscriptions(
  ctx: McpAdapterContext,
  serverName: string,
  client: McpClient,
): Promise<void> {
  const uris = ctx.resourceSubscriptions.uris(serverName);
  if (uris.length === 0) return;
  if (!client.getServerCapabilities()?.resources?.subscribe) return;
  for (const uri of uris) {
    try {
      await client.subscribeResource({ uri });
    } catch (error) {
      ctx.logger?.warn("MCP resource subscription replay failed", {
        event: "mcp.resource.subscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }
  ctx.logger?.info("MCP resource subscriptions replayed after reconnect", {
    event: "mcp.resource.subscribe.replayed",
    mcpServerName: serverName,
    uriCount: uris.length,
  });
}
