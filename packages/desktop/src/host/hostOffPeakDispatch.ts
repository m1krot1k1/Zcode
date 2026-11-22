import { randomUUID } from "node:crypto";
import {
  isOffPeakTerminalStatus,
  type ModelSelection,
  type TraceId,
  type ZCodeAutomationRunOutcome,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { IOffPeakTaskService, IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import {
  OffPeakModelUnavailableError,
  OffPeakTaskRepo,
  OffPeakTaskService,
  buildTaskChangeSummary,
  getOffPeakRequestAuthBuilder,
  type OffPeakRequestAuthBuilder,
} from "@zcode/services/node";
import { logger } from "./hostProcessLogging.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { hostState } from "./hostState.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";

const { parentPort } = process;

// ---- 闲时任务（off-peak）派发：与 cron 并行的独立链路（表/消息/常量互不复用）----
const offPeakTaskRepo = new OffPeakTaskRepo();
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * 续跑提示词（"实现时定"的落地）：3h 时间盒到期 / app 重启恢复后 resume 同一
 * session 续发。不重发原始 prompt（会让模型从头再做一遍），而是指示接续未完成的工作。
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- off-peak 运行时装配（server client + 进程内 mock 网关 + 编排服务，host 域属主）----
// ⚠ 多窗口=多 host 会各自跑一份 sync 轮询（批量接口幂等、写入同库同数据，重复仅多耗请求）；
// mock 网关用固定端口单实例共享票据状态。若多窗口轮询放大成本，再加跨 host 选主。
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** 派发时按本段票据构造逐请求鉴权；静态模型事实由 CLI Built-in Config 提供。 */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
let offPeakRuntime: OffPeakRuntime | null = null;

async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = hostState.activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

interface OffPeakRunDispatchRequest {
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string | null;
  hostId?: string;
  additionalDirectories?: string[];
}

function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** 终态回填 files_changed：复用现有 task diff 汇总（工具写盘型统计，Bash 改动不计入，接受）。 */
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // 汇总为空（无文件改动）按 0 计——"改了 0 个文件"对完成通知是真实信息。
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
    return undefined;
  }
}

/** loop 终态 → off_peak_tasks 终态：succeeded→completed、stopped→cancelled（用户手动停止）、其余→failed。 */
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  if (!updated) {
    // 终态不可逆出：任务已被用户先一步取消/删除等，丢弃迟到回写（幂等兜底）。
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // 后台完成统一置未读，打开 task 时由导航链路清除（与 cron 同款）。
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  zcodeAgentService: IZCodeAgentService;
  service: OffPeakTaskService;
  ticketId: string;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): { admitted(): void } {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const target = {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
  const registration = params.service.residentExecutions.register({
    offPeakTaskId: params.offPeakTaskId,
    executionId: params.traceId,
    sessionId: params.taskId,
    ticketId: params.ticketId,
    control: (control) =>
      params.zcodeAgentService.controlOffPeakExecutionV4({ ...target, control }),
    complete: (outcome) => finalizeOffPeakRun({ ...params, outcome }),
    disposed: () => disposeOffPeakRunSubscription(key),
  });
  const disposable = params.zcodeAgentService.onDynamicOffPeakLifecycle(target)((event) => {
    if (event.executionId !== params.traceId || event.sessionId !== params.taskId) return;
    void params.service.residentExecutions
      .handle(event)
      .catch((error) => logger.warn("off-peak 生命周期处理失败:", error));
  });
  offPeakRunSubscriptions.set(key, {
    dispose() {
      disposable.dispose();
      registration.dispose();
    },
  });
  return registration;
}

/**
 * 把一次闲时任务派发提交给当前 host 的 V4 task service。
 * 首跑 createTask；进程内换票只交付现存执行，绝不重发初始 prompt。
 * 已有任务行的中断恢复仍复用会话；它不恢复旧进程的后台工作或通知。
 */
export async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId?: string;
  sessionId?: string;
  lifecycleManaged: true;
}> {
  const zcodeTaskService = hostState.activeServices?.getOptional(IZCodeTaskService);
  const zcodeAgentService = hostState.activeServices?.getOptional(IZCodeAgentService);
  if (!zcodeTaskService || !zcodeAgentService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  if (!request.serverTicketId) {
    // schedulable 必然已取号；无票派发说明快照失序，按 transient 回执等下轮（轮询会补票）。
    throw new Error("off-peak dispatch without server ticket");
  }
  const currentTask = await offPeakTaskRepo.get(request.offPeakTaskId);
  if (!currentTask || isOffPeakTerminalStatus(currentTask.status)) {
    // 调度认领与 CLI 收口可以交错；迟到的派发不能重放已经完成的任务。
    await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
    const sessionId = currentTask?.conversationId ?? request.conversationId ?? request.sessionId;
    return { conversationId: sessionId, sessionId, lifecycleManaged: true };
  }
  if (runtime.service.residentExecutions.has(request.offPeakTaskId)) {
    const stillNeedsTicket = runtime.service.residentExecutions.retakeGuard(request.offPeakTaskId);
    const auth = runtime.service.residentExecutions.isUserOwned(request.offPeakTaskId)
      ? {}
      : await runtime.buildRequestAuth(request.serverTicketId);
    // 先写 running 再唤醒 CLI；否则新请求立即过期产生的 requeue 会被迟到确认覆盖。
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, { startedAt: Date.now() });
    try {
      const resident = await runtime.service.residentExecutions.deliverTicket(
        request.offPeakTaskId,
        request.serverTicketId,
        auth,
      );
      if (resident)
        return {
          conversationId: resident.sessionId,
          sessionId: resident.sessionId,
          lifecycleManaged: true,
        };
      // 等凭据期间驻留执行可能完成并注销；此派发已属于续票，禁止降级成初始 prompt。
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      const sessionId = currentTask.conversationId ?? request.conversationId ?? request.sessionId;
      return { conversationId: sessionId, sessionId, lifecycleManaged: true };
    } catch (error) {
      // RPC 在途可能发生用户接管或整项完成，失败回执不能重新夺回调度归属。
      if (stillNeedsTicket()) await offPeakTaskRepo.requeueForContinuation(request.offPeakTaskId);
      throw error;
    }
  }
  // 闲时 Selection 只承载驻内存续跑；普通 Session entry 与 CLI 默认不持久化它。
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // 首次派发与复用会话的恢复派发需要在轮次事实中可区分；该字段只描述
  // 当前自动 turn 的调度阶段，不改变稳定 task ID、独立 message ID 或手动消息语义。
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    if (dispatchKind === "bound-first-run") {
      // 绑定首跑：会话内创建的任务在创建它的会话里执行（对齐 dispatchCronRun 的 targetTaskId 路径）。
      // 先探测再写配置：绑定的是用户的工作会话，忙碌时直接 transient 交给调度器退避，
      // 不能先 setMode 再被 session/send 以 -32010 拒绝（那会悄悄改掉用户会话的权限模式）。
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
      };
      // Bug 原因：归属收口后 tasks-index 行的 status 只镜像 CLI 的 last_outcome，
      // 永远不会是 running，原来按 listTasks(...).status === "running" 的忙碌判断已失效，
      // 闲时任务会被派发到仍在运行的绑定会话上。运行中事实只能取 syncer 的活动集合。
      const [deletedIds, activeIds] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listActiveTaskIds(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: activeIds.includes(taskId),
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // 绑定会话首次盖章归属标记，侧栏归入闲时分组（机制同 cron targetTaskId）。
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    } else if (dispatchKind === "resume") {
      // 续跑段：resume 同一 session（冷恢复水合历史；send 前必须先 resume）。
      taskId = request.conversationId!;
      // 原因：offPeakTaskId 只用于跨 talk 关联；每次自动轮必须生成独立消息身份，
      // 不能复用 task ID，也不能依赖同毫秒时间戳避免碰撞。
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // D48：pre-打点会话续跑时补写归属标记（bootstrap 回填之外的双保险）。
        offPeakTaskId: request.offPeakTaskId,
      });
      // 权限模式随派发下发（resume 后显式设置，幂等）。
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // 档位是 idle Selection 的一部分，只在 sendPrompt 注入；单独写档位会污染用户会话。
    } else {
      const task = await zcodeTaskService.createTask({
        projectId: request.projectId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        additionalDirectories: request.additionalDirectories,
        // 空 Session 沿用普通初始化；idle Selection 只在下方执行中注入。
        // 在此写入会让闲时轮结束后的普通消息继续使用无票的隐藏 Provider。
        mode: request.permissionMode as ZCodeTaskMode,
        // 闲时任务是无界面的 createTask + sendPrompt 连续派发；空 session 必须在首条
        // V4 admission 内先持久化，否则 session_input 外键会先于 session 主记录写入。
        deferPersistenceUntilFirstPrompt: true,
        // 创建时即盖章持久归属标记（月亮图标/后续系统分组只看该标记，不再反查 store）。
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    // 准备会话含异步 I/O；任务可能在此期间取消，首条 prompt 接纳前必须重新核对。
    const beforeAdmission = await offPeakTaskRepo.get(request.offPeakTaskId);
    if (!beforeAdmission || isOffPeakTerminalStatus(beforeAdmission.status)) {
      await runtime.service.residentExecutions.discardTicket(request.serverTicketId);
      return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    const lifecycle = trackOffPeakRunOutcome({
      zcodeTaskService,
      zcodeAgentService,
      service: runtime.service,
      ticketId: request.serverTicketId,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug 原因：闲时自动 turn 以前只注入 idle plan，没有限制工具面，模型可在后台创建
      // 持久化定时任务。首跑与续跑在此收敛，显式隐藏 CronCreate 且不伪造 cron automation 归属。
      // 闲时轮同时隐藏 OffPeakCreate，OffPeakList 只读保留。
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // 闲时执行凭据只服务主 Turn；完成后不再派生自动 Memory 请求。
        memoryExtraction: "skip",
        selectionScope: "execution",
        offPeak: {
          executionId: traceId,
          ticketId: request.serverTicketId,
          providerErrorCode: "3102",
        },
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "allow",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    await offPeakTaskRepo.markRunning(request.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: taskId,
      sessionId: taskId,
    });
    lifecycle.admitted();
    // 只有 init 实际新建；绑定首跑和跨票续跑只是原 Session 的后续输入。
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId, lifecycleManaged: true };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

/** shutdown 顺序：先释放全部 run 订阅，再清运行时，最后关 Repo。 */
export function disposeOffPeakRunSubscriptions(): void {
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
}

export function closeOffPeakTaskRepo(): void {
  offPeakTaskRepo.close();
}

export function disposeOffPeakRuntimeOwner(): void {
  disposeOffPeakRuntime();
}
