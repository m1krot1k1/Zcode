/**
 * cli-diff-engine публичный контракт: 6-уровневый детерминированный движок сопоставления
 * и слияния патчей без побочных эффектов ввода-вывода (слой domain).
 */
export type CliDiffEngineId = string & { readonly __brand: "CliDiffEngineId" };

export type DiffLineEnding = "LF" | "CRLF";

/**
 * Шесть уровней каскада сопоставления патчей в порядке ослабления строгости:
 * 1. exact — побайтовое совпадение
 * 2. crlf-normalized — нормализация CRLF/LF, smart-кавычек, тире и escape-последовательностей
 * 3. line-trimmed — игнорирование краевых пробелов, префиксов Read и сдвига пустых строк
 * 4. indentation-shifted — относительный профиль отступов + reindentReplacementLines
 * 5. fuzzy-block-anchor — верхний/нижний якоря + Levenshtein similarity с ambiguity guard
 * 6. conflict-resolver — сортировка и слияние непересекающихся ханков с пересчётом смещений
 */
export type DiffMatchTier =
  | "exact"
  | "crlf-normalized"
  | "line-trimmed"
  | "indentation-shifted"
  | "fuzzy-block-anchor"
  | "conflict-resolver";

export interface BestMatchDiagnostic {
  readonly similarity: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet: string;
  readonly reason: string;
  readonly formatted: string;
}

export interface SingleEditRequest {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
  readonly expectedReplacements?: number;
  readonly expectedStartLine?: number;
  readonly preserveLineEndings?: boolean;
}

/**
 * Уточнённый legacy-лейбл стратегии для обратной совместимости `EditOutput.matchStrategy`.
 * Канонический уровень остаётся одним из шести `DiffMatchTier`; лейбл лишь уточняет подтип.
 */
export type LegacyMatchStrategy =
  | "exact"
  | "quote_normalized"
  | "line_number_prefix_stripped"
  | "escape_normalized"
  | "unicode_escape_normalized"
  | "line_trimmed"
  | "indentation_flexible"
  | "block_anchor";

export type SingleEditOutcome =
  | {
      readonly status: "matched";
      readonly content: string;
      readonly appliedTier: DiffMatchTier;
      readonly originalLineEndings: DiffLineEnding;
      readonly candidateCount: number;
      readonly actualOldString: string;
      readonly actualNewString: string;
      readonly startLine: number;
      readonly endLine: number;
      /** Уточняющий подтип уровня; отсутствует — используйте `appliedTier`. */
      readonly legacyMatchStrategy?: LegacyMatchStrategy;
    }
  | {
      readonly status: "ambiguous";
      readonly attemptedTier: DiffMatchTier;
      readonly candidateCount: number;
      readonly diagnostic: BestMatchDiagnostic;
    }
  | {
      readonly status: "not_found";
      readonly diagnostic: BestMatchDiagnostic;
    };

export interface MultiHunkEditItem {
  readonly id?: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
  readonly expectedStartLine?: number;
}

export interface PatchHunkSpec {
  readonly changeContext?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly endOfFile?: boolean;
}

export interface MultiHunkConflictInfo {
  readonly firstHunkIndex: number;
  readonly secondHunkIndex: number;
  readonly firstRange: readonly [startLine: number, endLine: number];
  readonly secondRange: readonly [startLine: number, endLine: number];
  readonly message: string;
}

export type MultiHunkOutcome =
  | {
      readonly status: "applied";
      readonly content: string;
      readonly appliedTier: DiffMatchTier;
      readonly appliedTiersByHunk: readonly DiffMatchTier[];
      readonly originalLineEndings: DiffLineEnding;
      readonly appliedHunkCount: number;
    }
  | {
      readonly status: "conflict";
      readonly conflict: MultiHunkConflictInfo;
    }
  | {
      readonly status: "ambiguous";
      readonly failedHunkIndex: number;
      readonly candidateCount: number;
      readonly diagnostic: BestMatchDiagnostic;
    }
  | {
      readonly status: "not_found";
      readonly failedHunkIndex: number;
      readonly diagnostic: BestMatchDiagnostic;
    };

export interface IMultiTierDiffEngine {
  /**
   * Применяет одиночную замену через каскад уровней 1..5 с сохранением переводов строк файла.
   */
  applyEdit(content: string, request: SingleEditRequest): SingleEditOutcome;

  /**
   * Упорядочивает, проверяет на перекрытия (Tier 6 conflict-resolver) и сливает пакет правок в одном файле.
   */
  applyMultiHunkEdits(
    content: string,
    hunks: readonly MultiHunkEditItem[],
    options?: { readonly preserveLineEndings?: boolean },
  ): MultiHunkOutcome;

  /**
   * Применяет структурированные контекстные ханки ApplyPatch (с @@ changeContext и ре-индентацией).
   */
  applyStructuredPatchHunks(
    content: string,
    hunks: readonly PatchHunkSpec[],
    options?: { readonly preserveLineEndings?: boolean },
  ): MultiHunkOutcome;

  /**
   * Определяет доминирующий перевод строк текста (LF или CRLF).
   */
  detectLineEndings(content: string): DiffLineEnding;

  /**
   * Восстанавливает целевой перевод строк текста без двойного \r\r\n.
   */
  restoreLineEndings(logicalContent: string, lineEndings: DiffLineEnding): string;
}

export interface CliDiffEngineContract extends IMultiTierDiffEngine {}
