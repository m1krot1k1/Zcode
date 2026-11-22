// 导出入口：决定输出位置、先打包 zip，失败时回退到目录导出。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  getExportLogDir as getDefaultExportLogDir,
  getExportLogStageDir as getDefaultExportLogStageDir,
} from "@zcode/services/node";

import { logger } from "../logger.js";
import { createLogArchiveArtifacts } from "./collection.js";
import { writeLogArchiveDirectory } from "./directoryArchive.js";
import { formatErrorMessage } from "./errors.js";
import { getZCodeDataDir } from "./paths.js";
import type { ExportLogsDependencies } from "./types.js";
import { writeLogArchiveZip } from "./zipArchive.js";

function formatTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function exportLogs(
  dependencies: ExportLogsDependencies = {},
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const now = dependencies.now ?? (() => new Date());
    const getSourceDir = dependencies.getZCodeDataDir ?? getZCodeDataDir;
    const buildArtifacts = dependencies.createLogArchiveArtifacts ?? createLogArchiveArtifacts;
    const writeZip = dependencies.writeLogArchiveZip ?? writeLogArchiveZip;
    const writeDirectory = dependencies.writeLogArchiveDirectory ?? writeLogArchiveDirectory;
    const showItemInFolder =
      dependencies.showItemInFolder ??
      (async (path: string) => {
        const { shell } = await import("electron");
        shell.showItemInFolder(path);
      });
    const getStageRootDir = dependencies.getExportLogStageDir ?? getDefaultExportLogStageDir;
    const getOutputRootDir = dependencies.getExportLogDir ?? getDefaultExportLogDir;

    const sourceDir = getSourceDir();
    const timestamp = formatTimestamp(now());
    const exportBaseName = `zcode-logs-${timestamp}`;
    const outputRootDir = getOutputRootDir();
    await mkdir(outputRootDir, { recursive: true });
    const outputDir = await mkdtemp(join(outputRootDir, `${exportBaseName}-`));
    const zipPath = join(outputDir, `${exportBaseName}.zip`);
    const directoryPath = join(outputDir, exportBaseName);

    logger.info("[export-logs] 开始打包日志", {
      source: sourceDir,
      zipDest: zipPath,
      directoryDest: directoryPath,
    });
    const artifacts = await buildArtifacts(sourceDir, { now });

    try {
      await writeZip(zipPath, artifacts, { stageRootDir: getStageRootDir() });
      await showItemInFolder(zipPath);

      logger.info("[export-logs] 日志导出完成", {
        path: zipPath,
        format: "zip",
      });
      return { success: true, path: zipPath };
    } catch (zipError) {
      const zipErrorMessage = zipError instanceof Error ? zipError.message : String(zipError);

      // Windows 的压缩能力不再依赖 PowerShell/.NET，但归档写入仍可能被杀软、磁盘策略等外部因素打断。
      // 这里回退为目录导出，保证用户至少能稳定拿到原始日志，而不是直接报错。
      logger.warn("[export-logs] zip 导出失败，回退到目录导出", {
        error: zipErrorMessage,
        zipPath,
        fallbackPath: directoryPath,
      });
      await rm(zipPath, { force: true }).catch(() => {});

      try {
        await writeDirectory(directoryPath, artifacts);
      } catch (directoryError) {
        const directoryErrorMessage =
          directoryError instanceof Error ? directoryError.message : String(directoryError);
        throw new Error(`zip 导出失败：${zipErrorMessage}；目录导出失败：${directoryErrorMessage}`);
      }

      await showItemInFolder(directoryPath);
      logger.info("[export-logs] 日志导出完成", {
        path: directoryPath,
        format: "directory",
      });
      return { success: true, path: directoryPath };
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    logger.error("[export-logs] 日志导出失败", { error: message });
    return { success: false, error: message };
  }
}
