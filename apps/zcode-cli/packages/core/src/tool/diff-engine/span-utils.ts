// ============================================================
// Diff Engine: span primitives and low-level text helpers.
// Извлечено из multi-tier-engine.ts, чтобы файлы реализации
// оставались в пределах architecture-policy maxFileLines.
// ============================================================

import type { LegacyMatchStrategy } from "./contract.js";

export interface SpanCandidate {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly matchedText: string;
  readonly startLineIndex: number; // 0-based
  readonly endLineIndex: number; // 0-based exclusive
  readonly reindentRequired?: boolean;
  readonly unescapeReplacement?: boolean;
  readonly stripReplacementPrefixes?: boolean;
  readonly legacyStrategy?: LegacyMatchStrategy;
}

export function collectSubstringOffsets(haystack: string, needle: string): number[] {
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

export function applyRawSafeReplacements(
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

export function preserveCurlyQuotesIfPresent(
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

export function isOpeningContext(chars: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return prev === " " || prev === "\t" || prev === "\n" || prev === "(" || prev === "[" || prev === "{";
}

export function isUnicodeLetter(ch: string | undefined): boolean {
  return ch !== undefined && /\p{L}/u.test(ch);
}

export function unescapeVisibleCharacters(value: string): string {
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

export function unescapeUnicodeCharacters(value: string): string {
  return value.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedSlash, hex: string) => {
    if (escapedSlash !== undefined) return match;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

export function computeLineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = Array.from({ length: lines.length }, () => 0);
  let pos = 0;
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i] = pos;
    pos += lines[i]!.length + 1;
  }
  return offsets;
}

export function offsetSpanToCandidate(
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

export function lineRangeToSpanCandidate(
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

export function findLineIndexAtOffset(lineOffsets: readonly number[], offset: number): number {
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

export function filterNonOverlappingSpans(spans: readonly SpanCandidate[]): SpanCandidate[] {
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

export function adjustEmptyDeletionEndOffset(
  logicalContent: string,
  endOffset: number,
  replacementText: string,
): number {
  if (replacementText === "" && endOffset < logicalContent.length && logicalContent[endOffset] === "\n") {
    return endOffset + 1;
  }
  return endOffset;
}

export function computeRawLineRange(
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

export function trimTrailingEmptySearchLine(lines: string[]): string[] {
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}

export function splitLogicalLinesKeepEmpty(logicalContent: string): string[] {
  return logicalContent.length === 0 ? [] : logicalContent.split("\n");
}

export function splitPatchLogicalLines(logicalContent: string): string[] {
  if (logicalContent.length === 0) return [];
  const lines = logicalContent.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
