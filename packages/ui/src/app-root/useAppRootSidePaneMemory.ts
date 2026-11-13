import { useState } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import { useTaskSidePaneMemoryBridge } from "@/app-shell/useTaskSidePaneMemoryBridge.js";

/**
 * Мост памяти side pane App: выбранный Git-источник и восстановленные
 * browser URL привязаны к task/workspace и переживают переключение задач.
 */
export function useAppRootSidePaneMemory({
  activeTaskId,
  workspaceAbsPath,
  workspaceIdentity,
}: {
  activeTaskId: string | null;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
}) {
  const [gitSelectedSourceId, setGitSelectedSourceId] = useState<GitChangeSourceId>("unstaged");
  const { browserRestoreUrls, handleBrowserUrlChange } = useTaskSidePaneMemoryBridge({
    activeTaskId,
    gitSelectedSourceId,
    setGitSelectedSourceId,
    workspaceAbsPath,
    workspaceIdentity,
  });

  return {
    gitSelectedSourceId,
    setGitSelectedSourceId,
    browserRestoreUrls,
    handleBrowserUrlChange,
  };
}
