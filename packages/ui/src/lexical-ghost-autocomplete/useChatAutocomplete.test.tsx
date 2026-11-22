// @vitest-environment jsdom
import type { ChatAutocompleteRequest, ChatAutocompleteResponse } from "@zcode/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
  type GhostAutocompletePromptState,
  type GhostAutocompleteServicePort,
} from "./contract.js";
import { useChatAutocomplete } from "./useChatAutocomplete.js";

const promptState: GhostAutocompletePromptState = {
  text: "исправь гонку субагентов",
  cursorAtEnd: true,
  hasSelection: false,
  hasActiveTriggerPanel: false,
  isComposing: false,
};

function response(requestId: string, suggestion: string): ChatAutocompleteResponse {
  return {
    requestId,
    suggestion,
    source: "model_stream",
    latencyMs: 5,
    modelUsed: { providerId: "p", modelId: "fast" },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useChatAutocomplete", () => {
  it("no-ops without a service: no timer, no request, no crash", () => {
    vi.useFakeTimers();
    const hook = renderHook(() =>
      useChatAutocomplete({
        service: null,
        workspacePath: "/repo/zcode",
        config: DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
      }),
    );

    act(() => {
      hook.result.current.request(promptState);
      vi.advanceTimersByTime(1_000);
    });

    expect(hook.result.current.suggestion).toBe("");
    expect(hook.result.current.isLoading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requests the user-voice suffix after the debounce and accepts it", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(
      async (request: ChatAutocompleteRequest): Promise<ChatAutocompleteResponse> =>
        response(request.requestId, " через FileLockRegistry"),
    );
    const service: GhostAutocompleteServicePort = {
      complete,
      cancel: vi.fn(async () => {}),
      recordAcceptedSuggestion: vi.fn(async () => {}),
    };
    const hook = renderHook(() =>
      useChatAutocomplete({
        service,
        workspacePath: "/repo/zcode",
        config: DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
      }),
    );

    act(() => {
      hook.result.current.request(promptState);
    });
    expect(complete).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.baseDebounceMs);
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      prefix: promptState.text,
      suffix: "",
      cursorAtEndOfLine: true,
      openTabPaths: [],
    });
    expect(hook.result.current.suggestion).toBe(" через FileLockRegistry");

    act(() => {
      hook.result.current.accept(promptState.text, " через FileLockRegistry");
    });

    expect(hook.result.current.suggestion).toBe("");
    expect(service.recordAcceptedSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/repo/zcode",
        acceptedSlice: " через FileLockRegistry",
      }),
    );
  });

  it("reset cancels the in-flight suggestion without waiting for the model", async () => {
    vi.useFakeTimers();
    let resolveComplete: ((value: ChatAutocompleteResponse) => void) | undefined;
    const complete = vi.fn(
      (request: ChatAutocompleteRequest) =>
        new Promise<ChatAutocompleteResponse>((resolve) => {
          resolveComplete = () => resolve(response(request.requestId, " late suggestion"));
        }),
    );
    const cancel = vi.fn(async () => {});
    const service: GhostAutocompleteServicePort = {
      complete,
      cancel,
      recordAcceptedSuggestion: vi.fn(async () => {}),
    };
    const hook = renderHook(() =>
      useChatAutocomplete({
        service,
        workspacePath: "/repo/zcode",
        config: DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
      }),
    );

    await act(async () => {
      hook.result.current.request(promptState);
      vi.advanceTimersByTime(DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.baseDebounceMs);
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const requestId = complete.mock.calls[0]?.[0].requestId;
    expect(requestId).toBeTruthy();

    act(() => {
      hook.result.current.reset();
    });
    expect(cancel).toHaveBeenCalledWith({ requestId });
    expect(hook.result.current.suggestion).toBe("");
    expect(hook.result.current.isLoading).toBe(false);

    await act(async () => {
      resolveComplete?.(response(requestId!, " late suggestion"));
    });
    expect(hook.result.current.suggestion).toBe("");
  });

  it("treats a filtered empty_suggestion as a normal hidden hint", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(
      async (request: ChatAutocompleteRequest): Promise<ChatAutocompleteResponse> => {
        throw Object.assign(new Error("filtered"), {
          code: "empty_suggestion",
          requestId: request.requestId,
        });
      },
    );
    const service: GhostAutocompleteServicePort = {
      complete,
      cancel: vi.fn(async () => {}),
      recordAcceptedSuggestion: vi.fn(async () => {}),
    };
    const hook = renderHook(() =>
      useChatAutocomplete({
        service,
        workspacePath: "/repo/zcode",
        config: DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
      }),
    );

    await act(async () => {
      hook.result.current.request(promptState);
      vi.advanceTimersByTime(DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.baseDebounceMs);
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(hook.result.current.suggestion).toBe("");
    expect(hook.result.current.isLoading).toBe(false);
  });
});
