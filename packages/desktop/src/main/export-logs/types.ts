// 导出日志流程共用的类型：待打包文件清单、归档产物、依赖注入与文本编码识别结果。
export interface LogArchiveFileEntry {
  absolutePath: string;
  archivePath: string;
}

export interface LogArchiveArtifacts {
  files: LogArchiveFileEntry[];
  aboutContent: string;
}

export interface CreateLogArchiveArtifactsOptions {
  now?: () => Date;
  lookbackDays?: number;
}

export interface LogArchiveSkippedFileEntry {
  absolutePath: string;
  archivePath: string;
  error: string;
}

export interface ExportLogsDependencies {
  now?: () => Date;
  getZCodeDataDir?: () => string;
  getExportLogStageDir?: () => string;
  getExportLogDir?: () => string;
  createLogArchiveArtifacts?: (
    sourceDir: string,
    options?: CreateLogArchiveArtifactsOptions,
  ) => Promise<LogArchiveArtifacts>;
  writeLogArchiveZip?: (
    outputPath: string,
    artifacts: LogArchiveArtifacts,
    options?: WriteLogArchiveZipOptions,
  ) => Promise<void>;
  writeLogArchiveDirectory?: (outputPath: string, artifacts: LogArchiveArtifacts) => Promise<void>;
  showItemInFolder?: (path: string) => Promise<void> | void;
}

export interface WriteLogArchiveZipOptions {
  stageRootDir?: string;
}

export interface CreateFeedbackLogArchiveFromExportLogsOptions {
  now?: () => Date;
  outputRootDir?: string;
  stageRootDir?: string;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

export type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface TextFileEncodingInfo {
  encoding: SupportedTextEncoding;
  bomLength: number;
  bomBytes: Buffer;
}
