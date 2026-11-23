import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getZCodeDataRootDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  LocalEmbeddingInstallResult,
  LocalEmbeddingPullResult,
  LocalEmbeddingRuntimeStatus,
} from "./localEmbeddingContract.js";

const log = createServiceLogger("local-embeddings");
const RELEASE_BASE = "https://github.com/ollama/ollama/releases/latest/download";
const OLLAMA_HOST = "127.0.0.1:11434";
const OLLAMA_ENDPOINT = `http://${OLLAMA_HOST}`;
const READY_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const MAX_COMMAND_OUTPUT = 32_000;
const MAX_MODEL_NAME = 120;
const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)?$/u;

const RECOMMENDED_SMALL = {
  model: "nomic-embed-text",
  dimensions: 768,
  downloadBytes: 274_000_000,
  reason:
    "Best quality/size trade-off for code and mixed English/Russian documentation on a 16 GB machine.",
} as const;
const RECOMMENDED_LARGE = {
  model: "bge-m3",
  dimensions: 1024,
  downloadBytes: 1_200_000_000,
  reason:
    "Multilingual retrieval with stronger Russian coverage; recommended when at least 24 GB of RAM is available.",
} as const;

export interface LocalEmbeddingRuntimeOptions {
  /** Override the managed tools directory (tests). */
  toolsRoot?: string;
  /** Override the platform binary lookup (tests). */
  binaryPath?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  totalMemoryBytes?: () => number;
  /** Tests: skip system-wide binaries and exercise the managed install path only. */
  allowSystemBinary?: boolean;
}

interface RuntimeArchive {
  readonly fileName: string;
  readonly kind: "tgz" | "tar.zst" | "zip";
}

function archiveForPlatform(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): RuntimeArchive | undefined {
  if (platform === "darwin") return { fileName: "ollama-darwin.tgz", kind: "tgz" };
  if (platform === "linux") {
    const target = arch === "arm64" ? "arm64" : "amd64";
    return { fileName: `ollama-linux-${target}.tar.zst`, kind: "tar.zst" };
  }
  if (platform === "win32") {
    const target = arch === "arm64" ? "arm64" : "amd64";
    return { fileName: `ollama-windows-${target}.zip`, kind: "zip" };
  }
  return undefined;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ollama.exe" : "ollama";
}

async function findBinary(directory: string, name: string, depth = 2): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = await findBinary(candidate, name, depth - 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(env ? { env } : {}),
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.slice(0, MAX_COMMAND_OUTPUT);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_COMMAND_OUTPUT) stderr += chunk.slice(0, MAX_COMMAND_OUTPUT);
    });
    child.once("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)/u.exec(output)?.[1];
}

function normalizeModelId(name: string): string {
  return name
    .trim()
    .replace(/:latest$/u, "")
    .toLowerCase();
}

/** List Ollama manifests without starting the server; works while runtime is stopped. */
async function listInstalledModels(
  toolsRoot: string,
): Promise<Array<{ id: string; sizeBytes?: number }>> {
  const root = join(toolsRoot, "models", "manifests");
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await walk(root);
  const models = new Map<string, { id: string; sizeBytes?: number }>();
  for (const file of files) {
    const segments = file.slice(root.length + 1).split(/[\\/]/u);
    if (segments.length < 4) continue;
    const [registry, namespace, model, tag] = segments.slice(-4);
    if (!registry || !namespace || !model || !tag) continue;
    const id = normalizeModelId(
      namespace === "library"
        ? tag === "latest"
          ? model
          : `${model}:${tag}`
        : `${namespace}/${model}:${tag}`,
    );
    if (id) models.set(id, { id });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function createLocalEmbeddingRuntime(options: LocalEmbeddingRuntimeOptions = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const toolsRoot = options.toolsRoot ?? join(getZCodeDataRootDir(), "tools", "local-embeddings");
  const fetchImpl = options.fetch ?? fetch;
  const totalMemoryBytes = (options.totalMemoryBytes ?? totalmem)();
  const recommended = totalMemoryBytes >= 16 * 1024 ** 3 ? RECOMMENDED_LARGE : RECOMMENDED_SMALL;
  let binaryPath: string | undefined;
  let serverChild: ReturnType<typeof spawn> | undefined;
  let installing: Promise<LocalEmbeddingInstallResult> | undefined;
  let starting: Promise<boolean> | undefined;
  const pulls = new Map<string, Promise<LocalEmbeddingPullResult>>();
  let disposed = false;

  const managedBinaryPath = (): string => join(toolsRoot, "runtime", binaryName(platform));

  const resolveBinary = async (): Promise<string | undefined> => {
    if (binaryPath) return binaryPath;
    const override = options.binaryPath?.trim();
    if (override && existsSync(override)) {
      binaryPath = override;
      return binaryPath;
    }
    const candidates = [
      managedBinaryPath(),
      join(toolsRoot, "ollama", binaryName(platform)),
      ...(options.allowSystemBinary === false
        ? []
        : ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/usr/bin/ollama"]),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        binaryPath = candidate;
        return candidate;
      }
    }
    const managed = await findBinary(join(toolsRoot, "runtime"), binaryName(platform));
    if (managed) {
      binaryPath = managed;
      return managed;
    }
    return undefined;
  };

  const versionOf = async (binary: string): Promise<string | undefined> => {
    const result = await run(binary, ["--version"], VERSION_TIMEOUT_MS);
    if (result.code !== 0) return undefined;
    return parseVersion(`${result.stdout}\n${result.stderr}`);
  };

  const serverEnvironment = (): NodeJS.ProcessEnv => ({
    ...process.env,
    OLLAMA_HOST,
    OLLAMA_MODELS: join(toolsRoot, "models"),
    NO_COLOR: "1",
  });

  const probe = async (): Promise<
    { running: true; models: Array<{ id: string; sizeBytes?: number }> } | { running: false }
  > => {
    try {
      const response = await fetchImpl(`${OLLAMA_ENDPOINT}/api/tags`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return { running: false };
      const payload = (await response.json()) as {
        models?: Array<{ name?: string; size?: number }>;
      };
      const models: Array<{ id: string; sizeBytes?: number }> = [];
      for (const model of payload.models ?? []) {
        const id = typeof model.name === "string" ? normalizeModelId(model.name) : "";
        if (!id) continue;
        models.push({
          id,
          ...(typeof model.size === "number" ? { sizeBytes: model.size } : {}),
        });
      }
      return { running: true, models };
    } catch {
      return { running: false };
    }
  };

  const ensureServer = async (): Promise<boolean> => {
    if (disposed) return false;
    const current = await probe();
    if (current.running) return true;
    if (starting) return starting;
    starting = (async () => {
      const binary = await resolveBinary();
      if (!binary) return false;
      await mkdir(join(toolsRoot, "models"), { recursive: true });
      serverChild = spawn(binary, ["serve"], {
        stdio: "ignore",
        windowsHide: true,
        detached: false,
        env: serverEnvironment(),
      });
      serverChild.on("error", () => {
        serverChild = undefined;
      });
      serverChild.on("exit", () => {
        serverChild = undefined;
      });
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline && !disposed) {
        const result = await probe();
        if (result.running) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const download = async (archive: RuntimeArchive): Promise<string> => {
    const temporaryDirectory = join(toolsRoot, "downloads");
    await mkdir(temporaryDirectory, { recursive: true });
    const archivePath = join(temporaryDirectory, archive.fileName);
    const response = await fetchImpl(`${RELEASE_BASE}/${archive.fileName}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`download-failed-${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));
    return archivePath;
  };

  const extract = async (
    archivePath: string,
    archive: RuntimeArchive,
    destination: string,
  ): Promise<void> => {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    if (archive.kind === "tgz") {
      const result = await run("tar", ["-xzf", archivePath, "-C", destination], 120_000);
      if (result.code !== 0) throw new Error("extract-failed");
      return;
    }
    if (archive.kind === "tar.zst") {
      const result = await run("tar", ["--zstd", "-xf", archivePath, "-C", destination], 120_000);
      if (result.code !== 0) throw new Error("extract-failed-zstd");
      return;
    }
    const escapedArchive = archivePath.replaceAll("'", "''");
    const escapedDestination = destination.replaceAll("'", "''");
    const result = await run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
      ],
      180_000,
    );
    if (result.code !== 0) throw new Error("extract-failed-zip");
  };

  const install = async (): Promise<LocalEmbeddingInstallResult> => {
    const existing = await resolveBinary();
    if (existing) {
      const version = await versionOf(existing);
      return { status: "already-installed", ...(version ? { version } : {}) };
    }
    const archive = archiveForPlatform(platform, arch);
    if (!archive) {
      return {
        status: "failed",
        diagnostic: `local-embedding-runtime-unsupported:${platform}/${arch}`,
      };
    }
    try {
      const archivePath = await download(archive);
      const destination = join(toolsRoot, "runtime");
      await extract(archivePath, archive, destination);
      const installed = await findBinary(destination, binaryName(platform));
      if (!installed) return { status: "failed", diagnostic: "runtime-binary-missing" };
      if (platform !== "win32") await chmod(installed, 0o755).catch(() => undefined);
      const version = await versionOf(installed);
      if (!version) return { status: "failed", diagnostic: "runtime-version-failed" };
      binaryPath = installed;
      await rm(archivePath, { force: true }).catch(() => undefined);
      log.info("Local embedding runtime installed", { version, platform, arch });
      return { status: "installed", version };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      log.warn("Local embedding runtime install failed", { diagnostic });
      return { status: "failed", diagnostic: diagnostic.slice(0, 240) };
    }
  };

  const pull = async (modelValue: string): Promise<LocalEmbeddingPullResult> => {
    const model = modelValue.trim().toLowerCase();
    if (!model || model.length > MAX_MODEL_NAME || !MODEL_NAME_PATTERN.test(model)) {
      return { status: "failed", model, diagnostic: "invalid-model-name" };
    }
    const existing = pulls.get(model);
    if (existing) return existing;
    const task = (async (): Promise<LocalEmbeddingPullResult> => {
      const binary = await resolveBinary();
      if (!binary) return { status: "failed", model, diagnostic: "runtime-missing" };
      if (!(await ensureServer())) {
        return { status: "failed", model, diagnostic: "runtime-start-failed" };
      }
      const result = await run(binary, ["pull", model], PULL_TIMEOUT_MS, serverEnvironment());
      if (result.timedOut) return { status: "failed", model, diagnostic: "download-timeout" };
      if (result.code !== 0) {
        return {
          status: "failed",
          model,
          diagnostic: (result.stderr.trim() || result.stdout.trim() || "download-failed").slice(
            0,
            240,
          ),
        };
      }
      const installed = await probe();
      const present =
        installed.running && installed.models.some((entry) => normalizeModelId(entry.id) === model);
      if (!present) return { status: "failed", model, diagnostic: "model-not-listed" };
      log.info("Local embedding model installed", { model });
      return { status: "installed", model };
    })().finally(() => {
      pulls.delete(model);
    });
    pulls.set(model, task);
    return task;
  };

  return {
    async getStatus(): Promise<LocalEmbeddingRuntimeStatus> {
      const binary = await resolveBinary();
      const diskModels = await listInstalledModels(toolsRoot);
      if (!binary) {
        return {
          runtime: "ollama",
          installed: false,
          running: false,
          models: diskModels,
          totalMemoryBytes,
          recommended,
        };
      }
      const version = await versionOf(binary);
      const probed = await probe();
      const models = new Map(diskModels.map((model) => [model.id, model]));
      if (probed.running) for (const model of probed.models) models.set(model.id, model);
      return {
        runtime: "ollama",
        installed: true,
        running: probed.running,
        ...(version ? { version } : {}),
        models: [...models.values()],
        totalMemoryBytes,
        recommended,
      };
    },
    install(): Promise<LocalEmbeddingInstallResult> {
      installing ??= install().finally(() => {
        installing = undefined;
      });
      return installing;
    },
    start(): Promise<boolean> {
      return ensureServer();
    },
    pull,
    dispose(): void {
      disposed = true;
      if (serverChild) {
        try {
          serverChild.kill("SIGTERM");
        } catch {
          // Уже завершён.
        }
        serverChild = undefined;
      }
    },
  };
}

export type LocalEmbeddingRuntime = ReturnType<typeof createLocalEmbeddingRuntime>;
