/**
 * BigModel monitor 数据的兼容入口。
 *
 * 实现已拆分到 ./bigmodel-monitor-mapper/（类型、序列对齐、模型/工具归一化、
 * 热力图与快照组装）；这里保留原导入路径与公开 API，供 bigmodel provider 使用。
 */
export * from "./bigmodel-monitor-mapper/index.js";
