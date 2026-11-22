import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLoadOutcome } from "@zcode/contracts";

const mocks = vi.hoisted(() => ({
  resolveZCodePlugins: vi.fn(),
}));

vi.mock("../src/plugins.js", () => ({
  resolveZCodePlugins: mocks.resolveZCodePlugins,
}));

import { createPluginRuntimeCatalog } from "../src/app/plugin-runtime-catalog.js";

const outcome = (name: string): PluginLoadOutcome => ({
  commandRoots: [],
  diagnostics: [],
  hooks: {},
  mcpServers: {},
  plugins: [
    {
      commandRootCount: 0,
      components: [],
      dataPath: `/tmp/${name}`,
      declaredMcpServerNames: [],
      enabled: true,
      hookDetails: [],
      id: `${name}@market`,
      manifestPath: `/tmp/${name}/plugin.json`,
      marketplace: "market",
      mcpServerNames: [],
      name,
      rootPath: `/tmp/${name}`,
      skillCount: 0,
      skillRootCount: 0,
      source: "cache",
    },
  ],
  skillRoots: [],
});

describe("plugin runtime catalog", () => {
  beforeEach(() => {
    mocks.resolveZCodePlugins.mockReset();
  });

  it("reloads config from disk and serializes concurrent refreshes", async () => {
    mocks.resolveZCodePlugins.mockReturnValueOnce(outcome("documents"));
    const initial = outcome("initial");
    const catalog = createPluginRuntimeCatalog({
      initial,
      pluginStorageRoot: "/tmp/plugins",
      workingDirectory: "/workspace",
    });

    expect(catalog.current()).toBe(initial);
    const first = catalog.refresh();
    const second = catalog.refresh();
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      plugins: [expect.objectContaining({ id: "documents@market" })],
    });
    expect(mocks.resolveZCodePlugins).toHaveBeenCalledTimes(1);
    expect(mocks.resolveZCodePlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginStorageRoot: "/tmp/plugins",
        workingDirectory: "/workspace",
      }),
    );
    expect(catalog.current()).toMatchObject({
      plugins: [expect.objectContaining({ id: "documents@market" })],
    });
  });
});
