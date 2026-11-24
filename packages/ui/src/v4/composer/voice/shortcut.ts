/**
 * In-app dictation shortcut binding.
 *
 * A binding is either one modifier key (`Alt`) or modifiers plus one key
 * (`Control+Shift+Space`). Keys are stored as `KeyboardEvent.code` values, so a binding
 * does not depend on the keyboard layout. A bare key is not a binding: capturing one
 * would swallow ordinary typing.
 */
export const DEFAULT_VOICE_SHORTCUT = "Alt";

const MODIFIER_CODES: Readonly<Record<string, readonly string[]>> = {
  Control: ["ControlLeft", "ControlRight"],
  Alt: ["AltLeft", "AltRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Meta: ["MetaLeft", "MetaRight"],
};

const CODE_TO_MODIFIER: Readonly<Record<string, string>> = {
  ControlLeft: "Control",
  ControlRight: "Control",
  AltLeft: "Alt",
  AltRight: "Alt",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  MetaLeft: "Meta",
  MetaRight: "Meta",
};

const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Meta"] as const;

const MODIFIER_LABELS: Readonly<Record<string, string>> = {
  Control: "Ctrl",
  Alt: "⌥",
  Shift: "Shift",
  Meta: "⌘",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Del",
};

export function pressedModifiers(event: KeyboardEvent): Set<string> {
  const modifiers = new Set<string>();
  if (event.ctrlKey) modifiers.add("Control");
  if (event.altKey) modifiers.add("Alt");
  if (event.shiftKey) modifiers.add("Shift");
  if (event.metaKey) modifiers.add("Meta");
  return modifiers;
}

/** True when the event is exactly the configured binding. */
export function matchesVoiceShortcut(event: KeyboardEvent, binding: string): boolean {
  const parts = binding.split("+").filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1]!;
  const required = parts.slice(0, -1);
  const modifierCodes = MODIFIER_CODES[key];
  if (modifierCodes) {
    // Modifier-only binding: the key itself must match and no other modifier may be held.
    if (!modifierCodes.includes(event.code)) return false;
    const pressed = pressedModifiers(event);
    pressed.delete(key);
    return pressed.size === 0;
  }
  const pressed = pressedModifiers(event);
  if (pressed.size !== required.length) return false;
  if (!required.every((modifier) => pressed.has(modifier))) return false;
  return event.code === key;
}

/**
 * Binding for a captured key press, or `null` when the press cannot be a binding yet:
 * a modifier held together with another modifier, or a key without any modifier.
 */
export function normalizeShortcutFromEvent(event: KeyboardEvent): string | null {
  const pressed = pressedModifiers(event);
  const modifier = CODE_TO_MODIFIER[event.code];
  if (modifier) {
    pressed.delete(modifier);
    if (pressed.size > 0) return null;
    return modifier;
  }
  const modifiers = MODIFIER_ORDER.filter((name) => pressed.has(name));
  if (modifiers.length === 0) return null;
  return [...modifiers, event.code].join("+");
}

/** Human-readable label of a binding, e.g. `Alt` → `⌥`, `Control+KeyF` → `Ctrl+F`. */
export function formatShortcut(binding: string): string {
  const parts = binding.split("+").filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  return parts
    .map((part) => {
      const modifier = MODIFIER_LABELS[part];
      if (modifier) return modifier;
      if (part.startsWith("Key")) return part.slice(3);
      if (part.startsWith("Digit")) return part.slice(5);
      return KEY_LABELS[part] ?? part;
    })
    .join("+");
}
