import type { ProviderSettingsFacade } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { createProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";

interface FacadeFixtureInput {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly models?: readonly string[];
  readonly failFor?: string;
}

function createFacadeFixture(input: FacadeFixtureInput = {}) {
  const models = [...(input.models ?? [])];
  const added: Array<{ providerId: string; modelId: string; config: unknown }> = [];
  const view = () => ({
    revision: 1,
    providers: [
      {
        providerId: "p",
        providerName: "Provider P",
        enabled: true,
        executable: true,
        issues: [],
        effectiveConfig: {
          api: input.baseUrl
            ? { type: "openai-chat-completions", baseUrl: input.baseUrl }
            : { type: "opencode-sdk" },
          access: input.apiKey ? { type: "api-key", apiKey: input.apiKey } : { type: "oauth" },
        },
        models: models.map((modelId) => ({ modelId, enabled: true, executable: true, issues: [] })),
      },
    ],
  });
  const addPersonalModel = vi.fn(async (providerId: string, modelId: string, config: unknown) => {
    if (input.failFor === modelId) throw new Error(`cannot add ${modelId}`);
    models.push(modelId);
    added.push({ providerId, modelId, config });
    return view();
  });
  return {
    facade: {
      onDidChange: vi.fn(),
      getView: vi.fn(view),
      addPersonalModel,
    } as unknown as ProviderSettingsFacade,
    added,
    addPersonalModel,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createService(fixture: ReturnType<typeof createFacadeFixture>, fetchImpl: typeof fetch) {
  return createProviderSettingsService(fixture.facade, undefined, undefined, { fetchImpl });
}

describe("Provider 模型自动发现", () => {
  it("把 /models 全字段响应归一化，并在有 Key 时带 Bearer", async () => {
    const fixture = createFacadeFixture({
      baseUrl: "https://api.example.com/v1/",
      apiKey: "sk-fixture",
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "alpha",
            name: "Alpha",
            limit: { context: 1_000_000, output: 32_000 },
            capabilities: { reasoning: { supported: true, effort: ["low", "medium", "high"] } },
          },
        ],
      }),
    );
    const service = createService(fixture, fetchImpl as unknown as typeof fetch);

    const models = await service.discoverProviderModels("p");

    expect(models).toEqual([
      {
        id: "alpha",
        displayName: "Alpha",
        contextWindow: 1_000_000,
        maxOutput: 32_000,
        reasoningEffort: ["low", "medium", "high"],
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer sk-fixture" },
      }),
    );
  });

  it("缺少 limit 或 capabilities 时仍返回模型，未知字段不写入", async () => {
    const fixture = createFacadeFixture({ baseUrl: "https://api.example.com/v1" });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: [{ id: "beta" }] }),
    );
    const service = createService(fixture, fetchImpl as unknown as typeof fetch);

    const models = await service.discoverProviderModels("p");

    expect(models).toEqual([{ id: "beta", displayName: "beta" }]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: {} });
  });

  it("上游返回非 2xx 时得到空数组且不抛异常", async () => {
    const fixture = createFacadeFixture({ baseUrl: "https://api.example.com/v1" });
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    const service = createService(fixture, fetchImpl as unknown as typeof fetch);

    await expect(service.discoverProviderModels("p")).resolves.toEqual([]);
  });

  it("网络失败或响应结构非法时得到空数组且不抛异常", async () => {
    const fixture = createFacadeFixture({ baseUrl: "https://api.example.com/v1" });
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      createService(fixture, failing as unknown as typeof fetch).discoverProviderModels("p"),
    ).resolves.toEqual([]);

    const malformed = vi.fn(async () => jsonResponse({ data: "not-an-array" }));
    await expect(
      createService(fixture, malformed as unknown as typeof fetch).discoverProviderModels("p"),
    ).resolves.toEqual([]);
  });

  it("导入跳过已存在的 modelId，重复导入不重复写入", async () => {
    const fixture = createFacadeFixture({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-fixture",
      models: ["existing"],
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: "existing" }, { id: "fresh", limit: { context: 128_000 } }] }),
    );
    const service = createService(fixture, fetchImpl as unknown as typeof fetch);

    await expect(service.importDiscoveredModels("p")).resolves.toBe(1);
    expect(fixture.added).toEqual([
      { providerId: "p", modelId: "fresh", config: { properties: { contextWindow: 128_000 } } },
    ]);

    await expect(service.importDiscoveredModels("p")).resolves.toBe(0);
    expect(fixture.added).toHaveLength(1);
  });

  it("导入写入上下文与推理档位，单个模型失败不影响其他模型", async () => {
    const fixture = createFacadeFixture({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-fixture",
      failFor: "broken",
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "broken",
            name: "Broken",
            capabilities: { reasoning: { supported: false, effort: ["low"] } },
          },
          {
            id: "gamma",
            name: "Gamma",
            limit: { context: 200_000, output: 64_000 },
            capabilities: { reasoning: { supported: true, effort: ["low", "high"] } },
          },
        ],
      }),
    );
    const service = createService(fixture, fetchImpl as unknown as typeof fetch);

    await expect(service.importDiscoveredModels("p")).resolves.toBe(1);
    expect(fixture.added).toEqual([
      {
        providerId: "p",
        modelId: "gamma",
        config: {
          properties: { contextWindow: 200_000 },
          optionSpecs: {
            reasoningLevel: { values: ["low", "high"] },
            maxOutputTokens: { max: 64_000 },
          },
        },
      },
    ]);
  });
});
