import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import { useCallback, useEffect } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  resolveOppositeFollowupDelivery,
  shouldEnableModifiedEnterSubmit,
  shouldReverseFollowupDeliveryForPointer,
} from "@/v4/composer/followupModeSettings.js";
import type { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import type { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import type { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import type { usePluginUiModelContexts } from "@/plugin-ui/index.js";
import type { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import type { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { runComposerSubmit } from "./composerSubmit.js";
import type { ConversationComposerProps, HeldQueueConfirmation } from "./types.js";

/**
 * 发送状态机与编辑器事件入口。
 *
 * `canSend` / Stop 切换 / 草稿占用态上报都从同一份派生状态读取；
 * `submit` 的实现放在 composerSubmit.ts，这里只负责把组件闭包交给它。
 */

type AttachmentsApi = ReturnType<typeof useComposerAttachments>;
type CodeComments = ReturnType<typeof useCodeCommentContexts>;
type WebElements = ReturnType<typeof useWebElementContexts>;
type PluginUiContexts = ReturnType<typeof usePluginUiModelContexts>;
type PptxReferences = ReturnType<typeof usePptxElementReferences>;
type ConversationSelections = ReturnType<typeof useConversationSelectionReferences>;
type ConversationTelemetry = ReturnType<typeof useScopedConversationTelemetrySupervisor>;

/** `resolveAttachableShareContext` 命中的待发送分享上下文。 */
interface PendingShareContext {
  contextId: string;
  title: string;
  shareUrl: string;
  status: string;
}

export interface ComposerSendControllerInput {
  props: ConversationComposerProps;
  snapshot: ConversationSnapshot | null;
  text: string;
  pending: boolean;
  disabled: boolean;
  runtimeBlocked: boolean;
  remoteAvailable: boolean;
  isMobileTextInputViewport: boolean;
  appleKeyboardPlatform: boolean;
  pendingShareContext: PendingShareContext | null;
  attachmentsApi: AttachmentsApi;
  conversationTelemetry: ConversationTelemetry;
  codeComments: Pick<CodeComments, "contexts" | "hasContexts" | "getContexts" | "removeContext">;
  webElements: Pick<WebElements, "contexts" | "hasContexts" | "removeContext">;
  pluginUi: Pick<PluginUiContexts, "contexts" | "hasContexts" | "removeContext">;
  pptxReferences: Pick<PptxReferences, "references" | "hasReferences" | "removeReference">;
  conversationSelections: Pick<ConversationSelections, "references" | "removeReference">;
  hasConversationSelectionReferences: boolean;
  hasAttachments: boolean;
  heldQueueConfirmation: HeldQueueConfirmation | null;
  scheduleDraftPersist: () => void;
  snapshotDraftOfEditor: () => Omit<V4ComposerDraft, "updatedAt">;
  updateText: (text: string) => void;
  setHeldQueueConfirmation: Dispatch<SetStateAction<HeldQueueConfirmation | null>>;
  setPending: Dispatch<SetStateAction<boolean>>;
  setPromptHistory: Dispatch<SetStateAction<readonly string[]>>;
  setSendTooltipOpen: Dispatch<SetStateAction<boolean>>;
  programmaticFocusRef: MutableRefObject<boolean>;
  reversePointerDeliveryRef: MutableRefObject<boolean>;
  sendTriggerRef: MutableRefObject<"button" | "shortcut">;
  textRef: MutableRefObject<string>;
  snapshotRef: MutableRefObject<ConversationSnapshot | null>;
  contentRevisionRef: MutableRefObject<number>;
  commandResolutionCleanupsRef: MutableRefObject<Set<() => void>>;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  draftScopeRef: MutableRefObject<string>;
  draftPersistTimerRef: MutableRefObject<number | null>;
  suppressDraftPersistRef: MutableRefObject<boolean>;
  targetSelectionPendingRef: MutableRefObject<boolean>;
  pendingRef: MutableRefObject<boolean>;
}

export function useComposerSendController(input: ComposerSendControllerInput) {
  const {
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
    codeComments,
    webElements,
    pluginUi,
    pptxReferences,
    conversationSelections,
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
  } = input;
  const {
    createSubmissionFromComposer,
    draftConfig,
    draftMode = false,
    isWebRemoteControl = false,
    modelSelectionView = null,
    onDraftStateChange,
    onSendText,
    onSetComposerOrchestrationMode,
    onStop,
    provider,
    readPlanIdentitySnapshot,
    sessionId = null,
    submissionReady = true,
    telemetryDraftConfig,
    updateComposerContent,
    workspaceIdentity,
    workspacePath,
  } = input.props;

  const hasCodeCommentContexts = codeComments.hasContexts;
  const getCodeCommentContexts = codeComments.getContexts;
  const removeCodeCommentContext = codeComments.removeContext;
  const hasWebElementContexts = webElements.hasContexts;
  const webElementContexts = webElements.contexts;
  const removeWebElementContext = webElements.removeContext;
  const hasPptxElementReferences = pptxReferences.hasReferences;
  const pptxElementReferences = pptxReferences.references;
  const removePptxElementReference = pptxReferences.removeReference;
  const removeConversationSelectionReference = conversationSelections.removeReference;
  const hasPluginUiContexts = pluginUi.hasContexts;
  const removePluginUiContext = pluginUi.removeContext;
  const pluginUiContexts = pluginUi.contexts;
  const conversationSelectionReferences = conversationSelections.references;
  const mode = snapshot?.inputRouting.mode ?? "startNow";
  const modifiedEnterSubmits = shouldEnableModifiedEnterSubmit({
    inputRoutingMode: mode,
    isMobileTextInputViewport,
    isWebRemoteControl,
  });
  const canStop = Boolean(snapshot?.control.canStop);
  const modifiedEnterReversesDelivery = modifiedEnterSubmits && canStop;
  const hasText = text.trim().length > 0;
  const hasDraftToSubmit =
    hasText ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  const hasComposerDraftContent =
    text.length > 0 ||
    hasAttachments ||
    hasCodeCommentContexts ||
    hasWebElementContexts ||
    hasPptxElementReferences ||
    hasConversationSelectionReferences ||
    hasPluginUiContexts ||
    Boolean(pendingShareContext);
  useEffect(() => {
    onDraftStateChange?.({
      hasContent: hasComposerDraftContent,
      busy: pending,
    });
  }, [hasComposerDraftContent, onDraftStateChange, pending]);
  // choice 保留正常发送按钮；提交后由 SessionPane 按 slash 语义决定是否弹确认框。
  // V4 重构时把 guide 当成“不可提交”状态，导致按钮和 Enter 同时失效；
  // guide 是 CLI 已授权的 busy 输入路由，是否最终 steer 或回退 queue 由命令层裁决。
  const routingAllowsSend = draftMode || (snapshot !== null && mode !== "reject");
  const attachmentsReady = !attachmentsApi.hasUnreadyAttachments;
  const canSend =
    !disabled &&
    !pending &&
    hasDraftToSubmit &&
    routingAllowsSend &&
    attachmentsReady &&
    submissionReady &&
    !runtimeBlocked;
  // 旧 UI 状态机：streaming + 空草稿 → Stop；有草稿 → 发送键（入队）。
  const showStopControl = canStop && !hasDraftToSubmit;

  useEffect(() => {
    if (!canSend) setSendTooltipOpen(false);
  }, [canSend]);

  const submit = useCallback(
    (
      heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
      expectedHeldQueueItemIds?: readonly string[],
      existingTelemetrySeed?: ConversationPromptTelemetrySeed,
      requestedDelivery?: "startNow" | "queue" | "guide",
    ) =>
      runComposerSubmit(
        {
          attachmentsApi,
          conversationSelectionReferences,
          conversationTelemetry,
          createSubmissionFromComposer,
          draftConfig,
          getCodeCommentContexts,
          modelSelectionView,
          onSendText,
          onSetComposerOrchestrationMode,
          pendingShareContext,
          pluginUiContexts,
          pptxElementReferences,
          provider,
          readPlanIdentitySnapshot,
          removeCodeCommentContext,
          removeConversationSelectionReference,
          removePluginUiContext,
          removePptxElementReference,
          removeWebElementContext,
          remoteAvailable,
          runtimeBlocked,
          sessionId,
          snapshotDraftOfEditor,
          submissionReady,
          telemetryDraftConfig,
          updateComposerContent,
          updateText,
          webElementContexts,
          workspaceIdentity,
          workspacePath,
          commandResolutionCleanupsRef,
          contentRevisionRef,
          draftPersistTimerRef,
          draftScopeRef,
          inputApiRef,
          pendingRef,
          sendTriggerRef,
          setHeldQueueConfirmation,
          setPending,
          setPromptHistory,
          snapshotRef,
          suppressDraftPersistRef,
          targetSelectionPendingRef,
          textRef,
        },
        heldQueueDisposition,
        expectedHeldQueueItemIds,
        existingTelemetrySeed,
        requestedDelivery,
      ),
    [
      attachmentsApi,
      conversationSelectionReferences,
      conversationTelemetry,
      draftConfig,
      createSubmissionFromComposer,
      submissionReady,
      remoteAvailable,
      runtimeBlocked,
      getCodeCommentContexts,
      telemetryDraftConfig,
      modelSelectionView,
      onSendText,
      onSetComposerOrchestrationMode,
      pendingShareContext,
      provider,
      readPlanIdentitySnapshot,
      removeCodeCommentContext,
      removeConversationSelectionReference,
      removePptxElementReference,
      removeWebElementContext,
      removePluginUiContext,
      pluginUiContexts,
      sessionId,
      snapshotDraftOfEditor,
      updateText,
      updateComposerContent,
      webElementContexts,
      pptxElementReferences,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // Lexical onChange（首字符也稳定回传，见 LexicalChatInput.TextContentPlugin）。
  const handleEditorChange = useCallback(
    (value: string) => {
      conversationTelemetry?.recordComposerTextChange(value);
      updateText(value);
      // 正文先进入与 mode/model 相同的内存 Draft；防抖只负责补充最新 Lexical JSON。
      updateComposerContent({ text: value });
      scheduleDraftPersist();
    },
    [conversationTelemetry, scheduleDraftPersist, updateComposerContent, updateText],
  );

  const handleEditorFocus = useCallback(() => {
    conversationTelemetry?.recordComposerFocus();
    // 程序性聚焦不算「点击输入框」；标记一次性消费，之后的手动 focus 照常上报。
    if (programmaticFocusRef.current) {
      programmaticFocusRef.current = false;
      return;
    }
    conversationTelemetry?.recordComposerFocusClick({
      sessionId: sessionId ?? null,
    });
  }, [conversationTelemetry, sessionId]);

  // 编辑器提交（Enter / 发送键 form submit 同路径）。返回 false：编辑器不自行 reset，
  // 由 submit 成功后经 inputApiRef.clear() 清空——失败时草稿留在输入框。
  const handleEditorSubmit = useCallback(
    (value: string) => {
      textRef.current = value;
      const reverseDelivery = reversePointerDeliveryRef.current;
      reversePointerDeliveryRef.current = false;
      const followupMode = snapshotRef.current?.config.followupMode;
      void submit(
        undefined,
        undefined,
        undefined,
        reverseDelivery && followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleModifiedEditorSubmit = useCallback(
    (value: string) => {
      const followupMode = snapshotRef.current?.config.followupMode;
      textRef.current = value;
      // inputRouting 在 turn 启动初期可能仍为 startNow，不能用它
      // 推断空闲。组合键始终表达单次反向 delivery；空闲时 CLI 自然 startNow。
      void submit(
        undefined,
        undefined,
        undefined,
        followupMode ? resolveOppositeFollowupDelivery(followupMode) : undefined,
      );
      return false;
    },
    [submit],
  );

  const handleClearQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "clearQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleKeepQueueSend = useCallback(() => {
    if (!heldQueueConfirmation) return;
    void submit(
      "keepQueueAndSend",
      heldQueueConfirmation.queueItemIds,
      heldQueueConfirmation.telemetrySeed,
      heldQueueConfirmation.requestedDelivery,
    );
  }, [heldQueueConfirmation, submit]);

  const handleStopClick = useCallback(() => {
    runUserAction({
      input: {
        featureId: "conversation.composer.message",
        action: "stop",
        trigger: "button",
      },
      operation: onStop,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "stop_generation",
    });
  }, [onStop]);

  // 发送键是 type="submit"，与 Enter 共用 handleEditorSubmit；DOM 事件顺序保证 click 早于
  // submit，故这里只置标记，由 submit() 读取并复位。
  const handleSendButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      sendTriggerRef.current = "button";
      reversePointerDeliveryRef.current = shouldReverseFollowupDeliveryForPointer({
        enabled: modifiedEnterReversesDelivery,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isApplePlatform: appleKeyboardPlatform,
      });
    },
    [appleKeyboardPlatform, modifiedEnterReversesDelivery],
  );

  return {
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
    submit,
  };
}
