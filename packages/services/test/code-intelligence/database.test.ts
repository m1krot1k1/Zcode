import { describe, expect, it, vi } from "vitest";
import {
  requestEmbeddings,
  validateEmbeddingConfig,
} from "../../src/code-intelligence/database.js";

describe("embedding providers", () => {
  it("allows Ollama only on a loopback HTTP endpoint", () => {
    expect(
      validateEmbeddingConfig("ollama", "http://127.0.0.1:11434/api/embed", "nomic-embed-text"),
    ).toMatchObject({
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434/api/embed",
      model: "nomic-embed-text",
    });
    expect(() =>
      validateEmbeddingConfig("ollama", "https://example.test/api/embed", "nomic-embed-text"),
    ).toThrow();
    expect(() =>
      validateEmbeddingConfig("ollama", "http://example.test/api/embed", "nomic-embed-text"),
    ).toThrow();
  });

  it("allows HTTPS OpenAI-compatible endpoints but rejects URL credentials and query strings", () => {
    expect(
      validateEmbeddingConfig(
        "openai-compatible",
        "https://openrouter.ai/api/v1/embeddings",
        "openai/text-embedding-3-small",
      ),
    ).toMatchObject({ provider: "openai-compatible" });
    expect(() =>
      validateEmbeddingConfig(
        "openai-compatible",
        "https://user:secret@example.test/v1/embeddings",
        "example/embed",
      ),
    ).toThrow();
    expect(() =>
      validateEmbeddingConfig(
        "openai-compatible",
        "https://example.test/v1/embeddings?token=secret",
        "example/embed",
      ),
    ).toThrow();
    expect(() =>
      validateEmbeddingConfig(
        "openai-compatible",
        "http://example.test/v1/embeddings",
        "example/embed",
      ),
    ).toThrow();
  });

  it("normalizes an origin-only endpoint to the provider embedding path", () => {
    expect(
      validateEmbeddingConfig("openai-compatible", "https://example.test", "example/embed"),
    ).toMatchObject({ endpoint: "https://example.test/v1/embeddings" });
    expect(
      validateEmbeddingConfig("openai-compatible", "https://example.test/v1", "example/embed"),
    ).toMatchObject({ endpoint: "https://example.test/v1/embeddings" });
    expect(
      validateEmbeddingConfig("ollama", "http://127.0.0.1:11434", "nomic-embed-text"),
    ).toMatchObject({ endpoint: "http://127.0.0.1:11434/api/embeddings" });
    expect(
      validateEmbeddingConfig("ollama", "http://127.0.0.1:11434/api", "nomic-embed-text"),
    ).toMatchObject({ endpoint: "http://127.0.0.1:11434/api/embeddings" });
  });

  it("maps OpenAI-compatible response indexes back to input order and sends a bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "example/embed",
        input: ["first", "second"],
      });
      return Response.json({
        data: [
          { object: "embedding", index: 1, embedding: [0, 1] },
          { object: "embedding", index: 0, embedding: [1, 0] },
        ],
      });
    });
    const config = validateEmbeddingConfig(
      "openai-compatible",
      "https://example.test/v1/embeddings",
      "example/embed",
    );

    await expect(
      requestEmbeddings({ ...config, apiKey: "test-secret" }, ["first", "second"], fetchMock),
    ).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("uses Ollama's embeddings response without authorization by default", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "nomic-embed-text",
        input: ["text"],
      });
      return Response.json({ embeddings: [[0.25, 0.75]] });
    });
    const config = validateEmbeddingConfig(
      "ollama",
      "http://127.0.0.1:11434/api/embed",
      "nomic-embed-text",
    );

    await expect(requestEmbeddings(config, ["text"], fetchMock)).resolves.toEqual([[0.25, 0.75]]);
  });

  it("retries bounded 429 and 5xx batch responses before returning vectors", async () => {
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 503, headers: { "retry-after": "0" } });
      if (calls === 2) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ data: [{ index: 0, embedding: [0.25, 0.75] }] });
    });
    const config = validateEmbeddingConfig(
      "openai-compatible",
      "https://example.test/v1/embeddings",
      "example/embed",
    );

    await expect(requestEmbeddings(config, ["text"], fetchMock)).resolves.toEqual([[0.25, 0.75]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a rate limit whose Retry-After exceeds the bounded wait", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
    );
    const config = validateEmbeddingConfig(
      "openai-compatible",
      "https://example.test/v1/embeddings",
      "example/embed",
    );

    await expect(requestEmbeddings(config, ["text"], fetchMock)).rejects.toMatchObject({
      name: "EmbeddingHttpError",
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an OpenAI-compatible response with duplicate or missing indexes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [0] },
        ],
      }),
    );
    const config = validateEmbeddingConfig(
      "openai-compatible",
      "https://example.test/v1/embeddings",
      "example/embed",
    );

    await expect(requestEmbeddings(config, ["first", "second"], fetchMock)).rejects.toThrow(
      "invalid vector order",
    );
  });

  it("preserves only the HTTP status for provider failures, never the response body", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('{"error":"private provider detail"}', { status: 401 }),
    );
    const config = validateEmbeddingConfig(
      "openai-compatible",
      "https://example.test/v1/embeddings",
      "example/embed",
    );

    await expect(requestEmbeddings(config, ["probe"], fetchMock)).rejects.toMatchObject({
      name: "EmbeddingHttpError",
      message: "Embedding endpoint returned HTTP 401.",
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
