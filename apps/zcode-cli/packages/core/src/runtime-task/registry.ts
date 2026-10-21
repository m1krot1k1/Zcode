import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentOutput } from "@zcode/contracts";

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
  /** 内存执行归属；重启不会恢复闲时后台任务。 */
  offPeakExecutionId?: string;
  offPeakCancelled?: boolean;
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  /** 根 runtime session；子任务由唯一 registry 传播此归属。 */
  rootSessionId?: SessionId;
  /** 同一根会话内一轮 coordinator turn 的稳定配额范围。 */
  rootRunId?: string;
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
        | "lineage_conflict"
        | "owner_closed"
        | "parent_stopped"
        | "task_already_running"
        | "task_finalizing"
        | "total_limit";
    };

export const SUBAGENT_ROOT_MAX_TASKS = 128;
/** Across all root runs in one session; background children can outlive their launch turn. */
export const SUBAGENT_ROOT_MAX_ACTIVE_TASKS = 24;

export interface RuntimeTaskRegistry {
  subscribe?(listener: () => void): () => void;
  setOffPeakExecutionId?(executionId: string | undefined): void;
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(
    id: string,
    message: RuntimeTaskPendingMessage,
  ): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  registerSubagentTask(
    task: RuntimeTaskSnapshot,
    cancellation: RuntimeTaskCancellationHandle,
  ): RuntimeTaskAdmissionResult;
  releaseSubagentCancellationHandle(
    taskId: string,
    cancellation: RuntimeTaskCancellationHandle,
  ): void;
  cancelSubagentSubtree(
    taskId: string,
    reason?: unknown,
  ): Promise<RuntimeTaskSnapshot | undefined>;
  beginSubagentTaskFinalization(taskId: string): boolean;
  isSubagentTaskFinalizing(taskId: string): boolean;
  cancelSubagentChildren(
    parentSessionId: SessionId,
    reason?: unknown,
  ): Promise<void>;
  openSessionOwner(sessionId: SessionId): void;
  getRootSessionIdForSession(sessionId: SessionId): SessionId;
  getBranchGenerationForSession(sessionId: SessionId): number;
  setBranchGenerationForSession(sessionId: SessionId, generation: number): void;
  remove(id: string): void;
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
}

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
  private readonly backgroundWaiters = new Map<
    string,
    Set<RuntimeTaskWaiter>
  >();
  private readonly cancellationHandles = new Map<
    string,
    RuntimeTaskCancellationHandle
  >();
  private readonly finalizingSubagentTasks = new Map<
    string,
    RuntimeTaskCancellationHandle | undefined
  >();
  private readonly closedSessionOwners = new Set<SessionId>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  register(task: RuntimeTaskSnapshot): void {
    const ownerSessionId = task.ownerSessionId ?? task.parentSessionId;
    const stamped = {
      ...task,
      ...((task.offPeakExecutionId ?? this.offPeakExecutionId)
        ? {
            offPeakExecutionId:
              task.offPeakExecutionId ?? this.offPeakExecutionId,
          }
        : {}),
      branchGeneration:
        task.branchGeneration ??
        (ownerSessionId ? this.branchGenerations.get(ownerSessionId) : undefined) ??
        this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
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
    if (
      (existing?.rootSessionId && existing.rootSessionId !== rootSessionId) ||
      [...this.tasks.values()].some(
        (candidate) =>
          candidate.type === "local_agent" &&
          candidate.childSessionId === task.childSessionId &&
          candidate.taskId !== task.taskId,
      )
    ) {
      return { accepted: false, reason: "lineage_conflict" };
    }
    // SendMessage resume keeps the existing node in its original root run, even though the
    // coordinator request that resumed it may have a newer turn id.
    const rootRunId =
      existing?.rootSessionId === rootSessionId && existing.rootRunId
        ? existing.rootRunId
        : (parentTask?.rootRunId ?? makeRootRunId(rootSessionId, task.turnId));

    const currentRunTasks = [...this.tasks.values()].filter(
      (candidate) => candidate.rootRunId === rootRunId,
    );
    const priorSameRunTask =
      existing?.rootRunId === rootRunId ? existing : undefined;
    const totalBeforeAdmission =
      currentRunTasks.length - (priorSameRunTask ? 1 : 0);
    if (totalBeforeAdmission >= SUBAGENT_ROOT_MAX_TASKS) {
      return { accepted: false, reason: "total_limit" };
    }
    const activeBeforeAdmission = [...this.tasks.values()].filter(
      (candidate) =>
        candidate.type === "local_agent" &&
        candidate.rootSessionId === rootSessionId &&
        candidate.taskId !== task.taskId &&
        candidate.status === "running",
    ).length;
    if (activeBeforeAdmission >= SUBAGENT_ROOT_MAX_ACTIVE_TASKS) {
      return { accepted: false, reason: "active_limit" };
    }

    const stamped: RuntimeTaskSnapshot = {
      ...task,
      // A node inherits its immediate owner session generation; descendants may rewind locally
      // without mutating the root generation or sibling branches.
      branchGeneration: this.branchGenerations.get(parentSessionId) ?? 0,
      rootRunId,
      rootSessionId,
    };
    this.tasks.set(stamped.taskId, stamped);
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
      if (task?.childSessionId)
        this.closedSessionOwners.add(task.childSessionId);
      const handle = this.cancellationHandles.get(id);
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
    const targetSettlement = settlements.find(
      (settlement) => settlement.id === taskId,
    );
    return isRuntimeTaskSnapshot(targetSettlement?.snapshot)
      ? targetSettlement.snapshot
      : this.tasks.get(taskId);
  }

  beginSubagentTaskFinalization(taskId: string): boolean {
    if (this.finalizingSubagentTasks.has(taskId)) return false;
    this.finalizingSubagentTasks.set(
      taskId,
      this.cancellationHandles.get(taskId),
    );
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
      this.tasks.set(taskId, current);
      this.resolveIfTerminal(taskId, current);
    } else if (current) {
      this.resolveTerminalWaiters(taskId, current);
    }
    this.changed();
  }

  async cancelSubagentChildren(
    parentSessionId: SessionId,
    reason: unknown = new Error(`Subagent owner closed: ${parentSessionId}`),
  ): Promise<void> {
    this.closedSessionOwners.add(parentSessionId);
    const childIds = [...this.tasks.values()]
      .filter(
        (task) =>
          task.type === "local_agent" &&
          task.parentSessionId === parentSessionId,
      )
      .map((task) => task.taskId);
    await Promise.all(
      childIds.map((taskId) => this.cancelSubagentSubtree(taskId, reason)),
    );
  }

  openSessionOwner(sessionId: SessionId): void {
    this.closedSessionOwners.delete(sessionId);
  }

  getRootSessionIdForSession(sessionId: SessionId): SessionId {
    return this.findTaskByChildSession(sessionId)?.rootSessionId ?? sessionId;
  }

  getBranchGenerationForSession(sessionId: SessionId): number {
    return this.branchGenerations.get(sessionId) ?? 0;
  }

  setBranchGenerationForSession(
    sessionId: SessionId,
    generation: number,
  ): void {
    this.branchGenerations.set(sessionId, generation);
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  private findTaskByChildSession(
    sessionId: SessionId,
  ): RuntimeTaskSnapshot | undefined {
    return [...this.tasks.values()].find(
      (task) =>
        task.type === "local_agent" && task.childSessionId === sessionId,
    );
  }

  private wouldCreateSubagentCycle(
    parentSessionId: SessionId,
    childSessionId: SessionId,
  ): boolean {
    let currentSessionId: SessionId | undefined = parentSessionId;
    const seen = new Set<SessionId>();
    while (currentSessionId && !seen.has(currentSessionId)) {
      if (currentSessionId === childSessionId) return true;
      seen.add(currentSessionId);
      currentSessionId =
        this.findTaskByChildSession(currentSessionId)?.parentSessionId;
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
        for (const child of this.tasks.values()) {
          if (
            child.type === "local_agent" &&
            child.parentSessionId === childSessionId
          ) {
            pending.push(child.taskId);
          }
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
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    this.changed();
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    this.changed();
    return true;
  }

  remove(id: string): void {
    this.tasks.delete(id);
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

  queueMessage(
    id: string,
    message: RuntimeTaskPendingMessage,
  ): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0)
      return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
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
    if (
      !this.finalizingSubagentTasks.has(id) &&
      (!current || isTerminalRuntimeTask(current))
    )
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

  private resolveBackgroundWaiters(
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
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

function makeRootRunId(
  rootSessionId: SessionId,
  turnId: TurnId | undefined,
): string {
  return `${rootSessionId}:${turnId ?? "session"}`;
}

export function isTerminalRuntimeTask(
  task: Pick<RuntimeTaskSnapshot, "status">,
): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

function isRuntimeTaskSnapshot(
  value: void | RuntimeTaskSnapshot | undefined,
): value is RuntimeTaskSnapshot {
  return typeof value === "object" && value !== null && "taskId" in value;
}

export function hasRunningBackgroundRuntimeTask(
  registry: RuntimeTaskRegistry,
): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
