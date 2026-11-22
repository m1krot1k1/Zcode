import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import {
  resolveFrameByteLimit,
  RpcFrameLimitError,
  type IMessagePassingProtocol,
} from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

interface ChannelServerOptions {
  /**
   * 单个入站 Channel 消息上限；只能收紧，不能超过 MAX_FRAME_BYTES。
   * 默认与传输层硬上限一致，保证两层不会出现两套极限。
   */
  maxFrameBytes?: number;
  /**
   * oversize 消息的观测点。使用 MessagePort 时 transport 不做帧检查，
   * 这里是唯一能拿到 typed error 的位置；回调抛错不会影响服务端。
   */
  onFrameError?: (error: Error) => void;
}

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;
  private readonly maxFrameBytes: number;
  private readonly onFrameError?: (error: Error) => void;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
    options: ChannelServerOptions = {},
  ) {
    this.maxFrameBytes = resolveFrameByteLimit(options.maxFrameBytes);
    this.onFrameError = options.onFrameError;
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private reportFrameError(error: Error): void {
    if (!this.onFrameError) {
      return;
    }
    try {
      this.onFrameError(error);
    } catch {
      // 观测点不得反向影响服务端：调用方回调抛错按既有 send() 的 noop 语义吞掉。
    }
  }

  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    const frame = writer.buffer;
    // ChannelServer 有自己的上限（默认同为 MAX_FRAME_BYTES，只能收紧），必须先拦一道：
    // 反序列化后的帧大小与传输层 payload 不是同一对象，不能假设 transport 一定比本层更严。
    if (frame.byteLength > this.maxFrameBytes) {
      this.reportFrameError(new RpcFrameLimitError(frame.byteLength, this.maxFrameBytes));
      return;
    }
    try {
      this.protocol.send(frame);
    } catch (error) {
      // 保留原有「发送失败不打断调用」语义；但 oversize 响应必须可观测，
      // 否则客户端会永远等待一个到不了的 Promise。
      if (error instanceof RpcFrameLimitError) {
        this.reportFrameError(error);
      }
    }
  }

  private onRawMessage(message: VSBuffer): void {
    // 超限消息直接忽略：反序列化会按声明的 VQL 长度分配内存，不能先解析再判断。
    if (message.byteLength > this.maxFrameBytes) {
      this.reportFrameError(new RpcFrameLimitError(message.byteLength, this.maxFrameBytes));
      return;
    }

    let header: unknown;
    let body: unknown;
    try {
      const reader = new BufferReader(message);
      header = deserialize(reader);
      body = deserialize(reader);
    } catch {
      // 损坏的 Channel 消息不能把异常抛进 protocol 的 onMessage 监听器：
      // 那会从 socket/port 回调逃逸并终结整个连接。按既有契约静默丢弃。
      return;
    }

    if (!Array.isArray(header) || typeof header[0] !== "number") {
      // 未知/损坏 tag（deserialize 对未知 DataType 返回 undefined）没有可路由的请求，
      // 保持旧开关语义：不响应、不断连接。
      return;
    }

    const type = header[0] as RequestType;
    const requestId = header[1];
    const channelName = header[2];
    const requestName = header[3];

    switch (type) {
      case RequestType.Promise:
      case RequestType.EventListen:
        // 路由需要 id/channelName/name；缺失时 onPromise 会把 undefined 当 channel 名，
        // 静默进入 pending 队列。这里直接按未知 tag 丢弃。
        if (
          typeof requestId !== "number" ||
          typeof channelName !== "string" ||
          typeof requestName !== "string"
        ) {
          return;
        }
        if (type === RequestType.Promise) {
          this.onPromise({
            type,
            id: requestId,
            channelName,
            name: requestName,
            arg: body,
          });
        } else {
          this.onEventListen({
            type,
            id: requestId,
            channelName,
            name: requestName,
            arg: body,
          });
        }
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        if (typeof requestId !== "number") {
          return;
        }
        this.disposeActiveRequest(requestId);
        return;
    }
  }

  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
              retryable?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
              "retryable",
            ] as const;
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const disposable = channel.listen(
      this.ctx,
      request.name,
      request.arg,
    )((data) => {
      this.sendResponse({
        id: request.id,
        data,
        type: ResponseType.EventFire,
      });
    });
    this.activeRequests.set(request.id, disposable);
  }

  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type !== RequestType.Promise) {
        return;
      }

      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type: ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
  }
}
