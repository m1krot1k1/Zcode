import type { ChatCodingPlanUsageRemainingConfig } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  ChatCodingPlanUsageRemainingPanel,
  type CodingPlanQuotaResetAutoConfettiArms,
} from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  ChatStartPlanBalancePanel,
  type ChatStartPlanBalanceConfig,
} from "@/chat-input-toolbar/StartPlanContextBalance.js";
import { cn } from "@/components/lib/utils.js";
import { Progress } from "@/components/ui/progress.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BREAKDOWN_SOURCE_LABEL_ID,
  PERCENT_MAX,
  getBreakdownToneStyle,
  type ContextUsageBreakdownSegment,
  type ContextUsageProgressSegment,
  type ContextUsageTaskUsage,
} from "./usageFormatting.js";

export interface ContextUsageBodyProps {
  armedAutoConfetti: CodingPlanQuotaResetAutoConfettiArms;
  breakdownSegments: readonly ContextUsageBreakdownSegment[];
  cacheHitRateLabel: string | null;
  codingPlanUsageRemaining: ChatCodingPlanUsageRemainingConfig | undefined;
  compactTokenUsageLabel: string | null;
  hasCodingPlanUsageRemaining: boolean;
  hasStartPlanBalance: boolean;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  locale: string;
  onAutoResetCelebrated: (completedAt: number) => void;
  onQuotaResetDialogOpenChange: (open: boolean) => void;
  percentageFormatter: Intl.NumberFormat;
  progressSegments: readonly ContextUsageProgressSegment[];
  quotaResetDialogOpen: boolean;
  renderableTaskUsage: ContextUsageTaskUsage | null;
  startPlanBalance: ChatStartPlanBalanceConfig | undefined;
  usagePercent: number;
}

/** Context hover 面板 body：上下文容量、来源明细与 Coding Plan / Start Plan 两段余额。 */
export function ContextUsageBody({
  armedAutoConfetti,
  breakdownSegments,
  cacheHitRateLabel,
  codingPlanUsageRemaining,
  compactTokenUsageLabel,
  hasCodingPlanUsageRemaining,
  hasStartPlanBalance,
  intl,
  locale,
  onAutoResetCelebrated,
  onQuotaResetDialogOpenChange,
  percentageFormatter,
  progressSegments,
  quotaResetDialogOpen,
  renderableTaskUsage,
  startPlanBalance,
  usagePercent,
}: ContextUsageBodyProps) {
  return (
    <>
      {/* Bugfix: 默认 ai-elements Header 会硬编码标题并把摘要拆到独立头部。
          工具栏上下文 hover 只需要一块紧凑信息面板，摘要和明细统一放在 body 里。 */}
      {renderableTaskUsage && compactTokenUsageLabel ? (
        <div className="space-y-2">
          <div className="flex min-w-0 mb-3 items-center gap-3">
            <span className="shrink-0 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "chat.contextUsage.title" })}
            </span>
            <span className="ml-auto shrink-0 text-right font-mono text-ui-sm text-foreground-subtle">
              {compactTokenUsageLabel}
            </span>
          </div>
          <Progress
            className="h-2 bg-surface"
            indicatorClassName="min-w-2"
            segments={progressSegments}
            value={usagePercent * PERCENT_MAX}
          />
        </div>
      ) : null}
      {renderableTaskUsage && (breakdownSegments.length > 0 || cacheHitRateLabel) ? (
        <>
          {breakdownSegments.length > 0 ? (
            <div
              aria-label={intl.formatMessage({
                id: "chat.contextUsage.breakdown",
              })}
              className="space-y-1.5"
            >
              <div className="grid gap-1.5">
                {breakdownSegments.map((segment, index) => (
                  <div className="flex min-w-0 items-center gap-2 text-ui-sm" key={segment.source}>
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-sm border border-border"
                      style={getBreakdownToneStyle(index)}
                    />
                    <span className="min-w-0 truncate text-foreground-subtle">
                      {intl.formatMessage({
                        id: BREAKDOWN_SOURCE_LABEL_ID[segment.source],
                      })}
                    </span>
                    {/* Bugfix: breakdown 行只展示占比，分项 token 数会和顶部总量口径混在一起造成误读。 */}
                    <span className="ml-auto min-w-10 shrink-0 text-right font-mono text-ui-sm tabular-nums text-foreground">
                      {percentageFormatter.format(segment.percent)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {cacheHitRateLabel ? (
            <div
              className={cn(
                "flex items-center justify-between gap-3 text-ui-sm",
                breakdownSegments.length > 0 && "border-t border-border pt-3",
              )}
            >
              <span className="text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.contextUsage.cacheHitRate",
                })}
              </span>
              <span className="font-mono text-ui-sm text-foreground">{cacheHitRateLabel}</span>
            </div>
          ) : null}
        </>
      ) : null}
      {codingPlanUsageRemaining && hasCodingPlanUsageRemaining ? (
        <ChatCodingPlanUsageRemainingPanel
          autoCelebrateArm={armedAutoConfetti}
          config={codingPlanUsageRemaining}
          intl={intl}
          locale={locale}
          quotaResetDialogOpen={quotaResetDialogOpen}
          separated={Boolean(renderableTaskUsage && compactTokenUsageLabel)}
          onAutoCelebrated={onAutoResetCelebrated}
          onQuotaResetDialogOpenChange={onQuotaResetDialogOpenChange}
        />
      ) : null}
      {startPlanBalance && hasStartPlanBalance ? (
        <ChatStartPlanBalancePanel
          config={startPlanBalance}
          intl={intl}
          locale={locale}
          separated={Boolean(
            (renderableTaskUsage && compactTokenUsageLabel) || hasCodingPlanUsageRemaining,
          )}
        />
      ) : null}
    </>
  );
}
