import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Путь файла индекса для identity.
 *
 * Хеш (`sha256`, 32 hex-символа) — часть контракта хранения: он же используется при
 * открытии БД в воркере и при удалении индекса. Функция вынесена из `IndexService`,
 * чтобы тесты и обслуживание проверяли ровно тот же путь, а не копию формулы.
 */
export function databaseFileFor(indexRootDir: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return join(indexRootDir, `${digest}.sqlite3`);
}
