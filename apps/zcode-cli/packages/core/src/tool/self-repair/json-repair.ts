import {
  RAW_MALFORMED_TOOL_INPUT_SYMBOL,
  type RawMalformedToolInputEnvelope,
  type RepairStage,
} from "./contract.js";

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export function attachRawMalformedToolInput<T extends Record<string, unknown>>(
  target: T,
  rawText: string,
): T {
  const envelope: RawMalformedToolInputEnvelope = {
    rawText,
    byteLength: utf8ByteLength(rawText),
  };
  Object.defineProperty(target, RAW_MALFORMED_TOOL_INPUT_SYMBOL, {
    value: envelope,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return target;
}

export function readRawMalformedToolInput(
  input: unknown,
): RawMalformedToolInputEnvelope | undefined {
  if (typeof input === "string") {
    return {
      rawText: input,
      byteLength: utf8ByteLength(input),
    };
  }
  if (typeof input === "object" && input !== null) {
    const candidate = (input as Record<symbol, unknown>)[RAW_MALFORMED_TOOL_INPUT_SYMBOL];
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as RawMalformedToolInputEnvelope).rawText === "string" &&
      typeof (candidate as RawMalformedToolInputEnvelope).byteLength === "number"
    ) {
      return candidate as RawMalformedToolInputEnvelope;
    }
  }
  return undefined;
}

export interface DeterministicJsonRepairResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly appliedStages: RepairStage[];
  readonly parseError?: string;
}

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const HEX_QUAD_REGEX = /^[0-9a-fA-F]{4}$/;

/**
 * Детерминированно устраняет безопасные артефакты сериализации JSON:
 * - одинарную внешнюю обёртку markdown-блока (```json ... ```);
 * - неэкранированные управляющие символы (\n, \r, \t) и битые escape-последовательности внутри строк;
 * - висячие запятые перед `}` и `]`.
 *
 * Инвариант F-01: НИКОГДА не дописывает закрывающие кавычки или скобки к оборванному хвосту.
 */
export function repairJsonStringDeterministic(rawInput: string): DeterministicJsonRepairResult {
  const appliedStages: RepairStage[] = [];
  const addStage = (stage: RepairStage) => {
    if (!appliedStages.includes(stage)) {
      appliedStages.push(stage);
    }
  };

  let candidate = rawInput.startsWith("\uFEFF") ? rawInput.slice(1) : rawInput;

  const direct = tryParseNonNullJson(candidate);
  if (direct.ok) {
    return { ok: true, value: direct.value, appliedStages };
  }

  const strippedFence = stripSingleOuterMarkdownFence(candidate);
  if (strippedFence !== undefined) {
    candidate = strippedFence;
    addStage("strip_markdown_fences");
    const afterFence = tryParseNonNullJson(candidate);
    if (afterFence.ok) {
      return { ok: true, value: afterFence.value, appliedStages };
    }
  }

  const scanned = scanAndNormalizeJsonText(candidate);
  if (scanned.escapedControlChars) {
    addStage("escape_unescaped_control_chars");
  }
  if (scanned.fixedTrailingCommas) {
    addStage("fix_trailing_commas");
  }

  // Запрещено угадывать обрезанный хвост: незакрытая строка или скобка остаётся ошибкой парсинга.
  if (scanned.unclosedString || scanned.openDepth !== 0) {
    return {
      ok: false,
      appliedStages,
      parseError: direct.error ?? "Truncated or unbalanced JSON input",
    };
  }

  const afterScan = tryParseNonNullJson(scanned.text);
  if (afterScan.ok) {
    return { ok: true, value: afterScan.value, appliedStages };
  }

  return {
    ok: false,
    appliedStages,
    parseError: afterScan.error ?? direct.error,
  };
}

function stripSingleOuterMarkdownFence(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return undefined;
  }
  const match = /^```(?:json|JSON|javascript|js|ts)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/u.exec(
    trimmed,
  );
  if (!match?.[1]) {
    return undefined;
  }
  const inner = match[1].trim();
  return inner.length > 0 ? inner : undefined;
}

function scanAndNormalizeJsonText(text: string): {
  text: string;
  escapedControlChars: boolean;
  fixedTrailingCommas: boolean;
  unclosedString: boolean;
  openDepth: number;
} {
  let out = "";
  let inString = false;
  let escapedControlChars = false;
  let fixedTrailingCommas = false;
  let openDepth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) {
          // Оборванный обратный слэш на конце строки
          out += "\\";
          continue;
        }
        if (next === "u") {
          const quad = text.slice(i + 2, i + 6);
          if (HEX_QUAD_REGEX.test(quad)) {
            out += `\\u${quad}`;
            i += 5;
            continue;
          }
          // Невалидный \uXXXX внутри закрытой строки (например Windows путь C:\users) -> экранируем слэш
          out += "\\\\";
          escapedControlChars = true;
          continue;
        }
        if (VALID_JSON_ESCAPES.has(next)) {
          out += `\\${next}`;
          i += 1;
          continue;
        }
        // Нестандартный escape внутри строки (например \' или пути Windows)
        out += "\\\\";
        escapedControlChars = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }

      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        escapedControlChars = true;
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }

      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      openDepth += 1;
      out += ch;
      continue;
    }

    if (ch === "}" || ch === "]") {
      openDepth -= 1;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let lookahead = i + 1;
      while (lookahead < text.length && /\s/u.test(text[lookahead]!)) {
        lookahead += 1;
      }
      const nextToken = text[lookahead];
      if (nextToken === "}" || nextToken === "]") {
        fixedTrailingCommas = true;
        continue;
      }
    }

    out += ch;
  }

  return {
    text: out,
    escapedControlChars,
    fixedTrailingCommas,
    unclosedString: inString,
    openDepth,
  };
}

function tryParseNonNullJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, error: "Tool input JSON root must be an object or array" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
