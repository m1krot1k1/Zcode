import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  resolveOpenCodeCli,
  type OpenCodeCliResolution,
  type OpenCodeCommandSpec,
} from "./cliResolver.js";
import { installOpenCodePinnedCli } from "./cliBinaryInstaller.js";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type {
  OpenCodeCliModelCatalog,
  OpenCodeCliStatus,
  OpenCodeInstallCommandOutcome,
} from "../contract.js";

const VERSION_TIMEOUT_MS = 4_000;
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_VERSION_OUTPUT_CHARS = 512;
const MODEL_CATALOG_TIMEOUT_MS = 15_000;
const MAX_MODEL_CATALOG_OUTPUT_CHARS = 256 * 1024;
const MAX_MODEL_CATALOG_SIZE = 2_000;

export function detectHostLinuxLibc(
  platform: NodeJS.Platform = process.platform,
): "glibc" | "musl" | undefined {
  if (platform !== "linux") return undefined;
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

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

export async function resolveCliCommand(cliPath?: string): Promise<OpenCodeCliResolution> {
  const linuxLibc = detectHostLinuxLibc();
  return await resolveOpenCodeCli({
    platform: process.platform,
    architecture: process.arch,
    linuxLibc,
    pathValue: process.env.PATH,
    pathExtValue: process.env.PATHEXT,
    homeDirectory: homedir(),
    env: process.env,
    explicitPath: cliPath?.trim() || undefined,
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

/** Read the CLI model list without opening an ACP session or exposing arbitrary CLI output. */
export async function runModelCatalog(
  spec: OpenCodeCommandSpec,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenCodeCliModelCatalog> {
  return await new Promise<OpenCodeCliModelCatalog>((resolve) => {
    let output = "";
    let oversized = false;
    let settled = false;
    const finish = (result: OpenCodeCliModelCatalog) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(
      spec.command,
      [...spec.prefixArgs, "models"],
      spawnOptions(undefined, ["ignore", "pipe", "ignore"], sourceEnvironment, platform),
    );
    const timer = setTimeout(() => {
      finish({ status: "timed-out", diagnostic: "opencode.models-timeout" });
      void terminateProcessTreeAndWait(child);
    }, MODEL_CATALOG_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      if (output.length + text.length > MAX_MODEL_CATALOG_OUTPUT_CHARS) {
        oversized = true;
        finish({ status: "unavailable", diagnostic: "opencode.models-output-invalid" });
        void terminateProcessTreeAndWait(child);
        return;
      }
      output += text;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({
        status: "unavailable",
        diagnostic: error.code === "ENOENT" ? "opencode.cli-missing" : "opencode.models-failed",
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0 || oversized) {
        finish({ status: "unavailable", diagnostic: "opencode.models-failed" });
        return;
      }
      const models = [
        ...new Set(
          output
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
      if (
        models.length > MAX_MODEL_CATALOG_SIZE ||
        models.some((model) => !/^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/u.test(model))
      ) {
        finish({ status: "unavailable", diagnostic: "opencode.models-output-invalid" });
        return;
      }
      finish({ status: "available", models, authentication: "not-checked" });
    });
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
  architecture: NodeJS.Architecture = process.arch,
  linuxLibc?: "glibc" | "musl",
): Promise<OpenCodeInstallCommandOutcome> {
  const resolvedLinuxLibc = linuxLibc ?? detectHostLinuxLibc(platform);
  return await installOpenCodePinnedCli({
    timeoutMs,
    sourceEnvironment,
    platform,
    architecture,
    linuxLibc: resolvedLinuxLibc,
    runVersion,
    makeSpawnOptions: spawnOptions,
  });
}
