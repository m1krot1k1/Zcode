// PreviewPane 拆分（max-lines）：媒体预览（视频/音频）的 URL 生命周期与播放失败恢复。
// 生成号（generation）保证切源后晚到的 prepare/refresh 结果不会覆盖新源。
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { IServiceAccessor } from "./contract.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { MediaCodeViewerSource } from "@/lib/codeViewer.js";
import { decodeBase64ToArrayBuffer } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";
import { getPreviewPaneReadErrorMessage } from "./errors.js";
import { resolveMediaPlaybackErrorMessageId } from "./sources.js";
import type { PreviewPaneErrorSetter } from "./types.js";

export interface PreviewPaneMediaDataOptions {
  mediaPreviewService: IServiceAccessor["mediaPreviewService"];
  mediaSource: MediaCodeViewerSource | null;
  intl: IntlInstance;
  setError: PreviewPaneErrorSetter;
}

export interface PreviewPaneMediaData {
  loadingMediaPreview: boolean;
  mediaPreviewUrl: string | null;
  onMediaError: (event: SyntheticEvent<HTMLMediaElement>) => void;
  onMediaLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

export function usePreviewPaneMediaData({
  mediaPreviewService,
  mediaSource,
  intl,
  setError,
}: PreviewPaneMediaDataOptions): PreviewPaneMediaData {
  const [loadingMediaPreview, setLoadingMediaPreview] = useState(false);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaPreviewId, setMediaPreviewId] = useState<string | null>(null);
  const mediaPreviewGenerationRef = useRef(0);
  const mediaRefreshAttemptedRef = useRef(false);
  const mediaRefreshInFlightRef = useRef(false);
  const mediaRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaPlaybackRestoreRef = useRef<{
    currentTime: number;
    paused: boolean;
    volume: number;
    muted: boolean;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    let preparedPreviewId: string | null = null;
    const generation = ++mediaPreviewGenerationRef.current;

    if (!mediaSource) {
      setLoadingMediaPreview(false);
      setMediaPreviewUrl(null);
      setMediaPreviewId(null);
      mediaRefreshAttemptedRef.current = false;
      if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
      mediaRefreshTimerRef.current = null;
      mediaPlaybackRestoreRef.current = null;
      return () => {
        disposed = true;
      };
    }

    setLoadingMediaPreview(true);
    setMediaPreviewUrl(null);
    setMediaPreviewId(null);
    setError(null);
    mediaRefreshAttemptedRef.current = false;
    mediaRefreshInFlightRef.current = false;
    if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
    mediaRefreshTimerRef.current = null;
    mediaPlaybackRestoreRef.current = null;
    if (!mediaPreviewService) {
      setLoadingMediaPreview(false);
      setError(intl.formatMessage({ id: "codeViewer.mediaUnavailable" }));
      return () => {
        disposed = true;
      };
    }

    void mediaPreviewService
      .prepare({
        path: mediaSource.path,
        expectedKind: mediaSource.kind,
      })
      .then((preview) => {
        const previewId = "previewId" in preview ? preview.previewId : null;
        if (previewId) preparedPreviewId = previewId;
        if (disposed || generation !== mediaPreviewGenerationRef.current) {
          if (previewId && mediaPreviewService?.release) {
            void mediaPreviewService.release({ previewId }).catch(() => undefined);
          }
          return;
        }
        if ("url" in preview) {
          if (previewId) setMediaPreviewId(previewId);
          setMediaPreviewUrl(preview.url);
        } else {
          objectUrl = URL.createObjectURL(
            new Blob([decodeBase64ToArrayBuffer(preview.dataBase64)], {
              type: preview.mediaType,
            }),
          );
          setMediaPreviewUrl(objectUrl);
        }
      })
      .catch((previewError: unknown) => {
        if (disposed || generation !== mediaPreviewGenerationRef.current) return;
        logger.error("[PreviewPane] 读取媒体预览失败", {
          path: mediaSource.path,
          error: previewError instanceof Error ? previewError.message : String(previewError),
        });
        setError(getPreviewPaneReadErrorMessage(previewError, intl));
      })
      .finally(() => {
        if (!disposed && generation === mediaPreviewGenerationRef.current) {
          setLoadingMediaPreview(false);
        }
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
      mediaRefreshTimerRef.current = null;
      if (preparedPreviewId && mediaPreviewService?.release) {
        void mediaPreviewService.release({ previewId: preparedPreviewId }).catch(() => undefined);
      }
    };
  }, [intl, mediaPreviewService, mediaSource, setError]);

  const handleMediaError = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>) => {
      const mediaElement = event.currentTarget;
      const refreshPlaybackUrl = mediaPreviewService?.refreshPlaybackUrl;
      if (!mediaPreviewId || !refreshPlaybackUrl) {
        setError(
          intl.formatMessage({
            id: resolveMediaPlaybackErrorMessageId(mediaElement.error?.code),
          }),
        );
        return;
      }
      if (mediaRefreshAttemptedRef.current || mediaRefreshInFlightRef.current) {
        setError(intl.formatMessage({ id: "codeViewer.mediaLoadFailed" }));
        return;
      }

      mediaRefreshAttemptedRef.current = true;
      const generation = mediaPreviewGenerationRef.current;
      mediaPlaybackRestoreRef.current = {
        currentTime: Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0,
        paused: mediaElement.paused,
        volume: mediaElement.volume,
        muted: mediaElement.muted,
      };
      setError(null);
      mediaRefreshTimerRef.current = setTimeout(() => {
        mediaRefreshTimerRef.current = null;
        if (generation !== mediaPreviewGenerationRef.current) return;
        mediaRefreshInFlightRef.current = true;
        void refreshPlaybackUrl({ previewId: mediaPreviewId })
          .then(({ url }) => {
            if (generation === mediaPreviewGenerationRef.current) setMediaPreviewUrl(url);
          })
          .catch(() => {
            if (generation === mediaPreviewGenerationRef.current) {
              setError(intl.formatMessage({ id: "codeViewer.mediaLoadFailed" }));
            }
          })
          .finally(() => {
            mediaRefreshInFlightRef.current = false;
          });
      }, 500);
    },
    [intl, mediaPreviewId, mediaPreviewService, setError],
  );

  const handleMediaLoadedMetadata = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const restore = mediaPlaybackRestoreRef.current;
    if (!restore) return;
    const mediaElement = event.currentTarget;
    mediaElement.volume = restore.volume;
    mediaElement.muted = restore.muted;
    try {
      mediaElement.currentTime = restore.currentTime;
    } catch {
      // 媒体元数据尚未完全就绪时由浏览器稍后继续处理，不阻断播放器加载。
    }
    if (!restore.paused) void mediaElement.play().catch(() => undefined);
    mediaPlaybackRestoreRef.current = null;
  }, []);

  return {
    loadingMediaPreview,
    mediaPreviewUrl,
    onMediaError: handleMediaError,
    onMediaLoadedMetadata: handleMediaLoadedMetadata,
  };
}
