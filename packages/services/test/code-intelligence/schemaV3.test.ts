import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, readMeta } from "../../src/code-intelligence/worker/store.js";
import { SCHEMA_VERSION } from "../../src/code-intelligence/worker/storeSchema.js";
import {
  packText,
  packFileChunks,
  chunkTextAt,
  textOf,
} from "../../src/code-intelligence/worker/chunkContent.js";
import {
  LOCAL_SKETCH_DIM,
  quantizeSketch,
  quantizeSketchQ4,
  sketchCosine,
  sketchCosineQ4,
  sketchOfText,
} from "../../src/code-intelligence/ranking/localSketch.js";

const requireFromHere = createRequire(import.meta.url);
const { DatabaseSync } = requireFromHere("node:sqlite") as typeof import("node:sqlite");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("schema v3 migration", () => {
  it("recreates a v2 database explicitly and records the source version", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-schema-v2-"));
    roots.push(root);
    const filePath = join(root, "v2.sqlite3");
    // Минимальная база v2: только таблицы, по которым вычисляется дрейф (версия и колонки).
    const legacy = new DatabaseSync(filePath);
    try {
      // PRAGMA нельзя смешивать с DDL в одном `exec`: он возвращает значение, и SQLite
      // разбирает остаток как продолжение выражения.
      legacy.exec("PRAGMA page_size = 4096");
      legacy.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta(key, value) VALUES('schema_version', '2');
        CREATE TABLE files(file_id INTEGER PRIMARY KEY, rel_path TEXT NOT NULL UNIQUE);
        CREATE TABLE chunks(
          chunk_id INTEGER PRIMARY KEY,
          file_id INTEGER NOT NULL,
          content BLOB,
          scope_header TEXT
        );
        CREATE TABLE chunk_vectors(
          chunk_id INTEGER PRIMARY KEY,
          local_sketch_i8 BLOB NOT NULL
        );
        CREATE TABLE symbols_fts(name_tokens);
        CREATE TABLE unresolved_refs(src_file_id INTEGER, target_name TEXT);
        INSERT INTO files(file_id, rel_path) VALUES(1, 'old.ts');
      `);
    } finally {
      legacy.close();
    }

    const { db, migratedFromV1 } = await openStore(filePath);
    try {
      // Запись миграции: явная фиксация версии-источника, а не молчаливое удаление.
      expect(readMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
      expect(readMeta(db, "migrated_from")).toContain("v2@");
      expect(readMeta(db, "migrated_at")).toBeDefined();
      // `v1` не участвовал: флаг отражает только переход со схемы v1.
      expect(migratedFromV1).toBe(false);

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(tables).not.toContain("symbols_fts");
      expect(tables).not.toContain("unresolved_refs");
      expect(tables).toContain("refs");
      expect(tables).toContain("strings");

      // page_size применяется через VACUUM во время миграции.
      const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };
      expect(Number(pageSize.page_size)).toBe(8192);
      // Старые данные удалены: индекс переиндексируется в фоне, пользовательские файлы целы.
      const files = db.prepare("SELECT COUNT(*) AS total FROM files").get() as { total: number };
      expect(Number(files.total)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps a v3 database intact when reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-schema-v3-"));
    roots.push(root);
    const filePath = join(root, "v3.sqlite3");
    const first = await openStore(filePath);
    first.db.close();

    const second = await openStore(filePath);
    try {
      expect(readMeta(second.db, "schema_version")).toBe(String(SCHEMA_VERSION));
      // Повторное открытие актуальной схемы не должно писать migration-запись.
      expect(readMeta(second.db, "migrated_from")).toBeUndefined();
    } finally {
      second.db.close();
    }
  });
});

describe("4-bit sketch quantization", () => {
  it("packs 256 dimensions into 128 bytes with a per-vector scale", () => {
    const sketch = sketchOfText("workspace watcher reconciles nested edits");
    const packed = quantizeSketchQ4(sketch);
    expect(packed.bytes.byteLength).toBe(Math.ceil(LOCAL_SKETCH_DIM / 2));
    expect(packed.scale).toBeGreaterThan(0);
    expect(packed.scale).toBeLessThanOrEqual(1);
  });

  it("keeps cosine ranking close to the Int8 baseline", () => {
    const query = sketchOfText("workspace watcher");
    const queryI8 = quantizeSketch(query);
    const documents = [
      "workspace watcher reconciles nested edits and debounces bursts",
      "the token budget packer collapses spans by signature",
      "sqlite migration drops legacy tables and records the source version",
    ];
    const int8Scores = documents.map((text) =>
      sketchCosine(queryI8, quantizeSketch(sketchOfText(text))),
    );
    const q4Scores = documents.map((text) => {
      const packed = quantizeSketchQ4(sketchOfText(text));
      return sketchCosineQ4(queryI8, packed.bytes, packed.scale);
    });

    // Порядок документов обязан совпасть: квантизация меняет значения, но не ранжирование.
    const orderOf = (scores: number[]): number[] =>
      scores
        .map((score, index) => ({ score, index }))
        .sort((a, b) => b.score - a.score)
        .map((item) => item.index);
    expect(orderOf(q4Scores)).toEqual(orderOf(int8Scores));

    // Замер на корпусе: средняя |Δ| была 0.0015 для i8 и 0.0079 для q4, то есть
    // расхождение остаётся в пределах одного шага квантизации.
    for (let index = 0; index < documents.length; index += 1) {
      expect(Math.abs((q4Scores[index] ?? 0) - (int8Scores[index] ?? 0))).toBeLessThan(0.05);
    }
  });
});

describe("chunk text packing", () => {
  it("round-trips short text without compression overhead", () => {
    const short = "const a = 1;";
    const packed = packText(short);
    // Формат с меткой: 0x00 — несжатый UTF-8, иначе deflate добавлял бы заголовок потока
    // к каждой 47-символьной сигнатуре и делал хранение дороже исходного текста.
    expect(packed[0]).toBe(0);
    expect(textOf(packed)).toBe(short);
  });

  it("round-trips long text through deflate", () => {
    const long = "export function handler(input: Input): Output {\n".repeat(40);
    const packed = packText(long);
    expect(packed[0]).toBe(1);
    expect(textOf(packed)).toBe(long);
    expect(packed.byteLength).toBeLessThan(Buffer.byteLength(long, "utf8"));
  });

  it("returns the requested chunk by index and rejects out-of-range indexes", () => {
    const contents = ["first chunk", "second chunk", "third chunk"];
    const blob = packFileChunks(contents);
    expect(chunkTextAt(blob, 0)).toBe("first chunk");
    expect(chunkTextAt(blob, 2)).toBe("third chunk");
    // Строгий контракт: индекс вне диапазона не должен подставлять соседний чанк.
    expect(chunkTextAt(blob, 3)).toBe("");
    expect(chunkTextAt(blob, -1)).toBe("");
  });

  it("returns an empty string for a corrupted blob instead of throwing", () => {
    expect(chunkTextAt(new Uint8Array([1, 2, 3, 4]), 0)).toBe("");
  });
});
