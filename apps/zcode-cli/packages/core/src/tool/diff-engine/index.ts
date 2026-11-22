export {
  type BestMatchDiagnostic,
  type CliDiffEngineContract,
  type CliDiffEngineId,
  type DiffLineEnding,
  type DiffMatchTier,
  type IMultiTierDiffEngine,
  type MultiHunkConflictInfo,
  type MultiHunkEditItem,
  type MultiHunkOutcome,
  type PatchHunkSpec,
  type SingleEditOutcome,
  type SingleEditRequest,
} from "./contract.js";
export {
  MultiTierDiffEngine,
  createMultiTierDiffEngine,
} from "./multi-tier-engine.js";
export {
  computeIndentProfile,
  extractLeadingWhitespace,
  measureIndentColumns,
  reindentReplacementLines,
  reindentReplacementText,
  type IndentProfile,
} from "./reindent.js";
export {
  FUZZY_ANCHOR_AMBIGUITY_MARGIN,
  FUZZY_ANCHOR_MAX_WINDOW_SLACK,
  FUZZY_ANCHOR_MIN_SIMILARITY,
  buildBestMatchDiagnostic,
  computeBlockSimilarity,
  computeNormalizedLineSimilarity,
  findFuzzyAnchorMatch,
  levenshteinDistance,
  normalizeSmartPunctuationAndSpaces,
  stripReadLinePrefixes,
  type FuzzyAnchorCandidate,
  type FuzzyAnchorSearchResult,
} from "./fuzzy-anchor.js";
export {
  resolveAndMergeCharReplacements,
  resolveAndMergeLineReplacements,
  type CharSpanMergeResult,
  type LineSpanMergeResult,
  type ResolvedCharSpanReplacement,
  type ResolvedLineSpanReplacement,
} from "./conflict-resolver.js";
