// SettingsPage 拆分（max-lines）：设置表单的本地状态。唯一写入口仍是这里，加载/保存由
// useSettingsPageRuntime 与各 handler hook 负责；拆分只移动声明位置，不新增状态副本。
import { useState, type Dispatch, type SetStateAction } from "react";
import type {
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  ZCodeInteractionBehavior,
} from "@zcode/shared";

export interface SettingsFormStateOptions {
  isWindowsDesktop?: boolean;
}

export interface SettingsFormState {
  dataBaseDir: string;
  setDataBaseDir: Dispatch<SetStateAction<string>>;
  terminalInheritSystemProfile: boolean;
  setTerminalInheritSystemProfile: Dispatch<SetStateAction<boolean>>;
  terminalFontFamily: string;
  setTerminalFontFamily: Dispatch<SetStateAction<string>>;
  integratedTerminalShell: IntegratedTerminalShellSelection;
  setIntegratedTerminalShell: Dispatch<SetStateAction<IntegratedTerminalShellSelection>>;
  integratedTerminalShellOptions: IntegratedTerminalShellOption[];
  setIntegratedTerminalShellOptions: Dispatch<SetStateAction<IntegratedTerminalShellOption[]>>;
  httpProxy: string;
  setHttpProxy: Dispatch<SetStateAction<string>>;
  httpProxyList: string;
  setHttpProxyList: Dispatch<SetStateAction<string>>;
  httpProxyNoProxy: string;
  setHttpProxyNoProxy: Dispatch<SetStateAction<string>>;
  httpProxyCaCertPath: string;
  setHttpProxyCaCertPath: Dispatch<SetStateAction<string>>;
  subagentMaxParallel: number | undefined;
  setSubagentMaxParallel: Dispatch<SetStateAction<number | undefined>>;
  subagentTaskTimeoutMinutes: number | undefined;
  setSubagentTaskTimeoutMinutes: Dispatch<SetStateAction<number | undefined>>;
  embeddedBrowserAllowInsecureCertificates: boolean;
  setEmbeddedBrowserAllowInsecureCertificates: Dispatch<SetStateAction<boolean>>;
  taskAutoArchiveEnabled: boolean;
  setTaskAutoArchiveEnabled: Dispatch<SetStateAction<boolean>>;
  taskAutoArchiveOlderThanDays: number;
  setTaskAutoArchiveOlderThanDays: Dispatch<SetStateAction<number>>;
  closeToTrayOnWindows: boolean;
  setCloseToTrayOnWindows: Dispatch<SetStateAction<boolean>>;
  desktopChromiumHardwareAccelerationEnabled: boolean;
  setDesktopChromiumHardwareAccelerationEnabled: Dispatch<SetStateAction<boolean>>;
  receivePreviewUpdates: boolean;
  setReceivePreviewUpdates: Dispatch<SetStateAction<boolean>>;
  autoDownloadAndInstallUpdates: boolean;
  setAutoDownloadAndInstallUpdates: Dispatch<SetStateAction<boolean>>;
  messageStreamShowReasoning: boolean;
  setMessageStreamShowReasoning: Dispatch<SetStateAction<boolean>>;
  messageStreamShowTodos: boolean;
  setMessageStreamShowTodos: Dispatch<SetStateAction<boolean>>;
  toolGroupingExploreEnabled: boolean;
  setToolGroupingExploreEnabled: Dispatch<SetStateAction<boolean>>;
  toolGroupingTerminalEnabled: boolean;
  setToolGroupingTerminalEnabled: Dispatch<SetStateAction<boolean>>;
  toolGroupingChangesEnabled: boolean;
  setToolGroupingChangesEnabled: Dispatch<SetStateAction<boolean>>;
  zcodeInteractionBehavior: ZCodeInteractionBehavior;
  setZCodeInteractionBehavior: Dispatch<SetStateAction<ZCodeInteractionBehavior>>;
  defaultHomeDir: string;
  setDefaultHomeDir: Dispatch<SetStateAction<string>>;
  hostPlatform: string;
  setHostPlatform: Dispatch<SetStateAction<string>>;
}

export function useSettingsFormState({
  isWindowsDesktop,
}: SettingsFormStateOptions): SettingsFormState {
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyList, setHttpProxyList] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [subagentMaxParallel, setSubagentMaxParallel] = useState<number | undefined>(undefined);
  const [subagentTaskTimeoutMinutes, setSubagentTaskTimeoutMinutes] = useState<number | undefined>(
    undefined,
  );
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(30);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(Boolean(isWindowsDesktop));
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  const [receivePreviewUpdates, setReceivePreviewUpdates] = useState(false);
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  const [toolGroupingExploreEnabled, setToolGroupingExploreEnabled] = useState(true);
  const [toolGroupingTerminalEnabled, setToolGroupingTerminalEnabled] = useState(true);
  const [toolGroupingChangesEnabled, setToolGroupingChangesEnabled] = useState(true);
  const [zcodeInteractionBehavior, setZCodeInteractionBehavior] =
    useState<ZCodeInteractionBehavior>("queue");
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  return {
    dataBaseDir,
    setDataBaseDir,
    terminalInheritSystemProfile,
    setTerminalInheritSystemProfile,
    terminalFontFamily,
    setTerminalFontFamily,
    integratedTerminalShell,
    setIntegratedTerminalShell,
    integratedTerminalShellOptions,
    setIntegratedTerminalShellOptions,
    httpProxy,
    setHttpProxy,
    httpProxyList,
    setHttpProxyList,
    httpProxyNoProxy,
    setHttpProxyNoProxy,
    httpProxyCaCertPath,
    setHttpProxyCaCertPath,
    subagentMaxParallel,
    setSubagentMaxParallel,
    subagentTaskTimeoutMinutes,
    setSubagentTaskTimeoutMinutes,
    embeddedBrowserAllowInsecureCertificates,
    setEmbeddedBrowserAllowInsecureCertificates,
    taskAutoArchiveEnabled,
    setTaskAutoArchiveEnabled,
    taskAutoArchiveOlderThanDays,
    setTaskAutoArchiveOlderThanDays,
    closeToTrayOnWindows,
    setCloseToTrayOnWindows,
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
    receivePreviewUpdates,
    setReceivePreviewUpdates,
    autoDownloadAndInstallUpdates,
    setAutoDownloadAndInstallUpdates,
    messageStreamShowReasoning,
    setMessageStreamShowReasoning,
    messageStreamShowTodos,
    setMessageStreamShowTodos,
    toolGroupingExploreEnabled,
    setToolGroupingExploreEnabled,
    toolGroupingTerminalEnabled,
    setToolGroupingTerminalEnabled,
    toolGroupingChangesEnabled,
    setToolGroupingChangesEnabled,
    zcodeInteractionBehavior,
    setZCodeInteractionBehavior,
    defaultHomeDir,
    setDefaultHomeDir,
    hostPlatform,
    setHostPlatform,
  };
}
