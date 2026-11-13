import { useEffect, useEffectEvent, useMemo } from "react";
import {
  DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  type ConnectionProfile,
  type RemoteTarget,
} from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { findPreferredSourceConnectionProfile } from "@/lib/remoteConnectionWizard.js";
import { isRemoteConnectionFlowActive } from "@/lib/remoteConnectionDialogState.js";
import type { RemoteConnectionFlowState } from "@/remote-connection-flow/useRemoteConnectionFlowState.js";
import type { RemoteConnectionDialogLifecycle } from "@/remote-connection-flow/useRemoteConnectionDialogLifecycle.js";
import type { RemoteConnectionActions } from "@/remote-connection-flow/useRemoteConnectionActions.js";

export type RemoteConnectionIntent = ReturnType<typeof useRemoteConnectionIntent>;

/**
 * 外部入口偏好消费：openIntentId、kind/target/profile/source 意图与后台恢复 re-entry。
 * 每个意图只消费一次；effect 的依赖顺序与原实现一致。
 */
export function useRemoteConnectionIntent(
  core: RemoteConnectionFlowState,
  dialog: RemoteConnectionDialogLifecycle,
  actions: RemoteConnectionActions,
) {
  const {
    applySourceManagementSnapshot,
    availableKinds,
    connectedSessionId,
    consumedKindPreferenceRef,
    consumedOpenIntentIdRef,
    consumedPreferredProfileIdRef,
    consumedPreferredSourceServerIdRef,
    consumedPreferredTargetRef,
    currentStep,
    entryEpochRef,
    flowActive,
    flowSnapshot,
    initialFailure,
    loading,
    minimizedRef,
    open,
    openIntentId,
    pendingCompletionIntentRef,
    pendingRemoteTarget,
    preferredDirectoryPath,
    preferredKind,
    preferredProfileId,
    preferredSourceServerId,
    preferredTarget,
    preferredWslDistro,
    refreshingIntent,
    refreshingIntentRef,
    resetDraft,
    setAssetInstallMode,
    setCurrentStep,
    setDockerContainer,
    setError,
    setFocusCredentials,
    setHost,
    setKind,
    setManualDockerContainer,
    setPassword,
    setPort,
    setPrivateKeyPassphrase,
    setPrivateKeyPath,
    setRefreshingIntent,
    setServerName,
    setServerToken,
    setServerUrl,
    setSshAuthMethod,
    setUsername,
    setWslDistro,
    setWslUser,
    sourceManagement,
    sourceManagementSnapshot,
    updatePendingRemoteTarget,
    upgradeLoading,
  } = core;
  const { closeDialog, resumeBackground } = dialog;
  const { acceptInitialFailure, handleSelectProfile } = actions;
  const acceptOpenIntent = useEffectEvent(() => {
    // 新入口先撤销旧 epoch/等待点，再由下面的偏好 effect 消费；恢复卡片不走这里。
    const wasBackground = minimizedRef.current;
    closeDialog({ keepOpen: true });
    if (wasBackground && sourceManagement) {
      const epoch = entryEpochRef.current;
      refreshingIntentRef.current = epoch;
      setRefreshingIntent(true);
      // 后台订阅保持存活，新入口仍须先读最新 Profile，不能消费旧快照的已编辑线路。
      void sourceManagement
        .getSnapshot()
        .then((snapshot) => {
          if (entryEpochRef.current === epoch) applySourceManagementSnapshot(snapshot);
        })
        .catch((cause) => {
          if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
        })
        .finally(() => {
          if (refreshingIntentRef.current !== epoch) return;
          refreshingIntentRef.current = null;
          setRefreshingIntent(false);
        });
    }
  });
  useEffect(() => {
    if (!open || openIntentId === undefined || consumedOpenIntentIdRef.current === openIntentId)
      return;
    consumedOpenIntentIdRef.current = openIntentId;
    // Root 用 flowActive 拒绝新增意图；显式替换已有 openIntentId 仍需撤销等待中的完成动作。
    if (isRemoteConnectionFlowActive(flowSnapshot) || upgradeLoading) return;
    acceptOpenIntent();
  }, [open, openIntentId, flowActive]);

  const applyKindPreference = useEffectEvent(() => {
    if (!preferredKind || !availableKinds.includes(preferredKind)) return;
    // 外部 WSL/UNC 意图只在新入口消费一次；恢复收起的表单不能覆盖用户草稿。
    resetDraft();
    setKind(preferredKind);
    if (preferredKind === "wsl") setWslDistro(preferredWslDistro ?? "");
    setCurrentStep("settings");
  });
  useEffect(() => {
    if (!open || !preferredKind || preferredTarget || preferredProfileId || preferredSourceServerId)
      return;
    const key = `${preferredKind}:${preferredWslDistro ?? ""}`;
    if (consumedKindPreferenceRef.current === key) return;
    consumedKindPreferenceRef.current = key;
    applyKindPreference();
  }, [
    open,
    preferredKind,
    preferredWslDistro,
    preferredTarget,
    preferredProfileId,
    preferredSourceServerId,
    openIntentId,
  ]);

  const applyPreferredTarget = useEffectEvent((target: RemoteTarget) => {
    entryEpochRef.current += 1;
    setFocusCredentials(false);
    // 只替换地址会把上一目标的密码/token 带进新请求；清理发生在换目标而非收起时。
    setPassword("");
    setPrivateKeyPassphrase("");
    setServerToken("");
    setKind(target.kind);
    updatePendingRemoteTarget(target);
    pendingCompletionIntentRef.current = {
      preferredDirectoryPath,
      options: { directToDirectory: true },
    };
    if (target.kind === "ssh") {
      setHost(target.host);
      setPort(String(target.port ?? 22));
      setUsername(target.username);
      setPrivateKeyPath(target.privateKeyPath ?? "");
      setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
      // 已有线路必须沿用保存的下载侧，不能被新建表单的默认值覆盖。
      setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    } else if (target.kind === "wsl") {
      setWslDistro(target.distro ?? "");
      setWslUser(target.user ?? "");
    } else if (target.kind === "docker") {
      setManualDockerContainer(target.container);
      setDockerContainer(target.container);
    } else {
      setServerUrl(target.url);
      setServerName(target.name ?? "");
    }
    if (!acceptInitialFailure(target, initialFailure)) setCurrentStep("settings");
  });
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    )
      consumedPreferredTargetRef.current = null;
    if (
      !open ||
      !preferredTarget ||
      preferredProfileId ||
      loading ||
      connectedSessionId ||
      consumedPreferredTargetRef.current === preferredTarget
    )
      return;
    consumedPreferredTargetRef.current = preferredTarget;
    applyPreferredTarget(preferredTarget);
  }, [
    open,
    preferredTarget,
    preferredProfileId,
    loading,
    connectedSessionId,
    currentStep,
    pendingRemoteTarget,
    openIntentId,
  ]);

  const openPreferredSourceDirectory = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, undefined, { directToDirectory: true });
  });
  const openPreferredProfile = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, preferredDirectoryPath, {
      directToDirectory: true,
      initialFailure,
    });
  });

  useEffect(() => {
    if (
      !open ||
      !preferredProfileId ||
      refreshingIntentRef.current !== null ||
      loading ||
      connectedSessionId ||
      consumedPreferredProfileIdRef.current === preferredProfileId ||
      !sourceManagementSnapshot
    ) {
      return;
    }
    const profile = sourceManagementSnapshot.profiles.find(
      (candidate) =>
        candidate.profileId === preferredProfileId && candidate.lifecycleState !== "retired",
    );
    if (!profile) return;

    consumedPreferredProfileIdRef.current = preferredProfileId;
    openPreferredProfile(profile);
  }, [
    connectedSessionId,
    loading,
    open,
    openIntentId,
    preferredProfileId,
    refreshingIntent,
    sourceManagementSnapshot,
  ]);

  useEffect(() => {
    if (
      !open ||
      !preferredSourceServerId ||
      refreshingIntentRef.current !== null ||
      loading ||
      connectedSessionId ||
      consumedPreferredSourceServerIdRef.current === preferredSourceServerId ||
      !sourceManagementSnapshot
    ) {
      return;
    }
    const profile = findPreferredSourceConnectionProfile(
      sourceManagementSnapshot,
      preferredSourceServerId,
    );
    if (!profile) return;

    // Bug 原因：侧栏设备组虽然已知 sourceServerId，弹窗入口过去只接受连接类型，
    // 打开后只能重置到设备首屏。这里一次性消费设备意图，并复用设备卡既有直达目录链路。
    consumedPreferredSourceServerIdRef.current = preferredSourceServerId;
    openPreferredSourceDirectory(profile);
  }, [
    connectedSessionId,
    loading,
    open,
    openIntentId,
    preferredSourceServerId,
    refreshingIntent,
    sourceManagementSnapshot,
  ]);

  const resumeOpenedBackground = useEffectEvent(() => {
    // 普通入口只更新受控 open，曾绕过后台恢复，导致已完成结果挂在没有继续入口的连接页。
    // 复用同一恢复动作：在途时解除后台标记，完成后一次消费结果，保留取消与代际保护。
    if (minimizedRef.current) resumeBackground();
  });
  useEffect(() => {
    if (open) resumeOpenedBackground();
  }, [open]);

  const displayTarget = useMemo(
    () =>
      pendingRemoteTarget?.kind === "ssh"
        ? {
            kind: "ssh" as const,
            host: pendingRemoteTarget.host,
            username: pendingRemoteTarget.username,
            port: pendingRemoteTarget.port,
          }
        : pendingRemoteTarget?.kind === "server"
          ? {
              kind: "server" as const,
              url: pendingRemoteTarget.url,
              name: pendingRemoteTarget.name,
            }
          : pendingRemoteTarget,
    [pendingRemoteTarget],
  );

  return {
    displayTarget,
  };
}
