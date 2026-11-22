import { useEffect, useMemo, useRef, useState } from "react";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";
import {
  buildRemotePluginSyncRowsForCandidates,
  filterRemotePluginSyncRows,
  resolveDefaultRemotePluginSyncSelection,
  shouldAllowRemotePluginSyncDialogOpenChange,
} from "@/settings/remote-plugin-sync-dialog/candidateRows.js";
import { loadRemotePluginSyncCandidates } from "@/settings/remote-plugin-sync-dialog/loadCandidates.js";
import { syncSelectedRemotePlugins } from "@/settings/remote-plugin-sync-dialog/syncSelectedRemotePlugins.js";
import { shouldFinishRemotePluginSyncRun } from "@/settings/remote-plugin-sync-dialog/syncSteps.js";
import type {
  RemotePluginSyncDialogProps,
  RemotePluginSyncProgressView,
  RemotePluginSyncRow,
  RemotePluginSyncRunResult,
  Step,
} from "@/settings/remote-plugin-sync-dialog/types.js";

export function useRemotePluginSyncDialog(props: RemotePluginSyncDialogProps) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const {
    localPluginSyncService,
    localWorkspacePath,
    localZCodeAgentService,
    onOpenChange,
    onSynced,
    open,
    remotePluginSyncService,
    remoteZCodeAgentService,
    remoteTarget,
    workspacePath,
    workspaceIdentity,
  } = props;
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemotePluginSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showExistingRemotePlugins, setShowExistingRemotePlugins] = useState(true);
  const [importResult, setImportResult] = useState<RemotePluginSyncRunResult | null>(null);
  const [syncProgressById, setSyncProgressById] = useState<
    Map<string, RemotePluginSyncProgressView>
  >(new Map());
  const [syncRows, setSyncRows] = useState<RemotePluginSyncRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRequestedRef = useRef<Set<string>>(new Set());
  const stopWaitersRef = useRef<Map<string, () => void>>(new Map());
  const syncInFlightRef = useRef(false);
  const syncAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemotePlugins(true);
    setImportResult(null);
    setSyncProgressById(new Map());
    setSyncRows([]);
    setError(null);
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    stopRequestedRef.current = new Set();
    stopWaitersRef.current = new Map();
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const { candidates, statuses } = await loadRemotePluginSyncCandidates({
          localPluginSyncService,
          localWorkspacePath: localWorkspacePath ?? workspacePath,
          localZCodeAgentService,
          remotePluginSyncService,
          remoteWorkspaceIdentity: workspaceIdentity,
          remoteWorkspacePath: workspacePath,
          remoteZCodeAgentService,
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemotePluginSyncRowsForCandidates(candidates, statuses);
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemotePluginSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStep("selection");
      }
    })();

    return () => {
      cancelled = true;
      // 远端目标失效会直接卸载 Dialog，绕过“同步中禁止关闭”的交互保护。
      // 主动终止当前 run，避免旧目标上的后续步骤和结果继续落回已失效的 UI。
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
    };
  }, [
    localPluginSyncService,
    localWorkspacePath,
    localZCodeAgentService,
    open,
    remotePluginSyncService,
    remoteZCodeAgentService,
    workspaceIdentity,
    workspacePath,
  ]);

  const visibleRows = useMemo(
    () => filterRemotePluginSyncRows(rows, showExistingRemotePlugins),
    [rows, showExistingRemotePlugins],
  );
  const visibleMissingIds = useMemo(
    () => visibleRows.filter((row) => !row.exists).map((row) => row.candidate.id),
    [visibleRows],
  );
  const selectedSyncIds = useMemo(
    () => visibleMissingIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleMissingIds],
  );
  const selectedCount = selectedSyncIds.length;
  const targetLabel = formatRemoteSkillSyncTarget(remoteTarget, workspacePath);

  const handleOpenChange = (nextOpen: boolean) => {
    // plugin 同步是逐项远端 RPC；同步中关闭弹窗会让下次打开时重置为 loading/0 项，
    // 但后台 RPC 仍在跑。同步中只拦截关闭请求，避免丢失进度状态。
    if (!shouldAllowRemotePluginSyncDialogOpenChange(step, nextOpen)) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const togglePlugin = (pluginId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(pluginId);
      } else {
        next.delete(pluginId);
      }
      return next;
    });
  };

  const stopPluginSync = (candidateId: string) => {
    stopRequestedRef.current.add(candidateId);
    stopWaitersRef.current.get(candidateId)?.();
    // 远端 marketplace install/add 会占用插件存储锁；只在远程同步生成的
    // operationId 上发送取消，避免误伤本地插件页的常规安装、启停和市场管理操作。
    setSyncProgressById((current) => {
      const next = new Map(current);
      const previous = next.get(candidateId) ?? { logs: [], status: "queued" as const };
      next.set(candidateId, {
        ...previous,
        logs: [
          ...previous.logs,
          "stop requested; cancelling the active remote plugin operation when possible",
        ],
        status: "stopped",
      });
      return next;
    });
  };

  const syncSelected = async () => {
    if (
      !shouldStartRemoteSyncOperation({
        inFlight: syncInFlightRef.current,
        selectedCount: selectedSyncIds.length,
      })
    ) {
      if (selectedSyncIds.length === 0) {
        setError(intl.formatMessage({ id: "settings.plugins.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    const syncAbortController = new AbortController();
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = syncAbortController;
    const finishSyncRun = () => {
      if (!shouldFinishRemotePluginSyncRun(syncAbortControllerRef.current, syncAbortController)) {
        return;
      }
      syncAbortControllerRef.current = null;
      syncInFlightRef.current = false;
    };
    setError(null);
    setStep("preflighting");
    const selectedRows = rows.filter((row) => !row.exists && selectedIds.has(row.candidate.id));
    try {
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remotePluginSyncService.checkRemoteUserPluginWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
    } catch (syncError) {
      if (syncAbortController.signal.aborted) {
        finishSyncRun();
        return;
      }
      setError(
        isRemoteSyncPreflightTimeoutError(syncError)
          ? intl.formatMessage(
              { id: "settings.remoteSync.preflightTimeout" },
              { seconds: String(Math.ceil(syncError.timeoutMs / 1000)) },
            )
          : syncError instanceof Error
            ? syncError.message
            : String(syncError),
      );
      setStep("selection");
      finishSyncRun();
      return;
    }

    if (syncAbortController.signal.aborted) {
      finishSyncRun();
      return;
    }

    setStep("syncing");
    setSyncRows(selectedRows);
    setSyncProgressById(
      new Map(
        selectedRows.map((row) => [
          row.candidate.id,
          {
            logs: ["Queued plugin sync"],
            status: "queued" as const,
          },
        ]),
      ),
    );
    stopRequestedRef.current = new Set();
    stopWaitersRef.current = new Map();
    try {
      const result = await syncSelectedRemotePlugins({
        localPluginSyncService,
        reportTelemetryEvent: (event) =>
          reportAppTelemetryEvent(
            platform,
            {
              ...event,
              eventExtraDetail: {
                ...event.eventExtraDetail,
                client_kind: "desktop",
                remote_kind: remoteTarget.kind,
              },
            },
            "RemotePluginSync",
          ),
        onItemProgress: (event) => {
          if (syncAbortController.signal.aborted) {
            return;
          }
          setSyncProgressById((current) => {
            const next = new Map(current);
            const previous = next.get(event.candidateId) ?? {
              logs: [],
              status: "queued" as const,
            };
            next.set(event.candidateId, {
              logs: [...previous.logs, event.log],
              ...(event.result
                ? { result: event.result }
                : previous.result
                  ? { result: previous.result }
                  : {}),
              status: event.status,
            });
            return next;
          });
        },
        remotePluginSyncService,
        remoteWorkspaceIdentity: workspaceIdentity,
        remoteWorkspacePath: workspacePath,
        remoteZCodeAgentService,
        rows: selectedRows,
        signal: syncAbortController.signal,
        stopControl: {
          cancelOperation: async (operationId) => {
            if (!remoteZCodeAgentService?.cancelPluginOperation) {
              return;
            }
            await remoteZCodeAgentService.cancelPluginOperation({ operationId });
          },
          isStopped: (candidateId) => stopRequestedRef.current.has(candidateId),
          waitForStop: (candidateId) => {
            if (stopRequestedRef.current.has(candidateId)) {
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              stopWaitersRef.current.set(candidateId, resolve);
            });
          },
        },
      });
      if (syncAbortController.signal.aborted) {
        return;
      }
      await onSynced();
      if (syncAbortController.signal.aborted) {
        return;
      }
      setImportResult(result);
      setStep("complete");
    } catch (syncError) {
      if (syncAbortController.signal.aborted) {
        return;
      }
      setError(syncError instanceof Error ? syncError.message : String(syncError));
      setStep("selection");
    } finally {
      finishSyncRun();
    }
  };

  return {
    error,
    handleOpenChange,
    importResult,
    intl,
    rows,
    selectedCount,
    selectedIds,
    setSelectedIds,
    setShowExistingRemotePlugins,
    showExistingRemotePlugins,
    step,
    stopPluginSync,
    syncProgressById,
    syncRows,
    syncSelected,
    targetLabel,
    togglePlugin,
    visibleMissingIds,
    visibleRows,
  };
}
