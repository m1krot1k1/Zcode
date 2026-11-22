import { calculateModelCostUsd } from "@zcode/shared";
import type { TokenUsageInfo } from "@zcode/contracts";

/**
 * Runtime 的成本唯一入口：把归一化 token 用量交给模型价格目录计算。
 *
 * 不要在各写入路径里保留 `cost: 0` 或再复制一份价格表；无法确定价格时返回
 * `undefined`，由协议层省略字段。
 */
export function calculateRuntimeModelCost(
  modelId: string | null | undefined,
  tokens: TokenUsageInfo | null | undefined,
): number | undefined {
  if (!tokens) {
    return undefined;
  }
  return calculateModelCostUsd(modelId, {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
  });
}
