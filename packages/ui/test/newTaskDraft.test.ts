// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const view = {
  revision: 1,
  providers: [
    {
      providerId: "local-provider",
      config: {},
      models: [
        {
          modelId: "qwen3:8b",
          config: {
            optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } },
          },
        },
      ],
    },
  ],
  preferredSelection: {
    providerId: "local-provider",
    modelId: "qwen3:8b",
    options: { reasoningLevel: "disabled" },
  },
} as ModelSelectionView;

describe("initializeNewTaskDraft", () => {
  it("replaces a removed Recent provider with the first selectable model", () => {
    window.localStorage.setItem(
      "zcode-model-selection-recent-v1:/repo",
      JSON.stringify({
        modelSelection: { providerId: "removed", modelId: "removed" },
        mode: "build",
      }),
    );
    const draft = initializeNewTaskDraft({ text: "", updatedAt: 0 }, "/repo", undefined, view);
    expect(draft.modelSelection).toEqual({
      providerId: "local-provider",
      modelId: "qwen3:8b",
      options: { reasoningLevel: "disabled" },
    });
  });
});
