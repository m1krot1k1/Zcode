import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  redactE2ENetworkCaptureJson,
  sanitizeE2ENetworkCaptureHeaders,
} from "../e2e-network-capture-redaction.js";
import { findFixtureIndex, parseJson } from "./fixtures.js";
import {
  BROWSER_FIXTURE_URL_REPLAY_TOKEN,
  extractReplayVariables,
  resolveFixtureResponseBody,
} from "./replay-variables.js";
import { writeEventStreamResponse, writeResponse } from "./response-stream.js";
import type { MutableCaptureRecord, UpstreamReplayFixture } from "./types.js";

interface ReplayRequestContext {
  baseUrl: string;
  fixtureMatchCounts: Map<string, number>;
  fixtures: UpstreamReplayFixture[];
  records: MutableCaptureRecord[];
  writeArtifact(): Promise<void>;
  holdStream(id: string, response: ServerResponse): Promise<void>;
}

export async function handleReplayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ReplayRequestContext,
) {
  const startedAt = new Date().toISOString();
  const requestBody = await readRequestBody(request);
  const requestText = requestBody.toString("utf-8");
  const requestJson = parseJson(requestText);
  const requestUrl = buildRequestUrl(request, context.baseUrl);
  const record: MutableCaptureRecord = {
    host: requestUrl.host,
    id: randomUUID(),
    method: request.method ?? "GET",
    path: requestUrl.pathname + requestUrl.search,
    protocol: requestUrl.protocol === "https:" ? "https" : "http",
    requestBodyBytes: requestBody.length,
    requestHeaders: sanitizeE2ENetworkCaptureHeaders(request.headers),
    requestJson: requestJson ? redactE2ENetworkCaptureJson(requestJson) : undefined,
    requestTextPreview: requestJson ? undefined : requestText,
    responseBodyBytes: 0,
    responseHeaders: {},
    startedAt,
    status: "pending",
    url: requestUrl.toString(),
  };
  context.records.push(record);
  await context.writeArtifact();

  const fixtureIndex = findFixtureIndex(
    context.fixtures,
    record,
    requestText,
    requestJson,
    context.fixtureMatchCounts,
  );
  const fixture = fixtureIndex >= 0 ? context.fixtures[fixtureIndex] : undefined;
  if (!fixture) {
    const body = JSON.stringify(
      {
        error: {
          message: `Missing Upstream e2e fixture for ${record.method} ${record.path}`,
        },
      },
      null,
      2,
    );
    await writeResponse(response, record, {
      body,
      headers: { "content-type": "application/json; charset=utf-8" },
      statusCode: 500,
      statusMessage: "Missing Fixture",
    });
    await context.writeArtifact();
    return;
  }
  context.fixtureMatchCounts.set(fixture.id, (context.fixtureMatchCounts.get(fixture.id) ?? 0) + 1);
  record.replay = {
    closeMode: fixture.response.closeMode ?? "end",
    fixtureId: fixture.id,
  };
  await context.writeArtifact();

  if (fixture.response.delayMs && fixture.response.delayMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, fixture.response.delayMs));
  }

  if (fixture.response.events?.length) {
    await writeEventStreamResponse(response, record, {
      events: fixture.response.events,
      closeMode: fixture.response.closeMode ?? "end",
      headers: fixture.response.headers ?? {},
      statusCode: fixture.response.statusCode,
      statusMessage: fixture.response.statusMessage ?? "OK",
    });
  } else {
    const resolvedBody = resolveFixtureResponseBody(
      fixture.response,
      extractReplayVariables(requestText, requestJson),
    );
    if (resolvedBody.body.includes(BROWSER_FIXTURE_URL_REPLAY_TOKEN)) {
      // 修复原因：动态 URL marker 缺失或格式错误时保留模板会让 Browser tool
      // 导航到字面量 `{{browserFixtureUrl}}`，随后可能被 compact 摘要掩盖成成功。
      // replay 必须 fail closed，让 fixture/request 契约错误直接可见。
      await writeResponse(response, record, {
        body: JSON.stringify({
          error: { message: "Missing E2E_BROWSER_FIXTURE_URL replay variable" },
        }),
        headers: { "content-type": "application/json; charset=utf-8" },
        statusCode: 500,
        statusMessage: "Missing Replay Variable",
      });
      // Bug 根因：artifact 写入改为异步后，这个 fail-closed 分支仍然 fire-and-forget；
      // Windows 原子替换最终失败时 rejection 会逃出统一 handler catch。返回前等待，
      // 让诊断落盘失败按请求生命周期收口，且不覆盖已经返回的 500 业务证据。
      await context.writeArtifact();
      return;
    }
    await writeResponse(response, record, {
      body: resolvedBody.body,
      chunks: fixture.response.chunks,
      closeMode: fixture.response.closeMode,
      ...(fixture.response.releaseAfterChunks === undefined
        ? {}
        : {
            releaseAfterChunks: fixture.response.releaseAfterChunks,
            release: () => {
              if (fixture.metadata?.timingPolicy !== "controlled-stream")
                throw new Error("仅 controlled-stream 允许显式释放");
              return context.holdStream(fixture.id, response);
            },
          }),
      headers: resolvedBody.headers,
      statusCode: fixture.response.statusCode,
      statusMessage: fixture.response.statusMessage ?? "OK",
    });
  }
  if (fixture.replay?.consumeOnce) {
    context.fixtures.splice(fixtureIndex, 1);
  }
  await context.writeArtifact();
}

export function closeReplayResponseAfterHandlerError(
  response: ServerResponse,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[upstream-replay] request handler failed: ${message}`);
  if (response.writableEnded || response.destroyed) {
    return;
  }
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const body = JSON.stringify({
    error: { message: `Upstream E2E replay handler failed: ${message}` },
  });
  response.writeHead(500, "Replay Handler Failed", {
    "content-length": String(Buffer.byteLength(body, "utf-8")),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildRequestUrl(request: IncomingMessage, baseUrl: string): URL {
  const rawUrl = request.url ?? "/";
  if (/^https?:\/\//i.test(rawUrl)) {
    return new URL(rawUrl);
  }
  const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return new URL(path, baseUrl);
}
