/**
 * zcodeTaskServiceAdapterPrompt.ts: Отправка промпта в ZCode Agent (sendText/legacy send).
 */
import type {
  CoreHelpers,
  CreateZCodeTaskServiceAdapterOptions,
  TaskAdapterState,
  TaskTarget,
} from "./zcodeTaskServiceAdapterCore.js";
import type { ToolProjectionHelpers } from "./zcodeTaskServiceAdapterToolProjection.js";
import type {
  TraceId,
  ZCodeAutomationBotDeliveryTarget,
  ZCodeBackgroundTurnAttribution,
  ZCodePromptAttachment,
  ZCodeTaskClientMode,
} from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "./zcodeTaskServiceAdapterCore.js";
import { assertV4CommandAckOk, createHostCommandEnvelope } from "./zcodeV4HostCommand.js";
import { resolveWorkspaceKey } from "@zcode/shared";

export type PromptHelpers = ReturnType<typeof createPromptHelpers>;

export function createPromptHelpers(
  deps: { options: CreateZCodeTaskServiceAdapterOptions } & Pick<
    TaskAdapterState,
    "activePromptInputIds"
  > &
    Pick<
      CoreHelpers,
      | "clearStreamingToolInputCache"
      | "notifySyncerSession"
      | "resolvePromptToolDenylist"
      | "taskKey"
      | "turnAttributionOf"
    > &
    Pick<ToolProjectionHelpers, "clearLiveToolProjection">,
) {
  const {
    activePromptInputIds,
    clearStreamingToolInputCache,
    notifySyncerSession,
    resolvePromptToolDenylist,
    taskKey,
    turnAttributionOf,
    clearLiveToolProjection,
    options,
  } = deps;

  async function sendPromptToAgent(
    target: TaskTarget,
    params: {
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      toolDenylist?: string[];
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      clientId?: string;
      clientMode?: ZCodeTaskClientMode;
      logReason?: string;
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void> {
    const startedAt = Date.now();
    notifySyncerSession(target);
    // live tool projection 只用于当前运行的终态收口。
    // 新输入开始时必须清掉上一轮 live-only 子工具，避免后续 snapshot 把旧工具补到新回复尾部。
    clearLiveToolProjection(target);
    clearStreamingToolInputCache(target);
    // ZCode task wrapper 的字段仍叫 traceId，但这里语义已经是单次输入 inputId。
    // 先记录 inputId，后续 ZCode session 事件回投 ZCode Agent 时才能让 UI 终态按输入轮次收口。
    activePromptInputIds.set(taskKey(target), params.traceId);
    logger.info(params.traceId, "ZCode task facade sendPrompt 开始", {
      attachmentCount: params.attachments?.length ?? 0,
      queryId: params.queryId ?? null,
      reason: params.logReason ?? "direct",
      taskId: target.taskId,
      textLength: params.content.length,
      workspaceIdentity: target.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(target),
      workspacePath: target.workspacePath,
    });
    try {
      const promptToolDenylist = resolvePromptToolDenylist(params);
      if (params.attachments?.length) {
        // 遗留（附件命令面）：v4 sendText 的 attachments 是 attachmentRef 引用模型，
        // 上传/寄存命令面尚未建模（CLI 侧 fork-edit-retry.ts 同款裁决“附件命令面后续”）。
        // 带附件输入保留旧 session/send，避免手机 replayable 图片/文件输入回归；
        // 过渡归宿 = v4 附件命令面（届时由 v4 sendText 承接）。
        await options.zcodeAgentService.sendPrompt({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          sessionId: target.taskId,
          inputId: params.traceId,
          queryId: params.queryId,
          messageId: params.messageId,
          content: params.content,
          attachments: params.attachments.map((attachment) => ({
            ...attachment,
          })),
          // 附件回退只改变载荷传输，不得丢掉本次已解析的模型或执行范围。
          modelSelection: params.modelSelection,
          modelExecution: params.modelExecution,
          ...turnAttributionOf(params),
          toolDenylist: promptToolDenylist,
          botDeliveryTarget: params.botDeliveryTarget,
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        });
      } else {
        // send 主路径收敛 v4 sendText。幂等键 inputId→commandId 对齐：
        // CLI 侧以 commandId 为 inputId 起 turn，终态事件 inputId 才能与 host command
        // queue 的 traceId 对账（completeRuntimeCommandByInputId 语义不变）。
        // heldQueueDisposition=keepQueueAndSend：旧 session/send 没有 held choice 闸门，
        // replayable 无人机交互路径按“立即发送、不动队列”等价老语义。
        const ack = await options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
          envelope: createHostCommandEnvelope({
            type: "sendText",
            payload: {
              text: params.content,
              heldQueueDisposition: "keepQueueAndSend",
              ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
              ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
              ...turnAttributionOf(params),
              ...(params.botDeliveryTarget ? { botDeliveryTarget: params.botDeliveryTarget } : {}),
              ...(promptToolDenylist ? { toolDisallowlist: promptToolDenylist } : {}),
            },
            sessionId: target.taskId,
            commandId: params.traceId,
            clientId: params.clientId,
          }),
        });
        assertV4CommandAckOk("sendText", ack, `session=${target.taskId}`);
      }
      logger.info(params.traceId, "ZCode task facade sendPrompt ACK", {
        durationMs: Date.now() - startedAt,
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    } catch (error) {
      activePromptInputIds.delete(taskKey(target));
      logger.warn(params.traceId, "ZCode task facade sendPrompt 失败", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      throw error;
    }
  }

  return { sendPromptToAgent };
}
