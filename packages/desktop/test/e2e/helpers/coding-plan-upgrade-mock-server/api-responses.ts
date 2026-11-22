import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildCodingPlanWebviewFixtureHtml,
  buildManualClaimStartPlanBalance,
} from "./billing-fixtures.js";
import type { CodingPlanUpgradeMockRequest, CodingPlanUpgradeMockState } from "./contracts.js";

export async function handleRequest(
  state: CodingPlanUpgradeMockState,
  requests: CodingPlanUpgradeMockRequest[],
  request: IncomingMessage,
  response: ServerResponse,
  marketingTouch: boolean,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/__e2e/coding-plan/webview-state") {
    sendJson(response, { pending: state.webviewWaiters.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/webview-mode") {
    const { mode } = await readJsonBody<{ mode: "hold" | "fail" | "ready" }>(request);
    state.webviewMode = mode;
    state.webviewWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/__e2e/coding-plan/requests") {
    sendJson(response, { requests });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/customer-info-hold") {
    const { held } = await readJsonBody<{ held: boolean }>(request);
    state.customerInfoHeld = held;
    if (!held) state.customerInfoWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/inventory-mode") {
    const { mode } = await readJsonBody<{ mode: "hold" | "fail" | "ready" }>(request);
    state.inventoryMode = mode;
    state.inventoryWaiters.splice(0).forEach((release) => release());
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-failure" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.manualClaimShouldFail = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-bucket-ready" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.manualClaimBucketReady = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/manual-claim-next-window" &&
    state.scenario === "manual-claim-experience"
  ) {
    // Bug 原因：下一时段只重置 completed 会让失败用例的一次性开关泄漏到后续成功用例。
    state.manualClaimCompleted = false;
    state.manualClaimShouldFail = false;
    sendJson(response, { ok: true });
    return;
  }

  const recordedRequest = recordRequest(requests, request, url);

  if (
    request.method === "POST" &&
    url.pathname === "/__e2e/coding-plan/start-expired" &&
    state.scenario === "manual-claim-experience"
  ) {
    state.startPlanExpired = true;
    sendJson(response, { ok: true });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/zcode-plan/billing/preview" &&
    state.scenario === "manual-claim-experience"
  ) {
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        server_time: Math.floor(Date.now() / 1_000),
        plans: state.manualClaimCompleted
          ? []
          : [
              {
                plan_id: "weekend-plan-e2e",
                name: "ZCode Weekend Build",
                description: "Deterministic manual claim fixture",
                priority: 100,
                entitlements: [
                  {
                    entitlement_id: "weekend-glm-flash",
                    show_name: "GLM-5.3-Flash",
                    meter: "model_usage",
                    unit_type: "token",
                    capabilities: ["model:glm-5.3-flash"],
                    grant_units: 10_000_000_000,
                    period: "one_time",
                    priority: 10,
                  },
                ],
              },
            ],
      },
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/zcode-plan/billing/claim" &&
    state.scenario === "manual-claim-experience"
  ) {
    if (state.manualClaimShouldFail) {
      state.manualClaimShouldFail = false;
      state.manualClaimCompleted = true;
      sendJson(response, { code: 1003, data: null, msg: "already claimed" });
      return;
    }
    state.manualClaimCompleted = true;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    sendJson(response, {
      code: 0,
      msg: "ok",
      data: {
        server_time: nowSeconds,
        plan: {
          user_plan_id: "user-weekend-plan-e2e",
          plan_id: "weekend-plan-e2e",
          status: "active",
          starts_at: nowSeconds,
          ends_at: nowSeconds + 86_400,
          entitlements: [
            {
              entitlement_id: "weekend-glm-flash",
              show_name: "GLM-5.3-Flash",
              effective_at: nowSeconds + 3_600,
            },
          ],
        },
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/coding-plan") {
    if (state.webviewMode === "hold")
      await new Promise<void>((resolve) => state.webviewWaiters.push(resolve));
    if (state.webviewMode === "fail") {
      response.destroy();
      return;
    }
    sendHtml(response, buildCodingPlanWebviewFixtureHtml(state.scenario));
    return;
  }

  if (request.method === "POST" && url.pathname === "/__e2e/coding-plan/purchase-complete") {
    state.purchaseCompleted = true;
    sendJson(response, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/releases/latest") {
    sendJson(response, {
      code: 0,
      data: { config_version: "coding-plan-upgrade-e2e" },
      config_version: "coding-plan-upgrade-e2e",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/client/configs") {
    sendJson(response, state.clientConfigPayload);
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/zcode-plan/billing/balance" &&
    (state.scenario === "manual-claim-experience" || state.scenario === "webview-refresh-provider")
  ) {
    // Bug 原因：领取 fixture 只 mock 了旧 quota 接口；当前 Start 可用性以
    // billing/balance 为准，缺失时刷新会把刚写入的 Start selectedKey 收敛回 Individual。
    sendJson(
      response,
      state.startPlanExpired
        ? {
            code: 0,
            msg: "ok",
            data: {
              server_time: Math.floor(Date.now() / 1000),
              plans: [],
              balances: [],
            },
          }
        : buildManualClaimStartPlanBalance(
            state.manualClaimCompleted,
            state.manualClaimBucketReady,
          ),
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/biz/pay/batch-preview") {
    if (state.scenario === "personal-system-busy") {
      // 修复原因：系统繁忙是接口整体失败语义，不能伪造成商品售罄。
      // 服务层会把 WAF/HTML 类不可展示响应收敛成 coding_plan_system_busy，再交给 UI 本地化。
      sendJson(response, {
        code: 503,
        msg: "<html>request has been blocked</html>",
        data: null,
      });
      return;
    }
    const personalProducts =
      state.clientConfigPayload.data.configs.codingPlanStaticProducts[
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ] ?? [];
    sendJson(response, {
      code: 200,
      data: {
        isAuthenticated: true,
        isSubscribed: false,
        productList: personalProducts.map((product) => ({
          ...product,
          canPurchase: false,
          soldOut: true,
        })),
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/monitor/usage/quota/limit") {
    if (state.scenario === "webview-refresh-provider") {
      sendJson(response, { code: 200, data: { level: "pro", limits: [] } });
      return;
    }
    if (state.scenario === "manual-claim-experience") {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      sendJson(response, {
        code: 0,
        msg: "ok",
        data: {
          plans: [
            {
              plan_id: "weekend-plan-e2e",
              name: "ZCode Weekend Build",
              status: "active",
              starts_at: nowSeconds,
              ends_at: nowSeconds + 86_400,
              entitlements: [{ meter: "model_usage", period: "one_time" }],
            },
          ],
          balances: [
            {
              plan_id: "weekend-plan-e2e",
              entitlement_id: "weekend-glm-flash",
              show_name: "GLM-5.3-Flash",
              capabilities: ["model:glm-5.3-flash"],
              total_units: 10_000_000_000,
              used_units: 0,
              remaining_units: 10_000_000_000,
              available_units: 10_000_000_000,
              expires_at: nowSeconds + 86_400,
            },
          ],
        },
      });
      return;
    }
    // 修复原因：sidebar 升级入口通过 entitlement 判断账号是已连接但未开通套餐；
    // mock 必须用 HTTP 200 承载业务 no_plan，否则 readApiJson 会提前抛错，
    // 购买面板会被当成不可用账号并跳过 batch-preview。
    sendJson(response, {
      code: 404,
      msg: "当前用户不存在coding plan",
      data: null,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/biz/subscription/list") {
    sendJson(response, {
      code: 200,
      data:
        state.scenario === "webview-refresh-provider" ||
        (state.scenario === "manual-claim-experience" && state.manualClaimCompleted)
          ? [
              {
                productId: "glm-coding-pro-e2e",
                productName: "GLM Coding Pro",
                status: "VALID",
                inCurrentPeriod: true,
              },
            ]
          : [],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/biz/customer/getCustomerInfo") {
    // 将单卡 provider 同步停在网络边界，验证全局查询已完成后的 Subscribe 加载反馈。
    if (state.customerInfoHeld) {
      await new Promise<void>((resolve) => state.customerInfoWaiters.push(resolve));
    }
    sendJson(response, {
      code: 200,
      data:
        state.purchaseCompleted ||
        // 营销升级先查询全部连接的权益；没有项目凭据会停在 unknown，无法打开升级页。
        // 只补可查询项目，不把“尚未领取”伪造成已有订阅。
        marketingTouch ||
        // 无套餐仍需可查询的项目凭据；空项目会让 Account State 变为 unknown，遮蔽订阅入口。
        state.scenario === "personal-sold-out" ||
        state.scenario === "personal-system-busy" ||
        // 当前账号服务通过组织/项目取得凭据；库存场景购买前已经拥有个人套餐，不能只伪造订阅列表。
        state.scenario === "webview-refresh-provider" ||
        (state.scenario === "manual-claim-experience" && state.manualClaimCompleted)
          ? {
              organizations: [
                {
                  organizationId: "org-e2e",
                  projects: [{ projectId: "proj-e2e", projectType: 0 }],
                },
              ],
            }
          : { organizations: [] },
    });
    return;
  }

  if (
    (request.method === "GET" || request.method === "POST") &&
    url.pathname === "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys"
  ) {
    if (request.method === "POST" && recordedRequest) {
      // 仅记录创建用途与名称，不把可能含凭据的任意请求体写入 E2E ledger。
      const { name, usageScene } = await readJsonBody<{
        name?: unknown;
        usageScene?: unknown;
      }>(request);
      recordedRequest.keyCreation = { name, usageScene };
    }
    sendJson(response, {
      code: 200,
      data: !state.purchaseCompleted
        ? request.method === "GET"
          ? [{ name: "zcode", apiKey: "bigmodel-personal-api-key" }]
          : { name: "zcode", apiKey: "bigmodel-personal-api-key" }
        : request.method === "GET"
          ? [{ name: "zcode", apiKey: "bigmodel-webview-refreshed-key" }]
          : { name: "zcode", apiKey: "bigmodel-webview-refreshed-key" },
    });
    return;
  }

  if (
    request.method === "POST" &&
    /^\/api\/biz\/v1\/organization\/org-e2e\/projects\/proj-e2e\/api_keys\/[^/]+\/access_tokens$/.test(
      url.pathname,
    )
  ) {
    const body = await readJsonBody<{ clientType?: string }>(request);
    if (body.clientType !== "zcode" || !request.headers.authorization?.startsWith("Bearer ")) {
      sendJson(response, { code: 400, msg: "invalid_token_request" });
      return;
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: Math.floor(Date.now() / 1000) + 600 })}.e2e-signature`;
    sendJson(response, {
      code: 200,
      data: {
        enable: true,
        accessToken: token,
        tokenType: "Bearer",
        expiresIn: 600,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname ===
      "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-webview-refreshed-key" ||
      url.pathname ===
        "/api/biz/v1/organization/org-e2e/projects/proj-e2e/api_keys/copy/bigmodel-personal-api-key")
  ) {
    sendJson(response, {
      code: 200,
      // Bug 原因：Z.ai 的 resolver 需要 copy secret，但 BigModel 的 apiKey 本身已是
      // 完整凭据。fixture 若无条件返回 Z.ai secret，会把 BigModel key 错拼成 key.secret。
      data: {
        secretKey:
          request.headers.authorization === "Bearer zai-webview-oauth-token"
            ? "zai-webview-refreshed-secret"
            : "",
      },
    });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/api/biz/subscription/enterprise/v2/pricing" ||
      url.pathname === "/api/biz/campaign/partner/enterprise/pricing")
  ) {
    if (url.pathname === "/api/biz/subscription/enterprise/v2/pricing") {
      if (state.inventoryMode === "hold")
        await new Promise<void>((resolve) => state.inventoryWaiters.push(resolve));
      if (state.inventoryMode === "fail") {
        sendJson(response, { code: 503, msg: "inventory unavailable" }, 503);
        return;
      }
    }
    sendJson(response, { code: 200, data: { productList: [] } });
    return;
  }

  sendJson(
    response,
    {
      code: 404,
      msg: `Unhandled E2E mock path: ${request.method} ${url.pathname}`,
    },
    404,
  );
}

export function recordRequest(
  requests: CodingPlanUpgradeMockRequest[],
  request: IncomingMessage,
  url: URL,
) {
  if (url.pathname === "/__e2e/coding-plan/requests") {
    return;
  }
  const recorded: CodingPlanUpgradeMockRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(
      Object.entries(request.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return [[key, value.join(",")]];
        return typeof value === "string" ? [[key, value]] : [];
      }),
    ),
  };
  requests.push(recorded);
  return recorded;
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

export function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

export function sendJson(response: ServerResponse, payload: unknown, statusCode = 200) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}
