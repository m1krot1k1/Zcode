import { describe, expect, it, vi } from "vitest";

import {
  configureOpenAiCompatibleEmbeddings,
  indexAndSearch,
  inspectCodeGraph,
} from "./contract.example.js";
import { codeIntelligenceModule } from "./module.js";
import type { CodeIntelligenceService, CodeIndexStatus } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("code-intelligence contract", () => {
  it("declares its module manifest", () => {
    expect(codeIntelligenceModule.id).toBe("code-intelligence");
    expect(codeIntelligenceModule.requires).toContain("sqlite-migrations");
  });

  it("keeps the Host surface bounded and status paths relative", () => {
    const operations: Array<keyof CodeIntelligenceService> = [
      "getStatus",
      "watchWorkspace",
      "indexWorkspace",
      "search",
      "getSymbolContext",
      "getGraphOverview",
      "getImpact",
      "trace",
      "testEmbeddingConfig",
      "setEmbeddingConfig",
      "clearIndex",
    ];
    const status: CodeIndexStatus = {
      state: "unindexed",
      generation: 0,
      counts: { files: 0, chunks: 0, symbols: 0, edges: 0 },
      embedding: { configured: false, available: false, phase: "not-configured" },
      diagnostics: [],
    };
    expect(operations).toHaveLength(11);
    expect(status.counts.files).toBe(0);
  });

  it("demonstrates index-then-search using the Host contract", async () => {
    const service = {
      indexWorkspace: async () => undefined,
      search: async () => ({ results: [], semantic: false, partial: false }),
    } as unknown as CodeIntelligenceService;

    await expect(indexAndSearch(service, "/workspace")).resolves.toEqual([]);
  });

  it("reads the bounded code graph through the Host contract", async () => {
    const graph = { nodes: [], edges: [], partial: false };
    const getGraphOverview = vi.fn(async () => graph);
    const service = { getGraphOverview } as unknown as CodeIntelligenceService;

    await expect(
      inspectCodeGraph(service, "/workspace", {
        path: "src/index.ts",
        startLine: 8,
      }),
    ).resolves.toBe(graph);
    expect(getGraphOverview).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      focus: { path: "src/index.ts", startLine: 8 },
      limit: 60,
    });
  });

  it("configures an OpenAI-compatible endpoint without putting a key in the example", async () => {
    const setEmbeddingConfig = vi.fn(async () => ({
      state: "unindexed" as const,
      generation: 0,
      counts: { files: 0, chunks: 0, symbols: 0, edges: 0 },
      embedding: {
        configured: true,
        provider: "openai-compatible" as const,
        endpoint: "https://example.test/v1/embeddings",
        model: "example/embed-small",
        apiKeyConfigured: false,
        available: false,
        phase: "pending" as const,
      },
      diagnostics: [],
    }));
    const service = {
      setEmbeddingConfig,
    } as unknown as CodeIntelligenceService;

    await configureOpenAiCompatibleEmbeddings(
      service,
      "/workspace",
      "https://example.test/v1/embeddings",
      "example/embed-small",
    );

    expect(setEmbeddingConfig).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      provider: "openai-compatible",
      endpoint: "https://example.test/v1/embeddings",
      model: "example/embed-small",
    });
  });
});
