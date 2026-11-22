import type {
  ZCodeAgentSessionTarget,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentInitializeResult,
  ZCodeAgentRunAutomationNowResult,
  ZCodeAgentWorkspaceRuntimeIdentity,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentListSessionsParams,
  ZCodeAgentListSessionSubagentsParams,
  ZCodeAgentAppUsageParams,
  ZCodeAgentTaskTokenUsageParams,
  ZCodeAgentReadSessionParams,
  ZCodeAgentReadSessionMessagesParams,
  ZCodeAgentReadSessionEventsParams,
  ZCodeAgentReadWorkspacePresentationParams,
  ZCodeAgentGrantWorkspaceHookTrustParams,
  ZCodeAgentSendPromptParams,
  ZCodeAgentCompactParams,
  ZCodeAgentGoalParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentSetModeParams,
  ZCodeAgentGenerateWorkspaceTextParams,
  ZCodeAgentTestModelConnectivityParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentRespondSessionRuntimePreferencesParams,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentConversationSubscribeParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationRowsRangeParams,
  ZCodeAgentConversationPlansParams,
  ZCodeAgentConversationWorkflowRunEventsParams,
  ZCodeAgentConversationWorkflowRunsParams,
  ZCodeAgentConversationWorkflowRunArtifactsParams,
  ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ZCodeAgentConversationWorkflowRunNodeResultParams,
  ZCodeAgentBackgroundBashOutputParams,
  ZCodeAgentConversationFileChangesParams,
  ZCodeAgentConversationFileRewindPreviewParams,
  ZCodeAgentConversationCommandParams,
  ZCodeAgentCommandsQueryParams,
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentAttachmentReadParams,
  ZCodeAgentConversationAttachmentReadParams,
  ZCodeAgentConversationAttachmentStatParams,
  ZCodeAgentAttachmentPreviewSourceParams,
  ZCodeAgentConnectionFlowParams,
  ZCodeAgentSessionsIndexSubscribeParams,
  ZCodeAgentWorkspaceConfigSubscribeParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentLocalRuntimeChildProcesses,
  ZCodeAgentStorageStartupSnapshot,
} from "./params.js";
import type { PluginUiToolResultNotification } from "@zcode/shared/mcp-apps";
import type {
  BackgroundBashOutputResult,
  SessionDebugSnapshot,
  AppUsageSnapshot,
  ZCodeTaskTokenUsageResult,
  DynamicWorkflowMode,
  ZCodeAutomation,
  ZCodeAutomationRun,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalResult,
  ZCodeMessageWithParts,
  AgentLaneResourceSample,
  ZCodeMcpTelemetryEvent,
  ZCodeMcpResourceSample,
  ZCodeToolExecResource,
  ZCodeMcpListResult,
  ZCodeMcpConnectResult,
  ZCodePluginsListResult,
  ZCodePluginsOverviewResult,
  ZCodePluginsMarketplaceMutationResult,
  ZCodePluginsInstallResult,
  ZCodePluginsReferenceCatalogResult,
  ZCodeSkillsReferenceCatalogResult,
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiReadResourceResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiAppToolAcceptedResult,
  ZCodeMcpUiRegisterAppToolsResult,
  ZCodeMcpUiUnregisterAppToolsResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodePluginsListUiSurfacesResult,
  ZCodeWorkflowsDeleteResult,
  ZCodeWorkflowsForRunResult,
  ZCodeWorkflowsGetResult,
  ZCodeWorkflowsListResult,
  ZCodeWorkflowsMoveResult,
  ZCodeWorkflowsRunsResult,
  ZCodeWorkflowsSaveResult,
  ZCodeWorkflowsUpdateMetaResult,
  ZCodePluginsUninstallResult,
  ZCodePluginsRestoreBuiltinResult,
  ZCodePluginsConfigureResult,
  ZCodePluginsDescribeResult,
  ZCodePluginsValidateResult,
  ZCodePluginsSetEnabledResult,
  ZCodePluginsCancelOperationResult,
  ZCodePluginOperationProgressNotification,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderRuntimeHeadersCancelled,
  ZCodeProviderTestModelConnectivityResult,
  ZCodeSessionEvent,
  ZCodeSessionInfo,
  ZCodeSessionSendResult,
  ZCodeSessionStateSnapshot,
  ZCodeSessionSubagentsResult,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceGenerateTextResult,
  ZCodeWorkspaceHookTrustGrantResult,
} from "@zcode/shared";
import type { Event, IDisposable } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  ClientHello,
  CommandAck,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  SessionsIndexReconcileResult,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../../descriptors.js";
import type {
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentConnectMcpServerParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentWorkspaceTarget,
} from "../zcodeAgentPluginParams.js";
import type {
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
} from "../zcodeAgentWorkflowParams.js";

export interface IZCodeAgentService {
  /** 控制面不需要账号或模型，且不发送普通协议请求。 */
  prepareStorage(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeAgentStorageStartupSnapshot>;
  initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult>;
  /**
   * 同步 App 全局运行时偏好到所有已活动 workspace；不得为此启动空闲 Agent。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  /**
   * 动态工作流用户选择变化的信号（docs/dynamic-workflow/launch.md「The user's choice」）：Host 重新计算
   * 生效模式并串行重发 workspace/updateDynamicWorkflowPolicy。有本机设置权威的 Host 以设置文件为准；
   * desktop-attached remote Host 以传入值为准（缺席 = 跟随服务端）。不得为此启动空闲 Agent。
   */
  syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentWorkspaceRuntimeIdentity>;
  createSession(params: ZCodeAgentCreateSessionParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeAgentResumeSessionParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeAgentListSessionsParams): Promise<ZCodeSessionInfo[]>;
  listSessionSubagents(
    params: ZCodeAgentListSessionSubagentsParams,
  ): Promise<ZCodeSessionSubagentsResult>;
  getAppUsageStats(params: ZCodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams): Promise<ZCodeTaskTokenUsageResult>;
  readSession(params: ZCodeAgentReadSessionParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(
    params: ZCodeAgentReadSessionMessagesParams,
  ): Promise<ZCodeMessageWithParts[]>;
  readSessionDebug(params: ZCodeAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: ZCodeAgentReadSessionEventsParams): Promise<ZCodeSessionEvent[]>;
  readWorkspacePresentation(
    params: ZCodeAgentReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  /** 无 task/session 的 Settings 预信任；Agent 会重新发现并校验 canonical snapshot。 */
  grantWorkspaceHookTrust(
    params: ZCodeAgentGrantWorkspaceHookTrustParams,
  ): Promise<ZCodeWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams): Promise<ZCodeMcpListResult>;
  /** Settings 显式连接 project-scope MCP；approveProjectScope 才会写 digest approval。 */
  connectMcpServer(params: ZCodeAgentConnectMcpServerParams): Promise<ZCodeMcpConnectResult>;
  listPlugins(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：session-scoped 只读投影。
   * 走 workspace 级 agent client（session 记录只存在于该进程），不走独立插件管理进程。
   */
  getPluginReferenceCatalog(
    params: ZCodeAgentPluginReferenceCatalogParams,
  ): Promise<ZCodePluginsReferenceCatalogResult>;
  /** Composer Skill 引用 catalog；带 sessionId 时读取该 runtime 的冻结快照。 */
  getSkillReferenceCatalog(
    params: ZCodeAgentSkillReferenceCatalogParams,
  ): Promise<ZCodeSkillsReferenceCatalogResult>;
  /** 插件 UI：读取插件 MCP 的 `ui://` 资源；走 session 所在 workspace agent 进程。 */
  openMcpUiInstance(
    params: import("../../plugin-ui-bridge/contract.js").PluginUiPrepareSandboxParams & {
      accountContext?: string;
    },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  validateMcpUiInstance(
    params: import("../../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  recycleMcpUiInstance(
    params: import("../../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<boolean>;
  closeMcpUiInstance(
    params: import("../../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  readMcpResource(params: ZCodeAgentReadMcpResourceParams): Promise<ZCodeMcpReadResourceResult>;
  /** 插件 UI：UI 发起的工具调用；复用既有权限审批，不产生 transcript row。 */
  sampleMcpApp(
    params: import("../../plugin-ui-bridge/samplingContract.js").PluginUiSamplingParams,
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  cancelMcpAppSampling(
    params: import("../../plugin-ui-bridge/samplingContract.js").PluginUiCancelSamplingParams,
  ): Promise<{ cancelled: boolean }>;
  callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams): Promise<ZCodeMcpUiCallToolResult>;
  /** 插件 UI 取消带 callId 的进行中 UI 工具调用；agent 侧 abort 到 MCP client。 */
  cancelMcpToolCallForUi(
    params: ZCodeAgentCancelMcpToolCallForUiParams,
  ): Promise<ZCodeMcpUiCancelCallResult>;
  /** 插件 UI 页面发起的 `resources/read`，agent 侧限同插件服务器、8 MiB、mimeType 白名单。 */
  readMcpResourceForUi(
    params: ZCodeAgentReadMcpResourceForUiParams,
  ): Promise<ZCodeMcpUiReadResourceResult>;
  /** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe 代理。 */
  listMcpResourcesForUi(
    params: ZCodeAgentListMcpResourcesForUiParams,
  ): Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi(
    params: ZCodeAgentListMcpResourcesForUiParams,
  ): Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  /** App-Provided Tools：页面工具登记 / 注销与模型调用的认领 / 回传（信箱投递走 v4 live 增量）。 */
  registerAppToolsForUi(
    params: ZCodeAgentRegisterAppToolsForUiParams,
  ): Promise<ZCodeMcpUiRegisterAppToolsResult>;
  unregisterAppToolsForUi(
    params: ZCodeAgentAppToolInstanceForUiParams,
  ): Promise<ZCodeMcpUiUnregisterAppToolsResult>;
  claimAppToolCallForUi(
    params: ZCodeAgentAppToolCallForUiParams,
  ): Promise<ZCodeMcpUiAppToolAcceptedResult>;
  resolveAppToolCallForUi(
    params: ZCodeAgentResolveAppToolCallForUiParams,
  ): Promise<ZCodeMcpUiAppToolAcceptedResult>;
  /** 插件 UI 工作区级面板入口（已启用插件清单 `ui.surfaces[]`）。 */
  listPluginUiSurfaces(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodePluginsListUiSurfacesResult>;
  // 已保存工作流的 GUI 中枢：workspace 级、无会话，每次调用现扫 `<cwd>/.zcode/workflows/`。
  // 全局档传 `scope: "global"`：带 workspace 就用它当载体，不带则由 services 层自选本机载体运行时。
  listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams): Promise<ZCodeWorkflowsListResult>;
  getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams): Promise<ZCodeWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: ZCodeAgentUpdateSavedWorkflowMetaParams,
  ): Promise<ZCodeWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: ZCodeAgentDeleteSavedWorkflowParams,
  ): Promise<ZCodeWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: ZCodeAgentListSavedWorkflowRunsParams,
  ): Promise<ZCodeWorkflowsRunsResult>;
  // 在项目档 / 全局档之间移动同名文件：
  // `workspace` 是载体（移到项目传目标项目、移到全局传源项目），`to` 是落点档；不覆盖已存在的目标。
  moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams): Promise<ZCodeWorkflowsMoveResult>;
  // 完成卡的「直接保存」（docs/dynamic-workflow/transcript-and-notifications.md）：按 runId 从
  // journal 取这次 run 实际跑过的脚本落盘，不经模型回合。两者都必带 workspace（journal 在那里）。
  saveSavedWorkflowFromRun(
    params: ZCodeAgentSaveSavedWorkflowFromRunParams,
  ): Promise<ZCodeWorkflowsSaveResult>;
  /** 这次 run 对应哪个已保存工作流（推导，不记忆）；顺带回 run 的实参供「再次运行」预填。 */
  findSavedWorkflowForRun(
    params: ZCodeAgentFindSavedWorkflowForRunParams,
  ): Promise<ZCodeWorkflowsForRunResult>;
  resolveSuggestedPluginReference(
    params: ZCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zcode/shared").ZCodePluginsResolveSuggestedReferenceResult>;
  /** 推荐项 Plugin 首次本地检查缺失后的 operation-scoped 刷新进度。 */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZCodePluginOperationProgressNotification>;
  getPluginsOverview(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsOverviewResult>;
  /**
   * 资源管理器：枚举本 Host 内全部本地 Agent 进程（含 plugin / mcp-status 泳道），
   * 并向每个存活 runtime 请求 `process/childProcesses`；单个 runtime 失败只让它的 children 为空。
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<ZCodeAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: ZCodeAgentAddPluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZCodeAgentRemovePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  installPlugin(params: ZCodeAgentInstallPluginParams): Promise<ZCodePluginsInstallResult>;
  cancelPluginOperation(
    params: ZCodeAgentCancelPluginOperationParams,
  ): Promise<ZCodePluginsCancelOperationResult>;
  uninstallPlugin(params: ZCodeAgentUninstallPluginParams): Promise<ZCodePluginsUninstallResult>;
  updatePlugin(params: ZCodeAgentUpdatePluginParams): Promise<ZCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZCodeAgentRestoreBuiltinPluginParams,
  ): Promise<ZCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ZCodeAgentConfigurePluginParams): Promise<ZCodePluginsConfigureResult>;
  resetPluginConfig(
    params: ZCodeAgentResetPluginConfigParams,
  ): Promise<ZCodePluginsConfigureResult>;
  validatePlugin(params: ZCodeAgentValidatePluginParams): Promise<ZCodePluginsValidateResult>;
  describePlugin(params: ZCodeAgentDescribePluginParams): Promise<ZCodePluginsDescribeResult>;
  setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams): Promise<ZCodePluginsSetEnabledResult>;
  // ---- 定时任务(automation)管理 ----
  listAutomations(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAutomation[]>;
  listAllAutomations(): Promise<ZCodeAutomation[]>;
  createAutomation(params: ZCodeAgentCreateAutomationParams): Promise<ZCodeAutomation>;
  updateAutomation(params: ZCodeAgentUpdateAutomationParams): Promise<ZCodeAutomation | null>;
  deleteAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAgentRunAutomationNowResult>;
  listAutomationRuns(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAutomationRun[]>;
  deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: ZCodeAgentGenerateWorkspaceTextParams,
  ): Promise<ZCodeWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: ZCodeAgentTestModelConnectivityParams,
  ): Promise<ZCodeProviderTestModelConnectivityResult>;
  /**
   * @deprecated：send 主路径已收敛 v4 sendText 命令。仅剩两个消费点——
   * adapter 带附件输入回退（待附件命令面落地后移除）与 zcodeSessionService
   * pass-through；新代码禁止回用。
   */
  sendPrompt(params: ZCodeAgentSendPromptParams): Promise<ZCodeSessionSendResult>;
  compactSession(params: ZCodeAgentCompactParams): Promise<ZCodeSessionCompactResult>;
  goalSession(params: ZCodeAgentGoalParams): Promise<ZCodeSessionGoalResult>;
  closeSession(
    params: ZCodeAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  /**
   * 释放 Host 侧 per-session 内存镜像（seq/trace/无订阅者 emitter）。
   * 会话关闭、删除或所属 runtime 退出时由生命周期路径调用；可选是为了兼容旧测试夹具，
   * 生产实现始终存在，调用方不可依赖它执行核心业务逻辑。
   */
  forgetSession?(params: ZCodeAgentSessionTarget): void;
  setModel(params: ZCodeAgentSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeAgentSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZCodeAgentRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  respondSessionRuntimePreferences(
    params: ZCodeAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  /**
   * v4 UI 的 Start Plan runtime-auth bridge 只需要本地 pending request 事件，
   * 不能为此额外打开旧 `session/subscribe`，否则会把旧 replay/continuous 读路径
   * 重新带回 v4 pane。
   */
  onDynamicProviderRuntimeHeadersRequest(
    params: ZCodeAgentSessionTarget,
  ): Event<ZCodeProviderRuntimeHeadersRequestParams>;
  /**
   * Start Plan runtime headers 的 workspace 级订阅入口（生产应答方使用）。
   * Bug 原因（2026-08-16 web 远控卡死）：session 级入口只随桌面 pane 挂载订阅，
   * web 远控新建会话在桌面没有 pane、web 端无应答方，请求校验请求滞留 pending，
   * 任务永久「工作中」。桌面窗口用本入口为每个打开的 workspace tab 维持常驻应答方；
   * 订阅时先注册 live listener 再按 workspaceKey 前缀补投 pending，与 session 级同语义。
   */
  onDynamicWorkspaceProviderRuntimeHeadersRequest(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeProviderRuntimeHeadersRequestParams>;
  /** 只投递本 workspace 的校验取消，不属于 conversation stream。 */
  onDynamicWorkspaceProviderRuntimeHeadersCancelled(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeProviderRuntimeHeadersCancelled>;
  onDynamicSessionRuntimePreferencesRequest(): Event<ZCodeAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI 进程级资源样本，带 services 打的 lane 标签（CLI 自己不知道 lane）。
   * 使用 dynamic event 避免 RPC 服务在无人订阅时缓冲周期事件；
   * 该事件不属于 session/conversation continuous 或 replayable 状态。
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP 进程生命周期与低频内存事件，仅供可信 Host relay 上报 ARMS。 */
  onDynamicMcpTelemetry(): Event<ZCodeMcpTelemetryEvent>;
  /** MCP 进程树资源事实，只供可信 Host 汇总上报。 */
  onDynamicMcpResourceSamples(): Event<ZCodeMcpResourceSample[]>;
  /** Bash 完成事实，仅可信 Host 资源旁路订阅。 */
  onDynamicToolExecResource(): Event<ZCodeToolExecResource>;
  /**
   * @deprecated 旧协议订阅面（session/subscribe + session/event + state.updated）。
   * task-index syncer 已迁 v4 sessions-index/workspace-config 帧；
   * 仅剩 zcodeTaskServiceAdapter.onDynamicTaskEvent（replayable 读路径）消费。
   * 写路径已收敛 v4 命令面；本订阅是读路径投影源。
   */
  onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams): Event<ZCodeAgentServiceEvent>;
  // ── v4 conversation 通道（竖切）──
  /** RPC attachment 建立后先读取 host 可信 hello。 */
  helloConversationV4(): Promise<HelloMessage>;
  /** hello 校验后回送 clientHello；metadata 不能覆盖 connection mode/profile。 */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** 仅供 trusted host relay/facade；terminal RPC caller 必须被 connection scope 拒绝。 */
  setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: ZCodeAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** rows/range 行分页 query（loadOlder 游标向上补历史）。 */
  conversationRowsRangeV4(
    params: ZCodeAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: ZCodeAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** workflow run 事件日志分页；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunEventsV4(
    params: ZCodeAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举；journal-backed 的重启后发现面。 */
  conversationWorkflowRunsV4(
    params: ZCodeAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** workflow run 的用户面产物清单；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunArtifactsV4(
    params: ZCodeAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页；hook 以 itemCount 变化为信号增量拉取。 */
  conversationWorkflowRunArtifactDataV4(
    params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块；授权在 CLI 侧（journal 行才是取字节的依据）。 */
  conversationWorkflowRunArtifactReadV4(
    params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 工作区 transcript 的清单。 */
  conversationWorkflowRunWorkspaceV4(
    params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文。 */
  conversationWorkflowRunNodeResultV4(
    params: ZCodeAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: ZCodeAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: ZCodeAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: ZCodeAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: ZCodeAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
  /** Desktop local 已发送视频 source query；远端与 Web 返回 chunked。 */
  attachmentPreviewSourceV4(
    params: ZCodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** 已发送 image/video 只读分块查询；connection scope 注入可信 workspace 连接。 */
  attachmentReadV4(params: ZCodeAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share 读取 userInput 附件，允许 text/plain 等非媒体类型。 */
  conversationAttachmentReadV4(
    params: ZCodeAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Share 选择阶段只读 userInput 附件元数据，不读取完整内容。 */
  conversationAttachmentStatV4(
    params: ZCodeAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** workspace 级下行帧流（v4/conversation/frame），renderer 侧按 topic 自行路由。 */
  onDynamicConversationFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** workspace 级 live telemetry 事实；connection facade 仅向可信 desktop-continuous 下游暴露。 */
  onDynamicLocalTtftFacts(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<import("@zcode/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** Host 消费驻留 CLI 的闲时生命周期；不参与聊天快照恢复。 */
  onDynamicOffPeakLifecycle(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<import("@zcode/shared").OffPeakLifecycleNotification>;
  controlOffPeakExecutionV4(
    params: ZCodeAgentWorkspaceTarget & { control: import("@zcode/shared").OffPeakControlParams },
  ): Promise<import("@zcode/shared").OffPeakControlResult>;
  /** 当前窗口全部本地 live task 的 CUA 权限观察；历史、远程与 replayable 不在此事件面。 */
  onDynamicCuaPermissionObservation(): Event<ZCodeAgentCuaPermissionObservation>;
  /** 本地桌面窗口创建插件页面，不依赖 conversation 订阅。 */
  onDynamicPluginUiToolResult(): Event<
    PluginUiToolResultNotification & { workspacePath: string; workspaceIdentity?: string }
  >;

  /** 只读 CLI 持久事实；不恢复会话运行实例。旧远端可以不提供此能力。 */
  reconcileSessionsIndexV4?(
    params: ZCodeAgentWorkspaceTarget & { sessionIds: string[] },
  ): Promise<SessionsIndexReconcileResult>;
  // ── M5 sessions-index 通道（列表活性）──
  subscribeSessionsIndexV4(
    params: ZCodeAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 sessions-index 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicSessionsIndexFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config 通道（配置目录活性；task-index syncer 消费）──
  subscribeWorkspaceConfigV4(
    params: ZCodeAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 workspace-config 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicWorkspaceConfigFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * （CLI 重连重订）：agent 进程换代通知（超时回收/崩溃后重新拉起）。
   * v4 订阅活在 CLI 进程内存，进程换代即失效；订阅方（task-index syncer 等）
   * 收到后必须对该 workspaceKey 重发 subscribe，否则帧流静默中断。
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Agent client 在 service 内完成登记后发布 available，当前 client 关闭后发布 unavailable。
   * 这是被动 observer attach/detach 的唯一生命周期信号，不表达用户使用租约。
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** 当前 desktop-local CUA turn 是否仍在执行，用于 Helper recovery 避免中途回收 Agent。 */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const IZCodeAgentService = createServiceDescriptor<IZCodeAgentService>(
  ServiceChannels.ZCodeAgent,
);
