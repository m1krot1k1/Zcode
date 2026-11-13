import { useCallback, useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import { resolveConversationWorkspaceTarget } from "@/conversation-workspace-target/index.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import { logger } from "@/logger.js";
import type { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import type { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { TabStore } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  readComposerWorkspaceScope,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

type RestoreWorkspaceTabs = ReturnType<typeof useRemoteWorkspaceHistory>["restorePersistedSession"];
type ReconnectRemoteWorkspace = ReturnType<
  typeof useRemoteWorkspaceHistory
>["handleReconnectRemoteWorkspace"];
type WorkspaceActionSetters = Pick<
  ReturnType<typeof useRootWorkspaceActions>,
  "setWorkspaceActionError" | "handleResolveConversationWorkspace"
>;

/**
 * workspace shell 的会话恢复与远控回连接线。
 *
 * `restorePersistedSession` 在历史 tab 恢复之后补一次草稿归属：桌面刷新不经过
 * initialWorkspace 入口，草稿项目范围必须先于首屏门禁写回，避免按未归类范围预热。
 */
export function useRootWorkspaceShellWiring({
  platform,
  tabStoreApi,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  handleResolveConversationWorkspace,
  handleReconnectRemoteWorkspace,
  restoreWorkspaceTabs,
  setWorkspaceActionError,
}: {
  platform: IPlatformService;
  tabStoreApi: TabStore;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  handleResolveConversationWorkspace: WorkspaceActionSetters["handleResolveConversationWorkspace"];
  handleReconnectRemoteWorkspace: ReconnectRemoteWorkspace;
  restoreWorkspaceTabs: RestoreWorkspaceTabs;
  setWorkspaceActionError: WorkspaceActionSetters["setWorkspaceActionError"];
}) {
  const handleResolveConversationWorkspaceForShell = useCallback(
    async () =>
      // Bug 原因：此前只回传 workspacePath，Shell 再按路径反查 identity；多设备 conversation 路径
      // 相同时会归到错误 Source。改为在这里按 Source 归属一次性解析 path + identity。
      await resolveConversationWorkspaceTarget({
        getTabs: () => tabStoreApi.getState().tabs,
        activeWorkspacePath,
        activeWorkspaceIdentity,
        resolveLocalConversationWorkspacePath: handleResolveConversationWorkspace,
      }),
    [activeWorkspacePath, activeWorkspaceIdentity, handleResolveConversationWorkspace, tabStoreApi],
  );

  useEffect(() => {
    if (!platform.onWebRemoteControlReconnectWorkspace) {
      return;
    }

    return platform.onWebRemoteControlReconnectWorkspace(async (request) => {
      try {
        await handleReconnectRemoteWorkspace(request.workspaceKey, {
          activateWorkspaceAfterReconnect: false,
          showErrorToast: false,
          throwOnFailure: true,
        });
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: true,
        };
      } catch (error) {
        return {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }, [handleReconnectRemoteWorkspace, platform]);

  useEffect(() => {
    // Bugfix: fileDisplay 默认不传 basePath 时需要落到“当前激活 workspace”。
    // 之前纯工具层拿不到窗口内的 workspace 上下文，只能退回绝对路径，导致 mention / 文件展示在输入框里不够简洁。
    // 这里由 Root 在 workspace 切换时同步一份当前上下文，既保留工具层复用性，也不把 Zustand 依赖硬塞进工具函数。
    setDefaultFileDisplayBasePath(activeWorkspacePath);
  }, [activeWorkspacePath]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }

    setWorkspaceActionError(null);
  }, [activeWorkspacePath, setWorkspaceActionError]);

  const composerClientNamespace = useComposerClientNamespace();
  const restorePersistedSession = useCallback(
    async (...args: Parameters<RestoreWorkspaceTabs>) => {
      const restored = await restoreWorkspaceTabs(...args);
      const restoreDraftIntents = () => {
        // 桌面刷新通过历史 tab 恢复，不经过 initialWorkspace 入口。先恢复项目意图，
        // 再打开首屏门禁，避免 Composer 按未归类范围读取并预热同目录的项目草稿。
        for (const tab of tabStoreApi.getState().tabs) {
          if (!isWorkspaceTab(tab)) continue;
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(tab.workspacePath, tab.workspaceIdentity);
          if (workspace.activeTaskId || workspace.draftProjectId !== undefined) continue;
          const scope = readComposerWorkspaceScope(
            tab.workspacePath,
            tab.workspaceIdentity,
            composerClientNamespace,
          );
          if (!scope) continue;
          const draft = readV4ComposerDraft(
            tab.workspacePath,
            tab.workspaceIdentity,
            V4_DRAFT_SCOPE_ROOT,
            scope,
          );
          useZCodeSessionStore
            .getState()
            .startDraft(tab.workspacePath, undefined, tab.workspaceIdentity, {
              projectId: scope.projectId,
              taskGroupId: draft?.taskGroupId,
            });
          logger.info("[Root] 已恢复新建草稿归属", {
            workspacePath: tab.workspacePath,
            workspaceIdentity: tab.workspaceIdentity,
            projectId: scope.projectId,
          });
        }
      };
      restoreDraftIntents();
      return {
        ...restored,
        ...(restored.deferredRestore
          ? {
              deferredRestore: () => {
                restored.deferredRestore!();
                restoreDraftIntents();
              },
            }
          : {}),
      };
    },
    [restoreWorkspaceTabs, composerClientNamespace, tabStoreApi],
  );

  return { handleResolveConversationWorkspaceForShell, restorePersistedSession };
}
