import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type {
  CodeImpactResult,
  CodeIndexStatus,
  CodeSymbolContext,
  CodeTraceResult,
  EmbeddingErrorCode,
  EmbeddingPhase,
  EmbeddingProvider,
} from "./contract.js";
import type { IndexedFileRecord } from "./scanner.js";

// Keep node:sqlite an external built-in. This matches the existing task-index storage boundary.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const MAX_SEARCH_LIMIT = 50;
export const MAX_EMBED_BATCH = 32;
export const MAX_DIAGNOSTICS = 12;
const INDEX_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL DEFAULT 0,
    size INTEGER NOT NULL, fingerprint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS symbols (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
    start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT NOT NULL,
    exported INTEGER NOT NULL, FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
  CREATE INDEX IF NOT EXISTS symbols_path_idx ON symbols(path);
  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
    content TEXT NOT NULL, embedding BLOB, embedding_model TEXT,
    FOREIGN KEY(path) REFERENCES files(path) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);
  CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL,
    source_path TEXT NOT NULL, target_path TEXT NOT NULL,
    PRIMARY KEY(source_id, target_id, relation),
    FOREIGN KEY(source_path) REFERENCES files(path) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id);
  CREATE INDEX IF NOT EXISTS edges_target_path_idx ON edges(target_path);
  CREATE TABLE IF NOT EXISTS imported_calls (
    source_id TEXT NOT NULL, source_path TEXT NOT NULL, imported_name TEXT NOT NULL,
    target_path TEXT NOT NULL,
    FOREIGN KEY(source_path) REFERENCES files(path) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS imported_calls_target_idx ON imported_calls(target_path, imported_name);
`;

export interface Row extends Record<string, unknown> {
  [key: string]: unknown;
}

export interface IndexProgress {
  discoveredFiles: number;
  indexedFiles: number;
  state: "indexing" | "degraded";
  diagnostics: string[];
  embeddingPhase?: EmbeddingPhase;
  embeddingCompleted?: number;
  embeddingTotal?: number;
}

interface EmbeddingConfig {
  provider?: EmbeddingProvider;
  endpoint?: string;
  model?: string;
  identity?: string;
  apiKeyConfigured?: boolean;
  /** Request-only secret loaded from ICredentialService; never returned by getEmbeddingConfig. */
  apiKey?: string;
}

function embeddingConfigIdentity(config: {
  provider: EmbeddingProvider;
  endpoint: string;
  model: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([config.provider, config.endpoint, config.model]))
    .digest("hex");
}

export function readText(db: CodeIndexDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as Row | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

export function writeText(db: CodeIndexDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

export function workspaceIdentity(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  const identity = params.workspaceIdentity?.trim() || params.workspacePath.trim();
  if (!identity) throw new Error("A workspace path or identity is required.");
  return identity;
}

export function safeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 12;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
}

export function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_$-]{2,}/gu) ?? [])].slice(0, 20);
}

export function lexicalScore(queryTerms: string[], value: string): number {
  const lower = value.toLowerCase();
  let matched = 0;
  for (const term of queryTerms) if (lower.includes(term)) matched += 1;
  return matched / Math.max(queryTerms.length, 1);
}

export function safeExcerpt(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").slice(0, 360);
}

export function readEmbedding(blob: unknown): number[] | undefined {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < blob.byteLength; offset += 4)
    values.push(view.getFloat32(offset, true));
  return values.every(Number.isFinite) ? values : undefined;
}

export function writeEmbedding(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function validateEmbeddingConfig(
  providerValue: EmbeddingProvider | null | undefined,
  endpointValue?: string | null,
  modelValue?: string | null,
): EmbeddingConfig {
  const provider = providerValue ?? "ollama";
  const endpoint = endpointValue?.trim();
  const model = modelValue?.trim();
  if (!endpoint && !model) return {};
  if (!endpoint || !model) throw new Error("Both embedding endpoint and model are required.");
  if (provider !== "ollama" && provider !== "openai-compatible")
    throw new Error("Unsupported embedding provider.");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Embedding endpoint must be a valid URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (isIP(hostname.replace(/^\[|\]$/g, "")) === 4 && hostname.startsWith("127."));
  const protocolAllowed =
    provider === "ollama"
      ? parsed.protocol === "http:" && loopback
      : parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback);
  if (
    !protocolAllowed ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    endpoint.length > 2048 ||
    !/^[\p{L}\p{N}._:/-]{1,120}$/u.test(model)
  ) {
    throw new Error(
      "Embedding configuration must use an allowed credential-free endpoint and a valid model name.",
    );
  }
  const normalizedEndpoint = parsed.toString().replace(/\/$/, "");
  return {
    provider,
    endpoint: normalizedEndpoint,
    model,
    identity: embeddingConfigIdentity({
      provider,
      endpoint: normalizedEndpoint,
      model,
    }),
  };
}

export function databaseFileFor(indexRootDir: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return join(indexRootDir, `${digest}.sqlite3`);
}

export function openDatabase(filePath: string): CodeIndexDatabase {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(INDEX_SCHEMA);
  const fileColumns = db.prepare("PRAGMA table_info(files)").all() as Row[];
  if (!fileColumns.some((column) => column.name === "ctime_ms")) {
    db.exec("ALTER TABLE files ADD COLUMN ctime_ms REAL NOT NULL DEFAULT 0");
  }
  return db;
}

function count(db: CodeIndexDatabase, table: "files" | "chunks" | "symbols" | "edges"): number {
  const row = db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as Row;
  return Number(row.value ?? 0);
}

export function getCounts(db: CodeIndexDatabase): CodeIndexStatus["counts"] {
  return {
    files: count(db, "files"),
    chunks: count(db, "chunks"),
    symbols: count(db, "symbols"),
    edges: count(db, "edges"),
  };
}

export function getEmbeddingConfig(db: CodeIndexDatabase): EmbeddingConfig {
  const endpoint = readText(db, "embedding_endpoint");
  const model = readText(db, "embedding_model");
  if (!endpoint || !model) return {};
  // Older local settings predate the provider field and were Ollama endpoints.
  const provider: EmbeddingProvider =
    readText(db, "embedding_provider") === "openai-compatible" ? "openai-compatible" : "ollama";
  return {
    provider,
    endpoint,
    model,
    identity: embeddingConfigIdentity({ provider, endpoint, model }),
    apiKeyConfigured: readText(db, "embedding_api_key_configured") === "true",
  };
}

export function hasPartialCoverage(db: CodeIndexDatabase): boolean {
  return readText(db, "index_partial") === "true" || readText(db, "index_state") === "degraded";
}

export function readImpact(db: CodeIndexDatabase, changedPaths: string[]): CodeImpactResult {
  const normalized = [
    ...new Set(
      changedPaths.map((path) =>
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
  return { changedPaths: normalized, affectedSymbols: affectedSymbols.slice(0, 100), partial };
}

export function readSymbolContext(
  db: CodeIndexDatabase,
  symbolName: string,
): CodeSymbolContext | null {
  const symbol = rows<Row>(
    db,
    "SELECT id, name, kind, path, start_line AS startLine, end_line AS endLine FROM symbols WHERE id = ? OR name = ? ORDER BY exported DESC, start_line LIMIT 1",
    symbolName,
    symbolName,
  )[0];
  if (!symbol) return null;
  // 结构 contains 边只连接文件与声明，不能把模块误报成真实调用者或依赖。
  const outgoing = rows<Row>(
    db,
    "SELECT e.target_id AS id, e.relation, s.name, s.path, s.start_line AS startLine FROM edges e LEFT JOIN symbols s ON s.id=e.target_id WHERE e.source_id = ? AND e.relation <> 'contains' LIMIT 101",
    String(symbol.id),
  );
  const incoming = rows<Row>(
    db,
    "SELECT e.source_id AS id, e.relation, s.name, s.path, s.start_line AS startLine FROM edges e LEFT JOIN symbols s ON s.id=e.source_id WHERE e.target_id = ? AND e.relation <> 'contains' LIMIT 101",
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
}

export function readTrace(
  db: CodeIndexDatabase,
  fromSymbol: string,
  toSymbol: string,
): CodeTraceResult {
  const from = rows<Row>(
    db,
    "SELECT id FROM symbols WHERE id=? OR name=? ORDER BY exported DESC LIMIT 1",
    fromSymbol,
    fromSymbol,
  )[0];
  const to = rows<Row>(
    db,
    "SELECT id FROM symbols WHERE id=? OR name=? ORDER BY exported DESC LIMIT 1",
    toSymbol,
    toSymbol,
  )[0];
  if (!from || !to) return { found: false, path: [], partial: hasPartialCoverage(db) };
  const queue = [String(from.id)];
  const previous = new Map<string, { id: string; relation: string }>();
  const visited = new Set(queue);
  let partial = hasPartialCoverage(db);
  for (let cursor = 0; cursor < queue.length && !visited.has(String(to.id)); cursor += 1) {
    const outgoing = rows<Row>(
      db,
      "SELECT target_id AS targetId, relation FROM edges WHERE source_id = ? LIMIT 501",
      queue[cursor]!,
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
      previous.set(target, { id: queue[cursor]!, relation: String(edge.relation) });
      queue.push(target);
    }
    if (visited.size >= 2000) break;
  }
  if (!visited.has(String(to.id))) return { found: false, path: [], partial };
  const reversed = [{ id: String(to.id), relation: "target" }];
  let cursor = String(to.id);
  while (cursor !== String(from.id)) {
    const item = previous.get(cursor);
    if (!item) break;
    reversed.push(item);
    cursor = item.id;
  }
  const ordered = reversed.reverse();
  const symbols = rows<Row>(
    db,
    `SELECT id, name, path, start_line AS startLine FROM symbols WHERE id IN (${ordered.map(() => "?").join(",")})`,
    ...ordered.map((item) => item.id),
  );
  const byId = new Map(symbols.map((symbol) => [String(symbol.id), symbol]));
  const path = ordered.flatMap((item) => {
    const symbol = byId.get(item.id);
    return symbol
      ? [
          {
            name: String(symbol.name),
            path: String(symbol.path),
            startLine: Number(symbol.startLine),
            relation: item.relation,
          },
        ]
      : [];
  });
  return { found: true, path, partial };
}

export function statusFromDb(db: CodeIndexDatabase, progress?: IndexProgress): CodeIndexStatus {
  let diagnostics: string[] = [];
  try {
    const raw = readText(db, "diagnostics");
    if (raw) diagnostics = JSON.parse(raw) as string[];
  } catch {
    diagnostics = ["Stored index diagnostics could not be read."];
  }
  const config = getEmbeddingConfig(db);
  const storedModel = readText(db, "vectors_model");
  const storedState = readText(db, "index_state");
  const configured = Boolean(config.endpoint && config.model);
  const available = Boolean(config.identity && storedModel === config.identity);
  const storedEmbeddingPhase = readText(db, "embedding_phase");
  const embeddingPhase: EmbeddingPhase = !configured
    ? "not-configured"
    : (progress?.embeddingPhase ??
      (available ? "ready" : storedEmbeddingPhase === "failed" ? "failed" : "pending"));
  const storedEmbeddingErrorCode = readText(db, "embedding_error_code");
  const embeddingErrorCodes: readonly EmbeddingErrorCode[] = [
    "request-failed",
    "timeout",
    "invalid-response",
    "authentication",
    "not-found",
    "rate-limited",
    "provider-error",
  ];
  const storedEmbeddingHttpStatus = Number(readText(db, "embedding_http_status"));
  const lastEmbeddingError = embeddingErrorCodes.includes(
    storedEmbeddingErrorCode as EmbeddingErrorCode,
  )
    ? {
        code: storedEmbeddingErrorCode as EmbeddingErrorCode,
        ...(Number.isInteger(storedEmbeddingHttpStatus) &&
        storedEmbeddingHttpStatus >= 100 &&
        storedEmbeddingHttpStatus <= 599
          ? { httpStatus: storedEmbeddingHttpStatus }
          : {}),
      }
    : undefined;
  const state =
    progress?.state ??
    (storedState === "degraded" ? "degraded" : readText(db, "generation") ? "ready" : "unindexed");
  return {
    state,
    partial: hasPartialCoverage(db),
    generation: Number(readText(db, "generation") ?? 0),
    ...(readText(db, "updated_at") ? { updatedAt: Number(readText(db, "updated_at")) } : {}),
    counts: getCounts(db),
    ...(progress?.state === "indexing"
      ? {
          progress: {
            discoveredFiles: progress.discoveredFiles,
            indexedFiles: progress.indexedFiles,
            ...(progress.embeddingPhase === "building"
              ? {
                  embedding: {
                    completed: progress.embeddingCompleted ?? 0,
                    total: progress.embeddingTotal ?? 0,
                  },
                }
              : {}),
          },
        }
      : {}),
    embedding: {
      configured,
      ...(config.provider ? { provider: config.provider } : {}),
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.apiKeyConfigured !== undefined
        ? { apiKeyConfigured: config.apiKeyConfigured }
        : {}),
      available,
      phase: embeddingPhase,
      ...(embeddingPhase === "failed" && lastEmbeddingError
        ? { lastError: lastEmbeddingError }
        : {}),
    },
    diagnostics: [...diagnostics, ...(progress?.diagnostics ?? [])].slice(0, MAX_DIAGNOSTICS),
  };
}

export function rows<T extends Row>(
  db: CodeIndexDatabase,
  sql: string,
  ...parameters: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...parameters) as T[];
}

export function insertFileSymbols(db: CodeIndexDatabase, file: IndexedFileRecord): void {
  const addSymbol = db.prepare(
    "INSERT INTO symbols(id, name, kind, path, start_line, end_line, signature, exported) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const symbol of file.symbols)
    addSymbol.run(
      symbol.id,
      symbol.name,
      symbol.kind,
      symbol.path,
      symbol.startLine,
      symbol.endLine,
      symbol.signature,
      symbol.exported,
    );
}

export function syncGraphFacts(
  db: CodeIndexDatabase,
  records: IndexedFileRecord[],
  unchangedRecords: IndexedFileRecord[],
  filePaths: Set<string>,
): void {
  for (const file of unchangedRecords) insertFileSymbols(db, file);

  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges(source_id, target_id, relation, source_path, target_path) VALUES(?, ?, ?, ?, ?)",
  );
  const insertImportedCall = db.prepare(
    "INSERT INTO imported_calls(source_id, source_path, imported_name, target_path) VALUES(?, ?, ?, ?)",
  );
  for (const record of records) {
    for (const edge of record.edges) {
      if (!filePaths.has(edge.targetPath)) continue;
      insertEdge.run(edge.sourceId, edge.targetId, edge.relation, edge.sourcePath, edge.targetPath);
    }
    for (const call of record.importedCalls ?? []) {
      if (!filePaths.has(call.targetPath)) continue;
      insertImportedCall.run(call.sourceId, call.sourcePath, call.importedName, call.targetPath);
    }
  }
}

export function upsertFileRecord(db: CodeIndexDatabase, file: IndexedFileRecord): void {
  db.prepare(
    "INSERT INTO files(path, mtime_ms, ctime_ms, size, fingerprint) VALUES(?, ?, ?, ?, ?)",
  ).run(file.path, file.mtimeMs, file.ctimeMs, file.size, file.fingerprint);
  insertFileSymbols(db, file);
  const addChunk = db.prepare(
    "INSERT INTO chunks(id, path, start_line, end_line, content, embedding, embedding_model) VALUES(?, ?, ?, ?, ?, ?, ?)",
  );
  for (const chunk of file.chunks)
    addChunk.run(
      chunk.id,
      chunk.path,
      chunk.startLine,
      chunk.endLine,
      chunk.content,
      chunk.embedding ?? null,
      chunk.embeddingModel ?? null,
    );
  const addEdge = db.prepare(
    "INSERT OR IGNORE INTO edges(source_id, target_id, relation, source_path, target_path) VALUES(?, ?, ?, ?, ?)",
  );
  for (const edge of file.edges)
    addEdge.run(edge.sourceId, edge.targetId, edge.relation, edge.sourcePath, edge.targetPath);
}

export class EmbeddingHttpError extends Error {
  constructor(readonly status: number) {
    super(`Embedding endpoint returned HTTP ${status}.`);
    this.name = "EmbeddingHttpError";
  }
}

function embeddingHttpErrorCode(status: number): EmbeddingErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "provider-error";
}

export function embeddingFailureFromError(error: unknown): {
  code: EmbeddingErrorCode;
  httpStatus?: number;
} {
  if (error instanceof EmbeddingHttpError) {
    return {
      code: embeddingHttpErrorCode(error.status),
      httpStatus: error.status,
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (/invalid vector|invalid.*batch|vector order/i.test(message))
    return { code: "invalid-response" };
  if (/timeout|timed out|abort/i.test(message)) return { code: "timeout" };
  return { code: "request-failed" };
}

function retryDelayMs(response: Response, retryIndex: number): number | null {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (Number.isFinite(parsed)) return parsed <= 30_000 ? parsed : null;
  }
  return Math.min(500 * 2 ** retryIndex, 2_000);
}

export async function requestEmbeddings(
  config: EmbeddingConfig,
  input: string[],
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  if (!config.endpoint || !config.model || input.length === 0) return [];
  const vectors: number[][] = [];
  for (let offset = 0; offset < input.length; offset += MAX_EMBED_BATCH) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          input: input.slice(offset, offset + MAX_EMBED_BATCH),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) break;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw new EmbeddingHttpError(response.status);
      const delayMs = retryDelayMs(response, attempt);
      if (delayMs === null) throw new EmbeddingHttpError(response.status);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response?.ok) throw new EmbeddingHttpError(response?.status ?? 0);
    const payload: unknown = await response.json();
    const expectedCount = Math.min(MAX_EMBED_BATCH, input.length - offset);
    let embeddings: unknown;
    if (config.provider === "openai-compatible") {
      const data =
        payload && typeof payload === "object" && "data" in payload
          ? (payload as { data?: unknown }).data
          : undefined;
      if (!Array.isArray(data) || data.length !== expectedCount) {
        throw new Error("OpenAI-compatible embedding endpoint returned an invalid vector batch.");
      }
      const ordered: unknown[] = Array(expectedCount);
      for (const item of data) {
        if (!item || typeof item !== "object" || !("index" in item) || !("embedding" in item))
          throw new Error("OpenAI-compatible embedding endpoint returned an invalid vector.");
        const index = (item as { index?: unknown }).index;
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= expectedCount ||
          ordered[index] !== undefined
        ) {
          throw new Error("OpenAI-compatible embedding endpoint returned invalid vector order.");
        }
        ordered[index] = (item as { embedding: unknown }).embedding;
      }
      embeddings = ordered;
    } else {
      embeddings =
        payload && typeof payload === "object" && "embeddings" in payload
          ? (payload as { embeddings?: unknown }).embeddings
          : undefined;
    }
    if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
      throw new Error("Embedding endpoint returned an invalid vector batch.");
    }
    for (const embedding of embeddings) {
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw new Error("Embedding endpoint returned an invalid vector.");
      }
      vectors.push(embedding as number[]);
    }
  }
  return vectors;
}

export type CodeIndexDatabase = InstanceType<typeof DatabaseSync>;
