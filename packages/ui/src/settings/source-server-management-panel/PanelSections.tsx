import type { ConnectionProfile } from "@zcode/shared";
import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteConnectionMinimizedProgress } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { SourceServerUpdateActivity } from "@/settings/SourceServerUpdateActivity.js";
import { usePanelRuntime } from "./panelContext.js";
import {
  formatRelativeTimestamp,
  profileOperationScope,
} from "./panelModel.js";
import { ConnectionProfileRow } from "./ConnectionProfileRow.js";

export function UnboundProfilesSection({
  unboundProfiles,
}: {
  unboundProfiles: ConnectionProfile[];
}) {
  const { intl } = useZCodeIntl();
  const {
    background,
    logsByProfileId,
    busyOperations,
    busyScopes,
    run,
    management,
    applySnapshot,
    confirmDialog,
  } = usePanelRuntime();

  return (
    <details
      open={
        background &&
        !background.sourceServerId &&
        unboundProfiles.some((profile) => profile.profileId === background.profileId)
          ? true
          : undefined
      }
      data-unfinished-connections
      className="group/unfinished border-t border-border pt-4"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-base font-medium">
        <ChevronRight className="size-3.5 transition-transform group-open/unfinished:rotate-90" />
        {intl.formatMessage({ id: "settings.source.unfinishedConnections" })}
        <span className="rounded-md bg-tag px-1.5 py-0.5 text-ui-xs font-normal text-remote-foreground-muted">
          {unboundProfiles.length}
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        {unboundProfiles.map((profile) => (
          <div key={profile.profileId}>
            <ConnectionProfileRow profile={profile} />
            {background &&
            !background.sourceServerId &&
            background.profileId === profile.profileId ? (
              <RemoteConnectionMinimizedProgress {...background} />
            ) : null}
            {(logsByProfileId[profile.profileId]?.length ?? 0) > 0 ? (
              <SourceServerUpdateActivity
                active={false}
                recent
                logs={logsByProfileId[profile.profileId] ?? []}
              />
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            busyOperations.has("clear-unfinished") ||
            unboundProfiles.some((profile) => busyScopes.has(profileOperationScope(profile)))
          }
          onClick={() => {
            void confirmDialog({
              title: intl.formatMessage({ id: "settings.source.clearUnfinished" }),
              description: intl.formatMessage({
                id: "settings.source.clearUnfinishedDescription",
              }),
              confirmLabel: intl.formatMessage({ id: "settings.source.clearUnfinished" }),
              confirmVariant: "destructive",
            }).then((confirmed) => {
              if (confirmed)
                void run(
                  "clear-unfinished",
                  async () => {
                    // 清理时复核归属，连接刚成功的设备不能被旧列表误删。
                    const latest = await management.getSnapshot();
                    for (const profile of latest.profiles) {
                      if (!profile.sourceServerId && profile.lifecycleState !== "retired")
                        applySnapshot(await management.removeProfile(profile.profileId));
                    }
                  },
                  unboundProfiles.map(profileOperationScope),
                );
            });
          }}
        >
          {intl.formatMessage({ id: "settings.source.clearUnfinished" })}
        </Button>
      </div>
    </details>
  );
}

export function RetiredProfilesSection({ retiredProfiles }: { retiredProfiles: ConnectionProfile[] }) {
  const { intl, locale } = useZCodeIntl();

  return (
    <details className="group/retired border-t border-border pt-4">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-ui-base font-medium text-foreground">
        <ChevronRight className="size-3.5 shrink-0 text-remote-foreground-muted transition-transform group-open/retired:rotate-90" />
        {intl.formatMessage(
          { id: "settings.source.retiredProfilesWithCount" },
          { count: retiredProfiles.length },
        )}
        <span className="text-ui-xs font-normal text-remote-foreground-muted">
          {intl.formatMessage({
            id: "settings.source.retiredProfilesDescription",
          })}
        </span>
      </summary>
      <div className="mt-2 space-y-1 pl-6">
        {retiredProfiles.map((profile) => (
          <div
            key={profile.profileId}
            className="flex min-w-0 flex-wrap items-center gap-2 py-1.5 text-remote-foreground-muted"
          >
            <span className="font-mono text-ui-sm">
              {profile.displayName ?? profile.transport}
              {intl.formatMessage({
                id: "settings.source.retiredNameSuffix",
              })}
            </span>
            <span className="text-ui-xs">
              {profile.retiredAt
                ? `${intl.formatMessage(
                    { id: "settings.source.archivedAt" },
                    {
                      time: formatRelativeTimestamp(
                        profile.retiredAt,
                        locale,
                        intl.formatMessage,
                      ),
                    },
                  )} · ${intl.formatMessage({
                    id: "settings.source.retiredEntryNote",
                  })}`
                : intl.formatMessage({
                    id: "settings.source.retiredEntryNote",
                  })}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function ConnectionPreferencesSection() {
  const { intl } = useZCodeIntl();
  const {
    startupAutoReconnect,
    setStartupAutoReconnect,
    busyOperations,
    run,
    onUpdateSettings,
  } = usePanelRuntime();

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({
          id: "settings.source.connectionPreferences",
        })}
      </h3>
      <div className="mt-3 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-ui-sm text-foreground">
              {intl.formatMessage({
                id: "settings.source.startupAutoReconnect",
              })}
            </p>
            <p className="text-ui-xs text-remote-foreground-muted">
              {intl.formatMessage({
                id: "settings.source.startupAutoReconnectDescription",
              })}
            </p>
          </div>
          <Switch
            checked={startupAutoReconnect}
            disabled={busyOperations.has("startup-reconnect") || !onUpdateSettings}
            aria-busy={busyOperations.has("startup-reconnect")}
            onCheckedChange={(checked) => {
              const previous = startupAutoReconnect;
              setStartupAutoReconnect(checked);
              void run("startup-reconnect", async () => {
                try {
                  await onUpdateSettings?.({ remoteStartupAutoReconnectEnabled: checked });
                } catch (cause) {
                  setStartupAutoReconnect(previous);
                  throw cause;
                }
              });
            }}
            aria-label={intl.formatMessage({
              id: "settings.source.startupAutoReconnect",
            })}
          />
        </div>
      </div>
    </section>
  );
}

export function PanelEmptyState({
  ready,
  profilesCount,
  serversCount,
}: {
  ready: boolean;
  profilesCount: number;
  serversCount: number;
}) {
  const { intl } = useZCodeIntl();
  const { onCreateConnection } = usePanelRuntime();

  if (!ready || profilesCount > 0 || serversCount > 0) return null;

  return (
    <div className="space-y-3 py-4 text-center text-ui-sm text-remote-foreground-muted">
      <p>{intl.formatMessage({ id: "settings.source.empty" })}</p>
      {onCreateConnection ? (
        <Button type="button" size="sm" onClick={onCreateConnection}>
          <Plus className="size-3.5" />
          {intl.formatMessage({ id: "settings.source.newConnection" })}
        </Button>
      ) : null}
    </div>
  );
}
