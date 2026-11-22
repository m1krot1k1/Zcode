import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZAI_PROVIDER_ID,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_VERSION,
  createDynamicWorkflowClientConfig,
  isZaiCodingPlanProviderId,
  normalizeDynamicWorkflowMode,
  readRequestVerificationConfig,
  resolveBigModelApiOrigin,
  resolveDynamicWorkflowClientConfig,
  type ApiClient,
  type CodingPlanAgreementResponse,
  type CodingPlanBatchPreviewRequest,
  type CodingPlanBatchPreviewResponse,
  type CodingPlanBillingDiscountConfig,
  type CodingPlanCreateSignRequest,
  type CodingPlanPaymentCheckRequest,
  type CodingPlanPaymentCheckResponse,
  type CodingPlanPaypalSetupTokenRequest,
  type CodingPlanPaypalSetupTokenResponse,
  type CodingPlanPaypalSubscribeRequest,
  type CodingPlanPaypalSubscribeResponse,
  type CodingPlanPaypalSupportRequest,
  type CodingPlanPaypalSupportResponse,
  type CodingPlanPendingOrderCheckResponse,
  type CodingPlanPreviewRequest,
  type CodingPlanPreviewResponse,
  type CodingPlanProductInfo,
  type CodingPlanProductInfoRequest,
  type CodingPlanStaticProductsConfig,
  type CodingPlanStaticTeamProductsConfig,
  type CodingPlanStripeBindRequest,
  type CodingPlanStripeBindResponse,
  type CodingPlanStripeCard,
  type CodingPlanStripePayRequest,
  type CodingPlanStripePayResponse,
  type CodingPlanStripeUnbindRequest,
  type CodingPlanSubscriptionProviderId,
  type CodingPlanUpdateSignRequest,
  type DynamicWorkflowClientConfig,
  type EnterpriseCodingPlanBalanceResponse,
  type EnterpriseCodingPlanCancelOrderRequest,
  type EnterpriseCodingPlanCancelOrderResponse,
  type EnterpriseCodingPlanContinuePayRequest,
  type EnterpriseCodingPlanCreateOrderRequest,
  type EnterpriseCodingPlanCreateOrderResponse,
  type EnterpriseCodingPlanOrderCalculateRequest,
  type EnterpriseCodingPlanOrderCalculateResponse,
  type EnterpriseCodingPlanOrderStatusRequest,
  type EnterpriseCodingPlanOrderStatusResponse,
  type EnterpriseCodingPlanPendingOrder,
  type EnterpriseCodingPlanPricingRequest,
  type EnterpriseCodingPlanPricingResponse,
  type ForceUpdateConfig,
  type ManualClaimPlanClaimRequest,
  type ManualClaimPlanClaimResult,
  type ManualClaimPlanPreviewSnapshot,
  type RequestVerificationConfig,
  type StartPlanPreviewConfig,
  type ZCodeModelContextBudgetStrategy,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import { ensureBigModelTeamPlanProjectApiKeyWithStatus } from "#src/bigmodel/teamPlanApiKey.js";
import type { OffPeakClientConfig } from "../codingPlanSubscription.js";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import {
  resolveCodingPlanClientConfigUrl,
  unwrapClientConfigBillingDiscount,
  unwrapClientConfigForceUpdate,
  unwrapClientConfigProducts,
  unwrapClientConfigStartPlanPreview,
  unwrapClientConfigTeamProducts,
} from "./clientConfig.js";
import {
  BIGMODEL_CODING_PLAN_API_PREFIX,
  CLIENT_CONFIG_CACHE_TTL_MS,
  CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED,
  REQUEST_TIMEOUT_MS,
  ZAI_CODING_PLAN_PAY_API_PREFIX,
  ZCODE_JWT_TOKEN_KEY,
} from "./constants.js";
import {
  createBigModelLoginAuthHeaders,
  createZaiLoginAuthHeaders,
  resolveBigModelEnterpriseHost,
  resolveCodingPlanHost,
  resolvePreviewPath,
  resolveZaiCodingPlanHost,
} from "./endpoints.js";
import { fetchManualClaimPlanPreviews, submitManualPlanClaim } from "./manualClaim.js";
import { resolveOffPeakClientConfig } from "./offPeak.js";
import {
  applyTeamPlanProjectApiKeyStatuses,
  collectSubscribedTeamPlanProjectContexts,
  createTeamPlanProjectApiKeyPrewarmStatusFromEnsureResult,
  createTeamPlanProjectStatusKey,
  resolveBigModelTeamProjects,
  resolveFallbackEnterpriseTeamPlanProduct,
  resolveProductTeamProjects,
} from "./teamPlanProjects.js";
import {
  assertZaiPaymentProvider,
  dropUndefined,
  readCodingPlanApiJson,
  resolveClientPlatformKey,
  unwrapEnvelope,
} from "./transport.js";
import type {
  BigModelCustomerInfoResponse,
  BigModelCodingPlanSubscriptionProviderOptions,
  CodingPlanEndpointConfig,
  RemoteEnvelope,
  TeamPlanProjectApiKeyPrewarmStatus,
  ZCodeClientConfigEnvelope,
} from "./types.js";

const log = createServiceLogger("codingPlanSubscription");
export class BigModelCodingPlanSubscriptionProvider {
  protected readonly apiClient: ApiClient;
  protected readonly credentialService: Pick<ICredentialService, "load">;
  private readonly resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  private clientConfigSnapshot: ZCodeClientConfigEnvelope | null = null;
  private clientConfigSnapshotExpiresAt = 0;
  private clientConfigRequest: Promise<ZCodeClientConfigEnvelope> | null = null;
  constructor(options: BigModelCodingPlanSubscriptionProviderOptions) {
    this.apiClient = options.apiClient;
    this.credentialService = options.credentialService;
    this.resolveOffPeakModelSelectionView = options.resolveOffPeakModelSelectionView;
  }

  // ─────────── family 维度抽象（供 ZaiCodingPlanSubscriptionProvider 覆盖）───────────
  // 原 enterprise 读方法（getEnterprisePricing / enrichEnterprisePricingTeamProjects 等）
  // 把 family 硬编码成 bigmodel：providerId=bigmodelCodingPlan、host=resolveBigModelApiOrigin、
  // token=loadBigModelAccessToken。zai family 对称化时无法复用。
  // 这里把 family 维度抽成 protected 虚方法，bigmodel 默认实现保持原行为，zai 子类覆盖即可。

  /** 当前 family 的 Coding Plan providerId（bigmodelCodingPlan / zaiCodingPlan）。 */
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
  }

  /** 当前 family 的业务域名（bigmodel 域 / zai 域）。 */
  protected resolveFamilyEnterpriseHost(): string {
    return resolveBigModelApiOrigin(process.env);
  }

  /** 当前 family 的业务 OAuth token。 */
  protected async loadFamilyEnterpriseToken(): Promise<string> {
    return this.loadBigModelAccessToken();
  }

  /** 当前 family 的业务鉴权头。 */
  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
    return createBigModelLoginAuthHeaders(token);
  }

  async batchPreview(
    request: CodingPlanBatchPreviewRequest = {},
  ): Promise<CodingPlanBatchPreviewResponse> {
    return this.post<CodingPlanBatchPreviewResponse>(request.providerId, "/pay/batch-preview", {
      invitationCode: request.invitationCode,
    });
  }

  async getStaticProducts(): Promise<CodingPlanStaticProductsConfig> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigProducts(payload);
  }

  async getStaticTeamProducts(): Promise<CodingPlanStaticTeamProductsConfig> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigTeamProducts(payload);
  }

  async getStartPlanPreview(): Promise<StartPlanPreviewConfig | null> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigStartPlanPreview(payload);
  }

  async getManualClaimPlanPreviews(): Promise<ManualClaimPlanPreviewSnapshot> {
    return fetchManualClaimPlanPreviews(this.apiClient, this.credentialService);
  }

  async claimManualPlan(request: ManualClaimPlanClaimRequest): Promise<ManualClaimPlanClaimResult> {
    return submitManualPlanClaim(this.apiClient, this.credentialService, request);
  }

  /**
   * 闲时任务灰度配置：复用 client/configs 通道零新增请求。
   * forceRefresh 供"打开 Automations 入口补拉"（1h 快照否则灰度翻转最长 1h 不可见）。
   */
  async getOffPeakClientConfig(options?: { forceRefresh?: boolean }): Promise<OffPeakClientConfig> {
    if (process.env["ZCODE_OFFPEAK_MOCK"] === "1") {
      // mock 已经明确替代远端曝光配置，不能再先等待 /client/configs：
      // 离线 Desktop E2E 会一直停在 Loading，根本无法进入闲时执行链。
      const modelSelectionView = await this.resolveOffPeakModelSelectionView?.();
      return resolveOffPeakClientConfig({}, process.env, modelSelectionView);
    }
    if (options?.forceRefresh) {
      this.clientConfigSnapshot = null;
      this.clientConfigSnapshotExpiresAt = 0;
    }
    const payload = await this.getClientConfigs();
    const modelSelectionView = await this.resolveOffPeakModelSelectionView?.();
    return resolveOffPeakClientConfig(payload, process.env, modelSelectionView);
  }

  /**
   * 动态工作流灰度快照：与闲时任务同走
   * client/configs，零新增请求。三条边界：
   *   1. 本地覆盖（ZCODE_DYNAMIC_WORKFLOW_MODE）在任何网络动作之前裁决，命中即返回——
   *      preview 构建和开发者手测因此不受 1h 快照与首次 Host 竞态影响；
   *   2. forceRefresh 与 Off-Peak 同义，清掉快照后重拉（灰度翻转最长 1h 不可见）；
   *   3. 请求失败 fail-closed：返回 default（disabled）并 warn，绝不把异常抛给调用方——
   *      调用方在 session create/client 就绪路径上，灰度读失败不能阻断普通聊天。
   */
  async getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig> {
    // 覆盖合法即短路：判据（normalize）与快照构造（resolve）都留在 shared，这里不复述取值域。
    if (normalizeDynamicWorkflowMode(process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV])) {
      return resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env });
    }
    if (options?.forceRefresh) {
      this.clientConfigSnapshot = null;
      this.clientConfigSnapshotExpiresAt = 0;
    }
    try {
      const payload = await this.getClientConfigs();
      return resolveDynamicWorkflowClientConfig({
        remote: payload.data?.configs?.dynamicWorkflow,
        env: process.env,
      });
    } catch (error) {
      log.warn(undefined, "动态工作流灰度配置读取失败，按关闭处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
    }
  }

  async getModelContextBudgetStrategy(): Promise<ZCodeModelContextBudgetStrategy> {
    // 3.12.2：预算统一为 preflight-v1；保留兼容方法，但不能再为每次建会话等待远端配置。
    return DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
  }

  async getBillingDiscount(): Promise<CodingPlanBillingDiscountConfig | undefined> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigBillingDiscount(payload);
  }

  async getRequestVerificationConfig(): Promise<RequestVerificationConfig | null> {
    return readRequestVerificationConfig((await this.getClientConfigs()).data?.configs);
  }

  async getForceUpdateConfig(): Promise<ForceUpdateConfig | null> {
    const payload = await this.getClientConfigs();
    return unwrapClientConfigForceUpdate(payload);
  }

  async preview(request: CodingPlanPreviewRequest): Promise<CodingPlanPreviewResponse> {
    return this.post<CodingPlanPreviewResponse>(
      request.providerId,
      resolvePreviewPath(request.providerId),
      {
        productId: request.productId,
        invitationCode: request.invitationCode,
        imRef: request.imRef ?? null,
        ticket: request.ticket ?? null,
        randstr: request.randstr ?? null,
        // Coding Plan 试算接口默认按 Maas 渠道处理，不显式标记会丢失 zcode 来源归因。
        salesChannel: request.salesChannel ?? "zcode",
      },
    );
  }

  async productInfo(request: CodingPlanProductInfoRequest): Promise<CodingPlanProductInfo> {
    const url = new URL(
      `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/product/info`,
    );
    url.searchParams.set("productId", request.productId);
    return this.get<CodingPlanProductInfo>(request.providerId, url);
  }

  async createSign(request: CodingPlanCreateSignRequest): Promise<CodingPlanAgreementResponse> {
    if (request.providerId && isZaiCodingPlanProviderId(request.providerId)) {
      throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
    }

    return this.post<CodingPlanAgreementResponse>(request.providerId, "/pay/create-sign", {
      bizId: request.bizId,
      payType: request.payType ?? "ALI",
      invitationCode: request.invitationCode,
      renew: request.renew ?? null,
      isDelay: request.isDelay ?? 0,
      effectiveTime: request.effectiveTime ?? null,
    });
  }

  async updateSign(request: CodingPlanUpdateSignRequest): Promise<CodingPlanAgreementResponse> {
    if (request.providerId && isZaiCodingPlanProviderId(request.providerId)) {
      throw new Error(CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED);
    }

    return this.post<CodingPlanAgreementResponse>(request.providerId, "/pay/product/update/sign", {
      bizId: request.bizId,
      payType: request.payType ?? "ALI",
    });
  }

  async checkPayment(
    request: CodingPlanPaymentCheckRequest,
  ): Promise<CodingPlanPaymentCheckResponse> {
    const url = new URL(
      `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/pay/check`,
    );
    url.searchParams.set("bizId", request.bizId);
    const status = await this.get<string>(request.providerId, url);
    return { status };
  }

  async checkPendingOrders(
    request: {
      providerId?: CodingPlanSubscriptionProviderId;
    } = {},
  ): Promise<CodingPlanPendingOrderCheckResponse> {
    return this.get<CodingPlanPendingOrderCheckResponse>(
      request.providerId,
      new URL(
        `${resolveCodingPlanHost(request.providerId)}${BIGMODEL_CODING_PLAN_API_PREFIX}/pay/check-pending-orders`,
      ),
    );
  }

  async queryStripeCards(
    request: {
      providerId?: CodingPlanSubscriptionProviderId;
    } = {},
  ): Promise<CodingPlanStripeCard[]> {
    return this.getZaiPay<CodingPlanStripeCard[]>(request.providerId, "/stripe/query");
  }

  async bindStripeCard(
    request: CodingPlanStripeBindRequest,
  ): Promise<CodingPlanStripeBindResponse> {
    return this.postZaiPay<CodingPlanStripeBindResponse>(request.providerId, "/stripe/bind", {
      paymentMethodId: request.paymentMethodId,
      returnUrl: request.returnUrl,
      trackingContext: request.trackingContext,
    });
  }

  async unbindStripeCard(request: CodingPlanStripeUnbindRequest): Promise<string> {
    return this.postZaiPay<string>(request.providerId, "/stripe/unbind", {
      paymentMethodId: request.paymentMethodId,
    });
  }

  async payStripe(request: CodingPlanStripePayRequest): Promise<CodingPlanStripePayResponse> {
    return this.postZaiPay<CodingPlanStripePayResponse>(request.providerId, "/stripe/pay", {
      productId: request.productId,
      paymentMethodId: request.paymentMethodId,
      isSubscribe: request.isSubscribe ?? true,
      returnUrl: request.returnUrl,
      channelCode: request.channelCode,
      estimatePayAmount: request.estimatePayAmount,
      invitationCode: request.invitationCode,
      bizId: request.bizId,
      renew: request.renew ?? false,
    });
  }

  async checkPaypalSupport(
    request: CodingPlanPaypalSupportRequest = {},
  ): Promise<CodingPlanPaypalSupportResponse> {
    return this.getZaiPay<CodingPlanPaypalSupportResponse>(request.providerId, "/paypal/isSupport");
  }

  async createPaypalSetupToken(
    request: CodingPlanPaypalSetupTokenRequest,
  ): Promise<CodingPlanPaypalSetupTokenResponse> {
    return this.postZaiPay<CodingPlanPaypalSetupTokenResponse>(
      request.providerId,
      "/paypal/setupToken",
      {
        returnUrl: request.returnUrl,
        cancelUrl: request.cancelUrl,
      },
    );
  }

  async subscribePaypal(
    request: CodingPlanPaypalSubscribeRequest,
  ): Promise<CodingPlanPaypalSubscribeResponse> {
    return this.postZaiPay<CodingPlanPaypalSubscribeResponse>(
      request.providerId,
      "/paypal/subscribe",
      {
        productId: request.productId,
        productDesc: request.productDesc,
        setupTokenId: request.setupTokenId,
        amount: request.amount,
        isSubscribe: request.isSubscribe ?? true,
        estimatePayAmount: request.estimatePayAmount,
        invitationCode: request.invitationCode,
        bizId: request.bizId,
        channelCode: request.channelCode,
      },
    );
  }

  async getEnterprisePricing(
    request: EnterpriseCodingPlanPricingRequest = {},
  ): Promise<EnterpriseCodingPlanPricingResponse> {
    const providerId = this.codingPlanProviderId();
    const host = this.resolveFamilyEnterpriseHost();
    if (request.authenticated === false) {
      const payload = await readCodingPlanApiJson<
        RemoteEnvelope<EnterpriseCodingPlanPricingResponse>
      >(
        this.apiClient,
        `${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/campaign/partner/enterprise/pricing`,
        {
          method: "GET",
          timeoutMs: REQUEST_TIMEOUT_MS,
        },
      );
      return unwrapEnvelope(payload, providerId);
    }

    const response = await this.get<EnterpriseCodingPlanPricingResponse>(
      providerId,
      new URL(`${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/pricing`),
    );
    return this.enrichEnterprisePricingTeamProjects(response);
  }

  async getEnterpriseBalance(): Promise<EnterpriseCodingPlanBalanceResponse> {
    return this.get<EnterpriseCodingPlanBalanceResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      new URL(
        `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/balance`,
      ),
    );
  }

  async calculateEnterpriseOrder(
    request: EnterpriseCodingPlanOrderCalculateRequest,
  ): Promise<EnterpriseCodingPlanOrderCalculateResponse> {
    return this.post<EnterpriseCodingPlanOrderCalculateResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "/subscription/enterprise/v2/order/calculate",
      { ...request },
    );
  }

  async createEnterpriseOrder(
    request: EnterpriseCodingPlanCreateOrderRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse> {
    return this.post<EnterpriseCodingPlanCreateOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      "/subscription/enterprise/v2/order",
      { ...request },
    );
  }

  async getEnterprisePendingOrders(): Promise<EnterpriseCodingPlanPendingOrder[]> {
    const url = new URL(
      `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/orders/pending`,
    );
    return this.get<EnterpriseCodingPlanPendingOrder[]>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      url,
    );
  }

  async cancelEnterpriseOrder(
    request: EnterpriseCodingPlanCancelOrderRequest,
  ): Promise<EnterpriseCodingPlanCancelOrderResponse> {
    return this.post<EnterpriseCodingPlanCancelOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      `/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/cancel`,
      {},
    );
  }

  async continueEnterpriseOrderPayment(
    request: EnterpriseCodingPlanContinuePayRequest,
  ): Promise<EnterpriseCodingPlanCreateOrderResponse> {
    return this.post<EnterpriseCodingPlanCreateOrderResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      `/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/pay`,
      {},
    );
  }

  async checkEnterpriseOrderStatus(
    request: EnterpriseCodingPlanOrderStatusRequest,
  ): Promise<EnterpriseCodingPlanOrderStatusResponse> {
    const url = new URL(
      `${resolveBigModelEnterpriseHost()}${BIGMODEL_CODING_PLAN_API_PREFIX}/subscription/enterprise/v2/order/${encodeURIComponent(request.orderNo)}/status`,
    );
    return this.get<EnterpriseCodingPlanOrderStatusResponse>(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      url,
    );
  }

  private async post<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${BIGMODEL_CODING_PLAN_API_PREFIX}${path}`,
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
        body: JSON.stringify(dropUndefined(body)),
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async get<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    url: URL,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(this.apiClient, url, {
      method: "GET",
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: endpoint.headers,
    });
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async postZaiPay<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    assertZaiPaymentProvider(endpoint.providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${ZAI_CODING_PLAN_PAY_API_PREFIX}${path}`,
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
        body: JSON.stringify(dropUndefined(body)),
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async getZaiPay<T>(
    providerId: CodingPlanSubscriptionProviderId | undefined,
    path: string,
  ): Promise<T> {
    const endpoint = await this.resolveEndpointConfig(providerId);
    assertZaiPaymentProvider(endpoint.providerId);
    const payload = await readCodingPlanApiJson<RemoteEnvelope<T>>(
      this.apiClient,
      `${endpoint.host}${ZAI_CODING_PLAN_PAY_API_PREFIX}${path}`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: endpoint.headers,
      },
    );
    return unwrapEnvelope(payload, endpoint.providerId);
  }

  private async getClientConfigs(): Promise<ZCodeClientConfigEnvelope> {
    if (this.clientConfigSnapshot && this.clientConfigSnapshotExpiresAt > Date.now()) {
      return this.clientConfigSnapshot;
    }
    if (this.clientConfigRequest) {
      return await this.clientConfigRequest;
    }

    // client/configs 和其他 ZCode 平台接口必须共享运行时 endpoint；
    // E2E/测试环境会通过 ZCODE_BASE_URL 指向本地 mock，硬编码线上域名会让套餐状态不可控。
    const url = resolveCodingPlanClientConfigUrl(process.env);
    url.searchParams.set("app_version", ZCODE_VERSION);
    url.searchParams.set("platform", resolveClientPlatformKey());
    // StartPlanCard 和套餐列表都来自同一个 client/configs。
    // 同屏分别读取 preview/products 时必须合并请求，避免未登录设置页重复打远端配置。
    this.clientConfigRequest = readCodingPlanApiJson<ZCodeClientConfigEnvelope>(
      this.apiClient,
      url,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    try {
      const payload = await this.clientConfigRequest;
      this.clientConfigSnapshot = payload;
      this.clientConfigSnapshotExpiresAt = Date.now() + CLIENT_CONFIG_CACHE_TTL_MS;
      return payload;
    } finally {
      this.clientConfigRequest = null;
    }
  }

  private async resolveEndpointConfig(
    providerId: CodingPlanSubscriptionProviderId | undefined,
  ): Promise<CodingPlanEndpointConfig> {
    const normalizedProviderId =
      providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
    if (isZaiCodingPlanProviderId(normalizedProviderId)) {
      const authorization = await this.loadZaiAuthorization();
      return {
        providerId: normalizedProviderId,
        host: resolveZaiCodingPlanHost(),
        headers: createZaiLoginAuthHeaders(authorization),
      };
    }

    const token = await this.loadBigModelAccessToken();
    return {
      providerId: normalizedProviderId,
      host: resolveBigModelApiOrigin(process.env),
      headers: createBigModelLoginAuthHeaders(token),
    };
  }

  private async loadBigModelAccessToken(): Promise<string> {
    const token = (
      await this.credentialService.load(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!token) {
      throw new Error("bigmodel_oauth_required");
    }
    const zcodeJwtToken = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim();
    if (zcodeJwtToken && token === zcodeJwtToken) {
      // 旧版 BigModel OAuth callback 曾把 zcode JWT 同时写进
      // oauth:bigmodel:access_token，付费套餐预览会拿它去打 bigmodel.cn 并报令牌过期。
      // 这里在服务边界拦截旧污染状态，避免继续向 BigModel 业务接口发送错误凭据。
      log.warn(undefined, "BigModel access token is stale zcode JWT; login required");
      throw new Error("bigmodel_oauth_required");
    }
    return token;
  }

  protected async enrichEnterprisePricingTeamProjects(
    response: EnterpriseCodingPlanPricingResponse,
  ): Promise<EnterpriseCodingPlanPricingResponse> {
    if (response.productList.length === 0) {
      return response;
    }
    const hasSubscribedProduct = response.productList.some(
      (product) => product.subscribed === true,
    );
    const hasSubscribedProductMissingProjectContext = response.productList.some(
      (product) =>
        product.subscribed === true &&
        (!product.projectId?.trim() || !product.organizationId?.trim()),
    );
    if (hasSubscribedProduct && !hasSubscribedProductMissingProjectContext) {
      const apiKeyStatuses = await this.ensureSubscribedTeamPlanProjectApiKeys(
        response,
        await this.loadFamilyEnterpriseToken(),
      );
      return applyTeamPlanProjectApiKeyStatuses(response, apiKeyStatuses);
    }

    const token = await this.loadFamilyEnterpriseToken();
    const host = this.resolveFamilyEnterpriseHost();
    const customerInfo = await readCodingPlanApiJson<RemoteEnvelope<BigModelCustomerInfoResponse>>(
      this.apiClient,
      `${host}${BIGMODEL_CODING_PLAN_API_PREFIX}/customer/getCustomerInfo`,
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: this.createFamilyEnterpriseAuthHeaders(token),
      },
    );
    const teamProjects = resolveBigModelTeamProjects(customerInfo.data);
    if (teamProjects.length === 0) {
      return response;
    }
    const fallbackSubscribedProductId = hasSubscribedProduct
      ? null
      : (resolveFallbackEnterpriseTeamPlanProduct(response.productList)?.productId ?? null);

    const enrichedResponse = {
      ...response,
      productList: response.productList.map((product) => {
        const shouldEnrichProduct =
          product.subscribed === true ||
          (fallbackSubscribedProductId !== null &&
            product.productId === fallbackSubscribedProductId);
        if (!shouldEnrichProduct) {
          return product;
        }
        const matchedTeamProjects = resolveProductTeamProjects(product, teamProjects);
        if (matchedTeamProjects.length === 0) {
          return product;
        }
        const primaryProject = matchedTeamProjects[0];
        return {
          ...product,
          // 企业 pricing 的 subscribed 商品只返回 productId/tier，不返回 org/project。
          // 有些账号只返回 organizationId，不返回 projectId；必须继续读取 customerInfo.organizations 数组，
          // 并按机构匹配团队项目，否则多机构账号会漏掉真实 Team Plan 连接方式。
          // 另有测试环境账号 pricing 全部返回 subscribed=false，但 customerInfo 已有 projectType=2 团队项目；
          // 此时 customerInfo 是更可靠的已购凭据，需要反向补出当前团队套餐入口。
          organizationId: primaryProject?.organizationId ?? product.organizationId,
          organizationName: primaryProject?.organizationName ?? product.organizationName,
          projectId: primaryProject?.projectId ?? product.projectId,
          projectName: primaryProject?.projectName ?? product.projectName,
          teamProjects: matchedTeamProjects,
          subscribed: true,
        };
      }),
    };
    const apiKeyStatuses = await this.ensureSubscribedTeamPlanProjectApiKeys(
      enrichedResponse,
      token,
    );
    return applyTeamPlanProjectApiKeyStatuses(enrichedResponse, apiKeyStatuses);
  }

  protected async ensureSubscribedTeamPlanProjectApiKeys(
    response: EnterpriseCodingPlanPricingResponse,
    token: string,
  ): Promise<Map<string, TeamPlanProjectApiKeyPrewarmStatus>> {
    const teamContexts = collectSubscribedTeamPlanProjectContexts(response.productList);
    const statuses = new Map<string, TeamPlanProjectApiKeyPrewarmStatus>();
    if (teamContexts.length === 0) {
      return statuses;
    }
    const host = this.resolveFamilyEnterpriseHost();
    log.info(undefined, "Team Plan project api key prewarm started", {
      family: this.codingPlanProviderId(),
      teamProjectCount: teamContexts.length,
    });
    for (const teamContext of teamContexts) {
      try {
        const result = await ensureBigModelTeamPlanProjectApiKeyWithStatus({
          apiClient: this.apiClient,
          authorization: token,
          host,
          teamContext,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        log.info(undefined, "Team Plan project api key prewarm result", {
          family: this.codingPlanProviderId(),
          diagnostics: result.diagnostics,
          organizationId: teamContext.organizationId,
          projectId: teamContext.projectId,
          status: result.status,
        });
        statuses.set(
          createTeamPlanProjectStatusKey(teamContext),
          createTeamPlanProjectApiKeyPrewarmStatusFromEnsureResult(result),
        );
      } catch (error) {
        // 多团队套餐每个项目都需要独立 zcode-team-api-key。
        // 单个团队项目创建失败不能阻断 pricing 返回，否则会让其他团队入口一起不可见。
        log.warn(undefined, "Team Plan project api key prewarm failed", {
          family: this.codingPlanProviderId(),
          organizationId: teamContext.organizationId,
          projectId: teamContext.projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        statuses.set(createTeamPlanProjectStatusKey(teamContext), {
          status: "unavailable",
          reason: "request_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return statuses;
  }

  protected async loadZaiAuthorization(): Promise<string> {
    const token = (
      await this.credentialService.load(`oauth:${ZAI_PROVIDER_ID}:access_token`)
    )?.trim();
    if (!token) {
      throw new Error("zai_oauth_required");
    }

    return token;
  }
}
