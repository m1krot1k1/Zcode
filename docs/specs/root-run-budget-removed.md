# 移除 root-run token 预算

## 为什么移除

- 预算把 `cache_read` 计入 input+output：实测 cache_read 占记账的 95.7%，预算按未命中计费放大数十倍。
- 1M 缺省值在真实会话中 7–12 个请求即耗尽，用户看到的是「预算用尽」，而不是模型能力上限。
- 上线后记录 74 次误判中止（admission 拒绝整轮），全部由虚高记账触发，无一是真实 runaway。

## 保留的护栏

- spawn 预算（`spawnBudget`，缺省 32）：整棵子 Agent 树的 admission 上限；0 表示禁止 spawn。
- idle 600s 与首个 token 90s 超时不变；`maxTurns` 与工具级超时不变。

## runaway 如何被覆盖

真实 runaway 只有三种形态：无限 spawn、长时间无输出、无限 turn。分别由 spawn 预算、
idle/首 token 超时、maxTurns 拦截；token 数量不再是准入条件，只作为 usage 统计保留。

## 移除范围

- 设置：`AppSettings.rootRunTokenLimit`、设置卡片中的 token 行、`ZCODE_ROOT_RUN_TOKEN_LIMIT` 环境变量。
- Agent：`AgentRuntimeConfig.rootRunTokenLimit` 及其 token admission 预留（另一半提交）。
- 不动 spawn 预算、deadline、usage 记账与 provider 结算逻辑。
