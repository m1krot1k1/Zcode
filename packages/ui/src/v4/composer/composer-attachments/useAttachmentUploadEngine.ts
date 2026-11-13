/**
 * 附件上传引擎：scope 级队列、in-flight 控制器、完成/重试定时器、runtime 换代作废
 * 与会话唤醒都在这里原子收口。它是附件状态与副作用的唯一所有者，其他子 hook 只
 * 通过返回的回调读写，避免同一批附件出现两条写入路径。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { IPromptAttachmentTransferService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  exposeComposerAttachmentScopeKeyForE2E,
  readComposerAttachmentScope,
  updateComposerAttachmentScope,
  useComposerAttachmentUploadStore,
  type ComposerAttachmentUploadItem,
} from "@/store/composerAttachmentUploadStore.js";
import { uploadComposerAttachment, type AttachmentPutFn } from "@/v4/composer/attachmentUpload.js";
import {
  MissingInlinePdfContentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
  formatAttachmentSize,
  serializeChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import {
  buildScopeKey,
  isRemoteAttachmentTarget,
  isTransientAttachmentUploadError,
  progressPercent,
  RemoteAttachmentNotStagedError,
} from "./attachmentUploadHelpers.js";
import {
  COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS,
  COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS,
  COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT,
  COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY,
  EMPTY_COMPOSER_ATTACHMENTS,
  type ComposerAttachmentItemUpdate,
  type ComposerAttachmentScopeUpdate,
  type UploadQueueEntry,
  type UploadTarget,
} from "./types.js";

export interface AttachmentUploadEngineOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  scopeId: string;
  attachmentSessionId: string | null;
  attachmentPut: AttachmentPutFn;
  transferService: IPromptAttachmentTransferService;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onRuntimeRestart?: (listener: () => void) => () => void;
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
}

export interface AttachmentUploadEngine {
  scopeKey: string;
  attachments: ComposerAttachmentUploadItem[];
  attachmentError: string | null;
  setAttachmentError: (message: string | null) => void;
  restartEpoch: number;
  targetsRef: RefObject<Map<string, UploadTarget>>;
  uploadQueueRef: RefObject<UploadQueueEntry[]>;
  controllersRef: RefObject<Map<string, AbortController>>;
  completeTimersRef: RefObject<Map<string, number>>;
  retryTimersRef: RefObject<Map<string, number>>;
  commitScope: (targetScopeKey: string, update: ComposerAttachmentScopeUpdate) => void;
  updateItem: (
    targetScopeKey: string,
    attachmentId: string,
    update: ComposerAttachmentItemUpdate,
  ) => void;
  enqueueUpload: (targetScopeKey: string, attachmentId: string) => void;
  finishWithReady: (
    targetScopeKey: string,
    attachmentId: string,
    ref: AttachmentRef,
    staged: boolean,
  ) => void;
  runUpload: (targetScopeKey: string, attachmentId: string, target: UploadTarget) => Promise<void>;
  pumpQueue: () => void;
  invalidateAttachmentsForRuntimeChange: (options: { silent: boolean }) => void;
}

export function useAttachmentUploadEngine({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  scopeId,
  attachmentSessionId,
  attachmentPut,
  transferService,
  intl,
  onRuntimeRestart,
  onRuntimeLifecycle,
}: AttachmentUploadEngineOptions): AttachmentUploadEngine {
  const scopeKey = buildScopeKey(workspacePath, workspaceIdentity, scopeId);
  exposeComposerAttachmentScopeKeyForE2E(scopeKey);

  const targetsRef = useRef(new Map<string, UploadTarget>());
  const uploadQueueRef = useRef<UploadQueueEntry[]>([]);
  const activeUploadsRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const completeTimersRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, number>());
  const pumpQueueRef = useRef<() => void>(() => {});
  const attachments = useComposerAttachmentUploadStore(
    (state) => state.scopes[scopeKey] ?? EMPTY_COMPOSER_ATTACHMENTS,
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  /**
   * runtime 换代计数。换代后 attachmentSessionId 可能原地不变（正式会话由 cold-resume 恢复），
   * 只靠它做依赖会漏掉唤醒，附件将永久停在 waitingSession。
   */
  const [restartEpoch, setRestartEpoch] = useState(0);

  targetsRef.current.set(scopeKey, {
    sessionId: attachmentSessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    attachmentPut,
    transferService,
  });

  const commitScope = useCallback(
    (targetScopeKey: string, update: ComposerAttachmentScopeUpdate) => {
      updateComposerAttachmentScope(targetScopeKey, update);
    },
    [],
  );

  const updateItem = useCallback(
    (targetScopeKey: string, attachmentId: string, update: ComposerAttachmentItemUpdate) => {
      commitScope(targetScopeKey, (current) =>
        current.map((item) => (item.id === attachmentId ? update(item) : item)),
      );
    },
    [commitScope],
  );

  const enqueueUpload = useCallback((targetScopeKey: string, attachmentId: string) => {
    const exists = uploadQueueRef.current.some(
      (entry) => entry.scopeKey === targetScopeKey && entry.attachmentId === attachmentId,
    );
    if (!exists) uploadQueueRef.current.push({ scopeKey: targetScopeKey, attachmentId });
    queueMicrotask(() => pumpQueueRef.current());
  }, []);

  const finishWithReady = useCallback(
    (targetScopeKey: string, attachmentId: string, ref: AttachmentRef, staged: boolean) => {
      updateItem(targetScopeKey, attachmentId, (item) => ({
        ...item,
        uploadStatus: "ready",
        uploadProgress: 100,
        uploadError: undefined,
        uploadErrorKind: undefined,
        attachmentRef: ref,
        staged,
        showComplete: !item.localZeroCopy,
      }));
      const timerKey = `${targetScopeKey}\u0000${attachmentId}`;
      const previousTimer = completeTimersRef.current.get(timerKey);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      const timer = window.setTimeout(() => {
        completeTimersRef.current.delete(timerKey);
        updateItem(targetScopeKey, attachmentId, (item) => ({
          ...item,
          showComplete: false,
        }));
      }, COMPOSER_ATTACHMENT_COMPLETE_VISIBLE_MS);
      completeTimersRef.current.set(timerKey, timer);
    },
    [updateItem],
  );

  const runUpload = useCallback(
    async (targetScopeKey: string, attachmentId: string, target: UploadTarget) => {
      const controllerKey = `${targetScopeKey}\u0000${attachmentId}`;
      const controller = new AbortController();
      controllersRef.current.set(controllerKey, controller);
      updateItem(targetScopeKey, attachmentId, (item) => ({
        ...item,
        uploadStatus: "uploading",
        uploadProgress: Math.min(item.uploadProgress, 99),
        uploadError: undefined,
        uploadErrorKind: undefined,
      }));
      let progressSubscription: { dispose(): void } | null = null;
      try {
        const item = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === attachmentId,
        );
        if (!item || !target.sessionId) return;
        if (item.localPath && isRemoteAttachmentTarget(target)) {
          if (!target.remoteSessionId) {
            updateItem(targetScopeKey, attachmentId, (current) => ({
              ...current,
              uploadStatus: "waitingSession",
            }));
            return;
          }
          progressSubscription = target.transferService.onDynamicProgress(item.operationId)(
            (progress) => {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(targetScopeKey, attachmentId, (current) => ({
                ...current,
                uploadStatus: progress.phase === "committing" ? "committing" : current.uploadStatus,
                uploadProgress: Math.max(
                  current.uploadProgress,
                  progressPercent(progress.uploadedBytes, progress.totalBytes),
                ),
              }));
            },
          );
          const result = await target.transferService.stage({
            operationId: item.operationId,
            sessionId: target.sessionId,
            workspacePath: target.workspacePath,
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
            remoteSessionId: target.remoteSessionId,
            localPath: item.localPath,
            fileName: item.filename,
            mime: item.mimeType,
            sizeBytes: item.sizeBytes,
          });
          if (controllersRef.current.get(controllerKey) !== controller) return;
          // 远端 ServiceAccessor 曾错误注入本地 transfer service，并返回
          // staged:false + host localPath。远端 Agent 无法读取该路径，因此必须阻止发送。
          if (!result.staged) {
            throw new RemoteAttachmentNotStagedError(
              intl.formatMessage({
                id: "chat.attachments.upload.remoteMaterializationRequired",
              }),
            );
          }
          finishWithReady(
            targetScopeKey,
            attachmentId,
            {
              ref: result.ref,
              fileName: item.filename,
              mime: item.mimeType,
              bytes: result.bytes,
              ...(item.sourceKind
                ? { sourceKind: item.sourceKind, messageCount: item.messageCount }
                : {}),
            },
            result.staged,
          );
          return;
        }

        const serialized = await serializeChatComposerAttachment(item);
        const ref = await uploadComposerAttachment(
          target.attachmentPut,
          target.sessionId,
          serialized,
          {
            signal: controller.signal,
            onProgress(progress) {
              if (controllersRef.current.get(controllerKey) !== controller) return;
              updateItem(targetScopeKey, attachmentId, (current) => ({
                ...current,
                uploadStatus: progress.phase === "committing" ? "committing" : "uploading",
                uploadProgress: Math.max(
                  current.uploadProgress,
                  progressPercent(progress.uploadedBytes, progress.totalBytes),
                ),
              }));
            },
          },
        );
        if (!ref) throw new Error("附件缺少可读取内容");
        if (controllersRef.current.get(controllerKey) !== controller) return;
        finishWithReady(targetScopeKey, attachmentId, ref, false);
      } catch (error) {
        if (controllersRef.current.get(controllerKey) !== controller || controller.signal.aborted) {
          return;
        }
        const current = readComposerAttachmentScope(targetScopeKey).find(
          (candidate) => candidate.id === attachmentId,
        );
        if (!current) return;
        // 结构化超限错误在 UI 层按 locale 格式化（与 chatAttachments 序列化边界约定一致）。
        const message =
          error instanceof OversizedInlineVideoAttachmentError
            ? intl.formatMessage(
                { id: "chat.attachments.oversizedInlineVideo" },
                {
                  filename: error.filename,
                  size: formatAttachmentSize(error.sizeBytes),
                  maxSize: formatAttachmentSize(error.maxSizeBytes),
                },
              )
            : error instanceof OversizedInlinePdfAttachmentError
              ? intl.formatMessage(
                  { id: "chat.attachments.oversizedInlinePdf" },
                  {
                    filename: error.filename,
                    size: formatAttachmentSize(error.sizeBytes),
                    maxSize: formatAttachmentSize(error.maxSizeBytes),
                  },
                )
              : error instanceof MissingInlinePdfContentError
                ? intl.formatMessage(
                    { id: "chat.attachments.missingInlinePdfContent" },
                    { filename: error.filename },
                  )
                : error instanceof Error
                  ? error.message
                  : String(error);
        const transient = isTransientAttachmentUploadError(error);
        if (transient && current.autoRetryCount < 1) {
          updateItem(targetScopeKey, attachmentId, (item) => ({
            ...item,
            uploadStatus: "queued",
            uploadProgress: 0,
            uploadError: message,
            uploadErrorKind: "transient",
            autoRetryCount: item.autoRetryCount + 1,
          }));
          const timerKey = `${targetScopeKey}\u0000${attachmentId}`;
          const timer = window.setTimeout(() => {
            retryTimersRef.current.delete(timerKey);
            enqueueUpload(targetScopeKey, attachmentId);
          }, COMPOSER_ATTACHMENT_AUTO_RETRY_DELAY_MS);
          retryTimersRef.current.set(timerKey, timer);
        } else {
          updateItem(targetScopeKey, attachmentId, (item) => ({
            ...item,
            uploadStatus: "failed",
            uploadProgress: Math.min(item.uploadProgress, 99),
            uploadError: message,
            uploadErrorKind: transient ? "transient" : "permanent",
          }));
          logger.warn("[v4-composer-attachments] 附件上传失败", {
            attachmentId,
            error: message,
            scopeKey: targetScopeKey,
          });
        }
      } finally {
        progressSubscription?.dispose();
        if (controllersRef.current.get(controllerKey) === controller) {
          controllersRef.current.delete(controllerKey);
        }
        activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
        pumpQueueRef.current();
      }
    },
    [enqueueUpload, finishWithReady, intl, updateItem],
  );

  const pumpQueue = useCallback(() => {
    while (
      activeUploadsRef.current < COMPOSER_ATTACHMENT_UPLOAD_CONCURRENCY &&
      uploadQueueRef.current.length > 0
    ) {
      const entry = uploadQueueRef.current.shift();
      if (!entry) break;
      const item = readComposerAttachmentScope(entry.scopeKey).find(
        (candidate) => candidate.id === entry.attachmentId,
      );
      if (!item || (item.uploadStatus !== "queued" && item.uploadStatus !== "waitingSession")) {
        continue;
      }
      const target = targetsRef.current.get(entry.scopeKey);
      const waitingForRemoteSession = Boolean(
        target && item.localPath && isRemoteAttachmentTarget(target) && !target.remoteSessionId,
      );
      if (!target?.sessionId || waitingForRemoteSession) {
        updateItem(entry.scopeKey, entry.attachmentId, (current) => ({
          ...current,
          uploadStatus: "waitingSession",
        }));
        continue;
      }
      activeUploadsRef.current += 1;
      void runUpload(entry.scopeKey, entry.attachmentId, target);
    }
  }, [runUpload, updateItem]);
  pumpQueueRef.current = pumpQueue;

  useEffect(() => {
    const current = readComposerAttachmentScope(scopeKey);
    const remoteTargetReady =
      !isRemoteAttachmentTarget({ remoteSessionId, workspaceIdentity }) || Boolean(remoteSessionId);
    if (attachmentSessionId && remoteTargetReady) {
      for (const item of current) {
        if (item.uploadStatus === "waitingSession") {
          updateItem(scopeKey, item.id, (candidate) => ({
            ...candidate,
            uploadStatus: "queued",
          }));
          enqueueUpload(scopeKey, item.id);
        }
      }
    }
  }, [
    attachmentSessionId,
    enqueueUpload,
    remoteSessionId,
    restartEpoch,
    scopeKey,
    updateItem,
    workspaceIdentity,
  ]);

  /**
   * 换代作废：撤掉 in-flight 上传与远端暂存，把附件降回 waitingSession 等新会话。
   * silent=true 时不写错误文案——那是一次全自动恢复（作废 → 预热重建 → 重传，1-2s 内完成），
   * 报错只会让用户以为出了问题；waitingSession 本身已渲染成「正在等待会话」。
   */
  const invalidateAttachmentsForRuntimeChange = useCallback(
    ({ silent }: { silent: boolean }) => {
      for (const [targetScopeKey, items] of Object.entries(
        useComposerAttachmentUploadStore.getState().scopes,
      )) {
        const target = targetsRef.current.get(targetScopeKey);
        if (!target) continue;
        for (const item of items) {
          if (
            item.referenceOwnership === "session" ||
            item.localZeroCopy ||
            item.uploadStatus === "failed"
          ) {
            continue;
          }
          const key = `${targetScopeKey}\u0000${item.id}`;
          controllersRef.current.get(key)?.abort();
          controllersRef.current.delete(key);
          if (item.staged) void target?.transferService.cleanup(item.operationId).catch(() => {});
          if (item.runtimeRebuildRetryCount >= COMPOSER_ATTACHMENT_REBUILD_RETRY_LIMIT) {
            // 重传配额用尽是真失败，无论静默与否都必须让用户看见。
            updateItem(targetScopeKey, item.id, (current) => ({
              ...current,
              uploadStatus: "failed",
              uploadProgress: 0,
              uploadError: intl.formatMessage({
                id: "chat.attachments.upload.runtimeRestarted",
              }),
              uploadErrorKind: "runtimeRestarted",
              attachmentRef: undefined,
              staged: false,
              adopted: false,
              showComplete: false,
            }));
            continue;
          }
          // 换代后 targetsRef 里的 sessionId 必然陈旧（它在渲染期写入，而换代事件先于
          // 下一次渲染到达），拿它入队会直撞 sessionNotFound。一律降到 waitingSession，
          // 由 restartEpoch / 新 attachmentSessionId 驱动的唤醒 effect 在会话可用后统一入队。
          updateItem(targetScopeKey, item.id, (current) => ({
            ...current,
            uploadStatus: "waitingSession",
            uploadProgress: 0,
            ...(silent
              ? { uploadError: undefined, uploadErrorKind: undefined }
              : {
                  uploadError: intl.formatMessage({
                    id: "chat.attachments.upload.runtimeRestarted",
                  }),
                  uploadErrorKind: "runtimeRestarted" as const,
                }),
            attachmentRef: undefined,
            staged: false,
            adopted: false,
            showComplete: false,
            runtimeRebuildRetryCount: current.runtimeRebuildRetryCount + 1,
          }));
        }
      }
    },
    [intl, updateItem],
  );

  useEffect(() => {
    // 二选一订阅：两条通道都订会让同一次换代作废两次，白烧一次重传配额。
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        if (state === "unavailable") {
          // 作废与唤醒到此才真正解耦：此刻旧 CLI 已死、新的还没起来，递增 restartEpoch 会让
          // 唤醒 effect 立即入队并直撞死进程（正式会话态 sessionId 原地不变时尤其明显）。
          invalidateAttachmentsForRuntimeChange({ silent: true });
          return;
        }
        // 草稿态实际由重建后的新 attachmentSessionId 唤醒；这一路是正式会话态的兜底。
        setRestartEpoch((current) => current + 1);
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(() => {
      invalidateAttachmentsForRuntimeChange({ silent: false });
      // 作废与唤醒解耦：这里只负责作废，入队交给依赖 restartEpoch 的唤醒 effect。
      setRestartEpoch((current) => current + 1);
    });
  }, [invalidateAttachmentsForRuntimeChange, onRuntimeLifecycle, onRuntimeRestart]);

  return {
    scopeKey,
    attachments,
    attachmentError,
    setAttachmentError,
    restartEpoch,
    targetsRef,
    uploadQueueRef,
    controllersRef,
    completeTimersRef,
    retryTimersRef,
    commitScope,
    updateItem,
    enqueueUpload,
    finishWithReady,
    runUpload,
    pumpQueue,
    invalidateAttachmentsForRuntimeChange,
  };
}
