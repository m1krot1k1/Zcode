// ProductProjection 域模块：onTurnSteerQueued, onTurnSteerDispatchChanged, onTurnSteerDeliveryChanged, onTurnSteerDrained 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import type {
  SessionEvent,
  SessionInputPromotedPayload,
  TurnInputIntentMetadata,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerQueuedPayload,
} from "@zcode/contracts";
import type { ConversationDelta, QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function onTurnSteerQueued(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerQueuedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  const existingIndex = self.snapshot.queue.items.findIndex(
    (item) => item.queueItemId === queueItemId,
  );
  const existing = existingIndex >= 0 ? self.snapshot.queue.items[existingIndex] : undefined;
  // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
  // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
  const admittedDelivery: "queue" | "guide" =
    payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
      ? payload.intent.admittedDelivery
      : (payload.delivery ??
        (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
          ? existing.delivery.admitted
          : self.snapshot.config.followupMode === "guide"
            ? "guide"
            : "queue"));
  const requestedDelivery =
    payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
  const fallbackReasonCode =
    payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
  // Bug 根因：队列投影曾漏掉 intent.highspeed，自动和手动提升都因此把有效卡误判为不存在。
  const highspeed = payload.intent?.highspeed ?? existing?.highspeed;
  const nextItem: QueueItem = {
    // QueueItem 只代表 ZCode 的 queued/guide 输入；ACP route 在 admission 时拒绝。
    executionRoute: existing?.executionRoute ?? { kind: "zcode" },
    queueItemId,
    kind:
      payload.intent?.kind === "compact" || payload.commandKind === "compact"
        ? ("compact" as const)
        : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
          ? ("sendGoalCommand" as const)
          : (existing?.kind ?? ("sendText" as const)),
    text: payload.input,
    sourceCommandId:
      payload.intent?.sourceCommandId ??
      existing?.sourceCommandId ??
      payload.inputId ??
      payload.pendingInputId,
    clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
    attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
    ...((payload.intent?.source ?? existing?.source)
      ? { source: payload.intent?.source ?? existing?.source }
      : {}),
    // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
    // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
    modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
    mode: payload.intent?.mode ?? existing?.mode,
    planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
    orchestrationMode: payload.intent?.orchestrationMode ?? existing?.orchestrationMode,
    sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
    provenance: payload.intent?.provenance ?? existing?.provenance,
    // 排队事件和原地编辑都必须保留可信接入来源，不能在 UI 投影时丢掉发送者。
    ...((payload.intent?.inputOrigin ?? existing?.inputOrigin)
      ? { inputOrigin: payload.intent?.inputOrigin ?? existing?.inputOrigin }
      : {}),
    ...((payload.intent?.conversationQuotes ?? existing?.conversationQuotes)
      ? { conversationQuotes: payload.intent?.conversationQuotes ?? existing?.conversationQuotes }
      : {}),
    ...((payload.intent?.botGroupSource ?? existing?.botGroupSource)
      ? { botGroupSource: payload.intent?.botGroupSource ?? existing?.botGroupSource }
      : {}),
    delivery: {
      requested: requestedDelivery,
      admitted: admittedDelivery,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq:
        payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
      queuePosition:
        payload.intent?.queuePosition ??
        existing?.order.queuePosition ??
        Math.max(0, (payload.queueLength ?? 1) - 1),
    },
    steer:
      !payload.intent && !payload.delivery && existing
        ? existing.steer
        : fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : admittedDelivery === "guide"
            ? { state: "steering" }
            : { state: "notRequested" },
    dispatch: { state: "queued" },
    ...(highspeed ? { highspeed } : {}),
    ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
    admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? self.ms(event),
  };
  // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
  self.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
  // 同 id 重入 = editQueueItem 原地更新（保位）；新 id = 追加。旧逻辑 filter+append
  // 会把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
  const items =
    existingIndex >= 0
      ? self.snapshot.queue.items.map((item, index) => (index === existingIndex ? nextItem : item))
      : [...self.snapshot.queue.items, nextItem];
  return [
    {
      op: "state.updated",
      patch: self.queuePatch({ ...self.snapshot.queue, items }),
    },
  ];
}

export function onTurnSteerDispatchChanged(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDispatchChangedPayload;
  if (
    !self.snapshot.queue.items.some((candidate) => candidate.queueItemId === payload.pendingInputId)
  ) {
    return [];
  }
  const dispatch =
    payload.state === "queued"
      ? ({ state: "queued" } as const)
      : ({
          state: payload.state,
          reservationId: payload.reservationId,
        } as const);
  return [
    {
      op: "state.updated",
      patch: self.queuePatch({
        ...self.snapshot.queue,
        items: self.snapshot.queue.items.map((candidate) =>
          candidate.queueItemId === payload.pendingInputId ? { ...candidate, dispatch } : candidate,
        ),
      }),
    },
  ];
}

export function onTurnSteerDeliveryChanged(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDeliveryChangedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  if (!self.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
    return [];
  }
  self.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
  return [
    {
      op: "state.updated",
      patch: self.queuePatch({
        ...self.snapshot.queue,
        items: self.snapshot.queue.items.map((item) =>
          item.queueItemId === queueItemId
            ? {
                ...item,
                delivery: {
                  requested: payload.requestedDelivery,
                  admitted: payload.admittedDelivery,
                  fallbackReasonCode: payload.fallbackReasonCode,
                },
                steer: {
                  state: "fellBack",
                  reasonCode: payload.fallbackReasonCode,
                },
              }
            : item,
        ),
      }),
    },
  ];
}

export function onTurnSteerDrained(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDrainedPayload;
  const runtimeTurnId = String(
    payload.targetTurnId ?? event.turnId ?? self.currentTurnId ?? "turn-unknown",
  );
  // drain 事实优先自带文本/messageId（drainedInputs），
  // 投影不再依赖内存 queue 状态取文本——旧实现查不到 queue item 就静默 continue，
  // 用户输入从 queue 消失后也不进 history。旧事件（无 drainedInputs）回退查表。
  const items =
    payload.drainedInputs ??
    payload.pendingInputIds.flatMap((pendingInputId, index) => {
      const queueItem = self.snapshot.queue.items.find(
        (candidate) => candidate.queueItemId === pendingInputId,
      );
      if (!queueItem) return [];
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: queueItem.sourceCommandId,
        queueItemId: queueItem.queueItemId,
        clientId: queueItem.clientId,
        kind: queueItem.kind,
        text: queueItem.text,
        ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
        ...(queueItem.mode ? { mode: queueItem.mode } : {}),
        ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
        ...(queueItem.orchestrationMode ? { orchestrationMode: queueItem.orchestrationMode } : {}),
        admissionSeq: queueItem.order.admissionSeq,
        admittedAt: queueItem.admittedAt,
        requestedDelivery: queueItem.delivery.requested,
        admittedDelivery: queueItem.delivery.admitted,
        queuePosition: queueItem.order.queuePosition,
        ...(queueItem.delivery.fallbackReasonCode
          ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
          : {}),
        attachmentRefs: queueItem.attachments,
      };
      return [
        {
          pendingInputId,
          messageId: payload.injectedMessageIds?.[index],
          text: queueItem.text,
          delivery: self.deliveryByPendingInputId.get(pendingInputId),
          intent,
        },
      ];
    });

  const deltas: ConversationDelta[] = [];
  for (const item of items) {
    const delivery =
      item.delivery ?? self.deliveryByPendingInputId.get(item.pendingInputId) ?? "queue";
    // queue 消费 = product turn 边界（每条一轮：收口上一段
    // header、开新 turnHeader、后续 assistant 归新轮）；guide steer 内联当前轮。
    if (delivery === "queue") {
      deltas.push(
        ...self.splitProductTurn(
          event,
          runtimeTurnId,
          item.messageId ? String(item.messageId) : undefined,
        ),
      );
    }
    const messageId = item.messageId ? String(item.messageId) : null;
    const entityId = messageId ?? item.pendingInputId;
    const productTurnId = self.turnIdOf(event);
    const rootSourceCommandId =
      item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
    const row = {
      ...self.rowBase(event, productTurnId, entityId),
      kind: "userInput" as const,
      text:
        item.intent?.conversationQuotes || item.intent?.botGroupSource
          ? (item.intent.text ?? item.text)
          : item.text,
      origin: "realUser" as const,
      ...(delivery === "guide" ? { guided: true as const } : {}),
      ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
      ...(item.intent?.conversationQuotes
        ? { conversationQuotes: item.intent.conversationQuotes }
        : {}),
      ...(item.intent?.botGroupSource ? { botGroupSource: item.intent.botGroupSource } : {}),
      ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
      ...(item.intent?.highspeed ? { highspeed: item.intent.highspeed } : {}),
      ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
      ...(item.intent?.source ? { source: item.intent.source } : {}),
    };
    // queue/guide 消费后的 real-user row 与普通 TurnStarted 共用完整 canonical target；
    // 缺 messageId 的旧事件仍只可展示，不暴露无法执行的 edit action。
    self.registerCanonicalUserRowTarget(
      row.rowId,
      entityId,
      messageId && item.intent?.kind !== "compact"
        ? {
            entityId,
            productTurnId,
            transcriptMessageId: messageId,
            coveredByStableCompact: false,
            intent: {
              kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
              text: item.intent?.text ?? item.text,
              executionRoute: item.intent?.executionRoute ?? { kind: "zcode" },
              ...(item.intent?.sourceCommandId
                ? { sourceCommandId: item.intent.sourceCommandId }
                : {}),
              ...(item.intent?.inputOrigin ? { inputOrigin: item.intent.inputOrigin } : {}),
              ...(item.intent?.conversationQuotes
                ? { conversationQuotes: item.intent.conversationQuotes }
                : {}),
              ...(item.intent?.botGroupSource
                ? { botGroupSource: item.intent.botGroupSource }
                : {}),
              ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
              ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
              ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
              ...(item.intent?.admissionSeq !== undefined
                ? { admissionSeq: item.intent.admissionSeq }
                : {}),
              ...(item.intent?.admittedAt !== undefined
                ? { admittedAt: item.intent.admittedAt }
                : {}),
              ...(item.intent?.requestedDelivery
                ? { requestedDelivery: item.intent.requestedDelivery }
                : {}),
              ...(item.intent?.admittedDelivery
                ? { admittedDelivery: item.intent.admittedDelivery }
                : {}),
              ...(item.intent?.fallbackReasonCode
                ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                : {}),
              ...(item.intent?.modelSelection
                ? { modelSelection: item.intent.modelSelection }
                : {}),
              ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
              ...(item.intent?.planEnabled !== undefined
                ? { planEnabled: item.intent.planEnabled }
                : {}),
              ...(item.intent?.orchestrationMode
                ? { orchestrationMode: item.intent.orchestrationMode }
                : {}),
              ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
            },
          }
        : undefined,
    );
    if (delivery === "guide") {
      deltas.push(...self.openGuidedWorkSegment(event, row.entityId ?? item.pendingInputId));
    }
    deltas.push({ op: "row.appended", row });
    self.deliveryByPendingInputId.delete(item.pendingInputId);
  }
  return [...deltas, ...self.removeQueueItems(payload.pendingInputIds)];
}

export function onTurnSteerDiscarded(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDiscardedPayload;
  return self.removeQueueItems(payload.pendingInputIds);
}

export function onSessionInputPromoted(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionInputPromotedPayload;
  // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
  // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
  // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
  // 因此它才是可以安全移除 queue 投影的 durable commit signal。
  return self.removeQueueItems([payload.pendingInputId]);
}

export function onTurnSteerReordered(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { orderedPendingInputIds?: string[] };
  const order = payload.orderedPendingInputIds ?? [];
  const byId = new Map(self.snapshot.queue.items.map((item) => [item.queueItemId, item]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((item): item is (typeof self.snapshot.queue.items)[number] => item !== undefined);
  // 未在 order 里出现的项（防丢）追加保持原相对序。
  const orderedIds = new Set(order);
  const rest = self.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
  const reordered = [...ordered, ...rest];
  const items = reordered.map((item, index) =>
    item.order.queuePosition === index
      ? item
      : { ...item, order: { ...item.order, queuePosition: index } },
  );
  // 顺序无变化则不产 delta（幂等）。
  if (
    items.length === self.snapshot.queue.items.length &&
    items.every((item, index) => item === self.snapshot.queue.items[index])
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: self.queuePatch({ ...self.snapshot.queue, items }),
    },
  ];
}

export function onQueueAutoDrainChanged(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { autoDrain?: boolean };
  const autoDrain = payload.autoDrain ?? true;
  if (
    self.snapshot.queue.autoDrain === autoDrain &&
    (autoDrain || self.snapshot.queue.pauseReason === "manual")
  ) {
    return [];
  }
  const queue = { ...self.snapshot.queue, autoDrain };
  if (autoDrain) {
    delete queue.pauseReason;
  } else {
    queue.pauseReason = "manual";
  }
  return [
    {
      op: "state.updated",
      patch: self.queuePatch(queue),
    },
  ];
}

export function removeQueueItems(
  self: ProductProjectionContext,
  ids: readonly string[],
): ConversationDelta[] {
  const idSet = new Set(ids);
  for (const id of ids) self.deliveryByPendingInputId.delete(id);
  const items = self.snapshot.queue.items
    .filter((item) => !idSet.has(item.queueItemId))
    .map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
  if (items.length === self.snapshot.queue.items.length) return [];
  return [
    {
      op: "state.updated",
      patch: self.queuePatch({ ...self.snapshot.queue, items }),
    },
  ];
}
