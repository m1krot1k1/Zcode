import type {
  McpCallToolOptions,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpResourceSubscriptionRequest,
} from "@zcode/contracts";
import { McpResourceSubscribeUnsupportedError } from "@zcode/contracts";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  type McpAdapterContext,
  type McpClient,
  type McpServerRecord,
} from "./adapter-context.js";
import { pickResourceDescriptor } from "./adapter-helpers.js";
import { resolveConnectedRecord } from "./connection-lifecycle.js";
import { createMcpDeadline, remainingMcpDeadlineMs, type McpDeadline } from "./timeout.js";

/** `resources/list`，分页游标透传。 */
export async function listResources(
  ctx: McpAdapterContext,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourcesResult> {
  const { record, deadline, timeoutMessage } = await resolveForResourceRequest(
    ctx,
    request.serverName,
    "resources/list",
    options,
  );
  const result = await record.client.listResources(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resources: (result.resources ?? []).map((resource) => {
      const { uri, ...rest } = pickResourceDescriptor(resource);
      return { uri: uri ?? "", ...rest };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

export async function listResourceTemplates(
  ctx: McpAdapterContext,
  request: McpListResourcesRequest,
  options: McpCallToolOptions = {},
): Promise<McpListResourceTemplatesResult> {
  const { record, deadline, timeoutMessage } = await resolveForResourceRequest(
    ctx,
    request.serverName,
    "resources/templates/list",
    options,
  );
  const result = await record.client.listResourceTemplates(
    request.cursor ? { cursor: request.cursor } : {},
    { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
  );
  return {
    resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
      const item = template as Record<string, unknown>;
      return {
        uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
        ...pickResourceDescriptor(item, false),
      };
    }),
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}

/**
 * 按 (serverName, uri) 计数的订阅。同一连接被多个 session 共享时只向 server 订阅一次；
 * server 没声明 resources.subscribe 能力 → McpResourceSubscribeUnsupportedError。
 */
export async function subscribeResource(
  ctx: McpAdapterContext,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const { record, deadline, timeoutMessage } = await resolveForResourceRequest(
    ctx,
    request.serverName,
    "resources/subscribe",
    options,
  );
  if (!record.client.getServerCapabilities()?.resources?.subscribe) {
    throw new McpResourceSubscribeUnsupportedError(request.serverName);
  }
  const { first } = ctx.resourceSubscriptions.add(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!first) return;
  try {
    await record.client.subscribeResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
  } catch (error) {
    ctx.resourceSubscriptions.remove(request.serverName, request.uri, request.subscriberKey);
    throw error;
  }
  ctx.logger?.info("MCP resource subscribed", {
    event: "mcp.resource.subscribe",
    mcpServerName: request.serverName,
    uri: request.uri,
    status: "completed",
  });
}

export async function unsubscribeResource(
  ctx: McpAdapterContext,
  request: McpResourceSubscriptionRequest,
  options: McpCallToolOptions = {},
): Promise<void> {
  const removed = ctx.resourceSubscriptions.remove(
    request.serverName,
    request.uri,
    request.subscriberKey,
  );
  if (!removed?.last) return;
  await unsubscribeOnServer(ctx, request.serverName, request.uri, options);
}

export async function unsubscribeResourcesBySubscriber(
  ctx: McpAdapterContext,
  subscriberKeyPrefix: string,
): Promise<number> {
  const released = ctx.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
  for (const { serverName, uri } of released) {
    await unsubscribeOnServer(ctx, serverName, uri, {});
  }
  return released.length;
}

/** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
export function resourceSubscriptionCounts(
  ctx: McpAdapterContext,
): Record<string, Record<string, number>> {
  return ctx.resourceSubscriptions.counts();
}

async function unsubscribeOnServer(
  ctx: McpAdapterContext,
  serverName: string,
  uri: string,
  options: McpCallToolOptions,
): Promise<void> {
  const record = ctx.records.get(serverName);
  if (!record?.client || record.status.status !== "connected") return;
  try {
    await record.client.unsubscribeResource({ uri }, { signal: options.signal });
    ctx.logger?.info("MCP resource unsubscribed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      status: "completed",
    });
  } catch (error) {
    // 退订失败只记日志：登记表已清，server 多发的通知因没有订阅者会被丢弃。
    ctx.logger?.warn("MCP resource unsubscribe failed", {
      event: "mcp.resource.unsubscribe",
      mcpServerName: serverName,
      uri,
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
  }
}

async function resolveForResourceRequest(
  ctx: McpAdapterContext,
  serverName: string,
  operation: string,
  options: McpCallToolOptions,
): Promise<{
  record: McpServerRecord & { client: McpClient };
  deadline: McpDeadline;
  timeoutMessage: string;
}> {
  const timeoutMs =
    options.timeoutMs ?? ctx.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
  const record = await resolveConnectedRecord(
    ctx,
    serverName,
    deadline,
    timeoutMessage,
    options.signal,
  );
  return { record, deadline, timeoutMessage };
}
