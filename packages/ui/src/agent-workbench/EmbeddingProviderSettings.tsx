import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, ChevronDown, LoaderCircle, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  CodeIndexStatus,
  CodeIntelligenceService,
  CodeWorkspaceRef,
  EmbeddingProvider,
} from "./contract.js";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/api/embed";
const OPENAI_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

export function EmbeddingProviderSettings({
  codeIndex,
  workspaceRef,
}: {
  codeIndex?: CodeIntelligenceService;
  workspaceRef?: CodeWorkspaceRef;
}) {
  const { intl } = useZCodeIntl();
  const copy = useCallback((id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values), [intl]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<EmbeddingProvider>("ollama");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "clear-token" | "clear" | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!codeIndex || !workspaceRef) {
      setStatus(null);
      return;
    }
    void codeIndex.getStatus(workspaceRef).then((next) => {
      if (cancelled) return;
      setStatus(next);
      setEndpoint(next.embedding.endpoint ?? "");
      setModel(next.embedding.model ?? "");
      setProvider(next.embedding.provider ?? "ollama");
    }).catch(() => {
      if (!cancelled)
        setMessage({ text: copy("settings.embedding.statusFailed"), ok: false });
    });
    return () => {
      cancelled = true;
    };
  }, [codeIndex, copy, workspaceRef]);

  if (!codeIndex || !workspaceRef) return null;

  const updateStatus = async () => {
    const next = await codeIndex.getStatus(workspaceRef);
    setStatus(next);
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const result = await codeIndex.testEmbeddingConfig({
        ...workspaceRef,
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setMessage({
        ok: result.ok,
        text: result.ok
          ? copy("settings.embedding.testSuccess", {
              dimensions: result.dimensions ?? 0,
              ms: result.elapsedMs,
            })
          : copy(`settings.embedding.testError.${result.errorCode ?? "request-failed"}`, {
              status: result.httpStatus ?? 0,
            }),
      });
    } catch {
      setMessage({ text: copy("settings.embedding.testError.request-failed"), ok: false });
    } finally {
      // Test credentials are transient; never retain them after the request completes.
      setApiKey("");
      setBusy(null);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save");
    setMessage(null);
    try {
      await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      await updateStatus();
      setMessage({ text: copy("settings.embedding.saved"), ok: true });
    } catch {
      setMessage({ text: copy("settings.embedding.saveFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const clearToken = async () => {
    setBusy("clear-token");
    setMessage(null);
    try {
      await codeIndex.setEmbeddingConfig({ ...workspaceRef, apiKey: null });
      setApiKey("");
      await updateStatus();
      setMessage({ text: copy("settings.embedding.tokenCleared"), ok: true });
    } catch {
      setMessage({ text: copy("settings.embedding.saveFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const clearConfig = async () => {
    setBusy("clear");
    setMessage(null);
    try {
      await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        provider: null,
        endpoint: null,
        model: null,
        apiKey: null,
      });
      setEndpoint("");
      setModel("");
      setProvider("ollama");
      setApiKey("");
      await updateStatus();
      setMessage({ text: copy("settings.embedding.cleared"), ok: true });
    } catch {
      setMessage({ text: copy("settings.embedding.saveFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const configured = status?.embedding.configured === true;
  const statusLabel = copy(`settings.embedding.phase.${status?.embedding.phase ?? "pending"}`);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-muted/40"
            aria-label={copy("settings.embedding.title")}
            data-testid="model-settings-embeddings-toggle"
          >
            <span className="flex min-w-0 items-center gap-2 text-ui-sm font-medium">
              <PlugZap className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{copy("settings.embedding.title")}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-ui-xs text-muted-foreground">
              {statusLabel}
              <ChevronDown
                className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border px-4 py-3">
            {status?.diagnostics[0] ? (
              <p className="mb-2 line-clamp-2 text-ui-xs text-amber-600 dark:text-amber-400" title={status.diagnostics[0]}>
                {status.diagnostics[0]}
              </p>
            ) : null}
            <form className="space-y-2" onSubmit={(event) => void save(event)}>
              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                <Select
                  value={provider}
                  onValueChange={(value) => {
                    const next = value as EmbeddingProvider;
                    setProvider(next);
                    if (!endpoint.trim() || endpoint === LOCAL_ENDPOINT || endpoint === OPENAI_ENDPOINT)
                      setEndpoint(next === "ollama" ? LOCAL_ENDPOINT : OPENAI_ENDPOINT);
                  }}
                  disabled={busy !== null}
                >
                  <SelectTrigger
                    aria-label={copy("settings.embedding.provider")}
                    data-testid="agent-workbench-embedding-provider"
                    className="h-9 min-w-0"
                  >
                    <SelectValue className="min-w-0 truncate" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ollama">{copy("settings.embedding.ollama")}</SelectItem>
                    <SelectItem value="openai-compatible">
                      {copy("settings.embedding.openaiCompatible")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  aria-label={copy("settings.embedding.endpoint")}
                  data-testid="agent-workbench-embedding-endpoint"
                  className="h-9 min-w-0"
                  placeholder={provider === "ollama" ? LOCAL_ENDPOINT : OPENAI_ENDPOINT}
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={copy("settings.embedding.model")}
                  data-testid="agent-workbench-embedding-model"
                  className="h-9 min-w-0"
                  placeholder={provider === "ollama" ? "nomic-embed-text" : "openai/text-embedding-3-small"}
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={busy !== null}
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  aria-label={copy("settings.embedding.apiKey")}
                  data-testid="agent-workbench-embedding-api-key"
                  className="h-9 min-w-0"
                  placeholder={status?.embedding.apiKeyConfigured
                    ? copy("settings.embedding.tokenSaved")
                    : copy("settings.embedding.apiKey")}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={busy !== null}
                />
              </div>
              <p className="text-ui-xs text-muted-foreground">
                {copy("settings.embedding.privacy")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="agent-workbench-test-embedding"
                  disabled={busy !== null || !endpoint.trim() || !model.trim()}
                  onClick={() => void test()}
                >
                  {busy === "test" ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
                  {copy("settings.embedding.test")}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  data-testid="agent-workbench-save-embedding"
                  disabled={busy !== null || !endpoint.trim() || !model.trim()}
                >
                  {busy === "save" ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
                  {copy("settings.embedding.save")}
                </Button>
                {status?.embedding.apiKeyConfigured ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-ui-xs text-muted-foreground"
                    disabled={busy !== null}
                    onClick={() => void clearToken()}
                  >
                    {copy("settings.embedding.forgetToken")}
                  </Button>
                ) : null}
                {configured ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-ui-xs text-muted-foreground"
                    disabled={busy !== null}
                    onClick={() => void clearConfig()}
                  >
                    {copy("settings.embedding.clear")}
                  </Button>
                ) : null}
              </div>
            </form>
            {message ? (
              <p
                role="status"
                className={`mt-2 flex items-center gap-1 text-ui-xs ${message.ok ? "text-emerald-600" : "text-destructive"}`}
                data-testid="agent-workbench-embedding-message"
              >
                {message.ok ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {message.text}
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
