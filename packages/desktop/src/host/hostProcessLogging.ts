import { randomUUID } from "node:crypto";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import { createServiceLogger } from "@zcode/services/node";
import { HostMessageTypes, HostResponseTypes, formatLogPrefix } from "@zcode/shared";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import type { HostIncomingMessage } from "./hostMessagePortGuard.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";

const { parentPort } = process;

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

export function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // 日志上报失败不应影响 host 主流程。
  }
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

export const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // 连接进度上报失败不应中断 SSH/WSL/Docker 的真实连接流程。
    }
  },
});

function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

export function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // 问题反馈以前在 host service 内走 compactLogArchive 的 full fallback，
    // 收集范围和“导出日志”不一致，缺少 zcode-cli 日志、rollout/debug 以及导出链路脱敏。
    // 这里把完整日志打包委托给 main process 的导出日志同源逻辑，host 只拿 zip 路径继续上传。
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

// 后台输出轮询仍需独立的 debug logger，不能随其他日志调用方移除而丢失工厂导入。
const rpcDebugLogger = createServiceLogger("rpc");

export function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

/** 把 console 输出同时上报到 main；在 Host 组装完成后按既有顺序安装。 */
export function installHostConsoleReporting(): void {
  console.log = (...args: unknown[]) => {
    rawConsole.log(...args);
    reportHostLog("info", args);
  };

  console.warn = (...args: unknown[]) => {
    rawConsole.warn(...args);
    reportHostLog("warn", args);
  };

  console.error = (...args: unknown[]) => {
    rawConsole.error(...args);
    // Electron 会把 Node warning 先走 console.error，而 process warning listener 随后还会
    // 结构化记录 warn；若这里继续上报，就会为同一个 warning 留下一条 error 和一条 warn。
    if (!shouldReportHostConsoleError(args)) {
      return;
    }
    reportHostLog("error", args);
  };
}

type FeedbackLogArchiveResultMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.FeedbackLogArchiveResult }
>;
type LocalMediaPreviewPathAuthorizeResultMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.LocalMediaPreviewPathAuthorizeResult }
>;

/** main 返回完整日志归档结果；按 requestId 结算 host 侧 pending。 */
export function resolveFeedbackLogArchiveRequest(msg: FeedbackLogArchiveResultMessage): void {
  const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
  if (!pending) {
    return;
  }
  pendingFeedbackLogArchiveRequests.delete(msg.requestId);
  if (msg.ok && msg.path && typeof msg.size === "number") {
    pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
    pending.resolve({ path: msg.path, size: msg.size });
    return;
  }
  pending.reject(new Error(msg.error ?? "反馈日志归档创建失败"));
}

/** main 返回本地视频路径授权结果；按 requestId 结算 host 侧 pending。 */
export function resolveLocalMediaPreviewPathAuthorization(
  msg: LocalMediaPreviewPathAuthorizeResultMessage,
): void {
  const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
  if (!pending) return;
  pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
  if (msg.ok && msg.path) {
    logger.info("local media preview path authorization OK");
    pending.resolve(msg.path);
  } else {
    pending.reject(new Error(msg.error ?? "本地视频预览路径授权失败"));
  }
}
