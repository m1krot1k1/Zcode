import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { requestSecurityClientConfig } from "../request-security-edition/index.js";
import type {
  CodingPlanClientConfigFixture,
  CodingPlanUpgradeMockScenario,
  CodingPlanUpgradeMockState,
} from "./contracts.js";

export function createCodingPlanUpgradeMockState(
  basePayload: CodingPlanClientConfigFixture,
  scenario: CodingPlanUpgradeMockScenario,
): CodingPlanUpgradeMockState {
  const clientConfigPayload = structuredClone(basePayload);
  enrichClientConfigPayloadForUpgradeE2E(clientConfigPayload, scenario);
  return {
    clientConfigPayload,
    manualClaimBucketReady: false,
    manualClaimCompleted: false,
    manualClaimShouldFail: false,
    startPlanExpired: false,
    customerInfoHeld: false,
    customerInfoWaiters: [],
    inventoryMode: "ready",
    webviewMode: "ready",
    webviewWaiters: [],
    inventoryWaiters: [],
    purchaseCompleted: false,
    scenario,
  };
}

export function buildManualClaimStartPlanBalance(claimed: boolean, newBucketReady: boolean) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const oldPlanId = "zcode-v3-start-plan";
  const newPlanId = "weekend-plan-e2e";
  const oldPlan = {
    ends_at: nowSeconds + 4 * 86_400,
    entitlements: [
      {
        effective_at: 0,
        entitlement_id: "start-glm-turbo-e2e",
        show_name: "GLM-5-Turbo",
      },
    ],
    name: "ZCode V3 Start Plan",
    plan_id: oldPlanId,
    starts_at: nowSeconds - 86_400,
    status: "active",
  };
  const oldBalance = {
    available_units: 1_000_000_000,
    capabilities: ["model:glm-5-turbo"],
    entitlement_id: "start-glm-turbo-e2e",
    expires_at: nowSeconds + 4 * 86_400,
    plan_id: oldPlanId,
    remaining_units: 500_000_000,
    show_name: "GLM-5-Turbo",
    total_units: 1_000_000_000,
    used_units: 500_000_000,
  };
  const newPlan = {
    ends_at: nowSeconds + 86_400,
    entitlements: [
      {
        // 已到达排期时间但额度桶尚未生成，驱动设置页显示「刷新权益」。
        effective_at: nowSeconds - 60,
        entitlement_id: "weekend-glm-flash",
        show_name: "GLM-5.3-Flash",
      },
    ],
    name: "ZCode Weekend Build",
    plan_id: newPlanId,
    starts_at: nowSeconds - 60,
    status: "active",
  };
  const newBalance = {
    available_units: 10_000_000_000,
    capabilities: ["model:glm-5.3-flash"],
    entitlement_id: "weekend-glm-flash",
    expires_at: nowSeconds + 86_400,
    plan_id: newPlanId,
    remaining_units: 10_000_000_000,
    show_name: "GLM-5.3-Flash",
    total_units: 10_000_000_000,
    used_units: 0,
  };
  return {
    code: 0,
    data: {
      server_time: nowSeconds,
      balances: [oldBalance, ...(claimed && newBucketReady ? [newBalance] : [])],
      plans: [oldPlan, ...(claimed ? [newPlan] : [])],
    },
    msg: "ok",
    success: true,
  };
}

export function enrichClientConfigPayloadForUpgradeE2E(
  payload: CodingPlanClientConfigFixture,
  scenario: CodingPlanUpgradeMockScenario,
) {
  if (scenario === "manual-claim-experience") {
    // Bug 原因：领取 fixture 需要同时下发 Individual 与 Start；且 BigModel OAuth
    // resolver 会从同 family 的远端列表选择首个 Anthropic provider，Individual 必须排在前面，
    // 否则会把 Start 模型错误复用到 Individual，无法覆盖真实切换链路。
    payload.data.builtinProviders = [
      {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        name: "BigModel - Coding Plan",
        schema: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: ["GLM-5.3-Flash"],
      },
      {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        name: "BigModel - Start Plan",
        schema: "anthropic",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        models: ["GLM-5.3-Flash", "GLM-5-Turbo"],
      },
    ];
    payload.data.builtinModels = [
      {
        modelId: "GLM-5-Turbo",
        name: "GLM-5-Turbo",
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        priority: 101,
      },
      {
        modelId: "GLM-5.3-Flash",
        name: "GLM-5.3-Flash",
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        priority: 100,
      },
    ];
    Object.assign(payload.data.configs, requestSecurityClientConfig());
    return;
  }
  if (scenario !== "webview-refresh-provider") {
    return;
  }
  payload.data.builtinProviders = [
    {
      id: "bigmodel",
      name: "BigModel - Coding Plan",
      schema: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      models: ["glm-5.1-highspeed"],
    },
    {
      id: "zai",
      name: "Z.ai - Coding Plan",
      schema: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic",
      models: ["glm-5.1-highspeed"],
    },
  ];
}

export function buildCodingPlanWebviewFixtureHtml(scenario: CodingPlanUpgradeMockScenario): string {
  const label =
    scenario === "personal-system-busy"
      ? "System busy"
      : scenario === "personal-sold-out"
        ? "Sold out"
        : "Complete purchase";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Coding Plan E2E</title>
  </head>
  <body>
    <main data-testid="coding-plan-webview-fixture">
      <h1>Coding Plan E2E</h1>
      <button id="complete" type="button">${label}</button>
    </main>
    <script>
      document.getElementById("complete").addEventListener("click", async () => {
        await fetch("/__e2e/coding-plan/purchase-complete", {
          method: "POST",
          keepalive: true
        });
        window.zcodeBridge.notifyPurchaseComplete({
          provider: "bigmodel",
          timestamp: Date.now()
        });
      });
    </script>
  </body>
</html>`;
}
