import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PROJECT_UPGRADE_ORDER_SPEC,
  seedProjectUpgradeOrderFixture,
} from "../helpers/project-upgrade-order-fixture.js";
import { installHookTrustFixture } from "../helpers/hook-trust-fixture.js";
import { installHooksLifecycleFixture } from "../helpers/hooks-lifecycle-fixture.js";
import { installStopToolResultsFixture } from "../helpers/stop-tool-results-fixture.js";
import { workerSpecsContain } from "../helpers/e2e-worker-isolation.js";
import { createE2EStartupCredentialSeed } from "../helpers/e2e-startup-credentials.js";
import { seedRemoteOnboardingFixture } from "../helpers/remote-startup-profile.js";
import { BIGMODEL_PROVIDER_ID } from "@zcode/shared";
import { DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY } from "../helpers/network-capture-proxy.js";
import {
  shouldUsePluginCdnZipMarketplaceFixture,
  seedPluginCdnZipMarketplaceFixture,
  resolvePluginCdnZipMarketplaceLastUpdated,
} from "../helpers/plugin-cdn-zip-marketplace.js";
import { seedProviderReadinessHistoryFixture } from "../helpers/provider-readiness-history-fixture.js";
import {
  SMALL_AGENT_WARMUP_SCENARIO,
  PASSIVE_AGENT_STARTUP_SCENARIO,
  seedPassiveAgentStartupWorkspaces,
} from "../helpers/passive-agent-startup-fixture.js";
import { seedSessionHistoryFirstFixture } from "../helpers/session-history-first-fixture.js";
import { seedTaskIndexRowAuthorityFixture } from "../helpers/task-list-row-authority-fixture.js";
import { seedTaskTitleMarqueeFixture } from "../helpers/task-title-marquee-fixture.js";
import { seedAppUsageE2EFixture } from "../helpers/usage-stats-app-usage-fixture.js";
import {
  E2E_AUTH_PROVIDER_ID,
  E2E_AUTH_TOKEN,
  E2E_USER_PROFILE,
  e2eProviderPreset,
  readE2EThoughtLevel,
} from "./env.js";
import { shouldUseCodingPlanTeamMock } from "./mocks-coding-plan-team.js";
import {
  DESKTOP_DIR,
  E2E_APP_CONFIG_DIR,
  E2E_APP_CREDENTIALS_FILE,
  E2E_APP_SETTINGS_FILE,
  E2E_HOME_DIR,
  E2E_HOME_REMOVE_RETRY_DELAYS_MS,
  E2E_STORAGE_ROOT,
  ZCODE_CLI_ENTRYPOINT,
} from "./paths.js";
import { cleanupE2EElectronProcesses, delay } from "./process-lifecycle.js";
import { seedE2EModelConfig, seedE2EWorkerModelStreamConfig } from "./seeding-models.js";
import {
  resolvePluginMcpSkillState,
  seedE2EBuiltinWorkspacePluginDisable,
  seedE2EPluginMcpSkillState,
  seedE2EWorkspacePluginState,
} from "./seeding-plugins.js";
import {
  createCorruptOAuthCredentialSeed,
  createExpiredJwtOAuthCredentialSeed,
  isCodingPlanUpgradeE2E,
  isJwtExpiryReauthenticationSpec,
  isOAuthCredentialRecoverySpec,
  isSubagentCodingPlanLoginCatalogStaleSpec,
  seedE2EGitReviewEntryWorkspace,
  shouldSeedGuideInteractionBehavior,
  usesGitReviewEntryFixture,
  usesProviderReadinessColdStartFixture,
  usesTaskIndexRowAuthorityFixture,
} from "./seeding-spec-fixtures.js";
import {
  isBuiltInSubagentModelSelectionOverridesSpec,
  seedE2EBuiltInSubagentModelOverrides,
  seedE2ESubagentProfiles,
} from "./seeding-subagents.js";
import {
  AGENT_WARMUP_FIXTURE_SPECS,
  GIT_COMMIT_DIALOG_UI_FLOW_SPEC,
  HOOKS_LIFECYCLE_SPEC,
  HOOK_TRUST_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
  SMALL_AGENT_WARMUP_SPECS,
  TASK_TITLE_MARQUEE_SPEC,
} from "./specs.js";
import { wdioState } from "./state.js";

export async function resetE2EHome(specs: string[] = []) {
  await removeE2EHomeWithRetry();
  mkdirSync(E2E_HOME_DIR, { recursive: true });
  seedE2EStartupState(specs);
  await seedRemoteOnboardingFixture({
    // 营销弹窗会抢占首次引导的焦点；该套件从已完成引导的账号开始，独立验证弹窗交付。
    enabled:
      process.env.ZCODE_E2E_REMOTE_PROFILE === "1" ||
      specs.some((spec) => spec.endsWith("ui-shell/marketing-touch-delivery.test.ts")),
    specs,
    appConfigDir: E2E_APP_CONFIG_DIR,
    userId: E2E_USER_PROFILE.id,
  });
  if (workerSpecsContain(specs, PROJECT_UPGRADE_ORDER_SPEC)) {
    await seedProjectUpgradeOrderFixture(E2E_HOME_DIR, E2E_APP_SETTINGS_FILE);
  }
  if (usesProviderReadinessColdStartFixture(specs) || usesGitReviewEntryFixture(specs)) {
    // SP13 必须在 Host 打开 tasks-index 前同时预置真实 task row 与可打开的
    // CLI session；测试内临时注入会绕过 Header 与 status panel 的真实 task/service 解析链路。
    await seedProviderReadinessHistoryFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (usesTaskIndexRowAuthorityFixture(specs)) {
    // Bug 根因：TSL23 必须在 Host 打开 tasks-index 前制造“持久行多于 session 摘要”的冷启动状态；
    // spec 的 before hook 已经太晚，因此只对该 case 在 beforeSession 的隔离 HOME 中落盘。
    await seedTaskIndexRowAuthorityFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (specs.some((spec) => spec.includes(TASK_TITLE_MARQUEE_SPEC))) {
    await seedTaskTitleMarqueeFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  if (specs.some((spec) => spec.includes("usage-stats-app-usage.test.ts"))) {
    await seedAppUsageE2EFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
    });
  }
  seedE2EWorkerModelStreamConfig(specs);
  await seedE2EModelConfig(specs);
  seedE2EPluginCdnZipMarketplace(specs);
  seedE2EPluginMcpSkillInstalledPlugins(specs);
  seedE2EPluginMcpSkillState(specs);
  seedE2EWorkspacePluginState(specs);
  seedE2EBuiltinWorkspacePluginDisable(specs);
  seedE2EBuiltInSubagentModelOverrides(specs);
  seedE2ESubagentProfiles(specs);
  await seedE2EGitReviewEntryWorkspace(specs);
  seedE2EGitCommitDialogWorkspace(specs);
  if (specs.some((spec) => spec.includes("conversation-session-history-first.test.ts"))) {
    await seedSessionHistoryFirstFixture({
      cliEntryPoint: ZCODE_CLI_ENTRYPOINT,
      e2eHomeDir: E2E_HOME_DIR,
      workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
      providerId: e2eProviderPreset.providerId,
      modelId: e2eProviderPreset.model,
      thoughtLevel: readE2EThoughtLevel(),
    });
  }
  if (specs.some((spec) => spec.includes(HOOKS_LIFECYCLE_SPEC))) {
    // Bug 根因：spec 的 before hook 运行时 app-server 已经读取过 workspace config；
    // 测试内再写 Hooks 只能改变设置页，无法改变本轮 agent runtime。case-local fixture
    // 必须在 beforeSession 的干净 HOME 阶段落盘，确保首个 agent 进程冷启动即加载。
    await installHooksLifecycleFixture();
  }
  if (workerSpecsContain(specs, "conversation-session-stop-tool-results.test.ts")) {
    // Stop 复现的 Hook 必须在 app-server 首次读配置前落盘；spec.before 已晚于预热。
    await installStopToolResultsFixture();
  }
  if (specs.some((spec) => spec.includes(HOOK_TRUST_SPEC))) {
    // 同上：workspace 级 hook trust fixture 必须在首个 agent 进程冷启动前落盘，
    // 否则 SessionStart 软门禁不会在首轮 turn 生效（HK05 的 pending banner 前提）。
    await installHookTrustFixture();
  }
}

async function removeE2EHomeWithRetry() {
  for (let attempt = 0; attempt <= E2E_HOME_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rm(E2E_HOME_DIR, {
        force: true,
        maxRetries: process.platform === "win32" ? 3 : 1,
        recursive: true,
        retryDelay: 500,
      });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === E2E_HOME_REMOVE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      // 修复原因：Windows 会短暂保留 SQLite WAL/SHM 文件句柄；先兜底清掉遗留 Electron/host，
      // 再退避重试，避免 beforeSession 因上一轮 app 退出慢而重置失败。
      await cleanupE2EElectronProcesses(`beforeSession-remove-home-attempt-${attempt + 1}`);
      await delay(E2E_HOME_REMOVE_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

function isRetryableRemoveError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["EBUSY", "ENOTEMPTY", "EPERM"].includes(String((error as { code?: unknown }).code)),
  );
}

function seedE2EPluginCdnZipMarketplace(specs: string[] = []) {
  if (!shouldUsePluginCdnZipMarketplaceFixture(specs)) {
    return;
  }
  if (!wdioState.pluginCdnZipFixtureServer) {
    throw new Error("Plugin CDN zip fixture server must start before seeding marketplace");
  }
  seedPluginCdnZipMarketplaceFixture({
    e2eHomeDir: E2E_HOME_DIR,
    server: wdioState.pluginCdnZipFixtureServer,
    lastUpdated: resolvePluginCdnZipMarketplaceLastUpdated(specs),
  });
}

// 把插件 MCP skill lifecycle spec 需要的 installed_plugins.json 写到
// `~/.zcode/cli/plugins/installed_plugins.json`；仅在 spec 命中且 state != not-installed
// 时执行。注意 storageRoot 在 agent 视角是 `<home>/.zcode`，而 pluginStorageRoot
// 是 `<home>/.zcode/cli/plugins`，installed_plugins.json 必须落在后者下面才会被
// bootstrap 的 `listInstalledPluginRecords(pluginStorageRoot)` 读到（见
// `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:347`）。
function seedE2EPluginMcpSkillInstalledPlugins(specs: string[] = []) {
  const state = resolvePluginMcpSkillState(specs);
  if (!state || state === "not-installed" || state === "workspace-root") return;
  const templateName =
    state === "installed-enabled"
      ? "installed-plugins.enabled.template.json"
      : "installed-plugins.disabled.template.json";
  const fixturePath = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill", templateName);
  const pluginRoot = resolve(DESKTOP_DIR, "test/e2e/fixtures/plugin-mcp-skill/e2e-plugin-mcp-ping");
  const template = readFileSync(fixturePath, "utf-8").replaceAll("__INSTALL_PATH__", pluginRoot);
  // pluginStorageRoot = <home>/.zcode/cli/plugins
  const targetDir = resolve(E2E_STORAGE_ROOT, "cli/plugins");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(resolve(targetDir, "installed_plugins.json"), template, "utf-8");
}

function shouldSeedGitCommitDialogWorkspace(specs: string[] = []) {
  return specs.some((spec) => spec.includes(GIT_COMMIT_DIALOG_UI_FLOW_SPEC));
}

function seedE2EGitCommitDialogWorkspace(specs: string[] = []) {
  if (!shouldSeedGitCommitDialogWorkspace(specs)) {
    return;
  }

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  mkdirSync(resolve(workspacePath, "src"), { recursive: true });
  writeFileSync(resolve(workspacePath, "README.md"), "Git commit dialog E2E workspace\n", "utf-8");
  runGitE2ECommand(workspacePath, ["init"]);
  runGitE2ECommand(workspacePath, ["checkout", "-B", "main"]);
  runGitE2ECommand(workspacePath, ["config", "user.name", "ZCode E2E"]);
  runGitE2ECommand(workspacePath, ["config", "user.email", "zcode-e2e@example.com"]);
  runGitE2ECommand(workspacePath, ["add", "README.md"]);
  runGitE2ECommand(workspacePath, ["commit", "-m", "chore: seed git commit dialog e2e"]);
  runGitE2ECommand(workspacePath, ["branch", "e2e-target"]);

  writeFileSync(
    resolve(workspacePath, "src/staged-file.ts"),
    "export const stagedGitCommitDialogE2E = true;\n",
    "utf-8",
  );
  writeFileSync(
    resolve(workspacePath, "src/unstaged-file.ts"),
    "export const unstagedGitCommitDialogE2E = true;\n",
    "utf-8",
  );
  runGitE2ECommand(workspacePath, ["add", "src/staged-file.ts"]);
}

function runGitE2ECommand(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: process.env,
    stdio: "ignore",
  });
}

function seedE2EStartupState(specs: string[] = []) {
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  const useFreshConversationWorkspace = specs.some((spec) =>
    spec.includes("conversation-session-conversation-workspace.test.ts"),
  );
  const legacyDefaultProjectPath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const agentWarmupFixture = AGENT_WARMUP_FIXTURE_SPECS.some((marker) =>
    workerSpecsContain(specs, marker),
  );
  const agentWarmupScenario = SMALL_AGENT_WARMUP_SPECS.some((marker) =>
    workerSpecsContain(specs, marker),
  )
    ? SMALL_AGENT_WARMUP_SCENARIO
    : PASSIVE_AGENT_STARTUP_SCENARIO;
  const modelProviderRegressionFixture = workerSpecsContain(
    specs,
    MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
  );
  const passiveWorkspacePaths = agentWarmupFixture
    ? seedPassiveAgentStartupWorkspaces(E2E_HOME_DIR, agentWarmupScenario.workspaceCount)
    : [];
  if (modelProviderRegressionFixture) {
    // 模型回归缺口 spec 既需要 dormant workspace 切换，也需要 legacy 默认工作区
    // 供 provider/replay helper 初始化；两者都放进同一份 lastWorkspaceSession，避免
    // 测试直接绕过用户可见的侧栏入口注入 workspace。
    mkdirSync(legacyDefaultProjectPath, { recursive: true });
  }
  if (!useFreshConversationWorkspace && !agentWarmupFixture) {
    // 既有 E2E 大量以一个已打开项目为前置；产品首次启动已改为 conversation，
    // 测试基线显式 seed 项目会话，避免把“老 case 的 fixture”误当成新用户默认行为。
    mkdirSync(legacyDefaultProjectPath, { recursive: true });
  }
  const now = Date.now();
  const codingPlanTeamSpec = shouldUseCodingPlanTeamMock(specs);
  const codingPlanUpgradeE2E = isCodingPlanUpgradeE2E(specs);
  const oauthCredentialRecoverySpec = isOAuthCredentialRecoverySpec(specs);
  const jwtExpiryReauthenticationSpec = isJwtExpiryReauthenticationSpec(specs);
  const subagentLoginCatalogStaleSpec = isSubagentCodingPlanLoginCatalogStaleSpec(specs);
  const builtInSubagentModelOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const providerReadinessColdStartFixture = usesProviderReadinessColdStartFixture(specs);
  const shouldUseBigmodelAuth = codingPlanTeamSpec || codingPlanUpgradeE2E;
  const authProviderId = shouldUseBigmodelAuth ? BIGMODEL_PROVIDER_ID : E2E_AUTH_PROVIDER_ID;
  writeFileSync(
    E2E_APP_SETTINGS_FILE,
    JSON.stringify(
      {
        providerFamilyDomain: shouldUseBigmodelAuth ? "bigmodel" : "zai",
        providerFamilyDomainMigrated: true,
        providerFamilyDomainUpdatedAt: now,
        ...(modelProviderRegressionFixture
          ? {
              recentProjects: [legacyDefaultProjectPath, ...passiveWorkspacePaths],
              lastWorkspaceSession: [legacyDefaultProjectPath, ...passiveWorkspacePaths].map(
                (workspacePath) => ({
                  kind: "local" as const,
                  workspacePath,
                  workspacePurpose: "project" as const,
                }),
              ),
              lastActiveTabIndex: 0,
            }
          : agentWarmupFixture
            ? {
                recentProjects: passiveWorkspacePaths,
                lastWorkspaceSession: passiveWorkspacePaths.map((workspacePath) => ({
                  kind: "local" as const,
                  workspacePath,
                  workspacePurpose: "project" as const,
                })),
                lastActiveTabIndex: agentWarmupScenario.activeWorkspaceIndex,
              }
            : !useFreshConversationWorkspace
              ? {
                  lastWorkspaceSession: [
                    {
                      kind: "local",
                      workspacePath: legacyDefaultProjectPath,
                      workspacePurpose: "project",
                    },
                  ],
                  lastActiveTabIndex: 0,
                }
              : {}),
        ...(shouldSeedGuideInteractionBehavior(specs)
          ? {
              // steer 相关复现需要从当前 worker 的初始 settings 进入 guide 模式；
              // 运行中再改 setting.json 会被 app 启动态写回覆盖，导致实际仍跑 queue。
              zcodeInteractionBehavior: "guide",
            }
          : {}),
        providerFamilyConnectionSelections: shouldUseBigmodelAuth
          ? { bigmodel: { kind: "individual-coding-plan" } }
          : {},
        ...(wdioState.upstreamCaptureProxy
          ? {
              // 修复原因：agent 子进程只信任设置页显式代理配置，不读取
              // WDIO 进程里的标准 HTTPS_PROXY；capture 模式必须预设这里才能抓到真实请求。
              httpProxy: wdioState.upstreamCaptureProxy.proxyUrl,
              httpProxyCaCertPath: wdioState.upstreamCaptureProxy.caCertPath,
              httpProxyNoProxy: DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
            }
          : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(
    E2E_APP_CREDENTIALS_FILE,
    JSON.stringify(
      // 原因：匿名回调失败用例不需要假 JWT；401 过期确认层会遮挡被测登录入口。
      providerReadinessColdStartFixture ||
        workerSpecsContain(specs, "oauth-login-failure-cancel.test.ts")
        ? {}
        : // Bug 根因：I20 不验证账号登录，却播种假 ZCode JWT；带账号身份的旁路请求
          // 会把它发往真实控制面，401 随后弹出登录过期对话框并遮挡目标交互。
          // 该 case 只保留本地 Provider 回放，不注入无关账号身份。
          builtInSubagentModelOverridesSpec
          ? {}
          : subagentLoginCatalogStaleSpec
            ? {}
            : oauthCredentialRecoverySpec
              ? createCorruptOAuthCredentialSeed(authProviderId)
              : jwtExpiryReauthenticationSpec
                ? createExpiredJwtOAuthCredentialSeed(authProviderId)
                : createE2EStartupCredentialSeed({
                    specs,
                    accountMock: codingPlanTeamSpec || codingPlanUpgradeE2E,
                    remoteProfile: process.env.ZCODE_E2E_REMOTE_PROFILE === "1",
                    legacyAuthToken: E2E_AUTH_TOKEN,
                    restoredOAuthCredentials: {
                      "oauth:active_provider": authProviderId,
                      // 账号 mock 只覆盖选定族；夹带另一个假账号会访问未接管的真实控制面。
                      [`oauth:${authProviderId}:access_token`]: shouldUseBigmodelAuth
                        ? "e2e-bigmodel-oauth-token"
                        : E2E_AUTH_TOKEN,
                      [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
                      zcodejwttoken: E2E_AUTH_TOKEN,
                    },
                  }),
      null,
      2,
    ),
    "utf-8",
  );
}
