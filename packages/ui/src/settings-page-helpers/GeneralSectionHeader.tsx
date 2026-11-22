/**
 * 通用设置页头部徽标：展示当前语言偏好。
 *
 * 从 `settingsPageHelpers.tsx` 拆出，渲染内容与 i18n key 不变。
 */
import type { LocalePreference } from "@zcode/shared";
import { SettingsBadge } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function GeneralSectionHeader({ localePreference }: { localePreference: LocalePreference }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <SettingsBadge>
        {intl.formatMessage({ id: `settings.locale.${localePreference}` })}
      </SettingsBadge>
    </div>
  );
}
