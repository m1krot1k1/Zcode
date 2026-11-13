import {
  buildRuntimeZCodeApiUrl,
  requestVerificationClaimHeaders,
  ZCODE_VERSION,
  type ApiClient,
  type ManualClaimPlanClaimRequest,
  type ManualClaimPlanClaimResult,
  type ManualClaimPlanPreviewSnapshot,
} from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { REQUEST_TIMEOUT_MS, ZCODE_JWT_TOKEN_KEY } from "./constants.js";
import {
  readCodingPlanApiJson,
  readServerTimeMilliseconds,
  resolveClientPlatformKey,
} from "./transport.js";
import type {
  ManualClaimPlanClaimPayload,
  ManualClaimPlanPreviewPayload,
  RemoteEnvelope,
} from "./types.js";

/** /api/v1/zcode-plan/billing/preview 的读取与解包（code=0 envelope）。 */
export async function fetchManualClaimPlanPreviews(
  apiClient: ApiClient,
  credentialService: Pick<ICredentialService, "load">,
): Promise<ManualClaimPlanPreviewSnapshot> {
  const token = (await credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
  const url = new URL(buildRuntimeZCodeApiUrl(process.env, "/api/v1/zcode-plan/billing/preview"));
  url.searchParams.set("app_version", ZCODE_VERSION);
  url.searchParams.set("platform", resolveClientPlatformKey());
  const payload = await readCodingPlanApiJson<RemoteEnvelope<ManualClaimPlanPreviewPayload>>(
    apiClient,
    url,
    {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );
  // 新 ZCode billing 接口沿用平台 envelope（code=0 成功），不能复用
  // BigModel 支付接口的 code=200 解包器，否则合法 preview 会被误判失败。
  if (payload.code !== undefined && payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "manual_claim_preview_failed");
  }
  if (!payload.data) {
    throw new Error(payload.msg?.trim() || "manual_claim_preview_missing_data");
  }
  const data = payload.data;
  const serverTime = readServerTimeMilliseconds(data.server_time);
  const plans = (data.plans ?? []).flatMap((plan) => {
    const planId = plan.plan_id?.trim() ?? "";
    if (!planId) return [];
    return [
      {
        planId,
        name: plan.name?.trim() || planId,
        description: plan.description?.trim() ?? "",
        priority: Number.isFinite(plan.priority) ? (plan.priority ?? 0) : 0,
        entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
          const entitlementId = entitlement.entitlement_id?.trim() ?? "";
          if (!entitlementId) return [];
          return [
            {
              entitlementId,
              showName: entitlement.show_name?.trim() ?? "",
              meter: entitlement.meter?.trim() ?? "",
              unitType: entitlement.unit_type?.trim() ?? "",
              capabilities: entitlement.capabilities ?? [],
              grantUnits: Number.isFinite(entitlement.grant_units)
                ? (entitlement.grant_units ?? 0)
                : 0,
              period: entitlement.period?.trim() ?? "",
              priority: Number.isFinite(entitlement.priority) ? (entitlement.priority ?? 0) : 0,
              ...(Number.isFinite(entitlement.effective_at)
                ? { effectiveAt: entitlement.effective_at }
                : {}),
            },
          ];
        }),
      },
    ];
  });
  return { ...(serverTime === undefined ? {} : { serverTime }), plans };
}

/** /api/v1/zcode-plan/billing/claim 的提交与解包（code 可能是数字字符串）。 */
export async function submitManualPlanClaim(
  apiClient: ApiClient,
  credentialService: Pick<ICredentialService, "load">,
  request: ManualClaimPlanClaimRequest,
): Promise<ManualClaimPlanClaimResult> {
  const token = (await credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
  if (!token) {
    return { success: false, code: 401, message: "" };
  }
  const payload = await readCodingPlanApiJson<
    Omit<RemoteEnvelope<ManualClaimPlanClaimPayload>, "code"> & { code?: number | string }
  >(apiClient, new URL(buildRuntimeZCodeApiUrl(process.env, "/api/v1/zcode-plan/billing/claim")), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...requestVerificationClaimHeaders(request),
      "X-ZCode-App-Version": ZCODE_VERSION,
      "X-Platform": resolveClientPlatformKey(),
    },
    body: JSON.stringify({ plan_id: request.planId }),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  // 领取接口的错误码可能是数字字符串；缺失 code 仍不推断成功。
  const rawCode = payload.code;
  const code =
    typeof rawCode === "number"
      ? rawCode
      : typeof rawCode === "string" && /^\d+$/.test(rawCode)
        ? Number(rawCode)
        : -1;
  const serverTime = readServerTimeMilliseconds(payload.data?.server_time);
  if (code !== 0 || !payload.data?.plan) {
    const failureEndsAt = payload.data?.plan?.ends_at;
    return {
      success: false,
      code,
      // 服务端已完成翻译，顶层 msg 不是用户文案；空值由 UI 本地化兜底。
      message: typeof payload.data?.message === "string" ? payload.data.message : "",
      ...(serverTime === undefined ? {} : { serverTime }),
      // 保留既有结果字段兼容其他调用方；营销提示不再据此推导文案。
      ...(Number.isFinite(failureEndsAt) ? { failureEndsAt } : {}),
    };
  }
  const plan = payload.data.plan;
  return {
    success: true,
    code,
    message: payload.msg?.trim() ?? "",
    ...(serverTime === undefined ? {} : { serverTime }),
    plan: {
      userPlanId: plan.user_plan_id?.trim() ?? "",
      planId: plan.plan_id?.trim() || request.planId,
      status: plan.status?.trim() ?? "",
      ...(Number.isFinite(plan.starts_at) ? { startsAt: plan.starts_at } : {}),
      ...(Number.isFinite(plan.ends_at) ? { endsAt: plan.ends_at } : {}),
      entitlements: (plan.entitlements ?? []).flatMap((entitlement) => {
        const entitlementId = entitlement.entitlement_id?.trim() ?? "";
        if (!entitlementId) return [];
        return [
          {
            entitlementId,
            showName: entitlement.show_name?.trim() ?? "",
            ...(Number.isFinite(entitlement.effective_at)
              ? { effectiveAt: entitlement.effective_at }
              : {}),
          },
        ];
      }),
    },
  };
}
