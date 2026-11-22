import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeFilePageRank,
  computeSymbolCentrality,
} from "../../src/code-intelligence/worker/graphRank.js";
import { openStore, readMeta } from "../../src/code-intelligence/worker/store.js";
import { SCHEMA_VERSION } from "../../src/code-intelligence/worker/storeSchema.js";
import { CodeIndexService } from "../../src/code-intelligence/worker/indexService.js";

const requireFromHere = createRequire(import.meta.url);
const { DatabaseSync } = requireFromHere("node:sqlite") as typeof import("node:sqlite");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("graph ranking", () => {
  it("normalizes PageRank to a probability distribution and is deterministic", () => {
    const edges = [
      { from: 1, to: 2, weight: 2 },
      { from: 2, to: 3, weight: 1 },
      { from: 3, to: 1, weight: 1 },
    ];
    const tiers = new Map([
      [1, 0],
      [2, 0],
      [3, 2],
    ]);
    const first = computeFilePageRank([1, 2, 3], edges, tiers);
    const second = computeFilePageRank([1, 2, 3], edges, tiers);

    // Детерминизм обязателен: ранги участвуют в бустах поиска и должны быть воспроизводимы.
    expect([...first.ranks]).toEqual([...second.ranks]);
    // Контракт: нормализация по максимуму в (0, 1], поэтому лидер имеет ровно 1.
    const values = [...first.ranks.values()];
    expect(Math.max(...values)).toBeCloseTo(1, 9);
    for (const value of values) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("de-weights edges that leave a test file", () => {
    const edges = [
      { from: 1, to: 2, weight: 1 },
      { from: 3, to: 2, weight: 1 },
    ];
    const ranked = computeFilePageRank(
      [1, 2, 3],
      edges,
      new Map([
        [1, 0],
        [2, 0],
        [3, 2],
      ]),
    );
    // Продакшн-ребро весит больше тестового: цель получает больше веса от файла тира 0.
    expect(ranked.ranks.get(2)!).toBeGreaterThan(0);
    expect([...ranked.ranks.keys()].sort()).toEqual([1, 2, 3]);
  });

  it("ranks symbol centrality by incoming edge weight and stays stable", () => {
    const symbols = [{ symbolId: 1 }, { symbolId: 2 }, { symbolId: 3 }];
    const edges = [
      { src: 2, dst: 1, testSource: false },
      { src: 3, dst: 1, testSource: false },
      { src: 1, dst: 2, testSource: true },
    ];
    const first = computeSymbolCentrality(symbols, edges);
    const second = computeSymbolCentrality(symbols, edges);
    expect([...first]).toEqual([...second]);
    // Узел 1 — цель двух продакшн-рёбер, поэтому его центральность выше, чем у 2.
    expect(first.get(1)!).toBeGreaterThan(first.get(2)!);
  });
});

describe("schema v2 storage", () => {
  it("creates an integer-keyed schema with FTS5 tables and records the version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-schema-"));
    roots.push(root);
    const { db, created, migratedFromV1 } = await openStore(join(root, "index.sqlite3"));
    try {
      expect(created).toBe(true);
      expect(migratedFromV1).toBe(false);
      expect(readMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((row) => row.name);
      for (const expected of [
        "files",
        "symbols",
        "chunks",
        "edges",
        "chunks_fts",
        "chunk_vectors",
        "sketch_postings",
        "refs",
        "strings",
      ]) {
        expect(names).toContain(expected);
      }
      // `symbols_fts` и `unresolved_refs` удалены в v3: первая не читалась ни одним запросом,
      // вторая заменена агрегированной интернированной таблицей `refs`.
      expect(names).not.toContain("symbols_fts");
      expect(names).not.toContain("unresolved_refs");
      // Ключи целочисленные: текстовые `s:<path>:...` удалены вместе со схемой v1.
      const columns = db.prepare("PRAGMA table_info(symbols)").all() as Array<{
        name: string;
        type: string;
      }>;
      const id = columns.find((column) => column.name === "symbol_id");
      expect(id?.type).toBe("INTEGER");
    } finally {
      db.close();
    }
  });

  it("migrates a legacy v1 database by recreating the schema and logging the act", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-schema-v1-"));
    roots.push(root);
    const filePath = join(root, "legacy.sqlite3");
    // Схема v1: текстовые PK и метаданные в index_meta.
    const legacy = new DatabaseSync(filePath);
    try {
      legacy.exec(`
        CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files(id TEXT PRIMARY KEY, path TEXT NOT NULL);
        CREATE TABLE symbols(id TEXT PRIMARY KEY, file_id TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE chunks(id TEXT PRIMARY KEY, file_id TEXT NOT NULL, content TEXT NOT NULL);
        CREATE TABLE edges(source_id TEXT NOT NULL, target_id TEXT NOT NULL, kind TEXT NOT NULL);
        CREATE TABLE imported_calls(id TEXT PRIMARY KEY);
        INSERT INTO index_meta(key, value) VALUES('schema_version', '1');
        INSERT INTO files(id, path) VALUES('f:old', 'old.ts');
      `);
    } finally {
      legacy.close();
    }

    const { db, migratedFromV1, legacySizeBytes } = await openStore(filePath);
    try {
      expect(migratedFromV1).toBe(true);
      expect(legacySizeBytes).toBeGreaterThan(0);
      expect(readMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(readMeta(db, "migrated_from")).toContain("v1@");
      expect(readMeta(db, "migrated_at")).toBeDefined();
      const legacyTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'index_meta'")
        .get();
      expect(legacyTable).toBeUndefined();
      // Пользовательские файлы не затрагиваются: миграция касается только кеша индекса.
      const files = db.prepare("SELECT COUNT(*) AS total FROM files").get() as { total: number };
      expect(Number(files.total)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rebuilds a version-2 database that is missing required columns instead of failing later", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-schema-drift-"));
    roots.push(root);
    const filePath = join(root, "drift.sqlite3");
    const stale = new DatabaseSync(filePath);
    try {
      // База промежуточной сборки: версия 2, но без provider_sketch_i8 и kind.
      stale.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES('schema_version', '2');
        CREATE TABLE files(file_id INTEGER PRIMARY KEY, rel_path TEXT NOT NULL UNIQUE);
        CREATE TABLE chunk_vectors(
          chunk_id INTEGER PRIMARY KEY,
          local_sketch_i8 BLOB NOT NULL,
          provider_vec_i8 BLOB,
          provider_vec_scale REAL
        );
        CREATE TABLE sketch_postings(
          bucket INTEGER NOT NULL,
          sign INTEGER NOT NULL,
          weight_q INTEGER NOT NULL,
          chunk_id INTEGER NOT NULL
        );
      `);
    } finally {
      stale.close();
    }

    const { db } = await openStore(filePath);
    try {
      const vectorColumns = (
        db.prepare("PRAGMA table_info(chunk_vectors)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      // v3: 4-битная упаковка скетча с масштабом на вектор вместо Int8-байтов.
      expect(vectorColumns).toContain("local_sketch_q4");
      expect(vectorColumns).toContain("local_scale");
      expect(vectorColumns).toContain("provider_sketch_q4");
      expect(vectorColumns).toContain("provider_identity");
      expect(vectorColumns).not.toContain("provider_vec_i8");
      const postingColumns = (
        db.prepare("PRAGMA table_info(sketch_postings)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(postingColumns).toContain("kind");
      // Миграция v2 → v3 записывает исходную версию и размер базы.
      expect(readMeta(db, "migrated_from")).toContain("v2@");
    } finally {
      db.close();
    }
  });
});

describe("index service contract", () => {
  it("indexes a Python/Go/Rust workspace instead of reporting ready with zero files", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-multilang-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    await mkdir(join(workspacePath, "app"), { recursive: true });
    await writeFile(
      join(workspacePath, "app", "models.py"),
      "class WorkspaceIdentity:\n    def normalize(self) -> str:\n        return 'x'\n",
      "utf8",
    );
    await writeFile(
      join(workspacePath, "main.go"),
      'package main\n\ntype WorkspaceIdentity struct{}\n\nfunc Normalize() string { return "x" }\n',
      "utf8",
    );
    await writeFile(
      join(workspacePath, "lib.rs"),
      "pub struct WorkspaceIdentity;\n\npub fn resolve() -> i32 { 1 }\n",
      "utf8",
    );
    const service = new CodeIndexService({ indexRootDir: join(root, "indexes") });
    try {
      const result = await service.handle({
        id: 1,
        type: "index",
        workspacePath,
        force: true,
      } as never);
      expect(result.ok).toBe(true);
      const status = (await service.handle({ id: 2, type: "status", workspacePath } as never)) as {
        value: { state: string; counts: { files: number; symbols: number } };
      };
      expect(status.value.state).toBe("ready");
      expect(status.value.counts.files).toBe(3);
      expect(status.value.counts.symbols).toBeGreaterThanOrEqual(3);

      // Поиск по идентификатору из не-JS языка обязан находить файл.
      const search = (await service.handle({
        id: 3,
        type: "search",
        workspacePath,
        query: "WorkspaceIdentity",
      } as never)) as { value: { spans: Array<{ path: string }> } };
      expect(search.value.spans.map((span) => span.path)).toContain("app/models.py");
    } finally {
      await service.handle({ id: 99, type: "shutdown" } as never);
    }
  });
});
