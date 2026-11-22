// Static regression guard for docs/specs/remote-component-update-ux.md:
// remote component update/restart may restart only the ZCode core/service,
// never the host OS. The guard fails if a real power command appears in the
// remote update path; comments are ignored, string literals stay visible.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");

/**
 * Явный минимум guard'а: файлы update/release/service/startup-пути, которые
 * обязаны проверяться, даже если path-based выборка перестанет их находить.
 * Отсутствие такого файла — ошибка guard'а, а не тихое сужение покрытия.
 */
const EXPLICIT_UPDATE_SOURCES = [
  "packages/zcode-server-cli/src/runtime/updateCommand.ts",
  "packages/zcode-server-cli/src/runtime/updateErrors.ts",
  "packages/zcode-server-cli/src/runtime/updateHandoff.ts",
  "packages/zcode-server-cli/src/runtime/updatePreparation.ts",
  "packages/zcode-server-cli/src/runtime/updateReadiness.ts",
  "packages/zcode-server-cli/src/runtime/releaseInstaller.ts",
  "packages/zcode-server-cli/src/runtime/releaseManager.ts",
  "packages/zcode-server-cli/src/runtime/releaseDownload.ts",
  "packages/zcode-server-cli/src/runtime/serviceInstallation.ts",
  "packages/zcode-server-cli/src/runtime/startupRecovery.ts",
  "packages/zcode-server-cli/src/runtime/componentCache.ts",
  "packages/zcode-server-cli/src/supervisor/supervisor.ts",
  "packages/zcode-server-cli/src/platform/serviceManager.ts",
  "packages/server/src/source-server/transportAdapter.ts",
  "packages/desktop/src/host/source-server-connection/update.ts",
] as const;

/**
 * Path-based выборка: широкое дерево Core CLI фильтруется по сегментам имени
 * (update/release/supervisor/service/lifecycle/recovery), а каталоги
 * source-server проверяются целиком — они принадлежат удалённому обновлению.
 */
const SCAN_ROOTS = [
  { path: "packages/zcode-server-cli/src", selection: "pathKeywords" },
  { path: "packages/server/src/source-server", selection: "allTypescript" },
  { path: "packages/desktop/src/host/source-server-connection", selection: "allTypescript" },
] as const;

const UPDATE_PATH_KEYWORDS = [
  "update",
  "release",
  "supervisor",
  "service",
  "lifecycle",
  "recovery",
] as const;

const STRING_QUOTES = new Set(['"', "'", "`"]);
const REGEX_PREFIX_CHARS = "(,=:[!&|?{};+-*%<>~^/";
const TEST_FILE_SUFFIX = /\.(?:test|spec|d)\.ts$/;

/** Сегменты пути в нижнем регистре: updatePreparation -> update, preparation. */
function pathTokens(filePath: string): readonly string[] {
  return relative(repoRoot, filePath)
    .replace(/\.(?:d\.)?ts$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

function isUpdatePath(filePath: string): boolean {
  return pathTokens(filePath).some((token) =>
    (UPDATE_PATH_KEYWORDS as readonly string[]).includes(token),
  );
}

function collectTypescriptSources(directory: string): readonly string[] {
  if (!existsSync(directory)) {
    throw new Error(`Guard scan root is missing: ${relative(repoRoot, directory)}`);
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypescriptSources(entryPath));
    } else if (entry.isFile() && entryPath.endsWith(".ts") && !TEST_FILE_SUFFIX.test(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectGuardSources(): readonly string[] {
  const sources = new Set(EXPLICIT_UPDATE_SOURCES.map((source) => resolve(repoRoot, source)));
  for (const root of SCAN_ROOTS) {
    for (const file of collectTypescriptSources(resolve(repoRoot, root.path))) {
      if (root.selection === "allTypescript" || isUpdatePath(file)) sources.add(file);
    }
  }
  return [...sources].sort();
}

/**
 * Пропускает `//`-комментарий, возвращая индекс перевода строки: сам перевод
 * строки остаётся в разборе, чтобы не склеивать соседние строки кода.
 */
function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline;
}

/** Пропускает блочный комментарий и возвращает индекс сразу после его конца. */
function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
}

/**
 * Читает строковый/шаблонный литерал целиком. Содержимое литерала сохраняется:
 * именно там живут shell-команды, которые guard обязан видеть.
 */
function readStringLiteral(
  source: string,
  start: number,
): { readonly text: string; readonly end: number } {
  const quote = source[start] ?? "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      index = skipTemplateExpression(source, index + 2);
      continue;
    }
    if (char === quote) {
      return { text: source.slice(start, index + 1), end: index + 1 };
    }
    index += 1;
  }
  return { text: source.slice(start), end: source.length };
}

/**
 * Пропускает `${...}` внутри шаблонной строки, учитывая вложенные скобки,
 * литералы и комментарии. Это сканер, а не полный парсер JS.
 */
function skipTemplateExpression(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (STRING_QUOTES.has(char)) {
      index = readStringLiteral(source, index).end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/** Эвристика: `/` открывает regex-литерал, а не деление, по предыдущему символу. */
function isRegexLiteralStart(emitted: readonly string[]): boolean {
  for (let index = emitted.length - 1; index >= 0; index -= 1) {
    const char = emitted[index] ?? "";
    if (char.trim().length === 0) continue;
    return REGEX_PREFIX_CHARS.includes(char);
  }
  return true;
}

function readRegexLiteral(
  source: string,
  start: number,
): { readonly text: string; readonly end: number } {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inCharacterClass = true;
    else if (char === "]") inCharacterClass = false;
    else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && /[A-Za-z]/.test(source[index] ?? "")) index += 1;
      return { text: source.slice(start, index), end: index };
    } else if (char === "\n") {
      // До перевода строки литерал не закрылся — это деление, отдаём как есть.
      return { text: source.slice(start, index), end: index };
    }
    index += 1;
  }
  return { text: source.slice(start), end: source.length };
}

/**
 * Убирает комментарии, не разрезая строковые литералы: `//` и блочный маркер
 * внутри кавычек или шаблонной строки остаются видимым кодом. Раньше regex
 * `(^|[^:])\/\/[^\n]*` вырезал остаток строки после `//` в литерале и тем самым
 * прятал реальную power-команду от guard'а.
 */
function stripComments(source: string): string {
  const emitted: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "/" && next === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && next === "*") {
      emitted.push(" ");
      index = skipBlockComment(source, index);
      continue;
    }
    if (STRING_QUOTES.has(char)) {
      const literal = readStringLiteral(source, index);
      emitted.push(literal.text);
      index = literal.end;
      continue;
    }
    if (char === "/" && isRegexLiteralStart(emitted)) {
      const literal = readRegexLiteral(source, index);
      emitted.push(literal.text);
      index = literal.end;
      continue;
    }
    emitted.push(char);
    index += 1;
  }
  return emitted.join("");
}

// `shutdown` без аргументов встречается как внутренняя RPC-команда Core
// (`{ command: "shutdown" }`), поэтому OS-выключение ищем по вызову процесса,
// его аргументам или shell-строке, а не по одному слову.
const FORBIDDEN_POWER_COMMANDS: readonly RegExp[] = [
  // Имена системных команд: reboot/poweroff/halt, а также telinit/init с уровнем 0/6.
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\b(?:telinit|init)\s+[06]\b/i,
  // Аргументная форма: execFileSync("telinit", ["6"]) / spawn("init", ["0"]).
  /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync|run|runCommand|execute)\s*\(\s*["'`](?:telinit|init)["'`]\s*,\s*\[\s*["'`]?[06]["'`]?/i,
  /\bsystemctl\s+(?:--?\S+\s+)*reboot\b/i,
  /\bsudo\s+(?:-\S+\s+)*(?:reboot|poweroff|halt|shutdown)\b/i,
  /["'`](?:sudo\s+)?(?:usr\/)?(?:s?bin\/)?shutdown["'`]\s*,\s*\[/i,
  /\bshutdown\s+(?:-{1,2}[\w-]+|now|\+\d+)\b/i,
];

function findForbiddenPowerCommands(source: string): readonly string[] {
  const code = stripComments(source);
  return FORBIDDEN_POWER_COMMANDS.flatMap((pattern) => {
    const match = pattern.exec(code);
    return match ? [match[0]] : [];
  });
}

const guardSources = collectGuardSources().map((source) => relative(repoRoot, source));

describe("remote update never reboots the host", () => {
  it("explicit guard sources exist", () => {
    const missing = EXPLICIT_UPDATE_SOURCES.filter(
      (source) => !existsSync(resolve(repoRoot, source)),
    );
    expect(missing).toEqual([]);
  });

  it("path-based scan covers update, release, service and recovery modules", () => {
    expect(guardSources.length).toBeGreaterThanOrEqual(30);
    for (const expected of [
      "packages/zcode-server-cli/src/packaging/remoteAssetRelease.ts",
      "packages/zcode-server-cli/src/supervisor/crashBudget.ts",
      "packages/server/src/source-server/sourceServerReleaseDownload.ts",
      "packages/desktop/src/host/source-server-connection/lifecycle.ts",
      "packages/desktop/src/host/source-server-connection/manager.ts",
      "packages/desktop/src/host/source-server-connection/recovery.ts",
    ]) {
      expect(guardSources, expected).toContain(expected);
    }
  });

  it.each(guardSources)("%s contains no OS power command", (relativeSource) => {
    const source = readFileSync(resolve(repoRoot, relativeSource), "utf-8");
    expect(source.length).toBeGreaterThan(0);
    expect(findForbiddenPowerCommands(source)).toEqual([]);
  });

  it("detects real power commands so the guard cannot silently rot", () => {
    const realCommands = [
      'await execFile("reboot");',
      'execFileSync("reboot");',
      'await runCommand("sudo reboot");',
      'spawn("systemctl", ["reboot"]);',
      'await exec("sudo poweroff");',
      'execFileSync("shutdown", ["-r"]);',
      'run("shutdown", ["-r", "now"]);',
      'exec("halt");',
      'run("sudo shutdown -h now");',
      'runCommand("init 6");',
      'runCommand("sudo telinit 6");',
      'execFileSync("telinit", ["6"]);',
      'spawn("init", ["0"]);',
    ];
    for (const command of realCommands) {
      expect(findForbiddenPowerCommands(command), command).not.toEqual([]);
    }
  });

  it("does not treat comment markers inside string literals as comments", () => {
    // Контрпример к старому стрипперу: литерал "//" больше не прячет вызов ниже.
    const hiddenByLineMarker = [
      'const marker = "//"; execFileSync("reboot");',
      "const marker = '//'; execFileSync(\"reboot\");",
      'const marker = `//`; execFileSync("reboot");',
    ];
    // Блочный маркер в литерале раньше вырезал код до закрывающего маркера в конце строки.
    const hiddenByBlockMarker = 'const opener = "/*"; execFileSync("reboot"); // trailing */';
    const cases = [...hiddenByLineMarker, hiddenByBlockMarker];
    for (const source of cases) {
      expect(findForbiddenPowerCommands(source), source).not.toEqual([]);
    }
  });

  it("does not treat comment markers inside a regex literal as comments", () => {
    const source = 'const urlPattern = /https?:\\/\\//; execFileSync("reboot");';
    expect(findForbiddenPowerCommands(source)).not.toEqual([]);
  });

  it("ignores comments, docs and the internal Core shutdown protocol command", () => {
    const benign = [
      "// Never call reboot or poweroff here.",
      "/* systemctl reboot and sudo poweroff stay out of the update path. */",
      'core.send({ command: "shutdown" });',
      'if (message.command === "shutdown") { void shutdown("requested"); }',
      'await executor.run("systemctl", ["--user", "daemon-reload"]);',
      'const command = z.object({ command: z.literal("shutdown") });',
    ].join("\n");
    expect(findForbiddenPowerCommands(benign)).toEqual([]);
  });
});
