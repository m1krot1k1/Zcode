import { useMemo } from "react";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { setPendingSettingsPluginIntent } from "@/lib/settingsNavigation.js";
import { createQuickPickCommands } from "@/quickpick/quickPickCommands.js";

/**
 * Список команд command center: собирается из shell/side pane/настроек действий.
 * Набор команд и условия доступности сохранены из App.
 */
export function useAppRootQuickPickCommands({
  allowOpenWorkspace,
  isSidebarVisible,
  supportsEmbeddedBrowser,
  isLoggedIn,
  canOpenCommunity,
  themeTarget,
  newTaskShortcutLabel,
  openWorkspaceShortcutLabel,
  toggleSidebarShortcutLabel,
  toggleTerminalShortcutLabel,
  runVisibleWorkspaceCommand,
  handleCreateTaskIfWritable,
  onOpenWorkspace,
  openSettingsTab,
  handleSwitchTheme,
  handleOpenFeedback,
  handleOpenCommunity,
  handleOpenProductDocs,
  onLogin,
  onLogout,
  handleToggleSidebar,
  handleToggleTerminalIfWritable,
  handleToggleBrowser,
  handleOpenTerminalTabIfWritable,
  handleOpenBrowserTab,
  handleOpenGitIfWritable,
}: {
  allowOpenWorkspace: boolean;
  isSidebarVisible: boolean;
  supportsEmbeddedBrowser: boolean;
  isLoggedIn: boolean;
  canOpenCommunity: boolean;
  themeTarget: "dark" | "light";
  newTaskShortcutLabel: string;
  openWorkspaceShortcutLabel: string;
  toggleSidebarShortcutLabel: string;
  toggleTerminalShortcutLabel: string;
  runVisibleWorkspaceCommand: (run: () => void) => void;
  handleCreateTaskIfWritable: () => void;
  onOpenWorkspace: () => void;
  openSettingsTab: () => void;
  handleSwitchTheme: () => void;
  handleOpenFeedback: () => void;
  handleOpenCommunity: () => void;
  handleOpenProductDocs: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  handleToggleSidebar: () => void;
  handleToggleTerminalIfWritable: () => void;
  handleToggleBrowser: () => void;
  handleOpenTerminalTabIfWritable: () => void;
  handleOpenBrowserTab: () => void;
  handleOpenGitIfWritable: () => void;
}) {
  const isOfficeMode = useIsOfficeMode();
  const commands = useMemo(
    () =>
      createQuickPickCommands({
        supportsTerminal: !isOfficeMode,
        supportsReview: !isOfficeMode,
        allowOpenWorkspace,
        canOpenCommunity,
        isSidebarVisible,
        supportsEmbeddedBrowser,
        // quick pick 命令只关心登录态布尔值。
        // 如果依赖完整 user 对象，auth store 返回等价新引用时会重建整组 command/run 闭包。
        isLoggedIn,
        themeTarget,
        shortcuts: {
          newTask: newTaskShortcutLabel,
          openWorkspace: openWorkspaceShortcutLabel,
          toggleSidebar: toggleSidebarShortcutLabel,
          toggleTerminal: toggleTerminalShortcutLabel,
        },
        handlers: {
          createTask: () => runVisibleWorkspaceCommand(() => handleCreateTaskIfWritable()),
          openWorkspace: () => runVisibleWorkspaceCommand(onOpenWorkspace),
          openSettings: openSettingsTab,
          openSkillsSettings: () => {
            setPendingSettingsPluginIntent("skills");
            openSettingsTab();
          },
          openMcpSettings: () => {
            setPendingSettingsPluginIntent("mcps");
            openSettingsTab();
          },
          switchTheme: handleSwitchTheme,
          openFeedback: handleOpenFeedback,
          openCommunity: handleOpenCommunity,
          openProductDocs: handleOpenProductDocs,
          login: onLogin,
          logout: onLogout,
          toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
          toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
          togglePreview: () => runVisibleWorkspaceCommand(handleToggleBrowser),
          openTerminalTab: () => runVisibleWorkspaceCommand(handleOpenTerminalTabIfWritable),
          openBrowserTab: () => runVisibleWorkspaceCommand(handleOpenBrowserTab),
          openReviewTab: () => runVisibleWorkspaceCommand(handleOpenGitIfWritable),
        },
      }),
    [
      allowOpenWorkspace,
      canOpenCommunity,
      handleCreateTaskIfWritable,
      handleOpenBrowserTab,
      handleOpenCommunity,
      handleOpenFeedback,
      handleOpenGitIfWritable,
      handleOpenProductDocs,
      handleOpenTerminalTabIfWritable,
      handleSwitchTheme,
      handleToggleBrowser,
      handleToggleSidebar,
      handleToggleTerminalIfWritable,
      isLoggedIn,
      isOfficeMode,
      isSidebarVisible,
      newTaskShortcutLabel,
      onLogin,
      onLogout,
      onOpenWorkspace,
      openSettingsTab,
      openWorkspaceShortcutLabel,
      runVisibleWorkspaceCommand,
      supportsEmbeddedBrowser,
      themeTarget,
      toggleSidebarShortcutLabel,
      toggleTerminalShortcutLabel,
    ],
  );

  return commands;
}
