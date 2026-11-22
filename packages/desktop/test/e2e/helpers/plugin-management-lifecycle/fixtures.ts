import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getE2EAppDataPaths } from "../desktop-app.js";
import {
  PLUGIN_INLINE_ID,
  PLUGIN_INLINE_NAME,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_NAME,
} from "./constants.js";
import {
  writeLifecyclePlugin,
  writeMarketplaceManifest,
  writeSimplePlugin,
} from "./fixture-files.js";
import { isRecord, readJsonRecord, writeJson, writeText } from "./json-io.js";
import type { PluginLifecycleFixture } from "./types.js";

export async function createPluginLifecycleFixture(
  version = "1.0.0",
  withUi = false,
): Promise<PluginLifecycleFixture> {
  const { homeDir } = getE2EAppDataPaths();
  const marketplaceRoot = join(homeDir, "fixtures", "plugin-management-lifecycle-market");
  const pluginRoot = join(marketplaceRoot, "plugins", PLUGIN_LIFECYCLE_NAME);
  await rm(marketplaceRoot, { force: true, recursive: true });
  await writeLifecyclePlugin(pluginRoot, version, withUi);
  for (let index = 1; index <= 7; index += 1) {
    await writeSimplePlugin(
      join(marketplaceRoot, "plugins", `e2e-lifecycle-extra-${index}`),
      index,
    );
  }
  await writeMarketplaceManifest(marketplaceRoot, version);
  if (withUi) {
    const path = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
    const catalog = await readJsonRecord(path);
    const entries = catalog.plugins as Array<Record<string, unknown>>;
    entries.find((entry) => entry.name === PLUGIN_LIFECYCLE_NAME)!.componentTypes = ["mcp", "ui"];
    await writeJson(path, catalog);
  }
  const managedPluginRoot = lifecycleManagedPluginRoot(homeDir);
  if (existsSync(dirname(dirname(managedPluginRoot)))) {
    // 已登记的 directory marketplace 会复制进 managed storage；失败恢复必须同步修复该副本。
    await rm(managedPluginRoot, { force: true, recursive: true });
    await mkdir(dirname(managedPluginRoot), { recursive: true });
    await cp(pluginRoot, managedPluginRoot, { force: true, recursive: true });
  }
  return { marketplaceRoot, pluginRoot, version };
}

export async function updatePluginLifecycleFixture(
  fixture: PluginLifecycleFixture,
  version: string,
): Promise<PluginLifecycleFixture> {
  await writeLifecyclePlugin(fixture.pluginRoot, version);
  await writeMarketplaceManifest(fixture.marketplaceRoot, version);
  return { ...fixture, version };
}

export async function removeLifecyclePluginSource(fixture: PluginLifecycleFixture): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  await rm(fixture.marketplaceRoot, { force: true, recursive: true });
  // directory marketplace 在添加时会复制到 managed storage；仅删除原目录不会触发
  // describe/install/update 失败，因此故障注入必须同时移除权威 managed plugin 副本。
  await rm(lifecycleManagedPluginRoot(homeDir), {
    force: true,
    recursive: true,
  });
}

export async function removeLifecyclePluginPayload(fixture: PluginLifecycleFixture): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  // 保留 marketplace manifest 与登记关系，只移除其声明的插件 payload。这样 Manage 仍展示
  // update 入口，而安装器会在真正复制版本时确定性失败，正好覆盖“关联存在但升级源损坏”。
  await rm(fixture.pluginRoot, { force: true, recursive: true });
  await rm(lifecycleManagedPluginRoot(homeDir), {
    force: true,
    recursive: true,
  });
}

export async function corruptLifecycleMarketplaceManifest(
  fixture: PluginLifecycleFixture,
): Promise<void> {
  await writeText(
    join(fixture.marketplaceRoot, ".claude-plugin", "marketplace.json"),
    "{ invalid plugin lifecycle marketplace fixture",
  );
}

function lifecycleManagedPluginRoot(homeDir: string): string {
  return join(
    homeDir,
    ".zcode",
    "cli",
    "plugins",
    "marketplaces",
    PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    "plugins",
    PLUGIN_LIFECYCLE_NAME,
  );
}

export async function createInvalidOfficialCollisionFixture(): Promise<string> {
  const { homeDir } = getE2EAppDataPaths();
  const root = join(homeDir, "fixtures", "plugin-official-name-collision");
  await writeJson(join(root, ".claude-plugin", "marketplace.json"), {
    name: "zcode-plugins-official",
    plugins: [],
  });
  return root;
}

export async function seedInlineLifecyclePlugin(): Promise<string> {
  const { homeDir } = getE2EAppDataPaths();
  const root = join(homeDir, "fixtures", PLUGIN_INLINE_NAME);
  await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
    name: PLUGIN_INLINE_NAME,
    version: "1.0.0",
    description: "E2E inline plugin lifecycle smoke fixture",
    agents: "agents",
    skills: "skills",
  });
  await writeText(
    join(root, "agents", "inline-reviewer.md"),
    [
      "---",
      "name: inline-reviewer",
      "description: E2E inline Plugin reviewer profile",
      "tools:",
      "  - Read",
      "---",
      "",
      "Review the requested files for the inline Plugin fixture.",
    ].join("\n"),
  );
  await writeText(
    join(root, "skills", "inline-lifecycle", "SKILL.md"),
    [
      "---",
      "name: inline-lifecycle",
      "description: E2E inline lifecycle runtime marker",
      "---",
      "",
      "# Inline lifecycle",
      "",
      "E2E_PLUGIN_INLINE_LIFECYCLE_RUNTIME",
    ].join("\n"),
  );

  const configPath = join(homeDir, ".zcode", "cli", "config.json");
  const config = await readJsonRecord(configPath);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  await writeJson(configPath, {
    ...config,
    plugins: {
      ...plugins,
      dirs: [root],
      enabled: true,
      enabledPlugins: { ...enabledPlugins, [PLUGIN_INLINE_ID]: true },
    },
  });
  return root;
}
