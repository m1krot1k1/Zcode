/**
 * Automations Settings Section
 *
 * 定时任务与闲时任务的主视图入口：订阅 store、路由到列表/创建/编辑整页。
 *
 * 视图解析、数据状态、导航副作用、动作处理与子视图分别位于
 * `./automations-section/`；本模块只保留公共 API 与原有的 hook 调用顺序。
 */
import { useCallback } from "react";
import type { ZCodeOffPeakTask } from "@zcode/shared";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";
import { AutomationsSectionBody } from "@/settings/automations-section/AutomationsSectionBody.js";
import { toast } from "@/settings/automations-section/automationsSectionToast.js";
import type {
  AutomationsSectionActions,
  AutomationsSectionProps,
} from "@/settings/automations-section/automationsSectionTypes.js";
import { useAutomationActionHandlers } from "@/settings/automations-section/useAutomationActionHandlers.js";
import { useAutomationNavigationEffects } from "@/settings/automations-section/useAutomationNavigationEffects.js";
import { useAutomationOffPeakActionHandlers } from "@/settings/automations-section/useAutomationOffPeakActionHandlers.js";
import { useAutomationsDashboardState } from "@/settings/automations-section/useAutomationsDashboardState.js";

export { AUTOMATIONS_TOAST_ANCHOR_ID } from "@/settings/automations-section/automationsSectionToast.js";
export {
  canRestartAutomation,
  canToggleAutomation,
  getAutomationActionErrorToastId,
  getAutomationCreateErrorToastId,
  getAutomationRunNowToastId,
  resolveAutomationDetailNavigation,
  resolveAutomationDetailTarget,
  resolveAutomationTabAfterOffPeakChange,
  resolveAutomationTabNavigation,
  resolveAutomationTemplateVisibility,
  resolveOffPeakDetailNavigation,
  resolveVisibleAutomationTabs,
} from "@/settings/automations-section/automationViewResolvers.js";

export type { AutomationsSectionProps } from "@/settings/automations-section/automationsSectionTypes.js";

export function AutomationsSection({
  workspacePath,
  workspaceIdentity,
  onCreateViaChat,
  openAutomationId,
  openAutomationTab,
  onOpenAutomationConsumed,
  onNavigateToLaunchedRun,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSession,
}: AutomationsSectionProps) {
  const state = useAutomationsDashboardState({ workspacePath, workspaceIdentity });
  const navigation = useAutomationNavigationEffects({
    state,
    openAutomationId,
    openAutomationTab,
    onOpenAutomationConsumed,
  });
  const actions = useAutomationActionHandlers({
    state,
    navigation,
    onCreateViaChat,
    onOpenSession,
  });

  // 闲时任务删除是不可恢复的破坏性入口，确认弹窗声明留在本文件（破坏性入口清单按文件核对）。
  const { confirmDialog, intl, offPeakDelete, offPeakTaskService, setView } = state;
  const handleOffPeakDelete = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "offPeak.delete.title" }),
        description: intl.formatMessage({ id: "offPeak.delete.description" }),
        confirmLabel: intl.formatMessage({ id: "offPeak.delete.confirm" }),
      });
      if (!confirmed) return;
      await offPeakDelete(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
      setView((prev) =>
        prev.mode === "offpeak-edit" && prev.task.offPeakTaskId === task.offPeakTaskId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, intl, offPeakDelete, offPeakTaskService],
  );

  const offPeakActions = useAutomationOffPeakActionHandlers({ state, navigation });
  const mergedActions: AutomationsSectionActions = {
    ...actions,
    ...offPeakActions,
    handleOffPeakDelete,
  };

  return (
    <AutomationsSectionBody
      state={state}
      navigation={navigation}
      actions={mergedActions}
      onCreateViaChat={onCreateViaChat}
      onNavigateToLaunchedRun={onNavigateToLaunchedRun}
      onOpenWorkflowRun={onOpenWorkflowRun}
      onOpenWorkflowArtifact={onOpenWorkflowArtifact}
      openWorkflow={openWorkflow}
      onOpenWorkflowConsumed={onOpenWorkflowConsumed}
      onOpenSession={onOpenSession}
    />
  );
}
