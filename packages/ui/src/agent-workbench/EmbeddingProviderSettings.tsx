import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Cpu, Database, Download, LoaderCircle, Play } from "lucide-react";
import { Button } from "@/components/ui/button.js";
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
  LocalEmbeddingRuntimeStatus,
} from "./contract.js";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/api/embed";
const OPENAI_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function EmbeddingProviderSettings({
  codeIndex,
  workspaceRef,
}: {
  codeIndex?: CodeIntelligenceService;
  workspaceRef?: CodeWorkspaceRef;
}) {
  const { intl } = useZCodeIntl();
  const copy = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const [status, setStatus] = useState<CodeIndexStatus | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<EmbeddingProvider>("ollama");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "clear-token" | "clear" | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalEmbeddingRuntimeStatus | null>(null);
  const [localBusy, setLocalBusy] = useState<"install" | "pull" | "use" | null>(null);
  const [localMessage, setLocalMessage] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!codeIndex || !workspaceRef) {
      setStatus(null);
      return;
    }
    void codeIndex
      .getStatus(workspaceRef)
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setEndpoint(next.embedding.endpoint ?? "");
        setModel(next.embedding.model ?? "");
        setProvider(next.embedding.provider ?? "ollama");
      })
      .catch(() => {
        if (!cancelled) setMessage({ text: copy("settings.embedding.statusFailed"), ok: false });
      });
    return () => {
      cancelled = true;
    };
  }, [codeIndex, copy, workspaceRef]);

  const refreshLocalStatus = useCallback(async () => {
    if (!codeIndex?.localEmbeddings) return;
    try {
      const next = await codeIndex.localEmbeddings.getStatus();
      setLocalStatus(next);
      if (!endpoint.trim() && !model.trim()) {
        setProvider("ollama");
        setEndpoint(LOCAL_ENDPOINT);
        setModel(next.recommended.model);
      }
    } catch {
      // Older Hosts may not expose the local-runtime channel; the manual form still works.
      setLocalStatus(null);
    }
  }, [codeIndex, endpoint, model]);

  useEffect(() => {
    if (!codeIndex?.localEmbeddings) return;
    void refreshLocalStatus();
    // Only load once; install/pull actions refresh it explicitly.
  }, [codeIndex]);

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
      // A successful probe does not save credentials. Keep the draft so Save can persist it.
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

  const installLocal = async () => {
    if (!codeIndex?.localEmbeddings) return;
    setLocalBusy("install");
    setLocalMessage(null);
    try {
      const result = await codeIndex.localEmbeddings.install();
      if (result.status === "failed") {
        setLocalMessage({
          text: `${copy("settings.embedding.local.installFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      await refreshLocalStatus();
      setLocalMessage({
        text: copy("settings.embedding.local.runtimeInstalled"),
        ok: true,
      });
    } catch {
      setLocalMessage({ text: copy("settings.embedding.local.installFailed"), ok: false });
    } finally {
      setLocalBusy(null);
    }
  };

  const downloadLocalModel = async () => {
    if (!codeIndex?.localEmbeddings || !workspaceRef || !localStatus) return;
    const modelId = localStatus.recommended.model;
    setLocalBusy("pull");
    setLocalMessage(null);
    try {
      const result = await codeIndex.localEmbeddings.pull(modelId);
      if (result.status === "failed") {
        setLocalMessage({
          text: `${copy("settings.embedding.local.downloadFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        provider: "ollama",
        endpoint: LOCAL_ENDPOINT,
        model: modelId,
      });
      setProvider("ollama");
      setEndpoint(LOCAL_ENDPOINT);
      setModel(modelId);
      await updateStatus();
      await refreshLocalStatus();
      setLocalMessage({
        text: copy("settings.embedding.local.ready", { model: modelId }),
        ok: true,
      });
    } catch {
      setLocalMessage({ text: copy("settings.embedding.local.downloadFailed"), ok: false });
    } finally {
      setLocalBusy(null);
    }
  };

  const useInstalledLocalModel = async () => {
    if (!codeIndex || !workspaceRef || !localStatus) return;
    const modelId = localStatus.recommended.model;
    setLocalBusy("use");
    setLocalMessage(null);
    try {
      await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        provider: "ollama",
        endpoint: LOCAL_ENDPOINT,
        model: modelId,
        apiKey: null,
      });
      setProvider("ollama");
      setEndpoint(LOCAL_ENDPOINT);
      setModel(modelId);
      await updateStatus();
      setLocalMessage({
        text: copy("settings.embedding.local.ready", { model: modelId }),
        ok: true,
      });
    } catch {
      setLocalMessage({ text: copy("settings.embedding.saveFailed"), ok: false });
    } finally {
      setLocalBusy(null);
    }
  };

  const configured = status?.embedding.configured === true;
  const statusLabel = copy(`settings.embedding.phase.${status?.embedding.phase ?? "pending"}`);
  const recommendedModel = localStatus?.recommended.model;
  const localModelInstalled =
    recommendedModel !== undefined &&
    (localStatus?.models.some((model) => model.id.split(":")[0] === recommendedModel) ?? false);

  return (
    <section className="max-w-3xl space-y-4" data-testid="embedding-provider-settings">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="truncate text-ui-lg font-semibold">{copy("settings.embedding.title")}</h2>
        </div>
        <span className="shrink-0 text-ui-sm text-muted-foreground">{statusLabel}</span>
      </header>
      {localStatus ? (
        <section
          className="space-y-2 rounded-lg border border-border bg-card p-3"
          data-testid="local-embedding-runtime"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Cpu className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <h3 className="truncate text-ui-base font-semibold">
                {copy("settings.embedding.local.title")}
              </h3>
            </div>
            <span className="text-ui-xs text-muted-foreground">
              {localStatus.installed
                ? localStatus.running
                  ? copy("settings.embedding.local.running")
                  : copy("settings.embedding.local.stopped")
                : copy("settings.embedding.local.runtimeMissing")}
            </span>
          </div>
          <p className="text-ui-xs text-muted-foreground">
            {copy("settings.embedding.local.description")}
          </p>
          {recommendedModel ? (
            <>
              <p className="text-ui-xs text-muted-foreground">
                {copy("settings.embedding.local.recommended", {
                  model: recommendedModel,
                  dimensions: localStatus.recommended.dimensions,
                  size: formatBytes(localStatus.recommended.downloadBytes),
                })}
              </p>
              <p className="text-ui-xs text-muted-foreground">{localStatus.recommended.reason}</p>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {!localStatus.installed ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={localBusy !== null}
                onClick={() => void installLocal()}
              >
                {localBusy === "install" ? (
                  <LoaderCircle className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 size-3.5" />
                )}
                {copy("settings.embedding.local.installRuntime")}
              </Button>
            ) : null}
            {localStatus.installed && recommendedModel && !localModelInstalled ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={localBusy !== null}
                onClick={() => void downloadLocalModel()}
              >
                {localBusy === "pull" ? (
                  <LoaderCircle className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 size-3.5" />
                )}
                {copy("settings.embedding.local.downloadModel", {
                  model: recommendedModel,
                  size: formatBytes(localStatus.recommended.downloadBytes),
                })}
              </Button>
            ) : null}
            {localModelInstalled && recommendedModel ? (
              <Button
                type="button"
                size="sm"
                disabled={localBusy !== null}
                onClick={() => void useInstalledLocalModel()}
              >
                {localBusy === "use" ? (
                  <LoaderCircle className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Play className="mr-1 size-3.5" />
                )}
                {copy("settings.embedding.local.use", { model: recommendedModel })}
              </Button>
            ) : null}
          </div>
          {localMessage ? (
            <p
              role="status"
              className={`text-ui-xs ${localMessage.ok ? "text-emerald-600" : "text-destructive"}`}
            >
              {localMessage.text}
            </p>
          ) : null}
        </section>
      ) : null}
      {status?.diagnostics[0] ? (
        <p
          className="line-clamp-2 text-ui-xs text-amber-600 dark:text-amber-400"
          title={status.diagnostics[0]}
        >
          {status.diagnostics[0]}
        </p>
      ) : null}
      <form className="space-y-3" onSubmit={(event) => void save(event)}>
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
            placeholder={
              provider === "ollama" ? "nomic-embed-text" : "openai/text-embedding-3-small"
            }
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
            placeholder={
              status?.embedding.apiKeyConfigured
                ? copy("settings.embedding.tokenSaved")
                : copy("settings.embedding.apiKey")
            }
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={busy !== null}
          />
        </div>
        <p className="text-ui-xs text-muted-foreground">{copy("settings.embedding.privacy")}</p>
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
          className={`flex items-center gap-1 text-ui-xs ${message.ok ? "text-emerald-600" : "text-destructive"}`}
          data-testid="agent-workbench-embedding-message"
        >
          {message.ok ? <Check className="size-3.5" aria-hidden="true" /> : null}
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
