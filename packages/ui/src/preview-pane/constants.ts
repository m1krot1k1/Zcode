// PreviewPane 拆分（max-lines）：跨子模块共享的展示常量与结构类型。
import type { CodeCommentPreview } from "@/lib/codeCommentContext.js";

export interface CodeViewerBreadcrumbData {
  rootLabel: string | null;
  parentSegments: string[];
  fileLabel: string;
  fileIconSrc: string | null;
}

export type BreadcrumbMaskState = "none" | "left" | "right" | "both";

export const BREADCRUMB_MASK_CLASS_BY_STATE: Record<BreadcrumbMaskState, string> = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)]",
  right:
    "[mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)]",
};
export const PREVIEW_PANE_DEFERRED_PLACEHOLDER_LINE_WIDTHS = [
  44, 72, 58, 86, 64, 78, 52, 90, 68, 48, 82, 60,
] as const;
export const EMPTY_CODE_COMMENT_PREVIEWS: readonly CodeCommentPreview[] = [];

// 与 service 层 readFileRange 的默认分段大小对齐，一次 range 请求对应一次 RPC 调用。
export const PDF_RANGE_CHUNK_BYTES = 256 * 1024;
// 小 PDF 直接循环拉全量（少量往返、渲染路径最简单）；超过阈值交给 pdf.js range 按需分段加载。
export const PDF_FULL_READ_MAX_BYTES = 2 * 1024 * 1024;
export const PPTX_MAX_FILE_BYTES = 64 * 1024 * 1024;
