// SettingsPage 拆分（max-lines）：与 React 状态无关的纯助手与运行时动作包装，语义逐行保持。
import type { UsageEntitlementSnapshot } from "@zcode/shared";
import type { UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";
import type { CodingPlanUsageSource } from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import {
  runUserActionAsync,
  type UserActionResult,
  type UserActionTrigger,
} from "@/lib/userActionTelemetry.js";
import type { SettingsUserActionFeatureId } from "@/lib/userActionTraceCatalog.js";

type ParsedRunLimit = number | "empty" | "invalid";

/** 只接受十进制整数；空串表示“沿用默认值”，不写回设置。 */
export function parseRunLimitInput(raw: string, minimum: number): ParsedRunLimit {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "empty";
  if (!/^\d+$/u.test(trimmed)) return "invalid";
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return "invalid";
  return parsed;
}

export function runSettingsActionAsync<T>(options: {
  featureId: SettingsUserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  operation: () => Promise<T>;
  completed: UserActionResult;
  failureStage?: string;
}): Promise<T> {
  return runUserActionAsync({
    input: {
      featureId: options.featureId,
      action: options.action,
      trigger: options.trigger,
    },
    operation: options.operation,
    completed: options.completed,
    failureStage: options.failureStage ?? "settings_commit",
  });
}

export function isTeamCodingPlanUsageSource(source: CodingPlanUsageSource): boolean {
  return "planKind" in source.accountAccess && source.accountAccess.planKind === "team-coding-plan";
}

export function createSettingsUsageCodingPlanTabId(sourceId: string): UsageStatsSectionTab {
  return `codingPlan:${sourceId}`;
}

export function resolveSettingsUsageCodingPlanSourceId(tab: UsageStatsSectionTab): string | null {
  return tab.startsWith("codingPlan:") ? tab.slice("codingPlan:".length) : null;
}

export function resolveSettingsUsageCodingPlanTabLabel({
  defaultLabel,
  hasMultiplePersonalSources,
  source,
}: {
  defaultLabel: string;
  hasMultiplePersonalSources: boolean;
  index: number;
  source: CodingPlanUsageSource;
}): string {
  if (isTeamCodingPlanUsageSource(source)) {
    return source.label.replace(/^BigModel\s*-\s*/i, "").trim() || source.label;
  }
  if (hasMultiplePersonalSources) {
    return source.label.replace(/\s*-\s*Coding Plan$/i, "").trim() || source.label;
  }
  return defaultLabel;
}

export function hasActiveCodingPlanSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId: string,
): boolean {
  return (
    snapshot?.provider?.id === providerId &&
    snapshot.unavailableReason !== "no_plan" &&
    (Boolean(snapshot.subscription?.details.length) ||
      // quota 暂时失败时服务仍能确认当前 provider，但旧过滤条件会把
      // Coding Plan tab 当成未开通套餐删除。只有明确 no_plan 才应隐藏入口。
      snapshot.unavailableReason === "unavailable")
  );
}
