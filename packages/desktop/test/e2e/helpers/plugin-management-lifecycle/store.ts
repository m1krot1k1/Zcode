import { setInputValueByTestIdDom } from "../desktop-app.js";
import { getPluginList, waitUntilPluginList, waitUntilPluginOverview } from "./agent-actions.js";
import {
  clickPluginControl,
  hasPluginControl,
  readPluginControlChecked,
  setPluginControlValue,
  waitForPluginControl,
} from "./controls.js";
import {
  PLUGIN_LIFECYCLE_CONFIG_KEY,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
} from "./constants.js";
import { readPluginConfigOptions } from "./storage.js";
import type { PluginLifecycleFixture } from "./types.js";

export async function addMarketplaceSourceThroughUi(source: string): Promise<void> {
  await waitForPluginControl("plugin-store-create");
  await browser.execute(() => {
    document
      .querySelector<HTMLElement>('[data-testid="plugin-store-create"]')
      ?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
  });
  await waitForPluginControl("plugin-store-add-source-menu-item");
  await clickPluginControl("plugin-store-add-source-menu-item");
  await waitForPluginControl("plugin-store-add-source-dialog");
  await setInputValueByTestIdDom("plugin-store-add-source-input", source, {
    timeout: 15000,
  });
  await clickPluginControl("plugin-store-add-source-submit");
}

export async function addLifecycleMarketplaceThroughUi(
  fixture: PluginLifecycleFixture,
): Promise<void> {
  await addMarketplaceSourceThroughUi(fixture.marketplaceRoot);
  await waitUntilPluginOverview(
    (overview) =>
      overview.marketplaces.some(
        (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      ),
    "Lifecycle marketplace was not persisted after the UI submission",
    60000,
  );
  await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-add-source-dialog")), {
    timeout: 60000,
    timeoutMsg: "Lifecycle marketplace completed but the source dialog remained open",
  });
}

export async function waitForPluginCard(pluginId: string, timeout = 30000): Promise<void> {
  if (!(await hasPluginControl("plugin-store-card", { pluginId }))) {
    const marketplaceSeparator = pluginId.lastIndexOf("@");
    const marketplaceId =
      marketplaceSeparator >= 0 ? pluginId.slice(marketplaceSeparator + 1) : undefined;
    const groupKey = marketplaceId ? `marketplace:${marketplaceId}` : undefined;
    if (groupKey) {
      await browser.waitUntil(
        async () =>
          (await hasPluginControl("plugin-store-card", { pluginId })) ||
          (await hasPluginControl("plugin-store-group-toggle", { groupKey })),
        {
          timeout,
          timeoutMsg: `Plugin marketplace group did not render: ${groupKey}`,
        },
      );
      if (
        !(await hasPluginControl("plugin-store-card", { pluginId })) &&
        (await hasPluginControl("plugin-store-group-toggle", { groupKey }))
      ) {
        // 折叠分组只渲染前六张卡片；测试仍通过真实展开入口寻找目标插件。
        await clickPluginControl("plugin-store-group-toggle", { groupKey });
      }
    }
  }
  await waitForPluginControl("plugin-store-card", { pluginId }, timeout);
}

export async function openPluginCard(pluginId: string): Promise<void> {
  await waitForPluginCard(pluginId);
  await clickPluginControl("plugin-store-card", { pluginId });
  await waitForPluginControl("plugin-store-detail", { pluginId }, 30000);
}

export async function installPluginThroughUi(pluginId: string): Promise<void> {
  await clickPluginControl("plugin-store-install", { pluginId });
  await waitUntilPluginOverview(
    (overview) => overview.installedPlugins.some((plugin) => plugin.id === pluginId),
    `Plugin did not install through UI: ${pluginId}`,
    120000,
  );
}

export async function setPluginEnabledThroughUi(
  pluginId: string,
  enabled: boolean,
  entry: "detail" | "manage" = "detail",
): Promise<void> {
  if (entry === "manage") {
    const current = await readPluginControlChecked("plugin-settings-enabled-switch", { pluginId });
    if (current !== enabled)
      await clickPluginControl("plugin-settings-enabled-switch", { pluginId });
  } else {
    const list = await getPluginList();
    if (list.plugins.find((plugin) => plugin.id === pluginId)?.enabled !== enabled) {
      await clickPluginControl("plugin-store-item-menu", { pluginId });
      await clickPluginControl("plugin-store-menu-enabled", { pluginId });
    }
  }
  await waitUntilPluginList(
    (list) => list.plugins.some((plugin) => plugin.id === pluginId && plugin.enabled === enabled),
    `Plugin enabled state did not become ${enabled}: ${pluginId}`,
  );
}

export async function configureLifecyclePluginThroughUi(value: string): Promise<void> {
  await clickPluginControl("plugin-store-advanced");
  await setPluginControlValue(
    "plugin-store-config-input",
    { configKey: PLUGIN_LIFECYCLE_CONFIG_KEY },
    value,
  );
  await clickPluginControl("plugin-store-config-save", {
    pluginId: PLUGIN_LIFECYCLE_ID,
  });
  await browser.waitUntil(
    async () => (await readPluginConfigOptions())[PLUGIN_LIFECYCLE_CONFIG_KEY] === value,
    { timeout: 30000, timeoutMsg: "Plugin configuration did not persist" },
  );
}

export async function uninstallPluginThroughUi(pluginId: string, confirm: boolean): Promise<void> {
  await clickPluginControl("plugin-store-item-menu", { pluginId });
  await clickPluginControl("plugin-store-menu-uninstall", { pluginId });
  await waitForPluginControl("plugin-store-uninstall-dialog");
  await clickPluginControl(
    confirm ? "plugin-store-uninstall-confirm" : "plugin-store-uninstall-cancel",
  );
  if (confirm) {
    await waitUntilPluginOverview(
      (overview) => !overview.installedPlugins.some((plugin) => plugin.id === pluginId),
      `Plugin remained installed after confirmation: ${pluginId}`,
      120000,
    );
  } else {
    await waitUntilPluginOverview(
      (overview) => overview.installedPlugins.some((plugin) => plugin.id === pluginId),
      `Cancelling uninstall changed installation: ${pluginId}`,
    );
  }
}

export async function openManageView(): Promise<void> {
  await clickPluginControl("plugin-store-manage-open");
  await waitForPluginControl("plugin-store-manage");
}

export async function openSourcesDialog(): Promise<void> {
  await clickPluginControl("plugin-store-sources-open");
  await waitForPluginControl("plugin-store-sources-dialog");
}

export async function removeMarketplaceSourceThroughUi(marketplaceId: string): Promise<void> {
  await openSourcesDialog();
  await clickPluginControl("plugin-store-source-remove", { marketplaceId });
  await browser.waitUntil(
    async () => !(await hasPluginControl("plugin-store-source-row", { marketplaceId })),
    {
      timeout: 30000,
      timeoutMsg: `Marketplace source was not removed: ${marketplaceId}`,
    },
  );
  // 来源删除完成后通过弹窗标准 Escape 入口返回商店；否则 overlay 会拦截后续管理入口。
  await browser.keys(["Escape"]);
  await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-sources-dialog")), {
    timeout: 10000,
    timeoutMsg: "Marketplace sources dialog did not close",
  });
}
