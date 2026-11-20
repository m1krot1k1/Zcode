// Тонкий барrel публичной поверхности @zcode/services/node: только ре-экспорты.

export {
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
} from "#src/remote-projects/index.js";
export { createLegacySingleRootProjectService } from "#src/project/index.js";
export { createRemoteProjectService } from "#src/remote-projects/index.js";
export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
export {
  createTopicResourcePeers,
  type TopicResourcePeers,
} from "../zcode-agent/topicResourcePeers.js";
export { createTopicResourceRelayChannel } from "../zcode-agent/topicResourceRelayChannel.js";

export { createFileService } from "../file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "../process/processResourceSampler.js";
export { createMediaPreviewService } from "../media-preview/mediaPreview.js";
export { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
export type { ContentBundle } from "#src/cloud-content/contentBundleCache.js";
export type { CreateFileServiceOptions } from "../file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "../file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "../fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "../fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "../paths.js";
export { createGitService } from "../git/gitService.js";
export { GitCommitMessageGenerator } from "../git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "../git/gitCheckpointService.js";
export { createSystemService } from "../system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "../system/sshConfigAlias.js";
export { createTerminalService } from "../terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "../setting/settingService.js";
export { createCredentialService } from "../credential/credentialService.js";
export { createBroadcastService } from "../broadcast/broadcastService.js";
export { createZCodeAgentService } from "../zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "../zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "../zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "../zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "../zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "../zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "../zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "../zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "../zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export {
  createCuaHelperInstaller,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "../cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
} from "../cua-permission-broker/cuaHelperInstaller.js";
export type {
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
} from "../cua-permission-broker/index.js";
export { createProjectWorkspaceNavigation } from "#src/project-workspace-navigation/index.js";
export { createBotsService } from "../bots/botsService.js";
export { createFileWatcherService } from "../fileWatcher/fileWatcherService.js";
export { createOAuthService } from "../oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "../oauth/oauthProviderLogout.js";
export { OAuthCredentialRepo } from "../oauth/repo/oauthCredentialRepo.js";
export { createTelemetryCore, ensureTelemetryDeviceMid } from "../telemetry/telemetryCore.js";
export type { EnsureTelemetryDeviceMidOptions } from "../telemetry/telemetryCore.js";
export type { AccountRequestAuthResolver } from "../model-provider/accountProviderRequestAuthService.js";
export { createAccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "../model-provider/accountProviderCredentialStore.js";
export { importLegacyPersonalProviderConfig } from "../model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "../model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "../model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "../model-provider/accountProviderConnectionResolver.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "../model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "../model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  OpenCodeCliProviderCatalogSource,
  ProviderRuntime,
} from "../model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "../model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "../model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "../model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "../model-provider/providerFacadeServices.js";
export { createAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "../model-provider/accountProviderRequestAuthService.js";
export {
  resolveAccountTeamPlanRuntimeApiKey,
  resolveAccountTeamPlanRuntimeMaterial,
} from "../model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProjectTokenClient } from "../model-provider/accountProjectTokenClient.js";
export { createAccountProviderCredentialService } from "../model-provider/accountProviderCredentialService.js";
export { createSourceServerWorkspaceService } from "../source-server-workspace/sourceServerWorkspaceService.js";
export {
  SourceServerWorkspaceIdentityChannelServer,
  SourceServerWorkspaceIdentityMapper,
} from "../source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
export {
  SourceServerWorkspaceAliasRepo,
  SourceServerWorkspaceIdentityConflictError,
} from "../session/sourceServerWorkspaceAliasRepo.js";
export { migrateControllerRemoteWorkspaceIdentity } from "../session/controllerRemoteIdentityMigration.js";
export type {
  ControllerRemoteIdentityMigrationOptions,
  ControllerRemoteIdentityMigrationReport,
} from "../session/controllerRemoteIdentityMigration.js";
export { createUsageStatsService } from "../usage-stats/usageStatsService.js";
// Storage：service 与 adapters 工厂；desktop host 负责组装（Worker runner 在 desktop 包内）
export { createStorageService } from "../storage/app/storageService.js";
// 组装方与工厂在同一入口取类型，避免 desktop main 为服务接口再引 browser 入口。
export type { IStorageService } from "../storage/contract.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "../storage/app/ports.js";
export { createFsStorageCleaner } from "../storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "../storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "../storage/adapters/volumeProbe.js";
export { runStorageScan } from "../storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "../client-config/clientConfigService.js";
export { createClientScenesService } from "../client-scenes/clientScenesService.js";
export { createSkillsService } from "../skills/skillsService.js";
export { createSkillSyncService } from "../skill-sync/skillSyncService.js";
export { createMcpSyncService } from "../mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "../plugin-sync/pluginSyncService.js";
export { createPluginsService } from "../plugins/pluginsService.js";
export { createPluginManagementService } from "../plugins/pluginManagementService.js";
export {
  createSubagentsService,
  provisionSkillAgentProfile,
} from "../subagents/subagentsService.js";
export { createCommandsService } from "../commands/commandsService.js";
export { createHooksService } from "../hooks/hooksService.js";
export { createMemoryService } from "../memory/memoryService.js";
export { createOutputStyleService } from "../output-style/outputStyleService.js";
export { createSettingsSyncService } from "../settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "../feedback/feedbackLogArchive.js";
export { createFeedbackService } from "../feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "../feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "../prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "../conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "../providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  testProxyConnectivity,
  type HostApiNetworkTransport,
  type ProxyConnectivityResult,
} from "../providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "../runtime-tools/runtimeCommandEnv.js";

// 定时任务管理与 scheduler 共用同一套 node-only 存储和 cron 语义。
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "../session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "../session/automationService.js";
// 闲时任务与 automation 同库不同表；类型/常量全独立。
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "../session/offPeakTaskRepo.js";
// host 域终态回填 files_changed 复用现有 task diff 汇总。
export { buildTaskChangeSummary } from "../session/taskChangeSummary.js";
export { OffPeakTaskService } from "../session/offPeakTaskService.js";
export { IOffPeakTaskService } from "../session/offPeakTask.js";
export { IHighspeedCardService } from "../highspeed/highspeedCard.js";
export { createOffPeakServerClient, OffPeakServerError } from "../session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "../session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "../session/offPeakRuntimeModel.js";
export { createServiceLogger } from "../logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "../official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "../session/automationCron.js";

export type { BotProjectConnection } from "#src/bot-project-runtime/contract.js";

// 这些 conversation-share 实现依赖 Node 文件系统；仅通过 @zcode/services/node 暴露，
// 防止 browser-safe 根入口把 node:* 依赖带进 renderer。
export {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "../conversation-share/conversationShareService.js";
export { ConversationShareHttpClient } from "../conversation-share/conversationShareHttpClient.js";

export { isOfficialCuaPluginEnabledForWorkspace } from "#src/cua-permission-broker/index.js";

export { bindRemoteProjectIdentities } from "#src/project/index.js";

export { startupStorage } from "#src/startup-storage/index.js";

export { scopeConversationShareServiceForAttachment } from "../conversation-share/conversationShareConnectionScope.js";
export { localRuntimeNetworkCapture } from "../zcode-agent/localRuntimeNetworkCapture.js";
