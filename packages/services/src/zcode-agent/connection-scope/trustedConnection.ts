// 可信连接 carrier 的读写、workspace key 归一与 hello 构造。
import { V4_WIRE_PROTOCOL_VERSION, type HelloMessage } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";
import {
  MAX_DOWNSTREAM_CONNECTION_ID_LENGTH,
  type RoutedTopicFrame,
  type TrustedZCodeAgentV4UnsubscribeRoute,
  type ZCodeAgentV4ClientMode,
  type ZCodeAgentV4ConnectionContext,
} from "./types.js";

const TRUSTED_CONNECTION_FIELD = "__zcodeTrustedV4Connection";
const TRUSTED_UNSUBSCRIBE_ROUTE_FIELD = "__zcodeTrustedV4UnsubscribeRoute";

type TrustedConnectionCarrier = {
  [TRUSTED_CONNECTION_FIELD]?: ZCodeAgentV4ConnectionContext;
};

type TrustedUnsubscribeRouteCarrier = {
  [TRUSTED_UNSUBSCRIBE_ROUTE_FIELD]?: TrustedZCodeAgentV4UnsubscribeRoute;
};

export function readTrustedZCodeAgentV4UnsubscribeRoute(
  value: unknown,
): TrustedZCodeAgentV4UnsubscribeRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const route = (value as TrustedUnsubscribeRouteCarrier)[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  if (!route || typeof route.topic !== "string" || typeof route.connectionId !== "string") {
    return null;
  }
  return route;
}

/**
 * 该字段只在 host facade → base/remote service proxy 之间传递；facade 会覆盖所有
 * UI 入参中的同名字段，因此 renderer/mobile 不能伪造可信连接模式。
 */
export function readTrustedZCodeAgentV4Connection(
  value: unknown,
): ZCodeAgentV4ConnectionContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = (value as TrustedConnectionCarrier)[TRUSTED_CONNECTION_FIELD];
  if (!context || typeof context.connectionId !== "string") return null;
  if (
    context.clientMode !== "desktop-continuous" &&
    context.clientMode !== "web-remote-replayable"
  ) {
    return null;
  }
  return {
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    // 只认 true：缺席与 false 都是「旧消费者」，键在场与否是下游读端的判据。
    ...(context.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
    ...(context.historyFirst === true ? { historyFirst: true } : {}),
  };
}

export function withTrustedConnection<T extends object>(
  value: T,
  context: ZCodeAgentV4ConnectionContext,
): T {
  const forwarded: Record<string, unknown> = {
    ...(value as unknown as Record<string, unknown>),
  };
  // 共享 service 暴露在多个 RPC port 上时，调用方曾能传 profile，且所有
  // port 共用 workspace fan-out。facade 必须先清掉所有可伪造字段，再写 host 真值。
  delete forwarded[TRUSTED_CONNECTION_FIELD];
  delete forwarded["connectionId"];
  delete forwarded["clientMode"];
  delete forwarded["deliveryProfile"];
  delete forwarded["subscriberScope"];
  // 与 clientMode 同族的可信位：UI 面的 subscribe 不能自己挑增量编码。
  delete forwarded["workflowRunDeltas"];
  delete forwarded["historyFirst"];
  forwarded[TRUSTED_CONNECTION_FIELD] = context;
  return forwarded as T;
}

export function withTrustedUnsubscribeRoute<T extends object>(
  value: T,
  route: TrustedZCodeAgentV4UnsubscribeRoute,
): T {
  const forwarded = {
    ...(value as unknown as Record<string, unknown>),
  };
  delete forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD] = route;
  return forwarded as T;
}

export function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function workspaceTarget(target: ZCodeAgentWorkspaceTarget): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

export function assertConnectionId(connectionId: string): void {
  if (
    connectionId.trim().length === 0 ||
    connectionId.length > MAX_DOWNSTREAM_CONNECTION_ID_LENGTH
  ) {
    throw new Error("fault.connection.invalidConnectionId");
  }
}

export function namespaceRelayConnectionId(
  upstreamConnectionId: string,
  downstreamConnectionId: string,
): string {
  // 长度前缀消除 `a/b + c` 与 `a + b/c` 这类分隔符碰撞；connectionId 只作
  // opaque route key，不需要业务层解析。
  return `relay:${upstreamConnectionId.length}:${upstreamConnectionId}${downstreamConnectionId.length}:${downstreamConnectionId}`;
}

export function frameBytes(frame: RoutedTopicFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

export function deliveryProfileFor(
  clientMode: ZCodeAgentV4ClientMode,
): HelloMessage["deliveryProfile"] {
  return clientMode === "desktop-continuous" ? "continuous" : "replayable";
}

export function createHello(context: ZCodeAgentV4ConnectionContext): HelloMessage {
  const continuous = context.clientMode === "desktop-continuous";
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    deliveryProfile: deliveryProfileFor(context.clientMode),
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: continuous,
      localTerminal: continuous,
      binaryFrames: false,
      compression: "none",
      workspaceHookReview: true,
      independentPlanState: true,
      // 本 Host 会转发 `workflowRun.*` 键级增量；客户端见到它才能在 clientHello 里回声明
      // （那个 capabilities 是 .strict() 的，反过来会让老 Host 握不上手）。
      workflowRunDeltas: true,
      historyFirst: true,
    },
    auth: {},
  };
}
