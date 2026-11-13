/**
 * `GeneralSectionContent` 的 props 契约。
 *
 * 从 `settingsPageHelpers.tsx` 原样拆出（字段、可选性与注释均未改动），
 * 供内容组件与各设置分组共享；外部调用方仍从 barrel `settingsPageHelpers.tsx` 取组件本身。
 */
import type {
  AppToolSearchMode,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  LocalePreference,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import type { IPlatformService } from "@zcode/shared";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import type { RunLimitSaveResult } from "@/settings-page-helpers/RunLimitSettingRow.js";

export interface GeneralSectionContentProps {
  localePreference: LocalePreference;
  interfaceMode?: InterfaceMode;
  setInterfaceMode?: (mode: InterfaceMode) => void;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  telemetryEnabled?: boolean;
  setTelemetryEnabled?: (enabled: boolean) => void;
  closeToTrayOnWindows: boolean;
  keepAwakeWhileRunning?: boolean;
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  receivePreviewUpdates: boolean;
  autoDownloadAndInstallUpdates: boolean;
  dataBaseDir: string;
  terminalInheritSystemProfile: boolean;
  terminalFontFamily: string;
  integratedTerminalShell?: IntegratedTerminalShellSelection;
  integratedTerminalShellOptions?: IntegratedTerminalShellOption[];
  toolSearchMode?: AppToolSearchMode;
  onToolSearchModeChange: (mode: AppToolSearchMode) => Promise<void>;
  workspaceBoundary?: "strict" | "ask" | "allow";
  onWorkspaceBoundaryChange?: (mode: "strict" | "ask" | "allow") => void;
  nativeSearchEnhancementsEnabled: boolean;
  httpProxy?: string;
  httpProxyList?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  /** 每个 root run 的并行度；0/undefined 表示按机器适配。 */
  subagentMaxParallel?: number;
  /** 每个子代理的最短期限；0/undefined 表示使用 role default。 */
  subagentTaskTimeoutMinutes?: number;
  defaultHomeDir: string;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /** Linux 桌面端（isDesktop 且非 win/mac）；关闭驻留托盘设置在 Linux 上按能力自适应展示 */
  isLinuxDesktop?: boolean;
  /** Linux 关闭驻留托盘能力状态（spec：docs/desktop/linux-close-to-tray.md）；Windows 不传 */
  linuxCloseToTray?: {
    /** 能力探测中或确认不可用，开关锁定 */
    disabled: boolean;
    /** 确认不可用（描述文案切换为"未提供系统托盘"） */
    unavailable: boolean;
    /** GNOME 系桌面且无托盘（追加 AppIndicator 扩展安装提示） */
    gnomeLikeHint: boolean;
  };
  showIntegratedTerminalShell?: boolean;
  platform?: IPlatformService;
  setLocalePreference: (locale: LocalePreference) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  messageStreamShowReasoning: boolean;
  messageStreamShowTodos: boolean;
  toolGroupingExploreEnabled: boolean;
  toolGroupingTerminalEnabled: boolean;
  toolGroupingChangesEnabled: boolean;
  zcodeInteractionBehavior: ZCodeInteractionBehavior;
  askUserQuestionAutoResolutionEnabled?: boolean;
  modelIoFullRetentionEnabled?: boolean;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
  onTerminalInheritSystemProfileChange: (enabled: boolean) => Promise<void>;
  onTerminalFontFamilyChange: (fontFamily: string) => Promise<void>;
  onIntegratedTerminalShellChange?: (selection: IntegratedTerminalShellSelection) => Promise<void>;
  onNativeSearchEnhancementsEnabledChange: (enabled: boolean) => Promise<void>;
  onHttpProxyChange?: (httpProxy: string) => Promise<void>;
  onHttpProxyListChange?: (proxyList: string) => Promise<void>;
  onHttpProxyNoProxyChange?: (noProxy: string) => Promise<void>;
  onHttpProxyCaCertPathChange?: (caCertPath: string) => Promise<void>;
  onSpawnBudgetChange?: (raw: string) => Promise<RunLimitSaveResult>;
  onSubagentMaxParallelChange?: (raw: string) => Promise<RunLimitSaveResult>;
  onSubagentTaskTimeoutMinutesChange?: (raw: string) => Promise<RunLimitSaveResult>;
  onCloseToTrayOnWindowsChange: (enabled: boolean) => Promise<void>;
  onKeepAwakeWhileRunningChange?: (enabled: boolean) => Promise<void>;
  onDesktopChromiumHardwareAccelerationChange?: (enabled: boolean) => Promise<void>;
  onReceivePreviewUpdatesChange: (enabled: boolean) => Promise<void>;
  onAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowReasoningChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowTodosChange: (enabled: boolean) => Promise<void>;
  onToolGroupingExploreEnabledChange: (enabled: boolean) => Promise<void>;
  onToolGroupingTerminalEnabledChange: (enabled: boolean) => Promise<void>;
  onToolGroupingChangesEnabledChange: (enabled: boolean) => Promise<void>;
  onZCodeInteractionBehaviorChange: (behavior: ZCodeInteractionBehavior) => Promise<void>;
  onAskUserQuestionAutoResolutionEnabledChange?: (enabled: boolean) => Promise<void>;
  onModelIoFullRetentionEnabledChange?: (enabled: boolean) => Promise<void>;
  onOpenOnboardingDialog: () => void;
}
