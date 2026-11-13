// 目录形态的归档：逐个复制文件到目标目录（文本流式脱敏），并写入 about.txt。
import { constants } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../logger.js";
import { formatErrorMessage } from "./errors.js";
import { copySanitizedLogFile } from "./textSanitizing.js";
import type {
  LogArchiveArtifacts,
  LogArchiveFileEntry,
  LogArchiveSkippedFileEntry,
} from "./types.js";

async function copyLogArchiveFilesToDirectory(
  outputPath: string,
  files: LogArchiveFileEntry[],
): Promise<LogArchiveSkippedFileEntry[]> {
  const skippedFiles: LogArchiveSkippedFileEntry[] = [];

  for (const file of files) {
    const destinationPath = join(outputPath, ...file.archivePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true });

    const sourceStats = await stat(file.absolutePath).catch((error: unknown) => {
      skippedFiles.push({
        absolutePath: file.absolutePath,
        archivePath: file.archivePath,
        error: formatErrorMessage(error),
      });
      return null;
    });
    if (!sourceStats?.isFile()) {
      continue;
    }

    const sourceReadable = await access(file.absolutePath, constants.R_OK)
      .then(() => true)
      .catch((error: unknown) => {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        return false;
      });
    if (!sourceReadable) {
      continue;
    }

    try {
      await copySanitizedLogFile(file.absolutePath, destinationPath);
    } catch (error) {
      const sourceStatsAfterFailure = await stat(file.absolutePath).catch(() => null);
      const sourceReadableAfterFailure = sourceStatsAfterFailure?.isFile()
        ? await access(file.absolutePath, constants.R_OK)
            .then(() => true)
            .catch(() => false)
        : false;
      // telemetry/agent 日志文件可能在“扫描完待导出列表”之后被后台轮转、删除或改权限，
      // 软链目标也可能在这段窗口里失效。复制失败后再核一次源文件可读性；
      // 如果源头已经不可读，就把它当成坏文件跳过，避免单个 ENOENT/EACCES 让导出整体失败。
      if (!sourceReadableAfterFailure) {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        continue;
      }
      throw error;
    }
  }

  return skippedFiles;
}

function logSkippedLogArchiveFiles(skippedFiles: LogArchiveSkippedFileEntry[]): void {
  if (skippedFiles.length === 0) {
    return;
  }

  logger.warn("[export-logs] 检测到不可读日志文件，已在导出时自动跳过", {
    skippedCount: skippedFiles.length,
    skippedFiles: skippedFiles.slice(0, 10),
  });
}

export async function writeLogArchiveDirectory(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  const skippedFiles = await copyLogArchiveFilesToDirectory(outputPath, artifacts.files);
  logSkippedLogArchiveFiles(skippedFiles);

  await writeFile(join(outputPath, "about.txt"), artifacts.aboutContent, "utf-8");
}
