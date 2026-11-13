// PreviewPane 拆分（max-lines）：Office（xlsx/docx/doc）二进制预览读取。
import { useEffect, useState } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";
import { isPreviewPaneFileTooLargeError, isPreviewPaneMissingFileError } from "./errors.js";
import type { PreviewPaneErrorSetter } from "./types.js";

export interface PreviewPaneOfficeDataOptions {
  fileService: IServiceAccessor["fileService"];
  officePreviewKind: OfficeFilePreviewKind | null;
  /** 归一化后的源；Office 只处理 file 类型。 */
  source: CodeViewerSource | null;
  intl: IntlInstance;
  setError: PreviewPaneErrorSetter;
}

export interface PreviewPaneOfficeData {
  loadingOfficePreview: boolean;
  officePreview: FileBinaryPreview | null;
}

export function usePreviewPaneOfficeData({
  fileService,
  officePreviewKind,
  source,
  intl,
  setError,
}: PreviewPaneOfficeDataOptions): PreviewPaneOfficeData {
  const [officePreview, setOfficePreview] = useState<FileBinaryPreview | null>(null);
  const [loadingOfficePreview, setLoadingOfficePreview] = useState(false);

  useEffect(() => {
    let disposed = false;

    if (!officePreviewKind || source?.type !== "file") {
      setOfficePreview(null);
      setLoadingOfficePreview(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingOfficePreview(true);
    setOfficePreview(null);
    setError(null);

    void fileService
      .readBinaryPreview({ path: source.path })
      .then((result) => {
        if (!disposed) {
          setOfficePreview(result);
        }
      })
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error("[PreviewPane] 读取 Office 文件预览失败", {
          path: source.path,
          error: previewError instanceof Error ? previewError.message : String(previewError),
        });
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : isPreviewPaneFileTooLargeError(previewError)
              ? intl.formatMessage({ id: "codeViewer.officeTooLarge" })
              : previewError instanceof Error
                ? previewError.message
                : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingOfficePreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, intl, officePreviewKind, setError, source]);

  return { loadingOfficePreview, officePreview };
}
