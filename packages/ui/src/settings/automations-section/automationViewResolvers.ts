/**
 * Automations 主视图的纯视图解析：可见 tab、模板分流、动作能力与详情导航。
 *
 * 全部为无副作用函数，便于单测直接引用；组件只负责把结果接到状态上。
 */
import {
  isAutomationCreateLimitError,
  type ZCodeAutomation,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import type { AutomationRunNowResult } from "@/store/automationManagementStore.js";
import {
  SCHEDULED_AND_IDLE_AUTOMATION_TABS,
  SCHEDULED_ONLY_AUTOMATION_TABS,
  type AutomationsTab,
} from "@/settings/automations-section/automationsSectionTypes.js";

export function resolveVisibleAutomationTabs({
  hasAnyTasks,
  offPeakVisible,
}: {
  hasAnyTasks: boolean;
  offPeakVisible: boolean;
}): readonly AutomationsTab[] {
  if (!hasAnyTasks) return [];
  return offPeakVisible ? SCHEDULED_AND_IDLE_AUTOMATION_TABS : SCHEDULED_ONLY_AUTOMATION_TABS;
}

export function resolveAutomationTabAfterOffPeakChange(
  tab: AutomationsTab,
  offPeakVisible: boolean,
): AutomationsTab {
  return tab === "idle" && !offPeakVisible ? "scheduled" : tab;
}

export function resolveAutomationTabNavigation({
  requestedTab,
  tabsReady,
  visibleTabs,
}: {
  requestedTab: AutomationsTab;
  tabsReady: boolean;
  visibleTabs: readonly AutomationsTab[];
}): { status: "pending" } | { status: "settled"; tab: AutomationsTab } {
  if (!tabsReady) return { status: "pending" };
  return {
    status: "settled",
    tab: visibleTabs.includes(requestedTab) ? requestedTab : "scheduled",
  };
}

export function resolveAutomationTemplateVisibility({
  hasAnyTasks,
  offPeakCreationEnabled,
  tab,
}: {
  hasAnyTasks: boolean;
  offPeakCreationEnabled: boolean;
  tab: AutomationsTab;
}): {
  showOffPeakTemplates: boolean;
  showScheduledTemplates: boolean;
} {
  // 移除 All tab 后空首页仍默认落在 Scheduled，导致闲时模板被 tab 条件误隐藏。
  // 无任务时恢复两类模板并列展示；有任务后继续由 Scheduled / Idle tab 分流。
  const showAllTemplates = !hasAnyTasks;
  return {
    showOffPeakTemplates: offPeakCreationEnabled && (showAllTemplates || tab === "idle"),
    showScheduledTemplates: showAllTemplates || tab === "scheduled",
  };
}

export function canRestartAutomation(
  automation: Pick<ZCodeAutomation, "lifecycleStatus">,
): boolean {
  return automation.lifecycleStatus === "failed";
}

export function canToggleAutomation(automation: Pick<ZCodeAutomation, "lifecycleStatus">): boolean {
  return automation.lifecycleStatus !== "completed" && automation.lifecycleStatus !== "failed";
}

export function getAutomationRunNowToastId(
  result: AutomationRunNowResult,
): "automations.runNowQueued" | "automations.runNowAlreadyRunning" | "automations.runNowFailed" {
  if (result === "queued") return "automations.runNowQueued";
  if (result === "duplicate") return "automations.runNowAlreadyRunning";
  return "automations.runNowFailed";
}

type AutomationActionError = "create" | "update" | "toggle" | "restart" | "delete";

/** 原始 Agent/RPC 错误留在 logger；界面只展示当前动作对应的可理解提示。 */
export function getAutomationActionErrorToastId(action: AutomationActionError): string {
  return `automations.error.${action}`;
}

export function getAutomationCreateErrorToastId(error: unknown): string {
  return isAutomationCreateLimitError(error)
    ? "automations.error.createLimit"
    : getAutomationActionErrorToastId("create");
}

export function resolveAutomationDetailTarget(
  automations: readonly ZCodeAutomation[],
  automationId?: string | null,
): ZCodeAutomation | null {
  const targetId = automationId?.trim();
  if (!targetId) return null;
  return automations.find((automation) => automation.automationId === targetId) ?? null;
}

export function resolveAutomationDetailNavigation(
  automations: readonly ZCodeAutomation[],
  automationId: string | null | undefined,
  listReady: boolean,
): { status: "pending" } | { status: "missing" } | { status: "found"; target: ZCodeAutomation } {
  if (!automationId?.trim() || !listReady) return { status: "pending" };
  const target = resolveAutomationDetailTarget(automations, automationId);
  return target ? { status: "found", target } : { status: "missing" };
}

/** D49：openAutomationId 里 `offpeak-` 前缀 id 的判别（生成点唯一：offPeakTaskService 的 offpeak-${uuid}）。 */
export function isOffPeakDetailNavigationId(automationId: string | null | undefined): boolean {
  return Boolean(automationId?.trim().startsWith("offpeak-"));
}

/** D49：闲时轮尾卡跳转的并行解析路径；与 cron 的 resolveAutomationDetailNavigation 对称。 */
export function resolveOffPeakDetailNavigation(
  tasks: readonly ZCodeOffPeakTask[],
  offPeakTaskId: string | null | undefined,
  listReady: boolean,
  listError: string | null = null,
):
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "found"; target: ZCodeOffPeakTask } {
  const targetId = offPeakTaskId?.trim();
  if (!targetId || !listReady) return { status: "pending" };
  // review：store.refresh 吞错保留旧列表；列表不可信时不能做 found/missing 终审。
  if (listError) return { status: "unavailable" };
  const target = tasks.find((task) => task.offPeakTaskId === targetId) ?? null;
  return target ? { status: "found", target } : { status: "missing" };
}
