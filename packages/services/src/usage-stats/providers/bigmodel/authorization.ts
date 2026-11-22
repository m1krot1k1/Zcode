/**
 * BigModel 用量 provider 的鉴权解析。
 *
 * 从 provider.ts 的 `private resolveAuthorization` 原样搬出：同一顺序检查 env
 * API key、coding-plan 账户访问和显式 API 授权，调用方通过 deps 注入凭据服务。
 */
import { isCodingPlanModelProviderId } from "@zcode/shared";
import type { UsageEntitlementRequest, ZCodeAccountAccess } from "@zcode/shared";
import type { IAccountRequestAuthService } from "../../../model-provider/accountRequestAuthService.js";
import { readEnv } from "../../../oauth/providers/configUtils.js";
import {
  buildBigModelQuotaUrl,
  resolveAccountProviderLabel,
  resolveAccountProviderQuotaUrl,
  resolveQuotaUrlFromEnv,
} from "./http.js";
import { resolveTeamPlanContext } from "./quotaMapping.js";
import type { BigModelUsageQuotaProviderOptions, ResolvedQuotaAuthorization } from "./types.js";

export interface BigModelAuthorizationDeps {
  env: NodeJS.ProcessEnv;
  accountRequestAuthService: Pick<IAccountRequestAuthService, "resolveCurrent">;
  resolveApiAuthorization?: BigModelUsageQuotaProviderOptions["resolveApiAuthorization"];
  resolveRequestAccountAccess: (
    accountAccess: UsageEntitlementRequest["accountAccess"],
  ) => Promise<ZCodeAccountAccess | undefined>;
}

export async function resolveBigModelAuthorization(
  deps: BigModelAuthorizationDeps,
  request: {
    preferredProviderId?: string;
    accountAccess?: UsageEntitlementRequest["accountAccess"];
    requirePreferredProvider?: boolean;
    allowEnvApiKey?: boolean;
  } = {},
): Promise<ResolvedQuotaAuthorization | null> {
  if (request.allowEnvApiKey !== false && request.requirePreferredProvider !== true) {
    const envApiKey =
      readEnv(deps.env, "ZCODE_BIGMODEL_USAGE_API_KEY") ??
      readEnv(deps.env, "BIGMODEL_USAGE_API_KEY");
    if (envApiKey) {
      return {
        authorization: envApiKey,
        quotaUrl: resolveQuotaUrlFromEnv(deps.env) ?? buildBigModelQuotaUrl(deps.env),
        teamContext: null,
        provider: {
          id: "env:bigmodel-usage",
          name: "BigModel",
        },
      };
    }
  }

  const providerId = request.preferredProviderId?.trim() ?? "";
  const accountAccess = await deps.resolveRequestAccountAccess(request.accountAccess);
  if (providerId && isCodingPlanModelProviderId(providerId)) {
    if (!accountAccess) return null;
    const auth = await deps.accountRequestAuthService.resolveCurrent({
      providerId,
      accountAccess,
      reason: "usage",
    });
    const authorization = auth.apiKey?.trim() ?? "";
    if (!authorization) return null;
    return {
      authorization,
      quotaUrl:
        resolveQuotaUrlFromEnv(deps.env) ?? resolveAccountProviderQuotaUrl(providerId, deps.env),
      teamContext: resolveTeamPlanContext(accountAccess),
      provider: {
        id: providerId,
        name: resolveAccountProviderLabel(providerId),
      },
    };
  }

  const apiAuthorization = await deps.resolveApiAuthorization?.({
    preferredProviderId: providerId || undefined,
    requirePreferredProvider: request.requirePreferredProvider === true,
  });
  return apiAuthorization ? { ...apiAuthorization, teamContext: null } : null;
}
