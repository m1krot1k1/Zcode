import { Emitter, type Event } from "@zcode/rpc";
import {
  ZCODE_COMPATIBILITY_MANIFEST,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerConnectionStateSnapshot,
  type SourceServerOperationLog,
} from "@zcode/shared";
import {
  createSourceServerTransportAdapter,
  type SourceServerFileTransfer,
} from "@zcode/server/source-server";
import { connectServerRemoteOverDuplex } from "../serverRemoteConnection.js";
import { SourceServerOperationLogs } from "../sourceServerOperationLogs.js";
import { getFileTransfer, getOnlineConnection } from "./access.js";
import { connect } from "./connect.js";
import { disconnect, dispose, removeProfile } from "./lifecycle.js";
import { handleUnexpectedClose, reconnectOnStartup } from "./recovery.js";
import { getStateByProfile, listStates } from "./state.js";
import { updateServer } from "./update.js";
import type {
  ConnectSourceServerOptions,
  ManagedSourceServerConnection,
  ManagerContext,
  SourceServerConnectionInvalidatedEvent,
  SourceServerConnectionManagerOptions,
  StartupReconnectResult,
  UpdateServerOptions,
} from "./types.js";

/**
 * Source 连接管理器门面。状态、timer 与 emitter 的唯一所有者是 `ManagerContext`，
 * 各职责模块通过显式 context 协作；这里只保留原有公共 API 与调用顺序。
 */
export class SourceServerConnectionManager {
  public readonly onDidChangeState: Event<SourceServerConnectionStateSnapshot>;
  public readonly onDidReconnect: Event<ManagedSourceServerConnection>;
  public readonly onDidInvalidateConnection: Event<SourceServerConnectionInvalidatedEvent>;
  public readonly onDidAppendOperationLog: Event<SourceServerOperationLog>;
  private readonly context: ManagerContext;

  public constructor(options: SourceServerConnectionManagerOptions) {
    const now = options.now ?? Date.now;
    const operationLogs = new SourceServerOperationLogs(() => now());
    const stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
    const reconnectEmitter = new Emitter<ManagedSourceServerConnection>();
    const connectionInvalidatedEmitter = new Emitter<SourceServerConnectionInvalidatedEvent>();
    this.context = {
      options,
      adapters: new Map(),
      states: new Map(),
      compatibilityByProfileId: new Map(),
      onlineBySourceServerId: new Map(),
      connectFlights: new Map(),
      reconnectInputs: new Map(),
      profileIdsBySourceServerId: new Map(),
      retryTimers: new Map(),
      offlineProbeTimers: new Map(),
      updateFlights: new Set(),
      operationLogs,
      now,
      createAdapter: options.createAdapter ?? ((kind) => createSourceServerTransportAdapter(kind)),
      connectServer: options.connectServer ?? connectServerRemoteOverDuplex,
      compatibilityManifest: options.compatibilityManifest ?? ZCODE_COMPATIBILITY_MANIFEST,
      stateEmitter,
      reconnectEmitter,
      connectionInvalidatedEmitter,
      ports: {
        connect: (options) => this.connect(options),
        disconnect: (sourceServerId) => this.disconnect(sourceServerId),
      },
      onUnexpectedClose: handleUnexpectedClose,
    };
    this.onDidChangeState = stateEmitter.event;
    this.onDidReconnect = reconnectEmitter.event;
    this.onDidInvalidateConnection = connectionInvalidatedEmitter.event;
    this.onDidAppendOperationLog = operationLogs.onDidAppend;
  }

  public getRecentOperationLogs(profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">) {
    return this.context.operationLogs.read(profile);
  }

  public async connect(
    options: ConnectSourceServerOptions,
  ): Promise<ManagedSourceServerConnection> {
    return await connect(this.context, options);
  }

  public getStateByProfile(profileId: string): SourceServerConnectionStateSnapshot {
    return getStateByProfile(this.context, profileId);
  }

  public listStates(): SourceServerConnectionStateSnapshot[] {
    return listStates(this.context);
  }

  public async reconnectOnStartup(
    candidates: Array<{
      profile: ConnectionProfile;
      target: Exclude<RemoteTarget, { kind: "server" }>;
    }>,
    options: { maxConcurrency?: number; timeoutMs?: number } = {},
  ): Promise<StartupReconnectResult[]> {
    return reconnectOnStartup(this.context, candidates, options);
  }

  public getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined {
    return getOnlineConnection(this.context, sourceServerId);
  }

  public getFileTransfer(sourceServerId: string): SourceServerFileTransfer {
    return getFileTransfer(this.context, sourceServerId);
  }

  public async updateServer(options: UpdateServerOptions): Promise<ManagedSourceServerConnection> {
    return updateServer(this.context, options);
  }

  public disconnect(sourceServerId: string): void {
    disconnect(this.context, sourceServerId);
  }

  public removeProfile(profileId: string): void {
    removeProfile(this.context, profileId);
  }

  public dispose(): void {
    dispose(this.context);
  }
}
