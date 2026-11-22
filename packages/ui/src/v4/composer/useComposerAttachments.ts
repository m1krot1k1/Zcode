/**
 * composer 附件全链路入口：选择 / 粘贴 / 拖拽 / 白板注入 → 准入 → 分 scope 上传
 * → 发送门禁 → 发送后 adopt。
 *
 * 实现拆到 ./composer-attachments/，此文件只保留公开入口与 hook 调用顺序：
 * 上传引擎（含 runtime 换代作废与唤醒）→ 准入 → 拖拽反馈 → 交互表面 → 列表变更。
 * 顺序即原单体 hook 的顺序，公开 API、返回值字段和 memo 依赖保持不变。
 */
import { useMemo } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAttachmentUploadEngine } from "./composer-attachments/useAttachmentUploadEngine.js";
import { useComposerAttachmentAdmission } from "./composer-attachments/useComposerAttachmentAdmission.js";
import { useComposerAttachmentDragFeedback } from "./composer-attachments/useComposerAttachmentDragFeedback.js";
import { useComposerAttachmentSurface } from "./composer-attachments/useComposerAttachmentSurface.js";
import { useComposerAttachmentMutations } from "./composer-attachments/useComposerAttachmentMutations.js";
import {
  type ComposerAttachmentsApi,
  type UseComposerAttachmentsOptions,
} from "./composer-attachments/types.js";

export { COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS } from "./composer-attachments/types.js";
export { isTransientAttachmentUploadError } from "./composer-attachments/attachmentUploadHelpers.js";
export type {
  ComposerAttachmentsApi,
  ComposerAttachmentUploadItem,
} from "./composer-attachments/types.js";

export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): ComposerAttachmentsApi {
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId,
    attachmentSessionId = null,
    attachmentPut,
    onRuntimeRestart,
    onRuntimeLifecycle,
    disabled = false,
    listenAddToChatEvents = true,
  } = options;
  const platform = usePlatform();
  const { promptAttachmentTransferService } = useServices();
  const { intl } = useZCodeIntl();

  const engine = useAttachmentUploadEngine({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    scopeId,
    attachmentSessionId,
    attachmentPut,
    transferService: promptAttachmentTransferService,
    intl,
    onRuntimeRestart,
    onRuntimeLifecycle,
  });
  const { scopeKey } = engine;
  const admission = useComposerAttachmentAdmission({ engine, scopeKey, platform, intl });
  const drag = useComposerAttachmentDragFeedback(admission.addAttachmentFiles);
  const surface = useComposerAttachmentSurface({
    engine,
    admission,
    scopeKey,
    platform,
    intl,
    disabled,
    listenAddToChatEvents,
    workspacePath,
    workspaceIdentity,
  });
  const mutations = useComposerAttachmentMutations({ engine, admission, scopeKey });

  const { attachments, attachmentError, setAttachmentError } = engine;
  const { addAttachmentFiles } = admission;
  const {
    attachmentInputRef,
    openAttachmentPicker,
    handleAttachmentInputChange,
    handlePaste,
    handleWhiteboardMentionSelected,
  } = surface;
  const {
    composerDragKind,
    isDraggingOverComposer,
    handleDragOverComposer,
    handleDragLeaveComposer,
    handleDropComposer,
  } = drag;
  const {
    removeAttachment,
    retryAttachment,
    clearAttachments,
    restoreDraftAttachments,
    restoreSessionOwnedAttachments,
    prepareForSend,
    adoptSentAttachments,
  } = mutations;

  return useMemo(
    () => ({
      attachments,
      attachmentError,
      composerDragKind,
      hasAttachments: attachments.length > 0,
      hasUnreadyAttachments: attachments.some((item) => item.uploadStatus !== "ready"),
      isDraggingOverComposer,
      attachmentInputRef,
      openAttachmentPicker,
      handleAttachmentInputChange,
      handlePaste,
      handleDragOverComposer,
      handleDragLeaveComposer,
      handleDropComposer,
      handleWhiteboardMentionSelected,
      addAttachmentFiles,
      removeAttachment,
      retryAttachment,
      clearAttachments,
      restoreDraftAttachments,
      restoreSessionOwnedAttachments,
      prepareForSend,
      adoptSentAttachments,
      setAttachmentError,
    }),
    [
      addAttachmentFiles,
      attachmentError,
      adoptSentAttachments,
      attachments,
      composerDragKind,
      clearAttachments,
      restoreDraftAttachments,
      restoreSessionOwnedAttachments,
      handleAttachmentInputChange,
      handleDragLeaveComposer,
      handleDragOverComposer,
      handleDropComposer,
      handlePaste,
      handleWhiteboardMentionSelected,
      isDraggingOverComposer,
      openAttachmentPicker,
      prepareForSend,
      removeAttachment,
      retryAttachment,
      setAttachmentError,
    ],
  );
}
