import type { CodeIndexStatus, CodeSearchResult } from "./contract.js";

/**
 * Преобразование ответов воркера в опубликованный контракт.
 *
 * Держится отдельно от сервиса, чтобы сериализуемые границы были явными: воркер возвращает
 * plain-данные, а контракт требует ограниченных размеров (`excerpt <= 4096`, `score ∈ [0,1]`,
 * `diagnostics <= 12`). Никакой побайтовой обрезки ответа здесь нет.
 */

const MAX_EXCERPT_CHARS = 4096;
const MAX_DIAGNOSTICS = 12;

export interface WorkerRunSummary {
  generation?: number;
  files?: number;
  chunks?: number;
  symbols?: number;
  edges?: number;
  indexedFiles?: number;
  skipped?: number;
  textFallbackFiles?: number;
  truncated?: boolean;
  cancelled?: boolean;
  durationMs?: number;
  diagnostics?: string[];
}

export interface WorkerStatusPayload {
  state?: string;
  generation?: number;
  updatedAt?: number;
  counts?: { files?: number; chunks?: number; symbols?: number; edges?: number };
  schemaVersion?: number;
  /** Неполнота индекса из `meta.index_partial` (пропущенные/секретные файлы, лимит). */
  partial?: boolean;
  /** Фаза эмбеддингов, сохранённая воркером (`not-configured` | `ready` | `failed`). */
  embeddingPhase?: string;
  embeddingErrorCode?: string;
  embeddingErrorStatus?: string;
  migratedFromV1?: boolean;
  legacySizeBytes?: number;
  databaseBytes?: number;
  diagnostics?: string[];
  run?: WorkerRunSummary;
}

export interface WorkerSearchPayload {
  spans?: Array<{
    path: string;
    startLine: number;
    endLine: number;
    symbolName?: string;
    scopeHeader?: string;
    excerpt: string;
    excerptTruncated?: boolean;
    signatureOnly?: boolean;
    match?: string;
    score: number;
  }>;
  channels?: { fts: boolean; exact: boolean; vector: boolean; graph: boolean };
  candidateCount?: number;
  mergedSpans?: number;
  dropped?: number;
  collapsed?: number;
  usedTokens?: number;
  budgetTokens?: number;
  truncated?: boolean;
}

function normaliseState(value: string | undefined): CodeIndexStatus["state"] {
  if (value === "ready" || value === "indexing" || value === "degraded" || value === "unindexed")
    return value;
  // Контракт использует `degraded` для «индекс есть, но неполный/упавший».
  return value === "error" ? "degraded" : "unindexed";
}

export function diagnosticsOf(payload: WorkerStatusPayload | undefined): string[] {
  const list = payload?.diagnostics ?? payload?.run?.diagnostics ?? [];
  return list
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item.slice(0, 256))
    .slice(0, MAX_DIAGNOSTICS);
}

export function statusFromWorker(
  payload: WorkerStatusPayload,
  embedding: CodeIndexStatus["embedding"],
  extraDiagnostics: readonly string[] = [],
  progress?: { discoveredFiles: number; indexedFiles: number },
): CodeIndexStatus {
  const diagnostics = [...new Set([...diagnosticsOf(payload), ...extraDiagnostics])].slice(
    0,
    MAX_DIAGNOSTICS,
  );
  // Активный проход важнее сохранённого состояния: статус обязан показывать реальную работу,
  // иначе UI видит `unindexed`, пока индекс уже строится в фоне.
  const state = progress ? "indexing" : normaliseState(payload.state);
  return {
    state,
    partial: state === "degraded" || payload.partial === true || payload.run?.truncated === true,
    generation: Number(payload.generation ?? 0),
    ...(payload.updatedAt ? { updatedAt: Number(payload.updatedAt) } : {}),
    counts: {
      files: Number(payload.counts?.files ?? payload.run?.files ?? 0),
      chunks: Number(payload.counts?.chunks ?? payload.run?.chunks ?? 0),
      symbols: Number(payload.counts?.symbols ?? payload.run?.symbols ?? 0),
      edges: Number(payload.counts?.edges ?? payload.run?.edges ?? 0),
    },
    ...(progress ? { progress } : {}),
    ...(payload.databaseBytes ? { databaseBytes: Number(payload.databaseBytes) } : {}),
    ...(payload.schemaVersion ? { schemaVersion: Number(payload.schemaVersion) } : {}),
    ...(payload.migratedFromV1 !== undefined ? { migratedFromV1: payload.migratedFromV1 } : {}),
    ...(payload.legacySizeBytes ? { legacySizeBytes: Number(payload.legacySizeBytes) } : {}),
    ...(payload.run?.textFallbackFiles !== undefined
      ? { textFallbackFiles: Number(payload.run.textFallbackFiles) }
      : {}),
    embedding,
    diagnostics,
  };
}

export interface MappedSearch {
  results: CodeSearchResult[];
  semantic: boolean;
  partial: boolean;
  /** Метрики паковщика — пробрасываются в инструмент, но не в публичный контракт. */
  metrics: {
    usedTokens: number;
    budgetTokens: number;
    dropped: number;
    collapsed: number;
    candidateCount: number;
    truncated: boolean;
    channels: WorkerSearchPayload["channels"];
  };
}

function matchKindOf(value: string | undefined): CodeSearchResult["match"] {
  return value === "semantic" ? "semantic" : "lexical";
}

export function searchFromWorker(payload: WorkerSearchPayload, indexPartial = false): MappedSearch {
  const spans = payload.spans ?? [];
  const maxScore = spans.reduce((max, span) => Math.max(max, span.score), 0);
  const results: CodeSearchResult[] = spans.map((span) => {
    const cleaned = span.excerpt.replace(/\p{Cc}/gu, " ");
    const truncated = span.excerptTruncated === true || cleaned.length > MAX_EXCERPT_CHARS;
    return {
      path: span.path,
      startLine: Math.max(1, span.startLine),
      endLine: Math.max(span.startLine, span.endLine),
      ...(span.symbolName ? { symbolName: span.symbolName } : {}),
      ...(span.symbolName ? { symbolKind: "symbol" } : {}),
      excerpt: truncated ? cleaned.slice(0, MAX_EXCERPT_CHARS) : cleaned,
      ...(truncated ? { excerptTruncated: true } : {}),
      match: matchKindOf(span.match),
      // RRF-скор нормируется по лучшему попаданию: контракт требует [0, 1].
      score: maxScore > 0 ? Math.min(1, Math.max(0, span.score / maxScore)) : 0,
    };
  });
  return {
    results,
    semantic: payload.channels?.vector === true,
    // `partial` в контракте означает неполноту индекса, а не урезание бюджета.
    // Урезание бюджета отдаётся отдельной метрикой, чтобы UI не путал эти состояния.
    partial: indexPartial,
    metrics: {
      usedTokens: Number(payload.usedTokens ?? 0),
      budgetTokens: Number(payload.budgetTokens ?? 0),
      dropped: Number(payload.dropped ?? 0),
      collapsed: Number(payload.collapsed ?? 0),
      candidateCount: Number(payload.candidateCount ?? 0),
      truncated: payload.truncated === true,
      channels: payload.channels,
    },
  };
}
