// SessionPane 拆分：草稿预热会话绑定、命令恢复与草稿模型切换提示。
import { toast } from "@/components/ui/toast.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { logger } from "@/logger.js";
import type { ComposerScope, PendingTaskDraft } from "@/v4/composer/composerDraftStore.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { useDraftRuntimeRebuildGate } from "@/v4/composer/useDraftRuntimeRebuildGate.js";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import type { ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type { SessionPaneDispatchCommand } from "@/v4/session-pane/helpers.js";
import type { SessionPaneLeaseBinding } from "@/v4/session-pane/useSessionPaneLease.js";
import type { SessionDataLayer, SessionLease } from "@/v4/sessionDataLayer.js";
import { usePendingCommandRecovery } from "@/v4/usePendingCommandRecovery.js";
import type { ModelSelectionView } from "@zcode/services";
import type { SessionCreateSource } from "@zcode/shared";
import type {
  ConversationSnapshot,
  SessionConfigState,
  SessionModelTransition,
} from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

export interface UseSessionPaneDraftSessionParams {
  paneId: string;
  sessionId: string | null;
  selectionSideChat: boolean;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  provider: "glm" | undefined;
  onSelectionSideChatUnavailable: (() => void) | undefined;
  focused: boolean;
  remoteAvailable: boolean;
  layer: SessionDataLayer;
  onRuntimeRestart: (listener: () => void) => () => void;
  onRuntimeLifecycle:
    | ((listener: (state: "available" | "unavailable") => void) => () => void)
    | undefined;
  intl: IntlInstance;
  newTaskComposerScope: ComposerScope;
  setResolvedDraftCommand: Dispatch<SetStateAction<string | null>>;
  recoveringDraft: PendingTaskDraft | null;
  lease: SessionLease | null;
  setLease: Dispatch<SetStateAction<SessionPaneLeaseBinding>>;
  state: ConversationStoreState;
  snapshot: ConversationSnapshot | null;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  workspaceKey: string;
  draftRuntimeInvalidationVersion: number;
  draftAgentStartupAllowed: boolean;
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  modelSelectionView: ModelSelectionView | null;
  handleDraftSessionCreated: (
    createdSessionId: string,
    createSource?: SessionCreateSource,
    messageId?: string,
    taskGroupId?: string | null,
  ) => Promise<void>;
  dispatchCommand: SessionPaneDispatchCommand;
}

export function useSessionPaneDraftSession(params: UseSessionPaneDraftSessionParams) {
  const {
    paneId,
    sessionId,
    selectionSideChat,
    workspacePath,
    workspaceIdentity,
    provider,
    onSelectionSideChatUnavailable,
    focused,
    remoteAvailable,
    layer,
    onRuntimeRestart,
    onRuntimeLifecycle,
    intl,
    newTaskComposerScope,
    setResolvedDraftCommand,
    recoveringDraft,
    lease,
    setLease,
    state,
    snapshot,
    snapshotRef,
    workspaceKey,
    draftRuntimeInvalidationVersion,
    draftAgentStartupAllowed,
    resolveInitialDraftConfig,
    modelSelectionView,
    handleDraftSessionCreated,
    dispatchCommand,
  } = params;

  // ── 草稿态 v4 draft session 预热（m5）──
  // pane 未绑定会话时后台建 phase=draft 会话作预热载体：配置写 CAS 直达、首发复用。
  // 对外绑定语义不变（shell activeTaskId 仍 null），预热会话只是 pane 内部 effective 订阅目标。
  const { binding: prewarmBinding, waitForSession: waitForDraftSession } = useDraftSessionPrewarm({
    enabled: sessionId === null && draftAgentStartupAllowed && !recoveringDraft,
    workspaceKey,
    paneId,
    invalidationVersion: draftRuntimeInvalidationVersion,
    // SessionDataLayer 来自 workspace connection registry：同 transport generation 的 pane/remount
    // 共享 identity；provider wrapper 重建产生的新 sendCommand 函数不能误判为 transport 换代。
    transportIdentity: layer,
    dispatchCommand,
    // 预热会话只消费当前 Root Composer Draft 的一次性初始化结果。
    resolveInitialConfig: resolveInitialDraftConfig,
  });
  const prewarmBindingRef = useRef(prewarmBinding);
  prewarmBindingRef.current = prewarmBinding;
  const prewarmSessionId = prewarmBinding?.sessionId ?? null;
  // runtime 换代（CUA Helper 就绪、liveness 恢复等触发 workspace-dispose）会冲掉草稿态尚未
  // 持久化的预热会话。重建期间禁止发送，否则附件会挂在已消失的会话上（sessionNotFound）。
  const { rebuilding: draftRuntimeRebuilding } = useDraftRuntimeRebuildGate({
    enabled: sessionId === null,
    onRuntimeRestart,
    onRuntimeLifecycle,
    prewarmSessionId,
    workspaceIdentity,
    workspacePath,
  });
  const ensureDraftPrewarmConfigBeforeSendRef = useRef<(targetSessionId: string) => Promise<void>>(
    async () => undefined,
  );
  const effectiveSessionId = sessionId ?? recoveringDraft?.sessionId ?? prewarmSessionId;
  useEffect(() => {
    if (!recoveringDraft?.commandId || !remoteAvailable) return;
    let current = true;
    const commandId = recoveringDraft.commandId;
    const off = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
      if (!current) return;
      if (
        resolution === "accepted" ||
        resolution === "duplicate" ||
        resolution === "authoritative"
      ) {
        const entry = pendingCommandRegistry.findCommand(commandId);
        const recoveredSessionId = entry?.sessionId ?? recoveringDraft.sessionId;
        if (recoveredSessionId)
          void handleDraftSessionCreated(
            recoveredSessionId,
            entry?.clientContext?.sessionCreateSource,
            commandId,
            entry?.clientContext?.taskGroupId,
          );
      } else if (resolution === "failed" || resolution === "discarded") {
        setResolvedDraftCommand(commandId);
      }
    });
    void pendingCommandRegistry
      .reconcileSession(
        pendingCommandRegistry.findCommand(commandId)?.sessionId ??
          recoveringDraft.sessionId ??
          null,
        (params) => layer.queryCommands(params),
        workspaceIdentity?.trim() || workspacePath,
      )
      .catch((error) => {
        logger.warn("[v4-composer] 首发结果恢复查询失败，保留草稿身份", error);
      });
    return () => {
      current = false;
      off();
    };
  }, [
    recoveringDraft,
    remoteAvailable,
    layer,
    handleDraftSessionCreated,
    newTaskComposerScope,
    workspacePath,
    workspaceIdentity,
  ]);
  const showModelChangeNotice = useCallback(
    (sourceModel: ModelSelectionSource | null, targetModel: ModelSelectionSource) => {
      // Bug 原因：草稿尚未形成实际会话，模型选择本身已经在 composer 中可见；
      // 若此时重复弹出切换结果，会把初始化或 prewarm fallback 误报成一次会话内切换。
      if (sessionId === null) {
        return;
      }

      const fromProviderId = sourceModel?.provider ?? "";
      const fromModelId = sourceModel?.model ?? "";
      const providerChanged = Boolean(
        fromProviderId && targetModel.provider && fromProviderId !== targetModel.provider,
      );
      if (
        !fromModelId ||
        !targetModel.model ||
        (fromModelId === targetModel.model && !providerChanged)
      ) {
        return;
      }

      const fromProvider = resolveProviderLabel(fromProviderId, modelSelectionView);
      const toProvider = resolveProviderLabel(targetModel.provider, modelSelectionView);
      const fromModel = formatModelChangeLabel(fromProviderId, fromProvider, fromModelId, intl);
      const toModel = formatModelChangeLabel(
        targetModel.provider,
        toProvider,
        targetModel.model,
        intl,
      );
      toast(intl.formatMessage({ id: "chat.modelChangeNotice.changed" }, { fromModel, toModel }));
    },
    [intl, modelSelectionView, sessionId],
  );

  const handleOnlineModelTransition = useCallback(
    (
      subscribedSessionId: string,
      _store: SessionLease["store"],
      transition: SessionModelTransition,
    ) => {
      if (!focused || subscribedSessionId !== effectiveSessionId) return;
      // Bug 原因：自动 fallback 的提示与偏好晋升过去分别由 online 事件和任意
      // snapshot 差异驱动，recovery/历史投影可能静默改写下一草稿。现在两者都只
      // 消费 store 已按 deliveryKind 去重后的同一 realtime online 事件。
      showModelChangeNotice(transition.from, transition.to);
    },
    [
      effectiveSessionId,
      focused,
      provider,
      sessionId,
      showModelChangeNotice,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );
  const onlineModelTransitionHandlerRef = useRef(handleOnlineModelTransition);
  useLayoutEffect(() => {
    onlineModelTransitionHandlerRef.current = handleOnlineModelTransition;
  }, [handleOnlineModelTransition]);

  const recoverableCommands = usePendingCommandRecovery({
    layer,
    sessionId: effectiveSessionId,
    snapshot,
    status: state.status,
    subscriptionId: state.subscriptionId,
    workspacePath,
    workspaceIdentity,
  });

  useEffect(() => {
    if (!effectiveSessionId) {
      setLease({ sessionId, layer, lease: null });
      return;
    }
    const nextLease = layer.acquire(effectiveSessionId);
    // Bug 原因：acquire 会立即启动 connect，activation 可能在下一轮 effect 前释放
    // 一次性 online 帧；必须在 acquire 返回后同步监听，不能靠 snapshot 重放补偿。
    const offOnlineModelTransition = nextLease.store.onOnlineModelTransition((transition) => {
      onlineModelTransitionHandlerRef.current(effectiveSessionId, nextLease.store, transition);
    });
    setLease({ sessionId, layer, lease: nextLease });
    return () => {
      offOnlineModelTransition();
      nextLease.release();
    };
  }, [layer, effectiveSessionId]);

  useEffect(() => {
    if (!sessionId || !lease || snapshot?.sessionId !== sessionId) return;
    void lease.store.refreshPlans();
  }, [lease, sessionId, snapshot?.sessionId, state.planDirectoryRevision]);

  // 预热会话订阅失败（CLI 重启内存会话消失等）→ 丢弃旧 binding，下一次发送由 owner 重试。
  useEffect(() => {
    if (sessionId === null && prewarmBinding && state.status === "error") {
      logger.warn("[v4-draft-prewarm] 预热会话订阅失败，丢弃旧 binding", {
        prewarmSessionId: prewarmBinding.sessionId,
        lastError: state.lastError ?? null,
      });
      prewarmBinding.discard();
    }
  }, [prewarmBinding, sessionId, state.lastError, state.status]);

  useEffect(() => {
    if (
      !selectionSideChat ||
      state.status !== "error" ||
      !state.lastError?.includes("sessionNotFound")
    ) {
      return;
    }
    // 副屏是临时 UI 绑定；持久 child 丢失后清 tab，下一次框选按父会话重建。
    onSelectionSideChatUnavailable?.();
  }, [onSelectionSideChatUnavailable, selectionSideChat, state.lastError, state.status]);

  const settleCurrentQueueInputs = useCallback((targetSessionId: string) => {
    const current = snapshotRef.current;
    if (!current || current.sessionId !== targetSessionId) return;
    for (const item of current.queue.items) {
      pendingCommandRegistry.settle(targetSessionId, item.sourceCommandId);
    }
  }, []);

  return {
    waitForDraftSession,
    prewarmBindingRef,
    prewarmSessionId,
    draftRuntimeRebuilding,
    ensureDraftPrewarmConfigBeforeSendRef,
    effectiveSessionId,
    showModelChangeNotice,
    recoverableCommands,
    settleCurrentQueueInputs,
  };
}
