import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createMarketingTouchFixture } from "../marketing-touch-fixture.js";
import { rewardsWebsiteFixture } from "../rewards-website-fixture.js";
import { formatErrorMessage, handleRequest, readJsonBody, sendJson } from "./api-responses.js";
import { createCodingPlanUpgradeMockState } from "./billing-fixtures.js";
import {
  isCodingPlanUpgradeMockScenario,
  type CodingPlanClientConfigFixture,
  type CodingPlanUpgradeMockRequest,
  type CodingPlanUpgradeMockScenario,
  type CodingPlanUpgradeMockServer,
} from "./contracts.js";

export async function resetCodingPlanUpgradeMockServer(
  baseUrl: string,
  scenario: CodingPlanUpgradeMockScenario,
  options: { marketingTouch?: boolean } = {},
): Promise<void> {
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/reset`, {
    body: JSON.stringify({ scenario, marketingTouch: options.marketingTouch === true }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Coding Plan E2E mock reset failed: ${response.status} ${await response.text()}`,
    );
  }
}

export async function startCodingPlanUpgradeMockServer(
  scenario: CodingPlanUpgradeMockScenario,
  options: { marketingTouch?: boolean } = {},
): Promise<CodingPlanUpgradeMockServer> {
  // 修复原因：pnpm filter 会把 E2E cwd 切到 packages/desktop，不能用 cwd 定位仓库级 fixture。
  const clientConfigFixtureUrl = new URL(
    "../../fixtures/coding-plan-client-configs.json",
    import.meta.url,
  );
  const baseClientConfigPayload = JSON.parse(
    await readFile(clientConfigFixtureUrl, "utf8"),
  ) as CodingPlanClientConfigFixture;
  const requests: CodingPlanUpgradeMockRequest[] = [];
  const state = createCodingPlanUpgradeMockState(baseClientConfigPayload, scenario);
  // 同套餐场景也供旧测试复用，不能隐式注入需要 release 的营销领取暂停。
  let marketing = options.marketingTouch ? await createMarketingTouchFixture() : null;
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && pathname === "/__e2e/coding-plan/reset") {
        const payload = await readJsonBody<{ scenario?: unknown; marketingTouch?: boolean }>(
          request,
        );
        if (!isCodingPlanUpgradeMockScenario(payload.scenario)) {
          sendJson(response, { code: 400, msg: "Invalid Coding Plan E2E scenario" }, 400);
          return;
        }
        // 混合 suite 复用构建时的 origin；营销开关和投放也必须按 worker 重置，否则弹窗会遮挡购买入口。
        const nextMarketing = payload.marketingTouch ? await createMarketingTouchFixture() : null;
        marketing?.stop();
        marketing = nextMarketing;
        state.webviewWaiters.splice(0).forEach((release) => release());
        state.customerInfoWaiters.splice(0).forEach((release) => release());
        state.inventoryWaiters.splice(0).forEach((release) => release());
        Object.assign(
          state,
          createCodingPlanUpgradeMockState(baseClientConfigPayload, payload.scenario),
        );
        requests.splice(0, requests.length);
        sendJson(response, { ok: true, scenario: state.scenario });
        return;
      }
      if (marketing && /^\/(cn|en)\/rewards$/.test(pathname)) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(rewardsWebsiteFixture);
        return;
      }
      if (await marketing?.handle(request, response)) return;
      if (!marketing && pathname === "/api/v1/marketing/touch") {
        sendJson(response, {
          code: 0,
          data: {
            server_time: Math.floor(Date.now() / 1000),
            language: request.headers["x-client-language"] === "zh-CN" ? "zh-CN" : "en-US",
            deliveries: [],
          },
        });
        return;
      }
      await handleRequest(state, requests, request, response, marketing !== null);
    })().catch((error) => {
      if (!response.headersSent) {
        sendJson(response, { code: 500, msg: formatErrorMessage(error) }, 500);
        return;
      }
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Coding Plan E2E mock server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get scenario() {
      return state.scenario;
    },
    stop: async () => {
      marketing?.stop();
      state.webviewWaiters.splice(0).forEach((release) => release());
      state.customerInfoWaiters.splice(0).forEach((release) => release());
      state.inventoryWaiters.splice(0).forEach((release) => release());
      server.close();
      await once(server, "close");
    },
  };
}
