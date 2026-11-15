import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installZCodeMarketplacePlugin: vi.fn(),
  resolveZCodePlugins: vi.fn(),
}));

vi.mock("../src/plugins.js", () => ({
  installZCodeMarketplacePlugin: mocks.installZCodeMarketplacePlugin,
  resolveZCodePlugins: mocks.resolveZCodePlugins,
}));

import { createCapabilityInstallPort } from "../src/app/capability-install-port.js";

function createPort(mcpPort?: unknown) {
  return createCapabilityInstallPort({
    configResult: {} as never,
    mcpPort: mcpPort as never,
    pluginStorageRoot: "/storage/plugins",
    workingDirectory: "/workspace",
  });
}

describe("capability install port", () => {
  beforeEach(() => {
    mocks.installZCodeMarketplacePlugin.mockReset();
    mocks.resolveZCodePlugins.mockReset();
  });

  it("uses MCP live status and caches a successful connection", async () => {
    const status = vi.fn(async () => ({
      github: { status: "connected", transport: "http", toolCount: 3, updatedAt: "now" },
    }));
    const connectServer = vi.fn(async () => ({
      status: "connected",
      transport: "http",
      toolCount: 3,
      updatedAt: "now",
    }));
    const port = createPort({ connectServer, status });

    await expect(port.isInstalled("mcp", "github")).resolves.toBe(true);
    await expect(port.isInstalled("mcp", "other")).resolves.toBe(false);

    await expect(
      port.install({ kind: "mcp", id: "other", config: { type: "http", url: "https://x.test" } }),
    ).resolves.toMatchObject({
      kind: "mcp",
      id: "other",
      status: "installed",
      requiresReload: true,
    });
    expect(connectServer).toHaveBeenCalledWith("other", {
      type: "http",
      url: "https://x.test",
    });
    await expect(port.isInstalled("mcp", "other")).resolves.toBe(true);
  });

  it("persists the approved MCP server config to the user config before connecting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-capability-install-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({}));
    const connectServer = vi.fn(async () => ({
      status: "connected",
      transport: "http",
      toolCount: 1,
      updatedAt: "now",
    }));
    const port = createCapabilityInstallPort({
      configResult: { sources: { user: { path: configPath } } } as never,
      mcpPort: { connectServer, status: vi.fn() } as never,
      pluginStorageRoot: "/storage/plugins",
      workingDirectory: "/workspace",
    });

    try {
      await expect(
        port.install({
          kind: "mcp",
          id: "echo",
          config: { type: "http", url: "https://example.test/mcp" },
        }),
      ).resolves.toMatchObject({ status: "installed" });
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      expect(parsed).toMatchObject({
        mcp: {
          servers: {
            echo: { type: "http", url: "https://example.test/mcp" },
          },
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects MCP install without a config or MCP port", async () => {
    const port = createPort(undefined);
    await expect(port.install({ kind: "mcp", id: "x", config: {} })).rejects.toThrow(
      /MCP port is unavailable/u,
    );
  });

  it("installs a plugin through the marketplace installer and caches the installed id", async () => {
    mocks.resolveZCodePlugins.mockReturnValue({
      plugins: [{ id: "documents@market", enabled: true }],
    });
    mocks.installZCodeMarketplacePlugin.mockResolvedValue({
      dependencyClosure: [],
      diagnostics: [],
      installedPlugins: [
        {
          id: "documents@market",
          name: "documents",
          marketplace: "market",
          enabled: true,
        },
      ],
    });
    const port = createPort(undefined);

    await expect(port.isInstalled("plugin", "documents@market")).resolves.toBe(true);
    await expect(
      port.install({
        kind: "plugin",
        id: "documents@market",
        marketplace: "market",
        pluginName: "documents",
      }),
    ).resolves.toMatchObject({
      kind: "plugin",
      id: "documents@market",
      status: "installed",
      requiresReload: true,
    });
    expect(mocks.installZCodeMarketplacePlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: "market",
        pluginName: "documents",
        pluginStorageRoot: "/storage/plugins",
        workingDirectory: "/workspace",
      }),
    );
    await expect(port.isInstalled("plugin", "documents@market")).resolves.toBe(true);
  });

  it("fails when the marketplace installer reports no installed plugin", async () => {
    mocks.installZCodeMarketplacePlugin.mockResolvedValue({
      dependencyClosure: [],
      diagnostics: [{ message: "not found", severity: "error" }],
      installedPlugins: [],
    });
    const port = createPort(undefined);
    await expect(
      port.install({ kind: "plugin", id: "missing@market", marketplace: "market" }),
    ).rejects.toThrow(/did not produce an installed plugin: not found/u);
  });
});
