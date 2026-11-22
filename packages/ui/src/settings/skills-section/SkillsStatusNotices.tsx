/** 技能分区的内联状态提示：远程上下文、桌面专属能力与列表错误。 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function SkillsRemoteContextNotice({
  targetLabel,
}: {
  targetLabel: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
      {intl.formatMessage(
        { id: "settings.skills.remoteContext" },
        { target: targetLabel },
      )}
    </div>
  );
}

export function SkillsUserScopeNotice() {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "settings.skills.userScopeDesktopOnly" })}
    </div>
  );
}

export function SkillsErrorNotice({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
      {message}
    </div>
  );
}
