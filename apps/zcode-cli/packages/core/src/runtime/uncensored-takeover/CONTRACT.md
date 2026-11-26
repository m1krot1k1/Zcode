# cli-uncensored-takeover

一个 provider refusal 对应一个任务项：模块只负责「判定 → 归因 → 组装最小请求 → 按顺序尝试已启用模型」，
事件、durable session entry、幂等与后续 synthetic reminder 都由 turn loop（`uncensored-takeover-gate.ts`）独占，
模块不 import runtime 内部、service 或 UI。

## 不变量

1. 拒绝只由 finish reason 判定：`finishReason` / `rawFinishReason` 归一化（lower/trim/`_`→`-`）后
   属于 `{refusal, content-filter}`；不从正文推断 provider 级拒绝，也不因 `stop` / `tool-calls` / `length` /
   空 completions 触发。
1a. 文本级拒绝是独立的第二层：仅当 provider 未给出拒绝、finish reason 为 `stop` 且最后一条 assistant
   消息没有 tool call 时，`detectTextRefusal` 才按高精度模板集判定（英/俄/中文）。模板要求「拒绝词干 +
   请求服务动词」或「句首的拒绝词干 + 破折号/冒号引出原因」（`Не буду — это оскорбление`），
   单独的词干（`Я не буду менять конфигурацию`）不算拒绝；工具输出、澄清问题永不触发。
2. 归因确定：第一个 `in_progress`，否则第一个 `pending`；`itemIndex` 为 0-based 数组位置；空列表或全部
   `completed` 返回 `null`（不产生任何事件）。`itemText` 上限 4000，超出以 `…` 结尾。
3. 请求恰好两条消息（固定 system + user）；user ≤ 12000 字符；item 优先且 ≤ 4000；fragment ≤ 3 × 4000；
   只来自当前 turn 的成功只读工具结果（路径匹配优先，其后取最新）。无历史、无完整 prompt、无其它 пункт 文本。
4. HTTP：`POST apiUrl`、仅非空 key 才带 `Authorization`、`Content-Type: application/json`、
   `{model,messages,max_tokens:16384,stream:false}`、`redirect:"error"`、60s `AbortSignal`、每模型一次尝试。
   wire `model` 去掉精确的 `:thinking` 后缀（thinking 模型会把 max_tokens 全烧在 reasoning 上、正文为空），
   归因仍保留原始 id。
5. 路由：按 `models` 顺序仅取 `enabled:true`；refusal/error → 下一个；无启用模型或 config `null` → 0 次 fetch；
   全失败取最后一次状态。
6. 幂等：键为 `taskId + 归一化 itemText`；`agentId` = `uncensored-takeover:<taskId>:<itemIndex>:<sha256(key)[0..16]>`。
   turn loop 先查 durable entry，再查 per-runtime 内存守卫；同一 turn 已注入 reminder 的重复项不再注入，避免循环。

## 交集

- Turn loop：`finishModelStepWithoutToolCalls` 在 persist 与 automation 早退之后、auto-repair 之前调用 gate；
  成功后 `commitTurnRequestEntries(systemReminderAttachmentEntry("uncensored_takeover", …))` + 重置 TurnMachine +
  `"continue"`，主模型继续剩余项。
- Session store：durable 行类型 `runtime/uncensored_takeover`，payload 由 `contract.ts` 的 strict schema 校验；
  写入 `saveSessionEntry`，重复检查读取 `sessionEntries`。
- 事件：`model_refusal` → `subagent_spawned(takeover.status="running")` → HTTP → `subagent_stopped`（终态）。
