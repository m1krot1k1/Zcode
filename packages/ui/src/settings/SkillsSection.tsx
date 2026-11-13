import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodeProvider,
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillsCapability,
  SkillSummary,
} from "@zcode/shared";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { buildSkillMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { resolveUniquePluginListingByName } from "@/settings/pluginStoreListing.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import {
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import { groupSkillsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import { SkillsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  RemoteSyncDialogs,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  groupScopedSkillsBySource,
  selectPluginsForScope,
  selectSkillsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import { SkillDetailDialog } from "@/settings/skills-section/SkillDetailDialog.js";
import { SkillRow } from "@/settings/skills-section/SkillRow.js";
import { SkillsDiagnosticsBanner } from "@/settings/skills-section/SkillsDiagnosticsBanner.js";
import { SkillsInstalledGroup } from "@/settings/skills-section/SkillsInstalledGroup.js";
import { SkillsPluginGroups } from "@/settings/skills-section/SkillsPluginGroups.js";
import { SkillsRemoteSyncAction } from "@/settings/skills-section/SkillsRemoteSyncAction.js";
import {
  SkillsErrorNotice,
  SkillsRemoteContextNotice,
  SkillsUserScopeNotice,
} from "@/settings/skills-section/SkillsStatusNotices.js";
import {
  formatSkillPublishedAt,
  getWorkspaceBasename,
  resolveSkillScopeLabel,
} from "@/settings/skills-section/skillPresentation.js";
import type { SkillsSectionProps } from "@/settings/skills-section/types.js";

export function SkillsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  isWebRemoteControl = false,
  scopeFilter,
  searchQuery,
  onVisibleCountChange,
  onCreateTask,
  onDetailOpenChange,
  onOpenPluginStore,
  showMarketplaceBreadcrumb = false,
  reportDetailBreadcrumb = false,
  unscopedServices,
  cacheAuthorityKey,
}: SkillsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const baseServices = useBaseWorkspaceServices();
  const plugins = usePluginManagementStore((state) => state.plugins);
  const installedPlugins = usePluginManagementStore(
    (state) => state.installedPlugins,
  );
  const availablePlugins = usePluginManagementStore(
    (state) => state.availablePlugins,
  );
  const pluginListingById = useMemo(
    () =>
      new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  const pluginWorkspacePath = usePluginManagementStore(
    (state) => state.workspacePath,
  );
  const pluginWorkspaceIdentity = usePluginManagementStore(
    (state) => state.workspaceIdentity,
  );
  const pluginConfigScope = usePluginManagementStore(
    (state) => state.configScope,
  );
  const initializePlugins = usePluginManagementStore(
    (state) => state.initialize,
  );
  // useConfirmDialog 是纯 Zustand selector（不含 useState），放在这里不会影响 SkillsSection
  // 既有的「按 useState 调用次序」单测桩（见下方 selectedSkill 附近的注释）。
  const confirmDialog = useConfirmDialog();
  const activeWorkspacePath = workspacePath ?? null;
  const activeWorkspaceIdentity = workspaceIdentity;
  const targetServiceResolution = useWorkspaceServicesResolution(
    activeWorkspacePath,
    remoteSessionId,
    activeWorkspaceIdentity,
    remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  // PluginsSection 已把 Scope target 传入，但 Skills 仍从当前 ServiceProvider
  // 取服务，导致跨远程 host 误路由。技能读写和远端同步都改用同一 target 解析结果。
  const { pluginManagementService, skillSyncService, skillsService } =
    targetServiceResolution.services;
  // 单测会按 useState 调用次序注入技能/能力/选中项；这里的顺序即公开的组件契约，勿调整。
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [capability, setCapability] = useState<SkillsCapability | null>(null);
  const [loadedSkillTargetKey, setLoadedSkillTargetKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = searchQuery;
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  useEffect(() => {
    onDetailOpenChange?.(selectedSkill !== null);
  }, [onDetailOpenChange, selectedSkill]);
  const [diagnostics, setDiagnostics] = useState<SkillDiagnostic[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const latestRequestIdRef = useRef(0);
  const activeSkillTargetKey = buildSourceSettingsProjectionKey(
    activeWorkspacePath,
    activeWorkspaceIdentity,
    cacheAuthorityKey,
  );
  const projectionMatchesTarget =
    !activeWorkspacePath || loadedSkillTargetKey === activeSkillTargetKey;

  useEffect(() => {
    if (!activeWorkspacePath || !targetServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    pluginManagementService,
    scopeFilter,
    targetServiceResolution.rpcReady,
  ]);

  const workspaceLabel = getWorkspaceBasename(activeWorkspacePath);
  const connectedRemoteSyncTarget =
    targetServiceResolution.rpcReady &&
    shouldShowRemoteSyncActions({
      remoteSessionId,
      remoteTarget,
      clientMode: isWebRemoteControl
        ? "web-remote-replayable"
        : "desktop-continuous",
      hasLocalSourceService: Boolean(baseServices.skillSyncService),
    }) &&
    activeWorkspacePath
      ? remoteTarget
      : null;
  const remoteSkillSyncTargetLabel = connectedRemoteSyncTarget
    ? formatRemoteSkillSyncTarget(
        connectedRemoteSyncTarget,
        activeWorkspacePath ?? "",
      )
    : "";

  const renderScopeLabel = useCallback(
    (skill: SkillSummary): string =>
      resolveSkillScopeLabel(skill, intl, {
        workspaceLabel,
        locale,
        availablePlugins,
        pluginListingById,
      }),
    [availablePlugins, intl, locale, pluginListingById, workspaceLabel],
  );

  const renderDiagnosticCodeLabel = useCallback(
    (code: SkillDiagnosticCode): string =>
      intl.formatMessage({ id: `settings.skills.diagnostics.code.${code}` }),
    [intl],
  );

  const loadSkills = useCallback(
    async (showBlockingLoading: boolean) => {
      if (!targetServiceResolution.rpcReady) return;
      if (!activeWorkspacePath) {
        setSkills([]);
        setCapability(null);
        setDiagnostics([]);
        setError(null);
        setLoading(false);
        setLoadedSkillTargetKey("");
        return;
      }
      const requestTargetKey = buildSourceSettingsProjectionKey(
        activeWorkspacePath,
        activeWorkspaceIdentity,
        cacheAuthorityKey,
      );
      setLoading(showBlockingLoading);
      setError(null);
      const requestId = ++latestRequestIdRef.current;
      try {
        const result = await skillsService.list({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: ZCODE_AGENT_PROVIDER,
        });
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setSkills(result.skills);
        setCapability(result.capability);
        setDiagnostics(result.diagnostics);
        setLoadedSkillTargetKey(requestTargetKey);
        setLoading(false);
      } catch (loadError) {
        if (requestId !== latestRequestIdRef.current) {
          return;
        }
        setLoadedSkillTargetKey(requestTargetKey);
        setLoading(false);
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      cacheAuthorityKey,
      skillsService,
      targetServiceResolution.rpcReady,
    ],
  );

  useEffect(() => {
    if (!targetServiceResolution.rpcReady) {
      latestRequestIdRef.current += 1;
      setLoading(false);
      setError(null);
      setImportDialogOpen(false);
      setRemoteSkillSyncOpen(false);
      return;
    }
    // 首屏或切换 Scope target 时必须显示阻塞 loading；手动刷新仍走后台刷新，
    // 避免有当前 target 数据时整块闪烁。
    void loadSkills(true);
  }, [activeWorkspacePath, loadSkills, targetServiceResolution.rpcReady]);

  const refresh = useCallback(async () => {
    await loadSkills(false);
  }, [loadSkills]);

  const refreshSharedSkillStoreForCurrentWorkspace = useCallback(async () => {
    await refreshSharedSkillStoreForWorkspace({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
      skillsService,
    });
  }, [activeWorkspaceIdentity, activeWorkspacePath, skillsService]);

  const setEnabled = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (!activeWorkspacePath) {
        return;
      }
      // 移除三方来源后，技能状态统一写入 ZCode Agent 上下文，避免旧 provider 前缀带来分桶漂移。
      const targetSkill = skills.find((skill) => skill.id === skillId);
      const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
      try {
        await skillsService.setEnabled({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          provider: effectiveProvider,
          scope: targetSkill?.scope,
          skillId,
          enabled,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-enabled",
        });
        await Promise.all([
          loadSkills(false),
          refreshSharedSkillStoreForCurrentWorkspace(),
        ]);
      } catch (setEnabledError) {
        setError(
          setEnabledError instanceof Error
            ? setEnabledError.message
            : String(setEnabledError),
        );
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      loadSkills,
      refreshSharedSkillStoreForCurrentWorkspace,
      skills,
      skillsService,
    ],
  );

  // 删除本地技能：plugin 作用域技能不可单独删除（由卸载插件管理），调用方已在 UI 层屏蔽其入口。
  // 复用应用根部已挂载的确认弹窗 store（useConfirmDialog），与子智能体删除流程保持一致。
  const handleDeleteSkill = useCallback(
    async (skill: SkillSummary) => {
      if (!activeWorkspacePath || skill.scope === "plugin") {
        return;
      }
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.skills.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.skills.delete.description" },
          { name: skill.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await skillsService.deleteSkill({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          skillId: skill.id,
        });
        await invalidateDeferredDraftSessionForSkillChange({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          reason: "settings-skill-delete",
        });
        if (selectedSkill?.id === skill.id) {
          setSelectedSkill(null);
        }
        await loadSkills(false);
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError),
        );
      }
    },
    [
      activeWorkspaceIdentity,
      activeWorkspacePath,
      confirmDialog,
      intl,
      loadSkills,
      selectedSkill,
      skillsService,
    ],
  );

  const scopedProviderSkills = useMemo(() => {
    const allProviderSkills = filterSkillsForProvider(
      skills,
      ZCODE_AGENT_PROVIDER,
    );
    const pluginStoreMatchesTarget =
      (pluginWorkspaceIdentity?.trim() || pluginWorkspacePath || "") ===
        (activeWorkspaceIdentity?.trim() || activeWorkspacePath || "") &&
      pluginConfigScope === scopeFilter;
    return selectSkillsForScope(
      allProviderSkills,
      pluginStoreMatchesTarget
        ? selectPluginsForScope(plugins, installedPlugins, scopeFilter)
        : [],
      scopeFilter,
    );
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    installedPlugins,
    pluginWorkspaceIdentity,
    pluginWorkspacePath,
    pluginConfigScope,
    plugins,
    scopeFilter,
    skills,
  ]);
  const groupedSkills = useMemo(
    () => groupSkillsByPlugin(scopedProviderSkills, query),
    [query, scopedProviderSkills],
  );
  const skillSourceGroups = useMemo(() => {
    return groupScopedSkillsBySource(
      [...groupedSkills.local, ...groupedSkills.plugin],
      scopeFilter === "user"
        ? intl.formatMessage({ id: "settings.scope.user" })
        : workspaceLabel ||
            intl.formatMessage({ id: "settings.scope.workspace" }),
    );
  }, [
    groupedSkills.local,
    groupedSkills.plugin,
    intl,
    scopeFilter,
    workspaceLabel,
  ]);
  const filteredSkillCount =
    groupedSkills.local.length + groupedSkills.plugin.length;
  const hasEmptySearchResult =
    Boolean(query.trim()) && filteredSkillCount === 0;
  const directInstalledSkillCount = scopedProviderSkills.filter(
    (skill) => skill.scope !== "plugin",
  ).length;
  const hideInstalledGroup =
    Boolean(query.trim()) && groupedSkills.local.length === 0;
  const pluginIconItemById = useMemo(
    () =>
      new Map(
        plugins.map((plugin) => [
          plugin.id,
          { name: plugin.name, listing: pluginListingById.get(plugin.id) },
        ]),
      ),
    [pluginListingById, plugins],
  );
  useEffect(() => {
    onVisibleCountChange?.(filteredSkillCount);
  }, [filteredSkillCount, onVisibleCountChange]);
  const handleCreateSkill = () => {
    if (!activeWorkspacePath || !onCreateTask) {
      return;
    }
    const effectiveProvider: ZCodeProvider = ZCODE_AGENT_PROVIDER;
    const skillCreator = filterSkillsForProvider(
      skills,
      effectiveProvider,
    ).find((skill) => skill.name === "skill-creator");
    const markdown = buildSkillMentionMarkdown(
      "skill-creator",
      skillCreator?.path,
    );

    // v4 迁移删除旧 pendingComposerPrefill 后，这个入口仍手工操作 session
    // store，只剩返回聊天页的导航，skill-creator 文本没有进入新 Composer。统一委托
    // Root 的新任务入口，让草稿持久化、workspaceIdentity 隔离和 Composer 插入保持单一路径。
    onCreateTask({
      provider: effectiveProvider,
      initialPrompt: `${markdown} `,
      initialPromptMention: {
        id: `skill:${skillCreator?.id ?? "skill-creator"}`,
        category: "skills",
        label: "skill-creator",
        value: "skill-creator",
        markdown,
        ...(skillCreator?.description
          ? { description: skillCreator.description }
          : {}),
        ...(skillCreator
          ? {
              data: {
                path: skillCreator.path,
                scope: skillCreator.scope,
              },
            }
          : {}),
      },
    });
  };

  const detailSkill = selectedSkill
    ? (skills.find((skill) => skill.id === selectedSkill.id) ?? selectedSkill)
    : null;
  const selectedSkillPublishedAt = formatSkillPublishedAt(
    detailSkill?.metadata?.publishedAt,
  );
  const openSkillFilePath = useCallback(
    async (path: string) => {
      const result = await platform.openInFileManager(path);
      if (!result.success) {
        toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
      }
    },
    [intl, platform],
  );

  // 诊断条数不等于加载失败的技能数；同一次扫描可以返回可用技能和多个目录级警告。
  // 按严重级别展示真实统计，避免把 warning 误报成“所有技能加载失败”。
  const diagnosticErrorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const diagnosticWarningCount = diagnostics.length - diagnosticErrorCount;
  const diagnosticsSummary =
    diagnostics.length > 0
      ? intl.formatMessage(
          { id: "settings.skills.diagnostics.summary" },
          {
            errorCount: String(diagnosticErrorCount),
            warningCount: String(diagnosticWarningCount),
          },
        )
      : "";
  const renderSkillRow = (skill: SkillSummary) => {
    const pluginIconItem = skill.pluginId
      ? pluginIconItemById.get(skill.pluginId)
      : skill.pluginName
        ? {
            name: skill.pluginName,
            listing: resolveUniquePluginListingByName(
              availablePlugins,
              skill.pluginName,
            ),
          }
        : undefined;
    return (
      <SkillRow
        skill={skill}
        iconItem={pluginIconItem}
        intl={intl}
        onSelect={setSelectedSkill}
        onEnabledChange={setEnabled}
        onDelete={handleDeleteSkill}
      />
    );
  };

  const skillHeaderActions = (
    <SettingsResourceHeaderActions
      onRefresh={() =>
        void Promise.all([
          refresh(),
          refreshSharedSkillStoreForCurrentWorkspace(),
        ])
      }
      onImport={() => setImportDialogOpen(true)}
      onNew={handleCreateSkill}
      importDisabled={!capability?.userScopeAvailable}
      importActionId="settings.skills.import.open"
      newActionId="settings.skills.create.open"
    />
  );

  return (
    <div className="space-y-4">
      {/* Bug 原因：独立 Skills 分区的详情是弹窗，不属于页面级导航；只有插件容器需要上报详情层级。 */}
      {reportDetailBreadcrumb && detailSkill ? (
        <SettingsBreadcrumbReporter
          items={
            showMarketplaceBreadcrumb
              ? [
                  {
                    label: intl.formatMessage({ id: "settings.plugins.title" }),
                    onSelect: () => setSelectedSkill(null),
                  },
                  { label: detailSkill.name },
                ]
              : [{ label: detailSkill.name }]
          }
          onSectionSelect={
            showMarketplaceBreadcrumb && onOpenPluginStore
              ? onOpenPluginStore
              : () => setSelectedSkill(null)
          }
        />
      ) : null}
      {connectedRemoteSyncTarget ? (
        <div className="flex justify-end">
          <SkillsRemoteSyncAction onOpen={() => setRemoteSkillSyncOpen(true)} />
        </div>
      ) : null}

      {connectedRemoteSyncTarget ? (
        <SkillsRemoteContextNotice targetLabel={remoteSkillSyncTargetLabel} />
      ) : null}

      {targetServiceResolution.rpcReady && diagnostics.length > 0 ? (
        <SkillsDiagnosticsBanner
          diagnostics={diagnostics}
          open={diagnosticsOpen}
          summary={diagnosticsSummary}
          formatCodeLabel={renderDiagnosticCodeLabel}
          onToggle={() => setDiagnosticsOpen((prev) => !prev)}
        />
      ) : null}

      {targetServiceResolution.rpcReady && !capability?.userScopeAvailable ? (
        <SkillsUserScopeNotice />
      ) : null}

      {targetServiceResolution.rpcReady && error ? (
        <SkillsErrorNotice message={error} />
      ) : null}

      {!targetServiceResolution.rpcReady ? (
        <PluginLoadingState
          label={intl.formatMessage({ id: "common.connecting" })}
        />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState
          label={intl.formatMessage({ id: "common.loading" })}
        />
      ) : hasEmptySearchResult ? (
        <div className="space-y-2">
          <PluginSearchEmptyState
            label={intl.formatMessage({
              id: "settings.plugin.skills.searchEmpty",
            })}
          />
          {onOpenPluginStore ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenPluginStore}
                data-testid="skills-open-marketplace"
              >
                {intl.formatMessage({ id: "settings.plugin.skills.browse" })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-6">
          <SkillsInstalledGroup
            skills={groupedSkills.local}
            hidden={hideInstalledGroup}
            showEmptyState={directInstalledSkillCount === 0 && !query.trim()}
            count={groupedSkills.local.length}
            headerActions={skillHeaderActions}
            canImport={Boolean(capability?.userScopeAvailable)}
            renderRow={renderSkillRow}
            onCreateSkill={handleCreateSkill}
            onImport={() => setImportDialogOpen(true)}
            onOpenPluginStore={onOpenPluginStore}
          />
          <SkillsPluginGroups
            groups={skillSourceGroups}
            locale={locale}
            pluginListingById={pluginListingById}
            availablePlugins={availablePlugins}
            renderRow={renderSkillRow}
          />
        </div>
      )}
      <SkillDetailDialog
        skill={detailSkill}
        scopeLabel={detailSkill ? renderScopeLabel(detailSkill) : ""}
        publishedAt={selectedSkillPublishedAt}
        onClose={() => setSelectedSkill(null)}
        onOpenPath={(path) => void openSkillFilePath(path)}
      />
      <SkillsImportDialog
        open={importDialogOpen && targetServiceResolution.rpcReady}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        settingsSyncService={
          targetServiceResolution.services.settingsSyncService
        }
        onOpenChange={setImportDialogOpen}
        onImported={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            reason: "settings-skill-import",
          });
          await refresh();
        }}
      />
      <RemoteSyncDialogs
        canSyncSkills={Boolean(
          targetServiceResolution.rpcReady &&
          connectedRemoteSyncTarget &&
          activeWorkspacePath,
        )}
        canSyncMcp={false}
        skillOpen={remoteSkillSyncOpen && targetServiceResolution.rpcReady}
        mcpOpen={false}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={() => {}}
        localSkillSyncService={baseServices.skillSyncService}
        remoteSkillSyncService={skillSyncService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath={activeWorkspacePath ?? ""}
        mcpWorkspacePath=""
        workspaceIdentity={activeWorkspaceIdentity}
        onSkillsSynced={async () => {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: activeWorkspacePath,
            workspaceIdentity: activeWorkspaceIdentity,
            reason: "settings-remote-skill-sync",
          });
          await Promise.all([
            refresh(),
            refreshSharedSkillStoreForCurrentWorkspace(),
          ]);
        }}
        onMcpSynced={() => {}}
      />
    </div>
  );
}
