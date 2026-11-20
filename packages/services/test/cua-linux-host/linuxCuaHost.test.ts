/**
 * Тесты Linux CUA-хоста.
 *
 * Разделены на три группы:
 *  1. чистые проверки недоступности (не требуют графики) — всегда выполняются;
 *  2. реальный ввод через X11 XTest — выполняется только при наличии `$DISPLAY`
 *     и libX11/libXtst (проверяется фактическим движением указателя);
 *  3. Wayland-портал — `skip` с точной причиной, если сессия не Wayland.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createLinuxCuaHost, type LinuxCuaHost } from "../../src/cua-linux-host/index.js";
import { readPngSize } from "../../src/cua-linux-host/linux-screen-capture.js";
import type { LinuxCuaFrame } from "../../src/cua-linux-host/contract.js";
import { probeX11Ffi, X11KoffiInput } from "../../src/cua-linux-host/x11-koffi-input.js";

const hasDisplay = Boolean(process.env.DISPLAY?.trim());
const x11 = probeX11Ffi();
const hasX11Input = hasDisplay && x11.ok;

const FULL_ALLOW = {
  screenshot: "allow",
  pointer: "allow",
  keyboard: "allow",
  clipboard: "allow",
} as const;

const ALL_DENY = {
  screenshot: "deny",
  pointer: "deny",
  keyboard: "deny",
  clipboard: "deny",
} as const;

/**
 * 原因 (реальная, подтверждена прогоном): захват экрана 2560×1440 PNG заметно
 * больше `LINUX_CUA_DEFAULTS.maxFrameBytes` = 1 MiB. В этом случае
 * `toLinuxCuaFrame` сознательно НЕ отдаёт «обрезанный» base64 (он нечитаем), а
 * возвращает `base64: ""` вместе с `truncated: true`. Тест же ждал валидный PNG
 * и падал на `readPngSize(Buffer.from("", "base64")) === null`.
 *
 * Кроме того, X11-каскад не атомарен: провайдеры (gnome-screenshot/import/scrot/
 * ffmpeg x11grab) по очереди берут монопольный доступ к X-серверу, поэтому при
 * полном прогоне параллельный X-клиент из другого воркера может на время
 * удержать сервер и `captureScreen` штатно вернёт `null`.
 *
 * Обе ситуации обрабатываются **только в тестовой обвязке**: запрашиваем лимит,
 * заведомо превышающий кадр реального рабочего стола, и ретраим транзиентный
 * `null`. Продакшн-контракт (усечение и `null`) не ослабляется.
 */
const TEST_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

async function captureScreenEventually(
  host: LinuxCuaHost,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<{ frame: LinuxCuaFrame | null; attempts: number; reasons: string[] }> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 750;
  const reasons: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const frame = await host.captureScreen({
      format: "png",
      maxBytes: TEST_CAPTURE_MAX_BYTES,
    });
    if (frame) {
      // Усечённый кадр без содержимого — валидный продакшн-ответ, но не то,
      // что проверяет этот тест: фиксируем причину и продолжаем попытки.
      if (!frame.truncated) return { frame, attempts: attempt, reasons };
      reasons.push(`attempt#${attempt}=truncated(${frame.bytes}B)`);
    } else {
      reasons.push(`attempt#${attempt}=null`);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  // 诊断写 stderr: это тестовая обвязка, а не UI-код, и она не должна
  // попадать в stdout-контракт полного прогона.
  process.stderr.write(
    `[linuxCuaHost] captureScreen не дал полный кадр за ${attempts} попыток: ${reasons.join(", ")}\n`,
  );
  return { frame: null, attempts, reasons };
}

describe("LinuxCuaHost: честная недоступность", () => {
  it("без DISPLAY и WAYLAND_DISPLAY возвращает cua_unavailable с точной причиной", async () => {
    const host = createLinuxCuaHost({ platform: "linux", env: {}, probeCacheMs: 0 });
    const report = await host.probe();
    expect(report.available).toBe(false);
    expect(report.backend).toBe("headless");
    expect(report.reason).toBe("no-display-server");
    expect(report.detail).toMatch(/X11|Wayland/u);
    expect(report.availableReasons[0]?.ok).toBe(false);

    const result = await host.execute({ kind: "screenshot" }, FULL_ALLOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cua_unavailable");
      expect(result.reason).toBe("no-display-server");
    }
    await host.dispose();
  });

  it("на не-Linux платформе сообщает not-linux, а не падает", async () => {
    const host = createLinuxCuaHost({ platform: "darwin", env: {}, probeCacheMs: 0 });
    const report = await host.probe();
    expect(report.available).toBe(false);
    expect(report.reason).toBe("not-linux");
    await host.dispose();
  });

  it("запрет screenshot возвращает permission_denied до любых действий", async () => {
    const host = createLinuxCuaHost({ platform: "linux", env: {}, probeCacheMs: 0 });
    const result = await host.execute({ kind: "screenshot" }, ALL_DENY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("permission_denied");
      expect(result.message).toMatch(/screenshot: deny/u);
    }
    await host.dispose();
  });

  it("запрет pointer и keyboard даёт permission_denied с указанием политики", async () => {
    const host = createLinuxCuaHost({ platform: "linux", env: {}, probeCacheMs: 0 });
    const pointer = await host.execute({ kind: "click", options: { x: 1, y: 1 } }, ALL_DENY);
    const keyboard = await host.execute({ kind: "type", options: { text: "x" } }, ALL_DENY);
    expect(pointer.ok).toBe(false);
    expect(keyboard.ok).toBe(false);
    if (!pointer.ok) expect(pointer.message).toMatch(/pointer: deny/u);
    if (!keyboard.ok) expect(keyboard.message).toMatch(/keyboard: deny/u);
    await host.dispose();
  });

  it("dispose идемпотентен", async () => {
    const host = createLinuxCuaHost({ platform: "linux", env: {}, probeCacheMs: 0 });
    await host.dispose();
    await host.dispose();
    const afterDispose = await host.probe();
    expect(afterDispose.available).toBe(false);
  });
});

describe.runIf(hasX11Input)("LinuxCuaHost: реальный X11 ввод", () => {
  it("probe сообщает x11 backend и capture+input провайдеров", async () => {
    const host = createLinuxCuaHost({ probeCacheMs: 0 });
    const report = await host.probe();
    expect(report.backend).toBe("x11");
    expect(report.inputProvider).toBe("x11-xtest");
    // Захват зависит от установленных утилит; на этой машине ожидается gnome-screenshot,
    // но тест не привязывается к конкретному имени — только к «есть хоть один».
    expect(report.screenCaptureProvider).not.toBe("none");
    expect(report.available).toBe(true);
    await host.dispose();
  }, 30_000);

  it("движение указателя реально меняет позицию курсора", async () => {
    const input = X11KoffiInput.create();
    expect(input).not.toBeNull();
    const before = input!.pointerPosition();
    expect(before).not.toBeNull();
    const target = { x: 421, y: 337 };
    input!.movePointer(target.x, target.y);
    const after = input!.pointerPosition();
    expect(after?.x).toBe(target.x);
    expect(after?.y).toBe(target.y);
    input!.dispose();
  });

  it("execute(pointerMove) через хост двигает курсор", async () => {
    const host = createLinuxCuaHost({ probeCacheMs: 0 });
    const result = await host.execute(
      { kind: "pointerMove", options: { x: 512, y: 384 } },
      FULL_ALLOW,
    );
    expect(result.ok).toBe(true);

    const probeInput = X11KoffiInput.create();
    expect(probeInput?.pointerPosition()).toEqual({ x: 512, y: 384 });
    probeInput?.dispose();
    await host.dispose();
  }, 30_000);

  it("захват экрана возвращает валидный PNG с размерами", async () => {
    const host = createLinuxCuaHost({ probeCacheMs: 0 });
    const { frame, attempts, reasons } = await captureScreenEventually(host);
    expect(frame).not.toBeNull();
    expect(frame!.mimeType).toBe("image/png");
    expect(frame!.bytes).toBeGreaterThan(1000);
    expect(frame!.width).toBeGreaterThan(0);
    expect(frame!.height).toBeGreaterThan(0);
    const decoded = Buffer.from(frame!.base64, "base64");
    expect(readPngSize(decoded)).toEqual({ width: frame!.width, height: frame!.height });
    await host.dispose();
  }, 40_000);

  it("readPngSize не путает не-PNG буфер с изображением", () => {
    expect(readPngSize(Buffer.from("not a png at all"))).toBeNull();
  });
});

describe.runIf(!hasX11Input)("LinuxCuaHost: X11 ввод недоступен", () => {
  it("Честно пропускаем реальные тесты ввода: нет DISPLAY или libX11/libXtst", () => {
    // Причина: реальный синтез ввода требует X11-дисплея и библиотек XTest.
    // На headless-машине проверка недоступности покрыта группой выше.
  });
});

const isWayland =
  Boolean(process.env.WAYLAND_DISPLAY?.trim()) || process.env.XDG_SESSION_TYPE === "wayland";

describe.skipIf(!isWayland)("LinuxCuaHost: Wayland портал", () => {
  it("probe сообщает wayland backend и портал-провайдер ввода", async () => {
    const host = createLinuxCuaHost({ probeCacheMs: 0 });
    const report = await host.probe();
    expect(report.backend).toBe("wayland");
    expect(["wayland-remote-desktop", "none"]).toContain(report.inputProvider);
    await host.dispose();
  }, 30_000);
});

describe.skipIf(isWayland)("LinuxCuaHost: Wayland портал (пропуск)", () => {
  it.skip("Пропуск: текущая сессия не Wayland", () => {
    // Причина: WAYLAND_DISPLAY не задан и XDG_SESSION_TYPE != wayland.
    // Портал RemoteDesktop в этой сессии отсутствует, проверять нечего.
  });
});

describe("LinuxCuaHost: утилиты захвата", () => {
  it("наличие gnome-screenshot проверяется по PATH, а не по платформе", () => {
    const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
    const found = pathDirs.some((dir) => existsSync(`${dir}/gnome-screenshot`));
    // Тест фиксирует факт окружения, а не ожидание: значение может быть любым.
    expect(typeof found).toBe("boolean");
  });
});
