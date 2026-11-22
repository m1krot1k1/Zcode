import { randomUUID } from "node:crypto";

import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";


import { CoreErrorType, RewindStrategy, SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION, SessionEventType, createCoreError, createMessageId, createPartId, createSessionId, traceContextToLogContext } from "../deps.js";
import type { GoalStatus, MessageId, SessionEntryInfo, TargetCompletionVerificationPayload, MessageWithParts, SessionId, SessionInfo, SessionStorePort, TraceContext } from "../deps.js";
import { formatConversationForkNoticeBody } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

import type { StableConversationForkChildMetadata, StableConversationForkGoalBoundary, StableConversationForkOptions, ConversationBeforeInputForkOptions, StableConversationForkTarget, WorkspaceForkResult } from "../types.js";



import {
  stableForkError,
  buildForkedSessionInput,
  forkSourceMessagesForSession,
  asRecord,
  findCompactedForkParentUserMessage,
} from "./session-fork-basis.js";
import {
  commitAtomicConversationFork,
} from "./session-fork-side-chat.js";

/** Точки входа fork: сессия, сообщение, stable/goal-состояние, история транскрипта. */

export async function createForkedSession(
  runtime: AgentRuntimeInternal,
  options: {
    parentSession: SessionInfo;
    forkedSessionId?: SessionId;
    stableForkMetadata?: StableConversationForkChildMetadata;
  },
): Promise<SessionId> {
  if (!runtime.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const forkedSessionId = options.forkedSessionId ?? createSessionId();
  const input = buildForkedSessionInput(runtime, options.parentSession, forkedSessionId);
  // legacy workspace fork 兼容分支。V4 stable/compact-edit 入口直接构建完整 bundle，
  // 不得经过这里的 child-only metadata 原语，否则会重新引入逐条补写窗口。
  if (options.stableForkMetadata) {
    if (!runtime.sessionStore.createForkedSessionWithMetadata) {
      throw stableForkError("Stable fork requires atomic child metadata persistence", {
        forkedSessionId,
        sourceCommandId: options.stableForkMetadata.sourceCommandId,
      });
    }
    const persisted = await runtime.sessionStore.createForkedSessionWithMetadata(
      input,
      options.stableForkMetadata,
    );
    return persisted.id;
  } else {
    await runtime.sessionStore.createSession(input);
  }

  await runtime.sessionStore.saveSessionEntry?.(
    buildExecutionStateEntry(forkedSessionId, readRuntimeExecutionState(runtime)),
  );
  return forkedSessionId;
}

/** legacy workspace/checkpoint fork；V4 stable 与 compact-edit 禁止调用。 */
export async function forkConversationFromMessage(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId?: SessionId;
    targetMessageId: MessageId;
    traceContext: TraceContext;
    beforeTarget?: true;
  },
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  // fork 会在编辑重发和压缩后发生，复制源必须是 UI transcript 语义。
  // activeSessionMessages 是模型恢复语义，会按 compact boundary 截掉旧 worklog；
  // fork child 需要保留 fork 点前可见历史，但仍要排除 rewind/edit 后的旧分支。
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    throw stableForkError(
      `Fork target message not found in session store: ${options.targetMessageId}`,
      { messageId: options.targetMessageId },
    );
  }

  const legacyForkHistoryEndIndex = resolveForkHistoryEndIndex(
    forkSourceMessages,
    targetIndex,
    true,
  );
  const forkHistoryMessages = options.beforeTarget
    ? conversationHistoryBeforeInput(forkSourceMessages, options.targetMessageId)
    : buildForkHistoryMessages(
        parentMessages,
        forkSourceMessages,
        targetIndex,
        legacyForkHistoryEndIndex,
      );

  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
  });
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext: options.traceContext,
  });
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext: options.traceContext,
  });
  // 纯对话 fork 没有 workspace checkpoint，但 UI 仍需要一条结构化 fork notice 渲染分割线。
  // 之前只复制历史消息，导致 forked session 首屏看不到来源边界。
  const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);
  const forkTimelineCreated = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(options.targetMessageId)}_timeline`,
    ),
    parentID: copiedTargetMessageId,
    created: forkTimelineCreated,
    completed: forkTimelineCreated,
    finish: "completed",
    timeline: {
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
      anchorMessageId: copiedTargetMessageId,
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
      restoredFileCount: 0,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext: options.traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatConversationForkNoticeBody({
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: options.targetMessageId,
        restoredFileCount: 0,
      },
    },
    traceContext: options.traceContext,
  });
  this.logger?.debug("Conversation fork notice persisted", {
    ...traceContextToLogContext(options.traceContext),
    event: "session.fork.notice.persisted",
    forkedSessionId,
    module: "core.runtime",
    parentSessionId: this.sessionId,
    status: "completed",
    targetMessageId: options.targetMessageId,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: legacyForkHistoryEndIndex,
      targetMessageId: options.targetMessageId,
      restoredFileCount: 0,
      strategy: RewindStrategy.ForkRequired,
    },
    options.traceContext,
  );
  await this.appendEvent(forkedEvent, options.traceContext);

  return {
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles: [],
    response: `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${copiedMessageCount} messages.`,
  };
}

/** V4 running stable fork 公共入口：纯 transcript copy，不读取/恢复 workspace checkpoint。 */
export async function forkStableConversationAtMessage(
  this: AgentRuntimeInternal,
  options: StableConversationForkOptions,
): Promise<WorkspaceForkResult> {
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Stable fork sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const history = stableForkHistoryMessages(activeMessages, options.target);
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    target: options.target,
    targetMessageId: options.target.boundaryMessageId as MessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

/** compact-covered edit：复制目标真实用户输入之前的 active conversation prefix。 */
export async function forkConversationBeforeMessage(
  this: AgentRuntimeInternal,
  options: ConversationBeforeInputForkOptions,
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Fork requires a session adapter");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const prefix = conversationHistoryBeforeInput(activeMessages, options.targetMessageId);
  return await commitAtomicConversationFork(this, {
    commandFact: options.commandFact,
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    initialInput: options.initialInput,
    messages: prefix,
    parentSession,
    sourceCommandId: options.sourceCommandId,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

export function conversationHistoryBeforeInput(
  activeMessages: readonly MessageWithParts[],
  targetMessageId: MessageId,
): MessageWithParts[] {
  const targetIndex = activeMessages.findIndex((message) => message.info.id === targetMessageId);
  if (targetIndex < 0) {
    throw stableForkError(`Fork target input not found: ${targetMessageId}`, {
      targetMessageId,
    });
  }
  const target = activeMessages[targetIndex];
  if (target?.info.role !== "user") {
    throw stableForkError("Fork-before-input target is not a user message", {
      targetMessageId,
    });
  }
  return activeMessages.slice(0, targetIndex);
}

/**
 * stable resolver 已给出目标 product turn 的唯一 segment。core 保留 segment 起点前
 * 的 active transcript 前缀，并要求 ordered ids 在 active branch 中严格连续；不再按
 * parentID 或“同一 assistant turn”向 boundary 后扩张。
 */
export function stableForkHistoryMessages(
  activeMessages: readonly MessageWithParts[],
  target: StableConversationForkTarget,
): MessageWithParts[] {
  if (
    target.orderedMessageIds.length === 0 ||
    target.orderedMessageIds.at(-1) !== target.boundaryMessageId
  ) {
    throw stableForkError("Stable fork target has an invalid boundary", {
      boundaryMessageId: target.boundaryMessageId,
    });
  }
  if (new Set(target.orderedMessageIds).size !== target.orderedMessageIds.length) {
    throw stableForkError("Stable fork target contains duplicate message ids");
  }

  const indexById = new Map(
    activeMessages.map((message, index) => [String(message.info.id), index]),
  );
  const segmentStartIndex = indexById.get(target.orderedMessageIds[0]!);
  if (segmentStartIndex === undefined) {
    throw stableForkError("Stable fork target is not an active transcript segment", {
      messageId: target.orderedMessageIds[0],
    });
  }
  for (const [offset, messageId] of target.orderedMessageIds.entries()) {
    const actual = activeMessages[segmentStartIndex + offset];
    if (String(actual?.info.id) !== messageId) {
      throw stableForkError("Stable fork target is not a contiguous active transcript segment", {
        messageId,
      });
    }
  }
  const selectedSegment = activeMessages.slice(
    segmentStartIndex,
    segmentStartIndex + target.orderedMessageIds.length,
  );
  const boundary = selectedSegment.at(-1);
  if (boundary?.info.role !== "assistant" || boundary.info.error) {
    throw stableForkError("Stable fork boundary is not a completed assistant message", {
      boundaryMessageId: target.boundaryMessageId,
    });
  }
  return [...activeMessages.slice(0, segmentStartIndex), ...selectedSegment];
}

export async function copyGoalStateForFork(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId: SessionId;
    goalBoundary?: StableConversationForkGoalBoundary;
    messageIdMap: Map<MessageId, MessageId>;
    traceContext: TraceContext;
  },
): Promise<void> {
  const sessionStore = this.sessionStore;
  if (!sessionStore?.cloneTargetForFork) {
    return;
  }

  if (options.goalBoundary?.kind === "none") {
    return;
  }

  const parentTarget =
    options.goalBoundary?.kind === "snapshot"
      ? options.goalBoundary.target
      : await sessionStore.readTarget({ sessionID: this.sessionId });
  if (!parentTarget) return;
  if (
    options.goalBoundary?.kind === "snapshot" &&
    String(parentTarget.sessionID) !== String(this.sessionId)
  ) {
    throw stableForkError("Stable fork goal snapshot belongs to another session", {
      goalSessionId: parentTarget.sessionID,
      parentSessionId: this.sessionId,
    });
  }

  const copiedVerificationPayloads = await copyGoalVerificationEntriesForFork(sessionStore, {
    forkedSessionId: options.forkedSessionId,
    messageIdMap: options.messageIdMap,
    parentSessionId: this.sessionId,
    parentTargetId: parentTarget.targetID,
    ...(options.goalBoundary?.kind === "snapshot"
      ? {
          verificationEntryIds: new Set(options.goalBoundary.verificationEntryIds),
        }
      : {}),
  });
  const forkedStatus =
    options.goalBoundary?.kind === "snapshot"
      ? parentTarget.status
      : deriveForkedGoalStatusFromCopiedVerifications(
          parentTarget.status,
          copiedVerificationPayloads,
        );
  await sessionStore.cloneTargetForFork({
    sessionID: options.forkedSessionId,
    source: parentTarget,
    status: forkedStatus,
  });

  this.logger?.debug("Forked session goal state copied", {
    ...traceContextToLogContext(options.traceContext),
    copiedGoalVerificationCount: copiedVerificationPayloads.length,
    event: "session.fork.goal_state.copied",
    forkedSessionId: options.forkedSessionId,
    module: "core.runtime",
    parentSessionId: this.sessionId,
    targetId: parentTarget.targetID,
  });
}

export async function copyGoalVerificationEntriesForFork(
  sessionStore: SessionStorePort,
  options: {
    forkedSessionId: SessionId;
    messageIdMap: Map<MessageId, MessageId>;
    parentSessionId: SessionId;
    parentTargetId: string;
    verificationEntryIds?: ReadonlySet<string>;
  },
): Promise<TargetCompletionVerificationPayload[]> {
  if (!sessionStore.sessionEntries || !sessionStore.saveSessionEntry) {
    if (options.verificationEntryIds?.size) {
      throw stableForkError("Stable fork verifier boundary cannot be loaded", {
        verificationEntryIds: [...options.verificationEntryIds],
      });
    }
    return [];
  }

  const parentEntries = await sessionStore.sessionEntries({
    sessionID: options.parentSessionId,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  const copiedPayloads: TargetCompletionVerificationPayload[] = [];
  const remainingEntryIds = options.verificationEntryIds
    ? new Set(options.verificationEntryIds)
    : null;
  for (const parentEntry of parentEntries) {
    if (options.verificationEntryIds && !options.verificationEntryIds.has(parentEntry.id)) {
      continue;
    }
    remainingEntryIds?.delete(parentEntry.id);
    const cloned = cloneGoalVerificationEntryForFork(parentEntry, options);
    if (!cloned) {
      if (options.verificationEntryIds) {
        throw stableForkError("Stable fork verifier is outside the fixed transcript cut", {
          verificationEntryId: parentEntry.id,
        });
      }
      continue;
    }
    await sessionStore.saveSessionEntry(cloned.entry);
    copiedPayloads.push(cloned.payload);
  }
  if (remainingEntryIds?.size) {
    throw stableForkError("Stable fork verifier boundary references missing entries", {
      verificationEntryIds: [...remainingEntryIds],
    });
  }
  return copiedPayloads;
}

export function cloneGoalVerificationEntryForFork(
  entry: SessionEntryInfo,
  options: {
    forkedSessionId: SessionId;
    messageIdMap: Map<MessageId, MessageId>;
    parentTargetId: string;
  },
): { entry: SessionEntryInfo; payload: TargetCompletionVerificationPayload } | null {
  const data = asRecord(entry.data);
  const payload = asRecord(data.payload);
  if (payload.targetId !== options.parentTargetId) {
    return null;
  }
  const anchorAssistantMessageId =
    typeof payload.anchorAssistantMessageId === "string"
      ? (payload.anchorAssistantMessageId as MessageId)
      : null;
  // anchor 在场但不在 messageIdMap = 被验证的 assistant 在 fork 点之后（未复制）：
  // 这是 fork 历史边界过滤，正确跳过——child 只继承 fork 点前的 verifier timeline。
  if (anchorAssistantMessageId && !options.messageIdMap.has(anchorAssistantMessageId)) {
    return null;
  }
  const childAnchorAssistantMessageId = anchorAssistantMessageId
    ? options.messageIdMap.get(anchorAssistantMessageId)
    : undefined;

  // legacy entry 无 anchor 时不再整条静默跳过——verifier
  // 事实仍复制（无法按 anchor 判边界，宁可保留供溯源），本地 anchor 缺省、读取端
  // 按「无 anchor 落已知末尾」处理。anchorTurnId 指向父 runtime turn（child 不存在
  // 该轮），恒降级 originAnchorTurnId。
  const clonedPayloadRecord: Record<string, unknown> = { ...payload };
  if (childAnchorAssistantMessageId) {
    clonedPayloadRecord.anchorAssistantMessageId = childAnchorAssistantMessageId;
  }
  if (typeof payload.anchorTurnId === "string") {
    delete clonedPayloadRecord.anchorTurnId;
    clonedPayloadRecord.originAnchorTurnId = payload.anchorTurnId;
  }
  const clonedPayload = clonedPayloadRecord as unknown as TargetCompletionVerificationPayload;
  const eventId = randomUUID();
  return {
    entry: {
      ...entry,
      id: `fork_goal_verify_${eventId}`,
      sessionID: options.forkedSessionId,
      // verifier entry 是 goal iteration 的持久边界；fork 后必须复制到
      // child session，并把 anchor assistant 改写为 child message id，避免 UI 恢复时丢分割线。
      data: {
        ...data,
        eventId,
        payload: clonedPayload,
      },
    },
    payload: clonedPayload,
  };
}

export function deriveForkedGoalStatusFromCopiedVerifications(
  parentStatus: GoalStatus,
  copiedVerificationPayloads: readonly TargetCompletionVerificationPayload[],
): GoalStatus {
  const latestCompleted = [...copiedVerificationPayloads]
    .reverse()
    .find((payload) => payload.status === "completed" && payload.verification);
  if (latestCompleted?.verification?.passed === true) {
    return "complete";
  }
  if (parentStatus === "complete") {
    return "active";
  }
  return parentStatus;
}




export function resolveForkHistoryEndIndex(
  messages: MessageWithParts[],
  targetIndex: number,
  expandAssistantTurn: boolean,
): number {
  const target = messages[targetIndex];
  if (!expandAssistantTurn || target?.info.role !== "assistant") {
    return targetIndex + 1;
  }

  const parentId = target.info.parentID;
  let endIndex = targetIndex + 1;
  for (let index = targetIndex + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.info.role !== "assistant" || message.info.parentID !== parentId) {
      break;
    }
    endIndex = index + 1;
  }
  return endIndex;
}




export function buildForkHistoryMessages(
  parentMessages: MessageWithParts[],
  forkSourceMessages: MessageWithParts[],
  targetIndex: number,
  forkHistoryEndIndex: number,
): MessageWithParts[] {
  const forkHistoryMessages = forkSourceMessages.slice(0, forkHistoryEndIndex);
  const compactedParentUserMessage = findCompactedForkParentUserMessage(
    parentMessages,
    forkHistoryMessages,
    forkSourceMessages[targetIndex],
  );
  if (!compactedParentUserMessage) {
    return forkHistoryMessages;
  }

  // compact 后 active branch 只剩 summary user + assistant，summary 会被 UI 过滤。
  // fork 到该 assistant 时仍要把它 parentID 指向的真实用户输入放回 compact boundary 前，
  // 这样历史可见气泡不丢，同时 resume 仍从最后一个 compact boundary 开始，不改变模型上下文。
  return [compactedParentUserMessage, ...forkHistoryMessages];
}
