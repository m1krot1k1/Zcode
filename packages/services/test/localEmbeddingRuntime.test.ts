import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalEmbeddingRuntime } from "../src/code-intelligence/localEmbeddingRuntime.js";

function runtime(totalMemoryBytes: number, platform: NodeJS.Platform = "darwin") {
  return createLocalEmbeddingRuntime({
    toolsRoot: "/tmp/zcode-local-embeddings-test",
    platform,
    arch: "arm64",
    allowSystemBinary: false,
    totalMemoryBytes: () => totalMemoryBytes,
    fetch: async () => new Response("not running", { status: 503 }),
  });
}

describe("local embedding runtime", () => {
  it("recommends the compact model on an 8 GB machine", async () => {
    const status = await runtime(8 * 1024 ** 3).getStatus();
    expect(status).toMatchObject({
      runtime: "ollama",
      installed: false,
      recommended: { model: "nomic-embed-text", dimensions: 768 },
    });
  });

  it("recommends the multilingual model on a 16 GB machine", async () => {
    const status = await runtime(16 * 1024 ** 3).getStatus();
    expect(status.recommended.model).toBe("bge-m3");
    expect(status.recommended.dimensions).toBe(1024);
  });

  it("reports unsupported platforms instead of guessing an archive", async () => {
    const result = await runtime(16 * 1024 ** 3, "freebsd").install();
    expect(result).toMatchObject({ status: "failed" });
    if (result.status === "failed") {
      expect(result.diagnostic).toContain("local-embedding-runtime-unsupported");
    }
  });

  it("rejects unsafe model names before spawning the runtime", async () => {
    const result = await runtime(16 * 1024 ** 3).pull("../../etc/passwd");
    expect(result).toEqual({
      status: "failed",
      model: "../../etc/passwd",
      diagnostic: "invalid-model-name",
    });
  });
});

describe("local model manifests", () => {
  it("lists downloaded models while the runtime is stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-local-manifests-"));
    try {
      const manifest = join(root, "models/manifests/registry.ollama.ai/library/qwen2.5/1.5b");
      await mkdir(join(manifest, ".."), { recursive: true });
      await writeFile(manifest, "{}");
      const runtime = createLocalEmbeddingRuntime({
        toolsRoot: root,
        platform: "darwin",
        arch: "arm64",
        allowSystemBinary: false,
        fetch: async () => new Response("not running", { status: 503 }),
      });
      const status = await runtime.getStatus();
      expect(status.running).toBe(false);
      expect(status.models).toEqual([{ id: "qwen2.5:1.5b" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
