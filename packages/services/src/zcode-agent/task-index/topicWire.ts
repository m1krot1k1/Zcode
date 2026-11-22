/**
 * task-index/topicWire.ts: Приём физических кадров (ownership → assembly → apply) и
 * дедлайны сборки. Чужой subscriptionId не занимает staging.
 */
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  type TaskIndexRuntime,
  type TopicDeliveryKind,
  type TopicIngestHelpers,
  type WorkspaceIngestState,
} from "./contracts.js";
import { deliveryKindOf, faultDeliveryKindOf } from "./deliveryKind.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createTopicIngestHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    | "runtimeState"
    | "indexTopicFor"
    | "configTopicFor"
    | "stagePendingFrame"
    | "applySessionsIndexFrame"
    | "applyWorkspaceConfigFrame"
    | "handleIndexGap"
    | "handleConfigGap"
  >,
): TopicIngestHelpers {
  const { runtimeState } = ctx;

  function markAssemblyFault(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    reasonCode: string,
    deliveryKind: TopicDeliveryKind | undefined,
  ): void {
    logger.warn(
      undefined,
      `task index ${kind} physical assembly failed reason=${reasonCode} workspace=${resolveWorkspaceKey(state.target)}`,
    );
    if (kind === "sessions-index") {
      if (deliveryKind === "online" && state.indexRecovery) {
        state.indexRecovery.postRecoveryGapPending ||= state.indexRecovery.frameApplied;
        return;
      }
      // malformed deliveryKind 的 owned fault 不能被降成 online 后卡住已有 flight；
      // 已在恢复时按 recovery fault 推进升级，否则发起普通 same-sub resync。
      ctx.handleIndexGap(state, deliveryKind ?? (state.indexRecovery ? "recovery" : "online"));
    } else {
      if (deliveryKind === "online" && state.configRecovery) {
        state.configRecovery.postRecoveryGapPending ||= state.configRecovery.frameApplied;
        return;
      }
      ctx.handleConfigGap(state, deliveryKind ?? (state.configRecovery ? "recovery" : "online"));
    }
  }

  function scheduleAssemblyExpiry(state: WorkspaceIngestState): void {
    if (state.assemblyTimer) clearTimeout(state.assemblyTimer);
    const expiries = [state.indexAssembler.nextExpiryAt, state.configAssembler.nextExpiryAt].filter(
      (value): value is number => value !== null,
    );
    if (expiries.length === 0) {
      state.assemblyTimer = null;
      return;
    }
    const nextExpiryAt = Math.min(...expiries);
    const timer = setTimeout(
      () => {
        state.assemblyTimer = null;
        const now = Date.now();
        for (const event of state.indexAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "sessions-index",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        for (const event of state.configAssembler.expire(now)) {
          if (event.kind === "fault") {
            markAssemblyFault(
              state,
              "workspace-config",
              event.fault.reasonCode,
              faultDeliveryKindOf(event),
            );
          }
        }
        scheduleAssemblyExpiry(state);
      },
      Math.max(0, nextExpiryAt - Date.now()),
    );
    timer.unref?.();
    state.assemblyTimer = timer;
  }

  function handleSessionsIndexWire(
    state: WorkspaceIngestState,
    wire: SessionsIndexTopicWireCandidate,
  ): void {
    if (runtimeState.disposed || wire.topic !== ctx.indexTopicFor(state)) return;
    // ownership 必须先于 assembly；foreign sub 不得占用 decoded staging。
    if (state.indexSubscriptionId === null) {
      if (state.indexPending) {
        ctx.stagePendingFrame(state, "sessions-index", state.indexPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.indexSubscriptionId) return;
    const events = state.indexAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.indexAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "sessions-index",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          ctx.applySessionsIndexFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  function handleWorkspaceConfigWire(
    state: WorkspaceIngestState,
    wire: WorkspaceConfigTopicWireCandidate,
  ): void {
    if (runtimeState.disposed || wire.topic !== ctx.configTopicFor(state)) return;
    if (state.configSubscriptionId === null) {
      if (state.configPending) {
        ctx.stagePendingFrame(state, "workspace-config", state.configPending, wire);
      }
      return;
    }
    if (wire.subscriptionId !== state.configSubscriptionId) return;
    const events = state.configAssembler.accept(wire);
    const fault = events.find((event) => event.kind === "fault");
    if (fault?.kind === "fault") {
      state.configAssembler.abort(wire.topic, wire.subscriptionId);
      markAssemblyFault(
        state,
        "workspace-config",
        fault.fault.reasonCode,
        faultDeliveryKindOf(fault),
      );
    } else {
      for (const event of events) {
        if (event.kind === "complete") {
          ctx.applyWorkspaceConfigFrame(state, event.frame, deliveryKindOf(event));
        }
      }
    }
    scheduleAssemblyExpiry(state);
  }

  return {
    markAssemblyFault,
    scheduleAssemblyExpiry,
    handleSessionsIndexWire,
    handleWorkspaceConfigWire,
  };
}
