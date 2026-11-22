import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VSBuffer } from "@zcode/rpc";
import {
  connectViaWebSocket,
  WebSocketConnectionClosedError,
  WebSocketNotOpenError,
  wrapBrowserWebSocket,
} from "../src/websocket.js";

type Listener = (event: unknown) => void;

/**
 * 最小 WebSocket 替身：只实现客户端实际使用的 readyState / addEventListener / send / close。
 * 真正的 TCP 握手对本文件无意义，测试关注的是生命周期与失败路径。
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: ArrayBuffer): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("WebSocket is not open");
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "", wasClean: true });
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  fail(code = 1006, reason = "socket lost"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason, wasClean: false });
  }

  failWithError(): void {
    this.emit("error", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitForInstance(ordinal: number): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const instance = FakeWebSocket.instances[ordinal - 1];
    if (instance) return instance;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`FakeWebSocket instance #${ordinal} was never created`);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectViaWebSocket", () => {
  it("rejects pending RPC when the established connection closes", async () => {
    const promise = connectViaWebSocket("ws://127.0.0.1/ws", { reconnect: false });
    const ws = await waitForInstance(1);
    ws.open();
    const services = await promise;

    const pending = services.settingService.get();
    // RPC 未收到 Initialize/响应前保持 pending；关闭必须把它从等待中释放。
    ws.fail(1006, "server restart");

    await expect(pending).rejects.toBeInstanceOf(WebSocketConnectionClosedError);
    await expect(pending).rejects.toMatchObject({
      name: "ConnectionClosed",
      code: 1006,
      reason: "server restart",
    });
  });

  it("rejects pending RPC when the transport reports an error", async () => {
    const promise = connectViaWebSocket("ws://127.0.0.1/ws", { reconnect: false });
    const ws = await waitForInstance(1);
    ws.open();
    const services = await promise;

    const pending = services.settingService.get();
    ws.failWithError();

    await expect(pending).rejects.toMatchObject({ name: "ConnectionClosed", code: 1006 });
  });

  it("fails explicitly when writing without an open connection", () => {
    const ws = new FakeWebSocket("ws://127.0.0.1/ws");
    const socket = wrapBrowserWebSocket(ws, ws.url);

    expect(() => socket.write(VSBuffer.alloc(1))).toThrow(WebSocketNotOpenError);
    expect(() => socket.write(VSBuffer.alloc(1))).toThrow(/is not OPEN/u);

    ws.open();
    socket.write(VSBuffer.alloc(2));
    expect(ws.sent).toHaveLength(1);

    ws.readyState = FakeWebSocket.CLOSED;
    expect(() => socket.write(VSBuffer.alloc(1))).toThrow(WebSocketNotOpenError);
    expect(ws.sent).toHaveLength(1);
  });

  it("retries the handshake with bounded backoff before giving up", async () => {
    const promise = connectViaWebSocket("ws://127.0.0.1/ws", {
      reconnect: { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
    });

    const first = await waitForInstance(1);
    first.fail();
    const second = await waitForInstance(2);
    second.fail(1006, "still down");
    const third = await waitForInstance(3);
    third.open();

    const services = await promise;
    expect(services.settingService).toBeDefined();
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("rejects clearly after exhausting the reconnect budget", async () => {
    const promise = connectViaWebSocket("ws://127.0.0.1/ws", {
      reconnect: { attempts: 2, initialDelayMs: 1, maxDelayMs: 2 },
    });

    (await waitForInstance(1)).fail(1006, "refused");
    (await waitForInstance(2)).fail(1006, "refused again");

    await expect(promise).rejects.toThrow(/WebSocket closed before ready/u);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not retry when reconnect is disabled", async () => {
    const promise = connectViaWebSocket("ws://127.0.0.1/ws", { reconnect: false });
    (await waitForInstance(1)).fail(1006, "offline");

    await expect(promise).rejects.toThrow(/offline/u);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("only reports onClose for established connections", async () => {
    const onClose = vi.fn();
    const failed = connectViaWebSocket("ws://127.0.0.1/ws", {
      onClose,
      reconnect: false,
    });
    (await waitForInstance(1)).fail();
    await expect(failed).rejects.toThrow();
    expect(onClose).not.toHaveBeenCalled();

    const connected = connectViaWebSocket("ws://127.0.0.1/ws", { onClose, reconnect: false });
    const ws = await waitForInstance(2);
    ws.open();
    await connected;
    ws.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: "", wasClean: true });
  });
});
