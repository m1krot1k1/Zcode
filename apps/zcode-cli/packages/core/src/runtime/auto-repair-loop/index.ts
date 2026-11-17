/**
 * cli-auto-repair-loop — публичный вход модуля.
 * Всё, что не экспортировано здесь, считается внутренним.
 */
export type {
  AutoRepairLoopContract,
  RepairLoopLimits,
  RepairLoopObservation,
  RepairLoopOutcome,
  RepairLoopStatus,
  RepairLoopStopReason,
  RepairSignal,
  RepairSignalSeverity,
  RepairSignalSource,
  RepairVerificationPort,
  RepairVerificationVerdict,
} from "./contract.js";
export { AUTO_REPAIR_DEFAULTS } from "./contract.js";
export {
  AutoRepairLoop,
  createAutoRepairLoop,
  runAutoRepairLoopToCompletion,
  type AutoRepairLoopOptions,
} from "./loop.js";
export type { AutoRepairLogger, VerificationGateOptions } from "./verification-gate.js";
export { runVerificationGate } from "./verification-gate.js";
export {
  buildNextStep,
  dedupeSignals,
  formatRepairReport,
  groupSignalsByFile,
  makeSignal,
  mergeVerdicts,
  signalSignature,
  sortSignals,
} from "./telemetry-aggregator.js";
export {
  createRuntimeAutoRepairLoop,
  type AutoRepairVerificationRunners,
  type CreateRuntimeAutoRepairLoopOptions,
} from "./runtime-factory.js";
export {
  AUTO_REPAIR_GATE_MAX_RUNS,
  collectAgentAutoRepairSignals,
  parseLintOutput,
  parseTypecheckOutput,
  runAgentAutoRepairGate,
  type AgentAutoRepairGateOptions,
  type AgentVerificationExecPort,
  type AutoRepairGateOutcome,
} from "./agent-gate.js";
