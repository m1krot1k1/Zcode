import { afterEach, describe, expect, it } from "vitest";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  registerRecommendedPromptPane,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

const paneIds = ["rotation-first", "rotation-second"];

/**
 * The selector uses this same visual key. Plugin-only items intentionally have no
 * `iconUrl` (the UI renders their plugin icon), so asserting on `iconUrl` alone
 * would count several distinct fallbacks as one undefined icon.
 */
function iconKey(item: DraftSuggestedPromptItem): string {
  return item.iconUrl ?? item.iconName ?? item.plugin?.stableId ?? item.id;
}

afterEach(() => {
  for (const id of paneIds) unregisterRecommendedPromptPane(id);
});

describe("active task recommendations", () => {
  it("replaces all three visible office recommendations when refreshing", () => {
    registerRecommendedPromptPane(paneIds[0]!, "office");

    for (let refresh = 0; refresh < 6; refresh += 1) {
      const previous = getRecommendedPromptsForPane(paneIds[0]!, "office");
      advanceRecommendedPromptPane(paneIds[0]!);
      const next = getRecommendedPromptsForPane(paneIds[0]!, "office");

      expect(next).toHaveLength(3);
      expect(next.every((item) => !previous.some((shown) => shown.id === item.id))).toBe(true);
      expect(new Set(next.map((item) => iconKey(item))).size).toBe(3);
    }
  });

  it("keeps each coding pane visually varied while avoiding repeated tasks across panes", () => {
    registerRecommendedPromptPane(paneIds[0]!, "coding");
    registerRecommendedPromptPane(paneIds[1]!, "coding");

    const first = getRecommendedPromptsForPane(paneIds[0]!, "coding");
    const second = getRecommendedPromptsForPane(paneIds[1]!, "coding");
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(new Set(first.map((item) => iconKey(item)))).toHaveProperty("size", 3);
    expect(new Set(second.map((item) => iconKey(item)))).toHaveProperty("size", 3);
    expect(second.every((item) => !first.some((shown) => shown.id === item.id))).toBe(true);

    advanceRecommendedPromptPane(paneIds[0]!);
    const refreshed = getRecommendedPromptsForPane(paneIds[0]!, "coding");
    expect(new Set(refreshed.map((item) => iconKey(item)))).toHaveProperty("size", 3);
    expect(refreshed.map((item) => item.id)).not.toEqual(first.map((item) => item.id));
  });
});
