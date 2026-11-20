import { availableParallelism, totalmem } from "node:os";
import type {
  AgentOutput,
  ModelUsage,
  PrismTaskAcceptanceDecision,
  PrismTaskContract,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { WorkLedger } from "./work-ledger.js";

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

/** Own usage plus every admitted descendant, without double counting. */
export interface RuntimeTaskSubtreeUsage {
  totalTokens?: number;
  totalDurationMs?: number;
  toolUseCount?: number;
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
  /** @deprecated Legacy persisted value; it is read for compatibility but never gates or grants runtime work. */
  spawnGrant?: number;
  /** 嵌套层级；仅记录，不参与准入判定。 */
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
  /** Immediate parent subagent task; absent for a task spawned directly by the root turn. */
  parentTaskId?: string;
  /** Workspace спавна; вместе с agentId задаёт область claim'а в work ledger. */
  workspacePath?: string;
  /**
   * Может ли профиль задачи писать файлы (Write/Edit в его tools).
   * `false` — read-only роль: пути из prompt описывают область исследования, а не запись,
   * поэтому claim не создаётся и не проверяется на конфликты. `undefined` — legacy-поведение.
   */
  writeCapable?: boolean;
  /**
   * Explicit write scope declared by the caller. When present (including an empty
   * array), the registrar uses it instead of extracting paths from the prompt.
   * This prevents a shared orchestrator plan in the prompt from creating false
   * cross-branch conflicts.
   */
  writePaths?: readonly string[];
  /** Режим изоляции файловых правок субагента (shared-locked | git-worktree). */
  isolationMode?: import("@zcode/contracts").SubagentIsolationMode;
}

export const MAX_RETAINED_TERMINAL_SUBAGENT_SNAPSHOTS = 512;

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
        | "root_run_finished"
        | "lineage_conflict"
        | "owner_closed"
        | "parent_stopped"
        | "task_already_running"
        | "task_finalizing"
        /** Пути задачи пересекаются с живым claim'ом другого агента. */
        | "write_claim_conflict"
        /** Write-capable роль не объявила write_paths: запись нельзя ограничить. */
        | "write_scope_required"
        /** Ledger подключён, но чтение/запись claim'а недоступны (fail-closed). */
        | "work_claim_unavailable";
    };

/**
 * Дефолтный параллелизм субагентов.
 *
 * Раньше ёмкость равнялась числу ядер. Этого недостаточно: каждый субагент запускает
 * shell-процессы, и на 16 ГБ / 10 ядрах 112 одновременных агентов упёрлись в
 * `kern.maxprocperuid`, дав `spawn /bin/zsh EAGAIN`. Watchdog тогда ещё был выключен,
 * поэтому агенты висели часами.
 *
 * Теперь потолок — минимум из двух оценок: CPU и доступная память (1 ГБ на агента).
 * На 16 ГБ это 6 слотов вместо прежних 10: каждый агент запускает shell, файловые
 * операции и отдельный model-запрос, поэтому 512 МБ на агента давали thrashing.
 * Явная настройка пользователя по-прежнему может только уменьшать потолок.
 */
export function resolveAdaptiveSubagentMaxParallel(
  cpuCount = availableParallelism(),
  host: { totalMemoryBytes?: number } = readHostCapacity(),
): number {
  const safeCpuCount =
    Number.isSafeInteger(cpuCount) && cpuCount > 0 ? cpuCount : availableParallelism();
  const cpuBound = Math.max(1, safeCpuCount);

  const memoryBound = resolveMemoryBoundAgentCount(host);
  // Память недоступна (нестандартная платформа) — не ограничиваем ниже CPU.
  const effective = memoryBound === undefined ? cpuBound : Math.min(cpuBound, memoryBound);
  return Math.max(1, effective);
}

const AGENT_MEMORY_FOOTPRINT_BYTES = 1024 * 1024 * 1024;
/** 40% RAM: остальное — Host, Electron, code index и файловый кэш ОС. */
const AGENT_MEMORY_BUDGET_RATIO = 0.4;

function resolveMemoryBoundAgentCount(host: { totalMemoryBytes?: number }): number | undefined {
  const total = host.totalMemoryBytes;
  if (!Number.isFinite(total) || (total ?? 0) <= 0) return undefined;
  const budget = Math.floor((total as number) * AGENT_MEMORY_BUDGET_RATIO);
  return Math.max(1, Math.floor(budget / AGENT_MEMORY_FOOTPRINT_BYTES));
}

function readHostCapacity(): { totalMemoryBytes?: number } {
  return { totalMemoryBytes: totalmem() };
}

export function resolveSubagentMaxParallel(configured?: number): number {
  const hostCapacity = resolveAdaptiveSubagentMaxParallel();
  if (configured === undefined || configured === 0) return hostCapacity;
  if (!Number.isSafeInteger(configured) || configured < 1) return hostCapacity;
  // Настройка может только уменьшить фактическую ёмкость CPU, но не создавать
  // параллелизм выше ресурсов хоста.
  return Math.min(configured, hostCapacity);
}

export interface RuntimeTaskRegistry {
  /**
   * Реестр работ, в который этот registry объявляет claim'ы подзадач. Отсутствует —
   * wiring выключен (тесты и встраиваемые хосты без реестра).
   */
  readonly workLedger?: WorkLedger;
  subscribe?(listener: () => void): () => void;
  setOffPeakExecutionId?(executionId: string | undefined): void;
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  isTerminalTaskArchived?(taskId: string, attemptId: string): boolean;
  markTerminalTaskArchived?(taskId: string, attemptId: string): void;
  getSubagentTaskByChildSession(sessionId: SessionId): RuntimeTaskSnapshot | undefined;
  /** Own usage plus all admitted descendants; undefined when the task is unknown. */
  getSubtreeUsage(
    taskId: string,
    ownUsage?: RuntimeTaskUsageSnapshot,
  ): RuntimeTaskSubtreeUsage | undefined;
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
  /** Остаток spawn-бюджета конкретного session в root run; undefined — root-run состояния нет. */
  getRemainingSpawnBudget?(rootRunId: string, sessionId: SessionId): number | undefined;
  /** Разрешённая параллельность конкретного root run после settings/adaptive resolution. */
  getRootRunMaxParallel?(rootRunId: string): number | undefined;
  /** Текущее число активных worker-слотов root session (для фактического maxParallel). */
  getActiveSubagentWorkItemCount?(rootSessionId: SessionId): number;
  /** Возвращает, учитывается ли текущая роль как занятый слот в том же admission projection. */
  isActiveSubagentWorkItem?(taskId: string): boolean;
  /** Останавливает process-level таймеры registry (periodic sweep ledger). */
  dispose?(): void;
  /** Продлевает claim'ы живых running local_agent задач (перед periodic sweep). */
  heartbeatActiveWorkClaims?(now?: number): void;
  /** Heartbeat живых задач + материализация протухших claim'ов в `stale`. */
  sweepWorkLedger?(now?: number): void;
  getBranchGenerationForSession(sessionId: SessionId): number;
  setBranchGenerationForSession(sessionId: SessionId, generation: number): void;
  remove(id: string): void;
  /** Returns false without changing state when backgrounding would exceed root-session worker capacity. */
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
  /**
   * Ожидание изменения доступной ёмкости worker-слотов.
   *
   * Причина: admission отказывал мгновенно `active_limit`, и модель тратила целый
   * дополнительный запрос, чтобы повторить Task. Рантайм должен ждать освобождения
   * слота сам, а не превращать перегрузку в ошибку.
   */
  waitForCapacityChange(options?: { signal?: AbortSignal }): Promise<void>;
  // Исправление: optional hooks могли молча отключить budget; интерфейс теперь требует весь lifecycle.
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
  }): void;
  finishRootRunTurn(rootRunId: string): void;
  waitForRootRunCancellation(rootRunId: string): Promise<void>;
}

export interface RootRunBudgetState {
  rootRunId: string;
  /** undefined — срок не задан; root выполняется до Stop или завершения turn. */
  deadlineAt: number | undefined;
  rootSessionId: SessionId;
  turnId: TurnId;
  /** Immutable concurrency ceiling captured when this root run is admitted. */
  maxParallel: number;
  turnFinished: boolean;
  expired: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  onExhausted?: () => void;
  cancellationPromise?: Promise<void>;
}

export interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

export interface InMemoryRuntimeTaskRegistryOptions {
  /** Единственный владелец реестра работ; без него claim'ы не создаются. */
  workLedger?: WorkLedger;
}

export const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

export function isRuntimeTaskSnapshot(
  value: void | RuntimeTaskSnapshot | undefined,
): value is RuntimeTaskSnapshot {
  return typeof value === "object" && value !== null && "taskId" in value;
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

export function makeRootRunId(rootSessionId: SessionId, turnId: TurnId | undefined): string {
  return `${rootSessionId}:${turnId ?? "session"}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isBoundedIdentifier(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/\p{Cc}/u.test(value) &&
    utf8ByteLength(value) <= maxBytes
  );
}

export function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    utf8ByteLength(value) <= maxBytes
  );
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPositiveSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
