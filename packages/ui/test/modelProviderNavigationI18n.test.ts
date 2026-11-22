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
    const emptyLegacyOpenCodeProvider: ProviderSettingsFormProvider = {
      ...provider,
      providerId: "opencode-go-chat",
      templateId: "opencode-go-chat",
      providerName: "OpenCode Go (Chat)",
      models: [],
    };
    const configuredLegacyOpenCodeProvider: ProviderSettingsFormProvider = {
      ...provider,
      providerId: "opencode-go-responses",
      templateId: "opencode-go-responses",
      providerName: "OpenCode Go (Responses)",
      models: [
        {
          modelId: "legacy-model",
          config: {},
          hasPersonalConfig: true,
        },
      ],
    };
    const codingPlanEntitlements = {};
    const commonOptions = {
      presetProviders: [],
      modelProviders: [provider, emptyLegacyOpenCodeProvider, configuredLegacyOpenCodeProvider],
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
        "settings.modelProvider.openCodeCli": "OpenCode CLI · 无需 API Key",
        "settings.modelProvider.cursorCli": "Cursor CLI · 无需 API Key",
        "settings.modelProvider.legacyOpenCodeTitle": "旧版 OpenCode API 配置",
        "settings.modelProvider.createCustomProvider": "创建自定义供应商",
      }),
    });

    renderStart();
    const enResult = useModelProviderNavigation({
      ...commonOptions,
      intl: createIntl({
        "settings.modelProvider.customTitle": "Custom API providers for Composer",
        "settings.modelProvider.agentIntegrationsTitle": "Separate agent runtimes",
        "settings.modelProvider.openCodeCli": "OpenCode CLI · no API key",
        "settings.modelProvider.cursorCli": "Cursor CLI · no API key",
        "settings.modelProvider.legacyOpenCodeTitle": "Older OpenCode API configurations",
        "settings.modelProvider.createCustomProvider": "Create Custom Provider",
      }),
    });

    renderStart();
    const embeddingsResult = useModelProviderNavigation({
      ...commonOptions,
      codeIntelligenceAvailable: true,
      selectedNodeKey: "workspace-intelligence:embeddings",
      intl: createIntl({
        "settings.modelProvider.customTitle": "Custom API providers for Composer",
        "settings.modelProvider.agentIntegrationsTitle": "Local CLI providers",
        "settings.modelProvider.workspaceIntelligenceTitle": "Workspace intelligence",
        "settings.modelProvider.openCodeCli": "OpenCode CLI · no API key",
        "settings.modelProvider.cursorCli": "Cursor CLI · no API key",
        "settings.embedding.navigationLabel": "Embeddings",
      }),
    });

    expect(zhResult.navigationGroups.find((group) => group.id === "custom")?.title).toBe(
      "Composer 自定义 API 供应商",
    );
    const enCustomGroup = enResult.navigationGroups.find((group) => group.id === "custom");
    expect(enCustomGroup?.title).toBe("Custom API providers for Composer");
    expect(enCustomGroup?.items.map((item) => item.key)).toEqual(["custom:custom-provider"]);
    const legacyOpenCodeGroup = enResult.navigationGroups.find(
      (group) => group.id === "legacy-opencode",
    );
    expect(legacyOpenCodeGroup?.title).toBe("Older OpenCode API configurations");
    expect(legacyOpenCodeGroup?.items.map((item) => item.key)).toEqual([
      "custom:opencode-go-chat",
      "custom:opencode-go-responses",
    ]);
    expect(
      enResult.navigationGroups.find((group) => group.id === "agent-integrations"),
    ).toMatchObject({
      title: "Separate agent runtimes",
      items: [
        { type: "agentIntegration", integrationId: "opencode-cli" },
        { type: "agentIntegration", integrationId: "cursor-cli" },
      ],
    });
    const agentItems = enResult.navigationGroups.find(
      (group) => group.id === "agent-integrations",
    )?.items;
    expect(agentItems?.[0]?.label).toBe("OpenCode CLI · no API key");
    expect(agentItems?.[1]?.label).toBe("Cursor CLI · no API key");
    expect(
      embeddingsResult.navigationGroups.find((group) => group.id === "workspace-intelligence"),
    ).toMatchObject({
      title: "Workspace intelligence",
      items: [
        {
          key: "workspace-intelligence:embeddings",
          type: "codeIntelligence",
          label: "Embeddings",
        },
      ],
    });
    expect(embeddingsResult.selectedNavItem).toMatchObject({ type: "codeIntelligence" });
  });
});
