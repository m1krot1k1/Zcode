import type { ConnectionProfile } from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import { SourceServerUpdateActivity } from "@/settings/SourceServerUpdateActivity.js";
import { EditConnectionProfileDialog } from "@/remote-connection/EditConnectionProfileDialog.js";
import { usePanelRuntime } from "./panelContext.js";
import type { EditingConnectionState } from "./panelContext.js";

export function ErrorDetailsDialog({
  profile,
  onClose,
}: {
  profile: ConnectionProfile | null;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { stateByProfile, logsByProfileId } = usePanelRuntime();

  return (
    <Dialog
      open={Boolean(profile)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {profile
          ? (() => {
              const state = stateByProfile.get(profile.profileId);
              const classified = classifyRemoteConnectionError({
                errorCode: state?.errorCode,
                error: state?.error,
                target: profile.target,
              });
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>{intl.formatMessage({ id: classified.titleId })}</DialogTitle>
                    <DialogDescription>
                      {intl.formatMessage({ id: classified.reasonId })}
                    </DialogDescription>
                  </DialogHeader>
                  <details>
                    <summary>{intl.formatMessage({ id: "remote.error.details" })}</summary>
                    <pre className="whitespace-pre-wrap break-words text-ui-sm">
                      {state?.error ?? profile.lastConnectError}
                    </pre>
                  </details>
                  <SourceServerUpdateActivity
                    active={false}
                    recent
                    logs={logsByProfileId[profile.profileId] ?? []}
                  />
                </>
              );
            })()
          : null}
      </DialogContent>
    </Dialog>
  );
}

export function EditConnectionDialog({
  connection,
  onOpenChange,
  onSaved,
}: {
  connection: EditingConnectionState | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { management } = usePanelRuntime();

  return (
    <EditConnectionProfileDialog
      open={connection !== null}
      profile={connection?.profile ?? null}
      source={connection?.server}
      focusField={connection?.focusField}
      management={management}
      onOpenChange={onOpenChange}
      onSaved={onSaved}
    />
  );
}
