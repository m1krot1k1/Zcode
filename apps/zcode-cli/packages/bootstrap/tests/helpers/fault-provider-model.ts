/**
 * 把假 provider 服务器接成一条**真**的模型链（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）：
 * 真 `ProviderRegistry`（一个 api-key provider 指向假服务器）→ 真 `AiSdkModelAdapter`（真 fetch、
 * 极小的重试底延迟）→ 真 `ApiProviderModelRuntime.modelFactory`。矩阵与自测都从这里拿模型，
 * 于是 3008 事故走过的那条 HTTP 解析路径（fetch 包装 → 业务码 → runner → driver）一段不少。
 *
 * `createModelAdapter`（bootstrap/src/model-factory.ts）不透出 retry 选项，所以这里直接 new。
 * `env: {}` 是刻意的：proxy-aware fetch 没有 env 时会读 process.env，开发机上的 HTTP_PROXY
 * 会把回环请求劫走。
 */

import { AiSdkModelAdapter, type AiSdkModelRetryOptions } from "@zcode/adapters/model";
import type { ModelStatusSink } from "@zcode/contracts";
import {
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type ModelSelection,
  type Provider,
} from "@zcode/provider";
import {
  ApiProviderModelRuntime,
  type RuntimeModelFactory,
} from "../../src/app/provider-registry-model-runtime.js";
import { createApiKeyProviderConfig } from "../provider-config-fixtures.js";
import type { WireFormat } from "./fake-provider-server.js";

export const FAULT_PROVIDER_ID = "fault-test";
export const FAULT_MODEL_ID = "alpha";
/** governor 桶的 key（`workflowConcurrencyKey`）。 */
export const FAULT_CONCURRENCY_KEY = `${FAULT_PROVIDER_ID}/${FAULT_MODEL_ID}`;
const FAULT_REASONING_LEVEL = "medium";

/** 矩阵里每个 actor runtime 的 selection；factory 直接解引用 `options.reasoningLevel`，所以必须带。 */
export const FAULT_MODEL_SELECTION: ModelSelection = {
  providerId: FAULT_PROVIDER_ID,
  modelId: FAULT_MODEL_ID,
  options: { reasoningLevel: FAULT_REASONING_LEVEL },
} as ModelSelection;

/** 矩阵的步调杠杆之一：runner 的本地退避从 10ms 起、50ms 封顶（无上限预算下 maxAttempts 不生效）。 */
const FAULT_RETRY_OPTIONS: AiSdkModelRetryOptions = {
  backoffFactor: 2,
  baseDelayMs: 10,
  jitter: true,
  maxAttempts: 8,
  maxDelayMs: 50,
};

/**
 * hang 判决靠它变成一次 stream_idle_timeout 重试。注意：每次重试 +30s（stream-idle-timeout.ts 的增量）。
 * 只有 B6 行显式选它；默认关闭（见 `DEFAULT_FAULT_STREAM_IDLE_TIMEOUT_MS`）。
 */
export const FAULT_HANG_STREAM_IDLE_TIMEOUT_MS = 300;

/**
 * 缺省关闭 stream idle 看门狗。
 *
 * 根因：它原本缺省 300ms，而这是一条**真实墙钟**定时器（`readNextWithStreamIdleTimeout`）；
 * 矩阵的断言按「假服务器注入了几次故障」精确计数（`failed === rejected`、`requests = logical + n`）。
 * 全套 819 个文件并行跑时事件循环会被压住几百毫秒，请求已到本地回环但读取回调还没轮到，
 * 看门狗先把这次尝试 abort 成 `stream_idle_timeout` 并重试——矩阵于是多出一次真实重试，
 * 计数断言在无任何产品缺陷的情况下失败（本机复现：每 60ms 阻塞 150ms 即稳定多出 2 次）。
 *
 * 该看门狗不是矩阵要验证的行为，只有 B6「挂起 → 流空闲超时」行需要它，因此默认 0（禁用），
 * 由 B6 显式传 {@link FAULT_HANG_STREAM_IDLE_TIMEOUT_MS}。
 */
const DEFAULT_FAULT_STREAM_IDLE_TIMEOUT_MS = 0;

export interface FaultProviderModelOptions {
  baseURL: string;
  apiFormat: WireFormat;
  statusSink?: ModelStatusSink;
  retry?: AiSdkModelRetryOptions;
  streamIdleTimeoutMs?: number;
}

function faultModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      // 两种 wire 都认 max_tokens；reasoningLevel 不映射到请求体，免得假服务器收到未知字段。
      maxOutputTokens: { max: 1_000_000, map: '{"max_tokens": maxOutputTokens}' },
      reasoningLevel: { values: ["disabled", FAULT_REASONING_LEVEL], map: "{}" },
    }),
  });
}

function createFaultProviderRegistry(options: {
  baseURL: string;
  apiFormat: WireFormat;
}): ProviderRegistry {
  const provider: Provider = {
    providerId: FAULT_PROVIDER_ID,
    config: createApiKeyProviderConfig({
      apiFormat: options.apiFormat,
      apiKey: "fault-test-key",
      baseURL: options.baseURL,
      models: [FAULT_MODEL_ID],
    }),
    models: [{ modelId: FAULT_MODEL_ID, config: faultModelConfig() }],
  } as unknown as Provider;
  return new ProviderRegistry([provider]);
}

function createFaultModelAdapter(options: FaultProviderModelOptions): AiSdkModelAdapter {
  return new AiSdkModelAdapter({
    env: {},
    retry: options.retry ?? FAULT_RETRY_OPTIONS,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DEFAULT_FAULT_STREAM_IDLE_TIMEOUT_MS,
    ...(options.statusSink === undefined ? {} : { statusSink: options.statusSink }),
  });
}

export function createFaultModelFactory(options: FaultProviderModelOptions): {
  modelFactory: RuntimeModelFactory;
  adapter: AiSdkModelAdapter;
  registry: ProviderRegistry;
  dispose(): void;
} {
  const registry = createFaultProviderRegistry(options);
  const adapter = createFaultModelAdapter(options);
  const runtime = new ApiProviderModelRuntime({ registry, modelAdapter: adapter });
  runtime.start();
  return {
    modelFactory: runtime.modelFactory,
    adapter,
    registry,
    dispose: () => runtime.dispose(),
  };
}
