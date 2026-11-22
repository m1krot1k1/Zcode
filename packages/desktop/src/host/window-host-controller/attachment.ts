import { Emitter, Event } from "@zcode/rpc";
import { windowHostTaskAddressSchema } from "@zcode/shared/zcode-protocol-v4";
import type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostTaskUnreadSignal,
} from "@zcode/services";
import type { WindowHostControllerMutation } from "../windowHostControllerProjection.js";
import { mutationParams, normalizeTaskMeta, sourceKey } from "./helpers.js";
import type {
  ResolvedWindowHostControllerSource,
  WindowHostControllerListTaskList,
  WindowHostControllerRuntimeContext,
} from "./types.js";

/**
 * attachment 服务是 Host 对单个窗口暴露的 Controller facade：读列表、按地址重查、
 * 执行列表 mutation，并把投影帧/未读信号转成 attachment 级 emitter。
 */
export function createWindowHostControllerAttachmentFactory(
  context: WindowHostControllerRuntimeContext,
  listTaskList: WindowHostControllerListTaskList,
): (ownsUnreadSignals?: boolean) => IWindowControllerService & { dispose(): void } {
  const { options, projection, unreadSignals, refreshSource, state } = context;
  const { sourceAvailability } = state;

  return function createAttachmentService(
    ownsUnreadSignals = true,
  ): IWindowControllerService & { dispose(): void } {
    const frameEmitter = new Emitter<WindowHostControllerFrame>();
    const unreadEmitter = new Emitter<WindowHostTaskUnreadSignal>();
    const unreadSubscription = ownsUnreadSignals
      ? unreadSignals.event((signal) => unreadEmitter.fire(signal))
      : undefined;
    const subscriptions = new Map<string, { dispose(): void }>();
    let attachmentDisposed = false;
    return {
      listTaskList,
      async getTaskMeta(params) {
        const address = windowHostTaskAddressSchema.parse(params.address);
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        const taskService = resolved?.taskService;
        const assertCurrentSource = (current: ResolvedWindowHostControllerSource | null) => {
          if (
            attachmentDisposed ||
            !resolved ||
            !taskService ||
            !current ||
            current.sourceAvailability !== "online" ||
            current.taskService !== taskService ||
            current.scope.workspacePath !== address.workspacePath ||
            current.scope.workspaceIdentity !== address.workspaceIdentity ||
            sourceKey(current.scope) !== sourceKey(resolved.scope) ||
            (current.scope.kind === "remote" &&
              resolved.scope.kind === "remote" &&
              current.scope.remoteSessionId !== resolved.scope.remoteSessionId)
          )
            throw new Error("任务读取期间 source 已失效");
          const mismatched =
            current.scope.kind === "remote"
              ? (address.sourceServerId
                  ? address.sourceServerId !== current.scope.sourceServerId
                  : address.remoteSessionId !== current.scope.remoteSessionId) ||
                (address.remoteSessionId != null &&
                  address.remoteSessionId !== current.scope.remoteSessionId)
              : address.remoteSessionId != null || address.sourceServerId != null;
          if (mismatched) throw new Error("任务地址与 source 不匹配");
        };
        assertCurrentSource(resolved);
        // Bug 根因：列表读取失败可保留旧投影；把它当已读 marker 会漏清或误清。
        // 直接读唯一持久 owner，IO 前后复查同一服务与 attachment，不吞错、不物化整表。
        const result = await taskService!.getTaskMeta(mutationParams(address));
        assertCurrentSource(state.resolveCurrentSource(resolved!.scope));
        if (result && result.taskId !== address.taskId) throw new Error("任务读取返回地址不匹配");
        return result ? normalizeTaskMeta(result, resolved!.scope) : null;
      },
      async deleteArchivedTasks({ address, taskIds }) {
        if (taskIds.length === 0) {
          return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
        }
        const result = await projection.mutate(address, { kind: "delete-archived-batch", taskIds });
        if (!result || typeof result === "boolean" || !("deletedTaskIds" in result)) {
          throw new Error("归档删除批次未返回逐项目标结果");
        }
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // 只在整批结束后收敛投影，与 source 的一次事件共享 single-flight；刷新失败不改写已提交结果。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return result;
      },
      async deleteArchivedTask({ address }) {
        const deleted = await projection.mutate(address, { kind: "delete-archived" });
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // 删除已经持久成功，列表重查失败不能改报删除失败；后续事件仍会刷新投影。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return deleted === true;
      },
      async mutateTask({ address, mutation }) {
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        // 项目树也包含未打开 tab 的任务；先从唯一 owner 读取行验证，不能依赖 UI 先查另一份列表。
        if (!resolved || resolved.sourceAvailability !== "online")
          throw new Error(
            resolved?.scope.kind === "remote"
              ? "远程 source 当前离线，禁止列表写操作"
              : "任务 source 当前不可用",
          );
        const taskService = resolved.taskService;
        const assertCurrentUnreadSource = () => {
          const current = state.resolveCurrentSource(resolved.scope);
          if (
            current?.taskService !== taskService ||
            current?.sourceAvailability !== "online" ||
            sourceAvailability.get(sourceKey(resolved.scope)) !== "online"
          ) {
            throw new Error("未读写入期间 source 已失效");
          }
        };
        await refreshSource(resolved);
        // 首次读取也会等待 IO；后置检查只能拒绝回包，挡不住 mutation 重解析后误写新 source。
        if (mutation.kind === "mark-read" || mutation.kind === "mark-unread") {
          // 缓存命中不代表在途读取已结束；先等旧快照收口，缺行时再读，避免新任务被旧快照拒绝。
          // 旧读取失败不否定已知任务的完成事实，真正缺行的刷新仍须成功后才能写入。
          await state.sourceRefreshFlights.get(sourceKey(resolved.scope))?.promise.catch(() => {});
          assertCurrentUnreadSource();
          const known = projection
            .getTasks()
            .some(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                (address.sourceServerId
                  ? row.address.sourceServerId === address.sourceServerId
                  : row.address.remoteSessionId === address.remoteSessionId),
            );
          if (!known) {
            await refreshSource(resolved, true);
            assertCurrentUnreadSource();
          }
        }
        const mutationResult = await projection.mutate(
          address,
          mutation as WindowHostControllerMutation,
        );
        // 未读 CAS 必须使用本次写入分配的 marker；重查投影可能已包含后一次完成，不能替换回包。
        if (mutationResult && typeof mutationResult !== "boolean" && "taskId" in mutationResult) {
          assertCurrentUnreadSource();
          // 写入已提交；读取失败只影响投影刷新，不把成功的写操作伪装成可重试失败。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
          assertCurrentUnreadSource();
          return mutationResult;
        }
        await refreshSource(resolved, true);
        return (
          projection
            .getTasks()
            .find(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                (address.sourceServerId
                  ? row.address.sourceServerId === address.sourceServerId
                  : row.address.remoteSessionId === address.remoteSessionId),
            )?.meta ?? null
        );
      },
      async subscribeControllerV4(params) {
        const subscription = projection.subscribe({
          topic: params.topic,
          onFrame: (frame) => frameEmitter.fire(frame),
        });
        subscriptions.set(subscription.subscriptionId, subscription);
        return { ack: subscription.ack };
      },
      async resyncControllerV4(params) {
        return { ack: projection.resync(params.subscriptionId) };
      },
      async unsubscribeControllerV4(params) {
        subscriptions.get(params.subscriptionId)?.dispose();
        subscriptions.delete(params.subscriptionId);
      },
      onDynamicControllerFrame() {
        return frameEmitter.event;
      },
      onDynamicTaskUnreadSignal() {
        return ownsUnreadSignals ? unreadEmitter.event : Event.None;
      },
      dispose() {
        attachmentDisposed = true;
        unreadSubscription?.dispose();
        unreadEmitter.dispose();
        for (const subscription of subscriptions.values()) {
          subscription.dispose();
        }
        subscriptions.clear();
        frameEmitter.dispose();
      },
    };
  };
}
