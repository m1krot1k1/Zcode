import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { useCallback } from "react";
import {
  isSameSourceServerUpdateTarget,
  DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  type ConnectionProfile,
  type RemoteTarget,
} from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { buildRemoteTarget, buildRemoteTargetFromProfile } from "@/lib/remoteConnectionWizard.js";
import { getRemoteConnectionDirectoryFailureState } from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { RemoteConnectionFlowState } from "@/remote-connection-flow/useRemoteConnectionFlowState.js";
import type { RemoteConnectionDialogLifecycle } from "@/remote-connection-flow/useRemoteConnectionDialogLifecycle.js";
import type { RemoteConnectionConnect } from "@/remote-connection-flow/useRemoteConnectionConnect.js";

export type RemoteConnectionActions = ReturnType<typeof useRemoteConnectionActions>;

/**
 * 表单与设备卡动作：提交连接、取消/重试、目录选择、Profile 入口。
 * 只调用 connect/dialog 已暴露的动作，不在这里新增状态。
 */
export function useRemoteConnectionActions(
  core: RemoteConnectionFlowState,
  dialog: RemoteConnectionDialogLifecycle,
  connect: RemoteConnectionConnect,
) {
  const {
    activeRequestIdRef,
    applyOpenState,
    baseServices,
    cancelActiveTrace,
    cancelPendingRemoteConnection,
    completion,
    connectedSessionId,
    connectedSessionIdRef,
    entryEpochRef,
    formSnapshot,
    intl,
    loading,
    localWorkspacePath,
    minimizedRef,
    onCancelSession,
    onCancelled,
    onSelectProject,
    ownsConnectedSessionRef,
    pendingCompletionIntentRef,
    pendingInstallConfirmation,
    pendingRemoteTarget,
    resetConnectionLogs,
    resetFeedback,
    selectedSshConfigAlias,
    selectingDirectoryRef,
    setActiveProfileName,
    setAliasCredentialsPending,
    setAssetInstallMode,
    setBlockedCompletion,
    setCancelled,
    setCompletionRunning,
    setConnectedSessionId,
    setCurrentStep,
    setDirectoryPath,
    setDockerContainer,
    setError,
    setErrorCode,
    setHost,
    setKind,
    setLoading,
    setManualDockerContainer,
    setPassword,
    setPendingInstallConfirmation,
    setPort,
    setPrivateKeyPassphrase,
    setPrivateKeyPath,
    setRawError,
    setRecognizedDeviceName,
    setRecognizedSourceServerId,
    setSelectingDirectory,
    setServerName,
    setServerToken,
    setServerUrl,
    setSshAuthMethod,
    setUpgradeLoading,
    setUpgradeProfileId,
    setUsername,
    setValidationAttempt,
    setWslDistro,
    setWslUser,
    settleForceUpdate,
    sourceManagementSnapshot,
    updateConnectingRequestId,
    updatePendingRemoteTarget,
    upgradeProfileId,
  } = core;
  const { resumeRequiredServerUpdate, startRemoteConnection, updateRequiredServer } = connect;
  const { closeDialog, handleCancelSession, resetDirectorySelectionState } = dialog;
  const handleConnect = async () => {
    if (loading) {
      // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const { target: nextTarget } = buildRemoteTarget(intl, formSnapshot);
    if (!nextTarget) {
      // Bugfix: 必填项缺失属于表单校验，不应该和真实连接失败共用顶部错误条。
      // 错误改为显示在对应字段下方（RDUX-27），这里只记录一次失败提交。
      setValidationAttempt((attempt) => attempt + 1);
      return;
    }

    resetFeedback();
    setAliasCredentialsPending(false);
    updatePendingRemoteTarget(nextTarget);
    setActiveProfileName(selectedSshConfigAlias?.trim() || undefined);
    // 手动设备连接完成后统一选目录；已有项目保持原来的明确目录意图。
    await startRemoteConnection(
      nextTarget,
      false,
      // 外部偏好只在入口初始化；重新读取 props 会让「新建连接」复活旧设备目录。
      pendingCompletionIntentRef.current.preferredDirectoryPath,
      {
        ...pendingCompletionIntentRef.current.options,
        directToDirectory: true,
      },
    );
  };

  const handleConfirmInstall = useCallback(() => {
    logger.lifecycle.info("[remote-connection] 用户确认安装", {
      hasTarget: Boolean(pendingInstallConfirmation),
      activeRequestId: activeRequestIdRef.current,
      loading,
    });
    if (!pendingInstallConfirmation) return;
    const target = pendingInstallConfirmation;
    const intent = pendingCompletionIntentRef.current;
    setPendingInstallConfirmation(null);
    void startRemoteConnection(target, true, intent.preferredDirectoryPath, intent.options);
  }, [pendingInstallConfirmation, startRemoteConnection, loading]);

  const handleCancelInstall = useCallback(() => {
    if (completion === "device-management" && onCancelled) {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled(background);
      return;
    }
    // 安装确认可能已排入事件队列；取消先撤销归属，旧确认不能重新发起连接。
    entryEpochRef.current += 1;
    setPendingInstallConfirmation(null);
    resetFeedback();
    setCancelled(true);
  }, [closeDialog, completion, onCancelled]);

  const handleCancelConnection = useCallback(() => {
    if (completion === "device-management" && onCancelled) {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled(background);
      return;
    }
    settleForceUpdate(false);
    cancelActiveTrace();
    const requestId = activeRequestIdRef.current;
    entryEpochRef.current += 1;
    setBlockedCompletion(null);
    setCompletionRunning(false);
    const sessionId = connectedSessionIdRef.current;
    if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
    setConnectedSessionId(null);
    updateConnectingRequestId(null);
    setLoading(false);
    // 取消先撤销 epoch，旧更新的 finally 不再有权清理 busy；在 owner 的取消入口同步收口。
    setUpgradeLoading(false);
    setPendingInstallConfirmation(null);
    setAliasCredentialsPending(false);
    resetFeedback();
    setCancelled(true);
    if (requestId) void cancelPendingRemoteConnection(requestId);
  }, [
    cancelActiveTrace,
    cancelPendingRemoteConnection,
    closeDialog,
    completion,
    onCancelled,
    updateConnectingRequestId,
  ]);

  const handleStartPendingRemoteConnection = useCallback(
    (automaticServerUpdateAttempted = false) => {
      if (!pendingRemoteTarget) {
        void handleConnect();
        return;
      }

      if (
        pendingRemoteTarget.kind === "ssh" &&
        !pendingRemoteTarget.password &&
        !pendingRemoteTarget.privateKeyPath
      ) {
        resetFeedback();
        setAliasCredentialsPending(true);
        return;
      }
      const intent = pendingCompletionIntentRef.current;
      void startRemoteConnection(
        pendingRemoteTarget,
        false,
        intent.preferredDirectoryPath,
        intent.options,
        automaticServerUpdateAttempted,
      );
    },
    [handleConnect, pendingRemoteTarget, startRemoteConnection],
  );

  const handleUpgradeRequiredServer = useCallback(async () => {
    if (!upgradeProfileId || !pendingRemoteTarget || pendingRemoteTarget.kind === "server") return;
    if (await updateRequiredServer(upgradeProfileId, pendingRemoteTarget)) {
      handleStartPendingRemoteConnection(true);
    }
  }, [
    handleStartPendingRemoteConnection,
    pendingRemoteTarget,
    upgradeProfileId,
    updateRequiredServer,
  ]);

  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    try {
      await onCancelSession(connectedSessionId);
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // Bugfix: 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
      // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
      const epoch = entryEpochRef.current;
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        if (entryEpochRef.current !== epoch) return;
        pendingCompletionIntentRef.current = {};
        minimizedRef.current = false;
        setDirectoryPath("");
        resetConnectionLogs();
        setCurrentStep("device");
        setConnectedSessionId(null);
        updatePendingRemoteTarget(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        if (entryEpochRef.current !== epoch) return;
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        if (entryEpochRef.current === epoch) resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
      updatePendingRemoteTarget,
    ],
  );

  const acceptInitialFailure = (
    target: RemoteTarget,
    initialFailure?: RemoteConnectionOpenPreference["initialFailure"],
  ) => {
    if (!initialFailure) return false;
    if (initialFailure.code === "source-server-upgrade-required" && initialFailure.failedTarget) {
      target = { ...target, ...initialFailure.failedTarget };
    }
    if (
      (initialFailure.code === "source-server-install-required" ||
        initialFailure.code === "source-server-upgrade-required") &&
      target.kind === "wsl"
    ) {
      target = initialFailure.resolvedWslTarget ?? target;
    }
    updatePendingRemoteTarget(target);
    setKind(target.kind);
    if (target.kind === "ssh") {
      setHost(target.host);
      setPort(String(target.port ?? 22));
      setUsername(target.username);
      setPassword(target.password ?? "");
      setPrivateKeyPath(target.privateKeyPath ?? "");
      setPrivateKeyPassphrase(target.privateKeyPassphrase ?? "");
      setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
      setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    } else if (target.kind === "wsl") {
      setWslDistro(target.distro ?? "");
      setWslUser(target.user ?? "");
    } else if (target.kind === "docker") {
      setDockerContainer(target.container);
      setManualDockerContainer(target.container);
    } else {
      setServerUrl(target.url);
      setServerName(target.name ?? "");
      setServerToken(target.token ?? "");
    }
    setCurrentStep("connecting");
    setErrorCode(initialFailure.code);
    setRawError(initialFailure.message);
    setError(
      formatRemoteConnectionError({
        fallback: initialFailure.message,
        reasonCode: initialFailure.code,
        formatMessage: intl.formatMessage,
      }),
    );
    if (initialFailure.code === "source-server-install-required")
      setPendingInstallConfirmation(target);
    if (initialFailure.code === "source-server-upgrade-required" && target.kind !== "server") {
      void resumeRequiredServerUpdate(
        target,
        pendingCompletionIntentRef.current,
        entryEpochRef.current,
        false,
        initialFailure.profileId,
      );
    }
    return true;
  };

  const handleSelectProfile = (
    profile: ConnectionProfile,
    preferredDirectoryPath?: string,
    selectOptions?: {
      initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
      directToDirectory?: boolean;
      localWorkspacePath?: string;
    },
  ) => {
    const entryEpoch = ++entryEpochRef.current;
    resetFeedback();
    setPendingInstallConfirmation(null);
    setUpgradeProfileId(null);
    // 凭据缺失时也保留目录意图，不能等真正拨号才记录。
    pendingCompletionIntentRef.current = { preferredDirectoryPath, options: selectOptions };
    setDirectoryPath("");
    setActiveProfileName(profile.displayName);
    setRecognizedSourceServerId(profile.sourceServerId);
    setRecognizedDeviceName(
      sourceManagementSnapshot?.servers.find(
        (server) => server.sourceServerId === profile.sourceServerId,
      )?.displayName,
    );
    // Bug 原因：外部连接入口过去先在原界面直接执行 connectProfile，导致 toast、静默连接和
    // 弹窗进度三套反馈并存。精确 Profile intent 在加载凭据前就进入连接屏，后续安装/升级/
    // 失败/重试全部由同一个连接步骤承接。
    setCurrentStep("connecting");
    void (async () => {
      try {
        const target = buildRemoteTargetFromProfile(profile);
        const failure = selectOptions?.initialFailure;
        if (
          failure?.code === "source-server-upgrade-required" &&
          failure.failedTarget &&
          !isSameSourceServerUpdateTarget(target, failure.failedTarget)
        ) {
          // 新 Profile 的凭据也不能混入旧失败目标；先交回原身份，让恢复校验提供显式重试。
          acceptInitialFailure(failure.failedTarget, failure);
          return;
        }
        setKind(target.kind);
        // Bug 原因：设备首屏之前只把 Profile 的非敏感 metadata 传给 Host，
        // Host manager.connect 不会替 UI 解析 credential refs，密码线路因此必然认证失败。
        const credentials = await loadConnectionProfileCredentials({
          profile,
          loadCredential: baseServices.credentialService.load,
        });
        if (entryEpochRef.current !== entryEpoch) return;
        if (target.kind === "ssh") {
          const hasPasswordAuth = Boolean(credentials?.password);
          const expectsPrivateKeyPassphrase =
            profile.target.kind === "ssh" &&
            Boolean(profile.target.privateKeyPassphraseCredentialKey);
          const hasPrivateKeyAuth = Boolean(
            target.privateKeyPath &&
            (!expectsPrivateKeyPassphrase || credentials?.privateKeyPassphrase),
          );
          if (!hasPasswordAuth && !hasPrivateKeyAuth) {
            // Bug 原因：Profile ref 存在但 value 缺失时，旧路径仍以空认证 target 发起 SSH，
            // 把“需要交互凭据”误报成服务端认证失败。认证链不完整必须在网络调用前 fail closed。
            updatePendingRemoteTarget(target);
            // 补凭据时仍保留原线路配置，返回设置不能变成空白的新连接。
            setKind("ssh");
            // 自动换目标不能混用常驻表单中上一设备的凭据，缺凭据只能重新输入。
            setPassword("");
            setPrivateKeyPassphrase("");
            setServerToken("");
            setHost(target.host);
            setPort(String(target.port ?? 22));
            setUsername(target.username);
            setPrivateKeyPath(target.privateKeyPath ?? "");
            setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
            setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
            setErrorCode("credentials-required");
            setError(intl.formatMessage({ id: "remote.error.credentialsRequired" }));
            return;
          }
        }
        const targetWithCredentials =
          target.kind === "ssh" && credentials
            ? {
                ...target,
                ...(credentials.password ? { password: credentials.password } : {}),
                ...(credentials.privateKeyPassphrase
                  ? {
                      privateKeyPassphrase: credentials.privateKeyPassphrase,
                    }
                  : {}),
              }
            : target;
        // 已保存线路可能直接进入连接屏；返回修改用户名/密钥时必须编辑这条线路，而非旧表单草稿。
        if (targetWithCredentials.kind === "ssh") {
          setHost(targetWithCredentials.host);
          setPort(String(targetWithCredentials.port ?? 22));
          setUsername(targetWithCredentials.username);
          setPrivateKeyPath(targetWithCredentials.privateKeyPath ?? "");
          setSshAuthMethod(targetWithCredentials.privateKeyPath ? "privateKey" : "password");
          setPassword(targetWithCredentials.password ?? "");
          setPrivateKeyPassphrase(targetWithCredentials.privateKeyPassphrase ?? "");
          setAssetInstallMode(
            targetWithCredentials.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE,
          );
        }
        updatePendingRemoteTarget(targetWithCredentials);
        if (acceptInitialFailure(targetWithCredentials, selectOptions?.initialFailure)) return;
        await startRemoteConnection(
          targetWithCredentials,
          false,
          preferredDirectoryPath,
          selectOptions,
        );
      } catch (cause) {
        if (entryEpochRef.current !== entryEpoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
      }
    })();
  };

  return {
    handleConnect,
    handleConfirmInstall,
    handleCancelInstall,
    handleCancelConnection,
    handleStartPendingRemoteConnection,
    handleUpgradeRequiredServer,
    handleBackToConnection,
    handleSelectDirectory,
    acceptInitialFailure,
    handleSelectProfile,
  };
}
