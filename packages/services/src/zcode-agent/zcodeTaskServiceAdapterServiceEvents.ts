/**
 * zcodeTaskServiceAdapterServiceEvents.ts: Проекция сервисных событий ZCode Agent в stream-события задачи.
 */
import type { IZCodeAgentService, ZCodeAgentServiceEvent } from "./zcodeAgent.js";
import type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexTerminalEvent,
} from "./zcodeTaskIndexSyncer.js";
import type {
  CoreHelpers,
  CreateZCodeTaskServiceAdapterOptions,
  TaskAdapterState,
  TaskTarget,
} from "./zcodeTaskServiceAdapterCore.js";
import type { RuntimeCommandHelpers } from "./zcodeTaskServiceAdapterRuntimeCommands.js";
import type { TaskIndexHelpers } from "./zcodeTaskServiceAdapterTaskIndex.js";
import type { ToolProjectionHelpers } from "./zcodeTaskServiceAdapterToolProjection.js";
import type {
  ZCodePermissionRequest,
  ZCodeSessionStateSnapshot,
  ZCodeStreamEvent,
  ZCodeTaskSnapshot,
} from "@zcode/shared";
import { settingsToConfigOptions } from "./zcodeConfigOptions.js";
import { EMPTY_SLASH_COMMANDS, logger } from "./zcodeTaskServiceAdapterCore.js";
import {
  pendingPermissionToStreamEvent,
  pendingUserInputBackedPermissionToElicitationEvent,
  permissionRequestToStreamEvent,
  setTaskBackgroundTaskControlCache,
  userInputRequestToElicitationStreamEvent,
  userInputResponseToElicitationStreamEvent,
} from "./zcodeTaskServiceAdapterElicitationMapping.js";
import {
  mapMessage,
  sessionGoalStatsToRuntime,
  sessionTodoGroupsToRuntime,
  sessionTodosToPlanSteps,
} from "./zcodeTaskServiceAdapterMessageMapping.js";
import {
  asRecord,
  contextUsageFromProjection,
  contextUsageFromRuntime,
  isUserInputBackedPermissionToolName,
  recordAgentModelNetworkTelemetry,
  stringValue,
} from "./zcodeTaskServiceAdapterRuntimePayloads.js";
import { mapSessionEvent, mapStateUpdated } from "./zcodeTaskServiceAdapterSessionEventMapping.js";
import {
  addGoalVerificationTimelineSnapshotFallback,
  addSessionForkSnapshotFallback,
  getSnapshotGoalActiveIterationCount,
  normalizeGoalVerificationTimelineMessageOrder,
} from "./zcodeTaskServiceAdapterSnapshotSupport.js";
import {
  coalesceConsecutiveZCodeAssistants,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  generateTraceId,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  parseZCodeBackgroundTaskControlItems,
} from "@zcode/shared";

export type ServiceEventsHelpers = ReturnType<typeof createServiceEventsHelpers>;

export function createServiceEventsHelpers(
  deps: { options: CreateZCodeTaskServiceAdapterOptions } & Pick<
    TaskAdapterState,
    | "activePromptInputIds"
    | "apiRetryByTaskKey"
    | "backgroundTaskControlsByTaskKey"
    | "disposed"
    | "errorEmitter"
    | "globalTaskEmitters"
    | "liveToolProjectionsByTaskKey"
    | "runtimeCommandDrains"
    | "runtimeCommands"
    | "streamedTurnText"
    | "taskEmitters"
    | "taskIndexRepo"
    | "taskIndexSyncer"
    | "taskTargets"
    | "toolProjectionMemoryByTaskKey"
  > &
    Pick<
      CoreHelpers,
      | "emitTaskEvent"
      | "emitWorkspaceConfig"
      | "getToolProjectionMemory"
      | "taskKey"
      | "workspaceKey"
    > &
    Pick<
      RuntimeCommandHelpers,
      | "completeRuntimeCommandByInputId"
      | "completeRuntimeCommandForTerminalEvent"
      | "scheduleRuntimeCommandDrain"
    > &
    Pick<
      TaskIndexHelpers,
      | "hasActiveTaskApiRetry"
      | "snapshotToMeta"
      | "syncTaskIndexSnapshot"
      | "updateTaskApiRetryFromStreamEvent"
    > &
    Pick<
      ToolProjectionHelpers,
      "mergeLiveToolProjectionIntoSnapshotMessages" | "rememberLiveToolProjection"
    >,
) {
  const {
    activePromptInputIds,
    apiRetryByTaskKey,
    backgroundTaskControlsByTaskKey,
    errorEmitter,
    globalTaskEmitters,
    liveToolProjectionsByTaskKey,
    runtimeCommandDrains,
    runtimeCommands,
    streamedTurnText,
    taskEmitters,
    taskIndexRepo,
    taskIndexSyncer,
    taskTargets,
    toolProjectionMemoryByTaskKey,
    emitTaskEvent,
    emitWorkspaceConfig,
    getToolProjectionMemory,
    taskKey,
    workspaceKey,
    completeRuntimeCommandByInputId,
    completeRuntimeCommandForTerminalEvent,
    scheduleRuntimeCommandDrain,
    hasActiveTaskApiRetry,
    snapshotToMeta,
    syncTaskIndexSnapshot,
    updateTaskApiRetryFromStreamEvent,
    mergeLiveToolProjectionIntoSnapshotMessages,
    rememberLiveToolProjection,
    options,
  } = deps;

  function snapshotToZCode(
    snapshot: ZCodeSessionStateSnapshot,
    options?: { includeEmptyPendingElicitations?: boolean },
  ): ZCodeTaskSnapshot {
    const meta = snapshotToMeta(snapshot);
    const activeGoalIterationCount = getSnapshotGoalActiveIterationCount(snapshot);
    const goalIterationByAssistantMessageId = getZCodeGoalIterationByAssistantMessageId(
      snapshot.messages,
      {
        ...(activeGoalIterationCount > 0 ? { maxGoalIteration: activeGoalIterationCount } : {}),
        target: snapshot.projection.target,
      },
    );
    const backgroundTaskNotifications = collectZCodeBackgroundTaskNotificationsByToolUseId(
      snapshot.messages,
    );
    const messages = mergeLiveToolProjectionIntoSnapshotMessages(
      meta,
      normalizeGoalVerificationTimelineMessageOrder(
        addGoalVerificationTimelineSnapshotFallback(
          addSessionForkSnapshotFallback(
            coalesceConsecutiveZCodeAssistants(
              getZCodeUserVisibleMessages(snapshot.messages, {
                target: snapshot.projection.target,
              }).map((message) =>
                mapMessage(
                  message,
                  message.info.role === "assistant"
                    ? goalIterationByAssistantMessageId.get(message.info.messageId)
                    : undefined,
                  backgroundTaskNotifications,
                ),
              ),
            ),
            snapshot,
          ),
          snapshot,
        ),
      ),
    );
    const pendingPermissions: ZCodePermissionRequest[] = snapshot.projection.pendingPermissions
      .filter((permission) => !isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) => pendingPermissionToStreamEvent(snapshot.session.sessionId, permission));
    const pendingElicitations = snapshot.projection.pendingPermissions
      .filter((permission) => isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) =>
        pendingUserInputBackedPermissionToElicitationEvent(snapshot.session.sessionId, permission),
      )
      .filter(
        (event): event is Extract<ZCodeStreamEvent, { type: "elicitation_request" }> =>
          event !== null,
      );
    const backgroundTaskControls = parseZCodeBackgroundTaskControlItems(
      snapshot.projection.backgroundJobs,
    );
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      taskKey(meta),
      backgroundTaskControls,
    );
    return {
      meta,
      messages,
      fileChanges: [],
      configOptions: settingsToConfigOptions(snapshot.settings),
      // agent 协议 snapshot 含有 `/compact` 等命令；task facade 投影时必须保留，
      // 否则 replayable/legacy task restore 会把 UI 的 slashCommands 回填成空。
      slashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      runtime: {
        activeTurnKind: snapshot.runtime.activeTurnKind,
        apiRetry: apiRetryByTaskKey.get(taskKey(meta)) ?? null,
        contextUsage:
          contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
          contextUsageFromProjection(snapshot.projection) ??
          undefined,
        pendingPermissions,
        backgroundBashJobs: backgroundTaskControls,
        // 手机 replayable 快照需要用空数组表达“用户输入队列已清空”。
        // desktop-continuous 主链路仍保持原投影形态，避免把 replayable 的集合恢复语义扩散过去。
        ...(pendingElicitations.length > 0 || options?.includeEmptyPendingElicitations
          ? { pendingElicitations }
          : {}),
        pendingCommands: runtimeCommands.get(taskKey(meta)) ?? [],
        // todo 的权威数据在 agent DB；历史恢复时必须随 snapshot 映射给 UI，
        // 不能只依赖 renderer 运行期收到过的 plan stream event。
        plan: sessionTodosToPlanSteps(snapshot.todos),
        goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
        goalVerifications: snapshot.runtime.goalVerifications ?? null,
        goalVerificationTimeline: snapshot.runtime.goalVerificationTimeline ?? null,
        todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
      },
    };
  }

  function mapServiceEvent(params: TaskTarget, event: ZCodeAgentServiceEvent): void {
    if (event.type === "snapshot") {
      void syncTaskIndexSnapshot(event.snapshot).catch((error) => {
        logger.warn(undefined, "同步 ZCode snapshot 到 task index 失败", error);
      });
      const snapshotEvent: ZCodeStreamEvent = {
        type: "task_snapshot_updated",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKey(params),
        taskId: params.taskId,
        traceId: generateTraceId(params.taskId),
      };
      emitTaskEvent(params, snapshotEvent);
      emitWorkspaceConfig(params, event.snapshot.settings);
      return;
    }

    if (event.type === "state.updated") {
      for (const streamEvent of mapStateUpdated(params, event.notification)) {
        emitTaskEvent(params, streamEvent);
      }
      return;
    }

    if (event.type === "permission.request") {
      emitTaskEvent(params, permissionRequestToStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.request") {
      emitTaskEvent(params, userInputRequestToElicitationStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.response") {
      emitTaskEvent(
        params,
        userInputResponseToElicitationStreamEvent(params.taskId, event.requestId, event.response),
      );
      return;
    }

    if (event.type === "providerRuntimeHeaders.request") {
      return;
    }

    if (event.type === "session.event") {
      recordAgentModelNetworkTelemetry(event.event);
      if (event.event.type === "turn.started") {
        const payload = asRecord(event.event.payload);
        const inputId = stringValue(payload.inputId);
        if (inputId) {
          // remote/replayable/fallback 订阅不一定由 sendPrompt 建立。
          // turn.started 是后续 model.streaming 事件归属当前输入的协议事实，必须在 services 投影层同步记录。
          activePromptInputIds.set(taskKey(params), inputId);
        }
      }
    }

    const activePromptInputId = activePromptInputIds.get(taskKey(params));
    const streamEvents = mapSessionEvent(
      params,
      event.event,
      streamedTurnText,
      activePromptInputId,
      getToolProjectionMemory(params),
      backgroundTaskControlsByTaskKey,
      hasActiveTaskApiRetry(params),
    );
    for (const streamEvent of streamEvents) {
      rememberLiveToolProjection(params, streamEvent);
      updateTaskApiRetryFromStreamEvent(params, streamEvent);
      emitTaskEvent(params, streamEvent);
      if (streamEvent.type === "task_complete" || streamEvent.type === "task_error") {
        completeRuntimeCommandForTerminalEvent(params, streamEvent);
      }
    }
    if (event.event.type === "turn.completed" || event.event.type === "turn.failed") {
      activePromptInputIds.delete(taskKey(params));
    }
  }

  function handleTaskIndexTerminalEvent(event: ZCodeTaskIndexTerminalEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    // 终态事件源换成 v4 sessions-index 的 phase 迁移，摘要不携带 inputId，
    // 一律用本地记录的 active input 收口（旧协议 payload.inputId 缺失时的兜底路径，语义不变）。
    const terminalInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, terminalInputId, event.kind);
    // turn 终态只说明 stream 收口已到，不代表 agent server 的 active lock 已释放。
    // 这里仅收口当前 input；下一条 host command 必须等 ready 事件触发。
    activePromptInputIds.delete(key);
  }

  const taskIndexTerminalDisposable = taskIndexSyncer.onSessionTerminalEvent((event) => {
    queueMicrotask(() => {
      if (!deps.disposed) {
        handleTaskIndexTerminalEvent(event);
      }
    });
  });

  function handleTaskIndexReadyEvent(event: ZCodeTaskIndexReadyEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    const activeInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, activeInputId, event.reason);
    // prompt_completed/prompt_failed 由 agent server 在释放 activeAbortController 后发出。
    // 手机 host command queue 以它作为“下一条可以发送”的 ready 边界，避免 fixed delay 重试，
    // 也不改变桌面 continuous 的 renderer-local queue。
    activePromptInputIds.delete(key);
    scheduleRuntimeCommandDrain(params, "session-ready");
  }

  const taskIndexReadyDisposable = taskIndexSyncer.onSessionReadyEvent((event) => {
    queueMicrotask(() => {
      if (!deps.disposed) {
        handleTaskIndexReadyEvent(event);
      }
    });
  });

  /**
   * Agent 进程死亡/换代时，旧 turn 的 active input 永远不会再收到 turn.completed 或
   * sessions-index ready。旧实现把 id 留在表里，drain 的 `activePromptInputIds.has(key)`
   * 会永久拒绝该 task 的后续手机命令。
   *
   * 同时移除旧 runtime 的 running 命令：它们属于已死进程，既不会终态也不会被重发，
   * 留着还会让 drain 的 `status === "running"` 闸门永久关闭。accepted 命令只是排队，
   * 等下一次 ready/enqueue 继续消费，不能一并删掉。
   */
  function recoverRuntimeStateAfterRuntimeLoss(workspaceKeyValue: string): void {
    const prefix = `${workspaceKeyValue}\u0000`;
    // Map 迭代器允许删除/替换当前项；按前缀就地回收，避免复制整张 per-task 表。
    for (const key of activePromptInputIds.keys()) {
      if (key.startsWith(prefix)) activePromptInputIds.delete(key);
    }
    for (const [key, commands] of runtimeCommands) {
      if (!key.startsWith(prefix)) continue;
      // На смене процесса остаются только ещё не принятые команды: running/failed
      // принадлежат умершему runtime, их нельзя ни завершить, ни переотправить.
      const retained = commands.filter((command) => command.status === "accepted");
      if (retained.length > 0) {
        runtimeCommands.set(key, retained);
      } else {
        runtimeCommands.delete(key);
      }
    }
  }

  const noopDisposable = { dispose() {} };
  const runtimeLifecycleDisposable =
    options.zcodeAgentService.onAgentRuntimeLifecycle?.((event) => {
      // available 也清一次：崩溃后新 runtime 可能先发布 available，旧 turn 的 id 不能跨进程继承。
      recoverRuntimeStateAfterRuntimeLoss(event.workspaceKey);
    }) ??
    options.zcodeAgentService.onAgentRuntimeRestarted?.((event) => {
      recoverRuntimeStateAfterRuntimeLoss(event.workspaceKey);
    }) ??
    noopDisposable;

  /** 删除任务后 Host 侧不再需要该 task 的命令队列/turn 镜像。 */
  function forgetTaskRuntimeState(params: TaskTarget): void {
    const key = taskKey(params);
    activePromptInputIds.delete(key);
    runtimeCommands.delete(key);
    runtimeCommandDrains.delete(key);
    streamedTurnText.delete(key);
    liveToolProjectionsByTaskKey.delete(key);
    apiRetryByTaskKey.delete(key);
    backgroundTaskControlsByTaskKey.delete(key);
    taskTargets.delete(params.taskId);
  }

  function disposeLocalTaskState(): void {
    taskIndexTerminalDisposable.dispose();
    taskIndexReadyDisposable.dispose();
    runtimeLifecycleDisposable.dispose();
    taskIndexRepo.close();
    for (const emitter of taskEmitters.values()) emitter.dispose();
    for (const emitter of globalTaskEmitters.values()) emitter.dispose();
    errorEmitter.dispose();
    taskEmitters.clear();
    globalTaskEmitters.clear();
    runtimeCommandDrains.clear();
    streamedTurnText.clear();
    runtimeCommands.clear();
    activePromptInputIds.clear();
    taskTargets.clear();
    apiRetryByTaskKey.clear();
    backgroundTaskControlsByTaskKey.clear();
    toolProjectionMemoryByTaskKey.clear();
    liveToolProjectionsByTaskKey.clear();
  }

  async function disposeZCodeAgentServiceAndWait(): Promise<void> {
    const agentService = options.zcodeAgentService as IZCodeAgentService & {
      disposeAllAndWait?: () => Promise<void>;
    };
    if (agentService.disposeAllAndWait) {
      await agentService.disposeAllAndWait();
      return;
    }
    agentService.disposeAll();
  }

  return {
    snapshotToZCode,
    mapServiceEvent,
    handleTaskIndexTerminalEvent,
    handleTaskIndexReadyEvent,
    recoverRuntimeStateAfterRuntimeLoss,
    forgetTaskRuntimeState,
    disposeLocalTaskState,
    disposeZCodeAgentServiceAndWait,
  };
}
