// AC3/AC4：会话断开重连的恢复裁决。
// 覆盖：同 epoch/seq 续传缺口的且终态只应用一次；保留窗淘汰 → snapshot；
// CLI 重启后的 stale epoch → snapshot 而非旧 run 续传；重复 attach 幂等；
// 同一 commandId 的 stop 只执行一次。publisher 细粒度裁决矩阵见
// conversation-topic-publisher.test.ts，gateway 帧调度见 v4-gateway.test.ts。
import type {
  EventId,
  SessionEvent,
  SessionEventType as SessionEventTypeUnion,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { ConversationSnapshot, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import {
  ConversationTopicPublisher,
  ConversationV4Gateway,
  ProductProjection,
} from "../src/zcode-protocol-v4/index.js";

class EventLog {
  private seq = 0;
  readonly events: SessionEvent[] = [];

  constructor(private readonly sessionId = "session-1") {}

  push(
    type: SessionEventTypeUnion,
    payload: unknown,
    opts: { turnId?: string } = {},
  ): SessionEvent {
    this.seq += 1;
    const event: SessionEvent = {
      id: `event-${this.seq}` as EventId,
      sessionId: this.sessionId as SessionId,
      turnId: opts.turnId as TurnId | undefined,
      type,
      timestamp: new Date(1_700_000_000_000 + this.seq * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: this.seq,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

function makeLog(turns: number, answerPrefix = "回答"): EventLog {
  const log = new EventLog();
  log.push(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  for (let turn = 1; turn <= turns; turn += 1) {
    const turnId = `turn-${turn}`;
    log.push(SessionEventType.TurnStarted, { turnNumber: turn, input: `任务 ${turn}` }, { turnId });
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_start", delta: "", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: `${answerPrefix} ${turn} 上半`, done: false },
      { turnId },
    );
    log.push(
      SessionEventType.ModelStreaming,
      { kind: "text_delta", delta: " 下半", done: false },
      { turnId },
    );
    log.push(
      SessionEventType.TurnComplete,
      {
        response: `${answerPrefix} ${turn}`,
        tokenCount: 10,
        toolCallCount: 0,
        duration: 100,
        resultType: "success",
      },
      { turnId },
    );
  }
  return log;
}

/** 客户端 apply 规则：snapshot 整体替换；deltas 要求 fromSeq === store.seq；重复帧忽略。 */
function clientApply(
  store: { seq: number; snapshot: ConversationSnapshot | null },
  frame: ConversationTopicFrame,
): void {
  expect(() => conversationTopicFrameSchema.parse(frame)).not.toThrow();
  if (frame.payload.kind === "snapshot") {
    store.snapshot = frame.payload.snapshot;
    store.seq = frame.toSeq;
    return;
  }
  if (frame.toSeq <= store.seq) return; // 迟到/重复帧，只应用一次
  expect(frame.fromSeq).toBe(store.seq);
  expect(store.snapshot).not.toBeNull();
  store.snapshot = {
    ...applyConversationDeltas(store.snapshot as ConversationSnapshot, frame.payload.deltas),
    seq: frame.toSeq,
  };
  store.seq = frame.toSeq;
}

function authoritativeSnapshot(
  events: readonly SessionEvent[],
  epoch = "epoch-1",
): ConversationSnapshot {
  const projection = new ProductProjection("session-1", epoch);
  for (const event of events) projection.applyEvent(event);
  return projection.getSnapshot();
}

describe("AC3：断线重连按 epoch/seq 续传且终态只应用一次", () => {
  it("disconnect → resume 补齐缺口与终态，重复帧不改状态，水位重订阅无初始帧", () => {
    const log = makeLog(2);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };

    // 在线跟到第 6 个事件（turn 1 已完成）。
    for (const event of log.events.slice(0, 6)) publisher.ingest(event);
    const first = publisher.subscribe({ connectionId: "conn-1" });
    clientApply(store, first.frame!);
    // 掉线：只作废订阅，事件继续产生（turn 1 终态 + turn 2）。
    publisher.unsubscribe(first.ack.subscriptionId, "conn-1");
    for (const event of log.events.slice(6)) publisher.ingest(event);

    const resumed = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: store.seq },
    });
    expect(resumed.ack.mode).toBe("resume");
    clientApply(store, resumed.frame!);

    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
    // 终态只应用一次：重复投递同一 recovery 帧不推进 seq。
    const appliedSeq = store.seq;
    const appliedSnapshot = store.snapshot;
    clientApply(store, resumed.frame!);
    expect(store.seq).toBe(appliedSeq);
    expect(store.snapshot).toBe(appliedSnapshot);
    const serialized = JSON.stringify(store.snapshot?.rows);
    expect(serialized.split("回答 2").length - 1).toBe(1);

    // 在水位重订阅幂等：resume 且无初始帧，旧 subId 被替换。
    const atWatermark = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: store.seq },
    });
    expect(atWatermark.ack.mode).toBe("resume");
    expect(atWatermark.frame).toBeNull();
    const repeated = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: store.seq },
    });
    expect(repeated.ack.mode).toBe("resume");
    expect(repeated.frame).toBeNull();
    expect(publisher.hasSubscription(atWatermark.ack.subscriptionId, "conn-1")).toBe(false);
    expect(publisher.hasSubscription(repeated.ack.subscriptionId, "conn-1")).toBe(true);
    expect(JSON.stringify(publisher.getSnapshot().rows)).toBe(serialized);
  });

  it("base.seq 掉出保留窗 → snapshot 重建权威终态", () => {
    const log = makeLog(3); // 16 个事件；retention=5 → floor=11
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", {
      now: () => 0,
      retention: 5,
    });
    for (const event of log.events) publisher.ingest(event);

    const result = publisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: 10 },
    });
    expect(result.ack.mode).toBe("snapshot");
    expect(result.frame!.fromSeq).toBe(0);
    expect(result.frame!.payload.kind).toBe("snapshot");

    const store = { seq: 0, snapshot: null as ConversationSnapshot | null };
    clientApply(store, result.frame!);
    expect(store.snapshot).toEqual(authoritativeSnapshot(log.events));
  });
});

describe("AC4：CLI 重启后的 stale epoch 只返回新 epoch snapshot", () => {
  it("旧 epoch base 不续传旧 run，snapshot 等于新 epoch 投影且不含旧行", () => {
    const oldLog = makeLog(1, "旧回答");
    const oldPublisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of oldLog.events) oldPublisher.ingest(event);
    const oldStore = { seq: 0, snapshot: null as ConversationSnapshot | null };
    clientApply(oldStore, oldPublisher.subscribe({ connectionId: "conn-1" }).frame!);
    expect(oldStore.seq).toBe(oldLog.events.length);

    // CLI 重启：新进程新 epoch，旧 publisher 已消失。
    const newLog = makeLog(1, "新回答");
    const newPublisher = new ConversationTopicPublisher("session-1", "epoch-2", { now: () => 0 });
    for (const event of newLog.events) newPublisher.ingest(event);

    const result = newPublisher.subscribe({
      connectionId: "conn-1",
      base: { logEpoch: "epoch-1", seq: oldStore.seq },
    });
    expect(result.ack.mode).toBe("snapshot");
    expect(result.ack.logEpoch).toBe("epoch-2");
    expect(result.frame!.fromSeq).toBe(0);

    clientApply(oldStore, result.frame!);
    expect(oldStore.snapshot).toEqual(authoritativeSnapshot(newLog.events, "epoch-2"));
    expect(JSON.stringify(oldStore.snapshot?.rows)).not.toContain("旧回答");
  });
});

describe("AC5：同一 commandId 的 stop 只执行一次", () => {
  it("重复 stop 命令返回 duplicate 且只触发一次取消", async () => {
    const executed: string[] = [];
    const gateway = new ConversationV4Gateway(
      {
        sessionExists: (sessionId) => sessionId === "session-1",
        emitWireFrame: () => {},
        executeCommand: async (envelope) => {
          executed.push(`${envelope.type}:${envelope.commandId}`);
          return undefined;
        },
      },
      { now: () => 1_700_000_000_000, createLogEpoch: () => "epoch-1" },
    );
    const stop = {
      commandId: "stop-1",
      clientId: "client-1",
      sessionId: "session-1",
      type: "stop",
      payload: {},
      issuedAt: 1_700_000_000_000,
    };
    try {
      const first = await gateway.handleCommand(stop);
      const second = await gateway.handleCommand(stop);
      expect(first.status).toBe("accepted");
      expect(second.status).toBe("duplicate");
      expect(executed).toEqual(["stop:stop-1"]);
    } finally {
      gateway.dispose();
    }
  });
});
