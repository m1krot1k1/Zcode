/**
 * Automations 主视图的公共类型：外部 props、内部路由与标签页。
 *
 * 视图解析、hooks 与子视图都从这里取类型，避免各文件重复声明。
 */
import type { ZCodeAutomation, ZCodeOffPeakTask } from "@zcode/shared";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
  SavedWorkflowsOpenTarget,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { OffPeakCreateDraft } from "@/store/offPeakTaskStore.js";
import type { useAutomationActionHandlers } from "@/settings/automations-section/useAutomationActionHandlers.js";
import type { useAutomationOffPeakActionHandlers } from "@/settings/automations-section/useAutomationOffPeakActionHandlers.js";

export interface AutomationsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 「Create via chat」:切到会话让 agent 用 CronCreate 创建;缺省则回退到手动创建整页。
   * target = 工作流所属项目；定时任务的「通过对话创建」不带 target，落到活动项目。 */
  onCreateViaChat?: (prompt: string, target?: SavedWorkflowProjectTarget) => void;
  /** 会话内创建卡片的详情导航目标；定位成功后由调用方清空。 */
  openAutomationId?: string | null;
  /** 推荐提示词携带的一次性 tab 导航目标；仅在目标 tab 可见时应用。"workflow" 落到顶级「工作流」标签。 */
  openAutomationTab?: AutomationsNavigationTab | null;
  onOpenAutomationConsumed?: () => void;
  /** 工作流「运行」= GUI 直接启动：accepted 后切到新会话。 */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /** 工作流运行历史「查看实例」：切到发起它的会话并打开实例详情页。 */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** 产物 chip → `workflow-artifact` tab。 */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** 深链直接落到详情页；透传给 SavedWorkflowsSection，定位后由调用方清空。global 只需 name。 */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
  /** 打开某次运行关联的会话；管理页列出所有项目，必须携带 automation 所属 workspace。 */
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}

/** 创建表单的预填草稿(来自「More ideas」模板)。 */
export interface AutomationDraft {
  templateId?: string;
  title: string;
  cronExpr: string;
  prompt: string;
}

/** 主视图内部路由:列表 / 新建 / 编辑。 */
export type AutomationsView =
  | { mode: "list" }
  | { mode: "create"; draft: AutomationDraft | null }
  | { mode: "edit"; automation: ZCodeAutomation }
  | { mode: "offpeak-create"; draft?: OffPeakCreateDraft }
  | { mode: "offpeak-edit"; task: ZCodeOffPeakTask };

/** 主视图标签页：Scheduled 常驻，Idle 受灰度控制（D31）；不设 All 混排视图。 */
export type AutomationsTab = "scheduled" | "idle";

export const SCHEDULED_ONLY_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled"];
export const SCHEDULED_AND_IDLE_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled", "idle"];

/** 主视图动作集合：通用动作 + 闲时任务动作 + 仍留在入口文件的破坏性删除。 */
export type AutomationsSectionActions = ReturnType<typeof useAutomationActionHandlers> &
  ReturnType<typeof useAutomationOffPeakActionHandlers> & {
    handleOffPeakDelete: (task: ZCodeOffPeakTask) => Promise<void>;
  };
