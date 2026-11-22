/**
 * 附件列表变更：删除、失败重试、发送后清理、草稿迁移与会话接管恢复。
 * 每个入口都同时回收控制器、队列条目和定时器，并只通过引擎的 commitScope /
 * updateItem 写 store，保持「一条附件只有一条写入路径」。
 */
import { useCallback } from "react";
import { nanoid } from "nanoid";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";
import { readComposerAttachmentScope } from "@/store/composerAttachmentUploadStore.js";
import {
  createChatComposerAttachment,
  createChatComposerPathAttachment,
  revokeChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { logger } from "@/logger.js";
import type { ComposerAttachmentAdmission } from "./useComposerAttachmentAdmission.js";
import type { AttachmentUploadEngine } from "./useAttachmentUploadEngine.js";

export interface ComposerAttachmentMutationsOptions {
  engine: AttachmentUploadEngine;
  admission: ComposerAttachmentAdmission;
  scopeKey: string;
}

export interface ComposerAttachmentMutations {
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  clearAttachments: (attachmentIds?: readonly string[]) => void;
  restoreDraftAttachments: (attachments: readonly ChatComposerAttachment[]) => void;
  restoreSessionOwnedAttachments: (
    attachments: readonly AttachmentRef[],
    previewUrls?: Readonly<Record<string, string>>,
  ) => boolean;
  prepareForSend: () => Promise<AttachmentRef[] | null>;
  adoptSentAttachments: (attachmentIds: readonly string[]) => Promise<void>;
}

export function useComposerAttachmentMutations({
  engine,
  admission,
  scopeKey,
}: ComposerAttachmentMutationsOptions): ComposerAttachmentMutations {
  const {
    commitScope,
    updateItem,
    enqueueUpload,
    targetsRef,
    uploadQueueRef,
    controllersRef,
    completeTimersRef,
    retryTimersRef,
    setAttachmentError,
  } = engine;
  const { addPreparedAttachments } = admission;

  const removeAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey);
      const item = current.find((candidate) => candidate.id === id);
      if (!item) return;
      const key = `${scopeKey}\u0000${id}`;
      controllersRef.current.get(key)?.abort();
      controllersRef.current.delete(key);
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => !(entry.scopeKey === scopeKey && entry.attachmentId === id),
      );
      const completeTimer = completeTimersRef.current.get(key);
      if (completeTimer !== undefined) window.clearTimeout(completeTimer);
      const retryTimer = retryTimersRef.current.get(key);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      completeTimersRef.current.delete(key);
      retryTimersRef.current.delete(key);
      revokeChatComposerAttachment(item);
      const target = targetsRef.current.get(scopeKey);
      if (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing") {
        void target?.transferService.cancel(item.operationId).catch((error) => {
          logger.warn("[v4-composer-attachments] 取消远程附件失败", error);
        });
      }
      commitScope(scopeKey, (items) => items.filter((candidate) => candidate.id !== id));
      setAttachmentError(null);
    },
    [
      commitScope,
      completeTimersRef,
      controllersRef,
      retryTimersRef,
      scopeKey,
      setAttachmentError,
      targetsRef,
      uploadQueueRef,
    ],
  );

  const retryAttachment = useCallback(
    (id: string) => {
      const current = readComposerAttachmentScope(scopeKey).find(
        (candidate) => candidate.id === id,
      );
      if (!current || current.uploadStatus !== "failed") return;
      const target = targetsRef.current.get(scopeKey);
      void target?.transferService.cleanup(current.operationId).catch(() => {});
      updateItem(scopeKey, id, (item) => ({
        ...item,
        uploadStatus: target?.sessionId ? "queued" : "waitingSession",
        uploadProgress: 0,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: undefined,
        autoRetryCount: 0,
        runtimeRebuildRetryCount: 0,
        staged: false,
        adopted: false,
        showComplete: false,
      }));
      if (target?.sessionId) enqueueUpload(scopeKey, id);
    },
    [enqueueUpload, scopeKey, targetsRef, updateItem],
  );

  const clearAttachments = useCallback(
    (attachmentIds?: readonly string[]) => {
      const ids = attachmentIds ? new Set(attachmentIds) : null;
      const current = readComposerAttachmentScope(scopeKey).filter(
        (item) => !ids || ids.has(item.id),
      );
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        const key = `${scopeKey}\u0000${item.id}`;
        controllersRef.current.get(key)?.abort();
        controllersRef.current.delete(key);
        const completeTimer = completeTimersRef.current.get(key);
        if (completeTimer !== undefined) window.clearTimeout(completeTimer);
        const retryTimer = retryTimersRef.current.get(key);
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        completeTimersRef.current.delete(key);
        retryTimersRef.current.delete(key);
        revokeChatComposerAttachment(item);
        if (
          !item.adopted &&
          (item.staged || item.uploadStatus === "uploading" || item.uploadStatus === "committing")
        ) {
          void target?.transferService.cleanup(item.operationId).catch((error) => {
            logger.warn("[v4-composer-attachments] 清理未发送附件失败", error);
          });
        }
      }
      // ACK 到达后清空整个 scope，会顺手删除等待期间新加入的附件。
      uploadQueueRef.current = uploadQueueRef.current.filter(
        (entry) => entry.scopeKey !== scopeKey || (ids !== null && !ids.has(entry.attachmentId)),
      );
      commitScope(scopeKey, (items) => (ids ? items.filter((item) => !ids.has(item.id)) : []));
      setAttachmentError(null);
    },
    [
      commitScope,
      completeTimersRef,
      controllersRef,
      retryTimersRef,
      scopeKey,
      setAttachmentError,
      targetsRef,
      uploadQueueRef,
    ],
  );

  const restoreDraftAttachments = useCallback(
    (source: readonly ChatComposerAttachment[]) => {
      // 新项目可能使用另一 Host/session；保留原始 File/路径，重新生成预览和上传归属。
      const restored = source.map((item) => ({
        sourceKind: item.sourceKind,
        messageCount: item.messageCount,
        lineCount: item.lineCount,
        charCount: item.charCount,
        ...(item.file
          ? createChatComposerAttachment(item.file, item.localPath)
          : createChatComposerPathAttachment(item.localPath!)),
      }));
      clearAttachments();
      addPreparedAttachments(restored);
    },
    [addPreparedAttachments, clearAttachments],
  );

  const restoreSessionOwnedAttachments = useCallback(
    (
      attachmentRefs: readonly AttachmentRef[],
      previewUrls?: Readonly<Record<string, string>>,
    ): boolean => {
      if (attachmentRefs.length === 0) return true;
      if (readComposerAttachmentScope(scopeKey).length > 0) return false;
      const restored: ComposerAttachmentUploadItem[] = attachmentRefs.map((attachmentRef) => {
        const id = nanoid();
        const previewKey = attachmentRef.previewRef ?? attachmentRef.ref;
        const objectUrl = previewUrls?.[previewKey];
        const mime = attachmentRef.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const keepsPreview =
          Boolean(objectUrl) && (mime.startsWith("image/") || mime.startsWith("video/"));
        return {
          id,
          filename: attachmentRef.fileName,
          ...(attachmentRef.sourceKind
            ? { sourceKind: attachmentRef.sourceKind, messageCount: attachmentRef.messageCount }
            : {}),
          mimeType: attachmentRef.mime,
          ...(keepsPreview ? { objectUrl } : {}),
          sizeBytes: attachmentRef.bytes,
          referenceOwnership: "session",
          uploadStatus: "ready",
          uploadProgress: 100,
          attachmentRef: { ...attachmentRef },
          operationId: `session-owned-${id}`,
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: true,
          showComplete: false,
          localZeroCopy: false,
        };
      });
      // queue 中的 AttachmentRef 已在首次发送时由 session 接管；若按普通
      // composer 文件重建，会在撤回后重复 upload/adopt，并在 runtime restart 时误清引用。
      commitScope(scopeKey, () => restored);
      setAttachmentError(null);
      return true;
    },
    [commitScope, scopeKey, setAttachmentError],
  );

  const prepareForSend = useCallback(async (): Promise<AttachmentRef[] | null> => {
    const current = readComposerAttachmentScope(scopeKey);
    if (current.some((item) => item.uploadStatus !== "ready" || !item.attachmentRef)) {
      return null;
    }
    return current.flatMap((item) => (item.attachmentRef ? [item.attachmentRef] : []));
  }, [scopeKey]);

  const adoptSentAttachments = useCallback(
    async (attachmentIds: readonly string[]): Promise<void> => {
      const ids = new Set(attachmentIds);
      // 移交边界必须与本次 Submission 一致，不把下一条消息的附件提前交给 Session。
      const current = readComposerAttachmentScope(scopeKey).filter((item) => ids.has(item.id));
      const target = targetsRef.current.get(scopeKey);
      for (const item of current) {
        if (item.staged && !item.adopted) {
          try {
            await target?.transferService.adopt(item.operationId);
          } catch (error) {
            // sendText 已成功，不能因 adopt 回执失败把同一条消息重新留在 composer。
            logger.warn("[v4-composer-attachments] 附件发送后 adopt 失败", error);
          }
          updateItem(scopeKey, item.id, (candidate) => ({
            ...candidate,
            adopted: true,
          }));
        }
      }
    },
    [scopeKey, targetsRef, updateItem],
  );

  return {
    removeAttachment,
    retryAttachment,
    clearAttachments,
    restoreDraftAttachments,
    restoreSessionOwnedAttachments,
    prepareForSend,
    adoptSentAttachments,
  };
}
