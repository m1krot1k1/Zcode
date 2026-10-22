import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

function createCustomProvider(): ProviderSettingsFormProvider {
  return {
    providerId: "custom-provider",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    personalConfig: { group: "standard-personal", personalModelIds: ["glm-5"] },
    config: {
      label: "Custom Provider",
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-demo" },
      api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
      personalModelIds: ["glm-5"],
    },
    models: [{ modelId: "glm-5", config: {}, hasPersonalConfig: true }],
  };
}

function createIntl(messages: Record<string, string>) {
  return {
    formatMessage: ({ id }: { id: string }) => messages[id] ?? id,
  };
}

describe("model provider navigation i18n", () => {
  afterEach(() => {
    vi.doUnmock("react");
    vi.resetModules();
  });

  it("语言切换时刷新自定义供应商分组标题，添加入口不再混入导航", async () => {
    type MemoState = {
      deps: readonly unknown[] | undefined;
      value: unknown;
    };
    const memoStates: MemoState[] = [];
    let hookIndex = 0;
    const renderStart = () => {
      hookIndex = 0;
    };

    vi.resetModules();
    vi.doMock("react", async (importOriginal) => {
      const actual = await importOriginal<typeof import("react")>();
      return {
        ...actual,
        useEffect: vi.fn(),
        useMemo: vi.fn((factory: () => unknown, deps?: readonly unknown[]) => {
          const index = hookIndex;
          hookIndex += 1;
          const previous = memoStates[index];
          const unchanged =
            previous?.deps &&
            deps &&
            previous.deps.length === deps.length &&
            previous.deps.every((dependency, dependencyIndex) =>
              Object.is(dependency, deps[dependencyIndex]),
            );
          if (unchanged) {
            return previous.value;
          }
          const value = factory();
          memoStates[index] = { deps, value };
          return value;
        }),
      };
    });

    const { useModelProviderNavigation } =
      await import("@/settings/model-provider-section/useModelProviderNavigation.js");
    const provider = createCustomProvider();
    const codingPlanEntitlements = {};
    const commonOptions = {
      presetProviders: [],
      modelProviders: [provider],
      codingPlanEntitlements,
      selectedNodeKey: null,
      setSelectedNodeKey: vi.fn(),
    };

    renderStart();
    const zhResult = useModelProviderNavigation({
      ...commonOptions,
      intl: createIntl({
        "settings.modelProvider.customTitle": "Composer 自定义 API 供应商",
        "settings.modelProvider.agentIntegrationsTitle": "独立智能体运行时",
        "settings.modelProvider.openCodeCli": "OpenCode CLI",
        "settings.modelProvider.createCustomProvider": "创建自定义供应商",
      }),
    });

    renderStart();
    const enResult = useModelProviderNavigation({
      ...commonOptions,
      intl: createIntl({
        "settings.modelProvider.customTitle": "Custom API providers for Composer",
        "settings.modelProvider.agentIntegrationsTitle": "Separate agent runtimes",
        "settings.modelProvider.openCodeCli": "OpenCode CLI",
        "settings.modelProvider.createCustomProvider": "Create Custom Provider",
      }),
    });

    expect(zhResult.navigationGroups.find((group) => group.id === "custom")?.title).toBe(
      "Composer 自定义 API 供应商",
    );
    const enCustomGroup = enResult.navigationGroups.find((group) => group.id === "custom");
    expect(enCustomGroup?.title).toBe("Custom API providers for Composer");
    expect(enCustomGroup?.items).toHaveLength(1);
    expect(enCustomGroup?.items[0]?.type).toBe("custom");
    expect(
      enResult.navigationGroups.find((group) => group.id === "agent-integrations"),
    ).toMatchObject({
      title: "Separate agent runtimes",
      items: [{ type: "agentIntegration", integrationId: "opencode-cli" }],
    });
    expect(
      enResult.navigationGroups.find((group) => group.id === "agent-integrations")?.items[0]?.label,
    ).toBe("OpenCode CLI");
  });
});
