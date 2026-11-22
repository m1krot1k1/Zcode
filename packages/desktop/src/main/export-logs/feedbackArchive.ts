// 反馈诊断包：复用 services 的归档能力，来源与手动导出保持同一套路径。
import { join } from "node:path";

import {
  createFeedbackDiagnosticArchive,
  getFeedbackLogArchiveDir as getDefaultFeedbackLogArchiveDir,
} from "@zcode/services/node";

import { getCuaHelperRunDir, getZCodeCliDir, getZCodeCliLogDir } from "./paths.js";
import type { CreateFeedbackLogArchiveFromExportLogsOptions } from "./types.js";

export async function createFeedbackLogArchiveFromExportLogs(
  sourceDir: string,
  options: CreateFeedbackLogArchiveFromExportLogsOptions = {},
): Promise<{ path: string; size: number }> {
  return createFeedbackDiagnosticArchive({
    sources: [
      { directory: join(sourceDir, "logs"), archivePrefix: "logs" },
      { directory: getZCodeCliLogDir(), archivePrefix: ".zcode/cli/log" },
      {
        directory: getZCodeCliDir(),
        archivePrefix: ".zcode/cli",
        includeFileNames: ["config.json"],
        onlyCurrentDay: false,
        contentPolicy: "cli-config",
      },
      {
        directory: join(getZCodeCliDir(), "rollout"),
        archivePrefix: ".zcode/cli/rollout",
      },
      {
        directory: getCuaHelperRunDir(),
        archivePrefix: ".zcode/computer-use/run",
        exitLogsOnly: true,
      },
    ],
    outputRootDir: options.outputRootDir ?? getDefaultFeedbackLogArchiveDir(),
    now: options.now,
    onProgress: options.onProgress,
  });
}
