// ============================================================
// Tool Path Policy
// ============================================================

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { platform as currentPlatform } from "node:process";
import { CoreErrorType, createCoreError, type WorkspaceBoundaryMode } from "@zcode/contracts";
import {
  getToolPathApi,
  normalizeToolPathForComparison,
  type ToolPathPlatform,
} from "./path-normalization.js";

/**
 * workspace 边界模式（docs/specs/2026-11-11-workspace-boundary.md）。
 *
 * - `strict`：越界直接拒绝；
 * - `ask`：越界交给注入的审批端口，端口缺席时 fail closed（`permission_escalation`）；
 * - `allow`：越界放行，可选的审计回调记录访问。
 *
 * 未配置时保持兼容默认 `allow`，且在没有审计回调时完全跳过文件系统探测。
 * 类型定义在 `@zcode/contracts`（配置层是唯一来源），这里只做 re-export 保持既有导入路径。
 */
export type { WorkspaceBoundaryMode };

export type ToolPathOperation = "read" | "write" | "execute";

/**
 * 越界分类。`lexical` 是纯词法（`..`/外部绝对路径），`symlink` 是 realpath 后证明落在
 * workspace 之外；`dangling_symlink` 与 `unresolvable` 无法证明落点，按 fail closed 处理。
 */
export type WorkspaceBoundaryEscapeKind =
  | "lexical"
  | "symlink"
  | "dangling_symlink"
  | "unresolvable";

export interface WorkspaceBoundaryApprovalRequest {
  operation: ToolPathOperation;
  /** 模型原始输入。 */
  requestedPath: string;
  /** 词法解析后的路径（工具实际使用的那一个）。 */
  resolvedPath: string;
  workspaceRoot: string;
  physicalPath?: string;
  physicalWorkspaceRoot?: string;
  escapeKind: WorkspaceBoundaryEscapeKind;
  /** 确认窗可直接展示的一行 path preview。 */
  summary: string;
}

/**
 * ask 模式的审批端口。
 *
 * 必须是同步的：调用方先在既有 permission broker / 确认窗里取得用户决定，再把结果交给本端口。
 * path-policy 自己不弹窗、不等待、不用超时兜底。
 */
export interface WorkspaceBoundaryApprovalPort {
  decide(request: WorkspaceBoundaryApprovalRequest): {
    decision: "allow" | "deny";
    reason?: string;
  };
}

/** 工具声明的「本次调用会解析的模型路径」，只用于 ask 模式的事先审批。 */
export interface WorkspaceBoundaryPathRequest {
  path: string;
  operation: ToolPathOperation;
}

/** 越界探测结果：字段与审计/审批请求一一对应，判定只有一个实现。 */
interface WorkspaceBoundaryEscapeDetails {
  operation: ToolPathOperation;
  requestedPath: string;
  resolvedPath: string;
  workspaceRoot: string;
  physicalPath?: string;
  physicalWorkspaceRoot?: string;
  escapeKind: WorkspaceBoundaryEscapeKind;
}

export interface WorkspaceBoundaryAuditEvent {
  event: "workspace_boundary.escape";
  action: "allow" | "approve" | "deny";
  mode: WorkspaceBoundaryMode;
  /** 模式来自显式配置（true）还是兼容默认（false）。 */
  configured: boolean;
  operation: ToolPathOperation;
  requestedPath: string;
  resolvedPath: string;
  workspaceRoot: string;
  physicalPath?: string;
  physicalWorkspaceRoot?: string;
  escapeKind: WorkspaceBoundaryEscapeKind;
  platform: NodeJS.Platform;
  reason?: string;
}

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: ToolPathOperation;
  /** 见 {@link WorkspaceBoundaryMode}；缺省为兼容默认 `allow`。 */
  workspaceBoundary?: WorkspaceBoundaryMode;
  /** 仅 `ask` 模式使用；缺席时越界以 `permission_escalation` fail closed。 */
  workspaceBoundaryApproval?: WorkspaceBoundaryApprovalPort;
  /** 越界访问审计（allow / approve / deny）。回调抛错不影响判定结果。 */
  auditWorkspaceBoundary?: (event: WorkspaceBoundaryAuditEvent) => void;
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(options.workingDirectory, "workingDirectory");
  const workspaceRoot = normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  // 根因：旧实现有意放行 workspace 之外的路径（见 R03），symlink 也就一并穿透。
  // 边界判定集中在这一个函数里，handler 继续只依赖 resolveWorkspacePath。
  applyWorkspaceBoundary(options, workspaceRoot, resolvedPath);
  return resolvedPath;
}

export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  // 没有显式 cwd 时，默认 cwd 同样要经过边界判定：否则 strict/ask 会留下
  // “cwd 由调用方注入即可绕过”的缺口。allow 默认下返回值与旧实现完全一致。
  // 先保留旧实现的配置校验语义（相对/空 workingDirectory 仍是 ConfigurationError）。
  const workingDirectory = normalizeAbsoluteDirectory(options.workingDirectory, "workingDirectory");
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const hasExplicitCwd = inputCwd !== undefined && inputCwd.length > 0;
  return resolveWorkspacePath({
    ...options,
    inputPath: hasExplicitCwd ? inputCwd : workingDirectory,
  });
}

const BASH_PATH_TOKEN_PATTERN = /^(?:~(?:\/|$)|\/|\.\.?\/)/u;
const BASH_COMMAND_SEPARATORS = /[;&|()<>\s]+/u;

/**
 * Пути в команде Bash, которые лексически указывают за пределы workspace.
 *
 * Причина: граница применялась только к начальному cwd, а `cat ../secret` её обходил.
 * Здесь намеренно нет полноценного shell-парсера: проверяются только явные path-токены
 * без подстановок (`$`, `*`, `{`), чтобы не блокировать легитимные команды эвристикой.
 */
export function findBashPathsOutsideWorkspace(options: {
  command: string;
  workingDirectory: string;
  workspaceRoot: string;
  platform?: ToolPathPlatform;
}): string[] {
  const workspaceRoot = normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  const outside: string[] = [];
  for (const rawToken of options.command.split(BASH_COMMAND_SEPARATORS)) {
    const token = rawToken.replace(/^["']|["']$/gu, "").trim();
    if (token.length === 0) continue;
    if (token.includes("$") || token.includes("*") || token.includes("{")) continue;
    if (token.includes("://") || token === "-") continue;
    // `FOO=/abs/path` и `--flag=/abs/path`: значение после `=` тоже путь.
    const candidate = token.includes("=") ? (token.split("=").pop() ?? "") : token;
    // Флаг без значения (`--force`) не путь; флаг со значением уже разобран выше.
    if (candidate === token && token.startsWith("--")) continue;
    if (candidate.length === 0) continue;
    // Одиночный флаг вида `-n` не путь; `-o=/tmp/x` уже разобран выше.
    if (candidate.startsWith("-") && !BASH_PATH_TOKEN_PATTERN.test(candidate)) continue;
    const looksLikePath =
      BASH_PATH_TOKEN_PATTERN.test(candidate) ||
      candidate.includes("/../") ||
      candidate.endsWith("/..");
    if (!looksLikePath) continue;
    const absolute = candidate.startsWith("~")
      ? resolve(homedir(), candidate.slice(1).replace(/^[/\\]+/u, ""))
      : isAbsolute(candidate)
        ? normalize(candidate)
        : resolve(workingDirectory, candidate);
    if (!isPathWithinWorkspaceRoot(absolute, workspaceRoot, options.platform)) {
      outside.push(candidate);
    }
  }
  return [...new Set(outside)];
}

/**
 * Fail-closed проверка Bash-команды для strict/ask.
 *
 * `ask` не получает интерактивного согласования по путям внутри произвольной команды:
 * порт подтверждения работает по конкретным (operation, resolvedPath), которых здесь
 * может быть много и они не видны пользователю до разбора shell. Поэтому `ask` отклоняет
 * команду с подсказкой сузить её или выполнить файловый инструмент.
 */
export function assertBashCommandPathBoundary(options: {
  command: string;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceBoundary: WorkspaceBoundaryMode | undefined;
  platform?: ToolPathPlatform;
}): void {
  if (options.workspaceBoundary === undefined || options.workspaceBoundary === "allow") return;
  const outside = findBashPathsOutsideWorkspace(options);
  if (outside.length === 0) return;
  const type =
    options.workspaceBoundary === "ask"
      ? CoreErrorType.PermissionEscalation
      : CoreErrorType.PermissionDenied;
  throw createCoreError(
    type,
    `Bash command references paths outside the workspace: ${outside.join(", ")}`,
    {
      context: {
        code: "workspace_boundary_bash_path",
        workspaceBoundary: options.workspaceBoundary,
        paths: outside,
        workspaceRoot: options.workspaceRoot,
      },
      recoverable: true,
      retryable: false,
    },
  );
}

/**
 * Проверка объявленного write-scope (поле `write_paths` инструмента Agent/Task).
 *
 * Причина: scope был только подсказкой для work-ledger; фактическая запись ничем не
 * ограничивалась, и параллельные ветки могли писать в один файл. Явный массив
 * (`[]` включительно) — авторитетная граница, отсутствие поля — прежнее поведение.
 */
export function assertPathWithinWriteScope(options: {
  filePath: string;
  workspaceRoot: string;
  writeScope: readonly string[] | undefined;
  platform?: ToolPathPlatform;
}): void {
  if (options.writeScope === undefined) return;
  const workspaceRoot = normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const scopedPaths = options.writeScope
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => (isAbsolute(path) ? normalize(path) : resolve(workspaceRoot, path)));
  if (scopedPaths.length === 0) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      "Declared write scope is empty: this agent may not modify files",
      {
        context: { code: "write_scope_violation", reason: "empty_scope", workspaceRoot },
        recoverable: true,
        retryable: false,
      },
    );
  }
  const allowed = scopedPaths.some((scopePath) =>
    isPathWithinWorkspaceRoot(options.filePath, scopePath, options.platform),
  );
  if (!allowed) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      `Write outside the declared write_paths scope: ${options.filePath}`,
      {
        context: {
          code: "write_scope_violation",
          filePath: options.filePath,
          scope: scopedPaths,
          workspaceRoot,
        },
        recoverable: true,
        retryable: false,
      },
    );
  }
}

/**
 * 纯词法 containment：候选路径是否落在 root 之内（含 root 自身）。
 *
 * `relative` 是唯一判据：`/ws2` 不属于 `/ws`，跨盘符时 win32 的 `relative` 返回绝对路径，
 * 也判不包含。导出是为了平台矩阵单测，生产判定同样调用它。
 */
export function isPathWithinWorkspaceRoot(
  candidate: string,
  root: string,
  platform: ToolPathPlatform = currentPlatform,
): boolean {
  const pathApi = getToolPathApi(platform);
  const relativePath = pathApi.relative(
    normalizeForPlatformComparison(root, platform),
    normalizeForPlatformComparison(candidate, platform),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath))
  );
}

/**
 * 按**请求的平台**归一：win32 复用 `normalizeToolPathForComparison`（盘符别名、扩展前缀、
 * 盘符大小写），其他平台用该平台自己的 `normalize`。后者的意义是让平台矩阵单测在任何宿主
 * 上都按同一套分隔符语义执行，而不是被宿主的 `node:path` 实现偷偷影响。
 */
function normalizeForPlatformComparison(value: string, platform: ToolPathPlatform): string {
  if (platform === "win32") return normalizeToolPathForComparison(value, "win32");
  return getToolPathApi(platform).normalize(value).normalize("NFC");
}

function applyWorkspaceBoundary(
  options: ToolWorkspacePathOptions,
  workspaceRoot: string,
  resolvedPath: string,
): void {
  const configured = options.workspaceBoundary !== undefined;
  const mode = resolveWorkspaceBoundaryMode(options.workspaceBoundary);
  const audit = options.auditWorkspaceBoundary;

  if (mode === "allow" && audit === undefined) {
    // 兼容默认/显式 allow 且无审计：与改动前完全一致，不做任何文件系统探测。
    return;
  }

  const containment: BoundaryContainment = evaluateWorkspaceContainment(
    resolvedPath,
    workspaceRoot,
  );

  if (containment.kind === "contained") return;
  const escapeKind = containment.escapeKind;
  const physicalPath = containment.physicalPath;
  const physicalWorkspaceRoot = containment.physicalWorkspaceRoot;

  const report = (action: WorkspaceBoundaryAuditEvent["action"], reason?: string): void => {
    if (!audit) return;
    try {
      audit({
        event: "workspace_boundary.escape",
        action,
        mode,
        configured,
        operation: options.operation,
        requestedPath: options.inputPath,
        resolvedPath,
        workspaceRoot,
        ...(physicalPath === undefined ? {} : { physicalPath }),
        ...(physicalWorkspaceRoot === undefined ? {} : { physicalWorkspaceRoot }),
        escapeKind,
        platform: currentPlatform,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      // 审计是观察面，不能改变安全判定，也不能阻断工具执行。
    }
  };

  if (mode === "allow") {
    report("allow");
    return;
  }

  const summary = formatBoundarySummary({
    requestedPath: options.inputPath,
    resolvedPath,
    workspaceRoot,
    mode,
    escapeKind,
  });
  const details = {
    mode,
    resolvedPath,
    workspaceRoot,
    escapeKind,
    ...(physicalPath === undefined ? {} : { physicalPath }),
    ...(physicalWorkspaceRoot === undefined ? {} : { physicalWorkspaceRoot }),
  };
  if (mode === "strict") {
    report("deny");
    throw boundaryError(CoreErrorType.PermissionDenied, summary, options, details);
  }

  const approval = options.workspaceBoundaryApproval;
  if (!approval) {
    const reason =
      "workspaceBoundary=ask requires an approval port; refusing the out-of-workspace path";
    report("deny", reason);
    throw boundaryError(CoreErrorType.PermissionEscalation, summary, options, {
      ...details,
      reason,
    });
  }

  // 审批端口抛错按“拒绝”收口：ask 模式绝不能因为审批实现故障而放行。
  let approvalDecision: { decision?: unknown; reason?: unknown } | null = null;
  try {
    const rawDecision: unknown = approval.decide({
      operation: options.operation,
      requestedPath: options.inputPath,
      resolvedPath,
      workspaceRoot,
      ...(physicalPath === undefined ? {} : { physicalPath }),
      ...(physicalWorkspaceRoot === undefined ? {} : { physicalWorkspaceRoot }),
      escapeKind,
      summary,
    });
    // 根因：审批端口的类型声明只约束实现方，运行时仍可能返回 undefined / null / 缺字段。
    // 这类返回值不能被当成隐式放行，也不能让读取 `.decision` 的 TypeError 泄漏出去，
    // 否则 ask 模式会以非 PermissionDenied 的异常结束，绕过“越界必须拒绝”的契约。
    if (typeof rawDecision === "object" && rawDecision !== null) {
      approvalDecision = rawDecision as { decision?: unknown; reason?: unknown };
    }
  } catch (error) {
    const reason = `workspaceBoundary approval failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    report("deny", reason);
    throw boundaryError(CoreErrorType.PermissionDenied, reason, options, {
      ...details,
      reason,
    });
  }
  if (approvalDecision === null) {
    const reason = "workspaceBoundary approval returned no decision; refusing the escape";
    report("deny", reason);
    throw boundaryError(CoreErrorType.PermissionDenied, reason, options, {
      ...details,
      reason,
    });
  }
  if (approvalDecision.decision === "allow") {
    report("approve");
    return;
  }
  const denialReason =
    typeof approvalDecision.reason === "string" ? approvalDecision.reason : undefined;
  report("deny", denialReason);
  throw boundaryError(
    CoreErrorType.PermissionDenied,
    denialReason ?? summary,
    options,
    denialReason === undefined ? details : { ...details, reason: denialReason },
  );
}

/**
 * 边界探测（同步、只读）：越界返回细节，范围内返回 `undefined`。
 *
 * 与 {@link resolveWorkspacePath} 共用同一套词法与物理判定；供权限流在 handler 之前
 * 取得 `ask` 模式的用户决定，不新增第二套检查。
 */
export function describeWorkspaceBoundaryEscape(options: {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: ToolPathOperation;
}): WorkspaceBoundaryEscapeDetails | undefined {
  if (options.inputPath.length === 0) return undefined;
  const workingDirectory = normalizeAbsoluteDirectory(options.workingDirectory, "workingDirectory");
  const workspaceRoot = normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const resolvedPath = isAbsolute(options.inputPath)
    ? normalize(options.inputPath)
    : resolve(workingDirectory, options.inputPath);
  const containment = evaluateWorkspaceContainment(resolvedPath, workspaceRoot);
  if (containment.kind === "contained") return undefined;
  return {
    operation: options.operation,
    requestedPath: options.inputPath,
    resolvedPath,
    workspaceRoot,
    ...(containment.physicalPath === undefined ? {} : { physicalPath: containment.physicalPath }),
    ...(containment.physicalWorkspaceRoot === undefined
      ? {}
      : { physicalWorkspaceRoot: containment.physicalWorkspaceRoot }),
    escapeKind: containment.escapeKind,
  };
}

/** 把探测结果转成审批端口收到的请求（含确认窗可直接展示的一行 summary）。 */
export function createWorkspaceBoundaryApprovalRequest(
  escape: WorkspaceBoundaryEscapeDetails,
  mode: WorkspaceBoundaryMode,
): WorkspaceBoundaryApprovalRequest {
  return {
    operation: escape.operation,
    requestedPath: escape.requestedPath,
    resolvedPath: escape.resolvedPath,
    workspaceRoot: escape.workspaceRoot,
    ...(escape.physicalPath === undefined ? {} : { physicalPath: escape.physicalPath }),
    ...(escape.physicalWorkspaceRoot === undefined
      ? {}
      : { physicalWorkspaceRoot: escape.physicalWorkspaceRoot }),
    escapeKind: escape.escapeKind,
    summary: formatBoundarySummary({
      requestedPath: escape.requestedPath,
      resolvedPath: escape.resolvedPath,
      workspaceRoot: escape.workspaceRoot,
      mode,
      escapeKind: escape.escapeKind,
    }),
  };
}

/**
 * 由**已经取得的用户决定**构造同步审批端口。
 *
 * 端口只对预审批时展示过的 `(operation, resolvedPath)` 返回 allow；handler 若解析出
 * 另一条路径（例如 hook/用户改写入参、或工具动态计算路径），一律 deny。
 * 这是 ask 模式不重放、不猜测、不超时兜底的实现约束。
 */
export function createWorkspaceBoundaryApprovalPort(
  approved: readonly WorkspaceBoundaryApprovalRequest[],
): WorkspaceBoundaryApprovalPort {
  const allowed = new Set(approved.map(workspaceBoundaryRequestKey));
  return {
    decide(request) {
      if (allowed.has(workspaceBoundaryRequestKey(request))) return { decision: "allow" };
      return {
        decision: "deny",
        reason:
          `workspaceBoundary=ask path "${request.requestedPath}" was not part of the ` +
          "approved workspace-boundary request",
      };
    },
  };
}

function workspaceBoundaryRequestKey(
  request: Pick<WorkspaceBoundaryApprovalRequest, "operation" | "resolvedPath">,
): string {
  return `${request.operation}\u0000${request.resolvedPath}`;
}

/**
 * handler 侧的边界参数投影：把 ToolExecutionContext 上的模式/审批/审计一次带进
 * `resolveWorkspacePath` / `resolveToolWorkingDirectory`，避免每个 handler 重复手写。
 */
export function workspaceBoundaryOptions(context: {
  workspaceBoundary?: WorkspaceBoundaryMode;
  workspaceBoundaryApproval?: WorkspaceBoundaryApprovalPort;
  auditWorkspaceBoundary?: (event: WorkspaceBoundaryAuditEvent) => void;
}): Pick<
  ToolWorkspacePathOptions,
  "workspaceBoundary" | "workspaceBoundaryApproval" | "auditWorkspaceBoundary"
> {
  return {
    ...(context.workspaceBoundary === undefined
      ? {}
      : { workspaceBoundary: context.workspaceBoundary }),
    ...(context.workspaceBoundaryApproval === undefined
      ? {}
      : { workspaceBoundaryApproval: context.workspaceBoundaryApproval }),
    ...(context.auditWorkspaceBoundary === undefined
      ? {}
      : { auditWorkspaceBoundary: context.auditWorkspaceBoundary }),
  };
}

function evaluateWorkspaceContainment(
  resolvedPath: string,
  workspaceRoot: string,
): BoundaryContainment {
  return isPathWithinWorkspaceRoot(resolvedPath, workspaceRoot)
    ? evaluatePhysicalContainment(resolvedPath, workspaceRoot)
    : { kind: "escape", escapeKind: "lexical" };
}

type BoundaryContainment =
  | {
      kind: "contained";
      physicalPath: string;
      physicalWorkspaceRoot: string;
    }
  | {
      kind: "escape";
      escapeKind: WorkspaceBoundaryEscapeKind;
      physicalPath?: string;
      physicalWorkspaceRoot?: string;
    };

/**
 * 先词法、后物理：`resolvedPath` 已在词法上落在 root 内时才需要 realpath 复核。
 * 目标根自身必须可解析；目标允许不存在的尾段（新建文件/目录）。
 */
function evaluatePhysicalContainment(
  resolvedPath: string,
  workspaceRoot: string,
): BoundaryContainment {
  const rootResolution = resolvePhysicalPath(workspaceRoot, { allowMissingTail: false });
  if (rootResolution.physicalPath === undefined) {
    // 连 workspace root 都无法证明：没有可信物理根，不能把词法 root 冒充物理根。
    return {
      kind: "escape",
      escapeKind: rootResolution.failureKind ?? "unresolvable",
    };
  }
  const targetResolution = resolvePhysicalPath(resolvedPath, { allowMissingTail: true });
  if (targetResolution.physicalPath === undefined) {
    return {
      kind: "escape",
      escapeKind: targetResolution.failureKind ?? "unresolvable",
      physicalWorkspaceRoot: rootResolution.physicalPath,
    };
  }
  if (!isPathWithinWorkspaceRoot(targetResolution.physicalPath, rootResolution.physicalPath)) {
    return {
      kind: "escape",
      escapeKind: "symlink",
      physicalPath: targetResolution.physicalPath,
      physicalWorkspaceRoot: rootResolution.physicalPath,
    };
  }
  return {
    kind: "contained",
    physicalPath: targetResolution.physicalPath,
    physicalWorkspaceRoot: rootResolution.physicalPath,
  };
}

interface PhysicalPathResolution {
  physicalPath?: string;
  failureKind?: "dangling_symlink" | "unresolvable";
}

/**
 * 解析真实落点。`allowMissingTail`：从目标向上找到第一个存在且可 realpath 的祖先，
 * 再把不存在的尾段拼回去——"在 workspace 内新建文件"由此正常通过。
 *
 * 软链自身无法 realpath（目标缺失或成环）→ `dangling_symlink`；存在但无法解析
 * （EACCES 等）→ `unresolvable`。两者都不能证明落点，调用方按越界处理。
 */
function resolvePhysicalPath(
  target: string,
  options: { allowMissingTail: boolean },
): PhysicalPathResolution {
  const direct = tryRealpath(target);
  if (direct !== undefined) return { physicalPath: direct };
  if (!options.allowMissingTail) {
    const failureKind = classifyRealpathFailure(target);
    return { failureKind: failureKind === "missing" ? "unresolvable" : failureKind };
  }

  const missingTail: string[] = [];
  let current = normalize(target);
  for (;;) {
    const real = tryRealpath(current);
    if (real !== undefined) {
      return {
        physicalPath: missingTail.length === 0 ? real : join(real, ...missingTail.reverse()),
      };
    }
    const failureKind = classifyRealpathFailure(current);
    if (failureKind !== "missing") return { failureKind };
    const parent = dirname(current);
    if (parent === current) return { failureKind: "unresolvable" };
    missingTail.push(basename(current));
    current = parent;
  }
}

function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

function classifyRealpathFailure(target: string): "missing" | "dangling_symlink" | "unresolvable" {
  try {
    return lstatSync(target).isSymbolicLink() ? "dangling_symlink" : "unresolvable";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // 只有“确实不存在”才允许向上找已存在祖先。EACCES/ELOOP 等无法证明落点，
    // 必须 fail closed——否则一个不可读目录之后的尾段会被当成普通缺省路径。
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "ELOOP") return "dangling_symlink";
    return "unresolvable";
  }
}

function formatBoundarySummary(input: {
  requestedPath: string;
  resolvedPath: string;
  workspaceRoot: string;
  mode: WorkspaceBoundaryMode;
  escapeKind: WorkspaceBoundaryEscapeKind;
}): string {
  return (
    `Tool path "${input.requestedPath}" resolves to "${input.resolvedPath}" ` +
    `outside workspace "${input.workspaceRoot}"; ` +
    `workspaceBoundary=${input.mode}, escapeKind=${input.escapeKind}`
  );
}

function boundaryError(
  type: CoreErrorType,
  message: string,
  options: ToolWorkspacePathOptions,
  details: {
    mode: WorkspaceBoundaryMode;
    resolvedPath: string;
    workspaceRoot: string;
    escapeKind: WorkspaceBoundaryEscapeKind;
    physicalPath?: string;
    physicalWorkspaceRoot?: string;
    reason?: string;
  },
) {
  return createCoreError(type, message, {
    context: {
      workspaceBoundary: details.mode,
      escapeKind: details.escapeKind,
      operation: options.operation,
      requestedPath: options.inputPath,
      resolvedPath: details.resolvedPath,
      workspaceRoot: details.workspaceRoot,
      ...(details.physicalPath === undefined ? {} : { physicalPath: details.physicalPath }),
      ...(details.physicalWorkspaceRoot === undefined
        ? {}
        : { physicalWorkspaceRoot: details.physicalWorkspaceRoot }),
      ...(details.reason === undefined ? {} : { reason: details.reason }),
    },
    recoverable: true,
  });
}

function resolveWorkspaceBoundaryMode(
  value: WorkspaceBoundaryMode | undefined,
): WorkspaceBoundaryMode {
  if (value === undefined) return "allow";
  if (value === "strict" || value === "ask" || value === "allow") return value;
  // 非法配置 fail closed：不能把未知模式静默当成允许。
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `workspaceBoundary must be "strict", "ask" or "allow"; received ${JSON.stringify(value)}`,
    {
      context: { workspaceBoundary: value },
      recoverable: false,
    },
  );
}

function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
