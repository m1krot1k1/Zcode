import { collectServiceMemoryDiagnostics } from "@zcode/services";
import { formatZCodeHostProcessName } from "@zcode/shared";
import { createHostAttachmentRuntime } from "./hostAttachmentRuntime.js";
import { routeHostMessage } from "./hostMessageRouter.js";
import { registerHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { installHostConsoleReporting, logger } from "./hostProcessLogging.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
import { installHostProcessGuards } from "./hostShutdown.js";
import { hostState } from "./hostState.js";
import { createHostWindowRuntime } from "./hostWindowRuntime.js";

/**
 * Host Process 入口 —— 每个窗口对应一个独立的 host process
 *
 * 同一窗口的 Renderer 和手机 都 attachment 到这个 Host：
 *   Renderer / Mobile ←MessagePort→ Window Host
 *                                      ├─ local services
 *                                      └─ remote connection registry
 *
 * 启动流程：
 * 1. main 进程通过 Electron `utilityProcess.fork()` 创建本进程
 * 2. main 进程只发送一次 init-local 初始化窗口 Host
 * 3. 后续远端 connect / scoped attachment 都由同一 Host 处理
 */

const { parentPort } = process;

// 进程检索体验优化：host 由 utilityProcess 拉起时外壳仍是 Electron Helper，
// 这里根据 main 传入的窗口 label 补一层稳定的 zcode-* title，方便系统进程列表过滤。
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

// Node warning 不是远端连接失败，改成结构化 warn，避免默认 stderr 被误染成 error。
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// Host 进程自身的 60 秒采样：一次读数两个出口——门控后写本地
// `[memory]` 行，同一次读数换算成 HostResourceSample 经 parentPort 送 main 作 heap 来源。
// services 计数器由各 service 工厂自注册。
hostState.hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

installHostConsoleReporting();

createHostWindowRuntime();
createHostAttachmentRuntime();
installHostProcessGuards();

parentPort.on("message", routeHostMessage);
