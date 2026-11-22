/**
 * 归档偏好设置分组：开关 + 归档时长下拉。
 *
 * 从 `settingsPageHelpers.tsx` 拆出，设置值与保存动作仍由 SettingsPage 持有，
 * 组件只负责渲染，公开展示行为不变。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const TASK_AUTO_ARCHIVE_DAY_OPTIONS = [3, 7, 14, 30] as const;

/**
 * 归档偏好与归档列表集中展示，设置值和保存动作继续由 SettingsPage 持有。
 * Bugfix：关闭时禁用时长会迫使用户先开启归档，旧阈值可能立即生效；允许先保存时长再开启。
 */
export function TaskAutoArchiveSettings({
  taskAutoArchiveEnabled,
  taskAutoArchiveOlderThanDays,
  onTaskAutoArchiveEnabledChange,
  onTaskAutoArchiveOlderThanDaysChange,
}: {
  taskAutoArchiveEnabled: boolean;
  taskAutoArchiveOlderThanDays: number;
  onTaskAutoArchiveEnabledChange: (enabled: boolean) => Promise<void>;
  onTaskAutoArchiveOlderThanDaysChange: (days: number) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDescription",
        })}
        control={
          <Switch
            data-testid="archive-auto-archive-switch"
            aria-label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
            checked={taskAutoArchiveEnabled}
            onCheckedChange={(checked) => {
              void onTaskAutoArchiveEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchiveDays" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDaysDescription",
        })}
        control={
          <Select
            value={String(taskAutoArchiveOlderThanDays)}
            onValueChange={(value) => {
              void onTaskAutoArchiveOlderThanDaysChange(Number(value));
            }}
          >
            <SelectTrigger
              data-testid="archive-auto-archive-days"
              aria-label={intl.formatMessage({
                id: "settings.taskAutoArchiveDays",
              })}
              size="lg"
              className="w-full min-w-0 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {intl.formatMessage({
                    id: `settings.taskAutoArchiveDays.option.${days}`,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}
