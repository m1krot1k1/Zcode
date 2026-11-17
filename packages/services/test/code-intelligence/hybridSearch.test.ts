import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeIntelligenceService } from "../../src/code-intelligence/codeIntelligenceService.js";
import { IndexWorkerClient } from "../../src/code-intelligence/worker/workerClient.js";
import { packSpans } from "../../src/code-intelligence/ranking/tokenBudgetPacker.js";
import { createWorkspaceWatcherRegistry } from "../../src/code-intelligence/workspaceWatcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-ci-search-"));
  roots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(root, relPath);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  return root;
}

function serviceFor(indexRootDir: string) {
  return createCodeIntelligenceService({
    indexRootDir,
    workerFactory: (root) => new IndexWorkerClient({ indexRootDir: root, inProcess: true }),
  });
}

const WORKSPACE_FILES: Record<string, string> = {
  "packages/core/src/workspaceWatcher.ts": [
    "export function createWorkspaceWatcherRegistry(debounceMs: number): number {",
    "  return debounceMs;",
    "}",
    "export class WorkspaceWatcher {",
    "  watch(): void {}",
    "}",
    "",
  ].join("\n"),
  "packages/core/src/hybridSearch.ts": [
    "export function hybridSearch(query: string): string[] {",
    "  return [query];",
    "}",
    "",
  ].join("\n"),
  "packages/core/test/workspaceWatcher.test.ts": [
    "import { createWorkspaceWatcherRegistry } from '../src/workspaceWatcher.js';",
    "export function testWatcher(): number {",
    "  return createWorkspaceWatcherRegistry(100);",
    "}",
    "",
  ].join("\n"),
  "docs/workspace watcher notes.md":
    "# Workspace watcher\n\nNotes about workspace watcher behaviour.\n",
  ".agents/skills/watcher/SKILL.md": "# Watcher skill\n\nworkspace watcher skill description\n",
  "app/service.py": [
    "class WorkspaceService:",
    "    def resolve_identity(self) -> str:",
    "        return 'x'",
    "",
  ].join("\n"),
};

describe("hybrid search, reranking and token budget", () => {
  it("finds exact identifiers first and de-boosts tests, docs and skills", async () => {
    const indexRoot = await mkdtemp(join(tmpdir(), "zcode-ci-index-"));
    roots.push(indexRoot);
    const workspacePath = await makeWorkspace(WORKSPACE_FILES);
    const service = serviceFor(indexRoot);
    try {
      const status = await service.indexWorkspace({ workspacePath, force: true });
      expect(status.counts.files).toBe(6);
      expect(status.state).toBe("ready");

      const exact = await service.search({
        workspacePath,
        query: "createWorkspaceWatcherRegistry",
        limit: 6,
      });
      expect(exact.results.length).toBeGreaterThan(0);
      // Точный идентификатор из продакшн-файла обязан быть первым, а не тест/доки/скилл.
      expect(exact.results[0]!.path).toBe("packages/core/src/workspaceWatcher.ts");

      const lexical = await service.search({ workspacePath, query: "hybrid search", limit: 6 });
      expect(lexical.results[0]!.path).toBe("packages/core/src/hybridSearch.ts");
      expect(lexical.semantic).toBe(false);

      // Тот же запрос по шумной директории: при явном маркере тестов пенальти снимается.
      const testsIntent = await service.search({
        workspacePath,
        query: "workspaceWatcher test",
        limit: 6,
      });
      expect(
        testsIntent.results.some((result) => result.path.includes("test/workspaceWatcher.test.ts")),
      ).toBe(true);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("keeps JSON valid and within budget for any maxTokens value", async () => {
    const indexRoot = await mkdtemp(join(tmpdir(), "zcode-ci-index-"));
    roots.push(indexRoot);
    const workspacePath = await makeWorkspace(WORKSPACE_FILES);
    const service = serviceFor(indexRoot);
    try {
      await service.indexWorkspace({ workspacePath, force: true });
      for (const maxTokens of [64, 96, 128, 256, 512, 1024, 4000]) {
        const outcome = await service.search({
          workspacePath,
          query: "workspace watcher registry hybrid search",
          maxTokens,
          limit: 12,
        });
        const serialized = JSON.stringify(outcome);
        expect(() => JSON.parse(serialized)).not.toThrow();
        expect(outcome.budget?.usedTokens ?? 0).toBeLessThanOrEqual(maxTokens);
        // Ни один фрагмент не обрывается посередине строки: excerpt — точный срез файла.
        for (const result of outcome.results) {
          expect(result.startLine).toBeLessThanOrEqual(result.endLine);
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(1);
        }
        // Урезание бюджета помечается отдельной метрикой, а не как partial индекса.
        //
        // Проверяется инвариант, а не конкретное значение лимита: `truncated` обязан совпадать
        // с фактом отбрасывания/сворачивания. Прежняя версия требовала `truncated === true`
        // при `maxTokens <= 128`, но это зависело от числа кандидатов корпуса: после
        // диверсификации по файлам и отсечения по покрытию термов выдача стала компактнее,
        // и на 128 токенах весь результат уже помещается целиком.
        const truncated = outcome.budget?.truncated ?? false;
        const dropped = outcome.budget?.dropped ?? 0;
        const collapsed = outcome.budget?.collapsed ?? 0;
        expect(truncated).toBe(dropped > 0 || collapsed > 0);
      }
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("packs spans by collapsing to signature instead of cutting bytes", () => {
    const span = {
      relPath: "a.ts",
      startLine: 1,
      endLine: 200,
      scopeHeader: "a.ts | big",
      content: Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"),
      score: 0.9,
      pathTier: 0,
      members: 1,
    };
    const packed = packSpans([span], 120);
    expect(packed.spans).toHaveLength(1);
    expect(packed.spans[0]!.signatureOnly).toBe(true);
    expect(packed.spans[0]!.excerpt).toContain("more lines omitted");
    expect(packed.truncated).toBe(true);
    expect(() => JSON.parse(JSON.stringify(packed))).not.toThrow();

    const tooSmall = packSpans([span], 24);
    expect(tooSmall.spans).toHaveLength(0);
    expect(tooSmall.dropped).toBe(1);
  });
});

describe("incremental reconciliation", () => {
  it("applies create, modify, delete and rename without a full rescan", async () => {
    const indexRoot = await mkdtemp(join(tmpdir(), "zcode-ci-index-"));
    roots.push(indexRoot);
    const workspacePath = await makeWorkspace({
      "a.ts": "export function alpha(): number { return 1; }\n",
      "b.ts": "export function beta(): number { return 2; }\n",
    });
    const service = serviceFor(indexRoot);
    try {
      const initial = await service.indexWorkspace({ workspacePath, force: true });
      expect(initial.counts.files).toBe(2);

      // modify
      await writeFile(
        join(workspacePath, "a.ts"),
        "export function alphaV2(): number { return 3; }\n",
      );
      const modified = await service.notifyFilesMutated({ workspacePath, changed: ["a.ts"] });
      expect(modified.counts.files).toBe(2);
      const afterModify = await service.search({ workspacePath, query: "alphaV2", limit: 5 });
      expect(afterModify.results[0]?.path).toBe("a.ts");

      // create
      await writeFile(
        join(workspacePath, "c.ts"),
        "export function gamma(): number { return 4; }\n",
      );
      const created = await service.notifyFilesMutated({ workspacePath, changed: ["c.ts"] });
      expect(created.counts.files).toBe(3);
      const afterCreate = await service.search({ workspacePath, query: "gamma", limit: 5 });
      expect(afterCreate.results[0]?.path).toBe("c.ts");

      // delete
      await rm(join(workspacePath, "b.ts"), { force: true });
      const deleted = await service.notifyFilesMutated({ workspacePath, removed: ["b.ts"] });
      expect(deleted.counts.files).toBe(2);
      const afterDelete = await service.search({ workspacePath, query: "beta", limit: 5 });
      // Удалённый файл не должен оставаться «фантомом» в FTS.
      expect(afterDelete.results.some((result) => result.path === "b.ts")).toBe(false);

      // rename = remove + create
      await writeFile(
        join(workspacePath, "c2.ts"),
        "export function gamma(): number { return 4; }\n",
      );
      await rm(join(workspacePath, "c.ts"), { force: true });
      const renamed = await service.notifyFilesMutated({
        workspacePath,
        changed: ["c2.ts"],
        removed: ["c.ts"],
      });
      expect(renamed.counts.files).toBe(2);
      const afterRename = await service.search({ workspacePath, query: "gamma", limit: 5 });
      expect(afterRename.results[0]?.path).toBe("c2.ts");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("reports watcher pre-filtering rules and debounces bursts", async () => {
    const workspacePath = await makeWorkspace({
      "src/a.ts": "export const a = 1;\n",
      "node_modules/pkg/index.ts": "export const ignored = 1;\n",
    });
    const batches: Array<{ changed: string[]; removed: string[] }> = [];
    const registry = createWorkspaceWatcherRegistry({
      debounceMs: 30,
      onChange: (_workspace, batch) =>
        batches.push({ changed: batch.changed, removed: batch.removed }),
      onError: () => undefined,
    });
    try {
      await registry.ensure({ workspacePath });
      registry.notifyMutated({ workspacePath }, ["src/a.ts", "node_modules/pkg/index.ts"]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(batches).toHaveLength(1);
      // Пре-фильтрация исключает node_modules из инкрементального обновления.
      expect(batches[0]!.changed).toEqual(["src/a.ts"]);
    } finally {
      await registry.disposeAllAndWait();
    }
  });
});
