import type { RefObject } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 日志面板只做展开/复制与滚动容器，跟随最新的判定仍由连接视图持有。 */
export function RemoteConnectionLogPanel({
  logs,
  expanded,
  onToggleExpanded,
  containerRef,
  onScroll,
}: {
  logs: RemoteConnectionLogEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    // 日志区使用 max-h-48 语义档位，避免把原型 180px 固化为组件专属高度。
    <div className="flex flex-col">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start px-0"
        onClick={onToggleExpanded}
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
        />
        {intl.formatMessage({ id: "remote.connectionLog" })}
        <span className="text-remote-foreground-muted">
          {intl.formatMessage({ id: "remote.connectionLogLines" }, { count: String(logs.length) })}
        </span>
      </Button>
      {expanded ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-end"
          onClick={() => {
            void navigator.clipboard.writeText(
              logs
                .map((entry) => `${entry.timestamp} [${entry.level}] ${entry.message}`)
                .join("\n"),
            );
          }}
        >
          {intl.formatMessage({ id: "remote.copyLog" })}
        </Button>
      ) : null}
      {expanded ? (
        <div
          data-testid="remote-connection-log"
          ref={containerRef}
          onScroll={onScroll}
          className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-xs leading-6"
        >
          {logs.length > 0 ? (
            logs.map((entry) => (
              <div key={entry.id} className="w-full flex min-w-0 text-foreground">
                <span className="text-remote-foreground-muted">{entry.timestamp}</span>
                <span
                  className={cn(
                    "mx-2",
                    entry.level === "success"
                      ? "text-success"
                      : entry.level === "warn"
                        ? "text-warning"
                        : entry.level === "error"
                          ? "text-destructive"
                          : "text-remote-foreground-muted",
                  )}
                >
                  [{entry.level.toUpperCase()}]
                </span>
                <span>{entry.message}</span>
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center py-2 text-remote-foreground-muted">
              <span>[INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
