import type { ComponentProps, ReactNode } from "react";
import type { ChatMediaAttachmentPreviewTarget } from "@/ChatMediaAttachmentPreviewDialog.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isMediaChatComposerAttachment,
  isPdfChatComposerAttachment,
  isVideoChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { PluginUiModelContextChip } from "@/plugin-ui/index.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import type { useComposerAttachments } from "@/v4/composer/useComposerAttachments.js";
import type { useCodeCommentContexts } from "@/v4/composer/useCodeCommentContexts.js";
import type { useConversationSelectionReferences } from "@/v4/composer/useConversationSelectionReferences.js";
import type { usePptxElementReferences } from "@/v4/composer/usePptxElementReferences.js";
import type { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import type { usePluginUiModelContexts } from "@/plugin-ui/index.js";
import type { useWebElementContexts } from "@/v4/composer/useWebElementContexts.js";
import {
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  testId,
} from "@zcode/shared/test-ids";
import { ClipboardPenLineIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { formatAttachmentLineCount, getComposerAttachmentTypeLabel } from "./helpers.js";

/**
 * Composer 输入框上方的附件 / 上下文 chip 行。
 *
 * 由 `ConversationComposer` 在 useMemo 中调用（依赖不变时 JSX 身份不变），
 * 因此这里保持纯函数形态，不持有自己的状态。
 */

type AttachmentsApi = ReturnType<typeof useComposerAttachments>;
type CodeComments = ReturnType<typeof useCodeCommentContexts>;
type WebElements = ReturnType<typeof useWebElementContexts>;
type PluginUiContexts = ReturnType<typeof usePluginUiModelContexts>;
type PptxReferences = ReturnType<typeof usePptxElementReferences>;
type ConversationSelections = ReturnType<typeof useConversationSelectionReferences>;
type MediaPreviewItems = ComponentProps<typeof ImagePreviewDialog>["items"];
type ComposerAttachment = AttachmentsApi["attachments"][number];

export interface ComposerTopContentInput {
  attachmentsApi: AttachmentsApi;
  composerAttachments: readonly ComposerAttachment[];
  orderedComposerAttachments: readonly ComposerAttachment[];
  composerMediaPreviewItems: MediaPreviewItems;
  attachmentPreviewTitle: string;
  videoAttachmentPreviewTitle: string;
  codeCommentContexts: CodeComments["contexts"];
  removeCodeCommentContext: CodeComments["removeContext"];
  clearCodeCommentContexts: CodeComments["clearContexts"];
  webElementContexts: WebElements["contexts"];
  removeWebElementContext: WebElements["removeContext"];
  clearWebElementContexts: WebElements["clearContexts"];
  pluginUiContexts: PluginUiContexts["contexts"];
  removePluginUiContext: PluginUiContexts["removeContext"];
  clearPluginUiContexts: PluginUiContexts["clearContexts"];
  pptxElementReferences: PptxReferences["references"];
  removePptxElementReference: PptxReferences["removeReference"];
  clearPptxElementReferences: PptxReferences["clearReferences"];
  conversationSelectionReferences: ConversationSelections["references"];
  removeConversationSelectionReference: ConversationSelections["removeReference"];
  clearConversationSelectionReferences: ConversationSelections["clearReferences"];
  openPptxElementReference: ReturnType<typeof useOpenPptxElementReference>;
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  locale: string;
  setAttachmentPreviewIndex: (index: number) => void;
  setAttachmentPreviewOpen: (open: boolean) => void;
  setPdfAttachmentPreview: (target: ChatMediaAttachmentPreviewTarget | null) => void;
  setPdfAttachmentPreviewOpen: (open: boolean) => void;
}

export function buildComposerTopContent({
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
}: ComposerTopContentInput): ReactNode {
  if (
    composerAttachments.length === 0 &&
    codeCommentContexts.length === 0 &&
    webElementContexts.length === 0 &&
    pptxElementReferences.length === 0 &&
    conversationSelectionReferences.length === 0 &&
    pluginUiContexts.length === 0
  ) {
    return null;
  }
  return (
    <div className="flex max-w-full flex-col items-start gap-2">
      {composerAttachments.length > 0 ? (
        <Attachments
          variant="inline"
          className="flex max-w-full flex-wrap gap-2"
          data-composer-file-attachments-row="true"
        >
          {orderedComposerAttachments.map((attachment) => {
            const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
            const isMediaAttachment = isMediaChatComposerAttachment(attachment);
            const isVideoAttachment = isVideoChatComposerAttachment(attachment);
            const isPdfAttachment = isPdfChatComposerAttachment(attachment);
            const mediaType = attachment.objectUrl
              ? attachment.mimeType
              : attachment.mimeType.startsWith("image/")
                ? "application/octet-stream"
                : attachment.mimeType;
            const canPreviewImageAttachment =
              Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
            const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
            const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
            const fileDisplayDescriptor = resolveFileDisplayDescriptor(
              attachment.localPath ?? attachment.filename,
            );
            const uploadStatusLabel =
              attachment.uploadStatus === "uploading"
                ? intl.formatMessage(
                    { id: "chat.attachments.upload.uploading" },
                    { progress: String(attachment.uploadProgress) },
                  )
                : attachment.uploadStatus === "failed"
                  ? intl.formatMessage(
                      { id: "chat.attachments.upload.failed" },
                      { message: attachment.uploadError ?? "unknown" },
                    )
                  : intl.formatMessage({
                      id: `chat.attachments.upload.${attachment.uploadStatus}`,
                    });
            const showUploadStatus =
              !attachment.localZeroCopy &&
              (attachment.uploadStatus !== "ready" || attachment.showComplete);
            return (
              <Attachment
                key={attachment.id}
                variant={isMediaAttachment ? "grid" : "inline"}
                data-composer-attachment-kind={
                  isVideoAttachment
                    ? "video"
                    : isMediaAttachment
                      ? "image"
                      : isPdfAttachment
                        ? "pdf"
                        : "file"
                }
                data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
                data-upload-status={attachment.uploadStatus}
                className={
                  isMediaAttachment
                    ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                    : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
                }
                data={{
                  id: attachment.id,
                  type: "file",
                  filename: attachment.filename,
                  ...(isClipboardTextAttachment
                    ? {
                        description: intl.formatMessage(
                          {
                            id: "chat.attachments.clipboardText.description",
                          },
                          {
                            lineCount: formatAttachmentLineCount(attachment, locale),
                          },
                        ),
                        displayName: intl.formatMessage({
                          id: "chat.attachments.clipboardText",
                        }),
                        sourceKind: "clipboard-text" as const,
                      }
                    : {}),
                  mediaType,
                  url: attachment.objectUrl ?? "",
                }}
                onRemove={() => attachmentsApi.removeAttachment(attachment.id)}
                // 附件支持非图片格式，PDF 走独立 PdfViewer，
                // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
                // 图片与视频统一按添加顺序进入发送前 gallery，
                // 保证同一组媒体可以连续导航。
                onOpen={
                  canPreviewImageAttachment || canPreviewVideoAttachment
                    ? () => {
                        const previewIndex = composerMediaPreviewItems.findIndex(
                          (item) => item.src === attachment.objectUrl,
                        );
                        if (previewIndex < 0) return;
                        setAttachmentPreviewIndex(previewIndex);
                        setAttachmentPreviewOpen(true);
                      }
                    : canPreviewPdfAttachment
                      ? () => {
                          setPdfAttachmentPreview({
                            filename: attachment.filename,
                            mediaType: "application/pdf",
                            url: attachment.objectUrl,
                          });
                          setPdfAttachmentPreviewOpen(true);
                        }
                      : undefined
                }
                openLabel={
                  canPreviewVideoAttachment
                    ? videoAttachmentPreviewTitle
                    : canPreviewImageAttachment
                      ? attachmentPreviewTitle
                      : canPreviewPdfAttachment
                        ? intl.formatMessage({
                            id: "chat.attachments.preview.openPdf",
                          })
                        : undefined
                }
              >
                <div
                  className={cn(
                    "relative shrink-0",
                    isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                  )}
                >
                  <AttachmentPreview
                    className={cn(
                      isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md",
                    )}
                    fallbackIcon={
                      isClipboardTextAttachment ? (
                        <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                      ) : (
                        <FileDisplayIcon
                          src={fileDisplayDescriptor.fileIconSrc}
                          size={16}
                          className="size-4 shrink-0"
                        />
                      )
                    }
                  />
                  {showUploadStatus && isMediaAttachment ? (
                    <span
                      data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                      role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                      aria-label={uploadStatusLabel}
                      className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                    >
                      <svg
                        aria-hidden="true"
                        className="absolute inset-0 size-full -rotate-90 text-brand"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="stroke-border"
                          cx="12"
                          cy="12"
                          fill="none"
                          pathLength="100"
                          r="9"
                          strokeWidth="2"
                        />
                        <circle
                          className={
                            attachment.uploadStatus === "failed"
                              ? "stroke-destructive"
                              : "stroke-current"
                          }
                          cx="12"
                          cy="12"
                          fill="none"
                          pathLength="100"
                          r="9"
                          strokeDasharray={`${attachment.uploadProgress} 100`}
                          strokeLinecap="round"
                          strokeWidth="2"
                        />
                      </svg>
                      <span className="relative">
                        {attachment.uploadStatus === "failed"
                          ? "!"
                          : `${attachment.uploadProgress}%`}
                      </span>
                    </span>
                  ) : null}
                </div>
                {!isMediaAttachment ? (
                  isClipboardTextAttachment ? (
                    <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                  ) : (
                    <div className="min-w-0 max-w-40 flex-1">
                      <span
                        className="block truncate text-ui-base font-medium text-foreground"
                        title={attachment.filename}
                      >
                        {attachment.sourceKind === "topic-history"
                          ? intl.formatMessage(
                              { id: "chat.attachments.topicHistory" },
                              { count: attachment.messageCount ?? 0 },
                            )
                          : attachment.filename}
                      </span>
                      <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                        {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                      </span>
                    </div>
                  )
                ) : null}
                {showUploadStatus && !isMediaAttachment ? (
                  <span
                    data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                    role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                    title={uploadStatusLabel}
                    className={cn(
                      "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                      attachment.uploadStatus === "failed" && "text-destructive",
                    )}
                  >
                    {attachment.uploadStatus === "uploading"
                      ? `${attachment.uploadProgress}%`
                      : uploadStatusLabel}
                  </span>
                ) : null}
                {attachment.uploadStatus === "failed" ? (
                  <button
                    type="button"
                    data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                    aria-label={intl.formatMessage({
                      id: "chat.attachments.upload.retry",
                    })}
                    title={uploadStatusLabel}
                    className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      attachmentsApi.retryAttachment(attachment.id);
                    }}
                  >
                    <RotateCcwIcon className="size-3" />
                  </button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-composer-attachment-remove={attachment.id}
                  aria-label={intl.formatMessage({
                    id: "chat.attachments.remove",
                  })}
                  className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    attachmentsApi.removeAttachment(attachment.id);
                  }}
                >
                  <XIcon className="size-2.5" />
                </Button>
              </Attachment>
            );
          })}
        </Attachments>
      ) : null}
      {codeCommentContexts.length > 0 ||
      webElementContexts.length > 0 ||
      pptxElementReferences.length > 0 ||
      conversationSelectionReferences.length > 0 ||
      pluginUiContexts.length > 0 ? (
        <div
          className="flex max-w-full flex-wrap items-center gap-2"
          data-composer-context-attachments-row="true"
        >
          <CodeCommentAttachmentChip
            comments={codeCommentContexts}
            onRemove={removeCodeCommentContext}
            onRemoveAll={clearCodeCommentContexts}
          />
          <WebElementContextAttachmentChip
            contexts={webElementContexts}
            onRemove={removeWebElementContext}
            onRemoveAll={clearWebElementContexts}
          />
          <PluginUiModelContextChip
            contexts={pluginUiContexts}
            onRemove={removePluginUiContext}
            onRemoveAll={clearPluginUiContexts}
          />
          <PptxElementReferenceChip
            references={pptxElementReferences}
            onOpen={onOpenCodeViewer ? openPptxElementReference : undefined}
            onRemove={removePptxElementReference}
            onRemoveAll={clearPptxElementReferences}
          />
          <ConversationSelectionReferenceChip
            references={conversationSelectionReferences}
            onRemove={removeConversationSelectionReference}
            onRemoveAll={clearConversationSelectionReferences}
          />
        </div>
      ) : null}
    </div>
  );
}
