import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import {
  ZCODE_HTTP_PROXY_LIST_ENV_KEY,
  normalizeZCodeProxyEndpoint,
  readZCodeProxyList,
} from "@zcode/shared";
import {
  loadTlsCaCertificates,
  resolveProxyForRequest,
  resolveProxyUrlForRequest,
  resolveTlsCaCertFile,
} from "./http-config.js";
import { readIncomingResponse, toWebResponse } from "./incoming-response.js";

export type NetworkFetch = typeof globalThis.fetch;

interface NetworkProxyFetchOptions {
  caCertFile?: string;
  env?: Record<string, string | undefined>;
  fetch?: NetworkFetch;
  httpProxy?: string;
  httpProxyList?: readonly string[];
  noProxy?: string;
}

// Процессное кольцо: следующий модельный запрос начинается с прокси, который
// пережил прошлый ответ. Идентичность списка сбрасывает курсор на выбранный вход.
let proxyRingIdentity = "";
let proxyRingCursor = 0;

interface NormalizedFetchRequest {
  body?: Buffer;
  headers: Headers;
  method: string;
  signal?: AbortSignal | null;
  url: URL;
}

export function createNetworkProxyFetch(options: NetworkProxyFetchOptions): NetworkFetch {
  const directFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!hasNetworkFetchPolicy(options)) {
    return directFetch;
  }

  let tlsCaCertificates: Buffer | undefined;
  let tlsCaCertificatesLoaded = false;

  const getTlsCaCertificates = (): Buffer | undefined => {
    if (!tlsCaCertificatesLoaded) {
      tlsCaCertificates = loadTlsCaCertificates(options);
      tlsCaCertificatesLoaded = true;
    }
    return tlsCaCertificates;
  };

  return async (input, init) => {
    const requestUrl = readFetchInputUrl(input);
    if (!requestUrl || (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:")) {
      return directFetch(input, init);
    }

    const proxies = configuredProxyRing(options);
    const caCertFile = resolveTlsCaCertFile(options);
    if (proxies.length === 0) {
      const proxyUrl = resolveProxyUrlForRequest(requestUrl, options);
      if (!proxyUrl && !caCertFile) {
        return directFetch(input, init);
      }
      const request = await normalizeFetchRequest(input, init);
      return fetchWithAgent(request, {
        ca: caCertFile ? getTlsCaCertificates() : undefined,
        proxyUrl,
      });
    }

    // noProxy остаётся исключением: локальный адрес не обходит кольцо через прямое соединение
    // только когда правило само просит обойти прокси.
    if (resolveProxyForRequest(requestUrl, { ...options, httpProxy: proxies[0] }).noProxyMatched) {
      return directFetch(input, init);
    }

    const request = await normalizeFetchRequest(input, init);
    const start = syncProxyRingCursor(proxies, options.httpProxy);
    const ca = caCertFile ? getTlsCaCertificates() : undefined;
    for (let attempt = 0; attempt < proxies.length; attempt += 1) {
      if (request.signal?.aborted) {
        throw abortReason(request.signal);
      }
      const index = (start + attempt) % proxies.length;
      const proxyUrl = resolveProxyUrlForRequest(request.url, {
        ...options,
        httpProxy: proxies[index],
      });
      const response = await fetchWithAgent(request, { ca, proxyUrl });
      const rateLimited = response.status === 429;
      if (!rateLimited || attempt === proxies.length - 1) {
        // 原因：429 只说明这条出口被限流。下一次请求要从下一条开始，成功则留在当前。
        rememberProxyRingCursor(proxies, rateLimited ? (index + 1) % proxies.length : index);
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    }
    throw new Error("proxy-ring-exhausted");
  };
}

export function readConfiguredProxyEndpoints(
  env: Record<string, string | undefined> | undefined,
): string[] {
  return readZCodeProxyList(env?.[ZCODE_HTTP_PROXY_LIST_ENV_KEY]);
}

function configuredProxyRing(options: NetworkProxyFetchOptions): string[] {
  if (options.httpProxyList) return readZCodeProxyList(options.httpProxyList.join("\n"));
  return [];
}

function syncProxyRingCursor(proxies: readonly string[], preferred: string | undefined): number {
  const identity = proxies.join("\n");
  if (identity !== proxyRingIdentity) {
    proxyRingIdentity = identity;
    const preferredEndpoint = normalizeZCodeProxyEndpoint(preferred);
    const preferredIndex = preferredEndpoint ? proxies.indexOf(preferredEndpoint) : -1;
    proxyRingCursor = preferredIndex >= 0 ? preferredIndex : 0;
  }
  return proxyRingCursor;
}

function rememberProxyRingCursor(proxies: readonly string[], index: number): void {
  proxyRingIdentity = proxies.join("\n");
  proxyRingCursor = index;
}

/** Следующий вход кольца без сдвига. Сдвиг делает {@link commitConfiguredProxyCursor}. */
export function nextConfiguredProxyCandidate(
  proxies: readonly string[],
  preferred: string | undefined,
): string | undefined {
  if (proxies.length < 2) return undefined;
  const current = syncProxyRingCursor(proxies, preferred);
  return proxies[(current + 1) % proxies.length];
}

export function commitConfiguredProxyCursor(
  proxies: readonly string[],
  endpoint: string,
): void {
  const index = proxies.indexOf(endpoint);
  if (index >= 0) rememberProxyRingCursor(proxies, index);
}

function hasNetworkFetchPolicy(options: NetworkProxyFetchOptions): boolean {
  return Boolean(
    options.caCertFile ||
      options.env ||
      options.httpProxy ||
      options.httpProxyList?.some((entry) => entry.trim()) ||
      options.noProxy,
  );
}

function readFetchInputUrl(input: Parameters<NetworkFetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}

async function normalizeFetchRequest(
  input: Parameters<NetworkFetch>[0],
  init: Parameters<NetworkFetch>[1],
): Promise<NormalizedFetchRequest> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const arrayBuffer =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = arrayBuffer && arrayBuffer.byteLength > 0 ? Buffer.from(arrayBuffer) : undefined;

  return {
    body,
    headers: request.headers,
    method,
    signal: request.signal,
    url: new URL(request.url),
  };
}

function fetchWithAgent(
  request: NormalizedFetchRequest,
  options: { ca?: Buffer; proxyUrl?: string },
): Promise<Response> {
  const transport = request.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const signal = request.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    let settled = false;
    let responseMessage: http.IncomingMessage | undefined;
    let clientRequest: http.ClientRequest | undefined;

    const cleanupAll = (): void => {
      signal?.removeEventListener("abort", onAbort);
      clientRequest?.off("error", onRequestError);
      clientRequest?.off("close", onRequestClose);
      responseMessage?.off("close", cleanupAll);
      responseMessage?.off("error", onResponseError);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(error);
    };
    const onRequestError = (error: Error): void => {
      rejectOnce(error);
    };
    const onRequestClose = (): void => {
      if (!responseMessage && settled) cleanupAll();
    };
    const onResponseError = (): void => {
      // The web Response body receives the stream error through Readable.toWeb;
      // this listener only prevents Node from treating abort destroy as unhandled.
    };
    const onAbort = (): void => {
      const error = abortReason(signal);
      responseMessage?.destroy(error);
      clientRequest?.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    clientRequest = transport.request(
      {
        agent: createRequestAgent(request.url, options),
        headers: headersToOutgoing(request.headers),
        hostname: request.url.hostname,
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        port: request.url.port || undefined,
        protocol: request.url.protocol,
      },
      (message) => {
        responseMessage = message;
        responseMessage.once("close", cleanupAll);
        responseMessage.once("error", onResponseError);
        // 回调里抛出的东西没人接得住、会打死整个 agent 进程（network/incoming-response.ts）：
        // 表示不了的状态码只让这一次请求失败。
        let response: Response;
        try {
          response = toWebResponse(readIncomingResponse(message));
        } catch (error) {
          message.destroy();
          rejectOnce(error);
          return;
        }
        settled = true;
        resolve(response);
      },
    );

    clientRequest.once("error", onRequestError);
    clientRequest.once("close", onRequestClose);
    clientRequest.end(request.body);
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function createRequestAgent(
  url: URL,
  options: { ca?: Buffer; proxyUrl?: string },
): http.Agent | https.Agent | ProxyAgent {
  if (options.proxyUrl) {
    return new ProxyAgent({
      ca: options.ca,
      getProxyForUrl: () => options.proxyUrl ?? "",
      httpsAgent: options.ca ? new https.Agent({ ca: options.ca }) : undefined,
    }) as unknown as http.Agent;
  }

  if (url.protocol === "https:") {
    return new https.Agent({ ca: options.ca });
  }
  return new http.Agent();
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}
