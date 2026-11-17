/**
 * cli-model-cache-control 标准调用示例：在 OpenRouter OpenAI-compatible 请求体上注入至多 4 个稳定缓存断点。
 */
import type { CliModelCacheControlContract } from "./contract.js";

export function exampleCliModelCacheControl(
  contract: CliModelCacheControlContract,
): Record<string, unknown> {
  const capability = contract.resolveCapability({
    baseURL: "https://openrouter.ai/api/v1",
    modelId: "qwen/qwen3.6-plus",
    providerId: "openrouter",
    providerKind: "openai-compatible",
  });

  return contract.applyToOpenAiCompatibleWireBody(
    {
      model: "qwen/qwen3.6-plus",
      messages: [
        { role: "system", content: "You are ZCode." },
        { role: "user", content: "Inspect src/index.ts" },
      ],
      tools: [{ type: "function", function: { name: "Read" } }],
    },
    { capability },
  );
}
