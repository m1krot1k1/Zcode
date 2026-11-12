import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type CollaborationMode,
  type Logger,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
  type ToolExecutionSpanWriter,
  type WorkspaceBoundaryMode,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import {
  createWorkspaceBoundaryApprovalRequest,
  describeWorkspaceBoundaryEscape,
  type WorkspaceBoundaryApprovalRequest,
  type WorkspaceBoundaryAuditEvent,
} from "../path-policy.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolInputResolutionContext,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { resolveToolApproval } from "./approval-gate.js";
import { createErrorResult, createPermissionErrorResult } from "./errors.js";
import { emitPermissionDenied, emitPermissionResolved } from "./events.js";
import { applyPreToolPermissionDecision } from "./hook-flow.js";
import { applyMemoryFilePermission } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { preparePermissionInput } from "./permission-input.js";
import { applyPermissionInputAdjustments } from "./permission-input-adjustments.js";
import { recheckPermissionHookModifiedInput } from "./permission-input-recheck.js";
import { requestPermissionResponse } from "./permission-request.js";
import {
  interpretPermissionResponse,
  type PermissionFlowResult,
  type PermissionResponseTransition,
} from "./permission-response.js";
import {
  loadProjectPermissionRuleset,
  applyGrantedPermissionUpdates,
} from "./permission-rules-persistence.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";

export async function resolveToolPermission(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  preToolHookResult: HookRunResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
  telemetry?: ToolExecutionSpanWriter,
  preparedContext?: ToolRuntimePermissionCapabilityContext,
): Promise<PermissionFlowResult> {
  const context = {
    ...resolveRuntimePermissionContext(deps),
    ...preparedContext,
    mode,
    workingDirectory: preparedContext?.workingDirectory ?? deps.getWorkingDirectory(),
    workspaceRoot: preparedContext?.workspaceRoot ?? deps.getWorkspaceRoot(),
  };
  let projectRules: PermissionRuleset | null;
  try {
    projectRules = await loadProjectPermissionRuleset(deps);
  } catch (error) {
    return {
      allowed: false,
      result: createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to load project permission rules", {
          cause: error instanceof Error ? error : undefined,
          recoverable: true,
        }),
      ),
    };
  }
  let firstInput = true;
  let hooksAvailable = true;
  let permissionWaitMs = 0;
  /**
   * ask 模式下本次调用已经向用户展示并获批的越界路径。输入被 hook/用户改写后会重新计算；
   * 只有 handler 实际解析到这些路径时同步审批端口才放行。
   */
  let boundaryApproved: readonly WorkspaceBoundaryApprovalRequest[] = [];
  // 根因：递归重入会重跑 Hook，并把问答答案当新操作；显式转换仅重判新输入。
  while (true) {
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    const rulePolicy = entry.resolvePermissionRulePolicy?.(executionInput, context);
    let decision = deps.permissionService.checkPermission(
      {
        toolName: toolCall.name,
        input: executionInput,
        riskLevel: entry.metadata.riskLevel,
        mode,
        planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
        prePlanMode: deps.sessionModePort?.getPrePlanMode(),
        // 草稿预批与实际工具输入共用已准备的 cwd，不能在合并 Guarded 时漏传。
        workingDirectory: context.workingDirectory,
      },
      resolveRuntimePermissionCapability(entry, executionInput, context),
      projectRules,
      rulePolicy,
    );
    if (firstInput && decision.approvalMode !== "user-once") {
      decision = applyPreToolPermissionDecision(decision, preToolHookResult, mode);
    }
    firstInput = false;
    decision = applyMemoryFilePermission({
      decision,
      executionInput,
      memoryRoot: deps.getMemoryRoot?.(),
      toolName: toolCall.name,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
    // ask 模式的越界必须在这里变成真实用户确认：path-policy 的审批端口是同步契约，
    // 只能回放已经取得的决定，不能自己等待 broker。deny 仍然优先，见 gate 内部。
    const boundaryGate = applyWorkspaceBoundaryGate({
      decision,
      entry,
      executionInput,
      workspaceBoundary: deps.workspaceBoundary,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    });
    decision = boundaryGate.decision;
    boundaryApproved = boundaryGate.approvedRequests;
    // 修复原因：统一审批流程曾丢失原日志合同；恢复关联字段，输入仍只记录结构摘要。
    deps.logger?.debug("Tool permission evaluated", {
      ...traceContextToLogContext(traceContext),
      decision: decision.decision,
      event: "tool.permission.evaluated",
      inputSummary: summarizeInput(toolCall.input),
      mode,
      module: "core.tool.executor",
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sideEffectScope: decision.sideEffectScope,
      status:
        decision.decision === "allow"
          ? "completed"
          : decision.decision === "ask"
            ? "waiting"
            : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (decision.allowed) {
      telemetry?.setPermissionDecision(permissionWaitMs ? "granted" : "not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }
    if (decision.decision === "deny") {
      telemetry?.setPermissionDecision("denied");
      await emitPermissionDenied(deps, toolCall, decision.reason, traceContext);
      deps.logger?.warn("Tool permission denied", {
        ...traceContextToLogContext(traceContext),
        decision: decision.decision,
        event: "tool.permission.denied",
        mode,
        module: "core.tool.executor",
        reason: decision.reason,
        ruleId: decision.ruleId,
        status: "failed",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      return {
        allowed: false,
        result: createPermissionErrorResult(toolCall, decision.reason, {
          mode,
          ruleId: decision.ruleId,
        }),
      };
    }

    // 工具预览只能控制普通审批，不能覆盖 Guarded 的单次确认，也不能覆盖越界确认。
    const approval =
      decision.approvalMode === "user-once" || boundaryApproved.length > 0
        ? { gate: "ask" as const }
        : resolveToolApproval(deps, toolCall, entry, executionInput, traceContext);
    if (approval.gate === "proceed") {
      telemetry?.setPermissionDecision("not_required");
      return { allowed: true, executionInput, permissionWaitMs };
    }

    const requestId = "perm_" + crypto.randomUUID();
    const startedAt = Date.now();
    const suggestedPermissionUpdates =
      decision.approvalMode === "user-once"
        ? []
        : (rulePolicy?.suggestedPermissionUpdates ??
          buildDefaultPermissionUpdates(
            toolCall.name,
            executionInput,
            entry.permissionCapabilityGroup,
          ));
    telemetry?.markPermissionRequested();
    let transition: PermissionResponseTransition;
    let resolved: PermissionBrokerResult;
    try {
      let outcome = await requestPermissionResponse({
        deps,
        toolCall,
        input: executionInput,
        decision,
        mode,
        requestId,
        traceContext,
        suggestedPermissionUpdates,
        approval,
        runHooks: hooksAvailable && decision.approvalMode !== "user-once",
        signal,
      });
      hooksAvailable = false;
      let rewrite: PermissionResponseTransition | undefined;
      // 非 guarded 保留已发布的 Hook/project/Memory 重判范围与授权语义。
      if (mode !== "guarded" && outcome.source === "hook" && outcome.result.decision === "modify") {
        const normalized = preparePermissionInput(
          outcome.result.modifiedInput ?? executionInput,
          entry,
          deps,
        );
        const recheck = recheckPermissionHookModifiedInput({
          context,
          deps,
          entry,
          mode,
          modifiedInput: normalized,
          projectRules,
          toolCall,
        });
        if (recheck.permissionDecision?.decision === "ask") {
          // 旧分支用同一 requestId 再次调用 broker，迟到响应可能批准新输入。
          // 保留原有 project/Memory 重判范围，生命周期改走相同的结束→新建转换。
          rewrite = { kind: "rewrite", input: normalized };
        } else {
          executionInput = normalized;
          outcome = {
            source: "hook",
            result: {
              ...outcome.result,
              modifiedInput: undefined,
              decision: recheck.permissionDecision?.decision === "deny" ? "deny" : "allow",
              reason: recheck.permissionDecision?.reason ?? outcome.result.reason,
            },
          };
        }
      }
      transition =
        rewrite ??
        interpretPermissionResponse({
          deps,
          toolCall,
          entry,
          input: executionInput,
          mode,
          decision,
          outcome,
          requestId,
        });
      resolved = { ...outcome.result, resolvedAt: outcome.result.resolvedAt ?? new Date() };
    } catch (error) {
      const coreError = isCoreError(error)
        ? error
        : createCoreError(
            mode === "guarded" ? CoreErrorType.ToolExecutionFailed : CoreErrorType.PermissionDenied,
            "Permission request failed",
            {
              cause: error instanceof Error ? error : undefined,
              context: { requestId, toolCallId: toolCall.id, toolName: toolCall.name },
              recoverable: true,
            },
          );
      resolved = { decision: "deny", reason: coreError.message, resolvedAt: new Date() };
      transition = {
        kind: "complete",
        result: { allowed: false, result: createErrorResult(toolCall, coreError) },
      };
    }
    permissionWaitMs += Math.max(0, Date.now() - startedAt);
    // 只有此处结束请求：校验错误、取消、改写和正常响应都发一次终态。
    await emitPermissionResolved(deps, toolCall, requestId, resolved, traceContext);
    deps.logger?.info("Tool permission resolved", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.resolved",
      module: "core.tool.executor",
      requestId,
      mode,
      ruleId: decision.ruleId,
      decision: resolved.decision,
      reason: resolved.reason,
      status:
        resolved.decision === "allow" || resolved.decision === "modify" ? "completed" : "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    if (transition.kind === "rewrite") {
      executionInput = transition.input;
      continue;
    }
    const result = transition.result;
    telemetry?.setPermissionDecision(result.allowed ? "granted" : "denied");
    if (!result.allowed) return result;
    if (signal?.aborted)
      return {
        allowed: false,
        result: createErrorResult(
          toolCall,
          createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", {
            recoverable: true,
          }),
        ),
      };
    const updateFailure = await applyGrantedPermissionUpdates({
      deps,
      permissionUpdates: resolved.permissionUpdates,
      requestId,
      sessionPermissionUpdates: resolved.sessionPermissionUpdates,
      toolCall,
      traceContext,
    });
    if (updateFailure) return { allowed: false, result: updateFailure };
    const adjusted = applyPermissionInputAdjustments({
      deps,
      entry,
      toolCall,
      executionInput: result.executionInput,
      adjustments: resolved.inputAdjustments,
      traceContext,
    });
    if (!adjusted.ok) return { allowed: false, result: adjusted.result };
    return {
      ...result,
      executionInput: adjusted.executionInput,
      permissionWaitMs,
      ...(boundaryApproved.length === 0 ? {} : { workspaceBoundaryApproval: boundaryApproved }),
      ...(adjusted.applied === undefined ? {} : { inputAdjustments: adjusted.applied }),
    };
  }
}

/**
 * ask 模式的规则号。越界确认走既有 permission broker，但既不能命中「本会话总是允许」的
 * 普通规则，也不能被工具的 `prepareApproval` 收窄成 proceed；规则号因此独立。
 */
const WORKSPACE_BOUNDARY_ASK_RULE_ID = "tool.workspaceBoundary.ask";

interface WorkspaceBoundaryGateResult {
  decision: PermissionDecisionResult;
  /**
   * 本轮已经向用户展示并获批的越界请求。handler 只会拿到这些路径的同步放行；
   * 任何未展示过的越界路径由端口 fail closed。
   */
  approvedRequests: readonly WorkspaceBoundaryApprovalRequest[];
}

/**
 * 在权限判定之后、确认窗之前把 `ask` 模式的越界变成真实的用户确认。
 *
 * 根因：path-policy 的审批端口是**同步**契约（不做异步等待），而用户决定只能在
 * permission broker 里异步取得。因此决定必须提前到这里：工具声明本次会解析的路径
 * （`ToolEntry.resolveWorkspaceBoundaryPaths`），executor 用同一个
 * `describeWorkspaceBoundaryEscape` 判定越界，再让既有审批流去问用户。
 * handler 随后拿到的端口只回放这次已经拿到的决定——不弹窗、不阻塞、不猜。
 */
export function applyWorkspaceBoundaryGate(input: {
  decision: PermissionDecisionResult;
  entry: ToolEntry;
  executionInput: unknown;
  workspaceBoundary: WorkspaceBoundaryMode | undefined;
  workingDirectory: string;
  workspaceRoot: string;
}): WorkspaceBoundaryGateResult {
  const unchanged: WorkspaceBoundaryGateResult = {
    decision: input.decision,
    approvedRequests: [],
  };
  if (input.workspaceBoundary !== "ask") return unchanged;

  const declaredPaths = readDeclaredBoundaryPaths(input);
  if (declaredPaths.length === 0) return unchanged;

  const seen = new Set<string>();
  const requests: WorkspaceBoundaryApprovalRequest[] = [];
  for (const declared of declaredPaths) {
    const escape = describeWorkspaceBoundaryEscape({
      inputPath: declared.path,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
      operation: declared.operation,
    });
    if (!escape) continue;
    const request = createWorkspaceBoundaryApprovalRequest(escape, "ask");
    const key = `${request.operation}\u0000${request.resolvedPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push(request);
  }
  if (requests.length === 0) return unchanged;

  // 硬拒绝永远优先：越界不能把一个 deny 变回 ask。
  if (input.decision.decision === "deny") {
    return { decision: input.decision, approvedRequests: requests };
  }

  const summary =
    requests.length === 1
      ? requests[0]!.summary
      : `${requests.length} tool paths resolve outside workspace "${input.workspaceRoot}"; ` +
        `workspaceBoundary=ask. First: ${requests[0]!.summary}`;
  return {
    decision: {
      ...input.decision,
      decision: "ask",
      allowed: false,
      escalated: true,
      // user-once 同时保证：不写会话/项目规则、不提供「总是允许」、跳过 prepareApproval，
      // 于是这次确认不可能被工具预览降级成 proceed。
      approvalMode: "user-once",
      alwaysAsk: true,
      reason: summary,
      ruleId: WORKSPACE_BOUNDARY_ASK_RULE_ID,
    },
    approvedRequests: requests,
  };
}

function readDeclaredBoundaryPaths(input: {
  entry: ToolEntry;
  executionInput: unknown;
  workingDirectory: string;
}) {
  const resolvePaths = input.entry.resolveWorkspaceBoundaryPaths;
  if (!resolvePaths) return [];
  const context: ToolInputResolutionContext = { workingDirectory: input.workingDirectory };
  try {
    return resolvePaths(input.executionInput, context) ?? [];
  } catch {
    // 声明只是预审批的输入，不是判定：读不出来时不改变权限结果。handler 仍会走
    // path-policy，ask 模式下没有获批路径就 fail closed，不会因此放行。
    return [];
  }
}

/**
 * 越界审计：写 runtime logger（不是 console）。allow / approve 记 info，deny 记 warn。
 * 审计是观察面：这里抛错不能让工具执行失败，path-policy 自身也已兜住回调异常。
 */
export function createWorkspaceBoundaryAuditLogger(
  logger: Logger | undefined,
  traceContext: TraceContext,
): ((event: WorkspaceBoundaryAuditEvent) => void) | undefined {
  if (!logger) return undefined;
  return (event) => {
    const status = event.action === "deny" ? ("failed" as const) : ("completed" as const);
    const context = {
      ...traceContextToLogContext(traceContext),
      action: event.action,
      escapeKind: event.escapeKind,
      event: event.event,
      module: "core.tool.executor",
      operation: event.operation,
      platform: event.platform,
      requestedPath: event.requestedPath,
      resolvedPath: event.resolvedPath,
      status,
      workspaceBoundary: event.mode,
      workspaceBoundaryConfigured: event.configured,
      workspaceRoot: event.workspaceRoot,
      ...(event.physicalPath === undefined ? {} : { physicalPath: event.physicalPath }),
      ...(event.physicalWorkspaceRoot === undefined
        ? {}
        : { physicalWorkspaceRoot: event.physicalWorkspaceRoot }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    if (event.action === "deny") {
      logger.warn("Workspace boundary escape denied", context);
      return;
    }
    logger.info("Workspace boundary escape", context);
  };
}
