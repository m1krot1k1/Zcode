import { describe, expect, it, vi } from "vitest";
import { VSBuffer } from "../buffer.js";
import { ChannelServer } from "../channelServer.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "../serialization.js";
import { Emitter, Event } from "../foundation.js";
import {
  HEADER_SIZE,
  MAX_FRAME_BYTES,
  ProtocolMessageType,
  RPC_FRAME_TOO_LARGE,
  RpcFrameLimitError,
  SocketProtocol,
  resolveFrameByteLimit,
  type IMessagePassingProtocol,
  type ISocket,
} from "../protocol.js";
import { PersistentProtocol } from "../persistent-protocol.js";
import type { IServerChannel } from "../channels.shared.js";

class FakeSocket implements ISocket {
  private readonly dataEmitter = new Emitter<VSBuffer>();
  private readonly closeEmitter = new Emitter<void>();
  private readonly endEmitter = new Emitter<void>();
  onData = this.dataEmitter.event;
  onClose = this.closeEmitter.event;
  onEnd = this.endEmitter.event;
  readonly written: VSBuffer[] = [];

  write(buffer: VSBuffer): void {
    this.written.push(buffer);
  }

  emitData(buffer: VSBuffer): void {
    this.dataEmitter.fire(buffer);
  }

  end(): void {}
  async drain(): Promise<void> {}
  dispose(): void {
    this.dataEmitter.dispose();
    this.closeEmitter.dispose();
    this.endEmitter.dispose();
  }
}

function protocolFrame(
  type: ProtocolMessageType,
  payload: VSBuffer,
  options: { id?: number; ack?: number; declaredLength?: number } = {},
): VSBuffer {
  const frame = VSBuffer.alloc(HEADER_SIZE + payload.byteLength);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(options.id ?? 0, 1);
  frame.writeUInt32BE(options.ack ?? 0, 5);
  frame.writeUInt32BE(options.declaredLength ?? payload.byteLength, 9);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

function payloadOf(length: number, fill = 0x61): VSBuffer {
  return VSBuffer.wrap(new Uint8Array(length).fill(fill));
}

function headerOnly(length: number, type = ProtocolMessageType.Regular): VSBuffer {
  const header = VSBuffer.alloc(HEADER_SIZE);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(0, 1);
  header.writeUInt32BE(0, 5);
  header.writeUInt32BE(length, 9);
  return header;
}

function channelMessage(
  type: number,
  id: number,
  channelName?: string,
  name?: string,
  arg?: unknown,
): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, [type, id, channelName, name]);
  serialize(writer, arg);
  return writer.buffer;
}

class FakeProtocol implements IMessagePassingProtocol {
  private readonly emitter = new Emitter<VSBuffer>();
  readonly onMessage = this.emitter.event;
  readonly sent: VSBuffer[] = [];

  send(buffer: VSBuffer): void {
    this.sent.push(buffer);
  }

  emit(buffer: VSBuffer): void {
    this.emitter.fire(buffer);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

describe("MAX_FRAME_BYTES / resolveFrameByteLimit", () => {
  it("exposes a positive hard limit and clamps overrides down to it", () => {
    expect(MAX_FRAME_BYTES).toBe(96 * 1024 * 1024);
    expect(resolveFrameByteLimit()).toBe(MAX_FRAME_BYTES);
    expect(resolveFrameByteLimit(16)).toBe(16);
    expect(resolveFrameByteLimit(MAX_FRAME_BYTES + 1)).toBe(MAX_FRAME_BYTES);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %s instead of falling back",
    (value) => {
      expect(() => resolveFrameByteLimit(value)).toThrow(RangeError);
    },
  );

  it("applies the same validation to both stream protocols", () => {
    expect(() => new SocketProtocol(new FakeSocket(), { maxFrameBytes: 0 })).toThrow(RangeError);
    expect(() => new PersistentProtocol(new FakeSocket(), { maxFrameBytes: Number.NaN })).toThrow(
      RangeError,
    );
  });
});

describe("SocketProtocol frame bounds", () => {
  it("accepts a frame whose payload is exactly the limit", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    const errors = vi.fn();
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError(errors);

    socket.emitData(protocolFrame(ProtocolMessageType.Regular, payloadOf(16, 0x62)));

    expect(received).toEqual(["b".repeat(16)]);
    expect(errors).not.toHaveBeenCalled();
    protocol.dispose();
  });

  it("rejects limit + 1 with a typed error and never delivers it", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 16 });
    const received = vi.fn();
    const errors: unknown[] = [];
    protocol.onMessage(received);
    protocol.onError((error) => errors.push(error));
    const frame = protocolFrame(ProtocolMessageType.Regular, payloadOf(17));
    const alloc = vi.spyOn(VSBuffer, "alloc");
    try {
      socket.emitData(frame);

      expect(received).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      const error = errors[0];
      expect(error).toBeInstanceOf(RpcFrameLimitError);
      expect(error).toMatchObject({
        code: RPC_FRAME_TOO_LARGE,
        frameLength: 17,
        maxFrameBytes: 16,
        name: "RpcFrameLimitError",
      });
      // 拒绝路径不能按 length 去拼接 body。
      expect(alloc).not.toHaveBeenCalled();
    } finally {
      alloc.mockRestore();
      protocol.dispose();
    }
  });

  it("does not allocate the declared length for a huge length field", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 16 });
    const errors: unknown[] = [];
    protocol.onError((error) => errors.push(error));
    const alloc = vi.spyOn(VSBuffer, "alloc");
    try {
      socket.emitData(headerOnly(0xffffffff));
      // 继续喂少量字节：这些只会被流式丢弃，不能触发按声明长度的分配。
      socket.emitData(payloadOf(8));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(RpcFrameLimitError);
      expect(
        alloc.mock.calls.filter(([size]) => size === 0xffffffff || size >= 0xffffffff),
      ).toHaveLength(0);
      expect(
        alloc.mock.calls.every(([size]) => typeof size === "number" && size <= HEADER_SIZE),
      ).toBe(true);
    } finally {
      alloc.mockRestore();
      protocol.dispose();
    }
  });

  it("discards an oversize body without allocation and resumes on the next frame", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    const errors: unknown[] = [];
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError((error) => errors.push(error));
    // 帧在安装 spy 之前构造：这里只统计协议收到输入后的分配行为。
    const oversize = protocolFrame(ProtocolMessageType.Regular, payloadOf(32, 0x63));
    const next = protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("ok"));
    const alloc = vi.spyOn(VSBuffer, "alloc");
    try {
      socket.emitData(oversize);
      expect(received).toEqual([]);
      expect(errors).toHaveLength(1);
      // 旧实现会等 body 到齐后 read(32) → alloc(32)；新路径逐段丢弃不应分配新缓冲。
      expect(alloc).not.toHaveBeenCalled();

      socket.emitData(next);
      expect(received).toEqual(["ok"]);
      expect(errors).toHaveLength(1);
    } finally {
      alloc.mockRestore();
      protocol.dispose();
    }
  });

  it("keeps discarding a fragmented oversize body before resuming", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    const errors: unknown[] = [];
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError((error) => errors.push(error));
    const oversize = protocolFrame(ProtocolMessageType.Regular, payloadOf(32, 0x65));
    const next = protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("after"));

    socket.emitData(oversize.slice(0, HEADER_SIZE + 5));
    expect(errors).toHaveLength(1);
    expect(received).toEqual([]);

    socket.emitData(oversize.slice(HEADER_SIZE + 5));
    expect(received).toEqual([]);

    socket.emitData(next);
    expect(received).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    protocol.dispose();
  });

  it("ignores an unknown message type without throwing or delivering", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    protocol.onMessage((message) => received.push(message.toString()));

    expect(() => {
      socket.emitData(
        protocolFrame(200 as unknown as ProtocolMessageType, VSBuffer.fromString("ignored")),
      );
      socket.emitData(protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("kept")));
    }).not.toThrow();

    expect(received).toEqual(["kept"]);
    protocol.dispose();
  });

  it("delivers a byte-by-byte fragmented frame exactly once", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 64 });
    const received: string[] = [];
    protocol.onMessage((message) => received.push(message.toString()));
    const frame = protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("fragmented"));

    for (let offset = 0; offset < frame.byteLength; offset += 1) {
      socket.emitData(frame.slice(offset, offset + 1));
    }

    expect(received).toEqual(["fragmented"]);
    protocol.dispose();
  });

  it("waits for a truncated frame and delivers it once the body arrives", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 64 });
    const received: string[] = [];
    const errors = vi.fn();
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError(errors);
    const payload = VSBuffer.fromString("truncated");
    const frame = protocolFrame(ProtocolMessageType.Regular, payload);

    socket.emitData(frame.slice(0, HEADER_SIZE + 3));
    expect(received).toEqual([]);
    expect(errors).not.toHaveBeenCalled();

    socket.emitData(frame.slice(HEADER_SIZE + 3));
    expect(received).toEqual(["truncated"]);
    expect(errors).not.toHaveBeenCalled();
    protocol.dispose();
  });

  it("throws a typed error from send when the payload exceeds the tightened limit", () => {
    const socket = new FakeSocket();
    const protocol = new SocketProtocol(socket, { maxFrameBytes: 8 });

    expect(() => protocol.send(payloadOf(9))).toThrow(RpcFrameLimitError);
    expect(socket.written).toHaveLength(0);
    protocol.dispose();
  });
});

describe("PersistentProtocol frame bounds", () => {
  it("accepts exactly the limit and rejects limit + 1", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    const errors: unknown[] = [];
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError((error) => errors.push(error));

    socket.emitData(protocolFrame(ProtocolMessageType.Regular, payloadOf(16, 0x64), { id: 1 }));
    expect(received).toEqual(["d".repeat(16)]);

    socket.emitData(protocolFrame(ProtocolMessageType.Regular, payloadOf(17), { id: 2 }));
    expect(received).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RpcFrameLimitError);
    protocol.dispose();
  });

  it("applies the frame ACK before discarding an oversize body and keeps parsing", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, { maxFrameBytes: 8 });
    const received: string[] = [];
    const errors: unknown[] = [];
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError((error) => errors.push(error));

    protocol.send(VSBuffer.fromString("one"));
    protocol.send(VSBuffer.fromString("two"));
    expect(protocol.unacknowledgedBytes).toBe(6);

    socket.emitData(protocolFrame(ProtocolMessageType.Regular, payloadOf(9), { id: 1, ack: 1 }));
    expect(errors).toHaveLength(1);
    expect(protocol.unacknowledgedBytes).toBe(3);

    socket.emitData(
      protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("ok"), { id: 2 }),
    );
    expect(received).toEqual(["ok"]);
    protocol.dispose();
  });

  it("keeps discarding a fragmented oversize body before resuming", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    const errors: unknown[] = [];
    protocol.onMessage((message) => received.push(message.toString()));
    protocol.onError((error) => errors.push(error));
    const alloc = vi.spyOn(VSBuffer, "alloc");
    // 帧在安装 spy 之前构造：断言只覆盖协议收到输入后的分配行为。
    const oversize = protocolFrame(ProtocolMessageType.Regular, payloadOf(32, 0x66), {
      id: 1,
      ack: 1,
    });
    const next = protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("after"), {
      id: 2,
    });
    try {
      socket.emitData(oversize.slice(0, HEADER_SIZE + 4));
      expect(errors).toHaveLength(1);
      expect(received).toEqual([]);

      socket.emitData(oversize.slice(HEADER_SIZE + 4));
      expect(received).toEqual([]);
      // header 之外的 payload 只做流式丢弃，不按 length 构造 body。
      expect(
        alloc.mock.calls.filter(([size]) => typeof size === "number" && size > HEADER_SIZE),
      ).toHaveLength(0);

      socket.emitData(next);
      expect(received).toEqual(["after"]);
    } finally {
      alloc.mockRestore();
      protocol.dispose();
    }
  });

  it("does not throw on an unknown message type", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, { maxFrameBytes: 16 });
    const received: string[] = [];
    protocol.onMessage((message) => received.push(message.toString()));

    expect(() => {
      socket.emitData(
        protocolFrame(200 as unknown as ProtocolMessageType, payloadOf(3), { id: 1 }),
      );
      socket.emitData(
        protocolFrame(ProtocolMessageType.Regular, VSBuffer.fromString("ok"), { id: 2 }),
      );
    }).not.toThrow();
    expect(received).toEqual(["ok"]);
    protocol.dispose();
  });

  it("throws a typed error from send when the payload exceeds the tightened limit", () => {
    const socket = new FakeSocket();
    const protocol = new PersistentProtocol(socket, { maxFrameBytes: 8 });

    expect(() => protocol.send(payloadOf(9))).toThrow(RpcFrameLimitError);
    expect(protocol.unacknowledgedBytes).toBe(0);
    expect(socket.written).toHaveLength(0);
    protocol.dispose();
  });
});

describe("ChannelServer inbound message bounds", () => {
  function echoChannel(): IServerChannel<string> {
    return {
      call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
        return Promise.resolve({ command, arg } as unknown as T);
      },
      listen() {
        return Event.None;
      },
    };
  }

  function responseIds(sent: VSBuffer[]): number[] {
    return sent.map((buffer) => {
      const reader = new BufferReader(buffer);
      const header = deserialize(reader);
      return header[1] as number;
    });
  }

  it("ignores an unknown data tag and keeps serving later requests", async () => {
    const protocol = new FakeProtocol();
    const server = new ChannelServer(protocol, "ctx", 1000, true);
    server.registerChannel("svc", echoChannel());

    expect(() => {
      // 99 不是任何 DataType：deserialize 会返回 undefined。
      protocol.emit(VSBuffer.wrap(new Uint8Array([99, 0, 0, 0])));
      protocol.emit(channelMessage(100, 7, "svc", "ping", { value: 1 }));
    }).not.toThrow();

    await vi.waitFor(() => expect(protocol.sent.length).toBeGreaterThan(0));
    expect(responseIds(protocol.sent)).toEqual([7]);
    server.dispose();
    protocol.dispose();
  });

  it("ignores an unknown request type without responding or throwing", async () => {
    const protocol = new FakeProtocol();
    const server = new ChannelServer(protocol, "ctx", 1000, true);
    server.registerChannel("svc", echoChannel());

    expect(() => {
      protocol.emit(channelMessage(999, 1, "svc", "unknown"));
      protocol.emit(channelMessage(100, 2, "svc", "ping", "x"));
    }).not.toThrow();

    await vi.waitFor(() => expect(protocol.sent.length).toBeGreaterThan(0));
    expect(responseIds(protocol.sent)).toEqual([2]);
    server.dispose();
    protocol.dispose();
  });

  it("drops a message larger than the server limit but keeps the connection usable", async () => {
    const protocol = new FakeProtocol();
    const frameErrors: unknown[] = [];
    const server = new ChannelServer(protocol, "ctx", 1000, true, {
      maxFrameBytes: 64,
      onFrameError: (error) => frameErrors.push(error),
    });
    server.registerChannel("svc", echoChannel());

    expect(() => {
      protocol.emit(channelMessage(100, 1, "svc", "big", "x".repeat(128)));
      protocol.emit(channelMessage(100, 2, "svc", "small", "y"));
    }).not.toThrow();

    await vi.waitFor(() => expect(protocol.sent.length).toBeGreaterThan(0));
    expect(responseIds(protocol.sent)).toEqual([2]);
    expect(frameErrors).toHaveLength(1);
    expect(frameErrors[0]).toBeInstanceOf(RpcFrameLimitError);
    expect(frameErrors[0]).toMatchObject({
      code: RPC_FRAME_TOO_LARGE,
      maxFrameBytes: 64,
    });
    server.dispose();
    protocol.dispose();
  });

  it("keeps serving when the onFrameError observer throws", async () => {
    const protocol = new FakeProtocol();
    const server = new ChannelServer(protocol, "ctx", 1000, true, {
      maxFrameBytes: 64,
      onFrameError: () => {
        throw new Error("observer failure");
      },
    });
    server.registerChannel("svc", echoChannel());

    expect(() => {
      protocol.emit(channelMessage(100, 1, "svc", "big", "x".repeat(128)));
      protocol.emit(channelMessage(100, 2, "svc", "small", "y"));
    }).not.toThrow();

    await vi.waitFor(() => expect(protocol.sent.length).toBeGreaterThan(0));
    expect(responseIds(protocol.sent)).toEqual([2]);
    server.dispose();
    protocol.dispose();
  });

  it("validates its own frame limit", () => {
    const protocol = new FakeProtocol();
    expect(() => new ChannelServer(protocol, "ctx", 1000, true, { maxFrameBytes: 0 })).toThrow(
      RangeError,
    );
    protocol.dispose();
  });
});
