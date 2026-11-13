/**
 * zcodeTaskServiceAdapterAdminMethods.ts: Методы IZCodeTaskService: удаление/метаданные задач, подписки и dispose.
 */
import type {
  IZCodeTaskService,
  ZCodeArchivedTaskDeletionResult,
  ZCodeTaskReadyOutcome,
  ZCodeTaskTerminalOutcome,
} from "../session/zcodeTaskService.js";
import type { TaskAdapterContext } from "./zcodeTaskServiceAdapterContext.js";
import type {
  ZCodeStreamEvent,
  ZCodeTaskCreateResult,
  ZCodeTaskMeta,
  ZCodeWorkspaceEvent,
} from "@zcode/shared";
import { logger, unsupported } from "./zcodeTaskServiceAdapterCore.js";
import { toZCodeDeliveryKind } from "./zcodeTaskServiceAdapterSnapshotSupport.js";
import { Event } from "@zcode/rpc";
import { resolveWorkspaceKey } from "@zcode/shared";

export function createTaskAdminMethods(
  context: TaskAdapterContext,
): Pick<
  IZCodeTaskService,
  | "deleteTask"
  | "deleteArchivedTask"
  | "deleteArchivedTasks"
  | "renameTask"
  | "setTaskPinned"
  | "setTaskUnread"
  | "archiveTask"
  | "unarchiveTask"
  | "branchTaskFromPrompt"
  | "onDynamicStreamEvent"
  | "onDynamicTaskTerminalOutcome"
  | "onDynamicTaskReady"
  | "onDynamicTaskEvent"
  | "onDynamicWorkspaceEvent"
  | "onError"
> & { disposeAll(): void; disposeAllAndWait(): Promise<void> } {
  const {
    activePromptInputIds,
    botConnectionScopes,
    errorEmitter,
    legacySnapshotTaskKeys,
    memoryDiagnostics,
    taskIndexRepo,
    taskIndexSyncer,
    emitWorkspaceTaskListChanged,
    getGlobalTaskEmitter,
    getTaskEmitter,
    rememberTaskTarget,
    taskKey,
    disposeLocalTaskState,
    disposeZCodeAgentServiceAndWait,
    forgetTaskRuntimeState,
    mapServiceEvent,
    updateIndexedTaskState,
    options,
  } = context;
  return {
    async deleteTask(params): Promise<void> {
      forgetTaskRuntimeState(params);
      options.zcodeAgentService.forgetSession?.({ ...params, sessionId: params.taskId });
      await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "delete" },
      );
    },

    async deleteArchivedTask(params): Promise<boolean> {
      const meta = await taskIndexRepo.deleteArchivedTask(params);
      if (!meta) return false;
      forgetTaskRuntimeState(params);
      options.zcodeAgentService.forgetSession?.({ ...params, sessionId: params.taskId });
      await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "delete" },
      );
      emitWorkspaceTaskListChanged(params, meta, "task_deleted");
      return true;
    },

    async deleteArchivedTasks(params): Promise<ZCodeArchivedTaskDeletionResult> {
      const result: ZCodeArchivedTaskDeletionResult = {
        deletedTaskIds: [],
        skippedTaskIds: [],
        failedTaskIds: [],
      };
      const taskIds = [...new Set(params.taskIds)];
      if (taskIds.length === 0) return result;
      const startedAt = Date.now();
      for (const taskId of taskIds) {
        const target = {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId,
        };
        try {
          // 保留逐项事务与归档 guard：一项失败不能回滚其它成功项，也不能提前隐藏失败项。
          const meta = await taskIndexRepo.deleteArchivedTask(target);
          if (!meta) {
            result.skippedTaskIds.push(taskId);
            continue;
          }
          await taskIndexSyncer.mutateSessionFacts(
            { ...target, sessionId: taskId },
            { type: "delete" },
          );
          forgetTaskRuntimeState(target);
          options.zcodeAgentService.forgetSession?.({ ...target, sessionId: taskId });
          result.deletedTaskIds.push(taskId);
        } catch (error) {
          result.failedTaskIds.push(taskId);
          logger.warn(undefined, "[ArchivedTaskDeletion] 批次目标删除失败", { ...target, error });
        }
      }
      if (result.deletedTaskIds.length > 0) {
        // 根因：循环调用单条接口会逐项广播，驱动 Host 与 UI 各自全量重读。
        // 批次完成只发一次 workspace 事件，仍使所有观察端换代 deleted membership，防止任务复活。
        emitWorkspaceTaskListChanged(params, undefined, "task_deleted");
      }
      logger.info(undefined, "[ArchivedTaskDeletion] batch completed", {
        workspaceKey: resolveWorkspaceKey(params),
        requested: taskIds.length,
        deleted: result.deletedTaskIds.length,
        skipped: result.skippedTaskIds.length,
        failed: result.failedTaskIds.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },

    async renameTask(params): Promise<ZCodeTaskMeta> {
      const meta = await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "rename", title: params.title },
      );
      if (!meta) throw new Error("task.not-found");
      return meta;
    },

    async setTaskPinned(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, {
        pinned: params.pinned,
      });
      emitWorkspaceTaskListChanged(params, meta, params.pinned ? "task_pinned" : "task_unpinned");
      return meta;
    },

    async setTaskUnread(params): Promise<ZCodeTaskMeta> {
      if (!params.unread && typeof params.expectedUnreadAt === "number") {
        const result = await taskIndexRepo.clearTaskUnreadIfMatches({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          expectedUnreadAt: params.expectedUnreadAt,
        });
        // Bug 原因：旧手机点击可能晚于新的终态未读到达。CAS 未命中时必须把当前 meta
        // 广播出去让 renderer 对账，不能先乐观清除后留下 renderer-only 已读状态。
        if (result.cleared) {
          emitWorkspaceTaskListChanged(params, result.meta, "task_meta_changed");
        }
        return result.meta;
      }

      const unreadAt = params.unread ? Date.now() : undefined;
      const meta = await updateIndexedTaskState(params, { unreadAt });
      // Bug 原因：repository 可能为避免同毫秒 CAS 版本碰撞而推进 unreadAt；
      // 必须把最终持久值广播给 renderer 对账，否则后续 snapshot 会继续暴露旧 marker。
      // unread 归属在 tasks-index、sessions-index 不携带，必须走 task_meta_changed 触发 membership 重拉。
      emitWorkspaceTaskListChanged(params, meta, "task_meta_changed");
      return meta;
    },

    async archiveTask(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, { archived: true });
      emitWorkspaceTaskListChanged(params, meta, "task_archived");
      return meta;
    },

    async unarchiveTask(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, { archived: false });
      emitWorkspaceTaskListChanged(params, meta, "task_unarchived");
      return meta;
    },

    async branchTaskFromPrompt(): Promise<ZCodeTaskCreateResult> {
      unsupported("branchTaskFromPrompt");
    },

    onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent> {
      return getGlobalTaskEmitter(taskId).event;
    },

    onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome> {
      // 合并迁移：V4 syncer 只暴露归一化后的终态 kind，不再携带旧协议 event payload。
      // automation 只需要稳定收口运行结果，因此 completed/failed 在此映射为公开 outcome。
      return (listener) =>
        taskIndexSyncer.onSessionTerminalEvent((terminal) => {
          if (terminal.target.sessionId !== taskId) {
            return;
          }
          const target = {
            taskId,
            workspacePath: terminal.target.workspacePath,
            workspaceIdentity: terminal.target.workspaceIdentity,
          };
          const inputId = activePromptInputIds.get(taskKey(target));
          listener({
            taskId,
            ...(inputId ? { inputId } : {}),
            outcome: terminal.kind === "turn.failed" ? "failed" : "succeeded",
          });
        });
    },

    onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome> {
      return (listener) =>
        taskIndexSyncer.onSessionReadyEvent((ready) => {
          if (ready.target.sessionId !== taskId) {
            return;
          }
          listener({ taskId, reason: ready.reason });
        });
    },

    onDynamicTaskEvent(params): Event<ZCodeStreamEvent> {
      const target = {
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      };
      rememberTaskTarget(target);
      return (listener) => {
        const localDisposable = getTaskEmitter(target).event(listener);
        if (legacySnapshotTaskKeys.has(taskKey(target))) {
          // Bugfix: legacy ACP task 没有 zcode-cli sqlite session，恢复后只能作为只读历史。
          // 若继续向 ZCode Protocol 建 desktop-continuous/replayable 订阅，会反复触发
          // Session is not active 并刷爆日志；本地 emitter 已足够承接 rename/archive 等元数据事件。
          return localDisposable;
        }
        // M5 ③-2 复核（2026-07-06）：这里仍是 services/ 内旧 session/subscribe 词表的
        // 最后消费点（replayable/bots 的 stream 投影源）。写路径（send/stop/交互回执）
        // 本波已收敛 v4 命令；读路径消费方是 bots handleStreamEvent（10 种事件词表）与
        // host 镜像 taskRealtimePort（词表同为 ZCodeStreamEvent），二者换 v4 帧 = relay
        // 协议 + 手机 store + bots 投影整波重做（且 ui/store 本波由并行 agent 主修，避让）。
        // 死期改判 = replayable 读路径 v4 store 波次（波次 3），与 host/index.ts 镜像、
        // mapStateUpdated/mapServiceEvent、agentService.onDynamicSessionEvent 同批摘除。
        const upstreamDisposable = options.zcodeAgentService.onDynamicSessionEvent({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          sessionId: params.taskId,
          deliveryKind: toZCodeDeliveryKind(params.deliveryKind),
          includeSnapshot: params.deliveryKind === "replayable",
        })((event) => mapServiceEvent(target, event));
        return {
          dispose() {
            upstreamDisposable.dispose();
            localDisposable.dispose();
          },
        };
      };
    },

    onDynamicWorkspaceEvent(workspace): Event<ZCodeWorkspaceEvent> {
      return taskIndexSyncer.onDynamicWorkspaceEvent(workspace);
    },

    onError: errorEmitter.event,

    disposeAll(): void {
      if (context.disposed) {
        return;
      }
      context.disposed = true;
      memoryDiagnostics.dispose();
      // syncer 持有 agentService 的 v4 帧订阅（sessions-index/workspace-config），
      // 必须在 agentService.disposeAll 前释放，否则 emitter dispose 时仍会回调到已失效的 syncer。
      // workspaceEmitters 已下沉到 syncer，由 syncer.disposeAll 统一回收。
      taskIndexSyncer.disposeAll();
      for (const scope of botConnectionScopes.values()) void scope.dispose();
      botConnectionScopes.clear();
      options.zcodeAgentService.disposeAll();
      disposeLocalTaskState();
    },

    async disposeAllAndWait(): Promise<void> {
      if (context.disposed) {
        return;
      }
      context.disposed = true;
      // app 退出必须先断开 task index syncer 的订阅，再等待 agent 进程树完成清理；
      // 否则 host 退出时会把 zcode-cli 的 SIGKILL 兜底 timer 一起带走。
      taskIndexSyncer.disposeAll();
      await Promise.all([...botConnectionScopes.values()].map((scope) => scope.dispose()));
      botConnectionScopes.clear();
      await disposeZCodeAgentServiceAndWait();
      disposeLocalTaskState();
    },
  };
}
