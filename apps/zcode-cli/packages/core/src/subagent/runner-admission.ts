// Subagent runner: admission в runtime registry, PRISM-контракт, профили и auto-background.

import {
  AgentErrorCode,
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createSessionEvent,
  isCoreError,
  type PrismHostEvidenceReceipt,
  type SessionEvent,
  type SubagentLaunchRequest,
  type SubagentRunRequest,
  type TraceContext,
  type PrismTaskAcceptanceDecision,
  type PrismTaskAcceptanceLineage,
  type PrismTaskContract,
} from "@zcode/contracts";
import {
  PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
  PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
} from "@zcode/contracts";
import { createHash } from "node:crypto";
import { isBuiltInExploreAgentProfile, type AgentProfile } from "./profile.js";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "./explore-tools.js";
import { filterSubagentChildToolNames } from "./tool-policy.js";
import { createToolRuleNameSet } from "../tool/tool-visibility.js";
import {
  type RuntimeTaskAdmissionResult,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";
import {
  createPrismTaskContract,
  evaluatePrismTaskAcceptance,
  reducePrismTaskAcceptance,
} from "../runtime-task/registry.js";
import type { ExploreSubagentPortOptions, SubagentLifecycle } from "./runner-types.js";
import { registerSubagentTask, type SubagentTaskAbortHandle } from "./runner-task-runtime.js";

type AgentProfileResolution =
  | { kind: "matched"; profile: AgentProfile }
  | { availableAgentTypes: readonly string[]; kind: "not_found" }
  | {
      availableAgentTypes: readonly string[];
      kind: "ambiguous";
      matches: readonly string[];
    };

export interface AutoBackgroundTimer {
  cancel(): void;
  promise: Promise<{ kind: "backgrounded" | "ignored" }>;
}

const SUBAGENT_CAPACITY_WAIT_TIMEOUT_MS = 10 * 60_000;
const SUBAGENT_CAPACITY_POLL_MS = 1_000;

/**
 * Сколько ждать свободный worker-слот, прежде чем вернуть ошибку модели.
 * Причина: мгновенный отказ `active_limit` стоил полноценного дополнительного
 * запроса к модели (7–25 с) и превращал перегрузку в провал ветки DAG.
 */
export async function registerSubagentTaskWithCapacityWait(
  registry: RuntimeTaskRegistry,
  task: RuntimeTaskSnapshot,
  cancellation: SubagentTaskAbortHandle,
): Promise<RuntimeTaskAdmissionResult> {
  let admission = registerSubagentTask(registry, task, cancellation);
  if (admission.accepted || admission.reason !== "active_limit") return admission;
  const deadlineAt = Date.now() + SUBAGENT_CAPACITY_WAIT_TIMEOUT_MS;
  while (
    !admission.accepted &&
    admission.reason === "active_limit" &&
    Date.now() < deadlineAt &&
    !cancellation.signal.aborted
  ) {
    const capacityChanged = registry.waitForCapacityChange({
      signal: cancellation.signal,
    });
    const poll = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SUBAGENT_CAPACITY_POLL_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([capacityChanged, poll]);
    } catch {
      // Отмена родителя: ниже вернём текущий отказ, вызывающий код его обработает.
      break;
    }
    admission = registerSubagentTask(registry, task, cancellation);
  }
  return admission;
}

export async function declarePrismTaskContractForAdmission(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  registry: RuntimeTaskRegistry,
  admittedTask: RuntimeTaskSnapshot,
  traceContext: TraceContext,
): Promise<void> {
  if (!request.acceptanceCriteria?.length) return;
  if (
    !admittedTask.parentSessionId ||
    !admittedTask.rootRunId ||
    !admittedTask.attemptId ||
    admittedTask.branchGeneration === undefined
  ) {
    throw new Error("Cannot declare PRISM criteria without admitted task lineage");
  }

  const parentTask = registry.getSubagentTaskByChildSession(admittedTask.parentSessionId);
  const contract: PrismTaskContract = createPrismTaskContract({
    rootRunId: admittedTask.rootRunId,
    taskId: admittedTask.taskId,
    ...(parentTask ? { parentTaskId: parentTask.taskId } : {}),
    attemptId: admittedTask.attemptId,
    branchGeneration: admittedTask.branchGeneration,
    description: request.description,
    // 原因：原始命令可能含敏感参数；父会话 durable contract 只需哈希即可精确匹配。
    criteria: request.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      check: {
        kind: criterion.check.kind,
        commandSha256: createHash("sha256").update(criterion.check.command, "utf8").digest("hex"),
        expectedExitCode: criterion.check.expectedExitCode,
      },
      evaluatorId: PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
      evaluatorVersion: PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
    })),
  });
  const taskWithContract = registry.update(admittedTask.taskId, (current) =>
    current.attemptId === admittedTask.attemptId
      ? { ...current, prismTaskContract: contract }
      : current,
  );
  if (!taskWithContract?.prismTaskContract) {
    throw new Error("PRISM task admission changed before contract declaration");
  }

  const event = createSessionEvent(
    SessionEventType.PrismTaskContractDeclared,
    admittedTask.parentSessionId,
    { contract },
    { turnId: request.turnId, traceId: traceContext.traceId },
  );
  await options.emitParentEvent(event, traceContext);
}

export async function evaluateAndPersistPrismAcceptance(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  evidenceEvents: readonly SessionEvent[],
  traceContext: TraceContext,
): Promise<PrismTaskAcceptanceDecision> {
  const task = registry.get(taskId);
  const contract = task?.prismTaskContract;
  if (!task || !contract || !task.childSessionId || !task.parentSessionId) {
    return unknownPrismDecision(contract);
  }

  const current: PrismTaskAcceptanceLineage = {
    rootRunId: task.rootRunId ?? contract.rootRunId,
    taskId: task.taskId,
    ...(contract.parentTaskId === undefined ? {} : { parentTaskId: contract.parentTaskId }),
    attemptId: task.attemptId ?? contract.attemptId,
    branchGeneration: task.branchGeneration ?? contract.branchGeneration,
  };
  if (
    current.rootRunId !== contract.rootRunId ||
    current.attemptId !== contract.attemptId ||
    current.branchGeneration !== contract.branchGeneration ||
    registry.getBranchGenerationForSession(task.parentSessionId) !== current.branchGeneration
  ) {
    return unknownPrismDecision(contract);
  }

  const evaluated = evaluatePrismTaskAcceptance({
    contract,
    current,
    childSessionId: task.childSessionId,
    events: evidenceEvents,
  });
  const persistedReceipts: PrismHostEvidenceReceipt[] = [];
  for (const receipt of evaluated.receipts) {
    const event = createSessionEvent(
      SessionEventType.PrismEvidenceReceiptObserved,
      task.parentSessionId,
      { receipt },
      { turnId: task.turnId, traceId: traceContext.traceId },
    );
    try {
      await options.emitParentEvent(event, traceContext);
      const latest = registry.get(taskId);
      if (
        !latest ||
        latest.attemptId !== current.attemptId ||
        latest.branchGeneration !== current.branchGeneration ||
        registry.getBranchGenerationForSession(task.parentSessionId) !== current.branchGeneration
      ) {
        break;
      }
      persistedReceipts.push(receipt);
    } catch (error) {
      options.logger?.warn("PRISM evidence receipt could not be persisted", {
        event: "subagent.prism.receipt_persist_failed",
        module: "core.subagent",
        taskId,
        criterionId: receipt.criterionId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const decision = reducePrismTaskAcceptance({
    contract,
    receipts: persistedReceipts,
    current,
  });
  registry.update(taskId, (latest) =>
    latest.attemptId === current.attemptId && latest.branchGeneration === current.branchGeneration
      ? { ...latest, prismAcceptance: decision }
      : latest,
  );
  return decision;
}

function unknownPrismDecision(
  contract: PrismTaskContract | undefined,
): PrismTaskAcceptanceDecision {
  return {
    status: "unknown",
    passedCriterionIds: [],
    failedCriterionIds: [],
    missingCriterionIds: contract?.criteria.map(({ id }) => id) ?? [],
  };
}

const SUBAGENT_ADMISSION_REJECTED_CODE = "agent_subagent_admission_rejected";

/**
 * Причина отказа registry admission из ошибки порта. DAG по ней отличает write-claim
 * конфликт (ветка blocked, остальные ветки продолжаются) от прочих сбоев child.
 */
export function readSubagentAdmissionReason(error: unknown): string | undefined {
  if (!isCoreError(error) || error.context?.code !== SUBAGENT_ADMISSION_REJECTED_CODE) {
    return undefined;
  }
  const reason = error.context.reason;
  return typeof reason === "string" ? reason : undefined;
}

export function throwOnSubagentAdmissionFailure(
  admission: Extract<RuntimeTaskAdmissionResult, { accepted: false }>,
  request: SubagentRunRequest,
): never {
  const isCapacityLimit = admission.reason === "active_limit";
  const isWriteConflict = admission.reason === "write_claim_conflict";
  const isClaimUnavailable = admission.reason === "work_claim_unavailable";
  const message = isWriteConflict
      ? "Work claim conflict: another agent holds an overlapping file path. Choose non-overlapping files, read the held path first, or wait for that agent to finish. The spawn was not started."
      : isClaimUnavailable
        ? "Work ledger is unavailable: the host could not reserve this agent's file claim, so the spawn was not started to avoid a silent write conflict."
        : isCapacityLimit
          ? "No worker slot is currently available for this root session; retry after active work finishes or reduce parallelism."
          : "The parent runtime no longer accepts subagent work.";
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `${message} (reason: ${admission.reason})`,
    {
      context: {
        code: SUBAGENT_ADMISSION_REJECTED_CODE,
        reason: admission.reason,
        parentSessionId: request.sessionId,
        parentToolCallId: request.parentToolCallId,
      },
      recoverable: true,
    },
  );
}

export function normalizeAutoBackgroundMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

export function createAutoBackgroundTimer(
  registry: RuntimeTaskRegistry,
  agentId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): AutoBackgroundTimer {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise!: (value: { kind: "backgrounded" | "ignored" }) => void;

  const complete = (value: { kind: "backgrounded" | "ignored" }): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolvePromise(value);
  };
  const onAbort = (): void => {
    complete({ kind: "ignored" });
  };
  const promise = new Promise<{ kind: "backgrounded" | "ignored" }>((resolve) => {
    resolvePromise = resolve;
    if (signal?.aborted) {
      complete({ kind: "ignored" });
      return;
    }

    timer = setTimeout(() => {
      complete({
        kind: registry.requestBackground(agentId) ? "backgrounded" : "ignored",
      });
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return {
    cancel: () => complete({ kind: "ignored" }),
    promise,
  };
}

export function resolveAgentProfileForRequest(
  profiles: readonly AgentProfile[],
  request: SubagentRunRequest,
): { profile: AgentProfile; request: SubagentRunRequest } {
  const resolution = resolveAgentProfileByType(profiles, request.agentType);
  if (resolution.kind === "matched") {
    const { profile } = resolution;
    return {
      profile,
      request:
        profile.name === request.agentType
          ? request
          : {
              ...request,
              // 模型可能按大小写/分隔符近似写 subagent_type；后续
              // toolset、事件和 metadata 都依赖 canonical agentType，必须在入口统一收敛。
              agentType: profile.name,
            },
    };
  }

  if (resolution.kind === "ambiguous") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      [
        `Agent type '${request.agentType}' is ambiguous`,
        `matches ${resolution.matches.join(", ")}`,
        `Use the exact name: ${resolution.matches.join(" or ")}`,
      ].join(" — "),
      {
        context: {
          code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
          agentType: request.agentType,
          matches: resolution.matches,
          parentToolCallId: request.parentToolCallId,
        },
        recoverable: true,
      },
    );
  }

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Agent type '${request.agentType}' not found. Available agents: ${resolution.availableAgentTypes.join(", ")}`,
    {
      context: {
        code: AgentErrorCode.UNKNOWN_AGENT_TYPE,
        agentType: request.agentType,
        availableAgentTypes: resolution.availableAgentTypes,
        parentToolCallId: request.parentToolCallId,
      },
      recoverable: true,
    },
  );
}

function resolveAgentProfileByType(
  profiles: readonly AgentProfile[],
  requestedAgentType: string,
): AgentProfileResolution {
  const exact = profiles.find((candidate) => candidate.name === requestedAgentType);
  if (exact) return { kind: "matched", profile: exact };

  const availableAgentTypes = profiles.map((profile) => profile.name);

  const requestedNormalized = normalizeAgentTypeForMatch(requestedAgentType);
  if (!requestedNormalized) return { availableAgentTypes, kind: "not_found" };

  const normalizedMatches = profiles.filter(
    (candidate) => normalizeAgentTypeForMatch(candidate.name) === requestedNormalized,
  );
  if (normalizedMatches.length === 1) {
    return { kind: "matched", profile: normalizedMatches[0] };
  }
  if (normalizedMatches.length > 1) {
    return {
      availableAgentTypes,
      kind: "ambiguous",
      matches: normalizedMatches.map((profile) => profile.name),
    };
  }

  return { availableAgentTypes, kind: "not_found" };
}

function normalizeAgentTypeForMatch(agentType: string): string | undefined {
  const normalized = agentType
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Pd}_]+/gu, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function toSubagentExecutionRequest(request: SubagentLaunchRequest): SubagentRunRequest {
  const { runInBackground: _runInBackground, ...executionRequest } = request;
  return executionRequest;
}

/**
 * 子级 level 由“父级显式值 > 父任务 registry snapshot > 0”推导后加一。
 * foreground run 传入 runOptions.level（DAG 节点）、background start 无显式值，
 * resume 优先沿用自身 task.level；三者共用同一推导避免快照链在不同路径断开。
 */
export function deriveChildTaskLevel(
  request: SubagentRunRequest,
  parentLevel: number | undefined,
  registry?: RuntimeTaskRegistry,
): number {
  // AgentInput.level is the caller-provided parent level; it must participate in the
  // same precedence chain as DAG runOptions and the parent registry snapshot.
  const explicitParentLevel = parentLevel ?? request.level;
  const snapshotParentLevel =
    explicitParentLevel === undefined
      ? registry?.getSubagentTaskByChildSession(request.sessionId)?.level
      : undefined;
  return (explicitParentLevel ?? snapshotParentLevel ?? 0) + 1;
}

export function createRuntimeTaskSnapshot(input: {
  isBackgrounded: boolean;
  lifecycle: SubagentLifecycle;
  request: SubagentRunRequest;
  pendingMessages?: RuntimeTaskPendingMessage[];
  startedAt: Date;
  status: RuntimeTaskSnapshot["status"];
  /** 本任务的嵌套层级；仅记录。 */
  level?: number;
  /** Эффективная tool surface родителя; undefined — legacy-поведение. */
  parentToolNames?: readonly string[];
}): RuntimeTaskSnapshot {
  return {
    taskId: input.lifecycle.agentId,
    agentId: input.lifecycle.agentId,
    agentType: input.request.agentType,
    childSessionId: input.lifecycle.childSessionId,
    description: input.request.description,
    isBackgrounded: input.isBackgrounded,
    outputFile: input.lifecycle.outputFile,
    parentToolCallId: input.request.parentToolCallId,
    parentSessionId: input.request.sessionId,
    ...(input.pendingMessages?.length ? { pendingMessages: input.pendingMessages } : {}),
    prompt: input.request.prompt,
    startedAt: input.startedAt,
    status: input.status,
    childSessionReady: false,
    taskType: "local_agent",
    traceContext: input.lifecycle.runTraceContext,
    type: "local_agent",
    turnId: input.request.turnId,
    // Область claim'а в work ledger: тот же workspace, что видит конверт ребёнка.
    workspacePath: input.request.workspaceRoot || input.request.workingDirectory,
    // Write-capability берётся из фактической поверхности профиля И родителя,
    // а не из текста prompt: read-only роли не создают claim'ы на упомянутые для чтения пути.
    writeCapable: isEffectiveWriteCapable(input.lifecycle.profile, input.parentToolNames),
    ...(input.request.writePaths === undefined ? {} : { writePaths: input.request.writePaths }),
    ...(input.level === undefined ? {} : { level: input.level }),
  };
}

/**
 * Роль может писать, если её эффективная (унаследованная) поверхность содержит Write/Edit.
 * Read-only роли (start, orchestrator, researcher, reviewer, security-reviewer, evaluator)
 * объявляют инспекционный набор инструментов, поэтому не претендуют на запись путей.
 */
export function isAgentProfileWriteCapable(
  profile: Pick<AgentProfile, "tools" | "disallowedTools">,
): boolean {
  // 修复原因：runtime (resolveSubagentToolAllowlist) трактует tools: undefined/[]
  // как наследование родительского tool surface, а прежний классификатор считал это
  // пустым набором: custom/plugin профиль реально получал Write/Edit, но registrar
  // не создавал claim. 修复依据：disallowedTools 按 rule syntax 归一化 (Write(*)),
  // а пустой/отсутствующий tools наследует запись, пока не запрещены оба write-инструмента.
  const disallowed = createToolRuleNameSet(profile.disallowedTools);
  const deniesWriteSurface =
    disallowed?.has("Write") === true && disallowed.has("Edit") === true;
  // `tools: undefined` и `tools: []` наследуют весь доступный tool surface.
  if (profile.tools === undefined || profile.tools.length === 0) {
    return !deniesWriteSurface;
  }
  // `*` наследует весь доступный tool surface; запись остаётся возможной, пока
  // профиль явно не запретил оба write-инструмента.
  if (profile.tools.includes("*")) {
    return !deniesWriteSurface;
  }
  return profile.tools.some(
    (tool) => (tool === "Write" || tool === "Edit") && disallowed?.has(tool) !== true,
  );
}

/**
 * Эффективная write-capability задачи: профиль должен объявлять запись, а фактическая
 * поверхность родителя — действительно выдавать Write/Edit. `parentToolNames === undefined`
 * сохраняет прежнее поведение (классификация только по профилю) для старых вызывающих.
 */
export function isEffectiveWriteCapable(
  profile: Pick<AgentProfile, "tools" | "disallowedTools">,
  parentToolNames?: readonly string[],
): boolean {
  if (!isAgentProfileWriteCapable(profile)) return false;
  if (parentToolNames === undefined) return true;
  return parentToolNames.includes("Write") || parentToolNames.includes("Edit");
}

export function resolveAllowedTools(
  profile: AgentProfile,
  options: ExploreSubagentPortOptions,
): readonly string[] {
  const profileTools = isBuiltInExploreAgentProfile(profile)
    ? (options.getAllowedTools?.(profile) ?? EXPLORE_AGENT_ALLOWED_TOOLS)
    : profile.tools;
  const hasAllowedSkills = (profile.skills?.length ?? 0) > 0;
  // 配置可显式写 tools: [Skill]；不允许它绕过空/缺失的技能白名单。
  const baseTools = [...(profileTools ?? [])].filter(
    (toolName) => toolName !== "Skill" || hasAllowedSkills,
  );
  const disallowed = new Set(profile.disallowedTools ?? []);
  if (hasAllowedSkills && !disallowed.has("Skill")) {
    baseTools.push("Skill");
  }
  return filterSubagentChildToolNames(baseTools, profile.disallowedTools);
}

