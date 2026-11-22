import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { isRemoteConversationWorkspace } from "@/conversation-workspace-target/purpose.js";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import type { WorkspaceFileEntry, ZCodeTaskChangeSummary, ZCodeTaskMeta } from "@zcode/shared";
import { Command, CommandDialog, CommandEmpty, CommandList } from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { QUICK_PICK_SECTION_ORDER, type QuickPickCommand } from "@/quickpick/quickPickCommands.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickListClassName,
} from "@/quickpick/quickPickStyles.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import {
  clearCommandCenterSearchHistory,
  pushCommandCenterSearchHistory,
  readCommandCenterSearchHistory,
  type CommandCenterSearchHistoryEntry,
  type CommandCenterSearchScope,
} from "@/command-center/commandCenterSearchHistory.js";
import {
  buildTaskResultRows,
  COMMAND_CENTER_CONTEXT_SECTION_LIMIT,
  COMMAND_CENTER_TASK_RESULT_LIMIT,
  compareRecentChangedFiles,
  EMPTY_QUICK_PICK_COMMANDS,
  filterWorkspaceFileEntries,
  matchesCommand,
  resolveQueryScope,
  scopeToPrefix,
  type CommandCenterSectionId,
  type TaskChangedFileSummary,
  type TaskSearchResultRow,
} from "./dialog/commandCenterSearch.js";
import { CommandCenterScopeTabs } from "./dialog/CommandCenterScopeTabs.js";
import { CommandCenterSearchHistory } from "./dialog/CommandCenterSearchHistorySection.js";
import {
  CommandCenterRecentChangesSection,
  CommandCenterRecentTasksSection,
} from "./dialog/CommandCenterContextSections.js";
import {
  CommandCenterCommandSections,
  CommandCenterConversationSection,
  CommandCenterFileSection,
} from "./dialog/CommandCenterSearchSections.js";

// 公开 API 保持在原模块路径上，调用方与单测无需改动。
export { CommandCenterScopeButton } from "./dialog/CommandCenterScopeTabs.js";
export { CommandCenterSearchHistory } from "./dialog/CommandCenterSearchHistorySection.js";

const EMPTY_COMMAND_CENTER_WORKSPACE_TABS: WorkspaceTabState[] = [];
const commandCenterDialogClassName = cn(
  quickPickDialogClassName,
  // Linux 桌面端的通用 DialogContent 会给居中弹窗补偿自绘标题栏高度。
  // Command Center 是顶部搜索浮层，必须在 Linux variant 下重新声明 top，
  // 否则平台补偿会覆盖 top-16/sm:top-20，导致弹层掉到窗口中部。
  "top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)]",
  "platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20",
);
const commandCenterListClassName = cn(
  quickPickListClassName,
  "max-h-[min(440px,calc(100dvh-15rem))]",
);

export const CommandCenterDialog = memo(function CommandCenterDialogComponent({
  open,
  commands,
  workspaceAbsPath,
  workspaceIdentity,
  activeTaskId,
  activeTaskChangeSummary,
  workspaceTabs,
  onOpenChange,
  onSelectTask,
  onSearchResultHighlightRequest,
  onOpenCodeViewer,
}: {
  open: boolean;
  commands: QuickPickCommand[];
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId?: string | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  workspaceTabs: WorkspaceTabState[];
  onOpenChange: (open: boolean) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onSearchResultHighlightRequest?: (
    request: Omit<ChatSearchResultHighlightRequest, "requestId">,
  ) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  const { fileService } = useServices();
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const [rawQuery, setRawQuery] = useState("");
  const [manualScope, setManualScope] = useState<CommandCenterSearchScope>("all");
  const [expandedSections, setExpandedSections] = useState<Set<CommandCenterSectionId>>(
    () => new Set(),
  );
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommandCenterSearchHistoryEntry[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // 性能修复：Command Center 关闭时不需要跟随 chat streaming 重算命令、任务和 recent changes。
  // 保留 hooks 顺序，但把关闭态输入降为空，避免隐藏弹窗在每个 token 批次重建结果区。
  const effectiveCommands = open ? commands : EMPTY_QUICK_PICK_COMMANDS;
  const effectiveWorkspaceTabs = useMemo(
    () =>
      open
        ? workspaceTabs.filter((tab) => !isRemoteConversationWorkspace(tab))
        : EMPTY_COMMAND_CENTER_WORKSPACE_TABS,
    [open, workspaceTabs],
  );
  const effectiveActiveTaskChangeSummary = open ? activeTaskChangeSummary : null;
  const resolvedQuery = useMemo(() => resolveQueryScope(rawQuery), [rawQuery]);
  const activeScope = resolvedQuery.explicitScope ? resolvedQuery.scope : manualScope;
  const searchQuery = resolvedQuery.query;
  const hasSearchQuery = searchQuery.trim().length > 0;
  const searchConversations =
    open && hasSearchQuery && (activeScope === "all" || activeScope === "conversations");
  const searchFiles = open && hasSearchQuery && (activeScope === "all" || activeScope === "files");
  const searchWorkspaceTabs = useMemo(
    () => (searchConversations ? effectiveWorkspaceTabs : []),
    [effectiveWorkspaceTabs, searchConversations],
  );
  const currentWorkspaceTabs = useMemo(
    () =>
      effectiveWorkspaceTabs.filter(
        (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
      ),
    [effectiveWorkspaceTabs, workspaceKey],
  );
  const recentTaskWorkspaceTabs = useMemo(
    () => (open && !hasSearchQuery ? currentWorkspaceTabs : []),
    [currentWorkspaceTabs, hasSearchQuery, open],
  );
  const taskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery,
    expanded: false,
    collapsedLimit: COMMAND_CENTER_TASK_RESULT_LIMIT,
  });
  const recentTaskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: recentTaskWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: false,
    collapsedLimit:
      activeScope === "conversations"
        ? COMMAND_CENTER_TASK_RESULT_LIMIT + (activeTaskId ? 1 : 0)
        : COMMAND_CENTER_CONTEXT_SECTION_LIMIT + (activeTaskId ? 1 : 0),
  });
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        effectiveWorkspaceTabs.map((tab) => [
          tab.workspaceIdentity?.trim() || tab.workspacePath,
          tab.label,
        ]),
      ),
    [effectiveWorkspaceTabs],
  );
  const commandOptions = useMemo(
    () =>
      effectiveCommands
        .map((command) => ({
          command,
          title: intl.formatMessage({ id: command.titleId }),
        }))
        .filter(({ command, title }) => matchesCommand(command, title, searchQuery)),
    [effectiveCommands, intl, searchQuery],
  );
  const commandOptionsBySection = useMemo(
    () =>
      QUICK_PICK_SECTION_ORDER.map((sectionId) => ({
        sectionId,
        commands: commandOptions.filter(({ command }) => command.sectionId === sectionId),
      })).filter((section) => section.commands.length > 0),
    [commandOptions],
  );
  const conversationRows = useMemo(
    () => buildTaskResultRows({ tasks: taskList.items, query: searchQuery }),
    [searchQuery, taskList.items],
  );
  const fileRows = useMemo(
    () => filterWorkspaceFileEntries(workspaceFiles, searchQuery),
    [searchQuery, workspaceFiles],
  );
  const recentChangeRows = useMemo(
    () => [...(effectiveActiveTaskChangeSummary?.files ?? [])].sort(compareRecentChangedFiles),
    [effectiveActiveTaskChangeSummary],
  );
  const recentChangePreviewRows = useMemo(
    () => recentChangeRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentChangeRows],
  );
  const recentTaskRows = useMemo(
    () => recentTaskList.items.filter((task) => task.taskId !== activeTaskId),
    [activeTaskId, recentTaskList.items],
  );
  const recentTaskPreviewRows = useMemo(
    () => recentTaskRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentTaskRows],
  );
  useEffect(() => {
    if (open) {
      setHistoryEntries(readCommandCenterSearchHistory(workspaceKey));
      return;
    }

    setRawQuery("");
    setManualScope("all");
    setExpandedSections(new Set());
    setHistoryExpanded(false);
  }, [open, workspaceKey]);

  useEffect(() => {
    setExpandedSections(new Set());
  }, [activeScope, searchQuery]);

  useEffect(() => {
    setWorkspaceFiles([]);
    setWorkspaceFilesError(null);
    setWorkspaceFilesLoading(false);
    setLoadedWorkspaceKey(null);
  }, [workspaceKey]);

  useEffect(() => {
    if (!searchFiles || loadedWorkspaceKey === workspaceKey) {
      return;
    }

    let cancelled = false;
    setWorkspaceFilesLoading(true);
    setWorkspaceFilesError(null);
    void fetchWorkspaceFileEntriesPacked(fileService, workspaceAbsPath)
      .then((result) => {
        // Host 返回列式 packed 字符串（避免大数组结构化克隆），此处一次性解包。
        const entries = unpackWorkspaceFileEntries(result, workspaceAbsPath);
        if (cancelled) {
          return;
        }

        setWorkspaceFiles(entries);
        setLoadedWorkspaceKey(workspaceKey);
      })
      .catch((error) => {
        if (!cancelled) {
          const remoteCode = getRemoteConnectionFailureCode(error);
          setWorkspaceFilesError(
            remoteCode
              ? formatRemoteConnectionError({
                  fallback: String(error),
                  reasonCode: remoteCode,
                  formatMessage: intl.formatMessage,
                })
              : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkspaceFilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileService, loadedWorkspaceKey, searchFiles, workspaceAbsPath, workspaceKey, intl]);

  const rememberSearch = useCallback(
    (scope: CommandCenterSearchScope = activeScope) => {
      if (!hasSearchQuery) {
        return;
      }

      setHistoryEntries(
        pushCommandCenterSearchHistory({
          workspaceKey,
          query: searchQuery,
          scope,
        }),
      );
    },
    [activeScope, hasSearchQuery, searchQuery, workspaceKey],
  );

  const closeDialog = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const runCommand = useCallback(
    (command: QuickPickCommand) => {
      rememberSearch("commands");
      closeDialog();
      void Promise.resolve(command.run()).catch((error) => {
        logger.error("[CommandCenter] 命令执行失败", {
          commandId: command.id,
          error,
        });
        toast(
          intl.formatMessage(
            { id: "quickPick.commandFailed" },
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      });
    },
    [closeDialog, intl, rememberSearch],
  );

  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      rememberSearch("conversations");
      onSearchResultHighlightRequest?.({
        taskId: row.task.taskId,
        workspacePath: row.task.workspacePath,
        workspaceIdentity: row.task.workspaceIdentity,
        query: searchQuery,
        snippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSearchResultHighlightRequest, onSelectTask, rememberSearch, searchQuery],
  );

  const selectFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      rememberSearch("files");
      onOpenCodeViewer({
        type: "file",
        title: entry.name,
        path: entry.path,
      });
      closeDialog();
    },
    [closeDialog, onOpenCodeViewer, rememberSearch],
  );

  const selectRecentChange = useCallback(
    (file: TaskChangedFileSummary) => {
      closeDialog();
      const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(relativePath) || relativePath,
        path: file.path,
      });
    },
    [closeDialog, onOpenCodeViewer, workspaceAbsPath],
  );

  const selectRecentTask = useCallback(
    (task: ZCodeTaskMeta) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSelectTask],
  );

  const setScope = useCallback(
    (scope: CommandCenterSearchScope) => {
      setManualScope(scope);
      if (resolvedQuery.explicitScope) {
        setRawQuery(searchQuery);
      }
    },
    [resolvedQuery.explicitScope, searchQuery],
  );

  const shouldShowCommandSection = activeScope === "all" || activeScope === "commands";
  const shouldShowConversationSection = activeScope === "all" || activeScope === "conversations";
  const shouldShowFileSection = activeScope === "all" || activeScope === "files";
  const showHistory = !hasSearchQuery && historyEntries.length > 0;

  const renderDefaultSections = () => {
    switch (activeScope) {
      case "commands":
        return (
          <CommandCenterCommandSections
            visible={shouldShowCommandSection}
            sections={commandOptionsBySection}
            searchQuery={searchQuery}
            intl={intl}
            onRunCommand={runCommand}
          />
        );
      case "conversations":
        return (
          <CommandCenterRecentTasksSection
            rows={recentTaskRows}
            showEmpty
            intl={intl}
            onSelect={selectRecentTask}
          />
        );
      case "files":
        return (
          <CommandCenterRecentChangesSection
            rows={recentChangeRows}
            showEmpty
            workspaceAbsPath={workspaceAbsPath}
            onSelect={selectRecentChange}
            intl={intl}
          />
        );
      default:
        return (
          <>
            <CommandCenterRecentChangesSection
              rows={recentChangePreviewRows}
              workspaceAbsPath={workspaceAbsPath}
              onSelect={selectRecentChange}
              intl={intl}
            />
            <CommandCenterRecentTasksSection
              rows={recentTaskPreviewRows}
              intl={intl}
              onSelect={selectRecentTask}
            />
            <CommandCenterCommandSections
              visible={shouldShowCommandSection}
              sections={commandOptionsBySection}
              searchQuery={searchQuery}
              intl={intl}
              onRunCommand={runCommand}
            />
          </>
        );
    }
  };

  const hasAnySearchResults =
    (shouldShowCommandSection && commandOptions.length > 0) ||
    (shouldShowConversationSection && conversationRows.length > 0) ||
    (shouldShowFileSection && fileRows.length > 0);
  const hasSearchStatus =
    taskList.loading ||
    workspaceFilesLoading ||
    (shouldShowFileSection && Boolean(workspaceFilesError));

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "quickPick.title" })}
      description={intl.formatMessage({ id: "quickPick.description" })}
      className={commandCenterDialogClassName}
    >
      <Command shouldFilter={false} loop className={quickPickCommandClassName}>
        <div className="border-b border-border px-2 pt-2 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
            <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            <CommandPrimitive.Input
              value={rawQuery}
              onValueChange={setRawQuery}
              placeholder={intl.formatMessage({ id: "commandCenter.placeholder" })}
              className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
            />
          </div>
          <CommandCenterScopeTabs activeScope={activeScope} onSelectScope={setScope} intl={intl} />
        </div>
        <CommandList className={commandCenterListClassName}>
          {!hasSearchQuery ? (
            renderDefaultSections()
          ) : hasAnySearchResults || hasSearchStatus ? (
            <>
              <CommandCenterCommandSections
                visible={shouldShowCommandSection}
                sections={commandOptionsBySection}
                searchQuery={searchQuery}
                intl={intl}
                onRunCommand={runCommand}
              />
              <CommandCenterConversationSection
                visible={shouldShowConversationSection}
                hasSearchQuery={hasSearchQuery}
                rows={conversationRows}
                loading={taskList.loading}
                expanded={activeScope === "conversations" || expandedSections.has("conversations")}
                showMore={activeScope === "all"}
                searchQuery={searchQuery}
                workspaceLabelByKey={workspaceLabelByKey}
                intl={intl}
                onSelect={selectTask}
                onExpandMore={() =>
                  setExpandedSections((current) => new Set(current).add("conversations"))
                }
              />
              <CommandCenterFileSection
                visible={shouldShowFileSection}
                hasSearchQuery={hasSearchQuery}
                rows={fileRows}
                loading={workspaceFilesLoading}
                error={workspaceFilesError}
                expanded={activeScope === "files" || expandedSections.has("files")}
                showMore={activeScope === "all"}
                searchQuery={searchQuery}
                intl={intl}
                onSelect={selectFile}
                onExpandMore={() => setExpandedSections((current) => new Set(current).add("files"))}
              />
            </>
          ) : (
            <CommandEmpty className="px-4 py-5 text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.noResults" })}
            </CommandEmpty>
          )}
        </CommandList>
        {showHistory ? (
          <CommandCenterSearchHistory
            entries={historyEntries}
            expanded={historyExpanded}
            onToggleExpanded={() => setHistoryExpanded((value) => !value)}
            onPickEntry={(entry) => {
              const prefix = scopeToPrefix(entry.scope);
              setManualScope(entry.scope);
              setRawQuery(prefix ? `${prefix}${entry.query}` : entry.query);
            }}
            onClear={() => {
              clearCommandCenterSearchHistory(workspaceKey);
              setHistoryEntries([]);
            }}
            historyLabel={intl.formatMessage({ id: "commandCenter.history" })}
            clearLabel={intl.formatMessage({ id: "commandCenter.clearHistory" })}
            expandLabel={intl.formatMessage({ id: "commandCenter.expandHistory" })}
            collapseLabel={intl.formatMessage({ id: "commandCenter.collapseHistory" })}
          />
        ) : null}
      </Command>
    </CommandDialog>
  );
});
