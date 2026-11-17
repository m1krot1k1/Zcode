import type { Candidate } from "./searchChannels.js";

/**
 * Reciprocal Rank Fusion + детерминированные структурные множители.
 *
 * Базовая формула: `RRF(c) = Σ w_m / (60 + rank_m(c))` по каналам fts/exact/vector/graph.
 * Далее скор умножается на:
 *  - `TierPenalty` — де-бустинг шумных директорий (тесты, фикстуры, скиллы, docs), если в
 *    самом запросе нет явного маркера этих категорий;
 *  - `1 + 0.20 * pagerank + 0.15 * centrality` — структурная значимость файла и символа;
 *  - `ProximityBoost` — родство с активными файлами/директориями текущего хода.
 *
 * Все множители — чистые функции от входа: одинаковый запрос и индекс дают одинаковый порядок.
 */

export const RRF_K = 60;

const CHANNEL_WEIGHTS = {
  exact: 1.35,
  fts: 1.15,
  vector: 1.0,
  graph: 0.65,
} as const;

const TIER_PENALTY = [1.0, 0.65, 0.35, 0.2] as const;

/** Маркеры, при которых пользователь явно ищет в шумной директории — пенальти снимается. */
const TIER_INTENT_MARKERS =
  /\b(?:tests?|specs?|e2e|fixtures?|mocks?|skills?|docs?|snapshots?|examples?)\b/iu;

export interface RerankOptions {
  query: string;
  /** Файлы, открытые в редакторе или затронутые текущим ходом. */
  activeFiles?: readonly string[];
  /** Файлы из текущего git diff. */
  changedFiles?: readonly string[];
}

export interface RankedCandidate {
  candidate: Candidate;
  rrf: number;
  score: number;
  /** Множители сохраняются для отладки и для тестов, проверяющих механику пенализации. */
  factors: { tier: number; graph: number; proximity: number };
}

function tierFactor(pathTier: number, query: string): number {
  if (TIER_INTENT_MARKERS.test(query)) return 1;
  return TIER_PENALTY[Math.min(3, Math.max(0, pathTier))] ?? 1;
}

function proximityFactor(
  relPath: string,
  activeFiles: readonly string[] | undefined,
  changedFiles: readonly string[] | undefined,
): number {
  if (!activeFiles?.length && !changedFiles?.length) return 1;
  if (changedFiles?.includes(relPath)) return 1.3;
  if (activeFiles?.includes(relPath)) return 1.3;
  if (activeFiles?.length) {
    const directory = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
    if (directory) {
      for (const active of activeFiles) {
        const activeDirectory = active.includes("/")
          ? active.slice(0, active.lastIndexOf("/"))
          : "";
        if (activeDirectory && activeDirectory === directory) return 1.15;
      }
    }
  }
  return 1;
}

export function rrfScore(candidate: Candidate): number {
  let score = 0;
  if (candidate.ranks.exact !== undefined) {
    score += CHANNEL_WEIGHTS.exact / (RRF_K + candidate.ranks.exact);
  }
  if (candidate.ranks.fts !== undefined) {
    score += CHANNEL_WEIGHTS.fts / (RRF_K + candidate.ranks.fts);
  }
  if (candidate.ranks.vector !== undefined) {
    score += CHANNEL_WEIGHTS.vector / (RRF_K + candidate.ranks.vector);
  }
  if (candidate.ranks.graph !== undefined) {
    score += CHANNEL_WEIGHTS.graph / (RRF_K + candidate.ranks.graph);
  }
  return score;
}

export function rerankCandidates(
  candidates: readonly Candidate[],
  options: RerankOptions,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = candidates.map((candidate) => {
    const rrf = rrfScore(candidate);
    const tier = tierFactor(candidate.pathTier, options.query);
    const centrality = candidate.symbolCentrality ?? 0;
    const graph = 1 + 0.2 * candidate.filePageRank + 0.15 * centrality;
    const proximity = proximityFactor(candidate.relPath, options.activeFiles, options.changedFiles);
    return {
      candidate,
      rrf,
      score: rrf * tier * graph * proximity,
      factors: { tier, graph, proximity },
    };
  });
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.relPath.localeCompare(right.candidate.relPath) ||
      left.candidate.startLine - right.candidate.startLine,
  );
  return ranked;
}

/**
 * Слияние смежных/перекрывающихся диапазонов одного файла (зазор `<= mergeGap` строк).
 * Это устраняет дубли, когда символ и покрывающий его чанк попадают в выдачу оба.
 */
export interface MergedSpan {
  relPath: string;
  startLine: number;
  endLine: number;
  scopeHeader: string;
  content: string;
  score: number;
  pathTier: number;
  symbolName?: string;
  /** Кандидаты, вошедшие в диапазон — нужны для метрик покрытия. */
  members: number;
}

export function mergeAdjacentSpans(
  ranked: readonly RankedCandidate[],
  mergeGap = 5,
  maxCandidates = 80,
): MergedSpan[] {
  // Слияние читает `candidate.content`, а это ленивая распаковка blob-а файла.
  // Ранжированных кандидатов бывает до 450, тогда как в бюджет попадает ~20 спанов.
  // Срез по `ranked` (он уже отсортирован по score) ограничивает распаковку верхушкой.
  const limited = ranked.length > maxCandidates ? ranked.slice(0, maxCandidates) : ranked;
  const byPath = new Map<string, RankedCandidate[]>();
  for (const item of limited) {
    const list = byPath.get(item.candidate.relPath);
    if (list) list.push(item);
    else byPath.set(item.candidate.relPath, [item]);
  }
  const spans: MergedSpan[] = [];
  for (const [relPath, items] of byPath) {
    const sorted = [...items].sort(
      (left, right) => left.candidate.startLine - right.candidate.startLine,
    );
    let current: MergedSpan | undefined;
    for (const item of sorted) {
      const candidate = item.candidate;
      if (
        current &&
        candidate.startLine <= current.endLine + mergeGap + 1 &&
        candidate.endLine >= current.startLine
      ) {
        if (candidate.endLine > current.endLine) {
          // Расширение диапазона: контент склеиваем по строкам без дублей.
          const extra = candidate.content.split("\n");
          const overlap = Math.max(0, current.endLine - candidate.startLine + 1);
          current.content = [current.content, ...extra.slice(overlap)].join("\n");
          current.endLine = candidate.endLine;
        }
        current.score = Math.max(current.score, item.score);
        current.members += 1;
        if (!current.symbolName && candidate.symbolName) current.symbolName = candidate.symbolName;
        continue;
      }
      current = {
        relPath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        scopeHeader: candidate.scopeHeader,
        content: candidate.content,
        score: item.score,
        pathTier: candidate.pathTier,
        ...(candidate.symbolName ? { symbolName: candidate.symbolName } : {}),
        members: 1,
      };
      spans.push(current);
    }
  }
  spans.sort(
    (left, right) =>
      right.score - left.score ||
      left.relPath.localeCompare(right.relPath) ||
      left.startLine - right.startLine,
  );
  return spans;
}

/**
 * Диверсификация по файлам.
 *
 * Замер recall на репозитории: крупные файлы (`codeIntelligenceService.ts`, `searchChannels.ts`)
 * отдавали по 4–5 смежных чанков и занимали весь топ выдачи, вытесняя другие файлы.
 * `Recall@4` из-за этого был 0.75 при корректно найденных файлах в топ-12.
 *
 * Порядок внутри группы сохраняется (спаны уже отсортированы по скору), поэтому результат
 * остаётся детерминированным: сначала файлы, затем дополнительные чанки тех же файлов.
 * Бюджетный паковщик отбрасывает хвост первым, то есть дополнительный контекст уступает
 * место покрытию разных файлов.
 */
export function diversifyByFile(spans: readonly MergedSpan[], maxPerFile = 2): MergedSpan[] {
  const counts = new Map<string, number>();
  const head: MergedSpan[] = [];
  const tail: MergedSpan[] = [];
  for (const span of spans) {
    const used = counts.get(span.relPath) ?? 0;
    if (used < maxPerFile) {
      counts.set(span.relPath, used + 1);
      head.push(span);
      continue;
    }
    tail.push(span);
  }
  return [...head, ...tail];
}
