import type { SessionId, TurnId } from "@zcode/contracts";
import type { WorkLedger } from "./work-ledger.js";
import { WORK_LEDGER_TTL_MS } from "./work-ledger.js";
import {
  heartbeatActiveWorkClaims as heartbeatWorkClaims,
  sweepWorkLedger as sweepLedger,
} from "./registry-admission.js";
import {
  DEFAULT_ROOT_RUN_DEADLINE_MS,
  RootRunDeadlineExceededError,
  beginRootRunBudget,
  beginSubagentTaskFinalization,
  cancelRootRunChildren,
  cancelSubagentChildren,
  cancelSubagentSubtree,
  finishRootRunTurn,
  isSubagentTaskFinalizing,
} from "./registry-cancel.js";
import {
  getRootRunBudgetSnapshot,
  isRootRunBudgetExpired,
  waitForRootRunCancellation,
} from "./registry-root-run.js";
import { createRegistryState, type RegistryState } from "./registry-state.js";
import {
  drainTaskMessages,
  queueTaskMessage,
  registerSubagentTask,
  registerTask,
  removeTask,
  requestBackground,
  updateTask,
  waitForBackgroundRequest,
  waitForCapacityChange,
  waitForTerminal,
} from "./registry-tasks.js";
import {
  getActiveSubagentWorkItems,
  getRootRunIdForSession,
  getRootSessionIdForSession,
  getSubagentTaskByChildSession,
  isTerminalTaskArchived,
  markTerminalTaskArchived,
} from "./registry-store.js";
import type {
  InMemoryRuntimeTaskRegistryOptions,
  RuntimeTaskAdmissionResult,
  RuntimeTaskCancellationHandle,
  RuntimeTaskPendingMessage,
  RuntimeTaskRegistry,
  RuntimeTaskSnapshot,
} from "./registry-types.js";

export type {
  InMemoryRuntimeTaskRegistryOptions,
  RuntimeTaskAdmissionResult,
  RuntimeTaskCancellationHandle,
  RuntimeTaskMessageSink,
  RuntimeTaskPendingMessage,
  RuntimeTaskRegistry,
  RuntimeTaskSnapshot,
  RuntimeTaskType,
  RuntimeTaskUsageSnapshot,
} from "./registry-types.js";
export {
  MAX_RETAINED_TERMINAL_SUBAGENT_SNAPSHOTS,
  hasRunningBackgroundRuntimeTask,
  isTerminalRuntimeTask,
  resolveAdaptiveSubagentMaxParallel,
  resolveSubagentMaxParallel,
} from "./registry-types.js";
export {
  createRuntimeTaskTerminalCatalogEntry,
  readRuntimeTaskTerminalCatalogRecord,
  runtimeTaskOutputFile,
  runtimeTaskSnapshotFromTerminalCatalog,
} from "./registry-catalog.js";
export {
  createPrismEvidenceReceiptId,
  createPrismHostEvidenceReceipt,
  createPrismTaskContract,
  evaluatePrismTaskAcceptance,
  isPrismReceiptForCriterion,
  isValidPrismHostEvidenceReceipt,
  isValidPrismTaskContract,
  reducePrismTaskAcceptance,
} from "./registry-prism.js";
export type {
  PrismHostEvidenceReceiptInput,
  PrismTaskContractInput,
  PrismTaskEvaluation,
} from "./registry-prism.js";
export {
  createPrismHistoricalAcceptanceIndex,
  projectPrismHistoricalAcceptanceForTask,
} from "./registry-prism-history.js";
export type {
  PrismHistoricalAcceptanceIndex,
  PrismHistoricalAcceptanceInput,
} from "./registry-prism-history.js";
export { DEFAULT_ROOT_RUN_DEADLINE_MS, RootRunDeadlineExceededError };

/** Periodic materialization of stale work claims; lazy expiry stays authoritative. */
export const WORK_LEDGER_SWEEP_INTERVAL_MS = Math.max(1_000, Math.floor(WORK_LEDGER_TTL_MS / 2));

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private readonly state: RegistryState;

  constructor(options: InMemoryRuntimeTaskRegistryOptions = {}) {
    this.state = createRegistryState(options.workLedger);
    if (this.state.workLedger) {
      // 根因：без periodic sweep протухшие claim'ы остаются в памяти и в журнале до
      // следующего чтения; lazy expire гарантирует корректность, но не освобождает память.
      // 修复依据：отдельный unref-таймер материализует stale, не удерживая процесс.
      this.state.workLedgerSweepTimer = setInterval(() => {
        this.sweepWorkLedger();
      }, WORK_LEDGER_SWEEP_INTERVAL_MS);
      this.state.workLedgerSweepTimer.unref?.();
    }
  }

  get workLedger(): WorkLedger | undefined {
    return this.state.workLedger;
  }

  /** Освобождает process-level ресурсы registry; повторные вызовы безопасны. */
  dispose(): void {
    if (this.state.workLedgerSweepTimer) {
      clearInterval(this.state.workLedgerSweepTimer);
      this.state.workLedgerSweepTimer = undefined;
    }
  }

  heartbeatActiveWorkClaims(now: number = Date.now()): void {
    heartbeatWorkClaims(this.state, now);
  }

  sweepWorkLedger(now: number = Date.now()): void {
    sweepLedger(this.state, now);
  }

  subscribe(listener: () => void): () => void {
    this.state.listeners.add(listener);
    return () => {
      this.state.listeners.delete(listener);
    };
  }

  setOffPeakExecutionId(executionId: string | undefined): void {
    this.state.offPeakExecutionId = executionId;
  }

  beginRootRunBudget(input: {
    rootRunId: string;
    rootSessionId: SessionId;
    turnId: TurnId;
    startedAt?: number;
    deadlineMs?: number;
    /** @deprecated Persisted legacy value is ignored for admission. */
    spawnBudget?: number;
    maxParallel?: number;
    onExhausted?: () => void;
  }): void {
    beginRootRunBudget(this.state, input);
  }

  finishRootRunTurn(rootRunId: string): void {
    finishRootRunTurn(this.state, rootRunId);
  }

  cancelRootRunChildren(rootRunId: string, reason?: unknown): Promise<void> {
    return cancelRootRunChildren(this.state, rootRunId, reason);
  }

  waitForRootRunCancellation(rootRunId: string): Promise<void> {
    return waitForRootRunCancellation(this.state, rootRunId);
  }

  isRootRunBudgetExpired(rootRunId: string): boolean {
    return isRootRunBudgetExpired(this.state, rootRunId);
  }

  getRootRunBudgetSnapshot(rootRunId: string):
    | {
        deadlineAt: number | undefined;
        maxParallel: number;
      }
    | undefined {
    return getRootRunBudgetSnapshot(this.state, rootRunId);
  }

  register(task: RuntimeTaskSnapshot): void {
    registerTask(this.state, task);
  }

  registerSubagentTask(
    task: RuntimeTaskSnapshot,
    cancellation: RuntimeTaskCancellationHandle,
  ): RuntimeTaskAdmissionResult {
    return registerSubagentTask(this.state, task, cancellation);
  }

  releaseSubagentCancellationHandle(
    taskId: string,
    cancellation: RuntimeTaskCancellationHandle,
  ): void {
    if (this.state.cancellationHandles.get(taskId) === cancellation) {
      this.state.cancellationHandles.delete(taskId);
    }
  }

  cancelSubagentSubtree(
    taskId: string,
    reason?: unknown,
  ): Promise<RuntimeTaskSnapshot | undefined> {
    return cancelSubagentSubtree(this.state, taskId, reason);
  }

  beginSubagentTaskFinalization(taskId: string): boolean {
    return beginSubagentTaskFinalization(this.state, taskId);
  }

  isSubagentTaskFinalizing(taskId: string): boolean {
    return isSubagentTaskFinalizing(this.state, taskId);
  }

  markTerminalTaskArchived(taskId: string, attemptId: string): void {
    markTerminalTaskArchived(this.state, taskId, attemptId);
  }

  isTerminalTaskArchived(taskId: string, attemptId: string): boolean {
    return isTerminalTaskArchived(this.state, taskId, attemptId);
  }

  cancelSubagentChildren(parentSessionId: SessionId, reason?: unknown): Promise<void> {
    return cancelSubagentChildren(this.state, parentSessionId, reason);
  }

  openSessionOwner(sessionId: SessionId): void {
    this.state.closedSessionOwners.delete(sessionId);
  }

  getRootSessionIdForSession(sessionId: SessionId): SessionId {
    return getRootSessionIdForSession(this.state, sessionId);
  }

  /** @deprecated Kept for old callers; task-count quotas have been removed. */
  getRemainingSpawnBudget(rootRunId: string, sessionId: SessionId): number | undefined {
    void rootRunId;
    void sessionId;
    return undefined;
  }

  getRootRunMaxParallel(rootRunId: string): number | undefined {
    return this.state.rootRunBudgets.get(rootRunId)?.maxParallel;
  }

  /** Число активных worker-слотов root session; основа фактического maxParallel. */
  getActiveSubagentWorkItemCount(rootSessionId: SessionId): number {
    return getActiveSubagentWorkItems(this.state, rootSessionId).length;
  }

  isActiveSubagentWorkItem(taskId: string): boolean {
    const task = this.state.tasks.get(taskId);
    return task?.rootSessionId
      ? getActiveSubagentWorkItems(this.state, task.rootSessionId).some(
          (item) => item.taskId === taskId,
        )
      : false;
  }

  getRootRunIdForSession(sessionId: SessionId, turnId?: TurnId): string | undefined {
    return getRootRunIdForSession(this.state, sessionId, turnId);
  }

  getBranchGenerationForSession(sessionId: SessionId): number {
    return this.state.branchGenerations.get(sessionId) ?? 0;
  }

  setBranchGenerationForSession(sessionId: SessionId, generation: number): void {
    this.state.branchGenerations.set(sessionId, generation);
  }

  setActiveBranchGeneration(generation: number): void {
    this.state.activeBranchGeneration = generation;
  }

  getSubagentTaskByChildSession(sessionId: SessionId): RuntimeTaskSnapshot | undefined {
    return getSubagentTaskByChildSession(this.state, sessionId);
  }

  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    return updateTask(this.state, id, patcher);
  }

  requestBackground(id: string): boolean {
    return requestBackground(this.state, id);
  }

  remove(id: string): void {
    removeTask(this.state, id);
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.state.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.state.tasks);
  }

  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return queueTaskMessage(this.state, id, message);
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    return drainTaskMessages(this.state, id);
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    return waitForBackgroundRequest(this.state, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    return waitForTerminal(this.state, id, options);
  }

  waitForCapacityChange(options: { signal?: AbortSignal } = {}): Promise<void> {
    return waitForCapacityChange(this.state, options);
  }
}
