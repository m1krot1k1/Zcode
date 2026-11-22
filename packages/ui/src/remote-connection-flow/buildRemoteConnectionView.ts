import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import { type ComponentProps } from "react";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE, ZCODE_VERSION, type RemoteTarget } from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  getRemoteWizardStepCopy,
  collectRemoteFormFieldErrors,
  formatRemoteDraftPreview,
} from "@/lib/remoteConnectionWizard.js";
import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionSettingsStep,
  formatDeviceCardMeta,
} from "@/RemoteConnectionDialogContent.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import { RemoteConnectionWizardHeader } from "@/RemoteConnectionWizardChrome.js";
import type { RemoteConnectionFlowState } from "@/remote-connection-flow/useRemoteConnectionFlowState.js";
import type { RemoteConnectionDialogLifecycle } from "@/remote-connection-flow/useRemoteConnectionDialogLifecycle.js";
import type { RemoteConnectionConnect } from "@/remote-connection-flow/useRemoteConnectionConnect.js";
import type { RemoteConnectionActions } from "@/remote-connection-flow/useRemoteConnectionActions.js";
import type { RemoteConnectionIntent } from "@/remote-connection-flow/useRemoteConnectionIntent.js";

/**
 * 把 flow 各 owner 的状态投影成弹窗 props；纯函数，不调用 hook，也不新增状态。
 */
export function buildRemoteConnectionView({
  core,
  dialog,
  connect,
  actions,
  intent,
}: {
  core: RemoteConnectionFlowState;
  dialog: RemoteConnectionDialogLifecycle;
  connect: RemoteConnectionConnect;
  actions: RemoteConnectionActions;
  intent: RemoteConnectionIntent;
}) {
  const {
    activeProfileName,
    activeRequestIdRef,
    addingDevice,
    aliasCredentialsPending,
    applyOpenState,
    applySourceManagementSnapshot,
    applySshConfigAlias,
    assetInstallMode,
    availableKinds,
    backgroundReady,
    baseServices,
    cancelActiveTrace,
    cancelPendingRemoteConnection,
    cancelled,
    clearSelectedSshConfigAlias,
    completion,
    connectedSessionId,
    connectedSessionIdRef,
    connectingRequestId,
    consumedKindPreferenceRef,
    consumedPreferredProfileIdRef,
    consumedPreferredSourceServerIdRef,
    consumedPreferredTargetRef,
    currentRuntimeOptionsError,
    currentRuntimeOptionsLoading,
    currentStep,
    directoryBrowserServices,
    directoryPath,
    discoveryError,
    discoveryLoading,
    dockerAvailable,
    dockerContainer,
    dockerContainers,
    entryEpochRef,
    error,
    errorCode,
    focusCredentials,
    formSnapshot,
    host,
    intl,
    kind,
    loading,
    localWorkspacePath,
    manualDockerContainer,
    minimizedRef,
    onProjectIntentCleared,
    open,
    openIntentId,
    ownsConnectedSessionRef,
    password,
    pendingBackgroundCompletion,
    pendingCompletionIntentRef,
    pendingForceUpdate,
    pendingInstallConfirmation,
    pendingRemoteTarget,
    port,
    preferredKind,
    preferredProfileId,
    preferredSourceServerId,
    preferredTarget,
    preferredWslDistro,
    privateKeyPassphrase,
    privateKeyPath,
    quickOpenDirectoryData,
    rawError,
    recognizedDeviceName,
    recognizedServer,
    recognizedSourceServerId,
    refreshDockerContainers,
    remoteConversationWorkspaceBySourceServerId,
    remoteWorkspaceSessions,
    resetDraft,
    resetFeedback,
    selectedSshConfigAlias,
    selectingDirectory,
    selectingDirectoryRef,
    serverName,
    serverToken,
    serverUrl,
    serverWorkspacePath,
    setActiveProfileName,
    setAliasCredentialsPending,
    setAssetInstallMode,
    setBlockedCompletion,
    setCompletionRunning,
    setConnectedSessionId,
    setCurrentStep,
    setDirectoryPath,
    setDockerContainer,
    setError,
    setFocusCredentials,
    setHost,
    setKind,
    setLoading,
    setManualDockerContainer,
    setPassword,
    setPendingInstallConfirmation,
    setPort,
    setPrivateKeyPassphrase,
    setPrivateKeyPath,
    setRecognizedDeviceName,
    setRecognizedSourceServerId,
    setServerName,
    setServerToken,
    setServerUrl,
    setServerWorkspacePath,
    setSshAuthMethod,
    setUpgradeLoading,
    setUsername,
    setWslDistro,
    setWslUser,
    settleForceUpdate,
    sourceManagement,
    sourceManagementSnapshot,
    sshAuthMethod,
    sshConfigAliases,
    sshConfigAliasesError,
    sshConfigAliasesLoading,
    updateConnectingRequestId,
    updatePendingRemoteTarget,
    upgradeLoading,
    upgradeProfileId,
    username,
    validationAttempt,
    visibleConnectionLogs,
    wslDistro,
    wslDistros,
    wslUser,
  } = core;
  const { displayTarget } = intent;
  const {
    closeDialog,
    handleCancelSession,
    handleCloseRequest,
    handleOpenChange,
    resumeBackground,
    withConfirmedDiscard,
  } = dialog;
  const {
    handleBackToConnection,
    handleCancelConnection,
    handleCancelInstall,
    handleConfirmInstall,
    handleConnect,
    handleSelectDirectory,
    handleSelectProfile,
    handleStartPendingRemoteConnection,
    handleUpgradeRequiredServer,
  } = actions;
  const { startRemoteConnection } = connect;
  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind, {
    lineName:
      activeProfileName ??
      (pendingRemoteTarget ? formatRemoteLinkRailTarget(pendingRemoteTarget) : undefined),
    deviceName: recognizedDeviceName,
    connectionReady: Boolean(connectedSessionId) && !error,
    hasError: Boolean(error),
    updating: upgradeLoading,
    cancelled,
  });

  const credentialCategory = classifyRemoteConnectionError({
    errorCode,
    error: rawError ?? error,
  }).category;
  const needsCredentials =
    aliasCredentialsPending ||
    credentialCategory === "credentials" ||
    credentialCategory === "authentication";
  const passphraseRequired =
    pendingRemoteTarget?.kind === "ssh" && Boolean(pendingRemoteTarget.privateKeyPath);
  const currentConnectionState = sourceManagementSnapshot?.states.find(
    (state) =>
      state.profileId === upgradeProfileId ||
      sourceManagementSnapshot.profiles.some(
        (profile) =>
          profile.profileId === state.profileId &&
          pendingRemoteTarget &&
          pendingRemoteTarget.kind !== "server" &&
          profileMatchesRemoteTarget(profile, pendingRemoteTarget),
      ),
  );

  const directoryEpoch = entryEpochRef.current;

  return {
    open,
    currentStep,
    error,
    handleOpenChange,
    header: {
      currentStep,
      deviceManagement: completion === "device-management",
      hideHeading: currentStep === "connecting" && !cancelled,
      title: stepCopy.title,
      description: stepCopy.description,
      // 表单屏头部的实时目标预览，与连接页头部的「类型 + 等宽目标」同构（RDUX-27）。
      settingsPreview:
        currentStep === "settings"
          ? { kind, target: formatRemoteDraftPreview(formSnapshot) }
          : undefined,
      onMinimize: () => {
        // Bug 原因：收起按钮过去被 loading/connectedSessionId 门禁，填写配置和连接失败
        // 等 idle 步骤会看起来像功能被删除。收起始终只改 visibility；状态清理由关闭负责。
        minimizedRef.current = true;
        applyOpenState(false);
      },
      onClose: () => {
        // Bugfix: 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
        void handleCloseRequest();
      },
    } satisfies ComponentProps<typeof RemoteConnectionWizardHeader>,
    minimizedProgress:
      !open && minimizedRef.current
        ? {
            operationId: `${openIntentId ?? 0}:${directoryEpoch}`,
            view: currentStep,
            cancelled,
            target: displayTarget,
            name: recognizedDeviceName ?? activeProfileName,
            logs: visibleConnectionLogs,
            error: errorCode === "credentials-required" ? "" : error,
            reason: error
              ? intl.formatMessage({
                  id: classifyRemoteConnectionError({
                    errorCode,
                    // 用未本地化的原始错误再分一层传输原因（端口拒绝/无路由）；本地化标题不含 OS 错误文本。
                    error: rawError ?? error,
                    target: pendingRemoteTarget ?? undefined,
                  }).reasonId,
                })
              : "",
            waiting:
              aliasCredentialsPending ||
              Boolean(pendingInstallConfirmation) ||
              Boolean(pendingForceUpdate) ||
              errorCode === "credentials-required",
            ready: backgroundReady,
            sourceServerId: recognizedSourceServerId ?? preferredSourceServerId,
            profileId:
              preferredProfileId ??
              sourceManagementSnapshot?.profiles.find(
                (profile) =>
                  pendingRemoteTarget &&
                  pendingRemoteTarget.kind !== "server" &&
                  profileMatchesRemoteTarget(profile, pendingRemoteTarget),
              )?.profileId,
            onCancel: () => {
              if (entryEpochRef.current === directoryEpoch) void handleCloseRequest();
            },
            onResume: () => {
              if (
                entryEpochRef.current !== directoryEpoch ||
                (backgroundReady && !pendingBackgroundCompletion.current)
              )
                return;
              resumeBackground();
            },
          }
        : null,
    aliasCredentials: aliasCredentialsPending
      ? {
          password,
          onPasswordChange: setPassword,
          onSubmit: () => {
            void handleConnect();
          },
        }
      : null,
    selectionStep: {
      snapshot: sourceManagementSnapshot,
      aliases: sshConfigAliases,
      distros: wslDistros,
      containers: dockerContainers,
      availableKinds,
      dockerAvailable,
      loading: discoveryLoading,
      discoveryError,
      remoteConversationWorkspaceBySourceServerId,
      onSelectProfile: (profile, path) => {
        onProjectIntentCleared?.();
        handleSelectProfile(profile, path, { directToDirectory: true });
      },
      onNewConnection: (nextKind) => {
        entryEpochRef.current += 1;
        pendingCompletionIntentRef.current = { options: { announceReusedConnection: true } };
        updatePendingRemoteTarget(null);
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind(nextKind);
        setActiveProfileName(undefined);
        setAliasCredentialsPending(false);
        setFocusCredentials(false);
        onProjectIntentCleared?.();
        resetFeedback();
        setCurrentStep("settings");
      },
      onSelectTarget: (target) => {
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind(target.kind);
        if (target.kind === "wsl") setWslDistro(target.distro ?? "");
        if (target.kind === "docker") setDockerContainer(target.container);
        setActiveProfileName(undefined);
        onProjectIntentCleared?.();
        void startRemoteConnection(target);
      },
      onSelectAlias: (alias) => {
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind("ssh");
        applySshConfigAlias(alias);
        setActiveProfileName(alias.alias);
        pendingCompletionIntentRef.current = {};
        onProjectIntentCleared?.();
        resetFeedback();
        const target: RemoteTarget = {
          kind: "ssh",
          host: alias.host?.trim() || alias.alias,
          username: alias.username?.trim() ?? "",
          port: alias.port,
          sshConfigAlias: alias.alias,
          privateKeyPath: alias.privateKeyPath,
          assetInstallMode: DEFAULT_REMOTE_ASSET_INSTALL_MODE,
        };
        updatePendingRemoteTarget(target);
        if (!target.username) {
          setCurrentStep("settings");
          return;
        }
        if (!target.privateKeyPath) {
          setAliasCredentialsPending(true);
          setCurrentStep("connecting");
          return;
        }
        void startRemoteConnection(target);
      },
    } satisfies ComponentProps<typeof RemoteConnectionSelection>,
    settingsStep: {
      availableKinds: addingDevice ? availableKinds : undefined,
      onKindChange: addingDevice
        ? (nextKind: RemoteTarget["kind"]) => {
            if (nextKind === kind) return;
            entryEpochRef.current += 1;
            resetDraft();
            setKind(nextKind);
            updatePendingRemoteTarget(null);
            setActiveProfileName(undefined);
            setRecognizedSourceServerId(undefined);
            setRecognizedDeviceName(undefined);
            resetFeedback();
          }
        : undefined,
      connectLabel:
        completion === "device-management"
          ? intl.formatMessage({ id: "remote.addAndConnect" })
          : undefined,
      kind: kind,
      host: host,
      port: port,
      username: username,
      sshAuthMethod: sshAuthMethod,
      assetInstallMode: assetInstallMode,
      password: password,
      privateKeyPath: privateKeyPath,
      privateKeyPassphrase: privateKeyPassphrase,
      wslDistro: wslDistro,
      wslUser: wslUser,
      wslDistros: wslDistros,
      dockerContainer: dockerContainer,
      manualDockerContainer: manualDockerContainer,
      serverUrl: serverUrl,
      serverName: serverName,
      serverToken: serverToken,
      serverWorkspacePath: serverWorkspacePath,
      dockerContainers: dockerContainers,
      dockerAvailable: dockerAvailable,
      sshConfigAliases: sshConfigAliases,
      sshConfigAliasesLoading: sshConfigAliasesLoading,
      sshConfigAliasesError: sshConfigAliasesError,
      selectedSshConfigAlias: selectedSshConfigAlias,
      currentRuntimeOptionsLoading: currentRuntimeOptionsLoading,
      currentRuntimeOptionsError: currentRuntimeOptionsError,
      remoteWorkspaceSessions: remoteWorkspaceSessions,
      // 错误由当前字段值实时计算，字段改为有效即消失；唯一规则来源为 collectRemoteFormFieldErrors。
      fieldErrors: validationAttempt > 0 ? collectRemoteFormFieldErrors(intl, formSnapshot) : [],
      validationAttempt,
      focusCredentials: focusCredentials,
      loading: loading,
      onBack: () => {
        if (addingDevice) {
          void handleCloseRequest();
          return;
        }
        resetFeedback();
        setCurrentStep("device");
      },
      onHostChange: setHost,
      onPortChange: setPort,
      onUsernameChange: setUsername,
      onSshAuthMethodChange: setSshAuthMethod,
      onAssetInstallModeChange: setAssetInstallMode,
      onPasswordChange: setPassword,
      onPrivateKeyPathChange: setPrivateKeyPath,
      onPrivateKeyPassphraseChange: setPrivateKeyPassphrase,
      onWslDistroChange: setWslDistro,
      onWslUserChange: setWslUser,
      onDockerContainerChange: setDockerContainer,
      onManualDockerContainerChange: setManualDockerContainer,
      onServerUrlChange: setServerUrl,
      onServerNameChange: setServerName,
      onServerTokenChange: setServerToken,
      onServerWorkspacePathChange: setServerWorkspacePath,
      onDockerContainersRefresh: refreshDockerContainers,
      onApplySshConfigAlias: applySshConfigAlias,
      onClearSelectedSshConfigAlias: clearSelectedSshConfigAlias,
      onConnect: () => {
        void handleConnect();
      },
    } satisfies ComponentProps<typeof RemoteConnectionSettingsStep>,
    connectingStep: {
      backToDevicesLabel: addingDevice
        ? intl.formatMessage({ id: "settings.source.newConnection" })
        : undefined,
      onClose: () => {
        void handleCloseRequest();
      },
      onBackToDevices: () => {
        closeDialog({ keepOpen: true });
        // 返回列表不是重开同一外部入口，不能立即再次消费仍在 props 中的偏好。
        consumedKindPreferenceRef.current = preferredKind
          ? `${preferredKind}:${preferredWslDistro ?? ""}`
          : null;
        consumedPreferredSourceServerIdRef.current = preferredSourceServerId ?? null;
        consumedPreferredProfileIdRef.current = preferredProfileId ?? null;
        consumedPreferredTargetRef.current = preferredTarget ?? null;
        onProjectIntentCleared?.();
      },
      forceUpdate: pendingForceUpdate
        ? {
            ...pendingForceUpdate,
            onConfirm: () => settleForceUpdate(true),
            onCancel: handleCancelConnection,
          }
        : undefined,
      credentials: needsCredentials
        ? {
            passphrase: passphraseRequired,
            value: passphraseRequired ? privateKeyPassphrase : password,
            onChange: passphraseRequired ? setPrivateKeyPassphrase : setPassword,
            onSubmit: () => {
              if (pendingRemoteTarget?.kind !== "ssh") return;
              const value = passphraseRequired ? privateKeyPassphrase : password;
              if (!value) return;
              const target = {
                ...pendingRemoteTarget,
                ...(passphraseRequired ? { privateKeyPassphrase: value } : { password: value }),
              };
              const intent = pendingCompletionIntentRef.current;
              setAliasCredentialsPending(false);
              void startRemoteConnection(
                target,
                false,
                intent.preferredDirectoryPath,
                intent.options,
              );
            },
          }
        : undefined,
      onMinimize: () => {
        minimizedRef.current = true;
        applyOpenState(false);
      },
      kind: kind,
      logs: visibleConnectionLogs,
      errorMessage: error,
      errorCode: errorCode,
      rawError: rawError,
      upgradeTarget: sourceManagementSnapshot?.states.find(
        (state) =>
          state.profileId === upgradeProfileId ||
          sourceManagementSnapshot.profiles.some(
            (profile) =>
              profile.profileId === state.profileId &&
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          ),
      )?.upgradeTarget,
      cancelled: cancelled,
      onCancelConnection: handleCancelConnection,
      loading: loading || upgradeLoading,
      upgradeRequired: Boolean(upgradeProfileId),
      upgradeLoading: upgradeLoading && !pendingForceUpdate,
      onUpgrade: () => {
        void handleUpgradeRequiredServer();
      },
      connectionReady: Boolean(connectedSessionId) && !error,
      onContinueToDirectory: () => setCurrentStep("directory"),
      target: pendingRemoteTarget,
      recognizedDeviceName: recognizedDeviceName,
      profileName: activeProfileName,
      recognizedDeviceMeta: recognizedServer ? formatDeviceCardMeta(recognizedServer) : undefined,
      localVersion: ZCODE_VERSION,
      onUseRemoteDownload:
        pendingRemoteTarget?.kind === "ssh"
          ? () => {
              const target = {
                ...pendingRemoteTarget,
                assetInstallMode: "remote-download" as const,
              };
              const intent = pendingCompletionIntentRef.current;
              updatePendingRemoteTarget(target);
              void startRemoteConnection(
                target,
                false,
                intent.preferredDirectoryPath,
                intent.options,
              );
            }
          : undefined,
      installConfirmation: pendingInstallConfirmation
        ? {
            target: pendingInstallConfirmation,
            preview: currentConnectionState?.installPreview,
            onConfirm: () => {
              if (entryEpochRef.current !== directoryEpoch) return;
              handleConfirmInstall();
            },
            onCancel: handleCancelInstall,
          }
        : undefined,
      onBack: () => {
        void withConfirmedDiscard(async () => {
          cancelActiveTrace();
          const epoch = ++entryEpochRef.current;
          setBlockedCompletion(null);
          setCompletionRunning(false);
          const sessionId = connectedSessionIdRef.current;
          if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
          setConnectedSessionId(null);
          activeRequestIdRef.current = null;
          if (loading) {
            await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
            if (entryEpochRef.current !== epoch) return;
            setLoading(false);
          }
          setFocusCredentials(errorCode === "credentials-required");
          setPendingInstallConfirmation(null);
          resetFeedback();
          updateConnectingRequestId(null);
          setCurrentStep("settings");
        });
      },
      onRetry: () => {
        if (errorCode !== "source-server-identity-change-pending") {
          handleStartPendingRemoteConnection();
          return;
        }
        const profileId =
          preferredProfileId ??
          sourceManagementSnapshot?.profiles.find(
            (profile) =>
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          )?.profileId;
        if (!profileId || !sourceManagement) return;
        const epoch = entryEpochRef.current;
        void (async () => {
          if (entryEpochRef.current !== epoch) return;
          setUpgradeLoading(true);
          try {
            const snapshot = await sourceManagement.confirmIdentityChange(profileId);
            if (entryEpochRef.current !== epoch) return;
            applySourceManagementSnapshot(snapshot);
            setUpgradeLoading(false);
            handleStartPendingRemoteConnection();
          } catch (cause) {
            if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
          } finally {
            if (entryEpochRef.current === epoch) setUpgradeLoading(false);
          }
        })();
      },
    } satisfies ComponentProps<typeof RemoteConnectionConnectingStep>,
    directoryStep: {
      directoryPath,
      onDirectoryPathChange: (path) => {
        if (entryEpochRef.current === directoryEpoch) setDirectoryPath(path);
      },
      services: directoryBrowserServices,
      remoteTarget: pendingRemoteTarget,
      localSkillSyncService: baseServices.skillSyncService,
      remoteSkillSyncService: directoryBrowserServices?.skillSyncService ?? null,
      localMcpSyncService: baseServices.mcpSyncService,
      remoteMcpSyncService: directoryBrowserServices?.mcpSyncService ?? null,
      localPluginSyncService: baseServices.pluginSyncService,
      remotePluginSyncService: directoryBrowserServices?.pluginSyncService ?? null,
      localZCodeAgentService: baseServices.zcodeAgentService,
      remoteZCodeAgentService: directoryBrowserServices?.zcodeAgentService ?? null,
      localWorkspacePath: localWorkspacePath,
      selecting: selectingDirectory,
      onSelect: (path) => {
        void handleSelectDirectory(path);
      },
      onBack: () => {
        void withConfirmedDiscard(handleBackToConnection);
      },
      onCancel: () => {
        void handleCloseRequest();
      },
      onChooseLater: () => {
        // 只释放未绑定项目的临时 attachment；Host 的设备连接独立保留。
        if (!selectingDirectoryRef.current) closeDialog();
      },
      onSkillsSynced: async () => undefined,
      onMcpSynced: async () => undefined,
      onPluginsSynced: async () => undefined,
      deviceName: recognizedDeviceName,
      profileName: activeProfileName,
      deviceVersion: recognizedServer?.lastSeenVersion,
      onRenameDevice:
        recognizedSourceServerId && sourceManagement
          ? async (name) => {
              const snapshot = await sourceManagement.renameSource(recognizedSourceServerId, name);
              if (entryEpochRef.current !== directoryEpoch) return;
              applySourceManagementSnapshot(snapshot);
              setRecognizedDeviceName(name);
            }
          : undefined,
      quickOpenPaths: quickOpenDirectoryData.paths,
      quickOpenEntries: quickOpenDirectoryData.entries,
    } satisfies ComponentProps<typeof RemoteConnectionDirectoryStep>,
  };
}
