import { firstRow, type IndexDatabase, type Row } from "../worker/store.js";
import {
  chunksForSymbols,
  searchExact,
  searchFts,
  searchGraphNeighbors,
  searchLocalVector,
  SKETCH_KIND,
  type Candidate,
} from "./searchChannels.js";
import {
  mergeAdjacentSpans,
  diversifyByFile,
  rerankCandidates,
  type MergedSpan,
} from "./rrfReranker.js";
import {
  DEFAULT_MAX_TOKENS,
  enforceByteLimit,
  MAX_RESULT_JSON_BYTES,
  packSpans,
  type PackResult,
} from "./tokenBudgetPacker.js";
import { embedQuery, providerPlanOf } from "../worker/providerVectors.js";

/**
 * Гибридный поиск: каналы → RRF → структурные множители → слияние диапазонов → бюджет.
 * Возвращает уже упакованную, гарантированно валидную структуру (JSON сериализуется
 * потребителем и никогда не режется побайтово).
 *
 * Векторный канал работает в двух режимах: локальный скетч (всегда) и проекция вектора
 * провайдера (когда провайдер сконфигурирован и передан API-ключ). Сетевой вызов запроса
 * делается только при наличии обоих условий, поэтому офлайн-поведение не меняется.
 */

export interface HybridSearchParams {
  query: string;
  limit?: number;
  maxTokens?: number;
  lexicalOnly?: boolean;
  activeFiles?: readonly string[];
  changedFiles?: readonly string[];
  /** Секрет провайдера на время запроса; не сохраняется. */
  embeddingApiKey?: string;
  embeddingFetch?: typeof fetch;
}

export interface HybridSearchOutcome extends PackResult {
  /** Какие каналы реально дали кандидатов — используется статусом/диагностикой. */
  channels: { fts: boolean; exact: boolean; vector: boolean; graph: boolean };
  /** Общее число кандидатов до упаковки; помогает отличить «нет результата» от «не влезло». */
  candidateCount: number;
  mergedSpans: number;
  /** Кандидаты, которые прошли RRF, но были свёрнуты/отброшены бюджетом. */
  budgetTruncated: boolean;
}

function mergeCandidates(lists: readonly Candidate[][]): Candidate[] {
  const byChunk = new Map<number, Candidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const existing = byChunk.get(candidate.chunkId);
      if (!existing) {
        byChunk.set(candidate.chunkId, candidate);
        continue;
      }
      existing.ranks = {
        ...existing.ranks,
        ...(candidate.ranks.exact !== undefined && existing.ranks.exact === undefined
          ? { exact: candidate.ranks.exact }
          : {}),
        ...(candidate.ranks.fts !== undefined && existing.ranks.fts === undefined
          ? { fts: candidate.ranks.fts }
          : {}),
        ...(candidate.ranks.vector !== undefined && existing.ranks.vector === undefined
          ? { vector: candidate.ranks.vector }
          : {}),
        ...(candidate.ranks.graph !== undefined && existing.ranks.graph === undefined
          ? { graph: candidate.ranks.graph }
          : {}),
      };
    }
  }
  return [...byChunk.values()];
}

export async function hybridSearch(
  db: IndexDatabase,
  params: HybridSearchParams,
): Promise<HybridSearchOutcome> {
  const query = params.query.trim();
  const empty: HybridSearchOutcome = {
    spans: [],
    dropped: 0,
    collapsed: 0,
    usedTokens: 0,
    budgetTokens: Math.max(1, params.maxTokens ?? DEFAULT_MAX_TOKENS),
    truncated: false,
    channels: { fts: false, exact: false, vector: false, graph: false },
    candidateCount: 0,
    mergedSpans: 0,
    budgetTruncated: false,
  };
  if (!query) return empty;

  const exactHits = searchExact(db, query);
  const exactChunks = chunksForSymbols(
    db,
    exactHits.map((hit) => hit.symbolId),
    Math.max(20, exactHits.length * 2),
  );
  for (let index = 0; index < exactChunks.length; index += 1) {
    exactChunks[index]!.ranks.exact = index + 1;
  }

  const fts = searchFts(db, query);
  const vector = params.lexicalOnly ? [] : searchLocalVector(db, query);
  // Провайдерский канал включается только по явной конфигурации и при переданном ключе:
  // по умолчанию поиск не ходит в сеть.
  let providerVector: Candidate[] = [];
  if (!params.lexicalOnly) {
    const plan = providerPlanOf(db, params.embeddingApiKey, params.embeddingFetch);
    if (plan) {
      const querySketch = await embedQuery(plan, query).catch(() => null);
      const hasVectors = querySketch
        ? firstRow<Row>(
            db,
            "SELECT 1 AS present FROM chunk_vectors WHERE provider_sketch_q4 IS NOT NULL LIMIT 1",
          )
        : undefined;
      if (querySketch && hasVectors) {
        providerVector = searchLocalVector(db, query, { querySketch }, SKETCH_KIND.provider);
      }
    }
  }
  const graph = searchGraphNeighbors(
    db,
    exactHits.slice(0, 5).map((hit) => hit.symbolId),
  );

  const merged = mergeCandidates([exactChunks, fts, vector, providerVector, graph]);
  const ranked = rerankCandidates(merged, {
    query,
    ...(params.activeFiles ? { activeFiles: params.activeFiles } : {}),
    ...(params.changedFiles ? { changedFiles: params.changedFiles } : {}),
  });

  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Упаковываем с запасом: слияние диапазонов может изменить состав, но не добавить текст.
  const mergedSpans: MergedSpan[] = mergeAdjacentSpans(ranked);
  // Диверсификация по файлам: один крупный файл не должен занимать весь топ выдачи,
  // иначе `Recall@4` падает при том, что нужный файл есть в топ-12.
  const spans: MergedSpan[] = diversifyByFile(mergedSpans);
  const limitedSpanCount = params.limit !== undefined ? Math.max(1, params.limit) : undefined;
  const packInput =
    limitedSpanCount !== undefined && spans.length > limitedSpanCount * 3
      ? spans.slice(0, limitedSpanCount * 3)
      : spans;
  const packed = enforceByteLimit(
    packSpans(packInput, maxTokens, limitedSpanCount ?? 50),
    MAX_RESULT_JSON_BYTES,
  );
  const spansOut =
    limitedSpanCount !== undefined && packed.spans.length > limitedSpanCount
      ? packed.spans.slice(0, limitedSpanCount)
      : packed.spans;

  return {
    ...packed,
    spans: spansOut,
    budgetTokens: Math.max(1, maxTokens),
    truncated: packed.truncated || spansOut.length < packed.spans.length,
    dropped: packed.dropped + (packed.spans.length - spansOut.length) + packed.byteDropped,
    channels: {
      fts: fts.length > 0,
      exact: exactChunks.length > 0,
      vector: vector.length > 0 || providerVector.length > 0,
      graph: graph.length > 0,
    },
    candidateCount: merged.length,
    mergedSpans: spans.length,
    budgetTruncated: packed.truncated,
  };
}
