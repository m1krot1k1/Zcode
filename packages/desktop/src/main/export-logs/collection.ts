// 日志收集：遍历来源目录、按过滤策略生成待打包清单，并按 mtime 做保留期裁剪。
import { readdir, realpath, stat } from "node:fs/promises";
import { join, posix } from "node:path";

import { createAboutSnapshot, formatAboutDetail, readBuildMetadata } from "../about.js";
import { logger } from "../logger.js";
import { formatErrorMessage } from "./errors.js";
import { isExcludedRelativePath, normalizeArchivePath } from "./pathExclusions.js";
import {
  getCuaHelperRunDir,
  getZCodeCliDir,
  getZCodeCliLogDir,
  isCuaHelperDiagnosticFileName,
} from "./paths.js";
import type {
  CreateLogArchiveArtifactsOptions,
  LogArchiveArtifacts,
  LogArchiveFileEntry,
} from "./types.js";

const DEFAULT_LOG_EXPORT_LOOKBACK_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  if (
    normalizedArchivePath.startsWith("logs/") ||
    normalizedArchivePath.startsWith(".zcode/cli/log/")
  ) {
    return true;
  }

  return false;
}

async function filterRecentLogArchiveFiles(
  files: LogArchiveFileEntry[],
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveFileEntry[]> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOG_EXPORT_LOOKBACK_DAYS;
  if (lookbackDays <= 0) {
    return files;
  }

  const now = options.now ?? (() => new Date());
  const cutoffMs = now().getTime() - lookbackDays * MILLISECONDS_PER_DAY;
  const recentFiles: LogArchiveFileEntry[] = [];

  for (const file of files) {
    if (!shouldApplyLogExportRetention(file.archivePath)) {
      recentFiles.push(file);
      continue;
    }

    const fileStats = await stat(file.absolutePath).catch(() => null);
    // 导出日志过去按目录全量打包，长时间运行后旧 diagnostics 会把日志包放大到数百 MB。
    // 这里仅对“可由时间窗口复现现场”的日志类文件按 mtime 保留近 3 天；
    // settings 等排障配置不参与过滤，避免久未修改但仍影响当前行为的配置丢失。
    if (fileStats?.isFile() && fileStats.mtimeMs >= cutoffMs) {
      recentFiles.push(file);
    }
  }

  return recentFiles;
}

function createAboutContent(): string {
  const snapshot = createAboutSnapshot({ buildMetadata: readBuildMetadata() });
  return formatAboutDetail(snapshot);
}

function logSkippedLogArchiveDirectory(
  absolutePath: string,
  archivePath: string,
  error: unknown,
): void {
  logger.warn("[export-logs] 日志目录不可读，已在导出时自动跳过", {
    absolutePath,
    archivePath,
    error: formatErrorMessage(error),
  });
}

async function walkLogArchiveDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const resolvedDir = await realpath(absoluteDir).catch(() => absoluteDir);
  if (visitedDirs.has(resolvedDir)) {
    return;
  }
  visitedDirs.add(resolvedDir);

  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch((error: unknown) => {
    // 用户目录下的日志来源可能包含被系统或第三方 CLI 限制权限的子目录。
    // 单个目录 scandir 失败时跳过该目录，避免一次 EACCES 把整个日志包导出中断。
    logSkippedLogArchiveDirectory(absoluteDir, relativeDir, error);
    return null;
  });
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));

  for (const dirent of dirents) {
    const archivePath = relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name;
    if (isExcludedRelativePath(archivePath)) {
      continue;
    }

    const absolutePath = join(absoluteDir, dirent.name);
    if (dirent.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (dirent.isFile()) {
      files.push({ absolutePath, archivePath });
      continue;
    }

    if (!dirent.isSymbolicLink()) {
      continue;
    }

    const targetStats = await stat(absolutePath).catch(() => null);
    if (!targetStats) {
      continue;
    }

    // 日志目录里存在 provider 共享资源的软链入口。
    // 这里按目标类型处理并配合 realpath 去重，避免递归跟随时把同一份内容重复打进包，甚至形成循环遍历。
    if (targetStats.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (targetStats.isFile()) {
      files.push({ absolutePath, archivePath });
    }
  }
}

async function collectLogArchiveFilesFromDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const directoryStats = await stat(absoluteDir).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return;
  }

  await walkLogArchiveDirectory(absoluteDir, relativeDir, visitedDirs, files);
}

/**
 * 按文件名白名单收集单层目录，不递归。用于运行目录这类"诊断文件与凭据同放"的场景：
 * 递归收集会把 .tokens 之类的机密带进用户会转发出去的日志包，而 EXCLUDED 名单是
 * 事后补救、天然滞后。白名单则默认拒绝——目录里以后多出什么都不会跟着漏出去。
 */
async function collectLogArchiveFilesByName(
  absoluteDir: string,
  relativeDir: string,
  isCollectableFileName: (fileName: string) => boolean,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isCollectableFileName(dirent.name)) {
      continue;
    }
    await collectLogArchiveFile(
      join(absoluteDir, dirent.name),
      posix.join(relativeDir, dirent.name),
      files,
    );
  }
}

async function collectLogArchiveFile(
  absolutePath: string,
  archivePath: string,
  files: LogArchiveFileEntry[],
): Promise<void> {
  if (isExcludedRelativePath(archivePath)) {
    return;
  }
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats?.isFile()) {
    return;
  }
  files.push({ absolutePath, archivePath });
}

export async function collectLogArchiveFiles(sourceDir: string): Promise<LogArchiveFileEntry[]> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();
  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);
  files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  return files;
}

export async function createLogArchiveArtifacts(
  sourceDir: string,
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveArtifacts> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();

  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);

  const zcodeCliLogDir = getZCodeCliLogDir();
  // GLM / zcode-cli 的运行日志写在 ~/.zcode/cli/log，不在应用主数据目录 ~/.zcode/v2 下。
  // 如果导出日志只扫描 v2，定位 agent CLI 启动、协议或崩溃问题时会缺少最关键的原生侧日志。
  await collectLogArchiveFilesFromDirectory(
    zcodeCliLogDir,
    posix.join(".zcode", "cli", "log"),
    visitedDirs,
    files,
  );

  const zcodeCliDir = getZCodeCliDir();
  // 排查 agent CLI 问题还需要它的运行配置与模型 IO 轨迹。
  // config.json 是当前生效配置；rollout 是 model-io 调用轨迹，
  // 二者都不在 ~/.zcode/cli/log 下，需要额外收集才能完整还原现场。
  await collectLogArchiveFile(
    join(zcodeCliDir, "config.json"),
    posix.join(".zcode", "cli", "config.json"),
    files,
  );
  await collectLogArchiveFilesFromDirectory(
    join(zcodeCliDir, "rollout"),
    posix.join(".zcode", "cli", "rollout"),
    visitedDirs,
    files,
  );

  // Computer Use Helper 的结构化诊断必须进日志包：否则反馈包里
  // grep "background keyboard begin rejected" 命中 0，
  // 因为 Helper 由 LaunchServices 启动、stderr 被系统丢弃，它把诊断 tee 到
  // ~/.zcode/computer-use/run/<socket>.exit.log，既不在 app data 也不在 ~/.zcode/cli 下。
  // 同目录下有 .tokens broker 凭据，因此按文件名白名单只收 *.exit.log，不递归该目录。
  await collectLogArchiveFilesByName(
    getCuaHelperRunDir(),
    posix.join(".zcode", "computer-use", "run"),
    isCuaHelperDiagnosticFileName,
    files,
  );

  const recentFiles = await filterRecentLogArchiveFiles(files, options);
  recentFiles.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  return {
    files: recentFiles,
    aboutContent: createAboutContent(),
  };
}
