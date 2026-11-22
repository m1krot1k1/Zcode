// Coding Plan / client-config 共享常量；拆分子模块后仍保持单点定义。
export const BIGMODEL_CODING_PLAN_API_PREFIX = "/api/biz";
export const ZAI_CODING_PLAN_PAY_API_PREFIX = "/api/pay";
export const ZCODE_CLIENT_CONFIG_API_PREFIX = "/api/v1/client/configs";
export const REQUEST_TIMEOUT_MS = 15_000;
export const CLIENT_CONFIG_CACHE_TTL_MS = 60 * 60 * 1000;
export const CODING_PLAN_ZAI_OVERSEAS_PAYMENT_REQUIRED =
  "coding_plan_zai_overseas_payment_required";
export const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
