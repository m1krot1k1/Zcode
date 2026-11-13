import type { Emitter } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  IZCodeTaskService,
  WindowHostControllerTaskListResult,
  WindowHostTaskUnreadSignal,
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { createWindowHostControllerProjection } from "../windowHostControllerProjection.js";
import type {
  WindowHostControllerSessionOverlay,
  WindowHostControllerSourceScope,
} from "../windowHostControllerProjection.js";
import type { WindowHostSessionsIndexObserver } from "../windowHostSessionsIndexObserver.js";

export type WindowHostControllerProjection = ReturnType<
  typeof createWindowHostControllerProjection
>;

export interface ResolvedWindowHostControllerSource {
  scope: WindowHostControllerSourceScope;
  taskService?: IZCodeTaskService;
  agentService?: IZCodeAgentService;
  sourceAvailability: "online" | "offline";
}

export interface WindowHostControllerRuntimeOptions {
  createId: () => string;
  resolveSource: (scope: ZCodeTaskListWorkspaceScope) => ResolvedWindowHostControllerSource | null;
  onSourceError?: (
    scope: WindowHostControllerSourceScope,
    operation: "refresh" | "search",
    error: unknown,
  ) => void;
}

export interface WindowHostControllerRefreshFlight {
  taskService: IZCodeTaskService;
  promise: Promise<void>;
}

export interface WindowHostControllerSessionObserverEntry {
  agentService: IZCodeAgentService;
  observer: WindowHostSessionsIndexObserver;
}

/**
 * Local Host 内所有 source 的可变注册表。Controller 不持久化数据；这里的 map 只是
 * 内存索引与在途 flight 记账，投影本身由 projection 持有。
 */
export interface WindowHostControllerSourceState {
  registeredScopes: Map<string, WindowHostControllerSourceScope>;
  sourceAvailability: Map<string, "online" | "offline">;
  sourceTaskServices: Map<string, IZCodeTaskService>;
  sourceSnapshotTaskServices: Map<string, IZCodeTaskService>;
  sourceEventSubscriptions: Map<string, { dispose(): void }>;
  sourceRefreshFlights: Map<string, WindowHostControllerRefreshFlight>;
  sourceRefreshGenerations: Map<string, number>;
  sourceLiveOverlays: Map<string, WindowHostControllerSessionOverlay[]>;
  sourceSessionObservers: Map<string, WindowHostControllerSessionObserverEntry>;
  pendingReplacementByNextSourceKey: Map<string, WindowHostControllerSourceScope>;
  forgetRegisteredSource(scope: WindowHostControllerSourceScope): void;
  resolveCurrentSource(
    scope: WindowHostControllerSourceScope,
  ): ResolvedWindowHostControllerSource | null;
}

export type WindowHostControllerRefreshSource = (
  resolved: ResolvedWindowHostControllerSource,
  force?: boolean,
  beforeCommit?: () => void,
) => Promise<void>;

export type WindowHostControllerReplaceDisconnectedSource = (
  previousScope: WindowHostControllerSourceScope,
  resolved: ResolvedWindowHostControllerSource,
  transaction?: {
    canCommit?: () => boolean;
    rollbackOnFailure?: boolean;
  },
) => Promise<void>;

export type WindowHostControllerListTaskList = (
  query: ZCodeTaskListQuery,
) => Promise<WindowHostControllerTaskListResult>;

export interface WindowHostControllerRuntimeContext {
  options: WindowHostControllerRuntimeOptions;
  projection: WindowHostControllerProjection;
  unreadSignals: Emitter<WindowHostTaskUnreadSignal>;
  state: WindowHostControllerSourceState;
  refreshSource: WindowHostControllerRefreshSource;
  replaceDisconnectedSource: WindowHostControllerReplaceDisconnectedSource;
}
