import { useStartPlanRecommendation } from "@/hooks/useStartPlanRecommendation.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { type ZCodeAutomationScheduleRule } from "@zcode/shared";
import { type AutomationSettingsHistoryTab } from "@/settings/AutomationDesignPrimitives.js";
import { resolveLocalizedAutomationCreateTitle } from "@/settings/automationEditLocalizedTitle.js";
import { AUTOMATION_DEFAULT_MODE } from "@/settings/automationAgentConfigOptions.js";
import {
  resolveChangedAutomationEditFields,
  type AutomationEditDirtyField,
  type AutomationEditFieldSignatures,
} from "@/settings/automationEditDirtyState.js";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
  type AutomationEditRequiredField,
} from "@/settings/automationEditValidation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { saveAndRunAutomation } from "@/settings/automation-edit-view/automationEditSaveAndRun.js";
import type { AutomationEditViewProps } from "@/settings/automation-edit-view/automationEditTypes.js";
import {
  initialBuilder,
  normalizeAutomationScheduleRule,
  workspaceLabelFromPath,
} from "@/settings/automation-edit-view/automationEditFormModel.js";
import { useAutomationEditModelSelection } from "@/settings/automation-edit-view/useAutomationEditModelSelection.js";
import { logger } from "@/logger.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import {
  buildCronExpr,
  canVisualizeCronInAutomationEditor,
  describeCronBuilder,
  isSessionCreatedAutomation as resolveIsSessionCreatedAutomation,
  resolveAutomationStatusKind,
  type CronBuilderState,
} from "@/settings/automationFormat.js";
import type {
  CreateAutomationInput,
  UpdateAutomationInput,
} from "@/store/automationManagementStore.js";

export function useAutomationEditViewState({
  editing,
  initialDraft,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  onManageModels,
  saving,
  onSubmit,
  onBack,
  onRunNow,
  onToggle,
  onDelete,
  runsEntry,
  onLoadRuns,
  onDeleteRun,
  onOpenSession,
}: AutomationEditViewProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  const [runsPage, setRunsPage] = useState(1);
  const onLoadRunsRef = useRef(onLoadRuns);
  const saveAndRunPendingRef = useRef(false);
  const [saveAndRunPending, setSaveAndRunPending] = useState(false);
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "automations.edit.titlePlaceholder",
  });
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  const titleTouchedRef = useRef(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState<string>("");
  const modelSelection = useRef("");
  const [mode, setMode] = useState<string>(AUTOMATION_DEFAULT_MODE);
  const modeRef = useRef(AUTOMATION_DEFAULT_MODE);
  const [thoughtLevel, setThoughtLevel] = useState<string>("");
  const thoughtLevelRef = useRef("");
  const modelManuallyChangedRef = useRef(false);
  const thoughtManuallyChangedRef = useRef(false);
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // 不能首帧先渲染默认的“每天 09:00”、再由 effect 回填持久化调度。
  // 子级调度控件会先注册 value 回调，从而把默认值误记成 dirty baseline；编辑态必须首帧即使用真实值。
  const [builder, setBuilder] = useState<CronBuilderState>(() =>
    initialBuilder(editing, initialDraft),
  );
  // 新建任务默认不带日程，通过「Add schedule」显式添加；移除后未补齐标红提示。
  const [scheduleRemoved, setScheduleRemoved] = useState(!editing && !initialDraft);
  const [validationErrors, setValidationErrors] = useState<
    ReadonlySet<AutomationEditRequiredField>
  >(() => new Set());
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<AutomationEditDirtyField>>(
    () => new Set(),
  );
  const currentEditSignaturesRef = useRef<AutomationEditFieldSignatures | null>(null);
  const touchedFieldBaselinesRef = useRef<Partial<AutomationEditFieldSignatures>>({});
  const [endAt, setEndAt] = useState<number | undefined>(() => editing?.endAt);
  // 目标项目 key(仅新建时可改;编辑锁定为 automation 所属项目)。
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);

  const localWorkspaceOptions = useAutomationProjectOptions();
  const editingWorkspaceOption = editing
    ? findAutomationWorkspaceOptionByKey(
        localWorkspaceOptions,
        resolveAutomationWorkspaceSelectionKey(editing),
      )
    : undefined;
  const workspaceOptions = useMemo<AutomationWorkspaceOption[]>(
    () =>
      editing
        ? [
            {
              workspacePath: editing.workspacePath,
              workspaceIdentity: editing.workspaceIdentity,
              projectId: editing.projectId,
              hostId: editing.hostId,
              label: editingWorkspaceOption?.label ?? workspaceLabelFromPath(editing.workspacePath),
            },
          ]
        : localWorkspaceOptions,
    [editing, editingWorkspaceOption, localWorkspaceOptions],
  );
  const workspaceOptionsRef = useRef(workspaceOptions);
  workspaceOptionsRef.current = workspaceOptions;

  // 打开/切换编辑对象时重置表单。
  useEffect(() => {
    setTab("settings");
    setRunsPage(1);
    setTouchedFields(new Set());
    setValidationErrors(new Set());
    touchedFieldBaselinesRef.current = {};
    if (editing) {
      setScheduleRemoved(false);
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(editing.title);
      setPrompt(editing.prompt);
      const editingModel = editing.modelSelection
        ? encodeCustomModelValue(editing.modelSelection.providerId, editing.modelSelection.modelId)
        : "";
      const editingThoughtLevel = editing.modelSelection?.options?.reasoningLevel?.trim() ?? "";
      modelSelection.current = editingModel;
      thoughtLevelRef.current = editingThoughtLevel;
      setModel(editingModel);
      const editingMode = editing.mode?.trim() || AUTOMATION_DEFAULT_MODE;
      modeRef.current = editingMode;
      setMode(editingMode);
      setThoughtLevel(editingThoughtLevel);
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(editing.endAt);
      setWorkspaceKey(resolveAutomationWorkspaceSelectionKey(editing));
    } else {
      setScheduleRemoved(!initialDraft);
      // 新建页的默认标题可随 locale 更新；模板标题仍属于用户明确选择的内容。
      titleTouchedRef.current = false;
      modelManuallyChangedRef.current = false;
      thoughtManuallyChangedRef.current = false;
      setTitle(initialDraft?.title ?? localizedDefaultCreateTitle);
      setPrompt(initialDraft?.prompt ?? "");
      modelSelection.current = "";
      setModel("");
      modeRef.current = AUTOMATION_DEFAULT_MODE;
      thoughtLevelRef.current = "";
      setMode(AUTOMATION_DEFAULT_MODE);
      setThoughtLevel("");
      setBuilder(initialBuilder(editing, initialDraft));
      setEndAt(undefined);
      setWorkspaceKey(
        reconcileAutomationWorkspaceSelectionKey(workspaceOptionsRef.current, null, {
          workspacePath: defaultWorkspacePath,
          workspaceIdentity: defaultWorkspaceIdentity,
        }),
      );
    }
  }, [editing, initialDraft, defaultWorkspacePath, defaultWorkspaceIdentity]);

  useEffect(() => {
    const nextTitle = resolveLocalizedAutomationCreateTitle({
      currentTitle: title,
      hasInitialDraft: Boolean(initialDraft),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    if (nextTitle !== title) {
      setTitle(nextTitle);
    }
  }, [editing, initialDraft, localizedDefaultCreateTitle, title]);

  useEffect(() => {
    if (editing) return;
    // 候选为空或默认项目已失效时不能保留 default workspace 并允许落库。
    // 任何 tab 变化都重新把选择收敛到当前有效项目；没有候选时必须明确置空。
    setWorkspaceKey((currentWorkspaceKey) =>
      reconcileAutomationWorkspaceSelectionKey(workspaceOptions, currentWorkspaceKey, {
        workspacePath: defaultWorkspacePath,
        workspaceIdentity: defaultWorkspaceIdentity,
      }),
    );
  }, [defaultWorkspaceIdentity, defaultWorkspacePath, editing, workspaceOptions]);

  const markFieldTouched = useCallback((field: AutomationEditDirtyField) => {
    if (touchedFieldBaselinesRef.current[field] === undefined) {
      touchedFieldBaselinesRef.current[field] = currentEditSignaturesRef.current?.[field];
    }
    setTouchedFields((previous) => {
      if (previous.has(field)) return previous;
      const next = new Set(previous);
      next.add(field);
      return next;
    });
  }, []);

  const clearRequiredFieldValidation = useCallback((field: AutomationEditRequiredField) => {
    setValidationErrors((current) => clearAutomationEditRequiredFieldError(current, field));
  }, []);

  const handleRemoveSchedule = useCallback(() => {
    markFieldTouched("schedule");
    setScheduleRemoved(true);
    // 删除计划曾直接开启 destructive 校验态，把普通编辑误当成提交失败。
    clearRequiredFieldValidation("schedule");
    logger.debug("[AutomationEditView] 删除计划草稿", {
      automationId: editing?.automationId ?? null,
      validationVisible: false,
    });
  }, [clearRequiredFieldValidation, editing?.automationId, markFieldTouched]);

  useEffect(() => {
    onLoadRunsRef.current = onLoadRuns;
  }, [onLoadRuns]);

  // 切到 History tab(编辑态)时加载运行历史，并在停留期间轻量刷新。
  // cron run/outcome 由 scheduler/host 异步写入；只加载一次会让用户看到会话已结束但历史仍为空。
  // onLoadRuns 由父组件 inline 传入，不能作为依赖，否则每次 runsCache 更新都会重启 effect 形成请求循环。
  useEffect(() => {
    if (tab !== "history" || !editing) {
      return;
    }
    onLoadRunsRef.current?.();
    const timer = window.setInterval(() => {
      onLoadRunsRef.current?.();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [tab, editing?.automationId]);

  const isSessionCreatedAutomation = resolveIsSessionCreatedAutomation(editing);
  // 会话来源但无法由 UI 安全回显的旧 cron 保持只读；用户显式重设后以持久化标记退出该路径。
  const preserveSessionCreatedSchedule =
    isSessionCreatedAutomation &&
    !editing?.scheduleEditedByUser &&
    Boolean(editing && !canVisualizeCronInAutomationEditor(editing.cronExpr)) &&
    !touchedFields.has("schedule");
  const cronExpr = useMemo(
    () =>
      scheduleRemoved
        ? ""
        : preserveSessionCreatedSchedule
          ? (editing?.cronExpr ?? "")
          : buildCronExpr(builder),
    [builder, editing?.cronExpr, preserveSessionCreatedSchedule, scheduleRemoved],
  );
  const schedulePreview = useMemo(
    () => (cronExpr ? describeCronBuilder(builder, intl) : ""),
    [builder, cronExpr, intl],
  );
  const selectedWorkspace: AutomationWorkspaceOption | null =
    findAutomationWorkspaceOptionByKey(workspaceOptions, workspaceKey) ??
    (editing
      ? {
          workspacePath: editing.workspacePath,
          workspaceIdentity: editing.workspaceIdentity,
          projectId: editing.projectId,
          hostId: editing.hostId,
          label: editingWorkspaceOption?.label ?? workspaceLabelFromPath(editing.workspacePath),
        }
      : null);
  // 新建态无有效项目时保留空目标，避免模型配置读取悄悄回退到 conversation/default workspace。
  const selectedWorkspacePath = selectedWorkspace?.workspacePath ?? "";
  const selectedWorkspaceIdentity = selectedWorkspace?.workspaceIdentity;
  const {
    effectiveModelValue,
    effectiveReasoningLevel,
    effectiveSelection,
    handleModelValueChange,
    handleSelectProject,
    isSelectedConversationWorkspace,
    modeOption,
    modelSelectGroups,
    modelSelectionRead,
    modelSelectionView,
    modelTriggerLabel,
    selectedModelItem,
    selectedWorkspaceDisplayLabel,
    thoughtLevelOption,
  } = useAutomationEditModelSelection({
    defaultWorkspacePath,
    editing,
    intl,
    markFieldTouched,
    mode,
    model,
    modelManuallyChangedRef,
    modelSelectionRef: modelSelection,
    selectedWorkspace,
    selectedWorkspaceIdentity,
    selectedWorkspacePath,
    setModel,
    setThoughtLevel,
    setWorkspaceKey,
    thoughtLevel,
    thoughtLevelRef,
    thoughtManuallyChangedRef,
    workspaceOptions,
  });

  const requiredFieldErrors = useMemo(
    () =>
      resolveAutomationEditRequiredFieldErrors({
        title,
        cronExpr,
        prompt,
      }),
    [cronExpr, prompt, title],
  );
  const hasValidWorkspace = Boolean(editing || selectedWorkspace);
  const submissionContextReady =
    hasValidWorkspace &&
    (Boolean(editing) || selectedWorkspace !== null) &&
    modelSelectionRead.state.status === "ready" &&
    selectedModelItem !== null &&
    Boolean(effectiveReasoningLevel) &&
    !modelSelectionView?.selectionIssue;
  const canSubmit = submissionContextReady && requiredFieldErrors.length === 0;

  const requestRequiredFieldValidation = useCallback(
    (source: "save" | "run-now") => {
      setValidationErrors(new Set(requiredFieldErrors));
      logger.debug("[AutomationEditView] 提交前校验必填字段", {
        automationId: editing?.automationId ?? null,
        source,
        invalidFields: requiredFieldErrors,
      });
      return requiredFieldErrors.length === 0;
    },
    [editing?.automationId, requiredFieldErrors],
  );

  const currentScheduleRule = useMemo<ZCodeAutomationScheduleRule | undefined>(
    () =>
      builder.frequency === "custom"
        ? {
            unit: builder.customUnit,
            interval: builder.customInterval,
            hour: builder.hour,
            minute: builder.minute,
            anchorAt: editing?.scheduleRule?.anchorAt ?? Date.now(),
            weekdays: builder.customWeekdays,
            monthDays: builder.customMonthDays,
            // months 仅对 yearly 有意义；其它单位置空，JSON.stringify 会丢弃 undefined。
            months: builder.customUnit === "yearly" ? [builder.customMonth] : undefined,
            monthlyMode: builder.customMonthlyMode,
          }
        : undefined,
    [builder, editing?.scheduleRule?.anchorAt],
  );

  const buildSubmitInput = useCallback(
    ({ modeValue }: { modeValue: string }): CreateAutomationInput | UpdateAutomationInput => {
      if (!effectiveSelection || !effectiveReasoningLevel) {
        throw new Error("Automation model selection is required");
      }
      return {
        title: title.trim(),
        cronExpr,
        prompt: prompt.trim(),
        // 编辑会话内创建的有限次任务时，不能固定改成循环任务。
        recurring: editing?.recurring ?? true,
        ...(editing ? { endAt: endAt ?? null } : endAt ? { endAt } : {}),
        ...(editing
          ? preserveSessionCreatedSchedule
            ? {}
            : { scheduleRule: currentScheduleRule ?? null }
          : currentScheduleRule
            ? { scheduleRule: currentScheduleRule }
            : {}),
        ...(editing && touchedFields.has("schedule") ? { scheduleEditedByUser: true } : {}),
        mode: modeValue,
        modelSelection: effectiveSelection,
      };
    },
    [
      cronExpr,
      currentScheduleRule,
      editing,
      endAt,
      preserveSessionCreatedSchedule,
      prompt,
      effectiveSelection,
      effectiveReasoningLevel,
      title,
      touchedFields,
    ],
  );

  const currentEditSignatures = useMemo<AutomationEditFieldSignatures | null>(() => {
    if (!editing) return null;
    return {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule: JSON.stringify({
        cronExpr,
        endAt: endAt ?? null,
        scheduleRule: preserveSessionCreatedSchedule
          ? null
          : normalizeAutomationScheduleRule(currentScheduleRule ?? null),
      }),
      mode,
      thoughtLevel,
      model,
    };
  }, [
    cronExpr,
    currentScheduleRule,
    editing,
    endAt,
    preserveSessionCreatedSchedule,
    mode,
    model,
    prompt,
    thoughtLevel,
    title,
  ]);
  currentEditSignaturesRef.current = currentEditSignatures;

  const changedFields = useMemo(
    () =>
      currentEditSignatures
        ? resolveChangedAutomationEditFields({
            touchedFields,
            current: currentEditSignatures,
            baseline: touchedFieldBaselinesRef.current,
          })
        : [],
    [currentEditSignatures, touchedFields],
  );
  // 模型元数据和 cron builder 会在打开页面后异步归一化；只有用户实际操作过的
  // 字段才能触发未保存提示，否则仅打开已有任务再返回也会被误判为修改。
  const hasUnsavedChanges = Boolean(editing) && changedFields.length > 0;

  const recommendStartPlan = useStartPlanRecommendation(modelSelectionView);
  const submitAutomation = useCallback(
    async (options: { validationSource: "save" | "run-now"; returnToList?: boolean }) => {
      if (saving) return false;
      if (!requestRequiredFieldValidation(options.validationSource)) {
        return false;
      }
      if (!canSubmit) return false;
      // 防止刚改选择尚未取得对应 View 时，快速保存采用上一个输入的有效结果。
      if (modelSelection.current !== model || thoughtLevelRef.current !== thoughtLevel)
        return false;
      const input: CreateAutomationInput | UpdateAutomationInput = {
        ...(!editing && selectedWorkspace?.projectId
          ? { projectId: selectedWorkspace.projectId }
          : {}),
        // Bugfix: 权限下拉和保存按钮是两个独立控件，快速选择 Plan 后立即保存时，
        // React state 可能还没刷新到 submit 闭包；用 ref 保留最后一次选择，避免落库成默认 build。
        ...buildSubmitInput({
          modeValue: modeRef.current,
        }),
      };
      // 编辑态锁定原项目;新建态用选中的项目。
      const target = editing
        ? {
            workspacePath: editing.workspacePath,
            workspaceIdentity: editing.workspaceIdentity,
          }
        : selectedWorkspace
          ? {
              workspacePath: selectedWorkspace.workspacePath,
              workspaceIdentity: selectedWorkspace.workspaceIdentity,
            }
          : null;
      // 只禁用按钮无法覆盖快捷键或异步回调；提交边界也必须拒绝无有效项目的新建。
      if (!target) return false;
      if (input.modelSelection && (!editing || changedFields.includes("model"))) {
        const chosen = await recommendStartPlan(input.modelSelection);
        if (!chosen) return false;
        input.modelSelection = chosen;
      }
      const trace = startUserAction({
        featureId: "automation.lifecycle",
        action: editing ? "update" : "create",
        trigger: "button",
        workspaceKind: editing?.workspaceIdentity?.trim() ? "remote" : "local",
        automationKind: "scheduled",
      });
      try {
        const ok = await onSubmit({ input, ...target });
        if (ok) {
          trace.complete({ resultSource: "platform_result" });
          if (options?.returnToList !== false) onBack();
        } else {
          trace.reject({ resultSource: "platform_result" });
        }
        return ok;
      } catch (error) {
        trace.fail({ failureStage: "automation_save" });
        throw error;
      }
    },
    [
      buildSubmitInput,
      changedFields,
      recommendStartPlan,
      canSubmit,
      editing,
      onBack,
      onSubmit,
      requestRequiredFieldValidation,
      saving,
      model,
      thoughtLevel,
      selectedWorkspace?.workspaceIdentity,
      selectedWorkspace?.workspacePath,
      selectedWorkspace?.projectId,
    ],
  );

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitAutomation({ validationSource: "save" });
  };

  const handleSaveAndRun = useCallback(async () => {
    if (!editing || !onRunNow || saveAndRunPendingRef.current) return;
    saveAndRunPendingRef.current = true;
    setSaveAndRunPending(true);
    logger.debug("[AutomationEditView] 保存并立即运行开始", {
      automationId: editing.automationId,
      changedFields,
    });
    try {
      const completed = await saveAndRunAutomation(
        () =>
          submitAutomation({
            returnToList: false,
            validationSource: "run-now",
          }),
        () => onRunNow(editing),
      );
      logger.debug("[AutomationEditView] 保存并立即运行结束", {
        automationId: editing.automationId,
        completed,
      });
    } finally {
      saveAndRunPendingRef.current = false;
      setSaveAndRunPending(false);
    }
  }, [changedFields, editing, onRunNow, submitAutomation]);

  const handleBackClick = useCallback(async () => {
    logger.debug("[AutomationEditView] 返回前检查未保存更改", {
      automationId: editing?.automationId ?? null,
      touchedFields: [...touchedFields],
      changedFields,
    });
    if (!hasUnsavedChanges) {
      onBack();
      return;
    }

    // 定时任务曾单独维护“保存 / 放弃修改”弹窗，与闲时任务的确认弹窗
    // 尺寸和动作持续漂移；统一复用远程 Automation presentation，仅保留“取消 / 丢弃”语义。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "automations.unsaved.title" }),
      description: intl.formatMessage({
        id: "automations.unsaved.description",
      }),
      confirmLabel: intl.formatMessage({
        id: "automations.unsaved.discard",
      }),
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      presentation: "automation-confirmation",
    });
    logger.debug("[AutomationEditView] 未保存更改确认结果", {
      automationId: editing?.automationId ?? null,
      discarded: confirmed,
    });
    if (confirmed) onBack();
  }, [
    changedFields,
    confirmDialog,
    editing?.automationId,
    hasUnsavedChanges,
    intl,
    onBack,
    touchedFields,
  ]);

  const handleTabChange = useCallback(
    (nextTab: AutomationSettingsHistoryTab) => {
      // 新建定时任务曾直接禁用 History trigger，和闲时任务可查看空历史的交互不一致。
      logger.debug("[AutomationEditView] 切换设置页签", {
        automationId: editing?.automationId ?? null,
        nextTab,
        willLoadRuns: nextTab === "history" && Boolean(editing),
      });
      setTab(nextTab);
    },
    [editing],
  );

  const editStatus = editing ? resolveAutomationStatusKind(editing) : null;
  const showEditingSettingsActions = Boolean(editing && tab === "settings");
  const showCreateSettingsAction = !editing && tab === "settings";
  const modelValue = selectedModelItem?.value ?? "";

  const handleTitleValueChange = (value: string) => {
    titleTouchedRef.current = true;
    markFieldTouched("title");
    clearRequiredFieldValidation("title");
    setTitle(value);
  };

  const handlePromptValueChange = (value: string) => {
    markFieldTouched("prompt");
    clearRequiredFieldValidation("prompt");
    setPrompt(value);
  };

  const handleModeValueChange = (value: string) => {
    markFieldTouched("mode");
    modeRef.current = value;
    setMode(value);
  };

  const handleThoughtLevelValueChange = (value: string) => {
    if (!effectiveSelection) return;
    markFieldTouched("thoughtLevel");
    // 用户改档位时以正在显示的模型身份形成新意图；只读刷新不改表单。
    modelSelection.current = effectiveModelValue;
    setModel(effectiveModelValue);
    thoughtManuallyChangedRef.current = true;
    thoughtLevelRef.current = value;
    setThoughtLevel(value);
  };

  return {
    builder,
    canSubmit,
    clearRequiredFieldValidation,
    customRepeatOpen,
    editStatus,
    editing,
    endAt,
    handleBackClick,
    handleFormSubmit: handleSubmit,
    handleModeValueChange,
    handleModelValueChange,
    handlePromptValueChange,
    handleRemoveSchedule,
    handleSaveAndRun,
    handleSelectProject,
    handleTabChange,
    handleThoughtLevelValueChange,
    handleTitleValueChange,
    intl,
    isSelectedConversationWorkspace,
    markFieldTouched,
    modeOption,
    modelSelectGroups,
    modelSelectionRead,
    modelTriggerLabel,
    modelValue,
    onDelete,
    onDeleteRun,
    onManageModels,
    onOpenSession,
    onRunNow,
    onToggle,
    preserveSessionCreatedSchedule,
    prompt,
    runsEntry,
    runsPage,
    saveAndRunPending,
    saving,
    schedulePreview,
    scheduleRemoved,
    selectedWorkspaceDisplayLabel,
    setBuilder,
    setCustomRepeatOpen,
    setEndAt,
    setRunsPage,
    setScheduleRemoved,
    showCreateSettingsAction,
    showEditingSettingsActions,
    submissionContextReady,
    tab,
    thoughtLevelOption,
    thoughtTriggerRef,
    title,
    validationErrors,
    workspaceKey,
    workspaceOptions,
  };
}
