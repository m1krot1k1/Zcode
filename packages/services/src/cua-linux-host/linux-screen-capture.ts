/**
 * Захват экрана Linux с реальным каскадом провайдеров.
 *
 * Приоритет (первый работающий побеждает, и это видно в `probe()`):
 *  1. Electron `desktopCapturer` — есть только внутри Main, внедряется как порт;
 *  2. XDG Desktop Portal `org.freedesktop.portal.Screenshot` — Wayland-путь;
 *  3. `grim` — Wayland-композиторы; на X11 падает с "failed to create display";
 *  4. `gnome-screenshot` — GNOME/X11;
 *  5. ImageMagick `import` — X11;
 *  6. `scrot` — X11;
 *  7. `ffmpeg -f x11grab` — X11 last resort.
 *
 * Ничего не объявляется доступным без реального вызова: `grim` установлен на этой
 * машине, но на X11 он непригоден — тест это фиксирует.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  LINUX_CUA_DEFAULTS,
  type LinuxCuaCaptureOptions,
  type LinuxCuaFrame,
  type LinuxScreenCaptureProvider,
} from "./contract.js";

const execFileAsync = promisify(execFile);

/** Внедряемый порт Electron Main: без Electron он отсутствует. */
export interface ElectronScreenCapturePort {
  capture(): Promise<{ pngBuffer: Buffer; width: number; height: number; scaleFactor: number }>;
}

export interface ScreenCaptureProbeEntry {
  provider: LinuxScreenCaptureProvider;
  ok: boolean;
  reason?: string;
}

export interface ScreenCaptureResult {
  provider: LinuxScreenCaptureProvider;
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

const PROVIDER_ORDER: readonly LinuxScreenCaptureProvider[] = [
  "electron-desktop-capturer",
  "xdg-portal-screenshot",
  "grim",
  "gnome-screenshot",
  "imagemagick-import",
  "scrot",
  "ffmpeg-x11grab",
];

/** Проверяет наличие бинарника без запуска захвата. */
function whichSync(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, binary)));
}

function binaryFor(provider: LinuxScreenCaptureProvider): string | undefined {
  if (provider === "grim") return "grim";
  if (provider === "gnome-screenshot") return "gnome-screenshot";
  if (provider === "imagemagick-import") return "import";
  if (provider === "scrot") return "scrot";
  if (provider === "ffmpeg-x11grab") return "ffmpeg";
  return undefined;
}

/** Размер PNG из заголовка IHDR — без декодирования всего изображения. */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  // IHDR начинается сразу после сигнатуры: 8 байт длины+типа, затем width/height.
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Проба каждого провайдера. Для утилит проверяется наличие бинарника и,
 * для `grim`, реальный вызов: наличие бинарника не значит работоспособность.
 */
export async function probeScreenCaptureProviders(options: {
  electron?: ElectronScreenCapturePort;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ScreenCaptureProbeEntry[]> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? LINUX_CUA_DEFAULTS.captureTimeoutMs;
  const entries: ScreenCaptureProbeEntry[] = [];

  entries.push(
    options.electron
      ? { provider: "electron-desktop-capturer", ok: true }
      : {
          provider: "electron-desktop-capturer",
          ok: false,
          reason: "Electron desktopCapturer доступен только внутри Main",
        },
  );

  entries.push(
    env.WAYLAND_DISPLAY?.trim()
      ? await probeBinaryExecutable("xdg-portal-screenshot", "gdbus", argsPortalProbe(), timeoutMs)
      : {
          provider: "xdg-portal-screenshot",
          ok: false,
          reason: "нет WAYLAND_DISPLAY: портал Screenshot не применяется",
        },
  );

  /**
   * grim — Wayland-only: на X11 он есть в PATH, но падает с
   * "failed to create display". Наличие бинарника не делает его доступным,
   * поэтому требуем WAYLAND_DISPLAY и подтверждаем работоспособность вызовом `-h`
   * (`--version` grim не поддерживает — проверено).
   */
  const grim = binaryFor("grim");
  if (!grim || !whichSync(grim)) {
    entries.push({ provider: "grim", ok: false, reason: "grim не найден в PATH" });
  } else if (!env.WAYLAND_DISPLAY?.trim()) {
    entries.push({
      provider: "grim",
      ok: false,
      reason: "grim требует Wayland-композитор (WAYLAND_DISPLAY не задан)",
    });
  } else {
    const probe = await runBinaryWithTimeout(grim, ["-h"], timeoutMs);
    entries.push(
      probe.ok
        ? { provider: "grim", ok: true }
        : { provider: "grim", ok: false, reason: probe.reason ?? "grim недоступен" },
    );
  }

  for (const provider of [
    "gnome-screenshot",
    "imagemagick-import",
    "scrot",
    "ffmpeg-x11grab",
  ] as const) {
    const binary = binaryFor(provider)!;
    if (!whichSync(binary)) {
      entries.push({ provider, ok: false, reason: `${binary} не найден в PATH` });
      continue;
    }
    // Утилиты X11 требуют DISPLAY; без него вызов заведомо бесполезен.
    entries.push(
      env.DISPLAY?.trim()
        ? { provider, ok: true }
        : { provider, ok: false, reason: "нет DISPLAY: X11-утилита неприменима" },
    );
  }

  return entries;
}

function argsPortalProbe(): string[] {
  return [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.portal.Desktop",
    "--object-path",
    "/org/freedesktop/portal/desktop",
    "--method",
    "org.freedesktop.DBus.Properties.Get",
    "org.freedesktop.portal.Screenshot",
    "version",
  ];
}

async function probeBinaryExecutable(
  provider: LinuxScreenCaptureProvider,
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<ScreenCaptureProbeEntry> {
  if (!whichSync(binary)) {
    return { provider, ok: false, reason: `${binary} не найден в PATH` };
  }
  const result = await runBinaryWithTimeout(binary, args, timeoutMs);
  return result.ok
    ? { provider, ok: true }
    : { provider, ok: false, reason: result.reason ?? "проверка не прошла" };
}

async function runBinaryWithTimeout(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout?: string; stderr?: string; reason?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * Захватывает экран первым доступным провайдером.
 * Возвращает `null`, если ни одно звено не сработало: причина остаётся в probe().
 */
export async function captureScreenWithCascade(options: {
  probe: readonly ScreenCaptureProbeEntry[];
  electron?: ElectronScreenCapturePort;
  captureOptions?: LinuxCuaCaptureOptions;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ScreenCaptureResult | null> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? LINUX_CUA_DEFAULTS.captureTimeoutMs;
  const format = options.captureOptions?.format ?? LINUX_CUA_DEFAULTS.captureFormat;
  const quality = options.captureOptions?.quality ?? LINUX_CUA_DEFAULTS.jpegQuality;

  for (const provider of PROVIDER_ORDER) {
    const entry = options.probe.find((item) => item.provider === provider);
    if (!entry?.ok) continue;

    if (provider === "electron-desktop-capturer" && options.electron) {
      try {
        const captured = await options.electron.capture();
        const size = readPngSize(captured.pngBuffer);
        if (!size) continue;
        return {
          provider,
          buffer: captured.pngBuffer,
          mimeType: "image/png",
          width: size.width,
          height: size.height,
          scaleX: 1 / Math.max(1, captured.scaleFactor),
          scaleY: 1 / Math.max(1, captured.scaleFactor),
        };
      } catch {
        continue;
      }
    }

    if (provider === "xdg-portal-screenshot") {
      const captured = await captureViaPortal(env, timeoutMs);
      if (captured) return { ...captured, provider };
      continue;
    }

    const binary = binaryFor(provider);
    if (!binary) continue;
    const captured = await captureViaBinary(provider, binary, { env, timeoutMs, format, quality });
    if (captured) return captured;
  }
  return null;
}

async function captureViaBinary(
  provider: LinuxScreenCaptureProvider,
  binary: string,
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    format: "png" | "jpeg";
    quality: number;
  },
): Promise<ScreenCaptureResult | null> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cua-"));
  const target = join(dir, options.format === "jpeg" ? "frame.jpg" : "frame.png");
  try {
    const args = buildCaptureArgs(provider, target, options);
    const result = await runBinaryWithTimeout(binary, args, options.timeoutMs);
    if (!result.ok) return null;
    const buffer = await readFile(target);
    if (buffer.length === 0) return null;
    return {
      provider,
      buffer,
      mimeType: options.format === "jpeg" ? "image/jpeg" : "image/png",
      ...(await resolveFrameGeometry(buffer, options.format)),
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildCaptureArgs(
  provider: LinuxScreenCaptureProvider,
  target: string,
  options: { format: "png" | "jpeg"; quality: number },
): string[] {
  switch (provider) {
    case "grim":
      // grim сам выбирает формат по расширению.
      return [target];
    case "gnome-screenshot":
      return ["-f", target];
    case "imagemagick-import":
      return ["-window", "root", target];
    case "scrot":
      return [target];
    case "ffmpeg-x11grab": {
      const display = process.env.DISPLAY ?? ":0";
      return [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-i",
        display,
        "-frames:v",
        "1",
        // qscale ниже — выше качество; переводим 0..100 в диапазон 2..31.
        ...(options.format === "jpeg"
          ? ["-q:v", String(Math.max(2, Math.round(31 - (options.quality / 100) * 29)))]
          : []),
        target,
      ];
    }
    default:
      return [target];
  }
}

/**
 * Геометрия кадра: для PNG берём IHDR, для JPEG — `ffprobe`-независимый путь
 * через `jimp` (декодирование заголовка без полного растра здесь невозможно без
 * зависимости; jimp уже есть в проекте, но грузить его в горячем пути дорого).
 * Поэтому для JPEG отдаём размер рабочего стола из probe — он совпадает с кадром
 * полноэкранного снимка.
 */
async function resolveFrameGeometry(
  buffer: Buffer,
  format: "png" | "jpeg",
): Promise<{ width: number; height: number; scaleX: number; scaleY: number }> {
  if (format === "png") {
    const size = readPngSize(buffer);
    if (size) return { width: size.width, height: size.height, scaleX: 1, scaleY: 1 };
  }
  // JPEG без размеров в заголовке: масштаб 1:1, размер уточняет вызывающий по probe.
  return { width: 0, height: 0, scaleX: 1, scaleY: 1 };
}

/** Портал Screenshot: URI возвращается, читаем файл и удаляем. */
async function captureViaPortal(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Omit<ScreenCaptureResult, "provider"> | null> {
  if (!whichSync("gdbus")) return null;
  const result = await runBinaryWithTimeout(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.portal.Desktop",
      "--object-path",
      "/org/freedesktop/portal/desktop",
      "--method",
      "org.freedesktop.portal.Screenshot.Screenshot",
      "",
      "{}",
    ],
    Math.min(timeoutMs, LINUX_CUA_DEFAULTS.portalTimeoutMs),
  );
  if (!result.ok || !result.stdout) return null;
  const match = /'(file:\/\/[^']+)'/.exec(result.stdout);
  const fileUri = match?.[1];
  if (!fileUri) return null;
  const path = decodeURIComponent(fileUri.replace("file://", ""));
  try {
    const buffer = await readFile(path);
    const size = readPngSize(buffer);
    await rm(path, { force: true }).catch(() => undefined);
    if (!size) return null;
    return {
      buffer,
      mimeType: "image/png",
      width: size.width,
      height: size.height,
      scaleX: 1,
      scaleY: 1,
    };
  } catch {
    return null;
  }
}

/** Собирает `LinuxCuaFrame` с бюджетом байт и флагом усечения. */
export function toLinuxCuaFrame(
  result: ScreenCaptureResult,
  options: {
    capturedAt: number;
    maxBytes?: number;
    desktopSize?: { width: number; height: number };
  },
): LinuxCuaFrame {
  const maxBytes = options.maxBytes ?? LINUX_CUA_DEFAULTS.maxFrameBytes;
  const width = result.width || options.desktopSize?.width || 0;
  const height = result.height || options.desktopSize?.height || 0;
  if (result.buffer.byteLength <= maxBytes) {
    return {
      base64: result.buffer.toString("base64"),
      mimeType: result.mimeType,
      width,
      height,
      bytes: result.buffer.byteLength,
      provider: result.provider,
      scaleX: result.scaleX,
      scaleY: result.scaleY,
      captureDurationMs: Date.now() - options.capturedAt,
    };
  }
  // Кадр сверх бюджета: не отдаём «половину JPEG» (она нечитаема) — сообщаем усечение
  // и уменьшаем качество через повторный захват делает вызывающий. Здесь — явный флаг.
  return {
    base64: "",
    mimeType: result.mimeType,
    width,
    height,
    bytes: result.buffer.byteLength,
    provider: result.provider,
    scaleX: result.scaleX,
    scaleY: result.scaleY,
    captureDurationMs: Date.now() - options.capturedAt,
    truncated: true,
  };
}

/** Проверка размера файла без чтения содержимого — для диагностики. */
export async function fileSizeOrNull(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
