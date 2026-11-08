import type { CodeGraphOverview, CodeWorkspaceRef } from "./contract.js";
import { hasPartialCoverage, rows, type CodeIndexDatabase, type Row } from "./database.js";

const MAX_GRAPH_NODES = 80;
const MAX_GRAPH_EDGES = 180;

function graphNodeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 60;
  return Math.max(10, Math.min(MAX_GRAPH_NODES, Math.floor(limit)));
}

/** Keep graph selection inside SQLite; only the bounded response is materialized in the Host. */
export function readGraphOverview(
  db: CodeIndexDatabase,
  params: CodeWorkspaceRef & {
    focus?: { symbol?: string; path?: string; startLine?: number };
    limit?: number;
  },
): CodeGraphOverview {
  const nodeLimit = graphNodeLimit(params.limit);
  const edgeLimit = Math.min(MAX_GRAPH_EDGES, nodeLimit * 3);
  const focus = params.focus;
  const focusStartLine =
    typeof focus?.startLine === "number" && Number.isFinite(focus.startLine)
      ? focus.startLine
      : undefined;
  const focusedSymbol = focus
    ? rows<Row>(
        db,
        focus.path && focusStartLine !== undefined
          ? "SELECT id, name, kind, path, start_line AS startLine FROM symbols WHERE path = ? ORDER BY CASE WHEN start_line <= ? AND end_line >= ? THEN 0 ELSE 1 END, ABS(start_line - ?), exported DESC, start_line LIMIT 1"
          : "SELECT id, name, kind, path, start_line AS startLine FROM symbols WHERE id = ? OR name = ? ORDER BY exported DESC, start_line LIMIT 1",
        ...(focus.path && focusStartLine !== undefined
          ? [focus.path, focusStartLine, focusStartLine, focusStartLine]
          : [focus.symbol ?? "", focus.symbol ?? ""]),
      )[0]
    : undefined;

  if (focus && !focusedSymbol) {
    return { nodes: [], edges: [], partial: hasPartialCoverage(db) };
  }

  let focusId: string | undefined;
  let edgeRows: Row[];
  let candidateRows: Row[];
  let partial = hasPartialCoverage(db);

  if (focusedSymbol) {
    focusId = String(focusedSymbol.id);
    edgeRows = rows<Row>(
      db,
      "SELECT source_id AS source, target_id AS target, relation FROM edges WHERE source_id = ? OR target_id = ? ORDER BY relation, source_id, target_id LIMIT ?",
      focusId,
      focusId,
      edgeLimit + 1,
    );
    if (edgeRows.length > edgeLimit) partial = true;
    edgeRows = edgeRows.slice(0, edgeLimit);
    const adjacentIds = new Set<string>([focusId]);
    for (const edge of edgeRows) {
      adjacentIds.add(String(edge.source));
      adjacentIds.add(String(edge.target));
    }
    const boundedIds = [...adjacentIds].slice(0, nodeLimit);
    if (adjacentIds.size > boundedIds.length) partial = true;
    const allowedIds = new Set(boundedIds);
    edgeRows = edgeRows.filter(
      (edge) => allowedIds.has(String(edge.source)) && allowedIds.has(String(edge.target)),
    );
    candidateRows = rows<Row>(
      db,
      `SELECT s.id, s.name, s.kind, s.path, s.start_line AS startLine,
        (SELECT COUNT(*) FROM edges e WHERE e.source_id = s.id) +
        (SELECT COUNT(*) FROM edges e WHERE e.target_id = s.id) AS degree
        FROM symbols s WHERE s.id IN (${boundedIds.map(() => "?").join(",")})
        ORDER BY CASE WHEN s.id = ? THEN 0 ELSE 1 END, degree DESC, s.path, s.start_line`,
      ...boundedIds,
      focusId,
    );
  } else {
    candidateRows = rows<Row>(
      db,
      `WITH all_degrees AS (
        SELECT id, SUM(edge_count) AS degree FROM (
          SELECT source_id AS id, COUNT(*) AS edge_count FROM edges GROUP BY source_id
          UNION ALL
          SELECT target_id AS id, COUNT(*) AS edge_count FROM edges GROUP BY target_id
        ) GROUP BY id
      )
      SELECT s.id, s.name, s.kind, s.path, s.start_line AS startLine, all_degrees.degree
      FROM all_degrees JOIN symbols s ON s.id = all_degrees.id
      ORDER BY all_degrees.degree DESC, s.exported DESC, s.path, s.start_line
      LIMIT ?`,
      nodeLimit,
    );
    const ids = candidateRows.map((node) => String(node.id));
    edgeRows = ids.length
      ? rows<Row>(
          db,
          `SELECT source_id AS source, target_id AS target, relation FROM edges
            WHERE source_id IN (${ids.map(() => "?").join(",")})
              AND target_id IN (${ids.map(() => "?").join(",")})
            ORDER BY relation, source_id, target_id LIMIT ?`,
          ...ids,
          ...ids,
          edgeLimit + 1,
        )
      : [];
    if (edgeRows.length > edgeLimit) partial = true;
    edgeRows = edgeRows.slice(0, edgeLimit);
  }

  const totals = rows<Row>(
    db,
    "SELECT (SELECT COUNT(*) FROM symbols) AS symbols, (SELECT COUNT(*) FROM edges) AS edges",
  )[0];
  const nodes = candidateRows.map((node) => ({
    id: String(node.id),
    name: String(node.name),
    kind: String(node.kind),
    path: String(node.path),
    startLine: Number(node.startLine),
    degree: Number(node.degree ?? 0),
  }));
  const edges = edgeRows.map((edge) => ({
    source: String(edge.source),
    target: String(edge.target),
    relation: String(edge.relation),
  }));
  if (nodes.length < Number(totals?.symbols ?? 0) || edges.length < Number(totals?.edges ?? 0)) {
    partial = true;
  }
  return {
    nodes,
    edges,
    ...(focusId ? { focusId } : {}),
    partial,
  };
}
