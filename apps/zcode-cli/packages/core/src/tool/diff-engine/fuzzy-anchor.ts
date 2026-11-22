import type { BestMatchDiagnostic } from "./contract.js";

export const FUZZY_ANCHOR_MIN_SIMILARITY = 0.85;
export const FUZZY_ANCHOR_AMBIGUITY_MARGIN = 0.08;
export const FUZZY_ANCHOR_MAX_WINDOW_SLACK = 4;
const DEFAULT_DIAGNOSTIC_CONTEXT_RADIUS = 15;

export interface FuzzyAnchorCandidate {
  readonly startLineIndex: number; // 0-based inclusive
  readonly endLineIndex: number; // 0-based exclusive
  readonly similarity: number;
}

export type FuzzyAnchorSearchResult =
  | {
      readonly status: "matched";
      readonly candidate: FuzzyAnchorCandidate;
      readonly candidateCount: number;
    }
  | {
      readonly status: "ambiguous";
      readonly bestCandidate: FuzzyAnchorCandidate;
      readonly candidateCount: number;
    }
  | {
      readonly status: "not_found";
      readonly bestCandidate?: FuzzyAnchorCandidate;
    };

export function normalizeSmartPunctuationAndSpaces(value: string): string {
  return value
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
}

/**
 * Очищает случайно скопированные моделью префиксы номеров строк из вывода Read / Grep
 * (например, "12: code", "12\tcode", "  12 │ code", "12 | code", "12 → code").
 */
export function stripReadLinePrefixes(text: string): string | null {
  const lines = text.split("\n");
  let strippedAny = false;
  const cleaned: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line === "" && i === lines.length - 1) {
      cleaned.push("");
      continue;
    }
    const match = /^\s*\d+\s*(?:[│|→:]|\t)\s?(.*)$/.exec(line);
    if (!match) {
      return null;
    }
    strippedAny = true;
    cleaned.push(match[1] ?? "");
  }

  return strippedAny ? cleaned.join("\n") : null;
}

/**
 * Оптимизированное расстояние Левенштейна с отсечением общих краёв и ранним порогом maxDistance.
 */
export function levenshteinDistance(
  left: string,
  right: string,
  maxDistance = Number.MAX_SAFE_INTEGER,
): number {
  if (left === right) return 0;

  let start = 0;
  const minLen = Math.min(left.length, right.length);
  while (start < minLen && left.charCodeAt(start) === right.charCodeAt(start)) {
    start += 1;
  }

  let leftEnd = left.length;
  let rightEnd = right.length;
  while (
    leftEnd > start &&
    rightEnd > start &&
    left.charCodeAt(leftEnd - 1) === right.charCodeAt(rightEnd - 1)
  ) {
    leftEnd -= 1;
    rightEnd -= 1;
  }

  const aLen = leftEnd - start;
  const bLen = rightEnd - start;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  if (Math.abs(aLen - bLen) > maxDistance) {
    return maxDistance + 1;
  }

  const shorter = aLen <= bLen ? left.slice(start, leftEnd) : right.slice(start, rightEnd);
  const longer = aLen <= bLen ? right.slice(start, rightEnd) : left.slice(start, leftEnd);
  const sLen = shorter.length;
  const lLen = longer.length;

  const row = new Int32Array(sLen + 1);
  for (let j = 0; j <= sLen; j += 1) {
    row[j] = j;
  }

  for (let i = 1; i <= lLen; i += 1) {
    let prevDiag = row[0]!;
    row[0] = i;
    let rowMin = row[0];
    const lChar = longer.charCodeAt(i - 1);

    for (let j = 1; j <= sLen; j += 1) {
      const temp = row[j]!;
      const cost = lChar === shorter.charCodeAt(j - 1) ? 0 : 1;
      const val = Math.min(temp + 1, row[j - 1]! + 1, prevDiag + cost);
      row[j] = val;
      prevDiag = temp;
      if (val < rowMin) rowMin = val;
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
  }

  return row[sLen] ?? 0;
}

export function computeNormalizedLineSimilarity(actual: string, expected: string): number {
  const normActual = normalizeSmartPunctuationAndSpaces(actual.trim());
  const normExpected = normalizeSmartPunctuationAndSpaces(expected.trim());
  if (normActual === normExpected) return 1;
  const maxLen = Math.max(normActual.length, normExpected.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(normActual, normExpected);
  return Math.max(0, 1 - dist / maxLen);
}

export function computeBlockSimilarity(
  actualLines: readonly string[],
  searchLines: readonly string[],
): number {
  const normActual = actualLines
    .map((line) => normalizeSmartPunctuationAndSpaces(line.trim()))
    .filter((line) => line.length > 0);
  const normSearch = searchLines
    .map((line) => normalizeSmartPunctuationAndSpaces(line.trim()))
    .filter((line) => line.length > 0);

  if (normActual.length === 0 && normSearch.length === 0) return 1;
  if (normActual.length === 0 || normSearch.length === 0) return 0;

  const joinedActual = normActual.join("\n");
  const joinedSearch = normSearch.join("\n");
  if (joinedActual === joinedSearch) return 1;

  const maxLen = Math.max(joinedActual.length, joinedSearch.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistance(joinedActual, joinedSearch, Math.ceil(maxLen * 0.6));
  if (dist > Math.ceil(maxLen * 0.6)) {
    return 0;
  }
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Tier 5: Нечёткий якорный поиск (верхний + нижний непустые якоря + эластичное окно ±slack
 * + порог сходства Левенштейна + защита от неоднозначных дубликатов ambiguity guard).
 */
export function findFuzzyAnchorMatch(params: {
  readonly contentLines: readonly string[];
  readonly searchLines: readonly string[];
  readonly expectedStartLine?: number;
  readonly minSimilarity?: number;
  readonly ambiguityMargin?: number;
  readonly maxWindowSlack?: number;
}): FuzzyAnchorSearchResult {
  const { contentLines, searchLines } = params;
  const nonEmptyIndices: number[] = [];
  for (let i = 0; i < searchLines.length; i += 1) {
    if (searchLines[i]!.trim().length > 0) {
      nonEmptyIndices.push(i);
    }
  }

  // Защита от ложных срабатываний на коротких шаблонах: минимум 2 непустые строки (или >= 3 всего).
  if (searchLines.length < 3 && nonEmptyIndices.length < 2) {
    return { status: "not_found" };
  }
  if (nonEmptyIndices.length === 0 || contentLines.length === 0) {
    return { status: "not_found" };
  }

  const minSimilarity = params.minSimilarity ?? FUZZY_ANCHOR_MIN_SIMILARITY;
  const ambiguityMargin = params.ambiguityMargin ?? FUZZY_ANCHOR_AMBIGUITY_MARGIN;
  const maxSlack = params.maxWindowSlack ?? FUZZY_ANCHOR_MAX_WINDOW_SLACK;

  const firstNonEmptyOffset = nonEmptyIndices[0]!;
  const lastNonEmptyOffset = nonEmptyIndices[nonEmptyIndices.length - 1]!;
  const topAnchor = searchLines[firstNonEmptyOffset]!;
  const bottomAnchor = searchLines[lastNonEmptyOffset]!;
  const expectedSpan = lastNonEmptyOffset - firstNonEmptyOffset + 1;
  const trailingBlankCount = searchLines.length - 1 - lastNonEmptyOffset;

  const rawCandidates: FuzzyAnchorCandidate[] = [];
  let bestOverall: FuzzyAnchorCandidate | undefined;

  for (let startIdx = 0; startIdx < contentLines.length; startIdx += 1) {
    const topSim = computeNormalizedLineSimilarity(contentLines[startIdx]!, topAnchor);
    if (topSim < 0.78) continue;

    const minEndExclusive = Math.max(startIdx + 1, startIdx + expectedSpan - maxSlack);
    const maxEndExclusive = Math.min(
      contentLines.length,
      startIdx + expectedSpan + maxSlack,
    );

    let bestForStart: FuzzyAnchorCandidate | undefined;

    for (let endExclusive = minEndExclusive; endExclusive <= maxEndExclusive; endExclusive += 1) {
      const bottomLine = contentLines[endExclusive - 1]!;
      const bottomSim = computeNormalizedLineSimilarity(bottomLine, bottomAnchor);
      if (bottomSim < 0.78) continue;

      const fullStart = Math.max(0, startIdx - firstNonEmptyOffset);
      const fullEnd = Math.min(contentLines.length, endExclusive + trailingBlankCount);
      const windowSlice = contentLines.slice(fullStart, fullEnd);
      const similarity = computeBlockSimilarity(windowSlice, searchLines);

      const candidate: FuzzyAnchorCandidate = {
        startLineIndex: fullStart,
        endLineIndex: fullEnd,
        similarity,
      };

      if (!bestOverall || candidate.similarity > bestOverall.similarity) {
        bestOverall = candidate;
      }

      if (similarity >= minSimilarity) {
        if (!bestForStart || similarity > bestForStart.similarity) {
          bestForStart = candidate;
        }
      }
    }

    if (bestForStart) {
      rawCandidates.push(bestForStart);
    }
  }

  if (rawCandidates.length === 0) {
    return { status: "not_found", bestCandidate: bestOverall };
  }

  // Дедупликация перекрывающихся окон вокруг одного и того же участка кода
  const distinctCandidates = deduplicateOverlappingCandidates(
    rawCandidates,
    params.expectedStartLine,
  );

  const best = distinctCandidates[0]!;
  if (distinctCandidates.length > 1) {
    const second = distinctCandidates[1]!;
    if (best.similarity - second.similarity < ambiguityMargin) {
      return {
        status: "ambiguous",
        bestCandidate: best,
        candidateCount: distinctCandidates.length,
      };
    }
  }

  return {
    status: "matched",
    candidate: best,
    candidateCount: distinctCandidates.length,
  };
}

export function buildBestMatchDiagnostic(params: {
  readonly contentLines: readonly string[];
  readonly searchText: string;
  readonly reason: string;
  readonly contextRadius?: number;
  readonly hintCandidate?: FuzzyAnchorCandidate;
}): BestMatchDiagnostic {
  const { contentLines } = params;
  const radius = params.contextRadius ?? DEFAULT_DIAGNOSTIC_CONTEXT_RADIUS;

  if (contentLines.length === 0) {
    const formatted = `[BestMatchDiagnostic] File is empty. Reason: ${params.reason}`;
    return {
      similarity: 0,
      startLine: 1,
      endLine: 1,
      snippet: "",
      reason: params.reason,
      formatted,
    };
  }

  const searchLines = splitLogicalSearchLines(params.searchText);
  const candidate =
    params.hintCandidate ?? scanClosestDiagnosticWindow(contentLines, searchLines);

  const matchStartLine = candidate.startLineIndex + 1;
  const matchEndLine = Math.max(matchStartLine, candidate.endLineIndex);

  const snippetStartIdx = Math.max(0, candidate.startLineIndex - radius);
  const snippetEndIdx = Math.min(contentLines.length, candidate.endLineIndex + radius);
  const lineNumberWidth = String(snippetEndIdx).length;

  const snippetLines: string[] = [];
  for (let i = snippetStartIdx; i < snippetEndIdx; i += 1) {
    const lineNo = String(i + 1).padStart(lineNumberWidth, " ");
    const marker = i >= candidate.startLineIndex && i < candidate.endLineIndex ? ">" : " ";
    snippetLines.push(`${marker} ${lineNo} | ${contentLines[i] ?? ""}`);
  }

  const snippet = snippetLines.join("\n");
  const similarityPct = Math.round(candidate.similarity * 100);
  const formatted = [
    `Best match candidate (${similarityPct}% similarity, lines ${matchStartLine}-${matchEndLine}):`,
    `Reason: ${params.reason}`,
    snippet,
  ].join("\n");

  return {
    similarity: Number(candidate.similarity.toFixed(4)),
    startLine: matchStartLine,
    endLine: matchEndLine,
    snippet,
    reason: params.reason,
    formatted,
  };
}

function deduplicateOverlappingCandidates(
  candidates: readonly FuzzyAnchorCandidate[],
  expectedStartLine?: number,
): FuzzyAnchorCandidate[] {
  const expectedZeroBased =
    expectedStartLine !== undefined ? Math.max(0, expectedStartLine - 1) : undefined;

  const sorted = [...candidates].sort((a, b) => {
    if (Math.abs(b.similarity - a.similarity) > 1e-6) {
      return b.similarity - a.similarity;
    }
    if (expectedZeroBased !== undefined) {
      const distA = Math.abs(a.startLineIndex - expectedZeroBased);
      const distB = Math.abs(b.startLineIndex - expectedZeroBased);
      if (distA !== distB) return distA - distB;
    }
    return a.startLineIndex - b.startLineIndex;
  });

  const distinct: FuzzyAnchorCandidate[] = [];
  for (const candidate of sorted) {
    const overlapsExisting = distinct.some(
      (kept) =>
        candidate.startLineIndex < kept.endLineIndex &&
        kept.startLineIndex < candidate.endLineIndex,
    );
    if (!overlapsExisting) {
      distinct.push(candidate);
    }
  }
  return distinct;
}

function scanClosestDiagnosticWindow(
  contentLines: readonly string[],
  searchLines: readonly string[],
): FuzzyAnchorCandidate {
  const nonEmptySearch = searchLines.filter((line) => line.trim().length > 0);
  if (nonEmptySearch.length === 0) {
    return {
      startLineIndex: 0,
      endLineIndex: Math.min(contentLines.length, Math.max(1, searchLines.length)),
      similarity: 0,
    };
  }

  const windowLen = Math.min(contentLines.length, Math.max(1, searchLines.length));
  const anchorLine = nonEmptySearch[0]!;

  // Быстрый пред-отбор топ-12 позиций по сходству первой непустой строки, чтобы не делать O(N^2) на огромных файлах
  const scoredStarts: Array<{ index: number; anchorSim: number }> = [];
  for (let i = 0; i <= contentLines.length - 1; i += 1) {
    const sim = computeNormalizedLineSimilarity(contentLines[i]!, anchorLine);
    if (sim > 0.25 || scoredStarts.length < 8) {
      scoredStarts.push({ index: i, anchorSim: sim });
    }
  }
  scoredStarts.sort((a, b) => b.anchorSim - a.anchorSim);
  const topStarts = scoredStarts.slice(0, 16);

  let best: FuzzyAnchorCandidate = {
    startLineIndex: 0,
    endLineIndex: windowLen,
    similarity: 0,
  };

  for (const entry of topStarts) {
    const endIdx = Math.min(contentLines.length, entry.index + windowLen);
    const slice = contentLines.slice(entry.index, endIdx);
    const sim =
      searchLines.length === 1
        ? computeNormalizedLineSimilarity(slice[0] ?? "", searchLines[0] ?? "")
        : computeBlockSimilarity(slice, searchLines);
    if (sim > best.similarity) {
      best = {
        startLineIndex: entry.index,
        endLineIndex: Math.max(entry.index + 1, endIdx),
        similarity: sim,
      };
    }
  }

  return best;
}

function splitLogicalSearchLines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
