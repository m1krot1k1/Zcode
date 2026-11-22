import {
  requestSecurityWorkerEnv,
  requestSecuritySpecTimeout,
} from "../helpers/request-security-edition/index.js";
import { resolve } from "node:path";
import { getE2EProviderEndpointEnv } from "#e2e/helpers/e2e-provider-endpoint";
import { createCapabilities } from "./capabilities.js";
import { createE2EMochaRootHooks, createE2ESessionHooks } from "./hooks.js";
import { createServices } from "./services.js";
import {
  MANUAL_REVIEW_SPEC_GLOB,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "../../../scripts/e2e-formal-spec-selection.mjs";
import {
  E2E_PROVIDER_REPLAY_API_KEY,
  e2eProviderPresetName,
  resolveActiveE2EProviderEnv,
} from "./env.js";
import {
  E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  E2E_HOME_DIR,
  E2E_WEBDRIVER_REQUEST_LIMITS,
  INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
} from "./paths.js";
import { E2E_RUN_ID, e2eReporter } from "./reporters.js";
import {
  E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
  E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
  E2E_PROVIDER_SECONDARY_MODEL,
  REQUESTED_UPSTREAM_HTTP_MODE_ENV,
  TURN_STEER_PROBE_SPEC,
  UPSTREAM_PROVIDER_SPEC,
  configuredE2ESpecs,
  containerE2E,
  manualReviewE2E,
  manualReviewHoldMs,
  pluginNoGitGitHubArchiveE2E,
  requestedE2EExcludeSpecs,
  requestedE2ESpecs,
  requestedUpstreamE2EHttpMode,
  turnSteerProbeSpecRequested,
  upstreamProviderSpecRequested,
  workspacePluginRemoteExplicitSyncE2E,
} from "./specs.js";
import { wdioState } from "./state.js";

/**
 * Конфигурация WDIO. Хуки подключаются из hooks.ts: onPrepare пишет динамические
 * mock-порты прямо в runnerEnv этого же объекта, поэтому фабрика получает config.
 */
const config: WebdriverIO.Config = {
  runner: "local",

  // 修复原因：waitUntil 的 timeout 无法中断内部已经发出的 WebDriver HTTP 请求；
  // 坏 ContextId 在 hook 中会按默认 120 秒和 3 次重试卡数分钟，必须在协议层设硬边界。
  connectionRetryCount: E2E_WEBDRIVER_REQUEST_LIMITS.retryCount,

  // executeAsyncScript 的浏览器内 script timeout 与 WDIO 到 Chromedriver 的 HTTP timeout
  // 是两层独立门限；公网 Archive case 两层都必须覆盖 Agent 的 180 秒下载上限。
  connectionRetryTimeout: pluginNoGitGitHubArchiveE2E
    ? 300_000
    : E2E_WEBDRIVER_REQUEST_LIMITS.timeoutMs,

  runnerEnv: {
    E2E_PROVIDER_ALTERNATE_MODEL: E2E_PROVIDER_SECONDARY_MODEL,
    E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
    E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
    E2E_PROVIDER_HTTP_MODE: wdioState.upstreamE2EHttpMode,
    [REQUESTED_UPSTREAM_HTTP_MODE_ENV]: requestedUpstreamE2EHttpMode ?? "",
    E2E_PROVIDER_MODEL: resolveActiveE2EProviderEnv().model,
    E2E_PROVIDER_ID: resolveActiveE2EProviderEnv().providerId,
    E2E_PROVIDER_NAME: resolveActiveE2EProviderEnv().providerName,
    E2E_PROVIDER_PRESET: e2eProviderPresetName,
    ...requestSecurityWorkerEnv(process.env),
    E2E_PROVIDER_THOUGHT_LEVEL: resolveActiveE2EProviderEnv().thoughtLevel,
    ...(wdioState.upstreamE2EHttpMode === "replay"
      ? { E2E_PROVIDER_API_KEY: E2E_PROVIDER_REPLAY_API_KEY }
      : {}),
    HOME: E2E_HOME_DIR,
    USERPROFILE: E2E_HOME_DIR,
    // PLM-LC-010 使用非 ZCODE_ 前缀验证插件 MCP 的 Claude-compatible env 展开。
    // 值只供 fixture 做 hash 比对，工具结果和截图都不得回显原值。
    E2E_PLUGIN_RUNTIME_SECRET: "e2e-plugin-runtime-secret-fixture-20260718",
    ...(pluginNoGitGitHubArchiveE2E
      ? {
          // 真实公网 smoke 必须证明 Agent 没有偷偷回退开发机 Git；不存在的绝对路径会让
          // 任意 Git 调用稳定得到 ENOENT，同时不影响 WDIO runner 自身的进程清理命令。
          ZCODE_GIT_BINARY: resolve(E2E_HOME_DIR, "missing-bin", "git"),
        }
      : {}),
    VITE_ZCODE_E2E_STORE_BRIDGE: "1",
    ZCODE_AGENT_SERVER_ARGS_JSON: "",
    ZCODE_AGENT_SERVER_COMMAND: "",
    ZCODE_DATA_BASE_DIR: E2E_HOME_DIR,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:
      INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    ZCODE_DESKTOP_APPLICATION_NAME: "ZCode E2E",
    ZCODE_DESKTOP_HOME_DIR: E2E_HOME_DIR,
    ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZCODE_E2E_HOME_DIR: E2E_HOME_DIR,
    ZCODE_E2E_ARTIFACT_DIR: e2eReporter.artifactDir,
    ZCODE_E2E_DEFER_APP_DATA_CLEANUP: "1",
    ZCODE_E2E_RUN_ID: E2E_RUN_ID,
    ZCODE_ENV: "test",
    // 修复原因：普通 E2E 的 ZCODE_ENV=test 会把配置接口路由到测试域；
    // 请求安全 capture 与独立 live-team 显式覆盖生产控制面，其他用例保持原行为。
    ...getE2EProviderEndpointEnv(
      configuredE2ESpecs,
      e2eProviderPresetName,
      wdioState.upstreamE2EHttpMode,
    ),
    ...(process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH?.trim()
      ? {
          ZCODE_TELEMETRY_PARITY_CAPTURE_PATH: process.env.ZCODE_TELEMETRY_PARITY_CAPTURE_PATH,
        }
      : {}),
    ...(process.env.ZCODE_TELEMETRY_PARITY_VARIANT?.trim()
      ? {
          ZCODE_TELEMETRY_PARITY_VARIANT: process.env.ZCODE_TELEMETRY_PARITY_VARIANT,
        }
      : {}),
  },

  framework: "mocha",

  reporters: ["spec"],

  maxInstances: Number(process.env.ZCODE_E2E_MAX_INSTANCES ?? "1"),

  maxInstancesPerCapability: Number(process.env.ZCODE_E2E_MAX_INSTANCES ?? "1"),

  ...(containerE2E
    ? {
        autoXvfb: true,
        xvfbAutoInstall: false,
        xvfbMaxRetries: 5,
        xvfbRetryDelay: 1500,
      }
    : {}),

  services: createServices(),
  capabilities: createCapabilities(),

  specs: configuredE2ESpecs,

  // 修复原因：上游 provider e2e 需要真实上游 key，默认全量 e2e 不应启动一个“跳过但仍占用浏览器”的 worker。
  // 否则它会和 smoke 共用并重置 .e2e-home，表现为临时测试窗口白屏或一直等不到默认工作区。
  exclude: [
    ...(upstreamProviderSpecRequested ? [] : [UPSTREAM_PROVIDER_SPEC]),
    ...(turnSteerProbeSpecRequested ? [] : [TURN_STEER_PROBE_SPEC]),
    ...(manualReviewE2E ? [] : [MANUAL_REVIEW_SPEC_GLOB]),
    ...resolveEnvironmentGatedFormalSpecExcludes({
      env: process.env,
      targeted: requestedE2ESpecs.length > 0,
    }),
    // Bugfix: MR 自动门禁可以临时 quarantine 已知不稳定正式 spec，但本地默认
    // `test:e2e` 不受影响，避免把 flaky case 从开发者回归入口永久隐藏。
    ...requestedE2EExcludeSpecs,
  ],

  mochaOpts: {
    // Bug 根因：WDIO config beforeSuite 通过 executeHooksWithArgs 执行，普通异常会被
    // 记录后 resolve，坏 session 仍会进入产品 case。Mocha 原生 root hook 才会把
    // preflight rejection 计为 hook failure，并在 test body 前停止。
    rootHooks: createE2EMochaRootHooks(),
    ui: "bdd",
    // 远程 e2e 队列里有正式 spec 只包含一个远程用例（settings-ui-polish 的
    // MP-UI-05-remote）：整份跑会把同 spec 的本机用例一起拉进远程结果，失败原因
    // 与远程无关却计在远程账上（实测 MP-UI-06 拖累 MP-UI-05-remote 的通过结论）。
    // 未设置时保持全量，不影响本机回归。
    ...(process.env.ZCODE_E2E_MOCHA_GREP?.trim()
      ? { grep: process.env.ZCODE_E2E_MOCHA_GREP.trim() }
      : {}),
    // 修复原因：真实模型配置 + 首次会话预热可能超过 30s，保留更宽的单 case 上限，避免还没收到上游响应就被 Mocha 截断。
    // 真实 GitHub Archive smoke 会下载 Claude 官方市场和目标插件；E2E 抓包代理还会
    // 记录完整二进制响应，不能沿用只覆盖本地 fixture 的 120 秒上限。
    // WPL-011 会经过 SSH asset、marketplace 镜像、远端安装与 runtime refresh；
    // 固定 120 秒会在 UI 有机会报告具体同步结果前先截断 case。
    // Bug 根因：Mocha adapter 会在进入 test body 前按 config timeout 包裹用例，
    // 因此用例内的 this.timeout 无法为人工保留阶段追加预算。显式 hold 只扩展
    // manual-review 运行，不改变普通 E2E 的 120 秒上限。
    timeout:
      (configuredE2ESpecs.some((spec) =>
        spec.endsWith("conversation-session-remote-sidebar-menus.test.ts"),
      )
        ? // 此用例包含真实 SSH 首装、目录复用、设置定位、16 张截图和原目录重连；
          // Mocha 外层须与用例的 15 分钟预算一致，不能在首装解压时被默认 120 秒截断。
          15 * 60_000
        : configuredE2ESpecs.some((spec) =>
              spec.endsWith("conversation-session-remote-ui-walkthrough.test.ts"),
            )
          ? // 走查用例串行完成真实首装、失败/取消/后台、设置页与停容器掉线恢复，并全程录屏；
            // 与用例内 30 分钟预算一致。
            30 * 60_000
          : configuredE2ESpecs.some((spec) =>
                spec.endsWith("conversation-session-r3-mobile.test.ts"),
              )
            ? // 此用例串行完成真实 SSH 安装、两次 relay 配对和断网恢复；同步其原定预算，
              // 避免 WDIO 在手机离线期间按默认 120 秒截断，this.timeout 无法覆盖外层。
              40 * 60_000
            : pluginNoGitGitHubArchiveE2E ||
                workspacePluginRemoteExplicitSyncE2E ||
                configuredE2ESpecs.some((spec) =>
                  spec.endsWith("conversation-session-subagent-cross-host.test.ts"),
                )
              ? 600000
              : // 后台 Bash 冷恢复回归等待真实 child 结束、120s publisher grace 及 60s 清理节拍。
                configuredE2ESpecs.some((spec) =>
                    spec.endsWith("conversation-session-background-bash-output.test.ts"),
                  )
                ? 360000
                : requestSecuritySpecTimeout(configuredE2ESpecs, 120000)) + manualReviewHoldMs,
  },
};

Object.assign(config, createE2ESessionHooks(config));

export { config };
