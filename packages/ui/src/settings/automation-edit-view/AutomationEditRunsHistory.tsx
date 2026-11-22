import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { cn } from "@/components/lib/utils.js";
import type { ZCodeAutomationRun } from "@zcode/shared";
import {
  AutomationExternalLinkIcon,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { formatDateTime, formatDuration } from "@/settings/automationFormat.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AutomationRunsEntry } from "@/store/automationManagementStore.js";

/** 运行历史每页条数。 */
const RUNS_PAGE_SIZE = 8;

/**
 * 生成分页控件的页码序列：首尾各保留 3 页、当前页左右各 1 页，其余用省略号折叠。
 * 例：current=1,total=10 → [1,2,3,"ellipsis",8,9,10]。
 */
function buildRunsPageItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>([
    1,
    2,
    3,
    total - 2,
    total - 1,
    total,
    current - 1,
    current,
    current + 1,
  ]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}

// ---- 运行历史状态映射(与 AutomationRunsDialog 保持一致) ----
type RunStatusKind = "running" | "succeeded" | "failed" | "stopped" | "skipped";
function resolveRunStatus(run: ZCodeAutomationRun): RunStatusKind {
  if (run.dispatchStatus === "skipped") return "skipped";
  if (run.dispatchStatus === "failed_to_dispatch") return "failed";
  switch (run.outcome) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "running";
  }
}
// 运行状态用「圆点 + 彩色文字」呈现（Scheduled 历史表密度规格）。
const RUN_STATUS_DOT_CLASS: Record<RunStatusKind, string> = {
  running: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground-subtlest",
  skipped: "bg-warning",
};
const RUN_STATUS_TEXT_CLASS: Record<RunStatusKind, string> = {
  running: "text-primary",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground-subtle",
  skipped: "text-warning",
};

interface AutomationEditRunsHistoryProps {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  onDeleteRun?: (runId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  runsEntry?: AutomationRunsEntry;
  runsPage: number;
  setRunsPage: (page: number) => void;
}

export function AutomationEditRunsHistory({
  intl,
  onDeleteRun,
  onOpenSession,
  runsEntry,
  runsPage,
  setRunsPage,
}: AutomationEditRunsHistoryProps) {
  const runs = runsEntry?.runs ?? [];
  const runsLoading = runsEntry?.status === "loading";
  // 运行历史客户端分页：数据已整份加载，这里按页切片展示。删除后条数变化时把页码收敛到有效范围。
  const runsTotalPages = Math.max(1, Math.ceil(runs.length / RUNS_PAGE_SIZE));
  const runsCurrentPage = Math.min(runsPage, runsTotalPages);
  const pagedRuns = runs.slice(
    (runsCurrentPage - 1) * RUNS_PAGE_SIZE,
    runsCurrentPage * RUNS_PAGE_SIZE,
  );
  const runsPageItems = buildRunsPageItems(runsCurrentPage, runsTotalPages);
  return (
    // History tab：运行历史内联表
    <div>
      {/* 修复原因：运行条件已在设置入口说明，历史页重复提示会挤占表格上方空间。 */}
      {runsLoading && runs.length === 0 ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : runsEntry?.status === "error" ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
          {runsEntry.error}
        </div>
      ) : runs.length === 0 ? (
        // 定时任务曾仅渲染透明的 py-10 文本块，缺少与闲时任务一致的空态背景、边框和高度。
        <AutomationHistoryEmptyState>
          {intl.formatMessage({ id: "automations.runs.empty" })}
        </AutomationHistoryEmptyState>
      ) : (
        <div className="overflow-x-auto rounded-[8px]">
          {/* 修复原因：运行历史使用可缩放字号，不能继续绑定固定 18px 行高。 */}
          <table className="w-full text-left text-ui-base font-normal leading-normal tracking-[-0.08px]">
            <thead className="bg-surface text-foreground-subtle">
              <tr className="h-[30px] border-b border-border">
                <th className="px-4 font-normal">
                  {intl.formatMessage({
                    id: "automations.runs.col.triggered",
                  })}
                </th>
                <th className="px-4 font-normal">
                  {intl.formatMessage({
                    id: "automations.runs.col.trigger",
                  })}
                </th>
                <th className="px-4 font-normal">
                  {intl.formatMessage({
                    id: "automations.runs.col.status",
                  })}
                </th>
                <th className="px-4 font-normal">
                  {intl.formatMessage({
                    id: "automations.runs.col.duration",
                  })}
                </th>
                <th className="px-4 font-normal" />
              </tr>
            </thead>
            <tbody>
              {pagedRuns.map((run) => {
                const status = resolveRunStatus(run);
                const statusLabel = intl.formatMessage({
                  id: `automations.runs.status.${status}`,
                });
                const statusBadge = (
                  <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "inline-block size-1.5 rounded-full",
                          RUN_STATUS_DOT_CLASS[status],
                        )}
                      />
                    </span>
                    <span className={RUN_STATUS_TEXT_CLASS[status]}>{statusLabel}</span>
                  </span>
                );
                const canOpenSession = Boolean(run.sessionId && onOpenSession);
                const hasActions = canOpenSession || Boolean(onDeleteRun);
                return (
                  <tr
                    key={run.runId}
                    className="h-[46px] border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover"
                  >
                    <td className="whitespace-nowrap px-4 text-foreground-subtle">
                      {formatDateTime(run.scheduledAt ?? run.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 text-foreground-subtle">
                      {intl.formatMessage({
                        id: `automations.trigger.${run.trigger}`,
                      })}
                    </td>
                    <td className="px-4">
                      {status === "failed" ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>{statusBadge}</TooltipTrigger>
                            <TooltipContent
                              side="top"
                              align="start"
                              sideOffset={6}
                              className="max-w-96 whitespace-normal break-words"
                            >
                              {run.error?.trim() ||
                                intl.formatMessage({
                                  id: "automations.runs.errorUnavailable",
                                })}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        statusBadge
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 text-foreground-subtle">
                      {formatDuration(run.createdAt, run.updatedAt)}
                    </td>
                    <td className="px-4">
                      <div className="flex items-center justify-end">
                        {hasActions ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label={intl.formatMessage({
                                  id: "automations.moreActions",
                                })}
                                className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                              >
                                <AutomationMoreHorizontalIcon
                                  className="size-4"
                                  aria-hidden="true"
                                />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              sideOffset={4}
                              className="min-w-[160px]"
                            >
                              {canOpenSession ? (
                                <DropdownMenuItem onSelect={() => onOpenSession?.(run.sessionId!)}>
                                  <AutomationExternalLinkIcon
                                    className="size-3.5"
                                    aria-hidden="true"
                                  />
                                  {intl.formatMessage({
                                    id: "automations.runs.openSession",
                                  })}
                                </DropdownMenuItem>
                              ) : null}
                              {onDeleteRun ? (
                                <>
                                  {canOpenSession ? <DropdownMenuSeparator /> : null}
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => onDeleteRun(run.runId)}
                                  >
                                    <AutomationTrashIcon />
                                    {intl.formatMessage({
                                      id: "automations.runs.delete",
                                    })}
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.length > 0 && runsTotalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-ui-base">
          <button
            type="button"
            disabled={runsCurrentPage <= 1}
            onClick={() => setRunsPage(Math.max(1, runsCurrentPage - 1))}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {intl.formatMessage({ id: "automations.runs.prevPage" })}
          </button>
          <div className="flex items-center gap-1">
            {runsPageItems.map((item, index) =>
              item === "ellipsis" ? (
                <span
                  key={`ellipsis-${index}`}
                  className="flex size-7 items-center justify-center text-foreground-subtlest"
                  aria-hidden="true"
                >
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  aria-current={item === runsCurrentPage ? "page" : undefined}
                  onClick={() => setRunsPage(item)}
                  className={cn(
                    "inline-flex size-7 items-center justify-center rounded-[6px] transition-colors",
                    item === runsCurrentPage
                      ? "bg-surface text-foreground"
                      : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {item}
                </button>
              ),
            )}
          </div>
          <button
            type="button"
            disabled={runsCurrentPage >= runsTotalPages}
            onClick={() => setRunsPage(Math.min(runsTotalPages, runsCurrentPage + 1))}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-foreground-subtle transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            {intl.formatMessage({ id: "automations.runs.nextPage" })}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
