import type { IncomingMessage, ServerResponse } from "node:http";
import {
  requestSecurityAgentConfig,
  requestSecurityClientConfig,
} from "../helpers/request-security-edition/index.js";
import { PROVIDER_RESPONSIVE_TEAM_NAME } from "../fixtures/provider-family-responsive.js";
import { CODING_PLAN_MODEL_SSE_BODY } from "./env.js";
import { readRequestJson, writeJson } from "./http-utils.js";
import { SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE } from "./specs.js";

/**
 * Read-only снимок режимов mock-сервера: ветки аккаунта, подписок и метрик
 * только читают сценарий, поэтому мутирующее состояние остаётся в
 * mocks-coding-plan-team.ts.
 */
export interface CodingPlanTeamAccountRoutesState {
  caseMode: string;
  faultMode: string;
  providerResponsive: boolean;
  scenario: string;
}

/**
 * Аккаунт/подписки/метрики Coding Plan. Возвращает true, если запрос обработан;
 * false — вызывающий продолжает цепочку маршрутов (порядок веток — часть контракта).
 */
export async function handleCodingPlanTeamAccountRoutes(params: {
  state: CodingPlanTeamAccountRoutesState;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}): Promise<boolean> {
  const { request, response, url } = params;
  const { caseMode, faultMode, providerResponsive, scenario } = params.state;
  // Composer 切换会刷新 Built-in；缺省下载地址保留本轮已种入的目录，不能返回 404。
  if (url.pathname === "/api/v1/client/configs") {
    writeJson(response, {
      code: 0,
      success: true,
      data: {
        configs: requestSecurityClientConfig(),
      },
    });
    return true;
  }
  if (url.pathname === "/api/v1/agent/configs") {
    writeJson(response, {
      code: 0,
      data: requestSecurityAgentConfig(),
    });
    return true;
  }

  if (url.pathname === "/api/anthropic/v1/messages") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.end(CODING_PLAN_MODEL_SSE_BODY);
    return true;
  }

  if (url.pathname === "/api/biz/subscription/enterprise/v2/pricing") {
    writeJson(response, {
      code: 200,
      data: {
        productList:
          scenario === "personalOnly"
            ? []
            : [
                {
                  productId: "product-team-a",
                  tier: "PRO",
                  subscribeMode: "CONTINUOUS",
                  subscribePeriod: "MONTHLY",
                  purchaseMethodName: "连续包月",
                  subscribed: true,
                },
              ],
      },
    });
    return true;
  }

  if (url.pathname === "/api/biz/customer/getCustomerInfo") {
    writeJson(response, {
      code: 200,
      data: {
        ...(caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE
          ? {
              avatar: "",
              customerName: "Subagent Login E2E",
              customerNumber: "subagent-login-e2e-user",
              nickName: "Subagent Login E2E",
            }
          : {}),
        organizations: [
          ...(["expiredTeam", "twoTeams"].includes(faultMode)
            ? [
                {
                  organizationId: "org-team-b",
                  organizationName: "Active Team",
                  projects: [{ projectId: "proj-team-b", projectName: "Team B", projectType: 2 }],
                },
              ]
            : []),
          ...(faultMode === "unavailableTeam"
            ? [
                {
                  organizationId: "org-unavailable",
                  organizationName: "Unavailable Team",
                  projects: [
                    { projectId: "proj-unavailable", projectName: "Unavailable", projectType: 2 },
                  ],
                },
              ]
            : []),
          {
            organizationId: "org-team-a",
            organizationName: providerResponsive ? PROVIDER_RESPONSIVE_TEAM_NAME : "Team Org",
            projects: [
              ...(scenario !== "teamOnly" ||
              caseMode === SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE ||
              caseMode === "model-provider-plan-surface"
                ? [
                    {
                      projectId: "proj-personal-a",
                      projectName: "Personal Project",
                      projectType: 1,
                    },
                  ]
                : []),
              {
                projectId: "proj-team-a",
                projectName: "Team A",
                projectType: 2,
              },
            ],
          },
        ],
      },
    });
    return true;
  }

  if (request.method === "POST" && url.pathname.endsWith("/access_tokens")) {
    // 原因：账号 Provider 已改用项目 Token；旧夹具只返回长期 Key，使个人权益一直 unknown。
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: expiresAt })}.e2e-signature`;
    writeJson(response, {
      code: 200,
      data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn: 600, expiresAt },
    });
    return true;
  }

  if (url.pathname.endsWith("/api_keys")) {
    // Bug 根因：Provider 重构后个人 Coding Plan 会从 customerInfo 的个人项目解析
    // 项目 Key。旧 mock 仅按全局 scenario 返回 Team Key，both 场景即使明确选择
    // 个人 Provider 也拿不到对应凭据。fixture 必须和服务端一样按项目身份返回 Key。
    const personal = url.pathname.includes("/projects/proj-personal-a/");
    if (faultMode === "unavailableTeam" && url.pathname.includes("/projects/proj-unavailable/")) {
      writeJson(
        response,
        request.method === "POST"
          ? { code: 200, success: false, msg: "暂无有效的团队套餐授权记录", data: null }
          : { code: 200, data: [] },
      );
      return true;
    }
    writeJson(response, {
      code: 200,
      data: [
        {
          apiKey: personal ? "personal-ak" : "team-ak",
          keyType: personal ? 1 : 2,
          name: personal ? "zcode-api-key" : "zcode-team-api-key",
        },
      ],
    });
    return true;
  }

  if (
    request.method === "POST" &&
    /^\/api\/biz\/v1\/organization\/org-team-a\/projects\/proj-(personal|team)-a\/api_keys\/(personal|team)-ak\/access_tokens$/.test(
      url.pathname,
    )
  ) {
    // 项目鉴权已改为短期 Token；缺少签发响应会让模型目录在工具请求之前被判不可用。
    const body = await readRequestJson<{ clientType?: string }>(request);
    if (body.clientType !== "zcode" || !request.headers.authorization?.startsWith("Bearer ")) {
      writeJson(response, { code: 400, msg: "invalid_token_request" }, 400);
      return true;
    }
    const expiresIn = 600;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })}.${encode({ token_use: "project_access", api_key: "e2e-key", exp: expiresAt })}.e2e-signature`;
    writeJson(response, {
      code: 200,
      data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn, expiresAt },
    });
    return true;
  }

  if (
    url.pathname.endsWith("/api_keys/copy/team-ak") ||
    url.pathname.endsWith("/api_keys/copy/personal-ak")
  ) {
    const personal = url.pathname.endsWith("/api_keys/copy/personal-ak");
    writeJson(response, {
      code: 200,
      data: { secretKey: personal ? "personal-secret" : "team-secret" },
    });
    return true;
  }

  if (url.pathname === "/api/biz/team/subscribe/product/querySubscribeDetail") {
    writeJson(response, {
      code: 200,
      success: true,
      data:
        scenario === "personalOnly"
          ? { hasSubscription: false }
          : {
              hasSubscription: true,
              status:
                faultMode === "expiredTeam" && request.headers["bigmodel-project"] !== "proj-team-b"
                  ? "EXPIRED"
                  : "EFFECTIVE",
              memberGrantStatus: "VALID",
              productId: "product-team-a",
              productName: "Team Org",
              subscribeEndTime: "2027-08-25",
              subscribePeriod: "YEARLY",
            },
    });
    return true;
  }

  if (url.pathname === "/api/biz/subscription/list") {
    writeJson(response, {
      code: 200,
      data:
        scenario === "teamOnly"
          ? []
          : [
              {
                productId: "personal-coding",
                productName: "Coding Plan",
                // Bugfix: provider 可用性校验会要求订阅处于有效期；只给 renewTime 会被判成无个人权益。
                inCurrentPeriod: true,
                status: "VALID",
                renewTime: "2026-08-01T00:00:00.000Z",
              },
            ],
    });
    return true;
  }

  if (url.pathname === "/api/monitor/usage/quota/limit") {
    if (faultMode === "quotaBusinessFailure") {
      // CTP-11 第一阶段用业务失败生成 provider/unavailable 快照，验证入口稳定；
      // 随后的详情 fatal 会显式切换 quotaFailure，避免两种语义互相覆盖。
      writeJson(response, { code: 500, msg: "e2e quota business failure" });
      return true;
    }
    if (faultMode === "quotaFailure") {
      writeJson(response, { code: 500, msg: "e2e quota transport failure" }, 500);
      return true;
    }
    const isTeam = url.searchParams.get("type") === "2";
    const hasPlan = isTeam ? scenario !== "personalOnly" : scenario !== "teamOnly";
    if (!hasPlan) {
      writeJson(response, {
        code: 500,
        success: false,
        msg: "当前用户不存在coding plan",
      });
      return true;
    }
    writeJson(response, {
      code: 200,
      data: {
        level: isTeam ? "team" : "pro",
        limits: [
          {
            type: "TOKENS_LIMIT",
            unit: 3,
            number: 5,
            remaining: isTeam ? 900 : 700,
            percentage: isTeam ? 10 : 30,
            nextResetTime: Date.UTC(2026, 6, 4, 10, 0),
          },
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            remaining: isTeam ? 8000 : 6000,
            percentage: isTeam ? 20 : 40,
            nextResetTime: Date.UTC(2026, 6, 10, 0, 0),
          },
        ],
      },
    });
    return true;
  }

  if (url.pathname === "/api/monitor/credit-usage/activity") {
    if (faultMode === "optionalActivity") {
      writeJson(response, { code: 500, msg: "e2e optional activity failure" }, 500);
      return true;
    }
    writeJson(response, {
      code: 200,
      data: {
        summary: {
          totalTokens: 350720,
          peakDailyTokens: 120000,
          peakDailyTokensDate: "2026-08-16",
          totalUsageDurationMs: 5400000,
          currentStreakDays: 2,
          longestStreakDays: 4,
        },
        series: [
          {
            date: "2026-08-16",
            totalTokens: 350720,
            modelCallCount: 7,
            mcpCalls: 3,
          },
        ],
      },
    });
    return true;
  }

  if (url.pathname === "/api/monitor/credit-usage/usage-detail") {
    const isModel = url.searchParams.get("usageType") === "MODEL";
    writeJson(response, {
      code: 200,
      data: isModel
        ? {
            summary: {
              cacheHitRate: { value: 0.893, trend: 0.12 },
              totalCredits: { value: 28.95, trend: -0.2 },
              averageDailyCredits: { value: 4.13, trend: 0 },
            },
            modelUsage: {
              xTime: ["2026-08-16"],
              modelDataList: [
                {
                  modelName: "glm-credit-e2e",
                  totalTokens: 350720,
                  totalCredits: 28.95,
                  totalCreditsUsage: [28.95],
                  totalTokensUsage: [350720],
                  cachedInputCreditsUsage: [17.68],
                  uncachedInputCreditsUsage: [8.63],
                  outputCreditsUsage: [2.64],
                  cachedInputTokensUsage: [200000],
                  uncachedInputTokensUsage: [100000],
                  outputTokensUsage: [50720],
                  sortOrder: 1,
                },
              ],
            },
          }
        : {
            summary: {
              cacheHitRate: { value: null },
              totalCredits: { value: 1, trend: 0.5 },
              averageDailyCredits: { value: 0.2, trend: 0.1 },
            },
            mcpUsage: {
              xTime: ["2026-08-16"],
              mcpDataList: [
                {
                  mcpCode: "e2e-search",
                  mcpName: "E2E Search MCP",
                  creditsUsage: [1],
                  mcpCallCount: [3],
                  totalUsageCount: 3,
                  totalCredits: 1,
                  sortOrder: 1,
                },
              ],
            },
          },
    });
    return true;
  }

  if (url.pathname === "/api/monitor/usage/model-performance-day") {
    writeJson(response, {
      code: 200,
      data: {
        x_time: ["2026-08-16"],
        proMaxDecodeSpeed: [125.4],
        liteDecodeSpeed: [55.2],
      },
    });
    return true;
  }

  if (url.pathname === "/api/monitor/usage/model-usage") {
    const isTeam = url.searchParams.get("type") === "2";
    writeJson(response, {
      code: 200,
      data: {
        x_time: ["2026-07-01", "2026-07-02"],
        granularity: "daily",
        totalUsage: {
          totalModelCallCount: 2,
          totalTokensUsage: isTeam ? 3210 : 1230,
        },
        modelDataList: [
          {
            modelName: isTeam ? "glm-team-e2e" : "glm-personal-e2e",
            sortOrder: 1,
            tokensUsage: isTeam ? [1200, 2010] : [500, 730],
            totalTokens: isTeam ? 3210 : 1230,
          },
        ],
        modelSummaryList: [
          {
            modelName: isTeam ? "glm-team-e2e" : "glm-personal-e2e",
            sortOrder: 1,
            totalTokens: isTeam ? 3210 : 1230,
          },
        ],
      },
    });
    return true;
  }

  if (url.pathname === "/api/monitor/usage/tool-usage") {
    const isTeam = url.searchParams.get("type") === "2";
    writeJson(response, {
      code: 200,
      data: {
        x_time: ["2026-07-01", "2026-07-02"],
        granularity: "daily",
        toolDataList: [
          {
            toolCode: isTeam ? "team-search" : "personal-search",
            toolName: isTeam ? "Team Search" : "Personal Search",
            sortOrder: 1,
            usageCount: isTeam ? [2, 3] : [1, 1],
            totalUsageCount: isTeam ? 5 : 2,
          },
        ],
        toolSummaryList: [
          {
            toolCode: isTeam ? "team-search" : "personal-search",
            toolName: isTeam ? "Team Search" : "Personal Search",
            sortOrder: 1,
            totalUsageCount: isTeam ? 5 : 2,
          },
        ],
      },
    });
    return true;
  }

  return false;
}
