// SessionPane 拆分：会话分享的选择态、预检聚合与发布命令。
import { toast } from "@/components/ui/toast.js";
import { scheduleConversationSharePreflightRequest } from "@/conversation-share-interaction/conversationSharePreflightRequest.js";
import { createConversationSharePreflightResponseHandlers } from "@/conversation-share-interaction/conversationSharePreflightResponse.js";
import type { ConversationSharePreflightState } from "@/conversation-share-interaction/ConversationSharePreflightStatus.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";
import { logger } from "@/logger.js";
import {
  DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
  getConversationShareDockState,
  getConversationShareSelectedProductTurnIds,
  useConversationShareSelectionStore,
} from "@/store/conversationShareSelectionStore.js";
import type {
  ConversationShareDisplayError,
  ConversationShareDisplayWarnings,
  ConversationShareDockState,
  ConversationShareSelectionDraft,
} from "@/store/conversationShareSelectionStore.js";
import {
  ensureConversationShareAttempt,
  retainConversationShareAttemptAfterFailure,
} from "@/v4/conversationShareAttempt.js";
import { buildConversationShareItems } from "@/v4/conversationShareItems.js";
import {
  aggregateConversationShareBlockingIssues,
  conversationSharePreflightCacheKey,
  conversationShareTurnFingerprint,
  dedupeConversationShareIssues,
  getMissingConversationSharePreflightTurnIds,
} from "@/v4/conversationSharePreflightCache.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import type {
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  IConversationShareService,
} from "@zcode/services";
import { localizeConversationShareUrl } from "@zcode/shared";
import type { Locale } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UseSessionPaneShareSelectionParams {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  compactForRemoteControl: boolean;
  conversationShareService: IConversationShareService;
  intl: IntlInstance;
  snapshot: ConversationSnapshot | null;
}

export function useSessionPaneShareSelection(params: UseSessionPaneShareSelectionParams) {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    compactForRemoteControl,
    conversationShareService,
    intl,
    snapshot,
  } = params;

  const shareDraft = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.drafts[sessionId] : undefined,
  );
  const shareDockState = useConversationShareSelectionStore((storeState) =>
    sessionId ? storeState.dockStates[sessionId] : undefined,
  );
  const shareDock = shareDockState ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
  const shareTitle = shareDock.title ?? snapshot?.meta.title?.trim() ?? sessionId ?? "";
  const shareDisclosureAccepted = shareDock.disclosureAccepted;
  const sharePublishing = shareDock.publishing;
  const shareProgress = shareDock.progress;
  const shareCompletedArtifacts = shareDock.completedArtifacts;
  const shareTotalArtifacts = shareDock.totalArtifacts;
  const publishedShareUrl = shareDock.publishedShareUrl;
  const shareError = shareDock.error;
  const shareWarnings = shareDock.warnings;
  const shareActive = shareDraft?.open === true;
  // pending 草稿存在即处于范围编辑，避免维护第二套 stage/view 状态。
  const shareSelectionPanelVisible = shareActive && shareDraft?.pendingExcludedRowIds != null;
  const closeShare = useConversationShareSelectionStore((value) => value.closeShare);
  const updateShareDockState = useConversationShareSelectionStore((value) => value.updateDockState);
  const confirmShareSelection = useConversationShareSelectionStore(
    (value) => value.confirmSelectionEdit,
  );
  const beginShareSelection = useConversationShareSelectionStore(
    (value) => value.beginSelectionEdit,
  );
  const syncAvailableTurns = useConversationShareSelectionStore(
    (value) => value.syncAvailableTurns,
  );
  const toggleShareRow = useConversationShareSelectionStore((value) => value.togglePendingRow);
  const setAllPendingShareRows = useConversationShareSelectionStore(
    (value) => value.setAllPendingRowsSelected,
  );
  const deselectShareProductTurn = useConversationShareSelectionStore(
    (value) => value.deselectProductTurn,
  );
  const setShareAccessMode = useConversationShareSelectionStore((value) => value.setAccessMode);
  const cancelShareSelection = useConversationShareSelectionStore(
    (value) => value.cancelSelectionEdit,
  );
  const dismissShareSelectionPanel = useCallback(() => {
    if (sessionId) cancelShareSelection(sessionId);
  }, [sessionId, cancelShareSelection]);
  const pendingShareRowIds = useMemo(
    () =>
      new Set(
        (shareDraft?.availableRowIds ?? []).filter(
          (id) =>
            !(shareDraft?.pendingExcludedRowIds ?? shareDraft?.excludedRowIds ?? []).includes(id),
        ),
      ),
    [shareDraft],
  );
  const pendingShareTurnCount = useMemo(
    () =>
      new Set([...pendingShareRowIds].map((id) => shareDraft?.productTurnIdByRowId[id] ?? id)).size,
    [pendingShareRowIds, shareDraft],
  );
  const shareRenderUnits = useMemo(
    () => buildConversationTurnRenderUnits(snapshot?.rows.window ?? []),
    [snapshot?.rows.window],
  );
  const shareItems = useMemo(
    () =>
      buildConversationShareItems(shareRenderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, shareRenderUnits],
  );
  const eligibleShareItems = useMemo(
    () => shareItems.filter((item) => !item.isRunning),
    [shareItems],
  );
  useEffect(() => {
    if (!sessionId || !shareActive) return;
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    syncAvailableTurns(
      sessionId,
      eligibleShareItems.flatMap((item) => {
        const productTurnId = rowsById.get(item.rowId)?.productTurnId;
        return productTurnId ? [{ rowId: item.rowId, productTurnId }] : [];
      }),
    );
  }, [eligibleShareItems, sessionId, shareActive, snapshot?.rows.window, syncAvailableTurns]);
  const selectedShareProductTurnIds = useMemo(
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
          )
        : [],
    [sessionId, shareDraft],
  );
  const preflightShareProductTurnIds = useMemo(
    // 选择器预检读取待确认草稿；取消后自动回到已确认范围，不提前提交选择。
    () =>
      sessionId
        ? getConversationShareSelectedProductTurnIds(
            useConversationShareSelectionStore.getState(),
            sessionId,
            "pending",
          )
        : [],
    [sessionId, shareDraft],
  );
  const sharePreflightMetaRef = useRef<{
    revision: number;
    logEpoch: string;
    capabilitiesFingerprint: string;
    supportedArtifactTypes: readonly ConversationShareAllowedArtifact[];
  }>({
    revision: 0,
    logEpoch: "",
    capabilitiesFingerprint: "",
    supportedArtifactTypes: [],
  });
  const [sharePreflightVersion, setSharePreflightVersion] = useState(0);
  const selectedShareTurnFingerprints = useMemo(
    () =>
      new Map(
        preflightShareProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(
            snapshot?.rows.window ?? [],
            productTurnId,
            workspacePath,
            {
              workspaceKey: workspaceIdentity?.trim() || workspacePath,
              remoteSessionId: remoteSessionId ?? "",
              sessionId: sessionId ?? "",
              revision: snapshot?.revision,
              logEpoch: snapshot?.logEpoch,
              capabilitiesFingerprint: sharePreflightMetaRef.current.capabilitiesFingerprint,
            },
          ),
        ]),
      ),
    [
      remoteSessionId,
      preflightShareProductTurnIds,
      sessionId,
      sharePreflightVersion,
      snapshot?.logEpoch,
      snapshot?.revision,
      snapshot?.rows.window,
      workspaceIdentity,
      workspacePath,
    ],
  );
  const eligibleShareProductTurnIds = useMemo(() => {
    const rowsById = new Map((snapshot?.rows.window ?? []).map((row) => [row.rowId, row]));
    const seen = new Set<string>();
    return eligibleShareItems.flatMap((item) => {
      const productTurnId = rowsById.get(item.rowId)?.productTurnId;
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
  }, [eligibleShareItems, snapshot?.rows.window]);
  const sharePreflightCacheRef = useRef(new Map<string, ConversationShareTurnPreflightResult>());
  // 传输类失败会被按 turn 缓存成阻断项，仅靠选择变化无法再次触发 RPC；
  // 重试 token 变化时清缓存并重新发起，避免一次网络抖动把用户卡死在选择阶段。
  const [sharePreflightRetryToken, setSharePreflightRetryToken] = useState(0);
  const sharePreflightScopeKey = `${workspaceIdentity?.trim() || workspacePath}\u0000${remoteSessionId ?? ""}\u0000${sessionId ?? ""}`;
  const sharePreflightScopeKeyRef = useRef<string | null>(null);
  const sharePreflightCacheKey = useCallback(
    (productTurnId: string) =>
      conversationSharePreflightCacheKey(sharePreflightScopeKey, productTurnId),
    [sharePreflightScopeKey],
  );
  const retrySharePreflight = useCallback(() => {
    for (const productTurnId of preflightShareProductTurnIds) {
      sharePreflightCacheRef.current.delete(sharePreflightCacheKey(productTurnId));
    }
    setSharePreflightRetryToken((token) => token + 1);
    setSharePreflightVersion((version) => version + 1);
  }, [preflightShareProductTurnIds, sharePreflightCacheKey]);
  const shareHydratedSessionRef = useRef<string | null>(null);
  const sharePreflight = useMemo<ConversationSharePreflightState>(() => {
    if (!shareActive || !sessionId || compactForRemoteControl) {
      return { status: "idle" };
    }
    if (preflightShareProductTurnIds.length === 0) {
      return { status: "idle" };
    }
    const entries = preflightShareProductTurnIds.map((productTurnId) => {
      const entry = sharePreflightCacheRef.current.get(sharePreflightCacheKey(productTurnId));
      return entry?.turnFingerprint === selectedShareTurnFingerprints.get(productTurnId)
        ? entry
        : undefined;
    });
    if (entries.some((entry) => entry === undefined)) {
      return { status: "checking" };
    }
    const resolvedEntries = entries.filter(
      (entry): entry is ConversationShareTurnPreflightResult => entry !== undefined,
    );
    return {
      status: "ready",
      ...sharePreflightMetaRef.current,
      blockingIssues: aggregateConversationShareBlockingIssues(resolvedEntries),
      skippableWarnings: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.skippableWarnings),
      ),
      deferredIssues: dedupeConversationShareIssues(
        resolvedEntries.flatMap((entry) => entry.deferredIssues),
      ),
      turnResults: resolvedEntries,
    };
  }, [
    compactForRemoteControl,
    sessionId,
    preflightShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    shareActive,
    sharePreflightVersion,
  ]);

  useEffect(() => {
    if (sharePreflightScopeKeyRef.current === sharePreflightScopeKey) return;
    sharePreflightScopeKeyRef.current = sharePreflightScopeKey;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sharePreflightScopeKey]);

  useEffect(() => {
    if (shareActive && sessionId) return;
    sharePreflightCacheRef.current.clear();
    sharePreflightMetaRef.current = {
      revision: 0,
      logEpoch: "",
      capabilitiesFingerprint: "",
      supportedArtifactTypes: [],
    };
    setSharePreflightVersion((version) => version + 1);
  }, [sessionId, shareActive]);

  useEffect(() => {
    // 预检结果按 turn 缓存：选择/取消只重新聚合当前选中项，只有首次加入或 turn fingerprint
    // 变化才触发 RPC；发布阶段仍走独立的权威 stat/read/SHA 校验，不能把这里的缓存当成最终事实。
    const requestScopeKey = sharePreflightScopeKey;
    if (
      !shareActive ||
      !sessionId ||
      compactForRemoteControl ||
      preflightShareProductTurnIds.length === 0
    ) {
      return undefined;
    }
    const missingProductTurnIds = getMissingConversationSharePreflightTurnIds(
      sharePreflightScopeKey,
      preflightShareProductTurnIds,
      sharePreflightCacheRef.current,
      selectedShareTurnFingerprints,
    );
    if (missingProductTurnIds.length === 0) return undefined;
    const requestRows = snapshot?.rows.window ?? [];
    return scheduleConversationSharePreflightRequest({
      request: () =>
        conversationShareService.preflight({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          selection: {
            kind: "productTurns",
            productTurnIds: missingProductTurnIds,
          },
        }),
      ...createConversationSharePreflightResponseHandlers({
        sessionId,
        workspacePath,
        workspaceIdentity,
        remoteSessionId,
        missingProductTurnIds,
        requestRows,
        selectedShareTurnFingerprints,
        sharePreflightCacheRef,
        sharePreflightMetaRef,
        sharePreflightCacheKey,
        isCurrent: () => shareActive && requestScopeKey === sharePreflightScopeKeyRef.current,
        onUpdated: () => setSharePreflightVersion((version) => version + 1),
      }),
    });
  }, [
    compactForRemoteControl,
    conversationShareService,
    remoteSessionId,
    preflightShareProductTurnIds,
    selectedShareTurnFingerprints,
    sharePreflightCacheKey,
    sharePreflightRetryToken,
    sharePreflightScopeKey,
    sessionId,
    shareActive,
    snapshot?.rows.window,
    workspaceIdentity,
    workspacePath,
  ]);

  return {
    shareDraft,
    shareTitle,
    shareDisclosureAccepted,
    sharePublishing,
    shareProgress,
    shareCompletedArtifacts,
    shareTotalArtifacts,
    publishedShareUrl,
    shareError,
    shareWarnings,
    shareActive,
    shareSelectionPanelVisible,
    closeShare,
    updateShareDockState,
    confirmShareSelection,
    beginShareSelection,
    toggleShareRow,
    setAllPendingShareRows,
    deselectShareProductTurn,
    setShareAccessMode,
    dismissShareSelectionPanel,
    pendingShareRowIds,
    pendingShareTurnCount,
    shareItems,
    selectedShareProductTurnIds,
    preflightShareProductTurnIds,
    eligibleShareProductTurnIds,
    retrySharePreflight,
    shareHydratedSessionRef,
    sharePreflight,
  };
}

export interface UseSessionPaneSharePublishParams {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  remoteSessionId: string | null | undefined;
  onOpenBrowserUrl: ((url: string) => void) | undefined;
  conversationShareService: IConversationShareService;
  intl: IntlInstance;
  locale: Locale;
  snapshot: ConversationSnapshot | null;
  shareDraft: ConversationShareSelectionDraft | undefined;
  shareTitle: string;
  sharePublishing: boolean;
  publishedShareUrl: string | null;
  shareError: ConversationShareDisplayError | null;
  closeShare: (taskId: string) => void;
  updateShareDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
}

export function useSessionPaneSharePublish(params: UseSessionPaneSharePublishParams) {
  const {
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenBrowserUrl,
    conversationShareService,
    intl,
    locale,
    snapshot,
    shareDraft,
    shareTitle,
    sharePublishing,
    publishedShareUrl,
    shareError,
    closeShare,
    updateShareDockState,
  } = params;

  const handleConfirmShareDisclosure = useCallback(async () => {
    if (!sessionId || !shareDraft || sharePublishing) return;
    const productTurnIds = getConversationShareSelectedProductTurnIds(
      useConversationShareSelectionStore.getState(),
      sessionId,
    );
    if (productTurnIds.length === 0 || !shareTitle.trim()) return;
    const attemptKey = JSON.stringify({
      title: shareTitle.trim(),
      accessMode: shareDraft.accessMode,
      productTurnIds,
      revision: snapshot?.revision ?? null,
      logEpoch: snapshot?.logEpoch ?? null,
    });
    const shareAttempt = ensureConversationShareAttempt(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), sessionId)
        .attempt,
      attemptKey,
      sessionId,
      { randomUUID: () => globalThis.crypto?.randomUUID?.() },
    );
    const operationId = `share-operation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    let activePhase = "collecting";
    let collectedWarnings: ConversationShareDisplayWarnings | null = null;
    const progressSubscription = conversationShareService.onDynamicPublishProgress(operationId)((
      progress,
    ) => {
      activePhase = progress.phase;
      updateShareDockState(sessionId, {
        progress: progress.phase === "complete" ? "checking" : progress.phase,
        completedArtifacts: progress.completedArtifacts,
        totalArtifacts: progress.totalArtifacts,
      });
      const warnings = sanitizeConversationShareWarnings(progress.warnings);
      if (warnings.length > 0) {
        collectedWarnings = {
          issues: warnings,
          issueCount: warnings.length,
          ...(progress.omittedWarningCount
            ? { omittedIssueCount: progress.omittedWarningCount }
            : {}),
        };
      }
    });
    updateShareDockState(sessionId, {
      attempt: shareAttempt,
      publishing: true,
      progress: "collecting",
      completedArtifacts: 0,
      totalArtifacts: 0,
      publishedShareUrl: null,
      error: null,
      warnings: null,
    });
    try {
      const share = await conversationShareService.publish(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
          title: shareTitle.trim(),
          accessMode: shareDraft.accessMode,
          selection: { kind: "productTurns", productTurnIds },
          clientRequestId: shareAttempt.clientRequestId,
          disclosureAcceptedAt: shareAttempt.disclosureAcceptedAt,
          locale,
        },
        operationId,
      );
      const warnings = collectedWarnings as ConversationShareDisplayWarnings | null;
      updateShareDockState(sessionId, {
        publishedShareUrl: share.share_url,
        warnings,
      });
      // collectedWarnings 只在 progress 回调里赋值，TS 的控制流分析看不到跨闭包写入，
      // 会把它收窄成 null，这里显式还原真实类型。
      if (warnings) {
        toast(
          intl.formatMessage(
            { id: "conversationShare.publishSucceededWithSkips" },
            { count: warnings.issueCount },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "conversationShare.publishSucceeded" }));
      }
    } catch (error) {
      const details = getConversationShareErrorDetails(error);
      // 401 等传输错误通常没有服务端 issues，不能再降级成 collecting 阶段的通用文案。
      const resolvedMessageId = resolveConversationSharePublishErrorMessageId(error);
      const messageId =
        resolvedMessageId === "conversationShare.publishFailed" ? undefined : resolvedMessageId;
      updateShareDockState(sessionId, {
        attempt: retainConversationShareAttemptAfterFailure(shareAttempt, details.code),
        error:
          details.issues && details.issues.length > 0
            ? {
                issues: details.issues,
                issueCount: details.issueCount ?? details.issues.length,
                omittedIssueCount: details.omittedIssueCount,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                rejection: details.rejection,
              }
            : {
                issues: [
                  {
                    code: resolveConversationShareFallbackIssueCode(details),
                    scope: "transport",
                    phase: activePhase as "collecting" | "uploading" | "checking" | "complete",
                  },
                ],
                issueCount: 1,
                requestId: details.requestId,
                clientRequestId: details.clientRequestId,
                operationId,
                status: details.status,
                code: details.code,
                rejection: details.rejection,
                messageId,
              },
      });
      logger.warn("[conversation-share] 会话发布失败", {
        sessionId,
        operationId,
        phase: activePhase,
        accessMode: shareDraft.accessMode,
        selectedProductTurnCount: productTurnIds.length,
        remoteWorkspace: Boolean(workspaceIdentity || remoteSessionId),
        errorName: details.name,
        kind: details.kind,
        ...(details.reasonCode === undefined ? {} : { reasonCode: details.reasonCode }),
        ...(details.diagnostics === undefined ? {} : { diagnostics: details.diagnostics }),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
        ...(details.rejection ? { rejection: details.rejection } : {}),
        ...(details.requestId === undefined ? {} : { requestId: details.requestId }),
      });
    } finally {
      progressSubscription.dispose();
      updateShareDockState(sessionId, { publishing: false });
    }
  }, [
    conversationShareService,
    intl,
    remoteSessionId,
    sessionId,
    shareDraft,
    sharePublishing,
    shareTitle,
    snapshot?.logEpoch,
    snapshot?.revision,
    updateShareDockState,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleCopyPublishedShare = useCallback(async () => {
    if (!publishedShareUrl || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(publishedShareUrl);
      toast(intl.formatMessage({ id: "conversationShare.copySucceeded" }));
      return true;
    } catch {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return false;
    }
  }, [intl, publishedShareUrl]);

  const handleOpenPublishedShare = useCallback(() => {
    if (!publishedShareUrl || !onOpenBrowserUrl) return;
    // 服务端保存规范 /cn/share/ 路径；打开时再按当前界面语言切换落地页路径。
    onOpenBrowserUrl(localizeConversationShareUrl(publishedShareUrl, locale));
  }, [locale, onOpenBrowserUrl, publishedShareUrl]);

  const handleCopyShareRequestId = useCallback(() => {
    const requestId = shareError?.requestId;
    if (!requestId || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "conversationShare.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(requestId).then(
      () => toast(intl.formatMessage({ id: "conversationShare.copySucceeded" })),
      () => toast(intl.formatMessage({ id: "conversationShare.copyFailed" })),
    );
  }, [intl, shareError?.requestId]);

  const handleShareCancel = useCallback(() => {
    if (sharePublishing || !sessionId) return;
    closeShare(sessionId);
  }, [closeShare, sessionId, sharePublishing]);

  return {
    handleConfirmShareDisclosure,
    handleCopyPublishedShare,
    handleOpenPublishedShare,
    handleCopyShareRequestId,
    handleShareCancel,
  };
}
