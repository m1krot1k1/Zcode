// PreviewPane 拆分（max-lines）：文件读取错误分类，以及避免把远端绝对路径带到 UI 文案的脱敏。
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import { isPptxPreviewIncompleteFileError } from "@/lib/pptxPreviewData.js";

export function isPreviewPaneMissingFileError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
}

export function shouldToastPptxReferenceFileMissing(
  source: CodeViewerSource | null,
  error: unknown,
): boolean {
  return (
    source?.type === "pptx" &&
    source.referenceNavigation !== undefined &&
    isPreviewPaneMissingFileError(error)
  );
}

export function isPreviewPaneFileTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is too large to preview/i.test(message);
}

export function getPreviewPaneSafeErrorMessage(error: unknown, sourcePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isAbsoluteFilePath(sourcePath)) {
    return message;
  }

  const sourceLeaf = getPathLeaf(sourcePath);
  const pathVariants = new Set([
    sourcePath,
    sourcePath.replace(/\\/g, "/"),
    sourcePath.replace(/\//g, "\\"),
  ]);

  let safeMessage = message;
  for (const pathVariant of pathVariants) {
    if (pathVariant !== sourceLeaf) {
      safeMessage = safeMessage.split(pathVariant).join(sourceLeaf);
    }
  }
  return safeMessage;
}

export function resolvePptxPreviewReadErrorMessage(
  error: unknown,
  options: {
    sourcePath: string;
    fileMissingMessage: string;
    legacyFileTooLargeMessage: string;
    incompleteFileMessage: string;
  },
): string {
  if (isPreviewPaneMissingFileError(error)) {
    return options.fileMissingMessage;
  }
  if (isPreviewPaneFileTooLargeError(error)) {
    return options.legacyFileTooLargeMessage;
  }
  if (isPptxPreviewIncompleteFileError(error)) {
    return options.incompleteFileMessage;
  }
  return getPreviewPaneSafeErrorMessage(error, options.sourcePath);
}

/**
 * 文本 / 图片 / 媒体 / PDF 读取失败时的统一文案：
 * 文件不存在时用本地化提示，其余错误保留原始 message（这些通道不拼接远端绝对路径）。
 */
export function getPreviewPaneReadErrorMessage(error: unknown, intl: IntlInstance): string {
  if (isPreviewPaneMissingFileError(error)) {
    return intl.formatMessage({ id: "codeViewer.fileMissing" });
  }
  return error instanceof Error ? error.message : String(error);
}
