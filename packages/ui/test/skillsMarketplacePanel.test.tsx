// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { InstallMarketplaceSkillResult, MarketplaceSkillInfo } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { SkillsMarketplacePanel } from "@/settings/SkillsMarketplacePanel.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

const createDeck: MarketplaceSkillInfo = {
  name: "create-deck",
  skillId: "create-deck",
  source: "acme/deck",
  installs: 1200,
  installed: false,
};

const installedDeck: MarketplaceSkillInfo = { ...createDeck, installed: true };

const legacyDeck: MarketplaceSkillInfo = {
  name: "legacy-deck",
  skillId: "legacy-deck",
  source: "acme/deck",
  installs: 7,
  installed: true,
};

const createDeckInstallResult: InstallMarketplaceSkillResult = {
  name: "create-deck",
  scope: "workspace",
  path: "/workspace/demo/.agents/skills/create-deck",
};

function renderPanel(skillsService: Record<string, unknown>) {
  const view = render(
    <ZCodeIntlProvider initialLocale="en-US">
      <ServiceProvider services={{ skillsService } as unknown as IServiceAccessor}>
        <SkillsMarketplacePanel workspacePath="/workspace/demo" />
      </ServiceProvider>
    </ZCodeIntlProvider>,
  );
  mounted.push(view.unmount);
}

function submitSearch(value = "deck") {
  fireEvent.change(screen.getByTestId("plugin-store-skills-search"), {
    target: { value },
  });
  fireEvent.click(screen.getByTestId("plugin-store-skills-submit"));
}

describe("Skills marketplace panel", () => {
  it("shows the idle hint and renders search results with source, installs and installed state", async () => {
    const skillsService = {
      searchMarketplace: vi.fn().mockResolvedValue([createDeck, legacyDeck]),
      installMarketplaceSkill: vi.fn(),
    };
    renderPanel(skillsService);

    expect(
      screen.getByText("Search skills.sh to discover and install community skills."),
    ).toBeTruthy();

    submitSearch();

    await screen.findByText("create-deck");
    expect(skillsService.searchMarketplace).toHaveBeenCalledWith("deck", {
      workspacePath: "/workspace/demo",
    });
    expect(screen.getAllByText("acme/deck")).toHaveLength(2);
    expect(screen.getByText("Installs: 1200")).toBeTruthy();
    expect(
      screen
        .getByTestId("plugin-store-skills-item-legacy-deck")
        .getAttribute("data-installed"),
    ).toBe("true");
    expect(
      screen.getByTestId("plugin-store-skills-item-create-deck").getAttribute("data-installed"),
    ).toBe("false");
    expect(screen.getByTestId("plugin-store-skills-install-create-deck").hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByTestId("plugin-store-skills-install-legacy-deck").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("shows per-item install loading and refreshes installed state after success", async () => {
    let resolveInstall: ((value: InstallMarketplaceSkillResult) => void) | undefined;
    const installMarketplaceSkill = vi.fn(
      () =>
        new Promise<InstallMarketplaceSkillResult>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const searchMarketplace = vi
      .fn()
      .mockResolvedValueOnce([createDeck])
      .mockResolvedValueOnce([installedDeck]);
    renderPanel({ searchMarketplace, installMarketplaceSkill });

    submitSearch();
    await screen.findByText("create-deck");
    fireEvent.click(screen.getByTestId("plugin-store-skills-install-create-deck"));

    await screen.findByText("Installing…");
    expect(
      screen.getByTestId("plugin-store-skills-install-create-deck").hasAttribute("disabled"),
    ).toBe(true);
    expect(installMarketplaceSkill).toHaveBeenCalledWith({
      name: "acme/deck/create-deck",
      scope: "workspace",
      workspacePath: "/workspace/demo",
    });

    resolveInstall?.(createDeckInstallResult);

    await waitFor(() =>
      expect(screen.getByTestId("plugin-store-skills-install-create-deck").hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(screen.getByText("create-deck installed")).toBeTruthy();
    expect(searchMarketplace).toHaveBeenCalledTimes(2);
    expect(searchMarketplace).toHaveBeenLastCalledWith("deck", {
      workspacePath: "/workspace/demo",
    });
    expect(
      screen.getByTestId("plugin-store-skills-item-create-deck").getAttribute("data-installed"),
    ).toBe("true");
  });

  it("shows a retryable error and recovers to the empty state", async () => {
    const searchMarketplace = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([]);
    renderPanel({ searchMarketplace, installMarketplaceSkill: vi.fn() });

    submitSearch();
    await screen.findByText(
      "Could not load skills from skills.sh. Check your connection and try again.",
    );

    fireEvent.click(screen.getByTestId("plugin-store-skills-retry"));
    await screen.findByText("No skills match your search");
    expect(searchMarketplace).toHaveBeenCalledTimes(2);
    expect(searchMarketplace).toHaveBeenLastCalledWith("deck", {
      workspacePath: "/workspace/demo",
    });
  });
});
