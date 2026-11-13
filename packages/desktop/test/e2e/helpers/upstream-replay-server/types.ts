import type { writeE2EJsonFileAtomically } from "../e2e-atomic-json-file.js";
import type {
  E2ENetworkCaptureRecord,
  E2ENetworkCaptureResponseEvent,
} from "../network-capture-proxy.js";

export interface UpstreamReplayServer {
  artifactPath: string;
  baseUrl: string;
  host: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartUpstreamReplayServerOptions {
  artifactPath: string;
  artifactWriter?: typeof writeE2EJsonFileAtomically;
  fixtureVariables?: Readonly<Record<string, string>>;
  fixturePaths: string[];
  host?: string;
  port?: number;
}

export interface UpstreamReplayFixtureFile {
  fixtures: UpstreamReplayFixture[];
  version: 1;
}

export type UpstreamReplayCloseMode = "end" | "destroy";

export interface UpstreamReplayFixture {
  metadata?: { timingPolicy?: string };
  captured?: {
    capturedAt?: string;
    model?: string;
    requestBodyBytes?: number;
    responseBodyBytes?: number;
    statusCode?: number;
    url?: string;
  };
  description?: string;
  id: string;
  maxMatches?: number;
  match: {
    bodyExcludes?: string[];
    bodyIncludes?: string[];
    lastUserMessageExcludes?: string[];
    lastUserMessageIncludes?: string[];
    method?: string;
    pathIncludes?: string;
  };
  replay?: {
    consumeOnce?: boolean;
  };
  response: {
    body?: string;
    chunks?: UpstreamReplayResponseChunk[];
    closeMode?: UpstreamReplayCloseMode;
    delayMs?: number;
    /** 仅 controlled-stream：写出 N 个 chunk 后等待测试完成关键操作再释放。 */
    releaseAfterChunks?: number;
    events?: E2ENetworkCaptureResponseEvent[];
    headers?: Record<string, string>;
    statusCode: number;
    statusMessage?: string;
    text?: UpstreamReplayTextResponse | string;
    toolUse?: UpstreamReplayToolUseResponse;
    toolUses?: UpstreamReplayToolUseResponse[];
  };
}

export interface ReplayVariables {
  browserFixtureUrl?: string;
  latestBrowserTabAId?: string;
  latestBrowserTabBId?: string;
  latestBrowserTabId?: string;
  latestAgentId?: string;
  latestBashTaskId?: string;
  memoryRoot?: string;
  latestAutomationId?: string;
}

export interface UpstreamReplayResponseChunk {
  base64?: string;
  byteLength?: number;
  offsetMs: number;
  text?: string;
}

export interface UpstreamReplayTextResponse {
  id?: string;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  text: string;
}

export interface UpstreamReplayToolUseResponse {
  id?: string;
  input: Record<string, unknown>;
  inputTokens?: number;
  messageId?: string;
  model?: string;
  name: string;
  outputTokens?: number;
}

export type MutableCaptureRecord = E2ENetworkCaptureRecord;
