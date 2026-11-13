import type { ServerResponse } from "node:http";
import type { E2ENetworkCaptureResponseEvent } from "../network-capture-proxy.js";
import {
  redactE2ENetworkCaptureJsonText,
  sanitizeE2ENetworkCaptureHeaders,
} from "../e2e-network-capture-redaction.js";
import type {
  MutableCaptureRecord,
  UpstreamReplayCloseMode,
  UpstreamReplayResponseChunk,
} from "./types.js";

export async function writeResponse(
  response: ServerResponse,
  record: MutableCaptureRecord,
  fixtureResponse: {
    body: string;
    chunks?: UpstreamReplayResponseChunk[];
    closeMode?: UpstreamReplayCloseMode;
    releaseAfterChunks?: number;
    release?: () => Promise<void>;
    headers: Record<string, string>;
    statusCode: number;
    statusMessage: string;
  },
) {
  const responseChunks = normalizeReplayChunks(fixtureResponse.chunks);
  const destroyStream = fixtureResponse.closeMode === "destroy";
  // 同时带 text/chunks 的 fixture 实际发送 chunks，证据也必须记录真正发出的字节。
  const responseBody =
    responseChunks.length > 0
      ? Buffer.concat(responseChunks.map((chunk) => chunk.body))
      : Buffer.from(fixtureResponse.body, "utf-8");
  const responseHeaders = sanitizeResponseHeaders(fixtureResponse.headers);
  if (responseChunks.length === 0 && !destroyStream) {
    responseHeaders["content-length"] = String(responseBody.length);
  } else {
    delete responseHeaders["content-length"];
  }
  response.writeHead(fixtureResponse.statusCode, fixtureResponse.statusMessage, responseHeaders);
  let actualOffsets: number[] | undefined;
  if (responseChunks.length > 0) {
    if (
      fixtureResponse.release &&
      (!Number.isInteger(fixtureResponse.releaseAfterChunks) ||
        fixtureResponse.releaseAfterChunks! < 1 ||
        fixtureResponse.releaseAfterChunks! >= responseChunks.length)
    ) {
      throw new Error("releaseAfterChunks 必须位于流内部");
    }
    actualOffsets = await writeReplayChunks(response, responseChunks, fixtureResponse);
    if (!destroyStream) response.end();
  } else if (destroyStream) {
    await writeResponseChunk(response, responseBody);
  } else {
    response.end(responseBody);
  }

  record.status = destroyStream ? "error" : "complete";
  record.completedAt = new Date().toISOString();
  record.durationMs = durationMs(record.startedAt, record.completedAt);
  record.statusCode = fixtureResponse.statusCode;
  record.statusMessage = fixtureResponse.statusMessage;
  record.responseBodyBytes = responseBody.length;
  record.responseHeaders = sanitizeE2ENetworkCaptureHeaders(responseHeaders);
  record.responseTextPreview = redactE2ENetworkCaptureJsonText(responseBody.toString("utf-8"));
  if (responseChunks.length > 0) {
    record.responseChunkTimeline = responseChunks.map((chunk, index) => ({
      base64: chunk.body.toString("base64"),
      byteLength: chunk.byteLength,
      offsetMs: fixtureResponse.release ? actualOffsets![index]! : chunk.offsetMs,
    }));
  }
  if (destroyStream) {
    // chunks/body 与 events 必须执行相同的故障合同；只在 artifact 标 destroy
    // 却正常 end 会把网络中断测试变成正常 EOF，并制造“产品假完成”的错误结论。
    record.error = "Replay fixture destroyed SSE response stream";
    response.destroy();
  }
}

async function writeReplayChunks(
  response: ServerResponse,
  chunks: NormalizedReplayChunk[],
  control?: { releaseAfterChunks?: number; release?: () => Promise<void> },
) {
  let previousOffsetMs = 0;
  const startedAt = Date.now();
  const actualOffsets: number[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (index === control?.releaseAfterChunks && control.release) {
      await control.release();
      // 只移除被释放的那段人为慢窗口，后续 chunk 间距及内容原样保留。
      previousOffsetMs = chunk.offsetMs;
    }
    const delayMs = Math.max(0, chunk.offsetMs - previousOffsetMs);
    if (delayMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    previousOffsetMs = chunk.offsetMs;
    actualOffsets.push(Date.now() - startedAt);
    // 等待写入完成后再进入下一帧/销毁连接，避免最后一帧只进用户态队列就被丢弃。
    await writeResponseChunk(response, chunk.body);
  }
  return actualOffsets;
}

interface NormalizedReplayChunk {
  body: Buffer;
  byteLength: number;
  offsetMs: number;
}

function normalizeReplayChunks(
  chunks: UpstreamReplayResponseChunk[] | undefined,
): NormalizedReplayChunk[] {
  return (
    chunks
      ?.map((chunk) => {
        const body =
          chunk.base64 !== undefined
            ? Buffer.from(chunk.base64, "base64")
            : Buffer.from(chunk.text ?? "", "utf-8");
        return {
          body,
          byteLength: chunk.byteLength ?? body.length,
          offsetMs: Math.max(0, Math.round(chunk.offsetMs)),
        };
      })
      .filter((chunk) => chunk.body.length > 0) ?? []
  );
}

export async function writeEventStreamResponse(
  response: ServerResponse,
  record: MutableCaptureRecord,
  fixtureResponse: {
    closeMode: UpstreamReplayCloseMode;
    events: E2ENetworkCaptureResponseEvent[];
    headers: Record<string, string>;
    statusCode: number;
    statusMessage: string;
  },
) {
  const responseHeaders = sanitizeResponseHeaders(fixtureResponse.headers);
  delete responseHeaders["content-length"];
  response.writeHead(fixtureResponse.statusCode, fixtureResponse.statusMessage, responseHeaders);

  const startedAtMs = Date.now();
  const sortedEvents = [...fixtureResponse.events].sort(
    (left, right) => left.offsetMs - right.offsetMs || left.sequence - right.sequence,
  );
  const chunks: string[] = [];
  const replayedEvents: E2ENetworkCaptureResponseEvent[] = [];

  for (const event of sortedEvents) {
    const elapsedMs = Date.now() - startedAtMs;
    const waitMs = Math.max(0, event.offsetMs - elapsedMs);
    if (waitMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    }

    const text = event.text;
    await writeResponseChunk(response, text);
    chunks.push(text);
    replayedEvents.push({
      byteLength: Buffer.byteLength(text, "utf-8"),
      offsetMs: Math.max(0, Date.now() - startedAtMs),
      ...(event.partial ? { partial: true } : {}),
      sequence: replayedEvents.length,
      text,
    });
  }

  const body = chunks.join("");
  record.status = fixtureResponse.closeMode === "destroy" ? "error" : "complete";
  record.completedAt = new Date().toISOString();
  record.durationMs = durationMs(record.startedAt, record.completedAt);
  record.statusCode = fixtureResponse.statusCode;
  record.statusMessage = fixtureResponse.statusMessage;
  record.responseBodyBytes = Buffer.byteLength(body, "utf-8");
  record.responseEvents = replayedEvents;
  record.responseHeaders = sanitizeE2ENetworkCaptureHeaders(responseHeaders);
  record.responseTextPreview = redactE2ENetworkCaptureJsonText(body);
  record.replay = {
    ...record.replay,
    closeMode: fixtureResponse.closeMode,
  };

  if (fixtureResponse.closeMode === "destroy") {
    // 修复原因：SSE fault case 需要区分“provider 正常 EOF 但内容不完整”和
    // “连接在流式响应中异常断开”。这里按 fixture 显式销毁 socket，artifact 也标记为 error，
    // 让后续 E2E 能稳定构造断流语义，而不是依赖真实网络抖动。
    record.error = "Replay fixture destroyed SSE response stream";
    response.destroy();
    return;
  }

  response.end();
}

function writeResponseChunk(response: ServerResponse, text: string | Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    response.write(text, (error) => {
      if (error) {
        rejectWrite(error);
        return;
      }
      resolveWrite();
    });
  });
}

function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "connection" || normalizedName === "transfer-encoding") {
      continue;
    }
    sanitized[normalizedName] = value;
  }
  return sanitized;
}

function durationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}
