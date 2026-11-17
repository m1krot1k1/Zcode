import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { buildIndex } from "./support/buildIndex.js";
import { hybridSearch } from "../../src/code-intelligence/ranking/hybridSearch.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FILES: Record<string, string> = {
  "src/parser.ts": [
    "export function parseWorkspaceIdentity(raw: string): string {",
    "  return raw.trim().toLowerCase();",
    "}",
  ].join("\n"),
  "src/storage.ts": [
    "export function persistWorkspaceIdentity(identity: string): boolean {",
    "  return identity.length > 0;",
    "}",
  ].join("\n"),
  "src/telemetry.ts": [
    "export function emitMetricsBucket(bucket: string, value: number): void {",
    "  void bucket;",
    "  void value;",
    "}",
  ].join("\n"),
  "test/parser.test.ts": [
    "export function parserTestFixture(): string {",
    "  return 'fixture';",
    "}",
  ].join("\n"),
  ".agents/skills/docs/SKILL.md": "# Identity skill\n\nworkspace identity documentation\n",
};

describe("hybrid search channels and fusion", () => {
  it("prefers the exact identifier over lexical neighbours and de-boosts noisy paths", async () => {
    const { db, dispose } = await buildIndex(FILES, roots);
    try {
      const exact = await hybridSearch(db, { query: "parseWorkspaceIdentity", maxTokens: 4000 });
      expect(exact.spans[0]?.path).toBe("src/parser.ts");
      expect(exact.channels.exact).toBe(true);

      // Явный маркер `test` снимает пенальти тира: тестовый файл становится доступным.
      const withIntent = await hybridSearch(db, {
        query: "parserTestFixture test",
        maxTokens: 4000,
      });
      expect(withIntent.spans.some((span) => span.path === "test/parser.test.ts")).toBe(true);
    } finally {
      dispose();
    }
  });

  it("finds a lexical match when the query does not name a symbol", async () => {
    const { db, dispose } = await buildIndex(FILES, roots);
    try {
      const lexical = await hybridSearch(db, { query: "metrics bucket", maxTokens: 4000 });
      expect(lexical.channels.fts).toBe(true);
      expect(lexical.spans[0]?.path).toBe("src/telemetry.ts");
    } finally {
      dispose();
    }
  });

  it("merges channels with RRF so an exact hit outranks a purely vector-similar chunk", async () => {
    const { db, dispose } = await buildIndex(FILES, roots);
    try {
      const outcome = await hybridSearch(db, {
        query: "persistWorkspaceIdentity",
        maxTokens: 4000,
      });
      expect(outcome.candidateCount).toBeGreaterThan(0);
      // Точное имя символа даёт самый высокий вклад в RRF: файл-цель обязан быть первым.
      expect(outcome.spans[0]?.path).toBe("src/storage.ts");
      expect(outcome.mergedSpans).toBeGreaterThanOrEqual(1);
    } finally {
      dispose();
    }
  });

  it("keeps the response inside the token budget and never returns invalid JSON", async () => {
    const { db, dispose } = await buildIndex(FILES, roots);
    try {
      for (const maxTokens of [32, 48, 64, 128, 512, 4000]) {
        const outcome = await hybridSearch(db, {
          query: "workspace identity parse persist telemetry",
          maxTokens,
        });
        const serialized = JSON.stringify(outcome);
        expect(() => JSON.parse(serialized)).not.toThrow();
        expect(outcome.usedTokens).toBeLessThanOrEqual(Math.max(1, maxTokens));
        // Побайтовая обрезка запрещена: каждый фрагмент — целый срез или сигнатура.
        for (const span of outcome.spans) {
          expect(span.startLine).toBeLessThanOrEqual(span.endLine);
          expect(span.excerpt.length).toBeGreaterThan(0);
        }
        expect(outcome.budgetTokens).toBe(Math.max(1, maxTokens));
      }
    } finally {
      dispose();
    }
  });

  it("drops results with an explicit flag when the budget cannot fit even one signature", async () => {
    const { db, dispose } = await buildIndex(FILES, roots);
    try {
      const tiny = await hybridSearch(db, { query: "parseWorkspaceIdentity", maxTokens: 1 });
      expect(tiny.spans).toHaveLength(0);
      expect(tiny.truncated).toBe(true);
      expect(tiny.dropped).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  it("boosts the file that is active in the editor without changing the query semantics", async () => {
    const { db, dispose } = await buildIndex(FILES, roots);
    try {
      const plain = await hybridSearch(db, { query: "workspace identity", maxTokens: 4000 });
      const boosted = await hybridSearch(db, {
        query: "workspace identity",
        maxTokens: 4000,
        activeFiles: ["src/storage.ts"],
      });
      const plainIndex = plain.spans.findIndex((span) => span.path === "src/storage.ts");
      const boostedIndex = boosted.spans.findIndex((span) => span.path === "src/storage.ts");
      expect(boostedIndex).toBeGreaterThanOrEqual(0);
      expect(boostedIndex).toBeLessThanOrEqual(
        plainIndex === -1 ? Number.MAX_SAFE_INTEGER : plainIndex,
      );
    } finally {
      dispose();
    }
  });
});
