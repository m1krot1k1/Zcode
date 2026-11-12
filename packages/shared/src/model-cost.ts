import { getUsage } from "tokenlens";

/**
 * 单次模型请求的 token 用量。字段名与 Runtime 的 `TokenUsageInfo` 对齐，
 * 这里只做纯计算，不读取 provider/registry 状态。
 */
export interface ModelCostUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * 用模型目录里的价格计算一次请求的美元成本。
 *
 * 返回值是唯一事实源：调用方不得再用固定 0 或自行按 token 重算。
 * 模型不在价格目录、价格缺失或用量为空时返回 `undefined`，表示“未知”，
 * 让协议层省略该字段，而不是伪装成 0。
 */
export function calculateModelCostUsd(
  modelId: string | null | undefined,
  usage: ModelCostUsage | null | undefined,
): number | undefined {
  const normalizedModelId = modelId?.trim();
  if (!normalizedModelId || !usage) {
    return undefined;
  }

  const input = finiteNonNegative(usage.input);
  const output = finiteNonNegative(usage.output);
  const reasoning = finiteNonNegative(usage.reasoning);
  const cacheReads = finiteNonNegative(usage.cacheRead);
  const cacheWrites = finiteNonNegative(usage.cacheWrite);

  // 零 token 不代表“免费”：没有请求用量时价格计算没有任何事实依据。
  if (input + output + reasoning + cacheReads + cacheWrites <= 0) {
    return undefined;
  }

  const { costUSD } = getUsage({
    modelId: normalizedModelId,
    usage: {
      input,
      output,
      cacheReads,
      cacheWrites,
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    },
  });
  const total = costUSD?.totalUSD;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
