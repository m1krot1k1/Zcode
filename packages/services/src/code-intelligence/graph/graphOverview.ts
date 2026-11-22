import type { CodeGraphEdge, CodeGraphOverview, CodeWorkspaceRef } from "../contract.js";
import { EDGE_RELATION_NAME } from "../ast/languageRules.js";
import { allRows, firstRow, readMeta, type IndexDatabase, type Row } from "../worker/store.js";

/**
 * Ограниченный обзор графа: либо окрестность фокусного символа, либо связная выборка
 * от узла с максимальной степенью. Ответ никогда не содержит исходный текст и всегда
 * помечается `partial`, если выборка урезана.
 */

const MAX_NODES = 80;
const MAX_EDGES = 180;

function partialOf(db: IndexDatabase): boolean {
  return readMeta(db, "index_partial") === "true" || readMeta(db, "index_state") === "degraded";
}

function relationName(code: unknown): CodeGraphEdge["relation"] {
  // Контракт `CodeGraphEdge.relation` исторически содержит только три значения.
  // Новые типы рёбер (references/extends/implements) сводятся к ним, чтобы не ломать
  // опубликованный протокол: импорты остаются импортами, владение — contains,
  // вызовы и ссылки на типы — calls.
  const name = EDGE_RELATION_NAME[Number(code)] ?? "references";
  if (name === "imports") return "imports";
  if (name === "defines") return "contains";
  return "calls";
}

function nodeLimitOf(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 60;
  return Math.max(10, Math.min(MAX_NODES, Math.floor(limit)));
}

interface NodeRow extends Row {
  symbolId: number;
  name: string;
  kind: number;
  relPath: string;
  startLine: number;
  degree: number;
}

const NODE_SELECT = `
  SELECT s.symbol_id AS symbolId, s.name AS name, s.kind AS kind, f.rel_path AS relPath,
         s.start_line AS startLine,
         (SELECT COUNT(*) FROM edges e WHERE e.src_symbol_id = s.symbol_id)
       + (SELECT COUNT(*) FROM edges e WHERE e.dst_symbol_id = s.symbol_id) AS degree
  FROM symbols s JOIN files f ON f.file_id = s.file_id
`;

function toNode(row: NodeRow): CodeGraphOverview["nodes"][number] {
  return {
    id: `${row.relPath}#${row.symbolId}`,
    name: String(row.name),
    kind: String(row.kind),
    path: String(row.relPath),
    startLine: Number(row.startLine),
    degree: Number(row.degree ?? 0),
  };
}

/**
 * Разбор фокуса графа. Поддерживаются три формы, которые реально приходят из UI:
 *  - числовой `symbol_id`;
 *  - имя символа;
 *  - идентификатор узла `path#symbolId`, который возвращает сам overview.
 * Без третьей формы повторный запрос по клику на узел не находил символ вообще.
 */
function resolveFocusSymbol(db: IndexDatabase, value: string): NodeRow | undefined {
  const byNumeric = Number(value);
  if (Number.isInteger(byNumeric) && byNumeric > 0) {
    const row = firstRow<NodeRow>(db, `${NODE_SELECT} WHERE s.symbol_id = ? LIMIT 1`, byNumeric);
    if (row) return row;
  }
  const hashIndex = value.lastIndexOf("#");
  if (hashIndex > 0) {
    const path = value.slice(0, hashIndex);
    const idPart = Number(value.slice(hashIndex + 1));
    if (Number.isInteger(idPart) && idPart > 0) {
      const row = firstRow<NodeRow>(
        db,
        `${NODE_SELECT} WHERE f.rel_path = ? AND s.symbol_id = ? LIMIT 1`,
        path,
        idPart,
      );
      if (row) return row;
    }
  }
  return firstRow<NodeRow>(
    db,
    `${NODE_SELECT} WHERE s.name = ?
     ORDER BY s.exported DESC, s.centrality DESC LIMIT 1`,
    value,
  );
}

export function readGraphOverview(
  db: IndexDatabase,
  params: CodeWorkspaceRef & {
    focus?: { symbol?: string; path?: string; startLine?: number };
    limit?: number;
  },
): CodeGraphOverview {
  const nodeLimit = nodeLimitOf(params.limit);
  const edgeLimit = Math.min(MAX_EDGES, nodeLimit * 3);
  const focus = params.focus;
  let partial = partialOf(db);

  let focusSymbolId: number | undefined;
  let candidateRows: NodeRow[];

  if (focus) {
    const startLine = focus.startLine;
    const focused =
      focus.path && startLine !== undefined
        ? firstRow<NodeRow>(
            db,
            `${NODE_SELECT} WHERE f.rel_path = ?
             ORDER BY CASE WHEN s.start_line <= ? AND s.end_line >= ? THEN 0 ELSE 1 END,
                      ABS(s.start_line - ?), s.exported DESC LIMIT 1`,
            focus.path,
            startLine,
            startLine,
            startLine,
          )
        : focus.symbol
          ? resolveFocusSymbol(db, focus.symbol)
          : undefined;
    if (!focused) return { nodes: [], edges: [], partial };
    focusSymbolId = Number(focused.symbolId);
    const neighbors = allRows<Row>(
      db,
      `SELECT e.src_symbol_id AS src, e.dst_symbol_id AS dst, e.relation AS relation
       FROM edges e
       WHERE (e.src_symbol_id = ? OR e.dst_symbol_id = ?) AND e.relation <> 1
       ORDER BY e.relation, e.src_symbol_id, e.dst_symbol_id LIMIT ?`,
      focusSymbolId,
      focusSymbolId,
      edgeLimit + 1,
    );
    if (neighbors.length > edgeLimit) partial = true;
    const idSet = new Set<number>([focusSymbolId]);
    for (const row of neighbors.slice(0, edgeLimit)) {
      idSet.add(Number(row.src));
      idSet.add(Number(row.dst));
    }
    const ids = [...idSet].slice(0, nodeLimit);
    if (idSet.size > ids.length) partial = true;
    candidateRows = allRows<NodeRow>(
      db,
      `${NODE_SELECT} WHERE s.symbol_id IN (${ids.map(() => "?").join(",")})
       ORDER BY CASE WHEN s.symbol_id = ? THEN 0 ELSE 1 END, degree DESC, f.rel_path, s.start_line`,
      ...ids,
      focusSymbolId,
    );
  } else {
    const seed = firstRow<NodeRow>(
      db,
      `${NODE_SELECT} ORDER BY degree DESC, s.exported DESC, s.centrality DESC LIMIT 1`,
    );
    if (!seed) return { nodes: [], edges: [], partial };
    const frontier = [Number(seed.symbolId)];
    const visited = new Set<number>(frontier);
    while (frontier.length > 0 && visited.size < nodeLimit) {
      const batch = frontier.splice(0, 16);
      const placeholders = batch.map(() => "?").join(",");
      const neighbors = allRows<Row>(
        db,
        `SELECT e.src_symbol_id AS src, e.dst_symbol_id AS dst FROM edges e
         WHERE e.src_symbol_id IN (${placeholders}) OR e.dst_symbol_id IN (${placeholders})
         ORDER BY e.relation, e.src_symbol_id, e.dst_symbol_id LIMIT ?`,
        ...batch,
        ...batch,
        nodeLimit * 4,
      );
      for (const row of neighbors) {
        for (const id of [Number(row.src), Number(row.dst)]) {
          if (visited.has(id)) continue;
          if (visited.size >= nodeLimit) {
            partial = true;
            break;
          }
          visited.add(id);
          frontier.push(id);
        }
      }
    }
    const ids = [...visited];
    candidateRows = allRows<NodeRow>(
      db,
      `${NODE_SELECT} WHERE s.symbol_id IN (${ids.map(() => "?").join(",")})
       ORDER BY degree DESC, s.exported DESC, f.rel_path, s.start_line`,
      ...ids,
    );
  }

  const allowed = new Set(candidateRows.map((row) => Number(row.symbolId)));
  const edgeRows = allRows<Row>(
    db,
    `SELECT e.src_symbol_id AS src, e.dst_symbol_id AS dst, e.relation AS relation
     FROM edges e
     WHERE e.src_symbol_id IN (${[...allowed].map(() => "?").join(",")})
       AND e.dst_symbol_id IN (${[...allowed].map(() => "?").join(",")})
       AND e.relation <> 1
     ORDER BY e.relation, e.src_symbol_id, e.dst_symbol_id LIMIT ?`,
    ...allowed,
    ...allowed,
    edgeLimit + 1,
  );
  if (edgeRows.length > edgeLimit) partial = true;
  const symbols = new Map(candidateRows.map((row) => [Number(row.symbolId), row]));
  const edges: CodeGraphEdge[] = [];
  const seen = new Set<string>();
  for (const row of edgeRows.slice(0, edgeLimit)) {
    const source = symbols.get(Number(row.src));
    const target = symbols.get(Number(row.dst));
    if (!source || !target) continue;
    const key = `${row.src}:${row.dst}:${row.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: `${source.relPath}#${source.symbolId}`,
      target: `${target.relPath}#${target.symbolId}`,
      relation: relationName(row.relation),
    });
  }
  const totals = firstRow<Row>(
    db,
    "SELECT (SELECT COUNT(*) FROM symbols) AS symbols, (SELECT COUNT(*) FROM edges) AS edges",
  );
  if (
    candidateRows.length < Number(totals?.symbols ?? 0) ||
    edges.length < Number(totals?.edges ?? 0)
  ) {
    partial = true;
  }
  return {
    nodes: candidateRows.slice(0, nodeLimit).map(toNode),
    edges,
    ...(focusSymbolId !== undefined
      ? { focusId: `${symbols.get(focusSymbolId)?.relPath ?? ""}#${focusSymbolId}` }
      : {}),
    partial,
  };
}
