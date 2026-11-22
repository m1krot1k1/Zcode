import type { SessionId, TurnId } from "@zcode/contracts";
import type { RegistryState } from "./registry-state.js";
import type { RootRunBudgetState } from "./registry-types.js";

export function hasActiveRootRunChildren(state: RegistryState, rootRunId: string): boolean {
  return [...state.tasks.values()].some(
    (task) =>
      task.rootRunId === rootRunId &&
      (task.status === "running" || state.finalizingSubagentTasks.has(task.taskId)),
  );
}

export function findActiveRootRunBudget(
  state: RegistryState,
  rootSessionId: SessionId,
  turnId: TurnId,
): RootRunBudgetState | undefined {
  for (const budget of state.rootRunBudgets.values()) {
    if (
      budget.rootSessionId === rootSessionId &&
      budget.turnId === turnId &&
      !budget.turnFinished
    ) {
      return budget;
    }
  }
  return undefined;
}

export function maybeReleaseRootRunBudget(
  state: RegistryState,
  rootRunId: string | undefined,
): void {
  if (!rootRunId) return;
  const budget = state.rootRunBudgets.get(rootRunId);
  if (budget?.turnFinished && !hasActiveRootRunChildren(state, rootRunId)) {
    deleteRootRunBudget(state, rootRunId);
  }
}

export function deleteRootRunBudget(state: RegistryState, rootRunId: string): void {
  const budget = state.rootRunBudgets.get(rootRunId);
  if (!budget) return;
  if (budget.deadlineTimer) clearTimeout(budget.deadlineTimer);
  state.rootRunBudgets.delete(rootRunId);
  state.finishedRootRunIds.add(rootRunId);
}

export function isRootRunBudgetExpired(state: RegistryState, rootRunId: string): boolean {
  const budget = state.rootRunBudgets.get(rootRunId);
  return (
    budget !== undefined &&
    (budget.expired || (budget.deadlineAt !== undefined && Date.now() >= budget.deadlineAt))
  );
}

export function getRootRunBudgetSnapshot(
  state: RegistryState,
  rootRunId: string,
):
  | {
      deadlineAt: number | undefined;
      maxParallel: number;
    }
  | undefined {
  const budget = state.rootRunBudgets.get(rootRunId);
  return budget
    ? {
        deadlineAt: budget.deadlineAt,
        maxParallel: budget.maxParallel,
      }
    : undefined;
}

export function waitForRootRunCancellation(state: RegistryState, rootRunId: string): Promise<void> {
  return state.rootRunBudgets.get(rootRunId)?.cancellationPromise ?? Promise.resolve();
}
