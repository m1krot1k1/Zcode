/**
 * Source Server 连接管理器的公共入口。实现按职责拆分在相邻模块中：
 * - `manager.ts` — 门面与公共 API；
 * - `connect.ts` — 单连接/复用/flight 归并与握手；
 * - `recovery.ts` — 启动重连、retry/offline probe 与意外关闭；
 * - `update.ts` — 显式更新与运行任务守卫；
 * - `lifecycle.ts` — 断开、删除 profile 与 dispose；
 * - `state.ts` / `compatibility.ts` — 状态发布与版本兼容事实；
 * - `access.ts` / `adapters.ts` — 在线连接、文件传输与 transport adapter 缓存。
 */
export { SourceServerConnectionManager } from "./manager.js";
export {
  SourceServerIdentityChangePendingError,
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
} from "./types.js";
export type {
  ConnectSourceServerOptions,
  ManagedSourceServerConnection,
  SourceServerConnectionManagerOptions,
} from "./types.js";
