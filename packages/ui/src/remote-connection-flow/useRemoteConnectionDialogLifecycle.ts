import { useCallback } from "react";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import type { RemoteConnectionFlowState } from "@/remote-connection-flow/useRemoteConnectionFlowState.js";

export type RemoteConnectionDialogLifecycle = ReturnType<typeof useRemoteConnectionDialogLifecycle>;

/**
 * 弹窗可见性与收尾：关闭确认、session 释放、后台结果恢复入口。
 * handleOpenChange/resumeBackground 只由事件与 effect 调用，不新增 hook 顺序。
 */
export function useRemoteConnectionDialogLifecycle(core: RemoteConnectionFlowState) {
  const {
    addingDevice,
    applyOpenState,
    cancelActiveTrace,
    cancelPendingRemoteConnection,
    confirmDialog,
    connectedSessionId,
    connectedSessionIdRef,
    connectingRequestId,
    consumedKindPreferenceRef,
    consumedPreferredProfileIdRef,
    consumedPreferredSourceServerIdRef,
    consumedPreferredTargetRef,
    currentStep,
    entryEpochRef,
    intl,
    loading,
    minimizedRef,
    onCancelSession,
    onCancelled,
    ownsConnectedSessionRef,
    pendingBackgroundCompletion,
    pendingCompletionIntentRef,
    refreshingIntentRef,
    resetConnectionLogs,
    resetDraft,
    resetFeedback,
    selectingDirectoryRef,
    setActiveProfileName,
    setAliasCredentialsPending,
    setBackgroundReady,
    setBlockedCompletion,
    setCompletionRunning,
    setConnectedSessionId,
    setCurrentStep,
    setDirectoryPath,
    setDiscardPending,
    setError,
    setFocusCredentials,
    setLoading,
    setPendingInstallConfirmation,
    setRecognizedDeviceName,
    setRecognizedSourceServerId,
    setRefreshingIntent,
    setSelectingDirectory,
    setUpgradeLoading,
    setUpgradeProfileId,
    settleForceUpdate,
    updateConnectingRequestId,
    updatePendingRemoteTarget,
  } = core;
  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean; keepOpen?: boolean }) => {
      settleForceUpdate(false);
      cancelActiveTrace();
      entryEpochRef.current += 1;
      setBlockedCompletion(null);
      setCompletionRunning(false);
      minimizedRef.current = false;
      pendingBackgroundCompletion.current = null;
      setBackgroundReady(false);
      refreshingIntentRef.current = null;
      setRefreshingIntent(false);
      resetDraft();
      setDirectoryPath("");
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
      consumedPreferredTargetRef.current = null;
      setAliasCredentialsPending(false);
      setFocusCredentials(false);
      // 关闭确认可能早于连接完成，异步确认后必须释放当前 attachment，不能读旧闭包。
      const sessionId = connectedSessionIdRef.current;
      if (!options?.preserveSession && sessionId && ownsConnectedSessionRef.current) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // Bugfix: 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      setCurrentStep(addingDevice ? "settings" : "device");
      setConnectedSessionId(null);
      ownsConnectedSessionRef.current = false;
      updatePendingRemoteTarget(null);
      setPendingInstallConfirmation(null);
      setUpgradeProfileId(null);
      setUpgradeLoading(false);
      setRecognizedDeviceName(undefined);
      setRecognizedSourceServerId(undefined);
      setActiveProfileName(undefined);
      pendingCompletionIntentRef.current = {};
      updateConnectingRequestId(null);
      if (!options?.keepOpen) applyOpenState(false);
    },
    [
      addingDevice,
      cancelActiveTrace,
      cancelPendingRemoteConnection,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
      updatePendingRemoteTarget,
    ],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  const withConfirmedDiscard = async (discard: () => void | Promise<void>) => {
    const epoch = entryEpochRef.current;
    setDiscardPending(true);
    try {
      const confirmed = await confirmRemoteFlowDiscard();
      if (confirmed && entryEpochRef.current === epoch) await discard();
    } finally {
      setDiscardPending(false);
    }
  };
  const handleCloseRequest = () =>
    withConfirmedDiscard(() => {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled?.(background);
    });

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      minimizedRef.current = false;
      applyOpenState(true);
      return;
    }

    void handleCloseRequest();
  };

  const resumeBackground = () => {
    const finish = pendingBackgroundCompletion.current;
    if (!finish) {
      handleOpenChange(true);
      return;
    }
    const operationEpoch = entryEpochRef.current;
    // 先消费再运行，重复按钮和旧 toast 不能重复恢复。
    pendingBackgroundCompletion.current = null;
    minimizedRef.current = false;
    // 通知继续曾跳过前台通知，资格查询期间原草稿仍可发送；先由原 owner 恢复禁发，再等待 IO。
    applyOpenState(true);
    setBackgroundReady(false);
    setCompletionRunning(true);
    void finish()
      .catch((cause) => {
        // 快照读取也可能延迟失败；取消或换入口后不能用旧错误重新打开弹窗。
        if (entryEpochRef.current !== operationEpoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        // 显式继续也会等待资格 IO；用户再次收起后，迟到错误只能更新原后台操作。
        if (!minimizedRef.current) applyOpenState(true);
      })
      .finally(() => {
        if (entryEpochRef.current === operationEpoch) setCompletionRunning(false);
      });
  };

  return {
    resetDirectorySelectionState,
    handleCancelSession,
    closeDialog,
    withConfirmedDiscard,
    handleCloseRequest,
    handleOpenChange,
    resumeBackground,
  };
}
