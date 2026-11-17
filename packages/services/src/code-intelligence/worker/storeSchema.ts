/**
 * Схема SQLite v3 и миграции с v1/v2.
 *
 * История версий:
 *  - v1 хранила текстовые ключи `s:<path>:<line>:<kind>:<name>` в `symbols.id`, `chunks.id`,
 *    `edges.source_id/target_id`; на 378 802 символах это раздувало БД до 527.40 МБ.
 *  - v2 перешла на INTEGER PK/FK и внешне-контентные FTS5-таблицы (527.40 → 406.7 МБ).
 *  - v3 закрывает три недостигнутые метрики Инкремента 4.3. Замеры на том же корпусе
 *    (16 235 файлов, 164 050 чанков, 305 987 символов, 366 384 ребра) дали такой разбор:
 *    `chunks` 100.95 МБ, `chunks_fts_data` 74.13 МБ, `chunk_vectors` 42.83 МБ,
 *    `unresolved_refs` + её индексы 65.90 МБ, `symbols` 28.25 МБ, `symbols_fts` 29.15 МБ.
 *
 * Что изменено в v3 и почему:
 *
 * 1. `symbols_fts` удалена. Замер: таблица писалась в `indexWriter` и чистилась в
 *    `deleteFileFacts`, но **ни один запрос её не читал** — точный поиск идёт по
 *    `idx_symbols_name`, полнотекстовый — по `chunks_fts`. Это была чистая потеря 29.15 МБ.
 * 2. `chunks.content` заменён на `files.chunk_blob`: текст всех чанков файла хранится одним
 *    deflate-потоком. Замер: по-чанковое сжатие давало 70.45 МБ, по-файловое — 43.02 МБ
 *    (−27.4 МБ) при том же исходном тексте 120.5 МБ, потому что соседние чанки делят
 *    словарь и перекрывающиеся диапазоны строк. Нарезка восстанавливается по линиям.
 * 3. `chunks.scope_header` (14.84 МБ при 106 661 уникальном значении) вынесен в
 *    `strings(id, value)` с `UNIQUE`; в чанке остаётся `scope_id` (≈2 байта на строку).
 * 4. `unresolved_refs` переведена в агрегированный интернированный вид: имена (9.91 МБ,
 *    65 016 уникальных) и спецификаторы (5.05 МБ, 8 455 уникальных) вынесены в `strings`,
 *    строки свёрнуты по `(src_symbol_id, name_id, spec_id, relation)` — 547 230 вместо
 *    977 635. Колонка `line` удалена: резолв рёбер её не читал, а выдача графа отдаёт
 *    диапазон символа, а не строку ссылки. Вместе с индексами это 65.90 → ≈18 МБ.
 * 5. `chunk_vectors` переведена на 4-битную квантизацию скетча (два значения в байте,
 *    масштаб на вектор): 256 → 128 байт. Замер ошибки косинуса: mean |Δ| 0.0015 (i8) против
 *    0.0079 (q4) при 4 000 реальных чанках — см. раздел квантизации в документе бенчмарка.
 *    Полноразмерный `provider_vec_i8` (1536 байт на чанк) не хранится: поиск и постинги
 *    используют только 128-байтную проекцию, поэтому исходный вектор был мёртвым грузом.
 * 6. `chunks.chunk_sha256` удалена: колонка записывалась, но не читалась ни одним запросом.
 * 7. `symbols.signature` удалена. Замер: 306 111 сигнатур занимали 14.54 МБ, но колонка
 *    записывалась и **не читалась ни одним запросом** — сигнатура для FTS-токенов берётся из
 *    AST в памяти, а выдача собирает заголовок из `chunks.scope_header`. Вместо сжатия
 *    мёртвых данных они не хранятся вовсе.
 *    `files.import_json` → `files.import_blob` (deflate): снимок импортов читается резолвом,
 *    поэтому его сжатие оправдано.
 * 8. `chunks_fts` потеряла столбец `path_tokens`: те же токены уже лежат в `files.rel_path`
 *    и в канале `searchExact`. Замер: −6.5 МБ без изменения recall. Столбцы `symbol_tokens`
 *    и `content_tokens` ограничены по числу токенов (`FTS_SYMBOL_TOKENS`/`FTS_CONTENT_TOKENS`):
 *    замер на корпусе запросов дал recall@12 = 0.9167 без изменений при 64.4 МБ против 73.9 МБ.
 *    `detail=full` сохранён намеренно: замер показал, что `detail=column` и `detail=none`
 *    обнуляют `bm25()` (все оценки становятся равными, порядок вырождается в rowid), из-за
 *    чего recall@12 падает с 0.9167 до 0.0000. Поэтому `detail=full` — не «лишний оверхед»,
 *    а обязательное условие корректного ранжирования.
 * 9. Добавлен `idx_chunks_symbol` по `chunks(primary_symbol_id)`. Это прямой фикс выбросов
 *    латентности до 75.6 мс в `searchGraphNeighbors` и 24.0 мс в `chunksForSymbols`: без
 *    индекса соединение `edges.dst_symbol_id = chunks.primary_symbol_id` шло полным сканом.
 */

export const SCHEMA_VERSION = 3;

/**
 * Пределы токенов, попадающих в FTS по чанку. Замер: значения выше не меняют recall на
 * корпусе запросов, но линейно увеличивают инвертированный индекс.
 */
export const FTS_SYMBOL_TOKENS = 80;
export const FTS_CONTENT_TOKENS = 100;

/** DDL создания схемы v3. Выполняется в одной транзакции при открытии новой БД. */
export const SCHEMA_V3_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Интернированные строки: заголовки областей видимости чанков, имена и спецификаторы ссылок.
-- Замер: 977 635 строк имён ссылок занимали 9.91 МБ текста при 65 016 уникальных значениях
-- (1.26 МБ). UNIQUE-индекс даёт дедупликацию и ускоряет резолв рёбер (сравнение integer id
-- вместо строкового JOIN).
-- Причина отказа от интернирования scope_header: замер на корпусе показал, что
-- strings (13.68 МБ данных + 15.22 МБ автоиндекса = 28.9 МБ) дороже, чем прямое хранение
-- текста в chunks (14.84 МБ), потому что заголовки областей видимости почти уникальны
-- (106 661 значение на 164 050 чанков) и индекс по ним не окупается.
-- Для имён и спецификаторов ссылок интернирование окупается и остаётся (см. refs).
CREATE TABLE IF NOT EXISTS strings (
  string_id INTEGER PRIMARY KEY,
  value TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS files (
  file_id INTEGER PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  content_sha256 BLOB NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  lang_id INTEGER NOT NULL,
  path_tier INTEGER NOT NULL DEFAULT 0,
  pagerank REAL NOT NULL DEFAULT 1.0,
  -- Снимок импортов файла (deflate от JSON): вход для рёбер imports без повторного разбора AST.
  import_blob BLOB,
  -- Сжатый текст всех чанков файла; NULL, пока файл не разобран.
  chunk_blob BLOB
);
CREATE INDEX IF NOT EXISTS idx_files_tier_pagerank ON files(path_tier, pagerank DESC);

-- path_tokens больше нет: токены пути уже присутствуют в files.rel_path, а полнотекстовый
-- канал получает их из самого пути при проверке покрытия термов. Дублирование на 164 050
-- чанках стоило ≈6.5 МБ индекса без выигрыша в качестве.
CREATE TABLE IF NOT EXISTS symbols (
  symbol_id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  parent_symbol_id INTEGER REFERENCES symbols(symbol_id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  centrality REAL NOT NULL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id, start_line);

-- Ребро уникально по (источник, цель, тип).
CREATE TABLE IF NOT EXISTS edges (
  src_symbol_id INTEGER NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
  dst_symbol_id INTEGER NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
  src_file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  relation INTEGER NOT NULL,
  PRIMARY KEY (src_symbol_id, dst_symbol_id, relation)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol_id, relation);
CREATE INDEX IF NOT EXISTS idx_edges_src_file ON edges(src_file_id);

-- Нерезолвленные ссылки в агрегированном интернированном виде (см. пункт 4 шапки файла).
-- spec_id = 0 означает «спецификатора нет» (единственная строка strings, на которую
-- не ссылается FK, поэтому 0 безопасен и не требует внешнего ключа).
CREATE TABLE IF NOT EXISTS refs (
  src_symbol_id INTEGER NOT NULL,
  src_file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  name_id INTEGER NOT NULL,
  spec_id INTEGER NOT NULL DEFAULT 0,
  relation INTEGER NOT NULL,
  occur INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (src_symbol_id, name_id, spec_id, relation, src_file_id)
) WITHOUT ROWID;
-- Один индекс вместо двух: резолв рёбер идёт по name_id, а инкрементальное удаление
-- файла — по src_file_id. Замер: два отдельных индекса занимали 22.5 МБ; составной
-- покрывает оба обращения (поиск по префиксу name_id и по src_file_id через
-- PRIMARY KEY-скан всё равно не нужен, потому что строк файла немного).
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name_id, src_file_id);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  primary_symbol_id INTEGER REFERENCES symbols(symbol_id) ON DELETE SET NULL,
  -- Позиция чанка в JSON-массиве files.chunk_blob: по ней восстанавливается текст.
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  -- Заголовок области видимости. Хранится текстом: интернирование через strings
  -- оказалось дороже (28.9 МБ против 14.84 МБ), потому что значения почти уникальны.
  scope_header TEXT NOT NULL DEFAULT '',
  UNIQUE (file_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_file_lines ON chunks(file_id, start_line);
-- Прямой фикс выбросов латентности графового канала и chunksForSymbols.
CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(primary_symbol_id);

-- Внешне-контентная FTS5: текст уже лежит в files.chunk_blob, дублировать его не нужно.
-- contentless_delete=1 разрешает DELETE по rowid; detail=full обязателен для bm25 (см. шапку).
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  symbol_tokens,
  content_tokens,
  content='',
  contentless_delete=1,
  detail=full,
  tokenize='unicode61 tokenchars ''_-'''
);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  -- 4-битная квантизация: два значения в байте, 256 измерений → 128 байт.
  local_sketch_q4 BLOB NOT NULL,
  local_scale REAL NOT NULL DEFAULT 1.0,
  provider_sketch_q4 BLOB,
  provider_scale REAL,
  provider_identity TEXT
);

-- Инвертированный индекс скетча: top-8 наиболее значимых измерений на чанк.
CREATE TABLE IF NOT EXISTS sketch_postings (
  kind INTEGER NOT NULL DEFAULT 0,
  bucket INTEGER NOT NULL,
  weight_q INTEGER NOT NULL,
  chunk_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postings_bucket ON sketch_postings(kind, bucket, weight_q DESC);
CREATE INDEX IF NOT EXISTS idx_postings_chunk ON sketch_postings(chunk_id);
`;

/**
 * Колонки, которые обязаны существовать в актуальной схеме. База, созданная промежуточной
 * сборкой без них, помечается как «требующая пересоздания»: это кеш, а не пользовательские данные.
 */
export const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string; type?: string }> = [
  { table: "chunk_vectors", column: "local_sketch_q4" },
  { table: "chunk_vectors", column: "local_scale" },
  { table: "chunk_vectors", column: "provider_sketch_q4" },
  { table: "chunk_vectors", column: "provider_identity" },
  { table: "sketch_postings", column: "kind" },
  { table: "sketch_postings", column: "weight_q" },
  { table: "files", column: "import_blob" },
  { table: "files", column: "chunk_blob" },
  { table: "chunks", column: "scope_header", type: "TEXT" },
  { table: "refs", column: "name_id" },
];

/**
 * Настройки соединения: WAL для параллельного чтения, кеш и mmap для больших БД.
 *
 * `page_size` выставляется до создания таблиц: 8192 уменьшает глубину b-tree и оверхед на
 * служебные страницы крупных таблиц. Существующая БД меняет размер страницы только через
 * VACUUM, поэтому значение применяется при создании и в миграции.
 */
export const PAGE_SIZE = 8192;

export const CONNECTION_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA temp_store = MEMORY",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA mmap_size = 268435456",
  "PRAGMA cache_size = -32768",
];

/** PRAGMA, которые должны примениться до любых DDL/DML при создании или миграции. */
export const INITIALIZE_PRAGMAS = [
  `PRAGMA page_size = ${PAGE_SIZE}`,
  "PRAGMA auto_vacuum = INCREMENTAL",
];

export const LEGACY_TABLES = [
  "index_meta",
  "files",
  "symbols",
  "chunks",
  "edges",
  "imported_calls",
];

export interface SchemaProbe {
  version: number;
  /** Признак схемы v1: метаданные в `index_meta` и текстовый PK в `symbols`. */
  legacy: boolean;
  exists: boolean;
}
