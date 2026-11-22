import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import { INDEXED_EXTENSIONS, pathTierOf } from "../ast/languageRegistry.js";

/**
 * Обход workspace без чтения содержимого.
 *
 * Отличия от v1, которые устранены здесь:
 *  - v1 индексировала только JS/TS (`SOURCE_EXTENSIONS`), поэтому Python/Go/Rust проект давал
 *    `ready` при 0 файлов. v2 берёт `INDEXED_EXTENSIONS` из реестра языков.
 *  - v1 останавливалась на 20 000 файлов молча; v2 сообщает `truncated` и продолжает работу
 *    с уже найденным (частичный индекс лучше пустого).
 *  - игнор-правила применяются до `stat`, поэтому `node_modules` не даёт тысяч syscall'ов.
 */

export const MAX_INDEXED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 60_000;

const SECRET_FILE_NAME =
  /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx|keystore)|[^/]*secret[^/]*|id_rsa|id_ed25519)$/iu;

/**
 * Контентные признаки реального секрета.
 *
 * Отличие от проверки имени файла: `.env`-подобные имена отсекаются всегда, а содержимое —
 * только если это похоже на настоящий секрет. Причина: v1 исключала любой файл с паролем,
 * из-за чего фикстуры тестов выпадали из индекса. Фикстурные значения (в тестовых путях)
 * допускаются, продуктовые — нет: индекс не должен хранить живые креденшелы.
 */
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
];

/**
 * Присваивание секрета строковым литералом. Проверяется только в продакшн-путях
 * (`pathTier < 2`): фикстуры тестов законно содержат `password = "fixture-..."`.
 */
const CREDENTIAL_ASSIGNMENT =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["'`][^"'`]{8,}["'`]/iu;

export function looksLikeSecretContent(content: string, pathTier = 0): boolean {
  if (SECRET_CONTENT.some((pattern) => pattern.test(content))) return true;
  return pathTier < 2 && CREDENTIAL_ASSIGNMENT.test(content);
}

export const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/.zcode/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/**",
  "**/generated/**",
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.d.ts.map",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*secret*",
];

export interface ScannedFile {
  relPath: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
  pathTier: number;
}

export interface ScanResult {
  files: ScannedFile[];
  truncated: boolean;
  skippedLarge: number;
  skippedSecret: number;
}

function scopeIgnoreContent(content: string, prefix: string): string {
  return content
    .split(/\r?\n/u)
    .map((line) => {
      if (!line || line.startsWith("#")) return line;
      const negation = line.startsWith("!") ? "!" : "";
      const body = (negation ? line.slice(1) : line).replace(/^\//u, "");
      if (!body) return line;
      const scoped = body.includes("/") ? `${prefix}/${body}` : `${prefix}/**/${body}`;
      return `${negation}${scoped}`;
    })
    .join("\n");
}

async function addIgnoreFiles(
  rules: Ignore,
  directory: string,
  relDirectory: string,
): Promise<void> {
  for (const name of [".gitignore", ".zcodeignore"]) {
    try {
      const content = await readFile(join(directory, name), "utf8");
      rules.add(relDirectory ? scopeIgnoreContent(content, relDirectory) : content);
    } catch {
      // Файлы игнора опциональны; отсутствие не является ошибкой индексации.
    }
  }
}

export async function scanWorkspaceFiles(workspacePath: string): Promise<ScanResult> {
  const rootPath = resolve(workspacePath);
  const rules = (ignoreFactory as unknown as () => Ignore)().add(DEFAULT_IGNORES);
  await addIgnoreFiles(rules, rootPath, "");
  const files: ScannedFile[] = [];
  let truncated = false;
  let skippedLarge = 0;
  let skippedSecret = 0;

  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    const relDirectory = relative(rootPath, directory).split(sep).join("/");
    if (relDirectory && relDirectory !== ".") await addIgnoreFiles(rules, directory, relDirectory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const absolutePath = join(directory, entry.name);
      const relPath = relative(rootPath, absolutePath).split(sep).join("/");
      if (!relPath) continue;
      if (rules.ignores(relPath)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!INDEXED_EXTENSIONS.includes(extension)) continue;
      if (SECRET_FILE_NAME.test(relPath)) {
        skippedSecret += 1;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        continue;
      }
      if (info.size > MAX_INDEXED_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      files.push({
        relPath,
        absolutePath,
        mtimeMs: Math.floor(info.mtimeMs),
        size: info.size,
        pathTier: pathTierOf(relPath),
      });
    }
  };

  await visit(rootPath);
  files.sort((left, right) => left.relPath.localeCompare(right.relPath));
  return { files, truncated, skippedLarge, skippedSecret };
}

/** Минимальная проверка, что путь не выходит за пределы workspace (защита от `..` в событиях). */
export function isInsideWorkspace(workspacePath: string, relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}
