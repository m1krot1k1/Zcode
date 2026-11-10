import type {
  CodeImpactResult,
  CodeSearchResult,
  CodeSymbolContext,
  CodeTraceResult,
} from "./contract.js";
import {
  cosineSimilarity,
  hasPartialCoverage,
  readEmbedding,
  rows,
  type CodeIndexDatabase,
  type Row,
} from "./database.js";

const CODE_INDEX_CHUNK_EXCERPT_CHARS = 4096;
const GRAPH_EXCERPT_BUDGET = 8_000;
const GRAPH_EXCERPT_NODE_CAP = 1024;

export function chunkExcerpt(value: string): { excerpt: string; excerptTruncated: boolean } {
  const cleaned = value.replace(/\p{Cc}/gu, " ");
  if (cleaned.length <= CODE_INDEX_CHUNK_EXCERPT_CHARS) {
    return { excerpt: cleaned, excerptTruncated: false };
  }
  return {
    excerpt: cleaned.slice(0, CODE_INDEX_CHUNK_EXCERPT_CHARS),
    excerptTruncated: true,
  };
}

export function readCoveringChunkContent(
  db: CodeIndexDatabase,
  path: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const chunk = rows<Row>(
    db,
    `SELECT content FROM chunks
     WHERE path = ? AND start_line <= ? AND end_line >= ?
     ORDER BY CASE WHEN end_line >= ? THEN 0 ELSE 1 END, (end_line - start_line) ASC
     LIMIT 1`,
    path,
    startLine,
    startLine,
    endLine,
  )[0];
  const content = chunk ? String(chunk.content) : "";
  return content.length > 0 ? content : undefined;
}

function positiveLine(value: unknown): number | undefined {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : undefined;
}

function takeGraphExcerpt(
  db: CodeIndexDatabase,
  path: string,
  startLine: number,
  endLine: number | undefined,
  budget: { remaining: number },
): { excerpt?: string; excerptTruncated?: boolean } {
  if (endLine === undefined || budget.remaining < 80) return {};
  const content = readCoveringChunkContent(db, path, startLine, endLine);
  if (!content) return {};
  const piece = chunkExcerpt(content);
  const excerpt = piece.excerpt.slice(0, Math.min(GRAPH_EXCERPT_NODE_CAP, budget.remaining));
  if (!excerpt) return {};
  budget.remaining -= excerpt.length;
  return {
    excerpt,
    ...(piece.excerptTruncated || excerpt.length < piece.excerpt.length
      ? { excerptTruncated: true }
      : {}),
  };
}

export function readImpact(db: CodeIndexDatabase, changedPaths: string[]): CodeImpactResult {
  const normalized = [
    ...new Set(
      changedPaths.map((path) =>
        path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, ""),
      ),
    ),
  ].slice(0, 100);
  const distance = new Map<string, number>();
  const queue = normalized.map((path) => ({ path, depth: 0 }));
  let partial = hasPartialCoverage(db);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.depth >= 4) continue;
    const upstream = rows<Row>(
      db,
      "SELECT DISTINCT source_path AS sourcePath FROM edges WHERE target_path = ? LIMIT 501",
      current.path,
    );
    if (upstream.length > 500) partial = true;
    for (const edge of upstream.slice(0, 500)) {
      if (distance.has(String(edge.sourcePath))) continue;
      if (distance.size >= 1000) {
        partial = true;
        break;
      }
      const nextDepth = current.depth + 1;
      distance.set(String(edge.sourcePath), nextDepth);
      queue.push({ path: String(edge.sourcePath), depth: nextDepth });
    }
    if (distance.size >= 1000) break;
  }
  const affectedSymbols: CodeImpactResult["affectedSymbols"] = [];
  const excerptBudget = { remaining: GRAPH_EXCERPT_BUDGET };
  for (const [path, depth] of [...distance].sort((left, right) => left[1] - right[1])) {
    const found = rows<Row>(
      db,
      "SELECT name, path, start_line AS startLine, end_line AS endLine FROM symbols WHERE path = ? ORDER BY exported DESC LIMIT 9",
      path,
    );
    if (found.length > 8) partial = true;
    for (const symbol of found) {
      const startLine = positiveLine(symbol.startLine) ?? 1;
      const endLine = positiveLine(symbol.endLine);
      affectedSymbols.push({
        name: String(symbol.name),
        path,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        ...takeGraphExcerpt(db, path, startLine, endLine, excerptBudget),
        distance: depth,
      });
    }
    if (affectedSymbols.length >= 100) {
      partial = true;
      break;
    }
  }
  affectedSymbols.sort(
    (left, right) => left.distance - right.distance || left.path.localeCompare(right.path),
  );
  return { changedPaths: normalized, affectedSymbols: affectedSymbols.slice(0, 100), partial };
}

export function readSymbolContext(
  db: CodeIndexDatabase,
  symbolName: string,
): CodeSymbolContext | null {
  const symbol = rows<Row>(
    db,
    "SELECT id, name, kind, path, start_line AS startLine, end_line AS endLine FROM symbols WHERE id = ? OR name = ? ORDER BY exported DESC, start_line LIMIT 1",
    symbolName,
    symbolName,
  )[0];
  if (!symbol) return null;
  // 结构 contains 边只连接文件与声明，不能把模块误报成真实调用者或依赖。
  const outgoing = rows<Row>(
    db,
    "SELECT e.target_id AS id, e.relation, s.name, s.path, s.start_line AS startLine, s.end_line AS endLine FROM edges e LEFT JOIN symbols s ON s.id=e.target_id WHERE e.source_id = ? AND e.relation <> 'contains' LIMIT 101",
    String(symbol.id),
  );
  const incoming = rows<Row>(
    db,
    "SELECT e.source_id AS id, e.relation, s.name, s.path, s.start_line AS startLine, s.end_line AS endLine FROM edges e LEFT JOIN symbols s ON s.id=e.source_id WHERE e.target_id = ? AND e.relation <> 'contains' LIMIT 101",
    String(symbol.id),
  );
  const excerptBudget = { remaining: GRAPH_EXCERPT_BUDGET };
  const symbolStartLine = positiveLine(symbol.startLine) ?? 1;
  const symbolEndLine = positiveLine(symbol.endLine) ?? symbolStartLine;
  const symbolChunk = readCoveringChunkContent(
    db,
    String(symbol.path),
    symbolStartLine,
    symbolEndLine,
  );
  const symbolExcerpt = symbolChunk ? chunkExcerpt(symbolChunk) : undefined;
  const related = (items: Row[]) =>
    items.map((item) => {
      const path = String(item.path ?? "");
      const startLine = positiveLine(item.startLine) ?? 1;
      const endLine = positiveLine(item.endLine);
      return {
        name: String(item.name ?? item.path ?? "module"),
        path,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        ...takeGraphExcerpt(db, path, startLine, endLine, excerptBudget),
      };
    });
  return {
    symbol: {
      id: String(symbol.id),
      name: String(symbol.name),
      kind: String(symbol.kind),
      path: String(symbol.path),
      startLine: symbolStartLine,
      endLine: symbolEndLine,
      ...(symbolExcerpt
        ? {
            excerpt: symbolExcerpt.excerpt,
            ...(symbolExcerpt.excerptTruncated ? { excerptTruncated: true } : {}),
          }
        : {}),
    },
    callers: related(incoming.slice(0, 100)),
    dependencies: related(outgoing.slice(0, 100)),
    partial: incoming.length > 100 || outgoing.length > 100 || hasPartialCoverage(db),
  };
}

export function readTrace(
  db: CodeIndexDatabase,
  fromSymbol: string,
  toSymbol: string,
): CodeTraceResult {
  const from = rows<Row>(
    db,
    "SELECT id FROM symbols WHERE id=? OR name=? ORDER BY exported DESC LIMIT 1",
    fromSymbol,
    fromSymbol,
  )[0];
  const to = rows<Row>(
    db,
    "SELECT id FROM symbols WHERE id=? OR name=? ORDER BY exported DESC LIMIT 1",
    toSymbol,
    toSymbol,
  )[0];
  if (!from || !to) return { found: false, path: [], partial: hasPartialCoverage(db) };
  const queue = [String(from.id)];
  const previous = new Map<string, { id: string; relation: string }>();
  const visited = new Set(queue);
  let partial = hasPartialCoverage(db);
  for (let cursor = 0; cursor < queue.length && !visited.has(String(to.id)); cursor += 1) {
    const outgoing = rows<Row>(
      db,
      "SELECT target_id AS targetId, relation FROM edges WHERE source_id = ? LIMIT 501",
      queue[cursor]!,
    );
    if (outgoing.length > 500) partial = true;
    for (const edge of outgoing.slice(0, 500)) {
      const target = String(edge.targetId);
      if (visited.has(target)) continue;
      if (visited.size >= 2000) {
        partial = true;
        break;
      }
      visited.add(target);
      previous.set(target, { id: queue[cursor]!, relation: String(edge.relation) });
      queue.push(target);
    }
    if (visited.size >= 2000) break;
  }
  if (!visited.has(String(to.id))) return { found: false, path: [], partial };
  const reversed = [{ id: String(to.id), relation: "target" }];
  let cursor = String(to.id);
  while (cursor !== String(from.id)) {
    const item = previous.get(cursor);
    if (!item) break;
    reversed.push(item);
    cursor = item.id;
  }
  const ordered = reversed.reverse();
  const symbols = rows<Row>(
    db,
    `SELECT id, name, path, start_line AS startLine, end_line AS endLine FROM symbols WHERE id IN (${ordered.map(() => "?").join(",")})`,
    ...ordered.map((item) => item.id),
  );
  const byId = new Map(symbols.map((symbol) => [String(symbol.id), symbol]));
  const excerptBudget = { remaining: GRAPH_EXCERPT_BUDGET };
  const path = ordered.flatMap((item) => {
    const symbol = byId.get(item.id);
    if (!symbol) return [];
    const startLine = positiveLine(symbol.startLine) ?? 1;
    const endLine = positiveLine(symbol.endLine);
    const symbolPath = String(symbol.path);
    return [
      {
        name: String(symbol.name),
        path: symbolPath,
        startLine,
        ...(endLine === undefined ? {} : { endLine }),
        ...takeGraphExcerpt(db, symbolPath, startLine, endLine, excerptBudget),
        relation: item.relation,
      },
    ];
  });
  return { found: true, path, partial };
}

export function mergeSemanticChunkHits(
  db: CodeIndexDatabase,
  byKey: Map<string, CodeSearchResult>,
  queryVector: number[],
  modelIdentity: string,
): void {
  const semanticCandidates: Array<{ id: string; score: number }> = [];
  let lastId = "";
  while (true) {
    const page = rows<Row>(
      db,
      "SELECT id, embedding FROM chunks WHERE id > ? AND embedding_model = ? AND embedding IS NOT NULL ORDER BY id LIMIT 256",
      lastId,
      modelIdentity,
    );
    if (page.length === 0) break;
    for (const chunk of page) {
      const vector = readEmbedding(chunk.embedding);
      if (!vector) continue;
      const score = Math.max(0, cosineSimilarity(queryVector, vector));
      if (semanticCandidates.length < 200 || score > semanticCandidates.at(-1)!.score) {
        semanticCandidates.push({ id: String(chunk.id), score });
        semanticCandidates.sort((left, right) => right.score - left.score);
        if (semanticCandidates.length > 200) semanticCandidates.pop();
      }
    }
    lastId = String(page[page.length - 1]!.id);
    if (page.length < 256) break;
  }
  for (const candidate of semanticCandidates) {
    const chunk = rows<Row>(
      db,
      "SELECT path, start_line AS startLine, end_line AS endLine, content FROM chunks WHERE id = ?",
      candidate.id,
    )[0];
    if (!chunk) continue;
    const key = `${chunk.path}:${chunk.startLine}`;
    const existing = byKey.get(key);
    const combined = Math.min(1, candidate.score * 0.7 + (existing?.score ?? 0) * 0.3);
    byKey.set(key, {
      path: String(chunk.path),
      startLine: Number(chunk.startLine),
      endLine: Number(chunk.endLine),
      excerpt: String(chunk.content),
      match: "semantic",
      score: combined,
    });
  }
}
