import type { RuntimeInputPresentation } from "@zcode/contracts";
import { createModelId, createModelProviderId } from "@zcode/contracts";
import {
  SessionEventType,
  createMessageId,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import type {
  EnvInfo,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageVisibility,
  Model,
  SessionId,
  SessionProjection,
  SessionStorePort,
  TraceContext,
  TurnId,
  SyntheticUserMessageSource,
  TurnInputIntentMetadata,
  TurnExecutionKind,
} from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import { calculateRuntimeModelCost } from "../helpers/model-cost.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildSyntheticUserNoticeMessageMetadata,
  buildSyntheticUserNoticePartMetadata,
  buildSyntheticUserNoticeSemantics,
} from "./synthetic-notice-metadata.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import { getMetadataTools } from "./config.js";
import { buildProjectionAnchor, mapSyntheticSourceToAnchorOrigin } from "./projection-anchor.js";

export async function persistUserPrompt(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  input: string,
  attachments: ResolvedTurnAttachment[] | undefined,
  traceContext: TraceContext,
  options?: {
    /**
     * drain 注入的输入把投递语义落到持久事实（metadata.turnSteerDelivery），
     * 冷恢复据此还原「queue=独立轮 / guide=内联当前轮」的切分，与 live 结构一致。
     */
    steerDelivery?: "guide" | "queue";
    inputPresentation?: RuntimeInputPresentation;
    /**
     * （promotion 原子性）：给定账本 id 且 store 支持时，账本置 promoted
     * 与 message/parts 持久化走同一事务——杜绝「queue 已消费但 transcript 无
     * user message」的孤儿窗口（旧 drain 跨 store 无事务）。
     */
    sessionInputId?: string;
    /** V4 command 幂等锚点；必须来自 CLI admission，不能在 drain 时换新 id。 */
    sourceCommandId?: string;
    clientId?: string;
    intent?: TurnInputIntentMetadata;
    /** 冷恢复所需的执行语义；不能只存在于 live TurnStarted。 */
    executionKind?: TurnExecutionKind;
    /** 引擎附加文本的起点；同样为冷恢复而存。 */
    epilogueStart?: number;
  },
): Promise<void> {
  this.latestConversationMessageId = messageID;
  if (!this.sessionStore) return;

  const created = Date.now();
  // 用户消息的 tools 映射是持久化元数据，不是 provider 能力声明；该入口没有本轮 Model，
  // 未知能力下不能把条件工具 WebSearch 写成可用。
  const tools = Object.fromEntries(getMetadataTools.call(this).map((tool) => [tool.name, true]));
  const conversationInputIntent = buildPersistedConversationInputIntent(
    input,
    options?.intent,
    "drained",
  );
  const message: Parameters<SessionStorePort["saveMessage"]>[0] = {
    id: messageID,
    sessionID: this.sessionId,
    role: "user",
    time: {
      created,
    },
    agent: this.config.agentName ?? "zcode-agent",
    modelSelection: this.getSessionModelSelection(),
    contextSnapshot: buildPersistedContextSnapshot(this.config.envInfo),
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
    anchor: buildProjectionAnchor(
      traceContext,
      "realUser",
      options?.intent?.sourceCommandId ?? options?.sourceCommandId,
    ),
    system: this.config.systemPrompt,
    tools,
    ...(options?.inputPresentation ||
    options?.steerDelivery ||
    options?.clientId ||
    options?.intent ||
    options?.executionKind ||
    options?.epilogueStart !== undefined
      ? {
          metadata: {
            ...(options?.steerDelivery ? { turnSteerDelivery: options.steerDelivery } : {}),
            ...(options?.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
            ...(options?.intent ? { inputIntent: options.intent } : {}),
            ...(conversationInputIntent ? { conversationInputIntent } : {}),
            ...((options?.intent?.clientId ?? options?.clientId)
              ? { inputClientId: options?.intent?.clientId ?? options?.clientId }
              : {}),
            ...(options?.executionKind ? { executionKind: options.executionKind } : {}),
            ...(options?.intent?.highspeed ? { highspeed: options.intent.highspeed } : {}),
            ...(options?.epilogueStart === undefined
              ? {}
              : { epilogueStart: options.epilogueStart }),
          },
        }
      : {}),
  };
  const parts: MessagePart[] = [
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID,
      type: "text",
      text: withConversationQuotes(
        input,
        options?.intent?.conversationQuotes,
        options?.intent?.botGroupSource,
      ),
      time: {
        start: created,
        end: created,
      },
    },
    ...(attachments ?? []).map(
      (attachment): MessagePart => ({
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "file",
        mime: attachment.mime,
        filename: attachment.filename,
        url: attachment.url,
        source: attachment.source,
        metadata: attachment.metadata,
      }),
    ),
  ];

  if (options?.sessionInputId && this.sessionStore.promoteSessionInput) {
    await this.sessionStore.promoteSessionInput({
      id: options.sessionInputId,
      sessionID: this.sessionId,
      message,
      parts,
    });
    this.logger?.debug("Session input promoted", {
      ...traceContextToLogContext(traceContext),
      event: "session_input.promoted",
      messageId: messageID,
      module: "core.runtime",
      sessionInputId: options.sessionInputId,
      status: "completed",
    });
    const sourceCommandId =
      options.intent?.sourceCommandId ?? options.sourceCommandId ?? options.sessionInputId;
    // promotion 事务提交后再发事件：gateway 只能在此边界解除 live-input pin。
    // 若在 queue remove/TurnStarted 就解除，LRU churn 会在 transcript 尚未落盘时把
    // commands/query 退化成 unknown，重复执行同一输入。
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionInputPromoted,
        {
          pendingInputId: options.sessionInputId,
          sourceCommandId,
          messageId: messageID,
        },
        traceContext,
      ),
      traceContext,
    );
    return;
  }

  await this.persistMessage(message, traceContext);
  for (const part of parts) {
    await this.persistPart(part, traceContext);
  }
}

export async function persistSyntheticUserNotice(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "rewind",
    text,
    traceContext,
  });
}

export async function persistSyntheticUserNoticeForSession(
  this: AgentRuntimeInternal,
  options: {
    messageID: MessageId;
    sessionId: SessionId;
    source: SyntheticUserMessageSource;
    text: string;
    traceContext: TraceContext;
    /** 额外结构化 metadata，会与 `{ source }` 合并写到 part.metadata 上，供 UI 识别消息类型。 */
    metadata?: Record<string, unknown>;
    visibility?: MessageVisibility;
  },
): Promise<void> {
  if (options.sessionId === this.sessionId) {
    this.latestConversationMessageId = options.messageID;
  }
  if (!this.sessionStore) return;

  const created = Date.now();
  const visibility = options.visibility ?? "model-only";
  const messageMetadata = buildSyntheticUserNoticeMessageMetadata(
    options.source,
    visibility,
    options.metadata,
  );
  const partMetadata = buildSyntheticUserNoticePartMetadata(
    options.source,
    visibility,
    options.metadata,
  );
  await this.persistMessage(
    {
      id: options.messageID,
      sessionID: options.sessionId,
      role: "user",
      time: {
        created,
      },
      agent: this.config.agentName ?? "zcode-agent",
      metadata: messageMetadata,
      modelSelection: this.getSessionModelSelection(),
      semantics: buildSyntheticUserNoticeSemantics(options.source, visibility),
      anchor: buildProjectionAnchor(
        options.traceContext,
        mapSyntheticSourceToAnchorOrigin(options.source),
      ),
      source: options.source,
      system: this.config.systemPrompt,
      synthetic: true,
      // 同上：synthetic notice 也没有本轮 Model，条件工具按不可用处理。
      tools: Object.fromEntries(getMetadataTools.call(this).map((tool) => [tool.name, true])),
      visibility,
    },
    options.traceContext,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: options.sessionId,
      messageID: options.messageID,
      type: "text",
      text: options.text,
      synthetic: true,
      time: {
        start: created,
        end: created,
      },
      metadata: partMetadata,
    },
    options.traceContext,
  );
}

export async function persistAssistantMessage(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  parentID: MessageId,
  created: number,
  update:
    | {
        completed?: number;
        error?: { name: string; data?: Record<string, unknown> };
        finish?: string;
        finishReason?: string;
        rawFinishReason?: string;
        stepDiagnostics?: import("@zcode/contracts").PersistedStepDiagnostics;
        tokens?: ReturnType<typeof toTokenUsageInfo>;
      }
    | undefined,
  traceContext: TraceContext,
  /**
   * `null` marks a synthetic answer with no model attribution; `undefined` keeps the legacy
   * session-selection fallback; a value attributes the message to that provider/model.
   */
  model?: Pick<Model, "providerId" | "modelId"> | null,
): Promise<void> {
  this.latestConversationMessageId = messageID;
  this.latestAssistantMessageId = messageID;
  if (traceContext.turnId) {
    this.latestAssistantTurnId = traceContext.turnId;
  }
  if (!this.sessionStore) return;
  const selection = this.getSessionModelSelection();
  const providerId =
    model === null
      ? undefined
      : (model?.providerId ?? (selection && createModelProviderId(selection.providerId)));
  const modelId =
    model === null
      ? undefined
      : (model?.modelId ?? (selection && createModelId(selection.modelId)));
  const tokens = update?.tokens ?? emptyTokenUsageInfo();
  // 成本只在消息写入路径计算一次；step-finish 与 assistant message 共用同一价格函数。
  const cost = calculateRuntimeModelCost(modelId, update?.tokens);

  await this.persistMessage(
    {
      id: messageID,
      sessionID: this.sessionId,
      role: "assistant",
      time: {
        created,
        completed: update?.completed,
      },
      error: update?.error,
      parentID,
      // 默认模型可能在请求进行中切换；模型请求路径必须显式传入生成这条
      // 消息的模型。默认值只保留给不经过模型结果的既有 synthetic/fallback 路径。
      modelId,
      providerId,
      mode: this.config.mode ?? "build",
      planEnabled: this.getPlanEnabled(),
      agent: this.config.agentName ?? "zcode-agent",
      path: {
        cwd: this.workingDirectory,
        // cwd 可随 Bash cd 变化，root 必须保留会话初始工作区身份。
        root: this.workspaceRoot,
      },
      cost,
      tokens,
      finish: update?.finish,
      ...(update?.finishReason ?? update?.finish
        ? { finishReason: update?.finishReason ?? update?.finish }
        : {}),
      ...(update?.rawFinishReason ? { rawFinishReason: update.rawFinishReason } : {}),
      ...(update?.stepDiagnostics?.rawTruncatedInputPreview
        ? { rawTruncatedInputPreview: update.stepDiagnostics.rawTruncatedInputPreview }
        : {}),
      ...(update?.stepDiagnostics?.repairAttempts &&
      update.stepDiagnostics.repairAttempts.length > 0
        ? { repairAttempts: update.stepDiagnostics.repairAttempts }
        : {}),
      ...(update?.stepDiagnostics?.stateTransitions &&
      update.stepDiagnostics.stateTransitions.length > 0
        ? { stateTransitions: update.stepDiagnostics.stateTransitions }
        : {}),
      ...(update?.stepDiagnostics ? { stepDiagnostics: update.stepDiagnostics } : {}),
      semantics: {
        origin: "agent_runtime",
        kind: "assistant_response",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
      anchor: buildProjectionAnchor(traceContext),
    },
    traceContext,
  );
}

export async function persistMessage(
  this: AgentRuntimeInternal,
  input: Parameters<SessionStorePort["saveMessage"]>[0],
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.saveMessage(input, copyFrom);
  this.logger?.debug("Session message persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.message.persisted",
    messageId: input.id,
    module: "core.runtime",
    role: input.role,
    status: "completed",
  });
}

/**
 * 受限终态的 durable 标记（docs/specs/max-turns-limit.md）。
 *
 * cold hydration 的 turn 状态来自 transcript 而非 live TurnComplete，因此必须把
 * `metadata.turnResult` 写到本 turn 的最终 assistant 消息上，否则重启后受限 turn 会被
 * 重建为 success。这里刻意不用 `assistant.error`：带 error 的消息会被排除在 compact
 * preserved segment 与 stable-fork boundary 之外，已生成的正文会丢失。
 *
 * 修复原因：runtime 全局 `latestAssistantMessageId` 是跨 turn 指针，空 length 步骤被
 * `persistCompletedAssistantStep` 回滚后它仍指向上一个 turn 的 assistant，旧实现会把
 * `error_max_turns` 写进别人的 turn。锚点必须按 `anchor.turnId` 在本 turn 内查找；
 * 当前 turn 没有任何可标记 assistant 时，写一个空的 technical anchor，而不是越界写入。
 * 写入失败只降级 cold 路径到旧行为，不把 live 终态改成 success。
 */
function isTurnAssistantBoundary(
  info: MessageInfo,
  turnId: TurnId,
): info is Extract<MessageInfo, { role: "assistant" }> {
  return (
    info.role === "assistant" &&
    info.anchor?.turnId === turnId &&
    info.time.completed !== undefined &&
    info.error === undefined
  );
}

export async function persistTurnResultMarker(
  this: AgentRuntimeInternal,
  input: {
    historyRoundCount?: number;
    model?: Model;
    parentMessageId: MessageId;
    resultType: "error_max_turns";
    traceContext: TraceContext;
    turnId: TurnId;
  },
): Promise<void> {
  if (!this.sessionStore) return;
  const store = this.sessionStore;
  try {
    const findBoundary = async () => {
      const messages = await store.messages({ sessionID: this.sessionId });
      return messages
        .filter((message) => isTurnAssistantBoundary(message.info, input.turnId))
        .at(-1)?.info;
    };
    let boundary = await findBoundary();
    if (!boundary) {
      // 空 length 步骤没有可标记的 assistant：创建最小技术锚点，让冷恢复仍能看到本 turn
      // 的受限终态。空文本/零 usage/无 finish 不会进入 provider 历史，也不会伪造 Continue。
      const messageId = createMessageId();
      const createdAt = Date.now();
      await this.persistAssistantMessage(
        messageId,
        input.parentMessageId,
        createdAt,
        { completed: createdAt },
        input.traceContext,
        input.model,
      );
      this.logger?.info("Persisted max turns technical assistant anchor", {
        ...traceContextToLogContext(input.traceContext),
        event: "turn.max_turns.anchor_persisted",
        messageId,
        module: "core.runtime",
        status: "completed",
      });
      boundary = await findBoundary();
    }
    // fail-closed：锚点必须仍属于当前 turn；不匹配时宁可不写，也不能污染其它 turn。
    if (!boundary || !isTurnAssistantBoundary(boundary, input.turnId)) {
      this.logger?.warn("Skipped max turns marker without a turn-scoped assistant anchor", {
        ...traceContextToLogContext(input.traceContext),
        event: "turn.max_turns.marker_anchor_mismatch",
        module: "core.runtime",
        status: "failed",
      });
      return;
    }
    const anchor =
      input.historyRoundCount === undefined
        ? boundary.anchor
        : {
            ...boundary.anchor,
            turnId: input.turnId,
            historyRoundCount: input.historyRoundCount,
          };
    await this.persistMessage(
      {
        ...boundary,
        anchor,
        metadata: { ...boundary.metadata, turnResult: input.resultType },
      },
      input.traceContext,
    );
  } catch (error) {
    this.logger?.warn("Failed to persist max turns marker", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "turn.max_turns.marker_persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function persistPart(
  this: AgentRuntimeInternal,
  input: MessagePart,
  traceContext: TraceContext,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  if (!this.sessionStore) return;
  await this.sessionStore.savePart(input, copyFrom);
  this.logger?.debug("Session part persisted", {
    ...traceContextToLogContext(traceContext),
    event: "session.part.persisted",
    messageId: input.messageID,
    module: "core.runtime",
    partId: input.id,
    partType: input.type,
    status: "completed",
  });
}

function buildPersistedContextSnapshot(envInfo: EnvInfo | undefined):
  | {
      envInfo: EnvInfo;
    }
  | undefined {
  if (!envInfo) {
    return undefined;
  }

  return { envInfo: { ...envInfo } };
}

export async function rebuildProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  const events = await this.eventStore.getEvents(this.sessionId);
  return this.eventReducer.reduce(events);
}
