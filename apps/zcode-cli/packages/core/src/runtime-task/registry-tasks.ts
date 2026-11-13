import { randomUUID } from "node:crypto";
import { admitWorkClaim, releaseWorkClaim } from "./registry-admission.js";
import { finishSubagentTaskFinalization } from "./registry-cancel.js";
import { findActiveRootRunBudget, isRootRunBudgetExpired } from "./registry-root-run.js";
import { notifyRegistryChanged, type RegistryState } from "./registry-state.js";
import {
  isTerminalRuntimeTask,
  makeRootRunId,
  resolveSubagentMaxParallel,
  type RuntimeTaskAdmissionResult,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskPendingMessage,
  type RuntimeTaskSnapshot,
} from "./registry-types.js";
import {
  deleteTerminalArchiveKey,
  findTaskByChildSession,
  getActiveSubagentWorkItems,
  getRootSessionIdForSession,
  getSubagentTaskByChildSession,
  notifyCapacityChanged,
  removeTaskIndexes,
  resolveBackgroundWaiters,
  resolveIfBackgrounded,
  resolveIfTerminal,
  resolveTerminalWaiters,
  setTaskSnapshot,
  waitForTask,
  wouldCreateSubagentCycle,
} from "./registry-store.js";

export function registerTask(state: RegistryState, task: RuntimeTaskSnapshot): void {
  const ownerSessionId = task.ownerSessionId ?? task.parentSessionId;
  const stamped = {
    ...task,
    ...((task.offPeakExecutionId ?? state.offPeakExecutionId)
      ? {
          offPeakExecutionId: task.offPeakExecutionId ?? state.offPeakExecutionId,
        }
      : {}),
    branchGeneration:
      task.branchGeneration ??
      (ownerSessionId ? state.branchGenerations.get(ownerSessionId) : undefined) ??
      state.activeBranchGeneration,
  };
  setTaskSnapshot(state, stamped);
  resolveIfTerminal(state, stamped.taskId, stamped);
  resolveIfBackgrounded(state, stamped.taskId, stamped);
  notifyRegistryChanged(state);
}

export function registerSubagentTask(
  state: RegistryState,
  task: RuntimeTaskSnapshot,
  cancellation: RuntimeTaskCancellationHandle,
): RuntimeTaskAdmissionResult {
  if (state.finalizingSubagentTasks.has(task.taskId)) {
    return { accepted: false, reason: "task_finalizing" };
  }
  const parentSessionId = task.parentSessionId;
  if (!task.childSessionId) {
    return { accepted: false, reason: "lineage_conflict" };
  }
  if (!parentSessionId || state.closedSessionOwners.has(parentSessionId)) {
    return { accepted: false, reason: "owner_closed" };
  }

  const parentTask = findTaskByChildSession(state, parentSessionId);
  if (parentTask && isTerminalRuntimeTask(parentTask)) {
    return { accepted: false, reason: "parent_stopped" };
  }
  if (wouldCreateSubagentCycle(state, parentSessionId, task.childSessionId)) {
    return { accepted: false, reason: "lineage_conflict" };
  }

  const rootSessionId = parentTask?.rootSessionId ?? parentSessionId;
  if (state.closedSessionOwners.has(rootSessionId)) {
    return { accepted: false, reason: "owner_closed" };
  }
  const existing = state.tasks.get(task.taskId);
  if (existing && !isTerminalRuntimeTask(existing)) {
    return { accepted: false, reason: "task_already_running" };
  }
  const existingChildOwner = getSubagentTaskByChildSession(state, task.childSessionId);
  if (
    (existing?.rootSessionId && existing.rootSessionId !== rootSessionId) ||
    (existingChildOwner && existingChildOwner.taskId !== task.taskId)
  ) {
    return { accepted: false, reason: "lineage_conflict" };
  }
  // SendMessage resume keeps the existing node in its original root run, even though the
  // coordinator request that resumed it may have a newer turn id.
  const pinnedRootRunId =
    existing?.rootSessionId === rootSessionId && existing.rootRunId
      ? existing.rootRunId
      : (parentTask?.rootRunId ?? makeRootRunId(rootSessionId, task.turnId));
  // 根因：resume 固定在已结束的 root run 上，而该 run 的预算在 finishRootRunTurn 后已删除，
  // finishedRootRunIds 标记会让新 turn 中合法的 SendMessage resume 永久被拒。
  // 修复依据：仅当原 run 已释放且当前 turn 有活动预算时，把 resume 计入当前 turn 的预算，
  // 保持唯一预算所有者与单条扣减路径；没有活动预算时仍由下方 finishedRootRunIds 门禁 fail-closed。
  // turnId 缺失时无法匹配活动预算，保持 pinned/fail-closed 语义。
  const activeResumeBudget =
    existing && isTerminalRuntimeTask(existing) && state.finishedRootRunIds.has(pinnedRootRunId)
      ? task.turnId
        ? findActiveRootRunBudget(state, rootSessionId, task.turnId)
        : undefined
      : undefined;
  const rootRunId = activeResumeBudget?.rootRunId ?? pinnedRootRunId;
  if (isRootRunBudgetExpired(state, rootRunId)) {
    return { accepted: false, reason: "root_run_budget_exceeded" };
  }

  // Старый terminal task может быть возобновлён только внутри нового активного root run.
  const rootBudget = state.rootRunBudgets.get(rootRunId);
  if (
    !rootBudget &&
    existing?.rootRunId === rootRunId &&
    isTerminalRuntimeTask(existing) &&
    state.finishedRootRunIds.has(rootRunId)
  ) {
    return { accepted: false, reason: "root_run_finished" };
  }

  const activeWorkItems = getActiveSubagentWorkItems(state, rootSessionId);
  const foregroundParentTransfersSlot =
    task.isBackgrounded !== true &&
    parentTask?.status === "running" &&
    activeWorkItems.some((activeTask) => activeTask.taskId === parentTask.taskId);
  // 根因：旧逻辑把等待 foreground child 的祖先也计入并发额度，使并发上限变成隐式 depth cap；
  // 修复依据：foreground Agent 调用会挂起父级，子级应接管该 worker slot，background child 则另计。
  const projectedActiveCount = activeWorkItems.length - (foregroundParentTransfersSlot ? 1 : 0);
  const activeLimit = rootBudget?.maxParallel ?? resolveSubagentMaxParallel();
  if (projectedActiveCount >= activeLimit) {
    return { accepted: false, reason: "active_limit" };
  }

  const { spawnGrant: legacySpawnGrant, ...taskWithoutLegacyGrant } = task;
  // Persisted grants are obsolete; do not copy them into a fresh task attempt.
  void legacySpawnGrant;
  const stamped: RuntimeTaskSnapshot = {
    ...taskWithoutLegacyGrant,
    // A node inherits its immediate owner session generation; descendants may rewind locally
    // without mutating the root generation or sibling branches.
    branchGeneration: state.branchGenerations.get(parentSessionId) ?? 0,
    rootRunId,
    rootSessionId,
    // 每次重新准入都生成新 attempt，防止旧 verifier receipt 命中相同 taskId 的新生命期。
    attemptId: randomUUID(),
  };
  // Registrar hard gate: findConflicts и claim выполняются до записи снапшота,
  // чтобы отклонённый admission не оставлял ни задачи, ни claim'а.
  const claimAdmission = admitWorkClaim(state, stamped, parentTask?.agentId ?? null);
  if (!claimAdmission.accepted) return claimAdmission;
  try {
    setTaskSnapshot(state, stamped);
  } catch (error) {
    // Claim уже записан; сбой записи снапшота не должен оставить «призрак» в ledger.
    if (claimAdmission.claimed) releaseWorkClaim(state, stamped.agentId);
    throw error;
  }
  state.cancellationHandles.set(stamped.taskId, cancellation);
  // 终态清理结束后才允许同一 task id 开启新生命期、唤醒 terminal waiter。
  void cancellation.settled.then(() => {
    finishSubagentTaskFinalization(state, stamped.taskId, cancellation);
  });
  resolveIfTerminal(state, stamped.taskId, stamped);
  resolveIfBackgrounded(state, stamped.taskId, stamped);
  notifyRegistryChanged(state);
  return { accepted: true, task: stamped };
}

export function updateTask(
  state: RegistryState,
  id: string,
  patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
): RuntimeTaskSnapshot | undefined {
  const current = state.tasks.get(id);
  if (!current) return undefined;
  const next = patcher(current);
  setTaskSnapshot(state, next);
  resolveIfTerminal(state, id, next);
  resolveIfBackgrounded(state, id, next);
  notifyRegistryChanged(state);
  return next;
}

export function requestBackground(state: RegistryState, id: string): boolean {
  const task = state.tasks.get(id);
  if (!task || isTerminalRuntimeTask(task)) return false;
  const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
  if (task.isBackgrounded !== true && task.type === "local_agent" && task.status === "running") {
    const rootSessionId =
      task.rootSessionId ??
      (task.parentSessionId ? getRootSessionIdForSession(state, task.parentSessionId) : undefined);
    if (rootSessionId) {
      const projectedActiveCount = getActiveSubagentWorkItems(state, rootSessionId, next).length;
      // 根因：foreground→background 会唤醒父级继续执行，若只在 spawn 检查并发额度，转换会额外释放一个 worker。
      // 修复依据：用转换后的 registry 投影重新计数；超额时拒绝状态变更，waiter 继续等待 foreground child。
      const activeLimit =
        (task.rootRunId ? state.rootRunBudgets.get(task.rootRunId)?.maxParallel : undefined) ??
        resolveSubagentMaxParallel();
      if (projectedActiveCount > activeLimit) return false;
    }
  }
  setTaskSnapshot(state, next);
  resolveBackgroundWaiters(state, id, next);
  notifyRegistryChanged(state);
  return true;
}

export function removeTask(state: RegistryState, id: string): void {
  const task = state.tasks.get(id);
  const capacityFreed =
    task !== undefined &&
    task.type === "local_agent" &&
    !isTerminalRuntimeTask(task) &&
    task.status === "running";
  if (task && task.type === "local_agent" && !isTerminalRuntimeTask(task)) {
    // Удаление активной задачи без терминального перехода тоже освобождает работу.
    releaseWorkClaim(state, task.agentId);
  }
  if (task) removeTaskIndexes(state, task);
  state.tasks.delete(id);
  state.terminalSubagentTaskIds.delete(id);
  if (capacityFreed) notifyCapacityChanged(state);
  if (task?.attemptId) {
    deleteTerminalArchiveKey(state, id, task.attemptId);
  }
  state.cancellationHandles.delete(id);
  state.finalizingSubagentTasks.delete(id);
  resolveTerminalWaiters(state, id, undefined);
  resolveBackgroundWaiters(state, id, undefined);
  notifyRegistryChanged(state);
}

export function queueTaskMessage(
  state: RegistryState,
  id: string,
  message: RuntimeTaskPendingMessage,
): RuntimeTaskSnapshot | undefined {
  return updateTask(state, id, (task) => ({
    ...task,
    pendingMessages: [...(task.pendingMessages ?? []), message],
  }));
}

export function drainTaskMessages(state: RegistryState, id: string): RuntimeTaskPendingMessage[] {
  const task = state.tasks.get(id);
  if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
  const messages = task.pendingMessages;
  setTaskSnapshot(state, { ...task, pendingMessages: [] });
  notifyRegistryChanged(state);
  return messages;
}

export function waitForBackgroundRequest(
  state: RegistryState,
  id: string,
  options?: { signal?: AbortSignal },
): Promise<RuntimeTaskSnapshot | undefined> {
  const current = state.tasks.get(id);
  if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
    return Promise.resolve(current?.isBackgrounded ? current : undefined);
  }
  return waitForTask(state.backgroundWaiters, id, options);
}

export function waitForTerminal(
  state: RegistryState,
  id: string,
  options?: { signal?: AbortSignal },
): Promise<RuntimeTaskSnapshot | undefined> {
  const current = state.tasks.get(id);
  if (!state.finalizingSubagentTasks.has(id) && (!current || isTerminalRuntimeTask(current)))
    return Promise.resolve(current);
  return waitForTask(state.terminalWaiters, id, options);
}

export function waitForCapacityChange(
  state: RegistryState,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason ?? new Error("Capacity wait aborted"));
  }
  return new Promise<void>((resolve, reject) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(options.signal?.reason ?? new Error("Capacity wait aborted"));
    };
    const cleanup = (): void => {
      state.capacityWaiters.delete(done);
      options.signal?.removeEventListener("abort", onAbort);
    };
    state.capacityWaiters.add(done);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
