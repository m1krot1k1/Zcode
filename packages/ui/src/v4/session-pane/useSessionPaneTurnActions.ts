// SessionPane 拆分：回合与队列的用户动作（fork/edit/retry/feedback/queue 撤回与立即发送）。
import { toast } from "@/components/ui/toast.js";
import { prepareHighspeedSendContext } from "@/highspeed/highspeedSend.js";
import type { HighspeedSendContext, HighspeedTurnPreparer } from "@/highspeed/highspeedSend.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { buildDraftCreateConfigPayload } from "@/v4/composer/useDraftConfigControl.js";
import type { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import type { DraftPrewarmBinding } from "@/v4/composer/useDraftSessionPrewarm.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import type { ConfigCommandBarrier } from "@/v4/configCommandBarrier.js";
import type { ComposerRestoreRequest } from "@/v4/ConversationComposer.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type { HighspeedPaneOrigin, SessionPaneDispatchCommand } from "@/v4/session-pane/helpers.js";
import {
  resolveQueuedComposerRestore,
  shouldRestoreQueuedComposerFromAck,
} from "@/v4/session-pane/queuedComposerRestore.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";
import type { HighspeedCardSnapshot } from "@zcode/shared";
import type {
  AttachmentRef,
  CommandAck,
  CommandType,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface UseSessionPaneTurnActionsParams {
  sessionId: string | null;
  onSessionCreated: ((sessionId: string) => void) | undefined;
  attachmentRead: ReturnType<typeof useV4Conversation>["attachmentRead"];
  intl: IntlInstance;
  runtimeReady: boolean;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  activeHighspeedCard: HighspeedCardSnapshot | null;
  setHighspeedActivationCardId: Dispatch<SetStateAction<string | null>>;
  composerDraftStateRef: RefObject<{ hasContent: boolean; busy: boolean }>;
  setQueueEditOperation: Dispatch<
    SetStateAction<{ queueItemId: string; sessionId: string; workspaceKey: string } | null>
  >;
  queueEditOperationRef: RefObject<{
    queueItemId: string;
    sessionId: string;
    workspaceKey: string;
  } | null>;
  setComposerRestoreRequest: Dispatch<SetStateAction<ComposerRestoreRequest | null>>;
  nextComposerRestoreRequestIdRef: RefObject<number>;
  workspaceKey: string;
  composerBindingRef: RefObject<{ sessionId: string | null; workspaceKey: string }>;
  configCommandBarrier: ConfigCommandBarrier;
  draftConfigRef: ReturnType<typeof useDraftConfigControl>["draftConfigRef"];
  handleDraftSelectModel: (modelProvider: string, model: string, reasoningLevel?: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  appFollowupMode: "queue" | "guide" | null;
  snapshotSessionId: string | null;
  snapshotFollowupMode: "queue" | "guide" | null;
  snapshotRevision: number | null;
  dispatchCommand: SessionPaneDispatchCommand;
  prewarmBindingRef: RefObject<DraftPrewarmBinding | null>;
  prewarmSessionId: string | null;
  ensureDraftPrewarmConfigBeforeSendRef: RefObject<(targetSessionId: string) => Promise<void>>;
  captureHighspeedPaneOrigin: () => HighspeedPaneOrigin;
  prepareHighspeedTurnFrom: (origin: HighspeedPaneOrigin) => HighspeedTurnPreparer;
  focusTimelineToLatest: () => void;
}

export function useSessionPaneTurnActions(params: UseSessionPaneTurnActionsParams) {
  const {
    sessionId,
    onSessionCreated,
    attachmentRead,
    intl,
    runtimeReady,
    snapshotRef,
    activeHighspeedCard,
    setHighspeedActivationCardId,
    composerDraftStateRef,
    setQueueEditOperation,
    queueEditOperationRef,
    setComposerRestoreRequest,
    nextComposerRestoreRequestIdRef,
    workspaceKey,
    composerBindingRef,
    configCommandBarrier,
    draftConfigRef,
    handleDraftSelectModel,
    handleDraftSelectThought,
    appFollowupMode,
    snapshotSessionId,
    snapshotFollowupMode,
    snapshotRevision,
    dispatchCommand,
    prewarmBindingRef,
    prewarmSessionId,
    ensureDraftPrewarmConfigBeforeSendRef,
    captureHighspeedPaneOrigin,
    prepareHighspeedTurnFrom,
    focusTimelineToLatest,
  } = params;

  const handleComposerDraftStateChange = useCallback(
    (state: { hasContent: boolean; busy: boolean }) => {
      composerDraftStateRef.current = state;
    },
    [],
  );
  const clearQueueEditOperation = useCallback(() => {
    queueEditOperationRef.current = null;
    setQueueEditOperation(null);
  }, []);
  const handleComposerRestoreApplied = useCallback(
    (requestId: number) => {
      setComposerRestoreRequest((current) => (current?.requestId === requestId ? null : current));
      clearQueueEditOperation();
    },
    [clearQueueEditOperation],
  );
  const handleHighspeedActivationApplied = useCallback((cardId: string) => {
    // 按 cardId 消费：迟到的旧卡回调不能清掉新卡的激活请求。
    setHighspeedActivationCardId((current) => (current === cardId ? null : current));
  }, []);

  const handleFork = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // forkAssistant 是 CAS 命令：baseRevision 取当前投影 revision。
      void dispatchCommand(
        "forkAssistant",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          logger.warn(`[v4-pane] fork 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          return;
        }
        if (ack.result?.type === "forkAssistant") {
          // 原地切到 child session（与新建会话同一选择路径）。
          onSessionCreated?.(ack.result.sessionId);
        }
      });
    },
    [dispatchCommand, onSessionCreated, sessionId],
  );

  const handleEdit = useCallback(
    async (
      target: ConversationRowTarget,
      newText: string,
      attachments?: readonly AttachmentRef[],
      workspaceMode: "preserve" | "rewind" = "preserve",
      conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
    ) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      if (
        !newText.trim() &&
        (!attachments || attachments.length === 0) &&
        !conversationQuotes?.length
      ) {
        logger.warn("[v4-pane] edit 跳过：行内编辑内容为空且无附件");
        return false;
      }
      const highspeed = await prepareHighspeedSendContext(
        sessionId,
        prepareHighspeedTurnFrom(captureHighspeedPaneOrigin()),
      );
      const latest = snapshotRef.current;
      if (!latest || latest.sessionId !== sessionId) {
        logger.warn("[v4-pane] edit 跳过：Highspeed prepare 后 session 已切换");
        return false;
      }
      const ack = await dispatchCommand(
        "editUserQuery",
        {
          target,
          newText,
          workspaceMode,
          conversationQuotes,
          // editUserQuery 的 attachments 缺省表示保留 canonical 原附件；
          // 只有显式透传 []，CLI 才能区分“用户删除全部”与“调用方未修改附件”。
          ...(attachments ? { attachments: [...attachments] } : {}),
          ...highspeed.override,
        },
        sessionId,
        latest.revision,
        latest.logEpoch,
        undefined,
        highspeed.acceleratedCard,
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        logger.warn(`[v4-pane] edit 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        return false;
      }
      // fork ACK 只做旧协议解码兼容；新 edit 永不导航 child。blocked 由行内冲突弹窗处理。
      return ack;
    },
    [captureHighspeedPaneOrigin, dispatchCommand, prepareHighspeedTurnFrom, sessionId],
  );

  const dispatchRetryTurn = useCallback(
    async (target: ConversationRowTarget): Promise<CommandAck> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) {
        throw new Error("retryTurn 缺少当前 session 投影");
      }
      // retryTurn 是 CAS 命令：baseRevision 取当前投影 revision。
      return dispatchCommand(
        "retryTurn",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleRetry = useCallback(
    (target: ConversationRowTarget) => {
      void dispatchRetryTurn(target)
        .then((ack) => {
          if (ack.status !== "accepted") {
            logger.warn(`[v4-pane] retry 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
        })
        .catch((error: unknown) => {
          logger.warn("[v4-pane] retry 提交失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [dispatchRetryTurn],
  );

  const handleAssistantFeedback = useCallback(
    async (
      target: ConversationRowTarget,
      feedback: "like" | "dislike" | null,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return false;
      const ack = await dispatchCommand(
        "setAssistantFeedback",
        { target, feedback },
        sessionId,
        current.revision,
        current.logEpoch,
      );
      const accepted = ack.status === "accepted" || ack.status === "duplicate";
      if (!accepted) {
        logger.warn(`[v4-pane] assistant 反馈被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
      }
      return accepted;
    },
    [dispatchCommand, sessionId],
  );

  const handleDeleteQueueItem = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      const sourceCommandId = current.queue.items.find(
        (item) => item.queueItemId === queueItemId,
      )?.sourceCommandId;
      void dispatchCommand("deleteQueueItem", { queueItemId }, sessionId, current.revision).then(
        (ack) => {
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] deleteQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
            return;
          }
          if (sourceCommandId) pendingCommandRegistry.settle(sessionId, sourceCommandId);
        },
      );
    },
    [dispatchCommand, sessionId],
  );

  const handleEditQueueItem = useCallback(
    async (queueItemId: string): Promise<void> => {
      const current = snapshotRef.current;
      if (!sessionId || current === null || queueEditOperationRef.current) return;
      if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
        toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
        return;
      }
      const restoreTarget = resolveQueuedComposerRestore(current, queueItemId);
      if (!restoreTarget) {
        logger.warn(`[v4-pane] queue 撤回编辑跳过：queue item 不存在或不可编辑 ${queueItemId}`);
        return;
      }
      const operation = { queueItemId, sessionId, workspaceKey };
      queueEditOperationRef.current = operation;
      setQueueEditOperation(operation);
      const createdPreviewUrls: string[] = [];
      const attachmentPreviewUrls: Record<string, string> = {};
      const revokeCreatedPreviewUrls = () => {
        for (const url of createdPreviewUrls) URL.revokeObjectURL(url);
      };
      try {
        // delete 之后 ref 不再挂在队列上，attachment/read 会拒绝它。先取回 image/video，
        // 否则恢复出的 chip 没有 object URL，会被 composer 降成 application/octet-stream。
        if (runtimeReady) {
          await Promise.all(
            restoreTarget.attachments.map(async (attachment) => {
              const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
              if (!mime.startsWith("image/") && !mime.startsWith("video/")) return;
              const ref = attachment.previewRef ?? attachment.ref;
              try {
                const result = await attachmentRead({
                  sessionId,
                  ref,
                  ...(mime.startsWith("video/") ? { mediaType: attachment.mime } : {}),
                });
                if ("url" in result) {
                  attachmentPreviewUrls[ref] = result.url;
                  return;
                }
                const url = URL.createObjectURL(
                  new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
                );
                createdPreviewUrls.push(url);
                attachmentPreviewUrls[ref] = url;
              } catch (error) {
                logger.warn("[v4-pane] 撤回前读取队列缩略图失败", error);
              }
            }),
          );
        }
        if (composerDraftStateRef.current.hasContent || composerDraftStateRef.current.busy) {
          // 读取缩略图期间用户已经开始输入。此时删除会丢掉队列项，草稿侧又会拒绝恢复。
          revokeCreatedPreviewUrls();
          toast(intl.formatMessage({ id: "chat.queue.editDraftConflict" }));
          clearQueueEditOperation();
          return;
        }
        const ack = await dispatchCommand(
          "deleteQueueItem",
          { queueItemId },
          sessionId,
          restoreTarget.baseRevision,
        );
        if (!shouldRestoreQueuedComposerFromAck(ack.status)) {
          revokeCreatedPreviewUrls();
          logger.warn(`[v4-pane] queue 撤回编辑被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
          clearQueueEditOperation();
          return;
        }
        pendingCommandRegistry.settle(sessionId, restoreTarget.sourceCommandId);
        const currentBinding = composerBindingRef.current;
        if (
          currentBinding.sessionId !== sessionId ||
          currentBinding.workspaceKey !== workspaceKey
        ) {
          // delete ACK 异步返回时 pane 可能已切 task；旧实现若直接 setText，
          // 会把原 session 的 queue payload 写进新 task。权威删除保留，但本地恢复必须放弃。
          revokeCreatedPreviewUrls();
          logger.warn("[v4-pane] queue 撤回编辑未恢复：ACK 返回前 composer 已切换", {
            queueItemId,
            sessionId,
            workspaceKey,
          });
          clearQueueEditOperation();
          return;
        }
        setComposerRestoreRequest({
          requestId: nextComposerRestoreRequestIdRef.current++,
          sessionId,
          workspaceKey,
          inputKind: restoreTarget.inputKind,
          text: restoreTarget.text,
          attachments: restoreTarget.attachments,
          ...(Object.keys(attachmentPreviewUrls).length > 0 ? { attachmentPreviewUrls } : {}),
          config: restoreTarget.config,
        });
      } catch (error) {
        revokeCreatedPreviewUrls();
        logger.warn("[v4-pane] queue 撤回编辑命令失败", error);
        toast(intl.formatMessage({ id: "chat.queue.editRestoreFailed" }));
        clearQueueEditOperation();
      }
    },
    [
      attachmentRead,
      clearQueueEditOperation,
      dispatchCommand,
      intl,
      runtimeReady,
      sessionId,
      workspaceKey,
    ],
  );

  const handleSendQueuedNow = useCallback(
    (queueItemId: string) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      // 用户明确点击“立即发送”时，视觉意图等价于点击“滚动到底部”；command 的
      // reserve/stop/promote 生命周期仍由 CLI 裁决，不把滚动状态混入协议。
      focusTimelineToLatest();
      const highspeedOrigin = captureHighspeedPaneOrigin();
      void (async () => {
        const queueItem = current.queue.items.find((item) => item.queueItemId === queueItemId);
        let highspeedOverride: HighspeedSendContext["override"] = {};
        if (queueItem?.highspeed && queueItem.highspeed.expiresAt > Date.now()) {
          const refreshed = await prepareHighspeedSendContext(
            sessionId,
            prepareHighspeedTurnFrom(highspeedOrigin),
            queueItem.modelSelection,
          );
          // Bug 原因：CLI 暂存 runtime 可能跨异步边界缺失；手动提升时补充同一张卡的
          // 新 runtime。若服务返回了不同卡，不得把原队列意图悄悄改绑到另一张卡。
          if (refreshed.acceleratedCard?.cardId === queueItem.highspeed.cardId) {
            highspeedOverride = refreshed.override;
          }
        }
        const latest = snapshotRef.current;
        const latestQueueItem = latest?.queue.items.find(
          (item) => item.queueItemId === queueItemId,
        );
        if (!latest || latest.sessionId !== sessionId || !latestQueueItem) {
          logger.warn("[v4-pane] sendQueuedNow 跳过：Highspeed prepare 后队列状态已变化", {
            queueItemId,
          });
          return null;
        }
        return dispatchCommand(
          "sendQueuedNow",
          { queueItemId, ...highspeedOverride },
          sessionId,
          latest.revision,
        );
      })().then((ack) => {
        if (!ack) return;
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] sendQueuedNow 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [
      captureHighspeedPaneOrigin,
      dispatchCommand,
      focusTimelineToLatest,
      prepareHighspeedTurnFrom,
      sessionId,
    ],
  );

  const handleReorderQueueItem = useCallback(
    (queueItemId: string, beforeQueueItemId: string | null) => {
      const current = snapshotRef.current;
      if (!sessionId || current === null) return;
      void dispatchCommand(
        "reorderQueueItem",
        { queueItemId, beforeQueueItemId },
        sessionId,
        current.revision,
      ).then((ack) => {
        if (ack.status !== "accepted" && ack.status !== "noop") {
          logger.warn(`[v4-pane] reorderQueueItem 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
        }
      });
    },
    [dispatchCommand, sessionId],
  );

  const handleResumeQueue = useCallback(async () => {
    const current = snapshotRef.current;
    if (!sessionId || !current || current.queue.autoDrain || current.queue.items.length === 0) {
      return;
    }
    const ack = await dispatchCommand(
      "setAutoDrain",
      { autoDrain: true },
      sessionId,
      current.revision,
    );
    if (ack.status !== "accepted" && ack.status !== "noop") {
      logger.warn(`[v4-pane] 恢复暂停队列被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
    }
  }, [dispatchCommand, sessionId]);

  // 配置面 CAS 命令的 stale 重试。模型→思考深度→模式连续操作时，前一条命令的
  // revision bump 可能尚未回流到本地投影，直接用本地 revision 会被 CAS 判 stale。
  // stale ack 带 revisionAtDecision（CLI 当前 revision），用它重试即可收敛（有界 3 次）。
  // m5：目标 = effective session（已绑定会话或草稿预热会话）；投影必须与目标
  // 同源（snapshot.sessionId 校验），防止预热切换瞬间用错 revision。
  const dispatchConfigCas = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      options?: { initialBaseRevision?: number; targetSessionId?: string },
    ): Promise<CommandAck | null> => {
      const targetSessionId =
        options?.targetSessionId ?? sessionId ?? prewarmBindingRef.current?.sessionId ?? null;
      const current = snapshotRef.current;
      if (!targetSessionId) {
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "skipped",
          reasonCode: "no-session",
          at: Date.now(),
        });
        return null;
      }
      // draft 预热会话已经创建、snapshot 尚未投影时，旧逻辑直接跳过
      // 配置 CAS；首发随后沿用 runtime 的 build 缺省。CAS 本身支持 stale revision
      // 回包重试，因此无 snapshot 时从 0 起步也能确定收敛，不能把“未投影”当成功。
      let baseRevision =
        options?.initialBaseRevision ??
        (current?.sessionId === targetSessionId ? current.revision : 0);
      let lastAck: CommandAck | null = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ack = await dispatchCommand(type, payload, targetSessionId, baseRevision);
          lastAck = ack;
          if (ack.status === "stale") {
            baseRevision = ack.revisionAtDecision;
            continue;
          }
          if (ack.status !== "accepted" && ack.status !== "noop") {
            logger.warn(`[v4-pane] ${type} 被拒绝: ${ack.status} ${ack.reasonCode ?? ""}`);
          }
          return ack;
        }
        logger.warn(`[v4-pane] ${type} 连续 stale，放弃重试`);
        return lastAck;
      } catch (error) {
        if (isProviderNotReadyError(error)) {
          // provider readiness 竞态被配置 CAS 吞成 null 后，首发会改写成
          // missing-ack，草稿页无法恢复成模型配置引导。确定性启动门禁必须原样上抛。
          throw error;
        }
        // 生产 renderer 日志关闭，异常也进 ack 调试缓冲，避免静默丢失。
        recordV4CommandAck({
          type: `ui:${type}`,
          status: "dispatch-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        logger.warn(`[v4-pane] ${type} 失败: ${String(error)}`);
        return null;
      }
    },
    [dispatchCommand, sessionId],
  );
  const ensureDraftPrewarmConfigBeforeSend = useCallback(
    async (targetSessionId: string) => {
      // followupMode 仍是 Session 行为设置；模型与模式属于本次 Submission，随 sendText
      // 原子提交，不能在发送前通过 CAS 改写共享 Session。
      const desiredConfig = buildDraftCreateConfigPayload(
        draftConfigRef.current,
        appFollowupMode,
      ).config;
      if (!desiredConfig) return;
      const projectedConfig =
        snapshotRef.current?.sessionId === targetSessionId ? snapshotRef.current.config : null;

      const requireAcceptedConfigAck = (type: CommandType, ack: CommandAck | null) => {
        if (
          ack &&
          (ack.status === "accepted" || ack.status === "noop" || ack.status === "duplicate")
        ) {
          return;
        }
        throw new Error(
          `${type} 未在首发前收敛: ${ack?.status ?? "missing-ack"} ${ack?.reasonCode ?? ""}`,
        );
      };

      if (
        desiredConfig.followupMode &&
        desiredConfig.followupMode !== projectedConfig?.followupMode
      ) {
        const ack = await dispatchConfigCas(
          "setFollowupMode",
          { mode: desiredConfig.followupMode },
          { targetSessionId },
        );
        requireAcceptedConfigAck("setFollowupMode", ack);
      }
    },
    [appFollowupMode, dispatchConfigCas, draftConfigRef],
  );
  ensureDraftPrewarmConfigBeforeSendRef.current = ensureDraftPrewarmConfigBeforeSend;

  const followupModeSyncKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const targetSessionId = sessionId ?? prewarmSessionId;
    if (!targetSessionId || !appFollowupMode || snapshotRevision === null) return;
    if (snapshotSessionId !== targetSessionId) return;
    if (snapshotFollowupMode === appFollowupMode) {
      followupModeSyncKeyRef.current = `${targetSessionId}:${appFollowupMode}:synced`;
      return;
    }
    const syncKey = `${targetSessionId}:${appFollowupMode}:${snapshotRevision}`;
    if (followupModeSyncKeyRef.current === syncKey) return;
    followupModeSyncKeyRef.current = syncKey;
    // 交互行为的用户事实源是 app 设置页；v4 投影 followupMode 只是
    // CLI/runtime 同步结果。这里把设置变更补发成既有 setFollowupMode 命令，
    // 避免 composer 再暴露一个同义“追加模式”入口造成上下游分叉。
    void configCommandBarrier.enqueue(() =>
      dispatchConfigCas("setFollowupMode", { mode: appFollowupMode }),
    );
  }, [
    appFollowupMode,
    configCommandBarrier,
    dispatchConfigCas,
    prewarmSessionId,
    sessionId,
    snapshotFollowupMode,
    snapshotRevision,
    snapshotSessionId,
  ]);

  // Composer 选择表达“下一次提交”。点击只更新 renderer intent；Session Selection
  // 在 Submission 真正开跑（Guide 为下一次 model-step）时由 CLI/Core 更新。
  const handleSelectModel = useCallback(
    (
      modelProvider: string,
      model: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) => {
      // 加速卡在本轮已把 Selection 锁定成卡上模型，选型菜单此时不可用；仍有快捷键
      // 或竞态调用进来时明确提示，不能静默把草稿改成另一个模型。
      if (activeHighspeedCard) {
        toast(intl.formatMessage({ id: "chat.highspeed.modelLocked" }));
        return;
      }
      const resolvedProvider =
        modelProvider || draftConfigRef.current.provider || sourceModel?.provider || "";
      logger.debug("[v4-pane] onSelectModel", {
        modelProvider: resolvedProvider,
        model,
        branch: "composer-submission-intent",
      });
      handleDraftSelectModel(resolvedProvider, model, reasoningLevel);
    },
    [activeHighspeedCard, draftConfigRef, handleDraftSelectModel, intl],
  );

  const handleSelectThought = useCallback(
    (thought: string, _modelContext: { provider: string; model: string }) => {
      handleDraftSelectThought(thought);
    },
    [handleDraftSelectThought],
  );

  return {
    handleComposerDraftStateChange,
    handleComposerRestoreApplied,
    handleHighspeedActivationApplied,
    handleFork,
    handleEdit,
    handleRetry,
    handleAssistantFeedback,
    handleDeleteQueueItem,
    handleEditQueueItem,
    handleSendQueuedNow,
    handleReorderQueueItem,
    handleResumeQueue,
    handleSelectModel,
    handleSelectThought,
  };
}
