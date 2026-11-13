import {
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
} from "@zcode/shared";

export interface SourceServerWorkspaceAliasRepoOptions {
  taskDbPath?: string;
  sessionDbPath?: string;
  backupRoot?: string;
  now?: () => number;
  migrationId?: () => string;
  afterPhaseCommitted?: (phase: WorkspaceMigrationPhase) => Promise<void> | void;
}

export const WORKSPACE_MIGRATION_PHASES = [
  "preflight",
  "backups-created",
  "task-db-merged",
  "session-db-merged",
  "config-dirs-merged",
  "alias-published",
  "completed",
] as const;

export type WorkspaceMigrationPhase = (typeof WORKSPACE_MIGRATION_PHASES)[number];

export function hasReachedMigrationPhase(
  current: WorkspaceMigrationPhase,
  target: WorkspaceMigrationPhase,
): boolean {
  return WORKSPACE_MIGRATION_PHASES.indexOf(current) >= WORKSPACE_MIGRATION_PHASES.indexOf(target);
}

export function parseMigrationPhase(value: string): WorkspaceMigrationPhase | null {
  return WORKSPACE_MIGRATION_PHASES.includes(value as WorkspaceMigrationPhase)
    ? (value as WorkspaceMigrationPhase)
    : null;
}

export interface ResolveCanonicalWorkspaceKeyInput {
  workspacePath: string;
  legacyRouteHint?: string;
}

export interface ResolveCanonicalWorkspaceKeyResult {
  canonicalKey: string;
  mergedKeys: string[];
  migrationId?: string;
}

/**
 * 迁移域共享上下文：路径、时钟与阶段回调由 Repo 在构造时冻结，
 * 领域函数全部显式接收，避免把 Repo 实例再传回来形成反向依赖。
 */
export interface SourceServerWorkspaceAliasContext {
  readonly taskDbPath: string;
  readonly sessionDbPath: string;
  readonly backupRoot: string;
  readonly now: () => number;
  readonly createMigrationId: () => string;
  readonly afterPhaseCommitted?: SourceServerWorkspaceAliasRepoOptions["afterPhaseCommitted"];
}

export class SourceServerWorkspaceIdentityConflictError extends Error {
  public readonly code = WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly conflicts: WorkspaceTaskIdentityConflict[] = [],
  ) {
    super(`Source Server workspace task identity conflict: ${workspacePath}`);
    this.name = "SourceServerWorkspaceIdentityConflictError";
  }
}

export class SourceServerWorkspaceConfigConflictError extends Error {
  public readonly code = WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly relativePath: string,
    public readonly sourceKey: string,
  ) {
    super(`Source Server workspace config conflict: ${workspacePath} (${relativePath})`);
    this.name = "SourceServerWorkspaceConfigConflictError";
  }
}

export class SourceServerWorkspaceMigrationPlanDivergedError extends Error {
  public readonly code = WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly newVariants: string[],
  ) {
    super(`Source Server workspace migration plan diverged: ${workspacePath}`);
    this.name = "SourceServerWorkspaceMigrationPlanDivergedError";
  }
}

export class SourceServerWorkspaceSessionGenerationChangedError extends Error {
  public readonly code = WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE;
  public readonly retryable = false;

  public constructor(workspacePath: string) {
    super(`Source Server workspace session database generation changed: ${workspacePath}`);
    this.name = "SourceServerWorkspaceSessionGenerationChangedError";
  }
}

export interface WorkspaceActivityRow {
  workspace_key: string;
  last_active_at: number;
}

export interface WorkspaceTaskIdentityConflict {
  taskId: string;
  sourceKey: string;
}

export type WorkspaceActivityDigestVersion = 1 | 2;

export interface WorkspaceActivityDigestBaseline {
  version: WorkspaceActivityDigestVersion;
  digests: Record<string, string>;
}

export type SessionConfigEntries = Map<
  string,
  { kind: "directory" } | { kind: "file"; content: Buffer }
>;

export const WORKSPACE_PATH_TABLES = [
  "tasks",
  "task_group_members",
  "automations",
  "off_peak_tasks",
] as const;

export interface ActiveWorkspaceMigration {
  migrationId: string;
  canonicalKey: string;
  variants: string[];
  phase: WorkspaceMigrationPhase;
  taskBackupPath: string;
  sessionBackupPath: string | null;
  sessionDatabaseGeneration: string | null;
}
