/**
 * Детерминированный взвешенный PageRank по межфайловому графу.
 *
 * Требования из спецификации и их реализация:
 *  - фиксированное число итераций (`DAMPING = 0.85`, `ITERATIONS = 15`) — результат не зависит
 *    от времени и нагрузки;
 *  - узлы обходятся в отсортированном по id порядке, суммы накапливаются в `Float64Array`,
 *    поэтому одинаковый вход даёт бит-в-бит одинаковый выход;
 *  - рёбра из тестовых файлов (`path_tier >= 2`) учитываются с весом 0.2, чтобы моки,
 *    тысячи раз вызываемые в тестах, не вытесняли ядро архитектуры;
 *  - PageRank нормализуется в [0, 1] по максимуму для предсказуемого буста в ранжировании.
 */

const DAMPING = 0.85;
const ITERATIONS = 15;
const TEST_TIER_WEIGHT = 0.2;
const EPSILON = 1e-9;

export interface PageRankEdge {
  /** `file_id` источника. */
  from: number;
  /** `file_id` цели. */
  to: number;
  weight: number;
}

export interface PageRankResult {
  /** Нормализованный вес по `file_id`. */
  ranks: Map<number, number>;
  iterations: number;
}

export function computeFilePageRank(
  fileIds: readonly number[],
  edges: readonly PageRankEdge[],
  tiersByFile: ReadonlyMap<number, number>,
): PageRankResult {
  const ids = [...new Set(fileIds)].sort((left, right) => left - right);
  const indexOf = new Map<number, number>();
  ids.forEach((id, index) => indexOf.set(id, index));
  const size = ids.length;
  if (size === 0) return { ranks: new Map(), iterations: 0 };

  const outWeight = new Float64Array(size);
  const weighted: Array<{ from: number; to: number; weight: number }> = [];
  for (const edge of edges) {
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const tier = tiersByFile.get(edge.from) ?? 0;
    const weight = tier >= 2 ? edge.weight * TEST_TIER_WEIGHT : edge.weight;
    if (weight <= 0) continue;
    weighted.push({ from, to, weight });
    outWeight[from] = (outWeight[from] ?? 0) + weight;
  }
  // Сортировка обеспечивает детерминированный порядок суммирования.
  weighted.sort((left, right) => left.from - right.from || left.to - right.to);

  let ranks = new Float64Array(size).fill(1 / size);
  const damping = DAMPING;
  const teleport = (1 - damping) / size;

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const next = new Float64Array(size);
    const danglingMass = sumDangling(ranks, outWeight);
    const danglingShare = (damping * danglingMass) / size;
    next.fill(teleport + danglingShare);
    for (const edge of weighted) {
      const share = (damping * (ranks[edge.from] ?? 0) * edge.weight) / (outWeight[edge.from] || 1);
      next[edge.to] = (next[edge.to] ?? 0) + share;
    }
    let delta = 0;
    for (let index = 0; index < size; index += 1) {
      delta += Math.abs((next[index] ?? 0) - (ranks[index] ?? 0));
    }
    ranks = next;
    if (delta < EPSILON) {
      return { ranks: normalize(ids, ranks), iterations: iteration + 1 };
    }
  }
  return { ranks: normalize(ids, ranks), iterations: ITERATIONS };
}

function sumDangling(ranks: Float64Array, outWeight: Float64Array): number {
  let mass = 0;
  for (let index = 0; index < ranks.length; index += 1) {
    if ((outWeight[index] ?? 0) <= 0) mass += ranks[index] ?? 0;
  }
  return mass;
}

function normalize(ids: readonly number[], ranks: Float64Array): Map<number, number> {
  let max = 0;
  for (const value of ranks) max = Math.max(max, value);
  const result = new Map<number, number>();
  const scale = max > 0 ? 1 / max : 0;
  ids.forEach((id, index) => {
    result.set(id, Math.min(1, Math.max(0, (ranks[index] ?? 0) * scale)));
  });
  return result;
}

/**
 * Центральность символа: `log1p(in_degree * 2 + out_degree)` в нормализованном виде.
 * Входящие вызовы весят вдвое — «кто меня вызывает» важнее «кого вызываю я».
 */
export function computeSymbolCentrality(
  symbols: readonly { symbolId: number }[],
  edges: readonly { dst: number; src: number; testSource: boolean }[],
): Map<number, number> {
  const inDegree = new Map<number, number>();
  const outDegree = new Map<number, number>();
  for (const edge of edges) {
    const weight = edge.testSource ? TEST_TIER_WEIGHT : 1;
    inDegree.set(edge.dst, (inDegree.get(edge.dst) ?? 0) + weight);
    outDegree.set(edge.src, (outDegree.get(edge.src) ?? 0) + weight);
  }
  const raw = new Map<number, number>();
  let max = 0;
  for (const symbol of symbols) {
    const value = Math.log1p(
      (inDegree.get(symbol.symbolId) ?? 0) * 2 + (outDegree.get(symbol.symbolId) ?? 0),
    );
    raw.set(symbol.symbolId, value);
    max = Math.max(max, value);
  }
  const normalized = new Map<number, number>();
  for (const [id, value] of raw) normalized.set(id, max > 0 ? value / max : 0);
  return normalized;
}
