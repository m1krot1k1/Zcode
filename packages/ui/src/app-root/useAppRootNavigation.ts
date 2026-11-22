import { useCallback, useEffect, useState } from "react";
import { resolveWorkspaceKey } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import type { WorkspaceMainView } from "@/app-shell/types.js";
import {
  useWorkspaceTaskNavigation,
  type AutomationsNavigationTarget,
} from "@/app-shell/useWorkspaceTaskNavigation.js";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";
import {
  addPluginStoreOpenListener,
  type PluginStoreOpenTarget,
} from "@/lib/pluginStoreNavigation.js";
import {
  resolveQuickPickConversationNavigation,
  selectQuickPickConversationTaskIds,
} from "@/lib/quickPickConversationNavigation.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";

/**
 * Навигация App по main view: chat / automations / plugin-store, task-история,
 * deep-link в «сохранённые» workflow, вход в настройки плагинов и переход
 * к соседнему диалогу по шорткату.
 */
export function useAppRootNavigation({
  workspaceAbsPath,
  workspaceIdentity,
  activeTaskId,
  activateTabByPath,
  isWorkspaceVisible,
  runVisibleWorkspaceCommand,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  isWorkspaceVisible: boolean;
  runVisibleWorkspaceCommand: (run: () => void) => void;
}) {
  const { intl } = useZCodeIntl();
  const [workspaceMainView, setWorkspaceMainView] = useState<WorkspaceMainView>("chat");
  const [openAutomationId, setOpenAutomationId] = useState<string | null>(null);
  const [openAutomationTab, setOpenAutomationTab] = useState<NonNullable<
    AutomationsNavigationTarget["automationTab"]
  > | null>(null);
  const [pluginStoreOpenVersion, setPluginStoreOpenVersion] = useState(0);
  const handleNavigateToTaskMain = useCallback(() => {
    setWorkspaceMainView("chat");
  }, []);
  const { preserveNextSettingsExit } = useWorkspaceMainViewSettingsExit({
    isWorkspaceVisible,
    workspaceMainView,
    onExitSettings: handleNavigateToTaskMain,
  });
  const handleNavigateToAutomationsMain = useCallback((target: AutomationsNavigationTarget) => {
    setOpenAutomationId(target.automationId ?? null);
    setOpenAutomationTab(target.automationTab ?? null);
    setWorkspaceMainView("automations");
  }, []);
  const handleNavigateToPluginStoreMain = useCallback(() => {
    setPluginStoreOpenVersion((version) => version + 1);
    preserveNextSettingsExit();
    setWorkspaceMainView("plugin-store");
  }, [preserveNextSettingsExit]);
  const handleOpenAutomationConsumed = useCallback(() => {
    setOpenAutomationId(null);
    setOpenAutomationTab(null);
  }, []);
  // 中枢深链（「已保存」芯片 → 那个工作流的详情页）：中枢定位后由它回调清空。
  const [openWorkflow, setOpenWorkflow] = useState<SavedWorkflowsOpenTarget | null>(null);
  const handleOpenWorkflowConsumed = useCallback(() => setOpenWorkflow(null), []);
  const {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath,
    workspaceIdentity,
    activateTabByPath,
    onNavigateToTask: handleNavigateToTaskMain,
    onNavigateToAutomations: handleNavigateToAutomationsMain,
    onNavigateToPluginStore: handleNavigateToPluginStoreMain,
  });
  // 完成卡「已保存」芯片的落点（docs/dynamic-workflow/transcript-and-notifications.md「Saving the
  // run, and running it again」）：走「自动化」入口的同一条导航（进历史、切主视图），落在「工作流」
  // 标签，再由深链把中枢定位到那一页。项目档按 workspaceKey 找组，全局档只要名字。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      setOpenWorkflow(
        target.scope === "global"
          ? { scope: "global", name: target.name }
          : {
              scope: "project",
              name: target.name,
              workspaceKey: resolveWorkspaceKey({
                workspacePath: target.workspacePath,
                ...(target.workspaceIdentity
                  ? { workspaceIdentity: target.workspaceIdentity }
                  : {}),
              }),
            },
      );
      handleOpenAutomations(undefined, "workflow");
    },
    [handleOpenAutomations],
  );
  const handleOpenPluginStoreForScope = useCallback(
    (_target: PluginStoreOpenTarget = {}) => {
      // 管理范围由市场内视图持有，重复打开只重置市场导航。
      if (workspaceMainView === "plugin-store") {
        setPluginStoreOpenVersion((version) => version + 1);
        return;
      }
      handleOpenPluginStore();
    },
    [handleOpenPluginStore, workspaceMainView],
  );
  useEffect(
    () => addPluginStoreOpenListener(handleOpenPluginStoreForScope),
    [handleOpenPluginStoreForScope],
  );
  const handleSelectAdjacentConversation = useCallback(
    (direction: "previous" | "next") => {
      runVisibleWorkspaceCommand(() => {
        const sessionState = useZCodeSessionStore.getState();
        const workspaceState = sessionState.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        const fallbackTaskIds = getVisibleTaskMetas(workspaceState).map((task) => task.taskId);
        const taskQueryCacheState = useTaskQueryCacheStore.getState();
        // 性能修复：task meta 在恢复和流式事件期间会高频写入 query cache。
        // 上/下一个会话只在快捷键触发时需要最新快照，不能让 App 订阅整个 cache 后带动 shell 重渲染。
        const quickPickConversationNavigation = resolveQuickPickConversationNavigation({
          taskIds: selectQuickPickConversationTaskIds({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            resultsByQueryKey: taskQueryCacheState.resultsByQueryKey,
            taskMetaByEntityKey: taskQueryCacheState.taskMetaByEntityKey,
            fallbackTaskIds,
          }),
          activeTaskId,
        });
        const targetTaskId =
          direction === "previous"
            ? quickPickConversationNavigation.previousTaskId
            : quickPickConversationNavigation.nextTaskId;
        if (!targetTaskId) {
          return;
        }

        handleSelectTask(workspaceAbsPath, targetTaskId, workspaceIdentity);
      });
    },
    [activeTaskId, handleSelectTask, runVisibleWorkspaceCommand, workspaceAbsPath, workspaceIdentity],
  );
  const handleSelectPreviousConversation = useCallback(() => {
    handleSelectAdjacentConversation("previous");
  }, [handleSelectAdjacentConversation]);
  const handleSelectNextConversation = useCallback(() => {
    handleSelectAdjacentConversation("next");
  }, [handleSelectAdjacentConversation]);

  return {
    workspaceMainView,
    setWorkspaceMainView,
    pluginStoreOpenVersion,
    openAutomationId,
    openAutomationTab,
    openWorkflow,
    handleOpenWorkflowConsumed,
    handleOpenSavedWorkflowInHub,
    handleOpenAutomationConsumed,
    handleOpenAutomations,
    handleOpenPluginStoreForScope,
    handleSelectTask,
    handleTaskNavBack,
    handleTaskNavForward,
    handleNavigateToTaskMain,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
    handleSelectPreviousConversation,
    handleSelectNextConversation,
  };
}
