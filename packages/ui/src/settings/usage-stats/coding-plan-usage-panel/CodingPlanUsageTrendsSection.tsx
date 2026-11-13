import type { CodingPlanUsageSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CodingPlanHealthSection } from "./CodingPlanHealthSection.js";
import { CodingPlanUsageDetailSection } from "./CodingPlanUsageDetailSection.js";
import { SegmentedTabs } from "./SegmentedTabs.js";
import type { CodingPlanUsageTrendRange } from "./types.js";

const CODING_PLAN_USAGE_TRENDS_SECTION_ID = "coding-plan-usage-trends";

export function CodingPlanUsageTrendsSection({
  range,
  snapshot,
  onRangeChange,
}: {
  range: CodingPlanUsageTrendRange;
  snapshot: CodingPlanUsageSnapshot;
  onRangeChange: (range: CodingPlanUsageTrendRange) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section id={CODING_PLAN_USAGE_TRENDS_SECTION_ID} className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.trendsTitle" })}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <CodingPlanRangeSelector
            range={range}
            onRangeChange={onRangeChange}
          />
        </div>
      </div>
      <CodingPlanUsageDetailSection snapshot={snapshot} />
      <CodingPlanHealthSection snapshot={snapshot} />
    </section>
  );
}

function CodingPlanRangeSelector({
  range,
  onRangeChange,
}: {
  range: CodingPlanUsageTrendRange;
  onRangeChange: (range: CodingPlanUsageTrendRange) => void;
}) {
  const options: CodingPlanUsageTrendRange[] = ["7d", "30d"];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedTabs
        value={range}
        options={options}
        labelIdPrefix="settings.usage.codingPlanRange"
        onChange={(value) => onRangeChange(value as CodingPlanUsageTrendRange)}
      />
    </div>
  );
}
