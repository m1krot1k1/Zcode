// ============================================================
// Diff Engine: tiered matchers for levels 2..5.
// ============================================================

import type {
  DiffMatchTier,
  LegacyMatchStrategy,
  SingleEditOutcome,
} from "./contract.js";
import {
  buildBestMatchDiagnostic,
  findFuzzyAnchorMatch,
  normalizeSmartPunctuationAndSpaces,
  stripReadLinePrefixes,
} from "./fuzzy-anchor.js";
import { computeIndentProfile, reindentReplacementText } from "./reindent.js";
import {
  collectSubstringOffsets,
  filterNonOverlappingSpans,
  lineRangeToSpanCandidate,
  offsetSpanToCandidate,
  preserveCurlyQuotesIfPresent,
  trimTrailingEmptySearchLine,
  unescapeUnicodeCharacters,
  unescapeVisibleCharacters,
  type SpanCandidate,
} from "./span-utils.js";

const BROAD_TIERS = new Set<DiffMatchTier>([
  "line-trimmed",
  "indentation-shifted",
  "fuzzy-block-anchor",
]);

export function matchLogicalCascade(params: {
  readonly logicalContent: string;
  readonly contentLines: readonly string[];
  readonly lineOffsets: readonly number[];
  readonly logicalSearch: string;
  readonly replaceAll: boolean;
  readonly expectedCount: number;
  readonly expectedStartLine?: number;
}):
  | { readonly status: "matched"; readonly tier: DiffMatchTier; readonly spans: SpanCandidate[] }
  | Extract<SingleEditOutcome, { status: "ambiguous" | "not_found" }> {
  const { logicalContent, contentLines, lineOffsets, logicalSearch, replaceAll, expectedCount } = params;

  // Tier 2a: crlf-normalized exact
  const crlfExactOffsets = collectSubstringOffsets(logicalContent, logicalSearch);
  if (crlfExactOffsets.length > 0) {
    const spans = crlfExactOffsets.map((off) =>
      offsetSpanToCandidate(logicalContent, lineOffsets, off, off + logicalSearch.length),
    );
    return finalizeTierCandidates("crlf-normalized", spans, contentLines, logicalSearch, replaceAll, expectedCount);
  }

    // Tier 2b: smart punctuation / quote normalized
  const quoteSpans = collectQuoteNormalizedSpans(logicalContent, lineOffsets, logicalSearch).map(
    (span): SpanCandidate => ({ ...span, legacyStrategy: "quote_normalized" }),
  );
  if (quoteSpans.length > 0) {
    return finalizeTierCandidates("crlf-normalized", quoteSpans, contentLines, logicalSearch, replaceAll, expectedCount);
  }

  // Tier 2c: visible / unicode escape normalized
  const unescapedVisible = unescapeVisibleCharacters(logicalSearch);
  if (unescapedVisible !== logicalSearch) {
    const escOffsets = collectSubstringOffsets(logicalContent, unescapedVisible);
    if (escOffsets.length > 0) {
      const spans = escOffsets.map(
        (off): SpanCandidate => ({
          ...offsetSpanToCandidate(logicalContent, lineOffsets, off, off + unescapedVisible.length),
          unescapeReplacement: true,
          legacyStrategy: "escape_normalized",
        }),
      );
      return finalizeTierCandidates("crlf-normalized", spans, contentLines, logicalSearch, replaceAll, expectedCount);
    }
  }
  const unescapedUnicode = unescapeUnicodeCharacters(logicalSearch);
  if (unescapedUnicode !== logicalSearch) {
    const uniOffsets = collectSubstringOffsets(logicalContent, unescapedUnicode);
    if (uniOffsets.length > 0) {
      const spans = uniOffsets.map(
        (off): SpanCandidate => ({
          ...offsetSpanToCandidate(logicalContent, lineOffsets, off, off + unescapedUnicode.length),
          legacyStrategy: "unicode_escape_normalized",
        }),
      );
      return finalizeTierCandidates("crlf-normalized", spans, contentLines, logicalSearch, replaceAll, expectedCount);
    }
  }

  // Для broad matchers при replaceAll запрещаем короткие однострочные шаблоны (< 12 символов)
  const searchLines = trimTrailingEmptySearchLine(logicalSearch.split("\n"));
  const allowBroadWithReplaceAll =
    !replaceAll || (searchLines.length >= 2 && logicalSearch.trim().length >= 12);

  if (allowBroadWithReplaceAll) {
    // Tier 3a: снятие скопированных префиксов Read ("12: " / "12\t" / "12 | ")
    const strippedPrefixes = stripReadLinePrefixes(logicalSearch);
    if (strippedPrefixes !== null && strippedPrefixes !== logicalSearch) {
      const strippedOffsets = collectSubstringOffsets(logicalContent, strippedPrefixes);
      if (strippedOffsets.length > 0) {
        const spans = strippedOffsets.map(
          (off): SpanCandidate => ({
            ...offsetSpanToCandidate(logicalContent, lineOffsets, off, off + strippedPrefixes.length),
            stripReplacementPrefixes: true,
            legacyStrategy: "line_number_prefix_stripped",
          }),
        );
        return finalizeTierCandidates("line-trimmed", spans, contentLines, logicalSearch, replaceAll, expectedCount);
      }
    }

    const effectiveSearch = strippedPrefixes ?? logicalSearch;
    const effectiveSearchLines = trimTrailingEmptySearchLine(effectiveSearch.split("\n"));

    // Tier 3b: line-trimmed (сначала trimEnd, затем trim + blank-line tolerant)
    const trimEndSpans = withLegacyStrategy(
      "line-trimmed",
      collectLineTrimEndSpans(contentLines, lineOffsets, effectiveSearchLines, strippedPrefixes !== null),
      strippedPrefixes !== null,
    );
    if (trimEndSpans.length > 0) {
      return finalizeTierCandidates("line-trimmed", trimEndSpans, contentLines, logicalSearch, replaceAll, expectedCount);
    }

    // Tier 3c: line-trimmed (полный trim + допуск пустых строк) — строго до Tier 4,
    // чтобы сдвиг отступов не «съедал» более точное совпадение по содержимому.
    const lineTrimSpans = withLegacyStrategy(
      "line-trimmed",
      collectLineTrimSpans(
        contentLines,
        lineOffsets,
        effectiveSearchLines,
        strippedPrefixes !== null,
      ),
      strippedPrefixes !== null,
    );
    if (lineTrimSpans.length > 0) {
      return finalizeTierCandidates("line-trimmed", lineTrimSpans, contentLines, logicalSearch, replaceAll, expectedCount);
    }

    // Tier 4: indentation-shifted (относительный профиль отступов >= 2 непустых строк)
    const indentSpans = withLegacyStrategy(
      "indentation-shifted",
      collectIndentationShiftedSpans(
        contentLines,
        lineOffsets,
        effectiveSearchLines,
        strippedPrefixes !== null,
      ),
      strippedPrefixes !== null,
    );
    if (indentSpans.length > 0) {
      return finalizeTierCandidates("indentation-shifted", indentSpans, contentLines, logicalSearch, replaceAll, expectedCount);
    }

    // Tier 5: fuzzy-block-anchor (Levenshtein >= 0.85 + ambiguity guard margin >= 0.08)
    if (!replaceAll) {
      const fuzzy = findFuzzyAnchorMatch({
        contentLines,
        searchLines: effectiveSearchLines,
        expectedStartLine: params.expectedStartLine,
      });
      if (fuzzy.status === "matched") {
        const span = lineRangeToSpanCandidate(
          contentLines,
          lineOffsets,
          fuzzy.candidate.startLineIndex,
          fuzzy.candidate.endLineIndex,
          { reindentRequired: true, stripReplacementPrefixes: strippedPrefixes !== null },
        );
        return { status: "matched", tier: "fuzzy-block-anchor", spans: [span] };
      }
      if (fuzzy.status === "ambiguous") {
        return {
          status: "ambiguous",
          attemptedTier: "fuzzy-block-anchor",
          candidateCount: fuzzy.candidateCount,
          diagnostic: buildBestMatchDiagnostic({
            contentLines,
            searchText: effectiveSearch,
            reason: `Ambiguous fuzzy anchor match (${fuzzy.candidateCount} similar blocks within confidence margin). Provide more surrounding lines.`,
            hintCandidate: fuzzy.bestCandidate,
          }),
        };
      }
      return {
        status: "not_found",
        diagnostic: buildBestMatchDiagnostic({
          contentLines,
          searchText: effectiveSearch,
          reason: "Pattern did not match any tier (exact, crlf-normalized, line-trimmed, indentation-shifted, fuzzy-block-anchor).",
          hintCandidate: fuzzy.bestCandidate,
        }),
      };
    }
  }

  return {
    status: "not_found",
    diagnostic: buildBestMatchDiagnostic({
      contentLines,
      searchText: logicalSearch,
      reason:
        replaceAll && BROAD_TIERS.has("line-trimmed")
          ? "Exact/normalized match not found (broad fuzzy tiers are disabled for short replaceAll patterns to prevent unintended edits)."
          : "Pattern not found in file.",
    }),
  };
}

export function defaultLegacyStrategy(tier: DiffMatchTier): LegacyMatchStrategy {
  switch (tier) {
    case "exact":
      return "exact";
    case "crlf-normalized":
      return "quote_normalized";
    case "line-trimmed":
      return "line_trimmed";
    case "indentation-shifted":
      return "indentation_flexible";
    case "fuzzy-block-anchor":
      return "block_anchor";
    case "conflict-resolver":
      return "exact";
  }
}

/**
 * Применяет уточнённые legacy-лейблы к уже найденным кандидатам уровней 3/4/5,
 * чтобы `EditOutput.matchStrategy` сохранял прежние имена стратегий.
 */
export function withLegacyStrategy(
  tier: DiffMatchTier,
  spans: SpanCandidate[],
  stripReplacementPrefixes: boolean,
): SpanCandidate[] {
  const legacy: LegacyMatchStrategy = stripReplacementPrefixes
    ? "line_number_prefix_stripped"
    : defaultLegacyStrategy(tier);
  return spans.map((span) => (span.legacyStrategy ? span : { ...span, legacyStrategy: legacy }));
}

export function finalizeTierCandidates(
  tier: DiffMatchTier,
  spans: SpanCandidate[],
  contentLines: readonly string[],
  logicalSearch: string,
  replaceAll: boolean,
  expectedCount: number,
):
  | { readonly status: "matched"; readonly tier: DiffMatchTier; readonly spans: SpanCandidate[] }
  | Extract<SingleEditOutcome, { status: "ambiguous" }> {
  if (replaceAll) {
    // Для replaceAll допускаем замену всех непересекающихся вхождений, если все они идентичны или найдены на точном/нормализованном уровне
    const nonOverlapping = filterNonOverlappingSpans(spans);
    const uniqueMatchedTexts = new Set(nonOverlapping.map((item) => item.matchedText));
    if (BROAD_TIERS.has(tier) && uniqueMatchedTexts.size > 1) {
      return {
        status: "ambiguous",
        attemptedTier: tier,
        candidateCount: nonOverlapping.length,
        diagnostic: buildBestMatchDiagnostic({
          contentLines,
          searchText: logicalSearch,
          reason: `Multiple non-identical blocks (${nonOverlapping.length}) matched at tier '${tier}'.`,
        }),
      };
    }
    return { status: "matched", tier, spans: nonOverlapping };
  }

  if (spans.length !== expectedCount) {
    return {
      status: "ambiguous",
      attemptedTier: tier,
      candidateCount: spans.length,
      diagnostic: buildBestMatchDiagnostic({
        contentLines,
        searchText: logicalSearch,
        reason: `Found ${spans.length} candidate matches at tier '${tier}' (expected ${expectedCount}). Provide more context lines to disambiguate.`,
      }),
    };
  }

  return { status: "matched", tier, spans };
}

export function seekPatchLinesWithTiers(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  eof: boolean,
):
  | {
      readonly status: "matched";
      readonly startIndex: number;
      readonly matchedCount: number;
      readonly tier: DiffMatchTier;
      readonly reindent: boolean;
    }
  | { readonly status: "ambiguous"; readonly candidateCount: number }
  | { readonly status: "not_found" } {
  if (pattern.length === 0) return { status: "not_found" };

  // 1. exact
  const exactIdx = tryFindLineSequence(lines, pattern, startIndex, eof, (a, b) => a === b);
  if (exactIdx !== -1) {
    return { status: "matched", startIndex: exactIdx, matchedCount: pattern.length, tier: "exact", reindent: false };
  }

  // 2. line-trimmed (trimEnd)
  const trimEndIdx = tryFindLineSequence(lines, pattern, startIndex, eof, (a, b) => a.trimEnd() === b.trimEnd());
  if (trimEndIdx !== -1) {
    return { status: "matched", startIndex: trimEndIdx, matchedCount: pattern.length, tier: "line-trimmed", reindent: false };
  }

  // 3. indentation-shifted (относительный профиль отступов + reindent!)
  if (pattern.filter((l) => l.trim().length > 0).length >= 2) {
    const searchStripped = computeIndentProfile(pattern).strippedLines.join("\n");
    for (let idx = startIndex; idx <= lines.length - pattern.length; idx += 1) {
      const slice = lines.slice(idx, idx + pattern.length);
      if (computeIndentProfile(slice).strippedLines.join("\n") === searchStripped) {
        return {
          status: "matched",
          startIndex: idx,
          matchedCount: pattern.length,
          tier: "indentation-shifted",
          reindent: true,
        };
      }
    }
  }

  // 4. line-trimmed + smart punctuation. Замена остаётся как её прислала модель:
  // trim-совпадение не доказывает, что модель ошиблась именно в базовом отступе,
  // поэтому авто-ре-индентация здесь намеренно не применяется (только Tier 4 сохраняет её).
  const normIdx = tryFindLineSequence(
    lines,
    pattern,
    startIndex,
    eof,
    (a, b) =>
      normalizeSmartPunctuationAndSpaces(a.trim()) === normalizeSmartPunctuationAndSpaces(b.trim()),
  );
  if (normIdx !== -1) {
    return {
      status: "matched",
      startIndex: normIdx,
      matchedCount: pattern.length,
      tier: "line-trimmed",
      reindent: false,
    };
  }

  // 5. fuzzy-block-anchor (на срезе от startIndex)
  const subLines = lines.slice(startIndex);
  const fuzzy = findFuzzyAnchorMatch({
    contentLines: subLines,
    searchLines: pattern,
  });
  if (fuzzy.status === "matched") {
    return {
      status: "matched",
      startIndex: startIndex + fuzzy.candidate.startLineIndex,
      matchedCount: fuzzy.candidate.endLineIndex - fuzzy.candidate.startLineIndex,
      tier: "fuzzy-block-anchor",
      reindent: true,
    };
  }
  if (fuzzy.status === "ambiguous") {
    return { status: "ambiguous", candidateCount: fuzzy.candidateCount };
  }

  return { status: "not_found" };
}

export function tryFindLineSequence(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  eof: boolean,
  compare: (actual: string, expected: string) => boolean,
): number {
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex && matchAt(lines, pattern, fromEnd, compare)) {
      return fromEnd;
    }
  }
  for (let idx = startIndex; idx <= lines.length - pattern.length; idx += 1) {
    if (matchAt(lines, pattern, idx, compare)) {
      return idx;
    }
  }
  return -1;
}

export function matchAt(
  lines: readonly string[],
  pattern: readonly string[],
  startIndex: number,
  compare: (actual: string, expected: string) => boolean,
): boolean {
  for (let offset = 0; offset < pattern.length; offset += 1) {
    if (!compare(lines[startIndex + offset] ?? "", pattern[offset] ?? "")) {
      return false;
    }
  }
  return true;
}

export function collectQuoteNormalizedSpans(
  logicalContent: string,
  lineOffsets: readonly number[],
  logicalSearch: string,
): SpanCandidate[] {
  // Нормализация символов 1-к-1 по длине (кавычки и неразрывные пробелы) для точных индексных границ
  const normChar = (v: string) =>
    v
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
      .replace(/\u00A0/g, " ");
  const normContent = normChar(logicalContent);
  const normSearch = normChar(logicalSearch);
  if (normContent === logicalContent && normSearch === logicalSearch) {
    return [];
  }
  return collectSubstringOffsets(normContent, normSearch).map((off) =>
    offsetSpanToCandidate(logicalContent, lineOffsets, off, off + normSearch.length),
  );
}

export function collectLineTrimEndSpans(
  contentLines: readonly string[],
  lineOffsets: readonly number[],
  searchLines: readonly string[],
  stripReplacementPrefixes: boolean,
): SpanCandidate[] {
  const spans = collectLineTrimEndSpansRaw(contentLines, lineOffsets, searchLines, stripReplacementPrefixes);
  if (spans.length > 0 || searchLines.filter((l) => l.trim().length > 0).length < 2) {
    return spans;
  }
  // Эластичность к пропущенным/добавленным пустым строкам при точном содержимом непустых строк.
  const nonEmptyTrimEnd = searchLines.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  return collectBlankTolerantSpans(
    contentLines,
    lineOffsets,
    nonEmptyTrimEnd,
    (block) => {
      const actual = block.map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
      return actual.length === nonEmptyTrimEnd.length && actual.every((line, idx) => line === nonEmptyTrimEnd[idx]);
    },
    { reindentRequired: false, stripReplacementPrefixes },
  );
}

export function collectLineTrimEndSpansRaw(
  contentLines: readonly string[],
  lineOffsets: readonly number[],
  searchLines: readonly string[],
  stripReplacementPrefixes: boolean,
): SpanCandidate[] {
  if (searchLines.length === 0) return [];
  const spans: SpanCandidate[] = [];
  for (let i = 0; i <= contentLines.length - searchLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j += 1) {
      if (contentLines[i + j]!.trimEnd() !== searchLines[j]!.trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      spans.push(
        lineRangeToSpanCandidate(contentLines, lineOffsets, i, i + searchLines.length, {
          stripReplacementPrefixes,
        }),
      );
    }
  }
  return spans;
}

export function collectIndentationShiftedSpans(
  contentLines: readonly string[],
  lineOffsets: readonly number[],
  searchLines: readonly string[],
  stripReplacementPrefixes: boolean,
): SpanCandidate[] {
  const nonEmptyCount = searchLines.filter((l) => l.trim().length > 0).length;
  if (searchLines.length < 2 || nonEmptyCount < 2) return [];

  const searchProfile = computeIndentProfile(searchLines);
  const normalizedSearch = searchProfile.strippedLines.map((l) => l.trimEnd()).join("\n");
  const spans: SpanCandidate[] = [];

  for (let i = 0; i <= contentLines.length - searchLines.length; i += 1) {
    const block = contentLines.slice(i, i + searchLines.length);
    const blockProfile = computeIndentProfile(block);
    const normalizedBlock = blockProfile.strippedLines.map((l) => l.trimEnd()).join("\n");
    if (normalizedBlock === normalizedSearch) {
      spans.push(
        lineRangeToSpanCandidate(contentLines, lineOffsets, i, i + searchLines.length, {
          reindentRequired: true,
          stripReplacementPrefixes,
        }),
      );
    }
  }

  if (spans.length > 0) {
    return spans;
  }

  // Эластичность к пропущенным/лишним пустым строкам при сохранённом профиле отступов
  const nonEmptySearchStripped = searchProfile.strippedLines.filter((l) => l.trim().length > 0);
  return collectBlankTolerantSpans(
    contentLines,
    lineOffsets,
    nonEmptySearchStripped,
    (block) => {
      const prof = computeIndentProfile(block);
      const nonEmptyBlock = prof.strippedLines.filter((l) => l.trim().length > 0);
      return (
        nonEmptyBlock.length === nonEmptySearchStripped.length &&
        nonEmptyBlock.every((line, idx) => line.trimEnd() === nonEmptySearchStripped[idx]!.trimEnd())
      );
    },
    { reindentRequired: true, stripReplacementPrefixes },
  );
}

export function collectLineTrimSpans(
  contentLines: readonly string[],
  lineOffsets: readonly number[],
  searchLines: readonly string[],
  stripReplacementPrefixes: boolean,
): SpanCandidate[] {
  if (searchLines.length === 0) return [];
  const spans: SpanCandidate[] = [];
  for (let i = 0; i <= contentLines.length - searchLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j += 1) {
      if (contentLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      spans.push(
        lineRangeToSpanCandidate(contentLines, lineOffsets, i, i + searchLines.length, {
          // trim-совпадение не доказывает ошибку базового отступа: замена пишется как прислана.
          reindentRequired: false,
          stripReplacementPrefixes,
        }),
      );
    }
  }
  if (spans.length > 0 || searchLines.filter((l) => l.trim().length > 0).length < 2) {
    return spans;
  }

  const nonEmptyTrimmed = searchLines.map((l) => l.trim()).filter((l) => l.length > 0);
  return collectBlankTolerantSpans(
    contentLines,
    lineOffsets,
    nonEmptyTrimmed,
    (block) => {
      const actualNonEmpty = block.map((l) => l.trim()).filter((l) => l.length > 0);
      return (
        actualNonEmpty.length === nonEmptyTrimmed.length &&
        actualNonEmpty.every((line, idx) => line === nonEmptyTrimmed[idx])
      );
    },
    { reindentRequired: false, stripReplacementPrefixes },
  );
}

export function collectBlankTolerantSpans(
  contentLines: readonly string[],
  lineOffsets: readonly number[],
  nonEmptyTargets: readonly string[],
  predicate: (block: readonly string[]) => boolean,
  flags: { reindentRequired: boolean; stripReplacementPrefixes: boolean },
): SpanCandidate[] {
  if (nonEmptyTargets.length < 2) return [];
  const firstTrim = nonEmptyTargets[0]!.trim();
  const spans: SpanCandidate[] = [];

  for (let start = 0; start < contentLines.length; start += 1) {
    if (contentLines[start]!.trim() !== firstTrim) continue;
    let nonEmptySeen = 0;
    let end = start;
    while (end < contentLines.length && nonEmptySeen < nonEmptyTargets.length) {
      if (contentLines[end]!.trim().length > 0) {
        nonEmptySeen += 1;
      }
      end += 1;
      if (end - start > nonEmptyTargets.length + 6) break;
    }
    if (nonEmptySeen === nonEmptyTargets.length) {
      const slice = contentLines.slice(start, end);
      if (predicate(slice)) {
        spans.push(lineRangeToSpanCandidate(contentLines, lineOffsets, start, end, flags));
      }
    }
  }
  return spans;
}


export function transformReplacementForSpan(params: {
  readonly span: SpanCandidate;
  readonly logicalSearch: string;
  readonly logicalNew: string;
  readonly logicalContent: string;
}): string {
  let effectiveSearch = params.logicalSearch;
  let nextText = params.logicalNew;

  if (params.span.stripReplacementPrefixes) {
    const strippedSearch = stripReadLinePrefixes(effectiveSearch);
    if (strippedSearch !== null) effectiveSearch = strippedSearch;
    const strippedNew = stripReadLinePrefixes(nextText);
    if (strippedNew !== null) nextText = strippedNew;
  }

  if (params.span.unescapeReplacement) {
    nextText = unescapeVisibleCharacters(nextText);
  }

  // Если исходный search имел завершающий \n, а lineRangeToSpanCandidate захватил строки без финального \n, синхронизируем завершающий перевод строки
  if (effectiveSearch.endsWith("\n") && !params.span.matchedText.endsWith("\n") && nextText.endsWith("\n")) {
    nextText = nextText.slice(0, -1);
    effectiveSearch = effectiveSearch.slice(0, -1);
  }

  if (params.span.reindentRequired) {
    nextText = reindentReplacementText({
      matchedBlock: params.span.matchedText,
      searchBlock: effectiveSearch,
      replacementText: nextText,
    });
  }

  nextText = preserveCurlyQuotesIfPresent(effectiveSearch, params.span.matchedText, nextText);
  return nextText;
}
