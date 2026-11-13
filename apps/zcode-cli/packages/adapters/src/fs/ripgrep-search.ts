// ============================================================
// Node FileSystem Adapter
// ============================================================

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { Worker } from "node:worker_threads";
import type { RgArg, RipgrepBufferedResult } from "ripgrep";
import { createFileSystemError, type FileSystemNodeKind, type FileSystemSearchTextEntry, type FileSystemTextSearchOutputMode, type FileSystemSearchTextRequest, type FileSystemSearchTextResult } from "@zcode/contracts";




import { DEFAULT_RIPGREP_TIMEOUT_MS, FinishTextSearchParams, ParsedTextSearch, RIPGREP_WORKER_SOURCE, RipgrepJsonEvent, RipgrepRuntimeFailure, RipgrepSearchPlan, RipgrepTimeoutFailure, RipgrepWorker, RipgrepWorkerData, RipgrepWorkerMessage, SerializedWorkerError, SymlinkWriteRefusedError, TYPE_EXTENSION_MAP, VCS_DIRECTORIES_TO_EXCLUDE, ripgrepTimeoutMsForTests, ripgrepWorkerFactoryForTests } from "./search-types.js";
import { applyHeadLimit, createGlobMatcher, createOnlyMatchingEntries, looksBinary, matchesFileType, throwIfAborted, toPosixRelative } from "./search-match.js";
import {
  collectTextSearchCandidates,
  compileSearchRegex,
  searchLineContent,
  searchMultilineContent,
} from "./text-search-scan.js";

// Исполнение поиска: ripgrep-воркер, парсинг вывода, построчный/multiline скан.



export async function searchTextWithRipgrep(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  let rootInfo: Awaited<ReturnType<typeof stat>>;
  try {
    throwIfAborted(signal);
    rootInfo = await stat(path);
  } catch (error) {
    throw toFileSystemError(error, path);
  }

  if (!rootInfo.isFile() && !rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  const mode = request.outputMode ?? "files_with_matches";
  const plan = createRipgrepSearchPlan(path, rootInfo, request, mode);
  const result = await runBundledRipgrep(plan.args, plan.preopens, { signal });
  throwIfAborted(signal);

  if (result.code === 2) {
    throw toRipgrepFileSystemError(result.stderr, path, pattern);
  }
  if (result.code !== 0 && result.code !== 1) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: `ripgrep exited with code ${result.code}: ${result.stderr || "unknown error"}`,
    });
  }

  const parsed =
    mode === "content"
      ? parseRipgrepJsonOutput(result.stdout, plan.outputRoot, request)
      : parseRipgrepCountOutput(result.stdout, plan.outputRoot, request);
  const files = await sortPathsByMtime(parsed.files);

  return finishTextSearchResult({
    path,
    pattern,
    mode,
    startedAt,
    request,
    files,
    entries: mode === "files_with_matches" ? [] : parsed.entries,
    numMatches: parsed.numMatches,
  });
}



export async function searchTextWithJavaScript(
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Grep pattern must not be empty",
    });
  }

  try {
    throwIfAborted(signal);
    const regex = compileSearchRegex(pattern, request);
    const rootInfo = await stat(path);
    const mode = request.outputMode ?? "files_with_matches";
    const candidates = await collectTextSearchCandidates(path, rootInfo, request, signal);

    const searchRequest =
      mode === "content" ? request : { ...request, onlyMatching: false };
    const contentEntries: FileSystemSearchTextEntry[] = [];
    const countEntries: FileSystemSearchTextEntry[] = [];
    const matchingFiles: Array<{ path: string; mtimeMs: number }> = [];
    let numMatches = 0;

    for (const candidate of candidates) {
      throwIfAborted(signal);
      const content = await readFile(candidate.path, "utf8");
      if (looksBinary(content)) continue;

      const search = request.multiline
        ? searchMultilineContent(candidate.path, content, regex, searchRequest)
        : searchLineContent(candidate.path, content, regex, searchRequest);

      if (search.matchCount === 0) continue;

      numMatches += search.matchCount;
      matchingFiles.push({ path: candidate.path, mtimeMs: candidate.mtimeMs });
      if (mode === "content") {
        contentEntries.push(...search.entries);
      } else if (mode === "count") {
        countEntries.push({
          path: candidate.path,
          count: search.matchCount,
        });
      }
    }

    matchingFiles.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    return finishTextSearchResult({
      path,
      pattern,
      mode,
      startedAt,
      request,
      files: matchingFiles.map((item) => item.path),
      entries: mode === "content" ? contentEntries : countEntries,
      numMatches,
    });
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}



export async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}



export async function readAtMostBytes(
  path: string,
  maxBytes: number,
  initialSizeBytes: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    // 稳定文件按 stat 大小一次读取；只有文件在 stat 后增长时才继续分块追到硬上限。
    const firstBuffer = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1, initialSizeBytes + 1)));
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const chunk =
        bytesReadTotal === 0
          ? firstBuffer
          : Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytesReadTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytesReadTotal);
      // FileHandle.read 的短读不等于 EOF；只有明确返回 0 字节才能停止。
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (chunks.length === 0) return Buffer.alloc(0);
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesReadTotal);
  } finally {
    await handle.close();
  }
}



export function getNodeErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}



export async function atomicWrite(path: string, content: Buffer): Promise<void> {
  let existingMode: number | undefined;

  try {
    const targetInfo = await lstat(path);
    if (targetInfo.isSymbolicLink()) {
      throw new SymlinkWriteRefusedError(
        `Refusing to write through symlink: ${path}. Resolve the symlink and pass the real target path explicitly.`,
      );
    }
    existingMode = targetInfo.mode;
  } catch (error) {
    if (getNodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;

  try {
    const handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
    try {
      await handle.writeFile(content);
      if (existingMode !== undefined) {
        // 原子写会用临时文件 inode 覆盖目标文件；必须先复制原文件权限，避免抹掉脚本执行位。
        await handle.chmod(existingMode);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
  } catch {
    await unlink(tempPath).catch(() => undefined);
    const fallbackHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (getNodeErrorCode(error) === "ELOOP") {
        throw new SymlinkWriteRefusedError(`Refusing to write through symlink: ${path} (O_NOFOLLOW)`);
      }
      throw error;
    });

    try {
      await fallbackHandle.writeFile(content);
      await fallbackHandle.sync();
    } finally {
      await fallbackHandle.close();
    }
  }
}



export function nodeKind(info: Awaited<ReturnType<typeof stat>>): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}



export function direntKind(info: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FileSystemNodeKind {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}



export function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}



export function resolveAbsoluteRequestPath(path: string): string {
  if (!isAbsolute(path)) {
    throw createFileSystemError({
      code: "invalid_path",
      path,
      message: `FileSystemPort requires an absolute path: ${path}`,
    });
  }
  return normalize(path);
}



export function hashBuffer(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}



export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${formatByteUnit(bytes / 1024)}KB`;
  return `${formatByteUnit(bytes / (1024 * 1024))}MB`;
}



export function formatByteUnit(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}



export function toFileSystemError(error: unknown, path: string): Error {
  if (error instanceof Error && error.name === "FileSystemPortError") {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    // Preserve cancellation as its own code so tools do not report user aborts as I/O failures.
    return createFileSystemError({
      code: "cancelled",
      path,
      message: `File system operation was cancelled: ${path}`,
      cause: error,
    });
  }

  const code = getNodeErrorCode(error);
  if (code === "ENOENT") {
    return createFileSystemError({
      code: "not_found",
      path,
      message: `File not found: ${path}`,
      cause: error,
    });
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message: `Permission denied for path: ${path}`,
      cause: error,
    });
  }
  if (code === "EISDIR") {
    return createFileSystemError({
      code: "is_directory",
      path,
      message: `Path is a directory: ${path}`,
      cause: error,
    });
  }
  if (code === "ENAMETOOLONG") {
    return createFileSystemError({
      code: "invalid_path",
      path,
      message: `Invalid path: ${path}`,
      cause: error,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message: error instanceof Error ? error.message : `File system error for path: ${path}`,
    cause: error,
  });
}



export function createRipgrepSearchPlan(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  mode: FileSystemTextSearchOutputMode,
): RipgrepSearchPlan {
  const outputRoot = rootInfo.isDirectory() ? path : dirname(path);
  const target = rootInfo.isDirectory() ? "." : basename(path);
  const args: RgArg[] = [
    "--no-config",
    "--hidden",
    "--color",
    "never",
    "--no-heading",
    "--with-filename",
    "--max-columns",
    "500",
  ];

  for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${dir}`, "--glob", `!**/${dir}/**`);
  }

  if (request.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  if (request.ignoreCase) {
    args.push("-i");
  }

  if (mode === "content") {
    args.push("--json");
    if (request.onlyMatching) {
      args.push("--only-matching");
    }
    addRipgrepContextArgs(args, request);
  } else {
    args.push("-c");
  }

  if (request.glob) {
    addRipgrepGlobArgs(args, request.glob);
  }
  if (request.type) {
    addRipgrepTypeArgs(args, request.type);
  }

  args.push("-e", request.pattern.trim(), "--", target);

  return {
    args,
    outputRoot,
    preopens: { ".": outputRoot },
  };
}



export function addRipgrepContextArgs(args: RgArg[], request: FileSystemSearchTextRequest): void {
  if (request.context !== undefined) {
    args.push("-C", String(request.context));
    return;
  }
  if (request.beforeContext !== undefined) {
    args.push("-B", String(request.beforeContext));
  }
  if (request.afterContext !== undefined) {
    args.push("-A", String(request.afterContext));
  }
}



export function addRipgrepGlobArgs(args: RgArg[], glob: string): void {
  for (const pattern of splitRipgrepGlobPatterns(glob)) {
    args.push("--glob", pattern);
  }
}



export function splitRipgrepGlobPatterns(glob: string): string[] {
  const patterns: string[] = [];
  for (const rawPattern of glob.split(/\s+/)) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      patterns.push(rawPattern);
      continue;
    }
    patterns.push(...rawPattern.split(","));
  }
  return patterns.map((pattern) => pattern.trim()).filter(Boolean);
}



export function addRipgrepTypeArgs(args: RgArg[], type: string): void {
  for (const pattern of fileTypeGlobPatterns(type)) {
    args.push("--glob", pattern);
  }
}



export function fileTypeGlobPatterns(type: string): string[] {
  const normalized = normalizeFileType(type);
  if (!/^[a-z0-9_+-]+$/i.test(normalized)) return [];
  const extensions = TYPE_EXTENSION_MAP[normalized] ?? [`.${normalized}`];
  return extensions.flatMap((extension) => [`*${extension}`, `**/*${extension}`]);
}



export function normalizeFileType(type: string): string {
  return type.toLowerCase().replace(/^\./, "");
}



export async function runBundledRipgrep(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal } = {},
): Promise<RipgrepBufferedResult> {
  try {
    return await runBundledRipgrepWorker(args, preopens, {
      signal: options.signal,
      timeoutMs: ripgrepTimeoutMsForTests ?? DEFAULT_RIPGREP_TIMEOUT_MS,
    });
  } catch (error) {
    if (isAbortError(error) || error instanceof RipgrepTimeoutFailure) {
      throw error;
    }
    throw new RipgrepRuntimeFailure(error);
  }
}



export function runBundledRipgrepWorker(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<RipgrepBufferedResult> {
  if (options.signal?.aborted) {
    return Promise.reject(createAbortError("ripgrep search was cancelled before it started"));
  }

  // 不能在 agent 主线程里直接运行 WASI ripgrep。大目录搜索会占住 Node
  // event loop，导致 session/stop 虽然绕过协议队列，却没有机会被 agent 处理。
  // 放到 Worker 后，用户 stop 和超时都能从主线程 terminate 这个搜索执行单元。
  const worker = createRipgrepWorker({
    args: args.map(String),
    preopens,
  });

  return new Promise<RipgrepBufferedResult>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const terminateWorker = (): void => {
      const termination = worker.terminate();
      if (typeof termination === "object" && termination !== null && "catch" in termination) {
        void termination.catch(() => undefined);
      }
    };

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const settle = (settler: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settler();
    };

    const handleAbort = (): void => {
      terminateWorker();
      settle(() => reject(createAbortError("ripgrep search was cancelled")));
    };

    options.signal?.addEventListener("abort", handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      terminateWorker();
      settle(() => reject(new RipgrepTimeoutFailure(options.timeoutMs)));
    }, options.timeoutMs);

    worker.once("message", (message: unknown) => {
      settle(() => {
        const parsed = message as Partial<RipgrepWorkerMessage>;
        if (parsed.type === "result" && parsed.result) {
          resolve(parsed.result);
          return;
        }
        if (parsed.type === "error") {
          reject(deserializeWorkerError(parsed.error));
          return;
        }
        reject(new Error("ripgrep worker returned an unknown message"));
      });
    });

    worker.once("error", (error: Error) => {
      settle(() => reject(error));
    });

    worker.once("exit", (code: number) => {
      if (settled) return;
      settle(() => reject(new Error(`ripgrep worker exited before returning a result: ${code}`)));
    });
  });
}



export function createRipgrepWorker(workerData: RipgrepWorkerData): RipgrepWorker {
  return (
    ripgrepWorkerFactoryForTests?.(workerData) ??
    new Worker(RIPGREP_WORKER_SOURCE, {
      eval: true,
      workerData,
    })
  );
}



export function deserializeWorkerError(serialized: SerializedWorkerError | undefined): Error {
  const error = new Error(serialized?.message ?? "ripgrep worker failed");
  error.name = serialized?.name ?? "Error";
  if (serialized?.stack) {
    error.stack = serialized.stack;
  }
  if (serialized && "code" in serialized) {
    Object.assign(error, { code: serialized.code });
  }
  return error;
}



export function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}



export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}



export function parseRipgrepJsonOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const event = parseRipgrepJsonEvent(line, request.path);
    if (event.type !== "match" && event.type !== "context") continue;

    const rawPath = event.data?.path?.text;
    if (!rawPath) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    const matched = event.type === "match";
    if (matched) {
      files.add(path);
      numMatches += 1;
    }

    if (request.onlyMatching && matched) {
      const submatches = event.data?.submatches ?? [];
      if (submatches.length > 0) {
        const lineNumber =
          typeof event.data?.line_number === "number" ? event.data.line_number : undefined;
        for (const submatch of submatches) {
          entries.push(...createOnlyMatchingEntries({
            path,
            text: submatch.match?.text ?? "",
            lineNumber,
          }));
        }
        continue;
      }
    }

    entries.push({
      path,
      lineNumber: typeof event.data?.line_number === "number" ? event.data.line_number : undefined,
      text: stripTrailingLineEnding(event.data?.lines?.text ?? ""),
      matched,
    });
  }

  return { entries, files: [...files], numMatches };
}



export function parseRipgrepCountOutput(
  stdout: string,
  outputRoot: string,
  request: FileSystemSearchTextRequest,
): ParsedTextSearch {
  const entries: FileSystemSearchTextEntry[] = [];
  const files = new Set<string>();
  const shouldKeep = createTextResultFilter(outputRoot, request);
  let numMatches = 0;

  for (const line of splitOutputLines(stdout)) {
    const separatorIndex = line.lastIndexOf(":");
    if (separatorIndex <= 0) continue;

    const rawPath = line.slice(0, separatorIndex);
    const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
    if (!Number.isFinite(count) || count <= 0) continue;

    const path = resolveRipgrepOutputPath(outputRoot, rawPath);
    if (!shouldKeep(path)) continue;

    files.add(path);
    numMatches += count;
    entries.push({ path, count });
  }

  return { entries, files: [...files], numMatches };
}



export function finishTextSearchResult(params: FinishTextSearchParams): FileSystemSearchTextResult {
  if (params.mode === "files_with_matches") {
    const limited = applyHeadLimit(params.files, params.request.headLimit, params.request.offset);
    return {
      path: params.path,
      pattern: params.pattern,
      mode: params.mode,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      files: limited.items,
      entries: [],
      numMatches: params.numMatches,
      truncated: limited.truncated,
      appliedLimit: limited.appliedLimit,
      appliedOffset: limited.appliedOffset,
    };
  }

  const limited = applyHeadLimit(params.entries, params.request.headLimit, params.request.offset);
  return {
    path: params.path,
    pattern: params.pattern,
    mode: params.mode,
    durationMs: Math.max(0, Date.now() - params.startedAt),
    files: params.files,
    entries: limited.items,
    numMatches: params.numMatches,
    truncated: limited.truncated,
    appliedLimit: limited.appliedLimit,
    appliedOffset: limited.appliedOffset,
  };
}



export async function sortPathsByMtime(paths: string[]): Promise<string[]> {
  const withStats = await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        const info = await stat(path);
        return { path, mtimeMs: Number(info.mtimeMs) };
      } catch {
        return { path, mtimeMs: 0 };
      }
    }),
  );

  withStats.sort((left, right) => {
    const timeComparison = right.mtimeMs - left.mtimeMs;
    return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
  });
  return withStats.map((item) => item.path);
}



export function splitOutputLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}



export function parseRipgrepJsonEvent(line: string, path: string): RipgrepJsonEvent {
  try {
    return JSON.parse(line) as RipgrepJsonEvent;
  } catch (error) {
    throw createFileSystemError({
      code: "io_error",
      path,
      message: "Failed to parse ripgrep JSON output",
      cause: error,
    });
  }
}



export function createTextResultFilter(
  root: string,
  request: FileSystemSearchTextRequest,
): (path: string) => boolean {
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;

  return (path) => {
    const relativePath = toPosixRelative(root, path);
    if (globMatcher && !globMatcher(relativePath, basename(path))) return false;
    if (request.type && !matchesFileType(path, request.type)) return false;
    return true;
  };
}



export function resolveRipgrepOutputPath(root: string, rawPath: string): string {
  if (isAbsolute(rawPath)) return normalize(rawPath);
  const withoutLeadingDot = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
  return normalize(join(root, withoutLeadingDot));
}



export function stripTrailingLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}



export function toRipgrepFileSystemError(stderr: string, path: string, pattern: string): Error {
  const message = stderr.trim() || `ripgrep failed while searching ${path}`;
  const normalized = message.toLowerCase();

  if (
    normalized.includes("regex parse error") ||
    normalized.includes("error parsing regex") ||
    normalized.includes("unclosed")
  ) {
    return createFileSystemError({
      code: "invalid_pattern",
      path,
      message: `Invalid grep regular expression: ${pattern}`,
    });
  }

  if (normalized.includes("permission denied") || normalized.includes("os error 13")) {
    return createFileSystemError({
      code: "permission_denied",
      path,
      message,
    });
  }

  if (normalized.includes("no such file") || normalized.includes("os error 2")) {
    return createFileSystemError({
      code: "not_found",
      path,
      message,
    });
  }

  return createFileSystemError({
    code: "io_error",
    path,
    message,
  });
}
