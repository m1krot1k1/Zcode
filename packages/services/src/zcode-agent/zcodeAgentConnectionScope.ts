// 兼容入口：V4 connection-scoped facade 已拆分到 ./connection-scope/。
// 保留原路径与导出顺序，消费者继续从这里导入。
export type {
  ZCodeAgentV4ClientMode,
  ZCodeAgentV4ConnectionContext,
} from "./connection-scope/types.js";
export { readTrustedZCodeAgentV4UnsubscribeRoute } from "./connection-scope/trustedConnection.js";
export { readTrustedZCodeAgentV4Connection } from "./connection-scope/trustedConnection.js";
export { createZCodeAgentConnectionScope } from "./connection-scope/createScope.js";
export type { ZCodeAgentConnectionScope } from "./connection-scope/createScope.js";
// Share RPC 复用同一内部 carrier 写入规则，不能复制一套连接身份拼装。
export { withTrustedConnection as withTrustedZCodeAgentV4Connection } from "./connection-scope/trustedConnection.js";
