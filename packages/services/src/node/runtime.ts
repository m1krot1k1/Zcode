// Runtime-сервисы: task index syncer, авто-архивация, сессии, git, task adapter,
// bots, OAuth, off-peak зависимости, conversation share и marketing assets.
import type {
  AgentServices,
  BuildContext,
  CoreServices,
  CuaServices,
  FeatureServices,
  ProjectServices,
  ProviderServices,
} from "./bundles.js";
import { createBotProjectRuntime } from "#src/bot-project-runtime/index.js";
import { BotsRepo } from "#src/bots/repo.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import { createTaskAutoArchiveScheduler } from "#src/project/index.js";
import { createUnsupportedConversationShareService } from "../conversation-share/conversationShare.js";
import { createLocalConversationShareArtifactSource } from "../conversation-share/conversationShareArtifactSource.js";
import { ConversationShareHttpClient } from "../conversation-share/conversationShareHttpClient.js";
import { ConversationShareService } from "../conversation-share/conversationShareService.js";
import { GitCommitMessageGenerator } from "../git/gitCommitMessageGenerator.js";
import { createGitService } from "../git/gitService.js";
import type { OffPeakRequestAuthBuilder } from "./side-tables.js";
import { createOAuthService } from "../oauth/oauthService.js";
import {
  buildOffPeakRequestAuth,
  resolveOffPeakCredentials,
} from "../session/offPeakRuntimeModel.js";
import { createZCodeTaskIndexSyncer } from "../zcode-agent/zcodeTaskIndexSyncer.js";
import { createZCodeTaskServiceAdapter } from "../zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "../zcode-session/zcodeSessionService.js";
import {
  ZCODE_ENV,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  buildRuntimeZCodeApiUrl,
  zcodeAccountAccessSchema,
  zcodeProviderAccountAccessSchema,
} from "@zcode/shared";
import { type IConversationShareService as IConversationShareServiceType } from "../conversation-share/conversationShare.js";

export function createRuntimeServices(
  args: BuildContext &
    CoreServices &
    ProviderServices &
    FeatureServices &
    CuaServices &
    ProjectServices &
    AgentServices,
) {
  const {
    options,
    isDesktopAttachedRemote,
    zcodeJwtLogoutHandlerRef,
    settingService,
    apiClient,
    credentialService,
    oauthCredentialRepo,
    providerRuntime,
    taskIndexRepo,
    accountRequestAuthService,
    zcodeAgentService,
    cuaProductMcpServerResolver,
    publishProjectChange,
    oauthLogout,
    broadcastService,
    remoteProjectService,
  } = args;
  // desktop-continuous UI 直接订阅 zcodeSessionService，绕开 ZCode task adapter 的
  // mapServiceEvent 路径，导致 task_complete 永远不会写回 sqlite，侧边栏 spinner 不停。
  // 在 services 层装配一个共享的 taskIndexRepo + syncer，session 任意入口都会唤醒
  // shadow 订阅，把 runtime 终态收敛进 sqlite。
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  // 自动归档只由这里的定时扫描触发（启动首轮 + 每小时 + 设置变更补扫）；readTree 与任务点击
  // 都不再执行 archiveInactive。判据仍排除 syncer 观察到的非终态会话，不为扫描启动 CLI。
  const taskAutoArchiveScheduler = createTaskAutoArchiveScheduler({
    readPolicy: async () => {
      const settings = await settingService.get();
      if (!settings.taskAutoArchiveEnabled) return null;
      const days = Math.max(1, Math.floor(settings.taskAutoArchiveOlderThanDays ?? 30));
      return {
        cutoff: Date.now() - days * 86_400_000,
        activeTasks: zcodeTaskIndexSyncer.activeTaskRefs(),
      };
    },
    repository: () => taskIndexRepo.getProjectRepository(),
    afterChange: publishProjectChange,
  });

  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // Git sidecar 属于目标 Environment；初始模型直接读取同一 Host View，
        // 不再通过临时 Agent workspace state 反推模型与 reasoning。
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // task wrapper 由 ZCode task service adapter 提供；核心 session 状态由 ZCode agent server 维护。
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    settingService,
    cuaProductMcpServerResolver,
  });
  const botsRepo = new BotsRepo();
  const botLog = createServiceLogger("bots");
  const botRemoteWorkspaceService = options.resolveBotProjectConnection
    ? createBotProjectRuntime({
        remoteProjectService,
        resolveOnline: options.resolveBotProjectConnection,
        onConnectionsChanged: (listener) =>
          broadcastService.onMessage((event) => {
            if (event.channel === "state:projects") listener();
          }),
        readBoundTargets: async () =>
          Object.values((await botsRepo.readState()).bots).flatMap((context) =>
            context.workspaceIdentity
              ? [
                  {
                    workspacePath: context.workspacePath,
                    workspaceIdentity: context.workspaceIdentity,
                    hostId: context.hostId,
                  },
                ]
              : [],
          ),
        readRuntimePreferences: async () => {
          const settings = await settingService.get();
          return {
            askUserQuestionAutoResolutionEnabled:
              settings.askUserQuestionAutoResolutionEnabled !== false,
            modelIoFullRetentionEnabled: settings.modelIoFullRetentionEnabled === true,
          };
        },
        warn: (message) => botLog.warn(message),
      })
    : undefined;
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    onProviderLogout: oauthLogout.current ?? undefined,
  });
  const zcodeJwtLogoutLogger = createServiceLogger("zcode-jwt-logout");
  zcodeJwtLogoutHandlerRef.current = (input, headers) => {
    // 条件退出本身已串行去重；不能丢弃等待旧候选期间到来的新凭据 401。
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // 401 分类后可能已完成新登录；只有队列内真正清理的旧会话才广播过期。
        if (invalidated) {
          void broadcastService.send({
            channel: ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        zcodeJwtLogoutLogger.warn("ZCode JWT logout failed", { error });
      });
  };
  // Desktop Host 曾从 Settings View 再扫描一次 Account Provider，既绕开
  // Registry 的 entitlement/executable 事实，也在多个套餐同时可见时无法唯一选择。
  // 闲时服务与 Host 派发必须共享同一个 Registry-backed 凭据解析闭包。
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start 缓存的是首次就绪；账号后到或切换后必须读 Registry 最近完成的快照。
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = zcodeProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: zcodeAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
  const conversationShareClient = new ConversationShareHttpClient({
    // 分享运行时始终走真实 API；测试/Mock 场景应在 service 单测或 Web fixture 中显式注入，
    // 不能让开发环境默认生成仅存在于进程内存的 mock-share 链接。
    apiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.zcodeJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // 注册链上的懒工厂（如 OffPeak）会各自创建 tasks-index sqlite repo；先收集到本数组，
  // services 集合建好后在 return 前统一登记进 sharedSqliteRepos 侧表
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const marketingAssets = createMarketingAssetRegistry({
    allowLoopback: ZCODE_ENV === "test" || process.env.NODE_ENV === "development",
  });
  return {
    zcodeTaskIndexSyncer,
    taskAutoArchiveScheduler,
    zcodeSessionService,
    gitService,
    zcodeTaskService,
    botsRepo,
    botRemoteWorkspaceService,
    oauthService,
    offPeakCredentialResolverDeps,
    buildOffPeakRequestAuthForTicket,
    conversationShareService,
    sqliteReposToClose,
    marketingAssets,
  };
}
