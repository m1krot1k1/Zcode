/// <reference types="node" />
// ============================================================
// Этап 5: нагрузочный стресс-тест параллельных транзакций редактирования
// ============================================================
//
// Инварианты Инкремента 4.2 (FileTransactionManager + FileLockRegistry):
//  1. Нет дедлоков при N параллельных пакетах на пересекающихся путях.
//  2. Нет потерянных обновлений: непересекающиеся файлы сохраняют каждый свой
//     результат, конфликтующие — сериализуются, пакет остаётся согласованным.
//  3. Сбой записи в середине пакета даёт 100% откат.
//  4. Нет остаточных файлов/временных артефактов.
//  5. Нет утечек handles/памяти после сотен прогонов.

import { describe, expect, it } from "vitest";
import type {
  FileSystemCreateDirectoryRequest,
  FileSystemCreateDirectoryResult,
  FileSystemListDirectoryRequest,
  FileSystemListDirectoryResult,
  FileSystemOperationOptions,
  FileSystemPort,
  FileSystemReadBytesRequest,
  FileSystemReadBytesResult,
  FileSystemReadTextRangeRequest,
  FileSystemReadTextRangeResult,
  FileSystemReadTextRequest,
  FileSystemReadTextResult,
  FileSystemRemoveFileRequest,
  FileSystemRemoveFileResult,
  FileSystemSearchFilesRequest,
  FileSystemSearchFilesResult,
  FileSystemSearchTextRequest,
  FileSystemSearchTextResult,
  FileSystemStatRequest,
  FileSystemStatResult,
  FileSystemWriteTextRequest,
  FileSystemWriteTextResult,
} from "@zcode/contracts";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import {
  createFileLockRegistry,
  createFileTransactionManager,
  type FileMutationOp,
} from "../src/tool/file-transaction/index.js";

// ── In-memory FileSystemPort ────────────────────────────────

interface StressFs {
  readonly port: FileSystemPort;
  readonly files: Map<string, string>;
  /** Подстроки путей, где запись должна упасть (инжектированный сбой). */
  readonly failingPathIncludes: Set<string>;
  writeCalls: number;
  /** Сколько раз один и тот же путь писался конкурентно — нарушение эксклюзивного лока. */
  interleavedPathWrites: number;
  /** Активные записи по нормализованному ключу пути. */
  readonly activeWritesByPath: Map<string, number>;
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+/gu, "/");
}

function createStressFs(initial: Record<string, string> = {}): StressFs {
  const files = new Map(Object.entries(initial));
  const directories = new Set<string>();
  const failingPathIncludes = new Set<string>();
  const activeWritesByPath = new Map<string, number>();
  const state = { writeCalls: 0, interleavedPathWrites: 0 };

  const notFound = (path: string) =>
    createCoreError(CoreErrorType.ToolExecutionFailed, `missing file: ${path}`, {
      context: { code: "not_found", path },
      recoverable: false,
    });

  const port: FileSystemPort = {
    async createDirectory(
      request: FileSystemCreateDirectoryRequest,
    ): Promise<FileSystemCreateDirectoryResult> {
      directories.add(request.path);
      return { path: request.path };
    },
    async stat(request: FileSystemStatRequest): Promise<FileSystemStatResult> {
      const content = files.get(request.path);
      if (content !== undefined) {
        const sizeBytes = Buffer.byteLength(content, "utf8");
        return {
          path: request.path,
          kind: "file",
          sizeBytes,
          mtimeMs: 1,
          revision: { id: `${request.path}:1`, mtimeMs: 1, sizeBytes },
        };
      }
      if (directories.has(request.path)) {
        return { path: request.path, kind: "directory", sizeBytes: 0 };
      }
      return { path: request.path, kind: "missing", sizeBytes: 0 };
    },
    async readTextFile(request: FileSystemReadTextRequest): Promise<FileSystemReadTextResult> {
      const content = files.get(request.path);
      if (content === undefined) throw notFound(request.path);
      const sizeBytes = Buffer.byteLength(content, "utf8");
      return {
        path: request.path,
        content,
        encoding: "utf8",
        lineEndings: content.includes("\r\n") ? "CRLF" : "LF",
        bytesRead: sizeBytes,
        sizeBytes,
        truncated: false,
        revision: { id: `${request.path}:1`, mtimeMs: 1, sizeBytes },
      };
    },
    async readBinaryFile(_request: FileSystemReadBytesRequest): Promise<FileSystemReadBytesResult> {
      throw new Error("readBinaryFile не используется в стресс-тесте");
    },
    async readTextFileRange(
      _request: FileSystemReadTextRangeRequest,
    ): Promise<FileSystemReadTextRangeResult> {
      throw new Error("readTextFileRange не используется в стресс-тесте");
    },
    async writeTextFile(
      request: FileSystemWriteTextRequest,
      _options?: FileSystemOperationOptions,
    ): Promise<FileSystemWriteTextResult> {
      state.writeCalls += 1;
      const key = pathKey(request.path);
      const active = (activeWritesByPath.get(key) ?? 0) + 1;
      activeWritesByPath.set(key, active);
      // Конкурентная запись ОДНОГО пути означала бы, что лок не удержал
      // эксклюзивный доступ — это и есть проверяемый инвариант.
      if (active > 1) state.interleavedPathWrites += 1;
      try {
        // Даём планировщику переключиться: окно для гонки, если лока нет.
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const suffix of failingPathIncludes) {
          if (key.includes(suffix)) {
            throw createCoreError(
              CoreErrorType.ToolExecutionFailed,
              `injected write failure: ${request.path}`,
              { context: { code: "io_error", path: request.path }, recoverable: false },
            );
          }
        }
        files.set(request.path, request.content);
        return {
          path: request.path,
          bytesWritten: Buffer.byteLength(request.content, "utf8"),
          revision: {
            id: `${request.path}:2`,
            mtimeMs: 2,
            sizeBytes: Buffer.byteLength(request.content, "utf8"),
          },
        };
      } finally {
        const remaining = (activeWritesByPath.get(key) ?? 1) - 1;
        if (remaining <= 0) activeWritesByPath.delete(key);
        else activeWritesByPath.set(key, remaining);
      }
    },
    async removeFile(request: FileSystemRemoveFileRequest): Promise<FileSystemRemoveFileResult> {
      const removed = files.delete(request.path);
      return { path: request.path, removed };
    },
    async listDirectory(
      _request: FileSystemListDirectoryRequest,
    ): Promise<FileSystemListDirectoryResult> {
      return { path: "", durationMs: 0, entries: [], numEntries: 0 };
    },
    async searchFiles(
      _request: FileSystemSearchFilesRequest,
    ): Promise<FileSystemSearchFilesResult> {
      return { path: "", pattern: "", durationMs: 0, files: [], numFiles: 0, truncated: false };
    },
    async searchText(_request: FileSystemSearchTextRequest): Promise<FileSystemSearchTextResult> {
      return {
        path: "",
        pattern: "",
        mode: "content",
        durationMs: 0,
        files: [],
        entries: [],
        numMatches: 0,
        truncated: false,
      };
    },
  };

  return {
    port,
    files,
    failingPathIncludes,
    activeWritesByPath,
    get writeCalls() {
      return state.writeCalls;
    },
    set writeCalls(next: number) {
      state.writeCalls = next;
    },
    get interleavedPathWrites() {
      return state.interleavedPathWrites;
    },
    set interleavedPathWrites(next: number) {
      state.interleavedPathWrites = next;
    },
  } as StressFs;
}

// ── Метрики ─────────────────────────────────────────────────

function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(samples: readonly number[]): number {
  return samples.length === 0 ? 0 : samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
}

const WORKSPACE = "/stress/workspace";

function updateOp(path: string, next: string): FileMutationOp {
  return { kind: "update", path, computeNext: () => ({ content: next }) };
}

interface TxOutcome {
  readonly ms: number;
  readonly status: string;
  readonly rolledBackSteps: number;
  readonly errorCode?: string;
}

async function runTransaction(
  manager: ReturnType<typeof createFileTransactionManager>,
  fs: StressFs,
  operations: readonly FileMutationOp[],
  sessionId: string,
): Promise<TxOutcome> {
  const startedAt = performance.now();
  const result = await manager.executeTransaction({
    workspacePath: WORKSPACE,
    sessionId,
    operations,
    fileSystemPort: fs.port,
    strictSyntaxValidation: false,
  });
  return {
    ms: performance.now() - startedAt,
    status: result.status,
    rolledBackSteps: result.rolledBackSteps,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}

describe("Этап 5 — стресс параллельных файловых транзакций", () => {
  it("32 параллельные транзакции на непересекающихся файлах не теряют обновления", async () => {
    const count = 32;
    const initial: Record<string, string> = {};
    for (let index = 0; index < count; index += 1) {
      initial[`${WORKSPACE}/f${index}.txt`] = `seed-${index}\n`;
    }
    const fs = createStressFs(initial);
    const manager = createFileTransactionManager({ lockRegistry: createFileLockRegistry() });
    const samples: number[] = [];

    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        runTransaction(
          manager,
          fs,
          [updateOp(`${WORKSPACE}/f${index}.txt`, `done-${index}\n`)],
          `s-${index}`,
        ),
      ),
    );

    for (const result of results) {
      samples.push(result.ms);
      expect(result.status).toBe("committed");
    }
    for (let index = 0; index < count; index += 1) {
      expect(fs.files.get(`${WORKSPACE}/f${index}.txt`)).toBe(`done-${index}\n`);
    }
    // Разные пути не конкурируют: ни одной конкурентной записи одного пути.
    expect(fs.interleavedPathWrites).toBe(0);

    console.info(
      `[stress][tx][disjoint] n=${count} p50=${round(percentile(samples, 50))}ms p95=${round(
        percentile(samples, 95),
      )}ms throughput=${round((count * 1000) / mean(samples))}/s`,
    );
  }, 60_000);

  it("32 параллельные транзакции на одном файле сериализуются без дедлока", async () => {
    const count = 32;
    const fs = createStressFs({ [`${WORKSPACE}/shared.txt`]: "v0\n" });
    const manager = createFileTransactionManager({ lockRegistry: createFileLockRegistry() });
    const samples: number[] = [];

    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        runTransaction(
          manager,
          fs,
          [updateOp(`${WORKSPACE}/shared.txt`, `v${index + 1}\n`)],
          `shared-${index}`,
        ),
      ),
    );

    for (const result of results) {
      samples.push(result.ms);
      expect(result.status).toBe("committed");
    }
    const final = fs.files.get(`${WORKSPACE}/shared.txt`);
    expect(final).toMatch(/^v\d+\n$/);
    expect(fs.interleavedPathWrites).toBe(0);
    expect(fs.writeCalls).toBe(count);

    console.info(
      `[stress][tx][shared] n=${count} p50=${round(percentile(samples, 50))}ms p95=${round(
        percentile(samples, 95),
      )}ms final=${String(final).trim()} writes=${fs.writeCalls} conflicts=${count - 1}`,
    );
  }, 60_000);

  it("пересекающиеся writePaths: пакет остаётся согласованным", async () => {
    const count = 16;
    const fs = createStressFs({
      [`${WORKSPACE}/a.txt`]: "a0\n",
      [`${WORKSPACE}/b.txt`]: "b0\n",
    });
    const manager = createFileTransactionManager({ lockRegistry: createFileLockRegistry() });
    const samples: number[] = [];

    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        runTransaction(
          manager,
          fs,
          [
            updateOp(`${WORKSPACE}/a.txt`, `a${index + 1}\n`),
            updateOp(`${WORKSPACE}/b.txt`, `b${index + 1}\n`),
          ],
          `pair-${index}`,
        ),
      ),
    );

    for (const result of results) {
      samples.push(result.ms);
      expect(result.status).toBe("committed");
    }
    const aVersion = /^a(\d+)\n$/.exec(fs.files.get(`${WORKSPACE}/a.txt`) ?? "")?.[1];
    const bVersion = /^b(\d+)\n$/.exec(fs.files.get(`${WORKSPACE}/b.txt`) ?? "")?.[1];
    expect(aVersion).toBeDefined();
    // Пакет атомарен: оба файла из одной транзакции.
    expect(aVersion).toBe(bVersion);
    expect(fs.interleavedPathWrites).toBe(0);

    console.info(
      `[stress][tx][overlap] n=${count} p95=${round(percentile(samples, 95))}ms consistent=a${aVersion}/b${bVersion}`,
    );
  }, 60_000);

  it("инжектированный сбой записи в середине пакета даёт 100% откат", async () => {
    const fs = createStressFs({
      [`${WORKSPACE}/keep1.txt`]: "keep1\n",
      [`${WORKSPACE}/keep2.txt`]: "keep2\n",
      [`${WORKSPACE}/boom.txt`]: "boom\n",
    });
    const manager = createFileTransactionManager({ lockRegistry: createFileLockRegistry() });
    fs.failingPathIncludes.add("boom.txt");

    const result = await runTransaction(
      manager,
      fs,
      [
        updateOp(`${WORKSPACE}/keep1.txt`, "CHANGED1\n"),
        updateOp(`${WORKSPACE}/keep2.txt`, "CHANGED2\n"),
        updateOp(`${WORKSPACE}/boom.txt`, "CHANGED3\n"),
      ],
      "rollback",
    );

    expect(result.status).toBe("rolled_back_on_error");
    expect(fs.files.get(`${WORKSPACE}/keep1.txt`)).toBe("keep1\n");
    expect(fs.files.get(`${WORKSPACE}/keep2.txt`)).toBe("keep2\n");
    expect(fs.files.get(`${WORKSPACE}/boom.txt`)).toBe("boom\n");

    console.info(`[stress][tx][rollback] ok=false writes=${fs.writeCalls} restored=3/3`);
  }, 30_000);

  it("create+delete не оставляют остаточных файлов", async () => {
    const fs = createStressFs({});
    const manager = createFileTransactionManager({ lockRegistry: createFileLockRegistry() });

    const created = await runTransaction(
      manager,
      fs,
      [{ kind: "create", path: `${WORKSPACE}/tmp-new.txt`, content: "payload\n" }],
      "create-only",
    );
    expect(created.status).toBe("committed");
    expect(fs.files.get(`${WORKSPACE}/tmp-new.txt`)).toBe("payload\n");

    const removed = await runTransaction(
      manager,
      fs,
      [{ kind: "delete", path: `${WORKSPACE}/tmp-new.txt` }],
      "delete-only",
    );
    expect(removed.status).toBe("committed");
    expect(fs.files.has(`${WORKSPACE}/tmp-new.txt`)).toBe(false);
    expect([...fs.files.keys()].filter((path) => path.includes(".tmp"))).toEqual([]);
  }, 30_000);

  it("нет утечек handles и памяти после 500 прогонов", async () => {
    const probe = (): { handles: number; heap: number } => {
      const handles = (
        process as unknown as { _getActiveHandles?: () => unknown[] }
      )._getActiveHandles?.();
      return { handles: handles ? handles.length : 0, heap: process.memoryUsage().heapUsed };
    };

    const fs = createStressFs({ [`${WORKSPACE}/leak.txt`]: "x\n" });
    const manager = createFileTransactionManager({ lockRegistry: createFileLockRegistry() });

    for (let index = 0; index < 50; index += 1) {
      await runTransaction(
        manager,
        fs,
        [updateOp(`${WORKSPACE}/leak.txt`, `w${index}\n`)],
        `warm-${index}`,
      );
    }
    globalThis.gc?.();
    const before = probe();

    for (let index = 0; index < 500; index += 1) {
      await runTransaction(
        manager,
        fs,
        [updateOp(`${WORKSPACE}/leak.txt`, `r${index}\n`)],
        `run-${index}`,
      );
    }
    globalThis.gc?.();
    const after = probe();

    expect(Math.abs(after.handles - before.handles)).toBeLessThanOrEqual(16);
    expect(after.heap - before.heap).toBeLessThan(64 * 1024 * 1024);

    console.info(
      `[stress][tx][leaks] handles ${before.handles}→${after.handles} heapDelta=${round(
        (after.heap - before.heap) / (1024 * 1024),
      )}MB`,
    );
  }, 120_000);
});
