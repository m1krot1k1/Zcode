import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
} from "@/settings/usage-stats/usageStatsUiParts.js";

export function SegmentedTabs<T extends string>({
  value,
  options,
  labelIdPrefix,
  onChange,
}: {
  value: T;
  options: T[];
  labelIdPrefix: string;
  onChange: (value: T) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)}>
      <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
        {options.map((option) => (
          <TabsTrigger
            key={option}
            value={option}
            className={USAGE_STATS_TABS_TRIGGER_CLASS}
          >
            {intl.formatMessage({ id: `${labelIdPrefix}.${option}` })}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
