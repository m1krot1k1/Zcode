import { Emitter } from "@zcode/rpc";
import type { WindowHostTaskUnreadSignal } from "@zcode/services";
import {
  createWindowHostControllerProjection,
  type WindowHostControllerSourceScope,
} from "../windowHostControllerProjection.js";
import { createWindowHostControllerAttachmentFactory } from "./attachment.js";
import { sourceKey } from "./helpers.js";
import { createWindowHostControllerSourceLifecycle } from "./sourceLifecycle.js";
import { createWindowHostControllerSourceState } from "./sourceState.js";
import { createWindowHostControllerTaskAddressResolver } from "./taskAddress.js";
import { createWindowHostControllerTaskList } from "./taskList.js";
import type {
  WindowHostControllerRuntimeContext,
  WindowHostControllerRuntimeOptions,
} from "./types.js";

/**
 * WindowHostControllerRuntime 是 Local Host 内的聚合权威。它不持久化数据；每次在线查询都从
 * 对应 source 的 tasks-index 重建投影，断连时只冻结最后一次成功的内存快照。
 */
export function createWindowHostControllerRuntime(options: WindowHostControllerRuntimeOptions) {
  const projection = createWindowHostControllerProjection({ createId: options.createId });
  const unreadSignals = new Emitter<WindowHostTaskUnreadSignal>();
  const state = createWindowHostControllerSourceState(options);
  const { refreshSource, replaceDisconnectedSource } = createWindowHostControllerSourceLifecycle({
    options,
    projection,
    unreadSignals,
    state,
  });
  const context: WindowHostControllerRuntimeContext = {
    options,
    projection,
    unreadSignals,
    state,
    refreshSource,
    replaceDisconnectedSource,
  };
  const listTaskList = createWindowHostControllerTaskList(context);
  const createAttachmentService = createWindowHostControllerAttachmentFactory(
    context,
    listTaskList,
  );

  const service = createAttachmentService();

  return {
    service,
    createAttachmentService,
    replaceDisconnectedSource,
    resolveTaskAddress: createWindowHostControllerTaskAddressResolver(context),
    disconnectSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!state.registeredScopes.has(key) || state.sourceAvailability.get(key) === "offline") {
        return;
      }
      state.sourceAvailability.set(key, "offline");
      state.sourceRefreshGenerations.set(key, (state.sourceRefreshGenerations.get(key) ?? 0) + 1);
      state.sourceRefreshFlights.delete(key);
      state.sourceSessionObservers.get(key)?.observer.dispose();
      state.sourceSessionObservers.delete(key);
      state.sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(scope);
    },
    removeSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!state.registeredScopes.has(key)) {
        return;
      }
      const retainedPreviousScope = state.pendingReplacementByNextSourceKey.get(key);
      state.forgetRegisteredSource(scope);
      state.pendingReplacementByNextSourceKey.delete(key);
      for (const [nextKey, previousScope] of state.pendingReplacementByNextSourceKey) {
        if (sourceKey(previousScope) === key) {
          state.pendingReplacementByNextSourceKey.delete(nextKey);
        }
      }
      projection.removeSource(scope);
      if (retainedPreviousScope && sourceKey(retainedPreviousScope) !== key) {
        // 当前 logical session 在成功 resync 前仍借用上一代离线 rows；关闭当前 scope
        // 等同关闭这份 history scope，必须连同保留投影一起清理。
        state.forgetRegisteredSource(retainedPreviousScope);
        projection.removeSource(retainedPreviousScope);
      }
    },
    dispose(): void {
      service.dispose();
      unreadSignals.dispose();
      for (const scope of state.registeredScopes.values()) {
        projection.removeSource(scope);
      }
      for (const subscription of state.sourceEventSubscriptions.values()) {
        subscription.dispose();
      }
      state.registeredScopes.clear();
      state.sourceAvailability.clear();
      state.sourceTaskServices.clear();
      state.sourceSnapshotTaskServices.clear();
      state.sourceEventSubscriptions.clear();
      state.sourceRefreshFlights.clear();
      state.sourceRefreshGenerations.clear();
      for (const entry of state.sourceSessionObservers.values()) entry.observer.dispose();
      state.sourceSessionObservers.clear();
      state.sourceLiveOverlays.clear();
      state.pendingReplacementByNextSourceKey.clear();
    },
  };
}
