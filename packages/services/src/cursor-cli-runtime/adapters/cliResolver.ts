import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Discovery result for the official Cursor CLI (`cursor-agent`). */
export type CursorCliResolution =
  | {
      found: true;
      path: string;
      source: "env" | "path" | "home-local-bin" | "home-cursor-bin";
    }
  | { found: false; reason: string };

export interface CursorCliResolverInput {
  pathValue?: string | undefined;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  isExecutableFile?: (candidate: string) => Promise<boolean>;
}

async function defaultIsExecutableFile(candidate: string): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    if (process.platform !== "win32") await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function getCursorCliCandidates(input: {
  pathValue: string | undefined;
  homeDirectory: string;
}): string[] {
  const pathCandidates = (input.pathValue ?? "")
    .split(delimiter)
    // 根因：空 PATH 项等于 cwd，不能从用户可控目录解析可执行文件。
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => join(entry.trim(), "cursor-agent"));
  return [
    ...pathCandidates,
    // GUI Host 可能没有加载 login shell 的 PATH；Cursor 安装脚本写入这两个目录之一。
    join(input.homeDirectory, ".local", "bin", "cursor-agent"),
    join(input.homeDirectory, ".cursor", "bin", "cursor-agent"),
  ];
}

/**
 * Резолв: `CURSOR_AGENT_PATH` (абсолютный) -> `cursor-agent` в PATH -> `~/.local/bin` -> `~/.cursor/bin`.
 * Явно заданный, но непригодный env-путь не блокирует остальные кандидаты: причина сохраняется в reason.
 */
export async function resolveCursorCli(
  input: CursorCliResolverInput = {},
): Promise<CursorCliResolution> {
  const env = input.env ?? process.env;
  const homeDirectory = input.homeDirectory ?? homedir();
  const isExecutableFile = input.isExecutableFile ?? defaultIsExecutableFile;
  const reasons: string[] = [];

  const envPath = env.CURSOR_AGENT_PATH?.trim();
  if (envPath) {
    if (!isAbsolute(envPath)) {
      reasons.push("env-not-absolute");
    } else if (await isExecutableFile(envPath)) {
      return { found: true, path: envPath, source: "env" };
    } else {
      reasons.push("env-not-found");
    }
  } else {
    reasons.push("env-unset");
  }

  const candidates = getCursorCliCandidates({
    pathValue: input.pathValue ?? env.PATH,
    homeDirectory,
  });
  const pathCandidateCount = candidates.length - 2;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (!(await isExecutableFile(candidate))) continue;
    if (index < pathCandidateCount) return { found: true, path: candidate, source: "path" };
    return {
      found: true,
      path: candidate,
      source: index === pathCandidateCount ? "home-local-bin" : "home-cursor-bin",
    };
  }

  return { found: false, reason: `${reasons.join(",")},not-found` };
}
