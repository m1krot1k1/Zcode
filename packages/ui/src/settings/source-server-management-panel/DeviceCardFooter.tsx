import type { ConnectionProfile, SourceServerOperationLog, SourceServerRecord } from "@zcode/shared";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { SourceServerLogList } from "@/settings/SourceServerUpdateActivity.js";
import { usePanelRuntime } from "./panelContext.js";
import { ConnectionProfileRow } from "./ConnectionProfileRow.js";

export function DeviceCardFooter({
  server,
  otherProfiles,
  showOtherProfiles,
  otherProfilesExpanded,
  showRecentLog,
  logExpanded,
  operationLogs,
}: {
  server: SourceServerRecord;
  otherProfiles: ConnectionProfile[];
  showOtherProfiles: boolean;
  otherProfilesExpanded: boolean;
  showRecentLog: boolean;
  logExpanded: boolean;
  operationLogs: SourceServerOperationLog[];
}) {
  const { intl } = useZCodeIntl();
  const { setExpandedSavedConnectionSources, setLogExpansionBySource } = usePanelRuntime();

  return (
    <div className="border-t border-border px-4 py-2" data-device-card-footer>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {showOtherProfiles ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 text-remote-foreground-muted"
            aria-label={intl.formatMessage({
              id: "settings.source.otherSavedConnections",
            })}
            aria-expanded={otherProfilesExpanded}
            onClick={() =>
              setExpandedSavedConnectionSources((current) => {
                const next = new Set(current);
                if (next.has(server.sourceServerId)) next.delete(server.sourceServerId);
                else next.add(server.sourceServerId);
                return next;
              })
            }
          >
            {otherProfilesExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            {intl.formatMessage(
              { id: "settings.source.otherSavedConnectionsCount" },
              { count: otherProfiles.length },
            )}
          </Button>
        ) : null}
        {showRecentLog ? (
          <Button
            data-source-server-log-toggle
            type="button"
            variant="ghost"
            size="sm"
            // 只有日志入口时靠左，避免页脚左侧空出一整行。
            className={cn(
              "text-remote-foreground-muted",
              showOtherProfiles ? "-mr-2 ml-auto" : "-ml-2",
            )}
            aria-expanded={logExpanded}
            onClick={() =>
              setLogExpansionBySource((current) =>
                new Map(current).set(server.sourceServerId, !logExpanded),
              )
            }
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", logExpanded && "rotate-90")}
            />
            {intl.formatMessage({ id: "settings.source.recentLog" })}
          </Button>
        ) : null}
      </div>
      {otherProfilesExpanded ? (
        <div className="mt-1 px-2 py-1">
          {otherProfiles.map((profile) => (
            <ConnectionProfileRow key={profile.profileId} profile={profile} server={server} />
          ))}
        </div>
      ) : null}
      {logExpanded ? (
        <div className="mt-1 pb-1">
          <SourceServerLogList logs={operationLogs} />
        </div>
      ) : null}
    </div>
  );
}
