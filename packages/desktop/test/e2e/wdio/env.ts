import {
  resolveUpstreamE2EHttpMode,
  resolveUpstreamE2EHttpModeForWorker,
  hasUpstreamCaseLocalReplayFixtureForWorker,
} from "../helpers/upstream-replay-fixture-resolution.js";
import { resolveAskUserQuestionClockScaleForWorker } from "../helpers/e2e-worker-environment.js";
import { getE2EProviderEndpointEnv } from "#e2e/helpers/e2e-provider-endpoint";
import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";
import {
  E2E_HOME_DIR,
  UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
  readPositiveIntegerEnv,
} from "./paths.js";
import { E2E_RUN_ID } from "./reporters.js";
import {
  E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
  E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
  E2E_PROVIDER_ID,
  E2E_PROVIDER_MODEL,
  E2E_PROVIDER_SECONDARY_MODEL,
  configuredE2ESpecs,
  manualReviewE2E,
  requestedAskUserQuestionClockScale,
  requestedUpstreamE2EHttpMode,
} from "./specs.js";
import { wdioState } from "./state.js";

// 上游供应商地址由 E2E_PROVIDER_BASE_URL 提供，仓库不写死任何供应商；只有 capture 模式访问真实上游时需要。
// 回放模式使用本地回放服务器，实际生效的地址经 E2E_PROVIDER_RUNTIME_BASE_URL 传给各测试进程。
const E2E_PROVIDER_UPSTREAM_BASE_URL = process.env.E2E_PROVIDER_BASE_URL?.trim() ?? "";
export const E2E_PROVIDER_REPLAY_API_KEY = "e2e-fixture-key";
export const CODING_PLAN_MODEL_SSE_BODY =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"coding-plan-e2e","type":"message","role":"assistant","content":[],"model":"glm-e2e","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":128,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"coding-plan-e2e-ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
export const E2E_AUTH_PROVIDER_ID = "zai";
export const E2E_AUTH_TOKEN = "e2e-oauth-token";
export const E2E_USER_PROFILE = {
  displayName: "ZCode E2E",
  id: "zcode-e2e-user",
  username: "zcode-e2e-user",
};
const GLM_HIGHSPEED_E2E_PROVIDER_ID = "e2e-glmhighspeed";
const GLM_HIGHSPEED_E2E_MODEL = "glm-5.1-highspeed";
const GLM_HIGHSPEED_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const BIGMODEL_GLM53_E2E_PROVIDER_ID = "e2e-bigmodel-glm53";
const BIGMODEL_GLM53_E2E_MODEL = "GLM-5.3";
const BIGMODEL_GLM53_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const STAGING_MODEL_E2E_PROVIDER_ID = "e2e-staging-model";
const STAGING_MODEL_E2E_MODEL = "glm-5.2";
const STAGING_MODEL_E2E_BASE_URL = "https://open.bigmodel.cn/api";
const E2E_PROVIDER_PRESETS = {
  env: {
    apiKeyEnvNames: ["E2E_PROVIDER_API_KEY"],
    baseUrl: E2E_PROVIDER_UPSTREAM_BASE_URL,
    expectedHost: readUpstreamBaseUrlPart("host"),
    expectedProtocol: readUpstreamBaseUrlPart("protocol"),
    model: E2E_PROVIDER_MODEL,
    providerId: E2E_PROVIDER_ID,
    providerName: "Upstream E2E",
    thoughtLevel: "high",
  },
  glmhighspeed: {
    apiKeyEnvNames: [
      "GLM_HIGHSPEED_E2E_API_KEY",
      "BIGMODEL_API_KEY",
      "ZHIPUAI_API_KEY",
      "E2E_PROVIDER_API_KEY",
    ],
    baseUrl: GLM_HIGHSPEED_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: GLM_HIGHSPEED_E2E_MODEL,
    providerId: GLM_HIGHSPEED_E2E_PROVIDER_ID,
    providerName: "GLM Highspeed E2E",
    thoughtLevel: "",
  },
  bigmodel53: {
    apiKeyEnvNames: ["BIGMODEL_GLM53_E2E_API_KEY"],
    baseUrl: BIGMODEL_GLM53_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: BIGMODEL_GLM53_E2E_MODEL,
    providerId: BIGMODEL_GLM53_E2E_PROVIDER_ID,
    providerName: "BigModel GLM-5.3 E2E",
    thoughtLevel: "",
  },
  stagingmodel: {
    apiKeyEnvNames: ["STAGING_MODEL_E2E_API_KEY"],
    baseUrl: STAGING_MODEL_E2E_BASE_URL,
    expectedHost: "open.bigmodel.cn",
    expectedProtocol: "https",
    model: STAGING_MODEL_E2E_MODEL,
    providerId: STAGING_MODEL_E2E_PROVIDER_ID,
    providerName: "stagingModel",
    thoughtLevel: "",
  },
} as const;
type E2EProviderPresetName = keyof typeof E2E_PROVIDER_PRESETS;
export const upstreamE2EContextWindowOverride = readPositiveIntegerEnv(
  "ZCODE_E2E_UPSTREAM_CONTEXT_WINDOW",
);
export const upstreamE2EMaxOutputTokensOverride = readPositiveIntegerEnv(
  "ZCODE_E2E_UPSTREAM_MAX_OUTPUT_TOKENS",
);
export const e2eProviderPresetName = readE2EProviderPresetName();
export const e2eProviderPreset = E2E_PROVIDER_PRESETS[e2eProviderPresetName];
// HTTP-режим и адрес upstream фиксируются до старта reporter/сборки и далее меняются
// только per-worker в applyUpstreamE2EHttpModeForWorker.
wdioState.upstreamE2EHttpMode = readUpstreamE2EHttpMode();
wdioState.upstreamE2EBaseUrl = e2eProviderPreset.baseUrl;

process.env.HOME = E2E_HOME_DIR;
process.env.USERPROFILE = E2E_HOME_DIR;
process.env.ZCODE_E2E_HOME_DIR = E2E_HOME_DIR;
process.env.ZCODE_E2E_RUN_ID = E2E_RUN_ID;
process.env.ZCODE_DATA_BASE_DIR = E2E_HOME_DIR;
process.env.ZCODE_DESKTOP_APPLICATION_NAME = "ZCode E2E";
process.env.ZCODE_DESKTOP_HOME_DIR = E2E_HOME_DIR;
process.env.ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA = "1";
// Bugfix: renderer E2E store bridge 只能由 WDIO 进程显式打开，避免 ZCODE_ENV=test 的产品测试环境暴露全局可变 store。
process.env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";
// Bugfix: e2e session 由 Chromedriver 管理调试端口；禁用主进程开发态固定的 9229，
// 避免和本机已打开的 ZCode Dev 冲突后出现空白窗口并卡在 session 创建阶段。
process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT = "1";

applyE2EProviderEnv();

function readUpstreamBaseUrlPart(part: "host" | "protocol") {
  if (!E2E_PROVIDER_UPSTREAM_BASE_URL) return "";
  const url = new URL(E2E_PROVIDER_UPSTREAM_BASE_URL);
  return part === "host" ? url.host : url.protocol.replace(/:$/u, "");
}

function readE2EProviderPresetName(): E2EProviderPresetName {
  const configured =
    process.env.E2E_PROVIDER_PRESET?.trim() || process.env.LLM_E2E_PROVIDER_PRESET?.trim();
  if (!configured) {
    // 默认使用环境变量配置的上游供应商（E2E_PROVIDER_BASE_URL / API_KEY / MODEL）；
    // 修复原因：rebase 后默认曾落到 GLM highspeed，会请求 open.bigmodel.cn 且人工验收链路不一致。
    return "env";
  }
  if (
    configured === "env" ||
    configured === "glmhighspeed" ||
    configured === "bigmodel53" ||
    configured === "stagingmodel"
  ) {
    return configured;
  }
  throw new Error(
    `Unsupported E2E_PROVIDER_PRESET=${configured}. ` +
      "Expected env, glmhighspeed, bigmodel53, or stagingmodel.",
  );
}

export function resolveActiveE2EProviderEnv(_specs: string[] = configuredE2ESpecs) {
  return {
    providerId: e2eProviderPreset.providerId,
    providerName: e2eProviderPreset.providerName,
    model: e2eProviderPreset.model,
    thoughtLevel: readE2EThoughtLevel(),
  };
}

export function applyE2EProviderEnv(specs: string[] = configuredE2ESpecs) {
  const providerEnv = resolveActiveE2EProviderEnv(specs);
  process.env.E2E_PROVIDER_PRESET = e2eProviderPresetName;
  process.env.E2E_PROVIDER_ID = providerEnv.providerId;
  process.env.E2E_PROVIDER_NAME = providerEnv.providerName;
  process.env.E2E_PROVIDER_MODEL = providerEnv.model;
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_ID = E2E_PROVIDER_ALTERNATE_PROVIDER_ID;
  process.env.E2E_PROVIDER_ALTERNATE_PROVIDER_NAME = E2E_PROVIDER_ALTERNATE_PROVIDER_NAME;
  process.env.E2E_PROVIDER_ALTERNATE_MODEL = E2E_PROVIDER_SECONDARY_MODEL;
  process.env.E2E_PROVIDER_THOUGHT_LEVEL = providerEnv.thoughtLevel;
  // 修复原因：runnerEnv 只保证 WDIO spec 进程可见，Electron/Host 启动链继承的是
  // wdio config 进程环境。请求安全 capture 与 live-team 选择的生产控制面只写 runnerEnv
  // 会让 Agent 继续访问测试域；live-team 的生产 JWT 则会触发 401。
  Object.assign(
    process.env,
    getE2EProviderEndpointEnv(specs, e2eProviderPresetName, wdioState.upstreamE2EHttpMode),
  );
}

export function readE2EThoughtLevel() {
  for (const envName of ["E2E_PROVIDER_THOUGHT_LEVEL", "LLM_E2E_THOUGHT_LEVEL"]) {
    if (process.env[envName] !== undefined) {
      return process.env[envName]?.trim() ?? "";
    }
  }
  return e2eProviderPreset.thoughtLevel;
}

export function readUpstreamE2EHttpMode() {
  const mode = resolveUpstreamE2EHttpMode({
    explicitReplayFixture: Boolean(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim()),
    manualReview: manualReviewE2E,
    requestedMode: requestedUpstreamE2EHttpMode,
  });
  process.env.E2E_PROVIDER_HTTP_MODE = mode;
  return mode;
}

export function applyUpstreamE2EHttpModeForWorker(specs: string[]) {
  wdioState.upstreamE2EHttpMode = resolveUpstreamE2EHttpModeForWorker({
    caseLocalReplayFixtureAvailable: hasUpstreamCaseLocalReplayFixtureForWorker({
      caseFixtureDir: UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
      specs,
    }),
    explicitReplayFixture: Boolean(process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim()),
    requestedMode: requestedUpstreamE2EHttpMode,
    specs,
  });
  // Bug 根因：combined run 的全局 manual-review 开关过去把正式 worker 也固定为
  // capture，case-local replay 因此直连真实模型并产生假失败。mode 必须在每个
  // Electron 启动前按该 worker 的 spec 与 fixture 完整性重新决策。
  process.env.E2E_PROVIDER_HTTP_MODE = wdioState.upstreamE2EHttpMode;
}

export function applySwarmCrashBoundaryEnvForWorker(specs: string[]) {
  if (specs.some((spec) => spec.includes("conversation-session-swarm-crash.test.ts"))) {
    // Агент наследует env worker до spawn. Пауза после commit графа и резервирования
    // есть только у этого spec; остальные worker её не получают.
    process.env.ZCODE_E2E_SWARM_CRASH_BOUNDARY = "1";
    return;
  }
  delete process.env.ZCODE_E2E_SWARM_CRASH_BOUNDARY;
}

export function applyAskUserQuestionClockScaleForWorker(specs: string[]) {
  const scale = resolveAskUserQuestionClockScaleForWorker({
    requestedScale: requestedAskUserQuestionClockScale,
    specs,
  });
  if (scale) {
    // Bug 根因：该 pending case 的五分钟 deadline 依赖测试时钟缩放；单独跑时由
    // 人工注入，全量 worker 没有继承就会在产品启动前直接失败。按 spec 注入并在
    // 下一 worker 清理，避免缩放泄漏到普通 AskUserQuestion 行为。
    process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV] = scale;
  } else {
    delete process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV];
  }
}

export function assertUpstreamCaptureConfig() {
  if (!e2eProviderPreset.baseUrl) {
    throw new Error(
      `E2E_PROVIDER_HTTP_MODE=capture with ${e2eProviderPresetName} requires E2E_PROVIDER_BASE_URL.`,
    );
  }
  const apiKey = readE2EProviderApiKey();
  if (apiKey && apiKey !== "xxx") {
    return;
  }

  // 修复原因：默认 e2e 已切成 fixture replay；只有显式 capture 才会访问真实
  // 上游。采集 fixture 时必须提前校验真实 key，避免把失败响应固化进仓库。
  throw new Error(
    `E2E_PROVIDER_HTTP_MODE=capture with ${e2eProviderPresetName} requires one of: ${e2eProviderPreset.apiKeyEnvNames.join(", ")}.`,
  );
}

export function readE2EProviderApiKey() {
  for (const envName of e2eProviderPreset.apiKeyEnvNames) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

export function ensureUpstreamReplayConfig() {
  process.env.E2E_PROVIDER_API_KEY = E2E_PROVIDER_REPLAY_API_KEY;
}
