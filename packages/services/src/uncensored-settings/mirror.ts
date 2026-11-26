import type { ZCodeUncensoredProviderConfig } from "@zcode/shared";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";

/** Mirrors are derived state: every sync replaces the whole prefix-owned group. */
export const UNCENSORED_MIRROR_PREFIX = "Uncensored · ";

type ProviderSettingsMirrorPort = Pick<
  IProviderSettingsService,
  "getView" | "createPersonalProvider" | "deletePersonalProvider" | "addPersonalModel"
>;

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MODEL_METADATA_TIMEOUT_MS = 8_000;

interface ModelMetadata {
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** `apiUrl` is the full chat endpoint; the registry appends `/chat/completions` to baseUrl. */
function mirrorBaseUrl(apiUrl: string): string {
  return apiUrl.replace(/\/chat\/completions\/?$/u, "").replace(/\/$/u, "");
}

function positiveInt(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function metadataFromEntry(entry: unknown): ModelMetadata {
  if (!entry || typeof entry !== "object") return {};
  const record = entry as Record<string, unknown>;
  return {
    contextWindow:
      positiveInt(record.context_length) ??
      positiveInt(record.context_window) ??
      positiveInt(record.max_context_length) ??
      positiveInt(record.max_model_len),
    maxOutputTokens:
      positiveInt(record.max_output_tokens) ?? positiveInt(record.max_completion_tokens),
  };
}

/**
 * Model catalogs are inconsistent: OpenAI-compatible `/models` often omits limits, while
 * providers such as nano-gpt expose them only with `?detailed=true`. Try the detailed
 * catalog first, then the plain one, and fall back to a conservative default.
 */
async function fetchModelMetadata(
  provider: ZCodeUncensoredProviderConfig,
  fetchImpl: typeof fetch,
): Promise<ReadonlyMap<string, ModelMetadata>> {
  const baseUrl = mirrorBaseUrl(provider.apiUrl);
  const headers: Record<string, string> = {};
  if (provider.apiKey && provider.apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  for (const url of [`${baseUrl}/models?detailed=true`, `${baseUrl}/models`]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_METADATA_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const body = (await response.json()) as { data?: unknown };
      if (!Array.isArray(body.data)) continue;
      const metadata = new Map<string, ModelMetadata>();
      for (const entry of body.data) {
        if (!entry || typeof entry !== "object") continue;
        const id = (entry as { id?: unknown }).id;
        if (typeof id !== "string" || id.length === 0) continue;
        metadata.set(id, metadataFromEntry(entry));
      }
      if (metadata.size > 0) return metadata;
    } catch {
      // Catalog is optional metadata; the fallback below keeps the mirror usable.
    } finally {
      clearTimeout(timer);
    }
  }
  return new Map();
}

function modelProperties(contextWindow: number) {
  return {
    contextWindow,
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
  };
}

/**
 * Host-side mirror of uncensored providers into the normal provider registry. The key never
 * leaves the Host: the renderer only sees the resulting provider/model entries. Mirrors are
 * named with a fixed prefix and fully replaced on every sync, so removed providers/models do
 * not leave ghosts. Best-effort: a registry failure must not fail the settings save.
 */
export async function mirrorUncensoredProviders(
  providerSettings: ProviderSettingsMirrorPort,
  providers: readonly ZCodeUncensoredProviderConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReadonlyMap<string, string>> {
  const view = await providerSettings.getView();
  for (const existing of view.providers) {
    if (existing.providerName?.startsWith(UNCENSORED_MIRROR_PREFIX)) {
      await providerSettings.deletePersonalProvider(existing.providerId);
    }
  }
  // providerName → mirrored providerId; the takeover uses the same normal provider as chat.
  const mirrored = new Map<string, string>();
  for (const provider of providers) {
    if (provider.models.length === 0) continue;
    const metadata = await fetchModelMetadata(provider, fetchImpl);
    const created = await providerSettings.createPersonalProvider({
      providerName: `${UNCENSORED_MIRROR_PREFIX}${provider.name}`,
      initialConfig: {
        access: { type: "api-key", apiKey: provider.apiKey ?? "" },
        api: { type: "openai-chat-completions", baseUrl: mirrorBaseUrl(provider.apiUrl) },
        personalModelIds: [],
        modelOrder: [],
      },
    });
    mirrored.set(provider.name, created.providerId);
    for (const model of provider.models) {
      const meta = metadata.get(model.id);
      const contextWindow = meta?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const maxOutputTokens = Math.min(
        meta?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        contextWindow,
      );
      await providerSettings.addPersonalModel(
        created.providerId,
        model.id,
        {
          enabled: true,
          properties: modelProperties(contextWindow),
          optionSpecs: {
            // Thinking-модели тратят общий с ответом бюджет на reasoning и отдают пустой
            // content (finish_reason: length). Перехвату нужен готовый ответ, поэтому
            // единственный уровень явно выключает обдумывание на проводе.
            reasoningLevel: { values: ["disabled"], map: "{'reasoning_effort': 'none'}" },
            maxOutputTokens: { max: maxOutputTokens },
          },
        },
        true,
      );
    }
  }
  return mirrored;
}
