import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { ChatErrorBannerSurface } from "@/lib/chatErrorBannerTelemetry.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  handleFact,
  processPromptFact,
  acceptPromptSeed,
} from "@/v4/telemetry/supervisor/prompt.js";
import {
  awaitSendRender,
  flushReports,
  notifyUserInputRendered,
  recordComposerFocus,
  recordComposerFocusClick,
  recordComposerTextChange,
  recordSendClick,
  reportVisibleChatError,
  settleSendResult,
  type ConversationSendFailureReason,
} from "@/v4/telemetry/supervisor/sending.js";
import {
  SupervisorState,
  type AcceptedConversationPromptTelemetrySeed,
  type ConversationPromptTelemetrySeed,
  type SupervisorOptions,
} from "@/v4/telemetry/supervisor/state.js";

export { resolveSendAckSettlement } from "@/v4/telemetry/supervisor/sending.js";
export type { ConversationPromptTelemetrySeed } from "@/v4/telemetry/supervisor/state.js";

/**
 * renderer workspace 级 live telemetry 状态机。
 *
 * 它不读取 rows/snapshot，也不跟随 pane lease 销毁；React 只负责 attachment 和
 * foreground 引用，所有高频 fact 都进入这个命令式对象，避免 streaming 触发渲染。
 *
 * 状态与各领域逻辑分居 `supervisor/`：state（状态所有权）、budgets（有界缓存）、
 * events（事实→旧事件映射）、sending（发送漏斗与上报队列）、subagents（detached
 * 子会话账本）、terminal（轮次收口）、prompt（prompt 生命周期与事实路由）。
 * 本类只保留公开 API 与一次晚绑定，不承载状态。
 */
export class ConversationTelemetrySupervisor {
  private readonly state: SupervisorState;

  constructor(options: SupervisorOptions) {
    this.state = new SupervisorState(options);
    // terminal 收口后要唤醒同 task 的排队 prompt，而 terminal 位于更低层；
    // 用晚绑定打破 prompt ↔ terminal 的模块依赖环。
    this.state.processPromptFact = (lifecycle, fact, receivedAt, foregroundAtReceipt) =>
      processPromptFact(this.state, lifecycle, fact, receivedAt, foregroundAtReceipt);
  }

  recordComposerFocus(): void {
    recordComposerFocus(this.state);
  }

  recordComposerTextChange(nextText: string): void {
    recordComposerTextChange(this.state, nextText);
  }

  recordComposerFocusClick(input: { sessionId: string | null }): void {
    recordComposerFocusClick(this.state, input);
  }

  recordSendClick(input: {
    sessionId: string | null;
    seed: ConversationPromptTelemetrySeed;
    trigger: "button" | "shortcut";
  }): ConversationPromptTelemetrySeed {
    return recordSendClick(this.state, input);
  }

  settleSendResult(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId?: string;
    status: "success" | "fail";
    ackStatus?: string;
    reasonCode?: ConversationSendFailureReason;
    ackCostMs?: number;
    costMs?: number;
  }): void {
    settleSendResult(this.state, input);
  }

  awaitSendRender(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId: string;
    ackStatus: string;
  }): void {
    awaitSendRender(this.state, input);
  }

  notifyUserInputRendered(commandId: string): void {
    notifyUserInputRendered(this.state, commandId);
  }

  acceptPromptSeed(
    seed: AcceptedConversationPromptTelemetrySeed,
    options: { reportSendButton?: boolean } = {},
  ): void {
    acceptPromptSeed(this.state, seed, options);
  }

  attachForeground(owner: object, sessionId: string): () => void {
    return this.state.attachForeground(owner, sessionId);
  }

  handleFact(fact: ConversationTelemetryFact): void {
    handleFact(this.state, fact);
  }

  reportVisibleChatError(params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
  }): void {
    reportVisibleChatError(this.state, params);
  }

  /** 仅供有界缓存单测观察；业务逻辑不依赖此值。 */
  getPendingCommandCountForTest(): number {
    return this.state.pendingFactsByCommandId.size;
  }

  /** 仅供 focused tests 等待串行 reporter 清空。 */
  async flushReportsForTest(): Promise<void> {
    await flushReports(this.state);
  }

  dispose(): void {
    this.state.dispose();
  }
}
