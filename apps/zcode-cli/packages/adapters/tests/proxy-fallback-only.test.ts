import { describe, expect, it } from "vitest";
import { createNetworkProxyFetch, type ProxyFallbackNotice } from "../src/network/proxy-fetch.js";

/**
 * Fallback-only mode is what an isolated remote workspace borrows: the device
 * relay must never become a forced proxy, because a host that already has
 * internet would then depend on the desktop staying awake.
 *
 * Direct traffic goes through `fetch`; proxied traffic through `transport`.
 */

const TARGET = "https://api.example.test/v1/chat";
const RELAY = "http://127.0.0.1:41234";

interface Harness {
  directCalls: number;
  proxied: Array<string | undefined>;
  fetch: typeof fetch;
  transport: never;
}

function harness(respond: (relayUsed: boolean) => Response | Promise<Response>): Harness {
  const state: Harness = {
    directCalls: 0,
    proxied: [],
    fetch: (async () => {
      state.directCalls += 1;
      return await respond(false);
    }) as unknown as typeof fetch,
    transport: (async (_request: unknown, options: { proxyUrl?: string }) => {
      state.proxied.push(options.proxyUrl);
      return await respond(true);
    }) as never,
  };
  return state;
}

function networkFailure(): Error {
  return Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
    code: "ENOTFOUND",
  });
}

function ok(body: string): Response {
  return new Response(body, { status: 200 });
}

describe("fallback-only proxy", () => {
  it("goes direct first and reaches the relay only after a network failure", async () => {
    const h = harness((relayUsed) =>
      relayUsed ? ok("via-relay") : Promise.reject(networkFailure()),
    );
    const notices: ProxyFallbackNotice[] = [];
    const proxyFetch = createNetworkProxyFetch({
      fallbackProxy: RELAY,
      fetch: h.fetch,
      onProxyFallback: (notice) => notices.push(notice),
      transport: h.transport,
    });

    const response = await proxyFetch(TARGET);

    expect(await response.text()).toBe("via-relay");
    expect(h.directCalls).toBe(1);
    expect(h.proxied).toEqual([RELAY]);
  });

  it("never touches the relay when the direct request succeeds", async () => {
    const h = harness(() => ok("direct"));
    const proxyFetch = createNetworkProxyFetch({
      fallbackProxy: RELAY,
      fetch: h.fetch,
      transport: h.transport,
    });

    const response = await proxyFetch(TARGET);

    expect(await response.text()).toBe("direct");
    // A host with working egress must not pay for the tunnel at all.
    expect(h.directCalls).toBe(1);
    expect(h.proxied).toEqual([]);
  });

  it("propagates a non-network error instead of retrying through the relay", async () => {
    const h = harness(() => {
      throw Object.assign(new Error("schema rejected"), { code: "ERR_BAD_REQUEST" });
    });
    const proxyFetch = createNetworkProxyFetch({
      fallbackProxy: RELAY,
      fetch: h.fetch,
      transport: h.transport,
    });

    await expect(proxyFetch(TARGET)).rejects.toThrow("schema rejected");
    // No second attempt: a schema refusal is not a transport problem.
    expect(h.directCalls).toBe(1);
    expect(h.proxied).toEqual([]);
  });

  it("keeps an explicit operator proxy first-choice when both are present", async () => {
    const h = harness(() => ok("explicit"));
    const proxyFetch = createNetworkProxyFetch({
      httpProxy: "http://10.0.0.5:3128",
      fallbackProxy: RELAY,
      fetch: h.fetch,
      transport: h.transport,
    });

    await proxyFetch(TARGET);

    // A configured proxy is used first; the direct leg is not taken.
    expect(h.directCalls).toBe(0);
    expect(h.proxied[0]).toBe("http://10.0.0.5:3128/");
  });
});
