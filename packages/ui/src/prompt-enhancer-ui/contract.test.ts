import { describe, expect, it } from "vitest";
import {
  COMPOSER_ENHANCE_TARGET,
  SYSTEM_PROMPT_ENHANCE_TARGET,
  isEnhancePromptEnabled,
  resolveEnhanceUndoText,
} from "./contract.js";
import { uiPromptEnhancerModule } from "./module.js";

describe("ui-prompt-enhancer contract", () => {
  it("declares the managed module id", () => {
    expect(uiPromptEnhancerModule.id).toBe("ui-prompt-enhancer");
  });

  it("disables the composer button on empty or too-short drafts", () => {
    expect(isEnhancePromptEnabled("", COMPOSER_ENHANCE_TARGET)).toBe(false);
    expect(isEnhancePromptEnabled("  ab  ", COMPOSER_ENHANCE_TARGET)).toBe(false);
    expect(isEnhancePromptEnabled("fix the race", COMPOSER_ENHANCE_TARGET)).toBe(true);
  });

  it("requires a longer draft for custom system prompts", () => {
    expect(isEnhancePromptEnabled("short role", SYSTEM_PROMPT_ENHANCE_TARGET)).toBe(false);
    expect(
      isEnhancePromptEnabled(
        "You are a reviewer. Always check invariants before proposing refactors.",
        SYSTEM_PROMPT_ENHANCE_TARGET,
      ),
    ).toBe(true);
  });

  it("returns the original draft for undo only when it actually differs", () => {
    expect(resolveEnhanceUndoText(undefined, "any")).toBeNull();
    expect(resolveEnhanceUndoText("draft", "draft")).toBeNull();
    expect(resolveEnhanceUndoText("draft", "enhanced")).toBe("draft");
  });
});
