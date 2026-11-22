import { resolveMcpQuotaLimit } from "@/lib/codingPlanQuotaPresentation.js";
import {
  buildCodingPlanUsageSources,
  type CodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import { CodingPlanActivitySection } from "@/settings/usage-stats/coding-plan-usage-panel/CodingPlanActivitySection.js";
import { CodingPlanQuotaCards } from "@/settings/usage-stats/coding-plan-usage-panel/CodingPlanQuotaCards.js";
import { CodingPlanUsageTrendsSection } from "@/settings/usage-stats/coding-plan-usage-panel/CodingPlanUsageTrendsSection.js";
import { useCodingPlanUsagePanelState } from "@/settings/usage-stats/coding-plan-usage-panel/useCodingPlanUsagePanelState.js";
import type { CodingPlanUsagePanelProps } from "@/settings/usage-stats/coding-plan-usage-panel/types.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import { UsageEmptyState } from "@/settings/usage-stats/usageStatsUiParts.js";

export { buildCodingPlanUsageSources, type CodingPlanUsageSource };
export { formatUsageStatsQuotaResetTime } from "@/settings/usage-stats/coding-plan-usage-panel/codingPlanUsageFormatting.js";
export {
  hasCodingPlanCreditUsageData,
  resolveCodingPlanUsageProviderName,
  shouldShowCodingPlanUsageDetailSummary,
} from "@/settings/usage-stats/coding-plan-usage-panel/codingPlanUsageMetrics.js";

export function CodingPlanUsagePanel({
  loadingSources,
  selectedSource,
  workspaceIdentity,
  workspacePath,
}: CodingPlanUsagePanelProps) {
  const {
    intl,
    range,
    setRange,
    effectiveSource,
    effectiveProviderId,
    effectiveEntitlementSnapshot,
    snapshot,
    loading,
    error,
    handleResetEntitlementRefresh,
    handleUsageStatsRefresh,
  } = useCodingPlanUsagePanelState({ loadingSources, selectedSource });
  void workspaceIdentity;
  void workspacePath;

  if (loadingSources && !effectiveSource) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
        description={intl.formatMessage({
          id: "settings.usage.codingPlanLoadingDescription",
        })}
      />
    );
  }

  if (!loadingSources && !effectiveSource) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({
          id: "settings.usage.codingPlanCurrentConnectionTitle",
        })}
        description={intl.formatMessage({
          id: "settings.usage.codingPlanCurrentConnectionDescription",
        })}
      />
    );
  }

  return (
    <div className="space-y-5">
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      {loading && !snapshot ? (
        // Coding Plan 来自供应商 monitor API，加载说明要和 App Usage 的本地统计区分。
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.codingPlanLoadingDescription",
          })}
        />
      ) : snapshot ? (
        <>
          <CodingPlanQuotaCards
            quota={effectiveEntitlementSnapshot?.quota ?? snapshot.quota}
            mcpQuotaLimit={resolveMcpQuotaLimit(effectiveEntitlementSnapshot)}
            generatedAt={snapshot.generatedAt}
            sourceKey={effectiveSource?.id}
            preferredProviderId={effectiveProviderId}
            accountAccess={effectiveSource?.accountAccess}
            onEntitlementRefresh={handleResetEntitlementRefresh}
            onUsageStatsRefresh={handleUsageStatsRefresh}
          />
          <CodingPlanActivitySection snapshot={snapshot} />
          <CodingPlanUsageTrendsSection
            range={range}
            snapshot={snapshot}
            onRangeChange={setRange}
          />
        </>
      ) : null}
    </div>
  );
}
