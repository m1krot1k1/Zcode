import { acquisitionFor } from "./parserAccess.js";
import {
  EDGE_RELATION,
  SYMBOL_KIND,
  rulesForLanguage,
  type DefinitionRule,
  type LanguageRule,
} from "./languageRules.js";
import type { TsNode, TsParser } from "./parserPool.js";
import {
  emptyParsedFile,
  estimateTokens,
  type ParsedCall,
  type ParsedChunk,
  type ParsedFile,
  type ParsedHeritage,
  type ParsedImport,
  type ParsedReference,
  type ParsedSymbol,
} from "./types.js";

const MAX_CHUNK_CHARS = 1400;
const TAIL_MERGE_CHARS = 200;
const MAX_SYMBOLS_PER_FILE = 4000;
const MAX_CALLS_PER_FILE = 3000;
const MAX_REFERENCES_PER_FILE = 3000;
const MAX_IMPORTS_PER_FILE = 400;
const SIGNATURE_LIMIT = 500;

const NAME_NODE_TYPES = [
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "constant",
  "name",
  "simple_identifier",
  "word",
];

interface CollectContext {
  rule: LanguageRule;
  symbols: ParsedSymbol[];
  nodeSymbols: Map<TsNode, number>;
  sourceLines: string[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  references: ParsedReference[];
  heritage: ParsedHeritage[];
}

function lineOf(node: TsNode): number {
  return node.startPosition.row + 1;
}

function endLineOf(node: TsNode): number {
  // `endPosition` указывает на позицию после последнего символа; на строке-границе она
  // попадает в следующий ряд, поэтому уменьшаем, если столбец нулевой и не начало файла.
  const row = node.endPosition.row;
  return node.endPosition.column === 0 && row > node.startPosition.row ? row : row + 1;
}

function firstLineText(sourceLines: string[], startLine: number): string {
  return (sourceLines[startLine - 1] ?? "").trim().slice(0, SIGNATURE_LIMIT);
}

function hasExportKeyword(node: TsNode): boolean {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === "export" || child.text === "export") return true;
    if (child.type === "modifiers" || child.type === "visibility_modifier") {
      if (/\b(?:pub|public|export)\b/u.test(child.text)) return true;
    }
  }
  return false;
}

/** Рекурсивный поиск идентификатора внутри declarator (C/C++: `int (*f)(int)`). */
function declaratorNameOf(node: TsNode, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  const direct = node.childForFieldName("declarator");
  if (direct) {
    if (NAME_NODE_TYPES.includes(direct.type)) return direct.text;
    const nested = declaratorNameOf(direct, depth + 1);
    if (nested) return nested;
  }
  for (const child of node.namedChildren) {
    if (depth > 6) break;
    if (NAME_NODE_TYPES.includes(child.type)) return child.text;
    const nested = declaratorNameOf(child, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/** Имя из pattern-узла: `{ a, b }` → `a`, `[x, y]` → `x`, `foo` → `foo`. */
function patternNameOf(node: TsNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (NAME_NODE_TYPES.includes(node.type)) return node.text || undefined;
  if (node.type === "object" || node.type === "object_pattern") {
    // Берём первый именованный ключ: он и есть «главное» имя деструктуризации.
    for (const child of node.namedChildren) {
      if (child.type === "shorthand_property_identifier_pattern") return child.text || undefined;
      const key = child.childForFieldName("key") ?? child.childForFieldName("value");
      if (key?.text) return key.text;
      if (NAME_NODE_TYPES.includes(child.type) && child.text) return child.text;
    }
    return undefined;
  }
  if (node.type === "array" || node.type === "array_pattern") {
    return patternNameOf(node.namedChildren[0]);
  }
  return undefined;
}

function resolveName(node: TsNode, rule: DefinitionRule): string | undefined {
  if (rule.declaratorName) {
    const name = declaratorNameOf(node);
    if (name) return name;
  }
  if (rule.nameField) {
    const named = node.childForFieldName(rule.nameField);
    if (named?.text) return named.text;
  }
  const fieldName = node.childForFieldName("name");
  // Причина проверки типа: для `const { a, b } = hook()` полем `name` является весь
  // object-pattern, и его `.text` — многострочный блок деструктуризации. Такое «имя»
  // раздувало `symbols.name` и `chunks.scope_header` (замер: до 1500 символов на чанк)
  // и попадало в FTS-токены как мусор. Из pattern берётся только первый идентификатор.
  if (fieldName) {
    const resolved = patternNameOf(fieldName);
    if (resolved) return resolved;
    if (NAME_NODE_TYPES.includes(fieldName.type) && fieldName.text) return fieldName.text;
  }
  for (const child of node.namedChildren) {
    if (NAME_NODE_TYPES.includes(child.type) && child.text) return child.text;
    if (child.type === "type_spec" || child.type === "variable_declarator") {
      const nested = child.childForFieldName("name");
      if (nested?.text) return nested.text;
      const pattern = child.childForFieldName("declarator");
      if (pattern?.text) return pattern.text;
    }
  }
  // TS/JS: `const foo = ...` и `const { a, b } = ...`
  for (const child of node.namedChildren) {
    if (child.type === "variable_declarator") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) return nameNode.text;
    }
  }
  return undefined;
}

function isExported(
  node: TsNode,
  rule: DefinitionRule,
  name: string,
  enclosingExported: boolean,
): boolean {
  if (rule.exported === "always") return true;
  if (node.type === "export_statement") return true;
  if (hasExportKeyword(node)) return true;
  if (rule.exported === "capitalized") return !name.startsWith("_");
  return enclosingExported && rule.kind !== SYMBOL_KIND.method;
}

function matchDefinition(rule: LanguageRule, nodeType: string): DefinitionRule | undefined {
  for (const definition of rule.definitions) {
    if (definition.node === nodeType) return definition;
  }
  return undefined;
}

function collectSymbols(
  context: CollectContext,
  node: TsNode,
  parentIndex: number | null,
  parentExported: boolean,
): void {
  for (const child of node.namedChildren) {
    if (context.symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    const definition = matchDefinition(context.rule, child.type);
    if (definition) {
      const name = resolveName(child, definition);
      if (name && name.length <= 512) {
        const startLine = lineOf(child);
        const endLine = Math.max(startLine, endLineOf(child));
        const exported = isExported(child, definition, name, parentExported);
        const index = context.symbols.length;
        context.symbols.push({
          name,
          kind: definition.kind,
          startLine,
          endLine,
          parentIndex,
          exported,
          signature: firstLineText(context.sourceLines, startLine),
        });
        context.nodeSymbols.set(child, index);
        collectSymbols(context, child, index, exported);
        continue;
      }
    }
    collectSymbols(context, child, parentIndex, parentExported);
  }
}

function enclosingSymbolIndex(
  nodeSymbols: Map<TsNode, number>,
  symbols: ParsedSymbol[],
  node: TsNode,
): number | null {
  let current: TsNode | null = node.parent;
  while (current) {
    const found = nodeSymbols.get(current);
    if (found !== undefined) return found;
    current = current.parent;
  }
  // Символ не найден по узлу (имя получено из declarator) — ищем по диапазону строк.
  const line = lineOf(node);
  let best: number | null = null;
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index]!;
    if (symbol.startLine <= line && symbol.endLine >= line) {
      if (best === null || symbol.startLine >= symbols[best]!.startLine) best = index;
    }
  }
  return best;
}

function calleeNameOf(node: TsNode): string | undefined {
  for (const field of ["function", "name", "method", "command", "function_name"]) {
    const named = node.childForFieldName(field);
    if (named) {
      if (NAME_NODE_TYPES.includes(named.type)) return named.text;
      const nested = calleeNameOf(named);
      if (nested) return nested;
    }
  }
  const first = node.namedChild(0);
  if (!first) return undefined;
  if (NAME_NODE_TYPES.includes(first.type)) return first.text;
  if (first.type === "member_expression" || first.type === "field_expression") {
    const property = first.childForFieldName("property") ?? first.childForFieldName("field");
    if (property?.text) return property.text;
  }
  return undefined;
}

function stringLiteralsOf(node: TsNode, depth = 0): string[] {
  if (depth > 4) return [];
  const literals: string[] = [];
  if (
    node.type === "string" ||
    node.type === "string_literal" ||
    node.type === "interpreted_string_literal" ||
    node.type === "system_lib_string" ||
    node.type === "raw_string_literal"
  ) {
    literals.push(node.text.replace(/^["'`<]|["'`>]$/gu, ""));
    return literals;
  }
  for (const child of node.namedChildren) literals.push(...stringLiteralsOf(child, depth + 1));
  return literals;
}

function identifierNamesOf(node: TsNode, depth = 0, limit = 32): string[] {
  if (depth > 4 || limit <= 0) return [];
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (names.length >= limit) break;
    if (NAME_NODE_TYPES.includes(child.type) && child.text) {
      names.push(child.text);
      continue;
    }
    names.push(...identifierNamesOf(child, depth + 1, limit - names.length));
  }
  return names;
}

const ALIAS_PAIR = /([\p{L}_$][\p{L}\p{N}_$]*)\s+as\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu;

/** Пары алиасов из текста импорта: `{ a as b }`, `import x as y`, `import "mod" as m`. */
function aliasPairsOf(text: string): Array<{ imported: string; local: string }> {
  const pairs: Array<{ imported: string; local: string }> = [];
  for (const match of text.matchAll(ALIAS_PAIR)) {
    const imported = match[1];
    const local = match[2];
    if (!imported || !local || imported === local) continue;
    pairs.push({ imported, local });
    if (pairs.length >= 32) break;
  }
  return pairs;
}

function heritageNamesOf(node: TsNode, types: string[], limit = 16): string[] {
  const names: string[] = [];
  const visit = (current: TsNode, depth: number): void => {
    if (depth > 6 || names.length >= limit) return;
    if (types.includes(current.type)) {
      for (const name of identifierNamesOf(current, 0, limit - names.length)) names.push(name);
      return;
    }
    for (const child of current.namedChildren) visit(child, depth + 1);
  };
  visit(node, 0);
  return names;
}

/** Диапазоны строк, покрывающие файл без пересечений и без разрезания узлов AST. */
interface ChunkUnit {
  startLine: number;
  endLine: number;
  symbolIndex: number | null;
}

function emitSymbolUnits(
  context: CollectContext,
  node: TsNode,
  symbolIndex: number,
  scopePath: string[],
  units: ChunkUnit[],
): void {
  const symbol = context.symbols[symbolIndex]!;
  const text = (
    context.sourceLines.slice(symbol.startLine - 1, symbol.endLine).join("\n") ?? ""
  ).trim();
  const childSymbols: number[] = [];
  for (let index = 0; index < context.symbols.length; index += 1) {
    if (context.symbols[index]!.parentIndex === symbolIndex) childSymbols.push(index);
  }
  if (text.length <= MAX_CHUNK_CHARS || childSymbols.length === 0) {
    units.push({ startLine: symbol.startLine, endLine: symbol.endLine, symbolIndex });
    return;
  }
  // Крупное объявление: сначала шапка до первого дочернего объявления, затем дети рекурсивно.
  const nextScope = [...scopePath, symbol.name];
  let cursor = symbol.startLine;
  for (const childIndex of childSymbols) {
    const child = context.symbols[childIndex]!;
    if (child.startLine > cursor) {
      const headerEnd = child.startLine - 1;
      if (headerEnd >= cursor) units.push({ startLine: cursor, endLine: headerEnd, symbolIndex });
    }
    const childNode = findNodeForSymbol(context, node, childIndex);
    if (childNode) emitSymbolUnits(context, childNode, childIndex, nextScope, units);
    else
      units.push({ startLine: child.startLine, endLine: child.endLine, symbolIndex: childIndex });
    cursor = child.endLine + 1;
  }
  if (cursor <= symbol.endLine) {
    units.push({ startLine: cursor, endLine: symbol.endLine, symbolIndex });
  }
}

function findNodeForSymbol(
  context: CollectContext,
  node: TsNode,
  symbolIndex: number,
): TsNode | undefined {
  for (const [candidate, index] of context.nodeSymbols) {
    if (index !== symbolIndex) continue;
    // Узел должен лежать внутри переданного поддерева.
    if (candidate.startIndex >= node.startIndex && candidate.endIndex <= node.endIndex) {
      return candidate;
    }
  }
  return undefined;
}

function mergeTailUnits(units: ChunkUnit[], sourceLines: string[]): ChunkUnit[] {
  const merged: ChunkUnit[] = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    if (previous && previous.endLine < unit.startLine) {
      const gapLength = unit.startLine - previous.endLine;
      const unitChars = (sourceLines.slice(unit.startLine - 1, unit.endLine).join("\n") ?? "")
        .length;
      if (gapLength <= 3 && unitChars < TAIL_MERGE_CHARS) {
        previous.endLine = unit.endLine;
        continue;
      }
    }
    merged.push({ ...unit });
  }
  return merged;
}

/**
 * Предельная длина заголовка области видимости.
 *
 * Найденный дефект: для `const { a, b, c, ... } = useHook()` чанкер брал в качестве имени
 * символа весь блок деструктуризации (`nameNode.text`), поэтому `scope_header` раздувался до
 * 1500+ символов с переводами строк. Замер на корпусе: 164 050 чанков давали 14.84 МБ
 * заголовков при 103 000 уникальных значений, и половина объёма приходилась на такие блоки.
 * Заголовок нужен модели как краткий контекст (`path | Symbol.member`), а не как копия кода,
 * поэтому сегменты обрезаются, а переводы строк схлопываются.
 */
const SCOPE_SEGMENT_LIMIT = 80;
const SCOPE_HEADER_LIMIT = 200;

function compactScopeSegment(value: string): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  if (flattened.length <= SCOPE_SEGMENT_LIMIT) return flattened;
  // Многострочный блок деструктуризации опознаётся по фигурным скобкам: оставляем признак
  // «это деструктуризация», но не её содержимое.
  if (flattened.startsWith("{") || flattened.startsWith("[")) {
    return `${flattened[0]}…${flattened.at(-1) ?? ""}`;
  }
  return `${flattened.slice(0, SCOPE_SEGMENT_LIMIT)}…`;
}

function scopeHeaderOf(relPath: string, scopeParts: readonly string[]): string {
  const parts = [relPath, ...scopeParts];
  const header = parts.join(" | ");
  return header.length <= SCOPE_HEADER_LIMIT ? header : `${header.slice(0, SCOPE_HEADER_LIMIT)}…`;
}

function buildChunks(context: CollectContext, units: ChunkUnit[], relPath: string): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  for (const unit of units) {
    const startLine = Math.max(1, unit.startLine);
    const endLine = Math.min(context.sourceLines.length, unit.endLine);
    if (endLine < startLine) continue;
    const content = context.sourceLines
      .slice(startLine - 1, endLine)
      .join("\n")
      .trim();
    if (!content) continue;
    const scopeParts: string[] = [];
    if (unit.symbolIndex !== null) {
      const chain: string[] = [];
      let cursor: number | null = unit.symbolIndex;
      let guard = 0;
      while (cursor !== null && guard < 16) {
        const symbol: ParsedSymbol | undefined = context.symbols[cursor];
        if (!symbol) break;
        chain.unshift(compactScopeSegment(symbol.name));
        cursor = symbol.parentIndex;
        guard += 1;
      }
      scopeParts.push(chain.join("."));
    } else {
      scopeParts.push("(top-level)");
    }
    chunks.push({
      startLine,
      endLine,
      content,
      scopeHeader: scopeHeaderOf(relPath, scopeParts),
      symbolIndex: unit.symbolIndex,
      tokenCount: estimateTokens(content),
    });
  }
  return chunks;
}

function chunkFillerRegion(
  context: CollectContext,
  startLine: number,
  endLine: number,
  units: ChunkUnit[],
): void {
  let cursor = startLine;
  while (cursor <= endLine) {
    let sliceEnd = cursor;
    let accumulated = 0;
    while (sliceEnd <= endLine && accumulated < MAX_CHUNK_CHARS) {
      accumulated += (context.sourceLines[sliceEnd - 1] ?? "").length + 1;
      sliceEnd += 1;
    }
    const chunkEnd = Math.min(endLine, Math.max(cursor, sliceEnd - 1));
    if (chunkEnd >= cursor) units.push({ startLine: cursor, endLine: chunkEnd, symbolIndex: null });
    cursor = chunkEnd + 1;
  }
}

function collectFillerUnits(context: CollectContext, units: ChunkUnit[]): void {
  const covered: boolean[] = new Array(context.sourceLines.length + 2).fill(false);
  for (const unit of units) {
    for (let line = unit.startLine; line <= unit.endLine; line += 1) {
      if (line < covered.length) covered[line] = true;
    }
  }
  let gapStart = 0;
  for (let line = 1; line <= context.sourceLines.length; line += 1) {
    if (covered[line]) {
      if (gapStart && line - 1 >= gapStart) chunkFillerRegion(context, gapStart, line - 1, units);
      gapStart = 0;
    } else if (gapStart === 0) {
      gapStart = line;
    }
  }
  if (gapStart) chunkFillerRegion(context, gapStart, context.sourceLines.length, units);
}

function collectImportsAndCalls(context: CollectContext, node: TsNode): void {
  const { rule } = context;
  const pending: Array<() => void> = [];
  const visit = (current: TsNode, depth: number): void => {
    if (depth > 64) return;
    if (rule.importNodes.includes(current.type) && context.imports.length < MAX_IMPORTS_PER_FILE) {
      const specifiers = stringLiteralsOf(current);
      const names = identifierNamesOf(current).filter(
        (name) => !specifiers.some((specifier) => specifier.includes(name) && name.length < 4),
      );
      const aliases = aliasPairsOf(current.text);
      for (const specifier of specifiers.slice(0, 4)) {
        if (context.imports.length >= MAX_IMPORTS_PER_FILE) break;
        context.imports.push({
          specifier,
          names: names.slice(0, 32),
          ...(aliases.length > 0 ? { aliases } : {}),
          line: lineOf(current),
        });
      }
    }
    if (rule.callNodes.includes(current.type) && context.calls.length < MAX_CALLS_PER_FILE) {
      const name = calleeNameOf(current);
      if (name && name.length <= 256) {
        pending.push(() => {
          context.calls.push({
            name,
            line: lineOf(current),
            enclosingSymbolIndex: enclosingSymbolIndex(
              context.nodeSymbols,
              context.symbols,
              current,
            ),
          });
        });
      }
    }
    if (
      (current.type === "type_identifier" || current.type === "type_annotation") &&
      context.references.length < MAX_REFERENCES_PER_FILE
    ) {
      const text = current.text.trim();
      if (/^[\p{L}_$][\p{L}\p{N}_$]{2,255}$/u.test(text)) {
        pending.push(() => {
          context.references.push({
            name: text,
            line: lineOf(current),
            enclosingSymbolIndex: enclosingSymbolIndex(
              context.nodeSymbols,
              context.symbols,
              current,
            ),
          });
        });
      }
    }
    for (const child of current.namedChildren) visit(child, depth + 1);
  };
  visit(node, 0);
  for (const action of pending) {
    if (
      context.calls.length >= MAX_CALLS_PER_FILE &&
      context.references.length >= MAX_REFERENCES_PER_FILE
    ) {
      break;
    }
    action();
  }
}

function collectHeritage(context: CollectContext, node: TsNode): void {
  const { rule } = context;
  const visit = (current: TsNode, depth: number): void => {
    if (depth > 12) return;
    const symbolIndex = context.nodeSymbols.get(current);
    if (symbolIndex !== undefined) {
      if (rule.extendsNodes.length > 0) {
        for (const name of heritageNamesOf(current, rule.extendsNodes, 8)) {
          if (name && name !== context.symbols[symbolIndex]!.name) {
            context.heritage.push({
              name,
              relation: "extends",
              symbolIndex,
              line: lineOf(current),
            });
          }
        }
      }
      if (rule.implementsNodes.length > 0) {
        for (const name of heritageNamesOf(current, rule.implementsNodes, 8)) {
          if (name && name !== context.symbols[symbolIndex]!.name) {
            context.heritage.push({
              name,
              relation: "implements",
              symbolIndex,
              line: lineOf(current),
            });
          }
        }
      }
    }
    for (const child of current.namedChildren) visit(child, depth + 1);
  };
  visit(node, 0);
}

/**
 * Разбирает файл грамматикой tree-sitter.
 * Возвращает `null`, если грамматика недоступна или парсер не смог разобрать ввод —
 * вызывающая сторона обязана использовать структурный текстовый чанкер.
 */
export async function parseWithTreeSitter(
  relPath: string,
  source: string,
  languageName: string,
): Promise<ParsedFile | null> {
  const rule = rulesForLanguage(languageName);
  if (!rule) return null;
  const acquisition = await acquisitionFor(languageName);
  if (!acquisition) return null;
  const { parser, languageId } = acquisition;
  return parseUsing(parser, rule, languageId, languageName, relPath, source);
}

function parseUsing(
  parser: TsParser,
  rule: LanguageRule,
  languageId: number,
  languageName: string,
  relPath: string,
  source: string,
): ParsedFile | null {
  const tree = (() => {
    try {
      return parser.parse(source);
    } catch {
      return null;
    }
  })();
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    if (!root || root.type !== rule.root) return null;
    const sourceLines = source.split(/\r?\n/u);
    const context: CollectContext = {
      rule,
      symbols: [],
      nodeSymbols: new Map(),
      sourceLines,
      calls: [],
      references: [],
      imports: [],
      heritage: [],
    };
    collectSymbols(context, root, null, false);
    const units: ChunkUnit[] = [];
    for (let index = 0; index < context.symbols.length; index += 1) {
      const symbol = context.symbols[index]!;
      if (symbol.parentIndex !== null) continue;
      const node = findNodeForSymbol(context, root, index);
      if (node) emitSymbolUnits(context, node, index, [], units);
      else units.push({ startLine: symbol.startLine, endLine: symbol.endLine, symbolIndex: index });
    }
    units.sort((left, right) => left.startLine - right.startLine);
    collectFillerUnits(context, units);
    units.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
    const mergedUnits = mergeTailUnits(dedupeUnits(units), sourceLines);
    collectImportsAndCalls(context, root);
    collectHeritage(context, root);
    const result = emptyParsedFile(languageId, languageName);
    result.usedTreeSitter = true;
    result.symbols = context.symbols;
    result.chunks = buildChunks(context, mergedUnits, relPath);
    result.imports = context.imports;
    result.calls = context.calls;
    result.references = context.references;
    result.heritage = context.heritage.slice(0, 2000);
    return result;
  } finally {
    tree.delete();
  }
}

function dedupeUnits(units: ChunkUnit[]): ChunkUnit[] {
  const seen = new Set<string>();
  const deduped: ChunkUnit[] = [];
  for (const unit of units) {
    const key = `${unit.startLine}:${unit.endLine}:${unit.symbolIndex ?? -1}`;
    if (seen.has(key)) continue;
    // Убираем полностью вложенные дубли (шапка крупного класса vs. его же член).
    if (deduped.some((item) => item.startLine <= unit.startLine && item.endLine >= unit.endLine)) {
      continue;
    }
    seen.add(key);
    deduped.push(unit);
  }
  return deduped;
}

/** Публичный тип связи для сборки рёбер из AST-фактов. */
export const AST_EDGE = EDGE_RELATION;
