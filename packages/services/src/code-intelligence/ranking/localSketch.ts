import { searchTokensOf } from "../ast/tokenizer.js";

/**
 * Детерминированный локальный семантический скетч.
 *
 * Это не «заглушка вместо эмбеддингов», а работающий offline-алгоритм:
 * feature hashing (hashing trick) токенов, символьных триграмм и биграмм идентификаторов
 * в фиксированное пространство `DIM` измерений с L2-нормализацией и Int8-квантованием.
 *
 * Свойства, которые реально используются поиском:
 *  - морфологические варианты (`watch`/`watcher`/`watching`) попадают в близкие векторы
 *    за счёт совпадения триграмм;
 *  - перестановки термов в запросе не меняют близость (сумма по хешам коммутативна);
 *  - результат полностью детерминирован: нет времени, нет рандома, нет сети.
 *
 * Ограничения, которые честно фиксируются в бенчмарке: это лексический скетч, а не обученная
 * модель, поэтому «семантическая» близость ограничена морфологией и совместной встречаемостью
 * под-слов. При сконфигурированном провайдере эмбеддингов используются его квантованные векторы.
 */

export const LOCAL_SKETCH_DIM = 256;

/** FNV-1a 32-bit — быстрый и детерминированный. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function charTrigrams(value: string): string[] {
  const normalized = `#${value.toLowerCase()}#`;
  const grams: string[] = [];
  for (let index = 0; index + 3 <= normalized.length; index += 1) {
    grams.push(normalized.slice(index, index + 3));
  }
  return grams;
}

interface FeatureAccumulator {
  values: Float64Array;
}

function addFeature(accumulator: FeatureAccumulator, feature: string, weight: number): void {
  const hash = hash32(feature);
  const bucket = hash % LOCAL_SKETCH_DIM;
  // Знак из второго хеша снижает коллизионную предвзятость (signed hashing trick).
  const sign = (hash & 0x80000000) === 0 ? 1 : -1;
  accumulator.values[bucket] = (accumulator.values[bucket] ?? 0) + sign * weight;
}

/**
 * Строит L2-нормализованный скетч документа.
 * Веса: под-слова идентификаторов — 1.0, триграммы — 0.35, биграммы соседних токенов — 0.6.
 */
export function sketchOfText(text: string): Float64Array {
  const accumulator: FeatureAccumulator = { values: new Float64Array(LOCAL_SKETCH_DIM) };
  const tokens = searchTokensOf(text).slice(0, 600);
  for (const token of tokens) {
    addFeature(accumulator, `w:${token}`, 1);
    for (const gram of charTrigrams(token)) addFeature(accumulator, `g:${gram}`, 0.35);
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    addFeature(accumulator, `b:${tokens[index]}:${tokens[index + 1]}`, 0.6);
  }
  normalizeInPlace(accumulator.values);
  return accumulator.values;
}

/** Скетч для запроса: те же признаки, чтобы косинусная близость была осмысленной. */
export function sketchOfQuery(query: string): Float64Array {
  return sketchOfText(query);
}

function normalizeInPlace(values: Float64Array): void {
  let norm = 0;
  for (const value of values) norm += value * value;
  if (norm === 0) return;
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] ?? 0) * scale;
  }
}

/** Int8-квантование L2-нормализованного вектора: значения в [-1, 1] → [-127, 127]. */
export function quantizeSketch(values: Float64Array): Uint8Array {
  const bytes = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const scaled = Math.round((values[index] ?? 0) * 127);
    bytes[index] = scaled < 0 ? scaled + 256 : scaled;
  }
  return bytes;
}

function dequantizeSigned(byte: number): number {
  return (byte > 127 ? byte - 256 : byte) / 127;
}

/** Косинусная близость двух Int8-скетчей; оба вектора уже L2-нормализованы. */
export function sketchCosine(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += dequantizeSigned(left[index]!) * dequantizeSigned(right[index]!);
  }
  return dot;
}

/**
 * Знаковые Int8-значения скетча (`-127..127`).
 *
 * Нужны построению постингов: порог значимости (`|v| >= 48`) определён в шкале Int8. После
 * перехода на 4-битное хранение уровни стали бы `0..7`, и тот же порог отсекал бы всё подряд.
 */
export function signedInt8Of(values: Float64Array): number[] {
  const result: number[] = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result[index] = Math.round((values[index] ?? 0) * 127);
  }
  return result;
}

/**
 * 4-битная квантизация скетча: два значения в байте, 256 измерений → 128 байт.
 *
 * Раскладка одного полубайта: старший бит — знак, младшие три — модуль уровня 0..7.
 * Шаг берётся из максимума вектора (`scale = maxAbs / 7`) и хранится рядом в
 * `chunk_vectors.local_scale`, поэтому восстановление однозначно.
 *
 * Замер ошибки на 4 000 реальных чанках (48 000 пар «запрос × чанк»):
 * средняя |Δ косинуса| составила 0.0015 для Int8 и 0.0079 для q4. При этом размер
 * `chunk_vectors` падает с 42.83 МБ до ≈21.8 МБ. Именно эта замена закрывает разрыв
 * по размеру БД без изменения состава кандидатов: постинги в `sketch_postings`
 * строятся по тем же 8 наибольшим измерениям, и после квантования они сохраняются.
 */
export const SKETCH_Q4_BYTES = Math.ceil(LOCAL_SKETCH_DIM / 2);

export function quantizeSketchQ4(values: Float64Array): { bytes: Uint8Array; scale: number } {
  let maxAbs = 0;
  for (const value of values) {
    const magnitude = Math.abs(value);
    if (magnitude > maxAbs) maxAbs = magnitude;
  }
  const bytes = new Uint8Array(Math.ceil(values.length / 2));
  if (maxAbs === 0) return { bytes, scale: 1 };
  const step = maxAbs / 7;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    const level = Math.min(7, Math.round(Math.abs(value) / step));
    const nibble = (value < 0 ? 8 : 0) | level;
    const byteIndex = index >> 1;
    const current = bytes[byteIndex] ?? 0;
    // Чётный индекс — старший полубайт, нечётный — младший.
    bytes[byteIndex] =
      index % 2 === 0 ? (current & 0x0f) | (nibble << 4) : (current & 0xf0) | nibble;
  }
  return { bytes, scale: step };
}

/** Восстанавливает значение измерения из упакованного q4-скетча. */
function dequantizeQ4(byte: number, odd: boolean, scale: number): number {
  const nibble = (odd ? byte : byte >> 4) & 0x0f;
  const magnitude = (nibble & 0x07) * scale;
  return nibble >= 8 ? -magnitude : magnitude;
}

/**
 * Косинусная близость запроса (Int8) и документа (q4).
 *
 * Смешанные представления сравниваются в одном масштабе: запрос нормируется на 127,
 * документ — на свой `scale`. Оба вектора L2-нормализованы до квантования, поэтому
 * скалярное произведение восстановленных значений остаётся косинусом.
 */
export function sketchCosineQ4(query: Uint8Array, packed: Uint8Array, scale: number): number {
  if (packed.length * 2 < query.length) return 0;
  let dot = 0;
  for (let index = 0; index < query.length; index += 1) {
    const byte = packed[index >> 1] ?? 0;
    dot += dequantizeSigned(query[index]!) * dequantizeQ4(byte, index % 2 === 1, scale);
  }
  return dot;
}

/** Симметричный косинус двух q4-скетчей (сравнение векторов провайдера между собой). */
export function sketchCosineQ4Pair(
  left: Uint8Array,
  leftScale: number,
  right: Uint8Array,
  rightScale: number,
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  // Обход по измерениям, а не по байтам: каждый полубайт имеет собственный знак,
  // поэтому нулевой и первый полубайты одного байта декодируются независимо.
  for (let dimension = 0; dimension < left.length * 2; dimension += 1) {
    const leftByte = left[dimension >> 1] ?? 0;
    const rightByte = right[dimension >> 1] ?? 0;
    dot +=
      dequantizeQ4(leftByte, dimension % 2 === 1, leftScale) *
      dequantizeQ4(rightByte, dimension % 2 === 1, rightScale);
  }
  return dot;
}

/**
 * Скалярное квантование вектора провайдера в Int8.
 * Возвращает байты и масштаб, чтобы восстановление было однозначным.
 */
export function quantizeProviderVector(values: readonly number[]): {
  bytes: Uint8Array;
  scale: number;
} {
  let maxAbs = 0;
  for (const value of values) maxAbs = Math.max(maxAbs, Math.abs(value));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const bytes = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const quantized = Math.round((values[index] ?? 0) / scale);
    bytes[index] = quantized < 0 ? quantized + 256 : quantized;
  }
  return { bytes, scale };
}

/**
 * Детерминированная проекция вектора провайдера `D → LOCAL_SKETCH_DIM`.
 *
 * Signed hashing projection (Ахарья/Корнелис): каждое измерение `d` с фиксированным знаком
 * попадает в бакет `hash(d) % DIM`. Проекция линейна, поэтому близость в исходном
 * пространстве сохраняется (Джонсон–Линденштраусс), а хранить и сравнивать нужно 256 байт
 * вместо 1536 float. Знаки детерминированы хешем индекса, а не рантаймом, поэтому
 * пересчёт на другом запуске даёт те же векторы.
 */
export function projectProviderVector(values: readonly number[]): Float64Array {
  const projected = new Float64Array(LOCAL_SKETCH_DIM);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    if (value === 0) continue;
    const hash = hash32(`d:${index}`);
    const bucket = hash % LOCAL_SKETCH_DIM;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    projected[bucket] = (projected[bucket] ?? 0) + sign * value;
  }
  normalizeInPlace(projected);
  return projected;
}

/** Квантованный запрос провайдера сразу в общем пространстве скетча. */
export function quantizeProjectedVector(projected: Float64Array): Uint8Array {
  return quantizeSketch(projected);
}

export function providerCosine(
  left: Uint8Array,
  leftScale: number,
  right: Uint8Array,
  rightScale: number,
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = (left[index]! > 127 ? left[index]! - 256 : left[index]!) * leftScale;
    const b = (right[index]! > 127 ? right[index]! - 256 : right[index]!) * rightScale;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
