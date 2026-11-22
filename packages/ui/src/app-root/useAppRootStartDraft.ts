import { useCallback } from "react";
import type { SessionCreateSource, WorkspacePurpose } from "@zcode/shared";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  isWorkspaceReadOnly,
  isWorkspaceTab,
  type TabStoreState,
  type WorkspaceTabOptions,
} from "@/store/tabStore.js";
import { resolveWorkspaceSwitchDraftProvider } from "@/lib/workspaceDraftProvider.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { WorkspaceShellZCodeState } from "@/app-shell/types.js";

/**
 * Переключение workspace и старт черновика: сначала гарантируем открытую вкладку,
 * затем сбрасываем workbench layout (кроме мобильного remote-переключателя) и
 * стартуем draft в выбранном workspace.
 */
export function useAppRootStartDraft({
  tabs,
  addTab,
  activateTabByPath,
  selectedProvider,
  webRemoteControlWorkspaceSwitcher,
}: {
  tabs: TabStoreState["tabs"];
  addTab: (workspacePath: string, options?: WorkspaceTabOptions) => unknown;
  activateTabByPath: TabStoreState["activateTabByPath"];
  selectedProvider: WorkspaceShellZCodeState["selectedProvider"];
  webRemoteControlWorkspaceSwitcher?: unknown;
}) {
  return useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: WorkspacePurpose,
      createSource?: SessionCreateSource,
    ) => {
      const store = useZCodeSessionStore.getState();
      const resolvedTargetWorkspaceIdentity =
        targetWorkspaceIdentity ??
        tabs.filter(isWorkspaceTab).find((tab) => tab.workspacePath === targetWorkspacePath)
          ?.workspaceIdentity;
      if (isWorkspaceReadOnly({ tabs }, targetWorkspacePath, resolvedTargetWorkspaceIdentity)) {
        return;
      }
      const targetSelectedProvider = resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: selectedProvider,
        targetWorkspacePath,
        targetWorkspaceIdentity: resolvedTargetWorkspaceIdentity,
        workspaces: store.workspaces,
      });

      // 空态里的 workspace 选择器要表达"在这个项目里开始工作"，
      // 目标 workspace 如果已经记住了自己的 Agent，切过去后应当继续沿用那份选择；
      // 只有首次进入、还没建立 workspace UI 状态时，才继承当前空态里正在看的 Agent。
      // 否则来回切项目时会把目标项目刚用过的 Agent 覆盖掉，看起来就像“总是重置成默认值”。
      // 另外 Home 这类固定入口并不保证已经存在于 tab 列表里，之前直接 activateTabByPath 会静默失败，
      // 看起来就像"点了没反应"。这里先确保目标 workspace 已打开，再把当前空态的 provider 一并传给 startDraft，
      // 保证首次进入的新 workspace 也能继续沿用当前上下文。
      const targetTabOptions =
        resolvedTargetWorkspaceIdentity || targetWorkspacePurpose
          ? {
              ...(resolvedTargetWorkspaceIdentity
                ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
                : {}),
              ...(targetWorkspacePurpose ? { workspacePurpose: targetWorkspacePurpose } : {}),
            }
          : undefined;
      if (targetWorkspacePurpose) {
        // purpose 是分类元数据；即使 tab 已存在也要合并，避免首次从项目解绑时被默认成 project。
        addTab(targetWorkspacePath, targetTabOptions);
      } else if (
        !activateTabByPath(
          targetWorkspacePath,
          resolvedTargetWorkspaceIdentity
            ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
            : undefined,
        )
      ) {
        addTab(targetWorkspacePath, targetTabOptions);
      }
      if (!webRemoteControlWorkspaceSwitcher) {
        // 修复原因：workspace 行“新建对话”以前由叶子组件直接 activateTab + startDraft，
        // 没有退出重启恢复的 workbench group/pane。group primary binding 因而仍可覆盖草稿。
        // desktop 所有显式新建入口统一先回到单 primary pane；手机 /remote 不消费这份本地布局。
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      store.startDraft(
        targetWorkspacePath,
        targetSelectedProvider,
        resolvedTargetWorkspaceIdentity,
        { createSource: createSource ?? "project" },
      );
    },
    [activateTabByPath, addTab, selectedProvider, tabs, webRemoteControlWorkspaceSwitcher],
  );
}
