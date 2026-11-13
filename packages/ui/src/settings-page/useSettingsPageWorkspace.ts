// SettingsPage 拆分（max-lines）：当前 workspace / Host 服务绑定、模型供应商跳转目标与共享设置快照。
// 钩子顺序保持拆分前：个人模型配置目标 → 分区导航 → tab store → Host 服务 → 共享设置 → Source 管理。
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  consumePendingSettingsModelProviderTarget,
  resolveSettingsSection,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import type { TabId } from "@zcode/shared";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import { resolveRemoteConnectionNavigationPresentation } from "@/lib/remoteConnectionPresentation.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";

export interface SettingsPageWorkspaceOptions {
  activeSection: SettingsSectionId;
  isDesktop?: boolean;
  setActiveSection: Dispatch<SetStateAction<SettingsSectionId>>;
}

export interface SettingsPageWorkspaceState {
  pendingModelProviderTarget: SettingsModelProviderTarget | undefined;
  setPendingModelProviderTarget: (target: SettingsModelProviderTarget | undefined) => void;
  requestOnboardingDialog: () => void;
  setActiveSettingsSection: (
    section: SettingsSectionId,
    fallbackSection?: SettingsSectionId,
  ) => void;
  handleOpenCodingPlanUpgradeSettings: (
    providerId: string,
    funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext,
  ) => void;
  handleOpenModelProviderSettings: () => void;
  handleOpenUsageSettings: () => void;
  activeWorkspacePath: string | null;
  activateTab: (tabId: TabId) => void;
  openSettingsTab: () => void;
  workspaceTabs: WorkspaceTabState[];
  activeWorkspaceIdentity: string | undefined;
  activeWorkspaceTab: WorkspaceTabState | null;
  localModelProviderConnectivityWorkspacePath: ReturnType<
    typeof resolveModelProviderConnectivityWorkspacePath
  >;
  isRemoteModelProviderWorkspace: boolean;
  selectDirectory: ReturnType<typeof useSelectDirectory>;
  services: ReturnType<typeof useServices>;
  onboardingRecordService: ReturnType<typeof useServices>["onboardingRecordService"];
  localHostServices: ReturnType<typeof useBaseWorkspaceServices>;
  projectDirectory: ReturnType<typeof useOptionalProjectDirectory>;
  sharedSettings: ReturnType<typeof useSettings>["settings"];
  updateSharedSettings: ReturnType<typeof useSettings>["update"];
  telemetryEnabled: boolean;
  workspaceBoundary: NonNullable<ReturnType<typeof useSettings>["settings"]>["workspaceBoundary"];
  sourceManagement: ReturnType<typeof useBaseWorkspaceServices>["sourceServerManagementService"];
  sourceManagementSnapshot: ReturnType<typeof useSourceServerManagementSnapshot>["snapshot"];
  remoteDevicesPresentation: ReturnType<typeof resolveRemoteConnectionNavigationPresentation>;
  memoryWorkspaceDisplayNames: string[];
  memoryEnabled: boolean;
  toolSearchMode: NonNullable<ReturnType<typeof useSettings>["settings"]>["toolSearchMode"];
  nativeSearchEnhancementsEnabled: boolean;
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled: boolean;
}

export function useSettingsPageWorkspace({
  activeSection,
  isDesktop,
  setActiveSection,
}: SettingsPageWorkspaceOptions): SettingsPageWorkspaceState {
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const setNewUserOnboardingOpen = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  const requestOnboardingDialog = () => setNewUserOnboardingOpen(true);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      const resolvedSection = resolveSettingsSection(section, fallbackSection);
      setActiveSection(resolvedSection);
      writeLastSettingsSectionPreference(resolvedSection);
    },
    [activeSection, setActiveSection],
  );
  useEffect(() => {
    if (!isDesktop && activeSection === "remoteDevices") {
      setActiveSettingsSection("general");
    }
  }, [activeSection, isDesktop, setActiveSettingsSection]);
  const handleOpenCodingPlanUpgradeSettings = useCallback(
    (
      providerId: string,
      funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext,
    ) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext,
      });
    },
    [openCodingPlanUpgrade],
  );
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const handleOpenUsageSettings = useCallback(() => {
    // 设置页 sidebar footer 里的齿轮/返回按钮复用 onBack，
    // 但头像菜单的“使用统计”应该停留在设置页并切到 Usage，不能跟着返回工作区。
    setActiveSettingsSection("usage");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activateTab = useTabStore((state) => state.activateTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const selectDirectory = useSelectDirectory();
  const services = useServices();
  const onboardingRecordService = services.onboardingRecordService;
  const localHostServices = useBaseWorkspaceServices();
  const projectDirectory = useOptionalProjectDirectory();
  // SettingsPage 可能挂在远端 workspace 的 ServiceProvider 下；共享设置属于本机 Host，
  // 读写必须固定走本机 settingService，否则会写进远端 setting。
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings({
    services: localHostServices,
  });
  // 隐私开关：undefined 视为 включено (историческое поведение), явный false отключает отправку.
  const telemetryEnabled = sharedSettings?.telemetryEnabled !== false;
  const workspaceBoundary = sharedSettings?.workspaceBoundary ?? "allow";
  const sourceManagement = localHostServices.sourceServerManagementService;
  const { snapshot: sourceManagementSnapshot } = useSourceServerManagementSnapshot(
    sourceManagement,
    {
      onError: (error) =>
        logger.warn("[SettingsPage] 读取 Source 状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  const remoteDevicesPresentation = useMemo(
    () => resolveRemoteConnectionNavigationPresentation(sourceManagementSnapshot),
    [sourceManagementSnapshot],
  );
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  const memoryEnabled = sharedSettings?.memoryEnabled === true;
  const toolSearchMode = sharedSettings?.toolSearchMode ?? "off";
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;

  return {
    pendingModelProviderTarget,
    setPendingModelProviderTarget,
    requestOnboardingDialog,
    setActiveSettingsSection,
    handleOpenCodingPlanUpgradeSettings,
    handleOpenModelProviderSettings,
    handleOpenUsageSettings,
    activeWorkspacePath,
    activateTab,
    openSettingsTab,
    workspaceTabs,
    activeWorkspaceIdentity,
    activeWorkspaceTab,
    localModelProviderConnectivityWorkspacePath,
    isRemoteModelProviderWorkspace,
    selectDirectory,
    services,
    onboardingRecordService,
    localHostServices,
    projectDirectory,
    sharedSettings,
    updateSharedSettings,
    telemetryEnabled,
    workspaceBoundary,
    sourceManagement,
    sourceManagementSnapshot,
    remoteDevicesPresentation,
    memoryWorkspaceDisplayNames,
    memoryEnabled,
    toolSearchMode,
    nativeSearchEnhancementsEnabled,
    askUserQuestionAutoResolutionEnabled,
    modelIoFullRetentionEnabled,
  };
}
