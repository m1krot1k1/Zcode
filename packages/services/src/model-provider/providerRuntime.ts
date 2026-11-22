import {
  NodeModelSelectionConfigRepository,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  LocalAuthAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistryService,
  ProviderSettingsFacade,
  createFailClosedAccountProviderConfigSnapshot,
  buildCursorReasoningMap,
  groupCursorModels,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSettingsMutationTarget,
  type Provider,
  type ProviderSource,
  type RuntimeProviderCatalogSnapshot,
} from "@zcode/provider";
import { cursorRuntimeModelIdSchema, opencodeRuntimeModelIdSchema } from "@zcode/shared";
import {
  createProviderConfigRuntime,
  type ProviderConfigRuntime,
  type ProviderConfigRuntimeOptions,
} from "./providerConfigRuntime.js";
import {
  createModelSelectionService,
  createProviderSettingsService,
  type IModelSelectionService,
  type IProviderSettingsService,
  type ModelSelectionConfiguredDefaultSource,
  type ProviderSettingsConnectivityTester,
} from "./providerFacadeServices.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  IOpenCodeAcpRuntime,
  OpenCodeCliModelDescriptor,
} from "../opencode-acp-runtime/contract.js";
import type {
  ICursorCliRuntime,
  CursorCliModelDescriptor,
} from "../cursor-cli-runtime/contract.js";
import type { ObservableSettingService } from "../setting/observableSettingService.js";

const log = createServiceLogger("provider-runtime");

const OPENCODE_CLI_PROVIDER_ID = "opencode" as const;
const CURSOR_CLI_PROVIDER_ID = "cursor" as const;

/** Host-owned projection of the local OpenCode CLI into the shared model catalog. */
export class OpenCodeCliProviderCatalogSource implements ProviderSource<RuntimeProviderCatalogSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #disposeSettings: () => void;

  constructor(
    private readonly settings: ObservableSettingService,
    private readonly runtime: Pick<IOpenCodeAcpRuntime, "getCliStatus" | "listModels">,
  ) {
    this.#disposeSettings = settings.onDidUpdate((event) => {
      if (event.keys.includes("openCodeCliEnabled")) this.#emit("setting-updated");
    });
  }

  async read(): Promise<RuntimeProviderCatalogSnapshot> {
    const settings = await this.settings.get();
    if (settings.openCodeCliEnabled !== true) return emptyOpenCodeSnapshot("disabled");

    // 根因：CLI/catalog 抛错会拒绝整次 Registry refresh，已配置的 API Provider 也无法发布。
    // 修复：刷新失败是可重试的空快照；OpenCode 不进入选择器，其它 Provider 照常合并。
    try {
      return await this.#readEnabledCatalog();
    } catch {
      return emptyOpenCodeSnapshot("models-unavailable");
    }
  }

  async #readEnabledCatalog(): Promise<RuntimeProviderCatalogSnapshot> {
    const status = await this.runtime.getCliStatus();
    if (status.status !== "available") return emptyOpenCodeSnapshot(`cli-${status.status}`);
    const catalog = await this.runtime.listModels();
    if (catalog.status !== "available") return emptyOpenCodeSnapshot(`models-${catalog.status}`);

    const models = catalog.models.filter(
      (model) => opencodeRuntimeModelIdSchema.safeParse(model.modelId).success,
    );
    if (models.length === 0) return emptyOpenCodeSnapshot(`models-empty:${status.version}`);
    const provider = createOpenCodeProvider(models);
    return Object.freeze({
      revision: `opencode:${status.version}:${status.executablePath}:${models
        .map((model) => `${model.modelId}:${model.reasoningVariants?.join(",") ?? ""}`)
        .join("\n")}`,
      providers: Object.freeze([provider]),
      cliExecutablePath: status.executablePath,
    });
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposeSettings();
    this.#listeners.clear();
  }

  /** Установка CLI не меняет настройку; источник отдельно инвалидируется владельцем. */
  async refresh(reason = "manual-refresh"): Promise<RuntimeProviderCatalogSnapshot> {
    this.#emit(reason);
    return this.read();
  }

  #emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

function createOpenCodeProvider(catalogModels: readonly OpenCodeCliModelDescriptor[]): Provider {
  const providerConfigResult = createRegistryProviderConfig(
    new ProviderConfig({
      group: "standard-personal",
      access: new LocalAuthAccessConfig(),
      api: new ProviderApiConfig({ type: "opencode-sdk" }),
    }),
    [OPENCODE_CLI_PROVIDER_ID],
  );
  if (!providerConfigResult.ok) {
    throw new Error(
      `OpenCode CLI provider config is invalid: ${providerConfigResult.issues[0]?.message}`,
    );
  }

  const models = catalogModels.map((model) => {
    const modelConfigResult = createRegistryModelConfig(
      new ModelConfig({
        enabled: true,
        // 修复依据：Registry 的模型配置必须完整；仅投影 CLI 的已验证 metadata，避免一条 ID 使整个目录刷新失败。
        properties: new ModelPropertiesConfig({
          requiresMfjsToolSchema: false,
          contextWindow: model.contextWindow,
          inputFormat: model.inputFormat,
          outputFormat: { supportsText: model.outputSupportsText },
          // OpenCode SDK валидирует request.tools до вызова провайдера. Его реализация игнорирует
          // клиентские схемы и исполняет собственные инструменты, поэтому capability здесь
          // разрешает общий adapter path, но не передаёт OpenCode исполнение ZCode tools.
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        }),
        optionSpecs: new ModelOptionSpecsConfig({
          // Причина: OpenCode CLI сообщает effort как model variants; фиксированный disabled скрывал настройку.
          // Передаём только проверенные варианты каталога, а не придумываем уровни для модели.
          reasoningLevel: {
            values: model.reasoningVariants?.length ? model.reasoningVariants : ["disabled"],
            map: "{}",
          },
          maxOutputTokens: { max: model.maxOutputTokens, map: "{}" },
        }),
      }),
      [OPENCODE_CLI_PROVIDER_ID, model.modelId],
    );
    if (!modelConfigResult.ok) {
      throw new Error(
        `OpenCode CLI model config is invalid: ${model.modelId}: ${modelConfigResult.issues[0]?.message}`,
      );
    }
    return Object.freeze({ modelId: model.modelId, config: modelConfigResult.config });
  });
  return Object.freeze({
    providerId: OPENCODE_CLI_PROVIDER_ID,
    providerName: "OpenCode CLI",
    config: providerConfigResult.config,
    models: Object.freeze(models),
  });
}

function emptyOpenCodeSnapshot(revision: string): RuntimeProviderCatalogSnapshot {
  return Object.freeze({
    revision: `opencode:${revision}`,
    providers: Object.freeze([]),
  });
}

interface CliProviderEntry {
  readonly provider: Provider;
  readonly executablePath: string;
  readonly revision: string;
}

/**
 * Публикует оба локальных CLI-провайдера в один snapshot. Каждый CLI проверяется независимо:
 * сбой или отключение одного не скрывает второй. Настройка `*CliEnabled` — единственный
 * владелец видимости провайдера в Composer.
 */
export class LocalCliProviderCatalogSource implements ProviderSource<RuntimeProviderCatalogSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();
  readonly #disposeSettings: () => void;

  constructor(
    private readonly settings: ObservableSettingService,
    private readonly openCodeRuntime:
      | Pick<IOpenCodeAcpRuntime, "getCliStatus" | "listModels">
      | undefined,
    private readonly cursorRuntime:
      | Pick<ICursorCliRuntime, "getCliStatus" | "listModels">
      | undefined,
  ) {
    this.#disposeSettings = settings.onDidUpdate((event) => {
      if (event.keys.includes("openCodeCliEnabled") || event.keys.includes("cursorCliEnabled")) {
        this.#emit("setting-updated");
      }
    });
  }

  async read(): Promise<RuntimeProviderCatalogSnapshot> {
    const settings = await this.settings.get();
    const openCodeEnabled = settings.openCodeCliEnabled === true && this.openCodeRuntime != null;
    const cursorEnabled = settings.cursorCliEnabled === true && this.cursorRuntime != null;
    const [openCode, cursor] = await Promise.all([
      openCodeEnabled ? this.#readOpenCode() : Promise.resolve(undefined),
      cursorEnabled ? this.#readCursor() : Promise.resolve(undefined),
    ]);
    const entries = [openCode, cursor].filter((entry): entry is CliProviderEntry => entry != null);
    const executablePaths: Partial<Record<"opencode" | "cursor", string>> = {};
    for (const entry of entries) {
      if (entry.provider.providerId === OPENCODE_CLI_PROVIDER_ID) {
        executablePaths.opencode = entry.executablePath;
      } else if (entry.provider.providerId === CURSOR_CLI_PROVIDER_ID) {
        executablePaths.cursor = entry.executablePath;
      }
    }
    return Object.freeze({
      revision: `local-cli:${
        entries.map((entry) => `${entry.provider.providerId}@${entry.revision}`).join("|") || "none"
      }`,
      providers: Object.freeze(entries.map((entry) => entry.provider)),
      ...(executablePaths.opencode ? { cliExecutablePath: executablePaths.opencode } : {}),
      ...(Object.keys(executablePaths).length > 0
        ? { cliExecutablePaths: Object.freeze(executablePaths) }
        : {}),
    });
  }

  async #readOpenCode(): Promise<CliProviderEntry | undefined> {
    // 根因：CLI/catalog 抛错会拒绝整次 Registry refresh，已配置的 API Provider 也无法发布。
    // 修复：刷新失败是可重试的空结果；其它 Provider 照常合并。
    try {
      if (!this.openCodeRuntime) return undefined;
      const status = await this.openCodeRuntime.getCliStatus();
      if (status.status !== "available") return undefined;
      const catalog = await this.openCodeRuntime.listModels();
      if (catalog.status !== "available") return undefined;
      const models = catalog.models.filter(
        (model) => opencodeRuntimeModelIdSchema.safeParse(model.modelId).success,
      );
      if (models.length === 0) return undefined;
      return {
        provider: createOpenCodeProvider(models),
        executablePath: status.executablePath,
        revision: `${status.version}:${models.map((model) => model.modelId).join(",")}`,
      };
    } catch {
      return undefined;
    }
  }

  async #readCursor(): Promise<CliProviderEntry | undefined> {
    try {
      if (!this.cursorRuntime) return undefined;
      const status = await this.cursorRuntime.getCliStatus();
      if (status.status !== "available") return undefined;
      const catalog = await this.cursorRuntime.listModels();
      if (catalog.status !== "available") return undefined;
      const models = catalog.models.filter(
        (model) => cursorRuntimeModelIdSchema.safeParse(model.modelId).success,
      );
      if (models.length === 0) return undefined;
      return {
        provider: createCursorProvider(models),
        executablePath: status.executablePath,
        revision: `${status.version}:${models.map((model) => model.modelId).join(",")}`,
      };
    } catch {
      return undefined;
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposeSettings();
    this.#listeners.clear();
  }

  /** Установка CLI не меняет настройку; источник отдельно инвалидируется владельцем. */
  async refresh(reason = "manual-refresh"): Promise<RuntimeProviderCatalogSnapshot> {
    this.#emit(reason);
    return this.read();
  }

  #emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

/**
 * Cursor CLI не публикует context window и usage в `--list-models`, поэтому берём
 * консервативный лимит, чтобы context assembly не превышал окно модели.
 */
const CURSOR_DEFAULT_CONTEXT_WINDOW = 128_000;
const CURSOR_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

function createCursorProvider(catalogModels: readonly CursorCliModelDescriptor[]): Provider {
  const providerConfigResult = createRegistryProviderConfig(
    new ProviderConfig({
      group: "standard-personal",
      access: new LocalAuthAccessConfig(),
      api: new ProviderApiConfig({ type: "cursor-cli" }),
    }),
    [CURSOR_CLI_PROVIDER_ID],
  );
  if (!providerConfigResult.ok) {
    throw new Error(
      `Cursor CLI provider config is invalid: ${providerConfigResult.issues[0]?.message}`,
    );
  }

  const models = groupCursorModels(catalogModels).map((model) => {
    const modelConfigResult = createRegistryModelConfig(
      new ModelConfig({
        enabled: true,
        properties: new ModelPropertiesConfig({
          displayName: model.name,
          requiresMfjsToolSchema: false,
          contextWindow: CURSOR_DEFAULT_CONTEXT_WINDOW,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          // Cursor agent исполняет свои инструменты сам; providerExecuted-части приходят из CLI.
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        }),
        optionSpecs: new ModelOptionSpecsConfig({
          reasoningLevel: {
            values: model.reasoningLevels.map((entry) => entry.level),
            map: buildCursorReasoningMap(model.reasoningLevels),
          },
          maxOutputTokens: { max: CURSOR_DEFAULT_MAX_OUTPUT_TOKENS, map: "{}" },
        }),
      }),
      [CURSOR_CLI_PROVIDER_ID, model.modelId],
    );
    if (!modelConfigResult.ok) {
      throw new Error(
        `Cursor CLI model config is invalid: ${model.modelId}: ${modelConfigResult.issues[0]?.message}`,
      );
    }
    return Object.freeze({ modelId: model.modelId, config: modelConfigResult.config });
  });
  return Object.freeze({
    providerId: CURSOR_CLI_PROVIDER_ID,
    providerName: "Cursor CLI",
    config: providerConfigResult.config,
    models: Object.freeze(models),
  });
}

export interface ProviderRuntimeOptions extends ProviderConfigRuntimeOptions {
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly runtimeProviderSource?: RefreshableProviderSource<RuntimeProviderCatalogSnapshot>;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
}

export interface ProviderRuntimeDependencies {
  readonly configRuntime: ProviderConfigRuntime;
  readonly accountSource?: RefreshableProviderSource<AccountProviderConfigSnapshot>;
  readonly runtimeProviderSource?: RefreshableProviderSource<RuntimeProviderCatalogSnapshot>;
  readonly disposeAccountSource?: () => void;
  readonly testConnectivity?: ProviderSettingsConnectivityTester;
  readonly modelSelectionConfiguredDefaultSource?: ModelSelectionConfiguredDefaultSource;
  readonly disposeModelSelectionConfiguredDefaultSource?: () => void;
}

interface RefreshableProviderSource<TSnapshot> extends ProviderSource<TSnapshot> {
  refresh?(reason: string): Promise<TSnapshot>;
  dispose?(): void;
}

/**
 * 普通 API Provider 可以在账号能力尚未装配时独立运行。
 * Account Provider 由当前 Built-in revision 对齐的 access.entitled=false Overlay 显式 fail-closed。
 */
export class EmptyAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly configSource: ProviderSource<ProviderConfigSnapshot>) {}

  async read(): Promise<AccountProviderConfigSnapshot> {
    return createFailClosedAccountProviderConfigSnapshot(await this.configSource.read());
  }

  onDidChange(): () => void {
    return () => {};
  }
}

/** 组装一个进程内共享的 Provider Config、Registry 与 Facade。 */
export class ProviderRuntime {
  readonly configService: ProviderConfigRuntime["configService"];
  readonly registryService: ProviderRegistryService;
  readonly providerSettings: IProviderSettingsService;
  readonly modelSelection: IModelSelectionService;
  readonly #configRuntime: ProviderConfigRuntime;
  readonly #disposeAccountSource?: () => void;
  readonly #runtimeProviderSource?: RefreshableProviderSource<RuntimeProviderCatalogSnapshot>;
  readonly #disposeBuiltinRecovery: () => void;
  readonly #modelSelectionRuntime: IModelSelectionService & { dispose(): void };
  readonly #disposeModelSelectionConfiguredDefaultSource?: () => void;
  #startPromise: ReturnType<ProviderRegistryService["start"]> | null = null;
  #disposed = false;

  constructor(dependencies: ProviderRuntimeDependencies) {
    this.#configRuntime = dependencies.configRuntime;
    this.#disposeAccountSource = dependencies.disposeAccountSource;
    this.#runtimeProviderSource = dependencies.runtimeProviderSource;
    this.#disposeModelSelectionConfiguredDefaultSource =
      dependencies.disposeModelSelectionConfiguredDefaultSource;
    this.configService = this.#configRuntime.configService;
    const accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot> =
      dependencies.accountSource ?? new EmptyAccountProviderConfigSource(this.configService);
    this.#disposeBuiltinRecovery = this.#configRuntime.onDidCheckZCodeBuiltin(async () => {
      const [config, account] = await Promise.all([
        this.configService.read(),
        accountSource.read(),
      ]);
      if (!this.#disposed && config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision) {
        await accountSource.refresh?.("builtin-account-recovery");
      }
    });
    this.registryService = new ProviderRegistryService({
      configSource: this.configService,
      accountSource,
      ...(dependencies.runtimeProviderSource
        ? { runtimeProviderSource: dependencies.runtimeProviderSource }
        : {}),
    });
    const mutations = createSettingsMutationTarget(
      this.#configRuntime,
      this.registryService,
      accountSource,
    );
    const ensureReady = () => this.start();
    const settingsFacade = new ProviderSettingsFacade(this.registryService, mutations);
    this.providerSettings = createProviderSettingsService(
      settingsFacade,
      ensureReady,
      dependencies.testConnectivity,
    );
    this.#modelSelectionRuntime = createModelSelectionService(
      createNodeModelSelectionFacade(this.registryService),
      ensureReady,
      dependencies.modelSelectionConfiguredDefaultSource,
    );
    this.modelSelection = this.#modelSelectionRuntime;
  }

  start(): Promise<void> {
    if (this.#disposed) throw new Error("ProviderRuntime 已 dispose");
    if (this.#startPromise) return this.#startPromise;
    const startPromise = this.#configRuntime.start().then(() => this.registryService.start());
    this.#startPromise = startPromise;
    void startPromise.catch(() => {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    });
    return startPromise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeBuiltinRecovery();
    this.#modelSelectionRuntime.dispose();
    this.registryService.dispose();
    this.#disposeAccountSource?.();
    this.#runtimeProviderSource?.dispose?.();
    this.#disposeModelSelectionConfiguredDefaultSource?.();
    this.#configRuntime.dispose();
  }
}

function createSettingsMutationTarget(
  configRuntime: ProviderConfigRuntime,
  registryService: ProviderRegistryService,
  accountSource: RefreshableProviderSource<AccountProviderConfigSnapshot>,
): ProviderSettingsMutationTarget {
  const configService = configRuntime.configService;
  return {
    createPersonalProvider: (input) => configService.createPersonalProvider(input),
    savePersonalProviderOverlay: (providerId, config, membership, metadata) =>
      configService.savePersonalProviderOverlay(providerId, config, membership, metadata),
    deletePersonalProvider: (providerId) => configService.deletePersonalProvider(providerId),
    reorderPersonalProviders: (providerIds) => configService.reorderPersonalProviders(providerIds),
    reorderPersonalModels: (providerId, modelIds, membership) =>
      configService.reorderPersonalModels(providerId, modelIds, membership),
    // 手工四参数转发曾丢掉新增的配置模式；直接绑定完整签名，避免装配层截断写入意图。
    addPersonalModel: configService.addPersonalModel.bind(configService),
    renamePersonalModel: (providerId, currentModelId, nextModelId, membership) =>
      configService.renamePersonalModel(providerId, currentModelId, nextModelId, membership),
    deletePersonalModel: (providerId, modelId, membership) =>
      configService.deletePersonalModel(providerId, modelId, membership),
    setPersonalModelEnabled: (providerId, modelId, enabled, membership) =>
      configService.setPersonalModelEnabled(providerId, modelId, enabled, membership),
    savePersonalModelDraft: (
      providerId,
      originalModelId,
      nextModelId,
      config,
      expectedPersonalRevision,
      useRecommendedConfig,
      membership,
    ) =>
      configService.savePersonalModelDraft(
        providerId,
        originalModelId,
        nextModelId,
        config,
        expectedPersonalRevision,
        useRecommendedConfig,
        membership,
      ),
    refresh: (reason) => registryService.refresh(reason),
    refreshSources: async (reason) => {
      const [builtinResult, accountResult] = await Promise.allSettled([
        configRuntime.refreshZCodeBuiltin({ force: true }),
        accountSource.refresh?.(reason) ?? Promise.resolve(),
      ]);
      // 远端更新失败不代表本地配置不可用；此前统一抛错会让套餐切换回滚，
      // 并掩盖真正的账号失败。只降级远端更新，Config/Registry 和权益错误仍保留。
      if (builtinResult.status === "rejected") {
        log.warn(undefined, "Builtin 远端更新失败，继续使用本地配置", {
          reason,
          error: builtinResult.reason,
        });
      }
      const snapshot = await registryService.refresh(reason);
      if (accountResult.status === "rejected") throw accountResult.reason;
      return snapshot;
    },
  };
}

export function createProviderRuntime(options: ProviderRuntimeOptions): ProviderRuntime {
  const { accountSource, runtimeProviderSource, testConnectivity, ...configRuntimeOptions } =
    options;
  const configRuntime = createProviderConfigRuntime(configRuntimeOptions);
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource,
    runtimeProviderSource,
    testConnectivity,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}

export function createProviderRuntimeFromConfigRuntime(
  dependencies: ProviderRuntimeDependencies,
): ProviderRuntime {
  return new ProviderRuntime(dependencies);
}
