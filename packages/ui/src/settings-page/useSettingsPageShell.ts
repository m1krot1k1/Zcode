// SettingsPage 拆分（max-lines）：页面外壳状态（分区选择、插件导航意图、Linux 托盘能力、全局 store 选择器）。
// 钩子调用顺序与拆分前一致：Linux 托盘探测 → 营销跳转 → 插件来源清理。
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useStore } from "zustand";
import type { DesktopCloseToTrayCapability } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { ZCodeState } from "@/store/index.js";
import type { SettingsBreadcrumbItem } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
} from "@/settingsPageHelpers.js";
import {
  marketingNavigation,
  finishMarketingNavigation,
  marketingSettingsSections,
} from "@/lib/marketingNavigation.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import {
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsSourceServerId,
  writeLastSettingsSectionPreference,
  type SettingsPluginNavigationOrigin,
  type SettingsPluginTabTarget,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import type { SettingsSectionGroup } from "./types.js";

export interface SettingsPageShellOptions {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
}

export interface SettingsPageShellState {
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  localePreference: ReturnType<typeof useZCodeIntl>["localePreference"];
  setLocalePreference: ReturnType<typeof useZCodeIntl>["setLocalePreference"];
  settingsSectionGroups: SettingsSectionGroup[];
  settingsSections: ReturnType<typeof createSettingsPageConfig>["settingsSections"];
  isLinuxDesktop: boolean;
  usesInlineWindowControls: boolean;
  platform: ReturnType<typeof usePlatform>;
  remoteWorkspaceController: ReturnType<typeof useOptionalRemoteWorkspaceController>;
  activeSection: SettingsSectionId;
  setActiveSection: Dispatch<SetStateAction<SettingsSectionId>>;
  targetSourceServerId: string | undefined;
  setTargetSourceServerId: Dispatch<SetStateAction<string | undefined>>;
  targetSourceServerDetails: boolean;
  setTargetSourceServerDetails: Dispatch<SetStateAction<boolean>>;
  pluginTab: SettingsPluginTabTarget | undefined;
  setPluginTab: Dispatch<SetStateAction<SettingsPluginTabTarget | undefined>>;
  linuxCloseToTray:
    | {
        disabled: boolean;
        unavailable: boolean;
        gnomeLikeHint: boolean;
      }
    | undefined;
  pluginNavigationOrigin: SettingsPluginNavigationOrigin | undefined;
  setPluginNavigationOrigin: Dispatch<SetStateAction<SettingsPluginNavigationOrigin | undefined>>;
  pluginScopeKey: string | undefined;
  setPluginScopeKey: Dispatch<SetStateAction<string | undefined>>;
  settingsSectionNavigationVersion: number;
  setSettingsSectionNavigationVersion: Dispatch<SetStateAction<number>>;
  settingsBreadcrumbItems: readonly SettingsBreadcrumbItem[];
  setSettingsBreadcrumbItems: Dispatch<SetStateAction<readonly SettingsBreadcrumbItem[]>>;
  interfaceMode: ZCodeState["interfaceMode"];
  setInterfaceMode: ZCodeState["setInterfaceMode"];
  theme: ZCodeState["theme"];
  setTheme: ZCodeState["setTheme"];
  codePreviewSettings: ZCodeState["codePreviewSettings"];
  setCodePreviewSettings: ZCodeState["setCodePreviewSettings"];
  uiFontSizePx: ZCodeState["uiFontSizePx"];
  setUiFontSizePx: ZCodeState["setUiFontSizePx"];
  notificationEnabled: ZCodeState["notificationEnabled"];
  setNotificationEnabled: ZCodeState["setNotificationEnabled"];
  notificationSoundEnabled: ZCodeState["notificationSoundEnabled"];
  setNotificationSoundEnabled: ZCodeState["setNotificationSoundEnabled"];
}

export function useSettingsPageShell({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
}: SettingsPageShellOptions): SettingsPageShellState {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () =>
      createSettingsPageConfig({
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop],
  );
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  const remoteWorkspaceController = useOptionalRemoteWorkspaceController();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  const [targetSourceServerId, setTargetSourceServerId] = useState(
    consumePendingSettingsSourceServerId,
  );
  const [targetSourceServerDetails, setTargetSourceServerDetails] = useState(
    consumePendingSettingsSourceServerDetails,
  );
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  // Linux 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）：打开设置页时
  // 经 platform IPC 触发 main 侧探测（带 stale 缓存），用户装完 AppIndicator 扩展重开
  // 设置页即可解除置灰；Web/远控无桥不查询。
  const [linuxCloseToTrayCapability, setLinuxCloseToTrayCapability] =
    useState<DesktopCloseToTrayCapability | null>(null);
  useEffect(() => {
    if (!isLinuxDesktop) {
      return;
    }
    let cancelled = false;
    platform
      .getCloseToTrayCapability?.()
      .then((capability) => {
        if (!cancelled) {
          setLinuxCloseToTrayCapability(capability);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, platform]);
  const linuxCloseToTray = isLinuxDesktop
    ? {
        // 探测中按不可用锁定，防止查询完成前误开导致关窗失联
        disabled: linuxCloseToTrayCapability === null || !linuxCloseToTrayCapability.supported,
        unavailable: linuxCloseToTrayCapability?.supported === false,
        gnomeLikeHint:
          linuxCloseToTrayCapability?.supported === false &&
          linuxCloseToTrayCapability.gnomeLikeWithoutTray,
      }
    : undefined;
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings") return;
    const target = marketingRequest.target;
    const section = target.section ? marketingSettingsSections[target.section] : activeSection;
    if (!settingsSections.some((item) => item.id === section)) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
    } else if (activeSection === section && !target.provider_id) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [activeSection, marketingRequest, settingsSections]);
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const theme = useZCodeStore((state) => state.theme);
  const setTheme = useZCodeStore((state) => state.setTheme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useZCodeStore((state) => state.setCodePreviewSettings);
  const uiFontSizePx = useZCodeStore((state) => state.uiFontSizePx);
  const setUiFontSizePx = useZCodeStore((state) => state.setUiFontSizePx);
  const notificationEnabled = useZCodeStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useZCodeStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useZCodeStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useZCodeStore((state) => state.setNotificationSoundEnabled);

  return {
    intl,
    localePreference,
    setLocalePreference,
    settingsSectionGroups,
    settingsSections,
    isLinuxDesktop,
    usesInlineWindowControls,
    platform,
    remoteWorkspaceController,
    activeSection,
    setActiveSection,
    targetSourceServerId,
    setTargetSourceServerId,
    targetSourceServerDetails,
    setTargetSourceServerDetails,
    pluginTab,
    setPluginTab,
    linuxCloseToTray,
    pluginNavigationOrigin,
    setPluginNavigationOrigin,
    pluginScopeKey,
    setPluginScopeKey,
    settingsSectionNavigationVersion,
    setSettingsSectionNavigationVersion,
    settingsBreadcrumbItems,
    setSettingsBreadcrumbItems,
    interfaceMode,
    setInterfaceMode,
    theme,
    setTheme,
    codePreviewSettings,
    setCodePreviewSettings,
    uiFontSizePx,
    setUiFontSizePx,
    notificationEnabled,
    setNotificationEnabled,
    notificationSoundEnabled,
    setNotificationSoundEnabled,
  };
}
