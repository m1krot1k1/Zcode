import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { EMPTY_ATTACHMENTS } from "@/v4/share-readonly-timeline/constants.js";
import { formatAttachmentSize } from "@/lib/chatAttachmentMetadata.js";
import { logger } from "@/logger.js";
import { FileTextIcon } from "lucide-react";
import { useState } from "react";

function UserInputAttachment({
  attachment,
  artifactUrls,
}: {
  attachment: NonNullable<UserInputRow["attachments"]>[number];
  artifactUrls: ReadonlyMap<string, string>;
}) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>();
  const url = artifactUrls.get(attachment.ref.split("/").at(-1) ?? "");
  const previewUrl = attachment.previewRef
    ? artifactUrls.get(attachment.previewRef.split("/").at(-1) ?? "")
    : undefined;
  const imageSrc = attachment.mime.startsWith("image/")
    ? (previewUrl ?? url)
    : undefined;
  // Bug 根因：只读分享把所有输入附件都画成文件 pill，丢失了已上传图片的展示。
  // 复用公开 manifest 地址取图；不读取原宿主文件，失败时仍保留原附件下载入口。
  if (imageSrc && failedPreviewUrl !== imageSrc) {
    return (
      <a
        href={url}
        target={url ? "_blank" : undefined}
        rel={url ? "noopener noreferrer" : undefined}
        aria-disabled={url ? undefined : "true"}
        title={attachment.fileName}
        className="block size-24 max-w-full overflow-hidden rounded-lg border border-border bg-surface hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      >
        <img
          src={imageSrc}
          alt={attachment.fileName}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => {
            setFailedPreviewUrl(imageSrc);
            // 签名下载地址可能含凭据，诊断仅记录 MIME，不输出 URL 或附件名。
            logger.warn("[share-input-image] preview failed", {
              mime: attachment.mime,
            });
          }}
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      target={url ? "_blank" : undefined}
      rel={url ? "noopener noreferrer" : undefined}
      aria-disabled={url ? undefined : "true"}
      className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-foreground hover:bg-surface-hover"
      data-v4-user-input-attachment-pill="true"
    >
      <FileTextIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 max-w-64 truncate">{attachment.fileName}</span>
      <span className="shrink-0 text-foreground-subtlest">
        {formatAttachmentSize(attachment.bytes)}
      </span>
    </a>
  );
}

export function UserInputPresentation({
  row,
  artifactUrls,
}: {
  row: UserInputRow;
  artifactUrls: ReadonlyMap<string, string>;
}) {
  const attachments = row.attachments ?? [];
  return (
    <div
      className="flex flex-col items-end"
      data-conversation-share-row-kind="userInput"
    >
      {attachments.length > 0 ? (
        <div
          className="mb-2 flex w-full max-w-xl flex-wrap items-start justify-end gap-2"
          data-v4-user-input-attachments="true"
        >
          {attachments.map((attachment, index) => (
            <UserInputAttachment
              key={`${attachment.ref}-${index}`}
              attachment={attachment}
              artifactUrls={artifactUrls}
            />
          ))}
        </div>
      ) : null}
      <div
        data-v4-user-input-bubble="true"
        className="flex max-w-xl flex-col gap-2 rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground"
      >
        <ConversationUserInputBody contentText={row.text} rowId={row.rowId}>
          <ConversationUserInputContent
            text={row.text}
            attachments={row.attachments ?? EMPTY_ATTACHMENTS}
          />
        </ConversationUserInputBody>
      </div>
    </div>
  );
}
