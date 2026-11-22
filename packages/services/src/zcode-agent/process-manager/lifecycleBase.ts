/**
 * process-manager/lifecycleBase.ts: Единственный владелец состояния менеджера процессов —
 * пул managed-процессов, generation/identity, idle-таймеры, reclaim и dispose.
 *
 * Spawn-оркестрация живёт в наследнике (`processManager.ts`): порядок событий
 * spawn → ready → exit и владение таймерами остаются в одних руках.
 */
import { Emitter } from "@zcode/rpc";
import { resolveWorkspaceKey, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zcode-agent/zcodeAgent.js";
import type { RuntimeProcessLifecycleReporter } from "#src/process/runtimeProcessLifecycle.js";
import type { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";
import { errorLog, log, warnLog } from "./logging.js";
import { resolveDefaultZCodeAgentCommand } from "./commandResolver.js";
import type {
  AgentProcessCleanupReason,
  ManagedZCodeAgentProcess,
  ZCodeAgentCommandResolver,
  ZCodeAgentProcessManagerOptions,
  ZCodeAgentRuntimeIdentity,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentRuntimeRestartedEvent,
} from "./types.js";

export abstract class ZCodeAgentProcessManagerBase {
  protected readonly processesByWorkspaceKey = new Map<string, ManagedZCodeAgentProcess>();
  protected readonly ownedProcesses = new Set<ManagedZCodeAgentProcess>();
  protected readonly startingByWorkspaceKey = new Map<string, Promise<ZCodeProtocolClient>>();
  protected readonly restartGenerationByWorkspaceKey = new Map<string, number>();
  protected readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
  protected readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  protected readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  protected readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ZCodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  protected readonly commandResolver: ZCodeAgentCommandResolver;
  protected readonly presentationSurface: ZCodeAgentProcessManagerOptions["presentationSurface"];
  protected readonly requestTimeoutMs: number | undefined;
  protected readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  protected readonly resolveSpawnEnv: ZCodeAgentProcessManagerOptions["resolveSpawnEnv"];
  protected readonly waitForSpawnAdmission: ZCodeAgentProcessManagerOptions["waitForSpawnAdmission"];
  protected readonly spawnFallbackCwd: string | undefined;
  protected readonly lane: string | undefined;
  protected readonly idleTimeoutMs: number | undefined;
  protected readonly runtimeRestartedEmitter = new Emitter<ZCodeAgentRuntimeRestartedEvent>();
  protected readonly runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  protected disposeAllInFlight: Promise<void> | undefined;
  protected disposed = false;

  /** 进程换代通知（generation>1 时触发）；v4 订阅方据此重订，见 ZCodeAgentRuntimeRestartedEvent。 */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** 进程真实 spawn 后 available，当前 protocol client 关闭后 unavailable。 */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ZCodeAgentProcessManagerOptions) {
    this.commandResolver = options?.commandResolver ?? resolveDefaultZCodeAgentCommand;
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  }

  protected reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // 进程生命周期上报是旁路观测，临时失败不得阻断 agent 启动或回收。
      warnLog("ZCode agent process lifecycle reporter failed", error);
    }
  }

  protected clearIdleTimer(managed: ManagedZCodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * 空闲回收：每次在飞请求归零就重置计时；到点时若仍无请求在飞且该进程仍是当前活跃实例，
   * 主动回收整棵进程树（含挂在其下的 MCP 子进程）。归因为 expected/idle-timeout，
   * 不会被监控当作崩溃。到点时有新请求在飞则什么都不做，等下一次归零重新计时。
   */
  protected scheduleIdleReclaim(
    workspaceKey: string,
    managed: ManagedZCodeAgentProcess,
  ): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // 自定义 Agent 的旧启动请求可能先结清，再继续数据库准备；无在飞 RPC 不代表迁移空闲。
      if (
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ZCode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // 空闲计时器不能把 host 进程钉在事件循环里。
    timer.unref?.();
    managed.idleTimer = timer;
  }

  protected recordTerminationIntent(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // protocol close 可能是 Agent 崩溃的结果，只有 Host 主动发起的回收
    // 才能建立退出意图。首次 cleanup 原因是根因事实，后续 app quit 等幂等回收不能
    // 把已经发生的异常 protocol close 改写成 expected。
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  protected reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    const workspaceKey = managed.runtimeIdentity.workspaceKey;
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
      managed.runtimeIdentity.identity
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "unavailable",
    });
  }

  protected reportRuntimeReady(managed: ManagedZCodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.child.pid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.child.pid!,
        provider: ZCODE_AGENT_PROVIDER,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

  protected cleanupManagedProcess(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // protocol close 只会使 client 不再可复用，不代表它对应的
    // OS 进程已退出。将回收 Promise 绑在 managed process 上，timeout、restart 和
    // app quit 可以共用同一次幂等回收，Host 也不会丢失已退休进程的所有权。
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(async () => {
        // 进程树回收可能先于异步 exit 监听器返回；必须等 stderr/退出事件完成，
        // 否则 Host 会提前释放所有权，关闭调用方看不到最后一条诊断。
        await managed.exitDiagnosticsCompleted;
        cleanupCompleted = true;
        log("ZCode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    // Bug 原因：dispose 与重试编排竞态时，rejection 可能先于调用方 await 挂靠被判为
    // unhandledRejection（vitest 计为运行级失败，生产等价于未处理拒绝）。catch 必须在
    // 创建点无条件挂靠：reportError:false（重试路径）时静默吞掉，统一上报由
    // cleanupManagedProcessWithRetry 的 await/catch 完成，告警语义不变。
    void cleanupPromise.catch((error) => {
      if (options.reportError === false) {
        return;
      }
      errorLog("ZCode agent process cleanup failed", {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        reason,
        error,
      });
    });
    return cleanupPromise;
  }

  private async cleanupManagedProcessForShutdown(
    managed: ManagedZCodeAgentProcess,
  ): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

  protected async cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // 首次 cleanup 的进程树/exit 观察可能只是中间态；在 retry 成功时，
      // 首次 rejection 不应提前升级为生产 error 告警。最终失败仍由本方法统一上报一次。
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows 进程表查询/exit 事件可能短暂落后，首次 cleanup 会误报 root
      // 残留。restart/app quit 都不能把这种中间态暴露给调用方，需重试一次并复用
      // transport 内部快照；真实残留会在第二次 cleanup 继续抛出。
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ZCode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, { reportError: false });
      } catch (finalError) {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    const workspaceKey = resolveWorkspaceKey(params);
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed) {
      return existing.client;
    }

    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ZCode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ZCode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      return client;
    }

    // agent 启动前置后，host warmup 和 UI 首次 readWorkspacePresentation/sendPrompt
    // 可能同时进入 getClient。这里按 workspaceKey 收敛启动中的 promise，避免同一工作区重复 spawn。
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    try {
      return await startPromise;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
    }
  }

  /**
   * 只读取已经登记的 runtime client；被动 observer 使用本入口避免 getClient 的隐式 spawn。
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed && !managed.child.killed ? managed.client : undefined;
  }

  /** 资源管理器：当前仍存活的受管 runtime（pid + workspace + client） */
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ZCodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ZCodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.child.pid !== "number") continue;
      result.push({
        pid: managed.child.pid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** Agent service 首次通过 provider/model 门禁后调用；同一 runtime 只上报一次。 */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient 可能早于 ChildProcess 的异步 spawn 事件返回，也可能在 await 期间
    // 被新 runtime 替换。只给返回该 entry 的进程标 ready，并由 spawn 回调保证 start → ready 顺序。
    this.reportRuntimeReady(managed);
  }

  protected abstract startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient>;

  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAgentRuntimeIdentity> {
    const workspaceKey = resolveWorkspaceKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity 是查询接口，旧实现却复用了启动型 getClient，
    // 导致 provider 保存等被动探测按 workspace 数量隐式 spawn Agent CLI。
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return managed.runtimeIdentity;
  }

  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ZCODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params);
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose 不能把尚未完成的 start promise 从追踪表中删掉。删除会让
    // recovery/UI 的下一次 getClient 再开一条 spawn，旧 promise 随后又可能越过异步
    // resolve 回写进程池，形成同一 workspace 的 spawn/dispose 风暴。代际检查会让旧
    // promise 在真正 spawn 前失败，finally 再按 promise identity 清理 map。
    if (managed) {
      // restartWorkspaceProcess 只应回收当前 workspace 的 agent。
      // 不能复用 disposeAll，否则会把整个 manager 标记为已关闭，后续首发/预热无法重新拉起。
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("ZCode agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

  private abortAllPendingStarts(
    reason = new Error("ZCode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // app/host 退出时旧逻辑只同步 dispose client，底层进程树的 SIGKILL 兜底
    // 依赖 unref timer，host 自己退出后 timer 不会再执行，zcode-cli 会残留为孤儿进程。
    // 这里让 host 可以等待每个 workspace 的 agent 进程树完成 graceful + force 清理。
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
