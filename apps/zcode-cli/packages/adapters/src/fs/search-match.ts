// ============================================================
// Node FileSystem Adapter
// ============================================================




import { extname, relative, sep } from "node:path";


import { createFileSystemError, type FileSystemSearchTextEntry, type FileSystemSearchTextRequest } from "@zcode/contracts";




import {
  DEFAULT_GREP_HEAD_LIMIT,
  LineRange,
  OnlyMatchingMatches,
  TYPE_EXTENSION_MAP,
  TextSearchResult,
} from "./search-types.js";

// Сборка результатов: only-matching/context-индексы, glob-матчинг, лимиты.



export function collectLineOnlyMatchingMatches(
  path: string,
  lines: string[],
  regex: RegExp,
): OnlyMatchingMatches {
  const entriesByLine = new Map<number, FileSystemSearchTextEntry[]>();
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}g`);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const entries: FileSystemSearchTextEntry[] = [];
    globalRegex.lastIndex = 0;
    for (const match of line.matchAll(globalRegex)) {
      entries.push(
        ...createOnlyMatchingEntries({
          path,
          lineNumber: lineIndex + 1,
          text: match[0],
        }),
      );
    }
    if (entries.length > 0) {
      entriesByLine.set(lineIndex, entries);
    }
  }

  return {
    matchCount: entriesByLine.size,
    ranges: Array.from(entriesByLine.keys()).map((lineIndex) => ({
      start: lineIndex,
      end: lineIndex,
    })),
    entriesByLine,
  };
}



export function collectMultilineOnlyMatchingMatches(
  path: string,
  content: string,
  regex: RegExp,
): OnlyMatchingMatches {
  const matches: OnlyMatchingMatches = {
    matchCount: 0,
    ranges: [],
    entriesByLine: new Map(),
  };
  const globalRegex = new RegExp(regex.source, `${regex.ignoreCase ? "i" : ""}gs`);

  for (const match of content.matchAll(globalRegex)) {
    const matchIndex = match.index ?? 0;
    const startLineNumber = lineNumberForIndex(content, matchIndex);
    const entries = createOnlyMatchingEntries({
      path,
      lineNumber: startLineNumber,
      text: match[0],
    });
    for (const entry of entries) {
      const lineIndex = (entry.lineNumber ?? startLineNumber) - 1;
      const existing = matches.entriesByLine.get(lineIndex) ?? [];
      existing.push(entry);
      matches.entriesByLine.set(lineIndex, existing);
    }

    const endIndex = Math.max(matchIndex, matchIndex + match[0].length - 1);
    matches.ranges.push({
      start: startLineNumber - 1,
      end: lineNumberForIndex(content, endIndex) - 1,
    });
    matches.matchCount += 1;
  }

  return matches;
}



export function createOnlyMatchingSearchResult(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): TextSearchResult {
  return {
    matchCount: input.matches.matchCount,
    entries: createOnlyMatchingContentEntries(input),
  };
}



export function createOnlyMatchingContentEntries(input: {
  path: string;
  lines: string[];
  request: FileSystemSearchTextRequest;
  matches: OnlyMatchingMatches;
}): FileSystemSearchTextEntry[] {
  const matchedLineIndexes = createMatchedLineIndexes(input.matches.ranges);

  return createContextLineIndexes(input.lines.length, input.matches.ranges, input.request)
    .flatMap((lineIndex) => {
      const matchedEntries = input.matches.entriesByLine.get(lineIndex);
      if (matchedEntries) return matchedEntries;
      if (matchedLineIndexes.has(lineIndex)) return [];
      return [
        {
          path: input.path,
          lineNumber: lineIndex + 1,
          text: input.lines[lineIndex] ?? "",
          matched: false,
        },
      ];
    });
}



export function createContextLineIndexes(
  lineCount: number,
  ranges: LineRange[],
  request: FileSystemSearchTextRequest,
): number[] {
  const context = request.context ?? 0;
  const beforeContext = request.beforeContext ?? context;
  const afterContext = request.afterContext ?? context;
  const indexes = new Set<number>();

  for (const range of ranges) {
    const start = Math.max(0, range.start - beforeContext);
    const end = Math.min(lineCount - 1, range.end + afterContext);
    for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}



export function createMatchedLineIndexes(ranges: LineRange[]): Set<number> {
  const indexes = new Set<number>();
  for (const range of ranges) {
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      indexes.add(lineIndex);
    }
  }
  return indexes;
}



export function createOnlyMatchingEntries(input: {
  path: string;
  lineNumber?: number;
  text: string;
}): FileSystemSearchTextEntry[] {
  if (input.text.length === 0) {
    return [
      {
        path: input.path,
        lineNumber: input.lineNumber,
        text: "",
        matched: true,
      },
    ];
  }

  // ripgrep 只把 LF/CRLF 当作输出行边界；单独的 CR 是普通匹配文本。
  // 同时，跨行 match 内部的空行不生成 entry，但整段零长度 match 需要保留空 entry。
  return input.text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      line.length === 0
        ? []
        : [
            {
              path: input.path,
              lineNumber:
                input.lineNumber === undefined ? undefined : input.lineNumber + index,
              text: line,
              matched: true,
            },
          ],
    );
}



export function splitRipgrepSearchLines(content: string): string[] {
  // ripgrep 以 LF/CRLF 作为行结束符；末尾换行不是额外空行，单独的 CR 保留在行内容中。
  if (content.length === 0) return [];
  return content.replace(/\r?\n$/, "").split(/\r?\n/);
}



export function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}



export function lineNumberForIndex(content: string, index: number): number {
  let lineNumber = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      lineNumber += 1;
    }
  }
  return lineNumber;
}



export function createGlobMatcher(pattern: string): (relativePath: string, fileName: string) => boolean {
  const normalized = normalizeGlobPattern(pattern);
  const regex = globPatternToRegExp(normalized);
  const basenameRegex = normalized.includes("/") ? undefined : globPatternToRegExp(normalized);

  return (relativePath, fileName) =>
    regex.test(relativePath) || (basenameRegex ? basenameRegex.test(fileName) : false);
}



export function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/^\.\//, "");
}



export function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map(escapeRegExp)
          .join("|");
        regex += `(?:${alternatives})`;
        index = end;
        continue;
      }
    }

    regex += escapeRegExp(char ?? "");
  }

  regex += "$";
  try {
    return new RegExp(regex);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      message: `Invalid glob pattern: ${pattern}`,
      cause: error,
    });
  }
}



export function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}



export function toPosixRelative(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}



export function matchesFileType(path: string, type: string): boolean {
  const normalized = type.toLowerCase().replace(/^\./, "");
  const extension = extname(path).toLowerCase();
  const known = TYPE_EXTENSION_MAP[normalized];
  if (known) {
    return known.includes(extension);
  }
  return extension === `.${normalized}`;
}



export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled");
  error.name = "AbortError";
  throw error;
}



export function looksBinary(content: string): boolean {
  return content.includes("\0");
}



export function applyHeadLimit<T>(
  items: T[],
  headLimit: number | undefined,
  offset = 0,
): { items: T[]; appliedLimit?: number; appliedOffset?: number; truncated: boolean } {
  if (headLimit === 0) {
    return {
      items: items.slice(offset),
      appliedOffset: offset > 0 ? offset : undefined,
      truncated: false,
    };
  }

  const effectiveLimit = headLimit ?? DEFAULT_GREP_HEAD_LIMIT;
  const sliced = items.slice(offset, offset + effectiveLimit);
  const truncated = items.length - offset > effectiveLimit;

  return {
    items: sliced,
    appliedLimit: truncated ? effectiveLimit : undefined,
    appliedOffset: offset > 0 ? offset : undefined,
    truncated,
  };
}
