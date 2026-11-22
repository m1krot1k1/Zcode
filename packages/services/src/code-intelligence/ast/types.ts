/** Структурные факты одного файла, полученные AST- или текстовым чанкером. */
export interface ParsedSymbol {
  name: string;
  /** Числовой код вида из `SYMBOL_KIND`. */
  kind: number;
  /** 1-based, включительно. */
  startLine: number;
  endLine: number;
  /** Индекс родителя в массиве `symbols`; `null` — верхний уровень. */
  parentIndex: number | null;
  exported: boolean;
  /** Первая строка объявления, усечённая до 500 символов. */
  signature: string;
}

export interface ParsedChunk {
  startLine: number;
  endLine: number;
  content: string;
  /** Заголовок области видимости: `path | Class.method`, нужен модели для контекста. */
  scopeHeader: string;
  /** Индекс основного символа в `symbols`; `null` — файловый блок. */
  symbolIndex: number | null;
  tokenCount: number;
}

export interface ParsedImport {
  specifier: string;
  /** Импортированные имена; пустой массив — импорт модуля целиком. */
  names: string[];
  /**
   * Пары «локальный алиас → импортированное имя» (`import { a as b }`).
   * Нужны, чтобы вызов `b()` резолвился в символ `a`, а не терялся как неизвестный.
   */
  aliases?: Array<{ imported: string; local: string }>;
  line: number;
}

export interface ParsedCall {
  name: string;
  line: number;
  enclosingSymbolIndex: number | null;
}

export interface ParsedReference {
  name: string;
  line: number;
  enclosingSymbolIndex: number | null;
}

export interface ParsedHeritage {
  name: string;
  relation: "extends" | "implements";
  symbolIndex: number;
  line: number;
}

export interface ParsedFile {
  languageId: number;
  languageName: string;
  /** `true`, если файл разобран грамматикой tree-sitter; `false` — структурным текстовым чанкером. */
  usedTreeSitter: boolean;
  symbols: ParsedSymbol[];
  chunks: ParsedChunk[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  references: ParsedReference[];
  heritage: ParsedHeritage[];
}

export function emptyParsedFile(languageId: number, languageName: string): ParsedFile {
  return {
    languageId,
    languageName,
    usedTreeSitter: false,
    symbols: [],
    chunks: [],
    imports: [],
    calls: [],
    references: [],
    heritage: [],
  };
}

/** Оценка числа токенов: 4 символа на токен — устойчивое приближение для кода и текста. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
