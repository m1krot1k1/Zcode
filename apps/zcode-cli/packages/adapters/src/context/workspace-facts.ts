// ============================================================
// Workspace Facts - detection, classification and input snapshot
// ============================================================
//
// Единственный владелец вычисления workspace facts (кроме cache-персистенции).
// Модуль не запускает команды: git HEAD читается из .git/HEAD, refs и packed-refs;
// версии toolchain — из файлов и текущего process.version.

import { createHash } from "node:crypto";
import {
  lstat as fsLstat,
  mkdir,
  readFile,
  readdir,
  realpath as fsRealpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  PackageManager,
  ProjectContext,
  ProjectType,
  WorkspaceFacts,
  WorkspaceScriptClassification,
  WorkspaceScriptKind,
  WorkspaceToolchainFacts,
} from "@zcode/contracts";

const MAX_HASH_BYTES = 16 * 1024 * 1024;
const MAX_PARSE_BYTES = 1024 * 1024;
const MAX_SCANNED_ENTRIES = 64;
const MAX_SCRIPTS = 200;
const MAX_COMMAND_LENGTH = 2048;
const MAX_WORKSPACES = 64;
const MAX_INPUT_PATHS = 128;
const MAX_MISE_ENTRIES = 32;
const MAX_VERSION_DECLARATION_LENGTH = 128;
const MAX_PACKED_REFS_BYTES = 4 * 1024 * 1024;

const GIT_SHA = /^[0-9a-f]{40,64}$/iu;

const FIXED_INPUT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "lerna.json",
  "turbo.json",
  "nx.json",
  "mise.toml",
  ".mise.toml",
  ".nvmrc",
  ".node-version",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "Pipfile",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
] as const;

const SCANNED_INPUT_PREFIXES = [
  "tsconfig",
  "vitest.config.",
  "jest.config.",
  "playwright.config.",
  "cypress.config.",
  "karma.conf.",
  ".mocharc.",
] as const;

const TEXT_INPUT_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  "lerna.json",
  "mise.toml",
  ".mise.toml",
  ".nvmrc",
  ".node-version",
]);

const PYTHON_MARKERS = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"] as const;
const JAVA_MARKERS = ["pom.xml", "build.gradle", "build.gradle.kts"] as const;
const BUILD_FILES = [
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
] as const;

export const WORKSPACE_SCRIPT_KINDS: readonly WorkspaceScriptKind[] = [
  "test",
  "lint",
  "typecheck",
  "build",
  "dev",
];

export interface WorkspaceFactsFileStat {
  isFile: boolean;
  mtimeMs: number;
  size: number;
  /** true, когда lstat определил символьную ссылку; такие входы не читаются. */
  isSymbolicLink?: boolean;
}

/** Узкий IO-порт: позволяет тестам считать чтения и управлять stat без реального FS. */
export interface WorkspaceFactsIo {
  stat(filePath: string): Promise<WorkspaceFactsFileStat | null>;
  /**
   * lstat/realpath опциональны для узких тестовых IO. Боевой IO их реализует,
   * чтобы запретить symlink-входы и чтение за пределы realpath(projectRoot).
   */
  lstat?(filePath: string): Promise<WorkspaceFactsFileStat | null>;
  realpath?(filePath: string): Promise<string>;
  readFile(filePath: string): Promise<Buffer>;
  readdir(directory: string): Promise<string[]>;
  mkdir(directory: string, options: { recursive: true; mode?: number }): Promise<void>;
  writeFile(filePath: string, data: string, options: { mode?: number; flag?: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export const nodeWorkspaceFactsIo: WorkspaceFactsIo = {
  async stat(filePath) {
    try {
      const info = await stat(filePath);
      return { isFile: info.isFile(), mtimeMs: info.mtimeMs, size: info.size };
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return null;
      throw error;
    }
  },
  async lstat(filePath) {
    try {
      const info = await fsLstat(filePath);
      return {
        isFile: info.isFile(),
        mtimeMs: info.mtimeMs,
        size: info.size,
        isSymbolicLink: info.isSymbolicLink(),
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return null;
      throw error;
    }
  },
  realpath(filePath) {
    return fsRealpath(filePath);
  },
  readFile(filePath) {
    return readFile(filePath);
  },
  async readdir(directory) {
    try {
      return await readdir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return [];
      throw error;
    }
  },
  async mkdir(directory, options) {
    await mkdir(directory, options);
  },
  async writeFile(filePath, data, options) {
    await writeFile(filePath, data, { encoding: "utf8", ...options });
  },
  rename,
  unlink,
};

export interface WorkspaceInputProbe {
  path: string;
  exists: boolean;
  mtimeMs: number;
  size: number;
}

export interface WorkspaceInputFile extends WorkspaceInputProbe {
  sha256: string | null;
}

export interface WorkspaceGitFacts {
  head?: string;
  dirty?: boolean;
  dirtySignature?: string;
}

export interface WorkspaceInputSnapshot {
  files: WorkspaceInputFile[];
  text: Map<string, string>;
  git: WorkspaceGitFacts;
}

export interface WorkspaceInputProbeResult {
  files: WorkspaceInputProbe[];
  git: { head?: string; indexSignature?: string };
}

async function listWorkspaceInputPaths(
  projectRoot: string,
  io: WorkspaceFactsIo,
): Promise<string[]> {
  const names = new Set<string>(FIXED_INPUT_FILES);
  const entries = await io.readdir(projectRoot);
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= MAX_SCANNED_ENTRIES) break;
    if (!isSafeRootEntry(entry)) continue;
    if (!SCANNED_INPUT_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    if (entry.startsWith("tsconfig") && !entry.endsWith(".json")) continue;
    names.add(entry);
    scanned += 1;
  }
  return [...names].sort((left, right) => left.localeCompare(right)).slice(0, MAX_INPUT_PATHS);
}

function isSafeRootEntry(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".."
  );
}

export async function probeWorkspaceInputs(
  projectRoot: string,
  io: WorkspaceFactsIo,
): Promise<WorkspaceInputProbeResult> {
  const paths = await listWorkspaceInputPaths(projectRoot, io);
  const files: WorkspaceInputProbe[] = [];
  for (const path of paths) {
    // Bugfix (security): lstat вместо stat, чтобы symlink-вход (.nvmrc,
    // .node-version, mise.toml) не уводил чтение за пределы projectRoot.
    const info = await lstatEntry(io, join(projectRoot, path));
    if (!info) {
      files.push({ path, exists: false, mtimeMs: 0, size: 0 });
      continue;
    }
    if (info.isSymbolicLink) {
      // Fail-closed: symlink-вход никогда не читается и не попадает в text/cache;
      // size -1 инвалидирует запись при подмене обычного файла ссылкой.
      files.push({ path, exists: false, mtimeMs: info.mtimeMs, size: -1 });
      continue;
    }
    if (!info.isFile) {
      // Каталог/спецфайл на месте входа — не file. size -1 отличает его от отсутствия,
      // чтобы подмена file → directory инвалидировала запись.
      files.push({ path, exists: false, mtimeMs: info.mtimeMs, size: -1 });
      continue;
    }
    files.push({ path, exists: true, mtimeMs: info.mtimeMs, size: info.size });
  }
  const git = await resolveGitMetadata(projectRoot, io).catch(() => ({}));
  return { files, git };
}

export async function fingerprintWorkspaceInputs(
  projectRoot: string,
  probe: WorkspaceInputProbeResult,
  io: WorkspaceFactsIo,
): Promise<WorkspaceInputSnapshot> {
  const files: WorkspaceInputFile[] = [];
  const text = new Map<string, string>();
  for (const item of probe.files) {
    if (!item.exists) {
      files.push({ ...item, sha256: null });
      continue;
    }
    if (item.size > MAX_HASH_BYTES) {
      files.push({ ...item, sha256: `oversize:${item.size}:${item.mtimeMs}` });
      continue;
    }
    // Defense-in-depth: повторная проверка перед чтением (probe → fingerprint
    // разделены по времени), плюс canonical containment внутри realpath(root).
    if (!(await isContainedInputFile(io, projectRoot, item.path))) {
      files.push({ ...item, sha256: null });
      continue;
    }
    const buffer = await io.readFile(join(projectRoot, item.path));
    files.push({ ...item, sha256: createHash("sha256").update(buffer).digest("hex") });
    if (TEXT_INPUT_FILES.has(item.path) && buffer.length <= MAX_PARSE_BYTES) {
      text.set(item.path, buffer.toString("utf8"));
    }
  }
  return {
    files,
    text,
    git: probe.git.head ? { head: probe.git.head } : {},
  };
}

export async function resolveGitMetadata(
  projectRoot: string,
  io: WorkspaceFactsIo,
): Promise<{ head?: string; indexSignature?: string }> {
  const dotGitPath = join(projectRoot, ".git");
  const dotGit = await lstatEntry(io, dotGitPath);
  // Bugfix (security): symlink .git (файл или каталог) не читается — его цель
  // может находиться вне projectRoot.
  if (!dotGit || dotGit.isSymbolicLink) return {};
  let gitDir = dotGitPath;
  if (dotGit.isFile) {
    const pointer = await readContainedText(io, projectRoot, dotGitPath, 4096);
    const match = /^gitdir:\s*(.+)$/u.exec(pointer?.trim() ?? "");
    if (!match?.[1]) return {};
    gitDir = resolve(projectRoot, match[1].trim());
  }
  // gitdir (и сам .git) обязан находиться внутри realpath(projectRoot):
  // указатель за пределы дерева — fail-closed без чтения HEAD/refs/index.
  if (!(await isContainedPath(io, projectRoot, gitDir))) return {};
  const head = await readGitHead(projectRoot, gitDir, io);
  const index = await statContainedEntry(io, projectRoot, join(gitDir, "index"));
  return {
    ...(head ? { head } : {}),
    ...(index?.isFile ? { indexSignature: `${index.mtimeMs}:${index.size}` } : {}),
  };
}

async function readGitHead(
  projectRoot: string,
  gitDir: string,
  io: WorkspaceFactsIo,
): Promise<string | undefined> {
  const headText = (await readContainedText(io, projectRoot, join(gitDir, "HEAD"), 4096))?.trim();
  if (!headText) return undefined;
  if (!headText.startsWith("ref: ")) {
    return GIT_SHA.test(headText) ? headText : undefined;
  }
  const ref = headText.slice("ref: ".length).trim();
  if (!ref || ref.includes("..") || ref.startsWith("/")) return undefined;
  const commonDir = await resolveGitCommonDir(projectRoot, gitDir, io);
  for (const directory of uniqueStrings([gitDir, commonDir])) {
    const sha = (await readContainedText(io, projectRoot, join(directory, ref), 4096))?.trim();
    if (sha && GIT_SHA.test(sha)) return sha;
  }
  for (const directory of uniqueStrings([commonDir, gitDir])) {
    const packedRefs = await readContainedText(
      io,
      projectRoot,
      join(directory, "packed-refs"),
      MAX_PACKED_REFS_BYTES,
    );
    if (!packedRefs) continue;
    for (const line of packedRefs.split(/\r?\n/u)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.trim().split(/\s+/u);
      if (name === ref && sha && GIT_SHA.test(sha)) return sha;
    }
  }
  // Ветка без коммита: HEAD стабилен по имени ref, но не по sha.
  return `ref:${ref}`;
}

async function resolveGitCommonDir(
  projectRoot: string,
  gitDir: string,
  io: WorkspaceFactsIo,
): Promise<string> {
  const commonDir = (
    await readContainedText(io, projectRoot, join(gitDir, "commondir"), 4096)
  )?.trim();
  if (!commonDir) return gitDir;
  const candidate = resolve(gitDir, commonDir);
  // commondir: только внутри projectRoot. Выход за дерево = игнорируем внешний
  // каталог (никакого чтения refs/packed-refs снаружи).
  return (await isContainedPath(io, projectRoot, candidate)) ? candidate : gitDir;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function lstatEntry(
  io: WorkspaceFactsIo,
  filePath: string,
): Promise<WorkspaceFactsFileStat | null> {
  return io.lstat ? io.lstat(filePath) : io.stat(filePath);
}

/** Лексическая и canonical (realpath) проверка: fail-closed при любой ошибке канонизации. */
async function isContainedPath(
  io: WorkspaceFactsIo,
  projectRoot: string,
  candidate: string,
): Promise<boolean> {
  if (!isPathInside(projectRoot, candidate)) return false;
  if (!io.realpath) return true;
  try {
    const rootReal = await io.realpath(projectRoot);
    const candidateReal = await io.realpath(candidate);
    return isPathInside(rootReal, candidateReal);
  } catch (error) {
    // Отказ канонизации (включая исчезнувший файл) — вход не читается.
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return false;
    throw error;
  }
}

async function statContainedEntry(
  io: WorkspaceFactsIo,
  projectRoot: string,
  filePath: string,
): Promise<WorkspaceFactsFileStat | null> {
  if (!(await isContainedPath(io, projectRoot, filePath))) return null;
  const info = await lstatEntry(io, filePath);
  if (!info || info.isSymbolicLink) return null;
  return info;
}

async function readContainedText(
  io: WorkspaceFactsIo,
  projectRoot: string,
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  const info = await statContainedEntry(io, projectRoot, filePath);
  if (!info?.isFile) return undefined;
  return readBoundedText(io, filePath, maxBytes);
}

async function isContainedInputFile(
  io: WorkspaceFactsIo,
  projectRoot: string,
  relativePath: string,
): Promise<boolean> {
  const info = await statContainedEntry(io, projectRoot, join(projectRoot, relativePath));
  return info?.isFile === true;
}

async function readBoundedText(
  io: WorkspaceFactsIo,
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const buffer = await io.readFile(filePath);
    return buffer.subarray(0, maxBytes).toString("utf8");
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") ||
      isNodeError(error, "ENOTDIR") ||
      isNodeError(error, "EISDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

export interface BuildWorkspaceProjectContextInput {
  snapshot: WorkspaceInputSnapshot;
  now: number;
}

export function buildWorkspaceProjectContext(
  input: BuildWorkspaceProjectContextInput,
): ProjectContext {
  const present = new Set(
    input.snapshot.files.filter((file) => file.exists).map((file) => file.path),
  );
  const packageJson = parsePackageJson(input.snapshot.text.get("package.json"));
  const type = detectProjectType(present);
  const packageManager = detectPackageManager(present);
  const scripts = sanitizeScripts(packageJson?.scripts);
  const buildFiles = BUILD_FILES.filter((file) => present.has(file));
  const workspaceFacts: WorkspaceFacts = {
    classifiedScripts: classifyScripts(scripts ?? {}),
    monorepo: parseMonorepoFacts(present, packageJson, input.snapshot.text),
    toolchain: parseToolchainFacts(packageJson, input.snapshot.text),
    verifiedCommands: [],
    verifiedCommandsStatus: "unavailable",
    provenance: {
      computedAt: new Date(input.now).toISOString(),
      ...(input.snapshot.git.head ? { gitHead: input.snapshot.git.head } : {}),
      ...(input.snapshot.git.dirty !== undefined ? { gitDirty: input.snapshot.git.dirty } : {}),
      inputs: input.snapshot.files
        .filter((file) => file.exists)
        .slice(0, MAX_INPUT_PATHS)
        .map((file) => ({
          path: file.path,
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
        })),
    },
  };

  return {
    type,
    packageManager,
    scripts,
    buildFiles: buildFiles.length > 0 ? buildFiles : undefined,
    workspaceFacts,
  };
}

function detectProjectType(present: ReadonlySet<string>): ProjectType {
  if (present.has("package.json")) return "node";
  if (PYTHON_MARKERS.some((file) => present.has(file))) return "python";
  if (present.has("Cargo.toml")) return "rust";
  if (present.has("go.mod")) return "go";
  if (JAVA_MARKERS.some((file) => present.has(file))) return "java";
  return "unknown";
}

function detectPackageManager(present: ReadonlySet<string>): PackageManager | undefined {
  if (present.has("pnpm-lock.yaml")) return "pnpm";
  if (present.has("yarn.lock")) return "yarn";
  if (present.has("bun.lockb") || present.has("bun.lock")) return "bun";
  if (present.has("package-lock.json")) return "npm";
  return undefined;
}

interface ParsedPackageJson {
  scripts?: Record<string, unknown>;
  workspaces?: unknown;
  packageManager?: unknown;
  engines?: unknown;
}

function parsePackageJson(source: string | undefined): ParsedPackageJson | undefined {
  if (!source) return undefined;
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? (parsed as ParsedPackageJson) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeScripts(
  raw: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const sanitized: Record<string, string> = {};
  let count = 0;
  for (const [rawName, command] of Object.entries(raw)) {
    if (count >= MAX_SCRIPTS) break;
    if (typeof command !== "string") continue;
    // Bugfix (security): имя script — интерполируемое значение; newline не должен
    // создавать отдельную строку в промпте или в кеше.
    const name = toSingleLine(rawName);
    if (!name || name.length > 128) continue;
    sanitized[name] = redactCommand(command);
    count += 1;
  }
  return count > 0 ? sanitized : undefined;
}

// Секретным считается только ключ, в котором секретное слово — отдельный
// сегмент имени (`TOKEN`, `AUTH_TOKEN`, `API_KEY`). Подстрочный `AUTH` в
// `Authorization` под это правило не попадает.
const SECRET_KEY_SEGMENT =
  /(?:^|[_.-])(?:TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIALS?|AUTH|API[_.-]?KEY|PRIVATE[_.-]?KEY|ACCESS[_.-]?KEY)(?:$|[_.-])/iu;

const REDACTED = "<redacted>";

// Bugfix (security): интерполируемые из репозитория значения не должны
// содержать переводы строк/табы, иначе они создают отдельную строку-инструкцию
// в секции промпта. Нормализация — до ограничения длины.
// F-3: та же нормализация, что и в core-секции: все C0/C1 controls (\p{Cc},
// включая NEL) плюс LS/PS.
const SINGLE_LINE_SEPARATORS = /[\p{Cc}\u2028\u2029]+/gu;

function toSingleLine(value: string): string {
  return value.replace(SINGLE_LINE_SEPARATORS, " ").trim();
}

// Bugfix (security): bare `Authorization: <token>` (без схемы Bearer/Basic/Token)
// не редактировался, потому что подстрочный AUTH в слове Authorization не является
// отдельным сегментом ключа. Схема без токена (`Authorization: Bearer`) остаётся
// нетронутой, чтобы не ломать ложноположительный сценарий.
const BARE_AUTHORIZATION_HEADER =
  /\b(Authorization)(\s*[:=]\s*)(?!(?:Bearer|Basic|Token)\b)([^\s"']+)/giu;

// Bugfix (security): query/fragment-параметр считается секретным по имени,
// а не по фиксированному whitelist. Набор сегментов = SECRET_KEY_SEGMENT плюс
// auth/authorization/session_id/signature/sig, поэтому `?client_secret=`,
// `?refresh_token=`, `?id_token=`, `?auth_token=`, `?x-api-key=` и `#access_token=`
// редактируются независимо от позиции (первый параметр или после `&`).
const SECRET_PARAMETER_SEGMENT =
  /(?:^|[_.-])(?:AUTHORIZATION|CREDENTIALS?|PRIVATE[_.-]?KEY|ACCESS[_.-]?KEY|SESSION[_.-]?ID|SIGNATURE|PASSWORD|PASSWD|SECRET|TOKEN|AUTH|SIG|API[_.-]?KEY)(?:$|[_.-])/iu;

// Bugfix (security): единое правило для query/fragment/assignment-значений.
// Правило идёт до generic assignment-regex, который иначе начинает матч с
// `https` и проглатывает URL, не доходя до самого параметра.
//
// R-1: `%` разрешён в имени, а имя декодируется через decodeURIComponent перед
// проверкой секретного сегмента (`?auth%5Ftoken=`, `?%74oken=`). Исходное имя
// остаётся в команде; malformed `%` не роняет замену.
//
// Low (security recheck): однократного декодирования мало для двойного
// кодирования (`?%2574oken=`, `?auth%255Ftoken=`). Имя декодируется не более
// трёх проходов, секретный сегмент проверяется на исходном имени и на каждом
// результате; ошибка декодирования прекращает цепочку, но не бросает исключение.
//
// R-2: lookbehind `[?&#=]` (и `^` для вложенного значения) позволяет находить
// секретный параметр после `?`, `&`, `#` и `=`, не потребляя разделитель и не
// давая внешнему несекретному значению `?next=`/`?foo=` скрыть вложенный ключ.
// Незакавыченное значение включает `?`/`=`, поэтому секрет редактируется целиком,
// а вложенные параметры разбираются рекурсивным проходом (<= 3 уровней).
//
// R-3: quoted-альтернативы допускают escaped-кавычки (`"abc\"def"`,
// `'abc\'def'`), иначе значение обрывалось на экранированной кавычке. Хвостовая
// shell-кавычка URL (`...zzz999'`) по-прежнему не входит в значение.
//
// Low (security recheck): значение параметра — конкатенация shell-сегментов
// одного слова, поэтому после закрывающей кавычки может идти unquoted-хвост
// (`?token="abc"def`), а escaped newline внутри кавычек не обрывает значение
// (`?token="abc\` + newline + `def"`). Первый сегмент может быть полноценной
// quoted-строкой с пробелами (`"abc 123"`); последующие adjacent quoted-сегменты
// допускаются, только если кавычка открывает содержимое без пробела сразу после
// неё. Это не даёт закрывающей shell-кавычке URL склеиться со следующим
// аргументом (`'url1?token=abc' 'url2'`). Незакрытая кавычка потребляется до
// `&`/`#`/whitespace; escaped-пары (включая escaped newline LF и CRLF)
// потребляются целиком.
const QUERY_ESCAPED = String.raw`\\\r?\n|\\[\s\S]`;
const QUERY_VALUE_SEGMENT = String.raw`"(?:${QUERY_ESCAPED}|[^"\\])*"|'(?:${QUERY_ESCAPED}|[^'\\])*'`;
const QUERY_VALUE_HEAD = String.raw`${QUERY_VALUE_SEGMENT}|"(?:${QUERY_ESCAPED}|[^"\\&#\s])+|'(?:${QUERY_ESCAPED}|[^'\\&#\s])+|${QUERY_ESCAPED}|[^&#\s"'\\]+`;
const QUERY_VALUE_TAIL = String.raw`"(?=\S)(?:${QUERY_ESCAPED}|[^"\\])*"|'(?=\S)(?:${QUERY_ESCAPED}|[^'\\])*'|"(?:${QUERY_ESCAPED}|[^"\\&#\s])+|'(?:${QUERY_ESCAPED}|[^'\\&#\s])+|${QUERY_ESCAPED}|[^&#\s"'\\]+`;
const QUERY_VALUE_SOURCE = String.raw`(?:${QUERY_VALUE_HEAD})(?:${QUERY_VALUE_TAIL})*`;
const QUERY_PARAMETER = new RegExp(
  String.raw`(?:^|(?<=[?&#=]))([A-Za-z0-9_.%~-]+)=(${QUERY_VALUE_SOURCE}|)`,
  "gu",
);

const MAX_QUERY_REDACTION_DEPTH = 3;
const MAX_PARAMETER_NAME_DECODE_PASSES = 3;

function isSecretParameterName(name: string): boolean {
  if (SECRET_PARAMETER_SEGMENT.test(name)) return true;
  let current = name;
  for (let pass = 0; pass < MAX_PARAMETER_NAME_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding: проверяем уже полученные варианты, не падая.
      return false;
    }
    if (decoded === current) return false;
    if (SECRET_PARAMETER_SEGMENT.test(decoded)) return true;
    current = decoded;
  }
  return false;
}

function redactQueryValues(input: string, depth = 0): string {
  return input.replace(QUERY_PARAMETER, (match, name: string, value: string) => {
    if (isSecretParameterName(name)) {
      return `${name}=${REDACTED}`;
    }
    if (!value) return match;
    if (depth >= MAX_QUERY_REDACTION_DEPTH) return match;
    if (!value.includes("=") && !value.includes("?")) return match;
    const nested = redactQueryValues(value, depth + 1);
    return nested === value ? match : `${name}=${nested}`;
  });
}

// Bugfix (security): известные префиксы токенов редактируются даже без
// secret-ключа рядом (`node deploy.js sk-...`, `ghp_...` в тексте).
// Negative lookbehind не даёт принять `app-sk-production`/`task-sk-rebuild-2024`
// за токен: префикс должен начинаться на границе идентификатора.
const PREFIXED_TOKEN =
  /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|glpat-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}\b|xox[baprs]-[A-Za-z0-9-]{8,})/gu;

// Bugfix (security): PEM-блок приватного ключа (и одиночный заголовок) целиком
// замещается, чтобы base64-тело не попало в кеш/промпт.
const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;
const PEM_PRIVATE_KEY_HEADER = /-----BEGIN [^-]*PRIVATE KEY-----[^\n]*/gu;

export function redactCommand(command: string): string {
  const bounded =
    command.length > MAX_COMMAND_LENGTH ? command.slice(0, MAX_COMMAND_LENGTH) : command;
  const withoutAuthHeaders = bounded
    // Bugfix: сначала снимаем значение auth-схемы целиком. Иначе assignment-regex
    // ниже редактировал в `Authorization: Bearer <token>` слово Bearer, оставляя
    // сам токен, а последующее правило уже не могло его найти.
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, `$1 ${REDACTED}`)
    // Bugfix (security): PEM private key blocks/headers.
    .replace(PEM_PRIVATE_KEY_BLOCK, REDACTED)
    .replace(PEM_PRIVATE_KEY_HEADER, REDACTED)
    // Bugfix (security): bare Authorization-заголовок без схемы.
    .replace(
      BARE_AUTHORIZATION_HEADER,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    );
  return (
    redactQueryValues(withoutAuthHeaders)
      // Bugfix (security): префиксные токены без secret-ключа.
      .replace(PREFIXED_TOKEN, REDACTED)
      // Assignment-секреты: только ключ с секретным сегментом.
      .replace(
        // Bugfix: незакавыченное значение не должно захватывать закрывающую кавычку
        // (`access_key=<redacted>'`), иначе URL-аргумент теряет кавычку.
        /\b([A-Za-z0-9_.-]+)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&;|"']+)/gu,
        (match, key: string, separator: string) =>
          SECRET_KEY_SEGMENT.test(key) ? `${key}${separator}${REDACTED}` : match,
      )
      .replace(/\/\/[^\s/@:]+:[^\s/@]+@/gu, `//${REDACTED}@`)
  );
}

const NAME_KIND_RULES: ReadonlyArray<{ kind: WorkspaceScriptKind; pattern: RegExp }> = [
  { kind: "test", pattern: /^(?:test|tests|spec|unit|e2e|integration|coverage)(?:$|[-:_])/u },
  { kind: "lint", pattern: /^lint(?:$|[-:_])/u },
  {
    kind: "typecheck",
    pattern: /^(?:typecheck|type-check|types-check|check-types|typegen-check)(?:$|[-:_])/u,
  },
  { kind: "build", pattern: /^(?:build|compile|bundle)(?:$|[-:_])/u },
  { kind: "dev", pattern: /^(?:dev|develop|serve|start|watch)(?:$|[-:_])/u },
];

const COMMAND_KIND_RULES: ReadonlyArray<{ kind: WorkspaceScriptKind; pattern: RegExp }> = [
  { kind: "test", pattern: /\b(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress)\b/iu },
  {
    kind: "lint",
    pattern: /\b(?:eslint|oxlint|stylelint|biome\s+(?:check|lint)|prettier\s+--check)\b/iu,
  },
  {
    kind: "typecheck",
    pattern: /\b(?:tsc|vue-tsc|tsgo)\b[^&|;]*--noEmit\b|\btypecheck\b/iu,
  },
  {
    kind: "build",
    pattern:
      /\b(?:vite\s+build|webpack|rollup|esbuild|tsc\s+-b|turbo\s+(?:run\s+)?build|nx\s+build|next\s+build|bun\s+build|tsup)\b/iu,
  },
  {
    kind: "dev",
    pattern:
      /\b(?:vite|next\s+dev|nodemon|tsx\s+watch|turbo\s+(?:run\s+)?dev|webpack\s+serve|wrangler\s+dev)\b/iu,
  },
];

export function classifyScripts(
  scripts: Readonly<Record<string, string>>,
): Record<WorkspaceScriptKind, WorkspaceScriptClassification[]> {
  const classified: Record<WorkspaceScriptKind, WorkspaceScriptClassification[]> = {
    test: [],
    lint: [],
    typecheck: [],
    build: [],
    dev: [],
  };
  for (const name of Object.keys(scripts).sort((left, right) => left.localeCompare(right))) {
    const command = scripts[name] ?? "";
    const normalizedName = name.toLowerCase().replace(/\s+/gu, "-");
    const nameRule = NAME_KIND_RULES.find((rule) => rule.pattern.test(normalizedName));
    if (nameRule) {
      classified[nameRule.kind].push({ name, command, kind: nameRule.kind, matchedBy: "name" });
      continue;
    }
    const commandRule = COMMAND_KIND_RULES.find((rule) => rule.pattern.test(command));
    if (commandRule) {
      classified[commandRule.kind].push({
        name,
        command,
        kind: commandRule.kind,
        matchedBy: "command",
      });
    }
  }
  return classified;
}

function parseMonorepoFacts(
  present: ReadonlySet<string>,
  packageJson: ParsedPackageJson | undefined,
  text: ReadonlyMap<string, string>,
): WorkspaceFacts["monorepo"] {
  const workspaces: string[] = [];
  for (const path of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    const source = text.get(path);
    if (source) workspaces.push(...parsePnpmWorkspacePackages(source));
  }
  const packageWorkspaces = packageJson?.workspaces;
  if (Array.isArray(packageWorkspaces)) {
    workspaces.push(...packageWorkspaces.filter(isShortString));
  } else if (isRecord(packageWorkspaces) && Array.isArray(packageWorkspaces.packages)) {
    workspaces.push(...packageWorkspaces.packages.filter(isShortString));
  }
  const lernaSource = text.get("lerna.json");
  if (lernaSource) {
    try {
      const lerna: unknown = JSON.parse(lernaSource);
      if (isRecord(lerna) && Array.isArray(lerna.packages)) {
        workspaces.push(...lerna.packages.filter(isShortString));
      }
    } catch {
      // Битый lerna.json не должен ломать facts: рассматриваем как отсутствие workspaces.
    }
  }
  const unique = uniqueStrings(workspaces).slice(0, MAX_WORKSPACES);
  const isMonorepo =
    present.has("pnpm-workspace.yaml") ||
    present.has("pnpm-workspace.yml") ||
    present.has("lerna.json") ||
    unique.length > 0;
  return {
    isMonorepo,
    ...(unique.length > 0 ? { workspaces: unique } : {}),
  };
}

function parsePnpmWorkspacePackages(source: string): string[] {
  const packages: string[] = [];
  let inPackages = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      inPackages = /^packages\s*:/u.test(line.trim());
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s*(.+)$/u.exec(line);
    if (item?.[1]) packages.push(stripQuotes(item[1].trim()));
    if (packages.length >= MAX_WORKSPACES) break;
  }
  return packages.filter(isShortString);
}

function parseToolchainFacts(
  packageJson: ParsedPackageJson | undefined,
  text: ReadonlyMap<string, string>,
): WorkspaceToolchainFacts {
  const miseSource = text.get("mise.toml") ?? text.get(".mise.toml");
  const mise = parseMiseTools(miseSource);
  const engines = extractStringRecord(packageJson?.engines);
  const packageManagerDeclaration =
    typeof packageJson?.packageManager === "string"
      ? boundedVersion(packageJson.packageManager)
      : undefined;
  const node =
    firstBoundedVersion(text.get(".nvmrc"), text.get(".node-version"), mise?.node, engines?.node) ??
    undefined;
  const packageManager =
    packageManagerDeclaration ??
    firstBoundedVersion(engines?.pnpm, engines?.yarn, engines?.npm, engines?.bun) ??
    undefined;
  const engineVersions = engines
    ? Object.fromEntries(
        Object.entries(engines).filter(([key]) => ["npm", "yarn", "pnpm", "bun"].includes(key)),
      )
    : undefined;
  return {
    ...(node ? { node } : {}),
    nodeRuntime: process.version,
    ...(packageManager ? { packageManager } : {}),
    ...(mise ? { mise } : {}),
    ...(engineVersions && Object.keys(engineVersions).length > 0
      ? { engines: engineVersions }
      : {}),
  };
}

function parseMiseTools(source: string | undefined): Record<string, string> | undefined {
  if (!source) return undefined;
  const tools: Record<string, string> = {};
  let inTools = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools) continue;
    const entry = /^([A-Za-z0-9_.-]{1,64})\s*=\s*(.+)$/u.exec(line);
    if (!entry?.[1] || !entry[2]) continue;
    const value = boundedVersion(stripQuotes(entry[2].replace(/\s+#.*$/u, "").trim()));
    if (!value) continue;
    tools[entry[1]] = value;
    if (Object.keys(tools).length >= MAX_MISE_ENTRIES) break;
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

function extractStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/u.test(key) || typeof entry !== "string") continue;
    const bounded = boundedVersion(entry);
    if (bounded) result[key] = bounded;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function firstBoundedVersion(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const bounded = boundedVersion(value);
    if (bounded) return bounded;
  }
  return undefined;
}

function boundedVersion(value: string | undefined): string | undefined {
  // Bugfix (security): версия из файла может содержать newline/табы; после
  // нормализации она не создаёт отдельную строку и всё ещё ограничена длиной.
  const trimmed = value === undefined ? undefined : toSingleLine(value);
  if (!trimmed || trimmed.length > MAX_VERSION_DECLARATION_LENGTH) return undefined;
  return trimmed;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isShortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
