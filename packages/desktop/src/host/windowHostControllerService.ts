/**
 * `createWindowHostControllerRuntime` 的公共入口。实现按职责拆分到
 * `window-host-controller/`：类型、纯 helper、source 状态、source 聚合/刷新、
 * 列表查询、attachment 服务、地址解析与生命周期。保持原有导出面与操作顺序不变。
 */
export { createWindowHostControllerRuntime } from "./window-host-controller/index.js";
