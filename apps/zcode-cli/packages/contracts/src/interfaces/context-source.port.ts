// ============================================================
// Context Source Port - host/workspace context boundary
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  nodeVersion: string;
  // 执行模型不是环境事实；只能由当前 model step 的 Model 在 Prompt 渲染时提供。
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: "clean" | "dirty" | "not_repo";
  gitStatusLines?: string[];
  recentCommits?: string[];
}

export interface UserInstructionsOptions {
  workingDirectory: string;
  projectRoot?: string;
  priorityFiles?: string[];
  maxBytes?: number;
  /** Explicit workspace-relative file targets; vague prompt text is never used for rule matching. */
  ruleTargetPaths?: readonly string[];
}

export interface ResolvedWorkspaceRule {
  filePath: string;
  fileName: string;
  description?: string;
  globs: string[];
  alwaysApply: boolean;
  appliedBy: "alwaysApply" | "glob";
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

/** Packaged, always-on guidance that accompanies every runtime context snapshot. */
export interface ResolvedHarnessRule {
  id: string;
  description?: string;
  content: string;
}

export type UserInstructionSourceScope = "user" | "workspace";

export interface ResolvedUserInstructionSource {
  scope: UserInstructionSourceScope;
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface ResolvedUserInstructions {
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  sources?: ResolvedUserInstructionSource[];
}

export type ProjectType = "node" | "python" | "rust" | "go" | "java" | "unknown";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/** Назначение script, выведенное из его имени и/или команды. */
export type WorkspaceScriptKind = "test" | "lint" | "typecheck" | "build" | "dev";

export interface WorkspaceScriptClassification {
  /** Имя script в package.json (не содержимое команды). */
  name: string;
  /** Команда после redaction секретоподобных частей. */
  command: string;
  kind: WorkspaceScriptKind;
  /** Какой признак дал классификацию: имя script или текст команды. */
  matchedBy: "name" | "command";
}

export interface WorkspaceMonorepoFacts {
  isMonorepo: boolean;
  /** Globs/пути из pnpm-workspace.yaml, package.json#workspaces или lerna.json. */
  workspaces?: string[];
}

export interface WorkspaceToolchainFacts {
  /** Версия Node, задекларированная в файлах проекта. */
  node?: string;
  /** Фактическая версия исполняющего Node (process.version). */
  nodeRuntime?: string;
  /** packageManager/engines из package.json (например pnpm@9.15.0). */
  packageManager?: string;
  /** Ограниченный набор tool-версий из mise.toml. */
  mise?: Record<string, string>;
  /** Другие декларации package manager из engines (npm/yarn/pnpm/bun). */
  engines?: Record<string, string>;
}

/**
 * Успешно выполненная команда с provenance. Поле зарезервировано: Work 3a не
 * создаёт execution path и не запускает команды, поэтому кеш пишет пустой массив
 * и verifiedCommandsStatus = "unavailable".
 */
export interface WorkspaceVerifiedCommand {
  command: string;
  /** Источник: файл и/или script/инструмент, породивший команду. */
  source: string;
  kind?: WorkspaceScriptKind;
  verifiedAt: string;
  exitCode?: number;
}

export interface WorkspaceFactsProvenance {
  computedAt: string;
  gitHead?: string;
  gitDirty?: boolean;
  /** Относительные пути входов и их SHA-256 (без содержимого). */
  inputs: Array<{ path: string; sha256?: string }>;
}

export interface WorkspaceFacts {
  classifiedScripts: Record<WorkspaceScriptKind, WorkspaceScriptClassification[]>;
  monorepo: WorkspaceMonorepoFacts;
  toolchain: WorkspaceToolchainFacts;
  verifiedCommands: WorkspaceVerifiedCommand[];
  verifiedCommandsStatus: "unavailable" | "recorded";
  provenance: WorkspaceFactsProvenance;
}

export interface ProjectContext {
  type: ProjectType;
  packageManager?: PackageManager;
  scripts?: Record<string, string>;
  buildFiles?: string[];
  /**
   * Обогащённый снимок workspace facts. При наличии фактов рендерится в промпт
   * как компактная untrusted-секция (`buildWorkspaceFactsSection`, см.
   * packages/core/src/context/builder.ts) и доступен runtime-потребителям через
   * ContextSourceSnapshot. Legacy projectContext без workspaceFacts в промпт не
   * рендерится (см. docs/specs/workspace-facts-cache.md §8).
   */
  workspaceFacts?: WorkspaceFacts;
}

export interface ContextSourceRequest {
  workingDirectory: string;
  /**
   * Identity workspace для изоляции производных данных (кеш workspace facts).
   * Для remote workspace содержит remote-сегмент; отсутствие означает local path fallback.
   */
  workspaceIdentity?: string;
  /** Исходное представление пути workspace (для local fallback ключа кеша). */
  workspacePath?: string;
  currentDate?: string;
  effectiveShellDisplayName?: string;
  envInfo?: EnvInfo;
  userInstructions?: UserInstructionsOptions;
  /** Explicit workspace-relative target paths used to select file-scoped workspace rules. */
  ruleTargetPaths?: readonly string[];
  projectContext?: ProjectContext;
  trace?: TraceContext;
}

export interface ContextSourceDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface ContextSourceSnapshot {
  workingDirectory: string;
  envInfo: EnvInfo;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  bundledHarnessRules?: ResolvedHarnessRule[];
  workspaceRules?: ResolvedWorkspaceRule[];
  projectContext?: ProjectContext;
  diagnostics: ContextSourceDiagnostic[];
}

export interface ContextSourceResolveOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface ContextSourcePort {
  resolveContextSources(
    request: ContextSourceRequest,
    options?: ContextSourceResolveOptions,
  ): Promise<ContextSourceSnapshot>;
}
