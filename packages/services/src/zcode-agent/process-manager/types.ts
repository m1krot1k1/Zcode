/**
 * process-manager/types.ts: Контракты менеджера процессов агента — команда запуска,
 * параметры manager'а, состояние управляемого процесса и runtime identity.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RuntimeProcessLifecycleReporter } from "#src/process/runtimeProcessLifecycle.js";
import type { ZCodeAgentPresentationSurface } from "#src/zcode-agent/zcodeAgentPresentationSurface.js";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";

export interface ZCodeAgentCommand {
  /** 本地配套 CLI bundle 的存储专用 Worker 入口；远端/自定义命令不推断能力。 */
  storagePreparationEntry?: string;
  /** 本次部署的 Agent 支持迁移前的启动通知；旧自定义命令保持原协议。 */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ZCodeAgentCommandResolverContext {
  presentationSurface?: ZCodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export type ZCodeAgentCommandResolver = (
  context: ZCodeAgentCommandResolverContext,
) => Promise<ZCodeAgentCommand | null> | ZCodeAgentCommand | null;

export interface ZCodeAgentProcessManagerOptions {
  commandResolver?: ZCodeAgentCommandResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * 进程泳道标识。同一 workspace 的不同泳道各走独立 manager 实例；lane 会写入
   * runtimeIdentity 与 spawn/exit 日志，便于排障区分。
   * 缺省为 chat 主泳道，不追加任何标记。
   */
  lane?: string;
  /**
   * 空闲回收阈值：连接上没有请求在飞持续超过该时长，就主动回收整棵进程树，
   * 下次 getClient 透明重新拉起。只给 mcp-status 这类“按需探测、进程内挂着 MCP 子进程”
   * 的控制面 lane 使用；chat / plugin 缺省不回收。
   */
  idleTimeoutMs?: number;
  /**
   * 仅当默认进程 cwd 等于目标 workspace 且该目录不可用时使用。
   * 业务 workspacePath/workspaceKey 不随 cwd 兜底改变。
   */
  spawnFallbackCwd?: string;
  /**
   * 每次 spawn agent 子进程前解析的额外环境变量（在 process.env 之后、workspace 变量之前合入）。
   * 用于把设置页的代理等配置注入子进程；按 spawn 时读取，天然「下次启动生效」。
   *
   * context 携带本次 spawn 的 workspace 标识三元组（workspacePath/workspaceIdentity/workspaceKey）。
   * Helper lifecycle 不再回收或重启已有 Agent。
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * 可选的外部 spawn admission hook。CUA 默认装配不再注入 Helper recovery gate，
   * 避免 Helper lifecycle 阻塞或间接重启 Agent；保留该通用 hook 供其他产品策略使用。
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
}

export interface ManagedZCodeAgentProcess {
  client: ZCodeProtocolClient;
  child: ChildProcessWithoutNullStreams;
  cleanupPromise?: Promise<void>;
  exitDiagnosticsCompleted: Promise<void>;
  exited: boolean;
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

export type AgentProcessCleanupReason =
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "workspace-dispose"
  | "workspace-dispose-retry";

export interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

/**
 * （CLI 重连重订边界）：同一 workspace 的 agent 进程被重建（超时回收/崩溃后
 * 首个 getClient 重新拉起）。v4 订阅（sessions-index/workspace-config/conversation）
 * 都活在 CLI 进程内存里，进程换代即失效——订阅方收到本事件后必须重发 subscribe。
 */
export interface ZCodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
}

export interface ZCodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

export interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** 进程泳道标识；chat 主泳道缺省为空。 */
  lane?: string;
}

export interface ZCodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}
