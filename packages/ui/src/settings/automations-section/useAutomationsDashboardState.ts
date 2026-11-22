/**
 * Automations 主视图的数据与本地状态层。
 *
 * 只做 store 订阅、派生投影与本地 UI 状态；副作用与动作处理分别放在
 * `useAutomationNavigationEffects` / `useAutomationActionHandlers`，保持原有 hook 调用顺序。
 */
import { useCallback, useMemo, useState } from "react";
import {
  AUTOMATION_CREATE_LIMIT,
  type ModelSelection,
  type OffPeakTaskCreateResult,
} from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useOffPeakEligibility } from "@/hooks/useOffPeakEligibility.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";
import {
  isCurrentOffPeakCodingPlanSupported,
  useOffPeakTaskStore,
} from "@/store/offPeakTaskStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";
import { isRemoteAutomationWorkspace } from "@/hooks/useAutomationProjectOptions.js";
import {
  formatOffPeakRemainingWait,
  resolveOffPeakCreateBlockReason,
} from "@/settings/offPeakUiPresentation.js";
import {
  DEFAULT_AUTOMATION_STATUS_FILTER,
  filterAutomationsByStatus,
  filterOffPeakTasksByStatus,
  resolveAutomationTabState,
  type AutomationStatusFilter,
  type AutomationTabState,
} from "@/settings/automationStatusFilter.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";
import type { AutomationsPageTab } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import {
  resolveAutomationTemplateVisibility,
  resolveVisibleAutomationTabs,
} from "@/settings/automations-section/automationViewResolvers.js";
import type {
  AutomationsSectionProps,
  AutomationsTab,
  AutomationsView,
} from "@/settings/automations-section/automationsSectionTypes.js";

// offPeakTaskStore 的 createTask/updateTask 入参类型未导出，声明文件无法引用；
// 这里用同构签名承接，避免把 store 内部类型泄漏到模块边界。
interface OffPeakCreateTaskInput {
  title: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface OffPeakUpdateTaskInput {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ModelSelection | null;
}

type OffPeakCreateAction = (
  input: OffPeakCreateTaskInput,
  service: IOffPeakTaskService,
) => Promise<OffPeakTaskCreateResult>;

type OffPeakUpdateAction = (
  offPeakTaskId: string,
  input: OffPeakUpdateTaskInput,
  service: IOffPeakTaskService,
) => Promise<boolean>;

export function useAutomationsDashboardState({
  workspacePath,
  workspaceIdentity,
}: AutomationsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const { clientScenesService, offPeakTaskService, zcodeAgentService } = useServices();
  const confirmDialog = useConfirmDialog();
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const { status: entryStatus, label: entryLabel, retry: retryEntry } = useCodingPlanEntryGate();
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings();
  useOffPeakEligibility(sharedSettings, providerSettingsView?.revision);

  const automations = useAutomationManagementStore((state) => state.automations);
  const automationCreateLimitReached = automations.length >= AUTOMATION_CREATE_LIMIT;
  const loading = useAutomationManagementStore((state) => state.loading);
  const operationId = useAutomationManagementStore((state) => state.operationId);
  const runsCache = useAutomationManagementStore((state) => state.runsCache);
  const initialize = useAutomationManagementStore((state) => state.initialize);
  const createAutomation = useAutomationManagementStore((state) => state.createAutomation);
  const updateAutomation = useAutomationManagementStore((state) => state.updateAutomation);
  const deleteAutomation = useAutomationManagementStore((state) => state.deleteAutomation);
  const setEnabled = useAutomationManagementStore((state) => state.setEnabled);
  const restartAutomation = useAutomationManagementStore((state) => state.restartAutomation);
  const runAutomationNow = useAutomationManagementStore((state) => state.runAutomationNow);
  const loadRuns = useAutomationManagementStore((state) => state.loadRuns);
  const deleteRun = useAutomationManagementStore((state) => state.deleteRun);
  const refresh = useAutomationManagementStore((state) => state.refresh);

  const automationTemplates = useAutomationTemplates(clientScenesService);
  const offPeakTasks = useOffPeakTaskStore((state) => state.tasks);
  const offPeakStoreLoading = useOffPeakTaskStore((state) => state.loading);
  const offPeakGrayConfig = useOffPeakTaskStore((state) => state.grayConfig);
  const offPeakCodingPlanSupport = useOffPeakTaskStore((state) => state.codingPlanSupport);
  const offPeakTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.takeNumberAvailability,
  );
  const offPeakTakeNumberAvailabilityStatus = useOffPeakTaskStore(
    (state) => state.takeNumberAvailabilityStatus,
  );
  const offPeakOperationId = useOffPeakTaskStore((state) => state.operationId);
  const offPeakRefresh = useOffPeakTaskStore((state) => state.refresh);
  const offPeakRefreshCodingPlanSupport = useOffPeakTaskStore(
    (state) => state.refreshCodingPlanSupport,
  );
  const offPeakRefreshTakeNumberAvailability = useOffPeakTaskStore(
    (state) => state.refreshTakeNumberAvailability,
  );
  const offPeakCreate: OffPeakCreateAction = useOffPeakTaskStore((state) => state.createTask);
  const offPeakUpdate: OffPeakUpdateAction = useOffPeakTaskStore((state) => state.updateTask);
  const offPeakPause = useOffPeakTaskStore((state) => state.pauseTask);
  const offPeakContinue = useOffPeakTaskStore((state) => state.continueTask);
  const offPeakCancel = useOffPeakTaskStore((state) => state.cancelTask);
  const offPeakDelete = useOffPeakTaskStore((state) => state.deleteTask);
  const offPeakDeleteHistory = useOffPeakTaskStore((state) => state.deleteHistory);
  const consumePendingCreateDraft = useOffPeakTaskStore((state) => state.consumePendingCreateDraft);

  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<AutomationsView>({ mode: "list" });
  // tab 与状态筛选同居一个状态：所有 setTab 调用都经 resolveAutomationTabState 归约，
  // tab 一变筛选即回到全部，切走再切回也不会恢复旧筛选。
  const [tabState, setTabState] = useState<AutomationTabState<AutomationsTab>>({
    tab: "scheduled",
    filter: DEFAULT_AUTOMATION_STATUS_FILTER,
  });
  const { tab, filter: statusFilter } = tabState;
  const setTab = useCallback(
    (next: AutomationsTab | ((current: AutomationsTab) => AutomationsTab)) =>
      setTabState((previous) =>
        resolveAutomationTabState(previous, typeof next === "function" ? next(previous.tab) : next),
      ),
    [],
  );
  const setStatusFilter = useCallback(
    (filter: AutomationStatusFilter) => setTabState((previous) => ({ ...previous, filter })),
    [],
  );
  // 动态工作流灰度：未命中就没有「工作流」标签，
  // 页面退回单一的「自动化」。快照未就绪时 enabled 为 false，宁可标题晚半拍长出切换，也不先闪
  // 一个标签再收起——中枢很少是用户进 app 后第一眼看的东西。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  // 顶级标签「自动化 / 工作流」：页标题即切换。中枢已是跨项目视图，记忆不再按项目分桶，用 app 级单 key。
  const [storedPageTab, setPageTabState] = useState<AutomationsPageTab>(() =>
    readAutomationsPageTab(),
  );
  // 灰度关时忽略 sessionStorage 里记住的「工作流」：只收窄读出来的值，记忆本身不清，
  // 灰度再开时用户仍然回到上次那一页。中枢只在 `pageTab === "workflow"` 分支挂载，
  // 收窄 pageTab 等于 SavedWorkflowsSection 永不挂载，不会有一帧的误挂载去发查询。
  const pageTab: AutomationsPageTab = dynamicWorkflowEnabled ? storedPageTab : "automation";
  const setPageTab = useCallback((next: AutomationsPageTab) => {
    setPageTabState(next);
    writeAutomationsPageTab(next);
  }, []);
  const activeWorkspaceTab = useTabStore((state) => {
    const activeTab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    return activeTab && isWorkspaceTab(activeTab) ? activeTab : undefined;
  });
  const currentWorkspaceIsRemote = isRemoteAutomationWorkspace(activeWorkspaceTab);
  // 灰度中途翻转：只藏创建入口；有非终态存量仍展示并跑到终态。
  const offPeakGrayEnabled = offPeakGrayConfig?.enabled === true;
  const offPeakCreationEnabled = offPeakGrayEnabled && !currentWorkspaceIsRemote;
  // 扫描全部 provider 会把未选中的 Coding Plan 当成当前执行凭证。
  // mock 演示字段仍可覆盖；真实路径只接受与当前 family/selectedKey 一致的脱敏 resolver 快照。
  const offPeakNoPlan =
    offPeakGrayConfig?.codingPlanActive === false ||
    (offPeakGrayConfig?.codingPlanActive === undefined &&
      !offPeakStoreLoading &&
      !isCurrentOffPeakCodingPlanSupported(offPeakCodingPlanSupport, sharedSettings));
  const offPeakVisible =
    !currentWorkspaceIsRemote && (offPeakGrayEnabled || offPeakTasks.length > 0);
  const hasAnyTasks = automations.length > 0 || offPeakTasks.length > 0;
  const visibleTabs = resolveVisibleAutomationTabs({
    hasAnyTasks,
    offPeakVisible,
  });
  const hasVisibleTaskCards =
    tab === "scheduled" ? automations.length > 0 : offPeakTasks.length > 0;
  const visibleAutomations = filterAutomationsByStatus(automations, statusFilter);
  const visibleOffPeakTasks = filterOffPeakTasksByStatus(offPeakTasks, statusFilter);
  const { showOffPeakTemplates, showScheduledTemplates } = resolveAutomationTemplateVisibility({
    hasAnyTasks,
    offPeakCreationEnabled,
    tab,
  });
  const hasVisibleTemplates = showOffPeakTemplates || showScheduledTemplates;
  const showTaskTemplateSeparator = hasVisibleTaskCards && hasVisibleTemplates;
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // 相对时间基准;刷新列表时更新,避免频繁 setInterval。
  const [now, setNow] = useState(() => Date.now());

  // 创建准入 fail-closed。只有服务端成功返回 canTakeNumber=true 才放行；资格不符、
  // loading/idle/error 与额度 false 都禁入，避免依赖异常被吞掉后直到真实创建才报错。
  const offPeakCreateGrey = useMemo(() => {
    const reason = resolveOffPeakCreateBlockReason({
      availabilityStatus: offPeakTakeNumberAvailabilityStatus,
      canTakeNumber: offPeakTakeNumberAvailability?.canTakeNumber,
      grayEnabled: offPeakGrayEnabled,
      noPlan: offPeakNoPlan,
    });
    const tooltip =
      reason === "plan"
        ? intl.formatMessage({ id: "offPeak.create.codingPlanOnly" })
        : reason === "unavailable"
          ? intl.formatMessage({ id: "offPeak.create.availabilityUnavailable" })
          : reason === "quota" && offPeakTakeNumberAvailability?.nextTakeAt !== undefined
            ? intl.formatMessage(
                { id: "offPeak.create.limitReachedAt" },
                {
                  time: formatOffPeakRemainingWait(
                    offPeakTakeNumberAvailability.nextTakeAt,
                    now,
                    intl,
                  ),
                },
              )
            : undefined;
    return { reason, tooltip };
  }, [
    intl,
    now,
    offPeakGrayEnabled,
    offPeakNoPlan,
    offPeakTakeNumberAvailability,
    offPeakTakeNumberAvailabilityStatus,
  ]);

  return {
    intl,
    locale,
    platform,
    clientScenesService,
    offPeakTaskService,
    zcodeAgentService,
    confirmDialog,
    openCodingPlanUpgrade,
    providerSettingsView,
    entryStatus,
    entryLabel,
    retryEntry,
    sharedSettings,
    updateSharedSettings,
    automations,
    automationCreateLimitReached,
    loading,
    operationId,
    runsCache,
    initialize,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    setEnabled,
    restartAutomation,
    runAutomationNow,
    loadRuns,
    deleteRun,
    refresh,
    automationTemplates,
    offPeakTasks,
    offPeakStoreLoading,
    offPeakTakeNumberAvailability,
    offPeakGrayConfig,
    offPeakOperationId,
    offPeakRefresh,
    offPeakRefreshCodingPlanSupport,
    offPeakRefreshTakeNumberAvailability,
    offPeakCreate,
    offPeakUpdate,
    offPeakPause,
    offPeakContinue,
    offPeakCancel,
    offPeakDelete,
    offPeakDeleteHistory,
    consumePendingCreateDraft,
    refreshing,
    setRefreshing,
    view,
    setView,
    tab,
    statusFilter,
    setTab,
    setStatusFilter,
    dynamicWorkflowEnabled,
    pageTab,
    setPageTab,
    currentWorkspaceIsRemote,
    offPeakGrayEnabled,
    offPeakCreationEnabled,
    offPeakVisible,
    hasAnyTasks,
    visibleTabs,
    hasVisibleTaskCards,
    visibleAutomations,
    visibleOffPeakTasks,
    showOffPeakTemplates,
    showScheduledTemplates,
    hasVisibleTemplates,
    showTaskTemplateSeparator,
    loadedWorkspaceKey,
    setLoadedWorkspaceKey,
    now,
    setNow,
    offPeakCreateGrey,
    workspacePath,
    workspaceIdentity,
  };
}
