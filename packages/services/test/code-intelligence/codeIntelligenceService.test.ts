import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import type { CodeIntelligenceService } from "../../src/code-intelligence/contract.js";
import { createCodeIntelligenceService } from "../../src/code-intelligence/codeIntelligenceService.js";
import { databaseFileFor } from "../../src/code-intelligence/worker/storePath.js";
import { openStore } from "../../src/code-intelligence/worker/store.js";

/** Открывает индексный файл напрямую (схема v2) и гарантированно закрывает соединение. */
async function withIndexDatabase<T>(
  databasePath: string,
  read: (db: Awaited<ReturnType<typeof openStore>>["db"]) => T,
): Promise<T> {
  const { db } = await openStore(databasePath);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Тестовая обвязка для ожидания асинхронных событий `fs.watch`.
 *
 * 原因: контент и удаления внутри watched-корня доставляются событиями `fs.watch`.
 * 在 полном прогоне (особенно на Node 24, где `rename` может доставляться позже)
 * фиксированные 100×50 мс не гарантируют доставку — падение отражает бюджет
 * ожидания, а не поведение кода. При исчерпании бюджета тест падает с явной
 * причиной в сообщении, поэтому диагностика не теряется.
 */
async function waitForCondition(
  predicate: () => Promise<boolean>,
  reason: string,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 200;
  const intervalMs = options.intervalMs ?? 50;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Не дождались события fs.watch за ${attempts}×${intervalMs} мс: ${reason}. ` +
      "Если это повторяется на свежем HEAD — проверяйте доставку событий, а не бюджет ожидания.",
  );
}

const temporaryRoots: string[] = [];
const services: Array<ReturnType<typeof createCodeIntelligenceService>> = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.disposeAllAndWait()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createTestService() {
  const root = await mkdtemp(join(tmpdir(), "zcode-code-intelligence-"));
  temporaryRoots.push(root);
  const workspacePath = join(root, "workspace");
  const indexRootDir = join(root, "indexes");
  await mkdir(workspacePath, { recursive: true });
  const credentials = new Map<string, string>();
  const credentialService = {
    load: vi.fn(async (key: string) => credentials.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      credentials.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      credentials.delete(key);
    }),
  };
  const service = createCodeIntelligenceService({
    indexRootDir,
    credentialService,
  });
  services.push(service);
  return {
    root,
    workspacePath,
    indexRootDir,
    credentials,
    credentialService,
    service,
  };
}

describe("code intelligence embedding configuration", () => {
  it("probes the same maximum batch size used by indexing", async () => {
    const { workspacePath, root } = await createTestService();
    const requestSizes: number[] = [];
    const probeService = createCodeIntelligenceService({
      indexRootDir: join(root, "batch-probe-index"),
      fetch: vi.fn(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        requestSizes.push(body.input.length);
        return Response.json({
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
        });
      }) as typeof fetch,
    });
    services.push(probeService);

    const result = await probeService.testEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });

    expect(result).toMatchObject({ ok: true, dimensions: 2 });
    expect(requestSizes).toEqual([32]);
  });

  it("tests Ollama against a controlled loopback API without sending credentials off-device", async () => {
    const { workspacePath, root } = await createTestService();
    const requests: Array<{
      authorization: string | null;
      body: { model: string; input: string[] };
    }> = [];
    const server = createServer((request, response) => {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(rawBody) as { model: string; input: string[] };
        requests.push({ authorization: request.headers.authorization ?? null, body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ embeddings: body.input.map(() => [0.25, 0.75]) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback server did not bind.");
    const endpoint = `http://127.0.0.1:${address.port}/api/embed`;
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "ollama-probe-index"),
    });
    services.push(service);

    try {
      const result = await service.testEmbeddingConfig({
        workspacePath,
        provider: "ollama",
        endpoint,
        model: "nomic-embed-text",
      });

      expect(result).toMatchObject({ ok: true, dimensions: 2 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: null,
        body: { model: "nomic-embed-text" },
      });
      expect(requests[0]?.body.input).toHaveLength(32);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports a safe bulk embedding failure even when the single-request probe passed", async () => {
    const { workspacePath, root } = await createTestService();
    await writeFile(join(workspacePath, "embed.ts"), "export const indexed = true;", "utf8");
    let requestCount = 0;
    const providerBody = "private provider response must not escape";
    const indexService = createCodeIntelligenceService({
      indexRootDir: join(root, "bulk-error-index"),
      fetch: vi.fn(async (_input, init) => {
        requestCount += 1;
        if (requestCount > 1) return new Response(providerBody, { status: 429 });
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return Response.json({
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
        });
      }) as typeof fetch,
    });
    services.push(indexService);
    const config = {
      workspacePath,
      provider: "openai-compatible" as const,
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    };
    await indexService.setEmbeddingConfig(config);
    expect(await indexService.testEmbeddingConfig(config)).toMatchObject({ ok: true });

    const status = await indexService.indexWorkspace({ workspacePath });

    expect(status.embedding).toMatchObject({
      phase: "failed",
      lastError: { code: "rate-limited", httpStatus: 429 },
    });
    expect(JSON.stringify(status)).not.toContain(providerBody);

    const restartedService = createCodeIntelligenceService({
      indexRootDir: join(root, "bulk-error-index"),
    });
    services.push(restartedService);
    await expect(restartedService.getStatus({ workspacePath })).resolves.toMatchObject({
      embedding: {
        phase: "failed",
        lastError: { code: "rate-limited", httpStatus: 429 },
      },
    });
  });

  it("reports ready after the indexing pass that was in flight", async () => {
    const { workspacePath, root } = await createTestService();
    await writeFile(join(workspacePath, "held.ts"), "export const held = true;\n", "utf8");
    let releaseFetch: (response: Response) => void = () => undefined;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "stale-status-index"),
      fetch: vi.fn(() => fetchGate) as typeof fetch,
    });
    services.push(service);
    await service.setEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });

    const indexing = service.indexWorkspace({ workspacePath });
    await vi.waitFor(async () => {
      expect((await service.getStatus({ workspacePath })).state).toBe("indexing");
    });
    releaseFetch(
      Response.json({
        data: [{ index: 0, embedding: [1, 0] }],
      }),
    );
    await indexing;

    await expect(service.getStatus({ workspacePath })).resolves.toMatchObject({ state: "ready" });
  });

  it("returns indexing status without waiting for the busy worker", async () => {
    const { workspacePath, root } = await createTestService();
    await writeFile(join(workspacePath, "held.ts"), "export const held = true;\n", "utf8");
    let releaseFetch: (response: Response) => void = () => undefined;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const statusHook = vi.fn(async () => {});
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "busy-worker-index"),
      fetch: vi.fn(() => fetchGate) as typeof fetch,
      beforeReadStatusProgress: statusHook,
    });
    services.push(service);
    await service.setEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });

    const indexing = service.indexWorkspace({ workspacePath });
    await vi.waitFor(async () => {
      expect((await service.getStatus({ workspacePath })).state).toBe("indexing");
    });
    const callsBefore = statusHook.mock.calls.length;
    const startedAt = Date.now();
    const status = await service.getStatus({ workspacePath });
    expect(status.state).toBe("indexing");
    expect(statusHook.mock.calls.length).toBe(callsBefore);
    expect(Date.now() - startedAt).toBeLessThan(1000);

    releaseFetch(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    await indexing;
  });

  it("sanitizes invalid probe inputs and credential-store failures without saving draft settings", async () => {
    const { workspacePath, service, credentialService } = await createTestService();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })),
    );
    const probeService = createCodeIntelligenceService({
      indexRootDir: join(workspacePath, "probe-index"),
      fetch: fetchImpl as typeof fetch,
      credentialService: {
        ...credentialService,
        load: vi.fn(async () => {
          throw new Error("secret backend detail");
        }),
      },
    });
    services.push(probeService);

    const invalid = await service.testEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "not a url",
      model: "m",
    });
    const credentialFailure = await probeService.testEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "m",
    });
    expect(invalid).toMatchObject({ ok: false, errorCode: "invalid-config" });
    expect(credentialFailure).toMatchObject({ ok: false, errorCode: "request-failed" });
    expect(JSON.stringify(credentialFailure)).not.toContain("secret backend detail");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await service.getStatus({ workspacePath })).embedding.configured).toBe(false);
  });

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [404, "not-found"],
    [429, "rate-limited"],
    [503, "provider-error"],
  ] as const)(
    "reports sanitized HTTP %s failures from the embedding provider",
    async (httpStatus, errorCode) => {
      const { workspacePath, root, credentialService } = await createTestService();
      const privateBody = "provider response contains private diagnostics";
      const probeService = createCodeIntelligenceService({
        indexRootDir: join(root, "http-error-index"),
        fetch: vi.fn(
          async () =>
            new Response(privateBody, {
              status: httpStatus,
              ...(httpStatus === 429 || httpStatus >= 500
                ? { headers: { "retry-after": "0" } }
                : {}),
            }),
        ) as typeof fetch,
        credentialService,
      });
      services.push(probeService);

      const result = await probeService.testEmbeddingConfig({
        workspacePath,
        provider: "openai-compatible",
        endpoint: "https://example.com/v1/embeddings",
        model: "example/embed",
        apiKey: "sk-transient-probe-token",
      });

      expect(result).toMatchObject({ ok: false, errorCode, httpStatus });
      expect(JSON.stringify(result)).not.toContain(privateBody);
      expect(JSON.stringify(result)).not.toContain("sk-transient-probe-token");
    },
  );

  it("keeps an optional API key in secure credentials and out of SQLite/status", async () => {
    const { workspacePath, indexRootDir, credentials, credentialService, service } =
      await createTestService();
    const workspaceIdentity = "remote-workspace:private-123";
    const workspaceRef = { workspacePath, workspaceIdentity };
    const apiKey = "sk-example-embedding-token-should-not-be-stored-in-sqlite";
    const key = `code-intelligence:${createHash("sha256")
      .update(workspaceIdentity)
      .digest("hex")
      .slice(0, 32)}:embedding-api-key`;

    const status = await service.setEmbeddingConfig({
      ...workspaceRef,
      provider: "openai-compatible",
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      model: "openai/text-embedding-3-small",
      apiKey,
    });

    expect(credentials.get(key)).toBe(apiKey);
    expect(status.embedding).toMatchObject({
      configured: true,
      provider: "openai-compatible",
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      model: "openai/text-embedding-3-small",
      apiKeyConfigured: true,
      available: false,
    });
    expect(JSON.stringify(status)).not.toContain(apiKey);
    const dbPath = databaseFileFor(indexRootDir, workspaceIdentity);
    const storedBytes = await Promise.all(
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((path) =>
        readFile(path).catch(() => Buffer.alloc(0)),
      ),
    );
    expect(Buffer.concat(storedBytes).includes(Buffer.from(apiKey))).toBe(false);

    const preserved = await service.setEmbeddingConfig({
      ...workspaceRef,
      provider: "openai-compatible",
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      model: "openai/text-embedding-3-small",
    });
    expect(credentials.get(key)).toBe(apiKey);
    expect(preserved.embedding.apiKeyConfigured).toBe(true);

    const clearedKey = await service.setEmbeddingConfig({
      ...workspaceRef,
      apiKey: null,
    });
    expect(credentials.has(key)).toBe(false);
    expect(clearedKey.embedding.apiKeyConfigured).toBe(false);
    expect(credentialService.delete).toHaveBeenCalledWith(key);
  });

  it("reuses the Host-saved token after a successful transient probe over the service RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-code-intelligence-rpc-credentials-"));
    temporaryRoots.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const credentials = new Map<string, string>();
    const credentialService = {
      load: vi.fn(async (key: string) => credentials.get(key) ?? null),
      save: vi.fn(async (key: string, value: string) => {
        credentials.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        credentials.delete(key);
      }),
    };
    const authorizationHeaders: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
      });
    }) as typeof fetch;
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "indexes"),
      credentialService,
      fetch: fetchMock,
    });
    services.push(service);

    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "local-host");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel("code-intelligence", ProxyChannel.fromService(service));
    const hostService = ProxyChannel.toService<CodeIntelligenceService>(
      client.getChannel("code-intelligence"),
    );
    const workspaceRef = { workspacePath, workspaceIdentity: "workspace-credential-test" };
    const config = {
      ...workspaceRef,
      provider: "openai-compatible" as const,
      endpoint: "https://embedding.example/v1/embeddings",
      model: "example/embed-model",
    };
    const token = "test-only-transient-token";

    try {
      const firstProbe = await hostService.testEmbeddingConfig({ ...config, apiKey: token });
      expect(firstProbe.ok, JSON.stringify(firstProbe)).toBe(true);
      expect(credentials.size).toBe(0);

      await expect(
        hostService.setEmbeddingConfig({ ...config, apiKey: token }),
      ).resolves.toMatchObject({
        embedding: { apiKeyConfigured: true },
      });
      expect([...credentials.values()]).toEqual([token]);

      credentialService.load.mockClear();
      await expect(hostService.testEmbeddingConfig(config)).resolves.toMatchObject({ ok: true });
      expect(credentialService.load).toHaveBeenCalledWith(
        expect.stringMatching(/^code-intelligence:[a-f0-9]{32}:embedding-api-key$/u),
      );
      expect(authorizationHeaders).toEqual([`Bearer ${token}`, `Bearer ${token}`]);

      const restartedService = createCodeIntelligenceService({
        indexRootDir: join(root, "indexes"),
        credentialService,
        fetch: fetchMock,
      });
      services.push(restartedService);
      await expect(restartedService.testEmbeddingConfig(config)).resolves.toMatchObject({
        ok: true,
      });
      expect(authorizationHeaders).toEqual([
        `Bearer ${token}`,
        `Bearer ${token}`,
        `Bearer ${token}`,
      ]);
    } finally {
      server.dispose();
      client.dispose();
    }
  });

  it("removes workspace-scoped embedding credentials when the index is cleared", async () => {
    const { workspacePath, credentials, service } = await createTestService();
    const identity = "workspace-to-clear";
    const key = `code-intelligence:${createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 32)}:embedding-api-key`;
    await service.setEmbeddingConfig({
      workspacePath,
      workspaceIdentity: identity,
      provider: "openai-compatible",
      endpoint: "https://openrouter.ai/api/v1/embeddings",
      model: "openai/text-embedding-3-small",
      apiKey: "sk-delete-on-clear",
    });

    await service.clearIndex({ workspacePath, workspaceIdentity: identity });

    expect(credentials.has(key)).toBe(false);
  });
});

describe("code intelligence coverage", () => {
  it("indexes a fixture password in a test without marking the workspace partial", async () => {
    const { workspacePath, service } = await createTestService();
    await mkdir(join(workspacePath, "src", "test"), { recursive: true });
    await writeFile(join(workspacePath, "src", "ready.ts"), "export const ready = true;\n", "utf8");
    await writeFile(
      join(workspacePath, "src", "test", "login.test.ts"),
      'export const password = "fixture-password-value";\n',
      "utf8",
    );

    const status = await service.indexWorkspace({ workspacePath });

    expect(status.partial).toBe(false);
    expect(status.diagnostics.join("\n")).not.toContain("secret patterns");
    const found = await service.search({
      workspacePath,
      query: "fixture-password-value",
      lexicalOnly: true,
    });
    expect(found.results.some((hit) => hit.path.endsWith("login.test.ts"))).toBe(true);
  });

  it("migrates an old policy-only partial flag to green when the pass is complete", async () => {
    const { workspacePath, indexRootDir, service } = await createTestService();
    await writeFile(join(workspacePath, "a.ts"), "export const a = 1;\n", "utf8");
    await service.indexWorkspace({ workspacePath });
    const databasePath = databaseFileFor(indexRootDir, workspacePath);
    await withIndexDatabase(databasePath, (db) => {
      db.prepare("UPDATE meta SET value = 'true' WHERE key = 'index_partial'").run();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'diagnostics'").run(
        JSON.stringify(["A source file matching secret patterns was excluded from the index."]),
      );
    });

    const status = await service.getStatus({ workspacePath });
    expect(status.partial).toBe(false);
    expect(status.diagnostics.some((line) => line.includes("secret patterns"))).toBe(true);
  });

  it("keeps a product credential and a private-key block out of the index", async () => {
    const { workspacePath, service } = await createTestService();
    await mkdir(join(workspacePath, "src", "test"), { recursive: true });
    await writeFile(
      join(workspacePath, "src", "keys.ts"),
      'export const password = "production-credential-value";\n',
      "utf8",
    );
    await writeFile(
      join(workspacePath, "src", "test", "pem.test.ts"),
      `${"-----BEGIN " + "PRIVATE KEY-----"}\nfixture\n`,
      "utf8",
    );

    const status = await service.indexWorkspace({ workspacePath });

    expect(status.partial).toBe(false);
    expect(status.diagnostics.some((line) => line.includes("secret patterns"))).toBe(true);
    const found = await service.search({
      workspacePath,
      query: "production-credential-value",
      lexicalOnly: true,
    });
    expect(found.results).toEqual([]);
    const pem = await service.search({
      workspacePath,
      query: "BEGIN PRIVATE KEY",
      lexicalOnly: true,
    });
    expect(pem.results).toEqual([]);
  });
});

describe("code intelligence graph overview", () => {
  it("resolves named imported calls to the exported symbol across workspace files", async () => {
    const { workspacePath, service } = await createTestService();
    const sourceDir = join(workspacePath, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "embeddingProbe.ts"),
      "export async function probeEmbeddingProvider() { return true; }\n",
      "utf8",
    );
    await writeFile(
      join(sourceDir, "codeIntelligenceService.ts"),
      'import { probeEmbeddingProvider as probe } from "./embeddingProbe.js";\nexport async function testEmbeddingConfig() { return probe(); }\n',
      "utf8",
    );

    await service.indexWorkspace({ workspacePath });

    await expect(
      service.getSymbolContext({ workspacePath, symbol: "probeEmbeddingProvider" }),
    ).resolves.toMatchObject({
      symbol: { name: "probeEmbeddingProvider", path: "src/embeddingProbe.ts" },
      callers: [
        expect.objectContaining({
          name: "testEmbeddingConfig",
          path: "src/codeIntelligenceService.ts",
        }),
      ],
    });

    await writeFile(
      join(sourceDir, "embeddingProbe.ts"),
      "// moved in the file\nexport async function probeEmbeddingProvider() { return true; }\n",
      "utf8",
    );
    await service.indexWorkspace({ workspacePath });

    await expect(
      service.getSymbolContext({ workspacePath, symbol: "probeEmbeddingProvider" }),
    ).resolves.toMatchObject({
      callers: [
        expect.objectContaining({
          name: "testEmbeddingConfig",
          path: "src/codeIntelligenceService.ts",
        }),
      ],
    });
  });

  it("persists provider vectors as compact 256-dim projections and reuses them on search", async () => {
    const { workspacePath, indexRootDir } = await createTestService();
    const sourceDir = join(workspacePath, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "embeddingProbe.ts"),
      "export async function probeEmbeddingProvider() {\n  return true;\n}\n",
      "utf8",
    );
    await writeFile(
      join(sourceDir, "codeIntelligenceService.ts"),
      'import { probeEmbeddingProvider } from "./embeddingProbe.js";\n' +
        "export const testEmbeddingConfig = async (params: unknown) => {\n" +
        "  return probeEmbeddingProvider(params);\n" +
        "};\n",
      "utf8",
    );
    // Провайдер отвечает 8-мерными векторами: проверяем, что в БД лежит 256-байтная проекция,
    // а полноразмерный вектор не дублируется в постингах.
    const fetchImpl = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({
        data: body.input.map((_, index) => ({
          index,
          embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        })),
      });
    }) as typeof fetch;
    const indexedService = createCodeIntelligenceService({ indexRootDir, fetch: fetchImpl });
    services.push(indexedService);
    await indexedService.setEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });
    const indexed = await indexedService.indexWorkspace({ workspacePath });
    expect(indexed.embedding).toMatchObject({ phase: "ready" });

    const databasePath = databaseFileFor(indexRootDir, workspacePath);
    const shapes = await withIndexDatabase(
      databasePath,
      (db) =>
        db
          .prepare(
            // v3: 4-битная упаковка (256 измерений → 128 байт) плюс масштаб на вектор.
            // Полноразмерный `provider_vec_i8` не хранится: канал работает в 256-мерном
            // пространстве проекции, поэтому исходный вектор никем не читался.
            "SELECT length(provider_sketch_q4) AS sketch_len, provider_scale AS scale, provider_identity AS identity FROM chunk_vectors WHERE provider_sketch_q4 IS NOT NULL",
          )
          .all() as Array<{ sketch_len: number; scale: number; identity: string }>,
    );
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.sketch_len).toBe(128);
      expect(shape.scale).toBeGreaterThan(0);
      expect(shape.identity).toContain("embed-model");
    }
    const providerPostings = await withIndexDatabase(
      databasePath,
      (db) =>
        db.prepare("SELECT COUNT(*) AS total FROM sketch_postings WHERE kind = 1").get() as {
          total: number;
        },
    );
    expect(Number(providerPostings.total)).toBeGreaterThan(0);

    // Графовые факты не зависят от векторов: контекст символа переживает повторный проход.
    await indexedService.indexWorkspace({ workspacePath });
    await expect(
      indexedService.getSymbolContext({ workspacePath, symbol: "probeEmbeddingProvider" }),
    ).resolves.toMatchObject({
      callers: [
        expect.objectContaining({
          name: "testEmbeddingConfig",
          path: "src/codeIntelligenceService.ts",
        }),
      ],
    });
  });

  it("returns bounded relative-path nodes and focus neighborhoods from the local index", async () => {
    const { workspacePath, service } = await createTestService();
    const sourceDir = join(workspacePath, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "alpha.ts"),
      'import { beta } from "./beta";\nexport function helper() { return 1; }\nexport function alpha() { return helper(); }\n',
      "utf8",
    );
    await writeFile(
      join(sourceDir, "beta.ts"),
      'import { alpha } from "./alpha";\nexport function beta() { return alpha(); }\n',
      "utf8",
    );

    await service.indexWorkspace({ workspacePath });
    const overview = await service.getGraphOverview({ workspacePath, limit: 10 });

    expect(overview.nodes.length).toBeLessThanOrEqual(10);
    expect(overview.nodes.some((node) => node.path === "/src/alpha.ts")).toBe(false);
    expect(overview.nodes.some((node) => node.path === "src/alpha.ts")).toBe(true);
    expect(overview.edges.map((edge) => edge.relation)).toEqual(
      expect.arrayContaining(["imports", "calls"]),
    );
    expect(typeof overview.partial).toBe("boolean");

    const alphaNode = overview.nodes.find((node) => node.name === "alpha");
    expect(alphaNode).toBeDefined();
    const focused = await service.getGraphOverview({
      workspacePath,
      focus: { symbol: alphaNode!.id },
    });
    expect(focused.focusId).toBe(alphaNode!.id);
    expect(focused.nodes.length).toBeGreaterThan(0);
    expect(
      focused.edges.every(
        (edge) =>
          focused.nodes.some((node) => node.id === edge.source) &&
          focused.nodes.some((node) => node.id === edge.target),
      ),
    ).toBe(true);
    expect(JSON.stringify(focused)).not.toContain(workspacePath);
  });

  it("keeps the overview inside one connected code neighborhood", async () => {
    const { workspacePath, service } = await createTestService();
    const sourceDir = join(workspacePath, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "alpha.ts"),
      'import { beta } from "./beta.js";\nexport function alpha() { return beta(); }\n',
      "utf8",
    );
    await writeFile(
      join(sourceDir, "beta.ts"),
      'import { alpha } from "./alpha.js";\nexport function beta() { return alpha(); }\n',
      "utf8",
    );
    await writeFile(
      join(sourceDir, "core.ts"),
      [
        "export function core() { return a() + b() + c() + d(); }",
        "export function a() { return core(); }",
        "export function b() { return core(); }",
        "export function c() { return core(); }",
        "export function d() { return core(); }",
      ].join("\n"),
      "utf8",
    );

    await service.indexWorkspace({ workspacePath });
    const overview = await service.getGraphOverview({ workspacePath, limit: 3 });

    expect(overview.nodes.length).toBeGreaterThanOrEqual(3);
    expect(overview.nodes.every((node) => node.path === "src/core.ts")).toBe(true);
    expect(overview.edges.length).toBeGreaterThan(0);
    expect(
      overview.edges.every(
        (edge) =>
          overview.nodes.some((node) => node.id === edge.source) &&
          overview.nodes.some((node) => node.id === edge.target),
      ),
    ).toBe(true);
  });
});

describe("code intelligence workspace lifecycle", () => {
  it("reports embedding phases from pending through committed ready or failed", async () => {
    const { workspacePath, root } = await createTestService();
    await writeFile(
      join(workspacePath, "embed.ts"),
      "export function embedMe() { return 1; }",
      "utf8",
    );
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "phase-index"),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ index: 0, embedding: [1, 0] }],
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    });
    services.push(service);
    const configured = await service.setEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });
    expect(configured.embedding.phase).toBe("pending");
    const indexed = await service.indexWorkspace({ workspacePath });
    expect(indexed.embedding).toMatchObject({ phase: "ready", available: true });

    const failing = createCodeIntelligenceService({
      indexRootDir: join(root, "failed-phase-index"),
      fetch: vi.fn(async () => new Response("{}", { status: 503 })) as typeof fetch,
    });
    services.push(failing);
    await failing.setEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });
    const failed = await failing.indexWorkspace({ workspacePath });
    expect(failed.embedding.phase).toBe("failed");
  });

  it("reconciles watched nested edits and deletions and rebinds the same identity to a new root", async () => {
    const { root, workspacePath, service } = await createTestService();
    const nestedSourceDir = join(workspacePath, "src", "nested");
    await mkdir(nestedSourceDir, { recursive: true });
    const source = join(nestedSourceDir, "sample.ts");
    await writeFile(source, "export function beforeChange() { return 1; }", "utf8");
    await service.indexWorkspace({ workspacePath, workspaceIdentity: "stable-id" });
    await service.watchWorkspace({ workspacePath, workspaceIdentity: "stable-id" });
    await service.watchWorkspace({ workspacePath, workspaceIdentity: "stable-id" });
    await writeFile(source, "export function afterChange() { return 2; }", "utf8");
    // 原因: переиндексация наблюдаемого файла идёт через `fs.watch`, и в полном прогоне
    // доставка события под нагрузкой выходит за фиксированные 100×50 мс. Падал не баг,
    // а бюджет ожидания. Ждём больше и явно сообщаем причину при исчерпании бюджета —
    // это тестовая обвязка, продакшн-код не ослабляем.
    await waitForCondition(
      async () =>
        (
          await service.search({
            workspacePath,
            workspaceIdentity: "stable-id",
            query: "afterChange",
          })
        ).results.length > 0,
      "переиндексация изменённого sample.ts через fs.watch",
    );
    expect(
      (
        await service.search({
          workspacePath,
          workspaceIdentity: "stable-id",
          query: "beforeChange",
        })
      ).results,
    ).toHaveLength(0);
    expect(
      (
        await service.search({
          workspacePath,
          workspaceIdentity: "stable-id",
          query: "afterChange",
        })
      ).results.length,
    ).toBeGreaterThan(0);

    const movedRoot = join(root, "moved-workspace");
    await mkdir(movedRoot);
    await writeFile(
      join(movedRoot, "replacement.ts"),
      "export function movedRootSymbol() {}",
      "utf8",
    );
    await service.watchWorkspace({ workspacePath: movedRoot, workspaceIdentity: "stable-id" });
    expect(
      (await service.getStatus({ workspacePath: movedRoot, workspaceIdentity: "stable-id" })).counts
        .files,
    ).toBe(1);
    await rm(join(movedRoot, "replacement.ts"));
    // 原因: удаление внутри уже наблюдаемого корня доезжает только через `fs.watch`.
    // В полном прогоне на Node 24 доставка `rename` под нагрузкой выходит за 5 с,
    // поэтому фиксированный цикл 100×50 мс падал на медленной доставке, а не на баге.
    await waitForCondition(
      async () =>
        (await service.getStatus({ workspacePath: movedRoot, workspaceIdentity: "stable-id" }))
          .counts.files === 0,
      "удаление replacement.ts из watched-корня",
      { attempts: 400, intervalMs: 50 },
    );
    expect(
      (await service.getStatus({ workspacePath: movedRoot, workspaceIdentity: "stable-id" })).counts
        .files,
    ).toBe(0);
  });

  it("indexes added and renamed files with fresh embeddings, then removes deleted vectors", async () => {
    const { workspacePath, indexRootDir } = await createTestService();
    const embeddedInputs: string[] = [];
    const fetchImpl = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      embeddedInputs.push(...body.input);
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [0.5, 0.5] })),
      });
    }) as typeof fetch;
    const indexedService = createCodeIntelligenceService({ indexRootDir, fetch: fetchImpl });
    services.push(indexedService);
    const identity = "watch-add-rename-delete";
    await indexedService.setEmbeddingConfig({
      workspacePath,
      workspaceIdentity: identity,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });
    await indexedService.indexWorkspace({ workspacePath, workspaceIdentity: identity });
    await indexedService.watchWorkspace({ workspacePath, workspaceIdentity: identity });

    const databasePath = databaseFileFor(indexRootDir, identity);
    const readChunkPaths = () =>
      withIndexDatabase(
        databasePath,
        (db) =>
          db
            .prepare(
              "SELECT f.rel_path AS path FROM chunks c JOIN files f ON f.file_id = c.file_id ORDER BY f.rel_path",
            )
            .all() as Array<{ path: string }>,
      );
    const waitFor = async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for the code index watcher to reconcile a file change.");
    };

    const addedPath = join(workspacePath, "added.ts");
    await writeFile(addedPath, "export function addedSemanticMarker() { return 1; }", "utf8");
    await waitFor(
      async () =>
        (await indexedService.getStatus({ workspacePath, workspaceIdentity: identity })).counts
          .files === 1,
    );
    await waitFor(async () => (await readChunkPaths()).some((chunk) => chunk.path === "added.ts"));
    const firstVectorCount = (await readChunkPaths()).length;
    expect(embeddedInputs.some((content) => content.includes("addedSemanticMarker"))).toBe(true);
    expect(firstVectorCount).toBeGreaterThan(0);
    const firstGeneration = (
      await indexedService.getStatus({ workspacePath, workspaceIdentity: identity })
    ).generation;

    const renamedPath = join(workspacePath, "renamed.ts");
    await rename(addedPath, renamedPath);
    await waitFor(async () => {
      const paths = (await readChunkPaths()).map((chunk) => chunk.path);
      return paths.includes("renamed.ts") && !paths.includes("added.ts");
    });
    expect(embeddedInputs.some((content) => content.includes("addedSemanticMarker"))).toBe(true);
    expect(
      (await indexedService.getStatus({ workspacePath, workspaceIdentity: identity })).generation,
    ).toBeGreaterThan(firstGeneration);
    await expect(
      indexedService.getSymbolContext({
        workspacePath,
        workspaceIdentity: identity,
        symbol: "addedSemanticMarker",
      }),
    ).resolves.toMatchObject({ symbol: { path: "renamed.ts" } });

    await rm(renamedPath);
    await waitFor(
      async () =>
        (await indexedService.getStatus({ workspacePath, workspaceIdentity: identity })).counts
          .files === 0,
    );
    await expect(readChunkPaths()).resolves.toEqual([]);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("prevents an activation index from surviving clearIndex", async () => {
    const { workspacePath } = await createTestService();
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const root = temporaryRoots.at(-1)!;
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "race-index"),
      fetch: fetchImpl as typeof fetch,
    });
    services.push(service);
    await writeFile(join(workspacePath, "race.ts"), "export function raceSymbol() {}", "utf8");
    await service.indexWorkspace({ workspacePath, workspaceIdentity: "clear-race" });
    await service.setEmbeddingConfig({
      workspacePath,
      workspaceIdentity: "clear-race",
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });
    const activation = service.watchWorkspace({ workspacePath, workspaceIdentity: "clear-race" });
    for (let i = 0; i < 100 && !fetchImpl.mock.calls.length; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).toHaveBeenCalled();
    const clearing = service.clearIndex({ workspacePath, workspaceIdentity: "clear-race" });
    release(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }));
    await Promise.all([clearing, activation.catch(() => undefined)]);
    expect(
      (await service.getStatus({ workspacePath, workspaceIdentity: "clear-race" })).state,
    ).toBe("unindexed");
  });
});

describe("code intelligence chunk excerpts", () => {
  it("returns the stored chunk and does not call the embedding provider for lexicalOnly", async () => {
    const { workspacePath, root } = await createTestService();
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "excerpt-index"),
      fetch: fetchImpl as typeof fetch,
    });
    services.push(service);
    const body = `export function wideExcerpt() {\n${"x".repeat(5000)}\n}`;
    await writeFile(join(workspacePath, "wide.ts"), body, "utf8");
    await service.setEmbeddingConfig({
      workspacePath,
      provider: "openai-compatible",
      endpoint: "https://example.com/v1/embeddings",
      model: "embed-model",
    });
    await service.indexWorkspace({ workspacePath });
    const callsAfterIndex = fetchImpl.mock.calls.length;
    const found = await service.search({
      workspacePath,
      query: "wideExcerpt",
      lexicalOnly: true,
    });
    expect(fetchImpl.mock.calls.length).toBe(callsAfterIndex);
    expect(found.semantic).toBe(false);
    expect(found.results[0]?.excerpt.length).toBeGreaterThan(360);
    expect(found.results[0]?.excerptTruncated).toBe(true);
    expect(found.results[0]?.endLine).toBeGreaterThan(found.results[0]?.startLine ?? 0);
    const context = await service.getSymbolContext({ workspacePath, symbol: "wideExcerpt" });
    expect(context?.symbol.endLine).toBeGreaterThan(context?.symbol.startLine ?? 0);
    expect(context?.symbol.excerpt?.length).toBeGreaterThan(360);
  });
});
