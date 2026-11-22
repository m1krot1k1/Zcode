// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhancerService } from "@zcode/services";
import type { PromptEnhanceResult } from "@zcode/shared";
import { usePromptEnhancer } from "./usePromptEnhancer.js";

function result(text: string): PromptEnhanceResult {
  return {
    requestId: "req_test_1",
    enhancedText: text,
    style: "structured_engineering",
    framework: "rise",
    domain: "coding",
    taskKind: "feature",
    addedClarifications: [],
    assumptions: [],
    capabilitySuggestions: [],
    usedContext: [],
    modelUsed: { providerId: "p", modelId: "m" },
    tokenDelta: { before: 1, after: 2, method: "char-ratio" },
    elapsedMs: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function serviceWithEnhance(enhance: PromptEnhancerService["enhance"]): PromptEnhancerService {
  return {
    enhance,
    cancel: vi.fn(async () => {}),
    onStreamDelta: vi.fn(() => () => {}),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("usePromptEnhancer", () => {
  it("resolves to null when the request settles after unmount", async () => {
    const pending = deferred<PromptEnhanceResult>();
    const service = serviceWithEnhance(() => pending.promise);
    const { result: hook, unmount } = renderHook(() =>
      usePromptEnhancer({ promptEnhancerService: service, workspacePath: "/repo/zcode" }),
    );

    let enhancePromise!: Promise<PromptEnhanceResult | null>;
    act(() => {
      enhancePromise = hook.current.enhance("Original prompt");
    });
    unmount();

    let outcome: PromptEnhanceResult | null | undefined;
    await act(async () => {
      pending.resolve(result("Better prompt"));
      outcome = await enhancePromise;
    });

    expect(outcome).toBeNull();
  });

  it("returns the enhanced result while mounted", async () => {
    const service = serviceWithEnhance(async () => result("Better prompt"));
    const { result: hook } = renderHook(() =>
      usePromptEnhancer({ promptEnhancerService: service, workspacePath: "/repo/zcode" }),
    );

    let outcome: PromptEnhanceResult | null | undefined;
    await act(async () => {
      outcome = await hook.current.enhance("Original prompt");
    });

    expect(outcome).toMatchObject({ enhancedText: "Better prompt" });
    expect(hook.current.status).toBe("ready");
    expect(hook.current.streamingText).toBe("Better prompt");
  });
});
