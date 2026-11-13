import {
  SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT,
  SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT,
  SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL,
  type PrismHostEvidenceReceipt,
  type PrismTaskAcceptanceDecision,
  type PrismTaskAcceptanceLineage,
  type PrismTaskContract,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SubagentExecutionTerminalPayload,
} from "@zcode/contracts";
import {
  hasOnlyKeys,
  isBoundedIdentifier,
  isNonNegativeSafeInteger,
  isRecord,
} from "./registry-types.js";
import {
  isValidPrismHostEvidenceReceipt,
  isValidPrismTaskContract,
  reducePrismTaskAcceptance,
} from "./registry-prism.js";

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
    if (
      entry.type !== SESSION_ENTRY_HOST_ACCEPTANCE_CONTRACT ||
      entry.sessionID !== input.rootSessionId
    )
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
      entry.type !== SESSION_ENTRY_HOST_ACCEPTANCE_RECEIPT ||
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
    if (
      entry.type !== SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL ||
      entry.sessionID !== input.rootSessionId
    )
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
      terminalEntry.type !== SESSION_ENTRY_HOST_ACCEPTANCE_TERMINAL ||
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
