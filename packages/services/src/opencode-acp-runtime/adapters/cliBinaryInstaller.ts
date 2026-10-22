import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { OpenCodeCliStatus, OpenCodeInstallCommandOutcome } from "../contract.js";
import type { OpenCodeCommandSpec } from "./cliResolver.js";
import {
  OPEN_CODE_CLI_RELEASE_VERSION,
  resolveOpenCodeCliReleaseAsset,
} from "./cliReleaseManifest.js";
import { terminateProcessTreeAndWait } from "#src/process/processTreeTerminator.js";

const MAX_RELEASE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const REDIRECT_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

type SpawnOptionsFactory = (
  cwd: string | undefined,
  stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "ignore"],
  sourceEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) => Parameters<typeof spawn>[2];

export async function downloadPinnedOpenCodeArchive(input: {
  url: string;
  expectedSha256: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let url = new URL(input.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  timer.unref?.();
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      if (url.protocol !== "https:" || !REDIRECT_HOSTS.has(url.hostname)) {
        throw new Error("download");
      }
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === 5) throw new Error("download");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error("download");
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_ARCHIVE_BYTES) {
        throw new Error("download");
      }
      if (!response.body) throw new Error("download");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        totalBytes += item.value.byteLength;
        if (totalBytes > MAX_RELEASE_ARCHIVE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("download");
        }
        chunks.push(item.value);
      }
      if (totalBytes === 0) throw new Error("download");
      const bytes = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes,
      );
      if (createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) {
        throw new Error("integrity");
      }
      return bytes;
    }
    throw new Error("download");
  } catch (error) {
    if (error instanceof Error && ["download", "integrity"].includes(error.message)) throw error;
    if (controller.signal.aborted) throw new Error("timeout");
    throw new Error("download");
  } finally {
    clearTimeout(timer);
  }
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([exit, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function archiveExtractor(input: {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  temporaryDirectory: string;
  archivePath: string;
  extractionDirectory: string;
}): { command: string; args: string[]; scriptPath?: string; script?: string } {
  if (input.platform === "darwin") {
    return {
      command: "/usr/bin/ditto",
      args: ["-x", "-k", input.archivePath, input.extractionDirectory],
    };
  }
  if (input.platform === "linux") {
    return {
      command: "tar",
      args: ["-xzf", input.archivePath, "-C", input.extractionDirectory, "--", "opencode"],
    };
  }
  if (input.platform === "win32") {
    const systemRoot = input.environment.SystemRoot || input.environment.WINDIR;
    if (!systemRoot) throw new Error("unsupported");
    const scriptPath = join(input.temporaryDirectory, "extract.ps1");
    return {
      command: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        scriptPath,
        input.archivePath,
        input.extractionDirectory,
      ],
      scriptPath,
      script:
        "param([string]$ArchivePath, [string]$DestinationPath)\n$ErrorActionPreference = 'Stop'\nExpand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force\n",
    };
  }
  throw new Error("unsupported");
}

export async function installOpenCodePinnedCli(input: {
  timeoutMs: number;
  sourceEnvironment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  linuxLibc?: "glibc" | "musl";
  runVersion: (
    spec: OpenCodeCommandSpec,
    sourceEnvironment: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<OpenCodeCliStatus>;
  makeSpawnOptions: SpawnOptionsFactory;
}): Promise<OpenCodeInstallCommandOutcome> {
  const asset = resolveOpenCodeCliReleaseAsset({
    platform: input.platform,
    architecture: input.architecture,
    linuxLibc: input.linuxLibc,
  });
  if (!asset) return { ok: false, diagnostic: "opencode.install-platform-unsupported" };
  if (
    input.platform === "win32" &&
    !input.sourceEnvironment.SystemRoot &&
    !input.sourceEnvironment.WINDIR
  ) {
    return { ok: false, diagnostic: "opencode.install-platform-unsupported" };
  }

  let temporaryDirectory: string | undefined;
  let activeChild: ReturnType<typeof spawn> | undefined;
  let installedDestinationPath: string | undefined;
  let stage: "download" | "temporary-write" | "archive" | "verification" | "destination" =
    "download";
  try {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-opencode-install-"));
    const archivePath = join(temporaryDirectory, asset.fileName);
    const extractionDirectory = join(temporaryDirectory, "extracted");
    const temporaryHome = join(temporaryDirectory, "home");
    await mkdir(extractionDirectory, { recursive: true, mode: 0o700 });
    await mkdir(temporaryHome, { recursive: true, mode: 0o700 });
    const isolatedEnvironment = {
      ...input.sourceEnvironment,
      HOME: temporaryHome,
      USERPROFILE: input.platform === "win32" ? temporaryHome : input.sourceEnvironment.USERPROFILE,
      TMPDIR: temporaryDirectory,
      TMP: temporaryDirectory,
      TEMP: temporaryDirectory,
      XDG_CONFIG_HOME: join(temporaryHome, ".config"),
      XDG_DATA_HOME: join(temporaryHome, ".local", "share"),
      XDG_CACHE_HOME: join(temporaryHome, ".cache"),
      XDG_STATE_HOME: join(temporaryHome, ".local", "state"),
    };
    const url = `https://github.com/anomalyco/opencode/releases/download/v${OPEN_CODE_CLI_RELEASE_VERSION}/${asset.fileName}`;
    const archive = await downloadPinnedOpenCodeArchive({
      url,
      expectedSha256: asset.sha256,
      timeoutMs: input.timeoutMs,
    });
    // Причина: digest уже проверен downloader-ом; запись временного архива не является ошибкой проверки SHA-256.
    stage = "temporary-write";
    await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });

    stage = "archive";
    const extractor = archiveExtractor({
      platform: input.platform,
      environment: input.sourceEnvironment,
      temporaryDirectory,
      archivePath,
      extractionDirectory,
    });
    if (extractor.scriptPath) {
      await writeFile(extractor.scriptPath, extractor.script ?? "", { flag: "wx", mode: 0o600 });
    }
    activeChild = spawn(
      extractor.command,
      extractor.args,
      input.makeSpawnOptions(
        undefined,
        ["ignore", "ignore", "ignore"],
        input.sourceEnvironment,
        input.platform,
      ),
    );
    const extractStatus = await waitForChildExit(activeChild, input.timeoutMs);
    activeChild = undefined;
    if (extractStatus !== 0) return { ok: false, diagnostic: "opencode.install-archive-invalid" };

    stage = "verification";
    const pathJoin = input.platform === "win32" ? win32.join : join;
    const stagedBinaryPath = pathJoin(extractionDirectory, asset.executableName);
    const binaryInfo = await stat(stagedBinaryPath).catch(() => null);
    if (!binaryInfo?.isFile() || binaryInfo.size === 0) {
      return { ok: false, diagnostic: "opencode.install-archive-invalid" };
    }
    if (input.platform !== "win32") await chmod(stagedBinaryPath, 0o755);
    const version = await input.runVersion(
      { command: stagedBinaryPath, prefixArgs: [] },
      isolatedEnvironment,
      input.platform,
    );
    const expectedVersion = new RegExp(
      `(?:^|\\s)v?${OPEN_CODE_CLI_RELEASE_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
      "u",
    );
    if (version.status !== "available" || !expectedVersion.test(version.version)) {
      if (version.status === "timed-out") {
        return { ok: false, diagnostic: "opencode.install-timeout" };
      }
      return { ok: false, diagnostic: "opencode.install-verification-failed" };
    }

    stage = "destination";
    const homeDirectory =
      input.platform === "win32"
        ? input.sourceEnvironment.USERPROFILE || input.sourceEnvironment.HOME || homedir()
        : input.sourceEnvironment.HOME || homedir();
    const destinationDirectory = pathJoin(homeDirectory, ".opencode", "bin");
    const destinationPath = pathJoin(destinationDirectory, asset.executableName);
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    // Причина: exclusive-create исключает перезапись работающего CLI при одновременной установке.
    await copyFile(stagedBinaryPath, destinationPath, constants.COPYFILE_EXCL);
    installedDestinationPath = destinationPath;
    if (input.platform !== "win32") await chmod(destinationPath, 0o755);
    installedDestinationPath = undefined;
    return { ok: true };
  } catch (error) {
    if (activeChild) await terminateProcessTreeAndWait(activeChild).catch(() => undefined);
    if (installedDestinationPath) await unlink(installedDestinationPath).catch(() => undefined);
    if (error instanceof Error && error.message === "timeout") {
      return { ok: false, diagnostic: "opencode.install-timeout" };
    }
    if (error instanceof Error && error.message === "integrity") {
      return { ok: false, diagnostic: "opencode.install-integrity-failed" };
    }
    if (
      stage === "destination" &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return { ok: false, diagnostic: "opencode.install-destination-conflict" };
    }
    const diagnostic =
      stage === "download"
        ? "opencode.install-download-failed"
        : stage === "temporary-write"
          ? "opencode.install-write-failed"
          : stage === "archive"
            ? "opencode.install-archive-invalid"
            : stage === "verification"
              ? "opencode.install-verification-failed"
              : "opencode.install-write-failed";
    return { ok: false, diagnostic };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
