import { CompactTrigger, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import { createCompactRapidRefillError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  evaluateRapidRefill,
  getTurnTools,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

/**
 * Реактивный compact после ошибки контекста.
 *
 * Вынесено из turn-model-step.ts: файл перешёл порог 800 строк, а эта ветка —
 * самодостаточный шаг с собственными инвариантами (одна попытка на model step,
 * breaker быстрых повторных заполнений, пересоздание turn machine).
 */
export async function recoverModelStepAfterContextExceeded(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  contextError: unknown,
  modelStepIndex: number,
  activeEntries: readonly RuntimeMessageEntry[],
): Promise<boolean> {
  if (state.reactiveCompactAttemptedInCurrentModelStep) {
    return false;
  }

  const rapidRefill = evaluateRapidRefill(state.compactTracking);
  if (rapidRefill.shouldBlock) {
    this.logger?.warn("Reactive compact rapid-refill breaker tripped", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "compact.rapid_refill_breaker",
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      modelStepIndex,
      module: "core.runtime",
      status: "failed",
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Reactive,
    });
    throw createCompactRapidRefillError({
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
      toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
    });
  }

  state.reactiveCompactAttemptedInCurrentModelStep = true;
  const compactOutcome = await this.reactiveCompactAfterContextExceeded(
    contextError,
    state.turnTraceContext,
    state.events,
    state.turnAbortSignal,
    {
      activeEntries,
      modelStepIndex,
      agentListingTools: getTurnTools(this, state),
      rapidRefillCount: rapidRefill.consecutiveRapidRefills,
      model: state.model,
      turnRequestState: state.turnRequestState,
      getContinuationTools: () => getTurnTools(this, state),
    },
  );
  if (compactOutcome !== "compacted") {
    return false;
  }

  recordCompactSuccess(state, rapidRefill);
  recordCompactHistoryRound(state);
  state.turnMachine = new TurnMachineImpl(
    TurnMachineImpl.create(
      this.sessionId,
      this.turnNumber,
      state.input,
      state.traceId,
      state.turnId,
    ).start(),
  );
  return true;
}
