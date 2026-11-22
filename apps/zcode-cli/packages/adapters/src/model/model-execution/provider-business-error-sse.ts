// ============================================================
// Vercel AI SDK model execution — SSE business error detection
// ============================================================

import type { ProviderCode } from "./types.js";
import {
  ProviderBusinessError,
  SSE_FRAME_SEPARATOR_PATTERN,
  providerCodeToStatusCode,
  readProviderBusinessFailureFromBody,
  responseHeadersToRecord,
  readProviderMessage,
  readProviderRequestId,
  summarizeProviderBusinessBody,
  toProviderCode,
  type ProviderBusinessErrorFetchOptions,
} from "./provider-business-error.js";
import { asRecord, safeParseRecord } from "./record-utils.js";

export function createProviderBusinessErrorSseResponse(
  response: Response,
  options: ProviderBusinessErrorFetchOptions,
): Response {
  const body = response.body;
  if (!body) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const responseHeaders = responseHeadersToRecord(response.headers);

  return new Response(
    body.pipeThrough(
      createProviderBusinessErrorSseTransform(options, response.status, responseHeaders),
    ),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

function createProviderBusinessErrorSseTransform(
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let streamFailed = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode(chunk, { stream: true });
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
    },
    flush(controller) {
      if (streamFailed) {
        return;
      }

      pending += decoder.decode();
      pending = emitCompleteProviderBusinessSseFrames(
        pending,
        controller,
        encoder,
        options,
        responseStatus,
        responseHeaders,
        () => {
          streamFailed = true;
        },
      );
      if (!streamFailed && pending.length > 0) {
        emitProviderBusinessSseFrame(
          pending,
          "",
          controller,
          encoder,
          options,
          responseStatus,
          responseHeaders,
          () => {
            streamFailed = true;
          },
        );
      }
    },
  });
}

function emitCompleteProviderBusinessSseFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) {
      return pending;
    }

    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    const emitted = emitProviderBusinessSseFrame(
      frame,
      separator,
      controller,
      encoder,
      options,
      responseStatus,
      responseHeaders,
      markFailed,
    );
    if (!emitted) {
      return "";
    }
  }
}

function emitProviderBusinessSseFrame(
  frame: string,
  separator: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  options: ProviderBusinessErrorFetchOptions,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  markFailed: () => void,
): boolean {
  const failure = detectProviderBusinessSseFrameFailure(frame);
  if (failure) {
    // 部分 OpenAI-compatible provider 只在 HTTP 200 SSE error frame 中报告业务错误；
    // 同时保留原始响应头，保证限流场景的 retry-after 能进入后续重试退避。
    controller.error(
      new ProviderBusinessError({
        providerCode: failure.providerCode,
        providerId: options.providerId,
        providerKind: options.providerKind,
        providerMessage: failure.providerMessage,
        providerRequestId: failure.providerRequestId,
        responseBodySummary: failure.responseBodySummary,
        responseHeaders,
        responseStatus,
        statusCode: failure.statusCode,
      }),
    );
    markFailed();
    return false;
  }

  controller.enqueue(encoder.encode(`${frame}${separator}`));
  return true;
}

function detectProviderBusinessSseFrameFailure(frame: string):
  | {
      providerCode?: ProviderCode;
      providerMessage?: string;
      providerRequestId?: string;
      responseBodySummary: Record<string, unknown>;
      statusCode?: number;
    }
  | undefined {
  const sse = readSseFrame(frame);
  const data = sse.data?.trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  const body = safeParseRecord(data);
  if (!body) {
    return undefined;
  }

  const businessFailure = readProviderBusinessFailureFromBody(body);
  if (businessFailure) {
    return {
      ...businessFailure,
      providerRequestId: readProviderRequestId(body),
    };
  }

  if (sse.event?.toLowerCase() !== "error") {
    return undefined;
  }

  const errorRecord = asRecord(body.error);
  const providerCode =
    toProviderCode(body.providerCode) ??
    toProviderCode(errorRecord?.providerCode) ??
    toProviderCode(body.error_code) ??
    toProviderCode(errorRecord?.error_code) ??
    // 包装码不能覆盖真实 providerCode。
    toProviderCode(body.code) ??
    toProviderCode(errorRecord?.code);

  return {
    providerCode,
    providerMessage: readProviderMessage(body),
    providerRequestId: readProviderRequestId(body),
    responseBodySummary: summarizeProviderBusinessBody(body),
    statusCode: providerCodeToStatusCode(providerCode),
  };
}

function readSseFrame(frame: string): { data?: string; event?: string } {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const rawLine of frame.split(/\r\n|\n|\r/)) {
    if (rawLine.startsWith("event:")) {
      event = trimSseFieldValue(rawLine.slice("event:".length));
      continue;
    }
    if (!rawLine.startsWith("data:")) {
      continue;
    }

    dataLines.push(trimSseFieldValue(rawLine.slice("data:".length)));
  }

  return {
    data: dataLines.length === 0 ? undefined : dataLines.join("\n"),
    event,
  };
}

function trimSseFieldValue(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}
