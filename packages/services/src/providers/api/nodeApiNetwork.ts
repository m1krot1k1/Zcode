import { readFile } from "node:fs/promises";
import { connect as connectNet, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface HostApiNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
}

export interface HostApiNetworkTransport {
  fetch: typeof fetch;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

type HostProxyRoute =
  | { kind: "direct"; noProxyMatched?: boolean }
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "invalid"; reason: string };

export function mergeHostApiCaCertificates(
  customCa: string,
  defaultCa: readonly string[] = rootCertificates,
): string[] {
  // Node 的 tls.ca 会替换而不是追加默认根证书。只传企业代理 CA 会让未被
  // 中间人重签的公网证书失去信任链，因此必须同时保留 Node 默认根证书。
  return [...defaultCa, customCa];
}

function normalizeProxyUrl(value: string): string | undefined {
  const shorthand = value.match(/^([^:/\s]+):(\d+):([^:]*):(.*)$/u);
  const candidate = shorthand
    ? `socks5://${encodeURIComponent(shorthand[3] ?? "")}:${encodeURIComponent(shorthand[4] ?? "")}@${shorthand[1]}:${shorthand[2]}`
    : /^socks:\/\//iu.test(value)
      ? value.replace(/^socks:/iu, "socks5:")
      : /^\w[\w+.-]*:\/\//.test(value)
        ? value
        : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname || !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export type ProxyConnectivityResult =
  | { ok: true; outboundIp: string }
  | {
      ok: false;
      reason: "invalid_proxy" | "connection_failed" | "timeout" | "invalid_response";
    };

const PROXY_TEST_TARGETS = [
  { host: "api.ipify.org", path: "/?format=json", accept: "application/json" },
  { host: "checkip.amazonaws.com", path: "/", accept: "text/plain" },
  { host: "icanhazip.com", path: "/", accept: "text/plain" },
] as const;

/** Проверяет прокси только по явному запросу UI; значения URL и ошибки с credentials наружу не возвращаются. */
export async function testProxyConnectivity(rawProxy: string): Promise<ProxyConnectivityResult> {
  const normalized = normalizeProxyUrl(rawProxy.trim());
  if (!normalized) return { ok: false, reason: "invalid_proxy" };

  let proxy: URL;
  try {
    proxy = new URL(normalized);
  } catch {
    return { ok: false, reason: "invalid_proxy" };
  }

  let lastReason: Extract<ProxyConnectivityResult, { ok: false }>["reason"] = "connection_failed";
  for (const target of PROXY_TEST_TARGETS) {
    let dispatcher: Dispatcher | undefined;
    try {
      dispatcher = new Agent({
        connect: (
          _options: Record<string, unknown>,
          callback: (error: Error | null, socket?: Socket | null) => void,
        ) => {
          void createProxyTestTunnel(proxy, target.host)
            .then((socket) => {
              const secureSocket = connectTls({
                socket,
                servername: target.host,
              });
              secureSocket.setTimeout(8_000, () =>
                secureSocket.destroy(new Error("proxy response timeout")),
              );
              secureSocket.once("secureConnect", () => callback(null, secureSocket));
              secureSocket.once("error", (error) => callback(error, null));
            })
            .catch((error: unknown) =>
              callback(error instanceof Error ? error : new Error("proxy connection failed"), null),
            );
          return undefined;
        },
      } as never);
      const response = await undiciFetch(`https://${target.host}${target.path}`, {
        dispatcher,
        signal: AbortSignal.timeout(8_000),
        headers: { accept: target.accept },
      } as never);
      if (!response.ok) {
        lastReason = "connection_failed";
        continue;
      }
      const body = (await response.text()).slice(0, 512);
      let outboundIp = "";
      try {
        const parsed = JSON.parse(body) as { ip?: unknown };
        outboundIp = typeof parsed.ip === "string" ? parsed.ip : "";
      } catch {
        outboundIp = body.trim();
      }
      if (isIP(outboundIp)) return { ok: true, outboundIp };
      lastReason = "invalid_response";
    } catch (error) {
      lastReason =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "connection_failed";
    } finally {
      await dispatcher?.close().catch(() => undefined);
    }
  }
  return { ok: false, reason: lastReason };
}

const pendingSocketBytes = new WeakMap<Socket, Buffer>();

async function createProxyTestTunnel(
  proxy: URL,
  targetHost: string,
  targetPort = 443,
): Promise<Socket> {
  const port = Number(
    proxy.port || (proxy.protocol === "https:" ? 443 : proxy.protocol === "http:" ? 80 : 1080),
  );
  // Bug 原因：Node socket.setTimeout 只覆盖建连后的空闲阶段，代理主机不响应 TCP
  // 握手时不会触发它，导致批量测试永远停在 Testing。连接阶段单独使用可销毁 socket 的定时器。
  const proxySocket =
    proxy.protocol === "https:"
      ? await connectSocketWithTimeout(
          connectTls({
            host: proxy.hostname,
            port,
            servername: proxy.hostname,
          }),
          "secureConnect",
        )
      : await connectSocketWithTimeout(connectNet({ host: proxy.hostname, port }), "connect");
  proxySocket.setTimeout(8_000, () => proxySocket.destroy(new Error("proxy timeout")));

  if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
    const hasCredentials = Boolean(proxy.username || proxy.password);
    proxySocket.write(Buffer.from([5, hasCredentials ? 2 : 1, 0, 2]));
    const greeting = await readSocketBytes(proxySocket, 2);
    if (greeting[0] !== 5 || greeting[1] === 255)
      throw new Error("proxy authentication unavailable");
    if (greeting[1] === 2) {
      const username = decodeURIComponent(proxy.username);
      const password = decodeURIComponent(proxy.password);
      const userBytes = Buffer.from(username);
      const passBytes = Buffer.from(password);
      if (!userBytes.length || userBytes.length > 255 || passBytes.length > 255) {
        throw new Error("proxy authentication invalid");
      }
      proxySocket.write(
        Buffer.concat([
          Buffer.from([1, userBytes.length]),
          userBytes,
          Buffer.from([passBytes.length]),
          passBytes,
        ]),
      );
      const auth = await readSocketBytes(proxySocket, 2);
      if (auth[1] !== 0) throw new Error("proxy authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error("proxy authentication unavailable");
    }
    const host = Buffer.from(targetHost);
    proxySocket.write(
      Buffer.concat([
        Buffer.from([5, 1, 0, 3, host.length]),
        host,
        Buffer.from([targetPort >> 8, targetPort & 0xff]),
      ]),
    );
    const reply = await readSocketBytes(proxySocket, 4);
    if (reply[1] !== 0) throw new Error("proxy tunnel rejected");
    const addressLength =
      reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : ((await readSocketBytes(proxySocket, 1))[0] ?? 0);
    await readSocketBytes(proxySocket, addressLength + 2);
    return proxySocket;
  }

  const auth =
    proxy.username || proxy.password
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
      : "";
  proxySocket.write(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}Connection: keep-alive\r\n\r\n`,
  );
  const headers = await readSocketHeader(proxySocket);
  if (!/^HTTP\/\d(?:\.\d)? 200\b/u.test(headers)) throw new Error("proxy tunnel rejected");
  return proxySocket;
}

function connectSocketWithTimeout(
  socket: Socket,
  eventName: "connect" | "secureConnect",
  timeoutMs = 8_000,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("proxy connect timeout"));
    }, timeoutMs);
    socket.once(eventName, onConnect);
    socket.once("error", onError);
  });
}

export async function readSocketBytes(socket: Socket, expectedLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Node's flowing `data` mode does not reliably re-emit bytes passed back
    // with socket.unshift(). Keep surplus protocol bytes ourselves so a SOCKS
    // reply coalesced into one TCP packet cannot stall the next read.
    let received = pendingSocketBytes.get(socket) ?? Buffer.alloc(0);
    pendingSocketBytes.delete(socket);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = () => {
      cleanup();
      const result = received.subarray(0, expectedLength);
      const remainder = received.subarray(expectedLength);
      if (remainder.length) pendingSocketBytes.set(socket, remainder);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < expectedLength) return;
      finish();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy closed connection"));
    };
    if (received.length >= expectedLength) {
      finish();
      return;
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function readSocketHeader(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) {
        if (received.length > 16_384) {
          cleanup();
          reject(new Error("proxy response too large"));
        }
        return;
      }
      cleanup();
      const remainder = received.subarray(end + 4);
      if (remainder.length) socket.unshift(remainder);
      resolve(received.subarray(0, end).toString("latin1"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy closed connection"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function matchesNoProxy(url: URL, value: string | undefined): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (value ?? "").split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;

    const ruleWithoutScheme = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    const [ruleHost = "", rulePort] = ruleWithoutScheme.split(":");
    const normalizedHost = ruleHost.replace(/^\*\.?/, "").replace(/^\./, "");
    if (!normalizedHost) return false;
    const hostMatches = host === normalizedHost || host.endsWith(`.${normalizedHost}`);
    return hostMatches && (!rulePort || rulePort === port);
  });
}

export function resolveHostProxyForUrl(
  requestUrl: string | URL,
  options: HostApiNetworkOptions,
): HostProxyRoute {
  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { kind: "direct" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "direct" };
  }
  if (matchesNoProxy(url, options.noProxy)) {
    return { kind: "direct", noProxyMatched: true };
  }
  const configuredProxy = options.httpProxy?.trim();
  if (!configuredProxy) {
    return { kind: "direct" };
  }
  const proxyUrl = normalizeProxyUrl(configuredProxy);
  return proxyUrl
    ? { kind: "proxy", proxyUrl }
    : { kind: "invalid", reason: "Configured Host proxy URL is invalid" };
}

interface HostApiNetworkTransportDependencies {
  createDispatcher?: typeof createDispatcher;
  fetchWithDispatcher?: (
    input: string,
    init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
  ) => Promise<Response>;
}

export function createHostApiNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
  dependencies: HostApiNetworkTransportDependencies = {},
): HostApiNetworkTransport {
  // Host 是独立 Node 进程，Electron Session.setProxy 不会影响它的 globalThis.fetch；
  // 在 NodeApiClient 出口按请求注入 dispatcher，避免把 telemetry 等其它裸 fetch 全局改道。
  let optionsPromise: Promise<HostApiNetworkOptions> | undefined;
  const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
  let disposed = false;
  let generation = 0;
  let pendingDispatcherCreations = 0;
  let resolveDispatcherCreations: (() => void) | undefined;
  let dispatcherCreationsDone: Promise<void> | undefined;
  const lateDisposePromises: Promise<void>[] = [];
  let disposePromise: Promise<void> | undefined;
  let disposeMode: "close" | "destroy" | undefined;
  const dispatcherFactory = dependencies.createDispatcher ?? createDispatcher;
  const fetchWithDispatcher =
    dependencies.fetchWithDispatcher ??
    ((input, init) => undiciFetch(input, init as never) as unknown as Promise<Response>);

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (disposed) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestGeneration = generation;
    if (!optionsPromise) {
      // 设置读取失败只影响当前请求；清掉 rejected promise，避免一次瞬时 IPC/启动竞态
      // 把 Host API 永久锁死，同时仍保持失败请求不回退到直连。
      optionsPromise = resolveOptions().catch((error: unknown) => {
        optionsPromise = undefined;
        throw error;
      });
    }
    const options = await optionsPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestUrl = input instanceof Request ? input.url : String(input);
    const route = resolveHostProxyForUrl(requestUrl, options);
    if (route.kind === "invalid") {
      throw new Error(route.reason);
    }
    if (route.kind === "direct" && !options.caCertPath) {
      return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
    }

    const dispatcherKey = `${route.kind}:${route.kind === "proxy" ? route.proxyUrl : "direct"}:${options.caCertPath ?? ""}`;
    let dispatcherPromise = dispatcherPromises.get(dispatcherKey);
    if (!dispatcherPromise) {
      if (disposed) {
        throw new Error("Host API network transport has been disposed");
      }
      const dispatcherGeneration = generation;
      pendingDispatcherCreations += 1;
      dispatcherPromise = dispatcherFactory(route, options.caCertPath);
      dispatcherPromises.set(dispatcherKey, dispatcherPromise);
      void dispatcherPromise
        .then((dispatcher) => {
          if (
            (disposed || generation !== dispatcherGeneration) &&
            dispatcherPromises.get(dispatcherKey) === dispatcherPromise
          ) {
            dispatcherPromises.delete(dispatcherKey);
            const cleanupPromise = Promise.resolve(
              disposeMode === "close" ? dispatcher.close() : dispatcher.destroy(),
            ).catch(() => {});
            lateDisposePromises.push(cleanupPromise);
          }
        })
        .catch(() => {});
      const markDispatcherCreationDone = () => {
        pendingDispatcherCreations -= 1;
        if (pendingDispatcherCreations === 0) {
          resolveDispatcherCreations?.();
          resolveDispatcherCreations = undefined;
        }
      };
      void dispatcherPromise.then(markDispatcherCreationDone, markDispatcherCreationDone);
      dispatcherPromise.catch(() => {
        // 设置/CA 等临时 IO 失败只影响当前请求；清理 rejected dispatcher，避免一次启动竞态
        // 把同一路由永久锁死，同时仍保持失败请求 fail-closed、不回退到直连。
        if (dispatcherPromises.get(dispatcherKey) === dispatcherPromise) {
          dispatcherPromises.delete(dispatcherKey);
        }
      });
    }
    const dispatcher = await dispatcherPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    return fetchWithDispatcher(
      input as unknown as string,
      {
        ...init,
        dispatcher,
      } as Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
    );
  };

  const startDispose = (mode: "close" | "destroy"): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    generation += 1;
    disposeMode = mode;
    // dispatcher 不能只被闭包缓存、没有 Host owner：窗口/远端 Host 重建后连接池和
    // keep-alive socket 仍可能存活。释放时对当前单飞 Promise 做快照，确保初始化中的 dispatcher
    // 也会在完成后被收口；同步退出 destroy，等待式退出 close。
    const pendingDispatchers = [...dispatcherPromises.values()];
    dispatcherPromises.clear();
    if (pendingDispatcherCreations > 0) {
      dispatcherCreationsDone = new Promise<void>((resolve) => {
        resolveDispatcherCreations = resolve;
      });
    }
    disposePromise = (async () => {
      await Promise.allSettled(
        pendingDispatchers.map(async (dispatcherPromise) => {
          const dispatcher = await dispatcherPromise;
          if (mode === "close") {
            await dispatcher.close();
          } else {
            await dispatcher.destroy();
          }
        }),
      );
      await dispatcherCreationsDone;
      await Promise.all(lateDisposePromises);
    })();
    return disposePromise;
  };

  return {
    fetch,
    dispose() {
      void startDispose("destroy");
    },
    disposeAndWait() {
      return startDispose("close");
    },
  };
}

async function createDispatcher(
  route: Exclude<HostProxyRoute, { kind: "invalid" }>,
  caCertPath: string | undefined,
): Promise<Dispatcher> {
  const customCa = caCertPath ? await readFile(caCertPath, "utf8") : undefined;
  const ca = customCa ? mergeHostApiCaCertificates(customCa) : undefined;
  if (route.kind === "proxy") {
    const proxy = new URL(route.proxyUrl);
    if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
      // Undici ProxyAgent 支持 HTTP CONNECT；SOCKS 在同一 Host transport 内走自定义隧道。
      return new Agent({
        connect: (
          options: Record<string, unknown>,
          callback: (error: Error | null, socket?: Socket | null) => void,
        ) => {
          const targetHost = String(options.hostname ?? options.host ?? "");
          const targetPort = Number(options.port || 443);
          void createProxyTestTunnel(proxy, targetHost, targetPort)
            .then((socket) => {
              if (options.protocol === "http:") {
                callback(null, socket);
                return;
              }
              const secureSocket = connectTls({
                socket,
                servername: String(options.servername ?? targetHost),
                ca,
              });
              secureSocket.once("secureConnect", () => callback(null, secureSocket));
              secureSocket.once("error", (error) => callback(error, null));
            })
            .catch((error: unknown) =>
              callback(error instanceof Error ? error : new Error("proxy connection failed"), null),
            );
          return undefined;
        },
      } as never);
    }
    return new ProxyAgent({
      uri: route.proxyUrl,
      proxyTls: ca ? { ca } : undefined,
      requestTls: ca ? { ca } : undefined,
    });
  }
  return new Agent({ connect: ca ? { ca } : undefined });
}
