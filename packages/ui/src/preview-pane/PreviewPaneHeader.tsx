// PreviewPane 拆分（max-lines）：顶部路径面包屑 + 显示选项 / 文件动作 / 打开方式工具条。
import { Fragment } from "react";
import {
  ChevronRightIcon,
  CopyIcon,
  Ellipsis,
  ExternalLinkIcon,
  EyeIcon,
  FileCode2Icon,
} from "lucide-react";
import type { EditorInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayIcon } from "@/lib/fileDisplay.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { BREADCRUMB_MASK_CLASS_BY_STATE, type CodeViewerBreadcrumbData } from "./constants.js";
import { usePreviewPaneBreadcrumbScroll } from "./usePreviewPaneBreadcrumbScroll.js";

export interface PreviewPaneHeaderProps {
  source: CodeViewerSource;
  breadcrumb: CodeViewerBreadcrumbData | null;
  intl: IntlInstance;
  /** 文件管理器把面包屑与目录开关放在同一工具栏，此时不再自带背景与分隔线。 */
  headerContainer?: HTMLElement | null;
  showDocumentHeaderDivider: boolean;
  hasMoreMenu: boolean;
  canToggleMarkdownView: boolean;
  canToggleSvgView: boolean;
  canToggleCodeWrap: boolean;
  markdownViewMode: "preview" | "code";
  svgViewMode: "preview" | "code";
  wrapLongLines: boolean;
  onMarkdownViewModeChange: (mode: "preview" | "code") => void;
  onSvgViewModeChange: (mode: "preview" | "code") => void;
  onWrapLongLinesChange: (wrap: boolean) => void;
  sourceWorkspacePath?: string;
  fileActions: ReturnType<typeof useFileContextActions>;
  canOpenDiffFilePreview: boolean;
  onOpenDiffFilePreview: () => void;
  selectedEditor: EditorInfo | null;
  canOpenInEditor: boolean;
  onOpenInEditor: () => void;
}

export function PreviewPaneHeader({
  source,
  breadcrumb,
  intl,
  headerContainer,
  showDocumentHeaderDivider,
  hasMoreMenu,
  canToggleMarkdownView,
  canToggleSvgView,
  canToggleCodeWrap,
  markdownViewMode,
  svgViewMode,
  wrapLongLines,
  onMarkdownViewModeChange,
  onSvgViewModeChange,
  onWrapLongLinesChange,
  sourceWorkspacePath,
  fileActions,
  canOpenDiffFilePreview,
  onOpenDiffFilePreview,
  selectedEditor,
  canOpenInEditor,
  onOpenInEditor,
}: PreviewPaneHeaderProps) {
  const { breadcrumbScrollRef, breadcrumbContentRef, breadcrumbMaskState } =
    usePreviewPaneBreadcrumbScroll({ breadcrumb, headerContainer });

  return (
    <div
      className={cn(
        "flex h-10 min-w-0 shrink-0 items-center gap-2",
        !headerContainer && "bg-surface/30",
        !headerContainer && showDocumentHeaderDivider && "border-b border-border",
      )}
    >
      <div
        ref={breadcrumbScrollRef}
        className={cn(
          "min-w-0 flex-1 overflow-x-auto !scrollbar-hide",
          BREADCRUMB_MASK_CLASS_BY_STATE[breadcrumbMaskState],
        )}
      >
        <div
          ref={breadcrumbContentRef}
          className="flex min-w-max items-center px-3 gap-0.5 text-ui-base text-foreground-subtle"
        >
          {breadcrumb?.rootLabel ? (
            <span className="shrink-0 text-foreground-subtle">{breadcrumb.rootLabel}</span>
          ) : null}
          {breadcrumb?.rootLabel ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          ) : null}
          {breadcrumb?.parentSegments.map((segment, index) => (
            <Fragment key={`${segment}-${index}`}>
              <span className="shrink-0">{segment}</span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
            </Fragment>
          ))}

          <span className="inline-flex min-w-0 items-center gap-1 text-foreground">
            {breadcrumb?.fileIconSrc ? (
              <FileDisplayIcon src={breadcrumb.fileIconSrc} size={14} className="shrink-0" />
            ) : null}
            <span className="truncate">{breadcrumb?.fileLabel ?? source.title}</span>
          </span>
        </div>
      </div>

      <div className="flex shrink-0 pr-1.5 items-center gap-2">
        {canOpenDiffFilePreview ? (
          <Button
            type="button"
            size="default"
            variant="ghost"
            className="shrink-0 rounded-lg text-foreground-subtle hover:text-foreground"
            data-diff-source-preview-trigger
            onClick={onOpenDiffFilePreview}
            title={intl.formatMessage({
              id: "codeViewer.openSourcePreview",
            })}
            aria-label={intl.formatMessage({
              id: "codeViewer.openSourcePreview",
            })}
          >
            <FileCode2Icon className="size-3.5" data-icon="inline-start" />
            <span>
              {intl.formatMessage({
                id: "codeViewer.openSourcePreview",
              })}
            </span>
          </Button>
        ) : null}
        {/* Bugfix: 图片和 patch 这类预览没有任何显示选项，继续渲染触发器会打开空菜单，所以只在存在菜单项时显示更多按钮。 */}
        {hasMoreMenu || source.path ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={intl.formatMessage({ id: "common.more" })}
                title={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canToggleMarkdownView ? (
                <>
                  <DropdownMenuLabel>
                    {intl.formatMessage({ id: "codeViewer.markdownMode" })}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={markdownViewMode}
                    onValueChange={(value) => {
                      onMarkdownViewModeChange(value as "preview" | "code");
                    }}
                  >
                    <DropdownMenuRadioItem value="preview">
                      <EyeIcon className="size-4" />
                      {intl.formatMessage({
                        id: "codeViewer.markdownPreview",
                      })}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="code">
                      <FileCode2Icon className="size-4" />
                      {intl.formatMessage({
                        id: "codeViewer.markdownSource",
                      })}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
              {canToggleSvgView ? (
                <>
                  {canToggleMarkdownView ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>
                    {intl.formatMessage({ id: "codeViewer.svgMode" })}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={svgViewMode}
                    onValueChange={(value) => {
                      onSvgViewModeChange(value as "preview" | "code");
                    }}
                  >
                    <DropdownMenuRadioItem value="preview">
                      <EyeIcon className="size-4" />
                      {intl.formatMessage({ id: "codeViewer.svgPreview" })}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="code">
                      <FileCode2Icon className="size-4" />
                      {intl.formatMessage({ id: "codeViewer.svgSource" })}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
              {canToggleCodeWrap ? (
                <>
                  {canToggleMarkdownView || canToggleSvgView ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuCheckboxItem
                    checked={wrapLongLines}
                    onCheckedChange={(checked) => {
                      onWrapLongLinesChange(Boolean(checked));
                    }}
                  >
                    <FileCode2Icon className="size-4" />
                    {intl.formatMessage({ id: "codeViewer.wrapLines" })}
                  </DropdownMenuCheckboxItem>
                </>
              ) : null}
              {source.path ? (
                <>
                  {hasMoreMenu ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    onSelect={() => void fileActions.copyAbsolutePath({ path: source.path! })}
                  >
                    <CopyIcon className="size-4" />
                    {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void fileActions.copyRelativePath({
                        path: source.path!,
                        relativePath: sourceWorkspacePath
                          ? getWorkspaceFileRelativePath(sourceWorkspacePath, source.path!)
                          : source.path!,
                      })
                    }
                  >
                    <CopyIcon className="size-4" />
                    {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {/* 第一期 PPTX 明确为只读预览，不展示任何编辑入口。 */}
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          className="shrink-0 text-foreground-subtle hover:text-foreground disabled:text-foreground-subtlest"
          onClick={onOpenInEditor}
          disabled={!canOpenInEditor}
          title={
            selectedEditor
              ? intl.formatMessage(
                  { id: "appHeader.openInEditor" },
                  { editor: selectedEditor.name },
                )
              : intl.formatMessage({ id: "chat.changeSummary.openInEditor" })
          }
          aria-label={
            selectedEditor
              ? intl.formatMessage(
                  { id: "appHeader.openInEditor" },
                  { editor: selectedEditor.name },
                )
              : intl.formatMessage({ id: "chat.changeSummary.openInEditor" })
          }
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
