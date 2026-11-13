import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
  E2ENetworkResponseChunk,
} from "../network-capture-proxy.js";
import type {
  UpstreamReplayFixture,
  UpstreamReplayFixtureFile,
  UpstreamReplayResponseChunk,
} from "./types.js";

export function findFixtureIndex(
  fixtures: UpstreamReplayFixture[],
  record: E2ENetworkCaptureRecord,
  requestText: string,
  requestJson: unknown,
  fixtureMatchCounts: ReadonlyMap<string, number>,
) {
  return fixtures.findIndex((fixture) => {
    // 回放需要表达“同一类请求前 N 次失败、之后成功”的时序。
    // maxMatches 只影响测试 fixture 匹配，不进入产品协议。
    if (
      fixture.maxMatches !== undefined &&
      (fixtureMatchCounts.get(fixture.id) ?? 0) >= fixture.maxMatches
    ) {
      return false;
    }

    const expectedMethod = fixture.match.method?.toUpperCase();
    if (expectedMethod && expectedMethod !== record.method.toUpperCase()) {
      return false;
    }
    if (fixture.match.pathIncludes && !record.path.includes(fixture.match.pathIncludes)) {
      return false;
    }

    const latestUserMessageText =
      fixture.match.lastUserMessageIncludes || fixture.match.lastUserMessageExcludes
        ? readLatestUserMessageText(requestJson)
        : "";

    return (
      (fixture.match.bodyIncludes?.every(
        (text) => requestText.includes(text) || captureContainsText(requestJson, text),
      ) ??
        true) &&
      (fixture.match.bodyExcludes?.every(
        (text) => !requestText.includes(text) && !captureContainsText(requestJson, text),
      ) ??
        true) &&
      (fixture.match.lastUserMessageIncludes?.every((text) =>
        latestUserMessageText.includes(text),
      ) ??
        true) &&
      (fixture.match.lastUserMessageExcludes?.every(
        (text) => !latestUserMessageText.includes(text),
      ) ??
        true)
    );
  });
}

function readLatestUserMessageText(requestJson: unknown): string {
  if (!requestJson || typeof requestJson !== "object") {
    return "";
  }
  const messages = (requestJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    if ((message as { role?: unknown }).role !== "user") {
      continue;
    }
    return readMessageContentText((message as { content?: unknown }).content);
  }
  return "";
}

function readMessageContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
      // 修复原因：Anthropic Messages continuation 把工具结果放在 user/tool_result.content，
      // 旧实现只读 text，导致 fixture 只能在整段 body 搜 marker；而 tool code 本身
      // 也包含成功 marker，会把真实失败结果误匹配成成功 continuation。
      if ((part as { type?: unknown }).type === "tool_result") {
        return readMessageContentText((part as { content?: unknown }).content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function loadFixtureFile(
  path: string,
  fixtureVariables: Readonly<Record<string, string>> = {},
): UpstreamReplayFixture[] {
  const resolvedPath = resolve(path);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf-8")) as
    | UpstreamReplayFixtureFile
    | E2ENetworkCaptureArtifact;
  if (isUpstreamReplayFixtureFile(parsed)) {
    return applyFixtureVariables(parsed.fixtures, fixtureVariables) as UpstreamReplayFixture[];
  }
  if (isNetworkCaptureArtifact(parsed)) {
    return applyFixtureVariables(
      convertCaptureArtifactToFixtures(parsed, resolvedPath),
      fixtureVariables,
    ) as UpstreamReplayFixture[];
  }
  throw new Error(`Invalid Upstream e2e replay fixture: ${path}`);
}

function applyFixtureVariables(
  value: unknown,
  variables: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === "string") {
    return Object.entries(variables).reduce(
      (resolvedValue, [name, replacement]) => resolvedValue.split(`{{${name}}}`).join(replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyFixtureVariables(item, variables));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, applyFixtureVariables(child, variables)]),
  );
}

function isUpstreamReplayFixtureFile(
  value: UpstreamReplayFixtureFile | E2ENetworkCaptureArtifact,
): value is UpstreamReplayFixtureFile {
  return value.version === 1 && Array.isArray((value as UpstreamReplayFixtureFile).fixtures);
}

function isNetworkCaptureArtifact(
  value: UpstreamReplayFixtureFile | E2ENetworkCaptureArtifact,
): value is E2ENetworkCaptureArtifact {
  return value.version === 1 && Array.isArray((value as E2ENetworkCaptureArtifact).records);
}

function convertCaptureArtifactToFixtures(
  artifact: E2ENetworkCaptureArtifact,
  sourcePath: string,
): UpstreamReplayFixture[] {
  const fixtures = artifact.records
    .filter((record) => record.status === "complete" && record.statusCode)
    .filter(
      (record) =>
        record.responseTextPreview ||
        record.responseChunkTimeline?.length ||
        record.responseEvents?.length,
    )
    .map((record, index) => {
      const responseBody = resolveCapturedResponseBody(record);
      return {
        id: `capture-${String(index + 1).padStart(3, "0")}-${record.id}`,
        description: `Captured replay response from ${sourcePath}`,
        match: {
          method: record.method,
          pathIncludes: capturePathname(record),
        },
        replay: {
          consumeOnce: true,
        },
        captured: {
          capturedAt: record.completedAt ?? record.startedAt,
          requestBodyBytes: record.requestBodyBytes,
          responseBodyBytes: record.responseBodyBytes,
          statusCode: record.statusCode,
          url: record.url,
        },
        response: {
          body: responseBody,
          chunks: record.responseChunkTimeline?.map(captureChunkToReplayChunk),
          events: record.responseEvents,
          headers: record.responseHeaders,
          statusCode: record.statusCode ?? 200,
          statusMessage: record.statusMessage,
        },
      } satisfies UpstreamReplayFixture;
    });

  if (fixtures.length === 0) {
    throw new Error(`Upstream capture artifact has no replayable records: ${sourcePath}`);
  }
  return fixtures;
}

function resolveCapturedResponseBody(record: E2ENetworkCaptureRecord) {
  if (record.responseTextPreview && !record.responseBodyTruncated) {
    return record.responseTextPreview;
  }
  if (record.responseEvents?.length) {
    return record.responseEvents.map((event) => event.text).join("");
  }
  if (record.responseChunkTimeline?.length && !record.responseChunkTimelineTruncated) {
    return Buffer.concat(
      record.responseChunkTimeline.map((chunk) => Buffer.from(chunk.base64, "base64")),
    ).toString("utf-8");
  }
  return record.responseTextPreview ?? "";
}

function captureChunkToReplayChunk(chunk: E2ENetworkResponseChunk): UpstreamReplayResponseChunk {
  return {
    base64: chunk.base64,
    byteLength: chunk.byteLength,
    offsetMs: chunk.offsetMs,
  };
}

function capturePathname(record: E2ENetworkCaptureRecord) {
  try {
    return new URL(record.url).pathname;
  } catch {
    return record.path.split("?")[0] || record.path;
  }
}

export function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function captureContainsText(value: unknown, expected: string): boolean {
  if (typeof value === "string") {
    return value.includes(expected);
  }
  if (Array.isArray(value)) {
    return value.some((item) => captureContainsText(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((child) => captureContainsText(child, expected));
}
