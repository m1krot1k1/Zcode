/**
 * Обход дерева каталогов для поиска файлов (Glob) и текстового fallback (Grep).
 *
 * Вынесен из `fs/index.ts`, чтобы основной адаптер не превышал лимит max-lines.
 *
 * Два измерения производительности, подтверждённые замерами на этом репозитории:
 * - `node_modules` больше не обходится: 164 каталога и ~212 тыс. файлов против 10 тыс.
 *   исходников. Обход без него — 0.27 с, с ним — 8.18 с на каждый вызов Glob.
 * - файлы одного каталога обрабатываются пачками по WALK_CONCURRENCY вместо
 *   последовательного `await stat`, что убирает второй по стоимости фактор.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Одновременных stat/readdir при обходе: ограничено, чтобы не упереться в дескрипторы. */
const WALK_CONCURRENCY = 16;

/**
 * Каталоги, которые не обходятся при поиске файлов и текста.
 *
 * Помимо VCS-каталогов исключается `node_modules`: он не содержит исходников
 * проекта, но вносит подавляющую часть файловых операций.
 */
export const WALK_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  ".jj",
  ".sl",
  "node_modules",
]);

type WalkVisitor = (
  path: string,
  info: Awaited<ReturnType<typeof stat>>,
) => Promise<void> | void;

export async function walkFiles(
  current: string,
  signal: AbortSignal | undefined,
  visitor: WalkVisitor,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await readdir(current, { withFileTypes: true });

  const files = entries.filter((entry) => entry.isFile());
  for (let index = 0; index < files.length; index += WALK_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = files.slice(index, index + WALK_CONCURRENCY);
    await Promise.all(
      batch.map(async (entry) => {
        const childPath = join(current, entry.name);
        const info = await stat(childPath);
        await visitor(childPath, info);
      }),
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (WALK_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    throwIfAborted(signal);
    await walkFiles(join(current, entry.name), signal, visitor);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("File walk aborted");
  }
}
