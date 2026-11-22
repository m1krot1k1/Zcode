import { mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatTimestamp } from "@zcode/shared";
import { cleanupExpiredLogFiles, LOG_RETENTION_DAYS } from "./logRetention.js";
import { getAppConfigDir, maybeThrowInjectedFsFault } from "@zcode/services/node";

function getLogDir() {
  const e2eLogDir =
    process.env.ZCODE_ENV === "test" ? process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() : undefined;
  if (e2eLogDir) {
    return e2eLogDir;
  }
  return join(getAppConfigDir(), "logs");
}

// 启动时确保日志目录存在
const LOG_DIR = getLogDir();
mkdirSync(LOG_DIR, { recursive: true });

const logRetentionResult = cleanupExpiredLogFiles(LOG_DIR);
if (logRetentionResult.failedFiles.length > 0) {
  safeConsoleWrite(
    "warn",
    `[log-retention] failed to delete expired logs from ${LOG_DIR}:`,
    logRetentionResult.failedFiles,
    `retentionDays=${LOG_RETENTION_DAYS}`,
  );
}

type LogLevel = "debug" | "info" | "warn" | "error";

const SENSITIVE_LOG_KEY_PATTERN =
  /(?:api[-_]?key|authorization|cookie|credential|password|passwd|secret|token|private[-_]?key)/i;

/**
 * 与 adapters/logging 的 DefaultLogRedactor 保持同一敏感字段口径。
 * main 进程不依赖 adapters 包，因此在这里保留一份最小实现，避免为了脱敏
 * 把整个 logging 适配器拉进 Electron 主进程。
 */
function redactLogText(value: string): string {
  return value
    .replace(
      /(\bauthorization\b["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,"'};]+/giu,
      "$1 {redacted}",
    )
    .replace(
      /([?&](?:api[_-]?key|token|access[_-]?token|authorization|password|passwd|secret|cookie|session)=)[^&\s]+/giu,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:api[_-]?key|token|access[_-]?token|password|passwd|secret|client[_-]?secret|cookie|set-cookie|session)["']?\s*[:=]\s*["']?)(?!\{redacted\})[^\s,"'};]+/giu,
      "$1{redacted}",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 {redacted}")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "{secret}")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "{secret}")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "{secret}")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/gu, "{secret}");
}

function redactLogValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") {
    return redactLogText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > 8) {
    return "[Redacted:DepthLimit]";
  }
  if (seen.has(value)) {
    return "[Redacted:Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen, depth + 1));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Error 等宿主对象保留原始字段，避免 JSON.stringify 丢栈。
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      SENSITIVE_LOG_KEY_PATTERN.test(key)
        ? "[Redacted]"
        : redactLogValue(entryValue, seen, depth + 1),
    ]),
  );
}

function redactLogArgs(args: unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map((value) => redactLogValue(value, seen, 0));
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function ignoreBrokenPipeStreamError(error: Error): void {
  // WDIO / dev runner 结束后可能先关闭 stdout/stderr 管道，随后主进程日志还在刷新。
  // stream error 是异步事件，try/catch 包 console.log 不一定兜得住；这里统一吞掉 EPIPE。
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

process.stdout.on("error", ignoreBrokenPipeStreamError);
process.stderr.on("error", ignoreBrokenPipeStreamError);

function safeConsoleWrite(level: LogLevel, ...args: unknown[]): void {
  const consoleFn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  try {
    consoleFn(...args);
  } catch (error) {
    // dev 脚本或父终端退出后，Electron main 的 stdout/stderr 管道可能已关闭。
    // 这时 console.* 会抛 EPIPE，不能让日志输出反过来杀掉主进程；文件日志仍会继续写入。
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 单一写入队列：appendFileSync 在会话/工具高频日志下会阻塞 Electron main，
 * 改为串行异步追加，保持同一进程内的行顺序。
 */
let writeQueue: Promise<void> = Promise.resolve();

function enqueueLogLine(filePath: string, line: string): void {
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      maybeThrowInjectedFsFault({ operation: "appendFile", path: filePath });
      await appendFile(filePath, line);
    })
    .catch(() => {
      // 日志写入失败不应影响应用运行
    });
}

/** 测试与退出屏障使用：等待当前队列落盘。 */
export function flushLoggerForTests(): Promise<void> {
  return writeQueue;
}

function write(level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const safeArgs = redactLogArgs(args);
  const message = safeArgs.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  const filePath = join(logDir, `${formatDate(now)}.log`);

  // 同时保留 console 输出，方便开发调试；console 也加时间戳和 PID，与文件格式对齐
  safeConsoleWrite(level, `[${ts}] [pid:${pid}] [${source}]`, ...safeArgs);
  enqueueLogLine(filePath, line);
}

function writeDedicated(filePrefix: string, level: LogLevel, source: string, ...args: unknown[]) {
  const now = new Date();
  const ts = formatTimestamp(now);
  const pid = process.pid;
  const safeArgs = redactLogArgs(args);
  const message = safeArgs.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${ts}] [${level}] [pid:${pid}] [${source}] ${message}\n`;
  const logDir = getLogDir();
  // Bugfix: 远控 relay trace 与主日志混放时，目录内文件会快速增多，人工排查不直观。
  // 这里把高频 trace 分流到 logs 子目录，避免影响主日志浏览与导出定位。
  const dedicatedDir = join(logDir, "web-remote-control");
  const filePath = join(dedicatedDir, `${filePrefix}-${formatDate(now)}.log`);

  enqueueLogLine(filePath, line);
}

/**
 * main 进程日志，默认写入 ~/.zcode/v2/logs/YYYY-MM-DD.log；E2E 测试使用 worker 专属目录。
 * 同时保留 console 输出方便开发调试
 */
export const logger = {
  // 高频 browser/CDP 等协议细节只在本地开发记录，避免生产日志量与命令流同数量级。
  debug: (...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      write("debug", "main", ...args);
    }
  },
  info: (...args: unknown[]) => write("info", "main", ...args),
  warn: (...args: unknown[]) => write("warn", "main", ...args),
  error: (...args: unknown[]) => write("error", "main", ...args),

  /** renderer 日志通过 IPC 传入后调用此方法写入同一文件 */
  fromRenderer: (level: LogLevel, args: unknown[]) => write(level, "renderer", ...args),
};

/**
 * Web remote control relay message trace 专用日志。
 * 仅用于高频链路排障，独立落盘避免淹没主日志文件。
 */
export const webRemoteControlRelayLogger = {
  info: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "info", "web-remote-control-relay", ...args),
  warn: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "warn", "web-remote-control-relay", ...args),
  error: (...args: unknown[]) =>
    writeDedicated("web-remote-control-relay", "error", "web-remote-control-relay", ...args),
};
