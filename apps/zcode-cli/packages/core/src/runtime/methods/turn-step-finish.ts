import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import { toTokenUsageInfo } from "../helpers/index.js";
import { calculateRuntimeModelCost } from "../helpers/model-cost.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export async function persistToolModelStepFinish(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<void> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed turn step finish requires the loop Model");
  }
  const tokens = toTokenUsageInfo(options.result.usage);
  const cost = calculateRuntimeModelCost(model.modelId, tokens);
  const stepDiagnostics = state.lastStepDiagnostics
    ? {
        ...state.lastStepDiagnostics,
        stateTransitions: [...(state.turnMachine.state.stateTransitions ?? [])],
      }
    : undefined;
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      ...(stepDiagnostics?.rawFinishReason ? { rawReason: stepDiagnostics.rawFinishReason } : {}),
      ...(cost !== undefined ? { cost } : {}),
      tokens,
      ...(stepDiagnostics ? { stepDiagnostics } : {}),
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      finishReason: options.result.finishReason,
      ...(stepDiagnostics?.rawFinishReason
        ? { rawFinishReason: stepDiagnostics.rawFinishReason }
        : {}),
      ...(stepDiagnostics ? { stepDiagnostics } : {}),
      tokens,
    },
    options.modelTraceContext,
    model,
  );
}
