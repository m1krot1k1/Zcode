import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  resolveOpenCodeCli,
  type OpenCodeCliResolution,
  type OpenCodeCommandSpec,
} from "./cliResolver.js";
import { resolveOpenCodeCliReleaseAsset } from "./cliReleaseManifest.js";
import { installOpenCodePinnedCli } from "./cliBinaryInstaller.js";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";
import type {
  OpenCodeCliModelCatalog,
  OpenCodeCliModelDescriptor,
  OpenCodeCliStatus,
  OpenCodeInstallCommandOutcome,
} from "../contract.js";

const VERSION_TIMEOUT_MS = 4_000;
export const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_VERSION_OUTPUT_CHARS = 512;
const MODEL_CATALOG_TIMEOUT_MS = 15_000;
const MAX_MODEL_CATALOG_OUTPUT_CHARS = 256 * 1024;
const MAX_MODEL_CATALOG_SIZE = 2_000;
const OPEN_CODE_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const SAFE_OPEN_CODE_VARIANT_ID = /^[A-Za-z0-9._:-]{1,80}$/u;

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
  // macOS Electron 会按 path_helper 重建 PATH，/opt/homebrew/bin 排在 E2E fixture 前面。
  // 仅当调用方没有显式 cliPath 时，绝对路径的测试覆盖才生效。
  const e2eCliPath = process.env.ZCODE_E2E_OPENCODE_CLI_PATH?.trim();
  const explicitPath =
    cliPath?.trim() || (e2eCliPath && isAbsolute(e2eCliPath) ? e2eCliPath : undefined);
  const resolution = await resolveOpenCodeCli({
    platform: process.platform,
    architecture: process.arch,
    linuxLibc,
    pathValue: process.env.PATH,
    pathExtValue: process.env.PATHEXT,
    homeDirectory: homedir(),
    env: process.env,
    explicitPath,
    isExecutableFile,
  });

  // 根因：missing-CLI E2E 必须把开发机上的全局 OpenCode 隔离掉，但显式测试路径在安装前
  // 不存在时会被解析成 invalid-explicit-path，设置页因此隐藏 Install。
  // 修复依据：仅在 ZCODE_ENV=test 且使用 E2E 专用绝对路径时，把该路径的“尚未安装”映射为
  // 可安装状态；安装仍写入隔离 HOME，正式运行和用户手选路径语义不变。
  if (
    process.env.ZCODE_ENV === "test" &&
    e2eCliPath &&
    isAbsolute(e2eCliPath) &&
    resolution.status === "invalid-explicit-path" &&
    resolution.diagnostic === "opencode.explicit-cli-unavailable"
  ) {
    return {
      status: "missing",
      diagnostic: "opencode.cli-missing",
      installSupported: Boolean(
        resolveOpenCodeCliReleaseAsset({
          platform: process.platform,
          architecture: process.arch,
          linuxLibc,
        }),
      ),
    };
  }
  return resolution;
}

function childProcessEnvironment(
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
}/** Read the CLI's bounded model metadata without opening an ACP session or exposing raw output. */
export async function runModelCatalog(
  spec: OpenCodeCommandSpec,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenCodeCliModelCatalog> {
  let isolatedDataHome: string;
  try {
    // Bug 根因：IDE Host 对 OpenCode 持久数据目录可能只有读权限；`models` 因无法打开日志直接退出，导致 Composer 没有可选模型。
    // 修复依据：同一 CLI 在临时 XDG_DATA_HOME 下可正常列出目录。此命令只读模型元数据，不需要用户 data/auth 文件。
    // 为发现命令单独隔离可写数据目录，保留正常 config/cache，并在进程退出后清理，绝不改动用户 OpenCode 登录态。
    isolatedDataHome = await mkdtemp(join(tmpdir(), "zcode-opencode-model-catalog-"));
  } catch {
    return { status: "unavailable", diagnostic: "opencode.models-failed" };
  }

  try {
    return await new Promise<OpenCodeCliModelCatalog>((resolve) => {
      let output = "";
      let oversized = false;
      let settled = false;
      let timedOut = false;
      const finish = (result: OpenCodeCliModelCatalog) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = spawn(spec.command, [...spec.prefixArgs, "models", "--verbose"], {
        ...spawnOptions(undefined, ["ignore", "pipe", "ignore"], sourceEnvironment, platform),
        env: childProcessEnvironment(
          { ...sourceEnvironment, XDG_DATA_HOME: isolatedDataHome },
          platform,
        ),
      });
      const timer = setTimeout(() => {
        timedOut = true;
        void terminateProcessTreeAndWait(child).finally(() => {
          finish({ status: "timed-out", diagnostic: "opencode.models-timeout" });
        });
      }, MODEL_CATALOG_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = String(chunk);
        if (output.length + text.length > MAX_MODEL_CATALOG_OUTPUT_CHARS) {
          oversized = true;
          void terminateProcessTreeAndWait(child).finally(() => {
            finish({ status: "unavailable", diagnostic: "opencode.models-output-invalid" });
          });
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
        if (timedOut) {
          finish({ status: "timed-out", diagnostic: "opencode.models-timeout" });
          return;
        }
        if (oversized) {
          finish({ status: "unavailable", diagnostic: "opencode.models-output-invalid" });
          return;
        }
        if (code !== 0) {
          finish({ status: "unavailable", diagnostic: "opencode.models-failed" });
          return;
        }
        const models = parseOpenCodeVerboseModelCatalog(output);
        if (models.length === 0 || models.length > MAX_MODEL_CATALOG_SIZE) {
          finish({ status: "unavailable", diagnostic: "opencode.models-output-invalid" });
          return;
        }
        finish({ status: "available", models, authentication: "not-checked" });
      });
    });
  } catch {
    return { status: "unavailable", diagnostic: "opencode.models-failed" };
  } finally {
    await rm(isolatedDataHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** CLI output is `provider/model` followed by a JSON block; project only facts the registry needs. */
export function parseOpenCodeVerboseModelCatalog(output: string): OpenCodeCliModelDescriptor[] {
  const models = new Map<string, OpenCodeCliModelDescriptor>();
  const idPattern = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/u;
  let cursor = 0;

  while (cursor < output.length && models.size <= MAX_MODEL_CATALOG_SIZE) {
    const lineEnd = output.indexOf("\n", cursor);
    const nextLineStart = lineEnd < 0 ? output.length : lineEnd + 1;
    const listedId = output.slice(cursor, lineEnd < 0 ? output.length : lineEnd).trim();
    cursor = nextLineStart;
    if (!idPattern.test(listedId)) continue;

    while (cursor < output.length && /\s/u.test(output[cursor] ?? "")) cursor += 1;
    if (output[cursor] !== "{") continue;
    const jsonStart = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; cursor < output.length; cursor += 1) {
      const char = output[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        cursor += 1;
        break;
      }
    }
    if (depth !== 0) break;

    let raw: unknown;
    try {
      raw = JSON.parse(output.slice(jsonStart, cursor));
    } catch {
      continue;
    }
    const model = projectOpenCodeModel(listedId, raw);
    if (model) models.set(model.modelId, model);
  }

  return [...models.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
}

function projectOpenCodeModel(listedId: string, raw: unknown): OpenCodeCliModelDescriptor | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as {
    id?: unknown;
    providerID?: unknown;
    name?: unknown;
    limit?: { context?: unknown; output?: unknown };
    capabilities?: {
      reasoning?: unknown;
      input?: Record<string, unknown>;
      output?: Record<string, unknown>;
    };
    variants?: unknown;
  };
  const modelId = `${String(value.providerID ?? "")}/${String(value.id ?? "")}`;
  const contextWindow = value.limit?.context;
  const maxOutputTokens = value.limit?.output;
  const input = value.capabilities?.input;
  const output = value.capabilities?.output;
  const isPositiveInteger = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  const isBoolean = (candidate: unknown): candidate is boolean => typeof candidate === "boolean";
  const reasoningVariants = projectReasoningVariants(
    value.capabilities?.reasoning === true ? value.variants : undefined,
  );
  if (
    modelId !== listedId ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 160 ||
    !isPositiveInteger(contextWindow) ||
    !isPositiveInteger(maxOutputTokens) ||
    maxOutputTokens > contextWindow ||
    !input ||
    !output ||
    !isBoolean(input.text) ||
    !isBoolean(input.image) ||
    !isBoolean(input.video) ||
    !isBoolean(input.audio) ||
    !isBoolean(input.pdf) ||
    !isBoolean(output.text)
  ) {
    return null;
  }

  return Object.freeze({
    modelId,
    name: value.name,
    contextWindow,
    maxOutputTokens,
    ...(reasoningVariants.length > 0 ? { reasoningVariants } : {}),
    inputFormat: Object.freeze({
      supportsText: input.text,
      supportsImage: input.image,
      supportsVideo: input.video,
      supportsAudio: input.audio,
      supportsPdf: input.pdf,
    }),
    outputSupportsText: output.text,
  });
}

function projectReasoningVariants(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.freeze(
    Object.entries(value).flatMap(([variantId, metadata]) => {
      if (
        !SAFE_OPEN_CODE_VARIANT_ID.test(variantId) ||
        metadata === null ||
        typeof metadata !== "object"
      ) {
        return [];
      }
      const effort = (metadata as { reasoningEffort?: unknown }).reasoningEffort;
      return typeof effort === "string" && OPEN_CODE_REASONING_EFFORTS.has(effort.toLowerCase())
        ? [variantId]
        : [];
    }),
  );
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
