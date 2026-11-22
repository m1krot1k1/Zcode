import {
  isZaiCodingPlanProviderId,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type CodingPlanSubscriptionProviderId,
} from "@zcode/shared";

export function createBigModelLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // BigModel 登录态业务接口要求 Authorization 直接传 accessToken。
    // 这里不能套 Bearer；Bearer 只适用于模型/API Key 类接口。
    Authorization: token,
    "Content-Type": "application/json",
  };
}

export function createZaiLoginAuthHeaders(token: string): Record<string, string> {
  return {
    // Z.ai provider connection 已把 access_token 持久化为业务 JWT。
    // 这里不能使用模型 API key，也不能给业务 JWT 添加 Bearer 前缀。
    Authorization: token,
    "Content-Type": "application/json",
  };
}

export function resolveCodingPlanHost(
  providerId: CodingPlanSubscriptionProviderId | undefined,
): string {
  return providerId && isZaiCodingPlanProviderId(providerId)
    ? resolveZaiCodingPlanHost()
    : resolveBigModelApiOrigin(process.env);
}

export function resolveZaiCodingPlanHost(): string {
  // Z.ai Coding Plan 的 /api/biz 与 /api/pay 业务接口必须跟随产品环境。
  // 业务 token 必须发送到 .env 配置的 ZAI Business origin；未覆盖时默认 api.z.ai。
  return resolveZaiBusinessBaseUrl(process.env);
}

export function resolveBigModelEnterpriseHost(): string {
  // 企业套餐 token 必须发送到 .env 配置的 BigModel origin；未覆盖时默认 bigmodel.cn，
  // 服务端返回空响应后被归一成系统繁忙。
  return resolveBigModelApiOrigin(process.env);
}

export function resolvePreviewPath(
  providerId: CodingPlanSubscriptionProviderId | undefined,
): string {
  return providerId && isZaiCodingPlanProviderId(providerId) ? "/pay/zai-preview" : "/pay/preview";
}
