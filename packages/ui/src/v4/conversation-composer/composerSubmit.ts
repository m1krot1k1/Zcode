import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ModelSelectionView } from "@zcode/services";
import type { ZCodeProvider } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { appendPromptHistoryEntry } from "@/lib/promptHistory.js";
import {
  persistPromptHistoryEntries,
  readPromptHistoryEntries,
} from "@/lib/promptHistoryStorage.js";
import { resolveProviderBaseURL } from "@/lib/registryProviderView.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { trackUnsettledComposerSubmission } from "@/v4/composer/composerSubmissionSettlement.js";
import {
  countComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import type { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import type { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import type { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import type { usePluginUiModelContexts } from "@/plugin-ui/index.js";
import type { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import type { useScopedConversationTelemetrySupervisor } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { arePromptHistoryEntriesEqual } from "./helpers.js";
import type { ConversationComposerProps, HeldQueueConfirmation } from "./types.js";

/**
 * 发送链路的 renderer 侧实现。
 *
 * 拆出组件是为了把「发送状态机」（预传门禁 / 遥测配对 / 草稿占用与回滚 / 队列确认）
 * 留在单一所有者里；所有入参都由 `ConversationComposer` 的闭包原样传入，
 * 依赖收集仍在组件的 useCallback 上完成。
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

export interface ComposerSubmitContext {
  attachmentsApi: AttachmentsApi;
  conversationSelectionReferences: ConversationSelections["references"];
  conversationTelemetry: ConversationTelemetry;
  createSubmissionFromComposer: ConversationComposerProps["createSubmissionFromComposer"];
  draftConfig: ConversationComposerProps["draftConfig"];
  getCodeCommentContexts: CodeComments["getContexts"];
  modelSelectionView: ModelSelectionView | null;
  onSendText: ConversationComposerProps["onSendText"];
  onSetComposerOrchestrationMode: ConversationComposerProps["onSetComposerOrchestrationMode"];
  pendingShareContext: PendingShareContext | null;
  pluginUiContexts: PluginUiContexts["contexts"];
  pptxElementReferences: PptxReferences["references"];
  provider: ZCodeProvider | undefined;
  readPlanIdentitySnapshot: ConversationComposerProps["readPlanIdentitySnapshot"];
  removeCodeCommentContext: CodeComments["removeContext"];
  removeConversationSelectionReference: ConversationSelections["removeReference"];
  removePluginUiContext: PluginUiContexts["removeContext"];
  removePptxElementReference: PptxReferences["removeReference"];
  removeWebElementContext: WebElements["removeContext"];
  remoteAvailable: boolean;
  runtimeBlocked: boolean;
  sessionId: string | null;
  snapshotDraftOfEditor: () => Omit<V4ComposerDraft, "updatedAt">;
  submissionReady: boolean;
  telemetryDraftConfig: ConversationComposerProps["telemetryDraftConfig"];
  updateComposerContent: ConversationComposerProps["updateComposerContent"];
  updateText: (text: string) => void;
  webElementContexts: WebElements["contexts"];
  workspaceIdentity: string | undefined;
  workspacePath: string;
  commandResolutionCleanupsRef: MutableRefObject<Set<() => void>>;
  contentRevisionRef: MutableRefObject<number>;
  draftPersistTimerRef: MutableRefObject<number | null>;
  draftScopeRef: MutableRefObject<string>;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  pendingRef: MutableRefObject<boolean>;
  sendTriggerRef: MutableRefObject<"button" | "shortcut">;
  setHeldQueueConfirmation: Dispatch<SetStateAction<HeldQueueConfirmation | null>>;
  setPending: Dispatch<SetStateAction<boolean>>;
  setPromptHistory: Dispatch<SetStateAction<readonly string[]>>;
  snapshotRef: MutableRefObject<ConversationSnapshot | null>;
  suppressDraftPersistRef: MutableRefObject<boolean>;
  targetSelectionPendingRef: MutableRefObject<boolean>;
  textRef: MutableRefObject<string>;
}

/**
 * 提交当前 composer 内容。
 *
 * 返回值语义与 `onSendText` 一致（`sent | blocked | confirmationRequired | void`）；
 * 失败与重试都由调用方读取权威投影后的状态机决定，这里只负责一次提交生命周期。
 */
export async function runComposerSubmit(
  ctx: ComposerSubmitContext,
  heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend",
  expectedHeldQueueItemIds?: readonly string[],
  existingTelemetrySeed?: ConversationPromptTelemetrySeed,
  requestedDelivery?: "startNow" | "queue" | "guide",
): Promise<void> {
  const {
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
  } = ctx;
  const trimmed = textRef.current.trim();
  // 与组件内的身份 key 同一规则；发送时冻结，避免首发 promotion 后读到新 scope。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const submittedQueueItemIds =
    snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
  const hasPendingAttachments = attachmentsApi.attachments.length > 0;
  const currentCodeCommentContexts = getCodeCommentContexts();
  const hasPendingCodeCommentContexts = currentCodeCommentContexts.length > 0;
  const currentWebElementContexts = webElementContexts;
  const hasPendingWebElementContexts = currentWebElementContexts.length > 0;
  const currentPluginUiContexts = pluginUiContexts;
  const hasPendingPluginUiContexts = currentPluginUiContexts.length > 0;
  const currentPptxElementReferences = pptxElementReferences;
  const hasPendingPptxElementReferences = currentPptxElementReferences.length > 0;
  const currentConversationSelections = conversationSelectionReferences;
  const hasPendingConversationSelections = currentConversationSelections.length > 0;
  const submittedShareContext = pendingShareContext;
  // 草稿首发 accepted 后同一 composer 会原地从 __draft__ promotion 到
  // session scope；若成功清理时再读可变 ref，会误清新 scope，并把首条输入残留在
  // __draft__，下次新建任务又恢复。发送开始时冻结真正提交的 scope。
  const submittedDraft = snapshotDraftOfEditor();
  const submittedScopeKey = `${workspaceKey}\0${draftScopeRef.current}`;
  let cleanupRevision = contentRevisionRef.current;
  const submission = createSubmissionFromComposer?.() ?? null;
  const submittedAttachmentIds = attachmentsApi.attachments.map((item) => item.id);
  if (
    (!trimmed &&
      !hasPendingAttachments &&
      !hasPendingCodeCommentContexts &&
      !hasPendingWebElementContexts &&
      !hasPendingPptxElementReferences &&
      !hasPendingConversationSelections &&
      !hasPendingPluginUiContexts &&
      !submittedShareContext) ||
    pendingRef.current ||
    targetSelectionPendingRef.current ||
    !remoteAvailable ||
    !submissionReady ||
    runtimeBlocked ||
    (createSubmissionFromComposer !== undefined && submission === null) ||
    attachmentsApi.hasUnreadyAttachments
  ) {
    return;
  }
  const sendAction = startUserAction({
    featureId: "conversation.composer.message",
    action: "send",
    trigger: sendTriggerRef.current === "button" ? "button" : "shortcut",
    workspaceKind: workspaceIdentity?.trim() ? "remote" : "local",
  });
  pendingRef.current = true;
  setPending(true);
  // Bug 根因：草稿 intent 只保存用户显式改动，正常继承模型位于冻结初始化 config。
  // prewarm snapshot 尚未到达时若只读 draftConfig，send_btn 会错误落成空模型/glm。
  const telemetryConfig = telemetryDraftConfig ?? snapshotRef.current?.config ?? draftConfig;
  let telemetrySeed: ConversationPromptTelemetrySeed;
  if (existingTelemetrySeed) {
    // 队列二次确认复用首次点击的 seed：不重报 send_click，也不重置发送触发来源，
    // 保证 send_click 与 send_result 严格 1:1。
    telemetrySeed = existingTelemetrySeed;
    if (telemetrySeed.localTtft)
      getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, false);
  } else {
    const freshSeed: ConversationPromptTelemetrySeed = {
      sendTime: Date.now(),
      localTtft: !workspaceIdentity?.trim()
        ? getLocalTtftObserver()?.start(
            workspacePath,
            (snapshotRef.current !== null &&
              snapshotRef.current.inputRouting.mode !== "startNow") ||
              false,
            trimmed.startsWith("/"),
          )
        : undefined,
      extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
        askMode: telemetryConfig?.mode,
        modelName: telemetryConfig?.model,
        configProvider: telemetryConfig?.provider,
        agentProvider: provider,
        providerBaseURL: resolveProviderBaseURL(telemetryConfig?.provider, modelSelectionView),
        planIdentitySnapshot: readPlanIdentitySnapshot?.(),
      }),
    };
    const sendTrigger = sendTriggerRef.current;
    sendTriggerRef.current = "shortcut";
    // recordSendClick 回填 sendClickId，必须用它的返回值作为后续 seed，
    // 否则落定时拿不到关联键，send_result 会被当成后台任务跳过。
    telemetrySeed =
      conversationTelemetry?.recordSendClick({
        sessionId: sessionId ?? null,
        seed: freshSeed,
        trigger: sendTrigger,
      }) ?? freshSeed;
  }
  let promptHistoryBeforeSend: readonly string[] | null = null;
  let promptHistoryAfterAppend: readonly string[] | null = null;
  let promptHistoryWasPersisted = false;
  let draftSubmissionClaimed = false;
  let editorClearedOptimistically = false;
  let submittedCommandId: string | null = null;
  let submittedCommandResolved = false;
  const claimSubmittedDraft = () => {
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
      draftPersistTimerRef.current = null;
    }
    // 首发 promotion 会在 onSendText 返回前切换 scope 或重建 Composer。
    // 若仍允许旧 scope effect 落盘，新 Composer 会把已经发送的正文当草稿恢复。
    // 提交前先占用并隐藏该草稿；失败路径再恢复，避免用等待时间掩盖竞态。
    suppressDraftPersistRef.current = true;
    updateComposerContent({ text: "" });
    draftSubmissionClaimed = true;
  };
  const restoreSubmittedDraft = () => {
    if (!draftSubmissionClaimed) return;
    // 用户在等待期间已经产生更新时，当前完整正文是更新后的事实；旧失败回包不能覆盖。
    if (contentRevisionRef.current === cleanupRevision) {
      updateComposerContent(submittedDraft);
      if (submittedDraft.orchestrationMode === "swarm") onSetComposerOrchestrationMode?.(true);
      if (submittedCommandId && !submittedCommandResolved) {
        // 传输层失败不等于 CLI 未 admission（ACK 丢失即如此）。正文虽已恢复回草稿，
        // 该 command 仍待权威结论；登记到模块级账本，让卸载重挂后的 composer 也能收口。
        trackUnsettledComposerSubmission(submittedScopeKey, {
          commandId: submittedCommandId,
          text: submittedDraft.text,
        });
      }
    }
    suppressDraftPersistRef.current = false;
    draftSubmissionClaimed = false;
    if (editorClearedOptimistically && contentRevisionRef.current === cleanupRevision) {
      if (submittedDraft.editorStateJson) {
        inputApiRef.current?.setEditorStateJson(submittedDraft.editorStateJson);
      } else {
        inputApiRef.current?.setText(submittedDraft.text);
      }
      updateText(submittedDraft.text);
      editorClearedOptimistically = false;
    }
  };
  const finalizeSubmittedDraft = () => {
    if (!draftSubmissionClaimed) return;
    suppressDraftPersistRef.current = false;
    draftSubmissionClaimed = false;
  };
  let submittedContentSettled = false;
  const settleSubmittedContent = async () => {
    if (submittedContentSettled) return;
    submittedContentSettled = true;
    await attachmentsApi.adoptSentAttachments(submittedAttachmentIds);
    // 权威 projection 已确认原 command 被接管；等待期间的新正文属于下一次提交。
    if (contentRevisionRef.current === cleanupRevision) {
      inputApiRef.current?.clear();
      updateText("");
      updateComposerContent({ text: "" });
    }
    attachmentsApi.clearAttachments(submittedAttachmentIds);
    currentCodeCommentContexts.forEach(removeCodeCommentContext);
    currentWebElementContexts.forEach((context) => removeWebElementContext(context.id));
    currentPluginUiContexts.forEach((context) => removePluginUiContext(context.id));
    currentPptxElementReferences.forEach((reference) => removePptxElementReference(reference.id));
    currentConversationSelections.forEach((reference) =>
      removeConversationSelectionReference(reference.id),
    );
    finalizeSubmittedDraft();
  };
  const subscribeToCommandResolution = (commandId: string) => {
    let active = true;
    let cleanup = () => undefined;
    submittedCommandId = commandId;
    const unsubscribe = pendingCommandRegistry.subscribeResolution(commandId, (resolution) => {
      if (!active) return;
      submittedCommandResolved = true;
      cleanup();
      if (
        resolution !== "accepted" &&
        resolution !== "duplicate" &&
        resolution !== "authoritative"
      ) {
        return;
      }
      void settleSubmittedContent();
    });
    cleanup = () => {
      if (!active) return;
      active = false;
      unsubscribe();
      commandResolutionCleanupsRef.current.delete(cleanup);
    };
    commandResolutionCleanupsRef.current.add(cleanup);
  };
  const rollbackPromptHistory = () => {
    if (!promptHistoryWasPersisted || !promptHistoryBeforeSend || !promptHistoryAfterAppend) {
      return;
    }
    const currentPromptHistory = readPromptHistoryEntries(workspacePath);
    if (arePromptHistoryEntriesEqual(currentPromptHistory, promptHistoryAfterAppend)) {
      persistPromptHistoryEntries(workspacePath, promptHistoryBeforeSend);
      setPromptHistory(promptHistoryBeforeSend);
      return;
    }
    setPromptHistory(currentPromptHistory);
  };
  try {
    // 二次门禁：只消费预传完成的 ref，不在点击发送时回落上传。
    const readyAttachmentRefs = await attachmentsApi.prepareForSend();
    if (readyAttachmentRefs === null) {
      if (telemetrySeed.localTtft)
        getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
      // send_click 已上报，此处不落定会留下无配对的悬空样本，污染成功率分母。
      conversationTelemetry?.settleSendResult({
        seed: telemetrySeed,
        sessionId: sessionId ?? null,
        status: "fail",
        reasonCode: "attachment_not_ready",
      });
      sendAction.fail({ failureStage: "attachment_not_ready" });
      return;
    }
    // 外部上下文不走协议附件；按 selection -> code comment -> web -> PPTX 的固定尾块顺序
    // 序列化，历史 user row 才能按相反顺序无损解析并隐藏内部 prompt block。
    //
    // 分享 handover 不在这里序列化：share URL 块纯粹是 renderer 自产自销（CLI/shared
    // 里没有任何东西解析它），唯一作用是驱动一个已被产品裁掉的 chip，代价却是把一个
    // share URL 塞进发给模型的正文。模型侧内容由隐藏的 shared_context 消息经
    // inputIntent.sharedContextRefs 注入，与正文无关。
    const promptText = serializeComposerPromptContexts(trimmed, {
      codeComments: currentCodeCommentContexts,
      conversationSelections: [],
      webElements: currentWebElementContexts,
      pptxElements: currentPptxElementReferences,
      pluginUiContexts: currentPluginUiContexts,
    });
    const contextAttachmentCount =
      countComposerPromptContexts({
        codeComments: currentCodeCommentContexts,
        conversationSelections: currentConversationSelections,
        webElements: currentWebElementContexts,
        pptxElements: currentPptxElementReferences,
        pluginUiContexts: currentPluginUiContexts,
      }) + (submittedShareContext ? 1 : 0);
    if (trimmed) {
      promptHistoryBeforeSend = readPromptHistoryEntries(workspacePath);
      promptHistoryAfterAppend = appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed);
      if (!arePromptHistoryEntriesEqual(promptHistoryBeforeSend, promptHistoryAfterAppend)) {
        // 预热首发 accepted 后，SessionPane 会立即 promote 到新 session，
        // draft composer 可能在 await 恢复前卸载；不能把写盘藏在 React state updater 里。
        // 这里继续沿用旧 UI 的 localStorage history，不接 input_history 数据库：
        // 发起真实发送前先同步写盘，若发送失败再恢复到发送前快照。
        persistPromptHistoryEntries(workspacePath, promptHistoryAfterAppend);
        promptHistoryWasPersisted = true;
        setPromptHistory(promptHistoryAfterAppend);
      }
    }
    claimSubmittedDraft();
    if (requestedDelivery === "startNow") {
      // 原子抢占需要等旧 turn 退出并提交新 TurnStarted ACK；
      // 若编辑器也等整条链路才清空，用户会误以为快捷键未生效。
      // 先清空可见正文；命令拒绝时用冻结 editor state 原样恢复。
      inputApiRef.current?.clear();
      updateText("");
      cleanupRevision = contentRevisionRef.current;
      editorClearedOptimistically = true;
    }
    // Обычный OpenCode чат не должен незаметно делать отдельный запрос planner;
    // swarm запускается только по явному намерению, сохранённому в draft.
    const orchestrationMode = submittedDraft.orchestrationMode;
    const sendResult = await onSendText(promptText, {
      submittedDraftText: submittedDraft.text,
      ...(orchestrationMode ? { orchestrationMode } : {}),
      submission,
      ...(currentConversationSelections.length
        ? {
            conversationQuotes: currentConversationSelections.map(
              ({ text, path, senderName, senderId, messageId, sentAt }) => ({
                text,
                path,
                senderName,
                senderId,
                messageId,
                sentAt,
              }),
            ),
          }
        : {}),
      telemetrySeed,
      onCommandCreated: subscribeToCommandResolution,
      ...(requestedDelivery ? { requestedDelivery } : {}),
      ...(heldQueueDisposition ? { heldQueueDisposition } : {}),
      ...(expectedHeldQueueItemIds ? { expectedHeldQueueItemIds } : {}),
      ...(readyAttachmentRefs.length > 0 ? { attachments: readyAttachmentRefs } : {}),
      ...(contextAttachmentCount > 0 ? { contextAttachmentCount } : {}),
      ...(submittedShareContext
        ? {
            sharedContextRefs: [
              {
                kind: "shared_context_import" as const,
                context_id: submittedShareContext.contextId,
              },
            ],
          }
        : {}),
    });
    if (sendResult === "blocked") {
      if (telemetrySeed.localTtft)
        getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "rejected");
      // 产品 guard 是一次正常拒绝，不应借异常路径表达；回滚发送前暂记的 history，
      // 同时不 clear editor/draft/附件，让用户切换模式后可以直接重试。
      rollbackPromptHistory();
      restoreSubmittedDraft();
      conversationTelemetry?.settleSendResult({
        seed: telemetrySeed,
        sessionId: sessionId ?? null,
        status: "fail",
        reasonCode: "blocked",
      });
      sendAction.reject({
        resultSource: "authority_ack",
        admissionResult: "rejected",
      });
      return;
    }
    if (sendResult === "confirmationRequired") {
      if (telemetrySeed.localTtft)
        getLocalTtftObserver()?.confirmation(telemetrySeed.localTtft, true);
      rollbackPromptHistory();
      restoreSubmittedDraft();
      const latestQueueItemIds =
        snapshotRef.current?.queue.items.map((item) => item.queueItemId) ?? [];
      // 首次提交冻结当前队列；跨端 stale 后用最新投影替换，要求用户重新确认。
      setHeldQueueConfirmation({
        // 标记 queueConfirmed：确认后复用该 seed 落定，send_cost_ms 含用户在弹窗上的停留。
        telemetrySeed: { ...telemetrySeed, queueConfirmed: true },
        ...(requestedDelivery ? { requestedDelivery } : {}),
        queueItemIds: latestQueueItemIds.length > 0 ? latestQueueItemIds : submittedQueueItemIds,
      });
      sendAction.noop();
      return;
    }
    setHeldQueueConfirmation(null);
    // 发送成功或 ACK 丢失后由权威 projection 结算：清本次提交捕获的内容，
    // prompt history 已在真实发送前同步写盘，避免首发 promote 丢失或误清新 scope。
    await settleSubmittedContent();
    sendAction.complete({
      resultSource: "authority_ack",
      admissionResult: "accepted",
    });
  } catch (error) {
    rollbackPromptHistory();
    // 权威 ACK/投影可能在 Promise 失败回调前先到达；清理已开始时不能再把旧草稿恢复回来。
    if (!submittedContentSettled) restoreSubmittedDraft();
    if (telemetrySeed.localTtft) getLocalTtftObserver()?.exclude(telemetrySeed.localTtft, "failed");
    // 发送失败草稿保留在输入框（不清空），仅记录原因。
    logger.warn(`[v4-composer] 发送失败: ${String(error)}`);
    // ACK 侧失败已由 SessionPane 落定；能走到这里的是 composer 自身链路异常。
    conversationTelemetry?.settleSendResult({
      seed: telemetrySeed,
      sessionId: sessionId ?? null,
      status: "fail",
      reasonCode: "composer_error",
    });
    sendAction.fail({ failureStage: "composer_send" });
  } finally {
    pendingRef.current = false;
    setPending(false);
  }
}
