/**
 * 定时任务卡片网格：单卡展示状态/调度/运行次数，并挂操作菜单。
 */
import type { ComponentType, SVGProps } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ZCodeAutomation } from "@zcode/shared";
import { TID_AUTOMATION_CARD, TID_AUTOMATIONS_LIST } from "@zcode/shared/test-ids";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatAutomationCardNextRun,
  hasAutomationFailureState,
  resolveAutomationStatusKind,
  type AutomationStatusKind,
} from "@/settings/automationFormat.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";
import { AutomationScheduleBadge } from "@/settings/AutomationScheduleBadge.js";
import {
  AutomationClockIcon,
  AutomationPausedIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { AutomationActionsMenu } from "@/settings/automations-section/AutomationActionsMenu.js";
import {
  canRestartAutomation,
  canToggleAutomation,
} from "@/settings/automations-section/automationViewResolvers.js";

const STATUS_META: Record<
  AutomationStatusKind,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }
> = {
  active: { icon: AutomationClockIcon, className: "text-success" },
  // 设计稿的暂停态是 stop-circle 描边图标，不能回退为圆圈内实心方块。
  paused: { icon: AutomationPausedIcon, className: "text-foreground-subtle" },
  completed: { icon: CircleCheck, className: "text-foreground-subtle" },
  failed: { icon: TriangleAlert, className: "text-destructive" },
};

function automationPromptSummary(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : " ";
}

export interface AutomationCardGridProps {
  visibleAutomations: readonly ZCodeAutomation[];
  now: number;
  operationId: string | null | undefined;
  onOpen: (automation: ZCodeAutomation) => void;
  onRunNow: (automation: ZCodeAutomation) => void;
  onToggle: (automation: ZCodeAutomation, enabled: boolean) => void;
  onRestart: (automation: ZCodeAutomation) => void;
  onDelete: (automation: ZCodeAutomation) => void;
}

export function AutomationCardGrid({
  visibleAutomations,
  now,
  operationId,
  onOpen,
  onRunNow,
  onToggle,
  onRestart,
  onDelete,
}: AutomationCardGridProps) {
  const { intl } = useZCodeIntl();
  return (
    <div
      data-testid={TID_AUTOMATIONS_LIST}
      className={cn(
        "grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2",
        // 设计规范最多露出 8 张卡片；grid 自身负责滚动。阈值按筛选后的数量算，
        // 否则筛出少量卡片时仍锁高度会留下大块空白。
        visibleAutomations.length > 8 &&
          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
      )}
    >
      {visibleAutomations.map((automation) => {
        const status = resolveAutomationStatusKind(automation);
        const hasFailure = hasAutomationFailureState(automation);
        const statusMeta = STATUS_META[status];
        const StatusIcon = statusMeta.icon;
        const scheduleText = describeAutomationCardSchedule(automation, intl);
        const formattedNextRun = formatAutomationCardNextRun(automation.nextRunAt, now, intl);
        // completed/paused/失败态的调度不再推进，但有限次任务跑完后
        // nextRunAt 仍可能指向未来时刻，曾被拼进卡片误显“下次运行”。只有活跃
        // 且未失败的卡片才追加下次运行时间，其余一律只展示频率摘要。
        const scheduleCardText =
          status === "active" && !hasFailure && formattedNextRun
            ? `${scheduleText} · ${intl.formatMessage(
                { id: "automations.nextRun" },
                { when: formattedNextRun },
              )}`
            : scheduleText;
        // Card 展示的是定时 + 手动派发的累计次数；maxRuns 只约束定时计划，
        // 若作为分母会让用户误以为“立即运行”也消耗有限任务额度。
        const runCountText = intl.formatMessage(
          { id: "automations.runCount" },
          { count: String(automation.runCount) },
        );
        const busy = operationId?.endsWith(`:${automation.automationId}`) ?? false;
        // completed 表示有限次任务已经自然结束，不能再通过 Restart 复活；
        // failed 才是可恢复终态，允许用户手动重排下一次运行。
        const canRestart = canRestartAutomation(automation);
        const canToggle = canToggleAutomation(automation);
        return (
          <div
            key={automation.automationId}
            data-testid={TID_AUTOMATION_CARD}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(automation)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(automation);
              }
            }}
            className={cn(
              // 任务卡与模板卡曾分别使用 surface/border，跨主题下描边深浅不一致。
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // 已完成任务保持静态弱化，不在 hover 时恢复透明度或改变背景。
              status === "completed" ? "opacity-60" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-12 text-ui-base font-medium leading-5 text-foreground">
                {automation.title}
              </span>
              <p className="text-wrap-phrase line-clamp-2 h-10 text-ui-base font-normal leading-5 text-foreground-subtle">
                {automationPromptSummary(automation.prompt)}
              </p>
              <div className="mt-auto flex h-6 min-w-0 items-center gap-2 text-ui-base leading-5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {hasFailure ? (
                    <>
                      <span className="inline-flex shrink-0 items-center py-0.5 pl-1 pr-2 font-normal text-destructive">
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <TriangleAlert className="size-4" strokeWidth={1.33} aria-hidden="true" />
                        </span>
                        <span className="pl-1">
                          {intl.formatMessage({
                            id: "automations.lifecycle.failed",
                          })}
                        </span>
                      </span>
                      {/* 失败态也只展示 cron 摘要，禁止把已过期 nextRunAt 误写成“下次运行”。 */}
                      <span className="inline-flex min-w-0 items-center rounded-md bg-success/10 py-0.5 pl-1 pr-2 font-normal text-success opacity-40">
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationClockIcon className="size-4" aria-hidden="true" />
                        </span>
                        <span className="truncate pl-1">{scheduleCardText}</span>
                      </span>
                    </>
                  ) : status === "active" ? (
                    <AutomationScheduleBadge
                      text={scheduleCardText}
                      icon={
                        <StatusIcon
                          className="size-4 shrink-0"
                          strokeWidth={1.33}
                          aria-hidden="true"
                        />
                      }
                    />
                  ) : (
                    <>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 font-normal",
                          statusMeta.className,
                        )}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <StatusIcon
                            className="size-4 shrink-0"
                            strokeWidth={1.33}
                            aria-hidden="true"
                          />
                        </span>
                        {intl.formatMessage({
                          id: `automations.lifecycle.${status}`,
                        })}
                      </span>
                      {status === "paused" || status === "completed" ? (
                        /* 暂停/完成后调度不再推进，只展示 cron 摘要，不展示 nextRunAt。 */
                        <AutomationScheduleBadge
                          dimmed
                          text={scheduleCardText}
                          icon={<AutomationClockIcon className="size-4" aria-hidden="true" />}
                        />
                      ) : null}
                    </>
                  )}
                </div>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 text-ui-base font-normal text-foreground-subtle",
                    (hasFailure || status === "paused") && "opacity-40",
                  )}
                >
                  {runCountText}
                </span>
              </div>
            </div>

            <div className="absolute right-3 top-3 flex items-center gap-1">
              {busy ? <Spinner className="size-3.5" /> : null}
              <AutomationActionsMenu
                automation={automation}
                busy={busy}
                canRestart={canRestart}
                canToggle={canToggle}
                onRunNow={onRunNow}
                onEdit={onOpen}
                onToggle={onToggle}
                onRestart={onRestart}
                onDelete={onDelete}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
