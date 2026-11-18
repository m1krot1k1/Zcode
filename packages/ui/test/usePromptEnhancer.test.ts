// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import type { PromptEnhancerService } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { usePromptEnhancer } from "@/hooks/usePromptEnhancer.js";

describe("usePromptEnhancer", () => {
  it("disposes an RPC-style stream subscription on unmount", () => {
    const dispose = vi.fn();
    const onStreamDelta = vi.fn(() => ({ dispose }));
    const promptEnhancerService = { onStreamDelta } as unknown as PromptEnhancerService;

    const { unmount } = renderHook(() =>
      usePromptEnhancer({
        promptEnhancerService,
        workspacePath: "/workspace",
      }),
    );

    expect(onStreamDelta).toHaveBeenCalledTimes(1);
    expect(() => unmount()).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("releases a function-style stream subscription on unmount", () => {
    const release = vi.fn();
    const onStreamDelta = vi.fn(() => release);
    const promptEnhancerService = { onStreamDelta } as unknown as PromptEnhancerService;

    const { unmount } = renderHook(() =>
      usePromptEnhancer({
        promptEnhancerService,
        workspacePath: "/workspace",
      }),
    );

    expect(() => unmount()).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
