import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFile } from "../ast/parseFile.js";
import { isInsideWorkspace, looksLikeSecretContent, scanWorkspaceFiles } from "./workspaceScan.js";
import { pathTierOf } from "../ast/languageRegistry.js";
import {
  clearUnresolved,
  fileIdsOf,
  filePathById,
  fileTiers,
  findFileId,
  resolveEdges,
  writeFileFacts,
  deleteFileFacts,
} from "./indexWriter.js";
import { computeFilePageRank, computeSymbolCentrality } from "./graphRank.js";
import {
  embedChunkContents,
  providerPlanOf,
  ProviderEmbeddingError,
  type ProviderChunkVector,
} from "./providerVectors.js";
import {
  compactDatabase,
  countOf,
  firstRow,
  readMeta,
  writeMeta,
  type IndexDatabase,
  type OpenOutcome,
  type Row,
} from "./store.js";
import { SCHEMA_VERSION } from "./storeSchema.js";
import { textOf } from "./chunkContent.js";
import { invalidateFtsCache } from "../ranking/searchChannels.js";

/**
 * Движок индексации: скан → разбор → запись батчами → резолв рёбер → PageRank.
 *
 * Всё это исполняется в `node:worker_threads`, поэтому Event Loop Local Host не блокируется.
 * Запись идёт батчами по `BATCH_FILES` файлов в одной транзакции: так WAL не разрастается
 * до размера всего индекса, а прерывание по отмене оставляет консистентный префикс.
 */

const BATCH_FILES = 80;

export interface IndexProgressInfo {
  state: "idle" | "indexing" | "ready" | "error";
  discoveredFiles: number;
  indexedFiles: number;
  phase?: "scan" | "parse" | "write" | "done";
}

export interface IndexRunOptions {
  workspacePath: string;
  db: IndexDatabase;
  force?: boolean;
  /** Секрет провайдера на время прохода; никогда не пишется в БД. */
  embeddingApiKey?: string;
  embeddingFetch?: typeof fetch;
  /** Возвращает `true`, если работу нужно прекратить (отмена/остановка воркера). */
  isCancelled: () => boolean;
  onProgress: (progress: IndexProgressInfo) => void;
}

export interface IndexRunResult {
  generation: number;
  files: number;
  chunks: number;
  symbols: number;
  edges: number;
  indexedFiles: number;
  skipped: number;
  /** Число файлов, для которых AST-грамматика была недоступна и использован текстовый чанкер. */
  textFallbackFiles: number;
  /** Фаза эмбеддингов по итогам прохода: `ready` только при реально построенных векторах. */
  embeddingFailure?: { code: string; httpStatus?: number };
  truncated: boolean;
  cancelled: boolean;
  durationMs: number;
  diagnostics: string[];
}

interface ExistingFileRow extends Row {
  file_id: number;
  rel_path: string;
  mtime_ms: number;
  size_bytes: number;
}

function existingFiles(db: IndexDatabase): Map<string, ExistingFileRow> {
  const rows = db
    .prepare("SELECT file_id, rel_path, mtime_ms, size_bytes FROM files ORDER BY file_id")
    .all() as ExistingFileRow[];
  return new Map(rows.map((row) => [String(row.rel_path), row]));
}

/** Пересчёт глобального PageRank и центральности символов после изменения графа. */
export function recomputeGraphRanking(db: IndexDatabase): void {
  const fileIds = fileIdsOf(db);
  const tiers = fileTiers(db);
  const edgeRows = db
    .prepare(
      `SELECT sf.rel_path AS fromPath, df.rel_path AS toPath, COUNT(*) AS weight
       FROM edges e
       JOIN files sf ON sf.file_id = e.src_file_id
       JOIN files df ON df.file_id = (SELECT file_id FROM symbols WHERE symbol_id = e.dst_symbol_id)
       GROUP BY fromPath, toPath`,
    )
    .all() as Array<{ fromPath: string; toPath: string; weight: number }>;
  const pathToId = new Map(filePathById(db));
  const idByPath = new Map<string, number>();
  for (const [id, path] of pathToId) idByPath.set(path, id);
  const rankEdges = edgeRows.flatMap((row) => {
    const from = idByPath.get(String(row.fromPath));
    const to = idByPath.get(String(row.toPath));
    return from !== undefined && to !== undefined ? [{ from, to, weight: Number(row.weight) }] : [];
  });
  const { ranks } = computeFilePageRank(fileIds, rankEdges, tiers);
  const updateFile = db.prepare("UPDATE files SET pagerank = ? WHERE file_id = ?");
  for (const [fileId, rank] of ranks) updateFile.run(rank, fileId);

  const symbolRows = db
    .prepare("SELECT symbol_id AS symbolId, file_id AS fileId FROM symbols")
    .all() as Array<{ symbolId: number; fileId: number }>;
  const tierByFile = tiers;
  const symbolEdges = (
    db
      .prepare(
        `SELECT e.src_symbol_id AS src, e.dst_symbol_id AS dst, e.src_file_id AS srcFile
         FROM edges e`,
      )
      .all() as Array<{ src: number; dst: number; srcFile: number }>
  ).map((row) => ({
    src: Number(row.src),
    dst: Number(row.dst),
    testSource: (tierByFile.get(Number(row.srcFile)) ?? 0) >= 2,
  }));
  const centrality = computeSymbolCentrality(
    symbolRows.map((row) => ({ symbolId: Number(row.symbolId) })),
    symbolEdges,
  );
  const updateSymbol = db.prepare("UPDATE symbols SET centrality = ? WHERE symbol_id = ?");
  for (const [symbolId, value] of centrality) updateSymbol.run(value, symbolId);
}

interface IndexContext {
  workspacePath: string;
  db: IndexDatabase;
  /** Секрет провайдера на время прохода: приходит из запроса и не сохраняется. */
  embeddingApiKey: string | undefined;
  embeddingFetch: typeof fetch | undefined;
  /** Сбой провайдера в текущем проходе: фиксируется один раз и не прерывает индексацию. */
  providerFailure: ProviderEmbeddingError | undefined;
  isCancelled: () => boolean;
  onProgress: (progress: IndexProgressInfo) => void;
  startTime: number;
}

interface FileTask {
  relPath: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
  pathTier: number;
}

async function processBatch(
  context: IndexContext,
  batch: readonly FileTask[],
  plan: ReturnType<typeof providerPlanOf>,
): Promise<{ written: number; textFallback: number; secretFiles: number }> {
  const { db } = context;
  let written = 0;
  let textFallback = 0;
  let secretFiles = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const task of batch) {
      if (context.isCancelled()) break;
      let content: string;
      try {
        content = await readFile(task.absolutePath, "utf8");
      } catch {
        continue;
      }
      // Живой секрет в содержимом не индексируется: индекс не должен хранить креденшелы.
      if (looksLikeSecretContent(content, task.pathTier)) {
        secretFiles += 1;
        continue;
      }
      const parsed = await parseFile(task.relPath, content);
      if (!parsed.usedTreeSitter) textFallback += 1;
      // Сбой провайдера не отменяет проход: локальный скетч и FTS остаются рабочими,
      // а категория ошибки сохраняется, чтобы статус честно показывал `failed`.
      let vectors: readonly ProviderChunkVector[] | undefined;
      if (plan && parsed.chunks.length > 0) {
        try {
          vectors = await embedChunkContents(
            plan,
            parsed.chunks.map((chunk) => chunk.content),
          );
        } catch (error) {
          if (error instanceof ProviderEmbeddingError && !context.providerFailure) {
            context.providerFailure = error;
          }
          vectors = undefined;
        }
      }
      writeFileFacts(db, {
        relPath: task.relPath,
        content,
        mtimeMs: task.mtimeMs,
        size: task.size,
        pathTier: task.pathTier,
        parsed,
        ...(vectors && plan ? { providerVectors: vectors, providerIdentity: plan.identity } : {}),
      });
      written += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { written, textFallback, secretFiles };
}

export async function runFullIndex(options: IndexRunOptions): Promise<IndexRunResult> {
  const context: IndexContext = {
    workspacePath: options.workspacePath,
    db: options.db,
    embeddingApiKey: options.embeddingApiKey,
    embeddingFetch: options.embeddingFetch,
    providerFailure: undefined,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
    startTime: Date.now(),
  };
  const { db } = context;
  const diagnostics: string[] = [];

  options.onProgress({
    state: "indexing",
    discoveredFiles: 0,
    indexedFiles: 0,
    phase: "scan",
  });
  const scan = await scanWorkspaceFiles(options.workspacePath);
  if (scan.truncated) diagnostics.push("Indexing stopped at the file safety limit.");
  if (scan.skippedLarge > 0)
    diagnostics.push("Some source files exceeded the 1 MiB indexing limit and were skipped.");
  if (scan.skippedSecret > 0)
    diagnostics.push("A source file matching secret patterns was excluded from the index.");

  const previous = existingFiles(db);
  // План провайдера читается один раз: настройки не меняются внутри прохода.
  const plan = providerPlanOf(db, context.embeddingApiKey, context.embeddingFetch);
  const vectorCoverage = plan ? providerVectorFiles(db, plan.identity) : undefined;
  const tasks: FileTask[] = [];
  for (const file of scan.files) {
    const prior = previous.get(file.relPath);
    const sourceUnchanged =
      !options.force && prior && prior.mtime_ms === file.mtimeMs && prior.size_bytes === file.size;
    // Файл без векторов текущего провайдера обязан быть переиндексирован: иначе настройка
    // провайдера после первой индексации никогда не наполнит векторный канал.
    const vectorsMissing =
      plan !== null && prior !== undefined && !vectorCoverage?.has(prior.file_id);
    if (sourceUnchanged && !vectorsMissing) continue;
    tasks.push(file);
  }

  // Файлы, которых больше нет на диске, удаляются из индекса.
  const presentPaths = new Set(scan.files.map((file) => file.relPath));
  const removed: string[] = [];
  for (const relPath of previous.keys()) {
    if (!presentPaths.has(relPath)) removed.push(relPath);
  }
  if (removed.length > 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const relPath of removed) {
        const fileId = findFileId(db, relPath);
        if (fileId !== undefined) deleteFileFacts(db, fileId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Причина: `deleteFileFacts` освобождает страницы, но файл БД не уменьшается без
    // `incremental_vacuum`. Вызов стоит вне транзакции удаления, потому что PRAGMA
    // не работает внутри открытой транзакции.
    compactDatabase(db);
  }

  options.onProgress({
    state: "indexing",
    discoveredFiles: scan.files.length,
    indexedFiles: 0,
    phase: "parse",
  });

  let indexedFiles = 0;
  let textFallbackFiles = 0;
  // Счётчик файлов, исключённых по контентному признаку секрета: значение попадает
  // в диагностику и `index_partial`, чтобы неполнота индекса была видна.
  let secretFileCount = 0;
  let cancelled = false;
  for (let offset = 0; offset < tasks.length; offset += BATCH_FILES) {
    if (options.isCancelled()) {
      cancelled = true;
      break;
    }
    const batch = tasks.slice(offset, offset + BATCH_FILES);
    const outcome = await processBatch(context, batch, plan);
    indexedFiles += outcome.written;
    textFallbackFiles += outcome.textFallback;
    secretFileCount += outcome.secretFiles;
    options.onProgress({
      state: "indexing",
      discoveredFiles: scan.files.length,
      indexedFiles,
      phase: "write",
    });
    // Явный yield между транзакциями: воркер не должен держать CPU-квант непрерывно.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  options.onProgress({
    state: "indexing",
    discoveredFiles: scan.files.length,
    indexedFiles,
    phase: "write",
  });
  clearUnresolvedForChanged(db);
  resolveEdges(db, importEdgeInputs(db));
  recomputeGraphRanking(db);

  const generation = Number(readMeta(db, "generation") ?? 0) + 1;
  writeMeta(db, "generation", String(generation));
  // Кэш FTS ключуется по generation: без сброса он вернул бы результаты по прежнему индексу.
  invalidateFtsCache();
  writeMeta(db, "index_state", cancelled ? "degraded" : "ready");
  writeMeta(db, "schema_version", String(SCHEMA_VERSION));
  writeMeta(db, "updated_at", String(Date.now()));
  if (secretFileCount > 0) {
    diagnostics.push("A source file matching secret patterns was excluded from the index.");
  }
  writeEmbeddingPhase(db, plan ? context.providerFailure : undefined);
  writeMeta(db, "index_partial", String(scan.truncated || diagnostics.length > 0));
  writeMeta(db, "diagnostics", JSON.stringify(diagnostics.slice(0, 12)));
  writeMeta(db, "last_index_duration_ms", String(Date.now() - context.startTime));

  options.onProgress({
    state: cancelled ? "idle" : "ready",
    discoveredFiles: scan.files.length,
    indexedFiles,
    phase: "done",
  });

  return {
    generation,
    files: countOf(db, "files"),
    chunks: countOf(db, "chunks"),
    symbols: countOf(db, "symbols"),
    edges: countOf(db, "edges"),
    indexedFiles,
    skipped: scan.skippedLarge + scan.skippedSecret,
    textFallbackFiles,
    ...(context.providerFailure
      ? {
          embeddingFailure: {
            code: context.providerFailure.code,
            ...(context.providerFailure.httpStatus !== undefined
              ? { httpStatus: context.providerFailure.httpStatus }
              : {}),
          },
        }
      : {}),
    truncated: scan.truncated,
    cancelled,
    durationMs: Date.now() - context.startTime,
    diagnostics,
  };
}

/**
 * После полного прохода `unresolved_refs` содержит только актуальные ссылки: записи
 * перезаписанных файлов удалены вместе с файлом. Оставляем вызов явным, чтобы правило
 * «резолв всегда строится из текущего набора» было видно в коде, а не подразумевалось.
 */
/**
 * Файлы, у которых все чанки уже имеют проекцию вектора текущего провайдера.
 * Нужен, чтобы повторный проход не пересчитывал эмбеддинги для неизменённых файлов,
 * но и не пропускал файлы, оставшиеся без векторов после смены провайдера.
 */
function providerVectorFiles(db: IndexDatabase, identity: string): Set<number> {
  const rows = db
    .prepare(
      `SELECT c.file_id AS fileId, COUNT(*) AS total,
              SUM(CASE WHEN v.provider_identity = ? AND v.provider_sketch_q4 IS NOT NULL THEN 1 ELSE 0 END) AS covered
       FROM chunks c
       JOIN chunk_vectors v ON v.chunk_id = c.chunk_id
       GROUP BY c.file_id`,
    )
    .all(identity) as Array<{ fileId: number; total: number; covered: number }>;
  const covered = new Set<number>();
  for (const row of rows) {
    if (Number(row.total) > 0 && Number(row.covered) === Number(row.total)) {
      covered.add(Number(row.fileId));
    }
  }
  return covered;
}

/**
 * Вход для рёбер `imports`: импорты каждого файла восстанавливаются из
 * `unresolved_refs` нельзя (там только имена), поэтому они хранятся в `meta` как
 * сериализованный снимок на файл. Источник — AST-разбор, не повторный обход диска.
 */
function importEdgeInputs(db: IndexDatabase): Array<{
  specifier: string;
  names: readonly string[];
  srcFileId: number;
}> {
  const rows = db
    .prepare(
      "SELECT file_id AS fileId, import_blob AS payload FROM files WHERE import_blob IS NOT NULL",
    )
    .all() as Array<{ fileId: number; payload: string }>;
  const result: Array<{ specifier: string; names: readonly string[]; srcFileId: number }> = [];
  for (const row of rows) {
    try {
      // `import_blob` — deflate от JSON: распаковка на файл дешевле, чем 5.4 МБ текста на диске.
      const parsed: unknown = JSON.parse(textOf(row.payload));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const specifier = (item as { specifier?: unknown }).specifier;
        const names = (item as { names?: unknown }).names;
        if (typeof specifier !== "string" || !Array.isArray(names)) continue;
        result.push({
          specifier,
          names: names.filter((name): name is string => typeof name === "string"),
          srcFileId: Number(row.fileId),
        });
      }
    } catch {
      // Повреждённый снимок импортов не должен ломать резолв остальных файлов.
    }
  }
  return result;
}

function clearUnresolvedForChanged(_db: IndexDatabase): void {
  // Ничего не удаляем: `deleteFileFacts` уже почистил строки изменённых файлов.
}

/**
 * Фиксирует фазу эмбеддингов в `meta`.
 *
 * Правило: `failed` ставится только по реальной ошибке провайдера, а `ready` — только когда
 * провайдер сконфигурирован и проход завершился без ошибок. Отсутствие провайдера — не ошибка:
 * индекс полностью работоспособен на локальном скетче.
 */
function writeEmbeddingPhase(db: IndexDatabase, failure: ProviderEmbeddingError | undefined): void {
  if (failure) {
    writeMeta(db, "embedding_phase", "failed");
    writeMeta(db, "embedding_error_code", failure.code);
    if (failure.httpStatus !== undefined)
      writeMeta(db, "embedding_error_status", String(failure.httpStatus));
    else db.prepare("DELETE FROM meta WHERE key = 'embedding_error_status'").run();
    return;
  }
  db.prepare(
    "DELETE FROM meta WHERE key IN ('embedding_error_code','embedding_error_status')",
  ).run();
  writeMeta(db, "embedding_phase", readMeta(db, "embedding_endpoint") ? "ready" : "not-configured");
}

/**
 * Удаляет из индекса записи с тем же содержимым, которых больше нет на диске.
 *
 * Это устраняет последствие переименования, когда watcher не прислал `unlink` для старого
 * пути. Проверка ограничена одной записью по `content_sha256` и реальным `stat`, поэтому
 * не превращается в скан индекса.
 */
async function dropStaleDuplicates(
  db: IndexDatabase,
  workspacePath: string,
  relPath: string,
): Promise<void> {
  const row = firstRow<Row>(
    db,
    "SELECT file_id AS fileId, content_sha256 AS hash FROM files WHERE rel_path = ?",
    relPath,
  );
  if (!row || !(row.hash instanceof Uint8Array)) return;
  const duplicates = db
    .prepare(
      "SELECT file_id AS fileId, rel_path AS relPath FROM files WHERE content_sha256 = ? AND rel_path <> ?",
    )
    .all(row.hash, relPath) as Array<{ fileId: number; relPath: string }>;
  for (const duplicate of duplicates) {
    const stalePath = String(duplicate.relPath);
    const exists = await stat(join(workspacePath, stalePath)).then(
      () => true,
      () => false,
    );
    if (exists) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteFileFacts(db, Number(duplicate.fileId));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Частичное обновление набора путей (create/modify/delete) без полного скана. */
export interface PartialIndexOptions extends IndexRunOptions {
  changed: readonly string[];
  removed: readonly string[];
}

export async function runPartialIndex(options: PartialIndexOptions): Promise<IndexRunResult> {
  const context: IndexContext = {
    workspacePath: options.workspacePath,
    db: options.db,
    embeddingApiKey: options.embeddingApiKey,
    embeddingFetch: options.embeddingFetch,
    providerFailure: undefined,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
    startTime: Date.now(),
  };
  const { db } = context;
  const diagnostics: string[] = [];
  // План провайдера читается один раз: настройки не меняются внутри прохода.
  const plan = providerPlanOf(db, context.embeddingApiKey, context.embeddingFetch);
  const removed = options.removed.filter((path) => isInsideWorkspace(options.workspacePath, path));
  const changed = options.changed.filter((path) => isInsideWorkspace(options.workspacePath, path));

  options.onProgress({
    state: "indexing",
    discoveredFiles: changed.length + removed.length,
    indexedFiles: 0,
    phase: "parse",
  });

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const relPath of removed) {
      const fileId = findFileId(db, relPath);
      if (fileId === undefined) continue;
      deleteFileFacts(db, fileId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // Причина: частичный проход удаляет строки из FTS/векторов, но без `incremental_vacuum`
  // освобождённые страницы остаются в файле. PRAGMA выполняется вне транзакции.
  if (removed.length > 0) compactDatabase(db);

  let indexedFiles = 0;
  let textFallbackFiles = 0;
  let cancelled = false;
  for (const relPath of changed) {
    if (options.isCancelled()) {
      cancelled = true;
      break;
    }
    const absolutePath = join(options.workspacePath, relPath);
    let content: string;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      // Файл удалён между событием и чтением — считаем это удалением.
      const fileId = findFileId(db, relPath);
      if (fileId !== undefined) {
        db.exec("BEGIN IMMEDIATE");
        try {
          deleteFileFacts(db, fileId);
          db.exec("COMMIT");
        } catch {
          db.exec("ROLLBACK");
        }
      }
      continue;
    }
    const { stat } = await import("node:fs/promises");
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      continue;
    }
    if (info.size > 1024 * 1024) {
      diagnostics.push("A source file exceeded the 1 MiB indexing limit and was skipped.");
      continue;
    }
    if (looksLikeSecretContent(content, pathTierOf(relPath))) {
      diagnostics.push("A source file matching secret patterns was excluded from the index.");
      const existingId = findFileId(db, relPath);
      if (existingId !== undefined) {
        db.exec("BEGIN IMMEDIATE");
        try {
          deleteFileFacts(db, existingId);
          db.exec("COMMIT");
        } catch {
          db.exec("ROLLBACK");
        }
      }
      continue;
    }
    const parsed = await parseFile(relPath, content);
    if (!parsed.usedTreeSitter) textFallbackFiles += 1;
    // Сетевой вызов эмбеддингов выполняется до `BEGIN IMMEDIATE`, чтобы не держать блокировку.
    let vectors: readonly ProviderChunkVector[] | undefined;
    if (plan && parsed.chunks.length > 0) {
      try {
        vectors = await embedChunkContents(
          plan,
          parsed.chunks.map((chunk) => chunk.content),
        );
      } catch (error) {
        if (error instanceof ProviderEmbeddingError && !context.providerFailure) {
          context.providerFailure = error;
        }
        vectors = undefined;
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      writeFileFacts(db, {
        relPath,
        content,
        mtimeMs: Math.floor(info.mtimeMs),
        size: info.size,
        pathTier: 0,
        parsed,
        ...(vectors && plan ? { providerVectors: vectors, providerIdentity: plan.identity } : {}),
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    indexedFiles += 1;
    // Компенсация переименования: рекурсивный `fs.watch` не гарантирует `unlink` для старого
    // пути, поэтому прежняя запись оставалась «фантомом» (файл есть в индексе, но не на диске).
    // Поиск по хешу содержимого точечный: обычно находится 0–1 кандидат.
    await dropStaleDuplicates(db, options.workspacePath, relPath);
    options.onProgress({
      state: "indexing",
      discoveredFiles: changed.length,
      indexedFiles,
      phase: "write",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  resolveEdges(db, importEdgeInputs(db));
  recomputeGraphRanking(db);

  const generation = Number(readMeta(db, "generation") ?? 0) + 1;
  writeMeta(db, "generation", String(generation));
  invalidateFtsCache();
  writeMeta(db, "index_state", cancelled ? "degraded" : "ready");
  writeMeta(db, "updated_at", String(Date.now()));
  writeEmbeddingPhase(db, plan ? context.providerFailure : undefined);
  writeMeta(db, "index_partial", String(diagnostics.length > 0));
  if (diagnostics.length > 0)
    writeMeta(db, "diagnostics", JSON.stringify(diagnostics.slice(0, 12)));
  writeMeta(db, "last_index_duration_ms", String(Date.now() - context.startTime));

  options.onProgress({
    state: cancelled ? "idle" : "ready",
    discoveredFiles: changed.length,
    indexedFiles,
    phase: "done",
  });

  return {
    generation,
    files: countOf(db, "files"),
    chunks: countOf(db, "chunks"),
    symbols: countOf(db, "symbols"),
    edges: countOf(db, "edges"),
    indexedFiles,
    skipped: 0,
    textFallbackFiles,
    ...(context.providerFailure
      ? {
          embeddingFailure: {
            code: context.providerFailure.code,
            ...(context.providerFailure.httpStatus !== undefined
              ? { httpStatus: context.providerFailure.httpStatus }
              : {}),
          },
        }
      : {}),
    truncated: false,
    cancelled,
    durationMs: Date.now() - context.startTime,
    diagnostics,
  };
}

export { clearUnresolved, firstRow, SCHEMA_VERSION, type OpenOutcome };
