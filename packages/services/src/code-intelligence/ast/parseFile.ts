import { languageForPath } from "./languageRegistry.js";
import { parseWithTreeSitter } from "./astChunker.js";
import { parseWithTextChunker } from "./textChunker.js";
import type { ParsedFile } from "./types.js";

/**
 * Files above this size are indexed with the structural text chunker instead of tree-sitter.
 * The scanner still accepts files up to 8 MiB; parsing a multi-megabyte bundle through WASM
 * AST would dominate a full index pass and can exhaust the worker heap.
 */
const MAX_TREE_SITTER_SOURCE_CHARS = 1024 * 1024;

/**
 * Единая точка входа разбора: tree-sitter, если грамматика языка реально доступна,
 * иначе — структурный текстовый чанкер. Результат всегда содержит `languageName` и
 * `usedTreeSitter`, чтобы статус/диагностика могли честно показать, чем разобран файл.
 */
export async function parseFile(relPath: string, source: string): Promise<ParsedFile> {
  const descriptor = languageForPath(relPath);
  if (descriptor.wasm && source.length <= MAX_TREE_SITTER_SOURCE_CHARS) {
    const parsed = await parseWithTreeSitter(relPath, source, descriptor.name);
    if (parsed) return parsed;
  }
  const fallback = parseWithTextChunker(relPath, source, descriptor.id, descriptor.name);
  fallback.usedTreeSitter = false;
  return fallback;
}
