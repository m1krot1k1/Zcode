import { describe, expect, it } from "vitest";
import {
  DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
  resolveGhostAutocompleteSkip,
  type GhostAutocompletePromptState,
} from "./contract.js";
import { uiLexicalGhostAutocompleteModule } from "./module.js";

const enabled = { enabled: true, minPrefixChars: 6, cursorAtEndOnly: true };
const baseState: GhostAutocompletePromptState = {
  text: "исправь гонку субагентов",
  cursorAtEnd: true,
  hasSelection: false,
  hasActiveTriggerPanel: false,
  isComposing: false,
};

describe("ui-lexical-ghost-autocomplete manifest", () => {
  it("declares the managed module id", () => {
    expect(uiLexicalGhostAutocompleteModule.id).toBe("ui-lexical-ghost-autocomplete");
  });

  it("ships autocomplete enabled by default, gated by settings and service availability", () => {
    expect(DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.enabled).toBe(true);
    expect(DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.keymap).toEqual({
      acceptAll: "Tab",
      acceptWord: "ArrowRight",
      dismiss: "Escape",
    });
  });
});

describe("resolveGhostAutocompleteSkip", () => {
  it("allows a valid trailing cursor with enough text", () => {
    expect(resolveGhostAutocompleteSkip(baseState, enabled)).toBeNull();
  });

  it("skips when the feature is disabled", () => {
    expect(resolveGhostAutocompleteSkip(baseState, { ...enabled, enabled: false })).toBe(
      "disabled",
    );
  });

  it("skips IME composition before anything else", () => {
    expect(resolveGhostAutocompleteSkip({ ...baseState, isComposing: true }, enabled)).toBe(
      "ime_composing",
    );
  });

  it("skips a non-collapsed selection", () => {
    expect(resolveGhostAutocompleteSkip({ ...baseState, hasSelection: true }, enabled)).toBe(
      "selection",
    );
  });

  it("skips while a slash or mention panel is open", () => {
    expect(
      resolveGhostAutocompleteSkip({ ...baseState, hasActiveTriggerPanel: true }, enabled),
    ).toBe("trigger_panel_open");
  });

  it("skips empty and too-short input", () => {
    expect(resolveGhostAutocompleteSkip({ ...baseState, text: "   " }, enabled)).toBe("empty_text");
    expect(resolveGhostAutocompleteSkip({ ...baseState, text: "приве" }, enabled)).toBe(
      "short_prefix",
    );
  });

  it("skips a cursor that is not at the end when configured", () => {
    expect(resolveGhostAutocompleteSkip({ ...baseState, cursorAtEnd: false }, enabled)).toBe(
      "cursor_not_at_end",
    );
    expect(
      resolveGhostAutocompleteSkip(
        { ...baseState, cursorAtEnd: false },
        { ...enabled, cursorAtEndOnly: false },
      ),
    ).toBeNull();
  });
});
