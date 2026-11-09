import { cn } from "@/components/lib/utils.js";
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import type { CodeGraphNode, CodeGraphOverview } from "./contract.js";

interface FlowNodeData extends Record<string, unknown> {
  name: string;
  shortLabel: string;
  kind: string;
  kindLabel: string;
  path: string;
  startLine: number;
  degree: number;
  linksLabel: string;
  dimmed: boolean;
  accent: string;
  moduleLike: boolean;
}

type FlowNode = Node<FlowNodeData, "codeSymbol">;
type GraphCopy = (id: string, values?: Record<string, string | number>) => string;
type Point = { x: number; y: number };

const MODULE_WIDTH = 92;
const MODULE_HEIGHT = 78;
const PILL_HEIGHT = 34;

export const KIND_DOT_STYLES: Record<string, string> = {
  module: "bg-cyan-400",
  file: "bg-cyan-400",
  class: "bg-fuchsia-400",
  function: "bg-cyan-400",
  interface: "bg-fuchsia-400",
  method: "bg-sky-400",
  property: "bg-emerald-400",
};

const KIND_ACCENT: Record<string, string> = {
  module: "var(--color-terminal-bright-cyan)",
  file: "var(--color-terminal-bright-cyan)",
  class: "var(--color-icon-purple)",
  function: "var(--color-terminal-bright-cyan)",
  interface: "var(--color-icon-purple)",
  method: "var(--color-terminal-bright-blue)",
  property: "var(--color-terminal-bright-green)",
};

function shortLabel(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function accentFor(kind: string): string {
  return KIND_ACCENT[kind.toLowerCase()] ?? "var(--color-terminal-bright-cyan)";
}

function CodeSymbolNode({ data, selected }: NodeProps<FlowNode>) {
  const description = `${data.name}, ${data.kindLabel}, ${data.path}:${data.startLine}, ${data.linksLabel}`;
  const glow = selected
    ? `0 0 0 4px color-mix(in oklab, ${data.accent} 32%, transparent), 0 0 22px ${data.accent}`
    : `0 0 14px color-mix(in oklab, ${data.accent} 55%, transparent)`;
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center transition-opacity duration-300",
        data.moduleLike ? "flex-col gap-1" : "",
        data.dimmed ? "opacity-25" : "opacity-100",
      )}
      title={description}
      aria-label={description}
    >
      {/* 自定义节点若不画出 Handle，React Flow 没有可见端点，边也会没有着落。 */}
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2 !border !border-background !bg-foreground"
      />
      {data.moduleLike ? (
        <>
          <div
            className="size-11 rounded-full border bg-background/80 backdrop-blur-sm"
            style={{ borderColor: data.accent, boxShadow: glow }}
          />
          <span
            className="max-w-full truncate text-[10px] font-medium tracking-tight"
            style={{ color: data.accent }}
          >
            {data.shortLabel}
          </span>
        </>
      ) : (
        <div
          className="flex h-8 w-full items-center justify-center rounded-full border bg-background/80 px-3 text-ui-xs font-medium tracking-tight backdrop-blur-sm"
          style={{ borderColor: data.accent, boxShadow: glow, color: data.accent }}
        >
          <span className="max-w-full truncate">{data.shortLabel}</span>
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2 !border !border-background !bg-foreground"
      />
    </div>
  );
}

export const CODE_GRAPH_NODE_TYPES: NodeTypes = { codeSymbol: CodeSymbolNode };

export function graphKindLabel(kind: string, copy: GraphCopy): string {
  const id = `codeGraph.kind.${kind.toLowerCase()}`;
  const label = copy(id);
  return label === id ? kind : label;
}

function clusterKey(node: CodeGraphNode): string {
  const path = node.path.replaceAll("\\", "/");
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : path || node.kind;
}

function hashId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 33 + id.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function bounds(positions: Map<string, Point>) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of positions.values()) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY };
}

function constellationPositions(
  nodes: CodeGraphNode[],
  edges: CodeGraphOverview["edges"],
): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (!nodes.length) return positions;
  if (nodes.length === 1) {
    positions.set(nodes[0]!.id, { x: 0, y: 0 });
    return positions;
  }

  // 网格把符号排成表格。同目录先落在一圈上，再做有限次斥力/引力，
  // 最后拉开到标签和曲线边都读得清的画布。
  const groups = new Map<string, CodeGraphNode[]>();
  for (const node of nodes) {
    const key = clusterKey(node);
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }
  const groupKeys = [...groups.keys()].sort();
  const ring = 260 + groupKeys.length * 48;
  groupKeys.forEach((key, groupIndex) => {
    const members = groups.get(key) ?? [];
    const groupAngle = (groupIndex / groupKeys.length) * Math.PI * 2;
    const originX = Math.cos(groupAngle) * ring;
    const originY = Math.sin(groupAngle) * ring;
    members.forEach((node, memberIndex) => {
      const angle = (memberIndex / members.length) * Math.PI * 2 + groupIndex * 0.4;
      const radius = 96 + (memberIndex % 4) * 28;
      const jitter = (hashId(node.id) % 17) - 8;
      positions.set(node.id, {
        x: originX + Math.cos(angle) * radius + jitter,
        y: originY + Math.sin(angle) * radius - jitter,
      });
    });
  });

  const ids = nodes.map((node) => node.id);
  const present = new Set(ids);
  const links = edges.filter(
    (edge) => present.has(edge.source) && present.has(edge.target) && edge.source !== edge.target,
  );
  const repulsion = 8400;
  const attraction = 0.02;
  const ideal = 168;
  const iterations = 72;
  for (let step = 0; step < iterations; step += 1) {
    const shift = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const a = positions.get(ids[left]!)!;
        const b = positions.get(ids[right]!)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1) {
          dx = ((left + 1) * 0.37) % 2 === 0 ? 1 : -1;
          dy = right + 1;
          distance = Math.hypot(dx, dy);
        }
        const force = repulsion / (distance * distance);
        const ux = (dx / distance) * force;
        const uy = (dy / distance) * force;
        const da = shift.get(ids[left]!)!;
        const db = shift.get(ids[right]!)!;
        da.x += ux;
        da.y += uy;
        db.x -= ux;
        db.y -= uy;
      }
    }
    for (const edge of links) {
      const a = positions.get(edge.source)!;
      const b = positions.get(edge.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const force = attraction * (distance - ideal);
      const ux = (dx / distance) * force;
      const uy = (dy / distance) * force;
      const da = shift.get(edge.source)!;
      const db = shift.get(edge.target)!;
      da.x += ux;
      da.y += uy;
      db.x -= ux;
      db.y -= uy;
    }
    const temperature = 48 * (1 - step / iterations);
    for (const id of ids) {
      const point = positions.get(id)!;
      const delta = shift.get(id)!;
      const magnitude = Math.hypot(delta.x, delta.y) || 1;
      const stepLength = Math.min(magnitude, temperature);
      point.x += (delta.x / magnitude) * stepLength;
      point.y += (delta.y / magnitude) * stepLength;
    }
  }

  let box = bounds(positions);
  if (box.maxX - box.minX < 140 || box.maxY - box.minY < 100) {
    ids.forEach((id, index) => {
      const turn = index * 0.7;
      const radius = 90 + index * 42;
      positions.set(id, { x: Math.cos(turn) * radius, y: Math.sin(turn) * radius });
    });
    box = bounds(positions);
  }
  const width = Math.max(box.maxX - box.minX, 1);
  const height = Math.max(box.maxY - box.minY, 1);
  const targetWidth = Math.max(980, nodes.length * 42);
  const targetHeight = Math.max(640, nodes.length * 28);
  for (const point of positions.values()) {
    point.x = ((point.x - box.minX) / width) * targetWidth;
    point.y = ((point.y - box.minY) / height) * targetHeight;
  }

  const occupied = new Set<string>();
  for (const point of positions.values()) {
    let key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    let bump = 0;
    while (occupied.has(key)) {
      bump += 1;
      point.x += 36;
      point.y += 22 * bump;
      key = `${Math.round(point.x)}:${Math.round(point.y)}`;
    }
    occupied.add(key);
  }
  return positions;
}

function neighborhood(
  nodes: CodeGraphNode[],
  edges: CodeGraphOverview["edges"],
  focusId: string | null,
): Set<string> | null {
  if (!focusId) return null;
  const hot = new Set<string>([focusId]);
  const present = new Set(nodes.map((node) => node.id));
  if (!present.has(focusId)) return null;
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    if (edge.source === focusId) hot.add(edge.target);
    if (edge.target === focusId) hot.add(edge.source);
  }
  return hot;
}

export function createGraphNodes(
  graph: CodeGraphOverview,
  selectedId: string | null,
  copy: GraphCopy,
  focusId?: string | null,
): FlowNode[] {
  if (!graph.nodes.length) return [];
  const positions = constellationPositions(graph.nodes, graph.edges);
  const hot = neighborhood(graph.nodes, graph.edges, focusId ?? null);
  return graph.nodes.map((node) => {
    const kind = node.kind.toLowerCase();
    const moduleLike = kind === "module" || kind === "file";
    const label = shortLabel(node.name);
    const width = moduleLike ? MODULE_WIDTH : Math.min(188, Math.max(88, 28 + label.length * 7.2));
    const dimmed = hot !== null && !hot.has(node.id);
    return {
      id: node.id,
      type: "codeSymbol",
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      width,
      height: moduleLike ? MODULE_HEIGHT : PILL_HEIGHT,
      selected: node.id === selectedId,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      className: dimmed ? "is-dim" : node.id === selectedId ? "is-hot" : undefined,
      data: {
        ...node,
        shortLabel: label,
        kindLabel: graphKindLabel(node.kind, copy),
        linksLabel: copy("codeGraph.linkCount", { count: node.degree }),
        dimmed,
        accent: accentFor(node.kind),
        moduleLike,
      },
      ariaLabel: `${node.name}, ${graphKindLabel(node.kind, copy)}, ${node.path}:${node.startLine}`,
      draggable: true,
      selectable: true,
    };
  });
}

export function countByKind(nodes: CodeGraphNode[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}
