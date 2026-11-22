import { useCallback } from "react";
import type { AppRootPanels } from "@/app-root/types.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { runWorkspaceVisibleCommand } from "@/lib/workspaceVisibleCommand.js";

/**
 * Общие действия shell: гарантия видимости workspace, read-only гейты для
 * создания задачи, терминала, Git и просмотра кода, авто-открытие PPTX.
 */
export function useAppRootShellActions({
  isWorkspaceVisible,
  onReturnToWorkspace,
  workspaceReadOnlyReason,
  onCreateTask,
  handleToggleTerminal,
  handleOpenTerminalTab,
  handleOpenGit,
  handleToggleGit,
  handleOpenCodeViewer,
  handleOpenCodeViewers,
  isDesktop,
  webRemoteControlWorkspaceSwitcher,
}: {
  isWorkspaceVisible: boolean;
  onReturnToWorkspace?: () => void;
  workspaceReadOnlyReason?: string;
  onCreateTask: (request?: CreateTaskRequest) => void;
  handleToggleTerminal: () => void;
  handleOpenTerminalTab: () => void;
  handleOpenGit: () => void;
  handleToggleGit: () => void;
  handleOpenCodeViewer: AppRootPanels["handleOpenCodeViewer"];
  handleOpenCodeViewers: AppRootPanels["handleOpenCodeViewers"];
  isDesktop?: boolean;
  webRemoteControlWorkspaceSwitcher?: unknown;
}) {
  const runVisibleWorkspaceCommand = useCallback(
    (run: () => void) => {
      runWorkspaceVisibleCommand({
        isWorkspaceVisible,
        onReturnToWorkspace,
        run,
      });
    },
    [isWorkspaceVisible, onReturnToWorkspace],
  );
  const handleCreateTaskIfWritable = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      if (!workspaceReadOnlyReason) {
        onCreateTask(request);
      }
    },
    [onCreateTask, workspaceReadOnlyReason],
  );
  const handleToggleTerminalIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleTerminal();
    }
  }, [handleToggleTerminal, workspaceReadOnlyReason]);
  const handleOpenTerminalTabIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenTerminalTab();
    }
  }, [handleOpenTerminalTab, workspaceReadOnlyReason]);
  const handleOpenGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenGit();
    }
  }, [handleOpenGit, workspaceReadOnlyReason]);
  const handleToggleGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleGit();
    }
  }, [handleToggleGit, workspaceReadOnlyReason]);
  const handleOpenCodeViewerIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenCodeViewer>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenCodeViewer(...args);
      }
    },
    [handleOpenCodeViewer, workspaceReadOnlyReason],
  );
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!isDesktop || webRemoteControlWorkspaceSwitcher || workspaceReadOnlyReason) {
        return;
      }
      handleOpenCodeViewers(request.sources);
    },
    [handleOpenCodeViewers, isDesktop, webRemoteControlWorkspaceSwitcher, workspaceReadOnlyReason],
  );

  return {
    runVisibleWorkspaceCommand,
    handleCreateTaskIfWritable,
    handleToggleTerminalIfWritable,
    handleOpenTerminalTabIfWritable,
    handleOpenGitIfWritable,
    handleToggleGitIfWritable,
    handleOpenCodeViewerIfWritable,
    handleAutoOpenAssistantPptx,
  };
}
