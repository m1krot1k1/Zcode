// subscription ownership、pending ACK staging 与 topic frame 路由。
import { Emitter, type Event } from "@zcode/rpc";
import type { ZCodeAgentWorkspaceTarget } from "../zcodeAgent.js";
import {
  MAX_PENDING_OWNERSHIP_BYTES,
  MAX_PENDING_OWNERSHIP_FRAMES,
  type OwnedSubscription,
  type PendingOwnership,
  type RoutedFrameEvent,
  type RoutedTopicFrame,
  type SubscriptionKind,
  type TrustedZCodeAgentV4UnsubscribeRoute,
} from "./types.js";
import { frameBytes, workspaceKey, workspaceTarget } from "./trustedConnection.js";

export interface OwnershipRegistry {
  entries(): OwnedSubscription[];
  remember(subscriptionId: string, entry: OwnedSubscription): void;
  forget(entry: OwnedSubscription): void;
  findBySubscription(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    subscriptionId: string,
    expectedRoute: TrustedZCodeAgentV4UnsubscribeRoute | null,
  ): OwnedSubscription | null;
  ownsFrame(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: { subscriptionId: string; topic: string },
  ): boolean;
  beginPendingOwnership(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
  ): PendingOwnership;
  removePendingOwnership(pending: PendingOwnership): void;
  discardPendingOwnership(pending: PendingOwnership): void;
  routedEvent<T extends RoutedTopicFrame>(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    source: Event<T>,
  ): Event<T>;
  flushPendingFrames(
    entry: OwnedSubscription,
    subscriptionId: string,
    pending: PendingOwnership,
  ): void;
  currentRuntimeGeneration(invalidatedWorkspaceKey: string): number;
  invalidateWorkspaceRuntime(invalidatedWorkspaceKey: string, generation: number): void;
  takeEntries(): OwnedSubscription[];
  clearPending(): void;
  disposeRoutedEvents(): void;
  clearRuntimeGenerations(): void;
}

export function createOwnershipRegistry(): OwnershipRegistry {
  const owned = new Map<string, OwnedSubscription>();
  const routeKeyByOwnership = new Map<string, string>();
  const pendingByOwnership = new Map<string, Set<PendingOwnership>>();
  const routedFrameEvents = new Map<string, RoutedFrameEvent>();
  const runtimeGenerationByWorkspaceKey = new Map<string, number>();

  const routeKey = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ) => `${kind}\0${workspaceKey(target)}\0${topic}\0${subscriptionId}\0${connectionId}`;
  const ownershipKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget, topic: string) =>
    `${kind}\0${workspaceKey(target)}\0${topic}`;
  const routedEventKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget) =>
    `${kind}\0${workspaceKey(target)}`;

  const remember = (subscriptionId: string, entry: OwnedSubscription): void => {
    const key = routeKey(entry.kind, entry.target, entry.topic, subscriptionId, entry.connectionId);
    const previous = routeKeyByOwnership.get(entry.ownershipKey);
    if (previous) owned.delete(previous);
    routeKeyByOwnership.set(entry.ownershipKey, key);
    owned.set(key, entry);
  };
  const forget = (entry: OwnedSubscription): void => {
    const key = routeKey(
      entry.kind,
      entry.target,
      entry.topic,
      entry.subscriptionId,
      entry.connectionId,
    );
    owned.delete(key);
    if (routeKeyByOwnership.get(entry.ownershipKey) === key) {
      routeKeyByOwnership.delete(entry.ownershipKey);
    }
  };
  const findBySubscription = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    subscriptionId: string,
    expectedRoute: TrustedZCodeAgentV4UnsubscribeRoute | null,
  ): OwnedSubscription | null => {
    const expectedWorkspaceKey = workspaceKey(target);
    const matches = [...owned.values()].filter(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === subscriptionId &&
        workspaceKey(entry.target) === expectedWorkspaceKey &&
        (!expectedRoute ||
          (entry.topic === expectedRoute.topic &&
            entry.connectionId === expectedRoute.connectionId)),
    );
    // terminal UI 只传 subId；若它在同 method/workspace 内碰撞，宁可拒绝猜测。
    // trusted relay 则使用下游 facade 写入的 topic/connection 精确命中。
    return matches.length === 1 ? matches[0]! : null;
  };
  const ownsFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: { subscriptionId: string; topic: string },
  ) => {
    const expectedWorkspaceKey = workspaceKey(target);
    return [...owned.values()].some(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === frame.subscriptionId &&
        entry.topic === frame.topic &&
        workspaceKey(entry.target) === expectedWorkspaceKey,
    );
  };
  const beginPendingOwnership = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
  ): PendingOwnership => {
    const pending: PendingOwnership = {
      kind,
      target: workspaceTarget(target),
      topic,
      frames: [],
      stagedBytes: 0,
      overflowReason: null,
      runtimeGeneration: runtimeGenerationByWorkspaceKey.get(workspaceKey(target)) ?? 0,
      invalidatedByRuntimeRestart: false,
    };
    const key = ownershipKey(kind, target, topic);
    const group = pendingByOwnership.get(key) ?? new Set<PendingOwnership>();
    group.add(pending);
    pendingByOwnership.set(key, group);
    return pending;
  };
  const removePendingOwnership = (pending: PendingOwnership): void => {
    const key = ownershipKey(pending.kind, pending.target, pending.topic);
    const group = pendingByOwnership.get(key);
    group?.delete(pending);
    if (group?.size === 0) pendingByOwnership.delete(key);
  };
  const discardPendingOwnership = (pending: PendingOwnership): void => {
    removePendingOwnership(pending);
    pending.frames.length = 0;
    pending.stagedBytes = 0;
    pending.overflowReason = null;
  };
  const stageFrame = (pending: PendingOwnership, frame: RoutedTopicFrame): void => {
    if (pending.overflowReason || pending.invalidatedByRuntimeRestart) return;
    const bytes = frameBytes(frame);
    if (
      pending.frames.length + 1 > MAX_PENDING_OWNERSHIP_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_OWNERSHIP_BYTES
    ) {
      // 旧 ACK staging 超限时 shift 最旧帧，会把一个
      // logical frame 变成永久缺片。溢出必须清空整批并显式失败。
      pending.frames.length = 0;
      pending.stagedBytes = 0;
      pending.overflowReason = "fault.subscription.initialFrameStagingOverflow";
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
  const routeIncomingFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: RoutedTopicFrame,
    emitter: Emitter<RoutedTopicFrame>,
  ): void => {
    if (ownsFrame(kind, target, frame)) {
      emitter.fire(frame);
      return;
    }
    const group = pendingByOwnership.get(ownershipKey(kind, target, frame.topic));
    if (!group) return;
    for (const pending of group) stageFrame(pending, frame);
  };
  const routedEvent = <T extends RoutedTopicFrame>(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    source: Event<T>,
  ): Event<T> => {
    const key = routedEventKey(kind, target);
    let route = routedFrameEvents.get(key);
    if (!route) {
      const emitter = new Emitter<RoutedTopicFrame>();
      route = {
        emitter,
        upstream: source((frame) => routeIncomingFrame(kind, target, frame, emitter)),
      };
      routedFrameEvents.set(key, route);
    }
    return route.emitter.event as Event<T>;
  };
  const flushPendingFrames = (
    entry: OwnedSubscription,
    subscriptionId: string,
    pending: PendingOwnership,
  ): void => {
    const route = routedFrameEvents.get(routedEventKey(entry.kind, entry.target));
    if (!route) return;
    // CLI notification 可能先于 RPC subscribe response 抵达 host。旧实现
    // 直到 await 返回才登记 owner，早帧会被永久丢弃；同 topic 双端 pending 时也不能
    // 猜 owner。ACK 后只释放 ACK subscriptionId 对应帧，保留原到达顺序。
    for (const frame of pending.frames) {
      if (frame.subscriptionId === subscriptionId && ownsFrame(entry.kind, entry.target, frame)) {
        route.emitter.fire(frame);
      }
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };
  const invalidateWorkspaceRuntime = (
    invalidatedWorkspaceKey: string,
    generation: number,
  ): void => {
    runtimeGenerationByWorkspaceKey.set(invalidatedWorkspaceKey, generation);
    // runtime 内 subscription 已全部消失；本地 owner 直接 forget，不向新 runtime 清理。
    for (const entry of owned.values()) {
      if (workspaceKey(entry.target) === invalidatedWorkspaceKey) forget(entry);
    }
    const invalidatedPending = [...pendingByOwnership.values()]
      .flatMap((group) => [...group])
      .filter((pending) => workspaceKey(pending.target) === invalidatedWorkspaceKey);
    for (const pending of invalidatedPending) {
      pending.invalidatedByRuntimeRestart = true;
      // 从 routing group 摘除，避免旧 ACK 永不到达时继续为新 runtime 每帧积压；
      // pending 对象仍由原 Promise continuation 持有，可据 generation 拒绝迟到 ACK。
      removePendingOwnership(pending);
      pending.frames.length = 0;
      pending.stagedBytes = 0;
    }
  };

  return {
    entries: () => [...owned.values()],
    remember,
    forget,
    findBySubscription,
    ownsFrame,
    beginPendingOwnership,
    removePendingOwnership,
    discardPendingOwnership,
    routedEvent,
    flushPendingFrames,
    currentRuntimeGeneration: (invalidatedWorkspaceKey) =>
      runtimeGenerationByWorkspaceKey.get(invalidatedWorkspaceKey) ?? 0,
    invalidateWorkspaceRuntime,
    takeEntries: () => {
      const entries = Array.from(owned.values());
      owned.clear();
      routeKeyByOwnership.clear();
      return entries;
    },
    clearPending: () => {
      for (const group of pendingByOwnership.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = null;
        }
      }
      pendingByOwnership.clear();
    },
    disposeRoutedEvents: () => {
      for (const route of routedFrameEvents.values()) {
        route.upstream.dispose();
        route.emitter.dispose();
      }
      routedFrameEvents.clear();
    },
    clearRuntimeGenerations: () => {
      runtimeGenerationByWorkspaceKey.clear();
    },
  };
}
