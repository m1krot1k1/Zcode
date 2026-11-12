/* oxlint-disable eslint(max-lines) -- settings helper 聚合多个设置分组；终端、网络与自动归档多侧能力暂时超过行数限制。 */
import type {
  AppToolSearchMode,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  LocalePreference,
  ZCodeInteractionBehavior,
} from "@zcode/shared";
import { appToolSearchModeSchema } from "@zcode/shared";
import {
  TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH,
  TID_SETTINGS_NATIVE_SEARCH_SWITCH,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
} from "@zcode/shared/test-ids";
import { useState, useCallback, useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import {
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Check, Plus, Trash2 } from "lucide-react";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { DataBaseDirControl } from "@/settings/DataBaseDirControl.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { ProactiveSuggestionsSetting } from "@/settings/ProactiveSuggestionsSetting.js";
import { DynamicWorkflowModeSetting } from "@/settings/DynamicWorkflowModeSetting.js";
import { normalizeInterfaceMode, type InterfaceMode } from "@/lib/interfaceMode.js";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
  SETTINGS_SECTION_GROUPS,
  SETTINGS_SECTIONS,
  isSettingsSectionAvailable,
  type SettingsSectionId,
} from "@/settings/settingsPageConfig.js";



export { createSettingsPageConfig, resolveSettingsSectionForPlatform };

export { isSettingsSectionAvailable };

/** UI route labels reveal only scheme and endpoint, never proxy credentials or URL extras. */
export function sanitizeProxyRouteForDisplay(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (!["http:", "https:", "socks:", "socks5:", "socks5h:"].includes(url.protocol)) {
      return undefined;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    // Never fall back to showing the original string: legacy proxy formats can contain secrets.
    return undefined;
  }
}

const TASK_AUTO_ARCHIVE_DAY_OPTIONS = [3, 7, 14, 30] as const;
const ZCODE_INTERACTION_BEHAVIOR_OPTIONS: readonly ZCodeInteractionBehavior[] = ["queue", "guide"];

/**
 * 归档偏好与归档列表集中展示，设置值和保存动作继续由 SettingsPage 持有。
 * Bugfix：关闭时禁用时长会迫使用户先开启归档，旧阈值可能立即生效；允许先保存时长再开启。
 */
export function TaskAutoArchiveSettings({
  taskAutoArchiveEnabled,
  taskAutoArchiveOlderThanDays,
  onTaskAutoArchiveEnabledChange,
  onTaskAutoArchiveOlderThanDaysChange,
}: {
  taskAutoArchiveEnabled: boolean;
  taskAutoArchiveOlderThanDays: number;
  onTaskAutoArchiveEnabledChange: (enabled: boolean) => Promise<void>;
  onTaskAutoArchiveOlderThanDaysChange: (days: number) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDescription",
        })}
        control={
          <Switch
            data-testid="archive-auto-archive-switch"
            aria-label={intl.formatMessage({ id: "settings.taskAutoArchive" })}
            checked={taskAutoArchiveEnabled}
            onCheckedChange={(checked) => {
              void onTaskAutoArchiveEnabledChange(checked);
            }}
          />
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.taskAutoArchiveDays" })}
        description={intl.formatMessage({
          id: "settings.taskAutoArchiveDaysDescription",
        })}
        control={
          <Select
            value={String(taskAutoArchiveOlderThanDays)}
            onValueChange={(value) => {
              void onTaskAutoArchiveOlderThanDaysChange(Number(value));
            }}
          >
            <SelectTrigger
              data-testid="archive-auto-archive-days"
              aria-label={intl.formatMessage({
                id: "settings.taskAutoArchiveDays",
              })}
              size="lg"
              className="w-full min-w-0 justify-between"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_AUTO_ARCHIVE_DAY_OPTIONS.map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {intl.formatMessage({
                    id: `settings.taskAutoArchiveDays.option.${days}`,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SettingsGroupCard>
  );
}

/** 单次保存结果：empty/invalid 都不写 settings，保证“留空 = 用默认值”。 */
export type RunLimitSaveResult = "saved" | "empty" | "invalid";

function RunLimitSettingRow({
  labelId,
  descriptionId,
  invalidId,
  placeholder,
  testId: fieldTestId,
  value,
  onSave,
}: {
  labelId: string;
  descriptionId: string;
  invalidId: string;
  placeholder: string;
  testId: string;
  value?: number;
  onSave: (raw: string) => Promise<RunLimitSaveResult>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(value === undefined ? "" : String(value));
    setInvalid(false);
  }, [value]);
  const saved = value === undefined ? "" : String(value);
  const dirty = draft.trim() !== saved;
  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const result = await onSave(draft);
      setInvalid(result === "invalid");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsRow
      label={intl.formatMessage({ id: labelId })}
      description={intl.formatMessage({ id: descriptionId })}
      detail={
        <div className="space-y-2">
          <Input
            size="lg"
            inputMode="numeric"
            className="max-w-[240px] font-mono"
            value={draft}
            placeholder={placeholder}
            aria-label={intl.formatMessage({ id: labelId })}
            aria-invalid={invalid}
            data-testid={fieldTestId}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSave();
            }}
          />
          {invalid ? (
            <p className="text-ui-sm text-destructive" role="alert">
              {intl.formatMessage({ id: invalidId })}
            </p>
          ) : null}
        </div>
      }
      control={
        <Button
          type="button"
          size="lg"
          disabled={!dirty || saving}
          data-testid={`${fieldTestId}-save`}
          onClick={() => void handleSave()}
        >
          {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
        </Button>
      }
    />
  );
}

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
}: {
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
}) {
  const { intl } = useZCodeIntl();
  const hasServices = Boolean(useOptionalServices());
  // 部分 SSR 单测会用精简 props 直接渲染本组件，新增终端设置项后旧 helper 未必同步传值。
  // 这里把运行时缺省值兜到“继承系统 profile”，避免 undefined.trim() 把无关测试打断。
  const [localTerminalFontFamily, setLocalTerminalFontFamily] = useState(terminalFontFamily);

  useEffect(() => {
    setLocalTerminalFontFamily(terminalFontFamily);
  }, [terminalFontFamily]);

  const normalizedTerminalFontFamily = localTerminalFontFamily.trim();
  const isTerminalFontFamilyDirty = normalizedTerminalFontFamily !== terminalFontFamily;
  const integratedTerminalShellValue =
    integratedTerminalShell.mode === "shell" ? integratedTerminalShell.id : "auto";
  const selectedIntegratedTerminalShellOption =
    integratedTerminalShell.mode === "shell"
      ? (integratedTerminalShellOptions.find(
          (option) => option.id === integratedTerminalShell.id,
        ) ?? {
          dialect: integratedTerminalShell.dialect,
          id: integratedTerminalShell.id,
          label: integratedTerminalShell.label,
          path: integratedTerminalShell.path,
          source: "system" as const,
        })
      : undefined;
  const visibleIntegratedTerminalShellOptions = selectedIntegratedTerminalShellOption
    ? [
        selectedIntegratedTerminalShellOption,
        ...integratedTerminalShellOptions.filter(
          (option) => option.id !== selectedIntegratedTerminalShellOption.id,
        ),
      ]
    : integratedTerminalShellOptions;

  const handleTerminalFontFamilySave = useCallback(async () => {
    await onTerminalFontFamilyChange(normalizedTerminalFontFamily);
  }, [normalizedTerminalFontFamily, onTerminalFontFamilyChange]);

  const handleIntegratedTerminalShellChange = useCallback(
    async (value: string) => {
      if (value === "auto") {
        await onIntegratedTerminalShellChange({ mode: "auto" });
        return;
      }
      const option = visibleIntegratedTerminalShellOptions.find(
        (candidate) => candidate.id === value,
      );
      if (!option) {
        return;
      }
      await onIntegratedTerminalShellChange({
        mode: "shell",
        dialect: option.dialect,
        id: option.id,
        label: option.label,
        path: option.path,
      });
    },
    [onIntegratedTerminalShellChange, visibleIntegratedTerminalShellOptions],
  );

  const proxyListEntries = Array.from(
    new Set(
      [...httpProxyList.split(/\r?\n/u), httpProxy].map((proxy) => proxy.trim()).filter(Boolean),
    ),
  );
  const [proxyDialogOpen, setProxyDialogOpen] = useState(false);
  const [proxyRows, setProxyRows] = useState<string[]>(proxyListEntries);
  const [proxyChecks, setProxyChecks] = useState<
    Record<
      number,
      | { state: "checking" }
      | { state: "ok"; ip: string }
      | {
          state: "error";
          reason: "invalid_proxy" | "connection_failed" | "timeout" | "invalid_response";
        }
    >
  >({});
  const proxyTestRunRef = useRef(0);

  useEffect(() => {
    proxyTestRunRef.current += 1;
    setProxyRows(proxyListEntries);
    setProxyChecks({});
  }, [httpProxy, httpProxyList]);

  const normalizeProxyRow = (raw: string) => {
    const value = raw.trim();
    const shorthand = value.match(/^([^:/\s]+):(\d+):([^:]*):(.*)$/u);
    if (shorthand) {
      return `socks5://${encodeURIComponent(shorthand[3] ?? "")}:${encodeURIComponent(shorthand[4] ?? "")}@${shorthand[1]}:${shorthand[2]}`;
    }
    return value.replace(/^socks:\/\//iu, "socks5://");
  };

  const handleProxyTestsAll = async () => {
    const testProxy = platform?.testProxyConnectivity;
    if (!testProxy) return;
    const entries = proxyRows
      .map((proxy, index) => ({ index, endpoint: normalizeProxyRow(proxy) }))
      .filter((entry) => entry.endpoint);
    if (!entries.length) return;

    const runId = ++proxyTestRunRef.current;
    setProxyChecks(Object.fromEntries(entries.map(({ index }) => [index, { state: "checking" }])));
    const results = await Promise.all(
      entries.map(async ({ index, endpoint }) => {
        const result = await testProxy(endpoint).catch(() => ({
          ok: false as const,
          reason: "connection_failed" as const,
        }));
        return [
          index,
          result.ok
            ? { state: "ok" as const, ip: result.outboundIp }
            : { state: "error" as const, reason: result.reason },
        ] as const;
      }),
    );
    if (proxyTestRunRef.current !== runId) return;
    setProxyChecks(Object.fromEntries(results));
  };

  const handleProxyListSave = async () => {
    proxyTestRunRef.current += 1;
    const normalized = Array.from(new Set(proxyRows.map(normalizeProxyRow).filter(Boolean))).join(
      "\n",
    );
    await onHttpProxyListChange(normalized);
    setProxyRows(normalized ? normalized.split("\n") : []);
    setProxyChecks({});
    setProxyDialogOpen(false);
  };

  const handleProxyUse = async (index: number) => {
    const endpoint = normalizeProxyRow(proxyRows[index] ?? "");
    if (endpoint && proxyListEntries.includes(endpoint)) {
      await onHttpProxyChange(endpoint);
    }
  };

  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  const normalizedHttpProxyNoProxy = localHttpProxyNoProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.locale" })}
          description={intl.formatMessage({ id: "settings.localeDescription" })}
          control={
            <Select
              value={localePreference}
              onValueChange={(value) => setLocalePreference(value as LocalePreference)}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_LOCALE_SELECT_TRIGGER}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="system"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system")}
                >
                  {intl.formatMessage({ id: "settings.locale.system" })}
                </SelectItem>
                <SelectItem
                  value="zh-CN"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "zh-CN")}
                >
                  {intl.formatMessage({ id: "settings.locale.zh-CN" })}
                </SelectItem>
                <SelectItem
                  value="en-US"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "en-US")}
                >
                  {intl.formatMessage({ id: "settings.locale.en-US" })}
                </SelectItem>
                <SelectItem
                  value="ru-RU"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "ru-RU")}
                >
                  {intl.formatMessage({ id: "settings.locale.ru-RU" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          controlLayout="wide"
          label={intl.formatMessage({ id: "settings.interfaceMode" })}
          description={intl.formatMessage({
            id: "settings.interfaceMode.description",
          })}
          control={
            <Select
              value={interfaceMode}
              onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
            >
              <SelectTrigger
                size="lg"
                className="w-full min-w-0 sm:w-64"
                aria-label={intl.formatMessage({
                  id: "settings.interfaceMode",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coding">
                  {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                </SelectItem>
                <SelectItem value="office">
                  {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        {hasServices ? <ProactiveSuggestionsSetting /> : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.terminalProfile" })}
          description={intl.formatMessage({
            id: "settings.terminalProfileDescription",
          })}
          control={
            <Switch
              checked={terminalInheritSystemProfile}
              onCheckedChange={(checked) => {
                void onTerminalInheritSystemProfileChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.terminalFontFamily" })}
          description={intl.formatMessage({
            id: "settings.terminalFontFamilyDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isTerminalFontFamilyDirty}
              onClick={() => void handleTerminalFontFamilySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localTerminalFontFamily}
              placeholder={intl.formatMessage({
                id: "settings.terminalFontFamilyPlaceholder",
              })}
              onChange={(event) => {
                setLocalTerminalFontFamily(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isTerminalFontFamilyDirty) {
                  void handleTerminalFontFamilySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {showIntegratedTerminalShell ? (
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.integratedTerminalShell",
            })}
            description={intl.formatMessage({
              id: "settings.integratedTerminalShellDescription",
            })}
            control={
              <Select
                value={integratedTerminalShellValue}
                onValueChange={(value) => {
                  void handleIntegratedTerminalShellChange(value);
                }}
              >
                <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {intl.formatMessage({
                      id: "settings.integratedTerminalShell.auto",
                    })}
                  </SelectItem>
                  {visibleIntegratedTerminalShellOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        ) : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.workspaceBoundary" })}
          description={intl.formatMessage({
            id: "settings.workspaceBoundaryDescription",
          })}
          control={
            <Select
              value={workspaceBoundary}
              onValueChange={(value) => {
                if (value === "strict" || value === "ask" || value === "allow") {
                  onWorkspaceBoundaryChange(value);
                }
              }}
            >
              <SelectTrigger size="lg" className="w-[220px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["strict", "ask", "allow"] as const).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {intl.formatMessage({ id: `settings.workspaceBoundary.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolSearch" })}
          description={intl.formatMessage({
            id: "settings.toolSearchDescription",
          })}
          detail={
            <p className="text-ui-sm leading-5 text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.toolSearchExperimentalNotice",
              })}
            </p>
          }
          control={
            <Select
              value={toolSearchMode}
              onValueChange={(value) => {
                void onToolSearchModeChange(appToolSearchModeSchema.parse(value));
              }}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_TOOL_SEARCH_SELECT}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {appToolSearchModeSchema.options.map((mode) => (
                  <SelectItem
                    key={mode}
                    value={mode}
                    data-testid={testId(TID_SETTINGS_TOOL_SEARCH_OPTION, mode)}
                  >
                    {intl.formatMessage({ id: `settings.toolSearch.${mode}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.nativeSearchEnhancements",
          })}
          description={intl.formatMessage({
            id: "settings.nativeSearchEnhancementsDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.nativeSearchEnhancements",
              })}
              checked={nativeSearchEnhancementsEnabled}
              data-testid={TID_SETTINGS_NATIVE_SEARCH_SWITCH}
              onCheckedChange={(checked) => {
                void onNativeSearchEnhancementsEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyList" })}
          description={intl.formatMessage({
            id: "settings.httpProxyListDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              data-testid="settings-http-proxy-manage"
              onClick={() => {
                proxyTestRunRef.current += 1;
                setProxyRows(proxyListEntries);
                setProxyChecks({});
                setProxyDialogOpen(true);
              }}
            >
              <Plus className="mr-2 size-4" />
              {intl.formatMessage({ id: "settings.httpProxyManage" })}
            </Button>
          }
          detail={
            <div className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.httpProxyActive" })}:{" "}
              {sanitizeProxyRouteForDisplay(httpProxy) ||
                intl.formatMessage({ id: "settings.httpProxyDirect" })}
            </div>
          }
        />
        <Dialog open={proxyDialogOpen} onOpenChange={setProxyDialogOpen}>
          <DialogContent className="max-h-[min(85vh,760px)] max-w-3xl grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0">
            <DialogHeader className="border-b border-popover-border px-5 py-4 pr-12">
              <DialogTitle>{intl.formatMessage({ id: "settings.httpProxyManage" })}</DialogTitle>
              <DialogDescription>
                {intl.formatMessage({
                  id: "settings.httpProxyDialogDescription",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 space-y-3 overflow-y-auto p-5">
              <Textarea
                aria-label={intl.formatMessage({
                  id: "settings.httpProxyListEditor",
                })}
                data-testid="settings-proxy-list-editor"
                value={proxyRows.join("\n")}
                placeholder={intl.formatMessage({
                  id: "settings.httpProxyListPlaceholder",
                })}
                onChange={(event) => {
                  proxyTestRunRef.current += 1;
                  setProxyRows(event.currentTarget.value.split(/\r?\n/u));
                  setProxyChecks({});
                }}
                className="min-h-36 resize-y font-mono"
                spellCheck={false}
              />
              {proxyRows.map((proxy, index) => {
                if (!proxy.trim()) return null;
                const check = proxyChecks[index];
                return (
                  <div
                    key={index}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                    data-testid={`settings-proxy-row-${index}`}
                  >
                    <div className="min-w-[220px] flex-1 break-all font-mono text-ui-sm">
                      {normalizeProxyRow(proxy)}
                    </div>
                    <Button
                      type="button"
                      variant={httpProxy === normalizeProxyRow(proxy) ? "secondary" : "outline"}
                      disabled={
                        !proxy.trim() || !proxyListEntries.includes(normalizeProxyRow(proxy))
                      }
                      data-testid={`settings-proxy-use-${index}`}
                      onClick={() => void handleProxyUse(index)}
                    >
                      {httpProxy === normalizeProxyRow(proxy) ? (
                        <Check className="mr-2 size-4" />
                      ) : null}
                      {intl.formatMessage({ id: "settings.httpProxyUse" })}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={intl.formatMessage({
                        id: "settings.httpProxyRemove",
                      })}
                      data-testid={`settings-proxy-remove-${index}`}
                      onClick={() => {
                        proxyTestRunRef.current += 1;
                        setProxyRows((current) =>
                          current.filter((_row, rowIndex) => rowIndex !== index),
                        );
                        setProxyChecks({});
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                    {check?.state === "ok" ? (
                      <div
                        className="flex w-full items-center gap-2 text-ui-sm text-success"
                        data-testid={`settings-proxy-status-${index}`}
                      >
                        <span
                          className="size-2 shrink-0 rounded-full bg-success"
                          aria-hidden="true"
                        />
                        {intl.formatMessage({ id: "settings.httpProxyWorking" }, { ip: check.ip })}
                      </div>
                    ) : check?.state === "error" ? (
                      <div
                        className="flex w-full items-center gap-2 text-ui-sm text-destructive"
                        data-testid={`settings-proxy-status-${index}`}
                      >
                        <span
                          className="size-2 shrink-0 rounded-full bg-destructive"
                          aria-hidden="true"
                        />
                        {intl.formatMessage({
                          id:
                            check.reason === "timeout"
                              ? "settings.httpProxyFailedTimeout"
                              : check.reason === "invalid_response"
                                ? "settings.httpProxyFailedResponse"
                                : check.reason === "invalid_proxy"
                                  ? "settings.httpProxyFailedInvalid"
                                  : "settings.httpProxyFailedConnection",
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <DialogFooter className="border-t border-popover-border px-5 py-4 sm:justify-between">
              <div className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.httpProxyCurrent" })}:{" "}
                {sanitizeProxyRouteForDisplay(httpProxy) ||
                  intl.formatMessage({ id: "settings.httpProxyDirect" })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="settings-proxy-use-direct"
                  onClick={() => void onHttpProxyChange("")}
                >
                  {intl.formatMessage({ id: "settings.httpProxyUseDirect" })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  data-testid="settings-proxy-test-all"
                  disabled={
                    !proxyRows.some((proxy) => normalizeProxyRow(proxy)) ||
                    Object.values(proxyChecks).some((check) => check.state === "checking") ||
                    !platform?.testProxyConnectivity
                  }
                  onClick={() => void handleProxyTestsAll()}
                >
                  {intl.formatMessage({
                    id: Object.values(proxyChecks).some((check) => check.state === "checking")
                      ? "settings.httpProxyTestingAll"
                      : "settings.httpProxyTestAll",
                  })}
                </Button>
                <Button
                  type="button"
                  data-testid="settings-proxy-save"
                  disabled={
                    proxyRows.map(normalizeProxyRow).filter(Boolean).join("\n") === httpProxyList
                  }
                  onClick={() => void handleProxyListSave()}
                >
                  {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
          description={intl.formatMessage({
            id: "settings.httpProxyNoProxyDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyNoProxyDirty}
              onClick={() => void handleHttpProxyNoProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyNoProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyNoProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyNoProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                  void handleHttpProxyNoProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* 自定义 CA 属于 HTTP 代理的同一网络出口策略，必须跟代理输入放在同一卡片里。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
          description={intl.formatMessage({
            id: "settings.httpProxyCaCertPathDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyCaCertPathDirty}
              onClick={() => void handleHttpProxyCaCertPathSave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyCaCertPath}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyCaCertPathPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyCaCertPath(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                  void handleHttpProxyCaCertPathSave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      {/* 并行度只是可选的更低上限；0/空值使用主机可用并行度。 */}
      <SettingsGroupCard>
        <RunLimitSettingRow
          labelId="settings.subagentMaxParallel"
          descriptionId="settings.subagentMaxParallelDescription"
          invalidId="settings.subagentMaxParallelInvalid"
          placeholder={intl.formatMessage({ id: "settings.runLimitPlaceholder" })}
          testId="settings-subagent-max-parallel"
          value={subagentMaxParallel}
          onSave={onSubagentMaxParallelChange}
        />
        <RunLimitSettingRow
          labelId="settings.subagentTaskTimeoutMinutes"
          descriptionId="settings.subagentTaskTimeoutMinutesDescription"
          invalidId="settings.subagentTaskTimeoutMinutesInvalid"
          placeholder={intl.formatMessage({ id: "settings.runLimitPlaceholder" })}
          testId="settings-subagent-task-timeout"
          value={subagentTaskTimeoutMinutes}
          onSave={onSubagentTaskTimeoutMinutesChange}
        />
      </SettingsGroupCard>

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
          control={
            <Switch checked={notificationEnabled} onCheckedChange={setNotificationEnabled} />
          }
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

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.dataBaseDir" })}
          description={intl.formatMessage({
            id: "settings.dataBaseDirDescription",
          })}
          control={
            <DataBaseDirControl
              dataBaseDir={dataBaseDir}
              defaultHomeDir={defaultHomeDir}
              onDataBaseDirChange={onDataBaseDirChange}
              onSelectDataBaseDir={onSelectDataBaseDir}
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.onboarding" })}
          description={intl.formatMessage({
            id: "settings.onboardingDescription",
          })}
          control={
            <Button type="button" size="lg" variant="outline" onClick={onOpenOnboardingDialog}>
              {intl.formatMessage({ id: "settings.onboardingOpen" })}
            </Button>
          }
        />
      </SettingsGroupCard>
    </div>
  );
}

export function GeneralSectionHeader({ localePreference }: { localePreference: LocalePreference }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <SettingsBadge>
        {intl.formatMessage({ id: `settings.locale.${localePreference}` })}
      </SettingsBadge>
    </div>
  );
}
