import { describe, expect, it } from "vitest";
import {
  PROXY_UNAVAILABLE_HEALTH_TTL_MS,
  commitConfiguredProxyCursor,
  createNetworkProxyFetch,
  formatProxyFallbackWarning,
  type NetworkProxyTransport,
  type ProxyFallbackNotice,
} from "../src/network/proxy-fetch.js";

// 回退：койльцо прокси при отказе туннеля уходит на следующий вход, а когда мёртвы все — напрямую
// (docs/specs/network-proxy-settings.md, NPS-11…NPS-14). Реальную сеть в этих тестах не трогаем:
// транспорт кольца инжектируется, DNS и сокеты не участвуют.

const TARGET = "https://api.test/v1/messages";

interface Ring {
  endpointA: string;
  endpointB: string;
  hostA: string;
  hostB: string;
}

/** Уникальные входы на тест: смена списка сбрасывает процессный health-кэш и курсор кольца. */
function ring(prefix: string): Ring {
  const endpointA = `http://user:secret@proxy-${prefix}-a.test:3128`;
  const endpointB = `http://proxy-${prefix}-b.test:8080`;
  return { endpointA, endpointB, hostA: hostOf(endpointA), hostB: hostOf(endpointB) };
}

function hostOf(proxyUrl: string): string {
  return new URL(proxyUrl).host;
}

interface TransportCall {
  body?: string;
  proxy?: string;
}

/** Инжектируемый транспорт: записывает вход и тело, отдаёт заготовленный ответ или ошибку. */
function recordingTransport(behavior: (call: TransportCall) => Response | Error): {
  calls: TransportCall[];
  transport: NetworkProxyTransport;
} {
  const calls: TransportCall[] = [];
  const transport: NetworkProxyTransport = async (request, options) => {
    const call: TransportCall = {
      body: request.body?.toString("utf8"),
      proxy: options.proxyUrl ? hostOf(options.proxyUrl) : undefined,
    };
    calls.push(call);
    const outcome = behavior(call);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { calls, transport };
}

function tunnelRefused(): Error & { code: string } {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
    code: "ECONNREFUSED",
  });
}

function ok(body: string): Response {
  return new Response(body, { status: 200 });
}

describe("proxy ring fallback", () => {
  it("falls back to the next proxy when the first one refuses the tunnel", async () => {
    const { endpointA, endpointB, hostA, hostB } = ring("next");
    const { calls, transport } = recordingTransport((call) =>
      call.proxy === hostA ? tunnelRefused() : ok("second-proxy"),
    );
    const notices: ProxyFallbackNotice[] = [];
    const proxyFetch = createNetworkProxyFetch({
      httpProxyList: [endpointA, endpointB],
      onProxyFallback: (notice) => notices.push(notice),
      transport,
    });

    const response = await proxyFetch(TARGET, { body: "payload", method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("second-proxy");
    expect(calls.map((call) => call.proxy)).toEqual([hostA, hostB]);
    // Тело POST повторяется на следующем входе без потери.
    expect(calls.map((call) => call.body)).toEqual(["payload", "payload"]);
    expect(notices).toEqual([{ code: "ECONNREFUSED", direct: false, proxy: hostA }]);
    expect(JSON.stringify(notices)).not.toContain("secret");
  });

  it("goes direct and succeeds when every proxy refuses the tunnel", async () => {
    const { endpointA, endpointB, hostA, hostB } = ring("direct");
    const { calls, transport } = recordingTransport((call) =>
      call.proxy === undefined ? ok("direct-ok") : tunnelRefused(),
    );
    const notices: ProxyFallbackNotice[] = [];
    const proxyFetch = createNetworkProxyFetch({
      httpProxyList: [endpointA, endpointB],
      onProxyFallback: (notice) => notices.push(notice),
      transport,
    });

    const response = await proxyFetch(TARGET);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("direct-ok");
    expect(calls.map((call) => call.proxy)).toEqual([hostA, hostB, undefined]);
    expect(notices).toEqual([
      { code: "ECONNREFUSED", direct: true, proxy: hostA },
      { code: "ECONNREFUSED", direct: true, proxy: hostB },
    ]);
  });

  it("surfaces the direct connection error without proxy credentials when every proxy is dead", async () => {
    const { endpointA, endpointB, hostA, hostB } = ring("dead");
    const { calls, transport } = recordingTransport((call) => {
      if (call.proxy !== undefined) return tunnelRefused();
      // 直连失败：это ошибка модели, не прокси.
      return Object.assign(new Error("getaddrinfo ENOTFOUND api.test"), {
        code: "ENOTFOUND",
      });
    });
    const notices: ProxyFallbackNotice[] = [];
    const proxyFetch = createNetworkProxyFetch({
      httpProxyList: [endpointA, endpointB],
      onProxyFallback: (notice) => notices.push(notice),
      transport,
    });

    const error: unknown = await proxyFetch(TARGET).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toMatchObject({ code: "ENOTFOUND" });
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toMatch(/proxy/iu);
    expect(message).not.toContain("secret");
    expect(calls.map((call) => call.proxy)).toEqual([hostA, hostB, undefined]);
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice.direct).toBe(true);
      expect(notice.proxy).not.toContain("secret");
      expect(notice.proxy).not.toContain("@");
    }
  });

  it("keeps rotating on HTTP 429", async () => {
    const { endpointA, endpointB, hostA, hostB } = ring("rate");
    const { calls, transport } = recordingTransport((call) =>
      call.proxy === hostA
        ? new Response("rate-limited", { status: 429 })
        : ok("second-proxy"),
    );
    const notices: ProxyFallbackNotice[] = [];
    const proxyFetch = createNetworkProxyFetch({
      httpProxyList: [endpointA, endpointB],
      onProxyFallback: (notice) => notices.push(notice),
      transport,
    });

    const response = await proxyFetch(TARGET);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("second-proxy");
    expect(calls.map((call) => call.proxy)).toEqual([hostA, hostB]);
    // 429 — не признак мёртвого входа: варнинга фоллбека нет.
    expect(notices).toEqual([]);
  });

  it("skips a proxy marked dead for 60 seconds", async () => {
    const { endpointA, endpointB, hostA, hostB } = ring("cache");
    let phase = 1;
    const { calls, transport } = recordingTransport((call) => {
      if (call.proxy === hostA) return tunnelRefused();
      if (call.proxy === hostB && phase === 2) return tunnelRefused();
      return ok("ok");
    });

    const first = createNetworkProxyFetch({ httpProxyList: [endpointA, endpointB], transport });
    expect((await first(TARGET)).status).toBe(200);
    expect(calls.map((call) => call.proxy)).toEqual([hostA, hostB]);

    // Возвращаем кольцо на мёртвый вход: health-кэш всё равно не даёт к нему подключиться.
    commitConfiguredProxyCursor([endpointA, endpointB], endpointA);
    calls.length = 0;
    phase = 2;
    const notices: ProxyFallbackNotice[] = [];
    const again = createNetworkProxyFetch({
      httpProxyList: [endpointA, endpointB],
      onProxyFallback: (notice) => notices.push(notice),
      transport,
    });

    expect((await again(TARGET)).status).toBe(200);
    expect(calls.map((call) => call.proxy)).toEqual([hostB, undefined]);
    expect(notices.map((notice) => [notice.proxy, notice.code])).toEqual([
      [hostA, "cached"],
      [hostB, "ECONNREFUSED"],
    ]);
    expect(PROXY_UNAVAILABLE_HEALTH_TTL_MS).toBe(60_000);
  });

  it("formats the fallback warning with host:port only", () => {
    const next = formatProxyFallbackWarning({
      code: "ECONNREFUSED",
      direct: false,
      proxy: "proxy-a.test:3128",
    });
    expect(next).toContain("proxy-a.test:3128");
    expect(next).not.toMatch(/secret|@|http:\/\//iu);

    const direct = formatProxyFallbackWarning({
      code: "cached",
      direct: true,
      proxy: "proxy-b.test:8080",
    });
    expect(direct).toContain("proxy-b.test:8080");
    expect(direct).toContain("direct connection");
    expect(direct).not.toContain("secret");
  });

  it("returns a non-429 status without rotating", async () => {
    const { endpointA, endpointB, hostA } = ring("status");
    const { calls, transport } = recordingTransport((call) =>
      call.proxy === hostA
        ? new Response("server-error", { status: 500 })
        : ok("second-proxy"),
    );
    const notices: ProxyFallbackNotice[] = [];
    const proxyFetch = createNetworkProxyFetch({
      httpProxyList: [endpointA, endpointB],
      onProxyFallback: (notice) => notices.push(notice),
      transport,
    });

    const response = await proxyFetch(TARGET);

    // Ответ сервера возвращается как есть: 500 не означает «прокси мёртв».
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("server-error");
    expect(calls.map((call) => call.proxy)).toEqual([hostA]);
    expect(notices).toEqual([]);
  });
});
