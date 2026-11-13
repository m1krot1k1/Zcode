import { createHash, randomUUID } from "node:crypto";
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
  SessionEventType,
  type PrismBashEvidenceArtifact,
  type PrismHostEvidenceReceipt,
  type PrismTaskAcceptanceCriterion,
  type PrismTaskAcceptanceDecision,
  type PrismTaskAcceptanceLineage,
  type PrismTaskContract,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import {
  hasOnlyKeys,
  isBoundedIdentifier,
  isBoundedText,
  isNonNegativeSafeInteger,
  isPositiveSafeSequence,
  isRecord,
  isSha256,
  utf8ByteLength,
} from "./registry-types.js";

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
    /\p{Cc}/u.test(value.artifact.uri) ||
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
