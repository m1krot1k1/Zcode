// 命令中心的搜索结果分区：命令、对话、文件。
// 从 CommandCenterDialog.tsx 拆出，保持行 key、value 与截断顺序不变。

import { MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command.js";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import { QUICK_PICK_ICON_BY_KIND } from "@/quickpick/quickPickCommandIcons.js";
import type { QuickPickCommand, QuickPickCommandSectionId } from "@/quickpick/quickPickCommands.js";
import {
  quickPickItemClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { IntlInstance } from "@/i18n/index.js";
import {
  COMMAND_CENTER_SECTION_LIMIT,
  getTaskTitle,
  getWorkspaceFileDirectory,
  type TaskSearchResultRow,
} from "./commandCenterSearch.js";
import { CommandCenterMoreResultsRow } from "./CommandCenterContextSections.js";

export type CommandCenterCommandOption = {
  command: QuickPickCommand;
  title: string;
};

export type CommandCenterCommandSection = {
  sectionId: QuickPickCommandSectionId;
  commands: CommandCenterCommandOption[];
};

/**
 * 对话搜索结果的时间戳。
 * 独立组件便于复用与单测；按 DESIGN.md 语义角色，列表项里的相对时间属于
 * secondary copy，使用 text-ui-sm（不用 text-ui-xs，避免偏小）。
 */
export function CommandCenterConversationTimestamp({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "max-w-12 shrink-0 truncate font-sans text-ui-sm tracking-normal text-foreground-subtlest",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function CommandCenterCommandSections({
  visible,
  sections,
  searchQuery,
  intl,
  onRunCommand,
}: {
  visible: boolean;
  sections: CommandCenterCommandSection[];
  searchQuery: string;
  intl: IntlInstance;
  onRunCommand: (command: QuickPickCommand) => void;
}) {
  if (!visible || sections.length === 0) {
    return null;
  }

  return sections.map((section) => (
    <CommandGroup
      key={section.sectionId}
      heading={intl.formatMessage({
        id: `quickPick.section.${section.sectionId}`,
      })}
    >
      {section.commands.map(({ command, title }) => {
        const Icon = QUICK_PICK_ICON_BY_KIND[command.icon];
        return (
          <CommandItem
            key={command.id}
            value={`${title} ${command.keywords.join(" ")}`}
            disabled={command.disabled}
            className={quickPickItemClassName}
            onSelect={() => onRunCommand(command)}
          >
            <Icon className="size-3.5 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate">
              <HighlightedMatchText text={title} query={searchQuery} />
            </span>
            {command.shortcut ? (
              <CommandShortcut className={quickPickShortcutPillClassName}>
                {command.shortcut}
              </CommandShortcut>
            ) : null}
          </CommandItem>
        );
      })}
    </CommandGroup>
  ));
}

export function CommandCenterConversationSection({
  visible,
  hasSearchQuery,
  rows,
  loading,
  expanded,
  showMore,
  searchQuery,
  workspaceLabelByKey,
  intl,
  onSelect,
  onExpandMore,
}: {
  visible: boolean;
  hasSearchQuery: boolean;
  rows: TaskSearchResultRow[];
  loading: boolean;
  /** 展示全部行（scope=conversations 或用户点了「更多结果」）。 */
  expanded: boolean;
  /** scope=all 时才提供「更多结果」入口。 */
  showMore: boolean;
  searchQuery: string;
  workspaceLabelByKey: Map<string, string>;
  intl: IntlInstance;
  onSelect: (row: TaskSearchResultRow) => void;
  onExpandMore: () => void;
}) {
  if (!hasSearchQuery || !visible || (!loading && rows.length === 0)) {
    return null;
  }

  const visibleRows = expanded ? rows : rows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
  return (
    <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.conversations" })}>
      {loading && rows.length === 0 ? (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "taskSearch.loading" })}
        </CommandEmpty>
      ) : null}
      {visibleRows.map((row) => {
        const task = row.task;
        const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
        const workspaceLabel =
          workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
          task.workspacePath;
        const searchSnippet = row.searchSnippet?.trim();
        return (
          <CommandItem
            key={row.key}
            // 搜索结果沿用含工作区身份、任务 ID 和片段序号的行 key，避免同文案一起选中。
            value={`task-result:${row.key}`}
            className={quickPickItemClassName}
            onSelect={() => onSelect(row)}
          >
            <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
            <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
              <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                <HighlightedMatchText text={title} query={searchQuery} />
              </span>
              {searchSnippet ? (
                <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
                  <HighlightedMatchText text={searchSnippet} query={searchQuery} />
                </span>
              ) : null}
            </span>
            <CommandShortcut className={quickPickMetadataClassName}>
              {workspaceLabel}
            </CommandShortcut>
            <CommandCenterConversationTimestamp>
              {formatTaskRelativeTime(task.updatedAt, intl)}
            </CommandCenterConversationTimestamp>
          </CommandItem>
        );
      })}
      {showMore ? (
        <CommandCenterMoreResultsRow
          expanded={expanded}
          count={rows.length}
          label={intl.formatMessage({ id: "commandCenter.moreResults" })}
          onExpand={onExpandMore}
        />
      ) : null}
    </CommandGroup>
  );
}

export function CommandCenterFileSection({
  visible,
  hasSearchQuery,
  rows,
  loading,
  error,
  expanded,
  showMore,
  searchQuery,
  intl,
  onSelect,
  onExpandMore,
}: {
  visible: boolean;
  hasSearchQuery: boolean;
  rows: WorkspaceFileEntry[];
  loading: boolean;
  error: string | null;
  /** 展示全部行（scope=files 或用户点了「更多结果」）。 */
  expanded: boolean;
  /** scope=all 时才提供「更多结果」入口。 */
  showMore: boolean;
  searchQuery: string;
  intl: IntlInstance;
  onSelect: (entry: WorkspaceFileEntry) => void;
  onExpandMore: () => void;
}) {
  if (!hasSearchQuery || !visible || (!loading && !error && rows.length === 0)) {
    return null;
  }

  const visibleRows = expanded ? rows : rows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
  return (
    <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.files" })}>
      {loading && rows.length === 0 ? (
        <CommandEmpty className="px-4 py-5 text-foreground-subtle">
          {intl.formatMessage({ id: "sidePane.openFileLoading" })}
        </CommandEmpty>
      ) : error ? (
        <CommandEmpty className="px-4 py-5 text-destructive">{error}</CommandEmpty>
      ) : null}
      {visibleRows.map((entry) => {
        const descriptor = resolveFileDisplayDescriptor(entry.path);
        const directory = getWorkspaceFileDirectory(entry);
        return (
          <CommandItem
            key={entry.path}
            value={`${entry.name} ${entry.relativePath}`}
            className={quickPickItemClassName}
            onSelect={() => onSelect(entry)}
          >
            <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              <HighlightedMatchText text={entry.name} query={searchQuery} />
            </span>
            {directory ? (
              <CommandShortcut className={quickPickMetadataClassName}>
                <HighlightedMatchText text={directory} query={searchQuery} />
              </CommandShortcut>
            ) : null}
          </CommandItem>
        );
      })}
      {showMore ? (
        <CommandCenterMoreResultsRow
          expanded={expanded}
          count={rows.length}
          label={intl.formatMessage({ id: "commandCenter.moreResults" })}
          onExpand={onExpandMore}
        />
      ) : null}
    </CommandGroup>
  );
}
