import { createHash } from "node:crypto";
import { EDGE_RELATION, SYMBOL_KIND } from "../ast/languageRules.js";
import { ftsDocumentOf, searchTokensOf } from "../ast/tokenizer.js";
import { quantizeSketchQ4, signedInt8Of, sketchOfText } from "../ranking/localSketch.js";
import type { ParsedFile } from "../ast/types.js";
import type { IndexDatabase } from "./store.js";
import type { ProviderChunkVector } from "./providerVectors.js";
import { packFileChunks, packText } from "./chunkContent.js";
import { StringInterner } from "./stringInterner.js";
import { FTS_CONTENT_TOKENS, FTS_SYMBOL_TOKENS } from "./storeSchema.js";

/**
 * Запись структурных фактов одного файла в схему v3.
 *
 * Ключевые решения (замеры — в шапке `storeSchema.ts`):
 *  - INTEGER PK/FK вместо текстовых ключей `s:<path>:<line>:<kind>:<name>`;
 *  - текст всех чанков файла — один deflate-поток в `files.chunk_blob`, а `chunks.chunk_index`
 *    задаёт позицию в восстановленном JSON-массиве (70.45 → 41.62 МБ по корпусу);
 *  - заголовки областей видимости, имена и спецификаторы ссылок интернируются в `strings`;
 *  - FTS внешне-контентная, два столбца; `detail=full` обязателен для bm25 (см. схему);
 *  - скетч хранится в 4-битном виде с масштабом на вектор;
 *  - нерезолвленные ссылки агрегируются по `(src_symbol_id, name_id, spec_id, relation)`,
 *    чтобы резолв рёбер оставался инкрементальным `O(Δ_files)` без дублей строк.
 */

export interface WriteFileInput {
  relPath: string;
  content: string;
  mtimeMs: number;
  size: number;
  pathTier: number;
  parsed: ParsedFile;
  /** Векторы провайдера по порядку чанков; `undefined` — провайдер не сконфигурирован. */
  providerVectors?: readonly ProviderChunkVector[];
  /** Идентичность конфигурации провайдера: пишется рядом с векторами. */
  providerIdentity?: string;
}

export interface WrittenFile {
  fileId: number;
  symbolIds: number[];
  /** Импортированные имена с их спецификаторами — вход для межфайлового резолва. */
  imports: Array<{
    specifier: string;
    names: string[];
    aliases: Array<{ imported: string; local: string }>;
  }>;
}

function sha256Bytes(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function symbolTokensOf(name: string, signature: string): string {
  const tokens = new Set<string>();
  for (const token of searchTokensOf(name)) tokens.add(token);
  for (const token of searchTokensOf(signature)) tokens.add(token);
  // Цельный идентификатор в нижнем регистре — чтобы запрос `workspaceWatcher` совпадал
  // и с `workspace-watcher` в тексте, и с самим именем символа.
  tokens.add(name.toLowerCase());
  return ftsDocumentOf(tokens, FTS_SYMBOL_TOKENS);
}

export function deleteFileFacts(db: IndexDatabase, fileId: number): void {
  // Bug 原因：node:sqlite 的 run() 会读取连接级 lastInsertRowid；FTS5 删除内部事项可能把
  // 它写成超过 Number.MAX_SAFE_INTEGER 的 docid，Node 在构造 RunResult 时抛
  // ERR_OUT_OF_RANGE，即使 DELETE 已经成功，后续删除/写入也会连锁失败。
  // 删除语句不需要返回值，用 all() 只执行 SQL，避免读取这个与业务无关的字段。
  const runDelete = (sql: string): void => {
    db.prepare(sql).all(fileId);
  };
  // FTS-таблицы внешне-контентные и не удаляются каскадом, поэтому чистим их явно.
  runDelete(
    "DELETE FROM chunks_fts WHERE rowid IN (SELECT chunk_id FROM chunks WHERE file_id = ?)",
  );
  runDelete(
    "DELETE FROM sketch_postings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE file_id = ?)",
  );
  runDelete("DELETE FROM refs WHERE src_file_id = ?");
  runDelete("DELETE FROM files WHERE file_id = ?");
}

export function findFileId(db: IndexDatabase, relPath: string): number | undefined {
  const row = db.prepare("SELECT file_id FROM files WHERE rel_path = ?").get(relPath) as
    | { file_id?: number }
    | undefined;
  return typeof row?.file_id === "number" ? row.file_id : undefined;
}

export function writeFileFacts(db: IndexDatabase, input: WriteFileInput): WrittenFile {
  const existing = findFileId(db, input.relPath);
  if (existing !== undefined) deleteFileFacts(db, existing);

  const interner = new StringInterner(db);
  // Предзагрузка всех значений файла одним запросом на пачку: иначе каждая интернированная
  // строка стоила бы двух обращений к БД (INSERT + SELECT).
  interner.preload([
    ...input.parsed.chunks.map((chunk) => chunk.scopeHeader),
    ...input.parsed.calls.map((call) => call.name),
    ...input.parsed.references.map((reference) => reference.name),
    ...input.parsed.heritage.map((heritage) => heritage.name),
    ...input.parsed.imports.map((item) => item.specifier),
  ]);

  const inserted = db
    .prepare(
      `INSERT INTO files(rel_path, content_sha256, mtime_ms, size_bytes, lang_id, path_tier, pagerank, import_blob, chunk_blob)
       VALUES(?, ?, ?, ?, ?, ?, 1.0, ?, ?)`,
    )
    .run(
      input.relPath,
      sha256Bytes(input.content),
      input.mtimeMs,
      input.size,
      input.parsed.languageId,
      input.pathTier,
      packText(
        JSON.stringify(
          input.parsed.imports.slice(0, 400).map((item) => ({
            specifier: item.specifier,
            names: item.names.slice(0, 32),
          })),
        ),
      ),
      // Текст всех чанков файла — один deflate-поток (41.62 МБ по корпусу вместо 70.45 МБ).
      packFileChunks(input.parsed.chunks.map((chunk) => chunk.content)),
    );
  const fileId = Number(inserted.lastInsertRowid);

  const insertSymbol = db.prepare(
    `INSERT INTO symbols(file_id, parent_symbol_id, name, kind, exported, start_line, end_line, centrality)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0.0)`,
  );
  const symbolIds: number[] = [];
  for (const symbol of input.parsed.symbols) {
    const parentId = symbol.parentIndex !== null ? (symbolIds[symbol.parentIndex] ?? null) : null;
    const result = insertSymbol.run(
      fileId,
      parentId,
      symbol.name,
      symbol.kind,
      symbol.exported ? 1 : 0,
      symbol.startLine,
      symbol.endLine,
    );
    symbolIds.push(Number(result.lastInsertRowid));
  }

  const insertChunk = db.prepare(
    `INSERT INTO chunks(file_id, primary_symbol_id, chunk_index, start_line, end_line, token_count, scope_header)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChunkFts = db.prepare(
    "INSERT INTO chunks_fts(rowid, symbol_tokens, content_tokens) VALUES(?, ?, ?)",
  );
  const insertVector = db.prepare(
    `INSERT INTO chunk_vectors(chunk_id, local_sketch_q4, local_scale, provider_sketch_q4, provider_scale, provider_identity)
     VALUES(?, ?, ?, ?, ?, ?)`,
  );
  const insertPosting = db.prepare(
    "INSERT INTO sketch_postings(kind, bucket, weight_q, chunk_id) VALUES(?, ?, ?, ?)",
  );
  const POSTING_THRESHOLD = 48;
  const POSTINGS_PER_CHUNK = 8;
  /**
   * Постинги только по самым значимым измерениям.
   *
   * Замер: хранение всех измерений выше порога давало 5–10 млн строк на монорепозитории и
   * раздувало БД на сотни МБ, ничего не добавляя к качеству кандидатов (косинус всё равно
   * считается по полному скетчу). Восемь наибольших вкладов достаточно, чтобы найти чанк.
   */
  const writePostings = (chunkId: number, kind: number, signedValues: readonly number[]): void => {
    const candidates: Array<{ bucket: number; signed: number }> = [];
    for (let bucket = 0; bucket < signedValues.length; bucket += 1) {
      const signed = signedValues[bucket] ?? 0;
      if (Math.abs(signed) < POSTING_THRESHOLD) continue;
      candidates.push({ bucket, signed });
    }
    candidates.sort(
      (left, right) => Math.abs(right.signed) - Math.abs(left.signed) || left.bucket - right.bucket,
    );
    for (const candidate of candidates.slice(0, POSTINGS_PER_CHUNK)) {
      insertPosting.run(kind, candidate.bucket, candidate.signed, chunkId);
    }
  };
  for (let chunkIndex = 0; chunkIndex < input.parsed.chunks.length; chunkIndex += 1) {
    const chunk = input.parsed.chunks[chunkIndex]!;
    const primarySymbolId =
      chunk.symbolIndex !== null ? (symbolIds[chunk.symbolIndex] ?? null) : null;
    const result = insertChunk.run(
      fileId,
      primarySymbolId,
      chunkIndex,
      chunk.startLine,
      chunk.endLine,
      chunk.tokenCount,
      chunk.scopeHeader,
    );
    const chunkId = Number(result.lastInsertRowid);
    const symbolName =
      primarySymbolId !== null ? (input.parsed.symbols[chunk.symbolIndex ?? -1]?.name ?? "") : "";
    insertChunkFts.run(
      chunkId,
      ftsDocumentOf(searchTokensOf(`${symbolName} ${chunk.scopeHeader}`), FTS_SYMBOL_TOKENS),
      ftsDocumentOf(searchTokensOf(chunk.content), FTS_CONTENT_TOKENS),
    );
    const sketch = sketchOfText(chunk.content);
    const local = quantizeSketchQ4(sketch);
    const provider = input.providerVectors?.[chunkIndex];
    insertVector.run(
      chunkId,
      local.bytes,
      local.scale,
      provider ? provider.sketchQ4 : null,
      provider ? provider.sketchScale : null,
      provider && input.providerIdentity ? input.providerIdentity : null,
    );
    // Постинги строятся по полным (не упакованным) значениям: порог 48 из 127 теряет смысл
    // после перехода на уровни 0..7, поэтому постинги считаются от Int8-представления.
    writePostings(chunkId, 0, signedInt8Of(sketch));
    if (provider) writePostings(chunkId, 1, provider.sketchSigned);
  }

  // Определения: родительский символ владеет дочерним (структурная иерархия).
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges(src_symbol_id, dst_symbol_id, src_file_id, relation) VALUES(?, ?, ?, ?)",
  );
  for (let index = 0; index < symbolIds.length; index += 1) {
    const symbol = input.parsed.symbols[index]!;
    const parentId = symbol.parentIndex !== null ? symbolIds[symbol.parentIndex] : undefined;
    if (parentId !== undefined) {
      insertEdge.run(parentId, symbolIds[index]!, fileId, EDGE_RELATION.defines);
    }
  }

  const insertRef = db.prepare(
    `INSERT INTO refs(src_symbol_id, src_file_id, name_id, spec_id, relation, occur)
     VALUES(?, ?, ?, ?, ?, 1)
     ON CONFLICT(src_symbol_id, name_id, spec_id, relation, src_file_id)
     DO UPDATE SET occur = occur + 1`,
  );
  const moduleSymbolId = symbolIds[0] ?? 0;
  // Карта «имя, под которым имя видно в этом файле → реальное имя символа».
  // Нужна для `import { probe as p }`: вызов `p()` относится к символу `probe`.
  const importedName = new Map<string, { name: string; specifier: string }>();
  for (const item of input.parsed.imports) {
    for (const alias of item.aliases ?? []) {
      importedName.set(alias.local, { name: alias.imported, specifier: item.specifier });
    }
    for (const name of item.names) {
      if (!importedName.has(name)) importedName.set(name, { name, specifier: item.specifier });
    }
  }
  const resolveName = (name: string): { name: string; specifier: string | null } => {
    const imported = importedName.get(name);
    return imported
      ? { name: imported.name, specifier: imported.specifier }
      : { name, specifier: null };
  };
  /**
   * Запись ссылки в агрегированном виде.
   *
   * Причина агрегации: в схеме v2 на каждый вызов писалась отдельная строка вместе с номером
   * строки, из-за чего выходило 977 635 строк. Резолв рёбер номер строки не читал, поэтому
   * ссылки сведены по `(источник, имя, спецификатор, отношение)`, а повторные вхождения
   * считаются в `occur`. Это даёт 547 230 строк и снимает необходимость индекса по `line`.
   */
  const writeRef = (
    sourceId: number,
    name: string,
    specifier: string | null,
    relation: number,
  ): void => {
    if (!sourceId) return;
    insertRef.run(
      sourceId,
      fileId,
      interner.intern(name),
      interner.intern(specifier ?? ""),
      relation,
    );
  };
  for (const call of input.parsed.calls) {
    const sourceId =
      call.enclosingSymbolIndex !== null
        ? (symbolIds[call.enclosingSymbolIndex] ?? moduleSymbolId)
        : moduleSymbolId;
    const target = resolveName(call.name);
    writeRef(sourceId, target.name, target.specifier, EDGE_RELATION.calls);
  }
  for (const reference of input.parsed.references) {
    const sourceId =
      reference.enclosingSymbolIndex !== null
        ? (symbolIds[reference.enclosingSymbolIndex] ?? moduleSymbolId)
        : moduleSymbolId;
    const target = resolveName(reference.name);
    writeRef(sourceId, target.name, target.specifier, EDGE_RELATION.references);
  }
  for (const heritage of input.parsed.heritage) {
    const sourceId = symbolIds[heritage.symbolIndex] ?? 0;
    writeRef(
      sourceId,
      heritage.name,
      null,
      heritage.relation === "extends" ? EDGE_RELATION.extends : EDGE_RELATION.implements,
    );
  }

  return {
    fileId,
    symbolIds,
    imports: input.parsed.imports.map((item) => ({
      specifier: item.specifier,
      names: item.names,
      aliases: item.aliases ?? [],
    })),
  };
}

/**
 * Резолв межфайловых рёбер.
 *
 * Замер на монорепозитории Zcode показал, что коррелированный `COUNT(*)` на каждую строку
 * `unresolved_refs` даёт квадратичный проход (десятки секунд). Здесь имя сначала
 * классифицируется одним `GROUP BY`, и резолвятся только однозначные имена — стоимость
 * линейна по числу ссылок.
 */
export function resolveEdges(
  db: IndexDatabase,
  importEdges: readonly { specifier: string; names: readonly string[]; srcFileId: number }[] = [],
): void {
  db.exec("DELETE FROM edges WHERE relation <> " + EDGE_RELATION.defines);

  // Имена, у которых ровно один символ-определение во всём индексе — однозначные цели.
  // Сравнение идёт по тексту имени: `temp.unique_symbol_names` заполняется из `symbols`,
  // а `refs` соединена со `strings` — стоимость линейна по числу различных имён.
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS unique_symbol_names(value TEXT PRIMARY KEY, symbol_id INTEGER);
    DELETE FROM temp.unique_symbol_names;
    INSERT INTO temp.unique_symbol_names(value, symbol_id)
    SELECT name, MIN(symbol_id) FROM symbols GROUP BY name HAVING COUNT(*) = 1;
  `);
  db.exec("CREATE INDEX IF NOT EXISTS temp.idx_uniq_name ON unique_symbol_names(value)");

  // Приоритет 1: ссылка пришла из импорта конкретного модуля — берём одноимённый символ
  // из этого файла. Это устраняет ложные цели, когда во всём индексе несколько `probe`.
  //
  // Сравнение идёт по путям без расширений: спецификатор импорта ссылается на
  // скомпилированный модуль (`./x.js`), а в индексе лежит исходник (`x.ts`).
  db.exec(`
    INSERT OR IGNORE INTO edges(src_symbol_id, dst_symbol_id, src_file_id, relation)
    SELECT r.src_symbol_id, target.symbol_id, r.src_file_id, r.relation
    FROM refs r
    JOIN strings spec ON spec.string_id = r.spec_id
    JOIN strings name ON name.string_id = r.name_id
    JOIN files df
      ON r.spec_id <> 0
     AND REPLACE(REPLACE(REPLACE(REPLACE(df.rel_path, '.tsx', ''), '.ts', ''), '.jsx', ''), '.js', '')
         LIKE '%' || REPLACE(REPLACE(REPLACE(spec.value, '../', ''), './', ''), '.js', '') || '%'
    JOIN symbols target ON target.file_id = df.file_id AND target.name = name.value
    WHERE target.file_id <> r.src_file_id
      AND r.spec_id <> 0
  `);
  db.exec(`
    INSERT OR IGNORE INTO edges(src_symbol_id, dst_symbol_id, src_file_id, relation)
    SELECT r.src_symbol_id, u2.symbol_id, r.src_file_id, r.relation
    FROM refs r
    JOIN strings name ON name.string_id = r.name_id
    JOIN temp.unique_symbol_names u2 ON u2.value = name.value
    JOIN symbols s ON s.symbol_id = u2.symbol_id
    WHERE s.file_id <> r.src_file_id
  `);
  db.exec(`
    INSERT OR IGNORE INTO edges(src_symbol_id, dst_symbol_id, src_file_id, relation)
    SELECT r.src_symbol_id, u2.symbol_id, r.src_file_id, r.relation
    FROM refs r
    JOIN strings name ON name.string_id = r.name_id
    JOIN temp.unique_symbol_names u2 ON u2.value = name.value
    JOIN symbols s ON s.symbol_id = u2.symbol_id
    WHERE s.file_id = r.src_file_id
  `);
  db.exec("DELETE FROM temp.unique_symbol_names");
  insertImportEdges(db, importEdges);
}

/**
 * Рёбра `imports` от модульного символа файла к импортированным символам.
 *
 * Причина отдельного шага: `unresolved_refs` описывает использования имён, а импорт — это
 * факт зависимости даже без вызова. Граф зависимостей без этих рёбер не видит связи между
 * файлами, если символ импортирован, но не использован в теле.
 */
function insertImportEdges(
  db: IndexDatabase,
  imports: readonly { specifier: string; names: readonly string[]; srcFileId: number }[],
): void {
  if (imports.length === 0) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO edges(src_symbol_id, dst_symbol_id, src_file_id, relation)
     SELECT ?, target.symbol_id, ?, ?
     FROM files df
     JOIN symbols target ON target.file_id = df.file_id AND target.name = ?
     WHERE df.rel_path LIKE '%' || ? || '%'
       AND target.file_id <> ?
     LIMIT 1`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of imports) {
      const source = db
        .prepare(
          "SELECT symbol_id FROM symbols WHERE file_id = ? ORDER BY start_line, symbol_id LIMIT 1",
        )
        .get(item.srcFileId) as { symbol_id?: number } | undefined;
      const sourceId = Number(source?.symbol_id ?? 0);
      if (!sourceId) continue;
      const specifier = item.specifier.replace(/^\.\.?\//u, "").replace(/\.[cm]?[jt]sx?$/u, "");
      if (!specifier) continue;
      for (const name of item.names.slice(0, 16)) {
        insert.run(
          sourceId,
          item.srcFileId,
          EDGE_RELATION.imports,
          name,
          specifier,
          item.srcFileId,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function clearUnresolved(db: IndexDatabase): void {
  db.exec("DELETE FROM refs");
}

export function fileIdsOf(db: IndexDatabase): number[] {
  const rows = db.prepare("SELECT file_id FROM files ORDER BY file_id").all() as Array<{
    file_id: number;
  }>;
  return rows.map((row) => row.file_id);
}

export function fileTiers(db: IndexDatabase): Map<number, number> {
  const rows = db.prepare("SELECT file_id, path_tier FROM files ORDER BY file_id").all() as Array<{
    file_id: number;
    path_tier: number;
  }>;
  return new Map(rows.map((row) => [row.file_id, row.path_tier]));
}

export function filePathById(db: IndexDatabase): Map<number, string> {
  const rows = db.prepare("SELECT file_id, rel_path FROM files ORDER BY file_id").all() as Array<{
    file_id: number;
    rel_path: string;
  }>;
  return new Map(rows.map((row) => [row.file_id, row.rel_path]));
}

export { SYMBOL_KIND };
