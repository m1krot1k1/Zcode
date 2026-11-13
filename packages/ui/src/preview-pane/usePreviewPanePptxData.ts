// PreviewPane 拆分（max-lines）：PPTX 预览数据读取与 reference navigation 校验。
// 先等 file watch ready，再按 size/range 读取；再次 stat 防止把被替换的旧版本前缀当成完整文件。
import { useEffect, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { decodeBase64ToArrayBuffer } from "@/lib/officeFilePreview.js";
import {
  assertPptxPreviewDataComplete,
  isPptxPreviewIncompleteFileError,
  readPptxPreviewData,
} from "@/lib/pptxPreviewData.js";
import { logger } from "@/logger.js";
import {
  resolvePptxPreviewReadErrorMessage,
  shouldToastPptxReferenceFileMissing,
} from "./errors.js";
import { isPptxPreviewFileTooLarge } from "./sources.js";
import type { PreviewPaneErrorSetter } from "./types.js";

type PptxSource = Extract<CodeViewerSource, { type: "pptx" }>;

export interface PreviewPanePptxDataOptions {
  fileService: IServiceAccessor["fileService"];
  pptxSource: PptxSource | null;
  pptxSourcePath: string | null;
  /** 文件监听就绪前不发起读取，避免读到写了一半的包。 */
  pptxFileWatchReady: boolean;
  pptxReloadGeneration: number;
  intl: IntlInstance;
  setError: PreviewPaneErrorSetter;
}

export interface PreviewPanePptxData {
  loadingPptxPreview: boolean;
  pptxPreviewData: ArrayBuffer | null;
  validatedPptxReferenceNavigationRequestId: string | null;
}

export function usePreviewPanePptxData({
  fileService,
  pptxSource,
  pptxSourcePath,
  pptxFileWatchReady,
  pptxReloadGeneration,
  intl,
  setError,
}: PreviewPanePptxDataOptions): PreviewPanePptxData {
  const [loadingPptxPreview, setLoadingPptxPreview] = useState(false);
  const [pptxPreviewData, setPptxPreviewData] = useState<ArrayBuffer | null>(null);
  const [validatedPptxReferenceNavigationRequestId, setValidatedPptxReferenceNavigationRequestId] =
    useState<string | null>(null);
  const pptxReferenceNavigation = pptxSource?.referenceNavigation ?? null;

  useEffect(() => {
    const navigation = pptxReferenceNavigation;
    if (!navigation || !pptxSourcePath) {
      setValidatedPptxReferenceNavigationRequestId(null);
      return;
    }
    let disposed = false;
    setValidatedPptxReferenceNavigationRequestId(null);
    void fileService
      .stat({ path: pptxSourcePath })
      .then(() => {
        if (!disposed) {
          setValidatedPptxReferenceNavigationRequestId(navigation.requestId);
        }
      })
      .catch((navigationError: unknown) => {
        if (!disposed && shouldToastPptxReferenceFileMissing(pptxSource, navigationError)) {
          toast(
            intl.formatMessage({
              id: "chat.pptxElements.previewFileMissing",
            }),
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, [fileService, intl, pptxReferenceNavigation, pptxSource, pptxSourcePath]);

  useEffect(() => {
    let disposed = false;

    if (!pptxSourcePath) {
      setPptxPreviewData(null);
      setLoadingPptxPreview(false);
      return () => {
        disposed = true;
      };
    }

    if (!pptxFileWatchReady) {
      setPptxPreviewData(null);
      setLoadingPptxPreview(true);
      setError(null);
      return () => {
        disposed = true;
      };
    }

    setLoadingPptxPreview(true);
    setPptxPreviewData(null);
    setError(null);

    const path = pptxSourcePath;
    void (async () => {
      const fileStat = await fileService.stat({ path });
      if (disposed) {
        return;
      }

      if (typeof fileStat.size !== "number") {
        // 兼容旧远端：旧 Host 没有 size/range 能力，只能使用现有 8MB base64 通道。
        const preview = await fileService.readMediaPreview({ path });
        if (!disposed) {
          setPptxPreviewData(decodeBase64ToArrayBuffer(preview.dataBase64));
        }
        return;
      }

      if (isPptxPreviewFileTooLarge(fileStat.size)) {
        setError(intl.formatMessage({ id: "codeViewer.pptx.fileTooLarge" }));
        return;
      }

      const data = await readPptxPreviewData({
        fileSize: fileStat.size,
        readRange: (offset, length) => fileService.readFileRange({ path, offset, length }),
        isDisposed: () => disposed,
      });
      if (disposed || !data) {
        return;
      }

      // 文件可能在分段读取期间被替换成另一个大小不同的版本；再次 stat 可以阻止把旧版本的
      // 前缀当作完整 PPTX 解析。相同大小的内容替换仍需 Host 提供 fingerprint 才能检测，暂不扩展现有协议。
      const currentFileStat = await fileService.stat({ path });
      if (disposed) {
        return;
      }
      assertPptxPreviewDataComplete({
        expectedBytes: fileStat.size,
        actualBytes: data.byteLength,
        observedFileSize: currentFileStat.size,
      });

      setPptxPreviewData(data);
    })()
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        if (isPptxPreviewIncompleteFileError(previewError)) {
          logger.warn("[PreviewPane] PPTX 文件读取不完整，已阻止解析残缺数据", {
            path,
            expectedBytes: previewError.expectedBytes,
            actualBytes: previewError.actualBytes,
            observedFileSize: previewError.observedFileSize,
          });
        } else {
          logger.error(`[PreviewPane] 读取 PPTX 预览失败 path=${path}:`, previewError);
        }
        // 旧 Host 的 8MB base64 通道会把绝对路径拼进英文超限错误；原样展示既误导
        // 用户又泄漏远端目录。这里保留真实的 8MB 兼容边界，并对其它错误只展示文件名。
        setError(
          resolvePptxPreviewReadErrorMessage(previewError, {
            sourcePath: path,
            fileMissingMessage: intl.formatMessage({ id: "codeViewer.fileMissing" }),
            legacyFileTooLargeMessage: intl.formatMessage({
              id: "codeViewer.pptx.legacyFileTooLarge",
            }),
            incompleteFileMessage: intl.formatMessage({ id: "codeViewer.pptx.incomplete" }),
          }),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingPptxPreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [
    fileService,
    intl,
    pptxFileWatchReady,
    pptxReloadGeneration,
    pptxSourcePath,
    setError,
  ]);

  return {
    loadingPptxPreview,
    pptxPreviewData,
    validatedPptxReferenceNavigationRequestId,
  };
}
