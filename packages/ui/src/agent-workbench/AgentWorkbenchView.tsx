import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Bot, Database, RefreshCw, Search, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  ZCODE_AGENT_PROVIDER,
  type AgentSummary,
  type AgentWorkbenchViewProps,
  type CodeIndexStatus,
  type CodeImpactResult,
  type CodeSearchResult,
  type CodeSymbolContext,
  type CodeTraceResult,
} from "./contract.js";

const EMPTY_STATUS: CodeIndexStatus = {
  state: "unindexed",
  generation: 0,
  counts: { files: 0, chunks: 0, symbols: 0, edges: 0 },
  embedding: { configured: false, available: false },
  diagnostics: [],
};

function modelName(agent: AgentSummary): string | undefined {
  const selection = agent.modelSelection;
  if (!selection) return undefined;
  const model =
    "model" in selection && typeof selection.model === "string" ? selection.model : undefined;
  const provider =
    "provider" in selection && typeof selection.provider === "string"
      ? selection.provider
      : undefined;
  return model ? `${provider ? `${provider} / ` : ""}${model}` : undefined;
}

export function AgentWorkbenchView({
  workspacePath,
  workspaceIdentity,
  workspaceName,
  runActivity,
}: AgentWorkbenchViewProps) {
  const services = useServices();
  const { settings } = useSettings({ services });
  const { intl } = useZCodeIntl();
  const codeIndex = services.codeIntelligenceService;
  const [status, setStatus] = useState<CodeIndexStatus>(EMPTY_STATUS);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [symbol, setSymbol] = useState("");
  const [symbolContext, setSymbolContext] = useState<CodeSymbolContext | null>(null);
  const [changedPaths, setChangedPaths] = useState("");
  const [impact, setImpact] = useState<CodeImpactResult | null>(null);
  const [fromSymbol, setFromSymbol] = useState("");
  const [toSymbol, setToSymbol] = useState("");
  const [trace, setTrace] = useState<CodeTraceResult | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const copy = useCallback(
    (id: string, _defaultMessage: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id }, values),
    [intl],
  );
  const workspaceRef = { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) };

  const refreshStatus = useCallback(async () => {
    if (!codeIndex || !workspacePath) return;
    try {
      setStatus(await codeIndex.getStatus(workspaceRef));
    } catch {
      setMessage(copy("agentWorkbench.statusLoadFailed", "Could not read the local code index."));
    }
  }, [codeIndex, copy, workspaceIdentity, workspacePath]);

  useEffect(() => {
    let cancelled = false;
    setLoadingAgents(true);
    void services.subagentsService
      .list({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        provider: ZCODE_AGENT_PROVIDER,
        mode: "allRuntimeScopes",
      })
      .then((result) => {
        if (!cancelled) setAgents(result.agents);
      })
      .catch(() => {
        if (!cancelled)
          setMessage(copy("agentWorkbench.agentsLoadFailed", "Could not load agent profiles."));
      })
      .finally(() => {
        if (!cancelled) setLoadingAgents(false);
      });
    return () => {
      cancelled = true;
    };
  }, [copy, services.subagentsService, workspaceIdentity, workspacePath]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refreshStatus(), 500);
    return () => window.clearInterval(timer);
  }, [busy, refreshStatus]);

  useEffect(() => {
    if (status.embedding.endpoint !== undefined) setEndpoint(status.embedding.endpoint);
    if (status.embedding.model) setModel(status.embedding.model);
  }, [status.embedding.endpoint, status.embedding.model]);

  const indexWorkspace = async () => {
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await codeIndex.indexWorkspace(workspaceRef));
    } catch {
      setMessage(
        copy(
          "agentWorkbench.indexFailed",
          "Indexing failed. The last saved generation is preserved.",
        ),
      );
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const clearIndex = async () => {
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      await codeIndex.clearIndex(workspaceRef);
      setStatus(EMPTY_STATUS);
      setResults([]);
      setSearchState("idle");
    } catch {
      setMessage(copy("agentWorkbench.clearFailed", "Could not clear this workspace index."));
    } finally {
      setBusy(false);
    }
  };

  const saveEmbeddingConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        endpoint: endpoint.trim(),
        model: model.trim(),
      });
      setStatus(next);
      setMessage(copy("agentWorkbench.embeddingSaved", "Local embedding settings saved."));
    } catch {
      setMessage(
        copy(
          "agentWorkbench.embeddingRejected",
          "Use a credential-free loopback HTTP endpoint and a model name.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const clearEmbeddingConfig = async () => {
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      setStatus(
        await codeIndex.setEmbeddingConfig({ ...workspaceRef, endpoint: null, model: null }),
      );
      setEndpoint("");
      setModel("");
      setMessage(copy("agentWorkbench.embeddingCleared", "Local embedding settings cleared."));
    } catch {
      setMessage(
        copy("agentWorkbench.embeddingClearFailed", "Could not clear local embedding settings."),
      );
    } finally {
      setBusy(false);
    }
  };

  const loadSymbolContext = async () => {
    if (!codeIndex || !symbol.trim()) return;
    setGraphLoading(true);
    setMessage(null);
    try {
      setSymbolContext(
        await codeIndex.getSymbolContext({ ...workspaceRef, symbol: symbol.trim() }),
      );
    } catch {
      setSymbolContext(null);
      setMessage(copy("agentWorkbench.graphFailed", "Could not read code relationships."));
    } finally {
      setGraphLoading(false);
    }
  };

  const analyzeImpact = async () => {
    if (!codeIndex || !changedPaths.trim()) return;
    setGraphLoading(true);
    setMessage(null);
    try {
      const paths = changedPaths
        .split(/[\n,]+/u)
        .map((path) => path.trim())
        .filter(Boolean);
      setImpact(await codeIndex.getImpact({ ...workspaceRef, changedPaths: paths }));
    } catch {
      setImpact(null);
      setMessage(copy("agentWorkbench.graphFailed", "Could not read code relationships."));
    } finally {
      setGraphLoading(false);
    }
  };

  const traceSymbols = async () => {
    if (!codeIndex || !fromSymbol.trim() || !toSymbol.trim()) return;
    setGraphLoading(true);
    setMessage(null);
    try {
      setTrace(
        await codeIndex.trace({
          ...workspaceRef,
          fromSymbol: fromSymbol.trim(),
          toSymbol: toSymbol.trim(),
        }),
      );
    } catch {
      setTrace(null);
      setMessage(copy("agentWorkbench.graphFailed", "Could not read code relationships."));
    } finally {
      setGraphLoading(false);
    }
  };

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!codeIndex || !query.trim()) return;
    setSearchState("loading");
    setMessage(null);
    try {
      const result = await codeIndex.search({ ...workspaceRef, query, limit: 12 });
      setResults(result.results);
      setSearchState("done");
    } catch {
      setResults([]);
      setSearchState("error");
    }
  };

  const stateLabel = {
    unindexed: copy("agentWorkbench.stateUnindexed", "Not indexed"),
    indexing: copy("agentWorkbench.stateIndexing", "Indexing"),
    ready: copy("agentWorkbench.stateReady", "Ready"),
    degraded: copy("agentWorkbench.stateDegraded", "Needs attention"),
  }[status.state];
  const spawnBudget = settings?.spawnBudget ?? 128;
  const parallelLimit = settings?.subagentMaxParallel;
  const minimumRuntime = settings?.subagentTaskTimeoutMinutes;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto bg-background p-4"
      data-testid="agent-workbench"
    >
      <div className="mb-4 flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
          <Workflow className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="text-ui-base font-semibold">
            {copy("agentWorkbench.title", "Agent Workbench")}
          </h2>
          <p className="truncate text-ui-xs text-muted-foreground">
            {workspaceName || workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) || workspacePath}
          </p>
        </div>
      </div>

      <section
        className="mb-5 rounded-xl border bg-card p-3"
        aria-labelledby="agent-roster-heading"
      >
        <div className="mb-3 flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          <h3 id="agent-roster-heading" className="text-ui-sm font-semibold">
            {copy("agentWorkbench.roster", "Agent roles")}
          </h3>
          <span className="ml-auto text-ui-xs text-muted-foreground">{agents.length}</span>
        </div>
        {loadingAgents ? (
          <p className="text-ui-xs text-muted-foreground">
            {copy("agentWorkbench.loading", "Loading…")}
          </p>
        ) : null}
        {!loadingAgents && agents.length === 0 ? (
          <p className="text-ui-xs text-muted-foreground">
            {copy("agentWorkbench.noAgents", "No agent profiles found.")}
          </p>
        ) : null}
        <div className="space-y-2">
          {agents.map((agent) => (
            <div key={agent.id} className="rounded-lg border border-border/70 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    agent.enabled ? "bg-emerald-500" : "bg-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-ui-xs font-medium">{agent.name}</span>
                <span className="shrink-0 text-ui-xs text-muted-foreground">{agent.source}</span>
              </div>
              {agent.description ? (
                <p className="mt-1 line-clamp-2 text-ui-xs text-muted-foreground">
                  {agent.description}
                </p>
              ) : null}
              {agent.skills?.length ? (
                <p className="mt-1 truncate text-ui-xs text-primary">
                  {copy("agentWorkbench.skills", "Skills")}: {agent.skills.join(", ")}
                </p>
              ) : null}
              {modelName(agent) ? (
                <p className="mt-1 truncate text-ui-xs text-muted-foreground">{modelName(agent)}</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section
        className="mb-5 rounded-xl border bg-card p-3"
        aria-labelledby="agent-capacity-heading"
        data-testid="agent-workbench-capacity"
      >
        <div className="mb-2 flex items-center gap-2">
          <Workflow className="size-4 text-muted-foreground" />
          <h3 id="agent-capacity-heading" className="text-ui-sm font-semibold">
            {copy("agentWorkbench.capacity", "Swarm capacity")}
          </h3>
        </div>
        <dl className="grid grid-cols-1 gap-1.5 text-ui-xs sm:grid-cols-2">
          <div className="flex justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
            <dt className="text-muted-foreground">
              {copy("agentWorkbench.spawnBudget", "Spawn budget")}
            </dt>
            <dd className="font-medium">
              {spawnBudget === 0 ? copy("agentWorkbench.disabled", "Disabled") : spawnBudget}
            </dd>
          </div>
          <div className="flex justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
            <dt className="text-muted-foreground">
              {copy("agentWorkbench.parallelLimit", "Parallel agents")}
            </dt>
            <dd className="text-right font-medium">
              {parallelLimit == null || parallelLimit === 0
                ? copy("agentWorkbench.adaptiveParallel", "Adaptive · runtime CPU · max 128")
                : parallelLimit}
            </dd>
          </div>
          <div className="flex justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 sm:col-span-2">
            <dt className="text-muted-foreground">
              {copy("agentWorkbench.minimumRuntime", "Minimum task runtime")}
            </dt>
            <dd className="text-right font-medium">
              {minimumRuntime == null || minimumRuntime === 0
                ? copy("agentWorkbench.roleDeadlines", "Role-specific deadlines")
                : copy(
                    "agentWorkbench.minimumRuntimeValue",
                    "At least {minutes} min · role headroom retained",
                    { minutes: minimumRuntime },
                  )}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-ui-xs text-muted-foreground">
          {copy(
            "agentWorkbench.capacitySettingsHint",
            "These are the active Settings values; admission may also reflect remaining budget and currently occupied slots.",
          )}
        </p>
      </section>

      <section
        className="mb-5 rounded-xl border bg-card p-3"
        aria-labelledby="agent-run-activity-heading"
      >
        <h3 id="agent-run-activity-heading" className="mb-2 text-ui-sm font-semibold">
          {copy("agentWorkbench.runActivity", "Agents in current task")}
        </h3>
        {runActivity ? (
          <div
            className="h-72 min-h-[240px] overflow-hidden rounded-lg border"
            data-testid="agent-workbench-run-activity"
          >
            {runActivity}
          </div>
        ) : (
          <p className="text-ui-xs text-muted-foreground" data-testid="agent-workbench-run-empty">
            {copy(
              "agentWorkbench.noActiveTask",
              "Open a task to see its running and completed agent branches.",
            )}
          </p>
        )}
      </section>

      <section className="mb-5 rounded-xl border bg-card p-3" aria-labelledby="code-index-heading">
        <div className="mb-2 flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          <h3 id="code-index-heading" className="text-ui-sm font-semibold">
            {copy("agentWorkbench.codeIndex", "Local code index")}
          </h3>
          <span
            data-testid="agent-workbench-index-state"
            data-code-index-state={status.state}
            className={cn(
              "ml-auto rounded-full px-2 py-0.5 text-ui-xs",
              status.state === "ready"
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-muted text-muted-foreground",
            )}
          >
            {stateLabel}
          </span>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2 text-ui-xs">
          <div className="rounded-md bg-muted/50 px-2 py-1.5">
            {copy("agentWorkbench.files", "Files")}: <b>{status.counts.files}</b>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-1.5">
            {copy("agentWorkbench.symbols", "Symbols")}: <b>{status.counts.symbols}</b>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-1.5">
            {copy("agentWorkbench.chunks", "Chunks")}: <b>{status.counts.chunks}</b>
          </div>
          <div className="rounded-md bg-muted/50 px-2 py-1.5">
            {copy("agentWorkbench.edges", "Links")}: <b>{status.counts.edges}</b>
          </div>
        </div>
        <p className="mb-3 text-ui-xs text-muted-foreground">
          {status.embedding.configured
            ? copy("agentWorkbench.embeddingState", "Embeddings: {model} · {state}", {
                model: status.embedding.model ?? "",
                state: status.embedding.available
                  ? copy("agentWorkbench.embeddingReady", "ready")
                  : copy("agentWorkbench.embeddingPending", "not built"),
              })
            : copy(
                "agentWorkbench.embeddingOff",
                "Embeddings are off. Lexical and symbol search work locally without a model.",
              )}
        </p>
        {status.partial ? (
          <p className="mb-3 text-ui-xs text-amber-600">
            {copy(
              "agentWorkbench.indexPartial",
              "Some files were skipped or capped; relationship results may be incomplete.",
            )}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            className="min-w-0 flex-1"
            disabled={!codeIndex || busy}
            onClick={() => void indexWorkspace()}
          >
            <RefreshCw className={cn("mr-1.5 size-3.5", busy && "animate-spin")} />
            {status.generation > 0
              ? copy("agentWorkbench.refreshIndex", "Refresh index")
              : copy("agentWorkbench.buildIndex", "Build index")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={copy("agentWorkbench.clearIndex", "Clear index")}
            title={copy("agentWorkbench.clearIndex", "Clear index")}
            disabled={!codeIndex || busy || status.generation === 0}
            onClick={() => void clearIndex()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        {!codeIndex ? (
          <p className="mt-2 text-ui-xs text-muted-foreground">
            {copy("agentWorkbench.unavailable", "This host does not provide local code indexing.")}
          </p>
        ) : null}
        {status.progress ? (
          <p className="mt-2 text-ui-xs text-muted-foreground">
            {copy("agentWorkbench.progress", "Indexed {done} of {total} files", {
              done: status.progress.indexedFiles,
              total: status.progress.discoveredFiles,
            })}
          </p>
        ) : null}
        {status.diagnostics.map((diagnostic, index) => (
          <p key={`${diagnostic}-${index}`} className="mt-2 text-ui-xs text-amber-600">
            {diagnostic}
          </p>
        ))}
      </section>

      <section className="mb-5 rounded-xl border bg-card p-3" aria-labelledby="code-search-heading">
        <div className="mb-2 flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 id="code-search-heading" className="text-ui-sm font-semibold">
            {copy("agentWorkbench.searchTitle", "Search code")}
          </h3>
        </div>
        <form className="flex gap-2" onSubmit={(event) => void runSearch(event)}>
          <Input
            aria-label={copy("agentWorkbench.searchPlaceholder", "Search symbols and code")}
            placeholder={copy("agentWorkbench.searchPlaceholder", "Search symbols and code")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            type="submit"
            size="icon"
            aria-label={copy("agentWorkbench.searchAction", "Search")}
            disabled={!codeIndex || !query.trim() || searchState === "loading"}
          >
            <Search className="size-4" />
          </Button>
        </form>
        {searchState === "loading" ? (
          <p className="mt-3 text-ui-xs text-muted-foreground">
            {copy("agentWorkbench.searching", "Searching…")}
          </p>
        ) : null}
        {searchState === "error" ? (
          <p className="mt-3 text-ui-xs text-destructive">
            {copy("agentWorkbench.searchFailed", "Search failed.")}
          </p>
        ) : null}
        {searchState === "done" && results.length === 0 ? (
          <p className="mt-3 text-ui-xs text-muted-foreground">
            {copy("agentWorkbench.noResults", "No matches found.")}
          </p>
        ) : null}
        <div className="mt-2 space-y-2">
          {results.map((result, index) => (
            <article
              key={`${result.path}:${result.startLine}:${index}`}
              className="rounded-lg border border-border/70 px-2.5 py-2"
            >
              <p className="truncate text-ui-xs font-medium">
                {result.path}:{result.startLine}
              </p>
              {result.symbolName ? (
                <p className="mt-0.5 text-ui-xs text-primary">
                  {result.symbolKind} {result.symbolName}
                </p>
              ) : null}
              <p className="mt-1 line-clamp-3 font-mono text-ui-xs text-muted-foreground">
                {result.excerpt}
              </p>
              <p className="mt-1 text-right text-ui-2xs uppercase tracking-wide text-muted-foreground">
                {result.match}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="mb-5 rounded-xl border bg-card p-3" aria-labelledby="code-graph-heading">
        <div className="mb-2 flex items-center gap-2">
          <Workflow className="size-4 text-muted-foreground" />
          <h3 id="code-graph-heading" className="text-ui-sm font-semibold">
            {copy("agentWorkbench.graphTitle", "Code relationships")}
          </h3>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Input
              aria-label={copy("agentWorkbench.symbolPlaceholder", "Symbol name or ID")}
              placeholder={copy("agentWorkbench.symbolPlaceholder", "Symbol name or ID")}
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!codeIndex || graphLoading || !symbol.trim()}
              onClick={() => void loadSymbolContext()}
            >
              {copy("agentWorkbench.showContext", "Show callers and dependencies")}
            </Button>
            {symbolContext ? (
              <div
                className="rounded-md bg-muted/50 p-2 text-ui-xs"
                data-testid="agent-workbench-symbol-context"
              >
                <p className="truncate font-medium">
                  {symbolContext.symbol.name} · {symbolContext.symbol.path}:
                  {symbolContext.symbol.startLine}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {copy("agentWorkbench.callers", "Callers")}:{" "}
                  {symbolContext.callers.length
                    ? symbolContext.callers
                        .map((item) => `${item.name} (${item.path}:${item.startLine})`)
                        .join(", ")
                    : copy("agentWorkbench.none", "none")}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {copy("agentWorkbench.dependencies", "Dependencies")}:{" "}
                  {symbolContext.dependencies.length
                    ? symbolContext.dependencies
                        .map((item) => `${item.name} (${item.path}:${item.startLine})`)
                        .join(", ")
                    : copy("agentWorkbench.none", "none")}
                </p>
                {symbolContext.partial ? (
                  <p className="mt-1 text-amber-600">
                    {copy("agentWorkbench.partialGraph", "Results may be incomplete.")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5 border-t pt-3">
            <Input
              aria-label={copy("agentWorkbench.changedPaths", "Changed workspace paths")}
              placeholder={copy("agentWorkbench.changedPaths", "Changed paths, comma separated")}
              value={changedPaths}
              onChange={(event) => setChangedPaths(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!codeIndex || graphLoading || !changedPaths.trim()}
              onClick={() => void analyzeImpact()}
            >
              {copy("agentWorkbench.analyzeImpact", "Analyze change impact")}
            </Button>
            {impact ? (
              <div
                className="rounded-md bg-muted/50 p-2 text-ui-xs"
                data-testid="agent-workbench-impact"
              >
                {impact.affectedSymbols.length ? (
                  impact.affectedSymbols.map((item) => (
                    <p key={`${item.path}:${item.startLine}`} className="truncate">
                      {item.name} · {item.path}:{item.startLine}{" "}
                      <span className="text-muted-foreground">d{item.distance}</span>
                    </p>
                  ))
                ) : (
                  <p className="text-muted-foreground">
                    {copy("agentWorkbench.noImpact", "No indexed dependants found.")}
                  </p>
                )}
                {impact.partial ? (
                  <p className="mt-1 text-amber-600">
                    {copy("agentWorkbench.partialGraph", "Results may be incomplete.")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5 border-t pt-3">
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label={copy("agentWorkbench.traceFrom", "Trace from symbol")}
                placeholder={copy("agentWorkbench.traceFrom", "From symbol")}
                value={fromSymbol}
                onChange={(event) => setFromSymbol(event.target.value)}
              />
              <Input
                aria-label={copy("agentWorkbench.traceTo", "Trace to symbol")}
                placeholder={copy("agentWorkbench.traceTo", "To symbol")}
                value={toSymbol}
                onChange={(event) => setToSymbol(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!codeIndex || graphLoading || !fromSymbol.trim() || !toSymbol.trim()}
              onClick={() => void traceSymbols()}
            >
              {copy("agentWorkbench.traceAction", "Trace dependency path")}
            </Button>
            {trace ? (
              <div
                className="rounded-md bg-muted/50 p-2 text-ui-xs"
                data-testid="agent-workbench-trace"
              >
                {trace.found ? (
                  trace.path.map((item, index) => (
                    <p key={`${item.path}:${item.startLine}:${index}`} className="truncate">
                      {index ? `→ ` : ""}
                      {item.name} · {item.path}:{item.startLine}
                    </p>
                  ))
                ) : (
                  <p className="text-muted-foreground">
                    {copy("agentWorkbench.noTrace", "No path found in the current index.")}
                  </p>
                )}
                {trace.partial ? (
                  <p className="mt-1 text-amber-600">
                    {copy("agentWorkbench.partialGraph", "Results may be incomplete.")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className="mb-4 rounded-xl border bg-card p-3"
        aria-labelledby="embedding-config-heading"
      >
        <h3 id="embedding-config-heading" className="mb-2 text-ui-sm font-semibold">
          {copy("agentWorkbench.embeddingConfig", "Local embeddings")}
        </h3>
        <form className="space-y-2" onSubmit={(event) => void saveEmbeddingConfig(event)}>
          <Input
            aria-label={copy("agentWorkbench.embeddingEndpoint", "Embedding endpoint")}
            placeholder="http://127.0.0.1:11434/api/embed"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
          <Input
            aria-label={copy("agentWorkbench.embeddingModel", "Embedding model")}
            placeholder="nomic-embed-text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="w-full"
            disabled={!codeIndex || busy}
          >
            {copy("agentWorkbench.saveEmbedding", "Save local model settings")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full"
            disabled={!codeIndex || busy || !status.embedding.configured}
            onClick={() => void clearEmbeddingConfig()}
          >
            {copy("agentWorkbench.clearEmbedding", "Clear embedding settings")}
          </Button>
        </form>
      </section>
      {message ? (
        <p role="status" className="mb-3 text-ui-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
