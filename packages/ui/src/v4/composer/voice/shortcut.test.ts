import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_SHORTCUT,
  formatShortcut,
  matchesVoiceShortcut,
  normalizeShortcutFromEvent,
} from "./shortcut.js";

function keyEvent(init: {
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return {
    code: init.code,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
  } as KeyboardEvent;
}

describe("matchesVoiceShortcut", () => {
  it("matches the default binding on a bare modifier", () => {
    expect(matchesVoiceShortcut(keyEvent({ code: "AltLeft" }), DEFAULT_VOICE_SHORTCUT)).toBe(true);
    expect(matchesVoiceShortcut(keyEvent({ code: "AltRight" }), DEFAULT_VOICE_SHORTCUT)).toBe(true);
  });

  it("ignores a modifier held with another one", () => {
    expect(
      matchesVoiceShortcut(keyEvent({ code: "AltLeft", ctrlKey: true }), DEFAULT_VOICE_SHORTCUT),
    ).toBe(false);
    expect(
      matchesVoiceShortcut(keyEvent({ code: "AltLeft", shiftKey: true }), DEFAULT_VOICE_SHORTCUT),
    ).toBe(false);
  });

  it("matches a modifier plus key binding only with exactly its modifiers", () => {
    const binding = "Control+Shift+Space";
    expect(
      matchesVoiceShortcut(keyEvent({ code: "Space", ctrlKey: true, shiftKey: true }), binding),
    ).toBe(true);
    expect(matchesVoiceShortcut(keyEvent({ code: "Space", ctrlKey: true }), binding)).toBe(false);
    expect(
      matchesVoiceShortcut(
        keyEvent({ code: "Space", ctrlKey: true, shiftKey: true, altKey: true }),
        binding,
      ),
    ).toBe(false);
    expect(
      matchesVoiceShortcut(keyEvent({ code: "KeyF", ctrlKey: true, shiftKey: true }), binding),
    ).toBe(false);
  });

  it("never matches an empty binding", () => {
    expect(matchesVoiceShortcut(keyEvent({ code: "AltLeft" }), "")).toBe(false);
  });
});

describe("normalizeShortcutFromEvent", () => {
  it("captures a bare modifier", () => {
    expect(normalizeShortcutFromEvent(keyEvent({ code: "AltLeft" }))).toBe("Alt");
    expect(normalizeShortcutFromEvent(keyEvent({ code: "MetaRight" }))).toBe("Meta");
  });

  it("skips a modifier held together with another modifier", () => {
    expect(normalizeShortcutFromEvent(keyEvent({ code: "AltLeft", ctrlKey: true }))).toBeNull();
  });

  it("captures modifiers plus a key", () => {
    expect(
      normalizeShortcutFromEvent(keyEvent({ code: "Space", ctrlKey: true, shiftKey: true })),
    ).toBe("Control+Shift+Space");
    expect(normalizeShortcutFromEvent(keyEvent({ code: "F2", altKey: true }))).toBe("Alt+F2");
  });

  it("refuses a bare key so ordinary typing is not swallowed", () => {
    expect(normalizeShortcutFromEvent(keyEvent({ code: "KeyA" }))).toBeNull();
  });
});

describe("formatShortcut", () => {
  it("renders modifiers and keys for the user", () => {
    expect(formatShortcut("Alt")).toBe("⌥");
    expect(formatShortcut("Control+Shift+Space")).toBe("Ctrl+Shift+Space");
    expect(formatShortcut("Control+KeyF")).toBe("Ctrl+F");
    expect(formatShortcut("")).toBe("");
  });
});
