import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ModelUsage,
  PrismBashEvidenceArtifact,
  PrismHostEvidenceReceipt,
  PrismTaskAcceptanceCriterion,
  PrismTaskAcceptanceDecision,
  PrismTaskAcceptanceLineage,
  PrismTaskContract,
  SessionEntryInfo,
  RuntimeTaskTerminalCatalogRecord,
  SessionId,
  SessionEvent,
  SessionInfo,
  SubagentExecutionTerminalPayload,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import {
  BashInputSchema,
  PRISM_EVIDENCE_RECEIPT_MAX_BYTES,
  PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
  PRISM_BASH_EXIT_CODE_EVALUATOR_ID,
  PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION,
  PRISM_HOST_EVIDENCE_RECEIPT_SCHEMA,
  PRISM_TASK_CONTRACT_MAX_CRITERIA,
  PRISM_TASK_CONTRACT_MAX_CRITERION_DESCRIPTION_BYTES,
  PRISM_TASK_CONTRACT_SCHEMA,
  SESSION_ENTRY_PRISM_EVIDENCE_RECEIPT,
  SESSION_ENTRY_PRISM_TASK_CONTRACT,
  SESSION_ENTRY_PRISM_TASK_TERMINAL,
  SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
  SessionEventType,
  type AgentOutput,
} from "@zcode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** Host 为准的 spawn 配额：本任务还能再开多少个子任务；模型声明值只能在此之下收紧。 */
  spawnGrant?: number;
  /** 嵌套层级；仅记录，不参与准入判定（预算已限制树规模）。 */
  level?: number;
  /** UI may subscribe only after the child runtime has opened its session. */
  childSessionReady?: boolean;
  /** Immutable acceptance declaration owned by this admitted task attempt. */
  prismTaskContract?: PrismTaskContract;
  /** Reducer projection for the current attempt; receipts remain the durable evidence source. */
  prismAcceptance?: PrismTaskAcceptanceDecision;
  /** 内存执行归属；重启不会恢复闲时后台任务。 */
  offPeakExecutionId?: string;
  offPeakCancelled?: boolean;
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  /** 根 runtime session；子任务由唯一 registry 传播此归属。 */
  rootSessionId?: SessionId;
  /** 同一根会话内一轮 coordinator turn 的稳定配额范围。 */
  rootRunId?: string;
  /** 由唯一 registry 在每次新 admission 生成；旧 attempt 的 receipt 因此无法复用。 */
  attemptId?: string;
  /** 创建通用后台任务的 runtime session，用于按 owner 盖 branch generation。 */
  ownerSessionId?: SessionId;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
}

export const MAX_RETAINED_TERMINAL_SUBAGENT_SNAPSHOTS = 512;

export function createRuntimeTaskTerminalCatalogEntry(
  task: RuntimeTaskSnapshot,
): SessionEntryInfo | undefined {
  if (
    task.type !== "local_agent" ||
    !task.rootSessionId ||
    !task.attemptId ||
    !isTerminalRuntimeTask(task) ||
    !task.completedAt
  ) {
    return undefined;
  }
  const record: RuntimeTaskTerminalCatalogRecord = {
    schema: "zcode.runtime.task-terminal.v1",
    taskId: task.taskId,
    attemptId: task.attemptId,
    taskType: "local_agent",
    agentId: task.agentId,
    agentType: task.agentType,
    ...(task.childSessionId ? { childSessionId: task.childSessionId } : {}),
    ...(task.parentToolCallId ? { parentToolCallId: String(task.parentToolCallId) } : {}),
    ...(task.pid === undefined ? {} : { pid: task.pid }),
    status: task.status,
    description: task.description.slice(0, 4096),
    ...(task.error ? { error: task.error.slice(0, 4096) } : {}),
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    startedAt: task.startedAt.getTime(),
    completedAt: task.completedAt.getTime(),
  };
  return {
    id: `runtime-task-terminal:${task.rootSessionId}:${task.taskId}:${task.attemptId}`,
    sessionID: task.rootSessionId,
    type: SESSION_ENTRY_RUNTIME_TASK_TERMINAL,
    touchSession: false,
    time: { created: record.completedAt, updated: record.completedAt },
    data: { terminal: record },
  };
}

export function readRuntimeTaskTerminalCatalogRecord(
  entry: SessionEntryInfo,
): RuntimeTaskTerminalCatalogRecord | undefined {
  if (entry.type !== SESSION_ENTRY_RUNTIME_TASK_TERMINAL || !isRecord(entry.data)) return;
  const record = entry.data.terminal;
  if (!isRecord(record)) return;
  if (
    record.schema !== "zcode.runtime.task-terminal.v1" ||
    typeof record.taskId !== "string" ||
    record.taskId.length === 0 ||
    typeof record.attemptId !== "string" ||
    record.attemptId.length === 0 ||
    record.taskType !== "local_agent" ||
    typeof record.agentId !== "string" ||
    typeof record.agentType !== "string" ||
    record.agentId !== record.taskId ||
    typeof record.description !== "string" ||
    typeof record.status !== "string" ||
    !TERMINAL_STATUSES.has(record.status as RuntimeTaskSnapshot["status"]) ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt) ||
    typeof record.completedAt !== "number" ||
    !Number.isFinite(record.completedAt) ||
    (record.error !== undefined && typeof record.error !== "string") ||
    (record.exitCode !== undefined && typeof record.exitCode !== "number") ||
    (record.childSessionId !== undefined && typeof record.childSessionId !== "string") ||
    (record.parentToolCallId !== undefined && typeof record.parentToolCallId !== "string") ||
    (record.pid !== undefined && typeof record.pid !== "number")
  ) {
    return;
  }
  if (
    entry.id !==
    `runtime-task-terminal:${entry.sessionID}:${record.taskId}:${record.attemptId}`
  ) {
    return;
  }
  return record as unknown as RuntimeTaskTerminalCatalogRecord;
}

export function runtimeTaskSnapshotFromTerminalCatalog(
  record: RuntimeTaskTerminalCatalogRecord,
  rootSessionId: SessionId,
  outputRootDir: string,
): RuntimeTaskSnapshot {
  return {
    taskId: record.taskId,
    agentId: record.agentId,
    agentType: record.agentType,
    description: record.description,
    status: record.status,
    startedAt: new Date(record.startedAt),
    completedAt: new Date(record.completedAt),
    ...(record.childSessionId ? { childSessionId: record.childSessionId } : {}),
    ...(record.parentToolCallId ? { parentToolCallId: record.parentToolCallId } : {}),
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    ...(record.error ? { error: record.error } : {}),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    outputFile: runtimeTaskOutputFile(outputRootDir, rootSessionId, record.taskId),
    rootSessionId,
    type: "local_agent",
  };
}

export function runtimeTaskOutputFile(
  outputRootDir: string,
  rootSessionId: SessionId,
  taskId: string,
): string {
  // 修复依据：catalog 是持久化输入；路径只能由可信 root session 和 task ID 决定，不能由记录内的 owner/path 选文件。
  if (
    rootSessionId.length === 0 ||
    rootSessionId === "." ||
    rootSessionId === ".." ||
    /[\\/]/u.test(rootSessionId) ||
    taskId.length === 0 ||
    taskId === "." ||
    taskId === ".." ||
    /[\\/]/u.test(taskId)
  ) {
    throw new Error("Runtime task catalog contains an invalid task ID");
  }
  return join(outputRootDir, rootSessionId, taskId, "output.txt");
}

export interface RuntimeTaskCancellationHandle {
  abort(reason?: unknown): void;
  /** 只在底层 AgentRuntime 已经真正结束后 resolve；可带回该生命期终态快照。 */
  settled: Promise<void | RuntimeTaskSnapshot>;
}

export type RuntimeTaskAdmissionResult =
  | { accepted: true; task: RuntimeTaskSnapshot }
  | {
      accepted: false;
      reason:
        | "active_limit"
        | "root_run_budget_exceeded"
        | "spawn_budget_exhausted"
        | "lineage_conflict"
        | "owner_closed"
        | "parent_stopped"
        | "task_already_running"
        | "task_finalizing";
    };

/** Per-root-session worker ceiling: foreground children replace waiting parents; background children use another slot. */
export const SUBAGENT_ROOT_MAX_ACTIVE_TASKS = 24;

export type PrismTaskContractInput = Omit<PrismTaskContract, "schema" | "contractSha256">;

export type PrismHostEvidenceReceiptInput = Omit<
  PrismHostEvidenceReceipt,
  "schema" | "receiptId" | "issuer"
>;

/**
 * Строит hash по фиксированному порядку полей, чтобы JSON property order вызывающего кода
 * не менял identity неизменяемого acceptance-контракта.
 */
export function createPrismTaskContract(input: PrismTaskContractInput): PrismTaskContract {
  const contract = { ...input, schema: PRISM_TASK_CONTRACT_SCHEMA };
  if (!isValidPrismTaskContractBody(contract)) {
    throw new TypeError("Invalid or oversized PRISM task contract");
  }
  return {
    ...contract,
    contractSha256: hashPrismContract(contract),
  };
}

/**
 * Стабильный ключ вызова Host verifier. Helper только оформляет уже полученный результат;
 * он не запускает verifier и вызывается Host-кодом после проверки artifact.
 */
export function createPrismHostEvidenceReceipt(
  input: PrismHostEvidenceReceiptInput,
): PrismHostEvidenceReceipt {
  const receiptBase = {
    ...input,
    schema: PRISM_HOST_EVIDENCE_RECEIPT_SCHEMA,
    issuer: "host_evaluator" as const,
  };
  const receipt = {
    ...receiptBase,
    receiptId: createPrismEvidenceReceiptId(receiptBase),
  };
  if (!isValidPrismHostEvidenceReceipt(receipt)) {
    throw new TypeError("Invalid or oversized PRISM Host evidence receipt");
  }
  return receipt;
}

export function createPrismEvidenceReceiptId(
  input: Pick<
    PrismHostEvidenceReceipt,
    | "rootRunId"
    | "taskId"
    | "parentTaskId"
    | "attemptId"
    | "branchGeneration"
    | "criterionId"
    | "contractSha256"
    | "evaluatorId"
    | "evaluatorVersion"
    | "verifierInvocationId"
    | "result"
    | "artifact"
    | "observedAt"
  >,
): string {
  const identity = JSON.stringify([
    input.rootRunId,
    input.taskId,
    input.parentTaskId ?? null,
    input.attemptId,
    input.branchGeneration,
    input.criterionId,
    input.contractSha256,
    input.evaluatorId,
    input.evaluatorVersion,
    input.verifierInvocationId,
    input.result,
    input.artifact.uri,
    input.artifact.sha256,
    input.artifact.bytes,
    input.observedAt,
  ]);
  return `prism-receipt-v2-${createHash("sha256").update(identity).digest("hex")}`;
}

export function isValidPrismTaskContract(value: unknown): value is PrismTaskContract {
  if (!isRecord(value) || !isValidPrismTaskContractBody(value)) return false;
  return isSha256(value.contractSha256) && value.contractSha256 === hashPrismContract(value);
}

export function isValidPrismHostEvidenceReceipt(value: unknown): value is PrismHostEvidenceReceipt {
  if (!isRecord(value) || value.schema !== PRISM_HOST_EVIDENCE_RECEIPT_SCHEMA) return false;
  if (
    !hasOnlyKeys(value, [
      "schema",
      "receiptId",
      "issuer",
      "rootRunId",
      "taskId",
      "parentTaskId",
      "attemptId",
      "branchGeneration",
      "criterionId",
      "contractSha256",
      "evaluatorId",
      "evaluatorVersion",
      "verifierInvocationId",
      "result",
      "artifact",
      "observedAt",
    ]) ||
    value.issuer !== "host_evaluator" ||
    !isBoundedIdentifier(value.receiptId, 128) ||
    !isBoundedIdentifier(value.rootRunId, 256) ||
    !isBoundedIdentifier(value.taskId, 256) ||
    (value.parentTaskId !== undefined && !isBoundedIdentifier(value.parentTaskId, 256)) ||
    !isBoundedIdentifier(value.attemptId, 256) ||
    !isNonNegativeSafeInteger(value.branchGeneration) ||
    !isBoundedIdentifier(value.criterionId, 128) ||
    !isSha256(value.contractSha256) ||
    !isBoundedIdentifier(value.evaluatorId, 128) ||
    !isBoundedIdentifier(value.evaluatorVersion, 128) ||
    !isBoundedIdentifier(value.verifierInvocationId, 256) ||
    (value.result !== "pass" && value.result !== "fail") ||
    !isRecord(value.artifact) ||
    !hasOnlyKeys(value.artifact, ["uri", "sha256", "bytes", "evidence"]) ||
    !isBoundedText(value.artifact.uri, 2048) ||
    /[\u0000-\u001f\u007f]/u.test(value.artifact.uri) ||
    !isSha256(value.artifact.sha256) ||
    !isNonNegativeSafeInteger(value.artifact.bytes) ||
    !isValidPrismBashEvidenceArtifact(value.artifact.evidence) ||
    value.artifact.sha256 !==
      hashText(serializePrismBashEvidenceArtifact(value.artifact.evidence)) ||
    value.artifact.bytes !==
      Buffer.byteLength(serializePrismBashEvidenceArtifact(value.artifact.evidence), "utf8") ||
    value.result !== (value.artifact.evidence.exitCode === 0 ? "pass" : "fail") ||
    !isNonNegativeSafeInteger(value.observedAt)
  ) {
    return false;
  }
  const receipt = value as unknown as PrismHostEvidenceReceipt;
  return (
    receipt.receiptId === createPrismEvidenceReceiptId(receipt) &&
    utf8ByteLength(JSON.stringify(receipt)) <= PRISM_EVIDENCE_RECEIPT_MAX_BYTES
  );
}

/**
 * Pure, fail-closed reducer. Missing, malformed, worker-authored, stale, conflicting, or
 * mismatched receipts cannot satisfy a criterion. The reducer does not execute an evaluator.
 */
export function reducePrismTaskAcceptance(input: {
  contract: unknown;
  receipts: readonly unknown[];
  current: PrismTaskAcceptanceLineage;
}): PrismTaskAcceptanceDecision {
  const contract = isValidPrismTaskContract(input.contract) ? input.contract : undefined;
  if (!contract || !prismLineageMatchesContract(input.current, contract)) {
    return {
      status: "unknown",
      passedCriterionIds: [],
      failedCriterionIds: [],
      missingCriterionIds: contract?.criteria.map(({ id }) => id) ?? [],
    };
  }

  const passedCriterionIds: string[] = [];
  const failedCriterionIds: string[] = [];
  const missingCriterionIds: string[] = [];
  for (const criterion of contract.criteria) {
    const matching = input.receipts.filter((candidate): candidate is PrismHostEvidenceReceipt => {
      if (!isValidPrismHostEvidenceReceipt(candidate)) return false;
      return (
        prismLineageMatchesReceipt(input.current, candidate) &&
        candidate.contractSha256 === contract.contractSha256 &&
        candidate.criterionId === criterion.id &&
        candidate.evaluatorId === criterion.evaluatorId &&
        candidate.evaluatorVersion === criterion.evaluatorVersion &&
        isPrismReceiptForCriterion(candidate, criterion)
      );
    });
    if (matching.length === 0) {
      missingCriterionIds.push(criterion.id);
    } else if (matching.some(({ result }) => result === "fail")) {
      // Любой Host fail или конфликтующий повтор требует нового явного task attempt.
      failedCriterionIds.push(criterion.id);
    } else {
      passedCriterionIds.push(criterion.id);
    }
  }

  return {
    status:
      failedCriterionIds.length > 0
        ? "rejected"
        : missingCriterionIds.length === 0
          ? "verified"
          : "unknown",
    passedCriterionIds,
    failedCriterionIds,
    missingCriterionIds,
  };
}

/** Input for deriving an ended subagent's PRISM status from root-owned durable entries. */
export interface PrismHistoricalAcceptanceInput {
  rootSessionId: SessionId;
  rootRunId: string;
  taskId: string;
  parentTaskId?: string;
  childSessionId: SessionId;
  ownerSessionId: SessionId;
  ownerBranchGeneration: number;
  ownerSessionsById: ReadonlyMap<SessionId, SessionInfo>;
  contracts: readonly SessionEntryInfo[];
  receipts: readonly SessionEntryInfo[];
  terminals: readonly SessionEntryInfo[];
  index?: PrismHistoricalAcceptanceIndex;
}

export interface PrismHistoricalAcceptanceIndex {
  contractsByTaskId: ReadonlyMap<string, readonly SessionEntryInfo[]>;
  receiptsByLineage: ReadonlyMap<string, readonly SessionEntryInfo[]>;
  terminalTaskChildKeys: ReadonlySet<string>;
  terminalsByRootRunTaskAndChild: ReadonlyMap<
    string,
    ReadonlyArray<{
      entry: SessionEntryInfo;
      terminal: SubagentExecutionTerminalPayload;
    }>
  >;
  rawTerminalCountByTaskAndChild: ReadonlyMap<string, number>;
}

/** Builds one query-local index so a page of ended rows does not rescan all persisted history. */
export function createPrismHistoricalAcceptanceIndex(input: {
  rootSessionId: SessionId;
  contracts: readonly SessionEntryInfo[];
  receipts: readonly SessionEntryInfo[];
  terminals: readonly SessionEntryInfo[];
}): PrismHistoricalAcceptanceIndex {
  const contractsByTaskId = new Map<string, SessionEntryInfo[]>();
  for (const entry of input.contracts) {
    if (entry.type !== SESSION_ENTRY_PRISM_TASK_CONTRACT || entry.sessionID !== input.rootSessionId)
      continue;
    const taskId = nestedRecord(entry.data, "contract")?.taskId;
    if (typeof taskId !== "string") continue;
    const entries = contractsByTaskId.get(taskId) ?? [];
    entries.push(entry);
    contractsByTaskId.set(taskId, entries);
  }

  const receiptsByLineage = new Map<string, SessionEntryInfo[]>();
  for (const entry of input.receipts) {
    if (
      entry.type !== SESSION_ENTRY_PRISM_EVIDENCE_RECEIPT ||
      entry.sessionID !== input.rootSessionId
    )
      continue;
    const receipt = nestedRecord(entry.data, "receipt");
    if (
      typeof receipt?.rootRunId !== "string" ||
      typeof receipt.taskId !== "string" ||
      typeof receipt.attemptId !== "string"
    )
      continue;
    const key = JSON.stringify([receipt.rootRunId, receipt.taskId, receipt.attemptId]);
    const entries = receiptsByLineage.get(key) ?? [];
    entries.push(entry);
    receiptsByLineage.set(key, entries);
  }

  const terminalsByRootRunTaskAndChild = new Map<
    string,
    Array<{
      entry: SessionEntryInfo;
      terminal: SubagentExecutionTerminalPayload;
    }>
  >();
  const rawTerminalCountByTaskAndChild = new Map<string, number>();
  const terminalTaskChildKeys = new Set<string>();
  for (const entry of input.terminals) {
    if (entry.type !== SESSION_ENTRY_PRISM_TASK_TERMINAL || entry.sessionID !== input.rootSessionId)
      continue;
    const rawTerminal = nestedRecord(entry.data, "terminal");
    const parsed = parsePrismHistoricalTerminal(entry.data);
    if (parsed) {
      const key = JSON.stringify([parsed.rootRunId, parsed.taskId, parsed.childSessionId]);
      const entries = terminalsByRootRunTaskAndChild.get(key) ?? [];
      entries.push({ entry, terminal: parsed });
      terminalsByRootRunTaskAndChild.set(key, entries);
    }
    if (typeof rawTerminal?.taskId === "string" && typeof rawTerminal.childSessionId === "string") {
      terminalTaskChildKeys.add(JSON.stringify([rawTerminal.taskId, rawTerminal.childSessionId]));
      const key = JSON.stringify([rawTerminal.taskId, rawTerminal.childSessionId]);
      rawTerminalCountByTaskAndChild.set(key, (rawTerminalCountByTaskAndChild.get(key) ?? 0) + 1);
    }
  }
  return {
    contractsByTaskId,
    receiptsByLineage,
    terminalTaskChildKeys,
    terminalsByRootRunTaskAndChild,
    rawTerminalCountByTaskAndChild,
  };
}

/**
 * Recomputes historical acceptance for one exact transcript-linked child attempt.
 * This is a read-only projection: it never hydrates RuntimeTaskRegistry or starts work.
 */
export function projectPrismHistoricalAcceptanceForTask(
  input: PrismHistoricalAcceptanceInput,
): PrismTaskAcceptanceDecision | undefined {
  const index = input.index ?? createPrismHistoricalAcceptanceIndex(input);
  const candidateContracts = index.contractsByTaskId.get(input.taskId) ?? [];
  const candidateTerminals =
    index.terminalsByRootRunTaskAndChild.get(
      JSON.stringify([input.rootRunId, input.taskId, input.childSessionId]),
    ) ?? [];
  const childTerminals = candidateTerminals;
  const rawRelatedTerminalCount =
    index.rawTerminalCountByTaskAndChild.get(
      JSON.stringify([input.taskId, input.childSessionId]),
    ) ?? 0;
  const related =
    candidateContracts.length > 0 || childTerminals.length > 0 || rawRelatedTerminalCount > 0;
  if (!related) return undefined;

  const current: PrismTaskAcceptanceLineage = {
    rootRunId: input.rootRunId,
    taskId: input.taskId,
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    attemptId: "historical-unknown",
    branchGeneration: input.ownerBranchGeneration,
  };
  const unknown = (contract?: PrismTaskContract): PrismTaskAcceptanceDecision => ({
    status: "unknown",
    passedCriterionIds: [],
    failedCriterionIds: [],
    missingCriterionIds: contract?.criteria.map(({ id }) => id) ?? [],
  });

  const matchingTerminals = childTerminals.filter(
    ({ terminal }) =>
      terminal.rootRunId === input.rootRunId && terminal.parentTaskId === input.parentTaskId,
  );
  // A damaged duplicate for the same child attempt must not be hidden by a valid sibling row.
  // Conflicting valid lineage keys are equally ambiguous and must fail closed.
  if (
    matchingTerminals.length !== 1 ||
    childTerminals.length !== 1 ||
    rawRelatedTerminalCount !== childTerminals.length
  ) {
    const possibleContracts = candidateContracts.flatMap((entry) => {
      const contract = nestedRecord(entry.data, "contract");
      return isValidPrismTaskContract(contract) &&
        contract.rootRunId === input.rootRunId &&
        contract.parentTaskId === input.parentTaskId &&
        contract.branchGeneration === input.ownerBranchGeneration
        ? [contract]
        : [];
    });
    return possibleContracts.length === 1 ? unknown(possibleContracts[0]) : unknown();
  }
  const { entry: terminalEntry, terminal } = matchingTerminals[0]!;
  const expectedTerminalEntryId = `prism-task-terminal:${input.rootSessionId}:${terminal.terminalId}`;
  const owner = input.ownerSessionsById.get(input.ownerSessionId);
  const child = input.ownerSessionsById.get(input.childSessionId);
  // 修复依据：completed terminal 必须同时证明 Host 启动过 child；否则生命周期记录自相矛盾。
  if (
    terminalEntry.id !== expectedTerminalEntryId ||
    terminal.taskId !== input.taskId ||
    terminal.rootRunId !== input.rootRunId ||
    terminal.parentTaskId !== input.parentTaskId ||
    terminal.branchGeneration !== input.ownerBranchGeneration ||
    terminal.childSessionId !== input.childSessionId ||
    terminal.terminalStatus !== "completed" ||
    terminal.childStarted !== true ||
    !owner ||
    !child ||
    child.parentID !== owner.id ||
    owner.id !== input.ownerSessionId ||
    (owner.revert?.branchGeneration ?? 0) !== input.ownerBranchGeneration ||
    !hasCurrentPrismTerminalOwnerChain({
      rootSessionId: input.rootSessionId,
      rootRunId: input.rootRunId,
      terminalEntry,
      terminal,
      terminalsByRootRunTaskAndChild: index.terminalsByRootRunTaskAndChild,
      rawTerminalCountByTaskAndChild: index.rawTerminalCountByTaskAndChild,
      ownerSessionsById: input.ownerSessionsById,
    })
  ) {
    return unknown();
  }

  const matchingContracts = candidateContracts.filter((entry) => {
    const contract = nestedRecord(entry.data, "contract");
    return (
      contract?.rootRunId === terminal.rootRunId &&
      contract.taskId === terminal.taskId &&
      contract.attemptId === terminal.attemptId
    );
  });
  if (matchingContracts.length !== 1) return unknown();
  const contractEntry = matchingContracts[0]!;
  const rawContract = nestedRecord(contractEntry.data, "contract");
  if (
    contractEntry.id !==
      `prism-task-contract:${input.rootSessionId}:${terminal.rootRunId}:${terminal.taskId}:${terminal.attemptId}` ||
    !isValidPrismTaskContract(rawContract) ||
    rawContract.rootRunId !== input.rootRunId ||
    rawContract.taskId !== input.taskId ||
    rawContract.attemptId !== terminal.attemptId ||
    rawContract.parentTaskId !== input.parentTaskId ||
    rawContract.branchGeneration !== input.ownerBranchGeneration
  ) {
    return unknown();
  }
  const contract = rawContract;
  current.attemptId = contract.attemptId;

  const relatedReceipts =
    index.receiptsByLineage.get(
      JSON.stringify([input.rootRunId, input.taskId, terminal.attemptId]),
    ) ?? [];
  const receipts: PrismHostEvidenceReceipt[] = [];
  for (const entry of relatedReceipts) {
    const receipt = nestedRecord(entry.data, "receipt");
    if (
      !isValidPrismHostEvidenceReceipt(receipt) ||
      entry.id !== `prism-evidence-receipt:${input.rootSessionId}:${receipt.receiptId}` ||
      receipt.parentTaskId !== input.parentTaskId ||
      receipt.branchGeneration !== input.ownerBranchGeneration ||
      receipt.artifact.evidence.childSessionId !== input.childSessionId
    ) {
      return unknown(contract);
    }
    receipts.push(receipt);
  }

  const decision = reducePrismTaskAcceptance({ contract, receipts, current });
  if (decision.status !== terminal.acceptanceStatus) return unknown(contract);
  return decision;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

/** SQLite restores Date payloads as ISO strings, so the projection accepts both forms. */
function parsePrismHistoricalTerminal(
  value: unknown,
): SubagentExecutionTerminalPayload | undefined {
  const terminal = nestedRecord(value, "terminal");
  if (
    !terminal ||
    !hasOnlyKeys(terminal, [
      "schema",
      "terminalId",
      "rootRunId",
      "taskId",
      "attemptId",
      "parentTaskId",
      "branchGeneration",
      "childSessionId",
      "childStarted",
      "terminalStatus",
      "provenance",
      "acceptanceStatus",
      "observedAt",
    ])
  )
    return undefined;
  const observedAt =
    terminal.observedAt instanceof Date
      ? terminal.observedAt
      : typeof terminal.observedAt === "string"
        ? new Date(terminal.observedAt)
        : undefined;
  const terminalStatus = terminal.terminalStatus;
  if (
    terminal.schema !== "zcode.prism.subagent-terminal.v3" ||
    !isBoundedIdentifier(terminal.terminalId, 1024) ||
    !isBoundedIdentifier(terminal.rootRunId, 256) ||
    !isBoundedIdentifier(terminal.taskId, 256) ||
    !isBoundedIdentifier(terminal.attemptId, 256) ||
    (terminal.parentTaskId !== undefined && !isBoundedIdentifier(terminal.parentTaskId, 256)) ||
    !isNonNegativeSafeInteger(terminal.branchGeneration) ||
    !isBoundedIdentifier(terminal.childSessionId, 256) ||
    typeof terminal.childStarted !== "boolean" ||
    (terminalStatus !== "completed" &&
      terminalStatus !== "failed" &&
      terminalStatus !== "cancelled" &&
      terminalStatus !== "killed" &&
      terminalStatus !== "stopped" &&
      terminalStatus !== "lost") ||
    terminal.provenance !== "runtime_lifecycle" ||
    (terminal.acceptanceStatus !== "unknown" &&
      terminal.acceptanceStatus !== "verified" &&
      terminal.acceptanceStatus !== "rejected") ||
    !observedAt ||
    !Number.isFinite(observedAt.getTime())
  ) {
    return undefined;
  }
  return {
    schema: "zcode.prism.subagent-terminal.v3",
    terminalId: terminal.terminalId,
    rootRunId: terminal.rootRunId,
    taskId: terminal.taskId,
    attemptId: terminal.attemptId,
    ...(terminal.parentTaskId !== undefined ? { parentTaskId: terminal.parentTaskId } : {}),
    branchGeneration: terminal.branchGeneration,
    childSessionId: terminal.childSessionId as SessionId,
    childStarted: terminal.childStarted,
    terminalStatus,
    provenance: "runtime_lifecycle",
    acceptanceStatus: terminal.acceptanceStatus,
    observedAt,
  };
}

/**
 * Walks the durable parent-task chain without reviving runtime tasks. Each edge must have one
 * completed, session-linked terminal; only the leaf requires PRISM acceptance criteria.
 */
function hasCurrentPrismTerminalOwnerChain(input: {
  rootSessionId: SessionId;
  rootRunId: string;
  terminalEntry: SessionEntryInfo;
  terminal: SubagentExecutionTerminalPayload;
  terminalsByRootRunTaskAndChild: PrismHistoricalAcceptanceIndex["terminalsByRootRunTaskAndChild"];
  rawTerminalCountByTaskAndChild: PrismHistoricalAcceptanceIndex["rawTerminalCountByTaskAndChild"];
  ownerSessionsById: ReadonlyMap<SessionId, SessionInfo>;
}): boolean {
  let terminal = input.terminal;
  let terminalEntry = input.terminalEntry;
  let childSessionId = terminal.childSessionId;
  const visitedTaskIds = new Set<string>();
  while (true) {
    if (
      terminalEntry.type !== SESSION_ENTRY_PRISM_TASK_TERMINAL ||
      terminalEntry.sessionID !== input.rootSessionId ||
      terminalEntry.id !== `prism-task-terminal:${input.rootSessionId}:${terminal.terminalId}` ||
      terminal.rootRunId !== input.rootRunId ||
      terminal.terminalId !==
        `${terminal.rootRunId}/${terminal.taskId}/${terminal.branchGeneration}/${terminal.attemptId}` ||
      terminal.terminalStatus !== "completed" ||
      terminal.childStarted !== true ||
      visitedTaskIds.has(terminal.taskId)
    )
      return false;
    visitedTaskIds.add(terminal.taskId);

    const child = input.ownerSessionsById.get(childSessionId);
    if (!child || child.taskType !== "subagent_child" || !child.parentID) return false;
    const owner = input.ownerSessionsById.get(child.parentID);
    if (!owner || (owner.revert?.branchGeneration ?? 0) !== terminal.branchGeneration) return false;
    if (terminal.parentTaskId === undefined) {
      return owner.id === input.rootSessionId && owner.taskType !== "subagent_child";
    }

    const parentTerminals =
      input.terminalsByRootRunTaskAndChild.get(
        JSON.stringify([input.rootRunId, terminal.parentTaskId, owner.id]),
      ) ?? [];
    const rawParentTerminalCount =
      input.rawTerminalCountByTaskAndChild.get(JSON.stringify([terminal.parentTaskId, owner.id])) ??
      0;
    // 修复依据：祖先边按 task/child 对照原始日志，不能让格式损坏或 rootRun 不同的重复记录躲过索引。
    if (parentTerminals.length !== 1 || rawParentTerminalCount !== parentTerminals.length)
      return false;
    terminalEntry = parentTerminals[0]!.entry;
    terminal = parentTerminals[0]!.terminal;
    childSessionId = owner.id;
  }
}

export interface PrismTaskEvaluation {
  decision: PrismTaskAcceptanceDecision;
  receipts: PrismHostEvidenceReceipt[];
}

/**
 * Evaluates only exact Bash invocations and Host-stamped process outcomes.
 * Missing, ambiguous, backgrounded, or malformed evidence stays unknown.
 */
export function evaluatePrismTaskAcceptance(input: {
  contract: PrismTaskContract | undefined;
  current: PrismTaskAcceptanceLineage;
  childSessionId: SessionId;
  events: readonly SessionEvent[];
  observedAt?: number;
}): PrismTaskEvaluation {
  const contract = input.contract;
  if (!contract) {
    return {
      decision: {
        status: "unknown",
        passedCriterionIds: [],
        failedCriterionIds: [],
        missingCriterionIds: [],
      },
      receipts: [],
    };
  }

  const observedAt = input.observedAt ?? Date.now();
  const receipts = contract.criteria.flatMap((criterion) => {
    const receipt = evaluateBashCriterion({
      criterion,
      contract,
      current: input.current,
      childSessionId: input.childSessionId,
      events: input.events,
      observedAt,
    });
    return receipt ? [receipt] : [];
  });
  return {
    decision: reducePrismTaskAcceptance({
      contract,
      receipts,
      current: input.current,
    }),
    receipts,
  };
}

function evaluateBashCriterion(input: {
  criterion: PrismTaskContract["criteria"][number];
  contract: PrismTaskContract;
  current: PrismTaskAcceptanceLineage;
  childSessionId: SessionId;
  events: readonly SessionEvent[];
  observedAt: number;
}): PrismHostEvidenceReceipt | undefined {
  const { criterion } = input;
  if (
    criterion.evaluatorId !== PRISM_BASH_EXIT_CODE_EVALUATOR_ID ||
    criterion.evaluatorVersion !== PRISM_BASH_EXIT_CODE_EVALUATOR_VERSION ||
    criterion.check.kind !== "bash_exit_code" ||
    criterion.check.expectedExitCode !== 0
  ) {
    return undefined;
  }

  const expectedCommandHash = criterion.check.commandSha256;
  const matchingSchedules = input.events
    .filter((event) => {
      if (
        event.sessionId !== input.childSessionId ||
        event.type !== SessionEventType.ToolCallScheduled
      ) {
        return false;
      }
      if (!isRecord(event.payload)) return false;
      const payload = event.payload;
      if (payload.toolName !== "Bash" || typeof payload.toolCallId !== "string") return false;
      const parsedInput = BashInputSchema.safeParse(payload.input);
      return parsedInput.success && hashText(parsedInput.data.command) === expectedCommandHash;
    })
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  const latestSchedule = matchingSchedules.at(-1);
  if (!latestSchedule || !isRecord(latestSchedule.payload)) return undefined;

  const toolCallId = latestSchedule.payload.toolCallId;
  if (typeof toolCallId !== "string") return undefined;
  // 修复依据：事件只按 toolCallId 关联；复用 ID 或重复 sequence 会让旧结果冒充新执行。
  if (
    matchingSchedules.some((event) => !isPositiveSafeSequence(event.sequenceNumber)) ||
    new Set(matchingSchedules.map(({ sequenceNumber }) => sequenceNumber)).size !==
      matchingSchedules.length
  ) {
    return undefined;
  }
  const matchingInvocationSchedules = input.events.filter((event) => {
    if (
      event.sessionId !== input.childSessionId ||
      event.type !== SessionEventType.ToolCallScheduled ||
      (latestSchedule.turnId !== undefined && event.turnId !== latestSchedule.turnId)
    ) {
      return false;
    }
    return isRecord(event.payload) && event.payload.toolCallId === toolCallId;
  });
  // 原因：同一轮重复 toolCallId 无法区分并发执行；缺少 turnId 时必须检查整个 session。
  // 主机目前没有独立的 invocation ID，因此无法消除歧义时必须返回 unknown。
  if (matchingInvocationSchedules.length !== 1) return undefined;
  // 仅接受此次调度后追加的结果，避免复用旧的成功事件。
  const matchingResults = input.events.filter((event) => {
    if (
      event.sessionId !== input.childSessionId ||
      event.type !== SessionEventType.ToolCallResult ||
      event.turnId !== latestSchedule.turnId ||
      !isPositiveSafeSequence(event.sequenceNumber) ||
      event.sequenceNumber <= latestSchedule.sequenceNumber
    ) {
      return false;
    }
    return isRecord(event.payload) && event.payload.toolCallId === toolCallId;
  });
  if (matchingResults.length !== 1) return undefined;

  const resultEvent = matchingResults[0];
  if (!isRecord(resultEvent.payload) || !isRecord(resultEvent.payload.result)) return undefined;
  const result = resultEvent.payload.result;
  if (!isRecord(result.executionEvidence)) return undefined;
  const evidence = result.executionEvidence;
  if (
    result.success !== true ||
    evidence.kind !== "bash_process" ||
    evidence.commandSha256 !== expectedCommandHash ||
    evidence.status !== "completed" ||
    typeof evidence.exitCode !== "number" ||
    !Number.isInteger(evidence.exitCode) ||
    evidence.timedOut === true ||
    evidence.cancelled === true ||
    evidence.signal !== undefined
  ) {
    return undefined;
  }

  // 原因：child event store 是进程内存实现；receipt 必须内嵌有界快照才能在重启后复核。
  const artifactEvidence: PrismBashEvidenceArtifact = {
    schema: PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA,
    childSessionId: input.childSessionId,
    commandSha256: expectedCommandHash,
    resultEventId: resultEvent.id,
    resultSequence: resultEvent.sequenceNumber,
    scheduledEventId: latestSchedule.id,
    scheduledSequence: latestSchedule.sequenceNumber,
    status: "completed",
    exitCode: evidence.exitCode,
    toolCallId,
    ...(latestSchedule.turnId === undefined ? {} : { turnId: latestSchedule.turnId }),
  };
  const serializedArtifact = serializePrismBashEvidenceArtifact(artifactEvidence);
  return createPrismHostEvidenceReceipt({
    rootRunId: input.current.rootRunId,
    taskId: input.current.taskId,
    ...(input.current.parentTaskId === undefined
      ? {}
      : { parentTaskId: input.current.parentTaskId }),
    attemptId: input.current.attemptId,
    branchGeneration: input.current.branchGeneration,
    criterionId: criterion.id,
    contractSha256: input.contract.contractSha256,
    evaluatorId: criterion.evaluatorId,
    evaluatorVersion: criterion.evaluatorVersion,
    verifierInvocationId: randomUUID(),
    result: evidence.exitCode === criterion.check.expectedExitCode ? "pass" : "fail",
    artifact: {
      uri: `zcode-session-event://${encodeURIComponent(input.childSessionId)}/${encodeURIComponent(resultEvent.id)}`,
      sha256: hashText(serializedArtifact),
      bytes: Buffer.byteLength(serializedArtifact, "utf8"),
      evidence: artifactEvidence,
    },
    observedAt: input.observedAt,
  });
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPositiveSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function isPrismReceiptForCriterion(
  receipt: PrismHostEvidenceReceipt,
  criterion: PrismTaskAcceptanceCriterion,
): boolean {
  if (criterion.check.kind !== "bash_exit_code" || criterion.check.expectedExitCode !== 0) {
    return false;
  }
  return (
    receipt.artifact.evidence.commandSha256 === criterion.check.commandSha256 &&
    receipt.result ===
      (receipt.artifact.evidence.exitCode === criterion.check.expectedExitCode ? "pass" : "fail")
  );
}

function isValidPrismBashEvidenceArtifact(value: unknown): value is PrismBashEvidenceArtifact {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "schema",
      "childSessionId",
      "commandSha256",
      "scheduledEventId",
      "scheduledSequence",
      "resultEventId",
      "resultSequence",
      "toolCallId",
      "turnId",
      "status",
      "exitCode",
    ]) &&
    value.schema === PRISM_BASH_EVIDENCE_ARTIFACT_SCHEMA &&
    isBoundedIdentifier(value.childSessionId, 256) &&
    isSha256(value.commandSha256) &&
    isBoundedIdentifier(value.scheduledEventId, 256) &&
    isPositiveSafeSequence(value.scheduledSequence) &&
    isBoundedIdentifier(value.resultEventId, 256) &&
    isPositiveSafeSequence(value.resultSequence) &&
    value.resultSequence > value.scheduledSequence &&
    isBoundedIdentifier(value.toolCallId, 256) &&
    (value.turnId === undefined || isBoundedIdentifier(value.turnId, 256)) &&
    value.status === "completed" &&
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode)
  );
}

function serializePrismBashEvidenceArtifact(value: PrismBashEvidenceArtifact): string {
  return JSON.stringify([
    value.schema,
    value.childSessionId,
    value.commandSha256,
    value.scheduledEventId,
    value.scheduledSequence,
    value.resultEventId,
    value.resultSequence,
    value.toolCallId,
    value.turnId ?? null,
    value.status,
    value.exitCode,
  ]);
}

function prismLineageMatchesContract(
  current: PrismTaskAcceptanceLineage,
  contract: PrismTaskContract,
): boolean {
  return (
    current.rootRunId === contract.rootRunId &&
    current.taskId === contract.taskId &&
    current.parentTaskId === contract.parentTaskId &&
    current.attemptId === contract.attemptId &&
    current.branchGeneration === contract.branchGeneration
  );
}

function prismLineageMatchesReceipt(
  current: PrismTaskAcceptanceLineage,
  receipt: PrismHostEvidenceReceipt,
): boolean {
  return (
    current.rootRunId === receipt.rootRunId &&
    current.taskId === receipt.taskId &&
    current.parentTaskId === receipt.parentTaskId &&
    current.attemptId === receipt.attemptId &&
    current.branchGeneration === receipt.branchGeneration
  );
}

function isValidPrismTaskContractBody(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Omit<PrismTaskContract, "contractSha256"> {
  if (
    !hasOnlyKeys(value, [
      "schema",
      "rootRunId",
      "taskId",
      "parentTaskId",
      "attemptId",
      "branchGeneration",
      "description",
      "criteria",
      "contractSha256",
    ]) ||
    value.schema !== PRISM_TASK_CONTRACT_SCHEMA ||
    !isBoundedIdentifier(value.rootRunId, 256) ||
    !isBoundedIdentifier(value.taskId, 256) ||
    (value.parentTaskId !== undefined && !isBoundedIdentifier(value.parentTaskId, 256)) ||
    !isBoundedIdentifier(value.attemptId, 256) ||
    !isNonNegativeSafeInteger(value.branchGeneration) ||
    !isBoundedText(value.description, 1000) ||
    !Array.isArray(value.criteria) ||
    value.criteria.length === 0 ||
    value.criteria.length > PRISM_TASK_CONTRACT_MAX_CRITERIA
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of value.criteria) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["id", "description", "evaluatorId", "evaluatorVersion", "check"]) ||
      !isBoundedIdentifier(candidate.id, 128) ||
      ids.has(candidate.id) ||
      !isBoundedText(candidate.description, PRISM_TASK_CONTRACT_MAX_CRITERION_DESCRIPTION_BYTES) ||
      !isBoundedIdentifier(candidate.evaluatorId, 128) ||
      !isBoundedIdentifier(candidate.evaluatorVersion, 128) ||
      !isRecord(candidate.check) ||
      !hasOnlyKeys(candidate.check, ["kind", "commandSha256", "expectedExitCode"]) ||
      candidate.check.kind !== "bash_exit_code" ||
      !isSha256(candidate.check.commandSha256) ||
      candidate.check.expectedExitCode !== 0
    ) {
      return false;
    }
    ids.add(candidate.id);
  }
  return utf8ByteLength(JSON.stringify(value)) <= PRISM_EVIDENCE_RECEIPT_MAX_BYTES;
}

function hashPrismContract(
  contract: Pick<
    PrismTaskContract,
    | "schema"
    | "rootRunId"
    | "taskId"
    | "parentTaskId"
    | "attemptId"
    | "branchGeneration"
    | "description"
    | "criteria"
  >,
): string {
  const canonical = JSON.stringify([
    contract.schema,
    contract.rootRunId,
    contract.taskId,
    contract.parentTaskId ?? null,
    contract.attemptId,
    contract.branchGeneration,
    contract.description,
    contract.criteria.map((criterion) => [
      criterion.id,
      criterion.description,
      criterion.evaluatorId,
      criterion.evaluatorVersion,
      criterion.check.kind,
      criterion.check.commandSha256,
      criterion.check.expectedExitCode,
    ]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedIdentifier(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    utf8ByteLength(value) <= maxBytes
  );
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    utf8ByteLength(value) <= maxBytes
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

type RootRunBudgetExhaustionReason = "deadline" | "token_limit";

export interface RuntimeTaskRegistry {
  subscribe?(listener: () => void): () => void;
  setOffPeakExecutionId?(executionId: string | undefined): void;
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  isTerminalTaskArchived?(taskId: string, attemptId: string): boolean;
  markTerminalTaskArchived?(taskId: string, attemptId: string): void;
  getSubagentTaskByChildSession(sessionId: SessionId): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  registerSubagentTask(
    task: RuntimeTaskSnapshot,
    cancellation: RuntimeTaskCancellationHandle,
  ): RuntimeTaskAdmissionResult;
  releaseSubagentCancellationHandle(
    taskId: string,
    cancellation: RuntimeTaskCancellationHandle,
  ): void;
  cancelSubagentSubtree(taskId: string, reason?: unknown): Promise<RuntimeTaskSnapshot | undefined>;
  beginSubagentTaskFinalization(taskId: string): boolean;
  isSubagentTaskFinalizing(taskId: string): boolean;
  cancelSubagentChildren(parentSessionId: SessionId, reason?: unknown): Promise<void>;
  openSessionOwner(sessionId: SessionId): void;
  getRootSessionIdForSession(sessionId: SessionId): SessionId;
  getRootRunIdForSession(sessionId: SessionId, turnId?: TurnId): string | undefined;
  getBranchGenerationForSession(sessionId: SessionId): number;
  setBranchGenerationForSession(sessionId: SessionId, generation: number): void;
  remove(id: string): void;
  /** Returns false without changing state when backgrounding would exceed the root-session worker quota. */
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  // Исправление: optional hooks могли молча отключить budget; интерфейс теперь требует весь lifecycle.
  beginRootRunBudget(input: {
    rootRunId: string;
    rootSessionId: SessionId;
    turnId: TurnId;
    startedAt?: number;
    deadlineMs?: number;
    tokenLimit?: number;
    spawnBudget?: number;
    onExhausted?: (reason: RootRunBudgetExhaustionReason) => void;
  }): void;
  reserveRootRunTokens(input: {
    rootRunId: string;
    sessionId: SessionId;
    contextWindow: number;
    maxTokens: number;
  }): RootRunReservationRelease;
  recordRootRunUsage(event: SessionEvent): void;
  finishRootRunTurn(rootRunId: string): void;
  shouldEnforceRootRunBudget(rootRunId: string, sessionId: SessionId): boolean;
  waitForRootRunCancellation(rootRunId: string): Promise<void>;
}

interface RootRunBudgetState {
  rootRunId: string;
  deadlineAt: number;
  rootSessionId: SessionId;
  turnId: TurnId;
  tokenLimit: number;
  /** 本次 root run 的 spawn 总配额；0 表示禁止任何子任务。 */
  spawnBudget: number;
  /** 已准入的子任务数量（无论后续成败）。 */
  spawnsUsed: number;
  /** 每个 session 当前可继续 spawn 的次数；缺省回落到 spawnBudget。 */
  remainingSpawnsBySession: Map<SessionId, number>;
  usedTokens: number;
  reservedTokens: number;
  activeReservationsBySession: Map<SessionId, RootRunReservation[]>;
  seenUsageEvents: Set<string>;
  turnFinished: boolean;
  expired: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  onExhausted?: (reason: RootRunBudgetExhaustionReason) => void;
  cancellationPromise?: Promise<void>;
}

interface RootRunReservation {
  reservedTokens: number;
  consumed: boolean;
  requestId?: string;
  /** release() 已归还 admission 额度；entry 仍留到终态事件结算，结算时不再重复扣减。 */
  released?: boolean;
}

export type RootRunReservationRelease = (() => void) & {
  associateRequestId(requestId: string): void;
};

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

/**
 * 缺省 root-run token 预算（一轮用户请求 + 它派生的整棵子 Agent 树）。
 *
 * 依据：3.17.57 实机复现中，单次 `/start` 的 swarm 轮次诚实消耗了 515_621 token
 * （input 507_730 + output 7_891；cache_read 不计入预算），旧缺省 500_000 因此必然在
 * 轮次中途诚实耗尽并 TURN_CANCELLED，看起来像“未完成的请求被误杀”。
 *
 * 提到 1_000_000 是为了容纳一次完整的 root + 子 Agent 树的正常用量；同时保留硬上限作为
 * 死循环/失控 Agent 的熔断器 —— 不要改成 Infinity，也不要用超时替代它。
 */
export const DEFAULT_ROOT_RUN_TOKEN_LIMIT = 1_000_000;
/**
 * 每棵子 Agent 树默认允许的 spawn 次数。
 * 32 足以覆盖常见的分层探索，同时把「模型递归开 Agent」的扇出从指数压到可控范围：
 * 每次准入至少消耗 1 个配额，配额耗尽即拒绝，不需要额外的硬深度上限。
 */
export const DEFAULT_SPAWN_BUDGET = 32;

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private offPeakExecutionId: string | undefined;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setOffPeakExecutionId(executionId: string | undefined): void {
    this.offPeakExecutionId = executionId;
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private activeBranchGeneration = 0;
  private readonly branchGenerations = new Map<SessionId, number>();
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly cancellationHandles = new Map<string, RuntimeTaskCancellationHandle>();
  private readonly finalizingSubagentTasks = new Map<
    string,
    RuntimeTaskCancellationHandle | undefined
  >();
  private readonly closedSessionOwners = new Set<SessionId>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalSubagentTaskIds = new Set<string>();
  private readonly archivedTerminalTaskAttempts = new Set<string>();
  private readonly subagentTaskIdByChildSession = new Map<SessionId, string>();
  private readonly subagentTaskIdsByParentSession = new Map<SessionId, Set<string>>();
  private readonly activeSubagentTaskIdsByRootSession = new Map<SessionId, Set<string>>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly rootRunBudgets = new Map<string, RootRunBudgetState>();

  beginRootRunBudget(input: {
    rootRunId: string;
    rootSessionId: SessionId;
    turnId: TurnId;
    startedAt?: number;
    deadlineMs?: number;
    tokenLimit?: number;
    spawnBudget?: number;
    onExhausted?: (reason: RootRunBudgetExhaustionReason) => void;
  }): void {
    if (this.rootRunBudgets.has(input.rootRunId)) return;
    const deadlineAt = (input.startedAt ?? Date.now()) + (input.deadlineMs ?? 2 * 60 * 60 * 1000);
    this.rootRunBudgets.set(input.rootRunId, {
      rootRunId: input.rootRunId,
      deadlineAt,
      rootSessionId: input.rootSessionId,
      turnId: input.turnId,
      tokenLimit: input.tokenLimit ?? DEFAULT_ROOT_RUN_TOKEN_LIMIT,
      spawnBudget: input.spawnBudget ?? DEFAULT_SPAWN_BUDGET,
      spawnsUsed: 0,
      remainingSpawnsBySession: new Map(),
      usedTokens: 0,
      reservedTokens: 0,
      activeReservationsBySession: new Map(),
      seenUsageEvents: new Set(),
      turnFinished: false,
      expired: false,
      onExhausted: input.onExhausted,
    });
    const state = this.rootRunBudgets.get(input.rootRunId)!;
    state.deadlineTimer = setTimeout(() => {
      if (!this.rootRunBudgets.has(input.rootRunId)) return;
      this.expireRootRunBudget(state, "deadline");
    }, Math.max(0, deadlineAt - Date.now()));
    state.deadlineTimer.unref?.();
  }

  reserveRootRunTokens(input: {
    rootRunId: string;
    sessionId: SessionId;
    contextWindow: number;
    maxTokens: number;
  }): RootRunReservationRelease {
    const state = this.rootRunBudgets.get(input.rootRunId);
    // 根因：把模型声明的最大 contextWindow 当成每个并发请求的实际费用预留，
    // 两个 200k 窗口就能耗尽 500k root-run budget，导致普通双 Agent 任务拒绝子请求。
    // 修复依据：上限只对 provider 实际 usage 结算；admission 暂按该请求的输出 token 上限预留。
    const requestedReservation = input.maxTokens;
    if (state && Date.now() >= state.deadlineAt) {
      this.expireRootRunBudget(state, "deadline");
    }
    if (
      !state ||
      state.expired ||
      !Number.isSafeInteger(requestedReservation) ||
      requestedReservation <= 0
    ) {
      throw new RootRunBudgetExceededError(input.rootRunId);
    }
    const remaining = state.tokenLimit - state.usedTokens - state.reservedTokens;
    if (remaining <= 0) {
      // Резерв другого запроса временно занимает остаток; это отказ admission, а не исчерпание фактического бюджета.
      throw new RootRunBudgetExceededError(input.rootRunId);
    }
    // Если остаток меньше разрешённого output budget, request получает только доступный резерв.
    const reservation = Math.min(requestedReservation, remaining);
    state.reservedTokens += reservation;
    const reservations = state.activeReservationsBySession.get(input.sessionId) ?? [];
    const entry: RootRunReservation = { reservedTokens: reservation, consumed: false };
    reservations.push(entry);
    state.activeReservationsBySession.set(input.sessionId, reservations);
    let released = false;
    const release = (() => {
      if (released) return;
      released = true;
      const current = state.activeReservationsBySession.get(input.sessionId) ?? [];
      // 根因：adapter 在 attempt 结束（含重试退避）时调用 release，而终态事件是异步持久化的，
      // 落库时可能晚于 release。旧实现无条件把 entry 从列表里删掉，事件到达后便匹配不到预留，
      // 退化成按整个 tokenLimit 扣账 —— 一次 502 就耗尽预算、取消整轮（UI 显示 Stopped）。
      // 修复依据：已关联 requestId 且未被消费的预留必须留到终态事件结算；无 requestId 的永远匹配不到，直接删。
      if (entry.consumed || !entry.requestId) {
        const index = current.indexOf(entry);
        if (index >= 0) current.splice(index, 1);
      }
      if (current.length === 0) state.activeReservationsBySession.delete(input.sessionId);
      else state.activeReservationsBySession.set(input.sessionId, current);
      if (!entry.consumed) {
        // 释放后不占用 admission 额度，但要记住已释放，避免结算时重复扣减 reservedTokens。
        entry.released = true;
        state.reservedTokens = Math.max(0, state.reservedTokens - reservation);
      }
    }) as RootRunReservationRelease;
    release.associateRequestId = (requestId: string) => {
      if (requestId.trim()) entry.requestId = requestId;
    };
    return release;
  }

  /**
   * 归还某次 attempt 的 token 预留并把它从 active 列表移除。
   * allowUnassociated：终态事件可能在 requestId 关联之前到达（connect 阶段就失败），
   * 这种情况下只能借用同 session 内尚未关联的预留兜底。可重试失败不做这个兜底，
   * 因为并发请求的未关联预留可能属于另一个仍在进行的请求。
   */
  private settleRootRunReservation(
    state: RootRunBudgetState,
    sessionId: SessionId,
    requestId: string | undefined,
    allowUnassociated: boolean,
  ): RootRunReservation | undefined {
    const pending = state.activeReservationsBySession.get(sessionId);
    let reservation = requestId
      ? pending?.find((item) => !item.consumed && item.requestId === requestId)
      : undefined;
    if (!reservation && allowUnassociated) {
      reservation = pending?.find((item) => !item.consumed && item.requestId === undefined);
    }
    if (!reservation) return undefined;
    reservation.consumed = true;
    // 已 released 的预留早前已归还额度，这里只结算用量，避免重复扣减。
    if (!reservation.released) {
      state.reservedTokens = Math.max(0, state.reservedTokens - reservation.reservedTokens);
    }
    const reservations = pending ?? [];
    const index = reservations.indexOf(reservation);
    if (index >= 0) reservations.splice(index, 1);
    if (reservations.length === 0) state.activeReservationsBySession.delete(sessionId);
    return reservation;
  }

  recordRootRunUsage(event: SessionEvent): void {
    const state = this.findRootRunBudgetForEvent(event);
    if (!state) return;
    const key = JSON.stringify([state.rootRunId, event.sessionId, event.id]);
    if (state.seenUsageEvents.has(key)) return;
    const usage = extractProviderUsage(event);
    if (!isRootRunUsageEvent(event)) {
      // 可重试失败不是请求终点，因此不按终态结算 reservation。
      // 但 provider 已经报告的部分用量是事实，必须记账：旧实现直接 return，
      // 重试期间的真实花费被整段漏记（fail-open 少记），预算反而永远打不满。
      if (!isRootRunRetryableFailure(event)) return;
      // 根因：可重试失败的 attempt 不会再有终态事件，它的 reservation 永远无人结算。
      // adapter 每次重试都会重新申请一份 maxTokens（deepseek-v4.1-flash-1017 为 384k），
      // 500k 的 root-run 预算在第三次 admission 就被占满（384k + min(384k, 116k)），
      // 请求还没发出就抛 Root run resource budget is exhausted —— 表现为模型请求失败但没有 HTTP 状态。
      // 修复依据：可重试失败就是该 attempt 的终点，按 requestId 精确归还它的预留；部分用量仍照常记账。
      this.settleRootRunReservation(state, event.sessionId, getRootRunUsageRequestId(event), false);
      if (!usage || usage.totalTokens <= 0) {
        this.changed();
        return;
      }
      state.seenUsageEvents.add(key);
      state.usedTokens += usage.totalTokens;
      if (state.usedTokens >= state.tokenLimit) {
        this.expireRootRunBudget(state, "token_limit");
      }
      this.changed();
      return;
    }
    state.seenUsageEvents.add(key);
    const requestId = getRootRunUsageRequestId(event);
    // 根因：失败 attempt 的终态事件可能早于 requestId 关联（provider 在 connect 阶段就失败，
    // 或 admission 票据尚未 publish 任何带 requestId 的事件）。这类事件此前找不到 reservation，
    // 直接按整个 tokenLimit 扣账 —— 一次 502 就能耗尽 500k 预算并取消整轮，表现为 Stopped 且无回复。
    // 修复依据：同一 session 内未关联 requestId 的 reservation 就是这次 attempt 的预留，按它结算。
    // 只取 requestId === undefined 的条目：已关联 requestId 的预留属于别的 in-flight 请求，
    // 借用它会把用量记到别人的账上，并让那个请求的终态事件失去预留。
    const reservation = this.settleRootRunReservation(state, event.sessionId, requestId, true);
    // 缺少 usage 的终态事件代表 provider 成本未知，按该 attempt 的完整 reservation 扣账。
    // 根因：admission 在 remaining <= 0 时直接 throw（见上方 remaining 分支），该请求从未发给 provider，
    // 随后到达的 model_request_failed 既没有 usage 也没有 reservation；旧实现退到「本 run 发放过的
    // 最大单次预留」（deepseek-v4.1-flash-1017 为 384k），凭空记一笔从未发生的费用，
    // 一次 admission 拒绝就能把 500k 预算推到耗尽并取消整轮。
    // 修复依据：找不到 reservation 的终态事件按 0 记账 —— 未知成本不能凭空打满预算。
    // 回归用例 "treats an unattributable event without any reservation as zero cost" 覆盖。
    const debitedTokens = usage?.totalTokens ?? reservation?.reservedTokens ?? 0;
    state.usedTokens += debitedTokens;
    // Резервации активных запросов ограничивают новый admission, но не являются расходом.
    // Иначе параллельные дочерние ветки отменяли весь рой при полном, но ещё не потраченном резерве.
    if (state.usedTokens >= state.tokenLimit) {
      this.expireRootRunBudget(state, "token_limit");
    }
    this.changed();
  }

  finishRootRunTurn(rootRunId: string): void {
    const state = this.rootRunBudgets.get(rootRunId);
    if (!state) return;
    state.turnFinished = true;
    // 根因：root 会话的 reservation 只由终态事件结算，而 settleRootRunSessionReservations 只覆盖子任务；
    // abort/断流时终态事件可能永远不来，带 requestId 的 entry 会一直留在 activeReservationsBySession 里，
    // 直到进程结束（root 会话没有别的清理路径）。
    // 修复依据：turn 结束即该 root 会话不再发起新请求，残留 entry 已无结算对象，直接释放；
    // 子会话的 entry 保留，仍由子任务 terminal 结算，不影响防重复扣账。
    this.releaseRootRunSessionReservations(state, state.rootSessionId);
    if (!this.hasActiveRootRunChildren(rootRunId)) this.deleteRootRunBudget(rootRunId);
  }

  /** 交还某个会话在 root-run 上残留的全部 admission 预留（已 release 的条目额度已归还，不重复扣）。 */
  private releaseRootRunSessionReservations(state: RootRunBudgetState, sessionId: SessionId): void {
    const reservations = state.activeReservationsBySession.get(sessionId);
    if (!reservations?.length) {
      state.activeReservationsBySession.delete(sessionId);
      return;
    }
    let returnedTokens = 0;
    for (const reservation of reservations) {
      if (reservation.consumed || reservation.released) continue;
      reservation.released = true;
      returnedTokens += reservation.reservedTokens;
    }
    state.activeReservationsBySession.delete(sessionId);
    state.reservedTokens = Math.max(0, state.reservedTokens - returnedTokens);
  }

  async cancelRootRunChildren(rootRunId: string, reason?: unknown): Promise<void> {
    const active = [...this.tasks.values()].filter(
      (task) =>
        task.rootRunId === rootRunId &&
        (task.status === "running" || this.finalizingSubagentTasks.has(task.taskId)),
    );
    const activeIds = new Set(active.map((task) => task.taskId));
    const roots = active.filter((task) => {
      const parent = task.parentSessionId ? this.findTaskByChildSession(task.parentSessionId) : undefined;
      return !parent || !activeIds.has(parent.taskId);
    });
    await Promise.all(roots.map((task) => this.cancelSubagentSubtree(task.taskId, reason)));
  }

  waitForRootRunCancellation(rootRunId: string): Promise<void> {
    return this.rootRunBudgets.get(rootRunId)?.cancellationPromise ?? Promise.resolve();
  }

  isRootRunBudgetExpired(rootRunId: string): boolean {
    const state = this.rootRunBudgets.get(rootRunId);
    return state !== undefined && (state.expired || Date.now() >= state.deadlineAt);
  }

  /**
   * 根因：turn 结束后 finishRootRunTurn 会删除 root-run 预算；而 session_title、project_memory_extract
   * 等 post-turn sidecar 仍用已过期的 traceContext.turnId 合成同一个 rootRunId，reserveRootRunTokens
   * 对已删除的状态抛 RootRunBudgetExceededError，看起来像"预算耗尽"，实际是预算已被释放。
   * 修复依据：预算不存在 = 该 turn 已正常收尾并归还，不是超限，不进入闸门；
   * 只要预算还在，root 会话的本轮请求（含超限后）与全部 child 会话都必须继续受闸门约束。
   */
  shouldEnforceRootRunBudget(rootRunId: string, sessionId: SessionId): boolean {
    const state = this.rootRunBudgets.get(rootRunId);
    if (!state) return false;
    return !(state.turnFinished && state.rootSessionId === sessionId);
  }

  getRootRunBudgetSnapshot(rootRunId: string): {
    deadlineAt: number;
    reservedTokens: number;
    tokenLimit: number;
    usedTokens: number;
  } | undefined {
    const state = this.rootRunBudgets.get(rootRunId);
    return state
      ? {
          deadlineAt: state.deadlineAt,
          reservedTokens: state.reservedTokens,
          tokenLimit: state.tokenLimit,
          usedTokens: state.usedTokens,
        }
      : undefined;
  }

  private findRootRunBudgetForEvent(event: SessionEvent): RootRunBudgetState | undefined {
    const childTask = this.getSubagentTaskByChildSession(event.sessionId);
    if (childTask?.rootRunId) return this.rootRunBudgets.get(childTask.rootRunId);
    if (!event.turnId) return undefined;
    return this.rootRunBudgets.get(makeRootRunId(event.sessionId, event.turnId));
  }

  private hasActiveRootRunChildren(rootRunId: string): boolean {
    return [...this.tasks.values()].some(
      (task) =>
        task.rootRunId === rootRunId &&
        (task.status === "running" || this.finalizingSubagentTasks.has(task.taskId)),
    );
  }

  private maybeReleaseRootRunBudget(rootRunId: string | undefined): void {
    if (!rootRunId) return;
    const state = this.rootRunBudgets.get(rootRunId);
    if (state?.turnFinished && !this.hasActiveRootRunChildren(rootRunId)) {
      this.deleteRootRunBudget(rootRunId);
    }
  }

  private deleteRootRunBudget(rootRunId: string): void {
    const state = this.rootRunBudgets.get(rootRunId);
    if (!state) return;
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    this.rootRunBudgets.delete(rootRunId);
  }

  private expireRootRunBudget(
    state: RootRunBudgetState,
    reason: RootRunBudgetExhaustionReason,
  ): void {
    if (state.expired) return;
    state.expired = true;
    state.onExhausted?.(reason);
    state.cancellationPromise = this.cancelRootRunChildren(
      state.rootRunId,
      new RootRunBudgetExceededError(state.rootRunId),
    );
  }

  register(task: RuntimeTaskSnapshot): void {
    const ownerSessionId = task.ownerSessionId ?? task.parentSessionId;
    const stamped = {
      ...task,
      ...((task.offPeakExecutionId ?? this.offPeakExecutionId)
        ? {
            offPeakExecutionId: task.offPeakExecutionId ?? this.offPeakExecutionId,
          }
        : {}),
      branchGeneration:
        task.branchGeneration ??
        (ownerSessionId ? this.branchGenerations.get(ownerSessionId) : undefined) ??
        this.activeBranchGeneration,
    };
    this.setTaskSnapshot(stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
    this.changed();
  }

  registerSubagentTask(
    task: RuntimeTaskSnapshot,
    cancellation: RuntimeTaskCancellationHandle,
  ): RuntimeTaskAdmissionResult {
    if (this.finalizingSubagentTasks.has(task.taskId)) {
      return { accepted: false, reason: "task_finalizing" };
    }
    const parentSessionId = task.parentSessionId;
    if (!task.childSessionId) {
      return { accepted: false, reason: "lineage_conflict" };
    }
    if (!parentSessionId || this.closedSessionOwners.has(parentSessionId)) {
      return { accepted: false, reason: "owner_closed" };
    }

    const parentTask = this.findTaskByChildSession(parentSessionId);
    if (parentTask && isTerminalRuntimeTask(parentTask)) {
      return { accepted: false, reason: "parent_stopped" };
    }
    if (this.wouldCreateSubagentCycle(parentSessionId, task.childSessionId)) {
      return { accepted: false, reason: "lineage_conflict" };
    }

    const rootSessionId = parentTask?.rootSessionId ?? parentSessionId;
    if (this.closedSessionOwners.has(rootSessionId)) {
      return { accepted: false, reason: "owner_closed" };
    }
    const existing = this.tasks.get(task.taskId);
    if (existing && !isTerminalRuntimeTask(existing)) {
      return { accepted: false, reason: "task_already_running" };
    }
    const existingChildOwner = this.getSubagentTaskByChildSession(task.childSessionId);
    if (
      (existing?.rootSessionId && existing.rootSessionId !== rootSessionId) ||
      (existingChildOwner && existingChildOwner.taskId !== task.taskId)
    ) {
      return { accepted: false, reason: "lineage_conflict" };
    }
    // SendMessage resume keeps the existing node in its original root run, even though the
    // coordinator request that resumed it may have a newer turn id.
    const rootRunId =
      existing?.rootSessionId === rootSessionId && existing.rootRunId
        ? existing.rootRunId
        : (parentTask?.rootRunId ?? makeRootRunId(rootSessionId, task.turnId));
    if (this.isRootRunBudgetExpired(rootRunId)) {
      return { accepted: false, reason: "root_run_budget_exceeded" };
    }

    // spawn 预算门禁：必须在 active-limit 与任何写入之前拒绝，保证被拒请求不留副作用。
    // 没有 root-run 状态时（直接调用 registry 的旧路径）不做门禁，保持向后兼容。
    const rootBudget = this.rootRunBudgets.get(rootRunId);
    let parentRemainingSpawns: number | undefined;
    let childSpawnGrant: number | undefined;
    if (rootBudget) {
      const remaining =
        rootBudget.remainingSpawnsBySession.get(parentSessionId) ?? rootBudget.spawnBudget;
      if (remaining <= 0) {
        return { accepted: false, reason: "spawn_budget_exhausted" };
      }
      parentRemainingSpawns = remaining;
      // 子级预算严格小于父级；模型声明的 remaining_spawns 只能收紧，不能抬高 hostGrant。
      const hostGrant = remaining - 1;
      const requestedGrant = task.spawnGrant;
      childSpawnGrant =
        requestedGrant === undefined
          ? hostGrant
          : Math.min(Math.max(0, Math.floor(requestedGrant)), hostGrant);
    }

    const activeWorkItems = this.getActiveSubagentWorkItems(rootSessionId);
    const foregroundParentTransfersSlot =
      task.isBackgrounded !== true &&
      parentTask?.status === "running" &&
      activeWorkItems.some((activeTask) => activeTask.taskId === parentTask.taskId);
    // 根因：旧逻辑把等待 foreground child 的祖先也计入并发额度，使并发上限变成隐式 depth cap；
    // 修复依据：foreground Agent 调用会挂起父级，子级应接管该 worker slot，background child 则另计。
    const projectedActiveCount =
      activeWorkItems.length - (foregroundParentTransfersSlot ? 1 : 0);
    if (projectedActiveCount >= SUBAGENT_ROOT_MAX_ACTIVE_TASKS) {
      return { accepted: false, reason: "active_limit" };
    }

    const stamped: RuntimeTaskSnapshot = {
      ...task,
      // A node inherits its immediate owner session generation; descendants may rewind locally
      // without mutating the root generation or sibling branches.
      branchGeneration: this.branchGenerations.get(parentSessionId) ?? 0,
      rootRunId,
      rootSessionId,
      // 每次重新准入都生成新 attempt，防止旧 verifier receipt 命中相同 taskId 的新生命期。
      attemptId: randomUUID(),
      ...(childSpawnGrant === undefined ? {} : { spawnGrant: childSpawnGrant }),
    };
    if (rootBudget && parentRemainingSpawns !== undefined) {
      rootBudget.remainingSpawnsBySession.set(parentSessionId, parentRemainingSpawns - 1);
      if (task.childSessionId) {
        rootBudget.remainingSpawnsBySession.set(task.childSessionId, childSpawnGrant ?? 0);
      }
      rootBudget.spawnsUsed += 1;
    }
    this.setTaskSnapshot(stamped);
    this.cancellationHandles.set(stamped.taskId, cancellation);
    // 终态清理结束后才允许同一 task id 开启新生命期、唤醒 terminal waiter。
    void cancellation.settled.then(() => {
      this.finishSubagentTaskFinalization(stamped.taskId, cancellation);
    });
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
    this.changed();
    return { accepted: true, task: stamped };
  }

  releaseSubagentCancellationHandle(
    taskId: string,
    cancellation: RuntimeTaskCancellationHandle,
  ): void {
    if (this.cancellationHandles.get(taskId) === cancellation) {
      this.cancellationHandles.delete(taskId);
    }
  }

  async cancelSubagentSubtree(
    taskId: string,
    reason: unknown = new Error(`Subagent task cancelled: ${taskId}`),
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const taskIds = this.collectSubagentSubtree(taskId);
    const handles = taskIds.flatMap((id) => {
      const task = this.tasks.get(id);
      if (task?.childSessionId) this.closedSessionOwners.add(task.childSessionId);
      const handle =
        this.cancellationHandles.get(id) ?? this.finalizingSubagentTasks.get(id);
      return handle ? [{ handle, id }] : [];
    });

    // 先对整棵目标子树同步发出 abort，再等待各 runtime 实际退出，避免父先收口时子还在执行。
    for (const { handle } of handles) handle.abort(reason);
    const settlements = await Promise.all(
      handles.map(async ({ handle, id }) => ({
        id,
        snapshot: await handle.settled,
      })),
    );
    const targetSettlement = settlements.find((settlement) => settlement.id === taskId);
    return isRuntimeTaskSnapshot(targetSettlement?.snapshot)
      ? targetSettlement.snapshot
      : this.tasks.get(taskId);
  }

  beginSubagentTaskFinalization(taskId: string): boolean {
    if (this.finalizingSubagentTasks.has(taskId)) return false;
    this.finalizingSubagentTasks.set(taskId, this.cancellationHandles.get(taskId));
    return true;
  }

  isSubagentTaskFinalizing(taskId: string): boolean {
    return this.finalizingSubagentTasks.has(taskId);
  }

  private finishSubagentTaskFinalization(
    taskId: string,
    cancellation: RuntimeTaskCancellationHandle,
  ): void {
    if (
      !this.finalizingSubagentTasks.has(taskId) ||
      this.finalizingSubagentTasks.get(taskId) !== cancellation
    ) {
      return;
    }
    this.finalizingSubagentTasks.delete(taskId);
    let current = this.tasks.get(taskId);
    if (current && !isTerminalRuntimeTask(current)) {
      // Finisher must never leave a terminal waiter blocked forever if an earlier finalizer step
      // threw before its terminal update. Preserve the failure as an explicit retryable task state.
      current = {
        ...current,
        status: "failed",
        completedAt: new Date(),
        error: "Subagent finalization ended without recording a terminal state.",
      };
      this.setTaskSnapshot(current);
      this.resolveIfTerminal(taskId, current);
    } else if (current) {
      current = compactTerminalSubagentSnapshot(current);
      this.setTaskSnapshot(current);
      // A settled child owner cannot admit descendants because its parent task is terminal.
      // Removing the close marker prevents one retained SessionId per completed tree node.
      if (current.childSessionId) this.closedSessionOwners.delete(current.childSessionId);
      this.resolveTerminalWaiters(taskId, current);
    }
    this.maybeReleaseRootRunBudget(current?.rootRunId);
    this.pruneArchivedTerminalSnapshots();
    this.changed();
  }

  markTerminalTaskArchived(taskId: string, attemptId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.attemptId !== attemptId || !isTerminalRuntimeTask(task)) return;
    this.archivedTerminalTaskAttempts.delete(terminalArchiveKey(taskId, attemptId));
    this.archivedTerminalTaskAttempts.add(terminalArchiveKey(taskId, attemptId));
    this.pruneArchivedTerminalSnapshots();
    this.changed();
  }

  isTerminalTaskArchived(taskId: string, attemptId: string): boolean {
    return this.archivedTerminalTaskAttempts.has(terminalArchiveKey(taskId, attemptId));
  }

  private pruneArchivedTerminalSnapshots(): void {
    while (this.terminalSubagentTaskIds.size > MAX_RETAINED_TERMINAL_SUBAGENT_SNAPSHOTS) {
      let candidate: RuntimeTaskSnapshot | undefined;
      for (const key of this.archivedTerminalTaskAttempts) {
        const separator = key.indexOf("\0");
        const taskId = key.slice(0, separator);
        const attemptId = key.slice(separator + 1);
        const task = this.tasks.get(taskId);
        if (!task || task.attemptId !== attemptId || !isTerminalRuntimeTask(task)) {
          this.archivedTerminalTaskAttempts.delete(key);
          continue;
        }
        if (
          task.pendingMessages?.length ||
          this.terminalWaiters.get(taskId)?.size ||
          this.finalizingSubagentTasks.has(taskId) ||
          this.cancellationHandles.has(taskId) ||
          this.hasActiveSubagentDescendant(task)
        ) {
          continue;
        }
        candidate = task;
        break;
      }
      if (!candidate) return;
      this.removeTaskIndexes(candidate);
      this.tasks.delete(candidate.taskId);
      this.terminalSubagentTaskIds.delete(candidate.taskId);
      this.archivedTerminalTaskAttempts.delete(
        terminalArchiveKey(candidate.taskId, candidate.attemptId ?? ""),
      );
    }
  }

  private hasActiveSubagentDescendant(task: RuntimeTaskSnapshot): boolean {
    if (!task.childSessionId) return false;
    const pendingSessions = [task.childSessionId];
    const visitedSessions = new Set<SessionId>();
    while (pendingSessions.length > 0) {
      const sessionId = pendingSessions.pop();
      if (!sessionId || visitedSessions.has(sessionId)) continue;
      visitedSessions.add(sessionId);
      for (const childTaskId of this.subagentTaskIdsByParentSession.get(sessionId) ?? []) {
        const child = this.tasks.get(childTaskId);
        if (!child) continue;
        if (
          !isTerminalRuntimeTask(child) ||
          this.finalizingSubagentTasks.has(childTaskId) ||
          this.cancellationHandles.has(childTaskId)
        ) {
          return true;
        }
        if (child.childSessionId) pendingSessions.push(child.childSessionId);
      }
    }
    return false;
  }

  async cancelSubagentChildren(
    parentSessionId: SessionId,
    reason: unknown = new Error(`Subagent owner closed: ${parentSessionId}`),
  ): Promise<void> {
    // Если предок уже закрыл владельца и ждёт всё поддерево, вложенное закрытие не запускает
    // второй каскад: иначе потомки повторно обходят и ожидают одну ветку, а линейная цепочка
    // приводит к квадратичному числу обходов.
    if (this.closedSessionOwners.has(parentSessionId)) return;
    this.closedSessionOwners.add(parentSessionId);
    const childIds = [...(this.subagentTaskIdsByParentSession.get(parentSessionId) ?? [])];
    await Promise.all(childIds.map((taskId) => this.cancelSubagentSubtree(taskId, reason)));
  }

  openSessionOwner(sessionId: SessionId): void {
    this.closedSessionOwners.delete(sessionId);
  }

  getRootSessionIdForSession(sessionId: SessionId): SessionId {
    return this.findTaskByChildSession(sessionId)?.rootSessionId ?? sessionId;
  }

  getRootRunIdForSession(sessionId: SessionId, turnId?: TurnId): string | undefined {
    const task = this.findTaskByChildSession(sessionId);
    return task?.rootRunId ?? (turnId ? makeRootRunId(sessionId, turnId) : undefined);
  }

  getBranchGenerationForSession(sessionId: SessionId): number {
    return this.branchGenerations.get(sessionId) ?? 0;
  }

  setBranchGenerationForSession(sessionId: SessionId, generation: number): void {
    this.branchGenerations.set(sessionId, generation);
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  getSubagentTaskByChildSession(sessionId: SessionId): RuntimeTaskSnapshot | undefined {
    const taskId = this.subagentTaskIdByChildSession.get(sessionId);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  private setTaskSnapshot(task: RuntimeTaskSnapshot): void {
    const ownerOfChildSession =
      task.type === "local_agent" && task.childSessionId
        ? this.subagentTaskIdByChildSession.get(task.childSessionId)
        : undefined;
    if (ownerOfChildSession && ownerOfChildSession !== task.taskId) {
      throw new Error(`Child session already belongs to subagent task ${ownerOfChildSession}`);
    }

    const previous = this.tasks.get(task.taskId);
    if (task.type === "local_agent" && isTerminalRuntimeTask(task)) {
      this.terminalSubagentTaskIds.add(task.taskId);
    } else {
      this.terminalSubagentTaskIds.delete(task.taskId);
    }
    if (previous?.attemptId && previous.attemptId !== task.attemptId) {
      this.archivedTerminalTaskAttempts.delete(
        terminalArchiveKey(previous.taskId, previous.attemptId),
      );
    }
    if (previous) this.removeTaskIndexes(previous);
    this.tasks.set(task.taskId, task);
    if (task.type !== "local_agent") {
      this.maybeReleaseRootRunBudget(previous?.rootRunId ?? task.rootRunId);
      return;
    }

    if (task.childSessionId) this.subagentTaskIdByChildSession.set(task.childSessionId, task.taskId);
    if (task.parentSessionId) {
      addTaskIdToSessionIndex(this.subagentTaskIdsByParentSession, task.parentSessionId, task.taskId);
    }
    if (task.status === "running" && task.rootSessionId) {
      addTaskIdToSessionIndex(
        this.activeSubagentTaskIdsByRootSession,
        task.rootSessionId,
        task.taskId,
      );
    }
    if (
      previous &&
      !isTerminalRuntimeTask(previous) &&
      isTerminalRuntimeTask(task) &&
      task.childSessionId &&
      task.rootRunId
    ) {
      this.settleRootRunSessionReservations(task.rootRunId, task.childSessionId);
    }
    this.maybeReleaseRootRunBudget(previous?.rootRunId ?? task.rootRunId);
  }

  private settleRootRunSessionReservations(rootRunId: string, sessionId: SessionId): void {
    const state = this.rootRunBudgets.get(rootRunId);
    const reservations = state?.activeReservationsBySession.get(sessionId);
    if (!state || !reservations?.length) return;

    // 根因：子进程/流可能在写入终态 usage 前退出，遗留 reservation 会永久占住兄弟任务预算。
    // 修复依据：子任务 terminal 是该 session 不会再完成此请求的生命周期边界；未知成本按 reservation 保守扣账。
    let debitedTokens = 0;
    for (const reservation of reservations) {
      if (reservation.consumed || reservation.released) continue;
      reservation.consumed = true;
      debitedTokens += reservation.reservedTokens;
    }
    state.activeReservationsBySession.delete(sessionId);
    state.reservedTokens = Math.max(0, state.reservedTokens - debitedTokens);
    state.usedTokens += debitedTokens;
    if (state.usedTokens >= state.tokenLimit) {
      this.expireRootRunBudget(state, "token_limit");
    }
  }

  private removeTaskIndexes(task: RuntimeTaskSnapshot): void {
    if (task.type !== "local_agent") return;
    if (
      task.childSessionId &&
      this.subagentTaskIdByChildSession.get(task.childSessionId) === task.taskId
    ) {
      this.subagentTaskIdByChildSession.delete(task.childSessionId);
    }
    if (task.parentSessionId) {
      removeTaskIdFromSessionIndex(
        this.subagentTaskIdsByParentSession,
        task.parentSessionId,
        task.taskId,
      );
    }
    if (task.status === "running" && task.rootSessionId) {
      removeTaskIdFromSessionIndex(
        this.activeSubagentTaskIdsByRootSession,
        task.rootSessionId,
        task.taskId,
      );
    }
  }

  private findTaskByChildSession(sessionId: SessionId): RuntimeTaskSnapshot | undefined {
    return this.getSubagentTaskByChildSession(sessionId);
  }

  private getActiveSubagentWorkItems(
    rootSessionId: SessionId,
    taskOverride?: RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot[] {
    const activeTaskIds = this.activeSubagentTaskIdsByRootSession.get(rootSessionId) ?? new Set();
    const runningTasks = [...activeTaskIds]
      .map((taskId) =>
        taskId === taskOverride?.taskId ? taskOverride : this.tasks.get(taskId),
      )
      .filter((task): task is RuntimeTaskSnapshot =>
        task?.type === "local_agent" &&
        task.rootSessionId === rootSessionId &&
        task.status === "running",
      );
    const ownersWithForegroundChild = new Set(
      runningTasks
        .filter((task) => task.isBackgrounded !== true && task.parentSessionId)
        .map((task) => task.parentSessionId!),
    );
    // A foreground child means its parent runtime is waiting on this exact tool call. Background
    // children do not suspend the parent, so both remain separately charged to the root session.
    return runningTasks.filter(
      (task) => !task.childSessionId || !ownersWithForegroundChild.has(task.childSessionId),
    );
  }

  private wouldCreateSubagentCycle(parentSessionId: SessionId, childSessionId: SessionId): boolean {
    let currentSessionId: SessionId | undefined = parentSessionId;
    const seen = new Set<SessionId>();
    while (currentSessionId && !seen.has(currentSessionId)) {
      if (currentSessionId === childSessionId) return true;
      seen.add(currentSessionId);
      currentSessionId = this.findTaskByChildSession(currentSessionId)?.parentSessionId;
    }
    return false;
  }

  private collectSubagentSubtree(taskId: string): string[] {
    const result: string[] = [];
    const pending = [taskId];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const currentId = pending.pop();
      if (!currentId || seen.has(currentId)) continue;
      seen.add(currentId);
      const current = this.tasks.get(currentId);
      if (!current || current.type !== "local_agent") continue;
      result.push(currentId);
      const childSessionId = current.childSessionId;
      if (childSessionId) {
        const childTaskIds = this.subagentTaskIdsByParentSession.get(childSessionId);
        if (childTaskIds) {
          for (const childTaskId of childTaskIds) pending.push(childTaskId);
        }
      }
    }
    return result;
  }

  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    this.setTaskSnapshot(next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    this.changed();
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    if (
      task.isBackgrounded !== true &&
      task.type === "local_agent" &&
      task.status === "running"
    ) {
      const rootSessionId =
        task.rootSessionId ??
        (task.parentSessionId
          ? this.getRootSessionIdForSession(task.parentSessionId)
          : undefined);
      if (rootSessionId) {
        const projectedActiveCount = this.getActiveSubagentWorkItems(
          rootSessionId,
          next,
        ).length;
        // 根因：foreground→background 会唤醒父级继续执行，若只在 spawn 检查并发额度，转换会额外释放一个 worker。
        // 修复依据：用转换后的 registry 投影重新计数；超额时拒绝状态变更，waiter 继续等待 foreground child。
        if (projectedActiveCount > SUBAGENT_ROOT_MAX_ACTIVE_TASKS) return false;
      }
    }
    this.setTaskSnapshot(next);
    this.resolveBackgroundWaiters(id, next);
    this.changed();
    return true;
  }

  remove(id: string): void {
    const task = this.tasks.get(id);
    if (task) this.removeTaskIndexes(task);
    this.tasks.delete(id);
    this.terminalSubagentTaskIds.delete(id);
    if (task?.attemptId) {
      this.archivedTerminalTaskAttempts.delete(terminalArchiveKey(id, task.attemptId));
    }
    this.cancellationHandles.delete(id);
    this.finalizingSubagentTasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
    this.changed();
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.setTaskSnapshot({ ...task, pendingMessages: [] });
    this.changed();
    return messages;
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!this.finalizingSubagentTasks.has(id) && (!current || isTerminalRuntimeTask(current)))
      return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      if (!this.finalizingSubagentTasks.has(id)) {
        this.resolveTerminalWaiters(id, task);
      }
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

function addTaskIdToSessionIndex(
  index: Map<SessionId, Set<string>>,
  sessionId: SessionId,
  taskId: string,
): void {
  let taskIds = index.get(sessionId);
  if (!taskIds) {
    taskIds = new Set();
    index.set(sessionId, taskIds);
  }
  taskIds.add(taskId);
}

function removeTaskIdFromSessionIndex(
  index: Map<SessionId, Set<string>>,
  sessionId: SessionId,
  taskId: string,
): void {
  const taskIds = index.get(sessionId);
  if (!taskIds) return;
  taskIds.delete(taskId);
  if (taskIds.size === 0) index.delete(sessionId);
}

function makeRootRunId(rootSessionId: SessionId, turnId: TurnId | undefined): string {
  return `${rootSessionId}:${turnId ?? "session"}`;
}

export class RootRunBudgetExceededError extends Error {
  readonly code = "root_run_budget_exceeded";

  constructor(rootRunId: string) {
    super(`Root run resource budget is exhausted: ${rootRunId}`);
    this.name = "RootRunBudgetExceededError";
  }
}

function extractProviderUsage(event: SessionEvent):
  | { totalTokens: number }
  | undefined {
  let usage: ModelUsage | undefined;
  if (event.type === SessionEventType.ModelComplete) {
    const payload = event.payload as { usage?: ModelUsage; requestId?: string };
    usage = payload.usage;
  } else if (event.type === SessionEventType.ModelNetworkStatus) {
    const payload = event.payload as { type?: string; usage?: ModelUsage };
    if (payload.type !== "model_request_failed") return undefined;
    usage = payload.usage;
  } else return undefined;
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return undefined;
  return { totalTokens };
}

function getRootRunUsageRequestId(event: SessionEvent): string | undefined {
  if (event.type === SessionEventType.ModelComplete) {
    const requestId = (event.payload as { requestId?: unknown }).requestId;
    return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
  }
  if (event.type === SessionEventType.ModelNetworkStatus) {
    const payload = event.payload as { requestId?: unknown };
    return typeof payload.requestId === "string" && payload.requestId.length > 0
      ? payload.requestId
      : undefined;
  }
  return undefined;
}

function isRootRunUsageEvent(event: SessionEvent): boolean {
  if (event.type === SessionEventType.ModelComplete) return true;
  if (event.type !== SessionEventType.ModelNetworkStatus) return false;
  const payload = event.payload as { type?: string };
  if (payload.type !== "model_request_failed") return false;
  // 根因：可重试失败（如 502）之后 adapter 会退避重发，它不是请求终点。
  // 旧实现把每次都当终态结算，先消耗掉 reservation，重试 attempt 的终态事件便再也找不到预留，
  // 落到 tokenLimit 兜底而取消整轮。修复依据：只有不可重试的失败才是该请求的终态。
  return !isRootRunRetryableFailure(event);
}

/** 可重试的 model_request_failed：不是请求终点，只用于记账 provider 已报告的部分用量。 */
function isRootRunRetryableFailure(event: SessionEvent): boolean {
  if (event.type !== SessionEventType.ModelNetworkStatus) return false;
  const payload = event.payload as { type?: string; retryable?: boolean };
  return payload.type === "model_request_failed" && payload.retryable === true;
}

function compactTerminalSubagentSnapshot(task: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  if (task.type !== "local_agent") return task;
  const compactedOutput =
    task.output?.status === "completed"
      ? { ...task.output, content: [], prompt: "" }
      : task.output;
  // Full result text and prompts are available through the durable output file and the
  // just-completed Agent tool result. Keep only compact terminal metadata in the long-lived root registry.
  return {
    ...task,
    prompt: "",
    ...(compactedOutput === undefined ? {} : { output: compactedOutput }),
  };
}

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

function isRuntimeTaskSnapshot(
  value: void | RuntimeTaskSnapshot | undefined,
): value is RuntimeTaskSnapshot {
  return typeof value === "object" && value !== null && "taskId" in value;
}

function terminalArchiveKey(taskId: string, attemptId: string): string {
  return `${taskId}\0${attemptId}`;
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
