import type { SourceServerRecord, SourceServerWorkspaceHistoryEntry } from "@zcode/shared";
import { Box, Loader2, Pencil, Server, TerminalSquare } from "lucide-react";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { RemoteConnectionMinimizedProgress } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import {
  RemoteConnectionKindTag,
  RemoteConnectionStatusTag,
  formatConnectionProfileTarget,
} from "@/remote-connection/RemoteConnectionTags.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { formatRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import {
  sourceServerUpdateKey,
} from "@/lib/sourceServerUpdatePreferences.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import type { RemoteDeviceView } from "@/remote/remoteWorkspaceProjection.js";
import { usePanelRuntime } from "./panelContext.js";
import {
  formatRelativeTimestamp,
  formatTimestamp,
  profileOperationScope,
} from "./panelModel.js";
import { ConnectionProfileRow } from "./ConnectionProfileRow.js";
import { DeviceActionMenu } from "./DeviceActionMenu.js";
import { DeviceCardFooter } from "./DeviceCardFooter.js";
import { DeviceMigrationSection } from "./DeviceMigrationSection.js";
import { DeviceProjects } from "./DeviceProjects.js";
import { DeviceUpdateBanner } from "./DeviceUpdateBanner.js";
import { IdentityConfirmationButton } from "./IdentityConfirmationButton.js";

export function SourceServerDeviceCard({
  server,
  device,
}: {
  server: SourceServerRecord;
  device?: RemoteDeviceView;
}) {
  const { intl, locale } = useZCodeIntl();
  const {
    snapshot,
    stateByProfile,
    busyOperations,
    busyScopes,
    workspaceTabs,
    migrationReports,
    logsByProfileId,
    deferredUpdates,
    background,
    run,
    management,
    handleProfileAction,
    onCreateConnection,
    onConnectProfile,
    setEditingConnection,
    deviceCardsRef,
    expandedProjectSources,
    expandedSavedConnectionSources,
    logExpansionBySource,
  } = usePanelRuntime();

  const serverProfiles = device?.profiles ?? [];
  const preferredProfile =
    serverProfiles.find((profile) => profile.profileId === server.preferredProfileId) ??
    serverProfiles[0];
  // 旧 Source 在确认前仍可能是 uninstalled；恢复入口不能藏在安装状态或首选线路折叠后面。
  const pendingIdentityProfiles = serverProfiles.filter(
    (profile) => stateByProfile.get(profile.profileId)?.state === "identity-change-pending",
  );
  const identityChangeProfile =
    pendingIdentityProfiles.find((profile) => profile === preferredProfile) ??
    pendingIdentityProfiles[0];
  const currentProfile = serverProfiles.find(
    (profile) => stateByProfile.get(profile.profileId)?.state === "online",
  );
  const displayedProfile = currentProfile ?? preferredProfile;
  const ConnectionIcon =
    displayedProfile?.transport === "docker"
      ? Box
      : displayedProfile?.transport === "wsl"
        ? TerminalSquare
        : Server;
  // 同一项目可能有多条历史（不同连接），保留最近一次，并按最近打开倒序展示。
  const latestProjectByKey = new Map<string, SourceServerWorkspaceHistoryEntry>();
  for (const project of device?.knownProjects ?? []) {
    const key = resolveWorkspaceKey(project);
    const existing = latestProjectByKey.get(key);
    if (!existing || project.lastOpenedAt >= existing.lastOpenedAt)
      latestProjectByKey.set(key, project);
  }
  const projects = [...latestProjectByKey.values()].sort(
    (left, right) => right.lastOpenedAt - left.lastOpenedAt,
  );
  const projectsExpanded = expandedProjectSources.has(server.sourceServerId);
  const openedProjectPaths = new Set(
    workspaceTabs
      .filter(
        (tab) =>
          getWorkspaceSourceServerId(tab, {
            workspaceHistory: snapshot?.workspaceHistory,
          }) === server.sourceServerId,
      )
      .map((tab) => tab.workspacePath),
  );
  const otherProfiles = displayedProfile
    ? serverProfiles.filter(
        (profile) => profile !== displayedProfile && !pendingIdentityProfiles.includes(profile),
      )
    : [];
  const online = device?.aggregatedStatus === "online";
  const migrationReport = migrationReports[server.sourceServerId];
  const migrationCount = snapshot?.migrationCounts.find(
    (count) => count.sourceServerId === server.sourceServerId,
  );
  const showServerLines = server.installState !== "uninstalled";
  // 覆盖可更新/必须升级/更新中/更新失败四态：更新中不再携带 updateAvailability，也要选中。
  const profileStates = serverProfiles
    .map((profile) => stateByProfile.get(profile.profileId))
    .filter((state) => state !== undefined);
  const presentation = resolveRemoteConnectionPresentation(
    getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
  );
  const actionProfile =
    serverProfiles.find((profile) => profile.profileId === presentation.profileId) ??
    preferredProfile;
  const deviceBusy = busyScopes.has(`source:${server.sourceServerId}`);
  const actionBusy =
    busyOperations.has(`disconnect:${server.sourceServerId}`) ||
    busyOperations.has(`connect:${actionProfile?.profileId}`) ||
    busyOperations.has(`update:${actionProfile?.profileId}`) ||
    (busyOperations.has("desktop-update") &&
      presentation.primaryAction === "update-desktop");
  const preferredConnectionErrorText = presentation.reason
    ? intl.formatMessage({ id: presentation.reason.titleId }, presentation.reason.values)
    : null;
  const serverState =
    profileStates.find((state) => state.state === "updating") ??
    profileStates.find(
      (state) =>
        (state.updateAvailability && state.updateAvailability !== "none") ||
        state.state === "updating",
    );
  const updateFailed = serverState?.state === "failed";
  const updateKey = sourceServerUpdateKey(
    server.sourceServerId,
    serverState?.availableVersion ?? "",
  );
  const showUpdate =
    serverState &&
    !(
      serverState.updateAvailability === "available" &&
      serverState.state !== "updating" &&
      deferredUpdates.has(updateKey)
    );

  const updateFailureText =
    updateFailed && serverState
      ? formatRemoteConnectionError({
          fallback: intl.formatMessage({ id: "settings.source.operationFailed" }),
          reasonCode: serverState.errorCode,
          retryable: serverState.retryable,
          recoveryAttempt: serverState.recoveryAttempt,
          recoveryLimit: serverState.recoveryLimit,
          formatMessage: intl.formatMessage,
        })
      : null;
  const updateExplainsConnectionError = Boolean(
    showUpdate &&
    serverState?.profileId === presentation.profileId &&
    (serverState?.state === "updating" ||
      (updateFailed && updateFailureText === preferredConnectionErrorText) ||
      (serverState?.updateAvailability === "required" &&
        presentation.reason?.category === "source-server-upgrade-required")),
  );

  const operationLogs =
    logsByProfileId[serverState?.profileId ?? actionProfile?.profileId ?? ""] ?? [];
  const showOtherProfiles = showServerLines && otherProfiles.length > 0;
  const otherProfilesExpanded =
    showOtherProfiles && expandedSavedConnectionSources.has(server.sourceServerId);
  // 更新中由更新横幅展示进度与日志，页脚不重复。
  const showRecentLog = operationLogs.length > 0 && serverState?.state !== "updating";
  const logExpanded =
    showRecentLog &&
    (logExpansionBySource.get(server.sourceServerId) ?? presentation.status === "failed");

  return (
    <section
      key={server.sourceServerId}
      data-source-server-card={server.sourceServerId}
      tabIndex={-1}
      ref={(element) => {
        if (element) deviceCardsRef.current.set(server.sourceServerId, element);
        else deviceCardsRef.current.delete(server.sourceServerId);
      }}
      className="overflow-hidden rounded-xl border border-card-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
    >
      {background?.sourceServerId === server.sourceServerId ? (
        <RemoteConnectionMinimizedProgress {...background} />
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-4">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface text-remote-foreground-muted",
            server.installState === "uninstalled" && "opacity-60",
          )}
        >
          <ConnectionIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-ui-base font-semibold text-foreground">
              {server.displayName}
            </p>
            <RemoteConnectionStatusTag presentation={presentation} />
          </div>
        </div>
        <div
          className="order-2 basis-full min-w-0 flex flex-wrap items-center gap-2 text-ui-sm text-remote-foreground-muted"
          data-device-connection
        >
          {displayedProfile ? (
            <>
              <RemoteConnectionKindTag kind={displayedProfile.transport} />
              <span
                className="min-w-0 truncate font-mono"
                title={formatConnectionProfileTarget(displayedProfile)}
              >
                {formatConnectionProfileTarget(displayedProfile)}
              </span>
              {/* 只有一条连接时“当前 / 默认”没有区分意义，不显示。 */}
              {serverProfiles.length > 1 && currentProfile ? (
                <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">
                  {intl.formatMessage({
                    id: "settings.source.currentProfile",
                  })}
                </span>
              ) : null}
              {serverProfiles.length > 1 &&
              displayedProfile.profileId === server.preferredProfileId ? (
                <span className="shrink-0 rounded-md bg-tag px-1.5 py-0.5 text-ui-xs">
                  {intl.formatMessage({ id: "settings.source.defaultProfile" })}
                </span>
              ) : null}
              {displayedProfile.profileId !== server.preferredProfileId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={deviceBusy}
                  onClick={() =>
                    void run(
                      `preferred:${displayedProfile.profileId}`,
                      () =>
                        management.setPreferredProfile(
                          server.sourceServerId,
                          displayedProfile.profileId,
                        ),
                      [`source:${server.sourceServerId}`],
                    )
                  }
                >
                  {intl.formatMessage({ id: "settings.source.setDefault" })}
                </Button>
              ) : null}
            </>
          ) : null}
          {server.lastSeenVersion ? (
            <span
              className="shrink-0"
              title={intl.formatMessage({ id: "settings.source.info.version" })}
            >
              {displayedProfile ? "· " : ""}v{server.lastSeenVersion.replace(/^v/i, "")}
            </span>
          ) : null}
          {server.lastOnlineAt && !online ? (
            <span className="shrink-0" title={formatTimestamp(server.lastOnlineAt, locale)}>
              {displayedProfile || server.lastSeenVersion ? "· " : ""}
              {intl.formatMessage(
                { id: "settings.source.lastOnline" },
                {
                  time: formatRelativeTimestamp(server.lastOnlineAt, locale, intl.formatMessage),
                },
              )}
            </span>
          ) : null}
        </div>
        <DeviceProjects
          server={server}
          projects={projects}
          projectsExpanded={projectsExpanded}
          openedProjectPaths={openedProjectPaths}
          displayedProfile={displayedProfile}
          deviceBusy={deviceBusy}
        />
        <div className="order-1 ml-auto flex flex-wrap items-center gap-1">
          {presentation.primaryAction === "confirm-identity" && identityChangeProfile ? (
            <IdentityConfirmationButton profile={identityChangeProfile} size="sm" />
          ) : presentation.primaryAction !== "none" ? (
            <Button
              type="button"
              // 已连接时断开是低频操作，降为 ghost；任务继续提示放进按钮说明，不常驻占行。
              variant={presentation.primaryAction === "disconnect" ? "ghost" : "outline"}
              size="sm"
              title={
                presentation.primaryAction === "disconnect"
                  ? intl.formatMessage({ id: "settings.source.disconnectHint" })
                  : undefined
              }
              disabled={
                (deviceBusy && !["security", "details"].includes(presentation.primaryAction)) ||
                actionBusy ||
                presentation.status === "connecting"
              }
              aria-busy={actionBusy}
              onClick={() => {
                if (actionProfile) handleProfileAction(actionProfile, presentation, server);
                else onCreateConnection?.();
              }}
            >
              {actionBusy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({
                id:
                  server.installState === "uninstalled" &&
                  presentation.primaryAction === "install"
                    ? "settings.source.reinstallAndConnect"
                    : presentation.actionMessageId,
              })}
            </Button>
          ) : null}
          {presentation.primaryAction === "update-desktop" && preferredProfile ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deviceBusy}
              aria-busy={busyOperations.has(`connect:${preferredProfile.profileId}`)}
              onClick={() =>
                void run(
                  `connect:${preferredProfile.profileId}`,
                  async () => {
                    await onConnectProfile?.(preferredProfile.profileId);
                  },
                  [profileOperationScope(preferredProfile)],
                )
              }
            >
              {busyOperations.has(`connect:${preferredProfile.profileId}`) ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({ id: "remote.action.connect" })}
            </Button>
          ) : null}
          {displayedProfile ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={intl.formatMessage({
                id: "settings.source.editConnection",
              })}
              disabled={deviceBusy}
              onClick={() =>
                setEditingConnection({
                  profile: displayedProfile,
                  server,
                })
              }
            >
              <Pencil className="size-3.5" />
              {intl.formatMessage({ id: "settings.source.editConnection" })}
            </Button>
          ) : null}
          <DeviceActionMenu server={server} deviceBusy={deviceBusy} />
        </div>
      </div>
      {/* 更新失败只替代同一连接的相同原因，其他连接和可选更新不能吞掉连接错误。 */}
      {preferredConnectionErrorText && !updateExplainsConnectionError ? (
        <div className="mx-4 mb-3 rounded-md bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground">
          {preferredConnectionErrorText}
        </div>
      ) : null}
      {showUpdate && serverState ? (
        <DeviceUpdateBanner
          serverState={serverState}
          presentation={presentation}
          updateFailed={updateFailed}
          updateFailureText={updateFailureText}
          updateKey={updateKey}
          serverProfiles={serverProfiles}
          operationLogs={operationLogs}
          deviceBusy={deviceBusy}
        />
      ) : null}
      {pendingIdentityProfiles.length > 1 ? (
        <div className="border-t border-border px-4 py-2">
          {pendingIdentityProfiles
            .filter((profile) => profile !== identityChangeProfile)
            .map((profile) => (
              <ConnectionProfileRow key={profile.profileId} profile={profile} server={server} />
            ))}
        </div>
      ) : null}
      {showOtherProfiles || showRecentLog ? (
        <DeviceCardFooter
          server={server}
          otherProfiles={otherProfiles}
          showOtherProfiles={showOtherProfiles}
          otherProfilesExpanded={otherProfilesExpanded}
          showRecentLog={showRecentLog}
          logExpanded={logExpanded}
          operationLogs={operationLogs}
        />
      ) : null}
      {/* 产品边界：迁移账本是内部兼容机制，仅在存在待处理问题时以用户可理解的连接历史提醒暴露。 */}
      {showServerLines &&
      migrationCount?.status === "available" &&
      migrationCount.failedPathCount + migrationCount.abandonedPathCount > 0 ? (
        <DeviceMigrationSection
          server={server}
          migrationCount={migrationCount}
          migrationReport={migrationReport}
          deviceBusy={deviceBusy}
        />
      ) : null}
    </section>
  );
}
