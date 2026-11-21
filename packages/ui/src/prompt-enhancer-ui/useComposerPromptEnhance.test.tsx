// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhanceResult } from "@zcode/shared";

const enhancer = vi.hoisted(() => ({
  enhance: vi.fn(),
  cancel: vi.fn(async () => {}),
  reset: vi.fn(),
  undo: vi.fn(() => undefined),
  isRunning: false,
  error: undefined,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ promptEnhancerService: {} }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: { promptEnhancerSettings: { enabled: true } } }),
}));
vi.mock("@/hooks/usePromptEnhancer.js", () => ({
  usePromptEnhancer: () => enhancer,
}));

import { useComposerPromptEnhance } from "./useComposerPromptEnhance.js";

function result(text: string): PromptEnhanceResult {
  return {
    requestId: "req_preview_1",
    enhancedText: text,
    style: "structured_engineering",
    framework: "rise",
    domain: "coding",
    taskKind: "feature",
    addedClarifications: [],
    assumptions: [{ text: "Existing API", origin: "draft" }],
    capabilitySuggestions: [
      {
        kind: "skill",
        name: "yandex-direct",
        reason: "Domain match",
        requiresConsent: true,
      },
    ],
    usedContext: [],
    modelUsed: { providerId: "p", modelId: "m" },
    tokenDelta: { before: 1, after: 2, method: "char-ratio" },
    elapsedMs: 1,
  };
}

describe("useComposerPromptEnhance preview", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not mutate the draft before Apply and Undo restores the original", async () => {
    enhancer.enhance.mockResolvedValue(result("Better prompt"));
    const onApply = vi.fn();
    const { result: hook } = renderHook(() =>
      useComposerPromptEnhance({ workspacePath: "/repo/zcode", onApply }),
    );

    await act(async () => {
      await hook.current.enhance("Original prompt");
    });

    expect(onApply).not.toHaveBeenCalled();
    expect(hook.current.preview).toMatchObject({
      before: "Original prompt",
      after: "Better prompt",
      result: { framework: "rise", domain: "coding", taskKind: "feature" },
    });

    act(() => hook.current.acceptPreview());
    expect(onApply).toHaveBeenCalledWith("Better prompt");
    expect(hook.current.canUndo).toBe(true);

    act(() => hook.current.undo());
    expect(onApply).toHaveBeenLastCalledWith("Original prompt");
    expect(hook.current.canUndo).toBe(false);
  });

  it("discards a preview without touching the draft", async () => {
    enhancer.enhance.mockResolvedValue(result("Better prompt"));
    const onApply = vi.fn();
    const { result: hook } = renderHook(() =>
      useComposerPromptEnhance({ workspacePath: "/repo/zcode", onApply }),
    );

    await act(async () => {
      await hook.current.enhance("Original prompt");
    });
    act(() => hook.current.discardPreview());

    expect(hook.current.preview).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(enhancer.reset).toHaveBeenCalled();
  });
});
