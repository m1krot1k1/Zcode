import type { ProviderSettingsFacade } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { createProviderSettingsService } from "../src/model-provider/providerFacadeServices.js";

function createFacade(): ProviderSettingsFacade {
  return {
    onDidChange: vi.fn(),
    getView: vi.fn(() => ({ revision: 1, providers: [] })),
  } as unknown as ProviderSettingsFacade;
}

function createService(fetchImpl: typeof fetch) {
  return createProviderSettingsService(createFacade(), undefined, undefined, { fetchImpl });
}

function response(status: number): Response {
  return new Response(status >= 400 ? '{"error":"nope"}' : '{"ok":true}', { status });
}

describe("Provider API format detection", () => {
  it("probes the three wire formats and selects the one that answers", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/chat/completions")) return response(200);
      return response(404);
    });
    const service = createService(fetchImpl as unknown as typeof fetch);

    const result = await service.detectApiFormat({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-fixture",
      modelId: "model-x",
    });

    expect(result.format).toBe("openai-chat-completions");
    expect(result.reason).toBe("detected");
    expect(calls.sort()).toEqual([
      "https://api.example.com/v1/chat/completions",
      "https://api.example.com/v1/messages",
      "https://api.example.com/v1/responses",
    ]);
    const chatCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith("/chat/completions"),
    );
    expect(chatCall?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer sk-fixture" }),
    });
  });

  it("keeps a working preferred format when several formats answer", async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const service = createService(fetchImpl as unknown as typeof fetch);

    const result = await service.detectApiFormat({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-fixture",
      modelId: "model-x",
      preferred: "openai-responses",
    });

    expect(result.format).toBe("openai-responses");
  });

  it("reports auth when every format is rejected with 401/403", async () => {
    const fetchImpl = vi.fn(async () => response(401));
    const service = createService(fetchImpl as unknown as typeof fetch);

    const result = await service.detectApiFormat({
      baseUrl: "https://api.example.com/v1",
      modelId: "model-x",
    });

    expect(result).toMatchObject({ format: null, reason: "auth" });
  });

  it("does not probe invalid endpoints or empty model ids", async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const service = createService(fetchImpl as unknown as typeof fetch);

    await expect(
      service.detectApiFormat({ baseUrl: "file:///tmp/model", modelId: "model-x" }),
    ).resolves.toMatchObject({ format: null, reason: "none" });
    await expect(
      service.detectApiFormat({ baseUrl: "https://api.example.com/v1", modelId: "  " }),
    ).resolves.toMatchObject({ format: null, reason: "none" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
