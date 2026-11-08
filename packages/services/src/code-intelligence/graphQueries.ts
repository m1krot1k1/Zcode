import type { CodeGraphEdge, CodeGraphOverview, CodeWorkspaceRef } from "./contract.js";
import { hasPartialCoverage, rows, type CodeIndexDatabase, type Row } from "./database.js";

const MAX_GRAPH_NODES = 80;
const MAX_GRAPH_EDGES = 180;

interface GraphEdgeRow extends Row {
  source: string;
  target: string;
  relation: CodeGraphEdge["relation"];
}

function graphNodeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 60;
  return Math.max(10, Math.min(MAX_GRAPH_NODES, Math.floor(limit)));
}

function readConnectedOverview(
  db: CodeIndexDatabase,
  seed: Row,
  nodeLimit: number,
  edgeLimit: number,
): { nodes: Row[]; edges: GraphEdgeRow[]; partial: boolean } {
  const selected = new Map<string, Row>([[String(seed.id), seed]]);
  const frontier = [String(seed.id)];
  const spanningEdges = new Map<string, GraphEdgeRow>();

  while (frontier.length && selected.size < nodeLimit) {
    const batch = frontier.splice(0, 32);
    const existingIds = [...selected.keys()];
    const remaining = nodeLimit - selected.size;
    const neighbors = rows<Row>(
      db,
      `WITH all_degrees AS (
        SELECT id, SUM(edge_count) AS degree FROM (
          SELECT source_id AS id, COUNT(*) AS edge_count FROM edges GROUP BY source_id
          UNION ALL
          SELECT target_id AS id, COUNT(*) AS edge_count FROM edges GROUP BY target_id
        ) GROUP BY id
      ), neighbor_edges AS (
        SELECT CASE WHEN e.source_id IN (${batch.map(() => "?").join(",")})
                    THEN e.target_id ELSE e.source_id END AS neighbor_id,
               e.source_id, e.target_id, e.relation,
               ROW_NUMBER() OVER (
                 PARTITION BY CASE WHEN e.source_id IN (${batch.map(() => "?").join(",")})
                                   THEN e.target_id ELSE e.source_id END
                 ORDER BY e.relation, e.source_id, e.target_id
               ) AS edge_rank
        FROM edges e
        WHERE e.source_id IN (${batch.map(() => "?").join(",")})
           OR e.target_id IN (${batch.map(() => "?").join(",")})
      )
      SELECT s.id, s.name, s.kind, s.path, s.start_line AS startLine,
             COALESCE(d.degree, 0) AS degree,
             n.source_id AS parentSource, n.target_id AS parentTarget, n.relation AS parentRelation
      FROM neighbor_edges n
      JOIN symbols s ON s.id = n.neighbor_id
      LEFT JOIN all_degrees d ON d.id = s.id
      WHERE n.edge_rank = 1 AND s.id NOT IN (${existingIds.map(() => "?").join(",")})
      ORDER BY COALESCE(d.degree, 0) DESC, s.exported DESC, s.path, s.start_line
      LIMIT ?`,
      ...batch,
      ...batch,
      ...batch,
      ...batch,
      ...existingIds,
      remaining,
    );
    for (const node of neighbors) {
      const id = String(node.id);
      if (selected.has(id)) continue;
      selected.set(id, node);
      frontier.push(id);
      const edge: GraphEdgeRow = {
        source: String(node.parentSource),
        target: String(node.parentTarget),
        relation: String(node.parentRelation) as CodeGraphEdge["relation"],
      };
      spanningEdges.set(`${edge.source}:${edge.target}:${edge.relation}`, edge);
      if (selected.size >= nodeLimit) break;
    }
  }

  const ids = [...selected.keys()];
  const edges = rows<GraphEdgeRow>(
    db,
    `SELECT source_id AS source, target_id AS target, relation FROM edges
     WHERE source_id IN (${ids.map(() => "?").join(",")})
       AND target_id IN (${ids.map(() => "?").join(",")})
     ORDER BY relation, source_id, target_id LIMIT ?`,
    ...ids,
    ...ids,
    edgeLimit + 1,
  );
  const extraEdges = edges.filter(
    (edge) => !spanningEdges.has(`${edge.source}:${edge.target}:${edge.relation}`),
  );
  const orderedEdges = [...spanningEdges.values(), ...extraEdges].slice(0, edgeLimit);
  return {
    nodes: [...selected.values()],
    edges: orderedEdges,
    partial:
      selected.size === nodeLimit || edges.length > edgeLimit || orderedEdges.length < edges.length,
  };
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
    const seed = rows<Row>(
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
      LIMIT 1`,
    )[0];
    if (seed) {
      const overview = readConnectedOverview(db, seed, nodeLimit, edgeLimit);
      candidateRows = overview.nodes;
      edgeRows = overview.edges;
      partial ||= overview.partial;
    } else {
      candidateRows = [];
      edgeRows = [];
    }
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
    relation: String(edge.relation) as CodeGraphEdge["relation"],
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
