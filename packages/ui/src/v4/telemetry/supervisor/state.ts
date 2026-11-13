import type {
  IPlatformService,
  LocalTtftContext,
  RemoteWorkspaceIdentityKind,
  ZCodeUsage,
} from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { PromptMessageSource, recordAgentStepTelemetryEvent } from "@/lib/messageTelemetry.js";
import { discardPromptTelemetry } from "@/lib/messageTelemetry.js";
import { clearStreamStallTracking } from "@/lib/uiPerfArmsTelemetry.js";
import { BoundedKeySet } from "@/v4/telemetry/supervisor/budgets.js";

type TelemetryPlatform = Pick<IPlatformService, "reportArmsCustomEvent" | "reportTelemetryEvent">;

export interface ConversationPromptTelemetrySeed {
  localTtft?: LocalTtftContext;
  /** 用户触发原始发送动作的 renderer 时钟。 */
  sendTime: number;
  /** 发送瞬间冻结的旧版模型/模式/套餐字段。 */
  extraDetail: Record<string, string>;
  /**
   * 发送漏斗关联 ID，配对 send_click ↔ send_result。仅 composer 真实点击产生；
   * 后台任务（off_peak / automation）seed 无此字段，落定时直接跳过不报。
   */
  sendClickId?: string;
  /** 是否中途经过队列二次确认弹窗（该子集的 send_cost_ms 含用户停留时间）。 */
  queueConfirmed?: boolean;
}

export interface AcceptedConversationPromptTelemetrySeed extends ConversationPromptTelemetrySeed {
  /** CLI 会话记录的开关；缺失保持未知，不能用实时设置补齐。 */
  memoryEnabled?: boolean;
  sessionId: string;
  sourceCommandId: string;
  /** 独立 background wake 的 completion 来源在 TurnStarted admission 时冻结。 */
  completionMessageSource?: PromptMessageSource;
}

export interface PromptLifecycle {
  sessionId: string;
  sourceCommandId: string;
  taskKey: string;
  sendTime: number;
  foregroundFirstTokenAt: number | null;
  legacyFirstTokenObserved: boolean;
  turnId?: string;
  active: boolean;
  lastErrorMessage?: string;
  completionMessageSource?: PromptMessageSource;
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  /** 本轮消费过 dynamic-workflow run 的通知（agent_composition 的 wf 维度）。 */
  hasWorkflowResult: boolean;
  startedToolCallIds: Set<string>;
  stepSourceDetail: Record<string, string>;
}

export interface BufferedFact {
  fact: ConversationTelemetryFact;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

export interface ForegroundSubagentUsage {
  agentId: string;
  parentCommandId: string;
  parentToolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  usage: ZCodeUsage | null;
  stopped: boolean;
  pendingFinalizedSteps: PendingFinalizedStep[];
}

/**
 * 一个 detached 子会话的埋点账本。两种来源共用：
 * - `background`：Agent 工具的后台子代理，登记自 `subagent.lifecycle`，终态是子会话自己的
 *   `turn.terminal` 或 `subagent.lifecycle(stopped)`；
 * - `workflow`：动态工作流子代理，登记自 `workflow.lifecycle(actor-spawned)`，终态**只有**
 *   `workflow.lifecycle(run-settled)`——子会话的每次 turn.terminal 只是一次 ask 的结束。
 */
export interface BackgroundSubagentTelemetry {
  kind: "background" | "workflow";
  /** 仅 workflow：所属 run（终态汇总 step 的 tool_call_id 用它收尾）。 */
  runId?: string;
  parentSessionId: string;
  sourceCommandId: string;
  parentToolCallId: string;
  childSessionId: string;
  agentId: string;
  taskKey: string;
  stepSourceDetail: Record<string, string>;
  startedToolCallIds: Set<string>;
  usageReported: boolean;
  openToolCallIds: Set<string>;
  startedAt: number;
  requestIds: string[];
  requestCount: number;
  usage: ZCodeUsage | null;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

export type FinalizedAgentStep = ReturnType<typeof recordAgentStepTelemetryEvent>[number];

export interface PendingFinalizedStep {
  step: FinalizedAgentStep;
  extraDetail?: Record<string, string>;
}

export interface DeferredTerminal {
  lifecycle: PromptLifecycle;
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

export interface ConversationTelemetryWorkspaceDetail {
  workspace_kind: "local" | "remote";
  remote_kind: RemoteWorkspaceIdentityKind | "";
}

/** ACK 已受理、等待用户消息渲染出来的一条待落定记录。 */
export interface PendingSendRenderWait {
  seed: ConversationPromptTelemetrySeed;
  sessionId: string | null;
  ackStatus: string;
  ackCostMs: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * prompt 生命周期处理入口。terminal 收口后需要唤醒同 task 的排队 prompt，
 * 但 terminal 位于更低层；因此由 supervisor 门面在构造时做一次晚绑定，
 * 不引入模块环。
 */
export type ProcessPromptFact = (
  lifecycle: PromptLifecycle,
  fact: ConversationTelemetryFact,
  receivedAt: number,
  foregroundAtReceipt: boolean,
) => void;

export interface SupervisorOptions {
  platform: TelemetryPlatform;
  workspaceScopeKey: string;
  workspaceTelemetryDetail?: ConversationTelemetryWorkspaceDetail;
  now?: () => number;
}

/**
 * renderer workspace 级 live telemetry 的可变状态。
 *
 * 所有高频 fact 都进入这个命令式对象，避免 streaming 触发渲染；各 supervisor/*
 * 模块只通过显式传入的 state 读写，不共享模块级可变变量。
 */
export class SupervisorState {
  readonly platform: TelemetryPlatform;
  readonly workspaceTelemetryDetail: ConversationTelemetryWorkspaceDetail | null;
  readonly workspaceScopeKey: string;
  readonly now: () => number;
  readonly eventIds = new BoundedKeySet();
  readonly acceptedCommandIds = new BoundedKeySet();
  readonly settledSendClickIds = new BoundedKeySet();
  readonly terminalKeys = new BoundedKeySet();
  readonly compactionKeys = new BoundedKeySet();
  readonly foregroundOwnerSessions = new Map<object, string>();
  readonly foregroundSessionCounts = new Map<string, number>();
  readonly lifecyclesByCommandId = new Map<string, PromptLifecycle>();
  readonly activeCommandBySessionId = new Map<string, string>();
  readonly commandIdByTurnKey = new Map<string, string>();
  readonly pendingFactsByCommandId = new Map<string, BufferedFact[]>();
  readonly foregroundSubagentUsageByChildSession = new Map<string, ForegroundSubagentUsage>();
  /** 每个在飞 run 已登记的子代理会话（run-settled 时逐个结算）。 */
  readonly workflowActorsByRun = new Map<string, Set<string>>();
  readonly backgroundSubagentTelemetryByChildSession = new Map<
    string,
    BackgroundSubagentTelemetry
  >();
  readonly deferredTerminalsByCommandId = new Map<string, DeferredTerminal>();
  readonly pendingSendRenderWaits = new Map<string, PendingSendRenderWait>();
  reportTail: Promise<void> | null = null;
  disposed = false;
  processPromptFact: ProcessPromptFact = () => undefined;

  constructor(options: SupervisorOptions) {
    this.platform = options.platform;
    this.workspaceTelemetryDetail = options.workspaceTelemetryDetail ?? null;
    this.workspaceScopeKey = options.workspaceScopeKey;
    this.now = options.now ?? Date.now;
  }

  taskKey(sessionId: string): string {
    return `${this.workspaceScopeKey}\u0000${sessionId}`;
  }

  isForeground(sessionId: string): boolean {
    return (this.foregroundSessionCounts.get(sessionId) ?? 0) > 0;
  }

  /** 同一 session 多 pane 可见仍只记一份 foreground；不同 session 可同时可见。 */
  attachForeground(owner: object, sessionId: string): () => void {
    if (this.disposed) return () => undefined;
    const previous = this.foregroundOwnerSessions.get(owner);
    if (previous === sessionId) return () => this.detachForeground(owner);
    if (previous) this.decrementForeground(previous);
    this.foregroundOwnerSessions.set(owner, sessionId);
    this.foregroundSessionCounts.set(
      sessionId,
      (this.foregroundSessionCounts.get(sessionId) ?? 0) + 1,
    );
    return () => this.detachForeground(owner);
  }

  resolveCommandId(fact: ConversationTelemetryFact): string | undefined {
    if (fact.sourceCommandId) return fact.sourceCommandId;
    return fact.turnId
      ? this.commandIdByTurnKey.get(`${fact.sessionId}\u0000${fact.turnId}`)
      : this.activeCommandBySessionId.get(fact.sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lifecycle of this.lifecyclesByCommandId.values()) {
      clearStreamStallTracking(lifecycle.taskKey);
      discardPromptTelemetry(lifecycle.taskKey);
    }
    for (const child of this.backgroundSubagentTelemetryByChildSession.values()) {
      discardPromptTelemetry(child.taskKey);
    }
    // 待渲染的定时器不清会在卸载后继续跑，落定一批没有意义的 render_timeout。
    for (const wait of this.pendingSendRenderWaits.values()) {
      clearTimeout(wait.timer);
    }
    this.pendingSendRenderWaits.clear();
    this.eventIds.clear();
    this.acceptedCommandIds.clear();
    this.settledSendClickIds.clear();
    this.terminalKeys.clear();
    this.compactionKeys.clear();
    this.foregroundSubagentUsageByChildSession.clear();
    this.backgroundSubagentTelemetryByChildSession.clear();
    this.workflowActorsByRun.clear();
    this.deferredTerminalsByCommandId.clear();
    this.foregroundOwnerSessions.clear();
    this.foregroundSessionCounts.clear();
    this.lifecyclesByCommandId.clear();
    this.activeCommandBySessionId.clear();
    this.commandIdByTurnKey.clear();
    this.pendingFactsByCommandId.clear();
  }

  private detachForeground(owner: object): void {
    const sessionId = this.foregroundOwnerSessions.get(owner);
    if (!sessionId) return;
    this.foregroundOwnerSessions.delete(owner);
    this.decrementForeground(sessionId);
  }

  private decrementForeground(sessionId: string): void {
    const next = (this.foregroundSessionCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) {
      this.foregroundSessionCounts.set(sessionId, next);
      return;
    }
    this.foregroundSessionCounts.delete(sessionId);
    // 切走期间的墙钟时间不能被下一次回前台误判为 stream stall。
    clearStreamStallTracking(this.taskKey(sessionId));
  }
}
