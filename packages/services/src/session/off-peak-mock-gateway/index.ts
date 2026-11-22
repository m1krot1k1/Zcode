/* off-peak 进程内 mock 网关（模块入口）。
   本地起 127.0.0.1 http 服务完整模拟 额度快照/取号/批量状态/结算/messages，
   真实 HTTP client 与 idle plan provider 的 baseURL 只需指到本网关 origin——生产代码路径
   与联调完全一致，联调时删掉 ZCODE_OFFPEAK_MOCK 开关即可（tech-design §10 工序 3）。

   ⚠ messages 端点在准入后把请求原样代理到 resolveUpstream() 指定的真实模型端点
   （通常是用户 coding plan 的 anthropic 兼容端点）——mock 模式下跑的是真模型、
   计费走用户自己的 key，仅用于开发/演示，文档已注明。

   模块划分：
   - types.ts：启动选项、依赖、票据与捕获请求的共享类型；
   - config.ts：开关、环境变量覆盖与默认配置；
   - http.ts / request.ts：HTTP 读写与 messages 请求体的宽松解析；
   - anthropic-mock.ts：Anthropic 兼容响应与 SSE 输出；
   - scenario.ts：foreground-subagents / capture 的确定性 E2E 脚本；
   - gateway.ts：票据状态机与路由（take/status/settle/messages 与 E2E 端点）。 */
export { isOffPeakMockEnabled } from "./config.js";
export { startOffPeakMockGateway } from "./gateway.js";
export type { OffPeakMockGatewayHandle } from "./types.js";
