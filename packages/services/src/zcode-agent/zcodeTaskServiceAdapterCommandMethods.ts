/**
 * zcodeTaskServiceAdapterCommandMethods.ts: Методы IZCodeTaskService: prompt, runtime-команды и stop/compact/goal.
 */
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { TaskAdapterContext } from "./zcodeTaskServiceAdapterContext.js";
import type {
  ZCodeCancelTaskCommandResult,
  ZCodeEnqueueTaskCommandResult,
  ZCodeTaskRuntimeCommand,
} from "@zcode/shared";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import { logger, unsupported } from "./zcodeTaskServiceAdapterCore.js";
import { userInputResponseToElicitationStreamEvent } from "./zcodeTaskServiceAdapterElicitationMapping.js";
import { assertV4CommandAckOk, createHostCommandEnvelope } from "./zcodeV4HostCommand.js";
import { resolveWorkspaceKey } from "@zcode/shared";

export function createCommandMethods(
  context: TaskAdapterContext,
): Pick<
  IZCodeTaskService,
  | "sendPrompt"
  | "deliverSessionMessage"
  | "sendSessionMessageDeliveryResult"
  | "enqueueTaskCommand"
  | "promoteTaskCommand"
  | "cancelTaskCommand"
  | "stopGeneration"
  | "compactSession"
  | "goalSession"
  | "respondPermission"
  | "respondElicitation"
> {
  const {
    activePromptInputIds,
    runtimeCommands,
    assertCurrentOwnerRun,
    clearStreamingToolInputCache,
    emitTaskEvent,
    emitWorkspaceTaskListChanged,
    getTaskTarget,
    notifySyncerSession,
    taskKey,
    turnAttributionOf,
    workspaceKey,
    sendPromptToAgent,
    emitRuntimeCommandSnapshotUpdated,
    scheduleRuntimeCommandDrain,
    setRuntimeCommands,
    syncTaskIndexSnapshot,
    clearLiveToolProjection,
    options,
  } = context;
  return {
    async sendPrompt(params): Promise<void> {
      const storedTarget = getTaskTarget(params.taskId);
      const target = {
        ...storedTarget,
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      };
      await sendPromptToAgent(target, {
        traceId: params.traceId,
        queryId: params.queryId,
        messageId: params.messageId,
        content: params.content,
        attachments: params.attachments,
        ...turnAttributionOf(params),
        toolDenylist: params.toolDenylist,
        botDeliveryTarget: params.botDeliveryTarget,
        clientId: params.clientId,
        clientMode: params.clientMode,
        modelSelection: params.modelSelection,
        modelExecution: params.modelExecution,
      });
    },

    async deliverSessionMessage(
      _request: SessionMessageSendRequested,
    ): Promise<SessionMessageDeliveryResult> {
      unsupported("deliverSessionMessage");
    },

    async sendSessionMessageDeliveryResult(): Promise<void> {
      unsupported("sendSessionMessageDeliveryResult");
    },

    async enqueueTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const workspaceKeyValue = workspaceKey(params);
      const command: ZCodeTaskRuntimeCommand = {
        commandId: params.commandId,
        taskId: params.taskId,
        traceId: params.traceId,
        queryId: params.queryId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKeyValue,
        status: "accepted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clientId: params.clientId,
        clientLabel: params.clientLabel,
        type: "send_prompt",
        content: params.content,
        attachments: params.attachments,
        // manual run / 手机 replayable 的 prompt 可能先进入 host command queue；
        // 若这里丢 automationId，drain 时会按普通用户输入发送，CronCreate 会重新暴露。
        automationId: params.automationId,
      };
      const key = taskKey(params);
      runtimeCommands.set(key, [...(runtimeCommands.get(key) ?? []), command]);
      // 手机 replayable host command 被 accepted 后，前端本地 drain 会主动跳过 hostCommand。
      // 因此 host 需要在当前 task 已空闲时自行触发消费；桌面 continuous 不调用该入口，不会受影响。
      scheduleRuntimeCommandDrain(params, "enqueue");
      return { accepted: true, command };
    },

    async promoteTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      if (!command) {
        throw Object.assign(new Error("Task command not found."), {
          code: "OWNER_COMMAND_FAILED",
        });
      }
      if (command.status === "running") {
        return { accepted: true, command };
      }
      const nextCommand = {
        ...command,
        status: "accepted" as const,
        updatedAt: Date.now(),
      };
      runtimeCommands.set(key, [nextCommand, ...commands.filter((item) => item !== command)]);
      scheduleRuntimeCommandDrain(params, "promote");
      return { accepted: true, command: nextCommand };
    },

    async cancelTaskCommand(params): Promise<ZCodeCancelTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      if (!command) {
        logger.info(undefined, "ZCode task command 取消时已不存在", {
          commandId: params.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: true,
          commandId: params.commandId,
          reason: "not_found",
        };
      }
      if (command.status === "running") {
        logger.info(command.traceId, "ZCode task command 已开始运行，跳过取消", {
          commandId: command.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: false,
          commandId: command.commandId,
          reason: "already_running",
          status: command.status,
        };
      }
      // 手机 replayable 队列的事实源在 host runtime command queue。
      // 删除按钮不能只清 renderer 本地 store，否则下一次 snapshot 会把已 accepted 的命令恢复回来。
      setRuntimeCommands(
        params,
        commands.filter((item) => item.commandId !== command.commandId),
      );
      emitRuntimeCommandSnapshotUpdated(params, command.traceId);
      logger.info(command.traceId, "ZCode task command 已取消", {
        commandId: command.commandId,
        status: command.status,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      return {
        canceled: true,
        commandId: command.commandId,
        status: command.status,
      };
    },

    async stopGeneration(params): Promise<void> {
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      logger.info(params.runId, "ZCode task facade stopGeneration 开始", {
        hasRunId: Boolean(params.runId),
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      // session/stop → v4 stop 命令（goal-pause barrier 语义由 CLI 原生 handler 承接）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "stop",
          // 话题停止必须保留已观察到的执行身份；日志 traceId 不能替代 CLI 执行身份。
          payload: params.expectedForegroundExecutionId
            ? { expectedForegroundExecutionId: params.expectedForegroundExecutionId }
            : {},
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
      logger.info(params.runId, "ZCode task facade stopGeneration ACK", {
        durationMs: Date.now() - startedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    },

    async compactSession(params) {
      // v4 compact 是 CAS 命令（必带 v4 conversation revision
      // 的 baseRevision），而本 facade 的 expectedRevision 是旧协议 stateRevision——
      // 两套计数器不可互换；replayable 侧拿到 v4 revision 前强行迁移会造成假 stale。
      // 且 v4 compact 无 instructions/runtimeModel 载荷。
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      if (params.inputId) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      try {
        const result = await options.zcodeAgentService.compactSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
          inputId: params.inputId,
          instructions: params.instructions,
          expectedRevision: params.expectedRevision,
        });
        if (result.compact?.state === "accepted") {
          return result;
        }
        const meta = await syncTaskIndexSnapshot(result.snapshot);
        // compact 收敛是状态同步，不涉及归属；缺省 task_meta_changed 会触发全局 membership 重拉。
        emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
        activePromptInputIds.delete(taskKey(target));
        return result;
      } catch (error) {
        activePromptInputIds.delete(taskKey(target));
        throw error;
      }
    },

    async goalSession(params) {
      // v4 sendGoalCommand 只覆盖 set 语义（text 原文），
      // 本 facade 的 action=resume/clear/replace/status 依赖旧 op 的结构化 action 面
      // （v4 侧 resumeGoal 是 CAS 命令，revision 计数器问题同 compactSession）。
      // 过渡归宿 = replayable v4 读路径收口，与 compactSession 同批。
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      const mayStartContinuation =
        params.action === "set" || params.action === "replace" || params.action === "resume";
      if (mayStartContinuation) {
        // goal resume 也可能启动新一轮模型输出，不能继承上一轮 live-only 工具。
        clearLiveToolProjection(target);
        clearStreamingToolInputCache(target);
      }
      if (params.inputId && mayStartContinuation) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      logger.info(params.inputId, "[zcode-task-service] goalSession start", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        mayStartContinuation,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const result = await options.zcodeAgentService.goalSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        inputId: params.inputId,
        action: params.action,
        objective: params.objective,
        expectedRevision: params.expectedRevision,
      });
      logger.info(params.inputId, "[zcode-task-service] goalSession agent 返回", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        responseLength: result.response?.length ?? 0,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const syncStartedAt = Date.now();
      const meta = await syncTaskIndexSnapshot(result.snapshot);
      // goal 动作后的快照收敛同为状态同步，不涉及归属，避免全局 membership 重拉。
      emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
      logger.info(params.inputId, "[zcode-task-service] goalSession task index 同步完成", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        syncDurationMs: Date.now() - syncStartedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      if (!mayStartContinuation || result.snapshot.session.status !== "running") {
        activePromptInputIds.delete(taskKey(target));
      }
      return result;
    },

    async respondPermission(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // permission 回执收敛 v4 resolveInteraction。
      // interactionId ≡ 业务 requestId（CLI interaction-broker 同源注册）；optionId 由
      // CLI 侧 buildProtocolPermissionOptions 精确回映 response（allow_project 的
      // permissionUpdates 持久化规则不丢，见 interaction-broker v4AnswerToPermissionResponse）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: { optionId: params.optionId },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `permission ${params.requestId}`);
      return true;
    },

    async respondElicitation(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // AskUserQuestion/plan-approval 回执收敛 v4 resolveInteraction。
      // answer.action/content 是 additive 扩展（多题答案/注解无损承载，CLI 侧
      // interaction-broker 优先按 action 精确映射，缺省回落 optionId/freeText 兼容路径）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: {
              action: params.action,
              ...(params.content ? { content: params.content } : {}),
            },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `elicitation ${params.requestId}`);
      if (params.clientMode === "web-remote-replayable") {
        // 语义保真（原 agentService.respondUserInput 的 web-remote-replayable 分支）：
        // 手机远控应答后，桌面/其它 observer 需要显式响应事件清理同一 requestId 的弹窗；
        // v4 命令路径不再经过旧 respondUserInput，这里由 adapter 本地补投同一事件。
        emitTaskEvent(
          target,
          userInputResponseToElicitationStreamEvent(params.taskId, params.requestId, {
            action: params.action,
            content: params.content,
          }),
        );
      }
      return true;
    },
  };
}
