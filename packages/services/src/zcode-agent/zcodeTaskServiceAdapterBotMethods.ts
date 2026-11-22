/**
 * zcodeTaskServiceAdapterBotMethods.ts: Методы IZCodeTaskService для bot-групп и topic admission.
 */
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { TaskAdapterContext } from "./zcodeTaskServiceAdapterContext.js";
import { uploadBotGroupAttachments } from "./groupAttachmentUpload.js";
import { textFromParts } from "./zcodeTaskServiceAdapterMessageMapping.js";
import { assertV4CommandAckOk, createHostCommandEnvelope } from "./zcodeV4HostCommand.js";
import {
  readBotGroupRuntimeSnapshot,
  waitBotGroupExecutionEnd,
} from "#src/zcode-agent/groupRuntimeSnapshot.js";

export function createBotMethods(
  context: TaskAdapterContext,
): Pick<
  IZCodeTaskService,
  | "readBotTopicSummaries"
  | "invalidateBotTopicInputs"
  | "readBotTopicExecution"
  | "stopBotTopicExecution"
  | "getBotGroupTaskBlockReason"
  | "cancelBotGroupInput"
  | "submitBotGroupInput"
> {
  const { botAgent, taskTargets, topicAdmission, getTaskTarget, taskKey, options } = context;
  return {
    async readBotTopicSummaries(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey(params))
        throw new Error("Topic task workspace mismatch");
      const messages = await options.zcodeAgentService.readSessionMessages({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId,
        sessionId: params.taskId,
        limit: 200,
      });
      return messages
        .flatMap(({ info, parts }) => {
          if (info.role !== "user" || info.source !== "bot_topic_context") return [];
          return [
            {
              checkpoint: String(info.metadata?.checkpoint ?? ""),
              text:
                typeof info.metadata?.displayText === "string"
                  ? info.metadata.displayText
                  : textFromParts(parts),
            },
          ];
        })
        .slice(-20);
    },

    async invalidateBotTopicInputs(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const key = JSON.stringify([
        taskKey(params),
        params.remoteSessionId ?? target.remoteSessionId ?? null,
      ]);
      await topicAdmission.invalidate(key);
    },
    async readBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        ...params,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: params.taskId,
      });
      if (snapshot.control.stopState === "idle") return undefined;
      const execution = snapshot.control.activeWorks.find((work) => work.foregroundExecutionId);
      if (!execution?.foregroundExecutionId)
        throw new Error("Topic execution identity is unavailable");
      return {
        executionId: execution.foregroundExecutionId,
        sourceCommandId: execution.sourceCommandId,
      };
    },
    async stopBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const agent = botAgent(workspace);
      // 先注册终态监听再停止，避免快速结束发生在 ACK 与订阅之间。
      const observation = new AbortController();
      const ended = waitBotGroupExecutionEnd(
        agent,
        { ...workspace, sessionId: params.taskId },
        params.executionId,
        observation.signal,
      );
      void ended.catch(() => undefined);
      try {
        const ack = await agent.sendConversationCommandV4({
          ...workspace,
          envelope: createHostCommandEnvelope({
            type: "stop",
            sessionId: params.taskId,
            payload: { expectedForegroundExecutionId: params.executionId },
          }),
        });
        assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
        await ended;
      } finally {
        observation.abort();
      }
    },

    async getBotGroupTaskBlockReason(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey({ ...params, taskId: params.taskId }))
        throw new Error("Group task workspace mismatch");
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(params), {
        ...params,
        ...((params.remoteSessionId ?? target?.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId }
          : {}),
        sessionId: params.taskId,
      });
      if (snapshot.pendingInteractions.length > 0) return "interaction";
      if (snapshot.control.phase === "running" || snapshot.control.phase === "prewarming")
        return "running";
      if (snapshot.queue.items.length > 0) return "queued";
      return null;
    },
    async cancelBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const item = snapshot.queue.items.find(
        (entry) => entry.sourceCommandId === params.sourceCommandId,
      );
      if (!item || item.dispatch.state !== "queued") throw new Error("Input is no longer queued");
      const source = item.botGroupSource;
      if (
        !source ||
        source.botId !== params.botId ||
        source.chatId !== params.chatId ||
        (params.actorId !== params.ownerId && source.senderId !== params.actorId)
      )
        throw new Error("Queue cancellation is not authorized");
      return botAgent(workspace).sendConversationCommandV4({
        ...workspace,
        envelope: createHostCommandEnvelope({
          type: "deleteQueueItem",
          sessionId: target.taskId,
          commandId: params.commandId,
          baseRevision: snapshot.revision,
          payload: { queueItemId: item.queueItemId },
        }),
      });
    },

    async submitBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const admissionKey = JSON.stringify([
        taskKey({ ...workspace, taskId: target.taskId }),
        workspace.remoteSessionId ?? null,
      ]);
      const version = topicAdmission.capture(admissionKey);
      // Bug 原因：Host 重启后任务索引仍在，但 CLI 尚未加载原会话；直接 admission
      // 会返回 sessionNotFound。复用后台订阅的冷恢复屏障，不依赖 Desktop 打开任务。
      await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const attachments = await uploadBotGroupAttachments(
        botAgent(workspace),
        { ...workspace, sessionId: target.taskId },
        params.attachments ?? [],
      );
      // 停止可以发生在附件上传期间；完成上传不代表旧输入仍允许被接受。
      if (params.source.threadId && version !== topicAdmission.capture(admissionKey)) {
        throw new Error("Topic input was cancelled during preparation");
      }
      const envelope = createHostCommandEnvelope({
        type: "sendText",
        sessionId: target.taskId,
        commandId: params.commandId,
        clientId: `bot:${params.source.botId}:${params.source.chatId}:${params.source.senderId}`,
        payload: {
          text: params.content,
          attachments,
          requestedDelivery: params.source.threadId ? "startNow" : "queue",
          botGroupSource: params.source,
          conversationQuotes: params.conversationQuotes,
          botDeliveryTarget: {
            provider: params.source.provider,
            botId: params.source.botId,
            providerUserId: params.source.chatId,
            chatType: "group",
            ...(params.source.threadId
              ? { threadId: params.source.threadId, rootMessageId: params.source.rootMessageId }
              : {}),
          },
        },
      });
      const send = async () => {
        try {
          return await botAgent(workspace).sendConversationCommandV4({
            ...workspace,
            envelope,
          });
        } catch (error) {
          // ACK 丢失时查询同一个命令，不能生成新 ID 重发输入。
          const query = await botAgent(workspace)
            .queryConversationCommandsV4({
              ...workspace,
              commands: [{ sessionId: target.taskId, commandId: params.commandId }],
            })
            .catch(() => null);
          const result = query?.results[0]?.result;
          if (result && result !== "unknown") return result;
          throw error;
        }
      };
      return params.source.threadId ? topicAdmission.run(admissionKey, version, send) : send();
    },
  };
}
