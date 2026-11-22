/** 已连接远程 workspace 时的技能同步入口。 */
import { UploadCloud } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function SkillsRemoteSyncAction({ onOpen }: { onOpen: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "settings.skills.remoteSync.open" })}
    >
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        aria-label={intl.formatMessage({
          id: "settings.skills.remoteSync.open",
        })}
        onClick={onOpen}
      >
        <UploadCloud className="size-3.5" aria-hidden="true" />
      </Button>
    </ControlHintTooltip>
  );
}
