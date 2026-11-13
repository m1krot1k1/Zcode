// SessionPane 拆分：命令编排入口（dispatchCommand 闭包纪律）与文件变更/撤销读取。
import { useCodingPlanBillingDiscountFromService } from "@/CodingPlanBillingDiscount.js";
import { toast } from "@/components/ui/toast.js";
import { recordHighspeedTurn } from "@/highspeed/highspeedTurnStore.js";
import type { ModelSelectionRead } from "@/hooks/useModelSelectionView.js";
import { usePlanIdentitySnapshot } from "@/hooks/usePlanIdentitySnapshot.js";
import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { isProviderNotReadyError } from "@/lib/chatPrepareError.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { prepareComposerRecentReceipt } from "@/lib/composerRecent.js";
import { createRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { reportSessionCreate } from "@/lib/sessionCreateTelemetry.js";
import { logger } from "@/logger.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { useOptionalCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { recordV4CommandAck } from "@/v4/commandAckObservability.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { readPendingTaskDraft } from "@/v4/composer/composerDraftStore.js";
import type { ComposerScope } from "@/v4/composer/composerDraftStore.js";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import type { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { requiresAcceptedInputProjection } from "@/v4/conversationProjectionStore.js";
import type { ConversationFileChangesRequestOptions } from "@/v4/conversationRowContext.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import {
  MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES,
  submissionConfigFromCommand,
} from "@/v4/session-pane/helpers.js";
import type { SessionPaneDispatchCommand } from "@/v4/session-pane/helpers.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { shouldResyncForStaleAuthority } from "@/v4/staleAuthorityRecovery.js";
import type {
  ConversationPromptTelemetrySeed,
  ConversationTelemetrySupervisor,
} from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { resolveSendAckSettlement } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import type { IServiceAccessor } from "@zcode/services";
import type {
  AppSettings,
  HighspeedCardSnapshot,
  IPlatformService,
  ModelSelection,
  SessionCreateSource,
} from "@zcode/shared";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  CommandType,
  ConversationRowTarget,
  ConversationSnapshot,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";

export interface UseSessionPaneCommandDispatchParams {
  sessionId: string | null;
  rootSessionId: string | undefined;
  selectionSideChat: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  isDesktop: boolean;
  compactForRemoteControl: boolean;
  provider: "glm" | undefined;
  onSessionCreated: ((sessionId: string) => void) | undefined;
  remoteAvailable: boolean;
  sendCommand: (
    envelope: CommandEnvelope,
    context?: { projectId?: string | null },
  ) => Promise<CommandAck>;
  platform: IPlatformService | null;
  intl: IntlInstance;
  baseWorkspaceServices: IServiceAccessor;
  newTaskComposerScope: ComposerScope;
  conversationTelemetry: ConversationTelemetrySupervisor | null;
  lease: SessionLease | null;
  snapshot: ConversationSnapshot | null;
  newlyCreatedSessionIdRef: RefObject<string | null>;
  dispatchCommandRef: RefObject<SessionPaneDispatchCommand | null>;
  workspaceKey: string;
  sharedSettings: AppSettings | null;
  modelSelectionRead: ModelSelectionRead;
  draftConfig: ReturnType<typeof useDraftConfigControl>["draftConfig"];
  draftConfigRef: ReturnType<typeof useDraftConfigControl>["draftConfigRef"];
  promoteComposerDraft: (createdSessionId: string) => void;
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
}

export function useSessionPaneCommandDispatch(params: UseSessionPaneCommandDispatchParams) {
  const {
    sessionId,
    rootSessionId,
    selectionSideChat,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    isDesktop,
    compactForRemoteControl,
    provider,
    onSessionCreated,
    remoteAvailable,
    sendCommand,
    platform,
    intl,
    baseWorkspaceServices,
    newTaskComposerScope,
    conversationTelemetry,
    lease,
    snapshot,
    newlyCreatedSessionIdRef,
    dispatchCommandRef,
    workspaceKey,
    sharedSettings,
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    promoteComposerDraft,
    captureAcceptedModelSelection,
  } = params;

  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const draftModelSelectionRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionId !== null) {
      draftModelSelectionRevisionRef.current = null;
      return;
    }
    const revision = modelSelectionView?.revision ?? null;
    const previousRevision = draftModelSelectionRevisionRef.current;
    draftModelSelectionRevisionRef.current = revision;
    if (
      revision === null ||
      previousRevision === null ||
      revision === previousRevision ||
      (draftConfigRef.current.provider && draftConfigRef.current.model)
    ) {
      return;
    }
    // Bug 原因：冷启动时普通 Provider 会先让草稿预热，Account Overlay 随后才进入
    // Selection View。旧预热会话冻结了早期 fallback，即使最新 View 已包含当前账号连接，
    // Renderer 也会永久停在旧模型。未发送且无显式选择的草稿不是执行事实；View 更新时
    // 回收并按最新选择事实重建，已显式选择和正式会话仍保持冻结。
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [draftConfigRef, modelSelectionView?.revision, sessionId, workspaceIdentity, workspacePath]);
  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const createSubmissionFromComposer = useCallback(() => {
    return createComposerSubmissionConfig(draftConfigRef.current, modelSelectionView);
  }, [draftConfigRef, modelSelectionView]);
  const composerSubmissionReady = useMemo(() => {
    return createComposerSubmissionConfig(draftConfig, modelSelectionView) !== null;
  }, [draftConfig, modelSelectionView]);
  const codingPlanUpgradeDialog = useOptionalCodingPlanUpgradeDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const billingDiscount = useCodingPlanBillingDiscountFromService(
    baseWorkspaceServices.codingPlanSubscriptionService,
  );
  const projectDirectory = useOptionalProjectDirectory();
  const commitCreatedTask = projectDirectory?.commitCreatedTask;
  const refreshTaskGroups = projectDirectory?.groups.refresh;
  const draftNavigation = useMemo(
    () => ({ controller: new AbortController() }),
    [workspaceKey, sessionId],
  );
  useEffect(() => {
    // StrictMode 会重放 effect；旧 scope 的请求仍使用各自的取消信号。
    draftNavigation.controller = new AbortController();
    return () => draftNavigation.controller.abort();
  }, [draftNavigation]);
  // 首发 commandId 在 accepted 时已存在，也是 completion 的 message_id；不必等回复完成。
  const reportDraftCreated = useCallback(
    (createdSessionId: string, source: SessionCreateSource, messageId: string) => {
      void reportSessionCreate(platform, {
        sessionId: createdSessionId,
        messageId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        source,
        clientKind: isDesktop ? "desktop" : compactForRemoteControl ? "mobile" : "web",
      });
    },
    [
      platform,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      isDesktop,
      compactForRemoteControl,
    ],
  );
  const handleDraftSessionCreated = useCallback(
    async (
      createdSessionId: string,
      createSource?: SessionCreateSource,
      messageId?: string,
      taskGroupId?: string | null,
    ) => {
      if (messageId) reportDraftCreated(createdSessionId, createSource ?? "session", messageId);
      const commit = () => {
        // Bug 根因：Session 打开埋点只衡量已有 Session，但草稿首发过去会把新建/预热提升的
        // sessionId 直接交给同一 hook。预热 lease 还保留草稿期的 startedAt 与空 snapshot timing，
        // 因而把数小时闲置时间误记为 total/react。创建边界先标记本 pane 的首次绑定；离开后
        // 再次显式打开同一 Session 时标记会清除，恢复正常的已有 Session 打开测量。
        newlyCreatedSessionIdRef.current = createdSessionId;
        promoteComposerDraft(createdSessionId);
        onSessionCreated?.(createdSessionId);
      };
      const organize =
        taskGroupId !== undefined
          ? async () => {
              const task = {
                taskId: createdSessionId,
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                hostId: remoteHostIdFromWorkspaceIdentity(workspaceIdentity ?? "") ?? "local",
              };
              const attempt = async () => {
                try {
                  if (!baseWorkspaceServices.taskGroupService)
                    throw new Error("task-group.service-unavailable");
                  await baseWorkspaceServices.taskGroupService.admit({
                    tasks: [task],
                    placement: {
                      task,
                      groupId: taskGroupId,
                      creationId: messageId ?? createdSessionId,
                    },
                  });
                  // 分组结构是独立投影；重读迟滞不能延长已接受首发或组织写入的完成时间。
                  void refreshTaskGroups?.();
                } catch (cause) {
                  // 会话已创建；组织失败不能向发送层抛错，否则会诱导用户再发一次。
                  // 重试闭包只持有这次创建的地址和 placement，绝不调用 createSession。
                  logger.error("[task-groups] 新任务归属提交失败", cause);
                  toast(intl.formatMessage({ id: "taskGroup.failed" }), {
                    durationMs: 0,
                    actionLabel: intl.formatMessage({ id: "taskGroup.retryPlacement" }),
                    onAction: () => void attempt(),
                    dedupeKey: `task-group:${createdSessionId}`,
                  });
                }
              };
              await attempt();
            }
          : undefined;
      if (commitCreatedTask) {
        await commitCreatedTask(
          { taskId: createdSessionId, workspacePath, workspaceIdentity },
          commit,
          draftNavigation.controller.signal,
          organize,
        );
      } else {
        void organize?.();
        commit();
      }
    },
    [
      commitCreatedTask,
      baseWorkspaceServices.taskGroupService,
      refreshTaskGroups,
      intl,
      draftNavigation,
      reportDraftCreated,
      onSessionCreated,
      promoteComposerDraft,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const readPlanIdentitySnapshot = usePlanIdentitySnapshot(
    sharedSettings?.providerFamilyDomain,
    sharedSettings?.providerFamilyDomain
      ? sharedSettings.providerFamilyConnectionSelections?.[sharedSettings.providerFamilyDomain]
      : undefined,
    baseWorkspaceServices.usageStatsService,
  );
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const messageStreamShowReasoning = sharedSettings?.messageStreamShowReasoning ?? true;
  const messageStreamShowTodos = sharedSettings?.messageStreamShowTodos ?? false;
  const toolGroupingExploreEnabled = sharedSettings?.toolGroupingExploreEnabled ?? true;
  const toolGroupingTerminalEnabled = sharedSettings?.toolGroupingTerminalEnabled ?? true;
  const toolGroupingChangesEnabled = sharedSettings?.toolGroupingChangesEnabled ?? false;
  const snapshotSessionId = snapshot?.sessionId ?? null;
  const snapshotFollowupMode = snapshot?.config.followupMode ?? null;
  const snapshotRevision = snapshot?.revision ?? null;

  // 注入模式对齐 PermissionDialog：theme/codePreviewSettings 在宿主取 store，
  // 经稳定引用的 rowContext 下发给 memo 行组件（MessageResponse/ToolCallBlocks）。
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  // Tier 1 fork 跳转：点 child 会话的 forkNotice → 把当前 pane 原地切到父会话，复用 fork
  // 落地同款 onSessionCreated（primary→setActiveTaskId、分屏→bindPaneSession）。rowId 预留
  // Tier 2 精确滚动——当前 forkNotice.parentRowId 恒为 0 占位，此处忽略。
  const handleNavigateToRow = useCallback(
    (targetSessionId: string, _rowId: number) => {
      if (!targetSessionId || targetSessionId === sessionId) {
        return;
      }
      onSessionCreated?.(targetSessionId);
    },
    [onSessionCreated, sessionId],
  );
  const dispatchCommand = useCallback(
    async (
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      baseRevision?: number,
      baseLogEpoch?: string,
      telemetrySeed?: ConversationPromptTelemetrySeed,
      highspeedCard?: HighspeedCardSnapshot,
      onEnvelopeCreated?: (envelope: CommandEnvelope) => void,
      creationProjectId?: string | null,
      sessionCreateSource?: SessionCreateSource,
      recentSubmissionOverride?: ComposerSubmissionConfig | null,
      creationTaskGroupId?: string | null,
      submittedDraftText?: string,
    ): Promise<CommandAck> => {
      // 离线点击/快捷键不得进入 accepted 命令恢复账本，更不能在重连后自动发送。
      if (!remoteAvailable) throw createRemoteWorkspaceDisconnectedError();
      const submission = submissionConfigFromCommand(type, payload);
      // 加速轮 payload 的 modelSelection 会被执行材料覆盖为隐藏加速 Provider；Recent 记录的是
      // 用户在 Composer 的原始选择（新任务草稿的模型种子），加速轮必须由调用方传入发送前
      // 冻结的 submission（spec §5.1）。接纳写入另有加速身份兜底拦截。
      const recentSubmission = recentSubmissionOverride ?? submission;
      const zcodeRecentSubmission =
        recentSubmission?.modelSelection && recentSubmission.mode
          ? {
              modelSelection: recentSubmission.modelSelection,
              mode: recentSubmission.mode,
              // Bug 根因：Recent 投影只复制模型和基础 mode，独立的 Plan 状态在新会话种子中丢失。
              // 用冻结的提交值记录，避免接受后读取已变化的 Composer 草稿。
              planEnabled: recentSubmission.planEnabled ?? false,
            }
          : null;
      // 发送时固定组织归属；同 cwd 可属于多个项目，切页和迟到 ACK 不得改写目标。
      let recentScope =
        creationProjectId === undefined
          ? newTaskComposerScope
          : { ...newTaskComposerScope, projectId: creationProjectId };
      // 在异步查询归属前冻结选择与发起顺序，避免慢查询把早发命令排成最新。
      const recentReceipt = zcodeRecentSubmission
        ? prepareComposerRecentReceipt(recentScope, zcodeRecentSubmission)
        : undefined;
      if (zcodeRecentSubmission && sessionId && targetSessionId) {
        const projectService = baseWorkspaceServices.projectService;
        if (!projectService) throw new Error("project.service-unavailable");
        const directories = await projectService.resolveSessionDirectories(
          {
            workspacePath,
            workspaceIdentity,
            // 辅助 child 不进主任务索引；Recent 查所属主会话，输入仍发给 child。
            // 普通会话和 fork 即使带 rootSessionId 也必须保留自身项目归属。
            taskId:
              selectionSideChat && targetSessionId === sessionId && rootSessionId
                ? rootSessionId
                : targetSessionId,
          },
          recentScope.hostId,
        );
        recentScope = { ...recentScope, projectId: directories.projectId };
      }
      if (recentReceipt) recentReceipt.scope = recentScope;
      const pendingDraft =
        sessionId === null && recentScope.projectId === null
          ? readPendingTaskDraft(recentScope)
          : null;
      const acceptSelection =
        submission &&
        submission.modelSelection &&
        (sessionId === null || targetSessionId === sessionId)
          ? captureAcceptedModelSelection(submission.modelSelection)
          : undefined;
      const envelope = createCommandEnvelope({
        type,
        sessionId: targetSessionId,
        payload: payload as never,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(baseLogEpoch ? { baseLogEpoch } : {}),
      });
      onEnvelopeCreated?.(envelope);
      const projectId =
        type === "createSession"
          ? creationProjectId !== undefined
            ? creationProjectId
            : useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                .draftProjectId
          : undefined;
      // 必须早于第一次上行：transport error/renderer refresh 后仍有可查询线索。
      pendingCommandRegistry.record(
        envelope,
        type === "createSession"
          ? {
              workspace: {
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
              },
              ...(projectId !== undefined ? { projectId } : {}),
              ...(recentReceipt
                ? {
                    composer: {
                      ...recentReceipt,
                      submittedText: submittedDraftText,
                      ...(pendingDraft?.workspacePath === workspacePath
                        ? { draftId: pendingDraft.draftId }
                        : {}),
                    },
                  }
                : {}),
              taskGroupId:
                creationTaskGroupId !== undefined
                  ? creationTaskGroupId
                  : useZCodeSessionStore
                      .getState()
                      .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
              sessionCreateSource:
                sessionCreateSource ??
                useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
                  .draftCreateSource,
            }
          : recentReceipt
            ? {
                workspace: { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) },
                ...(sessionId === null
                  ? {
                      projectId: recentScope.projectId,
                      taskGroupId:
                        creationTaskGroupId ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftTaskGroupId,
                      sessionCreateSource:
                        sessionCreateSource ??
                        useZCodeSessionStore
                          .getState()
                          .getWorkspaceState(workspacePath, workspaceIdentity).draftCreateSource,
                    }
                  : {}),
                composer: {
                  ...recentReceipt,
                  submittedText: submittedDraftText,
                  ...(pendingDraft?.workspacePath === workspacePath
                    ? { draftId: pendingDraft.draftId }
                    : {}),
                },
              }
            : undefined,
      );
      if (lease?.store && type !== "createSession") {
        lease.store.markCommandPending({
          commandId: envelope.commandId,
          type: envelope.type,
          issuedAt: envelope.issuedAt,
        });
      }
      let ack: CommandAck;
      try {
        if (telemetrySeed?.localTtft && !workspaceIdentity?.trim()) {
          envelope.ttft = getLocalTtftObserver()?.dispatch(
            telemetrySeed.localTtft,
            workspacePath,
            envelope.commandId,
            targetSessionId,
          );
        }
        ack =
          projectId !== undefined
            ? await sendCommand(envelope, { projectId })
            : await sendCommand(envelope);
        if (telemetrySeed?.localTtft && ack.reasonCode === "guard.heldQueueConfirmationStale")
          getLocalTtftObserver()?.confirmationRetry(telemetrySeed.localTtft);
        else if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.ack(telemetrySeed.localTtft, ack.status, ack.ttftExcluded);
      } catch (error) {
        if (telemetrySeed?.localTtft)
          getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
        if (lease?.store) {
          lease.store.settleCommand(envelope.commandId);
        }
        if (isProviderNotReadyError(error)) {
          // provider_not_ready 在 Host getClient 前确定性拒绝，CLI 不可能已经
          // admission。若继续保留 renderer 恢复账本，重连 query 必然得到 unknown；即使
          // unknown 现已静默清账，也不应为确定性拒绝留下无效的恢复记录。
          pendingCommandRegistry.rejectCommand(envelope.sessionId, envelope.commandId);
        }
        recordV4CommandAck({
          type,
          status: "transport-error",
          reasonCode: String(error),
          at: Date.now(),
        });
        // 发送漏斗落定：telemetrySeed 只有真实用户发送才携带，两步式 createSession
        // 与后台任务无 seed，天然不会伪造 send_result。
        if (telemetrySeed) {
          conversationTelemetry?.settleSendResult({
            seed: telemetrySeed,
            sessionId: targetSessionId,
            commandId: envelope.commandId,
            status: "fail",
            reasonCode: isProviderNotReadyError(error) ? "provider_not_ready" : "transport_error",
          });
        }
        throw error;
      }
      pendingCommandRegistry.applyAck(envelope, ack);
      if (ack.status === "accepted") {
        acceptSelection?.();
      }
      if (
        lease?.store &&
        requiresAcceptedInputProjection(type) &&
        (ack.status === "accepted" || ack.status === "duplicate")
      ) {
        // Bug 根因：editUserQuery 会先发布 branch cut；若 replacement user row 的 topic
        // 投影静默，UI 只剩截断结果。ACK 后必须和 sendText 一样等待权威输入投影；
        // watchdog 只重订阅，不伪造消息、不恢复旧分支，也不重放命令。
        lease.store.expectAcceptedInputProjection(envelope.commandId);
      }
      if (ack.status === "accepted" && telemetrySeed) {
        const acceptedSessionId =
          ack.result?.type === "createSelectionSideSession"
            ? ack.result.sessionId
            : (targetSessionId ??
              (ack.result?.type === "createSession" ? ack.result.sessionId : null));
        if (acceptedSessionId) {
          conversationTelemetry?.acceptPromptSeed({
            ...telemetrySeed,
            sessionId: acceptedSessionId,
            sourceCommandId: envelope.commandId,
            memoryEnabled: ack.memoryEnabled,
          });
        }
      }
      if (ack.status === "accepted" && highspeedCard && targetSessionId) {
        recordHighspeedTurn({
          sessionId: targetSessionId,
          sourceCommandId: envelope.commandId,
          card: highspeedCard,
          createdAt: Date.now(),
        });
      }
      if (telemetrySeed) {
        // 队列二次确认的 ACK 返回 null（非终态），落定会让 first-wins 吃掉真实结果。
        const outcome = resolveSendAckSettlement(ack);
        if (outcome) {
          const settledSessionId =
            ack.result?.type === "createSelectionSideSession"
              ? ack.result.sessionId
              : (targetSessionId ??
                (ack.result?.type === "createSession" ? ack.result.sessionId : null));
          if (outcome.kind === "awaitRender") {
            // ACK 只代表 Host 收下了命令，用户气泡此刻还没画出来；
            // 等投影回流出 userInput row（或 30s 超时）再落定端到端耗时。
            conversationTelemetry?.awaitSendRender({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              ackStatus: outcome.ackStatus,
            });
          } else {
            conversationTelemetry?.settleSendResult({
              seed: telemetrySeed,
              sessionId: settledSessionId,
              commandId: envelope.commandId,
              status: outcome.status,
              ackStatus: outcome.ackStatus,
              reasonCode: outcome.reasonCode,
            });
          }
        }
      }
      // 生产构建 renderer 日志关闭，ack 摘要写入有界调试缓冲供 e2e/现场 probe。
      recordV4CommandAck({
        type,
        status: ack.status,
        ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
        revisionAtDecision: ack.revisionAtDecision,
        at: Date.now(),
      });
      if (shouldResyncForStaleAuthority(ack)) {
        // epoch/entity authority 已变化时只清 optimistic overlay 仍会继续拿旧
        // target 发命令；统一 same-sub recovery 后才能基于同代 rowId/entityId 再裁决。
        lease?.store?.recoverFromStaleAuthority();
      }
      // rejected/stale/failed 时若不 settle，optimistic overlay 会永久残留。
      if (
        lease?.store &&
        type !== "createSession" &&
        ack.status !== "accepted" &&
        ack.status !== "duplicate"
      ) {
        lease.store.settleCommand(envelope.commandId);
      }
      return ack;
    },
    [
      captureAcceptedModelSelection,
      newTaskComposerScope,
      baseWorkspaceServices.projectService,
      conversationTelemetry,
      lease,
      provider,
      sendCommand,
      remoteAvailable,
      rootSessionId,
      selectionSideChat,
      sessionId,
      workspaceIdentity,
      workspacePath,
    ],
  );
  dispatchCommandRef.current = dispatchCommand;

  return {
    modelSelectionView,
    recommendStartPlan,
    createSubmissionFromComposer,
    composerSubmissionReady,
    codingPlanUpgradeDialog,
    openSettingsTab,
    billingDiscount,
    reportDraftCreated,
    handleDraftSessionCreated,
    readPlanIdentitySnapshot,
    appFollowupMode,
    messageStreamShowReasoning,
    messageStreamShowTodos,
    toolGroupingExploreEnabled,
    toolGroupingTerminalEnabled,
    toolGroupingChangesEnabled,
    snapshotSessionId,
    snapshotFollowupMode,
    snapshotRevision,
    theme,
    codePreviewSettings,
    handleNavigateToRow,
    dispatchCommand,
  };
}

export interface UseSessionPaneFileChangesParams {
  sessionId: string | null;
  fileChanges: (
    params: V4ConversationFileChangesParams,
  ) => Promise<V4ConversationFileChangesResult>;
  fileRewindPreview: (
    params: V4ConversationFileRewindPreviewParams,
  ) => Promise<V4ConversationFileRewindPreviewResult>;
  lease: SessionLease | null;
  fileChangesRequestCache: Map<string, Promise<V4ConversationFileChangesResult>>;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  dispatchCommand: SessionPaneDispatchCommand;
}

export function useSessionPaneFileChanges(params: UseSessionPaneFileChangesParams) {
  const {
    sessionId,
    fileChanges,
    fileRewindPreview,
    lease,
    fileChangesRequestCache,
    snapshotRef,
    dispatchCommand,
  } = params;

  const handleFetchFileChanges = useCallback(
    (target: ConversationRowTarget, options: ConversationFileChangesRequestOptions) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
      }
      const cacheKey = JSON.stringify([
        options.cachePolicy,
        sessionId,
        current.logEpoch,
        // rewind 会在同一 logEpoch、row/entity 下把 active 切为 reverted；
        // 终态缓存必须带上这个语义版本，不能继续复用撤销前的完整 diff。
        options.cachePolicy === "in-flight"
          ? current.revision
          : (options.fileChangesState ?? "unknown"),
        target.rowId,
        target.entityId,
      ]);
      const cachedRequest = fileChangesRequestCache.get(cacheKey);
      if (cachedRequest) {
        fileChangesRequestCache.delete(cacheKey);
        fileChangesRequestCache.set(cacheKey, cachedRequest);
        return cachedRequest;
      }

      // 虚拟行卸载会丢失行内 state，复挂载后预览卡片会重复拉取包含完整
      // patch 的 fileChanges；缓存必须放在 SessionPane，才能与文件变更面板共享同一请求。
      let request: Promise<V4ConversationFileChangesResult>;
      request = fileChanges({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).then(
        (result) => {
          // 运行中成功结果仍可能只是当前 revision 的局部 diff；只共享
          // in-flight Promise，settled 后删除，避免最终卡片复用早期结果。
          if (
            options.cachePolicy === "in-flight" &&
            fileChangesRequestCache.get(cacheKey) === request
          ) {
            fileChangesRequestCache.delete(cacheKey);
          }
          return result;
        },
        (error: unknown) => {
          // 失败不能污染后续重试；仅删除当前 Promise，避免旧请求误删同 key 的新请求。
          if (fileChangesRequestCache.get(cacheKey) === request) {
            fileChangesRequestCache.delete(cacheKey);
          }
          if (shouldResyncForStaleAuthority(error)) {
            lease?.store?.recoverFromStaleAuthority();
          }
          throw error;
        },
      );
      fileChangesRequestCache.set(cacheKey, request);
      while (fileChangesRequestCache.size > MAX_CONVERSATION_FILE_CHANGES_CACHE_ENTRIES) {
        const oldestKey = fileChangesRequestCache.keys().next().value;
        if (oldestKey === undefined) break;
        fileChangesRequestCache.delete(oldestKey);
      }
      return request;
    },
    [fileChanges, fileChangesRequestCache, lease, sessionId],
  );

  const handlePreviewFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        return Promise.resolve({
          canApply: false,
          safeFiles: [],
          unsafeFiles: [],
          ignoredFiles: [],
        });
      }
      return fileRewindPreview({
        sessionId,
        target,
        baseRevision: current.revision,
        baseLogEpoch: current.logEpoch,
      }).catch((error: unknown) => {
        if (shouldResyncForStaleAuthority(error)) {
          lease?.store?.recoverFromStaleAuthority();
        }
        throw error;
      });
    },
    [fileRewindPreview, lease, sessionId],
  );

  const handleApplyFileRewind = useCallback(
    (target: ConversationRowTarget) => {
      const current = snapshotRef.current;
      if (!sessionId || !current) {
        throw new Error("Cannot apply file rewind without an active session revision");
      }
      return dispatchCommand(
        "applyFileRewind",
        { target },
        sessionId,
        current.revision,
        current.logEpoch,
      );
    },
    [dispatchCommand, sessionId],
  );

  return { handleFetchFileChanges, handlePreviewFileRewind, handleApplyFileRewind };
}
