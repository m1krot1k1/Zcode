// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptEnhanceResult } from "@zcode/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

import { EnhancePromptDetails } from "./EnhancePromptDetails.js";

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
    capabilitySuggestions: [
      {
        kind: "skill",
        name: "frontend-design",
        reason: "Matches the design task",
        installed: false,
        source: "model",
        requiresConsent: true,
      },
    ],
    usedContext: [],
    modelUsed: { providerId: "p", modelId: "m" },
    tokenDelta: { before: 1, after: 2, method: "char-ratio" },
    elapsedMs: 1,
    ...overrides,
  };
}

afterEach(cleanup);

describe("EnhancePromptDetails capability consent", () => {
  it("requires a second explicit click before installing a skill", async () => {
    const onInstallSkill = vi.fn().mockResolvedValue(undefined);
    render(<EnhancePromptDetails result={result()} onInstallSkill={onInstallSkill} />);

    const first = screen.getByRole("button", {
      name: "chat.composer.enhanceCapabilityInstall",
    });
    fireEvent.click(first);
    expect(onInstallSkill).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", {
      name: "chat.composer.enhanceCapabilityConfirmInstall",
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(onInstallSkill).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText("chat.composer.enhanceCapabilityInstalled")).toBeTruthy(),
    );
  });

  it("does not offer install for an already installed or non-skill capability", () => {
    render(
      <EnhancePromptDetails
        result={result({
          capabilitySuggestions: [
            {
              kind: "skill",
              name: "installed-skill",
              reason: "Already installed",
              installed: true,
              source: "index",
              requiresConsent: true,
            },
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
        onInstallSkill={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "chat.composer.enhanceCapabilityInstall" }),
    ).toBeNull();
    expect(screen.getByText("chat.composer.enhanceCapabilityInstalled")).toBeTruthy();
  });
});
