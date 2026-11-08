import { Focus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { CodeGraphNode, CodeGraphOverview } from "./contract.js";

export function CodeGraphInspector({
  selectedNode,
  loading,
  visibleNodes,
  inbound,
  outbound,
  copy,
  onFocus,
}: {
  selectedNode: CodeGraphNode | null;
  loading: boolean;
  visibleNodes: CodeGraphNode[];
  inbound: CodeGraphOverview["edges"];
  outbound: CodeGraphOverview["edges"];
  copy: (id: string, values?: Record<string, string | number>) => string;
  onFocus: (symbol: string) => void;
}) {
  return (
    <aside className="min-h-48 rounded-lg border border-border bg-background/60 p-3">
      <div className="mb-3 flex items-center gap-2">
        <Focus className="size-4 text-primary" />
        <h3 className="text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {copy("codeGraph.inspector")}
        </h3>
      </div>
      {selectedNode ? (
        <>
          <p className="break-words text-ui-sm font-semibold">{selectedNode.name}</p>
          <p className="mt-1 break-all text-ui-xs text-muted-foreground">
            {selectedNode.path}:{selectedNode.startLine}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-md border border-border px-1.5 py-0.5 text-ui-xs">
              {selectedNode.kind}
            </span>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-ui-xs">
              {copy("codeGraph.linkCount", { count: selectedNode.degree })}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3 w-full gap-1.5"
            disabled={loading}
            onClick={() => onFocus(selectedNode.id)}
          >
            <Focus className="size-3.5" /> {copy("codeGraph.focusNode")}
          </Button>
          <div className="my-3 border-t border-border" />
          <RelatedSymbols
            title={copy("codeGraph.incoming")}
            empty={copy("codeGraph.noRelations")}
            edges={inbound}
            nodes={visibleNodes}
            direction="incoming"
            onSelect={(node) => onFocus(node.id)}
          />
          <RelatedSymbols
            title={copy("codeGraph.outgoing")}
            empty={copy("codeGraph.noRelations")}
            edges={outbound}
            nodes={visibleNodes}
            direction="outgoing"
            onSelect={(node) => onFocus(node.id)}
          />
        </>
      ) : (
        <p className="text-ui-xs leading-relaxed text-muted-foreground">
          {copy("codeGraph.selectNode")}
        </p>
      )}
    </aside>
  );
}

function RelatedSymbols({
  title,
  empty,
  edges,
  nodes,
  direction,
  onSelect,
}: {
  title: string;
  empty: string;
  edges: CodeGraphOverview["edges"];
  nodes: CodeGraphNode[];
  direction: "incoming" | "outgoing";
  onSelect: (node: CodeGraphNode) => void;
}) {
  const relatedIds = [
    ...new Set(edges.map((edge) => (direction === "incoming" ? edge.source : edge.target))),
  ].filter(Boolean);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const related = relatedIds.flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [node] : [];
  });

  return (
    <section className="mb-3 last:mb-0">
      <h4 className="mb-1 text-ui-xs font-medium">{title}</h4>
      {related.length ? (
        <div className="max-h-32 space-y-0.5 overflow-y-auto">
          {related.slice(0, 8).map((node) => (
            <button
              key={node.id}
              type="button"
              className="block w-full truncate rounded px-1.5 py-1 text-left text-ui-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              title={`${node.path}:${node.startLine}`}
              onClick={() => onSelect(node)}
            >
              {node.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-ui-xs text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}
