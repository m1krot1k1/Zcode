import { createHash } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getZCodeDataRootDir } from "../paths.js";
import type {
  CodeGraphOverview,
  CodeIndexStatus,
  CodeIntelligenceService,
  CodeSearchResult,
  EmbeddingErrorCode,
  EmbeddingTestResult,
} from "./contract.js";
import { scanWorkspace, type IndexedChunkRecord, type IndexedFileRecord } from "./scanner.js";
import { readGraphOverview } from "./graphQueries.js";
import {
  embeddingCredentialKey,
  updateEmbeddingConfig,
  type EmbeddingCredentialStore,
} from "./embeddingSettings.js";
import {
  MAX_DIAGNOSTICS,
  MAX_EMBED_BATCH,
  embeddingFailureFromError,
  cosineSimilarity,
  databaseFileFor,
  getEmbeddingConfig,
  getCounts,
  readImpact,
  readTrace,
  readSymbolContext,
  hasPartialCoverage,
  syncGraphFacts,
  lexicalScore,
  openDatabase,
  readEmbedding,
  readText,
  requestEmbeddings,
  rows,
  safeExcerpt,
  safeLimit,
  statusFromDb,
  tokenize,
  upsertFileRecord,
  workspaceIdentity,
  writeEmbedding,
  writeText,
  type CodeIndexDatabase,
  type IndexProgress,
  type Row,
} from "./database.js";
import { probeEmbeddingProvider } from "./embeddingProbe.js";
import { createWorkspaceWatcherRegistry } from "./workspaceWatcher.js";

type WorkspaceParams = { workspacePath: string; workspaceIdentity?: string };
type ManagedCodeIntelligenceService = CodeIntelligenceService & {
  disposeAll(): void;
  disposeAllAndWait(): Promise<void>;
};

const WATCHER_DIAGNOSTIC =
  "Workspace file watching is unavailable; refresh the local code index manually.";
const GRAPH_PARSER_VERSION = "3";
type Activation = { root: string; promise: Promise<void> };

interface CodeIntelligenceServiceOptions {
  indexRootDir?: string;
  fetch?: typeof fetch;
  credentialService?: EmbeddingCredentialStore;
}

export function createCodeIntelligenceService(
  options: CodeIntelligenceServiceOptions = {},
): ManagedCodeIntelligenceService {
  const indexRootDir = options.indexRootDir ?? join(getZCodeDataRootDir(), "code-intelligence");
  const fetchImpl = options.fetch ?? fetch;
  const credentialService = options.credentialService;
  const progressByIdentity = new Map<string, IndexProgress>();
  const activeIndexes = new Map<string, Promise<CodeIndexStatus>>();
  const diagnosticsByIdentity = new Map<string, string[]>();
  const activatedWorkspaceRoots = new Map<string, string>();
  const activationPromises = new Map<string, Activation>();
  const pendingWatcherRefreshes = new Map<string, WorkspaceParams>();
  const clearingWorkspaces = new Set<string>();
  let indexWorkspace: (params: WorkspaceParams & { force?: boolean }) => Promise<CodeIndexStatus>;

  const watcherRegistry = createWorkspaceWatcherRegistry({
    onChange(workspace) {
      const resolved = resolveWorkspace(workspace);
      pendingWatcherRefreshes.set(resolved.key, workspace);
      flushWatcherRefresh(resolved.key);
    },
    onError(workspace) {
      const resolved = resolveWorkspace(workspace);
      const diagnostics = diagnosticsByIdentity.get(resolved.key) ?? [];
      if (!diagnostics.includes(WATCHER_DIAGNOSTIC)) {
        diagnosticsByIdentity.set(resolved.key, [...diagnostics, WATCHER_DIAGNOSTIC]);
      }
    },
    onReady(workspace) {
      const resolved = resolveWorkspace(workspace);
      const diagnostics = diagnosticsByIdentity.get(resolved.key) ?? [];
      const remaining = diagnostics.filter((item) => item !== WATCHER_DIAGNOSTIC);
      if (remaining.length) diagnosticsByIdentity.set(resolved.key, remaining);
      else diagnosticsByIdentity.delete(resolved.key);
    },
  });

  const resolveWorkspace = (params: { workspacePath: string; workspaceIdentity?: string }) => {
    const identity = workspaceIdentity(params);
    const key = createHash("sha256").update(identity).digest("hex").slice(0, 32);
    const root = resolve(params.workspacePath);
    if (!isAbsolute(params.workspacePath) || !params.workspacePath.trim())
      throw new Error("Workspace path must be absolute.");
    return { identity, key, root, databasePath: databaseFileFor(indexRootDir, identity) };
  };

  const withDb = async <T>(
    params: { workspacePath: string; workspaceIdentity?: string },
    action: (db: CodeIndexDatabase) => Promise<T> | T,
  ): Promise<T> => {
    const workspace = resolveWorkspace(params);
    await mkdir(dirname(workspace.databasePath), { recursive: true });
    const db = openDatabase(workspace.databasePath);
    try {
      return await action(db);
    } finally {
      db.close();
    }
  };

  const armWatcher = async (params: WorkspaceParams): Promise<void> => {
    const workspace = resolveWorkspace(params);
    if (clearingWorkspaces.has(workspace.key)) {
      throw new Error("The workspace code index is being cleared.");
    }
    await watcherRegistry.ensure(workspace.key, workspace.root, {
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    if (clearingWorkspaces.has(workspace.key)) {
      await watcherRegistry.stop(workspace.key);
      throw new Error("The workspace code index is being cleared.");
    }
  };

  const flushWatcherRefresh = (key: string): void => {
    if (clearingWorkspaces.has(key) || activeIndexes.has(key)) return;
    const params = pendingWatcherRefreshes.get(key);
    if (!params) return;
    pendingWatcherRefreshes.delete(key);
    queueMicrotask(() => {
      if (clearingWorkspaces.has(key)) return;
      void indexWorkspace(params).catch(() => {});
    });
  };

  const watchWorkspace = async (params: WorkspaceParams): Promise<void> => {
    const workspace = resolveWorkspace(params);
    if (clearingWorkspaces.has(workspace.key)) {
      throw new Error("The workspace code index is being cleared.");
    }
    const existingActivation = activationPromises.get(workspace.key);
    if (existingActivation) {
      if (existingActivation.root === workspace.root) return existingActivation.promise;
      await existingActivation.promise.catch(() => undefined);
      return watchWorkspace(params);
    }
    if (activatedWorkspaceRoots.get(workspace.key) === workspace.root) {
      await armWatcher(params);
      return;
    }
    const activation = (async () => {
      await armWatcher(params);
      if (clearingWorkspaces.has(workspace.key)) return;
      const status = await getStatus(params);
      // Never build a first index implicitly. Existing indexes are reconciled once per Host
      // activation so edits made while ZCode was closed are caught before the next query.
      if (status.generation > 0) await indexWorkspace(params);
      if (!clearingWorkspaces.has(workspace.key))
        activatedWorkspaceRoots.set(workspace.key, workspace.root);
    })();
    const entry = { root: workspace.root, promise: activation };
    activationPromises.set(workspace.key, entry);
    try {
      await activation;
    } finally {
      if (activationPromises.get(workspace.key) === entry) activationPromises.delete(workspace.key);
    }
  };

  const getStatus = async (params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<CodeIndexStatus> => {
    const workspace = resolveWorkspace(params);
    const progress = progressByIdentity.get(workspace.key);
    try {
      await access(workspace.databasePath);
      const status = await withDb(params, (db) => statusFromDb(db, progress));
      const runtimeDiagnostics = diagnosticsByIdentity.get(workspace.key) ?? [];
      return {
        ...status,
        diagnostics: [...status.diagnostics, ...runtimeDiagnostics].slice(0, MAX_DIAGNOSTICS),
      };
    } catch (error) {
      if (!progress && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          state: "unindexed",
          generation: 0,
          counts: { files: 0, chunks: 0, symbols: 0, edges: 0 },
          embedding: { configured: false, available: false, phase: "not-configured" },
          diagnostics: [],
        };
      }
      return {
        state: progress?.state ?? "degraded",
        generation: 0,
        counts: { files: 0, chunks: 0, symbols: 0, edges: 0 },
        embedding: { configured: false, available: false, phase: "not-configured" },
        diagnostics: ["The local code index could not be opened."],
        ...(progress?.state === "indexing"
          ? {
              progress: {
                discoveredFiles: progress.discoveredFiles,
                indexedFiles: progress.indexedFiles,
              },
            }
          : {}),
      };
    }
  };

  const performIndexWorkspace = (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    force?: boolean;
  }): Promise<CodeIndexStatus> => {
    const workspace = resolveWorkspace(params);
    const existing = activeIndexes.get(workspace.key);
    if (existing) return existing;
    const work = (async (): Promise<CodeIndexStatus> => {
      progressByIdentity.set(workspace.key, {
        state: "indexing",
        discoveredFiles: 0,
        indexedFiles: 0,
        diagnostics: [],
      });
      const watcherDiagnostic =
        diagnosticsByIdentity.get(workspace.key)?.filter((item) => item === WATCHER_DIAGNOSTIC) ??
        [];
      if (watcherDiagnostic.length) diagnosticsByIdentity.set(workspace.key, watcherDiagnostic);
      else diagnosticsByIdentity.delete(workspace.key);
      try {
        const rootStat = await import("node:fs/promises").then(({ stat: statPath }) =>
          statPath(workspace.root),
        );
        if (!rootStat.isDirectory()) throw new Error("Workspace is not a directory.");
        const result = await withDb(params, async (db) => {
          const oldFiles = rows<Row>(
            db,
            "SELECT path, mtime_ms AS mtimeMs, ctime_ms AS ctimeMs, size, fingerprint FROM files",
          );
          const previous = new Map(
            oldFiles.map((file) => [
              String(file.path),
              {
                mtimeMs: Number(file.mtimeMs),
                ctimeMs: Number(file.ctimeMs),
                size: Number(file.size),
                fingerprint: String(file.fingerprint),
              },
            ]),
          );
          const graphRebuildRequired =
            readText(db, "graph_parser_version") !== GRAPH_PARSER_VERSION;
          const scan = await scanWorkspace(
            workspace.root,
            previous,
            Boolean(params.force),
            (discoveredFiles, indexedFiles) => {
              const current = progressByIdentity.get(workspace.key);
              if (current)
                progressByIdentity.set(workspace.key, {
                  ...current,
                  discoveredFiles,
                  indexedFiles,
                });
            },
            { reparseUnchanged: graphRebuildRequired },
          );
          const filePaths = new Set(
            scan.files.filter((file) => !file.excluded).map((file) => file.path),
          );
          const records: IndexedFileRecord[] = [];
          const changedChunks: IndexedChunkRecord[] = [];
          for (const file of scan.files) {
            if (file.excluded) continue;
            if (file.changed || graphRebuildRequired) {
              if (file.record) {
                records.push(file.record);
                if (file.changed) changedChunks.push(...file.record.chunks);
              }
            }
          }
          const config = getEmbeddingConfig(db);
          const modelIdentity = config.identity;
          let embeddingAvailable = false;
          let embeddingFailure: { code: EmbeddingErrorCode; httpStatus?: number } | undefined;
          const diagnostics = [...scan.diagnostics];
          const vectorsModel = readText(db, "vectors_model");
          const changedPaths = new Set(
            scan.files.filter((file) => file.changed || file.excluded).map((file) => file.path),
          );
          const needsFullReembed = Boolean(modelIdentity && vectorsModel !== modelIdentity);
          embeddingAvailable = Boolean(
            config.endpoint && config.model && modelIdentity && vectorsModel === modelIdentity,
          );
          if (
            config.endpoint &&
            config.model &&
            modelIdentity &&
            (changedChunks.length > 0 || needsFullReembed)
          ) {
            let embeddingCompleted = 0;
            const embeddingTotal = needsFullReembed
              ? Math.max(changedChunks.length, getCounts(db).chunks)
              : changedChunks.length;
            const setEmbeddingProgress = () => {
              const current = progressByIdentity.get(workspace.key);
              if (current)
                progressByIdentity.set(workspace.key, {
                  ...current,
                  embeddingPhase: "building",
                  embeddingCompleted,
                  embeddingTotal,
                });
            };
            setEmbeddingProgress();
            try {
              const storedApiKey = await credentialService?.load(
                embeddingCredentialKey(workspace.key),
              );
              const requestConfig = {
                ...config,
                ...(storedApiKey?.trim() ? { apiKey: storedApiKey.trim() } : {}),
              };
              const embedBatch = async (input: string[]) => {
                try {
                  return await requestEmbeddings(requestConfig, input, fetchImpl);
                } catch (error) {
                  embeddingFailure = embeddingFailureFromError(error);
                  throw error;
                }
              };
              // Network calls stay outside the main transaction. Existing vectors are staged in
              // a connection-local temp table so a model change never duplicates the whole index
              // in JavaScript memory and only a fully successful embedding pass is published.
              db.exec(
                "CREATE TEMP TABLE IF NOT EXISTS pending_embeddings (id TEXT PRIMARY KEY, embedding BLOB NOT NULL)",
              );
              db.exec("DELETE FROM temp.pending_embeddings");
              const stageEmbedding = db.prepare(
                "INSERT OR REPLACE INTO temp.pending_embeddings(id, embedding) VALUES(?, ?)",
              );
              for (let offset = 0; offset < changedChunks.length; offset += MAX_EMBED_BATCH) {
                const batch = changedChunks.slice(offset, offset + MAX_EMBED_BATCH);
                const embeddings = await embedBatch(batch.map((chunk) => chunk.content));
                batch.forEach((chunk, index) => {
                  chunk.embedding = writeEmbedding(embeddings[index]!);
                  chunk.embeddingModel = modelIdentity;
                });
                embeddingCompleted += batch.length;
                setEmbeddingProgress();
              }
              if (needsFullReembed) {
                const pageSize = MAX_EMBED_BATCH;
                let lastId = "";
                while (true) {
                  const page = rows<Row>(
                    db,
                    "SELECT id, path, content FROM chunks WHERE id > ? AND (embedding_model IS NULL OR embedding_model <> ?) ORDER BY id LIMIT ?",
                    lastId,
                    modelIdentity,
                    pageSize,
                  );
                  const eligible = page.filter((chunk) => !changedPaths.has(String(chunk.path)));
                  if (eligible.length > 0) {
                    const embeddings = await embedBatch(
                      eligible.map((chunk) => String(chunk.content)),
                    );
                    eligible.forEach((chunk, index) => {
                      stageEmbedding.run(String(chunk.id), writeEmbedding(embeddings[index]!));
                    });
                    embeddingCompleted += eligible.length;
                    setEmbeddingProgress();
                  }
                  if (page.length < pageSize) break;
                  lastId = String(page[page.length - 1]!.id);
                }
              }
              embeddingAvailable = true;
            } catch (error) {
              // Provider failures may fall back to lexical search; DB staging failures must abort indexing.
              if (!embeddingFailure) throw error;
              for (const chunk of changedChunks) {
                chunk.embedding = null;
                chunk.embeddingModel = null;
              }
              db.exec("DELETE FROM temp.pending_embeddings");
              embeddingAvailable = false;
              diagnostics.unshift(
                "Embedding generation failed; the local lexical index remains available.",
              );
            }
          }
          progressByIdentity.set(workspace.key, {
            ...progressByIdentity.get(workspace.key)!,
            state: "indexing",
            discoveredFiles: scan.files.length,
            indexedFiles: scan.files.length,
            diagnostics,
          });
          db.exec("BEGIN IMMEDIATE");
          try {
            if (graphRebuildRequired) {
              // Старые поколения не содержат всех импортированных вызовов; пересобираем только графовые таблицы.
              db.exec("DELETE FROM edges; DELETE FROM imported_calls; DELETE FROM symbols;");
            }
            const existingPaths = oldFiles.map((file) => String(file.path));
            for (const existingPath of existingPaths) {
              if (!filePaths.has(existingPath)) {
                db.prepare("DELETE FROM edges WHERE target_path = ?").run(existingPath);
                db.prepare("DELETE FROM files WHERE path = ?").run(existingPath);
              }
            }
            for (const file of scan.files) {
              if (!file.changed && !file.excluded) continue;
              // Imports from unchanged files target stable module IDs (`m:<relative-path>`), so
              // preserve inbound edges for changed files and rebuild only outgoing edges.
              db.prepare("DELETE FROM edges WHERE source_path = ?").run(file.path);
              db.prepare("DELETE FROM files WHERE path = ?").run(file.path);
            }
            const refreshMeta = db.prepare(
              "UPDATE files SET mtime_ms = ?, ctime_ms = ?, size = ?, fingerprint = COALESCE(?, fingerprint) WHERE path = ?",
            );
            for (const file of scan.files) {
              if (file.changed || file.excluded) continue;
              refreshMeta.run(
                file.mtimeMs,
                file.ctimeMs,
                file.size,
                file.fingerprint ?? null,
                file.path,
              );
            }
            for (const file of scan.files) {
              if (!file.changed || file.excluded) continue;
              const record = file.record;
              if (record) upsertFileRecord(db, record);
            }
            // Write edges after changed files so later deletes cannot remove earlier writes.
            syncGraphFacts(
              db,
              records,
              graphRebuildRequired
                ? scan.files.flatMap((file) =>
                    !file.changed && !file.excluded && file.record ? [file.record] : [],
                  )
                : [],
              filePaths,
            );
            // Cross-file call links are derived from named imports. Rebuild them from persisted
            // import facts so editing either endpoint refreshes callers without rescanning sources.
            db.prepare(
              "DELETE FROM edges WHERE relation = 'calls' AND source_path <> target_path",
            ).run();
            db.prepare(
              `INSERT OR IGNORE INTO edges(source_id, target_id, relation, source_path, target_path)
               SELECT imported_calls.source_id, target.id, 'calls', imported_calls.source_path, imported_calls.target_path
               FROM imported_calls
               JOIN symbols AS source ON source.id = imported_calls.source_id
               JOIN symbols AS target
                 ON target.path = imported_calls.target_path
                AND target.name = imported_calls.imported_name
                AND target.exported = 1
               WHERE (SELECT COUNT(*) FROM symbols AS candidate
                      WHERE candidate.path = imported_calls.target_path
                        AND candidate.name = imported_calls.imported_name
                        AND candidate.exported = 1) = 1`,
            ).run();
            if (embeddingAvailable && modelIdentity && needsFullReembed) {
              db.prepare(
                "UPDATE chunks SET embedding = (SELECT embedding FROM temp.pending_embeddings WHERE pending_embeddings.id = chunks.id), embedding_model = ? WHERE id IN (SELECT id FROM temp.pending_embeddings)",
              ).run(modelIdentity);
            }
            const generation = Number(readText(db, "generation") ?? 0) + 1;
            const now = Date.now();
            writeText(db, "generation", String(generation));
            writeText(db, "graph_parser_version", GRAPH_PARSER_VERSION);
            writeText(db, "index_state", "ready");
            writeText(db, "index_partial", String(scan.partial));
            writeText(db, "updated_at", String(now));
            writeText(db, "diagnostics", JSON.stringify(diagnostics.slice(0, MAX_DIAGNOSTICS)));
            writeText(
              db,
              "vectors_model",
              embeddingAvailable && modelIdentity ? modelIdentity : "",
            );
            if (!config.endpoint || !config.model) {
              db.prepare(
                "DELETE FROM index_meta WHERE key IN ('embedding_phase','embedding_error_code','embedding_http_status')",
              ).run();
            } else {
              writeText(db, "embedding_phase", embeddingAvailable ? "ready" : "failed");
              if (embeddingAvailable) {
                db.prepare(
                  "DELETE FROM index_meta WHERE key IN ('embedding_error_code','embedding_http_status')",
                ).run();
              } else if (embeddingFailure) {
                writeText(db, "embedding_error_code", embeddingFailure.code);
                if (embeddingFailure.httpStatus !== undefined)
                  writeText(db, "embedding_http_status", String(embeddingFailure.httpStatus));
                else db.prepare("DELETE FROM index_meta WHERE key = 'embedding_http_status'").run();
              }
            }
            db.exec("COMMIT");
            const current = progressByIdentity.get(workspace.key);
            if (current && config.endpoint && config.model) {
              progressByIdentity.set(workspace.key, {
                ...current,
                embeddingPhase: embeddingAvailable ? "ready" : "failed",
              });
            }
            return { generation, diagnostics };
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        });
        void result;
        progressByIdentity.delete(workspace.key);
        return await withDb(params, (db) => statusFromDb(db));
      } catch {
        const diagnostics = ["Indexing failed; the last committed generation remains available."];
        diagnosticsByIdentity.set(workspace.key, diagnostics);
        progressByIdentity.set(workspace.key, {
          state: "degraded",
          discoveredFiles: 0,
          indexedFiles: 0,
          diagnostics,
        });
        try {
          await withDb(params, (db) => {
            writeText(db, "diagnostics", JSON.stringify(diagnostics));
            writeText(db, "index_state", "degraded");
          });
        } catch {
          // Preserve the committed DB even if a diagnostic write cannot be completed.
        }
        return await getStatus(params);
      } finally {
        progressByIdentity.delete(workspace.key);
      }
    })();
    activeIndexes.set(workspace.key, work);
    void work.then(
      () => {
        activeIndexes.delete(workspace.key);
        flushWatcherRefresh(workspace.key);
      },
      () => {
        activeIndexes.delete(workspace.key);
        flushWatcherRefresh(workspace.key);
      },
    );
    return work;
  };

  indexWorkspace = async (params) => {
    // Arm first so events racing the initial scan become a queued incremental pass.
    await armWatcher(params);
    const workspace = resolveWorkspace(params);
    if (clearingWorkspaces.has(workspace.key)) {
      throw new Error("The workspace code index is being cleared.");
    }
    return performIndexWorkspace(params);
  };

  const testEmbeddingConfig = async (
    params: WorkspaceParams & {
      provider: "ollama" | "openai-compatible";
      endpoint: string;
      model: string;
      apiKey?: string;
    },
  ): Promise<EmbeddingTestResult> => {
    const workspace = resolveWorkspace(params);
    return probeEmbeddingProvider(
      params,
      embeddingCredentialKey(workspace.key),
      credentialService,
      fetchImpl,
    );
  };

  const service: CodeIntelligenceService = {
    getStatus,
    watchWorkspace,
    indexWorkspace,
    async search(params) {
      const query = params.query.trim();
      if (!query) return { results: [], semantic: false, partial: false };
      return withDb(params, async (db) => {
        const terms = tokenize(query);
        if (terms.length === 0) return { results: [], semantic: false, partial: false };
        const limit = safeLimit(params.limit);
        const candidateLimit = 1000;
        const symbolPredicates = terms.map(() => "name LIKE ? OR signature LIKE ?").join(" OR ");
        const chunkPredicates = terms.map(() => "content LIKE ?").join(" OR ");
        const patterns = terms.map((term) => `%${term}%`);
        const symbols = rows<Row>(
          db,
          `SELECT id, name, kind, path, start_line AS startLine, end_line AS endLine, signature FROM symbols WHERE ${symbolPredicates} LIMIT ?`,
          ...patterns.flatMap((pattern) => [pattern, pattern]),
          candidateLimit + 1,
        );
        const chunks = rows<Row>(
          db,
          `SELECT id, path, start_line AS startLine, end_line AS endLine, content FROM chunks WHERE ${chunkPredicates} LIMIT ?`,
          ...patterns,
          candidateLimit + 1,
        );
        const candidatesTruncated =
          symbols.length > candidateLimit || chunks.length > candidateLimit;
        if (symbols.length > candidateLimit) symbols.length = candidateLimit;
        if (chunks.length > candidateLimit) chunks.length = candidateLimit;
        const byKey = new Map<string, CodeSearchResult>();
        for (const symbol of symbols) {
          const score = Math.max(
            lexicalScore(terms, String(symbol.name)),
            lexicalScore(terms, String(symbol.signature)) * 0.75,
          );
          if (score <= 0) continue;
          const key = `${symbol.path}:${symbol.startLine}`;
          byKey.set(key, {
            path: String(symbol.path),
            startLine: Number(symbol.startLine),
            endLine: Number(symbol.endLine),
            symbolName: String(symbol.name),
            symbolKind: String(symbol.kind),
            excerpt: safeExcerpt(String(symbol.signature)),
            match: "lexical",
            score: Math.min(
              1,
              score + (String(symbol.name).toLowerCase() === query.toLowerCase() ? 0.45 : 0.12),
            ),
          });
        }
        for (const chunk of chunks) {
          const score = lexicalScore(terms, String(chunk.content));
          if (score <= 0) continue;
          const key = `${chunk.path}:${chunk.startLine}`;
          const existing = byKey.get(key);
          const result: CodeSearchResult = {
            path: String(chunk.path),
            startLine: Number(chunk.startLine),
            endLine: Number(chunk.endLine),
            excerpt: safeExcerpt(String(chunk.content)),
            match: "lexical",
            score: score * 0.8,
          };
          if (!existing || result.score > existing.score) byKey.set(key, result);
        }
        const config = getEmbeddingConfig(db);
        let semantic = false;
        if (
          config.endpoint &&
          config.model &&
          config.identity &&
          readText(db, "vectors_model") === config.identity
        ) {
          try {
            const workspace = resolveWorkspace(params);
            const storedApiKey = await credentialService?.load(
              embeddingCredentialKey(workspace.key),
            );
            const requestConfig = {
              ...config,
              ...(storedApiKey?.trim() ? { apiKey: storedApiKey.trim() } : {}),
            };
            const [queryVector] = await requestEmbeddings(requestConfig, [query], fetchImpl);
            if (queryVector) {
              semantic = true;
              const semanticCandidates: Array<{ id: string; score: number }> = [];
              let lastId = "";
              while (true) {
                const page = rows<Row>(
                  db,
                  "SELECT id, embedding FROM chunks WHERE id > ? AND embedding_model = ? AND embedding IS NOT NULL ORDER BY id LIMIT 256",
                  lastId,
                  config.identity,
                );
                if (page.length === 0) break;
                for (const chunk of page) {
                  const vector = readEmbedding(chunk.embedding);
                  if (!vector) continue;
                  const score = Math.max(0, cosineSimilarity(queryVector, vector));
                  if (semanticCandidates.length < 200 || score > semanticCandidates.at(-1)!.score) {
                    semanticCandidates.push({ id: String(chunk.id), score });
                    semanticCandidates.sort((left, right) => right.score - left.score);
                    if (semanticCandidates.length > 200) semanticCandidates.pop();
                  }
                }
                lastId = String(page[page.length - 1]!.id);
                if (page.length < 256) break;
              }
              for (const candidate of semanticCandidates) {
                const chunk = rows<Row>(
                  db,
                  "SELECT path, start_line AS startLine, end_line AS endLine, content FROM chunks WHERE id = ?",
                  candidate.id,
                )[0];
                if (!chunk) continue;
                const key = `${chunk.path}:${chunk.startLine}`;
                const existing = byKey.get(key);
                const combined = Math.min(1, candidate.score * 0.7 + (existing?.score ?? 0) * 0.3);
                byKey.set(key, {
                  path: String(chunk.path),
                  startLine: Number(chunk.startLine),
                  endLine: Number(chunk.endLine),
                  excerpt: safeExcerpt(String(chunk.content)),
                  match: "semantic",
                  score: combined,
                });
              }
            }
          } catch {
            const workspace = resolveWorkspace(params);
            diagnosticsByIdentity.set(workspace.key, [
              "Embedding search is unavailable; showing lexical results.",
            ]);
          }
        }
        const results = [...byKey.values()]
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
        return { results, semantic, partial: candidatesTruncated || hasPartialCoverage(db) };
      });
    },
    async getSymbolContext(params) {
      return withDb(params, (db) => readSymbolContext(db, params.symbol));
    },
    async getGraphOverview(params): Promise<CodeGraphOverview> {
      return withDb(params, (db) => readGraphOverview(db, params));
    },
    async getImpact(params) {
      return withDb(params, (db) => readImpact(db, params.changedPaths));
    },
    async trace(params) {
      return withDb(params, (db) => readTrace(db, params.fromSymbol, params.toSymbol));
    },
    testEmbeddingConfig,
    async setEmbeddingConfig(params) {
      const workspace = resolveWorkspace(params);
      return withDb(params, (db) =>
        updateEmbeddingConfig(db, params, embeddingCredentialKey(workspace.key), credentialService),
      );
    },
    async clearIndex(params) {
      const workspace = resolveWorkspace(params);
      clearingWorkspaces.add(workspace.key);
      try {
        await watcherRegistry.stop(workspace.key);
        const active = activeIndexes.get(workspace.key);
        if (active) await active.catch(() => undefined);
        pendingWatcherRefreshes.delete(workspace.key);
        const activation = activationPromises.get(workspace.key);
        if (activation) await activation.promise.catch(() => undefined);
        activatedWorkspaceRoots.delete(workspace.key);
        await credentialService?.delete(embeddingCredentialKey(workspace.key));
        await rm(workspace.databasePath, { force: true });
        await rm(`${workspace.databasePath}-wal`, { force: true });
        await rm(`${workspace.databasePath}-shm`, { force: true });
        diagnosticsByIdentity.delete(workspace.key);
        progressByIdentity.delete(workspace.key);
      } finally {
        clearingWorkspaces.delete(workspace.key);
      }
    },
  };
  return Object.assign(service, {
    disposeAll() {
      watcherRegistry.disposeAll();
    },
    disposeAllAndWait() {
      return watcherRegistry.disposeAllAndWait();
    },
  });
}
