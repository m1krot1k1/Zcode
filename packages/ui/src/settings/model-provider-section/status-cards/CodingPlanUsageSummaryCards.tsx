// StatusCards 拆分：Coding Plan 剩余额度汇总卡与单指标卡。
import type { UsageQuotaLimit, ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";
import { InfoIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuotaResetUi } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { formatQuotaResetTime } from "@/lib/codingPlanQuotaPresentation.js";
import {
  mergeCodingPlanQuotaResetOpportunityBadges,
  resolveCodingPlanQuotaResetActionCompletedAt,
  resolveCodingPlanQuotaResetLimit,
} from "@/lib/codingPlanQuotaResetUi.js";
import { LocalizedCodingPlanQuotaResetAction } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetAction.js";
import { CodingPlanQuotaResetOpportunity } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import { buildCodingPlanQuotaResetDialogConfig } from "@/components/coding-plan-quota-reset/buildCodingPlanQuotaResetDialogConfig.js";
import {
  findUsageLimit,
  formatLimitModels,
  formatRemainingPercentage,
  isDisplayableUsageLimit,
  resolveLimitRemainingPercentage,
} from "./codingPlanUsageMetrics.js";

const CODING_PLAN_USAGE_SUMMARY_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
] as const;

export function CodingPlanUsageSummaryCards({
  limits,
  mcpQuotaLimit,
  sourceKey,
  preferredProviderId,
  accountAccess,
  onEntitlementRefresh,
}: {
  limits: UsageQuotaLimit[];
  mcpQuotaLimit: UsageQuotaLimit | null;
  sourceKey: string;
  preferredProviderId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  onEntitlementRefresh?: () => void | Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const [quotaResetDialogOpen, setQuotaResetDialogOpen] = useState(false);
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey,
    preferredProviderId,
    accountAccess,
    onEntitlementRefresh,
  });
  const fiveHourLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 3, 5),
    resetUi.entry,
  );
  const weeklyLimit = resolveCodingPlanQuotaResetLimit(
    findUsageLimit(limits, "TOKENS_LIMIT", 6),
    resetUi.week.entry,
  );
  const standardCards = [
    createCodingPlanUsageSummaryCard({
      key: "fiveHour",
      label: intl.formatMessage({
        id: "settings.usage.entitlementFiveHourUsage",
      }),
      limit: fiveHourLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[0],
      resetTimeFormat: "dateTime",
    }),
    createCodingPlanUsageSummaryCard({
      key: "weekly",
      label: intl.formatMessage({
        id: "settings.usage.entitlementWeeklyUsage",
      }),
      limit: weeklyLimit ?? undefined,
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[1],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "monthlyTool",
      label: intl.formatMessage({
        id: "settings.usage.entitlementMonthlyMcpUsage",
      }),
      limit: findUsageLimit(limits, "TIME_LIMIT", 5, 1),
      progressColor: CODING_PLAN_USAGE_SUMMARY_COLORS[2],
      resetTimeFormat: "date",
    }),
    createCodingPlanUsageSummaryCard({
      key: "serverMcp",
      label: intl.formatMessage({
        id: "settings.usage.entitlementServerMcpUsage",
      }),
      limit: mcpQuotaLimit ?? undefined,
      progressColor: "var(--color-usage-chart-5)",
      // 官方 Server MCP 额度按自然日重置，重置时刻恒为 00:00，与其它额度卡统一用日期口径。
      resetTimeFormat: "date",
    }),
  ].filter((card): card is CodingPlanUsageSummaryCard => card !== null);
  const cards =
    standardCards.length > 0
      ? standardCards
      : limits
          .filter(isDisplayableUsageLimit)
          .slice(0, 3)
          .map((limit, index) => ({
            key: `generic-${index}`,
            label: resolveGenericUsageLimitLabel(limit, intl),
            limit,
            progressColor:
              CODING_PLAN_USAGE_SUMMARY_COLORS[index % CODING_PLAN_USAGE_SUMMARY_COLORS.length] ??
              CODING_PLAN_USAGE_SUMMARY_COLORS[0],
            resetTimeFormat: "date" as const,
          }));

  const fiveHourCardVisible = cards.some((card) => card.key === "fiveHour");
  const weeklyCardVisible = cards.some((card) => card.key === "weekly");
  // 五小时与周机会合并为一个徽标,次数累加,倒计时取最早到期的一档。
  // Bugfix：曾用「剩余 100% 则重置无收益」隐藏徽标与按钮。核销会把剩余改写成 100%，
  // 同类型余下的机会随即被藏掉，用户以为卡丢了。只要额度卡在且有可用机会就展示。
  const opportunityBadge = mergeCodingPlanQuotaResetOpportunityBadges([
    {
      count: resetUi.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.entry?.opportunityExpiresAt ?? null,
      visible: fiveHourCardVisible && resetUi.opportunityVisible,
    },
    {
      count: resetUi.week.entry?.opportunityCount ?? 0,
      expiresAt: resetUi.week.entry?.opportunityExpiresAt ?? null,
      visible: weeklyCardVisible && resetUi.week.opportunityVisible,
    },
  ]);
  const quotaResetDialog = buildCodingPlanQuotaResetDialogConfig({
    fiveHourEnabled: Boolean(fiveHourLimit),
    resetUi,
    usageItems: cards.map((card) => {
      const percentage = resolveLimitRemainingPercentage(card.limit);
      return {
        color: card.progressColor,
        id: card.key,
        label: card.label,
        percentage,
        resetTime: formatQuotaResetTime({
          locale,
          value: card.limit.nextResetTime,
          format: card.resetTimeFormat,
          compactToday: card.resetTimeFormat === "dateTime",
        }),
        value: formatRemainingPercentage(locale, percentage),
      };
    }),
    weekEnabled: Boolean(weeklyLimit),
  });

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        {(fiveHourCardVisible && resetUi.entry) || (weeklyCardVisible && resetUi.week.entry) ? (
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
      <div className="flex w-full gap-2 max-sm:flex-col">
        {cards.map((card) => (
          <PlanUsageMetricCard
            key={card.key}
            action={
              // 额度标题旁入口只打开统一弹窗；真正核销由弹窗内对应类型按钮触发。
              // Bugfix：这里曾额外要求 opportunityBadge.count <= 1，多张机会时反而把
              // 卡上的重置入口藏掉（Usage 页已修，此处遗漏）。与 Usage 页口径对齐：
              // 有可用机会就展示，不因满额或多张隐藏。
              card.key === "fiveHour" &&
              resetUi.entry &&
              (resetUi.opportunityVisible ||
                resetUi.processing ||
                resetUi.entry.status === "completed") ? (
                <LocalizedCodingPlanQuotaResetAction
                  completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi)}
                  processing={resetUi.processing}
                  onOpenDialog={() => setQuotaResetDialogOpen(true)}
                />
              ) : card.key === "weekly" &&
                resetUi.week.entry &&
                (resetUi.week.opportunityVisible ||
                  resetUi.week.processing ||
                  resetUi.week.entry.status === "completed") ? (
                <LocalizedCodingPlanQuotaResetAction
                  completedAt={resolveCodingPlanQuotaResetActionCompletedAt(resetUi.week)}
                  processing={resetUi.week.processing}
                  resetType="WEEK"
                  onOpenDialog={() => setQuotaResetDialogOpen(true)}
                />
              ) : undefined
            }
            label={card.label}
            limit={card.limit}
            infoDescription={
              card.key === "serverMcp"
                ? intl.formatMessage({
                    id: "sidebar.usage.plan.zcodeMcpDescription",
                  })
                : undefined
            }
            progressColor={card.progressColor}
            resetTimeFormat={card.resetTimeFormat}
          />
        ))}
      </div>
    </div>
  );
}

interface CodingPlanUsageSummaryCard {
  key: string;
  label: string;
  limit: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}

function createCodingPlanUsageSummaryCard(card: {
  key: string;
  label: string;
  limit: UsageQuotaLimit | undefined;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}): CodingPlanUsageSummaryCard | null {
  // Coding Plan 剩余额度展示必须和 sidebar/context 一样只展示接口真实返回的额度项。
  // 不能再用 limits[0]/[1]/[2] 兜底，否则 provider 详情会固定出现三张卡并和其它入口不一致。
  if (!card.limit) {
    return null;
  }
  return {
    key: card.key,
    label: card.label,
    limit: card.limit,
    progressColor: card.progressColor,
    resetTimeFormat: card.resetTimeFormat,
  };
}

function resolveGenericUsageLimitLabel(
  limit: UsageQuotaLimit,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (limit.type === "TIME_LIMIT") {
    return intl.formatMessage({
      id: "settings.usage.entitlementMonthlyMcpUsage",
    });
  }
  // Team Plan 的 quota limit 在测试环境可能不是个人 Coding Plan 的
  // TOKENS_LIMIT(3/5、6) 形态。此时仍应展示剩余额度，不能因为类型不在白名单就空白。
  return intl.formatMessage({
    id: "settings.modelProvider.planCard.usage.totalTokens",
  });
}

function PlanUsageMetricCard({
  action,
  infoDescription,
  label,
  limit,
  progressColor,
  resetTimeFormat,
}: {
  action?: ReactNode;
  infoDescription?: string;
  label?: string;
  limit?: UsageQuotaLimit;
  progressColor: string;
  resetTimeFormat: "date" | "dateTime";
}) {
  const { locale } = useZCodeIntl();
  const remainingPercentage = resolveLimitRemainingPercentage(limit);
  const progressPercentage = remainingPercentage ?? 0;
  const modelLabel = limit && limit.type !== "TIME_LIMIT" ? formatLimitModels(limit) : "";
  const resetTime = formatQuotaResetTime({
    locale,
    value: limit?.nextResetTime,
    format: resetTimeFormat,
    compactToday: resetTimeFormat === "dateTime",
  });

  return (
    <div className="min-w-0 flex-1 rounded-lg bg-surface p-3">
      {label ? (
        // 固定 24px 会让 20px 界面字号的 30px 行盒溢出；最小高度既保持默认对齐，也允许大字号撑高。
        <div className="flex min-h-6 min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{label}</span>
          {infoDescription ? (
            <ControlHintTooltip title={infoDescription} standalone>
              <button
                type="button"
                aria-label={infoDescription}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-foreground-subtle transition-colors hover:text-foreground"
                data-zcode-mcp-info="model-settings"
              >
                <InfoIcon className="size-3.5" aria-hidden="true" />
              </button>
            </ControlHintTooltip>
          ) : null}
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
      ) : null}
      {modelLabel ? (
        <div className={`truncate text-ui-xs text-foreground-subtle ${label ? "mt-1" : ""}`}>
          {modelLabel}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 items-baseline gap-1.5">
        <span className="text-ui-lg font-semibold leading-none text-foreground">
          {formatRemainingPercentage(locale, remainingPercentage)}
        </span>
        {resetTime ? (
          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{resetTime}</span>
        ) : null}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${progressPercentage}%`,
            backgroundColor: progressColor,
          }}
        />
      </div>
    </div>
  );
}
