import type { ZCodeUncensoredProviderConfig } from "@zcode/shared";
import type { IProviderSettingsService } from "../model-provider/providerFacadeServices.js";

/** Mirrors are derived state: every sync replaces the whole prefix-owned group. */
export const UNCENSORED_MIRROR_PREFIX = "Uncensored · ";

type ProviderSettingsMirrorPort = Pick<
  IProviderSettingsService,
  "getView" | "createPersonalProvider" | "deletePersonalProvider" | "addPersonalModel"
>;

const MODEL_PROPERTIES = {
  contextWindow: 32768,
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

const MODEL_OPTION_SPECS = {
  reasoningLevel: { values: ["disabled"], map: "{}" },
  maxOutputTokens: { max: 8192 },
};

/** `apiUrl` is the full chat endpoint; the registry appends `/chat/completions` to baseUrl. */
function mirrorBaseUrl(apiUrl: string): string {
  return apiUrl.replace(/\/chat\/completions\/?$/u, "");
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
): Promise<void> {
  const view = await providerSettings.getView();
  for (const existing of view.providers) {
    if (existing.providerName?.startsWith(UNCENSORED_MIRROR_PREFIX)) {
      await providerSettings.deletePersonalProvider(existing.providerId);
    }
  }
  for (const provider of providers) {
    if (provider.models.length === 0) continue;
    const created = await providerSettings.createPersonalProvider({
      providerName: `${UNCENSORED_MIRROR_PREFIX}${provider.name}`,
      initialConfig: {
        access: { type: "api-key", apiKey: provider.apiKey ?? "" },
        api: { type: "openai-chat-completions", baseUrl: mirrorBaseUrl(provider.apiUrl) },
        personalModelIds: [],
        modelOrder: [],
      },
    });
    for (const model of provider.models) {
      await providerSettings.addPersonalModel(
        created.providerId,
        model.id,
        {
          enabled: true,
          properties: MODEL_PROPERTIES,
          optionSpecs: MODEL_OPTION_SPECS,
        },
        true,
      );
    }
  }
}
