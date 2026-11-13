// ============================================================
// Node FileSystem Adapter
// ============================================================



import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";


import { createFileSystemError, type FileSystemSearchTextEntry, type FileSystemSearchTextRequest } from "@zcode/contracts";


import { walkFiles } from "./walk-files.js";

import {
  FileSearchCandidate,
  TextSearchResult,
} from "./search-types.js";
import {
  collectLineOnlyMatchingMatches,
  collectMultilineOnlyMatchingMatches,
  createContextLineIndexes,
  createGlobMatcher,
  createOnlyMatchingSearchResult,
  firstLine,
  lineNumberForIndex,
  matchesFileType,
  splitRipgrepSearchLines,
  toPosixRelative,
} from "./search-match.js";

// In-memory скан: регулярка запроса, кандидаты, построчный и multiline поиск.

export function compileSearchRegex(pattern: string, request: FileSystemSearchTextRequest): RegExp {
  try {
    const flags = `${request.ignoreCase ? "i" : ""}${request.multiline ? "s" : ""}`;
    return new RegExp(pattern, flags);
  } catch (error) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path: request.path,
      message: `Invalid grep regular expression: ${pattern}`,
      cause: error,
    });
  }
}



export async function collectTextSearchCandidates(
  path: string,
  rootInfo: Awaited<ReturnType<typeof stat>>,
  request: FileSystemSearchTextRequest,
  signal?: AbortSignal,
): Promise<FileSearchCandidate[]> {
  const candidates: FileSearchCandidate[] = [];
  const globMatcher = request.glob ? createGlobMatcher(request.glob) : undefined;
  const root = rootInfo.isDirectory() ? path : dirname(path);

  const addIfCandidate = async (filePath: string, info: Awaited<ReturnType<typeof stat>>) => {
    if (!info.isFile()) return;
    const relativePath = toPosixRelative(root, filePath);
    if (globMatcher && !globMatcher(relativePath, basename(filePath))) return;
    if (request.type && !matchesFileType(filePath, request.type)) return;
    candidates.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
  };

  if (rootInfo.isFile()) {
    await addIfCandidate(path, rootInfo);
    return candidates;
  }

  if (!rootInfo.isDirectory()) {
    throw createFileSystemError({
      code: "not_file",
      path,
      message: `Grep search path must be a file or directory: ${path}`,
    });
  }

  await walkFiles(root, signal, addIfCandidate);
  candidates.sort((left, right) => left.path.localeCompare(right.path));
  return candidates;
}



export function searchLineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);

  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectLineOnlyMatchingMatches(path, lines, regex),
    });
  }

  const matchingIndexes: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    regex.lastIndex = 0;
    if (regex.test(lines[index] ?? "")) {
      matchingIndexes.push(index);
    }
  }

  const ranges = matchingIndexes.map((index) => ({ start: index, end: index }));
  const matchedLineIndexes = new Set(matchingIndexes);
  const entries = createContextLineIndexes(lines.length, ranges, request).map((lineIndex) => ({
    path,
    lineNumber: lineIndex + 1,
    text: lines[lineIndex] ?? "",
    matched: matchedLineIndexes.has(lineIndex),
  }));

  return {
    matchCount: matchingIndexes.length,
    entries,
  };
}



export function searchMultilineContent(
  path: string,
  content: string,
  regex: RegExp,
  request: FileSystemSearchTextRequest,
): TextSearchResult {
  const lines = splitRipgrepSearchLines(content);
  if (request.onlyMatching) {
    return createOnlyMatchingSearchResult({
      path,
      lines,
      request,
      matches: collectMultilineOnlyMatchingMatches(path, content, regex),
    });
  }

  const flags = `${regex.ignoreCase ? "i" : ""}gs`;
  const globalRegex = new RegExp(regex.source, flags);
  const entries: FileSystemSearchTextEntry[] = [];
  let matchCount = 0;

  for (const match of content.matchAll(globalRegex)) {
    const index = match.index ?? 0;
    const lineNumber = lineNumberForIndex(content, index);
    const text = firstLine(match[0]);
    entries.push({
      path,
      lineNumber,
      text,
      matched: true,
    });
    matchCount += 1;
  }

  return { matchCount, entries };
}
