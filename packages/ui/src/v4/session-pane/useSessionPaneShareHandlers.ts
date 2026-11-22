// SessionPane 拆分：分享浮窗的复制/取消/选择等用户动作。
import type { ConversationSharePreflightState } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import { logger } from "@/logger.js";
import type { ConversationShareDockState } from "@/store/conversationShareSelectionStore.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import type { SessionPaneDispatchCommand } from "@/v4/session-pane/helpers.js";
import type { ConversationShareAccessMode, SessionCreateSource } from "@zcode/shared";
import { useCallback } from "react";
import type { RefObject } from "react";

export interface UseSessionPaneShareHandlersParams {
  sessionId: string | null;
  shareDisclosureAccepted: boolean;
  sharePublishing: boolean;
  publishedShareUrl: string | null;
  shareSelectionPanelVisible: boolean;
  updateShareDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
  beginShareSelection: (taskId: string) => void;
  toggleShareRow: (taskId: string, rowId: number) => void;
  deselectShareProductTurn: (taskId: string, productTurnId: string) => void;
  setShareAccessMode: (taskId: string, accessMode: ConversationShareAccessMode) => void;
  sharePreflight: ConversationSharePreflightState;
  timelineScrollToQueryRef: RefObject<
    ((target: { unitIndex: number; rowId: number }) => void) | null
  >;
  workspaceKey: string;
  handleDraftSessionCreated: (
    createdSessionId: string,
    createSource?: SessionCreateSource,
    messageId?: string,
    taskGroupId?: string | null,
  ) => Promise<void>;
  dispatchCommand: SessionPaneDispatchCommand;
  recoverableCommands: ReadonlyArray<PendingCommandEntry>;
  handleConfirmShareDisclosure: () => Promise<void>;
}

export function useSessionPaneShareHandlers(params: UseSessionPaneShareHandlersParams) {
  const {
    sessionId,
    shareDisclosureAccepted,
    sharePublishing,
    publishedShareUrl,
    shareSelectionPanelVisible,
    updateShareDockState,
    beginShareSelection,
    toggleShareRow,
    deselectShareProductTurn,
    setShareAccessMode,
    sharePreflight,
    timelineScrollToQueryRef,
    workspaceKey,
    handleDraftSessionCreated,
    dispatchCommand,
    recoverableCommands,
    handleConfirmShareDisclosure,
  } = params;

  const handleDismissShareWarnings = useCallback(() => {
    if (sessionId) updateShareDockState(sessionId, { warnings: null });
  }, [sessionId, updateShareDockState]);

  const handleDeselectShareTurn = useCallback(
    (productTurnId: string) => {
      if (!sessionId || !productTurnId) return;
      // 按 product turn 身份整轮移除：service 的 issue 已带 productTurnId，
      // 不再用 turnOrdinal 索引 UI 的 per-query 列表（两套编号会错位）。
      deselectShareProductTurn(sessionId, productTurnId);
    },
    [deselectShareProductTurn, sessionId],
  );

  const handleShareTitleChange = useCallback(
    (value: string) => {
      if (!sessionId) return;
      updateShareDockState(sessionId, {
        title: value,
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, updateShareDockState],
  );

  const handleShareAccessModeChange = useCallback(
    (accessMode: ConversationShareAccessMode) => {
      if (!sessionId) return;
      setShareAccessMode(sessionId, accessMode);
      updateShareDockState(sessionId, {
        disclosureAccepted: false,
        publishedShareUrl: null,
        error: null,
        warnings: null,
      });
    },
    [sessionId, setShareAccessMode, updateShareDockState],
  );

  // 内联回调会让 memo 确认 Dock 每次重渲染；依赖当前 session，避免切换后写回旧会话。
  const handleShareDisclosureAcceptedChange = useCallback(
    (accepted: boolean) => {
      if (sessionId) {
        updateShareDockState(sessionId, { disclosureAccepted: accepted });
      }
    },
    [sessionId, updateShareDockState],
  );

  const handleEditShareSelection = useCallback(() => {
    if (sharePublishing || publishedShareUrl || !sessionId) return;
    updateShareDockState(sessionId, { error: null });
    beginShareSelection(sessionId);
  }, [beginShareSelection, publishedShareUrl, sessionId, sharePublishing, updateShareDockState]);

  const handleShareConfirm = useCallback(() => {
    if (
      !shareDisclosureAccepted ||
      shareSelectionPanelVisible ||
      sharePreflight.status !== "ready" ||
      sharePreflight.blockingIssues.length > 0
    )
      return;
    void handleConfirmShareDisclosure();
  }, [
    handleConfirmShareDisclosure,
    shareDisclosureAccepted,
    shareSelectionPanelVisible,
    sharePreflight,
  ]);

  const handleShareSelectionToggle = useCallback(
    (rowId: number) => {
      if (sessionId) toggleShareRow(sessionId, rowId);
    },
    [sessionId, toggleShareRow],
  );

  const handleShareSelectionInspect = useCallback(
    (target: { unitIndex: number; rowId: number }) => {
      timelineScrollToQueryRef.current?.(target);
    },
    [],
  );

  const recoverableCommand = recoverableCommands[0] ?? null;
  const handleDismissPendingRecovery = useCallback(() => {
    if (!recoverableCommand) return;
    pendingCommandRegistry.dismissRecovery(
      recoverableCommand.sessionId,
      recoverableCommand.commandId,
    );
  }, [recoverableCommand]);
  const handleResendPendingCommand = useCallback(() => {
    if (!recoverableCommand) return;
    const replay = pendingCommandRegistry.consumeReplay({
      sessionId: recoverableCommand.sessionId,
      commandId: recoverableCommand.commandId,
    });
    if (!replay) return;
    void dispatchCommand(
      replay.type,
      replay.payload,
      replay.sessionId,
      replay.baseRevision,
      undefined,
      undefined,
      undefined,
      undefined,
      replay.clientContext?.projectId,
      replay.clientContext?.sessionCreateSource,
      undefined,
      replay.clientContext?.taskGroupId,
    )
      .then((ack) => {
        if (
          replay.type === "createSession" &&
          (ack.status === "accepted" || ack.status === "duplicate") &&
          ack.result?.type === "createSession"
        ) {
          const originWorkspace = replay.clientContext?.workspace;
          const originWorkspaceKey =
            originWorkspace?.workspaceIdentity?.trim() || originWorkspace?.workspacePath;
          if (originWorkspaceKey && originWorkspaceKey !== workspaceKey) {
            // 防御 stale UI/旧闭包直接触发跨 workspace replay；正常入口已在 hook 过滤。
            logger.error("[v4-pending-command] 拒绝跨 workspace 提交 createSession 恢复结果", {
              originWorkspaceKey,
              workspaceKey,
            });
            return;
          }
          return handleDraftSessionCreated(
            ack.result.sessionId,
            replay.clientContext?.sessionCreateSource,
            replay.payload.firstInput ? ack.commandId : undefined,
            replay.clientContext?.taskGroupId,
          );
        }
      })
      .catch((error) => {
        // 新 command 已先写入 registry；本次 transport 失败仍可在下次连接继续对账。
        logger.warn("[v4-pending-command] 用户确认重发失败", error);
      });
  }, [dispatchCommand, handleDraftSessionCreated, recoverableCommand, workspaceKey]);

  return {
    handleDismissShareWarnings,
    handleDeselectShareTurn,
    handleShareTitleChange,
    handleShareAccessModeChange,
    handleShareDisclosureAcceptedChange,
    handleEditShareSelection,
    handleShareConfirm,
    handleShareSelectionToggle,
    handleShareSelectionInspect,
    recoverableCommand,
    handleDismissPendingRecovery,
    handleResendPendingCommand,
  };
}
