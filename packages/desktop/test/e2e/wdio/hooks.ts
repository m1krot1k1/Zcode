import {
  startRequestSecurityFixture,
  stopRequestSecurityFixture,
} from "../helpers/request-security-edition/index.js";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  withE2ESourceEvidence,
  captureWorkspaceSources,
} from "../reporting/e2e-source-evidence.js";
import { runE2EBeforeSessionSetup } from "../helpers/e2e-before-session.js";
import {
  CODING_PLAN_TEAM_MOCK_BASE_URL_ENV,
  CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV,
  shouldReuseDesktopE2EBuild,
} from "../helpers/coding-plan-mock-env.js";
import { installBashPrefixPermissionPnpmShim } from "../helpers/bash-prefix-permission-shim.js";
import {
  installOpenCodeCliE2EFixture,
  E2E_OPENCODE_COMPOSER_TRACE_FILE,
} from "../helpers/open-code-cli-fixture.js";
import {
  applyE2EWorkerModelRetryEnv,
  resolveE2EWorkerChromiumProfileDir,
  replaceChromeUserDataDirArg,
} from "../helpers/e2e-worker-isolation.js";
import { prepareOAuthCompletionRaceFixture } from "../helpers/oauth-completion-race-fixture.js";
import { prepareWebRemoteControlAuthGateFixture } from "../helpers/web-remote-control-auth-gate-fixture.js";
import { prepareAccessToken401Fixture } from "../helpers/access-token-401-fixture.js";
import { withE2EDesktopBuildLock } from "../../../scripts/ensure-e2e-desktop-build.mjs";
import { E2EFailureArtifactCollector } from "../reporting/e2e-failure-artifacts.js";
import { classifyError } from "../reporting/e2e-reporting.js";
import {
  configureZCodeAgentServerEnv,
  prepareDesktopAppBuild,
  prepareZCodeAgentServer,
  stageDesktopE2EAppOutput,
} from "./build.js";
import {
  applyAskUserQuestionClockScaleForWorker,
  applyE2EProviderEnv,
  applySwarmCrashBoundaryEnvForWorker,
  applyUpstreamE2EHttpModeForWorker,
} from "./env.js";
import {
  configureCodingPlanTeamMockForSpecs,
  startCodingPlanTeamMockIfNeeded,
  stopCodingPlanTeamMock,
} from "./mocks-coding-plan-team.js";
import {
  configureHighspeedE2EMock,
  startCodingPlanUpgradeE2EMock,
  startOffPeakE2EMock,
  stopCodingPlanUpgradeE2EMock,
} from "./mocks-coding-plan-upgrade.js";
import {
  startClientScenesE2EMockIfNeeded,
  startDynamicWorkflowConfigE2EMock,
  startModelContextBudgetConfigE2EMock,
  startPluginCdnZipFixtureIfNeeded,
  stopClientScenesE2EMock,
  stopDynamicWorkflowConfigE2EMock,
  stopModelContextBudgetConfigE2EMock,
  stopPluginCdnZipFixture,
} from "./mocks-config.js";
import {
  startCodingPlanDataPlaneProxy,
  startUpstreamE2EHttp,
  stopUpstreamE2EHttp,
} from "./mocks-upstream.js";
import {
  E2E_APP_CREDENTIALS_FILE,
  E2E_APP_SETTINGS_FILE,
  E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS,
  E2E_HOME_DIR,
  E2E_PACKAGED_APP_BINARY_PATH,
  REPO_ROOT,
  isolateOpenCodeInstallE2EEnvironment,
  restoreOpenCodeInstallE2EEnvironment,
} from "./paths.js";
import {
  armCurrentElectronAppQuit,
  armE2ERunnerExitWatchdog,
  cleanupE2EDirectory,
  cleanupE2EElectronProcesses,
  e2eRunnerFinalizationGuard,
} from "./process-lifecycle.js";
import {
  E2E_APP_ENTRY_POINT,
  E2E_APP_OUTPUT_DIR,
  E2E_CHROMIUM_USER_DATA_ROOT_DIR,
  E2E_RUN_CACHE_DIR,
  e2eReporter,
  measureE2ELifecyclePhase,
  runE2EDiagnosticWithTimeout,
} from "./reporters.js";
import { resetE2EHome } from "./seeding-home.js";
import {
  configuredE2ESpecs,
  configuredModelRetryMaxRetries,
  isOpenCodeCliInstallE2E,
  isOpenCodeComposerE2E,
} from "./specs.js";
import { wdioState } from "./state.js";
import { createE2ERendererBridgeRootHooks } from "../helpers/e2e-renderer-bridge-root-hook.js";
import { runE2ERendererBridgePreflight } from "./bridge-preflight.js";

/**
 * Хуки WDIO-сессии. Вынесены из config.ts: порядок и сигнатуры — часть контракта
 * раннера (onPrepare -> onWorkerStart -> beforeSession -> ... -> onComplete).
 */
export function createE2ESessionHooks(config: WebdriverIO.Config): Partial<WebdriverIO.Config> {
  return {
    async onPrepare() {
      try {
        e2eReporter.prepare(configuredE2ESpecs);
        await measureE2ELifecyclePhase("prepare", { specs: configuredE2ESpecs }, async () => {
          await cleanupE2EElectronProcesses("onPrepare");
          await cleanupE2EDirectory("onPrepare", E2E_CHROMIUM_USER_DATA_ROOT_DIR, true);
          // Bug 根因：beforeSession 发生在 WDIO worker 内，而 Electron/ChromeDriver
          // 启动链继承的是 launcher 派生 worker 时的环境。reset mock 若到 worker 才启动，
          // Main -> Host 会继续请求真实 ZCode 域名；因此与 upgrade mock 一样在派发 worker
          // 前启动，并通过环境把同一个动态端口传给 Electron 和测试控制端。
          await startCodingPlanTeamMockIfNeeded(configuredE2ESpecs);
          if (wdioState.codingPlanTeamMockBaseUrl) {
            // WDIO 配置显式提供 runnerEnv 后不会再透传 launcher 的 process.env；必须把
            // onPrepare 分配的动态端口写回 runnerEnv，worker/ChromeDriver/Electron 才会
            // 继承同一个 mock，而不是在 beforeSession 另起一份只有测试代码能访问的服务。
            if (!config.runnerEnv) {
              // Fail fast：runnerEnv 被移除时 Object.assign 到临时对象会静默丢弃端口，
              // 表现为 worker 内 mock 失联，比这里直接失败难排查得多。
              throw new Error(
                "wdio config 缺少 runnerEnv，coding plan reset mock 端口无法透传给 worker",
              );
            }
            Object.assign(config.runnerEnv, {
              [CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]: wdioState.codingPlanTeamMockBaseUrl,
            });
          }
          // Bugfix: Coding Plan webview origin 是 Vite 编译期常量；mock 必须先于
          // build 启动并注入 env，否则 renderer 会 baked 线上官网 origin。
          await startCodingPlanUpgradeE2EMock(configuredE2ESpecs, {
            prepareForBuild: true,
          });
          const codingPlanUpgradeMockBaseUrl =
            process.env[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]?.trim();
          if (codingPlanUpgradeMockBaseUrl) {
            // 正式 Rewards 用例使用自托管网页，不依赖开发者的 localhost:3000 服务。
            if (configuredE2ESpecs.some((spec) => spec.includes("marketing-touch-rewards"))) {
              process.env.VITE_REWARDS_WEBVIEW_ORIGIN = codingPlanUpgradeMockBaseUrl;
            }
            if (!config.runnerEnv) {
              throw new Error(
                "wdio config 缺少 runnerEnv，coding plan upgrade mock 端口无法透传给 worker",
              );
            }
            Object.assign(config.runnerEnv, {
              [CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]: codingPlanUpgradeMockBaseUrl,
            });
          }
          const buildAndStage = async () =>
            withE2EDesktopBuildLock({}, async () => {
              prepareDesktopAppBuild();
              if (!E2E_PACKAGED_APP_BINARY_PATH) await stageDesktopE2EAppOutput();
            });
          // 旧覆盖报告只有路径，不能证明源码版本；复用构建不得追认当前工作树。
          if (process.env.ZCODE_E2E_SOURCE_EVIDENCE === "1") {
            await withE2ESourceEvidence({
              freshBuild: !E2E_PACKAGED_APP_BINARY_PATH && !shouldReuseDesktopE2EBuild(process.env),
              captureSources: () => captureWorkspaceSources(REPO_ROOT),
              build: buildAndStage,
              appOutputDir: E2E_APP_OUTPUT_DIR,
              artifactDir: e2eReporter.artifactDir,
            });
          } else await buildAndStage();
          prepareZCodeAgentServer();
        });
      } catch (error) {
        // 修复原因：WDIO 会把 onPrepare 异常记录成 hook error 后继续派发 worker，
        // 构建失败时会演变成几十个 DevToolsActivePort/bridge timeout 噪音，掩盖真正原因。
        console.error("[e2e] fatal onPrepare failure", error);
        process.exit(1);
      }
    },

    onWorkerStart(cid, _caps, specs) {
      e2eRunnerFinalizationGuard.disarm();
      wdioState.e2eWorkerLifecycleStarts.set(cid, {
        specs,
        startedAt: new Date(),
      });
    },

    async beforeSession(_config, capabilities, specs, cid) {
      // Bugfix: 现有 e2e 会读写 ~/.zcode/v2；如果多个 spec 复用真实 HOME，
      // 上一个 spec 的凭据、最近项目和 localStorage 会串到下一个 spec，
      // 既污染开发者本机数据，也让“首次启动”类断言变得随机。
      // 这里为 e2e 单独准备隔离 HOME，并在每个 session 启动前重置，保证每个 spec 都从干净环境开始。
      // onPrepare 设置的 process.env 不会可靠传进 WDIO worker；Electron 启动前在
      // worker 再清除自定义 Agent 覆盖，确保数据库准备仍走 bundled resolver。
      wdioState.currentE2EWorkerSessionSpecs = specs;
      applyUpstreamE2EHttpModeForWorker(specs);
      applyAskUserQuestionClockScaleForWorker(specs);
      applySwarmCrashBoundaryEnvForWorker(specs);
      applyE2EProviderEnv(specs);
      configureHighspeedE2EMock(specs);
      wdioState.currentE2EBeforeSessionError = null;
      applyE2EWorkerModelRetryEnv(process.env, specs, configuredModelRetryMaxRetries);
      wdioState.currentE2EChromiumUserDataDir = resolveE2EWorkerChromiumProfileDir(
        E2E_CHROMIUM_USER_DATA_ROOT_DIR,
        cid,
      );
      const chromeCapabilities = capabilities as {
        "goog:chromeOptions"?: { args?: string[] };
      };
      const chromeOptions = chromeCapabilities["goog:chromeOptions"] ?? {};
      // 修复原因：所有 worker 复用并反复删除同一个 profile 时，长批次中 Chromium
      // 会留下失效文档，CDP target 仍显示 file://，运行时却漂到 chrome-error://。
      // 在 session 创建前按 cid 注入独立 profile，确保 worker 生命周期互不污染。
      chromeOptions.args = replaceChromeUserDataDirArg(
        chromeOptions.args ?? [],
        wdioState.currentE2EChromiumUserDataDir,
      );
      const storageDiagnostics =
        process.env.ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS === "1" &&
        specs.some((spec) =>
          spec.endsWith("conversation-session-r3-desktop-settings-authority.test.ts"),
        );
      if (
        !E2E_PACKAGED_APP_BINARY_PATH &&
        (storageDiagnostics ||
          specs.some((spec) =>
            /conversation-session-subagent-(context-boundaries|multi-workspace|cross-host)\.test\.ts/.test(
              spec,
            ),
          ))
      ) {
        // ChromeDriver 会清空 NODE_OPTIONS；测试启动文件在正式 Main 导入前设置代理预加载。
        // 文件放在原 Main 旁边，保留 app 路径；正式 Host/CLI resolver 与存储准备均不替换。
        const entry = resolve(E2E_APP_OUTPUT_DIR, "main/subagent-e2e.mjs");
        const proxy = resolve(
          REPO_ROOT,
          storageDiagnostics
            ? "packages/desktop/test/e2e/helpers/storage-worker-diagnostics.mjs"
            : "packages/desktop/test/e2e/helpers/subagent-config-proxy.mjs",
        );
        const preload = `--import=${JSON.stringify(proxy)}`;
        const diagnostics = storageDiagnostics
          ? `process.env.ZCODE_E2E_STORAGE_WORKER_DIAGNOSTICS_DIR = ${JSON.stringify(resolve(e2eReporter.artifactDir, "storage-workers"))};\n`
          : "";
        await writeFile(
          entry,
          `${diagnostics}process.env.NODE_OPTIONS = ${JSON.stringify(preload)};\nawait import(${JSON.stringify(pathToFileURL(E2E_APP_ENTRY_POINT).href)});\n`,
        );
        chromeOptions.args = chromeOptions.args.map((arg) =>
          arg.startsWith("--app=") ? `--app=${entry}` : arg,
        );
      }
      chromeCapabilities["goog:chromeOptions"] = chromeOptions;
      try {
        await measureE2ELifecyclePhase("before-session", { cid, specs }, async () => {
          // 修复原因：worker 在 WebDriver session 创建前失败时不会可靠进入 afterSession；
          // 下一个 worker 必须先按本轮 run id 清理残留 Electron/host，不能让旧 target
          // 继续污染新的 launcher session。
          await cleanupE2EElectronProcesses("beforeSession-start", {
            requireExit: true,
          });
          // 原因：onPrepare 与 Electron launcher 不在同一进程，动态端口只能在
          // worker 的 beforeSession 中注入，才会被 Main -> Host 环境链继承。
          await startModelContextBudgetConfigE2EMock(specs);
          // 动态工作流灰度同样只能在 worker 的 beforeSession 注入动态端口，Main -> Host 的
          // 环境链才会继承到 case-local 的 /client/configs 网关。
          await startDynamicWorkflowConfigE2EMock(specs);
          // 此 SSH 用例验证会话归属；在 Electron 启动前设置开启前置，避免把本机 mock 的 loopback 交给远端。
          if (specs.some((spec) => spec.endsWith("conversation-session-r3-subagent.test.ts"))) {
            process.env.ZCODE_DYNAMIC_WORKFLOW_MODE = "alwaysOn";
          }
          await runE2EBeforeSessionSetup({
            cid,
            specs,
            configureAgentServerEnv: configureZCodeAgentServerEnv,
            configureCodingPlanTeamMockForSpecs,
            recordBeforeSession: e2eReporter.beforeSession,
            resetHome: resetE2EHome,
            startCodingPlanTeamMockIfNeeded,
            startCodingPlanUpgradeMockIfNeeded: startCodingPlanUpgradeE2EMock,
            startUpstreamHttpIfNeeded: startUpstreamE2EHttp,
            startCodingPlanDataPlaneProxyIfNeeded: startCodingPlanDataPlaneProxy,
            startPluginCdnZipFixtureIfNeeded,
            startOffPeakMockIfNeeded: startOffPeakE2EMock,
          });
          if (isOpenCodeComposerE2E(specs)) {
            if (process.platform !== "win32") {
              const currentSettings = JSON.parse(
                await readFile(E2E_APP_SETTINGS_FILE, "utf8").catch(() => "{}"),
              ) as Record<string, unknown>;
              // 本用例不得触达 ZCode production；意外后台请求也只能指向无法解析的 .invalid 域名。
              await writeFile(
                E2E_APP_SETTINGS_FILE,
                JSON.stringify({
                  ...currentSettings,
                  openCodeCliEnabled: true,
                  zcodeEndpointOrigin: "https://zcode-e2e.invalid",
                }),
                "utf8",
              );
              const cliBin = await installOpenCodeCliE2EFixture(
                E2E_HOME_DIR,
                resolve(
                  process.env.ZCODE_E2E_ARTIFACT_DIR ?? resolve(process.cwd(), ".e2e-artifacts"),
                  E2E_OPENCODE_COMPOSER_TRACE_FILE,
                ),
              );
              // 修复原因：Electron 在 macOS 上会重建 PATH，worker 里删掉 Homebrew 也到不了 Host。
              // 绝对路径随环境变量进入 Host，resolver 不再先命中 /opt/homebrew/bin/opencode。
              process.env.ZCODE_E2E_OPENCODE_CLI_PATH = resolve(cliBin, "opencode");
            }
          }
          if (isOpenCodeCliInstallE2E(specs)) {
            if (process.platform === "darwin") {
              const currentSettings = JSON.parse(
                await readFile(E2E_APP_SETTINGS_FILE, "utf8").catch(() => "{}"),
              ) as Record<string, unknown>;
              // 安装 smoke 只能访问隔离配置/数据目录，绝不能复用开发者的 OpenCode 登录态。
              await writeFile(
                E2E_APP_SETTINGS_FILE,
                JSON.stringify({
                  ...currentSettings,
                  openCodeCliEnabled: false,
                  zcodeEndpointOrigin: "https://zcode-e2e.invalid",
                }),
                "utf8",
              );
              isolateOpenCodeInstallE2EEnvironment();
            }
          }
          // Client Scenes 是布局 case 的远端目录依赖；必须在 resetHome 完成、Electron
          // 启动前覆盖 endpoint，确保 Main → Host 首次 import 时拿到 case-local fixture。
          await startClientScenesE2EMockIfNeeded(specs);
          await startRequestSecurityFixture(specs, E2E_HOME_DIR);
          wdioState.stopOAuthCompletionRaceFixture = await prepareOAuthCompletionRaceFixture(specs);
          wdioState.stopAccessToken401Fixture = await prepareAccessToken401Fixture({
            specs,
            credentialsFile: E2E_APP_CREDENTIALS_FILE,
            settingsFile: E2E_APP_SETTINGS_FILE,
          });
          wdioState.stopWebRemoteControlAuthGateFixture =
            await prepareWebRemoteControlAuthGateFixture({
              specs,
              credentialsFile: E2E_APP_CREDENTIALS_FILE,
              settingsFile: E2E_APP_SETTINGS_FILE,
              workspacePath: resolve(E2E_HOME_DIR, "ZCodeProject"),
            });
          // resetHome 之后、Electron 启动之前安装，Main -> Host -> Agent 才会同时继承
          // case-owned PATH；其他 spec 由 helper 保持 no-op。
          await installBashPrefixPermissionPnpmShim({
            environment: process.env,
            homeDir: E2E_HOME_DIR,
            specs,
          });
        });
      } catch (error) {
        // Bug 根因：WDIO executeHooksWithArgs 会吞掉 beforeSession rejection；保存原始
        // 失败并交给 Mocha root hook 抛出，确保产品 test body 不在残缺环境里继续跑。
        wdioState.currentE2EBeforeSessionError =
          error ?? new Error("beforeSession setup rejected without an error value");
      }
    },

    async before(_capabilities, specs) {
      // Bug 根因：WDIO 将项目与 wdio-electron-service 的 before hooks 放进 Promise.all；
      // 这里发 renderer/CDP 命令会与 service 的 ContextId、Puppeteer 和窗口初始化竞态。
      // before 只保存 worker 归属，browser 命令统一延后到 Mocha root hook 时序屏障。
      wdioState.currentE2EWorkerSpecs = specs;
    },

    async beforeTest(test) {
      // 修复原因：当前 Electron runner 的 before hook 阶段 `browser.electron`
      // 还没注入；等到 beforeTest 再启动采样，才能持续调用 electron.execute。
      await e2eReporter.startUICoverage(browser);
      await e2eReporter.startProcessSampling(browser, wdioState.currentE2EWorkerSpecs);
      wdioState.e2eFailureArtifacts ??= new E2EFailureArtifactCollector({
        artifactDir: e2eReporter.artifactDir,
        browser,
      });
      try {
        await wdioState.e2eFailureArtifacts.start(test);
      } catch (error) {
        // 修复原因：诊断产物的初始化失败不能让 beforeTest 变成新的 E2E 失败根因。
        console.warn("[e2e] failure artifact collection could not start", error);
      }
    },

    async beforeCommand(commandName) {
      if (commandName !== "refresh") {
        return;
      }
      try {
        // 修复原因：renderer 刷新会重建 globalThis.__coverage__；必须在页面销毁前
        // 合并本轮 counter，否则刷新前已走过的交互会从 suite 覆盖率中消失。
        await e2eReporter.snapshotUICoverage();
      } catch (error) {
        console.warn("[e2e-coverage] renderer pre-refresh snapshot failed", error);
      }
    },

    async after(_result, _capabilities, specs) {
      await measureE2ELifecyclePhase("after", { specs }, async () => {
        try {
          await e2eReporter.stopProcessSampling(browser, specs);
          await e2eReporter.stopUICoverage();
        } finally {
          // 先让 ChromeDriver 正常关闭 renderer；同进程的 closed 监听再触发
          // app.quit，afterSession 最后验证整个进程树已经退出。
          await armCurrentElectronAppQuit("after");
          wdioState.currentE2EWorkerSpecs = [];
        }
      });
    },

    async afterSession() {
      await measureE2ELifecyclePhase(
        "after-session",
        { specs: wdioState.currentE2EWorkerSessionSpecs },
        async () => {
          try {
            await cleanupE2EElectronProcesses("afterSession", {
              requireExit: true,
              waitForGracefulExit: true,
            });
            if (wdioState.currentE2EChromiumUserDataDir) {
              await cleanupE2EDirectory(
                "afterSession",
                wdioState.currentE2EChromiumUserDataDir,
                true,
              );
            }
            // Electron/Host/CLI 都已退出，V8 JSON 此时完整封口；趁下一 worker 启动前
            // 就地归一化，避免全量 manual-review 把重复 source map 累积到磁盘上限。
            e2eReporter.compactNodeCoverage();
          } finally {
            delete process.env.ZCODE_E2E_OPENCODE_CLI_PATH;
            delete process.env.ZCODE_E2E_OPENCODE_PORT;
            delete process.env.ZCODE_E2E_OPENCODE_MODEL_ID;
            delete process.env.ZCODE_E2E_OPENCODE_REPLY;
            delete process.env.ZCODE_E2E_OPENCODE_TRACE_PATH;
            restoreOpenCodeInstallE2EEnvironment();
            await stopRequestSecurityFixture();
            await stopModelContextBudgetConfigE2EMock();
            await stopDynamicWorkflowConfigE2EMock();
            wdioState.currentE2EElectronAppPid = null;
            await wdioState.stopOAuthCompletionRaceFixture?.();
            wdioState.stopOAuthCompletionRaceFixture = null;
            await wdioState.stopWebRemoteControlAuthGateFixture?.();
            wdioState.stopWebRemoteControlAuthGateFixture = null;
            await wdioState.stopAccessToken401Fixture?.();
            wdioState.stopAccessToken401Fixture = null;
            wdioState.currentE2EBeforeSessionError = null;
            wdioState.e2eFailureArtifacts = null;
            wdioState.currentE2EWorkerSessionSpecs = [];
            wdioState.currentE2EChromiumUserDataDir = null;
          }
        },
      );
    },

    onWorkerEnd(cid, exitCode, specs) {
      e2eRunnerFinalizationGuard.arm();
      const workerLifecycle = wdioState.e2eWorkerLifecycleStarts.get(cid);
      if (!workerLifecycle) {
        return;
      }
      wdioState.e2eWorkerLifecycleStarts.delete(cid);
      const completedAt = new Date();
      e2eReporter.recordLifecycleEvent({
        cid,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - workerLifecycle.startedAt.getTime(),
        error: exitCode === 0 ? undefined : `worker exited with code ${exitCode}`,
        phase: "worker",
        specs: specs.length > 0 ? specs : workerLifecycle.specs,
        startedAt: workerLifecycle.startedAt.toISOString(),
        status: exitCode === 0 ? "passed" : "failed",
      });
    },

    async afterTest(test, _context, result) {
      let failureArtifacts;
      const collectionErrors: string[] = [];
      try {
        // Mocha suite after 里的 clearAppData 会先退出 Electron；afterTest 是读取
        // renderer coverage 的最后稳定时机，WDIO after 只保留失败兜底。
        await e2eReporter.stopUICoverage();
      } catch (error) {
        console.warn("[e2e-coverage] renderer snapshot failed", error);
        collectionErrors.push(
          `renderer coverage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        failureArtifacts = await runE2EDiagnosticWithTimeout(
          async () =>
            wdioState.e2eFailureArtifacts?.complete(test, {
              ...result,
              errorCategory: result.passed
                ? undefined
                : classifyError(
                    result.error instanceof Error
                      ? result.error.message
                      : String(result.error ?? ""),
                  ),
            }),
          E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS,
          "E2E failure artifact collection",
        );
      } catch (error) {
        // 修复原因：失败证据采集属于诊断补充，采集器自身异常不能掩盖原始 E2E 失败。
        console.warn("[e2e] failure artifact collection failed", error);
        collectionErrors.push(
          `failure artifacts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      e2eReporter.recordTestResult(test, result, failureArtifacts, collectionErrors);
    },

    async onComplete(exitCode) {
      e2eRunnerFinalizationGuard.disarm();
      let onCompleteError: unknown;
      try {
        await measureE2ELifecyclePhase("complete", { specs: configuredE2ESpecs }, async () => {
          try {
            await stopUpstreamE2EHttp();
            await stopCodingPlanTeamMock();
            await stopCodingPlanUpgradeE2EMock();
            await stopRequestSecurityFixture();
            await stopModelContextBudgetConfigE2EMock();
            await stopDynamicWorkflowConfigE2EMock();
            await stopClientScenesE2EMock();
            await wdioState.stopOAuthCompletionRaceFixture?.();
            wdioState.stopOAuthCompletionRaceFixture = null;
            await wdioState.stopWebRemoteControlAuthGateFixture?.();
            wdioState.stopWebRemoteControlAuthGateFixture = null;
            await wdioState.stopAccessToken401Fixture?.();
            wdioState.stopAccessToken401Fixture = null;
            await stopPluginCdnZipFixture();
          } finally {
            await cleanupE2EElectronProcesses("onComplete");
            // 修复原因：逐 worker 删除同一 app data 会重复支付 SQLite 锁重试；下一
            // beforeSession 已负责重置，最后一个 worker 的 HOME 在全部进程退出后统一删除。
            // 失败保留诊断现场：批次 runner（run.mjs）注入 ZCODE_E2E_KEEP_HOME_ON_FAIL=1 时，
            // 失败 run 保留 HOME（setting.json/credentials/db 是失败定性的关键证据，
            // r3-rerun §49 曾因 home 被删只能从 run.log 反推 settings）。PASS 行为不变。
            if (exitCode !== 0 && process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL === "1") {
              console.warn(`[e2e] keeping failure home for diagnosis: ${E2E_HOME_DIR}`);
            } else {
              await cleanupE2EDirectory("onComplete-home", E2E_HOME_DIR, true);
            }
            await cleanupE2EDirectory("onComplete", E2E_RUN_CACHE_DIR);
          }
        });
      } catch (error) {
        onCompleteError = error;
      } finally {
        e2eReporter.writeSummary(exitCode);
        armE2ERunnerExitWatchdog(exitCode);
      }
      if (onCompleteError) {
        throw onCompleteError;
      }
    },
  };
}

/**
 * Mocha root hook: renderer preflight должен падать как hook failure, иначе
 * отклонённый beforeSession не остановит продуктовый test body.
 */
export function createE2EMochaRootHooks() {
  return createE2ERendererBridgeRootHooks(
    async () => {
      await measureE2ELifecyclePhase(
        "before-suite",
        { specs: wdioState.currentE2EWorkerSpecs },
        async () => {
          await runE2ERendererBridgePreflight(wdioState.currentE2EWorkerSpecs);
        },
      );
    },
    () => wdioState.currentE2EBeforeSessionError,
  );
}
