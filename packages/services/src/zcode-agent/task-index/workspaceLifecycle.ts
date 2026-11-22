/**
 * task-index/workspaceLifecycle.ts: Создание workspace ingest state, frame listeners,
 * runtime lifecycle (attach/suspend/resubscribe) и dormant-поведение.
 */
import { resolveWorkspaceKey } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type {
  TaskIndexRuntime,
  WorkspaceIngestState,
  WorkspaceLifecycleHelpers,
} from "./contracts.js";
import { createWorkspaceIngestState } from "./state.js";
import type { ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";

export function createWorkspaceLifecycleHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    | "agentService"
    | "workspaceIngests"
    | "availableRuntimeGenerationByWorkspaceKey"
    | "hasRuntimeLifecycle"
    | "runtimeState"
    | "isLiveState"
    | "handleSessionsIndexWire"
    | "handleWorkspaceConfigWire"
    | "subscribeIndexTopic"
    | "subscribeConfigTopic"
    | "discardIndexRecovery"
    | "discardConfigRecovery"
    | "clearPendingState"
  >,
): WorkspaceLifecycleHelpers {
  const {
    agentService,
    workspaceIngests,
    availableRuntimeGenerationByWorkspaceKey,
    hasRuntimeLifecycle,
    runtimeState,
    isLiveState,
  } = ctx;

  function ensureWorkspaceFrameListeners(state: WorkspaceIngestState): void {
    if (!isLiveState(state) || state.frameListenersInstalled) return;
    const workspace = state.target;
    // dormant state 跳过首次 establish，runtime available 后却直接走
    // resubscribe；默认 listener 已存在的话，同一 read 内紧随 response 的 initial
    // frame 无人消费。listener 必须在任一 subscribe 前同步安装，且跨 runtime 换代复用。
    state.disposables.push(
      agentService.onDynamicSessionsIndexFrame(workspace)((frame) =>
        ctx.handleSessionsIndexWire(state, frame),
      ),
      agentService.onDynamicWorkspaceConfigFrame(workspace)((frame) =>
        ctx.handleWorkspaceConfigWire(state, frame),
      ),
    );
    state.frameListenersInstalled = true;
  }

  async function establishWorkspaceSubscriptions(state: WorkspaceIngestState): Promise<void> {
    // 先挂帧监听再发起订阅：stdio 同一 read 会先 resolve response promise、再同步 fire
    // initial notification，而 await continuation 尚未运行；因此 handler 必须 staging，
    // 不能把“字节 response 在前”误当成“subscriptionId 已在 JS 状态里生效”。
    ensureWorkspaceFrameListeners(state);
    await Promise.all([
      ctx.subscribeIndexTopic(state, "initial", false),
      ctx.subscribeConfigTopic(state, "initial", false),
    ]);
  }

  /**
   * （CLI 重连重订）：agent 进程换代后，CLI 内存里的订阅全部丢失且不会有
   * gap 帧到达（订阅静默失活），ensureWorkspaceSubscription 的占位早退也不会重订。
   * 这里按 workspaceKey 重发 subscribe：帧监听挂在 workspace 级持久 emitter 上
   * （agentService wireClient 换代自动重接），只需刷新 subscriptionId 闸门；
   * 新 snapshot 帧对已 seeded 基线走既有“断档降级 snapshot” diff 路径收敛。
   */
  function resubscribeWorkspaceAfterRuntimeRestart(workspaceKey: string): void {
    if (runtimeState.disposed) return;
    const state = workspaceIngests.get(workspaceKey);
    if (!state) return;
    ensureWorkspaceFrameListeners(state);
    // 以前两个 topic 共用 Promise.all 代际，一侧暂态失败会
    // 撤销另一侧已成功的新订阅。现在各自 fresh subscribe + 退避重试。
    void ctx.subscribeIndexTopic(state, "runtime-restart", false);
    void ctx.subscribeConfigTopic(state, "runtime-restart", false);
  }

  function suspendWorkspaceAfterRuntimeUnavailable(workspaceKey: string, generation: number): void {
    const state = workspaceIngests.get(workspaceKey);
    if (!state || state.runtimeGeneration !== generation) return;
    state.runtimeGeneration = null;
    state.indexSubscriptionGeneration += 1;
    state.configSubscriptionGeneration += 1;
    state.indexRecoveryGeneration += 1;
    state.configRecoveryGeneration += 1;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.indexRetryTimer = null;
    state.configRetryTimer = null;
    ctx.discardIndexRecovery(state);
    ctx.discardConfigRecovery(state);
    ctx.clearPendingState(state);
    // runtime 已退出后调用 unsubscribe/retry 会重新进入 getClient。
    // unavailable 只清本地 ownership；CLI 内订阅已随进程销毁，不再发送清理 RPC。
    state.indexSubscriptionId = null;
    state.configSubscriptionId = null;
  }

  function installRuntimeLifecycle(): IDisposable[] {
    const runtimeLifecycleDisposable = agentService.onAgentRuntimeLifecycle?.((event) => {
      if (runtimeState.disposed) return;
      if (event.state === "unavailable") {
        if (
          availableRuntimeGenerationByWorkspaceKey.get(event.workspaceKey) ===
          event.runtimeIdentity.generation
        ) {
          availableRuntimeGenerationByWorkspaceKey.delete(event.workspaceKey);
        }
        suspendWorkspaceAfterRuntimeUnavailable(
          event.workspaceKey,
          event.runtimeIdentity.generation,
        );
        return;
      }

      availableRuntimeGenerationByWorkspaceKey.set(
        event.workspaceKey,
        event.runtimeIdentity.generation,
      );
      const existing = workspaceIngests.get(event.workspaceKey);
      if (!existing) {
        ensureWorkspaceSubscription({
          workspacePath: event.workspacePath,
          workspaceIdentity: event.workspaceIdentity,
        });
        return;
      }
      if (existing.runtimeGeneration === event.runtimeIdentity.generation) return;
      existing.runtimeGeneration = event.runtimeIdentity.generation;
      resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey);
    });

    // 旧测试夹具/host 没有 lifecycle 时保留 restart 兼容；生产只走 available/unavailable。
    const runtimeRestartedDisposable = hasRuntimeLifecycle
      ? undefined
      : agentService.onAgentRuntimeRestarted?.((event) =>
          resubscribeWorkspaceAfterRuntimeRestart(event.workspaceKey),
        );

    return [runtimeLifecycleDisposable, runtimeRestartedDisposable].filter(
      (disposable): disposable is IDisposable => disposable !== undefined,
    );
  }

  function ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void {
    if (runtimeState.disposed) {
      return;
    }
    if (!target.workspacePath) {
      return;
    }
    const key = resolveWorkspaceKey(target);
    if (workspaceIngests.has(key)) {
      return;
    }
    const state = createWorkspaceIngestState(
      target,
      availableRuntimeGenerationByWorkspaceKey.get(key) ?? null,
    );
    // 占位先写入 Map，避免订阅建立期间的并发调用重复订阅。
    workspaceIngests.set(key, state);
    // lifecycle 可用时，缺 runtime 的 workspace 只保留 dormant 占位；被动 observer
    // 不得启动 CLI。旧 host 没有 lifecycle 时沿用显式 ensure 的兼容行为。
    if (!hasRuntimeLifecycle || state.runtimeGeneration !== null) {
      void establishWorkspaceSubscriptions(state);
    }
  }

  return {
    ensureWorkspaceFrameListeners,
    establishWorkspaceSubscriptions,
    resubscribeWorkspaceAfterRuntimeRestart,
    suspendWorkspaceAfterRuntimeUnavailable,
    ensureWorkspaceSubscription,
    installRuntimeLifecycle,
  };
}
