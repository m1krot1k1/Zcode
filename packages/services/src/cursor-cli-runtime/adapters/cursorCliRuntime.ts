import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  ICursorCliRuntime,
  CursorCliInstallResult,
  CursorCliModelCatalog,
  CursorCliStatus,
} from "../contract.js";
import {
  resolveCursorCli,
  type CursorCliResolution,
  type CursorCliResolverInput,
} from "./cliResolver.js";
import { parseCursorModelCatalog } from "./cursorModelCatalogParser.js";
import { CURSOR_BASELINE_MODELS } from "./cursor-baseline-models.js";

export const CURSOR_CLI_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";

const STATUS_TIMEOUT_MS = 5_000;
const CATALOG_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface CursorCliCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export interface CursorCliRuntimeOptions {
  resolveCli?: (cliPath?: string) => Promise<CursorCliResolution>;
  runCommand?: (args: readonly string[], timeoutMs: number) => Promise<CursorCliCommandResult>;
  resolverInput?: Omit<CursorCliResolverInput, "pathValue"> & {
    pathValue?: string | undefined;
  };
  /** Catalog/status cache TTL; stops settings refreshes from spawning the CLI repeatedly. */
  cacheTtlMs?: number;
  now?: () => number;
}

function collect(stream: NodeJS.ReadableStream, sink: string[], onBytes: (total: number) => void) {
  let total = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    total += text.length;
    onBytes(total);
    if (total <= MAX_OUTPUT_BYTES) sink.push(text);
  });
}

function runCursorCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CursorCliCommandResult> {
  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error.name : "spawn-failed",
      });
      return;
    }
    const finish = (result: CursorCliCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const killIfOversized = (total: number) => {
      if (total > MAX_OUTPUT_BYTES) child.kill("SIGKILL");
    };
    if (child.stdout) collect(child.stdout, stdout, killIfOversized);
    if (child.stderr) collect(child.stderr, stderr, killIfOversized);
    child.once("error", (error) => {
      finish({
        exitCode: null,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        timedOut,
        spawnError: error.name,
      });
    });
    child.once("close", (code) => {
      finish({
        exitCode: code,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        timedOut,
      });
    });
  });
}

function parseVersion(stdout: string, stderr: string): string | undefined {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return undefined;
  const version = line.replace(/^cursor-agent\s+/iu, "").split(/\s+/u)[0];
  return version && version.length > 0 ? version.slice(0, 64) : undefined;
}

function diagnosticFrom(result: CursorCliCommandResult): string | undefined {
  if (result.spawnError) return `spawn-${result.spawnError}`;
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr.slice(0, 512) : undefined;
}

export function createCursorCliRuntime(options: CursorCliRuntimeOptions = {}): ICursorCliRuntime {
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const statusCache = new Map<string, { expiresAt: number; value: CursorCliStatus }>();
  const catalogCache = new Map<string, { expiresAt: number; value: CursorCliModelCatalog }>();
  const lastGoodStatus = new Map<string, CursorCliStatus>();
  const lastGoodCatalog = new Map<string, CursorCliModelCatalog>();
  const resolveCli =
    options.resolveCli ??
    ((cliPath?: string) =>
      resolveCursorCli({
        ...options.resolverInput,
        pathValue: cliPath ?? options.resolverInput?.pathValue,
      }));
  const run =
    options.runCommand ??
    (async (args: readonly string[], timeoutMs: number) =>
      runCursorCommand(args[0]!, args.slice(1), timeoutMs));

  const resolveExecutable = async (
    cliPath?: string,
  ): Promise<{ ok: true; path: string } | { ok: false; diagnostic: string }> => {
    const resolution = await resolveCli(cliPath);
    if (!resolution.found) return { ok: false, diagnostic: resolution.reason };
    return { ok: true, path: resolution.path };
  };

  const readCached = <T>(
    cache: Map<string, { expiresAt: number; value: T }>,
    key: string,
  ): T | undefined => {
    const cached = cache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt > now()) return cached.value;
    cache.delete(key);
    return undefined;
  };

  const writeCached = <T>(
    cache: Map<string, { expiresAt: number; value: T }>,
    key: string,
    value: T,
    ttlMs = cacheTtlMs,
  ): void => {
    cache.set(key, { expiresAt: now() + ttlMs, value });
  };
  const negativeTtlMs = Math.min(cacheTtlMs, 15_000);

  return {
    getCliStatus: async ({ cliPath } = {}): Promise<CursorCliStatus> => {
      const executable = await resolveExecutable(cliPath);
      if (!executable.ok) {
        return {
          status: "missing",
          diagnostic: executable.diagnostic,
          installCommand: CURSOR_CLI_INSTALL_COMMAND,
        };
      }
      const cached = readCached(statusCache, executable.path);
      if (cached) return cached;
      const result = await run([executable.path, "--version"], STATUS_TIMEOUT_MS);
      if (result.timedOut) {
        const stale = lastGoodStatus.get(executable.path);
        if (stale) {
          // 同样按短 TTL 缓存失败后的 last-good，否则设置页每次刷新都会重新 spawn 一次
          // --version，网络故障时反而放大启动风暴。
          writeCached(statusCache, executable.path, stale, negativeTtlMs);
          return stale;
        }
        const status: CursorCliStatus = {
          status: "timed-out",
          diagnostic: "cursor-agent --version timed out",
          installCommand: CURSOR_CLI_INSTALL_COMMAND,
        };
        writeCached(statusCache, executable.path, status, negativeTtlMs);
        return status;
      }
      const version = parseVersion(result.stdout, result.stderr);
      if (result.exitCode !== 0 || !version) {
        const stale = lastGoodStatus.get(executable.path);
        if (stale) {
          writeCached(statusCache, executable.path, stale, negativeTtlMs);
          return stale;
        }
        const status: CursorCliStatus = {
          status: "unavailable",
          diagnostic: diagnosticFrom(result) ?? "cursor-agent --version failed",
          installCommand: CURSOR_CLI_INSTALL_COMMAND,
        };
        writeCached(statusCache, executable.path, status, negativeTtlMs);
        return status;
      }
      const status: CursorCliStatus = {
        status: "available",
        version,
        executablePath: executable.path,
      };
      lastGoodStatus.set(executable.path, status);
      writeCached(statusCache, executable.path, status);
      return status;
    },

    listModels: async ({ cliPath } = {}): Promise<CursorCliModelCatalog> => {
      const executable = await resolveExecutable(cliPath);
      if (!executable.ok) {
        return { status: "unavailable", diagnostic: executable.diagnostic };
      }
      const cached = readCached(catalogCache, executable.path);
      if (cached) return cached;
      const attempts: readonly (readonly string[])[] = [
        [executable.path, "models"],
        [executable.path, "--list-models"],
      ];
      let last: CursorCliCommandResult | undefined;
      for (const args of attempts) {
        const result = await run(args, CATALOG_TIMEOUT_MS);
        last = result;
        if (result.timedOut) {
          const stale = lastGoodCatalog.get(executable.path);
          if (stale) {
            writeCached(catalogCache, executable.path, stale, negativeTtlMs);
            return stale;
          }
          const catalog: CursorCliModelCatalog = {
            status: "timed-out",
            diagnostic: `cursor-agent ${args.slice(1).join(" ")} timed out`,
          };
          writeCached(catalogCache, executable.path, catalog, negativeTtlMs);
          return catalog;
        }
        if (result.exitCode !== 0) continue;
        const models = parseCursorModelCatalog(result.stdout);
        if (models.length > 0) {
          const catalog: CursorCliModelCatalog = {
            status: "available",
            models,
            authentication: "not-checked",
          };
          lastGoodCatalog.set(executable.path, catalog);
          writeCached(catalogCache, executable.path, catalog);
          return catalog;
        }
      }
      // Официальный формат вывода не документирован: пустой/неузнанный список не должен
      // оставлять провайдера без моделей, иначе Composer теряет выбранный Cursor CLI.
      if (last && last.exitCode === 0) {
        const catalog: CursorCliModelCatalog = {
          status: "available",
          models: [...CURSOR_BASELINE_MODELS],
          authentication: "not-checked",
        };
        lastGoodCatalog.set(executable.path, catalog);
        writeCached(catalogCache, executable.path, catalog);
        return catalog;
      }
      const stale = lastGoodCatalog.get(executable.path);
      if (stale) {
        writeCached(catalogCache, executable.path, stale, negativeTtlMs);
        return stale;
      }
      const catalog: CursorCliModelCatalog = {
        status: "unavailable",
        diagnostic: (last && diagnosticFrom(last)) ?? "cursor-agent model listing failed",
      };
      writeCached(catalogCache, executable.path, catalog, negativeTtlMs);
      return catalog;
    },

    installCli: async (): Promise<CursorCliInstallResult> => {
      // Windows installer is a different (PowerShell) flow that this Host does not drive.
      if (process.platform === "win32") {
        return {
          status: "failed",
          diagnostic: "install-platform-unsupported",
          installCommand: CURSOR_CLI_INSTALL_COMMAND,
        };
      }
      const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
      const result = await run([shell, "-lc", CURSOR_CLI_INSTALL_COMMAND], INSTALL_TIMEOUT_MS);
      if (result.timedOut) {
        return {
          status: "failed",
          diagnostic: "install-timeout",
          installCommand: CURSOR_CLI_INSTALL_COMMAND,
        };
      }
      if (result.spawnError || result.exitCode !== 0) {
        return {
          status: "failed",
          diagnostic: "install-failed",
          installCommand: CURSOR_CLI_INSTALL_COMMAND,
        };
      }
      // Installer exit code alone is not evidence: the binary must resolve and answer --version.
      const executable = await resolveExecutable();
      const verifyFailed: CursorCliInstallResult = {
        status: "failed",
        diagnostic: "install-verification-failed",
        installCommand: CURSOR_CLI_INSTALL_COMMAND,
      };
      if (!executable.ok) return verifyFailed;
      const verify = await run([executable.path, "--version"], STATUS_TIMEOUT_MS);
      if (verify.timedOut) return verifyFailed;
      const version = parseVersion(verify.stdout, verify.stderr);
      if (verify.exitCode !== 0 || !version) return verifyFailed;
      statusCache.clear();
      catalogCache.clear();
      return { status: "installed", version, executablePath: executable.path };
    },
  };
}
