// PreviewPane 拆分（max-lines）：预览数据读取总入口。
// 唯一持有 error 状态，按「文本/图片 → 媒体 → PDF → Office → PPTX」顺序组合子 hook，
// 该顺序与拆分前各 effect 的注册顺序一致。
import { useState, type RefObject } from "react";
import type { FileBinaryPreview, FileMediaPreview, FileTextSlice } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { PdfViewerSource } from "@/components/ui/pdf-viewer.js";
import type { CodeViewerSource, MediaCodeViewerSource } from "@/lib/codeViewer.js";
import type { OfficeFilePreviewKind } from "@/lib/officeFilePreview.js";
import { usePreviewPaneTextImageData } from "./usePreviewPaneTextImageData.js";
import {
  usePreviewPaneMediaData,
  type PreviewPaneMediaData,
} from "./usePreviewPaneMediaData.js";
import { usePreviewPanePdfData } from "./usePreviewPanePdfData.js";
import { usePreviewPaneOfficeData } from "./usePreviewPaneOfficeData.js";
import { usePreviewPanePptxData } from "./usePreviewPanePptxData.js";

type PptxSource = Extract<CodeViewerSource, { type: "pptx" }>;

export interface PreviewPanePreviewDataOptions {
  fileService: IServiceAccessor["fileService"];
  mediaPreviewService: IServiceAccessor["mediaPreviewService"];
  fileSource: { path: string } | null;
  imageSource: { path: string } | null;
  mediaSource: MediaCodeViewerSource | null;
  pdfSource: { path: string } | null;
  officePreviewKind: OfficeFilePreviewKind | null;
  source: CodeViewerSource | null;
  pptxSource: PptxSource | null;
  pptxSourcePath: string | null;
  pptxFileWatchReady: boolean;
  pptxReloadGeneration: number;
  intl: IntlInstance;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

export interface PreviewPanePreviewData {
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
  loadingInitial: boolean;
  imagePreview: FileMediaPreview | null;
  loadingImagePreview: boolean;
  loadingMediaPreview: boolean;
  mediaPreviewUrl: string | null;
  onMediaError: PreviewPaneMediaData["onMediaError"];
  onMediaLoadedMetadata: PreviewPaneMediaData["onMediaLoadedMetadata"];
  loadingPdfPreview: boolean;
  pdfViewerSource: PdfViewerSource | null;
  loadingOfficePreview: boolean;
  officePreview: FileBinaryPreview | null;
  loadingPptxPreview: boolean;
  pptxPreviewData: ArrayBuffer | null;
  validatedPptxReferenceNavigationRequestId: string | null;
  error: string | null;
}

export function usePreviewPanePreviewData({
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
}: PreviewPanePreviewDataOptions): PreviewPanePreviewData {
  const [error, setError] = useState<string | null>(null);

  const textImage = usePreviewPaneTextImageData({
    fileService,
    fileSource,
    imageSource,
    intl,
    scrollContainerRef,
    setError,
  });
  const media = usePreviewPaneMediaData({
    mediaPreviewService,
    mediaSource,
    intl,
    setError,
  });
  const pdf = usePreviewPanePdfData({ fileService, pdfSource, intl, setError });
  const office = usePreviewPaneOfficeData({
    fileService,
    officePreviewKind,
    source,
    intl,
    setError,
  });
  const pptx = usePreviewPanePptxData({
    fileService,
    pptxSource,
    pptxSourcePath,
    pptxFileWatchReady,
    pptxReloadGeneration,
    intl,
    setError,
  });

  return {
    ...textImage,
    ...media,
    ...pdf,
    ...office,
    ...pptx,
    error,
  };
}
