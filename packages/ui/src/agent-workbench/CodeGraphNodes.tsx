import { cn } from "@/components/lib/utils.js";
import {
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import type { CodeGraphNode, CodeGraphOverview } from "./contract.js";

interface FlowNodeData extends Record<string, unknown> {
  name: string;
  kind: string;
  kindLabel: string;
  path: string;
  startLine: number;
  degree: number;
  linksLabel: string;
  showLabel: boolean;
}

type FlowNode = Node<FlowNodeData, "codeSymbol">;
export type GraphCopy = (id: string, values?: Record<string, string | number>) => string;

export const KIND_DOT_STYLES: Record<string, string> = {
  module: "bg-muted-foreground",
  file: "bg-blue-500",
  class: "bg-violet-500",
  function: "bg-sky-500",
  interface: "bg-fuchsia-500",
  method: "bg-teal-500",
  property: "bg-amber-500",
};

function CodeSymbolNode({ data, selected }: NodeProps<FlowNode>) {
  const dot = KIND_DOT_STYLES[data.kind.toLowerCase()] ?? "bg-muted-foreground";
  return (
    <div
      className={cn(
        "group relative flex size-4 items-center justify-center rounded-full border-2 border-background shadow-sm",
        dot,
        selected && "z-20 ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
      title={`${data.name} · ${data.kindLabel} · ${data.path}:${data.startLine} · ${data.linksLabel}`}
    >
      {data.showLabel ? (
        <span className="pointer-events-none absolute left-4 top-1/2 z-10 max-w-48 -translate-y-1/2 truncate rounded-md border border-border bg-card px-1.5 py-0.5 text-ui-xs font-medium text-foreground shadow-sm">
          {data.name}
        </span>
      ) : null}
    </div>
  );
}

export const CODE_GRAPH_NODE_TYPES: NodeTypes = { codeSymbol: CodeSymbolNode };

export function graphKindLabel(kind: string, copy: GraphCopy): string {
  const id = `codeGraph.kind.${kind.toLowerCase()}`;
  const label = copy(id);
  return label === id ? kind : label;
}

export function createGraphNodes(
  graph: CodeGraphOverview,
  selectedId: string | null,
  copy: GraphCopy,
): FlowNode[] {
  const ordered = [...graph.nodes].sort((left, right) => right.degree - left.degree);
  const positions = new Map<string, { x: number; y: number }>();
  if (!ordered.length) return [];

  const nodeIndex = new Map(ordered.map((node, index) => [node.id, index]));
  const centerId = graph.focusId ?? ordered[0]!.id;
  const centerIndex = nodeIndex.get(centerId) ?? 0;
  const initial = ordered.map((_, index) => {
    const angle = index * 2.399963229728653;
    const radius = index === centerIndex ? 0 : 170 + 28 * Math.sqrt(index + 1);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const velocity = ordered.map(() => ({ x: 0, y: 0 }));
  const forces = ordered.map(() => ({ x: 0, y: 0 }));
  const connectedEdges = graph.edges.flatMap((edge) => {
    const source = nodeIndex.get(edge.source);
    const target = nodeIndex.get(edge.target);
    return source === undefined || target === undefined ? [] : [[source, target] as const];
  });
  const idealLength = Math.max(96, Math.min(168, 620 / Math.sqrt(ordered.length)));

  for (let iteration = 0; iteration < 64; iteration += 1) {
    for (const force of forces) {
      force.x = 0;
      force.y = 0;
    }
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        let dx = initial[left]!.x - initial[right]!.x;
        let dy = initial[left]!.y - initial[right]!.y;
        const distanceSquared = Math.max(dx * dx + dy * dy, 36);
        const distance = Math.sqrt(distanceSquared);
        const repulsion = (idealLength * idealLength * 0.78) / distanceSquared;
        dx = (dx / distance) * repulsion;
        dy = (dy / distance) * repulsion;
        forces[left]!.x += dx;
        forces[left]!.y += dy;
        forces[right]!.x -= dx;
        forces[right]!.y -= dy;
      }
    }
    for (const [source, target] of connectedEdges) {
      const dx = initial[target]!.x - initial[source]!.x;
      const dy = initial[target]!.y - initial[source]!.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const attraction = ((distance - idealLength) * 0.014) / Math.sqrt(connectedEdges.length || 1);
      const fx = (dx / distance) * attraction;
      const fy = (dy / distance) * attraction;
      forces[source]!.x += fx;
      forces[source]!.y += fy;
      forces[target]!.x -= fx;
      forces[target]!.y -= fy;
    }
    const cooling = 1 - iteration / 72;
    for (let index = 0; index < ordered.length; index += 1) {
      if (index === centerIndex) continue;
      const point = initial[index]!;
      const force = forces[index]!;
      const drift = Math.max(0.001, Math.min(0.18, cooling * 0.12));
      force.x -= point.x * 0.002;
      force.y -= point.y * 0.002;
      velocity[index]!.x = (velocity[index]!.x + force.x) * 0.62;
      velocity[index]!.y = (velocity[index]!.y + force.y) * 0.62;
      point.x += Math.max(-18, Math.min(18, velocity[index]!.x * drift));
      point.y += Math.max(-18, Math.min(18, velocity[index]!.y * drift));
    }
  }

  initial.forEach((point, index) => {
    positions.set(ordered[index]!.id, point);
  });

  return ordered.flatMap((node, index) => {
    const position = positions.get(node.id);
    if (!position) return [];
    return [
      {
        id: node.id,
        type: "codeSymbol",
        position,
        data: {
          ...node,
          kindLabel: graphKindLabel(node.kind, copy),
          linksLabel: copy("codeGraph.linkCount", { count: node.degree }),
          showLabel:
            Boolean(graph.focusId) || index < 10 || node.degree >= 8 || node.id === selectedId,
        },
        draggable: false,
        selectable: true,
      },
    ];
  });
}

export function countByKind(nodes: CodeGraphNode[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}
