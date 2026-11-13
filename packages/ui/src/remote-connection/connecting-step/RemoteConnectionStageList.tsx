import type { ReactNode } from "react";
import type { RemoteTarget } from "@zcode/shared";
import { AlertTriangleIcon, CheckIcon, LoaderIcon, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  normalizeRemoteConnectionPhase,
  resolveRemoteConnectionPhaseSub,
  resolveRemoteConnectionPhases,
} from "@/remote-connection/connecting-step/phases.js";
import { resolveRemoteConnectionLogTime } from "@/remote-connection/connecting-step/logTime.js";
import { RemoteConnectionInstallPanel } from "@/remote-connection/connecting-step/RemoteConnectionInstallPanel.js";
import { RemoteConnectionForceUpdatePanel } from "@/remote-connection/connecting-step/RemoteConnectionForceUpdatePanel.js";
import type {
  RemoteConnectionForceUpdate,
  RemoteConnectionInstallConfirmation,
} from "@/remote-connection/connecting-step/types.js";

/** 阶段轨只投影阶段状态、子说明与内嵌面板；错误面板由连接视图注入。 */
export function RemoteConnectionStageList({
  kind,
  logs,
  phases,
  waitingPhase,
  recognizedDeviceName,
  installConfirmation,
  forceUpdate,
  errorPhase,
  errorPanel,
  loading,
  now,
  mountedAt,
}: {
  kind: RemoteTarget["kind"];
  logs: RemoteConnectionLogEntry[];
  phases: ReturnType<typeof resolveRemoteConnectionPhases>;
  waitingPhase?: string;
  recognizedDeviceName?: string;
  installConfirmation?: RemoteConnectionInstallConfirmation;
  forceUpdate?: RemoteConnectionForceUpdate;
  errorPhase: string;
  errorPanel: ReactNode;
  loading: boolean;
  now: number;
  mountedAt: number;
}) {
  const { intl } = useZCodeIntl();
  const deploymentFailedLog = [...logs]
    .reverse()
    .find(
      (entry) =>
        entry.level === "error" &&
        /^\[source-server:(?:download|preflight|upload|install)\]/u.test(entry.message),
    );
  const deployErrorReason = deploymentFailedLog?.message.replace(
    /^\[source-server:[^\]]+\]\s*/u,
    "",
  );
  const logTime = (timestamp: string) => resolveRemoteConnectionLogTime(timestamp, mountedAt);
  return (
    <ol data-testid="remote-connection-stages" className="shrink-0 space-y-0.5 py-1">
      {phases.map((phase, phaseIndex) => {
        const phaseStart = logs.find((entry) => {
          const raw = /^\[source-server:([^\]]+)\]/u.exec(entry.message)?.[1];
          return raw && normalizeRemoteConnectionPhase(raw) === phase.key;
        });
        const nextStart = logs.find((entry) => {
          const raw = /^\[source-server:([^\]]+)\]/u.exec(entry.message)?.[1];
          return (
            raw &&
            phases.findIndex((item) => item.key === normalizeRemoteConnectionPhase(raw)) >
              phaseIndex
          );
        });
        const phaseLog = [...logs].reverse().find((entry) => {
          const match = /^\[source-server:([^\]]+)\]/u.exec(entry.message);
          return match && normalizeRemoteConnectionPhase(match[1]!) === phase.key;
        });
        const rawPhase = /^\[source-server:([^\]]+)\]/u.exec(phaseLog?.message ?? "")?.[1];
        const progressMatch =
          phase.status === "active" && (rawPhase === "upload" || rawPhase === "download")
            ? phaseLog?.message.match(/(\d+(?:\.\d+)?)%/u)
            : null;
        const transfer = phaseLog?.message.match(
          /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) MB, (\d+(?:\.\d+)?) MB\/s/u,
        );
        const remainingSeconds =
          transfer && Number(transfer[3]) > 0
            ? Math.max(
                0,
                Math.ceil((Number(transfer[2]) - Number(transfer[1])) / Number(transfer[3])),
              )
            : undefined;
        const phaseSub = resolveRemoteConnectionPhaseSub(phase, {
          kind,
          rawPhase,
          recognizedDeviceName,
          installConfirmationPending: Boolean(installConfirmation),
          deployErrorReason,
        });
        return (
          <li
            key={phase.key}
            className={cn(
              "relative flex shrink-0 min-w-0 items-start gap-3 rounded-md px-2.5 py-2 text-ui-sm",
              // 原型 .stages li.cur：当前阶段行有 surface 底色高亮。
              phase.status === "active" && "bg-surface",
            )}
          >
            {phaseIndex < phases.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute left-5 top-8 bottom-0 border-l border-border"
              />
            ) : null}
            <span
              className={cn(
                "relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                phase.status === "complete"
                  ? "border-success bg-success-surface text-success-surface-foreground"
                  : phase.status === "active"
                    ? phase.key === waitingPhase
                      ? "border-warning text-warning"
                      : "border-progress-surface-foreground text-progress-surface-foreground"
                    : phase.status === "failed"
                      ? "border-destructive text-destructive"
                      : "border-border text-remote-foreground-muted",
              )}
            >
              {phase.status === "complete" ? (
                <CheckIcon className="size-3" />
              ) : phase.key === waitingPhase ? (
                <AlertTriangleIcon className="size-3 text-warning" />
              ) : phase.status === "active" ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : phase.status === "failed" ? (
                <XIcon className="size-3" />
              ) : (
                <span className="size-1.5 rounded-full bg-current" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    phase.status === "pending"
                      ? "text-remote-foreground-muted"
                      : phase.status === "active"
                        ? "text-foreground font-semibold"
                        : "text-foreground"
                  }
                >
                  {intl.formatMessage({
                    id:
                      phase.key === "channel" && kind !== "server"
                        ? `remote.phase.channel.${kind}`
                        : phase.titleId,
                  })}
                </span>
                {phaseStart || phase.status === "active" ? (
                  <span className="text-ui-xs tabular-nums text-remote-foreground-muted">
                    {Math.max(
                      0,
                      Math.floor(
                        ((phase.status === "complete" && nextStart
                          ? logTime(nextStart.timestamp)
                          : loading
                            ? now
                            : phaseLog
                              ? logTime(phaseLog.timestamp)
                              : now) -
                          (phaseStart ? logTime(phaseStart.timestamp) : mountedAt)) /
                          1000,
                      ),
                    )}{" "}
                    s
                  </span>
                ) : null}
              </div>
              {phaseSub ? (
                <p className="break-words text-ui-xs text-remote-foreground-muted">
                  {intl.formatMessage({ id: phaseSub.id }, phaseSub.values)}
                </p>
              ) : null}
              {phase.key === "deploy" &&
              !phaseSub &&
              rawPhase &&
              phase.status === "active" &&
              ["download", "upload", "extract", "verify-archive", "verify", "install"].includes(
                rawPhase,
              ) ? (
                <p className="mt-1 text-ui-xs text-remote-foreground-muted">
                  {intl.formatMessage({
                    id:
                      rawPhase === "download"
                        ? "remote.phaseSub.downloading"
                        : rawPhase === "upload"
                          ? "remote.phaseSub.uploading"
                          : rawPhase === "extract"
                            ? "remote.phaseSub.extracting"
                            : "remote.phaseSub.verifyingFiles",
                  })}
                </p>
              ) : null}
              {phase.key === "deploy" && installConfirmation ? (
                <RemoteConnectionInstallPanel confirmation={installConfirmation} />
              ) : null}
              {phase.key === "deploy" && forceUpdate ? (
                <RemoteConnectionForceUpdatePanel forceUpdate={forceUpdate} />
              ) : null}
              {phase.key === errorPhase && !forceUpdate ? errorPanel : null}
              {progressMatch ? (
                <p className="mt-1 text-ui-xs tabular-nums text-remote-foreground-muted">
                  {phaseLog?.message.match(/\([^)]+MB[^)]*\)/u)?.[0]}
                  {" · "}
                  {intl.formatMessage(
                    {
                      id:
                        remainingSeconds === undefined
                          ? "remote.transferTimeUnknown"
                          : "remote.transferTimeRemaining",
                    },
                    { seconds: remainingSeconds ?? 0 },
                  )}
                </p>
              ) : null}
              {progressMatch ? (
                <div
                  role="progressbar"
                  aria-label={intl.formatMessage({
                    id:
                      rawPhase === "download"
                        ? "remote.phaseSub.downloading"
                        : "remote.phaseSub.uploading",
                  })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(progressMatch[1])}
                  className="mt-1.5 h-1 max-w-sm overflow-hidden rounded-full bg-surface"
                >
                  <div
                    className="h-full rounded-full bg-progress-surface-foreground"
                    style={{ width: `${progressMatch[1]}%` }}
                  />
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
