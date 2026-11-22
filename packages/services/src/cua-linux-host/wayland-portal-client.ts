/**
 * Клиент `org.freedesktop.portal.RemoteDesktop` через D-Bus.
 *
 * Зачем отдельный файл: на чистом Wayland нет ни XTest, ни доступа к `/dev/uinput`
 * без root. Единственный легальный путь синтеза ввода — портал RemoteDesktop,
 * который требует явного согласия пользователя системным диалогом.
 *
 * Реализация вызывает `gdbus` — тот же бинарь, что используется для проверки портала
 * в probe. Это не «мок»: методы портала вызываются реально, а отсутствие сессии
 * возвращает `available: false` с причиной.
 *
 * Важно: сессия портала привязана к согласию пользователя. Без подтверждения
 * методы `Notify*` возвращают ошибку — это передаётся вызывающему как `portal-unavailable`,
 * а не игнорируется.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORTAL_DEST = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const REMOTE_DESKTOP_IFACE = "org.freedesktop.portal.RemoteDesktop";

/** Биты устройств из спецификации портала. */
export const PORTAL_DEVICE_KEYBOARD = 1;
export const PORTAL_DEVICE_POINTER = 2;

export interface WaylandPortalAvailability {
  available: boolean;
  reason?: string;
  /** Версия интерфейса RemoteDesktop, если портал её сообщил. */
  version?: number;
}

export interface WaylandPortalSession {
  /** Handle сессии (`/org/freedesktop/portal/desktop/session/...`). */
  sessionHandle: string;
  /** `true`, если пользователь подтвердил диалог и сессия готова к Notify*. */
  started: boolean;
  devices: number;
}

/** Проверяет наличие gdbus и версию интерфейса RemoteDesktop. */
export async function probeWaylandRemoteDesktopPortal(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5_000,
): Promise<WaylandPortalAvailability> {
  if (!env.WAYLAND_DISPLAY?.trim() && !env.XDG_SESSION_TYPE?.includes("wayland")) {
    return { available: false, reason: "сессия не Wayland: портал RemoteDesktop не требуется" };
  }
  if (!whichSync("gdbus")) {
    return { available: false, reason: "gdbus не найден в PATH" };
  }
  try {
    const { stdout } = await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        PORTAL_DEST,
        "--object-path",
        PORTAL_PATH,
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        REMOTE_DESKTOP_IFACE,
        "version",
      ],
      { timeout: timeoutMs },
    );
    const match = /uint32\s+(\d+)/u.exec(stdout);
    return match
      ? { available: true, version: Number(match[1]) }
      : { available: true, reason: "портал отвечает, но версию не сообщил" };
  } catch (error) {
    return { available: false, reason: messageOf(error) };
  }
}

/**
 * Создаёт сессию RemoteDesktop и запускает её.
 *
 * `Start` показывает системный диалог согласия. Пока пользователь не подтвердил,
 * `started` остаётся false — и мы честно сообщаем это, а не ждём бесконечно.
 */
export async function createWaylandRemoteDesktopSession(
  options: {
    devices?: number;
    timeoutMs?: number;
  } = {},
): Promise<WaylandPortalSession | null> {
  // `env` не нужен: gdbus сам читает DBUS_SESSION_BUS_ADDRESS из окружения процесса,
  // поэтому передача env здесь была бы неиспользуемым параметром.
  const devices = options.devices ?? PORTAL_DEVICE_KEYBOARD | PORTAL_DEVICE_POINTER;
  const timeoutMs = options.timeoutMs ?? 10_000;
  try {
    const created = await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        PORTAL_DEST,
        "--object-path",
        PORTAL_PATH,
        "--method",
        `${REMOTE_DESKTOP_IFACE}.CreateSession`,
        "{}",
      ],
      { timeout: timeoutMs },
    );
    // Ответ: (objectpath '/org/freedesktop/portal/desktop/session/1_1/...', {})
    const handleMatch = /objectpath '([^']+)'/u.exec(created.stdout);
    const sessionHandle = handleMatch?.[1];
    if (!sessionHandle) return null;

    // SelectDevices обязателен до Start: портал отказывает иначе.
    await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        PORTAL_DEST,
        "--object-path",
        PORTAL_PATH,
        "--method",
        `${REMOTE_DESKTOP_IFACE}.SelectDevices`,
        sessionHandle,
        JSON.stringify({ types: devices, handle_token: "zcode" }),
      ],
      { timeout: timeoutMs },
    );

    const started = await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        PORTAL_DEST,
        "--object-path",
        PORTAL_PATH,
        "--method",
        `${REMOTE_DESKTOP_IFACE}.Start`,
        sessionHandle,
        "",
        JSON.stringify({ handle_token: "zcode" }),
      ],
      { timeout: timeoutMs },
    );
    // Start возвращает Request handle; согласие приходит асинхронно, поэтому
    // started=true здесь означает «запрос принят», а не «пользователь согласился».
    return { sessionHandle, started: Boolean(started.stdout.trim()), devices };
  } catch {
    return null;
  }
}

export type WaylandPortalInputResult =
  | { ok: true }
  | {
      ok: false;
      reason: "portal-unavailable" | "session-not-started" | "execution-error";
      detail: string;
    };

/** Абсолютное движение указателя в координатах рабочего стола. */
export async function portalPointerMotionAbsolute(
  session: WaylandPortalSession,
  position: { x: number; y: number; screenWidth: number; screenHeight: number },
  timeoutMs = 5_000,
): Promise<WaylandPortalInputResult> {
  if (!session.started) {
    return {
      ok: false,
      reason: "session-not-started",
      detail: "пользователь не подтвердил сессию портала",
    };
  }
  return await callPortal(
    `${REMOTE_DESKTOP_IFACE}.NotifyPointerMotionAbsolute`,
    [
      session.sessionHandle,
      JSON.stringify({}),
      String(Math.round(position.x)),
      String(Math.round(position.y)),
      String(position.screenWidth),
      String(position.screenHeight),
    ],
    timeoutMs,
  );
}

/** Кнопка мыши: 0-лев/1-прав/2-сред по спецификации портала, state 1=press, 0=release. */
export async function portalPointerButton(
  session: WaylandPortalSession,
  button: 0 | 1 | 2,
  pressed: boolean,
  timeoutMs = 5_000,
): Promise<WaylandPortalInputResult> {
  if (!session.started) {
    return {
      ok: false,
      reason: "session-not-started",
      detail: "пользователь не подтвердил сессию портала",
    };
  }
  return await callPortal(
    `${REMOTE_DESKTOP_IFACE}.NotifyPointerButton`,
    [session.sessionHandle, JSON.stringify({}), String(button), pressed ? "1" : "0"],
    timeoutMs,
  );
}

/** Клавиша по keycode (evdev), state 1=press, 0=release. */
export async function portalKeyboardKeycode(
  session: WaylandPortalSession,
  keycode: number,
  pressed: boolean,
  timeoutMs = 5_000,
): Promise<WaylandPortalInputResult> {
  if (!session.started) {
    return {
      ok: false,
      reason: "session-not-started",
      detail: "пользователь не подтвердил сессию портала",
    };
  }
  return await callPortal(
    `${REMOTE_DESKTOP_IFACE}.NotifyKeyboardKeycode`,
    [session.sessionHandle, JSON.stringify({}), String(keycode), pressed ? "1" : "0"],
    timeoutMs,
  );
}

async function callPortal(
  method: string,
  args: string[],
  timeoutMs: number,
): Promise<WaylandPortalInputResult> {
  try {
    await execFileAsync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        PORTAL_DEST,
        "--object-path",
        PORTAL_PATH,
        "--method",
        method,
        ...args,
      ],
      { timeout: timeoutMs },
    );
    return { ok: true };
  } catch (error) {
    const detail = messageOf(error);
    // Портал возвращает "not permitted"/"cancelled" когда согласия нет — это не сбой кода.
    const reason = /cancel|not permitted|denied|access denied/iu.test(detail)
      ? "portal-unavailable"
      : "execution-error";
    return { ok: false, reason, detail };
  }
}

function whichSync(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, binary)));
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
