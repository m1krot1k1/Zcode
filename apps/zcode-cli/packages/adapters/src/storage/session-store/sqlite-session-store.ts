import type { MigrationResult } from "@zcode/shared/sqlite-migrations";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";
import { DatabaseSync } from "node:sqlite";
import type {
  CollaborationMode,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionTaskLinkInput,
  CreateSessionInput,
  FileDiff,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  GoalStatus,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  ListSessionsInput,
  AppUsageQueryInput,
  AppUsageQueryResult,
  LocalSettingStorePort,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  ModelUsageRecord,
  OpenCodeAgentRunAdmission,
  OpenCodeAgentRunHostEventTransition,
  OpenCodeAgentRunRecord,
  OpenCodeAgentRunStatus,
  OpenCodeAgentRunTransition,
  SwarmNodeAttemptRecord,
  SwarmNodeAttemptReservation,
  SwarmNodeAttemptTransition,
  SwarmRunAdmission,
  SwarmRunGraphCommit,
  SwarmRunOwnerClaim,
  SwarmRunRecord,
  SwarmRunStatus,
  SwarmRunTransition,
  PartId,
  PermissionRuleset,
  ProjectId,
  SessionEntryInfo,
  SessionEntryType,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
  SessionGoal,
  SessionId,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionTaskLinkRecord,
  SessionRevert,
  SessionStorePort,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  TodoItem,
  ToolUsageRecord,
  TurnUsageRecord,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowActivityInput,
  UpdateSessionInput,
  UpdateScriptWorkflowRunInput,
  UsageStorePort,
} from "@zcode/contracts";
// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import {
  accountSessionTargetUsage,
  clearSessionTarget,
  cloneSessionTargetForFork,
  createSessionTarget,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  readSessionTarget,
  recoverInterruptedSessionTargetRun,
  setSessionTarget,
  startSessionTargetRun,
  updateSessionTargetSummaryTitle,
  updateSessionTargetStatus,
} from "../session-target.js";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrationsAsync,
  type AsyncSqliteMigrationOptions,
} from "./migration-runner.js";
import type {
  ForkCommitFaultStage,
  SessionStoreDebugCounts,
  SqliteSessionStoreOptions,
} from "./options.js";
import { getDefaultSessionDbPath } from "./paths.js";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import * as debugRepository from "./repositories/debug.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import * as inputHistoryRepository from "./repositories/input-history.js";
import * as localSettingsRepository from "./repositories/local-settings.js";
import * as messageRepository from "./repositories/messages.js";
import * as scriptWorkflowActivityRepository from "./repositories/script-workflow-activities.js";
import * as scriptWorkflowRunRepository from "./repositories/script-workflow-runs.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import {
  commitForkBundle,
  commitSharedContextImportBundle,
  createForkedSessionWithMetadata,
  transitionSharedContextImport,
} from "./sqlite-session-store-fork.js";
import * as todoRepository from "./repositories/todos.js";
import * as usageRepository from "./repositories/usage.js";

export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;
  private dwfJournalStore?: JournalStorePort;

  private constructor(
    db: DatabaseSync,
    dbPath: string,
    options: SqliteSessionStoreOptions,
    readonly migrationResult: MigrationResult,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.forkCommitFaultAt = options.forkCommitFaultAt;
  }

  static async open(
    options: SqliteSessionStoreOptions = {},
    migrationOptions?: AsyncSqliteMigrationOptions,
  ): Promise<SqliteSessionStore> {
    const dbPath = options.dbPath ?? getDefaultSessionDbPath();
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    let db: DatabaseSync;
    try {
      if (dbPath !== ":memory:") {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(dbPath) });
        await mkdir(dirname(dbPath), { recursive: true });
      }
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: dbPath });
      db = new DatabaseSync(dbPath, { timeout: startupLockTimeoutMs });
    } catch (error) {
      throw new SqliteSessionMigrationError(`Failed to open SQLite session database at ${dbPath}`, {
        cause: error,
        dbPath,
        kind: "open_failed",
      });
    }
    try {
      const migration = await runSqliteSessionMigrationsAsync(
        db,
        dbPath,
        migrationOptions ?? { lockWaitTimeoutMs: startupLockTimeoutMs },
      );
      return new SqliteSessionStore(db, dbPath, options, migration);
    } catch (error) {
      try {
        db.close();
      } catch {
        /* 关闭失败不能覆盖迁移错误。 */
      }
      throw error;
    }
  }

  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ) {
    return SqliteSessionStore.open(options, migrationOptions);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.createSession(this.db, input);
  }

  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return createForkedSessionWithMetadata(this.db, input, metadata);
  }

  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return commitForkBundle(this.db, bundle, (stage) => this.maybeThrowForkCommitFault(stage));
  }

  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return commitSharedContextImportBundle(this.db, bundle);
  }

  async transitionSharedContextImport(
    input: SharedContextImportTransition,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return transitionSharedContextImport(this.db, input);
  }


  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.updateSession(this.db, input);
  }

  async softDeleteSession(sessionID: SessionId, timeDeleted = Date.now()): Promise<void> {
    this.throwBeforeWrite();
    sessionRepository.softDeleteSession(this.db, sessionID, timeDeleted);
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return sessionRepository.getSession(this.db, sessionID);
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return sessionRepository.listSessions(this.db, input);
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return sessionRepository.claimLegacySessionWorkspace(this.db, input);
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairRemoteSessionPaths(this.db, input);
  }

  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.saveMessage(this.db, input, copyFrom);
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removeMessage(this.db, input);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.savePart(this.db, input, copyFrom);
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removePart(this.db, input);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return messageRepository.messageWithParts(this.db, input);
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return messageRepository.messages(this.db, input);
  }

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    return sessionEntryRepository.saveSessionEntry(this.db, input);
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
    idPrefix?: string;
    limit?: number;
    order?: "asc" | "desc";
    maxDataBytes?: number;
  }): Promise<SessionEntryInfo[]> {
    return sessionEntryRepository.sessionEntries(this.db, input);
  }

  // ── session_input 账本──

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  }

  async admitOpenCodeAgentRun(
    input: OpenCodeAgentRunAdmission,
  ): Promise<{ input: SessionInputRecord; run: OpenCodeAgentRunRecord; created: boolean }> {
    this.throwBeforeWrite();
    return sessionInputRepository.admitOpenCodeAgentRun(this.db, input);
  }

  async transitionOpenCodeAgentRun(input: OpenCodeAgentRunTransition): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionInputRepository.transitionOpenCodeAgentRun(this.db, input);
  }

  async applyOpenCodeAgentRunHostEvent(
    input: OpenCodeAgentRunHostEventTransition,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionInputRepository.applyOpenCodeAgentRunHostEvent(this.db, input);
  }

  async getOpenCodeAgentRun(input: {
    sessionID: SessionId;
    runID: string;
  }): Promise<OpenCodeAgentRunRecord | null> {
    return sessionInputRepository.getOpenCodeAgentRun(this.db, input);
  }

  async listOpenCodeAgentRuns(input: {
    sessionID: SessionId;
    statuses?: OpenCodeAgentRunStatus[];
    limit?: number;
  }): Promise<OpenCodeAgentRunRecord[]> {
    return sessionInputRepository.listOpenCodeAgentRuns(this.db, input);
  }

  async listPendingOpenCodeAgentRuns(input?: {
    limit?: number;
  }): Promise<OpenCodeAgentRunRecord[]> {
    return sessionInputRepository.listPendingOpenCodeAgentRuns(this.db, input);
  }

  async recoverOpenCodeAgentRuns(input?: {
    now?: number;
    diagnosticCode?: string;
  }): Promise<OpenCodeAgentRunRecord[]> {
    this.throwBeforeWrite();
    return sessionInputRepository.recoverOpenCodeAgentRuns(this.db, input);
  }

  async admitSwarmRun(input: SwarmRunAdmission): Promise<{ run: SwarmRunRecord; created: boolean }> {
    this.throwBeforeWrite();
    return sessionInputRepository.admitSwarmRun(this.db, input);
  }

  async getSwarmRun(input: {
    rootSessionID: SessionId;
    runID: string;
  }): Promise<SwarmRunRecord | null> {
    return sessionInputRepository.getSwarmRun(this.db, input);
  }

  async findSwarmRunBySourceCommand(input: {
    rootSessionID: SessionId;
    sourceCommandID: string;
  }): Promise<SwarmRunRecord | null> {
    return sessionInputRepository.findSwarmRunBySourceCommand(this.db, input);
  }

  async listSwarmRuns(input: {
    rootSessionID: SessionId;
    statuses?: SwarmRunStatus[];
    limit?: number;
  }): Promise<SwarmRunRecord[]> {
    return sessionInputRepository.listSwarmRuns(this.db, input);
  }

  async commitSwarmRunGraph(input: SwarmRunGraphCommit): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionInputRepository.commitSwarmRunGraph(this.db, input);
  }

  async transitionSwarmRun(input: SwarmRunTransition): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionInputRepository.transitionSwarmRun(this.db, input);
  }

  async claimSwarmRunOwner(input: SwarmRunOwnerClaim): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionInputRepository.claimSwarmRunOwner(this.db, input);
  }

  async reserveSwarmNodeAttempt(input: SwarmNodeAttemptReservation): Promise<{
    attempt: SwarmNodeAttemptRecord;
    created: boolean;
  }> {
    this.throwBeforeWrite();
    return sessionInputRepository.reserveSwarmNodeAttempt(this.db, input);
  }

  async transitionSwarmNodeAttempt(input: SwarmNodeAttemptTransition): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionInputRepository.transitionSwarmNodeAttempt(this.db, input);
  }

  async listSwarmNodeAttempts(input: { runID: string }): Promise<SwarmNodeAttemptRecord[]> {
    return sessionInputRepository.listSwarmNodeAttempts(this.db, input);
  }

  async listRecoverableSwarmRuns(input?: { limit?: number }): Promise<SwarmRunRecord[]> {
    return sessionInputRepository.listRecoverableSwarmRuns(this.db, input);
  }

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return todoRepository.readTodos(this.db, input);
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    return todoRepository.updateTodos(this.db, input);
  }

  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return readSessionTarget(this.db, input);
  }

  async setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal> {
    return setSessionTarget(this.db, {
      objective: input.objective,
      sessionID: input.sessionID,
      status: input.status ?? "active",
      tokenBudget: input.tokenBudget,
    });
  }

  async cloneTargetForFork(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal> {
    this.throwBeforeWrite();
    return cloneSessionTargetForFork(this.db, {
      source: input.source,
      sessionID: input.sessionID,
      status: input.status ?? input.source.status,
    });
  }

  async createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null> {
    return createSessionTarget(this.db, input);
  }

  async updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetStatus(this.db, input);
  }

  async startTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null> {
    return startSessionTargetRun(this.db, input);
  }

  async heartbeatTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null> {
    return heartbeatSessionTargetRun(this.db, input);
  }

  async finishTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null> {
    return finishSessionTargetRun(this.db, input);
  }

  async recoverInterruptedTargetRun(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return recoverInterruptedSessionTargetRun(this.db, input);
  }

  async accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null> {
    return accountSessionTargetUsage(this.db, input);
  }

  async updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetSummaryTitle(this.db, input);
  }

  async clearTarget(input: { sessionID: SessionId }): Promise<boolean> {
    return clearSessionTarget(this.db, input);
  }

  async recordModelUsage(input: ModelUsageRecord): Promise<void> {
    return usageRepository.recordModelUsage(this.db, input);
  }

  async upsertTurnUsage(input: TurnUsageRecord): Promise<void> {
    return usageRepository.upsertTurnUsage(this.db, input);
  }

  async upsertToolUsage(input: ToolUsageRecord): Promise<void> {
    return usageRepository.upsertToolUsage(this.db, input);
  }

  async pruneUsage(input?: { beforeTime?: number }): Promise<void> {
    return usageRepository.pruneUsage(this.db, input);
  }

  async queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult> {
    return usageRepository.queryAppUsage(this.db, input);
  }

  async queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult> {
    return usageRepository.queryTaskUsage(this.db, input);
  }

  async recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recordInputHistory(this.db, input);
  }

  async recallPreviousInputHistory(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recallPreviousInputHistory(this.db, input);
  }

  async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
    return localSettingsRepository.getProjectPermission(this.db, projectID);
  }

  async saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset> {
    return localSettingsRepository.saveProjectPermission(this.db, input);
  }

  getProjectPermissionMode(projectID: ProjectId): CollaborationMode | null {
    return localSettingsRepository.getProjectPermissionMode(this.db, projectID);
  }

  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode {
    return localSettingsRepository.saveProjectPermissionMode(this.db, input);
  }

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    return sessionRepository.setRevert(this.db, input);
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    return sessionRepository.clearRevert(this.db, sessionID);
  }

  async upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord> {
    return scriptWorkflowRunRepository.upsertScriptWorkflowDefinition(this.db, input);
  }

  async createScriptWorkflowRun(
    input: CreateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.createScriptWorkflowRun(this.db, input);
  }

  async updateScriptWorkflowRun(
    input: UpdateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.updateScriptWorkflowRun(this.db, input);
  }

  async getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null> {
    return scriptWorkflowRunRepository.getScriptWorkflowRun(this.db, runId);
  }

  async listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]> {
    return scriptWorkflowRunRepository.listScriptWorkflowRuns(this.db, input);
  }

  async createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.createScriptWorkflowActivity(this.db, input);
  }

  async updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.updateScriptWorkflowActivity(this.db, input);
  }

  async findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null> {
    return scriptWorkflowActivityRepository.findCachedScriptWorkflowActivity(this.db, input);
  }

  async listScriptWorkflowActivities(input: {
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowActivities(this.db, input);
  }

  async appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord> {
    return scriptWorkflowActivityRepository.appendScriptWorkflowEvent(this.db, input);
  }

  async listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowEvents(this.db, input);
  }

  async createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord> {
    return scriptWorkflowActivityRepository.createSessionTaskLink(this.db, input);
  }

  /**
   * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
   * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
   */
  workflowJournalStore(): JournalStorePort {
    this.dwfJournalStore ??= createDwfJournalStore(this.db);
    return this.dwfJournalStore;
  }

  debugMigrationIds(): string[] {
    return debugRepository.debugMigrationIds(this.db);
  }

  debugCounts(sessionID?: SessionId): SessionStoreDebugCounts {
    return debugRepository.debugCounts(this.db, sessionID);
  }
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open(options);
}

export { getDefaultSessionDbPath };
