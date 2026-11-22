import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";
import type { AppRootTaskFindNavigationState } from "@/app-root/types.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

/**
 * Диалоги App: command center (quick pick) и поиск по задаче/изменениям файлов,
 * включая подсветку результата поиска и capability community-команды.
 */
export function useAppRootDialogs({
  runVisibleWorkspaceCommand,
  handleOpenGitIfWritable,
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
}: {
  runVisibleWorkspaceCommand: (run: () => void) => void;
  handleOpenGitIfWritable: () => void;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop: boolean;
}) {
  const { locale } = useZCodeIntl();
  const platform = usePlatform();
  const [isQuickPickOpen, setIsQuickPickOpen] = useState(false);
  const [isTaskFindOpen, setIsTaskFindOpen] = useState(false);
  const [taskFindFocusRequestId, setTaskFindFocusRequestId] = useState(0);
  const [conversationFindState, setConversationFindState] =
    useState<AppRootTaskFindNavigationState>(createTaskFindNavigationState);
  const [conversationFindMatchCount, setConversationFindMatchCount] = useState(0);
  const searchResultHighlightRequestIdRef = useRef(0);
  const [searchResultHighlightRequest, setSearchResultHighlightRequest] =
    useState<ChatSearchResultHighlightRequest | null>(null);
  const [fileChangeFindState, setFileChangeFindState] =
    useState<AppRootTaskFindNavigationState>(createTaskFindNavigationState);
  const [fileChangeFindMatchCount, setFileChangeFindMatchCount] = useState(0);
  const [canOpenCommunityFromQuickPick, setCanOpenCommunityFromQuickPick] = useState(false);

  useEffect(() => {
    let disposed = false;

    void platform.canOpenCommunity(locale).then(
      (visible) => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(visible);
        }
      },
      () => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(false);
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [locale, platform]);

  const handleOpenTaskFind = useCallback(() => {
    // Cmd/Ctrl+F 语义是“查找对话”，之前误复用了 Cmd/Ctrl+P 的文件搜索入口，
    // 导致用户在 quick pick 里点 Find 或按快捷键时会跳到打开文件。这里拆成独立状态，避免影响文件搜索链路。
    runVisibleWorkspaceCommand(() => {
      setTaskFindFocusRequestId((requestId) => requestId + 1);
      setIsTaskFindOpen(true);
    });
  }, [runVisibleWorkspaceCommand]);
  const handleTaskFindOpenChange = useCallback((open: boolean) => {
    setIsTaskFindOpen(open);
    if (!open) {
      setConversationFindState((state) => changeTaskFindSelection(state, "", -1));
      setConversationFindMatchCount(0);
      setFileChangeFindState((state) => changeTaskFindSelection(state, "", -1));
      setFileChangeFindMatchCount(0);
    }
  }, []);
  const handleConversationFindChange = useCallback((query: string, activeIndex: number) => {
    setConversationFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindNavigate = useCallback((query: string, activeIndex: number) => {
    // 单命中时上/下/Enter 都会回到同一 index；独立版本确保重复导航仍触发滚动。
    setConversationFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindMatchStateChange = useCallback(
    (state: ConversationFindMatchState) => {
      setConversationFindMatchCount(state.matchCount);
      if (state.activeIndex !== undefined) {
        setConversationFindState((current) =>
          changeTaskFindSelection(current, current.query, state.activeIndex ?? -1),
        );
      }
    },
    [],
  );
  const handleSearchResultHighlightRequest = useCallback(
    (request: Omit<ChatSearchResultHighlightRequest, "requestId">) => {
      searchResultHighlightRequestIdRef.current += 1;
      setSearchResultHighlightRequest({
        ...request,
        requestId: searchResultHighlightRequestIdRef.current,
      });
    },
    [],
  );
  const handleSearchResultHighlightDone = useCallback((requestId: number) => {
    setSearchResultHighlightRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);
  const handleFileChangeFindChange = useCallback((query: string, activeIndex: number) => {
    setFileChangeFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleFileChangeFindNavigate = useCallback((query: string, activeIndex: number) => {
    // 文件变更范围也可能只有一个命中；重复导航必须重新展开并聚焦同一处。
    setFileChangeFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleOpenQuickPick = useCallback(() => {
    setIsQuickPickOpen((open) => !open);
  }, []);
  const taskFindDialogProps = useMemo<TaskFindDialogProps>(
    () => ({
      open: isTaskFindOpen,
      focusRequestId: taskFindFocusRequestId,
      isMacDesktop,
      isWindowsDesktop,
      isLinuxDesktop,
      conversationMatchCount: conversationFindMatchCount,
      conversationMatchIndex: conversationFindState.activeIndex,
      fileChangeMatchCount: fileChangeFindMatchCount,
      fileChangeMatchIndex: fileChangeFindState.activeIndex,
      onOpenChange: handleTaskFindOpenChange,
      onConversationFindChange: handleConversationFindChange,
      onConversationFindNavigate: handleConversationFindNavigate,
      onFileChangeFindChange: handleFileChangeFindChange,
      onFileChangeFindNavigate: handleFileChangeFindNavigate,
      onOpenFileChanges: handleOpenGitIfWritable,
    }),
    [
      conversationFindMatchCount,
      conversationFindState.activeIndex,
      fileChangeFindMatchCount,
      fileChangeFindState.activeIndex,
      handleConversationFindChange,
      handleConversationFindNavigate,
      handleFileChangeFindChange,
      handleFileChangeFindNavigate,
      handleOpenGitIfWritable,
      handleTaskFindOpenChange,
      isLinuxDesktop,
      isMacDesktop,
      isTaskFindOpen,
      isWindowsDesktop,
      taskFindFocusRequestId,
    ],
  );

  return {
    isQuickPickOpen,
    setIsQuickPickOpen,
    handleOpenQuickPick,
    canOpenCommunityFromQuickPick,
    handleOpenTaskFind,
    conversationFindState,
    fileChangeFindState,
    setFileChangeFindMatchCount,
    handleConversationFindMatchStateChange,
    handleSearchResultHighlightRequest,
    searchResultHighlightRequest,
    handleSearchResultHighlightDone,
    taskFindDialogProps,
  };
}
