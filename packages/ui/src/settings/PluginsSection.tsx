/**
 * 设置页 Plugin 能力外壳：Scope 选择、Plugins/MCP/Skills/Commands 标签与导航上报。
 *
 * 视图实现拆分在 `plugins-section/`：列表由 `PluginList` 承载，工具条与空状态同目录复用；
 * 本文件只保留 Scope/tab 状态、编辑器锁定的 target 解析与标签内容编排。
 */
import { useConfigWorkspaceTargets } from "@/workspace-config-catalog/index.js";
import { SettingsUserScopeProvider } from "@/settings/SettingsMachine.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs.js";
import { toast } from "@/components/ui/toast.js";
import { getPathLeaf } from "@/lib/path.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { PluginList } from "@/settings/plugins-section/PluginList.js";
import { PluginsSectionEmptyState } from "@/settings/plugins-section/PluginsSectionEmptyState.js";
import { PluginsSectionToolbar } from "@/settings/plugins-section/PluginsSectionToolbar.js";
import {
  normalizePluginTab,
  workspaceKey,
  type PluginScope,
  type PluginTab,
  type PluginTabTarget,
  type PluginsSectionProps,
} from "@/settings/plugins-section/pluginsSectionTypes.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

export function PluginsSection({
  onScopeChange,
  onOpenUi,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isWebRemoteControl = false,
  initialTab = "plugins",
  initialScopeKey,
  mode = "plugin",
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  settingsSourceServerId,
  settingsSourceUserWorkspacePath,
}: PluginsSectionProps) {
  const { intl } = useZCodeIntl();
  const storeActiveWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activeWorkspacePath = workspacePath ?? storeActiveWorkspacePath;
  const activeWorkspaceIdentity = workspaceIdentity ?? storeActiveWorkspaceIdentity ?? undefined;
  const currentServices = useServices();
  const workspaceTabs = useConfigWorkspaceTargets(settingsSourceServerId);
  const preferredHost = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          workspaceKey(tab) === (activeWorkspaceIdentity?.trim() || activeWorkspacePath || ""),
      ) ??
      workspaceTabs[0] ??
      (activeWorkspacePath
        ? {
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            label: getPathLeaf(activeWorkspacePath) || activeWorkspacePath,
          }
        : null),
    [activeWorkspaceIdentity, activeWorkspacePath, workspaceTabs],
  );
  const sourceUserScopeTarget = useMemo<ConfigWorkspaceTarget | null>(() => {
    if (!settingsSourceServerId || !settingsSourceUserWorkspacePath?.trim()) return null;
    return {
      label: settingsSourceUserWorkspacePath,
      workspacePath: settingsSourceUserWorkspacePath,
    };
  }, [settingsSourceServerId, settingsSourceUserWorkspacePath]);
  const userScopeTarget = settingsSourceServerId ? sourceUserScopeTarget : preferredHost;
  const sourceUserCacheAuthorityKey = settingsSourceServerId
    ? `source-settings:${settingsSourceServerId}`
    : undefined;
  const [pickedScopeKey, setPickedScopeKey] = useState(() => initialScopeKey?.trim() || "user");
  useEffect(() => {
    onScopeChange?.(pickedScopeKey);
  }, [onScopeChange, pickedScopeKey]);
  const selectedScopeKey = pickedScopeKey;
  const fixedTab: PluginTabTarget | null =
    mode === "market"
      ? "plugins"
      : mode === "mcp"
        ? "mcps"
        : mode === "skill"
          ? "skills"
          : mode === "command"
            ? "commands"
            : null;
  const [interactiveTab, setInteractiveTab] = useState<PluginTab>(() =>
    normalizePluginTab(initialTab),
  );
  useEffect(() => setInteractiveTab(normalizePluginTab(initialTab)), [initialTab]);
  useEffect(() => {
    setPickedScopeKey(initialScopeKey?.trim() || "user");
  }, [initialScopeKey]);
  const selectedTab = fixedTab ?? interactiveTab;
  const [searchQueries, setSearchQueries] = useState<Record<PluginTabTarget, string>>({
    plugins: "",
    mcps: "",
    skills: "",
    commands: "",
  });
  const [capabilityCounts, setCapabilityCounts] = useState<Record<PluginTabTarget, number>>({
    plugins: 0,
    mcps: 0,
    skills: 0,
    commands: 0,
  });
  const [mcpEditorOpen, setMcpEditorOpen] = useState(false);
  const [skillDetailOpen, setSkillDetailOpen] = useState(false);
  const [mcpFormScopeKey, setMcpFormScopeKey] = useState<string | null>(null);
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [commandEditorOpen, setCommandEditorOpen] = useState(false);
  const [commandFormScopeKey, setCommandFormScopeKey] = useState<string | null>(null);
  const activeSearchQuery = searchQueries[selectedTab];
  const selectedScope: PluginScope = useMemo(() => {
    const tab = workspaceTabs.find((candidate) => workspaceKey(candidate) === selectedScopeKey);
    return tab ? { kind: "workspace", key: workspaceKey(tab), tab } : { kind: "user", key: "user" };
  }, [selectedScopeKey, workspaceTabs]);
  const openPluginStoreForSelectedScope = useCallback(
    (_returnScopeKey?: string, intent?: "add-marketplace") => {
      // Workspace 是已安装 Plugin 的配置视图，不提供 Marketplace 入口；市场只在 User
      // 视图中负责 package/cache 生命周期。
      if (selectedScope.kind !== "user") return;
      onOpenPluginStore("user", intent);
    },
    [onOpenPluginStore, selectedScope.kind],
  );
  const target = selectedScope.kind === "workspace" ? selectedScope.tab : userScopeTarget;
  const effectiveMcpScopeKey =
    mcpEditorOpen && mcpFormScopeKey ? mcpFormScopeKey : selectedScopeKey;
  const effectiveMcpWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveMcpScopeKey,
  );
  // 编辑器锁定的 Workspace 断连后，回退 preferredHost 会把保存请求发到
  // 另一个项目。失效当帧先移除写入目标，随后 effect 关闭编辑器，避免配置写错位置。
  const mcpEditorWorkspaceMissing = Boolean(
    mcpEditorOpen && mcpFormScopeKey && mcpFormScopeKey !== "user" && !effectiveMcpWorkspace,
  );
  const mcpTarget = mcpEditorWorkspaceMissing ? null : (effectiveMcpWorkspace ?? userScopeTarget);
  const effectiveCommandScopeKey =
    commandEditorOpen && commandFormScopeKey ? commandFormScopeKey : selectedScopeKey;
  const effectiveCommandWorkspace = workspaceTabs.find(
    (tab) => workspaceKey(tab) === effectiveCommandScopeKey,
  );
  const commandEditorWorkspaceMissing = Boolean(
    commandEditorOpen &&
    commandFormScopeKey &&
    commandFormScopeKey !== "user" &&
    !effectiveCommandWorkspace,
  );
  const commandTarget = commandEditorWorkspaceMissing
    ? null
    : (effectiveCommandWorkspace ?? userScopeTarget);

  useEffect(() => {
    if (!mcpEditorWorkspaceMissing) return;
    setMcpEditorOpen(false);
    setMcpFormScopeKey(null);
  }, [mcpEditorWorkspaceMissing]);

  useEffect(() => {
    if (!commandEditorWorkspaceMissing) return;
    setCommandEditorOpen(false);
    setCommandFormScopeKey(null);
  }, [commandEditorWorkspaceMissing]);

  useEffect(() => {
    if (
      pickedScopeKey !== "user" &&
      !workspaceTabs.some((tab) => workspaceKey(tab) === pickedScopeKey)
    ) {
      // 市场返回记录的是具体 workspace identity；目标已关闭或断连时，
      // 静默选中 User 会让用户误以为 Workspace 配置仍在展示，因此提示并显式切换。
      setPickedScopeKey("user");
      toast(
        intl.formatMessage({
          id: "settings.plugin.scopeUnavailableFallback",
        }),
      );
    }
  }, [intl, pickedScopeKey, workspaceTabs]);
  const selectedTargetKey = target ? workspaceKey(target) : "";

  const updatePluginCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.plugins === count ? current : { ...current, plugins: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateMcpCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.mcps === count ? current : { ...current, mcps: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateSkillCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.skills === count ? current : { ...current, skills: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const updateCommandCount = useCallback(
    (count: number) => {
      setCapabilityCounts((current) =>
        current.commands === count ? current : { ...current, commands: count },
      );
    },
    [selectedScope.key, selectedTargetKey],
  );
  const handleMcpEditorOpenChange = useCallback((open: boolean) => {
    setMcpEditorOpen(open);
    if (!open) setMcpFormScopeKey(null);
  }, []);
  const updateActiveSearchQuery = (value: string) => {
    setSearchQueries((current) => ({
      ...current,
      [selectedTab]: value,
    }));
  };

  return (
    <SettingsUserScopeProvider target={userScopeTarget} sourceServerId={settingsSourceServerId}>
      <div className="space-y-6">
        {mode === "plugin" &&
        showMarketplaceBreadcrumb &&
        !pluginDetailOpen &&
        !mcpEditorOpen &&
        !skillDetailOpen ? (
          <SettingsBreadcrumbReporter
            items={[
              {
                label: intl.formatMessage({
                  id: "settings.plugins.title",
                }),
              },
            ]}
            onSectionSelect={openPluginStoreForSelectedScope}
          />
        ) : null}
        <Tabs
          value={selectedTab}
          onValueChange={(value) => {
            if (mode === "plugin") {
              setInteractiveTab(normalizePluginTab(value as PluginTabTarget));
            }
          }}
        >
          {!mcpEditorOpen && !pluginDetailOpen && !commandEditorOpen ? (
            <PluginsSectionToolbar
              mode={mode}
              selectedTab={selectedTab}
              capabilityCounts={capabilityCounts}
              selectedScopeKey={selectedScopeKey}
              workspaceTabs={workspaceTabs}
              userScopeTarget={userScopeTarget}
              settingsSourceServerId={settingsSourceServerId}
              activeSearchQuery={activeSearchQuery}
              onScopeKeyChange={setPickedScopeKey}
              onSearchQueryChange={updateActiveSearchQuery}
              onSearchClear={() => updateActiveSearchQuery("")}
            />
          ) : null}
          {mode === "plugin" || mode === "market" ? (
            <TabsContent
              forceMount
              value="plugins"
              className={
                pluginDetailOpen
                  ? "data-[state=inactive]:hidden"
                  : "mt-6 data-[state=inactive]:hidden"
              }
            >
              <PluginList
                inMarketplace={mode === "market"}
                onOpenUi={onOpenUi}
                target={target}
                configScope={selectedScope.kind === "user" ? "user" : "workspace"}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                isWebRemoteControl={isWebRemoteControl}
                searchQuery={searchQueries.plugins}
                onAdd={selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined}
                onCreateTask={onCreateTask}
                onDetailOpenChange={setPluginDetailOpen}
                onOpenPluginStore={openPluginStoreForSelectedScope}
                showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                onVisibleCountChange={updatePluginCount}
                unscopedServices={
                  settingsSourceServerId && selectedScope.kind === "user"
                    ? currentServices
                    : undefined
                }
                cacheAuthorityKey={
                  settingsSourceServerId && selectedScope.kind === "user"
                    ? sourceUserCacheAuthorityKey
                    : undefined
                }
              />
            </TabsContent>
          ) : null}
          {mode === "plugin" || mode === "mcp" ? (
            <TabsContent
              forceMount
              value="mcps"
              className={
                mcpEditorOpen ? "data-[state=inactive]:hidden" : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {mcpTarget ? (
                <McpSettingsSection
                  workspacePath={mcpTarget.workspacePath}
                  workspaceIdentity={mcpTarget.workspaceIdentity}
                  remoteSessionId={mcpTarget.remoteSessionId}
                  remoteTarget={mcpTarget.remoteTarget}
                  localWorkspacePath={mcpTarget.localWorkspacePath}
                  isWebRemoteControl={isWebRemoteControl}
                  scopeFilter={effectiveMcpScopeKey === "user" ? "user" : "workspace"}
                  parentScopeKey={selectedScopeKey}
                  workspaceTabs={workspaceTabs}
                  searchQuery={searchQueries.mcps}
                  onVisibleCountChange={updateMcpCount}
                  onEditorOpenChange={handleMcpEditorOpenChange}
                  onFormScopeKeyChange={setMcpFormScopeKey}
                  onOpenPluginStore={
                    selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                  }
                  showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                  unscopedServices={
                    settingsSourceServerId && effectiveMcpScopeKey === "user"
                      ? currentServices
                      : undefined
                  }
                  cacheAuthorityKey={
                    settingsSourceServerId && effectiveMcpScopeKey === "user"
                      ? sourceUserCacheAuthorityKey
                      : undefined
                  }
                />
              ) : (
                <PluginsSectionEmptyState
                  message={intl.formatMessage({
                    id: "settings.plugin.noWorkspace",
                  })}
                />
              )}
            </TabsContent>
          ) : null}
          {mode === "plugin" || mode === "skill" ? (
            <TabsContent forceMount value="skills" className="mt-6 data-[state=inactive]:hidden">
              {target ? (
                <SkillsSection
                  workspacePath={target.workspacePath}
                  workspaceIdentity={target.workspaceIdentity}
                  remoteSessionId={target.remoteSessionId}
                  remoteTarget={target.remoteTarget}
                  isWebRemoteControl={isWebRemoteControl}
                  scopeFilter={selectedScope.kind === "user" ? "user" : "workspace"}
                  searchQuery={searchQueries.skills}
                  onCreateTask={onCreateTask}
                  onDetailOpenChange={setSkillDetailOpen}
                  onOpenPluginStore={
                    selectedScope.kind === "user" ? openPluginStoreForSelectedScope : undefined
                  }
                  showMarketplaceBreadcrumb={showMarketplaceBreadcrumb}
                  reportDetailBreadcrumb={mode === "plugin"}
                  onVisibleCountChange={updateSkillCount}
                  unscopedServices={
                    settingsSourceServerId && selectedScope.kind === "user"
                      ? currentServices
                      : undefined
                  }
                  cacheAuthorityKey={
                    settingsSourceServerId && selectedScope.kind === "user"
                      ? sourceUserCacheAuthorityKey
                      : undefined
                  }
                />
              ) : (
                <PluginsSectionEmptyState
                  message={intl.formatMessage({
                    id: "settings.plugin.noWorkspace",
                  })}
                />
              )}
            </TabsContent>
          ) : null}
          {mode === "command" ? (
            <TabsContent
              forceMount
              value="commands"
              className={
                commandEditorOpen
                  ? "data-[state=inactive]:hidden"
                  : "mt-6 data-[state=inactive]:hidden"
              }
            >
              {commandTarget ? (
                <CommandsSection
                  workspacePath={commandTarget.workspacePath}
                  workspaceIdentity={commandTarget.workspaceIdentity}
                  scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
                  parentScopeKey={selectedScopeKey}
                  workspaceTabs={workspaceTabs}
                  searchQuery={searchQueries.commands}
                  onVisibleCountChange={updateCommandCount}
                  onEditorOpenChange={setCommandEditorOpen}
                  onFormScopeKeyChange={setCommandFormScopeKey}
                  unscopedServices={
                    settingsSourceServerId && effectiveCommandScopeKey === "user"
                      ? currentServices
                      : undefined
                  }
                  cacheAuthorityKey={
                    settingsSourceServerId && effectiveCommandScopeKey === "user"
                      ? sourceUserCacheAuthorityKey
                      : undefined
                  }
                />
              ) : (
                <PluginsSectionEmptyState
                  message={intl.formatMessage({
                    id: "settings.plugin.noWorkspace",
                  })}
                />
              )}
            </TabsContent>
          ) : null}
        </Tabs>
      </div>
    </SettingsUserScopeProvider>
  );
}
