/**
 * BigModel 用量 provider 的领域类型。
 *
 * 鉴权、Team Plan 上下文与 Coding Plan reset 授权结果由 provider 与 HTTP 层共用，
 * 单独成模块避免 provider 与传输实现互相导入。
 */
import type { ApiClient, ProviderFamilyDomain } from "@zcode/shared";
import type { ICredentialService } from "../../../credential/credential.js";
import type { IAccountRequestAuthService } from "../../../model-provider/accountRequestAuthService.js";
import type { ZaiStartPlanBalanceEnvelope } from "../../../model-provider/zaiStartPlanBilling.js";
import type { OfficialMcpCredentialSource } from "../zcodeMcpQuotaProvider.js";

export interface UsageApiAuthorizationRequest {
  readonly preferredProviderId?: string;
  readonly requirePreferredProvider: boolean;
}

export interface UsageApiAuthorization {
  readonly authorization: string;
  readonly quotaUrl: string;
  readonly provider: ResolvedQuotaAuthorization["provider"];
}

export interface BigModelUsageQuotaProviderOptions {
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /**
   * 官方 Server MCP 的凭证来源。缺省时 entitlement 快照的 mcpQuota 恒为 null，
   * 既有装配（含单测）无需改动即可保持原行为。
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

export interface ResolvedQuotaAuthorization {
  authorization: string;
  quotaUrl: string;
  teamContext: TeamPlanContext | null;
  provider: {
    id: string;
    name: string;
  };
}

export interface TeamPlanContext {
  organizationId: string;
  projectId: string;
  // Team Plan 用量查询在 zai/bigmodel 两个 family 上对称存在，
  // 但复制团队项目 API Key 的 host、OAuth token key、鉴权 header 都按 family 分离。
  // 这里必须带上 family，下游 resolveTeamPlanProjectApiKey 才能选对 zai/bigmodel 的业务域名和 token。
  family: ProviderFamilyDomain;
}

export interface CodingPlanResetAuthorization {
  zcodeAuthorization: string;
  codingPlanAuthorization: string;
  teamContext: TeamPlanContext | null;
}

// 直接复用响应类型，避免本地副本遗漏新 bucket/周期字段。
export type ZaiStartPlanBalance = NonNullable<
  NonNullable<ZaiStartPlanBalanceEnvelope["data"]>["balances"]
>[number];
