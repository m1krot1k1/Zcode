import { createConversationShareMockRoute } from "../helpers/conversation-share-mock-route.js";
import {
  type EntitlementPresentation,
  presentationResponse,
} from "../fixtures/entitlement-presentation.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildProviderResponsiveStartBalance } from "../fixtures/provider-family-responsive.js";
import {
  shouldPrepareCodingPlanTeamMock,
  CODING_PLAN_TEAM_MOCK_BASE_URL_ENV,
  applyCodingPlanTeamMockEnv,
  clearCodingPlanTeamMockEnv,
} from "../helpers/coding-plan-mock-env.js";
import { workerSpecsContain } from "../helpers/e2e-worker-isolation.js";
import {
  MODEL_PROVIDER_CATALOG_PAYLOAD,
  resolveSubagentLoginCatalogConfigVersion,
  resolveSubagentLoginCatalogPayload,
} from "../helpers/model-provider-catalog-mock-server.js";
import { handleCodingPlanTeamAccountRoutes } from "./mocks-coding-plan-team-account-routes.js";
import { readRequestJson, writeJson } from "./http-utils.js";
import { isSubagentCodingPlanLoginCatalogStaleSpec } from "./seeding-spec-fixtures.js";
import { isModelProviderPlanSurfaceSpec } from "./seeding-subagents.js";
import {
  SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE,
  SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID,
  SUBAGENT_CODING_PLAN_OAUTH_STATE,
} from "./specs.js";
import { wdioState } from "./state.js";

export function shouldUseCodingPlanTeamMock(specs: string[] = []) {
  return shouldPrepareCodingPlanTeamMock(specs);
}

export async function startCodingPlanTeamMockIfNeeded(specs: string[] = []) {
  if (!shouldUseCodingPlanTeamMock(specs)) {
    await stopCodingPlanTeamMock();
    return;
  }

  const preparedBaseUrl = process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]?.trim();
  if (!wdioState.codingPlanTeamMockServer && preparedBaseUrl) {
    // Bugfix：采用前必须探活。launcher 若从 shell 继承了残留的死 URL、或 worker 拿到的
    // runnerEnv 指向已退出的 launcher server，静默采用会让控制面与数据面同时失联。
    if (await isCodingPlanTeamMockAlive(preparedBaseUrl)) {
      wdioState.codingPlanTeamMockBaseUrl = preparedBaseUrl;
      applyCodingPlanTeamMockEnv(process.env, preparedBaseUrl);
      return;
    }
    delete process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV];
  }
  if (wdioState.codingPlanTeamMockServer) {
    applyCodingPlanTeamMockEnv(process.env, wdioState.codingPlanTeamMockBaseUrl);
    return;
  }
  if (process.env.WDIO_WORKER_ID !== undefined) {
    // Fail fast：worker 内新起的 server 只有测试代码可达，Electron/Host 仍会指向
    // launcher 在 onPrepare 分配的地址（见 onPrepare 注释）。走到这里说明 runnerEnv
    // 没有携带存活的 mock 地址，静默降级只会让 waitForMockRequest 超时更难排查。
    throw new Error(
      "coding plan reset mock 未在 onPrepare 准备（runnerEnv 缺少存活的 ZCODE_E2E_CODING_PLAN_MOCK_URL）",
    );
  }

  let caseMode:
    | "default"
    | typeof SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
    | "model-provider-plan-surface" = "default";
  let subagentOAuthTokenIssued = false;
  let modelProviderCatalogMode: "full" | "partial" | "unavailable" = "full";
  let presentation: EntitlementPresentation | undefined;
  let scenario: "personalOnly" | "teamOnly" | "both" = "both";
  // Bug 回归：Start Plan 独立 case 需要 billing/balance 返回 Start Plan 权益与模型，
  // 让体验套餐和 Coding Plan 从首启就真实共存；mock 只在 onPrepare 创建一次，
  // 必须在创建时固定该模式，后续 worker 共享同一个 server 状态。
  const startIndependent = workerSpecsContain(
    specs,
    "conversation-session-start-plan-independent.test.ts",
  );
  let providerResponsive = startIndependent;
  let faultMode:
    | "none"
    | "optionalActivity"
    | "quotaBusinessFailure"
    | "quotaFailure"
    | "startBalance"
    | "startBalanceFailure"
    | "unavailableTeam"
    | "expiredTeam"
    | "twoTeams" = "none";
  let resetScenario:
    | "none"
    | "emptyThenGrant"
    | "existingMultiple"
    | "fiveHourUse"
    | "multiFiveHourUse"
    | "multiFiveHourUseLagging"
    | "urgentOpportunity" = "none";
  let resetScenarioStartedAt = Date.now();
  let resetOpportunityGranted = false;
  let resetUseAccepted = false;
  let resetUseConfirmed = false;
  // Bugfix：used_at 必须在确认时刻锁存。若每次 /status 都返回新的 Date.now()，
  // 客户端会把每轮轮询当成新完成，重复 history/read、entitlement 强刷甚至重播动效。
  let resetUsedAt: number | null = null;
  // multiFiveHourUse（QR-E2E-14）：FIVE_HOUR 持有 2 张机会，/use 即时核销最早一张（无 confirm
  // 步骤）。按 idempotency_key 幂等计数，与真实服务端一致：客户端重复发送旧 key 不会再核销一张。
  const resetMultiUsedKeys = new Set<string>();
  let resetMultiUnread = false;
  // multiFiveHourUseLagging（QR-E2E-15）：在 multiFiveHourUse 基础上，/use 核销结果延迟
  // RESET_USE_VISIBLE_LAG_MS 才在 /status 可见；窗口内 /status 返回核销前快照（上一张 used_at）。
  const RESET_USE_VISIBLE_LAG_MS = 600;
  let resetMultiLag: {
    usedAt: number | null;
    usedCount: number;
    unread: boolean;
    visibleAt: number;
  } | null = null;
  const requests: Array<{
    body?: unknown;
    headers: Record<string, string | string[] | undefined>;
    method: string;
    path: string;
    query: Record<string, string>;
  }> = [];
  const shareMockRoute = createConversationShareMockRoute();
  wdioState.codingPlanTeamMockServer = createServer(async (request, response) => {
    if (await shareMockRoute(request, response)) return;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__e2e/coding-plan/case-mode" && request.method === "POST") {
      presentation = undefined;
      const body = await readRequestJson<{ mode?: typeof caseMode }>(request);
      caseMode =
        body.mode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          ? SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          : body.mode === "model-provider-plan-surface"
            ? "model-provider-plan-surface"
            : "default";
      subagentOAuthTokenIssued = false;
      modelProviderCatalogMode = "full";
      scenario =
        caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE ? "personalOnly" : "both";
      faultMode = "none";
      resetScenario = "none";
      resetScenarioStartedAt = Date.now();
      resetOpportunityGranted = false;
      resetUseAccepted = false;
      resetUseConfirmed = false;
      resetUsedAt = null;
      resetMultiUsedKeys.clear();
      resetMultiUnread = false;
      resetMultiLag = null;
      requests.length = 0;
      writeJson(response, { mode: caseMode, ok: true });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/team-health" && request.method === "GET") {
      writeJson(response, { ok: true, mock: "team" });
      return;
    }

    if (url.pathname === "/__e2e/coding-plan/catalog-mode" && request.method === "POST") {
      const body = await readRequestJson<{ mode?: string }>(request);
      if (body.mode !== "full" && body.mode !== "partial" && body.mode !== "unavailable") {
        writeJson(response, { code: 400, msg: "invalid catalog mode" }, 400);
        return;
      }
      modelProviderCatalogMode = body.mode;
      writeJson(response, { mode: modelProviderCatalogMode, ok: true });
      return;
    }

    if (url.pathname === "/__e2e/coding-plan/scenario" && request.method === "POST") {
      const body = await readRequestJson<{
        scenario?: typeof scenario;
        faultMode?: typeof faultMode;
        providerResponsive?: boolean;
        presentation?: EntitlementPresentation;
      }>(request);
      providerResponsive = body.providerResponsive === true;
      presentation = body.presentation;
      if (
        body.scenario === "personalOnly" ||
        body.scenario === "teamOnly" ||
        body.scenario === "both"
      ) {
        scenario = body.scenario;
      }
      faultMode =
        body.faultMode === "optionalActivity" ||
        body.faultMode === "quotaBusinessFailure" ||
        body.faultMode === "quotaFailure" ||
        body.faultMode === "startBalance" ||
        body.faultMode === "unavailableTeam" ||
        body.faultMode === "expiredTeam" ||
        body.faultMode === "twoTeams" ||
        body.faultMode === "startBalanceFailure"
          ? body.faultMode
          : "none";
      requests.length = 0;
      writeJson(response, { faultMode, ok: true, scenario });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-scenario" && request.method === "POST") {
      const body = await readRequestJson<{
        resetScenario?: typeof resetScenario;
      }>(request);
      resetScenario =
        body.resetScenario === "emptyThenGrant" ||
        body.resetScenario === "existingMultiple" ||
        body.resetScenario === "fiveHourUse" ||
        body.resetScenario === "multiFiveHourUse" ||
        body.resetScenario === "multiFiveHourUseLagging" ||
        body.resetScenario === "urgentOpportunity"
          ? body.resetScenario
          : "none";
      resetOpportunityGranted = false;
      resetScenarioStartedAt = Date.now();
      resetUseAccepted = false;
      resetUseConfirmed = false;
      resetUsedAt = null;
      resetMultiUsedKeys.clear();
      resetMultiUnread = false;
      resetMultiLag = null;
      requests.length = 0;
      writeJson(response, { ok: true, resetScenario });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/reset-confirm-use" && request.method === "POST") {
      resetUseConfirmed = true;
      resetUsedAt ??= Date.now();
      writeJson(response, { ok: true });
      return;
    }
    if (url.pathname === "/__e2e/coding-plan/requests") {
      writeJson(response, { ok: true, requests });
      return;
    }

    const isResetMutation =
      request.method === "POST" &&
      (url.pathname.endsWith("/coding-plan/reset/opportunity") ||
        url.pathname.endsWith("/coding-plan/reset/use"));
    const requestBody = isResetMutation ? await readRequestJson<unknown>(request) : undefined;
    requests.push({
      ...(requestBody === undefined ? {} : { body: requestBody }),
      headers: {
        // reset 四接口的双 JWT 契约（Authorization=zcode JWT / X-Bigmodel-Authorization=MaaS JWT）
        // 由用例断言，必须一并记录。
        authorization: request.headers.authorization,
        "bigmodel-organization": request.headers["bigmodel-organization"],
        "bigmodel-project": request.headers["bigmodel-project"],
        "x-bigmodel-authorization": request.headers["x-bigmodel-authorization"],
      },
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
    });

    if (presentation) {
      const fixture = presentationResponse(url.pathname, presentation);
      if (fixture) {
        writeJson(response, fixture);
        return;
      }
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "POST" &&
      url.pathname === "/api/v1/oauth/cli/init"
    ) {
      writeJson(response, {
        code: 0,
        data: {
          authorize_url: `https://bigmodel.cn/login?appId=zcode&redirect=${encodeURIComponent("https://zcode.z.ai/api/v1/oauth/cli/callback/bigmodel")}&state=${SUBAGENT_CODING_PLAN_OAUTH_STATE}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
          flow_id: SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID,
          poll_interval_sec: 30,
        },
        msg: "",
      });
      return;
    }

    if (caseMode === "model-provider-plan-surface" && request.method === "GET") {
      if (url.pathname === "/api/v2/releases/latest") {
        writeJson(response, {
          config_version: "e2e-model-provider-catalog-v1",
          version: "3.8.1-e2e",
        });
        return;
      }
      if (url.pathname === "/api/v1/client/configs") {
        if (modelProviderCatalogMode === "unavailable") {
          writeJson(
            response,
            { code: 503, data: null, msg: "catalog temporarily unavailable" },
            503,
          );
          return;
        }
        if (modelProviderCatalogMode === "partial") {
          writeJson(response, {
            ...MODEL_PROVIDER_CATALOG_PAYLOAD,
            data: {
              ...MODEL_PROVIDER_CATALOG_PAYLOAD.data,
              builtinModels: MODEL_PROVIDER_CATALOG_PAYLOAD.data.builtinModels.slice(0, 1),
              builtinProviders: MODEL_PROVIDER_CATALOG_PAYLOAD.data.builtinProviders.slice(0, 1),
            },
          });
          return;
        }
        writeJson(response, MODEL_PROVIDER_CATALOG_PAYLOAD);
        return;
      }
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === `/api/v1/oauth/cli/poll/${SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID}`
    ) {
      writeJson(response, {
        code: 0,
        data: { status: "pending" },
        msg: "",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "POST" &&
      url.pathname === "/api/v1/oauth/token"
    ) {
      subagentOAuthTokenIssued = true;
      writeJson(response, {
        code: 0,
        data: {
          token: "e2e-subagent-login-zcode-jwt",
          bigmodel: {
            access_token: "e2e-subagent-login-bigmodel-token",
            refresh_token: "e2e-subagent-login-bigmodel-refresh-token",
          },
        },
        msg: "",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v2/releases/latest"
    ) {
      writeJson(response, {
        config_version: resolveSubagentLoginCatalogConfigVersion(subagentOAuthTokenIssued),
        version: "3.8.1-e2e",
      });
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v1/client/configs"
    ) {
      writeJson(
        response,
        resolveSubagentLoginCatalogPayload({
          configVersion: url.searchParams.get("config_version"),
          oauthTokenIssued: subagentOAuthTokenIssued,
        }),
      );
      return;
    }

    if (
      faultMode === "startBalanceFailure" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(response, { code: 429, msg: "Too many requests" }, 429);
      return;
    }

    if (
      providerResponsive &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(
        response,
        buildProviderResponsiveStartBalance(startIndependent ? "GLM-5.2" : undefined),
      );
      return;
    }

    if (
      caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      writeJson(response, {
        code: 0,
        data: { balances: [], plans: [] },
        msg: "",
        success: true,
      });
      return;
    }

    if (
      caseMode === "model-provider-plan-surface" &&
      request.method === "GET" &&
      url.pathname === "/api/v1/zcode-plan/billing/balance"
    ) {
      // 计划交叉用例需要一份确定的 Start Plan 权益；普通 Coding Plan 用例仍按
      // 自己的订阅接口判定，不把 Start 权益泄漏到其他 spec。
      writeJson(response, {
        code: 0,
        data: {
          plans: [
            {
              plan_id: "zcode-v3-start-plan",
              name: "ZCode V3 Start Plan",
              status: "active",
            },
          ],
          balances: [],
        },
        msg: "",
        success: true,
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/status") {
      if (resetScenario === "multiFiveHourUse" || resetScenario === "multiFiveHourUseLagging") {
        const lag =
          resetMultiLag !== null && Date.now() < resetMultiLag.visibleAt ? resetMultiLag : null;
        const usedCount = lag ? lag.usedCount : resetMultiUsedKeys.size;
        const usedAt = lag ? lag.usedAt : resetUsedAt;
        writeJson(response, {
          code: 0,
          data: {
            available_five_hour_resets: [
              { expire_at: resetScenarioStartedAt + 3_600_000 },
              { expire_at: resetScenarioStartedAt + 7_200_000 },
            ].slice(usedCount),
            available_week_resets: [{ expire_at: resetScenarioStartedAt + 86_400_000 }],
            latest_five_hour_reset_history:
              usedCount > 0 && usedAt !== null ? { used_at: usedAt } : null,
            latest_week_reset_history: null,
            has_unread_history: lag ? lag.unread : resetMultiUnread,
          },
        });
        return;
      }
      const useConfirmed = resetUseAccepted && resetUseConfirmed;
      const hasGrantedOpportunity = resetScenario !== "emptyThenGrant" || resetOpportunityGranted;
      const availableFiveHourResets =
        resetScenario === "none" || !hasGrantedOpportunity || useConfirmed
          ? []
          : resetScenario === "existingMultiple"
            ? [
                { expire_at: resetScenarioStartedAt + 3_600_000 },
                { expire_at: resetScenarioStartedAt + 7_200_000 },
              ]
            : resetScenario === "urgentOpportunity"
              ? // E2E mock must remain urgent after the Electron restart/build barrier;
                // anchoring to scenario setup made the opportunity expire before the
                // renderer finished its first status poll on slower Air runs.
                [{ expire_at: Date.now() + 120_000 }]
              : [{ expire_at: resetScenarioStartedAt + 3_600_000 }];
      const availableWeekResets =
        resetScenario === "existingMultiple" || resetScenario === "fiveHourUse"
          ? [{ expire_at: resetScenarioStartedAt + 86_400_000 }]
          : [];
      writeJson(response, {
        code: 0,
        data: {
          available_five_hour_resets: availableFiveHourResets,
          available_week_resets: availableWeekResets,
          latest_five_hour_reset_history:
            useConfirmed && resetUsedAt !== null ? { used_at: resetUsedAt } : null,
          latest_week_reset_history: null,
          has_unread_history: useConfirmed,
        },
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/opportunity") {
      const granted = resetScenario === "emptyThenGrant" || resetScenario === "existingMultiple";
      resetOpportunityGranted ||= granted;
      writeJson(response, {
        code: granted ? 0 : 3301,
        data: granted ? { granted: true } : { granted: false, next_try_at: Date.now() + 60_000 },
      });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/use") {
      if (resetScenario === "multiFiveHourUse" || resetScenario === "multiFiveHourUseLagging") {
        const idempotencyKey = (requestBody as { idempotency_key?: unknown } | null | undefined)
          ?.idempotency_key;
        if (
          typeof idempotencyKey === "string" &&
          idempotencyKey &&
          !resetMultiUsedKeys.has(idempotencyKey)
        ) {
          if (resetScenario === "multiFiveHourUseLagging") {
            resetMultiLag = {
              usedAt: resetUsedAt,
              usedCount: resetMultiUsedKeys.size,
              unread: resetMultiUnread,
              visibleAt: Date.now() + RESET_USE_VISIBLE_LAG_MS,
            };
          }
          resetMultiUsedKeys.add(idempotencyKey);
          // used_at 严格递增：客户端以 used_at 变化识别“又完成了一次”。
          resetUsedAt = Math.max(Date.now(), (resetUsedAt ?? 0) + 1);
          resetMultiUnread = true;
        }
        writeJson(response, { code: 0, data: { used: true } });
        return;
      }
      resetUseAccepted = true;
      resetUseConfirmed = false;
      writeJson(response, { code: 0, data: { used: true } });
      return;
    }

    if (url.pathname === "/api/v1/coding-plan/reset/history/read") {
      resetMultiUnread = false;
      writeJson(response, { code: 0, data: null });
      return;
    }

    if (
      await handleCodingPlanTeamAccountRoutes({
        state: { caseMode, faultMode, providerResponsive, scenario },
        request,
        response,
        url,
      })
    ) {
      return;
    }

    writeJson(response, { code: 404, msg: `Unhandled mock path: ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolveStart) => {
    wdioState.codingPlanTeamMockServer?.listen(0, "127.0.0.1", resolveStart);
  });
  const address = wdioState.codingPlanTeamMockServer.address() as AddressInfo;
  wdioState.codingPlanTeamMockBaseUrl = `http://127.0.0.1:${address.port}`;
  applyCodingPlanTeamMockEnv(process.env, wdioState.codingPlanTeamMockBaseUrl);
}

async function isCodingPlanTeamMockAlive(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/__e2e/coding-plan/team-health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function configureCodingPlanTeamMockForSpecs(specs: string[]) {
  if (!shouldUseCodingPlanTeamMock(specs)) {
    return;
  }
  const baseUrl =
    wdioState.codingPlanTeamMockBaseUrl || process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL?.trim() || "";
  if (!baseUrl) {
    throw new Error("coding plan mock case mode 配置失败：mock URL 未初始化");
  }
  const mode = isSubagentCodingPlanLoginCatalogStaleSpec(specs)
    ? SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
    : isModelProviderPlanSurfaceSpec(specs)
      ? "model-provider-plan-surface"
      : "default";
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/case-mode`, {
    body: JSON.stringify({ mode }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) {
    throw new Error(`coding plan mock case mode 配置失败：status=${response.status} mode=${mode}`);
  }
}

export async function stopCodingPlanTeamMock() {
  if (wdioState.codingPlanTeamMockServer) {
    await new Promise<void>((resolveStop) => {
      wdioState.codingPlanTeamMockServer?.close(() => resolveStop());
    });
    wdioState.codingPlanTeamMockServer = null;
  }
  if (wdioState.codingPlanDataPlaneProxy) {
    await wdioState.codingPlanDataPlaneProxy.stop();
    wdioState.codingPlanDataPlaneProxy = null;
  }
  // Bugfix：不能无条件删除共享 env。beforeSession 里 budget/catalog mock 先于本函数
  // 注入的 ZCODE_BASE_URL 等会被误删，导致那些 spec 的 Electron 打真实域名。
  // 只清除“当前值仍指向本 mock”的键：既撤掉 runnerEnv 播种到非 team worker 的污染，
  // 又不碰其他 mock 家族刚写入的值。
  const ownedBaseUrl =
    wdioState.codingPlanTeamMockBaseUrl ||
    process.env[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]?.trim() ||
    "";
  wdioState.codingPlanTeamMockBaseUrl = "";
  if (!ownedBaseUrl) {
    return;
  }
  clearCodingPlanTeamMockEnv(process.env, ownedBaseUrl);
}
