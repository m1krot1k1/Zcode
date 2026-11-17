const DEFAULT_TAB_WIDTH = 4;

export interface IndentProfile {
  readonly baseIndent: string;
  readonly baseColumns: number;
  readonly usesTabs: boolean;
  readonly strippedLines: readonly string[];
}

export function extractLeadingWhitespace(line: string): string {
  const match = /^[\t ]*/.exec(line);
  return match ? match[0] : "";
}

export function measureIndentColumns(indent: string, tabWidth = DEFAULT_TAB_WIDTH): number {
  let columns = 0;
  for (let i = 0; i < indent.length; i += 1) {
    if (indent[i] === "\t") {
      columns += tabWidth - (columns % tabWidth);
    } else {
      columns += 1;
    }
  }
  return columns;
}

export function computeIndentProfile(lines: readonly string[], tabWidth = DEFAULT_TAB_WIDTH): IndentProfile {
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return {
      baseIndent: "",
      baseColumns: 0,
      usesTabs: false,
      strippedLines: [...lines],
    };
  }

  let minLineIndent = extractLeadingWhitespace(nonEmptyLines[0]!);
  let minColumns = measureIndentColumns(minLineIndent, tabWidth);
  let tabIndentedCount = 0;

  for (const line of nonEmptyLines) {
    const ws = extractLeadingWhitespace(line);
    if (ws.includes("\t")) {
      tabIndentedCount += 1;
    }
    const cols = measureIndentColumns(ws, tabWidth);
    if (cols < minColumns) {
      minColumns = cols;
      minLineIndent = ws;
    }
  }

  const strippedLines = lines.map((line) => {
    if (line.trim().length === 0) {
      return "";
    }
    return sliceLeadingColumns(line, minColumns, tabWidth);
  });

  return {
    baseIndent: minLineIndent,
    baseColumns: minColumns,
    usesTabs: tabIndentedCount > nonEmptyLines.length / 2,
    strippedLines,
  };
}

/**
 * Пересчитывает отступы строк замены при совпадении блока со сдвигом базового отступа.
 * Сохраняет все внутренние сдвиги вложенных блоков (if / for / def / class),
 * выравнивая базовый уровень под реальный отступ найденного участка в файле.
 */
export function reindentReplacementLines(
  replacementLines: readonly string[],
  matchedBaseIndent: string,
  searchBaseIndent: string,
  tabWidth = DEFAULT_TAB_WIDTH,
): string[] {
  if (matchedBaseIndent === searchBaseIndent) {
    return [...replacementLines];
  }

  const matchedCols = measureIndentColumns(matchedBaseIndent, tabWidth);
  const searchCols = measureIndentColumns(searchBaseIndent, tabWidth);
  const matchedUsesTabs =
    matchedBaseIndent.length > 0 &&
    matchedBaseIndent.includes("\t") &&
    !matchedBaseIndent.includes(" ");

  return replacementLines.map((line) => {
    if (line.trim().length === 0) {
      return "";
    }

    // Быстрый точный путь: строка начинается ровно с searchBaseIndent
    if (searchBaseIndent.length > 0 && line.startsWith(searchBaseIndent)) {
      const rest = line.slice(searchBaseIndent.length);
      const innerWs = extractLeadingWhitespace(rest);
      const body = rest.slice(innerWs.length);
      if (matchedUsesTabs && innerWs.length > 0 && !innerWs.includes("\t")) {
        const innerCols = measureIndentColumns(innerWs, tabWidth);
        return `${matchedBaseIndent}${formatColumnsAsIndent(innerCols, true, tabWidth)}${body}`;
      }
      return `${matchedBaseIndent}${rest}`;
    }

    if (searchBaseIndent.length === 0) {
      const innerWs = extractLeadingWhitespace(line);
      const body = line.slice(innerWs.length);
      if (matchedUsesTabs && innerWs.length > 0 && !innerWs.includes("\t")) {
        const innerCols = measureIndentColumns(innerWs, tabWidth);
        return `${matchedBaseIndent}${formatColumnsAsIndent(innerCols, true, tabWidth)}${body}`;
      }
      return `${matchedBaseIndent}${line}`;
    }

    // Общий случай: строка в newString имеет меньший или смешанный отступ относительно searchBaseIndent
    const lineWs = extractLeadingWhitespace(line);
    const body = line.slice(lineWs.length);
    const lineCols = measureIndentColumns(lineWs, tabWidth);
    const relativeCols = lineCols - searchCols;
    const targetCols = Math.max(0, matchedCols + relativeCols);
    return `${formatColumnsAsIndent(targetCols, matchedUsesTabs, tabWidth)}${body}`;
  });
}

export function reindentReplacementText(params: {
  matchedBlock: string;
  searchBlock: string;
  replacementText: string;
}): string {
  const matchedLines = splitPreservingTrailingEmpty(params.matchedBlock);
  const searchLines = splitPreservingTrailingEmpty(params.searchBlock);
  const replacementLines = params.replacementText.split("\n");

  const hadTrailingNewline =
    params.replacementText.endsWith("\n") &&
    replacementLines.length > 1 &&
    replacementLines[replacementLines.length - 1] === "";

  const effectiveReplacementLines = hadTrailingNewline
    ? replacementLines.slice(0, -1)
    : replacementLines;

  const matchedProfile = computeIndentProfile(matchedLines);
  const searchProfile = computeIndentProfile(searchLines);

  const reindented = reindentReplacementLines(
    effectiveReplacementLines,
    matchedProfile.baseIndent,
    searchProfile.baseIndent,
  );

  return hadTrailingNewline ? `${reindented.join("\n")}\n` : reindented.join("\n");
}

function sliceLeadingColumns(line: string, columnsToDrop: number, tabWidth: number): string {
  if (columnsToDrop <= 0) return line;
  let consumedCols = 0;
  let index = 0;
  while (index < line.length && consumedCols < columnsToDrop) {
    const ch = line[index];
    if (ch === "\t") {
      const step = tabWidth - (consumedCols % tabWidth);
      if (consumedCols + step > columnsToDrop) {
        const leftoverSpaces = consumedCols + step - columnsToDrop;
        return `${" ".repeat(leftoverSpaces)}${line.slice(index + 1)}`;
      }
      consumedCols += step;
      index += 1;
    } else if (ch === " ") {
      consumedCols += 1;
      index += 1;
    } else {
      break;
    }
  }
  return line.slice(index);
}

function formatColumnsAsIndent(columns: number, useTabs: boolean, tabWidth: number): string {
  if (columns <= 0) return "";
  if (!useTabs) {
    return " ".repeat(columns);
  }
  const tabs = Math.floor(columns / tabWidth);
  const spaces = columns % tabWidth;
  return `${"\t".repeat(tabs)}${" ".repeat(spaces)}`;
}

function splitPreservingTrailingEmpty(block: string): string[] {
  const lines = block.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
