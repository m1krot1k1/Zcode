import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ServiceCollection } from "@zcode/services";
import {
  buildLiteTokenSetCookie,
  createHttpServer,
  isLiteTokenCookieSecure,
  resolveTrustProxyFromEnv,
} from "../src/http.js";

async function waitForListening(server: Server): Promise<AddressInfo> {
  if (!server.listening) await once(server, "listening");
  return server.address() as AddressInfo;
}

describe("lite-token cookie attributes (QW13)", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  async function startServer(overrides: { trustProxy?: boolean } = {}) {
    const server = createHttpServer(new ServiceCollection(), 0, {
      authToken: "secret-token",
      ...overrides,
    });
    servers.push(server);
    const address = await waitForListening(server);
    return { server, baseUrl: `http://127.0.0.1:${address.port}`, port: address.port };
  }

  it("always sets explicit expiry and hardened attributes while keeping the cookie name", () => {
    const cookie = buildLiteTokenSetCookie("secret-token", { secure: false });
    expect(cookie).toBe(
      "zcode_lite_token=secret-token; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax",
    );
    expect(cookie).not.toContain("Secure");
    // 保留现有 cookie 名称：改名会让已持有 cookie 的客户端必须重新用 ?token= 认证。
    expect(cookie.startsWith("zcode_lite_token=")).toBe(true);
  });

  it("adds Secure only for a real TLS socket or an explicitly trusted proxy https hop", () => {
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: true,
        trustProxy: false,
        forwardedProto: undefined,
      }),
    ).toBe(true);
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: false,
        forwardedProto: undefined,
      }),
    ).toBe(false);
    // 伪造的代理头默认被忽略。
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: false,
        forwardedProto: "https",
      }),
    ).toBe(false);
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: true,
        forwardedProto: "https",
      }),
    ).toBe(true);
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: true,
        forwardedProto: "http",
      }),
    ).toBe(false);
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: true,
        forwardedProto: undefined,
      }),
    ).toBe(false);
    // 多值代理链取最后一个 hop：最左侧可被客户端伪造，最近的可信代理值才可信。
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: true,
        forwardedProto: "http, https",
      }),
    ).toBe(true);
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: true,
        forwardedProto: "https, http",
      }),
    ).toBe(false);
    expect(
      isLiteTokenCookieSecure({
        socketEncrypted: false,
        trustProxy: true,
        forwardedProto: "  HTTPS  ",
      }),
    ).toBe(true);
  });

  it("parses the trusted-proxy env switch only for explicit truthy values", () => {
    expect(resolveTrustProxyFromEnv({ ZCODE_SERVER_TRUST_PROXY: "1" })).toBe(true);
    expect(resolveTrustProxyFromEnv({ ZCODE_SERVER_TRUST_PROXY: "TRUE" })).toBe(true);
    expect(resolveTrustProxyFromEnv({ ZCODE_SERVER_TRUST_PROXY: " yes " })).toBe(true);
    expect(resolveTrustProxyFromEnv({ ZCODE_SERVER_TRUST_PROXY: "0" })).toBe(false);
    expect(resolveTrustProxyFromEnv({ ZCODE_SERVER_TRUST_PROXY: "on" })).toBe(false);
    expect(resolveTrustProxyFromEnv({ ZCODE_SERVER_TRUST_PROXY: "https" })).toBe(false);
    expect(resolveTrustProxyFromEnv({})).toBe(false);
  });

  it("keeps plain HTTP working with a non-Secure cookie and full attributes", async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/api/server-info?token=secret-token`, {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("zcode_lite_token=secret-token");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    // trustProxy 默认关闭：plain HTTP 上的 X-Forwarded-Proto 不能被信任。
    expect(setCookie).not.toContain("Secure");

    const cookieAccepted = await fetch(`${baseUrl}/api/server-info`, {
      headers: { cookie: "zcode_lite_token=secret-token" },
    });
    expect(cookieAccepted.status).toBe(200);
  });

  it("honors X-Forwarded-Proto only when trustProxy is enabled", async () => {
    const { baseUrl } = await startServer({ trustProxy: true });

    const trusted = await fetch(`${baseUrl}/api/server-info?token=secret-token`, {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get("set-cookie")).toContain("Secure");

    const plainForwarded = await fetch(`${baseUrl}/api/server-info?token=secret-token`, {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(plainForwarded.headers.get("set-cookie") ?? "").not.toContain("Secure");
  });

  it("does not treat an absolute-form https request target as TLS", async () => {
    const { port } = await startServer();

    const result = await new Promise<{ status: number; setCookie: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          // absolute-form target 让 Hono 的 URL 变成 https://...，但 socket 仍是明文。
          path: `https://127.0.0.1:${port}/api/server-info?token=secret-token`,
          headers: { host: `127.0.0.1:${port}` },
        },
        (res) => {
          const setCookie = res.headers["set-cookie"]?.[0] ?? "";
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, setCookie }));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(result.status).toBe(200);
    expect(result.setCookie).toContain("zcode_lite_token=secret-token");
    expect(result.setCookie).not.toContain("Secure");
  });

  it("keeps rejecting bad tokens without setting a cookie", async () => {
    const { baseUrl } = await startServer({ trustProxy: true });

    const rejected = await fetch(`${baseUrl}/api/server-info?token=wrong-token`, {
      headers: { "x-forwarded-proto": "https" },
    });

    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();
  });
});
