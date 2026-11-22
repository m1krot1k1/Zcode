/**
 * ui-preview-pane 对外契约。
 *
 * 拆分出的数据钩子只依赖服务的类型面（IServiceAccessor），不直接依赖服务实现；
 * 类型通过本契约转出，架构检查据此区分 contract 层与 ui 层。
 */
export type { IServiceAccessor } from "@zcode/services";
