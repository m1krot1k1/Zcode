import { createPortal } from "react-dom";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TID_PREVIEW_PANE } from "@zcode/shared/test-ids";
import { createDiffSourceFilePreviewSource, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { usePptxFileWatch } from "@/hooks/usePptxFileWatch.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PreviewPaneContent } from "@/previewPaneContent.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import {
  buildCodeViewerBreadcrumb,
  resolvePreviewPaneImageFileReference,
} from "./preview-pane/breadcrumb.js";
import { EMPTY_CODE_COMMENT_PREVIEWS } from "./preview-pane/constants.js";
import { PreviewPaneDeferredHeavyContent } from "./preview-pane/PreviewPaneDeferredHeavyContent.js";
import { PreviewPaneHeader } from "./preview-pane/PreviewPaneHeader.js";
import {
  getPreviewPaneDisplayOptions,
  resolvePreviewPaneImageSource,
  resolvePreviewPaneInitialViewModes,
  resolvePreviewPaneMediaSource,
  resolvePreviewPanePdfSource,
  resolvePreviewPanePptxSource,
  shouldShowPreviewPaneHeaderDivider,
} from "./preview-pane/sources.js";
import { usePreviewPaneCodeCommentActions } from "./preview-pane/usePreviewPaneCodeCommentActions.js";
import { usePreviewPaneEditorActions } from "./preview-pane/usePreviewPaneEditorActions.js";
import { usePreviewPanePreviewData } from "./preview-pane/usePreviewPanePreviewData.js";
import { usePreviewPaneScrollMemory } from "./preview-pane/usePreviewPaneScrollMemory.js";

export function PreviewPane({
  source: rawSource,
  workspacePath,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  renderHeavyContent = true,
  headerContainer,
  markdownSelectionTarget,
}: {
  source: CodeViewerSource | null;
  onClose: () => void;
  workspacePath?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  renderHeavyContent?: boolean;
  /** 文件管理器将面包屑与目录开关放在同一工具栏，仍由预览维护文件操作。 */
  headerContainer?: HTMLElement | null;
  markdownSelectionTarget?: MarkdownSelectionTarget;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const source = useMemo(
    () => (rawSource ? normalizeCodeViewerSource(rawSource) : null),
    [rawSource],
  );
  const sourceWorkspacePath = source?.workspacePath ?? workspacePath;
  const imageFileReference = useMemo(
    () =>
      resolvePreviewPaneImageFileReference(
        source,
        workspacePath,
        markdownSelectionTarget?.workspaceKey,
      ),
    [source, workspacePath, markdownSelectionTarget?.workspaceKey],
  );
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: sourceWorkspacePath,
    workspaceIdentity: source?.workspaceIdentity,
    workspaceRemoteSessionId: source?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    source?.workspaceIdentity ||
    source?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  const fileActions = useFileContextActions();
  const { fileService, fileWatcherService, mediaPreviewService } = useWorkspaceServices(
    sourceWorkspacePath,
    source?.workspaceRemoteSessionId,
    source?.workspaceIdentity,
  );
  const sourceFilePath = source?.path;
  const loadImageDownloadSource = useCallback(async () => {
    if (!sourceFilePath) throw new Error("Image source path is unavailable");
    // SVG 文本预览按 UTF-8 解码；下载必须从同一来源 Host 读取原字节，保留其他编码及 XML 声明。
    const original = await fileService.readMediaPreview({ path: sourceFilePath });
    return `data:${original.mediaType};base64,${original.dataBase64}`;
  }, [fileService, sourceFilePath]);
  // 各预览读取通道共用同一滚动容器：切源时复位，折叠重内容前记录位置。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const imageSource = useMemo(() => resolvePreviewPaneImageSource(source), [source]);
  const mediaSource = useMemo(() => resolvePreviewPaneMediaSource(source), [source]);
  const pdfSource = useMemo(() => resolvePreviewPanePdfSource(source), [source]);
  const officePreviewKind = useMemo(
    () => (source?.type === "file" ? getOfficeFilePreviewKind(source.path) : null),
    [source],
  );
  const pptxSource = useMemo(() => resolvePreviewPanePptxSource(source), [source]);
  const showDocumentHeaderDivider = shouldShowPreviewPaneHeaderDivider(source);
  const pptxSourcePath = pptxSource?.path ?? null;
  const { ready: pptxFileWatchReady, reloadGeneration: pptxReloadGeneration } = usePptxFileWatch({
    filePath: pptxSourcePath,
    fileWatcherService,
  });
  const fileSource =
    (source?.type === "file" || source?.type === "code-review") &&
    !imageSource &&
    !pdfSource &&
    !officePreviewKind &&
    !pptxSource &&
    !mediaSource
      ? source
      : null;
  // 文本/图片/媒体/PDF/Office/PPTX 读取与 error 状态统一由该 hook 持有；
  // 子 hook 的调用顺序就是拆分前各 effect 的注册顺序。
  const previewData = usePreviewPanePreviewData({
    fileService,
    mediaPreviewService,
    fileSource,
    imageSource,
    mediaSource,
    pdfSource,
    officePreviewKind,
    source,
    pptxSource,
    pptxSourcePath,
    pptxFileWatchReady,
    pptxReloadGeneration,
    intl,
    scrollContainerRef,
  });
  const { onScroll, deferredBodyStyle } = usePreviewPaneScrollMemory({
    renderHeavyContent,
    filePreview: previewData.filePreview,
    source,
    scrollContainerRef,
  });
  const diffFilePreviewSource = useMemo(
    () =>
      source?.type === "patch" || source?.type === "multi-file-diff"
        ? createDiffSourceFilePreviewSource(source, sourceWorkspacePath)
        : null,
    [source, sourceWorkspacePath],
  );
  const codeCommentBucket = useMemo(
    () =>
      source?.type !== "code-review" && source?.path && sourceWorkspacePath
        ? {
            workspacePath: sourceWorkspacePath,
            workspaceIdentity: source.workspaceIdentity,
            sourcePath: source.path,
          }
        : null,
    [source, sourceWorkspacePath],
  );
  const codeComments = useCodeCommentPreviewStore((state) =>
    // code-review 不读取 Composer 评论 store，但这里每次 selector 求值都不能返回新的 []，
    // 否则会破坏 useSyncExternalStore 的稳定 snapshot 契约并触发无限更新。
    codeCommentBucket ? state.getComments(codeCommentBucket) : EMPTY_CODE_COMMENT_PREVIEWS,
  );
  const addCodeCommentPreview = useCodeCommentPreviewStore((state) => state.addComment);
  const removeCodeCommentPreview = useCodeCommentPreviewStore((state) => state.removeComment);
  const breadcrumb = useMemo(
    () => (source ? buildCodeViewerBreadcrumb(source, sourceWorkspacePath) : null),
    [source, sourceWorkspacePath],
  );
  const editorFilePath = source?.type !== "code-review" ? source?.path : undefined;
  const { selectedEditor, canOpenInEditor, handleOpenInEditor } = usePreviewPaneEditorActions({
    platform,
    source,
    editorFilePath,
    isRemoteSource,
    openInEditorRemoteTarget,
  });
  const canOpenDiffFilePreview = Boolean(diffFilePreviewSource && onOpenCodeViewer);
  const canCreateCodeComment = Boolean(
    source?.type !== "code-review" && source?.path && sourceWorkspacePath,
  );
  const [markdownViewMode, setMarkdownViewMode] = useState<"preview" | "code">("preview");
  const [svgViewMode, setSvgViewMode] = useState<"preview" | "code">("preview");
  const [wrapLongLinesOverride, setWrapLongLinesOverride] = useState<boolean | null>(null);
  const wrapLongLines = wrapLongLinesOverride ?? codePreviewSettings.wrapLongLines;
  const displayOptions = useMemo(
    () =>
      getPreviewPaneDisplayOptions(source, {
        markdownViewMode,
        svgViewMode,
      }),
    [markdownViewMode, source, svgViewMode],
  );
  const { canToggleCodeWrap, canToggleMarkdownView, canToggleSvgView, hasMoreMenu } =
    displayOptions;
  const codeCommentLabels = useMemo(
    () => ({
      addComment: intl.formatMessage({ id: "codeViewer.comment.add" }),
      addCommentTooltip: intl.formatMessage({
        id: "codeViewer.comment.addTooltip",
      }),
      commentPlaceholder: intl.formatMessage({
        id: "codeViewer.comment.placeholder",
      }),
      submitComment: intl.formatMessage({ id: "codeViewer.comment.submit" }),
      cancelComment: intl.formatMessage({ id: "common.cancel" }),
      deleteComment: intl.formatMessage({ id: "codeViewer.comment.delete" }),
      commentLine: intl.formatMessage({ id: "codeViewer.comment.line" }),
      commentRange: intl.formatMessage({ id: "codeViewer.comment.range" }),
    }),
    [intl],
  );
  // PDF / PPTX 的标签与 dwf 的 workflow-artifact tab 共用一份（见该 hook 的注释）：
  // 两个 labels 接口都是必填全字段，各写一份漏的不会是类型错误，而是一句没翻译的文案。
  const pdfViewerLabels = usePdfViewerLabels();
  const pptxViewerLabels = usePptxViewerLabels();
  const resolvedTheme = resolveTheme(theme);
  const codeTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;

  useEffect(() => {
    if (!source) {
      return;
    }

    const initialViewModes = resolvePreviewPaneInitialViewModes(source);
    setMarkdownViewMode(initialViewModes.markdownViewMode);
    setSvgViewMode(initialViewModes.svgViewMode);
    setWrapLongLinesOverride(null);
  }, [source]);

  const { onSubmitCodeComment, onDeleteCodeComment } = usePreviewPaneCodeCommentActions({
    source,
    sourceWorkspacePath,
    intl,
    addCodeCommentPreview,
    removeCodeCommentPreview,
  });

  if (!source) {
    return null;
  }

  const handleOpenDiffFilePreview = () => {
    if (!diffFilePreviewSource) {
      return;
    }

    onOpenCodeViewer?.(diffFilePreviewSource);
  };

  const pptxReferenceNavigation = pptxSource?.referenceNavigation ?? null;
  const pptxReferenceNavigationReady =
    pptxReferenceNavigation !== null &&
    previewData.validatedPptxReferenceNavigationRequestId === pptxReferenceNavigation.requestId;

  const header = (
    <PreviewPaneHeader
      source={source}
      breadcrumb={breadcrumb}
      intl={intl}
      headerContainer={headerContainer}
      showDocumentHeaderDivider={showDocumentHeaderDivider}
      hasMoreMenu={hasMoreMenu}
      canToggleMarkdownView={canToggleMarkdownView}
      canToggleSvgView={canToggleSvgView}
      canToggleCodeWrap={canToggleCodeWrap}
      markdownViewMode={markdownViewMode}
      svgViewMode={svgViewMode}
      wrapLongLines={wrapLongLines}
      onMarkdownViewModeChange={setMarkdownViewMode}
      onSvgViewModeChange={setSvgViewMode}
      onWrapLongLinesChange={setWrapLongLinesOverride}
      sourceWorkspacePath={sourceWorkspacePath}
      fileActions={fileActions}
      canOpenDiffFilePreview={canOpenDiffFilePreview}
      onOpenDiffFilePreview={handleOpenDiffFilePreview}
      selectedEditor={selectedEditor}
      canOpenInEditor={canOpenInEditor}
      onOpenInEditor={() => {
        void handleOpenInEditor();
      }}
    />
  );

  return (
    <aside
      data-testid={TID_PREVIEW_PANE}
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      {headerContainer ? createPortal(header, headerContainer) : header}
      <div className="min-h-0 flex-1">
        {renderHeavyContent ? (
          <PreviewPaneContent
            source={pptxSource ?? imageSource ?? pdfSource ?? mediaSource ?? source}
            filePreview={previewData.filePreview}
            fileTooLarge={previewData.fileTooLarge}
            loadingInitial={previewData.loadingInitial}
            loadingImagePreview={previewData.loadingImagePreview}
            imagePreview={previewData.imagePreview}
            imageFileReference={imageFileReference}
            loadImageDownloadSource={sourceFilePath ? loadImageDownloadSource : undefined}
            mediaSource={mediaSource}
            loadingMediaPreview={previewData.loadingMediaPreview}
            mediaPreviewUrl={previewData.mediaPreviewUrl}
            onMediaError={previewData.onMediaError}
            onMediaLoadedMetadata={previewData.onMediaLoadedMetadata}
            loadingPdfPreview={previewData.loadingPdfPreview}
            pdfViewerSource={previewData.pdfViewerSource}
            pdfViewerLabels={pdfViewerLabels}
            loadingOfficePreview={previewData.loadingOfficePreview}
            officePreview={previewData.officePreview}
            officePreviewKind={officePreviewKind}
            loadingPptxPreview={previewData.loadingPptxPreview}
            pptxPreviewData={previewData.pptxPreviewData}
            pptxViewerLabels={pptxViewerLabels}
            pptxReferenceSource={
              pptxSource && sourceWorkspacePath
                ? {
                    workspacePath: sourceWorkspacePath,
                    ...(pptxSource.workspaceIdentity
                      ? { workspaceIdentity: pptxSource.workspaceIdentity }
                      : {}),
                    ...(pptxSource.workspaceRemoteSessionId
                      ? { remoteSessionId: pptxSource.workspaceRemoteSessionId }
                      : {}),
                    sourcePath: pptxSource.path,
                    sourceTitle: pptxSource.title,
                  }
                : null
            }
            pptxReferenceNavigation={pptxReferenceNavigation}
            pptxReferenceNavigationReady={pptxReferenceNavigationReady}
            error={previewData.error}
            codePreviewSettings={codePreviewSettings}
            codeTheme={codeTheme}
            resolvedTheme={resolvedTheme}
            theme={theme}
            workspacePath={sourceWorkspacePath}
            onOpenBrowserUrl={onOpenBrowserUrl}
            markdownSelectionTarget={
              markdownSelectionTarget &&
              (source.workspaceIdentity?.trim() || sourceWorkspacePath) ===
                markdownSelectionTarget.workspaceKey
                ? markdownSelectionTarget
                : undefined
            }
            markdownViewMode={markdownViewMode}
            svgViewMode={svgViewMode}
            wrapLongLines={wrapLongLines}
            codeComments={codeComments}
            enableCodeLineSelection={canCreateCodeComment}
            enableCodeGutterUtility={canCreateCodeComment}
            codeCommentLabels={codeCommentLabels}
            onSubmitCodeComment={onSubmitCodeComment}
            onDeleteCodeComment={onDeleteCodeComment}
            // PreviewPane 外层只是 flex 壳，真实滚动发生在具体内容组件的 overflow 容器。
            // 折叠侧边面板卸载重内容前必须保存该容器的位置。
            onScroll={onScroll}
            scrollContainerRef={scrollContainerRef}
          />
        ) : (
          <PreviewPaneDeferredHeavyContent style={deferredBodyStyle} />
        )}
      </div>
    </aside>
  );
}

export {
  getPreviewPaneSafeErrorMessage,
  isPreviewPaneFileTooLargeError,
  isPreviewPaneMissingFileError,
  resolvePptxPreviewReadErrorMessage,
  shouldToastPptxReferenceFileMissing,
} from "./preview-pane/errors.js";
export { resolvePreviewPaneImageFileReference } from "./preview-pane/breadcrumb.js";
export {
  getPreviewPaneDisplayOptions,
  isPptxPreviewFileTooLarge,
  resolveMediaPlaybackErrorMessageId,
  resolvePreviewPaneImageSource,
  resolvePreviewPaneMediaSource,
  resolvePreviewPanePdfSource,
  resolvePreviewPanePptxSource,
  resolvePreviewPaneTextFileResult,
  shouldShowPreviewPaneHeaderDivider,
} from "./preview-pane/sources.js";
