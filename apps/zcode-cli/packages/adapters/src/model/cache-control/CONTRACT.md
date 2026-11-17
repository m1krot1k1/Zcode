# cli-model-cache-control

意图：在模型适配器边界统一规划与注入 `cache_control: { type: "ephemeral" }` 显式前缀缓存断点（涵盖 Anthropic 原生与 OpenRouter 上的 `anthropic/*`、`google/gemini-*`、`qwen/*`、`deepseek/*`、`z-ai/glm-*`），并统一提取各网关的缓存读写 token 指标。

不变量：

- 单次请求中的显式 `cache_control` 断点总数严格 `<= 4`（工具表末尾 1 个 + 稳定系统提示词 1 个 + 量化历史锚点至多 2 个）。
- 历史锚点采用步长量化阶梯（Rolling Quantized Prefix Staircase，默认每 4 条 `user | tool` 消息跃迁一次并保留上一阶锚点），禁止每轮单步移动断点破坏前缀命中。
- 对未声明显式断点能力的普通 `openai-compatible` 端点保持零侵入（不注入陌生 `cache_control` 字段）。

Hook 交集：

- OpenAI-compatible 路径：在 `provider-factory.ts` 的 `createOpenAiCompatibleCacheControlFetch` 包装层注入 wire JSON 断点与 OpenRouter 粘性路由提示。
- Anthropic 原生路径与指标归一化：在 `tool-transform.ts` / `runner-options.ts` 协调工具断点预算，在 `runner-normalization.ts` 统一提取 `cacheReadTokens` / `cacheWriteTokens`。
