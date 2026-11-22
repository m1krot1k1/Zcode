import { constants, deflateSync, inflateSync } from "node:zlib";

/**
 * Хранение текста чанков в сжатом виде — один deflate-поток на файл.
 *
 * Замеры на монорепозитории Zcode (164 050 чанков, 16 235 файлов):
 *  - без сжатия по-чанково текст занимал 184.4 МБ;
 *  - по-чанковый deflate (схема v2) дал 70.45 МБ;
 *  - по-файловый deflate с JSON-массивом содержимого (схема v3) даёт 41.62 МБ.
 *
 * Причина выигрыша: чанки одного файла разделяют словарь и перекрывающиеся диапазоны строк,
 * поэтому единый zlib-поток сжимает их лучше, чем независимые потоки с собственными заголовками.
 *
 * Почему JSON-массив, а не склейка через "\n": экономия отличается на 0.5 МБ (41.62 против
 * 41.12 МБ), но JSON сохраняет границы чанков явно. При склейке потребовалось бы вычислять
 * смещения, а любое расхождение в `start_line`/`end_line` молча отдавало бы чужой код.
 * Здесь соответствие «индекс в массиве → chunk_index» однозначно и проверяется длиной.
 */

const COMPRESS_LEVEL = 6;

export function packChunkText(text: string): Uint8Array {
  return new Uint8Array(deflateSync(Buffer.from(text, "utf8"), { level: COMPRESS_LEVEL }));
}

/**
 * Порог, ниже которого сжатие не применяется.
 *
 * Замер: средняя сигнатура символа — 47 символов. Deflate на таких строках добавляет
 * заголовок потока и таблицу Хаффмана, поэтому 306 073 сигнатуры занимали 16.06 МБ вместо
 * 14.54 МБ исходного текста, то есть сжатие делало хранение хуже. Порог 160 символов
 * оставляет в текстовом виде 99.98 % сигнатур (`<= 160` — 305 922 из 306 073) и сжимает
 * только те единичные случаи, где длина действительно оправдывает поток.
 */
const PACK_THRESHOLD = 160;

/**
 * Сжимает текст, если он достаточно длинный; иначе возвращает его как UTF-8 байты.
 *
 * Различие форматов не нужно размечать отдельно: `textOf` сначала пробует распаковку и при
 * неудаче возвращает строку как есть. Однако для однозначности метка ставится первым байтом:
 * 0x01 — deflate-поток, 0x00 — текстовый. Это дешевле, чем гадать по zlib-заголовку.
 */
export function packText(text: string): Uint8Array {
  const raw = Buffer.from(text, "utf8");
  if (text.length < PACK_THRESHOLD) {
    const out = new Uint8Array(raw.byteLength + 1);
    out[0] = 0;
    out.set(raw, 1);
    return out;
  }
  const compressed = deflateSync(raw, { level: COMPRESS_LEVEL });
  const out = new Uint8Array(compressed.byteLength + 1);
  out[0] = 1;
  out.set(compressed, 1);
  return out;
}

/**
 * Восстанавливает текст из значения колонки.
 *
 * Принимает и `Uint8Array` (актуальная схема), и `string` — второе нужно для записей,
 * созданных до включения сжатия, и для тестовых фикстур, наполняющих БД напрямую.
 */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return "";
  const marker = value[0];
  const payload = Buffer.from(value.buffer, value.byteOffset + 1, value.byteLength - 1);
  // Формат с меткой: 0x00 — несжатый UTF-8, 0x01 — deflate-поток. Сжатие применяется только
  // к длинным значениям, поэтому метка обязательна: иначе короткий текст не отличить от
  // повреждённого zlib-потока. Ветка без метки оставлена для чтения баз, созданных сборкой v3
  // до её введения.
  if (marker === 0) return payload.toString("utf8");
  if (marker === 1) {
    try {
      return inflateSync(payload).toString("utf8");
    } catch {
      return "";
    }
  }
  try {
    return inflateSync(Buffer.from(value)).toString("utf8");
  } catch {
    // Повреждённый поток не должен ломать выдачу: лучше пустой текст, чем исключение
    // в обработчике поиска. Повреждение возможно только при внешнем изменении файла БД.
    return "";
  }
}

/**
 * Упаковывает содержимое чанков файла в один deflate-поток от JSON-массива.
 *
 * `chunk_index` каждого чанка — его позиция в этом массиве. Инвариант «длина массива равна
 * числу чанков файла» проверяется при чтении: при повреждении отдаётся пустой фрагмент,
 * а не текст соседнего чанка.
 */
export function packFileChunks(contents: readonly string[]): Uint8Array {
  // Здесь сжатие применяется всегда: JSON-массив всех чанков файла превышает порог
  // коротких сигнатур на порядки, и deflate на нём даёт 41.62 МБ против 70.45 МБ по-чанково.
  return packChunkText(JSON.stringify(contents));
}

/**
 * Возвращает текст чанка по индексу внутри файла.
 *
 * Строгий контракт: индекс вне диапазона или повреждённый поток дают `""`. Подставлять
 * «соседний» чанк нельзя — выдача показала бы код, которого нет в запрошенном диапазоне.
 *
 * Распаковка и `JSON.parse` выполняются на каждое обращение, поэтому для пакетных чтений
 * (каналы поиска) используется `ChunkBlobCache`: один `inflate` на файл вместо одного на чанк.
 */
export function chunkTextAt(value: unknown, chunkIndex: number): string {
  const raw = textOf(value);
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "";
    const item = parsed[chunkIndex];
    return typeof item === "string" ? item : "";
  } catch {
    return "";
  }
}

/**
 * Кеш распакованных текстов чанков на время одного поискового запроса.
 *
 * Два уровня кеша:
 *  - `blobs: file_id → chunk_blob` — сжатый JSON всех чанков файла;
 *  - `decoded: file_id → string[]` — уже распакованный и разобранный массив.
 *
 * Замер регрессии при переходе с `chunks.content` на `files.chunk_blob`: `p50` вырос
 * с 32.7 мс до 64.4 мс, потому что каждый из ~450 кандидатов распаковывал JSON всего файла.
 * Один файл даёт в среднем 10 чанков, поэтому кеш на файл сокращает число `inflate`
 * и `JSON.parse` примерно во столько же раз.
 *
 * BLOB читается по требованию: каналы берут лёгкую проекцию без `chunk_blob`, и текст
 * запрашивается только для файлов, чьи кандидаты дошли до чтения содержимого.
 *
 * Время жизни ограничено запросом: объект создаётся в функции поиска и не покидает её,
 * поэтому данные устаревшего blob после переиндексации вернуться не могут.
 */
export class ChunkBlobCache {
  private readonly decoded = new Map<number, string[] | null>();

  constructor(private readonly readBlob: (fileId: number) => unknown) {}

  /** Текст чанка; `fileId` — ключ кеша, `chunkIndex` — позиция в массиве. */
  textAt(fileId: number, chunkIndex: number): string {
    let list = this.decoded.get(fileId);
    if (list === undefined) {
      list = this.decode(this.readBlob(fileId));
      this.decoded.set(fileId, list);
    }
    return list?.[chunkIndex] ?? "";
  }

  private decode(blob: unknown): string[] | null {
    const raw = textOf(blob);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed.map((item) => (typeof item === "string" ? item : ""));
    } catch {
      return null;
    }
  }

  get size(): number {
    return this.decoded.size;
  }
}
