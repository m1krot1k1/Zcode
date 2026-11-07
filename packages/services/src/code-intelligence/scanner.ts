import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, posix, relative, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import ts from "typescript";

export interface IndexedFileRecord {
  path: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  fingerprint: string;
  symbols: IndexedSymbolRecord[];
  chunks: IndexedChunkRecord[];
  edges: IndexedEdgeRecord[];
}

export interface IndexedSymbolRecord {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature: string;
  exported: number;
}

export interface IndexedChunkRecord {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding?: Uint8Array | null;
  embeddingModel?: string | null;
}

export interface IndexedEdgeRecord {
  sourceId: string;
  targetId: string;
  relation: "imports" | "calls";
  sourcePath: string;
  targetPath: string;
}

export interface ScannedFileMeta {
  path: string;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  fingerprint?: string;
  changed: boolean;
  excluded?: boolean;
  record?: IndexedFileRecord;
}

export interface WorkspaceScanResult {
  files: ScannedFileMeta[];
  diagnostics: string[];
  truncated: boolean;
  partial: boolean;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_FILES = 20_000;
const MAX_CHUNK_LINES = 120;
const CHUNK_OVERLAP_LINES = 12;
const SECRET_CONTENT =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["'][^"'\n]{16,}["']/i;
const SECRET_FILE_NAME =
  /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:pem|key|p12|pfx|keystore)|[^/]*secret[^/]*)$/i;
const DEFAULT_IGNORES = [
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
  "**/target/**",
  "**/generated/**",
  "**/*.min.js",
  "**/*.map",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*secret*",
];

export interface PreviousFileMeta {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  fingerprint: string;
}

function sourceScriptKind(filePath: string): ts.ScriptKind {
  switch (extname(filePath).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function symbolId(filePath: string, name: string, line: number, kind: string): string {
  return `s:${filePath}:${line}:${kind}:${name}`;
}

function declarationName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}

function declarationKind(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isPropertyDeclaration(node)) return "property";
  return undefined;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function safeSignature(sourceFile: ts.SourceFile, node: ts.Node): string {
  const raw = node.getText(sourceFile).split("\n", 1)[0]?.trim() ?? "";
  return raw.slice(0, 500);
}

function makeChunks(filePath: string, content: string): IndexedChunkRecord[] {
  const lines = content.split(/\r?\n/);
  const chunks: IndexedChunkRecord[] = [];
  const step = MAX_CHUNK_LINES - CHUNK_OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + MAX_CHUNK_LINES);
    const body = lines.slice(start, end).join("\n").trim();
    if (body) {
      chunks.push({
        id: `c:${filePath}:${start + 1}`,
        path: filePath,
        startLine: start + 1,
        endLine: end,
        content: body,
      });
    }
    if (end === lines.length) break;
  }
  return chunks;
}

function resolveImportPath(
  sourcePath: string,
  specifier: string,
  knownPaths: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map(
      (extension) => `${base}${extension}`,
    ),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((name) => `${base}/${name}`),
  ];
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null;
}

function parseSourceFile(
  rootPath: string,
  filePath: string,
  content: string,
  mtimeMs: number,
  ctimeMs: number,
  size: number,
  knownPaths: Set<string>,
): IndexedFileRecord {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    sourceScriptKind(filePath),
  );
  const relPath = relative(rootPath, filePath).split("\\").join("/");
  const lines = content.split(/\r?\n/).length;
  const moduleId = `m:${relPath}`;
  const symbols: IndexedSymbolRecord[] = [
    {
      id: moduleId,
      name: relPath,
      kind: "module",
      path: relPath,
      startLine: 1,
      endLine: Math.max(1, lines),
      signature: relPath,
      exported: 0,
    },
  ];
  const declarationByNode = new Map<ts.Node, IndexedSymbolRecord>();
  const namesToSymbols = new Map<string, IndexedSymbolRecord[]>();

  const collect = (node: ts.Node): void => {
    const name = declarationName(node);
    const kind = declarationKind(node);
    if (name && kind) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const record: IndexedSymbolRecord = {
        id: symbolId(relPath, name, startLine, kind),
        name,
        kind,
        path: relPath,
        startLine,
        endLine,
        signature: safeSignature(sourceFile, node),
        exported: isExported(node) ? 1 : 0,
      };
      symbols.push(record);
      declarationByNode.set(node, record);
      const named = namesToSymbols.get(name) ?? [];
      named.push(record);
      namesToSymbols.set(name, named);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const edges: IndexedEdgeRecord[] = [];
  const findContainerSymbol = (node: ts.Node): IndexedSymbolRecord => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      const found = declarationByNode.get(current);
      if (found) return found;
      current = current.parent;
    }
    return symbols[0]!;
  };
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const targetPath = resolveImportPath(relPath, node.moduleSpecifier.text, knownPaths);
      if (targetPath) {
        edges.push({
          sourceId: moduleId,
          targetId: `m:${targetPath}`,
          relation: "imports",
          sourcePath: relPath,
          targetPath,
        });
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const candidates = namesToSymbols.get(node.expression.text) ?? [];
      if (candidates.length === 1) {
        const source = findContainerSymbol(node);
        const target = candidates[0]!;
        if (source.id !== target.id) {
          edges.push({
            sourceId: source.id,
            targetId: target.id,
            relation: "calls",
            sourcePath: relPath,
            targetPath: relPath,
          });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);

  return {
    path: relPath,
    mtimeMs,
    ctimeMs,
    size,
    fingerprint: createHash("sha256").update(content).digest("hex"),
    symbols,
    chunks: makeChunks(relPath, content),
    edges,
  };
}

async function loadIgnoreRules(rootPath: string) {
  const rules = (ignoreFactory as unknown as () => Ignore)().add(DEFAULT_IGNORES);
  for (const name of [".gitignore", ".zcodeignore"]) {
    try {
      rules.add(await readFile(join(rootPath, name), "utf8"));
    } catch {
      // Ignore files are optional; unreadable rules are surfaced as a generic diagnostic later.
    }
  }
  return rules;
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

async function addNestedIgnoreRules(
  rules: Ignore,
  directory: string,
  relativeDirectory: string,
): Promise<void> {
  for (const name of [".gitignore", ".zcodeignore"]) {
    try {
      rules.add(
        scopeIgnoreContent(await readFile(join(directory, name), "utf8"), relativeDirectory),
      );
    } catch {
      // Workspace ignore files are optional.
    }
  }
}

export async function scanWorkspace(
  workspacePath: string,
  previousFiles: Map<string, PreviousFileMeta>,
  force: boolean,
  onProgress: (discoveredFiles: number, indexedFiles: number) => void,
): Promise<WorkspaceScanResult> {
  const rootPath = resolve(workspacePath);
  const rules = await loadIgnoreRules(rootPath);
  const diagnostics: string[] = [];
  const files: ScannedFileMeta[] = [];
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    if (truncated) return;
    const relativeDirectory = relative(rootPath, directory).split("\\").join("/");
    if (relativeDirectory && relativeDirectory !== ".") {
      await addNestedIgnoreRules(rules, directory, relativeDirectory);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      const absolutePath = join(directory, entry.name);
      const relPath = relative(rootPath, absolutePath).split("\\").join("/");
      if (rules.ignores(relPath) || SECRET_FILE_NAME.test(relPath)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (files.length >= MAX_SOURCE_FILES) {
        truncated = true;
        return;
      }
      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_SOURCE_BYTES) {
        diagnostics.push("Some source files exceeded the 1 MiB indexing limit and were skipped.");
        continue;
      }
      files.push({
        path: relPath,
        mtimeMs: fileStat.mtimeMs,
        ctimeMs: fileStat.ctimeMs,
        size: fileStat.size,
        changed:
          force ||
          previousFiles.get(relPath)?.mtimeMs !== fileStat.mtimeMs ||
          previousFiles.get(relPath)?.ctimeMs !== fileStat.ctimeMs ||
          previousFiles.get(relPath)?.size !== fileStat.size,
      });
      onProgress(files.length, 0);
    }
  };

  await visit(rootPath);
  const knownPaths = new Set(files.map((file) => file.path));
  let indexedFiles = 0;
  for (const file of files) {
    if (file.changed) {
      const absolutePath = join(rootPath, file.path);
      const content = await readFile(absolutePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_BYTES) {
        file.excluded = true;
        diagnostics.push("Some source files exceeded the 1 MiB indexing limit and were skipped.");
      } else if (SECRET_CONTENT.test(content)) {
        file.excluded = true;
        diagnostics.push("A source file matching secret patterns was excluded from the index.");
      } else {
        file.fingerprint = createHash("sha256").update(content).digest("hex");
        if (previousFiles.get(file.path)?.fingerprint === file.fingerprint) {
          file.changed = false;
        } else {
          file.record = parseSourceFile(
            rootPath,
            absolutePath,
            content,
            file.mtimeMs,
            file.ctimeMs,
            file.size,
            knownPaths,
          );
        }
      }
    }
    indexedFiles += 1;
    if (indexedFiles % 10 === 0 || indexedFiles === files.length) {
      onProgress(files.length, indexedFiles);
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
  }
  if (truncated)
    diagnostics.push(
      `Indexing stopped at the ${MAX_SOURCE_FILES.toLocaleString()} file safety limit.`,
    );
  if (diagnostics.length > 12) diagnostics.splice(12, diagnostics.length - 12);
  const uniqueDiagnostics = [...new Set(diagnostics)];
  return {
    files,
    diagnostics: uniqueDiagnostics,
    truncated,
    partial: truncated || uniqueDiagnostics.length > 0,
  };
}
