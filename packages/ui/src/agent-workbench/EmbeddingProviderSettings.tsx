import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type {
  CodeIndexStatus,
  CodeIntelligenceService,
  CodeWorkspaceRef,
  EmbeddingProvider,
} from "./contract.js";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/api/embed";
const OPENAI_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
type Copy = (
  id: string,
  defaultMessage: string,
  values?: Record<string, string | number>,
) => string;

export function EmbeddingProviderSettings({
  codeIndex,
  workspaceRef,
  status,
  setStatus,
  busy,
  setBusy,
  copy,
}: {
  codeIndex?: CodeIntelligenceService;
  workspaceRef: CodeWorkspaceRef;
  status: CodeIndexStatus;
  setStatus: Dispatch<SetStateAction<CodeIndexStatus>>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  copy: Copy;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<EmbeddingProvider>("ollama");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setEndpoint(status.embedding.endpoint ?? "");
    setModel(status.embedding.model ?? "");
    setProvider(status.embedding.provider ?? "ollama");
  }, [status.embedding.endpoint, status.embedding.model, status.embedding.provider]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setStatus(next);
      setApiKey("");
      setMessage(copy("agentWorkbench.embeddingSaved", "Embedding settings saved."));
    } catch {
      setMessage(
        copy(
          "agentWorkbench.embeddingRejected",
          "Use an allowed endpoint URL and a model name. Keep API tokens out of the URL.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const clearToken = async () => {
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await codeIndex.setEmbeddingConfig({ ...workspaceRef, apiKey: null }));
      setApiKey("");
      setMessage(copy("agentWorkbench.embeddingTokenCleared", "Saved API token removed."));
    } catch {
      setMessage(
        copy("agentWorkbench.embeddingTokenClearFailed", "Could not remove the saved API token."),
      );
    } finally {
      setBusy(false);
    }
  };

  const clearConfig = async () => {
    if (!codeIndex) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await codeIndex.setEmbeddingConfig({
        ...workspaceRef,
        provider: null,
        endpoint: null,
        model: null,
        apiKey: null,
      });
      setStatus(next);
      setEndpoint("");
      setModel("");
      setProvider("ollama");
      setApiKey("");
      setMessage(copy("agentWorkbench.embeddingCleared", "Embedding settings cleared."));
    } catch {
      setMessage(
        copy("agentWorkbench.embeddingClearFailed", "Could not clear embedding settings."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mb-4 rounded-xl border bg-card p-3"
      aria-labelledby="embedding-config-heading"
    >
      <h3 id="embedding-config-heading" className="mb-2 text-ui-sm font-semibold">
        {copy("agentWorkbench.embeddingConfig", "Embedding provider")}
      </h3>
      <form className="space-y-2" onSubmit={(event) => void save(event)}>
        <Select
          value={provider}
          onValueChange={(value) => {
            const next = value as EmbeddingProvider;
            setProvider(next);
            if (!endpoint.trim() || endpoint === LOCAL_ENDPOINT || endpoint === OPENAI_ENDPOINT) {
              setEndpoint(next === "ollama" ? LOCAL_ENDPOINT : OPENAI_ENDPOINT);
            }
          }}
          disabled={!codeIndex || busy}
        >
          <SelectTrigger
            className="w-full"
            aria-label={copy("agentWorkbench.embeddingProvider", "Embedding provider")}
            data-testid="agent-workbench-embedding-provider"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ollama">
              {copy("agentWorkbench.embeddingOllama", "Local · Ollama")}
            </SelectItem>
            <SelectItem
              value="openai-compatible"
              data-testid="agent-workbench-openai-compatible-option"
            >
              {copy("agentWorkbench.embeddingOpenAiCompatible", "OpenAI-compatible API")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          aria-label={copy("agentWorkbench.embeddingEndpoint", "Embedding endpoint")}
          data-testid="agent-workbench-embedding-endpoint"
          placeholder={provider === "ollama" ? LOCAL_ENDPOINT : OPENAI_ENDPOINT}
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
        />
        <Input
          aria-label={copy("agentWorkbench.embeddingModel", "Embedding model")}
          data-testid="agent-workbench-embedding-model"
          placeholder={provider === "ollama" ? "nomic-embed-text" : "openai/text-embedding-3-small"}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        <Input
          type="password"
          autoComplete="new-password"
          aria-label={copy("agentWorkbench.embeddingApiKey", "Optional API token")}
          data-testid="agent-workbench-embedding-api-key"
          placeholder={
            status.embedding.apiKeyConfigured
              ? copy("agentWorkbench.embeddingTokenSaved", "Saved · leave blank to keep")
              : copy("agentWorkbench.embeddingApiKey", "Optional API token")
          }
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <p className="text-ui-xs text-muted-foreground">
          {copy(
            "agentWorkbench.embeddingPrivacy",
            "Remote providers receive source chunks and search queries to create embeddings. Ollama keeps requests on this machine.",
          )}
        </p>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="w-full"
          data-testid="agent-workbench-save-embedding"
          disabled={!codeIndex || busy}
        >
          {copy("agentWorkbench.saveEmbedding", "Save embedding settings")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full"
          data-testid="agent-workbench-clear-embedding-token"
          disabled={!codeIndex || busy || !status.embedding.apiKeyConfigured}
          onClick={() => void clearToken()}
        >
          {copy("agentWorkbench.clearEmbeddingToken", "Forget saved API token")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full"
          data-testid="agent-workbench-clear-embedding-settings"
          disabled={!codeIndex || busy || !status.embedding.configured}
          onClick={() => void clearConfig()}
        >
          {copy("agentWorkbench.clearEmbedding", "Clear embedding settings and token")}
        </Button>
      </form>
      {message ? (
        <p role="status" className="mt-2 text-ui-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
