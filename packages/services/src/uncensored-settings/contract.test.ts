import { describe, expect, it, vi } from "vitest";

import type { ZCodeUncensoredProviderConfig } from "@zcode/shared";

import { uncensoredSettingsModule } from "./module.js";
import { createUncensoredSettingsService } from "./service.js";
import type { UncensoredSettingsStorePort } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("uncensored-settings contract", () => {
  it("declares its module manifest", () => {
    expect(uncensoredSettingsModule.id).toBe("uncensored-settings");
  });

  it("sends one direct message with the Host-owned key and never returns it", async () => {
    const store = {
      read: async () => ({ providers: [] }),
      write: async () => ({ providers: [] }),
      readTakeoverConfig: async () => ({
        providers: [
          {
            id: "p1",
            name: "Provider",
            apiUrl: "https://p1.test/v1/chat",
            apiKey: "secret",
            models: [{ id: "m1", enabled: true }],
          },
        ],
      }),
    } as unknown as UncensoredSettingsStorePort;
    const fetchMock = vi.fn(
      async (_url: string, _init: { headers: Record<string, string> }) => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "answer" } }] }),
      }),
    );
    const service = createUncensoredSettingsService({
      store,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await service.sendMessage(
      { workspacePath: "/workspace" },
      { providerId: "p1", modelId: "m1", text: "hello" },
    );

    expect(result).toEqual({ ok: true, text: "answer" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://p1.test/v1/chat",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer secret");
  });

  it("mirrors providers after a write and lazily on first read", async () => {
    const mirrorProviders = vi.fn(
      async (_providers: readonly ZCodeUncensoredProviderConfig[]) => {},
    );
    const store = {
      read: async () => ({ providers: [] }),
      write: async () => ({ providers: [] }),
      readTakeoverConfig: async () => ({
        providers: [
          {
            id: "p1",
            name: "Provider",
            apiUrl: "https://p1.test/v1/chat",
            apiKey: "secret",
            models: [{ id: "m1", enabled: true }],
          },
        ],
      }),
    } as unknown as UncensoredSettingsStorePort;
    const service = createUncensoredSettingsService({ store, mirrorProviders });

    await service.getConfig({ workspacePath: "/workspace" });
    await vi.waitFor(() => expect(mirrorProviders).toHaveBeenCalledTimes(1));
    await service.updateConfig({ workspacePath: "/workspace" }, { providers: [] });

    expect(mirrorProviders).toHaveBeenCalledTimes(2);
    expect(mirrorProviders.mock.calls[0]![0]).toHaveLength(1);
  });
});
