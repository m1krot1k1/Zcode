import {
  coalesceConsecutiveZCodeAssistants,
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getZCodeGoalActiveIterationCount,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  isZCodeGoalContinuationReminderMessage,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  parseZCodeBackgroundTaskControlItems,
  resolveZCodeVisibleSessionTitle,
  textFromZCodeMessageParts,
  ZCODE_AGENT_PROVIDER,
  type ZCodePersistedMessage,
  type ZCodeTaskGoalStats,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type ZCodeTaskSnapshot,
  type ZCodeTodoGroup,
  type ZCodePlanStep,
  type ZCodeMessageWithParts,
  type ZCodePermissionRequest,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  formatModelPickerValue,
  resolveTaskMetaModelSelectionFromSnapshot,
  zcodeSessionSettingsToConfigOptions,
  fromZCodeMode,
} from "./config.js";
import { fromZCodeGoal } from "./goal.js";
import {
  asRecord,
  COMPACTION_PROJECTION_DIAG_LIMIT,
  compactionProjectionDiagSignatures,
  stringValue,
} from "./primitives.js";
import { zcodeMessageToZCodePersistedMessage } from "./messages.js";
import {
  isUserInputBackedPermissionToolName,
  pendingPermissionToStreamEvent,
  pendingUserInputBackedPermissionToElicitationEvent,
} from "./permissions.js";
import {
  goalVerificationTimelineIdentityKey,
  goalVerificationTimelineMessageId,
} from "./timelines.js";
import {
  contextUsageFromProjection,
  contextUsageFromRuntime,
} from "./usage.js";

export function zcodeSessionSnapshotToZCodeTaskSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskSnapshot {
  const meta = zcodeSessionSnapshotToTaskMeta(snapshot);
  const activeGoalIterationCount =
    getSnapshotGoalActiveIterationCount(snapshot);
  const goalIterationByAssistantMessageId =
    getZCodeGoalIterationByAssistantMessageId(snapshot.messages, {
      ...(activeGoalIterationCount > 0
        ? { maxGoalIteration: activeGoalIterationCount }
        : {}),
      target: snapshot.projection.target,
    });
  const visibleMessages = getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  });
  const backgroundTaskNotifications =
    collectZCodeBackgroundTaskNotificationsByToolUseId(snapshot.messages);
  if (snapshot.projection.target) {
    const assistantGoalIterations = [
      ...goalIterationByAssistantMessageId.values(),
    ];
    const goalIterationCounts = assistantGoalIterations.reduce<
      Record<string, number>
    >(
      (counts, iteration) => ({
        ...counts,
        [String(iteration)]: (counts[String(iteration)] ?? 0) + 1,
      }),
      {},
    );
    logger.debug("[goalIterationDiag] snapshot projection", {
      assistantGoalIterations: goalIterationCounts,
      goalContinuationReminderUsers: snapshot.messages.filter(
        (message) =>
          message.info.role === "user" &&
          isZCodeGoalContinuationReminderMessage(message),
      ).length,
      goalStatsIteration: snapshot.goalStats?.iterationCount ?? null,
      rawMessages: snapshot.messages.length,
      sessionId: snapshot.session.sessionId,
      snapshotEventSeq: snapshot.runtime.eventSeq,
      targetId: snapshot.projection.target.targetId,
      visibleMessages: visibleMessages.length,
    });
  }
  const messages = normalizeGoalVerificationTimelineMessageOrder(
    addSessionForkSnapshotFallback(
      addGoalVerificationTimelineSnapshotFallback(
        addGoalObjectiveSnapshotFallback(
          restoreGoalCommandUserMessages(
            coalesceConsecutiveZCodeAssistants(
              visibleMessages.map((message) =>
                zcodeMessageToZCodePersistedMessage(
                  message,
                  message.info.role === "assistant"
                    ? goalIterationByAssistantMessageId.get(
                        message.info.messageId,
                      )
                    : undefined,
                  backgroundTaskNotifications,
                ),
              ),
            ),
            snapshot,
          ),
          snapshot,
        ),
        snapshot,
      ),
      snapshot,
    ),
  );
  logCompactionProjectionDiagnostic(snapshot, visibleMessages, messages);
  const pendingPermissions: ZCodePermissionRequest[] =
    snapshot.projection.pendingPermissions
      .filter(
        (permission) =>
          !isUserInputBackedPermissionToolName(permission.toolName),
      )
      .map((permission) =>
        pendingPermissionToStreamEvent(snapshot.session.sessionId, permission),
      );
  return {
    meta,
    messages,
    fileChanges: [],
    configOptions: zcodeSessionSettingsToConfigOptions(snapshot.settings),
    // Bugfix: session/read 已经通过协议返回 `/compact` 等 slashCommands。
    // 历史 task restore 会消费这里投影出的 task snapshot；如果不透传，UI 回填 store 时只能拿到空列表。
    slashCommands: snapshot.slashCommands ?? [],
    runtime: {
      activeTurnKind: snapshot.runtime.activeTurnKind,
      apiRetry: snapshot.runtime.apiRetry ?? null,
      contextUsage:
        contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
        contextUsageFromProjection(snapshot.projection) ??
        undefined,
      pendingPermissions,
      backgroundBashJobs: parseZCodeBackgroundTaskControlItems(
        snapshot.projection.backgroundJobs,
      ),
      pendingElicitations: snapshot.projection.pendingPermissions
        .filter((permission) =>
          isUserInputBackedPermissionToolName(permission.toolName),
        )
        .map((permission) =>
          pendingUserInputBackedPermissionToElicitationEvent(
            snapshot.session.sessionId,
            permission,
          ),
        )
        .filter(
          (
            event,
          ): event is Extract<
            ZCodeStreamEvent,
            { type: "elicitation_request" }
          > => event !== null,
        ),
      // Bugfix: agent 恢复历史 session 时会从 DB 读取 todo；UI 的 todo 面板不能再只依赖
      // 当前 renderer 内存里的 plan 事件，否则从历史打开会丢失持久 todo。
      plan: sessionTodosToPlanSteps(snapshot.todos),
      goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
      goalVerifications: snapshot.runtime.goalVerifications ?? null,
      goalVerificationTimeline:
        snapshot.runtime.goalVerificationTimeline ?? null,
      todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
    },
  };
}

function hasProtocolCompactionPart(message: ZCodeMessageWithParts): boolean {
  return message.parts.some((part) => part.type === "compaction");
}

function protocolMessageTimelineStatus(message: ZCodeMessageWithParts) {
  for (const part of message.parts) {
    if (part.type !== "compaction") {
      continue;
    }
    const metadata = asRecord(part.metadata);
    return {
      auto: part.auto,
      operationId: stringValue(metadata.operationId) ?? part.partId,
      phase: stringValue(metadata.phase),
      status: stringValue(metadata.timelineStatus),
      summaryMessageId:
        part.summaryMessageId ?? stringValue(metadata.summaryMessageId),
    };
  }
  return null;
}

function summarizeProtocolMessageForTimelineDiag(
  message: ZCodeMessageWithParts,
  index: number,
) {
  return {
    index,
    id: message.info.messageId,
    role: message.info.role,
    created: message.info.time.created,
    completed: message.info.time.completed,
    partTypes: message.parts.map((part) => part.type),
    textLength: textFromZCodeMessageParts(message.parts).length,
    compaction: protocolMessageTimelineStatus(message),
  };
}

function summarizePersistedMessageForTimelineDiag(
  message: ZCodePersistedMessage,
  index: number,
) {
  const timeline = message.syntheticTimeline;
  return {
    index,
    id: message.id ?? null,
    role: message.role,
    timestamp: message.timestamp,
    contentLength: message.content.length,
    thoughtLength:
      message.role === "assistant" ? (message.thought?.length ?? 0) : 0,
    partTypes:
      message.role === "assistant"
        ? (message.parts?.map((part) => part.type) ?? [])
        : [],
    timeline:
      timeline?.type === "context_compaction"
        ? {
            type: timeline.type,
            operationId: timeline.operationId,
            status: timeline.status,
            trigger: timeline.trigger,
            phase: timeline.phase,
            inputId: timeline.inputId,
            summaryMessageId: timeline.summaryMessageId,
          }
        : timeline
          ? { type: timeline.type }
          : null,
  };
}

function lastTimelineDiagItems<T>(
  items: readonly T[],
  mapItem: (item: T, index: number) => unknown,
) {
  const start = Math.max(0, items.length - 12);
  return items
    .slice(start)
    .map((item, offset) => mapItem(item, start + offset));
}

function rememberCompactionProjectionDiagSignature(signature: string): boolean {
  if (compactionProjectionDiagSignatures.has(signature)) {
    return false;
  }
  compactionProjectionDiagSignatures.add(signature);
  if (
    compactionProjectionDiagSignatures.size > COMPACTION_PROJECTION_DIAG_LIMIT
  ) {
    compactionProjectionDiagSignatures.clear();
    compactionProjectionDiagSignatures.add(signature);
  }
  return true;
}

function logCompactionProjectionDiagnostic(
  snapshot: ZCodeSessionStateSnapshot,
  visibleMessages: readonly ZCodeMessageWithParts[],
  projectedMessages: readonly ZCodePersistedMessage[],
) {
  const hasCompaction =
    snapshot.messages.some(hasProtocolCompactionPart) ||
    projectedMessages.some(
      (message) => message.syntheticTimeline?.type === "context_compaction",
    );
  if (!hasCompaction) {
    return;
  }

  const projectedTailSignature = projectedMessages
    .slice(-8)
    .map((message) => {
      const timeline = message.syntheticTimeline;
      return [
        message.id ?? "",
        message.role,
        message.content.length,
        timeline?.type ?? "",
        timeline?.type === "context_compaction" ? timeline.status : "",
      ].join(":");
    })
    .join("|");
  const signature = [
    snapshot.session.sessionId,
    snapshot.runtime.eventSeq ?? "no-seq",
    snapshot.session.updatedAt,
    projectedTailSignature,
  ].join("#");
  if (!rememberCompactionProjectionDiagSignature(signature)) {
    return;
  }

  // 修复排查：auto compact 之后曾出现 DB 有 assistant 但 GUI 不显示。
  // 这里只记录消息身份、长度和 timeline 元数据，避免把用户正文落进 UI 日志。
  logger.info("[conversationSessionTimelineDiag] projection compact snapshot", {
    sessionId: snapshot.session.sessionId,
    status: snapshot.session.status,
    eventSeq: snapshot.runtime.eventSeq ?? null,
    rawCount: snapshot.messages.length,
    visibleCount: visibleMessages.length,
    projectedCount: projectedMessages.length,
    rawTail: lastTimelineDiagItems(
      snapshot.messages,
      summarizeProtocolMessageForTimelineDiag,
    ),
    visibleTail: lastTimelineDiagItems(
      visibleMessages,
      summarizeProtocolMessageForTimelineDiag,
    ),
    projectedTail: lastTimelineDiagItems(
      projectedMessages,
      summarizePersistedMessageForTimelineDiag,
    ),
  });
}

function restoreGoalCommandUserMessages(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const target = snapshot.projection.target;
  const objective = target?.objective.trim();
  if (!target || !objective) {
    return messages;
  }

  let changed = false;
  const restored = messages.map((message) => {
    if (
      message.role !== "user" ||
      message.timestamp !== target.createdAt ||
      message.content.trim() !== objective
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      // Bugfix: /goal set 的 agent snapshot 已经持久化了一条可见 user message，
      // 但正文只保留 objective。这里按 target 创建时间恢复命令前缀，避免首轮 query 丢失 "/goal"。
      content: `/goal ${objective}`,
    };
  });

  return changed ? restored : messages;
}

function getSnapshotGoalActiveIterationCount(
  snapshot: ZCodeSessionStateSnapshot,
): number {
  const targetId = snapshot.projection.target?.targetId;
  const timeline =
    snapshot.runtime.goalVerificationTimeline?.filter(
      (item) => !targetId || item.targetId === targetId,
    ) ?? [];
  return getZCodeGoalActiveIterationCount({
    targetStatus: snapshot.projection.target?.status ?? null,
    timeline,
  });
}

function addGoalObjectiveSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const objective = snapshot.projection.target?.objective.trim();
  if (
    !objective ||
    messages.some((message) => message.role === "user") ||
    !snapshot.messages.some(isZCodeGoalContinuationReminderMessage)
  ) {
    return messages;
  }

  const continuationMessage = snapshot.messages.find(
    isZCodeGoalContinuationReminderMessage,
  );
  // Bugfix: /goal 续跑会把目标包进 model-only system-reminder，shared 可见过滤会正确隐藏内部 XML。
  // 但历史恢复如果没有原始用户 turn，聊天区会只剩 assistant 回复；这里补回用户实际输入的命令形态，
  // 避免首轮 query 被瘦身成 objective 后丢失 "/goal" 上下文。
  return [
    {
      role: "user",
      content: `/goal ${objective}`,
      timestamp:
        continuationMessage?.info.time.created ??
        snapshot.projection.target?.createdAt ??
        snapshot.session.createdAt,
      model: formatModelPickerValue(snapshot.settings.model.current),
    },
    ...messages,
  ];
}

function addSessionForkSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const parentSessionId = snapshot.session.parentSessionId;
  if (
    !parentSessionId ||
    messages.some(
      (message) => message.syntheticTimeline?.type === "session_fork",
    )
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      id: `zcode-timeline-fork-${parentSessionId}-`,
      role: "user",
      content: "",
      timestamp: snapshot.session.createdAt,
      // Bugfix: 旧的纯对话 fork 没有落库 synthetic notice，只能从 session.parentSessionId
      // 恢复一个不可跳转的分割线，避免历史 fork 会话完全看不到来源边界。
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "session_fork",
        display: "separator",
        parentSessionId,
        targetMessageId: "",
      },
    },
  ];
}

function addGoalVerificationTimelineSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const timeline = snapshot.runtime.goalVerificationTimeline ?? [];
  if (timeline.length === 0) {
    return messages;
  }

  const existingIds = new Set(
    messages
      .map((message) =>
        message.syntheticTimeline?.type === "goal_verification"
          ? goalVerificationTimelineIdentityKey(message.syntheticTimeline)
          : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
  const timelineMessages = timeline
    .filter(
      (item) => !existingIds.has(goalVerificationTimelineIdentityKey(item)),
    )
    .map<ZCodePersistedMessage>((item) => ({
      id: goalVerificationTimelineMessageId(item),
      role: "assistant",
      content: "",
      timestamp: item.startedAt ?? item.updatedAt,
      // 修复原因：goal verifier lifecycle 是 agent event-store 持久事实，不在 message history 内；
      // snapshot 恢复时必须按 target+iteration 和 anchor 补成边界 divider，避免同一轮校验重复追加或漂到下一轮。
      syntheticTimeline: item,
    }));
  if (timelineMessages.length === 0) {
    return messages;
  }
  return insertGoalVerificationTimelineMessages(messages, timelineMessages);
}

function insertGoalVerificationTimelineMessages(
  messages: ZCodePersistedMessage[],
  timelineMessages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const result = [...messages];
  for (const message of [...timelineMessages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )) {
    const timeline = message.syntheticTimeline;
    const anchorIndex =
      timeline?.type === "goal_verification" &&
      timeline.anchorAssistantMessageId
        ? findPersistedMessageIndexById(
            result,
            timeline.anchorAssistantMessageId,
          )
        : -1;
    if (anchorIndex >= 0) {
      result.splice(
        goalVerificationAnchorInsertIndex(result, anchorIndex),
        0,
        message,
      );
      continue;
    }
    result.splice(timestampInsertIndex(result, message.timestamp), 0, message);
  }
  return result;
}

function normalizeGoalVerificationTimelineMessageOrder(
  messages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const timelineMessages = messages.filter(
    (message) => message.syntheticTimeline?.type === "goal_verification",
  );
  if (timelineMessages.length === 0) {
    return messages;
  }
  // 修复原因：agent history 里已经持久化的 goal verifier divider 可能晚于下一条
  // user query 才到达；snapshot projection 必须重新按 anchor 归位，不能只修 fallback divider。
  return insertGoalVerificationTimelineMessages(
    messages.filter(
      (message) => message.syntheticTimeline?.type !== "goal_verification",
    ),
    timelineMessages,
  );
}

function goalVerificationAnchorInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  anchorIndex: number,
): number {
  let index = anchorIndex + 1;
  while (
    index < messages.length &&
    messages[index]?.syntheticTimeline?.type === "goal_verification"
  ) {
    index += 1;
  }
  return index;
}

function timestampInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  timestamp: number,
): number {
  const index = messages.findIndex((message) => message.timestamp > timestamp);
  return index >= 0 ? index : messages.length;
}

function findPersistedMessageIndexById(
  messages: readonly ZCodePersistedMessage[],
  messageId: string,
): number {
  return messages.findIndex(
    (message) =>
      message.id === messageId ||
      message.mergedMessageIds?.includes(messageId) === true,
  );
}

function sessionTodosToPlanSteps(
  todos: ZCodeSessionStateSnapshot["todos"],
): ZCodePlanStep[] | null {
  if (!todos || todos.length === 0) {
    return null;
  }
  return todos.map((todo, index) => ({
    id: `todo-${index}`,
    status: todo.status,
    title: todo.content,
  }));
}

function sessionGoalStatsToRuntime(
  stats: ZCodeSessionStateSnapshot["goalStats"],
): ZCodeTaskGoalStats | null {
  return stats ? { ...stats } : null;
}

function sessionTodoGroupsToRuntime(
  groups: ZCodeSessionStateSnapshot["todoGroups"],
): ZCodeTodoGroup[] | null {
  if (!groups || groups.length === 0) {
    return null;
  }
  return groups.map((group) => ({
    id: group.id,
    source: group.source,
    ...(group.goalIteration ? { goalIteration: group.goalIteration } : {}),
    ...(group.targetId ? { targetId: group.targetId } : {}),
    ...(group.startedAt ? { startedAt: group.startedAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
    todos: group.todos.map((todo, index) => ({
      id: `${group.id}-todo-${index}`,
      status: todo.status,
      title: todo.content,
    })),
  }));
}

function zcodeSessionSnapshotToTaskMeta(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskMeta {
  return {
    taskId: snapshot.session.sessionId,
    traceId: generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromZCodeMode(snapshot.session.mode),
    model: formatModelPickerValue(
      resolveTaskMetaModelSelectionFromSnapshot(snapshot),
    ),
    thoughtLevel: snapshot.settings.thoughtLevel.current,
    provider: ZCODE_AGENT_PROVIDER,
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code:
            snapshot.projection.lastError.code ??
            snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
    target: snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target,
  };
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}
