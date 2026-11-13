// ============================================================
// Vercel AI SDK model execution — OpenCode provider runtime
// ============================================================

import { delimiter, dirname, isAbsolute } from "node:path";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import type { ClientManagerOptions, OpencodeProvider } from "ai-sdk-provider-opencode-sdk";
import { isOpenCodeFreeUsageLimitMessage } from "../failure-inspection.js";
import { readConfiguredProxyEndpoints } from "../../network/proxy-fetch.js";
import {
  acquireOpenCodeSocksProxyLease,
  advanceOpenCodeSocksProxy,
  findOpenCodeLoopbackPort,
  type OpenCodeTaskBridge,
} from "../opencode-session.js";
import {
  OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS,
  type OpenCodeInvocationProvider,
} from "./opencode-invocation.js";
import { asRecord } from "./record-utils.js";
import type { ProviderFetch } from "./types.js";

export type OpenCodeModelProvider = OpencodeProvider;

export interface OpenCodeModelProviderRuntime {
  provider: OpenCodeModelProvider;
  dispose(): Promise<void>;
}

type OpenCodeSdk = typeof import("ai-sdk-provider-opencode-sdk");
type OpenCodeProcessSignal = "SIGINT" | "SIGTERM";
type OpenCodeSignalListener = NodeJS.SignalsListener;

const OPENCODE_PROCESS_SIGNALS: readonly OpenCodeProcessSignal[] = ["SIGINT", "SIGTERM"];
const OPENCODE_DIAGNOSTIC_BODY_MAX_BYTES = 8_192;
const OPENCODE_DIAGNOSTIC_READ_TIMEOUT_MS = 750;
const OPENCODE_SESSION_CREATE_PATH = /(?:^|\/)session\/?$/u;
const OPENCODE_SESSION_PROMPT_PATH = /(?:^|\/)session\/[^/]+\/(?:message|prompt_async)\/?$/u;
const OPENCODE_SAFE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);
export function createOpenCodeInvocationConfig(bridge: OpenCodeTaskBridge) {
  return {
    tools: { task: false },
    // OpenCode 1.x falls back to experimental.mcp_timeout for tool execution;
    // the per-server timeout is not consistently applied to long-running calls.
    experimental: { mcp_timeout: OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS },
    mcp: {
      zcode: {
        type: "remote" as const,
        url: bridge.url,
        enabled: true,
        timeout: OPENCODE_ZCODE_MCP_EXECUTION_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${bridge.bearerToken}` },
      },
    },
  };
}

/**
 * Lazily creates an isolated OpenCode provider for the owning CLI process.
 * The SDK constructs a default singleton during module evaluation, so only
 * signal listeners added by that import are removed. The isolated manager's
 * listeners remain until this runtime is disposed.
 */
/** SDK 的 `opencode serve` 只按 PATH 找二进制。E2E 把 fixture 绝对路径放在这个变量里。 */
export function preferOpenCodeE2ECliOnPath(env: NodeJS.ProcessEnv = process.env): void {
  const cliPath = env.ZCODE_E2E_OPENCODE_CLI_PATH?.trim();
  if (!cliPath || !isAbsolute(cliPath)) return;
  const binDir = dirname(cliPath);
  const current = env.PATH ?? "";
  const entries = current.split(delimiter).filter((entry) => entry && entry !== binDir);
  env.PATH = [binDir, ...entries].join(delimiter);
}

export async function createOpenCodeModelProvider(): Promise<OpenCodeModelProviderRuntime> {
  preferOpenCodeE2ECliOnPath();
  const e2ePortValue = process.env.ZCODE_E2E_OPENCODE_PORT?.trim();
  const e2ePort = e2ePortValue && /^\d+$/.test(e2ePortValue) ? Number(e2ePortValue) : undefined;
  const configuredProxies = readConfiguredProxyEndpoints(process.env);
  const selectedProxy = process.env.ZCODE_HTTP_PROXY?.trim();
  const configuredProxy =
    selectedProxy && configuredProxies.includes(selectedProxy)
      ? selectedProxy
      : (configuredProxies[0] ?? selectedProxy);
  const listenersBeforeImport = captureOpenCodeSignalListeners();
  let sdk: OpenCodeSdk;

  try {
    sdk = await import("ai-sdk-provider-opencode-sdk");
  } finally {
    removeNewOpenCodeSignalListeners(listenersBeforeImport);
  }
  const proxyLease = await acquireOpenCodeSocksProxyLease(configuredProxy);

  let clientManager: ReturnType<typeof sdk.OpencodeClientManager.createInstance> | undefined;

  try {
    const port =
      e2ePort && e2ePort <= 65_535
        ? e2ePort
        : configuredProxy
          ? await findOpenCodeLoopbackPort()
          : undefined;
    clientManager = sdk.OpencodeClientManager.createInstance({
      // Не подключаться к уже запущенному пользовательскому OpenCode без прокси ZCode.
      ...(port ? { port } : {}),
      clientOptions: { fetch: createOpenCodeDiagnosticFetch() },
    } satisfies ClientManagerOptions);
    const provider = sdk!.createOpencode({ clientManager }) as OpenCodeInvocationProvider;
    provider.createInvocationModel = async (modelId, settings, bridge) => {
      let invocationServer: Awaited<ReturnType<typeof createOpencodeServer>> | undefined;
      let invocationManager:
        | ReturnType<typeof sdk.OpencodeClientManager.createInstance>
        | undefined;
      let invocationProvider: OpencodeProvider | undefined;
      try {
        // OpenCode rejects port 0 when explicitly passed; select a loopback port and
        // let the SDK own this invocation's server. The bridge endpoint itself stays
        // bound to loopback and requires a one-time bearer lease.
        const invocationPort = await findOpenCodeLoopbackPort();
        invocationServer = await createOpencodeServer({
          hostname: "127.0.0.1",
          port: invocationPort,
          timeout: 20_000,
          config: createOpenCodeInvocationConfig(bridge),
        });
        invocationManager = sdk.OpencodeClientManager.createInstance({
          baseUrl: invocationServer.url,
          autoStartServer: false,
          clientOptions: { fetch: createOpenCodeDiagnosticFetch() },
        } satisfies ClientManagerOptions);
        invocationProvider = sdk.createOpencode({ clientManager: invocationManager });
        return {
          model: invocationProvider(modelId, settings),
          dispose: async () => {
            try {
              await invocationProvider?.dispose();
            } finally {
              invocationServer?.close();
            }
          },
        };
      } catch {
        await invocationProvider?.dispose().catch(() => undefined);
        await invocationManager?.dispose().catch(() => undefined);
        invocationServer?.close();
        throw new Error("opencode.invocation-server-start-failed");
      }
    };
    const disposeProvider = provider.dispose.bind(provider);
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      try {
        await disposeProvider();
      } finally {
        await proxyLease?.dispose();
      }
    };
    provider.dispose = dispose;

    return {
      provider,
      dispose,
    };
  } catch (error) {
    await clientManager?.dispose();
    await proxyLease?.dispose();
    throw error;
  }
}

/**
 * 根因：OpenCode SDK 在 session.create/prompt 失败时会丢弃 HTTP 状态并包装成空响应。
 * 修复依据：为这些本地端点保留状态码与脱敏错误字段，不转发 URL 或任意响应体。
 */
export function createOpenCodeDiagnosticFetch(
  fetchImpl: ProviderFetch = globalThis.fetch,
): ProviderFetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const requestUrl = request?.url ?? (input instanceof URL ? input.href : String(input));
    let isSessionCreate = false;
    let isSessionPrompt = false;
    try {
      const pathname = new URL(requestUrl).pathname;
      isSessionCreate = method === "POST" && OPENCODE_SESSION_CREATE_PATH.test(pathname);
      isSessionPrompt = method === "POST" && OPENCODE_SESSION_PROMPT_PATH.test(pathname);
    } catch {
      // URL parsing is only used to identify the endpoint and is never included in diagnostics.
    }
    const isOpenCodeModelRequest = isSessionCreate || isSessionPrompt;

    const proxyAttempts = Math.max(1, readConfiguredProxyEndpoints(process.env).length);
    let attempt = 0;
    try {
      while (attempt < proxyAttempts) {
        attempt += 1;
        // Request 的 body 只能读一次。重试前克隆，否则第二次本地请求没有正文。
        const attemptInput = input instanceof Request && proxyAttempts > 1 ? input.clone() : input;
        const response = await fetchImpl(attemptInput, init);
        if (!isOpenCodeModelRequest) return response;

        if (!response.ok) {
          const fields = await readOpenCodeDiagnosticFields(response);
          // 原因：OpenCode 的 429 发生在子进程上游。只有 SOCKS 桥能换出口时才重放这一次本地请求。
          if (
            isOpenCodeProxyRateLimit(response.status, fields) &&
            attempt < proxyAttempts &&
            advanceOpenCodeSocksProxy()
          ) {
            continue;
          }
          return createOpenCodeDiagnosticResponse(response.status, fields, isSessionPrompt);
        }
        if (isSessionCreate && response.status === 204) {
          return createOpenCodeDiagnosticResponse(
            204,
            { message: "OpenCode returned an empty session creation response." },
            false,
          );
        }
        return response;
      }
      throw new Error("opencode.proxy-ring-exhausted");
    } catch (cause) {
      if (!isOpenCodeModelRequest || isOpenCodeAbortError(cause)) throw cause;
      const causeRecord = asRecord(cause);
      const causeCode = typeof causeRecord?.code === "string" ? causeRecord.code.toUpperCase() : "";
      // Error.message от Node fetch может содержать URL. Наружу передаём только известный errno
      // и нейтральный текст; AbortError оставляем без изменений для обычной отмены запроса.
      throw {
        name: "OpenCodeTransportError",
        code: OPENCODE_SAFE_TRANSPORT_CODES.has(causeCode) ? causeCode : "OPENCODE_TRANSPORT_ERROR",
        message: "OpenCode local server request failed.",
      };
    }
  };
}

async function readOpenCodeDiagnosticFields(response: Response): Promise<{
  code?: string;
  message?: string;
}> {
  const text = await readBoundedOpenCodeResponseText(response);
  try {
    await response.body?.cancel();
  } catch {
    // 取消原响应流仅用于尽快释放连接，不能覆盖已解析的错误字段。
  }
  if (!text) return {};
  try {
    const root = asRecord(JSON.parse(text));
    const nested = asRecord(root?.error);
    const data = asRecord(root?.data);
    const nestedData = asRecord(nested?.data);
    const code = sanitizeOpenCodeDiagnosticCode(
      nested?.code ??
        nestedData?.code ??
        data?.code ??
        root?.code ??
        root?.error_code ??
        root?.name,
    );
    const message = sanitizeOpenCodeDiagnosticMessage(
      root?.message ?? data?.message ?? nested?.message ?? nestedData?.message,
    );
    return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
  } catch {
    return {};
  }
}

async function readBoundedOpenCodeResponseText(response: Response): Promise<string | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > OPENCODE_DIAGNOSTIC_BODY_MAX_BYTES) {
        void reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
    const body = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  })();
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      void reader.cancel();
      resolve(undefined);
    }, OPENCODE_DIAGNOSTIC_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sanitizeOpenCodeDiagnosticCode(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value)
    .replace(/[^A-Za-z0-9_.:-]/gu, "")
    .slice(0, 80);
  return code || undefined;
}

function sanitizeOpenCodeDiagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // 逐字符删除控制字符，避免供应商错误消息污染 Host 诊断日志。
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  }).join("");
  const message = withoutControls
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .replace(/\bapi[_-]?key\s*[:=]\s*[^\s,;]+/giu, "api_key=[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[URL]")
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s"'<>]+/gu, "[path]")
    .replace(/\b[A-Za-z]:\\(?:Users|home|tmp)\\[^\s"'<>]+/giu, "[path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280);
  return message || undefined;
}

function createOpenCodeDiagnosticResponse(
  upstreamStatus: number,
  fields: { code?: string; message?: string },
  preserveThroughEmptyResponseWrapper: boolean,
): Response {
  // Response forbids bodies for 204/304; use a JSON envelope and encode the actual status there.
  const responseStatus = upstreamStatus === 204 || upstreamStatus === 304 ? 200 : upstreamStatus;
  const message =
    fields.message ?? `OpenCode server returned HTTP ${upstreamStatus} while processing a request.`;
  // 根因：SDK 将 HTTP 错误折叠成 EmptyResponseData，只保留 Error.message 和根级状态，丢掉 response body 的 code/message。
  // 修复依据：将已脱敏且有界的完整诊断编码进 SDK 必然保留的 message，供错误投影恢复字段。
  const sdkVisibleMessage = preserveThroughEmptyResponseWrapper
    ? `OpenCode request diagnostic: ${JSON.stringify({
        statusCode: upstreamStatus,
        ...(fields.code ? { code: fields.code } : {}),
        message,
      })}`
    : message;
  return new Response(
    JSON.stringify({
      statusCode: upstreamStatus,
      ...(fields.code ? { code: fields.code } : {}),
      message: sdkVisibleMessage,
    }),
    { status: responseStatus, headers: { "content-type": "application/json" } },
  );
}

function isOpenCodeProxyRateLimit(
  status: number,
  fields: { code?: string; message?: string },
): boolean {
  // 根因：OpenCode 的免费用量上限是账号配额，不是 SOCKS 出口限流；换代理不能恢复额度，只会掩盖原始错误。
  if (isOpenCodeFreeUsageLimitMessage(fields.message)) return false;
  if (status === 429) return true;
  const code = fields.code?.toLowerCase();
  if (code === "rate_limited" || code === "model_rate_limited" || code === "rate_limit") {
    return true;
  }
  return false;
}

function isOpenCodeAbortError(error: unknown): boolean {
  const record = asRecord(error);
  return record?.name === "AbortError" || record?.code === "ABORT_ERR";
}

function captureOpenCodeSignalListeners(): Map<OpenCodeProcessSignal, OpenCodeSignalListener[]> {
  return new Map(OPENCODE_PROCESS_SIGNALS.map((signal) => [signal, process.listeners(signal)]));
}

function removeNewOpenCodeSignalListeners(
  before: Map<OpenCodeProcessSignal, OpenCodeSignalListener[]>,
): void {
  for (const signal of OPENCODE_PROCESS_SIGNALS) {
    const previousCounts = countOpenCodeSignalListeners(before.get(signal) ?? []);
    for (const listener of process.listeners(signal)) {
      const previousCount = previousCounts.get(listener) ?? 0;
      if (previousCount > 0) {
        previousCounts.set(listener, previousCount - 1);
      } else {
        process.removeListener(signal, listener);
      }
    }
  }
}

function countOpenCodeSignalListeners(
  listeners: OpenCodeSignalListener[],
): Map<OpenCodeSignalListener, number> {
  const counts = new Map<OpenCodeSignalListener, number>();
  for (const listener of listeners) {
    counts.set(listener, (counts.get(listener) ?? 0) + 1);
  }
  return counts;
}
