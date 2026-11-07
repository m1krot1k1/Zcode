import { createHash } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getZCodeDataRootDir } from "../paths.js";
import type {
  CodeImpactResult,
  CodeIndexStatus,
  CodeIntelligenceService,
  CodeSearchResult,
  CodeSymbolContext,
  CodeTraceResult,
} from "./contract.js";
import { scanWorkspace, type IndexedChunkRecord, type IndexedFileRecord } from "./scanner.js";
import {
  MAX_DIAGNOSTICS,
  MAX_EMBED_BATCH,
  cosineSimilarity,
  databaseFileFor,
  getEmbeddingConfig,
  hasPartialCoverage,
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
  validateEmbeddingConfig,
  workspaceIdentity,
  writeEmbedding,
  writeText,
  type CodeIndexDatabase,
  type EmbeddingConfig,
  type IndexProgress,
  type Row,
} from "./database.js";

interface CodeIntelligenceServiceOptions {
  indexRootDir?: string;
  fetch?: typeof fetch;
}

export function createCodeIntelligenceService(
  options: CodeIntelligenceServiceOptions = {},
): CodeIntelligenceService {
  const indexRootDir = options.indexRootDir ?? join(getZCodeDataRootDir(), "code-intelligence");
  const fetchImpl = options.fetch ?? fetch;
  const progressByIdentity = new Map<string, IndexProgress>();
  const activeIndexes = new Map<string, Promise<CodeIndexStatus>>();
  const diagnosticsByIdentity = new Map<string, string[]>();

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
          embedding: { configured: false, available: false },
          diagnostics: [],
        };
      }
      return {
        state: progress?.state ?? "degraded",
        generation: 0,
        counts: { files: 0, chunks: 0, symbols: 0, edges: 0 },
        embedding: { configured: false, available: false },
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

  const indexWorkspace = (params: {
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
      diagnosticsByIdentity.delete(workspace.key);
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
          );
          const filePaths = new Set(
            scan.files.filter((file) => !file.excluded).map((file) => file.path),
          );
          const records: IndexedFileRecord[] = [];
          const changedChunks: IndexedChunkRecord[] = [];
          for (const file of scan.files) {
            if (file.excluded) continue;
            if (file.changed) {
              if (file.record) {
                records.push(file.record);
                changedChunks.push(...file.record.chunks);
              }
            }
          }
          const config = getEmbeddingConfig(db);
          let embeddingAvailable = false;
          const diagnostics = [...scan.diagnostics];
          const vectorsModel = readText(db, "vectors_model");
          const changedPaths = new Set(
            scan.files.filter((file) => file.changed || file.excluded).map((file) => file.path),
          );
          const needsFullReembed = Boolean(config.model && vectorsModel !== config.model);
          embeddingAvailable = Boolean(
            config.endpoint && config.model && vectorsModel === config.model,
          );
          if (config.endpoint && config.model && (changedChunks.length > 0 || needsFullReembed)) {
            try {
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
                const embeddings = await requestEmbeddings(
                  config,
                  batch.map((chunk) => chunk.content),
                  fetchImpl,
                );
                batch.forEach((chunk, index) => {
                  chunk.embedding = writeEmbedding(embeddings[index]!);
                  chunk.embeddingModel = config.model;
                });
              }
              if (needsFullReembed) {
                const pageSize = MAX_EMBED_BATCH;
                let lastId = "";
                while (true) {
                  const page = rows<Row>(
                    db,
                    "SELECT id, path, content FROM chunks WHERE id > ? AND (embedding_model IS NULL OR embedding_model <> ?) ORDER BY id LIMIT ?",
                    lastId,
                    config.model,
                    pageSize,
                  );
                  const eligible = page.filter((chunk) => !changedPaths.has(String(chunk.path)));
                  if (eligible.length > 0) {
                    const embeddings = await requestEmbeddings(
                      config,
                      eligible.map((chunk) => String(chunk.content)),
                      fetchImpl,
                    );
                    eligible.forEach((chunk, index) => {
                      stageEmbedding.run(String(chunk.id), writeEmbedding(embeddings[index]!));
                    });
                  }
                  if (page.length < pageSize) break;
                  lastId = String(page[page.length - 1]!.id);
                }
              }
              embeddingAvailable = true;
            } catch {
              for (const chunk of changedChunks) {
                chunk.embedding = null;
                chunk.embeddingModel = null;
              }
              db.exec("DELETE FROM temp.pending_embeddings");
              embeddingAvailable = false;
              diagnostics.push(
                "The local embedding model was unavailable; the index was committed for lexical search.",
              );
            }
          }
          progressByIdentity.set(workspace.key, {
            state: "indexing",
            discoveredFiles: scan.files.length,
            indexedFiles: scan.files.length,
            diagnostics,
          });
          db.exec("BEGIN IMMEDIATE");
          try {
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
            // Write outgoing edges after all changed files are present, so file order cannot
            // remove an edge just written by an earlier changed file in this same generation.
            for (const record of records) {
              for (const edge of record.edges) {
                if (!filePaths.has(edge.targetPath)) continue;
                db.prepare(
                  "INSERT OR IGNORE INTO edges(source_id, target_id, relation, source_path, target_path) VALUES(?, ?, ?, ?, ?)",
                ).run(
                  edge.sourceId,
                  edge.targetId,
                  edge.relation,
                  edge.sourcePath,
                  edge.targetPath,
                );
              }
            }
            if (embeddingAvailable && config.model && needsFullReembed) {
              db.prepare(
                "UPDATE chunks SET embedding = (SELECT embedding FROM temp.pending_embeddings WHERE pending_embeddings.id = chunks.id), embedding_model = ? WHERE id IN (SELECT id FROM temp.pending_embeddings)",
              ).run(config.model);
            }
            const generation = Number(readText(db, "generation") ?? 0) + 1;
            const now = Date.now();
            writeText(db, "generation", String(generation));
            writeText(db, "index_state", "ready");
            writeText(db, "index_partial", String(scan.partial));
            writeText(db, "updated_at", String(now));
            writeText(db, "diagnostics", JSON.stringify(diagnostics.slice(0, MAX_DIAGNOSTICS)));
            writeText(db, "vectors_model", embeddingAvailable && config.model ? config.model : "");
            db.exec("COMMIT");
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
      () => activeIndexes.delete(workspace.key),
      () => activeIndexes.delete(workspace.key),
    );
    return work;
  };

  const service: CodeIntelligenceService = {
    getStatus,
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
        if (config.endpoint && config.model && readText(db, "vectors_model") === config.model) {
          try {
            const [queryVector] = await requestEmbeddings(config, [query], fetchImpl);
            if (queryVector) {
              semantic = true;
              const semanticCandidates: Array<{ id: string; score: number }> = [];
              let lastId = "";
              while (true) {
                const page = rows<Row>(
                  db,
                  "SELECT id, embedding FROM chunks WHERE id > ? AND embedding_model = ? AND embedding IS NOT NULL ORDER BY id LIMIT 256",
                  lastId,
                  config.model,
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
              "Local semantic search is unavailable; showing lexical results.",
            ]);
          }
        }
        const results = [...byKey.values()]
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
        return { results, semantic, partial: candidatesTruncated || hasPartialCoverage(db) };
      });
    },
    async getSymbolContext(params): Promise<CodeSymbolContext | null> {
      return withDb(params, (db) => {
        const matches = rows<Row>(
          db,
          "SELECT id, name, kind, path, start_line AS startLine, end_line AS endLine FROM symbols WHERE id = ? OR name = ? ORDER BY exported DESC, start_line LIMIT 1",
          params.symbol,
          params.symbol,
        );
        const symbol = matches[0];
        if (!symbol) return null;
        const outgoing = rows<Row>(
          db,
          "SELECT e.target_id AS id, e.relation, s.name, s.path, s.start_line AS startLine FROM edges e LEFT JOIN symbols s ON s.id=e.target_id WHERE e.source_id = ? LIMIT 101",
          String(symbol.id),
        );
        const incoming = rows<Row>(
          db,
          "SELECT e.source_id AS id, e.relation, s.name, s.path, s.start_line AS startLine FROM edges e LEFT JOIN symbols s ON s.id=e.source_id WHERE e.target_id = ? LIMIT 101",
          String(symbol.id),
        );
        const related = (items: Row[]) =>
          items.map((item) => ({
            name: String(item.name ?? item.path ?? "module"),
            path: String(item.path ?? ""),
            startLine: Number(item.startLine ?? 1),
          }));
        return {
          symbol: {
            id: String(symbol.id),
            name: String(symbol.name),
            kind: String(symbol.kind),
            path: String(symbol.path),
            startLine: Number(symbol.startLine),
            endLine: Number(symbol.endLine),
          },
          callers: related(incoming.slice(0, 100)),
          dependencies: related(outgoing.slice(0, 100)),
          partial: incoming.length > 100 || outgoing.length > 100 || hasPartialCoverage(db),
        };
      });
    },
    async getImpact(params): Promise<CodeImpactResult> {
      return withDb(params, (db) => {
        const normalized = [
          ...new Set(
            params.changedPaths.map((path) =>
              path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, ""),
            ),
          ),
        ].slice(0, 100);
        const distance = new Map<string, number>();
        const queue = normalized.map((path) => ({ path, depth: 0 }));
        let partial = hasPartialCoverage(db);
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
          const current = queue[cursor]!;
          if (current.depth >= 4) continue;
          const upstream = rows<Row>(
            db,
            "SELECT DISTINCT source_path AS sourcePath FROM edges WHERE target_path = ? LIMIT 501",
            current.path,
          );
          if (upstream.length > 500) partial = true;
          for (const edge of upstream.slice(0, 500)) {
            if (distance.has(String(edge.sourcePath))) continue;
            if (distance.size >= 1000) {
              partial = true;
              break;
            }
            const nextDepth = current.depth + 1;
            distance.set(String(edge.sourcePath), nextDepth);
            queue.push({ path: String(edge.sourcePath), depth: nextDepth });
          }
          if (distance.size >= 1000) break;
        }
        const affectedSymbols: CodeImpactResult["affectedSymbols"] = [];
        for (const [path, depth] of [...distance].sort((left, right) => left[1] - right[1])) {
          const found = rows<Row>(
            db,
            "SELECT name, path, start_line AS startLine FROM symbols WHERE path = ? ORDER BY exported DESC LIMIT 9",
            path,
          );
          if (found.length > 8) partial = true;
          for (const symbol of found)
            affectedSymbols.push({
              name: String(symbol.name),
              path,
              startLine: Number(symbol.startLine),
              distance: depth,
            });
          if (affectedSymbols.length >= 100) {
            partial = true;
            break;
          }
        }
        affectedSymbols.sort(
          (left, right) => left.distance - right.distance || left.path.localeCompare(right.path),
        );
        return {
          changedPaths: normalized,
          affectedSymbols: affectedSymbols.slice(0, 100),
          partial,
        };
      });
    },
    async trace(params): Promise<CodeTraceResult> {
      return withDb(params, (db) => {
        const from = rows<Row>(
          db,
          "SELECT id, name, path, start_line AS startLine FROM symbols WHERE id=? OR name=? ORDER BY exported DESC LIMIT 1",
          params.fromSymbol,
          params.fromSymbol,
        )[0];
        const to = rows<Row>(
          db,
          "SELECT id, name, path, start_line AS startLine FROM symbols WHERE id=? OR name=? ORDER BY exported DESC LIMIT 1",
          params.toSymbol,
          params.toSymbol,
        )[0];
        if (!from || !to) return { found: false, path: [], partial: hasPartialCoverage(db) };
        const queue = [String(from.id)];
        const previous = new Map<string, { id: string; relation: string }>();
        const visited = new Set(queue);
        let partial = hasPartialCoverage(db);
        for (let cursor = 0; cursor < queue.length && !visited.has(String(to.id)); cursor += 1) {
          const current = queue[cursor]!;
          const outgoing = rows<Row>(
            db,
            "SELECT target_id AS targetId, relation FROM edges WHERE source_id = ? LIMIT 501",
            current,
          );
          if (outgoing.length > 500) partial = true;
          for (const edge of outgoing.slice(0, 500)) {
            const target = String(edge.targetId);
            if (visited.has(target)) continue;
            if (visited.size >= 2000) {
              partial = true;
              break;
            }
            visited.add(target);
            previous.set(target, { id: current, relation: String(edge.relation) });
            queue.push(target);
          }
          if (visited.size >= 2000) break;
        }
        if (!visited.has(String(to.id))) return { found: false, path: [], partial };
        const reversed: Array<{ id: string; relation: string }> = [
          { id: String(to.id), relation: "target" },
        ];
        let cursor = String(to.id);
        while (cursor !== String(from.id)) {
          const item = previous.get(cursor);
          if (!item) break;
          reversed.push({ id: item.id, relation: item.relation });
          cursor = item.id;
        }
        const ordered = reversed.reverse();
        const symbolRows = rows<Row>(
          db,
          `SELECT id, name, path, start_line AS startLine FROM symbols WHERE id IN (${ordered.map(() => "?").join(",")})`,
          ...ordered.map((item) => item.id),
        );
        const symbolById = new Map(symbolRows.map((symbol) => [String(symbol.id), symbol]));
        const path = ordered.flatMap((item) => {
          const symbol = symbolById.get(item.id);
          if (!symbol) return [];
          return {
            name: String(symbol.name),
            path: String(symbol.path),
            startLine: Number(symbol.startLine),
            relation: item.relation,
          };
        });
        return { found: true, path, partial };
      });
    },
    async setEmbeddingConfig(params) {
      return withDb(params, (db) => {
        const hasExplicitClear = params.endpoint === null || params.model === null;
        const previousConfig = getEmbeddingConfig(db);
        const nextEndpoint = hasExplicitClear
          ? undefined
          : params.endpoint === undefined
            ? previousConfig.endpoint
            : params.endpoint;
        const nextModel = hasExplicitClear
          ? undefined
          : params.model === undefined
            ? previousConfig.model
            : params.model;
        if (!hasExplicitClear && (!nextEndpoint?.trim() || !nextModel?.trim())) {
          throw new Error(
            "Both local embedding endpoint and model are required. Use null to clear the configuration.",
          );
        }
        const config = hasExplicitClear ? {} : validateEmbeddingConfig(nextEndpoint, nextModel);
        const previousModel = previousConfig.model;
        db.exec("BEGIN IMMEDIATE");
        try {
          if (config.endpoint && config.model) {
            writeText(db, "embedding_endpoint", config.endpoint);
            writeText(db, "embedding_model", config.model);
          } else {
            db.prepare(
              "DELETE FROM index_meta WHERE key IN ('embedding_endpoint','embedding_model','vectors_model')",
            ).run();
            db.prepare("UPDATE chunks SET embedding = NULL, embedding_model = NULL").run();
          }
          if (config.model && previousModel !== config.model) {
            db.prepare("UPDATE chunks SET embedding = NULL, embedding_model = NULL").run();
            writeText(db, "vectors_model", "");
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return statusFromDb(db);
      });
    },
    async clearIndex(params) {
      const workspace = resolveWorkspace(params);
      const active = activeIndexes.get(workspace.key);
      if (active) await active.catch(() => undefined);
      await rm(workspace.databasePath, { force: true });
      await rm(`${workspace.databasePath}-wal`, { force: true });
      await rm(`${workspace.databasePath}-shm`, { force: true });
      diagnosticsByIdentity.delete(workspace.key);
      progressByIdentity.delete(workspace.key);
    },
  };
  return service;
}
