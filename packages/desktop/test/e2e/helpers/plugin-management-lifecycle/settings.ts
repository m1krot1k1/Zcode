import {
  TID_PLUGIN_STORE_BROWSE,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
  waitForTestIdByDom,
} from "../desktop-app.js";
import { pluginControlSelector, waitForPluginControl } from "./controls.js";

export async function openPluginSettings(scope: "user" | "workspace" = "user"): Promise<void> {
  if (scope === "workspace") {
    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    return;
  }
  await waitForDefaultWorkspaceReady();
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Plugin lifecycle E2E could not open Settings",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  // Settings 路由已统一使用单数 section id；"plugins" 是旧导航契约。
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "plugin"), {
    timeout: 15000,
    timeoutMsg: "Settings did not expose the Plugins section",
  });
  // Plugin 设置页现在只管理已安装插件；商店作为 WorkspaceShell 主视图，由
  // “浏览插件/创建”入口进入。旧用例直接等待商店根节点会绕过真实导航路径。
  // 该入口有稳定 testid，不按可见文案匹配——否则 i18n 改文案就会断。
  await clickTestIdByDom(TID_PLUGIN_STORE_BROWSE, {
    timeout: 15000,
    timeoutMsg: "Plugins 设置页没有进入商店的真实入口",
  });
  await waitForPluginControl("plugin-store-root", {}, 30000);
  await waitForPluginControl("plugin-store-list", {}, 30000);
}

export async function openPluginManagementSettings(): Promise<void> {
  await waitForDefaultWorkspaceReady();
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "Workspace Plugin E2E could not open Settings",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "plugin"), {
    timeout: 15000,
    timeoutMsg: "Settings did not expose the Plugin management section",
  });
  await waitForPluginControl("plugin-settings-scope-trigger", {}, 30000);
}

export async function selectPluginSettingsScope(scope: "user" | "workspace"): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (element) => element.dataset.testid === "plugin-settings-scope-trigger",
        );
        if (!trigger) return false;
        if (trigger.getAttribute("aria-expanded") === "true") return true;
        // Radix DropdownMenu 在 pointerdown 上切换 open；仅调用 click 不会打开菜单，
        // 这会让 Workspace scope E2E 误判为没有 Workspace 选项。
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            ctrlKey: false,
            pointerType: "mouse",
          }),
        );
        return true;
      }),
    { timeout: 10000, timeoutMsg: "Plugin scope trigger did not render" },
  );
  if (scope === "user") {
    await clickTestIdByDom("plugin-settings-scope-user-option");
  } else {
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(document.querySelector('[data-testid^="plugin-settings-scope-option"]')),
        ),
      {
        timeout: 15000,
        timeoutMsg: `Workspace Plugin scope option did not render: ${JSON.stringify(
          await browser.execute(() => {
            const tabStore = (
              window as typeof window & {
                __zcodeTabStoreE2E?: {
                  getState?: () => {
                    activeWorkspacePath?: string | null;
                    activeWorkspaceIdentity?: string | null;
                    tabs?: Array<Record<string, unknown>>;
                  };
                };
              }
            ).__zcodeTabStoreE2E;
            const state = tabStore?.getState?.();
            return {
              activeWorkspacePath: state?.activeWorkspacePath ?? null,
              activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
              tabs: state?.tabs ?? [],
            };
          }),
        )}`,
      },
    );
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-testid^="plugin-settings-scope-option"]')?.click();
    });
  }
  await waitForPluginScopeSelection("plugin-settings-scope-trigger", scope);
}

export async function waitForPluginSettingsScope(scope: "user" | "workspace"): Promise<void> {
  await waitForPluginScopeSelection("plugin-settings-scope-trigger", scope);
}

export async function clickPluginSettingsListBreadcrumb(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        // Marketplace 来源详情的 breadcrumb 是
        // Plugin Marketplace > Plugins > 当前插件；这里必须回到中间的 Plugins
        // 配置视图，不能点击最左侧 Marketplace 再绕一圈。
        const listButton = document.querySelector<HTMLButtonElement>(
          '[data-testid="settings-breadcrumb-item"]',
        );
        if (!listButton) return false;
        listButton.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: "Plugin settings breadcrumb did not expose the installed-list back action",
    },
  );
  await waitForPluginControl("plugin-settings-scope-trigger", {}, 30000);
}

export async function openInstalledPluginSettingsDetail(pluginId: string): Promise<void> {
  const rowSelector = pluginControlSelector("plugin-settings-plugin-row", {
    pluginId,
  });
  const opened = await browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    const button = row?.querySelector<HTMLButtonElement>("button");
    button?.click();
    return Boolean(button);
  }, rowSelector);
  if (!opened) {
    throw new Error(`Could not open installed Plugin detail: ${pluginId}`);
  }
  await waitForPluginControl("plugin-store-detail", { pluginId });
}

export async function openInstalledPluginSettingsAdvanced(pluginId: string): Promise<void> {
  await openInstalledPluginSettingsDetail(pluginId);
  const detailSelector = pluginControlSelector("plugin-store-detail", {
    pluginId,
  });
  const expanded = await browser.execute((selector) => {
    const details = document.querySelector<HTMLDetailsElement>(`${selector} details`);
    if (!details) return false;
    details.open = true;
    return true;
  }, detailSelector);
  if (!expanded) {
    throw new Error(`Installed Plugin detail has no advanced section: ${pluginId}`);
  }
}

async function waitForPluginScopeSelection(
  triggerTestId: string,
  scope: "user" | "workspace",
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (id, expectedScope) => {
          const trigger = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (candidate) => candidate.dataset.testid === id,
          );
          const selectedKey = trigger?.dataset.pluginScopeKey;
          return expectedScope === "user"
            ? selectedKey === "user"
            : Boolean(selectedKey && selectedKey !== "user");
        },
        triggerTestId,
        scope,
      ),
    {
      timeout: 15000,
      timeoutMsg: `Plugin scope trigger did not select ${scope}: ${triggerTestId}`,
    },
  );
}
