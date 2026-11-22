import { Loader2 } from "lucide-react";
import type { ConnectionProfile } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePanelRuntime } from "./panelContext.js";
import { profileOperationScope } from "./panelModel.js";

export function IdentityConfirmationButton({
  profile,
  size,
}: {
  profile: ConnectionProfile;
  size: "sm" | "xs";
}) {
  const { intl } = useZCodeIntl();
  const {
    busyScopes,
    busyOperations,
    stateByProfile,
    run,
    management,
    confirmDialog,
  } = usePanelRuntime();

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={
        busyScopes.has(profileOperationScope(profile)) ||
        stateByProfile.get(profile.profileId)?.state === "updating"
      }
      onClick={() =>
        void confirmDialog({
          title: intl.formatMessage({ id: "settings.source.identityChangeTitle" }),
          description: intl.formatMessage({ id: "settings.source.identityChangeDescription" }),
          confirmLabel: intl.formatMessage({ id: "settings.source.identityChangeConfirm" }),
        }).then((confirmed) =>
          confirmed
            ? run(
                `identity:${profile.profileId}`,
                () => management.confirmIdentityChange(profile.profileId),
                [profileOperationScope(profile)],
              )
            : undefined,
        )
      }
    >
      {busyOperations.has(`identity:${profile.profileId}`) ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : null}
      {intl.formatMessage({ id: "settings.source.identityChangeConfirm" })}
    </Button>
  );
}
