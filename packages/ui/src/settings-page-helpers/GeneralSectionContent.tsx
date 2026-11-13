/**
 * 通用设置页内容编排：应用 props 缺省值，聚合终端/代理视图模型，按原顺序渲染分组。
 *
 * 从 `settingsPageHelpers.tsx` 拆出；props 契约见 `generalSectionProps.ts`，
 * 视图分组见 `GeneralSettingsGroups.tsx` / `DesktopSettingsGroups.tsx`，
 * 代理卡片与弹窗见 `HttpProxySettingsSection.tsx` / `HttpProxyManagerDialog.tsx`。
 * hook 调用顺序与拆分前一致（终端 -> 代理），DOM 顺序、文案与 test id 不变。
 */
import { useOptionalServices } from "@/hooks/useServices.js";
import {
  BehaviorSettingsGroup,
  DesktopAndNotificationsSettingsGroup,
} from "@/settings-page-helpers/DesktopSettingsGroups.js";
import type { GeneralSectionContentProps } from "@/settings-page-helpers/generalSectionProps.js";
import {
  DataBaseDirSettingsGroup,
  GeneralLocaleSettingsGroup,
  InterfaceModeSettingsGroup,
  OnboardingSettingsGroup,
  RunLimitsSettingsGroup,
  TerminalAndToolsSettingsGroup,
  TerminalSettingsGroup,
} from "@/settings-page-helpers/GeneralSettingsGroups.js";
import { HttpProxySettingsSection } from "@/settings-page-helpers/HttpProxySettingsSection.js";
import type { RunLimitSaveResult } from "@/settings-page-helpers/RunLimitSettingRow.js";
import { useHttpProxySettings } from "@/settings-page-helpers/useHttpProxySettings.js";
import { useTerminalSettings } from "@/settings-page-helpers/useTerminalSettings.js";

export function GeneralSectionContent({
  localePreference,
  interfaceMode = "coding",
  setInterfaceMode = () => {},
  notificationEnabled,
  notificationSoundEnabled,
  telemetryEnabled = true,
  setTelemetryEnabled = () => {},
  closeToTrayOnWindows,
  keepAwakeWhileRunning = false,
  desktopChromiumHardwareAccelerationEnabled = true,
  receivePreviewUpdates,
  autoDownloadAndInstallUpdates,
  dataBaseDir,
  terminalInheritSystemProfile = true,
  terminalFontFamily = "",
  integratedTerminalShell = { mode: "auto" },
  integratedTerminalShellOptions = [],
  toolSearchMode = "off",
  workspaceBoundary = "allow",
  onWorkspaceBoundaryChange = () => {},
  onToolSearchModeChange,
  nativeSearchEnhancementsEnabled,
  httpProxy = "",
  httpProxyList = "",
  httpProxyNoProxy = "",
  httpProxyCaCertPath = "",
  subagentMaxParallel,
  subagentTaskTimeoutMinutes,
  defaultHomeDir,
  isDesktop,
  platform,
  isWindowsDesktop,
  isLinuxDesktop,
  linuxCloseToTray,
  showIntegratedTerminalShell = false,
  setLocalePreference,
  setNotificationEnabled,
  setNotificationSoundEnabled,
  messageStreamShowReasoning,
  messageStreamShowTodos,
  toolGroupingExploreEnabled,
  toolGroupingTerminalEnabled,
  toolGroupingChangesEnabled,
  zcodeInteractionBehavior,
  askUserQuestionAutoResolutionEnabled = true,
  modelIoFullRetentionEnabled = false,
  onDataBaseDirChange,
  onSelectDataBaseDir,
  onTerminalInheritSystemProfileChange = async () => {},
  onTerminalFontFamilyChange = async () => {},
  onIntegratedTerminalShellChange = async () => {},
  onNativeSearchEnhancementsEnabledChange,
  onHttpProxyChange = async () => {},
  onHttpProxyListChange = async () => {},
  onHttpProxyNoProxyChange = async () => {},
  onHttpProxyCaCertPathChange = async () => {},
  onSubagentMaxParallelChange = async (): Promise<RunLimitSaveResult> => "saved",
  onSubagentTaskTimeoutMinutesChange = async (): Promise<RunLimitSaveResult> => "saved",
  onCloseToTrayOnWindowsChange,
  onKeepAwakeWhileRunningChange = async () => {},
  onDesktopChromiumHardwareAccelerationChange = async () => {},
  onReceivePreviewUpdatesChange,
  onAutoDownloadAndInstallUpdatesChange,
  onMessageStreamShowReasoningChange,
  onMessageStreamShowTodosChange,
  onToolGroupingExploreEnabledChange,
  onToolGroupingTerminalEnabledChange,
  onToolGroupingChangesEnabledChange,
  onZCodeInteractionBehaviorChange,
  onAskUserQuestionAutoResolutionEnabledChange = async () => {},
  onModelIoFullRetentionEnabledChange = async () => {},
  onOpenOnboardingDialog,
}: GeneralSectionContentProps) {
  const hasServices = Boolean(useOptionalServices());
  const terminal = useTerminalSettings({
    integratedTerminalShell,
    integratedTerminalShellOptions,
    onIntegratedTerminalShellChange,
    onTerminalFontFamilyChange,
    terminalFontFamily,
  });
  const proxy = useHttpProxySettings({
    httpProxy,
    httpProxyCaCertPath,
    httpProxyList,
    httpProxyNoProxy,
    onHttpProxyCaCertPathChange,
    onHttpProxyChange,
    onHttpProxyListChange,
    onHttpProxyNoProxyChange,
    platform,
  });

  return (
    <div className="space-y-4">
      <GeneralLocaleSettingsGroup
        localePreference={localePreference}
        setLocalePreference={setLocalePreference}
      />

      <InterfaceModeSettingsGroup
        interfaceMode={interfaceMode}
        setInterfaceMode={setInterfaceMode}
        hasServices={hasServices}
      />

      <TerminalSettingsGroup
        terminalInheritSystemProfile={terminalInheritSystemProfile}
        onTerminalInheritSystemProfileChange={onTerminalInheritSystemProfileChange}
        terminal={terminal}
      />

      <TerminalAndToolsSettingsGroup
        showIntegratedTerminalShell={showIntegratedTerminalShell}
        terminal={terminal}
        workspaceBoundary={workspaceBoundary}
        onWorkspaceBoundaryChange={onWorkspaceBoundaryChange}
        toolSearchMode={toolSearchMode}
        onToolSearchModeChange={onToolSearchModeChange}
        nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
        onNativeSearchEnhancementsEnabledChange={onNativeSearchEnhancementsEnabledChange}
      />

      <HttpProxySettingsSection
        proxy={proxy}
        httpProxy={httpProxy}
        httpProxyList={httpProxyList}
        platform={platform}
        onHttpProxyChange={onHttpProxyChange}
      />

      <RunLimitsSettingsGroup
        subagentMaxParallel={subagentMaxParallel}
        onSubagentMaxParallelChange={onSubagentMaxParallelChange}
        subagentTaskTimeoutMinutes={subagentTaskTimeoutMinutes}
        onSubagentTaskTimeoutMinutesChange={onSubagentTaskTimeoutMinutesChange}
      />

      <DesktopAndNotificationsSettingsGroup
        isDesktop={Boolean(isDesktop)}
        desktopChromiumHardwareAccelerationEnabled={desktopChromiumHardwareAccelerationEnabled}
        onDesktopChromiumHardwareAccelerationChange={onDesktopChromiumHardwareAccelerationChange}
        receivePreviewUpdates={receivePreviewUpdates}
        onReceivePreviewUpdatesChange={onReceivePreviewUpdatesChange}
        autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
        onAutoDownloadAndInstallUpdatesChange={onAutoDownloadAndInstallUpdatesChange}
        notificationEnabled={notificationEnabled}
        setNotificationEnabled={setNotificationEnabled}
        notificationSoundEnabled={notificationSoundEnabled}
        setNotificationSoundEnabled={setNotificationSoundEnabled}
        telemetryEnabled={telemetryEnabled}
        setTelemetryEnabled={setTelemetryEnabled}
        isWindowsDesktop={Boolean(isWindowsDesktop)}
        isLinuxDesktop={Boolean(isLinuxDesktop)}
        linuxCloseToTray={linuxCloseToTray}
        closeToTrayOnWindows={closeToTrayOnWindows}
        onCloseToTrayOnWindowsChange={onCloseToTrayOnWindowsChange}
        keepAwakeWhileRunning={keepAwakeWhileRunning}
        onKeepAwakeWhileRunningChange={onKeepAwakeWhileRunningChange}
      />

      <BehaviorSettingsGroup
        hasServices={hasServices}
        zcodeInteractionBehavior={zcodeInteractionBehavior}
        onZCodeInteractionBehaviorChange={onZCodeInteractionBehaviorChange}
        askUserQuestionAutoResolutionEnabled={askUserQuestionAutoResolutionEnabled}
        onAskUserQuestionAutoResolutionEnabledChange={onAskUserQuestionAutoResolutionEnabledChange}
        modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
        onModelIoFullRetentionEnabledChange={onModelIoFullRetentionEnabledChange}
        messageStreamShowReasoning={messageStreamShowReasoning}
        onMessageStreamShowReasoningChange={onMessageStreamShowReasoningChange}
        messageStreamShowTodos={messageStreamShowTodos}
        onMessageStreamShowTodosChange={onMessageStreamShowTodosChange}
        toolGroupingExploreEnabled={toolGroupingExploreEnabled}
        onToolGroupingExploreEnabledChange={onToolGroupingExploreEnabledChange}
        toolGroupingTerminalEnabled={toolGroupingTerminalEnabled}
        onToolGroupingTerminalEnabledChange={onToolGroupingTerminalEnabledChange}
        toolGroupingChangesEnabled={toolGroupingChangesEnabled}
        onToolGroupingChangesEnabledChange={onToolGroupingChangesEnabledChange}
      />

      <DataBaseDirSettingsGroup
        dataBaseDir={dataBaseDir}
        defaultHomeDir={defaultHomeDir}
        onDataBaseDirChange={onDataBaseDirChange}
        onSelectDataBaseDir={onSelectDataBaseDir}
      />

      <OnboardingSettingsGroup onOpenOnboardingDialog={onOpenOnboardingDialog} />
    </div>
  );
}
