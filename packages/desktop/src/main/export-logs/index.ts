// 导出日志的公开入口：桌面主进程与测试只从这里取用，内部按职责拆分到同目录模块。
// 拆分过程中保持导出名称、收集顺序与归档语义不变。
export { collectLogArchiveFiles, createLogArchiveArtifacts } from "./collection.js";
export { writeLogArchiveDirectory } from "./directoryArchive.js";
export { exportLogs } from "./exportLogs.js";
export { createFeedbackLogArchiveFromExportLogs } from "./feedbackArchive.js";
export type {
  CreateFeedbackLogArchiveFromExportLogsOptions,
  CreateLogArchiveArtifactsOptions,
  ExportLogsDependencies,
  LogArchiveArtifacts,
  LogArchiveFileEntry,
  LogArchiveSkippedFileEntry,
  WriteLogArchiveZipOptions,
} from "./types.js";
export { writeLogArchiveZip } from "./zipArchive.js";
