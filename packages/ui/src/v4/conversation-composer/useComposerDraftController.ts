import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { readPromptHistoryEntries } from "@/lib/promptHistoryStorage.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  resolveComposerAutoFocus,
  type ComposerAutoFocusOptions,
} from "@/v4/composer/composerAutoFocus.js";
import {
  consumeV4ComposerDraftAttachments,
  consumeV4ComposerDraftWorkspaceTransferRequest,
  registerV4ComposerDraftReader,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { V4_DRAFT_SCOPE_ROOT, type V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { subscribeComposerSubmissionSettled } from "@/v4/composer/composerSubmissionSettlement.js";
import { removeCodeCommentPreview } from "@/v4/composer/codeCommentPreviewSync.js";
import { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import type { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import type { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import type { usePluginUiModelContexts } from "@/plugin-ui/index.js";
import type { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  applyComposerRestoreRequestToComposer,
  applyExternalTextInsertRequestToComposer,
  restorePersistedComposerDraftIntoInput,
  revokeUnappliedComposerPreviewUrls,
} from "./helpers.js";
import type { ConversationComposerProps } from "./types.js";

/**
 * 草稿与编辑器生命周期：per-session 草稿持久化、scope 切换恢复、
 * 外部预填 / 队列撤回请求应用、自动聚焦意图，以及 prompt history 的本地镜像。
 *
 * 这些 effect 的触发顺序即原组件的挂载顺序（持久化 → 聚焦 → 恢复 → 预填），
 * 调用方必须在同一位次调用本 hook，不要与其他编辑器 wiring 交织。
 */

type AttachmentsApi = ReturnType<typeof useComposerAttachments>;
type WebElements = ReturnType<typeof useWebElementContexts>;
type PluginUiContexts = ReturnType<typeof usePluginUiModelContexts>;
type PptxReferences = ReturnType<typeof usePptxElementReferences>;
type ConversationSelections = ReturnType<typeof useConversationSelectionReferences>;

export interface ComposerDraftControllerInput {
  composerDraft: ConversationComposerProps["composerDraft"];
  draftScopeId: string;
  workspacePath: string;
  workspaceIdentity: string | undefined;
  workspaceKey: string;
  sessionId: string | null;
  autoFocusEnabled: boolean;
  disabled: boolean;
  isMobileTextInputViewport: boolean;
  listenAddToChatEvents: boolean;
  services: ReturnType<typeof useOptionalServices>;
  attachmentsApi: AttachmentsApi;
  webElementContexts: WebElements["contexts"];
  pluginUiContexts: PluginUiContexts["contexts"];
  pptxElementReferences: PptxReferences["references"];
  conversationSelectionReferences: ConversationSelections["references"];
  composerRestoreRequest: ConversationComposerProps["composerRestoreRequest"];
  onComposerRestoreApplied: ConversationComposerProps["onComposerRestoreApplied"];
  externalTextInsertRequest: ConversationComposerProps["externalTextInsertRequest"];
  onExternalTextInsertApplied: ConversationComposerProps["onExternalTextInsertApplied"];
  updateComposerContent: ConversationComposerProps["updateComposerContent"];
  replaceComposerDraft: ConversationComposerProps["replaceComposerDraft"];
  updateText: (text: string) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  commandResolutionCleanupsRef: MutableRefObject<Set<() => void>>;
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  contentRevisionRef: MutableRefObject<number>;
  textRef: MutableRefObject<string>;
}

export function useComposerDraftController({
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
}: ComposerDraftControllerInput) {
  // ── 草稿 per-session 持久化（切会话/刷新不丢；mention pill 经 editorStateJson 保真）──
  const draftScopeRef = useRef(draftScopeId);
  const draftTargetRef = useRef({
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const ownerDraftRef = useRef({
    draft: composerDraft,
    workspacePath,
    workspaceIdentity,
    scopeId: draftScopeId,
  });
  const draftPersistTimerRef = useRef<number | null>(null);
  const suppressDraftPersistRef = useRef(false);

  const snapshotDraftOfEditor = useCallback((): Omit<V4ComposerDraft, "updatedAt"> => {
    const currentText = textRef.current;
    let editorStateJson: string | undefined;
    try {
      const editorState = inputApiRef.current?.getEditorState();
      editorStateJson = editorState ? JSON.stringify(editorState.toJSON()) : undefined;
    } catch (error) {
      logger.warn(`[v4-composer] 草稿 editorState 序列化失败: ${String(error)}`);
    }
    return currentText.trim()
      ? {
          ...ownerDraftRef.current.draft,
          text: currentText,
          ...(editorStateJson ? { editorStateJson } : { editorStateJson: undefined }),
        }
      : {
          ...ownerDraftRef.current.draft,
          text: "",
          editorStateJson: undefined,
          mention: undefined,
        };
  }, []);

  useEffect(() => {
    // 新建 scope 已包含项目身份；不能只匹配旧的裸 __draft__ 而漏掉当前编辑器。
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    return registerV4ComposerDraftReader(workspaceKey, () => ({
      draft: { ...ownerDraftRef.current.draft, ...snapshotDraftOfEditor() },
      attachments: attachmentsApi.attachments,
    }));
  }, [draftScopeId, workspaceKey, snapshotDraftOfEditor, attachmentsApi.attachments]);

  const persistDraftNow = useCallback(
    (scopeId: string) => {
      if (suppressDraftPersistRef.current) return;
      const content = snapshotDraftOfEditor();
      if (scopeId === draftScopeRef.current) {
        updateComposerContent(content);
        return;
      }
    },
    [snapshotDraftOfEditor, updateComposerContent, workspaceIdentity, workspacePath],
  );

  const scheduleDraftPersist = useCallback(() => {
    if (typeof window === "undefined") return;
    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }
    draftPersistTimerRef.current = window.setTimeout(() => {
      draftPersistTimerRef.current = null;
      persistDraftNow(draftScopeRef.current);
    }, 350);
  }, [persistDraftNow]);

  // ── 自动聚焦（新建任务 / 切会话 / 挂载后把光标交还输入框）──
  // 触发源：startDraft 递增的 draftFocusVersion（覆盖 Cmd/Ctrl+N 与所有「新建任务」入口）、
  // sessionId→draftScopeId 变化（切会话/切草稿）、以及挂载。三者置位聚焦意图；因切到需
  // 连接的会话时 composer 短暂 disabled，聚焦意图暂存，待可编辑时兑现一次。
  const draftFocusVersion = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspacePath, workspaceIdentity).draftFocusVersion,
  );
  useEffect(() => {
    if (!draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT)) return;
    const attachments = consumeV4ComposerDraftAttachments(workspaceKey, draftFocusVersion);
    if (attachments) attachmentsApi.restoreDraftAttachments(attachments);
  }, [draftFocusVersion, draftScopeId, workspaceKey, attachmentsApi.restoreDraftAttachments]);
  const pendingFocusRef = useRef(false);
  // 本次 focus 是否由程序触发（见 flushPendingFocus），供 send_input_focus 过滤非用户动作。
  const programmaticFocusRef = useRef(false);
  // 发送键与 Enter 共用同一个 form submit；按钮 onClick 早于 submit 触发，
  // 借此区分 send_click 的 send_trigger，读取后立刻复位回默认的 shortcut。
  const sendTriggerRef = useRef<"button" | "shortcut">("shortcut");
  // 修饰键点击先于 form submit；这里只保存这一拍的 delivery 反转意图，submit 消费后清零。
  const reversePointerDeliveryRef = useRef(false);
  const appliedComposerRestoreRequestRef = useRef<number | null>(null);
  const appliedExternalTextInsertRequestRef = useRef<number | null>(null);
  // 决策入参经 ref 读取，避免把 autoFocusEnabled/disabled/viewport 灌进 scope effect 依赖，
  // 触发多余的草稿重恢复（disabled 变化本不应重放草稿）。
  const focusOptsRef = useRef<ComposerAutoFocusOptions>({
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  });
  focusOptsRef.current = {
    autoFocusEnabled,
    disabled,
    isMobileViewport: isMobileTextInputViewport,
  };
  const flushPendingFocus = useCallback(() => {
    if (!pendingFocusRef.current) return;
    if (resolveComposerAutoFocus(focusOptsRef.current) !== "focus-now") return;
    if (!inputApiRef.current) return;
    pendingFocusRef.current = false;
    // 程序性聚焦与用户点击输入框会触发同一个 DOM focus 事件；置位后由 handleEditorFocus
    // 消费，避免把「切会话 / 挂载回焦 / 上下文块移除后回焦」误报成 send_input_focus。
    programmaticFocusRef.current = true;
    // Lexical root 可能晚一帧就绪，聚焦排到下一帧（与草稿回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => inputApiRef.current?.focus());
    } else {
      inputApiRef.current.focus();
    }
  }, []);
  const requestComposerFocus = useCallback(() => {
    if (resolveComposerAutoFocus(focusOptsRef.current) === "skip") return;
    pendingFocusRef.current = true;
    flushPendingFocus();
  }, [flushPendingFocus]);

  const handleCodeCommentRemoved = useCallback(
    (comment: Parameters<typeof removeCodeCommentPreview>[0]) => {
      removeCodeCommentPreview(comment, services?.broadcastService);
    },
    [services?.broadcastService],
  );
  const {
    contexts: codeCommentContexts,
    hasContexts: hasCodeCommentContexts,
    removeContext: removeCodeCommentContext,
    clearContexts: clearCodeCommentContexts,
    getContexts: getCodeCommentContexts,
  } = useCodeCommentContexts({
    // queue 撤回等待 ACK 时 composer 处于 disabled；与网页上下文保持同一写入门禁。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    onContextRemoved: handleCodeCommentRemoved,
    requestFocus: requestComposerFocus,
    scopeKey: `${workspaceKey}\0${draftScopeId}`,
  });

  const restoreConflictRequestRef = useRef<number | null>(null);
  const appliedPreviewRequestRef = useRef<number | null>(null);
  const latestRestoreRequestIdRef = useRef<number | null>(null);
  const restoreConflictMessageRef = useRef(intl.formatMessage);
  latestRestoreRequestIdRef.current = composerRestoreRequest?.requestId ?? null;
  restoreConflictMessageRef.current = intl.formatMessage;

  useEffect(() => {
    if (!composerRestoreRequest) return;
    const request = composerRestoreRequest;
    let reason: "applied" | "not-ready" | "conflict" | "mismatch" = "not-ready";
    const applyRequest = () => {
      const nextAppliedRequestId = applyComposerRestoreRequestToComposer({
        appliedRequestId: appliedComposerRestoreRequestRef.current,
        currentSessionId: sessionId,
        currentWorkspaceKey: workspaceKey,
        hasDraftContent:
          textRef.current.length > 0 ||
          attachmentsApi.attachments.length > 0 ||
          codeCommentContexts.length > 0 ||
          webElementContexts.length > 0 ||
          pptxElementReferences.length > 0 ||
          conversationSelectionReferences.length > 0 ||
          pluginUiContexts.length > 0,
        inputApi: inputApiRef.current,
        request,
        requestFocus: requestComposerFocus,
        restoreSessionOwnedAttachments: attachmentsApi.restoreSessionOwnedAttachments,
        reportRestore: (next) => {
          reason = next;
        },
        // 撤回项携带独立 Submission 配置；沿用草稿 owner，一次恢复且保留已处理授权标记。
        restoreDraftConfig: (config) =>
          replaceComposerDraft({
            ...ownerDraftRef.current.draft,
            ...config,
            text: request.text,
            editorStateJson: undefined,
            mention: undefined,
          }),
        scheduleDraftPersist,
        updateText,
      });
      const appliedNow =
        nextAppliedRequestId === request.requestId &&
        appliedComposerRestoreRequestRef.current !== request.requestId;
      appliedComposerRestoreRequestRef.current = nextAppliedRequestId;
      if (appliedNow) {
        appliedPreviewRequestRef.current = request.requestId;
        onComposerRestoreApplied?.(request.requestId);
      }
      return nextAppliedRequestId === request.requestId;
    };
    const finishAbandoned = () => {
      if (reason !== "conflict" || restoreConflictRequestRef.current === request.requestId) return;
      restoreConflictRequestRef.current = request.requestId;
      toast(restoreConflictMessageRef.current({ id: "chat.queue.editDraftConflict" }));
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") {
      finishAbandoned();
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (!applyRequest()) finishAbandoned();
    });
    return () => {
      cancelAnimationFrame(frame);
      // 请求被下一次撤回替换、且这次没有变成 chip 时，blob 没有主人，必须释放。
      if (
        latestRestoreRequestIdRef.current !== request.requestId &&
        appliedPreviewRequestRef.current !== request.requestId
      ) {
        revokeUnappliedComposerPreviewUrls(request.attachmentPreviewUrls);
      }
    };
  }, [
    attachmentsApi.attachments.length,
    attachmentsApi.restoreSessionOwnedAttachments,
    codeCommentContexts.length,
    composerRestoreRequest,
    conversationSelectionReferences.length,
    onComposerRestoreApplied,
    replaceComposerDraft,
    scheduleDraftPersist,
    sessionId,
    updateText,
    webElementContexts.length,
    pptxElementReferences.length,
    pluginUiContexts.length,
    workspaceKey,
  ]);

  // 根因：updateText 的身份跟着 onTextChange 变。恢复 effect 若把 updateText、
  // updateComposerContent、replaceComposerDraft 等不稳定回调放进依赖，父组件还没把超前键入
  // 回写进 composerDraft 时，一次只换回调的重渲染会用旧草稿覆盖编辑器，丢掉这些键入。
  // 回调放进 ref，依赖只留 scope / workspace：恢复仍只发生在挂载和这三项变化时。
  const draftRestoreRef = useRef({
    replaceComposerDraft,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateComposerContent,
    updateText,
  });
  draftRestoreRef.current = {
    replaceComposerDraft,
    requestComposerFocus,
    snapshotDraftOfEditor,
    updateComposerContent,
    updateText,
  };

  // scope 切换：先落旧 scope 草稿，再恢复新 scope（editorStateJson 优先，退纯文本）。
  useEffect(() => {
    const previousTarget = draftTargetRef.current;
    const targetChanged =
      previousTarget.scopeId !== draftScopeId ||
      previousTarget.workspacePath !== workspacePath ||
      previousTarget.workspaceIdentity !== workspaceIdentity;
    let transferredDraft: ReturnType<typeof snapshotDraftOfEditor> | null = null;
    if (targetChanged && !suppressDraftPersistRef.current) {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      const previousDraft = draftRestoreRef.current.snapshotDraftOfEditor();
      const shouldTransferDraft =
        previousTarget.scopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        draftScopeId.startsWith(V4_DRAFT_SCOPE_ROOT) &&
        consumeV4ComposerDraftWorkspaceTransferRequest({
          sourceWorkspacePath: previousTarget.workspacePath,
          sourceWorkspaceIdentity: previousTarget.workspaceIdentity,
          targetWorkspacePath: workspacePath,
          targetWorkspaceIdentity: workspaceIdentity,
        });
      if (shouldTransferDraft) {
        // 项目解绑只改变草稿的 cwd；输入正文、mention editor state 和组件内附件继续保留。
        draftRestoreRef.current.replaceComposerDraft({
          ...ownerDraftRef.current.draft,
          ...previousDraft,
        });
        transferredDraft = previousDraft;
      }
    }
    draftScopeRef.current = draftScopeId;
    draftTargetRef.current = {
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };

    const draft = transferredDraft ?? composerDraft;
    const restoreDraftInto = (api: LexicalChatInputHandle) => {
      const { updateText } = draftRestoreRef.current;
      if (!draft) {
        if (textRef.current) {
          api.clear();
          updateText("");
        }
        return;
      }
      updateText(
        restorePersistedComposerDraftIntoInput({
          draft,
          inputApi: api,
          onEditorStateError: (error) => {
            logger.warn(`[v4-composer] 草稿 editorState 恢复失败，退纯文本: ${String(error)}`);
          },
        }),
      );
    };
    let unsubscribeSettled: (() => void) | null = null;
    const applyDraft = () => {
      const api = inputApiRef.current;
      if (!api) return;
      restoreDraftInto(api);
      // Bug 根因（R3A-B-07）：ACK 丢失时传输先 reject，提交正文被恢复回草稿；随即断连让
      // SessionPane 连同本组件卸载，闭包里的结算订阅一起消失。重连重挂后正文从草稿回填，
      // 权威 projection 到达却无人清空，用户再点发送就重复归属。这里在回填后向模块级账本
      // 认领该 scope 尚未结算的提交：结算已到则同步清空，否则等它到达。
      const restoredText = draft?.text ?? "";
      const restoredRevision = contentRevisionRef.current;
      unsubscribeSettled = subscribeComposerSubmissionSettled(
        `${workspaceKey}\0${draftScopeId}`,
        (submission) => {
          // 只清"确实是那次提交、且用户还没在其上继续编辑"的正文；编辑器把回填正文
          // 重新序列化后若与提交原文一致，也视为未编辑。
          if (submission.text !== restoredText) return;
          if (
            contentRevisionRef.current !== restoredRevision &&
            textRef.current !== submission.text
          ) {
            return;
          }
          inputApiRef.current?.clear();
          draftRestoreRef.current.updateText("");
          draftRestoreRef.current.updateComposerContent({ text: "" });
        },
      );
      // 草稿恢复后把光标交还输入框（切会话/切草稿/挂载）；连接中会话待可编辑后兑现。
      draftRestoreRef.current.requestComposerFocus();
    };
    // Lexical root 可能晚一帧就绪；draft 恢复排到下一帧（与旧 initialValue 回填同款时序）。
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(applyDraft);
      return () => {
        cancelAnimationFrame(frame);
        unsubscribeSettled?.();
      };
    }
    applyDraft();
    return () => unsubscribeSettled?.();
    // 依赖只含 scope/workspace。见上方 draftRestoreRef：回调身份变化不得重放草稿。
  }, [draftScopeId, workspaceIdentity, workspacePath]);

  useEffect(() => {
    ownerDraftRef.current = {
      draft: composerDraft,
      workspacePath,
      workspaceIdentity,
      scopeId: draftScopeId,
    };
  }, [composerDraft, draftScopeId, workspaceIdentity, workspacePath]);

  // 外部预填和 scope 恢复可能在同一轮发生。若预填 effect 先执行，后续恢复会用旧草稿
  // 覆盖用户刚点的 Example Prompt；因此必须在 scope 恢复之后应用并确认单次插入请求。
  useEffect(() => {
    if (!externalTextInsertRequest) return;
    const applyRequest = () => {
      const nextAppliedRequestId = applyExternalTextInsertRequestToComposer({
        appliedRequestId: appliedExternalTextInsertRequestRef.current,
        inputApi: inputApiRef.current,
        request: externalTextInsertRequest,
        requestFocus: requestComposerFocus,
        scheduleDraftPersist,
        updateText,
      });
      const applied = nextAppliedRequestId === externalTextInsertRequest.requestId;
      appliedExternalTextInsertRequestRef.current = nextAppliedRequestId;
      if (applied) {
        onExternalTextInsertApplied?.(externalTextInsertRequest.requestId);
      }
      return applied;
    };
    if (applyRequest()) return;
    if (typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(applyRequest);
    return () => cancelAnimationFrame(frame);
  }, [
    externalTextInsertRequest,
    onExternalTextInsertApplied,
    requestComposerFocus,
    scheduleDraftPersist,
    updateText,
  ]);

  // 新建任务（含已在草稿态重复 Cmd/Ctrl+N，scope 未变）：startDraft 递增 nonce 即重新聚焦。
  const lastFocusVersionRef = useRef(draftFocusVersion);
  useEffect(() => {
    if (lastFocusVersionRef.current === draftFocusVersion) return;
    lastFocusVersionRef.current = draftFocusVersion;
    requestComposerFocus();
  }, [draftFocusVersion, requestComposerFocus]);

  // 切到需连接的会话时 disabled=true，聚焦意图 defer；连接完成 disabled→false 时兑现一次。
  useEffect(() => {
    flushPendingFocus();
  }, [disabled, flushPendingFocus]);

  // 刷新/关窗前落盘当前草稿。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => persistDraftNow(draftScopeRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("blur", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("blur", flush);
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
      for (const cleanup of commandResolutionCleanupsRef.current) cleanup();
      commandResolutionCleanupsRef.current.clear();
    };
  }, [persistDraftNow]);

  // ── prompt history（per-workspace localStorage，↑/↓ 导航由 PromptHistoryPlugin 消费）──
  const [promptHistory, setPromptHistory] = useState<readonly string[]>(() =>
    readPromptHistoryEntries(workspacePath),
  );
  useEffect(() => {
    setPromptHistory(readPromptHistoryEntries(workspacePath));
  }, [workspacePath]);

  return {
    codeCommentContexts,
    clearCodeCommentContexts,
    draftPersistTimerRef,
    draftScopeRef,
    getCodeCommentContexts,
    hasCodeCommentContexts,
    programmaticFocusRef,
    promptHistory,
    removeCodeCommentContext,
    requestComposerFocus,
    reversePointerDeliveryRef,
    scheduleDraftPersist,
    sendTriggerRef,
    setPromptHistory,
    snapshotDraftOfEditor,
    suppressDraftPersistRef,
  };
}
