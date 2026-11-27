import { describe, expect, it } from "vitest";
import { buildAgentProxyEnv, buildAgentRuntimeEnv } from "../src/runtime-tools/agentProxyEnv.js";

/**
 * The fallback flag is what keeps a remote workspace that already has internet
 * off the desktop tunnel. It cannot ride along in the environment — the runtime
 * scrub removes it — so the spawn patch has to re-emit it from the typed value.
 * Without these two cases the relay would silently become a forced proxy.
 */
describe("buildAgentProxyEnv", () => {
  it("re-emits the fallback flag when the network is fallback-only", () => {
    const env = buildAgentProxyEnv("http://127.0.0.1:41234", true);
    expect(env.ZCODE_HTTP_PROXY).toBe("http://127.0.0.1:41234");
    expect(env.ZCODE_HTTP_PROXY_FALLBACK_ONLY).toBe("1");
  });

  it("omits the flag for an ordinary operator-chosen proxy", () => {
    const env = buildAgentProxyEnv("http://127.0.0.1:41234");
    expect(env.ZCODE_HTTP_PROXY).toBe("http://127.0.0.1:41234");
    expect(env.ZCODE_HTTP_PROXY_FALLBACK_ONLY).toBeUndefined();
  });

  it("emits nothing without a proxy, so a stray flag cannot mark a direct host", () => {
    expect(buildAgentProxyEnv(undefined, true)).toEqual({});
  });
});

describe("buildAgentRuntimeEnv", () => {
  it("carries fallbackOnly through to the spawn patch", () => {
    const env = buildAgentRuntimeEnv({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: "localhost",
      fallbackOnly: true,
    });
    expect(env.ZCODE_HTTP_PROXY_FALLBACK_ONLY).toBe("1");
    expect(env.ZCODE_HTTP_PROXY).toBe("http://127.0.0.1:41234");
  });

  it("keeps an explicit proxy first-choice when the flag is absent", () => {
    const env = buildAgentRuntimeEnv({ httpProxy: "http://10.0.0.5:3128" });
    expect(env.ZCODE_HTTP_PROXY_FALLBACK_ONLY).toBeUndefined();
  });
});
