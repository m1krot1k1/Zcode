import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { domainToASCII } from "node:url";
import { AgentErrorCode } from "@zcode/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const OPENCODE_ROOT_DOMAIN = "opencode.ai";
const OPENCODE_GO_PATH = "/zen/go/v1";
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const PROXY_HEADER_LIMIT = 16 * 1024;
const SOCKS_HANDSHAKE_TIMEOUT_MS = 15_000;

interface SocksProxyAddress {
  hostname: string;
  password?: string;
  port: number;
  username?: string;
}

interface OpenCodeProxyLease {
  readonly localProxyUrl: string;
  dispose(): Promise<void>;
}

export interface OpenCodeTaskInput {
  description: string;
  prompt: string;
  subagent_type: string;
}

export interface OpenCodeSkillInput {
  skill: string;
  args?: string;
}

export interface OpenCodeTaskBridgeExecutors {
  executeTask?: (input: OpenCodeTaskInput) => Promise<string>;
  executeSkill?: (input: OpenCodeSkillInput) => Promise<string>;
}

export interface OpenCodeTaskBridge {
  readonly url: string;
  readonly bearerToken: string;
  dispose(): Promise<void>;
}

const UNKNOWN_AGENT_ROLE_MESSAGE =
  /^Agent type '[^'\r\n]{1,128}' is not available\. Choose one exact active role ID: ([^\r\n]{1,2048})$/u;
const SAFE_AGENT_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function getSafeUnknownAgentRoleMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== AgentErrorCode.UNKNOWN_AGENT_TYPE || typeof candidate.message !== "string") {
    return undefined;
  }
  const match = UNKNOWN_AGENT_ROLE_MESSAGE.exec(candidate.message);
  if (!match) return undefined;
  const profiles = match[1]
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => SAFE_AGENT_PROFILE_ID.test(profile));
  if (profiles.length === 0 || profiles.length > 32) return undefined;
  return `That ZCode agent profile is unavailable. Retry with one exact active role ID: ${profiles.join(", ")}.`;
}

/**
 * Invocation-scoped MCP bridge. The callback is captured from the current Core model
 * invocation; a lease can therefore never route into another session/runtime.
 */
export async function createOpenCodeTaskBridge(
  executors: OpenCodeTaskBridgeExecutors,
  signal?: AbortSignal,
): Promise<OpenCodeTaskBridge> {
  if (!executors.executeTask && !executors.executeSkill) {
    throw new Error("opencode.runtime-bridge-without-capabilities");
  }
  const bearerToken = randomBytes(32).toString("base64url");
  const pendingCalls = new Set<Promise<unknown>>();
  const activePosts = new Set<Promise<void>>();
  const mcpServer = new McpServer({ name: "zcode-runtime", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({
    // OpenCode sends initialize, initialized, list and tool calls as separate HTTP requests.
    // A stateless SDK transport is single-request-only, so this invocation owns one session.
    sessionIdGenerator: () => randomBytes(24).toString("base64url"),
    enableJsonResponse: true,
  });
  let acceptingRequests = true;
  let acceptingTools = true;
  let disposePromise: Promise<void> | undefined;
  const onAbort = () => {
    acceptingTools = false;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) acceptingTools = false;

  if (executors.executeTask) mcpServer.registerTool(
    "zcode_task",
    {
      title: "Delegate to a ZCode agent",
      description:
        "Run a task using a named ZCode agent profile. The task executes in the current ZCode session and returns its actual result.",
      inputSchema: {
        description: z.string().min(1).max(500),
        prompt: z.string().min(1).max(20_000),
        subagent_type: z.string().min(1).max(128),
      },
    },
    async (input) => {
      if (!acceptingTools || signal?.aborted) {
        return {
          content: [{ type: "text", text: "The ZCode task bridge is no longer active." }],
          isError: true,
        };
      }
      const call = executors.executeTask!(input as OpenCodeTaskInput);
      pendingCalls.add(call);
      try {
        const result = await call;
        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        // Never return arbitrary Core/provider error text: it may contain credentials or paths.
        const safeRoleFeedback = getSafeUnknownAgentRoleMessage(error);
        return {
          content: [{
            type: "text",
            text: safeRoleFeedback ?? "The ZCode agent task failed. See the ZCode conversation for details.",
          }],
          isError: true,
        };
      } finally {
        pendingCalls.delete(call);
      }
    },
  );

  if (executors.executeSkill) mcpServer.registerTool(
    "zcode_skill",
    {
      title: "Load a ZCode skill",
      description:
        "Load the full instructions for one skill listed in the current ZCode context. Use its exact skill name; never read a skill file path directly.",
      inputSchema: {
        skill: z.string().min(1).max(256),
        args: z.string().max(20_000).optional(),
      },
    },
    async (input) => {
      if (!acceptingTools || signal?.aborted) {
        return {
          content: [{ type: "text", text: "The ZCode skill bridge is no longer active." }],
          isError: true,
        };
      }
      const call = executors.executeSkill!(input as OpenCodeSkillInput);
      pendingCalls.add(call);
      try {
        return { content: [{ type: "text", text: await call }] };
      } catch {
        // SkillPort errors can contain local paths; expose only a fixed provider-safe message.
        return {
          content: [{ type: "text", text: "The ZCode skill could not be loaded. See the ZCode conversation for details." }],
          isError: true,
        };
      } finally {
        pendingCalls.delete(call);
      }
    },
  );

  await mcpServer.connect(transport);
  const httpServer = createHttpServer((request, response) => {
    if (!isAuthorizedBridgeRequest(request, bearerToken)) {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("ZCode task bridge unavailable");
      return;
    }
    if (!acceptingRequests || (!acceptingTools && request.method === "POST")) {
      response.writeHead(410, { "content-type": "text/plain" });
      response.end("ZCode task bridge unavailable");
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404);
      response.end();
      return;
    }
    const requestHandler = transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
    if (request.method === "POST") {
      activePosts.add(requestHandler);
      void requestHandler.finally(() => activePosts.delete(requestHandler));
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    await mcpServer.close().catch(() => undefined);
    throw error;
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeServer(httpServer);
    await mcpServer.close().catch(() => undefined);
    throw new Error("opencode.task-bridge-listener-unavailable");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearerToken,
    dispose: () => {
      if (disposePromise) return disposePromise;
      acceptingTools = false;
      disposePromise = (async () => {
        signal?.removeEventListener("abort", onAbort);
        await Promise.allSettled(pendingCalls);
        await Promise.allSettled(activePosts);
        acceptingRequests = false;
        await mcpServer.close().catch(() => undefined);
        await closeServer(httpServer);
      })();
      return disposePromise;
    },
  };
}

function isAuthorizedBridgeRequest(request: IncomingMessage, bearerToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${bearerToken}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

interface SharedProxyLeaseState {
  disposeBridge: () => Promise<void>;
  environment: NodeJS.ProcessEnv;
  localProxyUrl: string;
  originalValues: Map<(typeof PROXY_ENV_KEYS)[number], string | undefined>;
  references: number;
  sourceUrl: string;
}

let sharedProxyLease: SharedProxyLeaseState | undefined;

export function isOpenCodeGoBaseUrl(baseURL: string | undefined): boolean {
  const trimmed = baseURL?.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
    return (
      (hostname === OPENCODE_ROOT_DOMAIN || hostname.endsWith(`.${OPENCODE_ROOT_DOMAIN}`)) &&
      path === OPENCODE_GO_PATH
    );
  } catch {
    return false;
  }
}

/**
 * Bun/OpenCode 不 принимает SOCKS URL в HTTP_PROXY. На время жизни OpenCode runtime
 * даём его дочернему процессу loopback HTTP proxy, который туннелирует запросы через
 * SOCKS5. Адрес и учётные данные остаются только в памяти и не попадают в логи.
 */
export async function acquireOpenCodeSocksProxyLease(
  proxyUrl: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<OpenCodeProxyLease | undefined> {
  const address = parseSocksProxyAddress(proxyUrl);
  if (!address || !proxyUrl) return undefined;

  if (sharedProxyLease) {
    if (sharedProxyLease.sourceUrl !== proxyUrl || sharedProxyLease.environment !== environment) {
      throw new Error("opencode.proxy-configuration-conflict");
    }
    sharedProxyLease.references += 1;
    return createProxyLease(sharedProxyLease);
  }

  const bridge = await startSocksHttpProxyBridge(address);
  const state: SharedProxyLeaseState = {
    disposeBridge: bridge.dispose,
    environment,
    localProxyUrl: bridge.proxyUrl,
    originalValues: new Map(PROXY_ENV_KEYS.map((key) => [key, environment[key]])),
    references: 1,
    sourceUrl: proxyUrl,
  };
  for (const key of PROXY_ENV_KEYS) environment[key] = bridge.proxyUrl;
  sharedProxyLease = state;
  return createProxyLease(state);
}

/** Выбирает свободный loopback port, чтобы OpenCode не присоединился к чужому серверу. */
export async function findOpenCodeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("opencode.local-port-unavailable");
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

function createProxyLease(state: SharedProxyLeaseState): OpenCodeProxyLease {
  let disposed = false;
  return {
    localProxyUrl: state.localProxyUrl,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      state.references -= 1;
      if (state.references > 0) return;

      if (sharedProxyLease === state) sharedProxyLease = undefined;
      for (const key of PROXY_ENV_KEYS) {
        if (state.environment[key] === state.localProxyUrl) {
          const originalValue = state.originalValues.get(key);
          if (originalValue === undefined) delete state.environment[key];
          else state.environment[key] = originalValue;
        }
      }
      await state.disposeBridge();
    },
  };
}

function parseSocksProxyAddress(value: string | undefined): SocksProxyAddress | undefined {
  if (!value?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("opencode.proxy-configuration-invalid");
  }
  if (url.protocol === "http:" || url.protocol === "https:") return undefined;
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error("opencode.proxy-protocol-unsupported");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash || !url.hostname) {
    throw new Error("opencode.proxy-configuration-invalid");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const port = url.port ? Number(url.port) : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("opencode.proxy-configuration-invalid");
  }
  return {
    hostname,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    port,
    username: url.username ? decodeURIComponent(url.username) : undefined,
  };
}

async function startSocksHttpProxyBridge(
  proxy: SocksProxyAddress,
): Promise<{ dispose: () => Promise<void>; proxyUrl: string }> {
  const activeSockets = new Set<Socket>();
  const server = createServer((client) => {
    activeSockets.add(client);
    client.once("close", () => activeSockets.delete(client));
    void handleHttpProxyClient(client, proxy);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("opencode.proxy-bridge-start-failed");
  }
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    dispose: async () => {
      for (const socket of activeSockets) socket.destroy();
      await closeServer(server);
    },
  };
}

async function handleHttpProxyClient(client: Socket, proxy: SocksProxyAddress): Promise<void> {
  let upstream: Socket | undefined;
  try {
    client.setTimeout(SOCKS_HANDSHAKE_TIMEOUT_MS, () => client.destroy());
    const header = await readHttpHeader(client);
    const lines = header.toString("latin1").split("\r\n");
    const [method, target, version] = (lines.shift() ?? "").split(" ");
    if (!method || !target || !version) throw new Error("invalid-http-request");

    if (method.toUpperCase() === "CONNECT") {
      const destination = parseAuthority(target);
      upstream = await connectSocks5(proxy, destination.hostname, destination.port);
      closeSocketPair(client, upstream);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.setTimeout(0);
      client.pipe(upstream);
      upstream.pipe(client);
      return;
    }

    const destination = new URL(target);
    if (destination.protocol !== "http:") throw new Error("unsupported-http-proxy-target");
    upstream = await connectSocks5(proxy, destination.hostname, Number(destination.port || 80));
    closeSocketPair(client, upstream);
    const forwardedHeaders = lines.filter((line) => {
      const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
      return name !== "proxy-authorization" && name !== "proxy-connection";
    });
    upstream.write(
      `${method} ${destination.pathname || "/"}${destination.search} ${version}\r\n${forwardedHeaders.join("\r\n")}\r\n\r\n`,
    );
    client.setTimeout(0);
    client.pipe(upstream);
    upstream.pipe(client);
  } catch {
    if (!client.destroyed) {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    upstream?.destroy();
  }
}

function closeSocketPair(client: Socket, upstream: Socket): void {
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
}

function parseAuthority(value: string): { hostname: string; port: number } {
  let hostname: string;
  let portText: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") throw new Error("invalid-connect-authority");
    hostname = value.slice(1, end);
    portText = value.slice(end + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) throw new Error("invalid-connect-authority");
    hostname = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }
  const port = Number(portText);
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid-connect-authority");
  }
  return { hostname, port };
}

async function connectSocks5(
  proxy: SocksProxyAddress,
  hostname: string,
  port: number,
): Promise<Socket> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const upstream = createConnection({ host: proxy.hostname, port: proxy.port });
    const onError = (error: Error) => {
      upstream.destroy();
      reject(error);
    };
    upstream.once("error", onError);
    upstream.once("connect", () => {
      upstream.off("error", onError);
      resolve(upstream);
    });
  });
  socket.setTimeout(SOCKS_HANDSHAKE_TIMEOUT_MS, () => socket.destroy());

  try {
    const username = Buffer.from(proxy.username ?? "", "utf8");
    const password = Buffer.from(proxy.password ?? "", "utf8");
    if (username.length > 255 || password.length > 255) throw new Error("invalid-proxy-credentials");
    const useAuthentication = username.length > 0 || password.length > 0;
    socket.write(useAuthentication ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    const [version, method] = await readSocketExactly(socket, 2);
    if (version !== 5 || method === 255 || (method === 2 && !useAuthentication)) {
      throw new Error("socks-authentication-rejected");
    }
    if (method === 2) {
      socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
      const [authVersion, authStatus] = await readSocketExactly(socket, 2);
      if (authVersion !== 1 || authStatus !== 0) throw new Error("socks-authentication-rejected");
    } else if (method !== 0) {
      throw new Error("socks-authentication-method-unsupported");
    }

    const destination = encodeSocksAddress(hostname);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), destination, Buffer.from([port >> 8, port & 255])]));
    const response = await readSocketExactly(socket, 4);
    if (response[0] !== 5 || response[1] !== 0) throw new Error("socks-connect-rejected");
    const addressLength = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await readSocketExactly(socket, 1))[0] : 0;
    if (addressLength === 0) throw new Error("socks-address-type-unsupported");
    await readSocketExactly(socket, addressLength + 2);
    socket.setTimeout(0);
    socket.resume();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function encodeSocksAddress(hostname: string): Buffer {
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    return Buffer.concat([Buffer.from([1]), Buffer.from(hostname.split(".").map(Number))]);
  }
  if (ipVersion === 6) {
    const groups = expandIpv6(hostname);
    const bytes = Buffer.alloc(16);
    groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
    return Buffer.concat([Buffer.from([4]), bytes]);
  }
  const asciiHostname = domainToASCII(hostname);
  const encoded = Buffer.from(asciiHostname, "ascii");
  if (!encoded.length || encoded.length > 255) throw new Error("invalid-target-host");
  return Buffer.concat([Buffer.from([3, encoded.length]), encoded]);
}

function expandIpv6(hostname: string): number[] {
  const normalized = hostname.toLowerCase();
  const [leftText, rightText = ""] = normalized.split("::");
  const parseGroups = (text: string): number[] =>
    text ? text.split(":").filter(Boolean).map((part) => Number.parseInt(part, 16)) : [];
  const left = parseGroups(leftText);
  const right = parseGroups(rightText);
  const zeros = 8 - left.length - right.length;
  if (zeros < 0 || (normalized.includes("::") ? zeros < 1 : zeros !== 0)) {
    throw new Error("invalid-target-host");
  }
  return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

function readHttpHeader(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("http-header-incomplete"));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary >= 0) {
        const headerEnd = boundary + 4;
        const header = buffered.subarray(0, headerEnd);
        const remainder = buffered.subarray(headerEnd);
        cleanup();
        if (remainder.length > 0) socket.unshift(remainder);
        resolve(header);
        return;
      }
      if (buffered.length > PROXY_HEADER_LIMIT) {
        cleanup();
        reject(new Error("http-header-too-large"));
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function readSocketExactly(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socks-handshake-incomplete"));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= length) {
        const result = buffered.subarray(0, length);
        const remainder = buffered.subarray(length);
        socket.pause();
        cleanup();
        if (remainder.length > 0) socket.unshift(remainder);
        resolve(result);
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.resume();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
