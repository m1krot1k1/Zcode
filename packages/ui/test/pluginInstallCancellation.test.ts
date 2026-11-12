// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPluginManagementService } from "@zcode/services";
import type { ZCodePluginsInstallResult } from "@zcode/shared";
import { createPluginManagementStore } from "@/store/pluginManagementStore.js";
import { isPluginOperationCancelledError } from "@/store/pluginManagementStoreLoading.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type InstallParams = Parameters<IPluginManagementService["installPlugin"]>[0];
type CancelParams = Parameters<IPluginManagementService["cancelPluginOperation"]>[0];

function emptyOverview() {
  return {
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
  };
}

function installResult(
  overrides: Partial<ZCodePluginsInstallResult> = {},
): ZCodePluginsInstallResult {
  return { installedPlugins: [], dependencyClosure: [], diagnostics: [], ...overrides };
}

function cancelledDiagnostic() {
  return {
    code: "plugin_marketplace_invalid",
    message: "Plugin operation cancelled",
    severity: "error" as const,
  };
}

function createService(overrides: Partial<IPluginManagementService> = {}): IPluginManagementService {
  return {
    listPlugins: vi.fn(async () => ({ plugins: [], diagnostics: [] })),
    getPluginsOverview: vi.fn(async () => emptyOverview()),
    installPlugin: vi.fn<IPluginManagementService["installPlugin"]>(async () => installResult()),
    cancelPluginOperation: vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      async ({ operationId }) => ({ operationId, cancelled: true }),
    ),
    ...overrides,
  } as unknown as IPluginManagementService;
}

function makeItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "demo@personal",
    name: "demo",
    marketplace: "personal",
    installed: false,
    restorable: false,
    orphaned: false,
    ...overrides,
  };
}

function makeActions(overrides: Partial<PluginStoreActions> = {}): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onUpdate: () => {},
    activeOperations: [],
    togglingPluginId: null,
    ...overrides,
  };
}

function deferredInstall() {
  let resolveInstall!: (value: ZCodePluginsInstallResult) => void;
  let rejectInstall!: (error: Error) => void;
  const installPlugin = vi.fn<IPluginManagementService["installPlugin"]>(
    () =>
      new Promise<ZCodePluginsInstallResult>((resolve, reject) => {
        resolveInstall = resolve;
        rejectInstall = reject;
      }),
  );
  return {
    installPlugin,
    finish: (value: ZCodePluginsInstallResult) => resolveInstall(value),
    fail: (error: Error) => rejectInstall(error),
    lastOperationId: () => installPlugin.mock.calls.at(-1)?.[0].operationId,
  };
}

describe("plugin install cancellation (store)", () => {
  it("sends one generated operationId to the RPC and exposes it on the active entry", async () => {
    const pending = deferredInstall();
    const service = createService({ installPlugin: pending.installPlugin });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));

    const operationId = pending.lastOperationId();
    expect(operationId).toEqual(expect.any(String));
    expect(operationId).not.toHaveLength(0);
    expect((pending.installPlugin.mock.calls[0]?.[0] as InstallParams).operationId).toBe(
      operationId,
    );
    expect(store.getState().activeOperations).toEqual([
      { id: "plugin:install:demo@personal", remoteOperationId: operationId },
    ]);

    pending.finish(installResult());
    await installing;
    expect(store.getState().activeOperations).toEqual([]);
  });

  it("cancels the same operationId and stays in cancelling state until install settles", async () => {
    const pending = deferredInstall();
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      async ({ operationId }) => ({ operationId, cancelled: true }),
    );
    const service = createService({
      installPlugin: pending.installPlugin,
      cancelPluginOperation,
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));
    const operationId = pending.lastOperationId()!;

    await expect(store.getState().cancelInstall("demo", "personal", service)).resolves.toBe(true);

    expect(cancelPluginOperation.mock.calls[0]?.[0]).toEqual({
      operationId,
    } satisfies CancelParams);
    expect(store.getState().cancellingOperationIds).toEqual([operationId]);
    // 取消只是请求，底层 promise 未结束前条目仍在。
    expect(store.getState().activeOperations).toHaveLength(1);

    pending.fail(new Error("Plugin operation cancelled"));
    await installing;

    expect(store.getState().activeOperations).toEqual([]);
    expect(store.getState().cancellingOperationIds).toEqual([]);
  });

  it("settles a user cancellation as no error and reloads the real projection", async () => {
    const pending = deferredInstall();
    const listPlugins = vi.fn(async () => ({ plugins: [], diagnostics: [] }));
    const getPluginsOverview = vi.fn(async () => emptyOverview());
    const service = createService({
      listPlugins,
      getPluginsOverview,
      installPlugin: pending.installPlugin,
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));

    await expect(store.getState().cancelInstall("demo", "personal", service)).resolves.toBe(true);
    // CLI 的取消投影：ENVELOPE 成功、diagnostics 里带取消错误。
    pending.finish(installResult({ diagnostics: [cancelledDiagnostic()] }));
    await expect(installing).resolves.toBe(false);

    expect(store.getState().error).toBeNull();
    expect(store.getState().activeOperations).toEqual([]);
    expect(store.getState().cancelRequestOperationIds).toEqual([]);
    expect(store.getState().cancellingOperationIds).toEqual([]);
    // initialize 各一次 + 取消收口后的重新投影各一次。
    expect(listPlugins).toHaveBeenCalledTimes(2);
    expect(getPluginsOverview).toHaveBeenCalledTimes(2);
  });

  it("shows a cancellation diagnostic that no user requested", async () => {
    const service = createService({
      installPlugin: vi.fn<IPluginManagementService["installPlugin"]>(async () =>
        installResult({ diagnostics: [cancelledDiagnostic()] }),
      ),
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    await store.getState().installPlugin("demo", "personal", service);

    // CLI 自行中止（非用户取消）不能被伪装成用户取消而静默吞掉。
    expect(store.getState().error).toBe("Plugin operation cancelled");
  });

  it("does not hide an unrelated install failure", async () => {
    const service = createService({
      installPlugin: vi.fn<IPluginManagementService["installPlugin"]>(async () =>
        installResult({
          diagnostics: [
            {
              code: "plugin_archive_fetch_failed",
              message: "Archive download timed out",
              severity: "error" as const,
            },
          ],
        }),
      ),
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    await store.getState().installPlugin("demo", "personal", service);

    expect(store.getState().error).toBe("Archive download timed out");
  });

  it("clears the cancelling projection when the CLI cannot cancel the operation", async () => {
    const pending = deferredInstall();
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      async ({ operationId }) => ({ operationId, cancelled: false }),
    );
    const service = createService({
      installPlugin: pending.installPlugin,
      cancelPluginOperation,
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));

    await expect(store.getState().cancelInstall("demo", "personal", service)).resolves.toBe(false);

    expect(store.getState().cancellingOperationIds).toEqual([]);
    expect(store.getState().activeOperations).toHaveLength(1);

    pending.finish(installResult());
    await expect(installing).resolves.toBe(true);
  });

  it("clears the cancelling projection when the cancel RPC rejects", async () => {
    const pending = deferredInstall();
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      async () => {
        throw new Error("cancel transport unavailable");
      },
    );
    const service = createService({
      installPlugin: pending.installPlugin,
      cancelPluginOperation,
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));

    await expect(store.getState().cancelInstall("demo", "personal", service)).resolves.toBe(false);
    expect(store.getState().cancellingOperationIds).toEqual([]);

    pending.finish(installResult());
    await expect(installing).resolves.toBe(true);
  });

  it("keeps a successful install when cancel and persistence race", async () => {
    const pending = deferredInstall();
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      async ({ operationId }) => ({ operationId, cancelled: true }),
    );
    const service = createService({ installPlugin: pending.installPlugin, cancelPluginOperation });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));

    await expect(store.getState().cancelInstall("demo", "personal", service)).resolves.toBe(true);
    pending.finish(installResult());

    await expect(installing).resolves.toBe(true);
    expect(store.getState().error).toBeNull();
    expect(store.getState().activeOperations).toEqual([]);
    expect(store.getState().cancellingOperationIds).toEqual([]);
  });

  it("keeps install status while the cancel request is pending, then shows cancelling", async () => {
    const pending = deferredInstall();
    const cancelOperation = Promise.withResolvers<{ operationId: string; cancelled: boolean }>();
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      () => cancelOperation.promise,
    );
    const service = createService({
      installPlugin: pending.installPlugin,
      cancelPluginOperation,
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));
    const operationId = pending.lastOperationId()!;

    const cancelling = store.getState().cancelInstall("demo", "personal", service);
    await vi.waitFor(() =>
      expect(store.getState().cancelRequestOperationIds).toEqual([operationId]),
    );
    // 请求尚未得到 CLI 应答：不能提前显示“正在取消”。
    expect(store.getState().cancellingOperationIds).toEqual([]);

    cancelOperation.resolve({ operationId, cancelled: true });
    await expect(cancelling).resolves.toBe(true);
    expect(store.getState().cancelRequestOperationIds).toEqual([]);
    expect(store.getState().cancellingOperationIds).toEqual([operationId]);

    pending.fail(new Error("Plugin operation cancelled"));
    await installing;
    expect(store.getState().cancellingOperationIds).toEqual([]);
  });

  it("does not leave a ghost cancelling state when the install settles first", async () => {
    const pending = deferredInstall();
    const cancelOperation = Promise.withResolvers<{ operationId: string; cancelled: boolean }>();
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      () => cancelOperation.promise,
    );
    const service = createService({
      installPlugin: pending.installPlugin,
      cancelPluginOperation,
    });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });
    const installing = store.getState().installPlugin("demo", "personal", service);
    await vi.waitFor(() => expect(pending.installPlugin).toHaveBeenCalledTimes(1));
    const operationId = pending.lastOperationId()!;

    const cancelling = store.getState().cancelInstall("demo", "personal", service);
    await vi.waitFor(() =>
      expect(store.getState().cancelRequestOperationIds).toEqual([operationId]),
    );
    pending.finish(installResult());
    await installing;

    cancelOperation.resolve({ operationId, cancelled: true });
    await expect(cancelling).resolves.toBe(true);
    // 安装已经收口；迟到的确认不能把状态写回。
    expect(store.getState().activeOperations).toEqual([]);
    expect(store.getState().cancelRequestOperationIds).toEqual([]);
    expect(store.getState().cancellingOperationIds).toEqual([]);
  });

  it("returns false without an active install for the plugin", async () => {
    const cancelPluginOperation = vi.fn<IPluginManagementService["cancelPluginOperation"]>(
      async ({ operationId }) => ({ operationId, cancelled: true }),
    );
    const service = createService({ cancelPluginOperation });
    const store = createPluginManagementStore();
    await store.getState().initialize({ workspacePath: "/workspace/app", pluginService: service });

    await expect(store.getState().cancelInstall("demo", "personal", service)).resolves.toBe(false);
    expect(cancelPluginOperation).not.toHaveBeenCalled();
  });

  it("recognizes CLI cancellation errors and ignores unrelated failures", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isPluginOperationCancelledError(abort)).toBe(true);
    expect(isPluginOperationCancelledError(new Error("Plugin operation cancelled"))).toBe(true);
    expect(
      isPluginOperationCancelledError(
        Object.assign(new Error("failed"), { code: "plugin_operation_cancelled" }),
      ),
    ).toBe(true);
    expect(isPluginOperationCancelledError(new Error("Archive download timed out"))).toBe(false);
    expect(isPluginOperationCancelledError("Plugin operation cancelled")).toBe(false);
  });
});

describe("plugin install cancellation (UI)", () => {
  async function renderInstallButton(
    item: StorePluginItem,
    actions: PluginStoreActions,
    locale: "en-US" | "zh-CN" = "en-US",
  ): Promise<string> {
    const { PluginStoreInstallButton } = await import("@/settings/PluginStoreCard.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
    return renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(PluginStoreInstallButton, { item, actions, size: "sm" }),
      ),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Cancel for an install that carries a remote operationId", async () => {
    const onCancelInstall = vi.fn();
    const html = await renderInstallButton(
      makeItem(),
      makeActions({
        onCancelInstall,
        activeOperations: [
          { id: "plugin:install:demo@personal", remoteOperationId: "remote-1" },
        ],
      }),
    );

    expect(html).toContain('data-testid="plugin-store-install-cancel"');
    expect(html).toContain(">Cancel<");
    expect(html).toContain("Installing…");
  });

  it("does not show Cancel for restore operations", async () => {
    const html = await renderInstallButton(
      makeItem({ restorable: true }),
      makeActions({
        onCancelInstall: () => {},
        activeOperations: [{ id: "plugin:restore:demo@personal" }],
      }),
    );

    expect(html).toContain('data-testid="plugin-store-install"');
    expect(html).not.toContain('data-testid="plugin-store-install-cancel"');
  });

  it("shows the localized cancelling state and disables the Cancel button after the request", async () => {
    const html = await renderInstallButton(
      makeItem(),
      makeActions({
        onCancelInstall: () => {},
        activeOperations: [
          { id: "plugin:install:demo@personal", remoteOperationId: "remote-1" },
        ],
        cancellingOperationIds: ["remote-1"],
      }),
      "zh-CN",
    );

    expect(html).toContain("正在取消…");
    expect(html).not.toContain("安装中…");
    // 取消按钮带 disabled 属性，避免重复发送取消请求。
    expect(html).toMatch(/data-testid="plugin-store-install-cancel"[^>]*disabled/);
  });

  it("disables Cancel while the cancel request is pending without changing status text", async () => {
    const html = await renderInstallButton(
      makeItem(),
      makeActions({
        onCancelInstall: () => {},
        activeOperations: [
          { id: "plugin:install:demo@personal", remoteOperationId: "remote-1" },
        ],
        cancelRequestOperationIds: ["remote-1"],
      }),
    );

    expect(html).toContain("Installing…");
    expect(html).not.toContain("Cancelling…");
    expect(html).toMatch(/data-testid="plugin-store-install-cancel"[^>]*disabled/);
  });

  it("exposes the install progress in a live status region", async () => {
    const html = await renderInstallButton(
      makeItem(),
      makeActions({
        onCancelInstall: () => {},
        activeOperations: [
          { id: "plugin:install:demo@personal", remoteOperationId: "remote-1" },
        ],
      }),
    );

    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
  });
});
