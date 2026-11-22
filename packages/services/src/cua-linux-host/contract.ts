/**
 * services-cua-linux-host — контракт нативного Computer Use на Linux.
 *
 * Модуль владеет реальным рабочим столом Linux: определяет графический бэкенд
 * (X11/XWayland или чистый Wayland), захватывает экран и синтезирует ввод.
 *
 * Инварианты:
 * - каждый провайдер проверяется реально в `probe()`, результат кэшируется; ничего не
 *   объявляется доступным «по платформе»;
 * - при отсутствии графического хоста возвращается `cua_unavailable` с точной причиной,
 *   а не исключение;
 * - ввод идёт через реальные XTest/портал-вызовы; фейковых движений нет;
 * - координаты нормализуются по DPI и мультимонитору до логических пикселей рабочего стола.
 *
 * Границы разрешений (`screenshot`/`pointer`/`keyboard`/`clipboard`) вынесены в
 * отдельный контракт политики: модуль не решает, можно ли действовать, он только
 * исполняет уже разрешённое.
 */

/** Графический бэкенд рабочего стола, определённый по факту, а не по ОС. */
export type LinuxDisplayBackend = "x11" | "wayland" | "headless";

/** Провайдер захвата экрана; порядок в массиве `probe()` — реальный каскад приоритета. */
export type LinuxScreenCaptureProvider =
  | "electron-desktop-capturer"
  | "xdg-portal-screenshot"
  | "grim"
  | "gnome-screenshot"
  | "imagemagick-import"
  | "scrot"
  | "ffmpeg-x11grab"
  | "none";

/** Провайдер синтеза ввода. */
export type LinuxInputProvider = "x11-xtest" | "wayland-remote-desktop" | "none";

/** Причина недоступности CUA: точная, машинночитаемая и пригодная для UI. */
export type LinuxCuaUnavailableReason =
  | "not-linux"
  | "no-display-server"
  | "no-screen-capture-provider"
  | "no-input-provider"
  | "portal-unavailable"
  | "libx11-missing"
  | "libxtst-missing"
  | "koffi-missing"
  | "unknown-error";

export interface LinuxDisplayProbeResult {
  backend: LinuxDisplayBackend;
  /** `X11` использует display; `wayland` — wayland-socket; `headless` — ни то, ни другое. */
  sessionType: string | undefined;
  display: string | undefined;
  waylandDisplay: string | undefined;
  /** Ширина/высота объединённого рабочего стола в логических пикселях. */
  screen?: { width: number; height: number };
  /** Мониторы с их смещением и масштабом; порядок — как отдал сервер. */
  monitors?: ReadonlyArray<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    primary?: boolean;
  }>;
}

export interface LinuxCuaCapabilityReport {
  available: boolean;
  backend: LinuxDisplayBackend;
  screenCaptureProvider: LinuxScreenCaptureProvider;
  inputProvider: LinuxInputProvider;
  /** Все проверенные провайдеры с причинами отказа — модель должна видеть, что именно нет. */
  availableReasons: ReadonlyArray<{ provider: string; ok: boolean; reason?: string }>;
  reason?: LinuxCuaUnavailableReason;
  /** Человекочитаемое объяснение для UI/логов; не содержит секретов. */
  detail?: string;
  display: LinuxDisplayProbeResult;
}

export interface LinuxCuaCaptureOptions {
  /** Формат кадра. По умолчанию `png` (без потерь для OCR/ARIA-замера). */
  format?: "png" | "jpeg";
  /** Качество JPEG (0-100), если выбран jpeg. */
  quality?: number;
  /** Максимум байт итогового кадра; превышение → флаг усечения. */
  maxBytes?: number;
}

export interface LinuxCuaFrame {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  bytes: number;
  provider: LinuxScreenCaptureProvider;
  /** Логическая матрица: пиксель кадра → логические координаты рабочего стола. */
  scaleX: number;
  scaleY: number;
  captureDurationMs: number;
  /** `true`, если кадр был пересжат/обрезан из-за бюджета. */
  truncated?: boolean;
}

export interface LinuxCuaPointerMoveOptions {
  x: number;
  y: number;
  /** Плавное движение шагами; 1 — мгновенно. */
  steps?: number;
  delayMs?: number;
}

export type LinuxCuaMouseButton = "left" | "right" | "middle";

export interface LinuxCuaClickOptions {
  x: number;
  y: number;
  button?: LinuxCuaMouseButton;
  clickCount?: number;
}

export interface LinuxCuaScrollOptions {
  x: number;
  y: number;
  /** Положительное значение — «вниз», отрицательное — «вверх». */
  deltaY: number;
  /** Сколько «щелчков» колеса на один шаг; по умолчанию 1. */
  steps?: number;
}

export interface LinuxCuaKeyOptions {
  /** Имя клавиши в нотации X11 (`Return`, `Escape`, `a`, `ctrl+shift+t`). */
  key: string;
  /** Сколько раз нажать; по умолчанию 1. */
  repeat?: number;
}

export interface LinuxCuaTypeOptions {
  text: string;
  /** Задержка между символами; 0 — сразу. */
  delayMs?: number;
}

export interface LinuxCuaScreenshotPermission {
  /** Гранулярные политики; модуль исполняет только разрешённое. */
  screenshot: "allow" | "deny";
  pointer: "allow" | "deny";
  keyboard: "allow" | "deny";
  clipboard: "allow" | "deny";
}

export type LinuxCuaOperation =
  | { kind: "screenshot"; options?: LinuxCuaCaptureOptions }
  | { kind: "pointerMove"; options: LinuxCuaPointerMoveOptions }
  | { kind: "click"; options: LinuxCuaClickOptions }
  | { kind: "scroll"; options: LinuxCuaScrollOptions }
  | { kind: "key"; options: LinuxCuaKeyOptions }
  | { kind: "type"; options: LinuxCuaTypeOptions };

export type LinuxCuaOperationResult =
  | { ok: true; operation: LinuxCuaOperation["kind"]; frame?: LinuxCuaFrame; elapsedMs: number }
  | {
      ok: false;
      operation: LinuxCuaOperation["kind"];
      code: "permission_denied" | "cua_unavailable" | "execution_error";
      message: string;
      reason?: LinuxCuaUnavailableReason;
      elapsedMs: number;
    };

/**
 * Публичный контракт хоста: один метод — одно намерение.
 * Ни один метод не бросает; любая недоступность возвращается структурно.
 */
export interface LinuxCuaHostContract {
  /** Реальная проверка окружения с кэшем и причинами по каждому звену. */
  probe(options?: { refresh?: boolean }): Promise<LinuxCuaCapabilityReport>;
  /** Захват экрана выбранным каскадом; `null` — недоступно, причина в последнем probe. */
  captureScreen(options?: LinuxCuaCaptureOptions): Promise<LinuxCuaFrame | null>;
  /** Исполнение операции с учётом переданных политик. */
  execute(
    operation: LinuxCuaOperation,
    permissions: LinuxCuaScreenshotPermission,
  ): Promise<LinuxCuaOperationResult>;
  /** Снимает FFI-хендлы, таймеры и D-Bus-сессии. Идемпотентно. */
  dispose(): Promise<void>;
}

/** Бюджеты по умолчанию. */
export const LINUX_CUA_DEFAULTS = {
  maxFrameBytes: 1024 * 1024,
  captureFormat: "png" as const,
  jpegQuality: 80,
  /** Сколько живёт кэш probe, мс. */
  probeCacheMs: 30_000,
  /** Потолок ожидания внешних утилит захвата, мс. */
  captureTimeoutMs: 8_000,
  /** Потолок ожидания D-Bus-вызова портала, мс. */
  portalTimeoutMs: 5_000,
} as const;
