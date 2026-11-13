/**
 * Automations 主视图的用户动作处理：创建/编辑提交、启停、重启、立即运行、删除与闲时任务打开/取消。
 *
 * 以自定义 hook 承接，保持与原组件一致的 `useCallback` 顺序和依赖数组。
 * 闲时任务删除的破坏性确认留在 `AutomationsSection.tsx`（破坏性入口清单按文件核对）。
 */
import { useCallback } from "react";
import {
  AUTOMATION_CREATE_LIMIT,
  type ZCodeAutomation,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  reportAutomationActionClick,
  reportAutomationCreateResult,
  resolveAutomationSelectionTelemetry,
} from "@/lib/automationTelemetry.js";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";
import {
  materializeScheduledTemplateDraft,
  type ScheduledAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import type { AutomationEditSubmit } from "@/settings/AutomationEditView.js";
import {
  getAutomationActionErrorToastId,
  getAutomationCreateErrorToastId,
  getAutomationRunNowToastId,
} from "@/settings/automations-section/automationViewResolvers.js";
import { toast } from "@/settings/automations-section/automationsSectionToast.js";
import type { AutomationsSectionProps } from "@/settings/automations-section/automationsSectionTypes.js";
import type { useAutomationNavigationEffects } from "@/settings/automations-section/useAutomationNavigationEffects.js";
import type { useAutomationsDashboardState } from "@/settings/automations-section/useAutomationsDashboardState.js";

export interface UseAutomationActionHandlersParams {
  state: ReturnType<typeof useAutomationsDashboardState>;
  navigation: ReturnType<typeof useAutomationNavigationEffects>;
  onCreateViaChat?: AutomationsSectionProps["onCreateViaChat"];
  onOpenSession?: AutomationsSectionProps["onOpenSession"];
}

export function useAutomationActionHandlers({
  state,
  navigation,
  onCreateViaChat,
  onOpenSession,
}: UseAutomationActionHandlersParams) {
  const {
    automationCreateLimitReached,
    currentWorkspaceIsRemote,
    view,
    setView,
    intl,
    locale,
    providerSettingsView,
    platform,
    zcodeAgentService,
    updateAutomation,
    createAutomation,
    setNow,
    setEnabled,
    restartAutomation,
    runAutomationNow,
    loadRuns,
    confirmDialog,
    deleteAutomation,
    offPeakTaskService,
    offPeakCancel,
  } = state;
  const { showAutomationCreateLimitToast } = navigation;
  const handleCreateManually = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    setView({ mode: "create", draft: null });
  }, [automationCreateLimitReached, showAutomationCreateLimitToast]);

  // 「Create via chat」:交给 parent 切到会话视图;未提供则回退到手动创建整页。
  const handleCreateViaChat = useCallback(() => {
    if (automationCreateLimitReached) {
      showAutomationCreateLimitToast();
      return;
    }
    if (currentWorkspaceIsRemote) {
      // Automations 创建只能绑定本地项目；远端当前会话不能隐式成为创建目标。
      // 仍保留管理页，但把创建收敛到带本地项目选择器的表单。
      setView({ mode: "create", draft: null });
      return;
    }
    if (onCreateViaChat) {
      onCreateViaChat(intl.formatMessage({ id: "automations.createViaChat.prompt" }));
    } else setView({ mode: "create", draft: null });
  }, [
    automationCreateLimitReached,
    currentWorkspaceIsRemote,
    intl,
    onCreateViaChat,
    showAutomationCreateLimitToast,
  ]);

  const handleUseTemplate = useCallback(
    (template: ScheduledAutomationTemplate) => {
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return;
      }
      const draft = materializeScheduledTemplateDraft(template, locale);
      setView({
        mode: "create",
        draft,
      });
    },
    [automationCreateLimitReached, locale, showAutomationCreateLimitToast],
  );

  // 创建/编辑整页提交:创建可指定目标项目;编辑锁定原项目。
  const handleEditSubmit = useCallback(
    async ({
      input,
      workspacePath: targetPath,
      workspaceIdentity: targetIdentity,
    }: AutomationEditSubmit) => {
      if (view.mode === "edit") {
        const ok = await updateAutomation(view.automation.automationId, input, zcodeAgentService);
        if (!ok) {
          toast(
            intl.formatMessage({
              id: getAutomationActionErrorToastId("update"),
            }),
          );
        } else {
          setNow(Date.now());
        }
        return ok;
      }
      if (automationCreateLimitReached) {
        showAutomationCreateLimitToast();
        return false;
      }
      const created = await createAutomation(
        {
          ...(input as Parameters<typeof createAutomation>[0]),
          workspacePath: targetPath,
          workspaceIdentity: targetIdentity,
        },
        zcodeAgentService,
      );
      void reportAutomationCreateResult(platform, {
        automationId: created?.automationId,
        cronExpr: input.cronExpr ?? "",
        templateId: view.mode === "create" ? view.draft?.templateId : undefined,
        error: useAutomationManagementStore.getState().error,
        modelFields: resolveAutomationSelectionTelemetry(
          input.modelSelection,
          providerSettingsView,
        ),
      });
      if (!created) {
        const createError = useAutomationManagementStore.getState().error;
        toast(
          intl.formatMessage(
            { id: getAutomationCreateErrorToastId(createError) },
            { limit: String(AUTOMATION_CREATE_LIMIT) },
          ),
        );
        return false;
      }
      setNow(Date.now());
      return true;
    },
    [
      automationCreateLimitReached,
      createAutomation,
      intl,
      platform,
      providerSettingsView,
      showAutomationCreateLimitToast,
      updateAutomation,
      view,
      zcodeAgentService,
    ],
  );

  const handleToggle = useCallback(
    async (automation: ZCodeAutomation, enabled: boolean) => {
      await setEnabled(automation.automationId, enabled, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("toggle") }));
      else {
        // 编辑页 view 持有进入页面时的 automation 对象；列表刷新不会自动替换
        // 这个局部对象，导致菜单点击 Pause/Resume 后文案仍停在旧状态。
        setView((prev) =>
          prev.mode === "edit" && prev.automation.automationId === automation.automationId
            ? {
                mode: "edit",
                automation: {
                  ...prev.automation,
                  enabled,
                  lifecycleStatus: enabled ? "active" : "paused",
                },
              }
            : prev,
        );
        setNow(Date.now());
      }
    },
    [intl, setEnabled, zcodeAgentService],
  );

  const handleRestart = useCallback(
    async (automation: ZCodeAutomation) => {
      await restartAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message)
        toast(
          intl.formatMessage({
            id: getAutomationActionErrorToastId("restart"),
          }),
        );
      else setNow(Date.now());
    },
    [intl, restartAutomation, zcodeAgentService],
  );

  const handleRunNow = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      logger.debug("[automations] 立即运行交互开始", {
        automationId: automation.automationId,
        source,
      });
      void reportAutomationActionClick(platform, {
        action: "run_now",
        source,
        automation,
        providerSettingsView,
      });
      const result = await runAutomationNow(automation.automationId, zcodeAgentService);
      logger.debug("[automations] 立即运行交互结束", {
        automationId: automation.automationId,
        source,
        result,
      });
      if (result === "queued") {
        await loadRuns(automation.automationId, zcodeAgentService, true);
        const latestSessionId = useAutomationManagementStore
          .getState()
          .runsCache[automation.automationId]?.runs?.find(
            (run) => run.trigger === "manual" && Boolean(run.sessionId),
          )?.sessionId;
        toast(
          intl.formatMessage({ id: "scheduledPreview.toast.running" }, { title: automation.title }),
          {
            durationMs: 4000,
            position: "top-center",
            variant: "info",
            ...(latestSessionId && onOpenSession
              ? {
                  actionLabel: intl.formatMessage({
                    id: "scheduledPreview.toast.view",
                  }),
                  onAction: () =>
                    onOpenSession({
                      sessionId: latestSessionId,
                      workspacePath: automation.workspacePath,
                      workspaceIdentity: automation.workspaceIdentity,
                    }),
                }
              : {}),
            dismissible: true,
            dismissLabel: intl.formatMessage({ id: "common.close" }),
          },
        );
        setNow(Date.now());
      } else if (result === "duplicate") {
        // 连续点击或上一条 manual run 仍在执行时，store/host 会返回 duplicate。
        // 这里必须给出可见反馈，否则用户会以为按钮没响应。
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      } else if (result === "failed") {
        toast(intl.formatMessage({ id: getAutomationRunNowToastId(result) }));
      }
    },
    [
      intl,
      loadRuns,
      onOpenSession,
      platform,
      providerSettingsView,
      runAutomationNow,
      zcodeAgentService,
    ],
  );

  const handleDelete = useCallback(
    async (automation: ZCodeAutomation, source: "list" | "editor" = "list") => {
      const confirmed = await confirmDialog({
        presentation: "automation-confirmation",
        title: intl.formatMessage({ id: "automations.delete.title" }),
        description: intl.formatMessage(
          { id: "automations.delete.description" },
          { title: automation.title },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
        confirmVariant: "destructive",
        // 共享确认弹窗默认在按钮右侧渲染 esc / ⏎，在删除场景会被视为额外图标。
        // 定时任务删除按钮只保留动作文字，且不改变其他确认弹窗的键盘提示策略。
        showKeyboardHints: false,
      });
      if (!confirmed) return;
      void reportAutomationActionClick(platform, {
        action: "delete",
        source,
        automation,
        providerSettingsView,
      });
      await deleteAutomation(automation.automationId, zcodeAgentService);
      const message = useAutomationManagementStore.getState().error;
      if (message) toast(intl.formatMessage({ id: getAutomationActionErrorToastId("delete") }));
      // 若在编辑该任务的整页,删除后回列表。
      setView((prev) =>
        prev.mode === "edit" && prev.automation.automationId === automation.automationId
          ? { mode: "list" }
          : prev,
      );
    },
    [confirmDialog, deleteAutomation, intl, platform, providerSettingsView, zcodeAgentService],
  );

  const handleOffPeakOpenSession = useCallback(
    (task: ZCodeOffPeakTask) => {
      if (!task.sessionId || !onOpenSession) return;
      onOpenSession({
        sessionId: task.sessionId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
    },
    [onOpenSession],
  );

  const handleOffPeakOpen = useCallback((task: ZCodeOffPeakTask) => {
    // 有 session 的卡片主点击不能直接跳会话：会使 Settings/History
    // 无法稳定到达。卡片主路径始终进入任务详情，会话只保留为显式次级动作。
    setView({ mode: "offpeak-edit", task });
  }, []);

  const handleOffPeakCancel = useCallback(
    async (task: ZCodeOffPeakTask) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "offPeak.cancel.title" }),
        description: intl.formatMessage(
          { id: "offPeak.cancel.description" },
          { title: task.title || task.prompt },
        ),
        confirmLabel: intl.formatMessage({ id: "offPeak.action.cancel" }),
      });
      if (!confirmed) return;
      await offPeakCancel(task.offPeakTaskId, offPeakTaskService);
      const message = useOffPeakTaskStore.getState().error;
      if (message) toast(message);
    },
    [confirmDialog, intl, offPeakCancel, offPeakTaskService],
  );
  return {
    handleCreateManually,
    handleCreateViaChat,
    handleUseTemplate,
    handleEditSubmit,
    handleToggle,
    handleRestart,
    handleRunNow,
    handleDelete,
    handleOffPeakOpenSession,
    handleOffPeakOpen,
    handleOffPeakCancel,
  };
}
