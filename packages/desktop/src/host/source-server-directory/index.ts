import type { Event } from "@zcode/rpc";
import type { ConnectionProfile } from "@zcode/shared";
import type { UpdateConnectionProfileInput } from "@zcode/services";
import * as handshakeOperations from "./handshake.js";
import * as profileOperations from "./profiles.js";
import * as queryOperations from "./queries.js";
import { createSourceServerDirectoryRuntime } from "./runtime.js";
import * as sourceOperations from "./sources.js";
import type {
  NonServerRemoteTarget,
  SourceServerDirectoryContext,
  SourceServerDirectoryOptions,
  SourceServerDirectorySnapshot,
  SourceServerHandshakeRecord,
  SourceServerHandshakeResult,
  SourceServerReconnectCandidate,
} from "./types.js";
import * as workspaceOperations from "./workspaces.js";

export type {
  SourceServerDirectorySnapshot,
  SourceServerReconnectCandidate,
  SourceServerDirectoryOptions,
  SourceServerHandshakeRecord,
  SourceServerHandshakeResult,
} from "./types.js";

/**
 * Source/Profile/Workspace 三实体目录。
 *
 * 实现按职责拆分在 `source-server-directory/`：runtime 独占串行写队列、初始化 flight
 * 与变更事件，子模块只通过 context 读写。本类保留原有构造签名、公开方法与
 * 「initialize → enqueue → persist」顺序，外部调用方无需改动。
 */
export class SourceServerDirectory {
  private readonly context: SourceServerDirectoryContext;
  /** 目录持久化成功后的统一变更通知，管理服务负责将其映射为 generation。 */
  public readonly onDidChange: Event<void>;

  public constructor(options: SourceServerDirectoryOptions) {
    const runtime = createSourceServerDirectoryRuntime(options);
    this.context = runtime.context;
    this.onDidChange = runtime.onDidChange;
  }

  public async initialize(): Promise<void> {
    await this.context.initialize();
  }

  public async snapshot(): Promise<SourceServerDirectorySnapshot> {
    return await queryOperations.readSnapshot(this.context);
  }

  public async resolveLegacyWorkspaceIdentity(input: {
    profileId: string;
    workspacePath: string;
    fallback: string;
  }): Promise<string> {
    return await queryOperations.resolveLegacyWorkspaceIdentity(this.context, input);
  }

  public async ensureProfile(
    target: NonServerRemoteTarget,
    options: { deferCredentials?: boolean } = {},
  ): Promise<ConnectionProfile> {
    return await profileOperations.ensureProfile(this.context, target, options);
  }

  public async listStartupReconnectCandidates(): Promise<SourceServerReconnectCandidate[]> {
    return await queryOperations.listStartupReconnectCandidates(this.context);
  }

  public async recordLastOnline(sourceServerId: string, timestamp: number): Promise<void> {
    await handshakeOperations.recordLastOnline(this.context, sourceServerId, timestamp);
  }

  public async recordHandshake(
    profileId: string,
    handshake: SourceServerHandshakeRecord,
    options: { confirmIdentityChange?: boolean } = {},
  ): Promise<SourceServerHandshakeResult> {
    return await handshakeOperations.recordHandshake(this.context, profileId, handshake, options);
  }

  public async recordWorkspaceOpen(input: {
    profileId: string;
    sourceServerId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: "project" | "conversation";
    legacyWorkspaceIdentity?: string;
    openedAt?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    await workspaceOperations.recordWorkspaceOpen(this.context, input);
  }

  public async recordConversationWorkspace(
    sourceServerId: string,
    workspacePath: string,
  ): Promise<void> {
    await workspaceOperations.recordConversationWorkspace(
      this.context,
      sourceServerId,
      workspacePath,
    );
  }

  public async renameSource(sourceServerId: string, displayName: string): Promise<void> {
    await sourceOperations.renameSource(this.context, sourceServerId, displayName);
  }

  public async renameProfile(profileId: string, displayName: string): Promise<void> {
    await profileOperations.renameProfile(this.context, profileId, displayName);
  }

  public async updateProfile(input: UpdateConnectionProfileInput): Promise<void> {
    await profileOperations.updateProfile(this.context, input);
  }

  public async setPreferredProfile(sourceServerId: string, profileId: string): Promise<void> {
    await profileOperations.setPreferredProfile(this.context, sourceServerId, profileId);
  }

  public async resolveProfileTarget(
    profileOrId: string | ConnectionProfile,
  ): Promise<NonServerRemoteTarget> {
    return await profileOperations.resolveProfileTarget(this.context, profileOrId);
  }

  public async removeProfile(profileId: string): Promise<void> {
    await profileOperations.removeProfile(this.context, profileId);
  }

  public async removeSourceServer(sourceServerId: string): Promise<void> {
    await sourceOperations.removeSourceServer(this.context, sourceServerId);
  }

  public async markSourceUninstalled(profileId: string): Promise<void> {
    await sourceOperations.markSourceUninstalled(this.context, profileId);
  }
}
