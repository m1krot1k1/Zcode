# OpenCode 免费额度耗尽：立即失败而非空转

记录时间：2026-11-04

## 背景

OpenCode Zen 的免费模型额度耗尽时，上游返回：

```
HTTP 429
Retry-After: 15995
{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode; subscribe to OpenCode Go"}}
```

本地 `opencode serve` 不会把 429 透传给 SDK 客户端：它把请求挂起，并在 3～4 秒后通过 SSE 发出
`session.status`，其中 `status.type = "retry"`、`status.action.reason = "free_tier_limit"`、
`status.next` 是数小时后的时间戳。prompt 请求本身一直不返回。

修复前：provider 只识别 `session.error`，不识别 `session.status(retry)`，于是适配器既没有错误也没有 token，
只能等 first-token 看门狗（90s）超时，再被当作可重试失败走满 `maxAttempts`（11 次），用户看到约 20 分钟的
“Working”。

## 修复

1. `patches/ai-sdk-provider-opencode-sdk@3.0.6.patch`：`readSessionRetryLimitEvent` 把
   `free_tier_limit` 或等待超过 10 分钟的 `session.status(retry)` 归一化成 429 / `isRetryable: false`
   的错误，`createAPICallError` 保留显式 `isRetryable` 与 `retryAfterSeconds`。ESM 与 CJS 两份 dist 同步修改。
2. `failure-classifier.ts`：`FreeUsageLimitError` / 免费额度文案 → `OPENCODE_FREE_LIMIT_REACHED`、`retryable: false`；
   任意 429 的 `Retry-After > 600s` 同样不重试。`Retry-After ≤ 600s` 保持可重试。
3. `contracts/src/model/index.ts`：新增 `ModelErrorCode.OpenCodeFreeLimitReached`。
4. UI：`ChatErrorBanner` 本地化该 code，`en-US` / `zh-CN` 各一条文案，不透出上游原文。

## 边界

- 不修改全局 `maxAttempts`、first-token 90s、idle 600s。
- 只有 OpenCode 上下文的 “usage limit reached” 才算免费额度；其他 provider 的同名文案不受影响。
- 旧的 `OPENCODE_EMPTY_RESPONSE`（空响应包装里的额度文案）路径保持可用，只是分类结果改为
  `OPENCODE_FREE_LIMIT_REACHED`。
