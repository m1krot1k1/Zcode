import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeHttpClientAdapter } from "../src/http/index.js";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";

// 上游状态码不在 WHATWG `Response` 能表示的范围里时（docs/design/v2/model/http-proxy.md「行为」）。
//
// 回归（2026-09-29 实测）：子代理 WebFetch 一个 LinkedIn 个人页，LinkedIn 对爬虫回 999；adapter 在
// `http.request` 回调里 `new Response(stream, { status: 999 })`，构造函数抛 RangeError，没人接得住，
// agent 进程以 uncaughtException 退出，整个工作区的会话和 run 一起断了。204 / 304 带着流去构造也一样抛。
//
// 只有 adapter 自己发请求（这里是走代理）才经过这条路径；原生 fetch 本来就能带回 999。
// 这里的「代理」直接给出答复，不再转发：状态码是它说了算。

const BODY = "blocked";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("HttpClientPort through a proxy", () => {
  it("returns a nonstandard status such as 999 as an ordinary response", async () => {
    const proxy = await answeringProxy(999);
    const adapter = createNodeHttpClientAdapter({ env: { ZCODE_HTTP_PROXY: proxy } });

    const response = await adapter.request({ url: "http://profiles.example/in/someone" });

    expect(response.status).toBe(999);
    expect(new TextDecoder().decode(response.body)).toBe(BODY);
  });

  it.each([204, 304])("returns %i with an empty body", async (status) => {
    const proxy = await answeringProxy(status);
    const adapter = createNodeHttpClientAdapter({ env: { ZCODE_HTTP_PROXY: proxy } });

    const response = await adapter.request({ url: "http://profiles.example/in/someone" });

    expect(response.status).toBe(status);
    expect(response.bytes).toBe(0);
  });
});

describe("proxy-aware fetch", () => {
  it.each([204, 304])("resolves %i as a Response with no body", async (status) => {
    const proxyFetch = createNetworkProxyFetch({ httpProxy: await answeringProxy(status) });

    const response = await proxyFetch("http://api.example/v1/ping");

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it("retries HTTP 429 through the next proxy and then stays there", async () => {
    const hits = { first: 0, second: 0 };
    const bodies: string[] = [];
    const first = await countingProxy(429, () => {
      hits.first += 1;
    });
    const second = await countingProxy(200, (body) => {
      hits.second += 1;
      bodies.push(body);
    });
    const proxyFetch = createNetworkProxyFetch({
      httpProxy: first,
      httpProxyList: [first, second],
    });

    const response = await proxyFetch("http://api.example/v1/messages", {
      method: "POST",
      body: "same-body",
    });
    const again = await proxyFetch("http://api.example/v1/messages", {
      method: "POST",
      body: "same-body",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(again.status).toBe(200);
    expect(hits).toEqual({ first: 1, second: 2 });
    expect(bodies).toEqual(["same-body", "same-body"]);
  });

  it("wraps from the last rate-limited proxy back to the first on the next request", async () => {
    const hits = { first: 0, second: 0 };
    const first = await countingProxy(429, () => {
      hits.first += 1;
    });
    const second = await countingProxy(429, () => {
      hits.second += 1;
    });
    const proxyFetch = createNetworkProxyFetch({ httpProxyList: [first, second] });

    expect((await proxyFetch("http://api.example/v1/messages")).status).toBe(429);
    expect(hits).toEqual({ first: 1, second: 1 });
    expect((await proxyFetch("http://api.example/v1/messages")).status).toBe(429);
    expect(hits).toEqual({ first: 2, second: 2 });
  });

  it("does not rotate a single proxy or a non-429 server response", async () => {
    let limited = 0;
    let refused = 0;
    let serverErrors = 0;
    let healthy = 0;
    const only = await countingProxy(429, () => {
      limited += 1;
    });
    const down = await refusingProxy(() => {
      refused += 1;
    });
    const unhealthy = await countingProxy(500, () => {
      serverErrors += 1;
    });
    const good = await countingProxy(200, () => {
      healthy += 1;
    });

    const single = createNetworkProxyFetch({ httpProxy: only });
    expect((await single("http://api.example/v1/messages")).status).toBe(429);
    expect(limited).toBe(1);

    // 入口拒绝隧道 → 不是模型错误：кольцо уходит на следующий прокси (NPS-11).
    const ring = createNetworkProxyFetch({ httpProxyList: [down, good] });
    expect((await ring("http://api.example/v1/messages")).status).toBe(200);
    expect(refused).toBe(1);
    expect(healthy).toBe(1);

    // А вот НЕ-429 ответ сервера ротацию не крутит: 500 отдаётся как есть (NPS-13).
    const serverError = createNetworkProxyFetch({ httpProxyList: [unhealthy, good] });
    expect((await serverError("http://api.example/v1/messages")).status).toBe(500);
    expect(serverErrors).toBe(1);
    expect(healthy).toBe(1);
  });

  it("fails only this request when the status cannot be a Response", async () => {
    const proxyFetch = createNetworkProxyFetch({ httpProxy: await answeringProxy(999) });

    await expect(proxyFetch("http://api.example/v1/ping")).rejects.toMatchObject({
      code: "ZCODE_UNSUPPORTED_HTTP_STATUS",
      name: "TypeError",
      status: 999,
    });
    // 同一个 fetch 之后照常可用：失败的只是那一次请求。
    const next = createNetworkProxyFetch({ httpProxy: await answeringProxy(200) });
    expect((await next("http://api.example/v1/ping")).status).toBe(200);
  });
});

/** 一个直接答复的「代理」：每个请求都回 `status`，允许正文的状态带上 {@link BODY}。 */
async function answeringProxy(status: number): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { "content-type": "text/plain" });
    response.end(status === 204 || status === 304 ? undefined : BODY);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function countingProxy(
  status: number,
  onHit: (body: string) => void,
): Promise<string> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      onHit(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(status === 200 ? "ok" : "rate-limited");
    });
  });
  servers.push(server);
  await listen(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function refusingProxy(onHit: () => void): Promise<string> {
  const server = http.createServer((request) => {
    onHit();
    request.socket.destroy();
  });
  servers.push(server);
  await listen(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
