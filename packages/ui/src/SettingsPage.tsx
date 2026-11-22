import { SettingsMachinesProvider } from "@/settings/SettingsMachine.js";
import { useEffect } from "react";
import type { UserInfo } from "@zcode/shared";
import { TID_SETTINGS_PAGE } from "@zcode/shared/test-ids";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { cn } from "@/components/lib/utils.js";
import { resolveSettingsSectionForPlatform, GeneralSectionHeader } from "@/settingsPageHelpers.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { shouldFallbackSettingsUsageTabToApp } from "@/lib/settingsNavigation.js";
import type { CreateTaskRequest, RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";
import { SettingsSidebar } from "./settings-page/SettingsSidebar.js";
import { SettingsSectionContent } from "./settings-page/SettingsSectionContent.js";
import { SettingsUsageProviderTabs } from "./settings-page/SettingsUsageProviderTabs.js";
import { useSettingsFormState } from "./settings-page/useSettingsFormState.js";
import { useSettingsPagePreferenceHandlers } from "./settings-page/useSettingsPagePreferenceHandlers.js";
import { useSettingsPageRuntime } from "./settings-page/useSettingsPageRuntime.js";
import { useSettingsPageSettingsHandlers } from "./settings-page/useSettingsPageSettingsHandlers.js";
import { useSettingsPageShell } from "./settings-page/useSettingsPageShell.js";
import { useSettingsPageWorkspace } from "./settings-page/useSettingsPageWorkspace.js";
import { useSettingsUsageSources } from "./settings-page/useSettingsUsageSources.js";

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isWebRemoteControl = false,
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace: _onOpenWorkspace,
  onOpenRemoteWorkspace,
  allowOpenWorkspace: _allowOpenWorkspace = true,
  onLogin,
  onLogout,
  user,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
  /** 远程设备卡「新任务」：激活该设备已打开的 tab 并开新草稿（Root 注入）。 */
  allowOpenWorkspace?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}) {
  const shell = useSettingsPageShell({ isDesktop, isWindowsDesktop, isMacDesktop });
  const { activeSection, settingsSections, intl, localePreference, pluginNavigationOrigin } = shell;
  const usage = useSettingsUsageSources(activeSection);
  const workspace = useSettingsPageWorkspace({
    activeSection,
    isDesktop,
    setActiveSection: shell.setActiveSection,
  });
  const form = useSettingsFormState({ isWindowsDesktop });

  useEffect(() => {
    if (
      !shouldFallbackSettingsUsageTabToApp({
        activeTab: usage.activeTab === "app" ? "app" : "codingPlan",
        checkingCodingPlanTab: usage.checkingCodingPlanTab,
        loadingModelProviders: usage.providerSettingsLoading,
        showCodingPlanTab: usage.showCodingPlanTab,
      })
    ) {
      return;
    }

    // 剩余额度入口会先写入 Coding Plan tab 意图，再打开设置页。
    // 如果首帧 provider/entitlement 仍在加载就立刻回退，会让“更多”看起来只打开了 App Usage。
    // 这里等数据确认没有套餐后再回退，避免空入口误导用户。
    usage.setActiveTab("app");
  }, [
    usage.checkingCodingPlanTab,
    usage.showCodingPlanTab,
    usage.subscribedTeamProductsCount,
    usage.activeTab,
    usage.providerSettingsLoading,
    usage.setActiveTab,
  ]);

  useSettingsPageRuntime({ shell, usage, workspace, form, isWindowsDesktop });
  const settingsHandlers = useSettingsPageSettingsHandlers({ shell, workspace, form });
  const preferenceHandlers = useSettingsPagePreferenceHandlers({ shell, workspace, form });

  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  useEffect(() => {
    shell.setActiveSection((current) =>
      resolveSettingsSectionForPlatform(current, settingsSections),
    );
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    shell.settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? shell.settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");

  return (
    <>
      <DesktopWindowFrame
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className="relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)]"
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {shell.usesInlineWindowControls ? (
            <div
              className={cn(
                "absolute z-30 mt-px mr-px flex h-12 items-center gap-0.5 px-2 pointer-events-auto [app-region:no-drag]",
                // 外沿留白变化后，悬浮操作组也必须同步，否则与内容 Header 错位。
                isWindowsDesktop ? "right-1.5 top-1.5" : "right-1 top-1",
              )}
            >
              {/* Bug 原因：Windows/Linux 设置页仍保留旧 caption 下箭头，与主界面和 macOS 的帮助入口不一致。
                  统一复用问号帮助按钮，并让它在普通 flex 流中紧邻自绘窗控。
                  Settings 的独立标题层还需计入 4px 外层留白和 1px 边框，才能与 Workspace 控制组对齐。 */}
              <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />
              <DesktopWindowControls />
            </div>
          ) : null}

          <SettingsSidebar
            settingsSectionGroups={shell.settingsSectionGroups}
            activeSection={activeSection}
            isDesktop={isDesktop}
            remoteDevicesPresentation={workspace.remoteDevicesPresentation}
            pluginNavigationOrigin={pluginNavigationOrigin}
            onBack={onBack}
            onRequestOnboarding={workspace.requestOnboardingDialog}
            onSelectSection={(section) => {
              shell.setPluginNavigationOrigin(undefined);
              shell.setTargetSourceServerId(undefined);
              shell.setSettingsSectionNavigationVersion((version) => version + 1);
              workspace.setActiveSettingsSection(section);
            }}
            theme={shell.theme}
            localePreference={localePreference}
            onLocaleChange={preferenceHandlers.handleFooterLocaleChange}
            onThemeChange={preferenceHandlers.handleFooterThemeChange}
            onOpenUsageSettings={workspace.handleOpenUsageSettings}
            onOpenCodingPlanUpgrade={workspace.handleOpenCodingPlanUpgradeSettings}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
          />

          <section
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              isDesktop ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            )}
          >
            <div
              data-settings-top-inset={isDesktop ? "true" : undefined}
              // 下方面板使用 h-full；顶部留白不能参与 flex 收缩，否则 6px 会变成小数像素。
              className={cn(
                "shrink-0 [app-region:drag]",
                isDesktop && (isWindowsDesktop ? "h-1.5" : "h-1"),
                isMacDesktop && "max-lg:h-16",
              )}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "relative flex flex-col min-h-0 h-full border border-border bg-background",
                // 直接写像素圆角会绕过设计 token；设置页与工作区统一复用 rounded-md（默认 6px）。
                isWindowsDesktop ? "rounded-md" : "rounded-xl",
              )}
            >
              {!shell.usesInlineWindowControls ? (
                <div
                  className={cn(
                    // Settings 使用和 new task 一致的问号定位：在内容面板内定位，外层让出自绘窗口按钮区，内层保持 top-2.5/right-2.5。
                    "absolute top-0 z-50 h-10 w-10 pointer-events-auto [app-region:no-drag]",
                    "right-0",
                  )}
                >
                  <div className="absolute right-2.5 top-2.5 pointer-events-auto [app-region:no-drag]">
                    <WorkspaceHelpMenuButton
                      className="relative z-50 [app-region:no-drag]"
                      isDesktop={Boolean(isDesktop)}
                    />
                  </div>
                </div>
              ) : null}
              <SettingsBreadcrumbProvider
                onItemsChange={shell.setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角帮助/窗口按钮命中区域重叠；
                      // 这里把右侧按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      // Windows/Linux 设置页共同避开右上角菜单与内联窗控组。

                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 四个 28px 按钮、组内 2px 间距和左右 8px padding，共 134px。
                        shell.usesInlineWindowControls ? "mr-[134px]" : "mr-12",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <SettingsMachinesProvider
                    servers={workspace.sourceManagementSnapshot?.servers ?? []}
                  >
                    <main
                      className={cn(
                        "min-h-0 flex-1 [scrollbar-gutter:stable]",
                        activeSection === "codeGraph"
                          ? "overflow-y-auto lg:overflow-hidden"
                          : "overflow-y-auto",
                      )}
                    >
                      <div
                        className={cn(
                          activeSection === "codeGraph"
                            ? "min-h-full w-full max-w-none px-3 pb-3 pt-0 lg:h-full"
                            : SETTINGS_FRAME_CONTENT_CLASSNAME,
                          "flex flex-col",
                          activeSection === "codeGraph" ? "gap-0" : "gap-8",
                          isMacDesktop && activeSection !== "codeGraph" && "pt-0",
                        )}
                      >
                        {/* 归档设置迁入后也需要公共页头，不能再因列表自带标题而隐藏页面标题。 */}
                        <div className={cn(activeSection === "codeGraph" && "hidden")}>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                              {showActiveSectionTitle ? (
                                <h2 className="text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
                                  {activeSectionLabel}
                                </h2>
                              ) : null}
                              {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                                <span className="inline-flex h-6 items-center rounded-md border border-border px-2 text-ui-xs font-semibold tracking-normal text-foreground">
                                  {intl.formatMessage({
                                    id: activeSectionMeta.titleBadgeId,
                                  })}
                                </span>
                              ) : null}
                              {activeSection === "usage" ? (
                                <SettingsUsageProviderTabs
                                  activeTab={usage.activeTab}
                                  codingPlanSources={usage.codingPlanSources}
                                  onTabChange={usage.handleTabSelect}
                                />
                              ) : null}
                            </div>
                          </div>
                          {activeSection === "general" ? (
                            <GeneralSectionHeader localePreference={localePreference} />
                          ) : null}
                        </div>
                        <SettingsSectionContent
                          activeSection={activeSection}
                          isDesktop={isDesktop}
                          isMacDesktop={isMacDesktop}
                          isWindowsDesktop={isWindowsDesktop}
                          isWebRemoteControl={isWebRemoteControl}
                          captionWorkspacePath={captionWorkspacePath}
                          onBack={onBack}
                          onCreateTask={onCreateTask}
                          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
                          shell={shell}
                          usage={usage}
                          workspace={workspace}
                          form={form}
                          settingsHandlers={settingsHandlers}
                          preferenceHandlers={preferenceHandlers}
                        />
                      </div>
                    </main>
                  </SettingsMachinesProvider>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
      </DesktopWindowFrame>
    </>
  );
}
