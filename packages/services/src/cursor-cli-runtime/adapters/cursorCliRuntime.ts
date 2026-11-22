import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  /**
   * Optional JSON file for the last successful status/catalog. It makes a cold app start
   * instant and keeps the selected Cursor model alive when the CLI/network is temporarily
   * unavailable; the background refresh still replaces it after the TTL.
   */
  persistPath?: string;
  now?: () => number;
}

interface PersistedCursorCliCache {
  readonly version: 1;
  readonly executablePath: string;
  readonly status?: CursorCliStatus;
  readonly catalog?: CursorCliModelCatalog;
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
  const persistPath = options.persistPath;
  const isAvailableStatus = (
    value: unknown,
  ): value is Extract<CursorCliStatus, { status: "available" }> => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (
      record.status === "available" &&
      typeof record.version === "string" &&
      typeof record.executablePath === "string"
    );
  };
  const isAvailableCatalog = (
    value: unknown,
  ): value is Extract<CursorCliModelCatalog, { status: "available" }> => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (
      record.status === "available" &&
      Array.isArray(record.models) &&
      record.models.every(
        (model) =>
          !!model &&
          typeof model === "object" &&
          typeof (model as Record<string, unknown>).modelId === "string" &&
          typeof (model as Record<string, unknown>).name === "string",
      )
    );
  };
  let persistedLoad: Promise<void> | undefined;
  const ensurePersistedLoaded = (): Promise<void> => {
    if (!persistPath) return Promise.resolve();
    persistedLoad ??= (async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(persistPath, "utf8"));
        if (!parsed || typeof parsed !== "object") return;
        const record = parsed as Partial<PersistedCursorCliCache>;
        if (record.version !== 1 || typeof record.executablePath !== "string") return;
        if (!isAvailableStatus(record.status)) return;
        if (record.status.executablePath !== record.executablePath) return;
        lastGoodStatus.set(record.executablePath, record.status);
        writeCached(statusCache, record.executablePath, record.status);
        if (isAvailableCatalog(record.catalog)) {
          lastGoodCatalog.set(record.executablePath, record.catalog);
          writeCached(catalogCache, record.executablePath, record.catalog);
        }
      } catch {
        // Отсутствующий/повреждённый кэш не должен мешать обычной проверке CLI.
      }
    })();
    return persistedLoad;
  };
  let persistChain: Promise<void> = Promise.resolve();
  const persist = (executablePath: string): void => {
    if (!persistPath) return;
    const status = lastGoodStatus.get(executablePath);
    if (!isAvailableStatus(status)) return;
    const catalog = lastGoodCatalog.get(executablePath);
    const payload: PersistedCursorCliCache = {
      version: 1,
      executablePath,
      status,
      ...(isAvailableCatalog(catalog) ? { catalog } : {}),
    };
    persistChain = persistChain
      .then(async () => {
        await mkdir(dirname(persistPath), { recursive: true });
        const temporaryPath = `${persistPath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
        await rename(temporaryPath, persistPath);
      })
      .catch(() => undefined);
  };

  const statusRefreshes = new Map<string, Promise<CursorCliStatus>>();
  const refreshStatus = (executablePath: string): Promise<CursorCliStatus> => {
    const existing = statusRefreshes.get(executablePath);
    if (existing) return existing;
    const refresh = (async (): Promise<CursorCliStatus> => {
      const result = await run([executablePath, "--version"], STATUS_TIMEOUT_MS);
      if (!result.timedOut) {
        const version = parseVersion(result.stdout, result.stderr);
        if (result.exitCode === 0 && version) {
          const status: CursorCliStatus = {
            status: "available",
            version,
            executablePath,
          };
          lastGoodStatus.set(executablePath, status);
          writeCached(statusCache, executablePath, status);
          persist(executablePath);
          return status;
        }
      }
      const stale = lastGoodStatus.get(executablePath);
      if (stale) {
        // 失败时 last-good 也进入短 TTL：设置页刷新不能反复 spawn --version。
        writeCached(statusCache, executablePath, stale, negativeTtlMs);
        return stale;
      }
      const status: CursorCliStatus = result.timedOut
        ? {
            status: "timed-out",
            diagnostic: "cursor-agent --version timed out",
            installCommand: CURSOR_CLI_INSTALL_COMMAND,
          }
        : {
            status: "unavailable",
            diagnostic: diagnosticFrom(result) ?? "cursor-agent --version failed",
            installCommand: CURSOR_CLI_INSTALL_COMMAND,
          };
      writeCached(statusCache, executablePath, status, negativeTtlMs);
      return status;
    })().finally(() => {
      statusRefreshes.delete(executablePath);
    });
    statusRefreshes.set(executablePath, refresh);
    return refresh;
  };

  const catalogRefreshes = new Map<string, Promise<CursorCliModelCatalog>>();
  const refreshCatalog = (executablePath: string): Promise<CursorCliModelCatalog> => {
    const existing = catalogRefreshes.get(executablePath);
    if (existing) return existing;
    const refresh = (async (): Promise<CursorCliModelCatalog> => {
      const attempts: readonly (readonly string[])[] = [
        [executablePath, "models"],
        [executablePath, "--list-models"],
      ];
      let last: CursorCliCommandResult | undefined;
      for (const args of attempts) {
        const result = await run(args, CATALOG_TIMEOUT_MS);
        last = result;
        if (result.timedOut) break;
        if (result.exitCode !== 0) continue;
        const models = parseCursorModelCatalog(result.stdout);
        if (models.length > 0) {
          const catalog: CursorCliModelCatalog = {
            status: "available",
            models,
            authentication: "not-checked",
          };
          lastGoodCatalog.set(executablePath, catalog);
          writeCached(catalogCache, executablePath, catalog);
          persist(executablePath);
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
        lastGoodCatalog.set(executablePath, catalog);
        writeCached(catalogCache, executablePath, catalog);
        persist(executablePath);
        return catalog;
      }
      const stale = lastGoodCatalog.get(executablePath);
      if (stale) {
        writeCached(catalogCache, executablePath, stale, negativeTtlMs);
        return stale;
      }
      const catalog: CursorCliModelCatalog = last?.timedOut
        ? { status: "timed-out", diagnostic: "cursor-agent model listing timed out" }
        : {
            status: "unavailable",
            diagnostic: (last && diagnosticFrom(last)) ?? "cursor-agent model listing failed",
          };
      writeCached(catalogCache, executablePath, catalog, negativeTtlMs);
      return catalog;
    })().finally(() => {
      catalogRefreshes.delete(executablePath);
    });
    catalogRefreshes.set(executablePath, refresh);
    return refresh;
  };

  return {
    getCliStatus: async ({ cliPath } = {}): Promise<CursorCliStatus> => {
      await ensurePersistedLoaded();
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
      const stale = lastGoodStatus.get(executable.path);
      if (stale) {
        // Холодный старт/открытие чата не должны ждать сеть: отдаём last-good и обновляем фоном.
        void refreshStatus(executable.path).catch(() => undefined);
        return stale;
      }
      return refreshStatus(executable.path);
    },

    listModels: async ({ cliPath } = {}): Promise<CursorCliModelCatalog> => {
      await ensurePersistedLoaded();
      const executable = await resolveExecutable(cliPath);
      if (!executable.ok) {
        return { status: "unavailable", diagnostic: executable.diagnostic };
      }
      const cached = readCached(catalogCache, executable.path);
      if (cached) return cached;
      const stale = lastGoodCatalog.get(executable.path);
      if (stale) {
        void refreshCatalog(executable.path).catch(() => undefined);
        return stale;
      }
      return refreshCatalog(executable.path);
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
      lastGoodStatus.clear();
      lastGoodCatalog.clear();
      if (persistPath) await rm(persistPath, { force: true }).catch(() => undefined);
      return { status: "installed", version, executablePath: executable.path };
    },
  };
}
