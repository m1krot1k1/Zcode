import {
  AccountProviderService,
  LocalAuthAccessConfig,
  ModelConfig,
  MutableAccountProviderConfigSource,
  ProviderApiConfig,
  ProviderConfig,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
  type Provider,
  type ProviderSource,
  type RuntimeProviderCatalogSnapshot,
} from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
  zcodeProviderUpdateRuntimeCatalogParamsSchema,
} from "@zcode/shared";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";
import {
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
} from "./standalone-account-provider-runtime.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 自己拥有账号凭据与旧配置的一次性导入。 */
  readonly standalone?: {
    readonly credentialStore?: SharedZCodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  const runtimeProviderSource = new MutableRuntimeProviderCatalogSource();
  const credentialStore = options.standalone
    ? (options.standalone.credentialStore ?? createSharedZCodeCredentialStore({ env: { ...env } }))
    : undefined;
  let standaloneAccount: AccountProviderService | undefined;
  const bundledFile = options.standalone
    ? env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
          zcodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.zcodeBuiltinFilePath),
              "zcode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadZCodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ZCODE_VERSION,
                platform: resolveZCodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    accountSource,
    runtimeProviderSource,
    ...(credentialStore
      ? {
          createAccountSource(configService) {
            standaloneAccount = new AccountProviderService({
              configSource: configService,
              async resolve({ configRevision, configuredProviders }) {
                // 使用本轮捕获的 Built-in，而不是异步读另一份文件后仅贴上新 revision。
                const snapshot = await readStandaloneAccountProviderConfigSnapshot(
                  credentialStore,
                  env,
                  {
                    revision: configRevision,
                    providers: configuredProviders,
                  },
                );
                return {
                  providers: snapshot.providers,
                  states: snapshot.states ?? {},
                };
              },
            });
            standaloneAccount.onDidRefreshError(({ error }) => {
              try {
                options.standalone?.onAccountInitializationError?.(error);
              } catch {
                /* 观测回调不能改变账号事实。 */
              }
            });
            return standaloneAccount;
          },
        }
      : {}),
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  const disposeRecovery = standaloneAccount
    ? runtime.onDidCheckZCodeBuiltin(async () => {
        const [config, account] = await Promise.all([
          runtime.configService.read(),
          standaloneAccount!.read(),
        ]);
        if (config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision)
          await standaloneAccount!.refresh("builtin-account-recovery");
      })
    : undefined;
  // 复用 AccountService 的串行、过期结果丢弃机制，凭据变化与 Built-in 变化不能各自发布。
  const standaloneHeaders = credentialStore
    ? createStandaloneProviderRuntimeHeadersPort(credentialStore, env)
    : undefined;
  const disposeCredentialSubscription = credentialStore?.onDidChange?.(async () => {
    await standaloneHeaders?.invalidateChangedCredentials();
    await standaloneAccount!.refresh("standalone-credentials-changed");
    await runtime.registryService.refresh("standalone-credentials-barrier");
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        accountSource: standaloneAccount ?? accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          if (standaloneAccount)
            throw new Error("Standalone Account 由本进程管理，不接收 Host 覆盖");
          const changed = accountSource.replace(next, "host-account-config");
          // Source 去重只证明收过，不证明上次刷新成功。重交时仍刷新；配套配置未到
          // 则由 Registry 保留完整旧快照，不能把接收确认冒充应用确认。
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        async syncRuntimeProviderCatalog(next: RuntimeProviderCatalogSnapshot): Promise<boolean> {
          const changed = runtimeProviderSource.replace(next, "host-runtime-catalog");
          // 和 account overlay 一样，replace 的去重不能代替成功应用的回执；重交时仍刷新。
          await runtime.registryService.refresh("host-runtime-catalog");
          return changed;
        },
        dispose() {
          disposeCredentialSubscription?.();
          standaloneHeaders?.clearProjectTokens();
          disposeRecovery?.();
          standaloneAccount?.dispose();
          runtimeProviderSource.dispose();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        ...(credentialStore
          ? {
              providerRuntimeHeadersPort: standaloneHeaders!,
            }
          : {}),
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      disposeCredentialSubscription?.();
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    disposeCredentialSubscription?.();
    disposeRecovery?.();
    standaloneAccount?.dispose();
    runtimeProviderSource.dispose();
    runtime.dispose();
    throw error;
  }
}

/**
 * 解析 Host 的 local-auth Provider 信封为本地领域对象。
 * Worker 只接受固定 OpenCode provider ID 与无凭据的 SDK 配置；未知字段由 strict schema 拒绝。
 */
export function parseProcessRuntimeProviderCatalogSnapshot(
  input: unknown,
): RuntimeProviderCatalogSnapshot {
  const envelope = zcodeProviderUpdateRuntimeCatalogParamsSchema.parse(input);
  const providers: Provider[] = envelope.providers.map((candidate) => {
    if (candidate.providerId !== "opencode") {
      throw new Error(`Недопустимый runtime provider ID: ${candidate.providerId}`);
    }
    const models = candidate.models.map(({ modelId, config }) => {
      const result = createRegistryModelConfig(ModelConfig.fromData(config), [
        "runtime-provider",
        candidate.providerId,
        "models",
        modelId,
      ]);
      if (!result.ok) {
        throw new Error(`Неполная конфигурация OpenCode model ${modelId}`);
      }
      return Object.freeze({ modelId, config: result.config });
    });
    const config = new ProviderConfig({
      group: candidate.config.group,
      ...(candidate.config.logo === undefined ? {} : { logo: candidate.config.logo }),
      access: new LocalAuthAccessConfig(),
      api: new ProviderApiConfig({ type: "opencode-sdk" }),
      ...(candidate.config.builtinModelIds === undefined
        ? {}
        : { builtinModelIds: candidate.config.builtinModelIds }),
      ...(candidate.config.personalModelIds === undefined
        ? {}
        : { personalModelIds: candidate.config.personalModelIds }),
      ...(candidate.config.modelOrder === undefined
        ? {}
        : { modelOrder: candidate.config.modelOrder }),
      ...(candidate.config.visibility === undefined
        ? {}
        : { visibility: candidate.config.visibility }),
    });
    const providerConfig = createRegistryProviderConfig(config, [
      "runtime-provider",
      candidate.providerId,
    ]);
    if (!providerConfig.ok) {
      throw new Error("OpenCode runtime provider config не прошёл полную валидацию");
    }
    return Object.freeze({
      providerId: candidate.providerId,
      providerName: candidate.providerName,
      ...(candidate.templateId ? { templateId: candidate.templateId } : {}),
      config: providerConfig.config,
      models: Object.freeze(models),
    });
  });
  if (new Set(providers.map((provider) => provider.providerId)).size !== providers.length) {
    throw new Error("Runtime Provider Catalog содержит повторяющийся provider ID");
  }
  if (providers.length > 0 && !envelope.cliExecutablePath) {
    throw new Error("Для включённого OpenCode CLI требуется абсолютный путь к executable");
  }
  if (envelope.cliExecutablePath && !isAbsolute(envelope.cliExecutablePath)) {
    throw new Error("OpenCode CLI executable path должен быть абсолютным");
  }
  return Object.freeze({
    revision: envelope.revision.trim(),
    providers: Object.freeze(providers),
    ...(envelope.cliExecutablePath
      ? { cliExecutablePath: envelope.cliExecutablePath }
      : {}),
  });
}

class MutableRuntimeProviderCatalogSource
  implements ProviderSource<RuntimeProviderCatalogSnapshot>
{
  readonly #listeners = new Set<(reason: string) => void>();
  #snapshot: RuntimeProviderCatalogSnapshot = Object.freeze({
    revision: "empty-runtime-provider-catalog-v1",
    providers: Object.freeze([]),
  });
  readonly #originalPath = process.env.PATH;
  #injectedPath: string | undefined;

  async read(): Promise<RuntimeProviderCatalogSnapshot> {
    return this.#snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(snapshot: RuntimeProviderCatalogSnapshot, reason = "replace"): boolean {
    if (snapshot.revision === this.#snapshot.revision) return false;
    this.#restorePathIfOwned();
    // A resolver may retain the detected path while the user disables the provider.
    // Only an enabled catalog is allowed to alter this worker's PATH.
    const activeCliExecutablePath = snapshot.providers.some(
      (provider) => provider.providerId === "opencode",
    )
      ? snapshot.cliExecutablePath
      : undefined;
    if (activeCliExecutablePath) {
      const executableDirectory = dirname(activeCliExecutablePath);
      const existing = (this.#originalPath ?? "").split(delimiter);
      const nextPath = [executableDirectory, ...existing.filter((entry) => entry !== executableDirectory)]
        .filter(Boolean)
        .join(delimiter);
      process.env.PATH = nextPath;
      this.#injectedPath = nextPath;
    }
    this.#snapshot = Object.freeze({
      revision: snapshot.revision,
      providers: Object.freeze([...snapshot.providers]),
      ...(activeCliExecutablePath
        ? { cliExecutablePath: activeCliExecutablePath }
        : {}),
    });
    for (const listener of this.#listeners) listener(reason);
    return true;
  }

  dispose(): void {
    this.#restorePathIfOwned();
    this.#listeners.clear();
  }

  #restorePathIfOwned(): void {
    if (this.#injectedPath !== undefined && process.env.PATH === this.#injectedPath) {
      if (this.#originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = this.#originalPath;
    }
    this.#injectedPath = undefined;
  }
}

/** 把协议信封解析为进程 Registry 使用的第三层 Account Config Overlay。 */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // 仅约束托管 Worker 的普通账号信封；独立 CLI、API 和闲时不需要 current。
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // 与 Overlay 属于同一快照；不能只更新 revision 却丢掉当前连接事实。
    ...(input.states ? { states: input.states } : {}),
  });
}
