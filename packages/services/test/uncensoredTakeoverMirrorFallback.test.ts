import { describe, expect, it, vi } from "vitest";
import { createUncensoredSettingsService } from "../src/uncensored-settings/service.js";
import type { UncensoredSettingsStorePort } from "../src/uncensored-settings/contract.js";

const workspace = { workspacePath: "/remote/ws" };

function storeWith(takeoverProviders: unknown[] = []): UncensoredSettingsStorePort {
  return {
    read: async () => ({ providers: [] }),
    write: async (_workspace, write) => ({ providers: [] as never, ...write }),
    readTakeoverConfig: async () =>
      ({ providers: takeoverProviders }) as Awaited<
        ReturnType<UncensoredSettingsStorePort["readTakeoverConfig"]>
      >,
  } as UncensoredSettingsStorePort;
}

const mirrorView = [
  {
    providerId: "mirror-1",
    providerName: "Uncensored · nano-gpt",
    baseUrl: "https://api.nano-gpt.test/api/v1",
    models: [
      { modelId: "deepseek/x:thinking", enabled: true, selectable: true },
      { modelId: "deepseek/off", enabled: false, selectable: true },
    ],
  },
  {
    providerId: "opencode",
    providerName: "OpenCode Go",
    baseUrl: "https://opencode.test/v1",
    models: [{ modelId: "gpt-5", enabled: true, selectable: true }],
  },
];

describe("getTakeoverConfig: восстановление из реестра", () => {
  it("строит конфиг из mirror-провайдера, когда стор пуст", async () => {
    const service = createUncensoredSettingsService({
      store: storeWith(),
      listMirrorProviders: async () => mirrorView,
    });
    const config = await service.getTakeoverConfig(workspace);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({
      name: "nano-gpt",
      providerId: "mirror-1",
      apiUrl: "https://api.nano-gpt.test/api/v1/chat/completions",
      apiKey: null,
      models: [{ id: "deepseek/x:thinking", enabled: true }],
    });
  });

  it("не берёт выключенные и неподдерживаемые модели", async () => {
    const service = createUncensoredSettingsService({
      store: storeWith(),
      listMirrorProviders: async () => [
        {
          providerId: "mirror-2",
          providerName: "Uncensored · p",
          baseUrl: "https://p.test/v1",
          models: [{ modelId: "m", enabled: true, selectable: false }],
        },
      ],
    });
    expect((await service.getTakeoverConfig(workspace)).providers).toEqual([]);
  });

  it("не дублирует путь /chat/completions", async () => {
    const service = createUncensoredSettingsService({
      store: storeWith(),
      listMirrorProviders: async () => [
        {
          providerId: "mirror-3",
          providerName: "Uncensored · p",
          baseUrl: "https://p.test/v1/chat/completions",
          models: [{ modelId: "m", enabled: true, selectable: true }],
        },
      ],
    });
    const [provider] = (await service.getTakeoverConfig(workspace)).providers;
    expect(provider?.apiUrl).toBe("https://p.test/v1/chat/completions");
  });

  it("оставляет конфиг из стора, когда он непустой", async () => {
    const listMirrorProviders = vi.fn(async () => mirrorView);
    const service = createUncensoredSettingsService({
      store: storeWith([
        {
          id: "saved",
          name: "nano-gpt",
          apiUrl: "https://saved.test/v1/chat/completions",
          apiKey: "sk-saved",
          providerId: "mirror-saved",
          models: [{ id: "deepseek/x", enabled: true }],
        },
      ]),
      listMirrorProviders,
    });
    const config = await service.getTakeoverConfig(workspace);
    expect(listMirrorProviders).not.toHaveBeenCalled();
    expect(config.providers[0]).toMatchObject({ apiKey: "sk-saved", providerId: "mirror-saved" });
  });

  it("отдаёт пусто, если реестр недоступен", async () => {
    const service = createUncensoredSettingsService({
      store: storeWith(),
      listMirrorProviders: async () => {
        throw new Error("registry down");
      },
    });
    await expect(service.getTakeoverConfig(workspace)).resolves.toEqual({ providers: [] });
  });
});
