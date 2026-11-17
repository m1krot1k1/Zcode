// ============================================================
// MultiTierDiffEngine: 6-уровневый отказоустойчивый движок патчей.
// Класс держит публичный контракт, а матчеры уровней и утилиты спанов
// вынесены в tier-matchers.ts / span-utils.ts (лимит maxFileLines).
// ============================================================

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
import { buildBestMatchDiagnostic } from "./fuzzy-anchor.js";
import { computeIndentProfile, reindentReplacementLines } from "./reindent.js";
import {
  applyRawSafeReplacements,
  collectSubstringOffsets,
  computeLineStartOffsets,
  computeRawLineRange,
  offsetSpanToCandidate,
  splitLogicalLinesKeepEmpty,
  splitPatchLogicalLines,
  adjustEmptyDeletionEndOffset,
  type SpanCandidate,
} from "./span-utils.js";
import {
  defaultLegacyStrategy,
  matchLogicalCascade,
  seekPatchLinesWithTiers,
  transformReplacementForSpan,
} from "./tier-matchers.js";

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
      legacyMatchStrategy: firstSpan.legacyStrategy ?? defaultLegacyStrategy(resolved.tier),
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
