import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeIntelligenceService } from "../../src/code-intelligence/codeIntelligenceService.js";

const tempRoots: string[] = [];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-code-index-"));
  tempRoots.push(root);
  const workspacePath = join(root, "workspace");
  const indexRootDir = join(root, "index");
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeFile(join(workspacePath, ".gitignore"), "ignored.ts\n", "utf8");
  await writeFile(
    join(workspacePath, "src", "orders.ts"),
    "export function fetchOrders() { return []; }\n",
    "utf8",
  );
  await writeFile(
    join(workspacePath, "src", "consumer.ts"),
    'import { fetchOrders } from "./orders";\nexport function load() { return fetchOrders(); }\n',
    "utf8",
  );
  await writeFile(join(workspacePath, "ignored.ts"), "export function hiddenNeedle() {}\n", "utf8");
  const service = createCodeIntelligenceService({ indexRootDir });
  return { root, workspacePath, indexRootDir, service };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("code intelligence local index", () => {
  it("indexes ignore-aware JS/TS symbols and local import edges, then supports search, impact and trace", async () => {
    const { workspacePath, service } = await createFixture();
    const status = await service.indexWorkspace({ workspacePath });
    expect(status.state).toBe("ready");
    expect(status.generation).toBe(1);
    expect(status.counts.files).toBe(2);
    expect(status.counts.edges).toBeGreaterThan(0);

    const search = await service.search({ workspacePath, query: "fetchOrders" });
    expect(search.results.some((result) => result.symbolName === "fetchOrders")).toBe(true);
    expect((await service.search({ workspacePath, query: "hiddenNeedle" })).results).toEqual([]);

    const context = await service.getSymbolContext({ workspacePath, symbol: "src/consumer.ts" });
    expect(context?.dependencies.some((item) => item.path === "src/orders.ts")).toBe(true);
    const impact = await service.getImpact({ workspacePath, changedPaths: ["src/orders.ts"] });
    expect(impact.affectedSymbols.some((item) => item.path === "src/consumer.ts")).toBe(true);
    const trace = await service.trace({
      workspacePath,
      fromSymbol: "src/consumer.ts",
      toSymbol: "src/orders.ts",
    });
    expect(trace.found).toBe(true);
    expect(trace.path.map((item) => item.path)).toEqual(["src/consumer.ts", "src/orders.ts"]);
  });

  it("preserves inbound module links when an imported file changes", async () => {
    const { workspacePath, service } = await createFixture();
    await service.indexWorkspace({ workspacePath });
    const before = await service.getSymbolContext({ workspacePath, symbol: "src/consumer.ts" });
    expect(before?.dependencies.some((item) => item.path === "src/orders.ts")).toBe(true);

    await writeFile(
      join(workspacePath, "src", "orders.ts"),
      "export function fetchOrders() { return [{ id: 1 }]; }\n",
      "utf8",
    );
    await service.indexWorkspace({ workspacePath });

    const after = await service.getSymbolContext({ workspacePath, symbol: "src/consumer.ts" });
    const trace = await service.trace({
      workspacePath,
      fromSymbol: "src/consumer.ts",
      toSymbol: "src/orders.ts",
    });
    expect(after?.dependencies.some((item) => item.path === "src/orders.ts")).toBe(true);
    expect(trace.found).toBe(true);
  });

  it("stores local embeddings and only requests vectors for changed files", async () => {
    const { workspacePath } = await createFixture();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const embeddedService = createCodeIntelligenceService({
      indexRootDir: join(workspacePath, ".test-index"),
      fetch: fetchMock,
    });
    await embeddedService.setEmbeddingConfig({
      workspacePath,
      endpoint: "http://127.0.0.1:11434/api/embed",
      model: "nomic-embed-text",
    });
    const first = await embeddedService.indexWorkspace({ workspacePath });
    expect(first.embedding.available).toBe(true);
    const requestsAfterFirstIndex = fetchMock.mock.calls.length;
    const second = await embeddedService.indexWorkspace({ workspacePath });
    expect(second.generation).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterFirstIndex);

    const semantic = await embeddedService.search({ workspacePath, query: "find order logic" });
    expect(semantic.semantic).toBe(true);
    expect(semantic.results.some((item) => item.match === "semantic")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(requestsAfterFirstIndex + 1);
  });

  it("preserves omitted embedding settings and rebuilds vectors after a model change", async () => {
    const { workspacePath, root } = await createFixture();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
      const vector = body.model === "model-two" ? [0, 1, 0] : [1, 0, 0];
      return new Response(JSON.stringify({ embeddings: body.input.map(() => vector) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const service = createCodeIntelligenceService({
      indexRootDir: join(root, "persistent-index"),
      fetch: fetchMock,
    });
    await service.setEmbeddingConfig({
      workspacePath,
      endpoint: "http://127.0.0.1:11434/api/embed",
      model: "model-one",
    });
    await service.indexWorkspace({ workspacePath });
    const firstCount = fetchMock.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    await service.setEmbeddingConfig({ workspacePath });
    const preserved = await service.getStatus({ workspacePath });
    expect(preserved.embedding.configured).toBe(true);
    expect(preserved.embedding.endpoint).toBe("http://127.0.0.1:11434/api/embed");
    expect(preserved.embedding.model).toBe("model-one");

    await service.setEmbeddingConfig({ workspacePath, model: "model-two" });
    expect((await service.getStatus({ workspacePath })).embedding.available).toBe(false);
    const rebuilt = await service.indexWorkspace({ workspacePath });
    expect(rebuilt.embedding.available).toBe(true);
    expect(rebuilt.embedding.model).toBe("model-two");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(firstCount);
    await expect(
      service.setEmbeddingConfig({ workspacePath, endpoint: "", model: "" }),
    ).rejects.toThrow(/both local/i);
    expect((await service.getStatus({ workspacePath })).embedding.model).toBe("model-two");

    const cleared = await service.setEmbeddingConfig({
      workspacePath,
      endpoint: null,
      model: null,
    });
    expect(cleared.embedding.configured).toBe(false);
    expect(cleared.embedding.available).toBe(false);
  });

  it("rejects remote embedding endpoints and keeps the last committed generation on scan failure", async () => {
    const { workspacePath, service } = await createFixture();
    const initial = await service.indexWorkspace({ workspacePath });
    await expect(
      service.setEmbeddingConfig({
        workspacePath,
        endpoint: "https://example.com/embed",
        model: "model",
      }),
    ).rejects.toThrow(/loopback/i);

    await rm(workspacePath, { recursive: true, force: true });
    const failed = await service.indexWorkspace({ workspacePath });
    expect(failed.state).toBe("degraded");
    expect(failed.generation).toBe(initial.generation);
    expect(failed.counts.files).toBe(initial.counts.files);
  });

  it("separates index files by workspace identity and clears one identity only", async () => {
    const { workspacePath, service, indexRootDir } = await createFixture();
    await service.indexWorkspace({ workspacePath, workspaceIdentity: "remote-workspace-a" });
    await service.indexWorkspace({ workspacePath, workspaceIdentity: "remote-workspace-b" });
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(indexRootDir));
    expect(files.filter((file) => file.endsWith(".sqlite3"))).toHaveLength(2);
    await service.clearIndex({ workspacePath, workspaceIdentity: "remote-workspace-a" });
    expect(
      (await service.getStatus({ workspacePath, workspaceIdentity: "remote-workspace-a" })).state,
    ).toBe("unindexed");
    expect(
      (await service.getStatus({ workspacePath, workspaceIdentity: "remote-workspace-b" })).state,
    ).toBe("ready");
  });

  it("does not expose absolute workspace paths or source contents in status", async () => {
    const { workspacePath, service } = await createFixture();
    await service.indexWorkspace({ workspacePath });
    const status = await service.getStatus({ workspacePath });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(workspacePath);
    expect(serialized).not.toContain("fetchOrders");
  });
});
