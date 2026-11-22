import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import { HexVoiceService } from "./hexVoiceService.js";

function sse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function model() {
  return {
    id: "parakeet_unified_en",
    name: "Parakeet Unified English",
    languages: ["en"],
    installed: true,
    verified: true,
    downloadBytes: 1,
    streams: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HexVoiceService streaming startup", () => {
  it("prepares an installed model and retries the 503 model-not-loaded window", async () => {
    const service = new HexVoiceService();
    (service as unknown as { endpoint: { url: string; token: string } }).endpoint = {
      url: "http://hex.test",
      token: "secret",
    };
    (service as unknown as { models: Map<string, unknown> }).models.set(
      "parakeet_unified_en",
      model(),
    );
    let streamAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/models/parakeet_unified_en/prepare")) {
        return sse('data: {"type":"loading"}\n\ndata: {"type":"ok"}\n\n');
      }
      if (url.endsWith("/streams")) {
        streamAttempts += 1;
        if (streamAttempts < 3) {
          return new Response('{"code":"model-not-loaded"}', { status: 503 });
        }
        return new Response(JSON.stringify({ id: 1, ownerToken: "owner", partials: true }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/streams/1/events")) {
        return sse('data: {"type":"partial","stable":"hello","tentative":""}\n\n');
      }
      if (url.endsWith("/streams/1/cancel")) return new Response("{}", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.handle({
      action: "start",
      request: { model: "parakeet_unified_en", language: "en" },
    });

    expect(result).toMatchObject({ mode: "streaming", partials: true });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/prepare?language=en"))).toBe(
      true,
    );
    expect(streamAttempts).toBe(3);

    await service.handle({ action: "cancel" });
    service.dispose();
  });

  it("does not prepare an installed model twice on a normal start", async () => {
    const service = new HexVoiceService();
    (service as unknown as { endpoint: { url: string; token: string } }).endpoint = {
      url: "http://hex.test",
      token: "secret",
    };
    (service as unknown as { models: Map<string, unknown> }).models.set(
      "parakeet_unified_en",
      model(),
    );
    let prepares = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/prepare")) {
        prepares += 1;
        return sse('data: {"type":"ok"}\n\n');
      }
      if (url.endsWith("/streams")) {
        return new Response(JSON.stringify({ id: 1, ownerToken: "owner", partials: true }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/streams/1/events")) return sse("");
      if (url.endsWith("/streams/1/cancel")) return new Response("{}", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await service.handle({
      action: "start",
      request: { model: "parakeet_unified_en", language: "en" },
    });
    await service.handle({ action: "cancel" });
    await service.handle({
      action: "start",
      request: { model: "parakeet_unified_en", language: "en" },
    });

    expect(prepares).toBe(1);
    await service.handle({ action: "cancel" });
    service.dispose();
  });
});
