// 自动更新状态机已按职责拆分到 ./auto-updater/*（状态、菜单通道、manifest、下载、
// 安装、事件）；此入口保持原有公开 API，避免 desktop main 其他模块改 import 路径。
export * from "./auto-updater/index.js";
