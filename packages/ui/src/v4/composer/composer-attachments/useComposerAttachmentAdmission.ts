/**
 * 附件准入：上限判定、零拷贝判定和 scope 写入。所有「把新附件放进 composer」的
 * 入口（选择器 / 拖拽 / 粘贴 / 程序化注入）都必须经过 addPreparedAttachments，
 * 保证上限、operationId 与初始上传状态只有一份生成逻辑。
 */
import { useCallback } from "react";
import { toast } from "@/components/ui/toast.js";
import type { IPlatformService } from "@zcode/shared";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";
import { readComposerAttachmentScope } from "@/store/composerAttachmentUploadStore.js";
import {
  MAX_CHAT_ATTACHMENTS,
  createChatComposerAttachment,
  revokeChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isRemoteAttachmentTarget } from "./attachmentUploadHelpers.js";
import type { AttachmentUploadEngine } from "./useAttachmentUploadEngine.js";

export interface ComposerAttachmentAdmissionOptions {
  engine: AttachmentUploadEngine;
  scopeKey: string;
  platform: IPlatformService;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

export interface ComposerAttachmentAdmission {
  showAttachmentLimitWarning: () => void;
  addPreparedAttachments: (selectedAttachments: ChatComposerAttachment[]) => string[];
  addAttachmentFiles: (files: File[]) => string[];
}

export function useComposerAttachmentAdmission({
  engine,
  scopeKey,
  platform,
  intl,
}: ComposerAttachmentAdmissionOptions): ComposerAttachmentAdmission {
  const { commitScope, enqueueUpload, targetsRef, setAttachmentError } = engine;

  const showAttachmentLimitWarning = useCallback(() => {
    // 只更新输入框底部文字时，重复超限缺少明显反馈；每次添加都弹提示，同一输入框不堆叠。
    toast(
      intl.formatMessage(
        { id: "chat.attachments.maxFiles" },
        { count: String(MAX_CHAT_ATTACHMENTS) },
      ),
      { variant: "warning", position: "bottom-center", dedupeKey: `attachment-limit:${scopeKey}` },
    );
  }, [intl, scopeKey]);

  const addPreparedAttachments = useCallback(
    (selectedAttachments: ChatComposerAttachment[]): string[] => {
      if (selectedAttachments.length === 0) return [];
      const current = readComposerAttachmentScope(scopeKey);
      const remainingSlots = MAX_CHAT_ATTACHMENTS - current.length;
      if (remainingSlots <= 0) {
        selectedAttachments.forEach(revokeChatComposerAttachment);
        showAttachmentLimitWarning();
        return [];
      }
      const accepted = selectedAttachments.slice(0, remainingSlots);
      selectedAttachments.slice(remainingSlots).forEach(revokeChatComposerAttachment);
      const target = targetsRef.current.get(scopeKey);
      const items: ComposerAttachmentUploadItem[] = accepted.map((attachment) => {
        // 远端 identity 往往早于 remoteSessionId 注入；这段窗口不能退化为本地路径直读。
        const localZeroCopy = Boolean(
          attachment.localPath && target && !isRemoteAttachmentTarget(target),
        );
        return {
          ...attachment,
          referenceOwnership: "composer",
          operationId: `prompt-attachment-${attachment.id}`,
          uploadStatus: localZeroCopy ? "ready" : target?.sessionId ? "queued" : "waitingSession",
          uploadProgress: localZeroCopy ? 100 : 0,
          ...(localZeroCopy && attachment.localPath
            ? {
                attachmentRef: {
                  ref: attachment.localPath,
                  fileName: attachment.filename,
                  mime: attachment.mimeType,
                  bytes: attachment.sizeBytes,
                },
              }
            : {}),
          autoRetryCount: 0,
          runtimeRebuildRetryCount: 0,
          staged: false,
          adopted: false,
          showComplete: false,
          localZeroCopy,
        };
      });
      commitScope(scopeKey, (existing) => [...existing, ...items]);
      setAttachmentError(null);
      if (selectedAttachments.length > remainingSlots) showAttachmentLimitWarning();
      for (const item of items) {
        if (item.uploadStatus === "queued") enqueueUpload(scopeKey, item.id);
      }
      return items.map((item) => item.id);
    },
    [
      commitScope,
      enqueueUpload,
      scopeKey,
      setAttachmentError,
      showAttachmentLimitWarning,
      targetsRef,
    ],
  );

  const addAttachmentFiles = useCallback(
    (selectedFiles: File[]): string[] => {
      return addPreparedAttachments(
        selectedFiles.map((file) => {
          let localPath: string | undefined;
          try {
            const resolvedPath = platform.getPathForFile?.(file);
            localPath = resolvedPath?.trim() ? resolvedPath : undefined;
          } catch (error) {
            // Electron 32+ 的 File 需要经 preload webUtils 解析；失败时仍可走 Web bytes。
            logger.warn("[v4-composer-attachments] 解析附件本地路径失败", error);
          }
          return createChatComposerAttachment(file, localPath);
        }),
      );
    },
    [addPreparedAttachments, platform],
  );

  return { showAttachmentLimitWarning, addPreparedAttachments, addAttachmentFiles };
}
