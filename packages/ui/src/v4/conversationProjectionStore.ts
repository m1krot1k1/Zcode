// Conversation projection store 的公共入口。
// 实现按职责拆到 ./conversation-projection-store/：连接/恢复、帧应用、命令与历史查询。
// 三个层共享同一个 store 实例与同一份 state，这里只做公共 API 的单一出口。
export {
  ACCEPTED_INPUT_PROJECTION_GRACE_MS,
  hasOlderRows,
  mergeOlderRows,
  requiresAcceptedInputProjection,
  shouldAutoLoadIncompleteLeadingTurn,
} from "./conversation-projection-store/guards.js";
export { ConversationProjectionStore } from "./conversation-projection-store/store.js";
export type {
  ConversationStoreState,
  ConversationStoreStatus,
  OptimisticCommand,
  SessionOpenRendererTiming,
} from "./conversation-projection-store/types.js";
