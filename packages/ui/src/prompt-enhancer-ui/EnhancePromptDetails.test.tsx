// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhanceCapabilitySuggestion, PromptEnhanceResult } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

import { EnhancePromptDetails } from "./EnhancePromptDetails.js";

function skillSuggestion(
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

function result(overrides: Partial<PromptEnhanceResult> = {}): PromptEnhanceResult {
  return {
    requestId: "req_detail_1",
    enhancedText: "Implement the endpoint and verify it",
    style: "structured_engineering",
    framework: "rise",
    domain: "coding",
    taskKind: "feature",
    addedClarifications: [],
    assumptions: [],
    capabilitySuggestions: [skillSuggestion()],
    usedContext: [],
    modelUsed: { providerId: "p", modelId: "m" },
    tokenDelta: { before: 1, after: 2, method: "char-ratio" },
    elapsedMs: 1,
    ...overrides,
  };
}

afterEach(cleanup);

describe("EnhancePromptDetails automatic skill install", () => {
  it("renders the automatic install status without any click-to-install button", () => {
    const { rerender } = render(
      <EnhancePromptDetails
        result={result()}
        skillStates={{ "frontend-design": { phase: "installing" } }}
      />,
    );

    expect(screen.getByText("chat.composer.enhanceCapabilityInstalling")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "chat.composer.enhanceCapabilityInstall" }),
    ).toBeNull();

    rerender(
      <EnhancePromptDetails
        result={result()}
        skillStates={{ "frontend-design": { phase: "installed" } }}
      />,
    );

    expect(screen.getByText("chat.composer.enhanceCapabilityInstalled")).toBeTruthy();
    expect(screen.getByText("skills.sh")).toBeTruthy();
  });

  it("keeps the panel usable after a failed install and retries only on demand", () => {
    const onRetryInstallSkill = vi.fn();
    render(
      <EnhancePromptDetails
        result={result()}
        skillStates={{ "frontend-design": { phase: "error", error: "network down" } }}
        onRetryInstallSkill={onRetryInstallSkill}
      />,
    );

    expect(screen.getByText("network down")).toBeTruthy();
    expect(onRetryInstallSkill).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "chat.composer.enhanceCapabilityInstall" }),
    );

    expect(onRetryInstallSkill).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "skill", name: "frontend-design" }),
    );
  });

  it("explains that installation is unavailable instead of offering a dead action", () => {
    render(
      <EnhancePromptDetails result={result()} installAvailable={false} />,
    );

    expect(screen.getByText("chat.composer.enhanceCapabilityUnavailable")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "chat.composer.enhanceCapabilityInstall" }),
    ).toBeNull();
  });

  it("keeps a manual install button when auto-install is disabled in settings", () => {
    const onRetryInstallSkill = vi.fn();
    render(
      <EnhancePromptDetails
        result={result()}
        autoInstallEnabled={false}
        onRetryInstallSkill={onRetryInstallSkill}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "chat.composer.enhanceCapabilityInstall" }),
    );

    expect(onRetryInstallSkill).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "skill", name: "frontend-design" }),
    );
  });

  it("asks for one inline confirmation before removing an auto-installed skill", () => {
    const onRemoveInstalledSkill = vi.fn();
    render(
      <EnhancePromptDetails
        result={result()}
        skillStates={{ "frontend-design": { phase: "installed" } }}
        onRemoveInstalledSkill={onRemoveInstalledSkill}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));
    expect(onRemoveInstalledSkill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));
    expect(onRemoveInstalledSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "frontend-design" }),
    );
  });

  it("does not offer skill actions for already indexed or non-skill capabilities", () => {
    render(
      <EnhancePromptDetails
        result={result({
          capabilitySuggestions: [
            skillSuggestion({
              name: "installed-skill",
              reason: "Already installed",
              installed: true,
              source: "index",
            }),
            {
              kind: "mcp",
              name: "browser",
              reason: "Model proposal",
              installed: false,
              source: "model",
              requiresConsent: true,
            },
          ],
        })}
        onRetryInstallSkill={vi.fn()}
        onRemoveInstalledSkill={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "chat.composer.enhanceCapabilityInstall" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "common.delete" })).toBeNull();
    expect(screen.getByText("chat.composer.enhanceCapabilityInstalled")).toBeTruthy();
  });
});
