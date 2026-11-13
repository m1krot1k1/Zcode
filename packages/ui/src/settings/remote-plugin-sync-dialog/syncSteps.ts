import type {
  RemotePluginSyncExecParams,
  RemotePluginSyncProgressEvent,
  RemotePluginSyncProgressStatus,
  RemotePluginSyncResultItem,
  RemotePluginSyncRow,
} from "@/settings/remote-plugin-sync-dialog/types.js";

export function shouldFinishRemotePluginSyncRun(
  currentRun: AbortController | null,
  run: AbortController,
): boolean {
  return currentRun === run;
}

export class RemotePluginSyncStoppedError extends Error {
  constructor(readonly row: RemotePluginSyncRow) {
    super(`Stopped sync for ${row.candidate.pluginId}`);
    this.name = "RemotePluginSyncStoppedError";
  }
}

let remotePluginSyncOperationCounter = 0;

function createRemotePluginSyncOperationId(row: RemotePluginSyncRow): string {
  remotePluginSyncOperationCounter += 1;
  const safePluginId = row.candidate.pluginId.replace(/[^a-z0-9._-]+/giu, "-");
  return `remote-plugin-sync-${remotePluginSyncOperationCounter}-${safePluginId}`;
}

export function isRemotePluginSyncStoppedError(
  error: unknown,
): error is RemotePluginSyncStoppedError {
  return error instanceof RemotePluginSyncStoppedError;
}

export function buildStoppedRemotePluginResult(
  row: RemotePluginSyncRow,
): RemotePluginSyncResultItem {
  return {
    name: row.candidate.name,
    pluginId: row.candidate.pluginId,
    directoryName:
      row.candidate.kind === "inline"
        ? (row.candidate.inlineCandidate?.directoryName ?? row.candidate.name)
        : `${row.candidate.marketplace}/${row.candidate.name}`,
    status: "stopped",
    error:
      "stop requested; stopped waiting for this plugin sync. Any remote RPC that already started may still finish on the remote target.",
  };
}

export function emitRemotePluginSyncProgress(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
  },
  row: RemotePluginSyncRow,
  status: RemotePluginSyncProgressStatus,
  log: string,
  result?: RemotePluginSyncResultItem,
) {
  params.onItemProgress?.({
    candidateId: row.candidate.id,
    log,
    pluginId: row.candidate.pluginId,
    ...(result ? { result } : {}),
    status,
  });
}

export function throwIfRemotePluginSyncStopped(
  params: RemotePluginSyncExecParams,
  row: RemotePluginSyncRow,
) {
  if (params.signal?.aborted || params.stopControl?.isStopped(row.candidate.id)) {
    throw new RemotePluginSyncStoppedError(row);
  }
}

export async function awaitRemotePluginSyncStep<T>(
  params: RemotePluginSyncExecParams,
  row: RemotePluginSyncRow,
  log: string,
  run: (operationId: string) => Promise<T>,
  options: { cancellableRemoteOperation?: boolean } = {},
): Promise<T> {
  throwIfRemotePluginSyncStopped(params, row);
  const operationId = createRemotePluginSyncOperationId(row);
  emitRemotePluginSyncProgress(params, row, "syncing", `${log} (${operationId})`);
  const promise = run(operationId);
  const stopPromise = params.stopControl?.waitForStop?.(row.candidate.id);
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = params.signal
    ? new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        const handleAbort = () => resolve();
        params.signal?.addEventListener("abort", handleAbort, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", handleAbort);
      })
    : undefined;
  const interruptionPromises = [stopPromise, abortPromise].filter(
    (candidate): candidate is Promise<void> => Boolean(candidate),
  );
  if (interruptionPromises.length === 0) {
    return await promise;
  }
  try {
    return await Promise.race([
      promise,
      Promise.race(interruptionPromises).then(async () => {
        if (options.cancellableRemoteOperation === true && params.stopControl?.cancelOperation) {
          emitRemotePluginSyncProgress(
            params,
            row,
            "stopped",
            `request cancel plugin sync operation ${operationId}`,
          );
          try {
            await params.stopControl.cancelOperation(operationId);
            emitRemotePluginSyncProgress(
              params,
              row,
              "stopped",
              `cancel request sent for ${operationId}`,
            );
          } catch (error) {
            emitRemotePluginSyncProgress(
              params,
              row,
              "stopped",
              `cancel request failed for ${operationId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        throw new RemotePluginSyncStoppedError(row);
      }),
    ]);
  } finally {
    removeAbortListener?.();
  }
}
