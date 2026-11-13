import type { SessionId, TurnId } from "@zcode/contracts";
import { releaseWorkClaim } from "./registry-admission.js";
import type { RegistryState } from "./registry-state.js";
import {
  MAX_RETAINED_TERMINAL_SUBAGENT_SNAPSHOTS,
  isTerminalRuntimeTask,
  makeRootRunId,
  type RuntimeTaskSnapshot,
  type RuntimeTaskWaiter,
} from "./registry-types.js";
import { maybeReleaseRootRunBudget } from "./registry-root-run.js";
import { notifyRegistryChanged } from "./registry-state.js";

export function setTaskSnapshot(state: RegistryState, task: RuntimeTaskSnapshot): void {
  const ownerOfChildSession =
    task.type === "local_agent" && task.childSessionId
      ? state.subagentTaskIdByChildSession.get(task.childSessionId)
      : undefined;
  if (ownerOfChildSession && ownerOfChildSession !== task.taskId) {
    throw new Error(`Child session already belongs to subagent task ${ownerOfChildSession}`);
  }

  const previous = state.tasks.get(task.taskId);
  // Освобождение слота: задача была активной, а становится терминальной или перестаёт
  // быть running. Ждать ёмкость имеет смысл только на таких переходах.
  const capacityFreed =
    previous !== undefined &&
    previous.type === "local_agent" &&
    !isTerminalRuntimeTask(previous) &&
    (isTerminalRuntimeTask(task) || task.status !== "running");
  // Единый funnel всех записей задачи: здесь ловим переход в терминальное состояние,
  // чтобы завершение, падение и отмена одинаково снимали claim.
  if (
    previous &&
    task.type === "local_agent" &&
    !isTerminalRuntimeTask(previous) &&
    isTerminalRuntimeTask(task)
  ) {
    releaseWorkClaim(state, task.agentId);
  }
  if (task.type === "local_agent" && isTerminalRuntimeTask(task)) {
    state.terminalSubagentTaskIds.add(task.taskId);
  } else {
    state.terminalSubagentTaskIds.delete(task.taskId);
  }
  if (previous?.attemptId && previous.attemptId !== task.attemptId) {
    state.archivedTerminalTaskAttempts.delete(
      terminalArchiveKey(previous.taskId, previous.attemptId),
    );
  }
  if (previous) removeTaskIndexes(state, previous);
  state.tasks.set(task.taskId, task);
  if (task.type !== "local_agent") {
    maybeReleaseRootRunBudget(state, previous?.rootRunId ?? task.rootRunId);
    return;
  }

  if (task.childSessionId) state.subagentTaskIdByChildSession.set(task.childSessionId, task.taskId);
  if (task.parentSessionId) {
    addTaskIdToSessionIndex(
      state.subagentTaskIdsByParentSession,
      task.parentSessionId,
      task.taskId,
    );
  }
  if (task.status === "running" && task.rootSessionId) {
    addTaskIdToSessionIndex(
      state.activeSubagentTaskIdsByRootSession,
      task.rootSessionId,
      task.taskId,
    );
  }
  maybeReleaseRootRunBudget(state, previous?.rootRunId ?? task.rootRunId);
  if (capacityFreed) notifyCapacityChanged(state);
}

export function removeTaskIndexes(state: RegistryState, task: RuntimeTaskSnapshot): void {
  if (task.type !== "local_agent") return;
  if (
    task.childSessionId &&
    state.subagentTaskIdByChildSession.get(task.childSessionId) === task.taskId
  ) {
    state.subagentTaskIdByChildSession.delete(task.childSessionId);
  }
  if (task.parentSessionId) {
    removeTaskIdFromSessionIndex(
      state.subagentTaskIdsByParentSession,
      task.parentSessionId,
      task.taskId,
    );
  }
  if (task.status === "running" && task.rootSessionId) {
    removeTaskIdFromSessionIndex(
      state.activeSubagentTaskIdsByRootSession,
      task.rootSessionId,
      task.taskId,
    );
  }
}

export function findTaskByChildSession(
  state: RegistryState,
  sessionId: SessionId,
): RuntimeTaskSnapshot | undefined {
  return getSubagentTaskByChildSession(state, sessionId);
}

export function getRootSessionIdForSession(state: RegistryState, sessionId: SessionId): SessionId {
  return findTaskByChildSession(state, sessionId)?.rootSessionId ?? sessionId;
}

export function getRootRunIdForSession(
  state: RegistryState,
  sessionId: SessionId,
  turnId?: TurnId,
): string | undefined {
  const task = findTaskByChildSession(state, sessionId);
  return task?.rootRunId ?? (turnId ? makeRootRunId(sessionId, turnId) : undefined);
}

export function getSubagentTaskByChildSession(
  state: RegistryState,
  sessionId: SessionId,
): RuntimeTaskSnapshot | undefined {
  const taskId = state.subagentTaskIdByChildSession.get(sessionId);
  return taskId ? state.tasks.get(taskId) : undefined;
}

export function getActiveSubagentWorkItems(
  state: RegistryState,
  rootSessionId: SessionId,
  taskOverride?: RuntimeTaskSnapshot,
): RuntimeTaskSnapshot[] {
  const activeTaskIds =
    state.activeSubagentTaskIdsByRootSession.get(rootSessionId) ?? new Set<string>();
  const runningTasks = [...activeTaskIds]
    .map((taskId) => (taskId === taskOverride?.taskId ? taskOverride : state.tasks.get(taskId)))
    .filter(
      (task): task is RuntimeTaskSnapshot =>
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

export function wouldCreateSubagentCycle(
  state: RegistryState,
  parentSessionId: SessionId,
  childSessionId: SessionId,
): boolean {
  let currentSessionId: SessionId | undefined = parentSessionId;
  const seen = new Set<SessionId>();
  while (currentSessionId && !seen.has(currentSessionId)) {
    if (currentSessionId === childSessionId) return true;
    seen.add(currentSessionId);
    currentSessionId = findTaskByChildSession(state, currentSessionId)?.parentSessionId;
  }
  return false;
}

export function collectSubagentSubtree(state: RegistryState, taskId: string): string[] {
  const result: string[] = [];
  const pending = [taskId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || seen.has(currentId)) continue;
    seen.add(currentId);
    const current = state.tasks.get(currentId);
    if (!current || current.type !== "local_agent") continue;
    result.push(currentId);
    const childSessionId = current.childSessionId;
    if (childSessionId) {
      const childTaskIds = state.subagentTaskIdsByParentSession.get(childSessionId);
      if (childTaskIds) {
        for (const childTaskId of childTaskIds) pending.push(childTaskId);
      }
    }
  }
  return result;
}

export function markTerminalTaskArchived(
  state: RegistryState,
  taskId: string,
  attemptId: string,
): void {
  const task = state.tasks.get(taskId);
  if (!task || task.attemptId !== attemptId || !isTerminalRuntimeTask(task)) return;
  state.archivedTerminalTaskAttempts.delete(terminalArchiveKey(taskId, attemptId));
  state.archivedTerminalTaskAttempts.add(terminalArchiveKey(taskId, attemptId));
  pruneArchivedTerminalSnapshots(state);
  notifyRegistryChanged(state);
}

export function deleteTerminalArchiveKey(
  state: RegistryState,
  taskId: string,
  attemptId: string,
): void {
  state.archivedTerminalTaskAttempts.delete(terminalArchiveKey(taskId, attemptId));
}

export function isTerminalTaskArchived(
  state: RegistryState,
  taskId: string,
  attemptId: string,
): boolean {
  return state.archivedTerminalTaskAttempts.has(terminalArchiveKey(taskId, attemptId));
}

export function pruneArchivedTerminalSnapshots(state: RegistryState): void {
  while (state.terminalSubagentTaskIds.size > MAX_RETAINED_TERMINAL_SUBAGENT_SNAPSHOTS) {
    let candidate: RuntimeTaskSnapshot | undefined;
    for (const key of state.archivedTerminalTaskAttempts) {
      const separator = key.indexOf("\0");
      const taskId = key.slice(0, separator);
      const attemptId = key.slice(separator + 1);
      const task = state.tasks.get(taskId);
      if (!task || task.attemptId !== attemptId || !isTerminalRuntimeTask(task)) {
        state.archivedTerminalTaskAttempts.delete(key);
        continue;
      }
      if (
        task.pendingMessages?.length ||
        state.terminalWaiters.get(taskId)?.size ||
        state.finalizingSubagentTasks.has(taskId) ||
        state.cancellationHandles.has(taskId) ||
        hasActiveSubagentDescendant(state, task)
      ) {
        continue;
      }
      candidate = task;
      break;
    }
    if (!candidate) return;
    removeTaskIndexes(state, candidate);
    state.tasks.delete(candidate.taskId);
    state.terminalSubagentTaskIds.delete(candidate.taskId);
    state.archivedTerminalTaskAttempts.delete(
      terminalArchiveKey(candidate.taskId, candidate.attemptId ?? ""),
    );
  }
}

export function hasActiveSubagentDescendant(
  state: RegistryState,
  task: RuntimeTaskSnapshot,
): boolean {
  if (!task.childSessionId) return false;
  const pendingSessions = [task.childSessionId];
  const visitedSessions = new Set<SessionId>();
  while (pendingSessions.length > 0) {
    const sessionId = pendingSessions.pop();
    if (!sessionId || visitedSessions.has(sessionId)) continue;
    visitedSessions.add(sessionId);
    for (const childTaskId of state.subagentTaskIdsByParentSession.get(sessionId) ?? []) {
      const child = state.tasks.get(childTaskId);
      if (!child) continue;
      if (
        !isTerminalRuntimeTask(child) ||
        state.finalizingSubagentTasks.has(childTaskId) ||
        state.cancellationHandles.has(childTaskId)
      ) {
        return true;
      }
      if (child.childSessionId) pendingSessions.push(child.childSessionId);
    }
  }
  return false;
}

/** Будит ожидающих после освобождения слота; индексы к этому моменту уже обновлены. */
export function notifyCapacityChanged(state: RegistryState): void {
  if (state.capacityWaiters.size === 0) return;
  const waiters = [...state.capacityWaiters];
  state.capacityWaiters.clear();
  for (const waiter of waiters) waiter();
}

export function waitForTask(
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
        removeWaiter(waitersByTask, id, waiter);
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

export function resolveIfBackgrounded(
  state: RegistryState,
  id: string,
  task: RuntimeTaskSnapshot,
): void {
  if (task.isBackgrounded) {
    resolveBackgroundWaiters(state, id, task);
  }
}

export function resolveIfTerminal(
  state: RegistryState,
  id: string,
  task: RuntimeTaskSnapshot,
): void {
  if (isTerminalRuntimeTask(task)) {
    if (!state.finalizingSubagentTasks.has(id)) {
      resolveTerminalWaiters(state, id, task);
    }
    resolveBackgroundWaiters(state, id, undefined);
  }
}

export function resolveBackgroundWaiters(
  state: RegistryState,
  id: string,
  task: RuntimeTaskSnapshot | undefined,
): void {
  resolveWaiters(state.backgroundWaiters, id, task);
}

export function resolveTerminalWaiters(
  state: RegistryState,
  id: string,
  task: RuntimeTaskSnapshot | undefined,
): void {
  resolveWaiters(state.terminalWaiters, id, task);
}

function resolveWaiters(
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

function removeWaiter(
  waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
  id: string,
  waiter: RuntimeTaskWaiter,
): void {
  const waiters = waitersByTask.get(id);
  if (!waiters) return;
  waiters.delete(waiter);
  if (waiters.size === 0) waitersByTask.delete(id);
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

function terminalArchiveKey(taskId: string, attemptId: string): string {
  return `${taskId}\0${attemptId}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
