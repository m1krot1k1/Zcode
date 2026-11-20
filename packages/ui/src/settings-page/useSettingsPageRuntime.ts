// SettingsPage 拆分（max-lines）：页面运行时副作用（跨窗口分区跳转意图、Host/Source 设置加载、
// 共享设置回填表单）。effect 顺序与依赖数组与拆分前一致：跳转监听 → 本机 Host 加载 → Source 加载 → 共享设置。
import { useEffect } from "react";
import {
  addPendingSettingsSectionListener,
  resolveSettingsSection,
} from "@/lib/settingsNavigation.js";
import type { AppSettings } from "@zcode/shared";
import type { SettingsFormState } from "./useSettingsFormState.js";
import type { SettingsPageShellState } from "./useSettingsPageShell.js";
import type { SettingsPageWorkspaceState } from "./useSettingsPageWorkspace.js";
import type { SettingsUsageSourcesState } from "./useSettingsUsageSources.js";

export interface SettingsPageRuntimeOptions {
  shell: SettingsPageShellState;
  usage: SettingsUsageSourcesState;
  workspace: SettingsPageWorkspaceState;
  form: SettingsFormState;
  isWindowsDesktop?: boolean;
}

export function useSettingsPageRuntime({
  shell,
  usage,
  workspace,
  form,
  isWindowsDesktop,
}: SettingsPageRuntimeOptions): void {
  const { activeSection, setSettingsSectionNavigationVersion } = shell;
  const { setActiveSettingsSection, localHostServices, services, sharedSettings } = workspace;
  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        shell.setTargetSourceServerId(
          section === "remoteDevices" ? detail?.sourceServerId : undefined,
        );
        shell.setTargetSourceServerDetails(
          section === "remoteDevices" && detail?.sourceServerDetails === true,
        );
        if (section === "usage" && detail?.usageTab) {
          usage.setActiveTab(detail.usageTab === "codeGraph" ? "app" : detail.usageTab);
        }
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          shell.setPluginTab(detail.pluginTab);
          shell.setPluginNavigationOrigin(detail.pluginOrigin);
          shell.setPluginScopeKey(detail.pluginScopeKey);
        } else if (resolveSettingsSection(section) !== "plugin") {
          shell.setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          workspace.setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    let active = true;
    // 修复原因：远程 tab 的 services 属于 Source，但 Main 启动、native picker 和
    // 本机 shell 枚举都使用 Desktop 配置；读写必须同属 base Host，不能随 tab 切换。
    localHostServices.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        form.setDataBaseDir(settings.dataBaseDir ?? "");
        form.setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        form.setHttpProxy(settings.httpProxy ?? "");
        // 旧配置只保存活动代理；首次显示时将其作为列表中的唯一一项，避免升级后地址消失。
        form.setHttpProxyList(settings.httpProxyList ?? settings.httpProxy ?? "");
        form.setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        form.setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        form.setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        form.setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? Boolean(isWindowsDesktop));
        form.setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
      })
      .catch(() => {});
    localHostServices.systemService
      .info()
      .then((info) => {
        if (!active) return;
        form.setDefaultHomeDir(info.homedir);
        form.setHostPlatform(info.platform);
        if (info.platform !== "win32") {
          form.setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then((options) => {
            if (active) form.setIntegratedTerminalShellOptions(options);
          })
          .catch(() => {
            if (active) form.setIntegratedTerminalShellOptions([]);
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [localHostServices.systemService, localHostServices.settingService, isWindowsDesktop]);

  useEffect(() => {
    let active = true;
    // 终端 Profile 与任务归档由目标 Environment 消费，仍读 Source；切换后丢弃旧响应。
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        form.setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        form.setTerminalFontFamily(settings.terminalFontFamily ?? "");
        form.setSubagentMaxParallel(settings.subagentMaxParallel);
        form.setSubagentTaskTimeoutMinutes(settings.subagentTaskTimeoutMinutes);
        form.setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        form.setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 30);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [services.settingService]);

  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    form.setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    form.setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    form.setToolGroupingExploreEnabled(sharedSettings.toolGroupingExploreEnabled ?? true);
    form.setToolGroupingTerminalEnabled(sharedSettings.toolGroupingTerminalEnabled ?? true);
    form.setToolGroupingChangesEnabled(sharedSettings.toolGroupingChangesEnabled ?? true);
    form.setZCodeInteractionBehavior(sharedSettings.zcodeInteractionBehavior ?? "queue");
    form.setReceivePreviewUpdates(sharedSettings.receivePreviewUpdates ?? false);
    form.setAutoDownloadAndInstallUpdates(sharedSettings.autoDownloadAndInstallUpdates ?? false);
  }, [sharedSettings]);
}
