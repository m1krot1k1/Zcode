/**
 * Реализация `LinuxCuaHostContract`: единственный владелец состояния Linux CUA.
 *
 * Что здесь принадлежит хосту:
 * - результат `probe()` с TTL-кэшем (провайдеры не перепроверяются на каждое действие);
 * - открытый X11-дисплей (`X11KoffiInput`) — закрывается в `dispose()`;
 * - сессия портала RemoteDesktop, если она понадобилась;
 * - геометрия рабочего стола для нормализации координат.
 *
 * Политики разрешений приходят снаружи: хост не решает, «можно ли», он исполняет
 * уже разрешённое и возвращает `permission_denied` при запрете.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  LINUX_CUA_DEFAULTS,
  type LinuxCuaCapabilityReport,
  type LinuxCuaCaptureOptions,
  type LinuxCuaFrame,
  type LinuxCuaHostContract,
  type LinuxCuaOperation,
  type LinuxCuaOperationResult,
  type LinuxCuaScreenshotPermission,
  type LinuxDisplayProbeResult,
} from "./contract.js";
import {
  captureScreenWithCascade,
  probeScreenCaptureProviders,
  toLinuxCuaFrame,
  type ElectronScreenCapturePort,
  type ScreenCaptureProbeEntry,
} from "./linux-screen-capture.js";
import { X11KoffiInput, probeX11Ffi } from "./x11-koffi-input.js";
import {
  createWaylandRemoteDesktopSession,
  probeWaylandRemoteDesktopPortal,
  portalKeyboardKeycode,
  portalPointerButton,
  portalPointerMotionAbsolute,
  type WaylandPortalSession,
} from "./wayland-portal-client.js";

const execFileAsync = promisify(execFile);
const logger = createServiceLogger("cua-linux-host");

export interface LinuxCuaHostOptions {
  /** Внедряемый Electron Main порт захвата; вне Main отсутствует. */
  electronCapture?: ElectronScreenCapturePort;
  /** Платформа для тестов/эмуляции; по умолчанию реальная. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Отключить кэш probe (для тестов). */
  probeCacheMs?: number;
}

interface CachedProbe {
  report: LinuxCuaCapabilityReport;
  screenProbes: ScreenCaptureProbeEntry[];
  at: number;
}

export class LinuxCuaHost implements LinuxCuaHostContract {
  readonly #options: LinuxCuaHostOptions;
  readonly #env: NodeJS.ProcessEnv;
  readonly #probeCacheMs: number;
  #cached: CachedProbe | undefined;
  #x11: X11KoffiInput | null | undefined;
  #portal: WaylandPortalSession | null | undefined;
  #disposed = false;

  constructor(options: LinuxCuaHostOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#probeCacheMs = options.probeCacheMs ?? LINUX_CUA_DEFAULTS.probeCacheMs;
  }

  async probe(options: { refresh?: boolean } = {}): Promise<LinuxCuaCapabilityReport> {
    if (this.#disposed) {
      return this.#unavailableReport("unknown-error", "CUA Linux host освобождён (dispose)");
    }
    const now = Date.now();
    if (!options.refresh && this.#cached && now - this.#cached.at < this.#probeCacheMs) {
      return this.#cached.report;
    }

    const platform = this.#options.platform ?? process.platform;
    if (platform !== "linux") {
      const report = this.#unavailableReport("not-linux", `платформа ${platform} не Linux`);
      this.#cached = { report, screenProbes: [], at: now };
      return report;
    }

    const display = await this.#probeDisplay();
    if (display.backend === "headless") {
      const report: LinuxCuaCapabilityReport = {
        available: false,
        backend: "headless",
        screenCaptureProvider: "none",
        inputProvider: "none",
        availableReasons: [
          {
            provider: "display-server",
            ok: false,
            reason: "нет ни DISPLAY, ни WAYLAND_DISPLAY: графический хост отсутствует",
          },
        ],
        reason: "no-display-server",
        detail:
          "Запустите ZCode в графической сессии (X11 или Wayland) или разрешите headless-режим.",
        display,
      };
      this.#cached = { report, screenProbes: [], at: now };
      return report;
    }

    const screenProbes = await probeScreenCaptureProviders({
      ...(this.#options.electronCapture ? { electron: this.#options.electronCapture } : {}),
      env: this.#env,
    });
    const captureProvider = screenProbes.find((entry) => entry.ok)?.provider ?? "none";

    // Ввод: сначала X11/XWayland (работает и на XWayland), затем портал.
    const x11Probe = this.#env.DISPLAY?.trim() ? probeX11Ffi(this.#env) : undefined;
    let inputProvider: LinuxCuaCapabilityReport["inputProvider"] = "none";
    const reasons: Array<{ provider: string; ok: boolean; reason?: string }> = [];
    if (x11Probe?.ok) {
      inputProvider = "x11-xtest";
      reasons.push({ provider: "x11-xtest", ok: true });
    } else if (x11Probe) {
      reasons.push({
        provider: "x11-xtest",
        ok: false,
        reason: x11Probe.detail ?? x11Probe.reason,
      });
    }
    if (inputProvider === "none") {
      const portal = await probeWaylandRemoteDesktopPortal(this.#env);
      if (portal.available) {
        inputProvider = "wayland-remote-desktop";
        reasons.push({
          provider: "wayland-remote-desktop",
          ok: true,
          ...(portal.reason ? { reason: portal.reason } : {}),
        });
      } else {
        reasons.push({
          provider: "wayland-remote-desktop",
          ok: false,
          ...(portal.reason ? { reason: portal.reason } : {}),
        });
      }
    }

    const availableReasons = [
      ...screenProbes.map((entry) => ({
        provider: `capture:${entry.provider}`,
        ok: entry.ok,
        ...(entry.reason ? { reason: entry.reason } : {}),
      })),
      ...reasons,
    ];

    let reason: LinuxCuaCapabilityReport["reason"];
    let detail: string | undefined;
    if (captureProvider === "none" && inputProvider === "none") {
      reason = "no-screen-capture-provider";
      detail =
        "Не найден ни один работающий провайдер захвата экрана и ни один провайдер ввода. " +
        "Установите gnome-screenshot, grim (Wayland), imagemagick или scrot.";
    } else if (captureProvider === "none") {
      reason = "no-screen-capture-provider";
      detail = "Ввод доступен, но захват экрана невозможен: CUA без наблюдения бесполезен.";
    } else if (inputProvider === "none") {
      reason = "no-input-provider";
      detail =
        "Захват работает, но синтез ввода недоступен: нет libX11/libXtst с XTest и портал RemoteDesktop не отвечает.";
    }

    const queryMethod = availableReasons.filter((entry) => entry.ok).length;
    const report: LinuxCuaCapabilityReport = {
      available: captureProvider !== "none" && inputProvider !== "none",
      backend: display.backend,
      screenCaptureProvider: captureProvider,
      inputProvider,
      availableReasons,
      ...(reason ? { reason } : {}),
      ...(detail ? { detail } : {}),
      display,
    };
    logger.debug(undefined, "[cua-linux] probe завершён", {
      backend: report.backend,
      capture: report.screenCaptureProvider,
      input: report.inputProvider,
      available: report.available,
      workingProbes: queryMethod,
    });
    this.#cached = { report, screenProbes, at: now };
    return report;
  }

  async captureScreen(options: LinuxCuaCaptureOptions = {}): Promise<LinuxCuaFrame | null> {
    if (this.#disposed) return null;
    const report = await this.probe();
    if (!report.available && report.screenCaptureProvider === "none") return null;
    const screenProbes = this.#cached?.screenProbes ?? [];
    const startedAt = Date.now();
    const captured = await captureScreenWithCascade({
      probe: screenProbes,
      ...(this.#options.electronCapture ? { electron: this.#options.electronCapture } : {}),
      captureOptions: options,
      env: this.#env,
    });
    if (!captured) return null;
    return toLinuxCuaFrame(captured, {
      capturedAt: startedAt,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(report.display.screen ? { desktopSize: report.display.screen } : {}),
    });
  }

  async execute(
    operation: LinuxCuaOperation,
    permissions: LinuxCuaScreenshotPermission,
  ): Promise<LinuxCuaOperationResult> {
    const startedAt = Date.now();
    if (this.#disposed) {
      return {
        ok: false,
        operation: operation.kind,
        code: "cua_unavailable",
        message: "CUA Linux host освобождён (dispose)",
        elapsedMs: Date.now() - startedAt,
      };
    }

    const denial = checkPermission(operation, permissions);
    if (denial) {
      return {
        ok: false,
        operation: operation.kind,
        code: "permission_denied",
        message: denial,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const report = await this.probe();
    if (!report.available) {
      return {
        ok: false,
        operation: operation.kind,
        code: "cua_unavailable",
        message: report.detail ?? "Computer Use недоступен на этом рабочем столе",
        ...(report.reason ? { reason: report.reason } : {}),
        elapsedMs: Date.now() - startedAt,
      };
    }

    try {
      if (operation.kind === "screenshot") {
        const frame = await this.captureScreen(operation.options ?? {});
        if (!frame) {
          return {
            ok: false,
            operation: operation.kind,
            code: "cua_unavailable",
            message: "Захват экрана не удался ни одним провайдером",
            reason: "no-screen-capture-provider",
            elapsedMs: Date.now() - startedAt,
          };
        }
        return { ok: true, operation: operation.kind, frame, elapsedMs: Date.now() - startedAt };
      }

      await this.#performInput(operation, report);
      return { ok: true, operation: operation.kind, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      return {
        ok: false,
        operation: operation.kind,
        code: "execution_error",
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#x11?.dispose();
    this.#x11 = undefined;
    this.#portal = null;
    this.#cached = undefined;
  }

  /** Определяет бэкенд и геометрию рабочего стола реальными вызовами. */
  async #probeDisplay(): Promise<LinuxDisplayProbeResult> {
    const sessionType = this.#env.XDG_SESSION_TYPE?.trim();
    const display = this.#env.DISPLAY?.trim();
    const waylandDisplay = this.#env.WAYLAND_DISPLAY?.trim();

    if (!display && !waylandDisplay) {
      return { backend: "headless", sessionType, display, waylandDisplay };
    }

    // Приоритет: реально работающий X11 (в т.ч. XWayland) даёт и ввод, и геометрию.
    if (display) {
      const input = this.#ensureX11();
      if (input) {
        const screen = await this.#queryXrandrGeometry();
        const position = input.pointerPosition();
        return {
          backend: "x11",
          sessionType,
          display,
          waylandDisplay,
          ...(screen.total ? { screen: screen.total } : {}),
          ...(screen.monitors.length > 0 ? { monitors: screen.monitors } : {}),
          ...(position ? {} : {}),
        };
      }
    }

    if (waylandDisplay || sessionType === "wayland") {
      return { backend: "wayland", sessionType, display, waylandDisplay };
    }
    return { backend: "headless", sessionType, display, waylandDisplay };
  }

  /** `xrandr --listmonitors` → логические размеры с масштабом. */
  async #queryXrandrGeometry(): Promise<{
    total?: { width: number; height: number };
    monitors: NonNullable<LinuxDisplayProbeResult["monitors"]>;
  }> {
    try {
      const { stdout } = await execFileAsync("xrandr", ["--listmonitors"], { timeout: 3_000 });
      const monitors: Array<NonNullable<LinuxDisplayProbeResult["monitors"]>[number]> = [];
      // Формат: ` 0: +*HDMI-0 2560/597x1440/336+0+0  HDMI-0`
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+):\s+\S*\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/u.exec(line);
        if (!match) continue;
        const [, index, widthRaw, heightRaw, xRaw, yRaw] = match;
        monitors.push({
          id: `monitor-${index}`,
          x: Number(xRaw),
          y: Number(yRaw),
          width: Number(widthRaw),
          height: Number(heightRaw),
          scale: 1,
          ...(line.includes("+*") ? { primary: true } : {}),
        });
      }
      if (monitors.length === 0) return { monitors };
      const width = Math.max(...monitors.map((monitor) => monitor.x + monitor.width));
      const height = Math.max(...monitors.map((monitor) => monitor.y + monitor.height));
      return { total: { width, height }, monitors };
    } catch {
      return { monitors: [] };
    }
  }

  async #performInput(
    operation: Exclude<LinuxCuaOperation, { kind: "screenshot" }>,
    report: LinuxCuaCapabilityReport,
  ): Promise<void> {
    if (report.inputProvider === "x11-xtest") {
      const input = this.#ensureX11();
      if (!input) throw new Error("X11-ввод стал недоступен между probe и действием");
      switch (operation.kind) {
        case "pointerMove":
          await input.movePointerSmooth(
            operation.options.x,
            operation.options.y,
            operation.options.steps ?? 1,
            operation.options.delayMs ?? 0,
          );
          return;
        case "click":
          input.click(
            operation.options.x,
            operation.options.y,
            operation.options.button ?? "left",
            operation.options.clickCount ?? 1,
          );
          return;
        case "scroll":
          input.scroll(
            operation.options.x,
            operation.options.y,
            operation.options.deltaY,
            operation.options.steps ?? 1,
          );
          return;
        case "key":
          input.pressKey(operation.options.key, operation.options.repeat ?? 1);
          return;
        case "type":
          await input.typeText(operation.options.text, operation.options.delayMs ?? 0);
          return;
      }
    }

    // Wayland-путь: сессия портала.
    const portal = await this.#ensurePortal();
    if (!portal) throw new Error("Сессия портала RemoteDesktop недоступна");
    const screen = report.display.screen ?? { width: 1, height: 1 };
    switch (operation.kind) {
      case "pointerMove":
      case "click": {
        const position = {
          x: operation.options.x,
          y: operation.options.y,
          screenWidth: screen.width,
          screenHeight: screen.height,
        };
        const moved = await portalPointerMotionAbsolute(portal, position);
        if (!moved.ok) throw new Error(`Портал отклонил движение: ${moved.detail}`);
        if (operation.kind === "click") {
          const buttonIndex =
            operation.options.button === "right"
              ? 1
              : operation.options.button === "middle"
                ? 2
                : 0;
          for (let index = 0; index < (operation.options.clickCount ?? 1); index += 1) {
            const down = await portalPointerButton(portal, buttonIndex as 0 | 1 | 2, true);
            if (!down.ok) throw new Error(`Портал отклонил нажатие: ${down.detail}`);
            const up = await portalPointerButton(portal, buttonIndex as 0 | 1 | 2, false);
            if (!up.ok) throw new Error(`Портал отклонил отпускание: ${up.detail}`);
          }
        }
        return;
      }
      case "scroll": {
        // Портал не имеет отдельного wheel-метода: эмуляция кнопками 8/9 не
        // стандартизована, поэтому честно сообщаем ограничение вместо «тихого no-op».
        throw new Error(
          "Прокрутка через портал RemoteDesktop не поддержана: используйте X11/XWayland для wheel-событий.",
        );
      }
      case "key": {
        const keycode = evdevKeycodeFor(operation.options.key);
        if (keycode === null)
          throw new Error(`Клавиша '${operation.options.key}' не имеет evdev-кода`);
        const repeat = operation.options.repeat ?? 1;
        for (let index = 0; index < repeat; index += 1) {
          const down = await portalKeyboardKeycode(portal, keycode, true);
          if (!down.ok) throw new Error(`Портал отклонил клавишу: ${down.detail}`);
          const up = await portalKeyboardKeycode(portal, keycode, false);
          if (!up.ok) throw new Error(`Портал отклонил отпускание клавиши: ${up.detail}`);
        }
        return;
      }
      case "type": {
        for (const char of operation.options.text) {
          const keycode = evdevKeycodeForCharacter(char);
          if (keycode === null) {
            throw new Error(
              `Символ '${char}' не имеет evdev-соответствия; на Wayland используйте clipboard-путь.`,
            );
          }
          await portalKeyboardKeycode(portal, keycode, true);
          await portalKeyboardKeycode(portal, keycode, false);
        }
        return;
      }
    }
  }

  #ensureX11(): X11KoffiInput | null {
    if (this.#x11 !== undefined) return this.#x11;
    try {
      this.#x11 = X11KoffiInput.create(this.#env);
    } catch (error) {
      logger.warn(undefined, "[cua-linux] X11 FFI недоступен", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.#x11 = null;
    }
    return this.#x11;
  }

  async #ensurePortal(): Promise<WaylandPortalSession | null> {
    if (this.#portal !== undefined) return this.#portal;
    this.#portal = await createWaylandRemoteDesktopSession();
    return this.#portal;
  }

  #unavailableReport(
    reason: NonNullable<LinuxCuaCapabilityReport["reason"]>,
    detail: string,
  ): LinuxCuaCapabilityReport {
    return {
      available: false,
      backend: "headless",
      screenCaptureProvider: "none",
      inputProvider: "none",
      availableReasons: [{ provider: "host", ok: false, reason: detail }],
      reason,
      detail,
      display: {
        backend: "headless",
        sessionType: this.#env.XDG_SESSION_TYPE,
        display: this.#env.DISPLAY,
        waylandDisplay: this.#env.WAYLAND_DISPLAY,
      },
    };
  }
}

/** Проверка гранулярных политик; возвращает причину отказа или `null`. */
function checkPermission(
  operation: LinuxCuaOperation,
  permissions: LinuxCuaScreenshotPermission,
): string | null {
  if (operation.kind === "screenshot" && permissions.screenshot === "deny") {
    return "Захват экрана запрещён политикой CUA Permission Broker (screenshot: deny)";
  }
  if (
    (operation.kind === "pointerMove" ||
      operation.kind === "click" ||
      operation.kind === "scroll") &&
    permissions.pointer === "deny"
  ) {
    return "Управление указателем запрещено политикой CUA Permission Broker (pointer: deny)";
  }
  if ((operation.kind === "key" || operation.kind === "type") && permissions.keyboard === "deny") {
    return "Синтез клавиатуры запрещён политикой CUA Permission Broker (keyboard: deny)";
  }
  return null;
}

/**
 * Минимальная таблица evdev-кодов для портал-пути.
 *
 * Полный Unicode-ввод на Wayland требует xkbcommon-трансляции; здесь покрыт
 * практический минимум (буквы, цифры, базовые клавиши). Неподдержанный символ
 * даёт явную ошибку, а не тихий пропуск.
 */
const EVDEV_KEYCODES: Readonly<Record<string, number>> = {
  Escape: 1,
  Tab: 15,
  BackSpace: 14,
  Return: 28,
  Enter: 28,
  space: 57,
  Shift_L: 42,
  Control_L: 29,
  Alt_L: 56,
  Super_L: 125,
  a: 30,
  b: 48,
  c: 46,
  d: 32,
  e: 18,
  f: 33,
  g: 34,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  l: 38,
  m: 50,
  n: 49,
  o: 24,
  p: 25,
  q: 16,
  r: 19,
  s: 31,
  t: 20,
  u: 22,
  v: 47,
  w: 17,
  x: 45,
  y: 21,
  z: 44,
  "0": 11,
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 5,
  "5": 6,
  "6": 7,
  "7": 8,
  "8": 9,
  "9": 10,
  "-": 12,
  "=": 13,
  "[": 26,
  "]": 27,
  "\\": 43,
  ";": 39,
  "'": 40,
  ",": 51,
  ".": 52,
  "/": 53,
  "`": 41,
};

function evdevKeycodeFor(key: string): number | null {
  const last = key.split("+").at(-1)?.trim() ?? key;
  return EVDEV_KEYCODES[last] ?? EVDEV_KEYCODES[last.toLowerCase()] ?? null;
}

function evdevKeycodeForCharacter(char: string): number | null {
  return EVDEV_KEYCODES[char] ?? EVDEV_KEYCODES[char.toLowerCase()] ?? null;
}

/** Фабрика: единственный способ получить хост (скрывает конструктор от вызывающих). */
export function createLinuxCuaHost(options: LinuxCuaHostOptions = {}): LinuxCuaHost {
  return new LinuxCuaHost(options);
}
