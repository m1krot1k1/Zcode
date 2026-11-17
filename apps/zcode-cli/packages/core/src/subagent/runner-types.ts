// Subagent runner: публичные контракты, общий контекст фабрики и разделяемые типы.

import type { GetAgentDefinitions } from "./definitions.js";
import {
  type BackgroundResultOriginMeta,
  type AgentCompletedOutput,
  type AgentOutput,
  type Logger,
  type SessionEvent,
  type SessionId,
  type SubagentExecutionBudget,
  type SubagentIsolationMode,
  type SubagentPort,
  type SubagentRunOptions,
  type SwarmNodeResult,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentProfile } from "./profile.js";
import {
  type RuntimeTaskMessageSink,
  type RuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../runtime-task/registry.js";

export interface ExploreSubagentRuntimeRequest {
  agentId: string;
  agentType: string;
  allowedTools: readonly string[];
  /** 每次读取都返回 runtime task registry 的当前 foreground/background 状态。 */
  background: boolean;
  disallowedTools?: readonly string[];
  sessionId: SessionId;
  description: string;
  maxTurns?: number;
  /** child session 已持久化且可被 projection/query 读取后、首次模型执行前调用。 */
  onSessionReady?: (info?: { reasoningLevel?: string }) => Promise<void>;
  permissionMode?: AgentProfile["permissionMode"];
  prompt: string;
  profile: AgentProfile;
  registerMessageSink?: (sink: RuntimeTaskMessageSink) => void;
  reportActivity?: () => void;
  resumeFromStore?: boolean;
  systemPrompt?: string;
  /** Относительный класс effort, выбранный родителем для этого спавна. */
  effort?: string;
  /** Explicit capability gate from Agent/Task; also grants named MCP access. */
  requiredCapabilities?: readonly string[];
  /** Явное разрешение поднять ребёнка выше уровня родителя. */
  effortAboveParent?: boolean;
  /** Фактический параллелизм, рассчитанный по доступной ёмкости runtime. */
  maxParallel?: number;
  /** 本 child 的嵌套层级；仅记录，不设硬上限。 */
  level?: number;
  workingDirectory: string;
  workspaceRoot: string;
  /** Опциональные пути чтения, декларированные родителем/DAG-узлом. */
  readPaths?: readonly string[];
  /** Явно объявленный родителем write-scope; наследуется child runtime. */
  writePaths?: readonly string[];
  /** Режим изоляции файловых правок: общий workspace с FileLockRegistry или отдельный git worktree. */
  isolationMode?: SubagentIsolationMode;
  /** Жёсткий бюджет выполнения субагента (шаги, входные токены, wall-time). */
  budget?: SubagentExecutionBudget;
  traceContext: TraceContext;
}

export interface ExploreSubagentRuntimeResult {
  response: string;
  traceId: TraceContext["traceId"];
  events: SessionEvent[];
  /** Фактический уровень ребёнка после резолва класса effort. */
  reasoningLevel?: string;
}

export interface CompletedAgentRun {
  events: SessionEvent[];
  evidenceEvents: SessionEvent[];
  output: AgentCompletedOutput;
}

export interface ParentTaskNotificationCommand {
  originMeta: BackgroundResultOriginMeta;
  text: string;
  traceContext: TraceContext;
  taskId: string;
}

export type EnqueueParentTaskNotification = (
  notification: ParentTaskNotificationCommand,
) => undefined;

export interface ExploreSubagentPortOptions {
  runExploreAgent: (
    request: ExploreSubagentRuntimeRequest,
    options?: SubagentRunOptions,
  ) => Promise<ExploreSubagentRuntimeResult>;
  emitParentEvent: (event: SessionEvent, traceContext: TraceContext) => Promise<void>;
  /** Reads child Host events around one execution; evaluator never trusts worker text. */
  getChildEventCursor?: (sessionId: SessionId) => Promise<number>;
  getChildEventsAfter?: (sessionId: SessionId, cursor: number) => Promise<SessionEvent[]>;
  // background completion 必须同步写入父 runtime command queue；
  // 返回 undefined 可让 TypeScript 拒绝 async enqueue，避免 fake-notified。
  enqueueParentTaskNotification?: EnqueueParentTaskNotification;
  outputRootDir?: string;
  profiles?: readonly AgentProfile[];
  getAgentDefinitions?: GetAgentDefinitions;
  builtInModelSelectionOverrides?: Partial<
    Record<"general-purpose" | "Explore", import("@zcode/shared").ModelSelection>
  >;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /** Root-run concurrency ceiling; zero/undefined resolves adaptively. */
  maxParallel?: number;
  persistTerminalTaskCatalog?: (task: RuntimeTaskSnapshot) => Promise<boolean>;
  resolveTerminalTaskCatalog?: (taskId: string) => Promise<RuntimeTaskSnapshot | undefined>;
  createAgentId?: () => string;
  getAllowedTools?: (profile: AgentProfile) => readonly string[];
  /**
   * Эффективная tool surface родителя (built-ins ∪ делегируемый набор).
   * `undefined` сохраняет прежнее поведение: write-capability выводится только из профиля.
   */
  parentToolNames?: readonly string[];
  /** Hard deadline конкретной задачи; undefined — без deadline. */
  getTaskTimeoutMs?: (agentType: string) => number | undefined;
  inactivityTimeoutMs?: number;
  autoBackgroundMs?: number;
  logger?: Logger;
}

/** Внутренние capacity-поля DAG run: не входят в публичный контракт SubagentRunOptions. */
interface InternalDagParallelismOptions {
  internalActiveCount?: number;
  internalActiveCap?: number;
}

export type InternalDagRunOptions = SubagentRunOptions & InternalDagParallelismOptions;

export type SubagentDagNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export interface SubagentDagNodeResult {
  status: SubagentDagNodeStatus;
  output?: AgentCompletedOutput;
  outputTruncated?: boolean;
  error?: string;
  waveIndex?: number;
  structuredResult?: SwarmNodeResult;
}

export interface SettledSubagentDagNode {
  nodeId: string;
  output?: AgentOutput;
  error?: unknown;
}

export interface SubagentLifecycle {
  agentId: string;
  childSessionId: SessionId;
  metadataFile: string;
  outputFile: string;
  taskOutputFile: string;
  profile: AgentProfile;
  startedAt: number;
  runTraceContext: TraceContext;
  childTraceContext: TraceContext;
}

export const BACKGROUND_AGENT_STOPPED_STATE = {
  backgroundEventStatus: "cancelled",
  message: "Background agent task stopped.",
  notificationStatus: "stopped",
  registryStatus: "killed",
  subagentEventStatus: "stopped",
} as const;

/** Единый контекст фабрики: состояние и зависимости, общие для всех доменов runner. */
export interface ExploreRunnerContext {
  options: ExploreSubagentPortOptions;
  registry: RuntimeTaskRegistry;
  borrowedForegroundAgentIds: Set<string>;
  getProfiles: () => readonly AgentProfile[];
  autoBackgroundMs: number | undefined;
}

export type ExploreSubagentPort = SubagentPort & {
  start: NonNullable<SubagentPort["start"]>;
};
