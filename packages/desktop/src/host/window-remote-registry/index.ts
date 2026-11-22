/**
 * `windowRemoteConnectionRegistry` 的公共入口。实现按职责拆到本目录：类型、连接 key、
 * entry 生命周期、Source ownership、workspace runtime、恢复状态机、connect 与 scope 解析。
 * 保持原 barrel 的导出面与调用顺序不变。
 */
export {
  WindowRemoteConnectionUnavailableError,
  type WindowRemoteAssetDirs,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
  type WindowRemoteConnectionState,
  type WindowRemoteLogicalSessionSnapshot,
} from "./types.js";
export { createWindowRemoteConnectionRegistry } from "./registry.js";
