import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  HookEventName,
  HookMatcherConfig,
  PluginConfig,
  PluginLoadOutcome,
} from "@zcode/contracts";
import {
  computePluginHookDefinitionDigest,
  createNodePluginAdapter,
  evaluatePluginHookTrust,
  grantPluginHookTrust,
  isFirstPartyPlugin,
  loadPluginHookTrustState,
  resolvePluginHookTrustStorePath,
  revokePluginHookTrust,
  type PluginHookTrustRecord,
} from "./index.js";
import { addMarketplace, installMarketplacePlugin } from "./marketplace.js";

/**
 * Plugin hook trust gate 回归测试（R02）。
 *
 * 核心不变量：
 * - 第三方 marketplace / inline 插件 Hook 默认不进入 PluginLoadOutcome.hooks；
 * - 精确 grant 后同一 discovery 才注册；
 * - version 或 hook definition 变化使旧记录失效；
 * - revoke 立即阻止；
 * - official / official-marketplace 安装产物不受影响；
 * - trust store 损坏 fail closed 且不抛异常。
 */

const SESSION_START_HOOKS: HookMatcherConfig[] = [
  {
    hooks: [{ command: "echo third-party", type: "command" }],
  },
];

async function writePluginManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
  manifestDir = ".zcode-plugin",
): Promise<void> {
  await mkdir(join(pluginRoot, manifestDir), { recursive: true });
  await writeFile(join(pluginRoot, manifestDir, "plugin.json"), JSON.stringify(manifest));
}

async function writeHooksFile(
  pluginRoot: string,
  hooks: Record<string, unknown> = { SessionStart: SESSION_START_HOOKS },
): Promise<void> {
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await writeFile(join(pluginRoot, "hooks", "hooks.json"), JSON.stringify({ hooks }));
}

function baseConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    dirs: [],
    enabled: true,
    enabledPlugins: {},
    extraKnownMarketplaces: {},
    options: {},
    suppressedBuiltins: [],
    ...overrides,
  };
}

function discover(options: {
  config: PluginConfig;
  storageRoot: string;
  officialPluginRoots?: string[];
  workingDirectory: string;
}): Promise<PluginLoadOutcome> {
  return createNodePluginAdapter({ storageRoot: options.storageRoot }).discoverPlugins({
    config: options.config,
    env: {},
    officialPluginRoots: options.officialPluginRoots,
    storageRoot: options.storageRoot,
    workingDirectory: options.workingDirectory,
  });
}

async function writeMarketplaceWorkspace(input: {
  marketplace: string;
  marketplaceRoot: string;
  pluginName: string;
}): Promise<string> {
  const pluginRoot = join(input.marketplaceRoot, "plugins", input.pluginName);
  await mkdir(pluginRoot, { recursive: true });
  // 与 adapters/tests/plugins.test.ts 的 writeMarketplaceManifest 同口径：.claude-plugin/marketplace.json。
  await mkdir(join(input.marketplaceRoot, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(input.marketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: input.marketplace,
      plugins: [{ name: input.pluginName, source: `./plugins/${input.pluginName}` }],
    }),
  );
  return pluginRoot;
}

describe("plugin hook trust gate", () => {
  it("blocks third-party marketplace hooks without a trust record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-untrusted-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "third-party-market";
    const pluginName = "risky-hooks";
    const pluginId = `${pluginName}@${marketplace}`;
    try {
      const marketplaceRoot = join(dir, "marketplace");
      const sourceRoot = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot,
        pluginName,
      });
      await writePluginManifest(
        sourceRoot,
        { hooks: "hooks/hooks.json", name: pluginName },
        ".claude-plugin",
      );
      await writeHooksFile(sourceRoot);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      const outcome = await discover({
        config: baseConfig({ enabledPlugins: { [pluginId]: true } }),
        storageRoot,
        workingDirectory: dir,
      });

      // 注册前拦截：不产生可执行 matcher。
      expect(outcome.hooks).toEqual({});
      const plugin = outcome.plugins.find((candidate) => candidate.id === pluginId);
      expect(plugin?.enabled).toBe(true);
      // 定义仍保留给设置页只读展示，但明确标记不可运行。
      expect(plugin?.hookDetails).toMatchObject([
        { command: "echo third-party", event: "SessionStart", runnable: false, type: "command" },
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("runs the same hook after an explicit trust grant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-granted-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "third-party-market";
    const pluginName = "risky-hooks";
    const pluginId = `${pluginName}@${marketplace}`;
    try {
      const marketplaceRoot = join(dir, "marketplace");
      const sourceRoot = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot,
        pluginName,
      });
      await writePluginManifest(
        sourceRoot,
        { hooks: "hooks/hooks.json", name: pluginName },
        ".claude-plugin",
      );
      await writeHooksFile(sourceRoot);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      const config = baseConfig({ enabledPlugins: { [pluginId]: true } });
      expect((await discover({ config, storageRoot, workingDirectory: dir })).hooks).toEqual({});

      await grantPluginHookTrust({
        events: { SessionStart: SESSION_START_HOOKS },
        pluginId,
        storageRoot,
        version: "0.0.0",
      });

      const after = await discover({ config, storageRoot, workingDirectory: dir });
      expect(after.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
        command: "echo third-party",
        plugin: { id: pluginId },
        type: "command",
      });
      expect(
        after.plugins.find((candidate) => candidate.id === pluginId)?.hookDetails,
      ).toMatchObject([{ runnable: true }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("invalidates trust when the plugin version changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-version-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "third-party-market";
    const pluginName = "risky-hooks";
    const pluginId = `${pluginName}@${marketplace}`;
    const config = baseConfig({ enabledPlugins: { [pluginId]: true } });
    try {
      const firstRoot = join(dir, "marketplace-v1");
      const firstSource = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot: firstRoot,
        pluginName,
      });
      await writePluginManifest(firstSource, {
        hooks: "hooks/hooks.json",
        name: pluginName,
        version: "1.0.0",
      });
      await writeHooksFile(firstSource);
      await addMarketplace({ source: { source: "directory", path: firstRoot }, storageRoot });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      await grantPluginHookTrust({
        events: { SessionStart: SESSION_START_HOOKS },
        pluginId,
        storageRoot,
        version: "1.0.0",
      });
      expect(
        (await discover({ config, storageRoot, workingDirectory: dir })).hooks.SessionStart,
      ).toBeDefined();

      // 同 marketplace + 同插件名，仅 version 变化：记录必须失配。
      const secondRoot = join(dir, "marketplace-v2");
      const secondSource = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot: secondRoot,
        pluginName,
      });
      await writePluginManifest(secondSource, {
        hooks: "hooks/hooks.json",
        name: pluginName,
        version: "2.0.0",
      });
      await writeHooksFile(secondSource);
      await addMarketplace({ source: { source: "directory", path: secondRoot }, storageRoot });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      const outcome = await discover({ config, storageRoot, workingDirectory: dir });
      expect(outcome.hooks).toEqual({});
      expect(
        outcome.plugins.find((candidate) => candidate.id === pluginId)?.hookDetails,
      ).toMatchObject([{ runnable: false }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("invalidates trust when the hook definition changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-definition-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "third-party-market";
    const pluginName = "risky-hooks";
    const pluginId = `${pluginName}@${marketplace}`;
    const config = baseConfig({ enabledPlugins: { [pluginId]: true } });
    try {
      const marketplaceRoot = join(dir, "marketplace");
      const sourceRoot = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot,
        pluginName,
      });
      await writePluginManifest(
        sourceRoot,
        { hooks: "hooks/hooks.json", name: pluginName },
        ".claude-plugin",
      );
      await writeHooksFile(sourceRoot);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      await grantPluginHookTrust({
        events: { SessionStart: SESSION_START_HOOKS },
        pluginId,
        storageRoot,
        version: "0.0.0",
      });
      expect(
        (await discover({ config, storageRoot, workingDirectory: dir })).hooks.SessionStart,
      ).toBeDefined();

      // 原地改写已安装 cache 中的 command，模拟定义被替换。
      const installedRoot = join(storageRoot, "cache", marketplace, pluginName, "0.0.0");
      await writeHooksFile(installedRoot, {
        SessionStart: [{ hooks: [{ command: "echo replaced", type: "command" }] }],
      });

      const outcome = await discover({ config, storageRoot, workingDirectory: dir });
      expect(outcome.hooks).toEqual({});
      expect(
        outcome.plugins.find((candidate) => candidate.id === pluginId)?.hookDetails,
      ).toMatchObject([{ command: "echo replaced", runnable: false }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("blocks the hook again after revoke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-revoke-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "third-party-market";
    const pluginName = "risky-hooks";
    const pluginId = `${pluginName}@${marketplace}`;
    const config = baseConfig({ enabledPlugins: { [pluginId]: true } });
    try {
      const marketplaceRoot = join(dir, "marketplace");
      const sourceRoot = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot,
        pluginName,
      });
      await writePluginManifest(
        sourceRoot,
        { hooks: "hooks/hooks.json", name: pluginName },
        ".claude-plugin",
      );
      await writeHooksFile(sourceRoot);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      await grantPluginHookTrust({
        events: { SessionStart: SESSION_START_HOOKS },
        pluginId,
        storageRoot,
        version: "0.0.0",
      });
      expect(
        (await discover({ config, storageRoot, workingDirectory: dir })).hooks.SessionStart,
      ).toBeDefined();

      await revokePluginHookTrust({ pluginId, storageRoot });

      const outcome = await discover({ config, storageRoot, workingDirectory: dir });
      expect(outcome.hooks).toEqual({});
      expect(loadPluginHookTrustState(storageRoot)).toEqual({ records: [], status: "ok" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps first-party official plugin hooks runnable without any record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-official-"));
    const storageRoot = join(dir, "storage");
    const pluginRoot = join(dir, "bundled-plugin");
    try {
      await writePluginManifest(pluginRoot, { hooks: "hooks/hooks.json", name: "bundled-plugin" });
      await writeHooksFile(pluginRoot);
      const outcome = await discover({
        // official 候选默认停用；显式启用才能验证「first-party 不需信任即可运行」。
        config: baseConfig({
          enabledPlugins: { "bundled-plugin@zcode-plugins-official": true },
        }),
        officialPluginRoots: [pluginRoot],
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
        command: "echo third-party",
        plugin: { id: "bundled-plugin@zcode-plugins-official" },
      });
      expect(outcome.plugins[0]?.hookDetails).toMatchObject([{ runnable: true }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps official marketplace installs runnable without any record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-official-market-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "claude-plugins-official";
    const pluginName = "official-hooked";
    const pluginId = `${pluginName}@${marketplace}`;
    try {
      const marketplaceRoot = join(dir, "marketplace");
      const sourceRoot = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot,
        pluginName,
      });
      await writePluginManifest(
        sourceRoot,
        { hooks: "hooks/hooks.json", name: pluginName },
        ".claude-plugin",
      );
      await writeHooksFile(sourceRoot);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
        trustedId: marketplace,
      });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      const outcome = await discover({
        config: baseConfig({ enabledPlugins: { [pluginId]: true } }),
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.hooks.SessionStart).toBeDefined();
      expect(outcome.plugins[0]?.hookDetails).toMatchObject([{ runnable: true }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not grant implicit trust to inline project plugin directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-inline-"));
    const storageRoot = join(dir, "storage");
    const workingDirectory = join(dir, "workspace");
    const pluginRoot = join(workingDirectory, ".zcode", "plugins", "local-hooked");
    const pluginId = "local-hooked@inline";
    const config = baseConfig({ dirs: [pluginRoot] });
    try {
      // workspace/project 配置通过 plugins.dirs 注入的本地插件：来源是 inline。
      await writePluginManifest(pluginRoot, { hooks: "hooks/hooks.json", name: "local-hooked" });
      await writeHooksFile(pluginRoot);

      const untrusted = await discover({ config, storageRoot, workingDirectory });
      expect(untrusted.plugins[0]?.source).toBe("inline");
      expect(untrusted.hooks).toEqual({});
      expect(untrusted.plugins[0]?.hookDetails).toMatchObject([{ runnable: false }]);
      // inline 不是 first-party，不能借 project scope 获得隐式信任。
      expect(isFirstPartyPlugin({ marketplace: "inline", source: "inline" })).toBe(false);

      await grantPluginHookTrust({
        events: { SessionStart: SESSION_START_HOOKS },
        pluginId,
        storageRoot,
        version: "0.0.0",
      });
      const trusted = await discover({ config, storageRoot, workingDirectory });
      expect(trusted.hooks.SessionStart).toBeDefined();
      expect(trusted.plugins[0]?.hookDetails).toMatchObject([{ runnable: true }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("fails closed when the trust store is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-plugin-hook-trust-corrupt-"));
    const storageRoot = join(dir, "storage");
    const marketplace = "third-party-market";
    const pluginName = "risky-hooks";
    const pluginId = `${pluginName}@${marketplace}`;
    try {
      const marketplaceRoot = join(dir, "marketplace");
      const sourceRoot = await writeMarketplaceWorkspace({
        marketplace,
        marketplaceRoot,
        pluginName,
      });
      await writePluginManifest(
        sourceRoot,
        { hooks: "hooks/hooks.json", name: pluginName },
        ".claude-plugin",
      );
      await writeHooksFile(sourceRoot);
      await addMarketplace({
        source: { source: "directory", path: marketplaceRoot },
        storageRoot,
      });
      await installMarketplacePlugin({ marketplace, name: pluginName, storageRoot });

      await mkdir(join(storageRoot, "security"), { recursive: true });
      await writeFile(resolvePluginHookTrustStorePath(storageRoot), "{not json");

      expect(loadPluginHookTrustState(storageRoot)).toEqual({ records: [], status: "corrupt" });
      const outcome = await discover({
        config: baseConfig({ enabledPlugins: { [pluginId]: true } }),
        storageRoot,
        workingDirectory: dir,
      });
      expect(outcome.hooks).toEqual({});
      expect(
        outcome.plugins.find((candidate) => candidate.id === pluginId)?.hookDetails,
      ).toMatchObject([{ runnable: false }]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("binds the decision to the exact definition digest", () => {
    const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
      SessionStart: SESSION_START_HOOKS,
    };
    const digest = computePluginHookDefinitionDigest({
      events,
      pluginId: "demo@market",
      version: "1.0.0",
    });
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);

    const records: PluginHookTrustRecord[] = [
      {
        decision: "trusted",
        definitionDigest: digest,
        digestAlgorithm: "sha256",
        grantedAt: "2026-11-11T00:00:00.000Z",
        pluginId: "demo@market",
        version: "1.0.0",
      },
    ];

    // 精确命中才放行。
    expect(
      evaluatePluginHookTrust({
        events,
        firstParty: false,
        pluginId: "demo@market",
        state: { records, status: "ok" },
        version: "1.0.0",
      }),
    ).toEqual({ reason: "trusted_exact_match", runnable: true });

    // command 变化 → untrusted（不是 timeout / 重试可以绕过的）。
    expect(
      evaluatePluginHookTrust({
        events: {
          SessionStart: [{ hooks: [{ command: "echo changed", type: "command" }] }],
        },
        firstParty: false,
        pluginId: "demo@market",
        state: { records, status: "ok" },
        version: "1.0.0",
      }),
    ).toEqual({ reason: "untrusted", runnable: false });

    // 版本变化 → untrusted。
    expect(
      evaluatePluginHookTrust({
        events,
        firstParty: false,
        pluginId: "demo@market",
        state: { records, status: "ok" },
        version: "1.0.1",
      }),
    ).toEqual({ reason: "untrusted", runnable: false });

    // 无 Hook 定义不需要信任，也不会因此产生执行面。
    expect(
      evaluatePluginHookTrust({
        events: {},
        firstParty: false,
        pluginId: "demo@market",
        state: { records: [], status: "missing" },
        version: "1.0.0",
      }),
    ).toEqual({ reason: "no_hook_definitions", runnable: true });
  });
});
