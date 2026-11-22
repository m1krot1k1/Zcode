import {
  ChannelClient,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** 建立连接阶段的有界重试策略（指数退避）。 */
export interface WebSocketReconnectOptions {
  /** 最多尝试次数（含首次），默认 3，上限 10。 */
  attempts?: number;
  /** 首次重试等待，默认 500ms。 */
  initialDelayMs?: number;
  /** 单次退避上限，默认 5000ms。 */
  maxDelayMs?: number;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  /**
   * 仅覆盖「建立连接阶段」的重试；连接建立后不再透明重连。
   * 透明重连需要重放 in-flight RPC 与事件订阅，`ChannelClient` 绑定在固定
   * `SocketProtocol` 上无法安全迁移，因此连接建立后的关闭通过 `onClose` 通知调用方重建。
   * 传 `false` 关闭重试（只尝试一次）。
   */
  reconnect?: WebSocketReconnectOptions | false;
  /** 每次重试前的观测钩子；不要把包含 token 的 URL 写进日志。 */
  onReconnect?: (info: { attempt: number; delayMs: number; error: Error }) => void;
}

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;
/** WebSocket.OPEN；不依赖实例/构造器的静态常量，便于非浏览器宿主替换实现。 */
const WEB_SOCKET_OPEN = 1;

/** 连接建立后关闭/出错时用于拒绝挂起 RPC 的错误。 */
export class WebSocketConnectionClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(wsUrl: string, event: WebSocketConnectionCloseEvent) {
    super(
      event.reason
        ? `WebSocket connection closed: ${event.reason}`
        : `WebSocket connection closed (${event.code}): ${wsUrl}`,
    );
    this.name = "ConnectionClosed";
    this.code = event.code;
    this.reason = event.reason;
  }
}

/** 向非 OPEN 的 socket 写入是编程错误，必须显式失败而不是静默丢帧。 */
export class WebSocketNotOpenError extends Error {
  constructor(wsUrl: string, readyState: number) {
    super(`Cannot write to WebSocket (${wsUrl}): readyState ${readyState} is not OPEN`);
    this.name = "WebSocketNotOpenError";
  }
}

export function wrapBrowserWebSocket(
  ws: WebSocket,
  wsUrl: string,
  onTerminated: (event: WebSocketConnectionCloseEvent) => void = () => {},
): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let terminated = false;

  // close 与 error 可能先后各触发一次；只对外通知一次，避免调用方重复释放。
  const terminate = (event: WebSocketConnectionCloseEvent) => {
    if (terminated) return;
    terminated = true;
    onClose.fire();
    onEnd.fire();
    onTerminated(event);
  };

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", (event) => {
    terminate({ code: event.code, reason: event.reason, wasClean: event.wasClean });
  });
  ws.addEventListener("error", () => {
    terminate({ code: 1006, reason: "", wasClean: false });
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      // 旧实现直接丢弃非 OPEN 状态的数据，上层 RPC 会永远等不到响应；
      // 这里改成显式错误，让调用方看到真实的传输状态（ChannelClient 会继续 fail-closed）。
      if (ws.readyState !== WEB_SOCKET_OPEN) {
        throw new WebSocketNotOpenError(wsUrl, ws.readyState);
      }
      ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
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

export function connectViaWebSocket(
  wsUrl: string,
  options: WebSocketConnectionOptions = {},
): Promise<IServiceAccessor> {
  const policy = resolveReconnectPolicy(options.reconnect);

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const scheduleRetry = (error: Error): void => {
      if (settled) return;
      attempt += 1;
      if (attempt >= policy.attempts) {
        fail(error);
        return;
      }
      const delayMs = Math.min(policy.initialDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      options.onReconnect?.({ attempt, delayMs, error });
      setTimeout(() => {
        openAttempt();
      }, delayMs);
    };

    const openAttempt = (): void => {
      if (settled) return;
      let attemptSettled = false;
      let opened = false;
      const ws = new WebSocket(wsUrl);
      const failAttempt = (error: Error): void => {
        if (attemptSettled) return;
        attemptSettled = true;
        // 尚未 open 的 attempt 已无价值；主动关闭，避免失败实例挂到超时。
        if (ws.readyState === 0 /* CONNECTING */) {
          try {
            ws.close();
          } catch {
            // 某些宿主在 CONNECTING 上 close 会抛错；失败本身已由 error/close 事件上报。
          }
        }
        scheduleRetry(error);
      };

      ws.addEventListener("error", () => {
        failAttempt(new Error(`WebSocket connection failed: ${wsUrl}`));
      });
      ws.addEventListener("close", (event) => {
        // 只有已建立的连接才向调用方广播 onClose：握手失败由 promise rejection/onReconnect
        // 表达；重试期间每次失败都触发 onClose 会让上层误判连接生命周期。
        if (opened) {
          options.onClose?.({
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
        }
        if (settled) return;
        failAttempt(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      });

      ws.addEventListener("open", () => {
        if (attemptSettled || settled) {
          ws.close();
          return;
        }
        attemptSettled = true;
        opened = true;
        settled = true;
        options.onOpenSocket?.(ws);

        let client: ChannelClient | undefined;
        const socket = wrapBrowserWebSocket(ws, wsUrl, (event) => {
          // 连接断开必须让挂起的 RPC 立即 settle，而不是永久等待不会到达的响应。
          client?.dispose(new WebSocketConnectionClosedError(wsUrl, event));
        });
        client = new ChannelClient(new SocketProtocol(socket));
        resolve(new RemoteServiceAccess(client));
      });
    };

    openAttempt();
  });
}

function resolveReconnectPolicy(option: WebSocketReconnectOptions | false | undefined): {
  attempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
} {
  if (option === false) {
    return { attempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
  }
  return {
    attempts: clampInteger(option?.attempts, 1, MAX_RECONNECT_ATTEMPTS, DEFAULT_RECONNECT_ATTEMPTS),
    initialDelayMs: clampInteger(
      option?.initialDelayMs,
      0,
      DEFAULT_RECONNECT_MAX_DELAY_MS,
      DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    ),
    maxDelayMs: clampInteger(
      option?.maxDelayMs,
      0,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_RECONNECT_MAX_DELAY_MS,
    ),
  };
}

function clampInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean } = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client, options);
}
