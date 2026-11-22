/**
 * monitor 只读快照：model-usage / tool-usage → UsageStatsSnapshot。
 *
 * monitor 接口直接返回估算 token 数,反推字符数以保持现有 UI 字段语义。
 */
import type {
  UsageStatsDaySummary,
  UsageStatsModelUsage,
  UsageStatsRequest,
  UsageStatsSnapshot,
  UsageStatsToolUsage,
} from "@zcode/shared";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@zcode/shared";
import type {
  BigModelUsageModelSummaryPayload,
  BigModelUsageModelUsagePayload,
  BigModelUsageToolUsagePayload,
} from "./types.js";

export function buildUsageStatsSnapshotFromMonitor(
  request: UsageStatsRequest,
  modelData: BigModelUsageModelUsagePayload,
  toolData: BigModelUsageToolUsagePayload,
): UsageStatsSnapshot {
  const xTime = modelData.x_time ?? [];
  const tokensUsage = modelData.tokensUsage ?? [];
  const modelCallCount = modelData.modelCallCount ?? [];

  const daily: UsageStatsDaySummary[] = xTime.map((date, index) => {
    const totalEstimatedTokens = tokensUsage[index] ?? 0;
    const messageCount = modelCallCount[index] ?? 0;
    return {
      date,
      label: date,
      totalCharacters: totalEstimatedTokens * ESTIMATED_TOKEN_CHAR_DIVISOR,
      totalEstimatedTokens,
      sessionCount: messageCount > 0 ? 1 : 0,
      messageCount,
      activityScore: totalEstimatedTokens,
    };
  });

  const totalTokens = modelData.totalUsage?.totalTokensUsage ?? 0;
  const totalCalls = modelData.totalUsage?.totalModelCallCount ?? 0;
  const activeDayCount = daily.filter((day) => day.totalEstimatedTokens > 0).length;
  const mostActiveDay =
    daily.reduce<UsageStatsDaySummary | null>((best, day) => {
      if (!best || day.totalEstimatedTokens > best.totalEstimatedTokens) {
        return day;
      }
      return best;
    }, null) ?? null;
  const firstActiveDay = daily.find((day) => day.totalEstimatedTokens > 0) ?? null;
  const lastActiveDay = [...daily].reverse().find((day) => day.totalEstimatedTokens > 0) ?? null;

  const summaryList = modelData.totalUsage?.modelSummaryList ?? modelData.modelSummaryList ?? [];
  const models: UsageStatsModelUsage[] = summaryList
    .filter((entry): entry is BigModelUsageModelSummaryPayload => Boolean(entry?.modelName))
    .map((entry) => {
      const totalEstimatedTokens = entry.totalTokens ?? 0;
      return {
        modelId: entry.modelName ?? null,
        totalCharacters: totalEstimatedTokens * ESTIMATED_TOKEN_CHAR_DIVISOR,
        totalEstimatedTokens,
        inputCharacters: 0,
        inputEstimatedTokens: 0,
        outputCharacters: 0,
        outputEstimatedTokens: 0,
        sessionCount: 0,
        messageCount: 0,
        share: totalTokens > 0 ? totalEstimatedTokens / totalTokens : 0,
      };
    })
    .sort((left, right) => right.totalEstimatedTokens - left.totalEstimatedTokens);

  const favoriteModel = models[0]
    ? {
        modelId: models[0].modelId,
        totalCharacters: models[0].totalCharacters,
        totalEstimatedTokens: models[0].totalEstimatedTokens,
        share: models[0].share,
      }
    : null;

  return {
    range: request.range,
    generatedAt: Date.now(),
    timeZone: request.timeZone ?? "UTC",
    estimatedTokenCharDivisor: ESTIMATED_TOKEN_CHAR_DIVISOR,
    summary: {
      totalSessions: totalCalls,
      totalCharacters: totalTokens * ESTIMATED_TOKEN_CHAR_DIVISOR,
      totalEstimatedTokens: totalTokens,
      totalMessages: totalCalls,
      activeDays: activeDayCount,
      mostActiveDay,
      favoriteModel,
      longestSessionMs: 0,
      longestStreakDays: 0,
      currentStreakDays: 0,
      firstActivityDate: firstActiveDay?.date ?? null,
      lastActivityDate: lastActiveDay?.date ?? null,
      peakHour: null,
    },
    daily,
    // 热力图已从设置页移除;保留空结构以满足类型,避免下游消费方报错。
    heatmap: {
      startDate: firstActiveDay?.date ?? null,
      endDate: lastActiveDay?.date ?? null,
      maxActivityScore: daily.reduce(
        (max, day) => (day.activityScore > max ? day.activityScore : max),
        0,
      ),
      weeks: [],
      monthLabels: [],
    },
    models,
    source: "bigmodel-monitor",
    tools: buildToolUsages(toolData),
  };
}

function buildToolUsages(toolData: BigModelUsageToolUsagePayload): UsageStatsToolUsage[] {
  const tools: UsageStatsToolUsage[] = [];

  const definitions: Array<{
    toolCode: string;
    displayName: string;
    daily?: number[];
    total?: number;
  }> = [
    {
      toolCode: "network-search",
      displayName: "联网搜索 MCP",
      daily: toolData.networkSearchCount,
      total: toolData.totalUsage?.totalNetworkSearchCount,
    },
    {
      toolCode: "web-reader",
      displayName: "网页读取 MCP",
      daily: toolData.webReadMcpCount,
      total: toolData.totalUsage?.totalWebReadMcpCount,
    },
    {
      toolCode: "zread",
      displayName: "开源仓库 MCP",
      daily: toolData.zreadMcpCount,
      total: toolData.totalUsage?.totalZreadMcpCount,
    },
  ];

  for (const def of definitions) {
    const dailyCalls = Array.isArray(def.daily) ? def.daily : [];
    const totalCalls =
      typeof def.total === "number"
        ? def.total
        : dailyCalls.reduce((sum, value) => sum + (value ?? 0), 0);
    tools.push({
      toolCode: def.toolCode,
      displayName: def.displayName,
      totalCalls,
      dailyCalls,
    });
  }

  // search-mcp 没有按天数据,只有合计;有数值时单独追加一条。
  const totalSearchMcp = toolData.totalUsage?.totalSearchMcpCount ?? 0;
  if (totalSearchMcp > 0) {
    tools.push({
      toolCode: "search-mcp",
      // 该接口同时有 network-search 和 search-mcp 两个搜索类统计项。
      // 网页截图只明确了前者叫“联网搜索 MCP”，这里保留 Search MCP 避免两个搜索项重名。
      displayName: "Search MCP",
      totalCalls: totalSearchMcp,
      dailyCalls: [],
    });
  }

  return tools;
}
