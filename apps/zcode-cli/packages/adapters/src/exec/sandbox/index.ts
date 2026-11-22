/**
 * cli-exec-sandbox — публичный вход модуля.
 * Всё, что не экспортировано здесь, считается внутренним.
 */
export type {
  ExecutionSandboxContract,
  ProcessTreeKillOptions,
  ProcessTreeKillResult,
  SandboxCapability,
  SandboxCommand,
  SandboxLimits,
  SandboxMode,
  SandboxNetworkAccess,
  SandboxPolicy,
  SandboxProfile,
  SandboxedCommand,
} from "./contract.js";
export {
  SANDBOX_ENV_WHITELIST,
  SANDBOX_KILL_GRACE_MS,
  SANDBOX_PROBE_TTL_MS,
} from "./contract.js";

export {
  createExecutionSandbox,
  ExecutionSandbox,
  buildDegradedCommand,
  buildSandboxEnv,
  isPathInside,
  type ExecutionSandboxOptions,
} from "./execution-sandbox.js";
export {
  probeSandboxCapability,
  SandboxCapabilityCache,
  SEATBELT_PROBE_PROFILE,
  createBwrapProbeArgs,
  createBwrapNetworkProbeArgs,
  type ProbeInternals,
  type ProbeRunResult,
} from "./capability-probe.js";
export {
  buildBwrapCommand,
  buildLimitCommand,
  bwrapNeedsShellWrapper,
  resolveProtectedPaths,
  type BwrapBuildInput,
  type BwrapBuildResult,
} from "./linux-bwrap.js";
export {
  buildSeatbeltCommand,
  buildSeatbeltProfile,
  sbplEscape,
  type SeatbeltBuildInput,
  type SeatbeltBuildResult,
  type SeatbeltProfileInput,
} from "./macos-seatbelt.js";
export {
  attachAbortKill,
  collectTreePids,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessTree,
  readPosixProcessTable,
} from "./process-group-killer.js";
