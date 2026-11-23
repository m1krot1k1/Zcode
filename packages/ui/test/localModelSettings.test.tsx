// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIntelligenceService, CodeWorkspaceRef } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { LocalModelSettings } from "@/agent-workbench/LocalModelSettings.js";

afterEach(cleanup);

const workspaceRef: CodeWorkspaceRef = {
  workspacePath: "/workspace/demo",
  workspaceIdentity: "workspace-demo",
};

describe("Local model settings", () => {
  it("installs Ollama, downloads the RAM recommendation, and registers the provider", async () => {
    let installed = false;
    const getStatus = vi.fn(async () => ({
      runtime: "ollama" as const,
      installed,
      running: installed,
      totalMemoryBytes: 32 * 1024 ** 3,
      models: [],
      recommended: {
        model: "nomic-embed-text",
        dimensions: 768,
        downloadBytes: 274_000_000,
        reason: "embedding fixture",
      },
    }));
    const install = vi.fn(async () => {
      installed = true;
      return { status: "installed" as const, version: "0.40.17" };
    });
    const pull = vi.fn(async (model: string) => ({ status: "installed" as const, model }));
    const codeIndex = {
      localEmbeddings: { getStatus, install, pull },
    } as unknown as CodeIntelligenceService;
    const createPersonalProvider = vi.fn(async () => ({ providerId: "local-provider" }));
    const addPersonalModel = vi.fn(async () => ({}));
    const onRefresh = vi.fn(async () => {});

    render(
      <ZCodeIntlProvider initialLocale="en-US">
        <LocalModelSettings
          codeIndex={codeIndex}
          workspaceRef={workspaceRef}
          modelProviders={[]}
          createPersonalProvider={createPersonalProvider}
          addPersonalModel={addPersonalModel}
          onRefresh={onRefresh}
        />
      </ZCodeIntlProvider>,
    );

    const recommended = await screen.findByTestId("local-model-recommended");
    expect(recommended.textContent).toContain("Qwen3 Coder 30B A3B");
    expect(recommended.textContent).toContain("32.0 GB");

    fireEvent.click(screen.getByText("Install Ollama runtime"));
    expect(await screen.findByText("Ollama runtime installed.")).toBeTruthy();
    expect(install).toHaveBeenCalledTimes(1);

    fireEvent.click(within(recommended).getByText("Download"));
    expect(
      await screen.findByText("Qwen3 Coder 30B A3B is installed and available in the composer."),
    ).toBeTruthy();
    expect(pull).toHaveBeenCalledWith("qwen3-coder:30b");
    expect(createPersonalProvider).toHaveBeenCalledWith({
      providerName: "Ollama (local)",
      initialConfig: {
        access: { type: "api-key", apiKey: "ollama" },
        api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:11434/v1" },
        personalModelIds: [],
        modelOrder: [],
      },
    });
    expect(addPersonalModel).toHaveBeenCalledWith(
      "local-provider",
      "qwen3-coder:30b",
      expect.objectContaining({
        enabled: true,
        properties: expect.objectContaining({ supportsToolCall: true }),
      }),
      false,
    );
    expect(onRefresh).toHaveBeenCalled();
  });
});
