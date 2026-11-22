/**
 * macOS Seatbelt (`sandbox-exec`) — изоляция записи на уровне ядра.
 *
 * Профиль строится параметризованным: разрешено писать только в workspace, tmp и
 * явные writable-корни; критические пути (`.git/hooks`, `~/.ssh`) закрываются
 * отдельным deny после allow. Сеть запрещается целиком при `networkAccess: "deny"`,
 * кроме локального loopback — иначе dev-серверы и тесты не смогут слушать порт.
 */
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { wrapCommandWithLimits } from "./linux-bwrap.js";
import type {
  SandboxCapability,
  SandboxCommand,
  SandboxPolicy,
  SandboxedCommand,
} from "./contract.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** SBPL-строка: экранирование кавычек и обратных слэшей обязательно. */
export function sbplEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export interface SeatbeltProfileInput {
  policy: SandboxPolicy;
  /** Дополнительные каталоги вне workspace, куда писать разрешено. */
  extraWritable?: readonly string[];
}

/** Строит SBPL-профиль. Чистая функция: никакого I/O, удобно проверять в тестах. */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const { policy } = input;
  const writable = new Set<string>([
    policy.workspacePath,
    policy.cwdCaptureDir ?? "",
    tmpdir(),
    "/private/var/folders",
    "/private/tmp",
    ...(policy.writableRoots ?? []),
    ...(input.extraWritable ?? []),
  ]);
  writable.delete("");

  const home = safeHomedir();
  const denied = new Set<string>([
    join(policy.workspacePath, ".git", "hooks"),
    join(policy.workspacePath, ".zcode"),
    ...(policy.readOnlyRoots ?? []),
    ...(home ? [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".aws")] : []),
  ]);

  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    // Запись запрещена везде, затем точечно разрешена.
    "(deny file-write*)",
    "(allow file-write*",
    '  (literal "/dev/null")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
  ];
  for (const path of writable) {
    lines.push(`  (subpath "${sbplEscape(path)}")`);
  }
  lines.push(")");

  if (denied.size > 0) {
    lines.push("(deny file-write*");
    for (const path of denied) {
      lines.push(`  (subpath "${sbplEscape(path)}")`);
    }
    lines.push(")");
  }

  if (policy.networkAccess === "deny") {
    lines.push(
      "(deny network-outbound)",
      "(allow network-outbound (remote ip \"localhost:*\"))",
      "(allow network-inbound (local ip \"localhost:*\"))",
      "(allow network-bind (local ip \"localhost:*\"))",
    );
  }

  return lines.join("\n");
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

export interface SeatbeltBuildInput {
  command: SandboxCommand;
  policy: SandboxPolicy;
  capability: SandboxCapability;
  exists?: (path: string) => boolean;
}

export interface SeatbeltBuildResult {
  command?: SandboxedCommand;
  reason?: string;
}

/** Строит argv `sandbox-exec -p <profile> <file> <args...>`. */
export function buildSeatbeltCommand(input: SeatbeltBuildInput): SeatbeltBuildResult {
  const { policy, capability } = input;
  if (!capability.available || capability.mode !== "seatbelt") {
    return { reason: capability.reason ?? "sandbox-exec (Seatbelt) is unavailable" };
  }

  const exists = input.exists ?? existsSync;
  const writableRoots = (policy.writableRoots ?? []).filter((root) => exists(root));
  const profile = buildSeatbeltProfile({ policy, extraWritable: writableRoots });
  const finalCommand = wrapCommandWithLimits(input.command, policy.limits ?? {});
  const env = policy.env ?? {};

  return {
    command: {
      file: SANDBOX_EXEC,
      args: ["-p", profile, finalCommand.file, ...finalCommand.args],
      env,
      cwd: policy.cwd,
      sandboxMode: "seatbelt",
      limits: policy.limits ?? {},
      filesystemIsolated: true,
      networkIsolated: policy.networkAccess === "deny",
    },
  };
}
