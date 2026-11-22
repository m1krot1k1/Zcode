/**
 * composer 附件表面交互：文件选择器、粘贴（文件 / 文本）、白板引用注入。
 * 这些入口都只做事件转录与错误文案，接纳与上传仍由准入 / 引擎负责。
 */
import { useCallback, useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { ChatComposerPasteEvent } from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { readComposerAttachmentScope } from "@/store/composerAttachmentUploadStore.js";
import {
  MAX_CHAT_ATTACHMENTS,
  createChatComposerPathAttachment,
  createClipboardTextAttachmentFilenameForDate,
  createClipboardTextPathComposerAttachment,
  shouldCreateClipboardTextAttachment,
  shouldPreferSpreadsheetClipboardText,
} from "@/lib/chatAttachments.js";
import {
  WHITEBOARD_ADD_TO_CHAT_EVENT,
  buildWhiteboardWorkspaceKey,
  createWhiteboardPngFile,
  isWhiteboardAddToChatEvent,
} from "@/lib/whiteboard.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { selectAttachmentLocalPaths } from "./attachmentUploadHelpers.js";
import type { ComposerAttachmentAdmission } from "./useComposerAttachmentAdmission.js";
import type { AttachmentUploadEngine } from "./useAttachmentUploadEngine.js";

export interface ComposerAttachmentSurfaceOptions {
  engine: AttachmentUploadEngine;
  admission: ComposerAttachmentAdmission;
  scopeKey: string;
  platform: IPlatformService;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  disabled: boolean;
  listenAddToChatEvents: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ComposerAttachmentSurface {
  attachmentInputRef: React.RefObject<HTMLInputElement | null>;
  openAttachmentPicker: () => void;
  handleAttachmentInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (event: ChatComposerPasteEvent) => void;
  handleWhiteboardMentionSelected: (boardId: string) => Promise<void>;
}

export function useComposerAttachmentSurface({
  engine,
  admission,
  scopeKey,
  platform,
  intl,
  disabled,
  listenAddToChatEvents,
  workspacePath,
  workspaceIdentity,
}: ComposerAttachmentSurfaceOptions): ComposerAttachmentSurface {
  const { setAttachmentError } = engine;
  const { addPreparedAttachments, addAttachmentFiles, showAttachmentLimitWarning } = admission;
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  const addAttachmentLocalPaths = useCallback(
    (selectedPaths: string[]) => {
      addPreparedAttachments(selectedPaths.map(createChatComposerPathAttachment));
    },
    [addPreparedAttachments],
  );

  const openAttachmentPicker = useCallback(() => {
    if (readComposerAttachmentScope(scopeKey).length >= MAX_CHAT_ATTACHMENTS) {
      showAttachmentLimitWarning();
      return;
    }
    if (!platform.canSelectFilePath) {
      attachmentInputRef.current?.click();
      return;
    }
    void selectAttachmentLocalPaths(platform)
      .then((paths) => addAttachmentLocalPaths(paths))
      .catch((error) => {
        logger.warn("[v4-composer-attachments] 选择附件路径失败", error);
        setAttachmentError(
          intl.formatMessage(
            { id: "chat.attachments.readFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      });
  }, [
    addAttachmentLocalPaths,
    intl,
    platform,
    scopeKey,
    setAttachmentError,
    showAttachmentLimitWarning,
  ]);

  const handleAttachmentInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      addAttachmentFiles(files);
    },
    [addAttachmentFiles],
  );

  const handlePaste = useCallback(
    (event: ChatComposerPasteEvent) => {
      if (disabled || !event.clipboardData) return;
      const files = Array.from(event.clipboardData.files);
      const text = event.clipboardData.getData("text/plain");
      const html = event.clipboardData.getData("text/html");
      const prefersSpreadsheetText =
        files.length > 0 && shouldPreferSpreadsheetClipboardText(text, html);
      if (files.length > 0) {
        logger.debug("[v4-composer-attachments] 识别剪贴板多表示 payload", {
          clipboardTypes: Array.from(event.clipboardData.types),
          fileTypes: files.map((file) => file.type),
          prefersSpreadsheetText,
          textLength: text.length,
        });
      }
      if (files.length > 0 && !prefersSpreadsheetText) {
        event.preventDefault();
        event.stopPropagation?.();
        addAttachmentFiles(files);
        return;
      }
      if (!shouldCreateClipboardTextAttachment(text)) return;
      event.preventDefault();
      event.stopPropagation?.();
      void (async () => {
        try {
          const attachment = await platform.createTempTextAttachment?.({
            text,
            filename: createClipboardTextAttachmentFilenameForDate(),
          });
          if (!attachment) throw new Error("当前平台不支持临时文本附件");
          addPreparedAttachments([createClipboardTextPathComposerAttachment(text, attachment)]);
        } catch (error) {
          logger.warn("[v4-composer-attachments] 创建粘贴文本临时附件失败", error);
          setAttachmentError(
            intl.formatMessage(
              { id: "chat.attachments.readFailed" },
              { message: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      })();
    },
    [addAttachmentFiles, addPreparedAttachments, disabled, intl, platform, setAttachmentError],
  );

  const addWhiteboardToChat = useCallback(
    async (boardId: string) => {
      const board = useWhiteboardStore.getState().getBoard({
        boardId,
        workspaceIdentity,
        workspacePath,
      });
      if (!board) {
        setAttachmentError(intl.formatMessage({ id: "whiteboard.exportMissing" }));
        return;
      }
      try {
        addAttachmentFiles([createWhiteboardPngFile(board)]);
      } catch (error) {
        setAttachmentError(
          intl.formatMessage(
            { id: "whiteboard.exportFailed" },
            { message: error instanceof Error ? error.message : String(error) },
          ),
        );
      }
    },
    [addAttachmentFiles, intl, setAttachmentError, workspaceIdentity, workspacePath],
  );
  const handleWhiteboardMentionSelected = useCallback(
    async (boardId: string) => addWhiteboardToChat(boardId),
    [addWhiteboardToChat],
  );
  useEffect(() => {
    // 与 useWebElementContexts 等同款早退。SidePane forceMount 使非聚焦
    // 会话的 SessionPane 常驻，只有聚焦 composer（listenAddToChatEvents）才允许消费
    // add-to-chat 事件，否则同 workspace 的多个 composer 会同时注入附件。
    if (!listenAddToChatEvents || typeof window === "undefined") return;
    const handle = (event: Event) => {
      if (!isWhiteboardAddToChatEvent(event)) return;
      if (
        buildWhiteboardWorkspaceKey(event.detail) !==
        buildWhiteboardWorkspaceKey({ workspacePath, workspaceIdentity })
      ) {
        return;
      }
      event.preventDefault();
      void addWhiteboardToChat(event.detail.boardId);
    };
    window.addEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
    return () => window.removeEventListener(WHITEBOARD_ADD_TO_CHAT_EVENT, handle);
  }, [addWhiteboardToChat, listenAddToChatEvents, workspaceIdentity, workspacePath]);

  return {
    attachmentInputRef,
    openAttachmentPicker,
    handleAttachmentInputChange,
    handlePaste,
    handleWhiteboardMentionSelected,
  };
}
