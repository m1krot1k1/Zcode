import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  OPEN_CODE_WINGET_INSTALL_ARGS,
  resolveOpenCodeCli,
  resolveOpenCodeWingetExecutable,
  type OpenCodeCliResolution,
  type OpenCodeCommandSpec,
} from "./cliResolver.js";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type { OpenCodeCliStatus } from "../contract.js";

const VERSION_TIMEOUT_MS = 4_000;
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_VERSION_OUTPUT_CHARS = 512;
const OPEN_CODE_INSTALLER_URL = "https://opencode.ai/v2/install";
const MAX_INSTALLER_SCRIPT_BYTES = 512 * 1024;
const INSTALLER_DOWNLOAD_TIMEOUT_MS = 60_000;
// CLI и npm нужны пути, каталоги пользователя, временные каталоги и локаль; секреты Host не наследуем.
const COMMON_CHILD_ENV_KEYS = new Set(
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "COLORTERM",
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_BIN_HOME",
    "NPM_CONFIG_PREFIX",
    "PNPM_HOME",
    "VOLTA_HOME",
    "MISE_DATA_DIR",
  ].map((key) => key.toUpperCase()),
);
const WINDOWS_CHILD_ENV_KEYS = new Set(
  [
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ].map((key) => key.toUpperCase()),
);

async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    if (platform !== "win32") await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOpenCodeInstallerCommands(input: {
  pathValue: string | undefined;
  platform: NodeJS.Platform;
  isExecutableFile?: (candidate: string) => Promise<boolean>;
}): Promise<{ bash: string; curl: string } | undefined> {
  if (input.platform !== "darwin" && input.platform !== "linux") return undefined;
  const directories = (input.pathValue ?? "")
    .split(":")
    .map((directory) => directory.trim())
    .filter(Boolean);
  const find = async (command: string): Promise<string | undefined> => {
    for (const directory of directories) {
      const candidate = posix.join(directory, command);
      const executable =
        input.isExecutableFile ?? ((path: string) => isExecutableFile(path, input.platform));
      if (await executable(candidate)) return candidate;
    }
    return undefined;
  };
  const [bash, curl] = await Promise.all([find("bash"), find("curl")]);
  return bash && curl ? { bash, curl } : undefined;
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }),
    timeoutMs,
    "opencode.install-timeout",
  );
}

export async function resolveCliCommand(cliPath?: string): Promise<OpenCodeCliResolution> {
  return await resolveOpenCodeCli({
    platform: process.platform,
    pathValue: process.env.PATH,
    pathExtValue: process.env.PATHEXT,
    homeDirectory: homedir(),
    env: process.env,
    explicitPath: cliPath?.trim() || undefined,
    isExecutableFile,
  });
}

export async function resolveWingetCommand(): Promise<string | undefined> {
  return await resolveOpenCodeWingetExecutable({
    pathValue: process.env.PATH,
    pathExtValue: process.env.PATHEXT,
    localAppData: process.env.LOCALAPPDATA,
    isExecutableFile,
  });
}

export function childProcessEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const allowedKeys = new Set(COMMON_CHILD_ENV_KEYS);
  if (platform === "win32") {
    for (const key of WINDOWS_CHILD_ENV_KEYS) allowedKeys.add(key);
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowedKeys.has(key.toUpperCase())) environment[key] = value;
  }
  return environment;
}

export function spawnOptions(
  cwd: string | undefined,
  stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"],
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  return {
    cwd,
    env: childProcessEnvironment(sourceEnvironment, platform),
    stdio,
    windowsHide: true,
    detached: shouldSpawnInDetachedProcessGroup(),
    shell: false,
  };
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

export async function runVersion(
  spec: OpenCodeCommandSpec,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenCodeCliStatus> {
  return await new Promise<OpenCodeCliStatus>((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: OpenCodeCliStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(
      spec.command,
      [...spec.prefixArgs, "--version"],
      spawnOptions(undefined, ["ignore", "pipe", "ignore"], sourceEnvironment, platform),
    );
    const timer = setTimeout(() => {
      finish({ status: "timed-out", diagnostic: "opencode.version-timeout" });
      void terminateProcessTreeAndWait(child);
    }, VERSION_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (output.length < MAX_VERSION_OUTPUT_CHARS) {
        output += String(chunk).slice(0, MAX_VERSION_OUTPUT_CHARS - output.length);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        status: error.code === "ENOENT" ? "missing" : "unavailable",
        diagnostic: error.code === "ENOENT" ? "opencode.cli-missing" : "opencode.version-failed",
        installSupported: process.platform !== "win32",
      });
    });
    child.once("close", (code) => {
      const rawVersion = output.trim().split(/\r?\n/, 1)[0];
      const version = rawVersion
        ? stripControlCharacters(rawVersion).slice(0, MAX_VERSION_OUTPUT_CHARS)
        : undefined;
      if (code === 0 && version)
        finish({ status: "available", version, executablePath: spec.command });
      else if (!settled)
        finish({
          status: "unavailable",
          diagnostic: "opencode.version-failed",
        });
    });
  });
}

export async function installOpenCodeOfficialCli(
  timeoutMs: number,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "darwin" && platform !== "linux") return false;
  const installerCommands = await resolveOpenCodeInstallerCommands({
    pathValue: sourceEnvironment.PATH,
    platform,
    isExecutableFile,
  });
  if (!installerCommands) return false;

  let temporaryDirectory: string | undefined;
  let activeChild: ReturnType<typeof spawn> | undefined;
  let installedDestinationPath: string | undefined;
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-opencode-install-"));
    const temporaryHome = join(temporaryDirectory, "home");
    const scriptPath = join(temporaryDirectory, "install.sh");
    await mkdir(temporaryHome, { recursive: true, mode: 0o700 });

    // Официальный install script должен писать только во временный HOME: это не даёт ему заменить существующий CLI и трогать shell-профили пользователя.
    const isolatedEnvironment = {
      ...sourceEnvironment,
      HOME: temporaryHome,
      TMPDIR: temporaryDirectory,
      XDG_CONFIG_HOME: join(temporaryHome, ".config"),
      XDG_DATA_HOME: join(temporaryHome, ".local", "share"),
      XDG_CACHE_HOME: join(temporaryHome, ".cache"),
      XDG_STATE_HOME: join(temporaryHome, ".local", "state"),
    };

    activeChild = spawn(
      installerCommands.curl,
      [
        "-q",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-time",
        String(Math.ceil(INSTALLER_DOWNLOAD_TIMEOUT_MS / 1000)),
        "--max-filesize",
        String(MAX_INSTALLER_SCRIPT_BYTES),
        "--output",
        scriptPath,
        OPEN_CODE_INSTALLER_URL,
      ],
      spawnOptions(undefined, ["ignore", "ignore", "ignore"], sourceEnvironment, platform),
    );
    const downloadExitCode = await waitForChildExit(activeChild, INSTALLER_DOWNLOAD_TIMEOUT_MS);
    activeChild = undefined;
    if (downloadExitCode !== 0) return false;

    const scriptInfo = await stat(scriptPath).catch(() => null);
    if (
      !scriptInfo?.isFile() ||
      scriptInfo.size === 0 ||
      scriptInfo.size > MAX_INSTALLER_SCRIPT_BYTES
    ) {
      return false;
    }
    const script = await readFile(scriptPath);
    if (!script.subarray(0, 64).toString("utf8").startsWith("#!/usr/bin/env bash")) return false;

    activeChild = spawn(
      installerCommands.bash,
      [scriptPath, "--no-modify-path"],
      spawnOptions(undefined, ["ignore", "ignore", "ignore"], isolatedEnvironment, platform),
    );
    const installExitCode = await waitForChildExit(activeChild, timeoutMs);
    activeChild = undefined;
    if (installExitCode !== 0) return false;

    const stagedBinaryPath = join(temporaryHome, ".opencode", "bin", "opencode");
    const binaryInfo = await stat(stagedBinaryPath).catch(() => null);
    if (!binaryInfo?.isFile()) return false;
    await access(stagedBinaryPath, constants.X_OK).catch(() => {
      throw new Error("opencode.install-binary-not-executable");
    });
    const stagedVersion = await runVersion(
      { command: stagedBinaryPath, prefixArgs: [] },
      isolatedEnvironment,
      platform,
    );
    if (stagedVersion.status !== "available") return false;

    const destinationDirectory = join(sourceEnvironment.HOME || homedir(), ".opencode", "bin");
    const destinationPath = join(destinationDirectory, "opencode");
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    // COPYFILE_EXCL — если другой процесс установил CLI параллельно, не заменяем его файл.
    await copyFile(stagedBinaryPath, destinationPath, constants.COPYFILE_EXCL);
    installedDestinationPath = destinationPath;
    await chmod(destinationPath, 0o755);
    installedDestinationPath = undefined;
    return true;
  } catch {
    if (activeChild) await terminateProcessTreeAndWait(activeChild).catch(() => undefined);
    // Если копирование прошло, а проверка прав нет — удаляем только созданный нами неполный файл.
    if (installedDestinationPath) await unlink(installedDestinationPath).catch(() => undefined);
    return false;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function installOpenCodeWingetPackage(
  wingetPath: string,
  timeoutMs: number,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const child = spawn(
    wingetPath,
    [...OPEN_CODE_WINGET_INSTALL_ARGS],
    spawnOptions(undefined, ["ignore", "ignore", "ignore"], sourceEnvironment, platform),
  );
  try {
    const exitCode = await withTimeout(
      new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      }),
      timeoutMs,
      "opencode.install-timeout",
    );
    return exitCode === 0;
  } catch {
    await terminateProcessTreeAndWait(child).catch(() => undefined);
    return false;
  }
}
