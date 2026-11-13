// 文件内容清洗：按采样识别编码后流式脱敏写入目标文件。
// 不整文件 readFile，避免大日志导出时的内存峰值；脱敏按完整行边界切分，防止 token 被 chunk 截断。
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { sanitizeSensitiveLogContent } from "./redaction.js";
import { detectTextFileEncoding, TEXT_DETECTION_SAMPLE_BYTES } from "./textEncoding.js";
import type { SupportedTextEncoding, TextFileEncodingInfo } from "./types.js";

async function readFileSample(
  absolutePath: string,
  sampleBytes = TEXT_DETECTION_SAMPLE_BYTES,
): Promise<Buffer> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

function encodeTextWithEncoding(text: string, encoding: SupportedTextEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf-8");
  }
  if (encoding === "utf-16le") {
    return Buffer.from(text, "utf16le");
  }
  const encodedBuffer = Buffer.from(text, "utf16le");
  encodedBuffer.swap16();
  return encodedBuffer;
}

function splitByCompleteLine(content: string): {
  completeChunk: string;
  pendingChunk: string;
} {
  const lastLineFeedIndex = content.lastIndexOf("\n");
  if (lastLineFeedIndex >= 0) {
    return {
      completeChunk: content.slice(0, lastLineFeedIndex + 1),
      pendingChunk: content.slice(lastLineFeedIndex + 1),
    };
  }

  const lastCarriageReturnIndex = content.lastIndexOf("\r");
  if (lastCarriageReturnIndex >= 0 && lastCarriageReturnIndex < content.length - 1) {
    return {
      completeChunk: content.slice(0, lastCarriageReturnIndex + 1),
      pendingChunk: content.slice(lastCarriageReturnIndex + 1),
    };
  }

  return { completeChunk: "", pendingChunk: content };
}

function createSensitiveContentSanitizerTransform(encoding: SupportedTextEncoding): Transform {
  const decoder = new TextDecoder(encoding);
  let pendingChunk = "";

  return new Transform({
    transform(chunk, _chunkEncoding, callback) {
      try {
        const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const decodedChunk = decoder.decode(rawChunk, { stream: true });
        const mergedChunk = `${pendingChunk}${decodedChunk}`;
        const { completeChunk, pendingChunk: nextPendingChunk } = splitByCompleteLine(mergedChunk);
        pendingChunk = nextPendingChunk;

        if (completeChunk.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(completeChunk);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const remainingContent = `${pendingChunk}${decoder.decode()}`;
        if (remainingContent.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(remainingContent);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function sanitizeTextLogFileToDestination(
  sourcePath: string,
  destinationPath: string,
  encodingInfo: TextFileEncodingInfo,
): Promise<void> {
  const readStream = createReadStream(sourcePath, {
    start: encodingInfo.bomLength,
  });
  const writeStream = createWriteStream(destinationPath);

  if (encodingInfo.bomLength > 0) {
    writeStream.write(encodingInfo.bomBytes);
  }

  await pipeline(
    readStream,
    createSensitiveContentSanitizerTransform(encodingInfo.encoding),
    writeStream,
  );
}

/**
 * 把源文件落到目标目录：可识别为文本时流式脱敏，二进制才原样复制。
 * 采样识别失败（空文件除外）按二进制处理，保持旧行为。
 */
export async function copySanitizedLogFile(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  // 这里改为“采样识别编码 + 流式脱敏”，避免全量 readFile 带来的大文件内存峰值。
  // 同时显式支持 UTF-16 文本（含 BOM/无 BOM 常见形态），防止被误判成二进制后原样泄露敏感字段。
  const sourceSample = await readFileSample(sourcePath);
  const textEncodingInfo = detectTextFileEncoding(sourceSample);
  if (!textEncodingInfo) {
    await copyFile(sourcePath, destinationPath);
    return;
  }
  await sanitizeTextLogFileToDestination(sourcePath, destinationPath, textEncodingInfo);
}
