import {
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  sourceServerRunningTasksSchema,
  type SourceServerRunningTask,
} from "@zcode/shared";
import type { TransportContext } from "@zcode/server/source-server";
import { getAdapter } from "./adapters.js";
import { preserveCompatibilityState } from "./compatibility.js";
import { connectForSource } from "./connect.js";
import {
  invalidateOnlineConnectionForUpdate,
  scheduleOnlineRetry,
  stopAutomaticRecoveryForTerminalFailure,
} from "./recovery.js";
import { clearRecoveryTimers, getStateByProfile, setState } from "./state.js";
import type {
  ManagedSourceServerConnection,
  ManagerContext,
  UpdateServerOptions,
} from "./types.js";

export async function updateServer(
  ctx: ManagerContext,
  options: UpdateServerOptions,
): Promise<ManagedSourceServerConnection> {
  return ctx.operationLogs.run(
    "update",
    options.profile,
    options.target,
    options.context,
    (context) => updateServerOnce(ctx, { ...options, context }),
  );
}

async function updateServerOnce(
  ctx: ManagerContext,
  options: UpdateServerOptions,
): Promise<ManagedSourceServerConnection> {
  const sourceServerId = options.profile.sourceServerId;
  const previousState = getStateByProfile(ctx, options.profile.profileId);
  const previousCompatibility = preserveCompatibilityState(previousState);
  const controller = new AbortController();
  const flight = { profileId: options.profile.profileId, sourceServerId, controller };
  const context: TransportContext = {
    ...options.context,
    signal: options.context?.signal
      ? AbortSignal.any([options.context.signal, controller.signal])
      : controller.signal,
  };
  // Bug 原因：更新不在 connectFlights 中，断开后安装的迟到结果仍能重新发布连接。
  // 按操作身份登记，尚未握手的 Profile 也可取消；取消时先摘 owner，旧更新不再压住新连接的恢复。
  ctx.updateFlights.add(flight);
  if (sourceServerId) {
    clearRecoveryTimers(ctx, sourceServerId);
  }
  setState(ctx, options.profile.profileId, {
    state: "updating",
    ...(sourceServerId ? { sourceServerId } : {}),
    ...previousCompatibility,
  });
  let runningTasks: SourceServerRunningTask[] | undefined;
  try {
    context.signal?.throwIfAborted();
    const adapter = getAdapter(ctx, options.profile.transport);
    // Bug 原因：已握手分支曾改走远端 `zcode update`，但正常安装链没有配置远端 release
    // manifest URL，生产更新必然失败。所有 Profile 都由 Desktop 解析同一 archive 并经 Adapter 应用。
    const probe = await adapter.probe(options.target, context);
    context.signal?.throwIfAborted();
    const releaseResolver = options.resolveRelease ?? ctx.options.resolveRelease;
    const release =
      options.release ?? (releaseResolver ? await releaseResolver(probe, options.target) : null);
    context.signal?.throwIfAborted();
    if (!release) throw new Error("Source Server update release is unavailable");
    await adapter.installOrUpdate(options.target, release, context, {
      force: options.force === true,
    });
    context.signal?.throwIfAborted();
    const online = sourceServerId ? ctx.onlineBySourceServerId.get(sourceServerId) : undefined;
    if (sourceServerId && online) {
      invalidateOnlineConnectionForUpdate(ctx, sourceServerId, online);
    }
    // 失效事件的同步订阅者也可能提交断开，不能在该终态后进入 bootstrapping。
    context.signal?.throwIfAborted();
    // 重连事件由 connectOnce 的发布点统一 fire，这里不再重复发布。
    return await connectForSource(
      ctx,
      {
        profile: options.profile,
        target: options.target,
        context,
      },
      sourceServerId,
      false,
    );
  } catch (error) {
    // 终态由断开/删除/释放操作发布；旧更新的成功或失败都不能写回捕获的旧状态。
    controller.signal.throwIfAborted();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "source-server-update-running-tasks"
    ) {
      // 清单走只读控制命令，不扩展持久化 status 格式，旧远端不支持时保持未知。
      try {
        const result = await getAdapter(ctx, options.profile.transport).exec(
          options.target,
          ["running-tasks", "--json"],
          context,
        );
        if (result.exitCode === 0) {
          const parsed = sourceServerRunningTasksSchema.safeParse(JSON.parse(result.stdout.trim()));
          if (parsed.success) runningTasks = parsed.data;
        }
      } catch {
        /* 清单不可用不能绕过 force=false 的运行任务守卫。 */
      }
    }
    // running-tasks 读取同样会让出执行权，断开可能发生在错误收尾期间。
    controller.signal.throwIfAborted();
    const normalized = normalizeRemoteConnectionError(error);
    const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
    const retryable =
      error && typeof error === "object" && "retryable" in error
        ? (error as { retryable?: unknown }).retryable
        : undefined;
    if (sourceServerId && !ctx.onlineBySourceServerId.has(sourceServerId)) {
      // 更新期间 transport 已断开时不能恢复捕获的 online 快照，否则会产生无连接、无 timer 的假在线。
      if (ctx.reconnectInputs.has(sourceServerId)) {
        if (!stopAutomaticRecoveryForTerminalFailure(ctx, sourceServerId, error)) {
          scheduleOnlineRetry(ctx, sourceServerId, 0);
        }
      } else {
        setState(ctx, options.profile.profileId, {
          state: "offline",
          sourceServerId,
          ...previousCompatibility,
          ...(runningTasks ? { runningTasks } : {}),
          ...(errorCode ? { errorCode } : {}),
          retryable: typeof retryable === "boolean" ? retryable : true,
          error: normalized.message,
        });
      }
    } else {
      setState(ctx, options.profile.profileId, {
        // 更新失败不是新的兼容性事实；真实连接仍在时恢复操作前状态。
        state: previousState.state === "absent" ? "failed" : previousState.state,
        ...(sourceServerId ? { sourceServerId } : {}),
        ...previousCompatibility,
        ...(runningTasks ? { runningTasks } : {}),
        ...(errorCode ? { errorCode } : {}),
        retryable: typeof retryable === "boolean" ? retryable : true,
        error: normalized.message,
      });
    }
    throw error;
  } finally {
    ctx.updateFlights.delete(flight);
  }
}
