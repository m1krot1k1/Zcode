import type { ResolvedWorkspaceShellLayoutProps } from "@/app-shell/workspace-shell-layout/helpers.js";
import type { ConversationAutoCollapseState } from "@/app-shell/workspace-shell-layout/useConversationAutoCollapse.js";
import type {
  ShellCreateTaskInChat,
  WorkspaceConversationActionsState,
} from "@/app-shell/workspace-shell-layout/useWorkspaceConversationActions.js";
import type { WorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import type { WorkspaceShellDerivedState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellDerivedState.js";
import type { WorkspaceShellPaneState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellPaneState.js";
import type { WorkspaceSidebarResizeState } from "@/app-shell/workspace-shell-layout/useWorkspaceSidebarResize.js";
import type { WebRemoteControlNavigationState } from "@/app-shell/workspace-shell-layout/useWebRemoteControlNavigation.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { WorkflowRunOpenTarget } from "@/v4/workflowRunOpenContext.js";

/** 侧栏/中枢共用的「在对话里选中会话」入口签名。 */
export type ShellSelectTaskInChat = (
  targetWorkspacePath: string,
  taskId: string,
  targetWorkspaceIdentity?: string,
  targetRemoteSessionId?: string,
  expectedUnreadAt?: number,
) => void;

/**
 * 壳层内联在 WorkspaceShellLayout 里的跨项目导航动作（source-contract 测试锁定其形状）。
 * 它们与 controller 的返回值一起组成渲染上下文，渲染模块只读不写。
 */
export type WorkspaceShellInlineActions = {
  createTaskInChat: ShellCreateTaskInChat;
  selectTaskInChat: ShellSelectTaskInChat;
  handleCreateAutomationInChat: (
    prompt: string,
    targetWorkspace?: { workspacePath: string; workspaceIdentity?: string },
  ) => void;
  handleNavigateToLaunchedRun: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  handleOpenSavedWorkflowArtifact: (params: SavedWorkflowsOpenArtifactParams) => void;
  handleOpenSavedWorkflowInHub: (target: SavedWorkflowHubTarget) => void;
  handleOpenSavedWorkflowRun: (params: SavedWorkflowsOpenRunParams) => void;
  handleOpenSidebarWorkflowRun: (target: WorkflowRunOpenTarget) => void;
  handlePaneActiveSessionChange: (
    scope: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
    sessionId: string,
  ) => void;
  hasUpdateStatusButton: boolean;
  workspaceDraftResetKeys: string[];
  workspaceOnlyResetKeys: string[];
  workspaceSidebarVisibilityResetKeys: (string | boolean)[];
};

export type WorkspaceShellModel = WorkspaceShellBaseState &
  WorkspaceShellPaneState &
  ConversationAutoCollapseState &
  WorkspaceSidebarResizeState &
  WebRemoteControlNavigationState &
  WorkspaceShellDerivedState &
  WorkspaceConversationActionsState &
  WorkspaceShellInlineActions;

/** 渲染构建器只读上下文：原始 props（缺省值已固化）+ 壳层模型。 */
export type WorkspaceShellContext = {
  props: ResolvedWorkspaceShellLayoutProps;
  model: WorkspaceShellModel;
};
