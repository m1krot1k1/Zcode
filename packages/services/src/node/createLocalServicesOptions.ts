// Опции Node-входа services: единый контракт для всех фаз сборки Local Host.
import type { BotProjectConnection } from "#src/bot-project-runtime/index.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import type { IProjectService } from "#src/project/index.js";
import { type createRemoteProjectService } from "#src/remote-projects/index.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createBroadcastService } from "../broadcast/broadcastService.js";
import type { CreateFeedbackServiceOptions } from "../feedback/feedbackService.js";
import type { WorkspaceFileSearchFilter } from "../file/workspaceFileMentionFilter.js";
import type { HostApiNetworkTransport } from "../providers/api/nodeApiNetwork.js";
import type { ISettingService } from "../setting/setting.js";
import { createSettingServiceWithMigrations } from "../setting/settingService.js";
import type { ISourceServerWorkspaceService } from "../source-server-workspace/sourceServerWorkspace.js";
import type { CuaOperationStateReporter } from "../zcode-agent/cuaOperationTurnTracker.js";
import type { ZCodeAgentCommandResolver } from "../zcode-agent/zcodeAgentProcessManager.js";
import type { IChannel } from "@zcode/rpc";
import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  DynamicWorkflowMode,
  ProviderProvisioningTrigger,
  ServiceAuthorityMode,
  RemoteAgentNetworkOptions,
  ZCodeAutomation,
  ZCodeAutomationRun,
} from "@zcode/shared";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";

export interface CreateLocalServicesOptions {
  /** 已鉴权 Desktop stdio 连接提供的私有回查频道；不作为公共 service 暴露。 */
  topicResourceRelayChannel?: (request: unknown) => IChannel;
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Desktop Window Host 提供当前 Source 身份和线路，其他宿主不推断 Desktop 状态。 */
  resolveBotRemoteWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
  }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  /** 窗口级 Desktop Host 显式开启；standalone Source Server Host 自己拥有执行端 ACP 子进程。 */
  enableOpenCodeAcpRuntime?: boolean;
  /** Host 装配层注入的设置权威；与网络 transport 必须来自同一 Window Host 生命周期。 */
  settingService?: ISettingService;
  setWorkspaceProjection?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["setWorkspaceProjection"];
  /** 与注入的本地 Setting 共用写队列；外部远端 Setting 不传，由其权威 Host 完成迁移。 */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** 注入后由 ServiceCollection 接管释放，并供 Host 其它 app-managed 下载复用。 */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Desktop Host 注入 Main 推送的实时界面语言，供 ZCode endpoint 的 X-Client-Language；远端 server 不注入。 */
  resolveClientLanguage?: () => string | undefined;
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  /**
   * 动态工作流用户选择变化后的转发口（docs/dynamic-workflow/launch.md「The user's choice」）：
   * Desktop Host 把本机设置里的选择推给本窗口所有在线的 desktop-attached remote Host。
   */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  /** Desktop Host 请求 Main 登记已校验的插件 UI HTML，换取沙箱句柄。 */
  registerPluginSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  reportPluginTelemetryEvent?: (
    event: import("@zcode/shared").RendererTelemetryEventPayload,
  ) => void | Promise<void>;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** workspace 文件搜索默认使用内置过滤器；后续规则来源只需在 Host 装配时注入最终实现。 */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** desktop local host 在 manual run 落库后直接派发，不经过 scheduler 正常路径。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** 闲时任务翻 schedulable 后请求宿主立即唤醒 scheduler（desktop host 注入 parentPort 转发）。 */
  onOffPeakSchedulerWakeRequested?: () => void;
  // 注入点：默认 resolver 已能覆盖 dev/桌面/SSH 远端三类形态；
  // 测试或特殊宿主想强制走自定义 binary/参数时从这里注入。
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Desktop Main 提前异步采集的本机 runtime 环境；Local Host 注入后不再同步启动 login shell。 */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** 本地桌面上次 workspace 缺失时，仅用于 Agent 子进程 spawn.cwd 兜底。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** Host 下发给远端一次性 Agent 网络配置；来源可以是 stdio 入口的 env，也可以是 Source Server 读取的 handoff 文件。 */
  remoteAgentNetwork?: RemoteAgentNetworkOptions;
  /** 所属 Environment 的 ZCode Built-in Provider Config 物理路径。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server 只有在调用方明确配置认证时才暴露跨 Environment Provisioning target。 */
  providerProvisioningTargetEnabled?: boolean;
  /** Desktop Host 私有通知；只在 Source 成功持久化后请求 Main 调度远端镜像。 */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** 可信 Server Core 注入，区分物理持库 Host 与历史 workspace canonical route。 */
  projectStorageHostId?: string;
  sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  resolveProjectHostService?: (hostId: string) => Promise<IProjectService>;
  /** Bot 复用窗口已有 Source 连接；不经 main 创建 workspace attachment。 */
  resolveBotProjectConnection?: (hostId: string) => BotProjectConnection | undefined;
  remoteProjectConnection?: Pick<
    Parameters<typeof createRemoteProjectService>[0],
    "connectHost" | "readConnectionStates"
  >;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentTelemetry?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use 执行桥（host→main WebContentsView+CDP）；desktop host 注入，缺省则 browser 不可用。 */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** Windows desktop-local Host 的 CUA turn 状态投影；其它 authority 会在装配层拒绝。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
}
