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

/** Нефатальное уведомление о том, что вход кольца не принял соединение. */
export interface ProxyFallbackNotice {
  /** `host:port` прокси без логина и пароля. */
  proxy: string;
  /** Код сетевой ошибки (`ECONNREFUSED`, `cached` для уже помеченного входа). */
  code: string;
  /** `true` — запрос ушёл напрямую, `false` — переключились на следующий прокси. */
  direct: boolean;
}

interface NetworkProxyFetchOptions {
  caCertFile?: string;
  env?: Record<string, string | undefined>;
  fetch?: NetworkFetch;
  httpProxy?: string;
  httpProxyList?: readonly string[];
  noProxy?: string;
  /** Пробрасывает нефатальное предупреждение наверх; текст строит {@link formatProxyFallbackWarning}. */
  onProxyFallback?: (notice: ProxyFallbackNotice) => void;
}

// Процессное кольцо: следующий модельный запрос начинается с прокси, который
// пережил прошлый ответ. Идентичность списка сбрасывает курсор на выбранный вход.
let proxyRingIdentity = "";
let proxyRingCursor = 0;

// 原因：инцидент 149.248.50.68:1034. Мёртвый вход не должен выбираться каждым
// запросом подряд — держим его вне кольца 60 с, пока соседние входы отвечают.
// Ключ — только `host:port`, чтобы креденшелы не попадали в память и в логи.
export const PROXY_UNAVAILABLE_HEALTH_TTL_MS = 60_000;
const PROXY_UNAVAILABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

let proxyHealthIdentity = "";
const proxyUnavailableUntil = new Map<string, number>();
const announcedProxyFailures = new Set<string>();

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
    syncProxyHealthIdentity(proxies);
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
    const ordered = orderProxyCandidates(proxies, start);
    const failures: ProxyFallbackNotice[] = [];
    const live = ordered.filter((candidate) => {
      const key = proxyEndpointKey(candidate.proxy);
      if (!isProxyUnavailableRecently(key)) {
        return true;
      }
      failures.push({ code: "cached", direct: true, proxy: key });
      return false;
    });

    for (let attempt = 0; attempt < live.length; attempt += 1) {
      if (request.signal?.aborted) {
        throw abortReason(request.signal);
      }
      const { index, proxy } = live[attempt];
      const key = proxyEndpointKey(proxy);
      const proxyUrl = resolveProxyUrlForRequest(request.url, {
        ...options,
        httpProxy: proxy,
      });
      let response: Response;
      try {
        response = await fetchWithAgent(request, { ca, proxyUrl });
      } catch (error) {
        // 原因：прокси мог умереть между запросами (инцидент ECONNREFUSED 149.248.50.68:1034)
        // — это не ответ модели. Такой вход помечаем мёртвым и идём к следующему.
        if (!isProxyUnavailableError(error)) {
          throw error;
        }
        markProxyUnavailable(key);
        failures.push({ code: readProxyErrorCode(error), direct: false, proxy: key });
        continue;
      }
      const rateLimited = response.status === 429;
      if (rateLimited && attempt < live.length - 1) {
        // 原因：429 只说明这条出口被限流。下一次请求要从下一条开始，成功则留在当前。
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      clearProxyUnavailable(key);
      rememberProxyRingCursor(proxies, rateLimited ? (index + 1) % proxies.length : index);
      announceProxyFallback(failures, false, options);
      return response;
    }

    // Все входы кольца не приняли соединение: запрос уходит напрямую, без прокси.
    // Ошибку прямого соединения возвращаем как есть — это ошибка модели, не прокси.
    if (live.length > 0 || failures.length > 0) {
      announceProxyFallback(failures, true, options);
    }
    return fetchWithAgent(request, { ca, proxyUrl: undefined });
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

function orderProxyCandidates(
  proxies: readonly string[],
  start: number,
): Array<{ index: number; proxy: string }> {
  return proxies.map((proxy, offset) => ({
    index: (start + offset) % proxies.length,
    proxy,
  }));
}

/** `host:port` без userinfo — единственная форма, которую можно писать в лог и UI. */
function proxyEndpointKey(proxyUrl: string): string {
  try {
    return new URL(proxyUrl).host;
  } catch {
    return proxyUrl.replace(/\/\/[^@/]*@/u, "//").replace(/\/+$/u, "");
  }
}

/**
 * Сброс health-кэша при новом чтении конфига: список прокси — единственный
 * источник истины, старые отметки о смерти к нему не относятся.
 */
function syncProxyHealthIdentity(proxies: readonly string[]): void {
  const identity = proxies.join("\n");
  if (identity === proxyHealthIdentity) return;
  proxyHealthIdentity = identity;
  proxyUnavailableUntil.clear();
  announcedProxyFailures.clear();
}

function isProxyUnavailableRecently(key: string): boolean {
  const until = proxyUnavailableUntil.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  proxyUnavailableUntil.delete(key);
  return false;
}

function markProxyUnavailable(key: string): void {
  // TTL, а не бессрочная блокировка: прокси мог подняться, и через минуту его снова пробуем.
  proxyUnavailableUntil.set(key, Date.now() + PROXY_UNAVAILABLE_HEALTH_TTL_MS);
}

function clearProxyUnavailable(key: string): void {
  proxyUnavailableUntil.delete(key);
  announcedProxyFailures.delete(key);
}

/**
 * Ошибка установки туннеля до отправки запроса: прокси не принял соединение.
 * Обходим `cause` (как cline `isTransientNetworkError`) и `AggregateError.errors`.
 */
export function isProxyUnavailableError(error: unknown): boolean {
  return matchesProxyUnavailable(error, new Set<unknown>(), 0);
}

function matchesProxyUnavailable(error: unknown, seen: Set<unknown>, depth: number): boolean {
  if (!error || typeof error !== "object" || depth > 8 || seen.has(error)) return false;
  seen.add(error);

  if (error instanceof Error) {
    // Отмена — решение вызывающего, а не признак мёртвого прокси.
    if (error.name === "AbortError") return false;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && PROXY_UNAVAILABLE_ERROR_CODES.has(code)) return true;
    // socks-proxy-agent: CONNECT/SOCKS-рукопожатие не состоялось.
    if (error.name === "SocksClientError") return true;
    if (/proxy connection (?:failed|refused)|tunnel connection failed/iu.test(error.message)) {
      return true;
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause && matchesProxyUnavailable(cause, seen, depth + 1)) return true;

  const nested = (error as { errors?: unknown }).errors;
  return (
    Array.isArray(nested) &&
    nested.some((entry) => matchesProxyUnavailable(entry, seen, depth + 1))
  );
}

function readProxyErrorCode(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error && error.name !== "Error" ? error.name : "unknown";
}

/** Нефатальный текст для UI: только `host:port`, без логинов и паролей. */
export function formatProxyFallbackWarning(notice: ProxyFallbackNotice): string {
  const reason = notice.code === "cached" ? "marked unavailable" : notice.code;
  const target = notice.direct ? "using a direct connection" : "switching to the next proxy";
  return `Proxy ${notice.proxy} is unavailable (${reason}); ${target}.`;
}

function announceProxyFallback(
  failures: readonly ProxyFallbackNotice[],
  direct: boolean,
  options: NetworkProxyFetchOptions,
): void {
  const listener = options.onProxyFallback;
  if (!listener) return;
  for (const failure of failures) {
    // Один варнинг на вход в пределах health-окна: иначе каждый запрос повторяет тот же текст.
    if (announcedProxyFailures.has(failure.proxy)) continue;
    announcedProxyFailures.add(failure.proxy);
    listener({ ...failure, direct });
  }
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
