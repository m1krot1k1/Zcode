import { describe, expect, it, vi } from "vitest";
import type { ZCodeUncensoredProviderConfig } from "@zcode/shared";

import { mirrorUncensoredProviders, UNCENSORED_MIRROR_PREFIX } from "./mirror.js";

describe("uncensored provider mirror", () => {
  it("replaces only prefix-owned providers and strips the chat endpoint suffix", async () => {
    const view = {
      providers: [
        { providerId: "old-mirror", providerName: `${UNCENSORED_MIRROR_PREFIX}Old` },
        { providerId: "keep", providerName: "My provider" },
      ],
    };
    const settings = {
      getView: vi.fn(async () => view),
      deletePersonalProvider: vi.fn(async () => view),
      createPersonalProvider: vi.fn(async () => ({ providerId: "new-mirror" })),
      addPersonalModel: vi.fn(async () => view),
    };
    const providers: ZCodeUncensoredProviderConfig[] = [
      {
        id: "p1",
        name: "Provider One",
        apiUrl: "https://p1.test/v1/chat/completions",
        apiKey: "secret",
        models: [
          { id: "m1", enabled: true },
          { id: "m2", enabled: false },
        ],
      },
    ];

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: "m1", context_length: 1_048_576, max_output_tokens: 65_536 },
          { id: "m2", context_length: 1_048_576, max_output_tokens: 65_536 },
        ],
      }),
    }));

    await mirrorUncensoredProviders(
      settings as never,
      providers,
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://p1.test/v1/models?detailed=true",
      expect.objectContaining({ method: "GET" }),
    );
    expect(settings.deletePersonalProvider).toHaveBeenCalledTimes(1);
    expect(settings.deletePersonalProvider).toHaveBeenCalledWith("old-mirror");
    expect(settings.createPersonalProvider).toHaveBeenCalledWith({
      providerName: `${UNCENSORED_MIRROR_PREFIX}Provider One`,
      initialConfig: {
        access: { type: "api-key", apiKey: "secret" },
        api: { type: "openai-chat-completions", baseUrl: "https://p1.test/v1" },
        personalModelIds: [],
        modelOrder: [],
      },
    });
    expect(settings.addPersonalModel).toHaveBeenCalledTimes(2);
    expect(settings.addPersonalModel).toHaveBeenNthCalledWith(
      1,
      "new-mirror",
      "m1",
      expect.objectContaining({
        enabled: true,
        properties: expect.objectContaining({ contextWindow: 1_048_576 }),
        optionSpecs: expect.objectContaining({ maxOutputTokens: { max: 65_536 } }),
      }),
      true,
    );
    expect(settings.addPersonalModel).toHaveBeenNthCalledWith(
      2,
      "new-mirror",
      "m2",
      expect.objectContaining({
        enabled: true,
        properties: expect.objectContaining({ contextWindow: 1_048_576 }),
      }),
      true,
    );
  });

  it("creates no mirror for a provider without models", async () => {
    const settings = {
      getView: vi.fn(async () => ({ providers: [] })),
      deletePersonalProvider: vi.fn(),
      createPersonalProvider: vi.fn(async () => ({ providerId: "new" })),
      addPersonalModel: vi.fn(),
    };
    await mirrorUncensoredProviders(settings as never, [
      { id: "p1", name: "Empty", apiUrl: "https://p1.test/v1", apiKey: null, models: [] },
    ]);
    expect(settings.createPersonalProvider).not.toHaveBeenCalled();
    expect(settings.addPersonalModel).not.toHaveBeenCalled();
  });
});
