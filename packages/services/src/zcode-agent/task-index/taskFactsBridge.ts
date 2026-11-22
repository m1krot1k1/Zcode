/**
 * task-index/taskFactsBridge.ts: Мост к домену task-facts — зеркалирование summary,
 * reconcile пропусков snapshot, мутации намерений и адресная перечитка строки из CLI.
 */
import { createTaskFacts } from "#src/task-facts/index.js";
import type { TaskFactMutation } from "#src/task-facts/contract.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { assertV4CommandAckOk, createHostCommandEnvelope } from "../zcodeV4HostCommand.js";
import type { TaskFactsHelpers, TaskIndexRuntime, WorkspaceIngestState } from "./contracts.js";
import type { ZCodeAgentSessionTarget } from "../zcodeAgent.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createTaskFactsHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    | "agentService"
    | "taskIndexRepo"
    | "isLiveState"
    | "syncSnapshotAndBroadcast"
    | "emitWorkspaceTaskListChanged"
  >,
): TaskFactsHelpers {
  const { agentService, taskIndexRepo, isLiveState } = ctx;

  const taskFacts = createTaskFacts({
    store: taskIndexRepo,
    source: {
      reconcile: async (target, sessionIds) => {
        if (!agentService.reconcileSessionsIndexV4)
          throw new Error("sessions-index.reconcile-unavailable");
        return agentService.reconcileSessionsIndexV4({ ...target, sessionIds });
      },
      execute: async (target, intent) => {
        const envelope =
          intent.type === "delete"
            ? createHostCommandEnvelope({
                type: "deleteSession",
                sessionId: target.taskId,
                payload: {},
              })
            : createHostCommandEnvelope({
                type: "renameSession",
                sessionId: target.taskId,
                payload: { title: intent.title },
              });
        const ack = await agentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          envelope,
        });
        assertV4CommandAckOk(envelope.type, ack, target.taskId);
      },
    },
    changed: ({ target, meta, reason }) => ctx.emitWorkspaceTaskListChanged(target, meta, reason),
  });

  async function reconcileSnapshotOmissions(
    state: WorkspaceIngestState,
    snapshotSeq: number,
  ): Promise<void> {
    if (!agentService.reconcileSessionsIndexV4) return;
    try {
      await taskFacts.reconcile(
        state.target,
        new Set(state.summaries.keys()),
        () => isLiveState(state) && state.indexSeq === snapshotSeq,
      );
    } catch (error) {
      if (isLiveState(state))
        logger.warn(undefined, "CLI 会话对账未完成，保留已有行和待交接意图", error);
    }
  }

  const refreshSessionFacts = (target: ZCodeAgentSessionTarget) =>
    taskFacts.refresh({ ...target, taskId: target.sessionId });
  const mutateSessionFacts = (target: ZCodeAgentSessionTarget, intent: TaskFactMutation) =>
    taskFacts.mutate({ ...target, taskId: target.sessionId }, intent);
  const mirrorSummary = taskFacts.ingest;

  async function resyncTaskIndexRowFromAgent(
    target: ZCodeAgentSessionTarget,
    reason: string,
    options?: {
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
    },
  ): Promise<void> {
    try {
      // task-index 是被动观察者，只能读取现有 runtime。调用 resumeSession
      // 会在用户下一轮 prompt 已被 Core 接受后重新 materialize/resume 同一 session，
      // 形成第二个生命周期 writer；readSession(existing-only) 保留完整 snapshot
      // 的索引能力，同时不会拉起或修改 runtime。
      // 性能根因：每轮 turn 完成/改标题/变可见都会走这里，完整历史单行可达 ~15MB，
      // host stdio 帧解析与 JSON.parse 被打满；index 只读标题/正文/可见性/状态，
      // 故请求 contentProfile "index"（剥离 tool/reasoning/data URL 大载荷，结构不变）。
      // 不能用 messageLimit：searchableText 与标题回退依赖历史开头。
      const snapshot = await agentService.readSession({
        ...target,
        runtimePolicy: "existing-only",
        contentProfile: "index",
      });
      // 回源收敛是状态/正文同步，不涉及 pin/archive/unread 归属（task_status_changed）。
      await ctx.syncSnapshotAndBroadcast(snapshot, {
        ...(options?.unreadSignal ? { unreadSignal: options.unreadSignal } : {}),
        broadcastReason: "task_status_changed",
      });
    } catch (error) {
      logger.warn(
        undefined,
        `回源同步 task index 行失败 reason=${reason} taskId=${target.sessionId}`,
        error,
      );
    }
  }

  return {
    taskFacts,
    mirrorSummary,
    refreshSessionFacts,
    mutateSessionFacts,
    reconcileSnapshotOmissions,
    resyncTaskIndexRowFromAgent,
  };
}
