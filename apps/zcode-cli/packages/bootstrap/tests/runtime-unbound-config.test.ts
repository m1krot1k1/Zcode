import { describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  LocalAuthAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
} from "@zcode/provider";
import type { ModelSelection } from "@zcode/contracts";
import { resolveAppRuntimeConfig } from "../src/app/runtime-config.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

const identity = { providerId: "provider-a", modelId: "model-a" };
const complete = { ...identity, options: { reasoningLevel: "high" } };

function createRegistry() {
  return new ProviderRegistry([
    {
      providerId: identity.providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "openai-chat-completions",
        apiKey: "test",
        baseURL: "https://example.test",
        models: [identity.modelId],
      }),
      models: [
        {
          modelId: identity.modelId,
          config: new ModelConfig({
            enabled: true,
            visibility: "visible",

            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 200_000,
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
              supportsMidConversationSystem: true,
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                values: ["low", "high"],
                map: '{"reasoning_effort":reasoningLevel}',
              },
              maxOutputTokens: {
                max: 32_000,
                map: '{"max_tokens":maxOutputTokens}',
              },
            }),
          }),
        },
      ],
    },
  ]);
}

function createCursorRegistry() {
  return new ProviderRegistry([
    {
      providerId: "cursor",
      config: new ProviderConfig({
        group: "standard-personal",
        access: new LocalAuthAccessConfig(),
        api: new ProviderApiConfig({ type: "cursor-cli" }),
        enabled: true,
        id: "cursor",
        name: "Cursor CLI",
        visibility: "visible",
      }),
      models: [
        {
          modelId: "grok-4.7-fast",
          config: new ModelConfig({
            enabled: true,
            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 128_000,
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
            }),
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                values: ["low", "high", "xhigh"],
                map: "{}",
              },
              maxOutputTokens: { max: 32_000, map: "{}" },
            }),
          }),
        },
      ],
    },
  ]);
}

function resolve(resume: boolean, modelSelection?: ModelSelection, registry = createRegistry()) {
  return resolveAppRuntimeConfig({
    cliStorageRoot: "/test/cli",
    configResult: createConfig({ env: {}, skipUserConfig: true, workingDirectory: "/test" }),
    options: {
      resume,
      providerRegistry: registry,
      configuredDefaultModelSelection: complete,
      runtimeConfig: { modelSelection },
    },
    subagentOutputRootDir: "/test/agents",
    workingDirectory: "/test",
  }).runtimeConfig;
}

describe("Runtime 创建与未绑定恢复的边界", () => {
  it("新建会话没有 configured default 时使用正式初始推荐，历史恢复仍保持未绑定", () => {
    const config = resolveAppRuntimeConfig({
      cliStorageRoot: "/test/cli",
      configResult: createConfig({ env: {}, skipUserConfig: true, workingDirectory: "/test" }),
      options: { providerRegistry: createRegistry() },
      subagentOutputRootDir: "/test/agents",
      workingDirectory: "/test",
    });
    // Todo 58/88 的初始选择规则允许 Registry 推荐；下面的 resume 场景仍禁止默认值覆盖历史。
    expect(config.runtimeConfig.modelSelection).toEqual(complete);
  });
  it.each([
    undefined,
    identity,
    { ...identity, options: { reasoningLevel: "removed" } },
    { ...complete, providerId: "removed" },
    { ...complete, modelId: "removed" },
  ])("恢复不完整选择 %j 时不报错、不选择 configured default", (selection) => {
    expect(resolve(true, selection).modelSelection).toBeUndefined();
  });
  it("Registry 为空仍允许恢复历史", () => {
    expect(resolve(true, undefined, new ProviderRegistry([])).modelSelection).toBeUndefined();
  });
  it("完整选择恢复时原样保留", () => {
    expect(resolve(true, complete).modelSelection).toEqual(complete);
  });
  it("新建会话仍正常使用 configured default", () => {
    expect(resolve(false).modelSelection).toEqual(complete);
  });
  it("恢复旧 Cursor flat id 时迁移到分组模型和档位，而不是当成失效选择", () => {
    expect(
      resolve(
        true,
        {
          providerId: "cursor",
          modelId: "grok-4.7-xhigh-fast",
          options: { reasoningLevel: "disabled" },
        },
        createCursorRegistry(),
      ).modelSelection,
    ).toEqual({
      providerId: "cursor",
      modelId: "grok-4.7-fast",
      options: { reasoningLevel: "xhigh" },
    });
  });
  it("恢复已分组的 Cursor 选择时保留用户显式档位", () => {
    expect(
      resolve(
        true,
        {
          providerId: "cursor",
          modelId: "grok-4.7-fast",
          options: { reasoningLevel: "low" },
        },
        createCursorRegistry(),
      ).modelSelection,
    ).toEqual({
      providerId: "cursor",
      modelId: "grok-4.7-fast",
      options: { reasoningLevel: "low" },
    });
  });
});
