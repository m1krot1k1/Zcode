/**
 * MCP Settings — user action handlers.
 *
 * Kept as a plain factory (no hooks) so the section component stays focused on
 * projections and JSX while handlers keep their per-render closures.
 */
import {
  communityMcpPresetConfig,
  type CommunityMcpPreset,
  type IPlatformService,
  type McpRegistryInstallOption,
  type McpRegistryMarketplaceEntry,
  type McpServerConfig,
  type McpSource,
  type ZCodeAgentMcpServer,
  type ZCodeMcpServer,
} from "@zcode/shared";
import { isZCodeAgentMcpConnectUnsupportedError, type IMcpSyncService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import type { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { formToConfig, type FormState, type McpEditorMode } from "@/settings/mcpSettingsShared.js";
import { buildMcpProjectApprovalPreview } from "@/settings/mcpProjectApprovalPreview.js";
import type { PluginMcpServerItem } from "@/settings/pluginManagedResourceGroups.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import {
  DEFAULT_MCP_SOURCE,
  addCommunityMcpPresetToScope,
  registryServerName,
} from "./mcpSettingsPresets.js";
import type { RequestMcpServerStatusListOptions } from "./useMcpSettingsStatusRefresh.js";

interface McpSettingsActionsStore {
  addScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  connectMcpServer: (request: {
    approveProjectScope: boolean;
    id: string;
    mcpServers?: ZCodeAgentMcpServer[];
    service: Pick<IMcpSyncService, "connectWorkspaceMcpServer">;
    workspaceIdentity?: string;
    workspacePath: string;
  }) => Promise<"connected" | "requires_approval" | "failed">;
  ensureLoadedForWorkspace: (
    workspacePath: string,
    service: IMcpSyncService,
    workspaceIdentity?: string,
    authorityKey?: string,
  ) => Promise<boolean>;
  getEnabledMcpServersForZCode: (provider: string) => ZCodeAgentMcpServer[];
  listSavedServers: () => readonly ZCodeMcpServer[];
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  updateScopedMcpServer: (
    source: McpSource,
    name: string,
    config: McpServerConfig,
    projectPath?: string,
  ) => Promise<void>;
  updateServerStatus: (
    id: string,
    status: "unknown" | "connecting",
    error?: string,
    options?: { invalidateStatusListRequests?: boolean },
  ) => void;
}

export interface CreateMcpSettingsActionsInput {
  activeWorkspaceIdentity: string | undefined;
  activeWorkspacePath: string | undefined;
  cacheAuthorityKey: string | undefined;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  editingServer: ZCodeMcpServer | null;
  formScopeKey: string;
  installingPresetIdsRef: { current: Set<string> };
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  mcpSyncService: IMcpSyncService;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  parentScopeKey: string;
  platform: IPlatformService;
  requestMcpServerStatusList: (options?: RequestMcpServerStatusListOptions) => Promise<void>;
  setEditingServer: (server: ZCodeMcpServer | null) => void;
  setEditorMode: (mode: McpEditorMode) => void;
  setFormScopeKey: (scopeKey: string) => void;
  setInstallingPresetIds: (ids: Set<string>) => void;
  setPresetDraft: (server: ZCodeMcpServer | null) => void;
  setShowForm: (open: boolean) => void;
  store: McpSettingsActionsStore;
  workspaceTabs: ConfigWorkspaceTarget[];
}

export function createMcpSettingsActions({
  activeWorkspaceIdentity,
  activeWorkspacePath,
  cacheAuthorityKey,
  confirmDialog,
  editingServer,
  formScopeKey,
  installingPresetIdsRef,
  intl,
  mcpSyncService,
  onFormScopeKeyChange,
  parentScopeKey,
  platform,
  requestMcpServerStatusList,
  setEditingServer,
  setEditorMode,
  setFormScopeKey,
  setInstallingPresetIds,
  setPresetDraft,
  setShowForm,
  store,
  workspaceTabs,
}: CreateMcpSettingsActionsInput) {
  const {
    addScopedMcpServer,
    connectMcpServer,
    ensureLoadedForWorkspace,
    getEnabledMcpServersForZCode,
    listSavedServers,
    toggleServer,
    updateScopedMcpServer,
    updateServerStatus,
  } = store;

  async function handleToggle(id: string, enabled: boolean) {
    await toggleServer(id, enabled);

    if (!enabled) {
      // 禁用后的 unknown 只是本地展示态；toggleServer 已经作废旧请求，
      // 这里不能再推进 epoch，否则刚返回的 mcp/list 会被丢弃并造成反复转圈。
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }

    // renderer 侧浅检查无法真实启动 stdio MCP，曾把不存在的 command 误判为 connected。
    // 打开后只展示连接中，最终绿/红状态统一等待 agent 侧 mcp/list 真实 connect/listTools 回写。
    if (!activeWorkspacePath) {
      updateServerStatus(id, "unknown", undefined, {
        invalidateStatusListRequests: false,
      });
      return;
    }
    // connecting 只是等待真实 mcp/list 的临时展示态，不能作废随后发出的批量请求。
    updateServerStatus(id, "connecting", undefined, {
      invalidateStatusListRequests: false,
    });
    void requestMcpServerStatusList();
  }

  async function handleSave(form: FormState, prev?: ZCodeMcpServer) {
    if (!activeWorkspacePath) {
      return;
    }
    const loaded = await ensureLoadedForWorkspace(
      activeWorkspacePath,
      mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    );
    if (!loaded) {
      return;
    }
    const config = {
      ...formToConfig(form),
      ...(prev?.enabled === false ? { enable: false } : {}),
    };
    // 表单 Scope 可以独立于父页面切换，不能继续读取可能仍属于旧目标的
    // currentProjectPath；保存目标必须使用表单已解析并完成加载的 workspace props。
    const projectPath = formScopeKey === "user" ? undefined : activeWorkspacePath;

    if (editingServer && prev) {
      await updateScopedMcpServer(DEFAULT_MCP_SOURCE, prev.name, config, projectPath);
    } else {
      await addScopedMcpServer(DEFAULT_MCP_SOURCE, form.name, config, projectPath);
    }

    setShowForm(false);
    setEditingServer(null);
    setPresetDraft(null);
    onFormScopeKeyChange?.(null);
  }

  function handleEdit(server: ZCodeMcpServer) {
    const ownerWorkspace = workspaceTabs.find((tab) => tab.workspacePath === server.projectPath);
    const ownedScopeKey =
      server.scope === "workspace"
        ? ownerWorkspace
          ? getPluginWorkspaceKey(ownerWorkspace)
          : parentScopeKey
        : "user";
    setFormScopeKey(ownedScopeKey);
    onFormScopeKeyChange?.(ownedScopeKey);
    setEditingServer(server);
    setPresetDraft(null);
    setShowForm(false);
    setEditorMode("form");
  }

  function handleCreate() {
    setFormScopeKey(parentScopeKey);
    onFormScopeKeyChange?.(parentScopeKey);
    setEditingServer(null);
    setPresetDraft(null);
    setEditorMode("form");
    setShowForm(true);
  }

  function handleCreateFromPreset(preset: CommunityMcpPreset) {
    setFormScopeKey(parentScopeKey);
    onFormScopeKeyChange?.(parentScopeKey);
    setEditingServer(null);
    setPresetDraft({
      id: "",
      name: preset.id,
      enabled: true,
      source: "zcodeagentmcp",
      scope: "user",
      config: communityMcpPresetConfig(preset),
    });
    setEditorMode("form");
    setShowForm(true);
  }

  function handleConfigureRegistryEntry(
    entry: McpRegistryMarketplaceEntry,
    option: McpRegistryInstallOption,
  ) {
    setFormScopeKey(parentScopeKey);
    onFormScopeKeyChange?.(parentScopeKey);
    setEditingServer(null);
    setPresetDraft({
      id: "",
      name: registryServerName(entry.id),
      enabled: true,
      source: "zcodeagentmcp",
      scope: "user",
      config: {
        type: option.kind === "remote" ? (option.transport ?? "http") : "stdio",
        ...(option.command ? { command: option.command } : {}),
        ...(option.args ? { args: option.args } : {}),
        ...(option.url ? { url: option.url } : {}),
        ...(option.env ? { env: option.env } : {}),
      },
    });
    setEditorMode("form");
    setShowForm(true);
  }

  async function handleInstallPreset(preset: CommunityMcpPreset) {
    if (installingPresetIdsRef.current.has(preset.id)) return;
    installingPresetIdsRef.current.add(preset.id);
    setInstallingPresetIds(new Set(installingPresetIdsRef.current));
    try {
      const outcome = await addCommunityMcpPresetToScope({
        addServer: (name, config, projectPath) =>
          addScopedMcpServer(DEFAULT_MCP_SOURCE, name, config, projectPath),
        listSavedServers,
        loadCurrentScope: () =>
          activeWorkspacePath
            ? ensureLoadedForWorkspace(
                activeWorkspacePath,
                mcpSyncService,
                activeWorkspaceIdentity,
                cacheAuthorityKey,
              )
            : Promise.resolve(false),
        preset,
        scopeKey: parentScopeKey,
        workspacePath: activeWorkspacePath ?? undefined,
      });
      if (outcome === "unavailable") {
        toast(intl.formatMessage({ id: "settings.mcp.communityPresets.addFailed" }));
      } else if (outcome === "added") {
        toast(
          intl.formatMessage(
            { id: "settings.mcp.communityPresets.addedToast" },
            { name: preset.name },
          ),
        );
      }
    } catch (error) {
      logger.warn("[mcp] Failed to add bundled MCP preset", {
        presetId: preset.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
      toast(intl.formatMessage({ id: "settings.mcp.communityPresets.addFailed" }));
    } finally {
      installingPresetIdsRef.current.delete(preset.id);
      setInstallingPresetIds(new Set(installingPresetIdsRef.current));
    }
  }

  async function handleConnectProjectServer(server: ZCodeMcpServer) {
    if (!activeWorkspacePath) {
      return;
    }
    const preview = buildMcpProjectApprovalPreview(server.config);
    const details = [
      preview.commandLine
        ? intl.formatMessage(
            { id: "settings.mcp.projectApproval.commandLine" },
            { command: preview.commandLine },
          )
        : null,
      preview.url
        ? intl.formatMessage({ id: "settings.mcp.projectApproval.url" }, { url: preview.url })
        : null,
      preview.envEntries.length > 0
        ? intl.formatMessage(
            { id: "settings.mcp.projectApproval.env" },
            { entries: preview.envEntries.join(", ") },
          )
        : null,
      preview.headerEntries.length > 0
        ? intl.formatMessage(
            { id: "settings.mcp.projectApproval.headers" },
            { entries: preview.headerEntries.join(", ") },
          )
        : null,
    ].filter((line): line is string => Boolean(line));

    const confirmed = await confirmDialog({
      title: intl.formatMessage(
        { id: "settings.mcp.projectApproval.title" },
        { name: server.name },
      ),
      description: intl.formatMessage(
        { id: "settings.mcp.projectApproval.description" },
        { details: details.join("\n"), name: server.name },
      ),
      confirmLabel: intl.formatMessage({ id: "settings.mcp.projectApproval.confirm" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      intent: "mcp-project-approval",
    });
    if (!confirmed) {
      return;
    }

    try {
      const outcome = await connectMcpServer({
        approveProjectScope: true,
        id: server.id,
        // 与 mcp/list 相同的 UI-resolved 定义（含 `.agents/mcp.json` fallback）。
        // project-scope 的最终定义仍由 Agent 以本地配置为准，不会因下行快照被替换。
        mcpServers: getEnabledMcpServersForZCode("zcode"),
        service: mcpSyncService,
        ...(activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : {}),
        workspacePath: activeWorkspacePath,
      });
      if (outcome === "requires_approval") {
        // 定义在确认与请求之间发生变化时 Agent 会重新要求批准，绝不静默放行。
        toast(intl.formatMessage({ id: "settings.mcp.projectApproval.stillRequired" }), {
          durationMs: 8_000,
        });
        return;
      }
      if (outcome === "failed") {
        // 行内已经通过 status snapshot 展示 failureKind 文案与详情入口。
        toast(intl.formatMessage({ id: "settings.mcp.projectApproval.failed" }), {
          durationMs: 8_000,
        });
        return;
      }
      toast(
        intl.formatMessage({ id: "settings.mcp.projectApproval.connected" }, { name: server.name }),
      );
      void requestMcpServerStatusList();
    } catch (error) {
      if (isZCodeAgentMcpConnectUnsupportedError(error)) {
        toast(intl.formatMessage({ id: "settings.mcp.projectApproval.unsupported" }), {
          durationMs: 8_000,
        });
        return;
      }
      // 底层错误可能包含 spawn 命令行等定义片段；这里只记录错误类型。
      logger.warn("[mcp] connect project server failed", {
        errorName: error instanceof Error ? error.name : "unknown",
        serverName: server.name,
        workspacePath: activeWorkspacePath,
      });
      toast(intl.formatMessage({ id: "settings.mcp.projectApproval.failed" }), {
        durationMs: 8_000,
      });
    }
  }

  function handleOpenAuthorization(server: ZCodeMcpServer) {
    const authorizationUrl = server.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  function handleOpenPluginAuthorization(item: PluginMcpServerItem) {
    const authorizationUrl = item.authorization?.authorizationUrl;
    if (!authorizationUrl) {
      return;
    }
    platform.openExternal(authorizationUrl);
  }

  return {
    handleToggle,
    handleSave,
    handleEdit,
    handleCreate,
    handleCreateFromPreset,
    handleConfigureRegistryEntry,
    handleInstallPreset,
    handleConnectProjectServer,
    handleOpenAuthorization,
    handleOpenPluginAuthorization,
  };
}
