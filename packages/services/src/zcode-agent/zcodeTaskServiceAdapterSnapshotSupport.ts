/**
 * zcodeTaskServiceAdapterSnapshotSupport.ts: Нормализация параметров workspace и snapshot: режимы, лимиты сообщений, timeline-фолбэки.
 */
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import type {
  ModelSelection,
  ZCodeDeliveryKind,
  ZCodeGoalVerificationTimelineMeta,
  ZCodePersistedMessage,
  ZCodeSessionMode,
  ZCodeSessionStateSnapshot,
  ZCodeTaskMode,
  ZCodeTaskSnapshot,
} from "@zcode/shared";
import {
  decodeCustomModelValue,
  getZCodeGoalActiveIterationCount,
  parseModelPickerValue as parseSharedModelSelection,
  resolveZCodeVisibleSessionTitle,
} from "@zcode/shared";

export function normalizeWorkspaceParams(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
}

export function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

export function normalizeSnapshotMessageLimit(
  messageLimit: number | undefined,
): number | undefined {
  if (!messageLimit || !Number.isFinite(messageLimit) || messageLimit <= 0) {
    return undefined;
  }
  return Math.floor(messageLimit);
}

export function buildSnapshotHistory(
  totalMessages: number,
  messageLimit: number,
): NonNullable<ZCodeTaskSnapshot["history"]> {
  return {
    truncatedBefore: totalMessages > messageLimit,
    totalMessages,
  };
}

export function getTaskSnapshotMessageDiagnostics(snapshot: ZCodeTaskSnapshot) {
  let assistantMessages = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let bodyRefs = 0;
  let toolSliceMessages = 0;
  let contentChars = 0;
  let thoughtChars = 0;

  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      assistantMessages += 1;
    } else {
      userMessages += 1;
    }
    toolCalls += message.tools?.length ?? 0;
    bodyRefs += message.bodyRefs?.length ?? 0;
    if (message.toolSlice) {
      toolSliceMessages += 1;
    }
    contentChars += message.content.length;
    thoughtChars += message.thought?.length ?? 0;
  }

  return {
    assistantMessages,
    bodyRefs,
    contentChars,
    fileChanges: snapshot.fileChanges?.length ?? 0,
    historyTotalMessages: snapshot.history?.totalMessages ?? snapshot.messages.length,
    messages: snapshot.messages.length,
    slashCommands: snapshot.slashCommands?.length ?? 0,
    thoughtChars,
    toolCalls,
    toolSliceMessages,
    truncatedBefore: snapshot.history?.truncatedBefore ?? false,
    userMessages,
  };
}

export function limitTaskSnapshotMessages(
  snapshot: ZCodeTaskSnapshot,
  messageLimit: number | undefined,
): ZCodeTaskSnapshot {
  const limit = normalizeSnapshotMessageLimit(messageLimit);
  if (!limit) {
    return snapshot;
  }
  const history = buildSnapshotHistory(snapshot.messages.length, limit);
  return {
    ...snapshot,
    messages: history.truncatedBefore ? snapshot.messages.slice(-limit) : snapshot.messages,
    // 手机 replayable 首屏为了性能只拿尾部窗口。
    // UI 不能再用“返回条数是否等于 limit”猜测是否还有更早历史，因为短尾部终态快照也可能是裁剪窗口。
    history,
  };
}

export function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // UI 下拉的 custom:provider:model 只是展示态，不能原样传给 zcode-cli。
    // 旧解析会先按冒号截断成 custom，最终下发 glm/custom，触发 Unsupported model。
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

export function toZCodeMode(mode: ZCodeTaskMode | undefined): ZCodeSessionMode | undefined {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
      // automation UI 保存的“自动编辑”使用 canonical edit。旧映射漏掉该值，
      // 调用方的 ?? build 会把权限模式静默降级成“变更前确认”。
      return "edit";
    case "guarded":
      return "guarded";
    case "yolo":
    case "bypassPermissions":
    case "dontAsk":
      return "yolo";
    case "auto":
      return "auto";
    case "build":
    case "default":
    case "acceptEdits":
    case "autoEdit":
      return "build";
    default:
      return undefined;
  }
}

export function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

export function addSessionForkSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const parentSessionId = snapshot.session.parentSessionId;
  if (
    !parentSessionId ||
    messages.some((message) => message.syntheticTimeline?.type === "session_fork")
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
      // 旧的纯对话 fork 没有落库 synthetic notice，只能从 session.parentSessionId
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

export function addGoalVerificationTimelineSnapshotFallback(
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
    .filter((item) => !existingIds.has(goalVerificationTimelineIdentityKey(item)))
    .map<ZCodePersistedMessage>((item) => ({
      id: goalVerificationTimelineMessageId(item),
      role: "assistant",
      content: "",
      timestamp: item.startedAt ?? item.updatedAt,
      // goal verifier lifecycle 是 agent snapshot 的持久状态，不一定有
      // 对应 message history；task facade 也要按 target+iteration 和 anchor 补 divider，避免恢复后重复或错位。
      syntheticTimeline: item,
    }));
  if (timelineMessages.length === 0) {
    return messages;
  }
  return insertGoalVerificationTimelineMessages(messages, timelineMessages);
}

export function goalVerificationTimelineIdentityKey(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `${item.targetId}:${item.goalIteration}`;
  }
  return `verification:${item.verificationId}`;
}

export function goalVerificationTimelineMessageId(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `zcode-goal-verification-${item.targetId}-${item.goalIteration}`;
  }
  return `zcode-goal-verification-${item.verificationId}`;
}

export function insertGoalVerificationTimelineMessages(
  messages: ZCodePersistedMessage[],
  timelineMessages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const result = [...messages];
  for (const message of [...timelineMessages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )) {
    const timeline = message.syntheticTimeline;
    const anchorIndex =
      timeline?.type === "goal_verification" && timeline.anchorAssistantMessageId
        ? findPersistedMessageIndexById(result, timeline.anchorAssistantMessageId)
        : -1;
    if (anchorIndex >= 0) {
      result.splice(goalVerificationAnchorInsertIndex(result, anchorIndex), 0, message);
      continue;
    }
    result.splice(timestampInsertIndex(result, message.timestamp), 0, message);
  }
  return result;
}

export function normalizeGoalVerificationTimelineMessageOrder(
  messages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const timelineMessages = messages.filter(
    (message) => message.syntheticTimeline?.type === "goal_verification",
  );
  if (timelineMessages.length === 0) {
    return messages;
  }
  // agent history 已存在的 verifier divider 也可能因为异步到达排到下一条用户输入后面；
  // task facade snapshot 必须按 anchor 重新投影，而不是只给缺失 divider 做 fallback。
  return insertGoalVerificationTimelineMessages(
    messages.filter((message) => message.syntheticTimeline?.type !== "goal_verification"),
    timelineMessages,
  );
}

export function goalVerificationAnchorInsertIndex(
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

export function timestampInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  timestamp: number,
): number {
  const index = messages.findIndex((message) => message.timestamp > timestamp);
  return index >= 0 ? index : messages.length;
}

export function findPersistedMessageIndexById(
  messages: readonly ZCodePersistedMessage[],
  messageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === messageId || message.mergedMessageIds?.includes(messageId) === true,
  );
}

export function getSnapshotGoalActiveIterationCount(snapshot: ZCodeSessionStateSnapshot): number {
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

export function toZCodeDeliveryKind(
  deliveryKind: "continuous" | "bot-channel-continuous" | "replayable" | "mixed" | undefined,
): ZCodeDeliveryKind {
  return deliveryKind === "replayable" ? "web-remote-replayable" : "desktop-continuous";
}
