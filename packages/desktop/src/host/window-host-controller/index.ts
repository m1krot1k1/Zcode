/**
 * `windowHostControllerRuntime` 的公共入口。实现按职责拆到本目录：类型、纯 helper、
 * source 状态、source 聚合/刷新、列表查询、attachment 服务、地址解析与生命周期。
 * 保持原导出面、状态所有权与调用顺序不变。
 */
export { createWindowHostControllerRuntime } from "./runtime.js";
export type {
  ResolvedWindowHostControllerSource,
  WindowHostControllerRuntimeOptions,
} from "./types.js";
