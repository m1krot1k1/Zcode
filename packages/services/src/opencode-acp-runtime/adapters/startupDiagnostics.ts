const SAFE_OPENCODE_DIAGNOSTIC_CODES = new Set([
  "opencode.acp-cancel-timeout",
  "opencode.acp-close-timeout",
  "opencode.acp-connection-closed",
  "opencode.acp-initialize-failed",
  "opencode.acp-local-server-unavailable",
  "opencode.acp-process-exited",
  "opencode.acp-process-start-failed",
  "opencode.acp-session-create-failed",
  "opencode.acp-stdio-unavailable",
  "opencode.acp-timeout",
  "opencode.auth-required",
  "opencode.cli-missing",
  "opencode.cli-not-ready",
  "opencode.config-option-invalid",
  "opencode.config-option-update-failed",
  "opencode.install-explicit-path-selected",
  "opencode.install-download-failed",
  "opencode.install-script-invalid",
  "opencode.install-execution-failed",
  "opencode.install-failed",
  "opencode.install-package-manager-failed",
  "opencode.install-platform-unsupported",
  "opencode.install-timeout",
  "opencode.install-destination-conflict",
  "opencode.install-requires-missing-cli",
  "opencode.install-verification-failed",
  "opencode.permission-option-invalid",
  "opencode.permission-request-not-found",
  "opencode.prompt-failed",
  "opencode.prompt-invalid",
  "opencode.runtime-cli-path-mismatch",
  "opencode.runtime-disposed",
  "opencode.session-busy",
  "opencode.session-not-found",
  "opencode.workspace-directory-unavailable",
  "opencode.workspace-path-must-be-absolute",
]);

export function readOpenCodeErrorDiagnostic(error: unknown, fallback: string): string {
  // 根因：ACP peer 可以回传与本地 allowlist 完全相同的字符串，伪装成本地诊断。
  // 修复：只有本进程创建的类型化错误才可穿过边界；peer Error 一律使用固定 fallback。
  return error instanceof OpenCodeDiagnosticError && SAFE_OPENCODE_DIAGNOSTIC_CODES.has(error.code)
    ? error.code
    : fallback;
}

/** ACP reserves -32000 for an explicit authentication-required response. */
export function isOpenCodeAuthRequiredError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === -32000;
}

export class OpenCodeDiagnosticError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OpenCodeDiagnosticError";
  }
}

function stripDiagnosticControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

export function classifyAcpStartupFailure(input: {
  stderr: string;
  spawnErrorCode?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): string {
  if (input.spawnErrorCode === "ENOENT") return "opencode.cli-missing";
  if (input.spawnErrorCode) return "opencode.acp-process-start-failed";

  const stderr = stripDiagnosticControlCharacters(input.stderr);
  const loopbackError =
    /(?:EADDRNOTAVAIL|EADDRINUSE|EACCES|EPERM)[^\n]{0,160}(?:127\.0\.0\.1|localhost|listen|bind)|(?:127\.0\.0\.1|localhost|listen|bind)[^\n]{0,160}(?:EADDRNOTAVAIL|EADDRINUSE|EACCES|EPERM)/iu.test(
      stderr,
    );
  if (loopbackError) return "opencode.acp-local-server-unavailable";
  if (input.exitCode !== null || input.signal !== null) return "opencode.acp-process-exited";
  return "opencode.acp-initialize-failed";
}
