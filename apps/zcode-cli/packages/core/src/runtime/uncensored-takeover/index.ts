/**
 * Public entry of the managed `cli-uncensored-takeover` module. Runtime code imports only this
 * file; provider details stay behind `contract.ts`.
 */
export {
  TAKEOVER_HTTP_TIMEOUT_MS,
  TAKEOVER_MAX_FRAGMENT_CHARS,
  TAKEOVER_MAX_FRAGMENTS,
  TAKEOVER_MAX_ITEM_CHARS,
  TAKEOVER_MAX_TOKENS,
  TAKEOVER_MAX_USER_CONTENT_CHARS,
  TAKEOVER_REFUSAL_REASONS,
  TAKEOVER_SYSTEM_INSTRUCTION,
  UNCENSORED_TAKEOVER_AGENT_TYPE,
  UNCENSORED_TAKEOVER_ENTRY_TYPE,
  uncensoredTakeoverEntryPayloadSchema,
} from "./contract.js";
export type {
  AttributedTakeoverItem,
  BuildTakeoverEntryInput,
  CliUncensoredTakeoverContract,
  RunUncensoredTakeoverInput,
  TakeoverChatMessage,
  TakeoverContextFragment,
  TakeoverFetch,
  TakeoverFetchResponse,
  TakeoverLogger,
  TakeoverReminderInput,
  TakeoverRequestBody,
  TakeoverStatus,
  TakeoverTerminal,
  TakeoverTerminalStatus,
  TakeoverToolResult,
  UncensoredConfigPort,
  UncensoredGeneratePort,
  UncensoredGenerateResult,
  UncensoredTakeoverEntryPayload,
  UncensoredTakeoverSessionEntry,
} from "./contract.js";
export {
  buildTakeoverMessages,
  buildTakeoverReminder,
  buildTakeoverRequestBody,
  takeoverRequestModelId,
} from "./context.js";
export {
  attributeTodoItem,
  attributeTurnItem,
  detectRefusal,
  detectTextRefusal,
  hasRefusalMarker,
  REFUSAL_MARKER,
  stripRefusalMarker,
  normalizeFinishReason,
  normalizeItemText,
  selectContextFragments,
  TEXT_REFUSAL_REASON,
  truncateItemText,
} from "./detect.js";
export {
  buildTakeoverEntry,
  parseTakeoverEntryData,
  TAKEOVER_AGENT_ID_PREFIX,
  takeoverAgentId,
  takeoverIdempotencyKey,
} from "./durable-entry.js";
export { attemptTakeoverModel, defaultTakeoverFetch, type TakeoverAttemptOutcome } from "./http.js";
export { runUncensoredTakeover } from "./orchestrator.js";
