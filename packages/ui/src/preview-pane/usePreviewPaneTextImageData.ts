// PreviewPane 拆分（max-lines）：文本与图片预览读取。
// effect 顺序与依赖数组与拆分前一致：文本 → 图片。
import { useEffect, useState, type RefObject } from "react";
import type { FileMediaPreview, FileTextSlice } from "@zcode/shared";
import type { IServiceAccessor } from "./contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { FILE_VIEWER_MAX_TEXT_BYTES } from "@/lib/codeViewer.js";
import { logger } from "@/logger.js";
import { getPreviewPaneReadErrorMessage } from "./errors.js";
import { resolvePreviewPaneTextFileResult } from "./sources.js";
import type { PreviewPaneErrorSetter } from "./types.js";

export interface PreviewPaneTextImageDataOptions {
  fileService: IServiceAccessor["fileService"];
  /** 需要按文本读取的源（file / code-review）；其余类型为 null。 */
  fileSource: { path: string } | null;
  imageSource: { path: string } | null;
  intl: IntlInstance;
  /** 源切换时内容滚动位置归零。 */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  setError: PreviewPaneErrorSetter;
}

export interface PreviewPaneTextImageData {
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
  loadingInitial: boolean;
  imagePreview: FileMediaPreview | null;
  loadingImagePreview: boolean;
}

export function usePreviewPaneTextImageData({
  fileService,
  fileSource,
  imageSource,
  intl,
  scrollContainerRef,
  setError,
}: PreviewPaneTextImageDataOptions): PreviewPaneTextImageData {
  const [filePreview, setFilePreview] = useState<FileTextSlice | null>(null);
  const [fileTooLarge, setFileTooLarge] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingImagePreview, setLoadingImagePreview] = useState(false);
  const [imagePreview, setImagePreview] = useState<FileMediaPreview | null>(null);

  useEffect(() => {
    let disposed = false;

    setFilePreview(null);
    setFileTooLarge(false);
    setError(null);
    setLoadingInitial(Boolean(fileSource));
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }

    if (!fileSource) {
      return () => {
        disposed = true;
      };
    }

    // 把传输分块直接当成多个文档解码和渲染，会在 UTF-8 字符中间产生乱码，
    // 同时让每块行号从 1 重置。文本预览现在只读取 service 允许的完整上限；
    // 非二进制结果返回 truncated 时丢弃局部文本并提示文件过大，不再拼接分块。
    void fileService
      .readTextFile({
        path: fileSource.path,
        offset: 0,
        length: FILE_VIEWER_MAX_TEXT_BYTES,
      })
      .then((result) => {
        if (disposed) {
          return;
        }

        const nextFileState = resolvePreviewPaneTextFileResult(result);
        setFilePreview(nextFileState.filePreview);
        setFileTooLarge(nextFileState.fileTooLarge);
      })
      .catch((readError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取文件失败 path=${fileSource.path}:`, readError);
        setError(getPreviewPaneReadErrorMessage(readError, intl));
      })
      .finally(() => {
        if (!disposed) {
          setLoadingInitial(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, fileSource, intl, scrollContainerRef, setError]);

  useEffect(() => {
    let disposed = false;

    if (!imageSource) {
      setImagePreview(null);
      setLoadingImagePreview(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingImagePreview(true);
    setImagePreview(null);
    setError(null);

    void fileService
      .readMediaPreview({ path: imageSource.path })
      .then((result) => {
        if (disposed) {
          return;
        }

        setImagePreview(result);
      })
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取图片预览失败 path=${imageSource.path}:`, previewError);
        setError(getPreviewPaneReadErrorMessage(previewError, intl));
      })
      .finally(() => {
        if (!disposed) {
          setLoadingImagePreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, imageSource, intl, setError]);

  return {
    filePreview,
    fileTooLarge,
    loadingInitial,
    imagePreview,
    loadingImagePreview,
  };
}
