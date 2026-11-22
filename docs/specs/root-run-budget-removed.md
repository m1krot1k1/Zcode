# 移除 root-run token 预算

## 为什么移除

- 预算把 `cache_read` 计入 input+output：实测 cache_read 占记账的 95.7%，预算按未命中计费放大数十倍。
- 1M 缺省值在真实会话中 7–12 个请求即耗尽，用户看到的是「预算用尽」，而不是模型能力上限。
- 上线后记录 74 次误判中止（admission 拒绝整轮），全部由虚高记账触发，无一是真实 runaway。

## 保留的护栏

- spawn 预算已从 admission 移除：`spawnBudget`、`remaining_spawns`、`spawnGrant` 是 legacy 字段，
  旧值仍可读取，但不再限制新的启动。唯一的活动并发边界是实际 worker slot 容量（`active_limit`）；
  创建任务的总数没有上限。
- idle 600s 与首个 token 90s 超时不变（`DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 600_000`、
  `DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS = 90_000`）；工具级超时不变。
- `maxTurns` 是显式的用户/配置文件设置：未设置表示不限制轮数，限制只在显式正整数时生效，
  并让 turn 以可预测的 `error_max_turns` 结束（见 `max-turns-limit.md`）。

## runaway 如何被覆盖

真实 runaway 被分层拦截：无限 turn 由显式 `maxTurns` 拦截，长时间无输出由 idle/首 token
超时拦截，其余由用户 Stop 与 runtime stop 终止。创建任务的总数不再由应用层计数器限制：
并发受实际 slot 容量约束，串行链路只受角色 deadline（若显式启用）、Stop 或 turn 结束约束。
token 数量不再是准入条件，只作为 usage 统计保留。

Root run 默认不设置 wall-clock deadline：`DEFAULT_ROOT_RUN_DEADLINE_MS` 为 `undefined`，
因此 root turn 执行到完成、用户取消或 runtime 停止。`beginRootRunBudget` 的显式 `deadlineMs`
仍可供调用方和测试使用；它不是 token budget，也不限制模型请求数量。

## 移除范围

- 设置：`AppSettings.rootRunTokenLimit`、设置卡片中的 token 行、`ZCODE_ROOT_RUN_TOKEN_LIMIT` 环境变量。
- Agent：`AgentRuntimeConfig.rootRunTokenLimit` 及其 token admission 预留（另一半提交）。
- 不动 per-role deadline（只能通过 `subagentTaskTimeoutMinutes` 显式启用）、usage 记账与
  provider 结算逻辑。Root-run wall-clock deadline 默认不存在，只能由显式 `deadlineMs` 启用。
