import type { SessionId } from "@zcode/contracts";
import type { WorkLedger } from "./work-ledger.js";
import type {
  RootRunBudgetState,
  RuntimeTaskCancellationHandle,
  RuntimeTaskSnapshot,
  RuntimeTaskWaiter,
} from "./registry-types.js";

/**
 * Единственный мутабельный state registry. Доменные функции получают его явным первым
 * параметром, поэтому класс остаётся тонкой точкой входа без скрытого `this`-контекста.
 */
export interface RegistryState {
  readonly workLedger: WorkLedger | undefined;
  workLedgerSweepTimer: ReturnType<typeof setInterval> | undefined;
  offPeakExecutionId: string | undefined;
  readonly listeners: Set<() => void>;
  activeBranchGeneration: number;
  readonly branchGenerations: Map<SessionId, number>;
  readonly backgroundWaiters: Map<string, Set<RuntimeTaskWaiter>>;
  readonly cancellationHandles: Map<string, RuntimeTaskCancellationHandle>;
  readonly finalizingSubagentTasks: Map<string, RuntimeTaskCancellationHandle | undefined>;
  readonly closedSessionOwners: Set<SessionId>;
  readonly tasks: Map<string, RuntimeTaskSnapshot>;
  readonly terminalSubagentTaskIds: Set<string>;
  readonly archivedTerminalTaskAttempts: Set<string>;
  readonly subagentTaskIdByChildSession: Map<SessionId, string>;
  readonly subagentTaskIdsByParentSession: Map<SessionId, Set<string>>;
  readonly activeSubagentTaskIdsByRootSession: Map<SessionId, Set<string>>;
  readonly terminalWaiters: Map<string, Set<RuntimeTaskWaiter>>;
  /** Ожидающие освобождения worker-слота; резолвятся при терминальном переходе/снятии задачи. */
  readonly capacityWaiters: Set<() => void>;
  readonly rootRunBudgets: Map<string, RootRunBudgetState>;
  // Root runs whose budget was deliberately released after turn finish. A terminal
  // task from such a run cannot be resumed without a fresh budget.
  readonly finishedRootRunIds: Set<string>;
}

export function createRegistryState(workLedger: WorkLedger | undefined): RegistryState {
  return {
    workLedger,
    workLedgerSweepTimer: undefined,
    offPeakExecutionId: undefined,
    listeners: new Set(),
    activeBranchGeneration: 0,
    branchGenerations: new Map(),
    backgroundWaiters: new Map(),
    cancellationHandles: new Map(),
    finalizingSubagentTasks: new Map(),
    closedSessionOwners: new Set(),
    tasks: new Map(),
    terminalSubagentTaskIds: new Set(),
    archivedTerminalTaskAttempts: new Set(),
    subagentTaskIdByChildSession: new Map(),
    subagentTaskIdsByParentSession: new Map(),
    activeSubagentTaskIdsByRootSession: new Map(),
    terminalWaiters: new Map(),
    capacityWaiters: new Set(),
    rootRunBudgets: new Map(),
    finishedRootRunIds: new Set(),
  };
}

export function notifyRegistryChanged(state: RegistryState): void {
  for (const listener of state.listeners) listener();
}
