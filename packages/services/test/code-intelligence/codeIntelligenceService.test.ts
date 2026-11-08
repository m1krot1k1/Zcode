import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeIntelligenceService } from "../../src/code-intelligence/codeIntelligenceService.js";
import { databaseFileFor } from "../../src/code-intelligence/database.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
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
