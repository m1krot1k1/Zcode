import { extname } from "node:path";
import type { ISyntaxValidator, SyntaxErrorLocation, SyntaxValidationDiagnostic } from "./contract.js";

interface ScanResult {
  readonly errors: Array<{ line: number; column: number; message: string }>;
}

interface DelimiterEntry {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

const REGEX_PRECEDING_CHARS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
]);

/**
 * Быстрый пре-коммитный валидатор синтаксической целостности изменённых буферов (F-07).
 * Работает без тяжёлых зависимостей (без full-program typecheck): сканер баланса конструкций
 * с корректной обработкой строк, шаблонных литералов, комментариев и regex-литералов,
 * строгий JSON-парсер, отступы и двоеточия Python, а также проверка TOML/YAML-подобных конфигов.
 */
export class SyntaxValidator implements ISyntaxValidator {
  validateBuffer(params: {
    readonly filePath: string;
    readonly content: string;
    readonly beforeContent?: string | null;
  }): SyntaxValidationDiagnostic {
    const language = resolveLanguage(params.filePath);
    const nextErrors = collectErrors(language, params.content);
    const introducedErrors =
      params.beforeContent === undefined || params.beforeContent === null
        ? nextErrors.length
        : Math.max(0, nextErrors.length - collectErrors(language, params.beforeContent).length);

    const firstError = nextErrors[0];
    if (nextErrors.length === 0) {
      return { path: params.filePath, language, valid: true, preExistingErrors: 0, introducedErrors: 0 };
    }

    return {
      path: params.filePath,
      language,
      valid: false,
      preExistingErrors: Math.max(0, nextErrors.length - introducedErrors),
      introducedErrors,
      message: firstError?.message,
      line: firstError?.line,
      column: firstError?.column,
      firstError: firstError
        ? {
            line: firstError.line,
            column: firstError.column,
            message: firstError.message,
            snippet: buildSnippet(params.content, firstError.line),
          }
        : undefined,
    };
  }
}

export function createSyntaxValidator(): ISyntaxValidator {
  return new SyntaxValidator();
}

function resolveLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    case ".py":
      return "python";
    case ".toml":
      return "toml";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
    case ".kt":
      return "jvm";
    default:
      return "text";
  }
}

function collectErrors(language: string, content: string): Array<{ line: number; column: number; message: string }> {
  if (content.trim().length === 0) return [];
  switch (language) {
    case "json":
      return validateJson(content);
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx":
    case "go":
    case "rust":
    case "jvm":
      return scanBalancedCode(content).errors;
    case "python":
      return [...scanBalancedCode(content, { python: true }).errors, ...validatePythonIndentation(content)];
    case "yaml":
      return validateYamlTabs(content);
    case "toml":
      return scanBalancedCode(content, { python: false }).errors;
    default:
      return [];
  }
}

function validateJson(content: string): Array<{ line: number; column: number; message: string }> {
  try {
    JSON.parse(content);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = /position\s+(\d+)/i.exec(message);
    const offset = positionMatch ? Number(positionMatch[1]) : 0;
    const located = locateOffset(content, Number.isFinite(offset) ? offset : 0);
    return [{ line: located.line, column: located.column, message: `Invalid JSON: ${message}` }];
  }
}

/**
 * Сканер баланса скобок/кавычек с состоянием строки, шаблона, комментария и regex.
 * Возвращает первую реальную синтаксическую поломку, если она появилась.
 */
function scanBalancedCode(content: string, options: { python: boolean } = { python: false }): ScanResult {
  const errors: ScanResult["errors"] = [];
  const stack: DelimiterEntry[] = [];
  const templateStack: number[] = [];

  let line = 1;
  let column = 1;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inRegex = false;
  let inCharClass = false;
  let escaped = false;
  let prevSignificant = "";
  let stringStart: { line: number; column: number; quote: string } | undefined;

  const openingFor: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    const next = content[i + 1];

    if (ch === "\n") {
      if (inSingle || inDouble) {
        errors.push({
          line: stringStart?.line ?? line,
          column: stringStart?.column ?? column,
          message: `Unterminated string literal (${stringStart?.quote ?? "'"}).`,
        });
        inSingle = false;
        inDouble = false;
        stringStart = undefined;
      }
      if (inRegex) {
        errors.push({ line, column, message: "Unterminated regular expression literal." });
        inRegex = false;
        inCharClass = false;
      }
      inLineComment = false;
      line += 1;
      column = 1;
      escaped = false;
      continue;
    }

    if (inLineComment) {
      column += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
        column += 2;
        continue;
      }
      column += 1;
      continue;
    }
    if (escaped) {
      escaped = false;
      column += 1;
      continue;
    }
    if (inSingle || inDouble) {
      if (ch === "\\") {
        escaped = true;
      } else if ((inSingle && ch === "'") || (inDouble && ch === '"')) {
        if (inSingle) inSingle = false;
        else inDouble = false;
        stringStart = undefined;
        prevSignificant = "x";
      }
      column += 1;
      continue;
    }
    if (inBacktick) {
      if (ch === "\\") {
        escaped = true;
        column += 1;
        continue;
      }
      if (ch === "`") {
        inBacktick = false;
        prevSignificant = "x";
        column += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        templateStack.push(1);
        inBacktick = false;
        stack.push({ char: "{", line, column });
        i += 1;
        column += 2;
        prevSignificant = "{";
        continue;
      }
      column += 1;
      continue;
    }
    if (inRegex) {
      if (ch === "\\") {
        i += 1;
        column += 2;
        continue;
      }
      if (ch === "[") inCharClass = true;
      else if (ch === "]") inCharClass = false;
      else if (ch === "/" && !inCharClass) {
        inRegex = false;
        prevSignificant = "x";
      }
      column += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      column += 2;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      column += 2;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      stringStart = { line, column, quote: "'" };
      column += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      stringStart = { line, column, quote: '"' };
      column += 1;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      column += 1;
      continue;
    }
    if (ch === "/" && (prevSignificant === "" || REGEX_PRECEDING_CHARS.has(prevSignificant))) {
      inRegex = true;
      inCharClass = false;
      column += 1;
      continue;
    }
    if (!options.python && ch === "#") {
      column += 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push({ char: ch, line, column });
      prevSignificant = ch;
      column += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const expected = openingFor[ch]!;
      const top = stack.pop();
      if (top?.char === "{") {
        templateStack.pop();
      }
      if (!top || top.char !== expected) {
        errors.push({
          line,
          column,
          message: `Unexpected '${ch}'${top ? ` while '${top.char}' opened at ${top.line}:${top.column}` : ""}.`,
        });
        prevSignificant = ch;
        column += 1;
        continue;
      }
      if (top.char === "{" && templateStack.length > 0 && stack.length < templateStack[templateStack.length - 1]!) {
        inBacktick = true;
      }
      prevSignificant = ch;
      column += 1;
      continue;
    }
    if (ch.trim().length > 0) {
      prevSignificant = ch;
    }
    column += 1;
  }

  if (inBlockComment) {
    errors.push({ line, column, message: "Unterminated block comment." });
  }
  if (inBacktick) {
    errors.push({ line, column, message: "Unterminated template literal." });
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    errors.push({
      line: top.line,
      column: top.column,
      message: `Unclosed '${top.char}' opened at ${top.line}:${top.column}.`,
    });
  }

  return { errors };
}

function validatePythonIndentation(content: string): ScanResult["errors"] {
  const errors: ScanResult["errors"] = [];
  const lines = content.split("\n");
  let expectedIndentStack: number[] = [0];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmedRight = raw.replace(/\s+$/u, "");
    if (trimmedRight.trim().length === 0) continue;
    if (/^#/u.test(trimmedRight.trim())) continue;

    const indentMatch = /^[ \t]*/u.exec(trimmedRight);
    const indent = indentMatch ? indentMatch[0] : "";
    if (indent.includes("\t") && indent.includes(" ")) {
      errors.push({ line: i + 1, column: 1, message: "Mixed tabs and spaces in Python indentation." });
      continue;
    }
    const indentWidth = indent.length;
    const currentLevel = expectedIndentStack[expectedIndentStack.length - 1]!;

    if (indentWidth > currentLevel) {
      expectedIndentStack.push(indentWidth);
    } else if (indentWidth < currentLevel) {
      while (expectedIndentStack.length > 1 && expectedIndentStack[expectedIndentStack.length - 1]! > indentWidth) {
        expectedIndentStack.pop();
      }
      if (expectedIndentStack[expectedIndentStack.length - 1] !== indentWidth) {
        errors.push({
          line: i + 1,
          column: 1,
          message: `Inconsistent dedent: indentation ${indentWidth} does not match any outer block level.`,
        });
      }
    }

    const endsWithBlockOpener = /:\s*(#.*)?$/u.test(trimmedRight);
    if (endsWithBlockOpener) {
      const hasInlineBody = /:\s*[^\s#]/u.test(trimmedRight);
      if (hasInlineBody) continue;
      const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
      if (nextNonEmpty === undefined) {
        errors.push({ line: i + 1, column: trimmedRight.length, message: "Block opener without an indented body." });
        continue;
      }
      const nextIndent = (/^[ \t]*/u.exec(lines[nextNonEmpty] ?? "")?.[0] ?? "").length;
      if (nextIndent <= indentWidth) {
        errors.push({
          line: i + 1,
          column: trimmedRight.length,
          message: "Expected an indented block after ':'.",
        });
      }
    }
  }

  return errors;
}

function findNextNonEmptyLine(lines: readonly string[], from: number): number | undefined {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0 || /^\s*#/u.test(line)) continue;
    return i;
  }
  return undefined;
}

function validateYamlTabs(content: string): ScanResult["errors"] {
  const errors: ScanResult["errors"] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\t+\S/u.test(lines[i]!)) {
      errors.push({ line: i + 1, column: 1, message: "YAML indentation must use spaces, not tabs." });
      break;
    }
  }
  return errors;
}

function locateOffset(content: string, offset: number): { line: number; column: number } {
  const bounded = Math.min(Math.max(0, offset), Math.max(0, content.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < bounded; i += 1) {
    if (content[i] === "\n") {
      line += 1;
      lastNewline = i;
    }
  }
  return { line, column: bounded - lastNewline };
}

function buildSnippet(content: string, line: number, radius = 2): string {
  const lines = content.split("\n");
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  const width = String(end).length;
  const rendered: string[] = [];
  for (let i = start; i < end; i += 1) {
    const marker = i + 1 === line ? ">" : " ";
    rendered.push(`${marker} ${String(i + 1).padStart(width, " ")} | ${lines[i] ?? ""}`);
  }
  return rendered.join("\n");
}
