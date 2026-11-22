/**
 * BigModel 用量 provider 的 HTTP 细节。
 *
 * 负责鉴权 header、quota/monitor/reset URL 组装、reset 信封读取与时间范围换算。
 * 这里不缓存凭据，也不决定调用顺序，调用顺序由 provider 保持。
 */
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import {
  ApiError,
  BUILTIN_MODEL_PROVIDER_IDS,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
  isZaiCodingPlanProviderId,
} from "@zcode/shared";
import { readEnv } from "../../../oauth/providers/configUtils.js";
import { BIGMODEL_QUOTA_PATH } from "./constants.js";
import { codingPlanResetEnvelopeSchema } from "./parsing.js";
import type { CodingPlanResetAuthorization, ResolvedQuotaAuthorization } from "./types.js";

export function createCodingPlanResetHeaders(
  authorization: CodingPlanResetAuthorization,
  includeTargetScope: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: authorization.zcodeAuthorization,
    "X-Bigmodel-Authorization": authorization.codingPlanAuthorization,
  };
  if (!includeTargetScope) {
    return headers;
  }
  headers["Bigmodel-Target-Type"] = authorization.teamContext ? "TEAM" : "PERSONAL";
  if (authorization.teamContext) {
    headers["Bigmodel-Organization"] = authorization.teamContext.organizationId;
    headers["Bigmodel-Project"] = authorization.teamContext.projectId;
  }
  return headers;
}

export function readApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "msg", "detail"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

export function readApiDiagnosticHeaders(headers: Headers): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const name of ["x-request-id", "x-trace-id", "x-span-id"] as const) {
    const value = headers.get(name)?.trim();
    if (value) {
      result[name] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// 联调对账后缀：envelope 业务错误（如 2007 依赖失败）需要把后端 x-request-id
// 带进错误 message，RPC 日志和 UI warn 才能与后端日志按请求 id 精确对上。
// 仅用于日志定位，客户端不做分支；缺失时返回空串保持原 message 契约。
export function readCodingPlanResetErrorDiagnostics(headers: Headers): string {
  const requestId = headers.get("x-request-id")?.trim();
  return requestId ? ` (x-request-id:${requestId})` : "";
}

export async function readCodingPlanResetApiJson(
  apiClient: ApiClient,
  input: string,
  init: ApiRequestInit,
  options: { acceptedBusinessCodes?: readonly number[] } = {},
): Promise<unknown> {
  const response = await apiClient.request(input, init);
  let payload: unknown;
  let parseError: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch (error) {
    parseError = error;
  }

  // reset 后端在 HTTP 4xx 时仍通过统一 envelope 返回稳定业务 code。
  // 必须先读取 code，不能把易变的 msg 当成客户端分支依据。
  const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (envelope.success && envelope.data.code !== 0) {
    if (options.acceptedBusinessCodes?.includes(envelope.data.code)) {
      return payload;
    }
    throw new Error(
      `coding_plan_reset_api_error:${envelope.data.code}${readCodingPlanResetErrorDiagnostics(response.headers)}`,
    );
  }

  if (!response.ok) {
    throw new ApiError({
      message: readApiErrorMessage(payload, `HTTP ${response.status}`),
      url: input,
      method: init.method,
      status: response.status,
      responseHeaders: readApiDiagnosticHeaders(response.headers),
      cause: parseError,
    });
  }
  if (parseError !== undefined) {
    throw new Error("coding_plan_reset_invalid_response", {
      cause: parseError,
    });
  }
  return payload;
}

export function createBigModelUsageHeaders(
  resolved: ResolvedQuotaAuthorization,
): Record<string, string> {
  const headers: Record<string, string> = {
    // monitor 接口要求 authorization 直接传完整凭据。
    // 普通用量和 Coding Plan 用量都走 API Key，不能额外加 Bearer 前缀。
    authorization: resolved.authorization,
  };
  if (resolved.teamContext) {
    // Team Plan 的 quota / usage 按组织和项目隔离。
    // 只用 provider id 会固定读取默认项目，多个团队时余额会和当前选择不一致。
    headers["bigmodel-organization"] = resolved.teamContext.organizationId;
    headers["bigmodel-project"] = resolved.teamContext.projectId;
  }
  return headers;
}

export function buildQuotaLimitUrl(resolved: ResolvedQuotaAuthorization): string {
  if (!resolved.teamContext) {
    return resolved.quotaUrl;
  }

  // BigModel Team Plan 的 quota/limit 后端按 type=2 路由到团队套餐。
  // 只切换团队项目 key/header 仍会走个人 Coding Plan 分支并返回“当前用户不存在 coding plan”。
  const url = new URL(resolved.quotaUrl);
  url.searchParams.set("type", "2");
  return url.toString();
}

export function sanitizeMonitorDiagnosticUrl(url: string | undefined): string {
  if (!url) return "<unknown-monitor-url>";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-monitor-url>";
  }
}

export function buildUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "model-usage" | "tool-usage",
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, `/${endpoint}`);
  if (resolved.teamContext) {
    // BigModel Team Plan 的 monitor 用量接口和 quota/limit 一样按 type=2 路由。
    // 只带团队项目 key/header 时仍会落到个人 Coding Plan 分支并返回不存在套餐。
    url.searchParams.set("type", "2");
  }
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

export function buildCreditUsageMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  endpoint: "activity" | "usage-detail",
  startTime: string,
  endTime: string,
  usageType?: "MODEL" | "MCP",
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/usage\/quota\/limit$/, `/credit-usage/${endpoint}`);
  // Team Plan 的 quota/limit 仍用 type=2，但 credit-usage 使用 type=3；
  // 继续沿用 type=2 会触发后端“仅企业主账号可查询企业汇总数据”分支。
  url.searchParams.set("type", resolved.teamContext ? "3" : "1");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  if (usageType) {
    url.searchParams.set("usageType", usageType);
  }
  return url.toString();
}

export function buildModelPerformanceMonitorUrl(
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
): string {
  const url = new URL(resolved.quotaUrl);
  url.pathname = url.pathname.replace(/\/quota\/limit$/, "/model-performance-day");
  url.searchParams.set("startTime", startTime);
  url.searchParams.set("endTime", endTime);
  return url.toString();
}

export function resolveCreditUsageActivityTimeRange(timeZone: string | undefined): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, -365);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

export function resolveModelPerformanceTimeRange(
  timeZone: string | undefined,
  range: "7d" | "30d",
): {
  startTime: string;
  endTime: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), timeZone);
  const startDateKey = addDaysToDateKey(endDateKey, range === "7d" ? -6 : -29);
  return {
    startTime: `${startDateKey} 00:00:00`,
    endTime: `${endDateKey} 23:59:59`,
  };
}

export function formatDateInTimeZone(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function resolveQuotaUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return readEnv(env, "ZCODE_BIGMODEL_USAGE_QUOTA_URL") ?? readEnv(env, "BIGMODEL_USAGE_QUOTA_URL");
}

export function resolveCodingPlanApiKeyError(providerId: string | undefined): string {
  if (providerId && isZaiCodingPlanProviderId(providerId)) {
    return "zai_coding_plan_api_key_required";
  }
  return "bigmodel_coding_plan_api_key_required";
}

export function resolveAccountProviderQuotaUrl(providerId: string, env: NodeJS.ProcessEnv): string {
  return isZaiCodingPlanProviderId(providerId) ? buildZaiQuotaUrl(env) : buildBigModelQuotaUrl(env);
}

export function resolveAccountProviderLabel(providerId: string): string {
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    ? "Z.ai - Coding Plan"
    : "BigModel - Coding Plan";
}

export function buildBigModelQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  return buildBigModelApiUrl(env, BIGMODEL_QUOTA_PATH);
}

export function buildZaiQuotaUrl(env: NodeJS.ProcessEnv = process.env): string {
  // ZAI usage/quota 与 business login 共用业务域名。
  // 测试环境必须请求 配置的 ZAI Business origin，不能把测试 token 发送到生产 api.z.ai。
  return buildRuntimeZaiBusinessUrl(env, "/api/monitor/usage/quota/limit");
}
