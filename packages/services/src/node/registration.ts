// Регистрация всех Node-сервисов в ServiceCollection и финальная проводка сайд-таблиц.
import type { LocalServicesBundle } from "./bundles.js";
import { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createCloudContentService } from "#src/cloud-content/cloudContentService.js";
import { ICuaPermissionService, ICuaPipSessionService } from "#src/cua-permission-broker/index.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";
import { IProjectService, shouldRescanTaskAutoArchive } from "#src/project/index.js";
import { IRemoteProjectService } from "#src/remote-projects/index.js";
import { ITaskGroupService } from "#src/task-groups/index.js";
import { IBotsService } from "../bots/bots.js";
import { createBotsService } from "../bots/botsService.js";
import { IBroadcastService } from "../broadcast/broadcast.js";
import { IClientConfigService } from "../client-config/clientConfig.js";
import { createClientConfigService } from "../client-config/clientConfigService.js";
import { IClientScenesService } from "../client-scenes/clientScenes.js";
import { createClientScenesService } from "../client-scenes/clientScenesService.js";
import { ICodeIntelligenceService } from "../code-intelligence/contract.js";
import { createPromptEnhancerService, IPromptEnhancerService } from "../prompt-enhancer/index.js";
import {
  createPromptEnhancerCapabilityIndexProvider,
  createPromptEnhancerContextPorts,
  createPromptEnhancerPaths,
} from "./prompt-enhancer-ports.js";
import {
  createChatAutocompleteContextPorts,
  createChatAutocompletePaths,
  createChatAutocompleteService,
  IChatAutocompleteService,
} from "../chat-autocomplete/index.js";
import {
  createProactiveSuggestionService,
  IProactiveSuggestionService,
} from "../proactive-suggestion/index.js";
import { ICodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscription.js";
import { ServiceCollection } from "../collection.js";
import { ICommandsService } from "../commands/commands.js";
import { createCommandsService } from "../commands/commandsService.js";
import { IConversationShareService } from "../conversation-share/conversationShare.js";
import { ICredentialService } from "../credential/credential.js";
import { IFeedbackService } from "../feedback/feedback.js";
import { createFeedbackService } from "../feedback/feedbackService.js";
import { IFileService } from "../file/file.js";
import { IFileWatcherService } from "../fileWatcher/fileWatcher.js";
import { createFileWatcherService } from "../fileWatcher/fileWatcherService.js";
import { IGenUiService } from "../gen-ui/contract.js";
import { createGenUiService } from "../gen-ui/node.js";
import { IGitService } from "../git/git.js";
import { IGitCheckpointService } from "../git/gitCheckpoint.js";
import { IHighspeedCardService } from "../highspeed/highspeedCard.js";
import {
  HighspeedCardService,
  buildHighspeedCodingPlanAuthHeaders,
  createHighspeedHttpTransport,
} from "../highspeed/highspeedCardService.js";
import { createHighspeedMockTransport } from "../highspeed/highspeedMockTransport.js";
import { IHooksService } from "../hooks/hooks.js";
import { createHooksService } from "../hooks/hooksService.js";
import { IMcpSyncService } from "../mcp-sync/mcpSync.js";
import { IMediaPreviewService } from "../media-preview/mediaPreview.js";
import { IMemoryService } from "../memory/memory.js";
import { createMemoryService } from "../memory/memoryService.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "../model-provider/providerFacadeServices.js";
import { IProviderProvisioningTargetService } from "../model-provider/providerProvisioning.js";
import {
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
} from "../model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "../model-provider/providerProvisioningTarget.js";
import {
  registerHostApiNetworkTransportForDispose,
  registerManagedCuaHelperHostForDispose,
  setAccountRequestAuthService,
  setOffPeakRequestAuthBuilder,
  setProviderProvisioningSource,
  setProviderProvisioningTriggerDisposers,
  setProviderRuntime,
  setSharedSqliteRepos,
  setTaskAutoArchiveDisposer,
} from "./side-tables.js";
import { IOAuthService } from "../oauth/oauth.js";
import { IOnboardingRecordService } from "../onboarding/onboardingRecord.js";
import { IOpenCodeAcpRuntime } from "../opencode-acp-runtime/contract.js";
import { IOutputStyleService } from "../output-style/outputStyle.js";
import { createOutputStyleService } from "../output-style/outputStyleService.js";
import { IPluginSyncService } from "../plugin-sync/pluginSync.js";
import {
  IPluginUiAppToolsService,
  IPluginUiBridgeService,
  IPluginUiSamplingService,
} from "../plugin-ui-bridge/index.js";
import { IPluginManagementService } from "../plugins/pluginManagement.js";
import { createPluginManagementService } from "../plugins/pluginManagementService.js";
import { IPluginsService } from "../plugins/plugins.js";
import { createPluginsService } from "../plugins/pluginsService.js";
import { IPromptAttachmentTransferService } from "../prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createLocalPromptAttachmentTransferService } from "../prompt-attachment-transfer/promptAttachmentTransferService.js";
import {
  createOffPeakOriginResolver,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakCredentials,
  resolveOffPeakMockUpstream,
} from "../session/offPeakRuntimeModel.js";
import { createOffPeakServerClient } from "../session/offPeakServerClient.js";
import { IOffPeakTaskService } from "../session/offPeakTask.js";
import { OffPeakTaskRepo } from "../session/offPeakTaskRepo.js";
import { OffPeakTaskService } from "../session/offPeakTaskService.js";
import { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { ISettingService } from "../setting/setting.js";
import { ISettingsSyncService } from "../settings-sync/settingsSync.js";
import { createSettingsSyncService } from "../settings-sync/settingsSyncService.js";
import { ISkillSyncService } from "../skill-sync/skillSync.js";
import { createSkillSyncService } from "../skill-sync/skillSyncService.js";
import { ISkillsService } from "../skills/skills.js";
import { ISourceServerWorkspaceService } from "../source-server-workspace/sourceServerWorkspace.js";
import { ISubagentsService } from "../subagents/subagents.js";
import { ISystemService } from "../system/system.js";
import { ITerminalService } from "../terminal/terminal.js";
import { createTerminalService } from "../terminal/terminalService.js";
import { IUsageStatsService } from "../usage-stats/usageStats.js";
import { createUsageStatsService } from "../usage-stats/usageStatsService.js";
import { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { IZCodeSessionService } from "../zcode-session/zcodeSession.js";
import { PERSONAL_PROVIDER_CONFIG_FILE_NAME } from "@zcode/provider-node";
import {
  type HighspeedMockScenario,
  OFF_PEAK_PROVIDER_IDS,
  ZCODE_VERSION,
  buildRuntimeZCodeApiUrl,
  resolveRuntimeZCodeEndpointOrigin,
  resolveSafeTelemetryHostname,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAppConfigDir as resolveAppConfigDir } from "../paths.js";
import { getAppConfigDir as getContentAppConfigDir } from "../paths.js";

export function registerLocalServices(args: LocalServicesBundle): ServiceCollection {
  const {
    options,
    isDesktopAttachedRemote,
    openCodeAcpRuntime,
    settingService,
    resolveCurrentZCodeEndpointOrigin,
    credentialService,
    apiClient,
    broadcastService,
    hostApiNetworkTransport,
    gitCheckpointService,
    systemService,
    taskIndexRepo,
    onboardingRecordService,
    fileService,
    mediaPreviewService,
    accountRequestAuthService,
    providerConfigRuntime,
    providerRuntime,
    cuaProductHelperLifecycle,
    accountProviderConfigSource,
    providerProvisioningSource,
    providerProvisioningDisposers,
    sourceServerWorkspaceService,
    skillsService,
    mcpSyncService,
    pluginSyncService,
    pluginUiBridgeService,
    pluginUiSamplingService,
    pluginUiAppToolsService,
    subagentsService,
    codeIntelligenceService,
    codingPlanSubscriptionService,
    projectService,
    remoteProjectService,
    taskGroupService,
    zcodeAgentService,
    cuaPermissionService,
    cuaPipSessionService,
    zcodeSessionService,
    gitService,
    zcodeTaskService,
    botsRepo,
    botRemoteWorkspaceService,
    oauthService,
    offPeakCredentialResolverDeps,
    buildOffPeakRequestAuthForTicket,
    officialMcpCredentialSource,
    prepareProjectExecution,
    conversationShareService,
    sqliteReposToClose,
    marketingAssets,
    taskAutoArchiveScheduler,
  } = args;
  const services = new ServiceCollection()
    .register(
      IMarketingTouchService,
      createMarketingTouchService({
        apiClient,
        getToken: () => credentialService.load("zcodejwttoken"),
        getDeviceMid: () => options?.agentTelemetry?.getDeviceMid?.(),
        baseUrl: buildRuntimeZCodeApiUrl(process.env, "/"),
        appVersion: ZCODE_VERSION,
        onSnapshot: (snapshot) => marketingAssets.accept(snapshot),
      }),
    )
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(
      ICloudContentService,
      createCloudContentService({
        publishedAssets: marketingAssets,
        cacheRoot: join(getContentAppConfigDir(), "cache", "content-bundles", randomUUID()),
      }),
    )
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(IProjectService, projectService)
    .register(ITaskGroupService, taskGroupService)
    .register(IRemoteProjectService, remoteProjectService)
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        repo: botsRepo,
        projectService,
        remoteProjectService,
        ownerHostId: options?.projectStorageHostId ?? "local",
        credentialService,
        zcodeTaskService,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService
          ? {
              ...botRemoteWorkspaceService,
              resolveWorkspace: options?.resolveBotRemoteWorkspace,
            }
          : undefined,
        // 远端与本地 Bot 都读取所属 Environment 的 Model Selection View。
        // 远端启动期不再轮询旧 Preset，避免重新制造一套模型候选事实。
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, oauthService)
    .register(ISourceServerWorkspaceService, sourceServerWorkspaceService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        zcodeAgentService,
        officialMcpCredentialSource,
      }),
    )
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
      IOffPeakTaskService,
      (() => {
        // 闲时任务编排服务（与 automation 服务面独立）：
        // 单例属主在本集合，renderer 经 ProxyChannel 直连，host 派发经 getOptional 取同一实例。
        const offPeakLogger = createServiceLogger("off-peak");
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo 也持有 tasks-index.sqlite 连接；收集到链前数组，services 建好后统一登记
        // （工厂在注册链求值期执行，此时 services 常量尚未初始化，不能直接引用）
        sqliteReposToClose.push(offPeakTaskRepo);
        const offPeakTaskService = new OffPeakTaskService({
          prepareProjectExecution,
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
          resolveTelemetryProviderName: async () =>
            resolveSafeTelemetryHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // 旧行没有 Provider 身份；只能复用当前账号凭据链已裁定的 Account Family，
            // 不能靠 Registry/JSON 顺序在 Z.ai 与 BigModel 间猜测。
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await zcodeTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
        offPeakTaskService.startSync();
        // 回写前向引用，供 zcodeAgentService 的 offPeak/create、offPeak/list 协议 handler 调用。
        args.offPeakTask.current = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(
      IHighspeedCardService,
      (() => {
        const origin = resolveRuntimeZCodeEndpointOrigin(process.env);
        const rawMockScenario = process.env.ZCODE_HIGHSPEED_MOCK_SCENARIO;
        const mockScenarios = new Set<HighspeedMockScenario>([
          "hit-fast",
          "miss",
          "hit-after-timeout",
          "hit-invalid-model",
          "hit-queue-edit",
          "existing-foreign-task-card",
          "expired-card",
        ]);
        const mockScenario = mockScenarios.has(rawMockScenario as HighspeedMockScenario)
          ? (rawMockScenario as HighspeedMockScenario)
          : null;
        const resolveHighspeedLoginHeaders = async (): Promise<Record<string, string>> => {
          const jwt = (await credentialService.load("zcodejwttoken"))?.trim() ?? "";
          if (!jwt) throw new Error("highspeed request requires zcode jwt");
          return {
            Authorization: /^Bearer\s/i.test(jwt) ? jwt : `Bearer ${jwt}`,
          };
        };
        const transport = mockScenario
          ? createHighspeedMockTransport({ scenario: mockScenario })
          : createHighspeedHttpTransport({
              drawUrl: `${origin}/api/v1/highspeed/draw`,
              healthyBaseUrl: `${origin}/api/v1/highspeed/`,
              logger: createServiceLogger("highspeed"),
              drawHeaders: async () => {
                const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
                  allowMockCredentials: false,
                });
                const codingPlanAuthorization =
                  (
                    await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
                  )?.trim() ?? "";
                return buildHighspeedCodingPlanAuthHeaders({
                  zcodeJwt: credentials.jwt,
                  codingPlanAuthorization,
                  targetType:
                    credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
                  ...(credentials.organizationId
                    ? { organizationId: credentials.organizationId }
                    : {}),
                  ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
                });
              },
              healthyHeaders: resolveHighspeedLoginHeaders,
            });
        return new HighspeedCardService({
          transport,
          // 普通 mock 只验证抽卡 UI，不依赖隐藏执行 Provider；目录外模型与队列编辑场景
          // 必须走真实 Highspeed execution Selection，才能覆盖创建期退回和队列模型隔离。
          inferenceMode:
            mockScenario &&
            mockScenario !== "hit-invalid-model" &&
            mockScenario !== "hit-queue-edit"
              ? "session-default"
              : "highspeed",
          // 规则 11：draw 只对 Coding Plan 用户开放；mock 场景放行以便本地验证。
          resolveCodingPlanSupported: mockScenario
            ? async () => true
            : async () =>
                (await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps)).supported,
          // 规则 14：会话模型必须属于所选 Coding Plan Provider 的模型目录（Built-in Provider
          // Config 投影）才发起新 draw；mock 场景放行以便本地验证。
          resolveModelCovered: mockScenario
            ? async () => true
            : async (providerId, modelId) => {
                const view = await providerRuntime.modelSelection.getView();
                const provider = view.providers.find((item) => item.providerId === providerId);
                return provider?.models.some((model) => model.modelId === modelId) ?? false;
              },
          // 加速推理与 draw 走同一 highspeed 网关、同一 Coding Plan 双 JWT 契约：必须携带
          // zcode JWT + Coding Plan 业务 JWT + Team 身份头。此前只发 zcode JWT + 卡 ID，网关
          // 无法校验 Coding Plan 权益，返回 401 auth_failed。与 draw 头复用同一次 selected
          // connection 解析，避免把 ZAI 身份的卡打到 BigModel 加速 Provider。
          resolveInferenceAuth: async () => {
            const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
              allowMockCredentials: false,
            });
            const codingPlanAuthorization =
              (
                await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
              )?.trim() ?? "";
            return {
              zcodeJwt: credentials.jwt,
              family: credentials.providerFamily,
              codingPlanAuthorization,
              targetType: credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
              ...(credentials.organizationId ? { organizationId: credentials.organizationId } : {}),
              ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
            };
          },
        });
      })(),
    )
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    .register(
      IGenUiService,
      createGenUiService({ registerSandbox: options?.registerPluginSandbox }),
    )
    .register(IPluginUiBridgeService, pluginUiBridgeService)
    .register(IPluginUiSamplingService, pluginUiSamplingService)
    .register(IPluginUiAppToolsService, pluginUiAppToolsService)
    // 合并 MCP/Plugin Management 服务装配时误删了 plugin-sync 注册，
    // RemoteServiceAccess 仍会请求该频道，导致本地候选枚举超时、远端同步无法开始。
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // 设置页插件管理薄服务——plugins/* 旧协议词的 host 侧唯一消费点。
    .register(
      IPluginManagementService,
      createPluginManagementService({
        zcodeAgentService,
        reportTelemetryEvent: options?.reportPluginTelemetryEvent,
      }),
    )
    .register(ISubagentsService, subagentsService)
    .register(ICodeIntelligenceService, codeIntelligenceService)
    .register(
      IPromptEnhancerService,
      createPromptEnhancerService({
        ...createPromptEnhancerPaths({ zcodeAgentService, providerRuntime }),
        contextPorts: createPromptEnhancerContextPorts({
          codeIntelligenceService,
          gitService,
          fileService,
          zcodeSessionService,
        }),
        capabilityIndex: createPromptEnhancerCapabilityIndexProvider({
          skillsService,
          subagentsService,
        }),
      }),
    )
    .register(
      IChatAutocompleteService,
      createChatAutocompleteService({
        ...createChatAutocompletePaths({ zcodeAgentService, providerRuntime }),
        contextPorts: createChatAutocompleteContextPorts({
          codeIntelligenceService,
          gitService,
          zcodeSessionService,
        }),
      }),
    )
    // Переиспользуем тот же транспорт/резолвер, что у ghost-автодополнения:
    // второй владелец модели или копия путей не нужны.
    .register(
      IProactiveSuggestionService,
      createProactiveSuggestionService({
        ...createChatAutocompletePaths({ zcodeAgentService, providerRuntime }),
      }),
    )
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    .register(IOutputStyleService, createOutputStyleService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  if (openCodeAcpRuntime) {
    services.register(IOpenCodeAcpRuntime, openCodeAcpRuntime);
  }

  // 即使初始配置关闭也必须登记 lifecycle disposer：terminal fence 需要早于任意延迟 setting/acquire
  // 恢复，不能把"当前还没有 Helper"误当成"不需要生命周期所有者"。dispose 时串行 stop host。
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await cuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);

  // disposer 注册完成后才排预热。若 createLocalServices 中途抛错，不能留下一个无人持有、却会在当前
  // 调用栈结束后才创建的高权限 Helper；若返回后立即 dispose，terminal fence 会先于 acquire 生效。
  // Helper 懒启动：不预热——Helper 由 SDK 首次 CUA 调用拉起（spawn env 注入
  // 稳定 socket），或用户显式授权流（restartHelper）拉起。启动即零 Helper 常驻。

  setAccountRequestAuthService(services, accountRequestAuthService);
  setOffPeakRequestAuthBuilder(services, buildOffPeakRequestAuthForTicket);

  setProviderRuntime(services, providerRuntime);
  setProviderProvisioningSource(services, providerProvisioningSource);
  setProviderProvisioningTriggerDisposers(services, providerProvisioningDisposers);
  // desktop-attached-remote 的组织态在远端 Host 库里，由远端自己的扫描器归档；本机不扫。
  if (!isDesktopAttachedRemote) {
    const stopSettingsRescan = settingService.onDidUpdate((event) => {
      if (shouldRescanTaskAutoArchive(event.keys)) {
        void taskAutoArchiveScheduler.scan().catch(() => {});
      }
    });
    taskAutoArchiveScheduler.start();
    setTaskAutoArchiveDisposer(services, () => {
      stopSettingsRescan();
      taskAutoArchiveScheduler.dispose();
    });
  }
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // 见 sharedSqliteRepos 声明处注释：登记全部 tasks-index sqlite 句柄，dispose 链统一关闭
  sqliteReposToClose.push(taskIndexRepo);
  setSharedSqliteRepos(services, sqliteReposToClose);
  return services;
}
