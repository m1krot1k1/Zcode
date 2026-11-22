import type {
  AppSettings,
  ConnectionProfile,
  DockerProfileTarget,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SourceServerDeclaredWorkspaceWire,
  SourceServerRecord,
  SourceServerWorkspaceHistoryEntry,
  SSHProfileTarget,
  WSLProfileTarget,
} from "@zcode/shared";
import type { ICredentialService, ISettingService } from "@zcode/services";
import type { ControllerRemoteIdentityMigrationReport } from "@zcode/services/node";

/** Source Directory 可操作的远端目标：设备级 server 记录由 Directory 自己维护，不走连接目标。 */
export type NonServerRemoteTarget = Exclude<RemoteTarget, { kind: "server" }>;

/** 线路 Profile 的目标；三种传输方式共享同一套身份与凭据规则。 */
export type SourceServerProfileTarget = SSHProfileTarget | WSLProfileTarget | DockerProfileTarget;

export interface SourceServerDirectoryOptions {
  settingService: ISettingService;
  credentialService: ICredentialService;
  createProfileId?: () => string;
  now?: () => number;
  migrateControllerIdentity?: (input: {
    oldWorkspaceKey: string;
    newWorkspaceKey: string;
  }) => Promise<ControllerRemoteIdentityMigrationReport>;
  /** 远端 identity 被 canonical 覆盖等非错误诊断信息；生产环境应注入 no-op。 */
  logDebug?: (message: string) => void;
}

export interface SourceServerHandshakeRecord {
  sourceServerId: string;
  osUser?: string;
  hostname?: string;
  version: string;
  connectedAt?: number;
  workspaces?: readonly SourceServerDeclaredWorkspaceWire[];
}

export interface SourceServerHandshakeResult {
  identityChanged: boolean;
  migrationFailures: string[];
  effectiveProfileId: string;
  effectiveProfile: ConnectionProfile;
}

export interface SourceServerDirectorySnapshot {
  profiles: ConnectionProfile[];
  servers: SourceServerRecord[];
  workspaceHistory: SourceServerWorkspaceHistoryEntry[];
}

export interface SourceServerReconnectCandidate {
  profile: ConnectionProfile;
  target: NonServerRemoteTarget;
}

export type LegacySourceWorkspaceEntry = RemoteWorkspaceSessionEntry & {
  target: Exclude<RemoteWorkspaceSessionEntry["target"], { kind: "server" }>;
};

/**
 * 拆分子模块共享的运行上下文。
 *
 * 串行队列、持久化标记与初始化 flight 仍由单一 runtime 持有；子模块只消费该接口，
 * 因此所有入口保持原有的「initialize → enqueue → persist」顺序与变更事件语义。
 */
export interface SourceServerDirectoryContext {
  readonly options: SourceServerDirectoryOptions;
  readonly createProfileId: () => string;
  readonly now: () => number;
  readonly migrateControllerIdentity: (input: {
    oldWorkspaceKey: string;
    newWorkspaceKey: string;
  }) => Promise<ControllerRemoteIdentityMigrationReport>;
  initialize(): Promise<void>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  /** 目录持久化写入的唯一入口：写入成功即标记本次 enqueue 操作需要发布变更事件。 */
  persistSettings(patch: Partial<AppSettings>): Promise<void>;
}
