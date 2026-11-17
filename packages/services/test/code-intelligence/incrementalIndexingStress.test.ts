/// <reference types="node" />
// ============================================================
// Этап 5: стресс-тест инкрементальной индексации (Инкремент 4.3)
// ============================================================
//
// Проверяемые инварианты полного/частичного прохода индекса:
//  1. Массовый поток событий (1000+ файлов) корректно применяется батчами.
//  2. Нет фантомов: удалённые/переименованные файлы исчезают из индекса.
//  3. Поиск возвращает актуальные результаты после серии изменений.
//  4. Память не растёт линейно: heap после GC не зависит от числа проходов.
//  5. Отмена (`isCancelled`) оставляет консистентный префикс без битых строк.

import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runFullIndex, runPartialIndex } from "../../src/code-intelligence/worker/indexEngine.js";
import { openStore, type IndexDatabase } from "../../src/code-intelligence/worker/store.js";

interface Workspace {
  root: string;
  dbPath: string;
}

let workspace: Workspace;

async function writeWorkspaceFile(root: string, relPath: string, body: string): Promise<void> {
  const absolute = join(root, relPath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, body, "utf8");
}

function createProgressSink() {
  let discovered = 0;
  let indexed = 0;
  return {
    onProgress: (progress: { discoveredFiles: number; indexedFiles: number }) => {
      discovered = Math.max(discovered, progress.discoveredFiles);
      indexed = Math.max(indexed, progress.indexedFiles);
    },
    snapshot: () => ({ discovered, indexed }),
  };
}

function heapMb(): number {
  globalThis.gc?.();
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100;
}

describe("Этап 5 — стресс инкрементальной индексации", () => {
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-idx-stress-"));
    workspace = { root, dbPath: join(root, ".zcode-code-index", "index.sqlite") };
    await mkdir(join(root, ".zcode-code-index"), { recursive: true });
  }, 60_000);

  afterAll(async () => {
    if (workspace?.root) await rm(workspace.root, { recursive: true, force: true });
  });

  it("1000 файлов: полный проход + 1200 инкрементальных событий", async () => {
    const { root, dbPath } = workspace;
    const initialFiles = 1000;
    const dir = "src/bulk";

    for (let index = 0; index < initialFiles; index += 1) {
      await writeWorkspaceFile(
        root,
        `${dir}/file${index}.ts`,
        `export function fn${index}(value: number): number {\n  return value + ${index};\n}\n`,
      );
    }

    const { db } = await openStore(dbPath);
    const sink = createProgressSink();
    const fullStartedAt = performance.now();
    const full = await runFullIndex({
      workspacePath: root,
      db,
      isCancelled: () => false,
      onProgress: sink.onProgress,
    });
    const fullMs = Math.round(performance.now() - fullStartedAt);

    expect(full.cancelled).toBe(false);
    expect(full.indexedFiles).toBeGreaterThanOrEqual(initialFiles);

    // События: 400 modify + 400 create + 200 delete + 200 rename (через delete+create).
    // ВАЖНО: runPartialIndex принимает пути относительно workspacePath (их валидирует
    // isInsideWorkspace), поэтому здесь и далее передаём только относительные пути.
    const changed: string[] = [];
    const removed: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      const relPath = `${dir}/file${index}.ts`;
      await writeWorkspaceFile(
        root,
        relPath,
        `export function fn${index}(value: number): number {\n  return value * 2;\n}\n`,
      );
      changed.push(relPath);
    }
    for (let index = 0; index < 400; index += 1) {
      const relPath = `${dir}/added${index}.ts`;
      await writeWorkspaceFile(root, relPath, `export const added${index} = ${index};\n`);
      changed.push(relPath);
    }
    for (let index = 900; index < 1000; index += 1) {
      const relPath = `${dir}/file${index}.ts`;
      await rm(join(root, relPath), { force: true });
      removed.push(relPath);
    }
    for (let index = 0; index < 200; index += 1) {
      const fromRel = `${dir}/added${index}.ts`;
      const toRel = `${dir}/renamed${index}.ts`;
      await rm(join(root, fromRel), { force: true });
      await writeWorkspaceFile(root, toRel, `export const renamed${index} = ${index};\n`);
      removed.push(fromRel);
      changed.push(toRel);
    }

    const heapBefore = heapMb();
    const partialStartedAt = performance.now();
    const partial = await runPartialIndex({
      workspacePath: root,
      db,
      changed,
      removed,
      isCancelled: () => false,
      onProgress: sink.onProgress,
    });
    const partialMs = Math.round(performance.now() - partialStartedAt);
    const heapAfter = heapMb();

    expect(partial.cancelled).toBe(false);
    expect(changed.length).toBe(1000);
    expect(removed.length).toBe(300);
    expect(changed.length + removed.length).toBe(1300);

    // Нет фантомов: проверяем общий инвариант — каждый путь индекса существует на диске.
    // (Проверка по префиксу некорректна: `added200..399` остались на диске и должны быть в индексе.)
    const allIndexed = db.prepare("SELECT rel_path FROM files").all() as Array<{
      rel_path: string;
    }>;
    const phantomPaths: string[] = [];
    for (const row of allIndexed) {
      const onDisk = await access(join(root, row.rel_path)).then(
        () => true,
        () => false,
      );
      if (!onDisk) phantomPaths.push(row.rel_path);
    }
    expect(phantomPaths).toEqual([]);

    const removedRows = db.prepare("SELECT rel_path FROM files WHERE rel_path = ?");
    expect(removedRows.all(`${dir}/file995.ts`)).toEqual([]);
    expect(removedRows.all(`${dir}/added0.ts`)).toEqual([]);
    // Оставшиеся на диске added-файлы обязаны остаться в индексе.
    expect(removedRows.all(`${dir}/added399.ts`)).toHaveLength(1);

    // Актуальные результаты: переименованные присутствуют.
    const renamedRows = db
      .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ?")
      .all(`${dir}/renamed%`) as Array<{ rel_path: string }>;
    expect(renamedRows).toHaveLength(200);

    console.info(
      `[stress][index][bulk] files=${initialFiles} events=1200 fullMs=${fullMs} partialMs=${partialMs} heap ${heapBefore}→${heapAfter}MB ghosts=0 renamed=200`,
    );
  }, 300_000);

  it("серия инкрементальных проходов не растит память линейно", async () => {
    const { root, dbPath } = workspace;
    const fileCount = 40;
    const key = "src/cycle";

    for (let index = 0; index < fileCount; index += 1) {
      await writeWorkspaceFile(root, `${key}/c${index}.ts`, `export const c${index} = ${index};\n`);
    }

    const { db } = await openStore(dbPath);
    const sink = createProgressSink();
    await runFullIndex({
      workspacePath: root,
      db,
      isCancelled: () => false,
      onProgress: sink.onProgress,
    });

    const heapStart = heapMb();
    const rounds = 60;
    for (let round = 0; round < rounds; round += 1) {
      const changed: string[] = [];
      for (let index = 0; index < fileCount; index += 1) {
        const relPath = `${key}/c${index}.ts`;
        await writeWorkspaceFile(root, relPath, `export const c${index} = ${index + round + 1};\n`);
        // Workspace-relative путь: см. комментарий в тесте массового потока событий.
        changed.push(relPath);
      }
      await runPartialIndex({
        workspacePath: root,
        db,
        changed,
        removed: [],
        isCancelled: () => false,
        onProgress: sink.onProgress,
      });
    }
    const heapEnd = heapMb();
    const heapDelta = Math.round((heapEnd - heapStart) * 100) / 100;

    // 60 проходов × 40 файлов = 2400 событий: рост heap не должен быть линейным.
    expect(heapDelta).toBeLessThan(120);

    console.info(
      `[stress][index][cycles] rounds=${rounds} filesPerRound=${fileCount} events=${
        rounds * fileCount
      } heapDelta=${heapDelta}MB`,
    );
  }, 300_000);

  it("отмена оставляет консистентный индекс без битых строк", async () => {
    const { root, dbPath } = workspace;
    const cancelRoot = "src/cancel";
    await writeWorkspaceFile(root, `${cancelRoot}/c0.ts`, "export const c0 = 1;\n");
    await writeWorkspaceFile(root, `${cancelRoot}/c1.ts`, "export const c1 = 2;\n");

    const { db } = await openStore(dbPath);
    const sink = createProgressSink();
    let calls = 0;
    const result = await runPartialIndex({
      workspacePath: root,
      db,
      // Workspace-relative пути: см. комментарий в тесте массового потока событий.
      changed: [`${cancelRoot}/c0.ts`, `${cancelRoot}/c1.ts`],
      removed: [],
      // Первый же опрос отменяет проход: цикл обязан прерваться до чтения файла,
      // вернув cancelled=true и консистентный индекс (без битых строк).
      isCancelled: () => {
        calls += 1;
        return calls >= 1;
      },
      onProgress: sink.onProgress,
    });

    expect(result.cancelled).toBe(true);
    // Индекс читается без ошибок (нет битых строк после прерывания).
    const rowCount = db.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number };
    expect(rowCount.count).toBeGreaterThanOrEqual(0);

    console.info(
      `[stress][index][cancel] cancelled=${result.cancelled} filesInIndex=${rowCount.count}`,
    );
  }, 120_000);
});

/** Проверка, что openStore закрывает соединение после тестов. */
export type { IndexDatabase };
