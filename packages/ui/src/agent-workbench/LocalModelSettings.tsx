import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Cpu, Download, HardDrive, LoaderCircle } from "lucide-react";
import type { CodeIntelligenceService, CodeWorkspaceRef } from "./contract.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

type ProviderConfigInput = ProviderSettingsFormProvider["config"];
type ModelConfigInput = ProviderSettingsFormProvider["models"][number]["personalConfig"];
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

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
  const [runtime, setRuntime] = useState<Awaited<
    ReturnType<NonNullable<CodeIntelligenceService["localEmbeddings"]>["getStatus"]>
  > | null>(null);
  const [busy, setBusy] = useState<"install" | string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [customModel, setCustomModel] = useState("");

  const refreshRuntime = useCallback(async () => {
    if (!codeIndex?.localEmbeddings) return;
    try {
      setRuntime(await codeIndex.localEmbeddings.getStatus());
    } catch {
      setRuntime(null);
    }
  }, [codeIndex]);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const installed = useMemo(() => {
    const ids = new Set((runtime?.models ?? []).map((model) => normalizeModelId(model.id)));
    return ids;
  }, [runtime]);

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
    if (!codeIndex?.localEmbeddings) return;
    setBusy("install");
    setMessage(null);
    try {
      const result = await codeIndex.localEmbeddings.install();
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
      await addPersonalModel(providerId, model.id, localModelConfig(model), false);
    }
    await onRefresh();
  };

  const download = async (model: LocalChatModel) => {
    if (!codeIndex?.localEmbeddings) return;
    setBusy(model.id);
    setMessage(null);
    try {
      if (!runtime?.installed) {
        const installedRuntime = await codeIndex.localEmbeddings.install();
        if (installedRuntime.status === "failed") {
          setMessage({
            text: `${copy("settings.localModel.installFailed")}: ${installedRuntime.diagnostic}`,
            ok: false,
          });
          return;
        }
      }
      const result = await codeIndex.localEmbeddings.pull(model.id);
      if (result.status === "failed") {
        setMessage({
          text: `${copy("settings.localModel.downloadFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      await ensureProviderModel(model);
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
    if (!codeIndex?.localEmbeddings) return;
    const id = customModel.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)?$/u.test(id)) {
      setMessage({ text: copy("settings.localModel.invalidModel"), ok: false });
      return;
    }
    setBusy(id);
    setMessage(null);
    try {
      if (!runtime?.installed) {
        const installedRuntime = await codeIndex.localEmbeddings.install();
        if (installedRuntime.status === "failed") {
          setMessage({
            text: `${copy("settings.localModel.installFailed")}: ${installedRuntime.diagnostic}`,
            ok: false,
          });
          return;
        }
      }
      const result = await codeIndex.localEmbeddings.pull(id);
      if (result.status === "failed") {
        setMessage({
          text: `${copy("settings.localModel.downloadFailed")}: ${result.diagnostic}`,
          ok: false,
        });
        return;
      }
      await ensureProviderModel({
        id,
        label: id,
        downloadBytes: 0,
        minRamBytes: 0,
        contextWindow: 32_768,
      });
      await refreshRuntime();
      setMessage({ text: copy("settings.localModel.ready", { model: id }), ok: true });
    } catch {
      setMessage({ text: copy("settings.localModel.downloadFailed"), ok: false });
    } finally {
      setBusy(null);
    }
  };

  if (!codeIndex?.localEmbeddings || !workspaceRef) {
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

      {!runtime?.installed ? (
        <div className="rounded-lg border border-border bg-card p-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
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
            disabled={busy !== null}
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
                disabled={busy !== null}
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
            disabled={busy !== null || !customModel.trim()}
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
