/**
 * Automations 主视图列表页：标签页、状态筛选、任务卡、空态、模板区。
 *
 * 仅负责渲染与把用户动作转交给 hooks 暴露的处理器。
 */
import type { ReactNode } from "react";
import { TID_AUTOMATIONS_STATUS_FILTER, TID_OFFPEAK_TAB } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { OffPeakTaskList } from "@/settings/OffPeakTaskList.js";
import {
  AutomationCreateDropdown,
  AutomationKeepAwakeNotice,
  AutomationRefreshIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { AUTOMATION_STATUS_FILTERS } from "@/settings/automationStatusFilter.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  materializeOffPeakTemplateDraft,
  type OffPeakAutomationTemplate,
} from "@/settings/automationTemplateCatalog.js";
import type { AutomationsSectionActions } from "@/settings/automations-section/automationsSectionTypes.js";
import { AutomationCardGrid } from "@/settings/automations-section/AutomationCardGrid.js";
import { OffPeakCreateButton } from "@/settings/automations-section/OffPeakCreateButton.js";
import {
  OffPeakTemplateSection,
  ScheduledTemplateSection,
} from "@/settings/automations-section/AutomationTemplateSections.js";
import type { useAutomationNavigationEffects } from "@/settings/automations-section/useAutomationNavigationEffects.js";
import type { useAutomationsDashboardState } from "@/settings/automations-section/useAutomationsDashboardState.js";

/** 状态筛选命中 0 条时的占位；复用闲时空态卡的描边样式，文案与「还没有任务」区分开。 */
function AutomationStatusFilterEmpty() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "automations.statusFilter.empty" })}
    </div>
  );
}

export interface AutomationsDashboardListViewProps {
  header: ReactNode;
  state: ReturnType<typeof useAutomationsDashboardState>;
  navigation: ReturnType<typeof useAutomationNavigationEffects>;
  actions: AutomationsSectionActions;
}

export function AutomationsDashboardListView({
  header,
  state,
  navigation,
  actions,
}: AutomationsDashboardListViewProps) {
  const {
    intl,
    locale,
    setView,
    tab,
    setTab,
    statusFilter,
    setStatusFilter,
    visibleTabs,
    hasVisibleTaskCards,
    visibleAutomations,
    visibleOffPeakTasks,
    showOffPeakTemplates,
    showScheduledTemplates,
    showTaskTemplateSeparator,
    automations,
    offPeakTasks,
    offPeakVisible,
    offPeakCreationEnabled,
    offPeakOperationId,
    offPeakCreateGrey,
    refreshing,
    loading,
    operationId,
    automationTemplates,
    sharedSettings,
    updateSharedSettings,
    offPeakPause,
    offPeakContinue,
    now,
    offPeakTaskService,
    hasAnyTasks,
  } = state;
  const { handleRefresh, showCodingPlanRequiredToast } = navigation;
  const {
    handleCreateViaChat,
    handleCreateManually,
    handleUseTemplate,
    handleRunNow,
    handleToggle,
    handleRestart,
    handleDelete,
    handleOffPeakOpen,
    handleOffPeakCancel,
    handleOffPeakDelete,
    handleOffPeakOpenSession,
  } = actions;

  // 「More ideas」闲时模板 → 预填创建表单；customize 模板只带来源埋点，文案由表单自己渲染。
  const handleSelectOffPeakTemplate = (template: OffPeakAutomationTemplate) => {
    const materializedDraft = materializeOffPeakTemplateDraft(template, locale);
    setView({
      mode: "offpeak-create",
      draft: template.customize
        ? {
            telemetrySource: {
              eventRegion: "app.automations",
              templateId: template.id,
            },
          }
        : {
            title: materializedDraft.title,
            prompt: materializedDraft.prompt,
            telemetrySource: {
              eventRegion: "app.automations",
              templateId: template.id,
            },
          },
    });
  };

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {header}

      {/* Tab：Scheduled 常驻；Idle 仅在灰度命中或有闲时存量时出现（D31），不再提供 All 混排视图。
         有任务时右上对齐创建（4866-1735）；空态创建入口在大卡内（4889-2013），不重复顶栏按钮。 */}
      {visibleTabs.length > 0 ? (
        <div className="mt-8 flex items-center justify-between">
          {/* 修复原因：tab 曾与右侧操作组共用 12px 间距，未体现最新设计要求的 8px 紧凑节奏。 */}
          <div className="flex items-center gap-2" data-testid={TID_OFFPEAK_TAB}>
            {/* 修复原因：未选中态旧实现强制显示 surface 背景，无法与 hover、选中态形成层级。 */}
            {visibleTabs.map((key) => (
              <button
                key={key}
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                  tab === key
                    ? "bg-selected text-foreground"
                    : "text-foreground-subtle hover:bg-hover hover:text-foreground",
                )}
                onClick={() => setTab(key)}
              >
                {intl.formatMessage({ id: `offPeak.tabs.${key}` })}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <ControlHintTooltip
              title={intl.formatMessage({
                id: refreshing ? "automations.refreshing" : "automations.refresh",
              })}
            >
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={intl.formatMessage({ id: "automations.refresh" })}
                onClick={() => void handleRefresh()}
                disabled={refreshing}
              >
                <AutomationRefreshIcon
                  className={cn("size-3.5", refreshing && "animate-spin")}
                  aria-hidden="true"
                />
              </Button>
            </ControlHintTooltip>
            {tab !== "idle" ? (
              <AutomationCreateDropdown
                onViaChat={handleCreateViaChat}
                onManually={handleCreateManually}
              />
            ) : null}
            {showOffPeakTemplates ? (
              <OffPeakCreateButton
                greyReason={offPeakCreateGrey.reason}
                greyTooltip={offPeakCreateGrey.tooltip}
                onCreate={() => setView({ mode: "offpeak-create" })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 状态筛选：定时 / 闲时共用一组（全部 / 进行中 / 已完成 / 失败），只在当前 tab 有任务时出现。
         样式沿用顶栏 tab 的胶囊，但字号与内边距更小以体现层级。 */}
      {visibleTabs.length > 0 && hasVisibleTaskCards ? (
        <div
          className="mt-3 flex flex-wrap items-center gap-1.5"
          data-testid={TID_AUTOMATIONS_STATUS_FILTER}
        >
          {AUTOMATION_STATUS_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilter === key}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-ui-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                statusFilter === key
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
              onClick={() => setStatusFilter(key)}
            >
              {intl.formatMessage({ id: `automations.statusFilter.${key}` })}
            </button>
          ))}
        </div>
      ) : null}

      {loading && automations.length === 0 && offPeakTasks.length === 0 ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8",
            // 列表态提示栏与 action row 旧间距为 16px，小于设计稿要求的 20px。
            hasAnyTasks ? "mt-5" : "mt-8",
          )}
        >
          <div className="flex w-full flex-col gap-4">
            {/* keep-awake 是全局开关（与设置页「常规」镜像），定时任务运行会话同样受益，
               在定时/闲时两个 tab 都展示。列表态放在任务卡之前，空态保持大空卡在前。 */}
            {hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}

            {/* 去掉 All 混排视图后两类任务不再共用统一 grid；保留该锚点标记任务区起点。 */}
            <div data-automations-task-grid className="contents">
              {offPeakVisible && tab !== "scheduled" && offPeakTasks.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  {visibleOffPeakTasks.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <OffPeakTaskList
                      tasks={visibleOffPeakTasks}
                      busyOperationId={offPeakOperationId}
                      onOpen={handleOffPeakOpen}
                      onPause={(task) => void offPeakPause(task.offPeakTaskId, offPeakTaskService)}
                      onContinue={(task) =>
                        void offPeakContinue(task.offPeakTaskId, offPeakTaskService)
                      }
                      onCancel={(task) => void handleOffPeakCancel(task)}
                      onDelete={(task) => void handleOffPeakDelete(task)}
                      onOpenSession={handleOffPeakOpenSession}
                    />
                  )}
                </section>
              ) : null}

              {/* Task created：当前项目已创建的真实定时任务(全部)。点整张卡片进编辑。
                 闲时任务 tab 下整个定时任务区（卡片/空状态/通过对话创建）都不渲染。 */}
              {tab === "idle" ? null : automations.length > 0 ? (
                <section className="flex w-full flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                      {intl.formatMessage({ id: "automations.createdLabel" })}
                    </h2>
                    {/* 无 tab 行时创建入口落在本区标题右侧；有 tab 行时入口已在顶栏，避免重复。 */}
                    {visibleTabs.length === 0 ? (
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                    ) : null}
                  </div>
                  {visibleAutomations.length === 0 ? (
                    <AutomationStatusFilterEmpty />
                  ) : (
                    <AutomationCardGrid
                      visibleAutomations={visibleAutomations}
                      now={now}
                      operationId={operationId}
                      onOpen={(target) => setView({ mode: "edit", automation: target })}
                      onRunNow={handleRunNow}
                      onToggle={handleToggle}
                      onRestart={handleRestart}
                      onDelete={handleDelete}
                    />
                  )}
                </section>
              ) : (
                /* 空状态卡先于 Keep-awake，按钮组整体较卡片中心下移 8px。 */
                <div
                  data-automations-empty-state
                  className="flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
                >
                  <div className="flex translate-y-2 flex-col items-center gap-5">
                    <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                      {intl.formatMessage({ id: "automations.empty.title" })}
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <AutomationCreateDropdown
                        onViaChat={handleCreateViaChat}
                        onManually={handleCreateManually}
                      />
                      {/* 有闲时任务时右上已有创建入口，空卡不再重复（4866-1735 vs 4889-2013）。 */}
                      {offPeakCreationEnabled && offPeakTasks.length === 0 ? (
                        <OffPeakCreateButton
                          greyReason={offPeakCreateGrey.reason}
                          greyTooltip={offPeakCreateGrey.tooltip}
                          onCreate={() => setView({ mode: "offpeak-create" })}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Figma 4798:2443：空态保持唤醒提示条位于大空卡之后。 */}
            {!hasAnyTasks ? (
              <AutomationKeepAwakeNotice
                checked={sharedSettings?.keepAwakeWhileRunning ?? false}
                onChange={(value) =>
                  void updateSharedSettings({
                    keepAwakeWhileRunning: value,
                  })
                }
              />
            ) : null}
          </div>

          {/* 修复原因：真实任务卡与模板此前只靠空白分区，遗漏了 Figma 4835:5515 的分割线；
             分割线使用 surface 在 Light 下过淡，因此与 Card 统一使用 card-border。
             外层 gap-8 加本容器 py-2，使卡片到线、线到模板标题均保持 40px。 */}
          {showTaskTemplateSeparator ? (
            <div
              data-automations-task-template-separator
              className="flex w-full flex-col py-2"
              aria-hidden="true"
            >
              <div className="h-px w-full bg-card-border" />
            </div>
          ) : null}

          {showOffPeakTemplates ? (
            <OffPeakTemplateSection
              loading={automationTemplates.loading}
              templates={automationTemplates.offPeak}
              planLocked={offPeakCreateGrey.reason === "plan"}
              onCodingPlanRequired={showCodingPlanRequiredToast}
              onSelectTemplate={handleSelectOffPeakTemplate}
            />
          ) : null}

          {showScheduledTemplates ? (
            <ScheduledTemplateSection
              loading={automationTemplates.loading}
              templates={automationTemplates.scheduled}
              onSelectTemplate={handleUseTemplate}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
