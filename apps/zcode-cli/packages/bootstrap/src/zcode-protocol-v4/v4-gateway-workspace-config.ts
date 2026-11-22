// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：subscribeWorkspaceConfig / subscribeWorkspaceConfigReserved / publishWorkspaceConfig 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import {
  parseWorkspaceConfigTopic,
  v4ConversationSubscribeParamsSchema,
  type WorkspaceConfigState,
  type WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { GatewayContext, V4SubscribeDispatchResult } from "./v4-gateway-context.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";

/**
 * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
 */
export async function subscribeWorkspaceConfig(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const dispatch = await ctx.subscribeWorkspaceConfigReserved(rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeWorkspaceConfigReserved(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseWorkspaceConfigTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a workspace-config topic: ${params.topic}`);
  }
  const publisher = await ctx.ensureConfigPublisher(workspaceId);
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return ctx.subscribeDispatch(
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => ctx.flushConfig(workspaceId),
    );
  } catch (error) {
    // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
    result.rollback();
    throw error;
  }
}

/**
 * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
 * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
 * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
 * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
 */
export function publishWorkspaceConfig(
  ctx: GatewayContext,
  workspaceId: string,
  state: WorkspaceConfigState,
): void {
  if (ctx.disposed) return;
  let publisher = ctx.configPublishers.get(workspaceId);
  if (!publisher) {
    publisher = new WorkspaceConfigPublisher(
      workspaceId,
      ctx.createLogEpoch(`workspace-config/${workspaceId}`),
      ctx.now,
    );
    ctx.configPublishers.set(workspaceId, publisher);
  }
  try {
    if (publisher.publish(state)) ctx.flushConfig(workspaceId);
  } catch (error) {
    ctx.host.onError?.("v4.workspaceConfig.publish", error);
  }
}

export async function pullWorkspaceConfig(
  ctx: GatewayContext,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  if (!ctx.host.getWorkspaceConfig) return null;
  return (await ctx.host.getWorkspaceConfig(workspaceId)) ?? null;
}

/** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
export async function ensureConfigPublisher(
  ctx: GatewayContext,
  workspaceId: string,
): Promise<WorkspaceConfigPublisher> {
  const existing = ctx.configPublishers.get(workspaceId);
  if (existing) return existing;
  const publisher = new WorkspaceConfigPublisher(
    workspaceId,
    ctx.createLogEpoch(`workspace-config/${workspaceId}`),
    ctx.now,
  );
  const seed = await ctx.pullWorkspaceConfig(workspaceId).catch((error) => {
    ctx.host.onError?.("v4.workspaceConfig.seed", error);
    return null;
  });
  if (seed) publisher.publish(seed);
  // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
  const raced = ctx.configPublishers.get(workspaceId);
  if (raced) return raced;
  ctx.configPublishers.set(workspaceId, publisher);
  return publisher;
}

/** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
export function flushConfig(
  ctx: GatewayContext,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = ctx.configPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      ctx.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      ctx.emitReservation(reservation);
    } catch (error) {
      ctx.host.onError?.("v4.workspaceConfig.emit", error);
    }
  }
}
