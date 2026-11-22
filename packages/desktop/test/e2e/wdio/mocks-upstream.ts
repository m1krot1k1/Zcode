import {
  loadToolSearchResponses,
  toolSearchResponseStage,
  type ToolSearchRequest,
} from "../helpers/toolsearch-provider.js";
import {
  requestSecurityCaptureMocks,
  recordRequestSecurityCaptureMode,
  restoreRequestSecurityEndpointEnv,
} from "../helpers/request-security-edition/index.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startUpstreamReplayServer } from "../helpers/upstream-replay-server.js";
import {
  resolveUpstreamReplayFixturePaths as resolveUpstreamReplayFixturePathsFromContract,
  type UpstreamReplayFixtureMode,
} from "../helpers/upstream-replay-fixture-resolution.js";
import { shouldPrepareCodingPlanTeamMock } from "../helpers/coding-plan-mock-env.js";
import {
  workerSpecsContain,
  applyE2EWorkerReplayProxyEnv,
} from "../helpers/e2e-worker-isolation.js";
import { getE2EProviderEndpointEnv } from "#e2e/helpers/e2e-provider-endpoint";
import { createE2EReplayFixtureVariables } from "../helpers/e2e-runtime-paths.js";
import {
  DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY,
  startE2ENetworkCaptureProxy,
} from "../helpers/network-capture-proxy.js";
import {
  CODING_PLAN_MODEL_SSE_BODY,
  E2E_PROVIDER_REPLAY_API_KEY,
  assertUpstreamCaptureConfig,
  e2eProviderPreset,
  e2eProviderPresetName,
  ensureUpstreamReplayConfig,
  readE2EProviderApiKey,
} from "./env.js";
import {
  CODING_PLAN_DATA_PLANE_ARTIFACT_PATH,
  DESKTOP_DIR,
  E2E_CODING_PLAN_DATA_PLANE_CA_DIR,
  E2E_HOME_DIR,
  E2E_NETWORK_CAPTURE_CA_DIR,
  E2E_NETWORK_CAPTURE_DIR,
  E2E_PROVIDER_RUNTIME_FILE,
  LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS,
  REPO_ROOT,
  UPSTREAM_CAPTURE_ARTIFACT_PATH,
  UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES,
  UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES,
  UPSTREAM_COMMON_REPLAY_FIXTURE_PATH,
  UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR,
  UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
  UPSTREAM_REPLAY_FIXTURE_ROOT,
} from "./paths.js";
import { configuredE2ESpecs, configuredE2EWorkerNetworkEnv } from "./specs.js";
import { wdioState } from "./state.js";

function readConfiguredUpstreamReplayFixturePaths() {
  const configured = process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim();
  if (!configured) {
    return null;
  }

  return configured
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(REPO_ROOT, item));
}

function resolveUpstreamReplayFixturePaths(specs: string[] = []) {
  const configured = readConfiguredUpstreamReplayFixturePaths();
  return resolveUpstreamReplayFixturePathsFromContract({
    caseFixtureDir: UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR,
    caseManifestDir: UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR,
    commonFixturePath: UPSTREAM_COMMON_REPLAY_FIXTURE_PATH,
    configuredFixturePaths: configured,
    legacyFixturePaths: LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS,
    mode: readUpstreamReplayFixtureMode(),
    pluginFixturePaths: resolvePluginReplayFixturePaths(specs),
    specs,
  });
}

function readUpstreamReplayFixtureMode(): UpstreamReplayFixtureMode {
  const mode = process.env.E2E_PROVIDER_REPLAY_FIXTURE_MODE?.trim() || "compatible";
  if (mode === "compatible" || mode === "strict-case-local") {
    return mode;
  }
  throw new Error(
    `Unsupported E2E_PROVIDER_REPLAY_FIXTURE_MODE=${mode}. Expected compatible or strict-case-local.`,
  );
}

function resolvePluginReplayFixturePaths(specs: string[]): string[] {
  const fixtureDirs: string[] = [];
  if (workerSpecsContain(specs, "plugin-mcp-skill")) {
    fixtureDirs.push(resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "plugin-mcp-skill"));
  }
  if (workerSpecsContain(specs, "plugin-management-")) {
    fixtureDirs.push(resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "plugin-management"));
  }
  return fixtureDirs.filter(existsSync);
}

export async function startUpstreamE2EHttp(specs: string[] = []) {
  await stopUpstreamE2EHttp();
  if (
    wdioState.upstreamE2EHttpMode === "capture" ||
    specs.some((spec) => spec.includes("conversation-session-toolsearch"))
  ) {
    applyE2EWorkerReplayProxyEnv(process.env, [], "", configuredE2EWorkerNetworkEnv);
    await startUpstreamCaptureProxy(specs);
    return;
  }

  ensureUpstreamReplayConfig();
  wdioState.upstreamReplayServer = await startUpstreamReplayServer({
    artifactPath: UPSTREAM_CAPTURE_ARTIFACT_PATH,
    fixtureVariables: createE2EReplayFixtureVariables(E2E_HOME_DIR),
    fixturePaths: resolveUpstreamReplayFixturePaths(specs),
  });
  wdioState.upstreamE2EBaseUrl = wdioState.upstreamReplayServer.baseUrl;
  process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
  process.env.E2E_PROVIDER_CAPTURE_PATH = wdioState.upstreamReplayServer.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = wdioState.upstreamReplayServer.baseUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = `${wdioState.upstreamReplayServer.host}:${wdioState.upstreamReplayServer.port}`;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = wdioState.upstreamReplayServer.baseUrl;
  process.env.NO_PROXY = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  process.env.no_proxy = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  applyE2EWorkerReplayProxyEnv(
    process.env,
    specs,
    wdioState.upstreamReplayServer.baseUrl,
    configuredE2EWorkerNetworkEnv,
  );
  writeUpstreamE2ERuntimeFile("replay", wdioState.upstreamReplayServer.baseUrl);
}

const HIGHSPEED_DATA_PLANE_FIXTURE_PATHS = [
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-draw-timeout.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-draw-miss.json",
  "test/e2e/fixtures/upstream/conversation-session/conversation-session-highspeed-card-fallback-unlocks-model.json",
];

interface DataPlaneTurnFixture {
  match: { lastUserMessageIncludes: string[] };
  response: { body: string };
}

async function readDataPlaneTurnFixtures(path: string): Promise<DataPlaneTurnFixture[]> {
  return (
    JSON.parse(await readFile(resolve(DESKTOP_DIR, path), "utf8")) as {
      fixtures: DataPlaneTurnFixture[];
    }
  ).fixtures;
}

/**
 * Account 数据面按最后一条 user message 的标记回放 case-local 固定响应；
 * 非流式请求是标题 sidecar（generateText），统一返回固定标题。
 */
function createDataPlaneTurnResponder(
  fixtures: readonly DataPlaneTurnFixture[],
  options: { fallbackBody: string; title: { id: string; text: string } },
) {
  return (requestBody: string) => {
    const request = JSON.parse(requestBody) as {
      stream?: boolean;
      messages?: Array<{ role: string; content: unknown }>;
    };
    if (request.stream !== true)
      return JSON.stringify({
        id: options.title.id,
        type: "message",
        role: "assistant",
        model: "GLM-5.2",
        content: [{ type: "text", text: options.title.text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 4 },
      });
    const messages = request.messages ?? [];
    const lastUser = JSON.stringify(
      messages.findLast((message) => message.role === "user")?.content,
    );
    return (
      fixtures.find((fixture) =>
        fixture.match.lastUserMessageIncludes.every((marker) => lastUser?.includes(marker)),
      )?.response.body ?? options.fallbackBody
    );
  };
}

export async function startCodingPlanDataPlaneProxy(specs: readonly string[]) {
  // 数据面按当前 worker 启动；混合批次中的 ToolSearch 不影响其他账号用例。
  if (!shouldPrepareCodingPlanTeamMock(specs)) return;
  // ToolSearch 的多轮应答使用主 capture proxy，避免两个代理覆盖同一网络设置。
  if (specs.some((spec) => spec.includes("conversation-session-toolsearch"))) return;
  if (wdioState.codingPlanDataPlaneProxy) {
    for (const [key, value] of Object.entries(wdioState.codingPlanDataPlaneProxy.env)) {
      process.env[key] = value;
    }
    return;
  }
  // SR87 的真实请求走 Account 数据面，而非 上游 代理；必须让本例的
  // case-local fixture 真正供该数据面使用，不能只登记一份永远不命中的回放文件。
  const modelResponseBody = specs.some((spec) =>
    spec.includes("conversation-session-model-provider-effective-selection.test.ts"),
  )
    ? (
        JSON.parse(
          await readFile(
            resolve(
              DESKTOP_DIR,
              "test/e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-effective-selection.json",
            ),
            "utf8",
          ),
        ) as {
          fixtures: Array<{ response: { body: string } }>;
        }
      ).fixtures[0]!.response.body
    : CODING_PLAN_MODEL_SSE_BODY;
  const startIndependentFixtures = specs.some((spec) =>
    spec.includes("conversation-session-start-plan-independent.test.ts"),
  )
    ? await readDataPlaneTurnFixtures(
        "test/e2e/fixtures/upstream/conversation-session/conversation-session-start-plan-independent.json",
      )
    : null;
  // Highspeed 抽卡 case 的每轮请求都走 Team Coding Plan 内建 HTTPS Endpoint（spec §7）；
  // 静态 body 无法区分轮次，多轮 case 会在首轮就误判完成，必须按轮次标记回放。
  const highspeedFixtures = specs.some((spec) =>
    spec.includes("conversation-session-highspeed-card"),
  )
    ? (
        await Promise.all(
          HIGHSPEED_DATA_PLANE_FIXTURE_PATHS.map((path) => readDataPlaneTurnFixtures(path)),
        )
      ).flat()
    : null;
  wdioState.codingPlanDataPlaneProxy = await startE2ENetworkCaptureProxy({
    artifactPath: CODING_PLAN_DATA_PLANE_ARTIFACT_PATH,
    caDir: E2E_CODING_PLAN_DATA_PLANE_CA_DIR,
    responseMocks: [
      // 签名默认开启后，Account 用例的测试凭据也会发起握手；本地响应避免访问线上。
      {
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/paas/c1f3a7e2/v2/client",
        body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
      },
      ...(startIndependentFixtures
        ? [
            {
              host: "start154-e2e.invalid",
              method: "POST",
              path: "/v1/messages",
              headers: { "content-type": "text/event-stream; charset=utf-8" },
              body: createDataPlaneTurnResponder(startIndependentFixtures, {
                fallbackBody: CODING_PLAN_MODEL_SSE_BODY,
                title: { id: "start154-title", text: "Start154 checks" },
              }),
            },
          ]
        : []),
      {
        body: highspeedFixtures
          ? createDataPlaneTurnResponder(highspeedFixtures, {
              fallbackBody: modelResponseBody,
              title: { id: "highspeed-title", text: '{"title":"Highspeed draw"}' },
            })
          : modelResponseBody,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        host: "open.bigmodel.cn",
        method: "POST",
        path: "/api/anthropic/v1/messages",
      },
    ],
  });
  for (const [key, value] of Object.entries(wdioState.codingPlanDataPlaneProxy.env)) {
    process.env[key] = value;
  }
}

async function startUpstreamCaptureProxy(specs: readonly string[]) {
  const toolSearchFixture = specs.some((spec) => spec.includes("conversation-session-toolsearch"));
  if (!toolSearchFixture) assertUpstreamCaptureConfig();
  const toolSearchSpec = specs.find((spec) => spec.includes("conversation-session-toolsearch"));
  const toolSearchResponses = toolSearchSpec
    ? await loadToolSearchResponses(
        toolSearchSpec
          .replaceAll("\\", "/")
          .split("/")
          .at(-1)!
          .replace(/\.test\.ts$/, ""),
      )
    : undefined;
  const apiKey = toolSearchFixture ? E2E_PROVIDER_REPLAY_API_KEY : readE2EProviderApiKey();
  const responseMocks = requestSecurityCaptureMocks(process.env, e2eProviderPresetName);
  wdioState.upstreamCaptureProxy = await startE2ENetworkCaptureProxy({
    artifactPath: UPSTREAM_CAPTURE_ARTIFACT_PATH,
    // Bugfix: beforeSession 会在启动 capture proxy 后重置 .e2e-home；
    // CA 若放在 .e2e-home 下会被删掉，agent 随后读取 ZCODE_AGENT_CA_CERT 就会 ENOENT。
    caDir: E2E_NETWORK_CAPTURE_CA_DIR,
    recordResponseChunkTimeline: true,
    responseChunkTimelineLimitBytes: UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES,
    responsePreviewLimitBytes: UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES,
    responseMocks: toolSearchFixture
      ? [
          ...(responseMocks ?? []),
          // 签名默认开启后，ToolSearch 的假凭据也会握手；与 Account 用例共用本地失败响应边界。
          {
            host: "open.bigmodel.cn",
            method: "POST",
            path: "/api/paas/c1f3a7e2/v2/client",
            body: JSON.stringify({ code: 500, msg: "E2E handshake unavailable" }),
          },
          {
            body: (body) =>
              toolSearchResponses!.get(
                toolSearchResponseStage(JSON.parse(body) as ToolSearchRequest),
              ).response.body,
            headers: { "content-type": "text/event-stream; charset=utf-8" },
            host: "open.bigmodel.cn",
            method: "POST",
            path: "/api/anthropic/v1/messages",
          },
        ]
      : responseMocks,
  });
  process.env.E2E_PROVIDER_API_KEY = apiKey;
  wdioState.upstreamE2EBaseUrl = e2eProviderPreset.baseUrl;

  // 修复原因：capture 模式用于更新固定 fixture，需要真实上游响应和请求抓包；
  // 默认 replay 模式不会走这里，避免固定回归受网络、余额、限流影响。
  for (const [key, value] of Object.entries(wdioState.upstreamCaptureProxy.env)) {
    process.env[key] = value;
  }
  process.env.E2E_PROVIDER_CAPTURE_MODE = "capture";
  process.env.E2E_PROVIDER_CAPTURE_PATH = wdioState.upstreamCaptureProxy.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = wdioState.upstreamCaptureProxy.proxyUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = e2eProviderPreset.expectedHost;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = e2eProviderPreset.expectedProtocol;
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = e2eProviderPreset.baseUrl;
  recordRequestSecurityCaptureMode(process.env, Boolean(responseMocks));
  writeUpstreamE2ERuntimeFile("capture", e2eProviderPreset.baseUrl);
}

function writeUpstreamE2ERuntimeFile(mode: "capture" | "replay", baseUrl: string) {
  // 修复原因：WDIO hook 内设置的 env 不一定能被所有 spec 代码稳定读取；
  // 用 runtime 文件暴露本轮代理地址，避免自定义 provider case 误读旧 CLI config 端口。
  mkdirSync(E2E_NETWORK_CAPTURE_DIR, { recursive: true });
  writeFileSync(
    E2E_PROVIDER_RUNTIME_FILE,
    JSON.stringify(
      {
        artifactPath: process.env.E2E_PROVIDER_CAPTURE_PATH ?? "",
        baseUrl,
        mode,
      },
      null,
      2,
    ),
  );
}

export async function stopUpstreamE2EHttp() {
  if (!wdioState.upstreamCaptureProxy) {
    if (wdioState.upstreamReplayServer) {
      await wdioState.upstreamReplayServer.stop();
      wdioState.upstreamReplayServer = null;
    }
    return;
  }
  await wdioState.upstreamCaptureProxy.stop();
  wdioState.upstreamCaptureProxy = null;
  if (wdioState.upstreamReplayServer) {
    await wdioState.upstreamReplayServer.stop();
    wdioState.upstreamReplayServer = null;
  }
}

export function restoreE2EProviderEndpointEnv() {
  const endpointEnv = getE2EProviderEndpointEnv(
    configuredE2ESpecs,
    e2eProviderPresetName,
    wdioState.upstreamE2EHttpMode,
  );
  if (Object.keys(endpointEnv).length > 0) {
    // 修复原因：每轮 beforeSession 都会执行 mock 清理；请求安全 capture 与 live-team
    // 的生产控制面选择必须恢复，否则生产凭据会被送到测试域。
    Object.assign(process.env, endpointEnv);
    return;
  }
  restoreRequestSecurityEndpointEnv(
    process.env,
    e2eProviderPresetName,
    wdioState.upstreamE2EHttpMode,
  );
}

export function buildUpstreamE2EAnthropicBaseUrl() {
  const baseURL = wdioState.upstreamE2EBaseUrl.replace(/\/+$/u, "");
  return baseURL.endsWith("/anthropic") ? baseURL : `${baseURL}/anthropic`;
}
