import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { TID_APP_HEADER } from "@zcode/shared/test-ids";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import type {
  WorkspaceShellContext,
  WorkspaceShellModel,
} from "@/app-shell/workspace-shell-layout/context.js";
import { resolveWorkspaceShellLayoutProps } from "@/app-shell/workspace-shell-layout/helpers.js";
import { useConversationAutoCollapse } from "@/app-shell/workspace-shell-layout/useConversationAutoCollapse.js";
import { useWebRemoteControlNavigation } from "@/app-shell/workspace-shell-layout/useWebRemoteControlNavigation.js";
import { useWorkspaceConversationActions } from "@/app-shell/workspace-shell-layout/useWorkspaceConversationActions.js";
import { useWorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import { useWorkspaceShellDerivedState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellDerivedState.js";
import { useWorkspaceShellPaneState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellPaneState.js";
import { useWorkspaceSidebarResize } from "@/app-shell/workspace-shell-layout/useWorkspaceSidebarResize.js";
import { buildDesktopWideContent } from "@/app-shell/workspace-shell-layout/WorkspaceDesktopFrame.js";
import { buildRemoteShell } from "@/app-shell/workspace-shell-layout/WorkspaceRemoteShell.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { WorkflowRunOpenTarget } from "@/v4/workflowRunOpenContext.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  selectWorkbenchSession,
  type WorkbenchSessionTarget,
} from "@/v4/workbenchSessionPlacement.js";

/**
 * Workspace shell 的组装点：只保留 props 解构、controller 调用顺序与内联的跨项目导航动作。
 *
 * 布局实现按层拆在 ./workspace-shell-layout：
 * - helpers.ts：常量、纯函数与缺省值收口；
 * - useWorkspaceShell* / useConversationAutoCollapse / useWebRemoteControlNavigation /
 *   useWorkspaceSidebarResize / useWorkspaceConversationActions：状态所有者与回调；
 * - Workspace*Slot / Workspace*Column / WorkspaceMainViewBodies / WorkspaceDesktopFrame /
 *   WorkspaceRemoteShell：只读渲染构建器。
 * handleCreateTaskInChat / handleCreateAutomationInChat / handleOpenSavedWorkflowRun 的内联
 * 形状由 source-contract 测试（useRootWorkspaceActionsTargetWorkspace.test.ts）锁定。
 */
export const WorkspaceShellLayout = memo(function WorkspaceShellLayout(
  props: WorkspaceShellLayoutProps,
) {
  return (
    <ProjectDirectoryProvider isDesktop={props.isDesktop}>
      <WorkspaceShellLayoutContent {...props} />
    </ProjectDirectoryProvider>
  );
});

const WorkspaceShellLayoutContent = memo(function WorkspaceShellLayoutComponent(
  rawProps: WorkspaceShellLayoutProps,
) {
  const props = resolveWorkspaceShellLayoutProps(rawProps);
  const {
    activeTaskId,
    handleOpenWorkflowArtifact,
    handleOpenWorkflowRun,
    handleSelectTask,
    isDesktop,
    isMacDesktop,
    isSidebarVisible,
    isWindowsDesktop,
    onCreateTask,
    onOpenSavedWorkflowInHub,
    updateReadyVersion,
    updateState,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceReadOnlyReason,
    workspaceRemoteSessionId,
    workspaceTabs,
  } = props;

  const base = useWorkspaceShellBaseState(props);
  const panes = useWorkspaceShellPaneState(props, base);
  const autoCollapse = useConversationAutoCollapse(props, base, panes);

  const sidebarResize = useWorkspaceSidebarResize(base, panes);

  const webRemote = useWebRemoteControlNavigation(base);
  const derived = useWorkspaceShellDerivedState(props, base, panes, sidebarResize);
  // 别名保持 source-contract 测试锁定的调用形状（showChatMainView()），值仍是同一份 memo 回调。
  const showChatMainView = derived.showChatMainView;
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason 判定的是活动 workspace；当 request 显式带 targetWorkspace 时
      // 目标另属他项目（跨项目发起已保存工作流，docs/dynamic-workflow/launch.md「The detail page」），
      // 活动 workspace 的只读性不适用，真正的守卫是 root 动作对 target 的 isWorkspaceReadOnly。
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      showChatMainView();
      onCreateTask(request);
    },
    [onCreateTask, showChatMainView, workspaceReadOnlyReason],
  );
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  // 切入草稿曾改变侧栏选任务回调，让全部项目重渲染；点击时使用最近已提交的绑定，保留分屏导航语义。
  const shellWorkbenchBindingRef = useRef(shellWorkbenchBinding);
  useLayoutEffect(() => {
    shellWorkbenchBindingRef.current = shellWorkbenchBinding;
  }, [shellWorkbenchBinding]);
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // 带 target 时跳过活动 workspace 只读检查，交由 handleCreateTaskInChat / root 动作在
      // target 上校验（docs/dynamic-workflow/launch.md「The detail page」）；无 target 时形状不变。
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // 工作流「运行」现由中枢直接启动（docs/dynamic-workflow/launch.md）：GUI 建空会话 +
  // 发 startSavedWorkflow 命令，不再合成对话文案。本层只在 accepted 后把会话切到前台。
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      if (!base.isWebRemoteControlShell) {
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: base.tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            base.tabStoreApi.getState().addTab(workspacePath);
          },
        });
        if (!workspaceResult.accepted) {
          logger.warn("[automations] 运行历史目标远程 workspace 未连接，保留当前页面", {
            sessionId: taskId,
            workspaceIdentity: targetWorkspaceIdentity,
            workspacePath: targetWorkspacePath,
          });
          toast(base.intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          workspaceTabs.find(
            (tab) =>
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
              (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
          )?.remoteSessionId;
        const target: WorkbenchSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        selectWorkbenchSession(shellWorkbenchBindingRef.current, target);
      }
      // 只有目标 workspace 已经激活或补开成功后才关闭 Automations，避免失败时看起来像跳转成功。
      showChatMainView();
      if (typeof expectedUnreadAt === "number") {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity, expectedUnreadAt);
      } else {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      }
    },
    [
      handleSelectTask,
      base.intl,
      base.isWebRemoteControlShell,
      showChatMainView,
      base.tabStoreApi,
      workspaceTabs,
    ],
  );
  // 中枢直接启动 accepted 后切到新会话（run 卡已在顶部）：复用运行历史那条导航，
  // target 恒带工作流所属项目坐标（不变式 7），remoteSessionId 决定连接 endpoint。
  // 「已保存」芯片的落点：交给 App 切主视图并设深链（与「自动化」入口同一条导航历史）。
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      onOpenSavedWorkflowInHub(target);
    },
    [onOpenSavedWorkflowInHub],
  );
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // 工作流运行历史「查看实例」：先回到发起它的会话（侧栏页只在 chat 视图里可见），再开实例详情页。
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // 中枢是跨项目视图：实例必须开在发起它的项目，而非活动项目（不变式 8）。
      // params 恒带 workspacePath/identity；仅在异常缺省时兜底回退到活动 workspace。
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId 不在契约里：按目标 workspace 从已打开 tab 反查；命中活动项目即取活动值。
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowRun({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        toolCallId: params.toolCallId,
        runId: params.runId,
        workflowName: params.workflowName,
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // 侧栏运行行（docs/dynamic-workflow/presentation.md「The sidebar run line」）：与 composer 徽标
  // 同一跳转——先选中会话，再开 run pane。没有 toolCallId 的 run（不该有）只选中会话。
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // 中枢的产物 chip：与「查看实例」逐字同构（同一条「先回到发起它的会话」的路径），
  // 只是终点是 `workflow-artifact` tab 而不是 run 详情页。
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowArtifact({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.title === undefined ? {} : { title: params.title }),
        // 中枢的 chip 载荷带得到 contentType（html 产物据它直接开浏览器 tab）；`sourcePath`
        // 那份载荷没有，由 `handleOpenWorkflowArtifact` 自己查 journal 补。
        ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
    ) => {
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );

  const conversation = useWorkspaceConversationActions(
    props,
    base,
    derived,
    handleCreateTaskInChat,
  );
  const hasUpdateStatusButton =
    updateReadyVersion !== null ||
    updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded";
  // 修复原因：ErrorBoundary resetKeys 的数组如果每次 render 都重新创建，
  // 即使 workspace/task 没变化也会在 React DevTools Components 轨道里持续表现为子树 props 变化。
  const workspaceOnlyResetKeys = useMemo(() => [base.workspaceKey], [base.workspaceKey]);
  const workspaceDraftResetKeys = useMemo(
    () => [base.workspaceKey, activeTaskId ?? "draft"],
    [base.workspaceKey, activeTaskId],
  );
  const workspaceSidebarVisibilityResetKeys = useMemo(
    () => [base.workspaceKey, isSidebarVisible],
    [base.workspaceKey, isSidebarVisible],
  );
  // 渲染上下文：controller 的返回值 + 本文件内联的跨项目导航动作，构建器只读。
  const model: WorkspaceShellModel = {
    ...base,
    ...panes,
    ...autoCollapse,
    ...sidebarResize,
    ...webRemote,
    ...derived,
    ...conversation,
    createTaskInChat: handleCreateTaskInChat,
    selectTaskInChat: handleSelectTaskInChat,
    handleCreateAutomationInChat,
    handleNavigateToLaunchedRun,
    handleOpenSavedWorkflowArtifact,
    handleOpenSavedWorkflowInHub,
    handleOpenSavedWorkflowRun,
    handleOpenSidebarWorkflowRun,
    handlePaneActiveSessionChange,
    hasUpdateStatusButton,
    workspaceDraftResetKeys,
    workspaceOnlyResetKeys,
    workspaceSidebarVisibilityResetKeys,
  };
  const ctx: WorkspaceShellContext = { props, model };
  const wideContent = buildDesktopWideContent(ctx);
  return (
    <DesktopWindowFrame
      title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
      showHeader
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
      headerTestId={TID_APP_HEADER}
    >
      {base.isWebRemoteControlShell ? buildRemoteShell(ctx, wideContent) : wideContent}
    </DesktopWindowFrame>
  );
});
