import { describe, expect, it } from "vitest";
import {
  normalizeModelSelection,
  completeNewModelSelection,
  resolveInitialModelSelection,
  type ProviderRegistryView,
} from "../src/index.js";
import { resolveEffectiveModelSelection } from "../src/effective-model-selection.js";
import { ModelConfig, ModelOptionSpecsConfig, ModelPropertiesConfig } from "../src/config/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

describe("resolveInitialModelSelection", () => {
  const registry = registryView();

  it("只接受带合法 reasoning 的持久化 configured default", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      },
      source: "configured-default",
    });
  });

  it("新草稿的 configured default 不可用时使用 Registry 推荐，不写回偏好", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: { providerId: "removed", modelId: "removed" },
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("全新选择没有 configured default 时按可见 Provider 顺序初始化最高档", () => {
    expect(
      resolveInitialModelSelection({
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("失效默认档位使整个默认偏好失效；新草稿重新取 Registry 推荐", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "removed" },
        },
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("reports an empty registry without inventing a model", () => {
    expect(
      resolveInitialModelSelection({
        registry: { revision: 0, providers: [] },
      }),
    ).toEqual({ source: "none" });
  });

  it("never selects an embedding-only model as preferred chat selection", () => {
    const embeddingFirstRegistry = {
      revision: 2,
      providers: [
        {
          providerId: "provider-embed",
          config: createApiKeyProviderConfig({
            apiFormat: "openai-chat-completions",
            apiKey: "ollama",
            baseURL: "http://127.0.0.1:11434/v1",
            models: ["bge-m3"],
          }),
          models: [
            {
              modelId: "bge-m3",
              config: new ModelConfig({
                properties: new ModelPropertiesConfig({
                  requiresMfjsToolSchema: false,
                  contextWindow: 8_192,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: false,
                  supportsJsonSchemaOutput: false,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                }),
                optionSpecs: new ModelOptionSpecsConfig({
                  reasoningLevel: { values: ["disabled"], map: "{}" },
                  maxOutputTokens: { max: 8_000, map: "{}" },
                }),
              }),
            },
          ],
        },
        ...registry.providers,
      ],
    } as ProviderRegistryView;

    expect(resolveInitialModelSelection({ registry: embeddingFirstRegistry })).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-embed",
          modelId: "bge-m3",
          options: { reasoningLevel: "disabled" },
        },
        registry: embeddingFirstRegistry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });
});

describe("normalizeModelSelection", () => {
  it("migrates legacy flat Cursor reasoning ids to the grouped model + level", () => {
    const registry = cursorRegistryView();
    expect(
      normalizeModelSelection(registry, {
        providerId: "cursor",
        modelId: "grok-4.7-xhigh-fast",
        options: { reasoningLevel: "disabled" },
      }),
    ).toEqual({
      providerId: "cursor",
      modelId: "grok-4.7-fast",
      options: { reasoningLevel: "xhigh" },
    });
    expect(
      normalizeModelSelection(registry, {
        providerId: "cursor",
        modelId: "claude-haiku-5-5-low-no-thinking",
      }),
    ).toEqual({
      providerId: "cursor",
      modelId: "claude-haiku-5-5-no-thinking",
      options: { reasoningLevel: "low" },
    });
    expect(
      normalizeModelSelection(registry, {
        providerId: "cursor",
        modelId: "gpt-5.3-codex-high-fast",
      }),
    ).toEqual({
      providerId: "cursor",
      modelId: "gpt-5.3-codex-fast",
      options: { reasoningLevel: "high" },
    });
  });

  it("keeps an explicit level when the persisted id is already the grouped selector", () => {
    const registry = cursorRegistryView();
    // `-fast` / `-no-thinking` 是 grouped selector 的后缀，不是旧 reasoning id；
    // 再迁移一次会把用户显式选择的 low 覆盖成最高档。
    expect(
      normalizeModelSelection(registry, {
        providerId: "cursor",
        modelId: "grok-4.7-fast",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({
      providerId: "cursor",
      modelId: "grok-4.7-fast",
      options: { reasoningLevel: "low" },
    });
    expect(
      normalizeModelSelection(registry, {
        providerId: "cursor",
        modelId: "claude-haiku-5-5-no-thinking",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({
      providerId: "cursor",
      modelId: "claude-haiku-5-5-no-thinking",
      options: { reasoningLevel: "low" },
    });
    expect(
      normalizeModelSelection(registry, {
        providerId: "cursor",
        modelId: "gpt-5.3-codex-fast",
        options: { reasoningLevel: "high" },
      }),
    ).toEqual({
      providerId: "cursor",
      modelId: "gpt-5.3-codex-fast",
      options: { reasoningLevel: "high" },
    });
  });

  it("migrates a legacy flat Cursor id in the configured default", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "cursor",
          modelId: "gpt-5.3-codex-high",
          options: { reasoningLevel: "disabled" },
        },
        registry: cursorRegistryView(),
      }),
    ).toEqual({
      source: "configured-default",
      selection: {
        providerId: "cursor",
        modelId: "gpt-5.3-codex",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("主动选择目标模型取其最高档，不继承来源模型的档位", () => {
    expect(
      completeNewModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
  });
  it("新选择缺少 reasoning 时保留模型并清空 reasoning", () => {
    expect(
      normalizeModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("显式但失效的 reasoning 也清空，不偷偷替换档位", () => {
    expect(
      normalizeModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "removed" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });
});

describe("resolveEffectiveModelSelection", () => {
  it("мигрирует legacy Cursor flat id до построения composer view", () => {
    expect(
      resolveEffectiveModelSelection({
        selection: {
          providerId: "cursor",
          modelId: "grok-4.7-xhigh-fast",
          options: { reasoningLevel: "disabled" },
        },
        registry: cursorRegistryView(),
        classifyProvider: () => "ordinary",
      }),
    ).toEqual({
      effectiveSelection: {
        providerId: "cursor",
        modelId: "grok-4.7-fast",
        options: { reasoningLevel: "xhigh" },
      },
    });
  });
});

function cursorRegistryView(): ProviderRegistryView {
  const model = (modelId: string, values: readonly string[]) => ({
    modelId,
    config: new ModelConfig({
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: { values, map: "{}" },
        maxOutputTokens: { max: 8_000, map: "{}" },
      }),
    }),
  });
  return {
    revision: 1,
    providers: [
      {
        providerId: "cursor",
        config: { visibility: "visible" },
        models: [
          model("grok-4.7-fast", ["default", "low", "high", "xhigh"]),
          model("gpt-5.3-codex", ["default", "low", "high"]),
          model("gpt-5.3-codex-fast", ["default", "low", "high"]),
          model("claude-haiku-5-5-no-thinking", ["low", "high"]),
        ],
      },
    ],
  } as unknown as ProviderRegistryView;
}

function registryView(): ProviderRegistryView {
  return {
    revision: 1,
    providers: ["provider-a", "provider-b"].map((providerId) => ({
      providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        apiKey: "test-key",
        baseURL: "https://example.com",
        models: [`model-${providerId.at(-1)}`],
      }),
      models: [
        {
          modelId: `model-${providerId.at(-1)}`,
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 100_000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsVideo: false,
                supportsAudio: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: false,
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                values: ["low", "high"],
                map: "{'reasoning': {'effort': reasoningLevel}}",
              },
              maxOutputTokens: {
                max: 8_000,
                map: "{'max_tokens': maxOutputTokens}",
              },
            }),
          }),
        },
      ],
    })),
  };
}
