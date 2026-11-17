/**
 * Синтез ввода на X11/XWayland через прямой FFI к libX11/libXtst.
 *
 * Почему koffi, а не xdotool: xdotool — внешний процесс на каждое действие
 * (десятки миллисекунд на spawn) и дополнительная зависимость. koffi уже есть в
 * проекте и даёт реальные вызовы `XTestFake*` без промежуточного процесса.
 *
 * Все out-параметры передаются через `koffi.out(...)`: без этого koffi молча
 * возвращает нули вместо значений XQueryPointer (проверено эмпирически).
 */
import koffi from "koffi";
import type { LinuxCuaMouseButton } from "./contract.js";

/**
 * 修复原因：koffi 的类型声明对 `func()` 返回的函数签名做了强约束（0 参数），
 * 而 FFI 调用本来就要传任意参数个数；直接 cast 会触发 TS2352。
 * 这里只在本模块内声明最小 FFI 面，参数类型保持 `unknown[]`，把类型安全
 * 收窄职责交给调用处的 `decoded` 断言，而不是全局放宽 koffi。
 */
type KoffiFunction = (...args: unknown[]) => unknown;
interface KoffiLibrary {
  func(...args: unknown[]): KoffiFunction;
}
interface KoffiModule {
  load(path: string): KoffiLibrary;
  pointer(type: string): unknown;
  out(type: unknown): unknown;
  alloc(type: string, count: number): unknown;
  decode(value: unknown, offset: number, type: string): unknown;
}

const ffi = koffi as unknown as KoffiModule;

/** Отображаемая в коде ошибка отсутствия символов/библиотек. */
export class X11FfiUnavailableError extends Error {
  readonly reason: "libx11-missing" | "libxtst-missing" | "koffi-missing";

  constructor(reason: "libx11-missing" | "libxtst-missing" | "koffi-missing", message: string) {
    super(message);
    this.name = "X11FfiUnavailableError";
    this.reason = reason;
  }
}

const DISPLAY_POINTER = ffi.pointer("void");

/** Смещение колеса в X11 — фиксированные номера кнопок 4/5 (вертикаль) и 6/7 (горизонталь). */
const SCROLL_BUTTON_UP = 4;
const SCROLL_BUTTON_DOWN = 5;

export interface X11PointerPosition {
  x: number;
  y: number;
}

/**
 * Открытый X11-дисплей с загруженными символами.
 * Владелец — этот класс: только он закрывает `Display*` и освобождает буферы.
 */
export class X11KoffiInput {
  readonly #display: unknown;
  readonly #closeDisplay: KoffiFunction;
  readonly #queryPointer: KoffiFunction;
  readonly #sync: KoffiFunction;
  readonly #fakeMotion: KoffiFunction;
  readonly #fakeButton: KoffiFunction;
  readonly #fakeKey: KoffiFunction;
  readonly #stringToKeysym: KoffiFunction;
  readonly #keysymToKeycode: KoffiFunction;
  readonly #rootWindow: number;
  #disposed = false;

  private constructor(state: {
    display: unknown;
    closeDisplay: KoffiFunction;
    defaultRootWindow: KoffiFunction;
    queryPointer: KoffiFunction;
    sync: KoffiFunction;
    fakeMotion: KoffiFunction;
    fakeButton: KoffiFunction;
    fakeKey: KoffiFunction;
    stringToKeysym: KoffiFunction;
    keysymToKeycode: KoffiFunction;
    rootWindow: number;
  }) {
    this.#display = state.display;
    this.#closeDisplay = state.closeDisplay;
    this.#queryPointer = state.queryPointer;
    this.#sync = state.sync;
    this.#fakeMotion = state.fakeMotion;
    this.#fakeButton = state.fakeButton;
    this.#fakeKey = state.fakeKey;
    this.#stringToKeysym = state.stringToKeysym;
    this.#keysymToKeycode = state.keysymToKeycode;
    this.#rootWindow = state.rootWindow;
  }

  /**
   * Пытается открыть дисплей и загрузить все нужные символы.
   * Возвращает `null`, если X11 недоступен, и бросает `X11FfiUnavailableError`
   * с точным `reason`, если библиотека есть, но символы не найдены.
   */
  static create(env: NodeJS.ProcessEnv = process.env): X11KoffiInput | null {
    if (!env.DISPLAY?.trim()) return null;

    let x11: KoffiLibrary;
    let xtst: KoffiLibrary;
    try {
      x11 = ffi.load("libX11.so.6");
    } catch (error) {
      throw new X11FfiUnavailableError(
        "libx11-missing",
        `libX11.so.6 не загружается: ${messageOf(error)}`,
      );
    }
    try {
      xtst = ffi.load("libXtst.so.6");
    } catch (error) {
      throw new X11FfiUnavailableError(
        "libxtst-missing",
        `libXtst.so.6 не загружается: ${messageOf(error)}`,
      );
    }

    const openDisplay = x11.func("XOpenDisplay", "void*", ["const char*"]);
    const display = openDisplay(undefined);
    if (!display) return null;

    const closeDisplay = x11.func("XCloseDisplay", "int", [DISPLAY_POINTER]);
    const defaultRootWindow = x11.func("XDefaultRootWindow", "unsigned long", [DISPLAY_POINTER]);
    const queryPointer = x11.func("XQueryPointer", "int", [
      DISPLAY_POINTER,
      "unsigned long",
      ffi.out(ffi.pointer("unsigned long")),
      ffi.out(ffi.pointer("unsigned long")),
      ffi.out(ffi.pointer("int")),
      ffi.out(ffi.pointer("int")),
      ffi.out(ffi.pointer("int")),
      ffi.out(ffi.pointer("int")),
      ffi.out(ffi.pointer("unsigned int")),
    ]);
    const sync = x11.func("XSync", "int", [DISPLAY_POINTER, "int"]);
    const stringToKeysym = x11.func("XStringToKeysym", "unsigned long", ["const char*"]);
    const keysymToKeycode = x11.func("XKeysymToKeycode", "unsigned char", [
      DISPLAY_POINTER,
      "unsigned long",
    ]);

    const fakeMotion = xtst.func("XTestFakeMotionEvent", "int", [
      DISPLAY_POINTER,
      "int",
      "int",
      "int",
      "unsigned long",
    ]);
    const fakeButton = xtst.func("XTestFakeButtonEvent", "int", [
      DISPLAY_POINTER,
      "unsigned int",
      "int",
      "unsigned long",
    ]);
    const fakeKey = xtst.func("XTestFakeKeyEvent", "int", [
      DISPLAY_POINTER,
      "unsigned int",
      "int",
      "unsigned long",
    ]);

    const rootWindow = defaultRootWindow(display) as number;
    return new X11KoffiInput({
      display,
      closeDisplay,
      defaultRootWindow,
      queryPointer,
      sync,
      fakeMotion,
      fakeButton,
      fakeKey,
      stringToKeysym,
      keysymToKeycode,
      rootWindow,
    });
  }

  /** Текущая позиция указателя в координатах корневого окна. */
  pointerPosition(): X11PointerPosition | null {
    if (this.#disposed) return null;
    const rootReturn = ffi.alloc("unsigned long", 1);
    const childReturn = ffi.alloc("unsigned long", 1);
    const rootX = ffi.alloc("int", 1);
    const rootY = ffi.alloc("int", 1);
    const winX = ffi.alloc("int", 1);
    const winY = ffi.alloc("int", 1);
    const mask = ffi.alloc("unsigned int", 1);
    const sameScreen = this.#queryPointer(
      this.#display,
      this.#rootWindow,
      rootReturn,
      childReturn,
      rootX,
      rootY,
      winX,
      winY,
      mask,
    );
    if (!sameScreen) return null;
    return { x: ffi.decode(rootX, 0, "int") as number, y: ffi.decode(rootY, 0, "int") as number };
  }

  /** Перемещает указатель абсолютно. `screen` = -1 — текущий экран. */
  movePointer(x: number, y: number): void {
    this.#assertAlive();
    this.#fakeMotion(this.#display, -1, Math.round(x), Math.round(y), 0);
    this.#syncNow();
  }

  /** Плавное движение с шагами и паузой; шаг 1 — мгновенно. */
  async movePointerSmooth(x: number, y: number, steps = 1, delayMs = 0): Promise<void> {
    this.#assertAlive();
    if (steps <= 1) {
      this.movePointer(x, y);
      return;
    }
    const from = this.pointerPosition() ?? { x: 0, y: 0 };
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      this.#fakeMotion(
        this.#display,
        -1,
        Math.round(from.x + (x - from.x) * ratio),
        Math.round(from.y + (y - from.y) * ratio),
        0,
      );
      this.#syncNow();
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /** Клик: press+release реальными XTestFakeButtonEvent. */
  click(x: number, y: number, button: LinuxCuaMouseButton = "left", clickCount = 1): void {
    this.#assertAlive();
    this.movePointer(x, y);
    const buttonCode = buttonCodeFor(button);
    for (let index = 0; index < Math.max(1, clickCount); index += 1) {
      this.#fakeButton(this.#display, buttonCode, 1, 0);
      this.#fakeButton(this.#display, buttonCode, 0, 0);
      this.#syncNow();
    }
  }

  /** Прокрутка колесом; `deltaY > 0` — вниз. */
  scroll(x: number, y: number, deltaY: number, steps = 1): void {
    this.#assertAlive();
    this.movePointer(x, y);
    const button = deltaY >= 0 ? SCROLL_BUTTON_DOWN : SCROLL_BUTTON_UP;
    const total = Math.max(
      1,
      Math.abs(Math.round(steps)) * Math.max(1, Math.ceil(Math.abs(deltaY) / 120)),
    );
    for (let index = 0; index < total; index += 1) {
      this.#fakeButton(this.#display, button, 1, 0);
      this.#fakeButton(this.#display, button, 0, 0);
    }
    this.#syncNow();
  }

  /**
   * Нажатие клавиши в нотации `ctrl+shift+t` или `Return`.
   * Модификаторы зажимаются по порядку и отпускаются в обратном порядке —
   * иначе при исключении внутри действия клавиша осталась бы зажатой.
   */
  pressKey(spec: string, repeat = 1): void {
    this.#assertAlive();
    const parts = spec
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) throw new Error(`Пустая спецификация клавиши: '${spec}'`);
    const keyName = parts.at(-1)!;
    const modifiers = parts.slice(0, -1).map((part) => normalizeModifierName(part));
    const pressed: number[] = [];
    try {
      for (const modifier of modifiers) pressed.push(this.#keycodeForOrThrow(modifier));
      const mainCode = this.#keycodeForOrThrow(keyName);
      for (const code of pressed) this.#fakeKey(this.#display, code, 1, 0);
      for (let index = 0; index < Math.max(1, repeat); index += 1) {
        this.#fakeKey(this.#display, mainCode, 1, 0);
        this.#fakeKey(this.#display, mainCode, 0, 0);
      }
    } finally {
      for (const code of [...pressed].reverse()) this.#fakeKey(this.#display, code, 0, 0);
      this.#syncNow();
    }
  }

  /**
   * Ввод текста посимвольно через keysym.
   *
   * Unicode за пределами keysym-таблицы здесь не поддержан осознанно: корректный
   * ввод любого Unicode требует подмены keyboard mapping и рискован для чужого
   * рабочего стола. Для таких символов нужен clipboard-путь, который включается
   * отдельным разрешением `clipboard`.
   */
  async typeText(text: string, delayMs = 0): Promise<void> {
    this.#assertAlive();
    for (const char of text) {
      const spec = char === "\n" ? "Return" : char === "\t" ? "Tab" : char;
      const code = this.#keycodeFor(char === "\n" ? "Return" : char === "\t" ? "Tab" : spec);
      if (code === null) {
        throw new Error(
          `Символ '${char}' не имеет keysym-соответствия; используйте clipboard-ввод (нужно разрешение clipboard).`,
        );
      }
      const shift = needsShift(char);
      const shiftCode = shift ? this.#keycodeForOrThrow("Shift_L") : null;
      if (shiftCode !== null) this.#fakeKey(this.#display, shiftCode, 1, 0);
      this.#fakeKey(this.#display, code, 1, 0);
      this.#fakeKey(this.#display, code, 0, 0);
      if (shiftCode !== null) this.#fakeKey(this.#display, shiftCode, 0, 0);
      this.#syncNow();
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /** Отпускает все «опасные» модификаторы: аварийный выход не должен их залипать. */
  releaseModifiers(): void {
    if (this.#disposed) return;
    for (const name of [
      "Shift_L",
      "Shift_R",
      "Control_L",
      "Control_R",
      "Alt_L",
      "Alt_R",
      "Super_L",
      "Super_R",
    ]) {
      const code = this.#keycodeFor(name);
      if (code === null) continue;
      this.#fakeKey(this.#display, code, 0, 0);
    }
    this.#syncNow();
  }

  /** Закрывает Display. Повторный вызов безопасен. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.releaseModifiers();
    } catch {
      // Дисплей мог уже умереть; закрываем без шума.
    }
    try {
      this.#closeDisplay(this.#display);
    } catch {
      // Ничего не делаем: процесс завершает работу, дескриптор освободит ядро.
    }
  }

  #keycodeFor(name: string): number | null {
    const keysym = this.#stringToKeysym(name) as number;
    if (!keysym) return null;
    const code = this.#keysymToKeycode(this.#display, keysym) as number;
    return code || null;
  }

  #keycodeForOrThrow(name: string): number {
    const code = this.#keycodeFor(name);
    if (code === null) throw new Error(`Клавиша '${name}' не найдена в раскладке X11`);
    return code;
  }

  #syncNow(): void {
    // XSync, а не XFlush: гарантирует, что событие уже доставлено серверу,
    // иначе чтение позиции сразу после движения даёт старое значение.
    this.#sync(this.#display, 0);
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("X11 input уже освобождён (dispose)");
  }
}

function buttonCodeFor(button: LinuxCuaMouseButton): number {
  if (button === "middle") return 2;
  if (button === "right") return 3;
  return 1;
}

function normalizeModifierName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "ctrl" || normalized === "control") return "Control_L";
  if (normalized === "shift") return "Shift_L";
  if (normalized === "alt" || normalized === "option") return "Alt_L";
  if (
    normalized === "super" ||
    normalized === "meta" ||
    normalized === "cmd" ||
    normalized === "command"
  ) {
    return "Super_L";
  }
  return name;
}

/** Символы, требующие Shift в стандартной US-раскладке. */
function needsShift(char: string): boolean {
  return /^[A-Z!@#$%^&*()_+{}|:"<>?~]$/.test(char);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Отдельная проверка доступности инструментария без открытия дисплея. */
export function probeX11Ffi(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reason?: "libx11-missing" | "libxtst-missing" | "no-display";
  detail?: string;
} {
  if (!env.DISPLAY?.trim()) return { ok: false, reason: "no-display", detail: "DISPLAY не задан" };
  try {
    ffi.load("libX11.so.6");
  } catch (error) {
    return { ok: false, reason: "libx11-missing", detail: messageOf(error) };
  }
  try {
    ffi.load("libXtst.so.6");
  } catch (error) {
    return { ok: false, reason: "libxtst-missing", detail: messageOf(error) };
  }
  return { ok: true };
}
