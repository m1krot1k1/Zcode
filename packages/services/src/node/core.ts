// Фундамент Local Host: креденшелы, broadcast, сетевой transport, индексы задач,
// account/OAuth репозитории и файловые сервисы.
import type { BuildContext } from "./bundles.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  isCurrentOAuthCredentialRequest,
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createBroadcastService } from "../broadcast/broadcastService.js";
import { createCredentialService } from "../credential/credentialService.js";
import type { IFileService } from "../file/file.js";
import { createFileService } from "../file/fileService.js";
import { createGitCheckpointService } from "../git/gitCheckpointService.js";
import type { IMediaPreviewService } from "../media-preview/mediaPreview.js";
import { createMediaPreviewService } from "../media-preview/mediaPreview.js";
import { createAccountProjectTokenClient } from "../model-provider/accountProjectTokenClient.js";
import { AccountProviderApiClient } from "../model-provider/accountProviderApiClient.js";
import { AccountProviderApiKeyResolver } from "../model-provider/accountProviderApiKeyResolver.js";
import { createAccountProviderCredentialService } from "../model-provider/accountProviderCredentialService.js";
import { createAccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";
import { createLegacyTeamOrganizationResolver } from "../model-provider/legacyTeamOrganizationResolver.js";
import { PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS } from "../model-provider/providerProvisioningSource.js";
import { OAuthCredentialRepo } from "../oauth/repo/oauthCredentialRepo.js";
import {
  createHasExistingLocalTask,
  hasAnyAgentSessionRow,
  resolveAgentSessionDbPath,
} from "../onboarding/localUsageEvidence.js";
import { createOnboardingRecordService } from "../onboarding/onboardingRecordService.js";
import { createNodeApiClient } from "../providers/api/nodeApiClient.js";
import type { HostApiNetworkTransport } from "../providers/api/nodeApiNetwork.js";
import { createHostApiNetworkTransport } from "../providers/api/nodeApiNetwork.js";
import { TaskIndexRepo } from "../session/taskIndexRepo.js";
import { createSystemService } from "../system/systemService.js";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, buildLocalMediaPreviewUrl } from "@zcode/shared";
import type { AppSettings, ProviderFamilyDomain } from "@zcode/shared";
import { join } from "node:path";
import { getAppConfigDir as resolveAppConfigDir } from "../paths.js";

/** Фундамент, который получают все последующие фазы сборки Local Host. */
export interface CoreServices {
  credentialService: ReturnType<typeof createCredentialService>;
  accountProviderCredentialStore: ReturnType<typeof createAccountProviderCredentialStore>;
  broadcastService: ReturnType<typeof createBroadcastService>;
  gitCheckpointService: ReturnType<typeof createGitCheckpointService>;
  hostApiNetworkTransport: HostApiNetworkTransport;
  zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  };
  apiClient: ReturnType<typeof createNodeApiClient>;
  systemService: ReturnType<typeof createSystemService>;
  taskIndexRepo: TaskIndexRepo;
  onboardingRecordService: ReturnType<typeof createOnboardingRecordService>;
  oauthCredentialRepo: OAuthCredentialRepo;
  projectTokenClient: ReturnType<typeof createAccountProjectTokenClient>;
  accountProviderCredentialService: ReturnType<typeof createAccountProviderCredentialService>;
  resolveLegacyTeamOrganization: ReturnType<typeof createLegacyTeamOrganizationResolver>;
  readAccountProviderSettings: () => Promise<{
    providerFamilyDomain: ProviderFamilyDomain | null;
    selections: NonNullable<AppSettings["providerFamilyConnectionSelections"]>;
    unresolvedFamilies: readonly ProviderFamilyDomain[];
  }>;
  loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
  fileService: IFileService;
  mediaPreviewService: IMediaPreviewService;
}

export function createCoreServices(args: BuildContext): CoreServices {
  const {
    options,
    localSettings,
    settingService,
    resolveCurrentZCodeEndpointOrigin,
    pluginUiInvalidation,
    oauthLogout,
  } = args;
  let invalidateProjectTokens = () => {};
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key === "oauth:active_provider" || /^oauth:[^:]+:user_info$/.test(key))
        pluginUiInvalidation.current?.();
      if (provisioningOAuthKeys.has(key)) invalidateProjectTokens();
      if (provisioningOAuthKeys.has(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => zcodeJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    isBusinessUnauthorizedRequest: (input, _headers) =>
      isOAuthBusinessRequest({ input, credentialService }),
    resolveBusinessCredentialValidationRequest: (input, headers) =>
      resolveOAuthBusinessCredentialValidationRequest({
        input,
        headers,
        credentialService,
      }),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
    resolveClientLanguage: options?.resolveClientLanguage,
  });
  const systemService = createSystemService();
  // onboarding 资格与任务列表共用同一份全局 tasks-index；repo 懒加载数据库，提前构造不会
  // 增加启动 I/O，后续 session syncer 也继续复用这一实例。
  const taskIndexRepo = new TaskIndexRepo(undefined, options?.projectStorageHostId);
  // onboarding 完成记录：userId 由登录态补全（apikey/未登录为 null），见 docs/onboarding-record-spec.md。
  const onboardingEvidenceLogger = createServiceLogger("onboardingRecordService");
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    // 老用户使用证据不能只查 tasks-index：索引是 session 同步器的衍生投影，同步器在
    // agent/provider 就绪后才回填，而判定在登录完成、主界面挂载时执行，早于回填——
    // 2026-10 线上误弹：索引重建后登录瞬间判定看到空索引，老用户被当成新用户弹出引导
    // （取证：判定时刻全部历史任务行还在 WAL 未落库）。会话库与旧版快照目录是磁盘级
    // 持久事实，与同步时序无关；includeDeleted 让清空过任务列表的存量用户也不失去
    // 资格。会话证据必须查 cli/db/db.sqlite 的 session 表（评审 CR-01：cli/sessions
    // 是工作流输出目录，且文件存在性不代表有会话）。
    hasExistingLocalTask: createHasExistingLocalTask({
      listIndexTasks: () => taskIndexRepo.listTaskMetas({ includeDeleted: true }),
      // 解析结果 null（相对路径/project 覆盖等无法镜像的配置）→ 跳过会话证据源，
      // 继续旧版快照检查；不得猜默认路径，否则自定义会话库的存量用户被漏判。
      // 跳过/命中各留一条 debug（评审 SG-02）：判定每登录一次至多一条，线上复核
      // "走了哪个证据源"有据可依；不记录完整路径，避免 home 路径进日志。
      hasAgentSessionRow: async () => {
        const sessionDbPath = await resolveAgentSessionDbPath();
        if (sessionDbPath === null) {
          onboardingEvidenceLogger.debug(
            "onboarding 会话证据源跳过：会话库路径不可镜像（相对路径或 project 级覆盖）",
          );
          return false;
        }
        const hasRow = await hasAnyAgentSessionRow(sessionDbPath);
        onboardingEvidenceLogger.debug("onboarding 会话证据源已查询", {
          hasRow,
        });
        return hasRow;
      },
      resolveLegacyTaskSessionsDir: () => join(resolveAppConfigDir(), "sessions"),
    }),
  });
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // telemetry 之外的后台路径可能先读到损坏 OAuth 凭据。
      // 这类恢复也必须等价于 logout，复用同一 handler 清理派生模型 provider key。
      // 账号刷新 resolver 也可能读到损坏 token；等待下一轮刷新会让当前轮循环等待自身。
      // OAuth 删除已经完成，派生刷新交回原 Account Source 队列，后台只观察失败。
      void Promise.all(
        providers.map((provider) => oauthLogout.current?.(provider) ?? Promise.resolve()),
      ).catch((error: unknown) => {
        createServiceLogger("oauth-credential-recovery").warn(
          "refresh derived providers after corrupt OAuth cleanup failed",
          { error },
        );
      });
    },
  });
  const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);
  invalidateProjectTokens = () => projectTokenClient.clear();
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
    projectTokenClient,
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderMaterial: (
      family,
      accessToken,
      accountIdentity,
      rejectedProjectTokenFingerprint,
    ) =>
      accountProviderApiKeyResolver.resolveProviderMaterial(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
        accountIdentity,
        rejectedProjectTokenFingerprint,
      ),
  });
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
    // 迁移只在账号事实入口协调。ApiClient 的代理/端点仍读普通 Setting，不递归等待迁移。
    // 外部注入的 Setting（远端 attachment）由其所属 Host 管理，不读取本机旧文件。
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
  // Файловые сервисы создаются в фундаменте: проектному слою нужен fileService,
  // а media preview зависит только от него и опций Host.
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  return {
    credentialService,
    accountProviderCredentialStore,
    broadcastService,
    gitCheckpointService,
    hostApiNetworkTransport,
    zcodeJwtLogoutHandlerRef,
    apiClient,
    systemService,
    taskIndexRepo,
    onboardingRecordService,
    oauthCredentialRepo,
    projectTokenClient,
    accountProviderCredentialService,
    resolveLegacyTeamOrganization,
    readAccountProviderSettings,
    loadAccountIdentity,
    fileService,
    mediaPreviewService,
  };
}
