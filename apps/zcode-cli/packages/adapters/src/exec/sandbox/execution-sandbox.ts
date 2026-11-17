/**
 * Реализация `ExecutionSandbox`.
 *
 * Ключевое решение: обёртка никогда не «делает вид», что изоляция есть. Если
 * bwrap/Seatbelt недоступен, включается `degraded` — режим реальной, но более
 * слабой защиты:
 *   - рабочий каталог принудительно равен workspace (нельзя уйти в `/`),
 *   - окружение собирается только из whitelist (нет наследования секретов),
 *   - лимиты применяются через `sh -c 'ulimit ...'`,
 *   - политика `strict-offline` деградирует с явной причиной, поскольку без
 *     неймспейса сеть запретить нельзя.
 * В результате инструмент всегда получает честный `sandboxMode` и причину.
 */
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  SANDBOX_ENV_WHITELIST,
  SANDBOX_PROBE_TTL_MS,
  type ExecutionSandboxContract,
  type ProcessTreeKillOptions,
  type ProcessTreeKillResult,
  type SandboxCapability,
  type SandboxCommand,
  type SandboxLimits,
  type SandboxPolicy,
  type SandboxedCommand,
} from "./contract.js";
import { SandboxCapabilityCache, probeSandboxCapability } from "./capability-probe.js";
import { buildBwrapCommand, wrapCommandWithLimits } from "./linux-bwrap.js";
import { buildSeatbeltCommand } from "./macos-seatbelt.js";
import { killProcessTree } from "./process-group-killer.js";

export interface ExecutionSandboxOptions {
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  /** Собственный пробник — для тестов и для хоста, который хочет свой кэш. */
  probe?: () => Promise<SandboxCapability>;
  /** Проверка существования пути; подменяется в тестах. */
  exists?: (path: string) => boolean;
  /** Режим по умолчанию для новых вызовов: политика хоста. */
  defaultProfile?: SandboxPolicy["profile"];
}

/**
 * Собирает окружение только из whitelist. Пустые значения отбрасываются:
 * `FOO=` внутри `bwrap --setenv` неотличим от отсутствия переменной для shell.
 */
export function buildSandboxEnv(
  sourceEnv: NodeJS.ProcessEnv,
  policy: SandboxPolicy,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!policy.envIsolated) {
    for (const key of SANDBOX_ENV_WHITELIST) {
      const value = sourceEnv[key];
      if (value !== undefined && value !== "") env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(policy.env ?? {})) {
    env[key] = value;
  }
  return env;
}

/** `true`, если путь лежит внутри корня (учитывая равенство). */
export function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Degraded-режим: реальная защита доступного уровня.
 *
 * Здесь нет иллюзии изоляции: файловая система не изолирована, поэтому
 * `filesystemIsolated: false`, а `strict-offline` честно отмечается как
 * недостижимый в причине.
 */
export function buildDegradedCommand(
  command: SandboxCommand,
  policy: SandboxPolicy,
  options: {
    env: Record<string, string>;
    reason: string;
    exists?: (path: string) => boolean;
  },
): SandboxedCommand {
  // Причина: без неймспейса нельзя гарантировать запрет сети. Политика
  // сохраняется как запрос, но результат честно сообщает об отсутствии изоляции.
  const limited = wrapCommandWithLimits(command, policy.limits ?? {});
  return {
    file: limited.file,
    args: limited.args,
    env: options.env,
    cwd: policy.cwd,
    sandboxMode: "degraded",
    sandboxReason: options.reason,
    limits: policy.limits ?? {},
    filesystemIsolated: false,
    networkIsolated: false,
  };
}

export class ExecutionSandbox implements ExecutionSandboxContract {
  private readonly cache: SandboxCapabilityCache;
  private readonly platform: NodeJS.Platform;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly exists: (path: string) => boolean;

  constructor(options: ExecutionSandboxOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.processEnv = options.processEnv ?? process.env;
    this.exists = options.exists ?? existsSync;
    this.cache = new SandboxCapabilityCache(
      options.probe ??
        (() =>
          probeSandboxCapability({
            platform: this.platform,
            exists: async (path) => this.exists(path),
          })),
    );
  }

  async probe(options: { force?: boolean; ttlMs?: number } = {}): Promise<SandboxCapability> {
    return this.cache.get({ ttlMs: SANDBOX_PROBE_TTL_MS, ...options });
  }

  async wrap(command: SandboxCommand, policy: SandboxPolicy): Promise<SandboxedCommand> {
    const resolvedPolicy = this.normalizePolicy(policy);
    const env = buildSandboxEnv(this.processEnv, resolvedPolicy);
    const profile = resolvedPolicy.profile ?? "workspace-write";

    if (profile === "off" || this.platform === "win32") {
      // Windows: существующий путь исполнения сохраняется; явно сообщаем, что
      // ОС-песочницы нет, вместо тихой подмены семантики.
      return {
        file: command.file,
        args: [...command.args],
        env,
        cwd: resolvedPolicy.cwd,
        sandboxMode: this.platform === "win32" ? "none" : "degraded",
        sandboxReason:
          profile === "off"
            ? "sandbox profile is off"
            : "OS-level sandbox is not available on win32",
        limits: resolvedPolicy.limits ?? {},
        filesystemIsolated: false,
        networkIsolated: false,
      };
    }

    const capability = await this.probe();
    const buildInput = {
      command,
      policy: resolvedPolicy,
      capability,
      exists: this.exists,
    };

    const built =
      capability.mode === "bwrap"
        ? buildBwrapCommand(buildInput)
        : capability.mode === "seatbelt"
          ? buildSeatbeltCommand(buildInput)
          : { reason: capability.reason ?? "no sandbox mechanism available" };

    if (built.command) return built.command;
    return buildDegradedCommand(command, resolvedPolicy, {
      env,
      reason: built.reason ?? "sandbox mechanism unavailable",
      exists: this.exists,
    });
  }

  async killTree(
    rootPid: number,
    options: ProcessTreeKillOptions = {},
  ): Promise<ProcessTreeKillResult> {
    return killProcessTree(rootPid, { platform: this.platform, ...options });
  }

  /**
   * Приводит политику к безопасному виду: `cwd` не выходит за workspace,
   * writable-корни не дублируются, лимиты нормализуются.
   */
  private normalizePolicy(policy: SandboxPolicy): SandboxPolicy {
    const workspacePath = resolve(policy.workspacePath);
    // Причина: degraded-режим опирается на cwd как на границу. Если cwd вне
    // workspace, деградация теряет смысл, поэтому cwd схлопывается в корень.
    const cwd = isPathInside(policy.cwd, workspacePath) ? resolve(policy.cwd) : workspacePath;
    const writableRoots = [...new Set((policy.writableRoots ?? []).map((root) => resolve(root)))];
    const readOnlyRoots = [...new Set((policy.readOnlyRoots ?? []).map((root) => resolve(root)))];
    const cwdCaptureDir = policy.cwdCaptureDir ? resolve(policy.cwdCaptureDir) : undefined;
    const limits = normalizeLimits(policy.limits);
    return {
      ...policy,
      cwd,
      workspacePath,
      ...(writableRoots.length > 0 ? { writableRoots } : {}),
      ...(readOnlyRoots.length > 0 ? { readOnlyRoots } : {}),
      ...(cwdCaptureDir ? { cwdCaptureDir } : {}),
      ...(limits ? { limits } : {}),
    };
  }
}

function normalizeLimits(limits: SandboxLimits | undefined): SandboxLimits | undefined {
  if (!limits) return undefined;
  const normalized: SandboxLimits = {};
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  const cpuSeconds = positive(limits.cpuSeconds);
  const memoryBytes = positive(limits.memoryBytes);
  const maxProcesses = positive(limits.maxProcesses);
  const maxFileSizeBytes = positive(limits.maxFileSizeBytes);
  if (cpuSeconds !== undefined) normalized.cpuSeconds = cpuSeconds;
  if (memoryBytes !== undefined) normalized.memoryBytes = memoryBytes;
  if (maxProcesses !== undefined) normalized.maxProcesses = maxProcesses;
  if (maxFileSizeBytes !== undefined) normalized.maxFileSizeBytes = maxFileSizeBytes;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Фабрика по умолчанию: реальный пробник, реальные механизмы. */
export function createExecutionSandbox(
  options: ExecutionSandboxOptions = {},
): ExecutionSandbox {
  return new ExecutionSandbox(options);
}

export { killProcessTree, isProcessGroupAlive, isProcessAlive } from "./process-group-killer.js";
export { probeSandboxCapability, SandboxCapabilityCache } from "./capability-probe.js";
export { buildBwrapCommand, buildLimitCommand, resolveProtectedPaths } from "./linux-bwrap.js";
export { buildSeatbeltProfile, buildSeatbeltCommand } from "./macos-seatbelt.js";
