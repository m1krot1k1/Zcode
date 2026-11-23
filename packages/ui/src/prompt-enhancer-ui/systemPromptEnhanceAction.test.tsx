// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhanceResult } from "@zcode/shared";

const enhancer = vi.hoisted(() => ({
  enhance: vi.fn(),
  cancel: vi.fn(async () => {}),
  reset: vi.fn(),
  undo: vi.fn(() => undefined),
  isRunning: false,
  error: undefined as { code: string; message: string } | undefined,
}));

const usePromptEnhancerMock = vi.hoisted(() => vi.fn());

const optionalServices = vi.hoisted(() => ({
  current: { promptEnhancerService: {} } as { promptEnhancerService?: unknown } | undefined,
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => optionalServices.current,
}));
vi.mock("@/hooks/usePromptEnhancer.js", () => ({
  usePromptEnhancer: usePromptEnhancerMock,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

import { SystemPromptEnhanceAction } from "./SystemPromptEnhanceAction.js";

const DRAFT = "You are a careful reviewer. Verify the diff before answering the user.";

function result(text: string): PromptEnhanceResult {
  return {
    requestId: "req_system_1",
    enhancedText: text,
    style: "deep_architectural",
    framework: "oracle",
    domain: "general",
    taskKind: "general",
    addedClarifications: [],
    assumptions: [],
    capabilitySuggestions: [],
    usedContext: [],
    modelUsed: { providerId: "p", modelId: "m" },
    tokenDelta: { before: 1, after: 2, method: "char-ratio" },
    elapsedMs: 1,
  };
}

function renderAction(onApply = vi.fn()) {
  render(
    <SystemPromptEnhanceAction workspacePath="/repo/zcode" draftText={DRAFT} onApply={onApply} />,
  );
  return onApply;
}

beforeEach(() => {
  usePromptEnhancerMock.mockReturnValue(enhancer);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  optionalServices.current = { promptEnhancerService: {} };
  enhancer.isRunning = false;
  enhancer.error = undefined;
});

describe("SystemPromptEnhanceAction", () => {
  it("prefers the target-scoped service over the ambient settings host", () => {
    // SSH 场景：设置页可能渲染在本地 host 的 ServiceProvider 下，但正在编辑的 agent
    // 属于远端 workspace。Кнопка обязана использовать сервис target-скоупа.
    const targetEnhancer = {
      enhance: vi.fn(),
      cancel: vi.fn(async () => {}),
      onStreamDelta: vi.fn(() => () => {}),
    };
    const ambientEnhancer = {
      enhance: vi.fn(),
      cancel: vi.fn(async () => {}),
      onStreamDelta: vi.fn(() => () => {}),
    };
    optionalServices.current = { promptEnhancerService: ambientEnhancer };

    render(
      <SystemPromptEnhanceAction
        workspacePath="/srv/app"
        workspaceIdentity="ssh:prod:/srv/app"
        draftText={DRAFT}
        onApply={vi.fn()}
        services={{ promptEnhancerService: targetEnhancer } as never}
      />,
    );

    expect(usePromptEnhancerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        promptEnhancerService: targetEnhancer,
        workspacePath: "/srv/app",
        workspaceIdentity: "ssh:prod:/srv/app",
      }),
    );
    expect(usePromptEnhancerMock).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ promptEnhancerService: ambientEnhancer }),
    );
  });

  it("renders nothing when the prompt enhancer service is unavailable", () => {
    optionalServices.current = undefined;
    renderAction();

    expect(screen.queryByTestId("system-prompt-enhance")).toBeNull();
  });

  it("disables the button when the draft is shorter than the minimum length", () => {
    render(
      <SystemPromptEnhanceAction
        workspacePath="/repo/zcode"
        draftText="Too short."
        onApply={vi.fn()}
      />,
    );

    const button = screen.getByTestId("system-prompt-enhance") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("applies the enhanced text straight into the field without a preview dialog", async () => {
    enhancer.enhance.mockResolvedValue(result("Enhanced system prompt"));
    const onApply = renderAction();

    await act(async () => {
      fireEvent.click(screen.getByTestId("system-prompt-enhance"));
    });

    expect(enhancer.enhance).toHaveBeenCalledWith(DRAFT);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("Enhanced system prompt");
    expect(enhancer.reset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not apply anything when the enhancement fails or is cancelled", async () => {
    enhancer.enhance.mockResolvedValue(null);
    enhancer.error = { code: "aborted", message: "cancelled" };
    const onApply = renderAction();

    await act(async () => {
      fireEvent.click(screen.getByTestId("system-prompt-enhance"));
    });

    expect(onApply).not.toHaveBeenCalled();
    expect(enhancer.reset).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the button and shows a spinner while running", () => {
    enhancer.isRunning = true;
    const { container } = render(
      <SystemPromptEnhanceAction workspacePath="/repo/zcode" draftText={DRAFT} onApply={vi.fn()} />,
    );

    const button = screen.getByTestId("system-prompt-enhance") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});
