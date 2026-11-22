// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { isApiKeyAccess } from "@zcode/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";

const mocks = vi.hoisted(() => {
  const apiKey = "sk-old-key";
  const view = {
    revision: 1,
    addableProviders: [],
    providerOrder: ["provider-1"],
    providers: [
      {
        providerId: "provider-1",
        providerName: "Provider 1",
        enabled: true,
        executable: true,
        personalConfig: { access: { type: "api-key", apiKey } },
        effectiveConfig: {
          label: "Provider 1",
          group: "standard-personal",
          access: { type: "api-key", apiKey },
          api: { type: "openai-chat-completions", baseUrl: "https://old.example.com/v1" },
          personalModelIds: [],
        },
        issues: [],
        models: [],
      },
    ],
  };
  return {
    view,
    savePersonalProviderOverlay: vi.fn(async () => view),
    importDiscoveredModels: vi.fn(async () => 2),
    commit: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    providerSettingsService: {
      savePersonalProviderOverlay: mocks.savePersonalProviderOverlay,
      importDiscoveredModels: mocks.importDiscoveredModels,
    },
  }),
}));

vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsServiceView: () => ({
    state: { status: "ready", view: mocks.view },
    reload: vi.fn(),
    commit: mocks.commit,
  }),
}));

vi.mock("@/logger.js", () => ({ logger: mocks.logger }));

function withApiKey(
  provider: ProviderSettingsFormProvider,
  apiKey: string,
): ProviderSettingsFormProvider {
  const access = provider.config.access;
  if (!isApiKeyAccess(access)) throw new Error("fixture 必须是 api-key 访问");
  return { ...provider, config: { ...provider.config, access: { ...access, apiKey } } };
}

async function renderProviders() {
  const hook = renderHook(() => useModelProviders({ workspacePath: "/workspace" }));
  await waitFor(() => expect(hook.result.current.modelProviders).toHaveLength(1));
  return hook;
}

describe("useModelProviders 自动发现触发", () => {
  beforeEach(() => {
    mocks.savePersonalProviderOverlay.mockClear();
    mocks.importDiscoveredModels.mockClear();
    mocks.commit.mockClear();
    mocks.logger.warn.mockClear();
  });

  it("Key 变更保存后触发一次模型导入", async () => {
    const hook = await renderProviders();
    const base = hook.result.current.modelProviders[0]!;

    await act(async () => {
      await hook.result.current.saveProvider(withApiKey(base, "sk-new-key"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.importDiscoveredModels).toHaveBeenCalledTimes(1);
    expect(mocks.importDiscoveredModels).toHaveBeenCalledWith("provider-1");
  });

  it("Base URL 变更保存后同样触发模型导入", async () => {
    const hook = await renderProviders();
    const base = hook.result.current.modelProviders[0]!;
    const next: ProviderSettingsFormProvider = {
      ...base,
      config: {
        ...base.config,
        api: { ...base.config.api, baseUrl: "https://new.example.com/v1" },
      },
    };

    await act(async () => {
      await hook.result.current.saveProvider(next);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.importDiscoveredModels).toHaveBeenCalledWith("provider-1");
  });

  it("Key 与 Base URL 未变化时保存不触发导入", async () => {
    const hook = await renderProviders();
    const base = hook.result.current.modelProviders[0]!;

    await act(async () => {
      await hook.result.current.saveProvider({ ...base, providerNameUpdate: "Renamed" });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.importDiscoveredModels).not.toHaveBeenCalled();
  });

  it("导入失败只记录 warn，保存仍然成功", async () => {
    mocks.importDiscoveredModels.mockRejectedValueOnce(new Error("network down"));
    const hook = await renderProviders();
    const base = hook.result.current.modelProviders[0]!;

    await act(async () => {
      await expect(
        hook.result.current.saveProvider(withApiKey(base, "sk-new-key")),
      ).resolves.toBeDefined();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
