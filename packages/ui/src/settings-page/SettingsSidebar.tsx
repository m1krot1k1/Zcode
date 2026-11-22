// SettingsPage 拆分（max-lines）：左侧导航（分组、情绪入口、返回按钮与头像 footer）。
// 导航/返回/引导的 telemetry 包装保持在原位置，DOM 结构与拆分前一致。
import { ArrowLeft, Rocket } from "lucide-react";
import type { UserInfo } from "@zcode/shared";
import { TID_SETTINGS_BACK_BUTTON, TID_SETTINGS_SECTION_NAV, testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import type {
  SettingsPluginNavigationOrigin,
  SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionNavigationPresentation } from "@/lib/remoteConnectionPresentation.js";
import { isSettingsSectionAvailable } from "@/settingsPageHelpers.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import type { Theme } from "@/useTheme.js";
import { SettingsSidebarButton } from "./SettingsSidebarButton.js";
import type { SettingsSectionGroup } from "./types.js";

export interface SettingsSidebarProps {
  settingsSectionGroups: SettingsSectionGroup[];
  activeSection: SettingsSectionId;
  isDesktop?: boolean;
  remoteDevicesPresentation: ReturnType<typeof resolveRemoteConnectionNavigationPresentation>;
  pluginNavigationOrigin: SettingsPluginNavigationOrigin | undefined;
  onBack?: () => void;
  onRequestOnboarding: () => void;
  onSelectSection: (section: SettingsSectionId) => void;
  theme: Theme;
  localePreference: ReturnType<typeof useZCodeIntl>["localePreference"];
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onOpenUsageSettings: () => void;
  onOpenCodingPlanUpgrade: (providerId: string, funnelContext?: CodingPlanFunnelContext) => void;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}

export function SettingsSidebar({
  settingsSectionGroups,
  activeSection,
  isDesktop,
  remoteDevicesPresentation,
  pluginNavigationOrigin,
  onBack,
  onRequestOnboarding,
  onSelectSection,
  theme,
  localePreference,
  onLocaleChange,
  onThemeChange,
  onOpenUsageSettings,
  onOpenCodingPlanUpgrade,
  onLogin,
  onLogout,
  user,
}: SettingsSidebarProps) {
  const { intl } = useZCodeIntl();

  return (
    <aside className="min-w-0">
      <div className="flex h-full flex-col">
        <div className="h-12 [app-region:drag]"></div>
        <div className="px-2 pb-3 pt-3">
          {onBack ? (
            <ControlHintTooltip
              title={intl.formatMessage({
                id: "workspace.backToWorkspace",
              })}
              side="right"
              align="center"
            >
              <Button
                type="button"
                variant="ghost"
                size="lg"
                data-testid={TID_SETTINGS_BACK_BUTTON}
                aria-label={intl.formatMessage({
                  id: "workspace.backToWorkspace",
                })}
                className="m-1 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl bg-surface px-1.5 text-remote-foreground-muted hover:bg-surface-hover hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                onClick={() => {
                  runUserAction({
                    input: {
                      featureId: "settings.navigation",
                      action: "back_to_workspace",
                      trigger: "button",
                    },
                    operation: () => {
                      if (pluginNavigationOrigin === "plugin-store") {
                        requestPluginStoreOpen("user");
                      }
                      onBack?.();
                    },
                    completed: { resultSource: "local_commit" },
                    failureStage: "navigation_commit",
                  });
                }}
              >
                <ArrowLeft className="size-4" />
                <span className="max-lg:sr-only">
                  {intl.formatMessage({
                    id: "workspace.backToWorkspace",
                  })}
                </span>
              </Button>
            </ControlHintTooltip>
          ) : null}
        </div>

        <nav
          aria-label={intl.formatMessage({ id: "settings.navLabel" })}
          className="flex-1 overflow-y-auto px-2 pb-3"
        >
          <div className="space-y-4">
            {settingsSectionGroups.map((group, groupIndex) => {
              const groupLabel = intl.formatMessage({
                id: group.titleId,
              });
              const groupLabelId = `settings-sidebar-group-${group.id}`;

              return (
                <div
                  key={group.id}
                  role="group"
                  aria-labelledby={groupLabelId}
                  className={cn(
                    "space-y-1",
                    groupIndex > 0 && "max-lg:border-t max-lg:border-border max-lg:pt-3",
                  )}
                >
                  <div
                    id={groupLabelId}
                    className="px-2.5 pb-1 text-ui-sm font-medium text-remote-foreground-muted max-lg:sr-only"
                  >
                    {groupLabel}
                  </div>
                  {group.sections
                    .filter(({ id }) => isSettingsSectionAvailable(id, Boolean(isDesktop)))
                    .map(({ id, icon: Icon, titleId }) => {
                      const isActive = activeSection === id;
                      const label = intl.formatMessage({ id: titleId });

                      return (
                        <SettingsSidebarButton
                          key={id}
                          icon={Icon}
                          label={label}
                          active={isActive}
                          aria-current={isActive ? "page" : undefined}
                          data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                          data-settings-section-nav={id}
                          onClick={() => {
                            runUserAction({
                              input: {
                                featureId: "settings.navigation",
                                action: "open_section",
                                trigger: "button",
                              },
                              operation: () => {
                                onSelectSection(id);
                              },
                              completed: { resultSource: "local_commit", sectionId: id },
                              failureStage: "navigation_commit",
                            });
                          }}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="truncate text-ui-base text-foreground">{label}</span>
                            {id === "remoteDevices" ? (
                              <RemoteConnectionNavigationDot
                                presentation={remoteDevicesPresentation}
                              />
                            ) : null}
                          </span>
                        </SettingsSidebarButton>
                      );
                    })}
                </div>
              );
            })}
          </div>

          <SettingsSidebarButton
            icon={Rocket}
            label={intl.formatMessage({ id: "settings.onboarding" })}
            className="mt-4 border border-dashed border-border hover:border-border-hover"
            onClick={() => {
              runUserAction({
                input: {
                  featureId: "settings.navigation",
                  action: "open_onboarding",
                  trigger: "button",
                },
                operation: onRequestOnboarding,
                completed: { resultSource: "local_commit" },
                failureStage: "dialog_open",
              });
            }}
          >
            <span className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "settings.onboarding" })}
            </span>
          </SettingsSidebarButton>
        </nav>

        <div className="max-lg:hidden">
          <WorkspaceSidebarFooter
            theme={theme}
            localeMenuValue={localePreference}
            onLocaleChange={onLocaleChange}
            onThemeChange={onThemeChange}
            onSettingsButtonClick={onBack}
            onUsageClick={onOpenUsageSettings}
            onUpgradeClick={onOpenCodingPlanUpgrade}
            onLogin={onLogin}
            onLogout={onLogout}
            settingsButtonMode="back"
            user={user}
            // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
            // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
            isDesktop={isDesktop}
          />
        </div>
      </div>
    </aside>
  );
}
