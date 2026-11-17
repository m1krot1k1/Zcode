import type {
  CodeImpactResult,
  CodeSearchResult,
  CodeSymbolContext,
  CodeTraceResult,
} from "../contract.js";
import { allRows, firstRow, readMeta, type IndexDatabase, type Row } from "../worker/store.js";
import { chunkTextAt } from "../worker/chunkContent.js";

const EXCERPT_CHARS = 4096;
const GRAPH_EXCERPT_BUDGET = 8000;
const GRAPH_NODE_CAP = 1024;

function excerptOf(value: string): { excerpt: string; excerptTruncated: boolean } {
  const cleaned = value.replace(/\p{Cc}/gu, " ");
  if (cleaned.length <= EXCERPT_CHARS) return { excerpt: cleaned, excerptTruncated: false };
  return { excerpt: cleaned.slice(0, EXCERPT_CHARS), excerptTruncated: true };
}

export function chunkExcerpt(value: string): { excerpt: string; excerptTruncated: boolean } {
  return excerptOf(value);
}

/** Содержимое, покрывающее диапазон строк: минимальный чанк файла, который его содержит. */
export function readCoveringChunkContent(
  db: IndexDatabase,
  relPath: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const row = firstRow<Row>(
    db,
    `SELECT f.chunk_blob AS chunkBlob, c.chunk_index AS chunkIndex
     FROM chunks c JOIN files f ON f.file_id = c.file_id
     WHERE f.rel_path = ? AND c.start_line <= ? AND c.end_line >= ?
     ORDER BY (c.end_line - c.start_line) ASC LIMIT 1`,
    relPath,
    startLine,
    endLine,
  );
  const content = row ? chunkTextAt(row.chunkBlob, Number(row.chunkIndex)) : "";
  return content.length > 0 ? content : undefined;
}

function partialOf(db: IndexDatabase): boolean {
  return readMeta(db, "index_partial") === "true" || readMeta(db, "index_state") === "degraded";
}

function positiveLine(value: unknown): number | undefined {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function takeExcerpt(
  db: IndexDatabase,
  relPath: string,
  startLine: number,
  endLine: number | undefined,
  budget: { remaining: number },
): { excerpt?: string; excerptTruncated?: boolean } {
  if (endLine === undefined || budget.remaining < 80) return {};
  const content = readCoveringChunkContent(db, relPath, startLine, endLine);
  if (!content) return {};
  const piece = excerptOf(content);
  const excerpt = piece.excerpt.slice(0, Math.min(GRAPH_NODE_CAP, budget.remaining));
  if (!excerpt) return {};
  budget.remaining -= excerpt.length;
  return {
    excerpt,
    ...(piece.excerptTruncated || excerpt.length < piece.excerpt.length
      ? { excerptTruncated: true }
      : {}),
  };
}

interface SymbolRow extends Row {
  symbolId: number;
  name: string;
  kind: number;
  relPath: string;
  startLine: number;
  endLine: number;
}

function findSymbolByName(db: IndexDatabase, nameOrId: string): SymbolRow | undefined {
  const numeric = Number(nameOrId);
  if (Number.isInteger(numeric) && numeric > 0) {
    const byId = firstRow<SymbolRow>(
      db,
      `SELECT s.symbol_id AS symbolId, s.name AS name, s.kind AS kind, f.rel_path AS relPath,
              s.start_line AS startLine, s.end_line AS endLine
       FROM symbols s JOIN files f ON f.file_id = s.file_id WHERE s.symbol_id = ?`,
      numeric,
    );
    if (byId) return byId;
  }
  return firstRow<SymbolRow>(
    db,
    `SELECT s.symbol_id AS symbolId, s.name AS name, s.kind AS kind, f.rel_path AS relPath,
            s.start_line AS startLine, s.end_line AS endLine
     FROM symbols s JOIN files f ON f.file_id = s.file_id
     WHERE s.name = ? ORDER BY s.exported DESC, s.centrality DESC, s.start_line LIMIT 1`,
    nameOrId,
  );
}

/** Контекст символа: сам символ плюс прямые вызывающие и зависимости из `edges`. */
export function readSymbolContext(
  db: IndexDatabase,
  symbolNameOrId: string,
): CodeSymbolContext | null {
  const symbol = findSymbolByName(db, symbolNameOrId);
  if (!symbol) return null;
  const outgoing = allRows<Row>(
    db,
    `SELECT e.dst_symbol_id AS id, e.relation AS relation, s.name AS name, f.rel_path AS relPath,
            s.start_line AS startLine, s.end_line AS endLine
     FROM edges e
     JOIN symbols s ON s.symbol_id = e.dst_symbol_id
     JOIN files f ON f.file_id = s.file_id
     WHERE e.src_symbol_id = ? AND e.relation <> 1
     -- Группировка только по цели: один символ может быть одновременно целью calls
     -- и imports, и без этого он дублировался в ответе.
     GROUP BY e.dst_symbol_id
     ORDER BY s.centrality DESC, f.rel_path
     LIMIT 101`,
    Number(symbol.symbolId),
  );
  const incoming = allRows<Row>(
    db,
    `SELECT e.src_symbol_id AS id, e.relation AS relation, s.name AS name, f.rel_path AS relPath,
            s.start_line AS startLine, s.end_line AS endLine
     FROM edges e
     JOIN symbols s ON s.symbol_id = e.src_symbol_id
     JOIN files f ON f.file_id = s.file_id
     WHERE e.dst_symbol_id = ? AND e.relation <> 1
     GROUP BY e.src_symbol_id
     ORDER BY s.centrality DESC, f.rel_path
     LIMIT 101`,
    Number(symbol.symbolId),
  );
  const budget = { remaining: GRAPH_EXCERPT_BUDGET };
  const symbolStart = positiveLine(symbol.startLine) ?? 1;
  const symbolEnd = positiveLine(symbol.endLine) ?? symbolStart;
  const symbolContent = readCoveringChunkContent(
    db,
    String(symbol.relPath),
    symbolStart,
    symbolEnd,
  );
  const symbolExcerpt = symbolContent ? excerptOf(symbolContent) : undefined;
  const related = (items: Row[]) =>
    items.map((item) => {
      const relPath = String(item.relPath ?? "");
      const startLine = positiveLine(item.startLine) ?? 1;
      const endLine = positiveLine(item.endLine);
      return {
        name: String(item.name ?? relPath),
        path: relPath,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        ...takeExcerpt(db, relPath, startLine, endLine, budget),
      };
    });
  return {
    symbol: {
      id: `${symbol.relPath}#${symbol.symbolId}`,
      name: String(symbol.name),
      kind: String(symbol.kind),
      path: String(symbol.relPath),
      startLine: symbolStart,
      endLine: symbolEnd,
      ...(symbolExcerpt
        ? {
            excerpt: symbolExcerpt.excerpt,
            ...(symbolExcerpt.excerptTruncated ? { excerptTruncated: true } : {}),
          }
        : {}),
    },
    callers: related(incoming.slice(0, 100)),
    dependencies: related(outgoing.slice(0, 100)),
    partial: incoming.length > 100 || outgoing.length > 100 || partialOf(db),
  };
}

/** Обратное влияние: файлы, которые импортируют/вызывают изменённые пути (BFS ≤ 4 уровней). */
export function readImpact(db: IndexDatabase, changedPaths: readonly string[]): CodeImpactResult {
  const normalized = [
    ...new Set(
      changedPaths.map((path) =>
        path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+/u, ""),
      ),
    ),
  ].slice(0, 100);
  const distance = new Map<string, number>();
  const queue = normalized.map((path) => ({ path, depth: 0 }));
  let partial = partialOf(db);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.depth >= 4) continue;
    const upstream = allRows<Row>(
      db,
      `SELECT DISTINCT sf.rel_path AS relPath
       FROM edges e
       JOIN files df ON df.file_id = (SELECT file_id FROM symbols WHERE symbol_id = e.dst_symbol_id)
       JOIN files sf ON sf.file_id = e.src_file_id
       WHERE df.rel_path = ? LIMIT 501`,
      current.path,
    );
    if (upstream.length > 500) partial = true;
    for (const row of upstream.slice(0, 500)) {
      const relPath = String(row.relPath);
      if (distance.has(relPath) || normalized.includes(relPath)) continue;
      if (distance.size >= 1000) {
        partial = true;
        break;
      }
      const nextDepth = current.depth + 1;
      distance.set(relPath, nextDepth);
      queue.push({ path: relPath, depth: nextDepth });
    }
    if (distance.size >= 1000) break;
  }
  const affectedSymbols: CodeImpactResult["affectedSymbols"] = [];
  const budget = { remaining: GRAPH_EXCERPT_BUDGET };
  for (const [relPath, depth] of [...distance].sort(
    (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
  )) {
    const found = allRows<Row>(
      db,
      `SELECT s.name AS name, f.rel_path AS relPath, s.start_line AS startLine, s.end_line AS endLine
       FROM symbols s JOIN files f ON f.file_id = s.file_id
       WHERE f.rel_path = ? ORDER BY s.exported DESC, s.centrality DESC LIMIT 9`,
      relPath,
    );
    if (found.length > 8) partial = true;
    for (const row of found) {
      const startLine = positiveLine(row.startLine) ?? 1;
      const endLine = positiveLine(row.endLine);
      affectedSymbols.push({
        name: String(row.name),
        path: relPath,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        ...takeExcerpt(db, relPath, startLine, endLine, budget),
        distance: depth,
      });
    }
    if (affectedSymbols.length >= 100) {
      partial = true;
      break;
    }
  }
  return {
    changedPaths: normalized,
    affectedSymbols: affectedSymbols.slice(0, 100),
    partial,
  };
}

/** Кратчайший известный путь по рёбрам между двумя символами (BFS). */
export function readTrace(
  db: IndexDatabase,
  fromSymbol: string,
  toSymbol: string,
): CodeTraceResult {
  const from = findSymbolByName(db, fromSymbol);
  const to = findSymbolByName(db, toSymbol);
  if (!from || !to) return { found: false, path: [], partial: partialOf(db) };
  const startId = Number(from.symbolId);
  const targetId = Number(to.symbolId);
  const queue = [startId];
  const previous = new Map<number, { id: number; relation: string }>();
  const visited = new Set(queue);
  let partial = partialOf(db);
  for (let cursor = 0; cursor < queue.length && !visited.has(targetId); cursor += 1) {
    const outgoing = allRows<Row>(
      db,
      "SELECT dst_symbol_id AS dst, relation AS relation FROM edges WHERE src_symbol_id = ? LIMIT 501",
      queue[cursor]!,
    );
    if (outgoing.length > 500) partial = true;
    for (const row of outgoing.slice(0, 500)) {
      const next = Number(row.dst);
      if (visited.has(next)) continue;
      if (visited.size >= 2000) {
        partial = true;
        break;
      }
      visited.add(next);
      previous.set(next, { id: queue[cursor]!, relation: String(row.relation) });
      queue.push(next);
    }
    if (visited.size >= 2000) break;
  }
  if (!visited.has(targetId)) return { found: false, path: [], partial };
  const reversed: Array<{ id: number; relation: string }> = [{ id: targetId, relation: "target" }];
  let cursorId = targetId;
  while (cursorId !== startId) {
    const item = previous.get(cursorId);
    if (!item) break;
    reversed.push(item);
    cursorId = item.id;
  }
  const ordered = reversed.reverse();
  const byId = new Map<number, SymbolRow>();
  for (const item of ordered) {
    const row = findSymbolByName(db, String(item.id));
    if (row) byId.set(item.id, row);
  }
  const budget = { remaining: GRAPH_EXCERPT_BUDGET };
  const path = ordered.flatMap((item) => {
    const symbol = byId.get(item.id);
    if (!symbol) return [];
    const relPath = String(symbol.relPath);
    const startLine = positiveLine(symbol.startLine) ?? 1;
    const endLine = positiveLine(symbol.endLine);
    return [
      {
        name: String(symbol.name),
        path: relPath,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        ...takeExcerpt(db, relPath, startLine, endLine, budget),
        relation: item.relation,
      },
    ];
  });
  return { found: true, path, partial };
}

export type { CodeSearchResult };
