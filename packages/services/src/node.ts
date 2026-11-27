// Node.js service implementations — NOT safe to import in browser code.
// Точка входа @zcode/services/node: барrel публичной поверхности плюс композиция Local Host.
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { join } from "node:path";
import { getAppConfigDir } from "./paths.js";
import { IBotsService } from "./bots/bots.js";
import { ServiceCollection } from "./collection.js";
import { createSourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspaceService.js";
import { SourceServerWorkspaceIdentityMapper } from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
import { SourceServerWorkspaceAliasRepo } from "./session/sourceServerWorkspaceAliasRepo.js";
import {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createOpenCodeAcpRuntime } from "./opencode-acp-runtime/adapters/openCodeAcpRuntime.js";
import { createCursorCliRuntime } from "./cursor-cli-runtime/node.js";
import { LocalCliProviderCatalogSource } from "./model-provider/providerRuntime.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import {
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  formatLogPrefix,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import { createAgentServices } from "./node/agent.js";
import type { BuildContext, LocalServicesBundle } from "./node/bundles.js";
import { createCoreServices } from "./node/core.js";
import { createCuaServices } from "./node/cua-services.js";
import { createFeatureServices } from "./node/features.js";
import type { CreateLocalServicesOptions } from "./node/createLocalServicesOptions.js";
import { createProjectServices } from "./node/projects.js";
import { createProviderServices } from "./node/providers.js";
import { registerLocalServices } from "./node/registration.js";
import { createRuntimeServices } from "./node/runtime.js";
import { migrateApplicationStorage } from "./node/lifecycle.js";

export * from "./node/reexports.js";
export {
  createDefaultCuaProductHelper,
  createDynamicCuaProductMcpServerResolver,
  createWindowsCuaHelperHost,
  hasGlobalCliZCodeCuaServer,
  resolveBundledCuaHelperAppPath,
  resolveCuaScreenRecordingState,
  runCuaScreenCaptureReadinessProbe,
  shouldCreateDefaultCuaProductHelper,
  shouldEnableCuaOperationStateReporter,
  shouldEnableDefaultCuaProductHelper,
  shouldRetainDefaultCuaProductHelper,
  shouldUseCuaPermissionService,
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV,
} from "./node/cua-helpers.js";
export {
  getAccountRequestAuthService,
  getOffPeakRequestAuthBuilder,
  getProviderProvisioningSource,
  registerHostApiNetworkTransportForDispose,
  registerManagedCuaHelperHostForDispose,
  type OffPeakRequestAuthBuilder,
} from "./node/side-tables.js";
export {
  createTelemetryAuthorizationLoader,
  createTelemetryMarketingParamsLoader,
  createTelemetryUserIdLoader,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  migrateApplicationStorage,
} from "./node/lifecycle.js";

/**
 * 创建包含所有本地服务的 ServiceCollection
 *
 * @param options.parentPort - Electron host process 的 parentPort，
 *        用于 BroadcastService 跨窗口中转。传 null 则广播为空操作。
 */
export function createLocalServices(options: CreateLocalServicesOptions): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  const ownsOpenCodeAcpRuntime =
    (options?.enableOpenCodeAcpRuntime || options?.serviceAuthorityMode === "standalone-server") &&
    !isDesktopAttachedRemote;
  const openCodeAcpRuntime = ownsOpenCodeAcpRuntime ? createOpenCodeAcpRuntime() : undefined;
  // host / remote server 以前直接沿用当前进程环境启动后续服务。
  // GUI 启动的 desktop、SSH/WSL/Docker 拉起的 remote server 往往拿不到用户 login shell 里的 PATH，
  // 导致 bun 这类只在 shell profile 里追加的命令在 ZCode Agent/终端里不可见。
  // 这里在所有本地服务启动前统一修正运行时环境，并顺带把内置 rg 注入 PATH，
  // 让 ZCode Agent、终端、认证 runtime 共用同一套命令解析结果。
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // app 自签 CA：首次启动生成一份根 CA（幂等），供 agent 子进程经 NODE_EXTRA_CA_CERTS 信任、
  // 出口代理用其私钥重签。生成失败不应阻断启动（例如只读文件系统），仅记录日志后继续。
  try {
    ensureAppCaCert();
  } catch (error) {
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const cursorCliRuntime = !isDesktopAttachedRemote
    ? createCursorCliRuntime({
        // Холодный старт не должен ждать `cursor-agent models`; последний удачный
        // каталог читается сразу, а CLI обновляет его в фоне после TTL.
        persistPath: join(getAppConfigDir(), "cursor-cli-catalog.json"),
      })
    : undefined;
  const localCliProviderCatalogSource =
    openCodeAcpRuntime || cursorCliRuntime
      ? // `export { ... }` ниже только переэкспортирует символ и не создаёт локального binding.
        new LocalCliProviderCatalogSource(settingService, openCodeAcpRuntime, cursorCliRuntime)
      : undefined;
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });

  // Поздние привязки и разделяемые владельцы между фазами сборки.
  const pluginUiInvalidation: { current?: (() => void) | undefined } = {};
  const oauthLogout: BuildContext["oauthLogout"] = { current: null };
  const serviceRegistryRef: BuildContext["serviceRegistryRef"] = {};
  const agentServiceRef: BuildContext["agentServiceRef"] = {};
  const offPeakTask: BuildContext["offPeakTask"] = {};

  const context: BuildContext = {
    options,
    isDesktopAttachedRemote,
    localSettings,
    settingService,
    openCodeAcpRuntime,
    cursorCliRuntime,
    localCliProviderCatalogSource,
    desktopContextPromptEnabled,
    resolveCurrentZCodeEndpointOrigin,
    pluginUiInvalidation,
    oauthLogout,
    serviceRegistryRef,
    agentServiceRef,
    offPeakTask,
    resolveBotsService: () => serviceRegistryRef.current?.getOptional(IBotsService),
  };

  const core = createCoreServices(context);
  const providers = createProviderServices({ ...context, ...core });
  const features = createFeatureServices({ ...context, ...core, ...providers });
  const cua = createCuaServices({ ...context, ...core, ...providers });
  const projects = createProjectServices({ ...context, ...core });
  const agent = createAgentServices({
    ...context,
    ...core,
    ...providers,
    ...features,
    ...cua,
    ...projects,
  });
  const runtime = createRuntimeServices({
    ...context,
    ...core,
    ...providers,
    ...features,
    ...cua,
    ...projects,
    ...agent,
  });

  // Agent Service создан: связываем ленивые мосты и провайдерные проверки связности.
  agentServiceRef.current = agent.zcodeAgentService;
  providers.setProviderConnectivityAgentService(agent.zcodeAgentService);
  cua.setActiveTurnGetter(() => agent.zcodeAgentService.hasActiveCuaOperationTurn());

  const bundle: LocalServicesBundle = {
    ...context,
    ...core,
    ...providers,
    ...features,
    ...cua,
    ...projects,
    ...agent,
    ...runtime,
  };
  const services = registerLocalServices(bundle);
  serviceRegistryRef.current = services;

  return services;
}

/** 独立 Server 共用迁移屏障与身份装配；入口不得以 local owner 开放远端项目 RPC。 */
export async function createServerHostServices(options: {
  topicResourceRelayChannel?: NonNullable<CreateLocalServicesOptions["topicResourceRelayChannel"]>;
  sourceServerId: string;
  zcodeBuiltinProviderConfigFilePath: string;
  providerProvisioningTargetEnabled?: boolean;
  /** Host 下发的 Agent 网络配置；没有就是没有，不得在此层合成默认值。 */
  remoteAgentNetwork?: CreateLocalServicesOptions["remoteAgentNetwork"];
}) {
  const projectStorageHostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({
      serverId: options.sourceServerId,
      workspacePath: "/",
    }),
  );
  if (!projectStorageHostId) throw new Error("Invalid Source Server storage identity");
  await migrateApplicationStorage(await createSettingService().get(), projectStorageHostId);
  const workspaceAliasRepo = new SourceServerWorkspaceAliasRepo();
  const workspaceIdentityMapper = new SourceServerWorkspaceIdentityMapper();
  const sourceServerWorkspaceService = createSourceServerWorkspaceService(workspaceAliasRepo, {
    defaultWorkspaceIdentity: (workspacePath) =>
      buildServerRemoteWorkspaceIdentity({
        serverId: options.sourceServerId,
        workspacePath,
      }),
    onResolved: ({ workspacePath, canonicalWorkspaceKey }) => {
      workspaceIdentityMapper.register({
        stableIdentity: buildServerRemoteWorkspaceIdentity({
          serverId: options.sourceServerId,
          workspacePath,
        }),
        canonicalIdentity: canonicalWorkspaceKey,
      });
    },
  });
  const migrationFailedPathCount = await workspaceAliasRepo.getFailedPathCount();
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: options.providerProvisioningTargetEnabled,
    serviceAuthorityMode: "standalone-server",
    // Source Server 也是 Host 下发的网络配置的消费者：隔离远端靠这里的回退中继才能访问模型。
    // 与 stdio 入口共用一个解析器，否则两边会再次分叉。
    remoteAgentNetwork: options.remoteAgentNetwork,
    // Source Server является владельцем процесса на машине исполнения workspace;
    // delegated OpenCode должен запускаться здесь, а не в Desktop окне с удалённым cwd.
    enableOpenCodeAcpRuntime: true,
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    projectStorageHostId,
    sourceServerWorkspaceService,
  });
  return { services, workspaceIdentityMapper, migrationFailedPathCount };
}
