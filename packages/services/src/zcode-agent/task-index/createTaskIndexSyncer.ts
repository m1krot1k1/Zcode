/**
 * task-index/createTaskIndexSyncer.ts: Композиция syncer'а task index.
 *
 * Единственный владелец состояния — late-bound `TaskIndexRuntime`: группы
 * (emitters/targets/frames/recovery/subscribe/wire/ingest/facts/snapshot/lifecycle)
 * собираются в один контекст, поэтому взаимные вызовы не зависят от порядка модулей.
 */
import type { Event } from "@zcode/rpc";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { createEmittersHelpers } from "./emitters.js";
import { createSessionsIndexIngestHelpers } from "./sessionsIndexIngest.js";
import { createSnapshotSyncHelpers } from "./snapshotSync.js";
import { createTaskFactsHelpers } from "./taskFactsBridge.js";
import { createTargetHelpers } from "./targets.js";
import { createTaskIndexCoreState } from "./state.js";
import { createTopicFramesHelpers } from "./topicFrames.js";
import { createTopicIngestHelpers } from "./topicWire.js";
import { createTopicRecoveryHelpers } from "./topicRecovery.js";
import { createTopicSubscribeHelpers } from "./topicSubscribe.js";
import { createWorkspaceConfigIngestHelpers } from "./workspaceConfigIngest.js";
import { createWorkspaceLifecycleHelpers } from "./workspaceLifecycle.js";
import type {
  CreateZCodeTaskIndexSyncerOptions,
  TaskIndexRuntime,
  WorkspaceEventInput,
  ZCodeTaskIndexSyncer,
} from "./contracts.js";
import { isTerminalPhase } from "./contracts.js";
import type { ZCodeAgentSessionTarget } from "../zcodeAgent.js";

export function createZCodeTaskIndexSyncer(
  options: CreateZCodeTaskIndexSyncerOptions,
): ZCodeTaskIndexSyncer {
  const ctx = createTaskIndexCoreState(options) as TaskIndexRuntime;
  // 装配顺序只影响当场解构的基础字段（state/emitters）；跨组调用都走 ctx，
  // 因此 recovery ↔ subscribe ↔ ingest 的相互调用在运行时总能解析到实现。
  Object.assign(ctx, createEmittersHelpers(ctx));
  Object.assign(ctx, createTargetHelpers());
  Object.assign(ctx, createTopicFramesHelpers(ctx));
  Object.assign(ctx, createTaskFactsHelpers(ctx));
  Object.assign(ctx, createSnapshotSyncHelpers(ctx));
  Object.assign(ctx, createSessionsIndexIngestHelpers(ctx));
  Object.assign(ctx, createWorkspaceConfigIngestHelpers(ctx));
  Object.assign(ctx, createTopicRecoveryHelpers(ctx));
  Object.assign(ctx, createTopicSubscribeHelpers(ctx));
  Object.assign(ctx, createTopicIngestHelpers(ctx));
  Object.assign(ctx, createWorkspaceLifecycleHelpers(ctx));

  const runtimeLifecycleDisposables = ctx.installRuntimeLifecycle();

  return {
    activeTaskRefs() {
      return [...ctx.workspaceIngests.values()].flatMap((state) =>
        [...state.summaries.values()]
          .filter((summary) => !isTerminalPhase(summary.phase))
          .map((summary) => ({ ...state.target, taskId: summary.sessionId })),
      );
    },
    ensureWorkspaceSubscription: ctx.ensureWorkspaceSubscription,

    ensureSessionSubscription(target: ZCodeAgentSessionTarget): void {
      if (!target.sessionId || !target.workspacePath) {
        return;
      }
      ctx.ensureWorkspaceSubscription({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      });
    },

    mutateSessionFacts: ctx.mutateSessionFacts,
    syncSnapshotAndBroadcast: ctx.syncSnapshotAndBroadcast,

    syncTaskModel: ctx.syncTaskModel,

    emitWorkspaceTaskListChanged: ctx.emitWorkspaceTaskListChanged,

    getWorkspaceEmitter: ctx.getWorkspaceEmitter,

    onDynamicWorkspaceEvent(workspace: WorkspaceEventInput): Event<ZCodeWorkspaceEvent> {
      // 任务列表挂载会为所有 restored workspace 调用本入口。监听事件不代表
      // 用户使用该 workspace，禁止在这里激活 sessions-index 或启动 Agent。
      return ctx.getWorkspaceEmitter(workspace).event;
    },

    onSessionTerminalEvent: ctx.terminalEventEmitter.event,

    onSessionReadyEvent: ctx.readyEventEmitter.event,

    disposeAll(): void {
      ctx.runtimeState.disposed = true;
      for (const state of ctx.workspaceIngests.values()) {
        state.indexSubscriptionGeneration += 1;
        state.configSubscriptionGeneration += 1;
        state.indexRecoveryGeneration += 1;
        state.configRecoveryGeneration += 1;
        if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
        if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
        state.indexRetryTimer = null;
        state.configRetryTimer = null;
        ctx.discardIndexRecovery(state);
        ctx.discardConfigRecovery(state);
        ctx.clearPendingState(state);
        ctx.clearActiveSubscriptions(state);
        for (const disposable of state.disposables) {
          try {
            disposable.dispose();
          } catch {
            // 忽略 dispose 异常，确保所有订阅都尝试释放
          }
        }
      }
      ctx.workspaceIngests.clear();
      for (const emitter of ctx.workspaceEmitters.values()) {
        emitter.dispose();
      }
      ctx.workspaceEmitters.clear();
      ctx.terminalEventEmitter.dispose();
      ctx.readyEventEmitter.dispose();
      for (const disposable of runtimeLifecycleDisposables) disposable.dispose();
      ctx.availableRuntimeGenerationByWorkspaceKey.clear();
    },
  };
}
