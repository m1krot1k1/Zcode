import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";

/**
 * Device-side egress relay for isolated remote hosts.
 *
 * A remote workspace can be reachable over SSH while having no outbound
 * internet of its own — a pentest VM whose resolver points at a local
 * dnscrypt-proxy, with the Tor DNSPort it depends on not running. Model
 * requests issued *on that host* then fail with a network error before any
 * provider is contacted, and no setting on the remote can repair it.
 *
 * This relay runs on the device that runs the desktop app, binds to loopback
 * only, and is exposed to the remote host through the SSH connection that is
 * already open. The remote agent receives it as an HTTP proxy and uses it only
 * after a direct attempt fails, so hosts with their own egress keep using it.
 *
 * Scope: it forwards CONNECT tunnels and absolute-URI HTTP requests. It does
 * not terminate TLS — the remote client keeps its own TLS session end to end,
 * so nothing is re-signed and no CA has to be installed on the remote host.
 */

export interface EgressRelayOptions {
  /** Bind address; loopback only unless explicitly widened. */
  host?: string;
  /** Port to bind; 0 selects a free port. */
  port?: number;
}

export interface EgressRelay {
  /** URL the remote host should use, e.g. http://127.0.0.1:41234 */
  readonly url: string;
  readonly port: number;
  dispose(): Promise<void>;
}

const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/** Client sockets that already received a failure response. */
const failedSockets = new WeakSet<net.Socket>();

function writeProxyFailure(socket: net.Socket, status: number, reason: string): void {
  // The dial can fail from more than one place (timeout, error, close) and each
  // may fire after another already answered. Writing twice throws
  // ERR_STREAM_WRITE_AFTER_END, which would take the host process down, so a
  // failure is reported exactly once per socket.
  if (socket.destroyed || socket.writableEnded || failedSockets.has(socket)) return;
  failedSockets.add(socket);
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

function pipeBothWays(left: net.Socket, right: net.Socket): void {
  left.on("error", () => right.destroy());
  right.on("error", () => left.destroy());
  left.on("close", () => right.destroy());
  right.on("close", () => left.destroy());
  left.pipe(right);
  right.pipe(left);
}

/** Dial the CONNECT authority from this device and splice both sockets. */
function handleConnect(
  request: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
): void {
  const authority = request.url ?? "";
  const separator = authority.lastIndexOf(":");
  if (separator <= 0) {
    writeProxyFailure(clientSocket, 400, "Bad Request");
    return;
  }
  const host = authority.slice(0, separator).replace(/^\[|\]$/gu, "");
  const port = Number(authority.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    writeProxyFailure(clientSocket, 400, "Bad Request");
    return;
  }

  const upstream = net.connect({ host, port });
  let established = false;
  // A stalled dial must not hold the tunnel open, and it must fail visibly: a
  // bare destroy() emits close, not error, and a socket timeout is unreliable
  // while a connect is still pending (the kernel keeps retrying the SYN), so
  // the dial bound is an explicit timer the success path clears.
  const dialTimer = setTimeout(() => {
    if (established) return;
    upstream.destroy();
    writeProxyFailure(clientSocket, 504, "Gateway Timeout");
  }, UPSTREAM_IDLE_TIMEOUT_MS);
  upstream.once("connect", () => {
    established = true;
    clearTimeout(dialTimer);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    pipeBothWays(clientSocket, upstream);
  });
  upstream.once("error", () => {
    clearTimeout(dialTimer);
    writeProxyFailure(clientSocket, 502, "Bad Gateway");
  });
  upstream.once("close", () => {
    clearTimeout(dialTimer);
    if (!established) writeProxyFailure(clientSocket, 502, "Bad Gateway");
  });
}

/**
 * Forward a plain absolute-URI request. Some health probes use this form, and
 * supporting it keeps one relay for both shapes. https:// targets are refused
 * here: forwarding them in the clear would silently downgrade the client's
 * expectation of confidentiality, so those must use CONNECT.
 */
function handleAbsoluteRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  let target: URL;
  try {
    target = new URL(request.url ?? "");
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (target.protocol !== "http:") {
    response.writeHead(400).end();
    return;
  }
  const forwarded = http.request(
    {
      host: target.hostname,
      port: target.port ? Number(target.port) : 80,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...request.headers, host: target.host },
      timeout: UPSTREAM_IDLE_TIMEOUT_MS,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  forwarded.on("timeout", () => forwarded.destroy());
  forwarded.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(forwarded);
}

export function createEgressRelay(options: EgressRelayOptions = {}): Promise<EgressRelay> {
  const host = options.host?.trim() || "127.0.0.1";
  const requestedPort = options.port ?? 0;

  const server = http.createServer((request, response) => {
    if (/^https?:\/\//u.test(request.url ?? "")) {
      handleAbsoluteRequest(request, response);
      return;
    }
    response.writeHead(405).end();
  });

  server.on("connect", (request, clientSocket, head) => {
    handleConnect(request, clientSocket as net.Socket, head);
  });

  return new Promise<EgressRelay>((resolve, reject) => {
    const onListenError = (error: Error) => reject(error);
    server.once("error", onListenError);
    server.listen(requestedPort, host, () => {
      server.off("error", onListenError);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("egress relay did not bind a TCP port"));
        return;
      }
      let disposed: Promise<void> | undefined;
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        dispose() {
          disposed ??= new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          });
          return disposed;
        },
      });
    });
  });
}
