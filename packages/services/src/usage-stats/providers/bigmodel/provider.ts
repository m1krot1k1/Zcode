/**
 * BigModel 用量 provider 主体。
 *
 * 只保留方法编排与凭据读取顺序：解析、HTTP 细节、额度映射、monitor 请求
 * 分别位于同目录的独立模块。
 */
import type {
  ApiClient,
  CodingPlanRegularTpsRequest,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
  ZCodeAccountAccess,
} from "@zcode/shared";
import {
  ApiError,
  buildRuntimeZCodeApiUrl,
  isCodingPlanModelProviderId,
  isStartPlanModelProviderId,
} from "@zcode/shared";
import type { ICredentialService } from "../../../credential/credential.js";
import type { IAccountRequestAuthService } from "../../../model-provider/accountRequestAuthService.js";
import { readEnv } from "../../../oauth/providers/configUtils.js";
import {
  buildZaiStartPlanBalanceUrl,
  fetchZaiStartPlanBalanceEnvelope,
  type ZaiStartPlanBalanceEnvelope,
} from "../../../model-provider/zaiStartPlanBilling.js";
import { normalizeLimits, pickPrimaryLimit } from "../bigmodelUsageQuotaMapper.js";
import {
  buildCodingPlanUsageSnapshotFromMonitor,
  buildUsageStatsSnapshotFromMonitor,
} from "../bigmodelUsageMonitorMapper.js";
import type {
  BigModelUsageModelPerformanceEnvelope,
  BigModelUsageModelPerformancePayload,
} from "../bigmodelUsageMonitorMapper.js";
import {
  resolveCodingPlanUsageTimeRange,
  resolveUsageTimeRange,
} from "../bigmodelUsageMonitorRange.js";
import { fetchBigModelSubscriptionSummary } from "../bigmodelSubscriptionProvider.js";
import type { OfficialMcpCredentialSource } from "../zcodeMcpQuotaProvider.js";
import {
  BIGMODEL_OAUTH_ACCESS_TOKEN_KEY,
  CODING_PLAN_RESET_BASE_PATH,
  EMPTY_CREDIT_ACTIVITY_PAYLOAD,
  EMPTY_CREDIT_DETAIL_PAYLOAD,
  EMPTY_MODEL_PERFORMANCE_PAYLOAD,
  EMPTY_MODEL_USAGE_PAYLOAD,
  EMPTY_TOOL_USAGE_PAYLOAD,
  REQUEST_TIMEOUT_MS,
  ZAI_OAUTH_ACCESS_TOKEN_KEY,
  ZCODE_JWT_TOKEN_KEY,
  log,
} from "./constants.js";
import { resolveBigModelAuthorization } from "./authorization.js";
import {
  buildBigModelQuotaUrl,
  buildModelPerformanceMonitorUrl,
  buildZaiQuotaUrl,
  createBigModelUsageHeaders,
  createCodingPlanResetHeaders,
  readApiDiagnosticHeaders,
  readApiErrorMessage,
  readCodingPlanResetApiJson,
  resolveAccountProviderLabel,
  resolveAccountProviderQuotaUrl,
  resolveCodingPlanApiKeyError,
  resolveModelPerformanceTimeRange,
  resolveQuotaUrlFromEnv,
  sanitizeMonitorDiagnosticUrl,
} from "./http.js";
import {
  fetchCreditUsageActivity,
  fetchCreditUsageDetail,
  fetchMcpQuota,
  fetchModelPerformanceDay,
  fetchModelUsage,
  fetchQuota,
  fetchToolUsage,
} from "./monitorRequests.js";
import {
  codingPlanResetEnvelopeSchema,
  codingPlanResetOpportunityDeniedDataSchema,
  codingPlanResetOpportunityGrantedDataSchema,
  codingPlanResetStatusDataSchema,
  codingPlanResetUseDataSchema,
  isSuccessfulBigModelEnvelope,
  readBestEffortBigModelMonitorData,
  readCodingPlanResetEnvelope,
  readCodingPlanResetEnvelopeData,
  readSuccessfulBigModelMonitorData,
} from "./parsing.js";
import {
  buildSubscriptionSnapshot,
  buildUsageEntitlementContext,
  buildUsageEntitlementContextFromRequest,
  buildZaiStartPlanQuota,
  buildZaiStartPlanRemaining,
  buildZaiStartPlanSubscription,
  pickCurrentZaiStartPlan,
  readZaiStartPlanBalances,
  resolveTeamPlanContext,
  summarizeStartPlanBalances,
  summarizeStartPlans,
  warnOnUnattributedStartPlanBuckets,
} from "./quotaMapping.js";
import type {
  BigModelUsageQuotaProviderOptions,
  CodingPlanResetAuthorization,
  ResolvedQuotaAuthorization,
} from "./types.js";

export class BigModelUsageQuotaProvider {
  private readonly apiClient: ApiClient;
  private readonly accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  private readonly resolveApiAuthorization?: BigModelUsageQuotaProviderOptions["resolveApiAuthorization"];
  private readonly credentialService?: Pick<ICredentialService, "load">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly officialMcpCredentialSource?: OfficialMcpCredentialSource;

  constructor(options: BigModelUsageQuotaProviderOptions) {
    this.apiClient = options.apiClient;
    this.accountRequestAuthService = options.accountRequestAuthService;
    this.resolveApiAuthorization = options.resolveApiAuthorization;
    this.credentialService = options.credentialService;
    this.env = options.env ?? process.env;
    this.officialMcpCredentialSource = options.officialMcpCredentialSource;
  }

  async getSnapshot(): Promise<UsageEntitlementSnapshot> {
    return this.getSnapshotForRequest({});
  }

  async getSnapshotForRequest(
    request: UsageEntitlementRequest = {},
  ): Promise<UsageEntitlementSnapshot> {
    // 设置页只能从 Registry 取得静态 family/mode。动态 planKind 与 Team scope
    // 必须在服务边界读取当前账号连接；不能要求 UI 从 Effective Config 伪造动态权益事实。
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    const resolvedRequest: UsageEntitlementRequest = {
      ...request,
      accountAccess,
    };
    if (request.preferredProviderId && isStartPlanModelProviderId(request.preferredProviderId)) {
      return this.getStartPlanSnapshot(
        request.preferredProviderId,
        accountAccess,
        request.invalidateBalanceCache,
      );
    }

    const generatedAt = Date.now();
    const teamContext = accountAccess ? resolveTeamPlanContext(accountAccess) : null;
    const providerId = request.preferredProviderId?.trim() ?? "";
    // 团队权益不以调用 Key 为前置条件；即使 Key 创建/复制失败也保留已确认的订阅。
    const teamEntitlement = teamContext
      ? await fetchBigModelSubscriptionSummary({
          apiClient: this.apiClient,
          authorization: "",
          quotaUrl:
            resolveQuotaUrlFromEnv(this.env) ??
            (teamContext.family === "zai"
              ? buildZaiQuotaUrl(this.env)
              : buildBigModelQuotaUrl(this.env)),
          teamContext,
          businessToken: await this.credentialService?.load(
            `oauth:${teamContext.family}:access_token`,
          ),
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
      : null;
    let resolved: ResolvedQuotaAuthorization | null = null;
    try {
      resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess,
        requirePreferredProvider: request.requirePreferredProvider === true,
        allowEnvApiKey: request.allowEnvApiKey,
      });
    } catch (error) {
      log.warn(undefined, "读取用量凭据失败，保留独立订阅判定", {
        error: error instanceof Error ? error.message : String(error),
        preferredProviderId: providerId,
      });
    }
    const entitlement =
      teamEntitlement ??
      (resolved
        ? await fetchBigModelSubscriptionSummary({
            apiClient: this.apiClient,
            authorization: resolved.authorization,
            quotaUrl: resolved.quotaUrl,
            timeoutMs: REQUEST_TIMEOUT_MS,
          })
        : { kind: "unknown" as const });
    // 订阅未知不能发布为成功空快照，否则 hook 会覆盖同身份已确认权益并清除失败退避。
    // 无凭据的未配置状态仍正常返回；已有查询身份时让统一失败路径保留快照。
    if (entitlement.kind === "unknown" && (resolved || teamContext)) {
      throw new Error("Coding Plan entitlement refresh failed");
    }
    const subscription =
      entitlement.kind !== "available" ? null : buildSubscriptionSnapshot(entitlement.subscription);
    const [payload, mcpQuota] = resolved
      ? await Promise.all([
          fetchQuota(this.apiClient, resolved).catch(() => null),
          fetchMcpQuota(this.apiClient, this.officialMcpCredentialSource, this.env, resolved).catch(
            () => null,
          ),
        ])
      : [null, null];
    // quota 失败或 level 存在都不改变权益；额度耗尽也只影响用量显示。
    const quotaData = payload && isSuccessfulBigModelEnvelope(payload) ? payload.data : null;
    const limits = normalizeLimits(quotaData?.limits);
    const primaryLimit = pickPrimaryLimit(limits);
    if (accountAccess && providerId) {
      await this.accountRequestAuthService.assertCurrent({
        providerId,
        accountAccess,
      });
    }
    return {
      generatedAt,
      authenticated: true,
      ...(entitlement.kind === "available"
        ? {}
        : {
            unavailableReason:
              entitlement.kind === "unavailable"
                ? ("no_plan" as const)
                : resolved || teamContext
                  ? ("unavailable" as const)
                  : ("not_configured" as const),
          }),
      ...(teamEntitlement?.kind === "unavailable" && teamEntitlement.reason
        ? { teamPlanUnavailableReason: teamEntitlement.reason }
        : {}),
      context: resolved
        ? buildUsageEntitlementContext(resolved, subscription)
        : buildUsageEntitlementContextFromRequest(resolvedRequest),
      provider: resolved?.provider ?? null,
      remaining: primaryLimit
        ? {
            count: primaryLimit.remaining ?? 0,
            isShow: true,
            percentage: primaryLimit.percentage,
            nextResetTime: primaryLimit.nextResetTime ?? null,
          }
        : null,
      subscription,
      quota: quotaData ? { level: quotaData.level?.trim() || null, limits } : null,
      mcpQuota,
    };
  }

  private async resolveRequestAccountAccess(
    accountAccess: UsageEntitlementRequest["accountAccess"],
  ): Promise<ZCodeAccountAccess | undefined> {
    if (!accountAccess) return undefined;
    if (!("mode" in accountAccess)) return accountAccess;
    return (await this.accountRequestAuthService.resolveAccessCurrent(accountAccess)) ?? undefined;
  }

  private async getStartPlanSnapshot(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
    invalidateBalanceCache = false,
  ): Promise<UsageEntitlementSnapshot> {
    const generatedAt = Date.now();
    const resolved = await this.resolveStartPlanAuthorization(providerId, accountAccess);
    if (!resolved) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "not_configured",
        context: { scope: "personal" },
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    let balancePayload: ZaiStartPlanBalanceEnvelope;
    try {
      const balanceUrl = buildZaiStartPlanBalanceUrl();
      const balanceStartedAt = Date.now();
      // billing/current 已废弃，balance 会同时返回 plans 与 balances。
      // Start Plan 快照必须只发起一次 balance 请求，避免冷启动重复请求并继续依赖旧接口。
      balancePayload = await fetchZaiStartPlanBalanceEnvelope(
        this.apiClient,
        resolved.authorization,
        invalidateBalanceCache,
      );
      log.info(undefined, "billing/balance 请求完成", {
        balanceCount: balancePayload.data?.balances?.length ?? 0,
        balances: summarizeStartPlanBalances(balancePayload.data?.balances),
        code: balancePayload.code ?? null,
        durationMs: Date.now() - balanceStartedAt,
        msg: balancePayload.msg ?? null,
        payload: balancePayload,
        planCount: balancePayload.data?.plans?.length ?? 0,
        plans: summarizeStartPlans(balancePayload.data?.plans),
        providerId,
        success: balancePayload.code === 0,
        url: balanceUrl,
      });
    } catch (error) {
      log.warn(undefined, "billing/balance 请求失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId,
        responseHeaders: error instanceof ApiError ? (error.responseHeaders ?? null) : null,
        status: error instanceof ApiError ? error.status : null,
        url: buildZaiStartPlanBalanceUrl(),
      });
      // 保留 HTTP 429 等错误信息，让调用方退避并保留已确认的权益。
      throw error;
    }

    if (balancePayload.code !== 0) {
      throw new Error(balancePayload.msg || `Start Plan balance failed: ${balancePayload.code}`);
    }

    const currentPlan = pickCurrentZaiStartPlan(balancePayload.data?.plans);
    if (!currentPlan) {
      return {
        generatedAt,
        authenticated: true,
        unavailableReason: "no_plan",
        startPlanExpired:
          balancePayload.data?.plans?.some((plan) => plan.status?.toLowerCase() === "expired") ??
          false,
        context: { scope: "personal" },
        provider: resolved.provider,
        remaining: null,
        subscription: null,
        quota: null,
      };
    }

    warnOnUnattributedStartPlanBuckets(
      balancePayload.data?.plans,
      readZaiStartPlanBalances(balancePayload),
    );

    return {
      generatedAt,
      authenticated: true,
      context: { scope: "personal" },
      provider: resolved.provider,
      // balance 的服务端时间与本响应的 effective_at 配对，不能用本机时钟覆盖。
      ...(typeof balancePayload.data?.server_time === "number" &&
      Number.isFinite(balancePayload.data.server_time) &&
      balancePayload.data.server_time >= 0
        ? { serverTime: balancePayload.data.server_time * 1_000 }
        : {}),
      remaining: buildZaiStartPlanRemaining(readZaiStartPlanBalances(balancePayload)),
      subscription: buildZaiStartPlanSubscription(balancePayload.data?.plans),
      quota: buildZaiStartPlanQuota(
        readZaiStartPlanBalances(balancePayload),
        balancePayload.data?.plans,
      ),
    };
  }

  private async resolveStartPlanAuthorization(
    providerId: string,
    accountAccess: ZCodeAccountAccess | undefined,
  ): Promise<{
    authorization: string;
    provider: ResolvedQuotaAuthorization["provider"];
  } | null> {
    if (!accountAccess || accountAccess.planKind !== "start-plan") {
      return null;
    }
    let auth;
    try {
      auth = await this.accountRequestAuthService.resolveCurrent({
        providerId,
        accountAccess,
        reason: "usage",
      });
    } catch {
      return null;
    }
    const apiKey = auth.apiKey?.trim() ?? "";
    if (!apiKey) return null;

    return {
      authorization: /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`,
      provider: {
        id: providerId,
        name: resolveAccountProviderLabel(providerId),
      },
    };
  }

  async getUsageStatsSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: request.requirePreferredProvider === true,
      allowEnvApiKey: request.allowEnvApiKey,
    });
    if (!resolved) {
      // 设置页使用统计可被显式收口到 Coding Plan provider。
      // 严格指定 provider 时不允许回退到普通 API Key、环境变量或本地 session 聚合。
      throw new Error("no_bigmodel_api_key");
    }

    const { startTime, endTime } = resolveUsageTimeRange(request);
    const [modelPayload, toolPayload] = await Promise.all([
      fetchModelUsage(this.apiClient, resolved, startTime, endTime),
      fetchToolUsage(this.apiClient, resolved, startTime, endTime),
    ]);

    const modelData = readSuccessfulBigModelMonitorData(
      modelPayload,
      "BigModel model usage failed",
      EMPTY_MODEL_USAGE_PAYLOAD,
    );
    const toolData = readSuccessfulBigModelMonitorData(
      toolPayload,
      "BigModel tool usage failed",
      EMPTY_TOOL_USAGE_PAYLOAD,
      { allowMissingData: true },
    );

    return {
      ...buildUsageStatsSnapshotFromMonitor(request, modelData, toolData),
      sourceProvider: resolved.provider,
    };
  }

  async getCodingPlanResetStatus(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetStatusSnapshot> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/status`),
      {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createCodingPlanResetHeaders(authorization, true),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetStatusDataSchema);
    return {
      availableFiveHourResets: data.available_five_hour_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      availableWeekResets: data.available_week_resets.map((item) => ({
        expireAt: item.expire_at,
      })),
      latestFiveHourResetHistory: data.latest_five_hour_reset_history
        ? { usedAt: data.latest_five_hour_reset_history.used_at }
        : null,
      latestWeekResetHistory: data.latest_week_reset_history
        ? { usedAt: data.latest_week_reset_history.used_at }
        : null,
      hasUnreadHistory: data.has_unread_history,
    };
  }

  async useCodingPlanReset(request: CodingPlanResetUseRequest): Promise<CodingPlanResetUseResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/use`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          ...createCodingPlanResetHeaders(authorization, true),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          reset_type: request.resetType,
        }),
      },
    );
    const data = readCodingPlanResetEnvelopeData(payload, codingPlanResetUseDataSchema);
    return { used: data.used };
  }

  async requestCodingPlanResetOpportunity(
    request: CodingPlanResetOpportunityRequest,
  ): Promise<CodingPlanResetOpportunityResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 64) {
      throw new Error("coding_plan_reset_invalid_idempotency_key");
    }
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    let payload: unknown;
    try {
      payload = await readCodingPlanResetApiJson(
        this.apiClient,
        buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/opportunity`),
        {
          method: "POST",
          timeoutMs: REQUEST_TIMEOUT_MS,
          headers: {
            ...createCodingPlanResetHeaders(authorization, true),
            "content-type": "application/json",
          },
          body: JSON.stringify({ idempotency_key: idempotencyKey }),
        },
        { acceptedBusinessCodes: [3301] },
      );
    } catch (error) {
      // 后端在请求过快/发卡锁竞争时直接回 HTTP 429，不带 3301 信封和 next_try_at。
      // 映射成稳定错误码，客户端据此写兜底冷却，避免 30 秒轮询持续撞限流。
      if (error instanceof ApiError && error.status === 429) {
        throw new Error("coding_plan_reset_opportunity_throttled", {
          cause: error,
        });
      }
      throw error;
    }
    const envelope = codingPlanResetEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new Error("coding_plan_reset_invalid_response");
    }
    // 3301 的 next_try_at 是服务端限流边界，必须完整透传给客户端；
    // 丢弃该字段会让 30 秒轮询持续触发资格判断，绕过后端要求的重试间隔。
    if (envelope.data.code === 3301) {
      const denied = codingPlanResetOpportunityDeniedDataSchema.safeParse(envelope.data.data);
      if (!denied.success) {
        throw new Error("coding_plan_reset_invalid_response");
      }
      return { granted: false, nextTryAt: denied.data.next_try_at };
    }
    const data = readCodingPlanResetEnvelopeData(
      payload,
      codingPlanResetOpportunityGrantedDataSchema,
    );
    return { granted: data.granted, nextTryAt: null };
  }

  async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
    const authorization = await this.resolveCodingPlanResetAuthorization(request);
    const payload = await readCodingPlanResetApiJson(
      this.apiClient,
      buildRuntimeZCodeApiUrl(this.env, `${CODING_PLAN_RESET_BASE_PATH}/history/read`),
      {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        // history/read 使用当前 Coding Plan credential 校验身份，但按用户共享已读游标，不带 target scope。
        headers: createCodingPlanResetHeaders(authorization, false),
      },
    );
    readCodingPlanResetEnvelope(payload);
  }

  private async resolveCodingPlanResetAuthorization(
    request: CodingPlanResetScopeRequest,
  ): Promise<CodingPlanResetAuthorization> {
    const accountAccess = await this.resolveRequestAccountAccess(request.accountAccess);
    if (!accountAccess) {
      throw new Error("coding_plan_reset_account_access_required");
    }
    await this.accountRequestAuthService.assertCurrent({
      providerId: request.preferredProviderId,
      accountAccess,
    });
    const zcodeJwt = (await this.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (!zcodeJwt) {
      throw new Error("coding_plan_reset_zcode_jwt_required");
    }
    // reset 同时支持 Z.ai 与 BigModel Coding Plan。固定读取 oauth:bigmodel:access_token
    // 会让只登录 Z.ai 的用户在请求发出前失败；业务 JWT 必须跟随当前 provider family
    // 精确选择，禁止跨 family 回退。Header 仍按后端契约直传且不套 Bearer。
    const codingPlanJwtKey =
      accountAccess.family === "zai" ? ZAI_OAUTH_ACCESS_TOKEN_KEY : BIGMODEL_OAUTH_ACCESS_TOKEN_KEY;
    const codingPlanJwt = (await this.credentialService?.load(codingPlanJwtKey))?.trim() ?? "";
    if (!codingPlanJwt) {
      throw new Error("coding_plan_reset_maas_jwt_required");
    }
    return {
      zcodeAuthorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
      codingPlanAuthorization: codingPlanJwt,
      teamContext: resolveTeamPlanContext(accountAccess),
    };
  }

  async getCodingPlanUsageSnapshot(
    request: CodingPlanUsageRequest,
  ): Promise<CodingPlanUsageSnapshot> {
    const resolved = await this.resolveAuthorization({
      preferredProviderId: request.preferredProviderId,
      accountAccess: request.accountAccess,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    if (!resolved) {
      // Coding Plan 用量现在直接使用对应 Coding Plan provider 的 API Key。
      // 缺少 key 时不能回退普通 API Key、环境变量、OAuth 或本地 App Usage。
      throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));
    }

    const usageRange = resolveCodingPlanUsageTimeRange(request);
    // monitor 请求不能全有全无。quota 保持原有必须成功语义
    // （传输失败时整体失败，业务失败降级为 quota: null）；activity / detail / health
    // 是可选数据面，传输失败只清空对应区域并记 warn，任一路故障不能拖垮整张面板。
    const [quotaPayload, activityData, modelDetailData, toolDetailData, health7dData] =
      await Promise.all([
        fetchQuota(this.apiClient, resolved),
        readBestEffortBigModelMonitorData(
          fetchCreditUsageActivity(this.apiClient, resolved, request.timeZone),
          "BigModel activity usage failed",
          EMPTY_CREDIT_ACTIVITY_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          fetchCreditUsageDetail(
            this.apiClient,
            resolved,
            usageRange.startTime,
            usageRange.endTime,
            "MODEL",
          ),
          "BigModel model usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          fetchCreditUsageDetail(
            this.apiClient,
            resolved,
            usageRange.startTime,
            usageRange.endTime,
            "MCP",
          ),
          "BigModel tool usage detail failed",
          EMPTY_CREDIT_DETAIL_PAYLOAD,
        ),
        readBestEffortBigModelMonitorData(
          fetchModelPerformanceDay(this.apiClient, resolved, request.timeZone, "7d"),
          "BigModel model performance failed",
          EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        ),
      ]);

    const quota =
      isSuccessfulBigModelEnvelope(quotaPayload) && quotaPayload.data
        ? {
            level: quotaPayload.data.level?.trim() || null,
            limits: normalizeLimits(quotaPayload.data.limits),
          }
        : null;

    return buildCodingPlanUsageSnapshotFromMonitor({
      request,
      provider: resolved.provider,
      quota,
      granularity: usageRange.granularity,
      xTime: usageRange.xTime,
      startDateKey: usageRange.startDateKey,
      endDateKey: usageRange.endDateKey,
      activityData,
      modelDetailData,
      toolDetailData,
      healthData: health7dData,
    });
  }

  async getCodingPlanRegularTps(request: CodingPlanRegularTpsRequest): Promise<number | undefined> {
    const startedAt = Date.now();
    let requestUrl: string | undefined;
    let responseHeaders: Record<string, string> = {};
    let responseStatus: number | undefined;
    let responseStatusText: string | undefined;
    let responseCode: number | undefined;
    try {
      const resolved = await this.resolveAuthorization({
        preferredProviderId: request.preferredProviderId,
        accountAccess: request.accountAccess,
        requirePreferredProvider: true,
        allowEnvApiKey: false,
      });
      if (!resolved) throw new Error(resolveCodingPlanApiKeyError(request.preferredProviderId));

      const timeRange = resolveModelPerformanceTimeRange(request.timeZone, "7d");
      requestUrl = buildModelPerformanceMonitorUrl(
        resolved,
        timeRange.startTime,
        timeRange.endTime,
      );
      const response = await this.apiClient.request(requestUrl, {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: createBigModelUsageHeaders(resolved),
      });
      responseStatus = response.status;
      responseStatusText = response.statusText;
      responseHeaders = readApiDiagnosticHeaders(response.headers) ?? {};
      let payload: BigModelUsageModelPerformanceEnvelope | undefined;
      let parseError: unknown;
      try {
        payload = JSON.parse(await response.text()) as BigModelUsageModelPerformanceEnvelope;
        responseCode = typeof payload.code === "number" ? payload.code : undefined;
      } catch (error) {
        parseError = error;
      }
      if (!response.ok) {
        throw new ApiError({
          message: readApiErrorMessage(payload, `HTTP ${response.status}`),
          url: requestUrl,
          method: "GET",
          status: response.status,
          responseHeaders,
          cause: parseError,
        });
      }
      if (parseError !== undefined || payload === undefined) {
        throw new ApiError({
          message: parseError instanceof Error ? parseError.message : "Invalid JSON response",
          url: requestUrl,
          method: "GET",
          status: response.status,
          responseHeaders,
          cause: parseError,
        });
      }
      const data = readSuccessfulBigModelMonitorData<BigModelUsageModelPerformancePayload>(
        payload,
        "BigModel model performance failed",
        EMPTY_MODEL_PERFORMANCE_PAYLOAD,
        { allowMissingData: true },
      );
      return data.proMaxDecodeSpeed?.findLast((value) => Number.isFinite(value) && value > 0);
    } catch (error) {
      // Bug 原因：Highspeed 仅在 Renderer 记录了 TPS 读取失败文案，Host 层丢失了
      // monitor 的 HTTP status 和 request id，无法与后端日志对账。只输出 ApiError 中的安全诊断头。
      log.warn(undefined, "Highspeed 普通 TPS 健康检查失败", {
        error: error instanceof Error ? error.message : String(error),
        providerId: request.preferredProviderId,
        durationMs: Date.now() - startedAt,
        status: error instanceof ApiError ? error.status : (responseStatus ?? null),
        statusText: responseStatusText ?? null,
        responseCode: responseCode ?? null,
        responseHeaders:
          error instanceof ApiError ? (error.responseHeaders ?? responseHeaders) : responseHeaders,
        url: sanitizeMonitorDiagnosticUrl(error instanceof ApiError ? error.url : requestUrl),
      });
      throw error;
    }
  }

  private async resolveAuthorization(
    request: {
      preferredProviderId?: string;
      accountAccess?: UsageEntitlementRequest["accountAccess"];
      requirePreferredProvider?: boolean;
      allowEnvApiKey?: boolean;
    } = {},
  ): Promise<ResolvedQuotaAuthorization | null> {
    return resolveBigModelAuthorization(
      {
        env: this.env,
        accountRequestAuthService: this.accountRequestAuthService,
        resolveApiAuthorization: this.resolveApiAuthorization,
        resolveRequestAccountAccess: (accountAccess) =>
          this.resolveRequestAccountAccess(accountAccess),
      },
      request,
    );
  }
}
