import { ipcRenderer, webFrame } from "electron";
import type {
  DesktopZoomState,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
} from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";

const MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
let latestWindowControlsOverlayMetrics: WindowControlsOverlayMetrics | null = null;
let latestDesktopZoomLevel = 0;

export function clampDesktopZoomLevel(level: number) {
  return Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, level));
}

function resolveDesktopZoomLevelFromFactor(zoomFactor: number) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return 0;
  }

  return clampDesktopZoomLevel(
    Math.round(Math.log(zoomFactor) / Math.log(DESKTOP_ZOOM_FACTOR_STEP)),
  );
}

function resolveDesktopZoomFactorForLevel(level: number) {
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampDesktopZoomLevel(level));
}

function readCurrentWindowControlsOverlayReadyPayload(): WindowControlsOverlayReadyPayload {
  const zoomLevel = resolveDesktopZoomLevelFromFactor(webFrame.getZoomFactor());
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const metrics: WindowControlsOverlayMetrics =
    process.platform === "darwin"
      ? {
          leftPaddingPx: Math.round(MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX / zoomFactor),
        }
      : process.platform === "win32"
        ? {
            rightPaddingPx: Math.round(WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / zoomFactor),
            titleBarHeightPx: Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * zoomFactor),
          }
        : {};
  return {
    zoomLevel,
    metrics,
  };
}

export function readCurrentWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics {
  return readCurrentWindowControlsOverlayReadyPayload().metrics;
}

export function getLatestWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics | null {
  return latestWindowControlsOverlayMetrics;
}

export function getLatestDesktopZoomLevel(): number {
  return latestDesktopZoomLevel;
}

export function setLatestDesktopZoomLevel(level: number): void {
  latestDesktopZoomLevel = clampDesktopZoomLevel(level);
}

export function installWindowControlsOverlayBridge(): void {
  const initialWindowControlsOverlayPayload = readCurrentWindowControlsOverlayReadyPayload();
  latestDesktopZoomLevel = initialWindowControlsOverlayPayload.zoomLevel;
  latestWindowControlsOverlayMetrics = initialWindowControlsOverlayPayload.metrics;
  // RootStartupLoading 渲染前 main 进程就需要拿到当前 zoom 对应的红绿灯位置。
  // preload 比 React 页面更早运行，这里主动通知 main，避免等进入 App 页面后才调整。
  ipcRenderer.send(PlatformChannels.WindowControlsOverlayReady, initialWindowControlsOverlayPayload);

  ipcRenderer.on(
    PlatformChannels.WindowControlsOverlayChanged,
    (_event: unknown, metrics: WindowControlsOverlayMetrics) => {
      latestWindowControlsOverlayMetrics = metrics;
    },
  );

  ipcRenderer.on(
    PlatformChannels.DesktopZoomLevelChanged,
    (_event: unknown, state: DesktopZoomState) => {
      if (Number.isFinite(state.zoomLevel)) {
        latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
      }
    },
  );
}
