import { toast } from "@/components/ui/toast.js";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import { useCallback } from "react";
import {
  createUuid,
  getSourceServerUpdateTarget,
  isSameSourceServerUpdateTarget,
  type RemoteTarget,
} from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  findSourceServerUpgradeProfileId,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";
import { getRemoteConnectionCompletionDialogState } from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { runSourceServerUpdate } from "@/lib/sourceServerUpdateAction.js";
import { startUserAction, type UserActionHandle } from "@/lib/userActionTelemetry.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { RemoteConnectionCompletionIntent } from "@/remote-connection-flow/types.js";
import type { RemoteConnectionFlowState } from "@/remote-connection-flow/useRemoteConnectionFlowState.js";
import type { RemoteConnectionDialogLifecycle } from "@/remote-connection-flow/useRemoteConnectionDialogLifecycle.js";

export type RemoteConnectionConnect = ReturnType<typeof useRemoteConnectionConnect>;

/**
 * 连接与 Source 升级编排：发起连接、安装确认、升级后续连与后台完成动作。
 * startRemoteConnection/resumeRequiredServerUpdate 的相互递归保持在同一闭包内。
 */
export function useRemoteConnectionConnect(
  core: RemoteConnectionFlowState,
  dialog: RemoteConnectionDialogLifecycle,
) {
  const {
    acknowledgeBoundary,
    activeRequestIdRef,
    activeTraceRef,
    applyOpenState,
    applySourceManagementSnapshot,
    completion,
    confirmDialog,
    entryEpochRef,
    forceDecisionRef,
    intl,
    localWorkspacePath,
    minimizedRef,
    onConnect,
    onConnectionReady,
    onDeviceConnected,
    onProjectIntentCleared,
    onSelectProject,
    openIntentId,
    ownsConnectedSessionRef,
    pendingBackgroundCompletion,
    pendingCompletionIntentRef,
    resetConnectionLogs,
    resetFeedback,
    setBackgroundReady,
    setBlockedCompletion,
    setCancelled,
    setConnectedSessionId,
    setCurrentStep,
    setDirectoryPath,
    setError,
    setErrorCode,
    setLoading,
    setPendingForceUpdate,
    setPendingInstallConfirmation,
    setRawError,
    setRecognizedDeviceName,
    setRecognizedSourceServerId,
    setUpgradeLoading,
    setUpgradeProfileId,
    sourceManagement,
    updateConnectingRequestId,
    updatePendingRemoteTarget,
    upgradeLoading,
  } = core;
  const { closeDialog, handleCancelSession, resumeBackground } = dialog;
  const updateRequiredServer = useCallback(
    async (
      profileId: string,
      target: Exclude<RemoteTarget, { kind: "server" }>,
    ): Promise<boolean> => {
      if (!sourceManagement || upgradeLoading) return false;
      const epoch = entryEpochRef.current;
      const isCurrent = () => entryEpochRef.current === epoch;
      setUpgradeLoading(true);
      try {
        const next = await runSourceServerUpdate({
          management: sourceManagement,
          profileId,
          expectedTarget: getSourceServerUpdateTarget(target),
          confirmForce: async () => {
            if (!isCurrent()) return false;
            // 清单只是确认的附加信息，读取失败不能绕过或替换 force=false 守卫。
            const snapshot = await sourceManagement.getSnapshot().catch(() => undefined);
            if (!isCurrent()) return false;
            if (snapshot) applySourceManagementSnapshot(snapshot);
            const tasks = snapshot?.states.find(
              (state) => state.profileId === profileId,
            )?.runningTasks;
            setPendingForceUpdate({ tasks });
            return await new Promise<boolean>((resolve) => {
              forceDecisionRef.current = resolve;
            });
          },
        });
        if (!isCurrent() || !next) return false;
        applySourceManagementSnapshot(next);
        setError("");
        setErrorCode(undefined);
        setRawError(undefined);
        return true;
      } catch (updateError) {
        if (!isCurrent()) return false;
        const failure = updateError as {
          code?: unknown;
          retryable?: unknown;
        };
        if (failure.code === "remote-target-changed") {
          setUpgradeProfileId(null);
          setErrorCode(undefined);
          setRawError(undefined);
          setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
          return false;
        }
        setErrorCode(typeof failure.code === "string" ? failure.code : undefined);
        setRawError(getErrorMessage(updateError));
        setError(
          formatRemoteConnectionError({
            fallback: getErrorMessage(updateError),
            reasonCode: typeof failure.code === "string" ? failure.code : undefined,
            retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
            formatMessage: intl.formatMessage,
          }),
        );
        return false;
      } finally {
        if (isCurrent()) setUpgradeLoading(false);
      }
    },
    [applySourceManagementSnapshot, confirmDialog, intl, sourceManagement, upgradeLoading],
  );

  const startRemoteConnection = async (
    target: RemoteTarget,
    confirmSourceServerInstall = false,
    preferredDirectoryPath?: string,
    options?: RemoteConnectionCompletionIntent["options"],
    automaticServerUpdateAttempted = false,
  ) => {
    const nextTarget = withDefaultRemoteResourcePackages(target);

    if (activeRequestIdRef.current) {
      // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const operationEpoch = ++entryEpochRef.current;
    setDirectoryPath("");
    pendingCompletionIntentRef.current = {
      preferredDirectoryPath,
      options,
    };

    updatePendingRemoteTarget(nextTarget);
    setLoading(true);
    const sessionsAtStart = new Set(
      Object.keys(useRemoteWorkspaceSessionStore.getState().sessionsById),
    );
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setUpgradeProfileId(null);
    setCurrentStep("connecting");
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: nextTarget.kind,
    });
    activeTraceRef.current = { requestId, trace };
    const finishTrace = (finish: (action: UserActionHandle) => void) => {
      if (activeTraceRef.current?.requestId !== requestId) return;
      activeTraceRef.current = null;
      finish(trace);
    };
    try {
      let sessionId: string;
      try {
        const context = confirmSourceServerInstall
          ? { confirmSourceServerInstall: true }
          : undefined;
        sessionId = options?.announceReusedConnection
          ? await onConnect(nextTarget, requestId, context, { announceReusedConnection: true })
          : await onConnect(nextTarget, requestId, context);
      } catch (error) {
        if (activeRequestIdRef.current !== requestId) return;
        const reasonCode =
          error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (reasonCode !== "source-server-install-required") throw error;
        if (!confirmSourceServerInstall) {
          // 安装确认内联在连接阶段，避免在远程弹窗里再套一个确认弹窗，且能让用户看到真实目标。
          const snapshot = await sourceManagement?.getSnapshot().catch(() => undefined);
          if (activeRequestIdRef.current !== requestId) return;
          if (snapshot) applySourceManagementSnapshot(snapshot);
          const failure = error as {
            resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
          };
          const installTarget =
            nextTarget.kind === "wsl" ? (failure.resolvedWslTarget ?? nextTarget) : nextTarget;
          updatePendingRemoteTarget(installTarget);
          setPendingInstallConfirmation(installTarget);
          finishTrace((action) => action.cancel());
          return;
        }
        throw error;
      }
      // 取消/关闭先撤销请求归属；迟到结果只释放临时 session，不能复活旧流程。
      const discardStaleResult = () => {
        if (activeRequestIdRef.current === requestId) return false;
        if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
        return true;
      };
      if (discardStaleResult()) return;
      const connectedSourceServerId =
        useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId]?.sourceServerId;
      // 识别时刻由连接结果驱动：directory-record 完成后 session 才携带 sourceServerId，
      // 此时展示「已识别为现有设备」并刷新快照，确保新识别设备的名称与目录历史立即可用。
      if (connectedSourceServerId) {
        setRecognizedSourceServerId(connectedSourceServerId);
        try {
          const nextSnapshot = await sourceManagement?.getSnapshot();
          if (discardStaleResult()) return;
          if (nextSnapshot) {
            // 经统一 hook 的 generation 判序入口写入，防止旧快照后至覆盖新内容。
            applySourceManagementSnapshot(nextSnapshot);
            setRecognizedDeviceName(
              nextSnapshot.servers.find(
                (server) => server.sourceServerId === connectedSourceServerId,
              )?.displayName,
            );
          }
        } catch {
          // 设备名仅用于展示；快照读取失败时保留连接结果，不打断流程。
        }
      }
      if (discardStaleResult()) return;
      // 后台只保留本次意图的完成动作；不能在网络结果到达时恢复旧页面。
      // 设备管理只需 Source 身份，立即释放本次独占 attachment。
      ownsConnectedSessionRef.current =
        completion !== "device-management" && !sessionsAtStart.has(sessionId);
      if (completion === "device-management" && !sessionsAtStart.has(sessionId)) {
        await handleCancelSession(sessionId);
        if (discardStaleResult()) return;
      }
      setConnectedSessionId(completion === "device-management" ? null : sessionId);
      const finishConnection = async () => {
        const isCurrent = () => entryEpochRef.current === operationEpoch;
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        // 读取/保存介绍也会跨过收起事件；前台权限必须与 epoch 一起在 await 后重验。
        const acknowledged =
          !connectedSourceServerId ||
          (await acknowledgeBoundary(
            () => isCurrent() && !minimizedRef.current,
            () => setBlockedCompletion(() => finishConnection),
          ));
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        if (!acknowledged) return;
        if (completion === "device-management") {
          // 设备管理没有目录/项目副作用；只回收本次独占的临时 attachment，物理连接仍由 Source owner 保持。
          // 聊天返回仍需校验成员资格；必须等完成方确认，失败沿用本 flow 的错误和重试边界。
          await onDeviceConnected?.(
            connectedSourceServerId,
            () => isCurrent() && !minimizedRef.current,
          );
          if (!isCurrent()) return;
          if (minimizedRef.current) {
            deferCompletion();
            return;
          }
          finishTrace((action) => action.complete({ resultSource: "platform_result" }));
          closeDialog({ preserveSession: true });
          return;
        }
        if (onConnectionReady) {
          await onConnectionReady(sessionId);
          if (entryEpochRef.current !== operationEpoch) return;
          finishTrace((action) => action.complete({ resultSource: "platform_result" }));
          return;
        }
        if (preferredDirectoryPath?.trim()) {
          // 目录提交开始后由项目 owner 接管 attachment；取消 UI 不能回收可能已提交成功的会话。
          // 失败仍由下面的 catch 回收或恢复目录选择，介绍等待阶段的取消则由 flow 负责。
          setConnectedSessionId(null);
          try {
            await onSelectProject(
              sessionId,
              preferredDirectoryPath,
              options?.localWorkspacePath ?? localWorkspacePath,
            );
            if (entryEpochRef.current !== operationEpoch) return;
            pendingCompletionIntentRef.current = {};
            minimizedRef.current = false;
            setDirectoryPath("");
            resetConnectionLogs();
            setCurrentStep("device");
            setConnectedSessionId(null);
            updatePendingRemoteTarget(null);
            setRecognizedDeviceName(undefined);
            updateConnectingRequestId(null);
            applyOpenState(false);
            finishTrace((action) => action.complete({ resultSource: "platform_result" }));
            return;
          } catch (selectionError) {
            if (entryEpochRef.current !== operationEpoch) {
              if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
              return;
            }
            if (
              selectionError &&
              typeof selectionError === "object" &&
              "code" in selectionError &&
              selectionError.code === "remote-connection-canceled"
            ) {
              // 成员移除属于意图取消，不是可改目录的 IO 错误；只回收本次新建的 attachment。
              if (!sessionsAtStart.has(sessionId)) await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              pendingCompletionIntentRef.current = {};
              onProjectIntentCleared?.();
              resetFeedback();
              setCancelled(true);
              finishTrace((action) => action.cancel());
              return;
            }
            // 历史目录可能已被删除或权限变化；保留连接并回退目录浏览器，不能把快速入口变成死路。
            setError(getErrorMessage(selectionError));
          }
        }
        const completionState = getRemoteConnectionCompletionDialogState("success", {
          directToDirectory: true,
        });
        setConnectedSessionId(sessionId);
        setCurrentStep(completionState.step);
        minimizedRef.current = false;
        applyOpenState(completionState.open);
        finishTrace((action) => action.complete({ resultSource: "platform_result" }));
      };
      const deferCompletion = () => {
        setConnectedSessionId(completion === "device-management" ? null : sessionId);
        const continueConnection = async () => {
          if (connectedSourceServerId && sourceManagement) {
            const latest = await sourceManagement.getSnapshot();
            if (entryEpochRef.current !== operationEpoch) return;
            applySourceManagementSnapshot(latest);
            if (
              !latest.servers.some((server) => server.sourceServerId === connectedSourceServerId) ||
              !latest.states.some(
                (state) =>
                  state.sourceServerId === connectedSourceServerId && state.state === "online",
              )
            ) {
              if (completion !== "device-management" && !sessionsAtStart.has(sessionId))
                await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              setConnectedSessionId(null);
              minimizedRef.current = true;
              setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
              return;
            }
          }
          await finishConnection();
        };
        pendingBackgroundCompletion.current = continueConnection;
        setBackgroundReady(true);
        toast(intl.formatMessage({ id: "remote.background.ready" }), {
          variant: "info",
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
          dedupeKey: `remote-connection:${openIntentId ?? 0}:${operationEpoch}`,
          actionLabel: intl.formatMessage({ id: "remote.background.continue" }),
          onAction: () => {
            if (
              entryEpochRef.current !== operationEpoch ||
              pendingBackgroundCompletion.current !== continueConnection
            )
              return;
            resumeBackground();
          },
        });
        finishTrace((action) => action.complete({ resultSource: "platform_result" }));
      };
      await finishConnection();
    } catch (connectError) {
      if (activeRequestIdRef.current !== requestId) return;
      if (
        connectError &&
        typeof connectError === "object" &&
        "code" in connectError &&
        connectError.code === "remote-connection-canceled"
      ) {
        resetFeedback();
        setCancelled(true);
        finishTrace((action) => action.cancel());
        return;
      }
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const failure = connectError as {
        code?: unknown;
        retryable?: unknown;
        profileId?: unknown;
        resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
      };
      const reasonCode = typeof failure.code === "string" ? failure.code : undefined;
      const errorMessage = formatRemoteConnectionError({
        fallback: getErrorMessage(connectError),
        reasonCode,
        retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
        formatMessage: intl.formatMessage,
      });
      setErrorCode(reasonCode);
      setRawError(getErrorMessage(connectError));
      setError(errorMessage);
      setCurrentStep(completionState.step);
      if (!minimizedRef.current) applyOpenState(completionState.open);
      finishTrace((action) => action.fail({ failureStage: "remote_connect" }));
      if (reasonCode === "source-server-upgrade-required" && nextTarget.kind !== "server") {
        const failedTarget =
          nextTarget.kind === "wsl" ? (failure.resolvedWslTarget ?? nextTarget) : nextTarget;
        updatePendingRemoteTarget(failedTarget);
        await resumeRequiredServerUpdate(
          failedTarget,
          { preferredDirectoryPath, options },
          operationEpoch,
          automaticServerUpdateAttempted,
          typeof failure.profileId === "string" ? failure.profileId : undefined,
        );
      }
    } finally {
      // 所有失去归属的返回都结束旁路遥测；显式取消已在撤销请求前同步结算。
      finishTrace((action) => action.cancel());
      // 成功恢复原目录会先清空 requestId；仍属同一流程时必须结束 busy，取消/重试则由新 epoch 接管。
      if (entryEpochRef.current === operationEpoch) {
        activeRequestIdRef.current = null;
        setLoading(false);
      }
    }
  };

  const resumeRequiredServerUpdate = async (
    target: Exclude<RemoteTarget, { kind: "server" }>,
    intent: RemoteConnectionCompletionIntent,
    epoch: number,
    automaticServerUpdateAttempted = false,
    failedProfileId?: string,
  ): Promise<void> => {
    if (!sourceManagement) return;
    const isCurrent = () => entryEpochRef.current === epoch;
    try {
      const snapshot = await sourceManagement.getSnapshot();
      if (!isCurrent()) return;
      applySourceManagementSnapshot(snapshot);
      // Profile ID 标识可编辑记录，不能先覆盖失败目标再匹配；WSL 使用失败响应的实际身份。
      if (target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim())) {
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      const failedProfile = failedProfileId
        ? snapshot.profiles.find(
            (profile) =>
              profile.profileId === failedProfileId && profile.lifecycleState !== "retired",
          )
        : undefined;
      if (
        failedProfileId &&
        (!failedProfile || !isSameSourceServerUpdateTarget(failedProfile.target, target))
      ) {
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      const profileId = findSourceServerUpgradeProfileId(snapshot, target, failedProfileId);
      setUpgradeProfileId(profileId);
      if (!profileId) {
        const controllerUpdate = snapshot.states.some(
          (state) =>
            state.state === "needs-upgrade" &&
            state.upgradeTarget === "controller" &&
            snapshot.profiles.some(
              (profile) =>
                profile.profileId === state.profileId &&
                (!failedProfileId || profile.profileId === failedProfileId) &&
                profileMatchesRemoteTarget(profile, target),
            ),
        );
        if (controllerUpdate) return;
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      if (automaticServerUpdateAttempted) return;
      // 原项目交接曾只展示 initialFailure，绕过普通连接的自动更新。两种入口共用同一受保护
      // 更新链与意图 epoch：取消后不得恢复旧项目，更新后的连接也不得形成自动更新循环。
      if (!(await updateRequiredServer(profileId, target)) || !isCurrent()) return;
      updateConnectingRequestId(null);
      await startRemoteConnection(
        target,
        false,
        intent.preferredDirectoryPath,
        intent.options,
        true,
      );
    } catch (cause) {
      if (!isCurrent()) return;
      // 快照失败后只清空 Profile 会留下无效的“更新远端”按钮；清除旧升级错误，
      // 展示真实失败并沿用显式重试，重新连接后再由 Host 快照确认是否需要更新。
      setUpgradeProfileId(null);
      setErrorCode(undefined);
      setRawError(getErrorMessage(cause));
      setError(getErrorMessage(cause));
      logger.warn("[SSHDialog] 读取或核验升级目标失败", cause);
    }
  };

  return {
    updateRequiredServer,
    startRemoteConnection,
    resumeRequiredServerUpdate,
  };
}
