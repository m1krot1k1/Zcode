import { describe, expect, it } from "vitest";
import { buildCursorReasoningMap, groupCursorModels } from "@zcode/provider";

function model(modelId: string, name = modelId) {
  return { modelId, name, source: "cli" as const };
}

describe("groupCursorModels", () => {
  it("collapses reasoning and fast variants into one selector per base model", () => {
    const groups = groupCursorModels([
      model("auto", "Auto"),
      model("gpt-5.3-codex-low", "Codex 5.3 Low"),
      model("gpt-5.3-codex-low-fast", "Codex 5.3 Low Fast"),
      model("gpt-5.3-codex", "Codex 5.3"),
      model("gpt-5.3-codex-fast", "Codex 5.3 Fast"),
      model("gpt-5.3-codex-high", "Codex 5.3 High"),
      model("gpt-5.3-codex-high-fast", "Codex 5.3 High Fast"),
      model("gpt-5.3-codex-xhigh", "Codex 5.3 Extra High"),
      model("gpt-5.3-codex-xhigh-fast", "Codex 5.3 Extra High Fast"),
    ]);

    const normal = groups.find((group) => group.modelId === "gpt-5.3-codex");
    const fast = groups.find((group) => group.modelId === "gpt-5.3-codex-fast");
    expect(normal?.reasoningLevels).toEqual([
      { level: "default", modelId: "gpt-5.3-codex" },
      { level: "low", modelId: "gpt-5.3-codex-low" },
      { level: "high", modelId: "gpt-5.3-codex-high" },
      { level: "xhigh", modelId: "gpt-5.3-codex-xhigh" },
    ]);
    expect(fast?.reasoningLevels).toEqual([
      { level: "default", modelId: "gpt-5.3-codex-fast" },
      { level: "low", modelId: "gpt-5.3-codex-low-fast" },
      { level: "high", modelId: "gpt-5.3-codex-high-fast" },
      { level: "xhigh", modelId: "gpt-5.3-codex-xhigh-fast" },
    ]);
    expect(normal?.name).toBe("Codex 5.3");
    expect(fast?.name).toBe("Codex 5.3 Fast");
  });

  it("collapses Cursor's two-token extra-high level into xhigh on the same base", () => {
    const groups = groupCursorModels([
      model("gpt-5.5-none", "GPT 5.5 None"),
      model("gpt-5.5-high", "GPT 5.5 High"),
      model("gpt-5.5-extra-high", "GPT 5.5 Extra High"),
      model("gpt-5.5-extra-high-fast", "GPT 5.5 Extra High Fast"),
    ]);

    expect(groups.map((group) => group.modelId)).toEqual(["gpt-5.5", "gpt-5.5-fast"]);
    expect(groups.find((group) => group.modelId === "gpt-5.5")?.reasoningLevels).toEqual([
      { level: "none", modelId: "gpt-5.5-none" },
      { level: "high", modelId: "gpt-5.5-high" },
      { level: "xhigh", modelId: "gpt-5.5-extra-high" },
    ]);
    expect(groups.find((group) => group.modelId === "gpt-5.5-fast")?.reasoningLevels).toEqual([
      { level: "xhigh", modelId: "gpt-5.5-extra-high-fast" },
    ]);
  });

  it("keeps thinking/no-thinking and single-variant models distinct", () => {
    const groups = groupCursorModels([
      model("claude-opus-4-7-thinking-high", "Claude Opus 4.7 High Thinking"),
      model("claude-opus-4-7-thinking-low", "Claude Opus 4.7 Low Thinking"),
      model("claude-haiku-5-5-low-no-thinking", "Claude Haiku 5.5 Low No Thinking"),
      model("composer-2.5", "Composer 2.5"),
      model("composer-2.5-fast", "Composer 2.5 Fast"),
    ]);

    expect(groups.map((group) => group.modelId)).toEqual([
      "claude-opus-4-7-thinking",
      "claude-haiku-5-5-no-thinking",
      "composer-2.5",
      "composer-2.5-fast",
    ]);
    const thinking = groups.find((group) => group.modelId === "claude-opus-4-7-thinking");
    expect(thinking?.reasoningLevels.map((entry) => entry.level)).toEqual(["low", "high"]);
    expect(groups.find((group) => group.modelId === "composer-2.5")?.reasoningLevels).toEqual([
      { level: "disabled", modelId: "composer-2.5" },
    ]);
  });

  it("builds a restricted-CEL map from level to actual Cursor id", () => {
    const levels = [
      { level: "default", modelId: "gpt-5.3-codex" },
      { level: "low", modelId: "gpt-5.3-codex-low" },
      { level: "high", modelId: "gpt-5.3-codex-high" },
    ];
    const map = buildCursorReasoningMap(levels);
    expect(map).toContain("reasoningLevel == 'default'");
    expect(map).toContain("reasoningLevel == 'low'");
    expect(map).toContain("'modelId': 'gpt-5.3-codex-high'");
  });
});
