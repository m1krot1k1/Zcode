/**
 * Automations 主视图外壳：工作区守卫、创建/编辑整页路由、页面标题与顶级「自动化 / 工作流」切换。
 */
import { AutomationEditView } from "@/settings/AutomationEditView.js";
import { OffPeakEditView } from "@/settings/OffPeakEditView.js";
import { AutomationsPageTitle } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import { SavedWorkflowsSection } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsDashboardListView } from "@/settings/automations-section/AutomationsDashboardListView.js";
import { toast } from "@/settings/automations-section/automationsSectionToast.js";
import type { useAutomationNavigationEffects } from "@/settings/automations-section/useAutomationNavigationEffects.js";
import type { useAutomationsDashboardState } from "@/settings/automations-section/useAutomationsDashboardState.js";
import type {
  AutomationsSectionActions,
  AutomationsSectionProps,
} from "@/settings/automations-section/automationsSectionTypes.js";

export interface AutomationsSectionBodyProps extends Pick<
  AutomationsSectionProps,
  | "onCreateViaChat"
  | "onNavigateToLaunchedRun"
  | "onOpenWorkflowRun"
  | "onOpenWorkflowArtifact"
  | "openWorkflow"
  | "onOpenWorkflowConsumed"
  | "onOpenSession"
> {
  state: ReturnType<typeof useAutomationsDashboardState>;
  navigation: ReturnType<typeof useAutomationNavigationEffects>;
  actions: AutomationsSectionActions;
}

export function AutomationsSectionBody({
  state,
  navigation,
  actions,
  onCreateViaChat,
  onNavigateToLaunchedRun,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSession,
}: AutomationsSectionBodyProps) {
  const {
    intl,
    workspacePath,
    workspaceIdentity,
    view,
    setView,
    pageTab,
    setPageTab,
    dynamicWorkflowEnabled,
    hasAnyTasks,
    offPeakTasks,
    offPeakGrayConfig,
    offPeakOperationId,
    offPeakCreateGrey,
    offPeakPause,
    offPeakContinue,
    offPeakTaskService,
    operationId,
    runsCache,
    loadRuns,
    deleteRun,
    zcodeAgentService,
  } = state;
  const {
    handleEditSubmit,
    handleOffPeakSubmit,
    handleOffPeakDelete,
    handleOffPeakDeleteHistory,
    handleRunNow,
    handleToggle,
    handleDelete,
  } = actions;
  if (!workspacePath) {
    return (
      <div className="rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "automations.noWorkspace" })}
      </div>
    );
  }

  // 闲时任务创建/编辑整页（表单范式）。
  if (view.mode === "offpeak-create" || view.mode === "offpeak-edit") {
    const editingTask =
      view.mode === "offpeak-edit"
        ? (offPeakTasks.find((task) => task.offPeakTaskId === view.task.offPeakTaskId) ?? view.task)
        : null;
    return (
      <>
        <OffPeakEditView
          editing={editingTask}
          initialDraft={view.mode === "offpeak-create" ? (view.draft ?? null) : null}
          modelSelectionView={
            offPeakGrayConfig?.modelSelectionView ?? { revision: 0, providers: [] }
          }
          defaultWorkspacePath={workspacePath ?? ""}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            offPeakOperationId?.startsWith("offpeak:create") ||
            offPeakOperationId?.startsWith("offpeak:update") ||
            false
          }
          createBlocked={view.mode === "offpeak-create" && offPeakCreateGrey.reason !== null}
          createBlockedTooltip={offPeakCreateGrey.tooltip}
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleOffPeakSubmit}
          onOpenSession={onOpenSession}
          onDelete={(task) => void handleOffPeakDelete(task)}
          onDeleteHistory={(task) => void handleOffPeakDeleteHistory(task)}
          onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
          onContinue={(task) => void offPeakContinue(task.offPeakTaskId, offPeakTaskService)}
          showToast={toast}
        />
      </>
    );
  }

  // 创建/编辑整页(带 Settings/History tab)。
  if (view.mode !== "list") {
    return (
      <>
        <AutomationEditView
          editing={view.mode === "edit" ? view.automation : null}
          initialDraft={view.mode === "create" ? view.draft : null}
          defaultWorkspacePath={workspacePath}
          defaultWorkspaceIdentity={workspaceIdentity}
          saving={
            operationId?.startsWith("automation:create") ||
            operationId?.startsWith("automation:update") ||
            false
          }
          onBack={() => setView({ mode: "list" })}
          onSubmit={handleEditSubmit}
          onRunNow={(automation) => handleRunNow(automation, "editor")}
          onToggle={handleToggle}
          onDelete={(automation) => handleDelete(automation, "editor")}
          runsEntry={view.mode === "edit" ? runsCache[view.automation.automationId] : undefined}
          onLoadRuns={() => {
            if (view.mode === "edit")
              void loadRuns(view.automation.automationId, zcodeAgentService, true);
          }}
          onDeleteRun={(runId) => {
            if (view.mode === "edit") {
              void deleteRun(view.automation.automationId, runId, zcodeAgentService);
            }
          }}
          onOpenSession={
            view.mode === "edit" && onOpenSession
              ? (sessionId) => {
                  // 运行历史的跳转入口之前没有从父层接入导航回调，导致即使 run.sessionId
                  // 已经写入 automation_runs，菜单里也会把“跳到会话”隐藏掉。
                  onOpenSession({
                    sessionId,
                    workspacePath: view.automation.workspacePath,
                    workspaceIdentity: view.automation.workspaceIdentity,
                  });
                }
              : undefined
          }
        />
      </>
    );
  }

  // 页标题即顶级切换：「自动化 / 工作流」两个标题词
  // 并排，30/34 沿用 h1 的页面标题层级；副标题随标签换。
  const pageHeader = (
    <div className="flex flex-col gap-3">
      <AutomationsPageTitle
        workflowTabEnabled={dynamicWorkflowEnabled}
        value={pageTab}
        onValueChange={setPageTab}
      />
      <p className="text-ui-base leading-5 text-foreground-subtlest">
        {intl.formatMessage({
          id:
            pageTab === "workflow"
              ? "workflows.hub.description"
              : hasAnyTasks
                ? "automations.description.populated"
                : "automations.description",
        })}
      </p>
    </div>
  );

  if (pageTab === "workflow") {
    return (
      <SavedWorkflowsSection
        header={pageHeader}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        onNavigateToLaunchedRun={onNavigateToLaunchedRun}
        onCreateViaChat={onCreateViaChat}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        openWorkflow={openWorkflow}
        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
      />
    );
  }
  return (
    <AutomationsDashboardListView
      header={pageHeader}
      state={state}
      navigation={navigation}
      actions={actions}
    />
  );
}
