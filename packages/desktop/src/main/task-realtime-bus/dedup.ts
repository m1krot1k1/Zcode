import type { TaskRealtimeBusState } from "./state.js";

/** 事件去重按插入顺序淘汰最旧 eventId，保持既有 FIFO 窗口语义。 */
export function rememberEventId(state: TaskRealtimeBusState, eventId: string): boolean {
  if (state.seenEventIds.has(eventId)) {
    return false;
  }

  state.seenEventIds.add(eventId);
  state.seenEventOrder.push(eventId);

  while (state.seenEventOrder.length > state.seenEventLimit) {
    const removed = state.seenEventOrder.shift();
    if (removed) {
      state.seenEventIds.delete(removed);
    }
  }

  return true;
}
