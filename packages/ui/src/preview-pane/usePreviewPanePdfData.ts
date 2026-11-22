// PreviewPane 拆分（max-lines）：PDF 预览数据读取。
// 小文件整档读取，大文件交给 pdf.js 按 range 拉取；旧远端没有 size 时回退 base64 通道。
import { useEffect, useState } from "react";
import type { IServiceAccessor } from "./contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import { logger } from "@/logger.js";
import { PDF_FULL_READ_MAX_BYTES, PDF_RANGE_CHUNK_BYTES } from "./constants.js";
import { getPreviewPaneReadErrorMessage } from "./errors.js";
import type { PreviewPaneErrorSetter } from "./types.js";

export interface PreviewPanePdfDataOptions {
  fileService: IServiceAccessor["fileService"];
  pdfSource: { path: string } | null;
  intl: IntlInstance;
  setError: PreviewPaneErrorSetter;
}

export interface PreviewPanePdfData {
  loadingPdfPreview: boolean;
  pdfViewerSource: PdfViewerSource | null;
}

export function usePreviewPanePdfData({
  fileService,
  pdfSource,
  intl,
  setError,
}: PreviewPanePdfDataOptions): PreviewPanePdfData {
  const [loadingPdfPreview, setLoadingPdfPreview] = useState(false);
  const [pdfViewerSource, setPdfViewerSource] = useState<PdfViewerSource | null>(null);

  useEffect(() => {
    let disposed = false;

    if (!pdfSource) {
      setPdfViewerSource(null);
      setLoadingPdfPreview(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingPdfPreview(true);
    setPdfViewerSource(null);
    setError(null);

    const path = pdfSource.path;
    const readWholeFile = async (totalBytes: number): Promise<Uint8Array | null> => {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < totalBytes) {
        const chunk = await fileService.readFileRange({
          path,
          offset,
          length: PDF_RANGE_CHUNK_BYTES,
        });
        if (disposed) {
          return null;
        }
        if (chunk.length === 0) {
          // 读取期间文件被截断时按已读部分返回，交给 pdf.js 判定完整性，避免死循环
          break;
        }
        chunks.push(chunk);
        offset += chunk.length;
      }
      const data = new Uint8Array(offset);
      let position = 0;
      for (const chunk of chunks) {
        data.set(chunk, position);
        position += chunk.length;
      }
      return data;
    };

    void (async () => {
      const fileStat = await fileService.stat({ path });
      if (disposed) {
        return;
      }

      if (typeof fileStat.size !== "number") {
        // 版本偏差兜底：旧远端 stat 不返回 size，也一定没有 readFileRange，
        // 回退整档 base64 的旧通道（保留其 8MB 上限，超限走 catch 报错文案）。
        const preview = await fileService.readMediaPreview({ path });
        if (disposed) {
          return;
        }
        setPdfViewerSource(`data:application/pdf;base64,${preview.dataBase64}`);
        return;
      }

      if (fileStat.size <= PDF_FULL_READ_MAX_BYTES) {
        const data = await readWholeFile(fileStat.size);
        if (!disposed && data) {
          setPdfViewerSource(data);
        }
        return;
      }

      const totalBytes = fileStat.size;
      setPdfViewerSource({
        totalBytes,
        requestRange: (offset, length) => fileService.readFileRange({ path, offset, length }),
      });
    })()
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取 PDF 预览失败 path=${path}:`, previewError);
        setError(getPreviewPaneReadErrorMessage(previewError, intl));
      })
      .finally(() => {
        if (!disposed) {
          setLoadingPdfPreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, intl, pdfSource, setError]);

  return { loadingPdfPreview, pdfViewerSource };
}
