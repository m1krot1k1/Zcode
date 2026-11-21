// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhanceCapabilitySuggestion, PromptEnhanceResult } from "@zcode/shared";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  useSuggestedSkillAutoInstall,
  type SuggestedSkillAutoInstallOptions,
  type SuggestedSkillInstaller,
} from "./useSuggestedSkillAutoInstall.js";

function result(
  capabilitySuggestions: PromptEnhanceCapabilitySuggestion[],
  requestId = "req_auto_1",
): PromptEnhanceResult {
  return {
    requestId,
    enhancedText: "Implement the endpoint and verify it",
    style: "structured_engineering",
    framework: "rise",
    domain: "coding",
    taskKind: "feature",
    addedClarifications: [],
    assumptions: [],
    capabilitySuggestions,
    usedContext: [],
    modelUsed: { providerId: "p", modelId: "m" },
    tokenDelta: { before: 1, after: 2, method: "char-ratio" },
    elapsedMs: 1,
  };
}

function skill(
  overrides: Partial<PromptEnhanceCapabilitySuggestion> = {},
): PromptEnhanceCapabilitySuggestion {
  return {
    kind: "skill",
    name: "frontend-design",
    reason: "Matches the design task",
    installed: false,
    source: "model",
    requiresConsent: true,
    ...overrides,
  };
}

function installer(overrides: Partial<SuggestedSkillInstaller> = {}): SuggestedSkillInstaller {
  return {
    installMarketplaceSkill: vi.fn(async ({ name }: { name: string }) => ({ name })),
    list: vi.fn(async () => ({
      skills: [{ id: "glm:workspace:frontend-design:hash", name: "frontend-design" }],
    })),
    deleteSkill: vi.fn(async () => undefined),
    ...overrides,
  };
}

function options(
  overrides: Partial<SuggestedSkillAutoInstallOptions> = {},
): SuggestedSkillAutoInstallOptions {
  return {
    result: result([skill()]),
    workspacePath: "/workspace",
    enabled: true,
    install: installer(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("useSuggestedSkillAutoInstall", () => {
  it("installs a suggested skill automatically when the result arrives", async () => {
    const install = installer();
    const { result: hook } = renderHook(() => useSuggestedSkillAutoInstall(options({ install })));

    await waitFor(() => expect(install.installMarketplaceSkill).toHaveBeenCalledTimes(1));
    expect(install.installMarketplaceSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "frontend-design",
        scope: "workspace",
        workspacePath: "/workspace",
      }),
    );
    await waitFor(() =>
      expect(hook.current.statuses["frontend-design"]?.phase).toBe("installed"),
    );
  });

  it("installs nothing while no suggestion list has arrived", () => {
    const install = installer();
    renderHook(() => useSuggestedSkillAutoInstall(options({ result: null, install })));

    expect(install.installMarketplaceSkill).not.toHaveBeenCalled();
  });

  it("skips already installed skills and non-skill suggestions", () => {
    const install = installer();
    renderHook(() =>
      useSuggestedSkillAutoInstall(
        options({
          install,
          result: result([
            skill({ name: "already-installed", installed: true }),
            {
              kind: "mcp",
              name: "browser",
              reason: "Model proposal",
              installed: false,
              source: "model",
              requiresConsent: true,
            },
          ]),
        }),
      ),
    );

    expect(install.installMarketplaceSkill).not.toHaveBeenCalled();
  });

  it("does not repeat an install when the same suggestion arrives again", async () => {
    const install = installer();
    const { rerender } = renderHook(
      (props: SuggestedSkillAutoInstallOptions) => useSuggestedSkillAutoInstall(props),
      { initialProps: options({ install }) },
    );

    await waitFor(() => expect(install.installMarketplaceSkill).toHaveBeenCalledTimes(1));

    rerender(options({ install, result: result([skill()], "req_auto_2") }));
    await waitFor(() => expect(install.installMarketplaceSkill).toHaveBeenCalledTimes(1));
  });

  it("keeps the panel alive and surfaces the error when installation fails", async () => {
    const install = installer({
      installMarketplaceSkill: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { result: hook } = renderHook(() => useSuggestedSkillAutoInstall(options({ install })));

    await waitFor(() => expect(hook.current.statuses["frontend-design"]?.phase).toBe("error"));
    expect(hook.current.statuses["frontend-design"]?.error).toContain("network down");
  });

  it("retries a failed install only when asked explicitly", async () => {
    const install = installer({
      installMarketplaceSkill: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({ name: "frontend-design" }),
    });
    const { result: hook } = renderHook(() => useSuggestedSkillAutoInstall(options({ install })));

    await waitFor(() => expect(hook.current.statuses["frontend-design"]?.phase).toBe("error"));
    expect(install.installMarketplaceSkill).toHaveBeenCalledTimes(1);

    act(() => hook.current.retry("frontend-design"));

    await waitFor(() =>
      expect(hook.current.statuses["frontend-design"]?.phase).toBe("installed"),
    );
    expect(install.installMarketplaceSkill).toHaveBeenCalledTimes(2);
  });

  it("does not auto-install when the setting is off", () => {
    const install = installer();
    renderHook(() => useSuggestedSkillAutoInstall(options({ install, enabled: false })));

    expect(install.installMarketplaceSkill).not.toHaveBeenCalled();
  });

  it("removes an installed skill through the same service and does not reinstall it", async () => {
    const install = installer();
    const { result: hook } = renderHook(() => useSuggestedSkillAutoInstall(options({ install })));

    await waitFor(() =>
      expect(hook.current.statuses["frontend-design"]?.phase).toBe("installed"),
    );

    await act(async () => {
      await hook.current.remove("frontend-design");
    });

    expect(install.deleteSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/workspace",
        skillId: "glm:workspace:frontend-design:hash",
      }),
    );
    expect(hook.current.statuses["frontend-design"]?.phase).toBe("removed");
    expect(hook.current.removingSkill).toBeNull();
    // result 对象身份在父级重渲染时可能变化；删除后不能因此被 effect 装回来。
    expect(install.installMarketplaceSkill).toHaveBeenCalledTimes(1);
  });
});
