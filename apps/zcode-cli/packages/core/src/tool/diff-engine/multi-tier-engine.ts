import type {
  DiffLineEnding,
  DiffMatchTier,
  IMultiTierDiffEngine,
  MultiHunkEditItem,
  MultiHunkOutcome,
  PatchHunkSpec,
  SingleEditOutcome,
  SingleEditRequest,
} from "./contract.js";
import {
  resolveAndMergeCharReplacements,
  resolveAndMergeLineReplacements,
  type ResolvedCharSpanReplacement,
  type ResolvedLineSpanReplacement,
} from "./conflict-resolver.js";
import {
  buildBestMatchDiagnostic,
  findFuzzyAnchorMatch,
  normalizeSmartPunctuationAndSpaces,
  stripReadLinePrefixes,
} from "./fuzzy-anchor.js";
import {
  computeIndentProfile,
  reindentReplacementLines,
  reindentReplacementText,
} from "./reindent.js";

interface SpanCandidate {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly matchedText: string;
  readonly startLineIndex: number; // 0-based
  readonly endLineIndex: number; // 0-based exclusive
  readonly reindentRequired?: boolean;
  readonly unescapeReplacement?: boolean;
  readonly stripReplacementPrefixes?: boolean;
}

const BROAD_TIERS = new Set<DiffMatchTier>([
  "line-trimmed",
  "indentation-shifted",
  "fuzzy-block-anchor",
]);

export class MultiTierDiffEngine implements IMultiTierDiffEngine {
  detectLineEndings(content: string): DiffLineEnding {
    let crlfCount = 0;
    let lfCount = 0;
    for (let i = 0; i < content.length; i += 1) {
      if (content.charCodeAt(i) !== 10) continue;
      if (i > 0 && content.charCodeAt(i - 1) === 13) {
        crlfCount += 1;
      } else {
        lfCount += 1;
      }
    }
    return crlfCount > lfCount ? "CRLF" : "LF";
  }

  restoreLineEndings(logicalContent: string, lineEndings: DiffLineEnding): string {
    const normalized = logicalContent.replaceAll("\r\n", "\n");
    return lineEndings === "CRLF" ? normalized.replaceAll("\n", "\r\n") : normalized;
  }

  applyEdit(content: string, request: SingleEditRequest): SingleEditOutcome {
    const preserveEol = request.preserveLineEndings !== false;
    const originalEol = this.detectLineEndings(content);
    const replaceAll = request.replaceAll === true;
    const expectedCount = request.expectedReplacements ?? 1;

    // Специальный случай создания/полной вставки в пустой файл при oldString === ""
    if (request.oldString === "") {
      if (content.length === 0) {
        const finalContent = preserveEol
          ? this.restoreLineEndings(request.newString, originalEol)
          : request.newString;
        const newLineCount = Math.max(1, finalContent.replaceAll("\r\n", "\n").split("\n").length);
        return {
          status: "matched",
          content: finalContent,
          appliedTier: "exact",
          originalLineEndings: originalEol,
          candidateCount: 1,
          actualOldString: "",
          actualNewString: finalContent,
          startLine: 1,
          endLine: newLineCount,
        };
      }
      const logicalLines = splitLogicalLinesKeepEmpty(content.replaceAll("\r\n", "\n"));
      return {
        status: "not_found",
        diagnostic: buildBestMatchDiagnostic({
          contentLines: logicalLines,
          searchText: "",
          reason: "oldString is empty, which is only valid when creating or filling an empty file.",
        }),
      };
    }

    // Tier 1: exact (побайтовое вхождение в исходный буфер до нормализации EOL)
    const exactRawSpans = collectSubstringOffsets(content, request.oldString);
    if (exactRawSpans.length > 0) {
      if (!replaceAll && exactRawSpans.length !== expectedCount) {
        const logicalLines = splitLogicalLinesKeepEmpty(content.replaceAll("\r\n", "\n"));
        return {
          status: "ambiguous",
          attemptedTier: "exact",
          candidateCount: exactRawSpans.length,
          diagnostic: buildBestMatchDiagnostic({
            contentLines: logicalLines,
            searchText: request.oldString,
            reason: `Found ${exactRawSpans.length} exact occurrences, expected ${expectedCount}. Provide more surrounding context or set replaceAll: true.`,
          }),
        };
      }
      const rawReplacement = preserveEol
        ? this.restoreLineEndings(request.newString, originalEol)
        : request.newString;
      const targets = replaceAll ? exactRawSpans : exactRawSpans.slice(0, expectedCount);
      const updatedRaw = applyRawSafeReplacements(content, request.oldString, rawReplacement, targets);
      const lineRange = computeRawLineRange(content, targets[0]!, request.oldString.length);
      return {
        status: "matched",
        content: updatedRaw,
        appliedTier: "exact",
        originalLineEndings: originalEol,
        candidateCount: exactRawSpans.length,
        actualOldString: request.oldString,
        actualNewString: rawReplacement,
        startLine: lineRange.startLine,
        endLine: lineRange.endLine,
      };
    }

    // Нормализация буфера к логическому LF для уровней 2..5
    const logicalContent = content.replaceAll("\r\n", "\n");
    const logicalSearch = request.oldString.replaceAll("\r\n", "\n");
    const logicalNew = request.newString.replaceAll("\r\n", "\n");
    const contentLines = logicalContent.split("\n");
    const lineOffsets = computeLineStartOffsets(contentLines);

    const resolved = matchLogicalCascade({
      logicalContent,
      contentLines,
      lineOffsets,
      logicalSearch,
      replaceAll,
      expectedCount,
      expectedStartLine: request.expectedStartLine,
    });

    if (resolved.status !== "matched") {
      return resolved;
    }

    const chosenSpans = replaceAll
      ? resolved.spans
      : resolved.spans.slice(0, expectedCount);

    const replacements: ResolvedCharSpanReplacement[] = chosenSpans.map((span, idx) => {
      const transformedNew = transformReplacementForSpan({
        span,
        logicalSearch,
        logicalNew,
        logicalContent,
      });
      return {
        hunkIndex: idx,
        startOffset: span.startOffset,
        endOffset: adjustEmptyDeletionEndOffset(logicalContent, span.endOffset, transformedNew),
        startLine: span.startLineIndex + 1,
        endLine: Math.max(span.startLineIndex + 1, span.endLineIndex),
        replacementText: transformedNew,
        tier: resolved.tier,
      };
    });

    const merged = resolveAndMergeCharReplacements(logicalContent, replacements);
    if (merged.status === "conflict") {
      return {
        status: "ambiguous",
        attemptedTier: resolved.tier,
        candidateCount: chosenSpans.length,
        diagnostic: buildBestMatchDiagnostic({
          contentLines,
          searchText: logicalSearch,
          reason: merged.conflict.message,
        }),
      };
    }

    const firstSpan = chosenSpans[0]!;
    const firstActualNew = replacements[0]!.replacementText;
    const finalContent = preserveEol
      ? this.restoreLineEndings(merged.content, originalEol)
      : merged.content;

    return {
      status: "matched",
      content: finalContent,
      appliedTier: resolved.tier,
      originalLineEndings: originalEol,
      candidateCount: resolved.spans.length,
      actualOldString: firstSpan.matchedText,
      actualNewString: firstActualNew,
      startLine: firstSpan.startLineIndex + 1,
      endLine: Math.max(firstSpan.startLineIndex + 1, firstSpan.endLineIndex),
    };
  }

  applyMultiHunkEdits(
    content: string,
    hunks: readonly MultiHunkEditItem[],
    options?: { readonly preserveLineEndings?: boolean },
  ): MultiHunkOutcome {
    const preserveEol = options?.preserveLineEndings !== false;
    const originalEol = this.detectLineEndings(content);
    if (hunks.length === 0) {
      return {
        status: "applied",
        content,
        appliedTier: "exact",
        appliedTiersByHunk: [],
        originalLineEndings: originalEol,
        appliedHunkCount: 0,
      };
    }

    if (hunks.length === 1) {
      const single = this.applyEdit(content, {
        oldString: hunks[0]!.oldString,
        newString: hunks[0]!.newString,
        replaceAll: hunks[0]!.replaceAll,
        expectedStartLine: hunks[0]!.expectedStartLine,
        preserveLineEndings: preserveEol,
      });
      if (single.status === "matched") {
        return {
          status: "applied",
          content: single.content,
          appliedTier: single.appliedTier,
          appliedTiersByHunk: [single.appliedTier],
          originalLineEndings: originalEol,
          appliedHunkCount: 1,
        };
      }
      if (single.status === "ambiguous") {
        return {
          status: "ambiguous",
          failedHunkIndex: 0,
          candidateCount: single.candidateCount,
          diagnostic: single.diagnostic,
        };
      }
      return {
        status: "not_found",
        failedHunkIndex: 0,
        diagnostic: single.diagnostic,
      };
    }

    const logicalContent = content.replaceAll("\r\n", "\n");
    const contentLines = logicalContent.split("\n");
    const lineOffsets = computeLineStartOffsets(contentLines);

    const allSpans: ResolvedCharSpanReplacement[] = [];
    const tiersByHunk: DiffMatchTier[] = [];
    let cumulativeLineDelta = 0;

    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex]!;
      const logicalSearch = hunk.oldString.replaceAll("\r\n", "\n");
      const logicalNew = hunk.newString.replaceAll("\r\n", "\n");
      const replaceAll = hunk.replaceAll === true;

      // Проверяем сначала точное побайтовое совпадение до перехода к уровням 2..5
      const rawExactOffsets = collectSubstringOffsets(content, hunk.oldString);
      const exactLogicalOffsets = collectSubstringOffsets(logicalContent, logicalSearch);

      let matchedSpans: SpanCandidate[] | undefined;
      let matchedTier: DiffMatchTier | undefined;

      if (exactLogicalOffsets.length > 0 && (replaceAll || exactLogicalOffsets.length === 1)) {
        matchedTier = rawExactOffsets.length === exactLogicalOffsets.length ? "exact" : "crlf-normalized";
        matchedSpans = exactLogicalOffsets.map((offset) =>
          offsetSpanToCandidate(logicalContent, lineOffsets, offset, offset + logicalSearch.length),
        );
      } else {
        const expectedStart =
          hunk.expectedStartLine !== undefined
            ? Math.max(1, hunk.expectedStartLine + cumulativeLineDelta)
            : undefined;
        const cascaded = matchLogicalCascade({
          logicalContent,
          contentLines,
          lineOffsets,
          logicalSearch,
          replaceAll,
          expectedCount: 1,
          expectedStartLine: expectedStart,
        });
        if (cascaded.status === "not_found") {
          return {
            status: "not_found",
            failedHunkIndex: hunkIndex,
            diagnostic: cascaded.diagnostic,
          };
        }
        if (cascaded.status === "ambiguous") {
          return {
            status: "ambiguous",
            failedHunkIndex: hunkIndex,
            candidateCount: cascaded.candidateCount,
            diagnostic: cascaded.diagnostic,
          };
        }
        matchedSpans = cascaded.spans;
        matchedTier = cascaded.tier;
      }

      tiersByHunk.push(matchedTier);
      const targetSpans = replaceAll ? matchedSpans : matchedSpans.slice(0, 1);

      for (const span of targetSpans) {
        const replacementText = transformReplacementForSpan({
          span,
          logicalSearch,
          logicalNew,
          logicalContent,
        });
        const oldLineCount = span.matchedText.split("\n").length;
        const newLineCount = replacementText.split("\n").length;
        cumulativeLineDelta += newLineCount - oldLineCount;

        allSpans.push({
          hunkIndex,
          startOffset: span.startOffset,
          endOffset: adjustEmptyDeletionEndOffset(logicalContent, span.endOffset, replacementText),
          startLine: span.startLineIndex + 1,
          endLine: Math.max(span.startLineIndex + 1, span.endLineIndex),
          replacementText,
          tier: matchedTier,
        });
      }
    }

    const merged = resolveAndMergeCharReplacements(logicalContent, allSpans);
    if (merged.status === "conflict") {
      return {
        status: "conflict",
        conflict: merged.conflict,
      };
    }

    const finalContent = preserveEol
      ? this.restoreLineEndings(merged.content, originalEol)
      : merged.content;

    return {
      status: "applied",
      content: finalContent,
      appliedTier: "conflict-resolver",
      appliedTiersByHunk: tiersByHunk,
      originalLineEndings: originalEol,
      appliedHunkCount: hunks.length,
    };
  }

  applyStructuredPatchHunks(
    content: string,
    hunks: readonly PatchHunkSpec[],
    options?: { readonly preserveLineEndings?: boolean },
  ): MultiHunkOutcome {
    const preserveEol = options?.preserveLineEndings !== false;
    const originalEol = this.detectLineEndings(content);
    const logicalContent = content.replaceAll("\r\n", "\n");
    const hadTrailingNewline = logicalContent.length === 0 || logicalContent.endsWith("\n");
    const originalLines = splitPatchLogicalLines(logicalContent);

    if (hunks.length === 0) {
      return {
        status: "applied",
        content,
        appliedTier: "exact",
        appliedTiersByHunk: [],
        originalLineEndings: originalEol,
        appliedHunkCount: 0,
      };
    }

    const lineReplacements: ResolvedLineSpanReplacement[] = [];
    const tiersByHunk: DiffMatchTier[] = [];
    let searchCursor = 0;

    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex]!;
      let anchorStart = searchCursor;

      if (hunk.changeContext) {
        const ctxMatch = seekPatchLinesWithTiers(originalLines, [hunk.changeContext], anchorStart, false);
        if (ctxMatch.status !== "matched") {
          return {
            status: "not_found",
            failedHunkIndex: hunkIndex,
            diagnostic: buildBestMatchDiagnostic({
              contentLines: originalLines,
              searchText: hunk.changeContext,
              reason: `Failed to locate patch context header '@@ ${hunk.changeContext}'.`,
            }),
          };
        }
        anchorStart = ctxMatch.startIndex + 1;
      }

      if (hunk.oldLines.length === 0) {
        const insertionIdx = hunk.changeContext ? anchorStart : originalLines.length;
        tiersByHunk.push("exact");
        lineReplacements.push({
          hunkIndex,
          startLineIndex: insertionIdx,
          oldLineCount: 0,
          newLines: [...hunk.newLines],
          tier: "exact",
        });
        continue;
      }

      let pattern = [...hunk.oldLines];
      let replacement = [...hunk.newLines];
      let match = seekPatchLinesWithTiers(
        originalLines,
        pattern,
        anchorStart,
        hunk.endOfFile === true,
      );

      if (match.status === "not_found" && pattern[pattern.length - 1] === "") {
        pattern = pattern.slice(0, -1);
        if (replacement[replacement.length - 1] === "") {
          replacement = replacement.slice(0, -1);
        }
        match = seekPatchLinesWithTiers(
          originalLines,
          pattern,
          anchorStart,
          hunk.endOfFile === true,
        );
      }

      // Если после предыдущего ханка модели шли не по порядку строк — пробуем глобальный поиск с начала файла (для Tier 6 re-ordering!)
      if (match.status === "not_found" && anchorStart > 0 && !hunk.changeContext) {
        match = seekPatchLinesWithTiers(originalLines, pattern, 0, hunk.endOfFile === true);
      }

      if (match.status === "not_found") {
        return {
          status: "not_found",
          failedHunkIndex: hunkIndex,
          diagnostic: buildBestMatchDiagnostic({
            contentLines: originalLines,
            searchText: hunk.oldLines.join("\n"),
            reason: `Failed to match expected lines for hunk #${hunkIndex + 1}.`,
          }),
        };
      }
      if (match.status === "ambiguous") {
        return {
          status: "ambiguous",
          failedHunkIndex: hunkIndex,
          candidateCount: match.candidateCount,
          diagnostic: buildBestMatchDiagnostic({
            contentLines: originalLines,
            searchText: hunk.oldLines.join("\n"),
            reason: `Ambiguous hunk match (${match.candidateCount} candidates) for hunk #${hunkIndex + 1}.`,
          }),
        };
      }

      const matchedSlice = originalLines.slice(match.startIndex, match.startIndex + match.matchedCount);
      const effectiveReplacement = match.reindent
        ? reindentReplacementLines(
            replacement,
            computeIndentProfile(matchedSlice).baseIndent,
            computeIndentProfile(pattern).baseIndent,
          )
        : replacement;

      tiersByHunk.push(match.tier);
      lineReplacements.push({
        hunkIndex,
        startLineIndex: match.startIndex,
        oldLineCount: match.matchedCount,
        newLines: effectiveReplacement,
        tier: match.tier,
      });
      searchCursor = Math.max(searchCursor, match.startIndex + match.matchedCount);
    }

    const merged = resolveAndMergeLineReplacements(originalLines, lineReplacements);
    if (merged.status === "conflict") {
      return {
        status: "conflict",
        conflict: merged.conflict,
      };
    }

    const joinedLogical =
      merged.lines.length === 0
        ? ""
        : hadTrailingNewline
          ? `${merged.lines.join("\n")}\n`
          : merged.lines.join("\n");

    const finalContent = preserveEol
      ? this.restoreLineEndings(joinedLogical, originalEol)
      : joinedLogical;

    const topTier: DiffMatchTier =
      hunks.length > 1 ? "conflict-resolver" : (tiersByHunk[0] ?? "exact");

    return {
      status: "applied",
      content: finalContent,
      appliedTier: topTier,
      appliedTiersByHunk: tiersByHunk,
      originalLineEndings: originalEol,
      appliedHunkCount: hunks.length,
    };
  }
}

export function createMultiTierDiffEngine(): IMultiTierDiffEngine {
  return new MultiTierDiffEngine();
}

function matchLogicalCascade(params: {
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
  const quoteSpans = collectQuoteNormalizedSpans(logicalContent, lineOffsets, logicalSearch);
  if (quoteSpans.length > 0) {
    return finalizeTierCandidates("crlf-normalized", quoteSpans, contentLines, logicalSearch, replaceAll, expectedCount);
  }

  // Tier 2c: visible / unicode escape normalized
  const unescapedVisible = unescapeVisibleCharacters(logicalSearch);
  if (unescapedVisible !== logicalSearch) {
    const escOffsets = collectSubstringOffsets(logicalContent, unescapedVisible);
    if (escOffsets.length > 0) {
      const spans = escOffsets.map((off) => ({
        ...offsetSpanToCandidate(logicalContent, lineOffsets, off, off + unescapedVisible.length),
        unescapeReplacement: true,
      }));
      return finalizeTierCandidates("crlf-normalized", spans, contentLines, logicalSearch, replaceAll, expectedCount);
    }
  }
  const unescapedUnicode = unescapeUnicodeCharacters(logicalSearch);
  if (unescapedUnicode !== logicalSearch) {
    const uniOffsets = collectSubstringOffsets(logicalContent, unescapedUnicode);
    if (uniOffsets.length > 0) {
      const spans = uniOffsets.map((off) =>
        offsetSpanToCandidate(logicalContent, lineOffsets, off, off + unescapedUnicode.length),
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
        const spans = strippedOffsets.map((off) => ({
          ...offsetSpanToCandidate(logicalContent, lineOffsets, off, off + strippedPrefixes.length),
          stripReplacementPrefixes: true,
        }));
        return finalizeTierCandidates("line-trimmed", spans, contentLines, logicalSearch, replaceAll, expectedCount);
      }
    }

    const effectiveSearch = strippedPrefixes ?? logicalSearch;
    const effectiveSearchLines = trimTrailingEmptySearchLine(effectiveSearch.split("\n"));

    // Tier 3b: line-trimmed (сначала trimEnd, затем trim + blank-line tolerant)
    const trimEndSpans = collectLineTrimEndSpans(contentLines, lineOffsets, effectiveSearchLines, strippedPrefixes !== null);
    if (trimEndSpans.length > 0) {
      return finalizeTierCandidates("line-trimmed", trimEndSpans, contentLines, logicalSearch, replaceAll, expectedCount);
    }

    // Tier 4: indentation-shifted (относительный профиль отступов >= 2 непустых строк)
    const indentSpans = collectIndentationShiftedSpans(
      contentLines,
      lineOffsets,
      effectiveSearchLines,
      strippedPrefixes !== null,
    );
    if (indentSpans.length > 0) {
      return finalizeTierCandidates("indentation-shifted", indentSpans, contentLines, logicalSearch, replaceAll, expectedCount);
    }

    // Tier 3c: line-trimmed (для одиночной строки или смешанных отступов, с авто-ре-индентацией)
    const lineTrimSpans = collectLineTrimSpans(
      contentLines,
      lineOffsets,
      effectiveSearchLines,
      strippedPrefixes !== null,
    );
    if (lineTrimSpans.length > 0) {
      return finalizeTierCandidates("line-trimmed", lineTrimSpans, contentLines, logicalSearch, replaceAll, expectedCount);
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

function finalizeTierCandidates(
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

function seekPatchLinesWithTiers(
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

  // 4. line-trimmed + smart punctuation (с reindent если отступ сдвинут)
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
      reindent: true,
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

function tryFindLineSequence(
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

function matchAt(
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

function collectSubstringOffsets(haystack: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const offsets: number[] = [];
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    offsets.push(idx);
    pos = idx + Math.max(1, needle.length);
  }
  return offsets;
}

function applyRawSafeReplacements(
  rawContent: string,
  rawSearch: string,
  rawReplacement: string,
  offsets: readonly number[],
): string {
  let result = rawContent;
  for (let i = offsets.length - 1; i >= 0; i -= 1) {
    const start = offsets[i]!;
    let end = start + rawSearch.length;
    if (rawReplacement === "" && !rawSearch.endsWith("\n")) {
      if (result.slice(end, end + 2) === "\r\n") {
        end += 2;
      } else if (result[end] === "\n") {
        end += 1;
      }
    }
    result = `${result.slice(0, start)}${rawReplacement}${result.slice(end)}`;
  }
  return result;
}

function collectQuoteNormalizedSpans(
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

function collectLineTrimEndSpans(
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

function collectIndentationShiftedSpans(
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

function collectLineTrimSpans(
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
          reindentRequired: true,
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
    { reindentRequired: true, stripReplacementPrefixes },
  );
}

function collectBlankTolerantSpans(
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

function transformReplacementForSpan(params: {
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

function preserveCurlyQuotesIfPresent(
  oldSearch: string,
  actualMatched: string,
  replacement: string,
): string {
  if (oldSearch === actualMatched) return replacement;
  let result = replacement;
  if (actualMatched.includes("“") || actualMatched.includes("”")) {
    result = [...result]
      .map((ch, idx, arr) =>
        ch === '"' ? (isOpeningContext(arr, idx) ? "“" : "”") : ch,
      )
      .join("");
  }
  if (actualMatched.includes("‘") || actualMatched.includes("’")) {
    result = [...result]
      .map((ch, idx, arr) => {
        if (ch !== "'") return ch;
        if (isUnicodeLetter(arr[idx - 1]) && isUnicodeLetter(arr[idx + 1])) return "’";
        return isOpeningContext(arr, idx) ? "‘" : "’";
      })
      .join("");
  }
  return result;
}

function isOpeningContext(chars: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return prev === " " || prev === "\t" || prev === "\n" || prev === "(" || prev === "[" || prev === "{";
}

function isUnicodeLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{L}/u.test(ch);
}

function unescapeVisibleCharacters(value: string): string {
  return value.replace(/\\([ntr"'`\\$])/g, (match, token: string) => {
    switch (token) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
      case "'":
      case "`":
      case "\\":
      case "$":
        return token;
      default:
        return match;
    }
  });
}

function unescapeUnicodeCharacters(value: string): string {
  return value.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedSlash, hex: string) => {
    if (escapedSlash !== undefined) return match;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

function computeLineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i] = pos;
    pos += lines[i]!.length + 1;
  }
  return offsets;
}

function offsetSpanToCandidate(
  logicalContent: string,
  lineOffsets: readonly number[],
  startOffset: number,
  endOffset: number,
): SpanCandidate {
  const startLineIndex = findLineIndexAtOffset(lineOffsets, startOffset);
  const effectiveEnd = endOffset > startOffset ? endOffset - 1 : startOffset;
  const endLineIndex = findLineIndexAtOffset(lineOffsets, effectiveEnd) + 1;
  return {
    startOffset,
    endOffset,
    matchedText: logicalContent.slice(startOffset, endOffset),
    startLineIndex,
    endLineIndex,
  };
}

function lineRangeToSpanCandidate(
  contentLines: readonly string[],
  lineOffsets: readonly number[],
  startLineIndex: number,
  endLineIndex: number,
  extra?: { reindentRequired?: boolean; stripReplacementPrefixes?: boolean },
): SpanCandidate {
  const startOffset = lineOffsets[startLineIndex] ?? 0;
  const lastIdx = Math.max(startLineIndex, endLineIndex - 1);
  const endOffset = (lineOffsets[lastIdx] ?? 0) + (contentLines[lastIdx]?.length ?? 0);
  return {
    startOffset,
    endOffset,
    matchedText: contentLines.slice(startLineIndex, endLineIndex).join("\n"),
    startLineIndex,
    endLineIndex,
    ...extra,
  };
}

function findLineIndexAtOffset(lineOffsets: readonly number[], offset: number): number {
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const midOffset = lineOffsets[mid]!;
    if (midOffset <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(0, high);
}

function filterNonOverlappingSpans(spans: readonly SpanCandidate[]): SpanCandidate[] {
  const result: SpanCandidate[] = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (span.startOffset >= lastEnd) {
      result.push(span);
      lastEnd = span.endOffset;
    }
  }
  return result;
}

function adjustEmptyDeletionEndOffset(
  logicalContent: string,
  endOffset: number,
  replacementText: string,
): number {
  if (replacementText === "" && endOffset < logicalContent.length && logicalContent[endOffset] === "\n") {
    return endOffset + 1;
  }
  return endOffset;
}

function computeRawLineRange(
  rawContent: string,
  startOffset: number,
  byteLen: number,
): { startLine: number; endLine: number } {
  let startLine = 1;
  for (let i = 0; i < startOffset; i += 1) {
    if (rawContent.charCodeAt(i) === 10) startLine += 1;
  }
  let endLine = startLine;
  const endOffset = Math.min(rawContent.length, startOffset + Math.max(0, byteLen - 1));
  for (let i = startOffset; i < endOffset; i += 1) {
    if (rawContent.charCodeAt(i) === 10) endLine += 1;
  }
  return { startLine, endLine };
}

function trimTrailingEmptySearchLine(lines: string[]): string[] {
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

function splitLogicalLinesKeepEmpty(logicalContent: string): string[] {
  return logicalContent.length === 0 ? [] : logicalContent.split("\n");
}

function splitPatchLogicalLines(logicalContent: string): string[] {
  if (logicalContent.length === 0) return [];
  const lines = logicalContent.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
