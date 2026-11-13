import { DesktopCommandIds, type RemoteTarget } from "@zcode/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MinusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  classifyRemoteConnectionError,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  RemoteConnectionStatusTag,
  RemoteConnectionKindTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import {
  formatRemoteLinkRailTarget,
  formatRemoteLinkRailDevice,
} from "@/remote-connection/RemoteLinkRail.js";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";
import {
  resolveRemoteConnectionPhases,
  type RemoteConnectionPhaseStatus,
} from "@/remote-connection/connecting-step/phases.js";
import { resolveRemoteConnectionLogTime } from "@/remote-connection/connecting-step/logTime.js";
import { buildRemoteConnectionFeedbackDescription } from "@/remote-connection/connecting-step/feedbackDescription.js";
import { RemoteConnectionStageList } from "@/remote-connection/connecting-step/RemoteConnectionStageList.js";
import { RemoteConnectionLogPanel } from "@/remote-connection/connecting-step/RemoteConnectionLogPanel.js";
import { RemoteConnectionErrorPanel } from "@/remote-connection/connecting-step/RemoteConnectionErrorPanel.js";
import type {
  RemoteConnectionCredentialsForm,
  RemoteConnectionForceUpdate,
  RemoteConnectionInstallConfirmation,
} from "@/remote-connection/connecting-step/types.js";

export {
  resolveRemoteConnectionPhases,
  resolveRemoteConnectionPhaseSub,
  resolveRemoteOperationProgress,
} from "@/remote-connection/connecting-step/phases.js";

export function RemoteConnectionConnectingStep({
  kind,
  logs,
  errorMessage,
  errorCode,
  rawError,
  upgradeTarget,
  loading,
  installConfirmation,
  target,
  recognizedDeviceName,
  profileName,
  onUseRemoteDownload,
  onBack,
  onRetry,
  upgradeRequired = false,
  upgradeLoading = false,
  onUpgrade,
  connectionReady = false,
  cancelled = false,
  onCancelConnection,
  credentials,
  forceUpdate,
  onMinimize,
  onClose,
  onBackToDevices,
  backToDevicesLabel,
}: {
  forceUpdate?: RemoteConnectionForceUpdate;
  credentials?: RemoteConnectionCredentialsForm;
  onMinimize?: () => void;
  onClose?: () => void;
  onBackToDevices?: () => void;
  backToDevicesLabel?: string;
  kind: RemoteTarget["kind"];
  logs: RemoteConnectionLogEntry[];
  errorMessage: string;
  errorCode?: string;
  rawError?: string;
  upgradeTarget?: "controller" | "server";
  loading: boolean;
  installConfirmation?: RemoteConnectionInstallConfirmation;
  target?: RemoteTarget | null;
  recognizedDeviceName?: string;
  profileName?: string;
  recognizedDeviceMeta?: string;
  localVersion?: string;
  onUseRemoteDownload?: () => void;
  onBack: () => void;
  onRetry: () => void;
  upgradeRequired?: boolean;
  upgradeLoading?: boolean;
  onUpgrade?: () => void;
  connectionReady?: boolean;
  cancelled?: boolean;
  onCancelConnection?: () => void;
  onContinueToDirectory?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const credentialInputId = useId();
  const platform = usePlatform();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestLogRef = useRef(true);
  const latestLogId = logs.at(-1)?.id;
  const latestLogTimestamp = logs.at(-1)?.timestamp;
  const [now, setNow] = useState(Date.now);
  const [mountedAt] = useState(Date.now);
  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loading]);
  const waitingPhase = credentials
    ? "channel"
    : installConfirmation || forceUpdate
      ? "deploy"
      : undefined;
  const phases = resolveRemoteConnectionPhases(logs, { connectionReady }).map(
    (phase, index, all) => {
      const waitingIndex = all.findIndex((item) => item.key === waitingPhase);
      if (waitingIndex >= 0)
        return {
          ...phase,
          status: (index < waitingIndex
            ? "complete"
            : index === waitingIndex
              ? "active"
              : "pending") as RemoteConnectionPhaseStatus,
        };
      if (loading && !logs.length && index === 0) return { ...phase, status: "active" as const };
      return phase;
    },
  );
  const errorPresentation = classifyRemoteConnectionError({
    errorCode: credentials && !errorCode ? "credentials-required" : errorCode,
    error: rawError ?? errorMessage,
    target: target ?? undefined,
    upgradeTarget,
  });
  const presentation = resolveRemoteConnectionPresentation({
    state: forceUpdate
      ? "needs-upgrade"
      : upgradeLoading
        ? "updating"
        : installConfirmation
          ? "needs-install"
          : loading
            ? "bootstrapping"
            : upgradeRequired
              ? "needs-upgrade"
              : errorMessage
                ? "failed"
                : connectionReady
                  ? "online"
                  : "absent",
    errorCode: credentials && !errorCode ? "credentials-required" : errorCode,
    error: rawError ?? errorMessage,
    upgradeTarget,
    target: target ?? undefined,
    wizard: true,
  });
  const failed = presentation.status === "failed" && !loading && !cancelled;
  const errorDetailsRef = useRef<HTMLDetailsElement>(null);
  const [logsExpanded, setLogsExpanded] = useState(Boolean(errorMessage));

  useEffect(() => {
    if (errorMessage) setLogsExpanded(true);
  }, [errorMessage]);

  const handleLogContainerScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    shouldFollowLatestLogRef.current = isRemoteConnectionLogScrolledToLatest(container);
  }, []);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    // 日志持续追加会推高 scrollHeight，无条件写 scrollTop 会把向上查看历史日志的用户拉回底部。
    // 这里只在用户原本贴底时继续跟随最新日志。
    if (
      scrollRemoteConnectionLogsToLatestIfFollowing(container, shouldFollowLatestLogRef.current)
    ) {
      shouldFollowLatestLogRef.current = true;
    }
  }, [logs.length, latestLogId, latestLogTimestamp]);

  const handleOpenFeedback = async () => {
    // 远程连接失败时用户看到的是连接日志现场。
    // 反馈入口只预填脱敏后的错误摘要，附件由用户主动选择。
    openFeedbackSubmit({
      title:
        errorMessage.slice(0, 80) ||
        intl.formatMessage({ id: "feedback.submit.template.section.remoteConnectFailed" }),
      type: "bug",
      module: kind === "ssh" ? "SSH连接失败" : kind === "wsl" ? "WSL连接失败" : "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildRemoteConnectionFeedbackDescription(errorMessage, logs, (id, values) =>
        intl.formatMessage({ id }, values),
      ),
      screenshots: [],
    });
  };

  // 主操作按钮按呈现层给出的动作分流；只有 details/security 需要先展开错误详情。
  const handlePrimaryAction = () => {
    if (presentation.primaryAction === "cancel") onCancelConnection?.();
    else if (presentation.primaryAction === "update-desktop")
      void platform.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
    else if (presentation.primaryAction === "update-server" && onUpgrade) onUpgrade();
    else if (["credentials", "edit-auth", "edit-host"].includes(presentation.primaryAction))
      onBack();
    else if (["security", "details"].includes(presentation.primaryAction)) {
      if (errorDetailsRef.current) errorDetailsRef.current.open = true;
    } else onRetry();
  };

  const errorPanel =
    errorMessage || credentials ? (
      <RemoteConnectionErrorPanel
        errorMessage={errorMessage}
        credentials={credentials}
        credentialInputId={credentialInputId}
        rawError={rawError}
        loading={loading}
        upgradeLoading={upgradeLoading}
        presentation={presentation}
        errorPresentation={errorPresentation}
        errorDetailsRef={errorDetailsRef}
        onPrimaryAction={handlePrimaryAction}
        onBack={onBack}
        onUseRemoteDownload={onUseRemoteDownload}
        onOpenFeedback={() => {
          void handleOpenFeedback();
        }}
      />
    ) : null;
  const errorPhase = credentials
    ? "channel"
    : errorCode === "source-server-identity-change-pending"
      ? "identify"
      : (phases.find((phase) => phase.status === "failed")?.key ??
        phases.find((phase) => phase.status === "active")?.key ??
        "channel");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 ">
      <div className="flex flex-col flex-1 min-h-0 space-y-4 overflow-y-auto">
        <div className="shrink-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-base font-semibold">
              {recognizedDeviceName ??
                profileName ??
                (target
                  ? formatRemoteLinkRailDevice(target)
                  : intl.formatMessage({ id: "remote.phase.channel" }))}
            </h3>
            {kind === "server" ? (
              <span className="text-ui-xs">Server</span>
            ) : (
              <RemoteConnectionKindTag kind={kind} />
            )}
            {cancelled ? null : <RemoteConnectionStatusTag presentation={presentation} />}
          </div>
          {target ? (
            <p className="break-all font-mono text-ui-sm text-remote-foreground-muted">
              {formatRemoteLinkRailTarget(target)}
            </p>
          ) : null}
        </div>
        <RemoteConnectionStageList
          kind={kind}
          logs={logs}
          phases={phases}
          waitingPhase={waitingPhase}
          recognizedDeviceName={recognizedDeviceName}
          installConfirmation={installConfirmation}
          forceUpdate={forceUpdate}
          errorPhase={errorPhase}
          errorPanel={errorPanel}
          loading={loading}
          now={now}
          mountedAt={mountedAt}
        />
        <RemoteConnectionLogPanel
          logs={logs}
          expanded={logsExpanded}
          onToggleExpanded={() => setLogsExpanded((expanded) => !expanded)}
          containerRef={logContainerRef}
          onScroll={handleLogContainerScroll}
        />
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3">
        {failed || onMinimize ? (
          <Button type="button" variant="ghost" onClick={failed ? onBackToDevices : onMinimize}>
            {failed ? null : <MinusIcon className="size-4" />}
            {failed && backToDevicesLabel
              ? backToDevicesLabel
              : intl.formatMessage({
                  id: failed ? "remote.selection.back" : "remote.continueInBackground",
                })}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={upgradeLoading}
          onClick={failed ? onClose : cancelled ? onRetry : onCancelConnection}
        >
          {intl.formatMessage({
            id: failed ? "common.close" : cancelled ? "common.retry" : "remote.cancelConnection",
          })}
        </Button>
      </div>
    </div>
  );
}
