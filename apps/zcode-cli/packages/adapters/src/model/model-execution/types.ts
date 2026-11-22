// ============================================================
// Vercel AI SDK model execution — shared types
// ============================================================

import type { LanguageModel } from "ai";
import type { OpencodeProvider } from "ai-sdk-provider-opencode-sdk";
import type { ModelOptionValues } from "@zcode/model-option-map";
import type {
  Logger,
  ModelId,
  ModelProviderId,
  ModelRequestAuth,
  ProviderEndpointRoutingPort,
} from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import type { RawRequestBodyCapture } from "../model-option-map-fetch.js";
import type { ModelRequestSecurityPort, ModelRequestSecurityState } from "../request-security.js";

export type AiSdkProviderKind = "openai" | "anthropic" | "openai-compatible" | "opencode-sdk";
type AiSdkModelExecutionKind = AiSdkProviderKind;

export type EnvRecord = Record<string, string | undefined>;

export interface AiSdkProviderConfig {
  access: RegistryProviderConfig["access"];
  kind: AiSdkModelExecutionKind;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  name?: string;
}

export interface AiSdkModelExecutionConfig {
  /** 执行环境提供的默认来源信息，不属于 Provider 持久化配置。 */
  defaultHeaders?: Readonly<Record<string, string>>;
  endpointRoutingPort?: ProviderEndpointRoutingPort;
  env?: EnvRecord;
  network?: AiSdkNetworkConfig;
}

export interface AiSdkModelExecutionOptions {
  /** 由 owning process 创建并注入；执行适配器不导入包级 singleton。 */
  opencodeProvider?: OpencodeProvider;
  requestSecurityState?: ModelRequestSecurityState;
  logger?: Logger;
  transport?: ProviderFetch;
}

export interface AiSdkNetworkConfig {
  caCertFile?: string;
  httpProxy?: string;
  noProxy?: string;
}

export interface AiSdkResolvedModel {
  baseURL?: string;
  headers?: Record<string, string>;
  providerId: ModelProviderId;
  modelId: ModelId;
  model: LanguageModel;
  providerKind: AiSdkProviderKind;
  providerOptions?: Record<string, unknown>;
  rawRequestBodyCapture?: RawRequestBodyCapture;
  requestObservations?: ModelRequestSecurityPort;
}

export interface AiSdkBoundModelResolution {
  readonly resolved: AiSdkResolvedModel;
  resolveRequest(input: {
    readonly options: ModelOptionValues;
    readonly requestAuth?: ModelRequestAuth;
  }): AiSdkResolvedModel;
}

export type LanguageModelFactory = (modelId: string) => LanguageModel;
export type ProviderFetch = typeof globalThis.fetch;
export type ProviderCode = string | number;
