import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";

/**
 * Глобальные горячие клавиши App. Все действия проходят через те же
 * обработчики shell/side pane, что и кнопки, чтобы поведение не расходилось.
 */
export function useAppRootKeyboard({
  handleOpenQuickPick,
  openSettingsTab,
  handleOpenTaskFind,
  handleSwitchTheme,
  runVisibleWorkspaceCommand,
  handleToggleSidebar,
  handleToggleTerminalIfWritable,
  handleToggleSidePane,
  supportsSidePaneFullView,
  handleToggleSidePaneFullView,
  handleSelectPreviousConversation,
  handleSelectNextConversation,
  canPrimaryNavigationBack,
  handlePrimaryNavigationBack,
  canTaskNavForward,
  handleTaskNavForward,
}: {
  handleOpenQuickPick: () => void;
  openSettingsTab: () => void;
  handleOpenTaskFind: () => void;
  handleSwitchTheme: () => void;
  runVisibleWorkspaceCommand: (run: () => void) => void;
  handleToggleSidebar: () => void;
  handleToggleTerminalIfWritable: () => void;
  handleToggleSidePane: () => void;
  supportsSidePaneFullView: boolean;
  handleToggleSidePaneFullView: () => void;
  handleSelectPreviousConversation: () => void;
  handleSelectNextConversation: () => void;
  canPrimaryNavigationBack: boolean;
  handlePrimaryNavigationBack: () => void;
  canTaskNavForward: boolean;
  handleTaskNavForward: () => void;
}) {
  useAppKeyboard({
    openCommandCenter: handleOpenQuickPick,
    // 打开设置页：与设置入口按钮共用 tabStore.openSettingsTab；默认 ⌘,/Ctrl+,（系统惯例）
    openSettings: openSettingsTab,
    findInTask: handleOpenTaskFind,
    toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
    switchTheme: handleSwitchTheme,
    toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
    // ⌥⌘B 与 header 最右侧按钮共用同一条 toggle 入口，
    // 避免快捷键和按钮行为漂移；空面板的展示统一由 Open tab 空态承接。
    toggleSidePane: () => runVisibleWorkspaceCommand(handleToggleSidePane),
    toggleSidePaneFullView: supportsSidePaneFullView
      ? () => runVisibleWorkspaceCommand(handleToggleSidePaneFullView)
      : null,
    previousConversation: handleSelectPreviousConversation,
    nextConversation: handleSelectNextConversation,
    navigateBack: canPrimaryNavigationBack
      ? () => runVisibleWorkspaceCommand(handlePrimaryNavigationBack)
      : null,
    navigateForward: canTaskNavForward
      ? () => runVisibleWorkspaceCommand(handleTaskNavForward)
      : null,
  });
}
