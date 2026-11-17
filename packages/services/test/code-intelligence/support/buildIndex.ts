import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodeIndexService } from "../../../src/code-intelligence/worker/indexService.js";
import { databaseFileFor } from "../../../src/code-intelligence/worker/storePath.js";
import { openStore, type IndexDatabase } from "../../../src/code-intelligence/worker/store.js";

/**
 * Собирает реальный индекс во временном workspace и отдаёт открытую БД для прямых
 * проверок каналов поиска. Никаких моков: используется тот же `CodeIndexService`,
 * что и в продакшене, поэтому тесты видят фактическую схему и содержимое индекса.
 */
export async function buildIndex(
  files: Record<string, string>,
  roots: string[],
): Promise<{ workspacePath: string; db: IndexDatabase; dispose: () => void }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-search-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const indexRootDir = join(root, "indexes");
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(workspacePath, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  const service = new CodeIndexService({ indexRootDir });
  const indexed = await service.handle({
    id: 1,
    type: "index",
    workspacePath,
    force: true,
  } as never);
  if (!indexed.ok) throw new Error(indexed.error?.message ?? "Index build failed.");
  await service.handle({ id: 2, type: "shutdown" } as never);
  const { db } = await openStore(databaseFileFor(indexRootDir, workspacePath));
  return {
    workspacePath,
    db,
    dispose: () => {
      try {
        db.close();
      } catch {
        // Повторное закрытие безопасно: тест мог уже закрыть соединение.
      }
    },
  };
}

/** Удаляет временные каталоги теста; вызывается в `afterEach`. */
export async function cleanupRoots(roots: string[]): Promise<void> {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}
