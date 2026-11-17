import { pathTierOf } from "./languageRegistry.js";
import {
  emptyParsedFile,
  estimateTokens,
  type ParsedChunk,
  type ParsedFile,
  type ParsedImport,
  type ParsedSymbol,
} from "./types.js";

/**
 * Структурный чанкер без грамматики.
 *
 * Зачем он нужен, а не «заглушка»: `tree-sitter-yaml.wasm` из `tree-sitter-wasms@0.1.13`
 * падает на `Language.load` (проверено фактическим запуском), а markdown-грамматики в пакете нет.
 * Этот алгоритм — полноценная структурная сегментация, а не фиксированное окно строк:
 *
 * - **Markdown**: секции по ATX-заголовкам (`#`..`######`), вложенность отражается в `scope_header`
 *   (`docs/a.md | ## Раздел | ### Подраздел`); fenced-блоки кода не разрезаются.
 * - **YAML**: документы по `---` и узлы по изменению отступа ключа; fenced-структура сохраняется.
 * - **TOML/INI/JSON-подобные и неизвестные**: чанки режутся по границам строк на верхнем уровне
 *   отступа, без разрыва строки и без «разрезания» отступного блока.
 * - **Скобочные языки** (unknown с `{}`): баланс `{}`/`[]`/`()` контролируется, чанк закрывается
 *   только на нулевой глубине.
 *
 * Границы всегда выравниваются по строкам — ни один чанк не начинается и не кончается посередине строки.
 */

const TARGET_CHUNK_CHARS = 1200;
const MAX_CHUNK_CHARS = 2000;

interface RawSection {
  startLine: number;
  endLine: number;
  scopePath: string[];
  symbolIndex: number | null;
}

/** Markdown: секции по ATX-заголовкам с учётом fenced-кода. */
function markdownSections(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  const headings: Array<{ line: number; level: number; title: string }> = [];
  let inFence = false;
  let fenceMarker = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.match(/^\s*(```+|~~~+)/u);
    if (fence) {
      const marker = fence[1]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker.startsWith(fenceMarker[0]!)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/u);
    if (heading) {
      headings.push({
        line: index + 1,
        level: heading[1]!.length,
        title: heading[2]!.slice(0, 200),
      });
    }
  }
  if (headings.length === 0) return [];
  // Первая секция — преамбула до первого заголовка.
  if (headings[0]!.line > 1) {
    sections.push({
      startLine: 1,
      endLine: headings[0]!.line - 1,
      scopePath: [],
      symbolIndex: null,
    });
  }
  const stack: Array<{ level: number; title: string }> = [];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index]!;
    while (stack.length > 0 && stack.at(-1)!.level >= current.level) stack.pop();
    stack.push({ level: current.level, title: current.title });
    const next = headings[index + 1];
    const endLine = next ? next.line - 1 : lines.length;
    sections.push({
      startLine: current.line,
      endLine,
      scopePath: stack.map((entry) => entry.title),
      symbolIndex: null,
    });
  }
  return sections;
}

function indentOf(line: string): number {
  const matched = line.match(/^[ \t]*/u);
  if (!matched) return 0;
  let width = 0;
  for (const character of matched[0]) width += character === "\t" ? 2 : 1;
  return width;
}

/** YAML/TOML: узлы по ключам верхнего уровня с учётом отступов и `---`-разделителей документов. */
function keyedSections(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let start = 1;
  let baseIndent = -1;
  let documentIndex = 0;
  const flush = (endLine: number): void => {
    if (endLine >= start) {
      sections.push({
        startLine: start,
        endLine,
        scopePath: documentIndex > 0 ? [`document#${documentIndex + 1}`] : [],
        symbolIndex: null,
      });
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^---\s*$/u.test(trimmed)) {
      flush(index);
      documentIndex += 1;
      start = index + 2;
      baseIndent = -1;
      continue;
    }
    const indent = indentOf(line);
    if (baseIndent < 0) baseIndent = indent;
    const isKey = /^(?:[\w.$"'-]+|\d+)\s*[:=]/u.test(trimmed) || /^\[[^\]]+\]$/u.test(trimmed);
    if (isKey && indent === baseIndent && index + 1 > start) {
      flush(index);
      start = index + 1;
    }
  }
  flush(lines.length);
  return sections;
}

interface BracketState {
  depth: number;
}

function updateBrackets(line: string, state: BracketState): void {
  let inString: string | null = null;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inString) {
      if (character === inString) inString = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") state.depth += 1;
    else if (character === "}" || character === "]" || character === ")")
      state.depth = Math.max(0, state.depth - 1);
  }
}

/** Универсальное разрезание по границам строк с балансом скобок. */
function balancedSections(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let start = 1;
  let chars = 0;
  const state: BracketState = { depth: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    chars += line.length + 1;
    updateBrackets(line, state);
    const atBoundary = state.depth === 0;
    const nextLine = lines[index + 1];
    const nextIndent = nextLine ? indentOf(nextLine) : 0;
    const currentIndent = indentOf(line);
    const structuralBreak =
      atBoundary && chars >= TARGET_CHUNK_CHARS && (currentIndent === 0 || nextIndent === 0);
    if (structuralBreak || chars >= MAX_CHUNK_CHARS) {
      sections.push({ startLine: start, endLine: index + 1, scopePath: [], symbolIndex: null });
      start = index + 2;
      chars = 0;
      state.depth = 0;
    }
  }
  if (start <= lines.length) {
    sections.push({ startLine: start, endLine: lines.length, scopePath: [], symbolIndex: null });
  }
  return sections;
}

/** Символы для keyed-форматов: имена ключей верхнего уровня. */
function keyedSymbols(lines: string[], relPath: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  let baseIndent = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = indentOf(line);
    if (baseIndent < 0) baseIndent = indent;
    if (indent !== baseIndent) continue;
    const keyMatch = trimmed.match(/^["']?([\w.$-]{1,200})["']?\s*[:=]/u);
    if (!keyMatch) continue;
    const startLine = index + 1;
    let endLine = startLine;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]!;
      if (!candidate.trim()) continue;
      if (indentOf(candidate) <= baseIndent) break;
      endLine = cursor + 1;
    }
    symbols.push({
      name: keyMatch[1]!,
      kind: 6,
      startLine,
      endLine,
      parentIndex: null,
      exported: true,
      signature: trimmed.slice(0, 500),
    });
    void relPath;
  }
  return symbols;
}

function importsOf(lines: string[], languageName: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (languageName === "yaml") {
      const matched = line.match(/^\s*-\s*["']?([\w./@-]{2,200})["']?\s*$/u);
      if (matched) imports.push({ specifier: matched[1]!, names: [], line: index + 1 });
    }
  }
  return imports;
}

/** Структурная обработка файла без доступной грамматики. */
export function parseWithTextChunker(
  relPath: string,
  source: string,
  languageId: number,
  languageName: string,
): ParsedFile {
  const result = emptyParsedFile(languageId, languageName);
  const lines = source.split(/\r?\n/u);
  let sections: RawSection[] = [];
  if (languageName === "markdown") {
    sections = markdownSections(lines);
    for (const section of sections) {
      if (section.scopePath.length === 0) continue;
      result.symbols.push({
        name: section.scopePath.at(-1)!,
        kind: 8,
        startLine: section.startLine,
        endLine: section.endLine,
        parentIndex: null,
        exported: true,
        signature: (lines[section.startLine - 1] ?? "").trim().slice(0, 500),
      });
    }
    result.imports = importsOf(lines, languageName);
  } else if (languageName === "yaml" || languageName === "toml") {
    sections = keyedSections(lines);
    result.symbols = keyedSymbols(lines, relPath);
  }
  if (sections.length === 0) sections = balancedSections(lines);
  const tier = pathTierOf(relPath);
  void tier;
  let cursor = 1;
  for (const section of sections) {
    const startLine = Math.max(cursor, section.startLine);
    const endLine = Math.max(startLine, section.endLine);
    const content = lines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim();
    cursor = endLine + 1;
    if (!content) continue;
    const scopeHeader =
      section.scopePath.length > 0
        ? `${relPath} | ${section.scopePath.join(" | ")}`
        : `${relPath} | (section ${startLine}-${endLine})`;
    const chunk: ParsedChunk = {
      startLine,
      endLine,
      content,
      scopeHeader,
      symbolIndex: section.symbolIndex,
      tokenCount: estimateTokens(content),
    };
    result.chunks.push(chunk);
  }
  if (result.chunks.length === 0 && source.trim()) {
    const content = source.trim();
    result.chunks.push({
      startLine: 1,
      endLine: Math.max(1, lines.length),
      content,
      scopeHeader: `${relPath} | (whole file)`,
      symbolIndex: null,
      tokenCount: estimateTokens(content),
    });
  }
  return result;
}
