/**
 * 兼容入口：保留原模块路径与公共导出。
 * 实现在 `./window-remote-registry/` 中按状态机职责拆分，registry 仍是唯一状态所有者。
 */
export * from "./window-remote-registry/index.js";
