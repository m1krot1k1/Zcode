/**
 * Provider 详情子模块的本地契约。
 * ui 不直接依赖 @zcode/services：服务类型统一经 ui-root 契约转出，
 * 详情子组件只读取 Settings View 的既有形状，不复制服务端定义。
 */
export type { ProviderSettingsView } from "@/root/contract.js";
