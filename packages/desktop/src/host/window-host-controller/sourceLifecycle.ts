import type { Emitter } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WindowHostTaskAddress } from "@zcode/shared/zcode-protocol-v4";
import type { WindowHostTaskUnreadSignal } from "@zcode/services";
import type {
  WindowHostControllerMutation,
  WindowHostControllerMutationResult,
  WindowHostControllerSourceScope,
} from "../windowHostControllerProjection.js";
import {
  createWindowHostSessionsIndexObserver,
  type WindowHostSessionsIndexObserver,
} from "../windowHostSessionsIndexObserver.js";
import {
  mutationParams,
  normalizeTaskMeta,
  sessionOverlay,
  sourceKey,
  taskKey,
} from "./helpers.js";
import type {
  ResolvedWindowHostControllerSource,
  WindowHostControllerProjection,
  WindowHostControllerRefreshSource,
  WindowHostControllerReplaceDisconnectedSource,
  WindowHostControllerRuntimeOptions,
  WindowHostControllerSourceState,
} from "./types.js";

export interface WindowHostControllerSourceLifecycle {
  refreshSource: WindowHostControllerRefreshSource;
  replaceDisconnectedSource: WindowHostControllerReplaceDisconnectedSource;
}

interface SourceLifecycleContext {
  options: WindowHostControllerRuntimeOptions;
  projection: WindowHostControllerProjection;
  unreadSignals: Emitter<WindowHostTaskUnreadSignal>;
  state: WindowHostControllerSourceState;
}

/**
 * source 聚合与刷新：注册、事件订阅、single-flight 读取、断开与重连替换。
 * 全部函数共享同一个 closure，注册与刷新互为递归，不能拆成两个 owner。
 */
export function createWindowHostControllerSourceLifecycle(
  context: SourceLifecycleContext,
): WindowHostControllerSourceLifecycle {
  const { options, projection, unreadSignals, state } = context;
  const {
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
  } = state;

  function ensureSourceSessionObserver(
    resolved: ResolvedWindowHostControllerSource,
  ): WindowHostSessionsIndexObserver | null {
    const key = sourceKey(resolved.scope);
    if (resolved.sourceAvailability !== "online") {
      return sourceSessionObservers.get(key)?.observer ?? null;
    }
    if (!resolved.agentService) {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      if (sourceLiveOverlays.delete(key)) {
        projection.replaceSourceSessionOverlays(resolved.scope, []);
      }
      return null;
    }
    const current = sourceSessionObservers.get(key);
    if (current?.agentService === resolved.agentService) return current.observer;
    current?.observer.dispose();
    if (sourceLiveOverlays.delete(key)) {
      projection.replaceSourceSessionOverlays(resolved.scope, []);
    }
    let observer!: WindowHostSessionsIndexObserver;
    observer = createWindowHostSessionsIndexObserver({
      agentService: resolved.agentService,
      target: {
        workspacePath: resolved.scope.workspacePath,
        ...(resolved.scope.workspaceIdentity
          ? { workspaceIdentity: resolved.scope.workspaceIdentity }
          : {}),
      },
      onSessionsChange: (sessions) => {
        if (sourceSessionObservers.get(key)?.observer !== observer) return;
        const overlays = sessions.map(sessionOverlay);
        sourceLiveOverlays.set(key, overlays);
        projection.replaceSourceSessionOverlays(resolved.scope, overlays);
      },
      onError: (error) => options.onSourceError?.(resolved.scope, "refresh", error),
    });
    sourceSessionObservers.set(key, { agentService: resolved.agentService, observer });
    return observer;
  }

  async function executeMutation(
    scope: WindowHostControllerSourceScope,
    address: WindowHostTaskAddress,
    mutation: WindowHostControllerMutation,
  ): Promise<WindowHostControllerMutationResult> {
    const current = resolveCurrentSource(scope);
    if (!current?.taskService || current.sourceAvailability !== "online") {
      throw new Error(
        scope.kind === "remote" ? "远程 source 当前离线，禁止列表写操作" : "本地 source 当前不可用",
      );
    }
    const service = current.taskService;
    const base = mutationParams(address);
    switch (mutation.kind) {
      case "rename":
        await service.renameTask({ ...base, title: mutation.title });
        break;
      case "pin":
        await service.setTaskPinned({ ...base, pinned: mutation.pinned });
        break;
      case "archive":
        if (mutation.archived) {
          await service.archiveTask(base);
        } else {
          await service.unarchiveTask(base);
        }
        break;
      case "delete":
        await service.deleteTask(base);
        break;
      case "delete-archived":
        return service.deleteArchivedTask(base);
      case "delete-archived-batch":
        // 确认期间远端 session 可能已替换；不能将旧地址的批次写入同 identity 的新 source。
        if (sourceKey(current.scope) !== sourceKey(scope)) {
          throw new Error("归档删除批次的 source 已替换");
        }
        return service.deleteArchivedTasks({
          workspacePath: base.workspacePath,
          workspaceIdentity: base.workspaceIdentity,
          taskIds: mutation.taskIds,
        });
      case "mark-read":
        return normalizeTaskMeta(
          await service.setTaskUnread({
            ...base,
            unread: false,
            ...(mutation.expectedUnreadAt != null
              ? { expectedUnreadAt: mutation.expectedUnreadAt }
              : {}),
          }),
          current.scope,
        );
      case "mark-unread":
        return normalizeTaskMeta(
          await service.setTaskUnread({ ...base, unread: true }),
          current.scope,
        );
      case "open":
      case "resume":
        // open/resume 的 Controller 职责是验证唯一 source；conversation 随后仍走 scoped facade。
        break;
      default: {
        const exhaustive: never = mutation;
        throw new Error(`未知 Controller mutation: ${String(exhaustive)}`);
      }
    }
  }

  function registerResolvedSource(resolved: ResolvedWindowHostControllerSource): void {
    const key = sourceKey(resolved.scope);
    if (!registeredScopes.has(key)) {
      registeredScopes.set(key, resolved.scope);
      projection.registerSource({
        scope: resolved.scope,
        mutate: (address, mutation) => executeMutation(resolved.scope, address, mutation),
      });
    }
    const previousAvailability = sourceAvailability.get(key);
    sourceAvailability.set(key, resolved.sourceAvailability);
    if (
      resolved.taskService &&
      sourceSnapshotTaskServices.has(key) &&
      sourceSnapshotTaskServices.get(key) !== resolved.taskService
    ) {
      sourceSnapshotTaskServices.delete(key);
    }
    if (
      resolved.taskService &&
      resolved.sourceAvailability === "online" &&
      typeof resolved.taskService.onDynamicWorkspaceEvent === "function" &&
      sourceTaskServices.get(key) !== resolved.taskService
    ) {
      sourceEventSubscriptions.get(key)?.dispose();
      const taskService = resolved.taskService;
      const isCurrentSource = () => {
        const current = resolveCurrentSource(resolved.scope);
        return (
          sourceTaskServices.get(key) === taskService &&
          sourceAvailability.get(key) === "online" &&
          current?.taskService === taskService &&
          current?.sourceAvailability === "online"
        );
      };
      sourceTaskServices.set(key, taskService);
      sourceEventSubscriptions.set(
        key,
        taskService.onDynamicWorkspaceEvent({
          workspacePath: resolved.scope.workspacePath,
          ...(resolved.scope.workspaceIdentity
            ? { workspaceIdentity: resolved.scope.workspaceIdentity }
            : {}),
        })((event) => {
          // Bug 根因：Controller 接管观察后只刷新列表，丢掉了 Host 的明确完成信号。
          // 沿现有 source 监听转发实时事实；旧连接、离线 source 和普通快照都不能制造未读。
          if (!isCurrentSource()) return;
          const signal: WindowHostTaskUnreadSignal | undefined =
            event.type === "workspace_task_list_changed" &&
            event.reason === "task_status_changed" &&
            event.unreadSignal === "background_terminal" &&
            event.taskMeta &&
            (event.taskMeta.status === "completed" || event.taskMeta.status === "error")
              ? {
                  address: {
                    taskId: event.taskId ?? event.taskMeta.taskId,
                    workspacePath: resolved.scope.workspacePath,
                    ...(resolved.scope.workspaceIdentity
                      ? { workspaceIdentity: resolved.scope.workspaceIdentity }
                      : {}),
                    ...(resolved.scope.kind === "remote"
                      ? {
                          ...(resolved.scope.sourceServerId
                            ? { sourceServerId: resolved.scope.sourceServerId }
                            : {}),
                          ...(resolved.scope.remoteSessionId
                            ? { remoteSessionId: resolved.scope.remoteSessionId }
                            : {}),
                        }
                      : {}),
                  },
                  updatedAt: event.taskMeta.updatedAt,
                  status: event.taskMeta.status,
                }
              : undefined;
          // Bug 根因：等列表 IO 后才通知会漏记期间的查看；立即交给窗口记录，行就绪由 mutation 验证。
          if (signal) unreadSignals.fire(signal);
          // workspace event 可能在列表首轮 refresh 读取途中到达；直接复用
          // single-flight 会把事件吞掉。先等在途读取结束，再把多个事件合并成下一轮 refresh。
          const inFlight = sourceRefreshFlights.get(key)?.promise;
          void (async () => {
            await inFlight?.catch(() => {});
            if (!isCurrentSource()) return;
            const current = resolveCurrentSource(resolved.scope);
            if (current) {
              // 完成信号是已收到的事实，读取投影失败不能把它吞掉；写入仍由原 mutation 验证真实行。
              await refreshSource(current, true).catch((error) =>
                options.onSourceError?.(current.scope, "refresh", error),
              );
            }
          })().catch((error) => options.onSourceError?.(resolved.scope, "refresh", error));
        }),
      );
    }
    if (resolved.sourceAvailability === "offline" && previousAvailability === "online") {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(resolved.scope);
    }
  }

  async function readSourceTaskIndex(resolved: ResolvedWindowHostControllerSource) {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("Controller source 当前不可读取");
    }
    const request = {
      workspacePath: resolved.scope.workspacePath,
      ...(resolved.scope.workspaceIdentity
        ? { workspaceIdentity: resolved.scope.workspaceIdentity }
        : {}),
    };
    const [active, pinned, archived] = await Promise.all([
      resolved.taskService.listTasks(request),
      resolved.taskService.listPinnedTasks(request),
      resolved.taskService.listArchivedTasks(request),
    ]);
    const membershipByTaskKey = new Map<
      string,
      {
        meta: ZCodeTaskMeta;
        membership: { pinned: boolean; archived: boolean; active: boolean };
      }
    >();
    for (const task of active) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: false, active: true },
      });
    }
    for (const task of pinned) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: true, archived: false, active: true },
      });
    }
    for (const task of archived) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: true, active: false },
      });
    }
    return Array.from(membershipByTaskKey.values());
  }

  async function refreshSource(
    resolved: ResolvedWindowHostControllerSource,
    force = false,
    beforeCommit?: () => void,
  ): Promise<void> {
    registerResolvedSource(resolved);
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      return;
    }
    const key = sourceKey(resolved.scope);
    await ensureSourceSessionObserver(resolved)?.start();
    if (!force && sourceSnapshotTaskServices.get(key) === resolved.taskService) return;
    const existing = sourceRefreshFlights.get(key);
    if (existing?.taskService === resolved.taskService) return existing.promise;
    const generation = (sourceRefreshGenerations.get(key) ?? 0) + 1;
    sourceRefreshGenerations.set(key, generation);
    const promise = (async () => {
      const taskIndex = await readSourceTaskIndex(resolved);
      if (sourceRefreshGenerations.get(key) !== generation) {
        throw new Error("Controller source refresh generation 已失效");
      }
      beforeCommit?.();
      const previousScope = pendingReplacementByNextSourceKey.get(key);
      projection.replaceSourceSnapshot({
        scope: resolved.scope,
        ...(previousScope ? { replacesScope: previousScope } : {}),
        taskIndex,
        // live facts 仅驻 Host 内存；observer 使用 existing-only，列表读取不会启动 Agent。
        sessionsIndex: sourceLiveOverlays.get(key) ?? [],
      });
      if (previousScope) {
        forgetRegisteredSource(previousScope);
        pendingReplacementByNextSourceKey.delete(key);
      }
      sourceAvailability.set(key, "online");
      sourceSnapshotTaskServices.set(key, resolved.taskService!);
    })();
    sourceRefreshFlights.set(key, { taskService: resolved.taskService, promise });
    try {
      await promise;
    } finally {
      if (sourceRefreshFlights.get(key)?.promise === promise) {
        sourceRefreshFlights.delete(key);
      }
    }
  }

  async function replaceDisconnectedSource(
    previousScope: WindowHostControllerSourceScope,
    resolved: ResolvedWindowHostControllerSource,
    transaction?: {
      canCommit?: () => boolean;
      rollbackOnFailure?: boolean;
    },
  ): Promise<void> {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("重连 source 尚未 online，不能替换离线投影");
    }
    registerResolvedSource(resolved);
    const previousKey = sourceKey(previousScope);
    const retainedPreviousScope =
      pendingReplacementByNextSourceKey.get(previousKey) ?? previousScope;
    if (sourceKey(retainedPreviousScope) !== previousKey) {
      // 连续重连都在首个 snapshot 前失败时，可信 rows 仍属于更早的一代 source。
      // 摘掉中间空 source，把 replacement 链压缩到最后可信 scope，避免成功后遗留孤儿投影。
      pendingReplacementByNextSourceKey.delete(previousKey);
      forgetRegisteredSource(previousScope);
      projection.removeSource(previousScope);
    }
    pendingReplacementByNextSourceKey.set(sourceKey(resolved.scope), retainedPreviousScope);
    try {
      await refreshSource(resolved, true, () => {
        if (transaction?.canCommit?.() === false) {
          throw new Error("Controller source replacement generation 已失效");
        }
      });
    } catch (error) {
      if (transaction?.rollbackOnFailure) {
        const key = sourceKey(resolved.scope);
        if (pendingReplacementByNextSourceKey.has(key)) {
          // Bug 原因：Registry 已回滚 provisional logical session 时，Controller 曾继续保留
          // 新 generation 的 pending source/订阅，下一轮又从旧 session 重试，最终泄漏孤儿 owner。
          pendingReplacementByNextSourceKey.delete(key);
          forgetRegisteredSource(resolved.scope);
          projection.discardSource(resolved.scope);
        }
      }
      throw error;
    }
  }

  return { refreshSource, replaceDisconnectedSource };
}
