/**
 * task-index/workspaceConfigIngest.ts: Применение workspace-config кадров —
 * дедупликация по seq/epoch и трансляция каталога конфигурации в workspace event.
 */
import type { WorkspaceConfigTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConfigIngestHelpers,
  TaskIndexRuntime,
  TopicDeliveryKind,
  WorkspaceIngestState,
} from "./contracts.js";

export function createWorkspaceConfigIngestHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    "runtimeState" | "getWorkspaceEmitter" | "handleConfigGap" | "completeConfigRecoveryFrame"
  >,
): ConfigIngestHelpers {
  const { runtimeState } = ctx;

  function applyWorkspaceConfigFrame(
    state: WorkspaceIngestState,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (runtimeState.disposed) return;
    if (deliveryKind === "online" && state.configRecovery && frame.payload.kind === "deltas") {
      if (state.configRecovery.frameApplied && frame.toSeq > state.configSeq) {
        state.configRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (
        deliveryKind === "online" &&
        state.configHasAppliedBase &&
        frame.toSeq <= state.configSeq
      ) {
        return;
      }
      state.configLogEpoch = frame.payload.snapshot.logEpoch;
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    } else {
      if (!state.configHasAppliedBase) {
        ctx.handleConfigGap(state, deliveryKind === "recovery" ? "recovery" : "online");
        return;
      }
      if (frame.toSeq <= state.configSeq) {
        if (deliveryKind === "recovery" && state.configHasAppliedBase) {
          ctx.completeConfigRecoveryFrame(state, deliveryKind);
        }
        return;
      }
      if (frame.fromSeq !== state.configSeq) {
        ctx.handleConfigGap(state, deliveryKind);
        return;
      }
      state.configSeq = frame.toSeq;
      state.configHasAppliedBase = true;
    }
    const config =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot.config
        : frame.payload.deltas.at(-1)?.config;
    if (!config || config.configOptions.length === 0) {
      // 空目录（无 live session 的订阅种子）不下发：下游 useZCodeConfig 收到空
      // configOptions 会把聊天工具栏的模型目录清掉。
      ctx.completeConfigRecoveryFrame(state, deliveryKind);
      return;
    }
    // v4 载荷与 ZCodeConfigOption 结构对齐（shared 黄金测试背书），零映射直通，
    // 下游 workspace_config_options_update 消费面（useZCodeConfig 等）不改。
    ctx
      .getWorkspaceEmitter({
        workspacePath: state.target.workspacePath,
        workspaceIdentity: state.target.workspaceIdentity,
      })
      .fire({
        type: "workspace_config_options_update",
        workspacePath: state.target.workspacePath,
        workspaceIdentity: state.target.workspaceIdentity,
        configOptions: config.configOptions,
      });
    ctx.completeConfigRecoveryFrame(state, deliveryKind);
  }

  return { applyWorkspaceConfigFrame };
}
