import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import type { ChatMediaAttachmentPreviewTarget } from "@/ChatMediaAttachmentPreviewDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { readWorkspaceFileDragPayload } from "@/lib/workspaceFileDrag.js";
import { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import { usePluginUiContextImages, usePluginUiModelContexts } from "@/plugin-ui/index.js";
import type { ConversationComposerProps } from "./types.js";

/**
 * composer 的附件与上下文 surface：上传队列、拖拽 / 放下路由、
 * 预览弹窗状态，以及网页元素 / 插件 / PPTX / 对话引用四类上下文来源。
 *
 * 顺序即原组件的 hook 顺序：附件 → 拖拽 → 预览 → 上下文来源。
 */

export interface ComposerAttachmentSurfacesInput {
  props: ConversationComposerProps;
  draftScopeId: string;
  workspaceKey: string;
  disabled: boolean;
  runtimeBlocked: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  textRef: MutableRefObject<string>;
  updateText: (text: string) => void;
}

export function useComposerAttachmentSurfaces({
  props,
  draftScopeId,
  workspaceKey,
  disabled,
  runtimeBlocked,
  intl,
  inputApiRef,
  textRef,
  updateText,
}: ComposerAttachmentSurfacesInput) {
  const {
    attachmentPut,
    attachmentSessionId,
    listenAddToChatEvents,
    onDropTargetControllerChange,
    onOpenCodeViewer,
    onRuntimeLifecycle,
    onRuntimeRestart,
    remoteSessionId,
    rootDraftScopeKey,
    sessionId = null,
    workspaceIdentity,
    workspacePath,
  } = props;
  // ── 附件全链路（选择/粘贴/拖拽/画板/预传/门禁）──
  const attachmentsApi = useComposerAttachments({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId: draftScopeId,
    attachmentSessionId,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled: disabled || runtimeBlocked,
    listenAddToChatEvents: listenAddToChatEvents && !disabled && !runtimeBlocked,
  });
  // 对齐旧版 useChatComposer：窗口级 dragover 会在指针进入 ChatView 前预先点亮
  // 整个聊天区与桌面草稿标题栏；workspace payload 的文案优先于系统附件。
  const { externalFileDragging, workspaceFileDragging } = usePromptEditorDragState({
    enableExternalFileDrop: true,
    enableWorkspaceFileDrop: true,
  });
  const handleConversationDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragOverComposer(event);
    },
    [attachmentsApi.handleDragOverComposer],
  );
  const handleConversationDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      attachmentsApi.handleDragLeaveComposer(event);
    },
    [attachmentsApi.handleDragLeaveComposer],
  );
  const handleConversationDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const workspaceFilePayload = readWorkspaceFileDragPayload(event.dataTransfer);
      if (workspaceFilePayload) {
        // 文件树 payload 与 OS File[] 语义不同：只插入 mention，绝不能进入上传队列。
        event.preventDefault();
        attachmentsApi.handleDropComposer(event);
        appendWorkspaceFileMentionToComposer({
          inputApiRef,
          currentMarkdown: inputApiRef.current?.getMarkdown() ?? textRef.current,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: updateText,
        });
        return;
      }
      attachmentsApi.handleDropComposer(event);
    },
    [attachmentsApi.handleDropComposer, updateText, workspaceIdentity, workspacePath],
  );
  const conversationDragKind = workspaceFileDragging
    ? "workspace"
    : externalFileDragging
      ? "attachment"
      : (attachmentsApi.composerDragKind ??
        (attachmentsApi.isDraggingOverComposer ? "attachment" : null));
  const dropTargetController = useMemo<ConversationDropTargetController>(
    () => ({
      active: conversationDragKind !== null,
      kind: conversationDragKind,
      onDragOver: handleConversationDragOver,
      onDragLeave: handleConversationDragLeave,
      onDrop: handleConversationDrop,
    }),
    [
      conversationDragKind,
      handleConversationDragLeave,
      handleConversationDragOver,
      handleConversationDrop,
    ],
  );
  useEffect(() => {
    onDropTargetControllerChange?.(dropTargetController);
    return () => onDropTargetControllerChange?.(null);
  }, [dropTargetController, onDropTargetControllerChange]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const hasAttachments = attachmentsApi.hasAttachments;
  const {
    contexts: webElementContexts,
    hasContexts: hasWebElementContexts,
    removeContext: removeWebElementContext,
    clearContexts: clearWebElementContexts,
  } = useWebElementContexts({
    workspacePath,
    workspaceIdentity,
    // queue 撤回等待 ACK 时 composer 处于 disabled；此时也要阻止全局 add-to-chat
    // 写入网页上下文，避免权威删除成功后撞上 ACK 窗口内的新草稿。
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  // 插件 UI 经 ui/update-model-context 附加的上下文；按 sessionId 接收，随发送清空。
  const {
    contexts: pluginUiContexts,
    hasContexts: hasPluginUiContexts,
    removeContext: removePluginUiContext,
    clearContexts: clearPluginUiContexts,
  } = usePluginUiModelContexts({ sessionId, workspacePath, workspaceIdentity });
  // 上下文里的 image 块 → 本 composer 的图片附件，随下一回合发送。
  usePluginUiContextImages(pluginUiContexts, attachmentsApi);
  const {
    references: pptxElementReferences,
    hasReferences: hasPptxElementReferences,
    removeReference: removePptxElementReference,
    clearReferences: clearPptxElementReferences,
  } = usePptxElementReferences({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    listenAddToChatEvents: listenAddToChatEvents && !disabled,
    scopeId: draftScopeId,
  });
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    onOpenCodeViewer,
  });
  const {
    references: conversationSelectionReferences,
    limitReason: conversationSelectionLimitReason,
    removeReference: removeConversationSelectionReference,
    clearReferences: clearConversationSelectionReferences,
  } = useConversationSelectionReferences({
    sessionId,
    workspaceKey,
    draftScopeKey: rootDraftScopeKey,
  });
  const hasConversationSelectionReferences = conversationSelectionReferences.length > 0;

  return {
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
    dropTargetController,
    hasAttachments,
    hasConversationSelectionReferences,
    hasPluginUiContexts,
    hasPptxElementReferences,
    hasWebElementContexts,
    openPptxElementReference,
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
    pdfAttachmentPreview,
    pdfAttachmentPreviewOpen,
    videoAttachmentPreviewTitle,
    webElementContexts,
  };
}
