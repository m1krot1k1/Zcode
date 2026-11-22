import { afterEach, describe, expect, it } from "vitest";
import { deleteFileFacts, findFileId } from "../../src/code-intelligence/worker/indexWriter.js";
import { buildIndex, cleanupRoots } from "./support/buildIndex.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupRoots(roots);
});

describe("deleteFileFacts", () => {
  it("удаляет факты при last_insert_rowid больше Number.MAX_SAFE_INTEGER", async () => {
    const { db, dispose } = await buildIndex({ "a.ts": "export const value = 1;\n" }, roots);
    try {
      const fileId = findFileId(db, "a.ts");
      expect(fileId).toBeTypeOf("number");
      // Bug 原因：FTS5 删除内部事项会把连接级 last_insert_rowid 写成 64 位大数；
      // node:sqlite 的 run() 在构造 RunResult 时抛 ERR_OUT_OF_RANGE。这里显式复现
      // 该状态，确保删除路径不依赖 run() 的返回值。
      db.exec("CREATE TEMP TABLE rowid_probe(id INTEGER PRIMARY KEY)");
      db.exec("INSERT INTO rowid_probe(id) VALUES(9007336693694464)");

      expect(() => deleteFileFacts(db, fileId!)).not.toThrow();
      expect(db.prepare("SELECT count(*) AS count FROM files").get()).toEqual({ count: 0 });
    } finally {
      dispose();
    }
  });
});
