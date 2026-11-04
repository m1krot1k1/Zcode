import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { Model } from "@zcode/contracts";
import {
  createProviderQuotaFallbackModel,
  selectProviderFallbackCandidates,
  type AgentRuntimeDeps,
  type ProviderFallbackEvent,
  type ProviderModelClassFacts,
} from "@zcode/core";
import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
  /** 配额耗尽切换 Provider 时回调，用于日志/遥测；事件本身也会带在 status 上。 */
  readonly onProviderFallback?: (event: ProviderFallbackEvent) => void;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  readonly #onProviderFallback?: (event: ProviderFallbackEvent) => void;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
    this.#onProviderFallback = options.onProviderFallback;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createFallbackModel(provider, registryModel, target);
  };

  /**
   * 配额耗尽时按 Registry 顺序找同类模型；用户显式「只用这个 Provider」时不切换。
   * 候选最多 3 个（含当前），且只创建已通过可执行性校验的模型。
   */
  #createFallbackModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const primary: Model = this.#createRegistryModel(provider, registryModel, target);
    const options = target.selection.options;
    if (options?.providerFallback === "disabled") return primary;
    const facts = this.#collectProviderFacts();
    const source = facts.find(
      (fact) => fact.providerId === provider.providerId && fact.modelId === registryModel.modelId,
    );
    if (!source) return primary;
    const providerCount = new Set(facts.map((fact) => fact.providerId)).size;
    const candidates = selectProviderFallbackCandidates({
      source,
      providers: facts,
      ...(options?.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: options.reasoningLevel }),
      maxAttempts: Math.min(providerCount, 3),
    });
    const fallbacks = candidates.flatMap((candidate) => {
      const candidateProvider = this.#registry.getProvider(candidate.providerId);
      const candidateModel = this.#registry.getModel(candidate.providerId, candidate.modelId);
      if (!candidateProvider || !candidateModel) return [];
      return [
        {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          model: this.#createRegistryModel(candidateProvider, candidateModel, {
            ...target,
            selection: {
              ...target.selection,
              providerId: candidate.providerId,
              modelId: candidate.modelId,
            },
          }),
        },
      ];
    });
    return createProviderQuotaFallbackModel({
      primary: {
        providerId: provider.providerId,
        modelId: registryModel.modelId,
        model: primary,
      },
      fallbacks,
      maxAttempts: Math.min(providerCount, 3),
      ...(this.#onProviderFallback ? { onFallback: this.#onProviderFallback } : {}),
    });
  }

  #collectProviderFacts(): ProviderModelClassFacts[] {
    return this.#registry.getView().providers.flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.providerId,
        modelId: model.modelId,
        hidden: provider.config.visibility === "hidden",
        ...(model.config.properties?.contextWindow === undefined
          ? {}
          : { contextWindow: model.config.properties.contextWindow }),
        ...(model.config.properties?.supportsToolCall === undefined
          ? {}
          : { supportsToolCall: model.config.properties.supportsToolCall }),
        ...(model.config.properties?.supportsJsonSchemaOutput === undefined
          ? {}
          : { supportsJsonSchemaOutput: model.config.properties.supportsJsonSchemaOutput }),
        ...(model.config.properties?.inputFormat == null
          ? {}
          : { inputFormat: model.config.properties.inputFormat }),
        ...(model.config.optionSpecs?.reasoningLevel?.values == null
          ? {}
          : { reasoningLevels: model.config.optionSpecs.reasoningLevel.values }),
      })),
    );
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    // 修复依据：Registry 校验只保证「provider/model 存在且选项合法」，历史或协议 Selection 可能
    // 根本没有 options；原来的 `options!.reasoningLevel!` 会在这里抛 TypeError（读 undefined 的
    // 属性），把「模型选择不完整」误报成运行时崩溃。这里只做安全读取，缺值仍由上游 guard 拒绝。
    const normalReasoningLevel = target.selection.options?.reasoningLevel;
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      // Off-Peak 与 Highspeed 都靠执行作用域的动态 requestAuth（JWT / 计划 Key / 卡 ID header）
      // 发送，必须把承载它的 source 透传给 adapter。此门禁与 runner.ts 的 requestAuthRequired
      // 门禁一一对应：漏掉 highspeed 会在这里丢掉 source，导致 runner 端 requestAuth 缺失、
      // 本轮在发送前抛 model_request_auth_missing。
      ...(provider.config.access.type === "zhipu-account" &&
      (provider.config.access.mode === "off-peak" ||
        provider.config.access.mode === "highspeed")
        ? {
            requestDependencies: {
              requestAuth: {
                source: target.requestDependencies?.requestAuth?.source,
              },
            },
          }
        : {}),
      options: {
        reasoningLevel: normalReasoningLevel,
      },
    });
  }
}
