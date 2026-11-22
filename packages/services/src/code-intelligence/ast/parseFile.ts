import { languageForPath } from "./languageRegistry.js";
import { parseWithTreeSitter } from "./astChunker.js";
import { parseWithTextChunker } from "./textChunker.js";
import type { ParsedFile } from "./types.js";

/**
 * Единая точка входа разбора: tree-sitter, если грамматика языка реально доступна,
 * иначе — структурный текстовый чанкер. Результат всегда содержит `languageName` и
 * `usedTreeSitter`, чтобы статус/диагностика могли честно показать, чем разобран файл.
 */
export async function parseFile(relPath: string, source: string): Promise<ParsedFile> {
  const descriptor = languageForPath(relPath);
  if (descriptor.wasm) {
    const parsed = await parseWithTreeSitter(relPath, source, descriptor.name);
    if (parsed) return parsed;
  }
  const fallback = parseWithTextChunker(relPath, source, descriptor.id, descriptor.name);
  fallback.usedTreeSitter = false;
  return fallback;
}
