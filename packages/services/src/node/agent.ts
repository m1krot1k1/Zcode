// ZCode Agent service: сборка createZCodeAgentService со всеми зависимостями Host
// (spawn env, official MCP, CUA, bots/topic resource мосты, настройки сессий).
import type {
  BuildContext,
  CoreServices,
  CuaServices,
  FeatureServices,
  ProjectServices,
  ProviderServices,
} from "./bundles.js";
import { BROKER_SOCKET_ENV, BROKER_UNAVAILABLE_ENV } from "#src/cua-permission-broker/index.js";
import {
  getStableCuaPipeName,
  resolveStableCuaWinRecipe,
} from "#src/cua-permission-broker/stableCuaTransport.js";
import { shouldEnableCuaOperationStateReporter } from "./cua-helpers.js";
import { createOfficialMcpAuthHeadersResolver } from "../official-mcp/officialMcpCredentials.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRootRunBudgetEnv,
  buildAgentRuntimeEnv,
} from "../runtime-tools/agentProxyEnv.js";
import { buildAgentTelemetrySpawnEnv } from "../zcode-agent/agentTelemetryEnv.js";
import {
  readTopicResourceFromRelay,
  validateTopicResourceFromRelay,
} from "../zcode-agent/topicResourceRelayClient.js";
import { resolveZCodeAgentPresentationSurface } from "../zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeAgentService } from "../zcode-agent/zcodeAgentService.js";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  createNodeProviderRuntimePathEnv,
} from "@zcode/provider-node";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  projectStage4SettingsToSessionPreferences,
  resolvePromptDepthProfile,
  resolveStage4Settings,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  channelReplyHostRequestSchema,
  channelReplyResultSchema,
  createOfficialMcpTrustedOriginRegistry,
  getCapturedZCodeAgentTelemetryEnv,
} from "@zcode/shared";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAppConfigDir as resolveAppConfigDir } from "../paths.js";

export function createAgentServices(
  args: BuildContext &
    CoreServices &
    ProviderServices &
    FeatureServices &
    CuaServices &
    ProjectServices,
) {
  const {
    options,
    isDesktopAttachedRemote,
    openCodeAcpRuntime,
    localCliProviderCatalogSource,
    desktopContextPromptEnabled,
    settingService,
    oauthCredentialRepo,
    providerRuntime,
    providerConfigRuntime,
    accountRequestAuthService,
    codeIntelligenceService,
    uncensoredSettingsStore,
    uncensoredSettingsService,
    agentAccountProviderConfigSource,
    modelSelectionReadinessSource,
    offPeakToolWiring,
    resolveDynamicWorkflowUserMode,
    codingPlanSubscriptionService,
    cuaPipSessionService,
    subagentsService,
    projectService,
    prepareProjectExecution,
    credentialService,
    taskIndexRepo,
    resolveBotsService,
    isCuaEnabledForContext,
    resolveCurrentZCodeEndpointOrigin,
  } = args;
  const zcodeAgentService = createZCodeAgentService({
    codeIntelligenceService,
    uncensoredSettingsStore,
    uncensoredSettingsService,
    ...(openCodeAcpRuntime ? { openCodeAcpRuntime } : {}),
    ...(localCliProviderCatalogSource
      ? { runtimeProviderCatalogSource: localCliProviderCatalogSource }
      : {}),
    prepareProjectExecution,
    prepareSessionCreation: async (target) =>
      (await taskIndexRepo.getProjectRepository()).reserveCreatedTask({
        task: { ...target, taskId: target.sessionId },
        projectId: target.projectId,
        additionalDirectories: target.additionalDirectories,
      }).additionalDirectories,
    resolveSessionDirectories: async (target) =>
      (
        await projectService.resolveSessionDirectories({
          ...target,
          taskId: target.sessionId,
        })
      ).additionalDirectories,
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // 动态工作流灰度：与 Off-Peak 不同，
    // 这里不按 serviceAuthorityMode 裁剪——SSH/WSL/Docker 的 desktop-attached-remote Host
    // 是它自己那些 workspace 的唯一裁决者，灰度开启时远程 workspace 同样提供工作流。
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    forwardDynamicWorkflowUserMode: options?.forwardDynamicWorkflowUserMode,
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentTelemetry?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // createLocalServices 虽然暴露了 reporter 注入点，旧装配却没有继续传给
    // ZCodeAgentProcessManager，导致 host 永远不向 main 上报 Agent spawn/exit，进程监控器
    // 因而看不到实际运行的 Agent，也无法验证只读到可写升级是否复用同一进程。
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // browser-use：host→main 执行桥透传给 agent service 的 onRequest browserExecute 路由。
    browserControlExecutor: options?.browserControlExecutor,
    // 机器人凭据只归属于授权 Host；远端独立服务不能借用本机配置扩大读取范围。
    channelReplyExecutor: async (value) => {
      const request = channelReplyHostRequestSchema.parse(value);
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return channelReplyResultSchema.parse(
          await options.topicResourceRelayChannel(request).call("reply", request),
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop channel reply peer unavailable");
      const bots = resolveBotsService();
      if (!bots?.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    topicResourceExecutor: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return readTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = resolveBotsService();
      if (!bots?.readTopicResource) throw new Error("Topic resource service is unavailable");
      return bots.readTopicResource({ ...request, signal });
    },
    topicResourceValidator: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return validateTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = resolveBotsService();
      if (!bots?.validateTopicResource)
        throw new Error("Topic resource authorization is unavailable");
      return bots.validateTopicResource({ ...request, signal });
    },
    // 官方 Server MCP 身份头：host 是唯一身份权威，Agent 经反向请求索取。
    // Provider 存在性读取正式 Model Selection View；不恢复旧 Provider Snapshot。
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // host 是身份权威边界：provenance/origin 必须在这里再校验一次，不能只依赖 agent
    // adapter 的 fetch wrapper。判定实现与 CLI 侧共用 @zcode/shared 的同一份，避免分叉。
    // origin 解析复用 resolveCurrentZCodeEndpointOrigin——与闲时任务同口径（含 settings
    // 覆盖），否则会出现"闲时任务能连、官方 MCP 连不上"。
    // dev 开关必须同样传入，否则本地自测会被 host 单方面拒绝。
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveZCodeApiOrigin: resolveCurrentZCodeEndpointOrigin,
    }),
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // ZCode 只发布 turn/session 事实；面板 terminal policy 由 producer coordinator 决定。
    ...(options?.serviceAuthorityMode === "desktop-local"
      ? {
          onCuaPipSessionLifecycle: (_workspace, event) => {
            void cuaPipSessionService.publishLifecycle(event);
          },
        }
      : {}),
    // 设置页的 HTTP 代理、No Proxy + 自定义 CA 按 spawn 时读取注入 agent 子进程 env，
    // 覆盖模型 API / MCP / Bash 出口流量并信任用户显式配置的证书；改动后下次启动 agent 生效。
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // 本地 Host 准备解析快照；远程 CLI 继续由自己的文件 loader 读取和迁移配置。
      if (!isDesktopAttachedRemote) await subagentsService.prepareRuntimeState(context);
      // 显式下发的 Agent 网络（Host 合成的回退中继）优先生效，不管当前入口是
      // desktop-attached stdio 还是 supervisor 启动的 standalone Source Server。
      // 每次 spawn 重新解析：SSH 反向隧道每次重连都会拿到一个新的远端 loopback 端口，
      // 若把端口冻结在 Core 启动时刻，实际会把一个已经死掉的地址交给 Agent。
      // 不能放宽成“任何已配置的代理”：owners 自己设置的代理必须继续走下面的首选语义。
      const providedNetwork = await options?.resolveRemoteAgentNetwork?.();
      const agentNetwork = providedNetwork
        ? providedNetwork
        : {
            httpProxy: settings.httpProxy,
            httpProxyList: settings.httpProxyList,
            noProxy: settings.httpProxyNoProxy,
          };
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      let cuaProductHelperEnv: Record<string, string> = {};
      if (cuaPluginEnabled && (process.platform === "darwin" || process.platform === "win32")) {
        const brokerSocket =
          process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: brokerSocket,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        if (process.platform === "win32") {
          const recipe = await resolveStableCuaWinRecipe();
          if (recipe) {
            cuaProductHelperEnv["ZCODE_CUA_WIN_HELPER_RECIPE"] = JSON.stringify({
              ...recipe,
              hostPid: process.pid,
            });
          } else {
            cuaProductHelperEnv = {
              [BROKER_UNAVAILABLE_ENV]:
                "broker_unavailable: windows helper recipe could not be resolved",
            };
          }
        }
      }
      const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentTelemetry?.getDeviceMid?.()?.trim()
        : undefined;
      // Host 是旧配置迁移的唯一写入者。Agent spawn 前等待初始化完成，避免 Worker
      // 先拿到尚不存在的 provider_config.json 并发布短暂空 Registry。
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          httpProxyList: agentNetwork.httpProxyList,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
          fallbackOnly: "fallbackOnly" in agentNetwork ? agentNetwork.fallbackOnly : undefined,
        }),
        // 把 host 解析出的权威 origin（含 settings 覆盖）下发给 agent，否则 agent 侧只按
        // env 推导，test env + 自定义端点时两侧信任判定的输入分叉、官方 MCP 整体 fail closed。
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // Agent 资源设置走 spawn env 快照；设置缺省时由 runtime 采用自适应并发与角色期限。
        ...buildAgentRootRunBudgetEnv(
          settings.subagentMaxParallel,
          settings.subagentTaskTimeoutMinutes,
        ),
        // broker 凭据（socket/token）注入 agent spawn env，让内置 zcode-cua plugin 的
        // computer-use MCP server 经 __zcode-plugin-host 恢复 token 后连上 broker。
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentTelemetry?.runtimeSurface ?? "remote_workspace_host",
          telemetryEnv,
          userId: telemetryProfile?.id,
        }),
        ...createNodeProviderRuntimePathEnv({
          // Built-in Active 路径按当前 Endpoint 隔离，不能通过同步的固定路径
          // getter 读取；Agent spawn 必须等待本轮 Endpoint Source 完成解析和物化。
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(!isDesktopAttachedRemote
      ? { readSubagentRuntimeConfig: subagentsService.readRuntimeConfig }
      : {}),
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // 预算已统一，不能把可选远端配置作为本地/手机 shared-host 建会话的前置条件。
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            // Этап 4.6: единственная проекция настроек UI → рантайм. `resolveStage4Settings`
            // подставляет дефолты для старых `setting.json`, поэтому Host не хранит свою копию.
            const stage4 = resolveStage4Settings(settings);
            const stage4Runtime = projectStage4SettingsToSessionPreferences(stage4);
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              promptDepth: resolvePromptDepthProfile(settings.promptDepth),
              autoRepairLoopEnabled: stage4Runtime.enableAutoRepairLoop,
              autoRepairLoopLimits: stage4Runtime.autoRepairLoopLimits,
              sandboxMode: stage4.sandboxSettings.mode,
              sandboxAllowNetwork: stage4.sandboxSettings.allowBashNetwork,
              sandboxCommandTimeoutMs: stage4.sandboxSettings.commandTimeoutMs,
              subagentMaxParallel: stage4Runtime.subagentMaxParallel,
              codeIndexAutoStart: stage4.codeIndexSettings.autoStartOnWorkspaceOpen,
              codeIndexVectorChannel: stage4.codeIndexSettings.enableVectorChannel,
              codeIndexTokenBudget: stage4.codeIndexSettings.searchResultTokenBudget,
              backgroundFileTasks: stage4.parallelJobsSettings.backgroundFileTasks,
              chatAutocompleteEnabled: stage4.chatAutocompleteSettings.enabled,
              promptEnhancerEnabled: stage4.promptEnhancerSettings.enabled,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              toolSearchMode: settings.toolSearchMode ?? "off",
              workspaceBoundary: settings.workspaceBoundary ?? "allow",
              memoryEnabled: settings.memoryEnabled === true,
              modelContextBudgetStrategy,
              // user-execution 只消费 Shell；共享默认策略是统一 result schema 的兼容占位，
              // 不会覆盖 runtime-materialization 阶段已经固定的 strategy。
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });

  return { zcodeAgentService };
}
