import type {
  ApiClient,
  CodingPlanBillingDiscountConfig,
  CodingPlanStaticProductsConfig,
  CodingPlanStaticTeamProductsConfig,
  CodingPlanSubscriptionProviderId,
  EnterpriseCodingPlanProjectApiKeyUnavailableReason,
  ForceUpdateConfig,
  RequestVerificationClientConfig,
  StartPlanPreviewConfig,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import type { ICredentialService } from "../../credential/credential.js";

export interface RemoteEnvelope<T> {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: T | null;
}

export interface ManualClaimPlanPreviewPayload {
  server_time?: number;
  plans?: Array<{
    plan_id?: string;
    name?: string;
    description?: string;
    priority?: number;
    entitlements?: Array<{
      entitlement_id?: string;
      show_name?: string;
      meter?: string;
      unit_type?: string;
      capabilities?: string[];
      grant_units?: number;
      period?: string;
      priority?: number;
      effective_at?: number;
    }>;
  }>;
}

export interface ManualClaimPlanClaimPayload {
  server_time?: number;
  message?: unknown;
  plan?: {
    user_plan_id?: string;
    plan_id?: string;
    status?: string;
    starts_at?: number;
    ends_at?: number;
    entitlements?: Array<{
      entitlement_id?: string;
      show_name?: string;
      effective_at?: number;
    }>;
  };
}

export interface ZCodeClientConfigEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    configs?:
      | (RequestVerificationClientConfig & {
          forceUpdate?: ForceUpdateConfig | null;
          codingPlanBillingDiscount?: CodingPlanBillingDiscountConfig;
          codingPlanStaticProducts?: CodingPlanStaticProductsConfig;
          codingPlanStaticTeamProducts?: CodingPlanStaticTeamProductsConfig;
          startPlanPreview?: StartPlanPreviewConfig | null;
          // 闲时任务灰度（服务端）：内层字段服务端为 snake_case，与外层 camelCase 混排。
          offPeak?: {
            enable_offpeak_task?: boolean;
          } | null;
          modelContextBudget?: {
            strategy?: unknown;
          } | null;
          // 动态工作流灰度：mode 的取值域由
          // shared 的 normalizeDynamicWorkflowMode 裁决，这里保持 unknown，不在类型层假设服务端合法。
          dynamicWorkflow?: {
            mode?: unknown;
          } | null;
        })
      | null;
  } | null;
}

export interface BigModelCodingPlanSubscriptionProviderOptions {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
}

export interface TeamPlanProjectApiKeyPrewarmStatus {
  status: "available" | "unavailable";
  reason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason;
  message?: string | null;
}

export interface CodingPlanEndpointConfig {
  providerId: CodingPlanSubscriptionProviderId;
  host: string;
  headers: Record<string, string>;
}

export interface BigModelCustomerInfoResponse {
  organizations?: Array<{
    organizationId?: string | null;
    organizationName?: string | null;
    projects?: Array<{
      projectId?: string | null;
      projectName?: string | null;
      projectType?: number | string | null;
    }> | null;
  }> | null;
}
