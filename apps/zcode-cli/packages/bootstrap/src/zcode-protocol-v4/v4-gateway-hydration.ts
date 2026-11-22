// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：ensurePublisher / seedPublisherConfig / ensureHistoryReadyPublisher 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { randomUUID } from "node:crypto";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type { SessionUsageSeed } from "./product-projection.js";
import type { GatewayContext, HydrationBuffer, RawSequenceState } from "./v4-gateway-context.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-errors.js";
import type { PersistedEventsLoadResult } from "./v4-gateway-host.js";

export function ensurePublisher(
  ctx: GatewayContext,
  sessionId: string,
): ConversationTopicPublisher {
  let publisher = ctx.publishers.get(sessionId);
  if (!publisher) {
    publisher = new ConversationTopicPublisher(sessionId, ctx.createLogEpoch(sessionId), {
      now: ctx.now,
    });
    ctx.publishers.set(sessionId, publisher);
    // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
    ctx.seedPublisherConfig(sessionId, publisher);
  }
  return publisher;
}

/**
 * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
 * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
 * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
 * 事件接线期间），hydration 处补一次兜住该窗口。
 */
export function seedPublisherConfig(
  ctx: GatewayContext,
  sessionId: string,
  publisher: ConversationTopicPublisher,
): void {
  const getSeed = ctx.host.getSessionConfigSeed;
  if (!getSeed) return;
  try {
    const seed = getSeed.call(ctx.host, sessionId);
    if (seed) publisher.seedConfig(seed);
  } catch (error) {
    ctx.host.onError?.("v4.configSeed", error);
  }
}

/** 首帧先落 transport queue，再启动会同步扫描插件的 runtime；重连不重跑失败 hook。 */
export function ensureHistoryReadyPublisher(
  ctx: GatewayContext,
  sessionId: string,
  thought?: string,
  workspace?: ZCodeWorkspaceRef,
  additionalDirectories?: string[],
  retryAttempt?: string,
): Promise<ConversationTopicPublisher> {
  const existing = ctx.historyOpenings.get(sessionId);
  if (existing) return existing.history;
  const publisher = ctx.publishers.get(sessionId);
  const failed = publisher?.getSnapshot().runtimeInitialization;
  if (failed?.status === "failed" && failed.attemptId !== retryAttempt)
    return Promise.resolve(publisher!);
  // 失败 app 已回收，旧 raw tail 不属于下一次 runtime 的事件水位。
  if (failed?.status === "failed") ctx.rawSequenceStates.delete(sessionId);
  const attemptId = randomUUID();
  const initializationStartedAt = performance.now();
  let resolveReady!: (publisher: ConversationTopicPublisher) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<ConversationTopicPublisher>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 没有旧客户端等待时失败也由状态条消费，避免无人 await 的 rejection。
  void ready.catch(() => undefined);
  ctx.readyFlights.set(sessionId, ready);
  let messages: MessageWithParts[] | undefined;
  let started = false;
  const clear = () => {
    messages = undefined;
    if (ctx.readyFlights.get(sessionId) === ready) ctx.readyFlights.delete(sessionId);
    if (ctx.historyOpenings.get(sessionId) === opening) ctx.historyOpenings.delete(sessionId);
  };
  const opening = {
    cancel: () => {
      rejectReady(new Error("cold opening disposed"));
      clear();
    },
    history: Promise.resolve()
      .then(async () => {
        messages = await ctx.host.loadPersistedMessages!(sessionId);
        if (ctx.disposed || ctx.historyOpenings.get(sessionId) !== opening)
          throw new Error("cold opening disposed");
        const result = await ctx.hydratePublisher(sessionId, messages, true);
        ctx.setInitialization(sessionId, result, { status: "initializing", attemptId });
        return result;
      })
      .catch((error: unknown) => {
        rejectReady(error);
        clear();
        throw error;
      }),
    start: () => {
      if (started) return;
      started = true;
      // post-response commit 已确认首帧入队；下一轮让 stdio I/O 有机会交付，不用定时猜测 UI。
      setImmediate(() => {
        let disposeOnFailure: (() => Promise<void>) | undefined;
        let releaseRuntime: (() => void) | undefined;
        void (async () => {
          if (ctx.disposed || ctx.historyOpenings.get(sessionId) !== opening)
            throw new Error("cold opening disposed");
          releaseRuntime = await ctx.host.retainSessionRuntime?.(sessionId);
          if (ctx.disposed || ctx.historyOpenings.get(sessionId) !== opening)
            throw new Error("cold opening disposed");
          const restored = await ctx.coldResume.ensureResumed(
            sessionId,
            thought,
            workspace,
            additionalDirectories,
            messages,
            (outcome) => {
              disposeOnFailure = outcome.disposeOnFailure;
            },
          );
          if (ctx.disposed || ctx.historyOpenings.get(sessionId) !== opening)
            throw new Error("cold opening disposed");
          const result = await ctx.hydratePublisher(sessionId, restored ?? messages, true);
          ctx.setInitialization(sessionId, result, { status: "ready", attemptId });
          ctx.host.onDebug?.(
            `v4 runtime ready session=${sessionId} attempt=${attemptId} runtimeReadyMs=${Math.round(performance.now() - initializationStartedAt)}`,
          );
          resolveReady(result);
        })()
          .catch(async (error: unknown) => {
            // activation 成功而最终物化失败时，也必须拆掉本次 app，下一次重试才会完整 resume。
            await disposeOnFailure?.();
            if (!ctx.disposed && ctx.historyOpenings.get(sessionId) === opening) {
              const result = ctx.publishers.get(sessionId);
              if (result)
                ctx.setInitialization(sessionId, result, {
                  status: "failed",
                  attemptId,
                  reasonCode: "fault.subscribe.resumeFailed",
                  message: error instanceof Error ? error.message : String(error),
                });
              ctx.host.onError?.("v4.initialize", error, { sessionId, attemptId });
            }
            rejectReady(error);
          })
          .finally(() => {
            releaseRuntime?.();
            clear();
          });
      });
    },
  };
  ctx.historyOpenings.set(sessionId, opening);
  return opening.history;
}

export function setInitialization(
  ctx: GatewayContext,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
): void {
  publisher.setRuntimeInitialization(state);
  const sequence = ctx.rawSequenceStates.get(sessionId);
  if (sequence) {
    sequence.lastTransportSeq = publisher.getSnapshot().seq;
    sequence.offset = sequence.lastTransportSeq - sequence.sourceEventSeq;
  }
  for (const connectionId of new Set(
    [...ctx.flushStates.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.connectionId),
  )) {
    if (!ctx.pausedConnections.has(connectionId)) ctx.flushConnection(connectionId);
  }
}

/**
 * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
 * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
 */
export function ensureColdReadyPublisher(
  ctx: GatewayContext,
  sessionId: string,
  resumeThoughtLevel?: string,
  workspace?: ZCodeWorkspaceRef,
  additionalDirectories?: string[],
): Promise<ConversationTopicPublisher> {
  const existingFlight = ctx.readyFlights.get(sessionId);
  if (existingFlight) return existingFlight;
  // 先登记同一个 READY，再开始所有耗时工作。
  const operation = Promise.resolve().then(async () => {
    const persistedMessages = await ctx.coldResume.ensureResumed(
      sessionId,
      resumeThoughtLevel,
      workspace,
      additionalDirectories,
    );
    return ctx.hydratePublisher(sessionId, persistedMessages);
  });
  ctx.readyFlights.set(sessionId, operation);
  // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
  const clear = () => {
    if (ctx.readyFlights.get(sessionId) === operation) ctx.readyFlights.delete(sessionId);
  };
  void operation.then(clear, clear);
  return operation;
}

/**
 * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
 * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
 */
export function hydratePublisher(
  ctx: GatewayContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existing = ctx.publishers.get(sessionId);
  // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
  if (!forceRebuild && existing && ctx.hydratedSessions.has(sessionId))
    return Promise.resolve(existing);

  const inFlight = ctx.hydrationInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const buffer: HydrationBuffer = {
    cancelled: false,
    eventIds: new Set<string>(),
    rawEvents: [],
  };
  ctx.hydrationBuffers.set(sessionId, buffer);
  const hydration = ctx
    .performHydration(sessionId, buffer, persistedMessages, forceRebuild)
    .finally(() => {
      if (ctx.hydrationBuffers.get(sessionId) === buffer) {
        ctx.hydrationBuffers.delete(sessionId);
      }
      if (ctx.hydrationInFlight.get(sessionId) === hydration) {
        ctx.hydrationInFlight.delete(sessionId);
      }
    });
  ctx.hydrationInFlight.set(sessionId, hydration);
  return hydration;
}

export async function performHydration(
  ctx: GatewayContext,
  sessionId: string,
  buffer: HydrationBuffer,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existingAtStart = ctx.publishers.get(sessionId);
  const liveSessionAtStart = ctx.host.sessionExists(sessionId);
  const hydrationStartedAt = performance.now();
  ctx.host.onDebug?.(
    `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
      `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
      `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
  );
  const loaded: PersistedEventsLoadResult = ctx.host.loadPersistedEvents
    ? await ctx.host.loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
        ctx.host.onError?.("v4.hydrate", error, {
          durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
          existingPublisherAtStart: existingAtStart !== undefined,
          liveSessionAtStart,
          phase: "loadPersistedEvents",
          persistedMessages: persistedMessages?.length ?? 0,
          sessionId,
        });
        if (ctx.historyOpenings.has(sessionId)) throw error;
        return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
      })
    : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };

  ctx.host.onDebug?.(
    `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
      `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
      `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
  );

  if (ctx.disposed || buffer.cancelled) {
    throw new Error(`v4 hydration cancelled for session ${sessionId}`);
  }

  // assistant 守恒：拒收过正文流的 publisher 不可信——它建立于
  // TurnStarted 之后，缺段无法用 append-only 重放补进中间位置，只能整体重建。
  const latestPublisher = ctx.publishers.get(sessionId);
  const existingDroppedContent =
    latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
  // 事件日志完整（synthesized=false）且已有健康 live publisher（流式）→ 保留，不重放。
  if (
    existingAtStart &&
    latestPublisher === existingAtStart &&
    !loaded.synthesized &&
    !forceRebuild &&
    !existingDroppedContent
  ) {
    // 创建时种子可能落空（record 尚未入册），首次订阅补一次（幂等、事件优先）。
    ctx.hydrationBuffers.delete(sessionId);
    ctx.seedPublisherConfig(sessionId, latestPublisher);
    if (loaded.sharedContextImport) {
      latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    await ctx.seedPublisherUsage(sessionId, latestPublisher, persistedMessages, loaded.usageSeed);
    ctx.hydratedSessions.add(sessionId);
    ctx.publishCurrentSummaryToIndex(sessionId);
    return latestPublisher;
  }

  // 只记住 await 之前的 existing 引用是不够的：load 等待期间 raw event
  // 会继续推进这个 publisher，synthesized 返回后却把它整体删除，queue/stream 随之
  // 消失。重建以 sourceEventSeq 为 raw snapshot 边界，并把等待窗口内事件补回。
  const publisher = latestPublisher ?? existingAtStart ?? ctx.ensurePublisher(sessionId);
  ctx.rejectProjectionEventWaiters(
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.rehydrated",
      `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
    ),
  );
  publisher.rehydrate(loaded.events, {
    // 恢复时 transcript/event store 可能仍含运行期已拒绝的超大正文。不能让同一事实
    // 在 CLI 重启后再次把 subscribe 卡死；跳过该不可传输 projection event，继续归约
    // 后续持久 TurnError/TurnComplete，使冷快照停在最后一个可恢复边界。
    onPayloadTooLarge: (error) =>
      ctx.host.onError?.("v4.hydrate.payloadTooLarge", error, {
        phase: "publisher.rehydrate",
        sessionId,
      }),
  });
  if (loaded.sharedContextImport) {
    publisher.seedSharedContextImport(loaded.sharedContextImport);
  }
  if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
  // 同次恢复的种子先应用，再补 live buffer；较新的使用量和选模事件始终获胜。
  if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
  const sourceEventSeq = Math.max(
    0,
    loaded.sourceEventSeq ??
      (loaded.synthesized
        ? 0
        : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
  );
  const previousSequenceState = ctx.rawSequenceStates.get(sessionId);
  const sequenceState: RawSequenceState = {
    sourceEventSeq,
    offset: publisher.getSnapshot().seq - sourceEventSeq,
    lastTransportSeq: publisher.getSnapshot().seq,
    seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
    appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
    failedEventById: new Map(previousSequenceState?.failedEventById),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  ctx.rawSequenceStates.set(sessionId, sequenceState);
  // 持久读取的 sourceEventSeq 是 load 开始时的水位；hydration buffer
  // 只能记录 load 开始后的事件。若 seq=N 已在 buffer 创建前进入 live publisher，而
  // load 只读到 N-1 时，rehydrate 后不能仅重放 N+1：raw reorder 会永久等待已经被
  // 丢掉的 N，连带让 running Agent 控制行消失。保留与 publisher 相同大小的 raw tail，
  // 与 await 窗口 buffer 合并后从持久边界连续重放。
  const replayByEventId = new Map<string, SessionEvent>();
  for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  for (const rawEvent of buffer.rawEvents) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  const replayEvents = [...replayByEventId.values()].sort((left, right) => {
    if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
      return left.sequenceNumber - right.sequenceNumber;
    }
    if (left.sequenceNumber > 0) return -1;
    if (right.sequenceNumber > 0) return 1;
    return 0;
  });
  for (const rawEvent of replayEvents) {
    for (const normalized of ctx.normalizeRuntimeEventSequence(sessionId, rawEvent)) {
      try {
        publisher.ingest(normalized);
        ctx.resolveProjectionEventCommit(sessionId, String(normalized.id));
      } catch (error) {
        ctx.rejectProjectionEventCommit(
          sessionId,
          String(normalized.id),
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply hydrated event ${String(normalized.id)}`,
            { cause: error },
          ),
        );
        if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
        ctx.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "replayBufferedEvents",
          sessionId,
        });
      }
    }
  }
  // publisher 已替换且 buffer 已同步补齐；在 usage seed 的异步等待窗口内，新 raw
  // event 直接走上面的 per-session sequence state 进入新 publisher，不再需要二次 replay。
  if (ctx.hydrationBuffers.get(sessionId) === buffer) {
    ctx.hydrationBuffers.delete(sessionId);
  }
  // 冷恢复种子（重放之后）：resume 已把历史会话的上次选型写回 runtime
  // （reconcileResumedRuntimeSettings），而合成/持久化事件里可能没有 ModelSelected——
  // 种子只填事件未触碰的字段，日志有值时以日志为准（冷恢复口径）。
  ctx.seedPublisherConfig(sessionId, publisher);
  if (loaded.usageSeed === undefined) {
    await ctx.seedPublisherUsage(sessionId, publisher, persistedMessages);
  }
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (ctx.pausedConnections.has(state.connectionId)) continue;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      ctx.emitReservation(reservation);
    } catch (error) {
      ctx.host.onError?.("v4.hydrate.subscriptionResync", error, {
        phase: "subscriptionResync",
        sessionId,
      });
      ctx.scheduleFlush(routeKey, state, publisher);
    }
  }
  ctx.hydratedSessions.add(sessionId);
  ctx.publishCurrentSummaryToIndex(sessionId);
  return publisher;
}

export async function seedPublisherUsage(
  ctx: GatewayContext,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  persistedMessages?: MessageWithParts[],
  loadedSeed?: SessionUsageSeed | null,
): Promise<void> {
  if (loadedSeed !== undefined) {
    if (loadedSeed) publisher.seedUsage(loadedSeed);
    return;
  }
  const getSeed = ctx.host.getSessionUsageSeed;
  if (!getSeed) return;
  try {
    const seed = await getSeed.call(ctx.host, sessionId, persistedMessages);
    if (seed) publisher.seedUsage(seed);
  } catch (error) {
    ctx.host.onError?.("v4.usageSeed", error);
  }
}
