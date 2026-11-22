import type { SessionId, TurnId } from "@zcode/contracts";
import { compactTerminalSubagentSnapshot } from "./registry-catalog.js";
import {
  hasActiveRootRunChildren,
  deleteRootRunBudget,
  maybeReleaseRootRunBudget,
} from "./registry-root-run.js";
import { notifyRegistryChanged, type RegistryState } from "./registry-state.js";
import {
  isRuntimeTaskSnapshot,
  isTerminalRuntimeTask,
  resolveSubagentMaxParallel,
  type RootRunBudgetState,
  type RuntimeTaskCancellationHandle,
  type RuntimeTaskSnapshot,
} from "./registry-types.js";
import {
  collectSubagentSubtree,
  findTaskByChildSession,
  pruneArchivedTerminalSnapshots,
  resolveIfTerminal,
  resolveTerminalWaiters,
  setTaskSnapshot,
} from "./registry-store.js";

/** Root-run deadline больше не включается по умолчанию: задача выполняется до Stop или завершения. */
export const DEFAULT_ROOT_RUN_DEADLINE_MS: number | undefined = undefined;

export class RootRunDeadlineExceededError extends Error {
  readonly code = "root_run_deadline_exceeded";

  constructor(rootRunId: string) {
    super(`Root run time budget exhausted: ${rootRunId}`);
    this.name = "RootRunDeadlineExceededError";
  }
}

export function beginRootRunBudget(
  state: RegistryState,
  input: {
    rootRunId: string;
    rootSessionId: SessionId;
    turnId: TurnId;
    startedAt?: number;
    deadlineMs?: number;
    /** @deprecated Persisted legacy value is ignored for admission. */
    spawnBudget?: number;
    maxParallel?: number;
    onExhausted?: () => void;
  },
): void {
  if (state.rootRunBudgets.has(input.rootRunId)) return;
  state.finishedRootRunIds.delete(input.rootRunId);
  // Без явного deadlineMs root-run не получает wall-clock таймер: пользовательская
  // остановка и завершение turn остаются единственными границами.
  const deadlineMs = input.deadlineMs ?? DEFAULT_ROOT_RUN_DEADLINE_MS;
  const deadlineAt =
    deadlineMs === undefined ? undefined : (input.startedAt ?? Date.now()) + deadlineMs;
  state.rootRunBudgets.set(input.rootRunId, {
    rootRunId: input.rootRunId,
    deadlineAt,
    rootSessionId: input.rootSessionId,
    turnId: input.turnId,
    maxParallel: resolveSubagentMaxParallel(input.maxParallel),
    turnFinished: false,
    expired: false,
    onExhausted: input.onExhausted,
  });
  if (deadlineAt === undefined) return;
  const budget = state.rootRunBudgets.get(input.rootRunId)!;
  budget.deadlineTimer = setTimeout(
    () => {
      if (!state.rootRunBudgets.has(input.rootRunId)) return;
      expireRootRunBudget(state, budget);
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  budget.deadlineTimer.unref?.();
}

export function finishRootRunTurn(state: RegistryState, rootRunId: string): void {
  const budget = state.rootRunBudgets.get(rootRunId);
  if (!budget) return;
  budget.turnFinished = true;
  if (!hasActiveRootRunChildren(state, rootRunId)) deleteRootRunBudget(state, rootRunId);
}

export async function cancelRootRunChildren(
  state: RegistryState,
  rootRunId: string,
  reason?: unknown,
): Promise<void> {
  const active = [...state.tasks.values()].filter(
    (task) =>
      task.rootRunId === rootRunId &&
      (task.status === "running" || state.finalizingSubagentTasks.has(task.taskId)),
  );
  const activeIds = new Set(active.map((task) => task.taskId));
  const roots = active.filter((task) => {
    const parent = task.parentSessionId
      ? findTaskByChildSession(state, task.parentSessionId)
      : undefined;
    return !parent || !activeIds.has(parent.taskId);
  });
  await Promise.all(roots.map((task) => cancelSubagentSubtree(state, task.taskId, reason)));
}

export function expireRootRunBudget(state: RegistryState, budget: RootRunBudgetState): void {
  if (budget.expired) return;
  budget.expired = true;
  budget.onExhausted?.();
  budget.cancellationPromise = cancelRootRunChildren(
    state,
    budget.rootRunId,
    new RootRunDeadlineExceededError(budget.rootRunId),
  );
}

export async function cancelSubagentSubtree(
  state: RegistryState,
  taskId: string,
  reason: unknown = new Error(`Subagent task cancelled: ${taskId}`),
): Promise<RuntimeTaskSnapshot | undefined> {
  const taskIds = collectSubagentSubtree(state, taskId);
  const handles = taskIds.flatMap((id) => {
    const task = state.tasks.get(id);
    if (task?.childSessionId) state.closedSessionOwners.add(task.childSessionId);
    const handle = state.cancellationHandles.get(id) ?? state.finalizingSubagentTasks.get(id);
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
    : state.tasks.get(taskId);
}

export function beginSubagentTaskFinalization(state: RegistryState, taskId: string): boolean {
  if (state.finalizingSubagentTasks.has(taskId)) return false;
  state.finalizingSubagentTasks.set(taskId, state.cancellationHandles.get(taskId));
  return true;
}

export function isSubagentTaskFinalizing(state: RegistryState, taskId: string): boolean {
  return state.finalizingSubagentTasks.has(taskId);
}

export function finishSubagentTaskFinalization(
  state: RegistryState,
  taskId: string,
  cancellation: RuntimeTaskCancellationHandle,
): void {
  if (
    !state.finalizingSubagentTasks.has(taskId) ||
    state.finalizingSubagentTasks.get(taskId) !== cancellation
  ) {
    return;
  }
  state.finalizingSubagentTasks.delete(taskId);
  let current = state.tasks.get(taskId);
  if (current && !isTerminalRuntimeTask(current)) {
    // Finisher must never leave a terminal waiter blocked forever if an earlier finalizer step
    // threw before its terminal update. Preserve the failure as an explicit retryable task state.
    current = {
      ...current,
      status: "failed",
      completedAt: new Date(),
      error: "Subagent finalization ended without recording a terminal state.",
    };
    setTaskSnapshot(state, current);
    resolveIfTerminal(state, taskId, current);
  } else if (current) {
    current = compactTerminalSubagentSnapshot(current);
    setTaskSnapshot(state, current);
    // A settled child owner cannot admit descendants because its parent task is terminal.
    // Removing the close marker prevents one retained SessionId per completed tree node.
    if (current.childSessionId) state.closedSessionOwners.delete(current.childSessionId);
    resolveTerminalWaiters(state, taskId, current);
  }
  maybeReleaseRootRunBudget(state, current?.rootRunId);
  pruneArchivedTerminalSnapshots(state);
  notifyRegistryChanged(state);
}

export async function cancelSubagentChildren(
  state: RegistryState,
  parentSessionId: SessionId,
  reason: unknown = new Error(`Subagent owner closed: ${parentSessionId}`),
): Promise<void> {
  // Если предок уже закрыл владельца и ждёт всё поддерево, вложенное закрытие не запускает
  // второй каскад: иначе потомки повторно обходят и ожидают одну ветку, а линейная цепочка
  // приводит к квадратичному числу обходов.
  if (state.closedSessionOwners.has(parentSessionId)) return;
  state.closedSessionOwners.add(parentSessionId);
  const childIds = [...(state.subagentTaskIdsByParentSession.get(parentSessionId) ?? [])];
  await Promise.all(childIds.map((taskId) => cancelSubagentSubtree(state, taskId, reason)));
}
