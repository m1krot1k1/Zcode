// Fork-путь сессий: barrel публичного API.
//
// Реализация разделена по лимиту строк:
// - session-fork-basis.ts — identity map, goal/verifier-клоны, notice, границы
//   side-chat, общие предикаты сообщений;
// - session-fork-side-chat.ts — построение границ и атомарный коммит side-chat форка;
// - session-fork-entry.ts — точки входа (сессия/сообщение/stable/goal/история).
export {
  activeForkTranscriptMessages,
  buildAtomicForkNotice,
  createForkIdentityMap,
  forkSourceMessagesForSession,
} from "./session-fork-basis.js";
export {
  createSelectionSideConversation,
  selectionSideChatHistoryMessages,
} from "./session-fork-side-chat.js";
export {
  buildForkHistoryMessages,
  conversationHistoryBeforeInput,
  copyGoalStateForFork,
  createForkedSession,
  deriveForkedGoalStatusFromCopiedVerifications,
  forkConversationBeforeMessage,
  forkConversationFromMessage,
  forkStableConversationAtMessage,
  resolveForkHistoryEndIndex,
  stableForkHistoryMessages,
} from "./session-fork-entry.js";
