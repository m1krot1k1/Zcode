import { useState } from "react";
import { InfoIcon, RefreshCw } from "lucide-react";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  getQuotaRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import {
  formatCodingPlanRefreshTime,
  formatUsageStatsQuotaResetTime,
} from "./codingPlanUsageFormatting.js";
import type {
  CodingPlanQuotaCard,
  CodingPlanQuotaCardsProps,
} from "./types.js";

export function CodingPlanQuotaCards({
  quota,
  mcpQuotaLimit,
  generatedAt,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
  onUsageStatsRefresh,
}: CodingPlanQuotaCardsProps) {
  const { intl, locale } = useZCodeIntl();
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  const limits = quota?.limits ?? [];
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // Bugfix：曾用「剩余 100% 则重置无收益」隐藏徽标与按钮。核销会把剩余改写成 100%，
  // 同类型余下的机会随即被藏掉，用户以为卡丢了。只要额度存在且有可用机会就展示。
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(fiveHourLimit) && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: Boolean(weeklyLimit) && resetUi.week.opportunityVisible,
    },
  ]);
  const cards = [
    {
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit,
      progressColor: "var(--color-usage-chart-1)",
    },
    {
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit,
      progressColor: "var(--color-usage-chart-2)",
    },
    {
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      limit: findCodingPlanQuotaLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: "var(--color-usage-chart-3)",
    },
    {
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      limit: mcpQuotaLimit,
      progressColor: "var(--color-usage-chart-5)",
    },
  ].filter((card): card is CodingPlanQuotaCard => Boolean(card.limit));

  if (cards.length === 0) {
    return null;
  }

  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    resetUi,
    usageItems: cards.map((card) => ({
      color: card.progressColor,
      id: card.key,
      label: card.label,
      percentage: getQuotaRemainingPercentage(card.limit),
      resetTime: formatUsageStatsQuotaResetTime(
        locale,
        card.limit.nextResetTime,
      ),
      value: formatQuotaRemainingPercentage(locale, card.limit),
    })),
    weekEnabled: Boolean(weeklyLimit),
  });

  // Quota remaining 的响应式只允许整组纵向或整组横向。
  // 额度项（最多 4 个：5 小时 / 每周 / MCP / Server MCP）不能在中间断点排成 n+1，
  // 否则信息组会被视觉拆散。
  const quotaCardsLayoutClass = "flex flex-col gap-3 lg:flex-row";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
          </h3>
          {(fiveHourCardVisible && resetUi.entry) ||
          (weeklyCardVisible && resetUi.week.entry) ? (
            <CodingPlanQuotaResetOpportunity
              count={opportunityBadge.count}
              dialog={quotaResetDialog}
              dialogOpen={quotaResetDialogOpen}
              expiresAt={opportunityBadge.expiresAt}
              placement="inline"
              visible={opportunityBadge.visible}
              onDialogOpenChange={setQuotaResetDialogOpen}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-ui-base text-foreground-subtle">
          <span>{formatCodingPlanRefreshTime(locale, intl, generatedAt)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "settings.usage.refresh" })}
            onClick={() => {
              void onUsageStatsRefresh();
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">
              {intl.formatMessage({ id: "settings.usage.refresh" })}
            </span>
          </Button>
        </div>
      </div>
      <div className={quotaCardsLayoutClass}>
        {cards.map((card) => {
          const percentage = getQuotaRemainingPercentage(card.limit) ?? 0;
          const resetTime = formatUsageStatsQuotaResetTime(
            locale,
            card.limit.nextResetTime,
          );
          return (
            <div
              key={card.key}
              className="min-w-0 flex-1 rounded-xl bg-surface/70 p-4"
            >
              {/* min-h 与重置动作(h-5)对齐:没有动作的额度卡也保持同高,避免同排数值/进度条错位。 */}
              <div className="flex min-h-5 min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-ui-base text-foreground">
                  {card.label}
                </span>
                {card.key === "serverMcp" ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "sidebar.usage.plan.zcodeMcpDescription",
                    })}
                    standalone
                  >
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "sidebar.usage.plan.zcodeMcpDescription",
                      })}
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                      data-zcode-mcp-info="usage-stats"
                    >
                      <InfoIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  </ControlHintTooltip>
                ) : null}
                {/* 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。 */}
                {card.key === "fiveHour" &&
                resetUi.entry &&
                (resetUi.opportunityVisible ||
                  resetUi.processing ||
                  resetUi.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(
                      resetUi,
                    )}
                    processing={resetUi.processing}
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : card.key === "weekly" &&
                  resetUi.week.entry &&
                  (resetUi.week.opportunityVisible ||
                    resetUi.week.processing ||
                    resetUi.week.entry.status === "completed") ? (
                  <LocalizedCodingPlanQuotaResetAction
                    completedAt={resolveCodingPlanQuotaResetActionCompletedAt(
                      resetUi.week,
                    )}
                    processing={resetUi.week.processing}
                    resetType="WEEK"
                    onOpenDialog={() => setQuotaResetDialogOpen(true)}
                  />
                ) : null}
              </div>
              <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
                <span className="text-ui-xl font-semibold text-foreground">
                  {formatQuotaRemainingPercentage(locale, card.limit)}
                </span>
                {resetTime ? (
                  <span className="min-w-0 truncate text-ui-base text-foreground-subtle">
                    {resetTime}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-background">
                <div
                  className="min-w-2 h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{
                    width: `${percentage}%`,
                    backgroundColor: card.progressColor,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
