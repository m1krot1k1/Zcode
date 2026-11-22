import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, "../../../wdio.conf.ts");
const modulesDir = join(here, "../wdio");

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectSourceFiles(path, out);
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
}

/**
 * Конфиг WDIO разложен на модули в `test/e2e/wdio/`; source-contract тесты
 * проверяют не только тонкий вход, но и все модули, иначе проверка становится
 * вакуумной. Порядок детерминирован (сорт по имени), поэтому маркерные ассерты
 * не зависят от файловой системы.
 */
export function readWdioConfigSource(): string {
  const files: string[] = [];
  collectSourceFiles(modulesDir, files);
  return [configPath, ...files].map((path) => readFileSync(path, "utf8")).join("\n");
}
