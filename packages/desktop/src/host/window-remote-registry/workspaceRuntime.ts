import { shouldKeepConnectionAlive } from "./ownership.js";
import {
  WindowRemoteConnectCancelledError,
  type ConnectionEntry,
  type LogicalSession,
  type RegistryContext,
  type WorkspaceRuntimeState,
} from "./types.js";

export function sessionOwnsWorkspace<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  session: LogicalSession<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  workspaceKey: string,
): boolean {
  return (
    !session.cancelled &&
    session.entry === entry &&
    session.workspaceKey === workspaceKey &&
    ctx.sessionsById.get(session.remoteSessionId) === session
  );
}

export function hasOtherWorkspaceOwner<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  workspaceKey: string,
  excludedRemoteSessionId: string,
): boolean {
  return Array.from(ctx.sessionsById.values()).some(
    (candidate) =>
      candidate.remoteSessionId !== excludedRemoteSessionId &&
      sessionOwnsWorkspace(ctx, candidate, entry, workspaceKey),
  );
}

export function startWorkspaceRelease<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  entry: ConnectionEntry<TServices, TCapabilities>,
  workspaceKey: string,
  state: WorkspaceRuntimeState,
  generation: number,
): Promise<void> | undefined {
  if (
    entry.target.kind !== "wsl" ||
    state.generation !== generation ||
    state.releaseInFlight ||
    !entry.handle ||
    entry.state !== "online" ||
    !ctx.options.releaseWorkspace
  ) {
    return state.releaseInFlight;
  }
  state.pendingReleaseGeneration = undefined;
  const release = ctx.options
    .releaseWorkspace(entry.handle.services, state.context)
    .catch((error) => {
      ctx.options.onWorkspaceReleaseError?.(state.context, error);
      throw error;
    })
    .finally(() => {
      if (state.releaseInFlight === release) {
        state.releaseInFlight = undefined;
      }
      if (
        state.generation === generation &&
        !state.pendingReleaseGeneration &&
        !Array.from(ctx.sessionsById.values()).some((candidate) =>
          sessionOwnsWorkspace(ctx, candidate, entry, workspaceKey),
        )
      ) {
        entry.workspaceRuntimeByKey.delete(workspaceKey);
      }
    });
  // release 由 dispose/running-task 事件触发；失败由结构化回调记录，同时保留 rejecting
  // Promise 给同 workspace 的下一代 acquire，使其 fail-closed 而不是踩过未完成清理。
  void release.catch(() => undefined);
  state.releaseInFlight = release;
  return release;
}

export function requestWorkspaceRelease<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  params: {
    entry: ConnectionEntry<TServices, TCapabilities>;
    remoteSessionId: string;
    workspaceKey?: string;
    workspaceGeneration?: number;
  },
): Promise<void> | undefined {
  const { entry, workspaceKey, workspaceGeneration } = params;
  if (
    entry.target.kind !== "wsl" ||
    shouldKeepConnectionAlive(ctx, entry) ||
    !workspaceKey ||
    !workspaceGeneration
  ) {
    return undefined;
  }
  if (hasOtherWorkspaceOwner(ctx, entry, workspaceKey, params.remoteSessionId)) {
    return undefined;
  }
  const state = entry.workspaceRuntimeByKey.get(workspaceKey);
  if (!state || state.generation !== workspaceGeneration) {
    return undefined;
  }
  if ((entry.runningTaskCountByWorkspaceKey.get(workspaceKey) ?? 0) > 0) {
    state.pendingReleaseGeneration = workspaceGeneration;
    return undefined;
  }
  return startWorkspaceRelease(ctx, entry, workspaceKey, state, workspaceGeneration);
}

export function abortError(): Error {
  return Object.assign(new Error("Remote workspace bind was aborted"), {
    name: "AbortError",
  });
}

export async function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation;
  if (signal.aborted) throw abortError();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function prepareWorkspaceRuntime<TServices, TCapabilities>(
  ctx: RegistryContext<TServices, TCapabilities>,
  session: LogicalSession<TServices, TCapabilities>,
  signal?: AbortSignal,
): Promise<void> {
  const expectedSessionGeneration = session.generation;
  const identityPreparation =
    session.entry.handle &&
    session.sourceServerId &&
    session.workspacePath &&
    session.workspaceIdentity &&
    ctx.options.prepareWorkspaceIdentity
      ? ctx.options.prepareWorkspaceIdentity(session.entry.handle, {
          sourceServerId: session.sourceServerId,
          workspacePath: session.workspacePath,
          stableWorkspaceIdentity: session.workspaceIdentity,
          ...(session.legacyWorkspaceIdentity
            ? { legacyRouteHint: session.legacyWorkspaceIdentity }
            : {}),
          ...(signal ? { signal } : {}),
        })
      : null;
  const identityReady = waitWithAbort(identityPreparation ?? Promise.resolve(), signal);
  if (session.entry.target.kind !== "wsl" || !session.workspacePath || !session.workspaceKey) {
    if (!identityPreparation) {
      session.workspaceReadyState = "ready";
      session.workspaceReady = Promise.resolve();
      return session.workspaceReady;
    }
    session.workspaceReadyState = "pending";
    session.workspaceReady = identityReady.then(
      () => {
        if (session.generation !== expectedSessionGeneration) throw abortError();
        session.workspaceReadyState = "ready";
      },
      (error) => {
        if (session.generation === expectedSessionGeneration) {
          session.workspaceReadyState = "failed";
        }
        throw error;
      },
    );
    return session.workspaceReady;
  }
  const workspaceKey = session.workspaceKey;
  const entry = session.entry;
  const existing = entry.workspaceRuntimeByKey.get(workspaceKey);
  const hasOtherOwner = hasOtherWorkspaceOwner(ctx, entry, workspaceKey, session.remoteSessionId);
  const state =
    existing ??
    ({
      context: {
        workspacePath: session.workspacePath,
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
      },
      generation: 0,
    } satisfies WorkspaceRuntimeState);
  entry.workspaceRuntimeByKey.set(workspaceKey, state);
  state.context = {
    workspacePath: session.workspacePath,
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
  };
  if (!hasOtherOwner) {
    state.generation += 1;
    // 上一代 release 仍因 running task 等待时，新 logical owner 已重新持有
    // workspace；尚未开始的旧 release 必须失效，不能在 task 归零后误清新 runtime。
  }
  state.pendingReleaseGeneration = undefined;
  session.workspaceGeneration = state.generation;
  session.workspaceReadyState = "pending";
  const releaseToWait = state.releaseInFlight;
  const ready = Promise.all([identityReady, releaseToWait ?? Promise.resolve()])
    .then(() => {
      if (
        ctx.sessionsById.get(session.remoteSessionId) !== session ||
        session.cancelled ||
        entry.workspaceRuntimeByKey.get(workspaceKey)?.generation !== session.workspaceGeneration
      ) {
        throw new WindowRemoteConnectCancelledError();
      }
      session.workspaceReadyState = "ready";
    })
    .catch((error) => {
      session.workspaceReadyState = "failed";
      throw error;
    });
  session.workspaceReady = ready;
  return ready;
}
