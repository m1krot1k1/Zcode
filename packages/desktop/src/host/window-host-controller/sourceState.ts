import type { IZCodeTaskService } from "@zcode/services";
import type {
  WindowHostControllerSessionOverlay,
  WindowHostControllerSourceScope,
} from "../windowHostControllerProjection.js";
import { sourceKey } from "./helpers.js";
import type {
  ResolvedWindowHostControllerSource,
  WindowHostControllerRefreshFlight,
  WindowHostControllerRuntimeOptions,
  WindowHostControllerSessionObserverEntry,
  WindowHostControllerSourceState,
} from "./types.js";

/**
 * 创建 Controller 的 source 可变注册表。所有写入路径共享同一份 map，
 * 避免在多个模块间复制状态或产生第二条清理路径。
 */
export function createWindowHostControllerSourceState(
  options: WindowHostControllerRuntimeOptions,
): WindowHostControllerSourceState {
  const registeredScopes = new Map<string, WindowHostControllerSourceScope>();
  const sourceAvailability = new Map<string, "online" | "offline">();
  const sourceTaskServices = new Map<string, IZCodeTaskService>();
  const sourceSnapshotTaskServices = new Map<string, IZCodeTaskService>();
  const sourceEventSubscriptions = new Map<string, { dispose(): void }>();
  const sourceRefreshFlights = new Map<string, WindowHostControllerRefreshFlight>();
  const sourceRefreshGenerations = new Map<string, number>();
  const sourceLiveOverlays = new Map<string, WindowHostControllerSessionOverlay[]>();
  const sourceSessionObservers = new Map<string, WindowHostControllerSessionObserverEntry>();
  const pendingReplacementByNextSourceKey = new Map<string, WindowHostControllerSourceScope>();

  function forgetRegisteredSource(scope: WindowHostControllerSourceScope): void {
    const key = sourceKey(scope);
    registeredScopes.delete(key);
    sourceAvailability.delete(key);
    sourceTaskServices.delete(key);
    sourceSnapshotTaskServices.delete(key);
    sourceEventSubscriptions.get(key)?.dispose();
    sourceEventSubscriptions.delete(key);
    sourceSessionObservers.get(key)?.observer.dispose();
    sourceSessionObservers.delete(key);
    sourceLiveOverlays.delete(key);
    sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
    sourceRefreshFlights.delete(key);
  }

  function resolveCurrentSource(
    scope: WindowHostControllerSourceScope,
  ): ResolvedWindowHostControllerSource | null {
    return options.resolveSource({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    });
  }

  return {
    registeredScopes,
    sourceAvailability,
    sourceTaskServices,
    sourceSnapshotTaskServices,
    sourceEventSubscriptions,
    sourceRefreshFlights,
    sourceRefreshGenerations,
    sourceLiveOverlays,
    sourceSessionObservers,
    pendingReplacementByNextSourceKey,
    forgetRegisteredSource,
    resolveCurrentSource,
  };
}
