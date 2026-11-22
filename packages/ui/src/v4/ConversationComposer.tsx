/**
 * v4 会话 composer（composer parity）。
 *
 * 壳：ChatPromptEditor（Lexical 编辑器 + 动作菜单 + 拖拽反馈 + sticky 底座视觉），
 * 附件预览网格/大图预览/错误提示区一并提供。
 *
 * 芯：全新 v4 wiring——
 * - 路由/状态一律读 v4 投影 snapshot.inputRouting / control / config / usage；
 * - 发送键状态机对齐旧 UI：canSend（有文本或附件+路由允许）/ pending spinner /
 *   running+空草稿 → Stop（v4 stop 命令）/ 暂停队列（choice）→ 发送后弹清空/保留确认框；
 * - 附件全链路见 useComposerAttachments（发送经 v4 sendText attachments）；
 * - mention（@ 文件/画板、# 会话、$ 技能）与 slash 目录全集在 LexicalChatInput 内接线；
 * - 草稿 per-session 持久化（composerDraftStore）+ prompt history（promptHistoryStorage）；
 * - 工具条（模型/思考深度/模式/context usage）见 V4ComposerToolbar。
 *
 * 本文件只保留状态所有者与调用顺序；具体实现按层拆在 ./conversation-composer：
 * - helpers.ts / types.ts：纯函数与公共类型（对外仍从本模块导出）；
 * - useComposerAttachmentSurfaces：附件上传、拖拽路由与上下文来源；
 * - useComposerDraftController：草稿持久化、scope 恢复、自动聚焦与 prompt history；
 * - useComposerSendController + composerSubmit：发送状态机与编辑器事件；
 * - ComposerTopContent / ComposerControlNodes / ComposerRoot：渲染结构。
 */
import { useRemoteProjectReconnect } from "@/hooks/RemoteProjectPresentationContext.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useRemoteConversationAvailable } from "@/v4/RemoteConversationAvailability.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TID_CHAT_ATTACHMENT_BUTTON, TID_CHAT_ATTACHMENT_MENU_ITEM } from "@zcode/shared/test-ids";
import {
  resolveChatErrorBannerDisplayMessage,
  shouldSuppressChatErrorBanner,
} from "@/ChatErrorBanner.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ComposerEnhancePrompt,
  type ComposerEnhancePromptHandle,
} from "@/prompt-enhancer-ui/ComposerEnhancePrompt.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { advanceComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useConversationProactiveSuggestion } from "@/v4/composer/proactive-suggestion/index.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { isMediaChatComposerAttachment } from "@/lib/chatAttachments.js";
import { resolveChatPlaceholderKey } from "@/lib/chatPlaceholder.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import {
  WORKSPACE_FILE_ADD_TO_CHAT_EVENT,
  isWorkspaceFileAddToChatEvent,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import type { ModelSelectionState } from "@/hooks/useModelSelectionView.js";
import { V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { resolveFollowupModifierTooltip } from "@/v4/composer/followupModeSettings.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { usePrimaryFollowupModifier } from "@/v4/composer/usePrimaryFollowupModifier.js";
import { type ModelSelectionSource } from "@/v4/composer/V4ComposerToolbar.js";
import { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { resolveAttachableShareContext } from "@/lib/conversationShareContext.js";
import { buildComposerRoot } from "@/v4/conversation-composer/ComposerRoot.js";
import {
  buildLeadingActions,
  buildSubmitControl,
} from "@/v4/conversation-composer/ComposerControlNodes.js";
import { buildComposerTopContent } from "@/v4/conversation-composer/ComposerTopContent.js";
import { useComposerAttachmentSurfaces } from "@/v4/conversation-composer/useComposerAttachmentSurfaces.js";
import { useComposerConfigPicker } from "@/v4/conversation-composer/useComposerConfigPicker.js";
import { useComposerDraftController } from "@/v4/conversation-composer/useComposerDraftController.js";
import { useComposerHighspeedPresentation } from "@/v4/conversation-composer/useComposerHighspeedPresentation.js";
import { useComposerSendController } from "@/v4/conversation-composer/useComposerSendController.js";
import {
  applyComposerRestoreRequestToComposer,
  applyExternalTextInsertRequestToComposer,
  restorePersistedComposerDraftIntoInput,
} from "@/v4/conversation-composer/helpers.js";
import type {
  ComposerRestoreRequest,
  ConversationComposerProps,
  ConversationComposerSendOptions,
  ConversationComposerSendResult,
  HeldQueueConfirmation,
} from "@/v4/conversation-composer/types.js";

// 公共面保持从本模块读取：SessionPane 与测试只认这一条 import 路径。
export type {
  ComposerRestoreRequest,
  ConversationComposerSendOptions,
  ConversationComposerSendResult,
} from "@/v4/conversation-composer/types.js";
export {
  applyComposerRestoreRequestToComposer,
  applyExternalTextInsertRequestToComposer,
  restorePersistedComposerDraftIntoInput,
} from "@/v4/conversation-composer/helpers.js";

const MODEL_SELECTION_LOADING_STATE: ModelSelectionState = {
  status: "loading",
};

function ConversationComposerImpl(props: ConversationComposerProps) {
  const {
    snapshot,
    sessionId = null,
    draftMode = false,
    draftConfig,
    composerDraft,
    rootDraftScopeKey,
    updateComposerContent,
    replaceComposerDraft,
    onSetComposerOrchestrationMode,
    submissionReady = true,
    layout = "stacked",
    workingDurationMs,
    disabled: disabledProp = false,
    highspeedCard = null,
    highspeedActivationCardId = null,
    onHighspeedActivationApplied,
    autoFocusEnabled = true,
    isWebRemoteControl = false,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    modelSelectionView = null,
    modelSelectionState = MODEL_SELECTION_LOADING_STATE,
    modelSelectionReload,
    modelSelectionRefresh,
    provider,
    telemetryVisible = true,
    onTextChange,
    onSelectModel,
    onSelectThought,
    onSwitchMode,
    onOpenRunningBackgroundWorks,
    backgroundWorkOpenTarget = "panel",
    runningSubagentCount = 0,
    onRecoverCustomModelSelection,
    onSendCompressionCommand,
    error,
    modelConfigTarget = "local",
    onOpenCodeViewer,
    listenAddToChatEvents = true,
    externalTextInsertRequest = null,
    onExternalTextInsertApplied,
    composerRestoreRequest = null,
    onComposerRestoreApplied,
  } = props;
  const remoteAvailable = useRemoteConversationAvailable();
  const remoteController = useOptionalRemoteWorkspaceController();
  const reconnectProject = useRemoteProjectReconnect();
  const remoteKind = useOptionalTabStore((state) =>
    state.tabs.find(
      (tab) =>
        tab.kind === "workspace" &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
          (workspaceIdentity?.trim() || workspacePath),
    ),
  );
  const [targetSelectionPending, setTargetSelectionPending] = useState(false);
  const targetSelectionPendingRef = useRef(false);
  const updateTargetSelectionPending = useCallback((pending: boolean) => {
    targetSelectionPendingRef.current = pending;
    setTargetSelectionPending(pending);
  }, []);
  const disabled = disabledProp || !remoteAvailable || targetSelectionPending;
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const conversationTelemetry = useScopedConversationTelemetrySupervisor({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
  const draftScopeId =
    sessionId ??
    (rootDraftScopeKey ? `${V4_DRAFT_SCOPE_ROOT}:${rootDraftScopeKey}` : V4_DRAFT_SCOPE_ROOT);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const configPickerScopeKey = `${workspaceKey}\0${draftScopeId}`;
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const {
    handleHighspeedModelTransitionStart,
    highspeedEntrance,
    highspeedEntranceAnimated,
    highspeedPresented,
    highspeedSweepActive,
  } = useComposerHighspeedPresentation({
    highspeedCard,
    highspeedActivationCardId,
    onHighspeedActivationApplied,
  });
  const { activeConfigPicker, handleConfigPickerOpenChange } =
    useComposerConfigPicker(configPickerScopeKey);
  const [heldQueueConfirmation, setHeldQueueConfirmation] = useState<HeldQueueConfirmation | null>(
    null,
  );
  const [sendTooltipOpen, setSendTooltipOpen] = useState(false);
  // submit 经 ref 读取最新文本/pending，避免回调随每次输入变更引用。
  const textRef = useRef("");
  const contentRevisionRef = useRef(0);
  const pendingRef = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  // 这条线断过一次：composer 原本读一个平行的 sharedContextImport prop，而 SessionPane 从没
  // 传过它（全仓 `sharedContextImport=` 零命中），于是首条消息永远不带 sharedContextRefs。
  // 现在从必然拿到的 snapshot 推导，理由与边界见 resolveAttachableShareContext。
  const activeShareContext = resolveAttachableShareContext(snapshot?.sharedContextImport);
  const pendingShareContext = activeShareContext?.status === "pending" ? activeShareContext : null;
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const commandResolutionCleanupsRef = useRef(new Set<() => void>());
  const reportedErrorKeysRef = useRef(new Set<string>());
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const primaryModifierPressed = usePrimaryFollowupModifier();
  const appleKeyboardPlatform = isAppleKeyboardPlatform();
  // Bugfix：M3 删除旧 ChatView 后，M5 只恢复了桌面端的 false 硬编码，已登记的手机远控
  // 接线没有补回，导致 Enter 误发送。恢复旧语义：手机视口下 Enter 换行并用按钮发送；
  // 桌面端仍由 resolveChatEnterSubmits 的视口门禁保持 Enter 发送。
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: isWebRemoteControl,
  });
  // 修复原因：旧 ChatView 删除后，iOS 防聚焦放大的接线没有迁到 v4 composer，
  // 手机 Web 远控输入框会重新触发 Safari 的页面缩放。
  const avoidIosInputFocusZoom = shouldAvoidIosInputFocusZoom({
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  // Bugfix：手机远控把完整能力说明放进绝对定位 placeholder 后，三行英文会越过
  // 40px 编辑区并覆盖工具栏。手机端改用短文案并限制两行；桌面端继续保留完整提示。
  const compactMobilePlaceholder = isWebRemoteControl && isMobileTextInputViewport;
  const sendShortcut = resolveChatEnterShortcut({ enterSubmits });
  const updateText = useCallback(
    (next: string) => {
      textRef.current = next;
      contentRevisionRef.current += 1;
      advanceComposerDraftRevision(workspacePath, workspaceIdentity);
      setText(next);
      onTextChange?.(next);
    },
    [onTextChange, workspaceIdentity, workspacePath],
  );

  const initialization = snapshot?.runtimeInitialization;
  const runtimeBlocked = initialization !== undefined && initialization.status !== "ready";

  const {
    attachmentPreviewIndex,
    attachmentPreviewOpen,
    attachmentPreviewTitle,
    attachmentsApi,
    clearConversationSelectionReferences,
    clearPluginUiContexts,
    clearPptxElementReferences,
    clearWebElementContexts,
    conversationSelectionLimitReason,
    conversationSelectionReferences,
    hasAttachments,
    hasConversationSelectionReferences,
    hasPluginUiContexts,
    hasPptxElementReferences,
    hasWebElementContexts,
    openPptxElementReference,
    pdfAttachmentPreview,
    pdfAttachmentPreviewOpen,
    pluginUiContexts,
    pptxElementReferences,
    removeConversationSelectionReference,
    removePluginUiContext,
    removePptxElementReference,
    removeWebElementContext,
    setAttachmentPreviewIndex,
    setAttachmentPreviewOpen,
    setPdfAttachmentPreview,
    setPdfAttachmentPreviewOpen,
    videoAttachmentPreviewTitle,
    webElementContexts,
  } = useComposerAttachmentSurfaces({
    props,
    draftScopeId,
    workspaceKey,
    disabled,
    runtimeBlocked,
    intl,
    inputApiRef,
    textRef,
    updateText,
  });
  const {
    clearCodeCommentContexts,
    codeCommentContexts,
    draftPersistTimerRef,
    draftScopeRef,
    getCodeCommentContexts,
    hasCodeCommentContexts,
    programmaticFocusRef,
    promptHistory,
    removeCodeCommentContext,
    reversePointerDeliveryRef,
    scheduleDraftPersist,
    sendTriggerRef,
    setPromptHistory,
    snapshotDraftOfEditor,
    suppressDraftPersistRef,
  } = useComposerDraftController({
    composerDraft,
    draftScopeId,
    workspacePath,
    workspaceIdentity,
    workspaceKey,
    sessionId,
    autoFocusEnabled,
    disabled,
    isMobileTextInputViewport,
    listenAddToChatEvents,
    services,
    attachmentsApi,
    webElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    conversationSelectionReferences,
    composerRestoreRequest,
    onComposerRestoreApplied,
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    updateComposerContent,
    replaceComposerDraft,
    updateText,
    intl,
    commandResolutionCleanupsRef,
    inputApiRef,
    contentRevisionRef,
    textRef,
  });

  const {
    attachmentsReady,
    canSend,
    canStop,
    handleClearQueueSend,
    handleEditorChange,
    handleEditorFocus,
    handleEditorSubmit,
    handleKeepQueueSend,
    handleModifiedEditorSubmit,
    handleSendButtonClick,
    handleStopClick,
    mode,
    modifiedEnterReversesDelivery,
    modifiedEnterSubmits,
    routingAllowsSend,
    showStopControl,
  } = useComposerSendController({
    props,
    snapshot,
    text,
    pending,
    disabled,
    runtimeBlocked,
    remoteAvailable,
    isMobileTextInputViewport,
    appleKeyboardPlatform,
    pendingShareContext,
    attachmentsApi,
    conversationTelemetry,
    codeComments: {
      contexts: codeCommentContexts,
      getContexts: getCodeCommentContexts,
      hasContexts: hasCodeCommentContexts,
      removeContext: removeCodeCommentContext,
    },
    webElements: {
      contexts: webElementContexts,
      hasContexts: hasWebElementContexts,
      removeContext: removeWebElementContext,
    },
    pluginUi: {
      contexts: pluginUiContexts,
      hasContexts: hasPluginUiContexts,
      removeContext: removePluginUiContext,
    },
    pptxReferences: {
      references: pptxElementReferences,
      hasReferences: hasPptxElementReferences,
      removeReference: removePptxElementReference,
    },
    conversationSelections: {
      references: conversationSelectionReferences,
      removeReference: removeConversationSelectionReference,
    },
    hasConversationSelectionReferences,
    hasAttachments,
    heldQueueConfirmation,
    scheduleDraftPersist,
    snapshotDraftOfEditor,
    updateText,
    setHeldQueueConfirmation,
    setPending,
    setPromptHistory,
    setSendTooltipOpen,
    programmaticFocusRef,
    reversePointerDeliveryRef,
    sendTriggerRef,
    textRef,
    snapshotRef,
    contentRevisionRef,
    commandResolutionCleanupsRef,
    inputApiRef,
    draftScopeRef,
    draftPersistTimerRef,
    suppressDraftPersistRef,
    targetSelectionPendingRef,
    pendingRef,
  });

  // ── 「加入对话」全局事件（workspace file tree 右键/按钮）→ mention 插入 ──
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }
    const handleWorkspaceFileAddToChat = (event: Event) => {
      if (!isWorkspaceFileAddToChatEvent(event)) {
        return;
      }
      event.preventDefault();
      appendWorkspaceFileMentionToComposer({
        inputApiRef,
        currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
        payload: event.detail,
        workspacePath,
        workspaceIdentity,
        onTextChange: updateText,
      });
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    return () => {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handleWorkspaceFileAddToChat);
    };
  }, [listenAddToChatEvents, updateText, workspaceIdentity, workspacePath]);

  // 动态 placeholder（旧 chatViewPlaceholder 语义）：无历史 → newTask；
  // 有历史空闲 → followUpAsk；有历史处理中 → followUpQueue；
  // 完整视图浮窗（单行）运行中 → 「工作中 {时长}」，与流式消息同值同格式。
  const workingDurationLabel =
    layout === "inline" && canStop
      ? formatConversationWorkDuration(workingDurationMs, intl, locale)
      : null;
  const normalPlaceholder = workingDurationLabel
    ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: workingDurationLabel })
    : intl.formatMessage({
        id: resolveChatPlaceholderKey({
          hasHistoryMessages: (snapshot?.rows.totalCount ?? 0) > 0,
          isTaskProcessing: canStop,
          // 单行输入框放不下完整的新任务提示，沿用手机远控的短文案。
          compactNewTask: compactMobilePlaceholder || layout === "inline",
        }),
      });
  const sendTooltipTitle = intl.formatMessage({
    id: mode === "enqueue" ? "chat.queue.enqueue" : "chat.send",
  });
  const modifierTooltip = resolveFollowupModifierTooltip({
    enabled: modifiedEnterReversesDelivery,
    canSend,
    modifierPressed: primaryModifierPressed,
    followupMode: snapshot?.config.followupMode,
    isApplePlatform: appleKeyboardPlatform,
  });
  const resolvedSendTooltipTitle = modifierTooltip
    ? intl.formatMessage({ id: modifierTooltip.titleId })
    : sendTooltipTitle;
  const resolvedSendTooltipShortcut = modifierTooltip?.shortcut ?? sendShortcut;
  const stopTooltipTitle = intl.formatMessage({ id: "chat.stop" });
  const visibleError = error && !shouldSuppressChatErrorBanner(error) ? error : null;

  useEffect(() => {
    if (!visibleError || !conversationTelemetry || !telemetryVisible) return;
    const telemetryKey = [
      visibleError.taskId ?? sessionId ?? "",
      visibleError.code ?? "",
      visibleError.traceId ?? "",
      visibleError.message,
    ].join(":");
    if (reportedErrorKeysRef.current.has(telemetryKey)) return;
    reportedErrorKeysRef.current.add(telemetryKey);
    // 错误只有经过 suppression 后真实进入 render 才曝光；同一 composer mount 相同 key 一次。
    conversationTelemetry.reportVisibleChatError({
      errorKey: telemetryKey,
      displayMessage: resolveChatErrorBannerDisplayMessage(visibleError, intl),
      error: visibleError,
    });
  }, [conversationTelemetry, intl, sessionId, telemetryVisible, visibleError]);

  const attachmentAction = useMemo(
    () => ({
      label: intl.formatMessage({ id: "chat.composer.attachment" }),
      menuItemTestId: TID_CHAT_ATTACHMENT_MENU_ITEM,
      onSelect: () =>
        runUserAction({
          input: {
            featureId: "conversation.composer.attachment",
            action: "add",
            trigger: "button",
          },
          operation: attachmentsApi.openAttachmentPicker,
          completed: { resultSource: "local_commit" },
          failureStage: "attachment_picker",
        }),
      testId: TID_CHAT_ATTACHMENT_BUTTON,
    }),
    [intl, attachmentsApi.openAttachmentPicker],
  );

  // ── 附件预览网格 ──
  const composerAttachments = attachmentsApi.attachments;
  const orderedComposerAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: (typeof composerAttachments)[number][] = [];
    const files: (typeof composerAttachments)[number][] = [];
    for (const attachment of composerAttachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [composerAttachments]);
  const composerMediaPreviewItems = useMemo(
    () =>
      composerAttachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [composerAttachments],
  );
  const topContentNode = useMemo(() => {
    return buildComposerTopContent({
      attachmentsApi,
      composerAttachments,
      orderedComposerAttachments,
      composerMediaPreviewItems,
      attachmentPreviewTitle,
      videoAttachmentPreviewTitle,
      codeCommentContexts,
      removeCodeCommentContext,
      clearCodeCommentContexts,
      webElementContexts,
      removeWebElementContext,
      clearWebElementContexts,
      pluginUiContexts,
      removePluginUiContext,
      clearPluginUiContexts,
      pptxElementReferences,
      removePptxElementReference,
      clearPptxElementReferences,
      conversationSelectionReferences,
      removeConversationSelectionReference,
      clearConversationSelectionReferences,
      openPptxElementReference,
      onOpenCodeViewer,
      intl,
      locale,
      setAttachmentPreviewIndex,
      setAttachmentPreviewOpen,
      setPdfAttachmentPreview,
      setPdfAttachmentPreviewOpen,
    });
  }, [
    attachmentPreviewTitle,
    attachmentsApi,
    clearCodeCommentContexts,
    clearConversationSelectionReferences,
    clearWebElementContexts,
    clearPluginUiContexts,
    clearPptxElementReferences,
    codeCommentContexts,
    composerAttachments,
    composerMediaPreviewItems,
    orderedComposerAttachments,
    intl,
    locale,
    removeCodeCommentContext,
    removeConversationSelectionReference,
    removeWebElementContext,
    removePluginUiContext,
    removePptxElementReference,
    conversationSelectionReferences,
    pendingShareContext,
    webElementContexts,
    pluginUiContexts,
    pptxElementReferences,
    onOpenCodeViewer,
    openPptxElementReference,
  ]);

  // Проактивная подсказка следующей задачи: адаптер владеет ленивым контекстом,
  // turn identity, контейнером и принятием; композер передаёт только зависимости.
  const proactive = useConversationProactiveSuggestion({
    composer: props,
    draft: text,
    disabled,
    inputApiRef,
    updateText,
    scheduleDraftPersist,
    topContentNode,
  });

  // 发送/停止控制簇（对齐旧 ChatViewComposer.submitControlNode 结构：
  // 左侧 model/thought/usage 簇 + 右侧 stop 或 send）。
  // useMemo：composer 随流式 snapshot 高频重渲染，控制簇只在语义依赖变化时重建，
  // 避免每个 token 批次都重建 Tooltip/Select 子树。
  const composerUsage = snapshot?.usage ?? null;
  const composerPhase = snapshot?.control.phase ?? null;
  const handleSelectModelTrace = useCallback(
    (
      nextProvider: string,
      nextModel: string,
      sourceModel: ModelSelectionSource | null,
      reasoningLevel?: string,
    ) =>
      runUserAction({
        input: {
          featureId: "conversation.composer.config",
          action: "change_model",
          trigger: "select",
        },
        operation: () =>
          reasoningLevel === undefined
            ? onSelectModel(nextProvider, nextModel, sourceModel)
            : onSelectModel(nextProvider, nextModel, sourceModel, reasoningLevel),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "model_change",
      }),
    [onSelectModel],
  );
  // `Enhance Prompt`: один владелец запроса на композер — кнопка и `/enhance`
  // вызывают его через ref, поэтому не может быть двух параллельных улучшений.
  const enhancePromptRef = useRef<ComposerEnhancePromptHandle | null>(null);
  const enhancePromptNode = useMemo(
    () => (
      <ComposerEnhancePrompt
        ref={enhancePromptRef}
        workspacePath={workspacePath}
        {...(workspaceIdentity ? { workspaceIdentity } : {})}
        sessionId={sessionId ?? null}
        draftText={text}
        disabled={disabled || runtimeBlocked || pending}
        inputApiRef={inputApiRef}
        updateText={updateText}
        scheduleDraftPersist={scheduleDraftPersist}
      />
    ),
    [
      disabled,
      inputApiRef,
      pending,
      runtimeBlocked,
      scheduleDraftPersist,
      sessionId,
      text,
      updateText,
      workspaceIdentity,
      workspacePath,
    ],
  );
  // `/enhance` живёт рядом с кнопкой и дергает тот же владелец запроса.
  // CLI catalog остаётся авторитетом: команда добавляется только если CLI её не объявил.
  const appSlashCommandsWithEnhance = useMemo<readonly AppSlashCommand[]>(() => {
    const base = props.appSlashCommands ?? [];
    if (base.some((command) => command.value === "enhance")) return base;
    return [
      ...base,
      {
        value: "enhance",
        label: intl.formatMessage({ id: "chat.slash.app.enhance.label" }),
        description: intl.formatMessage({ id: "chat.slash.app.enhance.description" }),
        keywords: ["enhance", "improve", "улучшить", "промпт", "优化", "提示词"],
        run: () => enhancePromptRef.current?.trigger(),
      },
    ];
  }, [intl, props.appSlashCommands]);
  const submitControlNode = useMemo(
    () =>
      buildSubmitControl({
        props,
        intl,
        remoteAvailable,
        isMobileTextInputViewport,
        modelSelectionState,
        composerPhase,
        composerUsage,
        composerDraft,
        disabled,
        runtimeBlocked,
        pending,
        highspeedCard,
        highspeedEntranceAnimated,
        highspeedPresented,
        highspeedSweepActive,
        activeConfigPicker,
        handleConfigPickerOpenChange,
        handleSelectModelTrace,
        showStopControl,
        stopTooltipTitle,
        handleStopClick,
        resolvedSendTooltipTitle,
        resolvedSendTooltipShortcut,
        modifierTooltip,
        sendTooltipOpen,
        setSendTooltipOpen,
        canSend,
        handleSendButtonClick,
        enhancePromptNode,
      }),
    [
      canSend,
      activeConfigPicker,
      composerPhase,
      composerUsage,
      composerDraft.orchestrationMode,
      disabled,
      runtimeBlocked,
      draftConfig,
      draftMode,
      enhancePromptNode,
      handleStopClick,
      handleSendButtonClick,
      handleConfigPickerOpenChange,
      highspeedCard,
      highspeedEntranceAnimated,
      highspeedPresented,
      highspeedSweepActive,
      isWebRemoteControl,
      mode,
      handleSelectModelTrace,
      modelSelectionReload,
      modelSelectionRefresh,
      modelSelectionState,
      modelSelectionView,
      onSelectThought,
      onSetComposerOrchestrationMode,
      onRecoverCustomModelSelection,
      onSendCompressionCommand,
      onSwitchMode,
      pending,
      provider,
      modifierTooltip,
      resolvedSendTooltipShortcut,
      resolvedSendTooltipTitle,
      sendTooltipOpen,
      remoteAvailable,
      sendShortcut,
      sendTooltipTitle,
      sessionId,
      showStopControl,
      stopTooltipTitle,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // 左下：模式选择 + CUA 入口 + 当前 session 后台任务入口。followupMode 由 app 设置页同步到 CLI，
  // 不在 composer 暴露局部开关；后台入口只消费同一 snapshot，不维护第二份任务状态。
  const leadingActionsNode = useMemo(
    () =>
      buildLeadingActions({
        props,
        disabled,
        runtimeBlocked,
        activeConfigPicker,
        handleConfigPickerOpenChange,
        canStop,
        backgroundWorks: snapshot?.backgroundWorks ?? [],
      }),
    [
      activeConfigPicker,
      canStop,
      disabled,
      runtimeBlocked,
      draftConfig,
      handleConfigPickerOpenChange,
      isWebRemoteControl,
      backgroundWorkOpenTarget,
      onOpenRunningBackgroundWorks,
      onSwitchMode,
      provider,
      remoteSessionId,
      runningSubagentCount,
      snapshot?.backgroundWorks,
      workspaceIdentity,
      workspacePath,
    ],
  );
  return buildComposerRoot({
    props,
    attachmentsApi,
    mode,
    visibleError,
    intl,
    initialization,
    pending,
    disabled,
    runtimeBlocked,
    remoteAvailable,
    routingAllowsSend,
    attachmentsReady,
    submissionReady,
    hasCodeCommentContexts,
    hasAttachments,
    hasWebElementContexts,
    hasPptxElementReferences,
    hasConversationSelectionReferences,
    hasPluginUiContexts,
    enterSubmits,
    modifiedEnterSubmits,
    sendTooltipTitle,
    normalPlaceholder,
    avoidIosInputFocusZoom,
    compactMobilePlaceholder,
    conversationSelectionLimitReason,
    ...proactive,
    attachmentAction,
    leadingActionsNode,
    submitControlNode,
    appSlashCommandsOverride: appSlashCommandsWithEnhance,
    composerMediaPreviewItems,
    attachmentPreviewIndex,
    attachmentPreviewOpen,
    setAttachmentPreviewOpen,
    pdfAttachmentPreview,
    pdfAttachmentPreviewOpen,
    setPdfAttachmentPreview,
    setPdfAttachmentPreviewOpen,
    heldQueueConfirmation,
    setHeldQueueConfirmation,
    pendingRef,
    handleClearQueueSend,
    handleKeepQueueSend,
    handleEditorChange,
    handleEditorFocus,
    handleEditorSubmit,
    handleModifiedEditorSubmit,
    inputApiRef,
    promptHistory,
    workspaceKey,
    modelConfigTarget,
    highspeedCard,
    highspeedEntrance,
    highspeedEntranceAnimated,
    highspeedPresented,
    handleHighspeedModelTransitionStart,
    updateTargetSelectionPending,
    remoteKind,
    reconnectProject,
    remoteController,
  });
}

export const ConversationComposer = memo(ConversationComposerImpl);
