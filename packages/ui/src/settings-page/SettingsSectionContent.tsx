// SettingsPage 拆分（max-lines）：按 activeSection 渲染内容区。每个分支保持拆分前的 props
// 映射与服务边界（本机 Host / Source / 远端 workspace 的区分不变）。
import type { CreateTaskRequest, RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { resolveRecentRemoteProjectPreference } from "@/project-sidebar/remote-project-connection.js";
import { ArchiveManagement } from "@/project-sidebar/index.js";
import { CodeGraphExplorer } from "@/agent-workbench/index.js";
import { cn } from "@/components/lib/utils.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { AppearanceSectionContent } from "@/settingsCodePreview.js";
import { GeneralSectionContent, TaskAutoArchiveSettings } from "@/settingsPageHelpers.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { UsageStatsSection } from "@/settings/UsageStatsSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { SettingsStage4Section } from "@/settings-stage4/SettingsStage4Section.js";
import type { SettingsFormState } from "./useSettingsFormState.js";
import type { SettingsPageShellState } from "./useSettingsPageShell.js";
import type { SettingsPageWorkspaceState } from "./useSettingsPageWorkspace.js";
import type { SettingsPagePreferenceHandlers } from "./useSettingsPagePreferenceHandlers.js";
import type { SettingsPageSettingsHandlers } from "./useSettingsPageSettingsHandlers.js";
import type { SettingsUsageSourcesState } from "./useSettingsUsageSources.js";

export interface SettingsSectionContentProps {
  activeSection: SettingsSectionId;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl: boolean;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
  shell: SettingsPageShellState;
  usage: SettingsUsageSourcesState;
  workspace: SettingsPageWorkspaceState;
  form: SettingsFormState;
  settingsHandlers: SettingsPageSettingsHandlers;
  preferenceHandlers: SettingsPagePreferenceHandlers;
}

export function SettingsSectionContent({
  activeSection,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenRemoteWorkspace,
  shell,
  usage,
  workspace,
  form,
  settingsHandlers,
  preferenceHandlers,
}: SettingsSectionContentProps) {
  const { intl } = useZCodeIntl();
  const {
    codePreviewSettings,
    theme,
    uiFontSizePx,
    setUiFontSizePx,
    linuxCloseToTray,
    platform,
    interfaceMode,
    setInterfaceMode,
    localePreference,
    settingsSectionNavigationVersion,
    pluginTab,
    pluginScopeKey,
    pluginNavigationOrigin,
    remoteWorkspaceController,
    setNotificationEnabled,
    setNotificationSoundEnabled,
    notificationEnabled,
    notificationSoundEnabled,
  } = shell;
  const {
    sharedSettings,
    sourceManagement,
    sourceManagementSnapshot,
    projectDirectory,
    workspaceTabs,
    activateTab,
    openSettingsTab,
    localHostServices,
    selectDirectory,
    updateSharedSettings,
    telemetryEnabled,
    workspaceBoundary,
    memoryEnabled,
    toolSearchMode,
    nativeSearchEnhancementsEnabled,
    askUserQuestionAutoResolutionEnabled,
    modelIoFullRetentionEnabled,
    memoryWorkspaceDisplayNames,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeWorkspaceTab,
    isRemoteModelProviderWorkspace,
    localModelProviderConnectivityWorkspacePath,
    pendingModelProviderTarget,
    setPendingModelProviderTarget,
    requestOnboardingDialog,
    handleOpenModelProviderSettings,
  } = workspace;
  const {
    targetSourceServerId,
    setTargetSourceServerId,
    targetSourceServerDetails,
    setTargetSourceServerDetails,
  } = shell;

  return (
    <div
      className={cn(activeSection === "codeGraph" ? "flex min-h-0 flex-1 flex-col" : "space-y-8")}
    >
      {activeSection === "general" ? (
        <GeneralSectionContent
          localePreference={localePreference}
          interfaceMode={interfaceMode}
          setInterfaceMode={setInterfaceMode}
          isDesktop={isDesktop}
          isWindowsDesktop={isWindowsDesktop}
          isLinuxDesktop={shell.isLinuxDesktop}
          linuxCloseToTray={linuxCloseToTray}
          platform={platform}
          notificationEnabled={notificationEnabled}
          notificationSoundEnabled={notificationSoundEnabled}
          telemetryEnabled={telemetryEnabled}
          setTelemetryEnabled={(enabled) => {
            void updateSharedSettings({ telemetryEnabled: enabled });
          }}
          workspaceBoundary={workspaceBoundary}
          onWorkspaceBoundaryChange={(mode) => {
            void updateSharedSettings({ workspaceBoundary: mode });
          }}
          closeToTrayOnWindows={form.closeToTrayOnWindows}
          keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
          desktopChromiumHardwareAccelerationEnabled={
            form.desktopChromiumHardwareAccelerationEnabled
          }
          receivePreviewUpdates={form.receivePreviewUpdates}
          autoDownloadAndInstallUpdates={form.autoDownloadAndInstallUpdates}
          dataBaseDir={form.dataBaseDir}
          terminalInheritSystemProfile={form.terminalInheritSystemProfile}
          terminalFontFamily={form.terminalFontFamily}
          subagentMaxParallel={form.subagentMaxParallel}
          subagentTaskTimeoutMinutes={form.subagentTaskTimeoutMinutes}
          onSubagentMaxParallelChange={settingsHandlers.handleSubagentMaxParallelChange}
          onSubagentTaskTimeoutMinutesChange={
            settingsHandlers.handleSubagentTaskTimeoutMinutesChange
          }
          integratedTerminalShell={form.integratedTerminalShell}
          integratedTerminalShellOptions={form.integratedTerminalShellOptions}
          toolSearchMode={toolSearchMode}
          onToolSearchModeChange={settingsHandlers.handleToolSearchModeChange}
          nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
          httpProxy={form.httpProxy}
          httpProxyList={form.httpProxyList}
          httpProxyNoProxy={form.httpProxyNoProxy}
          httpProxyCaCertPath={form.httpProxyCaCertPath}
          defaultHomeDir={form.defaultHomeDir}
          showIntegratedTerminalShell={form.hostPlatform === "win32"}
          setLocalePreference={preferenceHandlers.handleFooterLocaleChange}
          setNotificationEnabled={(enabled) =>
            runUserAction({
              input: {
                featureId: "settings.notification",
                action: "toggle_notification",
                trigger: "switch",
              },
              operation: () => setNotificationEnabled(enabled),
              completed: {
                resultSource: "local_commit",
                stateAfter: enabled ? "enabled" : "disabled",
              },
              failureStage: "local_commit",
            })
          }
          setNotificationSoundEnabled={(enabled) =>
            runUserAction({
              input: {
                featureId: "settings.notification",
                action: "toggle_notification_sound",
                trigger: "switch",
              },
              operation: () => setNotificationSoundEnabled(enabled),
              completed: {
                resultSource: "local_commit",
                stateAfter: enabled ? "enabled" : "disabled",
              },
              failureStage: "local_commit",
            })
          }
          messageStreamShowReasoning={form.messageStreamShowReasoning}
          messageStreamShowTodos={form.messageStreamShowTodos}
          toolGroupingExploreEnabled={form.toolGroupingExploreEnabled}
          toolGroupingTerminalEnabled={form.toolGroupingTerminalEnabled}
          toolGroupingChangesEnabled={form.toolGroupingChangesEnabled}
          zcodeInteractionBehavior={form.zcodeInteractionBehavior}
          askUserQuestionAutoResolutionEnabled={askUserQuestionAutoResolutionEnabled}
          modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
          onDataBaseDirChange={settingsHandlers.handleDataBaseDirChange}
          onSelectDataBaseDir={selectDirectory}
          onTerminalInheritSystemProfileChange={
            settingsHandlers.handleTerminalInheritSystemProfileChange
          }
          onTerminalFontFamilyChange={settingsHandlers.handleTerminalFontFamilyChange}
          onIntegratedTerminalShellChange={settingsHandlers.handleIntegratedTerminalShellChange}
          onNativeSearchEnhancementsEnabledChange={
            settingsHandlers.handleNativeSearchEnhancementsEnabledChange
          }
          onModelIoFullRetentionEnabledChange={
            settingsHandlers.handleModelIoFullRetentionEnabledChange
          }
          onHttpProxyChange={settingsHandlers.handleHttpProxyChange}
          onHttpProxyListChange={settingsHandlers.handleHttpProxyListChange}
          onHttpProxyNoProxyChange={settingsHandlers.handleHttpProxyNoProxyChange}
          onHttpProxyCaCertPathChange={settingsHandlers.handleHttpProxyCaCertPathChange}
          onCloseToTrayOnWindowsChange={preferenceHandlers.handleCloseToTrayOnWindowsChange}
          onKeepAwakeWhileRunningChange={preferenceHandlers.handleKeepAwakeWhileRunningChange}
          onDesktopChromiumHardwareAccelerationChange={
            preferenceHandlers.handleDesktopChromiumHardwareAccelerationChange
          }
          onReceivePreviewUpdatesChange={preferenceHandlers.handleReceivePreviewUpdatesChange}
          onAutoDownloadAndInstallUpdatesChange={
            preferenceHandlers.handleAutoDownloadAndInstallUpdatesChange
          }
          onMessageStreamShowReasoningChange={
            preferenceHandlers.handleMessageStreamShowReasoningChange
          }
          onMessageStreamShowTodosChange={preferenceHandlers.handleMessageStreamShowTodosChange}
          onToolGroupingExploreEnabledChange={
            preferenceHandlers.handleToolGroupingExploreEnabledChange
          }
          onToolGroupingTerminalEnabledChange={
            preferenceHandlers.handleToolGroupingTerminalEnabledChange
          }
          onToolGroupingChangesEnabledChange={
            preferenceHandlers.handleToolGroupingChangesEnabledChange
          }
          onZCodeInteractionBehaviorChange={preferenceHandlers.handleZCodeInteractionBehaviorChange}
          onAskUserQuestionAutoResolutionEnabledChange={
            settingsHandlers.handleAskUserQuestionAutoResolutionEnabledChange
          }
          onOpenOnboardingDialog={() =>
            runUserAction({
              input: {
                featureId: "settings.navigation",
                action: "open_onboarding",
                trigger: "button",
              },
              operation: requestOnboardingDialog,
              completed: { resultSource: "local_commit" },
              failureStage: "dialog_open",
            })
          }
        />
      ) : activeSection === "remoteDevices" ? (
        sharedSettings && isDesktop && sourceManagement ? (
          <SourceServerManagementPanel
            key={`remote:${settingsSectionNavigationVersion}`}
            targetSourceServerId={targetSourceServerId}
            targetSourceServerDetails={targetSourceServerDetails}
            onTargetSourceServerFocused={() => {
              setTargetSourceServerId(undefined);
              setTargetSourceServerDetails(false);
            }}
            management={sourceManagement}
            onCreateConnection={
              onOpenRemoteWorkspace
                ? () => onOpenRemoteWorkspace({ completion: "device-management" })
                : undefined
            }
            onConnectProfile={
              remoteWorkspaceController
                ? (profileId) =>
                    remoteWorkspaceController.dispatch({
                      type: "connect-device",
                      profileId,
                      effect: "device-management",
                    })
                : onOpenRemoteWorkspace
                  ? (profileId) =>
                      onOpenRemoteWorkspace({
                        preferredProfileId: profileId,
                        completion: "device-management",
                      })
                  : undefined
            }
            onDisconnectSource={
              remoteWorkspaceController
                ? (sourceServerId) =>
                    remoteWorkspaceController.dispatch({
                      type: "disconnect-device",
                      sourceServerId,
                    })
                : undefined
            }
            onOpenProject={
              onOpenRemoteWorkspace
                ? async (sourceServerId, path, profileId) => {
                    // 仅传目录会被 Root 当成新建；复用侧栏唯一目录 owner，同步固定原入口。
                    const preference =
                      projectDirectory &&
                      resolveRecentRemoteProjectPreference(projectDirectory.directory, {
                        sourceServerId,
                        path,
                        profileId,
                      });
                    if (!preference) {
                      throw Object.assign(new Error("remote-project.entry-not-found"), {
                        code: "recent-project-unresolved",
                      });
                    }
                    onBack?.();
                    onOpenRemoteWorkspace(preference);
                  }
                : undefined
            }
            onShowUpdateDetails={(sourceServerId) => {
              setPendingSettingsSectionIntent("remoteDevices", {
                sourceServerId,
                sourceServerDetails: true,
              });
              openSettingsTab();
            }}
            workspaceTabs={workspaceTabs}
            onShowInSidebar={(sourceServerId) => {
              const target = workspaceTabs.find(
                (tab) =>
                  getWorkspaceSourceServerId(tab, {
                    workspaceHistory: sourceManagementSnapshot?.workspaceHistory,
                  }) === sourceServerId,
              );
              onBack?.();
              if (target) {
                activateTab(target.id);
                requestAnimationFrame(() => {
                  const row = Array.from(
                    document.querySelectorAll<HTMLElement>("[data-remote-project-identity]"),
                  ).find(
                    (element) => element.dataset.remoteProjectIdentity === target.workspaceIdentity,
                  );
                  row?.scrollIntoView({ block: "center" });
                  row
                    ?.querySelector<HTMLElement>('[role="button"]')
                    ?.focus({ preventScroll: true });
                });
              }
            }}
            settings={sharedSettings}
            onUpdateSettings={updateSharedSettings}
          />
        ) : (
          <p className="text-ui-sm text-remote-foreground-muted">
            {intl.formatMessage({
              id: sharedSettings ? "settings.source.empty" : "common.loading",
            })}
          </p>
        )
      ) : activeSection === "appearance" ? (
        <AppearanceSectionContent
          codePreviewSettings={codePreviewSettings}
          setCodePreviewSettings={preferenceHandlers.handleCodePreviewSettingsChange}
          theme={theme}
          setTheme={(nextTheme) => preferenceHandlers.handleFooterThemeChange(nextTheme)}
          uiFontSizePx={uiFontSizePx}
          setUiFontSizePx={(fontSizePx) =>
            runUserAction({
              input: {
                featureId: "settings.appearance",
                action: "change_ui_font_size",
                trigger: "keyboard",
              },
              operation: () => setUiFontSizePx(fontSizePx),
              completed: {
                resultSource: "local_commit",
                valueAfter: String(fontSizePx),
              },
              failureStage: "local_commit",
            })
          }
        />
      ) : activeSection === "shortcuts" ? (
        <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
      ) : activeSection === "modelProvider" ? (
        <ServiceProvider services={localHostServices}>
          {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
          <ModelProviderSection
            workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
            codeIndexWorkspacePath={
              isRemoteModelProviderWorkspace
                ? undefined
                : (activeWorkspacePath ?? captionWorkspacePath ?? undefined)
            }
            codeIndexWorkspaceIdentity={
              isRemoteModelProviderWorkspace ? undefined : activeWorkspaceIdentity
            }
            connectivityWorkspacePath={localModelProviderConnectivityWorkspacePath}
            connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
            pendingModelProviderTarget={pendingModelProviderTarget}
            onConsumePendingModelProviderTarget={() => setPendingModelProviderTarget(undefined)}
          />
        </ServiceProvider>
      ) : activeSection === "memory" ? (
        <ServiceProvider services={localHostServices}>
          {/* Memory catalog 始终使用本地 Host，避免远程 workspace 误读本机数据。 */}
          <MemorySettingsSection
            memoryEnabled={memoryEnabled}
            memoryService={localHostServices.memoryService}
            onMemoryEnabledChange={settingsHandlers.handleMemoryEnabledChange}
            projectMemoryViewerAvailable={Boolean(isDesktop)}
            workspaceDisplayNames={memoryWorkspaceDisplayNames}
          />
        </ServiceProvider>
      ) : activeSection === "plugin" ? (
        <PluginsSection
          key={`plugin:${settingsSectionNavigationVersion}`}
          isDesktop={Boolean(isDesktop)}
          isMacDesktop={Boolean(isMacDesktop)}
          isWindowsDesktop={Boolean(isWindowsDesktop)}
          isWebRemoteControl={isWebRemoteControl}
          initialTab={pluginTab}
          initialScopeKey={pluginScopeKey}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
          onCreateTask={onCreateTask}
          onOpenPluginStore={(_returnScopeKey, intent) => {
            // 添加市场与浏览插件都先离开设置层，再显示商店。
            requestPluginStoreOpen({ returnScopeKey: "user", intent });
            onBack?.();
          }}
        />
      ) : activeSection === "mcp" ? (
        <PluginsSection
          key={`mcp:${settingsSectionNavigationVersion}`}
          mode="mcp"
          isWebRemoteControl={isWebRemoteControl}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          onCreateTask={onCreateTask}
          onOpenPluginStore={(_returnScopeKey, intent) => {
            // 添加市场与浏览插件都先离开设置层，再显示商店。
            requestPluginStoreOpen({ returnScopeKey: "user", intent });
            onBack?.();
          }}
        />
      ) : activeSection === "skill" ? (
        <PluginsSection
          key={`skill:${settingsSectionNavigationVersion}`}
          mode="skill"
          isWebRemoteControl={isWebRemoteControl}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          onCreateTask={onCreateTask}
          onOpenPluginStore={(_returnScopeKey, intent) => {
            // 添加市场与浏览插件都先离开设置层，再显示商店。
            requestPluginStoreOpen({ returnScopeKey: "user", intent });
            onBack?.();
          }}
        />
      ) : activeSection === "migration" ? (
        <MigrationSection
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          isDesktop={isDesktop}
        />
      ) : activeSection === "archives" ? (
        <div className="min-w-0 space-y-6">
          <TaskAutoArchiveSettings
            taskAutoArchiveEnabled={form.taskAutoArchiveEnabled}
            taskAutoArchiveOlderThanDays={form.taskAutoArchiveOlderThanDays}
            onTaskAutoArchiveEnabledChange={settingsHandlers.handleTaskAutoArchiveEnabledChange}
            onTaskAutoArchiveOlderThanDaysChange={
              settingsHandlers.handleTaskAutoArchiveOlderThanDaysChange
            }
          />
          <ArchiveManagement />
        </div>
      ) : activeSection === "codeGraph" ? (
        <div className="@container/code-graph flex min-h-0 flex-1 flex-col">
          <CodeGraphExplorer
            workspaceIdentity={activeWorkspaceIdentity}
            workspacePath={activeWorkspacePath ?? undefined}
          />
        </div>
      ) : activeSection === "usage" ? (
        <UsageStatsSection
          activeTab={usage.activeTab}
          providerSourcesLoading={usage.providerSettingsLoading}
          selectedCodingPlanSource={usage.selectedCodingPlanSource}
        />
      ) : activeSection === "subagents" ? (
        <SubagentsSection
          onManageModels={handleOpenModelProviderSettings}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
        />
      ) : activeSection === "automations" ? (
        <AutomationsSection
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
        />
      ) : activeSection === "commands" ? (
        <PluginsSection
          mode="command"
          isWebRemoteControl={isWebRemoteControl}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          onCreateTask={onCreateTask}
          onOpenPluginStore={(_returnScopeKey, intent) => {
            // 添加市场与浏览插件都先离开设置层，再显示商店。
            requestPluginStoreOpen({ returnScopeKey: "user", intent });
            onBack?.();
          }}
        />
      ) : activeSection === "hooks" ? (
        <HooksSection
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
        />
      ) : activeSection === "workspaceFileSearch" ? (
        <WorkspaceFileSearchSection
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
        />
      ) : activeSection === "browser" ? (
        <BrowserSettingsSection
          isDesktop={Boolean(isDesktop)}
          isWindowsDesktop={isWindowsDesktop}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          embeddedBrowserAllowInsecureCertificates={form.embeddedBrowserAllowInsecureCertificates}
          onEmbeddedBrowserAllowInsecureCertificatesChange={
            preferenceHandlers.handleEmbeddedBrowserAllowInsecureCertificatesChange
          }
        />
      ) : activeSection === "stage4" ? (
        <SettingsStage4Section
          settings={sharedSettings}
          onUpdateSettings={async (patch) => {
            await updateSharedSettings(patch);
          }}
          isMacDesktop={Boolean(isMacDesktop)}
          isWindowsDesktop={Boolean(isWindowsDesktop)}
          isLinuxDesktop={shell.isLinuxDesktop}
          workspacePath={activeWorkspacePath}
          {...(activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : {})}
        />
      ) : activeSection === "computerUse" ? (
        <ComputerUseSection
          isDesktop={Boolean(isDesktop)}
          isMacDesktop={Boolean(isMacDesktop)}
          isWindowsDesktop={Boolean(isWindowsDesktop)}
          workspacePath={activeWorkspacePath}
          workspaceIdentity={activeWorkspaceIdentity}
          remoteSessionId={activeWorkspaceTab?.remoteSessionId}
          remoteTarget={activeWorkspaceTab?.remoteTarget}
          localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
        />
      ) : null}
    </div>
  );
}
