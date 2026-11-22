/**
 * Dock/Finder 启动只继承 launchd 的 PATH。登录 shell 的 PATH 必须在第一个 Host
 * 拉起之前写进本进程，Host 和 `opencode` 子进程才会看到终端里的同一个可执行文件。
 */
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute } from "node:path";

const PATH_MARKER_START = "__ZCODE_LOGIN_PATH_START__";
const PATH_MARKER_END = "__ZCODE_LOGIN_PATH_END__";
const SHELL_TIMEOUT_MS = 5_000;
const PRINT_PATH_COMMAND = `/bin/sh -c 'printf "%s%s%s" "${PATH_MARKER_START}" "$PATH" "${PATH_MARKER_END}"'`;
const SKIP_ENV_VAR = "ZCODE_SKIP_LOGIN_SHELL_PATH";

function defaultShellFor(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function loginShellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  try {
    const shell = userInfo().shell?.trim();
    if (shell) return shell;
  } catch {
    // 容器里可能没有 passwd 条目。
  }
  return env.SHELL?.trim() || defaultShellFor(platform);
}

function shellInvocation(
  shell: string,
  command: string,
): { args: string[]; argv0?: string } {
  const kind = basename(shell);
  if (kind === "csh" || kind === "tcsh") {
    return { args: ["-c", command], argv0: `-${kind}` };
  }
  return { args: ["-i", "-l", "-c", command] };
}

export function extractMarkedPath(output: string): string | undefined {
  const start = output.indexOf(PATH_MARKER_START);
  if (start === -1) return undefined;
  const end = output.indexOf(PATH_MARKER_END, start);
  if (end === -1) return undefined;
  const value = output.slice(start + PATH_MARKER_START.length, end).trim();
  return value.length > 0 ? value : undefined;
}

/** shell 目录在前，已注入目录去重后接在后面。 */
export function mergePaths(shellPath: string, currentPath: string): string {
  const entries = [...shellPath.split(delimiter), ...currentPath.split(delimiter)]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(entries)).join(delimiter);
}

export function prependPathDirectory(env: NodeJS.ProcessEnv, directory: string): void {
  const current = env.PATH ?? "";
  const entries = current.split(delimiter).filter((entry) => entry && entry !== directory);
  env.PATH = [directory, ...entries].join(delimiter);
}

function resolveLoginShellPath(
  shell: string,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const invocation = shellInvocation(shell, PRINT_PATH_COMMAND);
    const child = spawn(shell, invocation.args, {
      argv0: invocation.argv0,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const killShell = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy();
      killShell();
      resolve(value);
    };
    const timeout = setTimeout(() => settle(undefined), timeoutMs);
    child.stdout?.on("data", (data: Buffer) => {
      if (settled) return;
      outputBytes += data.length;
      if (outputBytes > 64 * 1024) {
        settle(undefined);
        return;
      }
      output += data.toString("utf8");
    });
    child.on("error", () => settle(undefined));
    child.on("close", () => settle(extractMarkedPath(output)));
  });
}

type LoginShellPathResult =
  | { status: "applied"; pathEntries: number; shell: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; shell: string };

export async function ensureLoginShellPath(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  userShell?: string;
  fallbackShell?: string;
}): Promise<LoginShellPathResult> {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  if (platform === "win32") return { status: "skipped", reason: "windows" };
  if (env[SKIP_ENV_VAR]?.trim()) return { status: "skipped", reason: SKIP_ENV_VAR };

  const userShell = options?.userShell ?? loginShellFor(platform, env);
  const fallbackShell = options?.fallbackShell ?? defaultShellFor(platform);
  const baseTimeoutMs = options?.timeoutMs ?? SHELL_TIMEOUT_MS;
  const attempts: Array<[string, number]> =
    userShell === fallbackShell
      ? [[userShell, baseTimeoutMs]]
      : [
          [userShell, baseTimeoutMs],
          [fallbackShell, baseTimeoutMs / 2],
        ];

  for (const [shell, timeoutMs] of attempts) {
    const shellPath = await resolveLoginShellPath(shell, timeoutMs);
    if (!shellPath) continue;
    const merged = mergePaths(shellPath, env.PATH ?? "");
    env.PATH = merged;
    return { status: "applied", pathEntries: merged.split(delimiter).length, shell };
  }
  return { status: "failed", shell: userShell };
}

/**
 * E2E fixture 必须排在开发者安装的 `opencode` 前面，因此有绝对路径时不再合并登录 shell。
 * 真实启动走登录 shell，和 Cline sidecar 一样。
 */
export async function applyDesktopProcessPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoginShellPathResult> {
  const e2eCliPath = env.ZCODE_E2E_OPENCODE_CLI_PATH?.trim();
  if (e2eCliPath && isAbsolute(e2eCliPath)) {
    prependPathDirectory(env, dirname(e2eCliPath));
    return { status: "skipped", reason: "e2e-opencode-cli" };
  }
  return ensureLoginShellPath({ env });
}
