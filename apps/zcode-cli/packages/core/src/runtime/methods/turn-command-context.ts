import type { ModelRequestDependencies } from "@zcode/contracts";
import type {
  MessageId,
  Model,
  ModelSelection,
  QueryId,
  SessionEvent,
  SessionGoal,
  TraceContext,
  TraceId,
  TurnId,
  TurnMachineImpl,
  TurnState,
} from "../deps.js";
import type { parseCompactCommand, parseRewindCommand } from "../helpers/commands.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState, AgentRuntimeConfig, ExecuteTurnOptions } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

export const MODEL_CREATION_FAILED_MESSAGE = "Model creation failed";
export const MODEL_CREATION_TURN_PHASE = "model_creation";
export const TURN_EXECUTION_FAILED_MESSAGE = "Turn execution failed";

export type TurnCreationFallback = {
  reason: "highspeed_selection_unavailable";
  fromModelSelection: ModelSelection;
  toModelSelection: ModelSelection;
};

/** Мутируемые факты модели, созданные до основной стадии и читаемые в терминальной. */
export interface TurnExecutionModelState {
  admittedModel: Model | undefined;
  submissionModel: Model | undefined;
  effectiveExecutionSelection: ModelSelection | undefined;
  effectiveRequestDependencies: ModelRequestDependencies | undefined;
  creationFallback: TurnCreationFallback | undefined;
  creationFailure: { error: unknown } | undefined;
  creationFallbackUnavailable: boolean;
}

/** Мутируемое состояние одного executeTurnCommand, разделяемое стадиями. */
export interface TurnCommandState {
  turnMachine: TurnMachineImpl;
  activeTurn: ActiveTurnSteeringState | undefined;
  startedTarget: SessionGoal | null;
  userMessageId: MessageId | undefined;
  loopState: RegularTurnLoopState | undefined;
  shouldRetryTitleGenerationAfterTurn: boolean;
  turnFailureHandled: boolean;
  model: TurnExecutionModelState;
}

export interface TurnCommandContext {
  runtime: AgentRuntimeInternal;
  input: string;
  attachments: TurnState["attachments"] | undefined;
  options: ExecuteTurnOptions | undefined;
  compactInstructions: ReturnType<typeof parseCompactCommand>;
  rewindCommand: ReturnType<typeof parseRewindCommand>;
  turnId: TurnId;
  queryId: QueryId;
  displayInput: string;
  turnTraceContext: TraceContext;
  traceId: TraceId;
  turnStartedAtMs: number;
  targetRunInputID: string;
  turnAbortSignal: AbortSignal;
  events: SessionEvent[];
  admittedModelSelection: ModelSelection | undefined;
  highspeedFallbackSelection: ModelSelection | undefined;
  admittedOutputStyle: AgentRuntimeConfig["outputStyle"];
  ownsRootRunBudget: boolean;
  rootRunId: string;
  startTurnPhase: (phase: string) => number;
  completeTurnPhase: (phase: string, startedAt: number) => void;
  state: TurnCommandState;
}
