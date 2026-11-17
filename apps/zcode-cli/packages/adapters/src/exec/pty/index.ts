/**
 * cli-exec-pty — публичный вход модуля.
 * Всё, что не экспортировано здесь, считается внутренним.
 */
export type {
  AgentPtyManagerContract,
  PtyChunk,
  PtyCreateOptions,
  PtyKillOptions,
  PtyManagerLimits,
  PtyReadResult,
  PtySandboxMode,
  PtySandboxOptions,
  PtySessionId,
  PtySessionInfo,
  PtySessionStatus,
  PtyWaitMatch,
  PtyWaitOptions,
  PtyWaitResult,
} from "./contract.js";
export {
  PTY_DEFAULT_BUFFER_BYTES,
  PTY_DEFAULT_COLS,
  PTY_DEFAULT_IDLE_MS,
  PTY_DEFAULT_IDLE_TIMEOUT_MS,
  PTY_DEFAULT_MAX_SESSIONS,
  PTY_DEFAULT_ROWS,
  PTY_DEFAULT_WAIT_TIMEOUT_MS,
} from "./contract.js";
export {
  AgentPtyManager,
  createAgentPtyManager,
  resolveDefaultShell,
  type AgentPtyManagerOptions,
} from "./agent-pty-manager.js";
export { AnsiRingBuffer, parseAnsi, stripAnsi, type ParsedAnsi } from "./ansi-ring-buffer.js";
export {
  createAgentPtySessionPort,
  createAgentPtySessionPortWithManager,
  type AgentPtySessionPort,
} from "./pty-session-port.js";
