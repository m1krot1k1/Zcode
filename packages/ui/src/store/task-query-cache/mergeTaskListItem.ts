import type { TaskListCacheDescriptor } from "@/lib/taskQueryCache.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import type { CachedTaskListItem } from "./types.js";

// republish（membership 重拉、sessions-index 帧）产出的 item 都是全新对象引用。
// 内容没变时如果照样换引用，taskMetaByEntityKey 和派生 items memo 会整列表换新，
// 所有列表行无效重渲染。这里做逐字段等价判断，等价则保留旧引用。
// 嵌套字段（lastError/target 等）用 JSON 比较；task meta 是小对象，代价可接受。
function areCachedTaskListItemsEquivalent(
  left: CachedTaskListItem,
  right: CachedTaskListItem,
): boolean {
  if (left === right) {
    return true;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (
      typeof leftValue === "object" &&
      leftValue !== null &&
      typeof rightValue === "object" &&
      rightValue !== null
    ) {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

export function mergeIncomingTaskListItem(params: {
  item: CachedTaskListItem;
  existingItem: CachedTaskListItem | undefined;
  descriptor: TaskListCacheDescriptor;
  hasUnreadOverlay: boolean;
  unreadAtOverlay: number | null | undefined;
}): CachedTaskListItem {
  const incomingActivity = getTaskListRowActivity(params.item);
  const existingActivity = params.existingItem ? getTaskListRowActivity(params.existingItem) : null;
  // 搜索结果来自 tasks-index，但实体缓存可能已有 sessions-index activity。
  // 合并时保留 sidecar，否则用户一输入搜索词，running/等待确认就会消失。
  const incomingWithActivity =
    params.descriptor.search && params.existingItem && existingActivity && !incomingActivity
      ? (mergeTaskListMembershipFields(params.existingItem, params.item) as CachedTaskListItem)
      : params.item;
  const keepExistingNonPlaceholderTitle =
    params.existingItem &&
    incomingActivity &&
    (params.item.title.trim().length === 0 ||
      params.item.title.trim().toLocaleLowerCase() === "new session") &&
    params.existingItem.title.trim().length > 0 &&
    params.existingItem.title.trim().toLocaleLowerCase() !== "new session";
  // 非搜索列表的 incoming item 是 sessions-index activity + 最新 membership join，
  // 不能再按 tasks-index updatedAt 做 whole-meta winner；否则 rename/unread 响应会覆盖实时
  // phase/lastActivityAt。只保留 sessions-index 尚未补齐时的首发标题和非 activity 展示字段。
  const mergedItem = params.descriptor.search
    ? incomingWithActivity
    : ({
        ...incomingWithActivity,
        ...(keepExistingNonPlaceholderTitle ? { title: params.existingItem?.title } : {}),
        changeSummary: incomingWithActivity.changeSummary ?? params.existingItem?.changeSummary,
        model: incomingWithActivity.model ?? params.existingItem?.model,
        provider: incomingWithActivity.provider ?? params.existingItem?.provider,
      } as CachedTaskListItem);
  const itemWithUnreadOverlay = params.hasUnreadOverlay
    ? ({
        ...mergedItem,
        unreadAt: params.unreadAtOverlay ?? undefined,
      } as CachedTaskListItem)
    : mergedItem;
  const nextItem =
    params.descriptor.search || !params.existingItem?.searchSnippet
      ? itemWithUnreadOverlay
      : {
          ...itemWithUnreadOverlay,
          searchSnippet: params.existingItem.searchSnippet,
          searchSnippets: params.existingItem.searchSnippets,
        };
  // 引用保持：合并结果与现值等价时沿用旧对象，让下游 memo/浅比较短路。
  return params.existingItem && areCachedTaskListItemsEquivalent(nextItem, params.existingItem)
    ? params.existingItem
    : nextItem;
}
