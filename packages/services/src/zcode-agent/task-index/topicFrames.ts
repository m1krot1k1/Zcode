/**
 * task-index/topicFrames.ts: Staging буфер физических кадров, topic keys, отмена подписок
 * и классификация ошибок subscribe.
 */
import { resolveWorkspaceKey, ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";
import { sessionsIndexTopic, workspaceConfigTopic } from "@zcode/shared/zcode-protocol-v4";
import type {
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "../zcodeAgent.js";
import {
  MAX_PENDING_TOPIC_BYTES,
  MAX_PENDING_TOPIC_FRAMES,
  TOPIC_SUBSCRIBE_WARN_INTERVAL_MS,
  type PendingTopicFrames,
  type TaskIndexRuntime,
  type TaskIndexTopicKind,
  type TopicFramesHelpers,
  type TopicRetryKind,
  type TopicSubscribeReason,
  type WorkspaceIngestState,
} from "./contracts.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createTopicFramesHelpers(
  ctx: Pick<TaskIndexRuntime, "agentService">,
): TopicFramesHelpers {
  const { agentService } = ctx;

  const indexTopicFor = (state: WorkspaceIngestState) =>
    sessionsIndexTopic(resolveWorkspaceKey(state.target));
  const configTopicFor = (state: WorkspaceIngestState) =>
    workspaceConfigTopic(resolveWorkspaceKey(state.target));

  const isProviderNotReadyError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
  const isRuntimeUnavailableError = (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;

  const logTopicSubscribeFailure = (
    state: WorkspaceIngestState,
    topic: TaskIndexTopicKind,
    reason: TopicSubscribeReason,
    error: unknown,
    retryKind: TopicRetryKind,
  ): void => {
    const message = `task index ${topic} 订阅失败 reason=${reason} workspace=${state.target.workspacePath}`;
    if (retryKind === "provider-not-ready") {
      // 新用户尚未配置模型是正常等待态；每个 workspace 的两个 topic 若持续 warn，
      // 会在用户进行任何操作前先制造日志风暴。debug 在 production 构建中不会落盘。
      logger.debug(undefined, message, error);
      return;
    }

    const lastWarnAt = topic === "sessions-index" ? state.indexLastWarnAt : state.configLastWarnAt;
    const now = Date.now();
    if (lastWarnAt === null || now - lastWarnAt >= TOPIC_SUBSCRIBE_WARN_INTERVAL_MS) {
      if (topic === "sessions-index") state.indexLastWarnAt = now;
      else state.configLastWarnAt = now;
      logger.warn(undefined, message, error);
      return;
    }
    // 高频重试细节只用于本地排查，不能和消息流同量级写入生产日志。
    logger.debug(undefined, message, error);
  };

  const createPendingFrames = <TFrame>(generation: number): PendingTopicFrames<TFrame> => ({
    generation,
    frames: [],
    stagedBytes: 0,
    recoveryNeeded: false,
  });

  const discardPendingFrames = <TFrame>(pending: PendingTopicFrames<TFrame> | null): void => {
    if (!pending) return;
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

  const frameBytes = (
    frame: SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  ): number => new TextEncoder().encode(JSON.stringify(frame)).byteLength;

  const stagePendingFrame = <
    TFrame extends SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  >(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    pending: PendingTopicFrames<TFrame>,
    frame: TFrame,
  ): void => {
    if (pending.recoveryNeeded) return;
    const bytes = frameBytes(frame);
    if (
      bytes > MAX_PENDING_TOPIC_BYTES ||
      pending.frames.length + 1 > MAX_PENDING_TOPIC_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_TOPIC_BYTES
    ) {
      // ACK-only 的 initial notification 会在 Promise continuation 前到达。订阅建立前的
      // 暂存缓冲区超限时，既不能无界积压，也不能丢帧了事；此时尚未取得可证明的 base，
      // 因此标记需要恢复，待 ACK 到达后仅为该 topic 发起新一代 snapshot 订阅。
      discardPendingFrames(pending);
      pending.recoveryNeeded = true;
      logger.warn(
        undefined,
        `task index ${kind} ACK staging overflow; recovery-needed workspace=${resolveWorkspaceKey(state.target)}`,
      );
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };

  const clearIndexPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.indexPending);
    state.indexPending = null;
    state.indexAssembler.clear();
  };

  const clearConfigPendingState = (state: WorkspaceIngestState): void => {
    discardPendingFrames(state.configPending);
    state.configPending = null;
    state.configAssembler.clear();
  };

  const clearPendingState = (state: WorkspaceIngestState): void => {
    clearIndexPendingState(state);
    clearConfigPendingState(state);
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    state.assemblyTimer = null;
  };

  const unsubscribeIndex = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeSessionsIndexV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `清理 task index sessions-index 订阅失败 workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };

  const unsubscribeConfig = async (
    state: WorkspaceIngestState,
    subscriptionId: string,
  ): Promise<void> => {
    try {
      await agentService.unsubscribeWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        runtimePolicy: "existing-only",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `清理 task index workspace-config 订阅失败 workspace=${state.target.workspacePath}`,
        error,
      );
    }
  };

  const clearActiveSubscriptions = (state: WorkspaceIngestState): void => {
    const indexSubscriptionId = state.indexSubscriptionId;
    const configSubscriptionId = state.configSubscriptionId;
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
    if (indexSubscriptionId) void unsubscribeIndex(state, indexSubscriptionId);
    if (configSubscriptionId) void unsubscribeConfig(state, configSubscriptionId);
  };

  return {
    isProviderNotReadyError,
    isRuntimeUnavailableError,
    indexTopicFor,
    configTopicFor,
    logTopicSubscribeFailure,
    createPendingFrames,
    discardPendingFrames,
    stagePendingFrame,
    clearIndexPendingState,
    clearConfigPendingState,
    clearPendingState,
    unsubscribeIndex,
    unsubscribeConfig,
    clearActiveSubscriptions,
  };
}
