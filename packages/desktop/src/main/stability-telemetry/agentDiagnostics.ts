import { createHash } from "node:crypto";
import type { HostAgentProcessErrorResponse, HostAgentProcessExitedResponse } from "@zcode/shared";
import { AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH } from "./constants.js";
import type {
  AgentCrashDiagnostic,
  AgentCrashPhase,
  AgentDiagnosticClass,
  AgentTerminationClass,
} from "./types.js";

const AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_CRASH_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_CRASH_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;
const AGENT_CRASH_UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const AGENT_CRASH_STACK_LOCATION_PATTERN = /:\d+:\d+/g;
const AGENT_CRASH_POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/\s"'`()[\]{}<>]+/g;
const AGENT_CRASH_WINDOWS_HOME_PATTERN = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`()[\]{}<>]+/gi;
const AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN =
  /\b[A-Za-z]:[\\/](?:[^\\/\s"'`()[\]{}<>:]+[\\/])*[^\\/\s"'`()[\]{}<>:]+/g;
const AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN =
  /\/(?:[^/\s"'`()[\]{}<>:]+\/)*[^/\s"'`()[\]{}<>:]+/g;
const AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN = /<(?:workspace|home)>[^\s"'`()[\]{}<>]*/g;

function truncateAgentCrashDetail(value: string): string {
  return value.length > AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH
    ? value.slice(0, AGENT_CRASH_ERROR_DETAIL_MAX_LENGTH)
    : value;
}

function redactRemainingAbsolutePaths(value: string): string {
  const protectedPaths: string[] = [];
  const protectedValue = value.replace(AGENT_CRASH_KNOWN_PATH_PLACEHOLDER_PATTERN, (match) => {
    const index = protectedPaths.push(match) - 1;
    return `ZCODE_REDACTED_PATH_${index}_TOKEN`;
  });
  const redacted = protectedValue
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>");
  return protectedPaths.reduce(
    (result, protectedPath, index) =>
      result.replace(`ZCODE_REDACTED_PATH_${index}_TOKEN`, protectedPath),
    redacted,
  );
}

export function sanitizeAgentCrashDetail(value: string, workspacePath: string): string {
  const withoutWorkspace = workspacePath ? value.split(workspacePath).join("<workspace>") : value;
  return truncateAgentCrashDetail(
    redactRemainingAbsolutePaths(
      withoutWorkspace
        .replace(AGENT_CRASH_WINDOWS_HOME_PATTERN, "<home>")
        .replace(AGENT_CRASH_POSIX_HOME_PATTERN, "<home>"),
    )
      .replace(AGENT_CRASH_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_CRASH_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // 修复原因：Host reporter 不是唯一输入边界，main 在发送 RUM 前必须再次遮盖裸 key。
      .replace(AGENT_CRASH_API_KEY_PATTERN, "$1<redacted>"),
  );
}

function normalizeAgentCrashFingerprintSource(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(AGENT_CRASH_UUID_PATTERN, "<uuid>")
    .replace(AGENT_CRASH_STACK_LOCATION_PATTERN, ":<line>:<column>")
    .replace(/\bpid\s*[:=]\s*\d+\b/gi, "pid=<pid>")
    .replace(AGENT_CRASH_WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(AGENT_CRASH_POSIX_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function normalizeAgentDiagnosticSummary(value: string): string {
  return truncateAgentCrashDetail(value.replace(/\\/g, "/").trim());
}

function isAgentDiagnosticNoise(line: string): boolean {
  return (
    /^(?:\[Object\]\s*,?\s*)+$/i.test(line) ||
    /\[Object\]/i.test(line) ||
    /^node:(?:events|internal)\b/i.test(line) ||
    /^at\s+/i.test(line) ||
    /^\d+:\s*0x[0-9a-f]+\b/i.test(line) ||
    /^\[\d+:0x[0-9a-f]+\]/i.test(line) ||
    /^<---.*--->$/.test(line) ||
    /^-+\s*(?:Native stack trace|JS stacktrace)\s*-+$/i.test(line) ||
    /^\(node:\d+\)\s*ExperimentalWarning:/i.test(line) ||
    /^\(Use `.*--trace-warnings.*\)$/i.test(line) ||
    /^(?:throw er;|Emitted ['"]error['"] event on .* instance at:)$/i.test(line) ||
    /^[}\]]\s*,?$/.test(line) ||
    /^(?:\{|\[)$/.test(line) ||
    /^["']?[\w-]+["']?\s*:\s*(?:\{|\[)$/.test(line) ||
    /^["']?code["']?\s*:\s*["'][A-Z0-9_]+["'],?$/i.test(line)
  );
}

function extractAgentErrorCode(value: string): string {
  const explicit = value.match(/\bcode:\s*["']?([A-Z][A-Z0-9_]+)\b/i)?.[1]?.toUpperCase();
  if (explicit && explicit !== "ERROR") {
    return explicit;
  }
  return (
    value
      .match(/\b(?:[A-Z]+_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|E[A-Z0-9_]{2,})\b/g)
      ?.find((candidate) => candidate !== "ERROR") ?? ""
  );
}

function isErrnoCode(errorCode: string): boolean {
  return /^E[A-Z0-9_]{2,}$/.test(errorCode) && !errorCode.startsWith("ERR_");
}

function isSqliteDiagnostic(value: string, errorCode: string): boolean {
  return (
    /^SQLITE_/i.test(errorCode) ||
    /\bSQLiteError\b|\bSQLite\s+(?:migration|database|initialization|lock)\b|\bdatabase (?:is locked|disk image is malformed)\b/i.test(
      value,
    )
  );
}

function classifyAgentDiagnostic(
  value: string,
  errorCode: string,
  hasUsefulSummary: boolean,
): AgentDiagnosticClass {
  if (/\b(?:JavaScript heap out of memory|Reached heap limit)\b/i.test(value)) {
    return "oom";
  }
  if (isSqliteDiagnostic(value, errorCode)) {
    return "sqlite";
  }
  if (isErrnoCode(errorCode)) {
    return "errno";
  }
  return hasUsefulSummary ? "generic" : "none";
}

export function createAgentCrashFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.map(normalizeAgentCrashFingerprintSource).join("|"))
    .digest("hex")
    .slice(0, 16);
}

export function parseAgentStderrDiagnostic(
  event: HostAgentProcessExitedResponse,
): AgentCrashDiagnostic {
  const errorStack = sanitizeAgentCrashDetail(
    event.stderrTail?.join("\n") ?? "",
    event.workspacePath,
  );
  const lines = errorStack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Bug 根因：旧逻辑把 stderr 第一条非空行当摘要，实际数据中的 [Object]、GC 标题和
  // native 地址因此盖过真正的 OOM / SQLite / errno。先排结构噪音，再按诊断确定性选行。
  const usefulLines = lines.filter((line) => !isAgentDiagnosticNoise(line));
  const oomLine = usefulLines.find((line) =>
    /\b(?:JavaScript heap out of memory|Reached heap limit)\b/i.test(line),
  );
  const stackErrorCode = extractAgentErrorCode(errorStack);
  const sqliteLine = usefulLines.find(
    (line) => !/ExperimentalWarning:/i.test(line) && isSqliteDiagnostic(line, stackErrorCode),
  );
  const errnoLine = usefulLines.find((line) => isErrnoCode(extractAgentErrorCode(line)));
  const errorLine =
    oomLine ??
    sqliteLine ??
    errnoLine ??
    usefulLines.find((line) => /^(?:[A-Za-z_$][\w$]*Error|Error):\s*/.test(line)) ??
    usefulLines.find((line) => /\b(?:Exception|fatal|panic|process exited)\b/i.test(line)) ??
    usefulLines[0];
  const errorMatch = errorLine?.match(/^([A-Za-z_$][\w$]*Error|Error):\s*(.*)$/);
  const errorName = oomLine ? "AgentOutOfMemory" : (errorMatch?.[1] ?? "AgentProcessExit");
  const fallbackMessage = `Agent process exited unexpectedly (code=${event.exitCode ?? "null"}, signal=${event.signal ?? "null"})`;
  const errorMessage = normalizeAgentDiagnosticSummary(
    (oomLine ? oomLine.replace(/^FATAL ERROR:\s*/i, "") : errorMatch?.[2]?.trim()) ||
      errorLine ||
      fallbackMessage,
  );
  const errorCode = oomLine
    ? "ERR_OUT_OF_MEMORY"
    : extractAgentErrorCode(`${errorMessage}\n${errorStack}`);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    errorLine != null,
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      lines.find((line) => line.startsWith("at ")) ?? "",
    ]),
  };
}

export function parseAgentSpawnDiagnostic(
  event: HostAgentProcessErrorResponse,
): AgentCrashDiagnostic {
  const errorName = event.errorName || "Error";
  const errorCode = event.errorCode ?? "";
  const errorMessage = sanitizeAgentCrashDetail(event.errorMessage, event.workspacePath);
  const errorStack = sanitizeAgentCrashDetail(event.errorStack ?? "", event.workspacePath);
  const diagnosticClass = classifyAgentDiagnostic(
    `${errorMessage}\n${errorStack}`,
    errorCode,
    Boolean(errorMessage),
  );
  return {
    errorName,
    errorCode,
    errorMessage,
    errorStack,
    diagnosticClass,
    errorFingerprint: createAgentCrashFingerprint([
      errorName,
      errorCode,
      errorMessage,
      errorStack.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
    ]),
  };
}

export function classifyAgentCrashPhase(runtimeReady: boolean | undefined): AgentCrashPhase {
  if (runtimeReady === true) {
    return "runtime";
  }
  if (runtimeReady === false) {
    return "startup";
  }
  return "unknown";
}

export function classifyAgentTermination(
  event: HostAgentProcessExitedResponse,
): AgentTerminationClass {
  if (event.signal) {
    return "signal";
  }
  if (event.exitCode === 0) {
    return "exit_zero";
  }
  if (typeof event.exitCode === "number") {
    return "exit_nonzero";
  }
  return "unknown";
}
