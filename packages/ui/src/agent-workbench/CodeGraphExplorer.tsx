import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Background, BackgroundVariant, Controls, ReactFlow, type Edge } from "@xyflow/react";
import { AlertCircle, Database, LoaderCircle, RefreshCw, Search, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { CodeGraphOverview, CodeIndexStatus, CodeSearchResult } from "./contract.js";
import { CodeGraphInspector } from "./CodeGraphInspector.js";
import {
  CODE_GRAPH_NODE_TYPES,
  countByKind,
  createGraphNodes,
  graphKindLabel,
  KIND_DOT_STYLES,
} from "./CodeGraphNodes.js";

import "@xyflow/react/dist/style.css";

const EMPTY_GRAPH: CodeGraphOverview = { nodes: [], edges: [], partial: false };

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
  const labelKind = useCallback((kind: string) => graphKindLabel(kind, copy), [copy]);
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [statusLoadState, setStatusLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [graph, setGraph] = useState<CodeGraphOverview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [graphLoadFailed, setGraphLoadFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [buildingIndex, setBuildingIndex] = useState(false);
  const [showCalls, setShowCalls] = useState(true);
  const [showImports, setShowImports] = useState(true);
  const [showContains, setShowContains] = useState(true);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [dragRevision, setDragRevision] = useState(0);
  const hasStatusRef = useRef(false);
  const statusRequestRef = useRef(0);
  const graphRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const buildRequestRef = useRef(0);
  const graphGenerationRef = useRef<number | null>(null);
  const dragPositions = useRef(new Map<string, { x: number; y: number }>());
  const layoutKeyRef = useRef("");
  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const workspaceRef = useMemo(
    () => ({
      workspacePath: workspacePath ?? "",
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );

  const refreshStatus = useCallback(async () => {
    if (!codeIndex || !workspacePath) return;
    const request = ++statusRequestRef.current;
    if (!hasStatusRef.current) setStatusLoadState("loading");
    try {
      const next = await codeIndex.getStatus(workspaceRef);
      if (request !== statusRequestRef.current) return;
      setStatus(next);
      hasStatusRef.current = true;
      setStatusLoadState("ready");
      setMessage(null);
      setMessageIsError(false);
    } catch {
      if (request !== statusRequestRef.current) return;
      setMessage(copy("codeGraph.statusFailed"));
      setMessageIsError(true);
      if (!hasStatusRef.current) setStatusLoadState("failed");
    }
  }, [codeIndex, copy, workspacePath, workspaceRef]);

  const loadGraph = useCallback(
    async (focus?: { symbol?: string; path?: string; startLine?: number }) => {
      if (!codeIndex || !workspacePath) return;
      const request = ++graphRequestRef.current;
      setLoading(true);
      setGraphLoadFailed(false);
      setMessage(null);
      setMessageIsError(false);
      try {
        const next = await codeIndex.getGraphOverview({
          ...workspaceRef,
          ...(focus ? { focus } : {}),
          limit: 60,
        });
        if (request !== graphRequestRef.current) return;
        setGraph(next);
        graphGenerationRef.current = status?.generation ?? null;
        setSelectedId(next.focusId ?? next.nodes[0]?.id ?? null);
        setSpotlightId(next.focusId ?? null);
      } catch {
        if (request !== graphRequestRef.current) return;
        // 首次图谱请求失败时必须退出加载态，让画布提供可操作的重试入口。
        setGraphLoadFailed(true);
        setMessage(copy("codeGraph.loadFailed"));
        setMessageIsError(true);
      } finally {
        if (request === graphRequestRef.current) setLoading(false);
      }
    },
    [codeIndex, copy, status?.generation, workspacePath, workspaceRef],
  );

  useEffect(() => {
    statusRequestRef.current += 1;
    graphRequestRef.current += 1;
    searchRequestRef.current += 1;
    buildRequestRef.current += 1;
    graphGenerationRef.current = null;
    setStatus(null);
    hasStatusRef.current = false;
    setStatusLoadState("loading");
    setHiddenKinds(new Set());
    setGraph(null);
    setGraphLoadFailed(false);
    setSelectedId(null);
    setSpotlightId(null);
    setHoverId(null);
    setResults([]);
    setMessage(null);
    setMessageIsError(false);
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!codeIndex || !workspacePath) return;
    void codeIndex
      .watchWorkspace(workspaceRef)
      .then(refreshStatus)
      .catch(() => {
        setMessage(copy("codeIndex.watchFailed"));
        setMessageIsError(true);
      });
  }, [codeIndex, copy, refreshStatus, workspacePath, workspaceRef]);

  useEffect(() => {
    if (
      (status?.state === "ready" || status?.state === "degraded") &&
      graphGenerationRef.current !== status.generation
    )
      void loadGraph();
  }, [loadGraph, status?.generation, status?.state]);

  useEffect(() => {
    if (status?.state !== "indexing" && !buildingIndex) return;
    const timer = window.setInterval(() => void refreshStatus(), 1200);
    return () => window.clearInterval(timer);
  }, [buildingIndex, refreshStatus, status?.state]);

  const buildIndex = async () => {
    if (!codeIndex || !workspacePath) return;
    const request = ++buildRequestRef.current;
    setBuildingIndex(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const nextStatus = await codeIndex.indexWorkspace(workspaceRef);
      if (request !== buildRequestRef.current) return;
      setStatus(nextStatus);
      await loadGraph();
    } catch {
      if (request !== buildRequestRef.current) return;
      setMessage(copy("codeGraph.indexFailed"));
      setMessageIsError(true);
    } finally {
      if (request === buildRequestRef.current) {
        setBuildingIndex(false);
        await refreshStatus();
      }
    }
  };

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!codeIndex || !query.trim()) return;
    const request = ++searchRequestRef.current;
    setSearching(true);
    setMessage(null);
    setMessageIsError(false);
    try {
      const response = await codeIndex.search({ ...workspaceRef, query: query.trim(), limit: 12 });
      if (request !== searchRequestRef.current) return;
      setResults(response.results);
      if (response.results.length === 0) {
        setMessage(copy("codeGraph.noMatches"));
      }
    } catch {
      if (request !== searchRequestRef.current) return;
      setResults([]);
      setMessage(copy("codeGraph.searchFailed"));
      setMessageIsError(true);
    } finally {
      if (request === searchRequestRef.current) setSearching(false);
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
  const visibleNodes = nodes.filter((node) => !hiddenKinds.has(node.kind));
  const selectedNode = visibleNodes.find((node) => node.id === selectedId) ?? null;
  const visibleEdges = useMemo(
    () =>
      (graph?.edges ?? []).filter((edge) =>
        edge.relation === "calls"
          ? showCalls
          : edge.relation === "imports"
            ? showImports
            : showContains,
      ),
    [graph, showCalls, showContains, showImports],
  );
  const layoutKey = visibleNodes
    .map((node) => node.id)
    .sort()
    .join("\0");
  if (layoutKeyRef.current !== layoutKey) {
    layoutKeyRef.current = layoutKey;
    dragPositions.current = new Map();
  }
  const flowNodes = useMemo(() => {
    const placed = createGraphNodes(
      { ...(graph ?? EMPTY_GRAPH), nodes: visibleNodes },
      selectedId,
      copy,
      hoverId ?? spotlightId,
    );
    return placed.map((node) => {
      const dragged = dragPositions.current.get(node.id);
      return dragged ? { ...node, position: dragged } : node;
    });
  }, [copy, dragRevision, graph, hoverId, selectedId, spotlightId, visibleNodes]);
  const flowNodeIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  const flowEdges = useMemo<Edge[]>(
    () =>
      visibleEdges
        .filter((edge) => flowNodeIds.has(edge.source) && flowNodeIds.has(edge.target))
        .map((edge) => {
          const focusId = hoverId ?? spotlightId;
          const incident = focusId !== null && (edge.source === focusId || edge.target === focusId);
          const dimmed = focusId !== null && !incident;
          // 主题令牌是 --color-*。裸 --primary / --border 写进 SVG stroke 后无效，边会消失。
          const color =
            edge.relation === "calls"
              ? "var(--color-terminal-bright-cyan)"
              : edge.relation === "imports"
                ? "var(--color-terminal-bright-magenta)"
                : "var(--color-foreground-subtle)";
          return {
            id: `${edge.source}:${edge.target}:${edge.relation}`,
            source: edge.source,
            target: edge.target,
            type: "default",
            animated: incident && !reduceMotion,
            zIndex: incident ? 2 : 0,
            style: {
              stroke: color,
              strokeWidth: incident ? 1.8 : 1,
              opacity: dimmed ? 0.16 : incident ? 0.95 : 0.42,
            },
            interactionWidth: 12,
          };
        }),
    [flowNodeIds, hoverId, reduceMotion, spotlightId, visibleEdges],
  );
  const kindCounts = useMemo(() => countByKind(nodes), [nodes]);
  const filteredGraphEmpty = nodes.length > 0 && visibleNodes.length === 0;
  const inbound = visibleEdges.filter((edge) => edge.target === selectedId);
  const outbound = visibleEdges.filter((edge) => edge.source === selectedId);

  if (!workspacePath) {
    return <GraphMessage icon={<Workflow />} text={copy("codeGraph.workspaceRequired")} />;
  }
  if (!codeIndex) {
    return <GraphMessage icon={<Database />} text={copy("codeGraph.unavailable")} />;
  }

  return (
    <section
      className="@container/code-graph flex min-h-[min(620px,78vh)] w-full min-w-0 flex-1 flex-col lg:h-full lg:min-h-0 lg:overflow-hidden"
      data-testid="usage-code-graph"
      data-layout="workspace"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card">
          <Workflow className="size-4 text-primary" />
        </span>
        <div className="min-w-0">
          <h2 className="text-ui-base font-semibold">{copy("codeGraph.title")}</h2>
          <p className="text-ui-xs text-muted-foreground">{copy("codeGraph.description")}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <span
            role="status"
            className={cn(
              "rounded-full bg-muted px-2.5 py-1 text-ui-xs text-muted-foreground",
              statusLoadState === "failed" && "text-destructive",
            )}
          >
            {status
              ? copy(`codeGraph.state.${status.state}`)
              : copy(
                  statusLoadState === "failed"
                    ? "codeGraph.statusFailed"
                    : "codeGraph.statusLoading",
                )}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={
              loading ||
              buildingIndex ||
              statusLoadState !== "ready" ||
              status?.state === "indexing"
            }
            onClick={() => void loadGraph()}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            {copy("codeGraph.refresh")}
          </Button>
        </div>
      </header>

      <div
        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-1.5 text-ui-xs tabular-nums"
        data-testid="usage-code-graph-stats"
        aria-busy={statusLoadState === "loading"}
      >
        {status ? (
          <>
            <span>{copy("codeGraph.files", { count: status.counts.files })}</span>
            <span>{copy("codeGraph.symbols", { count: status.counts.symbols })}</span>
            <span>{copy("codeGraph.links", { count: status.counts.edges })}</span>
            {status.partial || graph?.partial ? (
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                {copy("codeGraph.partial")}
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
            {copy(
              statusLoadState === "failed" ? "codeGraph.statusFailed" : "codeGraph.statusLoading",
            )}
          </span>
        )}
      </div>

      <form
        onSubmit={(event) => void runSearch(event)}
        className="relative z-20 flex shrink-0 gap-2 py-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => {
              searchRequestRef.current += 1;
              setSearching(false);
              setQuery(event.currentTarget.value);
            }}
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

      {message &&
      !(graphLoadFailed && graph === null && message === copy("codeGraph.loadFailed")) ? (
        <p
          role="status"
          className={cn(
            "mb-2 shrink-0 text-ui-xs",
            messageIsError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message}
        </p>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-3 @min-[700px]/code-graph:grid-cols-[120px_minmax(0,1fr)_168px] @min-[700px]/code-graph:grid-rows-[minmax(0,1fr)] @min-[960px]/code-graph:grid-cols-[180px_minmax(0,1fr)_260px] @min-[1200px]/code-graph:grid-cols-[208px_minmax(0,1fr)_300px]">
        <aside className="relative z-10 order-2 min-h-40 min-w-0 overflow-y-auto rounded-lg border border-border bg-card/50 p-3 @min-[700px]/code-graph:order-none @min-[700px]/code-graph:min-h-0">
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
            <FilterToggle
              label={copy("codeGraph.contains")}
              active={showContains}
              onClick={() => setShowContains((value) => !value)}
              color="bg-border"
            />
          </div>
          <div className="my-3 border-t border-border" />
          <h3 className="mb-2 text-ui-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {copy("codeGraph.nodeTypes")}
          </h3>
          <div className="space-y-1.5">
            {kindCounts.length ? (
              kindCounts.map(([kind, count]) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={!hiddenKinds.has(kind)}
                  onClick={() => {
                    const hiding = !hiddenKinds.has(kind);
                    if (hiding && selectedNode?.kind === kind) {
                      setSelectedId(visibleNodes.find((node) => node.kind !== kind)?.id ?? null);
                    }
                    setHiddenKinds((current) => {
                      const next = new Set(current);
                      if (hiding) next.add(kind);
                      else next.delete(kind);
                      return next;
                    });
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-1 rounded px-1 py-1 text-ui-xs hover:bg-accent",
                    hiddenKinds.has(kind) && "opacity-50",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        KIND_DOT_STYLES[kind.toLowerCase()] ?? "bg-border",
                      )}
                    />
                    <span className="truncate">{labelKind(kind)}</span>
                  </span>
                  <span className="text-muted-foreground/80">{count}</span>
                </button>
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
          className="relative z-0 order-1 h-[28rem] min-w-0 overflow-hidden rounded-lg border border-border bg-background @min-[700px]/code-graph:order-none @min-[700px]/code-graph:h-full @min-[700px]/code-graph:min-h-0"
          data-testid="usage-code-graph-canvas"
        >
          {statusLoadState === "loading" ||
          (loading && graph === null) ||
          (status !== null &&
            (status.state === "ready" || status.state === "degraded") &&
            graph === null &&
            !graphLoadFailed) ? (
            <div className="flex h-full items-center justify-center gap-2 text-ui-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> {copy("codeGraph.loading")}
            </div>
          ) : statusLoadState === "failed" || status === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertCircle className="size-7 text-destructive" />
              <p className="max-w-sm text-ui-sm text-muted-foreground">
                {copy("codeGraph.statusFailed")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refreshStatus()}
              >
                <RefreshCw className="mr-1.5 size-3.5" /> {copy("codeGraph.retryStatus")}
              </Button>
            </div>
          ) : graphLoadFailed && graph === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertCircle className="size-7 text-destructive" />
              <p className="max-w-sm text-ui-sm text-muted-foreground">
                {copy("codeGraph.loadFailed")}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void loadGraph()}>
                <RefreshCw className="mr-1.5 size-3.5" /> {copy("codeGraph.retryStatus")}
              </Button>
            </div>
          ) : status.state === "indexing" || buildingIndex ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-ui-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              <span>{copy("codeGraph.indexing")}</span>
              {status.progress ? (
                <span className="text-ui-xs">
                  {status.progress.indexedFiles} / {status.progress.discoveredFiles}
                </span>
              ) : null}
            </div>
          ) : status.counts.symbols === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
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
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Database className="size-7 text-muted-foreground" />
              <h3 className="text-ui-sm font-medium">{copy("codeGraph.noResolvedGraph")}</h3>
              <p className="max-w-sm text-ui-xs text-muted-foreground">
                {copy("codeGraph.noResolvedGraphDescription")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void loadGraph()}
              >
                {copy("codeGraph.refresh")}
              </Button>
            </div>
          ) : filteredGraphEmpty || (visibleNodes.length > 0 && flowNodes.length === 0) ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Database className="size-7 text-muted-foreground" />
              <h3 className="text-ui-sm font-medium">{copy("codeGraph.noNodes")}</h3>
              <p className="max-w-sm text-ui-xs text-muted-foreground">
                {copy("codeGraph.noVisibleNodesDescription")}
              </p>
            </div>
          ) : (
            <div className="code-graph-constellation absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-card),var(--color-background))]">
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={CODE_GRAPH_NODE_TYPES}
                className="h-full w-full"
                fitView
                fitViewOptions={{ padding: 0.18 }}
                minZoom={0.12}
                maxZoom={2.2}
                nodesConnectable={false}
                nodesDraggable
                nodesFocusable
                elementsSelectable
                onNodeClick={(_event, node) => {
                  setSelectedId(node.id);
                  setSpotlightId(node.id);
                }}
                onNodeMouseEnter={(_event, node) => setHoverId(node.id)}
                onNodeMouseLeave={() => setHoverId(null)}
                onNodeDragStop={(_event, node) => {
                  dragPositions.current.set(node.id, { x: node.position.x, y: node.position.y });
                  setDragRevision((revision) => revision + 1);
                }}
                proOptions={{ hideAttribution: true }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={26}
                  size={1}
                  color="var(--color-foreground-subtle)"
                />
                <Controls
                  position="bottom-left"
                  showInteractive={false}
                  className="overflow-hidden rounded-lg border border-border shadow-sm [&_.react-flow__controls-button]:!border-border [&_.react-flow__controls-button]:!bg-card [&_.react-flow__controls-button]:!text-foreground [&_.react-flow__controls-button>svg]:!fill-current [&_.react-flow__controls-button:hover]:!bg-muted"
                />
              </ReactFlow>
            </div>
          )}
        </main>

        <CodeGraphInspector
          selectedNode={selectedNode}
          loading={loading}
          visibleNodes={visibleNodes}
          inbound={inbound}
          outbound={outbound}
          copy={copy}
          labelKind={labelKind}
          onFocus={(symbol) => void loadGraph({ symbol })}
        />
      </div>
      {graph?.partial ? (
        <p className="mt-2 shrink-0 text-ui-xs text-muted-foreground">
          {copy("codeGraph.boundedHint")}
        </p>
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
