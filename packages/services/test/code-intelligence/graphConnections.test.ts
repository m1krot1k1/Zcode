import { afterEach, describe, expect, it } from "vitest";
import { firstRow } from "../../src/code-intelligence/worker/store.js";
import { buildIndex, cleanupRoots } from "./support/buildIndex.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupRoots(roots);
});

describe("code index graph connections", () => {
  it("строит refs и межфайловые edges на tree-sitter AST", async () => {
    const { db, dispose } = await buildIndex(
      {
        "src/math.ts": [
          "export function add(a: number, b: number): number {",
          "  return a + b;",
          "}",
        ].join("\n"),
        "src/app.ts": [
          'import { add } from "./math.js";',
          "",
          "export const total = add(1, 2);",
        ].join("\n"),
      },
      roots,
    );
    try {
      // Текстовый чанкер даёт symbols, но не refs: нулевые refs/edges означают,
      // что AST-парсер не загрузился и индекс потерял связи между файлами.
      const refs = firstRow<{ value: number }>(db, "SELECT COUNT(*) AS value FROM refs");
      const edges = firstRow<{ value: number }>(
        db,
        "SELECT COUNT(*) AS value FROM edges WHERE relation <> 1",
      );
      expect(Number(refs?.value ?? 0)).toBeGreaterThan(0);
      expect(Number(edges?.value ?? 0)).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });
});
