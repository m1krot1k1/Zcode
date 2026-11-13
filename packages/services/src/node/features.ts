// Feature-сервисы Host: skills/MCP/plugins/plugin UI/subagents/code intelligence
// и клиентские подписки (dynamic workflow, off-peak).
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { BuildContext, CoreServices, ProviderServices } from "./bundles.js";
import { createCodeIntelligenceService } from "../code-intelligence/index.js";
import { createCodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscriptionService.js";
import { createCommandsService } from "../commands/commandsService.js";
import { createHooksService } from "../hooks/hooksService.js";
import { createMcpSyncService } from "../mcp-sync/mcpSyncService.js";
import { createMemoryService } from "../memory/memoryService.js";
import { buildOffPeakModelSelectionView } from "../model-provider/offPeakModelSelectionView.js";
import { resolveOfficialMcpCredentials } from "../official-mcp/officialMcpCredentials.js";
import { createPluginSyncService } from "../plugin-sync/pluginSyncService.js";
import {
  createPluginUiAppToolsService,
  createPluginUiBridgeService,
  createPluginUiSamplingService,
} from "../plugin-ui-bridge/index.js";
import { createPluginUiAccountBindings } from "../plugin-ui-bridge/instanceAccounts.js";
import { createSkillsService } from "../skills/skillsService.js";
import { createSourceServerWorkspaceService } from "../source-server-workspace/sourceServerWorkspaceService.js";
import { createSubagentsService } from "../subagents/subagentsService.js";
import { join } from "node:path";
import { getZCodeDataRootDir as projectDataRoot } from "#src/paths.js";

export function createFeatureServices(args: BuildContext & CoreServices & ProviderServices) {
  const {
    options,
    isDesktopAttachedRemote,
    settingService,
    apiClient,
    credentialService,
    oauthCredentialRepo,
  } = args;
  const { providerRuntime, accountRequestAuthService, accountProviderConfigSource } = args;
  const { pluginUiInvalidation } = args;
  // Ленивые ссылки: feature-мосты объявлены раньше Agent Service, вызываются после сборки.
  const agentService = (): IZCodeAgentService => args.agentServiceRef.current!;
  const offPeakTask = args.offPeakTask;
  const sourceServerWorkspaceService =
    options.sourceServerWorkspaceService ?? createSourceServerWorkspaceService();
  // 官方 Server MCP 的凭证解析源。MCP 调用的身份头与 MCP 额度查询（/api/v1/mcp/usage）
  // 必须共用这一份实现，否则两处对"当前选中的 Coding Plan 连接"的判定会分叉。
  // 额度侧注入的是凭证解析而非 resolveHeaders：归属校验需要 providerFamily，
  // 而身份头里没有 family；身份头仍由同一个 buildOfficialMcpAuthHeaders 构造。
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // mcpSync/hooks 里引用 zcodeAgentService 的闭包是惰性调用，声明顺序不影响初始化。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // mcp/list 的 host 消费点收拢到 mcpSync 服务；真实状态检查仍在 agent 进程。
    listMcpServerStatuses: (params) => agentService().listMcpServerStatuses(params),
    connectMcpServer: (params) => agentService().connectMcpServer(params),
  });
  const pluginSyncService = createPluginSyncService();
  const pluginUiAccounts = createPluginUiAccountBindings({
    async readAccount() {
      const provider = await oauthCredentialRepo.loadActiveProvider();
      const profile = provider ? await oauthCredentialRepo.loadUserProfile(provider) : null;
      return [provider, profile?.id ?? null];
    },
    open: (params) => agentService().openMcpUiInstance(params),
    close: (params) => agentService().closeMcpUiInstance(params),
  });
  pluginUiInvalidation.current = () => pluginUiAccounts.invalidate();
  const pluginUiBridgeService = createPluginUiBridgeService({
    reportTelemetryEvent: options?.reportPluginTelemetryEvent,
    openInstance: (params) => pluginUiAccounts.open(params),
    closeInstance: (params) => pluginUiAccounts.close(params),
    validateInstance: (params) => agentService().validateMcpUiInstance(params),
    recycleInstance: (params) => agentService().recycleMcpUiInstance(params),
    // 插件 UI：资源读取与 UI 工具调用都发生在 session 所在的 agent 进程；host 只做校验与登记。
    readMcpResource: (params) => agentService().readMcpResource(params),
    callMcpToolForUi: (params) => agentService().callMcpToolForUi(params),
    cancelMcpToolCallForUi: (params) => agentService().cancelMcpToolCallForUi(params),
    readMcpResourceForUi: (params) => agentService().readMcpResourceForUi(params),
    listMcpResourcesForUi: (params) => agentService().listMcpResourcesForUi(params),
    listMcpResourceTemplatesForUi: (params) => agentService().listMcpResourceTemplatesForUi(params),
    subscribeMcpResourceForUi: (params) => agentService().subscribeMcpResourceForUi(params),
    unsubscribeMcpResourceForUi: (params) => agentService().unsubscribeMcpResourceForUi(params),
    listPluginUiSurfaces: (params) => agentService().listPluginUiSurfaces(params),
    registerSandbox: options?.registerPluginSandbox,
  });
  // App-Provided Tools：页面工具登记与模型调用的认领 / 回传都发生在 session 所在的 agent 进程。
  const pluginUiSamplingService = createPluginUiSamplingService({
    sample: (params) => agentService().sampleMcpApp(params),
    cancelSampling: (params) => agentService().cancelMcpAppSampling(params),
  });
  const pluginUiAppToolsService = createPluginUiAppToolsService({
    registerAppToolsForUi: (params) => agentService().registerAppToolsForUi(params),
    unregisterAppToolsForUi: (params) => agentService().unregisterAppToolsForUi(params),
    claimAppToolCallForUi: (params) => agentService().claimAppToolCallForUi(params),
    resolveAppToolCallForUi: (params) => agentService().resolveAppToolCallForUi(params),
  });
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const codeIntelligenceService = createCodeIntelligenceService({
    indexRootDir: join(projectDataRoot(), "code-intelligence"),
    credentialService,
  });
  const _commandsService = createCommandsService({ isDesktopRuntime: true });
  const _hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => agentService().grantWorkspaceHookTrust(params),
  });
  const _memoryService = createMemoryService();
  // 只要当前进程已经装配 Provider Runtime，就由该 Environment 自己的 Selection View
  // 决定执行就绪状态。Desktop-attached remote 也读取远端自己的 Config/Account Facts。
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  // ===== Computer Use Helper lifecycle 层（port 自 feat）=====
  // 约束：lifecycle coordinator 懒获取 + 代际 fence（dispose 仅来自显式 workspace 生命周期）；
  // 不创建定时健康探测；Helper restart 尽可能复用 host transport，既有 Agent 的 session、
  // 进程与 MCP stream 保持不变。
  // P1-a mitigation：createDefaultCuaProductHelper() 在 zcodeAgentService 存在之前就要组装 resolver，
  // 但"是否有活跃 turn"这个信号只有 zcodeAgentService 建好之后才能查询。用前向引用占位——resolver 真正
  // 调用 hasActiveTurn() 发生在后续某次 resolveMcpServers（异步），那时 hasActiveTurnRef 早已被赋值。
  // 先用前向引用连接 agent service 的 CUA turn tracker，避免在活跃 CUA 请求中途重启 Helper；

  // 动态工作流的用户选择（docs/dynamic-workflow/launch.md「The user's choice」）：本机设置文件是唯一来源，
  // 每次使用时读取。desktop-attached remote Host 读不到桌面的设置，选择由 desktop 推送
  // （agentService().syncDynamicWorkflowUserMode），这里不注入。读取失败按「跟随」处理。
  const resolveDynamicWorkflowUserMode = isDesktopAttachedRemote
    ? undefined
    : async () => (await settingService.get()).dynamicWorkflowMode;
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // OffPeakTaskService 单例在下方 DI register IIFE 中创建（晚于 agent service）；
  // 用前向引用 holder 惰性绑定——offPeak/create 协议请求只会发生在服务集合装配完成后。
  // desktop-attached-remote 装配不暴露 Off-Peak 工具面（远程不在支持范围）。
  const offPeakToolWiring =
    options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTask.current,
        };
  return {
    sourceServerWorkspaceService,
    officialMcpCredentialSource,
    skillsService,
    mcpSyncService,
    pluginSyncService,
    pluginUiBridgeService,
    pluginUiSamplingService,
    pluginUiAppToolsService,
    subagentsService,
    codeIntelligenceService,
    modelSelectionReadinessSource,
    agentAccountProviderConfigSource,
    codingPlanSubscriptionService,
    resolveDynamicWorkflowUserMode,
    offPeakToolWiring,
  };
}
