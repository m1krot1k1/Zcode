// PreviewPane 拆分（max-lines）：把 CodeViewerSource 归一化成图片 / 媒体 / PDF / PPTX 专用源，
// 以及决定代码视图显示选项的纯函数。这里不做任何读取，可单独测试。
import type { FileTextSlice } from "@zcode/shared";
import {
  inferImageMediaType,
  inferMediaPreview,
  isPdfPreviewPath,
  isPptxPreviewPath,
  type CodeViewerSource,
  type MediaCodeViewerSource,
} from "@/lib/codeViewer.js";
import { getOfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { PPTX_MAX_FILE_BYTES } from "./constants.js";

function isMarkdownSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.language === "markdown";
}

function isSvgSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.path?.toLowerCase().endsWith(".svg") === true;
}

function isMarkdownFilePath(path?: string): boolean {
  if (!path) {
    return false;
  }

  const normalizedPath = path.toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function isSvgFilePath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

function getFileImageMediaType(path?: string): string | null {
  const mediaType = inferImageMediaType(path);
  return mediaType && mediaType !== "image/svg+xml" ? mediaType : null;
}

export function resolvePreviewPaneTextFileResult(result: FileTextSlice): {
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
} {
  if (result.isBinary) {
    return {
      filePreview: result,
      fileTooLarge: false,
    };
  }

  return result.truncated
    ? {
        filePreview: null,
        fileTooLarge: true,
      }
    : {
        filePreview: result,
        fileTooLarge: false,
      };
}

export function isPptxPreviewFileTooLarge(size: number): boolean {
  return size > PPTX_MAX_FILE_BYTES;
}

/** 切换源时重置 markdown / svg 的默认视图；code-review 始终按源码展示。 */
export function resolvePreviewPaneInitialViewModes(source: CodeViewerSource): {
  markdownViewMode: "preview" | "code";
  svgViewMode: "preview" | "code";
} {
  return {
    markdownViewMode:
      source.type !== "code-review" && (isMarkdownSource(source) || isMarkdownFilePath(source.path))
        ? "preview"
        : "code",
    svgViewMode:
      source.type !== "code-review" && (isSvgSource(source) || isSvgFilePath(source.path))
        ? "preview"
        : "code",
  };
}

export function resolvePreviewPaneImageSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "image" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "image") {
    return source;
  }

  if (source.type !== "file") {
    return null;
  }

  const mediaType = getFileImageMediaType(source.path);
  if (!mediaType) {
    return null;
  }

  return {
    type: "image",
    title: source.title,
    path: source.path,
    mediaType,
  };
}

export function resolvePreviewPaneMediaSource(
  source: CodeViewerSource | null,
): MediaCodeViewerSource | null {
  if (!source) return null;
  if (source.type === "media") return source;
  if (source.type !== "file") return null;
  const media = inferMediaPreview(source.path);
  if (!media) return null;
  return { ...source, type: "media", ...media };
}

export function resolveMediaPlaybackErrorMessageId(
  code: number | undefined,
): "codeViewer.mediaUnsupported" | "codeViewer.mediaLoadFailed" {
  return code === 3 || code === 4 ? "codeViewer.mediaUnsupported" : "codeViewer.mediaLoadFailed";
}

export function resolvePreviewPanePdfSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "pdf" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "pdf") {
    return source;
  }

  if (source.type !== "file" || !isPdfPreviewPath(source.path)) {
    return null;
  }

  return {
    type: "pdf",
    title: source.title,
    path: source.path,
  };
}

export function resolvePreviewPanePptxSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "pptx" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "pptx") {
    return source;
  }

  if (source.type !== "file" || !isPptxPreviewPath(source.path)) {
    return null;
  }

  return {
    ...source,
    type: "pptx",
  };
}

export function shouldShowPreviewPaneHeaderDivider(source: CodeViewerSource | null): boolean {
  return Boolean(
    resolvePreviewPanePdfSource(source) ||
    resolvePreviewPanePptxSource(source) ||
    resolvePreviewPaneMediaSource(source) ||
    (source?.type === "file" && getOfficeFilePreviewKind(source.path)),
  );
}

function isPlainCodeSource(source: CodeViewerSource | null): boolean {
  if (!source) {
    return false;
  }

  if (source.type === "text") {
    return !isMarkdownSource(source) && !isSvgSource(source);
  }

  if (source.type === "file") {
    return (
      !isMarkdownFilePath(source.path) &&
      !isSvgFilePath(source.path) &&
      !getFileImageMediaType(source.path) &&
      // PDF、Office 和 PPTX 走专用只读预览，没有源码视图，也不该出现自动换行开关。
      !isPdfPreviewPath(source.path) &&
      !getOfficeFilePreviewKind(source.path) &&
      !isPptxPreviewPath(source.path)
    );
  }

  if (source.type === "media") return false;

  if (source.type === "code-review") {
    return true;
  }

  return false;
}

export function getPreviewPaneDisplayOptions(
  source: CodeViewerSource | null,
  viewModes: {
    markdownViewMode?: "preview" | "code";
    svgViewMode?: "preview" | "code";
  } = {},
) {
  const canToggleMarkdownView =
    source !== null &&
    (isMarkdownSource(source) || (source.type === "file" && isMarkdownFilePath(source.path)));
  const canToggleSvgView =
    source !== null &&
    (isSvgSource(source) || (source.type === "file" && isSvgFilePath(source.path)));
  const canToggleCodeWrap =
    isPlainCodeSource(source) ||
    (canToggleMarkdownView && viewModes.markdownViewMode === "code") ||
    (canToggleSvgView && viewModes.svgViewMode === "code");

  return {
    canToggleCodeWrap,
    canToggleMarkdownView,
    canToggleSvgView,
    hasMoreMenu: canToggleMarkdownView || canToggleSvgView || canToggleCodeWrap,
  };
}
