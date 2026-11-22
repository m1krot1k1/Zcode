import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Database, ExternalLink, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsUsageCodeGraphIntent } from "@/lib/settingsNavigation.js";
import {
  codeIndexDotClassName,
  codeIndexSkipReasons,
  codeIndexStateKey,
  codeIndexTone,
} from "./codeIndexIndicator.js";
import type { CodeIndexStatus, CodeSearchResult } from "./contract.js";

export function CodeIndexPopover({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const codeIndex = useServices().codeIntelligenceService;
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const { intl, locale } = useZCodeIntl();
  const intlRef = useRef(intl);
  intlRef.current = intl;
  // Intl provider 可能重建 context 对象；保持回调稳定，避免状态清理 effect 每次 render 重启。
  const copy = useCallback(
    (id: string, values?: Record<string, string | number>) =>
      intlRef.current.formatMessage({ id }, values),
    [],
  );
  const workspaceRef = useMemo(
    () => ({
      workspacePath,
      ...(workspaceIdentity?.trim() ? { workspaceIdentity: workspaceIdentity.trim() } : {}),
    }),
    [workspaceIdentity, workspacePath],
  );
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeSearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<CodeSearchResult | null>(null);
  const [busy, setBusy] = useState<"index" | "search" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const statusRequestRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    if (!codeIndex || !workspacePath) return;
    const request = ++statusRequestRef.current;
    try {
      const next = await codeIndex.getStatus(workspaceRef);
      // 慢返回不能覆盖更新的状态：索引已经结束时，旧的 indexing 会把圆点重新点亮。
      if (request !== statusRequestRef.current) return;
      setStatus(next);
    } catch {
      if (request !== statusRequestRef.current) return;
      setMessage(copy("codeIndex.statusFailed"));
      setMessageIsError(true);
    }
  }, [codeIndex, copy, workspacePath, workspaceRef]);

  useEffect(() => {
    setStatus(null);
    setResults([]);
    setSelectedResult(null);
    setMessage(null);
    setMessageIsError(false);
    if (!codeIndex || !workspacePath) return;
    void refreshStatus();
    void codeIndex
      .watchWorkspace(workspaceRef)
      .then(refreshStatus)
      .catch(() => {
        setMessage(copy("codeIndex.watchFailed"));
        setMessageIsError(true);
      });
  }, [codeIndex, copy, refreshStatus, workspacePath, workspaceRef]);

  useEffect(() => {
    // 自动索引不经过 Build 按钮。只要服务还在 indexing，关闭的弹层也要继续问状态。
    if (!open && status?.state !== "indexing") return;
    const timer = window.setInterval(() => void refreshStatus(), 1500);
    return () => window.clearInterval(timer);
  }, [open, refreshStatus, status?.state]);

  if (!workspacePath) return null;

  const showIndex = async () => {
    if (!codeIndex) return;
    setBusy("index");
    setMessage(null);
    setMessageIsError(false);
    try {
      setStatus(await codeIndex.indexWorkspace(workspaceRef));
    } catch {
      setMessage(copy("codeIndex.indexFailed"));
      setMessageIsError(true);
    } finally {
      setBusy(null);
      await refreshStatus();
    }
  };

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!codeIndex || !query.trim()) return;
    setBusy("search");
    setMessage(null);
    setMessageIsError(false);
    setSelectedResult(null);
    try {
      const response = await codeIndex.search({ ...workspaceRef, query: query.trim(), limit: 6 });
      setResults(response.results);
      if (!response.results.length) {
        setMessage(copy("codeIndex.noMatches"));
      }
    } catch {
      setResults([]);
      setMessage(copy("codeIndex.searchFailed"));
      setMessageIsError(true);
    } finally {
      setBusy(null);
    }
  };

  const openGraph = () => {
    setPendingSettingsUsageCodeGraphIntent();
    openSettingsTab?.();
    setOpen(false);
  };

  const currentStatus = status?.state ?? "unindexed";
  const indicatorTone = codeIndexTone(status);
  // 修复原因：badge 之前按 status.state 取 `codeGraph.state.*`，`ready && partial`
  // 会显示「Ready」，且 `codeGraph.state.degraded` 的文案是「Partial index」，
  // 把两种不同状态说成同一件事。统一通过 codeIndexStateKey 按 tone 取词。
  const statusLabel = copy(codeIndexStateKey(status));
  const triggerLabel = copy("codeIndex.triggerWithStatus", { status: statusLabel });
  const indexAction =
    status?.state === "unindexed"
      ? copy("codeIndex.build")
      : status?.state === "degraded"
        ? copy("codeIndex.retry")
        : copy("codeIndex.refresh");
  const embeddingPhase = status?.embedding.phase ?? "pending";
  const embeddingFailure = status?.embedding.lastError;
  const hasCoverageDetails = Boolean(status?.partial || status?.diagnostics.length);
  const updatedLabel = status?.updatedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(status.updatedAt),
      )
    : copy("codeIndex.neverUpdated");

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void refreshStatus();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          aria-label={triggerLabel}
          title={triggerLabel}
          data-testid="composer-code-index-trigger"
          data-code-index-state={currentStatus}
          data-code-index-tone={indicatorTone}
        >
          <Database className="size-4" aria-hidden="true" />
          <span
            className={`absolute right-1 top-1 size-1.5 rounded-full ${codeIndexDotClassName(indicatorTone)}`}
            data-testid="composer-code-index-indicator"
            data-code-index-tone={indicatorTone}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid="composer-code-index-status"
      >
        {statusLabel}
      </span>
      <PopoverContent
        align="end"
        side="top"
        className="w-[min(22rem,calc(100vw-1.5rem))] gap-0 p-0"
        data-testid="composer-code-index-popover"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-3.5 py-3">
          <div className="min-w-0">
            <p className="truncate text-ui-sm font-semibold">{copy("codeIndex.title")}</p>
            <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
              {workspacePath.split(/[\\/]/).filter(Boolean).at(-1)}
            </p>
          </div>
          <span
            className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-ui-xs text-muted-foreground"
            data-testid="composer-code-index-badge"
          >
            {statusLabel}
          </span>
        </div>

        {codeIndex ? (
          <div className="space-y-3 p-3.5">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-ui-xs">
              <span className="text-muted-foreground">{copy("codeIndex.files")}</span>
              <span className="text-right font-medium tabular-nums">
                {status?.counts.files ?? 0}
              </span>
              <span className="text-muted-foreground">{copy("codeIndex.symbols")}</span>
              <span className="text-right font-medium tabular-nums">
                {status?.counts.symbols ?? 0}
              </span>
              <span className="text-muted-foreground">{copy("codeIndex.chunks")}</span>
              <span className="text-right font-medium tabular-nums">
                {status?.counts.chunks ?? 0}
              </span>
              <span className="text-muted-foreground">{copy("codeIndex.links")}</span>
              <span className="text-right font-medium tabular-nums">
                {status?.counts.edges ?? 0}
              </span>
            </div>

            <div className="rounded-lg bg-muted/45 px-2.5 py-2 text-ui-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{copy("codeIndex.embedding")}</span>
                <span
                  className={
                    status?.embedding.phase === "failed" ? "text-destructive" : "font-medium"
                  }
                >
                  {copy(`codeIndex.embeddingPhase.${embeddingPhase}`)}
                </span>
              </div>
              {status?.embedding.model ? (
                <p className="mt-1 truncate text-muted-foreground" title={status.embedding.model}>
                  {status.embedding.model}
                </p>
              ) : null}
            </div>

            {status?.state === "indexing" ? (
              <div
                className="space-y-1 text-ui-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <p className="flex items-center gap-2">
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  {status.progress
                    ? copy("codeIndex.progress", {
                        indexed: status.progress.indexedFiles,
                        discovered: status.progress.discoveredFiles,
                      })
                    : copy("codeIndex.indexing")}
                </p>
                {status.progress?.embedding ? (
                  <p className="pl-5">
                    {copy("codeIndex.embeddingProgress", {
                      completed: status.progress.embedding.completed,
                      total: status.progress.embedding.total,
                    })}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-ui-xs text-muted-foreground">
                {copy("codeIndex.updated", { date: updatedLabel })}
              </p>
            )}

            {hasCoverageDetails ? (
              <details className="rounded-md bg-muted/35 px-2.5 py-2 text-ui-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium">
                  {copy(status?.partial ? "codeIndex.partial" : "codeIndex.details")}
                </summary>
                <p className="mt-1.5">{copy("codeIndex.coverageDetails")}</p>
                {codeIndexSkipReasons(status?.diagnostics ?? []).map((reason) => (
                  <p
                    key={reason.key}
                    className="mt-1"
                    data-testid="composer-code-index-skip-reason"
                  >
                    {copy(
                      reason.key,
                      reason.count === undefined ? undefined : { count: reason.count },
                    )}
                  </p>
                ))}
              </details>
            ) : null}
            {embeddingFailure ? (
              <p role="status" className="text-ui-xs text-destructive">
                {copy(`codeIndex.embeddingError.${embeddingFailure.code}`, {
                  status: embeddingFailure.httpStatus ?? 0,
                })}
              </p>
            ) : null}
            {message ? (
              <p
                role="status"
                className={
                  messageIsError
                    ? "text-ui-xs text-destructive"
                    : "text-ui-xs text-muted-foreground"
                }
              >
                {message}
              </p>
            ) : null}

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-center gap-1.5"
              data-testid="composer-code-index-refresh"
              disabled={busy !== null || status === null || status.state === "indexing"}
              onClick={() => void showIndex()}
            >
              {busy === "index" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {indexAction}
            </Button>

            {status && status.generation > 0 ? (
              <form onSubmit={(event) => void search(event)} className="flex gap-1.5">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={copy("codeIndex.searchPlaceholder")}
                    aria-label={copy("codeIndex.searchPlaceholder")}
                    className="h-8 pl-8 text-ui-xs"
                    data-testid="composer-code-index-search"
                  />
                </div>
                <Button
                  type="submit"
                  size="icon-sm"
                  variant="secondary"
                  disabled={busy !== null || !query.trim()}
                  aria-label={copy("codeGraph.search")}
                >
                  {busy === "search" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Search className="size-3.5" />
                  )}
                </Button>
              </form>
            ) : null}

            {results.length ? (
              <div
                className="max-h-40 space-y-1 overflow-y-auto"
                data-testid="composer-code-index-results"
              >
                {results.map((result, index) => (
                  <button
                    key={`${result.path}:${result.startLine}:${index}`}
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() => setSelectedResult(result)}
                  >
                    <span className="block truncate text-ui-xs font-medium">
                      {result.symbolName ?? result.path}
                    </span>
                    <span className="block truncate text-ui-xs text-muted-foreground">
                      {result.path}:{result.startLine}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {selectedResult ? (
              <div className="rounded-md border border-border bg-background p-2">
                <p className="mb-1 truncate text-ui-xs font-medium">
                  {selectedResult.path}:{selectedResult.startLine}
                </p>
                <p className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-ui-xs text-muted-foreground">
                  {selectedResult.excerpt}
                </p>
              </div>
            ) : null}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center gap-1.5 text-ui-xs text-muted-foreground"
              onClick={openGraph}
            >
              {copy("codeIndex.openGraph")}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <p className="p-3.5 text-ui-xs text-muted-foreground">{copy("codeGraph.unavailable")}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
