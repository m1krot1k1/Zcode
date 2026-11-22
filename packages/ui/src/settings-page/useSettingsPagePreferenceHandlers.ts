// SettingsPage 拆分（max-lines）：桌面/更新/会话展示/工具分组/外观偏好等“本地偏好”handler。
// 本地提交继续走 runUserAction，保存语义与拆分前一致。
import { useCallback } from "react";
import type { Locale, ZCodeInteractionBehavior } from "@zcode/shared";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import type { Theme } from "@/useTheme.js";
import { toast } from "@/components/ui/toast.js";
import { runSettingsActionAsync } from "./helpers.js";
import type { SettingsFormState } from "./useSettingsFormState.js";
import type { SettingsPageShellState } from "./useSettingsPageShell.js";
import type { SettingsPageWorkspaceState } from "./useSettingsPageWorkspace.js";

export interface SettingsPagePreferenceHandlersOptions {
  shell: SettingsPageShellState;
  workspace: SettingsPageWorkspaceState;
  form: SettingsFormState;
}

export interface SettingsPagePreferenceHandlers {
  handleCloseToTrayOnWindowsChange: (enabled: boolean) => Promise<void>;
  handleKeepAwakeWhileRunningChange: (enabled: boolean) => Promise<void>;
  handleDesktopChromiumHardwareAccelerationChange: (enabled: boolean) => Promise<void>;
  handleEmbeddedBrowserAllowInsecureCertificatesChange: (enabled: boolean) => Promise<void>;
  handleReceivePreviewUpdatesChange: (enabled: boolean) => Promise<void>;
  handleAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
  handleMessageStreamShowReasoningChange: (enabled: boolean) => Promise<void>;
  handleMessageStreamShowTodosChange: (enabled: boolean) => Promise<void>;
  handleToolGroupingExploreEnabledChange: (enabled: boolean) => Promise<void>;
  handleToolGroupingTerminalEnabledChange: (enabled: boolean) => Promise<void>;
  handleToolGroupingChangesEnabledChange: (enabled: boolean) => Promise<void>;
  handleZCodeInteractionBehaviorChange: (behavior: ZCodeInteractionBehavior) => Promise<void>;
  handleFooterLocaleChange: (value: string) => void;
  handleFooterThemeChange: (value: string) => void;
  handleCodePreviewSettingsChange: (patch: Partial<CodePreviewSettings>) => void;
}

export function useSettingsPagePreferenceHandlers({
  shell,
  workspace,
  form,
}: SettingsPagePreferenceHandlersOptions): SettingsPagePreferenceHandlers {
  const { intl, platform, setLocalePreference, setTheme, setCodePreviewSettings } = shell;
  const { localHostServices, updateSharedSettings } = workspace;
  const {
    setCloseToTrayOnWindows,
    setDesktopChromiumHardwareAccelerationEnabled,
    setEmbeddedBrowserAllowInsecureCertificates,
    setReceivePreviewUpdates,
    setAutoDownloadAndInstallUpdates,
    setMessageStreamShowReasoning,
    setMessageStreamShowTodos,
    setToolGroupingExploreEnabled,
    setToolGroupingTerminalEnabled,
    setToolGroupingChangesEnabled,
    setZCodeInteractionBehavior,
  } = form;
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_close_to_tray",
        trigger: "switch",
        operation: () => localHostServices.settingService.update({ closeToTrayOnWindows: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [localHostServices.settingService, platform, setCloseToTrayOnWindows],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_keep_awake",
        trigger: "switch",
        operation: () => updateSharedSettings({ keepAwakeWhileRunning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_hardware_acceleration",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            desktopChromiumHardwareAccelerationEnabled: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl, setDesktopChromiumHardwareAccelerationEnabled],
  );
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.browser",
        action: "toggle_insecure_certificates",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            embeddedBrowserAllowInsecureCertificates: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl, setEmbeddedBrowserAllowInsecureCertificates],
  );
  const handleReceivePreviewUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_preview_updates",
        trigger: "switch",
        operation: () => updateSharedSettings({ receivePreviewUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setReceivePreviewUpdates(enabled);
    },
    [updateSharedSettings, setReceivePreviewUpdates],
  );
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_auto_update",
        trigger: "switch",
        operation: () => updateSharedSettings({ autoDownloadAndInstallUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setAutoDownloadAndInstallUpdates(enabled);
    },
    [updateSharedSettings, setAutoDownloadAndInstallUpdates],
  );
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_reasoning",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowReasoning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings, setMessageStreamShowReasoning],
  );
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_todos",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowTodos: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings, setMessageStreamShowTodos],
  );
  const handleToolGroupingExploreEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_explore_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingExploreEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingExploreEnabled(enabled);
    },
    [updateSharedSettings, setToolGroupingExploreEnabled],
  );
  const handleToolGroupingTerminalEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_terminal_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingTerminalEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingTerminalEnabled(enabled);
    },
    [updateSharedSettings, setToolGroupingTerminalEnabled],
  );
  const handleToolGroupingChangesEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_changes_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingChangesEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingChangesEnabled(enabled);
    },
    [updateSharedSettings, setToolGroupingChangesEnabled],
  );
  const handleZCodeInteractionBehaviorChange = useCallback(
    async (behavior: ZCodeInteractionBehavior) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "change_interaction_behavior",
        trigger: "select",
        operation: () => updateSharedSettings({ zcodeInteractionBehavior: behavior }),
        completed: { resultSource: "shared_settings", valueAfter: behavior },
      });
      setZCodeInteractionBehavior(behavior);
    },
    [updateSharedSettings, setZCodeInteractionBehavior],
  );
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference("system"),
          completed: { resultSource: "local_commit", valueAfter: "system" },
          failureStage: "local_commit",
        });
        return;
      }
      if (value === "zh-CN" || value === "en-US" || value === "ru-RU") {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference(value as Locale),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setLocalePreference],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        runUserAction({
          input: { featureId: "settings.appearance", action: "change_theme", trigger: "select" },
          operation: () => setTheme(value as Theme),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Partial<CodePreviewSettings>) => {
      const [key] = Object.keys(patch);
      const action =
        key === "lightTheme"
          ? "change_code_light_theme"
          : key === "darkTheme"
            ? "change_code_dark_theme"
            : key === "showLineNumbers"
              ? "toggle_code_line_numbers"
              : key === "wrapLongLines"
                ? "toggle_code_line_wrap"
                : "change_code_font_size";
      const value = Object.values(patch)[0];
      return runUserAction({
        input: { featureId: "settings.appearance", action, trigger: "select" },
        operation: () => setCodePreviewSettings(patch),
        completed: {
          resultSource: "local_commit",
          ...(typeof value === "boolean"
            ? { stateAfter: value ? ("enabled" as const) : ("disabled" as const) }
            : { valueAfter: String(value) }),
        },
        failureStage: "local_commit",
      });
    },
    [setCodePreviewSettings],
  );

  return {
    handleCloseToTrayOnWindowsChange,
    handleKeepAwakeWhileRunningChange,
    handleDesktopChromiumHardwareAccelerationChange,
    handleEmbeddedBrowserAllowInsecureCertificatesChange,
    handleReceivePreviewUpdatesChange,
    handleAutoDownloadAndInstallUpdatesChange,
    handleMessageStreamShowReasoningChange,
    handleMessageStreamShowTodosChange,
    handleToolGroupingExploreEnabledChange,
    handleToolGroupingTerminalEnabledChange,
    handleToolGroupingChangesEnabledChange,
    handleZCodeInteractionBehaviorChange,
    handleFooterLocaleChange,
    handleFooterThemeChange,
    handleCodePreviewSettingsChange,
  };
}
