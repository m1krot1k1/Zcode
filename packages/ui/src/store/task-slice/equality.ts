import type { ZCodePermissionRequest } from "@zcode/shared";
import type { TaskUsageState } from "@/store/zcodeSessionStoreTypes.js";

export function arePermissionOptionsEqual(
  left: ZCodePermissionRequest["options"],
  right: ZCodePermissionRequest["options"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((option, index) => {
    const otherOption = right[index];
    if (!otherOption) {
      return false;
    }

    return (
      option.optionId === otherOption.optionId &&
      option.kind === otherOption.kind &&
      option.name === otherOption.name
    );
  });
}

export function arePermissionRequestsEquivalent(
  left: ZCodePermissionRequest,
  right: ZCodePermissionRequest,
): boolean {
  if (left === right) {
    return true;
  }

  // 同一 requestId 可能被连续投递成不同对象。raw 只用于展示预览，协议上 requestId 才是权限请求身份；
  // 这里按可见字段去重，避免重复请求把权限弹窗和 ChatView 整体重渲染。
  return (
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.inputId === right.inputId &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.description === right.description &&
    arePermissionOptionsEqual(left.options, right.options)
  );
}

function areTaskUsageCostsEqual(
  left: TaskUsageState["cost"] | undefined,
  right: TaskUsageState["cost"] | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return (
    normalizedLeft.amount === normalizedRight.amount &&
    normalizedLeft.currency === normalizedRight.currency
  );
}

function areTaskUsageCachesEqual(
  left: TaskUsageState["cache"] | undefined,
  right: TaskUsageState["cache"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.inputTokens === right.inputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.latestHitRate === right.latestHitRate &&
    left.hitRate === right.hitRate &&
    left.hitRateRequestCount === right.hitRateRequestCount &&
    left.totalInputTokens === right.totalInputTokens &&
    left.totalCacheReadTokens === right.totalCacheReadTokens &&
    left.totalCacheWriteTokens === right.totalCacheWriteTokens
  );
}

function areTaskUsageBreakdownsEqual(
  left: TaskUsageState["breakdown"] | undefined,
  right: TaskUsageState["breakdown"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) => item.source === right[index]?.source && item.chars === right[index]?.chars,
  );
}

export function areTaskUsageStatesEqual(
  left: TaskUsageState | null,
  right: TaskUsageState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.size === right.size &&
    left.used === right.used &&
    areTaskUsageCostsEqual(left.cost, right.cost) &&
    areTaskUsageCachesEqual(left.cache, right.cache) &&
    areTaskUsageBreakdownsEqual(left.breakdown, right.breakdown)
  );
}
