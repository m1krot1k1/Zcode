/**
 * Layer 2: 传输协议抽象
 *
 * IMessagePassingProtocol 是整个 IPC 框架的"腰部"——
 * 它上面是 Channel RPC 层（完全传输无关），
 * 它下面是各种具体传输实现（Electron/MessagePort/Socket/ChildProcess）。
 *
 * 只要实现 send() 和 onMessage，就能接入整个 RPC 框架。
 */

import { VSBuffer } from "./buffer.js";
import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";

// ============================================================================
// 核心传输接口
// ============================================================================

/**
 * IMessagePassingProtocol —— 整个框架的核心抽象
 *
 * 这就是 VS Code 通信能力的秘密：上层代码只看到 send/onMessage，
 * 不管底层是 Electron IPC、MessagePort、WebSocket 还是 TCP Socket。
 */
export interface IMessagePassingProtocol {
  send(buffer: VSBuffer): void;
  readonly onMessage: Event<VSBuffer>;
  /**
   * 可选诊断事件：传输层发现的帧级错误（目前只有 oversize frame）。
   * 不实现它的第三方协议仍然兼容；实现方必须保证错误不会以异常形式从 onData 逃逸。
   */
  readonly onError?: Event<Error>;
  drain?(): Promise<void>;
}

/**
 * 单个 RPC 帧 payload 的硬上限（不含 13 字节 header）。
 *
 * 取值依据（当前生产 payload 的最大值）：
 * - plugin sync 归档默认上限 50 MiB（packages/services/src/plugin-sync/pluginSyncService.ts）。
 *   归档以对象参数 `{ archive: Uint8Array, ... }` 传输，serialization 会把嵌套
 *   Uint8Array 转成 base64（packages/rpc/src/serialization.ts 的
 *   __zcode_rpc_nested_uint8array_v1 标记），实际帧约为 50 MiB × 4/3 ≈ 66.7 MiB 再加 JSON 外壳；
 * - skill sync 归档默认上限 20 MiB（packages/services/src/skill-sync/skillSyncService.ts）；
 * - web remote transport 单条消息上限 16 MiB
 *   （packages/shared/src/web-remote-control-rpc-transport.ts）；
 * - 附件分片 512 KiB（PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes）。
 *
 * 96 MiB 让最大归档连 base64 与 JSON 外壳一起通过，并给协议头/键名留出余量，
 * 同时仍然限制单个未读帧可占用的内存。
 * `PROTOCOL_V4_LIMITS.maxFrameBytes` 是 v4 物理投递帧的上限，不是本层传输帧上限，
 * 不能直接复用：它远小于 sync 归档。
 */
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;

export const RPC_FRAME_TOO_LARGE = "RPC_FRAME_TOO_LARGE" as const;

/**
 * oversize frame 的类型化错误。
 * 由协议层通过 onError 发布，或由 writeProtocolMessage 在发送超限帧时抛出。
 */
export class RpcFrameLimitError extends Error {
  readonly code = RPC_FRAME_TOO_LARGE;

  constructor(
    readonly frameLength: number,
    readonly maxFrameBytes: number,
  ) {
    super(`RPC frame length ${frameLength} exceeds the ${maxFrameBytes} byte limit`);
    this.name = "RpcFrameLimitError";
  }
}

/**
 * 归一化调用方传入的帧上限：只能收紧，不能突破 MAX_FRAME_BYTES。
 * 非法值（0、负数、小数、NaN、Infinity）直接失败，不做静默 fallback。
 */
export function resolveFrameByteLimit(maxFrameBytes?: number): number {
  if (maxFrameBytes === undefined) {
    return MAX_FRAME_BYTES;
  }
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError(
      `maxFrameBytes must be a positive safe integer, received ${String(maxFrameBytes)}`,
    );
  }
  return Math.min(maxFrameBytes, MAX_FRAME_BYTES);
}

/**
 * 连接级只读流控观察面。
 *
 * transport 负责维护未确认字节与状态边沿；业务层只能订阅，不能伪造 ACK 或直接改水位。
 */
export interface ConnectionFlowControl {
  readonly unacknowledgedBytes: number;
  readonly onSaturated: Event<void>;
  readonly onDrained: Event<void>;
}

export type MessagePortFlowState = "saturated" | "drained";

export interface MessagePortFlowControl {
  __zcodeRpcControl: "connection-flow-v1";
  state: MessagePortFlowState;
}

export type MessagePortPayload = Uint8Array | MessagePortFlowControl;

function isMessagePortFlowControl(value: unknown): value is MessagePortFlowControl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    // 二进制载荷可能有数百万字节；先看控制标记，避免为排除普通消息逐字节枚举。
    record.__zcodeRpcControl === "connection-flow-v1" &&
    (record.state === "saturated" || record.state === "drained") &&
    Object.keys(record).length === 2
  );
}

// ============================================================================
// Socket 接口（用于 TCP/WebSocket 等流式传输）
// ============================================================================

/**
 * ISocket 抽象了底层的网络 socket。
 * 在 Node.js 环境是 net.Socket，在浏览器环境是 WebSocket。
 */
export interface ISocket extends IDisposable {
  onData: Event<VSBuffer>;
  onClose: Event<void>;
  onEnd: Event<void>;
  write(buffer: VSBuffer): void;
  end(): void;
  drain(): Promise<void>;
}

// ============================================================================
// ChunkStream —— 处理 TCP 的分片和粘包
// ============================================================================

/**
 * TCP 是流式协议，一次 write 不代表对面一次 read 就能完整收到。
 * ChunkStream 把收到的碎片攒起来，按需读取指定字节数。
 */
export class ChunkStream {
  private chunks: VSBuffer[] = [];
  private totalLength = 0;

  get byteLength(): number {
    return this.totalLength;
  }

  acceptChunk(chunk: VSBuffer): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.byteLength;
  }

  /**
   * 预览前 byteCount 字节，但不消费底层缓冲。
   *
   * Socket/stdio 传输天然可能分片。
   * 之前协议层在 body 还没收全时就先把 header read 掉，后续再来的 body
   * 会失去对应的帧头，导致消息永远卡住。这里提供 peek，让调用方先判断
   * “整帧是否已经到齐”，确认足够后再真正消费。
   */
  peek(byteCount: number): VSBuffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }

    if (this.chunks[0].byteLength >= byteCount) {
      return this.chunks[0].slice(0, byteCount);
    }

    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= byteCount) {
        break;
      }

      const remaining = byteCount - offset;
      const copyLength = Math.min(chunk.byteLength, remaining);
      result.set(copyLength === chunk.byteLength ? chunk : chunk.slice(0, copyLength), offset);
      offset += copyLength;
    }

    return result;
  }

  /** 丢弃前 byteCount 字节 */
  skip(byteCount: number): void {
    const discarded = this.read(byteCount);
    if (!discarded) {
      throw new Error(`ChunkStream.skip(${byteCount}) 超出可读范围`);
    }
  }

  /**
   * 流式丢弃前 byteCount 字节，不拼接、不复制。
   *
   * oversize frame 的 payload 可能声明到 4 GiB：用 read() 会先 alloc(byteCount)，
   * 这里只按已到达的 chunk 逐段丢弃，返回真正丢弃的字节数，剩下等后续 chunk。
   */
  discard(byteCount: number): number {
    let remaining = Math.max(0, Math.min(byteCount, this.totalLength));
    let discarded = 0;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) {
        break;
      }
      if (chunk.byteLength <= remaining) {
        this.chunks.shift();
        this.totalLength -= chunk.byteLength;
        remaining -= chunk.byteLength;
        discarded += chunk.byteLength;
        continue;
      }
      this.chunks[0] = chunk.slice(remaining);
      this.totalLength -= remaining;
      discarded += remaining;
      remaining = 0;
    }
    return discarded;
  }

  /** 读取 byteCount 字节，不够就返回 null */
  read(byteCount: number): VSBuffer | null {
    if (this.totalLength < byteCount) {
      return null;
    }

    if (this.chunks[0].byteLength === byteCount) {
      const result = this.chunks.shift()!;
      this.totalLength -= byteCount;
      return result;
    }

    if (this.chunks[0].byteLength > byteCount) {
      const result = this.chunks[0].slice(0, byteCount);
      this.chunks[0] = this.chunks[0].slice(byteCount);
      this.totalLength -= byteCount;
      return result;
    }

    // 需要跨多个 chunk 拼接
    const result = VSBuffer.alloc(byteCount);
    let offset = 0;
    while (offset < byteCount) {
      const chunk = this.chunks[0];
      const needed = byteCount - offset;
      if (chunk.byteLength <= needed) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
        this.chunks.shift();
      } else {
        result.set(chunk.slice(0, needed), offset);
        this.chunks[0] = chunk.slice(needed);
        offset += needed;
      }
    }
    this.totalLength -= byteCount;
    return result;
  }
}

// ============================================================================
// Protocol —— 在 ISocket 上实现 IMessagePassingProtocol
// ============================================================================

/**
 * 消息帧格式 (13 bytes header):
 *
 * ┌─────────┬──────────┬──────────┬──────────────┐
 * │ type(1) │  id(4)   │  ack(4)  │  length(4)   │
 * └─────────┴──────────┴──────────┴──────────────┘
 *
 * type:   消息类型（Regular, Ack, KeepAlive 等）
 * id:     消息序号
 * ack:    确认号（告诉对方"我已收到你的消息到第 ack 号"）
 * length: payload 长度
 */
export enum ProtocolMessageType {
  None = 0,
  Regular = 1,
  Control = 2,
  Ack = 3,
  Disconnect = 5,
  ReplayRequest = 6,
  Pause = 7,
  Resume = 8,
  KeepAlive = 9,
}

export const HEADER_SIZE = 13; // 1 + 4 + 4 + 4

/** 两个流式协议实现共享同一个头解析，避免出现第二套帧格式。 */
export function readProtocolFrameHeader(header: VSBuffer): {
  type: ProtocolMessageType;
  id: number;
  ack: number;
  length: number;
} {
  return {
    type: header.readUInt8(0) as ProtocolMessageType,
    id: header.readUInt32BE(1),
    ack: header.readUInt32BE(5),
    length: header.readUInt32BE(9),
  };
}

export class ProtocolMessage {
  constructor(
    public readonly type: ProtocolMessageType,
    public readonly id: number,
    public readonly ack: number,
    public readonly data: VSBuffer,
  ) {}

  get byteLength(): number {
    return HEADER_SIZE + this.data.byteLength;
  }
}

export function writeProtocolMessage(msg: ProtocolMessage): VSBuffer {
  // 发送侧同样执行硬上限：避免一个超大 payload 先在本地 alloc 出整帧再交给 socket。
  if (msg.data.byteLength > MAX_FRAME_BYTES) {
    throw new RpcFrameLimitError(msg.data.byteLength, MAX_FRAME_BYTES);
  }
  const result = VSBuffer.alloc(HEADER_SIZE + msg.data.byteLength);
  result.writeUInt8(msg.type, 0);
  result.writeUInt32BE(msg.id, 1);
  result.writeUInt32BE(msg.ack, 5);
  result.writeUInt32BE(msg.data.byteLength, 9);
  result.set(msg.data, HEADER_SIZE);
  return result;
}

/**
 * 基础 Protocol: 在 ISocket 上加消息帧，实现 IMessagePassingProtocol。
 * 只做消息分帧，不做 ACK/重连（那是 PersistentProtocol 的事）。
 */
export class SocketProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  private readonly _onError = new Emitter<Error>();
  readonly onError = this._onError.event;

  private readonly chunkStream = new ChunkStream();
  private readonly disposables = new DisposableStore();
  private readonly maxFrameBytes: number;
  /** oversize frame 尚未到达的 payload 字节数；期间所有输入按顺序丢弃。 */
  private discardRemaining = 0;

  constructor(
    private socket: ISocket,
    options: { maxFrameBytes?: number } = {},
  ) {
    this.maxFrameBytes = resolveFrameByteLimit(options.maxFrameBytes);
    this.disposables.add(
      socket.onData((data) => {
        this.chunkStream.acceptChunk(data);
        // readMessages() 对任何畸形输入都只走 break/onError：未知 type 忽略、
        // 半帧继续等待、oversize 走 typed error，不把异常抛回 socket 回调。
        this.readMessages();
      }),
    );
  }

  send(buffer: VSBuffer): void {
    // 调用方把上限收紧后，发送侧也必须使用同一 effective limit。
    if (buffer.byteLength > this.maxFrameBytes) {
      throw new RpcFrameLimitError(buffer.byteLength, this.maxFrameBytes);
    }
    this.writeMessage(new ProtocolMessage(ProtocolMessageType.Regular, 0, 0, buffer));
  }

  private writeMessage(msg: ProtocolMessage): void {
    this.socket.write(writeProtocolMessage(msg));
  }

  private readMessages(): void {
    while (true) {
      if (this.discardRemaining > 0) {
        const discarded = this.chunkStream.discard(this.discardRemaining);
        this.discardRemaining -= discarded;
        if (this.discardRemaining > 0) {
          break;
        }
        continue;
      }

      const header = this.chunkStream.peek(HEADER_SIZE);
      if (!header) {
        break;
      }

      const { type, length } = readProtocolFrameHeader(header);

      // 先判长度、再等 body：否则对端只要声明一个巨大的 length 就能让我们
      // 无界缓存并等待 payload。
      if (length > this.maxFrameBytes) {
        this.chunkStream.skip(HEADER_SIZE);
        this.discardRemaining = length;
        this.emitError(new RpcFrameLimitError(length, this.maxFrameBytes));
        continue;
      }

      const totalFrameLength = HEADER_SIZE + length;
      if (this.chunkStream.byteLength < totalFrameLength) {
        // 不能在 body 未到齐时提前消费 header，否则下一段数据拼上来后
        // 已经找不到这帧的长度信息，调用方就会一直等待一个永远不会完成的 Promise。
        break;
      }

      this.chunkStream.skip(HEADER_SIZE);

      if (length === 0) {
        if (type === ProtocolMessageType.Regular) {
          this._onMessage.fire(VSBuffer.alloc(0));
        }
        continue;
      }

      const body = this.chunkStream.read(length);
      if (!body) {
        // 不可达：上面已确认 byteLength >= HEADER_SIZE + length。保留分支只为
        // 不把内部不变量错误抛进 socket 回调。
        break;
      }

      if (type === ProtocolMessageType.Regular) {
        this._onMessage.fire(body);
      }
    }
  }

  private emitError(error: Error): void {
    try {
      this._onError.fire(error);
    } catch {
      // 订阅者自己的异常不能反向变成协议异常：违反的只是观测约定，
      // 连接必须继续按同一字节流解析。
    }
  }

  async drain(): Promise<void> {
    return this.socket.drain();
  }

  dispose(): void {
    this.disposables.dispose();
    this._onMessage.dispose();
    this._onError.dispose();
  }
}

// ============================================================================
// QueueProtocol —— 内存中的协议对，用于测试
// ============================================================================

/**
 * 创建一对通过内存队列连接的 protocol，
 * 一端 send 的消息会出现在另一端的 onMessage。
 * 非常适合单元测试，不需要真正的网络连接。
 */
export function createQueuePair(): [IMessagePassingProtocol, IMessagePassingProtocol] {
  const emitterA = new Emitter<VSBuffer>();
  const emitterB = new Emitter<VSBuffer>();

  const protocolA: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // A 发送的消息 → B 收到
      setTimeout(() => emitterB.fire(buffer), 0);
    },
    onMessage: emitterA.event,
  };

  const protocolB: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      // B 发送的消息 → A 收到
      setTimeout(() => emitterA.fire(buffer), 0);
    },
    onMessage: emitterB.event,
  };

  return [protocolA, protocolB];
}

// ============================================================================
// MessagePort Protocol —— 用于 Web Worker / Electron sandbox
// ============================================================================

/**
 * MessagePort 接口的最小声明，
 * 使得这个 Protocol 可以同时在浏览器和 Electron 中使用。
 */
export interface MessagePortLike {
  addEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: MessagePortPayload }) => void): void;
  postMessage(message: MessagePortPayload): void;
  start(): void;
  close(): void;
}

/**
 * 在 MessagePort 上实现 IMessagePassingProtocol。
 * 这是最简单的传输实现——不需要分帧，因为 MessagePort 本身就是消息边界的。
 */
interface MessagePortProtocolOptions {
  /** 单个入站/出站消息上限；只能收紧，不能超过 MAX_FRAME_BYTES。 */
  maxFrameBytes?: number;
}

export class MessagePortProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage = this._onMessage.event;

  /**
   * MessagePort 没有帧头可校验，但消息仍有物理大小。入站超出有效上限时按同一 typed error
   * 通过 onError 观察；传输层无法阻止发送方已经把字节克隆过来，但能保证它们不进入
   * Channel 解析与后续内存放大。
   */
  private readonly _onError = new Emitter<Error>();
  readonly onError = this._onError.event;

  private readonly _onFlowState = new Emitter<MessagePortFlowState>();
  readonly onFlowState = this._onFlowState.event;

  private readonly maxFrameBytes: number;
  private readonly handler: (e: { data: MessagePortPayload }) => void;

  constructor(
    private port: MessagePortLike,
    options: MessagePortProtocolOptions = {},
  ) {
    this.maxFrameBytes = resolveFrameByteLimit(options.maxFrameBytes);
    this.handler = (e: { data: MessagePortPayload }) => {
      if (isMessagePortFlowControl(e.data)) {
        this._onFlowState.fire(e.data.state);
        return;
      }
      // MessagePort control object 不能进入 Channel deserialize；未知对象和伪造
      // connection-flow-v1 一律丢弃，只有真实 Uint8Array 才是 RPC binary。
      if (!(e.data instanceof Uint8Array)) return;
      if (e.data.byteLength > this.maxFrameBytes) {
        this.emitError(new RpcFrameLimitError(e.data.byteLength, this.maxFrameBytes));
        return;
      }
      this._onMessage.fire(VSBuffer.wrap(e.data));
    };
    this.port.addEventListener("message", this.handler);
    this.port.start();
  }

  send(buffer: VSBuffer): void {
    // MessagePort 保留消息边界，但没有帧头可校验：出站仍要执行同一有效上限，
    // 否则 Channel RPC 的上限只覆盖 Socket/Persistent 两条流式链路。
    if (buffer.byteLength > this.maxFrameBytes) {
      throw new RpcFrameLimitError(buffer.byteLength, this.maxFrameBytes);
    }
    this.port.postMessage(buffer.buffer);
  }

  sendFlowState(state: MessagePortFlowState): void {
    this.port.postMessage({ __zcodeRpcControl: "connection-flow-v1", state });
  }

  disconnect(): void {
    this.port.removeEventListener("message", this.handler);
    this.port.close();
    this._onMessage.dispose();
    this._onError.dispose();
    this._onFlowState.dispose();
  }

  private emitError(error: Error): void {
    try {
      this._onError.fire(error);
    } catch {
      // 与 SocketProtocol 相同：订阅者异常不能破坏端口上的消息边界。
    }
  }
}
