// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type {
  InstallMarketplaceSkillResult,
  MarketplaceSkillInfo,
  SkillSummary,
  SkillsListResult,
} from "@zcode/shared";
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

const yandexWordstat: MarketplaceSkillInfo = {
  name: "yandex-wordstat",
  skillId: "yandex-wordstat",
  source: "artwist-polyakov/polyakov-claude-skills",
  installs: 309,
  installed: false,
};

const createDeckInstallResult: InstallMarketplaceSkillResult = {
  name: "create-deck",
  scope: "workspace",
  path: "/workspace/demo/.agents/skills/create-deck",
};

const emptyListResult: SkillsListResult = {
  skills: [],
  capability: { userScopeAvailable: true },
  diagnostics: [],
};

const installedDeckSkill: SkillSummary = {
  id: "acme/deck/create-deck",
  name: "create-deck",
  description: "Build decks",
  body: "",
  path: "/workspace/demo/.agents/skills/create-deck/SKILL.md",
  scope: "workspace",
  enabled: true,
};

function installedSkillsResult(...skills: SkillSummary[]): SkillsListResult {
  return { skills, capability: { userScopeAvailable: true }, diagnostics: [] };
}

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
  it("renders installed skills immediately without any search query", async () => {
    const list = vi.fn().mockResolvedValue(installedSkillsResult(installedDeckSkill));
    renderPanel({
      list,
      searchMarketplace: vi.fn().mockResolvedValue([]),
      installMarketplaceSkill: vi.fn(),
    });

    const row = await screen.findByTestId(
      "plugin-store-skills-installed-item-acme/deck/create-deck",
    );
    expect(row.getAttribute("data-enabled")).toBe("true");
    expect(within(row).getByText("create-deck")).toBeTruthy();
    expect(within(row).getByText("This workspace")).toBeTruthy();
    expect(within(row).getByText("Enabled")).toBeTruthy();
    expect(
      within(row).getByText("/workspace/demo/.agents/skills/create-deck/SKILL.md"),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledWith({ workspacePath: "/workspace/demo" });
  });

  it("shows the installed empty state when no skills are installed", async () => {
    const list = vi.fn().mockResolvedValue(emptyListResult);
    renderPanel({
      list,
      searchMarketplace: vi.fn().mockResolvedValue([]),
      installMarketplaceSkill: vi.fn(),
    });

    expect(await screen.findByText("No installed skills yet")).toBeTruthy();
    expect(screen.getByTestId("plugin-store-skills-installed-empty")).toBeTruthy();
    expect(screen.queryByTestId("plugin-store-skills-installed-list")).toBeNull();
  });

  it("renders search results with source, installs and installed state", async () => {
    const skillsService = {
      list: vi.fn().mockResolvedValue(emptyListResult),
      searchMarketplace: vi.fn().mockResolvedValue([createDeck, legacyDeck]),
      installMarketplaceSkill: vi.fn(),
    };
    renderPanel(skillsService);

    expect(await screen.findByText("No installed skills yet")).toBeTruthy();

    submitSearch();

    await screen.findByText("create-deck");
    // 已安装列表与搜索结果互斥：查询非空时不得同时渲染已安装条目。
    expect(screen.queryByTestId("plugin-store-skills-installed-list")).toBeNull();
    expect(screen.queryByTestId("plugin-store-skills-installed-empty")).toBeNull();
    expect(skillsService.searchMarketplace).toHaveBeenCalledWith("deck", {
      workspacePath: "/workspace/demo",
    });
    expect(skillsService.searchMarketplace).toHaveBeenNthCalledWith(1, "skill", {
      workspacePath: "/workspace/demo",
    });
    expect(screen.getAllByText("acme/deck")).toHaveLength(2);
    expect(screen.getByText("Installs: 1200")).toBeTruthy();
    expect(
      screen.getByTestId("plugin-store-skills-item-legacy-deck").getAttribute("data-installed"),
    ).toBe("true");
    expect(
      screen.getByTestId("plugin-store-skills-item-create-deck").getAttribute("data-installed"),
    ).toBe("false");
    expect(
      screen.getByTestId("plugin-store-skills-install-create-deck").hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByTestId("plugin-store-skills-install-legacy-deck").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("does not render an unknown install count as zero", async () => {
    const unknownCount: MarketplaceSkillInfo = {
      name: "unknown-count",
      skillId: "unknown-count",
      source: "acme/skills",
      installed: false,
    };
    renderPanel({
      list: vi.fn().mockResolvedValue(emptyListResult),
      searchMarketplace: vi.fn().mockResolvedValue([unknownCount]),
      installMarketplaceSkill: vi.fn(),
    });

    await screen.findByText("No installed skills yet");
    submitSearch("unknown");

    const card = await screen.findByTestId("plugin-store-skills-item-unknown-count");
    expect(within(card).getByText("acme/skills")).toBeTruthy();
    expect(within(card).queryByText("Installs: 0")).toBeNull();
    expect(within(card).queryByText(/^Installs:/)).toBeNull();
  });

  it("searches remotely while typing without submit and shows matches in Popular", async () => {
    const searchMarketplace = vi.fn(async (query: string) =>
      query === "yandex" ? [yandexWordstat] : [],
    );
    renderPanel({
      list: vi.fn().mockResolvedValue(emptyListResult),
      searchMarketplace,
      installMarketplaceSkill: vi.fn(),
    });

    await screen.findByTestId("plugin-store-skills-catalog-empty");
    fireEvent.click(screen.getByTestId("plugin-store-skills-tab-popular"));
    expect(searchMarketplace).toHaveBeenCalledTimes(1);
    expect(searchMarketplace).toHaveBeenCalledWith("skill", {
      workspacePath: "/workspace/demo",
    });

    vi.useFakeTimers();
    try {
      const input = screen.getByTestId("plugin-store-skills-search");
      fireEvent.change(input, { target: { value: "yan" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      fireEvent.change(input, { target: { value: "yandex" } });
      expect(screen.getByTestId("plugin-store-skills-loading")).toBeTruthy();
      expect(screen.queryByTestId("plugin-store-skills-catalog-empty")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(349);
      });
      expect(searchMarketplace).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(searchMarketplace).toHaveBeenCalledTimes(2);
      expect(searchMarketplace).toHaveBeenLastCalledWith("yandex", {
        workspacePath: "/workspace/demo",
      });
      expect(screen.getByText("yandex-wordstat")).toBeTruthy();
      expect(screen.getByText("Installs: 309")).toBeTruthy();
      expect(screen.queryByTestId("plugin-store-skills-empty")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
      .mockResolvedValueOnce([]) // initial catalogue snapshot
      .mockResolvedValueOnce([createDeck]) // submitted search
      .mockResolvedValueOnce([installedDeck]) // refresh the submitted search
      .mockResolvedValueOnce([installedDeck]); // refresh the catalogue snapshot
    const list = vi
      .fn()
      .mockResolvedValueOnce(emptyListResult)
      .mockResolvedValue(installedSkillsResult(installedDeckSkill));
    renderPanel({ list, searchMarketplace, installMarketplaceSkill });

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
      expect(
        screen.getByTestId("plugin-store-skills-install-create-deck").hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByText("create-deck installed")).toBeTruthy();
    expect(searchMarketplace).toHaveBeenCalledTimes(4);
    expect(searchMarketplace).toHaveBeenNthCalledWith(2, "deck", {
      workspacePath: "/workspace/demo",
    });
    expect(searchMarketplace).toHaveBeenNthCalledWith(3, "deck", {
      workspacePath: "/workspace/demo",
    });
    expect(
      screen.getByTestId("plugin-store-skills-item-create-deck").getAttribute("data-installed"),
    ).toBe("true");
    // 安装成功后已安装列表独立重跑：清空查询即可看到新安装的技能。
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith({ workspacePath: "/workspace/demo" });
    fireEvent.change(screen.getByTestId("plugin-store-skills-search"), {
      target: { value: "" },
    });
    expect(
      await screen.findByTestId("plugin-store-skills-installed-item-acme/deck/create-deck"),
    ).toBeTruthy();
  });

  it("shows a retryable error and recovers to the empty state", async () => {
    const searchMarketplace = vi
      .fn()
      .mockResolvedValueOnce([]) // initial catalogue snapshot
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([]);
    renderPanel({
      list: vi.fn().mockResolvedValue(emptyListResult),
      searchMarketplace,
      installMarketplaceSkill: vi.fn(),
    });

    submitSearch();
    await screen.findByText(
      "Could not load skills from skills.sh. Check your connection and try again.",
    );

    fireEvent.click(screen.getByTestId("plugin-store-skills-retry"));
    await screen.findByText("No skills match your search");
    expect(searchMarketplace).toHaveBeenCalledTimes(3);
    expect(searchMarketplace).toHaveBeenLastCalledWith("deck", {
      workspacePath: "/workspace/demo",
    });
  });
});
