import type { ConnectionProfile, SourceServerRecord } from "@zcode/shared";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatConnectionProfileTarget,
  RemoteConnectionKindTag,
  RemoteConnectionStatusTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import {
  getRemoteDevicePresentationInput,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { usePanelRuntime } from "./panelContext.js";
import { formatRelativeTimestamp, formatTimestamp, profileOperationScope } from "./panelModel.js";
import { IdentityConfirmationButton } from "./IdentityConfirmationButton.js";

export function ConnectionProfileRow({
  profile,
  server,
}: {
  profile: ConnectionProfile;
  server?: SourceServerRecord;
}) {
  const { intl, locale } = useZCodeIntl();
  const {
    snapshot,
    stateByProfile,
    busyScopes,
    run,
    management,
    removeProfile,
    handleProfileAction,
    setEditingConnection,
  } = usePanelRuntime();

  const state = stateByProfile.get(profile.profileId);
  const isOnline = state?.state === "online";
  const identityChangePending = state?.state === "identity-change-pending";
  const profileName = profile.displayName ?? profile.transport;
  const presentation = resolveRemoteConnectionPresentation({ ...state, target: profile.target });
  const mutationBusy =
    busyScopes.has(profileOperationScope(profile)) || presentation.status === "connecting";
  const actionBusy =
    mutationBusy && !["security", "details"].includes(presentation.primaryAction);
  const devicePresentation = server
    ? resolveRemoteConnectionPresentation(
        getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
      )
    : null;
  const connectionErrorText =
    presentation.reason && devicePresentation?.profileId !== profile.profileId
      ? intl.formatMessage({ id: presentation.reason.titleId }, presentation.reason.values)
      : null;
  return (
    <div
      key={profile.profileId}
      className="group/line -mx-2 flex min-w-0 flex-wrap items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
    >
      <RemoteConnectionKindTag kind={profile.transport} />
      {!server ? <RemoteConnectionStatusTag presentation={presentation} /> : null}
      <span className="shrink-0 text-ui-sm font-medium text-foreground">{profileName}</span>
      <span className="min-w-0 truncate font-mono text-ui-xs text-remote-foreground-muted">
        {formatConnectionProfileTarget(profile)}
      </span>
      {server?.preferredProfileId === profile.profileId ? (
        <span className="shrink-0 rounded-md bg-tag px-2 py-0.5 text-ui-xs text-remote-foreground-muted">
          {intl.formatMessage({ id: "settings.source.defaultProfile" })}
        </span>
      ) : null}
      <span className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
        {connectionErrorText ? (
          <span
            className="max-w-64 truncate text-ui-xs text-destructive-surface-foreground"
            title={connectionErrorText}
          >
            {connectionErrorText}
          </span>
        ) : profile.lastConnectedAt ? (
          <span
            className="text-ui-xs text-remote-foreground-muted"
            title={formatTimestamp(profile.lastConnectedAt, locale)}
          >
            {intl.formatMessage(
              { id: "settings.source.lastConnected" },
              {
                time: formatRelativeTimestamp(
                  profile.lastConnectedAt,
                  locale,
                  intl.formatMessage,
                ),
              },
            )}
          </span>
        ) : null}
        {!isOnline && !identityChangePending ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={actionBusy}
            onClick={() =>
              handleProfileAction(
                profile,
                resolveRemoteConnectionPresentation({
                  ...stateByProfile.get(profile.profileId),
                  target: profile.target,
                }),
              )
            }
          >
            {intl.formatMessage({
              id: resolveRemoteConnectionPresentation({ ...state, target: profile.target })
                .actionMessageId,
            })}
          </Button>
        ) : null}
        {identityChangePending ? <IdentityConfirmationButton profile={profile} size="xs" /> : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={intl.formatMessage({
            id: "settings.source.editConnection",
          })}
          disabled={busyScopes.has(profileOperationScope(profile))}
          onClick={() => setEditingConnection({ profile })}
        >
          <Pencil className="size-3.5" />
          {intl.formatMessage({ id: "settings.source.editConnection" })}
        </Button>
        {server && server.preferredProfileId !== profile.profileId ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={mutationBusy}
            onClick={() =>
              void run(
                `preferred:${profile.profileId}`,
                () => management.setPreferredProfile(server.sourceServerId, profile.profileId),
                [profileOperationScope(profile)],
              )
            }
          >
            {intl.formatMessage({ id: "settings.source.setDefault" })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={mutationBusy}
          onClick={() => void removeProfile(profile)}
        >
          <Trash2 className="size-3.5" />
          {intl.formatMessage({ id: "settings.source.removeProfile" })}
        </Button>
      </span>
    </div>
  );
}
