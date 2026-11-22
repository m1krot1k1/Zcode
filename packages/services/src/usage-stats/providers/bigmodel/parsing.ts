/**
 * BigModel 用量 provider 的响应解析与信封校验。
 *
 * Coding Plan reset 的 zod schema、monitor/额度信封的成功判定与可选数据面降级
 * 都在这里；provider 只按解析结果做业务分支。
 */
import { z } from "zod";
import { ApiError } from "@zcode/shared";
import { log } from "./constants.js";

export const codingPlanResetEnvelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
});
export const codingPlanResetOpportunitySchema = z.object({
  expire_at: z.number().finite().positive(),
});
export const codingPlanResetHistorySchema = z.object({
  used_at: z.number().finite().positive(),
});
export const codingPlanResetStatusDataSchema = z.object({
  available_five_hour_resets: z.array(codingPlanResetOpportunitySchema),
  available_week_resets: z.array(codingPlanResetOpportunitySchema),
  latest_five_hour_reset_history: codingPlanResetHistorySchema.nullable(),
  latest_week_reset_history: codingPlanResetHistorySchema.nullable(),
  has_unread_history: z.boolean(),
});
export const codingPlanResetUseDataSchema = z.object({
  used: z.literal(true),
});
export const codingPlanResetOpportunityGrantedDataSchema = z.object({
  granted: z.literal(true),
});
export const codingPlanResetOpportunityDeniedDataSchema = z.object({
  granted: z.literal(false),
  next_try_at: z.number().int().positive(),
});

export function readCodingPlanResetEnvelope(
  payload: unknown,
): z.infer<typeof codingPlanResetEnvelopeSchema> {
  const result = codingPlanResetEnvelopeSchema.safeParse(payload);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  if (result.data.code !== 0) {
    throw new Error(`coding_plan_reset_api_error:${result.data.code}`);
  }
  return result.data;
}

export function readCodingPlanResetEnvelopeData<TSchema extends z.ZodType>(
  payload: unknown,
  schema: TSchema,
): z.infer<TSchema> {
  const envelope = readCodingPlanResetEnvelope(payload);
  const result = schema.safeParse(envelope.data);
  if (!result.success) {
    throw new Error("coding_plan_reset_invalid_response");
  }
  return result.data;
}

export function readSuccessfulBigModelMonitorData<TData extends object>(
  payload: {
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  },
  fallbackMessage: string,
  emptyData: TData,
  options: { allowMissingData?: boolean } = {},
): TData {
  if (!isSuccessfulBigModelEnvelope(payload)) {
    throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
  }
  if (payload.data) {
    return payload.data;
  }
  if (options.allowMissingData === true && hasExplicitBigModelSuccessSignal(payload)) {
    // BigModel monitor 的 tool-usage 在团队项目无工具调用时会返回
    // code=200、msg=“操作成功”但省略 data。空用量应显示为空统计，不能中断整个统计页。
    return emptyData;
  }
  throw new Error(readBigModelEnvelopeMessage(payload) || fallbackMessage);
}

// credit-usage/activity、usage-detail、model-performance-day 是可选数据面。
// 传输层失败（HTTP 非 2xx、超时、断网）时只清空对应区域并记 warn，不能让
// Promise.all 提前 reject 拖垮整张 Coding Plan Usage 面板。HTTP 200 但业务信封失败
// （如 token expired）仍由 readSuccessfulBigModelMonitorData 抛错：鉴权/后端错误必须
// 显式暴露给用户，不能伪装成空用量（既有测试已锁定该语义）。
export async function readBestEffortBigModelMonitorData<TData extends object>(
  request: Promise<{
    code?: number;
    message?: string;
    msg?: string;
    success?: boolean;
    data?: TData | null;
  }>,
  fallbackMessage: string,
  emptyData: TData,
): Promise<TData> {
  let payload: Awaited<typeof request> | null = null;
  try {
    payload = await request;
  } catch (error) {
    log.warn(undefined, `${fallbackMessage}，该区域降级为空统计`, {
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof ApiError ? error.status : null,
    });
    return emptyData;
  }
  return readSuccessfulBigModelMonitorData(payload, fallbackMessage, emptyData, {
    allowMissingData: true,
  });
}

export function readBigModelEnvelopeMessage(payload: { message?: string; msg?: string }): string {
  return payload.msg?.trim() || payload.message?.trim() || "";
}

export function hasExplicitBigModelSuccessSignal(payload: {
  code?: number;
  success?: boolean;
}): boolean {
  return payload.success === true || payload.code === 0 || payload.code === 200;
}

export function isSuccessfulBigModelEnvelope(payload: {
  code?: number;
  success?: boolean;
}): boolean {
  const code = payload.code;
  // BigModel monitor/quota 后端存在 code=0 且 msg=“操作成功”的成功响应。
  // 只按 code=200 判断会把团队用量统计的成功包误抛成错误，导致设置页显示无法读取统计。
  return (
    payload.success !== false && (code === undefined || code === null || code === 0 || code === 200)
  );
}

export function parseNumber(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numericValue) ? numericValue : null;
}

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function formatUnixSecondsAsIso(value: number | string | null | undefined): string | null {
  const numericValue = parseUnixSeconds(value);
  if (numericValue === null) {
    return null;
  }

  return new Date(numericValue * 1000).toISOString();
}

export function parseUnixSeconds(value: number | string | null | undefined): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}
