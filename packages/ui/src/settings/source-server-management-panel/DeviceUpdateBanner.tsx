import type {
  ConnectionProfile,
  SourceServerConnectionStateSnapshot,
  SourceServerOperationLog,
} from "@zcode/shared";
import { DesktopCommandIds } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { SourceServerUpdateActivity } from "@/settings/SourceServerUpdateActivity.js";
import { sourceServerUpdatePreferences } from "@/lib/sourceServerUpdatePreferences.js";
import { usePanelRuntime } from "./panelContext.js";

export function DeviceUpdateBanner({
  serverState,
  presentation,
  updateFailed,
  updateFailureText,
  updateKey,
  serverProfiles,
  operationLogs,
  deviceBusy,
}: {
  serverState: SourceServerConnectionStateSnapshot;
  presentation: RemoteConnectionPresentation;
  updateFailed: boolean;
  updateFailureText: string | null;
  updateKey: string;
  serverProfiles: ConnectionProfile[];
  operationLogs: SourceServerOperationLog[];
  deviceBusy: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { run, platform, updateProfile, busyOperations } = usePanelRuntime();

  return (
    <div
      className={cn(
        "mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-ui-sm",
        presentation.updateNotice.surface,
        presentation.updateNotice.foreground,
      )}
    >
      <span>
        {serverState.state === "updating"
          ? intl.formatMessage({
              id: "settings.source.updateInProgress",
            })
          : updateFailed
            ? updateFailureText
            : serverState.updateAvailability === "required"
              ? intl.formatMessage({
                  id: "settings.source.updateRequired",
                })
              : intl.formatMessage(
                  { id: "settings.source.updateAvailableVersion" },
                  {
                    version: serverState.availableVersion?.replace(/^v/i, "") ?? "",
                  },
                )}
      </span>
      {serverState.updateAvailability === "available" && serverState.state !== "updating" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => sourceServerUpdatePreferences.defer(updateKey)}
        >
          {intl.formatMessage({ id: "updateDialog.later" })}
        </Button>
      ) : null}
      {serverState.state !== "updating" &&
      presentation.primaryAction !== "update-server" &&
      presentation.primaryAction !== "update-desktop" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={deviceBusy || busyOperations.has("desktop-update")}
          onClick={() => {
            const profile = serverProfiles.find(
              (candidate) => candidate.profileId === serverState.profileId,
            );
            if (serverState.upgradeTarget === "controller")
              void run("desktop-update", async () => {
                await platform?.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
              });
            else if (profile) void updateProfile(profile);
          }}
        >
          {intl.formatMessage({
            id:
              serverState.upgradeTarget === "controller"
                ? "remote.action.update-desktop"
                : updateFailed
                  ? "remote.action.retry"
                  : "remote.action.update-server",
          })}
        </Button>
      ) : null}
      {serverState.state === "updating" ? (
        <>
          <SourceServerUpdateActivity
            active={serverState.state === "updating"}
            logs={operationLogs}
          />
          <p className="basis-full text-ui-xs opacity-80">
            {intl.formatMessage({
              id: "settings.source.updateScopeNote",
            })}
          </p>
        </>
      ) : serverState.currentVersion && serverState.minimumVersion ? (
        <p className="basis-full text-ui-xs opacity-80">
          {intl.formatMessage(
            { id: "settings.source.versionDetails" },
            {
              current: serverState.currentVersion.replace(/^v/i, ""),
              minimum: serverState.minimumVersion.replace(/^v/i, ""),
            },
          )}
        </p>
      ) : null}
    </div>
  );
}
