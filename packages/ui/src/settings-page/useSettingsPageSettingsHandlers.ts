// SettingsPage 拆分（max-lines）：终端/搜索/网络/存储/任务归档等“设置写入”handler。
// 每个 handler 保持拆分前的 telemetry 包装、失败语义与本地状态提交顺序。
import { useCallback } from "react";
import type { AppToolSearchMode, IntegratedTerminalShellSelection } from "@zcode/shared";
import type { RunLimitSaveResult } from "@/settingsPageHelpers.js";
import { toast } from "@/components/ui/toast.js";
import { parseRunLimitInput, runSettingsActionAsync } from "./helpers.js";
import type { SettingsFormState } from "./useSettingsFormState.js";
import type { SettingsPageShellState } from "./useSettingsPageShell.js";
import type { SettingsPageWorkspaceState } from "./useSettingsPageWorkspace.js";

export interface SettingsPageSettingsHandlersOptions {
  shell: SettingsPageShellState;
  workspace: SettingsPageWorkspaceState;
  form: SettingsFormState;
}

export interface SettingsPageSettingsHandlers {
  handleTerminalInheritSystemProfileChange: (enabled: boolean) => Promise<void>;
  handleTerminalFontFamilyChange: (fontFamily: string) => Promise<void>;
  handleSubagentMaxParallelChange: (raw: string) => Promise<RunLimitSaveResult>;
  handleSubagentTaskTimeoutMinutesChange: (raw: string) => Promise<RunLimitSaveResult>;
  handleIntegratedTerminalShellChange: (
    selection: IntegratedTerminalShellSelection,
  ) => Promise<void>;
  handleToolSearchModeChange: (mode: AppToolSearchMode) => Promise<void>;
  handleNativeSearchEnhancementsEnabledChange: (enabled: boolean) => Promise<void>;
  handleAskUserQuestionAutoResolutionEnabledChange: (enabled: boolean) => Promise<void>;
  handleModelIoFullRetentionEnabledChange: (enabled: boolean) => Promise<void>;
  handleMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  handleHttpProxyChange: (proxy: string) => Promise<void>;
  handleHttpProxyListChange: (proxyList: string) => Promise<void>;
  handleHttpProxyNoProxyChange: (noProxy: string) => Promise<void>;
  handleHttpProxyCaCertPathChange: (caCertPath: string) => Promise<void>;
  handleDataBaseDirChange: (dir: string) => Promise<void>;
  handleTaskAutoArchiveEnabledChange: (enabled: boolean) => Promise<void>;
  handleTaskAutoArchiveOlderThanDaysChange: (days: number) => Promise<void>;
}

export function useSettingsPageSettingsHandlers({
  shell,
  workspace,
  form,
}: SettingsPageSettingsHandlersOptions): SettingsPageSettingsHandlers {
  const { intl } = shell;
  const { services, localHostServices, updateSharedSettings, onboardingRecordService } = workspace;
  const {
    setTerminalInheritSystemProfile,
    setTerminalFontFamily,
    setSubagentMaxParallel,
    setSubagentTaskTimeoutMinutes,
    setIntegratedTerminalShell,
    setHttpProxy,
    setHttpProxyList,
    setHttpProxyNoProxy,
    setHttpProxyCaCertPath,
    setDataBaseDir,
    setTaskAutoArchiveEnabled,
    setTaskAutoArchiveOlderThanDays,
    httpProxy,
  } = form;
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "toggle_system_profile",
        trigger: "switch",
        operation: () => services.settingService.update({ terminalInheritSystemProfile: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService, setTerminalInheritSystemProfile],
  );
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "save_font_family",
        trigger: "button",
        operation: () =>
          services.settingService.update({ terminalFontFamily: normalizedFontFamily }),
        completed: { resultSource: "setting_service", configured: normalizedFontFamily.length > 0 },
      });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService, setTerminalFontFamily],
  );
  const handleSubagentMaxParallelChange = useCallback(
    async (raw: string): Promise<RunLimitSaveResult> => {
      const parsed = parseRunLimitInput(raw, 0);
      if (parsed === "empty" || parsed === "invalid") return parsed;
      await runSettingsActionAsync({
        featureId: "settings.run_limits",
        action: "save_subagent_max_parallel",
        trigger: "button",
        operation: () => services.settingService.update({ subagentMaxParallel: parsed }),
        completed: {
          resultSource: "setting_service",
          configured: true,
          valueAfter: String(parsed),
        },
      });
      setSubagentMaxParallel(parsed);
      return "saved";
    },
    [services.settingService, setSubagentMaxParallel],
  );
  const handleSubagentTaskTimeoutMinutesChange = useCallback(
    async (raw: string): Promise<RunLimitSaveResult> => {
      const parsed = parseRunLimitInput(raw, 0);
      if (parsed === "empty" || parsed === "invalid" || parsed > 180) return "invalid";
      await runSettingsActionAsync({
        featureId: "settings.run_limits",
        action: "save_subagent_task_timeout",
        trigger: "button",
        operation: () => services.settingService.update({ subagentTaskTimeoutMinutes: parsed }),
        completed: {
          resultSource: "setting_service",
          configured: true,
          valueAfter: String(parsed),
        },
      });
      setSubagentTaskTimeoutMinutes(parsed);
      return "saved";
    },
    [services.settingService, setSubagentTaskTimeoutMinutes],
  );
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "change_shell",
        trigger: "select",
        operation: () =>
          localHostServices.settingService.update({ integratedTerminalShell: selection }),
        completed: {
          resultSource: "setting_service",
          valueAfter: selection.mode === "auto" ? "auto" : "explicit",
        },
      });
      setIntegratedTerminalShell(selection);
    },
    [localHostServices.settingService, setIntegratedTerminalShell],
  );
  const handleToolSearchModeChange = useCallback(
    async (mode: AppToolSearchMode) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "change_tool_search_mode",
        trigger: "select",
        operation: () => updateSharedSettings({ toolSearchMode: mode }),
        completed: { resultSource: "shared_settings", valueAfter: mode },
      });
    },
    [updateSharedSettings],
  );
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "toggle_native_search",
        trigger: "switch",
        operation: () => updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_ask_user_auto_resolution",
        trigger: "switch",
        operation: () => updateSharedSettings({ askUserQuestionAutoResolutionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_model_io_retention",
        trigger: "switch",
        operation: () => updateSharedSettings({ modelIoFullRetentionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.memory",
        action: "toggle_memory",
        trigger: "switch",
        operation: async () => {
          await updateSharedSettings({ memoryEnabled: enabled });
          // 手动修改反向回写 record，换号同步不会复活旧值；失败不阻塞开关。
          await onboardingRecordService
            ?.updateRecordPreferences({ memoryEnabled: enabled })
            .catch((cause: unknown) => {
              console.warn("[settings] 回写引导记录失败", String(cause));
            });
        },
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings, onboardingRecordService],
  );
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
            httpProxy: normalizedProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedProxy.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl, setHttpProxy],
  );
  const handleHttpProxyListChange = useCallback(
    async (proxyList: string) => {
      const normalizedProxyList = proxyList
        .split(/\r?\n/u)
        .map((proxy) => proxy.trim())
        .filter(Boolean)
        .join("\n");
      const entries = normalizedProxyList.split("\n").filter(Boolean);
      const nextActiveProxy =
        !httpProxy || entries.includes(httpProxy) ? httpProxy : (entries[0] ?? "");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy_list",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            httpProxyList: normalizedProxyList,
            // 列表与活动代理一次写入，删除当前活动项时切换到首项；清空列表则恢复直连。
            httpProxy: nextActiveProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: entries.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyList(normalizedProxyList);
      setHttpProxy(nextActiveProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [httpProxy, intl, localHostServices.settingService, setHttpProxy, setHttpProxyList],
  );
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_no_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
            httpProxyNoProxy: normalizedNoProxy,
          }),
        completed: { resultSource: "setting_service", configured: normalizedNoProxy.length > 0 },
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl, setHttpProxyNoProxy],
  );
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_ca_certificate",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
            httpProxyCaCertPath: normalizedCaCertPath,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedCaCertPath.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl, setHttpProxyCaCertPath],
  );
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await runSettingsActionAsync({
        featureId: "settings.storage",
        action: "change_data_directory",
        trigger: "button",
        operation: () => localHostServices.settingService.updateDataBaseDir(dir || undefined),
        completed: { resultSource: "setting_service", requiresRestart: true },
        failureStage: "data_directory_update",
      });
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [localHostServices.settingService, setDataBaseDir],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "toggle_auto_archive",
        trigger: "switch",
        operation: () => services.settingService.update({ taskAutoArchiveEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService, setTaskAutoArchiveEnabled],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "change_auto_archive_days",
        trigger: "select",
        operation: () => services.settingService.update({ taskAutoArchiveOlderThanDays: days }),
        completed: { resultSource: "setting_service", valueAfter: String(days) },
      });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService, setTaskAutoArchiveOlderThanDays],
  );

  return {
    handleTerminalInheritSystemProfileChange,
    handleTerminalFontFamilyChange,
    handleSubagentMaxParallelChange,
    handleSubagentTaskTimeoutMinutesChange,
    handleIntegratedTerminalShellChange,
    handleToolSearchModeChange,
    handleNativeSearchEnhancementsEnabledChange,
    handleAskUserQuestionAutoResolutionEnabledChange,
    handleModelIoFullRetentionEnabledChange,
    handleMemoryEnabledChange,
    handleHttpProxyChange,
    handleHttpProxyListChange,
    handleHttpProxyNoProxyChange,
    handleHttpProxyCaCertPathChange,
    handleDataBaseDirChange,
    handleTaskAutoArchiveEnabledChange,
    handleTaskAutoArchiveOlderThanDaysChange,
  };
}
