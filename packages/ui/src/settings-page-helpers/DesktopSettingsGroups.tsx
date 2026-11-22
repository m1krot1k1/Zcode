/**
 * 通用设置页的桌面/通知分组与交互行为分组。
 *
 * 从 `GeneralSectionContent` 内联的 SettingsGroupCard 原样拆出；条件分支顺序、
 * 文案 key、test id 与 DOM 结构保持不变。
 */
import type { ZCodeInteractionBehavior } from "@zcode/shared";
import { TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH } from "@zcode/shared/test-ids";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DynamicWorkflowModeSetting } from "@/settings/DynamicWorkflowModeSetting.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type { GeneralSectionContentProps } from "@/settings-page-helpers/generalSectionProps.js";

const ZCODE_INTERACTION_BEHAVIOR_OPTIONS: readonly ZCodeInteractionBehavior[] = ["queue", "guide"];

type LinuxCloseToTrayState = NonNullable<GeneralSectionContentProps["linuxCloseToTray"]>;

export function DesktopAndNotificationsSettingsGroup({
  isDesktop,
  desktopChromiumHardwareAccelerationEnabled,
  onDesktopChromiumHardwareAccelerationChange,
  receivePreviewUpdates,
  onReceivePreviewUpdatesChange,
  autoDownloadAndInstallUpdates,
  onAutoDownloadAndInstallUpdatesChange,
  notificationEnabled,
  setNotificationEnabled,
  notificationSoundEnabled,
  setNotificationSoundEnabled,
  telemetryEnabled,
  setTelemetryEnabled,
  isWindowsDesktop,
  isLinuxDesktop,
  linuxCloseToTray,
  closeToTrayOnWindows,
  onCloseToTrayOnWindowsChange,
  keepAwakeWhileRunning,
  onKeepAwakeWhileRunningChange,
}: {
  isDesktop: boolean;
  desktopChromiumHardwareAccelerationEnabled: boolean;
  onDesktopChromiumHardwareAccelerationChange: (enabled: boolean) => Promise<void>;
  receivePreviewUpdates: boolean;
  onReceivePreviewUpdatesChange: (enabled: boolean) => Promise<void>;
  autoDownloadAndInstallUpdates: boolean;
  onAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
  notificationEnabled: boolean;
  setNotificationEnabled: (enabled: boolean) => void;
  notificationSoundEnabled: boolean;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  telemetryEnabled: boolean;
  setTelemetryEnabled: (enabled: boolean) => void;
  isWindowsDesktop: boolean;
  isLinuxDesktop: boolean;
  linuxCloseToTray?: LinuxCloseToTrayState;
  closeToTrayOnWindows: boolean;
  onCloseToTrayOnWindowsChange: (enabled: boolean) => Promise<void>;
  keepAwakeWhileRunning: boolean;
  onKeepAwakeWhileRunningChange: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      {isDesktop ? (
        <>
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.desktopChromiumHardwareAcceleration",
            })}
            description={intl.formatMessage({
              id: "settings.desktopChromiumHardwareAccelerationDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.desktopChromiumHardwareAcceleration",
                })}
                checked={desktopChromiumHardwareAccelerationEnabled}
                onCheckedChange={(checked) => {
                  void onDesktopChromiumHardwareAccelerationChange(checked);
                }}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.receivePreviewUpdates",
            })}
            description={intl.formatMessage({
              id: "settings.receivePreviewUpdatesDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.receivePreviewUpdates",
                })}
                checked={receivePreviewUpdates}
                onCheckedChange={(checked) => {
                  void onReceivePreviewUpdatesChange(checked);
                }}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.autoDownloadAndInstallUpdates",
            })}
            description={intl.formatMessage({
              id: "settings.autoDownloadAndInstallUpdatesDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.autoDownloadAndInstallUpdates",
                })}
                checked={autoDownloadAndInstallUpdates}
                onCheckedChange={(checked) => {
                  void onAutoDownloadAndInstallUpdatesChange(checked);
                }}
              />
            }
          />
        </>
      ) : null}
      <SettingsRow
        label={intl.formatMessage({ id: "settings.notification" })}
        description={intl.formatMessage({
          id: "settings.notificationDescription",
        })}
        control={<Switch checked={notificationEnabled} onCheckedChange={setNotificationEnabled} />}
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.notificationSound" })}
        description={intl.formatMessage({
          id: "settings.notificationSoundDescription",
        })}
        control={
          <Switch
            checked={notificationSoundEnabled}
            disabled={!notificationEnabled}
            onCheckedChange={setNotificationSoundEnabled}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.telemetryEnabled" })}
        description={intl.formatMessage({
          id: "settings.telemetryEnabledDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.telemetryEnabled" })}
            checked={telemetryEnabled}
            data-testid="settings-telemetry-enabled"
            onCheckedChange={setTelemetryEnabled}
          />
        }
      />
      {isWindowsDesktop || isLinuxDesktop ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.closeToTrayOnWindows" })}
          description={
            linuxCloseToTray?.unavailable
              ? linuxCloseToTray.gnomeLikeHint
                ? `${intl.formatMessage({ id: "settings.closeToTrayUnavailable" })} ${intl.formatMessage({ id: "settings.closeToTrayGnomeHint" })}`
                : intl.formatMessage({
                    id: "settings.closeToTrayUnavailable",
                  })
              : intl.formatMessage({
                  id: "settings.closeToTrayOnWindowsDescription",
                })
          }
          control={
            <Switch
              checked={closeToTrayOnWindows}
              // Linux 上托盘能力未知（探测中）或确认不可用时都锁定，防止误开导致关窗失联
              //（spec：docs/desktop/linux-close-to-tray.md）。
              disabled={Boolean(linuxCloseToTray?.disabled)}
              onCheckedChange={(checked) => {
                void onCloseToTrayOnWindowsChange(checked);
              }}
            />
          }
        />
      ) : null}
      {isDesktop ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.keepAwakeWhileRunning" })}
          description={intl.formatMessage({
            id: "settings.keepAwakeWhileRunningDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.keepAwakeWhileRunning",
              })}
              checked={keepAwakeWhileRunning}
              onCheckedChange={(checked) => {
                void onKeepAwakeWhileRunningChange(checked);
              }}
            />
          }
        />
      ) : null}
    </SettingsGroupCard>
  );
}

export function BehaviorSettingsGroup({
  hasServices,
  zcodeInteractionBehavior,
  onZCodeInteractionBehaviorChange,
  askUserQuestionAutoResolutionEnabled,
  onAskUserQuestionAutoResolutionEnabledChange,
  modelIoFullRetentionEnabled,
  onModelIoFullRetentionEnabledChange,
  messageStreamShowReasoning,
  onMessageStreamShowReasoningChange,
  messageStreamShowTodos,
  onMessageStreamShowTodosChange,
  toolGroupingExploreEnabled,
  onToolGroupingExploreEnabledChange,
  toolGroupingTerminalEnabled,
  onToolGroupingTerminalEnabledChange,
  toolGroupingChangesEnabled,
  onToolGroupingChangesEnabledChange,
}: {
  hasServices: boolean;
  zcodeInteractionBehavior: ZCodeInteractionBehavior;
  onZCodeInteractionBehaviorChange: (behavior: ZCodeInteractionBehavior) => Promise<void>;
  askUserQuestionAutoResolutionEnabled: boolean;
  onAskUserQuestionAutoResolutionEnabledChange: (enabled: boolean) => Promise<void>;
  modelIoFullRetentionEnabled: boolean;
  onModelIoFullRetentionEnabledChange: (enabled: boolean) => Promise<void>;
  messageStreamShowReasoning: boolean;
  onMessageStreamShowReasoningChange: (enabled: boolean) => Promise<void>;
  messageStreamShowTodos: boolean;
  onMessageStreamShowTodosChange: (enabled: boolean) => Promise<void>;
  toolGroupingExploreEnabled: boolean;
  onToolGroupingExploreEnabledChange: (enabled: boolean) => Promise<void>;
  toolGroupingTerminalEnabled: boolean;
  onToolGroupingTerminalEnabledChange: (enabled: boolean) => Promise<void>;
  toolGroupingChangesEnabled: boolean;
  onToolGroupingChangesEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({
          id: "settings.zcodeInteractionBehavior",
        })}
        description={intl.formatMessage({
          id: "settings.zcodeInteractionBehaviorDescription",
        })}
        control={
          <Select
            value={zcodeInteractionBehavior}
            onValueChange={(value) => {
              void onZCodeInteractionBehaviorChange(value as ZCodeInteractionBehavior);
            }}
          >
            <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZCODE_INTERACTION_BEHAVIOR_OPTIONS.map((behavior) => (
                <SelectItem key={behavior} value={behavior}>
                  {intl.formatMessage({
                    id: `settings.zcodeInteractionBehavior.option.${behavior}`,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({
          id: "settings.askUserQuestionAutoResolution",
        })}
        description={intl.formatMessage({
          id: "settings.askUserQuestionAutoResolutionDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.askUserQuestionAutoResolution",
            })}
            checked={askUserQuestionAutoResolutionEnabled}
            data-testid={TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH}
            onCheckedChange={(checked) => {
              void onAskUserQuestionAutoResolutionEnabledChange(checked);
            }}
          />
        }
      />
      {/* docs/dynamic-workflow/launch.md「The user's choice」：服务端未提供时整行不渲染。 */}
      {hasServices ? <DynamicWorkflowModeSetting /> : null}
      <SettingsRow
        label={intl.formatMessage({ id: "settings.modelIoFullRetention" })}
        description={intl.formatMessage({
          id: "settings.modelIoFullRetentionDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.modelIoFullRetention",
            })}
            checked={modelIoFullRetentionEnabled}
            onCheckedChange={(checked) => {
              void onModelIoFullRetentionEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({
          id: "settings.messageStreamShowReasoning",
        })}
        description={intl.formatMessage({
          id: "settings.messageStreamShowReasoningDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.messageStreamShowReasoning",
            })}
            checked={messageStreamShowReasoning}
            onCheckedChange={(checked) => {
              void onMessageStreamShowReasoningChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
        description={intl.formatMessage({
          id: "settings.messageStreamShowTodosDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.messageStreamShowTodos",
            })}
            checked={messageStreamShowTodos}
            onCheckedChange={(checked) => {
              void onMessageStreamShowTodosChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.toolGroupingExplore" })}
        description={intl.formatMessage({
          id: "settings.toolGroupingExploreDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.toolGroupingExplore",
            })}
            checked={toolGroupingExploreEnabled}
            onCheckedChange={(checked) => {
              void onToolGroupingExploreEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.toolGroupingTerminal" })}
        description={intl.formatMessage({
          id: "settings.toolGroupingTerminalDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.toolGroupingTerminal",
            })}
            checked={toolGroupingTerminalEnabled}
            onCheckedChange={(checked) => {
              void onToolGroupingTerminalEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.toolGroupingChanges" })}
        description={intl.formatMessage({
          id: "settings.toolGroupingChangesDescription",
        })}
        control={
          <Switch
            aria-label={intl.formatMessage({
              id: "settings.toolGroupingChanges",
            })}
            checked={toolGroupingChangesEnabled}
            onCheckedChange={(checked) => {
              void onToolGroupingChangesEnabledChange(checked);
            }}
          />
        }
      />
    </SettingsGroupCard>
  );
}
