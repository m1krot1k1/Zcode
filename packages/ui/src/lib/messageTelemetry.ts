/**
 * message_completion / agent_step 埋点入口。实现按职责拆在 `./message-telemetry/`：
 * prompt 生命周期、agent step 生命周期、权限等待归因、usage 与 extraDetail 构建。
 * 这里只保留稳定公开入口，调用方继续从 `@/lib/messageTelemetry.js` 导入。
 */
export * from "./message-telemetry/index.js";
