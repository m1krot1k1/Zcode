import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Cpu, Download, HardDrive, LoaderCircle } from "lucide-react";
import type { CodeIntelligenceService, CodeWorkspaceRef } from "./contract.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

type ProviderConfigInput = ProviderSettingsFormProvider["config"];
type ModelConfigInput = ProviderSettingsFormProvider["models"][number]["personalConfig"];
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveLocalRuntimeApi } from "./localRuntimeApi.js";

const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const OLLAMA_PROVIDER_NAME = "Ollama (local)";
const GB = 1024 ** 3;

interface LocalChatModel {
  readonly id: string;
  readonly label: string;
  readonly downloadBytes: number;
  readonly minRamBytes: number;
  readonly contextWindow: number;
}

/** Qwen3 family: small enough for laptops, MoE 30B for 32+ GB machines. */
const LOCAL_CHAT_MODELS: readonly LocalChatModel[] = [
  {
    id: "qwen3:4b",
    label: "Qwen3 4B",
    downloadBytes: 2_500_000_000,
    minRamBytes: 8 * GB,
    contextWindow: 32_768,
  },
  {
    id: "qwen3:8b",
    label: "Qwen3 8B",
    downloadBytes: 5_000_000_000,
    minRamBytes: 16 * GB,
    contextWindow: 32_768,
  },
  {
    id: "qwen3:14b",
    label: "Qwen3 14B",
    downloadBytes: 9_000_000_000,
    minRamBytes: 24 * GB,
    contextWindow: 32_768,
  },
  {
    id: "qwen3:30b-a3b",
    label: "Qwen3 30B A3B (MoE)",
    downloadBytes: 19_000_000_000,
    minRamBytes: 32 * GB,
    contextWindow: 32_768,
  },
  {
    id: "qwen3-coder:30b",
    label: "Qwen3 Coder 30B A3B",
    downloadBytes: 19_000_000_000,
    minRamBytes: 32 * GB,
    contextWindow: 32_768,
  },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

function normalizeModelId(id: string): string {
  return id
    .trim()
    .replace(/:latest$/u, "")
    .toLowerCase();
}

/** Embedding-only Ollama models must never be offered as chat models in Composer. */
function isEmbeddingModelId(id: string): boolean {
  return /(?:^|[/:])(?:bge(?:[-:]|$)|nomic-embed|mxbai-embed|all-minilm|snowflake-arctic-embed|text-embedding|embeddinggemma|e5-|gte-|jina-embed)/iu.test(
    id,
  );
}

function pickRecommended(totalMemoryBytes: number | undefined): LocalChatModel {
  const memory = totalMemoryBytes && totalMemoryBytes > 0 ? totalMemoryBytes : 16 * GB;
  const fitting = LOCAL_CHAT_MODELS.filter((model) => memory >= model.minRamBytes);
  return fitting.at(-1) ?? LOCAL_CHAT_MODELS[0]!;
}

function localModelConfig(model: LocalChatModel): ModelConfigInput {
  return {
    enabled: true,
    properties: {
      contextWindow: model.contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      requiresMfjsToolSchema: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 8192 },
    },
  };
}

export interface LocalModelSettingsProps {
  codeIndex?: CodeIntelligenceService;
  workspaceRef?: CodeWorkspaceRef;
  modelProviders: readonly ProviderSettingsFormProvider[];
  createPersonalProvider: (input?: {
    providerName?: string;
    initialConfig?: ProviderConfigInput;
  }) => Promise<{ providerId: string }>;
  addPersonalModel: (
    providerId: string,
    modelId: string,
    config: ModelConfigInput,
    useRecommendedConfig?: boolean,
  ) => Promise<unknown>;
  onRefresh: () => Promise<void> | void;
}

export function LocalModelSettings({
  codeIndex,
  workspaceRef,
  modelProviders,
  createPersonalProvider,
  addPersonalModel,
  onRefresh,
}: LocalModelSettingsProps) {
  const { intl } = useZCodeIntl();
  const copy = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const localRuntime = useMemo(() => resolveLocalRuntimeApi(codeIndex), [codeIndex]);
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<NonNullable<typeof localRuntime>["getStatus"]>
  > | null>(null);
  const [busy, setBusy] = useState<"install" | string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [customModel, setCustomModel] = useState("");
  const activeDownloads =
    runtime?.downloads?.filter(
      (download) => download.state === "downloading" || download.state === "verifying",
    ) ?? [];

  const refreshRuntime = useCallback(async () => {
    if (!localRuntime) {
      setRuntime(null);
      return;
    }
    try {
      let next = await localRuntime.getStatus();
      // Installed but stopped after an app restart: start it when the local-model
      // settings open so the Composer can use the already downloaded model.
      if (next.installed && !next.running) {
        await localRuntime.start().catch(() => false);
        next = await localRuntime.getStatus();
      }
      setRuntime(next);
    } catch {
      setRuntime(null);
    }
  }, [localRuntime]);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  useEffect(() => {
    if (activeDownloads.length === 0 && busy === null) return;
    const timer = window.setInterval(() => void refreshRuntime(), 1000);
    return () => window.clearInterval(timer);
  }, [activeDownloads.length, busy, refreshRuntime]);

  const installed = useMemo(() => {
    const ids = new Set((runtime?.models ?? []).map((model) => normalizeModelId(model.id)));
    return ids;
  }, [runtime]);
  const installedChatModels = useMemo(
    () => [...installed].filter((id) => !isEmbeddingModelId(id)),
    [installed],
  );

  const recommended = useMemo(
    () => pickRecommended(runtime?.totalMemoryBytes),
    [runtime?.totalMemoryBytes],
  );

  const ollamaProvider = useMemo(
    () =>
      modelProviders.find((provider) => {
        const api = provider.config?.api;
        return (
          api?.type === "openai-chat-completions" &&
          api.baseUrl?.replace(/\/+$/u, "") === OLLAMA_BASE_URL
        );
      }),
    [modelProviders],
  );

  const installRuntime = async () => {
    if (!localRuntime) return;
    setBusy("install");
    setMessage(null);
    try {
      const result = await localRuntime.install();
      if (result.status === "failed") {
        setMessage({
          text: `${copy("settings.localModel.installFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      await refreshRuntime();
      setMessage({ text: copy("settings.localModel.runtimeInstalled"), ok: true });
    } catch {
      setMessage({ text: copy("settings.localModel.installFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const ensureProviderModel = async (model: LocalChatModel) => {
    let providerId = ollamaProvider?.providerId;
    if (!providerId) {
      const created = await createPersonalProvider({
        providerName: OLLAMA_PROVIDER_NAME,
        initialConfig: {
          access: { type: "api-key", apiKey: "ollama" },
          api: { type: "openai-chat-completions", baseUrl: OLLAMA_BASE_URL },
          personalModelIds: [],
          modelOrder: [],
        },
      });
      providerId = created.providerId;
    }
    const alreadyAdded = ollamaProvider?.models.some((candidate) => candidate.modelId === model.id);
    if (!alreadyAdded) {
      await addPersonalModel(providerId, model.id, localModelConfig(model), true);
    }
    await onRefresh();
  };

  const download = async (model: LocalChatModel) => {
    if (!localRuntime) return;
    setBusy(model.id);
    setMessage(null);
    try {
      if (!runtime?.installed) {
        const installedRuntime = await localRuntime.install();
        if (installedRuntime.status === "failed") {
          setMessage({
            text: `${copy("settings.localModel.installFailed")}: ${installedRuntime.diagnostic}`,
            ok: false,
          });
          return;
        }
      }
      const result = await localRuntime.pull(model.id);
      if (result.status === "failed") {
        setMessage({
          text: `${copy("settings.localModel.downloadFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      try {
        await ensureProviderModel(model);
      } catch {
        setMessage({ text: copy("settings.localModel.providerFailed"), ok: false });
        return;
      }
      await refreshRuntime();
      setMessage({
        text: copy("settings.localModel.ready", { model: model.label }),
        ok: true,
      });
    } catch {
      setMessage({ text: copy("settings.localModel.downloadFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  const downloadCustom = async () => {
    if (!localRuntime) return;
    const id = customModel.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)?$/u.test(id)) {
      setMessage({ text: copy("settings.localModel.invalidModel"), ok: false });
      return;
    }
    setBusy(id);
    setMessage(null);
    try {
      if (!runtime?.installed) {
        const installedRuntime = await localRuntime.install();
        if (installedRuntime.status === "failed") {
          setMessage({
            text: `${copy("settings.localModel.installFailed")}: ${installedRuntime.diagnostic}`,
            ok: false,
          });
          return;
        }
      }
      const result = await localRuntime.pull(id);
      if (result.status === "failed") {
        setMessage({
          text: `${copy("settings.localModel.downloadFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      try {
        await ensureProviderModel({
          id,
          label: id,
          downloadBytes: 0,
          minRamBytes: 0,
          contextWindow: 32_768,
        });
      } catch {
        setMessage({ text: copy("settings.localModel.providerFailed"), ok: false });
        return;
      }
      await refreshRuntime();
      setMessage({ text: copy("settings.localModel.ready", { model: id }), ok: true });
    } catch {
      setMessage({ text: copy("settings.localModel.downloadFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  if (!localRuntime || !workspaceRef) {
    return (
      <section className="max-w-3xl space-y-2" data-testid="local-model-settings">
        <h2 className="text-ui-lg font-semibold">{copy("settings.localModel.title")}</h2>
        <p className="text-ui-sm text-muted-foreground">
          {copy("settings.localModel.unavailable")}
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-3xl space-y-4" data-testid="local-model-settings">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Cpu className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="truncate text-ui-lg font-semibold">{copy("settings.localModel.title")}</h2>
        </div>
        <span className="shrink-0 text-ui-sm text-muted-foreground">
          {!runtime
            ? copy("settings.localModel.statusLoading")
            : !runtime.installed
              ? copy("settings.localModel.runtimeMissing")
              : runtime.running
                ? copy("settings.localModel.running")
                : copy("settings.localModel.stopped")}
        </span>
      </header>
      <p className="text-ui-sm text-muted-foreground">{copy("settings.localModel.description")}</p>

      {activeDownloads.map((download) => {
        const percent =
          download.totalBytes && download.totalBytes > 0
            ? Math.min(
                100,
                Math.round(((download.completedBytes ?? 0) / download.totalBytes) * 100),
              )
            : null;
        return (
          <div
            key={download.model}
            className="space-y-1 rounded-lg border border-border bg-card p-3"
            data-testid={`local-model-download-${download.model}`}
          >
            <div className="flex items-center justify-between gap-2 text-ui-xs text-muted-foreground">
              <span className="truncate">
                {download.model} · {download.statusText ?? copy("settings.localModel.downloading")}
              </span>
              <span>
                {percent !== null
                  ? `${percent}%`
                  : download.completedBytes
                    ? formatBytes(download.completedBytes)
                    : ""}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${percent ?? 15}%` }}
              />
            </div>
          </div>
        );
      })}

      {!runtime?.installed ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null || activeDownloads.length > 0}
            onClick={() => void installRuntime()}
          >
            {busy === "install" ? (
              <LoaderCircle className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 size-3.5" />
            )}
            {copy("settings.localModel.installRuntime")}
          </Button>
        </div>
      ) : null}

      <div
        className="rounded-lg border border-border bg-card p-3"
        data-testid="local-model-recommended"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-ui-sm font-semibold">
              {copy("settings.localModel.recommended", {
                model: recommended.label,
                memory: runtime?.totalMemoryBytes
                  ? formatBytes(runtime.totalMemoryBytes)
                  : copy("settings.localModel.memoryUnknown"),
              })}
            </p>
            <p className="mt-0.5 text-ui-xs text-muted-foreground">
              {copy("settings.localModel.recommendedReason", {
                size: formatBytes(recommended.downloadBytes),
              })}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null || activeDownloads.length > 0}
            onClick={() => void download(recommended)}
          >
            {busy === recommended.id ? (
              <LoaderCircle className="mr-1 size-3.5 animate-spin" />
            ) : installed.has(normalizeModelId(recommended.id)) ? (
              <Check className="mr-1 size-3.5" />
            ) : (
              <Download className="mr-1 size-3.5" />
            )}
            {installed.has(normalizeModelId(recommended.id))
              ? copy("settings.localModel.addToComposer")
              : copy("settings.localModel.download")}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {LOCAL_CHAT_MODELS.map((model) => {
          const isInstalled = installed.has(normalizeModelId(model.id));
          return (
            <div
              key={model.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
              data-testid={`local-model-row-${model.id}`}
            >
              <div className="min-w-0">
                <p className="text-ui-sm font-medium">
                  {model.label}
                  <span className="ml-2 text-ui-xs text-muted-foreground">
                    {formatBytes(model.downloadBytes)}
                  </span>
                </p>
                <p className="text-ui-xs text-muted-foreground">
                  {copy("settings.localModel.minMemory", {
                    memory: formatBytes(model.minRamBytes),
                  })}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={isInstalled ? "outline" : "default"}
                disabled={busy !== null || activeDownloads.length > 0}
                onClick={() => void download(model)}
              >
                {busy === model.id ? (
                  <LoaderCircle className="mr-1 size-3.5 animate-spin" />
                ) : isInstalled ? (
                  <Check className="mr-1 size-3.5" />
                ) : (
                  <Download className="mr-1 size-3.5" />
                )}
                {isInstalled
                  ? copy("settings.localModel.addToComposer")
                  : copy("settings.localModel.download")}
              </Button>
            </div>
          );
        })}
      </div>

      {installedChatModels.length > 0 ? (
        <div className="space-y-2" data-testid="local-model-installed">
          <p className="text-ui-sm font-medium">{copy("settings.localModel.installedTitle")}</p>
          {installedChatModels.map((id) => {
            const catalogModel = LOCAL_CHAT_MODELS.find(
              (candidate) => normalizeModelId(candidate.id) === id,
            );
            const model = catalogModel ?? {
              id,
              label: id,
              downloadBytes: 0,
              minRamBytes: 0,
              contextWindow: 32_768,
            };
            return (
              <div
                key={id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
              >
                <span className="text-ui-sm">{model.label}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || activeDownloads.length > 0}
                  onClick={() => void download(model)}
                >
                  {busy === model.id ? (
                    <LoaderCircle className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Check className="mr-1 size-3.5" />
                  )}
                  {copy("settings.localModel.addToComposer")}
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-3">
        <p className="mb-2 flex items-center gap-1 text-ui-sm font-medium">
          <HardDrive className="size-3.5" aria-hidden="true" />
          {copy("settings.localModel.customTitle")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            value={customModel}
            onChange={(event) => setCustomModel(event.target.value)}
            placeholder={copy("settings.localModel.customPlaceholder")}
            className="min-w-52 flex-1"
            data-testid="local-model-custom-input"
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || activeDownloads.length > 0 || !customModel.trim()}
            onClick={() => void downloadCustom()}
          >
            {busy === customModel.trim() ? (
              <LoaderCircle className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 size-3.5" />
            )}
            {copy("settings.localModel.download")}
          </Button>
        </div>
        <p className="mt-2 text-ui-xs text-muted-foreground">
          {copy("settings.localModel.customHint")}
        </p>
      </div>

      {message ? (
        <p
          className={message.ok ? "text-ui-sm text-success" : "text-ui-sm text-destructive"}
          data-testid="local-model-message"
        >
          {message.text}
        </p>
      ) : null}
      <p className="text-ui-xs text-muted-foreground">{copy("settings.localModel.composerHint")}</p>
    </section>
  );
}
