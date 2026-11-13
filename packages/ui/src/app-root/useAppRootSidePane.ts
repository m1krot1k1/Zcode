import { useCallback, useEffect, useMemo, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";
import {
  CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
  getCloseActiveContextSidePaneTab,
} from "@/lib/closeActiveContext.js";
import { logger } from "@/logger.js";
import { useSidePaneFullView } from "@/side-pane-full-view/index.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

/**
 * Side pane App-уровня: контроллер панелей, derived-флаги открытых вкладок,
 * закрытие активного контекста по Cmd/Ctrl+W, сворачивание панели при новом
 * черновике и полный вид панели (только desktop).
 */
export function useAppRootSidePane({
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  sidePaneOwnerId,
  draftFocusVersion,
  isDesktop,
  isWorkspaceVisible,
  supportsEmbeddedBrowser,
  webRemoteControlWorkspaceSwitcher,
  platform,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
  draftFocusVersion: number;
  isDesktop?: boolean;
  isWorkspaceVisible: boolean;
  supportsEmbeddedBrowser: boolean;
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  platform: IPlatformService;
}) {
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const panels = useAppPanels({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    isWorkspaceVisible,
    supportsEmbeddedBrowser,
    platform,
    defaultWhiteboardNamePrefix: intl.formatMessage({
      id: "whiteboard.defaultName",
    }),
  });
  const {
    sidePaneState,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    handleCloseSidePaneTab,
    handleToggleSidePaneCollapse,
  } = panels;
  const lastHandledDraftSidePaneCloseRef = useRef({
    workspaceKey,
    draftFocusVersion,
  });

  // 新建任务只会把 activeTaskId 切到 draft，不会触发 side pane 的 workspace 级内存切换。
  // 因此用 startDraft 递增的版本号统一收起右侧面板，覆盖按钮、菜单、快捷键和远控入口。
  useEffect(() => {
    // 用 ref 记录上一次处理的 workspace/draft 版本，避免同一版本重复收起。
    const previous = lastHandledDraftSidePaneCloseRef.current;
    if (previous.workspaceKey !== workspaceKey) {
      lastHandledDraftSidePaneCloseRef.current = {
        workspaceKey,
        draftFocusVersion,
      };
      return;
    }

    if (previous.draftFocusVersion === draftFocusVersion) {
      return;
    }

    lastHandledDraftSidePaneCloseRef.current = {
      workspaceKey,
      draftFocusVersion,
    };
    if (draftFocusVersion === 0) {
      return;
    }

    const sidePaneTabCount = sidePaneState?.tabs.length ?? 0;
    if (!isSidePaneCollapsed) {
      logger.info(
        `[App] 新建任务时收起右侧面板 workspace=${workspaceAbsPath} tabs=${sidePaneTabCount}`,
      );
    }
    // scope effect 可能在同一轮更新展开态，不能用本次渲染的旧值跳过新草稿收起。
    setIsSidePaneCollapsed(true);
  }, [
    draftFocusVersion,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    sidePaneState,
    workspaceAbsPath,
    workspaceKey,
  ]);

  const activeSidePaneTab = useMemo(() => getActiveSidePaneTab(sidePaneState), [sidePaneState]);
  const isBrowserOpen = activeSidePaneTab?.type === "browser";
  const isGitOpen = activeSidePaneTab?.type === "git";
  const hasGitTab = sidePaneState?.tabs.some((tab) => tab.type === "git") ?? false;
  const isSidePaneOpen = !isSidePaneCollapsed;

  useEffect(() => {
    const handleCloseActiveContextRequest = (event: Event) => {
      const activeTab = getCloseActiveContextSidePaneTab({
        isWorkspaceVisible,
        isSidePaneCollapsed,
        sidePaneState,
      });
      if (!activeTab) {
        return;
      }

      // 桌面菜单的 Cmd/Ctrl+W 会先到 main 进程。
      // 这里在可见 workspace 层拦下请求，确保右侧 side pane 打开时关闭的是 active tab，
      // 而不是让 Root fallback 继续关闭整个窗口。
      event.preventDefault();
      handleCloseSidePaneTab(activeTab.id);
    };

    window.addEventListener(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, handleCloseActiveContextRequest);
    return () => {
      window.removeEventListener(
        CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
        handleCloseActiveContextRequest,
      );
    };
  }, [handleCloseSidePaneTab, isSidePaneCollapsed, isWorkspaceVisible, sidePaneState]);

  const handleToggleSidePane = useCallback(() => {
    // 交互说明：toggle panel 只改变右侧容器显隐，不隐式创建或切换任何 tab。
    // 之前无 tab 时会按 diff/browser 兜底自动开内容，导致用户只是想打开 side pane
    // 却得到一个新 Browser 或 Review。现在空内容统一交给 Open tab 空态承接。
    handleToggleSidePaneCollapse();
  }, [handleToggleSidePaneCollapse]);
  // Side Pane 完整视图只在桌面端提供（docs/ui/side-pane-full-view.md）。
  const supportsSidePaneFullView = Boolean(isDesktop) && !webRemoteControlWorkspaceSwitcher;
  const sidePaneFullView = useSidePaneFullView({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    ownerId: sidePaneOwnerId,
    isSidePaneOpen,
    enabled: supportsSidePaneFullView,
  });
  const handleToggleSidePaneFullView = useCallback(() => {
    // 面板关闭时快捷键先打开面板再进入完整视图；记录先写入，面板展开后即生效。
    if (!sidePaneFullView.fullView && !isSidePaneOpen) {
      handleToggleSidePaneCollapse();
      sidePaneFullView.enter();
      return;
    }
    sidePaneFullView.toggle();
  }, [handleToggleSidePaneCollapse, isSidePaneOpen, sidePaneFullView]);

  return {
    panels,
    isBrowserOpen,
    isGitOpen,
    hasGitTab,
    isSidePaneOpen,
    supportsSidePaneFullView,
    sidePaneFullView,
    handleToggleSidePane,
    handleToggleSidePaneFullView,
  };
}
