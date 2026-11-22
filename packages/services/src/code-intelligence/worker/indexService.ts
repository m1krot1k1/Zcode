import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runFullIndex, runPartialIndex } from "./indexEngine.js";
import {
  countOf,
  databaseSizeBytes,
  openStore,
  readMeta,
  writeMeta,
  type IndexDatabase,
} from "./store.js";
import type { WorkerRequest } from "./workerProtocol.js";
import { workspaceIdentityOf } from "./workspaceIdentity.js";
import { hybridSearch } from "../ranking/hybridSearch.js";
import { readSymbolContext, readImpact, readTrace } from "../graph/symbolGraphReads.js";
import { readGraphOverview } from "../graph/graphOverview.js";
import { disposeTreeSitter } from "../ast/parserPool.js";
import { resetParserAccess } from "../ast/parserAccess.js";
import { databaseFileFor } from "./storePath.js";

/**
 * Ядро воркера индексации: реестр открытых workspace-БД и обработка запросов протокола.
 *
 * Единственный владелец `DatabaseSync` в WAL-режиме. Модуль не знает про `worker_threads`:
 * его вызывает и `indexWorker.ts` (тред), и `workerClient.ts` в in-process режиме
 * (тесты/бенчмарки), поэтому проверяется ровно тот же код, что работает в продакшене.
 */

export interface IndexProgressEvent {
  state: "idle" | "indexing" | "ready" | "error";
  discoveredFiles: number;
  indexedFiles: number;
  phase?: "scan" | "parse" | "write" | "done";
}

interface OpenWorkspace {
  db: IndexDatabase;
  filePath: string;
  cancelled: boolean;
  migratedFromV1: boolean;
  legacySizeBytes: number;
  identity: string;
}

export interface IndexServiceOptions {
  indexRootDir: string;
  onProgress?: (progress: IndexProgressEvent) => void;
  /** Подмена `fetch` для эмбеддингов: нужна тестам и бенчмарку. */
  embeddingFetch?: typeof fetch;
}

export interface RequestResult {
  ok: boolean;
  value?: unknown;
  error?: { message: string; code?: string };
}

export class CodeIndexService {
  private readonly workspaces = new Map<string, OpenWorkspace>();
  private readonly indexRootDir: string;
  private readonly onProgress: ((progress: IndexProgressEvent) => void) | undefined;
  private readonly embeddingFetch: typeof fetch | undefined;
  private shuttingDown = false;
  /** Последовательная очередь для операций записи (одно SQLite-соединение). */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: IndexServiceOptions) {
    this.indexRootDir = options.indexRootDir;
    this.onProgress = options.onProgress;
    this.embeddingFetch = options.embeddingFetch;
  }

  private async ensureOpen(request: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<OpenWorkspace> {
    const identity = workspaceIdentityOf(request);
    const existing = this.workspaces.get(identity);
    if (existing) return existing;
    const filePath = databaseFileFor(this.indexRootDir, identity);
    await mkdir(this.indexRootDir, { recursive: true });
    const outcome = await openStore(filePath);
    const record: OpenWorkspace = {
      db: outcome.db,
      filePath,
      cancelled: false,
      migratedFromV1: outcome.migratedFromV1,
      legacySizeBytes: outcome.legacySizeBytes,
      identity,
    };
    this.workspaces.set(identity, record);
    return record;
  }

  private diagnosticsOf(db: IndexDatabase): string[] {
    const raw = readMeta(db, "diagnostics");
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  private statusOf(workspace: OpenWorkspace): Record<string, unknown> {
    const { db } = workspace;
    const storedState = readMeta(db, "index_state");
    return {
      state:
        storedState === "ready" ? "ready" : storedState === "degraded" ? "degraded" : "unindexed",
      generation: Number(readMeta(db, "generation") ?? 0),
      updatedAt: readMeta(db, "updated_at") ? Number(readMeta(db, "updated_at")) : undefined,
      counts: {
        files: countOf(db, "files"),
        chunks: countOf(db, "chunks"),
        symbols: countOf(db, "symbols"),
        edges: countOf(db, "edges"),
      },
      schemaVersion: Number(readMeta(db, "schema_version") ?? 0),
      partial: readMeta(db, "index_partial") === "true",
      // Фаза эмбеддингов хранится в meta: статус должен переживать рестарт воркера.
      embeddingPhase: readMeta(db, "embedding_phase") ?? "not-configured",
      embeddingErrorCode: readMeta(db, "embedding_error_code"),
      embeddingErrorStatus: readMeta(db, "embedding_error_status"),
      migratedFromV1: workspace.migratedFromV1,
      legacySizeBytes: workspace.legacySizeBytes,
      diagnostics: this.diagnosticsOf(db),
    };
  }

  private async withSize(status: Record<string, unknown>, workspace: OpenWorkspace) {
    return { ...status, databaseBytes: await databaseSizeBytes(workspace.filePath) };
  }

  private applyEmbeddingConfig(
    db: IndexDatabase,
    request: Extract<WorkerRequest, { type: "embeddingConfig" }>,
  ): void {
    const clear = request.provider === null || request.endpoint === null || request.model === null;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (clear) {
        db.prepare(
          "DELETE FROM meta WHERE key IN ('embedding_provider','embedding_endpoint','embedding_model','vectors_model','embedding_api_key_configured')",
        ).run();
        db.exec(
          "UPDATE chunk_vectors SET provider_sketch_q4 = NULL, provider_scale = NULL, provider_identity = NULL",
        );
        db.exec("DELETE FROM sketch_postings WHERE kind = 1");
      } else {
        const entries: Array<[string, string]> = [];
        if (request.provider) entries.push(["embedding_provider", request.provider]);
        if (request.endpoint) entries.push(["embedding_endpoint", request.endpoint]);
        if (request.model) entries.push(["embedding_model", request.model]);
        if (request.apiKeyConfigured !== undefined)
          entries.push(["embedding_api_key_configured", String(request.apiKeyConfigured)]);
        for (const [key, value] of entries) writeMeta(db, key, value);
        if (request.clearVectors) {
          // Смена модели делает прежние проекции несравнимыми с новыми запросами, поэтому
          // векторы и их постинги удаляются целиком, а не «обнуляются поля».
          db.exec(
            "UPDATE chunk_vectors SET provider_sketch_q4 = NULL, provider_scale = NULL, provider_identity = NULL",
          );
          db.exec("DELETE FROM sketch_postings WHERE kind = 1");
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Запросы сериализуются: у сервиса одно соединение `DatabaseSync`, а SQLite не поддерживает
   * вложенные транзакции. Раньше `mutate` и проход по watcher-событиям могли прийти
   * одновременно и падать с «cannot start a transaction within a transaction».
   * Очередь сохраняет порядок поступления и не блокирует Event Loop: ожидание идёт
   * на промисах между проходами.
   */
  async handle(request: WorkerRequest): Promise<RequestResult> {
    const run = async (): Promise<RequestResult> => {
      try {
        const value = await this.dispatch(request);
        return { ok: true, value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
          request.type === "index" || request.type === "mutate" ? "index-failed" : undefined;
        return { ok: false, error: { message: message.slice(0, 2000), ...(code ? { code } : {}) } };
      }
    };
    // Читающие запросы не открывают транзакций и могут идти параллельно записи,
    // поэтому в очередь попадают только операции, меняющие состояние.
    if (request.type === "search" || request.type === "status" || request.type === "open") {
      return run();
    }
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous.catch(() => undefined);
      return await run();
    } finally {
      release();
    }
  }

  private async dispatch(request: WorkerRequest): Promise<unknown> {
    switch (request.type) {
      case "open":
      case "status": {
        const workspace = await this.ensureOpen(request);
        return this.withSize(this.statusOf(workspace), workspace);
      }
      case "index": {
        const workspace = await this.ensureOpen(request);
        workspace.cancelled = false;
        const run = await runFullIndex({
          workspacePath: request.workspacePath,
          db: workspace.db,
          ...(request.force !== undefined ? { force: request.force } : {}),
          ...(request.embeddingApiKey ? { embeddingApiKey: request.embeddingApiKey } : {}),
          ...(this.embeddingFetch ? { embeddingFetch: this.embeddingFetch } : {}),
          isCancelled: () => workspace.cancelled || this.shuttingDown,
          onProgress: (progress) => this.onProgress?.(progress),
        });
        return { ...(await this.withSize(this.statusOf(workspace), workspace)), run };
      }
      case "mutate": {
        const workspace = await this.ensureOpen(request);
        workspace.cancelled = false;
        const run = await runPartialIndex({
          workspacePath: request.workspacePath,
          db: workspace.db,
          changed: request.changed,
          removed: request.removed,
          ...(request.embeddingApiKey ? { embeddingApiKey: request.embeddingApiKey } : {}),
          ...(this.embeddingFetch ? { embeddingFetch: this.embeddingFetch } : {}),
          isCancelled: () => workspace.cancelled || this.shuttingDown,
          onProgress: (progress) => this.onProgress?.(progress),
        });
        return { ...(await this.withSize(this.statusOf(workspace), workspace)), run };
      }
      case "search": {
        const workspace = await this.ensureOpen(request);
        return hybridSearch(workspace.db, {
          query: request.query,
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          ...(request.lexicalOnly !== undefined ? { lexicalOnly: request.lexicalOnly } : {}),
          ...(request.activeFiles ? { activeFiles: request.activeFiles } : {}),
          ...(request.changedFiles ? { changedFiles: request.changedFiles } : {}),
          ...(request.embeddingApiKey ? { embeddingApiKey: request.embeddingApiKey } : {}),
          ...(this.embeddingFetch ? { embeddingFetch: this.embeddingFetch } : {}),
        });
      }
      case "symbolContext": {
        const workspace = await this.ensureOpen(request);
        return readSymbolContext(workspace.db, request.symbol);
      }
      case "graphOverview": {
        const workspace = await this.ensureOpen(request);
        return readGraphOverview(workspace.db, request);
      }
      case "impact": {
        const workspace = await this.ensureOpen(request);
        return readImpact(workspace.db, request.changedPaths);
      }
      case "trace": {
        const workspace = await this.ensureOpen(request);
        return readTrace(workspace.db, request.fromSymbol, request.toSymbol);
      }
      case "embeddingConfig": {
        const workspace = await this.ensureOpen(request);
        this.applyEmbeddingConfig(workspace.db, request);
        return this.withSize(this.statusOf(workspace), workspace);
      }
      case "clear": {
        const identity = workspaceIdentityOf(request);
        const workspace = this.workspaces.get(identity);
        if (workspace) {
          try {
            workspace.db.close();
          } catch {
            // Повторное закрытие безопасно.
          }
          this.workspaces.delete(identity);
          for (const suffix of ["", "-wal", "-shm"]) {
            await rm(`${workspace.filePath}${suffix}`, { force: true });
          }
        }
        return { cleared: true };
      }
      case "cancel": {
        for (const workspace of this.workspaces.values()) workspace.cancelled = true;
        return { cancelled: true };
      }
      case "shutdown": {
        this.shuttingDown = true;
        for (const workspace of this.workspaces.values()) {
          try {
            workspace.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } catch {
            // Checkpoint не критичен: WAL читается при следующем открытии.
          }
          try {
            workspace.db.close();
          } catch {
            // Повторное закрытие безопасно игнорировать.
          }
        }
        this.workspaces.clear();
        // Порядок важен: сначала сбрасываем кеш наших acquisitions, который ссылается на
        // парсеры, затем освобождаем сами wasm-ресурсы. Иначе кеш вернёт «мёртвый» парсер
        // и последующий разбор молча деградирует до текстового чанкера.
        resetParserAccess();
        disposeTreeSitter();
        return { stopped: true };
      }
    }
  }
}
