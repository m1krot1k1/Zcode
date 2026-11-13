import type { WebContents } from "electron";
import { notifyStabilityLifecycle, reportStabilityCustom } from "./eventReporter.js";
import type { StabilityLogger } from "./types.js";

/** 与 @arms/rum-electron pv-collector 的 initial_load 窗口对齐，避免早于首屏 PV 单独 flush */
const PERF_APP_START_AFTER_VIEW_MS = 3_200;

let perfAppStartReported = false;

export function reportPerfAppStart(logger: StabilityLogger): void {
  if (perfAppStartReported) {
    return;
  }
  perfAppStartReported = true;
  notifyStabilityLifecycle("cold_start");
  reportStabilityCustom("perf_app_start", {}, "main", "cold_start");
  notifyStabilityLifecycle("runtime");
  logger.info("[stability] perf_app_start reported");
}

/**
 * 在主窗口首屏加载完成后再上报 perf_app_start。
 * 原因：过早 sendCustom 时 view 仍为 __default__，且可能与 renderer PV 分属不同上报批次；
 * ARMS 原始日志里常见只有 PV、看不到同 session 的 custom。
 */
export function scheduleReportPerfAppStartAfterMainViewReady(
  webContents: WebContents,
  logger: StabilityLogger,
): void {
  if (perfAppStartReported || webContents.isDestroyed()) {
    return;
  }

  const reportAfterView = (): void => {
    if (perfAppStartReported || webContents.isDestroyed()) {
      return;
    }
    setTimeout(() => {
      if (!webContents.isDestroyed()) {
        reportPerfAppStart(logger);
      }
    }, PERF_APP_START_AFTER_VIEW_MS);
  };

  if (webContents.isLoading()) {
    webContents.once("did-finish-load", reportAfterView);
    return;
  }

  reportAfterView();
}
