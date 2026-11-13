/**
 * BigModel 用量 provider 的共享常量与日志实例。
 *
 * 路径、凭据 key、超时与空载荷集中在常量模块，避免 provider / HTTP / 解析
 * 三层各自复制一份后出现漂移。
 */
import type {
  BigModelCreditUsageActivityPayload,
  BigModelCreditUsageDetailPayload,
  BigModelUsageModelPerformancePayload,
  BigModelUsageModelUsagePayload,
  BigModelUsageToolUsagePayload,
} from "../bigmodelUsageMonitorMapper.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

export const BIGMODEL_QUOTA_PATH = "/api/monitor/usage/quota/limit";
export const CODING_PLAN_RESET_BASE_PATH = "/api/v1/coding-plan/reset";
export const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
export const ZAI_OAUTH_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
export const BIGMODEL_OAUTH_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
export const REQUEST_TIMEOUT_MS = 15_000;
export const log = createServiceLogger("usage-stats");
export const EMPTY_MODEL_USAGE_PAYLOAD = {} satisfies BigModelUsageModelUsagePayload;
export const EMPTY_TOOL_USAGE_PAYLOAD = {} satisfies BigModelUsageToolUsagePayload;
export const EMPTY_CREDIT_ACTIVITY_PAYLOAD = {} satisfies BigModelCreditUsageActivityPayload;
export const EMPTY_CREDIT_DETAIL_PAYLOAD = {} satisfies BigModelCreditUsageDetailPayload;
export const EMPTY_MODEL_PERFORMANCE_PAYLOAD = {} satisfies BigModelUsageModelPerformancePayload;
