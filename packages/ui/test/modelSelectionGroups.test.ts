import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { buildRegistryModelSelectGroups, formatContextWindowLabel } from "../src/lib/modelSelectionGroups.js";

describe("model selection groups", () => {
  it.each([
    [{ type: "zhipu-account", accountType: "zai", mode: "individual-coding-plan" }, false],
    [{ type: "zhipu-account", accountType: "bigmodel", mode: "team-coding-plan" }, false],
    [{ type: "zhipu-coding-plan-api-key" }, false],
    [{ type: "zhipu-account", accountType: "zai", mode: "start-plan" }, false],
    [{ type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" }, false],
    [{ type: "zhipu-account", accountType: "bigmodel", mode: "off-peak" }, true],
    [{ type: "api-key" }, true],
  ])("仅套餐 GLM-5.3 隐藏视觉标，不影响 Flash/真实能力：%j", (access, expected) => {
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "fixture",
          config: {
            logo: { type: "builtin", key: "deepseek" },
            access: access as ModelSelectionView["providers"][number]["config"]["access"],
            api: { type: "anthropic-messages" },
          },
          models: ["GLM-5.3", "GLM-5.3-Flash", "GLM-4.7"].map((modelId) => ({
            modelId,
            config: { properties: { inputFormat: { supportsImage: true } } },
          })),
        },
      ],
    };
    const items = buildRegistryModelSelectGroups("glm", view)[0]!.items;
    expect(buildRegistryModelSelectGroups("glm", view)[0]!.logo).toEqual({
      type: "builtin",
      key: "deepseek",
    });
    expect(items[0]!.supportsVisionInput === true).toBe(expected);
    expect(items[1]!.supportsVisionInput).toBe(true);
    expect(items[2]!.supportsVisionInput).toBe(true);
    expect(view.providers[0]!.models[0]!.config.properties?.inputFormat?.supportsImage).toBe(true);
  });
  it("保留带前缀和多段斜杠的精确模型 ID；不从名称推断视觉能力", () => {
    const modelId = "upstream/family/vision-preview";
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "aggregator",
          config: { api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" } },
          models: [{ modelId, config: { properties: { inputFormat: { supportsImage: true } } } }],
        },
      ],
    };
    expect(buildRegistryModelSelectGroups("glm", view)[0]?.items).toEqual([
      {
        key: `registry-provider:aggregator:${modelId}`,
        value: "custom:aggregator:upstream%2Ffamily%2Fvision-preview",
        name: modelId,
        supportsVisionInput: true,
      },
    ]);
    view.providers[0]!.models[0]!.config = {};
    expect(buildRegistryModelSelectGroups("glm", view)[0]?.items[0]).not.toHaveProperty(
      "supportsVisionInput",
    );
  });
  it("直接把 Registry API Provider 投影为有序模型组", () => {
    const selectionView: ModelSelectionView = {
      revision: 7,
      providers: [
        {
          providerId: "anthropic-api",
          providerName: "Anthropic API",
          config: {
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com/anthropic",
            },
            models: ["claude-a", "claude-b"],
          },
          models: [
            {
              modelId: "claude-a",
              config: { properties: { inputFormat: { supportsImage: true } } },
            },
            { modelId: "claude-b", config: {} },
          ],
        },
        {
          providerId: "openai-api",
          providerName: "OpenAI API",
          config: {
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "openai-responses",
              baseUrl: "https://example.com/openai",
            },
            models: ["model-a"],
          },
          models: [{ modelId: "model-a", config: {} }],
        },
      ],
    };

    expect(buildRegistryModelSelectGroups("glm", selectionView)).toEqual([
      {
        key: "registry-provider:anthropic-api",
        label: "Anthropic API",
        labelBadge: "API",
        items: [
          {
            key: "registry-provider:anthropic-api:claude-a",
            value: "custom:anthropic-api:claude-a",
            name: "claude-a",
            supportsVisionInput: true,
          },
          {
            key: "registry-provider:anthropic-api:claude-b",
            value: "custom:anthropic-api:claude-b",
            name: "claude-b",
          },
        ],
      },
      {
        key: "registry-provider:openai-api",
        label: "OpenAI API",
        labelBadge: "API",
        items: [
          {
            key: "registry-provider:openai-api:model-a",
            value: "custom:openai-api:model-a",
            name: "model-a",
          },
        ],
      },
    ]);
  });

  it("把 OpenCode CLI 的原始 provider/model ID 加入普通 Composer 模型列表", () => {
    const modelId = "deepseek/deepseek-v4.1-flash-free";
    const selectionView: ModelSelectionView = {
      revision: 10,
      providers: [
        {
          providerId: "opencode",
          providerName: "OpenCode CLI",
          config: {
            access: { type: "local-auth" },
            api: { type: "opencode-sdk" },
          },
          models: [{ modelId, config: {} }],
        },
      ],
    };

    expect(buildRegistryModelSelectGroups("glm", selectionView)).toEqual([
      {
        key: "registry-provider:opencode",
        label: "OpenCode CLI",
        labelBadge: "CLI",
        items: [
          {
            key: `registry-provider:opencode:${modelId}`,
            value: `custom:opencode:${encodeURIComponent(modelId)}`,
            name: modelId,
          },
        ],
      },
    ]);
  });

  it("直接把 Registry Account Provider 投影为已选连接，不重新裁决 Family", () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
    const selectionView: ModelSelectionView = {
      revision: 8,
      providers: [
        {
          providerId,
          providerName: "BigModel Coding Plan",
          config: {
            access: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "team-coding-plan",
              entitled: true,
            },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com/anthropic",
            },
            models: ["GLM-5.2"],
          },
          models: [{ modelId: "GLM-5.2", config: {} }],
        },
      ],
    };

    expect(buildRegistryModelSelectGroups("glm", selectionView)).toEqual([
      {
        key: `registry-provider:${providerId}`,
        label: "BigModel",
        labelBadge: "Team",
        directItems: true,
        items: [
          {
            key: `registry-provider:${providerId}:GLM-5.2`,
            value: "custom:account%3Abigmodel-team-coding-plan:GLM-5.2",
            name: "GLM-5.2",
          },
        ],
      },
    ]);
  });
});

describe("formatContextWindowLabel", () => {
  it.each([
    [1_000_000, "1M"],
    [1_048_576, "1M"],
    [200_000, "200K"],
    [128_000, "128K"],
    [undefined, ""],
    [0, ""],
  ])("把 %s 格式化为 %j", (contextWindow, expected) => {
    expect(formatContextWindowLabel(contextWindow)).toBe(expected);
  });
});

describe("registry 模型上下文徽标", () => {
  it("有 contextWindow 的模型带 badgeLabel，缺失时不渲染徽标", () => {
    const view: ModelSelectionView = {
      revision: 3,
      providers: [
        {
          providerId: "fixture",
          config: { access: { type: "api-key", apiKey: "sk-test" }, api: { type: "anthropic-messages" } },
          models: [
            { modelId: "with-context", config: { properties: { contextWindow: 128_000 } } },
            { modelId: "without-context", config: {} },
          ],
        },
      ],
    };

    const items = buildRegistryModelSelectGroups("glm", view)[0]!.items;
    expect(items[0]!.badgeLabel).toBe("128K");
    expect(items[1]!.badgeLabel).toBeUndefined();
  });
});
