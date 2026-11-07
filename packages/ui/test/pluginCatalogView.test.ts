// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/settings/PluginStoreCard.js", () => ({
  PluginStoreCard: ({ item }: { item: StorePluginItem }) =>
    createElement("div", {
      "data-testid": "card",
      "data-plugin-id": item.id,
      "data-installed": String(item.installed),
    }),
}));
vi.mock("@/settings/SettingsSearchInput.js", () => ({
  SettingsSearchInput: ({ value }: { value?: string }) =>
    createElement("input", { "data-testid": "search-input", value }),
}));

import { PluginCatalogView } from "../src/settings/PluginCatalogView.js";
import { buildPluginCatalogView } from "../src/settings/pluginCatalogView.js";

const OFFICIAL = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID;

function plugin(name: string, kind: "official" | "community", installed = false): StorePluginItem {
  return {
    id: `${name}@${OFFICIAL}`,
    name,
    marketplace: OFFICIAL,
    installed,
    restorable: false,
    orphaned: false,
    listing: { publisherType: kind },
    summary: { id: `${name}@${OFFICIAL}`, name, marketplace: OFFICIAL, installed },
  };
}

// pdf/documents 在共享策展名单内（rank 0 / 3），alpha 不在名单内；community-item 来自社区。
const items: StorePluginItem[] = [
  plugin("community-item", "community"),
  plugin("alpha", "official"),
  plugin("documents", "official"),
  plugin("pdf", "official", true),
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
});

function renderCatalog(query = "") {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(PluginCatalogView, {
        items,
        actions: {} as PluginStoreActions,
        query,
        onQueryChange: vi.fn(),
      }),
    ),
  );
  return container;
}

const ids = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="card"]')].map(
    (node) => node.dataset.pluginId,
  );

describe("plugin catalog view", () => {
  it("orders official items first (curated rank, then name), then community", () => {
    const view = buildPluginCatalogView({
      items,
      tab: "all",
      sort: "recommended",
      filter: "",
      locale: "en-US",
    });
    expect(view.map((entry) => entry.item.name)).toEqual([
      "pdf",
      "documents",
      "alpha",
      "community-item",
    ]);
    expect(view.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
    expect(view.map((entry) => entry.source)).toEqual([
      "official",
      "official",
      "official",
      "community",
    ]);
  });

  it("sorts by name across sources when the name sort is selected", () => {
    const view = buildPluginCatalogView({
      items,
      tab: "all",
      sort: "name",
      filter: "",
      locale: "en-US",
    });
    expect(view.map((entry) => entry.item.name)).toEqual([
      "alpha",
      "community-item",
      "documents",
      "pdf",
    ]);
  });

  it("badges the real source and adds Featured only for curated plugin ids", () => {
    const view = buildPluginCatalogView({
      items,
      tab: "all",
      sort: "recommended",
      filter: "",
      locale: "en-US",
    });
    const byName = new Map(view.map((entry) => [entry.item.name, entry.badges]));
    expect(byName.get("pdf")).toEqual(["official", "featured"]);
    expect(byName.get("documents")).toEqual(["official", "featured"]);
    // 未进入共享策展名单的条目不得出现 Featured（或 Trending）徽章。
    expect(byName.get("alpha")).toEqual(["official"]);
    expect(byName.get("community-item")).toEqual(["community"]);
  });

  it("filters by the preserved search query without changing order or installed state", () => {
    const view = buildPluginCatalogView({
      items,
      tab: "all",
      sort: "recommended",
      filter: "doc",
      locale: "en-US",
    });
    expect(view.map((entry) => entry.item.name)).toEqual(["documents"]);
    const installed = buildPluginCatalogView({
      items,
      tab: "all",
      sort: "name",
      filter: "pdf",
      locale: "en-US",
    });
    expect(installed.map((entry) => entry.item.name)).toEqual(["pdf"]);
    expect(installed[0]?.item.installed).toBe(true);
  });

  it("renders tabs, rank numbers and badges, and never renders install counters", () => {
    const container = renderCatalog();
    expect(container.querySelector('[data-testid="plugin-catalog-tab-all"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-catalog-tab-official"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin-catalog-tab-community"]')).not.toBeNull();
    // 没有 anthropics 目录来源，不渲染第四个页签。
    expect(container.querySelector('[data-testid="plugin-catalog-tab-anthropics"]')).toBeNull();

    expect(ids(container)).toEqual([
      `pdf@${OFFICIAL}`,
      `documents@${OFFICIAL}`,
      `alpha@${OFFICIAL}`,
      `community-item@${OFFICIAL}`,
    ]);
    const ranks = [...container.querySelectorAll<HTMLElement>('[data-testid="plugin-catalog-rank"]')];
    expect(ranks.map((node) => node.dataset.rank)).toEqual(["1", "2", "3", "4"]);

    const pdfBadges = [
      ...container.querySelectorAll<HTMLElement>(
        `[data-testid="plugin-catalog-badge"][data-plugin-id="pdf@${OFFICIAL}"]`,
      ),
    ].map((node) => node.dataset.badge);
    expect(pdfBadges).toEqual(["official", "featured"]);

    // 数据源没有 installs/publishedAt，界面不能出现任何安装量或趋势文案。
    expect(container.textContent ?? "").not.toMatch(/installs?|downloads?|trending/i);
  });

  it("keeps installed state and rank numbering when the community tab is selected", () => {
    const container = renderCatalog();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-catalog-tab-community"]')!
        .click(),
    );
    expect(ids(container)).toEqual([`community-item@${OFFICIAL}`]);
    const rank = container.querySelector<HTMLElement>('[data-testid="plugin-catalog-rank"]');
    expect(rank?.dataset.rank).toBe("1");

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="plugin-catalog-tab-official"]')!
        .click(),
    );
    const installedCard = container.querySelector<HTMLElement>(
      `[data-testid="card"][data-plugin-id="pdf@${OFFICIAL}"]`,
    );
    expect(installedCard?.dataset.installed).toBe("true");
  });

  it("renders the empty state when search matches nothing", () => {
    const container = renderCatalog("no-such-plugin");
    expect(container.querySelectorAll('[data-testid="card"]')).toHaveLength(0);
  });
});
