/**
 * Automations 主视图的导航与刷新副作用。
 *
 * 列表加载、tab 迁移、深链消费、闲时额度轮询与刷新动作保持原有 hook 顺序与依赖数组。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AUTOMATION_CREATE_LIMIT,
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveWorkspaceKey,
} from "@zcode/shared";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";
import {
  isOffPeakDetailNavigationId,
  resolveAutomationDetailNavigation,
  resolveAutomationTabAfterOffPeakChange,
  resolveAutomationTabNavigation,
  resolveOffPeakDetailNavigation,
} from "@/settings/automations-section/automationViewResolvers.js";
import { toast } from "@/settings/automations-section/automationsSectionToast.js";
import type { useAutomationsDashboardState } from "@/settings/automations-section/useAutomationsDashboardState.js";

export interface UseAutomationNavigationEffectsParams {
  state: ReturnType<typeof useAutomationsDashboardState>;
  openAutomationId?: string | null;
  openAutomationTab?: AutomationsNavigationTab | null;
  onOpenAutomationConsumed?: () => void;
}

export function useAutomationNavigationEffects({
  state,
  openAutomationId,
  openAutomationTab,
  onOpenAutomationConsumed,
}: UseAutomationNavigationEffectsParams) {
  const {
    workspacePath,
    workspaceIdentity,
    zcodeAgentService,
    initialize,
    offPeakVisible,
    tab,
    setTab,
    dynamicWorkflowEnabled,
    setPageTab,
    visibleTabs,
    loadedWorkspaceKey,
    setLoadedWorkspaceKey,
    offPeakStoreLoading,
    offPeakRefreshTakeNumberAvailability,
    offPeakTaskService,
    offPeakTakeNumberAvailability,
    now,
    setNow,
    view,
    offPeakTasks,
    offPeakRefresh,
    offPeakGrayEnabled,
    offPeakRefreshCodingPlanSupport,
    refresh,
    setRefreshing,
    consumePendingCreateDraft,
    currentWorkspaceIsRemote,
    intl,
    sharedSettings,
    openCodingPlanUpgrade,
    providerSettingsView,
    entryLabel,
    entryStatus,
    retryEntry,
    automations,
    setView,
  } = state;
  useEffect(() => {
    if (!workspacePath) return;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath,
      workspaceIdentity,
    });
    let disposed = false;
    setLoadedWorkspaceKey(null);
    setNow(Date.now());
    void initialize({
      workspacePath,
      workspaceIdentity,
      agentService: zcodeAgentService,
    }).then(() => {
      if (!disposed) setLoadedWorkspaceKey(workspaceKey);
    });
    return () => {
      disposed = true;
    };
  }, [workspacePath, workspaceIdentity, zcodeAgentService, initialize]);

  useEffect(() => {
    const nextTab = resolveAutomationTabAfterOffPeakChange(tab, offPeakVisible);
    if (nextTab === tab) return;
    // 后台关闭闲时灰度后，Idle tab 会被隐藏；旧状态若继续停在 idle，
    // 定时任务列表也会被 tab === "idle" 一并隐藏。回到 Scheduled，确保定时任务始终可访问。
    setTab(nextTab);
  }, [offPeakVisible, tab]);

  useEffect(() => {
    if (!openAutomationTab) return;
    // 灰度关：请求的「工作流」标签不存在，
    // 落到「自动化」并把深链消费掉——不消费会让请求一直挂着，反复把页面拉回来。
    if (openAutomationTab === "workflow" && !dynamicWorkflowEnabled) {
      setPageTab("automation");
      onOpenAutomationConsumed?.();
      return;
    }
    if (openAutomationTab === "workflow") {
      setPageTab("workflow");
      onOpenAutomationConsumed?.();
      return;
    }
    // 闲时详情导航由下方 offpeak 分支统一 setTab("idle") + 消费；这里若先按
    // 当前（可能尚未加载的）可见 tab 回退到 scheduled 并消费，会把 pending 的详情导航一并清掉。
    if (isOffPeakDetailNavigationId(openAutomationId)) return;
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationTabNavigation({
      requestedTab: openAutomationTab,
      tabsReady:
        currentWorkspaceKey !== null &&
        loadedWorkspaceKey === currentWorkspaceKey &&
        !offPeakStoreLoading,
      visibleTabs,
    });
    if (result.status === "pending") return;
    setPageTab("automation");
    if (result.tab !== tab) setTab(result.tab);
    onOpenAutomationConsumed?.();
  }, [
    dynamicWorkflowEnabled,
    loadedWorkspaceKey,
    setLoadedWorkspaceKey,
    offPeakStoreLoading,
    onOpenAutomationConsumed,
    openAutomationId,
    openAutomationTab,
    setPageTab,
    tab,
    visibleTabs,
    workspaceIdentity,
    workspacePath,
  ]);

  // 服务端给出准确恢复时间；到点后重查。刷新期间及失败后继续禁入，直到成功返回 true。
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const delay = Math.max(0, nextTakeAt - Date.now()) + 100;
    const timer = setTimeout(() => {
      setNow(Date.now());
      void offPeakRefreshTakeNumberAvailability(offPeakTaskService);
    }, delay);
    return () => clearTimeout(timer);
  }, [offPeakRefreshTakeNumberAvailability, offPeakTaskService, offPeakTakeNumberAvailability]);

  // 额度 Tooltip 曾改成不会递减的绝对日期；按远端实现推进分钟边界，保持剩余时长准确。
  useEffect(() => {
    const nextTakeAt = offPeakTakeNumberAvailability?.nextTakeAt;
    if (offPeakTakeNumberAvailability?.canTakeNumber !== false || nextTakeAt === undefined) return;
    const remainingMs = nextTakeAt - Date.now();
    if (remainingMs <= 0) return;
    const minuteMs = 60_000;
    const remainderMs = remainingMs % minuteMs;
    const delay = (remainderMs === 0 ? minuteMs : remainderMs) + 50;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [now, offPeakTakeNumberAvailability]);

  // 位次/状态轮询刷新（host offPeakTaskSync 写库，renderer 每 10s 读快照；无任务不轮）。
  useEffect(() => {
    if (view.mode !== "list" || offPeakTasks.length === 0) return;
    const timer = setInterval(() => {
      void offPeakRefresh(offPeakTaskService);
    }, 10_000);
    return () => clearInterval(timer);
  }, [view.mode, offPeakTasks.length, offPeakRefresh, offPeakTaskService]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(zcodeAgentService),
        offPeakRefresh(offPeakTaskService),
        ...(offPeakGrayEnabled ? [offPeakRefreshCodingPlanSupport(offPeakTaskService)] : []),
      ]);
      setNow(Date.now());
    } finally {
      setRefreshing(false);
    }
  }, [
    offPeakGrayEnabled,
    offPeakRefresh,
    offPeakRefreshCodingPlanSupport,
    offPeakTaskService,
    refresh,
    zcodeAgentService,
  ]);

  // New task 页模板卡跳转过来：消费预填草稿 → 切 idle tab + 打开创建表单预填。
  useEffect(() => {
    const draft = consumePendingCreateDraft();
    if (!draft) return;
    if (currentWorkspaceIsRemote) return;
    setTab("idle");
    setView({ mode: "offpeak-create", draft });
  }, [consumePendingCreateDraft, currentWorkspaceIsRemote]);

  useEffect(() => {
    if (!currentWorkspaceIsRemote) return;
    setTab((current) => (current === "idle" ? "scheduled" : current));
    setView((current) =>
      current.mode === "offpeak-create" || current.mode === "offpeak-edit"
        ? { mode: "list" }
        : current,
    );
  }, [currentWorkspaceIsRemote]);

  const handleOpenCodingPlanUpgrade = useCallback(() => {
    const providerId =
      sharedSettings?.providerFamilyDomain === "bigmodel"
        ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
        : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const eventText = intl.formatMessage({
      id: "settings.modelProvider.codingPlan.upgrade",
    });
    // 埋点缺失原因：Automations 的闲时入口此前绕过了购买漏斗 context，只打开弹窗。
    // 这里在用户点击时冻结入口套餐状态，后续 OAuth 只刷新鉴权，不重建 funnel。
    openCodingPlanUpgrade({
      providerId,
      initialAudience: "personal",
      funnelContext: createIdleTimeCodingPlanFunnelContext({
        providerId,
        eventText,
        entryPlanState: resolveCodingPlanEntryPlanStateFromProviderSettings(providerSettingsView),
      }),
    });
  }, [intl, openCodingPlanUpgrade, providerSettingsView, sharedSettings?.providerFamilyDomain]);

  const showCodingPlanRequiredToast = useCallback(() => {
    toast(entryLabel ?? intl.formatMessage({ id: "offPeak.create.codingPlanToast" }), {
      durationMs: 8000,
      position: "top-center",
      variant: "info",
      actionLabel:
        entryStatus === "loading"
          ? undefined
          : (entryLabel ??
            intl.formatMessage({
              id: "settings.modelProvider.codingPlan.upgrade",
            })),
      onAction: entryStatus === "error" ? retryEntry : handleOpenCodingPlanUpgrade,
      dismissible: true,
      dismissLabel: intl.formatMessage({ id: "common.close" }),
    });
  }, [handleOpenCodingPlanUpgrade, intl, entryStatus, entryLabel, retryEntry]);

  const showAutomationCreateLimitToast = useCallback(() => {
    toast(
      intl.formatMessage(
        { id: "automations.error.createLimit" },
        { limit: String(AUTOMATION_CREATE_LIMIT) },
      ),
    );
  }, [intl]);

  // 会话内 OffPeakCreate 由 agent 直接落库，不经过 UI store；store 的 loading 初值也
  // 是 false（"未加载"与"已加载"不可分）。因此每次 offpeak 导航都强制刷新列表，并以
  // 「本次导航 id 的刷新已完成」作为唯一就绪信号，避免拿陈旧/空列表误判 targetNotFound。
  const [offPeakNavRefreshed, setOffPeakNavRefreshed] = useState<{
    id: string | null;
    error: string | null;
  }>({ id: null, error: null });
  useEffect(() => {
    if (!isOffPeakDetailNavigationId(openAutomationId)) return;
    let disposed = false;
    void offPeakRefresh(offPeakTaskService).finally(() => {
      if (disposed) return;
      // review：refresh 不 reject，失败只写 store.error；把它随就绪信号一起带出。
      setOffPeakNavRefreshed({
        id: openAutomationId ?? null,
        error: useOffPeakTaskStore.getState().error ?? null,
      });
    });
    return () => {
      disposed = true;
    };
  }, [openAutomationId, offPeakRefresh, offPeakTaskService]);

  useEffect(() => {
    // 闲时轮尾卡携带 offpeak- 前缀 id，从并行路径解析进 offpeak-edit 视图；
    // 不能落进 cron 解析（必然 missing 并误报 targetNotFound）。
    if (isOffPeakDetailNavigationId(openAutomationId)) {
      const result = resolveOffPeakDetailNavigation(
        offPeakTasks,
        openAutomationId,
        offPeakNavRefreshed.id === openAutomationId,
        offPeakNavRefreshed.error,
      );
      if (result.status === "pending") return;
      if (result.status === "found") {
        setTab("idle");
        setView({ mode: "offpeak-edit", task: result.target });
      } else if (result.status === "unavailable") {
        // 列表刷新失败：落到闲时 tab 并提示加载失败，不误报"任务不存在"。
        setTab("idle");
        toast(intl.formatMessage({ id: "offPeak.nav.listUnavailable" }));
      } else {
        toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
      }
      onOpenAutomationConsumed?.();
      return;
    }
    const currentWorkspaceKey = workspacePath
      ? resolveWorkspaceKey({ workspacePath, workspaceIdentity })
      : null;
    const result = resolveAutomationDetailNavigation(
      automations,
      openAutomationId,
      currentWorkspaceKey !== null && loadedWorkspaceKey === currentWorkspaceKey,
    );
    if (result.status === "pending") return;
    if (result.status === "found") {
      setView({ mode: "edit", automation: result.target });
    } else {
      // 目标任务可能已删除；失效的一次性导航必须提示并消费，不能影响后续进入页面。
      toast(intl.formatMessage({ id: "automations.error.targetNotFound" }));
    }
    onOpenAutomationConsumed?.();
  }, [
    automations,
    intl,
    loadedWorkspaceKey,
    offPeakNavRefreshed,
    offPeakTasks,
    onOpenAutomationConsumed,
    openAutomationId,
    workspaceIdentity,
    workspacePath,
  ]);
  return {
    handleRefresh,
    showCodingPlanRequiredToast,
    showAutomationCreateLimitToast,
    offPeakNavRefreshed,
  };
}
