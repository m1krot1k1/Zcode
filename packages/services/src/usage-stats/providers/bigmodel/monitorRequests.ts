/**
 * BigModel monitor / MCP 额度请求包装。
 *
 * provider 只按既有顺序发起请求；header、URL 与超时细节在 ./http.js，
 * 本模块把 apiClient 作为显式参数，不持有 provider 状态。
 */
import type { ApiClient, UsageMcpQuotaSnapshot } from "@zcode/shared";
import { isCodingPlanModelProviderId, isZaiCodingPlanProviderId } from "@zcode/shared";
import { readApiJson } from "../../../providers/api/apiJson.js";
import {
  fetchMcpQuotaSnapshot,
  type OfficialMcpCredentialSource,
} from "../zcodeMcpQuotaProvider.js";
import type { BigModelUsageQuotaEnvelope } from "../bigmodelUsageQuotaMapper.js";
import type {
  BigModelCreditUsageActivityEnvelope,
  BigModelCreditUsageDetailEnvelope,
  BigModelUsageModelPerformanceEnvelope,
  BigModelUsageModelUsageEnvelope,
  BigModelUsageToolUsageEnvelope,
} from "../bigmodelUsageMonitorMapper.js";
import { REQUEST_TIMEOUT_MS } from "./constants.js";
import {
  buildCreditUsageMonitorUrl,
  buildModelPerformanceMonitorUrl,
  buildQuotaLimitUrl,
  buildUsageMonitorUrl,
  createBigModelUsageHeaders,
  resolveCreditUsageActivityTimeRange,
  resolveModelPerformanceTimeRange,
} from "./http.js";
import type { ResolvedQuotaAuthorization } from "./types.js";

/**
 * 读取官方 Server MCP 额度。仅 Coding Plan provider 会发起：
 * 环境变量 key、普通 API Key provider 与 Start Plan 都没有该权益。
 */
export async function fetchMcpQuota(
  apiClient: ApiClient,
  officialMcpCredentialSource: OfficialMcpCredentialSource | undefined,
  env: NodeJS.ProcessEnv,
  resolved: ResolvedQuotaAuthorization,
): Promise<UsageMcpQuotaSnapshot | null> {
  if (!officialMcpCredentialSource) {
    return null;
  }
  if (!isCodingPlanModelProviderId(resolved.provider.id)) {
    return null;
  }
  return fetchMcpQuotaSnapshot({
    apiClient,
    credentialSource: officialMcpCredentialSource,
    env,
    requestScope: {
      providerFamily:
        resolved.teamContext?.family ??
        (isZaiCodingPlanProviderId(resolved.provider.id) ? "zai" : "bigmodel"),
      organizationId: resolved.teamContext?.organizationId ?? null,
      projectId: resolved.teamContext?.projectId ?? null,
    },
  });
}

export async function fetchQuota(
  apiClient: ApiClient,
  resolved: ResolvedQuotaAuthorization,
): Promise<BigModelUsageQuotaEnvelope> {
  return readApiJson<BigModelUsageQuotaEnvelope>(apiClient, buildQuotaLimitUrl(resolved), {
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: createBigModelUsageHeaders(resolved),
  });
}

export async function fetchModelUsage(
  apiClient: ApiClient,
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
): Promise<BigModelUsageModelUsageEnvelope> {
  return readApiJson<BigModelUsageModelUsageEnvelope>(
    apiClient,
    buildUsageMonitorUrl(resolved, "model-usage", startTime, endTime),
    {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    },
  );
}

export async function fetchToolUsage(
  apiClient: ApiClient,
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
): Promise<BigModelUsageToolUsageEnvelope> {
  return readApiJson<BigModelUsageToolUsageEnvelope>(
    apiClient,
    buildUsageMonitorUrl(resolved, "tool-usage", startTime, endTime),
    {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    },
  );
}

export async function fetchCreditUsageActivity(
  apiClient: ApiClient,
  resolved: ResolvedQuotaAuthorization,
  timeZone: string | undefined,
): Promise<BigModelCreditUsageActivityEnvelope> {
  const range = resolveCreditUsageActivityTimeRange(timeZone);
  return readApiJson<BigModelCreditUsageActivityEnvelope>(
    apiClient,
    buildCreditUsageMonitorUrl(resolved, "activity", range.startTime, range.endTime),
    {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    },
  );
}

export async function fetchCreditUsageDetail(
  apiClient: ApiClient,
  resolved: ResolvedQuotaAuthorization,
  startTime: string,
  endTime: string,
  usageType: "MODEL" | "MCP",
): Promise<BigModelCreditUsageDetailEnvelope> {
  return readApiJson<BigModelCreditUsageDetailEnvelope>(
    apiClient,
    buildCreditUsageMonitorUrl(resolved, "usage-detail", startTime, endTime, usageType),
    {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    },
  );
}

export async function fetchModelPerformanceDay(
  apiClient: ApiClient,
  resolved: ResolvedQuotaAuthorization,
  timeZone: string | undefined,
  range: "7d" | "30d",
): Promise<BigModelUsageModelPerformanceEnvelope> {
  const timeRange = resolveModelPerformanceTimeRange(timeZone, range);
  return readApiJson<BigModelUsageModelPerformanceEnvelope>(
    apiClient,
    buildModelPerformanceMonitorUrl(resolved, timeRange.startTime, timeRange.endTime),
    {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: createBigModelUsageHeaders(resolved),
    },
  );
}
