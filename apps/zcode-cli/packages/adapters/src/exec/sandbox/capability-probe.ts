/**
 * Реальное зондирование механизма изоляции.
 *
 * Ничего не предполагается «по платформе»: на Linux недостаточно наличия `bwrap`, нужно
 * убедиться, что непривилегированные user namespaces действительно работают (в части
 * дистрибутивов их блокирует AppArmor или `kernel.unprivileged_userns_clone=0`).
 * Поэтому probe делает настоящий пробный запуск и разбирает stderr при отказе.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

import { SANDBOX_PROBE_TTL_MS, type SandboxCapability } from "./contract.js";

const PROBE_TIMEOUT_MS = 5_000;
const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];
const SANDBOX_EXEC_CANDIDATES = ["/usr/bin/sandbox-exec", "/bin/sandbox-exec"];

export interface ProbeRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

export interface ProbeInternals {
  platform?: NodeJS.Platform;
  exists?: (path: string) => Promise<boolean>;
  run?: (file: string, args: readonly string[]) => Promise<ProbeRunResult>;
}

/** Находит первый существующий кандидат; `undefined`, если ни один не доступен. */
async function findExecutable(
  candidates: readonly string[],
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRun(file: string, args: readonly string[]): Promise<ProbeRunResult> {
  return new Promise<ProbeRunResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result: ProbeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Процесс мог завершиться между таймаутом и kill.
      }
      finish({ code: null, signal: null, stdout, stderr, timedOut: true });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish({ code: null, signal: null, stdout, stderr, timedOut: false, spawnError: error });
    });
    child.once("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut: false });
    });
  });
}

/** Минимальный профиль Seatbelt, доказывающий, что `sandbox-exec` исполняет процессы. */
export const SEATBELT_PROBE_PROFILE = "(version 1)\n(allow default)\n";

/** argv, доказывающий, что bwrap реально создаёт изолированный PID-неймспейс. */
export function createBwrapProbeArgs(): string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-pid",
    "--die-with-parent",
    "--",
    "/bin/true",
  ];
}

/** argv, доказывающий, что `--unshare-net` принимается ядром. */
export function createBwrapNetworkProbeArgs(): string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-net",
    "--",
    "/bin/true",
  ];
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

async function probeLinux(internals: {
  exists: (path: string) => Promise<boolean>;
  run: (file: string, args: readonly string[]) => Promise<ProbeRunResult>;
}): Promise<Pick<SandboxCapability, "mode" | "available" | "version" | "reason" | "supportedFlags">> {
  const binary = await findExecutable(BWRAP_CANDIDATES, internals.exists);
  if (!binary) {
    return {
      mode: "degraded",
      available: false,
      reason: "bubblewrap (bwrap) is not installed",
      supportedFlags: [],
    };
  }

  const versionRun = await internals.run(binary, ["--version"]);
  const version = versionRun.code === 0 ? firstLine(versionRun.stdout) || undefined : undefined;
  const selfTest = await internals.run(binary, createBwrapProbeArgs());

  if (selfTest.spawnError) {
    return {
      mode: "degraded",
      available: false,
      version,
      reason: `bwrap is not executable: ${selfTest.spawnError.message}`,
      supportedFlags: [],
    };
  }
  if (selfTest.timedOut || selfTest.code !== 0) {
    const detail = firstLine(selfTest.stderr);
    return {
      mode: "degraded",
      available: false,
      version,
      reason: selfTest.timedOut
        ? "bwrap self-test timed out"
        : `bwrap self-test failed${detail ? `: ${detail}` : ` (exit ${selfTest.code ?? "signal"})`}`,
      supportedFlags: [],
    };
  }

  const supportedFlags = [
    "--ro-bind",
    "--bind",
    "--dev",
    "--proc",
    "--tmpfs",
    "--die-with-parent",
    "--unshare-pid",
    "--unshare-ipc",
    "--chdir",
    "--setenv",
  ];
  const networkProbe = await internals.run(binary, createBwrapNetworkProbeArgs());
  if (networkProbe.code === 0 && !networkProbe.timedOut) supportedFlags.push("--unshare-net");

  return {
    mode: "bwrap",
    available: true,
    version,
    supportedFlags,
  };
}

async function probeMacos(internals: {
  exists: (path: string) => Promise<boolean>;
  run: (file: string, args: readonly string[]) => Promise<ProbeRunResult>;
}): Promise<Pick<SandboxCapability, "mode" | "available" | "version" | "reason" | "supportedFlags">> {
  const binary = await findExecutable(SANDBOX_EXEC_CANDIDATES, internals.exists);
  if (!binary) {
    return {
      mode: "degraded",
      available: false,
      reason: "sandbox-exec (Seatbelt) is not available",
      supportedFlags: [],
    };
  }

  const selfTest = await internals.run(binary, ["-p", SEATBELT_PROBE_PROFILE, "/usr/bin/true"]);
  if (selfTest.code !== 0 || selfTest.timedOut) {
    const detail = firstLine(selfTest.stderr);
    return {
      mode: "degraded",
      available: false,
      reason: selfTest.timedOut
        ? "sandbox-exec self-test timed out"
        : `sandbox-exec self-test failed${detail ? `: ${detail}` : ""}`,
      supportedFlags: [],
    };
  }

  return {
    mode: "seatbelt",
    available: true,
    supportedFlags: ["-p", "-f", "-D"],
  };
}

/**
 * Выполняет реальное зондирование. Функция никогда не бросает: любая проблема
 * превращается в `available: false` с причиной.
 */
export async function probeSandboxCapability(
  internals: ProbeInternals = {},
): Promise<SandboxCapability> {
  const startedAt = Date.now();
  const platform = internals.platform ?? process.platform;
  const exists = internals.exists ?? defaultExists;
  const run = internals.run ?? defaultRun;

  try {
    const probed =
      platform === "linux"
        ? await probeLinux({ exists, run })
        : platform === "darwin"
          ? await probeMacos({ exists, run })
          : {
              mode: "degraded" as const,
              available: false,
              reason: `OS-level sandbox is not supported on ${platform}`,
              supportedFlags: [] as string[],
            };

    return { ...probed, probedAt: startedAt, probeDurationMs: Math.max(0, Date.now() - startedAt) };
  } catch (error) {
    return {
      mode: "degraded",
      available: false,
      reason: `sandbox probe failed: ${error instanceof Error ? error.message : String(error)}`,
      supportedFlags: [],
      probedAt: startedAt,
      probeDurationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

/** Кэш зондирования: один процесс — один реальный самотест в пределах TTL. */
export class SandboxCapabilityCache {
  private capability?: SandboxCapability;
  private expiresAt = 0;

  constructor(
    private readonly probe: () => Promise<SandboxCapability> = () => probeSandboxCapability(),
  ) {}

  async get(options: { force?: boolean; ttlMs?: number } = {}): Promise<SandboxCapability> {
    const now = Date.now();
    if (!options.force && this.capability && now < this.expiresAt) return this.capability;
    const capability = await this.probe();
    this.capability = capability;
    this.expiresAt = now + (options.ttlMs ?? SANDBOX_PROBE_TTL_MS);
    return capability;
  }

  /** Сбрасывает кэш; следующий `get()` выполнит реальное зондирование. */
  invalidate(): void {
    this.capability = undefined;
    this.expiresAt = 0;
  }
}
