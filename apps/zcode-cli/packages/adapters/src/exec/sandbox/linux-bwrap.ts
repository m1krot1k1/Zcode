/**
 * bubblewrap (Linux) — реальная изоляция ФС и сети через user namespaces.
 *
 * Монтирование строится от самой строгой базы: вся корневая ФС только на чтение,
 * приватные `/tmp`, `/dev`, `/proc`, и поверх этого — единственный writable bind
 * на workspace. Дополнительные writable-корни добавляются явно из политики.
 * Критические пути (`.git/hooks`, `.zcode`, `~/.ssh`, `~/.gnupg`, `~/.aws`)
 * возвращаются в read-only уже после bind workspace.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  SandboxCapability,
  SandboxCommand,
  SandboxLimits,
  SandboxPolicy,
  SandboxedCommand,
} from "./contract.js";

/** Пути, которые обязаны оставаться read-only даже внутри workspace. */
export function resolveProtectedPaths(workspacePath: string): string[] {
  const home = safeHomedir();
  return [
    join(workspacePath, ".git", "hooks"),
    join(workspacePath, ".zcode"),
    ...(home ? [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".aws")] : []),
  ];
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/** Кибибайты для `ulimit -v`. */
function toKibibytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1024));
}

/**
 * Команда `ulimit` для применения лимитов. Возвращает `undefined`, если лимитов нет.
 * `-f` измеряется в 512-байтных блоках, `-v` — в KiB: это требование POSIX-шелла.
 */
export function buildLimitCommand(limits: SandboxLimits): string | undefined {
  const parts: string[] = [];
  if (limits.cpuSeconds !== undefined && limits.cpuSeconds > 0) {
    parts.push(`ulimit -t ${Math.floor(limits.cpuSeconds)}`);
  }
  if (limits.memoryBytes !== undefined && limits.memoryBytes > 0) {
    parts.push(`ulimit -v ${toKibibytes(limits.memoryBytes)}`);
  }
  if (limits.maxProcesses !== undefined && limits.maxProcesses > 0) {
    parts.push(`ulimit -u ${Math.floor(limits.maxProcesses)}`);
  }
  if (limits.maxFileSizeBytes !== undefined && limits.maxFileSizeBytes > 0) {
    parts.push(`ulimit -f ${Math.max(1, Math.floor(limits.maxFileSizeBytes / 512))}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function hasLimits(limits: SandboxLimits): boolean {
  return buildLimitCommand(limits) !== undefined;
}

/** Оборачивает команду в `sh -c 'ulimit ...; exec "$@"' sh <file> <args...>`. */
export function wrapCommandWithLimits(
  command: SandboxCommand,
  limits: SandboxLimits,
): { file: string; args: string[] } {
  const limitCommand = buildLimitCommand(limits);
  if (!limitCommand) return { file: command.file, args: [...command.args] };
  return {
    file: "/bin/sh",
    args: ["-c", `${limitCommand}; exec "$@"`, "sh", command.file, ...command.args],
  };
}

export interface BwrapBuildInput {
  command: SandboxCommand;
  policy: SandboxPolicy;
  capability: SandboxCapability;
  /** Проверка существования пути; в тестах подменяется. */
  exists?: (path: string) => boolean;
}

export interface BwrapBuildResult {
  command?: SandboxedCommand;
  /** Причина, по которой bwrap использовать нельзя. */
  reason?: string;
}

function flagSupported(capability: SandboxCapability, flag: string): boolean {
  return capability.supportedFlags.includes(flag);
}

/**
 * Строит argv bwrap. Возвращает `reason`, если механизм недоступен или политика
 * требует флага, которого нет в этой версии bwrap — тогда вызывающий переходит в `degraded`.
 */
export function buildBwrapCommand(input: BwrapBuildInput): BwrapBuildResult {
  const { policy, capability } = input;
  if (!capability.available || capability.mode !== "bwrap") {
    return { reason: capability.reason ?? "bubblewrap is unavailable" };
  }

  const exists = input.exists ?? existsSync;
  const wantsNetworkIsolation = policy.networkAccess === "deny";
  if (wantsNetworkIsolation && !flagSupported(capability, "--unshare-net")) {
    return { reason: "bwrap does not support --unshare-net in this version" };
  }

  const argv: string[] = ["--ro-bind", "/", "/"];
  if (policy.allowDevices !== false) {
    argv.push("--dev", "/dev");
  }
  argv.push("--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm");

  // Единственный обязательный writable-корень — workspace.
  const writable = new Set<string>([policy.workspacePath]);
  for (const root of policy.writableRoots ?? []) writable.add(root);
  for (const root of writable) {
    if (!exists(root)) continue;
    argv.push("--bind", root, root);
  }

  // Каталог захвата cwd должен быть виден снаружи песочницы.
  const captureDir = policy.cwdCaptureDir;
  if (captureDir && exists(captureDir)) {
    argv.push("--bind", captureDir, captureDir);
  }

  // Всё, что объявлено read-only явно, остаётся read-only даже внутри workspace.
  const protectedPaths = new Set<string>([
    ...resolveProtectedPaths(policy.workspacePath),
    ...(policy.readOnlyRoots ?? []),
  ]);
  for (const path of protectedPaths) {
    if (!exists(path)) continue;
    argv.push("--ro-bind", path, path);
  }

  argv.push("--unshare-pid", "--unshare-ipc", "--die-with-parent");
  if (wantsNetworkIsolation) argv.push("--unshare-net");

  argv.push("--chdir", policy.cwd);

  const env = policy.env ?? {};
  if (policy.envIsolated) argv.push("--clearenv");
  for (const [key, value] of Object.entries(env)) {
    argv.push("--setenv", key, value);
  }

  const finalCommand = wrapCommandWithLimits(input.command, policy.limits ?? {});
  argv.push("--", finalCommand.file, ...finalCommand.args);

  return {
    command: {
      file: "/usr/bin/bwrap",
      args: argv,
      env,
      cwd: policy.cwd,
      sandboxMode: "bwrap",
      limits: policy.limits ?? {},
      filesystemIsolated: true,
      networkIsolated: wantsNetworkIsolation,
    },
  };
}

/** Экспорт для тестов: реально ли лимиты требуют shell-обёртки. */
export function bwrapNeedsShellWrapper(limits: SandboxLimits): boolean {
  return hasLimits(limits);
}
