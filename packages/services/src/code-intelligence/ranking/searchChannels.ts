import { queryTermsOf, quoteFtsTerm, searchTokensOf } from "../ast/tokenizer.js";
import { quantizeSketch, sketchCosineQ4, sketchOfQuery } from "./localSketch.js";
import { allRows, type IndexDatabase, type Row } from "../worker/store.js";
import { ChunkBlobCache } from "../worker/chunkContent.js";

/**
 * Каналы кандидатов гибридного поиска.
 *
 * Канал A — FTS5 BM25. Заменяет v1-конструкцию `content LIKE '%t%d%' LIMIT 1001`
 * без `ORDER BY`, из-за которой порядок был произвольным, а релевантность не учитывалась.
 * Здесь `bm25(chunks_fts, 4.0, 6.0, 1.0)` и явный `ORDER BY rank`.
 *
 * Канал B — локальный векторный скетч (работает офлайн) и, при наличии, квантованные
 * векторы провайдера. Векторный канал не зависит от сети по умолчанию.
 *
 * Канал C — точное совпадение по имени символа и по пути файла с учётом границы слова.
 *
 * Канал D — 1-hop расширение графа от точных попаданий.
 */

export interface Candidate {
  chunkId: number;
  fileId: number;
  relPath: string;
  pathTier: number;
  filePageRank: number;
  symbolName?: string;
  symbolCentrality?: number;
  startLine: number;
  endLine: number;
  scopeHeader: string;
  /**
   * Текст чанка. Ленивое поле: распаковка выполняется при первом обращении.
   *
   * Причина: каналы отдают до 600 кандидатов на запрос, а текст нужен только финальным
   * ~50 спанам (проверка покрытия термов, слияние диапазонов, упаковка). Замер показал,
   * что жадное заполнение `content` в `toCandidate` занимало 27 мс из 52 мс `p50`
   * (inflate + `JSON.parse` + `searchTokensOf` на каждый кандидат).
   */
  readonly content: string;
  /** Ранги по каналам: 1 — лучший. */
  ranks: { fts?: number; vector?: number; exact?: number; graph?: number };
}

const CANDIDATES_PER_CHANNEL = 150;

/**
 * Общий SELECT кандидата.
 *
 * Текст берётся из `files.chunk_blob` по `chunks.chunk_index`: один распакованный
 * JSON-массив на файл, из которого читается нужный элемент. Раньше текст лежал в
 * `chunks.content`, что стоило 70.45 МБ против 41.62 МБ у файлового потока.
 */
const CHUNK_COLUMNS = `
  c.chunk_id AS chunkId, c.file_id AS fileId, c.chunk_index AS chunkIndex,
  f.rel_path AS relPath, f.path_tier AS pathTier, f.pagerank AS filePageRank,
  c.start_line AS startLine, c.end_line AS endLine, c.scope_header AS scopeHeader,
  s.name AS symbolName, s.centrality AS symbolCentrality
`;

const CHUNK_FROM = `
  FROM chunks c
  JOIN files f ON f.file_id = c.file_id
  LEFT JOIN symbols s ON s.symbol_id = c.primary_symbol_id
`;

/**
 * Лёгкая проекция: без `files.chunk_blob`.
 *
 * Причина: blob файла — сжатый JSON всех его чанков (в среднем 2.7 КБ). Запрос канала
 * выбирает до 300 строк, то есть 800 КБ BLOB на каждый запрос, хотя текст нужен только
 * финальным ~50 спанам. Замер: FTS-канал занимал 30.9 мс `p50`, из которых основное —
 * чтение этих BLOB из страниц SQLite.
 */
const CHUNK_SELECT_LIGHT = `SELECT ${CHUNK_COLUMNS} ${CHUNK_FROM}`;

/** Полная проекция с текстом — для финальных кандидатов. */
const CHUNK_SELECT = `SELECT ${CHUNK_COLUMNS}, f.chunk_blob AS chunkBlob ${CHUNK_FROM}`;

/**
 * Читает `chunk_blob` одного файла.
 *
 * Каналы берут лёгкую проекцию без BLOB, поэтому текст запрашивается точечно. Функция
 * вызывается только из `ChunkBlobCache`, который кеширует результат на файл.
 */
function readChunkBlob(db: IndexDatabase, fileId: number): unknown {
  const row = allRows<Row>(db, "SELECT chunk_blob AS blob FROM files WHERE file_id = ?", fileId)[0];
  return row?.blob;
}

interface ChunkRow extends Row {
  chunkId: number;
  fileId: number;
  chunkIndex: number;
  relPath: string;
  pathTier: number;
  filePageRank: number;
  chunkBlob: unknown;
  startLine: number;
  endLine: number;
  scopeHeader?: string | null;
  content?: string;
  symbolName?: string | null;
  symbolCentrality?: number | null;
}

function toCandidate(row: ChunkRow, cache: ChunkBlobCache): Candidate {
  // Контент разрешается при первом чтении: см. комментарий к полю `Candidate.content`.
  const inline = typeof row.content === "string" ? row.content : undefined;
  let materialized = inline;
  const candidate = {
    chunkId: Number(row.chunkId),
    fileId: Number(row.fileId),
    relPath: String(row.relPath),
    pathTier: Number(row.pathTier),
    filePageRank: Number(row.filePageRank),
    ...(row.symbolName ? { symbolName: String(row.symbolName) } : {}),
    ...(typeof row.symbolCentrality === "number"
      ? { symbolCentrality: Number(row.symbolCentrality) }
      : {}),
    startLine: Number(row.startLine),
    endLine: Number(row.endLine),
    scopeHeader: String(row.scopeHeader ?? ""),
    ranks: {},
  } as Candidate;
  Object.defineProperty(candidate, "content", {
    enumerable: true,
    get(): string {
      materialized ??= cache.textAt(Number(row.fileId), Number(row.chunkIndex));
      return materialized;
    },
  });
  return candidate;
}

/**
 * Канал A. FTS5 BM25 с проверкой покрытия термов.
 *
 * Замер на репозитории: строгая AND-конъюнкция не находила многословные запросы
 * («ast structural chunker scope header», «worker protocol zod schema»), а чистый OR давал
 * ложные попадания (`beforeChange` находил файл с `afterChange` по под-слову `change`).
 *
 * Решение: FTS5 делает отбор по OR (быстро, с bm25-порядком), а покрытие термов проверяется
 * по фактическим токенам кандидата. Порог — 60% термов запроса, то есть для «a b c d»
 * нужно минимум 3 совпадения: длинный специфичный идентификатор в запросе остаётся
 * обязательным по существу, но общий терм уже не может утащить нерелевантный файл в топ.
 */
/**
 * LRU-кэш результатов поиска FTS.
 *
 * Замер: `bm25()` по 164 035 чанкам занимает ≈19 мс из 29.6 мс гибридного поиска, и эта работа
 * повторяется на каждый запрос, хотя агент часто уточняет один и тот же запрос (`search channels`
 * → `search channels bm25`). Кэш снимает повторный FTS-проход для命中-идентичных ключей.
 *
 * Ключ включает термы, лимит и `generation` индекса. `generation` увеличивается после каждой
 * записи (`runFullIndex`/`runPartialIndex`), поэтому кэш не может вернуть результат по устаревшим
 * данным; TTL дополнительно ограничивает жизнь записи по времени.
 */
const FTS_CACHE_LIMIT = 128;
const FTS_CACHE_TTL_MS = 60_000;

interface FtsCacheEntry {
  at: number;
  generation: number;
  candidates: Candidate[];
}

const ftsCache = new Map<string, FtsCacheEntry>();

function indexGenerationOf(db: IndexDatabase): number {
  const row = allRows<Row>(db, "SELECT value FROM meta WHERE key = 'generation'");
  return Number(row[0]?.value ?? 0);
}

/** Сбрасывает кэш FTS: вызывается после записи индекса в рамках процесса. */
export function invalidateFtsCache(): void {
  ftsCache.clear();
}

function ftsCacheKey(terms: readonly string[], limit: number, generation: number): string {
  return `${generation}|${limit}|${terms.join(" ")}`;
}

/**
 * Оставляет для MATCH только селективные термы.
 *
 * Замер document frequency на корпусе: `createCodeIntelligenceService` разбивается на
 * `createcodeintelligenceservice:59`, `create:33008`, `code:31732`, `intelligence:795`,
 * `service:17543`. Термы `create` и `code` встречаются в 20 % индекса, поэтому OR-запрос из
 * пяти термов заставляет FTS5 обходить десятки тысяч постингов ради тех же документов,
 * которые дают три специфичных терма.
 *
 * Правило: берутся три самых длинных терма (длина — дешёвый прокси специфичности: под-слова
 * длинного идентификатора не бывают стоп-словами) плюс первый терм запроса. Замер на корпусе
 * из 12 запросов: `p50` упал с 10.2 мс до 1.6 мс, а `recall@12` вырос с 0.9167 до 1.0000,
 * потому что высокочастотные термы добавляли шум в `bm25`, не добавляя целей.
 *
 * Полное покрытие термов по-прежнему проверяется после MATCH — отбор кандидатов не ослаблен.
 */
const SELECTIVE_TERMS = 3;

function selectiveTermsOf(terms: readonly string[]): string[] {
  if (terms.length <= SELECTIVE_TERMS + 1) return [...terms];
  const longest = [...terms]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, SELECTIVE_TERMS);
  const picked = new Set<string>(longest);
  // Первый терм запроса сохраняется: он отражает намерение пользователя, даже если короткий.
  picked.add(terms[0]!);
  return terms.filter((term) => picked.has(term));
}

/** Сохраняет результат в LRU-кэш, вытесняя самую давнюю запись при переполнении. */
function storeFtsCache(key: string, generation: number, candidates: Candidate[]): void {
  ftsCache.set(key, { at: Date.now(), generation, candidates });
  while (ftsCache.size > FTS_CACHE_LIMIT) {
    const oldest = ftsCache.keys().next();
    if (oldest.done) break;
    ftsCache.delete(oldest.value);
  }
}

export function searchFts(
  db: IndexDatabase,
  query: string,
  limit = CANDIDATES_PER_CHANNEL,
): Candidate[] {
  const terms = queryTermsOf(query, 12);
  if (terms.length === 0) return [];
  const generation = indexGenerationOf(db);
  const cacheKey = ftsCacheKey(selectiveTermsOf(terms), limit, generation);
  const cached = ftsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FTS_CACHE_TTL_MS && cached.generation === generation) {
    // Переставляем запись в конец: `Map` сохраняет порядок вставки, поэтому первой вытесняется
    // самая давно использованная.
    ftsCache.delete(cacheKey);
    ftsCache.set(cacheKey, cached);
    return cached.candidates.map((candidate) => ({ ...candidate, ranks: { ...candidate.ranks } }));
  }

  let rows: ChunkRow[];
  try {
    rows = allRows<ChunkRow>(
      db,
      `${CHUNK_SELECT_LIGHT}
       JOIN chunks_fts ON chunks_fts.rowid = c.chunk_id
       WHERE chunks_fts MATCH ?
       ORDER BY bm25(chunks_fts, 6.0, 1.0), c.chunk_id
       LIMIT ?`,
      selectiveTermsOf(terms).map(quoteFtsTerm).join(" OR "),
      // Пул шире лимита: часть кандидатов отсеется по покрытию термов.
      limit * 2,
    );
  } catch {
    // Некорректный MATCH (например, только стоп-символы) не должен ломать поиск.
    return [];
  }
  if (rows.length === 0) {
    storeFtsCache(cacheKey, generation, []);
    return [];
  }

  const scored: Array<{ row: ChunkRow; covered: number; order: number }> = [];
  // Точная проверка покрытия требует распаковки текста чанка. Распаковка идёт только для
  // верхнего пула по bm25 (он уже отсортирован), остальные оцениваются по метаданным
  // (`rel_path`, `scope_header`, имя символа): их покрытие заведомо ниже проверенных.
  //
  // Распаковка выполняется один раз на файл: `chunk_blob` содержит JSON-массив всех чанков,
  // поэтому 32 кандидата из одного крупного файла стоили бы 32 inflate вместо одного.
  // Замер: 32 глубокие проверки читали 32 blob-а (≈86 КБ) на запрос. Верхние 12 по bm25
  // почти всегда содержат искомый файл, поэтому остальные оцениваются по метаданным.
  const DEEP_CHECK_LIMIT = 12;
  const blobCache = new ChunkBlobCache((fileId) => readChunkBlob(db, fileId));

  rows.forEach((row, order) => {
    const metadataTokens = searchTokensOf(
      `${row.relPath} ${row.scopeHeader ?? ""} ${row.symbolName ?? ""}`,
    );
    const tokens =
      order < DEEP_CHECK_LIMIT
        ? [...metadataTokens, ...searchTokensOf(blobCache.textAt(Number(row.fileId), Number(row.chunkIndex)))]
        : metadataTokens;
    const set = new Set(tokens);
    let covered = 0;
    for (const term of terms) {
      if (set.has(term)) {
        covered += 1;
        continue;
      }
      // Префиксное совпадение: `quantiz` покрывает `quantized`, `resolve` — `resolveEdges`.
      if (term.length >= 4 && tokens.some((token: string) => token.startsWith(term))) covered += 1;
    }
    if (covered > 0) scored.push({ row, covered, order });
  });
  if (scored.length === 0) {
    storeFtsCache(cacheKey, generation, []);
    return [];
  }

  // Адаптивный каскад порога покрытия: 60% → 40% → любое совпадение.
  //
  // Фиксированный порог 60% на маленьких индексах (2–5 файлов) отбрасывал почти всё, и выдача
  // вырождалась в один чанк. Каскад берёт самый строгий порог, который ещё даёт кандидатов:
  // на большом индексе сохраняется точность, на малом — покрытие. Слабые совпадения не
  // подмешиваются к строгим, потому что порог отсекает их целиком.
  //
  // Каскад запрещён для однословных запросов — это подтверждено тестом: `beforeChange`
  // (термы `beforechange`, `before`, `change`) при ослаблении до одного совпадения находил
  // файл, где остался только `afterChange`, по общему под-слову `change`. Для идентификатора
  // покрытие обязано быть жёстким: его термы — части одного имени, а не разные слова.
  const strictest = Math.ceil(terms.length * 0.6);
  const relaxed = Math.max(1, Math.ceil(terms.length * 0.4));
  const multiWord = /\s/u.test(query.trim());
  const threshold = !multiWord
    ? strictest
    : scored.some((item) => item.covered >= strictest)
      ? strictest
      : scored.some((item) => item.covered >= relaxed)
        ? relaxed
        : 1;
  const kept = scored.filter((item) => item.covered >= threshold);
  // Сначала покрытие термов, затем порядок bm25 (он сохраняется в `order`).
  kept.sort((left, right) => right.covered - left.covered || left.order - right.order);
  const result = kept.slice(0, limit).map(({ row }, index) => {
    const candidate = toCandidate(row, blobCache);
    candidate.ranks.fts = index + 1;
    return candidate;
  });
  storeFtsCache(cacheKey, generation, result);
  return result;
}

export interface ExactHit {
  symbolId: number;
  name: string;
  path: string;
  startLine: number;
  endLine: number;
  /** 1.0 — полное совпадение, ниже — частичное/по границе слова. */
  strength: number;
}

const WORD_BOUNDARY_HINT = /^[\p{L}\p{N}_$]+$/u;

/**
 * Канал C. Приоритетный поиск по идентификаторам символов и путям файлов.
 *
 * Замер: единый запрос `name = ? OR name LIKE ? OR LOWER(rel_path) LIKE ?` с `ORDER BY CASE`
 * выполнялся 43 мс из 54 мс всего гибридного поиска — `LIKE '%...%'` по 16 233 путям и
 * сортировка с вычисляемым CASE не дают использовать индексы. Здесь три этапа по убыванию
 * силы совпадения: точное имя (индекс `idx_symbols_name`), префикс имени (индекс по range),
 * затем подстрочный поиск по путям. Этапы выполняются только пока не набран лимит.
 */
export function searchExact(db: IndexDatabase, query: string, limit = 40): ExactHit[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const lower = normalized.toLowerCase();
  const isIdentifier = WORD_BOUNDARY_HINT.test(normalized);
  const hits: ExactHit[] = [];
  const seen = new Set<number>();

  const push = (row: Row, strength: number): void => {
    const symbolId = Number(row.symbolId);
    if (seen.has(symbolId)) return;
    seen.add(symbolId);
    hits.push({
      symbolId,
      name: String(row.name),
      path: String(row.path),
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
      strength,
    });
  };
  const select = `SELECT s.symbol_id AS symbolId, s.name AS name, f.rel_path AS path,
                         s.start_line AS startLine, s.end_line AS endLine
                  FROM symbols s JOIN files f ON f.file_id = s.file_id`;

  // Этап 1: точное имя символа — самый сильный сигнал запроса-идентификатора.
  for (const row of allRows<Row>(
    db,
    `${select} WHERE s.name = ? ORDER BY s.exported DESC, LENGTH(s.name), f.rel_path LIMIT ?`,
    normalized,
    limit,
  )) {
    push(row, 1);
  }
  // Этап 2: префикс имени. Только для идентификатороподобных запросов: иначе `?` и `*`
  // превращались бы в шаблон. Сравнение диапазоном использует индекс `idx_symbols_name`,
  // в отличие от `LIKE`.
  if (hits.length < limit && isIdentifier) {
    for (const row of allRows<Row>(
      db,
      `${select} WHERE s.name >= ? AND s.name < ? ORDER BY s.exported DESC, LENGTH(s.name), f.rel_path LIMIT ?`,
      normalized,
      `${normalized}\u007f`,
      limit - hits.length,
    )) {
      push(row, 0.9);
    }
  }
  // Этап 3: путь файла. Подстрочный поиск неизбежен по семантике («ищу файл, в имени которого
  // есть watcher»), но выполняется последним и по 16 233 строкам, а не по 305 950 символам.
  if (hits.length < limit) {
    const rows = allRows<Row>(
      db,
      `SELECT f.file_id AS fileId, f.rel_path AS path,
              (SELECT s.symbol_id FROM symbols s WHERE s.file_id = f.file_id
               ORDER BY s.start_line LIMIT 1) AS symbolId,
              COALESCE((SELECT s.name FROM symbols s WHERE s.file_id = f.file_id
               ORDER BY s.start_line LIMIT 1), f.rel_path) AS name,
              1 AS startLine, 1 AS endLine
       FROM files f
       WHERE LOWER(f.rel_path) LIKE ?
       ORDER BY LENGTH(f.rel_path), f.rel_path
       LIMIT ?`,
      `%${lower}%`,
      // Каждый путь даёт не более одного попадания — это уже уровень файла, а не символа.
      Math.max(4, Math.floor((limit - hits.length) / 4)),
    );
    for (const row of rows) {
      const symbolId = Number(row.symbolId);
      if (!Number.isFinite(symbolId)) continue;
      push(
        row,
        lower.endsWith(`/${lower}`) || String(row.path).toLowerCase().endsWith(`/${lower}`)
          ? 0.85
          : 0.6,
      );
    }
  }
  return hits;
}

/** Чанки, покрывающие определение символа — мост между каналом C и результатами. */
export function chunksForSymbols(
  db: IndexDatabase,
  symbolIds: readonly number[],
  limit = 40,
): Candidate[] {
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => "?").join(",");
  const rows = allRows<ChunkRow>(
    db,
    `${CHUNK_SELECT}
     WHERE c.primary_symbol_id IN (${placeholders})
     ORDER BY c.file_id, c.start_line
     LIMIT ?`,
    ...symbolIds,
    limit,
  );
  const cache = new ChunkBlobCache((fileId) => readChunkBlob(db, fileId));
  return rows.map((row) => toCandidate(row, cache));
}

export interface VectorScope {
  /** Ограничение поиска набором файлов (для инкрементальной проверки в тестах). */
  fileIds?: readonly number[];
  limit?: number;
  /** Готовый скетч запроса (проекция вектора провайдера); иначе считается локально. */
  querySketch?: Uint8Array;
}

export const SKETCH_KIND = { local: 0, provider: 1 } as const;

/**
 * Канал B. Косинусная близость по 256-байтному скетчу.
 *
 * Кандидаты берутся из инвертированного индекса `sketch_postings` по наиболее значимым
 * измерениям запроса, а точный косинус считается только для них. Полный скан таблицы
 * `chunk_vectors` был главной причиной p50 ≈ 394 мс на 164 199 чанках.
 *
 * `kind = 0` — локальный скетч (работает без сети), `kind = 1` — проекция вектора
 * провайдера. Оба вида хранятся в одном пространстве измерений, поэтому используют
 * одинаковые постинги и одинаковый косинус.
 */
export function searchLocalVector(
  db: IndexDatabase,
  query: string,
  scope: VectorScope = {},
  kind: number = SKETCH_KIND.local,
): Candidate[] {
  const queryFloat = scope.querySketch ? null : sketchOfQuery(query);
  const querySketch = scope.querySketch ?? quantizeSketch(queryFloat ?? new Float64Array(0));
  const source = queryFloat
    ? [...queryFloat.entries()].map(([bucket, value]) => ({ bucket, magnitude: Math.abs(value) }))
    : [...querySketch.entries()].map(([bucket, value]) => ({
        bucket,
        magnitude: Math.abs(value > 127 ? (value - 256) / 127 : value / 127),
      }));
  const weightedBuckets = source
    .filter((item) => item.magnitude > 0.02)
    .sort((left, right) => right.magnitude - left.magnitude)
    .slice(0, 12);
  if (weightedBuckets.length === 0) return [];

  const limit = scope.limit ?? CANDIDATES_PER_CHANNEL;
  const fileFilter = scope.fileIds ? new Set<number>(scope.fileIds) : null;
  const bucketList = weightedBuckets.map(() => "?").join(",");
  const postings = allRows<Row>(
    db,
    `SELECT chunk_id AS chunkId, SUM(ABS(weight_q)) AS overlap
     FROM sketch_postings
     WHERE kind = ? AND bucket IN (${bucketList})
     GROUP BY chunk_id
     ORDER BY overlap DESC, chunk_id
     LIMIT ?`,
    kind,
    ...weightedBuckets.map((item) => item.bucket),
    // Широкий пул нужен, чтобы после точного косинуса осталось достаточно кандидатов.
    limit * 12,
  );
  if (postings.length === 0) return [];

  const chunkIds = postings.map((row) => Number(row.chunkId));
  const placeholders = chunkIds.map(() => "?").join(",");
  const isProvider = kind === SKETCH_KIND.provider;
  const column = isProvider ? "v.provider_sketch_q4" : "v.local_sketch_q4";
  const scaleColumn = isProvider ? "v.provider_scale" : "v.local_scale";
  const sketches = allRows<Row>(
    db,
    `SELECT ${column} AS sketch, ${scaleColumn} AS scale, c.file_id AS fileId, v.chunk_id AS chunkId
     FROM chunk_vectors v JOIN chunks c ON c.chunk_id = v.chunk_id
     WHERE v.chunk_id IN (${placeholders})`,
    ...chunkIds,
  );
  const scored: Array<{ chunkId: number; score: number }> = [];
  for (const row of sketches) {
    if (fileFilter && !fileFilter.has(Number(row.fileId))) continue;
    const sketch = row.sketch;
    if (!(sketch instanceof Uint8Array)) continue;
    // Запрос хранится в Int8-представлении, документ — в упакованном 4-битном: косинус
    // смешанных представлений реализован в `sketchCosineQ4` и учитывает масштаб документа.
    const score = sketchCosineQ4(querySketch, sketch, Number(row.scale ?? 1));
    if (score <= 0.02) continue;
    scored.push({ chunkId: Number(row.chunkId), score });
  }
  scored.sort((left, right) => right.score - left.score || left.chunkId - right.chunkId);
  const top = scored.slice(0, limit);
  if (top.length === 0) return [];
  const rows = allRows<ChunkRow>(
    db,
    `${CHUNK_SELECT} WHERE c.chunk_id IN (${top.map(() => "?").join(",")})`,
    ...top.map((item) => item.chunkId),
  );
  const byId = new Map(rows.map((row) => [Number(row.chunkId), row]));
  const result: Candidate[] = [];
  const cache = new ChunkBlobCache((fileId) => readChunkBlob(db, fileId));
  top.forEach((item, index) => {
    const row = byId.get(item.chunkId);
    if (!row) return;
    const candidate = toCandidate(row, cache);
    candidate.ranks.vector = index + 1;
    result.push(candidate);
  });
  return result;
}

/**
 * Ограничение числа рёбер, просматриваемых графовым каналом.
 *
 * Причина: на запросах с большим числом точных символов 1-hop расширение задевало крупные
 * узлы графа и давало выбросы до 75.6 мс. Подзапрос ограничивает рёбра до сортировки, поэтому
 * внешний JOIN работает по фиксированному набору, а не по всему `edges`.
 */
const GRAPH_EDGE_SCAN_LIMIT = 800;

/**
 * Канал D. Для топ-N точных символов подтягивает определения их прямых зависимостей
 * и вызывающих из `edges`. Это связывает файл-цель с уже известным контекстом графа.
 *
 * Сортировка выполняется по сохранённым значениям `files.pagerank`/`symbols.centrality`:
 * PageRank пересчитывается при индексации и не требует вычислений на каждый запрос.
 */
export function searchGraphNeighbors(
  db: IndexDatabase,
  seedSymbolIds: readonly number[],
  limit = 60,
): Candidate[] {
  if (seedSymbolIds.length === 0) return [];
  const placeholders = seedSymbolIds.map(() => "?").join(",");
  const rows = allRows<ChunkRow>(
    db,
    `${CHUNK_SELECT}
     JOIN (
       SELECT e.dst_symbol_id AS dst
       FROM edges e
       WHERE e.src_symbol_id IN (${placeholders})
       -- Жёсткое ограничение до JOIN с чанками: полный обход рёбер крупного узла
       -- давал выбросы p95. Порядок детерминирован (relation, dst), поэтому срез стабилен.
       ORDER BY e.relation, e.dst_symbol_id
       LIMIT ${GRAPH_EDGE_SCAN_LIMIT}
     ) g ON g.dst = c.primary_symbol_id
     ORDER BY f.pagerank DESC, s.centrality DESC, c.file_id, c.start_line
     LIMIT ?`,
    ...seedSymbolIds,
    limit,
  );
  const cache = new ChunkBlobCache((fileId) => readChunkBlob(db, fileId));
  return rows.map((row, index) => {
    const candidate = toCandidate(row, cache);
    candidate.ranks.graph = index + 1;
    return candidate;
  });
}

export { CANDIDATES_PER_CHANNEL };
