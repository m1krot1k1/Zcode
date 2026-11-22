// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodeIndexStatus, CodeIntelligenceService, CodeWorkspaceRef } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { EmbeddingProviderSettings } from "@/agent-workbench/EmbeddingProviderSettings.js";

const workspaceRef: CodeWorkspaceRef = {
  workspacePath: "/workspace/demo",
  workspaceIdentity: "workspace-demo",
};

function status(apiKeyConfigured: boolean): CodeIndexStatus {
  return {
    state: "ready",
    generation: 1,
    counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
    embedding: {
      configured: true,
      provider: "openai-compatible",
      endpoint: "https://embeddings.example/v1/embeddings",
      model: "example/embed-model",
      apiKeyConfigured,
      available: false,
      phase: "pending",
    },
    diagnostics: [],
  };
}

describe("Embedding provider settings", () => {
  it("keeps a tested draft token until save and then tests with the saved credential", async () => {
    let savedToken = false;
    const getStatus = vi.fn(async () => status(savedToken));
    const testEmbeddingConfig = vi.fn(async (params: { apiKey?: string }) => ({
      ok: savedToken || params.apiKey === "test-only-token",
      dimensions: 1024,
      elapsedMs: 12,
    }));
    const setEmbeddingConfig = vi.fn(async (params: { apiKey?: string | null }) => {
      if (typeof params.apiKey === "string") savedToken = true;
      return status(savedToken);
    });
    const codeIndex = {
      getStatus,
      testEmbeddingConfig,
      setEmbeddingConfig,
    } as unknown as CodeIntelligenceService;

    render(
      <ZCodeIntlProvider initialLocale="en-US">
        <EmbeddingProviderSettings codeIndex={codeIndex} workspaceRef={workspaceRef} />
      </ZCodeIntlProvider>,
    );

    const tokenInput = await screen.findByTestId("agent-workbench-embedding-api-key");
    fireEvent.change(tokenInput, { target: { value: "test-only-token" } });

    fireEvent.click(screen.getByTestId("agent-workbench-test-embedding"));
    expect(await screen.findByText("Connected · 1024 dimensions in 12 ms")).toBeTruthy();
    expect((tokenInput as HTMLInputElement).value).toBe("test-only-token");

    fireEvent.click(screen.getByTestId("agent-workbench-save-embedding"));
    expect(await screen.findByText("Embedding settings saved.")).toBeTruthy();
    expect(setEmbeddingConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ...workspaceRef, apiKey: "test-only-token" }),
    );
    expect((tokenInput as HTMLInputElement).value).toBe("");
    expect(tokenInput.getAttribute("placeholder")).toBe("Saved · leave blank to keep");

    fireEvent.click(screen.getByTestId("agent-workbench-test-embedding"));
    expect(await screen.findByText("Connected · 1024 dimensions in 12 ms")).toBeTruthy();
    expect(testEmbeddingConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ...workspaceRef,
        provider: "openai-compatible",
        endpoint: "https://embeddings.example/v1/embeddings",
        model: "example/embed-model",
      }),
    );
    expect(testEmbeddingConfig.mock.calls[1]?.[0]).not.toHaveProperty("apiKey");
  });
});
