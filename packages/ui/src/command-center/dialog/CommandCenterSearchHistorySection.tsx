// 命令中心搜索历史区：分区标题 + 历史 chip + 清除/展开按钮。
// 从 CommandCenterDialog.tsx 抽出，便于复用与单测。

import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { CommandCenterSearchHistoryEntry } from "@/command-center/commandCenterSearchHistory.js";
import { scopeToPrefix } from "./commandCenterSearch.js";

/**
 * 命令中心搜索历史区：分区标题 + 历史 chip + 清除/展开按钮。
 *
 * 字号语义（DESIGN.md）：
 * - 分区标题：text-ui-sm（section label / helper text）
 * - 历史 chip 搜索词：text-ui-base（可读内容，与列表主体一致）
 * - chip 内 scope 前缀：text-ui-xs（badge 标记，比主体小一级形成层级）
 */
export function CommandCenterSearchHistory({
  entries,
  expanded,
  onToggleExpanded,
  onPickEntry,
  onClear,
  historyLabel,
  clearLabel,
  expandLabel,
  collapseLabel,
}: {
  entries: CommandCenterSearchHistoryEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPickEntry: (entry: CommandCenterSearchHistoryEntry) => void;
  onClear: () => void;
  historyLabel: string;
  clearLabel: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const canExpand = entries.length > 6;
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2 text-ui-sm font-medium text-foreground-subtle">
        <span>{historyLabel}</span>
        <button
          type="button"
          aria-label={clearLabel}
          className="ml-auto inline-grid size-6 place-items-center rounded-md text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
          onClick={onClear}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <div
        className={cn(
          "relative flex flex-wrap gap-1.5 overflow-hidden px-3 pt-1 pb-2 pr-11",
          expanded ? "" : "max-h-[34px]",
        )}
      >
        {entries.map((entry) => {
          const prefix = scopeToPrefix(entry.scope);
          return (
            <button
              key={`${entry.scope}:${entry.query}:${entry.updatedAt}`}
              type="button"
              // text-ui-base 随 --ui-font-size（12–20px）缩放，不能用固定 h-5
              // 否则 20px 字号下内容区（20px - 2px 边框 = 18px）装不下字体行盒，
              // 配合外层 overflow-hidden 会裁切文字。改用 min-h-5 + py-0.5 + leading-none
              // 让高度随字号增长，保证 12–20px 全范围可读。
              className="inline-flex min-h-5 max-w-44 shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 leading-none text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={() => onPickEntry(entry)}
            >
              {prefix ? <span className="font-mono text-ui-xs text-brand">{prefix}</span> : null}
              <span className="min-w-0 truncate">{entry.query}</span>
            </button>
          );
        })}
        {canExpand ? (
          <button
            type="button"
            aria-label={expanded ? collapseLabel : expandLabel}
            className="absolute top-1 right-3 inline-grid size-6 place-items-center rounded-md text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", expanded ? "rotate-180" : "")}
            />
          </button>
        ) : null}
      </div>
    </>
  );
}
