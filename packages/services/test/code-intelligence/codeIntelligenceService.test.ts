import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeIntelligenceService } from "../../src/code-intelligence/codeIntelligenceService.js";
import { databaseFileFor } from "../../src/code-intelligence/database.js";

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
        expect.objectContaining({ name: "testEmbeddingConfig", path: "src/codeIntelligenceService.ts" }),
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
        expect.objectContaining({ name: "testEmbeddingConfig", path: "src/codeIntelligenceService.ts" }),
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
    for (let i = 0; i < 100; i += 1) {
      if (
        (
          await service.search({
            workspacePath,
            workspaceIdentity: "stable-id",
            query: "afterChange",
          })
        ).results.length
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
    for (
      let i = 0;
      i < 100 &&
      (await service.getStatus({ workspacePath: movedRoot, workspaceIdentity: "stable-id" })).counts
        .files;
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await service.getStatus({ workspacePath: movedRoot, workspaceIdentity: "stable-id" })).counts
        .files,
    ).toBe(0);
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
