/**
 * Снимок renderer-local памяти прокрутки на границе scope (session/draft).
 *
 * Class-компонент снимает before-mutation snapshot старого DOM, потому что к
 * моменту cleanup обычного layout effect разметка уже заменена новой сессией.
 */
import { Component } from "react";
import {
  resolveChatSessionScrollRestoreTop,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import { SCROLL_MEMORY_RESTORE_TOLERANCE_PX } from "@/v4/conversation-timeline/timelineUtils.js";

export interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

export interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

export function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

export function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // 新 lease 的首帧 rows 可能仍是截断尾窗；只要还能拉取更早历史，就继续保留原始
  // 恢复意图，避免把临时 clamp 后的 scrollTop 当成最终阅读锚点。
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/** React 的 before-mutation snapshot：scope cleanup 时普通 layout effect 已看到新 DOM。 */
export class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}
