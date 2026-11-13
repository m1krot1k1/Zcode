// ProductProjection 域模块：onTurnStarted, applyBackgroundTaskNotification, onTurnComplete, leaveDraftAfterControlOnlyTurn 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type { SessionEvent, TurnCompletePayload, TurnErrorPayload } from "@zcode/contracts";
import {
  parseZCodeBackgroundTaskNotificationText,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
} from "@zcode/shared";
import type {
  ConversationDelta,
  GoalState,
  SessionControl,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { type CanonicalUserIntentFact } from "./event-normalizer.js";
import {
  buildToolOutput,
  buildTurnHeaderRow,
  classifyTurnInterruptReason,
  mapTurnResultToHeaderState,
} from "./projection-rows.js";
import { LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK } from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function onTurnStarted(
  self: ProductProjectionContext,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const event = fact.event;
  const runtimeTurnId = fact.runtimeTurnId;
  const turnId = fact.productTurnId;
  self.currentTurnId = runtimeTurnId;
  self.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
  // 新 runtimeTurn：product turn 映射归零（1:1），工时基准 = 本轮起点。
  self.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
  if (turnId !== runtimeTurnId) self.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
  self.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
  self.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
  self.currentProductTurnStartedAtMs = self.ms(event);
  self.streamingTextRowId = null;
  self.streamingReasoningRowId = null;
  self.outputContinuationTextRowId = null;

  // background Agent 的 ToolCallResult 只是 launch ACK，先把工具行收口成
  // success；子 Agent 的真实终态随后只作为 model-only task-notification 开新轮。
  // V4 过去没有按 tool-use-id 消费这条权威事实，因此 429 后卡片会永久停在 completed。
  const deltas: ConversationDelta[] = self.applyBackgroundTaskNotification(fact);
  const sharedContextRef = fact.sharedContextRefs?.[0];
  if (
    sharedContextRef &&
    self.snapshot.sharedContextImport &&
    "contextId" in self.snapshot.sharedContextImport &&
    self.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
    (self.snapshot.sharedContextImport.status === "pending" ||
      self.snapshot.sharedContextImport.status === "reserved")
  ) {
    const sharedContextImport = {
      ...self.snapshot.sharedContextImport,
      status: "attached" as const,
    };
    self.snapshot = { ...self.snapshot, sharedContextImport };
    deltas.push({ op: "state.updated", patch: { sharedContextImport } });
  }
  // marker 时机：只有当
  // 本轮实际使用的 provider/model 身份与上一轮不同时，才在 turnHeader 之前落
  // modelChange marker。普通首轮 silentInitial 不产 marker；显式 sourceLess 边界
  // 生成“正在使用”marker。思考深度变化只更新 config.thought，不是模型身份变化。
  // Bug 背景：旧实现在 onModelSelected（切换动作时）即落 marker，草稿态预热会话
  // 切一次模型就会在首条消息上方挂出 [modelChange]。
  const config = self.snapshot.config;
  const hasModel = config.provider !== "" && config.model !== "";
  if (hasModel && self.lastTurnModel.kind === "sourceLess") {
    deltas.push({
      op: "row.appended",
      row: {
        ...self.rowBase(
          event,
          turnId,
          `model-initial:${turnId}:${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  } else if (
    hasModel &&
    self.lastTurnModel.kind === "known" &&
    (self.lastTurnModel.provider !== config.provider || self.lastTurnModel.model !== config.model)
  ) {
    deltas.push({
      op: "row.appended",
      row: {
        ...self.rowBase(
          event,
          turnId,
          `model-change:${turnId}:${self.lastTurnModel.provider}/${self.lastTurnModel.model}->${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        // lane 由投影裁决（UI 不得按 marker type 自行推断落位语义）。
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          fromProvider: self.lastTurnModel.provider,
          fromModel: self.lastTurnModel.model,
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  }
  if (hasModel) {
    self.lastTurnModel = {
      kind: "known",
      provider: config.provider,
      model: config.model,
      thought: config.thought,
    };
  }
  const headerBase = self.rowBase(event, turnId, turnId);
  const header: TurnHeaderRow = {
    ...headerBase,
    kind: "turnHeader",
    origin: fact.turnHeaderOrigin,
    executionKind: fact.executionKind,
    ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
    ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
    ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
    state: "running",
    startedAt: headerBase.createdAt,
  };
  self.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });

  // model-only 输入（goal continuation 等）不产生可见 userInput row。
  if (fact.visibility === "visible") {
    const rowBase = self.rowBase(event, turnId, fact.entityId);
    const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
    const attachments = fact.attachments?.map((attachment, index) => ({
      ...attachment,
      ref: attachment.ref ?? `turn-attachment/${rowBase.rowId}/${index}`,
    }));
    const row: UserInputRow = {
      ...rowBase,
      kind: "userInput",
      text:
        fact.conversationQuotes || fact.botGroupSource
          ? (fact.intentText ?? fact.input)
          : fact.input,
      origin: fact.origin,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
      ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
      ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
      ...(fact.clientId ? { clientId: fact.clientId } : {}),
      ...(fact.highspeed ? { highspeed: fact.highspeed } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(fact.source ? { source: fact.source } : {}),
    };
    // workspace checkpoint 以 user messageId 为 targetMessageId。
    // 普通 TurnStarted 也要登记 userInput row 的内部锚点，否则文件摘要 query
    // 只能找到 assistant messageId，展开列表会查不到该轮 checkpoint。
    self.registerCanonicalUserRowTarget(
      row.rowId,
      fact.entityId,
      fact.transcriptMessageId
        ? {
            entityId: fact.entityId,
            productTurnId: fact.productTurnId,
            transcriptMessageId: fact.transcriptMessageId,
            coveredByStableCompact: false,
            intent: {
              kind: fact.intentKind,
              text: fact.intentText,
              executionRoute: fact.executionRoute ?? { kind: "zcode" },
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              ...(fact.inputOrigin ? { inputOrigin: fact.inputOrigin } : {}),
              ...(fact.conversationQuotes ? { conversationQuotes: fact.conversationQuotes } : {}),
              ...(fact.botGroupSource ? { botGroupSource: fact.botGroupSource } : {}),
              ...(fact.clientId ? { clientId: fact.clientId } : {}),
              ...(fact.attachments ? { attachments: fact.attachments } : {}),
              ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
              ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
              ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
              ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
              ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
              ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
              ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
              ...(fact.mode ? { mode: fact.mode } : {}),
              ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
              ...(fact.orchestrationMode ? { orchestrationMode: fact.orchestrationMode } : {}),
              ...(fact.provenance ? { provenance: fact.provenance } : {}),
            },
          }
        : undefined,
    );
    deltas.push({
      op: "row.appended",
      row,
    });
  }

  if (fact.executionKind === "agent") {
    deltas.push({
      op: "state.updated",
      patch: self.controlPatch({
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [
          {
            kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
            ...(fact.foregroundExecutionId
              ? { foregroundExecutionId: fact.foregroundExecutionId }
              : {}),
            // 自动中断必须关联实际执行输入，不能由客户端按最后一条消息猜测。
            ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
            startedAt: self.ms(event),
          },
        ],
        // 新一轮被接受后，旧错误不再是当前事实（与旧 reducer 同一裁决）。
        lastError: null,
        apiRetry: null,
      }),
    });
  }
  // /goal 的可见 query 用 controlOnly turn 建立 live 时间线身份，
  // 但真实执行属于紧随其后的 goalContinuation。若控制轮也推进 running，连续链路
  // 会短暂生成第二份 activeWorks，恢复投影也会出现伪造的工作生命周期。
  return deltas;
}

export function applyBackgroundTaskNotification(
  self: ProductProjectionContext,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const parsed = parseZCodeBackgroundTaskNotificationText(fact.input);
  if (!parsed) return [];
  const row = self.findToolRow(parsed.toolUseId);
  if (!row) return [];

  const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
    parsed.notification.status,
  );
  const status: ToolCallRow["status"] =
    notificationStatus === "failed"
      ? "error"
      : notificationStatus === "stopped"
        ? "cancelled"
        : "success";
  const content =
    parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
  const next: ToolCallRow = {
    ...row,
    status,
    ...(content
      ? {
          output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
        }
      : {}),
    endedAt: self.ms(fact.event),
  };
  if (status === "error") {
    next.error = {
      code: "fault.runtime.backgroundTaskFailed",
      message: parsed.notification.error ?? content ?? "Background task failed.",
    };
  } else {
    delete next.error;
  }
  return [{ op: "row.upserted", row: next }];
}

export function onTurnComplete(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnCompletePayload;
  self.outputContinuationTextRowId = null;
  const headerState = mapTurnResultToHeaderState(payload.resultType);
  const header = self.turnHeaderForEvent(event);
  if (header?.executionKind === "controlOnly") {
    // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
    // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
    // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
    const deltas = [
      ...self.upsertTurnHeader(event, headerState, undefined, payload.historyRoundCount),
      ...self.leaveDraftAfterControlOnlyTurn(
        payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
      ),
    ];
    self.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    self.currentTurnStartedModelOnly = false;
    return deltas;
  }
  const phase: SessionControl["phase"] =
    payload.resultType === "success"
      ? "completedSuccess"
      : payload.resultType === "cancelled"
        ? "completedInterrupted"
        : "error";
  const streamClose = payload.resultType === "success" ? "complete" : "interrupted";
  const activeMs = self.activeMsForCompletion(event, payload.duration);
  // error_max_turns 是受限结果而非传输失败：phase/标题已显示 failed，但
  // ChatErrorBanner 只读 control.lastError。投影稳定 code 才能让 ERROR_MAX_TURNS
  // 本地化分支可达（docs/specs/max-turns-limit.md「Контракт」）；message 用中性的
  // runtime 文案，UI 按 code 本地化而不是展示技术串。
  const limitLastError: SessionControl["lastError"] =
    payload.resultType === "error_max_turns"
      ? {
          code: "error_max_turns",
          message: "Turn reached the configured maxTurns limit.",
          recoverable: true,
          at: self.ms(event),
          source: "runtime",
          traceId: String(event.traceId),
        }
      : null;

  // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
  // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
  const goal = self.snapshot.goal;
  const pausedGoal: GoalState | undefined =
    payload.resultType === "cancelled" &&
    (goal?.status === "active" || goal?.status === "verifying")
      ? { ...goal, status: "paused" }
      : undefined;

  // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
  // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
  const heldQueue =
    payload.resultType === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    self.snapshot.queue.items.length > 0 &&
    (self.snapshot.queue.autoDrain || self.snapshot.queue.pauseReason !== "stopped")
      ? {
          ...self.snapshot.queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;

  const deltas: ConversationDelta[] = [
    ...self.closeStreamingRows(streamClose),
    // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
    // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
    ...self.closeOpenToolRows(event, payload.resultType === "cancelled" ? "cancelled" : "error"),
    ...self.upsertTurnHeader(
      event,
      headerState,
      activeMs,
      payload.historyRoundCount,
      self.highspeedTimingForTurn(self.turnIdOf(event), activeMs),
    ),
    ...(payload.resultType === "success" ? self.markStableForkAssistant(event) : []),
    {
      op: "state.updated",
      patch: self.controlPatch(
        {
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 受限终态才写 lastError；success/cancelled 不传该字段，保持「终态本身
          // 不清除 transient lastError」的既有语义。
          ...(limitLastError ? { lastError: limitLastError } : {}),
          // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
          // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
          apiRetry: null,
        },
        pausedGoal,
        heldQueue,
      ),
    },
  ];
  self.currentTurnId = null;
  // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
  self.currentTurnStartedModelOnly = false;
  return deltas;
}

export function leaveDraftAfterControlOnlyTurn(
  self: ProductProjectionContext,
  phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
): ConversationDelta[] {
  if (self.snapshot.control.phase !== "draft") return [];
  return [
    {
      op: "state.updated",
      patch: self.controlPatch({
        phase,
        sessionEnded: phase !== "error",
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      }),
    },
  ];
}

export function onTurnError(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnErrorPayload;
  self.outputContinuationTextRowId = null;
  if (self.turnHeaderForEvent(event)?.executionKind === "controlOnly") {
    const deltas = [
      ...self.upsertTurnHeader(event, "failed"),
      ...self.leaveDraftAfterControlOnlyTurn("error"),
    ];
    self.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    self.currentTurnStartedModelOnly = false;
    return deltas;
  }
  // TurnError 结束的是当前 turn，
  // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
  // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
  // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
  const heldQueue =
    self.snapshot.queue.items.length > 0
      ? {
          ...self.snapshot.queue,
          autoDrain: false,
          pauseReason: "error" as const,
        }
      : undefined;
  return [
    ...self.closeStreamingRows("interrupted"),
    ...self.closeOpenToolRows(event, "error"),
    ...self.upsertTurnHeader(
      event,
      "failed",
      undefined,
      undefined,
      self.highspeedTimingForTurn(self.turnIdOf(event)),
    ),
    {
      op: "state.updated",
      patch: self.controlPatch(
        {
          phase: "error",
          sessionEnded: false,
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
          lastError: {
            code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
            message: payload.error.message,
            recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
            at: self.ms(event),
            // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
            source: payload.error.attribution?.source ?? "runtime",
            traceId: String(event.traceId),
            ...(payload.error.detail ? { detail: payload.error.detail } : {}),
            ...(payload.error.underlyingErrorMessage
              ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
              : {}),
            ...(payload.error.underlyingErrorDetail
              ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
              : {}),
            ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
          },
          // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
          apiRetry: null,
        },
        undefined,
        heldQueue,
      ),
    },
  ];
}

export function splitProductTurn(
  self: ProductProjectionContext,
  event: SessionEvent,
  runtimeTurnId: string,
  promotedUserMessageId?: string,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const previousProductTurnId =
    self.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  const headerRowId = self.turnHeaderRowIdByTurnId.get(previousProductTurnId);
  const headerRow = headerRowId !== undefined ? self.findRow(headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const endedAt = self.ms(event);
    deltas.push({
      op: "row.upserted",
      row: {
        ...headerRow,
        state: "completedSuccess",
        endedAt,
        activeMs: Math.max(
          0,
          endedAt - (self.currentProductTurnStartedAtMs ?? headerRow.startedAt),
        ),
        ...(headerRow.workSegments
          ? {
              workSegments: self.completeWorkSegments(headerRow.workSegments, endedAt),
            }
          : {}),
      },
    });
  }
  const ordinal = (self.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
  self.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
  // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
  // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
  // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
  // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
  const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
  self.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
  self.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
  self.currentProductTurnStartedAtMs = self.ms(event);
  const header = buildTurnHeaderRow(self.rowBase(event, productTurnId, productTurnId), {
    turnNumber: 0,
    input: "",
  });
  self.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });
  return deltas;
}

export function activeMsForCompletion(
  self: ProductProjectionContext,
  event: SessionEvent,
  runtimeDuration?: number,
): number | undefined {
  const runtimeTurnId = String(event.turnId ?? self.currentTurnId ?? "turn-unknown");
  // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
  // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
  // 会错误覆盖 transcript 已计算好的整轮 duration。
  if (!self.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
  if (self.currentProductTurnStartedAtMs === null) return runtimeDuration;
  return Math.max(0, self.ms(event) - self.currentProductTurnStartedAtMs);
}

export function upsertTurnHeader(
  self: ProductProjectionContext,
  event: SessionEvent,
  state: "completedSuccess" | "completedInterrupted" | "failed",
  activeMs?: number,
  historyRoundCount?: number,
  highspeedTiming?: {
    modelDurationMs: number;
    toolDurationMs: number;
    otherDurationMs: number;
  },
): ConversationDelta[] {
  const row = self.turnHeaderForEvent(event);
  if (!row) return [];
  // 只有 TurnComplete(cancelled) 会带原因；TurnError 缺 resultType/abortReason，
  // 分类器返回空对象，row 形状与旧版本一致（老桌面按闭集 parse 不受影响）。
  const completion = event.payload as Partial<TurnCompletePayload>;
  const interrupt =
    state === "completedInterrupted"
      ? classifyTurnInterruptReason({
          resultType: completion.resultType ?? "",
          ...(completion.abortReason !== undefined ? { abortReason: completion.abortReason } : {}),
          ...(completion.preserveQueueAutoDrainOnCancel !== undefined
            ? { preserveQueueAutoDrainOnCancel: completion.preserveQueueAutoDrainOnCancel }
            : {}),
        })
      : {};
  const endedAt = self.ms(event);
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state,
        endedAt,
        ...(activeMs !== undefined ? { activeMs } : {}),
        ...highspeedTiming,
        ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
        ...(interrupt.interruptReason !== undefined
          ? { interruptReason: interrupt.interruptReason }
          : {}),
        ...(interrupt.interruptDetail !== undefined
          ? { interruptDetail: interrupt.interruptDetail }
          : {}),
        ...(row.workSegments
          ? {
              workSegments: self.completeWorkSegments(row.workSegments, endedAt),
            }
          : {}),
      },
    },
  ];
}

export function turnHeaderForEvent(
  self: ProductProjectionContext,
  event: SessionEvent,
): TurnHeaderRow | undefined {
  const rowId = self.turnHeaderRowIdByTurnId.get(self.turnIdOf(event));
  if (rowId === undefined) return undefined;
  const row = self.findRow(rowId);
  return row?.kind === "turnHeader" ? row : undefined;
}

export function openGuidedWorkSegment(
  self: ProductProjectionContext,
  event: SessionEvent,
  triggerEntityId: string,
): ConversationDelta[] {
  const row = self.turnHeaderForEvent(event);
  if (!row || row.executionKind === "controlOnly") return [];
  const startedAt = self.ms(event);
  const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
    {
      segmentId: `${row.turnId}:initial`,
      startedAt: row.startedAt,
    },
  ];
  // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
  // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
  const workSegments = [
    ...self.completeWorkSegments(existingSegments, startedAt),
    {
      segmentId: triggerEntityId,
      triggerEntityId,
      startedAt,
    },
  ];
  return [{ op: "row.upserted", row: { ...row, workSegments } }];
}

export function completeWorkSegments(
  self: ProductProjectionContext,
  segments: readonly TurnWorkSegment[],
  endedAt: number,
): TurnWorkSegment[] {
  return segments.map((segment, index) =>
    index === segments.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt,
          activeMs: Math.max(0, endedAt - segment.startedAt),
        }
      : segment,
  );
}
