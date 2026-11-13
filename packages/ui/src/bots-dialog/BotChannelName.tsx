import { getBotProviderRegionTagLabelId, type BotProviderEntryId } from "@/botsUi.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 渠道名称 + 区域标签（如飞书/Lark 的地区提示）。 */
export function BotChannelName({ provider }: { provider: BotProviderEntryId }) {
  const { intl } = useZCodeIntl();
  const regionTagLabelId = getBotProviderRegionTagLabelId(provider);

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: `bots.channel.${provider}` })}
      </span>
      {regionTagLabelId ? (
        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
          {intl.formatMessage({ id: regionTagLabelId })}
        </span>
      ) : null}
    </span>
  );
}
