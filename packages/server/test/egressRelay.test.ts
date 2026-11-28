import net from "node:net";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createEgressRelay, type EgressRelay } from "../src/remote/egressRelay.js";

/**
 * The relay is the piece that actually carries a model request on an isolated
 * host: everything else in this feature (the reverse forward, the handoff file,
 * the env flag) only decides whether the agent is told to use it. It had no
 * test at all, so these cases drive real sockets rather than mocks — a proxy
 * that is mocked is a proxy whose splicing, failure responses and framing are
 * all unverified.
 *
 * What is NOT covered here: TLS. The relay never terminates it (CONNECT is a
 * blind splice), so correctness of the end-to-end session is the remote
 * client's own, not this component's.
 */

const cleanups: Array<() => Promise<void> | void> = [];
/** Client sockets this file opened, destroyed before any server teardown:
 *  a test that fails mid-tunnel must not spend 30 s waiting for the relay's
 *  own idle timeout before the suite can move on. */
const clientSockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of clientSockets) socket.destroy();
  clientSockets.clear();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
});

/** A raw TCP server that echoes every byte back, upper-cased so direction is visible. */
async function startEchoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", (chunk) => socket.write(chunk.toString("utf8").toUpperCase()));
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function startRelay(): Promise<EgressRelay> {
  const relay = await createEgressRelay();
  cleanups.push(() => relay.dispose());
  return relay;
}

/**
 * Speak CONNECT to the relay and return the socket once the tunnel is open.
 * Returns the status line instead when the relay refuses, so failure cases
 * assert on what a real client would see.
 */
function openTunnel(
  relay: EgressRelay,
  authority: string,
): Promise<{ socket: net.Socket; statusLine: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relay.port, "127.0.0.1");
    clientSockets.add(socket);
    let buffer = "";
    let settled = false;
    const finish = (value: { socket: net.Socket; statusLine: string; body: string }) => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      resolve(value);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const separator = buffer.indexOf("\r\n\r\n");
      const newline = buffer.indexOf("\r\n");
      if (newline < 0) return;
      const statusLine = buffer.slice(0, newline);
      if (statusLine.includes(" 200 ")) {
        if (separator < 0) return;
        finish({ socket, statusLine, body: buffer.slice(separator + 4) });
        return;
      }
      finish({ socket, statusLine, body: buffer.slice(separator + 4) });
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
  });
}

describe("egress relay", () => {
  it("splices a CONNECT tunnel in both directions", async () => {
    const echo = await startEchoServer();
    cleanups.push(() => echo.close());
    const relay = await startRelay();

    const { socket, statusLine } = await openTunnel(relay, `127.0.0.1:${echo.port}`);
    expect(statusLine).toContain("200");

    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no echo came back")), 5_000);
      socket.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(chunk.toString("utf8"));
      });
      socket.write("hello relay");
    });
    expect(received).toBe("HELLO RELAY");
    socket.destroy();
  });

  it("carries a payload larger than one TCP segment", async () => {
    const echo = await startEchoServer();
    cleanups.push(() => echo.close());
    const relay = await startRelay();

    const { socket } = await openTunnel(relay, `127.0.0.1:${echo.port}`);
    const payload = "x".repeat(256 * 1024);
    let total = 0;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`only ${total} bytes came back`)), 10_000);
      socket.on("data", (chunk) => {
        total += chunk.length;
        if (total >= payload.length) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.write(payload);
    await done;
    // Upper-casing preserves length, so the round trip must be exact.
    expect(total).toBe(payload.length);
    socket.destroy();
  });

  it("answers 502 when the target refuses the connection", async () => {
    const relay = await startRelay();
    // A port nothing listens on: bind and immediately release it.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { statusLine, socket } = await openTunnel(relay, `127.0.0.1:${deadPort}`);
    expect(statusLine).toContain("502");
    socket.destroy();
  });

  it("answers 400 for a malformed authority", async () => {
    const relay = await startRelay();
    const { statusLine, socket } = await openTunnel(relay, "no-port-here");
    expect(statusLine).toContain("400");
    socket.destroy();
  });

  it("forwards a plain absolute-URI http request", async () => {
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`upstream saw ${request.method} ${request.url}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          upstream.closeAllConnections?.();
          upstream.close(() => resolve());
        }),
    );
    const relay = await startRelay();

    const statusLine = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: relay.port,
          method: "GET",
          // Absolute form, as a proxy client sends it.
          path: `http://127.0.0.1:${upstreamPort}/health?probe=1`,
          headers: { host: `127.0.0.1:${upstreamPort}` },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode + " " + response.statusMessage));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(statusLine).toContain("200");
  });

  it("refuses to forward an http:// absolute URI over https: without CONNECT", async () => {
    const relay = await startRelay();
    // The handler only downgrades if it accepted this; it must refuse instead
    // rather than forward a request the client believed was confidential.
    const statusCode = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(relay.port, "127.0.0.1");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        socket.destroy();
        resolve(Number(buffer.split(" ")[1]));
      });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write("GET https://example.invalid/secret HTTP/1.1\r\nHost: example.invalid\r\n\r\n");
      });
    });
    expect(statusCode).toBe(400);
  });

  it("releases its listening port on dispose", async () => {
    const relay = await createEgressRelay();
    const port = relay.port;
    await relay.dispose();
    // Nothing must still be listening there.
    const refused = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(true));
    });
    expect(refused).toBe(true);
  });
});
