/**
 * BigModel monitor / credit-usage 远端载荷与信封类型。
 *
 * 类型只描述接口返回结构，不含归一化逻辑；字段保持与远端 JSON 一致，
 * 由各 mapper 模块负责空值与类型收敛。
 */

export interface BigModelUsageModelSummaryPayload {
  modelName?: string;
  totalTokens?: number;
  sortOrder?: number;
}

export interface BigModelUsageModelDataPayload {
  modelName?: string;
  totalTokens?: number;
  tokensUsage?: number[];
  sortOrder?: number;
}

export interface BigModelUsageModelUsagePayload {
  x_time?: string[];
  granularity?: string;
  modelCallCount?: number[];
  tokensUsage?: number[];
  totalUsage?: {
    totalModelCallCount?: number;
    totalTokensUsage?: number;
    modelSummaryList?: BigModelUsageModelSummaryPayload[];
  };
  modelDataList?: BigModelUsageModelDataPayload[];
  modelSummaryList?: BigModelUsageModelSummaryPayload[];
}

export interface BigModelUsageToolUsagePayload {
  x_time?: string[];
  granularity?: string;
  networkSearchCount?: number[];
  webReadMcpCount?: number[];
  zreadMcpCount?: number[];
  totalUsage?: {
    totalNetworkSearchCount?: number;
    totalWebReadMcpCount?: number;
    totalZreadMcpCount?: number;
    totalSearchMcpCount?: number;
    toolSummaryList?: BigModelUsageToolSummaryPayload[];
  };
  toolDataList?: BigModelUsageToolDataPayload[];
  toolSummaryList?: BigModelUsageToolSummaryPayload[];
}

export interface BigModelCreditUsageMetricPayload {
  value?: number | string | null;
  trend?: number | string | null;
}

export interface BigModelCreditUsageActivitySummaryPayload {
  totalTokens?: number;
  peakDailyTokens?: number;
  peakDailyTokensDate?: string;
  totalUsageDurationMs?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
}

export interface BigModelCreditUsageActivitySeriesPayload {
  date?: string;
  totalTokens?: number;
  modelCallCount?: number;
  mcpCalls?: number;
}

export interface BigModelCreditUsageActivityPayload {
  summary?: BigModelCreditUsageActivitySummaryPayload | null;
  series?: BigModelCreditUsageActivitySeriesPayload[];
}

export interface BigModelCreditUsageModelDataPayload {
  modelCode?: string;
  modelName?: string;
  sortOrder?: number;
  totalTokens?: number;
  totalCredits?: number;
  totalCreditsUsage?: BigModelUsageNumberSeries;
  cachedInputCreditsUsage?: BigModelUsageNumberSeries;
  uncachedInputCreditsUsage?: BigModelUsageNumberSeries;
  outputCreditsUsage?: BigModelUsageNumberSeries;
  tokensUsage?: BigModelUsageNumberSeries;
  totalTokensUsage?: BigModelUsageNumberSeries;
  cachedInputTokensUsage?: BigModelUsageNumberSeries;
  uncachedInputTokensUsage?: BigModelUsageNumberSeries;
  outputTokensUsage?: BigModelUsageNumberSeries;
}

export interface BigModelCreditUsageMcpDataPayload {
  mcpCode?: string;
  mcpName?: string;
  toolCode?: string;
  toolName?: string;
  sortOrder?: number;
  totalCredits?: number;
  totalUsageCount?: number;
  creditsUsage?: BigModelUsageNumberSeries;
  mcpCallCount?: BigModelUsageNumberSeries;
  usageCount?: BigModelUsageNumberSeries;
}

/**
 * 远端数值序列：同一槽位可能是 number、数字字符串或空值。
 * 归一化统一经由 `toFiniteNumber`，因此这里保留宽松的输入类型。
 */
export type BigModelUsageNumberSeries = Array<number | string | null | undefined>;

export interface BigModelCreditUsageDetailPayload {
  summary?: {
    cacheHitRate?: BigModelCreditUsageMetricPayload;
    totalCredits?: BigModelCreditUsageMetricPayload;
    averageDailyCredits?: BigModelCreditUsageMetricPayload;
  } | null;
  modelUsage?: {
    xTime?: string[];
    periodTypes?: string[];
    modelDataList?: BigModelCreditUsageModelDataPayload[];
  } | null;
  mcpUsage?: {
    xTime?: string[];
    periodTypes?: string[];
    mcpDataList?: BigModelCreditUsageMcpDataPayload[];
  } | null;
}

export interface BigModelUsageModelPerformancePayload {
  x_time?: string[];
  xTime?: string[];
  proMaxDecodeSpeed?: number[];
  liteDecodeSpeed?: number[];
}

export interface BigModelUsageToolDataPayload {
  toolCode?: string;
  toolName?: string;
  sortOrder?: number;
  usageCount?: number[];
  totalUsageCount?: number;
}

export interface BigModelUsageToolSummaryPayload {
  toolCode?: string;
  toolName?: string;
  totalUsageCount?: number;
  sortOrder?: number;
}

export interface BigModelUsageModelUsageEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageModelUsagePayload | null;
}

export interface BigModelUsageToolUsageEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageToolUsagePayload | null;
}

export interface BigModelCreditUsageActivityEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelCreditUsageActivityPayload | null;
}

export interface BigModelCreditUsageDetailEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelCreditUsageDetailPayload | null;
}

export interface BigModelUsageModelPerformanceEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: BigModelUsageModelPerformancePayload | null;
}
