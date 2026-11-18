import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveWorkspaceKey,
  type SourceServerRunningTask,
  type RemoteTarget,
} from "@zcode/shared";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { isRemoteConnectionFlowActive } from "@/lib/remoteConnectionDialogState.js";
import { type UserActionHandle } from "@/lib/userActionTelemetry.js";
import { useRemoteBoundaryAcknowledgement } from "@/RemoteConnectionDialogContent.js";
import { type RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  normalizeRemoteConnectionOptions,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/contract.js";
import type { RemoteConnectionCompletionIntent } from "@/remote-connection-flow/types.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";

export type RemoteConnectionFlowState = ReturnType<typeof useRemoteConnectionFlowState>;

/**
 * flow 的唯一状态 owner：表单、阶段、requestId、entryEpoch 与派生只读投影。
 * 只在这里声明 useState/useRef，下游子 hook 通过返回值读取同一份闭包，不复制真值。
 */
export function useRemoteConnectionFlowState(options: RemoteConnectionFlowOptions) {
  const {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    controlledOpen,
    onOpenChange,
    isWindowsDesktop,
    remoteWorkspaceSessions,
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
  } = normalizeRemoteConnectionOptions(options);
  const addingDevice =
    completion === "device-management" &&
    !preferredSourceServerId &&
    !preferredProfileId &&
    !preferredTarget;
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const minimizedRef = useRef(false);
  const confirmationPending = useConfirmDialogStore((state) => Boolean(state.pendingRequest));
  const [discardPending, setDiscardPending] = useState(false);
  const [completionRunning, setCompletionRunning] = useState(false);
  const [blockedCompletion, setBlockedCompletion] = useState<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (confirmationPending || discardPending || !blockedCompletion) return;
    // 在关闭确认的 owner 处理完选择后重入，避免确认关闭与完成回调抢跑。
    setBlockedCompletion(null);
    const epoch = entryEpochRef.current;
    setCompletionRunning(true);
    void blockedCompletion()
      .catch((cause) => {
        if (entryEpochRef.current !== epoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        applyOpenState(true);
      })
      .finally(() => {
        if (entryEpochRef.current === epoch) setCompletionRunning(false);
      });
  }, [confirmationPending, discardPending, blockedCompletion]);
  const pendingBackgroundCompletion = useRef<(() => Promise<void>) | null>(null);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [aliasCredentialsPending, setAliasCredentialsPending] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const entryEpochRef = useRef(0);
  const refreshingIntentRef = useRef<number | null>(null);
  const [refreshingIntent, setRefreshingIntent] = useState(false);
  const consumedOpenIntentIdRef = useRef<number | undefined>(undefined);
  const activeTraceRef = useRef<{ requestId: string; trace: UserActionHandle } | null>(null);
  const cancelActiveTrace = useCallback(() => {
    const active = activeTraceRef.current;
    activeTraceRef.current = null;
    active?.trace.cancel();
  }, []);
  useEffect(() => cancelActiveTrace, [cancelActiveTrace]);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string>();
  const [rawError, setRawError] = useState<string>();
  // 0 表示尚未提交；每次提交校验失败递增，表单据此显示内联错误并聚焦第一个出错字段（RDUX-27）。
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [focusCredentials, setFocusCredentials] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const consumedKindPreferenceRef = useRef<string | null>(null);
  const [step, setCurrentStep] = useState<RemoteWizardStep>("device");
  // Root 常驻挂载，设置入口的首帧也直接展示分类表单，不等待 effect 隐藏旧选择屏。
  const currentStep = addingDevice && step === "device" ? "settings" : step;
  const ownsConnectedSessionRef = useRef(false);
  const [connectedSessionId, setConnectedSessionIdState] = useState<string | null>(null);
  const connectedSessionIdRef = useRef<string | null>(null);
  const setConnectedSessionId = useCallback((sessionId: string | null) => {
    connectedSessionIdRef.current = sessionId;
    setConnectedSessionIdState(sessionId);
  }, []);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [pendingInstallConfirmation, setPendingInstallConfirmation] = useState<RemoteTarget | null>(
    null,
  );
  const [upgradeProfileId, setUpgradeProfileId] = useState<string | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [pendingForceUpdate, setPendingForceUpdate] = useState<{
    tasks?: SourceServerRunningTask[];
  } | null>(null);
  const forceDecisionRef = useRef<((confirmed: boolean) => void) | null>(null);
  const settleForceUpdate = (confirmed: boolean) => {
    const resolve = forceDecisionRef.current;
    forceDecisionRef.current = null;
    setPendingForceUpdate(null);
    resolve?.(confirmed);
  };
  useEffect(
    () => () => {
      forceDecisionRef.current?.(false);
      forceDecisionRef.current = null;
    },
    [],
  );
  const [recognizedDeviceName, setRecognizedDeviceName] = useState<string | undefined>();
  const [recognizedSourceServerId, setRecognizedSourceServerId] = useState<string | undefined>();
  const [
    remoteConversationWorkspaceBySourceServerId,
    setRemoteConversationWorkspaceBySourceServerId,
  ] = useState<Record<string, { workspacePath: string; lastResolvedAt: number }>>({});
  /** 当前连接使用的线路名（SSH alias / 线路 displayName）；无名线路由消费方回退 user@host:port。 */
  const [activeProfileName, setActiveProfileName] = useState<string | undefined>();
  const consumedPreferredSourceServerIdRef = useRef<string | null>(null);
  const consumedPreferredProfileIdRef = useRef<string | null>(null);
  const consumedPreferredTargetRef = useRef<RemoteTarget | null>(null);
  const pendingCompletionIntentRef = useRef<RemoteConnectionCompletionIntent>({});
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs } = useRemoteConnectionLogs(connectingRequestId);
  const open = controlledOpen ?? uncontrolledOpen;
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
    resetDraft,
    discoveryLoading,
    discoveryError,
  } = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
    preserveDraftOnOpen: true,
    discoverAll: !addingDevice,
  });
  const appliedRecentSshKeyRef = useRef(false);
  useEffect(() => {
    if (!open) {
      appliedRecentSshKeyRef.current = false;
      return;
    }
    if (appliedRecentSshKeyRef.current) {
      return;
    }
    // 新建连接时把最近一次使用过的私钥路径预填进表单；已有 profile/alias
    // 或用户已经填写私钥时保持原值，避免覆盖明确选择。
    if (preferredProfileId || selectedSshConfigAlias || privateKeyPath.trim()) {
      return;
    }
    const recentPrivateKeyPath =
      buildSshConnectionHistorySuggestions(remoteWorkspaceSessions).privateKeyPaths[0];
    if (!recentPrivateKeyPath) {
      return;
    }

    appliedRecentSshKeyRef.current = true;
    setPrivateKeyPath(recentPrivateKeyPath);
    // 只有用户还没输入密码时才切换到私钥认证；密码已填写说明用户明确选了密码。
    if (sshAuthMethod === "password" && !password.trim()) {
      setSshAuthMethod("privateKey");
    }
  }, [
    open,
    preferredProfileId,
    selectedSshConfigAlias,
    privateKeyPath,
    password,
    sshAuthMethod,
    remoteWorkspaceSessions,
    setPrivateKeyPath,
    setSshAuthMethod,
  ]);
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const sourceManagement = baseServices.sourceServerManagementService;
  // 合同层：管理快照统一走 useSourceServerManagementSnapshot（双事件订阅 + in-flight/queued 队列 + generation 判序），
  // 不再各自手写订阅（§8.1.4 全部消费方收敛为统一 hook）。
  const { snapshot: sourceManagementSnapshot, applySnapshot: applySourceManagementSnapshot } =
    useSourceServerManagementSnapshot(sourceManagement, { enabled: open || minimizedRef.current });
  const { logsByProfileId: sourceOperationLogs } = useSourceServerOperationLogs(
    sourceManagement,
    upgradeProfileId ? [upgradeProfileId] : [],
  );
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    ) {
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
    }
  }, [open, currentStep, pendingRemoteTarget, connectedSessionId, loading]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void baseServices.settingService
      .get()
      .then((settings) => {
        if (!disposed) {
          setRemoteConversationWorkspaceBySourceServerId(
            settings.remoteConversationWorkspaceBySourceServerId ?? {},
          );
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [baseServices.settingService, open]);
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive =
    isRemoteConnectionFlowActive(flowSnapshot) ||
    upgradeLoading ||
    Boolean(blockedCompletion) ||
    completionRunning;
  const recognizedServer = useMemo(
    () =>
      recognizedSourceServerId
        ? (sourceManagementSnapshot?.servers.find(
            (server) => server.sourceServerId === recognizedSourceServerId,
          ) ?? null)
        : null,
    [recognizedSourceServerId, sourceManagementSnapshot],
  );
  const visibleConnectionLogs = useMemo(() => {
    const updateLogs = upgradeProfileId ? (sourceOperationLogs[upgradeProfileId] ?? []) : [];
    return [
      ...(connectingRequestId
        ? connectionLogs
        : rawError === initialFailure?.message
          ? (initialFailure?.logs ?? [])
          : []),
      ...updateLogs.map((entry, index) => ({
        id: `source-update-${entry.timestamp}-${entry.phase}-${index}`,
        level: entry.level,
        message: `[source-server:${entry.phase}] ${entry.message}${
          entry.progress === undefined || entry.message.startsWith("upload progress:")
            ? ""
            : ` ${(entry.progress * 100).toFixed(1)}%`
        }`,
        timestamp: new Date(entry.timestamp).toLocaleTimeString(locale, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })),
    ];
  }, [
    connectionLogs,
    connectingRequestId,
    initialFailure,
    rawError,
    locale,
    sourceOperationLogs,
    upgradeProfileId,
  ]);
  const quickOpenDirectoryData = useMemo(() => {
    if (!recognizedSourceServerId || !sourceManagementSnapshot) {
      return {
        paths: [] as Array<{ path: string; label?: string }>,
        entries: [] as Array<{ path: string; label?: string }>,
      };
    }
    const localEntries = sourceManagementSnapshot.workspaceHistory
      .filter(
        (entry) =>
          entry.sourceServerId === recognizedSourceServerId &&
          remoteConversationWorkspaceBySourceServerId[recognizedSourceServerId]?.workspacePath !==
            entry.workspacePath,
      )
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    const localKeys = new Set(localEntries.map((entry) => resolveWorkspaceKey(entry)));
    const server = sourceManagementSnapshot.servers.find(
      (candidate) => candidate.sourceServerId === recognizedSourceServerId,
    );
    return {
      paths: localEntries.slice(0, 3).map((entry) => ({
        path: entry.workspacePath,
        // 原型 q-time：本地记录显示相对时间（昨天 / 8月20日），远端记录显示「远端记录」。
        label: formatTaskRelativeTime(entry.lastOpenedAt, intl),
      })),
      entries: (server?.declaredWorkspaces ?? [])
        .filter((entry) => !localKeys.has(resolveWorkspaceKey(entry)))
        .map((entry) => ({
          path: entry.workspacePath,
          label: intl.formatMessage({ id: "remote.remoteRecord" }),
        })),
    };
  }, [
    intl,
    recognizedSourceServerId,
    remoteConversationWorkspaceBySourceServerId,
    sourceManagementSnapshot,
  ]);

  const backgroundActive = minimizedRef.current;
  useEffect(() => {
    // 后台完成消费后即使 loading/open 都未改变，也必须释放 Root 的入口门禁。
    onFlowActiveChange?.(flowActive || backgroundActive);
  }, [flowActive, backgroundActive, onFlowActiveChange]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      activeRequestIdRef.current = requestId;
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  const updatePendingRemoteTarget = useCallback(
    (target: RemoteTarget | null) => {
      setPendingRemoteTarget(target);
      // 已保存 WSL 线路曾只更新连接目标，返回配置却使用空值或上一线路的表单。
      // 在接受目标的同一入口回填两项，省略参数也必须清空旧输入。
      if (target?.kind === "wsl") {
        setWslDistro(target.distro ?? "");
        setWslUser(target.user ?? "");
      }
      // 在 onConnect 前同步告知通知层；最小化不清空目标，退出或改选沿用同一清理入口。
      onFlowTargetChange?.(target);
    },
    [onFlowTargetChange, setWslDistro, setWslUser],
  );
  useEffect(() => () => onFlowTargetChange?.(null), [onFlowTargetChange]);

  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  const resetFeedback = () => {
    setCancelled(false);
    setError("");
    setErrorCode(undefined);
    setRawError(undefined);
    setValidationAttempt(0);
  };

  const formSnapshot = {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    selectedSshConfigAlias,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
  };

  return {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    remoteWorkspaceSessions,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
    addingDevice,
    intl,
    confirmDialog,
    acknowledgeBoundary,
    cancelPendingRemoteConnection,
    loading,
    setLoading,
    minimizedRef,
    setDiscardPending,
    setCompletionRunning,
    setBlockedCompletion,
    pendingBackgroundCompletion,
    backgroundReady,
    setBackgroundReady,
    aliasCredentialsPending,
    setAliasCredentialsPending,
    activeRequestIdRef,
    entryEpochRef,
    refreshingIntentRef,
    refreshingIntent,
    setRefreshingIntent,
    consumedOpenIntentIdRef,
    activeTraceRef,
    cancelActiveTrace,
    cancelled,
    setCancelled,
    error,
    setError,
    errorCode,
    setErrorCode,
    rawError,
    setRawError,
    validationAttempt,
    setValidationAttempt,
    focusCredentials,
    setFocusCredentials,
    directoryPath,
    setDirectoryPath,
    consumedKindPreferenceRef,
    step,
    setCurrentStep,
    currentStep,
    ownsConnectedSessionRef,
    connectedSessionId,
    connectedSessionIdRef,
    setConnectedSessionId,
    connectingRequestId,
    pendingRemoteTarget,
    pendingInstallConfirmation,
    setPendingInstallConfirmation,
    upgradeProfileId,
    setUpgradeProfileId,
    upgradeLoading,
    setUpgradeLoading,
    pendingForceUpdate,
    setPendingForceUpdate,
    forceDecisionRef,
    settleForceUpdate,
    recognizedDeviceName,
    setRecognizedDeviceName,
    recognizedSourceServerId,
    setRecognizedSourceServerId,
    remoteConversationWorkspaceBySourceServerId,
    activeProfileName,
    setActiveProfileName,
    consumedPreferredSourceServerIdRef,
    consumedPreferredProfileIdRef,
    consumedPreferredTargetRef,
    pendingCompletionIntentRef,
    selectingDirectory,
    setSelectingDirectory,
    selectingDirectoryRef,
    resetConnectionLogs,
    open,
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
    resetDraft,
    discoveryLoading,
    discoveryError,
    directoryBrowserServices,
    baseServices,
    sourceManagement,
    sourceManagementSnapshot,
    applySourceManagementSnapshot,
    flowSnapshot,
    flowActive,
    recognizedServer,
    visibleConnectionLogs,
    quickOpenDirectoryData,
    updateConnectingRequestId,
    updatePendingRemoteTarget,
    applyOpenState,
    resetFeedback,
    formSnapshot,
  };
}
