import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { completeNewModelSelection } from "@zcode/provider";
import { ZCODE_AGENT_PROVIDER, type ZCodeAutomation } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import {
  buildAutomationModelSelectGroups,
  buildAutomationModeOption,
  buildAutomationThoughtLevelOption,
  resolveAutomationModelItem,
  resolveAutomationModelTriggerLabel,
  resolveAutomationPreferredModelValue,
} from "@/settings/automationAgentConfigOptions.js";
import type { AutomationEditDirtyField } from "@/settings/automationEditDirtyState.js";
import { workspaceLabelFromPath } from "@/settings/automation-edit-view/automationEditFormModel.js";
import {
  findAutomationWorkspaceOptionByKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";

interface UseAutomationEditModelSelectionParams {
  defaultWorkspacePath: string;
  editing: ZCodeAutomation | null;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  markFieldTouched: (field: AutomationEditDirtyField) => void;
  mode: string;
  model: string;
  modelManuallyChangedRef: MutableRefObject<boolean>;
  modelSelectionRef: MutableRefObject<string>;
  selectedWorkspace: AutomationWorkspaceOption | null;
  selectedWorkspaceIdentity: string | undefined;
  selectedWorkspacePath: string;
  setModel: Dispatch<SetStateAction<string>>;
  setThoughtLevel: Dispatch<SetStateAction<string>>;
  setWorkspaceKey: Dispatch<SetStateAction<string | null>>;
  thoughtLevel: string;
  thoughtLevelRef: MutableRefObject<string>;
  thoughtManuallyChangedRef: MutableRefObject<boolean>;
  workspaceOptions: AutomationWorkspaceOption[];
}

/**
 * 定时任务表单的模型/权限/思考档位派生状态与副作用。
 * 单独成 hook 只为控制文件体积：调用点仍保持原有的 hook 顺序与依赖数组。
 */
export function useAutomationEditModelSelection({
  defaultWorkspacePath,
  editing,
  intl,
  markFieldTouched,
  mode,
  model,
  modelManuallyChangedRef,
  modelSelectionRef,
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
}: UseAutomationEditModelSelectionParams) {
  const originalSelection = useMemo(() => {
    if (!model) return null;
    const identity = parseModelPickerValue(model);
    return identity
      ? { ...identity, ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}) }
      : null;
  }, [model, thoughtLevel]);
  // 模型候选属于当前表单目标 Host。项目切换时立即切换订阅；远程目标未连接时
  // 等待远端时保持 unavailable；本地空项目直接读取同 Host 模型目录，不创建假 cwd。
  const selectionOwner = useWorkspaceServicesResolution(
    selectedWorkspacePath || null,
    selectedWorkspace?.remoteSessionId,
    selectedWorkspaceIdentity,
    selectedWorkspace?.remoteTarget,
  );
  const modelSelectionRead = useModelSelectionServiceView(
    selectionOwner.services.modelSelectionService,
    Boolean(selectedWorkspace) && selectionOwner.connectionKind !== "remote-waiting",
    selectedWorkspace ? "remote-waiting" : "missing-target",
    { selection: originalSelection },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const effectiveSelection = modelSelectionView?.effectiveSelection;
  const effectiveModelValue = effectiveSelection
    ? encodeCustomModelValue(effectiveSelection.providerId, effectiveSelection.modelId)
    : "";
  const effectiveReasoningLevel = effectiveSelection?.options?.reasoningLevel ?? "";
  const modelSelectGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildAutomationModelSelectGroups({
      selectedProvider: ZCODE_AGENT_PROVIDER,
      labels: {
        apiKeyLabel: intl.formatMessage({ id: "settings.modelProvider.apiKey" }),
        apiKeyBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.apiKeyBadge",
        }),
        codingPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlan",
        }),
        codingPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.codingPlanBadge",
        }),
        startPlanLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlan",
        }),
        startPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.startPlanBadge",
        }),
        teamPlanBadgeLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlanBadge",
        }),
        teamPlanFallbackLabel: intl.formatMessage({
          id: "settings.modelProvider.connectionMode.teamPlan",
        }),
      },
      registrySelectionView: modelSelectionView,
    });
  }, [intl, modelSelectionView]);
  const isSelectedConversationWorkspace =
    selectedWorkspace?.projectId === null || selectedWorkspace?.workspacePurpose === "conversation";
  // Bug 原因：automation 数据只持久化 workspaceKey/path，编辑态曾直接把 conversation
  // backing path 当项目展示成 default。匹配当前 canonical 候选恢复 purpose 后，
  // 继续复用会话侧文案；无法匹配的历史目标仍回退到路径名称。
  const selectedWorkspaceDisplayLabel = isSelectedConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.workOutsideProject" })
    : (selectedWorkspace?.label ?? workspaceLabelFromPath(defaultWorkspacePath));
  const handleSelectProject = (key: string) => {
    if (!findAutomationWorkspaceOptionByKey(workspaceOptions, key)) return;
    modelManuallyChangedRef.current = false;
    thoughtManuallyChangedRef.current = false;
    modelSelectionRef.current = "";
    setModel("");
    setWorkspaceKey(key);
  };
  const modelTriggerLabel = resolveAutomationModelTriggerLabel({
    modelGroups: modelSelectGroups,
    modelSelectionView,
    modelValue: effectiveModelValue,
    fallbackLabel: intl.formatMessage({ id: "chat.toolbar.model.label" }),
  });
  // 主动选模型才初始化最高档；历史恢复和 View 刷新仍保留缺失档位。
  const handleModelValueChange = useCallback(
    (value: string) => {
      modelManuallyChangedRef.current = true;
      thoughtManuallyChangedRef.current = false;
      modelSelectionRef.current = value;
      setModel(value);
      const selection =
        value && modelSelectionView
          ? completeNewModelSelection(modelSelectionView, parseModelPickerValue(value))
          : undefined;
      const level = selection?.options?.reasoningLevel ?? "";
      thoughtLevelRef.current = level;
      setThoughtLevel(level);
      markFieldTouched("model");
    },
    [markFieldTouched, modelSelectionView],
  );
  // 定时任务编辑页只维护表单草稿，不能为了读取选项调用 workspace 默认配置接口；
  // 否则用户仅打开后取消，也会改掉当前项目或 draft session 的模型、模式和思考强度。
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  const selectedModelItem = useMemo(
    () => resolveAutomationModelItem(modelSelectGroups, effectiveModelValue),
    [effectiveModelValue, modelSelectGroups],
  );
  const preferredModelValue = useMemo(
    () => (modelSelectionView ? resolveAutomationPreferredModelValue(modelSelectionView) : null),
    [modelSelectionView],
  );
  const persistedSelectionInvalid = Boolean(
    originalSelection && modelSelectionView && modelSelectionView.selectionIssue,
  );
  const invalidSelectionNoticeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistedSelectionInvalid || !editing || !modelSelectionView) return;
    const noticeKey = `${editing.automationId}:${modelSelectionView.revision}`;
    if (invalidSelectionNoticeKeyRef.current === noticeKey) return;
    invalidSelectionNoticeKeyRef.current = noticeKey;
    toast(intl.formatMessage({ id: "modelSelection.invalidated.reselect" }), {
      variant: "warning",
      position: "bottom-center",
      dedupeKey: `automation-model-selection-invalidated:${editing.automationId}`,
    });
  }, [editing, intl, modelSelectionView, persistedSelectionInvalid]);
  useEffect(() => {
    if (
      editing ||
      !preferredModelValue ||
      modelManuallyChangedRef.current ||
      persistedSelectionInvalid
    )
      return;
    if (model) return;
    // 旧表单把“默认模型”保存为空值，却又要求提交前必须存在具体候选，
    // 导致初次创建按钮永远禁用。目标 Host ready 后直接选中并固化 preferredSelection。
    modelSelectionRef.current = preferredModelValue;
    setModel(preferredModelValue);
    thoughtManuallyChangedRef.current = false;
    const preferredReasoning =
      modelSelectionView?.preferredSelection?.options?.reasoningLevel ?? "";
    thoughtLevelRef.current = preferredReasoning;
    setThoughtLevel(preferredReasoning);
  }, [editing, model, modelSelectionView, persistedSelectionInvalid, preferredModelValue]);
  const selectedModelMetadataThoughtOption = useMemo(() => {
    if (!selectedModelItem) return null;
    const decodedModel = decodeCustomModelValue(selectedModelItem.value);
    if (!decodedModel?.modelName) return null;
    // 与会话 composer 复用同一模型静态事实，避免 workspace runtime catalog 暂未投影
    // thought_level 时，定时任务把支持推理的模型误显示成无思考档位。
    return modelSelectionView
      ? resolveModelThoughtOption({
          modelSelectionView,
          providerId: decodedModel.providerId,
          modelId: decodedModel.modelName,
        })
      : null;
  }, [modelSelectionView, selectedModelItem]);
  // 所选模型的 Option Specs 只来自目标 Host View；不能为预览再创建 deferred Session。
  const activeThoughtOption = selectedModelMetadataThoughtOption ?? undefined;
  const thoughtLevelOption = useMemo(
    () => buildAutomationThoughtLevelOption(activeThoughtOption, effectiveReasoningLevel),
    [activeThoughtOption, effectiveReasoningLevel],
  );

  return {
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
  };
}
