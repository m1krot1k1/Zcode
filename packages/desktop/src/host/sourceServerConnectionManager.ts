/**
 * 兼容入口：保留原模块路径与公共导出。
 * 实现在 `./source-server-connection/` 中按连接状态机职责拆分，
 * ManagerContext 仍是连接、状态、恢复 timer 的唯一状态所有者。
 */
export * from "./source-server-connection/index.js";
