// ============================================================
// Vercel AI SDK model execution — provider factory and binding
// ============================================================

import { withoutRequestVerificationHeaders } from "@zcode/shared";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import type { OpencodeProvider } from "ai-sdk-provider-opencode-sdk";
import {
  compileModelOptionMaps,
  type CompiledModelOptionMaps,
  type ModelOptionValues,
} from "@zcode/model-option-map";
import {
  type Logger,
  type ModelId,
  type ModelProviderId,
  type ModelRequestAuth,
  type ProviderEndpointRoutingPort,
  getCurrentModelInvocationContext,
} from "@zcode/contracts";
import type { RegistryModelConfig, RegistryProviderConfig } from "@zcode/provider";
import { withOpenRouterAttributionHeaders } from "@zcode/shared";
import { createAnthropicCompatFetch } from "../anthropic-stream-compat.js";
import { createModelRequestSecurityState } from "../request-security-edition/index.js";
import type { ModelRequestSecurityPort } from "../request-security.js";
import { createOpenAIResponsesJsonCompatFetch } from "../openai-responses-json-compat.js";
import {
  createModelOptionMapFetch,
  type RawRequestBodyCapture,
} from "../model-option-map-fetch.js";
import { createOpenAiCompatibleCacheControlFetch } from "../cache-control/index.js";
import { createProviderEndpointRoutingFetch } from "../provider-endpoint-routing-fetch.js";
import {
  mergeModelRequestHeaders,
  withoutModelAuthHeaders,
  withoutModelQuerySourceHeader,
} from "../model-request-headers.js";
import { createOpenCodeTaskBridge } from "../opencode-session.js";
import { formatProxyFallbackWarning, type ProxyFallbackNotice } from "../../network/proxy-fetch.js";
import {
  createProviderBusinessErrorFetch,
  createProviderProxyFetch,
} from "./provider-business-error-fetch.js";
import {
  OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS,
  assertOpenCodeWorkspaceDirectory,
  disposeAfterStream,
  getOpenCodeSkillExecutor,
  getOpenCodeTaskExecutor,
  projectOpenCodePrompt,
  sanitizeOpenCodeEmptyResponseError,
  sanitizeOpenCodeStreamErrors,
  type ExecuteOpenCodeSkill,
  type ExecuteOpenCodeTask,
  type OpenCodeInvocationProvider,
} from "./opencode-invocation.js";
import type {
  AiSdkBoundModelResolution,
  AiSdkModelExecutionConfig,
  AiSdkModelExecutionOptions,
  AiSdkNetworkConfig,
  AiSdkProviderConfig,
  AiSdkResolvedModel,
  EnvRecord,
  LanguageModelFactory,
  ProviderFetch,
} from "./types.js";

export class AiSdkModelExecution {
  private readonly env: EnvRecord;
  private readonly defaultHeaders: Record<string, string>;
  private readonly network: AiSdkNetworkConfig;
  private readonly endpointRoutingPort?: ProviderEndpointRoutingPort;
  private readonly logger?: Logger;
  private readonly baseTransport?: ProviderFetch;
  private readonly opencodeProvider?: OpencodeProvider;
  private readonly providerTransports = new Map<string, ProviderFetch>();
  private readonly requestSecurity: ModelRequestSecurityPort;

  constructor(config: AiSdkModelExecutionConfig = {}, options: AiSdkModelExecutionOptions = {}) {
    this.env = config.env ?? process.env;
    this.defaultHeaders = { ...config.defaultHeaders };
    this.network = { ...config.network };
    this.endpointRoutingPort = config.endpointRoutingPort;
    this.logger = options.logger;
    this.baseTransport = options.transport;
    this.opencodeProvider = options.opencodeProvider;
    this.requestSecurity = (
      options.requestSecurityState ?? createModelRequestSecurityState()
    ).createExecution({ logger: options.logger });
  }

  /**
   * 固定一个 Model 创建时使用的 Provider 静态事实。
   *
   * 请求期鉴权只覆盖 API Key 与 Header；Registry 后续热更新不会让已经创建的
   * Model 静默切换 Endpoint、协议、Provider Options 或 SDK Factory。
   */
  bindModel(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly modelApi?: RegistryModelConfig["api"];
    readonly supportsJsonSchemaOutput: boolean;
    readonly optionSpecs: {
      readonly reasoningLevel: { readonly map: string };
      readonly maxOutputTokens: { readonly map: string };
    };
  }): AiSdkBoundModelResolution {
    const snapshot = this.captureModelSnapshot(input);
    const optionMaps = compileModelOptionMaps(input.optionSpecs);
    return {
      // 这里只构造不执行请求的基础 Model；真正请求必须通过 resolveRequest 绑定完整 options。
      resolved: this.resolveSnapshot(snapshot, undefined, undefined, undefined),
      resolveRequest: ({ options, requestAuth }) =>
        this.resolveSnapshot(snapshot, requestAuth, optionMaps, options),
    };
  }

  private captureModelSnapshot(input: {
    readonly providerId: string;
    readonly modelId: string;
    readonly providerConfig: RegistryProviderConfig;
    readonly modelApi?: RegistryModelConfig["api"];
    readonly supportsJsonSchemaOutput: boolean;
  }): AiSdkModelSnapshot {
    const configuredProvider = toAiSdkProviderConfig(
      input.providerId,
      input.providerConfig,
      input.modelApi,
    );
    // 重构后模型 SDK 曾只接到用户 Header，漏掉版本和站点归因；在公共绑定边界恢复，
    // 不依赖签名成功，不给各业务重复补头，也不修改 Provider 或已绑定 Model 的配置。
    if (configuredProvider.kind !== "opencode-sdk") {
      configuredProvider.headers = mergeModelRequestHeaders(
        withOpenRouterAttributionHeaders(this.defaultHeaders, configuredProvider.baseURL),
        configuredProvider.headers,
      );
    }
    const apiKey = this.resolveApiKey(configuredProvider);
    return {
      providerConfig: {
        ...configuredProvider,
        ...(apiKey ? { apiKey } : {}),
        ...(configuredProvider.headers ? { headers: { ...configuredProvider.headers } } : {}),
        ...(configuredProvider.providerOptions
          ? { providerOptions: { ...configuredProvider.providerOptions } }
          : {}),
      },
      providerId: input.providerId as ModelProviderId,
      modelId: input.modelId as ModelId,
      supportsJsonSchemaOutput: input.supportsJsonSchemaOutput,
    };
  }

  private resolveSnapshot(
    snapshot: AiSdkModelSnapshot,
    requestAuth: ModelRequestAuth | undefined,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
  ): AiSdkResolvedModel {
    const providerConfig = applyModelRequestAuth(snapshot.providerConfig, requestAuth);
    // Model 创建时的 Provider 事实必须被冻结在当前 binding 中。若按 providerId 缓存
    // factory，配置更新后创建的新 Model 会错误复用旧 Endpoint / Header / API Key。
    const rawRequestBodyCapture: RawRequestBodyCapture = {};
    const factory = this.createFactory(
      snapshot.providerId,
      providerConfig,
      optionMaps,
      optionValues,
      rawRequestBodyCapture,
      snapshot.supportsJsonSchemaOutput,
      snapshot.providerConfig.access?.type === "zhipu-account" ? requestAuth?.apiKeyId : undefined,
    );
    return {
      baseURL: providerConfig.baseURL,
      headers: providerConfig.headers,
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      model: factory(snapshot.modelId.toString()),
      providerKind: providerConfig.kind,
      providerOptions: providerConfig.providerOptions,
      rawRequestBodyCapture,
      requestObservations: this.requestSecurity,
    };
  }

  private createFactory(
    providerId: string,
    providerConfig: AiSdkProviderConfig,
    optionMaps: CompiledModelOptionMaps | undefined,
    optionValues: ModelOptionValues | undefined,
    rawRequestBodyCapture: RawRequestBodyCapture,
    supportsJsonSchemaOutput: boolean,
    apiKeyId?: string,
  ): LanguageModelFactory {
    if (providerConfig.kind === "opencode-sdk") {
      if (!this.opencodeProvider) {
        throw new Error("OpenCode SDK provider is not initialized by the owning process");
      }
      return (modelId) => {
        // OpenCode tools 已由 OpenCode server 执行；模型流原样经过 ZCode adapter，
        // 由 providerExecuted 标记阻止 ZCode tool runner 二次派发。
        const getWorkingDirectory = () => {
          const context = getCurrentModelInvocationContext() as
            | (ReturnType<typeof getCurrentModelInvocationContext> & {
                workingDirectory?: string;
              })
            | undefined;
          return context?.workingDirectory;
        };
        const createModel = (workingDirectory = getWorkingDirectory()) => {
          const reasoningVariant = optionValues?.reasoningLevel;
          // Причина: OpenCode variants задают thinking модели; option map `{}` сам их в SDK не передаёт.
          const settings = {
            ...(workingDirectory ? { directory: workingDirectory } : {}),
            ...(reasoningVariant && reasoningVariant !== "disabled"
              ? { variant: reasoningVariant }
              : {}),
          };
          return this.opencodeProvider!(
            modelId,
            Object.keys(settings).length > 0 ? settings : undefined,
          );
        };
        const createInvocation = async (
          options: LanguageModelV3CallOptions,
          executeTask: ExecuteOpenCodeTask | undefined,
          executeSkill: ExecuteOpenCodeSkill | undefined,
        ) => {
          const openCodeAgentTypes = getCurrentModelInvocationContext()?.openCodeAgentTypes;
          // Роли берём из Core snapshot, который Core повторно проверяет перед запуском Task.
          // При пустом каталоге делегирование закрывается, без generic fallback.
          if (executeTask && (!openCodeAgentTypes || openCodeAgentTypes.length === 0)) {
            executeTask = undefined;
          }
          if (!executeTask && !executeSkill) {
            return { model: createModel(), dispose: async () => {} };
          }
          const bridge = await createOpenCodeTaskBridge(
            { executeTask, executeSkill, allowedAgentTypes: openCodeAgentTypes },
            options.abortSignal,
            this.logger,
          );
          this.logger?.debug("OpenCode invocation MCP configuration prepared", {
            bridgeId: bridge.bridgeId,
            event: "opencode.mcp.invocation",
            mcpName: "zcode",
            mcpTimeoutMs: OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS,
            status: "started",
          });
          const invocationProvider = this.opencodeProvider as OpenCodeInvocationProvider;
          if (!invocationProvider.createInvocationModel) {
            await bridge.dispose();
            throw new Error("opencode.task-bridge-unavailable");
          }
          try {
            const invocation = await invocationProvider.createInvocationModel(
              modelId,
              getWorkingDirectory() ? { directory: getWorkingDirectory() } : {},
              bridge,
            );
            let disposed = false;
            return {
              model: invocation.model,
              dispose: async () => {
                if (disposed) return;
                disposed = true;
                try {
                  await bridge.dispose();
                } finally {
                  await invocation.dispose();
                }
              },
            };
          } catch (error) {
            await bridge.dispose();
            throw error;
          }
        };
        const invokeOpenCode = (
          options: LanguageModelV3CallOptions,
          zcodeTaskEnabled: boolean,
          zcodeSkillEnabled: boolean,
        ) => ({
          ...options,
          prompt: projectOpenCodePrompt(options.prompt, zcodeTaskEnabled, zcodeSkillEnabled),
        });
        const initialModel = createModel();
        return {
          ...initialModel,
          doGenerate: async (options: LanguageModelV3CallOptions) => {
            const workingDirectory = getWorkingDirectory();
            await assertOpenCodeWorkspaceDirectory(workingDirectory);
            let invocation: Awaited<ReturnType<typeof createInvocation>> | undefined;
            try {
              const executeTask = getOpenCodeTaskExecutor();
              const executeSkill = getOpenCodeSkillExecutor();
              invocation = await createInvocation(options, executeTask, executeSkill);
              return await invocation.model.doGenerate(
                invokeOpenCode(options, Boolean(executeTask), Boolean(executeSkill)),
              );
            } catch (error) {
              throw sanitizeOpenCodeEmptyResponseError(error);
            } finally {
              await invocation?.dispose();
            }
          },
          doStream: async (options: LanguageModelV3CallOptions) => {
            const workingDirectory = getWorkingDirectory();
            await assertOpenCodeWorkspaceDirectory(workingDirectory);
            let invocation: Awaited<ReturnType<typeof createInvocation>> | undefined;
            try {
              const executeTask = getOpenCodeTaskExecutor();
              const executeSkill = getOpenCodeSkillExecutor();
              invocation = await createInvocation(options, executeTask, executeSkill);
              const result = await invocation.model.doStream(
                invokeOpenCode(options, Boolean(executeTask), Boolean(executeSkill)),
              );
              return {
                ...result,
                stream: disposeAfterStream(
                  sanitizeOpenCodeStreamErrors(result.stream),
                  invocation.dispose,
                ),
              };
            } catch (error) {
              await invocation?.dispose();
              throw sanitizeOpenCodeEmptyResponseError(error);
            }
          },
        } as LanguageModel;
      };
    }
    if (!providerConfig.baseURL) {
      throw new Error(`Provider API base URL is missing: ${providerId}`);
    }
    const httpProviderConfig = { ...providerConfig, baseURL: providerConfig.baseURL };
    const apiKey = this.resolveApiKey(providerConfig);
    // SDK 会合并 factory 默认 header；必须在这里去掉静态来源，才能保证缺失时真正省略。
    const headers = withoutModelQuerySourceHeader(providerConfig.headers);
    const networkTransport = this.resolveProviderTransport(providerId);
    // ID 属于当前 attempt，不能放入按 Provider 缓存的 transport，避免切换账号后串用。
    const providerTransport = this.endpointRoutingPort
      ? createProviderEndpointRoutingFetch({
          fetch: networkTransport,
          routingPort: this.endpointRoutingPort,
          apiKeyId,
        })
      : networkTransport;
    const requestTransport = this.requestSecurity.protectTransport({
      providerId,
      providerConfig: httpProviderConfig,
      transport: providerTransport,
    });
    const fetch = createProviderBusinessErrorFetch({
      fetch: requestTransport,
      providerId,
      providerKind: providerConfig.kind,
    });
    const optionFetch =
      optionMaps && optionValues
        ? createModelOptionMapFetch({
            capture: rawRequestBodyCapture,
            fetch,
            maps: optionMaps,
            values: optionValues,
          })
        : fetch;

    switch (providerConfig.kind) {
      case "openai": {
        const provider = createOpenAI({
          apiKey,
          baseURL: providerConfig.baseURL,
          fetch: createOpenAIResponsesJsonCompatFetch(optionFetch),
          headers,
        });
        return provider.responses as LanguageModelFactory;
      }

      case "anthropic": {
        const provider = createAnthropic({
          apiKey,
          baseURL: normalizeAnthropicBaseURL(providerConfig.baseURL),
          fetch: createAnthropicCompatFetch(optionFetch),
          headers: withAnthropicAuthorizationHeader(apiKey, headers),
        });
        return provider as LanguageModelFactory;
      }

      case "openai-compatible": {
        const provider = createOpenAICompatible<string, string, string, string>({
          name: providerConfig.name ?? providerId,
          baseURL: providerConfig.baseURL,
          apiKey,
          // Причина: @ai-sdk/openai-compatible теряет providerOptions.anthropic.cacheControl при сериализации;
          // инжектируем до 4 квантованных точек cache_control на уровне wire JSON для OpenRouter/DashScope семейств.
          fetch: createOpenAiCompatibleCacheControlFetch({
            baseURL: providerConfig.baseURL,
            capture: rawRequestBodyCapture,
            fetch: optionFetch,
            providerId,
          }),
          headers,
          // OpenAI Compatible 流式 usage 需要显式请求，Usage 是执行结果的一部分。
          includeUsage: true,
          // 缺少这一装配时 SDK 默认 false，会把已声明支持的 Schema 静默降为 JSON object。
          // 使用 binding 冻结的模型事实，不按供应商或实时 Registry 另查一套能力。
          supportsStructuredOutputs: supportsJsonSchemaOutput,
        });
        return provider as LanguageModelFactory;
      }
    }
  }

  /** OpenCode provider 生命周期由 owning process 显式结束。 */
  async dispose(): Promise<void> {
    await this.opencodeProvider?.dispose();
  }

  private resolveApiKey(providerConfig: AiSdkProviderConfig): string | undefined {
    return providerConfig.apiKey;
  }

  private resolveProviderTransport(providerId: string): ProviderFetch {
    const current = this.providerTransports.get(providerId);
    if (current) {
      return current;
    }
    const networkTransport = createProviderProxyFetch({
      caCertFile: this.network.caCertFile,
      env: this.env,
      fetch: this.baseTransport,
      httpProxy: this.network.httpProxy,
      noProxy: this.network.noProxy,
      // 原因：прокси-кольцо может уйти напрямую без ошибки модели. Варнинг нефатальный,
      // но пользователь должен видеть, какой вход умер: только host:port, без креденшелов.
      onProxyFallback: (notice: ProxyFallbackNotice) => {
        this.logger?.warn(formatProxyFallbackWarning(notice), {
          proxy: notice.proxy,
          proxyFallback: notice.direct ? "direct" : "next-proxy",
        });
      },
    });
    this.providerTransports.set(providerId, networkTransport);
    return networkTransport;
  }
}

interface AiSdkModelSnapshot {
  readonly supportsJsonSchemaOutput: boolean;
  readonly providerConfig: AiSdkProviderConfig;
  readonly providerId: ModelProviderId;
  readonly modelId: ModelId;
}

function toAiSdkProviderConfig(
  providerId: string,
  config: RegistryProviderConfig,
  modelApi?: RegistryModelConfig["api"],
): AiSdkProviderConfig {
  const api = modelApi ?? config.api;
  if (api.type === "opencode-sdk") {
    return {
      kind: "opencode-sdk",
      access: config.access,
    };
  }
  if (typeof api.baseUrl !== "string") {
    throw new Error(`Provider API base URL is missing: ${providerId}`);
  }
  const common = {
    ...(config.access.type !== "zhipu-account" &&
    config.access.type !== "local-auth" &&
    config.access.apiKey
      ? { apiKey: config.access.apiKey }
      : {}),
    baseURL: api.baseUrl,
    ...(config.api.headers ? { headers: { ...config.api.headers } } : {}),
    providerOptions: { apiFormat: api.type },
    access: config.access,
  };
  switch (api.type) {
    case "anthropic-messages":
      return { kind: "anthropic", ...common };
    case "openai-responses":
      return { kind: "openai", ...common };
    case "openai-chat-completions":
      return { kind: "openai-compatible", name: providerId, ...common };
  }
  throw new Error(`Unsupported Provider API type: ${String(api.type)}`);
}

function applyModelRequestAuth(
  providerConfig: AiSdkProviderConfig,
  requestAuth: ModelRequestAuth | undefined,
): AiSdkProviderConfig {
  if (!requestAuth) return providerConfig;
  const staticHeaders = withoutRequestVerificationHeaders(providerConfig.headers);
  // 账号动态身份头必须先清理静态认证头，避免 SDK 优先使用旧凭据。
  const headers =
    providerConfig.access.type === "zhipu-account"
      ? withoutModelAuthHeaders(staticHeaders)
      : staticHeaders;
  return {
    ...providerConfig,
    ...(requestAuth.apiKey ? { apiKey: requestAuth.apiKey } : {}),
    headers: mergeModelRequestHeaders(headers, requestAuth.headers),
  };
}

const AUTHORIZATION_HEADER_NAME = "Authorization";

function withAnthropicAuthorizationHeader(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!apiKey || hasHeader(headers, AUTHORIZATION_HEADER_NAME)) {
    return headers;
  }

  // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；显式配置的 Authorization 保持优先。
  return {
    [AUTHORIZATION_HEADER_NAME]: `Bearer ${apiKey}`,
    ...headers,
  };
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
}

function normalizeAnthropicBaseURL(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = pathname;
      return url.href;
    }

    // Anthropic's AI SDK provider appends /messages to baseURL, so explicit
    // gateway roots must include the /v1 API prefix at the adapter boundary.
    url.pathname = `${pathname}/v1`;
    return url.href;
  } catch {
    const withoutTrailingSlash = trimmed.replace(/\/+$/u, "");
    return withoutTrailingSlash.toLowerCase().endsWith("/v1")
      ? withoutTrailingSlash
      : `${withoutTrailingSlash}/v1`;
  }
}
