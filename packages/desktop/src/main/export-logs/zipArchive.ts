// zip 形态的归档：先稳定复制到暂存目录，再从暂存目录压缩，避免 yazl 面对轮转中的源文件。
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { getExportLogStageDir as getDefaultExportLogStageDir } from "@zcode/services/node";
import { ZipFile } from "yazl";

import { collectLogArchiveFiles } from "./collection.js";
import { writeLogArchiveDirectory } from "./directoryArchive.js";
import type { LogArchiveArtifacts, WriteLogArchiveZipOptions } from "./types.js";

export async function writeLogArchiveZip(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
  options: WriteLogArchiveZipOptions = {},
): Promise<void> {
  const stageRootDir = options.stageRootDir ?? getDefaultExportLogStageDir();
  await mkdir(stageRootDir, { recursive: true });
  const stagingDir = await mkdtemp(join(stageRootDir, "stage-"));
  try {
    // yazl.addFile 内部会再次对源路径执行 fs.stat/createReadStream。
    // 对于软链目标或正在被轮转的 telemetry 文件，这一步仍然可能异步抛错并触发未监听的 error 事件。
    // 这里先把可读文件稳定复制到临时目录，再从临时目录压缩，保证 zip 阶段只面对我们自己控制的常规文件。
    await writeLogArchiveDirectory(stagingDir, artifacts);

    const zipFile = new ZipFile();
    const stageFiles = await collectLogArchiveFiles(stagingDir);
    const outputStream = createWriteStream(outputPath);
    zipFile.once("error", (error) => {
      outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    for (const file of stageFiles) {
      zipFile.addFile(file.absolutePath, file.archivePath);
    }

    const writePromise = pipeline(zipFile.outputStream, outputStream);
    zipFile.end();
    await writePromise;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
