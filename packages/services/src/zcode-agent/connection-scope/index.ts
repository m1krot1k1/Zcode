// connection-scope 子模块的公开入口；导出顺序与原单文件 facade 保持一致。
export type { ZCodeAgentV4ClientMode, ZCodeAgentV4ConnectionContext } from "./types.js";
export { readTrustedZCodeAgentV4UnsubscribeRoute } from "./trustedConnection.js";
export { readTrustedZCodeAgentV4Connection } from "./trustedConnection.js";
export { createZCodeAgentConnectionScope } from "./createScope.js";
export type { ZCodeAgentConnectionScope } from "./createScope.js";
// Share RPC 复用同一内部 carrier 写入规则，不能复制一套连接身份拼装。
export { withTrustedConnection as withTrustedZCodeAgentV4Connection } from "./trustedConnection.js";
