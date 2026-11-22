import {
  CODING_PLAN_SYSTEM_BUSY,
  REQUEST_VERIFICATION_REQUIRED,
  isRequestVerificationMessage,
  isZaiCodingPlanProviderId,
  type ApiClient,
  type ApiRequestInit,
  type CodingPlanSubscriptionProviderId,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED } from "./constants.js";
import type { RemoteEnvelope } from "./types.js";

// 合并时曾丢失秒到毫秒的边界转换，导致客户端用本机时间误判待生效权益。
export function readServerTimeMilliseconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value * 1_000
    : undefined;
}

export function assertZaiPaymentProvider(providerId: CodingPlanSubscriptionProviderId): void {
  if (!isZaiCodingPlanProviderId(providerId)) {
    throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
  }
}

export function unwrapEnvelope<T>(
  payload: RemoteEnvelope<T>,
  providerId: CodingPlanSubscriptionProviderId,
): T {
  if (payload.code !== undefined && payload.code !== 200) {
    throw new Error(normalizeRemoteErrorMessage(payload.msg, providerId, payload.code));
  }
  if (payload.success === false) {
    throw new Error(normalizeRemoteErrorMessage(payload.msg, providerId));
  }
  if (payload.data === null || payload.data === undefined) {
    const providerName = resolveCodingPlanProviderName(providerId);
    throw new Error(payload.msg?.trim() || `${providerName} response missing data`);
  }
  return payload.data;
}

export function resolveClientPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function normalizeRemoteErrorMessage(
  msg: string | undefined,
  providerId: CodingPlanSubscriptionProviderId,
  code?: number,
) {
  const message = msg?.trim();
  if (message && isUnrenderableRemoteErrorMessage(message)) {
    return CODING_PLAN_SYSTEM_BUSY;
  }
  if (message && isRequestVerificationMessage(message)) {
    return REQUEST_VERIFICATION_REQUIRED;
  }
  const providerName = resolveCodingPlanProviderName(providerId);
  return message || `${providerName} request failed${code ? `: ${code}` : ""}`;
}

export async function readCodingPlanApiJson<T>(
  apiClient: ApiClient,
  input: string | URL,
  init?: ApiRequestInit,
): Promise<T> {
  try {
    return await readApiJson<T>(apiClient, input, init);
  } catch (error) {
    const message = readRemoteErrorMessage(error);
    if (isUnrenderableRemoteErrorMessage(message)) {
      // 支付接口偶发返回 WAF/HTML 页面或非 JSON 响应，原样透传会把整段
      // HTML 渲到确认支付页。服务边界先收敛为稳定错误码，UI 再做本地化提示。
      throw new Error(CODING_PLAN_SYSTEM_BUSY);
    }
    throw error;
  }
}

function readRemoteErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

function isUnrenderableRemoteErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

function resolveCodingPlanProviderName(providerId: CodingPlanSubscriptionProviderId): string {
  return isZaiCodingPlanProviderId(providerId) ? "Z.ai" : "BigModel";
}

export function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
