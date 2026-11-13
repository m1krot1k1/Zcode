import {
  FileDisplayIcon,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import { formatAttachmentSize } from "@/lib/chatAttachmentMetadata.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ArtifactOpenContext,
  resolveImportedArtifactPath,
} from "@/v4/share-readonly-timeline/artifactOpenContext.js";
import type { ArtifactRow } from "@zcode/shared/zcode-protocol-v4";
import { FileTextIcon } from "lucide-react";
import { memo, useContext } from "react";

/** 与正文的 AssistantPreviewCards 对齐：同一套 chat.previewCards.* 副标题词汇。 */
const ARTIFACT_SUBTITLE_MESSAGE_IDS: Readonly<Record<string, string>> = {
  pdf: "chat.previewCards.pdf",
  docx: "chat.previewCards.docx",
  xlsx: "chat.previewCards.xlsx",
  pptx: "chat.previewCards.pptx",
  md: "chat.previewCards.markdown",
  text: "chat.previewCards.text",
  html: "chat.previewCards.htmlWebsite",
};

export const ArtifactPresentation = memo(function ArtifactPresentation({
  row,
  url,
  previewLabel,
}: {
  row: ArtifactRow;
  url?: string;
  previewLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const artifactOpenContext = useContext(ArtifactOpenContext);
  const OpenAction = artifactOpenContext?.openAction;
  // 与 AssistantPreviewCards 保持同一视觉：44px 图标底板 + 真实文件类型图标 + 中粗标题 + 类型副标题。
  const descriptor = resolveFileDisplayDescriptor(row.displayName);
  const subtitleMessageId = ARTIFACT_SUBTITLE_MESSAGE_IDS[row.artifactType];
  const typeLabel = subtitleMessageId
    ? intl.formatMessage({ id: subtitleMessageId })
    : row.artifactType.toUpperCase();
  const localPath =
    artifactOpenContext && !url
      ? resolveImportedArtifactPath(
          artifactOpenContext.workspacePath,
          artifactOpenContext.artifactWorkspaceRelativePaths.get(
            row.artifactVersionId,
          ),
        )
      : null;
  const previewSource: CodeViewerSource | null =
    artifactOpenContext && localPath
      ? {
          type: "file",
          title: row.displayName,
          path: localPath,
          workspacePath: artifactOpenContext.workspacePath,
          ...(artifactOpenContext.workspaceIdentity
            ? { workspaceIdentity: artifactOpenContext.workspaceIdentity }
            : {}),
          ...(artifactOpenContext.workspaceRemoteSessionId
            ? {
                workspaceRemoteSessionId:
                  artifactOpenContext.workspaceRemoteSessionId,
              }
            : {}),
        }
      : null;
  return (
    // ReadonlyTurn 已提供与正文一致的水平 inset，这里再加 px-4 会让资源卡片两侧各多缩进 16px。
    <div data-conversation-share-row-kind="artifact" className="py-1">
      <div className="flex w-full items-center gap-3 rounded-xl border border-card-border bg-card p-3 pr-4 text-foreground">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-background text-foreground-subtle">
          {descriptor ? (
            <FileDisplayIcon src={descriptor.fileIconSrc} size={24} />
          ) : (
            <FileTextIcon className="size-6" aria-hidden="true" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-ui-base font-medium leading-5">
            {row.displayName}
          </p>
          <p className="truncate text-ui-base leading-5 text-foreground-subtlest">
            {typeLabel} · {formatAttachmentSize(row.sizeBytes)}
          </p>
        </div>
        {url ? (
          // 与正文卡片右侧的 OpenSplitButton 同一视觉（h-7 圆角描边 + input 底色）；
          // 资源 URL 实际触发下载，原「预览文件」文案会误导用户；分享页只保留「下载文件」动作。
          // data-share-preview-button 是测试断言用的结构性标记：语义锁定不依赖 Tailwind 类字符串。
          <div
            data-share-preview-button="true"
            className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
          >
            <button
              type="button"
              className="flex h-7 items-center gap-1 px-2 text-ui-sm text-foreground"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            >
              {previewLabel}
            </button>
          </div>
        ) : previewSource && OpenAction ? (
          <OpenAction
            target={{
              type: "file",
              path: previewSource.path,
              title: row.displayName,
              label: row.displayName,
              previewSource,
            }}
            onOpenFileLink={artifactOpenContext?.onOpenFileLink}
            onOpenCodeViewer={artifactOpenContext?.onOpenCodeViewer}
          />
        ) : null}
      </div>
    </div>
  );
});
