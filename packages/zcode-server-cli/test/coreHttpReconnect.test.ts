// Real Core HTTP/WS transport, connection scope and RPC client with a fake agent
// runtime: closing the desktop socket must dispose subscriptions without invoking
// abort/dispose teardown, and a reconnect carrying a base must return the final frame.
// Publisher/snapshot semantics are covered by
// apps/zcode-cli/packages/bootstrap/tests/session-survival-reconnect.test.ts;
// the real CLI runtime is not started here.
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  ProxyChannel,
  type ISocket,
} from "@zcode/rpc";
import { IZCodeAgentService, ServiceCollection } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createCoreHttpServer } from "../src/server-core/http.js";

const CAPABILITY_HEADER = "x-zcode-rpc-host-capability";
const EPOCH = "epoch-1";
const COMPLETION_DELAY_MS = 250;

function wrapClientWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

interface DesktopClient {
  service: IZCodeAgentService;
  dispose(): void;
}

async function openDesktopClient(base: string): Promise<DesktopClient> {
  const response = await fetch(`${base}/api/rpc-host-capability`, { method: "POST" });
  const { capability } = (await response.json()) as { capability: string };
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/host`, {
    headers: { [CAPABILITY_HEADER]: capability },
  });
  // Initialize frame is pushed right after upgrade; install the RPC listener before open.
  const client = new ChannelClient(new SocketProtocol(wrapClientWebSocket(socket)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, res) =>
      reject(new Error(`unexpected ${res.statusCode}`)),
    );
    socket.once("error", reject);
  });
  return {
    service: ProxyChannel.toService<IZCodeAgentService>(
      client.getChannel(IZCodeAgentService.channelName),
    ),
    dispose() {
      client.dispose();
      socket.close();
    },
  };
}

function conversationFrame(fromSeq: number, toSeq: number, text: string) {
  return {
    topic: "conversation",
    sessionId: "session-1",
    workspacePath: "/work",
    fromSeq,
    toSeq,
    payload: {
      kind: "deltas",
      deltas: [{ op: "row.upserted", row: { rowId: 1, kind: "assistant", text } }],
    },
  };
}

function createAgentRuntime() {
  const state = {
    runs: 0,
    completed: 0,
    cancelled: 0,
    aborted: false,
    subscriptions: new Set<string>(),
    unsubscribeCalls: 0,
    subscribeCalls: 0,
    /** Все вызовы base service в порядке поступления (для проверки teardown). */
    methodCalls: [] as string[],
  };
  const emitter = new Emitter<unknown>();
  let nextSub = 1;
  // Инъектируемый abort hook: connection scope держит Proxy над base service,
  // поэтому прямой abort-вызов teardown'а был бы зафиксирован здесь.
  // Completion завязан на abort: abort снимает таймер, поэтому рост `completed`
  // после close доказывает, что turn не был отменён.
  const completionTimers = new Set<ReturnType<typeof setTimeout>>();
  const abortActiveTurn = vi.fn(async () => {
    state.aborted = true;
    for (const timer of completionTimers) clearTimeout(timer);
    completionTimers.clear();
  });
  // Реальные teardown-методы IZCodeAgentService: connection-scope dispose не должен их звать.
  const disposeWorkspace = vi.fn(async () => undefined);
  const disposeAll = vi.fn(() => undefined);
  const service = {
    abortActiveTurn,
    disposeWorkspace,
    disposeAll,
    helloConversationV4: async () => ({}) as never,
    initializeConversationV4: async () => {},
    setConnectionFlowStateV4: async () => {},
    onDynamicConversationFrame: () => emitter.event,
    onDynamicSessionEvent: () => emitter.event,
    queryConversationCommandsV4: async () => ({ results: [] }),
    subscribeConversationV4: async (params: unknown) => {
      state.subscribeCalls += 1;
      const id = `sub-${nextSub++}`;
      state.subscriptions.add(id);
      const base = (params as { base?: { logEpoch?: string; seq?: number } } | undefined)?.base;
      if (base?.logEpoch === EPOCH && typeof base.seq === "number" && base.seq >= 0) {
        return {
          subscriptionId: id,
          ack: { subscriptionId: id, mode: "resume", logEpoch: EPOCH },
          initialFrame: conversationFrame(base.seq, 2, "final answer"),
        };
      }
      return {
        subscriptionId: id,
        ack: { subscriptionId: id, mode: "snapshot", logEpoch: EPOCH },
        initialFrame: conversationFrame(0, 2, "final answer"),
      };
    },
    resyncConversationV4: async () => ({
      ack: { mode: "snapshot", logEpoch: EPOCH },
      frame: conversationFrame(0, 2, "final answer"),
    }),
    unsubscribeConversationV4: async (params: { subscriptionId: string }) => {
      state.unsubscribeCalls += 1;
      state.subscriptions.delete(params.subscriptionId);
    },
    sendConversationCommandV4: async (params: unknown) => {
      const command = (params as { command?: { type?: string; commandId?: string } }).command;
      if (command?.type === "stop") {
        state.cancelled += 1;
      } else {
        state.runs += 1;
        // Turn завершается сам, только если его не отменили: abortActiveTurn
        // очищает этот таймер, поэтому completed=1 после close — осмысленный факт.
        const timer = setTimeout(() => {
          completionTimers.delete(timer);
          state.completed += 1;
        }, COMPLETION_DELAY_MS);
        completionTimers.add(timer);
      }
      return { status: "accepted", commandId: command?.commandId ?? "command" };
    },
  };
  // Recorder: любой метод, вызванный через connection scope, попадает в methodCalls.
  const recordedService = new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        state.methodCalls.push(String(property));
        return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { state, service: recordedService, abortActiveTurn, disposeWorkspace, disposeAll };
}

/** Direct abort/teardown methods, which connection close must never invoke. */
const ABORT_LIKE_TEARDOWN_METHOD = /abort|cancel|interrupt|stop|dispose|shutdown|deactivate/i;

function expectNoDirectAbort(
  runtime: ReturnType<typeof createAgentRuntime>,
  teardownStart: number,
): void {
  const teardownCalls = runtime.state.methodCalls.slice(teardownStart);
  expect(teardownCalls).toContain("unsubscribeConversationV4");
  // Только unsubscribe/flow-control: ни abort, ни disposeWorkspace/disposeAll.
  expect(teardownCalls.filter((name) => ABORT_LIKE_TEARDOWN_METHOD.test(name))).toEqual([]);
  expect(runtime.abortActiveTurn).not.toHaveBeenCalled();
  expect(runtime.disposeWorkspace).not.toHaveBeenCalled();
  expect(runtime.disposeAll).not.toHaveBeenCalled();
}

const subscribeParams = (base?: { logEpoch: string; seq: number }) => ({
  workspacePath: "/work",
  workspaceIdentity: "server://work",
  sessionId: "session-1",
  deliveryProfile: "continuous",
  ...(base ? { base } : {}),
});

const commandParams = {
  workspacePath: "/work",
  workspaceIdentity: "server://work",
  command: {
    sessionId: "session-1",
    commandId: "command-1",
    clientId: "desktop-1",
    type: "sendText",
    payload: { text: "long running task" },
  },
};

describe("Core WS reconnect survival", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("close disposed subscriptions without aborting active turn; reconnect with base returns final frame", async () => {
    const runtime = createAgentRuntime();
    const server = await createCoreHttpServer(
      new ServiceCollection().register(IZCodeAgentService, runtime.service as never),
    );
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;

    const first = await openDesktopClient(base);
    await first.service.subscribeConversationV4(subscribeParams() as never);
    await first.service.sendConversationCommandV4(commandParams as never);
    // Turn ещё не завершён: completed=1 после close докажет, что close его не отменил.
    expect(runtime.state.completed).toBe(0);
    const teardownStart = runtime.state.methodCalls.length;
    // Disconnect while the fake runtime is still working.
    first.dispose();

    await vi.waitFor(() => expect(runtime.state.completed).toBe(1), { timeout: 5000 });
    expect(runtime.state.aborted).toBe(false);
    expect(runtime.state.cancelled).toBe(0);
    expect(runtime.state.runs).toBe(1);
    await vi.waitFor(() => expect(runtime.state.unsubscribeCalls).toBeGreaterThan(0));
    expectNoDirectAbort(runtime, teardownStart);

    const second = await openDesktopClient(base);
    const resumed = await second.service.subscribeConversationV4(
      subscribeParams({ logEpoch: EPOCH, seq: 1 }) as never,
    );
    expect(resumed.ack.mode).toBe("resume");
    expect(resumed.initialFrame?.toSeq).toBeGreaterThan(1);
    expect(JSON.stringify(resumed.initialFrame)).toContain("final answer");

    const third = await openDesktopClient(base);
    const again = await third.service.subscribeConversationV4(
      subscribeParams({ logEpoch: EPOCH, seq: 1 }) as never,
    );
    expect(again.ack.mode).toBe("resume");
    expect(runtime.state.runs).toBe(1);
    expect(runtime.state.completed).toBe(1);
    expect(runtime.state.cancelled).toBe(0);
    second.dispose();
    third.dispose();
  });

  it("close without an active turn releases the connection subscriptions", async () => {
    const runtime = createAgentRuntime();
    const server = await createCoreHttpServer(
      new ServiceCollection().register(IZCodeAgentService, runtime.service as never),
    );
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    const client = await openDesktopClient(base);
    await client.service.subscribeConversationV4(subscribeParams() as never);
    expect(runtime.state.subscriptions.size).toBe(1);
    const teardownStart = runtime.state.methodCalls.length;
    client.dispose();
    await vi.waitFor(() => expect(runtime.state.subscriptions.size).toBe(0));
    expect(runtime.state.runs).toBe(0);
    expect(runtime.state.cancelled).toBe(0);
    expect(runtime.state.aborted).toBe(false);
    expectNoDirectAbort(runtime, teardownStart);
  });

  it("abort hook prevents completion, so the survival assertion is not vacuous", async () => {
    const runtime = createAgentRuntime();
    await runtime.service.sendConversationCommandV4(commandParams as never);
    await runtime.abortActiveTurn();
    await new Promise<void>((resolve) => setTimeout(resolve, COMPLETION_DELAY_MS * 2));
    expect(runtime.state.aborted).toBe(true);
    expect(runtime.state.completed).toBe(0);
  });
});
