import { join, win32 } from "node:path";
import { resolveOpenCodeCliReleaseAsset } from "./cliReleaseManifest.js";

export interface OpenCodeCommandSpec {
  command: string;
  prefixArgs: string[];
}

export type OpenCodeCliResolution =
  | { status: "resolved"; executablePath: string; spec: OpenCodeCommandSpec }
  | {
      status: "missing" | "unsupported" | "invalid-explicit-path";
      diagnostic: string;
      installSupported: boolean;
    };

export interface OpenCodeCliResolverInput {
  platform: NodeJS.Platform;
  pathValue: string | undefined;
  pathExtValue?: string;
  homeDirectory: string;
  architecture?: NodeJS.Architecture;
  linuxLibc?: "glibc" | "musl";
  env?: NodeJS.ProcessEnv;
  explicitPath?: string;
  isExecutableFile: (candidate: string) => Promise<boolean>;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

export function getPosixOpenCodeCandidates(input: {
  pathValue: string | undefined;
  homeDirectory: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const home = input.homeDirectory;
  const env = input.env ?? {};
  const pathCandidates = (input.pathValue ?? "")
    .split(":")
    // An empty PATH entry means cwd; avoid resolving a user-controlled executable from cwd.
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => join(entry.trim(), "opencode"));
  const knownDirectories = [
    env.NPM_CONFIG_PREFIX ? join(env.NPM_CONFIG_PREFIX, "bin") : "",
    env.PNPM_HOME ?? "",
    env.VOLTA_HOME ? join(env.VOLTA_HOME, "bin") : join(home, ".volta", "bin"),
    env.MISE_DATA_DIR
      ? join(env.MISE_DATA_DIR, "shims")
      : join(home, ".local", "share", "mise", "shims"),
    env.XDG_BIN_HOME ?? "",
    // OpenCode 官方安装脚本写入 ~/.opencode/bin；GUI Host 可能没有加载用户 shell 的 PATH 配置。
    join(home, ".opencode", "bin"),
    // Linuxbrew 也支持安装到用户目录；GUI Host 可能没有继承 ~/.linuxbrew/bin 的 PATH。
    join(home, ".linuxbrew", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, "npm", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
  return uniquePaths([
    ...pathCandidates,
    ...knownDirectories.map((directory) => join(directory, "opencode")),
  ]);
}

async function resolvePosix(input: OpenCodeCliResolverInput): Promise<OpenCodeCliResolution> {
  if (input.explicitPath !== undefined) {
    const explicitPath = input.explicitPath.trim();
    if (!explicitPath.startsWith("/")) {
      return {
        status: "invalid-explicit-path",
        diagnostic: "opencode.explicit-cli-path-must-be-absolute",
        installSupported: false,
      };
    }
    if (await input.isExecutableFile(explicitPath)) {
      return {
        status: "resolved",
        executablePath: explicitPath,
        spec: { command: explicitPath, prefixArgs: [] },
      };
    }
    return {
      status: "invalid-explicit-path",
      diagnostic: "opencode.explicit-cli-unavailable",
      installSupported: false,
    };
  }

  for (const candidate of getPosixOpenCodeCandidates(input)) {
    if (await input.isExecutableFile(candidate)) {
      return {
        status: "resolved",
        executablePath: candidate,
        spec: { command: candidate, prefixArgs: [] },
      };
    }
  }
  return {
    status: "missing",
    diagnostic: "opencode.cli-missing",
    installSupported: Boolean(
      resolveOpenCodeCliReleaseAsset({
        platform: input.platform,
        architecture: input.architecture ?? process.arch,
        linuxLibc: input.linuxLibc,
      }),
    ),
  };
}

async function resolveWindows(input: OpenCodeCliResolverInput): Promise<OpenCodeCliResolution> {
  const pathExt = (input.pathExtValue || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => [".exe", ".com", ".cmd", ".bat"].includes(extension));
  const nativeExtensions: string[] = pathExt.filter(
    (extension) => extension === ".exe" || extension === ".com",
  );
  const shimExtensions: string[] = pathExt.filter(
    (extension) => extension === ".cmd" || extension === ".bat",
  );

  if (input.explicitPath !== undefined) {
    const explicitPath = input.explicitPath.trim();
    if (!win32.isAbsolute(explicitPath)) {
      return {
        status: "invalid-explicit-path",
        diagnostic: "opencode.explicit-cli-path-must-be-absolute",
        installSupported: false,
      };
    }
    const extension = win32.extname(explicitPath).toLowerCase();
    if (shimExtensions.includes(extension)) {
      return {
        status: "unsupported",
        diagnostic: "opencode.windows-cli-shim-unsupported",
        installSupported: false,
      };
    }
    if (!nativeExtensions.includes(extension)) {
      return {
        status: "invalid-explicit-path",
        diagnostic: "opencode.windows-native-cli-required",
        installSupported: false,
      };
    }
    if (await input.isExecutableFile(explicitPath)) {
      return {
        status: "resolved",
        executablePath: explicitPath,
        spec: { command: explicitPath, prefixArgs: [] },
      };
    }
    return {
      status: "invalid-explicit-path",
      diagnostic: "opencode.explicit-cli-unavailable",
      installSupported: false,
    };
  }

  const pathDirectories = (input.pathValue ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const knownDirectories = [
    input.env?.NPM_CONFIG_PREFIX ?? "",
    input.env?.APPDATA ? win32.join(input.env.APPDATA, "npm") : "",
    input.env?.LOCALAPPDATA
      ? win32.join(input.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
      : "",
    input.env?.ProgramFiles ? win32.join(input.env.ProgramFiles, "WinGet", "Links") : "",
    win32.join(input.homeDirectory, ".opencode", "bin"),
  ].filter(Boolean);
  const directories = uniquePaths([...pathDirectories, ...knownDirectories]);
  for (const directory of directories) {
    for (const extension of pathExt) {
      const candidate = win32.join(directory, `opencode${extension}`);
      if (!(await input.isExecutableFile(candidate))) continue;
      if (nativeExtensions.includes(extension)) {
        return {
          status: "resolved",
          executablePath: candidate,
          spec: { command: candidate, prefixArgs: [] },
        };
      }
      if (shimExtensions.includes(extension)) {
        return {
          status: "unsupported",
          diagnostic: "opencode.windows-cli-shim-unsupported",
          installSupported: false,
        };
      }
    }
  }
  return {
    status: "missing",
    diagnostic: "opencode.cli-missing",
    installSupported: Boolean(
      resolveOpenCodeCliReleaseAsset({
        platform: input.platform,
        architecture: input.architecture ?? process.arch,
        linuxLibc: input.linuxLibc,
      }),
    ),
  };
}

export async function resolveOpenCodeCli(
  input: OpenCodeCliResolverInput,
): Promise<OpenCodeCliResolution> {
  return input.platform === "win32" ? await resolveWindows(input) : await resolvePosix(input);
}
