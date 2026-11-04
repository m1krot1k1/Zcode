import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  type ModelConfigObject,
  type ModelId,
  type ModelSelection,
  type ModelSelectionFacade,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderConfigObject,
  type ProviderId,
  type ProviderSettingsFacade,
  type ProviderSettingsCreationResult,
  type ModelConfigResolution,
  type ProviderSettingsView,
  type ResolveModelConfigInput,
  type SavePersonalModelDraftInput,
} from "@zcode/provider";
import { createServiceDescriptor } from "../descriptors.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

export type {
  ProviderSettingsProviderView,
  ModelSelectionView,
  ModelSelectionViewInput,
  ProviderSettingsView,
} from "@zcode/provider";

/** 自动发现得到的最小模型信息；上游缺省字段保持可选，不把未知值写成配置事实。 */
export interface DiscoveredModel {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly reasoningEffort?: readonly string[];
}

export interface ProviderSettingsServiceOptions {
  /** 测试注入的网络实现；生产使用运行时 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 测试注入的时钟，供后续 models.dev 缓存复用。 */
  readonly now?: () => number;
}

export interface IProviderSettingsService {
  readonly onDidChange: Event<ProviderSettingsView>;
  getView(): Promise<ProviderSettingsView>;
  refresh(reason: string): Promise<ProviderSettingsView>;
  createPersonalProvider(
    input?: Parameters<ProviderSettingsFacade["createPersonalProvider"]>[0],
  ): Promise<ProviderSettingsCreationResult>;
  resolveModelConfig(input: ResolveModelConfigInput): Promise<ModelConfigResolution>;
  savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfigObject,
    metadata?: Parameters<ProviderSettingsFacade["savePersonalProviderOverlay"]>[2],
  ): Promise<ProviderSettingsView>;
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderSettingsView>;
  reorderPersonalProviders(providerIds: readonly ProviderId[]): Promise<ProviderSettingsView>;
  reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
  ): Promise<ProviderSettingsView>;
  addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfigObject,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderSettingsView>;
  renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
  ): Promise<ProviderSettingsView>;
  deletePersonalModel(providerId: ProviderId, modelId: ModelId): Promise<ProviderSettingsView>;
  savePersonalModelDraft(input: SavePersonalModelDraftInput): Promise<ProviderSettingsView>;
  setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
  ): Promise<ProviderSettingsView>;
  /** 测试已经保存并进入目标 Environment Registry 的正式 Model。 */
  testModelConnectivity(
    input: ProviderSettingsConnectivityRequest,
  ): Promise<ModelConnectivityResult>;
  /** 读取 Provider 的 /models 目录；任何网络、状态或解析失败都返回空数组。 */
  discoverProviderModels(providerId: ProviderId): Promise<DiscoveredModel[]>;
  /** 将发现结果写入个人模型并跳过已存在 ID，返回本次新增数量。 */
  importDiscoveredModels(providerId: ProviderId): Promise<number>;
}

export const IProviderSettingsService = createServiceDescriptor<IProviderSettingsService>(
  ServiceChannels.ProviderSettings,
);

export interface ProviderSettingsConnectivityTestInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export interface ProviderSettingsConnectivityRequest {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

export type ProviderSettingsConnectivityTester = (
  input: ProviderSettingsConnectivityTestInput,
) => Promise<ModelConnectivityResult>;

export interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export interface ModelSelectionConfiguredDefaultSource {
  read(): Promise<ModelSelection | undefined>;
  onDidChange?(listener: () => void): () => void;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);

export function createProviderSettingsService(
  facade: ProviderSettingsFacade,
  ensureReady: () => Promise<void> = async () => {},
  testConnectivity?: ProviderSettingsConnectivityTester,
  options: ProviderSettingsServiceOptions = {},
): IProviderSettingsService {
  const log = createServiceLogger("provider-settings");
  const fetchImpl = options.fetchImpl ?? fetch;
  // 发现结果只来自 Provider 自身的 /models 目录；不把内置模板或远端目录当作可用事实。
  const discoverProviderModels = async (providerId: ProviderId): Promise<DiscoveredModel[]> => {
    await ensureReady();
    const provider = facade.getView().providers.find((item) => item.providerId === providerId);
    if (!provider) return [];
    const baseUrl = readStringField(provider.effectiveConfig.api, "baseUrl");
    // 无 HTTP 端点的 Provider（如 SDK 直连）没有可探测的目录，按空结果处理。
    if (!baseUrl) return [];
    const apiKey = readStringField(provider.effectiveConfig.access, "apiKey");
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        log.warn(undefined, `Provider ${providerId} 模型目录返回状态 ${response.status}`);
        return [];
      }
      return normalizeDiscoveredModels(await response.json());
    } catch (error) {
      // 发现是可选增强能力；网络、超时和解析失败都收敛为空结果，不能阻断设置页其他操作。
      log.warn(undefined, `Provider ${providerId} 模型目录读取失败: ${String(error)}`);
      return [];
    }
  };
  return {
    onDidChange: toEvent((listener) => facade.onDidChange(listener)),
    getView: async () => {
      await ensureReady();
      return facade.getView();
    },
    refresh: async (reason) => {
      await ensureReady();
      return facade.refresh(reason);
    },
    createPersonalProvider: async (input) => {
      await ensureReady();
      return facade.createPersonalProvider(input);
    },
    resolveModelConfig: async (input) => {
      await ensureReady();
      return facade.resolveModelConfig(input);
    },
    savePersonalProviderOverlay: async (providerId, config, metadata) => {
      await ensureReady();
      return facade.savePersonalProviderOverlay(providerId, config, metadata);
    },
    deletePersonalProvider: async (providerId) => {
      await ensureReady();
      return facade.deletePersonalProvider(providerId);
    },
    reorderPersonalProviders: async (providerIds) => {
      await ensureReady();
      return facade.reorderPersonalProviders(providerIds);
    },
    reorderPersonalModels: async (providerId, modelIds) => {
      await ensureReady();
      return facade.reorderPersonalModels(providerId, modelIds);
    },
    addPersonalModel: async (providerId, modelId, config, useRecommendedConfig) => {
      await ensureReady();
      return facade.addPersonalModel(providerId, modelId, config, useRecommendedConfig);
    },
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => {
      await ensureReady();
      return facade.renamePersonalModel(providerId, currentModelId, nextModelId);
    },
    deletePersonalModel: async (providerId, modelId) => {
      await ensureReady();
      return facade.deletePersonalModel(providerId, modelId);
    },
    savePersonalModelDraft: async (input) => {
      await ensureReady();
      return facade.savePersonalModelDraft(input);
    },
    setPersonalModelEnabled: async (providerId, modelId, enabled) => {
      await ensureReady();
      return facade.setPersonalModelEnabled(providerId, modelId, enabled);
    },
    testModelConnectivity: async (input) => {
      await ensureReady();
      if (!testConnectivity) {
        throw new Error("当前 Environment 未装配模型连通性测试能力");
      }
      await facade.waitForProviderOperations(input.providerId);
      // 禁用对象仍存在于配置视图，但不进入执行 Registry；不能把未发布误报成配置丢失。
      // 只消费操作完成后的公共资格，不另查 Key、权益，也不替代目标 Environment 最终校验。
      const provider = facade
        .getView()
        .providers.find((item) => item.providerId === input.providerId);
      const model = provider?.models.find((item) => item.modelId === input.modelId);
      const unavailable =
        !provider || !provider.enabled
          ? "provider-unavailable"
          : !model || !model.enabled || model.issues.length > 0
            ? "model-unavailable"
            : !provider.executable
              ? "provider-unavailable"
              : !model.executable
                ? "model-unavailable"
                : undefined;
      if (unavailable) {
        return {
          success: false,
          error: {
            code: unavailable,
            message:
              unavailable === "provider-unavailable"
                ? "This provider is currently unavailable for connectivity testing."
                : "This model is currently unavailable for connectivity testing.",
          },
        };
      }
      return testConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        providerId: input.providerId,
        modelId: input.modelId,
      });
    },
    discoverProviderModels,
    importDiscoveredModels: async (providerId) => {
      const discovered = await discoverProviderModels(providerId);
      if (discovered.length === 0) return 0;
      const provider = facade.getView().providers.find((item) => item.providerId === providerId);
      if (!provider) return 0;
      const known = new Set(provider.models.map((model) => model.modelId));
      let added = 0;
      for (const model of discovered) {
        // 已在 Registry 中的 ID（内置或已导入）不重复写入，避免每次连接都追加同一模型。
        if (known.has(model.id)) continue;
        try {
          await facade.addPersonalModel(providerId, model.id, toDiscoveredModelConfig(model));
          known.add(model.id);
          added += 1;
        } catch (error) {
          // 单个模型的配置校验或写入失败不能回滚其他模型，逐项隔离并如实计数。
          log.warn(undefined, `Provider ${providerId} 模型 ${model.id} 导入失败: ${String(error)}`);
        }
      }
      return added;
    },
  };
}

export function createModelSelectionService(
  facade: ModelSelectionFacade,
  ensureReady: () => Promise<void> = async () => {},
  configuredDefaultSource?: ModelSelectionConfiguredDefaultSource,
): IModelSelectionService & { dispose(): void } {
  const log = createServiceLogger("model-selection");
  let revision = 0;
  let disposed = false;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  const getView = async (input?: ModelSelectionViewInput): Promise<ModelSelectionView> => {
    await ensureReady();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const configuredDefault = await configuredDefaultSource?.read();
    if (disposed) throw new Error("ModelSelectionService 已 dispose");
    const base = facade.getView(configuredDefault);
    if (revision < base.revision) revision = base.revision;
    return facade.getView(configuredDefault, revision, input);
  };
  const emit = (): void => {
    if (disposed) return;
    revision += 1;
    void getView().then(
      (view) => {
        if (disposed) return;
        for (const listener of listeners) listener(view);
      },
      (error: unknown) => {
        // Registry 事件触发的异步 View 重建没有 owner；Host dispose 后它仍会继续
        // 读取已释放的配置仓库，并形成未处理 rejection。dispose 是明确的取消边界；仅在服务
        // 仍存活时记录真实读取失败。
        if (disposed) return;
        log.warn(undefined, `ModelSelection View 刷新失败: ${String(error)}`);
      },
    );
  };
  const disposeFacade = facade.onDidChange(emit);
  const disposeConfiguredDefault = configuredDefaultSource?.onDidChange?.(emit);

  return {
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getView,
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeFacade();
      disposeConfiguredDefault?.();
      listeners.clear();
    },
  };
}

const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

function readObjectField(source: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringField(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInteger(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 上游目录格式不完全统一：只保留可验证字段，缺省或非法值直接省略。 */
function normalizeDiscoveredModels(payload: unknown): DiscoveredModel[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const models: DiscoveredModel[] = [];
  for (const entry of data) {
    const id = readStringField(entry, "id");
    if (!id) continue;
    const limit = readObjectField(entry, "limit");
    const reasoning = readObjectField(readObjectField(entry, "capabilities"), "reasoning");
    const reasoningEffort = normalizeReasoningEffort(reasoning);
    const contextWindow = readPositiveInteger(limit, "context");
    const maxOutput = readPositiveInteger(limit, "output");
    models.push(
      Object.freeze({
        id,
        displayName: readStringField(entry, "name") ?? id,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutput === undefined ? {} : { maxOutput }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }),
    );
  }
  return models;
}

function normalizeReasoningEffort(
  reasoning: Record<string, unknown> | undefined,
): readonly string[] | undefined {
  // 只有上游声明支持推理时才把档位当成配置事实，避免把残留字段写进模型选项。
  if (!reasoning || reasoning.supported !== true || !Array.isArray(reasoning.effort)) return undefined;
  const levels: string[] = [];
  for (const value of reasoning.effort) {
    if (typeof value !== "string") continue;
    const level = value.trim();
    if (level.length === 0 || levels.includes(level)) continue;
    levels.push(level);
  }
  return levels.length > 0 ? Object.freeze(levels) : undefined;
}

function toDiscoveredModelConfig(model: DiscoveredModel): ModelConfigObject {
  const optionSpecs: NonNullable<ModelConfigObject["optionSpecs"]> = {
    ...(model.reasoningEffort && model.reasoningEffort.length > 0
      ? { reasoningLevel: { values: [...model.reasoningEffort] } }
      : {}),
    ...(model.maxOutput === undefined ? {} : { maxOutputTokens: { max: model.maxOutput } }),
  };
  return {
    ...(model.contextWindow === undefined
      ? {}
      : { properties: { contextWindow: model.contextWindow } }),
    ...(Object.keys(optionSpecs).length === 0 ? {} : { optionSpecs }),
  };
}

function toEvent<T>(subscribe: (listener: (event: T) => void) => () => void): Event<T> {
  return (listener) => {
    const dispose = subscribe(listener);
    return { dispose };
  };
}
