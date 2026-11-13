import { useCallback, useEffect, useMemo } from "react";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { ResolvedWorkspaceShellLayoutProps } from "@/app-shell/workspace-shell-layout/helpers.js";
import type { WorkspaceShellBaseState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellBaseState.js";
import type { WorkspaceShellDerivedState } from "@/app-shell/workspace-shell-layout/useWorkspaceShellDerivedState.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { areWorkspaceFilePathsEqual } from "@/workspace-file-tree/model.js";
import { ProjectComposerMenu } from "@/project-sidebar/index.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { WorkspacePluginPreview } from "@/workspace-plugin-preview/index.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";

/** 「在对话里创建任务」：壳层只负责切回 chat 视图，真正的只读守卫由调用方/root 动作决定。 */
export type ShellCreateTaskInChat = (
  request?: Parameters<ResolvedWorkspaceShellLayoutProps["onCreateTask"]>[0],
) => void;

/**
 * conversation 侧的壳层动作：草稿落地、workspace 切换、v4 pane 生命周期、
 * markdown 文件链接解析、Git 文件定位与辅助对话入口。所有回调仍以 Shell 为唯一 owner。
 */
export function useWorkspaceConversationActions(
  props: ResolvedWorkspaceShellLayoutProps,
  base: WorkspaceShellBaseState,
  derived: WorkspaceShellDerivedState,
  handleCreateTaskInChat: ShellCreateTaskInChat,
) {
  const {
    activeTaskId,
    allowRemoteWorkspace,
    gitState,
    handleCloseSidePaneTab,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleOpenPluginStore,
    handleRefreshGit,
    handleSelectTask,
    handleStartDraftInWorkspace,
    onCancelRemoteProject,
    onConnectRemote,
    onOpenRemoteWorkspace,
    onResolveConversationWorkspace,
    projectName,
    services,
    sidePaneState,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceReadOnlyReason,
    workspaceRemoteSessionId,
    workspaceTabs,
  } = props;
  const { baseServices, intl, isOfficeMode, isWebRemoteControlShell, workspaceKey } = base;
  const { findFileLinkOwnerWorkspace, gitDirtyFileCount, openFileTreeRequest, showChatMainView } =
    derived;
  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      showChatMainView();
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        targetWorkspacePurpose,
        createSource,
      );
    },
    [handleStartDraftInWorkspace, showChatMainView],
  );
  const activeWorkspacePurpose =
    workspaceTabs.find(
      (tab) =>
        tab.workspacePath === workspaceAbsPath &&
        (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
    )?.workspacePurpose ?? "project";
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    let target: Awaited<ReturnType<typeof onResolveConversationWorkspace>>;
    try {
      target = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
        error,
      });
      return;
    }
    // Bug 原因：这里曾用 targetWorkspacePath 在 workspaceTabs 里反查 conversation tab 的 identity。
    // 多设备的 conversation backing path 同为各自 home 下的固定目录，home 相同时会命中别的设备。
    // 现在 identity 由 Root 按 Source 归属解析后一并回传，Shell 直接消费，不再按路径判等。
    const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspaceKey) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath: target.workspacePath,
        targetWorkspaceIdentity: target.workspaceIdentity,
      });
    }
    handleStartDraftInWorkspaceInChat(
      target.workspacePath,
      target.workspaceIdentity,
      "conversation",
    );
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleSelectComposerPlugin = useCallback(
    (mention: ComposerMentionPrefill) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspaceAbsPath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceAbsPath, workspaceIdentity],
  );
  // v4 pane 生命周期回调（稳定引用，供 memo 友好的 pane 宿主消费）：
  // createSession/fork 后接入既有选择路径；删除会话后回 draft。
  const handleV4SessionCreated = useCallback(
    (sessionId: string) => {
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, workspaceAbsPath, workspaceIdentity],
  );
  // 草稿头部保留项目菜单与 Git 分支；项目目录由共享 Provider 提供。
  // Shell 只连接既有导航回调，pane 不持有另一份项目列表或 cwd 归属推断。
  const draftComposerHeader = useMemo(
    () => (
      <ProjectComposerMenu
        showEditProject
        workspacePath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        compactForRemoteControl={isWebRemoteControlShell}
        onCreateTask={handleCreateTaskInChat}
        onSelectConversationWorkspace={handleSelectConversationWorkspace}
        allowRemoteWorkspace={allowRemoteWorkspace}
        onOpenRemoteWorkspace={onOpenRemoteWorkspace}
        onConnectRemote={onConnectRemote}
        onCancelRemote={onCancelRemoteProject}
      >
        {isOfficeMode && !isWebRemoteControlShell ? (
          <WorkspacePluginPreview
            onOpen={handleOpenPluginStore}
            onSelectPlugin={handleSelectComposerPlugin}
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            remoteSessionId={workspaceRemoteSessionId ?? undefined}
          />
        ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
          <GitBranchSwitcher
            workspacePath={workspaceAbsPath}
            gitSummary={gitState.summary}
            dirtyFileCount={gitDirtyFileCount}
            onRefreshGit={handleRefreshGit}
            compactForRemoteControl={isWebRemoteControlShell}
            className="px-0 pt-0"
            popoverClassName="w-72"
            branchListClassName="max-h-48"
            // Bugfix（旧注释保真）：输入框区域在底部，Radix 碰撞避让会把分支菜单翻到下方。
            // 这里锁定上方弹出，避免菜单遮挡输入区并保持操作方向稳定。
            avoidPopoverCollisions={false}
          />
        ) : null}
      </ProjectComposerMenu>
    ),
    [
      isOfficeMode,
      workspaceRemoteSessionId,
      handleOpenPluginStore,
      handleSelectComposerPlugin,
      allowRemoteWorkspace,
      activeWorkspacePurpose,
      gitDirtyFileCount,
      gitState.summary,
      handleRefreshGit,
      handleSelectConversationWorkspace,
      handleCreateTaskInChat,
      isWebRemoteControlShell,
      onOpenRemoteWorkspace,
      onConnectRemote,
      onCancelRemoteProject,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleOpenMarkdownFileLink = useCallback(
    async (target: WorkspacePathOpenRequest) => {
      if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
        return;
      }
      try {
        const fileService = selectWorkspacePathFileService(
          target,
          services.fileService,
          baseServices.fileService,
        );
        const fileStat = await fileService.stat({
          path: target.path,
        });
        if (fileStat.type === "file") {
          if (
            shouldOpenAssistantHtmlInBrowser({
              path: target.path,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
              compactForRemoteControl: isWebRemoteControlShell,
            })
          ) {
            handleOpenBrowserUrl(toFileUrl(target.path));
            return;
          }
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
          return;
        }

        if (target.serviceScope === "base-local") {
          openFileTreeRequest({
            target: {
              workspacePath: target.path,
              workspaceName: target.label || getPathLeaf(target.path),
              revealPath: target.path,
              temporaryExternalDirectory: true,
            },
          });
          return;
        }

        const ownerWorkspace = findFileLinkOwnerWorkspace(
          target.path,
          target.workspaceIdentity,
          target.workspaceRemoteSessionId,
        );
        if (ownerWorkspace) {
          openFileTreeRequest({
            target: {
              workspacePath: ownerWorkspace.workspacePath,
              workspaceName: ownerWorkspace.label,
              workspaceIdentity: ownerWorkspace.workspaceIdentity,
              workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
              revealPath: areWorkspaceFilePathsEqual(ownerWorkspace.workspacePath, target.path)
                ? undefined
                : target.path,
            },
          });
          return;
        }

        openFileTreeRequest({
          target: {
            workspacePath: target.path,
            workspaceName: target.label || getPathLeaf(target.path),
            revealPath: target.path,
            temporaryExternalDirectory: true,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceShell] 打开 markdown 文件链接失败", {
          path: target.path,
          error: message,
        });
        if (shouldFallbackWorkspacePathToCodeViewer(target)) {
          // Bugfix: markdown file link 可能指向已不存在的路径。
          // stat 失败时保持旧行为交给 CodeViewer 展示具体读文件错误，避免点击完全无反馈。
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
        }
        toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
      }
    },
    [
      findFileLinkOwnerWorkspace,
      baseServices.fileService,
      handleOpenBrowserUrl,
      handleOpenCodeViewer,
      intl,
      isWebRemoteControlShell,
      openFileTreeRequest,
      services.fileService,
      workspaceReadOnlyReason,
    ],
  );
  useEffect(
    () =>
      addWorkspacePathOpenRequestListener((target) => {
        void handleOpenMarkdownFileLink(target);
      }),
    [handleOpenMarkdownFileLink],
  );
  const handleRevealGitFileInTree = useCallback(
    (path: string) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      openFileTreeRequest({
        target: {
          workspacePath: workspaceAbsPath,
          workspaceName: projectName,
          workspaceIdentity,
          workspaceRemoteSessionId,
          revealPath: path,
        },
      });
    },
    [
      openFileTreeRequest,
      projectName,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      workspaceReadOnlyReason,
    ],
  );
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // 固定入口由当前主 SessionPane 承接命令；若 pane 尚未挂载，不允许壳层自行拼接远程身份或协议。
      logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  return {
    handleStartDraftInWorkspaceInChat,
    handleSelectConversationWorkspace,
    handleSelectComposerPlugin,
    handleV4SessionCreated,
    draftComposerHeader,
    handleV4SessionDeleted,
    handleOpenMarkdownFileLink,
    handleRevealGitFileInTree,
    activeSelectionSideChatSessionId,
    handleOpenSelectionSideConversationLauncher,
  };
}

export type WorkspaceConversationActionsState = ReturnType<typeof useWorkspaceConversationActions>;
