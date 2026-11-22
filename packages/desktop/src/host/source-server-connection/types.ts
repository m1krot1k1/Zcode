import type { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  type CompatibilityManifest,
  type ConnectionProfile,
  type RemoteTarget,
  type ServerRemoteInfo,
  type SourceServerArtifactPolicy,
  type SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import type {
  ServerReleaseAsset,
  SourceServerTransportAdapter,
  TransportContext,
} from "@zcode/server/source-server";
import type {
  ServerRemoteConnection,
  ServerRemoteDuplexConnectionOptions,
} from "../serverRemoteConnection.js";
import type { SourceServerDirectory } from "../sourceServerDirectory.js";
import type { SourceServerOperationLogs } from "../sourceServerOperationLogs.js";

export interface ManagedSourceServerConnection {
  /** 本次调用复用物理连接时的实际脱敏目标；不写入在线 owner。 */
  reusedConnectionTarget?: RemoteTarget;
  sourceServerId: string;
  profileId: string;
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
}

export type SourceServerConnectionInvalidatedEvent =
  | {
      sourceServerId: string;
      reason: "update";
    }
  | {
      sourceServerId: string;
      reason: "profile-removed";
      recoverable: false;
    };

export class SourceServerInstallRequiredError extends Error {
  public readonly code = SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(public readonly profileId: string) {
    super("Source Server installation requires explicit user confirmation");
    this.name = "SourceServerInstallRequiredError";
  }
}

export class SourceServerUpgradeRequiredError extends Error {
  public readonly code = SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly upgradeTarget: "controller" | "server",
    public readonly currentVersion: string,
    public readonly minimumVersion: string,
    public readonly reason: "compatibility" | "development-archive" = "compatibility",
  ) {
    super(
      reason === "development-archive"
        ? `Source Server ${currentVersion} release archive differs from the current development build and must be updated`
        : upgradeTarget === "server"
          ? `Source Server ${currentVersion} must be upgraded to at least ${minimumVersion}`
          : `ZCode Desktop ${currentVersion} must be upgraded to at least ${minimumVersion}`,
    );
    this.name = "SourceServerUpgradeRequiredError";
  }
}

export class SourceServerIdentityChangePendingError extends Error {
  public readonly code = SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly pendingSourceServerId: string,
  ) {
    super("Source Server identity changed after reinstall and requires confirmation");
    this.name = "SourceServerIdentityChangePendingError";
  }
}

/** 显式断开/删除 profile 的取消信号；自动恢复回调据此结束而不排下一档重试。 */
export class SourceServerExplicitDisconnectError extends Error {
  public readonly code = "remote-connection-canceled";
  public constructor(public readonly sourceServerId: string) {
    super(`Source Server explicitly disconnected: ${sourceServerId}`);
    this.name = "SourceServerExplicitDisconnectError";
  }
}

export class SourceServerProfileRemovedError extends Error {
  public constructor(public readonly profileId: string) {
    super(`Connection Profile removed: ${profileId}`);
    this.name = "SourceServerProfileRemovedError";
  }
}

export class SourceServerHandshakeClosedError extends Error {
  public readonly retryable = true;
  public constructor(reason: string) {
    super(`Source Server connection closed during handshake: ${reason}`);
    this.name = "SourceServerHandshakeClosedError";
  }
}

export interface SourceServerConnectionManagerOptions {
  /** 成员关系归持久化端口；连接管理器只负责 admission 和握手提交的时序。 */
  admitConnection?: (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }) => Promise<(sourceServerId: string) => Promise<void>>;
  directory: {
    recordLastOnline?(sourceServerId: string, timestamp: number): Promise<void>;
    markSourceUninstalled?(profileId: string): Promise<void>;
    recordHandshake(
      profileId: string,
      handshake: Parameters<SourceServerDirectory["recordHandshake"]>[1],
      options?: Parameters<SourceServerDirectory["recordHandshake"]>[2],
    ): Promise<{
      identityChanged: boolean;
      effectiveProfile?: ConnectionProfile;
    }>;
  };
  createAdapter?: (kind: "ssh" | "wsl" | "docker") => SourceServerTransportAdapter;
  connectServer?: (options: ServerRemoteDuplexConnectionOptions) => Promise<ServerRemoteConnection>;
  now?: () => number;
  logWarn?: (message: string, error: Error) => void;
  onProjectChange?: (sourceServerId: string) => void;
  compatibilityManifest?: CompatibilityManifest;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
  resolveRelease?: (
    probe: Awaited<ReturnType<SourceServerTransportAdapter["probe"]>>,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options?: { metadataOnly?: boolean },
  ) => Promise<ServerReleaseAsset>;
}

export interface ConnectSourceServerOptions {
  membershipIntent?: "add" | "retain";
  profile: ConnectionProfile;
  target: RemoteTarget;
  release?: ServerReleaseAsset;
  allowInstall?: boolean;
  confirmIdentityChange?: boolean;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  context?: TransportContext;
  onDiagnosticPhase?: (phase: string) => void;
  /** 仅实际执行探测/握手的 flight 在升级等待点调用，join 请求不得提交另一份凭据。 */
  onAuthenticatedUpgradeRequired?: () => Promise<void>;
}

export interface UpdateServerOptions {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  force?: boolean;
  context?: TransportContext;
  release?: ServerReleaseAsset;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
}

export interface StartupReconnectResult {
  profileId: string;
  status: "online" | "failed";
  error?: string;
}

export interface OnlineConnection extends ManagedSourceServerConnection {
  connection: ServerRemoteConnection;
  profileIds: Set<string>;
  projectSubscription?: { dispose(): void };
}

export interface ReconnectInput {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  context: TransportContext;
}

export interface ConnectFlight {
  promise: Promise<ManagedSourceServerConnection>;
  sourceServerId?: string;
  controller: AbortController;
}

export interface UpdateFlight {
  profileId: string;
  sourceServerId?: string;
  controller: AbortController;
}

/** 版本兼容事实；恢复/离线/更新状态只继承它，不产生新事实。 */
export type CompatibilityStateFields = Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
>;

/**
 * 内部流程复用的公共入口引用。门面方法可能被实例级覆写（测试 spy、Host 包装），
 * 因此启动重连与 dispose 必须经由实例方法，而不是直连底层模块函数。
 */
export interface SourceServerManagerPorts {
  connect(options: ConnectSourceServerOptions): Promise<ManagedSourceServerConnection>;
  disconnect(sourceServerId: string): void;
}

/**
 * Manager 的唯一状态所有者。拆分后的模块通过显式传入的 context 读写同一组 map、
 * emitter 与 timer 表，避免各处闭包各自持有副本或另起写入路径。
 */
export interface ManagerContext {
  readonly options: SourceServerConnectionManagerOptions;
  readonly adapters: Map<string, SourceServerTransportAdapter>;
  readonly states: Map<string, SourceServerConnectionStateSnapshot>;
  readonly compatibilityByProfileId: Map<string, CompatibilityStateFields>;
  readonly onlineBySourceServerId: Map<string, OnlineConnection>;
  readonly connectFlights: Map<string, ConnectFlight>;
  readonly reconnectInputs: Map<string, ReconnectInput>;
  readonly profileIdsBySourceServerId: Map<string, Set<string>>;
  readonly retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly offlineProbeTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly updateFlights: Set<UpdateFlight>;
  readonly operationLogs: SourceServerOperationLogs;
  readonly now: () => number;
  readonly createAdapter: NonNullable<SourceServerConnectionManagerOptions["createAdapter"]>;
  readonly connectServer: NonNullable<SourceServerConnectionManagerOptions["connectServer"]>;
  readonly compatibilityManifest: CompatibilityManifest;
  readonly stateEmitter: Emitter<SourceServerConnectionStateSnapshot>;
  readonly reconnectEmitter: Emitter<ManagedSourceServerConnection>;
  readonly connectionInvalidatedEmitter: Emitter<SourceServerConnectionInvalidatedEvent>;
  readonly ports: SourceServerManagerPorts;
  readonly onUnexpectedClose: (
    ctx: ManagerContext,
    sourceServerId: string,
    reason: string,
    connection: ServerRemoteConnection,
  ) => void;
}
