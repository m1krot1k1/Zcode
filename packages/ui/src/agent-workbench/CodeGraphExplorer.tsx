import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  AlertCircle,
  Database,
  Focus,
  LoaderCircle,
  RefreshCw,
  Search,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type {
  CodeGraphOverview,
  CodeGraphNode,
  CodeIndexStatus,
  CodeSearchResult,
} from "./contract.js";

import "@xyflow/react/dist/style.css";

const EMPTY_GRAPH: CodeGraphOverview = { nodes: [], edges: [], partial: false };

interface FlowNodeData extends Record<string, unknown> {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  degree: number;
  showLabel: boolean;
}

type FlowNode = Node<FlowNodeData, "codeSymbol">;

const KIND_STYLES: Record<string, string> = {
  class: "border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  function: "border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  interface: "border-fuchsia-500/60 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
  method: "border-teal-500/60 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  file: "border-blue-500/60 bg-blue-500/10 text-blue-700 dark:text-blue-300",
};

const KIND_DOT_STYLES: Record<string, string> = {
  class: "bg-violet-500",
  function: "bg-sky-500",
  interface: "bg-fuchsia-500",
  method: "bg-teal-500",
  file: "bg-blue-500",
};

function CodeSymbolNode({ data, selected }: NodeProps<FlowNode>) {
  const style = KIND_STYLES[data.kind.toLowerCase()] ?? "border-border bg-card text-foreground";
  return (
    <div
      className={cn(
        "flex min-h-7 max-w-40 items-center gap-1.5 rounded-md border px-2 py-1 text-ui-xs shadow-sm",
        style,
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        data.showLabel ? "max-w-40" : "size-3 min-h-0 rounded-full border-2 p-0",
      )}
      title={`${data.name} · ${data.kind} · ${data.path}:${data.startLine} · ${data.degree} links`}
    >
      {data.showLabel ? (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-current opacity-70" />
          <span className="max-w-32 truncate font-medium">{data.name}</span>
        </>
      ) : null}
    </div>
  );
}

const nodeTypes: NodeTypes = { codeSymbol: CodeSymbolNode };

function createGraphNodes(graph: CodeGraphOverview, selectedId: string | null): FlowNode[] {
  const ordered = [...graph.nodes].sort((left, right) => right.degree - left.degree);
  const focusId = graph.focusId;
  const positions = new Map<string, { x: number; y: number }>();

  if (focusId && ordered.some((node) => node.id === focusId)) {
    positions.set(focusId, { x: 0, y: 0 });
    const incoming = graph.edges
      .filter((edge) => edge.target === focusId && edge.source !== focusId)
      .map((edge) => edge.source);
    const outgoing = graph.edges
      .filter((edge) => edge.source === focusId && edge.target !== focusId)
      .map((edge) => edge.target);
    const incomingIds = [...new Set(incoming)].filter((id) => !outgoing.includes(id));
    const outgoingIds = [...new Set(outgoing)];
    const positionColumn = (ids: string[], x: number) => {
      ids.forEach((id, index) => {
        positions.set(id, { x, y: (index - (ids.length - 1) / 2) * 64 });
      });
    };
    positionColumn(incomingIds, -280);
    positionColumn(outgoingIds, 280);
    for (const node of ordered) {
      if (!positions.has(node.id)) {
        positions.set(node.id, {
          x: 260 * Math.cos(2.399 * positions.size),
          y: 260 * Math.sin(2.399 * positions.size),
        });
      }
    }
  } else {
    ordered.forEach((node, index) => {
      const radius = 46 * Math.sqrt(index);
      const angle = index * 2.399963229728653;
      positions.set(node.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }

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
          showLabel: Boolean(focusId) || index < 10 || node.degree >= 8 || node.id === selectedId,
        },
        draggable: false,
        selectable: true,
      },
    ];
  });
}

function countByKind(nodes: CodeGraphNode[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
}

export function CodeGraphExplorer({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const services = useServices();
  const codeIndex = services.codeIntelligenceService;
  const { intl } = useZCodeIntl();
  const copy = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [statusLoadState, setStatusLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [graph, setGraph] = useState<CodeGraphOverview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [buildingIndex, setBuildingIndex] = useState(false);
  const [showCalls, setShowCalls] = useState(true);
  const [showImports, setShowImports] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const hasStatusRef = useRef(false);
  const workspaceRef = useMemo(
    () => ({
      workspacePath: workspacePath ?? "",
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );

  const refreshStatus = useCallback(async () => {
    if (!codeIndex || !workspacePath) return;
    if (!hasStatusRef.current) setStatusLoadState("loading");
    try {
      const next = await codeIndex.getStatus(workspaceRef);
      setStatus(next);
      hasStatusRef.current = true;
      setStatusLoadState("ready");
      setMessage(null);
    } catch {
      setMessage(copy("codeGraph.statusFailed"));
      if (!hasStatusRef.current) setStatusLoadState("failed");
    }
  }, [codeIndex, copy, workspacePath, workspaceRef]);

  const loadGraph = useCallback(
    async (focus?: { symbol?: string; path?: string; startLine?: number }) => {
      if (!codeIndex || !workspacePath) return;
      setLoading(true);
      setMessage(null);
      try {
        const next = await codeIndex.getGraphOverview({
          ...workspaceRef,
          ...(focus ? { focus } : {}),
          limit: 60,
        });
        setGraph(next);
        setSelectedId(next.focusId ?? next.nodes[0]?.id ?? null);
      } catch {
        setGraph(EMPTY_GRAPH);
        setMessage(copy("codeGraph.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [codeIndex, copy, workspacePath, workspaceRef],
  );

  useEffect(() => {
    setStatus(null);
    hasStatusRef.current = false;
    setStatusLoadState("loading");
    setGraph(null);
    setSelectedId(null);
    setResults([]);
    setMessage(null);
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!codeIndex || !workspacePath) return;
    void codeIndex.watchWorkspace(workspaceRef).then(refreshStatus).catch(() => {
      setMessage(copy("codeIndex.watchFailed"));
    });
  }, [codeIndex, copy, refreshStatus, workspacePath, workspaceRef]);

  useEffect(() => {
    if ((status?.state === "ready" || status?.state === "degraded") && graph === null)
      void loadGraph();
  }, [graph, loadGraph, status?.state]);

  useEffect(() => {
    if (status?.state !== "indexing" && !buildingIndex) return;
    const timer = window.setInterval(() => void refreshStatus(), 1200);
    return () => window.clearInterval(timer);
  }, [buildingIndex, refreshStatus, status?.state]);

  const buildIndex = async () => {
    if (!codeIndex || !workspacePath) return;
    setBuildingIndex(true);
    setMessage(null);
    try {
      setStatus(await codeIndex.indexWorkspace(workspaceRef));
      await loadGraph();
    } catch {
      setMessage(copy("codeGraph.indexFailed"));
    } finally {
      setBuildingIndex(false);
      await refreshStatus();
    }
  };

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!codeIndex || !query.trim()) return;
    setSearching(true);
    setMessage(null);
    try {
      const response = await codeIndex.search({ ...workspaceRef, query: query.trim(), limit: 12 });
      setResults(response.results);
      if (response.results.length === 0) setMessage(copy("codeGraph.noMatches"));
    } catch {
      setResults([]);
      setMessage(copy("codeGraph.searchFailed"));
    } finally {
      setSearching(false);
    }
  };

  const focusSearchResult = (result: CodeSearchResult) => {
    void loadGraph({
      ...(result.symbolName ? { symbol: result.symbolName } : {}),
      path: result.path,
      startLine: result.startLine,
    });
    setResults([]);
  };

  const nodes = graph?.nodes ?? [];
  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const visibleEdges = useMemo(
    () =>
      (graph?.edges ?? []).filter((edge) => (edge.relation === "calls" ? showCalls : showImports)),
    [graph, showCalls, showImports],
  );
  const flowNodes = useMemo(
    () => createGraphNodes(graph ?? EMPTY_GRAPH, selectedId),
    [graph, selectedId],
  );
  const flowNodeIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  const flowEdges = useMemo<Edge[]>(
    () =>
      visibleEdges
        .filter((edge) => flowNodeIds.has(edge.source) && flowNodeIds.has(edge.target))
        .map((edge, index) => {
          const color = edge.relation === "calls" ? "var(--primary)" : "var(--muted-foreground)";
          return {
            id: `${edge.source}:${edge.target}:${edge.relation}:${index}`,
            source: edge.source,
            target: edge.target,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed, color },
            style: {
              stroke: color,
              strokeWidth: edge.relation === "calls" ? 1.6 : 1,
              opacity: 0.62,
            },
            interactionWidth: 12,
          };
        }),
    [flowNodeIds, visibleEdges],
  );
  const kindCounts = useMemo(() => countByKind(nodes), [nodes]);
  const inbound = graph?.edges.filter((edge) => edge.target === selectedId) ?? [];
  const outbound = graph?.edges.filter((edge) => edge.source === selectedId) ?? [];

  if (!workspacePath) {
    return <GraphMessage icon={<Workflow />} text={copy("codeGraph.workspaceRequired")} />;
  }
  if (!codeIndex) {
    return <GraphMessage icon={<Database />} text={copy("codeGraph.unavailable")} />;
  }

  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4"
      data-testid="usage-code-graph"
    >
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <Workflow className="size-4 text-primary" />
        <h2 className="text-ui-base font-semibold">{copy("codeGraph.title")}</h2>
        <span
          role="status"
          className={cn(
            "ml-auto rounded-full bg-muted px-2.5 py-1 text-ui-xs text-muted-foreground",
            statusLoadState === "failed" && "text-destructive",
          )}
        >
          {status
            ? copy(`codeGraph.state.${status.state}`)
            : copy(statusLoadState === "failed" ? "codeGraph.statusFailed" : "codeGraph.statusLoading")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto gap-1.5"
          disabled={loading || buildingIndex || statusLoadState !== "ready" || status?.state === "indexing"}
          onClick={() => void loadGraph()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          {copy("codeGraph.refresh")}
        </Button>
      </header>
      <p className="mb-4 text-ui-xs text-muted-foreground">{copy("codeGraph.description")}</p>

      <div
        className="mb-3 flex min-h-9 flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted/40 px-3 py-2 text-ui-xs"
        data-testid="usage-code-graph-stats"
        aria-busy={statusLoadState === "loading"}
      >
        {status ? (
          <>
            <span>{copy("codeGraph.files", { count: status.counts.files })}</span>
            <span>{copy("codeGraph.symbols", { count: status.counts.symbols })}</span>
            <span>{copy("codeGraph.links", { count: status.counts.edges })}</span>
            {status.partial || graph?.partial ? (
              <span className="ml-auto flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertCircle className="size-3.5" /> {copy("codeGraph.partial")}
              </span>
            ) : null}
          </>
        ) : (
          <span className="flex items-center gap-2 text-muted-foreground">
            {statusLoadState === "loading" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <AlertCircle className="size-3.5 text-destructive" />
            )}
            {copy(statusLoadState === "failed" ? "codeGraph.statusFailed" : "codeGraph.statusLoading")}
          </span>
        )}
      </div>

      <form onSubmit={(event) => void runSearch(event)} className="relative mb-3 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={copy("codeGraph.searchPlaceholder")}
            className="pl-9"
            aria-label={copy("codeGraph.searchPlaceholder")}
            data-testid="usage-code-graph-search"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={searching || !query.trim()}>
          {searching ? <LoaderCircle className="size-4 animate-spin" /> : copy("codeGraph.search")}
        </Button>
        {results.length > 0 ? (
          <div className="absolute left-0 right-20 top-[calc(100%+6px)] z-20 max-h-60 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
            {results.map((result, index) => (
              <button
                key={`${result.path}:${result.startLine}:${index}`}
                type="button"
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-accent"
                onClick={() => focusSearchResult(result)}
              >
                <span className="max-w-full truncate text-ui-xs font-medium text-foreground">
                  {result.symbolName ?? result.path}
                </span>
                <span className="max-w-full truncate text-ui-xs text-muted-foreground">
                  {result.path}:{result.startLine}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </form>

      {message ? (
        <p role="status" className="mb-3 text-ui-xs text-amber-600">
          {message}
        </p>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-[136px_minmax(0,1fr)_208px]">
        <aside className="rounded-lg border border-border bg-background/60 p-2.5">
          <h3 className="mb-2 text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {copy("codeGraph.filters")}
          </h3>
          <div className="space-y-1.5">
            <FilterToggle
              label={copy("codeGraph.calls")}
              active={showCalls}
              onClick={() => setShowCalls((value) => !value)}
              color="bg-primary"
            />
            <FilterToggle
              label={copy("codeGraph.imports")}
              active={showImports}
              onClick={() => setShowImports((value) => !value)}
              color="bg-muted-foreground"
            />
          </div>
          <div className="my-3 border-t border-border" />
          <h3 className="mb-2 text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {copy("codeGraph.nodeTypes")}
          </h3>
          <div className="space-y-1.5">
            {kindCounts.length ? (
              kindCounts.map(([kind, count]) => (
                <div key={kind} className="flex items-center justify-between gap-1 text-ui-xs">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        KIND_DOT_STYLES[kind.toLowerCase()] ?? "bg-border",
                      )}
                    />
                    <span className="truncate">{kind}</span>
                  </span>
                  <span className="text-muted-foreground/80">{count}</span>
                </div>
              ))
            ) : (
              <p className="text-ui-xs text-muted-foreground">{copy("codeGraph.noNodes")}</p>
            )}
          </div>
          <div className="my-3 border-t border-border" />
          <p className="text-ui-xs leading-relaxed text-muted-foreground">
            {copy("codeGraph.legendHint")}
          </p>
        </aside>

        <main
          className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-background"
          data-testid="usage-code-graph-canvas"
        >
          {statusLoadState === "loading" ||
          loading ||
          (status !== null && (status.state === "ready" || status.state === "degraded") && graph === null) ? (
            <div className="flex h-[440px] items-center justify-center gap-2 text-ui-sm text-muted-foreground xl:h-[600px]">
              <LoaderCircle className="size-4 animate-spin" /> {copy("codeGraph.loading")}
            </div>
          ) : statusLoadState === "failed" || status === null ? (
            <div className="flex h-[440px] flex-col items-center justify-center gap-3 px-6 text-center xl:h-[600px]">
              <AlertCircle className="size-7 text-destructive" />
              <p className="max-w-sm text-ui-sm text-muted-foreground">{copy("codeGraph.statusFailed")}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void refreshStatus()}>
                <RefreshCw className="mr-1.5 size-3.5" /> {copy("codeGraph.retryStatus")}
              </Button>
            </div>
          ) : status.state === "indexing" || buildingIndex ? (
            <div className="flex h-[440px] flex-col items-center justify-center gap-2 text-center text-ui-sm text-muted-foreground xl:h-[600px]">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              <span>{copy("codeGraph.indexing")}</span>
              {status.progress ? (
                <span className="text-ui-xs">
                  {status.progress.indexedFiles} / {status.progress.discoveredFiles}
                </span>
              ) : null}
            </div>
          ) : status.counts.symbols === 0 ? (
            <div className="flex h-[440px] flex-col items-center justify-center gap-3 px-6 text-center xl:h-[600px]">
              <Database className="size-8 text-muted-foreground" />
              <div>
                <h3 className="text-ui-sm font-medium">{copy("codeGraph.emptyTitle")}</h3>
                <p className="mt-1 max-w-sm text-ui-xs text-muted-foreground">
                  {copy("codeGraph.emptyDescription")}
                </p>
              </div>
              <Button type="button" disabled={buildingIndex} onClick={() => void buildIndex()}>
                {buildingIndex ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
                {copy("codeGraph.buildIndex")}
              </Button>
            </div>
          ) : nodes.length === 0 ? (
            <div className="flex h-[440px] flex-col items-center justify-center gap-2 px-6 text-center xl:h-[600px]">
              <Database className="size-7 text-muted-foreground" />
              <h3 className="text-ui-sm font-medium">{copy("codeGraph.noResolvedGraph")}</h3>
              <p className="max-w-sm text-ui-xs text-muted-foreground">
                {copy("codeGraph.noResolvedGraphDescription")}
              </p>
              <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void loadGraph()}>
                {copy("codeGraph.refresh")}
              </Button>
            </div>
          ) : (
            <div className="h-[440px] xl:h-[600px]">
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.3, minZoom: 0.18, maxZoom: 1.3 }}
                minZoom={0.08}
                maxZoom={1.6}
                nodesConnectable={false}
                nodesDraggable={false}
                elementsSelectable
                onNodeClick={(_event, node) => setSelectedId(node.id)}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                <Controls
                  position="bottom-left"
                  showInteractive={false}
                  className="overflow-hidden rounded-lg border border-border shadow-sm [&_.react-flow__controls-button]:!border-border [&_.react-flow__controls-button]:!bg-card [&_.react-flow__controls-button]:!text-foreground [&_.react-flow__controls-button>svg]:!fill-current [&_.react-flow__controls-button:hover]:!bg-muted"
                />
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  style={{ width: 132, height: 88 }}
                  nodeColor={(node) =>
                    node.id === selectedId ? "var(--primary)" : "var(--muted-foreground)"
                  }
                  maskColor="color-mix(in srgb, var(--background) 76%, transparent)"
                  className="!rounded-lg !border !border-border !bg-card/90 shadow-sm"
                />
              </ReactFlow>
            </div>
          )}
        </main>

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
                onClick={() => void loadGraph({ symbol: selectedNode.id })}
              >
                <Focus className="size-3.5" /> {copy("codeGraph.focusNode")}
              </Button>
              <div className="my-3 border-t border-border" />
              <RelatedSymbols
                title={copy("codeGraph.incoming")}
                empty={copy("codeGraph.noRelations")}
                edges={inbound}
                nodes={nodes}
                direction="incoming"
                onSelect={(node) => void loadGraph({ symbol: node.id })}
              />
              <RelatedSymbols
                title={copy("codeGraph.outgoing")}
                empty={copy("codeGraph.noRelations")}
                edges={outbound}
                nodes={nodes}
                direction="outgoing"
                onSelect={(node) => void loadGraph({ symbol: node.id })}
              />
            </>
          ) : (
            <p className="text-ui-xs leading-relaxed text-muted-foreground">
              {copy("codeGraph.selectNode")}
            </p>
          )}
        </aside>
      </div>
      {graph?.partial ? (
        <p className="mt-3 text-ui-xs text-muted-foreground">{copy("codeGraph.boundedHint")}</p>
      ) : null}
    </section>
  );
}

function FilterToggle({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ui-xs transition-colors hover:bg-accent",
        active ? "text-foreground" : "text-muted-foreground opacity-60",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", color)} />
      <span className="truncate">{label}</span>
    </button>
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

function GraphMessage({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center">
      <div className="max-w-md">
        <span className="mx-auto mb-3 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </span>
        <p className="text-ui-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
