import type { DiffMatchTier, MultiHunkConflictInfo } from "./contract.js";

export interface ResolvedCharSpanReplacement {
  readonly hunkIndex: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number; // 1-based
  readonly endLine: number; // 1-based
  readonly replacementText: string;
  readonly tier: DiffMatchTier;
}

export interface ResolvedLineSpanReplacement {
  readonly hunkIndex: number;
  readonly startLineIndex: number; // 0-based
  readonly oldLineCount: number;
  readonly newLines: readonly string[];
  readonly tier: DiffMatchTier;
}

export type CharSpanMergeResult =
  | {
      readonly status: "merged";
      readonly content: string;
      readonly orderedReplacements: readonly ResolvedCharSpanReplacement[];
    }
  | {
      readonly status: "conflict";
      readonly conflict: MultiHunkConflictInfo;
    };

export type LineSpanMergeResult =
  | {
      readonly status: "merged";
      readonly lines: string[];
      readonly orderedReplacements: readonly ResolvedLineSpanReplacement[];
    }
  | {
      readonly status: "conflict";
      readonly conflict: MultiHunkConflictInfo;
    };

/**
 * Tier 6 (conflict-resolver): автоматически упорядочивает непересекающиеся символьные замены
 * в одном файле, проверяет отсутствие реальных перекрытий и применяет их без сдвига смещений.
 */
export function resolveAndMergeCharReplacements(
  logicalContent: string,
  replacements: readonly ResolvedCharSpanReplacement[],
): CharSpanMergeResult {
  if (replacements.length === 0) {
    return { status: "merged", content: logicalContent, orderedReplacements: [] };
  }

  const ordered = [...replacements].sort((left, right) => {
    if (left.startOffset !== right.startOffset) {
      return left.startOffset - right.startOffset;
    }
    if (left.endOffset !== right.endOffset) {
      return left.endOffset - right.endOffset;
    }
    return left.hunkIndex - right.hunkIndex;
  });

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (hasCharSpanConflict(prev, curr)) {
      return {
        status: "conflict",
        conflict: {
          firstHunkIndex: prev.hunkIndex,
          secondHunkIndex: curr.hunkIndex,
          firstRange: [prev.startLine, prev.endLine],
          secondRange: [curr.startLine, curr.endLine],
          message: `Overlapping hunks #${prev.hunkIndex + 1} (lines ${prev.startLine}-${prev.endLine}) and #${curr.hunkIndex + 1} (lines ${curr.startLine}-${curr.endLine}) cannot be merged safely.`,
        },
      };
    }
  }

  let result = logicalContent;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i]!;
    result = `${result.slice(0, item.startOffset)}${item.replacementText}${result.slice(item.endOffset)}`;
  }

  return {
    status: "merged",
    content: result,
    orderedReplacements: ordered,
  };
}

/**
 * Tier 6 (conflict-resolver) для построчных ханков (ApplyPatch):
 * упорядочивает диапазоны строк, проверяет отсутствие пересечений и применяет с конца к началу.
 */
export function resolveAndMergeLineReplacements(
  originalLines: readonly string[],
  replacements: readonly ResolvedLineSpanReplacement[],
): LineSpanMergeResult {
  if (replacements.length === 0) {
    return { status: "merged", lines: [...originalLines], orderedReplacements: [] };
  }

  const ordered = [...replacements].sort((left, right) => {
    if (left.startLineIndex !== right.startLineIndex) {
      return left.startLineIndex - right.startLineIndex;
    }
    if (left.oldLineCount !== right.oldLineCount) {
      return left.oldLineCount - right.oldLineCount;
    }
    return left.hunkIndex - right.hunkIndex;
  });

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    if (hasLineSpanConflict(prev, curr)) {
      const prevStart = prev.startLineIndex + 1;
      const prevEnd = Math.max(prevStart, prev.startLineIndex + prev.oldLineCount);
      const currStart = curr.startLineIndex + 1;
      const currEnd = Math.max(currStart, curr.startLineIndex + curr.oldLineCount);
      return {
        status: "conflict",
        conflict: {
          firstHunkIndex: prev.hunkIndex,
          secondHunkIndex: curr.hunkIndex,
          firstRange: [prevStart, prevEnd],
          secondRange: [currStart, currEnd],
          message: `Overlapping patch hunks #${prev.hunkIndex + 1} (lines ${prevStart}-${prevEnd}) and #${curr.hunkIndex + 1} (lines ${currStart}-${currEnd}).`,
        },
      };
    }
  }

  const nextLines = [...originalLines];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i]!;
    nextLines.splice(item.startLineIndex, item.oldLineCount, ...item.newLines);
  }

  return {
    status: "merged",
    lines: nextLines,
    orderedReplacements: ordered,
  };
}

function hasCharSpanConflict(
  prev: ResolvedCharSpanReplacement,
  curr: ResolvedCharSpanReplacement,
): boolean {
  const prevEmpty = prev.startOffset === prev.endOffset;
  const currEmpty = curr.startOffset === curr.endOffset;

  if (!prevEmpty && !currEmpty) {
    return prev.endOffset > curr.startOffset;
  }
  if (!prevEmpty && currEmpty) {
    // Чистая вставка строго внутри заменяемого диапазона неоднозначна
    return curr.startOffset > prev.startOffset && curr.startOffset < prev.endOffset;
  }
  if (prevEmpty && !currEmpty) {
    // Оба начинаются в одной точке: вставка перед удалением допустима (prev.endOffset === curr.startOffset)
    return prev.startOffset > curr.startOffset;
  }
  return false;
}

function hasLineSpanConflict(
  prev: ResolvedLineSpanReplacement,
  curr: ResolvedLineSpanReplacement,
): boolean {
  const prevEnd = prev.startLineIndex + prev.oldLineCount;
  const prevEmpty = prev.oldLineCount === 0;
  const currEmpty = curr.oldLineCount === 0;

  if (!prevEmpty && !currEmpty) {
    return prevEnd > curr.startLineIndex;
  }
  if (!prevEmpty && currEmpty) {
    return curr.startLineIndex > prev.startLineIndex && curr.startLineIndex < prevEnd;
  }
  return false;
}
