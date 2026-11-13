import {
  useRemoteConnectionProgress,
  RemoteConnectionMinimizedProgress,
} from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { DesktopCommandIds } from "@zcode/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type {
  ConnectionProfile,
  AppSettings,
  SourceServerManagementSnapshot,
  SourceServerMigrationReport,
  SourceServerRecord,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { getSourceServerManagementErrorMessage } from "@/lib/sourceServerManagementError.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import {
  getSourceServerForceUpdateDescription,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";
import { useDeferredSourceServerUpdates } from "@/lib/sourceServerUpdatePreferences.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { buildRemoteWorkspaceProjection } from "@/remote/remoteWorkspaceProjection.js";
import {
  PanelRuntimeContext,
  type EditingConnectionState,
  type PanelRuntime,
} from "./source-server-management-panel/panelContext.js";
import {
  getProjectCount,
  profileOperationScope,
} from "./source-server-management-panel/panelModel.js";
import { SourceServerDeviceCard } from "./source-server-management-panel/SourceServerDeviceCard.js";
import {
  ConnectionPreferencesSection,
  PanelEmptyState,
  RetiredProfilesSection,
  UnboundProfilesSection,
} from "./source-server-management-panel/PanelSections.js";
import {
  EditConnectionDialog,
  ErrorDetailsDialog,
} from "./source-server-management-panel/PanelDialogs.js";

export { getProjectCount };

export function SourceServerManagementPanel({
  management,
  targetSourceServerId,
  targetSourceServerDetails = false,
  onTargetSourceServerFocused,
  onCreateConnection,
  onConnectProfile,
  onDisconnectSource,
  onShowInSidebar,
  onOpenProject,
  onShowUpdateDetails,
  workspaceTabs = [],
  settings,
  onUpdateSettings,
}: {
  management: ISourceServerManagementService;
  targetSourceServerId?: string;
  targetSourceServerDetails?: boolean;
  onTargetSourceServerFocused?: () => void;
  onCreateConnection?: () => void;
  /** 用户点击连接时交给 Root 的全局弹窗，以 preferredProfileId 直达第 4 步。 */
  onConnectProfile?: (profileId: string) => Promise<void> | void;
  /** 用户断开设备时交给 Root 的统一 RemoteWorkspaceController。 */
  onDisconnectSource?: (sourceServerId: string) => Promise<void>;
  /** 「在侧边栏中显示」菜单项：返回工作区主界面（侧边栏设备分组所在处）。 */
  onShowInSidebar?: (sourceServerId: string) => void;
  onOpenProject?: (sourceServerId: string, path: string, profileId?: string) => Promise<void>;
  onShowUpdateDetails?: (sourceServerId: string) => void;
  workspaceTabs?: WorkspaceTabState[];
  /** 「新任务」按钮（原型 L763）：激活该设备已打开的 workspace tab 并开新草稿。 */
  /** 有已打开 workspace tab 的设备 id 集合；「新任务」仅对这些设备渲染。 */
  settings?: Pick<
    AppSettings,
    "remoteStartupAutoReconnectEnabled" | "remoteConversationWorkspaceBySourceServerId"
  > | null;
  onUpdateSettings?: (patch: Partial<AppSettings>) => Promise<unknown> | void;
}) {
  const background = useRemoteConnectionProgress();
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = useOptionalPlatform();
  const deferredUpdates = useDeferredSourceServerUpdates();
  const [startupAutoReconnect, setStartupAutoReconnect] = useState(
    settings?.remoteStartupAutoReconnectEnabled ?? true,
  );
  useEffect(() => {
    setStartupAutoReconnect(settings?.remoteStartupAutoReconnectEnabled ?? true);
  }, [settings?.remoteStartupAutoReconnectEnabled]);
  const [editingConnection, setEditingConnection] = useState<EditingConnectionState | null>(null);
  const [errorDetailsProfile, setErrorDetailsProfile] = useState<ConnectionProfile | null>(null);
  const [expandedSavedConnectionSources, setExpandedSavedConnectionSources] = useState<Set<string>>(
    new Set(),
  );
  const [expandedProjectSources, setExpandedProjectSources] = useState<Set<string>>(new Set());
  // 只记录用户手动切换过的日志展开状态；未切换时由设备是否失败决定默认值。
  const [logExpansionBySource, setLogExpansionBySource] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  // 这里只拥有面板操作的防重状态；业务状态与快照版本仍由 Host 和快照 hook 负责。
  const operationsRef = useRef(new Map<string, readonly string[]>());
  const [busyOperations, setBusyOperations] = useState<ReadonlyMap<string, readonly string[]>>(
    new Map(),
  );
  const busyScopes = new Set([...busyOperations.values()].flat());
  if (background?.sourceServerId) busyScopes.add(`source:${background.sourceServerId}`);
  else if (background?.profileId) busyScopes.add(`profile:${background.profileId}`);
  const hasBusyScope = useCallback(
    (scope: string) => [...operationsRef.current.values()].some((scopes) => scopes.includes(scope)),
    [],
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 相对时间必须随时钟更新，不能依赖连接事件才重绘。
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [migrationReports, setMigrationReports] = useState<
    Record<string, SourceServerMigrationReport | undefined>
  >({});

  const {
    snapshot,
    ready,
    applySnapshot,
    refresh: refreshSnapshot,
  } = useSourceServerManagementSnapshot(management, {
    onError: (cause) => setError(getSourceServerManagementErrorMessage(cause, intl.formatMessage)),
  });
  const focusedTargetRef = useRef<string | undefined>(undefined);
  const deviceCardsRef = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!targetSourceServerId) {
      focusedTargetRef.current = undefined;
      return;
    }
    const targetKey = `${targetSourceServerId}:${targetSourceServerDetails}`;
    if (!ready || focusedTargetRef.current === targetKey) return;
    const card = deviceCardsRef.current.get(targetSourceServerId);
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.focus({ preventScroll: true });
    const failedProfileId = snapshot?.states.find(
      (state) => state.sourceServerId === targetSourceServerId && state.state === "failed",
    )?.profileId;
    const failedProfile = snapshot?.profiles.find(
      (profile) => profile.profileId === failedProfileId,
    );
    if (targetSourceServerDetails && failedProfile) setErrorDetailsProfile(failedProfile);
    focusedTargetRef.current = targetKey;
    onTargetSourceServerFocused?.();
  }, [
    ready,
    snapshot,
    targetSourceServerId,
    targetSourceServerDetails,
    onTargetSourceServerFocused,
  ]);
  const { logsByProfileId } = useSourceServerOperationLogs(
    management,
    snapshot?.profiles.map((profile) => profile.profileId),
  );
  const projection = useMemo(
    () =>
      buildRemoteWorkspaceProjection({
        managementSnapshot: snapshot,
        tabs: [],
        remoteConversationWorkspaceBySourceServerId:
          settings?.remoteConversationWorkspaceBySourceServerId,
      }),
    [snapshot, settings?.remoteConversationWorkspaceBySourceServerId],
  );
  const refresh = useCallback(async () => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  const stateByProfile = useMemo(
    () => new Map(snapshot?.states.map((state) => [state.profileId, state]) ?? []),
    [snapshot?.states],
  );

  const run = useCallback(
    async (
      key: string,
      operation: () => Promise<SourceServerManagementSnapshot | void>,
      scopes: readonly string[] = [key],
    ) => {
      // 同设备的不同连接互斥；无关设备和日志查看独立，不用全局锁阻塞长时间更新。
      if (operationsRef.current.has(key) || scopes.some(hasBusyScope)) return;
      operationsRef.current.set(key, scopes);
      setBusyOperations(new Map(operationsRef.current));
      setError(null);
      try {
        const nextSnapshot = await operation();
        if (nextSnapshot) applySnapshot(nextSnapshot);
        else refreshSnapshot();
      } catch (cause) {
        setError(getSourceServerManagementErrorMessage(cause, intl.formatMessage));
      } finally {
        operationsRef.current.delete(key);
        setBusyOperations(new Map(operationsRef.current));
      }
    },
    [applySnapshot, refreshSnapshot, intl, hasBusyScope],
  );

  const removeProfile = useCallback(
    async (profile: ConnectionProfile) => {
      if (!management) return;
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.source.removeProfileTitle" }),
        description: intl.formatMessage(
          { id: "settings.source.removeProfileDescription" },
          { name: profile.displayName ?? profile.transport },
        ),
        confirmLabel: intl.formatMessage({
          id: "settings.source.removeProfile",
        }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      await run(`remove:${profile.profileId}`, () => management.removeProfile(profile.profileId), [
        profileOperationScope(profile),
      ]);
    },
    [confirmDialog, intl, management, run],
  );

  const removeSourceServer = useCallback(
    async (server: SourceServerRecord) => {
      if (hasBusyScope(`source:${server.sourceServerId}`)) return;
      const affectedProjects = workspaceTabs.filter(
        (tab) =>
          getWorkspaceSourceServerId(tab, { workspaceHistory: snapshot?.workspaceHistory }) ===
          server.sourceServerId,
      );
      const projectNotice =
        affectedProjects.length > 0
          ? intl.formatMessage(
              { id: "settings.source.removeOpenProjects" },
              {
                projects: affectedProjects
                  .map((tab) => `${tab.label} (${tab.workspacePath})`)
                  .join("\n"),
              },
            )
          : intl.formatMessage({ id: "settings.source.noOpenProjects" });
      const confirmed = await confirmDialog({
        title: intl.formatMessage({
          id: "settings.source.removeSourceServer",
        }),
        description:
          intl.formatMessage(
            { id: "settings.source.removeSourceServerDescription" },
            { name: server.displayName },
          ) +
          "\n\n" +
          projectNotice,
        confirmLabel: intl.formatMessage({
          id: "settings.source.removeSourceServer",
        }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      await run(
        `remove-source:${server.sourceServerId}`,
        () => management.removeSourceServer(server.sourceServerId),
        [`source:${server.sourceServerId}`],
      );
    },
    [confirmDialog, intl, management, run, snapshot?.workspaceHistory, workspaceTabs, hasBusyScope],
  );

  const loadMigrationReport = useCallback(
    async (sourceServerId: string) => {
      if (!management) return;
      await run(`report:${sourceServerId}`, async () => {
        const report = await management.getMigrationReport(sourceServerId);
        setMigrationReports((current) => ({ ...current, [sourceServerId]: report }));
      });
    },
    [management, run],
  );

  const toggleMigrationReport = useCallback(
    (sourceServerId: string) => {
      if (migrationReports[sourceServerId]) {
        setMigrationReports((current) => {
          const next = { ...current };
          delete next[sourceServerId];
          return next;
        });
        return;
      }
      void loadMigrationReport(sourceServerId);
    },
    [loadMigrationReport, migrationReports],
  );

  const runMigrationOperation = useCallback(
    async (
      key: string,
      sourceServerId: string,
      operation: () => Promise<SourceServerMigrationReport>,
    ) => {
      await run(key, async () => {
        const report = await operation();
        setMigrationReports((current) => ({ ...current, [sourceServerId]: report }));
      }, [`source:${sourceServerId}`]);
    },
    [run],
  );

  const updateProfile = useCallback(
    async (profile: ConnectionProfile) => {
      await run(
        `update:${profile.profileId}`,
        async () => {
          let next: SourceServerManagementSnapshot | null;
          try {
            next = await runSourceServerUpdate({
              management,
              profileId: profile.profileId,
              confirmForce: async () =>
                await confirmDialog({
                  title: intl.formatMessage({
                    id: "settings.source.forceUpdateTitle",
                  }),
                  description: await getSourceServerForceUpdateDescription(
                    management,
                    profile.profileId,
                    (id) => intl.formatMessage({ id }),
                  ),
                  confirmLabel: intl.formatMessage({
                    id: "settings.source.forceUpdate",
                  }),
                  confirmVariant: "destructive",
                }),
            });
          } catch (cause) {
            toast(
              intl.formatMessage(
                { id: "sourceServer.updateFailedToast" },
                { source: profile.displayName ?? profile.transport },
              ),
              {
                variant: "warning",
                actionLabel: intl.formatMessage({ id: "remote.action.details" }),
                onAction: () => {
                  // 更新可跨面板生命周期完成，不能让全局 toast 捕获已卸载组件的 setter。
                  if (mountedRef.current) setErrorDetailsProfile(profile);
                  else if (profile.sourceServerId) onShowUpdateDetails?.(profile.sourceServerId);
                },
              },
            );
            throw cause;
          }
          if (next)
            toast(
              intl.formatMessage(
                { id: "sourceServer.updateCompletedToast" },
                { source: profile.displayName ?? profile.transport },
              ),
              { variant: "source-server-update" },
            );
          return next ?? undefined;
        },
        [profileOperationScope(profile)],
      );
    },
    [confirmDialog, intl, management, onShowUpdateDetails, run],
  );

  const handleProfileAction = (
    profile: ConnectionProfile,
    presentation: RemoteConnectionPresentation,
    server?: SourceServerRecord,
  ) => {
    if (
      !["security", "details"].includes(presentation.primaryAction) &&
      hasBusyScope(profileOperationScope(profile))
    )
      return;
    switch (presentation.primaryAction) {
      case "update-desktop":
        void run("desktop-update", async () => {
          await platform?.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
        });
        return;
      case "update-server":
        void updateProfile(profile);
        return;
      case "disconnect":
        if (profile.sourceServerId && onDisconnectSource)
          void run(
            `disconnect:${profile.sourceServerId}`,
            () => onDisconnectSource(profile.sourceServerId!),
            [profileOperationScope(profile)],
          );
        return;
      case "credentials":
      case "edit-auth":
        setEditingConnection({ profile, server, focusField: "auth" });
        return;
      case "edit-host":
        setEditingConnection({ profile, server, focusField: "host" });
        return;
      case "security":
      case "details":
        setErrorDetailsProfile(profile);
        return;
      case "none":
        return;
      default:
        void run(
          `connect:${profile.profileId}`,
          async () => {
            await onConnectProfile?.(profile.profileId);
          },
          [profileOperationScope(profile)],
        );
    }
  };

  const servers = snapshot?.servers ?? [];
  const profiles = snapshot?.profiles ?? [];
  const activeProfiles = profiles.filter((profile) => profile.lifecycleState !== "retired");
  const retiredProfiles = profiles.filter((profile) => profile.lifecycleState === "retired");
  const unboundProfiles = activeProfiles.filter((profile) => !profile.sourceServerId);

  const runtime: PanelRuntime = {
    management,
    platform,
    snapshot,
    stateByProfile,
    busyOperations,
    busyScopes,
    logsByProfileId,
    migrationReports,
    deferredUpdates,
    background,
    deviceCardsRef,
    confirmDialog,
    workspaceTabs,
    run,
    removeProfile,
    removeSourceServer,
    updateProfile,
    handleProfileAction,
    toggleMigrationReport,
    runMigrationOperation,
    onCreateConnection,
    onConnectProfile,
    onDisconnectSource,
    onShowInSidebar,
    onOpenProject,
    onShowUpdateDetails,
    onUpdateSettings,
    setEditingConnection,
    setErrorDetailsProfile,
    expandedProjectSources,
    setExpandedProjectSources,
    expandedSavedConnectionSources,
    setExpandedSavedConnectionSources,
    logExpansionBySource,
    setLogExpansionBySource,
    startupAutoReconnect,
    setStartupAutoReconnect,
    applySnapshot,
  };

  return (
    <PanelRuntimeContext.Provider value={runtime}>
      <div className="flex flex-col gap-4" aria-busy={busyOperations.size > 0}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-xl">
            <p className="text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "settings.remoteDevicesDescription" })}
            </p>
            {error ? (
              <p role="alert" className="mt-2 text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          {onCreateConnection && (!ready || profiles.length > 0 || servers.length > 0) ? (
            <Button type="button" size="sm" onClick={onCreateConnection}>
              <Plus className="size-3.5" />
              {intl.formatMessage({ id: "settings.source.newConnection" })}
            </Button>
          ) : null}
        </div>
        {background &&
        !servers.some((server) => server.sourceServerId === background.sourceServerId) &&
        !unboundProfiles.some((profile) => profile.profileId === background.profileId) ? (
          <section
            data-unfinished-background-connection
            className="rounded-xl border border-card-border bg-card pt-3"
          >
            <p className="px-4 text-ui-sm font-medium">
              {intl.formatMessage({ id: "settings.source.unfinishedConnections" })}
            </p>
            <RemoteConnectionMinimizedProgress {...background} />
          </section>
        ) : null}
        {!ready && !error ? (
          <p
            role="status"
            className="flex items-center gap-2 text-ui-sm text-remote-foreground-muted"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : null}
        <div className="min-w-0 space-y-3">
          {servers.length > 0 ? (
            <h3 className="flex items-center gap-2 text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.source.devicesHeading" })}
              <span className="text-ui-xs font-normal text-remote-foreground-muted">
                {servers.length}
              </span>
            </h3>
          ) : null}
          {servers.map((server) => (
            <SourceServerDeviceCard
              key={server.sourceServerId}
              server={server}
              device={projection.devices.find(
                (candidate) => candidate.sourceServerId === server.sourceServerId,
              )}
            />
          ))}
          <UnboundProfilesSection unboundProfiles={unboundProfiles} />
          {retiredProfiles.length > 0 ? (
            <RetiredProfilesSection retiredProfiles={retiredProfiles} />
          ) : null}
          <ConnectionPreferencesSection />
          <PanelEmptyState
            ready={ready}
            profilesCount={profiles.length}
            serversCount={servers.length}
          />
        </div>
        <ErrorDetailsDialog
          profile={errorDetailsProfile}
          onClose={() => setErrorDetailsProfile(null)}
        />
        <EditConnectionDialog
          connection={editingConnection}
          onOpenChange={(open) => {
            if (!open) setEditingConnection(null);
          }}
          onSaved={refresh}
        />
      </div>
    </PanelRuntimeContext.Provider>
  );
}
